// §7.7 お知らせ・情報周知 / §7.12 ドキュメント / /files/[id] ダウンロード
// データプレフィクス: QA7
import { test, expect } from "@playwright/test";
import {
  ACCOUNTS,
  db,
  login,
  collectConsoleErrors,
  criticalErrors,
} from "./helpers";

const T_ALL = "QA7-全体向けお知らせ（添付付き）";
const T_PRIMARY = "QA7-1次店向けお知らせ";
const T_IMPORTANT = "QA7-重要お知らせ（既読管理）";
const T_STOP = "QA7-停止対象お知らせ";
const T_DEL = "QA7-削除対象お知らせ";
const ATTACH_NAME = "QA7-attach.txt";
const ATTACH_CONTENT = "QA7 announcement attachment content v1";

const DOC_ALL = "QA7-doc-全体公開マニュアル";
const DOC_PRIMARY = "QA7-doc-1次店向け通知";
const DOC_SNC = "QA7-doc-SNC内限定資料";
const DOC_DEL = "QA7-doc-削除対象資料";
const DOC_ALL_CONTENT = "QA7 document content (visibility=all) v1";

async function accountIdOf(loginId: string): Promise<string> {
  const acc = await db().account.findUnique({ where: { loginId } });
  expect(acc, `account ${loginId} がシードに存在すること`).not.toBeNull();
  return acc!.id;
}

async function cleanupQA7() {
  const d = db();
  // お知らせ（AnnouncementRead はFKカスケードで削除される）
  await d.announcement.deleteMany({ where: { title: { startsWith: "QA7" } } });
  await d.notification.deleteMany({ where: { title: { contains: "QA7" } } });
  // ドキュメント + 添付実体
  const docs = await d.document.findMany({ where: { title: { startsWith: "QA7" } } });
  await d.document.deleteMany({ where: { title: { startsWith: "QA7" } } });
  if (docs.length > 0) {
    await d.storedFile.deleteMany({ where: { id: { in: docs.map((x) => x.fileId) } } });
  }
  await d.storedFile.deleteMany({ where: { name: { startsWith: "QA7" } } });
}

test.beforeAll(async () => {
  await cleanupQA7();
});

test.afterAll(async () => {
  await cleanupQA7();
  await db().$disconnect();
});

// ─────────────────────────────────────────────────────────────
// §7.7 お知らせ
// ─────────────────────────────────────────────────────────────

test("お知らせ: R3が全体向け（添付付き）を作成 → DB保存・R7/R8/R9へ通知・R8/R9の一覧に表示", async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectConsoleErrors(page);

  await login(page, "R3");
  await page.goto("/announcements");
  await expect(page.getByRole("heading", { name: "お知らせ・情報周知" })).toBeVisible();

  await page.locator('select[name="audience"]').selectOption("all");
  await page.locator('input[name="title"]').fill(T_ALL);
  await page.locator('textarea[name="body"]').fill("QA7テスト本文です。\n全体向けに周知します。");
  await page.locator('input[name="files"]').setInputFiles({
    name: ATTACH_NAME,
    mimeType: "text/plain",
    buffer: Buffer.from(ATTACH_CONTENT),
  });
  await page.getByRole("button", { name: "作成して送信" }).click();
  await expect(page.getByText("お知らせを送信しました")).toBeVisible({ timeout: 15_000 });

  // DB: お知らせ本体
  const ann = await db().announcement.findFirst({ where: { title: T_ALL } });
  expect(ann).not.toBeNull();
  expect(ann!.audience).toBe("all");
  expect(ann!.status).toBe("sent");
  expect(ann!.important).toBe(false);
  expect(ann!.sentAt).not.toBeNull();
  expect(ann!.createdBy).toBe(ACCOUNTS.R3.loginId);
  const files = ann!.fileIds as unknown as { id: string; name: string }[];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe(ATTACH_NAME);

  // DB: 添付実体
  const stored = await db().storedFile.findUnique({ where: { id: files[0].id } });
  expect(stored).not.toBeNull();
  expect(Buffer.from(stored!.data).toString()).toBe(ATTACH_CONTENT);

  // DB: R7/R8/R9 に Notification（§7.7 送信時にアプリ内通知）
  for (const role of ["R7", "R8", "R9"] as const) {
    const accId = await accountIdOf(ACCOUNTS[role].loginId);
    const n = await db().notification.findFirst({
      where: { accountId: accId, link: `/announcements/${ann!.id}` },
    });
    expect(n, `${role}(${ACCOUNTS[role].loginId}) に通知が届くこと`).not.toBeNull();
    expect(n!.title).toBe(`お知らせ: ${T_ALL}`);
  }

  // R8 の一覧に表示
  await login(page, "R8");
  await page.goto("/announcements");
  await expect(page.getByRole("link", { name: T_ALL })).toBeVisible();

  // R9 の一覧に表示 + 詳細に添付リンク
  await login(page, "R9");
  await page.goto("/announcements");
  await expect(page.getByRole("link", { name: T_ALL })).toBeVisible();
  await page.getByRole("link", { name: T_ALL }).click();
  await page.waitForURL(`**/announcements/${ann!.id}`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: T_ALL })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(ATTACH_NAME) })).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

test("お知らせ: R3が1次店向けを作成 → R7に表示・R8/R9には非表示・通知は⑦のみ", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R3");
  await page.goto("/announcements");
  await page.locator('select[name="audience"]').selectOption("primary");
  await page.locator('input[name="title"]').fill(T_PRIMARY);
  await page.locator('textarea[name="body"]').fill("QA7: 1次店の管理者のみに周知する内容です。");
  await page.getByRole("button", { name: "作成して送信" }).click();
  await expect(page.getByText("お知らせを送信しました")).toBeVisible({ timeout: 15_000 });

  const ann = await db().announcement.findFirst({ where: { title: T_PRIMARY } });
  expect(ann).not.toBeNull();
  expect(ann!.audience).toBe("primary");

  // 通知: R7 にはあり、R8/R9 にはない
  const r7Id = await accountIdOf(ACCOUNTS.R7.loginId);
  const r8Id = await accountIdOf(ACCOUNTS.R8.loginId);
  const r9Id = await accountIdOf(ACCOUNTS.R9.loginId);
  const nR7 = await db().notification.findFirst({
    where: { accountId: r7Id, link: `/announcements/${ann!.id}` },
  });
  expect(nR7, "R7に通知が届くこと").not.toBeNull();
  const nOthers = await db().notification.count({
    where: { accountId: { in: [r8Id, r9Id] }, link: `/announcements/${ann!.id}` },
  });
  expect(nOthers, "R8/R9には通知されないこと").toBe(0);

  // R7 の一覧に表示（1次店向けバッジ付き）
  await login(page, "R7");
  await page.goto("/announcements");
  const r7Item = page.locator("li", { hasText: T_PRIMARY });
  await expect(r7Item).toBeVisible();
  await expect(r7Item.locator("span", { hasText: /^1次店向け$/ })).toBeVisible();

  // R8 の一覧に非表示 + 直接URLはリダイレクト
  await login(page, "R8");
  await page.goto("/announcements");
  await expect(page.getByText(T_PRIMARY)).toHaveCount(0);
  await page.goto(`/announcements/${ann!.id}`);
  await page.waitForURL(/\/announcements$/, { timeout: 15_000 });
  await expect(page.getByText(T_PRIMARY)).toHaveCount(0);

  // R9 の一覧に非表示 + 直接URLはリダイレクト
  await login(page, "R9");
  await page.goto("/announcements");
  await expect(page.getByText(T_PRIMARY)).toHaveCount(0);
  await page.goto(`/announcements/${ann!.id}`);
  await page.waitForURL(/\/announcements$/, { timeout: 15_000 });
  await expect(page.getByText(T_PRIMARY)).toHaveCount(0);
});

test("お知らせ: 重要フラグ → 一覧上部ピン+重要バッジ、R9閲覧でAnnouncementRead記録、R3側で既読率・未読者確認", async ({ page }) => {
  test.setTimeout(120_000);
  // R3: 重要フラグ付きで作成
  await login(page, "R3");
  await page.goto("/announcements");
  await page.locator('select[name="audience"]').selectOption("all");
  await page.locator('input[name="important"]').check();
  await page.locator('input[name="title"]').fill(T_IMPORTANT);
  await page.locator('textarea[name="body"]').fill("QA7: 重要なお知らせです。必ず確認してください。");
  await page.getByRole("button", { name: "作成して送信" }).click();
  await expect(page.getByText("お知らせを送信しました")).toBeVisible({ timeout: 15_000 });

  const ann = await db().announcement.findFirst({ where: { title: T_IMPORTANT } });
  expect(ann).not.toBeNull();
  expect(ann!.important).toBe(true);

  // R9: 一覧の最上部にピン + 重要バッジ
  await login(page, "R9");
  await page.goto("/announcements");
  const firstItem = page.locator("ul.divide-y > li").first();
  await expect(firstItem.getByRole("link", { name: T_IMPORTANT })).toBeVisible();
  await expect(firstItem.getByText("重要", { exact: true })).toBeVisible();

  // R9: 詳細を開く → AnnouncementRead が記録される
  await firstItem.getByRole("link", { name: T_IMPORTANT }).click();
  await page.waitForURL(`**/announcements/${ann!.id}`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: T_IMPORTANT })).toBeVisible();
  const r9Id = await accountIdOf(ACCOUNTS.R9.loginId);
  await expect
    .poll(
      async () =>
        db().announcementRead.count({
          where: { announcementId: ann!.id, accountId: r9Id },
        }),
      { timeout: 10_000 }
    )
    .toBe(1);

  // R3: 管理側一覧でも重要は上部ピン + 既読率・未読者一覧を確認
  await login(page, "R3");
  await page.goto("/announcements");
  const firstRow = page.locator("tbody > tr").first();
  await expect(firstRow.getByRole("link", { name: T_IMPORTANT })).toBeVisible();
  await expect(firstRow.getByText("重要", { exact: true })).toBeVisible();

  const readCell = firstRow.locator("td").nth(4);
  const readText = (await readCell.innerText()).replace(/\s+/g, " ");
  const m = readText.match(/(\d+) \/ (\d+)/);
  expect(m, `既読率セルに「n / m」形式の表示があること: ${readText}`).not.toBeNull();
  const readCount = Number(m![1]);
  const targetCount = Number(m![2]);
  expect(readCount).toBeGreaterThanOrEqual(1); // R9が既読
  expect(targetCount).toBeGreaterThanOrEqual(3); // ⑦⑧⑨が母数に入っている

  // 未読者一覧: R9(110001C001)は含まれず、未読のR8(airis_2210001_001)は含まれる
  await firstRow.locator("summary", { hasText: "未読者一覧" }).click();
  await expect(firstRow.getByText(ACCOUNTS.R8.loginId)).toBeVisible();
  await expect(firstRow.getByText(ACCOUNTS.R9.loginId)).toHaveCount(0);
});

test("お知らせ: 停止/削除 → 閲覧側から消える（停止=リダイレクト、削除=404）", async ({ page }) => {
  test.setTimeout(120_000);
  // 準備: DB直接で2件作成（自己完結）
  const d = db();
  const annStop = await d.announcement.create({
    data: { audience: "all", title: T_STOP, body: "QA7 停止テスト", status: "sent", sentAt: new Date(), createdBy: ACCOUNTS.R3.loginId },
  });
  const annDel = await d.announcement.create({
    data: { audience: "all", title: T_DEL, body: "QA7 削除テスト", status: "sent", sentAt: new Date(), createdBy: ACCOUNTS.R3.loginId },
  });

  // R9: 両方見える
  await login(page, "R9");
  await page.goto("/announcements");
  await expect(page.getByRole("link", { name: T_STOP })).toBeVisible();
  await expect(page.getByRole("link", { name: T_DEL })).toBeVisible();

  // R3: 停止
  await login(page, "R3");
  await page.goto("/announcements");
  const stopRow = page.locator("tbody > tr", { hasText: T_STOP });
  await stopRow.getByRole("button", { name: "停止" }).click();
  await expect(stopRow.getByRole("button", { name: "停止" })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await d.announcement.findUnique({ where: { id: annStop.id } }))?.status, { timeout: 10_000 })
    .toBe("stopped");

  // R3: 削除（論理削除 → 管理一覧からも消える）
  const delRow = page.locator("tbody > tr", { hasText: T_DEL });
  await delRow.getByRole("button", { name: "削除" }).click();
  await expect(page.locator("tbody > tr", { hasText: T_DEL })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => (await d.announcement.findUnique({ where: { id: annDel.id } }))?.status, { timeout: 10_000 })
    .toBe("deleted");

  // R9: 一覧から両方消えている
  await login(page, "R9");
  await page.goto("/announcements");
  await expect(page.getByText(T_STOP)).toHaveCount(0);
  await expect(page.getByText(T_DEL)).toHaveCount(0);

  // 停止 → 詳細直接アクセスは一覧へリダイレクト
  await page.goto(`/announcements/${annStop.id}`);
  await page.waitForURL(/\/announcements$/, { timeout: 15_000 });

  // 削除済 → 詳細直接アクセスは404
  const res = await page.goto(`/announcements/${annDel.id}`);
  expect(res!.status()).toBe(404);
});

test("お知らせ 異常系: 必須未入力（空白のみ）はエラー、存在しないIDは404、R5はページアクセス不可", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "R3");
  await page.goto("/announcements");

  // タイトル空白のみ → エラー
  await page.locator('input[name="title"]').fill("   ");
  await page.locator('textarea[name="body"]').fill("本文あり");
  await page.getByRole("button", { name: "作成して送信" }).click();
  await expect(page.getByText("タイトルを入力してください")).toBeVisible({ timeout: 15_000 });

  // 本文空白のみ → エラー
  await page.locator('input[name="title"]').fill("QA7-バリデーション確認");
  await page.locator('textarea[name="body"]').fill("   ");
  await page.getByRole("button", { name: "作成して送信" }).click();
  await expect(page.getByText("本文を入力してください")).toBeVisible({ timeout: 15_000 });
  expect(await db().announcement.count({ where: { title: "QA7-バリデーション確認" } })).toBe(0);

  // 存在しないID → 404
  const res = await page.goto("/announcements/qa7-not-exist-id");
  expect(res!.status()).toBe(404);

  // R5（HL窓口）はお知らせページにアクセス不可（§5.2 お知らせ ⑤=×）→ ダッシュボードへ
  await login(page, "R5");
  await page.goto("/announcements");
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
  // サイドメニューにも「お知らせ」が出ない
  await expect(page.locator("aside nav").getByText("お知らせ")).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────
// §7.12 ドキュメント
// ─────────────────────────────────────────────────────────────

test("ドキュメント: R2がsnc/primary/all各1件アップロード → ロール別可視性（R9=all, R7=all+primary, R5=all+snc, R3=全部）", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsoleErrors(page);

  await login(page, "R2");
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "ドキュメント", exact: true })).toBeVisible();
  await expect(page.getByText("ドキュメントアップロード（SNCのみ）")).toBeVisible();

  const uploads: [string, string, string][] = [
    // [title, visibility, content]
    [DOC_ALL, "all", DOC_ALL_CONTENT],
    [DOC_PRIMARY, "primary", "QA7 primary-only content"],
    [DOC_SNC, "snc", "QA7 snc-only content"],
  ];
  for (const [title, visibility, content] of uploads) {
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="category"]').fill("QA7カテゴリ");
    await page.locator('select[name="visibility"]').selectOption(visibility);
    await page.locator('input[name="file"]').setInputFiles({
      name: `QA7-${visibility}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(content),
    });
    await page.getByRole("button", { name: "アップロード" }).click();
    await expect(page.getByText(`「${title}」を登録しました`)).toBeVisible({ timeout: 15_000 });
  }

  // DB検証
  const d = db();
  for (const [title, visibility] of uploads) {
    const doc = await d.document.findFirst({ where: { title } });
    expect(doc, `${title} がDBに保存されること`).not.toBeNull();
    expect(doc!.visibility).toBe(visibility);
    expect(doc!.createdBy).toBe(ACCOUNTS.R2.loginId);
    const file = await d.storedFile.findUnique({ where: { id: doc!.fileId } });
    expect(file).not.toBeNull();
  }

  // R2（アップロード直後の一覧）: 3件とも表示 + 削除ボタンあり
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_ALL)).toBeVisible();
  await expect(page.getByText(DOC_PRIMARY)).toBeVisible();
  await expect(page.getByText(DOC_SNC)).toBeVisible();

  // R9: all のみ
  await login(page, "R9");
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_ALL)).toBeVisible();
  await expect(page.getByText(DOC_PRIMARY)).toHaveCount(0);
  await expect(page.getByText(DOC_SNC)).toHaveCount(0);

  // R7: all + primary（sncは見えない）
  await login(page, "R7");
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_ALL)).toBeVisible();
  await expect(page.getByText(DOC_PRIMARY)).toBeVisible();
  await expect(page.getByText(DOC_SNC)).toHaveCount(0);

  // R5: all + snc（primaryは見えない）
  await login(page, "R5");
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_ALL)).toBeVisible();
  await expect(page.getByText(DOC_SNC)).toBeVisible();
  await expect(page.getByText(DOC_PRIMARY)).toHaveCount(0);

  // R3: 全部
  await login(page, "R3");
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_ALL)).toBeVisible();
  await expect(page.getByText(DOC_PRIMARY)).toBeVisible();
  await expect(page.getByText(DOC_SNC)).toBeVisible();

  expect(criticalErrors(errors)).toEqual([]);
});

test("ドキュメント: 削除はSNCのみ（R7にアップロード・削除UIが出ない / R2で削除するとDBから消える）", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  // 準備: 削除対象ドキュメントをDB直接で作成（自己完結）
  const stored = await d.storedFile.create({
    data: { name: "QA7-del.txt", mime: "text/plain", size: 10, data: Buffer.from("QA7 delete"), uploadedBy: null },
  });
  const doc = await d.document.create({
    data: { title: DOC_DEL, category: "QA7カテゴリ", visibility: "all", fileId: stored.id, fileName: stored.name, createdBy: ACCOUNTS.R2.loginId },
  });

  // R7: アップロードフォームなし・削除ボタンなし（閲覧のみ）
  await login(page, "R7");
  await page.goto("/documents?q=QA7-doc");
  await expect(page.getByText(DOC_DEL)).toBeVisible();
  await expect(page.getByText("ドキュメントアップロード（SNCのみ）")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "削除" })).toHaveCount(0);

  // R2: 削除ボタンで削除 → UI・DBから消える（添付実体も削除）
  await login(page, "R2");
  await page.goto(`/documents?q=${encodeURIComponent(DOC_DEL)}`);
  const row = page.locator("tbody > tr", { hasText: DOC_DEL });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "削除" }).click();
  await expect(page.locator("tbody > tr", { hasText: DOC_DEL })).toHaveCount(0, { timeout: 15_000 });
  await expect
    .poll(async () => d.document.count({ where: { id: doc.id } }), { timeout: 10_000 })
    .toBe(0);
  expect(await d.storedFile.count({ where: { id: stored.id } })).toBe(0);
});

test("R4ダミー表示: お知らせ・ドキュメントも偽データのみ表示され実データは見えない（§3.5/§5.2）", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  // 実データ（非ダミー）としてお知らせ2件・全体公開ドキュメント1件を用意
  const annAll = await d.announcement.create({
    data: { audience: "all", title: "QA7-実データお知らせ（R4非表示確認）", body: "実データ", status: "sent", sentAt: new Date(), createdBy: ACCOUNTS.R3.loginId },
  });
  const annPrimary = await d.announcement.create({
    data: { audience: "primary", title: "QA7-実データ1次店向け（R4非表示確認）", body: "実データ", status: "sent", sentAt: new Date(), createdBy: ACCOUNTS.R3.loginId },
  });
  const stored = await d.storedFile.create({
    data: { name: "QA7-real.txt", mime: "text/plain", size: 8, data: Buffer.from("realdata"), uploadedBy: null },
  });
  const doc = await d.document.create({
    data: { title: "QA7-実データドキュメント（R4非表示確認）", visibility: "all", fileId: stored.id, fileName: stored.name, createdBy: ACCOUNTS.R2.loginId },
  });

  try {
    await login(page, "R4");

    // §3.5: ④のダミー表示ページは「シードで用意した架空データを表示し、実データへは一切アクセスさせない」
    // §5.2: お知らせ（全体向け/1次店向け）・ドキュメントはいずれも④=ダミー表示
    await page.goto("/announcements");
    await expect(
      page.getByText("QA7-実データお知らせ（R4非表示確認）"),
      "④ダミー表示では実データのお知らせ（全体向け）は表示されないこと（§3.5）"
    ).toHaveCount(0);
    await expect(
      page.getByText("QA7-実データ1次店向け（R4非表示確認）"),
      "④ダミー表示では実データのお知らせ（1次店向け）は表示されないこと（§3.5）"
    ).toHaveCount(0);

    await page.goto("/documents");
    await expect(
      page.getByText("QA7-実データドキュメント（R4非表示確認）"),
      "④ダミー表示では実データのドキュメントは表示されないこと（§3.5）"
    ).toHaveCount(0);
  } finally {
    await d.announcement.deleteMany({ where: { id: { in: [annAll.id, annPrimary.id] } } });
    await d.document.deleteMany({ where: { id: doc.id } });
    await d.storedFile.deleteMany({ where: { id: stored.id } });
  }
});

test("ファイルダウンロード /files/[id]: ログイン時200+内容一致+監査ログ、未ログイン401、存在しないID404", async ({ page, request }) => {
  test.setTimeout(120_000);
  const d = db();
  // 準備: 公開範囲allのドキュメント（DB直接作成で自己完結）
  const content = "QA7 download check content 12345";
  const stored = await d.storedFile.create({
    data: { name: "QA7-download.txt", mime: "text/plain", size: content.length, data: Buffer.from(content), uploadedBy: null },
  });

  try {
    // 未ログイン → 401（Playwrightのrequestフィクスチャはクッキー無し）
    const anon = await request.get(`/files/${stored.id}`);
    expect(anon.status()).toBe(401);

    // R9ログイン済みコンテキスト → 200 + 内容一致
    await login(page, "R9");
    const ok = await page.request.get(`/files/${stored.id}`);
    expect(ok.status()).toBe(200);
    expect(await ok.text()).toBe(content);
    expect(ok.headers()["content-type"]).toContain("text/plain");
    expect(ok.headers()["content-disposition"]).toContain("attachment");

    // 監査ログにダウンロード記録（§3.3 / §7.12）
    const log = await d.auditLog.findFirst({
      where: { actor: ACCOUNTS.R9.loginId, action: "file_download", target: { contains: stored.id } },
    });
    expect(log, "file_download の監査ログが残ること").not.toBeNull();

    // 存在しないファイルID → 404（ログイン済み）
    const nf = await page.request.get("/files/qa7-not-exist-file");
    expect(nf.status()).toBe(404);
  } finally {
    await d.storedFile.deleteMany({ where: { id: stored.id } });
  }
});
