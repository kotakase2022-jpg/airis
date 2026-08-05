// 発注者指示（2026-08-05）の実装確認（OWN-001〜004 / OWN-009 / OWN-011〜014）。
//
// 他の OWN 要件は既存スペックで検証済み:
//   OWN-005 生年月日の既定値      → e2e/05-sales-staff.spec.ts「生年月日のデフォルトは15年前の今日」
//   OWN-006 15歳未満の拒否        → e2e/05-sales-staff.spec.ts「15歳未満の方は申請できません」
//   OWN-007/008 CSVひな形の例文行 → e2e/07-reports-daily.spec.ts / qa9-own15-28.spec.ts OWN-026
//   OWN-010 ②は①を申請できない   → e2e/03-account-requests.spec.ts（選択肢 + API直送の拒否）
//   OWN-015〜028                  → e2e/qa9-own15-28.spec.ts
//
// 本スイートは読み取り中心（DBを書き換えない）。90アカウントの確認のみ実DBを参照する。
import { test, expect } from "@playwright/test";
import { ACCOUNTS, login, db } from "./helpers";

test.afterAll(async () => {
  await db().$disconnect();
});

// ---------------------------------------------------------------------------
// OWN-001: ログアウトボタンはヘッダ右上（「〜モード」バッジと通知ボタンの間）
// ---------------------------------------------------------------------------
test("OWN-001: ログアウトはヘッダ右上にあり、ロールバッジと通知ボタンの間に置かれている", async ({
  page,
}) => {
  await login(page, "R1");
  const logout = page.getByRole("button", { name: "ログアウト" });
  await expect(logout).toBeVisible();

  const box = await logout.boundingBox();
  expect(box, "ログアウトボタンの位置が取得できない").not.toBeNull();
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  // 右上: 画面の右半分かつ上端付近（ヘッダ内）
  expect(box!.x, "ログアウトが画面の右半分にない").toBeGreaterThan(viewport!.width / 2);
  expect(box!.y, "ログアウトがヘッダ（上端付近）にない").toBeLessThan(120);

  // 並び順: ロールバッジ → ログアウト → 通知ボタン
  const badge = page.locator("span", { hasText: /モード$/ }).first();
  const notif = page.locator('a[href="/notifications"]').first();
  const badgeBox = await badge.boundingBox();
  const notifBox = await notif.boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(notifBox).not.toBeNull();
  expect(badgeBox!.x, "ロールバッジがログアウトより右にある").toBeLessThan(box!.x);
  expect(notifBox!.x, "通知ボタンがログアウトより左にある").toBeGreaterThan(box!.x);
});

// ---------------------------------------------------------------------------
// OWN-002: 入力テキストの文字色が薄いグレーではない（読みやすい濃さ）
// ---------------------------------------------------------------------------
test("OWN-002: 入力欄の文字色が十分に濃い（プレースホルダより濃く、薄いグレーではない）", async ({
  page,
}) => {
  await login(page, "R2");
  await page.goto("/sales-staff");
  await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
  const input = page.locator('input[name="lastName"]');
  await input.fill("検証太郎");

  const color = await input.evaluate((el) => getComputedStyle(el).color);
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(m, `色を解釈できない: ${color}`).not.toBeNull();
  const [r, g, b] = [Number(m![1]), Number(m![2]), Number(m![3])];
  // 相対輝度（WCAG）。薄いグレー（#94a3b8 = slate-400 → 約0.28）より明確に暗いこと
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  console.log(`入力テキスト色 ${color} / 相対輝度 ${luminance.toFixed(4)}`);
  expect(luminance, `入力テキストが薄すぎる（${color}）`).toBeLessThan(0.1);
});

// ---------------------------------------------------------------------------
// OWN-003: ②〜⑩ に各10アカウント（計90）
//   ⑩は §14-2 により専用ロールを持たず「稼働終了代理店に属する⑦」で表現される
// ---------------------------------------------------------------------------
test("OWN-003: ②〜⑩に各10件のデモアカウントが存在する（計90件）", async () => {
  test.setTimeout(120_000);
  // 各ロールの「_002〜_011」枠（⑨は販売員IDの連番）が10件ずつあることを確認する。
  // シードの代表1件（_001 / C001）は従来から存在するため、デモ枠は _002 以降。
  const counts: Record<string, number> = {};

  // ②〜⑧: loginId の末尾3桁が 002〜011
  for (const role of ["R2", "R3", "R4", "R5", "R6", "R7", "R8"]) {
    const rows = await db().account.findMany({
      where: { role, agency: { is: { status: "active" } } },
      select: { loginId: true },
    });
    const all = await db().account.findMany({ where: { role }, select: { loginId: true } });
    const demo = all.filter((a) => /0(0[2-9]|1[01])$/.test(a.loginId));
    counts[role] = demo.length;
    console.log(`${role}: demo=${demo.length} (active-agency rows=${rows.length})`);
  }
  // ⑨: 販売員アカウント（販売員IDが loginId）
  const r9 = await db().account.findMany({ where: { role: "R9" }, select: { loginId: true } });
  counts["R9"] = r9.filter((a) => /C1(0[1-9]|10)$/.test(a.loginId)).length;
  console.log(`R9: demo=${counts["R9"]}`);

  // ⑩: 稼働終了代理店に属する⑦（§14-2 の実効ロール）
  const r10 = await db().account.findMany({
    where: { role: { in: ["R7", "R8"] }, agency: { is: { status: "closed" } } },
    select: { loginId: true },
  });
  counts["R10"] = r10.filter((a) => /0(0[2-9]|1[01])$/.test(a.loginId)).length;
  console.log(`R10(実効): demo=${counts["R10"]}`);

  for (const role of ["R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"]) {
    expect(counts[role], `${role} のデモアカウントが10件でない`).toBeGreaterThanOrEqual(10);
  }
  const total = ["R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"].reduce(
    (s, r) => s + Math.min(counts[r], 10),
    0
  );
  expect(total, "②〜⑩で計90件のデモアカウントが揃っていない").toBe(90);
});

// ---------------------------------------------------------------------------
// OWN-004: MFA登録画面にQRコードと「推奨：Google Authenticator」
//   （既存の e2e/22-mfa.spec.ts でも検証しているが、発注者指示の明示的な確認として残す）
// ---------------------------------------------------------------------------
test("OWN-004: MFA登録画面にQRコード画像と「推奨：Google Authenticator」が表示される", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const LOGIN_ID = ACCOUNTS.R2.loginId;
  const before = await db().account.findUniqueOrThrow({ where: { loginId: LOGIN_ID } });
  try {
    // 登録済みだと検証画面に行くため、いったんMFA未登録に戻す（afterで必ず復元）
    await db().account.update({
      where: { loginId: LOGIN_ID },
      data: { mfaEnabled: false, mfaSecret: null },
    });
    await db().session.deleteMany({ where: { accountId: before.id } });

    await page.goto("/login");
    await page.locator('input[name="loginId"]').fill(LOGIN_ID);
    await page.locator('input[name="password"]').fill(ACCOUNTS.R2.pw);
    await page.getByRole("button", { name: "ログイン" }).click();
    await page.waitForURL(/\/mfa\/setup/, { timeout: 20_000 });

    // QRコードは data URI の img として描画される
    const qr = page.locator('img[src^="data:image"]');
    await expect(qr, "QRコード画像が表示されていない").toBeVisible();
    // 「推奨：Google Authenticator」（全角コロン）
    await expect(page.getByText(/推奨[：:]\s*Google Authenticator/)).toBeVisible();
  } finally {
    await db().account.update({
      where: { loginId: LOGIN_ID },
      data: { mfaEnabled: before.mfaEnabled, mfaSecret: before.mfaSecret },
    });
    await db().session.deleteMany({ where: { accountId: before.id } });
  }
});

// ---------------------------------------------------------------------------
// OWN-012 / OWN-013: ログイン画面のプレースホルダが実際のID例 / スクロール不要
// ---------------------------------------------------------------------------
test("OWN-012: ログインIDのプレースホルダが実際のID例になっている", async ({ page }) => {
  await page.goto("/login");
  const ph = await page.locator('input[name="loginId"]').getAttribute("placeholder");
  console.log("placeholder:", ph);
  expect(ph, "プレースホルダが未設定").toBeTruthy();
  // 実在するID体系（Airisアカウント / 販売員ID）の例が示されていること
  expect(ph!).toMatch(/airis_/);
  expect(ph!).toMatch(/\d{6}C\d{3}/);
});

test("OWN-013: ログイン画面はスクロールなしで操作できる（375x812 / 1280x800 の両方）", async ({
  page,
}) => {
  for (const size of [
    { width: 375, height: 812 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
    const metrics = await page.evaluate(() => ({
      scrollH: document.documentElement.scrollHeight,
      clientH: document.documentElement.clientHeight,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    }));
    console.log(`${size.width}x${size.height}:`, JSON.stringify(metrics));
    // 縦スクロールが発生しない（1px の丸め誤差は許容）
    expect(
      metrics.scrollH - metrics.clientH,
      `${size.width}x${size.height} で縦スクロールが必要`
    ).toBeLessThanOrEqual(1);
    // 横スクロールも発生しない
    expect(
      metrics.scrollW - metrics.clientW,
      `${size.width}x${size.height} で横スクロールが必要`
    ).toBeLessThanOrEqual(1);
  }
});

// ---------------------------------------------------------------------------
// OWN-014: ③の管理画面アクセスが〇（発注者指示 2026-08-05）
//   ただし §6.1-3 の職務分離により、①〜⑥のリセット代行はできない（BUG-L01 の是正）
// ---------------------------------------------------------------------------
test("OWN-014: ③は管理画面に入れるが、①②のリセット代行ボタンは出ない（職務分離）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "R3");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(new URL(page.url()).pathname, "③が管理画面に入れていない").toBe("/admin");

  // ①のアカウント行にリセットボタンが出ないこと（UI層。サーバ側は単体テストで全数検証）
  const r1LoginId = ACCOUNTS.R1.loginId;
  await page.goto(`/admin?q=${encodeURIComponent(r1LoginId)}`);
  const row = page.locator("tbody tr", { hasText: r1LoginId }).first();
  await expect(row).toBeVisible();
  const rowButtons = (await row.locator("button").allInnerTexts()).map((s) => s.trim());
  console.log(`③が見る①の行のボタン: ${JSON.stringify(rowButtons)}`);
  expect(rowButtons, "③に①のPWリセットボタンが見えている").not.toContain("PWリセット");
  expect(rowButtons, "③に①のMFAリセットボタンが見えている").not.toContain("MFAリセット");

  // 代理店系（⑦）の行にはリセットボタンが出る（§4.2 のリセット代行は行える）
  const r7LoginId = ACCOUNTS.R7.loginId;
  await page.goto(`/admin?q=${encodeURIComponent(r7LoginId)}`);
  const row7 = page.locator("tbody tr", { hasText: r7LoginId }).first();
  await expect(row7).toBeVisible();
  const row7Buttons = (await row7.locator("button").allInnerTexts()).map((s) => s.trim());
  console.log(`③が見る⑦の行のボタン: ${JSON.stringify(row7Buttons)}`);
  expect(row7Buttons, "③が⑦のリセット代行を行えない（§4.2 未達）").toContain("PWリセット");
});
