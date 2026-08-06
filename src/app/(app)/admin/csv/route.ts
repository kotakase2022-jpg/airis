import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ACCOUNT_STATUS_LABELS, ROLE_LABELS, Role, canAccess } from "@/lib/roles";
import { csvResponse, toCsv } from "@/lib/csv";
import { canViewAuditRecords } from "../authz";
import { audit, today } from "@/lib/util";
import { isAdminIpAllowedFromSettings } from "@/lib/settings";
import {
  ERASURE_ACTIONS,
  ERASURE_CSV_HEADERS,
  erasureCsvRows,
  toErasureReports,
} from "@/lib/erasure";

function jst(d: Date, len: number): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, len).replace("T", " ");
}

// 管理画面CSVエクスポート
// ?type=inventory: 棚卸CSV / ?type=audit: 監査ログCSV / ?type=access: アクセスログCSV（要件1-6）
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.mustChangePassword) return new Response("Forbidden", { status: 403 });
  // 管理画面CSV（棚卸 / 監査ログ / アクセスログ）は **①②のみ**（§7.1 / §7.2）。
  // ③は管理画面に入れる（発注者指示 OWN-014）が、監査記録には到達させない
  // （発注者指示 2026-08-06）。判定は canViewAuditRecords() に集約する（§3.2）。
  // ④はダミー表示のため実データのエクスポートを許可しない。
  if (!canAccess(user.role, "admin") || !canViewAuditRecords(user.role)) {
    await audit(
      user.loginId,
      "csv_export",
      `admin type=${req.nextUrl.searchParams.get("type") ?? "inventory"} role=${user.role}`,
      "denied"
    );
    return new Response("Forbidden", { status: 403 });
  }
  // 管理系エンドポイントのIP許可リスト（§10.1）。ページ（/admin）と同じ制御を必ず適用する。
  // 判定は設定テーブル対応版（DB → 環境変数 → 既定値）を使う。DBに値が無い場合は
  // 従来どおり環境変数 ADMIN_IP_ALLOWLIST を見るので既存環境と互換
  // （src/lib/auth.ts の isAdminIpAllowed() 側の参照差し替えは統合担当が行う）。
  const ipCheck = await isAdminIpAllowedFromSettings();
  if (!ipCheck.allowed) {
    await audit(user.loginId, "csv_export", `admin ip=${ipCheck.ip} (allowlist)`, "denied");
    return new Response("Forbidden", { status: 403 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "inventory";

  if (type === "access") {
    // アクセスログCSV（§3.3 / 要件1-6）: AccessLog（ログイン日時・ID・結果・IP・UA・理由）を出力。
    // 監査ログ（AuditLog）の target へUAを埋め込む方式は廃止し、専用テーブルを情報源とする。
    const logs = await prisma.accessLog.findMany({ orderBy: { createdAt: "desc" } });
    const csv = toCsv(
      ["日時", "ログインID", "結果", "IP", "UserAgent", "理由"],
      logs.map((l) => [
        jst(l.createdAt, 16),
        l.loginId,
        l.result,
        l.ip ?? "",
        l.userAgent ?? "",
        l.reason ?? "",
      ])
    );
    await audit(user.loginId, "csv_export", "access_logs"); // CSV出力自体も監査対象（§3.6）
    return csvResponse(`アクセスログ_${today()}.csv`, csv);
  }

  if (type === "erasure") {
    // 削除完了レポートCSV（§10.3 / SEC要件②#31。削除証明用）:
    // 対象件数・データ種別・実行日時・実行者を、削除操作の監査ログ（append-only §10.4）から復元する。
    // ?id=<監査ログID> で1回の削除実行分だけを出力できる。
    const id = req.nextUrl.searchParams.get("id");
    const logs = await prisma.auditLog.findMany({
      where: {
        action: { in: [ERASURE_ACTIONS.agency, ERASURE_ACTIONS.pii] },
        result: "success",
        ...(id ? { id } : {}),
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, actor: true, action: true, target: true, createdAt: true },
    });
    const csv = toCsv(ERASURE_CSV_HEADERS, erasureCsvRows(toErasureReports(logs)));
    await audit(user.loginId, "csv_export", "erasure_reports"); // CSV出力自体も監査対象（§3.6）
    return csvResponse(`削除完了レポート_${today()}.csv`, csv);
  }

  if (type === "audit") {
    // 監査ログCSV（全件）
    const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" } });
    const csv = toCsv(
      ["日時", "actor", "action", "target", "result"],
      logs.map((l) => [jst(l.createdAt, 16), l.actor, l.action, l.target ?? "", l.result])
    );
    await audit(user.loginId, "csv_export", "audit_logs"); // CSV出力自体も監査対象（§3.6）
    return csvResponse(`監査ログ_${today()}.csv`, csv);
  }

  // 棚卸CSV（全アカウント。R4用ダミー代理店のデータは除外）
  const accounts = await prisma.account.findMany({
    where: { OR: [{ agencyId: null }, { agency: { isDummy: false } }] },
    include: { agency: true },
    orderBy: { loginId: "asc" },
  });
  const csv = toCsv(
    // 削除日時（§3.4 論理削除・1年保持）を含める（検収指摘 問題一覧No.10）
    [
      "ログインID",
      "ロール",
      "氏名",
      "メール",
      "所属代理店コード",
      "ステータス",
      "作成日",
      "最終PW変更日",
      "削除日時",
    ],
    accounts.map((a) => [
      a.loginId,
      ROLE_LABELS[a.role as Role] ?? a.role,
      a.name,
      a.email ?? "",
      a.agency?.code ?? "",
      ACCOUNT_STATUS_LABELS[a.status] ?? a.status,
      jst(a.createdAt, 10),
      jst(a.passwordUpdatedAt, 10),
      a.deletedAt ? jst(a.deletedAt, 16) : "",
    ])
  );
  await audit(user.loginId, "csv_export", "accounts_inventory");
  return csvResponse(`アカウント棚卸_${today()}.csv`, csv);
}
