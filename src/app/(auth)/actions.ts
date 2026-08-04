"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { ADMIN_PW_ROLES, Role } from "@/lib/roles";
import { audit } from "@/lib/util";

const PW_HISTORY_GENERATIONS = 24; // §4.2 再利用禁止: 過去24世代

// パスワード有効期間（§4.2: ①②③⑦=90日 / その他=180日）
function passwordMaxAgeDays(role: string): number {
  return ADMIN_PW_ROLES.includes(role as Role) ? 90 : 180;
}

// アクセスログ用のIP・User-Agent（§3.3 要件1-6）
async function requestMeta(): Promise<{ ip: string; ua: string }> {
  try {
    const h = await headers();
    const fwd = h.get("x-forwarded-for");
    const ip = fwd?.split(",")[0]?.trim() || "local";
    const ua = h.get("user-agent") ?? "";
    return { ip, ua };
  } catch {
    return { ip: "local", ua: "" };
  }
}

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  const loginId = String(formData.get("loginId") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!loginId || !password) return { error: "IDとパスワードを入力してください" };

  const { ip, ua } = await requestMeta();

  const account = await prisma.account.findUnique({ where: { loginId }, include: { agency: true } });
  if (!account || account.status === "deleted" || account.status === "suspended") {
    await audit(loginId, "login", `ua=${ua}`, "failure", ip);
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
    await audit(loginId, "login", `ua=${ua}`, "failure", ip);
    return { error: "IDまたはパスワードが正しくありません" };
  }

  // パスワード有効期限（§4.2）: 期限超過なら強制変更フラグを立てて/passwordへ誘導
  const maxAgeMs = passwordMaxAgeDays(account.role) * 24 * 3600 * 1000;
  const expired = Date.now() - account.passwordUpdatedAt.getTime() > maxAgeMs;
  const mustChangePassword = account.mustChangePassword || expired;

  await prisma.account.update({
    where: { id: account.id },
    data: { failedAttempts: 0, lockedUntil: null, ...(expired ? { mustChangePassword: true } : {}) },
  });
  await createSession(account.id);
  await audit(loginId, "login", `ua=${ua}`, "success", ip);
  redirect(mustChangePassword ? "/password" : "/dashboard");
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

  // 再利用禁止（§4.2: 過去24世代）: 現在のパスワード + PasswordHistory（直近24世代）と照合
  const history = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PW_HISTORY_GENERATIONS,
  });
  if (
    verifyPassword(next, account.passwordHash) ||
    history.some((h) => verifyPassword(next, h.hash))
  ) {
    return { error: "過去24世代と同じパスワードは使用できません" };
  }

  // 旧パスワードを履歴へ保存してから更新（24世代を超える古い履歴は削除）
  await prisma.passwordHistory.create({
    data: { accountId: user.id, hash: account.passwordHash },
  });
  await prisma.account.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(next), mustChangePassword: false, passwordUpdatedAt: new Date() },
  });
  const excess = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: PW_HISTORY_GENERATIONS,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.passwordHistory.deleteMany({ where: { id: { in: excess.map((e) => e.id) } } });
  }
  await audit(user.loginId, "password_change");
  redirect("/dashboard");
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) await audit(user.loginId, "logout");
  await destroySession();
  redirect("/login");
}
