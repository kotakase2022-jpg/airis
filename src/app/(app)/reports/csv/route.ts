// 日報CSVテンプレートのダウンロード（ヘッダ + 2行目に記入例。要件6-1 / 発注者指示 2026-08-05）
// GET /reports/csv?template=visit | tele

import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { canAccess } from "@/lib/roles";
import { toCsv, csvResponse } from "@/lib/csv";
import { audit, canViewFeatureInScope } from "@/lib/util";
import {
  VISIT_CSV_HEADERS,
  TELE_CSV_HEADERS,
  VISIT_CSV_EXAMPLE,
  TELE_CSV_EXAMPLE,
} from "../defs";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  // §5.2 ページアクセス（日報提出: ①②③⑦⑧⑨、④はダミー）
  if (!canAccess(user.role, "reports")) return new Response("Forbidden", { status: 403 });
  // §5.1「日報提出」の権限（提/変/閲/削。⑨は提のみ、④はダミー §3.5）をAPI層でも判定（§3.2）。
  // CSVテンプレートは一括登録（提出）の入力様式なので「提」を持つ⑨も対象に含む。
  if (!canViewFeatureInScope(user.role, "daily-report")) {
    await audit(user.loginId, "csv_export", `daily_report_template role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }

  const template = req.nextUrl.searchParams.get("template");
  if (template === "visit") {
    await audit(user.loginId, "csv_export", "daily_report_template_visit");
    return csvResponse(
      "訪販日報CSVテンプレート.csv",
      toCsv([...VISIT_CSV_HEADERS], [[...VISIT_CSV_EXAMPLE]])
    );
  }
  if (template === "tele") {
    await audit(user.loginId, "csv_export", "daily_report_template_tele");
    return csvResponse(
      "テレマ日報CSVテンプレート.csv",
      toCsv([...TELE_CSV_HEADERS], [[...TELE_CSV_EXAMPLE]])
    );
  }
  return new Response("Bad Request", { status: 400 });
}
