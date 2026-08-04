// QA担当: ナビゲーション・権限マトリクス（§5.2, §11.1, §13）
// データプレフィクス: QA1
import { test, expect } from "@playwright/test";
import {
  ACCOUNTS,
  RoleKey,
  db,
  login,
  collectConsoleErrors,
  criticalErrors,
} from "./helpers";

// ---------------------------------------------------------------
// サイドメニュー表示マトリクス（§11.1 の11項目 + 窓口案件）
// ---------------------------------------------------------------
const M = {
  dashboard: "ダッシュボード",
  accountRequests: "Airisアカウント申請",
  salesStaff: "販売員ID管理",
  fieldAgents: "訪販員申請・管理",
  reports: "各種資料の提出",
  agencies: "下位代理店",
  admin: "管理画面",
  hotline: "ホットライン窓口",
  consumerCenter: "消費者センター窓口",
  agencyCases: "窓口案件",
  announcements: "お知らせ",
  documents: "ドキュメント",
} as const;

const EXPECTED_MENU: Record<RoleKey, string[]> = {
  // ①: 11項目すべて（窓口案件は⑦⑩専用のため出ない）
  R1: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.agencies, M.admin, M.hotline, M.consumerCenter, M.announcements, M.documents],
  // ②: ①と同じ
  R2: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.agencies, M.admin, M.hotline, M.consumerCenter, M.announcements, M.documents],
  // ③: 管理画面なし（§5.2 Airisアカウント管理=×）
  R3: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.agencies, M.hotline, M.consumerCenter, M.announcements, M.documents],
  // ④: ダミー表示ページ群 + 申請。窓口2種は×（§5.2）
  R4: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.agencies, M.admin, M.announcements, M.documents],
  // ⑤: ダッシュボード/申請/ホットライン/ドキュメント
  R5: [M.dashboard, M.accountRequests, M.hotline, M.documents],
  // ⑥: ダッシュボード/申請/消費者センター/ドキュメント
  R6: [M.dashboard, M.accountRequests, M.consumerCenter, M.documents],
  // ⑦: 窓口2つの代わりに統合「窓口案件」（§11.1）
  R7: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.agencies, M.agencyCases, M.announcements, M.documents],
  // ⑧: 下位代理店なし・窓口なし
  R8: [M.dashboard, M.accountRequests, M.salesStaff, M.fieldAgents, M.reports, M.announcements, M.documents],
  // ⑨: ダッシュボード/各種資料の提出/お知らせ/ドキュメントのみ
  R9: [M.dashboard, M.reports, M.announcements, M.documents],
  // ⑩: ダッシュボード + 窓口案件のみ
  R10: [M.dashboard, M.agencyCases],
};

test.describe("サイドメニュー表示マトリクス（§11.1）", () => {
  for (const role of Object.keys(ACCOUNTS) as RoleKey[]) {
    test(`${role}(${ACCOUNTS[role].label}) のメニュー項目`, async ({ page }) => {
      const errors = collectConsoleErrors(page);
      await login(page, role);
      await expect(page).toHaveURL(/\/dashboard/);
      const items = (await page.locator("aside nav a").allInnerTexts()).map((t) => t.trim());
      // 出るべき項目 / 出てはいけない項目を過不足なく検証
      expect(items.sort()).toEqual([...EXPECTED_MENU[role]].sort());
      expect(criticalErrors(errors)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------
// URL直接アクセスの権限制御（§5.2）: 全ロール×全12ルート
// 権限なし → /dashboard へリダイレクト
// ---------------------------------------------------------------
const ROUTES = [
  "/account-requests",
  "/sales-staff",
  "/field-agents",
  "/reports",
  "/agencies",
  "/admin",
  "/hotline",
  "/consumer-center",
  "/agency-cases",
  "/announcements",
  "/documents",
  "/notifications",
] as const;

// §5.2 + §11.1 準拠の許可マトリクス（④はダミー表示だがアクセス自体は可。
// /notifications は通知ベル（§3.7）のため全ロール可）
const ALLOWED: Record<RoleKey, string[]> = {
  R1: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/agencies", "/admin", "/hotline", "/consumer-center", "/announcements", "/documents", "/notifications"],
  R2: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/agencies", "/admin", "/hotline", "/consumer-center", "/announcements", "/documents", "/notifications"],
  R3: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/agencies", "/hotline", "/consumer-center", "/announcements", "/documents", "/notifications"],
  R4: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/agencies", "/admin", "/announcements", "/documents", "/notifications"],
  R5: ["/account-requests", "/hotline", "/documents", "/notifications"],
  R6: ["/account-requests", "/consumer-center", "/documents", "/notifications"],
  R7: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/agencies", "/agency-cases", "/announcements", "/documents", "/notifications"],
  R8: ["/account-requests", "/sales-staff", "/field-agents", "/reports", "/announcements", "/documents", "/notifications"],
  R9: ["/reports", "/announcements", "/documents", "/notifications"],
  R10: ["/agency-cases", "/notifications"],
};

test.describe("URL直接アクセス権限マトリクス（§5.2）", () => {
  for (const role of Object.keys(ACCOUNTS) as RoleKey[]) {
    test(`${role}(${ACCOUNTS[role].label}) × 全12ルート`, async ({ page }) => {
      test.setTimeout(180_000);
      await login(page, role);
      await expect(page).toHaveURL(/\/dashboard/);
      const allowed = new Set(ALLOWED[role]);
      for (const route of ROUTES) {
        await page.goto(route);
        if (allowed.has(route)) {
          await expect(
            page,
            `${role} は ${route} にアクセスできるはず`
          ).toHaveURL(new RegExp(route.replace(/\//g, "\\/")), { timeout: 15_000 });
        } else {
          await expect(
            page,
            `${role} の ${route} へのアクセスは /dashboard へリダイレクトされるはず`
          ).toHaveURL(/\/dashboard/, { timeout: 15_000 });
        }
      }
    });
  }
});

// 権限外アクセスは監査ログ（access_denied）にも記録される（§3.3）
test("権限外アクセスの監査ログ: R9 → /admin で access_denied が記録される", async ({ page }) => {
  const prisma = db();
  const before = await prisma.auditLog.count({
    where: { actor: ACCOUNTS.R9.loginId, action: "access_denied" },
  });
  await login(page, "R9");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  await expect
    .poll(
      async () =>
        prisma.auditLog.count({
          where: { actor: ACCOUNTS.R9.loginId, action: "access_denied" },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(before);
});

// ---------------------------------------------------------------
// CSVルートの直接アクセス制御
// 権限外ロール → リダイレクトまたは4xx（200+CSV本文が返らないこと）
// ---------------------------------------------------------------
test.describe("CSVルートのアクセス制御", () => {
  test("R2: /admin/csv?type=inventory → 200 + CSV本文（正常系）", async ({ page }) => {
    await login(page, "R2");
    const r = await page.request.get("/admin/csv?type=inventory");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"] ?? "").toContain("csv");
    const body = await r.text();
    expect(body).toContain("ログインID");
    expect(body).toContain("airis_slb_sys_001");
  });

  test("R3: /admin/csv?type=inventory → 403（管理画面は①②のみ §5.2）", async ({ page }) => {
    await login(page, "R3");
    const r = await page.request.get("/admin/csv?type=inventory", { maxRedirects: 0 });
    expect(r.status()).toBeGreaterThanOrEqual(300);
    expect(r.status()).toBeLessThan(500);
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("R9: /admin/csv?type=audit → 4xx/リダイレクト（CSV本文なし）", async ({ page }) => {
    await login(page, "R9");
    const r = await page.request.get("/admin/csv?type=audit", { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("未認証: /admin/csv → 401", async ({ request }) => {
    const r = await request.get("/admin/csv?type=inventory", { maxRedirects: 0 });
    expect(r.status()).toBe(401);
  });

  test("R7: /sales-staff/csv/list → 200 + CSV本文（正常系）", async ({ page }) => {
    await login(page, "R7");
    const r = await page.request.get("/sales-staff/csv/list");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"] ?? "").toContain("csv");
    const body = await r.text();
    expect(body).toContain("販売員ID");
  });

  test("R9: /sales-staff/csv/list → リダイレクト（CSV本文なし）", async ({ page }) => {
    await login(page, "R9");
    const r = await page.request.get("/sales-staff/csv/list", { maxRedirects: 0 });
    expect([301, 302, 303, 307, 308, 401, 403]).toContain(r.status());
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
    if (r.status() >= 300 && r.status() < 400) {
      expect(r.headers()["location"] ?? "").toContain("/dashboard");
    }
  });

  test("R5: /sales-staff/csv/gigacc → リダイレクト/4xx（CSV本文なし）", async ({ page }) => {
    await login(page, "R5");
    const r = await page.request.get("/sales-staff/csv/gigacc", { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("R10: /sales-staff/csv/template → リダイレクト/4xx（CSV本文なし）", async ({ page }) => {
    await login(page, "R10");
    const r = await page.request.get("/sales-staff/csv/template", { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("R9: /field-agents/csv → 403（訪販員は⑨=× §5.2）", async ({ page }) => {
    await login(page, "R9");
    const r = await page.request.get("/field-agents/csv", { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("R5: /reports/csv?template=visit → 403（日報は⑤=× §5.2）", async ({ page }) => {
    await login(page, "R5");
    const r = await page.request.get("/reports/csv?template=visit", { maxRedirects: 0 });
    expect(r.status()).not.toBe(200);
    expect(r.headers()["content-type"] ?? "").not.toContain("csv");
  });

  test("R9: /reports/csv?template=visit → 200 CSV（⑨は日報提出可）", async ({ page }) => {
    await login(page, "R9");
    const r = await page.request.get("/reports/csv?template=visit");
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"] ?? "").toContain("csv");
  });

  test("未認証: /sales-staff/csv/list → /login リダイレクト", async ({ request }) => {
    const r = await request.get("/sales-staff/csv/list", { maxRedirects: 0 });
    expect(r.status()).toBeGreaterThanOrEqual(300);
    expect(r.status()).toBeLessThan(400);
    expect(r.headers()["location"] ?? "").toContain("/login");
  });
});
