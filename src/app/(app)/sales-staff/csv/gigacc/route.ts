// GiGaCC連携用CSV出力（本登録=registered のみ。SPEC §6.2-4 / §7.3）
import { agencyScope, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { csvResponse, toCsv } from "@/lib/csv";
import { isDummyFeature } from "@/lib/permissions";
import { audit, canViewFeatureInScope, today } from "@/lib/util";

export async function GET() {
  const user = await requirePage("sales-staff"); // 認可チェック（§5.2 ページアクセス）
  // §5.1「販売員ID」の参照権限をAPI層でも判定する（§3.2 多層防御）
  if (!canViewFeatureInScope(user.role, "sales-staff")) {
    await audit(user.loginId, "csv_export_gigacc", `role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }
  const scope = await agencyScope(user);
  const dummy = isDummyFeature(user.role, "sales-staff"); // ④のみ true（§3.5）

  const staff = await prisma.salesStaff.findMany({
    where: {
      status: "registered", // 本登録のみが連携対象
      ...(scope ? { agencyId: { in: scope } } : { agency: { isDummy: dummy } }),
    },
    include: { agency: true },
    orderBy: { salesId: "asc" },
  });

  // TODO: GiGaCC連携CSVの正式な列仕様は発注者確認待ち（SPEC §14-7）。プロトタイプ準拠の仮実装。
  const csv = toCsv(
    ["販売員ID", "姓", "名", "生年月日", "電話番号", "代理店コード", "代理店名"],
    staff.map((s) => [
      s.salesId ?? "",
      s.lastName,
      s.firstName,
      s.birthDate,
      s.phone,
      s.agency.code,
      s.agency.name,
    ])
  );
  await audit(user.loginId, "csv_export_gigacc", `${staff.length}件`);
  return csvResponse(`GiGaCC連携_${today()}.csv`, csv);
}
