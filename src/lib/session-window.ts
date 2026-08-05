// ===== セッションの失効ウィンドウ（§10.2 / SEC②#13）=====
// 「絶対期限 ≤24時間、アイドル ≤60分」はリリース条件のため、環境変数で**短縮のみ**できる
// （上限を超える値を設定しても仕様の上限へ丸める＝fail-safe）。
//
// server-only を含めない純粋モジュール（単体テストから直接検証できる）。
// 環境変数: SESSION_ABSOLUTE_HOURS / SESSION_IDLE_MINUTES
export type SessionEnv = Record<string, string | undefined>;

// §10.2 の上限。既定値も同値（仕様どおり最大まで使う）。
export const SESSION_ABSOLUTE_HOURS_MAX = 24;
export const SESSION_IDLE_MINUTES_MAX = 60;

// 正の数のみ受け付け、上限でクランプする。不正値は上限（=既定）へフォールバック。
function boundedNumber(raw: string | undefined, max: number): number {
  if (raw === undefined) return max;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(n, max);
}

export function sessionAbsoluteHours(env: SessionEnv = process.env): number {
  return boundedNumber(env.SESSION_ABSOLUTE_HOURS, SESSION_ABSOLUTE_HOURS_MAX);
}

export function sessionIdleMinutes(env: SessionEnv = process.env): number {
  return boundedNumber(env.SESSION_IDLE_MINUTES, SESSION_IDLE_MINUTES_MAX);
}

// 失効理由の判定（§10.2）。
// - "absolute": 絶対期限切れ（expiresAt 到達、または createdAt から絶対期限を超過）。
//   expiresAt はセッション作成時に固定されるが、設定変更後に発行済みセッションが
//   新しい上限を超えて生き残らないよう createdAt からも判定する（多層防御）。
// - "idle": 最終アクセス（lastSeenAt）から放置時間の上限を超過。
// - null: 有効。
export function sessionExpiryReason(
  session: { createdAt: Date; lastSeenAt: Date; expiresAt: Date },
  now: Date,
  env: SessionEnv = process.env
): "absolute" | "idle" | null {
  const t = now.getTime();
  if (session.expiresAt.getTime() <= t) return "absolute";
  if (t - session.createdAt.getTime() > sessionAbsoluteHours(env) * 3600 * 1000) return "absolute";
  if (t - session.lastSeenAt.getTime() > sessionIdleMinutes(env) * 60 * 1000) return "idle";
  return null;
}
