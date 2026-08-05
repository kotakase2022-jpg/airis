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
import { hashSync as argon2HashSync, verifySync as argon2VerifySync } from "@node-rs/argon2";
import crypto from "crypto";
import { completeMfaIfNeeded, db } from "./helpers";

const RUN = Date.now();
const REUSE_ERROR = "過去24世代と同じパスワードは使用できません";

// パスワードハッシュ（§2 / §10.3）: 現行方式は Argon2id（OWASP推奨 m=19MiB/t=2/p=1）+ ペッパー。
// ペッパー（PASSWORD_PEPPER_V1）はサーバ側と同じ値がテストプロセスに与えられていれば適用する。
// ※ src/lib/auth.ts と同じ前段ハッシュ（HMAC-SHA256・鍵=ペッパー）
const PEPPER = process.env.PASSWORD_PEPPER_V1 ?? "";
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
function prehash(pw: string): string {
  return PEPPER ? crypto.createHmac("sha256", PEPPER).update(pw, "utf8").digest("hex") : pw;
}
function hashPw(pw: string): string {
  return argon2HashSync(prehash(pw), ARGON2_OPTIONS);
}
// Argon2id / 旧bcrypt、ペッパー有効・無効の全組み合わせ（＝再ハッシュ前後の両方）を
// 許容してパスワード一致を判定する
function matchesPw(pw: string, hash: string): boolean {
  if (hash.startsWith("$argon2")) {
    try {
      return argon2VerifySync(hash, prehash(pw)) || argon2VerifySync(hash, pw);
    } catch {
      return false;
    }
  }
  return bcrypt.compareSync(prehash(pw), hash) || bcrypt.compareSync(pw, hash);
}

// QA13専用アカウント作成（シード行を破壊しない）
async function createAccount(
  loginId: string,
  password: string,
  opts: { role?: string; agencyId?: string; passwordUpdatedAt?: Date } = {}
): Promise<string> {
  await db().account.deleteMany({ where: { loginId } });
  const acc = await db().account.create({
    data: {
      loginId,
      role: opts.role ?? "R5",
      name: `QA13試験用 ${loginId}`,
      status: "active",
      passwordHash: hashPw(password),
      mustChangePassword: false,
      ...(opts.agencyId ? { agencyId: opts.agencyId } : {}),
      ...(opts.passwordUpdatedAt ? { passwordUpdatedAt: opts.passwordUpdatedAt } : {}),
    },
  });
  return acc.id;
}

async function removeAccount(loginId: string) {
  // PasswordHistory / Session は onDelete: Cascade で削除される
  await db().account.deleteMany({ where: { loginId } });
  // 監査ログ・アクセスログは Cascade 対象外なので明示的に後始末する
  // （アクセスログはロック判定/レート制限のカウンタ源のため残すと後続テストに影響する）
  await db().auditLog.deleteMany({ where: { actor: loginId } });
  await db().accessLog.deleteMany({ where: { loginId } });
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
  // MFA画面へ遷移した場合は通過する（失敗ケースは /login に留まるため何もしない）
  try {
    await page.waitForURL(/\/(mfa|dashboard|password)/, { timeout: 2000 });
  } catch {
    return;
  }
  if (page.url().includes("/mfa")) await completeMfaIfNeeded(page, loginId);
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
    expect(matchesPw(P0, acc!.passwordHistory[0].hash)).toBe(true);
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
    expect(matchesPw(P1, acc!.passwordHash)).toBe(true);

    // 未使用のパスワードへは変更できる（正常系）
    await submitPasswordChange(page, P1, P2);
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
    const after = await db().account.findUnique({
      where: { loginId: ID },
      include: { passwordHistory: true },
    });
    expect(matchesPw(P2, after!.passwordHash)).toBe(true);
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
          hash: hashPw(genPw(n)),
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
    expect(matchesPw(genPw(1), acc!.passwordHash)).toBe(true);
    expect(acc!.passwordHistory).toHaveLength(24);
    const remainingIds = acc!.passwordHistory.map((h) => h.id);
    expect(remainingIds).not.toContain(genIds[1]); // 最古から削除
    expect(remainingIds).not.toContain(genIds[2]);
    expect(remainingIds).toContain(genIds[3]);
    expect(remainingIds).toContain(genIds[25]);
    // 直前まで使っていたパスワード（CURRENT）の旧ハッシュが履歴に追加されている
    const newest = acc!.passwordHistory[acc!.passwordHistory.length - 1];
    expect(matchesPw(CURRENT, newest.hash)).toBe(true);
  });
});

// ================================================================
// 3. パスワード有効期限（§4.2: ①②③⑦=90日 / その他=180日）
// ================================================================
test.describe("パスワード有効期限", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

  test("管理者ロール(R3): 91日経過 → ログイン時に/passwordへ誘導・mustChangePassword=true", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const ID = `QA13_exp_adm_${RUN}`;
    const PW = `QA13-Admin-Expired-${RUN}a`; // 20桁以上
    expect(PW.length).toBeGreaterThanOrEqual(20);
    await createAccount(ID, PW, { role: "R3", passwordUpdatedAt: daysAgo(91) });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/password/, { timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "パスワードの変更" })).toBeVisible();

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

// ================================================================
// 4. 実効ロールでのポリシー判定（§4.2 / §14-2）
//    稼働終了代理店（Account.role=R7 + agency.status=closed → 実効⑩）は
//    管理者ポリシー（20桁/90日）ではなく一般ポリシー（14桁/180日）が適用される。
// ================================================================
test.describe("実効ロール（稼働終了代理店=⑩）のパスワードポリシー", () => {
  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000);

  async function closedAgencyId(): Promise<string> {
    const ag = await db().agency.findUnique({ where: { code: "190001" } }); // status=closed
    expect(ag?.status, "190001は稼働終了代理店であること").toBe("closed");
    return ag!.id;
  }
  async function activeAgencyId(): Promise<string> {
    const ag = await db().agency.findUnique({ where: { code: "110001" } });
    expect(ag?.status).toBe("active");
    return ag!.id;
  }

  test("稼働終了代理店の⑦(実効⑩): 91日経過は期限内（180日）→ 通常ログイン", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `QA13_closed_r10_${RUN}`;
    const PW = `QA13-Closed-Agency-${RUN}a`;
    await createAccount(ID, PW, {
      role: "R7",
      agencyId: await closedAgencyId(),
      passwordUpdatedAt: daysAgo(91),
    });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword, "実効⑩は180日ポリシーなので期限内").toBe(false);
    } finally {
      await removeAccount(ID);
    }
  });

  test("稼働中の⑦: 91日経過は期限切れ（90日）→ /passwordへ誘導（対照）", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `QA13_active_r7_${RUN}`;
    const PW = `QA13-Active-Agency-${RUN}b`;
    await createAccount(ID, PW, {
      role: "R7",
      agencyId: await activeAgencyId(),
      passwordUpdatedAt: daysAgo(91),
    });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/password/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(acc!.mustChangePassword).toBe(true);
    } finally {
      await removeAccount(ID);
    }
  });

  test("稼働終了代理店の⑦(実効⑩): パスワード最小桁数は14桁（20桁ではない）", async ({ page }) => {
    test.setTimeout(120_000);
    const ID = `QA13_closed_len_${RUN}`;
    const PW = `QA13-Closed-Len-${RUN}c`;
    await createAccount(ID, PW, { role: "R7", agencyId: await closedAgencyId() });
    try {
      await submitLogin(page, ID, PW);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

      // 13桁 → 一般ポリシーのエラー文言（管理者ポリシーなら「20桁以上」になる）
      const pw13 = "QA13Closed-a1"; // 13桁・大小英数
      expect(pw13.length).toBe(13);
      await submitPasswordChange(page, PW, pw13);
      await expect(page.getByText("パスワードは14桁以上にしてください")).toBeVisible();

      // 14桁 → 変更できる
      const pw14 = "QA13Closed-a1x"; // 14桁・大小英数
      expect(pw14.length).toBe(14);
      await submitPasswordChange(page, PW, pw14);
      await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
      const acc = await db().account.findUnique({ where: { loginId: ID } });
      expect(matchesPw(pw14, acc!.passwordHash)).toBe(true);
    } finally {
      await removeAccount(ID);
    }
  });
});
