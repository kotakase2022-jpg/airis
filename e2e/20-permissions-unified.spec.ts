/**
 * QA担当: 権限判定の統一検証（§3.2「機能×操作の権限は §5 の表をコードで表現し、API層・UI層の両方で判定する」）
 *
 * 対象: 主要CSVルート / ドキュメント（§7.12） / Airisアカウント申請（§6.1・§7.2）
 * 観点: 画面（UI層）とルートハンドラ（API層）の可否が **§5.1 / §5.2 の表どおり** に
 *       ロール横断で一致すること。期待値は指示書から独立に転記する（実装の定数を再利用しない）。
 *
 * データプレフィクス: QA20
 */
import { test, expect, type Page } from "@playwright/test";
import { ACCOUNTS, db, login, type RoleKey } from "./helpers";

const RUN = Date.now();

const ALL_ROLES: RoleKey[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

// ---------------------------------------------------------------------------
// 主要CSVルート × ロール（§5.1 の機能行 + §5.2 のページアクセスから転記）
// ---------------------------------------------------------------------------
const CSV_MATRIX: { path: string; allowed: RoleKey[]; spec: string }[] = [
  {
    path: "/sales-staff/csv/list",
    allowed: ["R1", "R2", "R3", "R4", "R7", "R8"],
    spec: "§5.1 販売員ID（①②③⑦=閲 / ⑧=申=自店の申請状況確認 / ④=ダミー）",
  },
  {
    path: "/sales-staff/csv/gigacc",
    allowed: ["R1", "R2", "R3", "R4", "R7", "R8"],
    spec: "§6.2-4 GiGaCC連携CSV（対象ロールは販売員IDと同じ）",
  },
  {
    path: "/sales-staff/csv/template",
    allowed: ["R1", "R2", "R3", "R4", "R7", "R8"],
    spec: "§6.2-3 一括申請ひな形（申請権を持つ⑧を含む）",
  },
  {
    path: "/field-agents/csv",
    allowed: ["R1", "R2", "R3", "R4", "R7", "R8"],
    spec: "§5.1 訪販員申請（①②③⑦=閲 / ⑧=申 / ④=ダミー）",
  },
  {
    path: "/reports/csv?template=visit",
    allowed: ["R1", "R2", "R3", "R4", "R7", "R8", "R9"],
    spec: "§5.1 日報提出（⑨=提のためテンプレート取得可 / ④=ダミー）",
  },
  {
    path: "/admin/csv?type=inventory",
    allowed: ["R1", "R2"],
    spec: "§5.2 Airisアカウント管理=①②のみ（④ダミーは実データのエクスポート不可 §3.5）",
  },
];

test.describe("主要CSVルートの権限（§5.1 / §5.2）", () => {
  for (const role of ALL_ROLES) {
    test(`${role}(${ACCOUNTS[role].label}): 主要CSVルートの可否が権限表どおり`, async ({ page }) => {
      await login(page, role);
      for (const route of CSV_MATRIX) {
        const res = await page.request.get(route.path, { maxRedirects: 0 });
        const contentType = res.headers()["content-type"] ?? "";
        if (route.allowed.includes(role)) {
          expect(res.status(), `${role} → ${route.path} は許可（${route.spec}）`).toBe(200);
          expect(contentType, `${role} → ${route.path} はCSVが返る`).toContain("csv");
        } else {
          expect(
            res.status(),
            `${role} → ${route.path} は不許可（${route.spec}）`
          ).not.toBe(200);
          expect(
            contentType,
            `${role} → ${route.path} はCSV本文を返してはいけない`
          ).not.toContain("csv");
        }
      }
    });
  }
});

// 1行分のCSVをダブルクォート対応で分解する
function splitCsvRow(row: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (inQuotes) {
      if (c === '"') {
        if (row[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      cols.push(cur);
      cur = "";
    } else cur += c;
  }
  cols.push(cur);
  return cols;
}

function csvRows(body: string): string[][] {
  return body
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .map(splitCsvRow);
}

test("R4（SNC閲覧）: 販売員CSVはダミー代理店のデータのみ（§3.5 ダミー表示モード）", async ({ page }) => {
  const agencies = await db().agency.findMany({ select: { code: true, isDummy: true } });
  const dummyCodes = new Set(agencies.filter((a) => a.isDummy).map((a) => a.code));
  const realCodes = new Set(agencies.filter((a) => !a.isDummy).map((a) => a.code));

  await login(page, "R4");
  const res = await page.request.get("/sales-staff/csv/list");
  expect(res.status()).toBe(200);
  const rows = csvRows(await res.text());
  const header = rows[0];
  const codeIdx = header.indexOf("代理店コード");
  expect(codeIdx, "代理店コード列が存在する").toBeGreaterThanOrEqual(0);

  const dataRows = rows.slice(1);
  expect(dataRows.length, "④にもダミーデータは表示される（§3.5）").toBeGreaterThan(0);
  for (const row of dataRows) {
    const code = row[codeIdx];
    expect(realCodes.has(code), `実データの代理店コードが混入している: ${code}`).toBe(false);
    expect(dummyCodes.has(code), `ダミー代理店のコードのみ: ${code}`).toBe(true);
  }
});

test("訪販員申請一覧CSV: SNC限定列（ブラックリスト/SNC用メモ）は①②③のみ（§7.4 / §5.1「承」）", async ({
  page,
}) => {
  // ③（SNC運用者）= §5.1 訪販員申請の「承」を持つ → SNC限定列あり
  await login(page, "R3");
  const sncRes = await page.request.get("/field-agents/csv");
  expect(sncRes.status()).toBe(200);
  const sncHeader = csvRows(await sncRes.text())[0];
  expect(sncHeader).toContain("ブラックリスト");
  expect(sncHeader).toContain("SNC用メモ");

  // ⑦（1次代理店管理者）= 代理店側 → 一切出さない（§7.4「代理店側には一切見せない」）
  await page.context().clearCookies();
  await login(page, "R7");
  const agencyRes = await page.request.get("/field-agents/csv");
  expect(agencyRes.status()).toBe(200);
  const agencyBody = await agencyRes.text();
  const agencyHeader = csvRows(agencyBody)[0];
  expect(agencyHeader).not.toContain("ブラックリスト");
  expect(agencyHeader).not.toContain("SNC用メモ");
  expect(agencyBody).not.toContain("★");
});

// ---------------------------------------------------------------------------
// ドキュメント（§7.12 / §5.2）
// 登録・削除はSNC（①②③）のみ。④はダミー表示で書き込み不可（§3.5）。⑩はページ自体×。
// ---------------------------------------------------------------------------
const DOC_PAGE_ROLES: RoleKey[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"];
const DOC_MANAGE_ROLES: RoleKey[] = ["R1", "R2", "R3"];

test.describe("ドキュメントの操作権限（§7.12 / §5.2）", () => {
  for (const role of DOC_PAGE_ROLES) {
    test(`${role}(${ACCOUNTS[role].label}): アップロード・削除UIはSNC①②③のみ`, async ({ page }) => {
      await login(page, role);
      await page.goto("/documents");
      await expect(page.getByRole("heading", { name: "ドキュメント" }).first()).toBeVisible();

      const uploadSection = page.getByText("ドキュメントアップロード（SNCのみ）");
      const deleteButtons = page.locator("tbody").getByRole("button", { name: "削除" });
      if (DOC_MANAGE_ROLES.includes(role)) {
        await expect(uploadSection, `${role} は §7.12 の登録主体`).toBeVisible();
        expect(await deleteButtons.count(), `${role} は削除操作を持つ`).toBeGreaterThan(0);
      } else {
        await expect(uploadSection, `${role} に登録UIを出さない`).toHaveCount(0);
        expect(await deleteButtons.count(), `${role} に削除UIを出さない`).toBe(0);
      }
    });
  }

  test("R10（稼働終了代理店）: /documents はアクセス不可（§5.2 ドキュメント=×）", async ({ page }) => {
    await login(page, "R10");
    await page.goto("/documents");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Airisアカウント申請（§5.1 Airisアカウント行 / §6.1 / §7.2）
//   申 = ①〜⑧ / 一承 = ⑦のみ / 承 = ①②③（SNC系ロール宛は①②のみ §6.1-3）
// ---------------------------------------------------------------------------
const REQ_FIRST = `QA20-F-${RUN}`; // 1次承認待ち（⑧の申請）
const REQ_FINAL = `QA20-P-${RUN}`; // 最終承認待ち

test.describe("Airisアカウント申請の承認権限（§5.1 / §6.1）", () => {
  test.beforeAll(async () => {
    const d = db();
    const agency = await d.agency.findUniqueOrThrow({ where: { code: "210001" } }); // ⑦110001配下の2次店
    const applicant = await d.account.findUniqueOrThrow({
      where: { loginId: ACCOUNTS.R8.loginId },
    });
    const base = {
      role: "R8",
      agencyId: agency.id,
      createdBy: applicant.id,
      history: [{ event: "requested", at: "2026-08-05", by: ACCOUNTS.R8.loginId }],
    };
    await d.accountRequest.createMany({
      data: [
        {
          ...base,
          requestId: REQ_FIRST,
          name: `QA20一次承認待ち-${RUN}`,
          email: `qa20-first-${RUN}@example.com`,
          status: "pending_first",
        },
        {
          ...base,
          requestId: REQ_FINAL,
          name: `QA20最終承認待ち-${RUN}`,
          email: `qa20-final-${RUN}@example.com`,
          status: "pending_final",
        },
      ],
    });
  });

  test.afterAll(async () => {
    await db().accountRequest.deleteMany({ where: { requestId: { startsWith: "QA20-" } } });
  });

  const row = (page: Page, requestId: string) =>
    page.locator("tbody tr", { hasText: requestId });

  test("R7（1次代理店管理者）: 一承のみ持つ（pending_firstに1次承認 / pending_finalには承認ボタン無し）", async ({
    page,
  }) => {
    await login(page, "R7");
    await page.goto("/account-requests");

    const first = row(page, REQ_FIRST);
    await expect(first).toHaveCount(1);
    await expect(first.getByRole("button", { name: "1次承認" })).toBeVisible();
    await expect(first.getByRole("button", { name: "却下" })).toBeVisible();

    const final = row(page, REQ_FINAL);
    await expect(final).toHaveCount(1);
    // §5.1: ⑦は「承」を持たない（最終承認は①②③）
    await expect(final.getByRole("button", { name: "最終承認" })).toHaveCount(0);
    await expect(final.getByRole("button", { name: "却下" })).toHaveCount(0);
  });

  test("R3（SNC運用者）: 承のみ持つ（1次承認ボタンは出ない / pending_finalに最終承認）", async ({
    page,
  }) => {
    await login(page, "R3");
    await page.goto("/account-requests");

    const first = row(page, REQ_FIRST);
    await expect(first).toHaveCount(1);
    // §5.1「一承」は⑦のみ。①②③には1次承認ボタンを出さない
    await expect(first.getByRole("button", { name: "1次承認" })).toHaveCount(0);

    const final = row(page, REQ_FINAL);
    await expect(final).toHaveCount(1);
    await expect(final.getByRole("button", { name: "最終承認" })).toBeVisible();
  });

  test("R8（2次代理店管理者）: 申のみ（自店の申請は見えるが承認・却下ボタンは一切出ない）", async ({
    page,
  }) => {
    await login(page, "R8");
    await page.goto("/account-requests");

    for (const requestId of [REQ_FIRST, REQ_FINAL]) {
      const target = row(page, requestId);
      await expect(target).toHaveCount(1);
      await expect(target.getByRole("button", { name: "1次承認" })).toHaveCount(0);
      await expect(target.getByRole("button", { name: "最終承認" })).toHaveCount(0);
      await expect(target.getByRole("button", { name: "却下" })).toHaveCount(0);
    }
  });

  test("R4（SNC閲覧）: 申請フォームは出る（§3.5 例外）が他ロールの申請は見えない", async ({ page }) => {
    await login(page, "R4");
    await page.goto("/account-requests");
    // §3.5 例外: ④のAirisアカウント申請（自ロール④のみ §6.1）は実データとして受け付ける
    await expect(page.getByRole("button", { name: "＋ アカウント申請" })).toBeVisible();
    await expect(row(page, REQ_FIRST)).toHaveCount(0);
    await expect(row(page, REQ_FINAL)).toHaveCount(0);
  });

  // §3.6「全件ロールバック」/ §3.1: 最終承認は Account 発行 + 申請更新の2テーブル書き込みなので、
  // 片方が失敗したら両方とも書かれないこと（真のトランザクション）を検証する。
  test("§3.6 最終承認は真のトランザクション: ID採番が衝突すると申請も更新されない", async ({ page }) => {
    const d = db();
    const agency = await d.agency.findUniqueOrThrow({ where: { code: "210001" } });
    const prefix = `airis_2${agency.code}_`; // ⑧のアカウントID体系（§4）
    const before = await d.account.count({ where: { loginId: { startsWith: prefix } } });
    // 採番規則は「同prefixの件数+1」。ブロッカーを1件足すと承認時の採番は (before+2) になるため、
    // そのIDを先に埋めておくと Account.create が unique 制約で必ず失敗する。
    const blockerLoginId = prefix + String(before + 2).padStart(3, "0");
    const applicant = await d.account.findUniqueOrThrow({
      where: { loginId: ACCOUNTS.R8.loginId },
    });
    const requestId = `QA20-TX-${RUN}`;

    await d.account.create({
      data: {
        loginId: blockerLoginId,
        role: "R8",
        name: `QA20採番衝突ブロッカー-${RUN}`,
        agencyId: agency.id,
        status: "suspended",
        passwordHash: "qa20-not-a-real-hash",
      },
    });
    await d.accountRequest.create({
      data: {
        requestId,
        role: "R8",
        name: `QA20トランザクション-${RUN}`,
        email: `qa20-tx-${RUN}@example.com`,
        agencyId: agency.id,
        createdBy: applicant.id,
        status: "pending_final",
        history: [{ event: "requested", at: "2026-08-05", by: ACCOUNTS.R8.loginId }],
      },
    });

    try {
      await login(page, "R3");
      await page.goto("/account-requests");
      const target = row(page, requestId);
      await expect(target).toHaveCount(1);
      await target.getByRole("button", { name: "最終承認" }).click();
      await expect(target.getByText(/承認処理が競合したため中断しました/)).toBeVisible({
        timeout: 15_000,
      });

      // 申請は pending_final のまま（issuedLoginId も付かない）
      const after = await d.accountRequest.findUniqueOrThrow({ where: { requestId } });
      expect(after.status, "失敗時は申請ステータスを進めない").toBe("pending_final");
      expect(after.issuedLoginId).toBeNull();
      // Account も1件も増えていない（ブロッカーのみ）
      expect(
        await d.account.count({ where: { loginId: { startsWith: prefix } } }),
        "Accountが部分的に作成されていない（全件ロールバック §3.6）"
      ).toBe(before + 1);
    } finally {
      await d.accountRequest.deleteMany({ where: { requestId } });
      await d.account.deleteMany({ where: { loginId: blockerLoginId } });
    }
  });

  test("R9/R10: /account-requests はアクセス不可（§5.2 Airisアカウント申請=×）", async ({ page }) => {
    for (const role of ["R9", "R10"] as RoleKey[]) {
      await page.context().clearCookies();
      await login(page, role);
      await page.goto("/account-requests");
      await expect(page, `${role} は §5.2 でアクセス不可`).toHaveURL(/\/dashboard/, {
        timeout: 15_000,
      });
    }
  });
});
