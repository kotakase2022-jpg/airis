import { Page, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { generateSync } from "otplib";

// ===== MFA（§4.2）=====
// シード済みアカウントは global-setup で既知の秘密鍵を事前登録し、ログイン時のTOTPを
// このヘルパーで生成する。テスト中に新規作成されたアカウントは初回ログインで登録画面に
// なるため、DBから秘密鍵（ページ表示時に発行済み）を読んでコードを生成する。
export const TEST_MFA_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

// ===== テストアカウント（prisma/seed.ts 準拠） =====
export const PW_ADMIN = "Airis-Demo-Admin-2026!x"; // ①②③⑦（20桁以上）
export const PW_GENERAL = "Airis-Demo-2026!"; // ④⑤⑥⑧⑨⑩（14桁以上）

export const ACCOUNTS = {
  R1: { loginId: "airis_slb_sys_001", pw: PW_ADMIN, label: "サスラボシステム管理" },
  R2: { loginId: "airis_snc_adm_001", pw: PW_ADMIN, label: "SNC管理者" },
  R3: { loginId: "airis_snc_ops_0001", pw: PW_ADMIN, label: "SNC運用者" },
  R4: { loginId: "airis_snc_vew_001", pw: PW_GENERAL, label: "SNC閲覧" },
  R5: { loginId: "airis_snc_spt1_001", pw: PW_GENERAL, label: "HL窓口" },
  R6: { loginId: "airis_snc_spt2_001", pw: PW_GENERAL, label: "消セン窓口" },
  R7: { loginId: "airis_1110001_001", pw: PW_ADMIN, label: "1次店管理者" },
  R8: { loginId: "airis_2210001_001", pw: PW_GENERAL, label: "2次店管理者" },
  R9: { loginId: "110001C001", pw: PW_GENERAL, label: "販売員" },
  R10: { loginId: "airis_1190001_001", pw: PW_ADMIN, label: "稼働終了代理店(⑦→⑩)" },
} as const;

export type RoleKey = keyof typeof ACCOUNTS;

// ===== DB検証用クライアント（オーナー接続=BYPASSRLS。テストのassert/準備専用） =====
let _db: PrismaClient | null = null;
export function db(): PrismaClient {
  if (!_db) {
    _db = new PrismaClient({
      datasourceUrl: "postgresql://postgres:postgres@localhost:5433/airis",
    });
  }
  return _db;
}

// ===== ログイン =====
// ログイン直後の遷移先が /mfa（検証）または /mfa/setup（初回登録）なら、
// DBの秘密鍵からTOTPコードを生成して通過する。⑨未登録などMFA無しならそのまま返る。
export async function completeMfaIfNeeded(page: Page, loginId: string): Promise<void> {
  await page.waitForURL(/\/(dashboard|password|mfa)/, { timeout: 15_000 });
  if (!/\/mfa(\/|$|\?)/.test(new URL(page.url()).pathname + "/")) return;
  // 登録画面の表示時点で mfaSecret はDBに発行済み（リロードでも不変）
  const acc = await db().account.findUnique({ where: { loginId } });
  if (!acc?.mfaSecret) throw new Error(`MFA secret not found for ${loginId}`);
  await page.locator('input[name="code"]').fill(generateSync({ secret: acc.mfaSecret }));
  await page.getByRole("button", { name: /登録して続行|認証する/ }).click();
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 15_000 });
}

export async function login(page: Page, role: RoleKey): Promise<void> {
  const acc = ACCOUNTS[role];
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(acc.loginId);
  await page.locator('input[name="password"]').fill(acc.pw);
  await page.getByRole("button", { name: "ログイン" }).click();
  await completeMfaIfNeeded(page, acc.loginId);
}

export async function loginExpectDashboard(page: Page, role: RoleKey): Promise<void> {
  await login(page, role);
  await expect(page).toHaveURL(/\/dashboard/);
}

// ===== コンソールエラー収集（各テストで有効化して最後にassert） =====
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

// 無害なエラー（favicon 404等）を除外して重大エラーのみ返す
export function criticalErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !/favicon|404.*\.ico|net::ERR_ABORTED.*\.ico/i.test(e)
  );
}

// ===== 認証系テスト用: アカウント状態のリセット =====
export async function resetAccountAuthState(loginId: string): Promise<void> {
  await db().account.updateMany({
    where: { loginId },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}
