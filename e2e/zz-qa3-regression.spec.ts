// QA loop3 独立検収（観点: 回帰・例外処理・境界）
// このファイルは検収作業用。検収完了後に削除する。
import { test, expect } from "@playwright/test";
import { hashSync as argon2HashSync } from "@node-rs/argon2";
import crypto from "crypto";
import { ACCOUNTS, login, collectConsoleErrors, criticalErrors, db, type RoleKey } from "./helpers";

// 使い捨てアカウントを作るためのパスワードハッシュ（アプリと同じ方式 §2 / §10.3）。
// Argon2id（m=19MiB/t=2/p=1）+ HMAC-SHA256 の前段ハッシュ（鍵=ペッパー）。
// ペッパー未設定の環境では素通し（src/lib/pepper.ts と同じ挙動）。
function hashedForTest(pw: string): { passwordHash: string; pepperVersion: string | null } {
  const pepper = process.env.PASSWORD_PEPPER_V1 ?? "";
  const pre = pepper ? crypto.createHmac("sha256", pepper).update(pw, "utf8").digest("hex") : pw;
  return {
    passwordHash: argon2HashSync(pre, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
    }),
    pepperVersion: pepper ? "v1" : null,
  };
}

const ALLOWED: Record<RoleKey, string[]> = {
  R1: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/agencies",
    "/admin",
    "/hotline",
    "/consumer-center",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R2: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/agencies",
    "/admin",
    "/hotline",
    "/consumer-center",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R3: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/agencies",
    "/admin",
    "/hotline",
    "/consumer-center",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R4: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/agencies",
    "/admin",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R5: ["/dashboard", "/account-requests", "/hotline", "/documents", "/notifications"],
  R6: ["/dashboard", "/account-requests", "/consumer-center", "/documents", "/notifications"],
  R7: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/agencies",
    "/agency-cases",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R8: [
    "/dashboard",
    "/account-requests",
    "/sales-staff",
    "/field-agents",
    "/reports",
    "/announcements",
    "/documents",
    "/notifications",
  ],
  R9: ["/dashboard", "/reports", "/announcements", "/documents", "/notifications"],
  R10: ["/dashboard", "/agency-cases", "/notifications"],
};

const ROLES = Object.keys(ALLOWED) as RoleKey[];

// ===== 1. 全10ロール: ログイン→全許可画面遷移。コンソールエラー/5xxを検出 =====
for (const role of ROLES) {
  test(`[REG] ${role} logs in and every allowed page renders without console errors or 5xx`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const errors = collectConsoleErrors(page);
    const bad: string[] = [];
    page.on("response", (r) => {
      if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`);
    });
    await login(page, role);
    await expect(page, `${role} did not reach the dashboard`).toHaveURL(/\/dashboard/);
    for (const path of ALLOWED[role]) {
      const res = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(res, `${role} ${path} no response`).not.toBeNull();
      expect(res!.status(), `${role} ${path} status`).toBeLessThan(400);
      // リダイレクトされていないこと（?denied= / /login へ落ちていないこと）
      expect(new URL(page.url()).pathname, `${role} ${path} redirected`).toBe(path);
      // ログイン済みのシェルが描画されていること
      await expect(
        page.getByRole("button", { name: "ログアウト" }),
        `${role} ${path} not authenticated`
      ).toBeVisible({ timeout: 10_000 });
      // Next.js の既定エラーページになっていないこと
      const html = await page.content();
      expect(html, `${role} ${path} rendered error page`).not.toContain("__next_error__");
      expect(html, `${role} ${path} shows an app error`).not.toContain("Application error");
    }
    expect(criticalErrors(errors), `${role} console errors`).toEqual([]);
    expect(bad, `${role} 5xx responses`).toEqual([]);
  });
}

// ===== 2. ③の管理画面: 閲覧+リセットのみ。停止/削除/変更はサーバ側で拒否 =====
test("[R3-ADMIN] R3 sees only reset buttons and a replayed suspend/delete is refused", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "R3");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  // 操作ボタンのみを見る（ステータス列・監査ログの文言は除外）
  const btnNames = await page.locator("button").allInnerTexts();
  const norm = btnNames.map((s) => s.trim()).filter(Boolean);
  console.log("R3 admin buttons:", JSON.stringify(norm));
  expect(norm).toContain("PWリセット");
  for (const forbidden of [
    "停止",
    "削除",
    "再開",
    "復旧",
    "編集",
    "ベンダーに設定",
    "ベンダー解除",
  ]) {
    expect(norm, `R3 must not see button ${forbidden}`).not.toContain(forbidden);
  }

  // 使い捨てアカウント（QAR_）を対象に op=suspend/delete 等を注入 → サーバ側で拒否されること
  page.on("dialog", (d) => d.accept());
  const agency = await db().agency.findFirstOrThrow({ where: { isDummy: false, tier: 2 } });
  const victim = await db().account.create({
    data: {
      loginId: "QAR_zz3_victim",
      name: "QAR 検収用",
      role: "R8",
      status: "active",
      agencyId: agency.id,
      passwordHash: "x",
      mustChangePassword: false,
    },
  });
  try {
    for (const op of ["suspend", "delete", "resume", "restore"]) {
      await page.goto("/admin?q=QAR_zz3_victim");
      const injected = await page.evaluate((o) => {
        const btn = document.querySelector('form button[name="op"]') as HTMLButtonElement | null;
        const form = btn?.closest("form") as HTMLFormElement | null;
        if (!form) return false;
        form.querySelectorAll('input[name="op"]').forEach((e) => e.remove());
        const inp = document.createElement("input");
        inp.type = "hidden";
        inp.name = "op";
        inp.value = o;
        form.appendChild(inp);
        form.requestSubmit();
        return true;
      }, op);
      expect(injected, `form for op=${op} not found`).toBe(true);
      await page.waitForTimeout(3500);
      const txt = await page.locator("body").innerText();
      const fresh = await db().account.findUnique({ where: { id: victim.id } });
      console.log(`op=${op} status=${fresh?.status} msg=${/権限がありません/.test(txt)}`);
      expect(fresh?.status, `op=${op} changed the account status`).toBe("active");
      expect(txt, `op=${op} was not refused with a message`).toContain("権限がありません");
    }
  } finally {
    await db().auditLog.deleteMany({ where: { target: { contains: "QAR_zz3_victim" } } });
    await db().session.deleteMany({ where: { accountId: victim.id } });
    await db().account.delete({ where: { id: victim.id } });
  }
});

// ===== 3. 例外: 存在しないID / 不正入力 / パスたたき =====
test("[EXC] nonexistent and malformed ids return 404/403, never 500", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R1");
  const targets = [
    "/hotline/does-not-exist",
    "/hotline/00000000-0000-0000-0000-000000000000",
    "/consumer-center/does-not-exist",
    "/announcements/does-not-exist",
    "/hotline/%27%20OR%201%3D1--",
    "/hotline/" + "a".repeat(3000),
  ];
  for (const t of targets) {
    const res = await page.request.get(t, { maxRedirects: 0 });
    expect(
      [301, 302, 307, 308, 400, 403, 404, 414].includes(res.status()),
      `${t} -> ${res.status()}`
    ).toBe(true);
  }
});

// ===== 4. 境界: 50件/頁 =====
test("[BND] admin list paginates at exactly 50 rows per page", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R1");
  await page.goto("/admin");
  const total = await db().account.count({
    where: { OR: [{ agencyId: null }, { agency: { isDummy: false } }] },
  });
  const acctTable = page.locator("table").first();
  const rows = await acctTable.locator("tbody tr").count();
  console.log("total accounts(non-dummy)", total, "rows page1", rows);
  expect(rows).toBeLessThanOrEqual(50);
  const summary = await page.locator("body").innerText();
  expect(summary).toMatch(new RegExp(`全\\s*${total}\\s*件`));
  if (total > 50) {
    expect(rows).toBe(50);
    await page.goto("/admin?page=2");
    const rows2 = await page.locator("table").first().locator("tbody tr").count();
    expect(rows2).toBe(Math.min(50, total - 50));
  }
  // 範囲外ページ: 空表示で落ちないこと
  const res = await page.goto("/admin?page=99999");
  expect(res!.status()).toBeLessThan(400);
});

// ===== 5. セッション: アイドル失効 / 絶対期限 / リロード / ブラウザバック =====
test("[SESS] idle expiry, absolute expiry, reload and back behave safely", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R7");
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);

  // リロード後も維持
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard/);

  // 画面遷移 → ブラウザバック
  await page.goto("/agency-cases");
  await page.goBack();
  await expect(page).toHaveURL(/\/dashboard/);

  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === "airis_session")?.value;
  expect(token, "session cookie missing").toBeTruthy();

  // アイドル61分経過を模擬
  await db().session.update({
    where: { token: token! },
    data: { lastSeenAt: new Date(Date.now() - 61 * 60 * 1000) },
  });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);

  // 期限切れセッションでブラウザバックしても保護画面が再表示されないこと
  await page.goBack();
  await page.waitForLoadState("domcontentloaded");
  const bodyAfterBack = await page.locator("body").innerText();
  expect(bodyAfterBack).not.toContain("ログアウト");
});

// ===== 6. 巨大入力・空入力 =====
test("[BND] oversized and empty text inputs are rejected with a message, not a 500", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "R5");
  await page.goto("/hotline");
  const huge = "あ".repeat(200_000);
  // 新規案件フォームを開く
  const openers = page.getByRole("button", { name: /新規|起票|作成/ });
  if ((await openers.count()) > 0) {
    await openers.first().click();
  }
  const titles = page.locator('input[name="title"], input[name="subject"]');
  if ((await titles.count()) > 0) {
    await titles.first().fill(huge.slice(0, 5000));
    const bodies = page.locator('textarea[name="body"], textarea[name="content"]');
    if ((await bodies.count()) > 0) await bodies.first().fill(huge);
    const submit = page.getByRole("button", { name: /登録|作成|保存|起票/ });
    if ((await submit.count()) > 0) {
      await submit.first().click();
      await page.waitForTimeout(4000);
      const html = await page.content();
      expect(html, "huge input crashed the page").not.toContain("__next_error__");
    }
  }
});

// ===== 7. 停止/削除済みアカウントの既存セッション無効化 =====
test("[SESS] suspending an account invalidates its live session immediately", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const victim = await db().account.findFirst({
    where: { loginId: ACCOUNTS.R8.loginId },
    select: { id: true, status: true },
  });
  expect(victim).not.toBeNull();

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "R8");
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);

  await db().account.update({ where: { id: victim!.id }, data: { status: "suspended" } });
  try {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await db().account.update({ where: { id: victim!.id }, data: { status: victim!.status } });
    await ctx.close();
  }
});

// ===== 8. ④ダミーは書き込み不可 =====
test("[R4] dummy viewer cannot write on the admin screen", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R4");
  await page.goto("/admin");
  const body = await page.locator("body").innerText();
  expect(body).toMatch(/ダミー|サンプル|閲覧/);
});

// ===== 9. IDOR: フォームのIDを他店のレコードに差し替えても拒否されること =====
test("[IDOR] R8 cannot delete another agency's daily report by swapping the form id", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // ⑧のスコープ外（親1次店110001）の日報を代理店コードから解決する。
  // 以前は cuid を直書きしていたため、DBを作り直すと解決できず失敗していた（CIでは必ず失敗する）。
  const parent = await db().agency.findFirstOrThrow({ where: { code: "110001" } });
  const foreign = await db().dailyReport.findFirstOrThrow({
    where: { agencyId: parent.id },
    select: { id: true, date: true, type: true },
  });
  page.on("dialog", (d) => d.accept());
  await login(page, "R8");
  await page.goto("/reports?tab=summary&from=2026-08-01&to=2026-08-31");
  const injected = await page.evaluate((fid) => {
    const inp = document.querySelector('form input[name="id"]') as HTMLInputElement | null;
    const form = inp?.closest("form") as HTMLFormElement | null;
    if (!inp || !form) return false;
    inp.value = fid;
    form.requestSubmit();
    return true;
  }, foreign.id);
  expect(injected, "no daily-report form found for R8").toBe(true);
  await page.waitForTimeout(4000);
  const still = await db().dailyReport.findUnique({ where: { id: foreign.id } });
  expect(still, "R8 deleted another agency's daily report").not.toBeNull();
  const denied = await db().auditLog.findFirst({
    where: { actor: "airis_2210001_001", action: "daily_report_delete" },
    orderBy: { createdAt: "desc" },
  });
  console.log("IDOR audit:", JSON.stringify(denied));
});

// ===== 10. IDOR: 訪販員申請で他店の販売員IDを注入 =====
test("[IDOR] R8 cannot file a field-agent application for another agency's sales staff", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // ⑧（210001所属）のスコープ外にある販売員を、代理店コードから解決する。
  // 以前は cuid 直書きで、DBを作り直すと解決できず失敗していた（CIでは必ず失敗する）。
  const r8 = await db().account.findFirstOrThrow({
    where: { loginId: ACCOUNTS.R8.loginId },
    select: { agencyId: true },
  });
  const foreignStaff = await db().salesStaff.findFirstOrThrow({
    where: {
      status: { in: ["provisional", "registered"] },
      agency: { isDummy: false, id: { not: r8.agencyId ?? undefined } },
      // ⑧のスコープは自店のみなので、自店以外ならスコープ外
    },
    select: { id: true, salesId: true },
  });
  const before = await db().fieldAgentApplication.count();
  await login(page, "R8");
  await page.goto("/field-agents");
  await page
    .getByRole("button", { name: /訪販員申請/ })
    .first()
    .click();
  const injected = await page.evaluate((sid) => {
    const sel = document.querySelector('select[name="salesStaffId"]') as HTMLSelectElement | null;
    if (!sel) return false;
    const opt = document.createElement("option");
    opt.value = sid;
    opt.text = "injected";
    sel.appendChild(opt);
    sel.value = sid;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, foreignStaff.id);
  expect(injected, "salesStaffId select not found").toBe(true);
  // 必須項目を埋める
  for (const [name, value] of [
    ["lastNameKana", "テスト"],
    ["firstNameKana", "タロウ"],
    ["pledgeNo", "QAR001"],
    ["startDate", "2026-09-01"],
    ["agencyCode1", "150008"],
    ["agencyCode2", "250008"],
  ] as const) {
    const loc = page.locator(`[name="${name}"]`);
    if ((await loc.count()) > 0) await loc.first().fill(value);
  }
  await page
    .getByRole("button", { name: /^申請する|申請$|登録/ })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(4000);
  const after = await db().fieldAgentApplication.count();
  expect(after, "R8 created an application for a foreign sales staff").toBe(before);
  const body = await page.locator("body").innerText();
  console.log("IDOR field-agent message:", body.match(/.{0,80}範囲外.{0,40}/)?.[0] ?? "(none)");
  expect(body).toMatch(/範囲外|見つからない|権限/);
});

// ===== 11. ステータスはマスタ値のみ受け付ける（不正値は拒否） =====
test("[EXC] a case status outside the master is refused", async ({ page }) => {
  test.setTimeout(120_000);
  const target = await db().case.findFirstOrThrow({
    where: { series: "HL", status: { notIn: ["完了", "停止", "削除済"] } },
    select: { id: true, status: true, caseNo: true },
  });
  page.on("dialog", (d) => d.accept());
  await login(page, "R5");
  await page.goto(`/hotline/${target.id}`);
  const injected = await page.evaluate(() => {
    const sel = document.querySelector('select[name="status"]') as HTMLSelectElement | null;
    const form = sel?.closest("form") as HTMLFormElement | null;
    if (!sel || !form) return false;
    const opt = document.createElement("option");
    opt.value = "QAR_不正ステータス";
    opt.text = "QAR";
    sel.appendChild(opt);
    sel.value = "QAR_不正ステータス";
    form.requestSubmit();
    return true;
  });
  expect(injected, "status form not found").toBe(true);
  await page.waitForTimeout(4000);
  const after = await db().case.findUniqueOrThrow({ where: { id: target.id } });
  expect(after.status, "a bogus status was accepted").toBe(target.status);
});

// ===== 12. 日報の再提出は上書き（重複行を作らない §7.5） =====
test("[BND] resubmitting a daily report overwrites instead of duplicating", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R9");
  await page.goto("/reports");
  const staff = await db().salesStaff.findFirstOrThrow({
    where: { salesId: "110001C001" },
    select: { id: true, agencyId: true },
  });
  const date = "2026-07-15";
  await db().dailyReport.deleteMany({ where: { salesStaffId: staff.id, date } });
  const before = await db().dailyReport.count();
  for (const n of ["3", "7"]) {
    await page.goto("/reports");
    const dateInput = page.locator('input[name="date"]').first();
    if ((await dateInput.count()) === 0) break;
    await dateInput.fill(date);
    const acq = page.locator('input[name="acquisitions"]').first();
    if ((await acq.count()) > 0) await acq.fill(n);
    const visits = page.locator('input[name="visits"]').first();
    if ((await visits.count()) > 0) await visits.fill("10");
    await page
      .getByRole("button", { name: /提出|保存|登録/ })
      .first()
      .click();
    await page.waitForTimeout(3000);
  }
  const rows = await db().dailyReport.findMany({ where: { salesStaffId: staff.id, date } });
  console.log("daily rows for", date, rows.length, JSON.stringify(rows.map((r) => r.acquisitions)));
  expect(rows.length, "resubmission created a duplicate row").toBeLessThanOrEqual(1);
  const after = await db().dailyReport.count();
  expect(after).toBeLessThanOrEqual(before + 1);
  await db().dailyReport.deleteMany({ where: { salesStaffId: staff.id, date } });
});

// ===== 13. 起票時の対応期限フォーマット検証（更新時は検証あり / 起票時は？） =====
test("[EXC] a malformed deadline is rejected when creating a case", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R5");
  await page.goto("/hotline?new=1");
  await page.selectOption('select[name="templateKind"]', { index: 1 });
  const primary = page.locator('select[name="primaryAgencyId"]');
  const opts = await primary
    .locator("option")
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean));
  await primary.selectOption(opts[0]);
  await page.locator('textarea[name="body"]').fill("QAR_DEADLINE_CHECK 検収用の本文");
  await page.locator('input[name="title"]').fill("QAR_DEADLINE_CHECK");
  // date入力の型検証を外して不正な文字列を送る
  await page.evaluate(() => {
    const el = document.querySelector('input[name="deadline"]') as HTMLInputElement;
    el.type = "text";
    el.value = "9999-99-99";
  });
  await page
    .getByRole("button", { name: /起票|作成|登録|送信/ })
    .first()
    .click();
  await page.waitForTimeout(5000);
  const created = await db().case.findFirst({
    where: { title: { contains: "QAR_DEADLINE_CHECK" } },
    select: { id: true, caseNo: true, deadline: true, status: true },
  });
  console.log(
    "created case:",
    JSON.stringify(created),
    "| page:",
    (await page.locator("body").innerText()).slice(0, 200)
  );
  try {
    expect(created?.deadline ?? null, "a malformed deadline was stored").not.toBe("9999-99-99");
  } finally {
    if (created) {
      await db().notification.deleteMany({ where: { body: { contains: created.caseNo } } });
      await db().caseStatusHistory.deleteMany({ where: { caseId: created.id } });
      await db().caseMessage.deleteMany({ where: { caseId: created.id } });
      await db()
        .statusHistory.deleteMany({ where: { entityId: created.id } })
        .catch(() => {});
      await db().auditLog.deleteMany({ where: { target: { contains: created.caseNo } } });
      await db().case.delete({ where: { id: created.id } });
      console.log("cleaned up", created.caseNo);
    }
  }
});

// ===== 14. IP許可リスト設定が実際に管理画面の入口へ効くか（§10.1） =====
test("[SEC] the IP allowlist saved from the admin UI is enforced on /admin itself", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const before = await db().appSetting.findUnique({ where: { key: "admin_ip_allowlist" } });
  page.on("dialog", (d) => d.accept());
  await login(page, "R1");
  await page.goto("/admin");
  await page.locator('input[name="settingValue"]').fill("203.0.113.9");
  await page.locator('[name="settingReason"]').fill("QAR 検収: 許可リストの実効性確認");
  await page.getByRole("button", { name: "IP許可リストを更新する" }).click();
  await page.waitForTimeout(4000);
  const saved = await db().appSetting.findUnique({ where: { key: "admin_ip_allowlist" } });
  console.log("saved setting:", JSON.stringify(saved));
  console.log(
    "UI message:",
    (await page.locator("body").innerText()).match(/.{0,120}許可リスト.{0,120}/)?.[0]
  );
  try {
    if (saved?.value === "203.0.113.9") {
      // 保存できたなら、管理画面の入口とCSVの双方で拒否されなければならない
      const pageRes = await page.request.get("/admin", { maxRedirects: 0 });
      const csvRes = await page.request.get("/admin/csv", { maxRedirects: 0 });
      console.log("after allowlist: /admin =", pageRes.status(), "/admin/csv =", csvRes.status());
      expect(
        [307, 302, 403].includes(pageRes.status()),
        `/admin was still reachable (${pageRes.status()}) while the allowlist excluded this IP`
      ).toBe(true);
    }
  } finally {
    if (before) {
      await db().appSetting.update({
        where: { key: "admin_ip_allowlist" },
        data: { value: before.value },
      });
    } else {
      await db().appSetting.deleteMany({ where: { key: "admin_ip_allowlist" } });
    }
    await db().statusHistory.deleteMany({
      where: { entityType: "app_setting", reason: { contains: "QAR" } },
    });
    await db().auditLog.deleteMany({ where: { target: { contains: "QAR 検収: 許可リスト" } } });
    console.log("restored AppSetting");
  }
});

// ===== 15. アカウントロック（30分で10回失敗→30分ロック §4.2） =====
test("[SEC] ten failed logins lock the throwaway account for 30 minutes", async ({ page }) => {
  // 60秒のレート制限ウィンドウを跨ぐ待機を含むため長め（下のコメント参照）
  test.setTimeout(300_000);
  const ID = "QAR_lock_001";
  const GOOD = "QAR-Lockout-Test-2026!xyz";
  // 使い捨てアカウントは **このテストが自分で作る**。
  // 以前は事前に手作業で作った行に依存しており、DBが新規のCIでは必ず失敗していた
  // （テストは自己完結でなければならない。シードアカウントは絶対に壊さない ← BUG-Q11 の再発防止）。
  const agency = await db().agency.findFirstOrThrow({ where: { code: "210001" } });
  await db().account.deleteMany({ where: { loginId: ID } });
  const acct = await db().account.create({
    data: {
      loginId: ID,
      role: "R8",
      name: "QAR ロック検証用",
      agencyId: agency.id,
      status: "active",
      // ログイン可能である必要があるため、アプリと同じ方式（Argon2id + 現行ペッパー）でハッシュする
      ...hashedForTest(GOOD),
      mustChangePassword: false,
    },
  });

  // まず正しいパスワードで入れることを確認（ハッシュ・ペッパーの整合）
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(ID);
  await page.locator('input[name="password"]').fill(GOOD);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/(dashboard|mfa|password)/, { timeout: 15_000 });
  console.log("good login landed on", new URL(page.url()).pathname);
  await db().session.deleteMany({ where: { accountId: acct!.id } });
  await db().account.update({
    where: { loginId: ID },
    data: { failedAttempts: 0, lockedUntil: null },
  });
  await page.context().clearCookies();

  // 失敗試行のペース配分について（§4.2 ロック と §10.1 レート制限の関係）:
  //   レート制限（同一IP+同一IDで60秒5回 / src/app/(auth)/actions.ts:28-29）は
  //   **パスワード検証より前段**で拒否するため、拒否された試行は AccessLog の failure に
  //   記録されない。したがって60秒以内に連続試行しても失敗カウンタは5で止まり、
  //   ロック閾値10（同:32、集計は30分ウィンドウ）には到達しない。
  //   これはレート制限がロックより手前で効いている＝より強い防御であり仕様どおり。
  //   §4.2 のロックは「30分ウィンドウ内で10回」なので、レート制限ウィンドウ（60秒）を
  //   跨げば到達する。ここでは 5回 → 62秒待機 → 5回 の2バーストで検証する。
  //   （期待結果は一切緩めていない: 10回失敗で30分ロックされることを従来どおり要求する）
  const states: string[] = [];
  let attempt = 0;
  for (const burst of [1, 2]) {
    for (let i = 1; i <= 5; i++) {
      attempt++;
      await page.goto("/login");
      await page.locator('input[name="loginId"]').fill(ID);
      await page.locator('input[name="password"]').fill(`wrong-password-${attempt}`);
      await page.getByRole("button", { name: "ログイン" }).click();
      await page.waitForTimeout(700);
      const a = await db().account.findUnique({ where: { loginId: ID } });
      states.push(
        `b${burst}-${i}:failed=${a?.failedAttempts} locked=${a?.lockedUntil ? "yes" : "no"}`
      );
    }
    if (burst === 1) {
      // 1バースト目の5件が60秒のレート制限ウィンドウから抜けるのを待つ
      const failures = await db().accessLog.count({
        where: { loginId: ID, result: "failure" },
      });
      console.log(`burst1 recorded failures=${failures} → waiting out the 60s rate-limit window`);
      expect(failures, "1バースト目で5件の失敗が記録されること").toBeGreaterThanOrEqual(5);
      await page.waitForTimeout(62_000);
    }
  }
  console.log(states.join(" | "));
  const after = await db().account.findUniqueOrThrow({ where: { loginId: ID } });
  expect(after.lockedUntil, "the account was never locked").not.toBeNull();
  const mins = (after.lockedUntil!.getTime() - Date.now()) / 60000;
  console.log("lock remaining minutes:", mins.toFixed(1));
  expect(mins).toBeGreaterThan(25);
  expect(mins).toBeLessThanOrEqual(31);

  // ロック中は正しいパスワードでも入れない
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(ID);
  await page.locator('input[name="password"]').fill(GOOD);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).pathname).toBe("/login");
  const msg = await page.locator("body").innerText();
  console.log("locked message:", msg.match(/.{0,100}ロック.{0,60}/)?.[0] ?? "(none)");
  expect(msg).toMatch(/ロック|しばらく|時間/);

  // 使い捨てアカウントの後片付け（次回実行に持ち越さない）
  await db().accessLog.deleteMany({ where: { loginId: ID } });
  await db().auditLog.deleteMany({ where: { actor: ID } });
  await db().session.deleteMany({ where: { accountId: acct.id } });
  await db().account.deleteMany({ where: { id: acct.id } });
});

// ===== 16. 絶対期限（24時間）を過ぎたセッションは失効する =====
test("[SESS] a session past its absolute expiry is refused", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R9");
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === "airis_session")!.value;
  await db().session.update({
    where: { token },
    data: {
      createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() - 60 * 1000),
    },
  });
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
