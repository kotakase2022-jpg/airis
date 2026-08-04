/**
 * QA担当: server action のエラー可視化（§3.2）と不正利用検知アラート（要件1-9）の回帰テスト
 * データプレフィクス: QA21（作成した行は afterAll / finally で必ず後始末する）
 *
 * 検証観点:
 *  (A) 販売員ID管理の行内操作（1次承認・停止・再開・削除・復旧）が
 *      「権限不足」「状態不整合」「対象不在」で **無反応にならず** ユーザー向けメッセージを表示する
 *  (B) お知らせの行内操作（送信・停止・削除）が同様にメッセージを表示する
 *  (C) 直近1時間の不正利用シグナル（並行ログイン / 直近成功IPと異なるIP）を検知して
 *      ②SNC管理者へ通知＋監査記録し、ダッシュボードの「不正利用アラート件数」が0以外になる
 *
 * 「権限不足」の分岐は UI 上でボタンが隠れるため、QA21専用アカウントの実効ロールを
 * ページ描画後に差し替えて（＝権限を失った状態で同じ操作を送信して）検証する。
 * シードアカウントには一切触れない。
 */
import { test, expect, Page } from "@playwright/test";
import { ACCOUNTS, PW_ADMIN, db, login } from "./helpers";

const P = "QA21";
const RUN = Date.now().toString().slice(-7);
const CRON_SECRET = process.env.CRON_SECRET ?? "qa-test-secret";

const created = {
  salesStaffIds: [] as string[],
  announcementIds: [] as string[],
  accountLoginIds: [] as string[],
};

// StatCard の値を取得（ラベル完全一致 → 同カード内の数値div）
function statCard(page: Page, label: string) {
  return page.locator(`div.min-w-0:has(div.truncate:text-is("${label}"))`).locator("div.text-2xl");
}

async function agencyByCode(code: string) {
  const ag = await db().agency.findUnique({ where: { code } });
  expect(ag, `代理店 ${code} がシードされていること`).toBeTruthy();
  return ag!;
}

async function loginAs(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 15_000 });
}

// QA21専用アカウント（パスワードはシードアカウントのハッシュを流用＝PW_ADMIN）
async function mkAccount(loginId: string, role: string, agencyId: string | null) {
  const d = db();
  const src = await d.account.findUnique({ where: { loginId: ACCOUNTS.R2.loginId } });
  expect(src, "②のシードアカウントが存在すること").toBeTruthy();
  await d.account.deleteMany({ where: { loginId } });
  const acc = await d.account.create({
    data: {
      loginId,
      role,
      name: `${P} ${role} 検証用`,
      agencyId,
      status: "active",
      passwordHash: src!.passwordHash, // = PW_ADMIN
      mustChangePassword: false,
    },
  });
  created.accountLoginIds.push(loginId);
  return acc;
}

async function mkStaff(lastName: string, agencyCode: string, status: string) {
  const ag = await agencyByCode(agencyCode);
  const staff = await db().salesStaff.create({
    data: {
      lastName,
      firstName: "検証",
      birthDate: "1991-01-01",
      phone: "080-2121-2121",
      agencyId: ag.id,
      status,
      firstApproved: status !== "applying",
      deletedAt: status === "deleted" ? new Date() : null,
      history: [{ event: "requested", at: "2026-08-01", by: "qa21-seed" }],
    },
  });
  created.salesStaffIds.push(staff.id);
  return staff;
}

async function mkAnnouncement(title: string, status: string) {
  const ann = await db().announcement.create({
    data: {
      audience: "all",
      title,
      body: `${P} エラー可視化検証用のお知らせ`,
      important: false,
      isDummy: false,
      status,
      sentAt: status === "draft" ? null : new Date(),
      createdBy: ACCOUNTS.R2.loginId,
    },
  });
  created.announcementIds.push(ann.id);
  return ann;
}

function staffRow(page: Page, lastName: string) {
  return page.locator("tbody tr", { hasText: lastName });
}

function annRow(page: Page, title: string) {
  return page.locator("tbody tr", { hasText: title });
}

test.afterAll(async () => {
  const d = db();
  await d.salesStaff.deleteMany({ where: { id: { in: created.salesStaffIds } } });
  await d.salesStaff.deleteMany({ where: { lastName: { startsWith: P } } });
  await d.announcement.deleteMany({ where: { id: { in: created.announcementIds } } });
  await d.announcement.deleteMany({ where: { title: { startsWith: P } } });
  if (created.accountLoginIds.length > 0) {
    // Session / Notification は onDelete: Cascade
    await d.account.deleteMany({ where: { loginId: { in: created.accountLoginIds } } });
  }
  await d.accessLog.deleteMany({ where: { loginId: { startsWith: P } } });
  await d.auditLog.deleteMany({ where: { actor: { startsWith: P } } });
  await d.auditLog.deleteMany({ where: { actor: "system-cron", target: { contains: P } } });
});

// ===========================================================================
// (A) 販売員ID管理: 行内操作のエラーが必ず画面に出る（§3.2）
// ===========================================================================
test("販売員ID: スコープ外になった販売員の停止はエラーメッセージが表示され、DBは変化しない", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const lastName = `${P}スコープ外${RUN}`;
  const staff = await mkStaff(lastName, "110001", "registered");

  await login(page, "R7"); // 110001の1次店管理者（自店配下スコープ）
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = staffRow(page, lastName);
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("button", { name: "停止", exact: true })).toBeVisible();

  // 画面描画後に対象をスコープ外（別の1次店）へ移動させ、権限外の操作にする
  const other = await agencyByCode("150008");
  await db().salesStaff.update({ where: { id: staff.id }, data: { agencyId: other.id } });

  await row.getByRole("button", { name: "停止", exact: true }).click();
  const err = row.getByTestId("row-action-error");
  await expect(err, "無反応ではなくエラーメッセージが表示される").toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("対象の販売員が見つかりません");

  const after = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(after.status, "停止は行われていない").toBe("registered");
});

test("販売員ID: 状態不整合（既に1次承認済み）の1次承認はエラーメッセージが表示される", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const lastName = `${P}状態不整合${RUN}`;
  const staff = await mkStaff(lastName, "110001", "applying");

  await login(page, "R7");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = staffRow(page, lastName);
  await expect(row.getByRole("button", { name: "1次承認", exact: true })).toBeVisible();

  // 別経路で先に1次承認された状態を作る（同時操作の競合）
  await db().salesStaff.update({
    where: { id: staff.id },
    data: { status: "provisional", firstApproved: true },
  });

  await row.getByRole("button", { name: "1次承認", exact: true }).click();
  const err = row.getByTestId("row-action-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("申請中の販売員のみ1次承認できます");
  await expect(err, "現在の状態がユーザーに分かる").toContainText("仮登録");

  // 履歴に approve_first が二重に積まれていない
  const after = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  const events = (after.history as { event: string }[]).map((h) => h.event);
  expect(events.filter((e) => e === "approve_first").length).toBe(0);
});

test("販売員ID: 既に削除済みの販売員の削除はエラーメッセージが表示される", async ({ page }) => {
  test.setTimeout(90_000);
  const lastName = `${P}削除済${RUN}`;
  const staff = await mkStaff(lastName, "110001", "registered");

  await login(page, "R7");
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = staffRow(page, lastName);
  page.on("dialog", (dlg) => dlg.accept()); // 削除確認ダイアログを承諾
  await expect(row.getByRole("button", { name: "削除", exact: true })).toBeVisible();

  await db().salesStaff.update({
    where: { id: staff.id },
    data: { status: "deleted", deletedAt: new Date() },
  });

  await row.getByRole("button", { name: "削除", exact: true }).click();
  const err = row.getByTestId("row-action-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("すでに削除されています");
});

test("販売員ID: 権限を失ったアカウントの停止操作は「権限がありません」を表示し、監査ログにdeniedを残す", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const loginId = `${P}_staff_writer_${RUN}`;
  const lastName = `${P}権限不足停止${RUN}`;
  const p1 = await agencyByCode("110001");
  const acc = await mkAccount(loginId, "R7", p1.id); // ⑦（停止権限あり）として描画
  const staff = await mkStaff(lastName, "110001", "registered");

  await loginAs(page, loginId, PW_ADMIN);
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = staffRow(page, lastName);
  const btn = row.getByRole("button", { name: "停止", exact: true });
  await expect(btn).toBeVisible();

  // 描画後に⑧（停止権限なし。§5.1 販売員ID ⑧=申のみ）へ差し替える
  await db().account.update({ where: { id: acc.id }, data: { role: "R8" } });

  await btn.click();
  const err = row.getByTestId("row-action-error");
  await expect(err, "権限不足でも無反応にしない").toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("販売員IDの停止権限がありません");

  expect((await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } })).status).toBe(
    "registered"
  );
  await expect
    .poll(
      async () =>
        db().auditLog.count({
          where: { actor: loginId, action: "sales_staff_suspend", result: "denied" },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);
});

test("販売員ID: 復旧はSNC管理系のみ。権限を失うと「復旧権限がありません」を表示する", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const loginId = `${P}_restore_${RUN}`;
  const lastName = `${P}権限不足復旧${RUN}`;
  const acc = await mkAccount(loginId, "R2", null); // ②（復旧可）として描画
  const staff = await mkStaff(lastName, "110001", "deleted");

  await loginAs(page, loginId, PW_ADMIN);
  await page.goto(`/sales-staff?q=${encodeURIComponent(lastName)}`);
  const row = staffRow(page, lastName);
  const btn = row.getByRole("button", { name: "復旧", exact: true });
  await expect(btn).toBeVisible();

  // 描画後に⑦（復旧権限なし。§3.4 の復旧はSNC管理系限定）へ差し替える
  await db().account.update({ where: { id: acc.id }, data: { role: "R7" } });

  await btn.click();
  const err = row.getByTestId("row-action-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("復旧権限がありません");

  const after = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
  expect(after.status, "復旧は行われていない").toBe("deleted");
  await expect
    .poll(
      async () =>
        db().auditLog.count({
          where: { actor: loginId, action: "sales_staff_restore", result: "denied" },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);
});

// ===========================================================================
// (B) お知らせ: 行内操作のエラーが必ず画面に出る（§3.2 / §7.7）
// ===========================================================================
test("お知らせ: 既に送信済みになった下書きの送信はエラーメッセージが表示される", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const title = `${P}送信競合${RUN}`;
  const ann = await mkAnnouncement(title, "draft");

  await login(page, "R2");
  await page.goto("/announcements");
  const row = annRow(page, title);
  await expect(row.getByRole("button", { name: "送信", exact: true })).toBeVisible();

  // 別経路で先に送信された状態を作る
  await db().announcement.update({
    where: { id: ann.id },
    data: { status: "sent", sentAt: new Date() },
  });

  await row.getByRole("button", { name: "送信", exact: true }).click();
  const err = row.getByTestId("announcement-row-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("下書きのお知らせのみ送信できます");
  await expect(err).toContainText("送信済み");
});

test("お知らせ: 対象が消えている削除はエラーメッセージが表示される", async ({ page }) => {
  test.setTimeout(90_000);
  const title = `${P}対象不在${RUN}`;
  const ann = await mkAnnouncement(title, "sent");

  await login(page, "R2");
  await page.goto("/announcements");
  const row = annRow(page, title);
  const btn = row.getByRole("button", { name: "削除", exact: true });
  await expect(btn).toBeVisible();

  // 描画後に対象が失われた状態を作る
  await db().announcement.delete({ where: { id: ann.id } });

  await btn.click();
  const err = row.getByTestId("announcement-row-error");
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("対象のお知らせが見つかりません");
});

test("お知らせ: 権限を失ったアカウントの停止操作は「停止権限がありません」を表示し、監査ログにdeniedを残す", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const loginId = `${P}_ann_writer_${RUN}`;
  const title = `${P}権限不足停止${RUN}`;
  const acc = await mkAccount(loginId, "R2", null); // ②（停止可）として描画
  const ann = await mkAnnouncement(title, "sent");

  await loginAs(page, loginId, PW_ADMIN);
  await page.goto("/announcements");
  const row = annRow(page, title);
  const btn = row.getByRole("button", { name: "停止", exact: true });
  await expect(btn).toBeVisible();

  // 描画後に⑦（お知らせは閲覧のみ。§5.1）へ差し替える
  await db().account.update({ where: { id: acc.id }, data: { role: "R7" } });

  await btn.click();
  const err = row.getByTestId("announcement-row-error");
  await expect(err, "権限不足でも無反応にしない").toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText("お知らせの停止権限がありません");

  expect((await db().announcement.findUniqueOrThrow({ where: { id: ann.id } })).status).toBe("sent");
  await expect
    .poll(
      async () =>
        db().auditLog.count({
          where: { actor: loginId, action: "announcement.stop", result: "denied" },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);
});

// ===========================================================================
// (C) 不正利用検知（要件1-9）: 直近1時間の異常 → ②へ通知＋監査 → ダッシュボードのカードが0以外
// ===========================================================================
test("不正利用検知: 直近1時間の並行ログイン・IP変化を検知し、②へ通知＋監査＋ダッシュボードのアラート件数が0以外になる", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const d = db();
  const loginId = `${P}_abuse_${RUN}`;
  const acc = await mkAccount(loginId, "R5", null);

  // --- ダッシュボード（②）の現在値を取得
  await login(page, "R2");
  await page.goto(`/dashboard?qa=${RUN}-before`);
  const before = Number((await statCard(page, "不正利用アラート件数").innerText()).trim());
  expect(Number.isFinite(before)).toBe(true);

  const start = new Date();
  try {
    // --- 準備1: 直近1時間に作成された有効セッション3件（同一アカウントの並行ログイン）
    await d.session.createMany({
      data: [1, 2, 3].map((i) => ({
        token: `${P}-token-${RUN}-${i}`,
        accountId: acc.id,
        createdAt: new Date(Date.now() - i * 60 * 1000),
        expiresAt: new Date(Date.now() + 3600 * 1000),
      })),
    });
    // --- 準備2: 直近1時間に「直近の成功IPと異なるIP」からのログイン成功（アクセスログ §3.3）
    await d.accessLog.createMany({
      data: [
        {
          loginId,
          accountId: acc.id,
          result: "success",
          ip: "198.51.100.11",
          userAgent: `${P}-agent`,
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
        },
        {
          loginId,
          accountId: acc.id,
          result: "success",
          ip: "198.51.100.22",
          userAgent: `${P}-agent`,
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
        },
      ],
    });

    // --- 検知バッチ実行
    const res = await request.get("/api/cron/daily", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      timeout: 60_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(
      body.abuseSignals.realtimeConcurrentSessions,
      "直近1時間の並行ログインが検知されること"
    ).toBeGreaterThanOrEqual(1);
    expect(
      body.abuseSignals.realtimeIpChange,
      "直近1時間のIP変化が検知されること"
    ).toBeGreaterThanOrEqual(1);

    // --- 監査記録（§3.3）: シグナル種別ごとに result=detected で残る
    for (const action of ["abuse_realtime_concurrent_sessions", "abuse_realtime_ip_change"]) {
      const row = await d.auditLog.findFirst({
        where: {
          actor: "system-cron",
          action,
          target: { contains: loginId },
          createdAt: { gte: start },
        },
      });
      expect(row, `監査ログ ${action} が記録されること`).not.toBeNull();
      expect(row!.result).toBe("detected");
    }
    // IP変化のシグナルには「どのIPからどのIPへ」が含まれる
    const ipRow = await d.auditLog.findFirst({
      where: {
        actor: "system-cron",
        action: "abuse_realtime_ip_change",
        target: { contains: loginId },
        createdAt: { gte: start },
      },
    });
    expect(ipRow!.target).toContain("198.51.100.11");
    expect(ipRow!.target).toContain("198.51.100.22");

    // --- ②SNC管理者へアプリ内通知（メールは notifyRole が同時送信 §3.7）
    const r2s = await d.account.findMany({
      where: { role: "R2", status: "active" },
      select: { id: true },
    });
    expect(r2s.length).toBeGreaterThan(0);
    for (const r2 of r2s) {
      const notification = await d.notification.findFirst({
        where: { accountId: r2.id, title: { contains: "不正利用検知" }, createdAt: { gte: start } },
        orderBy: { createdAt: "desc" },
      });
      expect(notification, "②へ不正利用検知の通知が作成されること").not.toBeNull();
      expect(notification!.link).toBe("/admin");
    }

    // --- ダッシュボードの「不正利用アラート件数」が0以外になる（§7.1）
    await page.goto(`/dashboard?qa=${RUN}-after`);
    const after = Number((await statCard(page, "不正利用アラート件数").innerText()).trim());
    expect(after, "アラート件数が0以外になること").toBeGreaterThan(0);
    expect(after, "検知分だけ増えること").toBeGreaterThan(before);
  } finally {
    // 本テストの実行分の通知・監査・アクセスログ・セッションを後始末
    await d.notification.deleteMany({
      where: { title: { contains: "不正利用検知" }, createdAt: { gte: start } },
    });
    await d.auditLog.deleteMany({
      where: { actor: "system-cron", action: { startsWith: "abuse_" }, createdAt: { gte: start } },
    });
    await d.accessLog.deleteMany({ where: { loginId } });
    await d.session.deleteMany({ where: { accountId: acc.id } });
  }
});
