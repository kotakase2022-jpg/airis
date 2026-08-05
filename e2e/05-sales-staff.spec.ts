// 販売員ID管理（SPEC §6.2 / §7.3）E2Eテスト
// データプレフィクス: QA3（作成データはすべて QA3 で始まる姓 / loginId を使用し、afterAllで清掃）
// シード行のうち 150008C001（関西四郎）系は読み取り利用可・110001C001系は閲覧のみ（変更しない）。

import { test, expect, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import {
  completeMfaIfNeeded,
  ACCOUNTS,
  PW_GENERAL,
  collectConsoleErrors,
  criticalErrors,
  db,
  login,
} from "./helpers";

const RUN = Date.now().toString(36); // 再実行しても衝突しない一意サフィクス
const P = (name: string) => `QA3${name}${RUN}`; // 姓に使う一意プレフィクス
const pad3 = (n: number) => String(n).padStart(3, "0");

// 最終承認で発行された loginId（= salesId）を清掃対象として記録
const issuedLoginIds: string[] = [];

async function agencyByCode(code: string) {
  return db().agency.findUniqueOrThrow({ where: { code } });
}

async function freshLogin(page: Page, role: keyof typeof ACCOUNTS) {
  await page.context().clearCookies();
  await login(page, role);
}

async function rawLogin(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  // MFA画面へ遷移した場合は通過する（失敗ケースは /login に留まるため何もしない）
  try {
    await page.waitForURL(/\/(mfa|dashboard|password)/, { timeout: 2000 });
  } catch {
    return;
  }
  if (page.url().includes("/mfa")) await completeMfaIfNeeded(page, loginId);
}

function gotoList(page: Page, q?: string) {
  return page.goto(`/sales-staff${q ? `?q=${encodeURIComponent(q)}` : ""}`);
}

function rowFor(page: Page, text: string) {
  return page.locator("tbody tr", { hasText: text });
}

// 次に採番されるべき販売員ID（{code}C{3桁} 採番規則の期待値）を実装と独立にDBから計算
async function expectedNextSalesId(code: string): Promise<string> {
  const existing = await db().salesStaff.findMany({
    where: { salesId: { startsWith: `${code}C` } },
    select: { salesId: true },
  });
  let max = 0;
  for (const e of existing) {
    const n = Number(e.salesId!.slice(code.length + 1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${code}C${pad3(max + 1)}`;
}

// QA3で作成したデータの物理清掃（他スイートと共有するシード行には触れない）
async function cleanupQa3() {
  const d = db();
  const staff = await d.salesStaff.findMany({
    where: { lastName: { startsWith: "QA3" } },
    select: { id: true, accountId: true },
  });
  const accIds = staff.map((s) => s.accountId).filter((x): x is string => !!x);
  await d.salesStaff.deleteMany({ where: { id: { in: staff.map((s) => s.id) } } });
  if (accIds.length > 0) {
    await d.notification.deleteMany({ where: { accountId: { in: accIds } } });
    await d.account.deleteMany({ where: { id: { in: accIds } } });
  }
  if (issuedLoginIds.length > 0) {
    await d.account.deleteMany({ where: { loginId: { in: issuedLoginIds } } });
  }
  await d.account.deleteMany({ where: { loginId: { startsWith: "QA3" } } });
}

test.beforeAll(async () => {
  await cleanupQa3(); // 前回異常終了の残骸を除去（採番テストの決定性確保）
});

test.afterAll(async () => {
  try {
    await cleanupQa3();
  } finally {
    await db().$disconnect();
  }
});

// =====================================================================
// 申請（正常系・異常系）
// =====================================================================

test("R8: 新規申請（姓名別枠・生年月日・電話）→ DBにapplying → R8の一覧に表示", async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);
  const lastName = P("申請");
  await freshLogin(page, "R8");
  await gotoList(page);

  // 説明バナー: R8は自店のみ操作可能
  await expect(page.getByText("操作可能な代理店")).toContainText(
    "株式会社セールスパートナー東京（210001）"
  );

  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  // R8は所属代理店が自店固定（disabled表示 + hidden）
  await expect(page.locator('input[name="agencyId"][type="hidden"]')).toHaveCount(1);
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("太郎");
  await page.locator('input[name="birthDate"]').fill("1991-05-05");
  await page.locator('input[name="phone"]').fill("090-1111-2222");
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText(`${lastName} 太郎 さんの販売員IDを申請しました（申請中）`)
  ).toBeVisible({
    timeout: 10_000,
  });

  // DB検証: applying / 未採番 / 自店(210001)
  const s1 = await agencyByCode("210001");
  const staff = await db().salesStaff.findFirst({ where: { lastName } });
  expect(staff).not.toBeNull();
  expect(staff!.status).toBe("applying");
  expect(staff!.salesId).toBeNull();
  expect(staff!.firstApproved).toBe(false);
  expect(staff!.agencyId).toBe(s1.id);
  expect(staff!.birthDate).toBe("1991-05-05");
  expect(staff!.phone).toBe("090-1111-2222");
  expect(staff!.firstName).toBe("太郎");

  // R8の一覧に表示される（ステータスバッジ=申請中・未採番）
  await gotoList(page, lastName);
  const row = rowFor(page, lastName);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("申請中");
  await expect(row).toContainText("未採番");

  expect(criticalErrors(errors)).toEqual([]);
});

test("申請フォーム: 必須項目未入力はエラーになり登録されない（HTML5+サーバ側）", async ({
  page,
}) => {
  const lastName = P("必須");
  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();

  // 1) ブラウザバリデーション: 姓だけ入力して送信→ 名がinvalidで送信されない
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.getByRole("button", { name: "申請する" }).click();
  const missing = await page
    .locator('input[name="firstName"]')
    .evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
  expect(missing).toBe(true);

  // 2) サーバ側検証: required属性を外して空のまま送信→ サーバのエラーメッセージ
  await page.evaluate(() => {
    document
      .querySelectorAll("input[required], select[required]")
      .forEach((el) => el.removeAttribute("required"));
  });
  await page.locator('input[name="lastName"]').fill("");
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("必須項目（代理店・姓・名・生年月日・電話番号）を入力してください")
  ).toBeVisible({ timeout: 10_000 });

  // DBに登録されていないこと
  expect(await db().salesStaff.count({ where: { lastName } })).toBe(0);
});

test("申請フォーム: 生年月日の形式不正はサーバ側でエラーになり登録されない", async ({ page }) => {
  const lastName = P("日付");
  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("次郎");
  await page.locator('input[name="phone"]').fill("090-2222-3333");
  // type=dateのブラウザ制約を外し、不正形式をサーバへ直接送る（改ざん耐性の検証）。
  // ※React hydration がDOM改変を巻き戻すことがあるため、値が定着するまでポーリングする
  const birth = page.locator('input[name="birthDate"]');
  await expect
    .poll(
      async () => {
        await birth.evaluate((el) => {
          const i = el as HTMLInputElement;
          i.type = "text";
          i.value = "1991/13/99";
        });
        await page.waitForTimeout(400);
        return birth.evaluate((el) => {
          const i = el as HTMLInputElement;
          return `${i.type}:${i.value}`;
        });
      },
      { timeout: 15_000 }
    )
    .toBe("text:1991/13/99");
  await page.getByRole("button", { name: "申請する" }).click();

  await expect(
    page.getByText("生年月日は実在する日付を YYYY-MM-DD 形式で入力してください")
  ).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().salesStaff.count({ where: { lastName } })).toBe(0);
});

// =====================================================================
// 承認フロー（採番規則 / 一時PW / R9ログイン）
// =====================================================================

test("承認フロー: R7の1次承認→仮登録、R2の最終承認→本登録+{code}C{3桁}採番+一時PW→そのIDでログイン可", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const lastName = P("承認");
  const s1 = await agencyByCode("210001");
  await db().salesStaff.create({
    data: {
      lastName,
      firstName: "花子",
      birthDate: "1992-02-02",
      phone: "090-3333-4444",
      agencyId: s1.id,
      status: "applying",
      history: [{ event: "requested", at: "2026-08-05", by: "qa3" }],
    },
  });

  // --- R7が1次承認 → provisional(仮登録) ---
  await freshLogin(page, "R7");
  await gotoList(page, lastName);
  const rowR7 = rowFor(page, lastName);
  await expect(rowR7).toHaveCount(1);
  await rowR7.getByRole("button", { name: "1次承認" }).click();
  await expect(rowR7).toContainText("仮登録", { timeout: 10_000 });

  let staff = await db().salesStaff.findFirst({ where: { lastName } });
  expect(staff!.status).toBe("provisional");
  expect(staff!.firstApproved).toBe(true);
  expect(JSON.stringify(staff!.history)).toContain("approve_first");
  expect(staff!.salesId).toBeNull(); // 採番は最終承認時

  // --- R2が最終承認 → registered + 採番 + 一時パスワード一度だけ表示 ---
  const expectedId = await expectedNextSalesId("210001");
  await freshLogin(page, "R2");
  await gotoList(page, lastName);
  const rowR2 = rowFor(page, lastName);
  await rowR2.getByRole("button", { name: "最終承認" }).click();

  const panel = rowR2.locator("div.bg-emerald-50");
  await expect(panel).toContainText("本登録が完了しました", { timeout: 10_000 });
  const monoSpans = panel.locator("span.font-mono.font-bold");
  const shownId = (await monoSpans.nth(0).innerText()).trim();
  const tempPw = (await monoSpans.nth(1).innerText()).trim();
  issuedLoginIds.push(shownId);

  // 採番規則 {代理店code}C{3桁連番}
  expect(shownId).toMatch(/^210001C\d{3}$/);
  expect(shownId).toBe(expectedId);
  expect(tempPw.length).toBeGreaterThanOrEqual(14); // 一般アカウントの最小桁数以上

  // DB検証: 本登録 + salesId + R9アカウント発行
  staff = await db().salesStaff.findFirst({ where: { lastName } });
  expect(staff!.status).toBe("registered");
  expect(staff!.salesId).toBe(expectedId);
  expect(staff!.accountId).not.toBeNull();
  expect(JSON.stringify(staff!.history)).toContain("final_approve");
  const account = await db().account.findUnique({ where: { loginId: expectedId } });
  expect(account).not.toBeNull();
  expect(account!.role).toBe("R9");
  expect(account!.status).toBe("active");
  expect(account!.agencyId).toBe(s1.id);
  expect(account!.mustChangePassword).toBe(true); // 初回変更強制（§10.1）
  // 一覧にも本登録として表示
  await expect(rowR2).toContainText("本登録");

  // --- 発行されたIDでログイン可能（初回はパスワード変更を経て/dashboardへ、ロール⑨） ---
  await page.context().clearCookies();
  await rawLogin(page, shownId, tempPw);
  await page.waitForURL(/\/password/, { timeout: 15_000 }); // 初期PWからの変更強制
  const newPw = "Qa3-Approved-2026-Ok1";
  await page.locator('input[name="current"]').fill(tempPw);
  await page.locator('input[name="next"]').fill(newPw);
  await page.locator('input[name="confirm"]').fill(newPw);
  await page.getByRole("button", { name: "変更する" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
  await expect(page.getByText("代理店一般（販売員）").first()).toBeVisible(); // R9として認識

  expect(criticalErrors(errors)).toEqual([]);
});

test("自己承認: R2が自分で申請→自分で1次承認→最終承認まで完結できる（§6.2 ①②③の自己承認）", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const lastName = P("自己");
  const p2 = await agencyByCode("150008");

  await freshLogin(page, "R2");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await page.locator('select[name="agencyId"]').selectOption(p2.id);
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("五郎");
  await page.locator('input[name="birthDate"]').fill("1993-03-03");
  await page.locator('input[name="phone"]').fill("090-4444-5555");
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText(`${lastName} 五郎 さんの販売員IDを申請しました（申請中）`)
  ).toBeVisible({
    timeout: 10_000,
  });

  // 自分で1次承認
  await gotoList(page, lastName);
  const row = rowFor(page, lastName);
  await row.getByRole("button", { name: "1次承認" }).click();
  await expect(row).toContainText("仮登録", { timeout: 10_000 });

  // 自分で最終承認
  const expectedId = await expectedNextSalesId("150008");
  await row.getByRole("button", { name: "最終承認" }).click();
  const panel = row.locator("div.bg-emerald-50");
  await expect(panel).toContainText("本登録が完了しました", { timeout: 10_000 });
  const shownId = (await panel.locator("span.font-mono.font-bold").nth(0).innerText()).trim();
  issuedLoginIds.push(shownId);
  expect(shownId).toMatch(/^150008C\d{3}$/);
  expect(shownId).toBe(expectedId);

  // DB: 全イベントがR2自身によって記録されている
  const staff = await db().salesStaff.findFirst({ where: { lastName } });
  expect(staff!.status).toBe("registered");
  const history = staff!.history as { event: string; by: string }[];
  const byEvent = (ev: string) => history.find((h) => h.event === ev);
  expect(byEvent("requested")?.by).toBe(ACCOUNTS.R2.loginId);
  expect(byEvent("approve_first")?.by).toBe(ACCOUNTS.R2.loginId);
  expect(byEvent("final_approve")?.by).toBe(ACCOUNTS.R2.loginId);
});

// =====================================================================
// 停止 / 再開 / 削除 / 復旧（自作データで実施。シード行は破壊しない）
// =====================================================================

async function createRegisteredStaff(lastName: string, loginId: string, password: string) {
  const p2 = await agencyByCode("150008");
  const account = await db().account.create({
    data: {
      loginId,
      role: "R9",
      name: `${lastName} 六郎`,
      agencyId: p2.id,
      status: "active",
      passwordHash: bcrypt.hashSync(password, 4),
      mustChangePassword: false,
    },
  });
  const staff = await db().salesStaff.create({
    data: {
      salesId: loginId, // {code}C 採番系列を汚さない QA3 形式のID
      lastName,
      firstName: "六郎",
      birthDate: "1994-04-04",
      phone: "090-5555-6666",
      agencyId: p2.id,
      status: "registered",
      firstApproved: true,
      accountId: account.id,
      history: [{ event: "requested", at: "2026-08-05", by: "qa3" }],
    },
  });
  return { account, staff };
}

test("停止→Accountもsuspended（ログイン不可）→再開→ログイン可", async ({ page }) => {
  test.setTimeout(90_000);
  const lastName = P("停止");
  const loginId = `QA3S${RUN}`;
  const password = "Qa3-Suspend-2026-Ok1";
  await createRegisteredStaff(lastName, loginId, password);

  // 事前確認: 停止前はログインできる
  await page.context().clearCookies();
  await rawLogin(page, loginId, password);
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

  // R2が停止
  await freshLogin(page, "R2");
  await gotoList(page, lastName);
  const row = rowFor(page, lastName);
  await row.getByRole("button", { name: "停止" }).click();
  await expect(row).toContainText("停止中", { timeout: 10_000 });

  const d = db();
  expect((await d.salesStaff.findFirst({ where: { lastName } }))!.status).toBe("suspended");
  expect((await d.account.findUnique({ where: { loginId } }))!.status).toBe("suspended");

  // 停止中はログイン不可
  await page.context().clearCookies();
  await rawLogin(page, loginId, password);
  await expect(page.getByText("IDまたはパスワードが正しくありません")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/login/);

  // R2が再開 → 本登録に戻り、ログイン可
  await freshLogin(page, "R2");
  await gotoList(page, lastName);
  await rowFor(page, lastName).getByRole("button", { name: "再開" }).click();
  await expect(rowFor(page, lastName)).toContainText("本登録", { timeout: 10_000 });
  expect((await d.salesStaff.findFirst({ where: { lastName } }))!.status).toBe("registered");
  expect((await d.account.findUnique({ where: { loginId } }))!.status).toBe("active");

  await page.context().clearCookies();
  await rawLogin(page, loginId, password);
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);
});

test("削除→deleted+deletedAt設定（論理削除・Account停止）→復旧", async ({ page }) => {
  test.setTimeout(60_000);
  const lastName = P("削除");
  const loginId = `QA3D${RUN}`;
  await createRegisteredStaff(lastName, loginId, "Qa3-Delete-2026-Ok1");

  await freshLogin(page, "R2");
  await gotoList(page, lastName);
  page.on("dialog", (dlg) => dlg.accept()); // 削除確認ダイアログを承諾
  const row = rowFor(page, lastName);
  await row.getByRole("button", { name: "削除" }).click();
  await expect(row).toContainText("削除済", { timeout: 10_000 });

  const d = db();
  let staff = await d.salesStaff.findFirst({ where: { lastName } });
  expect(staff!.status).toBe("deleted");
  expect(staff!.deletedAt).not.toBeNull(); // 論理削除（物理削除しない）
  expect((await d.account.findUnique({ where: { loginId } }))!.status).toBe("suspended");
  expect(JSON.stringify(staff!.history)).toContain("delete");

  // 復旧（deleted → 復旧後は削除済でなくなり deletedAt が解除される）
  await row.getByRole("button", { name: "復旧" }).click();
  await expect(row).not.toContainText("削除済", { timeout: 10_000 });
  staff = await d.salesStaff.findFirst({ where: { lastName } });
  expect(staff!.status).not.toBe("deleted");
  expect(staff!.deletedAt).toBeNull();
  expect(JSON.stringify(staff!.history)).toContain("restore");
});

// =====================================================================
// スコープ（§3.1）
// =====================================================================

test("スコープ: R8(210001)の一覧・フィルタには自店のみ表示される", async ({ page }) => {
  await freshLogin(page, "R8");
  await gotoList(page);

  // 代理店フィルタの選択肢は自店のみ
  const opts = await page.locator('select[name="agency"] option').allTextContents();
  expect(opts.some((t) => t.includes("210001"))).toBe(true);
  expect(opts.some((t) => t.includes("110001"))).toBe(false);
  expect(opts.some((t) => t.includes("210002"))).toBe(false);
  expect(opts.some((t) => t.includes("150008"))).toBe(false);

  // 他店（110001）の販売員は検索してもヒットしない
  await gotoList(page, "営業");
  await expect(page.getByText("条件に一致する販売員がいません。")).toBeVisible();

  // 自店の販売員は見える（シード: 販売 一郎 210001C001。検索は販売員IDで一意に特定）
  await gotoList(page, "210001C001");
  await expect(rowFor(page, "販売 一郎")).toHaveCount(1);
  await expect(rowFor(page, "販売 一郎")).toContainText("210001");
});

test("スコープ: R7(110001)は自店+配下2店のみ表示される", async ({ page }) => {
  await freshLogin(page, "R7");
  await gotoList(page);

  const opts = await page.locator('select[name="agency"] option').allTextContents();
  expect(opts.some((t) => t.includes("110001"))).toBe(true);
  expect(opts.some((t) => t.includes("210001"))).toBe(true);
  expect(opts.some((t) => t.includes("210002"))).toBe(true);
  expect(opts.some((t) => t.includes("150008"))).toBe(false);
  expect(opts.some((t) => t.includes("990001"))).toBe(false);

  // 自店（110001: 営業 太郎）・配下（210002: 現場 三子）は見える（販売員IDで検索）
  await gotoList(page, "110001C001");
  await expect(rowFor(page, "営業 太郎")).toHaveCount(1);
  await gotoList(page, "210002C001");
  await expect(rowFor(page, "現場 三子")).toHaveCount(1);

  // 他の1次店（150008: 関西 四郎）は見えない
  await gotoList(page, "関西");
  await expect(page.getByText("条件に一致する販売員がいません。")).toBeVisible();
});

test("スコープ: R2は全店を閲覧できるがダミー(990001系)は出ない", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await freshLogin(page, "R2");
  await gotoList(page);
  // 説明バナーに全店（110001系・150008系）が操作対象として並ぶ
  const banner = page.getByText(/操作可能な代理店|全代理店の販売員ID/);
  await expect(banner).toBeVisible();

  const opts = await page.locator('select[name="agency"] option').allTextContents();
  expect(opts.some((t) => t.includes("110001"))).toBe(true);
  expect(opts.some((t) => t.includes("150008"))).toBe(true);
  expect(opts.some((t) => t.includes("990001"))).toBe(false);
  expect(opts.some((t) => t.includes("991001"))).toBe(false);

  // 実データ（関西 四郎 150008C001）は見える
  await gotoList(page, "150008C001");
  await expect(rowFor(page, "関西 四郎")).toHaveCount(1);

  // ダミー販売員（見本）は検索してもヒットしない
  await gotoList(page, "見本");
  await expect(page.getByText("条件に一致する販売員がいません。")).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

// =====================================================================
// 検索・フィルタ・ページネーション表記
// =====================================================================

test("検索・代理店フィルタ・状態フィルタ・ページネーション表記", async ({ page }) => {
  test.setTimeout(60_000);
  const base = P("絞");
  const p2 = await agencyByCode("150008");
  const s3 = await agencyByCode("250008");
  await db().salesStaff.create({
    data: {
      lastName: `${base}A`,
      firstName: "甲",
      birthDate: "1990-01-01",
      phone: "090-7777-0001",
      agencyId: p2.id,
      status: "applying",
    },
  });
  await db().salesStaff.create({
    data: {
      lastName: `${base}B`,
      firstName: "乙",
      birthDate: "1990-01-02",
      phone: "090-7777-0002",
      agencyId: s3.id,
      status: "provisional",
      firstApproved: true,
    },
  });

  await freshLogin(page, "R2");

  // 検索フォームから検索（2件ヒット + 件数表記 + ページネーション表記）
  await gotoList(page);
  await page.locator('input[name="q"]').fill(base);
  await page.getByRole("button", { name: "絞り込み" }).click();
  await page.waitForURL(/q=/, { timeout: 10_000 });
  await expect(page.getByText(`販売員一覧（全2件）`)).toBeVisible();
  await expect(page.getByText("全2件中 1〜2件を表示")).toBeVisible();
  await expect(page.getByText("1 / 1 ページ")).toBeVisible();
  await expect(page.getByText("← 前へ")).toBeVisible();
  await expect(page.getByText("次へ →")).toBeVisible();

  // 代理店フィルタ: 150008に絞る → Aのみ
  await page.goto(`/sales-staff?q=${encodeURIComponent(base)}&agency=${p2.id}`);
  await expect(rowFor(page, `${base}A`)).toHaveCount(1);
  await expect(rowFor(page, `${base}B`)).toHaveCount(0);
  await expect(page.getByText(`販売員一覧（全1件）`)).toBeVisible();

  // 状態フィルタ: 仮登録に絞る → Bのみ
  await page.goto(`/sales-staff?q=${encodeURIComponent(base)}&status=provisional`);
  await expect(rowFor(page, `${base}B`)).toHaveCount(1);
  await expect(rowFor(page, `${base}A`)).toHaveCount(0);

  // 状態フィルタ: 申請中 → Aのみ
  await page.goto(`/sales-staff?q=${encodeURIComponent(base)}&status=applying`);
  await expect(rowFor(page, `${base}A`)).toHaveCount(1);
  await expect(rowFor(page, `${base}B`)).toHaveCount(0);
});

// =====================================================================
// CSV（ひな形DL / 一括申請 / 一覧出力 / GiGaCC）
// =====================================================================

const CSV_HEADER = "姓,名,生年月日,電話番号,代理店コード,メールアドレス";

test("CSVひな形DL: ヘッダが 姓,名,生年月日,電話番号,代理店コード,メールアドレス", async ({
  page,
}) => {
  await freshLogin(page, "R8");
  const res = await page.request.get("/sales-staff/csv/template");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"] ?? "").toContain(
    encodeURIComponent("販売員ID一括申請ひな形.csv")
  );
  const body = (await res.text()).replace(/^﻿/, "");
  expect(body.split(/\r?\n/)[0]).toBe(CSV_HEADER);
});

test("CSV一括申請: 正常2行→2件とも申請中で登録される", async ({ page }) => {
  const nameA = P("CSV甲");
  const nameB = P("CSV乙");
  const csv = [
    CSV_HEADER,
    `${nameA},一郎,1990-01-01,090-0000-0001,210001,`,
    `${nameB},二郎,1991-02-02,090-0000-0002,210001,csv2@example.com`,
  ].join("\r\n");

  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "CSV一括申請" }).click();
  await page.locator('input[name="file"]').setInputFiles({
    name: "bulk.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await page.getByRole("button", { name: "一括申請する" }).click();
  await expect(page.getByText("2件の販売員ID申請を登録しました（申請中）")).toBeVisible({
    timeout: 15_000,
  });

  const s1 = await agencyByCode("210001");
  const rows = await db().salesStaff.findMany({ where: { lastName: { in: [nameA, nameB] } } });
  expect(rows.length).toBe(2);
  for (const r of rows) {
    expect(r.status).toBe("applying");
    expect(r.agencyId).toBe(s1.id);
    expect(r.source).toBe("csv");
  }
  const b = rows.find((r) => r.lastName === nameB)!;
  expect(b.email).toBe("csv2@example.com");
});

test("CSV一括申請: 3行中1行不正（生年月日）→ 全件拒否+「3行目」エラー表示", async ({ page }) => {
  const names = [P("ERR甲"), P("ERR乙"), P("ERR丙")];
  const csv = [
    CSV_HEADER,
    `${names[0]},一,1990-01-01,090-0000-0011,210001,`,
    `${names[1]},二,1990/01/01,090-0000-0012,210001,`, // 生年月日形式不正（3行目）
    `${names[2]},三,1992-03-03,090-0000-0013,210001,`,
  ].join("\r\n");

  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "CSV一括申請" }).click();
  await page.locator('input[name="file"]').setInputFiles({
    name: "bulk-error.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
  await page.getByRole("button", { name: "一括申請する" }).click();

  await expect(page.getByText("取込エラー（全件登録されていません）")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/3行目.*生年月日/)).toBeVisible();

  // 正常な1・3行目も含め全件登録されていない（§3.6 全件ロールバック）
  expect(await db().salesStaff.count({ where: { lastName: { in: names } } })).toBe(0);
});

test("販売員一覧CSV出力: R8はスコープ内（自店210001）のみ出力される", async ({ page }) => {
  await freshLogin(page, "R8");
  const res = await page.request.get("/sales-staff/csv/list");
  expect(res.status()).toBe(200);
  const body = (await res.text()).replace(/^﻿/, "");
  const lines = body.trim().split(/\r?\n/);
  expect(lines[0]).toBe(
    "販売員ID,姓,名,生年月日,電話番号,メールアドレス,代理店コード,代理店名,ステータス,1次承認済み,最終更新"
  );
  const dataLines = lines.slice(1);
  expect(dataLines.length).toBeGreaterThan(0);
  for (const line of dataLines) {
    expect(line.split(",")[6]).toBe("210001"); // 代理店コード列: 全行が自店
  }
  expect(body).toContain("販売,一郎"); // 自店シード行を含む
  expect(body).not.toContain("営業,太郎"); // 他店（110001）は含まない
  expect(body).not.toContain("関西,四郎"); // 他1次店（150008）は含まない
});

test("GiGaCC連携CSV出力: 本登録のみが含まれる（仮登録・申請中・ダミーは含まない）", async ({
  page,
}) => {
  const regName = P("G本");
  const provName = P("G仮");
  const p2 = await agencyByCode("150008");
  const regSalesId = `QA3G${RUN}`;
  await db().salesStaff.create({
    data: {
      salesId: regSalesId,
      lastName: regName,
      firstName: "登",
      birthDate: "1990-06-06",
      phone: "090-8888-0001",
      agencyId: p2.id,
      status: "registered",
      firstApproved: true,
    },
  });
  await db().salesStaff.create({
    data: {
      lastName: provName,
      firstName: "仮",
      birthDate: "1990-07-07",
      phone: "090-8888-0002",
      agencyId: p2.id,
      status: "provisional",
      firstApproved: true,
    },
  });

  await freshLogin(page, "R2");
  const res = await page.request.get("/sales-staff/csv/gigacc");
  expect(res.status()).toBe(200);
  const body = (await res.text()).replace(/^﻿/, "");
  const lines = body.trim().split(/\r?\n/);
  expect(lines[0]).toBe("販売員ID,姓,名,生年月日,電話番号,代理店コード,代理店名");

  // 本登録は含まれる / 仮登録は含まれない / ダミーは含まれない
  expect(body).toContain(regSalesId);
  expect(body).toContain(regName);
  expect(body).not.toContain(provName);
  expect(body).not.toContain("見本");
  expect(body).not.toContain("990001");

  // CSV本文の全販売員IDがDB上で本登録であることを突合
  const ids = lines
    .slice(1)
    .map((l) => l.split(",")[0])
    .filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  const staffRows = await db().salesStaff.findMany({ where: { salesId: { in: ids } } });
  expect(staffRows.length).toBe(ids.length);
  for (const s of staffRows) expect(s.status).toBe("registered");
});

// =====================================================================
// R4ダミー表示・権限外アクセス・存在しないID
// =====================================================================

test("R4(閲覧): ダミーデータ(990001系)のみ表示され、操作ボタンが出ない", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await freshLogin(page, "R4");
  await gotoList(page);
  await expect(page.getByRole("heading", { name: "販売員ID管理" })).toBeVisible();

  // ダミー販売員のみ表示（シードの見本3名）
  await expect(rowFor(page, "見本 販売員1")).toHaveCount(1);
  await expect(page.locator("tbody tr", { hasText: "営業 太郎" })).toHaveCount(0);
  await expect(page.locator("tbody tr", { hasText: "関西 四郎" })).toHaveCount(0);
  const rows = page.locator("tbody tr");
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    await expect(rows.nth(i)).toContainText("見本"); // 全行がダミーデータ
  }

  // 操作UIが一切出ない（閲覧のみ）
  await expect(page.getByText("閲覧のみ").first()).toBeVisible();
  await expect(page.locator("summary", { hasText: "＋ 販売員ID申請" })).toHaveCount(0);
  await expect(page.locator("summary", { hasText: "CSV一括申請" })).toHaveCount(0);
  for (const name of ["1次承認", "最終承認", "停止", "再開", "削除", "復旧"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  }

  expect(criticalErrors(errors)).toEqual([]);
});

test("権限外アクセス: R9・R5が/sales-staffへ直接アクセスするとダッシュボードへ、未ログインは/loginへ", async ({
  page,
}) => {
  test.setTimeout(60_000);
  // R9（販売員）
  await freshLogin(page, "R9");
  await page.goto("/sales-staff");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);
  // サイドメニューにも出ない
  await expect(page.locator("aside, nav").getByText("販売員ID管理")).toHaveCount(0);

  // R5（HL窓口）
  await freshLogin(page, "R5");
  await page.goto("/sales-staff");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);

  // 未ログイン
  await page.context().clearCookies();
  await page.goto("/sales-staff");
  await page.waitForURL(/\/login/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/login/);
});

test("異常系: 存在しないIDではログインできない", async ({ page }) => {
  await page.context().clearCookies();
  await rawLogin(page, `QA3-ghost-${RUN}`, PW_GENERAL);
  await expect(page.getByText("IDまたはパスワードが正しくありません")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/login/);
});

// ================================================================
// 年齢制限（発注者指示 2026-08-05）: 生年月日のデフォルトは「15年前の今日」、
// 15歳未満（それより後の生年月日）は「15歳未満の方は申請できません」
// ================================================================
// 「15年前の今日」（JST）。src/lib/age.ts の fifteenYearsAgo と同じ規則を独立に再計算する
function cutoffBirthDate(): string {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  const y = jst.getUTCFullYear() - 15;
  const m = jst.getUTCMonth() + 1;
  const d = jst.getUTCDate();
  const isLeap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const day = m === 2 && d === 29 && !isLeap(y) ? 28 : d;
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

test("申請フォーム: 生年月日のデフォルトは15年前の今日（2026年時点=2011年の今日）", async ({
  page,
}) => {
  // R8は所属代理店が自店固定のためフォーム入力が最小で済む
  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await expect(page.locator('input[name="birthDate"]')).toHaveValue(cutoffBirthDate());
});

test("申請フォーム: 15歳未満の生年月日は「15歳未満の方は申請できません」", async ({ page }) => {
  const lastName = P("未成年");
  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("十四歳");
  await page.locator('input[name="phone"]').fill("090-1111-0014");
  // 締切日の翌日 = 15歳の誕生日前日（14歳）
  const cutoff = new Date(`${cutoffBirthDate()}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 1);
  await page.locator('input[name="birthDate"]').fill(cutoff.toISOString().slice(0, 10));
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText("15歳未満の方は申請できません")).toBeVisible({ timeout: 10_000 });
  expect(await db().salesStaff.count({ where: { lastName } })).toBe(0);
});

test("申請フォーム: ちょうど15歳（15年前の今日）は申請できる（境界）", async ({ page }) => {
  const lastName = P("十五歳");
  await freshLogin(page, "R8");
  await gotoList(page);
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("ちょうど");
  await page.locator('input[name="phone"]').fill("090-1111-0015");
  await page.locator('input[name="birthDate"]').fill(cutoffBirthDate());
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText(`${lastName} ちょうど さんの販売員IDを申請しました（申請中）`)
  ).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().salesStaff.count({ where: { lastName } })).toBe(1);
});
