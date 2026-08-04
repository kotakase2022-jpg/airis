// QA担当: 認証（§4.2, §10.1, §13）
// データプレフィクス: QA1
import { test, expect, Page } from "@playwright/test";
import {
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
// 3. アカウントロック（30分間に10回失敗 → ロック §4.2 / SEC②#12）
//    専用アカウントを db() で作成（passwordHash は既存⑧からコピー = PW_GENERAL）
// ================================================================
test.describe("アカウントロック", () => {
  const LOCK_ID = "QA1_lock_001";

  test("10回失敗でロック → ロックメッセージ → リセットで復旧", async ({ page }) => {
    test.setTimeout(240_000);
    const prisma = db();
    const src = await prisma.account.findUnique({
      where: { loginId: ACCOUNTS.R8.loginId },
    });
    expect(src).toBeTruthy();
    await prisma.account.deleteMany({ where: { loginId: LOCK_ID } });
    await prisma.account.create({
      data: {
        loginId: LOCK_ID,
        role: "R8",
        name: "QA1 ロック試験用",
        agencyId: src!.agencyId,
        status: "active",
        passwordHash: src!.passwordHash, // = PW_GENERAL
        mustChangePassword: false,
      },
    });
    try {
      // 10回連続で誤パスワード
      for (let i = 0; i < 10; i++) {
        await submitLogin(page, LOCK_ID, "QA1-Wrong-Pass-999!!");
        await expect(page.getByText(GENERIC_LOGIN_ERROR)).toBeVisible();
      }
      // DB: failedAttempts=10 かつ lockedUntil がセットされていること
      const locked = await prisma.account.findUnique({ where: { loginId: LOCK_ID } });
      expect(locked?.failedAttempts).toBeGreaterThanOrEqual(10);
      expect(locked?.lockedUntil).not.toBeNull();
      expect(locked!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

      // 正しいパスワードでもロックメッセージが出てログインできない
      await submitLogin(page, LOCK_ID, PW_GENERAL);
      await expect(page.getByText(LOCK_ERROR)).toBeVisible();
      expect(page.url()).toContain("/login");

      // resetAccountAuthState で復元 → ログイン成功
      await resetAccountAuthState(LOCK_ID);
      await submitLogin(page, LOCK_ID, PW_GENERAL);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    } finally {
      await resetAccountAuthState(LOCK_ID);
      await prisma.account.deleteMany({ where: { loginId: LOCK_ID } }); // sessionsはonDelete:Cascade
    }
  });
});

// ================================================================
// 4. 未ログイン時の保護ページアクセス → /login リダイレクト
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
// 5. ログアウト → /login、その後の保護ページアクセスも /login
// ================================================================
test("ログアウト → /login → 保護ページ再アクセスも /login（セッション破棄）", async ({ page }) => {
  await login(page, "R9");
  await expect(page).toHaveURL(/\/dashboard/);
  // ログアウト前のセッショントークンを控える
  const cookieBefore = (await page.context().cookies()).find(
    (c) => c.name === "airis_session"
  );
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
// 6. パスワード変更画面（§4.2: 管理者20桁 / 一般14桁）
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
  }

  async function submitPasswordChange(
    page: Page,
    current: string,
    next: string,
    confirm: string
  ) {
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

      // 現在パスワード誤り
      await submitPasswordChange(page, "Wrong-Current-123!", "QA1-NewPassword-14aA", "QA1-NewPassword-14aA");
      await expect(page.getByText("現在のパスワードが正しくありません")).toBeVisible();

      // 新パスワード不一致
      await submitPasswordChange(page, PW_GENERAL, "QA1-NewPassword-14aA", "QA1-NewPassword-14aB");
      await expect(page.getByText("新しいパスワードが一致しません")).toBeVisible();

      // 桁数不足（13桁・大小英数含む）→ 一般は14桁必須
      await submitPasswordChange(page, PW_GENERAL, "Abcdef123456!", "Abcdef123456!");
      await expect(page.getByText("パスワードは14桁以上にしてください")).toBeVisible();

      // DB: パスワードが変わっていないこと
      const acc = await db().account.findUnique({ where: { loginId: GEN_ID } });
      const src = await db().account.findUnique({ where: { loginId: ACCOUNTS.R5.loginId } });
      expect(acc?.passwordHash).toBe(src?.passwordHash);
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
// 7. /api/cron/daily の認証（Bearer CRON_SECRET=qa-test-secret）
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
