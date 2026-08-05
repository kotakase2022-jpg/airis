import "server-only";
import { sendMail } from "./mail";

// ===== §10.4 監査・監視: アラート設計（SEC-032） =====
// 仕様（§10.4）: 「認証失敗急増・特権操作・エクスポート操作のアラート設計
//   （実装はログ出力+通知フックまで。SIEM連携はインフラ側）」
//
// 本モジュールの責務は3点だけ:
//   (1) 構造化ログ（JSON）を標準出力に出す  … 収集基盤（SIEM）へはインフラ側で転送する（§10.6）
//   (2) ALERT_WEBHOOK_URL が設定されていれば JSON を POST する（汎用Webhook。特定SaaS依存なし）
//   (3) ALERT_MAIL_TO が設定されていれば メールで通知する
// (2)(3) はいずれも**未設定なら黙ってスキップ**する（開発・テスト環境で失敗させない）。
// アラート送出は業務を止めてはいけないので、この関数群は例外を外へ投げない。
//
// 判定対象の action 名はこのファイルに定数として列挙する。こうすることで
// audit() 側（src/lib/util.ts）が監査イベントから自動判定でき、
// 呼び出し側（server action / route handler、数十箇所）の改修が不要になる。

/** アラート種別（§10.4 の3分類）。ラベルは仕様の表記をそのまま使う。 */
export type AlertKind = "auth_failure_spike" | "privileged_operation" | "export_operation";

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  auth_failure_spike: "認証失敗急増",
  privileged_operation: "特権操作",
  export_operation: "エクスポート操作",
};

export type AlertSeverity = "critical" | "warning";

// 重大度: 認証失敗急増・特権操作は即時確認が必要（critical）。
// エクスポートは正常業務でも発生するため記録・事後確認向け（warning）。
const ALERT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  auth_failure_spike: "critical",
  privileged_operation: "critical",
  export_operation: "warning",
};

// ---- 特権操作の action 名（§10.4「特権操作」） ----
// アカウントの停止/削除/復旧、ロール変更、MFAリセット、パスワードリセット。
// `account_*` の一部は管理画面の拒否記録（`account_${op}` 形式 / src/app/(app)/admin/actions.ts）
// でも使われるため、拒否（result=denied）も同じ action 名で拾えるように列挙してある。
// 販売員ID（⑨）はアカウントの一種（§4）なので、その停止・削除・復旧も特権操作として扱う。
// 代理店の削除は配下アカウントのスコープに影響する重大操作なので同列に扱う（§10.4「等」）。
export const PRIVILEGED_ACTIONS: readonly string[] = [
  // Airisアカウント（§6.1 / 管理画面）
  "admin_account_action",
  "account_suspend",
  "account_resume",
  "account_delete",
  "account_restore",
  "account_role_change",
  "account_reset_password",
  "account_mfa_reset",
  // 管理者代行フロー（§4.2）
  "password_reset",
  "mfa_reset",
  // 販売員ID（§7.2。アカウント相当）
  "sales_staff_suspend",
  "sales_staff_resume",
  "sales_staff_delete",
  "sales_staff_restore",
  // 代理店（§7.5。配下アカウントのデータスコープに影響する）
  "agency_delete",
];

// ---- エクスポート操作の判定（§10.4「エクスポート操作」/ §3.6「出力は監査ログに記録」） ----
// action 名は英語（`csv_export*`）と日本語（`〜CSV出力`）が混在しているため、
// 双方を拾えるキーワード一致で判定する。取込（`csv_import` / `CSV一括申請`）は対象外。
export const EXPORT_ACTION_KEYWORDS: readonly string[] = [
  "csv_export",
  "CSV出力",
  "CSVエクスポート",
];

// ---- 認証失敗の判定（§10.4「認証失敗急増」） ----
// ログイン・MFAコード検証の失敗/拒否は action="login"（result=failure|denied）で記録される
// （src/app/(auth)/actions.ts）。
export const AUTH_FAILURE_ACTIONS: readonly string[] = ["login"];
const FAILURE_RESULTS: readonly string[] = ["failure", "denied"];

// 日次バッチ（§3.3 不正利用検知 / src/app/api/cron/daily/route.ts）が検知した
// 「ログイン失敗の多発」も同じアラート経路に寄せる（二重の検知ロジックを持たない）。
// バッチは `abuse_failed_logins` を result="detected" で監査記録する。
export const BATCH_AUTH_FAILURE_ACTIONS: readonly string[] = ["abuse_failed_logins"];

/**
 * 認証失敗急増のしきい値（§4.2 アカウントロック「30分間に10回失敗」と同じ窓・回数を既定にする。
 * ロックが掛かる時点でアラートも上がるので運用上の解釈がぶれない）。
 * 環境変数で調整可: AUTH_FAILURE_ALERT_THRESHOLD / AUTH_FAILURE_ALERT_WINDOW_MIN /
 * AUTH_FAILURE_ALERT_GLOBAL_THRESHOLD（アカウントを跨いだ総当たり検知）。
 */
export const DEFAULT_AUTH_FAILURE_THRESHOLD = 10;
export const DEFAULT_AUTH_FAILURE_WINDOW_MIN = 30;
export const DEFAULT_AUTH_FAILURE_GLOBAL_THRESHOLD = 30;

const GLOBAL_KEY = "__all__";

// 認証失敗の発生時刻（ミリ秒）をアクター別に保持するスライディングウィンドウ。
// プロセス内メモリのみ（永続化はしない）: §10.4 の実装範囲は「ログ出力+通知フック」までで、
// 恒久的な集計は日次バッチ（§3.3）と収集基盤側が担う。
const authFailures = new Map<string, number[]>();

function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** テスト・プロセス再利用時に検知状態を初期化する。 */
export function resetAlertState(): void {
  authFailures.clear();
}

function bumpWindow(key: string, at: number, windowMs: number, threshold: number): number {
  const recent = (authFailures.get(key) ?? []).filter((t) => at - t < windowMs);
  recent.push(at);
  if (recent.length >= threshold) {
    // 発火したら窓をクリアする（同一の急増で連続通知しないための最小限のデデュープ）
    authFailures.delete(key);
    return recent.length;
  }
  authFailures.set(key, recent);
  return 0;
}

/**
 * 認証失敗を1件記録し、急増と判定した場合はその件数（>0）を返す。
 * 同一アカウントへの集中（既定10回/30分）と、アカウントを跨いだ総量（既定30回/30分）の両方を見る。
 */
export function recordAuthFailure(actor: string, at: number = Date.now()): number {
  const windowMs =
    numEnv("AUTH_FAILURE_ALERT_WINDOW_MIN", DEFAULT_AUTH_FAILURE_WINDOW_MIN) * 60_000;
  const perActor = bumpWindow(
    actor || GLOBAL_KEY,
    at,
    windowMs,
    numEnv("AUTH_FAILURE_ALERT_THRESHOLD", DEFAULT_AUTH_FAILURE_THRESHOLD)
  );
  const global = bumpWindow(
    GLOBAL_KEY,
    at,
    windowMs,
    numEnv("AUTH_FAILURE_ALERT_GLOBAL_THRESHOLD", DEFAULT_AUTH_FAILURE_GLOBAL_THRESHOLD)
  );
  return Math.max(perActor, global);
}

/** 特権操作の action か（§10.4）。 */
export function isPrivilegedAction(action: string): boolean {
  return PRIVILEGED_ACTIONS.includes(action);
}

/** エクスポート操作の action か（§10.4 / §3.6）。 */
export function isExportAction(action: string): boolean {
  return EXPORT_ACTION_KEYWORDS.some((k) => action.includes(k));
}

/** 認証失敗イベントか（急増判定の入力になる。単発ではアラートにしない）。 */
export function isAuthFailureEvent(action: string, result: string): boolean {
  return AUTH_FAILURE_ACTIONS.includes(action) && FAILURE_RESULTS.includes(result);
}

/**
 * 監査イベントがアラート対象かを判定する（単発で即アラートになる種別のみ）。
 * 認証失敗は「急増」で初めてアラートになるため、ここでは null を返す（recordAuthFailure 参照）。
 */
export function classifyAlert(action: string, result = "success"): AlertKind | null {
  if (isPrivilegedAction(action)) return "privileged_operation";
  if (isExportAction(action)) return "export_operation";
  if (BATCH_AUTH_FAILURE_ACTIONS.includes(action)) return "auth_failure_spike";
  // result は将来の拡張（失敗のみ対象の種別）のために受けている。現状の3分類では未使用。
  void result;
  return null;
}

export type AlertEvent = {
  kind: AlertKind;
  actor: string;
  action: string;
  target?: string;
  result?: string;
  ip?: string;
  /** 補足（例: 認証失敗の件数と評価窓） */
  detail?: string;
};

/** 構造化ログ・Webhook・メールで送出するアラートのペイロード（収集基盤に流せる形式）。 */
export type AlertLogRecord = {
  type: "alert";
  ts: string;
  severity: AlertSeverity;
  kind: AlertKind;
  label: string;
  actor: string;
  action: string;
  target?: string;
  result?: string;
  ip?: string;
  detail?: string;
  env?: string;
  app: "airis";
};

// ログ・Webhookへ載せる target の最大長（監査ログDBには全文が残る。標準出力の肥大化だけ防ぐ）
const MAX_TARGET_LEN = 1000;

function clip(s?: string): string | undefined {
  if (s === undefined || s === null) return undefined;
  return s.length > MAX_TARGET_LEN ? `${s.slice(0, MAX_TARGET_LEN)}…` : s;
}

export function alertRecord(e: AlertEvent, ts: string = new Date().toISOString()): AlertLogRecord {
  return {
    type: "alert",
    ts,
    severity: ALERT_SEVERITY[e.kind],
    kind: e.kind,
    label: ALERT_KIND_LABELS[e.kind],
    actor: e.actor,
    action: e.action,
    target: clip(e.target),
    result: e.result,
    ip: e.ip,
    detail: e.detail,
    env: process.env.NODE_ENV,
    app: "airis",
  };
}

function alertText(r: AlertLogRecord): string {
  const lines = [
    `種別: ${r.label}（${r.severity}）`,
    `発生時刻: ${r.ts}`,
    `実行者: ${r.actor}`,
    `操作: ${r.action}`,
    r.target ? `対象: ${r.target}` : "",
    r.result ? `結果: ${r.result}` : "",
    r.ip ? `IP: ${r.ip}` : "",
    r.detail ? `補足: ${r.detail}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function postWebhook(record: AlertLogRecord): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return; // 未設定はスキップ（エラーにしない）
  try {
    // 汎用Webhook（特定SaaS固有の payload 形式には依存しない）。
    // 受け側で本文をそのまま表示できるよう text を添えるだけに留める。
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...record, text: alertText(record) }),
      signal: AbortSignal.timeout(numEnv("ALERT_WEBHOOK_TIMEOUT_MS", 3000)),
    });
  } catch (err) {
    console.error("[alert] webhook failed:", (err as Error).message);
  }
}

async function mailAlert(record: AlertLogRecord): Promise<void> {
  const to = process.env.ALERT_MAIL_TO;
  if (!to) return; // 未設定はスキップ（エラーにしない）
  const recipients = to
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await Promise.allSettled(
    recipients.map((addr) =>
      sendMail(addr, `【Airis】セキュリティアラート: ${record.label}`, alertText(record))
    )
  );
}

/**
 * アラートを送出する（§10.4 SEC-032）。
 * (1) 構造化ログ（JSON）を標準出力へ / (2) 汎用Webhook / (3) メール。
 * 通知フックは未設定ならスキップし、失敗しても例外を投げない（業務を止めない）。
 */
export async function alert(event: AlertEvent): Promise<void> {
  const record = alertRecord(event);
  try {
    console.log(JSON.stringify(record));
  } catch {
    // ログ整形の失敗で業務を止めない
  }
  await Promise.allSettled([postWebhook(record), mailAlert(record)]);
}

/**
 * 監査イベント（audit()）から自動でアラート判定・送出を行う。
 * これにより呼び出し側（server action / route handler）の改修が不要になる（後方互換）。
 */
export async function alertForAuditEvent(e: {
  actor: string;
  action: string;
  target?: string;
  result?: string;
  ip?: string;
}): Promise<void> {
  try {
    const result = e.result ?? "success";
    const kind = classifyAlert(e.action, result);
    if (kind) {
      await alert({ ...e, result, kind });
      return;
    }
    if (isAuthFailureEvent(e.action, result)) {
      const count = recordAuthFailure(e.actor);
      if (count > 0) {
        const windowMin = numEnv("AUTH_FAILURE_ALERT_WINDOW_MIN", DEFAULT_AUTH_FAILURE_WINDOW_MIN);
        await alert({
          ...e,
          result,
          kind: "auth_failure_spike",
          detail: `認証失敗${count}回（直近${windowMin}分）`,
        });
      }
    }
  } catch (err) {
    // アラート送出の失敗は監査記録・業務処理に影響させない
    console.error("[alert] dispatch failed:", (err as Error).message);
  }
}
