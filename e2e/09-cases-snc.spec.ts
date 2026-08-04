import { test, expect } from "@playwright/test";
import {
  ACCOUNTS,
  collectConsoleErrors,
  criticalErrors,
  db,
  login,
} from "./helpers";

// ============================================================
// 担当: 窓口3画面+通知（§7.8〜§7.10, §3.7）SNC側
// データプレフィクス: QA6
// ============================================================

const RUN = `QA6${Date.now().toString(36)}`; // 実行ごとの一意トークン
let seq = 0;

// JSTの日付（YYYY-MM-DD）を offsetDays ずらして返す（アプリの todayJst と同一ロジック）
function jstDate(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86400000 + 9 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
}

// テストデータ用の案件をDBに直接作成（オーナー接続）
async function mkCase(opts: {
  series?: "HL" | "CSC";
  agencyCode?: string;
  title: string;
  status?: string;
  deadline?: string | null;
}) {
  const agency = await db().agency.findUnique({
    where: { code: opts.agencyCode ?? "110001" },
  });
  if (!agency) throw new Error(`agency not found: ${opts.agencyCode}`);
  const series = opts.series ?? "HL";
  return db().case.create({
    data: {
      series,
      caseNo: `${series === "CSC" ? "CSC" : "HLC"}-${RUN}${seq++}`,
      templateKind: "フリー入力",
      title: opts.title,
      primaryAgencyId: agency.id,
      ispNumber: `${RUN}-isp`,
      deadline: opts.deadline === undefined ? jstDate(7) : opts.deadline,
      status: opts.status ?? "未対応",
      createdBy: "QA6テスト",
      messages: {
        create: { senderSide: "snc", senderName: "QA6テスト", body: "QA6テスト用の本文です。" },
      },
    },
  });
}

test.describe("§7.8 ホットライン窓口（SNC側）", () => {
  test("R5で/hotline: 一覧表示・通知チャネルバッジ・新規依頼ボタン・コンソールエラー0", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R5");
    await page.goto("/hotline");

    // ページタイトル
    await expect(page.getByRole("heading", { name: "ホットライン窓口" })).toBeVisible();

    // 案件カードが一覧に表示される（ページネーション50件/頁のため件数はDBと突合）
    const hlTotal = await db().case.count({
      where: { series: "HL", primaryAgency: { isDummy: false } },
    });
    await expect(page.getByText(`全${hlTotal}件中`)).toBeVisible();

    // シード案件（HL）が表示され、CSC案件はホットライン一覧に混ざらない
    // （データ蓄積で2頁目に落ちても検証できるよう、シードcaseNoで絞り込む）
    await page.goto("/hotline?q=1000000000");
    await expect(page.getByText("HLC-1000000000001")).toBeVisible();
    await expect(page.getByText("HLC-1000000000002")).toBeVisible();
    await expect(page.getByText("CSC-1000000000001")).toHaveCount(0);
    await page.goto("/hotline");

    // 通知チャネル状態バッジ行（§7.8: Airis内通知: 記録済み / Slack: 未設定 / メール: 未設定）
    await expect(page.getByText("Airis内通知: 記録済み")).toBeVisible();
    await expect(page.getByText("Slack: 未設定")).toBeVisible();
    await expect(page.getByText("メール: 未設定")).toBeVisible();

    // 起票ボタン（SNC側のみ表示）
    await expect(page.getByRole("link", { name: "新規依頼" })).toBeVisible();

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R5で/hotline: キーワード検索とステータスフィルタ", async ({ page }) => {
    const titleA = `${RUN}-flt 確認中の案件`;
    const titleB = `${RUN}-flt 完了の案件`;
    await mkCase({ title: titleA, status: "確認中" });
    await mkCase({ title: titleB, status: "完了" });

    await login(page, "R5");
    await page.goto("/hotline");

    // UIフォームから検索
    await page.locator('input[name="q"]').fill(`${RUN}-flt`);
    await page.getByRole("button", { name: "検索" }).click();
    await page.waitForURL(/\/hotline\?/);
    await expect(page.getByText(titleA)).toBeVisible();
    await expect(page.getByText(titleB)).toBeVisible();

    // ステータスフィルタ: 完了のみ
    await page.goto(`/hotline?q=${encodeURIComponent(`${RUN}-flt`)}&status=${encodeURIComponent("完了")}`);
    await expect(page.getByText(titleB)).toBeVisible();
    await expect(page.getByText(titleA)).toHaveCount(0);

    // 案件IDでの検索（シード案件）
    await page.goto(`/hotline?q=HLC-1000000000001`);
    await expect(page.getByText("HLC-1000000000001")).toBeVisible();
    await expect(page.getByText("HLC-1000000000002")).toHaveCount(0);
  });

  test("R5で/consumer-centerへ直接アクセス→/dashboardへリダイレクト", async ({ page }) => {
    await login(page, "R5");
    await page.goto("/consumer-center");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/dashboard/);

    // 権限外アクセスは監査ログに記録される（§3.3）
    const denied = await db().auditLog.findFirst({
      where: {
        actor: ACCOUNTS.R5.loginId,
        action: "access_denied",
        target: { contains: "consumer-center" },
      },
      orderBy: { createdAt: "desc" },
    });
    expect(denied).not.toBeNull();
  });

  test("R6で/hotlineへ直接アクセス→/dashboardへ、/consumer-centerは表示可", async ({ page }) => {
    await login(page, "R6");
    await page.goto("/hotline");
    await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/dashboard/);

    // 自分の担当窓口はアクセス可能（シードCSC案件が見える。HL案件は混ざらない）
    await page.goto("/consumer-center");
    await expect(page.getByRole("heading", { name: "消費者センター窓口" })).toBeVisible();
    await page.goto("/consumer-center?q=1000000000");
    await expect(page.getByText("CSC-1000000000001")).toBeVisible();
    await expect(page.getByText("HLC-1000000000001")).toHaveCount(0);
  });

  test("R5新規依頼: テンプレ「音声提出依頼」→タイトル自動生成・本文雛形→起票→DB Case + R7へNotification", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    const isp = `${RUN}-new1`;
    const expectedTitle = `音声提出依頼／東都ネットワーク販売株式会社／${isp}`;

    await login(page, "R5");
    await page.goto("/hotline?new=1");
    await expect(page.getByText("新規依頼の起票")).toBeVisible();

    // テンプレ選択 → 本文雛形が自動セットされる
    await page.locator('select[name="templateKind"]').selectOption("音声提出依頼");
    const body = await page.locator('textarea[name="body"]').inputValue();
    expect(body).toContain("■依頼理由");
    expect(body).toContain("■顧客要望");
    expect(body).toContain("■顧客情報");

    // 代理店選択・ISP入力 → タイトルが「テンプレ名称／代理店名称／ISP受付番号」で自動生成
    await page.locator('select[name="primaryAgencyId"]').selectOption({
      label: "110001 東都ネットワーク販売株式会社",
    });
    await page.locator('input[name="ispNumber"]').fill(isp);
    await expect(page.locator('input[name="title"]')).toHaveValue(expectedTitle);

    // 対応期限（カレンダー選択）
    await page.locator('input[name="deadline"]').fill(jstDate(7));

    // 起票 → 詳細ページへ遷移
    await page.getByRole("button", { name: "起票する" }).click();
    await page.waitForURL(/\/hotline\/[a-z0-9]+$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: expectedTitle })).toBeVisible();
    await expect(page.getByText("■依頼理由")).toBeVisible();

    // DB検証: Case(series=HL, caseNo=HLC-*)
    const created = await db().case.findFirst({
      where: { ispNumber: isp },
      include: { messages: true, primaryAgency: true },
    });
    expect(created).not.toBeNull();
    expect(created!.series).toBe("HL");
    expect(created!.caseNo).toMatch(/^HLC-/);
    expect(created!.title).toBe(expectedTitle);
    expect(created!.templateKind).toBe("音声提出依頼");
    expect(created!.status).toBe("未対応");
    expect(created!.deadline).toBe(jstDate(7));
    expect(created!.primaryAgency.code).toBe("110001");
    expect(created!.messages).toHaveLength(1);
    expect(created!.messages[0].senderSide).toBe("snc");

    // DB検証: 当該1次店のR7アカウントへNotification作成（要件9-2①）
    const notif = await db().notification.findFirst({
      where: {
        account: { loginId: ACCOUNTS.R7.loginId },
        title: "ホットライン窓口から新規依頼が届きました",
        body: { contains: created!.caseNo },
      },
    });
    expect(notif).not.toBeNull();
    expect(notif!.link).toBe(`/agency-cases/${created!.id}`);

    expect(criticalErrors(errors)).toEqual([]);
  });

  test("R5新規依頼: 必須未入力では起票できない（DBにも作成されない）", async ({ page }) => {
    await login(page, "R5");
    await page.goto("/hotline?new=1");
    const before = await db().case.count();

    await page.getByRole("button", { name: "起票する" }).click();
    // ブラウザのrequiredバリデーションで送信されず、同じページに留まる
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/new=1/);
    const valid = await page
      .locator('select[name="templateKind"]')
      .evaluate((el) => (el as HTMLSelectElement).checkValidity());
    expect(valid).toBe(false);

    const after = await db().case.count();
    expect(after).toBe(before);
  });

  test("期限バッジ3態: 期限まで◯日 / 本日期限 / 期限超過◯日", async ({ page }) => {
    const tFuture = `${RUN}-badge 5日後が対応期限の案件`;
    const tToday = `${RUN}-badge 当日が対応期限の案件`;
    const tOver = `${RUN}-badge 対応期限を過ぎた案件`;
    await mkCase({ title: tFuture, deadline: jstDate(5) });
    await mkCase({ title: tToday, deadline: jstDate(0) });
    await mkCase({ title: tOver, deadline: jstDate(-3) });

    await login(page, "R5");
    await page.goto(`/hotline?q=${encodeURIComponent(`${RUN}-badge`)}`);

    await expect(
      page.locator("a", { hasText: tFuture }).getByText("期限まで5日", { exact: true })
    ).toBeVisible();
    await expect(
      page.locator("a", { hasText: tToday }).getByText("本日期限", { exact: true })
    ).toBeVisible();
    await expect(
      page.locator("a", { hasText: tOver }).getByText("期限超過 3日", { exact: true })
    ).toBeVisible();
  });

  test("R5詳細: スレッド表示・ファイル添付付き返信→CaseMessage(snc)+R7へ通知", async ({ page }) => {
    const c = await mkCase({ title: `${RUN}-reply SNC返信テスト案件` });
    const replyText = `${RUN} SNCからの返信です。ご確認ください。`;

    await login(page, "R5");
    await page.goto(`/hotline/${c.id}`);

    // スレッド表示（初回メッセージ）
    await expect(page.getByText("やりとり（スレッド）")).toBeVisible();
    await expect(page.getByText("QA6テスト用の本文です。")).toBeVisible();

    // SNC側はファイル添付UIがある
    const fileInput = page.locator('input[type="file"][name="files"]');
    await expect(fileInput).toBeVisible();
    await fileInput.setInputFiles({
      name: "QA6-evidence.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 QA6 test attachment"),
    });
    await page.locator('textarea[name="body"]').fill(replyText);
    await page.getByRole("button", { name: "返信を送信" }).click();
    await expect(page.getByText("返信を送信しました。")).toBeVisible({ timeout: 15_000 });

    // 画面にも返信と添付が反映される
    await expect(page.getByText(replyText)).toBeVisible();
    await expect(page.getByText("QA6-evidence.pdf")).toBeVisible();

    // DB検証: CaseMessage(senderSide=snc, 添付あり)
    const msg = await db().caseMessage.findFirst({
      where: { caseId: c.id, body: replyText },
    });
    expect(msg).not.toBeNull();
    expect(msg!.senderSide).toBe("snc");
    const files = msg!.fileIds as { id: string; name: string }[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("QA6-evidence.pdf");

    // DB検証: R7へ返信通知（要件9-2②）
    const notif = await db().notification.findFirst({
      where: {
        account: { loginId: ACCOUNTS.R7.loginId },
        title: `ホットライン窓口から返信がありました（${c.caseNo}）`,
      },
    });
    expect(notif).not.toBeNull();
    expect(notif!.link).toBe(`/agency-cases/${c.id}`);
  });

  test("R5返信の添付は既定20MBまで受け付ける（§3.8。5MBの添付が保存されること）", async ({ page }) => {
    // 仕様§3.8: アップロード上限は既定20MB（環境変数で変更可）。
    // 既知の不一致: アプリはUI表記・コードとも4MB上限、さらにNext server actionsの
    // 既定bodySizeLimit(1MB)未調整のため約1MB超は「エラー表示なし」で暗黙に失敗する。
    // 期待値は仕様どおりとし、失敗はバグとして報告する。
    const c = await mkCase({ title: `${RUN}-size 添付上限テスト案件` });
    const replyText = `${RUN} 5MB添付付きの返信`;

    await login(page, "R5");
    await page.goto(`/hotline/${c.id}`);
    await page.locator('input[type="file"][name="files"]').setInputFiles({
      name: "QA6-large.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.alloc(5 * 1024 * 1024, 0x61),
    });
    await page.locator('textarea[name="body"]').fill(replyText);
    await page.getByRole("button", { name: "返信を送信" }).click();

    // 仕様期待: 20MB以下なので受理される
    await expect(page.getByText("返信を送信しました。")).toBeVisible({ timeout: 15_000 });
    const msg = await db().caseMessage.findFirst({
      where: { caseId: c.id, body: replyText },
    });
    expect(msg).not.toBeNull();
    const files = msg!.fileIds as { id: string; name: string }[];
    expect(files).toHaveLength(1);
  });

  test("R5ステータス変更→CaseStatusHistoryに記録され画面に履歴表示", async ({ page }) => {
    const c = await mkCase({ title: `${RUN}-status ステータス変更テスト案件` });

    await login(page, "R5");
    await page.goto(`/hotline/${c.id}`);
    await expect(page.getByRole("heading", { name: "ステータス変更履歴" })).toBeVisible();
    await expect(page.getByText("ステータス変更履歴はありません。")).toBeVisible();

    await page.locator('select[name="status"]').selectOption("対応中");
    await page.getByRole("button", { name: "ステータス変更" }).click();

    // 履歴が画面に表示される（未対応 → 対応中（変更者名））
    const historyItem = page.locator("li", { hasText: "（ホットライン 窓口担当）" });
    await expect(historyItem).toBeVisible({ timeout: 15_000 });
    await expect(historyItem.getByText("未対応")).toBeVisible();
    await expect(historyItem.getByText("対応中")).toBeVisible();

    // DB検証: Case.status更新 + CaseStatusHistory記録（要件9-4）
    await expect
      .poll(async () => (await db().case.findUnique({ where: { id: c.id } }))!.status)
      .toBe("対応中");
    const hist = await db().caseStatusHistory.findFirst({ where: { caseId: c.id } });
    expect(hist).not.toBeNull();
    expect(hist!.fromStatus).toBe("未対応");
    expect(hist!.toStatus).toBe("対応中");
    expect(hist!.changedBy).toBe("ホットライン 窓口担当");
  });

  test("R5緊急アラート→R3全員+当該R7にNotification（要件9-2③）", async ({ page }) => {
    const c = await mkCase({ title: `${RUN}-alert 緊急アラートテスト案件` });
    const alertTitle = `【緊急アラート】${c.caseNo} の対応をお願いします`;

    await login(page, "R5");
    await page.goto(`/hotline/${c.id}`);
    await page.getByRole("button", { name: "緊急アラート" }).click();

    // R3（アクティブ全員）に通知が作成される
    const r3Accounts = await db().account.findMany({
      where: { role: "R3", status: "active" },
      select: { id: true, loginId: true },
    });
    expect(r3Accounts.length).toBeGreaterThan(0);
    for (const acc of r3Accounts) {
      await expect
        .poll(
          async () =>
            db().notification.count({
              where: { accountId: acc.id, title: alertTitle },
            }),
          { timeout: 15_000 }
        )
        .toBeGreaterThan(0);
    }

    // 当該1次店のR7にも通知
    const r7Notif = await db().notification.findFirst({
      where: { account: { loginId: ACCOUNTS.R7.loginId }, title: alertTitle },
    });
    expect(r7Notif).not.toBeNull();
    expect(r7Notif!.link).toBe(`/agency-cases/${c.id}`);
  });

  test("存在しないID・系列違いIDの詳細アクセスは404", async ({ page }) => {
    await login(page, "R5");

    // 存在しないID
    const resp1 = await page.goto("/hotline/qa6-not-exist-id");
    expect(resp1!.status()).toBe(404);

    // CSC案件のIDを/hotline配下で開く → 404（series不一致）
    const csc = await db().case.findUnique({ where: { caseNo: "CSC-1000000000001" } });
    expect(csc).not.toBeNull();
    const resp2 = await page.goto(`/hotline/${csc!.id}`);
    expect(resp2!.status()).toBe(404);
  });
});

test.describe("§7.9 消費者センター窓口（SNC側）", () => {
  test("R6新規依頼: 起票するとCSC-接頭辞・series=CSCで作成される", async ({ page }) => {
    const isp = `${RUN}-csc1`;
    const expectedTitle = `代理店確認依頼／東都ネットワーク販売株式会社／${isp}`;

    await login(page, "R6");
    await page.goto("/consumer-center?new=1");
    await expect(page.getByText("新規依頼の起票")).toBeVisible();

    await page.locator('select[name="templateKind"]').selectOption("代理店確認依頼");
    // 「代理店確認依頼」の雛形は ■確認内容
    const body = await page.locator('textarea[name="body"]').inputValue();
    expect(body).toContain("■依頼理由");
    expect(body).toContain("■確認内容");
    expect(body).toContain("■顧客情報");

    await page.locator('select[name="primaryAgencyId"]').selectOption({
      label: "110001 東都ネットワーク販売株式会社",
    });
    await page.locator('input[name="ispNumber"]').fill(isp);
    await expect(page.locator('input[name="title"]')).toHaveValue(expectedTitle);
    await page.locator('input[name="deadline"]').fill(jstDate(5));
    await page.getByRole("button", { name: "起票する" }).click();
    await page.waitForURL(/\/consumer-center\/[a-z0-9]+$/, { timeout: 15_000 });

    const created = await db().case.findFirst({ where: { ispNumber: isp } });
    expect(created).not.toBeNull();
    expect(created!.series).toBe("CSC");
    expect(created!.caseNo).toMatch(/^CSC-/);

    // R7へ通知（CSC側も同様）
    const notif = await db().notification.findFirst({
      where: {
        account: { loginId: ACCOUNTS.R7.loginId },
        title: "消費者センター窓口から新規依頼が届きました",
        body: { contains: created!.caseNo },
      },
    });
    expect(notif).not.toBeNull();
  });
});
