// 日付入力の実在検証（QA loop3 で検出した実欠陥の回帰テスト）。
//
// 検出された欠陥:
//   窓口案件の作成パスに対応期限の検証が無く、`9999-99-99` がそのままDBへ保存されていた。
//   更新パスには検証があったが `/^\d{4}-\d{2}-\d{2}$/` の**形式のみ**だったため
//   `9999-99-99` / `2026-02-31` を通していた。同じ形式のみの検証が
//   稼働開始日・稼働終了日・生年月日・代理店参加日・日報の日付にも使われていた。
//
// 影響: 対応期限が不正だと督促バッチ（要件9-2）の期限判定が壊れ、
//       生年月日が不正だと15歳未満判定（発注者指示）が誤る。
//
// 検証方針: **実ブラウザから不正値を送り、実DBに保存されていないこと**を確認する。
//   HTMLの type="date" によるクライアント検証は page.evaluate で外し、
//   サーバ側（server action）で拒否されることを確かめる（UI層だけの防御では不十分 §3.2）。
import { test, expect } from "@playwright/test";
import { login, db } from "./helpers";

const TAG = "QAD_"; // 本スイートが作るデータの目印

// type="date" の入力欄に不正な文字列を入れる（ブラウザ側の型検証を外す）
async function forceDateValue(page: import("@playwright/test").Page, name: string, value: string) {
  await page.evaluate(
    ({ name, value }) => {
      const el = document.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
      if (!el) throw new Error(`input[name="${name}"] が見つかりません`);
      el.type = "text";
      el.value = value;
    },
    { name, value }
  );
}

// 形式は正しいが実在しない日付（境界値）
const IMPOSSIBLE_DATES = ["9999-99-99", "2026-02-31", "2026-13-01"];

test.afterAll(async () => {
  await db().$disconnect();
});

test("窓口案件: 実在しない対応期限は作成時にサーバ側で拒否され、DBに保存されない", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const title = `${TAG}期限検証`;
  try {
    await login(page, "R2");

    for (const bad of IMPOSSIBLE_DATES) {
      // 起票フォームは ?new=1 で表示される（src/components/cases/snc-case-list.tsx の showNew）
      await page.goto("/hotline?new=1");
      await expect(page.getByText("新規依頼の起票")).toBeVisible({ timeout: 15_000 });

      const deadlineInput = page.locator('[name="deadline"]').first();
      if (!(await deadlineInput.count())) {
        throw new Error("対応期限の入力欄が見つかりません（画面構成の変更）");
      }
      await forceDateValue(page, "deadline", bad);

      // 本文・件名など必須項目を埋める（画面にあるものだけ）
      const body = page.locator('[name="body"]').first();
      if (await body.count()) await body.fill(`${title} / ${bad}`);
      const titleInput = page.locator('[name="title"]').first();
      if (await titleInput.count()) await titleInput.fill(`${title}-${bad}`);
      const tmpl = page.locator('select[name="templateKind"]').first();
      if (await tmpl.count()) await tmpl.selectOption({ index: 1 }).catch(() => {});
      const primary = page.locator('select[name="primaryAgencyId"]').first();
      if (await primary.count()) await primary.selectOption({ index: 1 }).catch(() => {});

      await page
        .getByRole("button", { name: /起票|作成|登録|送信/ })
        .first()
        .click();
      await page.waitForTimeout(4000);

      // どの経路で拒否されても構わないが、**不正な期限を持つ案件が存在してはならない**
      const stored = await db().case.findFirst({ where: { deadline: bad } });
      expect(stored, `対応期限 ${bad} の案件がDBに保存されている`).toBeNull();
    }
  } finally {
    const rows = await db().case.findMany({
      where: { title: { contains: TAG } },
      select: { id: true, caseNo: true },
    });
    for (const c of rows) {
      await db()
        .notification.deleteMany({ where: { body: { contains: c.caseNo } } })
        .catch(() => {});
      await db()
        .caseStatusHistory.deleteMany({ where: { caseId: c.id } })
        .catch(() => {});
      await db()
        .caseMessage.deleteMany({ where: { caseId: c.id } })
        .catch(() => {});
      await db()
        .statusHistory.deleteMany({ where: { entityId: c.id } })
        .catch(() => {});
      await db()
        .auditLog.deleteMany({ where: { target: { contains: c.caseNo } } })
        .catch(() => {});
      await db().case.deleteMany({ where: { id: c.id } });
    }
  }
});

test("販売員ID申請: 実在しない生年月日はサーバ側で拒否され、DBに保存されない", async ({ page }) => {
  test.setTimeout(180_000);
  const lastName = `${TAG}生年月日`;
  try {
    await login(page, "R2");
    await page.goto("/sales-staff");
    await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();

    for (const bad of IMPOSSIBLE_DATES) {
      await page.locator('input[name="lastName"]').fill(lastName);
      await page.locator('input[name="firstName"]').fill("検証");
      await page.locator('input[name="phone"]').fill("090-5555-6666");
      const agencySelect = page.locator('select[name="agencyId"]');
      if (await agencySelect.count()) await agencySelect.selectOption({ index: 1 });
      await forceDateValue(page, "birthDate", bad);
      await page.getByRole("button", { name: "申請する" }).click();
      await page.waitForTimeout(4000);

      const stored = await db().salesStaff.findFirst({ where: { lastName } });
      expect(stored, `生年月日 ${bad} の販売員がDBに保存されている`).toBeNull();

      // 次のケースのためにフォームを開き直す
      await page.goto("/sales-staff");
      await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
    }
  } finally {
    const rows = await db().salesStaff.findMany({
      where: { lastName: { contains: TAG } },
      select: { id: true },
    });
    for (const s of rows) {
      await db()
        .statusHistory.deleteMany({ where: { entityId: s.id } })
        .catch(() => {});
      await db().salesStaff.deleteMany({ where: { id: s.id } });
    }
  }
});

test("日報CSV: 実在しない日付の行は取り込まれない（1行でもエラーなら全件拒否 §3.6）", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const HEADERS =
    "日付,販売員ID,エリア,獲得見込,獲得,稼働数,訪問数,対面数,商談数,成約数,活動実施内容,活動実施結果,備考";
  const AREA = `${TAG}CSV`;
  try {
    await login(page, "R2");
    await page.goto("/reports");
    const staff = await db().salesStaff.findFirst({
      where: { salesId: { not: null }, status: "registered", agency: { isDummy: false } },
      select: { salesId: true },
    });
    expect(staff, "本登録済みの販売員シードが必要").not.toBeNull();

    // 1行目は実在しない日付、2行目は正常 → §3.6 により全件拒否されること
    const lines = [
      `2026-02-31,${staff!.salesId},${AREA},,1,1,10,5,3,1,,,`,
      `2026-08-04,${staff!.salesId},${AREA},,1,1,10,5,3,1,,,`,
    ];
    await page.locator('select[name="csvType"]').selectOption("訪販");
    await page.setInputFiles('input[name="file"]', {
      name: "qad-bad-date.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("﻿" + [HEADERS, ...lines].join("\r\n"), "utf-8"),
    });
    await page.getByRole("button", { name: "CSVアップロード" }).click();
    await page.waitForTimeout(5000);

    const stored = await db().dailyReport.findMany({ where: { area: AREA } });
    expect(
      stored,
      "不正日付を含むCSVから1件も取り込まれてはいけない（§3.6 全件拒否）"
    ).toHaveLength(0);
  } finally {
    await db().dailyReport.deleteMany({ where: { area: { contains: TAG } } });
  }
});
