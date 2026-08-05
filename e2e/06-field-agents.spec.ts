// QA担当: 訪販員申請・管理（SPEC §6.3 / §7.4）
// データプレフィクス: QA4（一意RUN suffix付きで再実行しても衝突しない）
import { test, expect, type Page, type Browser } from "@playwright/test";
import {
  fieldAgentScope,
  login,
  db,
  collectConsoleErrors,
  criticalErrors,
  type RoleKey,
} from "./helpers";

const RUN = Date.now().toString(36);
const P = `QA4${RUN}`;
const jstMonth = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);

// ---------- テストデータ準備（db()=オーナー接続） ----------
async function agencyByCode(code: string) {
  const a = await db().agency.findUnique({ where: { code } });
  if (!a) throw new Error(`シード代理店 ${code} が見つかりません`);
  return a;
}

let seq = 0;
async function createStaff(opts: {
  code: string; // 所属代理店コード
  last?: string;
  first?: string;
  status?: string;
}) {
  const ag = await agencyByCode(opts.code);
  seq += 1;
  const status = opts.status ?? "registered";
  return db().salesStaff.create({
    data: {
      salesId: `${P}S${seq}`,
      lastName: opts.last ?? "QA4検証",
      firstName: opts.first ?? `試験${seq}`,
      birthDate: "1990-01-01",
      phone: "080-9999-0001",
      agencyId: ag.id,
      status,
      firstApproved: status !== "applying",
      history: [{ event: "requested", at: "2026-08-01", by: "qa4-seed" }],
    },
  });
}

async function createApp(
  salesStaffId: string,
  pledgeNo: string,
  status: string,
  extra: Record<string, unknown> = {}
) {
  const scope = await fieldAgentScope(salesStaffId);
  return db().fieldAgentApplication.create({
    data: {
      salesStaffId,
      ...scope, // 代理店スコープ列（§3.1。RLSがこの2列で判定する）
      applicationType: "稼働",
      products: "auひかり",
      attribute: "社員/契約社員",
      lastNameKana: "キューエーヨン",
      firstNameKana: "テスト",
      identityType: "免許証",
      pledgeNo,
      agencyCode1: "6YS008",
      status,
      firstApproved: status !== "applying",
      workMonth: status === "registered" ? jstMonth() : null,
      history: [{ event: "requested", at: "2026-08-01", by: "qa4-seed" }],
      ...extra,
    },
  });
}

// ---------- UI操作ヘルパー ----------
async function openApplyForm(page: Page) {
  // クライアントコンポーネントのhydration前クリックに耐えるようリトライ
  await expect(async () => {
    if (await page.locator('select[name="salesStaffId"]').isVisible()) return;
    await page.getByRole("button", { name: "＋ 訪販員申請" }).click({ timeout: 2000 });
    await expect(page.locator('select[name="salesStaffId"]')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

async function fillForm(
  page: Page,
  staffDbId: string,
  o: {
    pledgeNo?: string;
    products?: string;
    attribute?: string;
    type?: string;
    code1?: string;
    code2?: string;
    contractor?: { name: string; address: string; phone: string };
  }
) {
  await page.locator('select[name="salesStaffId"]').selectOption(staffDbId);
  await page.locator('select[name="applicationType"]').selectOption(o.type ?? "稼働");
  await page.locator('select[name="products"]').selectOption(o.products ?? "auひかり");
  await page.locator('input[name="agencyCode1"]').fill(o.code1 ?? "6YS008");
  if (o.code2) await page.locator('input[name="agencyCode2"]').fill(o.code2);
  await page.locator('input[name="lastNameKana"]').fill("キューエーヨン");
  await page.locator('input[name="firstNameKana"]').fill("テスト");
  await page.locator('select[name="identityType"]').selectOption("免許証");
  await page.locator('select[name="attribute"]').selectOption(o.attribute ?? "社員/契約社員");
  if (o.contractor) {
    await page.locator('input[name="contractorName"]').fill(o.contractor.name);
    await page.locator('input[name="contractorAddress"]').fill(o.contractor.address);
    await page.locator('input[name="contractorPhone"]').fill(o.contractor.phone);
  }
  if (o.pledgeNo !== undefined) await page.locator('input[name="pledgeNo"]').fill(o.pledgeNo);
}

function appRow(page: Page, pledgeNo: string) {
  return page.locator("tbody tr").filter({ hasText: `誓約書No: ${pledgeNo}` });
}

async function withRole(browser: Browser, role: RoleKey, fn: (p: Page) => Promise<void>) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  try {
    await login(p, role);
    await fn(p);
  } finally {
    await ctx.close();
  }
}

// ============================================================
// t01: R7 申請フォーム: 販売員ID選択→氏名・代理店の自動表示 + 選択肢仕様（§7.4）
// ============================================================
test("t01 R7申請フォーム: 選択肢が仕様どおり・販売員ID選択で氏名/代理店/1次店名を自動表示", async ({
  page,
}) => {
  const staff = await createStaff({ code: "210001", last: "QA4自動", first: `表示${RUN}` });
  const errors = collectConsoleErrors(page);
  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);

  // 選択肢が仕様どおり（§7.4）
  await expect(page.locator('select[name="applicationType"] option')).toHaveText(["稼働", "抹消"]);
  await expect(page.locator('select[name="products"] option')).toHaveText([
    "マルチ",
    "auひかり",
    "コラボ",
  ]);
  await expect(page.locator('select[name="attribute"] option')).toHaveText([
    "社員/契約社員",
    "パート・アルバイト",
    "業務委託社員",
    "個人事業主",
  ]);
  await expect(page.locator('select[name="identityType"] option')).toHaveText([
    "免許証",
    "マイナンバーカード",
    "パスポート",
  ]);

  // 選択前は自動表示欄が空（—）
  const nameBox = page
    .locator("label", { hasText: "氏名（自動表示）" })
    .locator("xpath=following-sibling::div[1]");
  const agencyBox = page
    .locator("label", { hasText: "所属代理店（自動表示）" })
    .locator("xpath=following-sibling::div[1]");
  await expect(nameBox).toHaveText("—");
  await expect(agencyBox).toHaveText("—");

  // 販売員IDを選択 → 氏名・所属代理店の自動表示、1次店名・所属代理店名の既定入力
  await page.locator('select[name="salesStaffId"]').selectOption(staff.id);
  await expect(nameBox).toHaveText(`QA4自動 表示${RUN}`);
  await expect(agencyBox).toHaveText("株式会社セールスパートナー東京（210001）");
  await expect(page.locator('input[name="primaryAgencyName"]')).toHaveValue(
    "東都ネットワーク販売株式会社"
  );
  await expect(page.locator('input[name="agencyName"]')).toHaveValue(
    "株式会社セールスパートナー東京"
  );

  // 稼働開始日/終了日はカレンダー選択（type=date）
  await expect(page.locator('input[name="startDate"]')).toHaveAttribute("type", "date");
  await expect(page.locator('input[name="endDate"]')).toHaveAttribute("type", "date");

  expect(criticalErrors(errors)).toEqual([]);
});

// ============================================================
// t02: マルチ選択時は使用代理店コード2枠必須（1枠のみでエラー）、auひかり/コラボは1枠目のみ必須
// ============================================================
test("t02 取扱商材=マルチは使用代理店コード2枠必須・auひかり/コラボは1枠目のみ必須", async ({
  page,
}) => {
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-MULTI1`;
  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);
  await fillForm(page, staff.id, { pledgeNo, products: "マルチ" });

  const code2 = page.locator('input[name="agencyCode2"]');
  // クライアント側: マルチのとき2枠目にrequired
  await expect(code2).toHaveJSProperty("required", true);

  // サーバ側: HTMLバリデーションを外して送信 → サーバ側必須エラーが返る
  await code2.evaluate((el) => el.removeAttribute("required"));
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("取扱商材が「マルチ」の場合、使用代理店コードは2枠とも必須です。")
  ).toBeVisible({ timeout: 10_000 });
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);

  // auひかり/コラボは1枠目のみ必須（2枠目はrequiredでない）
  await page.locator('select[name="products"]').selectOption("auひかり");
  await expect(code2).toHaveJSProperty("required", false);
  await page.locator('select[name="products"]').selectOption("コラボ");
  await expect(code2).toHaveJSProperty("required", false);
  // 1枠目は常に必須
  await expect(page.locator('input[name="agencyCode1"]')).toHaveJSProperty("required", true);

  // 2枠目を入れてマルチで申請 → 成功しDBに両枠が保存される
  // （注: server action完了後はReactがフォームのuncontrolled入力をリセットするため全項目を再入力）
  await fillForm(page, staff.id, { pledgeNo, products: "マルチ", code2: "666J08" });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("訪販員申請（稼働）を受け付けました。（申請中）").first()
  ).toBeVisible({
    timeout: 10_000,
  });
  const app = await db().fieldAgentApplication.findFirst({ where: { pledgeNo } });
  expect(app?.agencyCode1).toBe("6YS008");
  expect(app?.agencyCode2).toBe("666J08");
  expect(app?.products).toBe("マルチ");
});

// ============================================================
// t03: 属性=業務委託社員のとき業務委託会社名/住所/連絡先が必須、他属性では入力不可(disabled)
// ============================================================
test("t03 属性=業務委託社員のみ業務委託3項目が必須・他属性ではdisabled", async ({ page }) => {
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-CONTR1`;
  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);

  const cName = page.locator('input[name="contractorName"]');
  const cAddr = page.locator('input[name="contractorAddress"]');
  const cPhone = page.locator('input[name="contractorPhone"]');

  // 他属性（社員/契約社員・パート・アルバイト・個人事業主）では入力不可
  for (const attr of ["社員/契約社員", "パート・アルバイト", "個人事業主"]) {
    await page.locator('select[name="attribute"]').selectOption(attr);
    await expect(cName).toBeDisabled();
    await expect(cAddr).toBeDisabled();
    await expect(cPhone).toBeDisabled();
  }

  // 業務委託社員のとき入力可+必須
  await page.locator('select[name="attribute"]').selectOption("業務委託社員");
  await expect(cName).toBeEnabled();
  await expect(cName).toHaveJSProperty("required", true);
  await expect(cAddr).toHaveJSProperty("required", true);
  await expect(cPhone).toHaveJSProperty("required", true);

  // サーバ側: requiredを外して未入力送信 → サーバ側必須エラー
  await fillForm(page, staff.id, { pledgeNo, attribute: "業務委託社員" });
  for (const loc of [cName, cAddr, cPhone]) {
    await loc.evaluate((el) => el.removeAttribute("required"));
  }
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です。")
  ).toBeVisible({ timeout: 10_000 });
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);

  // 3項目を入力して申請 → 成功しDBに保存
  await fillForm(page, staff.id, {
    pledgeNo,
    attribute: "業務委託社員",
    contractor: {
      name: "QA4委託株式会社",
      address: "〒100-0001 東京都千代田区1-1",
      phone: "03-1234-5678",
    },
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("訪販員申請（稼働）を受け付けました。（申請中）").first()
  ).toBeVisible({
    timeout: 10_000,
  });
  const app = await db().fieldAgentApplication.findFirst({ where: { pledgeNo } });
  expect(app?.attribute).toBe("業務委託社員");
  expect(app?.contractorName).toBe("QA4委託株式会社");
  expect(app?.contractorAddress).toBe("〒100-0001 東京都千代田区1-1");
  expect(app?.contractorPhone).toBe("03-1234-5678");
});

// ============================================================
// t04: 誓約書No必須（未入力エラー）
// ============================================================
test("t04 誓約書Noは入力必須（未入力でエラー・DBに作成されない）", async ({ page }) => {
  const staff = await createStaff({ code: "210001" });
  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);
  await fillForm(page, staff.id, {}); // pledgeNo未入力

  const pledge = page.locator('input[name="pledgeNo"]');
  await expect(pledge).toHaveJSProperty("required", true);

  // サーバ側検証: requiredを外して送信 → 必須エラー
  await pledge.evaluate((el) => el.removeAttribute("required"));
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText("誓約書Noは入力必須です。")).toBeVisible({ timeout: 10_000 });
  expect(await db().fieldAgentApplication.count({ where: { salesStaffId: staff.id } })).toBe(0);
});

// ============================================================
// t05: 申請→DB applying→1次承認→provisional→最終承認→registered+workMonth（§6.3/§4.1）
// ============================================================
test("t05 承認フロー: R7申請(applying)→R7 1次承認(provisional)→R2最終承認(registered+workMonth)", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-FLOW1`;
  const errors = collectConsoleErrors(page);

  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);
  await fillForm(page, staff.id, { pledgeNo });
  // 誓約書PDF添付（§7.4）
  await page.locator('input[name="pledgeFile"]').setInputFiles({
    name: `QA4-${RUN}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n"),
  });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("訪販員申請（稼働）を受け付けました。（申請中）").first()
  ).toBeVisible({
    timeout: 10_000,
  });

  // DB: applying で作成される
  const created = await db().fieldAgentApplication.findFirst({ where: { pledgeNo } });
  expect(created).not.toBeNull();
  expect(created!.status).toBe("applying");
  expect(created!.applicationType).toBe("稼働");
  expect(created!.workMonth).toBeNull();
  expect(created!.pledgeFileId).not.toBeNull();
  expect((created!.history as { event: string }[]).map((h) => h.event)).toContain("requested");

  // 一覧: 申請中バッジ・誓約書PDFリンク、R7には最終承認ボタンが出ない（最終承認は①②③のみ）
  await page.goto(`/field-agents?q=${pledgeNo}`);
  const row = appRow(page, pledgeNo);
  await expect(row).toHaveCount(1);
  await expect(row.getByText("申請中", { exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: "誓約書PDF" })).toBeVisible();
  await expect(row.getByRole("button", { name: "最終承認" })).toHaveCount(0);

  // R7が1次承認 → provisional
  await row.getByRole("button", { name: "1次承認" }).click();
  await expect(row.getByText("仮登録", { exact: true })).toBeVisible({ timeout: 10_000 });
  const afterFirst = await db().fieldAgentApplication.findFirst({ where: { pledgeNo } });
  expect(afterFirst!.status).toBe("provisional");
  expect(afterFirst!.firstApproved).toBe(true);
  expect((afterFirst!.history as { event: string }[]).map((h) => h.event)).toContain(
    "approve_first"
  );
  // 仮登録になってもR7には最終承認ボタンなし（停止・削除は可能=⑦の権限）
  await expect(row.getByRole("button", { name: "最終承認" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "停止" })).toBeVisible();
  await expect(row.getByRole("button", { name: "削除" })).toBeVisible();

  // R2（SNC管理者）が最終承認 → registered + workMonth=当月
  await withRole(browser, "R2", async (p2) => {
    await p2.goto(`/field-agents?q=${pledgeNo}`);
    const row2 = appRow(p2, pledgeNo);
    await expect(row2).toHaveCount(1);
    await row2.getByRole("button", { name: "最終承認", exact: true }).click();
    await expect(row2.getByText("本登録", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  const final = await db().fieldAgentApplication.findFirst({ where: { pledgeNo } });
  expect(final!.status).toBe("registered");
  expect(final!.workMonth).toBe(jstMonth());
  expect((final!.history as { event: string }[]).map((h) => h.event)).toContain("final_approve");

  expect(criticalErrors(errors)).toEqual([]);
});

// ============================================================
// t06: 抹消申請の最終承認 → status=deleted（当該訪販員登録も抹消 §4.1）
// ============================================================
test("t06 抹消申請: 最終承認で抹消申請と既存の訪販員登録がdeletedになる", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const staff = await createStaff({ code: "210001" });
  const regPledge = `${P}-REGBASE`;
  const reg = await createApp(staff.id, regPledge, "registered"); // 既存の稼働登録
  const delPledge = `${P}-MASSHO`;

  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);
  await fillForm(page, staff.id, { pledgeNo: delPledge, type: "抹消" });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("訪販員申請（抹消）を受け付けました。（申請中）").first()
  ).toBeVisible({
    timeout: 10_000,
  });
  const created = await db().fieldAgentApplication.findFirst({ where: { pledgeNo: delPledge } });
  expect(created!.status).toBe("applying");
  expect(created!.applicationType).toBe("抹消");

  // R7 1次承認
  await page.goto(`/field-agents?q=${delPledge}`);
  const row = appRow(page, delPledge);
  await row.getByRole("button", { name: "1次承認" }).click();
  await expect(row.getByText("仮登録", { exact: true })).toBeVisible({ timeout: 10_000 });

  // R2 最終承認（ボタンラベルは「最終承認（抹消）」）
  await withRole(browser, "R2", async (p2) => {
    await p2.goto(`/field-agents?q=${delPledge}`);
    const row2 = appRow(p2, delPledge);
    await expect(row2.getByRole("button", { name: "最終承認（抹消）" })).toBeVisible();
    await row2.getByRole("button", { name: "最終承認（抹消）" }).click();
    await expect(row2.getByText("削除済", { exact: true })).toBeVisible({ timeout: 10_000 });
  });

  // DB: 抹消申請自体 + 既存の稼働登録の両方が deleted（=訪販員登録の抹消）
  const delApp = await db().fieldAgentApplication.findFirst({ where: { pledgeNo: delPledge } });
  expect(delApp!.status).toBe("deleted");
  expect(delApp!.deletedAt).not.toBeNull();
  expect((delApp!.history as { event: string }[]).map((h) => h.event)).toEqual(
    expect.arrayContaining(["final_approve", "delete"])
  );
  const regAfter = await db().fieldAgentApplication.findUnique({ where: { id: reg.id } });
  expect(regAfter!.status).toBe("deleted");
  expect(regAfter!.deletedAt).not.toBeNull();
});

// ============================================================
// t07: 異常系: 重複稼働申請・抹消対象なし
// ============================================================
test("t07 異常系: 有効な稼働申請がある販売員への再申請と、登録のない販売員への抹消申請はエラー", async ({
  page,
}) => {
  const staffDup = await createStaff({ code: "210001" });
  await createApp(staffDup.id, `${P}-DUPBASE`, "registered");
  const staffNone = await createStaff({ code: "210001" });

  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);

  // 重複稼働申請
  const dupPledge = `${P}-DUPNEW`;
  await fillForm(page, staffDup.id, { pledgeNo: dupPledge, type: "稼働" });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(
    page.getByText("この販売員には既に有効な訪販員申請（稼働）が存在します。")
  ).toBeVisible({ timeout: 10_000 });
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo: dupPledge } })).toBe(0);

  // 抹消対象なし
  const nonePledge = `${P}-NONE`;
  await fillForm(page, staffNone.id, { pledgeNo: nonePledge, type: "抹消" });
  await page.getByRole("button", { name: "申請する" }).click();
  await expect(page.getByText("抹消申請の対象となる訪販員登録がありません。")).toBeVisible({
    timeout: 10_000,
  });
  expect(await db().fieldAgentApplication.count({ where: { salesStaffId: staffNone.id } })).toBe(0);
});

// ============================================================
// t08: 同姓同名・ブラックリスト簡易チェック（§7.4 補助機能）
// ============================================================
test("t08 同姓同名チェック: 同姓同名がいれば警告・いなければ「簡易チェックで警告はありません。」", async ({
  page,
}) => {
  const unique = await createStaff({ code: "210001", last: "QA4唯一", first: `花子${RUN}` });
  const sameA = await createStaff({ code: "210001", last: "QA4同名", first: `太郎${RUN}` });
  const sameB = await createStaff({ code: "210002", last: "QA4同名", first: `太郎${RUN}` });

  await login(page, "R7");
  await page.goto("/field-agents");
  await openApplyForm(page);

  // 同姓同名なし → 警告なしメッセージ
  // ※SNC系(①②③)以外のロールにはボタンラベルでも「ブラックリスト」に言及しない（§7.4 代理店側には一切見せない）
  await page.locator('select[name="salesStaffId"]').selectOption(unique.id);
  await page.getByRole("button", { name: "同姓同名確認" }).click();
  await expect(page.getByText("簡易チェックで警告はありません。")).toBeVisible({ timeout: 10_000 });

  // 同姓同名あり → 警告表示（相手の販売員IDを含む）
  await page.locator('select[name="salesStaffId"]').selectOption(sameA.id);
  await page.getByRole("button", { name: "同姓同名確認" }).click();
  await expect(page.getByText(/簡易チェックの警告/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/同姓同名の販売員IDが存在します/).first()).toBeVisible();
  // 警告リスト項目に相手（同姓同名の別販売員）の販売員IDが含まれる
  await expect(page.locator("li").filter({ hasText: sameB.salesId! }).first()).toBeVisible();
});

// ============================================================
// t09: ブラックリスト欄・SNCメモ: R2では表示・編集可（§7.4）
// ============================================================
test("t09 R2はブラックリスト欄・SNCメモを表示・編集できる（DB反映まで検証）", async ({ page }) => {
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-BL-R2`;
  const memo = `${P}-機密メモ初期`;
  const app = await createApp(staff.id, pledgeNo, "registered", {
    blacklistFlag: "★",
    sncMemo: memo,
  });

  await login(page, "R2");
  await page.goto(`/field-agents?q=${pledgeNo}`);

  // 一覧: ブラックリスト列・★バッジ・メモが表示される
  await expect(page.locator("th", { hasText: "ブラックリスト" })).toBeVisible();
  const row = appRow(page, pledgeNo);
  await expect(row).toHaveCount(1);
  await expect(row.getByText("★", { exact: true })).toBeVisible();
  await expect(row.getByText(memo)).toBeVisible();

  // 行内の編集フォームから変更 → DBに反映
  await row.locator("summary", { hasText: "編集" }).click();
  await row.locator('select[name="blacklistFlag"]').selectOption("1");
  await row.locator('input[name="sncMemo"]').fill(`${P}-メモ更新`);
  await row.getByRole("button", { name: "保存" }).click();
  await expect
    .poll(
      async () => {
        const a = await db().fieldAgentApplication.findUnique({ where: { id: app.id } });
        return `${a?.blacklistFlag}|${a?.sncMemo}`;
      },
      { timeout: 10_000 }
    )
    .toBe(`1|${P}-メモ更新`);

  // 申請フォームにもSNC限定項目（ブラックリスト欄・SNC用メモ）が表示される
  await openApplyForm(page);
  await expect(page.getByText("SNC限定項目（代理店側には表示されません）")).toBeVisible();
  await expect(page.locator('form select[name="blacklistFlag"]').last()).toBeVisible();
  await expect(
    page.locator('select[name="blacklistFlag"] option', { hasText: "★（ブラックリスト）" }).first()
  ).toHaveCount(1);
});

// ============================================================
// t10: R7の一覧にはブラックリスト列・値・SNCメモが表示されない（§7.4）
// ============================================================
test("t10 R7一覧: ブラックリスト列・★・SNCメモの値が表示されない", async ({ page }) => {
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-BL-R7`;
  const memo = `${P}-代理店に見せないメモ`;
  await createApp(staff.id, pledgeNo, "registered", { blacklistFlag: "★", sncMemo: memo });

  await login(page, "R7");
  await page.goto(`/field-agents?q=${pledgeNo}`);
  const row = appRow(page, pledgeNo);
  await expect(row).toHaveCount(1); // 行自体は自店スコープ内なので見える

  // 列ヘッダ・値・メモが一切出ない
  await expect(page.locator("th", { hasText: "ブラックリスト" })).toHaveCount(0);
  await expect(page.getByText("★", { exact: true })).toHaveCount(0);
  await expect(page.getByText(memo)).toHaveCount(0);
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain(memo);
  expect(bodyText).not.toContain("★");
  expect(bodyText).not.toContain("SNC用メモ");
});

// ============================================================
// t11: R7/R8では画面（申請フォーム展開含む）に「★」「ブラックリスト」「SNCメモ」等が一切表示されない（§7.4）
// ============================================================
test("t11 R7/R8: 申請フォーム展開時も含め画面にブラックリスト関連の文言が一切存在しない", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-BL-STRICT`;
  const memo = `${P}-厳密チェックメモ`;
  await createApp(staff.id, pledgeNo, "registered", { blacklistFlag: "★", sncMemo: memo });

  for (const role of ["R7", "R8"] as const) {
    await withRole(browser, role, async (p) => {
      await p.goto(`/field-agents?q=${pledgeNo}`);
      await openApplyForm(p); // フォームを展開した状態で全文言を確認
      const text = await p.locator("body").innerText();
      expect
        .soft(text, `${role}: 「ブラックリスト」の文言が画面に存在しない`)
        .not.toContain("ブラックリスト");
      expect.soft(text, `${role}: 「SNCメモ」の文言が画面に存在しない`).not.toContain("SNCメモ");
      expect
        .soft(text, `${role}: 「SNC用メモ」の文言が画面に存在しない`)
        .not.toContain("SNC用メモ");
      expect.soft(text, `${role}: 「★」が画面に存在しない`).not.toContain("★");
      expect.soft(text, `${role}: SNCメモの値が画面に存在しない`).not.toContain(memo);
    });
  }
});

// ============================================================
// t12: 一覧CSV出力（棚卸）: R2はSNC限定列（ブラックリスト・SNC用メモ）込みでDL可能（§7.4 / 要件3-10）
// ============================================================
test("t12 CSV出力(R2): ヘッダが仕様どおりでSNC限定列とデータ（★・メモ）を含む", async ({
  page,
}) => {
  const staff = await createStaff({ code: "210001" });
  const pledgeNo = `${P}-CSV-R2`;
  const memo = `${P}-CSV機密メモ`;
  await createApp(staff.id, pledgeNo, "registered", { blacklistFlag: "★", sncMemo: memo });

  await login(page, "R2");
  const res = await page.request.get("/field-agents/csv");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"]).toContain("attachment");

  const text = (await res.text()).replace(/^﻿/, "");
  const lines = text.split("\r\n");
  const header = lines[0].split(",");
  for (const h of [
    "販売員ID",
    "氏名（姓）",
    "氏名（名）",
    "フリガナ（姓）",
    "フリガナ（名）",
    "1次店名",
    "所属代理店名",
    "申請区分",
    "取扱商材",
    "属性",
    "本人性種別",
    "誓約書No",
    "稼働開始日",
    "稼働終了日",
    "使用代理店コード1",
    "使用代理店コード2",
    "業務委託会社名",
    "業務委託会社住所",
    "業務委託会社連絡先",
    "ステータス",
    "稼働月",
  ]) {
    expect(header, `ヘッダに「${h}」列がある`).toContain(h);
  }
  expect(header).toContain("ブラックリスト");
  expect(header).toContain("SNC用メモ");

  const line = lines.find((l) => l.includes(pledgeNo));
  expect(line, "作成した行がCSVに含まれる").toBeTruthy();
  expect(line!).toContain("★");
  expect(line!).toContain(memo);
  expect(line!).toContain("本登録");
});

// ============================================================
// t13: CSV出力(R7): ブラックリスト列が含まれず、スコープ外代理店の行も含まれない
// ============================================================
test("t13 CSV出力(R7): SNC限定列なし・自店スコープ外の行なし", async ({ page }) => {
  const inStaff = await createStaff({ code: "210001" });
  const inPledge = `${P}-CSV-R7IN`;
  const memo = `${P}-R7に見せないメモ`;
  await createApp(inStaff.id, inPledge, "registered", { blacklistFlag: "★", sncMemo: memo });
  // スコープ外（別系列1次店150008配下の250008）
  const farStaff = await createStaff({ code: "250008" });
  const farPledge = `${P}-CSV-R7FAR`;
  await createApp(farStaff.id, farPledge, "registered");

  await login(page, "R7");
  const res = await page.request.get("/field-agents/csv");
  expect(res.status()).toBe(200);

  const text = (await res.text()).replace(/^﻿/, "");
  const lines = text.split("\r\n");
  const header = lines[0].split(",");
  expect(header).toContain("販売員ID");
  expect(header).toContain("誓約書No");
  expect(header, "ブラックリスト列が含まれない").not.toContain("ブラックリスト");
  expect(header, "SNC用メモ列が含まれない").not.toContain("SNC用メモ");

  const inLine = lines.find((l) => l.includes(inPledge));
  expect(inLine, "自店スコープ内の行は含まれる").toBeTruthy();
  expect(inLine!).not.toContain("★");
  expect(inLine!).not.toContain(memo);
  expect(text).not.toContain(memo);
  expect(text, "スコープ外代理店の行が含まれない").not.toContain(farPledge);

  // 一覧画面でもスコープ外は検索不可
  await page.goto(`/field-agents?q=${farPledge}`);
  await expect(page.getByText("該当する訪販員申請はありません。")).toBeVisible();
  await expect(page.getByText(`誓約書No: ${farPledge}`)).toHaveCount(0);
});

// ============================================================
// t14: 検索・状態フィルタ
// ============================================================
test("t14 検索・フィルタ: 誓約書No検索と状態フィルタで絞り込める", async ({ page }) => {
  const sA = await createStaff({ code: "210001" });
  const sB = await createStaff({ code: "210001" });
  const pledgeA = `${P}-FLT-A`;
  const pledgeB = `${P}-FLT-B`;
  await createApp(sA.id, pledgeA, "applying");
  await createApp(sB.id, pledgeB, "registered");

  await login(page, "R7");

  // 誓約書No検索: Aのみヒット
  await page.goto(`/field-agents?q=${pledgeA}`);
  await expect(appRow(page, pledgeA)).toHaveCount(1);
  await expect(page.getByText(`誓約書No: ${pledgeB}`)).toHaveCount(0);
  await expect(page.getByText("全1件中 1–1件を表示")).toBeVisible();

  // 前方一致部分(共通prefix)+状態フィルタ
  await page.goto(`/field-agents?q=${P}-FLT&status=applying`);
  await expect(appRow(page, pledgeA)).toHaveCount(1);
  await expect(page.getByText(`誓約書No: ${pledgeB}`)).toHaveCount(0);

  await page.goto(`/field-agents?q=${P}-FLT&status=registered`);
  await expect(appRow(page, pledgeB)).toHaveCount(1);
  await expect(page.getByText(`誓約書No: ${pledgeA}`)).toHaveCount(0);

  // 状態フィルタの選択肢
  await expect(page.locator('select[name="status"] option')).toHaveText([
    "すべての状態",
    "申請中",
    "仮登録",
    "本登録",
    "停止中",
    "削除済",
  ]);
});

// ============================================================
// t15: スコープ: R8は自店のみ（IDOR防止含む §3.1）+ R8は承認・管理操作不可
// ============================================================
test("t15 R8スコープ: 自店の申請のみ閲覧可・他店は検索/URL注入でも見えない・承認/停止ボタンなし", async ({
  page,
}) => {
  const inStaff = await createStaff({ code: "210001" }); // R8自店
  const inPledge = `${P}-SCOPE-IN`;
  await createApp(inStaff.id, inPledge, "applying");
  const outStaff = await createStaff({ code: "110001" }); // 親1次店（R8スコープ外）
  const outPledge = `${P}-SCOPE-OUT`;
  await createApp(outStaff.id, outPledge, "registered");
  const sibStaff = await createStaff({ code: "210002" }); // 兄弟2次店（R8スコープ外）
  const sibPledge = `${P}-SCOPE-SIB`;
  await createApp(sibStaff.id, sibPledge, "registered");

  const errors = collectConsoleErrors(page);
  await login(page, "R8");

  // 自店の行は見える + 操作ボタン（1次承認/最終承認/停止/削除）は表示されない（⑧は申のみ）
  await page.goto(`/field-agents?q=${inPledge}`);
  const row = appRow(page, inPledge);
  await expect(row).toHaveCount(1);
  for (const name of ["1次承認", "最終承認", "停止", "削除", "再開", "復旧"]) {
    await expect(row.getByRole("button", { name })).toHaveCount(0);
  }
  // 申請ボタン自体は使える（⑧=申）
  await expect(page.getByRole("button", { name: "＋ 訪販員申請" })).toBeVisible();

  // 親1次店・兄弟2次店の行は検索しても見えない
  for (const pledge of [outPledge, sibPledge]) {
    await page.goto(`/field-agents?q=${pledge}`);
    await expect(page.getByText("該当する訪販員申請はありません。")).toBeVisible();
    await expect(page.getByText(`誓約書No: ${pledge}`)).toHaveCount(0);
  }

  // 代理店フィルタの選択肢は自店のみ
  await page.goto("/field-agents");
  const agencyOptions = await page.locator('select[name="agency"] option').allTextContents();
  expect(agencyOptions.some((o) => o.includes("セールスパートナー東京"))).toBe(true);
  expect(agencyOptions.some((o) => o.includes("東都ネットワーク"))).toBe(false);
  expect(agencyOptions.some((o) => o.includes("フィールドプロ埼玉"))).toBe(false);

  // URLパラメータで親1次店の代理店IDを注入しても0件（クライアント由来IDを信用しない §3.1）
  const p1 = await agencyByCode("110001");
  await page.goto(`/field-agents?agency=${p1.id}`);
  await expect(page.getByText("全0件中 0–0件を表示")).toBeVisible();
  await expect(page.getByText(`誓約書No: ${outPledge}`)).toHaveCount(0);

  // 申請フォームの販売員セレクトにもスコープ外販売員が出ない
  await openApplyForm(page);
  const staffOptions = await page.locator('select[name="salesStaffId"] option').allTextContents();
  expect(staffOptions.some((o) => o.includes(inStaff.salesId!))).toBe(true);
  expect(staffOptions.some((o) => o.includes(outStaff.salesId!))).toBe(false);
  expect(staffOptions.some((o) => o.includes(sibStaff.salesId!))).toBe(false);

  expect(criticalErrors(errors)).toEqual([]);
});

// ============================================================
// t16: 権限外アクセス（§5.2: 訪販員申請/管理は①②③⑦⑧のみ）
// ============================================================
test("t16 権限外アクセス: R9/R5は/field-agentsにアクセス不可・CSVも403/401", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  // R9（販売員）: ページはダッシュボードへリダイレクト、CSVは403
  await login(page, "R9");
  await page.goto("/field-agents");
  await expect(page).toHaveURL(/\/dashboard/);
  const res9 = await page.request.get("/field-agents/csv");
  expect(res9.status()).toBe(403);

  // R5（HL窓口）: 同様に不可
  await withRole(browser, "R5", async (p5) => {
    await p5.goto("/field-agents");
    await expect(p5).toHaveURL(/\/dashboard/);
    const res5 = await p5.request.get("/field-agents/csv");
    expect(res5.status()).toBe(403);
  });

  // 未認証: ページはログインへ、CSVは401
  const ctx = await browser.newContext();
  const resAnon = await ctx.request.get("/field-agents/csv");
  expect(resAnon.status()).toBe(401);
  const pAnon = await ctx.newPage();
  await pAnon.goto("/field-agents");
  await expect(pAnon).toHaveURL(/\/login/);
  await ctx.close();
});

// ============================================================
// t17: 異常系: 不正なURLパラメータ・存在しないID/検索語でも壊れない
// ============================================================
test("t17 異常系: 不正status/存在しないagency/過大page/該当なし検索でもエラーなく表示", async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);
  await login(page, "R7");

  await page.goto("/field-agents?status=bogus&agency=no-such-id&page=9999");
  await expect(page.getByRole("heading", { name: "訪販員申請・管理" })).toBeVisible();
  await expect(page.getByText("全0件中 0–0件を表示")).toBeVisible(); // 存在しない代理店IDは0件に落ちる

  await page.goto(`/field-agents?q=NOEXIST-${RUN}`);
  await expect(page.getByText("該当する訪販員申請はありません。")).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});
