import "server-only";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, agencyScope } from "@/lib/auth";
import { PageKey, canAccess } from "@/lib/roles";
import { can, caseFeature } from "@/lib/permissions";
import { csvResponse, toCsv } from "@/lib/csv";
import { audit } from "@/lib/util";
import { seriesLabel } from "./badges";

// 窓口案件の一覧CSVエクスポート（検収指摘 問題一覧No.30 / 集計・棚卸用 No.14）。
// /hotline/csv と /consumer-center/csv から系列を変えて共用する。
export async function exportCasesCsv(series: "HL" | "CSC"): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const pageKey: PageKey = series === "HL" ? "hotline" : "consumer-center";
  // ④（ダミー表示）は実データのエクスポート不可（§3.5）
  if (user.isDummy || !canAccess(user.role, pageKey) || !can(user.role, caseFeature(series), "view")) {
    await audit(user.loginId, "csv_export", `cases_${series} role=${user.role}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }

  const scope = await agencyScope(user);
  const cases = await prisma.case.findMany({
    where: { series, ...(scope ? { primaryAgencyId: { in: scope } } : {}) },
    include: {
      primaryAgency: true,
      secondaryAgency: true,
      salesStaff: true,
      messages: { select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // 担当者名の解決（assigneeAccountId → loginId/氏名）
  const assigneeIds = [...new Set(cases.map((c) => c.assigneeAccountId).filter((v): v is string => !!v))];
  const assignees = assigneeIds.length
    ? await prisma.account.findMany({
        where: { id: { in: assigneeIds } },
        select: { id: true, loginId: true, name: true },
      })
    : [];
  const assigneeMap = new Map(assignees.map((a) => [a.id, `${a.loginId}（${a.name}）`]));

  const jst = (d: Date) =>
    new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");

  const csv = toCsv(
    [
      "案件番号", "テンプレ種別", "件名", "ステータス", "対応期限",
      "一次代理店コード", "一次代理店名", "二次代理店コード", "二次代理店名",
      "販売員ID", "販売員氏名", "担当者", "ISP受付番号", "メッセージ数",
      "起票者", "起票日時", "最終更新",
    ],
    cases.map((c) => [
      c.caseNo,
      c.templateKind,
      c.title,
      c.status,
      c.deadline ?? "",
      c.primaryAgency.code,
      c.primaryAgency.name,
      c.secondaryAgency?.code ?? "",
      c.secondaryAgency?.name ?? "",
      c.salesStaff?.salesId ?? "",
      c.salesStaff ? `${c.salesStaff.lastName} ${c.salesStaff.firstName}` : "",
      c.assigneeAccountId ? (assigneeMap.get(c.assigneeAccountId) ?? "") : "",
      c.ispNumber ?? "",
      String(c.messages.length),
      c.createdBy ?? "",
      jst(c.createdAt),
      jst(c.updatedAt),
    ])
  );
  await audit(user.loginId, "csv_export", `cases_${series}`); // CSV出力も監査対象（§3.6）
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  return csvResponse(`${seriesLabel(series)}案件一覧_${today}.csv`, csv);
}
