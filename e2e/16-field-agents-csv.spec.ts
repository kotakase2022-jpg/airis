/**
 * QA担当: 訪販員申請のCSV一括申請 + 誓約書PDF突合（SPEC §7.4 / §3.6 / §12 M3）
 * データプレフィクス: QA16
 *
 * 検証観点:
 *  - 一括申請CSVひな形DL（列仕様が §7.4 どおり）
 *  - 正常系: 行単位で登録され、誓約書PDFが `{誓約書No}-{連番3桁}.pdf` でCSV行順に突合される
 *  - エラー行レポート（n行目: 理由）+ **エラーが1件でもあれば全件ロールバック**（部分取込しない）
 *  - スコープ外の販売員ID・未登録の販売員IDは行エラー（§3.1）
 */
import { test, expect, type Page } from "@playwright/test";
import { fieldAgentScope, login, db, collectConsoleErrors, criticalErrors } from "./helpers";

const RUN = Date.now().toString(36);
const P = `QA16${RUN}`;

// §7.4 の一括申請CSV列（ひな形と取込の期待値。仕様の列順どおり）
const HEADERS = [
  "販売員ID",
  "申請区分",
  "取扱商材",
  "属性",
  "フリガナ(姓)",
  "フリガナ(名)",
  "本人性種別",
  "誓約書No",
  "稼働開始日",
  "使用代理店コード1",
  "使用代理店コード2",
  "業務委託会社名",
  "業務委託会社住所",
  "業務委託会社連絡先",
];

const PDF_BODY = "%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n";

// ---------- テストデータ（db()=オーナー接続で直接投入） ----------
let seq = 0;
async function createStaff(code: string, status = "registered") {
  const ag = await db().agency.findUnique({ where: { code } });
  if (!ag) throw new Error(`シード代理店 ${code} が見つかりません`);
  seq += 1;
  return db().salesStaff.create({
    data: {
      salesId: `${P}S${seq}`,
      lastName: "QA16一括",
      firstName: `試験${seq}`,
      birthDate: "1990-01-01",
      phone: "080-9999-0016",
      agencyId: ag.id,
      status,
      firstApproved: status !== "applying",
      history: [{ event: "requested", at: "2026-08-01", by: "qa16-seed" }],
    },
  });
}

// ---------- CSV組み立て ----------
type RowInput = {
  salesId: string;
  pledgeNo: string;
  type?: string;
  products?: string;
  attribute?: string;
  kanaLast?: string;
  kanaFirst?: string;
  identity?: string;
  startDate?: string;
  code1?: string;
  code2?: string;
  contractorName?: string;
  contractorAddress?: string;
  contractorPhone?: string;
};

function toRow(o: RowInput): string[] {
  return [
    o.salesId,
    o.type ?? "稼働",
    o.products ?? "auひかり",
    o.attribute ?? "社員/契約社員",
    o.kanaLast ?? "キューエージュウロク",
    o.kanaFirst ?? "テスト",
    o.identity ?? "免許証",
    o.pledgeNo,
    o.startDate ?? "2026-09-01",
    o.code1 ?? "6YS008",
    o.code2 ?? "",
    o.contractorName ?? "",
    o.contractorAddress ?? "",
    o.contractorPhone ?? "",
  ];
}

function buildCsv(rows: string[][]): Buffer {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const body = [HEADERS, ...rows].map((r) => r.map(esc).join(",")).join("\r\n");
  return Buffer.from("﻿" + body + "\r\n", "utf-8");
}

function pdfFile(pledgeNo: string, n: number) {
  return {
    name: `${pledgeNo}-${String(n).padStart(3, "0")}.pdf`,
    mimeType: "application/pdf",
    buffer: Buffer.from(PDF_BODY),
  };
}

// ---------- UI操作 ----------
async function openBulkForm(page: Page) {
  await page.goto("/field-agents");
  await expect(async () => {
    if (await page.locator('input[name="file"]').isVisible()) return;
    await page.getByRole("button", { name: "CSV一括申請" }).click({ timeout: 2000 });
    await expect(page.locator('input[name="file"]')).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

async function submitBulk(
  page: Page,
  csv: Buffer,
  pdfs: { name: string; mimeType: string; buffer: Buffer }[] = []
) {
  await page.locator('input[name="file"]').setInputFiles({
    name: `${P}.csv`,
    mimeType: "text/csv",
    buffer: csv,
  });
  if (pdfs.length > 0) {
    await page.locator('input[name="pledgeFiles"]').setInputFiles(pdfs);
  }
  await page.getByRole("button", { name: "一括申請する" }).click();
}

// ============================================================
// t01: 一括申請CSVひな形DL（§7.4 の列仕様どおり）
// ============================================================
test("t01 一括申請CSVひな形: 列が仕様どおりでBOM付きUTF-8のCSVとしてDLできる", async ({ page }) => {
  await login(page, "R7");
  const res = await page.request.get("/field-agents/csv/template");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/csv");
  expect(res.headers()["content-disposition"]).toContain("attachment");

  const raw = await res.text();
  expect(raw.startsWith("﻿"), "BOM付きUTF-8（Excel互換 §3.6）").toBe(true);
  const header = raw.replace(/^﻿/, "").split("\r\n")[0].split(",");
  expect(header).toEqual(HEADERS);

  // 画面にひな形DLリンクとCSV一括申請の導線がある（§7.3/§7.4 のツールバー相当）
  await page.goto("/field-agents");
  await expect(page.getByRole("link", { name: "一括申請CSVひな形" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "CSV一括申請" })).toBeVisible();
});

// ============================================================
// t02: 正常系: 3行のCSV + 誓約書PDF3件 → 全件applyingで登録され、PDFがCSV行順に突合される
// ============================================================
test("t02 正常系: CSV一括申請で全行が登録され、誓約書PDFが 誓約書No-連番3桁.pdf でCSV行順に突合される", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const s1 = await createStaff("210001");
  const s2 = await createStaff("210001");
  const s3 = await createStaff("210001", "provisional"); // 仮登録も申請可（§6.3-1）
  const pledgeNo = `${P}70`;

  const csv = buildCsv([
    toRow({ salesId: s1.salesId!, pledgeNo }),
    toRow({ salesId: s2.salesId!, pledgeNo, products: "マルチ", code2: "666J08" }),
    toRow({
      salesId: s3.salesId!,
      pledgeNo,
      attribute: "業務委託社員",
      contractorName: "QA16委託株式会社",
      contractorAddress: "〒100-0001 東京都千代田区1-1",
      contractorPhone: "03-1234-5678",
    }),
  ]);

  await login(page, "R7");
  await openBulkForm(page);
  await submitBulk(page, csv, [pdfFile(pledgeNo, 1), pdfFile(pledgeNo, 2), pdfFile(pledgeNo, 3)]);

  await expect(page.getByText(/3件の訪販員申請を登録しました。（申請中/)).toBeVisible({
    timeout: 20_000,
  });

  // DB: 3件が applying で作成される
  const apps = await db().fieldAgentApplication.findMany({
    where: { pledgeNo },
    include: { salesStaff: true },
  });
  expect(apps.length).toBe(3);
  for (const a of apps) {
    expect(a.status).toBe("applying");
    expect(a.workMonth).toBeNull();
    expect((a.history as { event: string }[]).map((h) => h.event)).toContain("requested");
    expect(a.primaryAgencyName).toBe("東都ネットワーク販売株式会社");
    expect(a.agencyName).toBe("株式会社セールスパートナー東京");
    expect(a.startDate).toBe("2026-09-01");
    expect(a.identityType).toBe("免許証");
    expect(a.lastNameKana).toBe("キューエージュウロク");
    expect(a.pledgeFileId).not.toBeNull();
  }

  // 誓約書PDFの突合: CSV行順に 001/002/003 が紐づく
  const byStaff = new Map(apps.map((a) => [a.salesStaffId, a]));
  const expectPdf = async (staffId: string, n: number) => {
    const app = byStaff.get(staffId);
    expect(app, `販売員 ${staffId} の申請が存在する`).toBeTruthy();
    const f = await db().storedFile.findUnique({ where: { id: app!.pledgeFileId! } });
    expect(f!.name).toBe(`${pledgeNo}-${String(n).padStart(3, "0")}.pdf`);
    expect(f!.mime).toBe("application/pdf");
  };
  await expectPdf(s1.id, 1);
  await expectPdf(s2.id, 2);
  await expectPdf(s3.id, 3);

  // 行ごとの値（マルチの2枠 / 業務委託3項目）が保存されている
  expect(byStaff.get(s2.id)!.products).toBe("マルチ");
  expect(byStaff.get(s2.id)!.agencyCode2).toBe("666J08");
  expect(byStaff.get(s3.id)!.attribute).toBe("業務委託社員");
  expect(byStaff.get(s3.id)!.contractorName).toBe("QA16委託株式会社");
  expect(byStaff.get(s3.id)!.contractorPhone).toBe("03-1234-5678");
  // 業務委託社員以外の行では業務委託3項目が保存されない
  expect(byStaff.get(s1.id)!.contractorName).toBeNull();

  // 一覧に反映され、誓約書PDFリンクからファイルが取得できる
  await page.goto(`/field-agents?q=${pledgeNo}`);
  const rows = page.locator("tbody tr").filter({ hasText: `誓約書No: ${pledgeNo}` });
  await expect(rows).toHaveCount(3);
  const href = await rows.first().getByRole("link", { name: "誓約書PDF" }).getAttribute("href");
  const fileRes = await page.request.get(href!);
  expect(fileRes.status()).toBe(200);

  // CSV取込は監査ログ記録対象（§3.3 / §3.6）
  const auditRow = await db().auditLog.findFirst({
    where: { action: "訪販員申請CSV一括申請", result: "success" },
    orderBy: { createdAt: "desc" },
  });
  expect(auditRow).not.toBeNull();
  expect(auditRow!.target).toContain("3件");

  expect(criticalErrors(errors)).toEqual([]);
});

// ============================================================
// t03: エラー行レポート + 全件ロールバック（§3.6）
// ============================================================
test("t03 エラー行レポート: 不正行があると「n行目: 理由」を表示し、正常行も含めて全件登録されない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const ok1 = await createStaff("210001");
  const applying = await createStaff("210001", "applying"); // 申請中は訪販員申請不可（§6.3-1）
  const ok2 = await createStaff("210001");
  const pledgeNo = `${P}ERR`;

  // 「n行目」はCSVファイルの物理行番号（ヘッダ行=1行目。Excelでの修正箇所と一致させる）
  const csv = buildCsv([
    toRow({ salesId: ok1.salesId!, pledgeNo }), // 2行目: 正常
    toRow({ salesId: applying.salesId!, pledgeNo }), // 3行目: 販売員IDが申請中
    toRow({ salesId: `${P}NOEXIST`, pledgeNo }), // 4行目: 存在しない販売員ID
    toRow({ salesId: ok2.salesId!, pledgeNo, products: "マルチ" }), // 5行目: マルチで2枠目なし
    toRow({ salesId: ok2.salesId!, pledgeNo, attribute: "業務委託社員" }), // 6行目: 業務委託3項目なし
    toRow({ salesId: ok2.salesId!, pledgeNo, identity: "運転免許" }), // 7行目: 本人性種別が不正
    toRow({ salesId: ok2.salesId!, pledgeNo: "" }), // 8行目: 誓約書No未入力
  ]);

  await login(page, "R7");
  await openBulkForm(page);
  await submitBulk(page, csv);

  const report = page.locator("li");
  await expect(page.getByText(/取込エラー（\d+件・全件登録されていません）/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(report.filter({ hasText: "3行目" })).toContainText(
    "仮登録または本登録ではありません"
  );
  await expect(report.filter({ hasText: "4行目" })).toContainText(
    "存在しないか、操作可能な代理店の範囲外です"
  );
  await expect(report.filter({ hasText: "5行目" })).toContainText(
    "取扱商材が「マルチ」の場合、使用代理店コードは2枠とも必須です"
  );
  await expect(report.filter({ hasText: "6行目" })).toContainText(
    "属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です"
  );
  await expect(report.filter({ hasText: "7行目" })).toContainText("本人性種別は");
  await expect(report.filter({ hasText: "8行目" })).toContainText("誓約書Noが未入力です");
  // 正常行（2行目）はエラーに出ない
  await expect(report.filter({ hasText: "2行目" })).toHaveCount(0);

  // 全件ロールバック: 正常行(1行目)も登録されていない
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);
  expect(await db().fieldAgentApplication.count({ where: { salesStaffId: ok1.id } })).toBe(0);
  expect(await db().fieldAgentApplication.count({ where: { salesStaffId: ok2.id } })).toBe(0);

  // 拒否も監査ログに残る（§3.3）
  const denied = await db().auditLog.findFirst({
    where: { action: "訪販員申請CSV一括申請", result: "denied" },
    orderBy: { createdAt: "desc" },
  });
  expect(denied).not.toBeNull();
  expect(denied!.target).toContain("全件未登録");
});

// ============================================================
// t04: 誓約書PDFの突合失敗はエラー行レポート対象・全件ロールバック（§7.4）
// ============================================================
test("t04 誓約書PDF突合: 連番が欠けている行はエラー行になり、突合できないPDFも報告され全件登録されない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const s1 = await createStaff("210001");
  const s2 = await createStaff("210001");
  const pledgeNo = `${P}PDF`;
  const csv = buildCsv([
    toRow({ salesId: s1.salesId!, pledgeNo }),
    toRow({ salesId: s2.salesId!, pledgeNo }),
  ]);

  await login(page, "R7");
  await openBulkForm(page);
  // 002 の代わりに規則外のファイル名を添付 → 2行目が突合不能・当該PDFも突合不能
  await submitBulk(page, csv, [
    pdfFile(pledgeNo, 1),
    { name: `${pledgeNo}-2.pdf`, mimeType: "application/pdf", buffer: Buffer.from(PDF_BODY) },
  ]);

  await expect(page.getByText(/取込エラー（\d+件・全件登録されていません）/)).toBeVisible({
    timeout: 20_000,
  });
  // 2件目のデータ行（=CSVの3行目）が突合不能
  await expect(page.locator("li").filter({ hasText: "3行目" })).toContainText(
    `誓約書PDF「${pledgeNo}-002.pdf」が見つかりません`
  );
  await expect(page.locator("li").filter({ hasText: `${pledgeNo}-2.pdf` })).toContainText(
    "CSVのどの行とも突合できません"
  );

  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);

  // 正しい連番（001/002）で再送 → 全件登録され、PDFが行順に突合される
  await page.reload();
  await openBulkForm(page);
  await submitBulk(page, csv, [pdfFile(pledgeNo, 1), pdfFile(pledgeNo, 2)]);
  await expect(page.getByText(/2件の訪販員申請を登録しました/)).toBeVisible({ timeout: 20_000 });

  const apps = await db().fieldAgentApplication.findMany({ where: { pledgeNo } });
  expect(apps.length).toBe(2);
  const app1 = apps.find((a) => a.salesStaffId === s1.id)!;
  const app2 = apps.find((a) => a.salesStaffId === s2.id)!;
  const f1 = await db().storedFile.findUnique({ where: { id: app1.pledgeFileId! } });
  const f2 = await db().storedFile.findUnique({ where: { id: app2.pledgeFileId! } });
  expect(f1!.name).toBe(`${pledgeNo}-001.pdf`);
  expect(f2!.name).toBe(`${pledgeNo}-002.pdf`);
});

// ============================================================
// t05: スコープ検証（§3.1）: R8は自店の販売員IDのみ一括申請できる
// ============================================================
test("t05 スコープ: R8のCSVに親1次店・兄弟2次店の販売員IDが含まれると行エラー・全件登録されない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const own = await createStaff("210001"); // R8自店
  const parent = await createStaff("110001"); // 親1次店（スコープ外）
  const sibling = await createStaff("210002"); // 兄弟2次店（スコープ外）
  const pledgeNo = `${P}SCOPE`;

  const csv = buildCsv([
    toRow({ salesId: own.salesId!, pledgeNo }),
    toRow({ salesId: parent.salesId!, pledgeNo }),
    toRow({ salesId: sibling.salesId!, pledgeNo }),
  ]);

  await login(page, "R8");
  await openBulkForm(page);
  await submitBulk(page, csv);

  await expect(page.getByText(/取込エラー（\d+件・全件登録されていません）/)).toBeVisible({
    timeout: 20_000,
  });
  // ヘッダ行=1行目のため、2件目/3件目のデータ行は 3行目 / 4行目
  for (const [line, staff] of [
    [3, parent],
    [4, sibling],
  ] as const) {
    await expect(page.locator("li").filter({ hasText: `${line}行目` })).toContainText(
      `販売員ID「${staff.salesId}」が存在しないか、操作可能な代理店の範囲外です`
    );
  }
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);

  // 自店のみのCSVなら登録できる
  await page.reload();
  await openBulkForm(page);
  await submitBulk(page, buildCsv([toRow({ salesId: own.salesId!, pledgeNo })]));
  await expect(page.getByText(/1件の訪販員申請を登録しました/)).toBeVisible({ timeout: 20_000 });
  const apps = await db().fieldAgentApplication.findMany({ where: { pledgeNo } });
  expect(apps.length).toBe(1);
  expect(apps[0].salesStaffId).toBe(own.id);
});

// ============================================================
// t06: 重複申請の行エラー（既存の有効な稼働申請 / CSV内重複）
// ============================================================
test("t06 重複: 既に有効な稼働申請がある販売員・CSV内で重複した販売員IDは行エラー", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const dup = await createStaff("210001");
  const twice = await createStaff("210001");
  const pledgeNo = `${P}DUP`;
  const dupScope = await fieldAgentScope(dup.id);
  await db().fieldAgentApplication.create({
    data: {
      salesStaffId: dup.id,
      ...dupScope, // 代理店スコープ列（§3.1）
      applicationType: "稼働",
      products: "auひかり",
      attribute: "社員/契約社員",
      lastNameKana: "キューエー",
      firstNameKana: "ジュウロク",
      identityType: "免許証",
      pledgeNo: `${P}BASE`,
      agencyCode1: "6YS008",
      status: "registered",
      firstApproved: true,
      history: [{ event: "requested", at: "2026-08-01", by: "qa16-seed" }],
    },
  });

  const csv = buildCsv([
    toRow({ salesId: dup.salesId!, pledgeNo }), // 2行目相当: 既存の有効申請あり
    toRow({ salesId: twice.salesId!, pledgeNo }),
    toRow({ salesId: twice.salesId!, pledgeNo }), // CSV内重複
  ]);

  await login(page, "R7");
  await openBulkForm(page);
  await submitBulk(page, csv);

  await expect(page.getByText(/取込エラー（\d+件・全件登録されていません）/)).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("li").filter({ hasText: "2行目" })).toContainText(
    "既に有効な訪販員申請（稼働）が存在します"
  );
  await expect(page.locator("li").filter({ hasText: "4行目" })).toContainText(
    "CSV内で重複しています"
  );
  expect(await db().fieldAgentApplication.count({ where: { pledgeNo } })).toBe(0);
});

// ============================================================
// t07: 権限（§5.2）: R9はひな形DLもできない / R4（ダミー）には一括申請の導線が出ない
// ============================================================
test("t07 権限: R9はひな形DL不可・R4（ダミー表示）にはCSV一括申請の導線が出ない", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await login(page, "R9");
  const res = await page.request.get("/field-agents/csv/template", { maxRedirects: 0 });
  expect(res.status(), "権限外はCSVひな形をDLできない").toBeGreaterThanOrEqual(300);
  expect(res.headers()["content-type"] ?? "").not.toContain("text/csv");

  const ctx = await browser.newContext();
  const p4 = await ctx.newPage();
  try {
    await login(p4, "R4");
    await p4.goto("/field-agents");
    await expect(p4.getByRole("button", { name: "CSV一括申請" })).toHaveCount(0);
    await expect(p4.getByRole("button", { name: "＋ 訪販員申請" })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
