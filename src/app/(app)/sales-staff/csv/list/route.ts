// 販売員一覧CSV出力（棚卸用・スコープ内全件。SPEC §7.3）
import { agencyScope, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";
import { STAFF_STATUS_LABELS } from "@/lib/roles";
import { isDummyFeature } from "@/lib/permissions";
import { audit, canViewFeatureInScope, today } from "@/lib/util";

export async function GET() {
  const user = await requirePage("sales-staff"); // 認可チェック（§5.2 ページアクセス）
  // §5.1「販売員ID」の参照権限をAPI層でも判定する（§3.2 多層防御）。
  // ①②③⑦=閲 / ⑧=申（自店スコープの申請状況確認 §5.1 補足）/ ④=ダミー（§3.5）
  if (!canViewFeatureInScope(user.role, "sales-staff")) {
    await audit(user.loginId, "csv_export_sales_staff_list", `role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }
  const scope = await agencyScope(user); // R4(ダミー)はダミー代理店に自動スコープされる
  const dummy = isDummyFeature(user.role, "sales-staff"); // ④のみ true（§3.5）

  const staff = await prisma.salesStaff.findMany({
    where: scope ? { agencyId: { in: scope } } : { agency: { isDummy: dummy } },
    include: { agency: true },
    orderBy: [{ agency: { code: "asc" } }, { createdAt: "asc" }],
  });

  const csv = toCsv(
    [
      "販売員ID",
      "姓",
      "名",
      "生年月日",
      "電話番号",
      "メールアドレス",
      "代理店コード",
      "代理店名",
      "ステータス",
      "1次承認済み",
      "最終更新",
    ],
    staff.map((s) => [
      s.salesId ?? "未採番",
      s.lastName,
      s.firstName,
      s.birthDate,
      s.phone,
      s.email ?? "",
      s.agency.code,
      s.agency.name,
      STAFF_STATUS_LABELS[s.status] ?? s.status,
      s.firstApproved ? "済" : "",
      s.updatedAt.toISOString().slice(0, 10),
    ])
  );
  await audit(user.loginId, "csv_export_sales_staff_list", `${staff.length}件`);
  return csvResponse(`販売員一覧_${today()}.csv`, csv);
}
