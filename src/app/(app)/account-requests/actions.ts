"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope, hashPasswordWithPepperVersion } from "@/lib/auth";
import { REQUESTABLE_ROLES, ROLE_LABELS, Role, needsFirstApproval } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import {
  audit,
  currentRls,
  notify,
  pushHistory,
  requiresAgency,
  storeFile,
  withScopedTransaction,
} from "@/lib/util";
import { recordStatusHistory, type StatusEvent } from "@/lib/status";
import { generateTempPassword } from "@/lib/temp-password";
import { canFinalApproveRequest, SNC_TARGET_DENIED_MESSAGE } from "./approval-rules";

// 状態遷移を StatusHistory（§4.1「遷移イベントを履歴テーブルに記録」）へ記録する。
// JSON列 history は画面表示用の軽量な履歴で、エンティティ横断の検索・監査には使えないため
// 両方に記録する（recordStatusHistory は失敗しても業務処理を止めない）。
function track(
  entityId: string,
  event: StatusEvent,
  fromStatus: string | null,
  toStatus: string | null,
  changedBy: string,
  reason?: string | null
) {
  return recordStatusHistory({
    entityType: "account_request",
    entityId,
    event,
    fromStatus,
    toStatus,
    reason,
    changedBy,
  });
}

export type ActionState =
  | {
      error?: string;
      ok?: boolean;
      message?: string;
      issuedLoginId?: string;
      tempPassword?: string;
    }
  | undefined;

// メール重複チェック（問題一覧No.39 / §4.1「1人1ID」）。
// 有効なアカウント（削除済みを除く）と審査中の申請を対象に重複を検出する。
// 戻り値: 重複ありならエラーメッセージ / なければ null
async function emailInUse(email: string, excludeRequestId?: string): Promise<string | null> {
  const account = await prisma.account.findFirst({
    where: { email, status: { not: "deleted" } },
    select: { loginId: true },
  });
  if (account) return "このメールアドレスは既存のアカウントで使用されています";
  const pending = await prisma.accountRequest.findFirst({
    where: {
      email,
      status: { in: ["pending_first", "pending_final"] },
      ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
    },
    select: { requestId: true },
  });
  if (pending) return "このメールアドレスは審査中の申請で使用されています";
  return null;
}

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

  // §5.1「Airisアカウント / 申」の権限（①〜⑧）をAPI層でも判定する（§3.2 多層防御）
  if (!can(user.role, "airis-account", "apply")) {
    await audit(user.loginId, "account_request_create", `role=${user.role}`, "denied");
    return { error: "アカウント申請の権限がありません" };
  }
  // 申請可能な対象ロールの制限（§6.1-1）
  if (!REQUESTABLE_ROLES[user.role].includes(role)) {
    return { error: "このロールを申請する権限がありません" };
  }
  if (!name) return { error: "氏名を入力してください" };
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return { error: "メールアドレスを正しく入力してください" };
  }
  // メール重複チェック（検収指摘 問題一覧No.39）: 1人1ID原則（§4.1）のため、
  // 既存アカウント（削除済み除く）・審査中の申請と同一メールは受け付けない
  const dup = await emailInUse(email);
  if (dup) return { error: dup };

  // 代理店系ロール（⑦⑧⑩）は所属代理店が必須（§4 のID体系）
  const needsAgency = requiresAgency(role);
  let agencyId: string | null = null;
  if (needsAgency) {
    if (!agencyIdInput) return { error: "所属代理店を選択してください" };
    const agency = await prisma.agency.findUnique({ where: { id: agencyIdInput } });
    if (!agency) return { error: "所属代理店が見つかりません" };
    if (role === "R7" && agency.tier !== 1)
      return { error: "一次代理店管理者には1次代理店を選択してください" };
    if (role === "R8" && agency.tier !== 2)
      return { error: "二次代理店管理者には2次代理店を選択してください" };
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

  // ⑧からの申請は⑦の1次承認を経てSNCへ（§6.1）。対象ロールは roles.ts の宣言的マップから導出する
  const status = needsFirstApproval(user.role) ? "pending_first" : "pending_final";
  const requestId = `REQ-${Date.now()}`;

  const created = await prisma.accountRequest.create({
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

  await track(created.id, "requested", null, status, user.loginId, `requestId=${requestId}`);
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
  // §5.1「Airisアカウント / 一承」は⑦のみ（canApproveFirst は airis-account では
  // 最終承認権限の内含を適用しない = §6.1-3 で1次承認者が⑦に限定されるため）
  if (!canApproveFirst(user.role, "airis-account")) {
    return { error: "1次承認の権限がありません" };
  }

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

  await track(
    req.id,
    "approve_first",
    req.status,
    "pending_final",
    user.loginId,
    `requestId=${req.requestId}`
  );
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
function loginPrefix(role: string, agency: { code: string; tier: number } | null): string | null {
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

export async function finalApproveAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  const user = await requirePage("account-requests");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };
  // §5.1「Airisアカウント / 承」= ①②③
  if (!can(user.role, "airis-account", "approve_final")) {
    return { error: "最終承認の権限がありません" };
  }

  const id = String(formData.get("id") ?? "");
  const req = await prisma.accountRequest.findUnique({ where: { id } });
  if (!req) return { error: "申請が見つかりません" };
  if (req.status !== "pending_final") return { error: "最終承認待ちの申請ではありません" };

  // 職務分離（§6.1-3 / 要件1-1）: SNC系ロール（①〜⑥）の申請は①②のみ最終承認可能。
  // ③（SNC運用者）は代理店系（⑦⑧⑩）の最終承認に限定される。
  if (!canFinalApproveRequest(user.role, req.role)) {
    await audit(
      user.loginId,
      "account_request_final_approve",
      `${req.requestId} role=${req.role} by=${user.role}`,
      "denied"
    );
    return { error: SNC_TARGET_DENIED_MESSAGE };
  }

  // 承認時にも重複を再検証（申請後に同一メールのアカウントが発行された場合の抜け対策）
  const dupAtApproval = await emailInUse(req.email, req.id);
  if (dupAtApproval) {
    return { error: `${dupAtApproval}。申請内容を確認し、必要なら却下してください` };
  }

  const agency = req.agencyId
    ? await prisma.agency.findUnique({ where: { id: req.agencyId } })
    : null;
  const prefix = loginPrefix(req.role, agency ? { code: agency.code, tier: agency.tier } : null);
  if (!prefix) return { error: "所属代理店情報が不足しているためIDを採番できません" };

  // 一時パスワード: DBにはハッシュのみ保存し、平文は戻り値で承認者に一度だけ表示
  const tempPassword = generateTempPassword(req.role);
  // ハッシュと同時に適用したペッパーのバージョンIDを保存する（SEC-021。
  // ここで pepperVersion を落とすとローテーションの移行完了判定が成立しない）
  const { hash: passwordHash, pepperVersion } = hashPasswordWithPepperVersion(tempPassword);

  // Account 発行 + AccountRequest 更新は**同一トランザクション**で行う（§3.6 / §3.1）。
  // ID採番（同prefixの件数+1。③のみ4桁、他は3桁）もトランザクション内で行い、
  // 申請の状態を `pending_final` で条件付き更新することで二重承認・採番競合を防ぐ。
  const rls = await currentRls();
  let issuedLoginId: string;
  try {
    issuedLoginId = await withScopedTransaction(rls, async (tx) => {
      const count = await tx.account.count({ where: { loginId: { startsWith: prefix } } });
      const digits = req.role === "R3" ? 4 : 3;
      const loginId = prefix + String(count + 1).padStart(digits, "0");

      await tx.account.create({
        data: {
          loginId,
          role: req.role,
          name: req.name,
          email: req.email,
          agencyId: req.agencyId,
          status: "active",
          passwordHash,
          pepperVersion, // 適用したペッパーのバージョンID（SEC-021。落とすと再ハッシュ判定が壊れる）
          mustChangePassword: true,
        },
      });

      const updated = await tx.accountRequest.updateMany({
        where: { id: req.id, status: "pending_final" },
        data: {
          status: "approved",
          issuedLoginId: loginId,
          history: pushHistory(req.history, "final_approve", user.loginId) as never,
        },
      });
      // 他の承認者が同時に承認済み → 全件ロールバック（アカウントも作られない）
      if (updated.count !== 1) throw new Error("account_request_conflict");
      return loginId;
    });
  } catch {
    await audit(user.loginId, "account_request_final_approve", req.requestId, "failure");
    return {
      error: "承認処理が競合したため中断しました。一覧を再読み込みして状態を確認してください",
    };
  }

  await track(
    req.id,
    "final_approve",
    req.status,
    "approved",
    user.loginId,
    `requestId=${req.requestId} -> ${issuedLoginId}`
  );
  await audit(
    user.loginId,
    "account_request_final_approve",
    `${req.requestId} -> ${issuedLoginId}`
  );
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
export async function rejectAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
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
  let sncTargetDenied = false;
  if (can(user.role, "airis-account", "approve_final")) {
    // 却下も最終承認と同じ職務分離制約（§6.1-3 / 要件1-1）:
    // SNC系ロール（①〜⑥）の申請は①②のみ却下できる（③は⑦⑧⑩に限定）
    allowed = canFinalApproveRequest(user.role, req.role);
    sncTargetDenied = !allowed;
  } else if (canApproveFirst(user.role, "airis-account") && req.status === "pending_first") {
    const scope = await agencyScope(user);
    allowed = !!req.agencyId && (scope ?? []).includes(req.agencyId);
  }
  if (!allowed) {
    await audit(
      user.loginId,
      "account_request_reject",
      `${req.requestId} role=${req.role} by=${user.role}`,
      "denied"
    );
    return { error: sncTargetDenied ? SNC_TARGET_DENIED_MESSAGE : "却下の権限がありません" };
  }

  await prisma.accountRequest.update({
    where: { id: req.id },
    data: {
      status: "rejected",
      rejectReason: reason,
      history: pushHistory(req.history, "reject", user.loginId) as never,
    },
  });

  await track(req.id, "reject", req.status, "rejected", user.loginId, reason);
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
