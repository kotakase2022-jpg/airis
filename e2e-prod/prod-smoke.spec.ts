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

/**
 * そのロールで**実際にログインできるアカウント**を本番DBから決める。
 *
 * 経緯（QA loop5・発注者確認済み）:
 *   本番は実運用に入っており、シード済みデモアカウントが業務操作で停止されることがある。
 *   実測: `110001C001`（⑨）は 2026-08-07 11:10 JST に⑦`airis_1110001_003` が
 *   **意図的に停止**（StatusHistory: sales_staff / suspend / registered→suspended）。
 *   その結果このスモークが「ログイン後の遷移待ちタイムアウト」で落ちていたが、
 *   原因はアプリではなく本番データの状態だった。
 *
 * 候補は **`prisma/seed.ts` が作るデモアカウントに限定**する。理由:
 *   - `Account.role` で同ロールを検索すると、**運用者が承認して作った販売員アカウント**も
 *     混ざる。それらのパスワードは発行時の一時パスワードで、この検証からは分からない。
 *   - ⑩は実効ロール（稼働終了代理店の⑦）で、DB上の `role` は `"R7"`。
 *     `role="R10"` で検索しても目的のアカウントは見つからない。
 *   デモアカウントならロール別の既定パスワード（PW_ADMIN / PW_GENERAL）が分かっている。
 *
 * MFA未登録のアカウントを選ぶとこの検証がMFAを本登録してしまい、
 * 発注者が配布したQR登録の運用を壊す。そのため**既にMFA登録済みを優先**する。
 *
 * 候補が1件も使えない場合は前提不成立として**明示的に失敗**させる（skip しない）。
 */
async function pickLoginId(role: string, candidates: string[]): Promise<string> {
  const rows = await db().account.findMany({
    where: {
      loginId: { in: candidates },
      status: "active",
      mustChangePassword: false,
      deletedAt: null,
      anonymizedAt: null,
    },
    select: { loginId: true, mfaSecret: true },
  });
  const usable = candidates.filter((id) => rows.some((r) => r.loginId === id));
  expect(
    usable.length,
    `${role}: ログイン可能なデモアカウントが本番に1件もありません（前提不成立）。` +
      `候補=${candidates.join(", ")}`
  ).toBeGreaterThan(0);

  const preferred = candidates[0];
  if (usable.includes(preferred)) return preferred;
  const withMfa = usable.find((id) => rows.find((r) => r.loginId === id)?.mfaSecret);
  const picked = withMfa ?? usable[0];
  console.log(
    `[prod-smoke] ${role}: 既定の ${preferred} が使用不可のため ${picked} で検証します` +
      `（本番の業務操作で停止・削除された可能性。アプリの不具合ではありません）`
  );
  return picked;
}

/** 発注者指示 2026-08-05 で追加したMFAデモ用アカウント（②〜⑩ 各10件）を候補に加える */
function demoCandidates(primary: string): string[] {
  const seq = (prefix: string, pad: number, from: number, to: number) =>
    Array.from(
      { length: to - from + 1 },
      (_, i) => `${prefix}${String(from + i).padStart(pad, "0")}`
    );
  const extra: Record<string, string[]> = {
    airis_snc_adm_001: seq("airis_snc_adm_", 3, 2, 11),
    airis_snc_ops_0001: seq("airis_snc_ops_", 4, 2, 11),
    airis_snc_vew_001: seq("airis_snc_vew_", 3, 2, 11),
    airis_snc_spt1_001: seq("airis_snc_spt1_", 3, 2, 11),
    airis_snc_spt2_001: seq("airis_snc_spt2_", 3, 2, 11),
    airis_1110001_001: seq("airis_1110001_", 3, 2, 11),
    airis_2210001_001: seq("airis_2210001_", 3, 2, 11),
    "110001C001": seq("110001C", 3, 101, 110),
    airis_1190001_001: seq("airis_1190001_", 3, 2, 11),
  };
  return [primary, ...(extra[primary] ?? [])];
}

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

    // 固定IDではなく「使用可能なデモアカウント」で検証する（理由は pickLoginId 参照）
    const loginId = await pickLoginId(c.role, demoCandidates(c.loginId));

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(loginId);
    await page.locator('input[name="password"]').fill(c.pw);
    await page.getByRole("button", { name: "ログイン" }).click();
    await completeMfaIfNeeded(page, loginId); // §4.2 MFA（①〜⑧⑩は必須 / ⑨は任意）
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
