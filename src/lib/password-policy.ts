// ===== パスワードポリシー（§4.2 / §10.1「ポリシー値は設定で変更可能に」）=====
// 桁数・有効期間・履歴世代数を環境変数で変更できるようにした純粋モジュール。
// 既定値は §4.2 の表のとおり（管理者①②③⑦=20桁/90日、一般④⑤⑥⑧⑨⑩=14桁/180日、履歴24世代）。
//
// server-only を含めない（=単体テストから直接検証できる）。環境変数はすべて引数 env
// （既定 process.env）から読み、副作用・現在時刻の取得を行わない（now は引数で受け取る）。
//
// 環境変数:
//   PASSWORD_MIN_ADMIN            管理者アカウントの最小桁数（既定 20）
//   PASSWORD_MIN_GENERAL          一般アカウントの最小桁数（既定 14）
//   PASSWORD_MAX_AGE_ADMIN_DAYS   管理者アカウントの有効期間（日。既定 90）
//   PASSWORD_MAX_AGE_GENERAL_DAYS 一般アカウントの有効期間（日。既定 180）
//   PASSWORD_HISTORY_GENERATIONS  再利用禁止の世代数（既定 24）
import { ADMIN_PW_ROLES, type Role } from "./roles";

export type PolicyEnv = Record<string, string | undefined>;

export type PasswordPolicy = {
  minLengthAdmin: number;
  minLengthGeneral: number;
  maxAgeAdminDays: number;
  maxAgeGeneralDays: number;
  historyGenerations: number;
};

// §4.2 の表の値（環境変数が未設定・不正な場合はこの値を使う）
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLengthAdmin: 20,
  minLengthGeneral: 14,
  maxAgeAdminDays: 90,
  maxAgeGeneralDays: 180,
  historyGenerations: 24,
};

// 設定値は正の整数のみ受け付ける。空文字・小数・0以下・非数値は既定値へフォールバックする
// （設定ミスでポリシーが無効化されない＝fail-safe）。
function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

export function passwordPolicy(env: PolicyEnv = process.env): PasswordPolicy {
  const d = DEFAULT_PASSWORD_POLICY;
  return {
    minLengthAdmin: positiveInt(env.PASSWORD_MIN_ADMIN, d.minLengthAdmin),
    minLengthGeneral: positiveInt(env.PASSWORD_MIN_GENERAL, d.minLengthGeneral),
    maxAgeAdminDays: positiveInt(env.PASSWORD_MAX_AGE_ADMIN_DAYS, d.maxAgeAdminDays),
    maxAgeGeneralDays: positiveInt(env.PASSWORD_MAX_AGE_GENERAL_DAYS, d.maxAgeGeneralDays),
    historyGenerations: positiveInt(env.PASSWORD_HISTORY_GENERATIONS, d.historyGenerations),
  };
}

// 管理者区分の判定は roles.ts の宣言的マップ（ADMIN_PW_ROLES = ①②③⑦）に委譲する。
// ロール配列をここに直書きしない（AGENTS.md / §3.2）。
// 判定は実効ロールで行うこと（稼働終了代理店の⑦⑧=⑩は一般ポリシー）。
export function isAdminPasswordRole(role: string): boolean {
  return ADMIN_PW_ROLES.includes(role as Role);
}

export function passwordMinLength(role: string, policy: PasswordPolicy = passwordPolicy()): number {
  return isAdminPasswordRole(role) ? policy.minLengthAdmin : policy.minLengthGeneral;
}

export function passwordMaxAgeDays(
  role: string,
  policy: PasswordPolicy = passwordPolicy()
): number {
  return isAdminPasswordRole(role) ? policy.maxAgeAdminDays : policy.maxAgeGeneralDays;
}

// 有効期間の超過判定（§4.2）。now は呼び出し側から渡す（レンダー中の new Date() を避ける）。
export function isPasswordExpired(
  passwordUpdatedAt: Date,
  role: string,
  now: Date,
  policy: PasswordPolicy = passwordPolicy()
): boolean {
  const maxAgeMs = passwordMaxAgeDays(role, policy) * 24 * 3600 * 1000;
  return now.getTime() - passwordUpdatedAt.getTime() > maxAgeMs;
}

// 再利用禁止（§4.2 過去24世代）のエラー文言。世代数は設定値に追従する。
export function passwordReuseError(policy: PasswordPolicy = passwordPolicy()): string {
  return `過去${policy.historyGenerations}世代と同じパスワードは使用できません`;
}

// 新パスワードの形式検証（§4.2）。問題なければ null、あればUIへ出すエラー文言を返す。
export function validateNewPassword(
  next: string,
  role: string,
  policy: PasswordPolicy = passwordPolicy()
): string | null {
  const minLen = passwordMinLength(role, policy);
  if (next.length < minLen) return `パスワードは${minLen}桁以上にしてください`;
  if (!/[A-Z]/.test(next) || !/[a-z]/.test(next) || !/[0-9]/.test(next)) {
    return "大文字・小文字・数字をそれぞれ含めてください";
  }
  return null;
}
