import { test, expect, Page } from "@playwright/test";
import { generateSync } from "otplib";
import { PrismaClient } from "@prisma/client";
import fs from "fs";

// 本番スモーク: 全10ロールのログイン + サイドメニュー構成（§11.1 / §5.2）+ ダッシュボード表示
// 業務データは変更しない（MFAの登録状態のみ、実際の登録フローを通じて更新される）。
// スクリーンショットを証拠として保存。

const PW_ADMIN = "Airis-Demo-Admin-2026!x";
const PW_GENERAL = "Airis-Demo-2026!";

// MFA（§4.2）: 秘密鍵は本番が発行したものをDBから読み、コードを生成して実フローを通す
// （既知の鍵を本番へ書き込まない）。
let _db: PrismaClient | null = null;
function db(): PrismaClient {
  if (!_db) {
    // 本番の接続情報は .env.deploy から読む（Next.js が読み込まないファイル）。
    // .env.local に本番URLを置くと Next.js がそれを優先し、ローカルの
    // `npm run dev` / `npm run seed` / 日次バッチが本番DBへ書き込む（BUG-OPS01 の再発防止）。
    const raw = fs.readFileSync(".env.deploy", "utf8");
    const m = raw.match(/^DATABASE_URL_UNPOOLED="?([^"\r\n]+)/m);
    if (!m)
      throw new Error(".env.deploy に DATABASE_URL_UNPOOLED がありません（本番接続情報の置き場）");
    _db = new PrismaClient({ datasourceUrl: m[1] });
  }
  return _db;
}

test.afterAll(async () => {
  await _db?.$disconnect();
});

// ログイン後にMFA画面（登録 or 検証）が出たら通過する。⑨未登録などMFA無しならそのまま返る。
async function completeMfaIfNeeded(page: Page, loginId: string) {
  await page.waitForURL(/\/(dashboard|password|mfa)/, { timeout: 30_000 });
  if (!page.url().includes("/mfa")) return;
  const acc = await db().account.findUnique({ where: { loginId } });
  expect(acc?.mfaSecret, `${loginId}: 秘密鍵が発行済みであること`).toBeTruthy();
  await page.locator('input[name="code"]').fill(generateSync({ secret: acc!.mfaSecret! }));
  await page.getByRole("button", { name: /登録して続行|認証する/ }).click();
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 30_000 });
}

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
  {
    role: "R1",
    loginId: "airis_slb_sys_001",
    pw: PW_ADMIN,
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "下位代理店",
      "管理画面",
      "ホットライン窓口",
      "消費者センター窓口",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R2",
    loginId: "airis_snc_adm_001",
    pw: PW_ADMIN,
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "下位代理店",
      "管理画面",
      "ホットライン窓口",
      "消費者センター窓口",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R3",
    loginId: "airis_snc_ops_0001",
    pw: PW_ADMIN,
    // ③は発注者指示（2026-08-05）により管理画面〇（閲覧+リセット代行 §4.2）
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "下位代理店",
      "管理画面",
      "ホットライン窓口",
      "消費者センター窓口",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R4",
    loginId: "airis_snc_vew_001",
    pw: PW_GENERAL,
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "下位代理店",
      "管理画面",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R5",
    loginId: "airis_snc_spt1_001",
    pw: PW_GENERAL,
    menu: ["ダッシュボード", "Airisアカウント申請", "ホットライン窓口", "ドキュメント"],
  },
  {
    role: "R6",
    loginId: "airis_snc_spt2_001",
    pw: PW_GENERAL,
    menu: ["ダッシュボード", "Airisアカウント申請", "消費者センター窓口", "ドキュメント"],
  },
  {
    role: "R7",
    loginId: "airis_1110001_001",
    pw: PW_ADMIN,
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "下位代理店",
      "窓口案件",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R8",
    loginId: "airis_2210001_001",
    pw: PW_GENERAL,
    menu: [
      "ダッシュボード",
      "Airisアカウント申請",
      "販売員ID管理",
      "訪販員申請・管理",
      "各種資料の提出",
      "お知らせ",
      "ドキュメント",
    ],
  },
  {
    role: "R9",
    loginId: "110001C001",
    pw: PW_GENERAL,
    menu: ["ダッシュボード", "各種資料の提出", "お知らせ", "ドキュメント"],
  },
  { role: "R10", loginId: "airis_1190001_001", pw: PW_ADMIN, menu: ["ダッシュボード", "窓口案件"] },
];

for (const c of CASES) {
  test(`本番: ${c.role} ログイン→ダッシュボード→メニュー構成`, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(c.loginId);
    await page.locator('input[name="password"]').fill(c.pw);
    await page.getByRole("button", { name: "ログイン" }).click();
    await completeMfaIfNeeded(page, c.loginId); // §4.2 MFA（①〜⑧⑩は必須 / ⑨は任意）
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

    const nav = page.locator("nav");
    for (const item of c.menu) {
      await expect(
        nav.getByRole("link", { name: item, exact: true }),
        `${c.role}: メニュー「${item}」が表示されるべき`
      ).toBeVisible();
    }
    for (const item of MENU_ALL.filter((m) => !c.menu.includes(m))) {
      await expect(
        nav.getByRole("link", { name: item, exact: true }),
        `${c.role}: メニュー「${item}」は表示されないべき`
      ).toHaveCount(0);
    }

    await page.screenshot({
      path: `../qa/screenshots/prod-${c.role}-dashboard.png`,
      fullPage: true,
    });
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
