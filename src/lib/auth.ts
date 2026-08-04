import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "./prisma";
import { Role, PageKey, canAccess, isDummyView } from "./roles";

const COOKIE = "airis_session";
const IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES ?? 60);
const ABS_HOURS = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 24);

export type CurrentUser = {
  id: string;
  loginId: string;
  name: string;
  role: Role; // 実効ロール（稼働終了代理店の⑦⑧はR10に解決）
  rawRole: Role;
  agencyId: string | null;
  agencyName: string | null;
  agencyTier: number | null;
  agencyStatus: string | null;
  mustChangePassword: boolean;
  isDummy: boolean; // R4 か
};

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
  store.set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: ABS_HOURS * 3600,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { token } });
    store.delete(COOKIE);
  }
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { account: { include: { agency: true } } },
  });
  if (!session) return null;
  const now = new Date();
  if (session.expiresAt < now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_MIN * 60 * 1000) return null;
  // アイドル更新（1分以上経過時のみ書き込み）
  if (now.getTime() - session.lastSeenAt.getTime() > 60 * 1000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }
  const a = session.account;
  if (a.status !== "active" && a.status !== "pending") return null;
  let role = a.role as Role;
  // 稼働終了代理店 → R10 に実効ロール解決（§14-2）
  if ((role === "R7" || role === "R8") && a.agency?.status === "closed") role = "R10";
  return {
    id: a.id,
    loginId: a.loginId,
    name: a.name,
    role,
    rawRole: a.role as Role,
    agencyId: a.agencyId,
    agencyName: a.agency?.name ?? null,
    agencyTier: a.agency?.tier ?? null,
    agencyStatus: a.agency?.status ?? null,
    mustChangePassword: a.mustChangePassword,
    isDummy: role === "R4",
  };
});

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/password");
  return user;
}

export async function requirePage(page: PageKey): Promise<CurrentUser & { dummy: boolean }> {
  const user = await requireUser();
  if (!canAccess(user.role, page)) redirect("/dashboard");
  return { ...user, dummy: isDummyView(user.role, page) };
}

// データスコープ（§3.1）: 参照可能な代理店IDのリストを返す。null = 全代理店（SNC系）
export async function agencyScope(user: CurrentUser): Promise<string[] | null> {
  if (user.isDummy) {
    const dummies = await prisma.agency.findMany({ where: { isDummy: true }, select: { id: true } });
    return dummies.map((d) => d.id);
  }
  if (["R1", "R2", "R3", "R5", "R6"].includes(user.role)) return null;
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
