// QA担当: MFA（TOTP §4.2 / 発注者指示 2026-08-05）
// - 必須ロール（⑨以外）は初回ログイン時にQRコードで強制登録（推奨: Google Authenticator）
// - ⑨販売員は利用任意（未登録ならパスワードのみでログイン、サイドバーから任意登録）
// - 登録済みアカウントはログイン第2段階でコード検証
// - コード連続失敗でセッション破棄 / 管理者によるMFAリセット
//
// 各テストは冒頭で対象アカウントのMFA状態を自前で整えるため、実行順に依存しない。
// 使用アカウント: シードのMFAデモ用（airis_snc_adm_002〜006 / 110001C101）
import { test, expect, Page } from "@playwright/test";
import { generateSync } from "otplib";
import { ACCOUNTS, PW_ADMIN, PW_GENERAL, TEST_MFA_SECRET, db, login } from "./helpers";

const ENROLL_ID = "airis_snc_adm_002"; // 強制登録フロー
const RESET_ID = "airis_snc_adm_003"; // 管理者リセット
const VERIFY_ID = "airis_snc_adm_004"; // コード検証
const GUARD_ID = "airis_snc_adm_005"; // MFA未完了セッションのfail-closed
const LOCKOUT_ID = "airis_snc_adm_006"; // 連続失敗
const R9_ID = "110001C101"; // ⑨任意登録

async function submitLogin(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

// コード送信。エラー文言は次の送信まで表示されたままなので、
// 「前回のエラーを見て先へ進む」競合を避けるため server action の応答まで必ず待つ。
async function fillCode(page: Page, code: string) {
  await page.locator('input[name="code"]').fill(code);
  const resp = page.waitForResponse((r) => r.request().method() === "POST", {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /登録して続行|認証する/ }).click();
  await resp;
}

async function currentCode(loginId: string): Promise<string> {
  const acc = await db().account.findUnique({ where: { loginId } });
  expect(acc?.mfaSecret, `${loginId} の秘密鍵が発行済みであること`).toBeTruthy();
  return generateSync({ secret: acc!.mfaSecret! });
}

// 現在の正コードとは必ず異なる6桁（1/10^6の偶然一致を排除して誤コード検証を決定的にする）
function wrongCodeFor(valid: string): string {
  const next = (Number(valid) + 1) % 1_000_000;
  return String(next).padStart(6, "0");
}

// 対象アカウントを「MFA未登録」に戻す（認証系ログ・カウンタも初期化）
async function setUnregistered(loginId: string) {
  await db().account.updateMany({
    where: { loginId },
    data: { mfaEnabled: false, mfaSecret: null, failedAttempts: 0, lockedUntil: null },
  });
  await db().accessLog.deleteMany({ where: { loginId } });
  await db().auditLog.deleteMany({ where: { actor: loginId } });
}

// 対象アカウントを「既知の秘密鍵で登録済み」にする
async function setRegistered(loginId: string) {
  await db().account.updateMany({
    where: { loginId },
    data: {
      mfaEnabled: true,
      mfaSecret: TEST_MFA_SECRET,
      failedAttempts: 0,
      lockedUntil: null,
    },
  });
  await db().accessLog.deleteMany({ where: { loginId } });
  await db().auditLog.deleteMany({ where: { actor: loginId } });
}

// ================================================================
// 1. 必須ロールの初回ログイン → QRコードで強制登録
// ================================================================
test("必須ロール(②)未登録: ログイン → /mfa/setup（QR + 推奨:Google Authenticator）→ 誤コード拒否 → 正コードで登録完了", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setUnregistered(ENROLL_ID);

  await submitLogin(page, ENROLL_ID, PW_ADMIN);
  await page.waitForURL(/\/mfa\/setup/, { timeout: 15_000 });

  // QRコード画像と案内文言（発注者指示: 「推奨：Google Authenticator」を掲出）
  await expect(page.getByAltText("MFA登録用QRコード")).toBeVisible();
  await expect(page.getByText("推奨：Google Authenticator")).toBeVisible();
  const shownSecret = (await page.getByTestId("mfa-secret").textContent())?.trim();
  expect(shownSecret).toBeTruthy();

  // 画面表示とDBの秘密鍵が一致し、コード確認まで有効化されない
  const acc = await db().account.findUnique({ where: { loginId: ENROLL_ID } });
  expect(acc?.mfaSecret).toBe(shownSecret);
  expect(acc?.mfaEnabled).toBe(false);

  // 誤コードは拒否される
  await fillCode(page, wrongCodeFor(generateSync({ secret: shownSecret! })));
  await expect(page.getByText("認証コードが正しくありません", { exact: false })).toBeVisible();
  expect((await db().account.findUnique({ where: { loginId: ENROLL_ID } }))?.mfaEnabled).toBe(false);

  // 正しいコードで登録完了 → ダッシュボード
  await fillCode(page, generateSync({ secret: shownSecret! }));
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

  expect((await db().account.findUnique({ where: { loginId: ENROLL_ID } }))?.mfaEnabled).toBe(true);
  const enrollLog = await db().auditLog.findFirst({
    where: { actor: ENROLL_ID, action: "mfa_enroll", result: "success" },
  });
  expect(enrollLog).not.toBeNull();
});

// ================================================================
// 2. 登録済みアカウントの再ログイン → コード検証
// ================================================================
test("登録済み(②): ログイン → /mfa 検証 → 誤コード拒否 → 正コードで /dashboard", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setRegistered(VERIFY_ID);

  await submitLogin(page, VERIFY_ID, PW_ADMIN);
  await page.waitForURL(/\/mfa$/, { timeout: 15_000 });
  await expect(page.getByText("推奨：Google Authenticator", { exact: false })).toBeVisible();

  const valid = await currentCode(VERIFY_ID);
  await fillCode(page, wrongCodeFor(valid));
  await expect(page.getByText("認証コードが正しくありません")).toBeVisible();
  await expect(page).toHaveURL(/\/mfa$/);

  await fillCode(page, await currentCode(VERIFY_ID));
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
});

// ================================================================
// 3. MFA未完了セッションは保護ページへ入れない（fail-closed）
// ================================================================
test("MFA未完了のまま保護ページへ直行 → 未ログイン扱いで /login", async ({ page }) => {
  test.setTimeout(60_000);
  await setRegistered(GUARD_ID);

  await submitLogin(page, GUARD_ID, PW_ADMIN);
  await page.waitForURL(/\/mfa$/, { timeout: 15_000 });

  await page.goto("/dashboard");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await page.goto("/admin");
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  // MFA未完了の間はログイン成功として記録されない（§3.3）
  const success = await db().accessLog.count({
    where: { loginId: GUARD_ID, result: "success" },
  });
  expect(success).toBe(0);
});

// ================================================================
// 4. コード連続失敗（5回）でセッション破棄 → ログインからやり直し
// ================================================================
test("検証コード5回失敗 → セッション破棄 → /login（失敗はアクセスログにも記録）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setRegistered(LOCKOUT_ID);

  await submitLogin(page, LOCKOUT_ID, PW_ADMIN);
  await page.waitForURL(/\/mfa$/, { timeout: 15_000 });
  const bad = wrongCodeFor(await currentCode(LOCKOUT_ID));

  for (let i = 0; i < 4; i++) {
    await fillCode(page, bad);
    await expect(page.getByText("認証コードが正しくありません")).toBeVisible();
  }
  // 5回目でセッション破棄 → /login へ
  await fillCode(page, bad);
  await page.waitForURL(/\/login/, { timeout: 15_000 });

  const fails = await db().accessLog.count({
    where: { loginId: LOCKOUT_ID, result: "failure", reason: "mfa_bad_code" },
  });
  expect(fails).toBe(5);

  // セッションが破棄されている（保護ページへ入れない）
  await page.goto("/dashboard");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
});

// ================================================================
// 5. ⑨販売員はMFA利用任意（§4.2）
// ================================================================
test("⑨未登録: パスワードのみで /dashboard（強制されない）→ サイドバーから任意登録 → 以後はコード必須", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await setUnregistered(R9_ID);

  // 未登録の⑨はMFAを要求されない
  await submitLogin(page, R9_ID, PW_GENERAL);
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

  // サイドバーの任意登録リンクから登録
  const link = page.getByRole("link", { name: "MFA設定（推奨）" });
  await expect(link).toBeVisible();
  await link.click();
  await page.waitForURL(/\/mfa\/setup/, { timeout: 15_000 });
  await expect(page.getByText("推奨：Google Authenticator")).toBeVisible();
  await fillCode(page, await currentCode(R9_ID));
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  expect((await db().account.findUnique({ where: { loginId: R9_ID } }))?.mfaEnabled).toBe(true);

  // 登録後はログインにコードが必須になる
  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await submitLogin(page, R9_ID, PW_GENERAL);
  await page.waitForURL(/\/mfa$/, { timeout: 15_000 });
  await fillCode(page, await currentCode(R9_ID));
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
});

// ================================================================
// 6. 管理者によるMFAリセット（認証アプリ紛失時 §4.2）
// ================================================================
test("②の管理画面からMFAリセット → 対象者は次回ログインで再登録", async ({ page }) => {
  test.setTimeout(90_000);
  await setRegistered(RESET_ID);

  await login(page, "R2");
  // 一覧は50件/ページのため検索で対象行に絞る
  await page.goto(`/admin?q=${RESET_ID}`);
  // 同じloginIdは監査ログ表にも現れるため、操作ボタンを持つ行（アカウント一覧）に限定する
  const row = page
    .locator("tr")
    .filter({ hasText: RESET_ID })
    .filter({ has: page.getByRole("button", { name: "MFAリセット" }) });
  await expect(row).toHaveCount(1);
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "MFAリセット" }).click();
  await expect(
    page.getByText(`${RESET_ID} のMFAをリセットしました`, { exact: false })
  ).toBeVisible({ timeout: 15_000 });

  const acc = await db().account.findUnique({ where: { loginId: RESET_ID } });
  expect(acc?.mfaEnabled).toBe(false);
  expect(acc?.mfaSecret).toBeNull();
  const auditRow = await db().auditLog.findFirst({
    where: { actor: ACCOUNTS.R2.loginId, action: "mfa_reset", target: RESET_ID },
  });
  expect(auditRow).not.toBeNull();

  // 対象者の次回ログインは登録画面から（新しい秘密鍵が発行される）
  await page.context().clearCookies();
  await submitLogin(page, RESET_ID, PW_ADMIN);
  await page.waitForURL(/\/mfa\/setup/, { timeout: 15_000 });
  await expect(page.getByAltText("MFA登録用QRコード")).toBeVisible();
  const newSecret = (await page.getByTestId("mfa-secret").textContent())?.trim();
  expect(newSecret).not.toBe(TEST_MFA_SECRET);
});
