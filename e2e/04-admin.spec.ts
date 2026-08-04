/**
 * QA担当: 管理画面（Airisアカウント管理）（§7.2 / §3.3 / §3.4 / §3.6）
 * データプレフィクス: QA2
 */
import { test, expect, Page } from "@playwright/test";
import bcrypt from "bcryptjs";
import {
  ACCOUNTS,
  db,
  login,
  collectConsoleErrors,
  criticalErrors,
} from "./helpers";

const RUN = Date.now();

// 統計カード（StatCard）の数値をラベルから取得
async function statValue(page: Page, label: string): Promise<number> {
  const card = page
    .locator("div.grid > div.rounded-2xl")
    .filter({ has: page.locator("div.truncate", { hasText: label }) });
  const txt = await card.locator("div.text-2xl").innerText();
  return Number(txt.trim());
}

// QA2専用アカウントをDB直で作成（シード行を破壊しないため）
async function createQa2Account(
  loginId: string,
  opts: { role?: string; status?: string; name?: string } = {}
): Promise<{ id: string; agencyId: string }> {
  const s1 = await db().agency.findUnique({ where: { code: "210001" } });
  if (!s1) throw new Error("シード代理店210001が見つかりません");
  const acc = await db().account.create({
    data: {
      loginId,
      role: opts.role ?? "R8",
      name: opts.name ?? `QA2テスト ${loginId}`,
      email: `${loginId}@example.com`,
      agencyId: s1.id,
      status: opts.status ?? "active",
      passwordHash: bcrypt.hashSync(`Qa2-Initial-${RUN}!x`, 10),
      mustChangePassword: false,
    },
  });
  return { id: acc.id, agencyId: s1.id };
}

// アカウント一覧テーブル（「ログインID」ヘッダを持つtable）から対象行を取得
function accountRow(page: Page, loginId: string) {
  return page
    .locator("table")
    .filter({ has: page.locator("th", { hasText: "ログインID" }) })
    .locator("tbody tr", { hasText: loginId });
}

test.describe("管理画面アクセス制御（§5.2: ①②のみ・④ダミー）", () => {
  test("R1/R2は/adminにアクセスできる（コンソールエラー0）", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R1");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "管理画面（Airisアカウント管理）" })
    ).toBeVisible();

    await login(page, "R2");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "管理画面（Airisアカウント管理）" })
    ).toBeVisible();
    // ナビに管理画面リンクがある
    await expect(page.getByRole("link", { name: "管理画面" })).toBeVisible();

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R3/R8は/adminへ直接アクセスできずダッシュボードへリダイレクト（監査ログ記録）", async ({ page }) => {
    const since = new Date(Date.now() - 60_000);

    await login(page, "R3");
    await expect(page.getByRole("link", { name: "管理画面" })).toHaveCount(0);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/dashboard/);

    await login(page, "R8");
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/dashboard/);

    // 権限外アクセスの試みが監査ログに記録される（§3.3）
    const denied = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R3.loginId,
        action: "access_denied",
        target: { contains: "page=admin" },
        createdAt: { gte: since },
      },
    });
    expect(denied).not.toBeNull();
  });

  test("未ログインで/adminへアクセスするとログイン画面へ", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/login/);
  });

  test("R4はダミー表示モード（実データ非表示・CSV不可・§3.5）", async ({ page }) => {
    await login(page, "R4");
    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: "管理画面（Airisアカウント管理）" })
    ).toBeVisible();
    await expect(page.getByText(/ダミー表示モード/)).toBeVisible();

    // CSV出力ボタンが表示されない
    await expect(page.getByRole("link", { name: "棚卸CSV出力" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "監査ログCSV出力" })).toHaveCount(0);

    // 実データが漏れない: 実アカウントID・実監査ログ（view_admin等）が表示されない
    await expect(page.getByText(ACCOUNTS.R1.loginId)).toHaveCount(0);
    await expect(page.getByText("view_admin")).toHaveCount(0);
    // 架空監査ログが表示される
    await expect(page.getByText("REQ-990013")).toBeVisible();

    // CSVエンドポイントも403
    const res = await page.request.get("/admin/csv?type=inventory");
    expect(res.status()).toBe(403);
  });
});

test.describe("アカウント一覧・検索・フィルタ（§7.2）", () => {
  test("全アカウントの一覧: SNC系（代理店に属さない）アカウントも表示される", async ({ page }) => {
    await login(page, "R2");
    // 仕様 §7.2:「Airisアカウント管理」ページは全アカウントの一覧
    await page.goto("/admin?q=airis_slb_sys_001");
    await expect(accountRow(page, "airis_slb_sys_001")).toHaveCount(1);

    await page.goto("/admin?q=airis_snc_ops_0001");
    await expect(accountRow(page, "airis_snc_ops_0001")).toHaveCount(1);
  });

  test("統計カード4枚の数値がDB件数と一致", async ({ page }) => {
    await login(page, "R2");

    // 実データ全アカウント（R4用ダミー代理店の分は除外）
    const realScope = {
      OR: [{ agencyId: null }, { agency: { isDummy: false } }],
    };
    // 仕様§7.2の4枚: 表示対象 / 承認待ち / 登録済み / 停止・削除
    const [total, pending, active, suspended, deleted] = await Promise.all([
      db().account.count({ where: realScope }),
      db().account.count({ where: { AND: [realScope, { status: "pending" }] } }),
      db().account.count({ where: { AND: [realScope, { status: "active" }] } }),
      db().account.count({ where: { AND: [realScope, { status: "suspended" }] } }),
      db().account.count({ where: { AND: [realScope, { status: "deleted" }] } }),
    ]);

    await page.goto("/admin");
    expect(await statValue(page, "表示対象")).toBe(total);
    expect(await statValue(page, "承認待ち")).toBe(pending);
    expect(await statValue(page, "登録済み")).toBe(active);
    expect(await statValue(page, "停止・削除")).toBe(suspended + deleted);
  });

  test("検索・ロールフィルタ・ステータスフィルタが機能する", async ({ page }) => {
    const a = await createQa2Account(`qa2_filter_a_${RUN}`, { role: "R8", status: "active" });
    const b = await createQa2Account(`qa2_filter_b_${RUN}`, { role: "R9", status: "suspended" });
    expect(a.id).not.toBe(b.id);

    await login(page, "R2");

    // 検索（ID部分一致）
    await page.goto(`/admin?q=qa2_filter`);
    await expect(accountRow(page, `qa2_filter_a_${RUN}`)).toHaveCount(1);
    await expect(accountRow(page, `qa2_filter_b_${RUN}`)).toHaveCount(1);

    // 検索フォームからの絞り込み + ロールフィルタ
    await page.goto("/admin");
    await page.locator('input[name="q"]').fill("qa2_filter");
    await page.locator('select[name="role"]').selectOption("R8");
    await page.getByRole("button", { name: "絞り込み" }).click();
    await page.waitForURL(/\/admin\?.*q=qa2_filter/);
    await expect(accountRow(page, `qa2_filter_a_${RUN}`)).toHaveCount(1);
    await expect(accountRow(page, `qa2_filter_b_${RUN}`)).toHaveCount(0);

    // ステータスフィルタ（停止のみ）
    await page.goto(`/admin?q=qa2_filter&status=suspended`);
    await expect(accountRow(page, `qa2_filter_b_${RUN}`)).toHaveCount(1);
    await expect(accountRow(page, `qa2_filter_a_${RUN}`)).toHaveCount(0);
    await expect(
      accountRow(page, `qa2_filter_b_${RUN}`).getByText("停止", { exact: true })
    ).toBeVisible();

    // 存在しないIDの検索は0件（異常系）
    await page.goto(`/admin?q=qa2_no_such_account_xyz`);
    await expect(
      page.getByText("条件に一致するアカウントがありません。")
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 停止→再開→削除→復旧（QA2専用アカウントで実施・§3.4）
// ---------------------------------------------------------------------------
test.describe.serial("アカウントライフサイクル（停止/再開/削除/復旧）", () => {
  const lcId = `qa2_lifecycle_${RUN}`;

  test.beforeAll(async () => {
    await createQa2Account(lcId, { status: "active" });
  });

  test("停止→DBでsuspended、再開→active", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await login(page, "R2");
    await page.goto(`/admin?q=${lcId}`);
    const row = accountRow(page, lcId);
    await expect(row).toHaveCount(1);

    // 停止
    await row.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByText(`${lcId} を停止しました`)).toBeVisible({ timeout: 10_000 });
    let acc = await db().account.findUnique({ where: { loginId: lcId } });
    expect(acc!.status).toBe("suspended");

    // 停止中の行には「再開」ボタンが出る（状態依存の操作表示 §7.2）
    await page.reload();
    const rowAfter = accountRow(page, lcId);
    await expect(rowAfter.getByText("停止", { exact: true })).toBeVisible();
    await expect(rowAfter.getByRole("button", { name: "再開" })).toBeVisible();
    await expect(rowAfter.getByRole("button", { name: "停止", exact: true })).toHaveCount(0);

    // 再開
    await rowAfter.getByRole("button", { name: "再開" }).click();
    await expect(page.getByText(`${lcId} を再開しました`)).toBeVisible({ timeout: 10_000 });
    acc = await db().account.findUnique({ where: { loginId: lcId } });
    expect(acc!.status).toBe("active");

    // 監査ログ（§3.3）
    const suspendLog = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "account_suspend", target: lcId },
    });
    const resumeLog = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "account_resume", target: lcId },
    });
    expect(suspendLog).not.toBeNull();
    expect(resumeLog).not.toBeNull();
  });

  test("削除→DBでdeleted（論理削除・deletedAt記録）、復旧→deletedAtがクリアされる", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await login(page, "R2");
    await page.goto(`/admin?q=${lcId}`);
    const row = accountRow(page, lcId);
    await expect(row).toHaveCount(1);

    // 削除（論理削除 §3.4: 物理削除しない）
    await row.getByRole("button", { name: "削除", exact: true }).click();
    await expect(page.getByText(new RegExp(`${lcId} を削除しました`))).toBeVisible({ timeout: 10_000 });
    let acc = await db().account.findUnique({ where: { loginId: lcId } });
    expect(acc).not.toBeNull(); // レコードは残る
    expect(acc!.status).toBe("deleted");
    expect(acc!.deletedAt).not.toBeNull();

    // 削除済の行には「復旧」ボタン
    await page.reload();
    const rowAfter = accountRow(page, lcId);
    await expect(rowAfter.getByText("削除済", { exact: true })).toBeVisible();
    const restoreBtn = rowAfter.getByRole("button", { name: "復旧" });
    await expect(restoreBtn).toBeVisible();

    // 復旧
    await restoreBtn.click();
    await expect(page.getByText(new RegExp(`${lcId} を復旧しました`))).toBeVisible({ timeout: 10_000 });
    acc = await db().account.findUnique({ where: { loginId: lcId } });
    expect(acc!.deletedAt).toBeNull();
    expect(acc!.status).toBe("suspended"); // 安全のため停止中として復元（アプリ仕様）

    // 監査ログ
    const deleteLog = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "account_delete", target: lcId },
    });
    const restoreLog = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "account_restore", target: lcId },
    });
    expect(deleteLog).not.toBeNull();
    expect(restoreLog).not.toBeNull();
  });

  test("停止中アカウントではログインできない（異常系）", async ({ page }) => {
    // 復旧後はsuspended → ログイン不可のはず
    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(lcId);
    await page.locator('input[name="password"]').fill(`Qa2-Initial-${RUN}!x`);
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(
      page.getByText("IDまたはパスワードが正しくありません")
    ).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});

// ---------------------------------------------------------------------------
// パスワードリセット→一時PW表示→ログイン→強制変更
// ---------------------------------------------------------------------------
test.describe.serial("パスワードリセット（管理者代行 §4.2）", () => {
  const prId = `qa2_pwreset_${RUN}`;
  let tempPassword = "";

  test.beforeAll(async () => {
    await createQa2Account(prId, { status: "active" });
  });

  test("R2がPWリセット→一時パスワードが一度だけ表示され、DBは初回変更必須になる", async ({ page }) => {
    page.on("dialog", (d) => d.accept());
    await login(page, "R2");
    await page.goto(`/admin?q=${prId}`);
    const row = accountRow(page, prId);
    await expect(row).toHaveCount(1);

    await row.getByRole("button", { name: "PWリセット" }).click();
    await expect(row.getByText(`一時パスワード（${prId}）`)).toBeVisible({ timeout: 10_000 });
    tempPassword = (await row.locator("div.select-all").innerText()).trim();
    expect(tempPassword.length).toBeGreaterThanOrEqual(14);

    const acc = await db().account.findUnique({ where: { loginId: prId } });
    expect(acc!.mustChangePassword).toBe(true);
    // 平文はDBに保存されない
    expect(acc!.passwordHash).not.toBe(tempPassword);

    // 監査ログ: password_reset
    const log = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "password_reset", target: prId },
    });
    expect(log).not.toBeNull();

    // リロード後は一時パスワードは再表示されない（一度だけ表示）
    await page.reload();
    await expect(page.getByText(`一時パスワード（${prId}）`)).toHaveCount(0);
  });

  test("一時PWでログイン→強制パスワード変更画面→変更完了", async ({ page }) => {
    expect(tempPassword).not.toBe("");

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(prId);
    await page.locator('input[name="password"]').fill(tempPassword);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/password/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "パスワードの変更" })
    ).toBeVisible();

    // 変更完了まで他機能へ遷移不可（§10.1）
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/password/);

    const newPw = `QA2-Reset-Done-${RUN}z`;
    await page.locator('input[name="current"]').fill(tempPassword);
    await page.locator('input[name="next"]').fill(newPw);
    await page.locator('input[name="confirm"]').fill(newPw);
    await page.getByRole("button", { name: "変更する" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    const acc = await db().account.findUnique({ where: { loginId: prId } });
    expect(acc!.mustChangePassword).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CSV出力（棚卸・監査ログ §3.6）と監査ログビューア（§3.3）
// ---------------------------------------------------------------------------
test.describe("CSV出力・監査ログ", () => {
  test("棚卸CSV: レスポンスがCSV（BOM付きUTF-8）でヘッダ行が正しく、SNC系アカウントも含む", async ({ page }) => {
    await login(page, "R2");
    await page.goto("/admin");
    await expect(page.getByRole("link", { name: "棚卸CSV出力" })).toBeVisible();

    const res = await page.request.get("/admin/csv?type=inventory");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const body = await res.text();
    // UTF-8 BOM付き（§3.6 Excel互換）
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe(
      "ログインID,ロール,氏名,メール,所属代理店コード,ステータス,作成日,最終PW変更日"
    );
    // 全アカウントが対象（SNC系・代理店系の両方を含む）
    expect(body).toContain("airis_slb_sys_001");
    expect(body).toContain("airis_1110001_001");
    // ダミー代理店のデータは含まない
    expect(body).not.toContain("990001");

    // CSVエクスポート自体が監査ログに記録される（§3.6）
    const log = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R2.loginId,
        action: "csv_export",
        target: "accounts_inventory",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
  });

  test("監査ログCSV: ヘッダ行が正しくエクスポートも監査対象", async ({ page }) => {
    await login(page, "R1");
    const res = await page.request.get("/admin/csv?type=audit");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    const body = await res.text();
    expect(body.charCodeAt(0)).toBe(0xfeff);
    const lines = body.replace(/^﻿/, "").split("\r\n");
    expect(lines[0]).toBe("日時,actor,action,target,result");
    expect(lines.length).toBeGreaterThan(1);

    const log = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R1.loginId, action: "csv_export", target: "audit_logs" },
      orderBy: { createdAt: "desc" },
    });
    expect(log).not.toBeNull();
  });

  test("CSV権限: R3は403、未認証は401（異常系）", async ({ page, browser }) => {
    await login(page, "R3");
    const res = await page.request.get("/admin/csv?type=inventory");
    expect(res.status()).toBe(403);

    // 権限外エクスポートの試みも監査ログに記録
    const denied = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R3.loginId, action: "csv_export", result: "denied" },
      orderBy: { createdAt: "desc" },
    });
    expect(denied).not.toBeNull();

    const anon = await browser.newContext({
      baseURL: process.env.QA_BASE_URL ?? "http://localhost:3100",
    });
    const anonRes = await anon.request.get("/admin/csv?type=audit");
    expect(anonRes.status()).toBe(401);
    await anon.close();
  });

  test("監査ログビューア: view_admin等の閲覧イベントが記録・表示される", async ({ page }) => {
    const since = new Date(Date.now() - 60_000);
    await login(page, "R2");
    await page.goto("/admin");

    // DB: 管理画面の閲覧イベント view_admin が記録されている（§3.3 機微データ閲覧記録）
    const viewLog = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R2.loginId,
        action: "view_admin",
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(viewLog).not.toBeNull();
    expect(viewLog!.target).toContain("role=R2");

    // 画面の監査ログビューア（直近100件）にも表示される
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /監査ログ（直近100件）/ })
    ).toBeVisible();
    await expect(
      page.locator("td", { hasText: "view_admin" }).first()
    ).toBeVisible();
  });

  test("アクセスログCSVダウンロード機能が提供されている（§7.2/§3.3/要件1-6）", async ({ page }) => {
    await login(page, "R2");
    await page.goto("/admin");
    // §7.2: 管理ページは「棚卸CSV、アクセスログCSV」を提供する
    // §3.3: ログイン日時・IPアドレス・User-Agent のCSVダウンロード機能を管理者向けに提供
    await expect(
      page.getByRole("link", { name: /アクセスログ.*CSV|アクセスログCSV/ })
    ).toBeVisible();
  });

  test("存在しないファイルIDは404・未認証は401（異常系）", async ({ page, browser }) => {
    await login(page, "R2");
    const res = await page.request.get("/files/qa2_no_such_file_id");
    expect(res.status()).toBe(404);

    // 未認証は401
    const anon = await browser.newContext({
      baseURL: process.env.QA_BASE_URL ?? "http://localhost:3100",
    });
    const anonRes = await anon.request.get("/files/qa2_no_such_file_id");
    expect(anonRes.status()).toBe(401);
    await anon.close();
  });
});

// ============ アカウント変更（氏名・メール・ロール §5.1「変」/ BUG-014修正の検証） ============
test.describe("アカウント変更（§5.1 変更・権限変更）", () => {
  test("R2がSNC系（代理店非所属）アカウントの氏名・メール・ロールを変更できる", async ({ page }) => {
    const loginId = `qa2_edit_snc_${RUN}`;
    // 代理店非所属のSNC系アカウント（R5）をDB直で作成
    const acc = await db().account.create({
      data: {
        loginId,
        role: "R5",
        name: `QA2編集前 ${RUN}`,
        email: `${loginId}@example.com`,
        status: "active",
        passwordHash: "x",
        mustChangePassword: false,
      },
    });
    try {
      await login(page, "R2");
      await page.goto(`/admin?q=${loginId}`);
      const row = accountRow(page, loginId);
      await expect(row).toHaveCount(1);
      await row.getByRole("button", { name: "編集" }).click();
      await row.locator('input[name="name"]').fill(`QA2編集後 ${RUN}`);
      await row.locator('input[name="email"]').fill(`edited_${loginId}@example.com`);
      await row.locator('select[name="role"]').selectOption("R6");
      await row.getByRole("button", { name: "保存" }).click();
      await expect(row.getByText("を更新しました")).toBeVisible();
      // DB検証
      const after = await db().account.findUnique({ where: { id: acc.id } });
      expect(after?.name).toBe(`QA2編集後 ${RUN}`);
      expect(after?.email).toBe(`edited_${loginId}@example.com`);
      expect(after?.role).toBe("R6");
      // 監査ログ（ロール変更）
      const log = await db().auditLog.findFirst({
        where: { action: "account_role_change", target: { contains: loginId } },
        orderBy: { createdAt: "desc" },
      });
      expect(log).not.toBeNull();
    } finally {
      await db().account.delete({ where: { id: acc.id } }).catch(() => {});
    }
  });

  test("代理店所属アカウントのロールはR7/R8のみ・R9は編集ボタン非表示（異常系）", async ({ page }) => {
    const loginId = `qa2_edit_agency_${RUN}`;
    const { id } = await createQa2Account(loginId, { role: "R8" });
    try {
      await login(page, "R2");
      await page.goto(`/admin?q=${loginId}`);
      const row = accountRow(page, loginId);
      await row.getByRole("button", { name: "編集" }).click();
      // 選択肢はR7/R8のみ（SNC系ロールは選べない）
      const options = await row.locator('select[name="role"] option').allTextContents();
      expect(options).toEqual(["一次代理店管理者", "二次代理店管理者"]);
      // R9（販売員）行には編集ボタンが出ない
      await page.goto(`/admin?q=110001C001`);
      const r9row = accountRow(page, "110001C001");
      await expect(r9row.getByRole("button", { name: "編集" })).toHaveCount(0);
    } finally {
      await db().account.delete({ where: { id } }).catch(() => {});
    }
  });

  test("SNC系（agencyId=null）アカウントの停止・再開ができる（BUG-002アクション側の検証）", async ({ page }) => {
    const loginId = `qa2_snc_ops_${RUN}`;
    const acc = await db().account.create({
      data: {
        loginId, role: "R5", name: "QA2 SNC停止テスト", status: "active",
        passwordHash: "x", mustChangePassword: false,
      },
    });
    try {
      await login(page, "R2");
      await page.goto(`/admin?q=${loginId}`);
      const row = accountRow(page, loginId);
      page.on("dialog", (d) => d.accept());
      await row.getByRole("button", { name: "停止" }).click();
      await expect(row.getByText("停止しました")).toBeVisible();
      const after = await db().account.findUnique({ where: { id: acc.id } });
      expect(after?.status).toBe("suspended");
    } finally {
      await db().account.delete({ where: { id: acc.id } }).catch(() => {});
    }
  });
});
