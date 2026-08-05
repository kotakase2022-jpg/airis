// QA担当: 認証（§4.2, §10.1, §13）
// データプレフィクス: QA1
import { test, expect, Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import crypto from "crypto";
import {
  completeMfaIfNeeded,
  ACCOUNTS,
  PW_ADMIN,
  PW_GENERAL,
  RoleKey,
  db,
  login,
  collectConsoleErrors,
  criticalErrors,
  resetAccountAuthState,
} from "./helpers";

// ロール別ヘッダバッジ表示（src/lib/roles.ts ROLE_LABELS 準拠。仕様§4/§14-2: R10は実効ロール解決）
const ROLE_HEADER_BADGE: Record<RoleKey, string> = {
  R1: "SLシステム管理 モード",
  R2: "SNC管理者 モード",
  R3: "SNC運用者 モード",
  R4: "SNC閲覧者 モード",
  R5: "SNCホットライン担当 モード",
  R6: "SNC消費者センター担当 モード",
  R7: "一次代理店管理者 モード",
  R8: "二次代理店管理者 モード",
  R9: "代理店一般（販売員） モード",
  R10: "稼働終了代理店 モード",
};

const GENERIC_LOGIN_ERROR = "IDまたはパスワードが正しくありません";
const LOCK_ERROR = "アカウントがロックされています。しばらくしてから再試行してください";
const RATE_LIMIT_ERROR = "試行が多すぎます。しばらくしてからお試しください";

// §4.2 / §10.1 の閾値（src/app/(auth)/actions.ts と一致させる）
const RATE_MAX_FAILURES = 5; // 同一IP+同一IDで1分に5回まで
const LOCK_THRESHOLD = 10; // 30分間に10回失敗でロック

// 認証失敗のアクセスログを直接シードする（ロック判定は AccessLog の直近30分集計で行われる）。
// レート制限（直近1分）に掛からないよう、既定で数分前の時刻に打つ。
async function seedLoginFailures(loginId: string, count: number, minutesAgo: number) {
  const base = Date.now() - minutesAgo * 60 * 1000;
  for (let i = 0; i < count; i++) {
    await db().accessLog.create({
      data: {
        loginId,
        result: "failure",
        ip: "local",
        userAgent: "qa1-seed",
        reason: "bad_password",
        createdAt: new Date(base + i * 1000),
      },
    });
  }
}

// 監査ログ＋アクセスログの後始末（アクセスログはロック/レート制限のカウンタ源なので必須）
async function clearLoginAudit(loginId: string) {
  await db().auditLog.deleteMany({ where: { actor: loginId } });
  await db().accessLog.deleteMany({ where: { loginId } });
}

// 認証系専用アカウントの作成（シード行を破壊しない）。passwordHash は既存⑧からコピー = PW_GENERAL
async function createAuthTestAccount(loginId: string) {
  const prisma = db();
  const src = await prisma.account.findUnique({ where: { loginId: ACCOUNTS.R8.loginId } });
  expect(src).toBeTruthy();
  await prisma.account.deleteMany({ where: { loginId } });
  await prisma.account.create({
    data: {
      loginId,
      role: "R8",
      name: `QA1 認証試験用(${loginId})`,
      agencyId: src!.agencyId,
      status: "active",
      passwordHash: src!.passwordHash, // = PW_GENERAL
      mustChangePassword: false,
    },
  });
}

async function removeAuthTestAccount(loginId: string) {
  await clearLoginAudit(loginId);
  await db().account.deleteMany({ where: { loginId } }); // sessionsはonDelete:Cascade
}

// ログインフォーム送信（結果を待たず、server action のレスポンスまで待つ）
async function submitLogin(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  const resp = page.waitForResponse((r) => r.request().method() === "POST", {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "ログイン" }).click();
  await resp;
  // MFA画面へ遷移した場合は通過する（失敗ケースは /login に留まるため何もしない）
  try {
    await page.waitForURL(/\/(mfa|dashboard|password)/, { timeout: 2000 });
  } catch {
    return;
  }
  if (page.url().includes("/mfa")) await completeMfaIfNeeded(page, loginId);
}

// ================================================================
// 1. 全10ロールのログイン成功 → /dashboard（コンソールエラー0）
// ================================================================
test.describe("ログイン成功（全10ロール）", () => {
  for (const role of Object.keys(ACCOUNTS) as RoleKey[]) {
    test(`${role}(${ACCOUNTS[role].label}) でログイン → /dashboard`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await login(page, role);
      await expect(page).toHaveURL(/\/dashboard/);
      // 実効ロールのヘッダバッジ（R10は稼働終了1次店の⑦が⑩に解決されること §14-2）
      await expect(page.getByText(ROLE_HEADER_BADGE[role], { exact: true })).toBeVisible();
      // ダッシュボード本体が表示されること
      await expect(page.locator("main")).toBeVisible();
      expect(criticalErrors(errors)).toEqual([]);
    });
  }
});

// ================================================================
// 1b. 入力ゆらぎの吸収（src/lib/password-input.ts / 運用配慮）
//     貼り付け時の前後空白・引用符、IMEの全角英数でもログインできること
// ================================================================
test.describe("ログイン入力ゆらぎの吸収", () => {
  const toFullWidth = (s: string) =>
    s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));

  test("パスワード前後の空白（貼り付け起因）でもログインできる", async ({ page }) => {
    await submitLogin(page, ACCOUNTS.R6.loginId, ` ${ACCOUNTS.R6.pw} `);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  });

  test("引用符ごと貼り付けてもログインできる", async ({ page }) => {
    await submitLogin(page, ACCOUNTS.R6.loginId, `"${ACCOUNTS.R6.pw}"`);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  });

  test("IMEの全角英数記号でもログインできる", async ({ page }) => {
    await submitLogin(page, ACCOUNTS.R6.loginId, toFullWidth(ACCOUNTS.R6.pw));
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  });

  test("ゆらぎ吸収でも誤パスワードは通らない（受理範囲を広げただけで弱化していない）", async ({
    page,
  }) => {
    try {
      await submitLogin(page, ACCOUNTS.R6.loginId, ` ${ACCOUNTS.R6.pw}x `);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");
    } finally {
      await resetAccountAuthState(ACCOUNTS.R6.loginId);
    }
  });
});

// ================================================================
// 2. ログイン失敗系（ユーザー列挙防止 §10.1）
// ================================================================
test.describe("ログイン失敗", () => {
  test("誤パスワード → 汎用エラーメッセージ・/loginに留まる", async ({ page }) => {
    try {
      await submitLogin(page, ACCOUNTS.R6.loginId, "Wrong-Password-2026!!");
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");
      // 失敗が failedAttempts に記録されること
      const acc = await db().account.findUnique({
        where: { loginId: ACCOUNTS.R6.loginId },
      });
      expect(acc?.failedAttempts).toBeGreaterThanOrEqual(1);
    } finally {
      // 共有シードアカウントの状態を復元
      await resetAccountAuthState(ACCOUNTS.R6.loginId);
    }
  });

  test("存在しないID → 誤パスワードと同一のエラー文言（列挙防止）", async ({ page }) => {
    await submitLogin(page, "QA1_no_such_user_999", "Whatever-Password-1!");
    await expect(page.getByText(GENERIC_LOGIN_ERROR, { exact: true })).toBeVisible();
    expect(page.url()).toContain("/login");
  });

  test("必須未入力（ID空）ではログインできない", async ({ page }) => {
    await page.goto("/login");
    await page.locator('input[name="password"]').fill("Some-Password-2026!");
    await page.getByRole("button", { name: "ログイン" }).click();
    // required属性またはサーバ側バリデーションで /login に留まる
    await page.waitForTimeout(1000);
    expect(page.url()).toContain("/login");
  });
});

// ================================================================
// 3. 認証エンドポイントのレート制限（§10.1 / SEC要件②）
//    同一IP+同一IDで1分に5回失敗したら、以降は認証情報の正否に関わらず拒否
// ================================================================
test.describe("ログインのレート制限", () => {
  const RATE_ID = "QA1_rate_001";

  test("1分に5回失敗 → 6回目は正しいパスワードでも拒否・監査記録あり", async ({ page }) => {
    test.setTimeout(240_000);
    await createAuthTestAccount(RATE_ID);
    try {
      // 上限まで（5回）は通常の汎用エラー
      for (let i = 0; i < RATE_MAX_FAILURES; i++) {
        await submitLogin(page, RATE_ID, "QA1-Wrong-Pass-777!!");
        await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      }

      // 6回目は「正しいパスワード」でもレート制限で拒否される
      // （パスワード検証より前で止まっていること = 総当たり抑止が効いていること）
      await submitLogin(page, RATE_ID, PW_GENERAL);
      await expect(page.getByText(RATE_LIMIT_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");
      const cookie = (await page.context().cookies()).find((c) => c.name === "airis_session");
      expect(cookie, "レート制限で拒否された場合はセッションが発行されないこと").toBeFalsy();

      // 拒否は監査ログに記録される（result=denied。失敗カウントには算入しない）
      const denied = await db().auditLog.findFirst({
        where: { actor: RATE_ID, action: "login", result: "denied" },
      });
      expect(denied, "レート制限による拒否が監査記録されること").not.toBeNull();
      expect(denied?.target).toContain("blocked=rate_limit");
      expect(denied?.ip).toBeTruthy();
      // UAは監査ログのtargetへ埋め込まず、AccessLog側に記録される（§3.3）
      expect(denied?.target).not.toContain("ua=");
      const deniedAccess = await db().accessLog.findFirst({
        where: { loginId: RATE_ID, result: "denied" },
      });
      expect(deniedAccess?.reason, "アクセスログにも拒否理由が残ること").toBe("rate_limit");

      // レート制限はロックではない（失敗5回なのでロック閾値10には達していない）
      const acc = await db().account.findUnique({ where: { loginId: RATE_ID } });
      expect(acc?.failedAttempts).toBe(RATE_MAX_FAILURES);
      expect(acc?.lockedUntil).toBeNull();
    } finally {
      await removeAuthTestAccount(RATE_ID);
    }
  });
});

// ================================================================
// 4. アカウントロック（30分間に10回失敗 → 30分ロック §4.2 / SEC②#12）
//    ロック判定は AccessLog（result=failure）の直近30分集計で行われる。
//    レート制限（1分5回）があるため、過去分の失敗はアクセスログへ直接シードして再現する。
// ================================================================
test.describe("アカウントロック（30分スライディングウィンドウ）", () => {
  const LOCK_ID = "QA1_lock_001";
  const WINDOW_ID = "QA1_lock_window_001";
  const EXPIRE_ID = "QA1_lock_expire_001";

  test("30分内に10回失敗でロック → ロックメッセージ → リセットで復旧", async ({ page }) => {
    test.setTimeout(240_000);
    await createAuthTestAccount(LOCK_ID);
    try {
      // 3分前の失敗9回（ウィンドウ内・レート制限の1分窓外）
      await seedLoginFailures(LOCK_ID, LOCK_THRESHOLD - 1, 3);
      // 10回目は実際のログインフォームから
      await submitLogin(page, LOCK_ID, "QA1-Wrong-Pass-999!!");
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();

      // DB: failedAttempts=10 かつ lockedUntil がセットされていること
      const locked = await db().account.findUnique({ where: { loginId: LOCK_ID } });
      expect(locked?.failedAttempts).toBeGreaterThanOrEqual(LOCK_THRESHOLD);
      expect(locked?.lockedUntil).not.toBeNull();
      expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // 正しいパスワードでもロックメッセージが出てログインできない
      await submitLogin(page, LOCK_ID, PW_GENERAL);
      await expect(page.getByText(LOCK_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");

      // ロック中の試行も監査記録される（§3.3）
      const blocked = await db().auditLog.findFirst({
        where: { actor: LOCK_ID, action: "login", result: "denied" },
      });
      expect(blocked?.target).toContain("blocked=locked");

      // 管理者によるロック解除相当（失敗履歴+カウンタのリセット）→ ログイン成功
      await clearLoginAudit(LOCK_ID);
      await resetAccountAuthState(LOCK_ID);
      await submitLogin(page, LOCK_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    } finally {
      await resetAccountAuthState(LOCK_ID);
      await removeAuthTestAccount(LOCK_ID);
    }
  });

  test("30分より前の失敗はロックに算入されない（スライディングウィンドウ）", async ({ page }) => {
    test.setTimeout(240_000);
    await createAuthTestAccount(WINDOW_ID);
    try {
      // 31〜42分前に12回失敗（ウィンドウ外なので失効しているべき）
      await seedLoginFailures(WINDOW_ID, 12, 42);
      await submitLogin(page, WINDOW_ID, "QA1-Wrong-Pass-888!!");
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();

      // 直近30分の失敗は今回の1回だけ → ロックされない
      const acc = await db().account.findUnique({ where: { loginId: WINDOW_ID } });
      expect(acc?.failedAttempts, "古い失敗は失効すること").toBe(1);
      expect(acc?.lockedUntil).toBeNull();

      // 正しいパスワードでログインできる
      await submitLogin(page, WINDOW_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    } finally {
      await removeAuthTestAccount(WINDOW_ID);
    }
  });

  test("lockedUntil満了後は failedAttempts が0に戻り、再ロックされない", async ({ page }) => {
    test.setTimeout(240_000);
    await createAuthTestAccount(EXPIRE_ID);
    try {
      // 満了済みロック + 失敗カウンタ10 の状態を作る
      await db().account.updateMany({
        where: { loginId: EXPIRE_ID },
        data: { failedAttempts: LOCK_THRESHOLD, lockedUntil: new Date(Date.now() - 60 * 1000) },
      });

      // 1回失敗 → 満了ロックはリセットされ、カウンタは「直近30分の失敗=1回」になる
      await submitLogin(page, EXPIRE_ID, "QA1-Wrong-Pass-666!!");
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      const acc = await db().account.findUnique({ where: { loginId: EXPIRE_ID } });
      expect(acc?.failedAttempts, "満了時に0へ戻ってから再計上されること").toBe(1);
      expect(acc?.lockedUntil, "満了ロックが即再ロックされないこと").toBeNull();

      // 正しいパスワードでログインでき、カウンタも0に戻る
      await submitLogin(page, EXPIRE_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const after = await db().account.findUnique({ where: { loginId: EXPIRE_ID } });
      expect(after?.failedAttempts).toBe(0);
      expect(after?.lockedUntil).toBeNull();
    } finally {
      await removeAuthTestAccount(EXPIRE_ID);
    }
  });
});

// ================================================================
// 5. 未ログイン時の保護ページアクセス → /login リダイレクト
// ================================================================
test.describe("未ログインアクセス制御", () => {
  for (const route of ["/dashboard", "/admin", "/reports", "/notifications", "/hotline"]) {
    test(`未ログインで ${route} → /login`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
      await expect(page.locator('input[name="loginId"]')).toBeVisible();
    });
  }
});

// ================================================================
// 6. ログアウト → /login、その後の保護ページアクセスも /login
// ================================================================
test("ログアウト → /login → 保護ページ再アクセスも /login（セッション破棄）", async ({ page }) => {
  await login(page, "R9");
  await expect(page).toHaveURL(/\/dashboard/);
  // ログアウト前のセッショントークンを控える
  const cookieBefore = (await page.context().cookies()).find((c) => c.name === "airis_session");
  expect(cookieBefore).toBeTruthy();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  // セッションが破棄されているので保護ページへは入れない
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  // DB上も当該セッションが破棄されていること（他テストのセッションは対象外）
  const session = await db().session.findUnique({
    where: { token: cookieBefore!.value },
  });
  expect(session).toBeNull();
});

// ================================================================
// 7. パスワード変更画面（§4.2: 管理者20桁 / 一般14桁）
//    専用アカウント（QA1）で実施し、テスト後に削除
// ================================================================
test.describe("パスワード変更", () => {
  const GEN_ID = "QA1_pw_gen_001"; // 一般（R5相当・最小14桁）
  const ADM_ID = "QA1_pw_adm_001"; // 管理者（R3相当・最小20桁）

  async function createTestAccount(loginId: string, role: string, srcLoginId: string) {
    const prisma = db();
    const src = await prisma.account.findUnique({ where: { loginId: srcLoginId } });
    expect(src).toBeTruthy();
    await prisma.account.deleteMany({ where: { loginId } });
    await prisma.account.create({
      data: {
        loginId,
        role,
        name: `QA1 PW試験用(${role})`,
        status: "active",
        passwordHash: src!.passwordHash,
        mustChangePassword: false,
      },
    });
  }

  async function removeTestAccount(loginId: string) {
    await db().account.deleteMany({ where: { loginId } });
    await clearLoginAudit(loginId); // 監査ログは Cascade 対象外なので明示的に削除
  }

  async function submitPasswordChange(page: Page, current: string, next: string, confirm: string) {
    await page.goto("/password");
    await page.locator('input[name="current"]').fill(current);
    await page.locator('input[name="next"]').fill(next);
    await page.locator('input[name="confirm"]').fill(confirm);
    const resp = page.waitForResponse((r) => r.request().method() === "POST", {
      timeout: 15_000,
    });
    await page.getByRole("button", { name: "変更する" }).click();
    await resp;
  }

  test("一般アカウント: 不一致 / 現在PW誤り / 14桁未満エラー", async ({ page }) => {
    test.setTimeout(120_000);
    await createTestAccount(GEN_ID, "R5", ACCOUNTS.R5.loginId);
    try {
      await submitLogin(page, GEN_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      // ログイン直後のハッシュ（旧方式なら成功時にArgon2idへ再ハッシュされているため、ここを基準にする）
      const afterLogin = await db().account.findUnique({ where: { loginId: GEN_ID } });

      // 現在パスワード誤り
      await submitPasswordChange(
        page,
        "Wrong-Current-123!",
        "QA1-NewPassword-14aA",
        "QA1-NewPassword-14aA"
      );
      await expect(page.getByText("現在のパスワードが正しくありません")).toBeVisible();

      // 新パスワード不一致
      await submitPasswordChange(page, PW_GENERAL, "QA1-NewPassword-14aA", "QA1-NewPassword-14aB");
      await expect(page.getByText("新しいパスワードが一致しません")).toBeVisible();

      // 桁数不足（13桁・大小英数含む）→ 一般は14桁必須
      await submitPasswordChange(page, PW_GENERAL, "Abcdef123456!", "Abcdef123456!");
      await expect(page.getByText("パスワードは14桁以上にしてください")).toBeVisible();

      // DB: パスワードが変わっていないこと
      const acc = await db().account.findUnique({ where: { loginId: GEN_ID } });
      expect(acc?.passwordHash).toBe(afterLogin?.passwordHash);
    } finally {
      await removeTestAccount(GEN_ID);
    }
  });

  test("管理者アカウント: 20桁未満エラー", async ({ page }) => {
    test.setTimeout(120_000);
    await createTestAccount(ADM_ID, "R3", ACCOUNTS.R3.loginId);
    try {
      await submitLogin(page, ADM_ID, PW_ADMIN);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // 19桁（大小英数含む）→ 管理者は20桁必須
      const pw19 = "Abcdefghij123456789"; // 19桁
      expect(pw19.length).toBe(19);
      await submitPasswordChange(page, PW_ADMIN, pw19, pw19);
      await expect(page.getByText("パスワードは20桁以上にしてください")).toBeVisible();
    } finally {
      await removeTestAccount(ADM_ID);
    }
  });

  test("正常系: 変更成功 → /dashboard・DBのハッシュ更新", async ({ page }) => {
    test.setTimeout(120_000);
    await createTestAccount(GEN_ID, "R5", ACCOUNTS.R5.loginId);
    try {
      const before = await db().account.findUnique({ where: { loginId: GEN_ID } });
      const errors = collectConsoleErrors(page);
      await submitLogin(page, GEN_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const newPw = "QA1-Changed-2026-abc1"; // 21桁・大小英数
      await submitPasswordChange(page, PW_GENERAL, newPw, newPw);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // DB: ハッシュが更新されていること
      const after = await db().account.findUnique({ where: { loginId: GEN_ID } });
      expect(after?.passwordHash).not.toBe(before?.passwordHash);
      expect(after?.mustChangePassword).toBe(false);

      // 新パスワードで再ログインできること
      await page.getByRole("button", { name: "ログアウト" }).click();
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      await submitLogin(page, GEN_ID, newPw);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      expect(criticalErrors(errors)).toEqual([]);
    } finally {
      await removeTestAccount(GEN_ID);
    }
  });
});

// ================================================================
// 8. /api/cron/daily の認証（Bearer CRON_SECRET=qa-test-secret）
// ================================================================
test.describe("/api/cron/daily 認証", () => {
  test("認証ヘッダなし → 401", async ({ request }) => {
    const r = await request.get("/api/cron/daily");
    expect(r.status()).toBe(401);
  });

  test("誤ったBearer → 401", async ({ request }) => {
    const r = await request.get("/api/cron/daily", {
      headers: { authorization: "Bearer wrong-secret" },
    });
    expect(r.status()).toBe(401);
  });

  test("正しいBearer(qa-test-secret) → 200 + ok:true", async ({ request }) => {
    const r = await request.get("/api/cron/daily", {
      headers: { authorization: "Bearer qa-test-secret" },
      timeout: 60_000,
    });
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
  });
});

// ================================================================
// 9. パスワードハッシュ: Argon2id + ペッパー（§2 / §10.3 / SEC②#42）
//    ハッシュ関数は Argon2id（OWASP推奨 m=19MiB/t=2/p=1）。ペッパーは環境変数
//    PASSWORD_PEPPER_V1（HMAC-SHA256 前段）。サーバ側と同じ値をテストプロセスにも
//    与えた場合のみ実行する（未設定＝ペッパー無効なのでスキップ）。
//      DATABASE_URL=... PASSWORD_PEPPER_V1=<値> npx next dev -p 3401
//      QA_BASE_URL=http://localhost:3401 PASSWORD_PEPPER_V1=<値> npx playwright test e2e/01-auth.spec.ts
// ================================================================
test.describe("パスワードハッシュ（Argon2id + ペッパー）", () => {
  const PEPPER = process.env.PASSWORD_PEPPER_V1 ?? "";
  const PEPPER_ID = "QA1_pepper_001";
  // src/lib/auth.ts と同じ前段ハッシュ（HMAC-SHA256・鍵=ペッパー）
  const prehash = (pw: string) =>
    crypto.createHmac("sha256", PEPPER).update(pw, "utf8").digest("hex");
  // src/lib/auth.ts と同じ Argon2id パラメータ（OWASP推奨）
  const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
  const argon2Peppered = (pw: string) => argon2HashSync(prehash(pw), ARGON2_OPTIONS);
  const bcryptPeppered = (pw: string) => bcrypt.hashSync(prehash(pw), 10);
  const argon2Matches = (pw: string, hash: string) => {
    try {
      return argon2VerifySync(hash, pw);
    } catch {
      return false;
    }
  };
  // 現行方式（Argon2id + ペッパー）で検証できること
  const matchesCurrent = (pw: string, hash: string) => argon2Matches(prehash(pw), hash);
  // Argon2idの識別子とOWASPパラメータがハッシュ文字列に含まれること
  const ARGON2ID_PREFIX = "$argon2id$v=19$m=19456,t=2,p=1$";

  test.skip(!PEPPER, "PASSWORD_PEPPER_V1 未設定（ペッパー無効）のためスキップ");

  test("旧bcryptハッシュ（ペッパー無し）でもログインでき、成功時にArgon2id+ペッパーへ再ハッシュされる", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const prisma = db();
    const PW = "QA1-Pepper-Legacy-2026a"; // 20桁以上（⑦想定でも足りる長さ）
    await prisma.account.deleteMany({ where: { loginId: PEPPER_ID } });
    await prisma.account.create({
      data: {
        loginId: PEPPER_ID,
        role: "R5",
        name: "QA1 ハッシュ移行試験用",
        status: "active",
        passwordHash: bcrypt.hashSync(PW, 10), // 旧方式（bcrypt・ペッパー無し）
        mustChangePassword: false,
      },
    });
    try {
      const before = await prisma.account.findUnique({ where: { loginId: PEPPER_ID } });
      expect(before!.passwordHash.startsWith("$2")).toBe(true); // bcrypt形式
      // 旧ハッシュでもログインできる（互換検証）
      await submitLogin(page, PEPPER_ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // 成功時に Argon2id（OWASPパラメータ）+ ペッパー付きへ再ハッシュされている
      const after = await prisma.account.findUnique({ where: { loginId: PEPPER_ID } });
      expect(after!.passwordHash).not.toBe(before!.passwordHash);
      expect(
        after!.passwordHash.startsWith(ARGON2ID_PREFIX),
        `Argon2id（m=19MiB/t=2/p=1）で保存されること: ${after!.passwordHash.slice(0, 40)}`
      ).toBe(true);
      expect(matchesCurrent(PW, after!.passwordHash), "Argon2id+ペッパーで検証できること").toBe(
        true
      );
      expect(
        argon2Matches(PW, after!.passwordHash),
        "ペッパー無しでは検証できないこと（ペッパーが実効していること）"
      ).toBe(false);
      // 有効期限の起点は変えない（§4.2）
      expect(after!.passwordUpdatedAt.getTime()).toBe(before!.passwordUpdatedAt.getTime());
      // 鍵交換・アルゴリズム移行の監査証跡（SEC②#42 / §10.3）
      const log = await prisma.auditLog.findFirst({
        where: { actor: PEPPER_ID, action: "password_rehash" },
      });
      expect(log, "再ハッシュが監査記録されること").not.toBeNull();
      expect(log!.target).toContain("argon2id");

      // 再ハッシュ後も同じパスワードでログインできる
      await page.getByRole("button", { name: "ログアウト" }).click();
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      await submitLogin(page, PEPPER_ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    } finally {
      await removeAuthTestAccount(PEPPER_ID);
    }
  });

  test("bcrypt+ペッパーの既存ハッシュもログイン成功時にArgon2idへ移行される", async ({ page }) => {
    test.setTimeout(240_000);
    const prisma = db();
    const ID = "QA1_argon_migrate_001";
    const PW = "QA1-Bcrypt-Peppered-2026c";
    await prisma.account.deleteMany({ where: { loginId: ID } });
    await prisma.account.create({
      data: {
        loginId: ID,
        role: "R5",
        name: "QA1 アルゴリズム移行試験用",
        status: "active",
        passwordHash: bcryptPeppered(PW), // ペッパーは適用済みだがアルゴリズムが旧（bcrypt）
        mustChangePassword: false,
      },
    });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const after = await prisma.account.findUnique({ where: { loginId: ID } });
      expect(after!.passwordHash.startsWith(ARGON2ID_PREFIX)).toBe(true);
      expect(matchesCurrent(PW, after!.passwordHash)).toBe(true);
      const log = await prisma.auditLog.findFirst({
        where: { actor: ID, action: "password_rehash" },
      });
      expect(log, "アルゴリズム移行が監査記録されること").not.toBeNull();
    } finally {
      await removeAuthTestAccount(ID);
    }
  });

  test("Argon2id+ペッパーのアカウントはそのままログインでき、誤パスワードは拒否される", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const prisma = db();
    const ID = "QA1_pepper_002";
    const PW = "QA1-Pepper-Native-2026b";
    await prisma.account.deleteMany({ where: { loginId: ID } });
    await prisma.account.create({
      data: {
        loginId: ID,
        role: "R5",
        name: "QA1 現行ハッシュ試験用",
        status: "active",
        passwordHash: argon2Peppered(PW),
        mustChangePassword: false,
      },
    });
    try {
      const before = await prisma.account.findUnique({ where: { loginId: ID } });
      await submitLogin(page, ID, `${PW}x`);
      await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      // 既に現行方式（Argon2id + ペッパー）なので再ハッシュは発生しない
      const after = await prisma.account.findUnique({ where: { loginId: ID } });
      expect(after!.passwordHash).toBe(before!.passwordHash);
      const log = await prisma.auditLog.findFirst({
        where: { actor: ID, action: "password_rehash" },
      });
      expect(log).toBeNull();
    } finally {
      await removeAuthTestAccount(ID);
    }
  });

  test("パスワード変更で保存されるハッシュもArgon2id+ペッパーになる", async ({ page }) => {
    test.setTimeout(240_000);
    const prisma = db();
    const ID = "QA1_argon_change_001";
    const PW = "QA1-Argon-Change-2026d";
    const NEW_PW = "QA1-Argon-Changed-2026e";
    await prisma.account.deleteMany({ where: { loginId: ID } });
    await prisma.account.create({
      data: {
        loginId: ID,
        role: "R5",
        name: "QA1 変更後ハッシュ試験用",
        status: "active",
        passwordHash: argon2Peppered(PW),
        mustChangePassword: false,
      },
    });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      await page.goto("/password");
      await page.locator('input[name="current"]').fill(PW);
      await page.locator('input[name="next"]').fill(NEW_PW);
      await page.locator('input[name="confirm"]').fill(NEW_PW);
      const resp = page.waitForResponse((r) => r.request().method() === "POST", {
        timeout: 15_000,
      });
      await page.getByRole("button", { name: "変更する" }).click();
      await resp;
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      const after = await prisma.account.findUnique({ where: { loginId: ID } });
      expect(after!.passwordHash.startsWith(ARGON2ID_PREFIX)).toBe(true);
      expect(matchesCurrent(NEW_PW, after!.passwordHash)).toBe(true);

      // 新パスワードで再ログインできる
      await page.getByRole("button", { name: "ログアウト" }).click();
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      await submitLogin(page, ID, NEW_PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    } finally {
      await removeAuthTestAccount(ID);
    }
  });
});
