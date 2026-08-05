/**
 * QA担当: セッション失効（絶対期限24時間 / アイドル60分）§10.2 / SEC要件②#13 / T-008
 *
 * 実時間の経過は待たず、DBの Session.createdAt / lastSeenAt / expiresAt を過去へ書き換えて
 * 検証する。実際にブラウザで保護ページ（/dashboard）へアクセスし、/login へ戻ることを確認する。
 *
 * - 絶対期限: createdAt を25時間前（expiresAt も過去）にし、lastSeenAt は現在のまま
 *   → アイドルではなく「絶対期限」による失効であることを分離して検証できる
 * - アイドル: lastSeenAt を61分前にし、expiresAt は未来のまま
 *   → 絶対期限未達でも放置で失効することを検証できる
 * - 反証: lastSeenAt が30分前（=どちらも未超過）ならセッションは有効のまま
 *   （書き換え自体が失効の原因ではないことを示す）
 *
 * 使用アカウント: シードの⑤（airis_snc_spt1_001）。テスト内で作った/書き換えたセッションは
 * 各テストの後始末で削除する。
 */
import { test, expect, Page } from "@playwright/test";
import { ACCOUNTS, db, login } from "./helpers";

const ROLE = "R5" as const;
const LOGIN_ID = ACCOUNTS[ROLE].loginId;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let accountId = "";

async function activeSessionIds(): Promise<string[]> {
  const rows = await db().session.findMany({
    where: { accountId, mfaPending: false },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

// ログイン済みセッションの時刻列を過去へ書き換える（実時間の経過を待たない）
async function rewriteSessions(data: {
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}): Promise<number> {
  const ids = await activeSessionIds();
  expect(ids.length, "ログイン済みセッションがDBに存在すること").toBeGreaterThan(0);
  const res = await db().session.updateMany({ where: { id: { in: ids } }, data });
  return res.count;
}

async function expectLoginPage(page: Page) {
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: "ログイン" })).toBeVisible();
}

test.beforeAll(async () => {
  // 参照・更新は select を明示する（この検証に不要な列に依存しないため）
  const acc = await db().account.findUnique({
    where: { loginId: LOGIN_ID },
    select: { id: true },
  });
  expect(acc, `シードアカウント ${LOGIN_ID} が存在すること`).not.toBeNull();
  accountId = acc!.id;
  // 初回パスワード変更フラグがONだと /password へ誘導されるため、
  // セッション失効の検証に集中できるようOFFにしておく（§9-1 の既定はON。seed.ts の SEED_DEMO）。
  await db().account.update({
    where: { id: accountId },
    data: { mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
    select: { id: true },
  });
});

test.afterEach(async () => {
  // 書き換えたセッションを残さない（後続テストのログイン状態に影響させない）
  await db().session.deleteMany({ where: { accountId } });
});

test.describe.serial("セッション失効（§10.2）", () => {
  test("絶対期限24時間を超えたセッションは失効し、保護ページで/loginへ戻る", async ({ page }) => {
    await login(page, ROLE);
    await expect(page).toHaveURL(/\/dashboard/);

    // createdAt = 25時間前 / expiresAt = createdAt+24h（=1時間前）/ lastSeenAt = 現在
    const now = Date.now();
    const createdAt = new Date(now - 25 * HOUR);
    const count = await rewriteSessions({
      createdAt,
      lastSeenAt: new Date(now),
      expiresAt: new Date(createdAt.getTime() + 24 * HOUR),
    });
    expect(count, "セッションの時刻列を書き換えたこと").toBeGreaterThan(0);

    await page.goto("/dashboard");
    await expectLoginPage(page);

    // 他の保護ページでも同じ（Cookieは残っているがサーバ側で失効扱い。⑤が閲覧できる画面で確認）
    await page.goto("/hotline");
    await expectLoginPage(page);
  });

  test("アイドル60分を超えたセッションは失効し、保護ページで/loginへ戻る", async ({ page }) => {
    await login(page, ROLE);
    await expect(page).toHaveURL(/\/dashboard/);

    // lastSeenAt = 61分前 / expiresAt は未来（絶対期限は未達）
    const now = Date.now();
    const count = await rewriteSessions({
      createdAt: new Date(now - 2 * HOUR),
      lastSeenAt: new Date(now - 61 * MIN),
      expiresAt: new Date(now + 22 * HOUR),
    });
    expect(count, "セッションの時刻列を書き換えたこと").toBeGreaterThan(0);

    await page.goto("/dashboard");
    await expectLoginPage(page);
  });

  test("絶対期限・アイドルとも未超過ならセッションは有効（最終アクセス時刻が更新される）", async ({
    page,
  }) => {
    await login(page, ROLE);
    await expect(page).toHaveURL(/\/dashboard/);

    // lastSeenAt = 30分前（アイドル60分未満）/ createdAt = 2時間前（絶対24時間未満）
    const now = Date.now();
    const staleLastSeen = new Date(now - 30 * MIN);
    const count = await rewriteSessions({
      createdAt: new Date(now - 2 * HOUR),
      lastSeenAt: staleLastSeen,
      expiresAt: new Date(now + 22 * HOUR),
    });
    expect(count).toBeGreaterThan(0);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);

    // アクセスにより lastSeenAt が更新される（アイドル期限が延伸する）
    const after = await db().session.findMany({
      where: { accountId, mfaPending: false },
      select: { lastSeenAt: true },
    });
    expect(after.length).toBeGreaterThan(0);
    expect(
      after.some((s) => s.lastSeenAt.getTime() > staleLastSeen.getTime()),
      "保護ページへのアクセスで lastSeenAt が更新されること"
    ).toBe(true);
  });

  test("失効後に再ログインすれば新しいセッションで利用できる", async ({ page }) => {
    await login(page, ROLE);
    const now = Date.now();
    const createdAt = new Date(now - 25 * HOUR);
    await rewriteSessions({
      createdAt,
      lastSeenAt: new Date(now),
      expiresAt: new Date(createdAt.getTime() + 24 * HOUR),
    });
    await page.goto("/dashboard");
    await expectLoginPage(page);

    // 失効済みの行を片付けてから再ログインし、以降の検証は新しいセッションのみを対象にする
    await db().session.deleteMany({ where: { accountId, expiresAt: { lt: new Date() } } });

    // 同じブラウザコンテキストで再ログイン → 新しいセッションが発行され、業務画面へ入れる
    await login(page, ROLE);
    await expect(page).toHaveURL(/\/dashboard/);
    const fresh = await db().session.findMany({
      where: { accountId, mfaPending: false },
      select: { expiresAt: true },
    });
    expect(fresh.length).toBeGreaterThan(0);
    // 新しいセッションの絶対期限は「今から24時間以内」（§10.2）
    for (const s of fresh) {
      expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(s.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 24 * HOUR + MIN);
    }
  });
});
