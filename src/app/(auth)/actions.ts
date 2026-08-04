"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { ADMIN_PW_ROLES, Role } from "@/lib/roles";
import { audit } from "@/lib/util";

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  const loginId = String(formData.get("loginId") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!loginId || !password) return { error: "IDとパスワードを入力してください" };

  const account = await prisma.account.findUnique({ where: { loginId }, include: { agency: true } });
  if (!account || account.status === "deleted" || account.status === "suspended") {
    await audit(loginId, "login", undefined, "failure");
    return { error: "IDまたはパスワードが正しくありません" };
  }
  if (account.lockedUntil && account.lockedUntil > new Date()) {
    return { error: "アカウントがロックされています。しばらくしてから再試行してください" };
  }
  if (!verifyPassword(password, account.passwordHash)) {
    const attempts = account.failedAttempts + 1;
    await prisma.account.update({
      where: { id: account.id },
      data: {
        failedAttempts: attempts,
        lockedUntil: attempts >= 10 ? new Date(Date.now() + 30 * 60 * 1000) : null,
      },
    });
    await audit(loginId, "login", undefined, "failure");
    return { error: "IDまたはパスワードが正しくありません" };
  }
  await prisma.account.update({
    where: { id: account.id },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  await createSession(account.id);
  await audit(loginId, "login");
  redirect(account.mustChangePassword ? "/password" : "/dashboard");
}

export async function changePasswordAction(_prev: { error?: string } | undefined, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const account = await prisma.account.findUnique({ where: { id: user.id } });
  if (!account || !verifyPassword(current, account.passwordHash)) {
    return { error: "現在のパスワードが正しくありません" };
  }
  if (next !== confirm) return { error: "新しいパスワードが一致しません" };
  const minLen = ADMIN_PW_ROLES.includes(user.rawRole as Role) ? 20 : 14;
  if (next.length < minLen) return { error: `パスワードは${minLen}桁以上にしてください` };
  if (!/[A-Z]/.test(next) || !/[a-z]/.test(next) || !/[0-9]/.test(next)) {
    return { error: "大文字・小文字・数字をそれぞれ含めてください" };
  }
  await prisma.account.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(next), mustChangePassword: false, passwordUpdatedAt: new Date() },
  });
  await audit(user.loginId, "password_change");
  redirect("/dashboard");
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) await audit(user.loginId, "logout");
  await destroySession();
  redirect("/login");
}
