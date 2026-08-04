/**
 * QA担当: パスワード有効期限・履歴24世代（§4.2）
 * データプレフィクス: QA13（専用アカウントで実施・後始末込み）
 *
 * - 再利用禁止: 変更時に過去24世代（PasswordHistory）と一致したらエラー
 * - 変更成功時: 旧ハッシュをPasswordHistoryへ保存し、24世代超は古い順に削除
 * - 有効期限: passwordUpdatedAt が期限超過（①②③⑦=90日 / その他=180日）なら
 *   ログイン時に mustChangePassword=true となり /password へ誘導される
 */
import { test, expect, Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { db } from "./helpers";

const RUN = Date.now();
const REUSE_ERROR = "過去24世代と同じパスワードは使用できません";

// QA13専用アカウント作成（シード行を破壊しない）
async function createAccount(
  loginId: string,
  password: string,
  opts: { role?: string; passwordUpdatedAt?: Date } = {}
): Promise<string> {
  await db().account.deleteMany({ where: { loginId } });
  const acc = await db().account.create({
    data: {
      loginId,
      role: opts.role ?? "R5",
      name: `QA13試験用 ${loginId}`,
      status: "active",
      passwordHash: bcrypt.hashSync(password, 10),
      mustChangePassword: false,
      ...(opts.passwordUpdatedAt ? { passwordUpdatedAt: opts.passwordUpdatedAt } : {}),
    },
  });
  return acc.id;
}

async function removeAccount(loginId: string) {
  // PasswordHistory / Session は onDelete: Cascade で削除される
  await db().account.deleteMany({ where: { loginId } });
}

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

async function submitPasswordChange(page: Page, current: string, next: string) {
  await page.goto("/password");
  await page.locator('input[name="current"]').fill(current);
  await page.locator('input[name="next"]').fill(next);
  await page.locator('input[name="confirm"]').fill(next);
  const resp = page.waitForResponse((r) => r.request().method() === "POST", {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "変更する" }).click();
  await resp;
}

// ================================================================
// 1. パスワード履歴（再利用禁止 §4.2）
// ================================================================
test.describe.serial("パスワード履歴: 再利用禁止・履歴保存", () => {
  const ID = `QA13_hist_${RUN}`;
  const P0 = `QA13-Gen-Zero-${RUN}a`; // 一般ロール14桁以上・大小英数
  const P1 = `QA13-Gen-One-${RUN}b`;
  const P2 = `QA13-Gen-Two-${RUN}c`;

  test.beforeAll(async () => {
    await createAccount(ID, P0, { role: "R5" });
  });
  test.afterAll(async () => {
    await removeAccount(ID);
  });

  test("変更成功時に旧ハッシュがPasswordHistoryへ保存される", async ({ page }) => {
    test.setTimeout(120_000);
    await submitLogin(page, ID, P0);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    await submitPasswordChange(page, P0, P1);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    const acc = await db().account.findUnique({
      where: { loginId: ID },
      include: { passwordHistory: true },
    });
    expect(acc!.passwordHistory).toHaveLength(1);
    // 保存されたのは旧パスワード（P0）のハッシュ
    expect(bcrypt.compareSync(P0, acc!.passwordHistory[0].hash)).toBe(true);
    expect(acc!.mustChangePassword).toBe(false);
  });

  test("過去世代（履歴内）のパスワードへは変更できない", async ({ page }) => {
    test.setTimeout(120_000);
    await submitLogin(page, ID, P1);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    // 1世代前（P0）への変更 → エラー
    await submitPasswordChange(page, P1, P0);
    await expect(page.getByText(REUSE_ERROR)).toBeVisible();

    // 現在のパスワード（P1）と同一への変更もエラー（再利用防止）
    await submitPasswordChange(page, P1, P1);
    await expect(page.getByText(REUSE_ERROR)).toBeVisible();

    // DB: パスワードは変わっていない
    const acc = await db().account.findUnique({ where: { loginId: ID } });
    expect(bcrypt.compareSync(P1, acc!.passwordHash)).toBe(true);

    // 未使用のパスワードへは変更できる（正常系）
    await submitPasswordChange(page, P1, P2);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    const after = await db().account.findUnique({
      where: { loginId: ID },
      include: { passwordHistory: true },
    });
    expect(bcrypt.compareSync(P2, after!.passwordHash)).toBe(true);
    expect(after!.passwordHistory).toHaveLength(2);
  });
});

// ================================================================
// 2. 24世代ウィンドウ + 履歴の剪定（24世代超は古い順に削除）
// ================================================================
test.describe.serial("パスワード履歴: 24世代ウィンドウと剪定", () => {
  const ID = `QA13_gen24_${RUN}`;
  const CURRENT = `QA13-Current-Pw-${RUN}x`;
  // 履歴25世代分（gen01が最古 = 25世代前 → 再利用可能になっているはず）
  const genPw = (n: number) => `QA13-History-${RUN}-g${String(n).padStart(2, "0")}`;
  const genIds: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const accountId = await createAccount(ID, CURRENT, { role: "R5" });
    // PasswordHistoryへ25世代を直接シード（gen01が最古・gen25が最新）
    const base = Date.now() - 60 * 60 * 1000;
    for (let n = 1; n <= 25; n++) {
      const row = await db().passwordHistory.create({
        data: {
          accountId,
          hash: bcrypt.hashSync(genPw(n), 10),
          createdAt: new Date(base + n * 60_000),
        },
      });
      genIds[n] = row.id;
    }
  });
  test.afterAll(async () => {
    await removeAccount(ID);
  });

  test("直近24世代内は拒否・25世代前は再利用可・履歴は24世代へ剪定", async ({ page }) => {
    test.setTimeout(180_000);
    await submitLogin(page, ID, CURRENT);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    // 直近の世代（gen25）→ 拒否
    await submitPasswordChange(page, CURRENT, genPw(25));
    await expect(page.getByText(REUSE_ERROR)).toBeVisible();

    // 24世代ウィンドウ内の最古（gen02）→ 拒否
    await submitPasswordChange(page, CURRENT, genPw(2));
    await expect(page.getByText(REUSE_ERROR)).toBeVisible();

    // 25世代前（gen01。ウィンドウ外）→ 変更できる
    await submitPasswordChange(page, CURRENT, genPw(1));
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    // DB検証: 履歴は最新24世代のみ保持（25シード + 旧PW追加 = 26 → 古い順に2件削除）
    const acc = await db().account.findUnique({
      where: { loginId: ID },
      include: { passwordHistory: { orderBy: { createdAt: "asc" } } },
    });
    expect(bcrypt.compareSync(genPw(1), acc!.passwordHash)).toBe(true);
    expect(acc!.passwordHistory).toHaveLength(24);
    const remainingIds = acc!.passwordHistory.map((h) => h.id);
    expect(remainingIds).not.toContain(genIds[1]); // 最古から削除
    expect(remainingIds).not.toContain(genIds[2]);
    expect(remainingIds).toContain(genIds[3]);
    expect(remainingIds).toContain(genIds[25]);
    // 直前まで使っていたパスワード（CURRENT）の旧ハッシュが履歴に追加されている
    const newest = acc!.passwordHistory[acc!.passwordHistory.length - 1];
    expect(bcrypt.compareSync(CURRENT, newest.hash)).toBe(true);
  });
});

// ================================================================
// 3. パスワード有効期限（§4.2: ①②③⑦=90日 / その他=180日）
// ================================================================
test.describe("パスワード有効期限", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

  test("管理者ロール(R3): 91日経過 → ログイン時に/passwordへ誘導・mustChangePassword=true", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `QA13_exp_adm_${RUN}`;
    const PW = `QA13-Admin-Expired-${RUN}a`; // 20桁以上
    expect(PW.length).toBeGreaterThanOrEqual(20);
    await createAccount(ID, PW, { role: "R3", passwordUpdatedAt: daysAgo(91) });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/password/, { timeout: 15_000 });
      await expect(
        page.getByRole("heading", { name: "パスワードの変更" })
      ).toBeVisible();

      // DB: mustChangePassword が立つ
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword).toBe(true);

      // 変更完了まで他機能へ遷移不可（§10.1）
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/password/);

      // 変更すれば解除され /dashboard へ（管理者20桁以上）
      const NEW_PW = `QA13-Admin-Renewed-${RUN}b`;
      expect(NEW_PW.length).toBeGreaterThanOrEqual(20);
      await submitPasswordChange(page, PW, NEW_PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const after = await db().account.findUnique({ where: { loginId: ID } });
      expect(after!.mustChangePassword).toBe(false);
    } finally {
      await removeAccount(ID);
    }
  });

  test("管理者ロール(R3): 89日経過 → 期限内なので通常ログイン", async ({ page }) => {
    const ID = `QA13_ok_adm_${RUN}`;
    const PW = `QA13-Admin-Valid-Pw-${RUN}c`;
    await createAccount(ID, PW, { role: "R3", passwordUpdatedAt: daysAgo(89) });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword).toBe(false);
    } finally {
      await removeAccount(ID);
    }
  });

  test("一般ロール(R5): 91日経過は期限内（180日）→ 通常ログイン", async ({ page }) => {
    const ID = `QA13_ok_gen_${RUN}`;
    const PW = `QA13-Gen-Valid-${RUN}d`;
    await createAccount(ID, PW, { role: "R5", passwordUpdatedAt: daysAgo(91) });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword).toBe(false);
    } finally {
      await removeAccount(ID);
    }
  });

  test("一般ロール(R5): 181日経過 → /passwordへ誘導・mustChangePassword=true", async ({ page }) => {
    const ID = `QA13_exp_gen_${RUN}`;
    const PW = `QA13-Gen-Expired-${RUN}e`;
    await createAccount(ID, PW, { role: "R5", passwordUpdatedAt: daysAgo(181) });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/password/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword).toBe(true);
    } finally {
      await removeAccount(ID);
    }
  });
});
