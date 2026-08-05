// QA5: 各種資料の提出 — 稼働提出物（SPEC §7.6, §6.4, 要件7-3）
// 対象: /reports?tab=submissions（テンプレDL・提出・二段階承認・差戻し・年度自動計算・提出状況 n/6）
import { test, expect, type Page } from "@playwright/test";
import { login, db, collectConsoleErrors, criticalErrors } from "./helpers";

const KINDS = [
  "【アライアンス申請書】",
  "【訪販用】稼働エリア申請フォーマット",
  "【ポスティング用】配布エリア申請フォーマット",
  "【独自特典】申請シート",
  "【催事用】稼働エリア申請フォーマット",
  "環境ヒアリングシート",
] as const;

// 他スイートと衝突しないよう遠い月を使用（プレフィクス QA5）
const M_FLOW = "2030-11"; // fy 2030
const M_REJECT = "2030-12"; // fy 2030
const M_FY = "2027-03"; // fy 2026（年度自動計算の検証用）
const M_STATUS = "2031-05"; // fy 2031（n/6 提出状況の検証用）

function dummyXlsx(name: string) {
  return {
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(`QA5 dummy xlsx payload for ${name}`),
  };
}

// 提出フォーム（絞り込みフォームと区別するため memo 入力を持つ form にスコープ）
function submissionForm(page: Page) {
  return page.locator("form").filter({ has: page.locator('input[name="memo"]') });
}

// 提出フォームから提出（成功メッセージまで待つ）
async function submitSubmission(
  page: Page,
  kind: string,
  month: string,
  memo: string,
  submitterAgencyValue?: string
) {
  await page.goto("/reports?tab=submissions");
  const form = submissionForm(page);
  await form.locator('select[name="kind"]').selectOption(kind);
  await form.locator('input[name="targetMonth"]').fill(month);
  if (submitterAgencyValue) {
    await form.locator('select[name="submitterAgencyId"]').selectOption(submitterAgencyValue);
  }
  await form.locator('input[name="file"]').setInputFiles(dummyXlsx(`${memo}.xlsx`));
  await form.locator('input[name="memo"]').fill(memo);
  await form.getByRole("button", { name: "提出する" }).click();
  await expect(page.getByText(`「${kind}」（${month}）を提出しました`)).toBeVisible({
    timeout: 15_000,
  });
}

async function findSubmission(memo: string) {
  return db().submission.findFirst({
    where: { memo },
    include: { submitterAgency: true, primaryAgency: true },
  });
}

test.beforeAll(async () => {
  // 自スイート（QA5プレフィクス）の過去データを掃除して自己完結にする
  await db().submission.deleteMany({ where: { memo: { startsWith: "QA5" } } });
});

test.afterAll(async () => {
  await db().$disconnect();
});

test("テンプレDLボタン6個が表示され /templates/template1..6.xlsx が200で返る", async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);
  await login(page, "R8");
  await page.goto("/reports?tab=submissions");
  await expect(page.getByText("提出用テンプレート（様式ダウンロード）")).toBeVisible();

  // 同名リンクは提出済み一覧にも現れるため、テンプレート（/templates/*.xlsx）リンクに限定する
  for (let i = 0; i < KINDS.length; i++) {
    const link = page.locator(`a[href="/templates/template${i + 1}.xlsx"]`);
    await expect(link).toBeVisible();
    await expect(link).toContainText(KINDS[i]); // 様式名がリンクテキスト（§7.6）
  }

  for (let i = 1; i <= 6; i++) {
    const res = await page.request.get(`/templates/template${i}.xlsx`);
    expect(res.status(), `template${i}.xlsx`).toBe(200);
    expect((await res.body()).length).toBeGreaterThan(0);
  }

  // 異常系: 存在しないテンプレートは404
  const notFound = await page.request.get("/templates/template7.xlsx");
  expect(notFound.status()).toBe(404);

  expect(criticalErrors(errors)).toEqual([]);
});

test("R8提出→pending_first→R7一次承認→pending_snc→R2最終承認→approved（各ステータスDB検証）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  const memo = "QA5-flow-二段階承認";

  // --- R8（2次店）が提出 → pending_first ---
  await login(page, "R8");
  await submitSubmission(page, KINDS[0], M_FLOW, memo);

  let sub = await findSubmission(memo);
  expect(sub).not.toBeNull();
  expect(sub!.status).toBe("pending_first");
  expect(sub!.fiscalYear).toBe(2030);
  expect(sub!.targetMonth).toBe(M_FLOW);
  expect(sub!.kind).toBe(KINDS[0]);
  expect(sub!.submitterAgency.code).toBe("210001"); // R8自店固定
  expect(sub!.primaryAgency.code).toBe("110001"); // 親の1次店
  expect(sub!.fileName).toBe(`${memo}.xlsx`);

  // --- R7（1次店）が一次承認 → pending_snc ---
  await page.context().clearCookies();
  await login(page, "R7");
  await page.goto("/reports?tab=submissions");
  const rowR7 = page.locator("tr").filter({ hasText: memo });
  await expect(rowR7.getByText("1次店確認中")).toBeVisible();
  await rowR7.getByRole("button", { name: "1次承認" }).click();
  await expect
    .poll(async () => (await findSubmission(memo))?.status, { timeout: 15_000 })
    .toBe("pending_snc");
  await page.reload();
  await expect(rowR7.getByText("SNC確認中")).toBeVisible();

  // --- R2（SNC管理者）が最終承認 → approved ---
  await page.context().clearCookies();
  await login(page, "R2");
  await page.goto("/reports?tab=submissions");
  const rowR2 = page.locator("tr").filter({ hasText: memo });
  await expect(rowR2.getByText("SNC確認中")).toBeVisible();
  await rowR2.getByRole("button", { name: "最終承認" }).click();
  await expect
    .poll(async () => (await findSubmission(memo))?.status, { timeout: 15_000 })
    .toBe("approved");
  await page.reload();
  await expect(rowR2.getByText("最終承認済み")).toBeVisible();

  // 履歴イベントの検証（submitted → approve_first → final_approve）
  sub = await findSubmission(memo);
  const events = (sub!.history as { event: string }[]).map((h) => h.event);
  expect(events).toEqual(["submitted", "approve_first", "final_approve"]);

  expect(criticalErrors(errors)).toEqual([]);
});

test("R7自身名義の提出→一次承認を経ず直接pending_snc", async ({ page }) => {
  const memo = "QA5-own-自店名義";
  const ownAgency = await db().agency.findUnique({ where: { code: "110001" } });
  expect(ownAgency).not.toBeNull();

  await login(page, "R7");
  await submitSubmission(page, KINDS[5], M_FLOW, memo, ownAgency!.id);

  const sub = await findSubmission(memo);
  expect(sub).not.toBeNull();
  expect(sub!.status).toBe("pending_snc"); // §6.4: ⑦自身名義は直接SNCへ
  expect(sub!.submitterAgency.code).toBe("110001");
  expect(sub!.primaryAgency.code).toBe("110001");

  // 一覧上もSNC確認中と表示される
  await page.goto("/reports?tab=submissions");
  const row = page.locator("tr").filter({ hasText: memo });
  await expect(row.getByText("SNC確認中")).toBeVisible();
});

test("差戻し（理由付き）→rejected・理由がDBと画面に残る", async ({ page }) => {
  const memo = "QA5-reject-差戻し対象";
  const reason = "QA5-書式不備のため差戻し";

  // R8が提出
  await login(page, "R8");
  await submitSubmission(page, KINDS[3], M_REJECT, memo);
  expect((await findSubmission(memo))!.status).toBe("pending_first");

  // R7が理由付きで差戻し
  await page.context().clearCookies();
  await login(page, "R7");
  await page.goto("/reports?tab=submissions");
  const row = page.locator("tr").filter({ hasText: memo });
  await row.locator('input[name="reason"]').fill(reason);
  await row.getByRole("button", { name: "差戻し" }).click();
  await expect
    .poll(async () => (await findSubmission(memo))?.status, { timeout: 15_000 })
    .toBe("rejected");

  const sub = await findSubmission(memo);
  expect(sub!.rejectReason).toBe(reason);
  const events = (sub!.history as { event: string }[]).map((h) => h.event);
  expect(events).toEqual(["submitted", "reject"]);

  // 画面表示: 差戻しバッジ + 理由
  await page.reload();
  await expect(row.getByText("差戻し", { exact: true })).toBeVisible();
  await expect(row.getByText(`理由: ${reason}`)).toBeVisible();
});

test("年度自動計算: 対象月2027-03→2026年度（フォーム表示・DB値・一覧表示）", async ({ page }) => {
  const memo = "QA5-fy-年度計算";
  await login(page, "R8");
  await page.goto("/reports?tab=submissions");

  // 対象月を入れるとフォーム上の年度表示が自動計算される
  const form = submissionForm(page);
  await form.locator('input[name="targetMonth"]').fill(M_FY);
  await expect(form.getByText("2026年度")).toBeVisible();

  await form.locator('select[name="kind"]').selectOption(KINDS[4]);
  await form.locator('input[name="file"]').setInputFiles(dummyXlsx(`${memo}.xlsx`));
  await form.locator('input[name="memo"]').fill(memo);
  await form.getByRole("button", { name: "提出する" }).click();
  await expect(page.getByText(`「${KINDS[4]}」（${M_FY}）を提出しました`)).toBeVisible({
    timeout: 15_000,
  });

  // DB: fiscalYear=2026
  const sub = await findSubmission(memo);
  expect(sub).not.toBeNull();
  expect(sub!.targetMonth).toBe(M_FY);
  expect(sub!.fiscalYear).toBe(2026);

  // 一覧行にも 2027-03 と 2026年度 が併記される
  await page.goto("/reports?tab=submissions");
  const row = page.locator("tr").filter({ hasText: memo });
  await expect(row.getByText(M_FY)).toBeVisible();
  await expect(row.getByText("2026年度")).toBeVisible();
});

test("提出状況テーブル: 対象月の「n / 6」バッジと未提出様式名の表示", async ({ page }) => {
  await login(page, "R8");
  // 2種類だけ提出（→ 2 / 6 になるはず）
  await submitSubmission(page, KINDS[0], M_STATUS, "QA5-status-1");
  await submitSubmission(page, KINDS[1], M_STATUS, "QA5-status-2");

  await page.goto(`/reports?tab=submissions&month=${M_STATUS}`);
  await expect(page.getByText(`提出状況（二次代理店 × ${M_STATUS}）`)).toBeVisible();

  const statusTable = page.locator("table").filter({ hasText: "未提出様式" });
  const row = statusTable.locator("tr").filter({ hasText: "株式会社セールスパートナー東京" });
  await expect(row).toHaveCount(1);
  await expect(row.getByText("2 / 6")).toBeVisible();

  // 未提出の4様式名が列挙される（提出済み2様式は列挙されない）
  for (const missing of [KINDS[2], KINDS[3], KINDS[4], KINDS[5]]) {
    await expect(row.getByText(missing)).toBeVisible();
  }
  const missingCell = row.locator("td").nth(2);
  await expect(missingCell.getByText(KINDS[0])).toHaveCount(0);
  await expect(missingCell.getByText(KINDS[1])).toHaveCount(0);
});

test("提出物一覧フィルタ: §7.6の項目（フリーワード/種別/1次代理店/2次代理店/年度/月）が揃っている", async ({
  page,
}) => {
  await login(page, "R2");
  await page.goto("/reports?tab=submissions");

  // 絞り込みフォーム（フリーワード入力 name=q を持つ form）
  const filterForm = page.locator("form").filter({ has: page.locator('input[name="q"]') });
  await expect(filterForm.locator('input[name="q"]')).toBeVisible(); // フリーワード
  await expect(filterForm.locator('select[name="kind"]')).toBeVisible(); // 種別
  await expect(filterForm.locator('select[name="fy"]')).toBeVisible(); // 年度
  await expect(filterForm.locator('input[name="fmonth"]')).toBeVisible(); // 月

  // 仕様§7.6: 「フィルタ: フリーワード / 種別 / 1次代理店 / 2次代理店 / 年度 / 月」
  await expect(filterForm.getByText("1次代理店")).toBeVisible();
  await expect(filterForm.getByText("2次代理店")).toBeVisible();
});

test("異常系: ファイル未添付では提出できない（DBにも作成されない）", async ({ page }) => {
  const memo = "QA5-nofile-未添付";
  await login(page, "R8");
  await page.goto("/reports?tab=submissions");
  const form = submissionForm(page);
  await form.locator('select[name="kind"]').selectOption(KINDS[0]);
  await form.locator('input[name="targetMonth"]').fill(M_FLOW);
  await form.locator('input[name="memo"]').fill(memo);
  await form.getByRole("button", { name: "提出する" }).click();

  // 必須バリデーションで送信がブロックされる
  const valueMissing = await form
    .locator('input[name="file"]')
    .evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
  expect(valueMissing).toBe(true);
  await expect(page.getByText("を提出しました")).toHaveCount(0);
  expect(await db().submission.count({ where: { memo } })).toBe(0);
});
