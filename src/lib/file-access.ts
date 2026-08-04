import "server-only";
import { prisma } from "./prisma";
import { agencyScope, type CurrentUser } from "./auth";
import { canAccess } from "./roles";

// ファイルの認可（§3.1 / §3.8 / §10.5）。
// fileId を参照するエンティティを特定し、そのエンティティの閲覧可否ルールを適用する。
// どのエンティティからも参照されていないファイルは拒否（fail-closed）。
export async function canAccessFile(user: CurrentUser, fileId: string): Promise<boolean> {
  const scope = await agencyScope(user); // null=全代理店（SNC系）/ 配列=そのIDのみ
  const inScope = (agencyId: string | null | undefined) =>
    scope === null ? true : !!agencyId && scope.includes(agencyId);

  // 1) アカウント申請の証跡（申請・承認に関与できるロール = account-requests ページ閲覧可）
  const req = await prisma.accountRequest.findFirst({
    where: { evidenceFileId: fileId },
    select: { agencyId: true },
  });
  if (req) return canAccess(user.role, "account-requests") && !user.isDummy;

  // 2) 訪販員申請の誓約書PDF（field-agents ページ + 対象販売員の代理店スコープ）
  const app = await prisma.fieldAgentApplication.findFirst({
    where: { pledgeFileId: fileId },
    select: { salesStaff: { select: { agencyId: true } } },
  });
  if (app) return canAccess(user.role, "field-agents") && inScope(app.salesStaff?.agencyId);

  // 3) 稼働提出物のファイル（reports ページ + 提出元/1次店スコープ）
  const sub = await prisma.submission.findFirst({
    where: { fileId },
    select: { submitterAgencyId: true, primaryAgencyId: true },
  });
  if (sub) {
    return (
      canAccess(user.role, "reports") &&
      (inScope(sub.submitterAgencyId) || inScope(sub.primaryAgencyId))
    );
  }

  // 4) 窓口案件メッセージの添付（案件の1次/2次店スコープ。SNC窓口担当は担当seriesのみ）
  const msgs = await prisma.caseMessage.findMany({
    where: {},
    select: { fileIds: true, case_: { select: { series: true, primaryAgencyId: true, secondaryAgencyId: true } } },
  });
  for (const m of msgs) {
    const ids = Array.isArray(m.fileIds) ? (m.fileIds as { id: string }[]) : [];
    if (ids.some((f) => f.id === fileId)) {
      const c = m.case_;
      const page =
        user.role === "R7" || user.role === "R10"
          ? "agency-cases"
          : c.series === "HL"
            ? "hotline"
            : "consumer-center";
      if (!canAccess(user.role, page)) return false;
      return inScope(c.primaryAgencyId) || inScope(c.secondaryAgencyId);
    }
  }

  // 5) お知らせの添付（配信対象ロール + ダミー分離）
  const anns = await prisma.announcement.findMany({
    where: { status: { in: ["sent", "stopped"] } },
    select: { fileIds: true, audience: true, isDummy: true },
  });
  for (const a of anns) {
    const ids = Array.isArray(a.fileIds) ? (a.fileIds as { id: string }[]) : [];
    if (ids.some((f) => f.id === fileId)) {
      if (!canAccess(user.role, "announcements")) return false;
      if (a.isDummy !== user.isDummy) return false; // ④ダミー分離
      // 全体向けは⑦⑧⑨、1次店向けは⑦のみ（§5.1）
      if (a.audience === "primary" && !["R1", "R2", "R3", "R7"].includes(user.role)) return false;
      return true;
    }
  }

  // 6) ドキュメント（公開範囲 + ダミー分離）
  const doc = await prisma.document.findFirst({
    where: { fileId },
    select: { visibility: true, isDummy: true },
  });
  if (doc) {
    if (!canAccess(user.role, "documents")) return false;
    if (doc.isDummy !== user.isDummy) return false;
    // 可視範囲: all=全ロール / primary=SNC系+R7 / snc=SNC系のみ
    if (doc.visibility === "snc") return ["R1", "R2", "R3", "R5", "R6"].includes(user.role);
    if (doc.visibility === "primary") return ["R1", "R2", "R3", "R5", "R6", "R7"].includes(user.role);
    return true; // all
  }

  // どのエンティティからも参照されていない → 拒否
  return false;
}
