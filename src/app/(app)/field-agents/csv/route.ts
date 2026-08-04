// 訪販員申請一覧CSV出力（棚卸用。SPEC §7.4 / 要件3-10）
// SNC限定項目（ブラックリスト欄・SNC用メモ）は SNC①②③ がダウンロードした場合のみ列に含める
import { getCurrentUser, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccess, SNC_ADMIN_ROLES, STAFF_STATUS_LABELS, type Role } from "@/lib/roles";
import { toCsv, csvResponse } from "@/lib/csv";
import { audit, today } from "@/lib/util";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.mustChangePassword) return new Response("Forbidden", { status: 403 });
  if (!canAccess(user.role, "field-agents")) return new Response("Forbidden", { status: 403 });

  const scope = await agencyScope(user); // R4はダミー代理店に自動スコープ
  const isSnc = SNC_ADMIN_ROLES.includes(user.role as Role);

  const apps = await prisma.fieldAgentApplication.findMany({
    where: {
      salesStaff: scope === null ? { agency: { isDummy: false } } : { agencyId: { in: scope } },
    },
    include: { salesStaff: { include: { agency: true } } },
    orderBy: { createdAt: "asc" },
  });

  const headers = [
    "販売員ID",
    "氏名（姓）",
    "氏名（名）",
    "フリガナ（姓）",
    "フリガナ（名）",
    "1次店名",
    "所属代理店名",
    "所属代理店コード",
    "申請区分",
    "取扱商材",
    "属性",
    "本人性種別",
    "誓約書No",
    "稼働開始日",
    "稼働終了日",
    "使用代理店コード1",
    "使用代理店コード2",
    "業務委託会社名",
    "業務委託会社住所",
    "業務委託会社連絡先",
    "ステータス",
    "稼働月",
    "申請日",
    "最終更新",
    ...(isSnc ? ["ブラックリスト", "SNC用メモ"] : []),
  ];

  const fmt = (d: Date) =>
    new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

  const rows = apps.map((a) => [
    a.salesStaff.salesId ?? "（未採番）",
    a.salesStaff.lastName,
    a.salesStaff.firstName,
    a.lastNameKana,
    a.firstNameKana,
    a.primaryAgencyName,
    a.agencyName ?? a.salesStaff.agency.name,
    a.salesStaff.agency.code,
    a.applicationType,
    a.products,
    a.attribute,
    a.identityType,
    a.pledgeNo,
    a.startDate,
    a.endDate,
    a.agencyCode1,
    a.agencyCode2,
    a.contractorName,
    a.contractorAddress,
    a.contractorPhone,
    STAFF_STATUS_LABELS[a.status] ?? a.status,
    a.workMonth,
    fmt(a.createdAt),
    fmt(a.updatedAt),
    ...(isSnc ? [a.blacklistFlag ?? "", a.sncMemo ?? ""] : []),
  ]);

  // CSVエクスポートは監査ログ記録対象（§3.3 / §3.6）
  await audit(
    user.loginId,
    "訪販員申請一覧CSV出力",
    `count=${apps.length}${isSnc ? "（SNC限定項目含む）" : ""}`
  );

  return csvResponse(`訪販員申請一覧_${today()}.csv`, toCsv(headers, rows));
}
