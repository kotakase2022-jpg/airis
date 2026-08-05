// 独立第三者QA（回帰監査）専用の検証スペック。
// 既存スペックは一切変更せず、ここでのみ観測する。使い捨てデータは接頭辞 ZQA を付ける。
import { test, expect } from "@playwright/test";
import { login, db, ACCOUNTS, PW_ADMIN } from "./helpers";

const P = "ZQA";

// ---------------------------------------------------------------------------
// 観点2: 当月KPIカード（変更2）の testid とレイアウト
// ---------------------------------------------------------------------------
test("AUDIT-1: 稼働日報タブ初期表示に data-testid=kpi-current-month が実在するか", async ({
  page,
}) => {
  await login(page, "R9");
  await page.goto("/reports");
  await expect(page.getByText("当月KPI（", { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });

  const html = await page.content();
  const hasAttr = html.includes("kpi-current-month");
  const byTestId = await page.getByTestId("kpi-current-month").count();
  const tilesPageWide = await page.locator("div.rounded-xl.bg-slate-50.text-center").count();
  const headings = await page.getByText("当月KPI（", { exact: false }).allTextContents();

  console.log(
    JSON.stringify(
      {
        AUDIT1: {
          testidAttrPresentInHtml: hasAttr,
          getByTestIdCount: byTestId,
          pageWideTileCount: tilesPageWide,
          kpiHeadings: headings,
        },
      },
      null,
      2
    )
  );
});

test("AUDIT-2: 当月KPIカードのタイル内容（訪販12 / テレマ8）と横スクロール（375x812）", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "R9");
  await page.goto("/reports");
  await expect(page.getByText("当月KPI（", { exact: false }).first()).toBeVisible({
    timeout: 15_000,
  });

  const labels = await page
    .locator("div.rounded-xl.bg-slate-50.text-center div.text-\\[11px\\]")
    .allTextContents();
  const values = await page
    .locator("div.rounded-xl.bg-slate-50.text-center div.text-base")
    .allTextContents();

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  console.log(
    JSON.stringify({ AUDIT2: { labelCount: labels.length, labels, values, overflow } }, null, 2)
  );
});

// ---------------------------------------------------------------------------
// 観点6: e2e/14-file-access.spec.ts が受け入れる [403,302,307] の実測値
// ---------------------------------------------------------------------------
test("AUDIT-3: mustChangePassword=true でのCSVルート実測ステータス", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  const MCP_ID = `${P}_mustchange_001`;
  const src = await d.account.findUnique({ where: { loginId: ACCOUNTS.R7.loginId } });
  expect(src, "⑦のシードアカウントが存在すること").toBeTruthy();
  await d.account.deleteMany({ where: { loginId: MCP_ID } });
  await d.account.create({
    data: {
      loginId: MCP_ID,
      role: "R7",
      name: `${P} 初回変更未完了`,
      agencyId: src!.agencyId,
      status: "active",
      passwordHash: src!.passwordHash,
      pepperVersion: src!.pepperVersion,
      mfaSecret: src!.mfaSecret,
      mfaEnabled: false,
      mustChangePassword: true,
    },
  });
  try {
    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(MCP_ID);
    await page.locator('input[name="password"]').fill(PW_ADMIN);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/(password|mfa)/, { timeout: 20_000 });

    const results: Record<string, { status: number; body: string }> = {};
    for (const path of [
      "/reports/csv?template=visit",
      "/hotline/csv",
      "/consumer-center/csv",
      "/admin/csv",
    ]) {
      const res = await page.request.get(path, { maxRedirects: 0 });
      results[path] = {
        status: res.status(),
        body: (await res.text()).slice(0, 120).replace(/\s+/g, " "),
      };
    }
    console.log(JSON.stringify({ AUDIT3: { url: page.url(), results } }, null, 2));
  } finally {
    await d.account.deleteMany({ where: { loginId: MCP_ID } });
  }
});
