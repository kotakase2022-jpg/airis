// 日報CSVテンプレートのダウンロード（ヘッダのみのCSV。要件6-1）
// GET /reports/csv?template=visit | tele

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canAccess } from "@/lib/roles";
import { toCsv, csvResponse } from "@/lib/csv";
import { audit } from "@/lib/util";
import { VISIT_CSV_HEADERS, TELE_CSV_HEADERS } from "../defs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!canAccess(user.role, "reports")) return new Response("Forbidden", { status: 403 });

  const template = req.nextUrl.searchParams.get("template");
  if (template === "visit") {
    await audit(user.loginId, "csv_export", "daily_report_template_visit");
    return csvResponse("訪販日報CSVテンプレート.csv", toCsv([...VISIT_CSV_HEADERS], []));
  }
  if (template === "tele") {
    await audit(user.loginId, "csv_export", "daily_report_template_tele");
    return csvResponse("テレマ日報CSVテンプレート.csv", toCsv([...TELE_CSV_HEADERS], []));
  }
  return new Response("Bad Request", { status: 400 });
}
