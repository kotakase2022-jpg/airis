import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { basePrisma } from "./prisma-base";
import type { Role } from "./roles";

export const SESSION_COOKIE = "airis_session";
const IDLE_MIN = Number(process.env.SESSION_IDLE_MINUTES ?? 60);

// PostgreSQL RLS 用のコンテキスト（§3.1 多層防御）
export type RlsContext = { bypass: boolean; scope: string[] };

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
  mfaEnabled: boolean; // MFA登録済みか（⑨の任意登録リンク表示などに使用）
  isDummy: boolean; // R4 か
};

export type SessionData = { user: CurrentUser; rls: RlsContext };

// セッション+RLSコンテキストの解決。
// リクエスト内でキャッシュされ、認証層（auth.ts）と Prisma RLS 拡張（prisma.ts）の両方から参照される。
// ※ここでは basePrisma（RLS拡張なし・非保護テーブルのみ）を使うこと。循環しない。
export const resolveSession = cache(async (): Promise<SessionData | null> => {
  let token: string | undefined;
  try {
    const store = await cookies();
    token = store.get(SESSION_COOKIE)?.value;
  } catch {
    // リクエストコンテキスト外（バッチ等）ではセッション無し
    return null;
  }
  if (!token) return null;

  const session = await basePrisma.session.findUnique({
    where: { token },
    include: { account: { include: { agency: true } } },
  });
  if (!session) return null;
  // MFA未完了セッションはアプリ全体で「未ログイン」扱い（fail-closed §4.2）。
  // /mfa の各ページだけが auth.ts の getMfaPendingSession() で明示的に参照する。
  if (session.mfaPending) return null;
  const now = new Date();
  if (session.expiresAt < now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_MIN * 60 * 1000) return null;
  // アイドル更新（1分以上経過時のみ書き込み）
  if (now.getTime() - session.lastSeenAt.getTime() > 60 * 1000) {
    await basePrisma.session.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }
  const a = session.account;
  if (a.status !== "active" && a.status !== "pending") return null;
  let role = a.role as Role;
  // 稼働終了代理店 → R10 に実効ロール解決（§14-2）
  if ((role === "R7" || role === "R8") && a.agency?.status === "closed") role = "R10";

  const user: CurrentUser = {
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
    mfaEnabled: a.mfaEnabled,
    isDummy: role === "R4",
  };

  // RLSコンテキスト計算（Agency は非保護テーブル）
  let rls: RlsContext;
  if (role === "R4") {
    const dummies = await basePrisma.agency.findMany({
      where: { isDummy: true },
      select: { id: true },
    });
    rls = { bypass: false, scope: dummies.map((d) => d.id) };
  } else if (["R1", "R2", "R3", "R5", "R6"].includes(role)) {
    rls = { bypass: true, scope: [] };
  } else if (user.agencyId) {
    const ids = [user.agencyId];
    if (role === "R7" || role === "R10") {
      const children = await basePrisma.agency.findMany({
        where: { parentId: user.agencyId },
        select: { id: true },
      });
      ids.push(...children.map((c) => c.id));
    }
    rls = { bypass: false, scope: ids };
  } else {
    rls = { bypass: false, scope: [] };
  }

  return { user, rls };
});
