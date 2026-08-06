// バッチ・スクリプト用に自前で作る PrismaClient が、RLS のコンテキストを必ず張ることを検査する。
//
// 経緯（QA loop5 で実測により検出。計画上の C2）:
//   `src/app/api/cron/daily/route.ts` の `batchClient()` は
//   `new PrismaClient({ datasourceUrl: DATABASE_URL_UNPOOLED ?? DATABASE_URL })` だけで、
//   `app.bypass` も `set_config` も張っていなかった。
//   `prisma/rls.sql` は9テーブルに `FORCE ROW LEVEL SECURITY` を付けているため、
//   **接続ロールが BYPASSRLS を持たない環境では例外を出さずに0件**になる。
//
//   ローカルの airis_app（NOBYPASSRLS）で実測した結果:
//     app.bypass 無し → accountRequest.updateMany(...) の count = 0（エラーなし）
//     app.bypass=on   → count = 1
//
//   `Account` は非保護テーブルなので匿名化され、保護テーブルだけが取り残される
//   ＝「一部だけ匿名化される」という最も気づきにくい壊れ方。
//   ローカル・CIは postgres（BYPASSRLS）で接続するため永久に再現しない（BUG-L13 と同型）。
//
// このテストは静的検査。実際の0件/1件の差はローカルDBに対する手動実測で確認済みで、
// 再現には NOBYPASSRLS ロールでの接続が必要なため単体テストでは再現しない。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "generated") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// アプリ本体は src/lib/prisma.ts の共有クライアント（クエリ毎に set_config する拡張つき）を使う。
// それ以外の場所で `new PrismaClient(` を書くのは、セッションの無いバッチ・スクリプト・シードだけ。
const SHARED_CLIENT = path.join(ROOT, "src", "lib", "prisma-base.ts");

const candidates = [
  ...walk(path.join(ROOT, "src")),
  ...walk(path.join(ROOT, "prisma")),
  ...walk(path.join(ROOT, "scripts")),
];

type Site = { file: string; body: string };
const sites: Site[] = [];
for (const f of candidates) {
  if (path.resolve(f) === path.resolve(SHARED_CLIENT)) continue;
  const body = fs.readFileSync(f, "utf8");
  if (/new PrismaClient\s*\(/.test(body)) {
    sites.push({ file: path.relative(ROOT, f).replaceAll("\\", "/"), body });
  }
}

// RLS コンテキストを張っている目印。
//   - 接続オプションで app.bypass=on を立てる（seed.ts / cron/daily の方式）
//   - クエリと同一トランザクションで set_config する（lib/util.ts の方式）
const HAS_BYPASS = /app\.bypass(?:%3D|=|', *')/;
const HAS_SET_CONFIG = /set_config\s*\(/;

// 行レベルのモデル操作（RLSポリシーが効く操作）を行っているか。
// DDL だけを流すスクリプト（`prisma/rls.sql` の適用など）は行を触らないため bypass は不要
// ＝ 必要性を**行アクセスの有無から導出**する。許可リストに名前を並べると、
// 後から行アクセスを足しても免除されたままになるため、この形にしている。
const ROW_LEVEL_OP =
  /\b(?:prisma|db|client)\s*\.\s*[a-z][A-Za-z0-9]*\s*\.\s*(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/;

function needsBypass(body: string): boolean {
  return ROW_LEVEL_OP.test(body);
}

describe("バッチ・スクリプト用の PrismaClient は RLS コンテキストを張る（§3.1 / C2）", () => {
  it("`new PrismaClient(` を書いている箇所を検出できている（空振り防止）", () => {
    expect(sites.length, "new PrismaClient( の箇所を1つも拾えていない").toBeGreaterThan(1);
    // 既知の箇所が含まれること（検出器が壊れたら気付けるようにする）
    expect(sites.map((s) => s.file)).toContain("src/app/api/cron/daily/route.ts");
    expect(sites.map((s) => s.file)).toContain("prisma/seed.ts");
  });

  it("**行レベル操作を行う生成箇所はすべて app.bypass もしくは set_config を伴う**", () => {
    const missing = sites
      .filter((s) => needsBypass(s.body))
      .filter((s) => !HAS_BYPASS.test(s.body) && !HAS_SET_CONFIG.test(s.body))
      .map((s) => s.file);
    expect(
      missing,
      "RLSコンテキストを張らずに行レベル操作をしています。" +
        "FORCE ROW LEVEL SECURITY のテーブルに対し、BYPASSRLS を持たないロールでは" +
        "例外を出さずに0件になります（サイレント失敗）:\n  " +
        missing.join("\n  ")
    ).toEqual([]);
  });

  it("免除されるのは行を触らない箇所だけ（免除の妥当性を検証する）", () => {
    const exempt = sites.filter((s) => !needsBypass(s.body));
    for (const s of exempt) {
      // 行を触らない＝生SQL（DDL）だけを流している、が成立していること
      expect(
        ROW_LEVEL_OP.test(s.body),
        `${s.file} は行レベル操作をしていないという前提で免除されています`
      ).toBe(false);
    }
    // 既知の免除対象（rls.sql を流すだけのスクリプト）が実際に免除側にいること
    expect(exempt.map((s) => s.file)).toContain("scripts/apply-rls.ts");
  });

  it("日次バッチは非プール接続を優先する（Neonのプール接続では接続オプションが効かない）", () => {
    const cron = sites.find((s) => s.file === "src/app/api/cron/daily/route.ts");
    expect(cron, "cron/daily が見つからない").toBeTruthy();
    expect(cron!.body).toContain("DATABASE_URL_UNPOOLED");
    // 非プールを先に評価していること（?? の左辺）
    expect(cron!.body).toMatch(/DATABASE_URL_UNPOOLED\s*\?\?\s*process\.env\.DATABASE_URL/);
  });

  it("行アクセスの検出が機能している（自己検査）", () => {
    expect(needsBypass(`await prisma.accountRequest.updateMany({ where: {} });`)).toBe(true);
    expect(needsBypass(`await db.salesStaff.findMany();`)).toBe(true);
    expect(
      needsBypass(`await prisma.$executeRawUnsafe(stmt);`),
      "DDLのみを行アクセスと誤判定"
    ).toBe(false);
  });

  it("検出器が「張っていない生成」を実際に見分けられる（自己検査）", () => {
    const bad = `const p = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });`;
    const goodOption = `const url = base + "?options=-c%20app.bypass%3Don";\nnew PrismaClient({ datasourceUrl: url });`;
    const goodSetConfig = `new PrismaClient();\nawait p.$executeRaw\`SELECT set_config('app.bypass','on',TRUE)\`;`;
    expect(HAS_BYPASS.test(bad) || HAS_SET_CONFIG.test(bad), "悪い例を見逃している").toBe(false);
    expect(HAS_BYPASS.test(goodOption), "接続オプション方式を拾えない").toBe(true);
    expect(HAS_SET_CONFIG.test(goodSetConfig), "set_config 方式を拾えない").toBe(true);
  });
});

describe("rls.sql の FORCE 対象と、バッチが触るモデルの対応", () => {
  const rls = fs.readFileSync(path.join(ROOT, "prisma", "rls.sql"), "utf8");
  const forced = [...rls.matchAll(/ALTER TABLE "(\w+)" FORCE ROW LEVEL SECURITY/g)].map(
    (m) => m[1]
  );

  it("FORCE ROW LEVEL SECURITY のテーブルを列挙できている", () => {
    expect(forced.length, "FORCE 指定を1つも拾えていない").toBeGreaterThan(5);
  });

  it("日次バッチが匿名化する保護テーブルが FORCE 対象に含まれている（＝bypass が必須である根拠）", () => {
    for (const t of ["SalesStaff", "FieldAgentApplication", "AccountRequest"]) {
      expect(forced, `${t} が FORCE 対象に無い（前提が変わっている）`).toContain(t);
    }
  });
});
