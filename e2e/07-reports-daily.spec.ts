// QA5: 各種資料の提出 — 稼働日報（SPEC §7.5, 要件6-1/6-2/6-3）
// 対象: /reports（稼働日報タブ・集計・実績確認タブ・CSVテンプレ/アップロード・モバイル）
import { test, expect, type Page } from "@playwright/test";
import { login, db, collectConsoleErrors, criticalErrors } from "./helpers";

// JST基準の当月（アプリの today() と同一ロジック）
const MONTH = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
const D_OVERWRITE = `${MONTH}-19`;
const D_KPI = `${MONTH}-20`;
const D_MOBILE = `${MONTH}-22`;
const D_CSV1 = `${MONTH}-23`;
const D_CSV2 = `${MONTH}-24`;
const D_CSV_BAD = `${MONTH}-25`;
const D_TELE = `${MONTH}-26`;
// 月初見込テスト用: 他データと衝突しない遠い月（6月=30日）
const M_FC = "2027-06";
const D_FC1 = `${M_FC}-19`;
const D_FC2 = `${M_FC}-20`;
// CSV経由の月初見込ロック検証用（要件6-3 / BUG-007の回帰）
const M_CSV_FC = "2027-08"; // フォームで確定済みの見込をCSVが上書きしないことの検証
const D_CFC1 = `${M_CSV_FC}-10`;
const D_CFC2 = `${M_CSV_FC}-11`;
const M_CSV_ONLY = "2027-09"; // CSVのみで月内複数行に見込がある場合
const D_CO1 = `${M_CSV_ONLY}-10`;
const D_CO2 = `${M_CSV_ONLY}-11`;
const D_CO3 = `${M_CSV_ONLY}-12`;
// 稼働提出物の通知宛先スコープ検証用（§3.7 / §5.1）
const M_SUB_NOTIFY = "2032-04"; // 他スイートの集計に影響しない遠い月
const SUB_KIND_NOTIFY = "環境ヒアリングシート";
const SUB_MEMO_NOTIFY = "QA5-通知宛先スコープ";

const VISIT_HEADERS =
  "日付,販売員ID,エリア,獲得見込,獲得,稼働数,訪問数,対面数,商談数,成約数,活動実施内容,活動実施結果,備考";
const TELE_HEADERS =
  "日付,販売員ID,エリア,稼働時間(月初見込),エントリー数(月初見込),稼働時間(実績),エントリー数(実績),アポ数(実績),クローズ通過数,前確通過数(実績),活動実施内容,活動実施結果,備考";

const KPI_LABELS_12 = [
  "生産性",
  "進捗",
  "達成率",
  "着地予想",
  "着地差分",
  "ペースメーカー",
  "対面率",
  "商談率",
  "成約率",
  "訪問/日",
  "対面/日",
  "商談/日",
];

let staffId = "";

test.beforeAll(async () => {
  const staff = await db().salesStaff.findUnique({ where: { salesId: "110001C001" } });
  if (!staff) throw new Error("シード販売員 110001C001 が見つかりません");
  staffId = staff.id;
  // 自スイート（QA5プレフィクス）の過去データを掃除して自己完結にする
  await db().dailyReport.deleteMany({
    where: {
      OR: [
        { area: { startsWith: "QA5" } },
        { activityContent: { startsWith: "QA5" } },
      ],
    },
  });
  // 月初見込ロック検証で使う月は「月内に見込が1件も無い」状態から開始する
  await db().dailyReport.deleteMany({
    where: {
      salesStaffId: staffId,
      OR: [M_FC, M_CSV_FC, M_CSV_ONLY].map((m) => ({ date: { startsWith: m } })),
    },
  });
  await db().submission.deleteMany({ where: { memo: SUB_MEMO_NOTIFY } });
});

test.afterAll(async () => {
  await db().submission.deleteMany({ where: { memo: SUB_MEMO_NOTIFY } });
  await db().$disconnect();
});

// 月内の日報を日付昇順で [日付, 月初見込] のペアにして返す（月初見込ロックのDB検証用）
async function monthForecastPairs(
  month: string,
  type: "訪販" | "テレマ" = "訪販"
): Promise<[string, number | null][]> {
  const rows = await db().dailyReport.findMany({
    where: { salesStaffId: staffId, type, date: { startsWith: month } },
    orderBy: { date: "asc" },
    select: { date: true, forecastAcq: true },
  });
  return rows.map((r) => [r.date, r.forecastAcq]);
}

async function uploadVisitCsv(page: Page, fileName: string, lines: string[]) {
  await page.locator('select[name="csvType"]').selectOption("訪販");
  await page.setInputFiles('input[name="file"]', {
    name: fileName,
    mimeType: "text/csv",
    buffer: Buffer.from("﻿" + [VISIT_HEADERS, ...lines].join("\r\n"), "utf-8"),
  });
  await page.getByRole("button", { name: "CSVアップロード" }).click();
}

async function saveVisitReport(
  page: Page,
  date: string,
  values: Record<string, string>,
  texts: { area?: string; activityContent?: string; activityResult?: string; notes?: string }
) {
  await page.fill('input[name="date"]', date);
  for (const [name, v] of Object.entries(values)) {
    await page.fill(`input[name="${name}"]`, v);
  }
  if (texts.area !== undefined) await page.fill('input[name="area"]', texts.area);
  if (texts.activityContent !== undefined)
    await page.fill('textarea[name="activityContent"]', texts.activityContent);
  if (texts.activityResult !== undefined)
    await page.fill('textarea[name="activityResult"]', texts.activityResult);
  if (texts.notes !== undefined) await page.fill('textarea[name="notes"]', texts.notes);
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${date} の訪販日報を保存しました`)).toBeVisible({
    timeout: 15_000,
  });
}

test("R9: /reports で稼働提出物タブが表示されず、販売員IDが自分固定（コンソールエラー0）", async ({
  page,
}) => {
  const errors = collectConsoleErrors(page);
  await login(page, "R9");
  await page.goto("/reports");
  await expect(page.getByText("日報・稼働提出物")).toBeVisible();

  // タブは「稼働日報」「集計・実績確認」の2つのみ（§5.2: ⑨は稼働提出物=×）
  const tabLinks = page.locator('a[href^="/reports?tab="]');
  await expect(tabLinks).toHaveCount(2);
  await expect(page.getByRole("link", { name: "稼働日報" })).toBeVisible();
  await expect(page.getByRole("link", { name: "集計・実績確認" })).toBeVisible();
  await expect(page.getByRole("link", { name: "稼働提出物" })).toHaveCount(0);

  // 販売員IDは自分固定（セレクトなし・自分のIDが固定表示）
  await expect(page.locator('select[name="salesStaffId"]')).toHaveCount(0);
  await expect(page.getByText("110001C001 営業太郎")).toBeVisible();

  // URL直接指定でも稼働提出物タブは開けない（dailyへ強制）
  await page.goto("/reports?tab=submissions");
  await expect(page.getByText("日報入力")).toBeVisible();
  await expect(page.getByText("提出フォーム")).toHaveCount(0);
  await expect(page.getByText("提出用テンプレート（様式ダウンロード）")).toHaveCount(0);

  expect(criticalErrors(errors)).toEqual([]);
});

test("R9: 訪販日報の保存→DB検証→同日再提出で上書き（レコード数が増えない）", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page, "R9");
  await page.goto("/reports");

  const countBefore = await db().dailyReport.count({
    where: { salesStaffId: staffId, type: "訪販" },
  });

  // 1回目の提出
  await saveVisitReport(
    page,
    D_OVERWRITE,
    {
      forecastAcq: "30",
      acquisitions: "2",
      workers: "3",
      visits: "50",
      meetings: "20",
      negotiations: "10",
      contracts: "2",
    },
    {
      area: "QA5-東京都新宿区",
      activityContent: "QA5 戸建てエリアの巡回訪問",
      activityResult: "QA5 在宅率高め",
      notes: "QA5 備考1",
    }
  );

  // DB検証（保存値）
  const rec1 = await db().dailyReport.findUnique({
    where: { date_type_salesStaffId: { date: D_OVERWRITE, type: "訪販", salesStaffId: staffId } },
  });
  expect(rec1).not.toBeNull();
  // 当月はシード日報（${MONTH}-01, forecastAcq=30）が月初見込を確定済みのため、
  // 後日日付で送信した見込は保存されない（要件6-3「月の初回提出時のみ入力」/ BUG-007）。
  expect(rec1!.forecastAcq).toBeNull();
  expect(rec1!.acquisitions).toBe(2);
  expect(rec1!.workers).toBe(3);
  expect(rec1!.visits).toBe(50);
  expect(rec1!.meetings).toBe(20);
  expect(rec1!.negotiations).toBe(10);
  expect(rec1!.contracts).toBe(2);
  expect(rec1!.area).toBe("QA5-東京都新宿区");
  expect(rec1!.activityContent).toBe("QA5 戸建てエリアの巡回訪問");
  expect(rec1!.source).toBe("form");

  // 2回目: 同じ日付・タイプで再提出→上書き（要件6-1）
  await saveVisitReport(
    page,
    D_OVERWRITE,
    { acquisitions: "5", visits: "60" },
    { activityContent: "QA5 修正後の活動内容" }
  );
  await expect
    .poll(
      async () => {
        const r = await db().dailyReport.findUnique({
          where: {
            date_type_salesStaffId: { date: D_OVERWRITE, type: "訪販", salesStaffId: staffId },
          },
        });
        return r?.acquisitions;
      },
      { timeout: 10_000 }
    )
    .toBe(5);

  const rec2 = await db().dailyReport.findUnique({
    where: { date_type_salesStaffId: { date: D_OVERWRITE, type: "訪販", salesStaffId: staffId } },
  });
  expect(rec2!.visits).toBe(60);
  expect(rec2!.activityContent).toBe("QA5 修正後の活動内容");

  // レコード数は1回分しか増えていない（上書きの証明）
  const countAfter = await db().dailyReport.count({
    where: { salesStaffId: staffId, type: "訪販" },
  });
  expect(countAfter).toBe(countBefore + 1);
  expect(
    await db().dailyReport.count({
      where: { date: D_OVERWRITE, type: "訪販", salesStaffId: staffId },
    })
  ).toBe(1);

  // 月初見込は月内最古のレコードが保持し続ける（当月の見込は1つだけ 要件6-3）
  const holder = await db().dailyReport.findFirst({
    where: { salesStaffId: staffId, type: "訪販", date: { startsWith: MONTH }, forecastAcq: { not: null } },
    orderBy: { date: "asc" },
    select: { date: true, forecastAcq: true },
  });
  expect(holder).not.toBeNull();
  expect(holder!.date).toBe(`${MONTH}-01`);

  expect(criticalErrors(errors)).toEqual([]);
});

test("R9: 保存後にKPIタイル12個のラベルが表示される", async ({ page }) => {
  await login(page, "R9");
  await page.goto("/reports");
  await saveVisitReport(
    page,
    D_KPI,
    { acquisitions: "1", workers: "1", visits: "10", meetings: "5", negotiations: "2", contracts: "1" },
    { area: "QA5-KPI検証" }
  );

  await expect(page.getByText(`当月KPI（${MONTH} / 訪販）`)).toBeVisible();
  const tiles = page.locator("div.rounded-xl.bg-slate-50.text-center");
  await expect(tiles).toHaveCount(12);
  for (const label of KPI_LABELS_12) {
    await expect(tiles.getByText(label, { exact: true })).toHaveCount(1);
  }
});

test("R9: テレマ切替で入力項目が変わる（稼働時間/エントリー数/アポ数/クローズ通過数/前確通過数）", async ({
  page,
}) => {
  await login(page, "R9");
  await page.goto("/reports");

  // 初期は訪販項目
  await expect(page.getByText("獲得見込（月初見込）")).toBeVisible();
  await expect(page.getByText("訪問数", { exact: true })).toBeVisible();

  // テレマへ切替
  await page.getByRole("button", { name: "テレマ" }).click();
  await expect(page.getByText("稼働時間（月初見込）")).toBeVisible();
  await expect(page.getByText("エントリー数（月初見込）")).toBeVisible();
  await expect(page.getByText("稼働時間（実績）")).toBeVisible();
  await expect(page.getByText("エントリー数（実績）")).toBeVisible();
  await expect(page.getByText("アポ数（実績）")).toBeVisible();
  await expect(page.getByText("クローズ通過数")).toBeVisible();
  await expect(page.getByText("前確通過数（実績）")).toBeVisible();

  // 訪販専用項目は消える
  await expect(page.getByText("獲得見込（月初見込）")).toHaveCount(0);
  await expect(page.getByText("訪問数", { exact: true })).toHaveCount(0);
  await expect(page.getByText("対面数", { exact: true })).toHaveCount(0);

  // 訪販へ戻すと元に戻る
  await page.getByRole("button", { name: "訪販" }).click();
  await expect(page.getByText("獲得見込（月初見込）")).toBeVisible();
  await expect(page.getByText("クローズ通過数")).toHaveCount(0);
});

test("R9: テレマ日報の保存→DB検証（テレマ項目が保存される）", async ({ page }) => {
  await login(page, "R9");
  await page.goto("/reports");
  await page.getByRole("button", { name: "テレマ" }).click();

  await page.fill('input[name="date"]', D_TELE);
  await page.fill('input[name="forecastHours"]', "8.5");
  await page.fill('input[name="forecastEntries"]', "100");
  await page.fill('input[name="actualHours"]', "7.5");
  await page.fill('input[name="entries"]', "12");
  await page.fill('input[name="appointments"]', "3");
  await page.fill('input[name="closePassed"]', "2");
  await page.fill('input[name="preConfirmPassed"]', "1");
  await page.fill('input[name="area"]', "QA5-テレマ提出");
  await page.fill('textarea[name="activityContent"]', "QA5 既存リストへの架電");
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${D_TELE} のテレマ日報を保存しました`)).toBeVisible({
    timeout: 15_000,
  });

  const rec = await db().dailyReport.findUnique({
    where: { date_type_salesStaffId: { date: D_TELE, type: "テレマ", salesStaffId: staffId } },
  });
  expect(rec).not.toBeNull();
  // 当月のテレマ月初見込はシード日報（${MONTH}-02, 稼働時間160 / エントリー200）で確定済みのため、
  // 後日日付で送信した月初見込は保存されない（要件6-3 / BUG-007）。実績値は保存される。
  expect(rec!.forecastHours).toBeNull();
  expect(rec!.forecastEntries).toBeNull();
  expect(rec!.actualHours).toBe(7.5);
  expect(rec!.entries).toBe(12);
  expect(rec!.appointments).toBe(3);
  expect(rec!.closePassed).toBe(2);
  expect(rec!.preConfirmPassed).toBe(1);
  expect(rec!.area).toBe("QA5-テレマ提出");
  // 訪販項目は入っていない
  expect(rec!.acquisitions).toBeNull();
  expect(rec!.visits).toBeNull();
});

test("R9: テレマ日報保存後にテレマ専用KPI（アポ生産性・クローズ通過率・前確通過率）が表示される（§7.5）", async ({
  page,
}) => {
  // 仕様§7.5: テレマKPI = アポ生産性=アポ数/稼働時間、クローズ通過率、前確通過率、差分（見込vs実績）、残稼働。
  // §14-5のTODO対象は「獲得生産性」「後確通過率」のみで、上記5指標は計算式が仕様に明記されている。
  await login(page, "R9");
  await page.goto("/reports");
  await page.getByRole("button", { name: "テレマ" }).click();
  await page.fill('input[name="date"]', D_TELE);
  await page.fill('input[name="actualHours"]', "7.5");
  await page.fill('input[name="appointments"]', "3");
  await page.fill('input[name="closePassed"]', "2");
  await page.fill('input[name="preConfirmPassed"]', "1");
  await page.fill('input[name="area"]', "QA5-テレマKPI");
  await page.getByRole("button", { name: "日報を保存する" }).click();
  await expect(page.getByText(`${D_TELE} のテレマ日報を保存しました`)).toBeVisible({
    timeout: 15_000,
  });

  const tiles = page.locator("div.rounded-xl.bg-slate-50.text-center");
  await expect(tiles.getByText("アポ生産性", { exact: true })).toBeVisible();
  await expect(tiles.getByText("クローズ通過率", { exact: true })).toBeVisible();
  await expect(tiles.getByText("前確通過率", { exact: true })).toBeVisible();
});

test("R9: 訪販の月初見込は月の初回提出時のみ入力（2回目提出の見込入力は反映されない）（要件6-3/§13）", async ({
  page,
}) => {
  // 仕様: 獲得見込（月初見込）は「月の初回提出時のみ入力」。
  // 初回に30を設定→2回目に99を入力しても、当月の見込は30のまま（達成率 = 3/30 = 10%）が期待値。
  await login(page, "R9");
  await page.goto("/reports");

  // 初回提出（2027-06の最初の日報）: 見込30
  await saveVisitReport(
    page,
    D_FC1,
    { forecastAcq: "30", acquisitions: "2", workers: "1", visits: "10", meetings: "5", negotiations: "2", contracts: "1" },
    { area: "QA5-月初見込1" }
  );
  // 2回目提出: 見込99を入力（仕様上は受け付けない/無視されるべき）
  await saveVisitReport(
    page,
    D_FC2,
    { forecastAcq: "99", acquisitions: "1", workers: "1" },
    { area: "QA5-月初見込2" }
  );

  // 期待値（仕様どおり）: 月初見込=30が維持され、達成率 = (2+1)/30 = 10%
  const tiles = page.locator("div.rounded-xl.bg-slate-50.text-center");
  const rateTile = tiles.filter({ hasText: "達成率" });
  await expect(rateTile.locator("div").first()).toHaveText("10%");

  // DB検証: 月内で見込を保持するのは最古日付の1レコードのみ
  // （後日日付の見込は保存しない = 月内に見込は1つだけ 要件6-3 / BUG-007）
  expect(await monthForecastPairs(M_FC)).toEqual([
    [D_FC1, 30],
    [D_FC2, null],
  ]);
});

test("R9: CSV取込では確定済み月初見込が上書きされない（月内全行のforecastAcqをDB検証）（要件6-3 / BUG-007）", async ({
  page,
}) => {
  // 仕様: 月初見込は「月の初回提出時のみ入力」。取込経路（フォーム／CSV）に依らず、
  // 一度確定した月初見込はCSVの値で上書きされてはならない。
  test.setTimeout(120_000);
  await login(page, "R9");
  await page.goto("/reports");

  // 月の初回提出（フォーム）で月初見込=40を確定
  await saveVisitReport(
    page,
    D_CFC1,
    { forecastAcq: "40", acquisitions: "1", workers: "1", visits: "10", meetings: "5", negotiations: "2", contracts: "1" },
    { area: "QA5-CSV月初見込の確定" }
  );
  expect(await monthForecastPairs(M_CSV_FC)).toEqual([[D_CFC1, 40]]);

  // CSVで同月2行を取込（確定日に999・後日に888の見込を入れた不正なCSV）
  await uploadVisitCsv(page, "QA5-visit-forecast-lock.csv", [
    `${D_CFC1},110001C001,QA5-CSV見込上書き1,999,5,2,30,10,5,2,QA5 CSV見込ロック1,,`,
    `${D_CFC2},110001C001,QA5-CSV見込上書き2,888,3,1,20,8,4,1,QA5 CSV見込ロック2,,`,
  ]);
  await expect(page.getByText("2件の訪販日報を取り込みました")).toBeVisible({ timeout: 15_000 });

  // 月内全行の見込を検証: 確定済みの40が維持され、後日日付には見込を保存しない
  await expect
    .poll(async () => JSON.stringify(await monthForecastPairs(M_CSV_FC)), { timeout: 10_000 })
    .toBe(JSON.stringify([[D_CFC1, 40], [D_CFC2, null]]));

  // 見込以外の値はCSVで正しく上書き・追加されている（取込自体は成功している証明）
  const rows = await db().dailyReport.findMany({
    where: { salesStaffId: staffId, type: "訪販", date: { startsWith: M_CSV_FC } },
    orderBy: { date: "asc" },
  });
  expect(rows).toHaveLength(2);
  expect(rows[0].acquisitions).toBe(5);
  expect(rows[0].visits).toBe(30);
  expect(rows[0].source).toBe("csv");
  expect(rows[1].acquisitions).toBe(3);
  expect(rows[1].source).toBe("csv");
});

test("R9: CSV取込のみでも月内の見込は最古日付の1件だけ（後日日付では見込が保存されない）（要件6-3）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "R9");
  await page.goto("/reports");

  // 行順に依存しないこと（後日日付を先頭に置く）も併せて検証する
  await uploadVisitCsv(page, "QA5-visit-forecast-only-csv.csv", [
    `${D_CO2},110001C001,QA5-CSV単独見込2,99,2,1,10,5,2,1,QA5 CSV単独見込2,,`,
    `${D_CO1},110001C001,QA5-CSV単独見込1,30,1,1,10,5,2,1,QA5 CSV単独見込1,,`,
    `${D_CO3},110001C001,QA5-CSV単独見込3,,1,1,10,5,2,1,QA5 CSV単独見込3,,`,
  ]);
  await expect(page.getByText("3件の訪販日報を取り込みました")).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(async () => JSON.stringify(await monthForecastPairs(M_CSV_ONLY)), { timeout: 10_000 })
    .toBe(JSON.stringify([[D_CO1, 30], [D_CO2, null], [D_CO3, null]]));
});

test("稼働提出物の通知は代理店管理者（⑦⑧）のみに届く（⑨販売員には配信しない）（§3.7 / §5.1）", async ({
  page,
}) => {
  // 仕様: §5.1 の権限マトリクスで⑨は稼働提出物=×。稼働提出物の通知（提出・承認・差戻し）は
  // 代理店管理者（⑦⑧）のみに配信し、同じ代理店に属する⑨販売員には配信しない。
  test.setTimeout(180_000);
  const d = db();
  const loginIds = ["airis_1110001_001", "airis_2210001_001", "110001C001", "210001C001"];
  const accounts = await d.account.findMany({
    where: { loginId: { in: loginIds } },
    select: { id: true, loginId: true },
  });
  const idOf = (loginId: string): string => {
    const acc = accounts.find((a) => a.loginId === loginId);
    if (!acc) throw new Error(`シードアカウント ${loginId} が見つかりません`);
    return acc.id;
  };
  const r7 = idOf("airis_1110001_001"); // ⑦ 東都(110001) = 1次店（提出通知の宛先）
  const r8 = idOf("airis_2210001_001"); // ⑧ セールスパートナー東京(210001) = 提出元
  const r9Ids = [idOf("110001C001"), idOf("210001C001")]; // ⑨（1次店所属・提出元所属の両方）
  const subNotify = { title: { contains: "稼働提出物" } };

  // 過去実行で作られた通知は除去し、このテストで新たに発生する通知のみを検証する
  await d.notification.deleteMany({ where: { accountId: { in: r9Ids }, ...subNotify } });
  await d.submission.deleteMany({ where: { memo: SUB_MEMO_NOTIFY } });
  const before7 = await d.notification.count({ where: { accountId: r7, ...subNotify } });
  const before8 = await d.notification.count({ where: { accountId: r8, ...subNotify } });

  // ⑧が提出 → 1次店（⑦）へ「1次承認待ち」通知
  await login(page, "R8");
  await page.goto("/reports?tab=submissions");
  const form = page.locator("form").filter({ has: page.locator('input[name="memo"]') });
  await form.locator('select[name="kind"]').selectOption(SUB_KIND_NOTIFY);
  await form.locator('input[name="targetMonth"]').fill(M_SUB_NOTIFY);
  await form.locator('input[name="file"]').setInputFiles({
    name: `${SUB_MEMO_NOTIFY}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from("QA5 dummy xlsx payload"),
  });
  await form.locator('input[name="memo"]').fill(SUB_MEMO_NOTIFY);
  await form.getByRole("button", { name: "提出する" }).click();
  await expect(page.getByText(`「${SUB_KIND_NOTIFY}」（${M_SUB_NOTIFY}）を提出しました`)).toBeVisible({
    timeout: 15_000,
  });

  await expect
    .poll(async () => d.notification.count({ where: { accountId: r7, ...subNotify } }), {
      timeout: 15_000,
    })
    .toBe(before7 + 1);
  // ⑨には1件も届かない
  expect(await d.notification.count({ where: { accountId: { in: r9Ids }, ...subNotify } })).toBe(0);

  // ②が差戻し → 提出元（⑧）へ通知。ここでも⑨には配信しない
  await page.context().clearCookies();
  await login(page, "R2");
  await page.goto(`/reports?tab=submissions&q=${encodeURIComponent(SUB_MEMO_NOTIFY)}`);
  const row = page.locator("tr").filter({ hasText: SUB_MEMO_NOTIFY });
  await expect(row).toHaveCount(1);
  await row.locator('input[name="reason"]').fill("QA5 通知宛先検証のため差戻し");
  await row.getByRole("button", { name: "差戻し" }).click();
  await expect
    .poll(async () => d.notification.count({ where: { accountId: r8, ...subNotify } }), {
      timeout: 15_000,
    })
    .toBe(before8 + 1);
  expect(await d.notification.count({ where: { accountId: { in: r9Ids }, ...subNotify } })).toBe(0);

  // 後片付け（他スイートの提出物集計に影響させない）
  await d.submission.deleteMany({ where: { memo: SUB_MEMO_NOTIFY } });
});

test("CSVテンプレートDL: 訪販/テレマのヘッダ検証・不正パラメータは400", async ({ page }) => {
  await login(page, "R9");

  const visit = await page.request.get("/reports/csv?template=visit");
  expect(visit.status()).toBe(200);
  expect(visit.headers()["content-type"]).toContain("text/csv");
  const visitBody = (await visit.text()).replace(/^﻿/, "");
  expect(visitBody.split(/\r?\n/)[0]).toBe(VISIT_HEADERS);

  const tele = await page.request.get("/reports/csv?template=tele");
  expect(tele.status()).toBe(200);
  const teleBody = (await tele.text()).replace(/^﻿/, "");
  expect(teleBody.split(/\r?\n/)[0]).toBe(TELE_HEADERS);

  // 異常系: 存在しないテンプレート種別
  const bad = await page.request.get("/reports/csv?template=bogus");
  expect(bad.status()).toBe(400);
});

test("R9: CSVアップロード正常（訪販2行）→DBに取込・値検証", async ({ page }) => {
  await login(page, "R9");
  await page.goto("/reports");

  const csv =
    VISIT_HEADERS +
    "\r\n" +
    `${D_CSV1},110001C001,QA5-CSV世田谷,30,3,2,40,18,9,2,QA5 CSV取込テスト,好反応,QA5備考A` +
    "\r\n" +
    `${D_CSV2},110001C001,QA5-CSV杉並,,1,1,20,8,4,1,QA5 CSV取込テスト2,,`;

  await page.locator('select[name="csvType"]').selectOption("訪販");
  await page.setInputFiles('input[name="file"]', {
    name: "QA5-visit.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("﻿" + csv, "utf-8"),
  });
  await page.getByRole("button", { name: "CSVアップロード" }).click();
  await expect(page.getByText("2件の訪販日報を取り込みました")).toBeVisible({ timeout: 15_000 });

  const row1 = await db().dailyReport.findUnique({
    where: { date_type_salesStaffId: { date: D_CSV1, type: "訪販", salesStaffId: staffId } },
  });
  expect(row1).not.toBeNull();
  // CSV取込でも月初見込ロックが働く: 当月はシード日報（${MONTH}-01）で確定済みのため
  // 後日日付のCSV行の見込は保存されない（要件6-3 / BUG-007）。他の列は取り込まれる。
  expect(row1!.forecastAcq).toBeNull();
  expect(row1!.acquisitions).toBe(3);
  expect(row1!.workers).toBe(2);
  expect(row1!.visits).toBe(40);
  expect(row1!.meetings).toBe(18);
  expect(row1!.negotiations).toBe(9);
  expect(row1!.contracts).toBe(2);
  expect(row1!.area).toBe("QA5-CSV世田谷");
  expect(row1!.activityContent).toBe("QA5 CSV取込テスト");
  expect(row1!.notes).toBe("QA5備考A");
  expect(row1!.source).toBe("csv");

  const row2 = await db().dailyReport.findUnique({
    where: { date_type_salesStaffId: { date: D_CSV2, type: "訪販", salesStaffId: staffId } },
  });
  expect(row2).not.toBeNull();
  expect(row2!.forecastAcq).toBeNull();
  expect(row2!.acquisitions).toBe(1);
  expect(row2!.source).toBe("csv");
});

test("R9: CSVアップロード不正行あり→全件拒否（正常行も取り込まれない）", async ({ page }) => {
  await login(page, "R9");
  await page.goto("/reports");

  const csv =
    VISIT_HEADERS +
    "\r\n" +
    `${D_CSV_BAD},110001C001,QA5-CSV拒否,,1,1,10,5,2,1,QA5 全件拒否テスト,,` +
    "\r\n" +
    `2026/08/26,110001C001,QA5-CSV不正,,1,1,10,5,2,1,QA5 不正行,,`;

  await page.locator('select[name="csvType"]').selectOption("訪販");
  await page.setInputFiles('input[name="file"]', {
    name: "QA5-visit-bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("﻿" + csv, "utf-8"),
  });
  await page.getByRole("button", { name: "CSVアップロード" }).click();

  // エラー行レポート（何行目・理由）+ 全件拒否の表示
  await expect(page.getByText("全件拒否しました")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3行目: 日付はYYYY-MM-DD形式で入力してください")).toBeVisible();

  // 正常行（2行目）も取り込まれていないこと（§3.6 全件ロールバック）
  expect(
    await db().dailyReport.count({
      where: { date: D_CSV_BAD, type: "訪販", salesStaffId: staffId },
    })
  ).toBe(0);
});

test("異常系: 日付未入力では保存できない（必須バリデーション）", async ({ page }) => {
  await login(page, "R9");
  await page.goto("/reports");
  await page.fill('input[name="date"]', "");
  await page.fill('input[name="acquisitions"]', "1");
  await page.getByRole("button", { name: "日報を保存する" }).click();
  const valueMissing = await page
    .locator('input[name="date"]')
    .evaluate((el) => (el as HTMLInputElement).validity.valueMissing);
  expect(valueMissing).toBe(true);
  await expect(page.getByText("日報を保存しました")).toHaveCount(0);
});

test("権限外アクセス: R5(HL窓口)/R10(稼働終了)は /reports に入れない", async ({ page, request }) => {
  // 未認証はCSVテンプレも401（ホストは playwright.config の baseURL / QA_BASE_URL に従う）
  const anon = await request.get("/reports/csv?template=visit");
  expect(anon.status()).toBe(401);

  await login(page, "R5");
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  const forbidden = await page.request.get("/reports/csv?template=visit");
  expect(forbidden.status()).toBe(403);

  await page.context().clearCookies();
  await login(page, "R10");
  await page.goto("/reports");
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
});

test.describe("モバイルビュー（375x812）", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("R9: スマホビューで日報フォームが操作可能（入力→保存成功→DB検証）", async ({ page }) => {
    const errors = collectConsoleErrors(page);
    await login(page, "R9");
    await page.goto("/reports");
    await expect(page.getByText("日報入力")).toBeVisible();

    await saveVisitReport(
      page,
      D_MOBILE,
      { acquisitions: "1", workers: "1", visits: "15", meetings: "6", negotiations: "3", contracts: "1" },
      { area: "QA5-モバイル入力", activityContent: "QA5 スマホからの提出テスト" }
    );

    const rec = await db().dailyReport.findUnique({
      where: { date_type_salesStaffId: { date: D_MOBILE, type: "訪販", salesStaffId: staffId } },
    });
    expect(rec).not.toBeNull();
    expect(rec!.acquisitions).toBe(1);
    expect(rec!.visits).toBe(15);
    expect(rec!.area).toBe("QA5-モバイル入力");

    expect(criticalErrors(errors)).toEqual([]);
  });
});

test("R9: 集計・実績確認タブ KPIカード6枚のラベル表示（自分の日報のみ表示）", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await login(page, "R9");
  await page.goto("/reports?tab=summary");

  for (const label of ["日報件数", "獲得/成果数", "生産性", "成約率", "提出物", "最終承認済み"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }

  // R9は自分の日報のみ（§3.1）: 他販売員のIDが混ざらない
  await expect(page.getByText("日報レコード")).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  expect(await page.locator("tbody tr").filter({ hasText: "210001C001" }).count()).toBe(0);
  expect(await page.locator("tbody tr").filter({ hasText: "110001C001" }).count()).toBeGreaterThan(0);

  // ⑨に削除権限は無い（§5.1: 提（自己修正可）のみ）→ 削除ボタンが出ない
  await expect(page.getByRole("button", { name: "削除" })).toHaveCount(0);

  expect(criticalErrors(errors)).toEqual([]);
});
