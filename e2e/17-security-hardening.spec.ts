/**
 * QA担当: セキュリティ多層防御の回帰テスト
 *   (a) §10.4 AuditLog の append-only（airis_appロールから UPDATE/DELETE 不可）
 *   (b) 要件1-9 不正利用検知アラート（日次バッチ → SNC管理者②へ通知 + 監査記録）
 *   (c) §3.1 AccountRequest の RLS（コンテキスト無しは0件 / スコープ内のみ可視）
 *
 * データプレフィクス: QA17（作成した行は必ず後始末する）
 * 前提: prisma/rls.sql 適用済み（npm run rls）＋ airis_app ロール（NOBYPASSRLS）
 */
import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { db, login } from "./helpers";

const RUN = Date.now();
const CRON_SECRET = process.env.CRON_SECRET ?? "qa-test-secret";

// アプリロール接続（airis_app = NOBYPASSRLS）。RLS・テーブル権限の実効値を検証するために使う。
const APP_DATABASE_URL =
  process.env.QA_APP_DATABASE_URL ?? "postgresql://airis_app:airis_app_test@localhost:5433/airis";

let appDb: PrismaClient;

test.beforeAll(() => {
  appDb = new PrismaClient({ datasourceUrl: APP_DATABASE_URL });
});

test.afterAll(async () => {
  await appDb.$disconnect();
});

// ===========================================================================
// (a) §10.4 AuditLog は append-only（アプリから更新・削除できない）
// ===========================================================================
test.describe("§10.4 AuditLog append-only（多層防御）", () => {
  test("airis_appロールは AuditLog を UPDATE / DELETE できず、INSERT / SELECT はできる", async () => {
    const target = `QA17-append-only-${RUN}`;
    // 準備: オーナー接続（BYPASSRLS）で監査ログを1件作成
    const row = await db().auditLog.create({
      data: { actor: "QA17-owner", action: "QA17_probe", target, result: "success" },
    });

    try {
      // INSERT は可能（アプリの監査記録が壊れていないこと）
      const insertedId = `qa17-ins-${RUN}`;
      await appDb.$executeRawUnsafe(
        `INSERT INTO "AuditLog" (id, actor, action, target, result, "createdAt") VALUES ($1, $2, $3, $4, $5, now())`,
        insertedId,
        "QA17-app",
        "QA17_probe",
        target,
        "success"
      );
      // SELECT も可能
      const inserted = await appDb.auditLog.findUnique({ where: { id: insertedId } });
      expect(inserted, "airis_appからのINSERT/SELECTは維持されること").not.toBeNull();

      // UPDATE / DELETE / TRUNCATE は権限エラー
      await expect(
        appDb.$executeRawUnsafe(`UPDATE "AuditLog" SET result = 'tampered' WHERE id = $1`, row.id),
        "AuditLogのUPDATEは権限エラーになること"
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appDb.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE id = $1`, row.id),
        "AuditLogのDELETEは権限エラーになること"
      ).rejects.toThrow(/permission denied/i);
      await expect(
        appDb.$executeRawUnsafe(`TRUNCATE TABLE "AuditLog"`),
        "AuditLogのTRUNCATEは権限エラーになること"
      ).rejects.toThrow(/permission denied|must be owner/i);

      // 監査ログが改変・削除されていないこと
      const after = await db().auditLog.findUnique({ where: { id: row.id } });
      expect(after).not.toBeNull();
      expect(after!.result).toBe("success");
      expect(await db().auditLog.count({ where: { target } })).toBe(2);
    } finally {
      await db().auditLog.deleteMany({ where: { target } });
    }
  });
});

// ===========================================================================
// (b) 要件1-9 不正利用検知アラート（日次バッチ）
// ===========================================================================
test.describe("要件1-9 不正利用検知アラート（cron/daily）", () => {
  const failActor = `qa17-fail-${RUN}`;
  const ipActor = `qa17-multiip-${RUN}`;
  const sessionLoginId = `qa17_session_${RUN}`;
  let sessionAccountId = "";

  test.afterAll(async () => {
    await db().auditLog.deleteMany({ where: { actor: { in: [failActor, ipActor] } } });
    await db().auditLog.deleteMany({
      where: { actor: "system-cron", target: { contains: `qa17-` } },
    });
    await db().auditLog.deleteMany({
      where: { actor: "system-cron", target: { contains: sessionLoginId } },
    });
    // Session は onDelete: Cascade
    await db().account.deleteMany({ where: { loginId: sessionLoginId } });
  });

  test("失敗ログイン10回 / 3IPからの成功 / 有効セッション3件 を検知し、②SNC管理者へ通知＋監査記録", async ({
    request,
  }) => {
    const start = new Date();

    // --- 準備(b): 直近24時間の失敗ログイン10回（§3.3 アクセスログ = AuditLog action=login）
    await db().auditLog.createMany({
      data: Array.from({ length: 10 }, () => ({
        actor: failActor,
        action: "login",
        result: "failure",
        target: "ua=QA17-agent",
        ip: "203.0.113.10",
      })),
    });
    // --- 準備(c): 3つの異なるIPからログイン成功
    await db().auditLog.createMany({
      data: ["203.0.113.21", "203.0.113.22", "203.0.113.23"].map((ip) => ({
        actor: ipActor,
        action: "login",
        result: "success",
        target: "ua=QA17-agent",
        ip,
      })),
    });
    // --- 準備(a): 同一アカウントに有効セッション3件（並行ログイン疑い）
    const acc = await db().account.create({
      data: {
        loginId: sessionLoginId,
        role: "R5",
        name: `QA17並行ログイン検証-${RUN}`,
        status: "active",
        passwordHash: "qa17-not-a-real-hash",
        mustChangePassword: false,
      },
    });
    sessionAccountId = acc.id;
    await db().session.createMany({
      data: [1, 2, 3].map((i) => ({
        token: `qa17-token-${RUN}-${i}`,
        accountId: sessionAccountId,
        expiresAt: new Date(Date.now() + 3600 * 1000),
      })),
    });

    // --- 日次バッチ実行
    const res = await request.get("/api/cron/daily", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
      timeout: 60_000,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // summary に検知件数が含まれる
    expect(body.abuseSignals, "summaryに不正利用検知の件数が含まれること").toBeTruthy();
    expect(body.abuseSignals.failedLogins).toBeGreaterThanOrEqual(1);
    expect(body.abuseSignals.multipleIps).toBeGreaterThanOrEqual(1);
    expect(body.abuseSignals.concurrentSessions).toBeGreaterThanOrEqual(1);
    expect(body.abuseSignals.total).toBeGreaterThanOrEqual(3);

    // 監査記録（§3.3）: シグナル種別ごとに残る
    for (const [action, actor] of [
      ["abuse_failed_logins", failActor],
      ["abuse_multiple_ips", ipActor],
      ["abuse_concurrent_sessions", sessionLoginId],
    ] as const) {
      const auditRow = await db().auditLog.findFirst({
        where: {
          actor: "system-cron",
          action,
          target: { contains: actor },
          createdAt: { gte: start },
        },
      });
      expect(auditRow, `監査ログ ${action} が記録されること`).not.toBeNull();
      expect(auditRow!.result).toBe("detected");
    }

    // ②SNC管理者（R2）全員へアプリ内通知（メールは notifyRole が同時送信 §3.7）
    const r2s = await db().account.findMany({
      where: { role: "R2", status: "active" },
      select: { id: true },
    });
    expect(r2s.length).toBeGreaterThan(0);
    for (const r2 of r2s) {
      const notification = await db().notification.findFirst({
        where: {
          accountId: r2.id,
          title: { contains: "不正利用検知" },
          createdAt: { gte: start },
        },
        orderBy: { createdAt: "desc" },
      });
      expect(notification, "R2へ不正利用検知の通知が作成されること").not.toBeNull();
      expect(notification!.body).toContain(failActor);
      expect(notification!.link).toBe("/admin");
    }

    // 後始末（通知は本テストの実行分のみ削除）
    await db().notification.deleteMany({
      where: { title: { contains: "不正利用検知" }, createdAt: { gte: start } },
    });
  });

  test("しきい値未満（失敗9回）では検知されない", async ({ request }) => {
    const quietActor = `qa17-quiet-${RUN}`;
    await db().auditLog.deleteMany({ where: { actor: { in: [failActor, ipActor] } } });
    await db().session.deleteMany({ where: { accountId: sessionAccountId } });
    await db().auditLog.createMany({
      data: Array.from({ length: 9 }, () => ({
        actor: quietActor,
        action: "login",
        result: "failure",
        target: "ua=QA17-agent",
        ip: "203.0.113.30",
      })),
    });
    try {
      const start = new Date();
      const res = await request.get("/api/cron/daily", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
        timeout: 60_000,
      });
      expect(res.status()).toBe(200);
      const detected = await db().auditLog.count({
        where: {
          actor: "system-cron",
          action: "abuse_failed_logins",
          target: { contains: quietActor },
          createdAt: { gte: start },
        },
      });
      expect(detected, "9回（しきい値10未満）は検知しないこと").toBe(0);
      // 本実行で他アカウント由来のシグナルが検知された場合の通知も後始末する
      await db().notification.deleteMany({
        where: { title: { contains: "不正利用検知" }, createdAt: { gte: start } },
      });
    } finally {
      await db().auditLog.deleteMany({ where: { actor: quietActor } });
    }
  });
});

// ===========================================================================
// (c) §3.1 AccountRequest の RLS（アプリ層チェックとの多層防御）
// ===========================================================================
test.describe("§3.1 AccountRequest の RLS", () => {
  test("コンテキスト無しでは0件（fail-closed）／スコープ内・bypass時のみ可視", async () => {
    const s1 = await db().agency.findUnique({ where: { code: "210001" } });
    const p2 = await db().agency.findUnique({ where: { code: "150008" } });
    expect(s1).not.toBeNull();
    expect(p2).not.toBeNull();

    const agencyRequestId = `QA17-REQ-A-${RUN}`;
    const sncRequestId = `QA17-REQ-S-${RUN}`;
    // 代理店スコープを持つ申請 + SNC系ロール宛（agencyId=null）の申請
    await db().accountRequest.create({
      data: {
        requestId: agencyRequestId,
        role: "R8",
        name: `QA17申請（代理店）-${RUN}`,
        email: `qa17-agency-${RUN}@example.com`,
        agencyId: s1!.id,
        status: "pending_first",
      },
    });
    await db().accountRequest.create({
      data: {
        requestId: sncRequestId,
        role: "R5",
        name: `QA17申請（SNC）-${RUN}`,
        email: `qa17-snc-${RUN}@example.com`,
        status: "pending_final",
      },
    });

    try {
      // オーナー接続（BYPASSRLS）では見える = 事前データが存在する
      expect(await db().accountRequest.count({ where: { requestId: agencyRequestId } })).toBe(1);

      // 1) コンテキスト無し（app.bypass / app.scope 未設定）→ 0件
      expect(
        await appDb.accountRequest.count(),
        "RLSコンテキストが無い接続からAccountRequestは0件であること"
      ).toBe(0);

      // 2) app.scope に当該代理店を設定 → 自店の申請とSNC系ロール宛（agencyId=null）の申請が見える
      const inScope = await appDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.scope', $1, true)`, s1!.id);
        return tx.accountRequest.findMany({
          where: { requestId: { in: [agencyRequestId, sncRequestId] } },
          select: { requestId: true },
        });
      });
      expect(inScope.map((r) => r.requestId).sort()).toEqual(
        [agencyRequestId, sncRequestId].sort()
      );

      // 3) 別代理店のスコープ → 他店の申請は見えない（SNC系ロール宛のみ）
      const outOfScope = await appDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.scope', $1, true)`, p2!.id);
        return tx.accountRequest.findMany({
          where: { requestId: { in: [agencyRequestId, sncRequestId] } },
          select: { requestId: true },
        });
      });
      expect(outOfScope.map((r) => r.requestId)).toEqual([sncRequestId]);

      // 4) app.bypass=on（SNC系ロール）→ すべて見える
      const bypass = await appDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass', 'on', true)`);
        return tx.accountRequest.findMany({
          where: { requestId: { in: [agencyRequestId, sncRequestId] } },
          select: { requestId: true },
        });
      });
      expect(bypass.map((r) => r.requestId).sort()).toEqual([agencyRequestId, sncRequestId].sort());

      // 5) コンテキスト無しでは書き込みもできない（WITH CHECK / fail-closed）
      await expect(
        appDb.accountRequest.create({
          data: {
            requestId: `QA17-REQ-X-${RUN}`,
            role: "R8",
            name: `QA17申請（拒否）-${RUN}`,
            email: `qa17-deny-${RUN}@example.com`,
            agencyId: s1!.id,
            status: "pending_first",
          },
        }),
        "コンテキスト無しのINSERTはRLSで拒否されること"
      ).rejects.toThrow(/row-level security|violates/i);
    } finally {
      await db().accountRequest.deleteMany({
        where: { requestId: { in: [agencyRequestId, sncRequestId, `QA17-REQ-X-${RUN}`] } },
      });
    }
  });

  test("④ダミーアカウントは自ロール④の申請を実データとして登録できる（§3.5 例外がRLSで阻害されない）", async ({
    page,
  }) => {
    const name = `QA17ダミー申請-${RUN}`;
    const email = `qa17-dummy-${RUN}@example.com`;
    try {
      await login(page, "R4");
      await page.goto("/account-requests");
      await page.getByRole("button", { name: "＋ アカウント申請" }).click();
      await expect(
        page.getByRole("heading", { name: "アカウント申請", exact: true })
      ).toBeVisible();
      await page.locator('input[name="name"]').fill(name);
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="evidence"]').setInputFiles({
        name: "qa17-evidence.png",
        mimeType: "image/png",
        buffer: Buffer.from("QA17-evidence-file-content"),
      });
      await page.getByRole("button", { name: "申請する" }).click();
      await expect(page.getByText(/アカウント申請を受け付けました（REQ-\d+）/)).toBeVisible({
        timeout: 15_000,
      });

      // agencyId=null（SNC系ロール宛）の申請がRLSのWITH CHECKを通過して保存されている
      const req = await db().accountRequest.findFirst({ where: { email } });
      expect(req, "④の申請が実データとして保存されること").not.toBeNull();
      expect(req!.role).toBe("R4");
      expect(req!.agencyId).toBeNull();

      // 一覧（自分が作成した申請）にも表示される
      await page.reload();
      await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(1);
    } finally {
      const req = await db().accountRequest.findFirst({ where: { email } });
      if (req?.evidenceFileId) {
        await db().storedFile.deleteMany({ where: { id: req.evidenceFileId } });
      }
      await db().accountRequest.deleteMany({ where: { email } });
    }
  });
});
