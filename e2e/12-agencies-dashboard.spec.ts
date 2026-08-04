// §7.11 下位代理店 / §7.1 ダッシュボード / §3.5 R4ダミー表示モード / §14-2 稼働終了→実効ロール⑩
// データプレフィクス: QA7（代理店コードは 9710xx 帯を使用）
import { test, expect, Page } from "@playwright/test";
import {
db,
  login,
  collectConsoleErrors,
  criticalErrors,
} from "./helpers";

const AG_CODE = "971010"; // 追加・編集・削除フローで使う2次代理店
const AG_NAME = "QA7-テスト代理店A";
const AG_NAME2 = "QA7-テスト代理店A改";
const AG_STAFF_ID = "971010C001";

function jstToday(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// StatCard の値を取得（ラベル完全一致 → 同カード内の数値div）
// :has(:text-is()) はスコープ（Page/Locator）に対して相対解決されるので section 配下でも使える
function statCard(scope: Page | ReturnType<Page["locator"]>, label: string) {
  return (scope as Page)
    .locator(`div.min-w-0:has(div.truncate:text-is("${label}"))`)
    .locator("div.text-2xl");
}

async function statValue(scope: Page | ReturnType<Page["locator"]>, label: string): Promise<number> {
  const txt = await statCard(scope, label).innerText({ timeout: 10_000 });
  return Number(txt.trim());
}

async function cleanupQA7() {
  const d = db();
  const agencies = await d.agency.findMany({
    where: { OR: [{ name: { startsWith: "QA7" } }, { code: { startsWith: "9710" } }] },
    select: { id: true },
  });
  const ids = agencies.map((a) => a.id);
  if (ids.length > 0) {
    await d.salesStaff.deleteMany({ where: { agencyId: { in: ids } } });
    await d.account.deleteMany({ where: { agencyId: { in: ids } } });
    await d.agency.deleteMany({ where: { id: { in: ids } } });
  }
  // 稼働終了テストが途中で落ちた場合に備え、共有シード行を必ず復元
  await d.agency.updateMany({ where: { code: "110001" }, data: { status: "active" } });
}

test.beforeAll(async () => {
  await cleanupQA7();
});

test.afterAll(async () => {
  await cleanupQA7();
  await db().$disconnect();
});

// ─────────────────────────────────────────────────────────────
// §7.11 下位代理店
// ─────────────────────────────────────────────────────────────

test("下位代理店: R2で統計4枚・階層ツリー・一覧列が表示され、統計値がDBと一致する", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  const d = db();

  // 期待値をDBから算出（R2スコープ = 非ダミー全代理店）
  const notDeleted = { status: { not: "deleted" } };
  const [subTotal, subActive, userTotal, ongoingTotal] = await Promise.all([
    d.agency.count({ where: { isDummy: false, tier: 2 } }),
    d.agency.count({ where: { isDummy: false, tier: 2, status: "active" } }),
    d.account.count({ where: { ...notDeleted, agency: { is: { isDummy: false } } } }),
    // 管轄内進行中案件 = scope内の未完了Case件数（§7.11）
    d.case.count({
      where: { status: { not: "完了" }, primaryAgency: { is: { isDummy: false } } },
    }),
  ]);

  await login(page, "R2");
  await page.goto("/agencies");
  await expect(page.getByRole("heading", { name: "下位代理店", exact: true })).toBeVisible();

  // 統計カード4枚（値がDB件数と一致）
  await expect(page.locator("div.grid.grid-cols-4 > div")).toHaveCount(4);
  expect(await statValue(page, "下位代理店数")).toBe(subTotal);
  expect(await statValue(page, "有効代理店")).toBe(subActive);
  expect(await statValue(page, "総ユーザー数")).toBe(userTotal);
  expect(await statValue(page, "管轄内進行中案件")).toBe(ongoingTotal);

  // 階層ツリー: 1次店ノード（東都=110001）とその配下2次店
  await expect(page.getByText("代理店階層ツリー")).toBeVisible();
  const primaryNode = page.locator("div.border-l-emerald-500", { hasText: "ID: 110001" });
  await expect(primaryNode).toBeVisible();
  await expect(primaryNode.getByText("東都ネットワーク販売株式会社")).toBeVisible();
  await expect(primaryNode.getByText("株式会社セールスパートナー東京")).toBeVisible();
  await expect(primaryNode.getByText("ID: 210001")).toBeVisible();
  // 稼働終了の1次店（190001）はツリーで「稼働終了」バッジ
  const closedNode = page.locator("div.border-l-emerald-500", { hasText: "ID: 190001" });
  await expect(closedNode.getByText("稼働終了")).toBeVisible();
  // ダミー代理店（990001）は表示されない
  await expect(page.getByText("990001")).toHaveCount(0);

  // 一覧テーブルの列（ID / 代理店名 / 一次代理店 / 代表者 / ステータス / 登録ユーザー / 進行中案件 / 参加日 §7.11）
  for (const col of ["ID", "代理店名", "一次代理店", "代表者", "ステータス", "登録ユーザー", "進行中案件", "参加日", "操作"]) {
    await expect(page.locator("th", { hasText: new RegExp(`^${col}$`) })).toBeVisible();
  }
  // 行の内容（210001 = セールスパートナー東京、親=東都、代表者=鈴木 四郎、参加日 2024-08-01）
  const row = page.locator("tbody > tr", { hasText: "210001" }).first();
  await expect(row.getByText("株式会社セールスパートナー東京")).toBeVisible();
  await expect(row.getByText("東都ネットワーク販売株式会社")).toBeVisible();
  await expect(row.getByText("鈴木 四郎")).toBeVisible();
  await expect(row.getByText("有効")).toBeVisible();
  await expect(row.getByText("2024-08-01")).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

test("下位代理店: R2で追加（親選択）→ 一覧・DB反映、6桁コード重複はエラー", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  const p1 = await d.agency.findUnique({ where: { code: "110001" } });
  expect(p1).not.toBeNull();

  await login(page, "R2");
  await page.goto("/agencies");

  // 追加モーダル（2次店・親=東都）
  await page.getByRole("button", { name: "＋ 下位代理店を追加" }).click();
  await page.locator('select[name="tier"]').selectOption("2");
  await page.locator('select[name="parentId"]').selectOption(p1!.id);
  await page.locator('input[name="code"]').fill(AG_CODE);
  await page.locator('input[name="name"]').fill(AG_NAME);
  await page.locator('input[name="representative"]').fill("QA7 代表太郎");
  await page.getByRole("button", { name: "登録する" }).click();
  // 成功でモーダルが閉じる
  await expect(page.locator('input[name="code"]')).toHaveCount(0, { timeout: 15_000 });

  // DB反映
  const created = await d.agency.findUnique({ where: { code: AG_CODE } });
  expect(created).not.toBeNull();
  expect(created!.name).toBe(AG_NAME);
  expect(created!.tier).toBe(2);
  expect(created!.parentId).toBe(p1!.id);
  expect(created!.status).toBe("active");
  expect(created!.representative).toBe("QA7 代表太郎");

  // 一覧に表示
  await page.goto(`/agencies?q=${AG_CODE}`);
  const row = page.locator("tbody > tr", { hasText: AG_CODE });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(AG_NAME)).toBeVisible();

  // 同じ6桁コードで再度追加 → エラー
  await page.getByRole("button", { name: "＋ 下位代理店を追加" }).click();
  await page.locator('select[name="tier"]').selectOption("2");
  await page.locator('select[name="parentId"]').selectOption(p1!.id);
  await page.locator('input[name="code"]').fill(AG_CODE);
  await page.locator('input[name="name"]').fill("QA7-重複コード店");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText(`代理店コード ${AG_CODE} は既に使用されています。`)).toBeVisible({ timeout: 15_000 });
  expect(await d.agency.count({ where: { code: AG_CODE } })).toBe(1);
  expect(await d.agency.count({ where: { name: "QA7-重複コード店" } })).toBe(0);
});

test("下位代理店: R2で編集 → UI・DB反映", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  // 前テストの代理店が無い場合も自己完結するよう用意
  const p1 = await d.agency.findUnique({ where: { code: "110001" } });
  let target = await d.agency.findUnique({ where: { code: AG_CODE } });
  if (!target) {
    target = await d.agency.create({
      data: { code: AG_CODE, name: AG_NAME, tier: 2, parentId: p1!.id, representative: "QA7 代表太郎" },
    });
  }

  await login(page, "R2");
  await page.goto(`/agencies?q=${AG_CODE}`);
  const row = page.locator("tbody > tr", { hasText: AG_CODE });
  await row.getByRole("button", { name: "編集" }).click();
  await page.locator('input[name="name"]').fill(AG_NAME2);
  await page.locator('input[name="representative"]').fill("QA7 代表次郎");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.locator('input[name="name"]')).toHaveCount(0, { timeout: 15_000 });

  // DB反映
  await expect
    .poll(async () => (await d.agency.findUnique({ where: { code: AG_CODE } }))?.name, { timeout: 10_000 })
    .toBe(AG_NAME2);
  expect((await d.agency.findUnique({ where: { code: AG_CODE } }))?.representative).toBe("QA7 代表次郎");

  // UI反映
  await page.goto(`/agencies?q=${AG_CODE}`);
  await expect(page.locator("tbody > tr", { hasText: AG_CODE }).getByText(AG_NAME2)).toBeVisible();
});

test("下位代理店: 配下にデータがある代理店の削除は拒否 → 空にすると削除成功", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  const p1 = await d.agency.findUnique({ where: { code: "110001" } });
  let target = await d.agency.findUnique({ where: { code: AG_CODE } });
  if (!target) {
    target = await d.agency.create({
      data: { code: AG_CODE, name: AG_NAME2, tier: 2, parentId: p1!.id },
    });
  }
  // 配下に販売員を作成（自作データのみで削除テストを行う）
  await d.salesStaff.deleteMany({ where: { salesId: AG_STAFF_ID } });
  await d.salesStaff.create({
    data: {
      salesId: AG_STAFF_ID,
      lastName: "QA7",
      firstName: "販売員",
      birthDate: "1990-01-01",
      phone: "080-9999-0001",
      agencyId: target.id,
      status: "registered",
      firstApproved: true,
    },
  });

  page.on("dialog", (dialog) => dialog.accept());
  await login(page, "R2");
  await page.goto(`/agencies?q=${AG_CODE}`);
  const row = page.locator("tbody > tr", { hasText: AG_CODE });
  await expect(row).toHaveCount(1);

  // 販売員が居るため削除拒否
  await row.getByRole("button", { name: "削除" }).click();
  await expect(row.getByText(/存在するため削除できません/)).toBeVisible({ timeout: 15_000 });
  expect(await d.agency.count({ where: { code: AG_CODE } })).toBe(1);

  // 配下データを消して空にする → 削除成功
  await d.salesStaff.deleteMany({ where: { salesId: AG_STAFF_ID } });
  await page.goto(`/agencies?q=${AG_CODE}`);
  await page.locator("tbody > tr", { hasText: AG_CODE }).getByRole("button", { name: "削除" }).click();
  await expect(page.locator("tbody > tr", { hasText: AG_CODE })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => d.agency.count({ where: { code: AG_CODE } }), { timeout: 10_000 })
    .toBe(0);
});

test("下位代理店: 稼働終了に変更 → 当該R7の実効ロールが⑩（メニューはダッシュボード+窓口案件のみ）→ 戻す", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const d = db();

  try {
    // R2: 東都（110001）を稼働終了に変更（ツリーの1次店ノードから編集）
    await login(page, "R2");
    await page.goto("/agencies");
    const primaryNode = page.locator("div.border-l-emerald-500", { hasText: "ID: 110001" });
    await primaryNode.getByRole("button", { name: "編集" }).click();
    const modal = page.locator("div.fixed", { hasText: "代理店を編集" });
    await modal.locator('select[name="status"]').selectOption("closed");
    await modal.getByRole("button", { name: "保存する" }).click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await d.agency.findUnique({ where: { code: "110001" } }))?.status, { timeout: 10_000 })
      .toBe("closed");

    // 当該R7でログイン → 実効ロール⑩
    const ctx = await browser.newContext();
    const p7 = await ctx.newPage();
    await login(p7, "R7");
    await expect(p7).toHaveURL(/\/dashboard/);
    // ロールバッジが「稼働終了代理店」
    await expect(p7.locator("aside").getByText("稼働終了代理店")).toBeVisible();
    // サイドメニューはダッシュボード+窓口案件の2項目のみ
    const navItems = p7.locator("aside nav a");
    await expect(navItems).toHaveCount(2);
    await expect(navItems.nth(0)).toHaveText("ダッシュボード");
    await expect(navItems.nth(1)).toHaveText("窓口案件");
    // ⑩は下位代理店・販売員ID・お知らせ等へ直接アクセスしてもダッシュボードへ戻される
    for (const url of ["/agencies", "/sales-staff", "/announcements", "/reports"]) {
      await p7.goto(url);
      await p7.waitForURL(/\/dashboard/, { timeout: 15_000 });
    }
    // 窓口案件は開ける
    await p7.goto("/agency-cases");
    await expect(p7).toHaveURL(/\/agency-cases/);

    // 戻す（R2のUIから active に復元）
    await page.goto("/agencies");
    const node2 = page.locator("div.border-l-emerald-500", { hasText: "ID: 110001" });
    await node2.getByRole("button", { name: "編集" }).click();
    const modal2 = page.locator("div.fixed", { hasText: "代理店を編集" });
    await modal2.locator('select[name="status"]').selectOption("active");
    await modal2.getByRole("button", { name: "保存する" }).click();
    await expect(modal2).toHaveCount(0, { timeout: 15_000 });
    await expect
      .poll(async () => (await d.agency.findUnique({ where: { code: "110001" } }))?.status, { timeout: 10_000 })
      .toBe("active");

    // 復元後: 同じR7セッションで実効ロールが⑦に戻る（メニュー復活）
    await p7.goto("/dashboard");
    await expect(p7.locator("aside nav a", { hasText: "下位代理店" })).toBeVisible();
    await expect(p7.locator("aside").getByText("一次代理店管理者")).toBeVisible();
    await ctx.close();
  } finally {
    // テスト失敗時も共有シード行を必ず復元
    await d.agency.updateMany({ where: { code: "110001" }, data: { status: "active" } });
  }
});

test("下位代理店: R7は閲覧のみ（追加/編集/削除ボタンなし・自店配下のみ表示）", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  // 期待値: R7(110001)のスコープ = 自店+配下（tier2の配下店数）
  const p1 = await d.agency.findUnique({ where: { code: "110001" } });
  const childCount = await d.agency.count({ where: { parentId: p1!.id, tier: 2 } });

  await login(page, "R7");
  await page.goto("/agencies");
  await expect(page.getByRole("heading", { name: "下位代理店", exact: true })).toBeVisible();
  await expect(page.getByText("配下の下位代理店を確認できます。")).toBeVisible();

  // 操作ボタンが一切出ない
  await expect(page.getByRole("button", { name: "＋ 下位代理店を追加" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "編集" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "削除" })).toHaveCount(0);
  await expect(page.locator("tbody").getByText("閲覧のみ").first()).toBeVisible();

  // 自店配下のみ（210001/210002は見える。他店配下 250008・ダミー990001系は見えない）
  expect(await statValue(page, "下位代理店数")).toBe(childCount);
  await expect(page.getByText("ID: 210001")).toBeVisible();
  await expect(page.getByText("ID: 210002")).toBeVisible();
  await expect(page.getByText("250008")).toHaveCount(0);
  await expect(page.getByText("990001")).toHaveCount(0);
  await expect(page.getByText("関西コミュニケーションズ株式会社")).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────
// §7.1 ダッシュボード
// ─────────────────────────────────────────────────────────────

test("ダッシュボード: R2の各セクションカード数値がDB件数と一致（販売員/訪販員/日報/代理店/窓口）", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  const d = db();
  const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  const today = jstToday();

  // R2スコープ = 非ダミー全代理店
  const scopeIds = (await d.agency.findMany({ where: { isDummy: false }, select: { id: true } })).map((a) => a.id);
  const staffOf = (s: string) => d.salesStaff.count({ where: { status: s, agencyId: { in: scopeIds } } });
  const fieldOf = (s: string) =>
    d.fieldAgentApplication.count({ where: { status: s, salesStaff: { agencyId: { in: scopeIds } } } });
  const caseOf = (s: string) => d.case.count({ where: { status: s, primaryAgencyId: { in: scopeIds } } });

  const expected = {
    staff: {
      申請中: await staffOf("applying"),
      仮登録: await staffOf("provisional"),
      本登録: await staffOf("registered"),
      停止中: await staffOf("suspended"),
      削除済: await staffOf("deleted"),
    },
    field: {
      申請中: await fieldOf("applying"),
      仮登録: await fieldOf("provisional"),
      稼働: await fieldOf("registered"),
      抹消: await fieldOf("deleted"),
    },
    reportCount: await d.dailyReport.count({
      where: { date: { startsWith: month }, agencyId: { in: scopeIds } },
    }),
    submissionPending: await d.submission.count({
      where: { status: { in: ["pending_first", "pending_snc"] }, submitterAgencyId: { in: scopeIds } },
    }),
    submissionApproved: await d.submission.count({
      where: { status: "approved", targetMonth: month, submitterAgencyId: { in: scopeIds } },
    }),
    agencyTotal: scopeIds.length,
    agencyActive: await d.agency.count({ where: { status: "active", isDummy: false } }),
    caseUntouched: await caseOf("未対応"),
    caseActive: (await caseOf("確認中")) + (await caseOf("対応中")),
    caseProblem: await caseOf("問題発生"),
    caseOverdue: await d.case.count({
      where: { status: { not: "完了" }, deadline: { lt: today }, primaryAgencyId: { in: scopeIds } },
    }),
  };

  await login(page, "R2");
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();

  const section = (name: string | RegExp) =>
    page.locator("section").filter({ has: page.locator("h2", { hasText: name }) });

  // 販売員ID
  const sStaff = section(/^販売員ID$/);
  for (const [label, value] of Object.entries(expected.staff)) {
    expect(await statValue(sStaff as never, label), `販売員ID:${label}`).toBe(value);
  }
  // 訪販員申請
  const sField = section(/^訪販員申請$/);
  for (const [label, value] of Object.entries(expected.field)) {
    expect(await statValue(sField as never, label), `訪販員申請:${label}`).toBe(value);
  }
  // 日報・稼働提出物
  const sReports = section(/^日報・稼働提出物/);
  expect(await statValue(sReports as never, "当月の日報件数")).toBe(expected.reportCount);
  expect(await statValue(sReports as never, "提出物 承認待ち")).toBe(expected.submissionPending);
  expect(await statValue(sReports as never, "提出物 最終承認済み（当月）")).toBe(expected.submissionApproved);
  // 代理店
  const sAgency = section(/^代理店$/);
  expect(await statValue(sAgency as never, "代理店数")).toBe(expected.agencyTotal);
  expect(await statValue(sAgency as never, "有効")).toBe(expected.agencyActive);
  // 窓口案件
  const sCases = section(/^窓口案件$/);
  expect(await statValue(sCases as never, "未対応")).toBe(expected.caseUntouched);
  expect(await statValue(sCases as never, "対応中")).toBe(expected.caseActive);
  expect(await statValue(sCases as never, "問題発生")).toBe(expected.caseProblem);
  expect(await statValue(sCases as never, "期限超過")).toBe(expected.caseOverdue);

  expect(criticalErrors(errors)).toEqual([]);
});

test("ダッシュボード: R2の各セクションリンクから該当画面へ遷移できる", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "R2");

  const links: [string, RegExp][] = [
    ["Airisアカウント申請 →", /\/account-requests/],
    ["販売員ID管理 →", /\/sales-staff/],
    ["訪販員申請・管理 →", /\/field-agents/],
    ["各種資料の提出 →", /\/reports/],
    ["下位代理店 →", /\/agencies/],
    ["窓口案件 →", /\/hotline/], // R2はHL窓口ページへ
    ["お知らせ →", /\/announcements/],
  ];
  for (const [label, urlPattern] of links) {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: label }).click();
    await page.waitForURL(urlPattern, { timeout: 15_000 });
  }
});

// ─────────────────────────────────────────────────────────────
// §3.5 R4ダミー表示モード
// ─────────────────────────────────────────────────────────────

test("R4ダミーモード: バナー表示・ダミー代理店(990001系)のみ表示・実データ非表示・操作ボタン非表示", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);
  const d = db();
  const dummyTotal = await d.agency.count({ where: { isDummy: true } });

  await login(page, "R4");
  await expect(page).toHaveURL(/\/dashboard/);

  // バナー「サンプルデータ」
  await expect(page.getByText("閲覧用アカウントのため、表示されているのはサンプルデータです。")).toBeVisible();

  // サイドメニュー: ④向け9項目（窓口2項目は出ない §5.2）
  const navTexts = await page.locator("aside nav a").allInnerTexts();
  expect(navTexts).toEqual([
    "ダッシュボード",
    "Airisアカウント申請",
    "販売員ID管理",
    "訪販員申請・管理",
    "各種資料の提出",
    "下位代理店",
    "管理画面",
    "お知らせ",
    "ドキュメント",
  ]);

  // ダッシュボードの代理店数 = ダミー代理店数のみ
  const sAgency = page.locator("section").filter({ has: page.locator("h2", { hasText: /^代理店$/ }) });
  expect(await statValue(sAgency as never, "代理店数")).toBe(dummyTotal);

  // 販売員ID管理: ダミー販売員(990001系)のみ、実データは一切出ない
  await page.goto("/sales-staff");
  await expect(page.getByText("990001C001")).toBeVisible();
  await expect(page.getByText("サンプル一次代理店株式会社").first()).toBeVisible();
  await expect(page.getByText("110001C001")).toHaveCount(0);
  await expect(page.getByText("210001C001")).toHaveCount(0);
  await expect(page.getByText("東都ネットワーク販売株式会社")).toHaveCount(0);
  await expect(page.getByText("株式会社セールスパートナー東京")).toHaveCount(0);
  // 操作ボタン非表示（申請・承認・停止・削除・編集）
  await expect(page.getByText("＋ 販売員ID申請")).toHaveCount(0);
  for (const btn of ["最終承認", "1次承認", "停止", "削除", "編集", "再開"]) {
    await expect(page.getByRole("button", { name: btn })).toHaveCount(0);
  }

  // 下位代理店: ダミー階層のみ + 操作ボタンなし
  await page.goto("/agencies");
  await expect(page.getByText("サンプル一次代理店株式会社").first()).toBeVisible();
  await expect(page.getByText("ID: 991001")).toBeVisible();
  await expect(page.getByText("110001")).toHaveCount(0);
  await expect(page.getByText("東都ネットワーク販売株式会社")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "＋ 下位代理店を追加" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "編集" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "削除" })).toHaveCount(0);

  expect(criticalErrors(errors)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────
// 異常系: 権限外URL直接アクセス
// ─────────────────────────────────────────────────────────────

test("権限外アクセス: R8/R9は/agenciesへ直接アクセスするとダッシュボードへリダイレクト", async ({ page }) => {
  test.setTimeout(120_000);
  // R9（販売員）
  await login(page, "R9");
  await page.goto("/agencies");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page.locator("aside nav a", { hasText: "下位代理店" })).toHaveCount(0);

  // R8（2次店管理者）
  await login(page, "R8");
  await page.goto("/agencies");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page.locator("aside nav a", { hasText: "下位代理店" })).toHaveCount(0);

  // R5（HL窓口）も代理店情報は不可（§5.2 ⑤=×）
  await login(page, "R5");
  await page.goto("/agencies");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
});
