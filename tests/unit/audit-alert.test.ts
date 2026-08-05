import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  alert,
  alertRecord,
  classifyAlert,
  isAuthFailureEvent,
  isExportAction,
  isPrivilegedAction,
  recordAuthFailure,
  resetAlertState,
  ALERT_KIND_LABELS,
  DEFAULT_AUTH_FAILURE_THRESHOLD,
  DEFAULT_AUTH_FAILURE_WINDOW_MIN,
  PRIVILEGED_ACTIONS,
} from "@/lib/alert";

// §10.4 監査・監視: 「認証失敗急増・特権操作・エクスポート操作のアラート設計
//  （実装はログ出力+通知フックまで）」の判定ロジックを検証する。

const ALERT_ENV = [
  "ALERT_WEBHOOK_URL",
  "ALERT_MAIL_TO",
  "AUTH_FAILURE_ALERT_THRESHOLD",
  "AUTH_FAILURE_ALERT_WINDOW_MIN",
  "AUTH_FAILURE_ALERT_GLOBAL_THRESHOLD",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ALERT_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetAlertState();
});

afterEach(() => {
  for (const k of ALERT_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("§10.4 特権操作のアラート判定", () => {
  // 実装（src/app/(app)/admin/actions.ts 等）が記録している action 名と対応していること
  it.each([
    "account_suspend",
    "account_delete",
    "account_role_change",
    "account_restore",
    "mfa_reset",
    "password_reset",
    "sales_staff_suspend",
    "sales_staff_delete",
    "agency_delete",
  ])("%s は特権操作としてアラート対象", (action) => {
    expect(isPrivilegedAction(action)).toBe(true);
    expect(classifyAlert(action)).toBe("privileged_operation");
  });

  it("拒否記録（result=denied）でも特権操作として判定する", () => {
    expect(classifyAlert("account_delete", "denied")).toBe("privileged_operation");
    // 管理画面の拒否記録は `account_${op}` 形式（op=reset_password / mfa_reset）
    expect(classifyAlert("account_reset_password", "denied")).toBe("privileged_operation");
    expect(classifyAlert("account_mfa_reset", "denied")).toBe("privileged_operation");
  });

  it("列挙した特権操作の action 名は重複していない", () => {
    expect(new Set(PRIVILEGED_ACTIONS).size).toBe(PRIVILEGED_ACTIONS.length);
  });
});

describe("§10.4 エクスポート操作のアラート判定", () => {
  it.each([
    "csv_export",
    "csv_export_gigacc",
    "csv_export_sales_staff_list",
    "csv_export_sales_staff_template",
    "訪販員申請一覧CSV出力",
  ])("%s はエクスポート操作としてアラート対象", (action) => {
    expect(isExportAction(action)).toBe(true);
    expect(classifyAlert(action)).toBe("export_operation");
  });

  it("CSV取込（エクスポートではない）はアラート対象にしない", () => {
    for (const action of [
      "daily_report_csv_import",
      "sales_staff_csv_apply",
      "訪販員申請CSV一括申請",
    ]) {
      expect(isExportAction(action)).toBe(false);
      expect(classifyAlert(action)).toBeNull();
    }
  });
});

describe("§10.4 通常操作はアラート対象にしない", () => {
  it.each([
    "login",
    "logout",
    "password_change",
    "mfa_enroll",
    "account_update",
    "account_request_create",
    "submission_create",
    "daily_report_upsert",
    "case_view",
    "notify_mail",
    "file_download",
  ])("%s は単発ではアラートにならない", (action) => {
    expect(classifyAlert(action)).toBeNull();
    expect(isPrivilegedAction(action)).toBe(false);
    expect(isExportAction(action)).toBe(false);
  });
});

describe("§10.4 認証失敗急増の判定", () => {
  it("ログイン失敗・拒否は認証失敗イベントとして扱う（単発ではアラートにしない）", () => {
    expect(isAuthFailureEvent("login", "failure")).toBe(true);
    expect(isAuthFailureEvent("login", "denied")).toBe(true);
    expect(isAuthFailureEvent("login", "success")).toBe(false);
    expect(isAuthFailureEvent("logout", "failure")).toBe(false);
    expect(classifyAlert("login", "failure")).toBeNull();
  });

  it("しきい値（既定10回/30分）に達したときだけ急増と判定する", () => {
    const t0 = 1_770_000_000_000;
    for (let i = 1; i < DEFAULT_AUTH_FAILURE_THRESHOLD; i++) {
      expect(recordAuthFailure("snc-admin-01", t0 + i * 1000)).toBe(0);
    }
    expect(recordAuthFailure("snc-admin-01", t0 + DEFAULT_AUTH_FAILURE_THRESHOLD * 1000)).toBe(
      DEFAULT_AUTH_FAILURE_THRESHOLD
    );
    // 発火後は窓がクリアされ、再度しきい値に達するまで通知しない
    expect(recordAuthFailure("snc-admin-01", t0 + 20_000)).toBe(0);
  });

  it("評価窓（30分）を超えた失敗は数えない", () => {
    const t0 = 1_770_000_000_000;
    const windowMs = DEFAULT_AUTH_FAILURE_WINDOW_MIN * 60_000;
    for (let i = 0; i < DEFAULT_AUTH_FAILURE_THRESHOLD - 1; i++) {
      expect(recordAuthFailure("agent-01", t0 + i * 1000)).toBe(0);
    }
    // 窓の外（30分超）まで飛ぶと過去分は失効するので急増にならない
    expect(recordAuthFailure("agent-01", t0 + windowMs + 1000)).toBe(0);
  });

  it("アカウントを跨いだ失敗の総量でも急増と判定する（総当たり対策）", () => {
    process.env.AUTH_FAILURE_ALERT_THRESHOLD = "100"; // 個別しきい値には到達させない
    process.env.AUTH_FAILURE_ALERT_GLOBAL_THRESHOLD = "3";
    const t0 = 1_770_000_000_000;
    expect(recordAuthFailure("a-1", t0)).toBe(0);
    expect(recordAuthFailure("a-2", t0 + 1000)).toBe(0);
    expect(recordAuthFailure("a-3", t0 + 2000)).toBe(3);
  });

  it("日次バッチ（§3.3 不正利用検知）のログイン失敗多発も同じ種別に寄せる", () => {
    expect(classifyAlert("abuse_failed_logins", "detected")).toBe("auth_failure_spike");
    // 並行ログイン等の他シグナルはバッチ側で②へ通知済みなので二重にアラートしない
    expect(classifyAlert("abuse_concurrent_sessions", "detected")).toBeNull();
    expect(classifyAlert("abuse_multiple_ips", "detected")).toBeNull();
  });
});

describe("§10.4 アラートの構造化ログ・通知フック", () => {
  it("構造化ログ（JSON）に種別・実行者・対象・結果が含まれる", () => {
    const r = alertRecord(
      {
        kind: "privileged_operation",
        actor: "snc-admin-01",
        action: "account_delete",
        target: "agency-user-07",
        result: "success",
        ip: "203.0.113.10",
      },
      "2026-08-05T00:00:00.000Z"
    );
    expect(r).toMatchObject({
      type: "alert",
      ts: "2026-08-05T00:00:00.000Z",
      severity: "critical",
      kind: "privileged_operation",
      label: ALERT_KIND_LABELS.privileged_operation,
      actor: "snc-admin-01",
      action: "account_delete",
      target: "agency-user-07",
      result: "success",
      ip: "203.0.113.10",
      app: "airis",
    });
    // 1イベント=1行のJSONとして出力できる形式であること
    expect(JSON.parse(JSON.stringify(r)).kind).toBe("privileged_operation");
  });

  it("長すぎる対象は標準出力向けに切り詰める（全文はDBに残る）", () => {
    const r = alertRecord({
      kind: "export_operation",
      actor: "snc-admin-01",
      action: "csv_export",
      target: "x".repeat(2000),
    });
    expect(r.target).toHaveLength(1001); // 1000文字 + 省略記号
    expect(r.target?.endsWith("…")).toBe(true);
  });

  it("Webhook・メール未設定でも例外を投げず、構造化ログだけ出力する", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      alert({ kind: "export_operation", actor: "snc-admin-01", action: "csv_export" })
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(log.mock.calls[0][0] as string);
    expect(payload.type).toBe("alert");
    expect(payload.kind).toBe("export_operation");
    expect(payload.severity).toBe("warning");
  });

  it("Webhook設定時はJSONをPOSTし、失敗しても例外を投げない", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://collector.example.test/hook";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network unreachable"));

    await expect(
      alert({ kind: "privileged_operation", actor: "snc-admin-01", action: "mfa_reset" })
    ).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://collector.example.test/hook");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.kind).toBe("privileged_operation");
    expect(body.action).toBe("mfa_reset");
    // 汎用Webhookとして扱う（特定SaaS固有のキーは持たない）
    expect(body.blocks).toBeUndefined();
    expect(body.attachments).toBeUndefined();
  });

  it("ALERT_MAIL_TO 設定時にSMTP未設定でも例外を投げない（送信はスキップ）", async () => {
    process.env.ALERT_MAIL_TO = "soc@example.test, sec@example.test";
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      alert({
        kind: "auth_failure_spike",
        actor: "snc-admin-01",
        action: "login",
        result: "failure",
        detail: "認証失敗10回（直近30分）",
      })
    ).resolves.toBeUndefined();

    expect(err).not.toHaveBeenCalled();
  });
});
