// §5.1 の未実装だった操作のE2E（独立レビュー第2回の残存指摘）
// 対象:
//   1. 稼働提出物の「変」= 差し替え（§5.1 稼働提出物 変 / §6.4 二段階承認へ差し戻る）
//   2. 窓口案件の「停」「削」（§5.1 ホットライン/消費者センター 停・削 / §3.4 論理削除）
//   3. 訪販員申請の「変」= 業務項目の変更（§5.1 訪販員申請 変 / §7.4 列仕様バリデーション）
// データプレフィクス: QA19（作成データはすべて QA19 で始まり、afterAll で物理清掃する）
//
// 検証観点（§13）: 正常系のUI操作 → DB検証 → 監査ログ / 権限外ロール（⑧⑨ほか）が実施できないこと /
//                  §7.4 のバリデーションがサーバ側で効くこと。

import { test, expect, type Page } from "@playwright/test";
import {
  fieldAgentScope,
  ACCOUNTS,
  collectConsoleErrors,
  criticalErrors,
  db,
  login,
} from "./helpers";

const RUN = Date.now().toString(36);
const P = (name: string) => `QA19${name}${RUN}`;

const KINDS = [
  "【アライアンス申請書】",
  "【訪販用】稼働エリア申請フォーマット",
  "【ポスティング用】配布エリア申請フォーマット",
] as const;

// 他スイート（QA5=2027/2030/2031年）と衝突しない対象月を使う
const M_R8 = "2032-01";
const M_R7 = "2032-02";
const M_RESUBMIT = "2032-03";
const M_SCOPE = "2032-04";

function jstDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function freshLogin(page: Page, role: keyof typeof ACCOUNTS) {
  await page.context().clearCookies();
  await login(page, role);
}

function rowFor(page: Page, text: string) {
  return page.locator("tbody tr", { hasText: text });
}

async function agencyByCode(code: string) {
  return db().agency.findUniqueOrThrow({ where: { code } });
}

// 監査ログの存在確認（§3.3: 各業務データの変更を記録）
async function auditExists(actor: string, action: string, targetContains: string) {
  return (
    (await db().auditLog.count({
      where: { actor, action, target: { contains: targetContains }, result: "success" },
    })) > 0
  );
}

function xlsxUpload(name: string) {
  return {
    name,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(`QA19 dummy xlsx payload for ${name}`),
  };
}

// ===== テストデータ作成（db()=オーナー接続） =====

async function mkStoredFile(name: string) {
  return db().storedFile.create({
    data: {
      name,
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 32,
      data: Buffer.from("QA19 original submission payload"),
      uploadedBy: "qa19",
    },
  });
}

async function mkSubmission(opts: {
  kind: string;
  targetMonth: string;
  submitterCode: string;
  memo: string;
  status?: string;
  rejectReason?: string | null;
}) {
  const submitter = await agencyByCode(opts.submitterCode);
  const primaryId = submitter.tier === 1 ? submitter.id : submitter.parentId!;
  const file = await mkStoredFile(`${opts.memo}-original.xlsx`);
  const [y, m] = opts.targetMonth.split("-").map(Number);
  return db().submission.create({
    data: {
      kind: opts.kind,
      fiscalYear: m >= 4 ? y : y - 1,
      targetMonth: opts.targetMonth,
      primaryAgencyId: primaryId,
      submitterAgencyId: submitter.id,
      fileId: file.id,
      fileName: file.name,
      memo: opts.memo,
      status: opts.status ?? "approved",
      rejectReason: opts.rejectReason ?? null,
      history: [{ event: "submitted", at: jstDate(), by: "qa19" }],
    },
  });
}

let caseSeq = 0;
async function mkCase(opts: {
  series: "HL" | "CSC";
  title: string;
  status?: string;
  agencyCode?: string;
}) {
  const agency = await agencyByCode(opts.agencyCode ?? "110001");
  const series = opts.series;
  return db().case.create({
    data: {
      series,
      caseNo: `${series === "HL" ? "HLC" : "CSC"}-QA19${RUN}${caseSeq++}`,
      templateKind: "フリー入力",
      title: opts.title,
      primaryAgencyId: agency.id,
      ispNumber: `QA19-${RUN}`,
      deadline: jstDate(7),
      status: opts.status ?? "未対応",
      createdBy: "QA19テスト",
      messages: {
        create: { senderSide: "snc", senderName: "QA19テスト", body: "QA19テスト用の本文です。" },
      },
    },
  });
}

let staffSeq = 0;
async function mkStaff(agencyCode: string) {
  const agency = await agencyByCode(agencyCode);
  staffSeq += 1;
  return db().salesStaff.create({
    data: {
      salesId: `QA19S${RUN}${staffSeq}`,
      lastName: "QA19検証",
      firstName: `試験${staffSeq}`,
      birthDate: "1990-01-01",
      phone: "080-9999-1900",
      agencyId: agency.id,
      status: "registered",
      firstApproved: true,
      history: [{ event: "requested", at: jstDate(), by: "qa19" }],
    },
  });
}

async function mkApplication(
  salesStaffId: string,
  pledgeNo: string,
  extra: Record<string, unknown> = {}
) {
  const scope = await fieldAgentScope(salesStaffId);
  return db().fieldAgentApplication.create({
    data: {
      salesStaffId,
      ...scope, // 代理店スコープ列（§3.1）
      applicationType: "稼働",
      products: "auひかり",
      attribute: "社員/契約社員",
      lastNameKana: "キューエージュウキュウ",
      firstNameKana: "ヘンコウマエ",
      identityType: "免許証",
      pledgeNo,
      agencyCode1: "6YS008",
      startDate: "2026-04-01",
      status: "registered",
      firstApproved: true,
      workMonth: "2026-04",
      history: [{ event: "requested", at: jstDate(), by: "qa19" }],
      ...extra,
    },
  });
}

async function cleanupQa19() {
  const d = db();
  await d.submission.deleteMany({ where: { memo: { startsWith: "QA19" } } });
  await d.case.deleteMany({ where: { caseNo: { contains: "QA19" } } });
  const staff = await d.salesStaff.findMany({
    where: { salesId: { startsWith: "QA19" } },
    select: { id: true },
  });
  const staffIds = staff.map((s) => s.id);
  if (staffIds.length > 0) {
    await d.fieldAgentApplication.deleteMany({ where: { salesStaffId: { in: staffIds } } });
    await d.salesStaff.deleteMany({ where: { id: { in: staffIds } } });
  }
  await d.storedFile.deleteMany({ where: { name: { startsWith: "QA19" } } });
}

test.beforeAll(async () => {
  await cleanupQa19();
});

test.afterAll(async () => {
  try {
    await cleanupQa19();
  } finally {
    await db().$disconnect();
  }
});

// =====================================================================
// 1. 稼働提出物の差し替え（§5.1 稼働提出物「変」= ①②③⑦⑧ / §6.4）
// =====================================================================

test("QA19 提出物差し替え: ⑧が最終承認済みの提出物を差し替え → ファイル更新+pending_firstへ戻る+history(resubmit)+監査ログ", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const memo = P("差し替え");
  const sub = await mkSubmission({
    kind: KINDS[0],
    targetMonth: M_R8,
    submitterCode: "210001", // ⑧の自店
    memo,
    status: "approved",
  });

  await freshLogin(page, "R8");
  await page.goto("/reports?tab=submissions");
  const row = rowFor(page, memo);
  await expect(row).toHaveCount(1);
  await expect(row.getByText("最終承認済み")).toBeVisible();
  await expect(row.getByRole("link", { name: `${memo}-original.xlsx` })).toBeVisible();

  // 差し替え（§5.1「変」）
  await row.locator('input[name="file"]').setInputFiles(xlsxUpload(`${memo}-new.xlsx`));
  await row.getByRole("button", { name: "差し替え" }).click();
  await expect(page.getByText("のファイルを差し替えました（1次店確認中）")).toBeVisible({
    timeout: 20_000,
  });

  // DB検証: ファイル差し替え + ステータスが提出直後（pending_first）へ戻る + history に resubmit
  const updated = await db().submission.findUniqueOrThrow({ where: { id: sub.id } });
  expect(updated.fileName).toBe(`${memo}-new.xlsx`);
  expect(updated.fileId).not.toBe(sub.fileId);
  expect(updated.status).toBe("pending_first");
  expect(updated.memo).toBe(memo); // メモ未入力なら既存メモを維持
  expect(updated.kind).toBe(KINDS[0]);
  expect(updated.targetMonth).toBe(M_R8);
  const events = (updated.history as { event: string; by: string }[]).map((h) => h.event);
  expect(events).toEqual(["submitted", "resubmit"]);
  expect((updated.history as { event: string; by: string }[]).at(-1)!.by).toBe(ACCOUNTS.R8.loginId);
  // 新しいファイルの実体が保存されている（§3.8）
  const stored = await db().storedFile.findUniqueOrThrow({ where: { id: updated.fileId } });
  expect(stored.name).toBe(`${memo}-new.xlsx`);
  // 監査ログ（§3.3）
  expect(await auditExists(ACCOUNTS.R8.loginId, "submission_update", sub.id)).toBe(true);
  // 通知: 1次店（110001）のR7へ差し替え通知
  const notif = await db().notification.findFirst({
    where: {
      account: { loginId: ACCOUNTS.R7.loginId },
      title: "稼働提出物が差し替えられました（1次承認待ち）",
      body: { contains: M_R8 },
    },
  });
  expect(notif).not.toBeNull();

  // 一覧表示も差し替え後のファイル名・ステータスになる
  await page.goto("/reports?tab=submissions");
  const row2 = rowFor(page, memo);
  await expect(row2.getByText("1次店確認中")).toBeVisible();
  await expect(row2.getByRole("link", { name: `${memo}-new.xlsx` })).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

test("QA19 提出物差し替え: ⑦の自店（1次店）名義は pending_snc へ戻り、差戻し理由とメモが更新される", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const memo = P("1次店差し替え");
  const newMemo = `${memo}-更新後メモ`;
  const sub = await mkSubmission({
    kind: KINDS[1],
    targetMonth: M_R7,
    submitterCode: "110001", // ⑦の自店名義（1次店）
    memo,
    status: "rejected",
    rejectReason: "QA19-初回は書式不備",
  });

  await freshLogin(page, "R7");
  await page.goto("/reports?tab=submissions");
  const row = rowFor(page, memo);
  await expect(row).toHaveCount(1);
  await expect(row.getByText("理由: QA19-初回は書式不備")).toBeVisible();

  await row.locator('input[name="file"]').setInputFiles(xlsxUpload(`${memo}-r7.xlsx`));
  await row.locator('input[name="replaceMemo"]').fill(newMemo);
  await row.getByRole("button", { name: "差し替え" }).click();
  await expect(page.getByText("のファイルを差し替えました（SNC確認中）")).toBeVisible({
    timeout: 20_000,
  });

  const updated = await db().submission.findUniqueOrThrow({ where: { id: sub.id } });
  expect(updated.status).toBe("pending_snc"); // §6.4: ⑦自身名義は直接SNCへ
  expect(updated.fileName).toBe(`${memo}-r7.xlsx`);
  expect(updated.memo).toBe(newMemo);
  expect(updated.rejectReason).toBeNull(); // 差戻し理由はクリアされる
  expect((updated.history as { event: string }[]).map((h) => h.event)).toEqual([
    "submitted",
    "resubmit",
  ]);
  expect(await auditExists(ACCOUNTS.R7.loginId, "submission_update", sub.id)).toBe(true);
});

test("QA19 提出物再提出: 同一（種別×対象月×提出元）の再提出は上書きで、レコードは増えない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const memo = P("再提出");
  const memo2 = `${memo}-2回目`;
  const sub = await mkSubmission({
    kind: KINDS[2],
    targetMonth: M_RESUBMIT,
    submitterCode: "210001",
    memo,
    status: "pending_snc",
  });

  await freshLogin(page, "R8");
  await page.goto("/reports?tab=submissions");
  const form = page.locator("form").filter({ has: page.locator('input[name="memo"]') });
  await form.locator('select[name="kind"]').selectOption(KINDS[2]);
  await form.locator('input[name="targetMonth"]').fill(M_RESUBMIT);
  await form.locator('input[name="file"]').setInputFiles(xlsxUpload(`${memo}-again.xlsx`));
  await form.locator('input[name="memo"]').fill(memo2);
  await form.getByRole("button", { name: "提出する" }).click();
  await expect(
    page.getByText("を再提出しました（既存の提出物を上書き / 1次店確認中）")
  ).toBeVisible({
    timeout: 20_000,
  });

  // 同一キーのレコードは1件のまま（上書き）
  const submitter = await agencyByCode("210001");
  const all = await db().submission.findMany({
    where: { kind: KINDS[2], targetMonth: M_RESUBMIT, submitterAgencyId: submitter.id },
  });
  expect(all).toHaveLength(1);
  expect(all[0].id).toBe(sub.id);
  expect(all[0].fileName).toBe(`${memo}-again.xlsx`);
  expect(all[0].memo).toBe(memo2);
  expect(all[0].status).toBe("pending_first");
  expect((all[0].history as { event: string }[]).map((h) => h.event)).toEqual([
    "submitted",
    "resubmit",
  ]);
});

test("QA19 権限外（提出物）: ④に差し替えUIが無い / ⑨は稼働提出物タブ自体が無い / ⑧はスコープ外の提出物を差し替えられない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const outMemo = P("スコープ外");
  await mkSubmission({
    kind: KINDS[0],
    targetMonth: M_SCOPE,
    submitterCode: "110001", // ⑦の自店名義 = ⑧のスコープ外
    memo: outMemo,
    status: "approved",
  });

  // ④（SNC閲覧=ダミー）: 閲覧専用のため差し替えUIが出ない
  await freshLogin(page, "R4");
  await page.goto("/reports?tab=submissions");
  await expect(
    page.getByText("SNC閲覧アカウントは閲覧専用です（ダミーデータ表示）。")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "差し替え" })).toHaveCount(0);

  // ⑨（販売員）: §5.2 で稼働提出物=×。タブが出ず、tab指定でも日報タブになる
  await freshLogin(page, "R9");
  await page.goto("/reports?tab=submissions");
  await expect(page.getByRole("link", { name: "稼働提出物" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "差し替え" })).toHaveCount(0);
  await expect(page.getByText("稼働日報を提出します。")).toBeVisible();

  // ⑧: スコープ外（親1次店名義）の提出物は一覧に出ないため差し替えできない（§3.1）
  await freshLogin(page, "R8");
  await page.goto("/reports?tab=submissions");
  await expect(rowFor(page, outMemo)).toHaveCount(0);
  const untouched = await db().submission.findFirstOrThrow({ where: { memo: outMemo } });
  expect(untouched.status).toBe("approved");
  expect((untouched.history as { event: string }[]).map((h) => h.event)).toEqual(["submitted"]);
});

// =====================================================================
// 2. 窓口案件の停止・削除（§5.1 停/削 = ①②③ + 担当窓口⑤⑥ / §3.4 論理削除）
// =====================================================================

test("QA19 窓口案件停止: ⑤がHL案件を停止 → status=停止+CaseStatusHistory+監査ログ / 代理店⑦は返信できない", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  const title = P("HL停止");
  const c = await mkCase({ series: "HL", title, status: "対応中" });

  await freshLogin(page, "R5");
  await page.goto(`/hotline/${c.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "案件を停止" }).click();

  // DB検証: status=停止 + CaseStatusHistory（対応中 → 停止）
  await expect
    .poll(async () => (await db().case.findUniqueOrThrow({ where: { id: c.id } })).status, {
      timeout: 20_000,
    })
    .toBe("停止");
  const hist = await db().caseStatusHistory.findFirst({
    where: { caseId: c.id, toStatus: "停止" },
  });
  expect(hist).not.toBeNull();
  expect(hist!.fromStatus).toBe("対応中");
  expect(hist!.changedBy).toBe("ホットライン 窓口担当");
  expect(await auditExists(ACCOUNTS.R5.loginId, "case_suspend", c.caseNo)).toBe(true);

  // 停止中はSNC側でも編集・ステータス変更・返信ができず、復旧ボタンだけが出る
  await page.reload();
  await expect(page.getByText("この案件は「停止」です。")).toBeVisible();
  await expect(page.getByRole("button", { name: "ステータス変更" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "緊急アラート" })).toHaveCount(0);
  await expect(page.locator("summary", { hasText: "案件を編集" })).toHaveCount(0);
  await expect(page.locator('textarea[name="body"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "復旧" })).toBeVisible();

  // 代理店⑦は停止された案件へ返信できない（サーバ側で拒否・CaseMessageも増えない）
  const before = await db().caseMessage.count({ where: { caseId: c.id } });
  await freshLogin(page, "R7");
  await page.goto(`/agency-cases/${c.id}`);
  await page.locator('textarea[name="body"]').fill("QA19 停止案件への返信テスト");
  await page.getByRole("button", { name: "返信を送信" }).click();
  await expect(page.getByText("この案件は「停止」のため返信できません。")).toBeVisible({
    timeout: 20_000,
  });
  expect(await db().caseMessage.count({ where: { caseId: c.id } })).toBe(before);

  // 復旧すると停止前のステータス（対応中）へ戻り、返信できるようになる
  await freshLogin(page, "R5");
  await page.goto(`/hotline/${c.id}`);
  await page.getByRole("button", { name: "復旧" }).click();
  await expect
    .poll(async () => (await db().case.findUniqueOrThrow({ where: { id: c.id } })).status, {
      timeout: 20_000,
    })
    .toBe("対応中");
  expect(await auditExists(ACCOUNTS.R5.loginId, "case_restore", c.caseNo)).toBe(true);
  await page.reload();
  await expect(page.locator('textarea[name="body"]')).toHaveCount(1);

  expect(criticalErrors(errors)).toEqual([]);
});

test("QA19 窓口案件削除: ⑥がCSC案件を論理削除 → status=削除済+履歴 / 編集・ステータス変更が拒否される / 復旧で戻る", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const title = P("CSC削除");
  const c = await mkCase({ series: "CSC", title, status: "確認中" });

  await freshLogin(page, "R6");
  await page.goto(`/consumer-center/${c.id}`);
  await expect(page.getByRole("button", { name: "案件を停止" })).toBeVisible();
  await page.getByRole("button", { name: "案件を削除" }).click();

  await expect
    .poll(async () => (await db().case.findUniqueOrThrow({ where: { id: c.id } })).status, {
      timeout: 20_000,
    })
    .toBe("削除済");
  const hist = await db().caseStatusHistory.findFirst({
    where: { caseId: c.id, toStatus: "削除済" },
  });
  expect(hist).not.toBeNull();
  expect(hist!.fromStatus).toBe("確認中");
  expect(await auditExists(ACCOUNTS.R6.loginId, "case_delete", c.caseNo)).toBe(true);

  // 削除済は編集・停止・ステータス変更UIが消え、復旧のみ可能（§3.4）
  await page.reload();
  await expect(page.getByText("この案件は「削除済」です。")).toBeVisible();
  await expect(page.getByRole("button", { name: "案件を停止" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "案件を削除" })).toHaveCount(0);
  await expect(page.locator("summary", { hasText: "案件を編集" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "復旧" })).toBeVisible();
  // 一覧のステータスフィルタから削除済を辿れる（SNC側のみ）
  await page.goto(
    `/consumer-center?q=${encodeURIComponent(c.caseNo)}&status=${encodeURIComponent("削除済")}`
  );
  await expect(page.getByText(c.caseNo)).toBeVisible();

  // 復旧 → 削除前のステータス（確認中）へ戻る
  await page.goto(`/consumer-center/${c.id}`);
  await page.getByRole("button", { name: "復旧" }).click();
  await expect
    .poll(async () => (await db().case.findUniqueOrThrow({ where: { id: c.id } })).status, {
      timeout: 20_000,
    })
    .toBe("確認中");
});

test("QA19 権限外（窓口案件）: ⑦に停止・削除UIが無く返信のみ / ⑧はホットラインにアクセス不可", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = P("窓口権限外");
  const c = await mkCase({ series: "HL", title });

  // ⑦（代理店）: 統合ビューは閲覧・返信のみ（§7.10）。停止・削除UIは無い
  await freshLogin(page, "R7");
  await page.goto(`/agency-cases/${c.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("button", { name: "案件を停止" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "案件を削除" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "復旧" })).toHaveCount(0);
  await expect(page.locator('textarea[name="body"]')).toHaveCount(1);
  // SNC側の窓口ページには入れない
  await page.goto(`/hotline/${c.id}`);
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

  // ⑧（2次店管理者）: ホットライン・消費者センターとも×（§5.2）
  await freshLogin(page, "R8");
  for (const url of [`/hotline/${c.id}`, `/consumer-center/${c.id}`, "/agency-cases"]) {
    await page.goto(url);
    await page.waitForURL(/\/dashboard/, { timeout: 20_000 });
  }

  // 案件は停止・削除されていない
  const unchanged = await db().case.findUniqueOrThrow({ where: { id: c.id } });
  expect(unchanged.status).toBe("未対応");
  expect(await db().caseStatusHistory.count({ where: { caseId: c.id } })).toBe(0);
});

// =====================================================================
// 3. 訪販員申請の業務項目の変更（§5.1 訪販員申請「変」= ①②③⑦ / §7.4）
// =====================================================================

test("QA19 訪販員申請変更: ②が業務項目を更新 → DB更新+history(update)+監査ログ+一覧反映", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);
  const pledgeNo = P("変更前誓約書");
  const newPledgeNo = P("変更後誓約書");
  const staff = await mkStaff("210001");
  const app = await mkApplication(staff.id, pledgeNo);

  await freshLogin(page, "R2");
  await page.goto(`/field-agents?q=${encodeURIComponent(pledgeNo)}`);
  const row = rowFor(page, pledgeNo);
  await expect(row).toHaveCount(1);
  await row.getByRole("link", { name: "変更", exact: true }).click();

  await expect(page.getByRole("heading", { name: "訪販員申請の業務項目を変更" })).toBeVisible();
  const form = page.locator("form", { has: page.locator('input[name="pledgeNo"]') });
  // 既存値がフォームに反映されている
  await expect(form.locator('select[name="products"]')).toHaveValue("auひかり");
  await expect(form.locator('input[name="agencyCode1"]')).toHaveValue("6YS008");
  await expect(form.locator('input[name="lastNameKana"]')).toHaveValue("キューエージュウキュウ");
  await expect(form.locator('input[name="startDate"]')).toHaveAttribute("type", "date");
  await expect(form.locator('input[name="endDate"]')).toHaveAttribute("type", "date");
  // 業務委託会社3項目は属性が業務委託社員以外では入力不可（§7.4）
  await expect(form.locator('input[name="contractorName"]')).toBeDisabled();

  // 業務項目を変更（取扱商材=マルチ → 使用代理店コード2枠必須）
  await form.locator('select[name="products"]').selectOption("マルチ");
  await form.locator('input[name="agencyCode1"]').fill("6YS009");
  await form.locator('input[name="agencyCode2"]').fill("666J08");
  await form.locator('select[name="identityType"]').selectOption("パスポート");
  await form.locator('input[name="lastNameKana"]').fill("ヘンコウ");
  await form.locator('input[name="firstNameKana"]').fill("ゴ");
  await form.locator('input[name="pledgeNo"]').fill(newPledgeNo);
  await form.locator('input[name="startDate"]').fill("2026-05-01");
  await form.locator('input[name="endDate"]').fill("2027-03-31");
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("訪販員申請の業務項目を更新しました。")).toBeVisible({
    timeout: 20_000,
  });

  // DB検証
  const updated = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(updated.products).toBe("マルチ");
  expect(updated.agencyCode1).toBe("6YS009");
  expect(updated.agencyCode2).toBe("666J08");
  expect(updated.identityType).toBe("パスポート");
  expect(updated.lastNameKana).toBe("ヘンコウ");
  expect(updated.firstNameKana).toBe("ゴ");
  expect(updated.pledgeNo).toBe(newPledgeNo);
  expect(updated.startDate).toBe("2026-05-01");
  expect(updated.endDate).toBe("2027-03-31");
  expect(updated.applicationType).toBe("稼働");
  expect(updated.status).toBe("registered"); // ステータス・承認状態は変わらない
  expect(updated.workMonth).toBe("2026-04");
  const events = (updated.history as { event: string; by: string }[]).map((h) => h.event);
  expect(events).toContain("update");
  expect(
    (updated.history as { event: string; by: string }[]).find((h) => h.event === "update")!.by
  ).toBe(ACCOUNTS.R2.loginId);
  // 監査ログ（§3.3。変更前後の値を含む）
  expect(await auditExists(ACCOUNTS.R2.loginId, "訪販員申請変更", app.id)).toBe(true);
  const log = await db().auditLog.findFirstOrThrow({
    where: { actor: ACCOUNTS.R2.loginId, action: "訪販員申請変更", target: { contains: app.id } },
    orderBy: { createdAt: "desc" },
  });
  expect(log.target).toContain("取扱商材 auひかり→マルチ");

  // 一覧に変更後の値が反映される
  await page.goto(`/field-agents?q=${encodeURIComponent(newPledgeNo)}`);
  const row2 = rowFor(page, newPledgeNo);
  await expect(row2).toHaveCount(1);
  await expect(row2).toContainText("マルチ");
  await expect(row2).toContainText("ヘンコウ ゴ");

  expect(criticalErrors(errors)).toEqual([]);
});

test("QA19 訪販員申請変更 バリデーション: マルチは2枠必須 / 業務委託社員は3項目必須（サーバ側で拒否・DB不変）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pledgeNo = P("変更検証");
  const staff = await mkStaff("210001");
  const app = await mkApplication(staff.id, pledgeNo);

  await freshLogin(page, "R3");
  await page.goto(`/field-agents?q=${encodeURIComponent(pledgeNo)}`);
  await rowFor(page, pledgeNo).getByRole("link", { name: "変更", exact: true }).click();
  const form = page.locator("form", { has: page.locator('input[name="pledgeNo"]') });

  // 取扱商材=マルチ で2枠目が空 → サーバ側で拒否（required属性を外して送信）
  await form.locator('select[name="products"]').selectOption("マルチ");
  await form.locator('input[name="agencyCode2"]').fill("");
  await form.evaluate((el) => {
    el.querySelectorAll("input[required]").forEach((i) => i.removeAttribute("required"));
  });
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(
    page.getByText("取扱商材が「マルチ」の場合、使用代理店コードは2枠とも必須です。")
  ).toBeVisible({ timeout: 20_000 });

  // 属性=業務委託社員 で3項目が空 → サーバ側で拒否
  await form.locator('select[name="products"]').selectOption("auひかり");
  await form.locator('select[name="attribute"]').selectOption("業務委託社員");
  await expect(form.locator('input[name="contractorName"]')).toBeEnabled();
  await form.evaluate((el) => {
    el.querySelectorAll("input[required]").forEach((i) => i.removeAttribute("required"));
  });
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(
    page.getByText("属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です。")
  ).toBeVisible({ timeout: 20_000 });

  // 誓約書Noを空にすると拒否される（§7.4 入力必須）
  await form.locator('select[name="attribute"]').selectOption("社員/契約社員");
  await form.locator('input[name="pledgeNo"]').fill("   ");
  await form.evaluate((el) => {
    el.querySelectorAll("input[required]").forEach((i) => i.removeAttribute("required"));
  });
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("誓約書Noは入力必須です。")).toBeVisible({ timeout: 20_000 });

  // ここまでDBは一切変わっていない
  const unchanged = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(unchanged.products).toBe("auひかり");
  expect(unchanged.agencyCode2).toBeNull();
  expect(unchanged.attribute).toBe("社員/契約社員");
  expect(unchanged.pledgeNo).toBe(pledgeNo);
  expect((unchanged.history as { event: string }[]).map((h) => h.event)).not.toContain("update");

  // 3項目を埋めれば保存できる（属性=業務委託社員のときのみ保持される §7.4）
  await form.locator('input[name="pledgeNo"]').fill(pledgeNo);
  await form.locator('select[name="attribute"]').selectOption("業務委託社員");
  await form.locator('input[name="contractorName"]').fill("QA19業務委託株式会社");
  await form.locator('input[name="contractorAddress"]').fill("〒100-0000 東京都千代田区QA19");
  await form.locator('input[name="contractorPhone"]').fill("03-1900-1900");
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("訪販員申請の業務項目を更新しました。")).toBeVisible({
    timeout: 20_000,
  });
  const saved = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(saved.attribute).toBe("業務委託社員");
  expect(saved.contractorName).toBe("QA19業務委託株式会社");
  expect(saved.contractorAddress).toBe("〒100-0000 東京都千代田区QA19");
  expect(saved.contractorPhone).toBe("03-1900-1900");

  // 属性を業務委託社員以外へ戻すと3項目はクリアされる（他属性では入力不可 §7.4）
  await form.locator('select[name="attribute"]').selectOption("個人事業主");
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect
    .poll(
      async () =>
        (await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } }))
          .contractorName,
      { timeout: 20_000 }
    )
    .toBeNull();
  const cleared = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(cleared.attribute).toBe("個人事業主");
  expect(cleared.contractorAddress).toBeNull();
  expect(cleared.contractorPhone).toBeNull();
});

test("QA19 訪販員申請変更: ⑦は自店配下（210001）を変更できる（⑦は自店配下のみ §14-11）", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pledgeNo = P("配下変更");
  const staff = await mkStaff("210001");
  const app = await mkApplication(staff.id, pledgeNo);

  await freshLogin(page, "R7");
  await page.goto(`/field-agents?q=${encodeURIComponent(pledgeNo)}`);
  await rowFor(page, pledgeNo).getByRole("link", { name: "変更", exact: true }).click();
  const form = page.locator("form", { has: page.locator('input[name="pledgeNo"]') });
  await form.locator('select[name="applicationType"]').selectOption("抹消");
  await form.locator('input[name="endDate"]').fill("2026-12-31");
  await form.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("訪販員申請の業務項目を更新しました。")).toBeVisible({
    timeout: 20_000,
  });

  const updated = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(updated.applicationType).toBe("抹消");
  expect(updated.endDate).toBe("2026-12-31");
  expect(updated.status).toBe("registered"); // 変更では承認状態を動かさない
  expect(await auditExists(ACCOUNTS.R7.loginId, "訪販員申請変更", app.id)).toBe(true);
});

test("QA19 権限外（訪販員申請）: ⑧に変更UIが無く ?edit= でも変更フォームが出ない / ⑨はページ自体にアクセス不可", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const pledgeNo = P("変更権限外");
  const staff = await mkStaff("210001"); // ⑧の自店
  const app = await mkApplication(staff.id, pledgeNo);

  // ⑧: §5.1 訪販員申請は「申」のみ。変更リンクも変更フォームも出ない
  await freshLogin(page, "R8");
  await page.goto(`/field-agents?q=${encodeURIComponent(pledgeNo)}`);
  const row = rowFor(page, pledgeNo);
  await expect(row).toHaveCount(1); // 自店なので行自体は見える
  await expect(row.getByRole("link", { name: "変更", exact: true })).toHaveCount(0);
  await page.goto(`/field-agents?edit=${app.id}`);
  await expect(page.getByRole("heading", { name: "訪販員申請の業務項目を変更" })).toHaveCount(0);
  await expect(page.locator('input[name="pledgeNo"]')).toHaveCount(0);
  // 申請フォーム（⑧=申）は使える
  await expect(page.getByRole("button", { name: "＋ 訪販員申請" })).toBeVisible();

  // ⑨: 訪販員申請ページ自体にアクセスできない（§5.2）
  await freshLogin(page, "R9");
  await page.goto(`/field-agents?edit=${app.id}`);
  await page.waitForURL(/\/dashboard/, { timeout: 20_000 });

  // DBは変わっていない
  const unchanged = await db().fieldAgentApplication.findUniqueOrThrow({ where: { id: app.id } });
  expect(unchanged.pledgeNo).toBe(pledgeNo);
  expect((unchanged.history as { event: string }[]).map((h) => h.event)).not.toContain("update");
});
