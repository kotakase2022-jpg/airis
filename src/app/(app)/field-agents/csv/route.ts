// 訪販員申請一覧CSV出力（棚卸用。SPEC §7.4 / 要件3-10）
// SNC限定項目（ブラックリスト欄・SNC用メモ）は SNC①②③ がダウンロードした場合のみ列に含める
// 権限判定は §5.1 の宣言的マップ（permissions.ts）経由で行う（§3.2）
import { getCurrentUser, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccess, STAFF_STATUS_LABELS } from "@/lib/roles";
import { can } from "@/lib/permissions";
import { toCsv, csvResponse } from "@/lib/csv";
import { audit, canViewFeatureInScope, today } from "@/lib/util";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (user.mustChangePassword) return new Response("Forbidden", { status: 403 });
  // §5.2 ページアクセス（訪販員申請/管理: ①②③⑦⑧、④はダミー）
  if (!canAccess(user.role, "field-agents")) return new Response("Forbidden", { status: 403 });
  // §5.1「訪販員申請」の参照権限（①②③⑦=閲 / ⑧=申 / ④=ダミー §3.5）を API層でも判定（§3.2）
  if (!canViewFeatureInScope(user.role, "field-agent")) {
    await audit(user.loginId, "訪販員申請一覧CSV出力", `role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }

  const scope = await agencyScope(user); // R4はダミー代理店に自動スコープ
  // SNC限定項目（ブラックリスト欄・SNC用メモ §7.4）は「SNCアカウント（①②③）」のみ。
  // §5.1「訪販員申請 / 承（最終承認）」を持つのは①②③なのでこれを根拠に判定する（§3.2）。
  const isSnc = can(user.role, "field-agent", "approve_final");

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
