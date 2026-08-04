// 一括申請CSVひな形ダウンロード（SPEC §6.2-3）
import { requirePage } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";
import { audit, canViewFeatureInScope } from "@/lib/util";

export async function GET() {
  const user = await requirePage("sales-staff"); // 認可（未ログインは /login へリダイレクト）
  // §5.1「販売員ID」の参照・申請権限をAPI層でも判定する（§3.2 多層防御）。
  // ひな形は一括申請（§6.2-3）の入力様式なので、申請権を持つ⑧も対象に含む。
  if (!canViewFeatureInScope(user.role, "sales-staff")) {
    await audit(user.loginId, "csv_export_sales_staff_template", `role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }
  const csv = toCsv(["姓", "名", "生年月日", "電話番号", "代理店コード", "メールアドレス"], []);
  return csvResponse("販売員ID一括申請ひな形.csv", csv);
}
