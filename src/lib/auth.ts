import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { prisma } from "./prisma";
import { PageKey, Role, canAccess, isDummyView } from "./roles";
import { resolveSession, SESSION_COOKIE, type CurrentUser } from "./session";
import { UNKNOWN_IP, trustedIpFrom } from "./client-ip";
import { passwordInputCandidates } from "./password-input";
import {
  hashPasswordWithVersion,
  verifyPasswordWithPepper,
  type HashedPassword,
  type PasswordVerification,
} from "./pepper";
import { sessionAbsoluteHours, sessionExpiryReason } from "./session-window";
import { audit } from "./util";

export type { CurrentUser } from "./session";
export { UNKNOWN_IP, trustedIpFrom } from "./client-ip";

// ===== パスワードハッシュ（§2 / §10.3 / SEC②#42） =====
// アルゴリズム（Argon2id + パラメータ）とペッパーのバージョン管理は src/lib/pepper.ts に
// 集約している（純粋モジュール。単体テスト tests/unit/pepper-rotation.test.ts で検証）。
// 実装は @node-rs/argon2（Rust実装のNAPIバインディング）。Next.js の serverExternalPackages
// 既定リストに含まれており、Vercel の Node.js ランタイムでもプリビルドバイナリ
// （linux-x64-gnu 等が package-lock.json に記録済み）がそのまま利用される。
// 同期APIを使うのは hashPassword/verifyPassword の呼び出し側（server action・route）が
// 同期前提で実装されているため。1回あたり十数ms程度。
export type { PasswordVerification, HashedPassword } from "./pepper";
export { activePepperVersion, currentPepperVersion } from "./pepper";

// 現行バージョンのペッパーでハッシュする（バージョンIDは活性バージョン = activePepperVersion()）。
// Account.pepperVersion も併せて更新したい呼び出し側は hashPasswordWithPepperVersion() を使う。
export function hashPassword(pw: string): string {
  return hashPasswordWithVersion(pw).hash;
}

// ハッシュと、それに適用したペッパーのバージョンIDを返す（SEC-021）。
// 呼び出し側は { passwordHash: hash, pepperVersion } をそのまま Account へ保存する。
export function hashPasswordWithPepperVersion(pw: string): HashedPassword {
  return hashPasswordWithVersion(pw);
}

// アカウントの pepperVersion を起点に照合する（照合順序と needsRehash の意味は pepper.ts 参照）。
// pepperVersion 省略時は「記録なし」として既知の全バージョン→ペッパー無しの順で試す
// （PasswordHistory のように バージョン列を持たないハッシュ用）。
export function verifyPassword(
  pw: string,
  hash: string,
  pepperVersion?: string | null
): PasswordVerification {
  return verifyPasswordWithPepper(pw, hash, pepperVersion ?? null);
}

// verifyPassword を入力ゆらぎ候補（password-input.ts）で順に照合する。一致した候補（matched）は
// needsRehash 時の再ハッシュ入力として呼び出し側が使用する。
export function verifyPasswordLenient(
  raw: string,
  hash: string,
  pepperVersion?: string | null
): PasswordVerification & { matched: string } {
  for (const candidate of passwordInputCandidates(raw)) {
    const r = verifyPassword(candidate, hash, pepperVersion);
    if (r.ok) return { ...r, matched: candidate };
  }
  return { ok: false, needsRehash: false, pepperVersion: null, matched: raw };
}

// 接続元IPの解決は src/lib/client-ip.ts（純粋関数・単体テスト対象）へ委譲する（§10.1）

// 実効ロールの解決（§14-2）: 稼働終了代理店（agency.status=closed）に属する⑦⑧は⑩として扱う。
// セッション経由（session.ts）と同じ規則を、セッション未確立のログイン処理でも使うためのヘルパ。
export function effectiveRole(rawRole: string, agencyStatus?: string | null): Role {
  if ((rawRole === "R7" || rawRole === "R8") && agencyStatus === "closed") return "R10";
  return rawRole as Role;
}

export async function createSession(accountId: string, opts?: { mfaPending?: boolean }) {
  const token = crypto.randomBytes(32).toString("hex");
  // 絶対期限（§10.2 ≤24時間）。環境変数で短縮できるが上限は超えられない（session-window.ts）。
  const absHours = sessionAbsoluteHours();
  const expiresAt = new Date(Date.now() + absHours * 3600 * 1000);
  await prisma.session.create({
    data: { token, accountId, expiresAt, mfaPending: opts?.mfaPending ?? false },
  });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(absHours * 3600),
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

// ===== MFA未完了セッション（§4.2）=====
// resolveSession は mfaPending セッションを「未ログイン」として扱う（fail-closed）。
// /mfa の登録・検証ページだけがこの関数で当該セッションを明示的に参照する。
export type MfaPendingSession = {
  sessionId: string;
  mfaAttempts: number;
  account: {
    id: string;
    loginId: string;
    role: Role;
    mfaSecret: string | null;
    mfaEnabled: boolean;
    mustChangePassword: boolean;
  };
};

export async function getMfaPendingSession(): Promise<MfaPendingSession | null> {
  let token: string | undefined;
  try {
    const store = await cookies();
    token = store.get(SESSION_COOKIE)?.value;
  } catch {
    return null;
  }
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { token },
    include: { account: true },
  });
  if (!session || !session.mfaPending) return null;
  const now = new Date();
  // 絶対期限24時間 / アイドル60分（§10.2 / SEC②#13）。判定は session-window.ts に集約。
  if (sessionExpiryReason(session, now)) return null;
  const a = session.account;
  if (a.status !== "active" && a.status !== "pending") return null;
  return {
    sessionId: session.id,
    mfaAttempts: session.mfaAttempts,
    account: {
      id: a.id,
      loginId: a.loginId,
      role: a.role as Role,
      mfaSecret: a.mfaSecret,
      mfaEnabled: a.mfaEnabled,
      mustChangePassword: a.mustChangePassword,
    },
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/password");
  return user;
}

// 管理系エンドポイントのIP許可リスト判定（§10.1 / SEC②#10）。
// ADMIN_IP_ALLOWLIST 未設定時は無効。設定時は「信頼できる接続元IPが許可リストに含まれる」
// 場合のみ true。信頼できるIPが決定できない（trustedIpFrom が unknown）場合は **拒否**（fail-closed）。
// ページだけでなく管理系のRoute Handler（/admin/csv 等）からも必ず呼ぶこと。
export async function isAdminIpAllowed(): Promise<{ allowed: boolean; ip: string }> {
  const list = process.env.ADMIN_IP_ALLOWLIST;
  if (!list) return { allowed: true, ip: "-" };
  let ip = UNKNOWN_IP;
  try {
    ip = trustedIpFrom(await headers());
  } catch {
    return { allowed: false, ip: UNKNOWN_IP };
  }
  if (ip === UNKNOWN_IP) return { allowed: false, ip };
  const allowed = list
    .split(",")
    .map((s) => s.trim())
    .includes(ip);
  return { allowed, ip };
}

export async function requirePage(page: PageKey): Promise<CurrentUser & { dummy: boolean }> {
  const user = await requireUser();
  if (page === "admin") {
    const { allowed, ip } = await isAdminIpAllowed();
    if (!allowed) {
      await audit(user.loginId, "access_denied", `page=admin ip=${ip} (allowlist)`, "denied");
      redirect("/dashboard?denied=admin");
    }
  }
  if (!canAccess(user.role, page)) {
    // 権限外アクセスの試みも記録（§3.3 / SEC②#35）。
    // 無言のリダイレクトでは404と区別できないため（検収指摘 問題一覧No.34）、
    // ダッシュボード側で「権限がありません」バナーを表示するクエリを付ける
    await audit(user.loginId, `access_denied`, `page=${page} role=${user.role}`, "denied");
    redirect(`/dashboard?denied=${page}`);
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
    const dummies = await prisma.agency.findMany({
      where: { isDummy: true },
      select: { id: true },
    });
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
