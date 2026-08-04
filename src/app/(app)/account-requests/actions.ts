"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope, hashPassword } from "@/lib/auth";
import { REQUESTABLE_ROLES, SNC_ADMIN_ROLES, ROLE_LABELS, Role } from "@/lib/roles";
import { audit, notify, pushHistory, storeFile } from "@/lib/util";

export type ActionState =
  | {
      error?: string;
      ok?: boolean;
      message?: string;
      issuedLoginId?: string;
      tempPassword?: string;
    }
  | undefined;

// ---------------------------------------------------------------------------
// 申請作成（§6.1 / §7.2）
// ---------------------------------------------------------------------------
export async function createRequestAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requirePage("account-requests");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません" };

  const role = String(formData.get("role") ?? "") as Role;
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const agencyIdInput = String(formData.get("agencyId") ?? "").trim();

  // 申請可能ロールの制限（§6.1）
  if (!REQUESTABLE_ROLES[user.role].includes(role)) {
    return { error: "このロールを申請する権限がありません" };
  }
  if (!name) return { error: "氏名を入力してください" };
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return { error: "メールアドレスを正しく入力してください" };
  }

  // 代理店系ロール（⑦⑧⑩）は所属代理店が必須
  const needsAgency = role === "R7" || role === "R8" || role === "R10";
  let agencyId: string | null = null;
  if (needsAgency) {
    if (!agencyIdInput) return { error: "所属代理店を選択してください" };
    const agency = await prisma.agency.findUnique({ where: { id: agencyIdInput } });
    if (!agency) return { error: "所属代理店が見つかりません" };
    if (role === "R7" && agency.tier !== 1) return { error: "一次代理店管理者には1次代理店を選択してください" };
    if (role === "R8" && agency.tier !== 2) return { error: "二次代理店管理者には2次代理店を選択してください" };
    if (!user.isDummy && agency.isDummy) return { error: "所属代理店が不正です" };
    // 代理店スコープ検証（§3.1）: クライアント由来のIDを信用しない
    const scope = await agencyScope(user);
    if (scope !== null && !scope.includes(agency.id)) {
      return { error: "操作可能な範囲外の代理店です" };
    }
    agencyId = agency.id;
  }

  // 上長承認証跡ファイル（必須）
  const evidence = formData.get("evidence");
  if (!(evidence instanceof File) || evidence.size === 0) {
    return { error: "上長承認証跡ファイルを添付してください" };
  }
  const stored = await storeFile(evidence, user.loginId);
  if ("error" in stored) return { error: stored.error };

  // ⑧からの申請は⑦の1次承認を経てSNCへ（§6.1）
  const status = user.role === "R8" ? "pending_first" : "pending_final";
  const requestId = `REQ-${Date.now()}`;

  await prisma.accountRequest.create({
    data: {
      requestId,
      role,
      name,
      email,
      agencyId,
      evidenceFileId: stored.id,
      status,
      history: pushHistory([], "requested", user.loginId) as never,
      createdBy: user.id,
    },
  });

  await audit(user.loginId, "account_request_create", requestId);
  revalidatePath("/account-requests");
  return { ok: true, message: `アカウント申請を受け付けました（${requestId}）` };
}

// ---------------------------------------------------------------------------
// 1次承認（⑦のみ: pending_first → pending_final）
// ---------------------------------------------------------------------------
export async function firstApproveAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requirePage("account-requests");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };
  if (user.role !== "R7") return { error: "1次承認の権限がありません" };

  const id = String(formData.get("id") ?? "");
  const req = await prisma.accountRequest.findUnique({ where: { id } });
  if (!req) return { error: "申請が見つかりません" };
  if (req.status !== "pending_first") return { error: "1次承認待ちの申請ではありません" };

  const scope = await agencyScope(user);
  if (!req.agencyId || !(scope ?? []).includes(req.agencyId)) {
    return { error: "操作可能な範囲外の申請です" };
  }

  await prisma.accountRequest.update({
    where: { id: req.id },
    data: {
      status: "pending_final",
      history: pushHistory(req.history, "approve_first", user.loginId) as never,
    },
  });

  await audit(user.loginId, "account_request_approve_first", req.requestId);
  if (req.createdBy) {
    await notify(
      req.createdBy,
      "アカウント申請が1次承認されました",
      `${req.requestId}（${req.name}）はSNCの最終承認待ちになりました。`,
      "/account-requests"
    );
  }
  revalidatePath("/account-requests");
  return { ok: true, message: "1次承認しました" };
}

// ---------------------------------------------------------------------------
// 最終承認（①②③: pending_final → approved + Account発行）
// ---------------------------------------------------------------------------

// loginId 自動採番のプレフィックス（§4 / 指示のID体系）
function loginPrefix(
  role: string,
  agency: { code: string; tier: number } | null
): string | null {
  switch (role) {
    case "R1":
      return "airis_slb_sys_";
    case "R2":
      return "airis_snc_adm_";
    case "R3":
      return "airis_snc_ops_";
    case "R4":
      return "airis_snc_vew_";
    case "R5":
      return "airis_snc_spt1_";
    case "R6":
      return "airis_snc_spt2_";
    case "R7":
      return agency ? `airis_1${agency.code}_` : null;
    case "R8":
      return agency ? `airis_2${agency.code}_` : null;
    case "R10":
      // TODO: ⑩は稼働終了した⑦⑧のIDを流用する運用（§4）。新規発行時は代理店tierからID体系を暫定判断
      return agency ? `airis_${agency.tier === 2 ? "2" : "1"}${agency.code}_` : null;
    default:
      return null;
  }
}

function generateTempPassword(): string {
  // 紛らわしい文字（I/l/O/0/1）を除いた英大小+数字で24文字
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(24);
  let pw = "";
  for (const b of bytes) pw += chars[b % chars.length];
  return pw;
}

export async function finalApproveAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requirePage("account-requests");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };
  if (!SNC_ADMIN_ROLES.includes(user.role)) return { error: "最終承認の権限がありません" };

  const id = String(formData.get("id") ?? "");
  const req = await prisma.accountRequest.findUnique({ where: { id } });
  if (!req) return { error: "申請が見つかりません" };
  if (req.status !== "pending_final") return { error: "最終承認待ちの申請ではありません" };

  const agency = req.agencyId
    ? await prisma.agency.findUnique({ where: { id: req.agencyId } })
    : null;
  const prefix = loginPrefix(req.role, agency ? { code: agency.code, tier: agency.tier } : null);
  if (!prefix) return { error: "所属代理店情報が不足しているためIDを採番できません" };

  // 連番採番: 既存同prefix数+1（③のみ4桁、他は3桁）
  // TODO: 同時承認による採番競合は速度優先で未対応（unique制約で失敗した場合は再実行で回復）
  const count = await prisma.account.count({ where: { loginId: { startsWith: prefix } } });
  const digits = req.role === "R3" ? 4 : 3;
  const issuedLoginId = prefix + String(count + 1).padStart(digits, "0");

  // 一時パスワード: DBにはハッシュのみ保存し、平文は戻り値で承認者に一度だけ表示
  const tempPassword = generateTempPassword();

  await prisma.account.create({
    data: {
      loginId: issuedLoginId,
      role: req.role,
      name: req.name,
      email: req.email,
      agencyId: req.agencyId,
      status: "active",
      passwordHash: hashPassword(tempPassword),
      mustChangePassword: true,
    },
  });

  await prisma.accountRequest.update({
    where: { id: req.id },
    data: {
      status: "approved",
      issuedLoginId,
      history: pushHistory(req.history, "final_approve", user.loginId) as never,
    },
  });

  await audit(user.loginId, "account_request_final_approve", `${req.requestId} -> ${issuedLoginId}`);
  if (req.createdBy) {
    await notify(
      req.createdBy,
      "アカウント申請が承認されました",
      `${req.requestId}（${ROLE_LABELS[req.role as Role] ?? req.role}・${req.name}）のアカウントが発行されました: ${issuedLoginId}`,
      "/account-requests"
    );
  }
  revalidatePath("/account-requests");
  return { ok: true, issuedLoginId, tempPassword };
}

// ---------------------------------------------------------------------------
// 却下（①②③は全承認待ち、⑦はpending_firstのみ）
// ---------------------------------------------------------------------------
export async function rejectAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requirePage("account-requests");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!reason) return { error: "却下理由を入力してください" };

  const req = await prisma.accountRequest.findUnique({ where: { id } });
  if (!req) return { error: "申請が見つかりません" };

  const pending = req.status === "pending_first" || req.status === "pending_final";
  if (!pending) return { error: "承認待ちの申請ではありません" };

  let allowed = false;
  if (SNC_ADMIN_ROLES.includes(user.role)) {
    allowed = true;
  } else if (user.role === "R7" && req.status === "pending_first") {
    const scope = await agencyScope(user);
    allowed = !!req.agencyId && (scope ?? []).includes(req.agencyId);
  }
  if (!allowed) return { error: "却下の権限がありません" };

  await prisma.accountRequest.update({
    where: { id: req.id },
    data: {
      status: "rejected",
      rejectReason: reason,
      history: pushHistory(req.history, "reject", user.loginId) as never,
    },
  });

  await audit(user.loginId, "account_request_reject", req.requestId);
  if (req.createdBy) {
    await notify(
      req.createdBy,
      "アカウント申請が却下されました",
      `${req.requestId}（${req.name}）: ${reason}`,
      "/account-requests"
    );
  }
  revalidatePath("/account-requests");
  return { ok: true, message: "却下しました" };
}
