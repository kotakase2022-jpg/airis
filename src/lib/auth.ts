import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import crypto from "crypto";
import { prisma } from "./prisma";
import { PageKey, Role, canAccess, isDummyView } from "./roles";
import { resolveSession, SESSION_COOKIE, type CurrentUser } from "./session";
import { audit } from "./util";

export type { CurrentUser } from "./session";

const ABS_HOURS = Number(process.env.SESSION_ABSOLUTE_HOURS ?? 24);

// ===== パスワードハッシュ（§2 / §10.3 / SEC②#42） =====
// アルゴリズムは Argon2id（§2「パスワードハッシュ: Argon2id（ソルト自動 + アプリケーション
// ペッパーを環境変数で付与）」/ §10.3）。ソルトは Argon2 が自動生成し、パラメータとともに
// ハッシュ文字列（$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>）へ埋め込まれる。
// 実装は @node-rs/argon2（Rust実装のNAPIバインディング）。Next.js の serverExternalPackages
// 既定リストに含まれており、Vercel の Node.js ランタイムでもプリビルドバイナリ
// （linux-x64-gnu 等が package-lock.json に記録済み）がそのまま利用される。
// 同期APIを使うのは hashPassword/verifyPassword の呼び出し側（server action・route）が
// 同期前提で実装されているため。1回あたり十数ms程度。
const CURRENT_PEPPER_KEY = "PASSWORD_PEPPER_V1";

// OWASP Password Storage Cheat Sheet の推奨（Argon2id: m=19MiB / t=2 / p=1）。
// algorithm は @node-rs/argon2 の既定値が Argon2id（生成されるハッシュの $argon2id$ で確認可能）。
// isolatedModules 有効のため ambient const enum（Algorithm）は import できないので既定値に従う。
const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB = 19MiB（>=19MiB）
  timeCost: 2, // 反復回数（>=2）
  parallelism: 1, // 並列度
  outputLen: 32,
} as const;

function currentPepper(): string {
  return process.env[CURRENT_PEPPER_KEY] ?? "";
}

// ペッパーの混ぜ方: OWASP Password Storage Cheat Sheet に従い HMAC-SHA256（鍵=ペッパー）で
// 前段ハッシュしてからパスワードハッシュ関数へ渡す（SHA-256はCRYPTREC準拠。§10.3 で
// 禁止された SHA-1/MD5 は使用しない）。bcrypt時代の72バイト切り詰め回避も兼ねる。
// 未設定時は従来動作（ペッパー無し）なので既存環境と互換。
// ローテーション時は PASSWORD_PEPPER_V2 を足して CURRENT_PEPPER_KEY を切り替え、
// ログイン成功時の再ハッシュ（needsRehash）で順次移行する。
function prehash(pw: string, pepper: string): string {
  if (!pepper) return pw;
  return crypto.createHmac("sha256", pepper).update(pw, "utf8").digest("hex");
}

export function hashPassword(pw: string): string {
  return argon2HashSync(prehash(pw, currentPepper()), ARGON2_OPTIONS);
}

// ok: パスワード一致
// needsRehash: 旧アルゴリズム（bcrypt）またはペッパー未適用の旧ハッシュだったため
//              現行方式（Argon2id + 現行ペッパー）での再ハッシュ保存が必要
export type PasswordVerification = { ok: boolean; needsRehash: boolean };

function isArgon2Hash(hash: string): boolean {
  return hash.startsWith("$argon2");
}

// Argon2id照合。壊れた/未知形式のハッシュでは例外が飛ぶため不一致として扱う。
function argon2Matches(hash: string, candidate: string): boolean {
  try {
    return argon2VerifySync(hash, candidate);
  } catch {
    return false;
  }
}

// bcrypt照合（旧アルゴリズム互換）。不正な形式では false（例外を伝播させない）。
function bcryptMatches(hash: string, candidate: string): boolean {
  try {
    return bcrypt.compareSync(candidate, hash);
  } catch {
    return false;
  }
}

export function verifyPassword(pw: string, hash: string): PasswordVerification {
  const pepper = currentPepper();
  if (isArgon2Hash(hash)) {
    if (pepper && argon2Matches(hash, prehash(pw, pepper))) {
      return { ok: true, needsRehash: false };
    }
    // ペッパー導入前（または旧バージョンのペッパー）のArgon2idハッシュ → 現行ペッパーで再ハッシュ
    if (argon2Matches(hash, pw)) return { ok: true, needsRehash: !!pepper };
    return { ok: false, needsRehash: false };
  }
  // 旧アルゴリズム（bcrypt）ハッシュとの互換検証（§10.3 の Argon2id 段階移行）。
  // 成功したら呼び出し側で hashPassword() により Argon2id + 現行ペッパーへ再ハッシュする。
  if (pepper && bcryptMatches(hash, prehash(pw, pepper))) return { ok: true, needsRehash: true };
  if (bcryptMatches(hash, pw)) return { ok: true, needsRehash: true };
  return { ok: false, needsRehash: false };
}

// ===== 接続元IPの解決（§10.1 / X-Forwarded-For 偽装対策） =====
// クライアントは x-forwarded-for を自由に偽装できるため「先頭」を接続元とみなしてはならない
// （レート制限・IP許可リストの回避に使われる）。
//  1. Vercel環境では x-vercel-forwarded-for（プラットフォームが付与し、クライアント指定値は
//     上書きされる）を優先する。
//  2. それ以外は x-forwarded-for の「末尾から TRUSTED_PROXY_HOPS（既定1）番目」を採用する。
//     信頼できるプロキシは自分が見た接続元を末尾に追記するため、末尾側はクライアントから
//     偽装できない。プロキシを多段で挟む構成では TRUSTED_PROXY_HOPS を段数に合わせる。
const TRUSTED_PROXY_HOPS = Math.max(1, Math.trunc(Number(process.env.TRUSTED_PROXY_HOPS)) || 1);

function pickFromEnd(headerValue: string, hops: number): string | null {
  const list = headerValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  const idx = Math.max(0, list.length - hops); // 段数が足りない場合は最左（偽装できる要素が無い）
  return list[idx] ?? null;
}

export function trustedIpFrom(h: Headers): string {
  const vercel = h.get("x-vercel-forwarded-for");
  if (vercel) return pickFromEnd(vercel, 1) ?? "local";
  const fwd = h.get("x-forwarded-for");
  if (fwd) return pickFromEnd(fwd, TRUSTED_PROXY_HOPS) ?? "local";
  return "local";
}

// 実効ロールの解決（§14-2）: 稼働終了代理店（agency.status=closed）に属する⑦⑧は⑩として扱う。
// セッション経由（session.ts）と同じ規則を、セッション未確立のログイン処理でも使うためのヘルパ。
export function effectiveRole(rawRole: string, agencyStatus?: string | null): Role {
  if ((rawRole === "R7" || rawRole === "R8") && agencyStatus === "closed") return "R10";
  return rawRole as Role;
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
  // 設定はカンマ区切りIPリスト。接続元は trustedIpFrom（偽装できない末尾hop）で判定する。
  if (page === "admin" && process.env.ADMIN_IP_ALLOWLIST) {
    try {
      const h = await headers();
      const ip = trustedIpFrom(h);
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
