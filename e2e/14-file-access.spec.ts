/**
 * QA担当: /files/[id] のファイル認可（§3.1 / §3.8 / §10.5 IDOR防止）回帰テスト
 * データプレフィクス: QA14（テストデータは自前で作成し、afterAll で完全に後始末する）
 *
 * 検証方針:
 * - セッションをDBへ直接作る手法は使わず、必ず通常のログインフォーム経由で認証する
 * - src/lib/file-access.ts の全分岐（分岐1 アカウント申請の証跡／分岐2 誓約書PDF／
 *   分岐3 稼働提出物／分岐4 窓口案件の添付／分岐5 お知らせの添付／分岐6 ドキュメント／
 *   孤立ファイル）について、§5.1 の権限マトリクス（permissions.ts）と §3.1 のスコープを
 *   全ロールで突合する
 * - 期待値は「200なら本体が完全一致」「403なら本体マーカーが1バイトも漏れない」の両面で確認する
 *
 * 実行効率のため 1ロール = 1テストとし、ログイン1回で全ファイルの可否行列を検証する。
 */
import { test, expect, Page } from "@playwright/test";
import { fieldAgentScope, completeMfaIfNeeded, ACCOUNTS, PW_ADMIN, RoleKey, db } from "./helpers";

const P = "QA14";
// 403時に本体が1バイトも返っていないことを確認するための共通マーカー
const MARKER = "do-not-leak-body";

// ---------------------------------------------------------------------------
// 検証対象ファイル（file-access.ts の分岐 × スコープの組み合わせを網羅する）
// ---------------------------------------------------------------------------
const FILE_KEYS = [
  // 分岐1: アカウント申請の証跡
  "reqSnc", // agencyId=NULL（SNC内部申請）／作成者=③
  "reqAgency", // agencyId=210001（2次店の申請）／作成者=⑧
  // 分岐2: 訪販員申請の誓約書PDF
  "pledgeP1", // 110001（⑦の自店）所属販売員の申請
  "pledgeP2", // 150008（他の1次店）所属販売員の申請
  "pledgeR9Self", // ⑨本人（110001C001）の申請
  // 分岐3: 稼働提出物
  "subP1", // 提出元=210001 / 1次店=110001
  "subP2", // 提出元=250008 / 1次店=150008
  // 分岐4: 窓口案件メッセージの添付
  "caseHl", // HL案件（1次店=110001）
  "caseHl190", // HL案件（1次店=190001＝稼働終了。⑩のスコープ）
  "caseCsc", // 消費者センター案件（1次店=110001）
  // 分岐5: お知らせの添付
  "annDraftAll", // 下書き（全体向け）
  "annStoppedAll", // 停止中（全体向け）
  "annSentAll", // 送信済み（全体向け）
  "annSentPrimary", // 送信済み（1次店向け）
  "annDummySentAll", // 送信済み（全体向け・④ダミー表示用データ）
  // 分岐6: ドキュメント
  "docAll", // visibility=all
  "docPrimary", // visibility=primary
  "docSnc", // visibility=snc
  "docDummyAll", // visibility=all・④ダミー表示用データ
  // 参照元が存在しないファイル（fail-closed）
  "orphan",
] as const;
type FileKey = (typeof FILE_KEYS)[number];

const LABELS: Record<FileKey, string> = {
  reqSnc: "分岐1 アカウント申請の証跡（agencyId=NULL / 作成者=③）",
  reqAgency: "分岐1 アカウント申請の証跡（agencyId=210001 / 作成者=⑧）",
  pledgeP1: "分岐2 誓約書PDF（110001所属）",
  pledgeP2: "分岐2 誓約書PDF（150008所属）",
  pledgeR9Self: "分岐2 誓約書PDF（⑨本人の申請）",
  subP1: "分岐3 稼働提出物（210001→110001）",
  subP2: "分岐3 稼働提出物（250008→150008）",
  caseHl: "分岐4 HL案件の添付（110001）",
  caseHl190: "分岐4 HL案件の添付（190001＝⑩のスコープ）",
  caseCsc: "分岐4 消費者センター案件の添付（110001）",
  annDraftAll: "分岐5 お知らせ添付（draft / 全体向け）",
  annStoppedAll: "分岐5 お知らせ添付（stopped / 全体向け）",
  annSentAll: "分岐5 お知らせ添付（sent / 全体向け）",
  annSentPrimary: "分岐5 お知らせ添付（sent / 1次店向け）",
  annDummySentAll: "分岐5 お知らせ添付（sent / 全体向け / ダミー）",
  docAll: "分岐6 ドキュメント（visibility=all）",
  docPrimary: "分岐6 ドキュメント（visibility=primary）",
  docSnc: "分岐6 ドキュメント（visibility=snc）",
  docDummyAll: "分岐6 ドキュメント（visibility=all / ダミー）",
  orphan: "孤立ファイル（参照元なし）",
};

const bodyOf = (key: FileKey) => `%PDF-1.4\n${P} ${MARKER} ${key}\n%%EOF\n`;

const fileIds = {} as Record<FileKey, string>;

// ---------------------------------------------------------------------------
// 検証対象ロール（§5.1 の①〜⑩ + 他の1次店の⑦）
//   allow = 200 を期待するファイル。列挙しなかったものは全て 403 を期待する。
// ---------------------------------------------------------------------------
type Principal = {
  id: string;
  label: string;
  loginId: string;
  pw: string;
  allow: FileKey[];
};

// SNC管理系（①②）: Airisアカウントの「閲」を持つため証跡は全件参照可（§5.1）。
// スコープは非ダミー全代理店（§3.1）なので、代理店に紐づくファイルはすべて取得できる。
const SNC_VIEW_ALLOW: FileKey[] = [
  "reqSnc",
  "reqAgency",
  "pledgeP1",
  "pledgeP2",
  "pledgeR9Self",
  "subP1",
  "subP2",
  "caseHl",
  "caseHl190",
  "caseCsc",
  "annDraftAll",
  "annStoppedAll",
  "annSentAll",
  "annSentPrimary",
  "docAll",
  "docPrimary",
  "docSnc",
];

const PRINCIPALS: Principal[] = [
  {
    id: "R1",
    label: "①SLシステム管理",
    loginId: ACCOUNTS.R1.loginId,
    pw: ACCOUNTS.R1.pw,
    allow: SNC_VIEW_ALLOW,
  },
  {
    id: "R2",
    label: "②SNC管理者",
    loginId: ACCOUNTS.R2.loginId,
    pw: ACCOUNTS.R2.pw,
    allow: SNC_VIEW_ALLOW,
  },
  {
    id: "R3",
    label: "③SNC運用者",
    loginId: ACCOUNTS.R3.loginId,
    pw: ACCOUNTS.R3.pw,
    // ③は §5.1 の Airisアカウント行で「承」（最終承認）を持つ。§6.1-2 のとおり
    // 承認判断には上長承認証跡の確認が前提となるため、全申請の証跡を取得できる。
    allow: SNC_VIEW_ALLOW,
  },
  {
    id: "R4",
    label: "④SNC閲覧（ダミー表示）",
    loginId: ACCOUNTS.R4.loginId,
    pw: ACCOUNTS.R4.pw,
    // ④は実データへ一切アクセスさせない（§3.5）。ダミー資料のみ取得できる。
    allow: ["docDummyAll"],
  },
  {
    id: "R5",
    label: "⑤HL窓口",
    loginId: ACCOUNTS.R5.loginId,
    pw: ACCOUNTS.R5.pw,
    // ⑤はホットラインのみ（消費者センターは×。§5.1）
    allow: ["caseHl", "caseHl190", "docAll", "docPrimary", "docSnc"],
  },
  {
    id: "R6",
    label: "⑥消費者センター窓口",
    loginId: ACCOUNTS.R6.loginId,
    pw: ACCOUNTS.R6.pw,
    // ⑥は消費者センターのみ（ホットラインは×。§5.1）
    allow: ["caseCsc", "docAll", "docPrimary", "docSnc"],
  },
  {
    id: "R7",
    label: "⑦1次店管理者（110001）",
    loginId: ACCOUNTS.R7.loginId,
    pw: ACCOUNTS.R7.pw,
    // ⑦は §5.1「申/一承」＝1次承認権限を持つ。§6.1-3 のとおり自店スコープ内の申請
    // （reqAgency: 配下2次店210001の申請）の証跡を承認判断のため取得できる。
    // SNC内部申請（reqSnc: agencyId=NULL）はスコープ外のため取得できない。
    allow: [
      "reqAgency",
      "pledgeP1",
      "pledgeR9Self",
      "subP1",
      "caseHl",
      "caseCsc",
      "annSentAll",
      "annSentPrimary",
      "docAll",
      "docPrimary",
    ],
  },
  {
    id: "R8",
    label: "⑧2次店管理者（210001）",
    loginId: ACCOUNTS.R8.loginId,
    pw: ACCOUNTS.R8.pw,
    // 証跡は「自分が作成した申請」のみ。提出物は自店スコープのみ。
    allow: ["reqAgency", "subP1", "annSentAll", "docAll"],
  },
  {
    id: "R9",
    label: "⑨代理店一般（販売員）",
    loginId: ACCOUNTS.R9.loginId,
    pw: ACCOUNTS.R9.pw,
    // ⑨は訪販員申請・稼働提出物の閲覧権限を持たない（自分の申請でも×。§5.1）
    allow: ["annSentAll", "docAll"],
  },
  {
    id: "R10",
    label: "⑩稼働終了代理店（190001）",
    loginId: ACCOUNTS.R10.loginId,
    pw: ACCOUNTS.R10.pw,
    // ⑩は「当該1次代理店の窓口案件のみ」（§3.1）。ドキュメントも×（§5.2）。
    allow: ["caseHl190"],
  },
];

// 他の1次店の⑦（「自店配下のみ」＝スコープ外は403 を確認するため専用に作成する）
const R7B_LOGIN_ID = `${P}_1150008_001`;
const R7B: Principal = {
  id: "R7B",
  label: "⑦1次店管理者（150008・他店）",
  loginId: R7B_LOGIN_ID,
  pw: PW_ADMIN,
  allow: ["pledgeP2", "subP2", "annSentAll", "annSentPrimary", "docAll", "docPrimary"],
};

// ---------------------------------------------------------------------------
// 後始末対象
// ---------------------------------------------------------------------------
const created = {
  storedFileIds: [] as string[],
  accountRequestIds: [] as string[],
  applicationIds: [] as string[],
  salesStaffIds: [] as string[],
  submissionIds: [] as string[],
  caseIds: [] as string[],
  announcementIds: [] as string[],
  documentIds: [] as string[],
  accountLoginIds: [] as string[],
};

async function agencyByCode(code: string) {
  const ag = await db().agency.findUnique({ where: { code } });
  expect(ag, `代理店 ${code} がシードされていること`).toBeTruthy();
  return ag!;
}

async function storeFile(key: FileKey, uploadedBy: string) {
  const data = Buffer.from(bodyOf(key), "utf8");
  const f = await db().storedFile.create({
    data: { name: `${P}-${key}.pdf`, mime: "application/pdf", size: data.length, data, uploadedBy },
  });
  created.storedFileIds.push(f.id);
  fileIds[key] = f.id;
  return f;
}

// ログインフォーム経由の認証（DBへの直接セッション作成は行わない）
async function loginAs(page: Page, loginId: string, password: string) {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "ログイン" }).click();
  await completeMfaIfNeeded(page, loginId); // MFA画面なら通過
}

async function loginRole(page: Page, role: RoleKey) {
  await loginAs(page, ACCOUNTS[role].loginId, ACCOUNTS[role].pw);
}

test.beforeAll(async () => {
  const d = db();
  const p1 = await agencyByCode("110001"); // 1次店（⑦=airis_1110001_001 の所属）
  const p2 = await agencyByCode("150008"); // 別の1次店（⑦B の所属）
  const p3 = await agencyByCode("190001"); // 稼働終了1次店（⑩=airis_1190001_001 の所属）
  const s1 = await agencyByCode("210001"); // 110001配下の2次店（⑧の所属）
  const s3 = await agencyByCode("250008"); // 150008配下の2次店

  // 前回実行の残骸を掃除（一意キーの衝突回避）
  await d.account.deleteMany({ where: { loginId: R7B_LOGIN_ID } });
  await d.case.deleteMany({ where: { caseNo: { startsWith: `${P}-` } } });
  await d.accountRequest.deleteMany({ where: { requestId: { startsWith: `${P}-` } } });
  await d.salesStaff.deleteMany({ where: { salesId: { startsWith: `${P}C` } } });

  // ---- 他の1次店（150008）の⑦アカウント（パスワードはシード⑦のハッシュを流用） ----
  const seedR7 = await d.account.findUnique({ where: { loginId: ACCOUNTS.R7.loginId } });
  expect(seedR7, "⑦のシードアカウントが存在すること").toBeTruthy();
  await d.account.create({
    data: {
      loginId: R7B_LOGIN_ID,
      role: "R7",
      name: `${P} 他店1次店管理者`,
      agencyId: p2.id,
      status: "active",
      passwordHash: seedR7!.passwordHash, // = PW_ADMIN
      mustChangePassword: false,
    },
  });
  created.accountLoginIds.push(R7B_LOGIN_ID);

  // ================= 分岐1: アカウント申請の証跡 =================
  const reqSncFile = await storeFile("reqSnc", ACCOUNTS.R3.loginId);
  const reqSnc = await d.accountRequest.create({
    data: {
      requestId: `${P}-REQ-SNC`,
      role: "R5",
      name: `${P} SNC内部申請`,
      email: `${P}-snc@example.com`,
      agencyId: null, // SNC内部申請（代理店に紐づかない）
      evidenceFileId: reqSncFile.id,
      status: "pending_final",
      createdBy: (
        await d.account.findUniqueOrThrow({
          where: { loginId: ACCOUNTS.R3.loginId },
          select: { id: true },
        })
      ).id, // ③が代行作成（本番同様 Account.id を保存）
      history: [{ event: "requested", at: "2026-08-01", by: ACCOUNTS.R3.loginId }],
    },
  });
  created.accountRequestIds.push(reqSnc.id);

  const reqAgencyFile = await storeFile("reqAgency", ACCOUNTS.R8.loginId);
  const reqAgency = await d.accountRequest.create({
    data: {
      requestId: `${P}-REQ-AGENCY`,
      role: "R8",
      name: `${P} 2次店申請`,
      email: `${P}-agency@example.com`,
      agencyId: s1.id, // 210001
      evidenceFileId: reqAgencyFile.id,
      status: "pending_first",
      createdBy: (
        await d.account.findUniqueOrThrow({
          where: { loginId: ACCOUNTS.R8.loginId },
          select: { id: true },
        })
      ).id, // ⑧が作成（本番同様 Account.id を保存）
      history: [{ event: "requested", at: "2026-08-01", by: ACCOUNTS.R8.loginId }],
    },
  });
  created.accountRequestIds.push(reqAgency.id);

  // ================= 分岐2: 訪販員申請の誓約書PDF =================
  const mkStaff = async (salesId: string, agencyId: string, firstName: string) => {
    const st = await d.salesStaff.create({
      data: {
        salesId,
        lastName: "QA14検証",
        firstName,
        birthDate: "1990-01-01",
        phone: "080-1414-1414",
        agencyId,
        status: "registered",
        firstApproved: true,
        history: [{ event: "requested", at: "2026-08-01", by: "qa14-seed" }],
      },
    });
    created.salesStaffIds.push(st.id);
    return st;
  };
  const mkApplication = async (salesStaffId: string, pledgeFileId: string, agencyCode1: string) => {
    const scope = await fieldAgentScope(salesStaffId);
    const app = await d.fieldAgentApplication.create({
      data: {
        salesStaffId,
        ...scope, // 代理店スコープ列（§3.1）
        applicationType: "稼働",
        products: "マルチ",
        attribute: "社員/契約社員",
        identityType: "免許証",
        pledgeNo: `${P}-${agencyCode1}-${pledgeFileId.slice(-6)}`,
        pledgeFileId,
        agencyCode1,
        status: "registered",
        firstApproved: true,
        history: [{ event: "requested", at: "2026-08-01", by: "qa14-seed" }],
      },
    });
    created.applicationIds.push(app.id);
    return app;
  };

  const staffP1 = await mkStaff(`${P}C110`, p1.id, "誓約書110");
  await mkApplication(staffP1.id, (await storeFile("pledgeP1", ACCOUNTS.R7.loginId)).id, "110001");

  const staffP2 = await mkStaff(`${P}C150`, p2.id, "誓約書150");
  await mkApplication(staffP2.id, (await storeFile("pledgeP2", R7B_LOGIN_ID)).id, "150008");

  // ⑨本人（シードの販売員 110001C001）の訪販員申請
  const r9Staff = await d.salesStaff.findUnique({ where: { salesId: ACCOUNTS.R9.loginId } });
  expect(r9Staff, "⑨のシード販売員が存在すること").toBeTruthy();
  await mkApplication(
    r9Staff!.id,
    (await storeFile("pledgeR9Self", ACCOUNTS.R9.loginId)).id,
    "110001"
  );

  // ================= 分岐3: 稼働提出物 =================
  const mkSubmission = async (key: FileKey, primaryAgencyId: string, submitterAgencyId: string) => {
    const f = await storeFile(key, ACCOUNTS.R8.loginId);
    const sub = await d.submission.create({
      data: {
        kind: "環境ヒアリングシート",
        fiscalYear: 2026,
        targetMonth: "2026-08",
        primaryAgencyId,
        submitterAgencyId,
        fileId: f.id,
        fileName: f.name,
        status: "pending_snc",
        history: [{ event: "submitted", at: "2026-08-01", by: "qa14-seed" }],
      },
    });
    created.submissionIds.push(sub.id);
  };
  await mkSubmission("subP1", p1.id, s1.id);
  await mkSubmission("subP2", p2.id, s3.id);

  // ================= 分岐4: 窓口案件メッセージの添付 =================
  const mkCase = async (key: FileKey, series: string, caseNo: string, primaryAgencyId: string) => {
    const f = await storeFile(key, ACCOUNTS.R5.loginId);
    const c = await d.case.create({
      data: {
        series,
        caseNo,
        templateKind: "フリー入力",
        title: `${P} ${series} 添付検証案件`,
        primaryAgencyId,
        status: "未対応",
        createdBy: series === "HL" ? ACCOUNTS.R5.loginId : ACCOUNTS.R6.loginId,
      },
    });
    created.caseIds.push(c.id);
    await d.caseMessage.create({
      data: {
        caseId: c.id,
        senderSide: "snc",
        senderName: "QA14 窓口",
        body: `${P} 添付ファイル付きメッセージ`,
        fileIds: [{ id: f.id, name: f.name }],
      },
    });
  };
  await mkCase("caseHl", "HL", `${P}-HLC-0001`, p1.id);
  await mkCase("caseHl190", "HL", `${P}-HLC-0002`, p3.id);
  await mkCase("caseCsc", "CSC", `${P}-CSC-0001`, p1.id);

  // ================= 分岐5: お知らせの添付 =================
  const mkAnnouncement = async (
    key: FileKey,
    audience: string,
    status: string,
    isDummy: boolean
  ) => {
    const f = await storeFile(key, ACCOUNTS.R2.loginId);
    const ann = await d.announcement.create({
      data: {
        audience,
        title: `${P} ${key}`,
        body: `${P} 添付ファイル付きお知らせ（${key}）`,
        important: false,
        isDummy,
        status,
        sentAt: status === "draft" ? null : new Date(),
        fileIds: [{ id: f.id, name: f.name }],
        createdBy: ACCOUNTS.R2.loginId,
      },
    });
    created.announcementIds.push(ann.id);
  };
  await mkAnnouncement("annDraftAll", "all", "draft", false);
  await mkAnnouncement("annStoppedAll", "all", "stopped", false);
  await mkAnnouncement("annSentAll", "all", "sent", false);
  await mkAnnouncement("annSentPrimary", "primary", "sent", false);
  await mkAnnouncement("annDummySentAll", "all", "sent", true);

  // ================= 分岐6: ドキュメント =================
  const mkDocument = async (key: FileKey, visibility: string, isDummy: boolean) => {
    const f = await storeFile(key, ACCOUNTS.R3.loginId);
    const doc = await d.document.create({
      data: {
        title: `${P} ${key}`,
        category: "規程",
        visibility,
        isDummy,
        fileId: f.id,
        fileName: f.name,
        createdBy: ACCOUNTS.R3.loginId,
      },
    });
    created.documentIds.push(doc.id);
  };
  await mkDocument("docAll", "all", false);
  await mkDocument("docPrimary", "primary", false);
  await mkDocument("docSnc", "snc", false);
  await mkDocument("docDummyAll", "all", true);

  // ================= 孤立ファイル（どのエンティティからも参照されない） =================
  await storeFile("orphan", ACCOUNTS.R2.loginId);

  // 全ファイルIDが解決されていること（取り違え防止）
  for (const key of FILE_KEYS) {
    expect(fileIds[key], `${key} のファイルが作成されていること`).toBeTruthy();
  }
});

test.afterAll(async () => {
  const d = db();
  await d.submission.deleteMany({ where: { id: { in: created.submissionIds } } });
  // CaseMessage / CaseRead / CaseStatusHistory は Case の onDelete: Cascade で消える
  await d.case.deleteMany({ where: { id: { in: created.caseIds } } });
  await d.announcement.deleteMany({ where: { id: { in: created.announcementIds } } });
  await d.document.deleteMany({ where: { id: { in: created.documentIds } } });
  await d.accountRequest.deleteMany({ where: { id: { in: created.accountRequestIds } } });
  await d.fieldAgentApplication.deleteMany({ where: { id: { in: created.applicationIds } } });
  await d.salesStaff.deleteMany({ where: { id: { in: created.salesStaffIds } } });
  await d.storedFile.deleteMany({ where: { id: { in: created.storedFileIds } } });
  if (created.accountLoginIds.length > 0) {
    // Session / Notification は onDelete: Cascade
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
// 1. 全分岐 × 全ロールの可否行列（§3.1 / §5.1 / §10.5 IDOR防止）
// ================================================================
async function assertAccessMatrix(page: Page, principal: Principal) {
  const allow = new Set<FileKey>(principal.allow);
  for (const key of FILE_KEYS) {
    const res = await page.request.get(`/files/${fileIds[key]}`);
    const expected = allow.has(key) ? 200 : 403;
    const ctx = `${principal.label} × ${LABELS[key]}`;
    expect(res.status(), ctx).toBe(expected);
    const text = await res.text();
    if (expected === 200) {
      expect(text, `${ctx}: 本体が完全一致すること`).toBe(bodyOf(key));
      expect(res.headers()["content-type"], ctx).toContain("application/pdf");
      expect(res.headers()["content-disposition"], ctx).toContain("attachment");
    } else {
      expect(text, `${ctx}: 本体が1バイトも漏れないこと`).not.toContain(MARKER);
    }
  }
}

for (const principal of PRINCIPALS) {
  test(`ファイル認可行列: ${principal.label}`, async ({ page }) => {
    test.setTimeout(120_000);
    await loginAs(page, principal.loginId, principal.pw);
    await assertAccessMatrix(page, principal);
  });
}

test(`ファイル認可行列: ${R7B.label}`, async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, R7B.loginId, R7B.pw);
  await assertAccessMatrix(page, R7B);
});

// ================================================================
// 2. 分岐ごとの要点を明示的に再確認（行列の意図が読めるようにする）
// ================================================================
test("分岐1: agencyId=NULLのSNC内部申請の証跡は⑦⑧が取得できず、①②③と作成者本人は取得できる", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // ⑦（自店＋配下スコープ）・⑧（自店スコープ）とも agencyId=NULL の申請には到達できない
  for (const role of ["R7", "R8"] as RoleKey[]) {
    await loginRole(page, role);
    const res = await page.request.get(`/files/${fileIds.reqSnc}`);
    expect(res.status(), `${role} は agencyId=NULL の証跡を取得できない`).toBe(403);
    expect(await res.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
  // ①②（Airisアカウントの「閲」保持）と③（承認権限者＝当該申請の作成者）は取得できる
  for (const role of ["R1", "R2", "R3"] as RoleKey[]) {
    await loginRole(page, role);
    const res = await page.request.get(`/files/${fileIds.reqSnc}`);
    expect(res.status(), `${role} は SNC内部申請の証跡を取得できる`).toBe(200);
    expect(await res.text()).toBe(bodyOf("reqSnc"));
    await page.context().clearCookies();
  }
  // 申請作成者本人（⑧が作成した申請）は、閲覧権限が無くても自分の申請なら取得できる
  await loginRole(page, "R8");
  const own = await page.request.get(`/files/${fileIds.reqAgency}`);
  expect(own.status(), "⑧は自分が作成した申請の証跡を取得できる").toBe(200);
  expect(await own.text()).toBe(bodyOf("reqAgency"));
});

test("分岐2: 誓約書PDFは⑨が自分の申請でも403 / ⑦は自店配下のみ200・他店⑦は403", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // ⑨は訪販員申請の閲覧権限を持たない（§5.1）ため、自分の申請の誓約書でも取得できない
  await loginRole(page, "R9");
  const self = await page.request.get(`/files/${fileIds.pledgeR9Self}`);
  expect(self.status(), "⑨は自分の訪販員申請の誓約書でも取得できない").toBe(403);
  expect(await self.text()).not.toContain(MARKER);
  await page.context().clearCookies();

  // ⑦（110001）: 自店配下は200 / 他店（150008）の誓約書は403
  await loginRole(page, "R7");
  expect((await page.request.get(`/files/${fileIds.pledgeP1}`)).status()).toBe(200);
  const other = await page.request.get(`/files/${fileIds.pledgeP2}`);
  expect(other.status(), "⑦は他の1次店の誓約書を取得できない").toBe(403);
  expect(await other.text()).not.toContain(MARKER);
  await page.context().clearCookies();

  // 他店⑦（150008）: 自店配下は200 / 110001の誓約書は403
  await loginAs(page, R7B.loginId, R7B.pw);
  expect((await page.request.get(`/files/${fileIds.pledgeP2}`)).status()).toBe(200);
  const cross = await page.request.get(`/files/${fileIds.pledgeP1}`);
  expect(cross.status(), "他店⑦は110001の誓約書を取得できない").toBe(403);
  expect(await cross.text()).not.toContain(MARKER);
});

test("分岐3: 稼働提出物は⑨⑩が403 / ⑦⑧はスコープ内のみ200", async ({ page }) => {
  test.setTimeout(120_000);
  for (const role of ["R9", "R10"] as RoleKey[]) {
    await loginRole(page, role);
    const res = await page.request.get(`/files/${fileIds.subP1}`);
    expect(res.status(), `${role} は稼働提出物を取得できない（§5.1）`).toBe(403);
    expect(await res.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
  // ⑦（110001=1次店側）・⑧（210001=提出元）はスコープ内の提出物のみ200
  for (const role of ["R7", "R8"] as RoleKey[]) {
    await loginRole(page, role);
    expect(
      (await page.request.get(`/files/${fileIds.subP1}`)).status(),
      `${role} スコープ内の提出物`
    ).toBe(200);
    const out = await page.request.get(`/files/${fileIds.subP2}`);
    expect(out.status(), `${role} スコープ外の提出物`).toBe(403);
    expect(await out.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
});

test("分岐4: 案件添付は⑧⑨が403 / ⑦は自店案件のみ200 / ⑤はHLのみ・⑥は消センのみ", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const role of ["R8", "R9"] as RoleKey[]) {
    await loginRole(page, role);
    for (const key of ["caseHl", "caseCsc"] as FileKey[]) {
      const res = await page.request.get(`/files/${fileIds[key]}`);
      expect(res.status(), `${role} × ${LABELS[key]}`).toBe(403);
      expect(await res.text()).not.toContain(MARKER);
    }
    await page.context().clearCookies();
  }
  // ⑦: 自店（110001）案件はHL・消センとも200 / 他店（190001）案件は403
  await loginRole(page, "R7");
  expect((await page.request.get(`/files/${fileIds.caseHl}`)).status()).toBe(200);
  expect((await page.request.get(`/files/${fileIds.caseCsc}`)).status()).toBe(200);
  expect(
    (await page.request.get(`/files/${fileIds.caseHl190}`)).status(),
    "⑦は他店の案件添付を取得できない"
  ).toBe(403);
  await page.context().clearCookies();

  // ⑤: ホットラインのみ
  await loginRole(page, "R5");
  expect((await page.request.get(`/files/${fileIds.caseHl}`)).status()).toBe(200);
  const cscForR5 = await page.request.get(`/files/${fileIds.caseCsc}`);
  expect(cscForR5.status(), "⑤は消費者センター案件の添付を取得できない").toBe(403);
  expect(await cscForR5.text()).not.toContain(MARKER);
  await page.context().clearCookies();

  // ⑥: 消費者センターのみ
  await loginRole(page, "R6");
  expect((await page.request.get(`/files/${fileIds.caseCsc}`)).status()).toBe(200);
  const hlForR6 = await page.request.get(`/files/${fileIds.caseHl}`);
  expect(hlForR6.status(), "⑥はホットライン案件の添付を取得できない").toBe(403);
  expect(await hlForR6.text()).not.toContain(MARKER);
  await page.context().clearCookies();

  // ⑩: 当該1次代理店（190001）の案件のみ
  await loginRole(page, "R10");
  expect((await page.request.get(`/files/${fileIds.caseHl190}`)).status()).toBe(200);
  expect((await page.request.get(`/files/${fileIds.caseHl}`)).status()).toBe(403);
});

test("分岐5: draft/stoppedは①②③のみ200・⑦⑧⑨は403 / sentは宛先ロールのみ200 / ダミーは分離", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // draft / stopped は「変更権限を持つ①②③」のみ
  for (const role of ["R1", "R2", "R3"] as RoleKey[]) {
    await loginRole(page, role);
    for (const key of ["annDraftAll", "annStoppedAll"] as FileKey[]) {
      expect(
        (await page.request.get(`/files/${fileIds[key]}`)).status(),
        `${role} × ${LABELS[key]}`
      ).toBe(200);
    }
    await page.context().clearCookies();
  }
  for (const role of ["R7", "R8", "R9"] as RoleKey[]) {
    await loginRole(page, role);
    for (const key of ["annDraftAll", "annStoppedAll"] as FileKey[]) {
      const res = await page.request.get(`/files/${fileIds[key]}`);
      expect(res.status(), `${role} × ${LABELS[key]}（未配信・配信停止中は閲覧側に出さない）`).toBe(
        403
      );
      expect(await res.text()).not.toContain(MARKER);
    }
    await page.context().clearCookies();
  }
  // sent（全体向け）は⑦⑧⑨が200、sent（1次店向け）は⑦のみ200
  for (const role of ["R7", "R8", "R9"] as RoleKey[]) {
    await loginRole(page, role);
    expect(
      (await page.request.get(`/files/${fileIds.annSentAll}`)).status(),
      `${role} × sent(全体向け)`
    ).toBe(200);
    const primary = await page.request.get(`/files/${fileIds.annSentPrimary}`);
    expect(primary.status(), `${role} × sent(1次店向け)`).toBe(role === "R7" ? 200 : 403);
    if (role !== "R7") expect(await primary.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
  // ④ダミー分離: 実データの添付は④から取得不可 / ダミーの添付は実ロールから取得不可
  await loginRole(page, "R4");
  const realForDummy = await page.request.get(`/files/${fileIds.annSentAll}`);
  expect(realForDummy.status(), "④は実お知らせの添付を取得できない（§3.5）").toBe(403);
  expect(await realForDummy.text()).not.toContain(MARKER);
  await page.context().clearCookies();
  for (const role of ["R2", "R7", "R9"] as RoleKey[]) {
    await loginRole(page, role);
    const dummy = await page.request.get(`/files/${fileIds.annDummySentAll}`);
    expect(dummy.status(), `${role} はダミーお知らせの添付を取得できない（§3.5）`).toBe(403);
    expect(await dummy.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
});

test("分岐6: ドキュメントは公開範囲×ロールで判定され、⑩は403・ダミーは分離される", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // ロールごとにまとめてログイン回数を抑える
  const cases: [RoleKey, FileKey, number][] = [
    // visibility=all: ⑩以外は取得可
    ["R3", "docAll", 200],
    ["R3", "docPrimary", 200],
    ["R3", "docSnc", 200],
    ["R5", "docSnc", 200],
    ["R6", "docPrimary", 200],
    ["R7", "docAll", 200],
    ["R7", "docPrimary", 200],
    ["R7", "docSnc", 403],
    ["R7", "docDummyAll", 403],
    ["R8", "docAll", 200],
    ["R8", "docPrimary", 403],
    ["R8", "docSnc", 403],
    ["R9", "docAll", 200],
    ["R9", "docPrimary", 403],
    ["R9", "docSnc", 403],
    ["R10", "docAll", 403],
    ["R10", "docPrimary", 403],
    ["R10", "docSnc", 403],
    ["R4", "docDummyAll", 200],
    ["R4", "docAll", 403],
    ["R2", "docDummyAll", 403],
  ];
  let current: RoleKey | null = null;
  for (const [role, key, status] of cases) {
    if (current !== role) {
      if (current) await page.context().clearCookies();
      await loginRole(page, role);
      current = role;
    }
    const res = await page.request.get(`/files/${fileIds[key]}`);
    expect(res.status(), `${role} × ${LABELS[key]}`).toBe(status);
    if (status === 403) expect(await res.text()).not.toContain(MARKER);
  }
});

test("孤立ファイル（参照元エンティティなし）は①②でも403（fail-closed）", async ({ page }) => {
  test.setTimeout(60_000);
  for (const role of ["R1", "R2"] as RoleKey[]) {
    await loginRole(page, role);
    const res = await page.request.get(`/files/${fileIds.orphan}`);
    expect(res.status(), `${role} でも孤立ファイルは取得できない`).toBe(403);
    expect(await res.text()).not.toContain(MARKER);
    await page.context().clearCookies();
  }
});

// ================================================================
// 3. ダウンロード監査（§3.3）: 成功・拒否の双方が記録される
// ================================================================
test("ファイル取得の成功・拒否がいずれも監査ログに記録される（§3.3）", async ({ page }) => {
  test.setTimeout(60_000);
  // 拒否（⑧が110001の誓約書PDFを要求）
  await loginRole(page, "R8");
  expect((await page.request.get(`/files/${fileIds.pledgeP1}`)).status()).toBe(403);
  await expect
    .poll(
      async () =>
        db().auditLog.count({
          where: {
            actor: ACCOUNTS.R8.loginId,
            action: "file_download",
            result: "denied",
            target: { contains: fileIds.pledgeP1 },
          },
        }),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(0);
  await page.context().clearCookies();

  // 成功（⑦が自店配下の誓約書PDFを取得）
  await loginRole(page, "R7");
  expect((await page.request.get(`/files/${fileIds.pledgeP1}`)).status()).toBe(200);
  const log = await db().auditLog.findFirst({
    where: {
      actor: ACCOUNTS.R7.loginId,
      action: "file_download",
      result: "success",
      target: { contains: fileIds.pledgeP1 },
    },
  });
  expect(log, "file_download の監査ログが残ること").not.toBeNull();
});

// ================================================================
// 4. 未認証・存在しないID
// ================================================================
test("未認証のファイル取得は401", async ({ request }) => {
  const res = await request.get(`/files/${fileIds.pledgeP1}`);
  expect(res.status()).toBe(401);
  expect(await res.text()).not.toContain(MARKER);
});

test("ログイン済みでも存在しないファイルIDは403（存在オラクル対策で403に統一 §10.5）", async ({
  page,
}) => {
  await loginRole(page, "R2");
  const res = await page.request.get(`/files/${P}-no-such-file-id`);
  expect(res.status()).toBe(403);
});

// ================================================================
// 5. 初回パスワード変更が未完了のアカウントは他機能を使えない（§10.1）
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
    const res = await page.request.get(`/files/${fileIds.pledgeP1}`);
    expect(res.status(), "パスワード変更完了まで他機能へ遷移不可").toBe(403);
    expect(await res.text()).not.toContain(MARKER);

    // ファイル配信だけでなく **CSV出力系のRoute Handler全経路** で同じく拒否されること
    // （SEC-10.1-11。以前は reports/hotline/consumer-center の3経路が素通りしていた）。
    // これらは middleware を介さず route handler が直接 403 を返すため、403 を厳密に要求する
    // （リダイレクトを許容すると、ガードを外しても別要因のリダイレクトで合格してしまう）。
    for (const path of ["/reports/csv?template=visit", "/hotline/csv", "/consumer-center/csv"]) {
      const csv = await page.request.get(path, { maxRedirects: 0 });
      expect(csv.status(), `${path} が初回パスワード変更前に到達可能`).toBe(403);
      expect(await csv.text()).not.toContain(MARKER);
    }
  } finally {
    await d.account.deleteMany({ where: { loginId: MCP_ID } });
  }
});
