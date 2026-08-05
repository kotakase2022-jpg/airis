// ホットライン案件一覧CSV（問題一覧No.30 / No.14）
import { exportCasesCsv } from "@/components/cases/csv-export";

export async function GET() {
  return exportCasesCsv("HL");
}
