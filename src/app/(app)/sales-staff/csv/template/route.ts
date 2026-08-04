// 一括申請CSVひな形ダウンロード（SPEC §6.2-3）
import { requirePage } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";

export async function GET() {
  await requirePage("sales-staff"); // 認可（未ログインは /login へリダイレクト）
  const csv = toCsv(["姓", "名", "生年月日", "電話番号", "代理店コード", "メールアドレス"], []);
  return csvResponse("販売員ID一括申請ひな形.csv", csv);
}
