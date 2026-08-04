import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "./prisma";
import { PageKey, canAccess, isDummyView } from "./roles";
import { resolveSession, SESSION_COOKIE, type CurrentUser } from "./session";
import { audit } from "./util";

export type { CurrentUser } from "./session";

const ABS_HOURS = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 24);

export function hashPassword(pw: string) {
  return bcrypt.hashSync(pw, 10);
}
export function verifyPassword(pw: string, hash: string) {
  return bcrypt.compareSync(pw, hash);
}

export async function createSession(accountId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ABS_HOURS * 3600 * 1000);
  await prisma.session.create({ data: { token, accountId, expiresAt } });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ABS_HOURS * 3600,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
    store.delete(SESSION_COOKIE);
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const data = await resolveSession();
  return data?.user ?? null;
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/password");
  return user;
}

export async function requirePage(page: PageKey): Promise<CurrentUser & { dummy: boolean }> {
  const user = await requireUser();
  // 管理系画面へのIP許可リスト制御（§10.1 / SEC②#10）。ADMIN_IP_ALLOWLIST未設定時は無効。
  // 設定はカンマ区切りIPリスト。x-forwarded-for先頭を接続元とみなす（信頼できるプロキシ配下前提）。
  if (page === "admin" && process.env.ADMIN_IP_ALLOWLIST) {
    try {
      const h = await headers();
      const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
      const allowed = process.env.ADMIN_IP_ALLOWLIST.split(",").map((s) => s.trim());
      if (!allowed.includes(ip)) {
        await audit(user.loginId, "access_denied", `page=admin ip=${ip} (allowlist)`, "denied");
        redirect("/dashboard");
      }
    } catch (e) {
      // redirect()はthrowで実現されるため再スロー。headers()不可時のみ通過
      if ((e as Error & { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) throw e;
    }
  }
  if (!canAccess(user.role, page)) {
    // 権限外アクセスの試みも記録（§3.3 / SEC②#35）
    await audit(user.loginId, `access_denied`, `page=${page} role=${user.role}`, "denied");
    redirect("/dashboard");
  }
  // 閲覧イベント監査（§3.3）: ページ表示のみ記録。server action経由（next-actionヘッダあり）は
  // 操作ごとの監査が別途あるため二重記録しない。SNC系のテナント横断参照は role で識別可能。
  try {
    const h = await headers();
    if (!h.get("next-action")) {
      await audit(
        user.loginId,
        `view_${page}`,
        `role=${user.role}${user.agencyId ? ` agency=${user.agencyId}` : ""}${isDummyView(user.role, page) ? " dummy" : ""}`
      );
    }
  } catch {
    // headers()が使えないコンテキストでは閲覧記録をスキップ（業務は止めない）
  }
  return { ...user, dummy: isDummyView(user.role, page) };
}

// データスコープ（§3.1 アプリ層）: 参照可能な代理店IDのリストを返す。
// SNC系にも「非ダミー全代理店」の配列を返す（R4用ダミーデータの混入防止）
export async function agencyScope(user: CurrentUser): Promise<string[] | null> {
  if (user.isDummy) {
    const dummies = await prisma.agency.findMany({ where: { isDummy: true }, select: { id: true } });
    return dummies.map((d) => d.id);
  }
  if (["R1", "R2", "R3", "R5", "R6"].includes(user.role)) {
    const all = await prisma.agency.findMany({ where: { isDummy: false }, select: { id: true } });
    return all.map((a) => a.id);
  }
  if (!user.agencyId) return [];
  if (user.role === "R7" || user.role === "R10") {
    const children = await prisma.agency.findMany({
      where: { parentId: user.agencyId },
      select: { id: true },
    });
    return [user.agencyId, ...children.map((c) => c.id)];
  }
  return [user.agencyId];
}
