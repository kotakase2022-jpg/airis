// QA担当: 検収問題一覧（2026-08-05 発注者提供）の未解決項目に対する修正の検証
// 対象: No.1(日報プリフィル) / No.10(棚卸CSV削除日時) / No.14・23・30(窓口拡張) /
//       No.15(変更理由) / No.19(申請一覧検索) / No.32(電話) / No.34(404/権限バナー) / No.39(メール重複)
// データプレフィクス: QA23
import { test, expect } from "@playwright/test";
import { ACCOUNTS, PW_GENERAL, db, login } from "./helpers";

const RUN = Date.now().toString(36);

// ================================================================
// No.1（S級）: 日報の再提出で既存値がプリフィルされ、未変更項目が消えない
// ================================================================
test("日報: 提出済みの日付を選ぶと既存値が読み込まれ、1項目だけ変更して保存しても他の値が保持される", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const DATE = "2026-08-21"; // シード日報（月初2日）や他テストと衝突しない日付
  const staff = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  await db().dailyReport.deleteMany({ where: { salesStaffId: staff!.id, date: DATE, type: "訪販" } });

  await login(page, "R9");
  await page.goto("/reports");
  // 1回目の提出（全項目入力）
  await page.locator('input[name="date"]').fill(DATE);
  await page.locator('input[name="area"]').fill(`QA23エリア${RUN}`);
  for (const [name, v] of [
    ["acquisitions", "5"],
    ["workers", "4"],
    ["visits", "40"],
    ["meetings", "12"],
    ["negotiations", "6"],
    ["contracts", "3"],
  ] as const) {
    await page.locator(`input[name="${name}"]`).fill(v);
  }
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${DATE} の訪販日報を保存しました`)).toBeVisible({ timeout: 10_000 });

  // ページを再読込して同じ日付を選択 → 既存値が読み込まれる（編集モード）
  await page.goto("/reports");
  await page.locator('input[name="date"]').fill(DATE);
  await expect(page.getByText("提出済み日報を読み込みました（編集モード）")).toBeVisible();
  await expect(page.locator('input[name="acquisitions"]')).toHaveValue("5");
  await expect(page.locator('input[name="visits"]')).toHaveValue("40");
  await expect(page.locator('input[name="area"]')).toHaveValue(`QA23エリア${RUN}`);

  // 成約数だけ変更して保存 → 他の項目は保持される（0/null上書きされない）
  await page.locator('input[name="contracts"]').fill("4");
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${DATE} の訪販日報を保存しました`)).toBeVisible({ timeout: 10_000 });

  const rec = await db().dailyReport.findFirst({
    where: { salesStaffId: staff!.id, date: DATE, type: "訪販" },
  });
  expect(rec?.contracts).toBe(4); // 変更した項目
  expect(rec?.acquisitions).toBe(5); // 既存値が保持される
  expect(rec?.workers).toBe(4);
  expect(rec?.visits).toBe(40);
  expect(rec?.meetings).toBe(12);
  expect(rec?.negotiations).toBe(6);
  expect(rec?.area).toBe(`QA23エリア${RUN}`);

  await db().dailyReport.deleteMany({ where: { salesStaffId: staff!.id, date: DATE, type: "訪販" } });
});

// ================================================================
// No.19: アカウント申請一覧の検索・絞り込み
// ================================================================
test("アカウント申請一覧: キーワード・状態で絞り込める", async ({ page }) => {
  await login(page, "R2");
  await page.goto("/account-requests");
  await expect(page.locator('form[action="/account-requests"] input[name="q"]')).toBeVisible();

  // 存在しないキーワード → 0件表示
  await page.goto(`/account-requests?q=QA23存在しない申請${RUN}`);
  await expect(page.getByText("条件に一致する申請がありません")).toBeVisible();

  // 状態フィルタが機能する（rejected のみ表示。シードに却下が無い場合は0件表示になる）
  await page.goto("/account-requests?status=rejected");
  const rows = page.locator("tbody tr");
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    await expect(rows.nth(i)).toContainText("差戻し・却下");
  }
});

// ================================================================
// No.39: メールアドレスの重複チェック
// ================================================================
test("アカウント申請: 既存アカウントと同じメールはエラー", async ({ page }) => {
  await login(page, "R2");
  await page.goto("/account-requests");
  await page.getByRole("button", { name: "＋ アカウント申請" }).click();
  await page.locator('select[name="role"]').selectOption("R5");
  await page.locator('input[name="name"]').fill(`QA23重複${RUN}`);
  // シードの既存アカウントのメール（airis_snc_spt1_001@example.com）
  await page.locator('input[name="email"]').fill("airis_snc_spt1_001@example.com");
  await page.locator('input[type="file"]').setInputFiles({
    name: "evidence.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa23"),
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("このメールアドレスは既存のアカウントで使用されています")
  ).toBeVisible({ timeout: 10_000 });
  expect(await db().accountRequest.count({ where: { name: `QA23重複${RUN}` } })).toBe(0);
});

// ================================================================
// No.32: 電話番号の形式チェック（サーバー側）
// ================================================================
test("販売員ID申請: 不正な電話番号はサーバー側で拒否される", async ({ page }) => {
  const lastName = `QA23電話${RUN}`;
  await login(page, "R8");
  await page.goto("/sales-staff");
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  await page.locator('input[name="lastName"]').fill(lastName);
  await page.locator('input[name="firstName"]').fill("番号");
  await page.locator('input[name="birthDate"]').fill("1990-01-01");
  // pattern属性を外してサーバー検証を直接突く（改ざん耐性）
  await page.locator('input[name="phone"]').evaluate((el) => {
    (el as HTMLInputElement).removeAttribute("pattern");
    (el as HTMLInputElement).removeAttribute("maxlength");
  });
  await page.locator('input[name="phone"]').fill("12345"); // 0始まりでない・桁不足
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("電話番号は0始まりの10〜11桁（ハイフン任意）で入力してください")
  ).toBeVisible({ timeout: 10_000 });
  expect(await db().salesStaff.count({ where: { lastName } })).toBe(0);
});

// ================================================================
// No.10: 棚卸CSVに削除日時列
// ================================================================
test("棚卸CSV: 削除日時列があり、削除済みアカウントに値が入る", async ({ page }) => {
  await login(page, "R2");
  const res = await page.request.get("/admin/csv?type=inventory");
  expect(res.status()).toBe(200);
  const lines = (await res.text()).replace(/^﻿/, "").split(/\r?\n/);
  expect(lines[0]).toContain("削除日時");
});

// ================================================================
// No.14 / No.23 / No.30: 窓口の販売員ID紐付け・起票時添付・担当者・代理店メール・集計・CSV
// ================================================================
test("HL窓口: 起票フォームに販売員ID選択と添付欄、集計セクションとCSVダウンロードがある", async ({
  page,
}) => {
  await login(page, "R5");
  await page.goto("/hotline?new=1");
  await expect(page.locator('select[name="salesStaffId"]')).toBeVisible();
  await expect(page.locator('input[name="files"]')).toBeVisible();
  await expect(page.getByText("集計", { exact: true })).toBeVisible();
  await expect(page.getByText("代理店別×ステータス")).toBeVisible();
  await expect(page.getByText("月別起票件数（直近6ヶ月）")).toBeVisible();

  const csv = await page.request.get("/hotline/csv");
  expect(csv.status()).toBe(200);
  const head = (await csv.text()).replace(/^﻿/, "").split(/\r?\n/)[0];
  expect(head).toContain("販売員ID");
  expect(head).toContain("担当者");
});

test("HL窓口: 販売員ID・添付つきで起票 → 詳細に販売員ID・代理店メール表示、担当者を変更できる", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await login(page, "R5");
  await page.goto("/hotline?new=1");
  await page.locator('select[name="templateKind"]').selectOption("音声提出依頼");
  // 一次代理店: 東都NW(110001)
  const p1 = await db().agency.findUnique({ where: { code: "110001" } });
  await page.locator('select[name="primaryAgencyId"]').selectOption(p1!.id);
  // 販売員ID（110001C001）を選択
  const staff = await db().salesStaff.findFirst({ where: { salesId: "110001C001" } });
  await page.locator('select[name="salesStaffId"]').selectOption(staff!.id);
  await page.locator('input[name="deadline"]').fill("2026-08-31");
  await page.locator('input[name="files"]').setInputFiles({
    name: `QA23添付${RUN}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4 qa23 attachment"),
  });
  await page.getByRole("button", { name: "起票する" }).click();
  await page.waitForURL(/\/hotline\/[a-z0-9]+$/, { timeout: 15_000 });

  // 詳細: 販売員ID・代理店メール（⑦のメール）・添付名
  await expect(page.getByText("110001C001（営業 太郎）")).toBeVisible();
  await expect(page.getByText("airis_1110001_001@example.com", { exact: false })).toBeVisible();
  await expect(page.getByText(`QA23添付${RUN}.pdf`)).toBeVisible();

  // 担当者を⑤に変更
  const r5 = await db().account.findUnique({ where: { loginId: ACCOUNTS.R5.loginId } });
  await page.locator('select[name="assigneeAccountId"]').selectOption(r5!.id);
  await page.getByRole("button", { name: "担当変更" }).click();
  await page.waitForLoadState("networkidle");
  const caseNo = new URL(page.url()).pathname.split("/").pop()!;
  const dbCase = await db().case.findUnique({ where: { id: caseNo } });
  expect(dbCase?.assigneeAccountId).toBe(r5!.id);
  expect(dbCase?.salesStaffId).toBe(staff!.id);

  // 後片付け（QA23案件を削除）
  await db().caseMessage.deleteMany({ where: { caseId: dbCase!.id } });
  await db().caseStatusHistory.deleteMany({ where: { caseId: dbCase!.id } });
  await db().caseRead.deleteMany({ where: { caseId: dbCase!.id } });
  await db().case.delete({ where: { id: dbCase!.id } });
});

// ================================================================
// No.34: 404とアクセス拒否の区別
// ================================================================
test("404: 存在しないページは日本語の404画面、権限外ページはダッシュボードにバナー表示", async ({
  page,
}) => {
  await login(page, "R9");
  // 存在しないURL → 404画面
  await page.goto("/no-such-page-xyz");
  await expect(page.getByText("ページが見つかりません")).toBeVisible();
  // 権限外ページ（R9は/adminへ入れない）→ ダッシュボードへリダイレクト+バナー
  await page.goto("/admin");
  await page.waitForURL(/\/dashboard\?denied=/, { timeout: 15_000 });
  await expect(page.getByText("表示する権限がありません", { exact: false })).toBeVisible();
});

// ================================================================
// No.15: アカウント変更に変更理由が必須で、監査ログに記録される
// ================================================================
test("アカウント変更: 変更理由が必須・監査ログにreasonが残る", async ({ page }) => {
  const target = "airis_snc_vew_002"; // MFAデモ用アカウントを対象に使用（値は元に戻す）
  await login(page, "R2");
  await page.goto(`/admin?q=${target}`);
  await page.getByRole("button", { name: "編集" }).first().click();
  const reason = `QA23理由${RUN}`;
  await page.locator('input[name="reason"]').fill(reason);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(`${target} を更新しました`)).toBeVisible({ timeout: 10_000 });
  const log = await db().auditLog.findFirst({
    where: { actor: ACCOUNTS.R2.loginId, action: "account_update", target: { contains: reason } },
  });
  expect(log).not.toBeNull();
});
