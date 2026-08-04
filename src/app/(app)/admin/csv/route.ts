import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ACCOUNT_STATUS_LABELS, ROLE_LABELS, Role } from "@/lib/roles";
import { csvResponse, toCsv } from "@/lib/csv";
import { audit, today } from "@/lib/util";

function jst(d: Date, len: number): string {
  return new Date(d.getTime() + 9 * 3600 * 1000)
    .toISOString()
    .slice(0, len)
    .replace("T", " ");
}

// 管理画面CSVエクスポート（?type=inventory: 棚卸CSV / ?type=audit: 監査ログCSV）
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.mustChangePassword) return new Response("Forbidden", { status: 403 });
  // R1/R2のみ（R4ダミー閲覧は実データのエクスポート不可）
  if (user.role !== "R1" && user.role !== "R2") {
    await audit(user.loginId, "csv_export", "admin", "denied");
    return new Response("Forbidden", { status: 403 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "inventory";

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
    ["ログインID", "ロール", "氏名", "メール", "所属代理店コード", "ステータス", "作成日", "最終PW変更日"],
    accounts.map((a) => [
      a.loginId,
      ROLE_LABELS[a.role as Role] ?? a.role,
      a.name,
      a.email ?? "",
      a.agency?.code ?? "",
      ACCOUNT_STATUS_LABELS[a.status] ?? a.status,
      jst(a.createdAt, 10),
      jst(a.passwordUpdatedAt, 10),
    ])
  );
  await audit(user.loginId, "csv_export", "accounts_inventory");
  return csvResponse(`アカウント棚卸_${today()}.csv`, csv);
}
