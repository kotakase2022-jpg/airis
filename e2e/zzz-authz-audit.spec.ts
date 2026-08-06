// 独立第三者による認可バイパス監査で検出した3件の、**是正後の回帰テスト**。
//
// 元は「欠陥が存在すること」を実証するスペックだったが、AUTHZ-1 / AUTHZ-3 の欠陥を是正したため
// 期待値を「塞がれていること」へ反転させ、同じ攻撃手順が通らないことの回帰テストとして残す。
// 使い捨てデータは ZZZAUDIT プレフィクスで作成し、afterAll で必ず後片付けする
// （シードアカウントのハッシュ・パスワードは触らない）。
//
// 検証対象:
//   AUTHZ-1  §14-2 実効ロール: 稼働終了1次店の配下2次店の⑧が⑩に解決される（是正済み）
//   AUTHZ-2  §5.2 ページアクセス: ③（SNC運用者）が管理画面と管理CSVに到達できる（発注者指示 OWN-014）
//   AUTHZ-3  §4.2/§6.1-3 職務分離: ③は①②のMFA/パスワードをリセットできない（是正済み）
import { test, expect } from "@playwright/test";
import { ACCOUNTS, PW_GENERAL, db, login } from "./helpers";

const AUDIT_R1_LOGIN = "ZZZAUDIT_slb_sys_900";

async function cleanup() {
  const d = db();
  // 稼働終了に切り替えた共有シード行を必ず復元（AUTHZ-1）
  await d.agency.updateMany({ where: { code: "110001" }, data: { status: "active" } });
  const acc = await d.account.findUnique({ where: { loginId: AUDIT_R1_LOGIN } });
  if (acc) {
    await d.session.deleteMany({ where: { accountId: acc.id } });
    await d.notification.deleteMany({ where: { accountId: acc.id } });
    await d.passwordHistory.deleteMany({ where: { accountId: acc.id } });
    await d.account.delete({ where: { id: acc.id } });
  }
}

test.beforeAll(cleanup);
test.afterAll(async () => {
  await cleanup();
  await db().$disconnect();
});

// ---------------------------------------------------------------------------
// AUTHZ-1: §14-2「Agencyのステータスを稼働終了に切替えると当該1次店の⑦と
//          **配下2次店の⑧** の実効ロールが⑩に解決される」
// 実装（src/lib/session.ts:63）は自アカウントの所属代理店の status しか見ないため、
// 1次店だけを稼働終了にすると配下2次店の⑧は⑧のまま残る。
// ---------------------------------------------------------------------------
test("AUTHZ-1: 1次店を稼働終了にすると配下2次店の⑧が⑩に解決される（§14-2 の是正確認）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const d = db();

  // updateAgencyAction（src/app/(app)/agencies/actions.ts:109）は対象1行の status のみ更新し
  // 配下2次店へ伝播しない。UI操作と同じ結果になるようDBで1行だけ更新する。
  await d.agency.updateMany({ where: { code: "110001" }, data: { status: "closed" } });
  const parent = await d.agency.findUniqueOrThrow({ where: { code: "110001" } });
  const child = await d.agency.findUniqueOrThrow({ where: { code: "210001" } });
  expect(parent.status).toBe("closed");
  expect(child.status).toBe("active"); // 配下は active のまま
  const r8 = await d.account.findUniqueOrThrow({ where: { loginId: ACCOUNTS.R8.loginId } });
  expect(r8.agencyId).toBe(child.id); // ⑧は稼働終了1次店の配下2次店に所属

  await login(page, "R8");
  await expect(page).toHaveURL(/\/dashboard/);

  // ⑩に解決されているので「稼働終了代理店」バッジが出て、メニューは⑩の範囲に絞られる（§11.1 / §5.2）
  const badge = page.locator("aside").getByText("稼働終了代理店");
  const navTexts = await page.locator("aside nav a").allInnerTexts();
  console.log("[AUTHZ-1] R8 sidebar =", JSON.stringify(navTexts));
  expect(await badge.count(), "⑩に解決されていない（稼働終了バッジが出ない）").toBeGreaterThan(0);
  expect(navTexts, "⑩では×の販売員ID管理が見えている（§5.2）").not.toContain("販売員ID管理");
  expect(navTexts, "⑩では×の各種資料の提出が見えている（§5.2）").not.toContain("各種資料の提出");

  // ⑩は窓口案件以外へ到達できない（requirePage が /dashboard?denied= へ戻す §5.2）
  for (const url of ["/sales-staff", "/field-agents", "/reports", "/announcements"]) {
    await page.goto(url);
    await expect(page, `⑩が到達できてはいけないページ: ${url}`).toHaveURL(/\/dashboard/);
  }
  // 窓口案件（代理店側）だけは到達できる（§4「稼働終了代理店（⑩）: 当該1次代理店の窓口案件のみ」）
  await page.goto("/agency-cases");
  await expect(page, "⑩が窓口案件に入れない").toHaveURL(/\/agency-cases/);

  // 書き込みも通らない: ⑩は販売員ID管理へ到達できないため申請フォーム自体が存在しない
  await page.goto("/sales-staff");
  await expect(page).toHaveURL(/\/dashboard/);
  expect(
    await page.locator("summary", { hasText: "＋ 販売員ID申請" }).count(),
    "⑩に販売員ID申請フォームが見えている"
  ).toBe(0);

  await d.agency.updateMany({ where: { code: "110001" }, data: { status: "active" } });
});

// ---------------------------------------------------------------------------
// AUTHZ-2: ③の管理画面アクセスは〇（発注者指示 2026-08-05 / OWN-014）だが、
//          監査記録には到達不可（発注者指示 2026-08-06）。
//          §7.1「管理画面（①②のみ）: 直近の監査イベント」/ §7.2「棚卸CSV、アクセスログCSV」
// ---------------------------------------------------------------------------
test("AUTHZ-2: ③は管理画面に入れるが、監査ログ/アクセスログ/棚卸CSVには到達できない（§7.1 / §7.2）", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, "R3");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin/); // 発注者指示 OWN-014 により③は入れる
  await expect(
    page.getByRole("heading", { name: /管理画面|アカウント管理/ }).first()
  ).toBeVisible();

  // 1) CSV出力の3種はいずれも403（API層）
  for (const type of ["audit", "access", "inventory"]) {
    const res = await page.request.get(`/admin/csv?type=${type}`, { maxRedirects: 0 });
    const body = await res.text();
    console.log(`[AUTHZ-2] R3 GET /admin/csv?type=${type} -> ${res.status()} len=${body.length}`);
    expect(res.status(), `③が /admin/csv?type=${type} に到達できる`).toBe(403);
  }

  // 2) 画面にもログのセクション・CSV出力ボタンが出ない（UI層）
  const bodyText = await page.locator("body").innerText();
  expect(bodyText, "③にアクセスログのセクションが見えている").not.toContain("アクセスログ（直近");
  expect(bodyText, "③に監査ログのセクションが見えている").not.toContain("監査ログ（直近");
  const links = await page.locator('a[href^="/admin/csv"]').count();
  console.log(`[AUTHZ-2] ③に見える /admin/csv リンク数: ${links}`);
  expect(links, "③にCSV出力リンクが見えている").toBe(0);

  // 3) ③に必要な業務（アカウント一覧の参照）は従来どおりできる
  await expect(page.locator("tbody tr").first(), "③がアカウント一覧を見られない").toBeVisible();

  // 4) 対照: ②は3種すべて取得できる（制限が③に限定されており過剰でないこと）
  await login(page, "R2");
  for (const type of ["audit", "access", "inventory"]) {
    const res = await page.request.get(`/admin/csv?type=${type}`);
    console.log(`[AUTHZ-2] 対照 R2 GET /admin/csv?type=${type} -> ${res.status()}`);
    expect(res.status(), `②が /admin/csv?type=${type} を取得できない`).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(50);
  }
});

// ---------------------------------------------------------------------------
// AUTHZ-3: ③が①（サスラボ社システム管理=全権）のMFAとパスワードをリセットでき、
//          表示された一時パスワードで当該アカウントにログインできる（＝乗っ取り）。
// §4.2 は「MFAリセット・パスワードリセットは管理者代行フロー（②③が実行）」と定めるが、
// 対象アカウントのロール制限が無い。要件1-1 /§6.1-3 は「SNC一般以上のアカウント発行・
// 権限変更・停止・削除は必ず②の承認」を要求しており、①②の資格情報リセットは
// 実質的に権限移転にあたる（account-requests 側では canFinalApproveRequest() で
// ③を⑦⑧⑩に限定しているのに、管理画面のリセット経路には同じ制限が無い）。
// ---------------------------------------------------------------------------
test("AUTHZ-3: ③は①アカウントのMFA・パスワードをリセットできない（§4.2 / §6.1-3 職務分離）", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const d = db();

  // 使い捨ての①アカウントを用意（シードの airis_slb_sys_001 には触らない）
  const donor = await d.account.findUniqueOrThrow({ where: { loginId: ACCOUNTS.R8.loginId } });
  const target = await d.account.create({
    data: {
      loginId: AUDIT_R1_LOGIN,
      role: "R1",
      name: "ZZZAUDIT 監査用サスラボ管理",
      email: "zzzaudit-slb@example.com",
      status: "active",
      passwordHash: donor.passwordHash,
      pepperVersion: donor.pepperVersion,
      mfaEnabled: true,
      mfaSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
      mustChangePassword: false,
    },
  });

  await login(page, "R3");
  await page.goto(`/admin?q=${AUDIT_R1_LOGIN}`);
  const row = page.locator("tbody tr", { hasText: AUDIT_R1_LOGIN });
  await expect(row).toHaveCount(1);

  // 1) UI層: ③には①のリセットボタンが出ない（§3.2 の1層目）
  const buttons = (await row.locator("button").allInnerTexts()).map((s) => s.trim());
  console.log("[AUTHZ-3] R3 が見る①の行のボタン:", JSON.stringify(buttons));
  expect(buttons, "③に①のMFAリセットが見えている").not.toContain("MFAリセット");
  expect(buttons, "③に①のPWリセットが見えている").not.toContain("PWリセット");

  // 2) API層: ③が **正当に持っている** リセットフォーム（⑦の行）の id を①へ差し替えて送る。
  //    UI層でボタンが消えているだけでは不十分なので、サーバ側の再検証を直接突く（§3.2 の2層目）。
  page.on("dialog", (d0) => d0.accept());
  for (const op of ["mfa_reset", "reset_password"]) {
    await page.goto(`/admin?q=${encodeURIComponent(ACCOUNTS.R7.loginId)}`);
    // ③は⑦のリセット代行を行えるため、この行には op ボタンを持つフォームが存在する
    await expect(
      page.locator('form button[name="op"]').first(),
      "③が⑦のリセットフォームを持っていない（前提が崩れている）"
    ).toBeVisible();
    const injected = await page.evaluate(
      ({ op, id }) => {
        const btn = document.querySelector('form button[name="op"]') as HTMLButtonElement | null;
        const form = btn?.closest("form") as HTMLFormElement | null;
        if (!form) return false;
        const set = (name: string, value: string) => {
          form.querySelectorAll(`input[name="${name}"]`).forEach((e) => e.remove());
          const i = document.createElement("input");
          i.type = "hidden";
          i.name = name;
          i.value = value;
          form.appendChild(i);
        };
        // ボタン由来の op を無効化してから、狙った op と対象IDを差し込む
        form.querySelectorAll('button[name="op"]').forEach((b) => b.removeAttribute("name"));
        set("op", op);
        set("id", id);
        form.requestSubmit();
        return true;
      },
      { op, id: target.id }
    );
    expect(injected, `op=${op} の注入先フォームが見つからない`).toBe(true);
    await page.waitForTimeout(4000);

    const after = await d.account.findUniqueOrThrow({ where: { id: target.id } });
    // MFAもパスワードも変わっていないこと（＝乗っ取りの起点が塞がれている）
    expect(after.mfaEnabled, `op=${op} でMFAが解除された`).toBe(true);
    expect(after.mfaSecret, `op=${op} でMFA秘密鍵が消された`).toBe(target.mfaSecret);
    expect(after.passwordHash, `op=${op} でパスワードが変更された`).toBe(target.passwordHash);

    // 一時パスワードが画面に出ていないこと（出ていたら乗っ取りが成立している）
    const body = await page.locator("body").innerText();
    expect(body, `op=${op} で一時パスワードが表示された`).not.toMatch(/一時パスワード/);
    console.log(`[AUTHZ-3] op=${op} は拒否された（MFA・パスワードは不変）`);
  }

  // 3) 監査ログに denied として記録されていること（§3.3）
  const denied = await d.auditLog.findMany({
    where: { target: { contains: AUDIT_R1_LOGIN }, result: "denied" },
  });
  console.log(`[AUTHZ-3] denied 監査ログ: ${denied.length}件`);
  expect(denied.length, "拒否が監査ログに記録されていない").toBeGreaterThanOrEqual(2);
});

// ---------------------------------------------------------------------------
// 対照実験: ⑧（一般代理店）は同じ管理CSVに到達できない（＝AUTHZ-2はR3固有の逸脱）
// ---------------------------------------------------------------------------
test("対照: ⑧は /admin と /admin/csv に到達できない", async ({ page }) => {
  await login(page, "R8");
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/dashboard/);
  const res = await page.request.get("/admin/csv?type=audit");
  console.log(`[control] R8 GET /admin/csv?type=audit -> ${res.status()}`);
  expect(res.status()).toBe(403);
  expect(PW_GENERAL.length).toBeGreaterThan(0); // 未使用importの回避
});
