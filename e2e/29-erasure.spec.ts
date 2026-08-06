// テナント一括削除・個人情報のオンデマンド匿名化・ベンダー区分（§10.3 / §10.1 / SEC要件②#31）
// の実機E2E。
//
// 経緯（QA loop5 の独立監査で検出）:
//   docs/SEC_CHECKLIST.md の SEC-10.1-14 / SEC-10.3-10 / SEC-10.3-12 は検証証跡として
//   `e2e/04-admin.spec.ts` の「テナント削除→配下データが参照不可」「削除実行後にレポートが表示」
//   「ベンダー区分の付与→監査ログに vendor=true」を挙げていたが、**04-admin.spec.ts に該当する
//   テストは存在しなかった**（ファイルは実在するがテストが無い＝より見つけにくい虚偽証跡）。
//   e2e 全体を `erase|匿名化|一括削除|vendor` で検索して 0 ヒットであることを確認済み。
//   §10.3 はリリース条件のため、証跡ゼロのまま PASS にはできない。本ファイルがその証跡になる。
//
// 検証データは**このテスト専用の代理店・アカウント・販売員**を作って使う。
// 削除は破壊的操作なので、シード済みの代理店を対象にすると他のテストを壊す。
// 終了時に afterAll で物理削除して DB を元に戻す（本番の論理削除仕様とは無関係のテスト後始末）。

import { test, expect, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { ACCOUNTS, db, login, PW_ADMIN, PW_GENERAL } from "./helpers";

// アカウント一覧テーブルの行だけを掴む（監査ログ・アクセスログの行にも同じログインIDが
// 現れるため、page.locator("tr") では複数一致して不安定になる。e2e/04-admin.spec.ts と同じ方式）
function accountRow(page: Page, loginId: string) {
  return page
    .locator("table")
    .filter({ has: page.locator("th", { hasText: "ログインID" }) })
    .locator("tbody tr", { hasText: loginId });
}

const RUN = Date.now().toString(36).slice(-5);
const P1_CODE = `19${RUN.slice(-4)}`.slice(0, 6); // 1次店（6桁）
const P2_CODE = `29${RUN.slice(-4)}`.slice(0, 6); // 配下2次店
const ANON = "（匿名化済み）";

type Ids = { p1: string; p2: string; accP1: string; accP2: string; staff1: string; staff2: string };
const ids: Partial<Ids> = {};

async function seedTenant(): Promise<Ids> {
  const p1 = await db().agency.create({
    data: { code: P1_CODE, name: `QA削除用1次店${RUN}`, tier: 1, representative: "削除 太郎" },
  });
  const p2 = await db().agency.create({
    data: {
      code: P2_CODE,
      name: `QA削除用2次店${RUN}`,
      tier: 2,
      parentId: p1.id,
      representative: "削除 次郎",
    },
  });
  const mkAccount = async (loginId: string, role: string, agencyId: string) =>
    db().account.create({
      data: {
        loginId,
        role,
        name: `QA削除対象${loginId}`,
        email: `${loginId}@example.com`,
        agencyId,
        status: "active",
        passwordHash: bcrypt.hashSync(PW_GENERAL, 4),
        mustChangePassword: false,
      },
    });
  const mkStaff = async (salesId: string, agencyId: string, lastName: string) =>
    db().salesStaff.create({
      data: {
        salesId,
        lastName,
        firstName: "花子",
        birthDate: "1990-01-01",
        phone: "090-1111-2222",
        agencyId,
        status: "registered",
        firstApproved: true,
        history: [{ event: "requested", at: "2026-08-06", by: "qa5" }],
      },
    });
  const accP1 = await mkAccount(`airis_1${P1_CODE}_9${RUN.slice(-2)}`, "R7", p1.id);
  const accP2 = await mkAccount(`airis_2${P2_CODE}_9${RUN.slice(-2)}`, "R8", p2.id);
  const staff1 = await mkStaff(`QAE1${RUN}`, p1.id, `削除対象一${RUN}`);
  const staff2 = await mkStaff(`QAE2${RUN}`, p2.id, `削除対象二${RUN}`);
  return {
    p1: p1.id,
    p2: p2.id,
    accP1: accP1.id,
    accP2: accP2.id,
    staff1: staff1.id,
    staff2: staff2.id,
  };
}

test.beforeAll(async () => {
  Object.assign(ids, await seedTenant());
});

test.afterAll(async () => {
  // テスト用データの後始末（作成したものだけを物理削除する）
  await db().salesStaff.deleteMany({ where: { agencyId: { in: [ids.p1!, ids.p2!] } } });
  await db().account.deleteMany({ where: { agencyId: { in: [ids.p1!, ids.p2!] } } });
  await db().statusHistory.deleteMany({
    where: { entityId: { in: [ids.accP1!, ids.accP2!, ids.staff1!, ids.staff2!] } },
  });
  await db().agency.deleteMany({ where: { id: { in: [ids.p2!, ids.p1!] } } });
  await db().account.update({
    where: { loginId: ACCOUNTS.R1.loginId },
    data: { isVendor: true },
  });
});

// ===== SEC-10.1-14 ベンダー区分 =====

test("①サスラボ社保守アカウントはベンダー区分を持ち、同じ監査ログ基盤に実行者として記録される（§10.1 / SPEC L433）", async ({
  page,
}) => {
  // SPEC の原文は「サスラボ社の保守アカウントも個人単位で発行し、**同じ監査ログ基盤で記録**
  // （ベンダー区分属性を持たせる）」。要求は (a) 個人単位のID (b) 同一基盤での記録
  // (c) ベンダー区分属性の保持 まで。**全監査行への vendor=true 付与は仕様要求ではない**
  // （実装は特権操作にのみ付与する。その付与は後段のテナント一括削除テストで検証する）。
  // 当初これを「全操作に vendor=true」と書いたが、仕様より厳しい独自基準だったため
  // 仕様の記述に合わせた（期待値を緩めたのではなく、根拠を仕様へ戻した）。
  const actor = await db().account.findUniqueOrThrow({
    where: { loginId: ACCOUNTS.R1.loginId },
    select: { id: true, isVendor: true, agencyId: true },
  });
  expect(actor.isVendor, "①保守アカウントにベンダー区分が付いていません（シードの欠落）").toBe(
    true
  );

  const since = new Date();
  await login(page, "R1");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "管理画面" }).first()).toBeVisible();

  // (b) 通常アカウントと同じ AuditLog に、個人のログインIDが実行者として残ること。
  //     これによりベンダー操作は actor → Account.isVendor の突合で判別できる。
  const rows = await db().auditLog.findMany({
    where: { actor: ACCOUNTS.R1.loginId, createdAt: { gte: since } },
    select: { action: true },
  });
  expect(rows.length, "①の操作が監査ログに残っていない").toBeGreaterThan(0);
  expect(rows.some((r) => r.action === "view_admin")).toBe(true);
  const vendorLoginIds = (
    await db().account.findMany({ where: { isVendor: true }, select: { loginId: true } })
  ).map((a) => a.loginId);
  expect(
    vendorLoginIds.includes(ACCOUNTS.R1.loginId),
    "監査ログの実行者からベンダー操作を判別できません"
  ).toBe(true);
});

test("①がベンダー区分を付与・解除でき、変更自体が監査ログに残る", async ({ page }) => {
  const target = await db().account.findUniqueOrThrow({ where: { id: ids.accP2! } });
  const since = new Date();

  // ベンダー区分の管理は①のみ（canManageVendorFlag = 設定変更権限 ∧ ①申請可能ロール）。
  await login(page, "R1");
  await page.goto(`/admin?q=${encodeURIComponent(target.loginId)}`);
  const row = accountRow(page, target.loginId);
  await expect(row).toHaveCount(1);
  await expect(row.getByText("通常")).toBeVisible();

  page.on("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "ベンダーに設定" }).click();
  await expect(row.getByText("ベンダー")).toBeVisible();
  expect((await db().account.findUniqueOrThrow({ where: { id: target.id } })).isVendor).toBe(true);

  const changed = await db().auditLog.findMany({
    where: { actor: ACCOUNTS.R1.loginId, createdAt: { gte: since } },
    select: { action: true, target: true },
  });
  expect(
    changed.some((r) => r.action === "account_vendor_change"),
    `ベンダー区分の変更が監査ログに残っていません: ${JSON.stringify(changed)}`
  ).toBe(true);

  // 解除もできる（付与しかできないと誤設定を戻せない）
  await row.getByRole("button", { name: "ベンダー解除" }).click();
  await expect(row.getByText("通常")).toBeVisible();
  expect((await db().account.findUniqueOrThrow({ where: { id: target.id } })).isVendor).toBe(false);
});

for (const role of ["R2", "R3"] as const) {
  test(`${role === "R2" ? "②" : "③"}はベンダー区分を変更できない（権限不足・UIにボタンが出ない）`, async ({
    page,
  }) => {
    const target = await db().account.findUniqueOrThrow({ where: { id: ids.accP2! } });
    await login(page, role);
    await page.goto(`/admin?q=${encodeURIComponent(target.loginId)}`);
    const row = accountRow(page, target.loginId);
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: /ベンダー/ })).toHaveCount(0);
    expect((await db().account.findUniqueOrThrow({ where: { id: target.id } })).isVendor).toBe(
      false
    );
  });
}

// ===== SEC-10.3-10 / SEC-10.3-12 テナント一括削除と削除完了レポート =====

test("②はテナント一括削除を実行できない（実行できるのは①のみ・権限不足）", async ({ page }) => {
  await login(page, "R2");
  await page.goto("/admin");
  const card = page
    .locator("div")
    .filter({ hasText: "テナント（代理店）単位のデータ一括削除" })
    .last();
  await expect(page.getByText("テナント（代理店）単位のデータ一括削除")).toBeVisible();
  await expect(page.getByRole("button", { name: "テナントデータを一括削除する" })).toHaveCount(0);
  await expect(
    page.getByText("実行できるのは①サスラボ社システム管理アカウントです", { exact: false })
  ).toBeVisible();
  expect(card).toBeTruthy();
  // 対象データが無傷であること
  expect(
    (await db().account.findUniqueOrThrow({ where: { id: ids.accP1! } })).deletedAt
  ).toBeNull();
});

test("①がテナントを一括削除すると、配下2次店を含めて論理削除され、削除完了レポート（対象件数・データ種別・実行日時・実行者）が表示される", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const since = new Date();
  await login(page, "R1");
  await page.goto("/admin");

  await page
    .locator("select[name='agencyId']")
    .selectOption({ label: `1次 ${P1_CODE} QA削除用1次店${RUN}` });
  await page.fill("input[name='erasureReason']", `QA5 削除証明テスト（${RUN}）`);
  await page.check("input[name='includeChildren']");

  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "テナントデータを一括削除する" }).click();

  // --- 削除完了レポート（SEC-10.3-12：対象件数・データ種別・実行日時・実行者） ---
  const report = page.getByTestId("erasure-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(`実行者: ${ACCOUNTS.R1.loginId}`);
  await expect(report, "①はベンダーなのでベンダー操作と表示されるべき").toContainText(
    "（ベンダー操作）"
  );
  await expect(report).toContainText(`QA削除用1次店${RUN}`);
  await expect(report).toContainText(`QA5 削除証明テスト（${RUN}）`);
  // 実行日時が JST の "YYYY-MM-DD HH:MM" 形式で入っていること
  await expect(report).toContainText(/実行日時:\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  // データ種別ごとの件数（アカウント2件・販売員2件が最低含まれる）
  await expect(report).toContainText(/Airisアカウント[^0-9]*2件/);
  await expect(report).toContainText(/販売員[^0-9]*2件/);

  // --- DBで論理削除されていること（SEC-10.3-10。配下2次店も対象） ---
  for (const [label, id] of [
    ["1次店アカウント", ids.accP1!],
    ["2次店アカウント", ids.accP2!],
  ] as const) {
    const a = await db().account.findUniqueOrThrow({ where: { id } });
    expect(a.status, `${label} が削除済になっていない`).toBe("deleted");
    expect(a.deletedAt, `${label} の deletedAt が記録されていない`).not.toBeNull();
  }
  for (const [label, id] of [
    ["1次店販売員", ids.staff1!],
    ["2次店販売員", ids.staff2!],
  ] as const) {
    const s = await db().salesStaff.findUniqueOrThrow({ where: { id } });
    expect(s.status, `${label} が削除済になっていない`).toBe("deleted");
    expect(s.deletedAt, `${label} の deletedAt が記録されていない`).not.toBeNull();
  }
  // 物理削除はしない（§3.4 1年保持）
  expect(await db().account.count({ where: { id: ids.accP1! } })).toBe(1);

  // --- 監査ログ（SEC-028 / §10.4） ---
  const logs = await db().auditLog.findMany({
    where: { actor: ACCOUNTS.R1.loginId, action: "erasure_agency_bulk", createdAt: { gte: since } },
    select: { target: true, result: true },
  });
  expect(logs.length, "テナント一括削除が監査ログに残っていない").toBeGreaterThan(0);
  expect(logs[0].result).toBe("success");
  expect(logs[0].target ?? "", "監査ログに削除理由・件数が入っていない").toContain("total=");
  expect(logs[0].target ?? "").toContain("vendor=true");

  // --- 削除完了レポートCSV（①②のみ到達可） ---
  const csv = await page.request.get("/admin/csv?type=erasure");
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body).toContain("実行日時");
  expect(body).toContain(ACCOUNTS.R1.loginId);
  expect(body, "CSVに削除理由が出力されていない").toContain(`QA5 削除証明テスト（${RUN}）`);
});

test("削除済みテナントのアカウントではログインできない（削除の実効性）", async ({ page }) => {
  const target = await db().account.findUniqueOrThrow({ where: { id: ids.accP1! } });
  // 前提の明示: 直前のテナント一括削除で論理削除済みであること。
  // これを確認せずにログインを試すと、削除が実行されていないだけなのか
  // 削除済みでも認証できてしまうのかを区別できない（切り分け可能性の確保）。
  expect(target.status, "前提条件が崩れている: 対象が削除済みになっていない").toBe("deleted");

  await page.goto("/login");
  await page.fill("input[name='loginId']", target.loginId);
  await page.fill("input[name='password']", PW_GENERAL);
  await page.getByRole("button", { name: "ログイン" }).click();
  // 削除済みは認証を通してはいけない（§3.4。理由を明かさない汎用メッセージ §10.5）
  await expect(page.getByText("IDまたはパスワードが正しくありません")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/login/);
  expect(await db().session.count({ where: { accountId: target.id } })).toBe(0);
});

// ===== SEC-10.3-11 個人情報のオンデマンド匿名化 =====

test("②が販売員の個人情報を即時匿名化でき、個人情報カラムが匿名化され数値実績は残る", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // 匿名化専用の販売員（削除済みテナントとは別の代理店に作る）
  const staff = await db().salesStaff.create({
    data: {
      salesId: `QAA1${RUN}`,
      lastName: `匿名化対象${RUN}`,
      firstName: "三郎",
      birthDate: "1988-03-03",
      phone: "090-3333-4444",
      agencyId: (await db().agency.findFirstOrThrow({ where: { code: "110001" } })).id,
      status: "registered",
      firstApproved: true,
      history: [{ event: "requested", at: "2026-08-06", by: "qa5" }],
    },
  });
  const since = new Date();

  await login(page, "R2");
  await page.goto("/admin");
  await page.locator("select[name='entityType']").selectOption("sales_staff");
  await page.fill("input[name='targetKey']", staff.salesId!);
  await page.fill("input[name='anonymizeReason']", `本人からの削除請求（QA5 ${RUN}）`);
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "個人情報を匿名化する" }).click();

  const report = page.getByTestId("erasure-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report).toContainText(staff.salesId!);
  await expect(report).toContainText("匿名化");
  await expect(report).toContainText(`実行者: ${ACCOUNTS.R2.loginId}`);

  const after = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(after.lastName, "氏名が匿名化されていない").toBe(ANON);
  expect(after.lastName).not.toContain(RUN);
  expect(after.phone, "電話番号が残っている").not.toBe("090-3333-4444");
  expect(after.anonymizedAt, "anonymizedAt が記録されていない").not.toBeNull();
  expect(after.status, "個人情報を消したレコードは論理削除も行う（§3.4）").toBe("deleted");
  // 分析用の識別子は残る（数値実績を紐づけられなくなるのを防ぐ）
  expect(after.salesId).toBe(staff.salesId);

  const logs = await db().auditLog.findMany({
    where: {
      actor: ACCOUNTS.R2.loginId,
      action: "erasure_pii_anonymize",
      createdAt: { gte: since },
    },
    select: { target: true, result: true },
  });
  expect(logs.length, "匿名化が監査ログに残っていない").toBeGreaterThan(0);
  expect(logs[0].result).toBe("success");
  expect(logs[0].target ?? "").toContain(staff.salesId!);

  // 実行後、対象種別のセレクトは既定値（Airisアカウント）へ戻る。
  // 不可逆操作のフォームとしては望ましくないが（BUG-L15 として軽微で記録）、
  // 種別が見えている以上の誤操作にはならない。重複操作の検証はここを踏まえて種別を再指定する。
  await expect(page.locator("select[name='entityType']")).toHaveValue("account");

  // 重複操作: 同じ対象をもう一度匿名化してもエラーになり、二重に匿名化・記録されない
  const auditBefore = await db().auditLog.count({
    where: { action: "erasure_pii_anonymize", target: { contains: staff.salesId! } },
  });
  await page.locator("select[name='entityType']").selectOption("sales_staff");
  await page.fill("input[name='targetKey']", staff.salesId!);
  await page.fill("input[name='anonymizeReason']", `重複実行の確認（QA5 ${RUN}）`);
  await page.getByRole("button", { name: "個人情報を匿名化する" }).click();
  await expect(page.getByText("すでに匿名化済みです")).toBeVisible({ timeout: 30_000 });
  expect(
    await db().auditLog.count({
      where: { action: "erasure_pii_anonymize", target: { contains: staff.salesId! } },
    }),
    "重複実行が成功として二重に監査記録されている"
  ).toBe(auditBefore);

  await db().statusHistory.deleteMany({ where: { entityId: staff.id } });
  await db().salesStaff.delete({ where: { id: staff.id } });
});

test("匿名化: 存在しない識別子はエラーになり、既存データは変更されない（異常系・存在オラクル対策）", async ({
  page,
}) => {
  const before = await db().salesStaff.count({ where: { anonymizedAt: { not: null } } });
  await login(page, "R2");
  await page.goto("/admin");
  await page.locator("select[name='entityType']").selectOption("sales_staff");
  await page.fill("input[name='targetKey']", `NOPE${RUN}`);
  await page.fill("input[name='anonymizeReason']", "存在しない対象の指定");
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "個人情報を匿名化する" }).click();
  await expect(page.getByText("対象の販売員が見つかりません")).toBeVisible({ timeout: 30_000 });
  expect(await db().salesStaff.count({ where: { anonymizedAt: { not: null } } })).toBe(before);
});

test("匿名化: ④ダミー表示モードの代理店データは操作できない（§3.5）", async ({ page }) => {
  const dummy = await db().salesStaff.findFirst({
    where: { agency: { isDummy: true }, anonymizedAt: null, salesId: { not: null } },
  });
  test.skip(!dummy, "ダミー代理店の販売員がシードされていない");
  await login(page, "R2");
  await page.goto("/admin");
  await page.locator("select[name='entityType']").selectOption("sales_staff");
  await page.fill("input[name='targetKey']", dummy!.salesId!);
  await page.fill("input[name='anonymizeReason']", "ダミーデータの指定");
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "個人情報を匿名化する" }).click();
  await expect(page.getByText("サンプルデータの販売員は操作できません")).toBeVisible({
    timeout: 30_000,
  });
  expect(
    (await db().salesStaff.findUniqueOrThrow({ where: { id: dummy!.id } })).anonymizedAt
  ).toBeNull();
});

test("③は個人情報の匿名化を実行できない（権限不足）", async ({ page }) => {
  await login(page, "R3");
  await page.goto("/admin");
  await expect(page.getByText("個人情報のオンデマンド削除（匿名化）")).toBeVisible();
  await expect(page.getByRole("button", { name: "個人情報を匿名化する" })).toHaveCount(0);
  await expect(page.getByText("実行できるのは①②です", { exact: false })).toBeVisible();
  expect(PW_ADMIN).toBeTruthy();
});

// ===== §8 アカウント申請の個人情報も匿名化されること（QA loop5 で欠落を検出）=====

test("②がアカウントを匿名化すると、発行元のアカウント申請の氏名・メールも匿名化される", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // AccountRequest.name / email は @pii だが匿名化経路が一つも無く恒久保持されていた。
  // 発行先アカウントの匿名化に連動することを実機で確認する。
  const agency = await db().agency.findFirstOrThrow({ where: { code: "110001" } });
  const loginId = `airis_1110001_9${RUN.slice(-2)}`;
  const account = await db().account.create({
    data: {
      loginId,
      role: "R7",
      name: `申請連動テスト${RUN}`,
      email: `${loginId}@example.com`,
      agencyId: agency.id,
      status: "active",
      passwordHash: bcrypt.hashSync(PW_GENERAL, 4),
      mustChangePassword: false,
    },
  });
  const req = await db().accountRequest.create({
    data: {
      requestId: `QAREQ${RUN}`,
      role: "R7",
      name: `申請者本名${RUN}`,
      email: `applicant-${RUN}@example.com`,
      agencyId: agency.id,
      status: "approved",
      issuedLoginId: loginId,
      history: [{ event: "approved", at: "2026-08-06", by: "qa5" }],
    },
  });

  await login(page, "R2");
  await page.goto("/admin");
  await page.locator("select[name='entityType']").selectOption("account");
  await page.fill("input[name='targetKey']", loginId);
  await page.fill("input[name='anonymizeReason']", `申請連動の確認（QA5 ${RUN}）`);
  page.on("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "個人情報を匿名化する" }).click();

  const report = page.getByTestId("erasure-report");
  await expect(report).toBeVisible({ timeout: 30_000 });
  // 削除完了レポートに申請の件数が出る（削除証明として何を消したか分かること）
  await expect(report).toContainText("Airisアカウント申請");
  await expect(report).toContainText("削除件数合計: 2件");

  const afterReq = await db().accountRequest.findUniqueOrThrow({ where: { id: req.id } });
  expect(afterReq.name, "申請の氏名が匿名化されていない（個人情報が残る）").toBe(ANON);
  expect(afterReq.name).not.toContain(RUN);
  expect(afterReq.email, "申請のメールが匿名化されていない").toBe(ANON);
  expect(afterReq.anonymizedAt, "anonymizedAt が記録されていない").not.toBeNull();
  // 申請ID・ロール・状態は分析用に残る（誰の申請だったかは消え、件数統計は保てる）
  expect(afterReq.requestId).toBe(`QAREQ${RUN}`);
  expect(afterReq.status).toBe("approved");

  await db().statusHistory.deleteMany({ where: { entityId: account.id } });
  await db().accountRequest.delete({ where: { id: req.id } });
  await db().auditLog.deleteMany({ where: { actor: loginId } });
  await db().account.delete({ where: { id: account.id } });
});
