/**
 * 訪販員申請の代理店スコープ列（primaryAgencyId / secondaryAgencyId）の一括補完（SPEC §3.1）
 *
 * 背景: FieldAgentApplication は §3.1 のスコープ列を後から追加したため、既存行は NULL のまま。
 * prisma/rls.sql の新しいポリシーはこの2列を直接照合する（NULL の行は代理店系ロールから
 * 見えない = fail-closed）ので、**1回だけ** このスクリプトで既存行を補完する。
 * 以降の新規行は申請作成時（field-agents/actions.ts）に必ず埋まる。
 *
 * 実行方法（ローカル / RLS適用済みDB。冪等なので何度実行しても安全）:
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/airis \
 *     npx tsx "src/app/(app)/field-agents/backfill-scope.ts"
 *   PowerShell:
 *     $env:DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/airis"; `
 *       npx tsx "src/app/(app)/field-agents/backfill-scope.ts"
 *   ※ APP_DATABASE_URL（airis_app）でも実行できる（RLSは app.bypass='on' で通す）。
 *   ※ --dry-run を付けると更新せず件数だけ表示する。
 */
// basePrisma（RLS拡張なしの素のクライアント）を使う。src/lib/util.ts の
// withScopedTransaction と同じ形（interactive transaction 内で set_config）だが、util.ts は
// `server-only` を import しており tsx 単体実行では解決できないため、ここでは basePrisma を
// 直接使って同じことを行う（アプリ実行時のコードパスではないため RLS 拡張の制約も無い）。
import { basePrisma } from "../../../lib/prisma-base";
import { resolveAgencyScope } from "./agency-scope";

const dryRun = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.APP_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL（または APP_DATABASE_URL）を指定して実行してください");
  }

  const result = await basePrisma.$transaction(async (tx) => {
    // RLSは app.bypass='on'（SNC系/管理バッチ相当 §3.1）で通す。必ず同一トランザクション内で設定する。
    await tx.$executeRaw`SELECT set_config('app.bypass', 'on', TRUE)`;
    const apps = await tx.fieldAgentApplication.findMany({
      select: {
        id: true,
        primaryAgencyId: true,
        secondaryAgencyId: true,
        salesStaff: { select: { agency: { select: { id: true, tier: true, parentId: true } } } },
      },
    });

    let updated = 0;
    const orphans: string[] = [];
    for (const app of apps) {
      const want = resolveAgencyScope(app.salesStaff.agency);
      if (want.primaryAgencyId === null && want.secondaryAgencyId === null) {
        orphans.push(app.id);
        continue;
      }
      if (
        app.primaryAgencyId === want.primaryAgencyId &&
        app.secondaryAgencyId === want.secondaryAgencyId
      ) {
        continue; // 既に正しい（冪等）
      }
      if (!dryRun) {
        await tx.fieldAgentApplication.update({ where: { id: app.id }, data: want });
      }
      updated += 1;
    }
    return { total: apps.length, updated, orphans };
  });

  console.log(
    `[backfill-scope] 訪販員申請 ${result.total}件 / ${dryRun ? "更新対象" : "更新"} ${result.updated}件`
  );
  if (result.orphans.length > 0) {
    // 2次代理店に親（1次店）が設定されていない等のデータ不整合。RLSでは見えなくなるため警告する。
    console.warn(
      `[backfill-scope] 警告: 所属代理店から1次店/2次店を解決できない申請が ${result.orphans.length}件あります: ${result.orphans.join(", ")}`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
