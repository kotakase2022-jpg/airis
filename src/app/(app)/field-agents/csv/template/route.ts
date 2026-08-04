// 訪販員申請 一括申請CSVひな形ダウンロード（SPEC §7.4 / §3.6）
// 列順はCSV一括申請（csvBulkApplyAction）の解釈順と一致させる。
import { requirePage } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";
import { audit } from "@/lib/util";
import { FIELD_AGENT_CSV_HEADERS } from "../../csv-columns";

export async function GET() {
  const user = await requirePage("field-agents"); // 認可（未ログインは /login へリダイレクト）
  await audit(user.loginId, "訪販員申請一括申請CSVひな形DL");
  return csvResponse(
    "訪販員申請一括申請ひな形.csv",
    toCsv([...FIELD_AGENT_CSV_HEADERS], [])
  );
}
