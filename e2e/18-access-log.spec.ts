/**
 * QA担当: アクセスログ（§3.3 / 要件1-6）とレート制限のIP判定（§10.1）
 * データプレフィクス: QA18（専用アカウントで実施・後始末込み）
 *
 * - AccessLog へログイン成功/失敗/拒否（ロック・レート制限）が記録されること
 * - ロック判定・レート制限が AccessLog（直近30分/1分）の集計で行われること
 * - X-Forwarded-For の偽装でレート制限が回避できないこと（末尾hopを採用）
 * - アクセスログCSV（/admin/csv?type=access）が AccessLog から生成されること
 * - AccessLog へ記録できない場合はログインを許可しないこと（fail-closed）
 *
 * 前提: devサーバーは APP_DATABASE_URL（airis_appロール）+ PASSWORD_PEPPER_V1 付きで起動していること
 *   QA_BASE_URL=http://localhost:3401 PASSWORD_PEPPER_V1=<値> npx playwright test e2e/18-access-log.spec.ts
 */
import { test, expect, Page } from "@playwright/test";
import { hashSync as argon2HashSync } from "@node-rs/argon2";
import crypto from "crypto";
import { ACCOUNTS, db, login } from "./helpers";

const RUN = Date.now();

const GENERIC_LOGIN_ERROR = "IDまたはパスワードが正しくありません";
const LOCK_ERROR = "アカウントがロックされています。しばらくしてから再試行してください";
const RATE_LIMIT_ERROR = "試行が多すぎます。しばらくしてからお試しください";
const ACCESS_LOG_ERROR = "ログイン処理を完了できませんでした。しばらくしてから再試行してください";

// src/app/(auth)/actions.ts と同じ閾値
const RATE_MAX_FAILURES = 5; // 同一IP+同一IDで1分に5回まで
const LOCK_THRESHOLD = 10; // 30分間に10回失敗でロック

// src/lib/auth.ts と同じハッシュ方式（Argon2id + HMAC-SHA256ペッパー前段）
const PEPPER = process.env.PASSWORD_PEPPER_V1 ?? "";
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
function hashPw(pw: string): string {
  const input = PEPPER
    ? crypto.createHmac("sha256", PEPPER).update(pw, "utf8").digest("hex")
    : pw;
  return argon2HashSync(input, ARGON2_OPTIONS);
}

const PW = `QA18-Access-Log-${RUN}a`; // 一般ロール（14桁以上・大小英数）

async function createAccount(loginId: string): Promise<string> {
  await removeAccount(loginId);
  const acc = await db().account.create({
    data: {
      loginId,
      role: "R5",
      name: `QA18試験用 ${loginId}`,
      status: "active",
      passwordHash: hashPw(PW),
      mustChangePassword: false,
    },
  });
  return acc.id;
}

async function removeAccount(loginId: string) {
  // Session は onDelete: Cascade。監査ログ・アクセスログは明示的に後始末する
  await db().account.deleteMany({ where: { loginId } });
  await db().auditLog.deleteMany({ where: { actor: loginId } });
  await db().accessLog.deleteMany({ where: { loginId } });
}

async function submitLogin(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  const resp = page.waitForResponse((r) => r.request().method() === "POST", { timeout: 15_000 });
  await page.getByRole("button", { name: "ログイン" }).click();
  await resp;
}

// x-forwarded-for を差し替えてリクエストさせる（偽装プロキシヘッダの再現）。
// 返り値の関数で値を切り替える（page.route ハンドラは1つだけ登録する）。
async function installForwardedFor(page: Page): Promise<(value: string | null) => void> {
  let current: string | null = null;
  await page.route("**/*", async (route) => {
    if (!current) {
      await route.continue();
      return;
    }
    await route.continue({
      headers: { ...route.request().headers(), "x-forwarded-for": current },
    });
  });
  return (value) => {
    current = value;
  };
}

async function accessLogsOf(loginId: string) {
  return db().accessLog.findMany({ where: { loginId }, orderBy: { createdAt: "asc" } });
}

// ================================================================
// 1. ログイン成功／失敗の記録（§3.3 / 要件1-6）
// ================================================================
test.describe("AccessLogの記録", () => {
  test("ログイン成功で 日時・ログインID・アカウント・IP・UA が記録される（AuditLogにUAは埋め込まない）", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const ID = `qa18_ok_${RUN}`;
    const accountId = await createAccount(ID);
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const logs = await accessLogsOf(ID);
      expect(logs, "成功のアクセスログが1件記録されること").toHaveLength(1);
      const row = logs[0];
      expect(row.result).toBe("success");
      expect(row.accountId, "アカウント単位で記録されること（§3.3）").toBe(accountId);
      expect(row.ip, "IPアドレスが記録されること").toBeTruthy();
      expect(row.userAgent ?? "", "User-Agentが記録されること").toContain("Mozilla");
      expect(row.reason, "成功時に理由は付かない").toBeNull();
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

      // 監査ログ（§3.3）は従来どおり残るが、target への `ua=` 埋め込みは廃止されている
      const audit = await db().auditLog.findFirst({
        where: { actor: ID, action: "login", result: "success" },
      });
      expect(audit, "ログイン成功が監査記録されること").not.toBeNull();
      expect(audit!.target ?? "", "UAは監査ログのtargetへ埋め込まない").not.toContain("ua=");
      expect(audit!.ip).toBeTruthy();
    } finally {
      await removeAccount(ID);
    }
  });

  test("誤パスワード・存在しないIDの失敗が理由付きで記録される", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `qa18_ng_${RUN}`;
    const NO_SUCH = `qa18_no_such_${RUN}`;
    const accountId = await createAccount(ID);
    try {
      await submitLogin(page, ID, `${PW}-wrong`);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();

      const logs = await accessLogsOf(ID);
      expect(logs).toHaveLength(1);
      expect(logs[0].result).toBe("failure");
      expect(logs[0].reason).toBe("bad_password");
      expect(logs[0].accountId).toBe(accountId);
      expect(logs[0].userAgent ?? "").toContain("Mozilla");

      // 失敗回数は AccessLog の直近30分集計で failedAttempts に反映される（§4.2）
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.failedAttempts).toBe(1);

      // 存在しないID: アカウント未特定でもログインIDとして記録される（列挙防止の文言は同一）
      await submitLogin(page, NO_SUCH, PW);
      await expect(page.getByText(GENERIC_LOGIN_ERROR, { exact: true })).toBeVisible();
      const missing = await accessLogsOf(NO_SUCH);
      expect(missing).toHaveLength(1);
      expect(missing[0].result).toBe("failure");
      expect(missing[0].reason).toBe("unknown_account");
      expect(missing[0].accountId).toBeNull();
    } finally {
      await removeAccount(ID);
      await removeAccount(NO_SUCH);
    }
  });

  test("ロック判定はAccessLogの直近30分集計で行われ、ロック中の拒否も記録される", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const ID = `qa18_lock_${RUN}`;
    await createAccount(ID);
    try {
      // 3分前の失敗9回をアクセスログへシード（レート制限の1分窓の外・ロック窓の内）
      const base = Date.now() - 3 * 60 * 1000;
      await db().accessLog.createMany({
        data: Array.from({ length: LOCK_THRESHOLD - 1 }, (_, i) => ({
          loginId: ID,
          result: "failure",
          ip: "local",
          userAgent: "qa18-seed",
          reason: "bad_password",
          createdAt: new Date(base + i * 1000),
        })),
      });

      // 10回目の失敗でロックされる
      await submitLogin(page, ID, `${PW}-wrong`);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      const locked = await db().account.findUnique({ where: { loginId: ID } });
      expect(locked!.failedAttempts).toBe(LOCK_THRESHOLD);
      expect(locked!.lockedUntil).not.toBeNull();

      // 正しいパスワードでも拒否され、reason=locked のアクセスログが残る
      await submitLogin(page, ID, PW);
      await expect(page.getByText(LOCK_ERROR)).toBeVisible();
      const denied = await db().accessLog.findMany({ where: { loginId: ID, result: "denied" } });
      expect(denied).toHaveLength(1);
      expect(denied[0].reason).toBe("locked");
      // 拒否は失敗としてカウントしない（denied は failure 集計に入らない）
      const after = await db().account.findUnique({ where: { loginId: ID } });
      expect(after!.failedAttempts).toBe(LOCK_THRESHOLD);
      const cookie = (await page.context().cookies()).find((c) => c.name === "airis_session");
      expect(cookie, "ロック中はセッションが発行されないこと").toBeFalsy();
    } finally {
      await removeAccount(ID);
    }
  });
});

// ================================================================
// 2. X-Forwarded-For 偽装とレート制限（§10.1）
//    信頼できるプロキシは「自分が見た接続元」を x-forwarded-for の末尾に追記する。
//    したがって末尾hop（既定 TRUSTED_PROXY_HOPS=1）を採用し、先頭側の
//    クライアント申告値は無視する。
// ================================================================
test.describe("X-Forwarded-For 偽装対策", () => {
  // これらは TRUST_PROXY=true で起動したサーバー（プロキシ配下想定）に対する検証。
  // 既定構成（TRUST_PROXY未設定）ではXFFを一切信頼しないため、
  // npm run test:e2e:trust-proxy で別途実行する。
  test.skip(process.env.QA_TRUST_PROXY !== "true", "TRUST_PROXY=true のサーバーが必要");

  test("x-forwarded-for は末尾hopが採用される（先頭の偽装値は無視される）", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `qa18_xff_pick_${RUN}`;
    await createAccount(ID);
    const SPOOFED = "203.0.113.1"; // クライアントが偽装した先頭要素
    const REAL = "198.51.100.9"; // 信頼できるプロキシが追記した末尾要素
    try {
      const setXff = await installForwardedFor(page);
      setXff(`${SPOOFED}, ${REAL}`);
      await submitLogin(page, ID, `${PW}-wrong`);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();

      const logs = await accessLogsOf(ID);
      expect(logs).toHaveLength(1);
      expect(logs[0].ip, "末尾hopが接続元IPとして採用されること").toBe(REAL);
      expect(logs[0].ip, "偽装された先頭要素は採用されないこと").not.toBe(SPOOFED);
    } finally {
      await removeAccount(ID);
    }
  });

  test("偽装プレフィクスを変えてもレート制限を回避できない（末尾hop単位で集計）", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const ID = `qa18_xff_rate_${RUN}`;
    await createAccount(ID);
    const REAL = "198.51.100.77"; // プロキシが付与する真の接続元（末尾）
    const OTHER = "198.51.100.88"; // 別の接続元（対照）
    try {
      const setXff = await installForwardedFor(page);

      // 失敗5回。毎回「先頭の偽装IP」を変える＝先頭を採用する実装ならレート制限を回避できてしまう
      for (let i = 0; i < RATE_MAX_FAILURES; i++) {
        setXff(`10.0.0.${i + 1}, ${REAL}`);
        await submitLogin(page, ID, `${PW}-wrong`);
        await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      }

      // 6回目は偽装プレフィクスを変えても、正しいパスワードでもレート制限で拒否される
      setXff(`10.0.0.99, ${REAL}`);
      await submitLogin(page, ID, PW);
      await expect(page.getByText(RATE_LIMIT_ERROR)).toBeVisible();
      const cookie = (await page.context().cookies()).find((c) => c.name === "airis_session");
      expect(cookie, "レート制限で拒否された場合はセッションが発行されないこと").toBeFalsy();

      // 記録されたIPは全て末尾hop（偽装した先頭要素は1件も採用されていない）
      const logs = await accessLogsOf(ID);
      expect(logs).toHaveLength(RATE_MAX_FAILURES + 1);
      expect(logs.every((l) => l.ip === REAL), "全件が末尾hopで記録されること").toBe(true);
      expect(logs.filter((l) => l.result === "failure")).toHaveLength(RATE_MAX_FAILURES);
      const denied = logs.filter((l) => l.result === "denied");
      expect(denied).toHaveLength(1);
      expect(denied[0].reason).toBe("rate_limit");

      // 対照: 末尾hop（=偽装できない値）が別IPなら別カウンタとして扱われる
      // ＝レート制限のキーが「先頭の申告値」ではなく「末尾hop」であることの裏付け
      setXff(`10.0.0.99, ${OTHER}`);
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const success = (await accessLogsOf(ID)).find((l) => l.result === "success");
      expect(success!.ip).toBe(OTHER);
    } finally {
      await removeAccount(ID);
    }
  });
});

// ================================================================
// 3. アクセスログCSV（§3.3 / §3.6 / 要件1-6）と管理画面ビューア
// ================================================================
test.describe("アクセスログCSV・ビューア", () => {
  // CSVのIP列の値は接続元IPの信頼設定に依存する（§10.1）。
  // 既定構成では unknown、TRUST_PROXY=true のサーバーでは末尾hopが記録される。
  const EXPECTED_IP = process.env.QA_TRUST_PROXY === "true" ? "198.51.100.21" : "unknown";
  test("CSVはAccessLogから生成され、列は 日時,ログインID,結果,IP,UserAgent,理由", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    const ID = `qa18_csv_${RUN}`;
    await createAccount(ID);
    const REAL = "198.51.100.21";
    try {
      // 失敗1件を作る（IP・UA・理由が入った行をCSVで確認するため）
      const ctx = await browser.newContext({
        baseURL: process.env.QA_BASE_URL ?? "http://localhost:3100",
      });
      const p2 = await ctx.newPage();
      const setXff = await installForwardedFor(p2);
      setXff(`203.0.113.5, ${REAL}`);
      await submitLogin(p2, ID, `${PW}-wrong`);
      await expect(p2.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      const ua = await p2.evaluate(() => navigator.userAgent);
      await ctx.close();

      const logged = await accessLogsOf(ID);
      expect(logged).toHaveLength(1);

      await login(page, "R2");
      const res = await page.request.get("/admin/csv?type=access");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/csv");
      const body = await res.text();
      expect(body.charCodeAt(0), "BOM付きUTF-8（§3.6）").toBe(0xfeff);
      const lines = body.replace(/^﻿/, "").split("\r\n");
      expect(lines[0]).toBe("日時,ログインID,結果,IP,UserAgent,理由");

      const row = lines.find((l) => l.includes(ID));
      expect(row, "AccessLogの行がCSVに出力されること").toBeTruthy();
      expect(row!).toContain("failure");
      expect(row!, "IP列（既定構成ではunknown / プロキシ配下では末尾hop）").toContain(EXPECTED_IP);
      expect(row!).toContain("bad_password");
      expect(row!, "User-AgentがCSVに出力されること").toContain(ua.slice(0, 20));
      // 日時はJST（YYYY-MM-DD HH:MM）
      expect(row!.split(",")[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

      // CSV出力自体も監査対象（§3.6）
      const exportLog = await db().auditLog.findFirst({
        where: { actor: ACCOUNTS.R2.loginId, action: "csv_export", target: "access_logs" },
        orderBy: { createdAt: "desc" },
      });
      expect(exportLog).not.toBeNull();
    } finally {
      await removeAccount(ID);
    }
  });

  test("管理画面のアクセスログビューア（直近100件）に表示される", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `qa18_view_${RUN}`;
    await createAccount(ID);
    try {
      await submitLogin(page, ID, `${PW}-wrong`);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();

      await login(page, "R2");
      await page.goto("/admin");
      await expect(
        page.getByRole("heading", { name: /アクセスログ（直近100件）/ })
      ).toBeVisible();
      await expect(page.locator("td", { hasText: ID }).first()).toBeVisible();
      // アクセスログCSV出力リンクが提供されている（§7.2）
      await expect(page.getByRole("link", { name: "アクセスログCSV出力" })).toBeVisible();
    } finally {
      await removeAccount(ID);
    }
  });
});

// ================================================================
// 4. fail-closed（アクセスログが記録できない場合はログインさせない）
//    AccessLog はロック判定・レート制限の情報源なので、書き込めない状態で
//    ログインを通すと総当たり対策が無効化される。
//    アプリ接続ロール（airis_app）のINSERT権限を一時的に剥奪して再現する。
// ================================================================
test.describe("AccessLog書き込み失敗時の fail-closed", () => {
  test("INSERTできない場合は正しいパスワードでもログインを許可しない", async ({ page }) => {
    test.setTimeout(180_000);
    const ID = `qa18_failclosed_${RUN}`;
    const accountId = await createAccount(ID);
    let revoked = false;
    try {
      await db().$executeRawUnsafe('REVOKE INSERT ON TABLE "AccessLog" FROM airis_app');
      revoked = true;

      // 正しいパスワードでもログインできない（セッションを発行しない）
      await submitLogin(page, ID, PW);
      await expect(page.getByText(ACCESS_LOG_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");
      const cookie = (await page.context().cookies()).find((c) => c.name === "airis_session");
      expect(cookie, "セッションCookieが発行されないこと").toBeFalsy();
      expect(await db().session.count({ where: { accountId } })).toBe(0);

      // 失敗側も同様に fail-closed（失敗が数えられない状態でログインを続行させない）
      await submitLogin(page, ID, `${PW}-wrong`);
      await expect(page.getByText(ACCESS_LOG_ERROR)).toBeVisible();

      // アクセスログは1件も残っていない（＝記録できていない状態だった）
      expect(await accessLogsOf(ID)).toHaveLength(0);
    } finally {
      if (revoked) {
        await db().$executeRawUnsafe('GRANT INSERT ON TABLE "AccessLog" TO airis_app');
      }
      await removeAccount(ID);
    }
  });

  test("権限を戻した後は通常どおりログインでき、記録される（復旧確認）", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `qa18_restored_${RUN}`;
    await createAccount(ID);
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const logs = await accessLogsOf(ID);
      expect(logs).toHaveLength(1);
      expect(logs[0].result).toBe("success");
    } finally {
      await removeAccount(ID);
    }
  });
});

// ============================================================================
// TRUST_PROXY 未設定（本番既定）では x-forwarded-for を信頼しない（§10.1 fail-closed）
// ※このテストは TRUST_PROXY=true で起動した検証サーバーでは skip される
// ============================================================================
test.describe("TRUST_PROXY のオプトイン", () => {
  test("TRUST_PROXY未設定時はXFFを信頼せず、接続元IPは unknown として記録される", async ({ page }) => {
    // 検証サーバーがTRUST_PROXY=trueで起動している場合はこのケースを検証できない
    // 既定構成（TRUST_PROXY未設定）で必ず検証する。TRUST_PROXY=true のサーバーでのみskip。
    test.skip(
      process.env.QA_TRUST_PROXY === "true",
      "TRUST_PROXY=true のサーバーでは既定挙動を検証できない"
    );
    const d = db();
    const ID = `qa18_untrusted_${RUN}`;
    await d.account.create({
      data: {
        loginId: ID,
        role: "R5",
        name: "QA18 XFF非信頼検証",
        status: "active",
        passwordHash: "x",
        mustChangePassword: false,
      },
    });
    try {
      await page.setExtraHTTPHeaders({ "x-forwarded-for": "203.0.113.77" });
      await page.goto("/login");
      await page.locator('input[name="loginId"]').fill(ID);
      await page.locator('input[name="password"]').fill("wrong-password");
      await page.getByRole("button", { name: "ログイン" }).click();
      await expect(page.getByText("IDまたはパスワードが正しくありません")).toBeVisible();

      const logs = await d.accessLog.findMany({ where: { loginId: ID } });
      expect(logs).toHaveLength(1);
      expect(logs[0].ip, "偽装XFFは採用されない").not.toBe("203.0.113.77");
      expect(logs[0].ip, "信頼できるIPが決定できない場合は unknown").toBe("unknown");
    } finally {
      await d.accessLog.deleteMany({ where: { loginId: ID } });
      await d.auditLog.deleteMany({ where: { actor: ID } });
      await d.account.deleteMany({ where: { loginId: ID } });
    }
  });
});
