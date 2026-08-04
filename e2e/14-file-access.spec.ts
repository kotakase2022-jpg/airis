/**
 * QA担当: /files/[id] のファイル認可（§3.1 / §3.8 / §10.5 IDOR防止）回帰テスト
 * データプレフィクス: QA14（テストデータは自前で作成し、afterAll で後始末）
 *
 * 検証方針:
 * - セッションをDBへ直接作る手法は使わず、必ず通常のログインフォーム経由で認証する
 * - ファイル本体は StoredFile + 参照エンティティ（FieldAgentApplication / Document）で構成し、
 *   参照元エンティティの閲覧可否ルールがそのままファイル取得の可否になることを確認する
 */
import { test, expect, Page } from "@playwright/test";
import { ACCOUNTS, PW_ADMIN, RoleKey, db } from "./helpers";

const P = "QA14";

// 誓約書PDF（1次店110001所属の販売員の訪販員申請に添付されたもの）
const PLEDGE_BODY = `%PDF-1.4\n${P} pledge document body\n%%EOF\n`;
// SNC限定ドキュメント
const SNC_DOC_BODY = `%PDF-1.4\n${P} snc only document body\n%%EOF\n`;

let pledgeFileId = "";
let sncDocFileId = "";
const created = {
  storedFileIds: [] as string[],
  applicationIds: [] as string[],
  salesStaffIds: [] as string[],
  documentIds: [] as string[],
  accountLoginIds: [] as string[],
};

async function agencyByCode(code: string) {
  const ag = await db().agency.findUnique({ where: { code } });
  expect(ag, `代理店 ${code} がシードされていること`).toBeTruthy();
  return ag!;
}

async function storeFile(name: string, mime: string, body: string, uploadedBy: string) {
  const data = Buffer.from(body, "utf8");
  const f = await db().storedFile.create({
    data: { name, mime, size: data.length, data, uploadedBy },
  });
  created.storedFileIds.push(f.id);
  return f;
}

// ログインフォーム経由の認証（DBへの直接セッション作成は行わない）
async function loginAs(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 15_000 });
}

async function loginRole(page: Page, role: RoleKey) {
  await loginAs(page, ACCOUNTS[role].loginId, ACCOUNTS[role].pw);
}

test.beforeAll(async () => {
  const d = db();
  const p1 = await agencyByCode("110001"); // 1次店（R7=airis_1110001_001 の所属）

  // ---- 誓約書PDF: 110001所属販売員の訪販員申請に添付（R7がアップロード） ----
  const pledge = await storeFile(
    `${P}-pledge.pdf`,
    "application/pdf",
    PLEDGE_BODY,
    ACCOUNTS.R7.loginId
  );
  pledgeFileId = pledge.id;

  const staff = await d.salesStaff.create({
    data: {
      salesId: `${P}C001`,
      lastName: "QA14検証",
      firstName: "誓約書",
      birthDate: "1990-01-01",
      phone: "080-1414-1414",
      agencyId: p1.id,
      status: "registered",
      firstApproved: true,
      history: [{ event: "requested", at: "2026-08-01", by: "qa14-seed" }],
    },
  });
  created.salesStaffIds.push(staff.id);

  const app = await d.fieldAgentApplication.create({
    data: {
      salesStaffId: staff.id,
      applicationType: "稼働",
      products: "マルチ",
      attribute: "社員/契約社員",
      identityType: "免許証",
      pledgeNo: `${P}-0001`,
      pledgeFileId: pledge.id,
      agencyCode1: "110001",
      status: "registered",
      firstApproved: true,
      history: [{ event: "requested", at: "2026-08-01", by: "qa14-seed" }],
    },
  });
  created.applicationIds.push(app.id);

  // ---- SNC限定（visibility=snc）ドキュメント ----
  const sncFile = await storeFile(
    `${P}-snc-only.pdf`,
    "application/pdf",
    SNC_DOC_BODY,
    ACCOUNTS.R3.loginId
  );
  sncDocFileId = sncFile.id;
  const doc = await d.document.create({
    data: {
      title: `${P} SNC限定ドキュメント`,
      category: "規程",
      visibility: "snc",
      isDummy: false,
      fileId: sncFile.id,
      fileName: sncFile.name,
      createdBy: ACCOUNTS.R3.loginId,
    },
  });
  created.documentIds.push(doc.id);
});

test.afterAll(async () => {
  const d = db();
  await d.fieldAgentApplication.deleteMany({ where: { id: { in: created.applicationIds } } });
  await d.salesStaff.deleteMany({ where: { id: { in: created.salesStaffIds } } });
  await d.document.deleteMany({ where: { id: { in: created.documentIds } } });
  await d.storedFile.deleteMany({ where: { id: { in: created.storedFileIds } } });
  if (created.accountLoginIds.length > 0) {
    // Session は onDelete: Cascade
    await d.account.deleteMany({ where: { loginId: { in: created.accountLoginIds } } });
  }
  // 監査ログは Cascade 対象外。QA14アカウント分と、シードアカウントが残した
  // 本テスト由来の file_download 記録（target に対象fileIdを含む）を後始末する。
  await d.auditLog.deleteMany({ where: { actor: { startsWith: `${P}_` } } });
  for (const fileId of created.storedFileIds) {
    await d.auditLog.deleteMany({
      where: { action: "file_download", target: { contains: fileId } },
    });
  }
});

// ================================================================
// 1. 誓約書PDFのIDOR防止（§10.5）: URLを知っていても権限外は403
// ================================================================
test.describe("誓約書PDF（訪販員申請の添付）のアクセス制御", () => {
  // ⑧=別テナント(210001) / ⑨=同代理店だが訪販員申請の閲覧権限なし / ④=ダミー閲覧 / ⑤=窓口担当
  const DENIED: RoleKey[] = ["R8", "R9", "R4", "R5"];
  for (const role of DENIED) {
    test(`${role}(${ACCOUNTS[role].label}) は403（本体を取得できない）`, async ({ page }) => {
      await loginRole(page, role);
      const res = await page.request.get(`/files/${pledgeFileId}`);
      expect(
        res.status(),
        `${role} は110001の誓約書PDFを取得できないこと（§3.1/§10.5）`
      ).toBe(403);
      expect(await res.text()).not.toContain("pledge document body");

      // 拒否も監査ログに残ること（§3.3）
      await expect
        .poll(
          async () =>
            db().auditLog.count({
              where: {
                actor: ACCOUNTS[role].loginId,
                action: "file_download",
                result: "denied",
                target: { contains: pledgeFileId },
              },
            }),
          { timeout: 10_000 }
        )
        .toBeGreaterThan(0);
    });
  }

  // ②③=SNC系（テナント横断可） / ⑦=対象代理店(110001)の1次店管理者
  const ALLOWED: RoleKey[] = ["R2", "R3", "R7"];
  for (const role of ALLOWED) {
    test(`${role}(${ACCOUNTS[role].label}) は200で本体が取得できる`, async ({ page }) => {
      await loginRole(page, role);
      const res = await page.request.get(`/files/${pledgeFileId}`);
      expect(res.status(), `${role} は正当な閲覧者`).toBe(200);
      expect(await res.text()).toBe(PLEDGE_BODY);
      expect(res.headers()["content-type"]).toContain("application/pdf");
      expect(res.headers()["content-disposition"]).toContain("attachment");
      // ダウンロードの監査記録（§3.3）
      const log = await db().auditLog.findFirst({
        where: {
          actor: ACCOUNTS[role].loginId,
          action: "file_download",
          result: "success",
          target: { contains: pledgeFileId },
        },
      });
      expect(log, "file_download の監査ログが残ること").not.toBeNull();
    });
  }
});

// ================================================================
// 2. ドキュメント公開範囲（visibility=snc）
// ================================================================
test.describe("visibility=snc ドキュメントのアクセス制御", () => {
  for (const role of ["R9", "R7"] as RoleKey[]) {
    test(`${role} は snc 限定ドキュメントを取得できない（403）`, async ({ page }) => {
      await loginRole(page, role);
      const res = await page.request.get(`/files/${sncDocFileId}`);
      expect(res.status()).toBe(403);
      expect(await res.text()).not.toContain("snc only document body");
    });
  }

  test("R3（SNC運用者）は snc 限定ドキュメントを取得できる（200）", async ({ page }) => {
    await loginRole(page, "R3");
    const res = await page.request.get(`/files/${sncDocFileId}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toBe(SNC_DOC_BODY);
    expect(res.headers()["content-type"]).toContain("application/pdf");
  });
});

// ================================================================
// 3. 未認証・存在しないID
// ================================================================
test("未認証のファイル取得は401", async ({ request }) => {
  const res = await request.get(`/files/${pledgeFileId}`);
  expect(res.status()).toBe(401);
  expect(await res.text()).not.toContain("pledge document body");
});

test("ログイン済みでも存在しないファイルIDは404", async ({ page }) => {
  await loginRole(page, "R2");
  const res = await page.request.get(`/files/${P}-no-such-file-id`);
  expect(res.status()).toBe(404);
});

// ================================================================
// 4. 初回パスワード変更が未完了のアカウントは他機能を使えない（§10.1）
//    専用アカウント（QA14）で実施し、テスト後に削除
// ================================================================
test("mustChangePassword=true のアカウントは403（§10.1）", async ({ page }) => {
  test.setTimeout(120_000);
  const d = db();
  const MCP_ID = `${P}_mustchange_001`;
  const src = await d.account.findUnique({ where: { loginId: ACCOUNTS.R7.loginId } });
  expect(src, "⑦のシードアカウントが存在すること").toBeTruthy();
  await d.account.deleteMany({ where: { loginId: MCP_ID } });
  await d.account.create({
    data: {
      loginId: MCP_ID,
      role: "R7",
      name: `${P} 初回変更未完了`,
      agencyId: src!.agencyId, // 110001（本来は誓約書PDFを閲覧できる立場）
      status: "active",
      passwordHash: src!.passwordHash, // = PW_ADMIN
      mustChangePassword: true,
    },
  });
  created.accountLoginIds.push(MCP_ID);
  try {
    await loginAs(page, MCP_ID, PW_ADMIN);
    // 初回パスワード変更へ誘導される
    await expect(page).toHaveURL(/\/password/);
    const res = await page.request.get(`/files/${pledgeFileId}`);
    expect(res.status(), "パスワード変更完了まで他機能へ遷移不可").toBe(403);
    expect(await res.text()).not.toContain("pledge document body");
  } finally {
    await d.account.deleteMany({ where: { loginId: MCP_ID } });
  }
});
