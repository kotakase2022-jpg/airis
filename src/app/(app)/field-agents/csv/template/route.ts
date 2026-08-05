// 訪販員申請 一括申請CSVひな形ダウンロード（SPEC §7.4 / §3.6）
// 列順はCSV一括申請（csvBulkApplyAction）の解釈順と一致させる。
import { requirePage } from "@/lib/auth";
import { csvResponse, toCsv } from "@/lib/csv";
import { audit } from "@/lib/util";
import { FIELD_AGENT_CSV_HEADERS } from "../../csv-columns";

export async function GET() {
  const user = await requirePage("field-agents"); // 認可（未ログインは /login へリダイレクト）
  await audit(user.loginId, "訪販員申請一括申請CSVひな形DL");
  // 2行目に記入例（検収指摘 問題一覧No.29）。販売員IDに「(例)」を含めるため、
  // 例文行を残したまま取り込むと該当販売員なしのエラーになり誤登録を防げる
  return csvResponse(
    "訪販員申請一括申請ひな形.csv",
    toCsv(
      [...FIELD_AGENT_CSV_HEADERS],
      [
        [
          "(例)999999C001",
          "稼働",
          "auひかり",
          "業務委託社員",
          "ヤマダ",
          "タロウ",
          "運転免許証",
          "PL-2026-001",
          "2026-09-01",
          "999999",
          "999998",
          "株式会社サンプル販売",
          "東京都新宿区1-2-3",
          "03-1234-5678",
        ],
      ]
    )
  );
}
