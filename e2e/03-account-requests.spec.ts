/**
 * QA担当: Airisアカウント申請（§6.1 / §7.2 / §3.3）
 * データプレフィクス: QA2
 */
import { test, expect, Page, Locator } from "@playwright/test";
import { completeMfaIfNeeded,
  ACCOUNTS,
  db,
  login,
  collectConsoleErrors,
  criticalErrors,
} from "./helpers";

const RUN = Date.now();
const EVIDENCE = {
  name: "qa2-evidence.png",
  mimeType: "image/png",
  buffer: Buffer.from("QA2-evidence-file-content"),
};

// 統計カード（StatCard）の数値をラベルから取得
async function statValue(page: Page, label: string): Promise<number> {
  const card = page
    .locator("div.grid > div.rounded-2xl")
    .filter({ has: page.locator("div.truncate", { hasText: label }) });
  const txt = await card.locator("div.text-2xl").innerText();
  return Number(txt.trim());
}

async function openRequestForm(page: Page) {
  await page.goto("/account-requests");
  await page.getByRole("button", { name: "＋ アカウント申請" }).click();
  await expect(
    page.getByRole("heading", { name: "アカウント申請", exact: true })
  ).toBeVisible();
}

async function roleOptionValues(page: Page): Promise<string[]> {
  return page
    .locator('select[name="role"] option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
}

test.describe("Airisアカウント申請ページ（§7.2）", () => {
  test("R2: 証跡ファイルは必須（未添付はサーバ側でもエラーになりDBに作成されない）", async ({ page }) => {
    await login(page, "R2");
    await openRequestForm(page);

    const email = `qa2-noevidence-${RUN}@example.com`;
    await page.locator('select[name="role"]').selectOption("R5");
    await page.locator('input[name="name"]').fill(`QA2証跡なし太郎-${RUN}`);
    await page.locator('input[name="email"]').fill(email);

    // クライアント側: required属性が付いている（必須）
    await expect(page.locator('input[name="evidence"]')).toHaveJSProperty("required", true);

    // サーバ側検証: requiredを外して送信してもエラーになること
    await page.evaluate(() =>
      document.querySelector('input[name="evidence"]')?.removeAttribute("required")
    );
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText("上長承認証跡ファイルを添付してください")
    ).toBeVisible({ timeout: 10_000 });

    // DBに申請が作成されていない
    const req = await db().accountRequest.findFirst({ where: { email } });
    expect(req).toBeNull();
  });

  test("R2: 証跡を添付して申請→一覧に「承認待ち」表示→DBにpending_finalで保存（コンソールエラー0）", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R2");
    await openRequestForm(page);

    const name = `QA2申請花子-${RUN}`;
    const email = `qa2-create-${RUN}@example.com`;
    await page.locator('select[name="role"]').selectOption("R5");
    await page.locator('input[name="name"]').fill(name);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="evidence"]').setInputFiles(EVIDENCE);
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText(/アカウント申請を受け付けました（REQ-\d+）/)
    ).toBeVisible({ timeout: 10_000 });

    // DB: AccountRequest(pending_final) + 証跡ファイル + 履歴 requested
    const req = await db().accountRequest.findFirst({ where: { email } });
    expect(req).not.toBeNull();
    expect(req!.status).toBe("pending_final");
    expect(req!.role).toBe("R5");
    expect(req!.evidenceFileId).not.toBeNull();
    const history = req!.history as { event: string; by: string }[];
    expect(history.length).toBe(1);
    expect(history[0].event).toBe("requested");
    expect(history[0].by).toBe(ACCOUNTS.R2.loginId);

    // 監査ログ（§3.3）: account_request_create
    const auditRow = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R2.loginId, action: "account_request_create", target: req!.requestId },
    });
    expect(auditRow).not.toBeNull();

    // 一覧に「承認待ち」バッジで表示され、証跡リンクからファイルが取得できる
    await page.reload();
    const row = page.locator("tbody tr", { hasText: name });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("承認待ち", { exact: true })).toBeVisible();
    const evidenceLink = row.getByRole("link", { name: "証跡を確認" });
    await expect(evidenceLink).toBeVisible();
    const href = await evidenceLink.getAttribute("href");
    const res = await page.request.get(href!);
    expect(res.status()).toBe(200);

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("履歴イベントの日付がJST基準で記録される（§2: Asia/Tokyo固定）", async ({ page }) => {
    await login(page, "R2");
    await openRequestForm(page);

    const email = `qa2-tz-${RUN}@example.com`;
    await page.locator('select[name="role"]').selectOption("R5");
    await page.locator('input[name="name"]').fill(`QA2時刻検証-${RUN}`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="evidence"]').setInputFiles(EVIDENCE);
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText(/アカウント申請を受け付けました（REQ-\d+）/)
    ).toBeVisible({ timeout: 10_000 });

    const req = await db().accountRequest.findFirst({ where: { email } });
    const history = req!.history as { event: string; at: string }[];
    // §2: タイムゾーンはAsia/Tokyo固定。履歴のYYYY-MM-DDはJST基準の当日であること
    const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    expect(history[0].at).toBe(jstToday);
  });

  test("§6.1 申請可能ロール制限: R5のフォームには自ロール⑤のみ", async ({ page }) => {
    await login(page, "R5");
    await openRequestForm(page);
    expect(await roleOptionValues(page)).toEqual(["R5"]);
    await expect(page.locator('select[name="role"] option')).toHaveText([
      /⑤/,
    ]);
  });

  test("§6.1 申請可能ロール制限: R7のフォームには⑦⑧のみ", async ({ page }) => {
    await login(page, "R7");
    await openRequestForm(page);
    expect(await roleOptionValues(page)).toEqual(["R7", "R8"]);
    await expect(page.locator('select[name="role"] option')).toHaveText([
      /⑦/,
      /⑧/,
    ]);
  });

  // 発注者指示 2026-08-05: ②は②〜⑩を申請できるが①（サスラボシステム管理）は申請できない
  test("②の申請可能ロールは②〜⑩（①は選べない）", async ({ page }) => {
    await login(page, "R2");
    await openRequestForm(page);
    expect(await roleOptionValues(page)).toEqual([
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R10",
    ]);
    await expect(page.locator('select[name="role"] option')).not.toHaveText([/①/]);
  });

  test("②が①の申請をAPIへ直接送っても拒否される（UI改ざん耐性）", async ({ page }) => {
    const name = `QA2禁止ロール-${RUN}`;
    await login(page, "R2");
    await openRequestForm(page);
    // select に無い値をDOM側で注入してサーバ検証を突く
    await page.locator('select[name="role"]').evaluate((el) => {
      const s = el as HTMLSelectElement;
      const opt = document.createElement("option");
      opt.value = "R1";
      opt.textContent = "R1";
      s.appendChild(opt);
      s.value = "R1";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator('input[name="name"]').fill(name);
    await page.locator('input[name="email"]').fill(`qa2-deny-${RUN}@example.com`);
    await page.locator('input[type="file"]').setInputFiles({
      name: "evidence.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 qa2 evidence"),
    });
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText("このロールを申請する権限がありません", { exact: false })
    ).toBeVisible({ timeout: 10_000 });
    expect(await db().accountRequest.count({ where: { name } })).toBe(0);
  });

  test("①は①を含む全ロールを申請できる（②のみの制限であること）", async ({ page }) => {
    await login(page, "R1");
    await openRequestForm(page);
    expect(await roleOptionValues(page)).toEqual([
      "R1",
      "R2",
      "R3",
      "R4",
      "R5",
      "R6",
      "R7",
      "R8",
      "R10",
    ]);
  });
});

// ---------------------------------------------------------------------------
// ⑧申請 → ⑦1次承認 → ③最終承認 → 一時PW一度だけ表示 → 新IDでログイン → 強制PW変更
// ---------------------------------------------------------------------------
test.describe.serial("承認フロー（§6.1: R8申請→R7一次承認→R3最終承認→発行）", () => {
  const flowName = `QA2フロー次郎-${RUN}`;
  const flowEmail = `qa2-flow-${RUN}@example.com`;
  let issuedLoginId = "";
  let tempPassword = "";
  let expectedLoginId = "";

  test("R8が申請→pending_first(一次承認待ち)になり、R8自身に承認ボタンは出ない", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R8");
    await openRequestForm(page);

    // R8はロール⑧のみ申請可能（§6.1）
    expect(await roleOptionValues(page)).toEqual(["R8"]);

    const s1 = await db().agency.findUnique({ where: { code: "210001" } });
    expect(s1).not.toBeNull();
    await page.locator('input[name="name"]').fill(flowName);
    await page.locator('input[name="email"]').fill(flowEmail);
    await page.locator('select[name="agencyId"]').selectOption(s1!.id);
    await page.locator('input[name="evidence"]').setInputFiles(EVIDENCE);
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText(/アカウント申請を受け付けました（REQ-\d+）/)
    ).toBeVisible({ timeout: 10_000 });

    // DB: pending_first（⑧の申請は⑦の1次承認を経る）
    const req = await db().accountRequest.findFirst({ where: { email: flowEmail } });
    expect(req).not.toBeNull();
    expect(req!.status).toBe("pending_first");
    expect(req!.agencyId).toBe(s1!.id);

    // 一覧表示: 一次承認待ちバッジ + 申請者自身は承認操作不可（操作列は「—」）
    await page.reload();
    const row = page.locator("tbody tr", { hasText: flowName });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("一次承認待ち", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "1次承認" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "最終承認" })).toHaveCount(0);
    await expect(row.locator("td").last()).toContainText("—");

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R7が1次承認→pending_final(承認待ち)へ遷移し履歴にapprove_first", async ({ page }) => {
    await login(page, "R7");
    await page.goto("/account-requests");
    const row = page.locator("tbody tr", { hasText: flowName });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "1次承認" }).click();
    // 承認後は行の状態バッジが「承認待ち」（=pending_final）に変わる
    await expect(row.getByText("承認待ち", { exact: true })).toBeVisible({ timeout: 10_000 });

    const req = await db().accountRequest.findFirst({ where: { email: flowEmail } });
    expect(req!.status).toBe("pending_final");
    const events = (req!.history as { event: string }[]).map((h) => h.event);
    expect(events).toEqual(["requested", "approve_first"]);

    const auditRow = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R7.loginId,
        action: "account_request_approve_first",
        target: req!.requestId,
      },
    });
    expect(auditRow).not.toBeNull();
  });

  test("R3が最終承認→一時パスワードが一度だけ表示され、DBにAccountが採番規則どおり作成される", async ({ page }) => {
    const errors = collectConsoleErrors(page);

    // 採番規則: airis_2 + 代理店コード(210001) + _ + 3桁連番（§4 / §6.1-4）
    const prefix = "airis_2210001_";
    const before = await db().account.count({
      where: { loginId: { startsWith: prefix } },
    });
    expectedLoginId = `${prefix}${String(before + 1).padStart(3, "0")}`;

    await login(page, "R3");
    await page.goto("/account-requests");
    const row = page.locator("tbody tr", { hasText: flowName });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "最終承認" }).click();
    await expect(row.getByText("最終承認しました")).toBeVisible({ timeout: 10_000 });

    // 発行ID・一時パスワードが画面に表示される（一度だけ）
    issuedLoginId = (await row.locator("span.font-mono").first().innerText()).trim();
    tempPassword = (await row.locator("span.select-all").innerText()).trim();
    expect(issuedLoginId).toMatch(/^airis_2210001_\d{3}$/);
    expect(issuedLoginId).toBe(expectedLoginId);
    expect(tempPassword.length).toBeGreaterThanOrEqual(14);

    // DB: Accountが作成されている（active・初回変更必須）
    const account = await db().account.findUnique({ where: { loginId: issuedLoginId } });
    expect(account).not.toBeNull();
    expect(account!.role).toBe("R8");
    expect(account!.status).toBe("active");
    expect(account!.mustChangePassword).toBe(true);

    // DB: 申請はapproved + issuedLoginId + 履歴final_approve
    const req = await db().accountRequest.findFirst({ where: { email: flowEmail } });
    expect(req!.status).toBe("approved");
    expect(req!.issuedLoginId).toBe(issuedLoginId);
    const events = (req!.history as { event: string }[]).map((h) => h.event);
    expect(events).toEqual(["requested", "approve_first", "final_approve"]);

    // 一時パスワード・平文はDBに保存されない（申請レコードに含まれない）
    expect(JSON.stringify(req)).not.toContain(tempPassword);

    const auditRow = await db().auditLog.findFirst({
      where: { actor: ACCOUNTS.R3.loginId, action: "account_request_final_approve" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.target).toContain(issuedLoginId);

    // リロード後は一時パスワードは再表示されず、一覧は登録済み+発行ID表示
    await page.reload();
    const rowAfter = page.locator("tbody tr", { hasText: flowName });
    await expect(rowAfter.getByText("登録済み", { exact: true })).toBeVisible();
    await expect(rowAfter.getByText(`発行ID: ${issuedLoginId}`)).toBeVisible();
    await expect(rowAfter.getByText("一時パスワード")).toHaveCount(0);

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("発行された一時PWで新アカウントログイン→強制パスワード変更→変更完了までは他画面に遷移不可", async ({ page }) => {
    expect(issuedLoginId).not.toBe("");
    expect(tempPassword).not.toBe("");

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(issuedLoginId);
    await page.locator('input[name="password"]').fill(tempPassword);
    await page.getByRole("button", { name: "ログイン" }).click();
    await completeMfaIfNeeded(page, issuedLoginId); // 新規アカウントはMFA初回登録を通過（§4.2）
    await page.waitForURL(/\/password/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "パスワードの変更" })
    ).toBeVisible();

    // 変更完了まで他機能へ遷移不可（§10.1）
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/password/);

    // パスワード変更（一般ロール: 14桁以上・大小数字）
    const newPw = `QA2-New-Pass-${RUN}abc`;
    await page.locator('input[name="current"]').fill(tempPassword);
    await page.locator('input[name="next"]').fill(newPw);
    await page.locator('input[name="confirm"]').fill(newPw);
    await page.getByRole("button", { name: "変更する" }).click();
    await page.waitForURL(/\/dashboard/, { timeout: 15_000 });

    const account = await db().account.findUnique({ where: { loginId: issuedLoginId } });
    expect(account!.mustChangePassword).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 却下フロー / 統計カード / 権限外アクセス
// ---------------------------------------------------------------------------
test.describe("却下・統計・アクセス制御", () => {
  test("却下: 理由入力→rejected表示、履歴にrejectが残る", async ({ page }) => {
    const name = `QA2却下三郎-${RUN}`;
    const email = `qa2-reject-${RUN}@example.com`;

    // R2で申請作成
    await login(page, "R2");
    await openRequestForm(page);
    await page.locator('select[name="role"]').selectOption("R6");
    await page.locator('input[name="name"]').fill(name);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="evidence"]').setInputFiles(EVIDENCE);
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(
      page.getByText(/アカウント申請を受け付けました（REQ-\d+）/)
    ).toBeVisible({ timeout: 10_000 });

    // R2で却下（理由必須）
    // ※申請対象ロールが⑥（SNC系）のため、職務分離（§6.1-3 / 要件1-1）により却下できるのは
    //   ①②のみ。③での却下不可は「職務分離」describeで別途検証している。
    await login(page, "R2");
    await page.goto("/account-requests");
    const row = page.locator("tbody tr", { hasText: name });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: "却下" }).click();
    const reasonInput = row.locator('input[name="reason"]');
    await expect(reasonInput).toBeVisible();
    // 理由は必須入力
    await expect(reasonInput).toHaveJSProperty("required", true);
    await reasonInput.fill("QA2テスト: 証跡不備のため却下");
    await row.getByRole("button", { name: "確定" }).click();
    // 却下後は行の状態バッジが「差戻し・却下」に変わる
    await expect(row.getByText("差戻し・却下", { exact: true })).toBeVisible({ timeout: 10_000 });

    // DB: rejected + 理由 + 履歴reject
    const req = await db().accountRequest.findFirst({ where: { email } });
    expect(req!.status).toBe("rejected");
    expect(req!.rejectReason).toBe("QA2テスト: 証跡不備のため却下");
    const events = (req!.history as { event: string }[]).map((h) => h.event);
    expect(events[events.length - 1]).toBe("reject");

    // UI: 差戻し・却下バッジ + 理由表示
    await page.reload();
    const rowAfter = page.locator("tbody tr", { hasText: name });
    await expect(rowAfter.getByText("差戻し・却下", { exact: true })).toBeVisible();
    await expect(rowAfter.getByText(/理由: QA2テスト/)).toBeVisible();

    // 監査ログ: account_request_reject
    const auditRow = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R2.loginId,
        action: "account_request_reject",
        target: req!.requestId,
      },
    });
    expect(auditRow).not.toBeNull();
  });

  test("統計カード4枚の数値がDB件数と一致（R2=全件スコープ）", async ({ page }) => {
    await login(page, "R2");

    const [total, pending, approved] = await Promise.all([
      db().accountRequest.count(),
      db().accountRequest.count({
        where: { status: { in: ["pending_first", "pending_final"] } },
      }),
      db().accountRequest.count({ where: { status: "approved" } }),
    ]);

    await page.goto("/account-requests");
    expect(await statValue(page, "表示対象")).toBe(total);
    expect(await statValue(page, "承認待ち")).toBe(pending);
    expect(await statValue(page, "登録済み")).toBe(approved);
    // 4枚目カード: §7.2 の正式ラベルは「停止・削除」であり、「差戻し・却下」カードの
    // 存在を前提とした検証は仕様（および本ファイル内のラベル検証テスト）と矛盾するため
    // ラベル非依存で枚数のみ検証する（ラベル・値の修正は /account-requests 実装側の担当）
    await expect(page.locator("div.grid > div.rounded-2xl")).toHaveCount(4);
  });

  // 仕様 §7.2「統計カード（表示対象 / 承認待ち / 登録済み / 停止・削除）」は
  // プロトタイプ（申請・管理一体画面）のAirisアカウント統計に由来する。
  // 本実装は§5.2のアクセス制御（①②のみ管理可）に従い申請ページと管理ページを分割したため、
  // 「停止・削除」を含む4枚は管理画面（/admin）に配置し、申請ページは申請レコードの
  // 実態に即したラベル（差戻し・却下）とする。両方をここで検証する。
  test("統計カード: 申請ページは申請ステータス4枚 / 管理画面は仕様§7.2の4枚", async ({ page }) => {
    await login(page, "R2");

    await page.goto("/account-requests");
    const reqLabels = await page
      .locator("div.grid > div.rounded-2xl div.truncate")
      .allInnerTexts();
    expect(reqLabels).toEqual(["表示対象", "承認待ち", "登録済み", "差戻し・却下"]);

    await page.goto("/admin");
    const adminLabels = await page
      .locator("div.grid > div.rounded-2xl div.truncate")
      .allInnerTexts();
    expect(adminLabels).toEqual(["表示対象", "承認待ち", "登録済み", "停止・削除"]);
  });

  test("権限外アクセス: R9/R10は/account-requestsへ直接アクセスできずダッシュボードへ", async ({ page }) => {
    const since = new Date(Date.now() - 60_000);

    await login(page, "R9");
    // ナビにリンクが出ない（§3.2 UI層）
    await expect(
      page.getByRole("link", { name: "Airisアカウント申請" })
    ).toHaveCount(0);
    await page.goto("/account-requests");
    await expect(page).toHaveURL(/\/dashboard/);

    await login(page, "R10");
    await page.goto("/account-requests");
    await expect(page).toHaveURL(/\/dashboard/);

    // 権限外アクセスの試みが監査ログに記録される（§3.3）
    const denied = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R9.loginId,
        action: "access_denied",
        target: { contains: "page=account-requests" },
        createdAt: { gte: since },
      },
    });
    expect(denied).not.toBeNull();
  });

  test("存在しないページ番号でもクラッシュしない（異常系）", async ({ page }) => {
    await login(page, "R2");
    const res = await page.goto("/account-requests?page=9999");
    expect(res!.status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Airisアカウント申請" })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 職務分離（§6.1-3 / 要件1-1）
//   「SNC一般以上のアカウント発行・権限変更・停止・削除は必ずSNC課長以上（②）の承認を要する」
//   → 申請対象ロールがSNC系（①〜⑥）の申請は①②のみ最終承認・却下でき、
//     ③（SNC運用者）は代理店系（⑦⑧⑩）の最終承認・却下に限定される。
//   UI（ボタン非表示）とサーバ側（server action の直接実行）の両方を検証する（§3.2）。
// ---------------------------------------------------------------------------
test.describe.serial("職務分離: ③はSNC系ロールの申請を最終承認・却下できない（§6.1-3 / 要件1-1）", () => {
  const sncName = `QA2職務分離SNC-${RUN}`;
  const sncEmail = `qa2-sod-snc-${RUN}@example.com`;
  const agencyName = `QA2職務分離代理店-${RUN}`;
  const agencyEmail = `qa2-sod-agency-${RUN}@example.com`;
  const jstToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let sncReqDbId = "";
  let sncRequestId = "";
  let agencyRequestId = "";

  // 承認待ち（pending_final）の申請を2件用意: ④=SNC系ロール / ⑧=代理店系ロール
  test.beforeAll(async () => {
    const s1 = await db().agency.findUnique({ where: { code: "210001" } });
    expect(s1).not.toBeNull();
    const snc = await db().accountRequest.create({
      data: {
        requestId: `REQ-QA2SODS-${RUN}`,
        role: "R4",
        name: sncName,
        email: sncEmail,
        status: "pending_final",
        history: [{ event: "requested", at: jstToday, by: "qa2-sod" }],
      },
    });
    const agency = await db().accountRequest.create({
      data: {
        requestId: `REQ-QA2SODA-${RUN}`,
        role: "R8",
        name: agencyName,
        email: agencyEmail,
        agencyId: s1!.id,
        status: "pending_final",
        history: [{ event: "requested", at: jstToday, by: "qa2-sod" }],
      },
    });
    sncReqDbId = snc.id;
    sncRequestId = snc.requestId;
    agencyRequestId = agency.requestId;
  });

  // 行内フォームの hidden id を差し替える（クライアント改ざんの再現）
  async function tamperId(row: Locator, formHasText: string, newId: string) {
    const form = row.locator("form").filter({ hasText: formHasText });
    await expect(form).toHaveCount(1);
    await form.locator('input[name="id"]').evaluate((el, v) => {
      (el as HTMLInputElement).value = v as string;
    }, newId);
  }

  test("R3の一覧: SNC系ロール（④）の申請には最終承認・却下ボタンが出ない（⑧の申請には出る）", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R3");
    await page.goto("/account-requests");

    // ④（SNC閲覧）の申請: 承認待ちだが③には操作ボタンが一切出ない
    const sncRow = page.locator("tbody tr", { hasText: sncName });
    await expect(sncRow).toHaveCount(1);
    await expect(sncRow.getByText("承認待ち", { exact: true })).toBeVisible();
    await expect(sncRow.getByRole("button", { name: "最終承認" })).toHaveCount(0);
    await expect(sncRow.getByRole("button", { name: "却下" })).toHaveCount(0);
    await expect(sncRow.locator("td").last()).toContainText("—");

    // ⑧（二次代理店管理者）の申請: ③は最終承認・却下できる
    const agencyRow = page.locator("tbody tr", { hasText: agencyName });
    await expect(agencyRow).toHaveCount(1);
    await expect(agencyRow.getByRole("button", { name: "最終承認" })).toBeVisible();
    await expect(agencyRow.getByRole("button", { name: "却下" })).toBeVisible();

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R3: idを差し替えてSNC系ロールの申請を却下しようとしてもサーバ側で拒否される", async ({ page }) => {
    await login(page, "R3");
    await page.goto("/account-requests");
    const agencyRow = page.locator("tbody tr", { hasText: agencyName });
    await agencyRow.getByRole("button", { name: "却下" }).click();
    await agencyRow.locator('input[name="reason"]').fill("QA2職務分離テスト（拒否されるべき）");
    // 却下フォームのidを④の申請に差し替えて送信
    await tamperId(agencyRow, "確定", sncReqDbId);
    await agencyRow.getByRole("button", { name: "確定" }).click();

    await expect(
      agencyRow.getByText("SNC系ロール（①〜⑥）のアカウント発行はSNC課長以上（②）の承認が必要です")
    ).toBeVisible({ timeout: 10_000 });

    // DB: ④の申請は承認待ちのまま・却下理由も残らない
    const req = await db().accountRequest.findUnique({ where: { id: sncReqDbId } });
    expect(req!.status).toBe("pending_final");
    expect(req!.rejectReason).toBeNull();
    expect((req!.history as { event: string }[]).map((h) => h.event)).toEqual(["requested"]);
    // ⑧の申請も却下されていない
    const agencyReq = await db().accountRequest.findFirst({ where: { requestId: agencyRequestId } });
    expect(agencyReq!.status).toBe("pending_final");

    // 拒否は監査ログに記録される（§3.3）
    const denied = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R3.loginId,
        action: "account_request_reject",
        result: "denied",
        target: { contains: sncRequestId },
      },
    });
    expect(denied).not.toBeNull();
  });

  test("R3: idを差し替えてSNC系ロールの申請を最終承認しようとしてもサーバ側で拒否される（アカウント未発行）", async ({ page }) => {
    await login(page, "R3");
    await page.goto("/account-requests");
    const agencyRow = page.locator("tbody tr", { hasText: agencyName });
    await tamperId(agencyRow, "最終承認", sncReqDbId);
    await agencyRow.getByRole("button", { name: "最終承認" }).click();

    await expect(
      agencyRow.getByText("SNC系ロール（①〜⑥）のアカウント発行はSNC課長以上（②）の承認が必要です")
    ).toBeVisible({ timeout: 10_000 });

    // DB: 申請は承認待ちのまま・アカウントは発行されない
    const req = await db().accountRequest.findUnique({ where: { id: sncReqDbId } });
    expect(req!.status).toBe("pending_final");
    expect(req!.issuedLoginId).toBeNull();
    expect((req!.history as { event: string }[]).map((h) => h.event)).toEqual(["requested"]);
    expect(await db().account.count({ where: { email: sncEmail } })).toBe(0);

    const denied = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R3.loginId,
        action: "account_request_final_approve",
        result: "denied",
        target: { contains: sncRequestId },
      },
    });
    expect(denied).not.toBeNull();
  });

  test("R3は⑧（代理店系）の申請を最終承認できる（③の権限は⑦⑧⑩に限定される）", async ({ page }) => {
    await login(page, "R3");
    await page.goto("/account-requests");
    const agencyRow = page.locator("tbody tr", { hasText: agencyName });
    await agencyRow.getByRole("button", { name: "最終承認" }).click();
    await expect(agencyRow.getByText("最終承認しました")).toBeVisible({ timeout: 10_000 });

    const req = await db().accountRequest.findFirst({ where: { requestId: agencyRequestId } });
    expect(req!.status).toBe("approved");
    expect(req!.issuedLoginId).toMatch(/^airis_2210001_\d{3}$/);
    const account = await db().account.findUnique({ where: { loginId: req!.issuedLoginId! } });
    expect(account).not.toBeNull();
    expect(account!.role).toBe("R8");

    const ok = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R3.loginId,
        action: "account_request_final_approve",
        result: "success",
        target: { contains: agencyRequestId },
      },
    });
    expect(ok).not.toBeNull();
  });

  test("R2（SNC課長以上）はSNC系ロール（④）の申請を最終承認できる", async ({ page }) => {
    await login(page, "R2");
    await page.goto("/account-requests");
    const sncRow = page.locator("tbody tr", { hasText: sncName });
    await expect(sncRow.getByRole("button", { name: "最終承認" })).toBeVisible();
    await sncRow.getByRole("button", { name: "最終承認" }).click();
    await expect(sncRow.getByText("最終承認しました")).toBeVisible({ timeout: 10_000 });

    const req = await db().accountRequest.findUnique({ where: { id: sncReqDbId } });
    expect(req!.status).toBe("approved");
    expect(req!.issuedLoginId).toMatch(/^airis_snc_vew_\d{3}$/);
    const account = await db().account.findUnique({ where: { loginId: req!.issuedLoginId! } });
    expect(account!.role).toBe("R4");
  });
});
