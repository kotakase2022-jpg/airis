"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { hashPassword, requirePage } from "@/lib/auth";
import { ADMIN_PW_ROLES, ROLE_LABELS, Role } from "@/lib/roles";
import { audit } from "@/lib/util";

export type AdminActionState =
  | { error?: string; message?: string; tempPassword?: string; targetLoginId?: string }
  | undefined;

// 一時パスワード生成（大文字・小文字・数字を必ず含む。紛らわしい文字は除外）
function generateTempPassword(len: number): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

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

  switch (op) {
    case "suspend": {
      if (account.status !== "active") return { error: "登録済みのアカウントのみ停止できます" };
      await prisma.account.update({ where: { id }, data: { status: "suspended" } });
      await prisma.session.deleteMany({ where: { accountId: id } }); // 即時セッション破棄
      await audit(user.loginId, "account_suspend", account.loginId);
      revalidatePath("/admin");
      return { message: `${account.loginId} を停止しました` };
    }
    case "resume": {
      if (account.status !== "suspended") return { error: "停止中のアカウントのみ再開できます" };
      await prisma.account.update({ where: { id }, data: { status: "active" } });
      await audit(user.loginId, "account_resume", account.loginId);
      revalidatePath("/admin");
      return { message: `${account.loginId} を再開しました` };
    }
    case "delete": {
      if (account.status === "deleted") return { error: "すでに削除済です" };
      // §3.4 論理削除（物理削除しない・1年間保持）
      // TODO: 1年経過後の個人情報カラム匿名化は日次バッチで実装（本モジュール外）
      await prisma.account.update({
        where: { id },
        data: { status: "deleted", deletedAt: new Date() },
      });
      await prisma.session.deleteMany({ where: { accountId: id } });
      await audit(user.loginId, "account_delete", account.loginId);
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
      await audit(user.loginId, "account_restore", account.loginId);
      revalidatePath("/admin");
      return { message: `${account.loginId} を復旧しました（停止中として復元）` };
    }
    case "reset_password": {
      if (account.status === "deleted") return { error: "削除済のアカウントはリセットできません" };
      // ロール別パスワード最小桁数（§4.2: 管理者20桁/一般14桁）を満たす長さで生成
      const len = ADMIN_PW_ROLES.includes(account.role as Role) ? 24 : 16;
      const temp = generateTempPassword(len);
      await prisma.account.update({
        where: { id },
        data: {
          passwordHash: hashPassword(temp),
          mustChangePassword: true,
          passwordUpdatedAt: new Date(),
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
      await prisma.session.deleteMany({ where: { accountId: id } });
      await audit(user.loginId, "password_reset", account.loginId);
      revalidatePath("/admin");
      // 一時パスワードは戻り値でのみ返し、DB・URLには残さない（一度だけインライン表示）
      return { tempPassword: temp, targetLoginId: account.loginId };
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

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!id || !name) return { error: "氏名は必須です" };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "メールアドレスの形式が不正です" };

  const account = await prisma.account.findUnique({ where: { id }, include: { agency: true } });
  if (!account) return { error: "対象アカウントが見つかりません" };
  if (account.agency?.isDummy) return { error: "サンプルデータのアカウントは操作できません" };
  if (account.role === "R9") return { error: "販売員IDのアカウントは販売員ID管理から変更してください" };

  // ロール変更の許容範囲: 代理店非所属アカウントはSNC系（R1〜R6）内、
  // 代理店所属アカウントはR7/R8内でのみ変更可能（所属と役割の整合を保つ）
  const allowedRoles: Role[] = account.agencyId ? ["R7", "R8"] : ["R1", "R2", "R3", "R4", "R5", "R6"];
  if (!allowedRoles.includes(role as Role)) return { error: "指定できないロールです" };

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

  const roleChanged = role !== account.role;
  await prisma.account.update({
    where: { id },
    data: { name, email: email || null, role },
  });
  if (roleChanged) {
    // 権限変更は即時反映のためセッション破棄（次回ログインから新ロール）
    await prisma.session.deleteMany({ where: { accountId: id } });
  }
  await audit(
    user.loginId,
    roleChanged ? "account_role_change" : "account_update",
    roleChanged
      ? `${account.loginId}: ${ROLE_LABELS[account.role as Role]} → ${ROLE_LABELS[role as Role]}`
      : account.loginId
  );
  revalidatePath("/admin");
  return { message: `${account.loginId} を更新しました` };
}
