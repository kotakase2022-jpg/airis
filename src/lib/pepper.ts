// ===== パスワードハッシュとペッパーのバージョン管理（§2 / §10.3 / SEC②#42）=====
// 「シークレットは年1回以上の交換を前提に設計する（ペッパーはバージョンID付きで保持し、
// ログイン成功時に新バージョンで再ハッシュする）」を満たすための純粋モジュール。
//
// server-only を含めない（=単体テストから直接検証できる）。副作用は持たず、環境変数は
// すべて引数 env（既定 process.env）から読むため、V1→V2 切替の挙動をテストで再現できる。
// 実際の入出力（Account.pepperVersion の更新）は呼び出し側（src/lib/auth.ts / server action）が行う。
//
// 環境変数:
//   PASSWORD_PEPPER_V1, PASSWORD_PEPPER_V2, ... ペッパー本体（複数バージョンを同時に保持）
//   CURRENT_PEPPER_KEY                        現行バージョンID（例 "v2"。互換のため
//                                             "PASSWORD_PEPPER_V2" 形式も受け付ける）
// 運用手順は docs/OPERATIONS.md §2.1。
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";

export type PepperEnv = Record<string, string | undefined>;

export const PEPPER_ENV_PREFIX = "PASSWORD_PEPPER_";
// CURRENT_PEPPER_KEY 未設定時のバージョンID（従来の実装が PASSWORD_PEPPER_V1 固定だったため）
export const DEFAULT_PEPPER_VERSION = "v1";

// アルゴリズムは Argon2id（§2 / §10.3）。OWASP Password Storage Cheat Sheet の推奨値
// （Argon2id: m=19MiB / t=2 / p=1）。ソルトは Argon2 が自動生成しハッシュ文字列へ埋め込む。
// algorithm は @node-rs/argon2 の既定値が Argon2id（生成されるハッシュの $argon2id$ で確認可能）。
// isolatedModules 有効のため ambient const enum（Algorithm）は import できないので既定値に従う。
export const ARGON2_OPTIONS = {
  memoryCost: 19456, // KiB = 19MiB（>=19MiB）
  timeCost: 2, // 反復回数（>=2）
  parallelism: 1, // 並列度
  outputLen: 32,
} as const;

// ペッパーの混ぜ方: OWASP Password Storage Cheat Sheet に従い HMAC-SHA256（鍵=ペッパー）で
// 前段ハッシュしてからパスワードハッシュ関数へ渡す（SHA-256はCRYPTREC準拠。§10.3 で
// 禁止された SHA-1/MD5 は使用しない）。bcrypt時代の72バイト切り詰め回避も兼ねる。
// 未設定時は従来動作（ペッパー無し）なので既存環境と互換。
export function prehash(pw: string, pepper: string): string {
  if (!pepper) return pw;
  return crypto.createHmac("sha256", pepper).update(pw, "utf8").digest("hex");
}

// バージョンIDの正規化: "V2" / "v2" / "PASSWORD_PEPPER_V2" → "v2"
export function normalizePepperVersion(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.toUpperCase().startsWith(PEPPER_ENV_PREFIX)
    ? trimmed.slice(PEPPER_ENV_PREFIX.length)
    : trimmed;
  return bare.toLowerCase();
}

// バージョンID → 環境変数名（"v2" → "PASSWORD_PEPPER_V2"）
export function pepperEnvName(version: string): string {
  return PEPPER_ENV_PREFIX + normalizePepperVersion(version).toUpperCase();
}

// 現行バージョンID（CURRENT_PEPPER_KEY。未設定なら "v1"）
export function currentPepperVersion(env: PepperEnv = process.env): string {
  const raw = env.CURRENT_PEPPER_KEY;
  const normalized = raw ? normalizePepperVersion(raw) : "";
  return normalized || DEFAULT_PEPPER_VERSION;
}

// 指定バージョンのペッパー値（未設定・null は空文字＝ペッパー無し）
export function pepperValue(
  version: string | null | undefined,
  env: PepperEnv = process.env
): string {
  if (!version) return "";
  return env[pepperEnvName(version)] ?? "";
}

// 現行バージョンのペッパー値（未設定なら空文字＝ペッパー無しで動作）
export function currentPepper(env: PepperEnv = process.env): string {
  return pepperValue(currentPepperVersion(env), env);
}

// 新規ハッシュに記録すべきバージョンID。ペッパー未設定なら null（= Account.pepperVersion も null）。
export function activePepperVersion(env: PepperEnv = process.env): string | null {
  return currentPepper(env) ? currentPepperVersion(env) : null;
}

// バージョンIDの新しい順（v10 > v2 > v1）。数値部で比較し、同値・非数値は文字列の降順。
function compareVersionDesc(a: string, b: string): number {
  const na = Number(a.replace(/\D/g, ""));
  const nb = Number(b.replace(/\D/g, ""));
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return nb - na;
  return a < b ? 1 : a > b ? -1 : 0;
}

// 環境変数に値が入っている全バージョンID。現行バージョンを先頭に、以降は新しい順。
export function knownPepperVersions(env: PepperEnv = process.env): string[] {
  const found = Object.keys(env)
    .filter((k) => k.toUpperCase().startsWith(PEPPER_ENV_PREFIX) && (env[k] ?? "") !== "")
    .map((k) => normalizePepperVersion(k));
  const sorted = Array.from(new Set(found)).sort(compareVersionDesc);
  const current = currentPepperVersion(env);
  const hasCurrent = sorted.includes(current);
  return hasCurrent ? [current, ...sorted.filter((v) => v !== current)] : sorted;
}

export type PepperCandidate = { version: string | null; pepper: string };

// 照合順序（SEC-021）: ①そのアカウントの pepperVersion に対応するペッパー
// → ②他の既知バージョン（現行を優先） → ③ペッパーなし（導入前のハッシュ）。
// pepperVersion が記録されているアカウントは1回目で当たるため、通常は追加コストが発生しない。
export function pepperCandidates(
  accountPepperVersion: string | null | undefined,
  env: PepperEnv = process.env
): PepperCandidate[] {
  const versions: (string | null)[] = [];
  const account = accountPepperVersion ? normalizePepperVersion(accountPepperVersion) : null;
  // ①（環境変数から値が引けない＝そのバージョンが撤去済みの場合は飛ばす）
  if (account && pepperValue(account, env)) versions.push(account);
  // ②
  for (const v of knownPepperVersions(env)) if (!versions.includes(v)) versions.push(v);
  // ③ ペッパー無し（バージョンID null）
  versions.push(null);
  return versions.map((version) => ({ version, pepper: pepperValue(version, env) }));
}

// ok: パスワード一致
// needsRehash: 現行方式（Argon2id + 現行バージョンのペッパー）以外で一致したため、
//              現行方式での再ハッシュ保存が必要（旧アルゴリズムbcrypt / 旧ペッパー / ペッパー未適用）
// pepperVersion: 一致したペッパーのバージョンID（null = ペッパー無し）。
//                呼び出し側が Account.pepperVersion の実態補正に使う。
export type PasswordVerification = {
  ok: boolean;
  needsRehash: boolean;
  pepperVersion: string | null;
};

export function isArgon2Hash(hash: string): boolean {
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

export type HashedPassword = { hash: string; pepperVersion: string | null };

// 現行バージョンのペッパーでハッシュし、記録すべきバージョンIDを併せて返す（SEC-021）。
// 呼び出し側は返り値の pepperVersion を Account.pepperVersion に保存する。
export function hashPasswordWithVersion(pw: string, env: PepperEnv = process.env): HashedPassword {
  return {
    hash: argon2HashSync(prehash(pw, currentPepper(env)), ARGON2_OPTIONS),
    pepperVersion: activePepperVersion(env),
  };
}

// アカウントの pepperVersion を起点に、既知バージョン→ペッパー無しの順で照合する（SEC-021）。
// V1→V2 の切替直後でも既存ハッシュ（V1適用済み / ペッパー未適用）で必ずログインでき、
// needsRehash=true が返るので呼び出し側がその場で現行バージョンへ移行できる。
export function verifyPasswordWithPepper(
  pw: string,
  hash: string,
  accountPepperVersion: string | null | undefined,
  env: PepperEnv = process.env
): PasswordVerification {
  const argon2 = isArgon2Hash(hash);
  const currentVersion = activePepperVersion(env); // ペッパー無し運用なら null
  for (const cand of pepperCandidates(accountPepperVersion, env)) {
    const matched = argon2
      ? argon2Matches(hash, prehash(pw, cand.pepper))
      : bcryptMatches(hash, prehash(pw, cand.pepper));
    if (!matched) continue;
    // 現行方式（Argon2id かつ現行バージョンのペッパー）以外で一致した場合は再ハッシュ対象
    const isCurrent = argon2 && cand.version === currentVersion;
    return { ok: true, needsRehash: !isCurrent, pepperVersion: cand.version };
  }
  return { ok: false, needsRehash: false, pepperVersion: null };
}
