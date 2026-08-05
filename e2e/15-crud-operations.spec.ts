// 変更（update）操作のE2E（§5.1「変」/ §7.3 操作列「編集」/ §7.7 / §7.8）
// 対象: 販売員IDの編集 / お知らせの編集 / 窓口案件の編集（件名・対応期限）
// データプレフィクス: QA15（作成データはすべて QA15 で始まり、afterAll で物理清掃する）
//
// 検証観点（§13）: 正常系のUI操作 → DB検証 → 監査ログ、および権限外ロール（⑧⑨ほか）が編集できないこと。

import { test, expect, type Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import { ACCOUNTS, PW_GENERAL, collectConsoleErrors, criticalErrors, db, login } from "./helpers";

const RUN = Date.now().toString(36);
const P = (name: string) => `QA15${name}${RUN}`;

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

// 案件編集フォーム（<details>）を開いた状態にする。保存後の再レンダリングでは
// details の open 状態がDOMに保持されるため、summary の再クリックは「閉じる」動作になる。
async function ensureCaseEditorOpen(page: Page) {
  const details = page.locator("details", { has: page.locator('input[name="deadline"]') });
  await details.waitFor();
  await details.evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
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

// ===== テストデータ作成 =====
async function mkStaff(opts: { lastName: string; agencyCode: string; withAccount?: boolean }) {
  const agency = await agencyByCode(opts.agencyCode);
  let accountId: string | undefined;
  const loginId = `QA15S${RUN}${opts.agencyCode}`;
  if (opts.withAccount) {
    const acc = await db().account.create({
      data: {
        loginId,
        role: "R9",
        name: `${opts.lastName} 旧名`,
        email: "qa15-old@example.com",
        agencyId: agency.id,
        status: "active",
        passwordHash: bcrypt.hashSync("Qa15-Dummy-Password-2026", 4),
        mustChangePassword: false,
      },
    });
    accountId = acc.id;
  }
  return db().salesStaff.create({
    data: {
      salesId: opts.withAccount ? loginId : null,
      lastName: opts.lastName,
      firstName: "旧名",
      birthDate: "1990-01-01",
      phone: "090-0000-0000",
      email: "qa15-old@example.com",
      agencyId: agency.id,
      status: "registered",
      firstApproved: true,
      accountId,
      history: [{ event: "requested", at: jstDate(), by: "qa15" }],
    },
  });
}

async function mkAnnouncement(opts: {
  title: string;
  audience?: string;
  status?: string;
  important?: boolean;
}) {
  return db().announcement.create({
    data: {
      audience: opts.audience ?? "all",
      title: opts.title,
      body: "QA15 変更前の本文です。",
      important: opts.important ?? false,
      status: opts.status ?? "sent",
      sentAt: opts.status === "draft" ? null : new Date(),
      createdBy: "qa15",
    },
  });
}

let caseSeq = 0;
async function mkCase(opts: { series: "HL" | "CSC"; title: string; deadline?: string | null }) {
  const agency = await agencyByCode("110001");
  const series = opts.series;
  return db().case.create({
    data: {
      series,
      caseNo: `${series === "HL" ? "HLC" : "CSC"}-QA15${RUN}${caseSeq++}`,
      templateKind: "フリー入力",
      title: opts.title,
      primaryAgencyId: agency.id,
      ispNumber: `QA15-${RUN}`,
      deadline: opts.deadline === undefined ? jstDate(7) : opts.deadline,
      status: "未対応",
      createdBy: "QA15テスト",
      messages: {
        create: { senderSide: "snc", senderName: "QA15テスト", body: "QA15テスト用の本文です。" },
      },
    },
  });
}

async function cleanupQa15() {
  const d = db();
  const staff = await d.salesStaff.findMany({
    where: { lastName: { startsWith: "QA15" } },
    select: { id: true, accountId: true },
  });
  const accIds = staff.map((s) => s.accountId).filter((x): x is string => !!x);
  await d.salesStaff.deleteMany({ where: { id: { in: staff.map((s) => s.id) } } });
  if (accIds.length > 0) {
    await d.notification.deleteMany({ where: { accountId: { in: accIds } } });
    await d.account.deleteMany({ where: { id: { in: accIds } } });
  }
  await d.account.deleteMany({ where: { loginId: { startsWith: "QA15" } } });
  await d.announcement.deleteMany({ where: { title: { startsWith: "QA15" } } });
  await d.case.deleteMany({ where: { caseNo: { contains: "QA15" } } });
}

test.beforeAll(async () => {
  await cleanupQa15();
});

test.afterAll(async () => {
  try {
    await cleanupQa15();
  } finally {
    await db().$disconnect();
  }
});

// =====================================================================
// 販売員IDの編集（§7.3 操作列「編集」/ §5.1 販売員ID「変」= ①②③⑦）
// =====================================================================

test("販売員ID編集: R2が氏名・生年月日・電話・メールを更新 → DB更新+history(update)+R9アカウント同期+監査ログ", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const lastName = P("販売員編集");
  const staff = await mkStaff({ lastName, agencyCode: "150008", withAccount: true });

  await freshLogin(page, "R2");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = rowFor(page, lastName);
  await expect(row).toHaveCount(1);
  // 編集前の表示（生年月日 / 電話 / メール）
  await expect(row).toContainText("1990-01-01");
  await expect(row).toContainText("090-0000-0000");

  await row.getByRole("button", { name: "編集", exact: true }).click();
  const form = row.locator("form", { has: page.locator('input[name="lastName"]') });
  await expect(form.locator('input[name="lastName"]')).toHaveValue(lastName);
  await expect(form.locator('input[name="firstName"]')).toHaveValue("旧名");

  await form.locator('input[name="firstName"]').fill("新名");
  await form.locator('input[name="birthDate"]').fill("1985-12-24");
  await form.locator('input[name="phone"]').fill("080-1111-9999");
  await form.locator('input[name="email"]').fill("qa15-new@example.com");
  await form.getByRole("button", { name: "保存" }).click();

  await expect(page.getByText(`${lastName} 新名 さんの登録情報を更新しました`)).toBeVisible({
    timeout: 15_000,
  });

  // DB検証
  const updated = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(updated.lastName).toBe(lastName);
  expect(updated.firstName).toBe("新名");
  expect(updated.birthDate).toBe("1985-12-24");
  expect(updated.phone).toBe("080-1111-9999");
  expect(updated.email).toBe("qa15-new@example.com");
  expect(updated.status).toBe("registered"); // ステータスは変わらない
  // 履歴に update イベントが積まれる（§4.1 履歴テーブル相当のJSON履歴）
  const history = updated.history as { event: string; by: string }[];
  expect(history.map((h) => h.event)).toContain("update");
  expect(history.find((h) => h.event === "update")!.by).toBe(ACCOUNTS.R2.loginId);
  // 発行済みR9アカウントの氏名・メールも同期される
  const acc = await db().account.findUniqueOrThrow({ where: { id: updated.accountId! } });
  expect(acc.name).toBe(`${lastName} 新名`);
  expect(acc.email).toBe("qa15-new@example.com");
  // 監査ログ（§3.3 変更）
  expect(await auditExists(ACCOUNTS.R2.loginId, "sales_staff_update", staff.id)).toBe(true);

  // 一覧の表示も更新後の値になる
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row2 = rowFor(page, lastName);
  await expect(row2).toContainText("1985-12-24");
  await expect(row2).toContainText("080-1111-9999");
  await expect(row2).toContainText("qa15-new@example.com");

  expect(criticalErrors(errors)).toEqual([]);
});

test("販売員ID編集: R7は自店配下（210001）を編集できる（⑦は自店配下のみ §14-11）", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const lastName = P("配下編集");
  const staff = await mkStaff({ lastName, agencyCode: "210001" });

  await freshLogin(page, "R7");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = rowFor(page, lastName);
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "編集", exact: true }).click();
  const form = row.locator("form", { has: page.locator('input[name="lastName"]') });
  await form.locator('input[name="phone"]').fill("070-2222-3333");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText(/登録情報を更新しました/)).toBeVisible({ timeout: 15_000 });

  const updated = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(updated.phone).toBe("070-2222-3333");
  expect(await auditExists(ACCOUNTS.R7.loginId, "sales_staff_update", staff.id)).toBe(true);
});

test("販売員ID編集 異常系: 必須未入力・生年月日形式不正はサーバ側で拒否されDBは変わらない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const lastName = P("編集検証");
  const staff = await mkStaff({ lastName, agencyCode: "150008" });

  await freshLogin(page, "R2");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = rowFor(page, lastName);
  await row.getByRole("button", { name: "編集", exact: true }).click();
  const form = row.locator("form", { has: page.locator('input[name="lastName"]') });

  // required属性を外して空のまま送信 → サーバ側エラー
  await form.locator('input[name="lastName"], input[name="firstName"]').first().waitFor();
  await form.evaluate((el) => {
    el.querySelectorAll("input[required]").forEach((i) => i.removeAttribute("required"));
  });
  await form.locator('input[name="firstName"]').fill("");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByText("必須項目（姓・名・生年月日・電話番号）を入力してください")
  ).toBeVisible({ timeout: 15_000 });

  // 生年月日の形式不正（type=date のブラウザ制約を外して送信）
  const birth = form.locator('input[name="birthDate"]');
  await expect
    .poll(
      async () => {
        await birth.evaluate((el) => {
          const i = el as HTMLInputElement;
          i.type = "text";
          i.value = "1985/12/24";
        });
        await page.waitForTimeout(400);
        return birth.evaluate((el) => {
          const i = el as HTMLInputElement;
          return `${i.type}:${i.value}`;
        });
      },
      { timeout: 15_000 }
    )
    .toBe("text:1985/12/24");
  await form.locator('input[name="firstName"]').fill("新名");
  await form.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByText("生年月日は実在する日付を YYYY-MM-DD 形式で入力してください")
  ).toBeVisible({
    timeout: 15_000,
  });

  // DBは編集前のまま
  const unchanged = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(unchanged.firstName).toBe("旧名");
  expect(unchanged.birthDate).toBe("1990-01-01");
  expect((unchanged.history as { event: string }[]).map((h) => h.event)).not.toContain("update");
});

test("権限外: ⑧（2次店管理者）と④（ダミー）に販売員IDの編集UIが出ない / ⑨はページ自体にアクセス不可", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const lastName = P("権限外編集");
  await mkStaff({ lastName, agencyCode: "210001" });

  // ⑧: 自店（210001）の販売員は見えるが「編集」ボタンは無い（§5.1 販売員ID ⑧=申のみ）
  await freshLogin(page, "R8");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = rowFor(page, lastName);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);
  // 申請フォームは⑧にも表示される（⑧=申）
  await expect(page.locator("summary", { hasText: "＋ 販売員ID申請" })).toHaveCount(1);

  // ④: ダミー表示（実データは見えず・編集UIも無い）
  await freshLogin(page, "R4");
  await page.goto("/sales-staff");
  await expect(page.getByText("閲覧のみ").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);

  // ⑨: 販売員IDページにアクセスできない（§5.2）
  await freshLogin(page, "R9");
  await page.goto("/sales-staff");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  await expect(page).toHaveURL(/\/dashboard/);
});

// =====================================================================
// お知らせの編集（§5.1 お知らせ「変」= ①②③ / §7.7）
// =====================================================================

test("お知らせ編集: R3が送信済みのタイトル・本文・重要フラグを更新 → DB更新+閲覧側に反映+監査ログ", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const title = P("お知らせ編集");
  const newTitle = `${title}-更新後`;
  const ann = await mkAnnouncement({ title, audience: "all", status: "sent" });

  await freshLogin(page, "R3");
  await page.goto("/announcements");
  const row = rowFor(page, title);
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "編集", exact: true }).click();

  const form = row.locator("form", { has: page.locator('input[name="title"]') });
  await expect(form.locator('input[name="title"]')).toHaveValue(title);
  await form.locator('input[name="title"]').fill(newTitle);
  await form.locator('textarea[name="body"]').fill("QA15 変更後の本文です。");
  await form.locator('input[name="important"]').check();
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("お知らせを更新しました")).toBeVisible({ timeout: 15_000 });

  // DB検証
  const updated = await db().announcement.findUniqueOrThrow({ where: { id: ann.id } });
  expect(updated.title).toBe(newTitle);
  expect(updated.body).toBe("QA15 変更後の本文です。");
  expect(updated.important).toBe(true);
  expect(updated.audience).toBe("all"); // 宛先は変更されない
  expect(updated.status).toBe("sent");
  expect(await auditExists(ACCOUNTS.R3.loginId, "announcement.update", ann.id)).toBe(true);

  // 閲覧側（⑨）にも更新後のタイトル・本文が反映される
  await freshLogin(page, "R9");
  await page.goto("/announcements");
  await expect(page.getByRole("link", { name: newTitle })).toBeVisible();
  await page.goto(`/announcements/${ann.id}`);
  await expect(page.getByRole("heading", { name: newTitle })).toBeVisible();
  await expect(page.getByText("QA15 変更後の本文です。")).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

test("お知らせ編集: 下書きは編集可・停止中は編集不可 / タイトル空白はエラー", async ({ page }) => {
  test.setTimeout(90_000);
  const draftTitle = P("下書き編集");
  const stoppedTitle = P("停止中");
  const draft = await mkAnnouncement({ title: draftTitle, status: "draft" });
  await mkAnnouncement({ title: stoppedTitle, status: "stopped" });

  await freshLogin(page, "R2");
  await page.goto("/announcements");

  // 下書き: 編集できる
  const draftRow = rowFor(page, draftTitle);
  await draftRow.getByRole("button", { name: "編集", exact: true }).click();
  const form = draftRow.locator("form", { has: page.locator('input[name="title"]') });
  await form.locator('textarea[name="body"]').fill("QA15 下書きを修正しました。");
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("お知らせを更新しました")).toBeVisible({ timeout: 15_000 });
  const updatedDraft = await db().announcement.findUniqueOrThrow({ where: { id: draft.id } });
  expect(updatedDraft.body).toBe("QA15 下書きを修正しました。");
  expect(updatedDraft.status).toBe("draft"); // 編集では送信されない
  expect(updatedDraft.sentAt).toBeNull();

  // 停止中: 編集ボタンが出ない（送信済み・下書きのみ編集可）
  const stoppedRow = rowFor(page, stoppedTitle);
  await expect(stoppedRow).toHaveCount(1);
  await expect(stoppedRow.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);

  // タイトル空白のみ → サーバ側でエラー・DBは変わらない（保存後も編集フォームは開いたまま）
  const form2 = rowFor(page, draftTitle).locator("form", {
    has: page.locator('input[name="title"]'),
  });
  await form2.locator('input[name="title"]').fill("   ");
  await form2.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("タイトルを入力してください")).toBeVisible({ timeout: 15_000 });
  expect((await db().announcement.findUniqueOrThrow({ where: { id: draft.id } })).title).toBe(
    draftTitle
  );
});

test("権限外: ⑦⑧⑨（閲覧のみ）にお知らせの編集UIが出ない", async ({ page }) => {
  test.setTimeout(90_000);
  const title = P("閲覧のみ");
  await mkAnnouncement({ title, audience: "all", status: "sent" });

  for (const role of ["R7", "R8", "R9"] as const) {
    await freshLogin(page, role);
    await page.goto("/announcements");
    // 一覧には表示される（§5.1 ⑦⑧⑨=閲）
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    // 編集・停止・削除・作成UIは一切出ない
    await expect(page.getByRole("button", { name: "編集", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "削除", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "作成して送信" })).toHaveCount(0);
  }
});

// =====================================================================
// 窓口案件の編集（§5.1 ホットライン/消センター「変」= ①②③ + 担当窓口⑤⑥）
// =====================================================================

test("窓口案件編集: R5がHL案件の件名・対応期限を更新 → DB更新+期限バッジ変化+監査ログ", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectConsoleErrors(page);
  const title = P("HL案件編集");
  const newTitle = `${title}-更新後`;
  const c = await mkCase({ series: "HL", title, deadline: jstDate(7) });

  await freshLogin(page, "R5");
  await page.goto(`/hotline/${c.id}`);
  await expect(page.getByText("期限まで7日")).toBeVisible();

  await page.locator("summary", { hasText: "案件を編集（件名・対応期限）" }).click();
  const form = page.locator("form", { has: page.locator('input[name="deadline"]') });
  await expect(form.locator('input[name="title"]')).toHaveValue(title);
  await form.locator('input[name="title"]').fill(newTitle);
  await form.locator('input[name="deadline"]').fill(jstDate(-2));
  await form.getByRole("button", { name: "保存", exact: true }).click();

  // 期限超過バッジに変化し、ヘッダの件名も更新される
  await expect(page.getByText("期限超過 2日")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: newTitle })).toBeVisible();

  // DB検証
  const updated = await db().case.findUniqueOrThrow({ where: { id: c.id } });
  expect(updated.title).toBe(newTitle);
  expect(updated.deadline).toBe(jstDate(-2));
  expect(updated.status).toBe("未対応"); // ステータスは変わらない
  expect(await auditExists(ACCOUNTS.R5.loginId, "case_update", updated.caseNo)).toBe(true);

  // 対応期限を空欄にすると期限バッジが消える
  await ensureCaseEditorOpen(page);
  await form.locator('input[name="deadline"]').fill("");
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect
    .poll(async () => (await db().case.findUniqueOrThrow({ where: { id: c.id } })).deadline, {
      timeout: 15_000,
    })
    .toBeNull();
  await expect(page.getByText(/期限超過|期限まで|本日期限/)).toHaveCount(0);

  expect(criticalErrors(errors)).toEqual([]);
});

test("窓口案件編集: ①②③は両窓口を編集可 / ⑥は消費者センターのみ（HLはページアクセス不可）", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const cscTitle = P("CSC案件編集");
  const hlTitle = P("HL担当外");
  const csc = await mkCase({ series: "CSC", title: cscTitle, deadline: jstDate(3) });
  const hl = await mkCase({ series: "HL", title: hlTitle, deadline: jstDate(3) });

  // ⑥: 消費者センター案件は編集できる
  await freshLogin(page, "R6");
  await page.goto(`/consumer-center/${csc.id}`);
  await page.locator("summary", { hasText: "案件を編集（件名・対応期限）" }).click();
  const form = page.locator("form", { has: page.locator('input[name="deadline"]') });
  await form.locator('input[name="deadline"]').fill(jstDate(10));
  await form.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText("期限まで10日")).toBeVisible({ timeout: 15_000 });
  expect((await db().case.findUniqueOrThrow({ where: { id: csc.id } })).deadline).toBe(jstDate(10));

  // ⑥: ホットライン窓口はページ自体にアクセス不可（§5.1 ⑥のHL=×）
  await page.goto(`/hotline/${hl.id}`);
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  expect((await db().case.findUniqueOrThrow({ where: { id: hl.id } })).deadline).toBe(jstDate(3));

  // ②: HL案件も編集できる（①②③は両窓口）
  await freshLogin(page, "R2");
  await page.goto(`/hotline/${hl.id}`);
  await page.locator("summary", { hasText: "案件を編集（件名・対応期限）" }).click();
  const form2 = page.locator("form", { has: page.locator('input[name="deadline"]') });
  await form2.locator('input[name="title"]').fill(`${hlTitle}-②更新`);
  await form2.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${hlTitle}-②更新` })).toBeVisible({
    timeout: 15_000,
  });
  expect((await db().case.findUniqueOrThrow({ where: { id: hl.id } })).title).toBe(
    `${hlTitle}-②更新`
  );
});

test("権限外: ⑦（代理店）は窓口案件を編集できず返信のみ（編集UI・ステータス変更UIが無い）", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = P("代理店側編集不可");
  const c = await mkCase({ series: "HL", title, deadline: jstDate(5) });

  await freshLogin(page, "R7");
  // 統合ビュー（§7.10）では閲覧・返信のみ
  await page.goto(`/agency-cases/${c.id}`);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.locator("summary", { hasText: "案件を編集" })).toHaveCount(0);
  await expect(page.locator('input[name="deadline"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ステータス変更" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "緊急アラート" })).toHaveCount(0);
  // 返信フォームは表示される（⑦の唯一の書き込み手段）
  await expect(page.locator('textarea[name="body"]')).toHaveCount(1);

  // SNC側の窓口ページには入れない（§5.2 ⑦はホットライン=〇だが統合ビューへ集約。/hotlineは代理店不可）
  await page.goto(`/hotline/${c.id}`);
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

  // 案件は編集されていない
  const unchanged = await db().case.findUniqueOrThrow({ where: { id: c.id } });
  expect(unchanged.title).toBe(title);
  expect(unchanged.deadline).toBe(jstDate(5));
});

test("未ログインでは編集対象ページにアクセスできない（/loginへ）", async ({ page }) => {
  const title = P("未ログイン");
  const c = await mkCase({ series: "HL", title });
  await page.context().clearCookies();
  for (const url of ["/sales-staff", "/announcements", `/hotline/${c.id}`]) {
    await page.goto(url);
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  }
  expect(PW_GENERAL.length).toBeGreaterThanOrEqual(14); // 一般アカウント最小桁数（§4.2）
});
