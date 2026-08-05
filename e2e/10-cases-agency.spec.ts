import { test, expect } from "@playwright/test";
import { ACCOUNTS, collectConsoleErrors, criticalErrors, db, login } from "./helpers";

// ============================================================
// 担当: 窓口3画面+通知（§7.10 代理店向け窓口ビュー, §3.7 通知）
// データプレフィクス: QA6
// ============================================================

const RUN = `QA6A${Date.now().toString(36)}`; // 実行ごとの一意トークン
let seq = 0;

function jstDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function mkCase(opts: {
  series?: "HL" | "CSC";
  agencyCode?: string;
  title: string;
  status?: string;
  deadline?: string | null;
}) {
  const agency = await db().agency.findUnique({
    where: { code: opts.agencyCode ?? "110001" },
  });
  if (!agency) throw new Error(`agency not found: ${opts.agencyCode}`);
  const series = opts.series ?? "HL";
  return db().case.create({
    data: {
      series,
      caseNo: `${series === "CSC" ? "CSC" : "HLC"}-${RUN}${seq++}`,
      templateKind: "フリー入力",
      title: opts.title,
      primaryAgencyId: agency.id,
      ispNumber: `${RUN}-isp`,
      deadline: opts.deadline === undefined ? jstDate(7) : opts.deadline,
      status: opts.status ?? "未対応",
      createdBy: "QA6テスト",
      messages: {
        create: { senderSide: "snc", senderName: "QA6テスト", body: "QA6テスト用の本文です。" },
      },
    },
  });
}

test.describe("§7.10 代理店向け窓口ビュー（R7）", () => {
  test("R7で/agency-cases: HLとCSCが同一画面に混在し種別バッジで区別・自店案件のみ", async ({
    page,
  }) => {
    const errors = collectConsoleErrors(page);
    const hlTitle = `${RUN}-mix ホットライン側の案件`;
    const cscTitle = `${RUN}-mix 消費者センター側の案件`;
    const otherTitle = `${RUN}-other 他店（関西）の案件`;
    await mkCase({ series: "HL", title: hlTitle });
    await mkCase({ series: "CSC", title: cscTitle });
    await mkCase({ series: "HL", agencyCode: "150008", title: otherTitle });

    await login(page, "R7");

    // サイドメニュー: 代理店系は「窓口案件」1項目（ホットライン窓口/消費者センター窓口は出ない §11.1）
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "窓口案件" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "ホットライン窓口" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "消費者センター窓口" })).toHaveCount(0);

    await page.goto(`/agency-cases?q=${encodeURIComponent(`${RUN}-mix`)}`);
    await expect(page.getByRole("heading", { name: "窓口案件" })).toBeVisible();

    // HL/CSC両方が同一画面に表示され、種別バッジで区別される
    const hlCard = page.locator("a", { hasText: hlTitle });
    const cscCard = page.locator("a", { hasText: cscTitle });
    await expect(hlCard).toBeVisible();
    await expect(cscCard).toBeVisible();
    await expect(hlCard.getByText("ホットライン", { exact: true })).toBeVisible();
    await expect(cscCard.getByText("消費者センター", { exact: true })).toBeVisible();

    // 他店案件は一覧に出ない
    await page.goto(`/agency-cases?q=${encodeURIComponent(`${RUN}-other`)}`);
    await expect(page.getByText("自店宛の窓口案件はありません。")).toBeVisible();
    await expect(page.getByText(otherTitle)).toHaveCount(0);

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R7: 他店案件のIDを直接開くとリダイレクト、存在しないIDは404", async ({ page }) => {
    const other = await mkCase({
      agencyCode: "150008",
      title: `${RUN}-idor 他店直アクセステスト`,
    });

    await login(page, "R7");

    // 他店案件へのIDOR → 404またはリダイレクトで内容は見えない
    // （実装はRLSによりレコード自体が見えず404。アプリ層のリダイレクトでも仕様上可）
    const idorResp = await page.goto(`/agency-cases/${other.id}`);
    const blocked =
      /\/agency-cases$/.test(new URL(page.url()).pathname) || idorResp!.status() === 404;
    expect(blocked).toBe(true);
    await expect(page.getByText(`${RUN}-idor`)).toHaveCount(0);

    // 既読も記録されない（他店の閲覧は成立しない）
    const r7Agency = await db().agency.findUnique({ where: { code: "110001" } });
    const read = await db().caseRead.findUnique({
      where: { caseId_agencyId: { caseId: other.id, agencyId: r7Agency!.id } },
    });
    expect(read).toBeNull();

    // 存在しないID → 404
    const resp = await page.goto("/agency-cases/qa6-not-exist-id");
    expect(resp!.status()).toBe(404);
  });

  test("R7詳細: 返信フォームあり／新規起票ボタン・ファイル添付UI・ステータス変更UIなし", async ({
    page,
  }) => {
    const c = await mkCase({ title: `${RUN}-ui 制約確認用の案件` });

    await login(page, "R7");
    await page.goto("/agency-cases");
    // 一覧に「新規依頼」起票ボタンが無い（代理店から新規起票不可 §7.8/§7.10）
    await expect(page.getByRole("link", { name: "新規依頼" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "新規依頼" })).toHaveCount(0);

    await page.goto(`/agency-cases/${c.id}`);
    await expect(page.getByRole("heading", { name: c.title })).toBeVisible();
    await expect(page.getByText("やりとり（スレッド）")).toBeVisible();

    // 返信フォームはある
    await expect(page.locator('textarea[name="body"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "返信を送信" })).toBeVisible();

    // ファイル添付UIなし（§14-3: 代理店側は添付不可）
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    // ステータス変更UIなし
    await expect(page.locator('select[name="status"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ステータス変更" })).toHaveCount(0);
    // 緊急アラートもSNC側専用
    await expect(page.getByRole("button", { name: "緊急アラート" })).toHaveCount(0);
  });

  test("R7返信→DBにCaseMessage(senderSide=agency)→R5(HL担当)とR3にNotification", async ({
    page,
  }) => {
    const c = await mkCase({ title: `${RUN}-reply 代理店返信テスト案件` });
    const replyText = `${RUN} 代理店からの返信です。対応済みです。`;

    await login(page, "R7");
    await page.goto(`/agency-cases/${c.id}`);
    await page.locator('textarea[name="body"]').fill(replyText);
    await page.getByRole("button", { name: "返信を送信" }).click();
    await expect(page.getByText("返信を送信しました。")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(replyText)).toBeVisible();

    // DB検証: CaseMessage(senderSide=agency)
    const msg = await db().caseMessage.findFirst({
      where: { caseId: c.id, body: replyText },
    });
    expect(msg).not.toBeNull();
    expect(msg!.senderSide).toBe("agency");
    expect(msg!.senderName).toBe("東都NW 管理者");

    // DB検証: R5（HL担当窓口）とR3へNotification
    const notifTitle = `代理店から返信がありました（${c.caseNo}）`;
    const r5Notif = await db().notification.findFirst({
      where: { account: { loginId: ACCOUNTS.R5.loginId }, title: notifTitle },
    });
    expect(r5Notif).not.toBeNull();
    expect(r5Notif!.link).toBe(`/hotline/${c.id}`);
    const r3Notif = await db().notification.findFirst({
      where: { account: { loginId: ACCOUNTS.R3.loginId }, title: notifTitle },
    });
    expect(r3Notif).not.toBeNull();
  });

  test("R7が詳細を開くとCaseRead記録→SNC側一覧が「代理店未読」→「代理店既読」に変わる", async ({
    page,
    browser,
  }) => {
    const c = await mkCase({ title: `${RUN}-read 既読管理テスト案件` });
    const q = encodeURIComponent(`${RUN}-read`);

    // SNC側（R5）: 閲覧前は「代理店未読」
    const sncCtx = await browser.newContext({ baseURL: "http://localhost:3100" });
    const sncPage = await sncCtx.newPage();
    await login(sncPage, "R5");
    await sncPage.goto(`/hotline?q=${q}`);
    const card = sncPage.locator("a", { hasText: c.title });
    await expect(card.getByText("代理店未読")).toBeVisible();

    // 代理店側（R7）が詳細を開く → CaseRead記録
    await login(page, "R7");
    await page.goto(`/agency-cases/${c.id}`);
    await expect(page.getByRole("heading", { name: c.title })).toBeVisible();

    const r7Agency = await db().agency.findUnique({ where: { code: "110001" } });
    const read = await db().caseRead.findUnique({
      where: { caseId_agencyId: { caseId: c.id, agencyId: r7Agency!.id } },
    });
    expect(read).not.toBeNull();
    expect(read!.readAt.getTime()).toBeGreaterThan(Date.now() - 60_000);

    // SNC側一覧で「代理店既読」表示に変わる
    await sncPage.goto(`/hotline?q=${q}`);
    await expect(card.getByText("代理店既読")).toBeVisible();
    await expect(card.getByText("代理店未読")).toHaveCount(0);

    await sncCtx.close();
  });
});

test.describe("§7.10 稼働終了代理店（R10）", () => {
  test("R10ログイン: メニューはダッシュボードと窓口案件のみ・窓口案件の閲覧/返信可能", async ({
    page,
  }) => {
    const own = await mkCase({
      agencyCode: "190001",
      title: `${RUN}-r10 稼働終了店宛の案件`,
    });
    const replyText = `${RUN} 稼働終了代理店からの返信です。`;

    await login(page, "R10");
    await expect(page).toHaveURL(/\/dashboard/);

    // サイドメニューはダッシュボード+窓口案件の2項目のみ（§11.1: ⑩）
    const navLinks = page.locator("aside nav a");
    await expect(navLinks).toHaveCount(2);
    await expect(
      page.locator("aside nav").getByRole("link", { name: "ダッシュボード" })
    ).toBeVisible();
    await expect(page.locator("aside nav").getByRole("link", { name: "窓口案件" })).toBeVisible();

    // 窓口以外のページへ直接アクセス → /dashboardへ
    await page.goto("/reports");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    await page.goto("/hotline");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

    // 自店（190001）宛の案件は閲覧できる
    await page.goto(`/agency-cases?q=${encodeURIComponent(`${RUN}-r10`)}`);
    await expect(page.getByText(own.title)).toBeVisible();

    // 他店（110001）のシード案件は見えない
    await page.goto("/agency-cases?q=HLC-1000000000001");
    await expect(page.getByText("自店宛の窓口案件はありません。")).toBeVisible();

    // 詳細を開いて返信できる
    await page.goto(`/agency-cases/${own.id}`);
    await expect(page.getByRole("heading", { name: own.title })).toBeVisible();
    await page.locator('textarea[name="body"]').fill(replyText);
    await page.getByRole("button", { name: "返信を送信" }).click();
    await expect(page.getByText("返信を送信しました。")).toBeVisible({ timeout: 15_000 });

    const msg = await db().caseMessage.findFirst({
      where: { caseId: own.id, body: replyText },
    });
    expect(msg).not.toBeNull();
    expect(msg!.senderSide).toBe("agency");
  });

  test("R10: 他店案件のID直接アクセスは404/リダイレクトで見えない", async ({ page }) => {
    const seedCase = await db().case.findUnique({ where: { caseNo: "HLC-1000000000001" } });
    expect(seedCase).not.toBeNull();

    await login(page, "R10");
    const resp = await page.goto(`/agency-cases/${seedCase!.id}`);
    const blocked = /\/agency-cases$/.test(new URL(page.url()).pathname) || resp!.status() === 404;
    expect(blocked).toBe(true);
    await expect(page.getByText("HLC-1000000000001")).toHaveCount(0);

    // 他店の閲覧は成立しないので既読も記録されない
    const r10Agency = await db().agency.findUnique({ where: { code: "190001" } });
    const read = await db().caseRead.findUnique({
      where: { caseId_agencyId: { caseId: seedCase!.id, agencyId: r10Agency!.id } },
    });
    expect(read).toBeNull();
  });
});

test.describe("権限外ロールの窓口ビューアクセス", () => {
  test("R8で/agency-casesへ直接アクセス→/dashboardへ", async ({ page }) => {
    await login(page, "R8");
    await page.goto("/agency-cases");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("R7で/hotline・/consumer-centerへ直接アクセス→/dashboardへ", async ({ page }) => {
    await login(page, "R7");
    await page.goto("/hotline");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    await page.goto("/consumer-center");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
  });
});

test.describe("§3.7 通知ベル・通知一覧", () => {
  test("未読バッジ数→/notificationsで一覧表示→すべて既読→バッジ消える", async ({ page }) => {
    // R10アカウントで自己完結（シード通知はR7宛のみなので共有シード行を壊さない）
    const account = await db().account.findUnique({
      where: { loginId: ACCOUNTS.R10.loginId },
    });
    expect(account).not.toBeNull();
    // 前回実行のQA6残骸は削除・その他の未読は既読化してから、未読2件を作成
    await db().notification.deleteMany({
      where: { accountId: account!.id, title: { contains: "テスト通知その" } },
    });
    await db().notification.updateMany({
      where: { accountId: account!.id, readAt: null },
      data: { readAt: new Date() },
    });
    const n1 = `${RUN} テスト通知その1`;
    const n2 = `${RUN} テスト通知その2`;
    await db().notification.create({
      data: { accountId: account!.id, title: n1, body: `${RUN} 通知本文1`, link: "/agency-cases" },
    });
    await db().notification.create({
      data: { accountId: account!.id, title: n2, body: `${RUN} 通知本文2` },
    });

    const errors = collectConsoleErrors(page);
    await login(page, "R10");

    // ヘッダの通知ベルに未読バッジ「2」
    const bell = page.locator('a[href="/notifications"]');
    await expect(bell).toBeVisible();
    await expect(bell.locator("span")).toHaveText("2");

    // /notificationsで一覧表示
    await bell.click();
    await page.waitForURL(/\/notifications/, { timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "通知" })).toBeVisible();
    await expect(page.getByText(n1)).toBeVisible();
    await expect(page.getByText(n2)).toBeVisible();
    const item1 = page.getByRole("listitem").filter({ hasText: n1 });
    await expect(item1.getByText(`${RUN} 通知本文1`)).toBeVisible();
    // リンク付き通知には「詳細を見る」
    await expect(item1.getByRole("link", { name: "詳細を見る →" })).toBeVisible();

    // すべて既読にする → バッジが消える
    await page.getByRole("button", { name: "すべて既読にする" }).click();
    await expect(bell.locator("span")).toHaveCount(0, { timeout: 15_000 });

    // DB検証: 未読0
    await expect
      .poll(async () =>
        db().notification.count({ where: { accountId: account!.id, readAt: null } })
      )
      .toBe(0);

    expect(criticalErrors(errors)).toEqual([]);
  });
});
