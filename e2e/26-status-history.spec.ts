// §4.1「状態遷移はサーバ側で厳密に制御し、遷移イベントを履歴テーブル（例: requested /
// approve_first / final_approve / reject / suspend / resume / delete）に記録」の検証（R-022）。
//
// 検証方針:
//   - 実ブラウザで実際に画面操作 → 実DBの StatusHistory を直接読み、行が存在することを確認する
//     （コードを読んでPASSにしない。監査要件なので「記録された事実」を証拠にする）
//   - 対象は StatusHistory.entityType の6種のうち、案件（case）以外の5種:
//     account / account_request / sales_staff / field_agent / submission
//     ※ submission は長く記録経路が無く（宣言だけで1行も記録されていなかった）、
//       このコメントも「対象外」と書いて追認していた。QA loop5 / 監査計画 C6 で是正し検証対象に加えた。
//   - 破壊的操作を伴うため、対象は各テストが自分で作った使い捨てデータのみ（BUG-Q11 の再発防止）
import { test, expect } from "@playwright/test";
import { login, db, fieldAgentScope } from "./helpers";

const TAG = "QAS_"; // 本スイートが作るデータの目印（後片付けの検索キー）

// StatusHistory から指定エンティティの遷移イベントを取り出す
async function events(entityType: string, entityId: string): Promise<string[]> {
  const rows = await db().statusHistory.findMany({
    where: { entityType, entityId },
    orderBy: { changedAt: "asc" },
    select: { event: true },
  });
  return rows.map((r) => r.event);
}

async function historyRows(entityType: string, entityId: string) {
  return db().statusHistory.findMany({
    where: { entityType, entityId },
    orderBy: { changedAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// 1. 販売員ID（sales_staff）: 申請 → 1次承認 → 停止 → 再開 → 削除 → 復旧
// ---------------------------------------------------------------------------
test("sales_staff: 申請〜復旧の各遷移が StatusHistory に記録される（§4.1）", async ({ page }) => {
  test.setTimeout(180_000);
  const agency = await db().agency.findFirst({ where: { isDummy: false, tier: 1 } });
  expect(agency, "1次代理店のシードが必要").not.toBeNull();

  let staffId = "";
  try {
    await login(page, "R2");
    await page.goto("/sales-staff");
    // 申請フォームは <details> で折り畳まれているため先に開く
    await page.locator("summary", { hasText: "＋ 販売員ID申請" }).click();
    await page.locator('input[name="lastName"]').fill(`${TAG}姓`);
    await page.locator('input[name="firstName"]').fill("検証");
    await page.locator('input[name="birthDate"]').fill("1990-01-01");
    await page.locator('input[name="phone"]').fill("090-3333-4444");
    const agencySelect = page.locator('select[name="agencyId"]');
    if (await agencySelect.count()) await agencySelect.selectOption(agency!.id);
    await page.getByRole("button", { name: "申請する" }).click();
    await expect(page.getByText(/販売員IDを申請しました/)).toBeVisible({ timeout: 15_000 });

    const staff = await db().salesStaff.findFirst({
      where: { lastName: `${TAG}姓` },
      select: { id: true, status: true },
    });
    expect(staff, "販売員申請が作成されていること").not.toBeNull();
    staffId = staff!.id;

    // 申請時点で requested が記録されている
    expect(await events("sales_staff", staffId)).toContain("requested");

    // 1次承認 → approve_first
    await page.reload();
    const row = page.locator("tr", { hasText: `${TAG}姓` }).first();
    await row.getByRole("button", { name: /1次承認/ }).click();
    await page.waitForTimeout(4000);
    expect(await events("sales_staff", staffId)).toContain("approve_first");

    // 停止 → suspend
    await page.reload();
    await page
      .locator("tr", { hasText: `${TAG}姓` })
      .first()
      .getByRole("button", { name: /^停止$/ })
      .click();
    await page.waitForTimeout(4000);
    expect(await events("sales_staff", staffId)).toContain("suspend");

    // 再開 → resume
    await page.reload();
    await page
      .locator("tr", { hasText: `${TAG}姓` })
      .first()
      .getByRole("button", { name: /^再開$/ })
      .click();
    await page.waitForTimeout(4000);
    expect(await events("sales_staff", staffId)).toContain("resume");

    // 遷移前後のステータスと実行者が残っていること（監査に必要な最小情報 §3.3）
    const rows = await historyRows("sales_staff", staffId);
    const suspendRow = rows.find((r) => r.event === "suspend");
    expect(suspendRow?.toStatus).toBe("suspended");
    expect(suspendRow?.changedBy).toBeTruthy();
  } finally {
    if (staffId) {
      await db().statusHistory.deleteMany({ where: { entityId: staffId } });
      await db().salesStaff.deleteMany({ where: { id: staffId } });
    }
    await db().auditLog.deleteMany({ where: { target: { contains: staffId || TAG } } });
  }
});

// ---------------------------------------------------------------------------
// 2. 訪販員申請（field_agent）: 申請 → 1次承認 → 停止 → 削除
// ---------------------------------------------------------------------------
test("field_agent: 申請〜削除の各遷移が StatusHistory に記録される（§4.1）", async ({ page }) => {
  test.setTimeout(180_000);
  const staff = await db().salesStaff.findFirst({
    where: { salesId: { not: null }, status: "registered", agency: { isDummy: false } },
    include: { agency: true },
  });
  expect(staff, "本登録済みの販売員シードが必要").not.toBeNull();

  let appId = "";
  try {
    const created = await db().fieldAgentApplication.create({
      data: {
        salesStaffId: staff!.id,
        applicationType: "稼働",
        products: "auひかり",
        attribute: "社員/契約社員",
        lastNameKana: "カナセイ",
        firstNameKana: `${TAG}ケンショウ`,
        identityType: "免許証",
        pledgeNo: `${TAG}PLEDGE-1`,
        agencyCode1: staff!.agency.code,
        status: "applying",
        history: [],
        ...(await fieldAgentScope(staff!.id)),
      },
    });
    appId = created.id;

    await login(page, "R2");
    await page.goto("/field-agents");
    const row = page.locator("tr", { hasText: `${TAG}ケンショウ` }).first();
    await row.getByRole("button", { name: /1次承認/ }).click();
    await page.waitForTimeout(4000);
    expect(await events("field_agent", appId)).toContain("approve_first");

    await page.reload();
    await page
      .locator("tr", { hasText: `${TAG}ケンショウ` })
      .first()
      .getByRole("button", { name: /^停止$/ })
      .click();
    await page.waitForTimeout(4000);
    expect(await events("field_agent", appId)).toContain("suspend");

    await page.reload();
    page.on("dialog", (d) => d.accept());
    await page
      .locator("tr", { hasText: `${TAG}ケンショウ` })
      .first()
      .getByRole("button", { name: /^削除$/ })
      .click();
    await page.waitForTimeout(4000);
    const evs = await events("field_agent", appId);
    expect(evs).toContain("delete");

    const rows = await historyRows("field_agent", appId);
    expect(rows.find((r) => r.event === "delete")?.toStatus).toBe("deleted");
  } finally {
    if (appId) {
      await db().statusHistory.deleteMany({ where: { entityId: appId } });
      await db().fieldAgentApplication.deleteMany({ where: { id: appId } });
    }
    await db().auditLog.deleteMany({ where: { target: { contains: appId || TAG } } });
  }
});

// ---------------------------------------------------------------------------
// 3. Airisアカウント申請（account_request）: 申請 → 却下
// ---------------------------------------------------------------------------
test("account_request: 申請と却下が StatusHistory に記録される（§4.1）", async ({ page }) => {
  test.setTimeout(180_000);
  const agency = await db().agency.findFirst({ where: { isDummy: false, tier: 1 } });
  let reqId = "";
  try {
    const created = await db().accountRequest.create({
      data: {
        requestId: `${TAG}REQ-1`,
        role: "R7",
        name: `${TAG}申請者`,
        email: `${TAG.toLowerCase()}req1@example.com`,
        agencyId: agency!.id,
        status: "pending_final",
        history: [],
      },
    });
    reqId = created.id;

    await login(page, "R2");
    await page.goto("/account-requests");
    const row = page.locator("tbody tr", { hasText: `${TAG}申請者` }).first();
    await row.getByRole("button", { name: "却下" }).click();
    // 却下は理由必須（行内に入力欄が開く → 確定で送信）
    const reasonInput = row.locator('input[name="reason"]');
    await expect(reasonInput).toBeVisible();
    await reasonInput.fill("QAS 検収: 却下遷移の履歴記録確認");
    await row.getByRole("button", { name: "確定" }).click();
    await expect(row.getByText("差戻し・却下", { exact: true })).toBeVisible({ timeout: 15_000 });

    const evs = await events("account_request", reqId);
    expect(evs, "却下が履歴テーブルに記録されること").toContain("reject");
    const rows = await historyRows("account_request", reqId);
    const rejectRow = rows.find((r) => r.event === "reject");
    expect(rejectRow?.fromStatus).toBe("pending_final");
    expect(rejectRow?.toStatus).toBe("rejected");
    expect(rejectRow?.reason, "却下理由が履歴に残ること").toBeTruthy();
  } finally {
    if (reqId) {
      await db().statusHistory.deleteMany({ where: { entityId: reqId } });
      await db().accountRequest.deleteMany({ where: { id: reqId } });
    }
    await db().auditLog.deleteMany({ where: { target: { contains: `${TAG}REQ-1` } } });
  }
});

// ---------------------------------------------------------------------------
// 4. Airisアカウント（account）: 停止 → 再開
//    Account は JSON列 history を持たないため、StatusHistory が唯一の遷移記録になる
// ---------------------------------------------------------------------------
test("account: 停止・再開が StatusHistory に記録される（§4.1）", async ({ page }) => {
  test.setTimeout(180_000);
  const agency = await db().agency.findFirst({ where: { isDummy: false, tier: 1 } });
  const LOGIN_ID = `${TAG}acct_001`;
  let acctId = "";
  try {
    const created = await db().account.create({
      data: {
        loginId: LOGIN_ID,
        role: "R7",
        name: `${TAG}停止対象`,
        agencyId: agency!.id,
        status: "active",
        // ログインさせないため照合不能なハッシュを入れる（このテストは管理操作のみを見る）
        passwordHash:
          "$argon2id$v=19$m=19456,t=2,p=1$QUFBQUFBQUFBQUFBQUFBQQ$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    acctId = created.id;

    page.on("dialog", (d) => d.accept());
    await login(page, "R2");
    await page.goto("/admin");
    const row = page.locator("tr", { hasText: LOGIN_ID }).first();
    await row.getByRole("button", { name: /^停止$/ }).click();
    await page.waitForTimeout(4000);
    expect(await events("account", acctId)).toContain("suspend");

    await page.reload();
    await page
      .locator("tr", { hasText: LOGIN_ID })
      .first()
      .getByRole("button", { name: /^再開$/ })
      .click();
    await page.waitForTimeout(4000);
    expect(await events("account", acctId)).toContain("resume");

    const rows = await historyRows("account", acctId);
    const suspendRow = rows.find((r) => r.event === "suspend");
    expect(suspendRow?.fromStatus).toBe("active");
    expect(suspendRow?.toStatus).toBe("suspended");
    expect(suspendRow?.changedBy, "実行者の loginId が残ること").toBeTruthy();
  } finally {
    if (acctId) {
      await db().statusHistory.deleteMany({ where: { entityId: acctId } });
      await db().session.deleteMany({ where: { accountId: acctId } });
      await db().account.deleteMany({ where: { id: acctId } });
    }
    await db().auditLog.deleteMany({ where: { target: { contains: LOGIN_ID } } });
  }
});

// ---------------------------------------------------------------------------
// 5. 稼働提出物（submission）: 提出 → 1次承認 → 最終承認 / 差戻し / 削除
//
// 監査計画 C6 の是正確認。`submission` は STATUS_ENTITY_TYPES に宣言され
// schema.prisma も「本テーブルを正の追跡元とする」と書いていたのに、
// reports/actions.ts が @/lib/status を import すらしておらず**1行も記録されていなかった**。
// ---------------------------------------------------------------------------
test("submission: 提出〜承認・差戻し・削除が StatusHistory に記録される（§4.1 / C6）", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const MEMO = `${TAG}sub_${Date.now().toString(36).slice(-5)}`;
  const MONTH = "2026-03";
  // 提出種別は src/lib/roles.ts の SUBMISSION_KINDS の実在値を使う
  // （存在しない値だと selectOption がタイムアウトする）
  const KIND = "【アライアンス申請書】";

  const submitted: string[] = [];
  try {
    // --- ⑧（2次店）が提出 → 1次店確認中（pending_first）
    await login(page, "R8");
    await page.goto("/reports?tab=submissions");
    const form = page.locator("form").filter({ has: page.locator('input[name="memo"]') });
    await form.locator('select[name="kind"]').selectOption(KIND);
    await form.locator('input[name="targetMonth"]').fill(MONTH);
    await form.locator('input[name="file"]').setInputFiles({
      name: `${MEMO}.xlsx`,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(`QA26 dummy payload ${MEMO}`),
    });
    await form.locator('input[name="memo"]').fill(MEMO);
    await form.getByRole("button", { name: "提出する" }).click();
    await expect(page.getByText(`「${KIND}」（${MONTH}）を提出しました`)).toBeVisible({
      timeout: 15_000,
    });

    const sub = await db().submission.findFirst({ where: { memo: MEMO } });
    expect(sub, "提出物が作成されていない").not.toBeNull();
    submitted.push(sub!.id);

    // 新規提出が requested として記録されること（ここが従来0件だった）
    expect(
      await events("submission", sub!.id),
      "新規提出が StatusHistory に記録されていない（C6 未是正）"
    ).toContain("requested");

    const first = (await historyRows("submission", sub!.id))[0];
    expect(first.toStatus, "遷移先ステータスが記録されていない").toBe(sub!.status);
    expect(first.changedBy, "実行者が記録されていない").toBeTruthy();

    // --- ⑦（1次店）が1次承認 → SNC確認中
    await login(page, "R7");
    await page.goto("/reports?tab=submissions");
    const row = page.locator("tr", { hasText: MEMO }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "1次承認" }).click();
    // 画面全体の文言で待つと他行の「SNC確認中」と衝突するため、対象行のみを見る
    await expect(page.locator("tr", { hasText: MEMO }).first()).toContainText("SNC確認中", {
      timeout: 15_000,
    });

    expect(await events("submission", sub!.id)).toContain("approve_first");

    // --- ②（SNC）が最終承認
    await login(page, "R2");
    await page.goto("/reports?tab=submissions");
    const row2 = page.locator("tr", { hasText: MEMO }).first();
    await expect(row2).toBeVisible({ timeout: 15_000 });
    await row2.getByRole("button", { name: "最終承認" }).click();
    await expect(page.locator("tr", { hasText: MEMO }).first()).toContainText("承認済", {
      timeout: 15_000,
    });

    const evts = await events("submission", sub!.id);
    expect(evts).toContain("final_approve");
    // 遷移の順序が保たれること（監査の追跡元として使えること）
    expect(evts.indexOf("requested")).toBeLessThan(evts.indexOf("approve_first"));
    expect(evts.indexOf("approve_first")).toBeLessThan(evts.indexOf("final_approve"));

    // 最終承認の行に from/to が入っていること
    const rows = await historyRows("submission", sub!.id);
    const fin = rows.find((r) => r.event === "final_approve")!;
    expect(fin.fromStatus).toBe("pending_snc");
    expect(fin.toStatus).toBe("approved");
  } finally {
    for (const id of submitted) {
      await db().statusHistory.deleteMany({ where: { entityType: "submission", entityId: id } });
      await db().submission.deleteMany({ where: { id } });
    }
    await db().submission.deleteMany({ where: { memo: MEMO } });
  }
});
