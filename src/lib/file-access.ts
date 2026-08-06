import "server-only";
import { prisma } from "./prisma";
import { agencyScope, type CurrentUser } from "./auth";
import { can, canApproveFirst, announcementFeature, caseFeature } from "./permissions";
// 証跡ファイルの参照可否は「その申請を最終承認できるか」で判定する（§6.1-3 の職務分離）。
// 規則の情報源を最終承認・リセット代行と1つに保つ（§3.2）。
import { canFinalApproveRequest } from "@/app/(app)/account-requests/approval-rules";

// ファイルの認可（§3.1 / §3.8 / §10.5）。
// fileId を参照するエンティティを特定し、そのエンティティの閲覧可否ルールを適用する。
// 判定は §5.1 の宣言的権限マップ（permissions.ts）の (feature, op) で行う（§3.2）。
// どのエンティティからも参照されていないファイルは拒否（fail-closed）。
export async function canAccessFile(user: CurrentUser, fileId: string): Promise<boolean> {
  const scope = await agencyScope(user); // null=全代理店 / 配列=そのIDのみ
  const inScope = (agencyId: string | null | undefined) =>
    scope === null ? true : !!agencyId && scope.includes(agencyId);

  // 販売員（⑨）は「自分のデータのみ」（§3.1）。自分の SalesStaff を解決する。
  const selfStaff =
    user.role === "R9"
      ? await prisma.salesStaff.findUnique({ where: { accountId: user.id }, select: { id: true } })
      : null;

  // 1) アカウント申請の証跡（§5.1 Airisアカウント）
  //    「自分が作成した申請」＋「その申請を承認できる立場の者」だけが参照できる。
  //    agencyId=NULL（SNC内部申請）は SNC系と作成者本人のみ。
  const req = await prisma.accountRequest.findFirst({
    where: { evidenceFileId: fileId },
    // role は職務分離（§6.1-3）の判定に必要
    select: { agencyId: true, createdBy: true, role: true },
  });
  if (req) {
    // AccountRequest.createdBy は Account.id（cuid）で保存される（account-requests/actions.ts）
    const isOwnRequest = !!req.createdBy && req.createdBy === user.id;
    // 申請者本人は自分が添付した証跡を参照できる（④⑤⑥⑧など閲覧権限が無いロールを含む）。
    // ④はAirisアカウント申請のみ実データを扱える（§3.5 の例外）ため、自己申請の証跡は許可し、
    // 他ロールの申請証跡は従来どおり見せない。
    if (isOwnRequest) return true;
    if (user.isDummy) return false;
    // 承認判断のために証跡を見るので、**その申請を最終承認できる者だけ**が参照できる。
    // §6.1-3 / 要件1-1 により、SNC系（①〜⑥）宛の申請を最終承認できるのは①②のみで、
    // ③は代理店系（⑦⑧⑩）に限定される。③が承認できない申請の証跡を見る業務上の必要はない。
    // （発注者指示 2026-08-06。QA loop4 の独立監査で「③が①〜⑥宛申請の証跡まで取得できる」
    //   ことを検出し、リセット代行と同じ職務分離の規則へ揃えた）
    if (canFinalApproveRequest(user.role, req.role)) return true;
    // ⑦（1次承認権限 §6.1-3）は自店スコープ内の申請のみ。agencyId=NULL（SNC内部申請）は不可
    if (canApproveFirst(user.role, "airis-account")) return inScope(req.agencyId);
    return false;
  }

  // 2) 訪販員申請の誓約書PDF（§5.1 訪販員申請）
  const app = await prisma.fieldAgentApplication.findFirst({
    where: { pledgeFileId: fileId },
    select: { salesStaffId: true, salesStaff: { select: { agencyId: true } } },
  });
  if (app) {
    if (!can(user.role, "field-agent", "view")) {
      // ⑨は訪販員申請の閲覧権限を持たない（自分の申請でも×。§5.1）
      return false;
    }
    if (user.isDummy) return inScope(app.salesStaff?.agencyId); // ④はダミー代理店のみ
    return inScope(app.salesStaff?.agencyId);
  }

  // 3) 稼働提出物のファイル（§5.1 稼働提出物: ⑨⑩=×）
  const sub = await prisma.submission.findFirst({
    where: { fileId },
    select: { submitterAgencyId: true, primaryAgencyId: true },
  });
  if (sub) {
    if (!can(user.role, "submission", "view") && !can(user.role, "submission", "submit")) {
      return false; // ⑨⑩ は取得不可
    }
    return inScope(sub.submitterAgencyId) || inScope(sub.primaryAgencyId);
  }

  // 4) 窓口案件メッセージの添付（§5.1 ホットライン/消費者センター）
  const msgs = await prisma.caseMessage.findMany({
    select: {
      fileIds: true,
      case_: { select: { series: true, primaryAgencyId: true, secondaryAgencyId: true } },
    },
  });
  for (const m of msgs) {
    const ids = Array.isArray(m.fileIds) ? (m.fileIds as { id: string }[]) : [];
    if (!ids.some((f) => f.id === fileId)) continue;
    const c = m.case_;
    const feature = caseFeature(c.series);
    if (!can(user.role, feature, "view")) return false; // ④⑧⑨は×
    return inScope(c.primaryAgencyId) || inScope(c.secondaryAgencyId);
  }

  // 5) お知らせの添付（§5.1 お知らせ / §7.7 ライフサイクル）
  //    draft・stopped は「変更権限を持つ①②③」のみ、sent は配信対象ロール。
  const anns = await prisma.announcement.findMany({
    where: { status: { in: ["draft", "sent", "stopped"] } },
    select: { fileIds: true, audience: true, isDummy: true, status: true },
  });
  for (const a of anns) {
    const ids = Array.isArray(a.fileIds) ? (a.fileIds as { id: string }[]) : [];
    if (!ids.some((f) => f.id === fileId)) continue;
    if (a.isDummy !== user.isDummy) return false; // ④ダミー分離
    const feature = announcementFeature(a.audience);
    if (a.status === "draft" || a.status === "stopped") {
      // 未配信・配信停止中は管理側（変更権限保持者）のみ
      return can(user.role, feature, "update");
    }
    return can(user.role, feature, "view");
  }

  // 6) ドキュメント（§7.12 公開範囲）
  const doc = await prisma.document.findFirst({
    where: { fileId },
    select: { visibility: true, isDummy: true },
  });
  if (doc) {
    if (doc.isDummy !== user.isDummy) return false;
    // §5.2: ドキュメントページは①②③⑤⑥⑦⑧⑨（④はダミー）。⑩は×
    if (user.role === "R10") return false;
    if (doc.visibility === "snc") return ["R1", "R2", "R3", "R5", "R6"].includes(user.role);
    if (doc.visibility === "primary")
      return ["R1", "R2", "R3", "R5", "R6", "R7"].includes(user.role);
    return true; // all
  }

  // 7) 日報にはファイル添付が無い（CSVは都度生成）。ここに到達＝孤立ファイル → 拒否
  void selfStaff;
  return false;
}
