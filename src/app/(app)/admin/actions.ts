"use server";

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { agencyScope, hashPassword, requirePage } from "@/lib/auth";
import { ADMIN_PW_ROLES, Role } from "@/lib/roles";
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

  const account = await prisma.account.findUnique({ where: { id } });
  if (!account) return { error: "対象アカウントが見つかりません" };

  // 代理店スコープ検証（§3.1。管理画面はR1/R2のみ＝null=全代理店だが多層防御として実施）
  const scope = await agencyScope(user);
  if (scope !== null && (!account.agencyId || !scope.includes(account.agencyId))) {
    await audit(user.loginId, `account_${op}`, account.loginId, "denied");
    return { error: "権限がありません" };
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
