// 本番環境での是正確認（QA loop3 の critical / major 修正が本番で有効か）。
//
// 読み取り＋UI表示の確認のみ。**本番データを書き換える操作は一切行わない**
// （リセット・停止・削除などの実行はしない。ボタンが出ないことの確認に留める）。
// 認証情報とMFA通過の手順は prod-smoke.spec.ts と同じ方式（秘密鍵は本番DBから読む）。
// 接続・ログイン・MFA通過は e2e-prod/helpers.ts に集約する。
// 以前ここに複製を持っていたため、prod-smoke 側だけMFA登録をやめる修正をした結果、
// この複製が残って本番アカウント2件（②③）を新たに登録してしまった（QA loop5）。
import { test, expect } from "@playwright/test";
import { PW_ADMIN, db, disconnectDb, login } from "./helpers";

const R1_LOGIN = "airis_slb_sys_001";
const R3_LOGIN = "airis_snc_ops_0001";

test.afterAll(async () => {
  await disconnectDb();
});

test("本番: ③は①アカウントのリセットボタンが見えない（critical BUG-L01 の是正確認）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, R3_LOGIN, PW_ADMIN);
  // 発注者指示（OWN-014）どおり③は管理画面に入れる
  await page.goto("/admin");
  expect(new URL(page.url()).pathname, "③が管理画面に入れない").toBe("/admin");

  // ①の行にはリセットボタンが出ない（職務分離 §6.1-3）
  await page.goto(`/admin?q=${encodeURIComponent(R1_LOGIN)}`);
  const row = page.locator("tbody tr", { hasText: R1_LOGIN }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  const buttons = (await row.locator("button").allInnerTexts()).map((s) => s.trim());
  console.log(`[prod] ③が見る①の行のボタン: ${JSON.stringify(buttons)}`);
  expect(buttons, "本番で③に①のPWリセットが見えている").not.toContain("PWリセット");
  expect(buttons, "本番で③に①のMFAリセットが見えている").not.toContain("MFAリセット");
});

test("本番: 当月KPIが稼働日報タブの初期表示に出る（§7.5 一覧・集計画面に表示）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, R1_LOGIN, PW_ADMIN);
  await page.goto("/reports");
  const card = page.getByTestId("kpi-current-month");
  await expect(card, "当月KPIカードが表示されていない").toBeVisible({ timeout: 20_000 });
  // 原本準拠の指標が揃っている（訪販12 + テレマ8。獲得生産性・後確通過率は本ループで追加）
  for (const label of ["生産性", "進捗", "ペースメーカー", "訪問/日", "獲得生産性", "後確通過率"]) {
    await expect(card.getByText(label, { exact: true }), `${label} が無い`).toBeVisible();
  }
  // ペースメーカーは率表示（原本 J7 の書式が 0%）
  const paceTile = card.locator("div.rounded-xl").filter({ hasText: "ペースメーカー" }).first();
  const text = (await paceTile.innerText()).replace(/\s+/g, " ");
  console.log(`[prod] ペースメーカーのタイル: ${JSON.stringify(text)}`);
  expect(text, "ペースメーカーが率表示になっていない").toMatch(/%/);
});

test("本番: ③は監査ログ/アクセスログ/棚卸CSVに到達できない（発注者指示 2026-08-06）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, R3_LOGIN, PW_ADMIN);

  // API層: /admin/csv の4type すべてが403
  for (const type of ["inventory", "audit", "access", "erasure"]) {
    const res = await page.request.get(`/admin/csv?type=${type}`, { maxRedirects: 0 });
    const body = await res.text();
    console.log(`[prod] ③ GET /admin/csv?type=${type} -> ${res.status()}`);
    expect(res.status(), `本番で③が /admin/csv?type=${type} に到達できる`).toBe(403);
    expect(body, `本番で type=${type} のCSV本文が返っている`).not.toContain("ログインID");
  }

  // UI層: 管理画面にログのセクションもCSV出力リンクも出ない
  await page.goto("/admin");
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "本番で③にアクセスログのセクションが見えている").not.toContain(
    "アクセスログ（直近"
  );
  expect(bodyText, "本番で③に監査ログのセクションが見えている").not.toContain("監査ログ（直近");
  const links = await page.locator('a[href^="/admin/csv"]').count();
  console.log(`[prod] ③に見える /admin/csv リンク数: ${links}`);
  expect(links, "本番で③にCSV出力リンクが見えている").toBe(0);

  // ③に必要な業務（アカウント一覧の参照）は従来どおりできる
  await expect(
    page.locator("tbody tr").first(),
    "本番で③がアカウント一覧を見られない"
  ).toBeVisible();
});

test("本番: ②は監査記録に従来どおり到達できる（制限が③に限定されている）", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "airis_snc_adm_001", PW_ADMIN);
  for (const type of ["inventory", "audit", "access"]) {
    const res = await page.request.get(`/admin/csv?type=${type}`);
    console.log(`[prod] 対照 ② GET /admin/csv?type=${type} -> ${res.status()}`);
    expect(res.status(), `本番で②が /admin/csv?type=${type} を取得できない`).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(50);
  }
});

test("本番: ③は自分が作成していないSNC系宛申請の証跡を取得できない（発注者指示 2026-08-06）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const d = db();
  // 本番の実データから「SNC系（①〜⑥）宛 かつ ③が作成者ではない」申請の証跡を探す。
  // **本番データは一切変更しない**（読み取りとファイル取得の可否確認のみ）。
  const r3 = await d.account.findUnique({
    where: { loginId: R3_LOGIN },
    select: { id: true },
  });
  const target = await d.accountRequest.findFirst({
    where: {
      role: { in: ["R1", "R2", "R3", "R4", "R5", "R6"] },
      evidenceFileId: { not: null },
      ...(r3 ? { NOT: { createdBy: r3.id } } : {}),
    },
    select: { requestId: true, role: true, evidenceFileId: true },
  });
  if (!target) {
    console.log("[prod] 対象の申請（SNC系宛・③以外が作成）が本番に無いためスキップ");
    test.skip();
    return;
  }
  console.log(`[prod] 対象: ${target.requestId}（宛先ロール=${target.role}）`);

  await login(page, R3_LOGIN, PW_ADMIN);
  const denied = await page.request.get(`/files/${target.evidenceFileId}`, { maxRedirects: 0 });
  console.log(`[prod] ③ GET /files/<SNC系宛の証跡> -> ${denied.status()}`);
  expect(denied.status(), "本番で③がSNC系宛申請の証跡を取得できる").toBe(403);

  // 対照: ②は従来どおり取得できる（制限が③に限定されており過剰でない）
  await page.context().clearCookies();
  await login(page, "airis_snc_adm_001", PW_ADMIN);
  const ok = await page.request.get(`/files/${target.evidenceFileId}`, { maxRedirects: 0 });
  console.log(`[prod] 対照 ② GET /files/<同じ証跡> -> ${ok.status()}`);
  expect(ok.status(), "本番で②が証跡を取得できない").toBe(200);
});

test("本番: CSV出力系のRoute Handlerは未認証で到達できない", async ({ page }) => {
  for (const path of ["/reports/csv?template=visit", "/hotline/csv", "/consumer-center/csv"]) {
    const res = await page.request.get(path, { maxRedirects: 0 });
    console.log(`[prod] 未認証 GET ${path} -> ${res.status()}`);
    expect([401, 403, 302, 307], `${path} が未認証で到達可能`).toContain(res.status());
  }
});
