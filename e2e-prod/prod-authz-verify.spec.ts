// 本番環境での是正確認（QA loop3 の critical / major 修正が本番で有効か）。
//
// 読み取り＋UI表示の確認のみ。**本番データを書き換える操作は一切行わない**
// （リセット・停止・削除などの実行はしない。ボタンが出ないことの確認に留める）。
// 認証情報とMFA通過の手順は prod-smoke.spec.ts と同じ方式（秘密鍵は本番DBから読む）。
import { test, expect, Page } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const PW_ADMIN = "Airis-Demo-Admin-2026!x";
const R1_LOGIN = "airis_slb_sys_001";
const R3_LOGIN = "airis_snc_ops_0001";

let _db: PrismaClient | null = null;
function db(): PrismaClient {
  if (!_db) {
    const url = fs
      .readFileSync(".env.local", "utf8")
      .match(/^DATABASE_URL_UNPOOLED="?([^"\r\n]+)/m)![1];
    _db = new PrismaClient({ datasourceUrl: url });
  }
  return _db;
}

test.afterAll(async () => {
  await _db?.$disconnect();
});

async function login(page: Page, loginId: string, pw: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(pw);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/(dashboard|password|mfa)/, { timeout: 30_000 });
  if (!page.url().includes("/mfa")) return;
  const acc = await db().account.findUnique({ where: { loginId } });
  expect(acc?.mfaSecret, `${loginId}: 秘密鍵が発行済みであること`).toBeTruthy();
  await page.locator('input[name="code"]').fill(generateSync({ secret: acc!.mfaSecret! }));
  await page.getByRole("button", { name: /登録して続行|認証する/ }).click();
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 30_000 });
}

test("本番: ③は①アカウントのリセットボタンが見えない（critical BUG-L01 の是正確認）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, R3_LOGIN, PW_ADMIN);
  // 発注者指示（OWN-014）どおり③は管理画面に入れる
  await page.goto("/admin");
  expect(new URL(page.url()).pathname, "③が管理画面に入れない").toBe("/admin");

  // ①の行にはリセットボタンが出ない（職務分離 §6.1-3）
  await page.goto(`/admin?q=${encodeURIComponent(R1_LOGIN)}`);
  const row = page.locator("tbody tr", { hasText: R1_LOGIN }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const buttons = (await row.locator("button").allInnerTexts()).map((s) => s.trim());
  console.log(`[prod] ③が見る①の行のボタン: ${JSON.stringify(buttons)}`);
  expect(buttons, "本番で③に①のPWリセットが見えている").not.toContain("PWリセット");
  expect(buttons, "本番で③に①のMFAリセットが見えている").not.toContain("MFAリセット");
});

test("本番: 当月KPIが稼働日報タブの初期表示に出る（§7.5 一覧・集計画面に表示）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, R1_LOGIN, PW_ADMIN);
  await page.goto("/reports");
  const card = page.getByTestId("kpi-current-month");
  await expect(card, "当月KPIカードが表示されていない").toBeVisible({ timeout: 20_000 });
  // 原本準拠の指標が揃っている（訪販12 + テレマ8。獲得生産性・後確通過率は本ループで追加）
  for (const label of ["生産性", "進捗", "ペースメーカー", "訪問/日", "獲得生産性", "後確通過率"]) {
    await expect(card.getByText(label, { exact: true }), `${label} が無い`).toBeVisible();
  }
  // ペースメーカーは率表示（原本 J7 の書式が 0%）
  const paceTile = card.locator("div.rounded-xl").filter({ hasText: "ペースメーカー" }).first();
  const text = (await paceTile.innerText()).replace(/\s+/g, " ");
  console.log(`[prod] ペースメーカーのタイル: ${JSON.stringify(text)}`);
  expect(text, "ペースメーカーが率表示になっていない").toMatch(/%/);
});

test("本番: CSV出力系のRoute Handlerは未認証で到達できない", async ({ page }) => {
  for (const path of ["/reports/csv?template=visit", "/hotline/csv", "/consumer-center/csv"]) {
    const res = await page.request.get(path, { maxRedirects: 0 });
    console.log(`[prod] 未認証 GET ${path} -> ${res.status()}`);
    expect([401, 403, 302, 307], `${path} が未認証で到達可能`).toContain(res.status());
  }
});
