"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, hashedForAccount } from "@/lib/auth";
import { REQUESTABLE_ROLES, ROLE_LABELS, Role } from "@/lib/roles";
import { audit, requiresAgency } from "@/lib/util";
import { recordStatusHistory, type StatusEvent } from "@/lib/status";
import { generateTempPassword } from "@/lib/temp-password";
import type { CurrentUser } from "@/lib/auth";
import {
  ADMIN_IP_ALLOWLIST_KEY,
  SETTING_DEFINITIONS,
  setSetting,
  type SettingKey,
} from "@/lib/settings";
import {
  ERASURE_ACTIONS,
  PII_ENTITY_LABELS,
  anonymizeEntity,
  eraseAgencyData,
  type ErasureActor,
  type ErasureReport,
  type PiiEntityType,
} from "@/lib/erasure";
import {
  ADMIN_OP_PERMISSION,
  canAdminAccountOp,
  canAnonymizePii,
  canEraseTenantData,
  canManageVendorFlag,
  canUpdateAccount,
  canUpdateSettings,
} from "./authz";
// 資格情報リセットの職務分離は最終承認と同じ規則を使う（規則の情報源を1つに保つ §3.2）
import {
  SNC_TARGET_RESET_DENIED_MESSAGE,
  canResetCredentialsFor,
} from "../account-requests/approval-rules";

export type AdminActionState =
  { error?: string; message?: string; tempPassword?: string; targetLoginId?: string } | undefined;

// セキュリティ設定の変更結果（§10.1）
export type SettingActionState = { error?: string; message?: string; warning?: string } | undefined;

// 削除実行の結果（§10.3。report は削除完了レポート SEC要件②#31）
export type ErasureActionState =
  { error?: string; message?: string; report?: ErasureReport } | undefined;

// 実行者のベンダー区分（Account.isVendor = サスラボ保守区分 §10.1）を解決する。
// セッション（CurrentUser）は isVendor を持たないため、操作時にDBから読む。
// 監査ログの target に vendor=true を含め、ベンダー操作を区別できるようにする（SEC要件①）。
async function actorContext(user: CurrentUser): Promise<ErasureActor> {
  const me = await prisma.account.findUnique({
    where: { id: user.id },
    select: { isVendor: true },
  });
  return { loginId: user.loginId, accountId: user.id, isVendor: !!me?.isVendor };
}

function withVendorMark(target: string, isVendor: boolean): string {
  return isVendor ? `${target} vendor=true` : target;
}

// アカウントの状態遷移を StatusHistory（§4.1「遷移イベントを履歴テーブルに記録」）へ記録する。
// Account は JSON列 history を持たないため、遷移履歴はこのテーブルのみが情報源になる。
// recordStatusHistory は失敗しても業務処理（停止・削除そのもの）を止めない。
function track(
  entityId: string,
  event: StatusEvent,
  fromStatus: string | null,
  toStatus: string | null,
  changedBy: string,
  reason?: string | null
) {
  return recordStatusHistory({
    entityType: "account",
    entityId,
    event,
    fromStatus,
    toStatus,
    reason,
    changedBy,
  });
}

// 管理画面の操作 → §5.1「Airisアカウント」列の操作の対応（§3.2 宣言的マップ経由で判定する）。
// §5.1 では 変/停/閲/削 はいずれも①②のみ。§6.1-5「Airisアカウントの停止・削除は①②のみ」。

// 一時パスワード生成（大文字・小文字・数字を必ず含む。紛らわしい文字は除外）

// 管理画面のアカウント操作（停止/再開/削除/復旧/パスワードリセット）
export async function accountAction(
  _prev: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  // 認可はaction内でも必ず検証（未認可はrequirePage内でリダイレクト）
  const user = await requirePage("admin");
  if (user.dummy) {
    // R4（SNC閲覧）は書き込み全面禁止（§3.5）
    await audit(user.loginId, "admin_account_action", undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }

  const id = String(formData.get("id") ?? "");
  const op = String(formData.get("op") ?? "");
  if (!id || !op) return { error: "不正なリクエストです" };

  // §5.1「Airisアカウント」の操作権限（変/停/削=①②）をAPI層でも判定する（§3.2 多層防御）。
  // 管理画面自体は §5.2 で①②のみ（requirePageで担保）だが、操作単位でも宣言的マップに照会する。
  // 判定は authz.ts の ADMIN_OP_PERMISSION から導出する（UI層と同じ導出＝乖離しない §3.2）
  if (!(op in ADMIN_OP_PERMISSION)) return { error: "不明な操作です" };
  if (!canAdminAccountOp(user.role, op)) {
    await audit(user.loginId, `account_${op}`, `role=${user.role}`, "denied");
    return { error: "この操作の権限がありません" };
  }

  const account = await prisma.account.findUnique({ where: { id }, include: { agency: true } });
  if (!account) return { error: "対象アカウントが見つかりません" };

  // 管理画面はR1/R2のみ（requirePageで担保）= 全アカウント（SNC系のagencyId=null含む）を操作可能。
  // ダミー代理店（④表示用）のアカウントのみ操作対象外とする。
  if (account.agency?.isDummy) {
    await audit(user.loginId, `account_${op}`, account.loginId, "denied");
    return { error: "サンプルデータのアカウントは操作できません" };
  }

  if (account.id === user.id) {
    return { error: "自分自身のアカウントは操作できません" };
  }

  // 職務分離（§6.1-3 / 要件1-1）: 資格情報リセットは対象ロールによって実行者を絞る。
  // §4.2 は「②③が実行」だが、MFAリセット→パスワードリセットの連続実行は
  // 対象アカウントの乗っ取りに等しい（一時パスワードが実行者に平文表示され、MFAも未登録に戻る）。
  // そのためSNC系（①〜⑥）が対象の場合は①②のみとし、③は代理店系のリセット代行に限定する。
  // 判定は account-requests の最終承認と同じ規則を使う（規則の情報源を1つに保つ §3.2）。
  if (op === "reset_password" || op === "mfa_reset") {
    if (!canResetCredentialsFor(user.role, account.role)) {
      await audit(
        user.loginId,
        `account_${op}`,
        `${account.loginId} target=${account.role} by=${user.role}`,
        "denied"
      );
      return { error: SNC_TARGET_RESET_DENIED_MESSAGE };
    }
  }

  // ベンダー（サスラボ社保守）による操作は監査ログで区別できるようにする（§10.1 / SEC要件①）
  const actor = await actorContext(user);
  const tgt = (target: string) => withVendorMark(target, actor.isVendor);

  switch (op) {
    case "suspend": {
      if (account.status !== "active") return { error: "登録済みのアカウントのみ停止できます" };
      await prisma.account.update({ where: { id }, data: { status: "suspended" } });
      await prisma.session.deleteMany({ where: { accountId: id } }); // 即時セッション破棄
      await track(id, "suspend", account.status, "suspended", user.loginId);
      await audit(user.loginId, "account_suspend", tgt(account.loginId));
      revalidatePath("/admin");
      return { message: `${account.loginId} を停止しました` };
    }
    case "resume": {
      if (account.status !== "suspended") return { error: "停止中のアカウントのみ再開できます" };
      await prisma.account.update({ where: { id }, data: { status: "active" } });
      await track(id, "resume", account.status, "active", user.loginId);
      await audit(user.loginId, "account_resume", tgt(account.loginId));
      revalidatePath("/admin");
      return { message: `${account.loginId} を再開しました` };
    }
    case "delete": {
      if (account.status === "deleted") return { error: "すでに削除済です" };
      // §3.4 論理削除（物理削除しない・1年間保持）。
      // 1年経過後の個人情報匿名化は日次バッチ（/api/cron/daily）で実施済み
      await prisma.account.update({
        where: { id },
        data: { status: "deleted", deletedAt: new Date() },
      });
      await prisma.session.deleteMany({ where: { accountId: id } });
      await track(
        id,
        "delete",
        account.status,
        "deleted",
        user.loginId,
        "論理削除・1年間保持（§3.4）"
      );
      await audit(user.loginId, "account_delete", tgt(account.loginId));
      revalidatePath("/admin");
      return { message: `${account.loginId} を削除しました（論理削除・1年間保持）` };
    }
    case "restore": {
      if (account.status !== "deleted") return { error: "削除済のアカウントのみ復旧できます" };
      // 復旧は安全のため「停止中」として復元し、再開操作で有効化する
      await prisma.account.update({
        where: { id },
        data: { status: "suspended", deletedAt: null },
      });
      await track(id, "restore", account.status, "suspended", user.loginId, "停止中として復元");
      await audit(user.loginId, "account_restore", tgt(account.loginId));
      revalidatePath("/admin");
      return { message: `${account.loginId} を復旧しました（停止中として復元）` };
    }
    case "reset_password": {
      if (account.status === "deleted") return { error: "削除済のアカウントはリセットできません" };
      // 桁数はロール別のポリシー最小桁数から導出する（§4.2 / SEC-004。src/lib/temp-password.ts）
      const temp = generateTempPassword(account.role);
      await prisma.account.update({
        where: { id },
        data: {
          ...hashedForAccount(temp), // passwordHash + pepperVersion（SEC-021）
          mustChangePassword: true,
          passwordUpdatedAt: new Date(),
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await prisma.session.deleteMany({ where: { accountId: id } });
      await audit(user.loginId, "password_reset", tgt(account.loginId));
      revalidatePath("/admin");
      // 一時パスワードは戻り値でのみ返し、DB・URLには残さない（一度だけインライン表示）
      return { tempPassword: temp, targetLoginId: account.loginId };
    }
    case "mfa_reset": {
      if (account.status === "deleted") return { error: "削除済のアカウントはリセットできません" };
      if (!account.mfaEnabled && !account.mfaSecret)
        return { error: "MFAが未登録のアカウントです" };
      // 認証アプリ紛失時のリセット（§4.2）。次回ログイン時にQRコードから再登録させる
      await prisma.account.update({
        where: { id },
        data: { mfaEnabled: false, mfaSecret: null },
      });
      await prisma.session.deleteMany({ where: { accountId: id } }); // 即時セッション破棄
      await audit(user.loginId, "mfa_reset", tgt(account.loginId));
      revalidatePath("/admin");
      return { message: `${account.loginId} のMFAをリセットしました（次回ログイン時に再登録）` };
    }
    default:
      return { error: "不明な操作です" };
  }
}

// アカウント情報の変更（氏名・メール・ロール §5.1「変」/ 要件1-1 権限変更。R1/R2のみ）
export async function updateAccountAction(
  _prev: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const user = await requirePage("admin");
  if (user.dummy) {
    await audit(user.loginId, "account_update", undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }
  // §5.1「Airisアカウント / 変」= ①②（権限変更は要件1-1でSNC課長以上）
  if (!canUpdateAccount(user.role)) {
    await audit(user.loginId, "account_update", `role=${user.role}`, "denied");
    return { error: "アカウント変更の権限がありません" };
  }

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!id || !name) return { error: "氏名は必須です" };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { error: "メールアドレスの形式が不正です" };

  const account = await prisma.account.findUnique({ where: { id }, include: { agency: true } });
  if (!account) return { error: "対象アカウントが見つかりません" };
  if (account.agency?.isDummy) return { error: "サンプルデータのアカウントは操作できません" };
  if (account.role === "R9")
    return { error: "販売員IDのアカウントは販売員ID管理から変更してください" };

  // メール重複チェック（問題一覧No.39 / §4.1「1人1ID」）: 他の有効アカウントと同一メールは不可
  if (email) {
    const dup = await prisma.account.findFirst({
      where: { email, status: { not: "deleted" }, id: { not: id } },
      select: { loginId: true },
    });
    if (dup) return { error: "このメールアドレスは他のアカウントで使用されています" };
  }

  // 付与できるロールの範囲（ハードコード配列を使わず宣言的マップから導出する §3.2）:
  //  - 操作者自身が申請・発行できるロールに限る（§6.1-1 の REQUESTABLE_ROLES）
  //  - ⑩は実効ロール（§14-2: Agency.status=closed から解決される）なので直接付与しない
  //  - 所属と役割の整合を保つ（代理店所属アカウント=⑦⑧ / 非所属=SNC系①〜⑥。§4 のID体系）
  const assignableRoles = REQUESTABLE_ROLES[user.role].filter(
    (r) => r !== "R10" && requiresAgency(r) === !!account.agencyId
  );
  if (!assignableRoles.includes(role as Role)) return { error: "指定できないロールです" };

  // 所属代理店の階層とロールの整合（§3.1 / 申請時の createRequestAction と同一ルール）:
  // ⑦一次代理店管理者は1次代理店、⑧二次代理店管理者は2次代理店に属していなければならない
  if (account.agencyId) {
    if (role === "R7" && account.agency?.tier !== 1) {
      return { error: "一次代理店管理者には1次代理店を選択してください" };
    }
    if (role === "R8" && account.agency?.tier !== 2) {
      return { error: "二次代理店管理者には2次代理店を選択してください" };
    }
  }
  if (account.id === user.id && role !== account.role) {
    return { error: "自分自身のロールは変更できません" };
  }

  // 変更理由（必須・監査ログに記録。検収指摘 問題一覧No.15）
  const reason = String(formData.get("reason") ?? "")
    .trim()
    .slice(0, 200);
  if (!reason) return { error: "変更理由を入力してください" };

  const roleChanged = role !== account.role;
  await prisma.account.update({
    where: { id },
    data: { name, email: email || null, role },
  });
  if (roleChanged) {
    // 権限変更は即時反映のためセッション破棄（次回ログインから新ロール）
    await prisma.session.deleteMany({ where: { accountId: id } });
  }
  const actor = await actorContext(user);
  const detail = roleChanged
    ? `${account.loginId}: ${ROLE_LABELS[account.role as Role]} → ${ROLE_LABELS[role as Role]}`
    : account.loginId;
  await track(
    id,
    "update",
    account.status,
    account.status,
    user.loginId,
    `${detail} reason=${reason}`
  );
  await audit(
    user.loginId,
    roleChanged ? "account_role_change" : "account_update",
    `${withVendorMark(detail, actor.isVendor)} reason=${reason}`
  );
  revalidatePath("/admin");
  return { message: `${account.loginId} を更新しました` };
}

// ===== ベンダー区分（Account.isVendor = サスラボ保守区分。§10.1 / SEC要件①） =====
// 「サスラボ社の保守アカウントも個人単位で発行し、同じ監査ログ基盤で記録（ベンダー区分属性を
// 持たせる）」を機能させるための変更経路。付与できるのは①のみ（authz.ts の導出根拠を参照）。
export async function updateVendorFlagAction(
  _prev: AdminActionState,
  formData: FormData
): Promise<AdminActionState> {
  const user = await requirePage("admin");
  if (user.dummy) {
    await audit(user.loginId, "account_vendor_change", undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }
  if (!canManageVendorFlag(user.role)) {
    await audit(user.loginId, "account_vendor_change", `role=${user.role}`, "denied");
    return {
      error: "ベンダー区分の変更権限がありません（サスラボ社システム管理アカウントのみ）",
    };
  }

  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("isVendor") ?? "") === "true";
  if (!id) return { error: "不正なリクエストです" };

  const account = await prisma.account.findUnique({ where: { id }, include: { agency: true } });
  if (!account) return { error: "対象アカウントが見つかりません" };
  if (account.agency?.isDummy) return { error: "サンプルデータのアカウントは操作できません" };
  if (account.isVendor === next) {
    return { error: `${account.loginId} のベンダー区分は既にその値です` };
  }

  await prisma.account.update({ where: { id }, data: { isVendor: next } });
  const actor = await actorContext(user);
  await audit(
    user.loginId,
    "account_vendor_change",
    withVendorMark(`${account.loginId}: isVendor ${account.isVendor} → ${next}`, actor.isVendor)
  );
  revalidatePath("/admin");
  return {
    message: `${account.loginId} のベンダー区分を${next ? "「ベンダー」に設定" : "解除"}しました`,
  };
}

// ===== セキュリティ設定の変更（§10.1 IP許可リスト / §3.3 設定変更の監査） =====
export async function updateSecuritySettingAction(
  _prev: SettingActionState,
  formData: FormData
): Promise<SettingActionState> {
  const user = await requirePage("admin");
  if (user.dummy) {
    await audit(user.loginId, "setting_change", undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }
  // §5.1「Airisアカウント / 変」= ①②（authz.ts で宣言的マップから導出）
  if (!canUpdateSettings(user.role)) {
    await audit(user.loginId, "setting_change", `role=${user.role}`, "denied");
    return { error: "設定変更の権限がありません" };
  }

  const key = String(formData.get("key") ?? "");
  if (key !== ADMIN_IP_ALLOWLIST_KEY) return { error: "不明な設定項目です" };
  const settingKey: SettingKey = key;
  const value = String(formData.get("settingValue") ?? "");
  const reason = String(formData.get("settingReason") ?? "")
    .trim()
    .slice(0, 200);
  if (!reason) return { error: "変更理由を入力してください" };

  const actor = await actorContext(user);
  const result = await setSetting(settingKey, value, actor, reason);
  if (!result.ok) return { error: result.error };

  revalidatePath("/admin");
  return {
    message: `${SETTING_DEFINITIONS[settingKey].label}を変更しました（変更前: ${
      result.before || "(未設定)"
    } → 変更後: ${result.after || "(未設定)"}）`,
    warning: result.warning,
  };
}

// ===== テナント（代理店）単位のデータ一括削除（§10.3 / SEC要件②#31） =====
export async function eraseAgencyAction(
  _prev: ErasureActionState,
  formData: FormData
): Promise<ErasureActionState> {
  const user = await requirePage("admin");
  if (user.dummy) {
    await audit(user.loginId, ERASURE_ACTIONS.agency, undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }
  if (!canEraseTenantData(user.role)) {
    await audit(user.loginId, ERASURE_ACTIONS.agency, `role=${user.role}`, "denied");
    return {
      error:
        "テナント単位のデータ一括削除の権限がありません（サスラボ社システム管理アカウントのみ）",
    };
  }

  const agencyId = String(formData.get("agencyId") ?? "");
  const includeChildren = String(formData.get("includeChildren") ?? "") === "on";
  const reason = String(formData.get("erasureReason") ?? "")
    .trim()
    .slice(0, 200);
  if (!reason) return { error: "削除理由を入力してください" };

  const actor = await actorContext(user);
  const result = await eraseAgencyData({ agencyId, includeChildren, reason, actor });
  if (!result.ok) return { error: result.error };

  revalidatePath("/admin");
  return {
    message: `${result.report.targetLabel} のデータを一括削除しました（論理削除 ${result.report.total}件）`,
    report: result.report,
  };
}

// ===== 個人情報のオンデマンド削除（匿名化。§10.3 / §3.4） =====
export async function anonymizePiiAction(
  _prev: ErasureActionState,
  formData: FormData
): Promise<ErasureActionState> {
  const user = await requirePage("admin");
  if (user.dummy) {
    await audit(user.loginId, ERASURE_ACTIONS.pii, undefined, "denied");
    return { error: "閲覧専用アカウントのため操作できません" };
  }
  if (!canAnonymizePii(user.role)) {
    await audit(user.loginId, ERASURE_ACTIONS.pii, `role=${user.role}`, "denied");
    return { error: "個人情報削除の権限がありません" };
  }

  const entityType = String(formData.get("entityType") ?? "");
  // 許可された種別のみ（プロトタイプ由来のキー "toString" 等を弾く）
  if (!Object.keys(PII_ENTITY_LABELS).includes(entityType)) return { error: "不明な対象種別です" };
  const key = String(formData.get("targetKey") ?? "");
  const reason = String(formData.get("anonymizeReason") ?? "")
    .trim()
    .slice(0, 200);
  if (!reason) return { error: "削除理由を入力してください" };

  const actor = await actorContext(user);
  const result = await anonymizeEntity({
    entityType: entityType as PiiEntityType,
    key,
    reason,
    actor,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/admin");
  return {
    message: `${result.report.targetLabel} の個人情報を匿名化しました（${result.report.scopeLabel}）`,
    report: result.report,
  };
}
