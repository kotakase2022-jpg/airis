import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import crypto from "crypto";
import { prisma } from "./prisma";
import { PageKey, Role, canAccess, isDummyView } from "./roles";
import { effectiveRoleFor, resolveSession, SESSION_COOKIE, type CurrentUser } from "./session";
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

// Account の passwordHash / pepperVersion をまとめて更新するための data 断片を返す（SEC-021）。
// 管理者代行のパスワードリセット・ID発行など「新しいハッシュを保存する」全経路でこれを使う。
export function hashedForAccount(pw: string): {
  passwordHash: string;
  pepperVersion: string | null;
} {
  const { hash, pepperVersion } = hashPasswordWithVersion(pw);
  return { passwordHash: hash, pepperVersion };
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

// 実効ロールの解決（§14-2）: 稼働終了代理店に属する⑦と、その配下2次店の⑧は⑩として扱う。
// 規則の実装は session.ts の effectiveRoleFor()（純粋関数）に集約し、セッション未確立の
// ログイン処理からも同じ関数を通す（二重実装で片方だけ直す事故を防ぐ §3.2）。
// parentAgencyStatus を渡さない呼び出しは⑦（1次店所属）専用と見なす。
export function effectiveRole(
  rawRole: string,
  agencyStatus?: string | null,
  parentAgencyStatus?: string | null
): Role {
  return effectiveRoleFor(rawRole, agencyStatus ?? null, parentAgencyStatus ?? null);
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
// 許可リストは **設定テーブル（AppSetting）→ 環境変数 ADMIN_IP_ALLOWLIST → 未設定** の順で解決する
// （§10.1「環境変数/設定テーブルで設定可能に」）。管理画面から変更した値が即座に効く必要があるため、
// ここで settings.ts の解決関数を使う（env のみを見ると、画面で設定しても管理画面自体に効かない）。
// 未設定時は無効（全許可）。設定時は「信頼できる接続元IPが許可リストに含まれる」場合のみ true。
// 信頼できるIPが決定できない（trustedIpFrom が unknown）場合は **拒否**（fail-closed）。
// ページ（requirePage）と管理系のRoute Handler（/admin/csv 等）の双方から必ず呼ぶこと。
export async function isAdminIpAllowed(): Promise<{ allowed: boolean; ip: string }> {
  const { isAdminIpAllowedFromSettings } = await import("./settings");
  return isAdminIpAllowedFromSettings();
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
    // ⑩は §4「稼働終了代理店（⑩）: **当該1次代理店の**窓口案件のみ」。
    // ⑧が親1次店の稼働終了で⑩になった場合（§14-2）、基準は自店（2次店）ではなく親1次店。
    // 自店基準のままだと案件の primaryAgencyId（＝1次店）と一致せず1件も見えない。
    let baseId = user.agencyId;
    if (user.role === "R10" && user.agencyTier === 2) {
      const own = await prisma.agency.findUnique({
        where: { id: user.agencyId },
        select: { parentId: true },
      });
      baseId = own?.parentId ?? user.agencyId;
    }
    const children = await prisma.agency.findMany({
      where: { parentId: baseId },
      select: { id: true },
    });
    return [baseId, ...children.map((c) => c.id)];
  }
  return [user.agencyId];
}
