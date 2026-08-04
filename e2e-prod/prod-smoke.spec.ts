import { test, expect } from "@playwright/test";

// 本番スモーク: 全10ロールのログイン + サイドメニュー構成（§11.1 / §5.2）+ ダッシュボード表示
// 読み取り専用（データ変更なし）。スクリーンショットを証拠として保存。

const PW_ADMIN = "Airis-Demo-Admin-2026!x";
const PW_GENERAL = "Airis-Demo-2026!";

const MENU_ALL = [
  "ダッシュボード",
  "Airisアカウント申請",
  "販売員ID管理",
  "訪販員申請・管理",
  "各種資料の提出",
  "下位代理店",
  "管理画面",
  "ホットライン窓口",
  "消費者センター窓口",
  "窓口案件",
  "お知らせ",
  "ドキュメント",
] as const;

const CASES: {
  role: string;
  loginId: string;
  pw: string;
  menu: string[];
}[] = [
  { role: "R1", loginId: "airis_slb_sys_001", pw: PW_ADMIN, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","下位代理店","管理画面","ホットライン窓口","消費者センター窓口","お知らせ","ドキュメント"] },
  { role: "R2", loginId: "airis_snc_adm_001", pw: PW_ADMIN, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","下位代理店","管理画面","ホットライン窓口","消費者センター窓口","お知らせ","ドキュメント"] },
  { role: "R3", loginId: "airis_snc_ops_0001", pw: PW_ADMIN, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","下位代理店","ホットライン窓口","消費者センター窓口","お知らせ","ドキュメント"] },
  { role: "R4", loginId: "airis_snc_vew_001", pw: PW_GENERAL, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","下位代理店","管理画面","お知らせ","ドキュメント"] },
  { role: "R5", loginId: "airis_snc_spt1_001", pw: PW_GENERAL, menu: ["ダッシュボード","Airisアカウント申請","ホットライン窓口","ドキュメント"] },
  { role: "R6", loginId: "airis_snc_spt2_001", pw: PW_GENERAL, menu: ["ダッシュボード","Airisアカウント申請","消費者センター窓口","ドキュメント"] },
  { role: "R7", loginId: "airis_1110001_001", pw: PW_ADMIN, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","下位代理店","窓口案件","お知らせ","ドキュメント"] },
  { role: "R8", loginId: "airis_2210001_001", pw: PW_GENERAL, menu: ["ダッシュボード","Airisアカウント申請","販売員ID管理","訪販員申請・管理","各種資料の提出","お知らせ","ドキュメント"] },
  { role: "R9", loginId: "110001C001", pw: PW_GENERAL, menu: ["ダッシュボード","各種資料の提出","お知らせ","ドキュメント"] },
  { role: "R10", loginId: "airis_1190001_001", pw: PW_ADMIN, menu: ["ダッシュボード","窓口案件"] },
];

for (const c of CASES) {
  test(`本番: ${c.role} ログイン→ダッシュボード→メニュー構成`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(c.loginId);
    await page.locator('input[name="password"]').fill(c.pw);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

    const nav = page.locator("nav");
    for (const item of c.menu) {
      await expect(nav.getByRole("link", { name: item, exact: true }), `${c.role}: メニュー「${item}」が表示されるべき`).toBeVisible();
    }
    for (const item of MENU_ALL.filter((m) => !c.menu.includes(m))) {
      await expect(nav.getByRole("link", { name: item, exact: true }), `${c.role}: メニュー「${item}」は表示されないべき`).toHaveCount(0);
    }

    await page.screenshot({ path: `../qa/screenshots/prod-${c.role}-dashboard.png`, fullPage: true });
    expect(consoleErrors, "ページエラーが発生しないこと").toEqual([]);
  });
}

test("本番: 未ログインで保護ページ→/loginへリダイレクト", async ({ page }) => {
  await page.goto("/sales-staff");
  await page.waitForURL(/\/login/);
  await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
});

test("本番: cronエンドポイントは認証必須", async ({ request }) => {
  const res = await request.get("/api/cron/daily");
  expect(res.status()).toBe(401);
});

test("本番: 提出物テンプレート6種が配信される", async ({ request }) => {
  for (let i = 1; i <= 6; i++) {
    const res = await request.get(`/templates/template${i}.xlsx`);
    expect(res.status(), `template${i}.xlsx`).toBe(200);
  }
});
