// QA独立判定: OWN-015〜OWN-028（発注者追加指示 2026-08-05）の実機検証
// データプレフィクス: QA9（作成データは afterAll/各テスト末尾で削除）
import { test, expect, Browser, Page } from "@playwright/test";
import { generateSync } from "otplib";
import { ACCOUNTS, PW_GENERAL, db, login, RoleKey } from "./helpers";

const RUN = Date.now().toString(36);

// 使い捨てコンテキストでログイン済みページを作る
async function loginNewContext(browser: Browser, role: RoleKey): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, role);
  return page;
}

test.afterAll(async () => {
  // QA9プレフィクスの作成データを削除して原状回復
  const d = db();
  const cases = await d.case.findMany({
    where: { OR: [{ title: { contains: "QA9" } }, { ispNumber: { contains: "QA9" } }] },
    select: { id: true },
  });
  for (const c of cases) {
    await d.caseMessage.deleteMany({ where: { caseId: c.id } });
    await d.caseStatusHistory.deleteMany({ where: { caseId: c.id } });
    await d.caseRead.deleteMany({ where: { caseId: c.id } });
    await d.notification.deleteMany({ where: { link: { contains: c.id } } });
    await d.case.delete({ where: { id: c.id } });
  }
  await d.storedFile.deleteMany({ where: { name: { startsWith: "QA9" } } });
  await d.accountRequest.deleteMany({
    where: { OR: [{ requestId: { startsWith: "QA9-" } }, { name: { contains: "QA9" } }] },
  });
  await d.account.deleteMany({ where: { loginId: { startsWith: "QA9_" } } });
  await d.salesStaff.deleteMany({ where: { lastName: { contains: "QA9" } } });
  const staff = await d.salesStaff.findFirst({ where: { salesId: "110001C001" } });
  if (staff) {
    await d.dailyReport.deleteMany({
      where: { salesStaffId: staff.id, date: "2026-08-23", type: "訪販" },
    });
  }
});

// ================================================================
// OWN-015: ログインの入力ゆらぎ吸収（前後空白 / 全角英数 / 引用符）+ 誤PW拒否
// ================================================================
test("OWN-015: 前後空白・全角・引用符付きパスワードは受理、誤パスワードは拒否", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const tryLogin = async (pw: string) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(ACCOUNTS.R9.loginId);
    await page.locator('input[name="password"]').fill(pw);
    await page.getByRole("button", { name: "ログイン" }).click();
    // パスワード受理 = /mfa または /dashboard に遷移。拒否 = /login に留まりエラー表示
    await page.waitForURL(/\/(mfa|dashboard)/, { timeout: 8_000 }).catch(() => {});
    const url = new URL(page.url()).pathname;
    const accepted = /^\/(mfa|dashboard)/.test(url);
    let errorText = "";
    if (!accepted) {
      errorText =
        (await page.getByText("IDまたはパスワードが正しくありません").count()) > 0
          ? "IDまたはパスワードが正しくありません"
          : (await page.locator("body").innerText()).slice(0, 200);
    }
    return { ctx, page, accepted, errorText };
  };

  // 1) 前後空白 → 受理（MFAまで完走してダッシュボード到達を確認）
  const r1 = await tryLogin(`  ${PW_GENERAL}  `);
  expect(r1.accepted, "前後空白付きが拒否された").toBe(true);
  const acc = await db().account.findUnique({ where: { loginId: ACCOUNTS.R9.loginId } });
  await r1.page.locator('input[name="code"]').fill(generateSync({ secret: acc!.mfaSecret! }));
  await r1.page.getByRole("button", { name: /登録して続行|認証する/ }).click();
  await r1.page.waitForURL(/\/(dashboard|password)/, { timeout: 15_000 });
  await r1.ctx.close();

  // 2) 全角英数記号 → 受理（パスワード段階通過= /mfa 到達で判定）
  const zenkaku = "Ａｉｒｉｓ－Ｄｅｍｏ－２０２６！"; // NFKC → Airis-Demo-2026!
  const r2 = await tryLogin(zenkaku);
  expect(r2.accepted, "全角英数が拒否された").toBe(true);
  await r2.ctx.close();

  // 3) 引用符ごと貼り付け → 受理
  const r3 = await tryLogin(`"${PW_GENERAL}"`);
  expect(r3.accepted, "引用符付きが拒否された").toBe(true);
  await r3.ctx.close();

  // 4) 誤パスワード → 拒否
  const r4 = await tryLogin("Airis-Demo-2026?");
  expect(r4.accepted, "誤パスワードが受理された").toBe(false);
  expect(r4.errorText).toContain("IDまたはパスワードが正しくありません");
  await r4.ctx.close();

  // 5) 誤パスワードを引用符で包んでも拒否
  const r5 = await tryLogin('"Wrong-Demo-2026!"');
  expect(r5.accepted, "引用符付き誤パスワードが受理された").toBe(false);
  await r5.ctx.close();
});

// ================================================================
// OWN-016: 日報の再選択でプリフィル・編集モード表示・1項目変更で他項目保持
// ================================================================
test("OWN-016: 提出済み日報のプリフィルと部分更新の保持", async ({ page }) => {
  test.setTimeout(120_000);
  const DATE = "2026-08-23";
  const staff = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  await db().dailyReport.deleteMany({
    where: { salesStaffId: staff!.id, date: DATE, type: "訪販" },
  });

  await login(page, "R9");
  await page.goto("/reports");
  await page.locator('input[name="date"]').fill(DATE);
  await page.locator('input[name="area"]').fill(`QA9エリア${RUN}`);
  const initial = {
    acquisitions: "7",
    workers: "3",
    visits: "31",
    meetings: "9",
    negotiations: "5",
    contracts: "2",
  } as const;
  for (const [name, v] of Object.entries(initial)) {
    await page.locator(`input[name="${name}"]`).fill(v);
  }
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${DATE} の訪販日報を保存しました`)).toBeVisible({ timeout: 10_000 });

  // 再読込して同じ販売員×日付×タイプを選択 → プリフィル＋編集モード表示
  await page.goto("/reports");
  await page.locator('input[name="date"]').fill(DATE);
  await expect(page.getByText("提出済み日報を読み込みました（編集モード）")).toBeVisible();
  await expect(page.locator('input[name="acquisitions"]')).toHaveValue("7");
  await expect(page.locator('input[name="visits"]')).toHaveValue("31");
  await expect(page.locator('input[name="area"]')).toHaveValue(`QA9エリア${RUN}`);

  // 1項目（visits）だけ変更して保存
  await page.locator('input[name="visits"]').fill("32");
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${DATE} の訪販日報を保存しました`)).toBeVisible({ timeout: 10_000 });

  const rec = await db().dailyReport.findFirst({
    where: { salesStaffId: staff!.id, date: DATE, type: "訪販" },
  });
  expect(rec?.visits).toBe(32);
  expect(rec?.acquisitions).toBe(7);
  expect(rec?.workers).toBe(3);
  expect(rec?.meetings).toBe(9);
  expect(rec?.negotiations).toBe(5);
  expect(rec?.contracts).toBe(2);
  expect(rec?.area).toBe(`QA9エリア${RUN}`);

  await db().dailyReport.deleteMany({
    where: { salesStaffId: staff!.id, date: DATE, type: "訪販" },
  });
});

// ================================================================
// OWN-017: 棚卸CSVに「削除日時」列があり、削除済みアカウント行に値が入る
// ================================================================
test("OWN-017: 棚卸CSVの削除日時列と削除済み行の値", async ({ page }) => {
  await login(page, "R2");
  const res = await page.request.get("/admin/csv?type=inventory");
  expect(res.status()).toBe(200);
  const text = (await res.text()).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(",").map((s) => s.replace(/^"|"$/g, ""));
  const delIdx = header.indexOf("削除日時");
  expect(delIdx, `ヘッダに削除日時列がない: ${lines[0]}`).toBeGreaterThanOrEqual(0);

  // 削除済みアカウント（シードの airis_snc_spt2_900 / deletedAt=2026-06-20）の行に値が入る
  const delRow = lines.find((l) => l.includes("airis_snc_spt2_900"));
  expect(delRow, "削除済みアカウントの行がCSVに無い").toBeTruthy();
  const cols = delRow!.split(",").map((s) => s.replace(/^"|"$/g, ""));
  // シードの削除済みアカウントは deletedAt=2026-06-20（JST表記で出力される）
  expect(cols[delIdx], `削除日時が空: ${delRow}`).toMatch(/^2026-06-20 \d{2}:\d{2}$/);

  // 有効アカウントの行は削除日時が空
  const aliveRow = lines.find((l) => l.startsWith("airis_snc_adm_001"));
  expect(aliveRow).toBeTruthy();
  expect(aliveRow!.split(",").map((s) => s.replace(/^"|"$/g, ""))[delIdx]).toBe("");
});

// ================================================================
// OWN-018: docx/pptx/msg 添付の受理・20MB上限・不許可形式の拒否
// ================================================================
test("OWN-018: Office/msg添付は受理、20MB超・不許可形式は拒否", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "R5");

  // 1) docx/pptx/msg を添付して起票 → 受理・詳細に表示
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("フリー入力");
  const p1 = await db().agency.findUnique({ where: { code: "110001" } });
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="title"]').fill(`QA9添付形式${RUN}`);
  await page.locator('textarea[name="body"]').fill("QA9 添付形式検証");
  await page.locator('input[name="files"]').setInputFiles([
    {
      name: `QA9book${RUN}.docx`,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("PK docx qa9"),
    },
    {
      name: `QA9slide${RUN}.pptx`,
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      buffer: Buffer.from("PK pptx qa9"),
    },
    {
      name: `QA9mail${RUN}.msg`,
      mimeType: "application/vnd.ms-outlook",
      buffer: Buffer.from("msg qa9"),
    },
  ]);
  await page.getByRole("button", { name: "起票する" }).click();
  await page.waitForURL(/\/hotline\/[a-z0-9]+$/, { timeout: 20_000 });
  await expect(page.getByText(`QA9book${RUN}.docx`)).toBeVisible();
  await expect(page.getByText(`QA9slide${RUN}.pptx`)).toBeVisible();
  await expect(page.getByText(`QA9mail${RUN}.msg`)).toBeVisible();
  const stored = await db().storedFile.findFirst({ where: { name: `QA9book${RUN}.docx` } });
  expect(stored?.mime).toBe(
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );

  // 2) 不許可形式（.exe）→ 拒否・案件は作られない
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("フリー入力");
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="title"]').fill(`QA9不許可${RUN}`);
  await page.locator('textarea[name="body"]').fill("QA9 不許可形式");
  await page
    .locator('input[name="files"]')
    .setInputFiles([
      { name: `QA9bad${RUN}.exe`, mimeType: "application/octet-stream", buffer: Buffer.from("MZ") },
    ]);
  await page.getByRole("button", { name: "起票する" }).click();
  await expect(
    page.getByText("この形式のファイルは受け付けられません", { exact: false })
  ).toBeVisible({ timeout: 15_000 });
  expect(await db().case.count({ where: { title: `QA9不許可${RUN}` } })).toBe(0);

  // 3) 20MB超（21MB）→ 拒否・案件は作られない
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("フリー入力");
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="title"]').fill(`QA9超過${RUN}`);
  await page.locator('textarea[name="body"]').fill("QA9 サイズ超過");
  await page.locator('input[name="files"]').setInputFiles([
    {
      name: `QA9big${RUN}.pdf`,
      mimeType: "application/pdf",
      buffer: Buffer.alloc(21 * 1024 * 1024, 65),
    },
  ]);
  await page.getByRole("button", { name: "起票する" }).click();
  await expect(page.getByText("ファイルは20MB以下にしてください", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  expect(await db().case.count({ where: { title: `QA9超過${RUN}` } })).toBe(0);
});

// ================================================================
// OWN-019: 起票時の販売員ID紐付け保存・表示、対象代理店外の販売員は拒否
// ================================================================
test("OWN-019: 販売員ID保存・表示と代理店外販売員の拒否", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R5");

  // 1) 正常系: 110001配下の販売員 110001C001 を紐付けて起票
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("音声提出依頼");
  const p1 = await db().agency.findUnique({ where: { code: "110001" } });
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  const staff = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  await page.locator('select[name="salesStaffId"]').selectOption(staff!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="ispNumber"]').fill(`QA9-OWN19-${RUN}`);
  await page.getByRole("button", { name: "起票する" }).click();
  await page.waitForURL(/\/hotline\/[a-z0-9]+$/, { timeout: 20_000 });
  const caseId = new URL(page.url()).pathname.split("/").pop()!;
  // 詳細画面に販売員IDが表示される
  await expect(page.getByText("110001C001", { exact: false }).first()).toBeVisible();
  // DBに保存されている
  const dbCase = await db().case.findUnique({ where: { id: caseId } });
  expect(dbCase?.salesStaffId).toBe(staff!.id);

  // 2) 異常系: 一次代理店=150008（関西）に 110001 配下の販売員を指定（改ざん送信）→ 拒否
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("音声提出依頼");
  const kansai = await db().agency.findUnique({ where: { code: "150008" } });
  await page.locator('select[name="primaryAgencyId"]').selectOption(kansai!.id);
  // クライアント側の絞り込みを回避してoptionを注入
  await page.locator('select[name="salesStaffId"]').evaluate((el, staffId) => {
    const opt = document.createElement("option");
    opt.value = staffId as string;
    opt.textContent = "tampered";
    (el as HTMLSelectElement).appendChild(opt);
    (el as HTMLSelectElement).value = staffId as string;
  }, staff!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="title"]').fill(`QA9代理店外${RUN}`);
  await page.locator('textarea[name="body"]').fill("QA9 代理店外販売員の拒否検証");
  await page.getByRole("button", { name: "起票する" }).click();
  await expect(page.getByText("指定した販売員は対象代理店に所属していません")).toBeVisible({
    timeout: 15_000,
  });
  expect(await db().case.count({ where: { title: `QA9代理店外${RUN}` } })).toBe(0);
});

// ================================================================
// OWN-020: 一覧に代理店別×ステータス集計と月別起票件数（直近6ヶ月）
// ================================================================
test("OWN-020: 集計表と月別件数がDB実数と一致して表示される", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, "R5");

  // DB実数（HL・110001の合計と当月起票数）
  const p1 = await db().agency.findUnique({ where: { code: "110001" } });
  const agencyTotal = await db().case.count({ where: { series: "HL", primaryAgencyId: p1!.id } });
  const nowJst = new Date(Date.now() + 9 * 3600 * 1000);
  const monthKey = nowJst.toISOString().slice(0, 7); // 2026-08
  const monthStartUtc = new Date(Date.parse(`${monthKey}-01T00:00:00+09:00`));
  const monthCount = await db().case.count({
    where: { series: "HL", createdAt: { gte: monthStartUtc } },
  });

  await page.goto("/hotline");
  await expect(page.getByText("集計", { exact: true })).toBeVisible();
  await expect(page.getByText("代理店別×ステータス")).toBeVisible();
  await expect(page.getByText("月別起票件数（直近6ヶ月）")).toBeVisible();

  // 110001行の合計セル（最終td）がDB実数と一致
  const row = page.locator("table tr", { hasText: "110001" }).first();
  await expect(row).toBeVisible();
  const lastCell = row.locator("td").last();
  await expect(lastCell).toHaveText(String(agencyTotal));

  // 月別グラフ: 6ヶ月分のラベルがあり、当月の件数がDB実数と一致
  const monthLabel = monthKey.slice(2); // "26-08"
  await expect(page.getByText(monthLabel, { exact: true })).toBeVisible();
  const monthCol = page
    .locator("div.flex.flex-1.flex-col", { hasText: monthLabel })
    .first()
    .locator("span")
    .first();
  await expect(monthCol).toHaveText(String(monthCount));

  // R2（SNC管理者）でも消費者センター側に集計が表示される
  const p2 = await loginNewContext(browser, "R2");
  await p2.goto("/consumer-center");
  await expect(p2.getByText("集計", { exact: true })).toBeVisible();
  await expect(p2.getByText("代理店別×ステータス")).toBeVisible();
  await expect(p2.getByText("月別起票件数（直近6ヶ月）")).toBeVisible();
  await p2.context().close();
});

// ================================================================
// OWN-021: 起票時添付の保存表示・担当者設定（SNC系のみ）＋監査・代理店メール表示
// ================================================================
test("OWN-021: 起票時添付・担当者変更（監査記録）・代理店メール表示", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R5");
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("音声提出依頼");
  const p1 = await db().agency.findUnique({ where: { code: "110001" } });
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  const staff = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  await page.locator('select[name="salesStaffId"]').selectOption(staff!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="ispNumber"]').fill(`QA9-OWN21-${RUN}`);
  await page.locator('input[name="files"]').setInputFiles({
    name: `QA9attach${RUN}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa9 own21"),
  });
  await page.getByRole("button", { name: "起票する" }).click();
  await page.waitForURL(/\/hotline\/[a-z0-9]+$/, { timeout: 20_000 });
  const caseId = new URL(page.url()).pathname.split("/").pop()!;

  // 起票時添付が保存・表示される
  await expect(page.getByText(`QA9attach${RUN}.pdf`)).toBeVisible();

  // 代理店メール（⑦）の表示
  await expect(page.getByText("代理店メール（⑦管理者）")).toBeVisible();
  await expect(page.getByText("airis_1110001_001@example.com", { exact: false })).toBeVisible();

  // 担当者候補はSNC系のみ（代理店アカウントが混じらない）
  const options = await page.locator('select[name="assigneeAccountId"] option').allTextContents();
  expect(
    options.some(
      (o) => o.includes("airis_1110001") || o.includes("airis_2210001") || o.includes("110001C")
    )
  ).toBe(false);
  expect(options.some((o) => o.includes("airis_snc_ops_0001"))).toBe(true);

  // 担当者をR3（SNC運用者）へ設定 → DB反映・監査記録
  const r3 = await db().account.findUnique({ where: { loginId: ACCOUNTS.R3.loginId } });
  await page.locator('select[name="assigneeAccountId"]').selectOption(r3!.id);
  await page.getByRole("button", { name: "担当変更" }).click();
  await page.waitForLoadState("networkidle");
  const dbCase = await db().case.findUnique({ where: { id: caseId } });
  expect(dbCase?.assigneeAccountId).toBe(r3!.id);
  const auditRec = await db().auditLog.findFirst({
    where: {
      actor: ACCOUNTS.R5.loginId,
      action: "case_assign",
      target: { contains: dbCase!.caseNo },
    },
    orderBy: { createdAt: "desc" },
  });
  expect(auditRec, "case_assignの監査ログが無い").not.toBeNull();
  expect(auditRec!.target).toContain("airis_snc_ops_0001");

  // CSVにも販売員ID・担当者が出る（OWN-022のデータ面の証拠）
  const csv = await page.request.get("/hotline/csv");
  expect(csv.status()).toBe(200);
  const csvText = (await csv.text()).replace(/^﻿/, "");
  const line = csvText.split(/\r?\n/).find((l) => l.includes(dbCase!.caseNo));
  expect(line).toBeTruthy();
  expect(line!).toContain("110001C001");
  expect(line!).toContain("airis_snc_ops_0001");
});

// ================================================================
// OWN-022: /hotline/csv /consumer-center/csv の権限マトリクス
// ================================================================
test("OWN-022: 案件CSVは許可ロールのみDL可・④やスコープ外は403", async ({ browser }) => {
  test.setTimeout(180_000);
  const get = async (page: Page, path: string) => {
    const res = await page.request.get(path);
    return { status: res.status(), text: res.status() === 200 ? await res.text() : "" };
  };

  // R2: 両方200・ヘッダに販売員ID・担当者列
  const r2 = await loginNewContext(browser, "R2");
  for (const path of ["/hotline/csv", "/consumer-center/csv"]) {
    const res = await get(r2, path);
    expect(res.status, `R2 ${path}`).toBe(200);
    const head = res.text.replace(/^﻿/, "").split(/\r?\n/)[0];
    expect(head).toContain("販売員ID");
    expect(head).toContain("担当者");
  }
  await r2.context().close();

  // R5: hotline=200 / consumer-center=403（スコープ外）
  const r5 = await loginNewContext(browser, "R5");
  expect((await get(r5, "/hotline/csv")).status).toBe(200);
  expect((await get(r5, "/consumer-center/csv")).status).toBe(403);
  await r5.context().close();

  // R6: consumer-center=200 / hotline=403
  const r6 = await loginNewContext(browser, "R6");
  expect((await get(r6, "/consumer-center/csv")).status).toBe(200);
  expect((await get(r6, "/hotline/csv")).status).toBe(403);
  await r6.context().close();

  // R4（④ダミー閲覧）: 両方403
  const r4 = await loginNewContext(browser, "R4");
  expect((await get(r4, "/hotline/csv")).status).toBe(403);
  expect((await get(r4, "/consumer-center/csv")).status).toBe(403);
  await r4.context().close();

  // R8（代理店・スコープ外）: 両方403
  const r8 = await loginNewContext(browser, "R8");
  expect((await get(r8, "/hotline/csv")).status).toBe(403);
  expect((await get(r8, "/consumer-center/csv")).status).toBe(403);
  await r8.context().close();
});

// ================================================================
// OWN-023: アカウント変更の理由必須・confirm・監査ログにreason
// ================================================================
test("OWN-023: 変更理由必須・confirmダイアログ・監査ログ記録", async ({ page }) => {
  test.setTimeout(120_000);
  const target = "airis_snc_vew_002";
  const before = await db().account.findUnique({ where: { loginId: target } });
  await login(page, "R2");
  await page.goto(`/admin?q=${target}`);
  await page.getByRole("button", { name: "編集" }).first().click();

  // 1) 理由なし（required属性を外してサーバー検証を直接突く）→ エラー
  await page.locator('input[name="reason"]').evaluate((el) => el.removeAttribute("required"));
  let dialogCount = 0;
  let dialogMsg = "";
  page.on("dialog", (d) => {
    dialogCount++;
    dialogMsg = d.message();
    d.accept();
  });
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("変更理由を入力してください")).toBeVisible({ timeout: 10_000 });
  expect(dialogCount).toBeGreaterThanOrEqual(1); // confirmが出た
  expect(dialogMsg).toContain("変更しますか");

  // 2) 理由あり → 成功・監査ログにreason
  const reason = `QA9変更理由${RUN}`;
  await page.locator('input[name="reason"]').fill(reason);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(`${target} を更新しました`)).toBeVisible({ timeout: 10_000 });
  const log = await db().auditLog.findFirst({
    where: {
      actor: ACCOUNTS.R2.loginId,
      action: "account_update",
      target: { contains: `reason=${reason}` },
    },
  });
  expect(log, "reasonを含む監査ログが無い").not.toBeNull();
  expect(log!.target).toContain(target);

  // 値は変えていない（プリフィルのまま保存）ことを確認 = 原状のまま
  const after = await db().account.findUnique({ where: { loginId: target } });
  expect(after?.name).toBe(before?.name);
  expect(after?.email).toBe(before?.email);
  expect(after?.role).toBe(before?.role);
});

// ================================================================
// OWN-024: 申請一覧の検索（氏名/メール/申請ID）・ロール・状態・ページ送り条件維持
// ================================================================
test("OWN-024: 検索・ロール・状態フィルタとページ送りの条件維持", async ({ page }) => {
  test.setTimeout(180_000);
  // 55件のQA9申請を用意（PAGE_SIZE=50 → 2ページ）
  const d = db();
  await d.accountRequest.deleteMany({ where: { requestId: { startsWith: "QA9-PG" } } });
  await d.accountRequest.createMany({
    data: Array.from({ length: 55 }, (_, i) => ({
      requestId: `QA9-PG-${RUN}-${String(i + 1).padStart(2, "0")}`,
      role: "R5",
      name: `QA9PG${RUN}-${i + 1}`,
      email: `qa9pg${i + 1}-${RUN}@example.com`,
      status: "pending_final",
      history: [],
    })),
  });

  await login(page, "R2");

  // 氏名検索
  await page.goto(`/account-requests?q=QA9PG${RUN}-13`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText(`QA9PG${RUN}-13`);

  // 申請ID検索
  await page.goto(`/account-requests?q=QA9-PG-${RUN}-07`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText(`QA9-PG-${RUN}-07`);

  // メール検索
  await page.goto(`/account-requests?q=qa9pg21-${RUN}`);
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await expect(page.locator("tbody tr").first()).toContainText(`qa9pg21-${RUN}@example.com`);

  // ロールフィルタ: R7指定なら0件、R5指定なら表示あり
  await page.goto(`/account-requests?q=QA9PG${RUN}&filterRole=R7`);
  await expect(page.getByText("条件に一致する申請がありません")).toBeVisible();
  await page.goto(`/account-requests?q=QA9PG${RUN}&filterRole=R5`);
  expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);

  // 状態フィルタ: approved=0件 / pending=あり
  await page.goto(`/account-requests?q=QA9PG${RUN}&status=approved`);
  await expect(page.getByText("条件に一致する申請がありません")).toBeVisible();
  await page.goto(`/account-requests?q=QA9PG${RUN}&status=pending`);
  expect(await page.locator("tbody tr").count()).toBeGreaterThan(0);

  // ページ送り: 55件 → 1/2ページ。次へで q・status が維持される
  await page.goto(`/account-requests?q=QA9PG${RUN}&status=pending`);
  await expect(page.getByText("1 / 2 ページ")).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("link", { name: "次へ" }).click();
  await page.waitForURL(/page=2/);
  const url = new URL(page.url());
  expect(url.searchParams.get("q")).toBe(`QA9PG${RUN}`);
  expect(url.searchParams.get("status")).toBe("pending");
  await expect(page.locator("tbody tr")).toHaveCount(5);
  await expect(page.locator("tbody tr").first()).toContainText(`QA9PG${RUN}`);

  await d.accountRequest.deleteMany({ where: { requestId: { startsWith: "QA9-PG" } } });
});

// ================================================================
// OWN-025: 電話番号形式（0始まり10〜11桁・ハイフン任意）のサーバー側検証と入力属性
// ================================================================
test("OWN-025: 不正電話番号は申請・編集・CSVの3経路すべてでサーバー側拒否", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const PHONE_ERR = "電話番号は0始まりの10〜11桁（ハイフン任意）で入力してください";

  // --- 経路1: 申請フォーム（⑧） ---
  await login(page, "R8");
  await page.goto("/sales-staff");
  await page.locator("summary", { hasText: "販売員ID申請" }).first().click();
  const phoneInput = page.locator('input[name="phone"]').first();
  // 入力欄の pattern / inputMode 属性（要件の後段）
  await expect(phoneInput).toHaveAttribute("pattern", "0[0-9\\-]{9,12}");
  await expect(phoneInput).toHaveAttribute("inputmode", "tel");

  await page.locator('input[name="lastName"]').first().fill(`QA9電話申${RUN}`);
  await page.locator('input[name="firstName"]').first().fill("太郎");
  await page.locator('input[name="birthDate"]').first().fill("1990-01-01");
  await phoneInput.evaluate((el) => {
    el.removeAttribute("pattern");
    el.removeAttribute("maxlength");
  });
  await phoneInput.fill("12345678901"); // 0始まりでない11桁
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText(PHONE_ERR)).toBeVisible({ timeout: 10_000 });
  expect(await db().salesStaff.count({ where: { lastName: `QA9電話申${RUN}` } })).toBe(0);

  // --- 経路2: 編集フォーム（②） ---
  const staffBefore = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  const r2 = await loginNewContext(browser, "R2");
  await r2.goto("/sales-staff?q=110001C001");
  await r2.getByRole("button", { name: "編集" }).first().click();
  const editPhone = r2.locator('form:has(input[name="staffId"]) input[name="phone"]');
  await expect(editPhone).toHaveAttribute("pattern", "0[0-9\\-]{9,12}");
  await expect(editPhone).toHaveAttribute("inputmode", "tel");
  await editPhone.evaluate((el) => {
    el.removeAttribute("pattern");
    el.removeAttribute("maxlength");
  });
  await editPhone.fill("090-12345"); // 桁不足
  await r2.locator('form:has(input[name="staffId"])').getByRole("button", { name: "保存" }).click();
  await expect(r2.getByText(PHONE_ERR)).toBeVisible({ timeout: 10_000 });
  const staffAfter = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  expect(staffAfter?.phone).toBe(staffBefore?.phone); // 変更されていない
  await r2.context().close();

  // --- 経路3: CSV一括申請（⑧・自店コード210001） ---
  const csv = `姓,名,生年月日,電話番号,代理店コード,メールアドレス\nQA9電話CSV${RUN},花子,1990-01-01,12345,210001,`;
  await page.goto("/sales-staff");
  await page.locator("summary", { hasText: "CSV一括申請" }).first().click();
  await page
    .locator('input[type="file"][name="file"]')
    .first()
    .setInputFiles({
      name: "QA9phone.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("﻿" + csv, "utf8"),
    });
  await page.getByRole("button", { name: "一括申請する" }).click();
  await expect(page.getByText(PHONE_ERR, { exact: false }).first()).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().salesStaff.count({ where: { lastName: `QA9電話CSV${RUN}` } })).toBe(0);
});

// ================================================================
// OWN-026: ひな形CSVの2行目に記入例・例文行を残した取込はエラーで全件不登録
// ================================================================
test("OWN-026: ひな形2行目の記入例と例文行取込のエラー", async ({ page }) => {
  test.setTimeout(180_000);
  await login(page, "R7"); // ⑦: 販売員ID・訪販員の両方を扱える

  // --- 販売員IDひな形 ---
  const res = await page.request.get("/sales-staff/csv/template");
  expect(res.status()).toBe(200);
  const tpl = (await res.text()).replace(/^﻿/, "");
  const lines = tpl.split(/\r?\n/).filter((l) => l.trim());
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines[1]).toContain("(例)"); // 2行目に記入例
  const beforeCount = await db().salesStaff.count();
  // 例文行を残したまま取込
  await page.goto("/sales-staff");
  await page.locator("summary", { hasText: "CSV一括申請" }).first().click();
  await page
    .locator('input[type="file"][name="file"]')
    .first()
    .setInputFiles({
      name: "QA9template.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("﻿" + tpl, "utf8"),
    });
  await page.getByRole("button", { name: "一括申請する" }).click();
  await expect(page.getByText("取込エラー", { exact: false }).first()).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().salesStaff.count()).toBe(beforeCount); // 1件も登録されない
  expect(await db().salesStaff.count({ where: { lastName: { contains: "(例)" } } })).toBe(0);

  // --- 訪販員申請ひな形 ---
  const res2 = await page.request.get("/field-agents/csv/template");
  expect(res2.status()).toBe(200);
  const tpl2 = (await res2.text()).replace(/^﻿/, "");
  const lines2 = tpl2.split(/\r?\n/).filter((l) => l.trim());
  expect(lines2.length).toBeGreaterThanOrEqual(2);
  expect(lines2[1]).toContain("(例)");
  const beforeFa = await db().fieldAgentApplication.count();
  await page.goto("/field-agents");
  await page.getByRole("button", { name: "CSV一括申請" }).first().click();
  await page
    .locator('input[type="file"][name="file"]')
    .first()
    .setInputFiles({
      name: "QA9fa-template.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("﻿" + tpl2, "utf8"),
    });
  await page.getByRole("button", { name: "一括申請する" }).click();
  await expect(page.getByText(/取込エラー|全件登録されていません|エラー/).first()).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().fieldAgentApplication.count()).toBe(beforeFa);
});

// ================================================================
// OWN-027: 404専用画面（日本語）と権限外アクセスの/dashboard?denied=バナー（監査継続）
// ================================================================
test("OWN-027: 404画面・権限外はdeniedバナー・監査ログ継続", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R9");

  // 存在しないURL → 日本語404画面
  await page.goto(`/qa9-no-such-page-${RUN}`);
  await expect(page.getByText("404")).toBeVisible();
  await expect(page.getByText("ページが見つかりません")).toBeVisible();
  await expect(page.getByRole("link", { name: "ダッシュボードへ戻る" })).toBeVisible();

  // 権限外URL（R9は/admin不可）→ /dashboard?denied= + バナー
  const beforeTs = new Date(Date.now() - 5_000);
  await page.goto("/admin");
  await page.waitForURL(/\/dashboard\?denied=/, { timeout: 15_000 });
  await expect(page.getByText("表示する権限がありません", { exact: false })).toBeVisible();

  // 監査は継続している（access_denied が記録される）
  const log = await db().auditLog.findFirst({
    where: {
      actor: ACCOUNTS.R9.loginId,
      action: "access_denied",
      target: { contains: "page=admin" },
      result: "denied",
      createdAt: { gte: beforeTs },
    },
  });
  expect(log, "access_deniedの監査ログが無い").not.toBeNull();
});

// ================================================================
// OWN-028: メール重複（申請/承認/変更の3経路）と削除済みメールの再利用
// ================================================================
test("OWN-028: 3経路のメール重複エラーと削除済みメール再利用", async ({ page }) => {
  test.setTimeout(180_000);
  const d = db();
  await login(page, "R2");

  // --- 経路1: 申請時の重複（既存アカウントのメール） ---
  await page.goto("/account-requests");
  await page.getByRole("button", { name: "＋ アカウント申請" }).click();
  await page.locator('select[name="role"]').selectOption("R5");
  await page.locator('input[name="name"]').fill(`QA9申請重複${RUN}`);
  await page.locator('input[name="email"]').fill("airis_snc_spt1_001@example.com");
  await page.locator('input[name="evidence"]').setInputFiles({
    name: "QA9evidence.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa9"),
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("このメールアドレスは既存のアカウントで使用されています")
  ).toBeVisible({ timeout: 10_000 });
  expect(await d.accountRequest.count({ where: { name: `QA9申請重複${RUN}` } })).toBe(0);

  // --- 経路2: 承認時の重複（申請後に同一メールのアカウントが発行されたケース） ---
  const apprEmail = `qa9appr-${RUN}@example.com`;
  await page.goto("/account-requests");
  await page.getByRole("button", { name: "＋ アカウント申請" }).click();
  await page.locator('select[name="role"]').selectOption("R5");
  await page.locator('input[name="name"]').fill(`QA9承認重複${RUN}`);
  await page.locator('input[name="email"]').fill(apprEmail);
  await page.locator('input[name="evidence"]').setInputFiles({
    name: "QA9evidence2.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa9"),
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText("アカウント申請を受け付けました", { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  // 申請後に同一メールのアカウントを直接作成（別経路での発行を模擬）
  await d.account.create({
    data: {
      loginId: `QA9_dup_${RUN}`,
      role: "R5",
      name: "QA9重複用",
      email: apprEmail,
      status: "active",
      passwordHash: "x",
    },
  });
  await page.goto(`/account-requests?q=QA9承認重複${RUN}`);
  await page.getByRole("button", { name: "最終承認" }).first().click();
  await expect(
    page.getByText("このメールアドレスは既存のアカウントで使用されています", { exact: false })
  ).toBeVisible({ timeout: 10_000 });
  const reqAfter = await d.accountRequest.findFirst({ where: { name: `QA9承認重複${RUN}` } });
  expect(reqAfter?.status).toBe("pending_final"); // 承認されていない
  expect(reqAfter?.issuedLoginId).toBeNull();

  // --- 経路3: アカウント変更時の重複 ---
  const target = "airis_snc_vew_002";
  const beforeAcc = await d.account.findUnique({ where: { loginId: target } });
  await page.goto(`/admin?q=${target}`);
  await page.getByRole("button", { name: "編集" }).first().click();
  await page.locator('input[name="email"]').fill("airis_snc_spt1_001@example.com");
  await page.locator('input[name="reason"]').fill(`QA9重複試験${RUN}`);
  page.once("dialog", (dlg) => dlg.accept());
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("このメールアドレスは他のアカウントで使用されています")).toBeVisible({
    timeout: 10_000,
  });
  const afterAcc = await d.account.findUnique({ where: { loginId: target } });
  expect(afterAcc?.email).toBe(beforeAcc?.email); // 変更されていない

  // --- 削除済みアカウントのメールは再利用できる ---
  const delEmail = `qa9del-${RUN}@example.com`;
  await d.account.create({
    data: {
      loginId: `QA9_del_${RUN}`,
      role: "R5",
      name: "QA9削除済み",
      email: delEmail,
      status: "deleted",
      deletedAt: new Date(),
      passwordHash: "x",
    },
  });
  await page.goto("/account-requests");
  await page.getByRole("button", { name: "＋ アカウント申請" }).click();
  await page.locator('select[name="role"]').selectOption("R5");
  await page.locator('input[name="name"]').fill(`QA9再利用${RUN}`);
  await page.locator('input[name="email"]').fill(delEmail);
  await page.locator('input[name="evidence"]').setInputFiles({
    name: "QA9evidence3.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa9"),
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText("アカウント申請を受け付けました", { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  expect(await d.accountRequest.count({ where: { name: `QA9再利用${RUN}` } })).toBe(1);

  // クリーンアップ（afterAllでも実施するが即時削除）
  await d.accountRequest.deleteMany({ where: { name: { contains: "QA9" } } });
  await d.account.deleteMany({ where: { loginId: { startsWith: "QA9_" } } });
});
