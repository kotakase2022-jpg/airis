// QA担当: 日次バッチの督促リマインド（SPEC §7.8 / 要件9-2「督促機能」）
// 対象: POST or GET /api/cron/daily の「1) 期限切れ案件リマインド」
// データプレフィクス: QA25（作成データは afterAll で削除）
//
// 実時間経過は不要。期限（deadline）を過去日にしたケースを作り、実バッチを実行して
// 通知（Notification）・監査ログ・冪等性・対象外ケースの除外を実DBで検証する。
import { test, expect } from "@playwright/test";
import { db } from "./helpers";

const RUN = Date.now().toString(36);
const P = `QA25-${RUN}`;
const CRON_SECRET = process.env.CRON_SECRET ?? "qa-test-secret";
const BASE = process.env.QA_BASE_URL ?? "http://localhost:3100";

// JSTの今日から days 日ずらした YYYY-MM-DD
function jstDate(days: number): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + days * 86400000);
  return d.toISOString().slice(0, 10);
}

const created: { caseIds: string[] } = { caseIds: [] };

async function mkCase(opts: {
  caseNo: string;
  status: string;
  deadline: string | null;
  agencyCode: string;
}): Promise<string> {
  const agency = await db().agency.findUniqueOrThrow({ where: { code: opts.agencyCode } });
  const c = await db().case.create({
    data: {
      series: "HL",
      caseNo: opts.caseNo,
      templateKind: "フリー入力",
      title: `${P} ${opts.caseNo}`,
      primaryAgencyId: agency.id,
      deadline: opts.deadline,
      status: opts.status,
      createdBy: "qa25-seed",
      messages: { create: { senderSide: "snc", senderName: "QA25", body: `${P} 本文` } },
    },
  });
  created.caseIds.push(c.id);
  return c.id;
}

async function runCron(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/api/cron/daily`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// 対象1次店（110001）のR7アカウントID
async function r7AccountIds(): Promise<string[]> {
  const agency = await db().agency.findUniqueOrThrow({ where: { code: "110001" } });
  const rows = await db().account.findMany({
    where: { role: "R7", status: "active", agencyId: agency.id },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

test.afterAll(async () => {
  const d = db();
  for (const id of created.caseIds) {
    await d.caseMessage.deleteMany({ where: { caseId: id } });
    await d.caseStatusHistory.deleteMany({ where: { caseId: id } });
    await d.caseRead.deleteMany({ where: { caseId: id } });
    await d.case.delete({ where: { id } }).catch(() => {});
  }
  await d.notification.deleteMany({ where: { body: { contains: P } } });
  await d.$disconnect();
});

test("認証: Bearerなし→401 / 誤トークン→401（§10.1）", async () => {
  const noAuth = await fetch(`${BASE}/api/cron/daily`);
  expect(noAuth.status).toBe(401);
  const badAuth = await fetch(`${BASE}/api/cron/daily`, {
    headers: { Authorization: "Bearer wrong-secret-xyz" },
  });
  expect(badAuth.status).toBe(401);
});

test("期限超過かつ未完了の案件について、当該1次店のR7へ督促通知が届く（要件9-2）", async () => {
  test.setTimeout(120_000);
  const overdueId = await mkCase({
    caseNo: `${P}-OVERDUE`,
    status: "未対応",
    deadline: jstDate(-3), // 3日前が期限 = 超過
    agencyCode: "110001",
  });

  const r7s = await r7AccountIds();
  expect(r7s.length, "対象1次店のR7アカウントが存在すること").toBeGreaterThan(0);
  const before = await db().notification.count({
    where: { accountId: { in: r7s }, title: { contains: "督促" } },
  });

  const res = await runCron();
  expect(res.status).toBe(200);
  expect(res.body.ok).toBe(true);

  // R7への督促通知が増える
  const after = await db().notification.findMany({
    where: { accountId: { in: r7s }, title: { contains: "督促" } },
    orderBy: { createdAt: "desc" },
  });
  expect(after.length).toBeGreaterThan(before);
  const mine = after.find((n) => (n.body ?? "").includes(`${P}-OVERDUE`));
  expect(mine, "作成した期限超過案件の督促通知が存在する").toBeTruthy();
  // 通知本文・タイトル・遷移先（§7.8）
  expect(mine!.title).toContain("対応期限を過ぎた案件があります");
  expect(mine!.title).toContain(jstDate(-3)); // 期限日が入る
  expect(mine!.link).toBe("/agency-cases");

  // SNC運用者(R3)へはサマリ通知（要件9-2）
  const r3 = await db().account.findMany({
    where: { role: "R3", status: "active" },
    select: { id: true },
  });
  const summary = await db().notification.findFirst({
    where: {
      accountId: { in: r3.map((a) => a.id) },
      title: { contains: "期限超過の窓口案件" },
      body: { contains: `${P}-OVERDUE` },
    },
  });
  expect(summary, "R3へのサマリ通知が存在する").toBeTruthy();
  expect(summary!.link).toBe("/hotline");

  // 監査ログにバッチ実行が残る（§3.3）。
  // バッチは actor="system-cron" / action="daily_batch" で記録する
  // （src/app/api/cron/daily/route.ts）。以前この検証は action に "cron" を含む行を
  // 探しており、実装が actor 側に "cron" を持つため常に見つからなかった（テスト側の誤り）。
  // 列を正しく指定し、併せて result と実行サマリの記録（可観測性）まで検証する。
  const auditRow = await db().auditLog.findFirst({
    where: { actor: "system-cron", action: "daily_batch" },
    orderBy: { createdAt: "desc" },
  });
  expect(auditRow, "日次バッチの監査ログが記録される").toBeTruthy();
  expect(auditRow!.result, "正常終了として記録される").toBe("success");
  expect(auditRow!.target, "実行サマリ（JSON）が監査ログに残る").toBeTruthy();

  expect(overdueId).toBeTruthy();
});

test("対象外の案件（完了 / 期限が未来 / 期限なし）には督促が飛ばない", async () => {
  test.setTimeout(120_000);
  await mkCase({
    caseNo: `${P}-DONE`,
    status: "完了",
    deadline: jstDate(-5), // 期限超過だが完了済み → 対象外
    agencyCode: "110001",
  });
  await mkCase({
    caseNo: `${P}-FUTURE`,
    status: "未対応",
    deadline: jstDate(7), // 未来 → 対象外
    agencyCode: "110001",
  });
  await mkCase({
    caseNo: `${P}-NODEADLINE`,
    status: "未対応",
    deadline: null, // 期限なし → 対象外
    agencyCode: "110001",
  });

  const res = await runCron();
  expect(res.status).toBe(200);

  for (const suffix of ["DONE", "FUTURE", "NODEADLINE"]) {
    const n = await db().notification.count({
      where: { title: { contains: "督促" }, body: { contains: `${P}-${suffix}` } },
    });
    expect(n, `${suffix} は督促対象外`).toBe(0);
  }
});

test("バッチのサマリに期限超過件数と通知件数が含まれる（実行結果の可観測性）", async () => {
  test.setTimeout(120_000);
  const res = await runCron();
  expect(res.status).toBe(200);
  // /api/cron/daily は overdueCases / remindedAccounts を返す（route.ts の summary）
  expect(res.body).toHaveProperty("overdueCases");
  expect(res.body).toHaveProperty("remindedAccounts");
  expect(Number(res.body.overdueCases)).toBeGreaterThan(0); // 前のテストで作った超過案件がある
});

test("再実行しても督促対象の判定は同じ（期限・ステータスに依存し、実行回数で変わらない）", async () => {
  test.setTimeout(120_000);
  const first = await runCron();
  const second = await runCron();
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  // 同じ条件なので対象件数は一致する（通知は毎回送られる=督促の仕様）
  expect(Number(second.body.overdueCases)).toBe(Number(first.body.overdueCases));
});

// ===== 2) 削除後1年経過データの匿名化（§3.4 / §8）=====
//
// 経緯（QA loop5 で実測により検出。計画上の C2）:
//   `batchClient()` が `app.bypass` を張っていなかったため、`prisma/rls.sql` で
//   FORCE ROW LEVEL SECURITY を付けた保護テーブル（SalesStaff / AccountRequest 等）に対し、
//   **接続ロールが BYPASSRLS を持たない環境では例外を出さずに0件**になっていた。
//   ローカルの airis_app（NOBYPASSRLS）で 0件 / app.bypass=on で 1件 になることを実測確認済み。
//   Account は非保護テーブルなので匿名化され、保護テーブルだけ取り残される＝
//   「一部だけ匿名化される」という最も気づきにくい壊れ方だった。
//
// ここでは匿名化そのものの動作（保護・非保護の両テーブルが匿名化されること）を検証する。
// NOBYPASSRLS 接続での再現は `DATABASE_URL_UNPOOLED` を airis_app に向けたサーバが必要なため、
// この spec は既定のサーバ構成で「匿名化が動くこと」を担保する。
// 手順は qa/QA_REPORT.md（loop5）に記載。
test("削除から1年経過したデータが匿名化される（保護テーブル・非保護テーブルの両方）", async () => {
  test.setTimeout(120_000);
  const ANON = "（匿名化済み）";
  const OLD = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  const agency = await db().agency.findFirstOrThrow({ where: { code: "110001" } });
  const loginId = `airis_1110001_x${RUN.slice(-3)}`;

  // 非保護テーブル（Account）
  const account = await db().account.create({
    data: {
      loginId,
      role: "R7",
      name: `${P} 氏名`,
      email: `${P}@example.com`.toLowerCase(),
      agencyId: agency.id,
      status: "deleted",
      deletedAt: OLD,
      passwordHash: "x",
      mustChangePassword: false,
    },
  });
  // 保護テーブル（SalesStaff: FORCE ROW LEVEL SECURITY）
  const staff = await db().salesStaff.create({
    data: {
      salesId: `Q25S${RUN.slice(-4)}`,
      lastName: `${P}姓`,
      firstName: "太郎",
      birthDate: "1990-05-05",
      phone: "090-9999-8888",
      agencyId: agency.id,
      status: "deleted",
      deletedAt: OLD,
      firstApproved: true,
      history: [],
    },
  });
  // 保護テーブル（AccountRequest: FORCE ROW LEVEL SECURITY）。発行先アカウントに連動する
  const req = await db().accountRequest.create({
    data: {
      requestId: `Q25R${RUN.slice(-4)}`,
      role: "R7",
      name: `${P} 申請者`,
      email: `${P}-req@example.com`.toLowerCase(),
      agencyId: agency.id,
      status: "approved",
      issuedLoginId: loginId,
      history: [],
    },
  });

  try {
    const { status, body } = await runCron();
    expect(status).toBe(200);
    const anonymized = body.anonymized as Record<string, number>;
    // サマリで件数が観測できること（0件と「対象なし」を区別するため）
    expect(
      anonymized.accounts,
      `Account が匿名化されていない: ${JSON.stringify(anonymized)}`
    ).toBeGreaterThan(0);
    expect(
      anonymized.salesStaff,
      `保護テーブル SalesStaff が匿名化されていない（RLSでサイレント0件の疑い）: ${JSON.stringify(anonymized)}`
    ).toBeGreaterThan(0);
    expect(
      anonymized.accountRequests,
      `保護テーブル AccountRequest が匿名化されていない: ${JSON.stringify(anonymized)}`
    ).toBeGreaterThan(0);

    // DB実体で確認（件数だけ合っていて中身が消えていない、を防ぐ）
    const a = await db().account.findUniqueOrThrow({ where: { id: account.id } });
    expect(a.name).toBe(ANON);
    expect(a.anonymizedAt).not.toBeNull();

    const s = await db().salesStaff.findUniqueOrThrow({ where: { id: staff.id } });
    expect(s.lastName, "販売員の氏名が残っている").toBe(ANON);
    expect(s.phone, "販売員の電話番号が残っている").not.toBe("090-9999-8888");
    expect(s.anonymizedAt).not.toBeNull();

    const r = await db().accountRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(r.name, "申請の氏名が残っている").toBe(ANON);
    expect(r.email, "申請のメールが残っている").toBe(ANON);
    expect(r.anonymizedAt).not.toBeNull();

    // 冪等性: 再実行しても二重処理されない（anonymizedAt IS NULL で絞っている）
    const second = await runCron();
    const again = second.body.anonymized as Record<string, number>;
    expect(again.accountRequests, "匿名化済みを再度処理している").toBe(0);
  } finally {
    await db().statusHistory.deleteMany({ where: { entityId: { in: [account.id, staff.id] } } });
    await db().accountRequest.deleteMany({ where: { id: req.id } });
    await db().salesStaff.deleteMany({ where: { id: staff.id } });
    await db().account.deleteMany({ where: { id: account.id } });
  }
});
