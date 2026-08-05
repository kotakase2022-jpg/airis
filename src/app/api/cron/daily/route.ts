import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { notify, notifyRole, audit, today } from "@/lib/util";
import { anonymizeData } from "@/lib/pii";
import { sendMail, mailConfigured } from "@/lib/mail";
import { UNKNOWN_IP } from "@/lib/client-ip";

// 日次バッチ（Vercel Cron から毎日実行。vercel.json 参照）
//  1) 期限切れ窓口案件の自動リマインド（SPEC §7.8 / 要件9-2 督促機能）
//  2) 削除後1年経過データの個人情報匿名化（SPEC §3.4）
//  3) 不正利用検知アラート（SPEC §3.3 / 要件1-9）
//     - 日次窓（直近24時間）: 並行ログイン疑い / ログイン失敗の多発 / 複数IPからの成功
//     - 準リアルタイム窓（直近1時間）: 並行ログイン / 直近成功IPと異なるIPからの成功
//
// 認証: Authorization: Bearer ${CRON_SECRET}（Vercel Cronが自動付与）
// DB: バッチはセッションが無くRLSでfail-closedになるため、
//     オーナー接続（BYPASSRLS・非プール）の専用クライアントを使用する。

export const maxDuration = 60;

// 不正利用検知のしきい値（§3.3 / 要件1-9）。直近24時間を評価窓とする。
const ABUSE_WINDOW_HOURS = 24;
const CONCURRENT_SESSION_THRESHOLD = 3; // 同一アカウントの有効セッション数（並行ログイン疑い）
const FAILED_LOGIN_THRESHOLD = 10; // 失敗ログイン回数
const DISTINCT_IP_THRESHOLD = 3; // ログイン成功した異なるIP数（普段と異なるIP）

// 準リアルタイム検知（要件1-9「同一アカウントの並行ログイン・普段と異なるIP」）の評価窓。
// ログイン成功時の即時検知は認証処理側（(auth)/actions.ts）に手を入れずに実現するため、
// 「直近1時間に発生した異常」をバッチ側で拾い上げる方式にしている。
// 日次バッチを短周期（例: 毎時）でも起動できるようにしてあるので、
// 起動間隔を詰めるだけで検知の遅延を1時間以内に抑えられる（vercel.json のスケジュール変更のみ）。
const REALTIME_WINDOW_MINUTES = 60;

type AbuseKind =
  | "concurrent_sessions"
  | "failed_logins"
  | "multiple_ips"
  | "realtime_concurrent_sessions"
  | "realtime_ip_change";

const ABUSE_LABELS: Record<AbuseKind, string> = {
  concurrent_sessions: "並行ログインの疑い",
  failed_logins: "ログイン失敗の多発",
  multiple_ips: "複数IPからのログイン成功",
  realtime_concurrent_sessions: "並行ログインの疑い（直近1時間）",
  realtime_ip_change: "直近の成功IPと異なるIPからのログイン成功（直近1時間）",
};

type AbuseSignal = { kind: AbuseKind; actor: string; detail: string };

// ログイン成功イベント（アクセスログ §3.3 / 監査ログの login 成功を同一の型に正規化する）
type LoginSuccess = { actor: string; ip: string; at: Date };

function batchClient() {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  });
}

// 不審シグナルの検知（§3.3 / 要件1-9）。
// (a) 直近24時間に作成された有効セッションが3つ以上ある（並行ログイン疑い）
// (b) 直近24時間の失敗ログインが10回以上あるアカウント
// (c) 直近24時間に3つ以上の異なるIPからログイン成功しているアカウント
// アクセスログは AuditLog（action=login / result=success|failure / ip）に記録されている（§3.3）。
async function detectAbuseSignals(db: PrismaClient): Promise<AbuseSignal[]> {
  const now = new Date();
  const since = new Date(now.getTime() - ABUSE_WINDOW_HOURS * 3600 * 1000);
  const signals: AbuseSignal[] = [];

  // (a) 並行ログイン疑い（有効=期限内のセッション）
  const sessionGroups = await db.session.groupBy({
    by: ["accountId"],
    where: { createdAt: { gte: since }, expiresAt: { gt: now } },
    _count: { _all: true },
  });
  const concurrent = sessionGroups.filter((g) => g._count._all >= CONCURRENT_SESSION_THRESHOLD);
  if (concurrent.length > 0) {
    const accounts = await db.account.findMany({
      where: { id: { in: concurrent.map((g) => g.accountId) } },
      select: { id: true, loginId: true },
    });
    const loginIdOf = new Map(accounts.map((a) => [a.id, a.loginId]));
    for (const g of concurrent) {
      signals.push({
        kind: "concurrent_sessions",
        actor: loginIdOf.get(g.accountId) ?? g.accountId,
        detail: `有効セッション${g._count._all}件（直近${ABUSE_WINDOW_HOURS}時間）`,
      });
    }
  }

  // (b) 失敗ログインの多発
  const failedGroups = await db.auditLog.groupBy({
    by: ["actor"],
    where: { action: "login", result: "failure", createdAt: { gte: since } },
    _count: { _all: true },
  });
  for (const g of failedGroups) {
    if (g._count._all >= FAILED_LOGIN_THRESHOLD) {
      signals.push({
        kind: "failed_logins",
        actor: g.actor,
        detail: `ログイン失敗${g._count._all}回（直近${ABUSE_WINDOW_HOURS}時間）`,
      });
    }
  }

  // (c) 複数IPからのログイン成功
  const successGroups = await db.auditLog.groupBy({
    by: ["actor", "ip"],
    where: { action: "login", result: "success", createdAt: { gte: since } },
    _count: { _all: true },
  });
  const ipsByActor = new Map<string, Set<string>>();
  for (const g of successGroups) {
    if (!g.ip) continue;
    const set = ipsByActor.get(g.actor) ?? new Set<string>();
    set.add(g.ip);
    ipsByActor.set(g.actor, set);
  }
  for (const [actor, ips] of ipsByActor) {
    if (ips.size >= DISTINCT_IP_THRESHOLD) {
      signals.push({
        kind: "multiple_ips",
        actor,
        detail: `${ips.size}個の異なるIPからログイン成功（${[...ips].join(", ")}）`,
      });
    }
  }

  return signals;
}

// 直近1時間のログイン成功イベントを AccessLog（§3.3 アクセスログ）と AuditLog（action=login）から
// 収集し、アカウント単位で時系列に並べて返す。
// 認証処理側の書き込み先がどちらであっても検知できるよう両方を情報源とする
// （同一ログインが二重に記録されても、IPが同じなら「IP変化」とは判定されない）。
async function recentLoginSuccesses(db: PrismaClient, since: Date): Promise<Map<string, LoginSuccess[]>> {
  const [accessRows, auditRows] = await Promise.all([
    db.accessLog.findMany({
      where: { result: "success", createdAt: { gte: since } },
      select: { loginId: true, ip: true, createdAt: true },
    }),
    db.auditLog.findMany({
      where: { action: "login", result: "success", createdAt: { gte: since } },
      select: { actor: true, ip: true, createdAt: true },
    }),
  ]);

  const events: LoginSuccess[] = [
    ...accessRows.filter((r) => r.ip && r.ip !== UNKNOWN_IP).map((r) => ({ actor: r.loginId, ip: r.ip!, at: r.createdAt })),
    ...auditRows.filter((r) => r.ip && r.ip !== UNKNOWN_IP).map((r) => ({ actor: r.actor, ip: r.ip!, at: r.createdAt })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const byActor = new Map<string, LoginSuccess[]>();
  for (const e of events) {
    const list = byActor.get(e.actor) ?? [];
    list.push(e);
    byActor.set(e.actor, list);
  }
  return byActor;
}

// 準リアルタイム検知（要件1-9）。日次窓（24時間）より短い「直近1時間」で
//   (d) 同一アカウントの有効セッションが3つ以上（並行ログイン）
//   (e) 直近の成功IPと異なるIPからのログイン成功（普段と異なるIP）
// を検知する。cron/daily の起動間隔を詰めればそのまま即時性が上がる。
async function detectRealtimeAbuseSignals(db: PrismaClient): Promise<AbuseSignal[]> {
  const now = new Date();
  const since = new Date(now.getTime() - REALTIME_WINDOW_MINUTES * 60 * 1000);
  const signals: AbuseSignal[] = [];

  // (d) 直近1時間に作成された有効セッションが3つ以上（同一アカウントの並行ログイン）
  const sessionGroups = await db.session.groupBy({
    by: ["accountId"],
    where: { createdAt: { gte: since }, expiresAt: { gt: now } },
    _count: { _all: true },
  });
  const concurrent = sessionGroups.filter((g) => g._count._all >= CONCURRENT_SESSION_THRESHOLD);
  if (concurrent.length > 0) {
    const accounts = await db.account.findMany({
      where: { id: { in: concurrent.map((g) => g.accountId) } },
      select: { id: true, loginId: true },
    });
    const loginIdOf = new Map(accounts.map((a) => [a.id, a.loginId]));
    for (const g of concurrent) {
      signals.push({
        kind: "realtime_concurrent_sessions",
        actor: loginIdOf.get(g.accountId) ?? g.accountId,
        detail: `有効セッション${g._count._all}件（直近${REALTIME_WINDOW_MINUTES}分）`,
      });
    }
  }

  // (e) 直近の成功IPと異なるIPからのログイン成功
  const byActor = await recentLoginSuccesses(db, since);
  for (const [actor, events] of byActor) {
    for (let i = 1; i < events.length; i++) {
      if (events[i].ip === events[i - 1].ip) continue;
      signals.push({
        kind: "realtime_ip_change",
        actor,
        detail: `直近の成功IP ${events[i - 1].ip} と異なる ${events[i].ip} からログイン成功（直近${REALTIME_WINDOW_MINUTES}分）`,
      });
      break; // アカウントごとに1件（同一アカウントの連続通知を抑制）
    }
  }

  return signals;
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = batchClient();
  const summary = {
    overdueCases: 0,
    remindedAccounts: 0,
    anonymized: { accounts: 0, salesStaff: 0, fieldApplications: 0 },
    abuseSignals: {
      total: 0,
      concurrentSessions: 0,
      failedLogins: 0,
      multipleIps: 0,
      realtimeConcurrentSessions: 0,
      realtimeIpChange: 0,
    },
  };

  try {
    // ============ 1) 期限切れ案件リマインド ============
    const overdue = await db.case.findMany({
      where: { status: { not: "完了" }, deadline: { lt: today(), not: null } },
      include: { primaryAgency: true },
      orderBy: { deadline: "asc" },
    });
    summary.overdueCases = overdue.length;

    if (overdue.length > 0) {
      // 当該1次店のR7へ案件ごとに督促（見落とし防止）
      for (const c of overdue) {
        const r7s = await db.account.findMany({
          where: { role: "R7", status: "active", agencyId: c.primaryAgencyId },
          select: { id: true },
        });
        await Promise.all(
          r7s.map((a) =>
            notify(
              a.id,
              `【督促】対応期限を過ぎた案件があります（期限: ${c.deadline}）`,
              c.title,
              "/agency-cases"
            )
          )
        );
        summary.remindedAccounts += r7s.length;
      }
      // SNC運用者(R3)へはサマリで通知（要件9-2: SNC運用者アカウントへ通知）
      const caseList = overdue.map((c) => `${c.caseNo}（期限: ${c.deadline} / ${c.primaryAgency.name}）`).join(" / ");
      await notifyRole(
        ["R3"],
        `【リマインド】期限超過の窓口案件が${overdue.length}件あります`,
        caseList,
        "/hotline"
      );
      // 指定メールアドレスへの通知（要件9-2: 指定のメールアドレスに通知。REMINDER_MAIL_TO で指定）
      if (mailConfigured() && process.env.REMINDER_MAIL_TO) {
        await sendMail(
          process.env.REMINDER_MAIL_TO,
          `【Airis】期限超過の窓口案件が${overdue.length}件あります`,
          caseList
        );
      }
    }

    // ============ 2) 個人情報の匿名化（削除後1年経過 §3.4） ============
    // 匿名化済み判定は anonymizedAt IS NULL で行い、匿名化時に anonymizedAt を設定する
    const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const now = new Date();

    // Airisアカウント（loginIdは監査追跡のため残す。ログインはstatus=deletedで不可）
    const accounts = await db.account.updateMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, anonymizedAt: null },
      // 匿名化対象は src/lib/pii.ts の単一定義（schema.prisma の /// @pii 注釈と一致）
      data: { ...anonymizeData("Account"), anonymizedAt: now },
    });
    summary.anonymized.accounts = accounts.count;

    // 販売員（数値実績は分析用に残す）
    const staff = await db.salesStaff.updateMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, anonymizedAt: null },
      data: { ...anonymizeData("SalesStaff"), anonymizedAt: now },
    });
    summary.anonymized.salesStaff = staff.count;

    // 訪販員申請（業務委託先・カナ・SNCメモを消去。誓約書PDFも削除）
    const apps = await db.fieldAgentApplication.findMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, anonymizedAt: null },
      select: { id: true, pledgeFileId: true },
    });
    for (const a of apps) {
      if (a.pledgeFileId) {
        await db.storedFile.deleteMany({ where: { id: a.pledgeFileId } });
      }
      await db.fieldAgentApplication.update({
        where: { id: a.id },
        data: {
          ...anonymizeData("FieldAgentApplication"),
          sncMemo: null, // SNCメモは業務メモ（PII定義外だが個人情報を含みうるため消去）
          anonymizedAt: now,
        },
      });
    }
    summary.anonymized.fieldApplications = apps.length;

    // ============ 3) 不正利用検知アラート（§3.3 / 要件1-9） ============
    // 検知したら SNC管理者アカウント（②=R2）へアプリ内通知＋メール（notifyRole が両チャネル送信）。
    // 日次バッチのため、24時間の評価窓が続く限り翌日も再通知される（見落とし防止を優先）。
    // 日次窓（24時間）に加えて、直近1時間の異常（並行ログイン・直近成功IPと異なるIP）も
    // 準リアルタイム検知として評価する（要件1-9）。
    const abuseSignals = [
      ...(await detectAbuseSignals(db)),
      ...(await detectRealtimeAbuseSignals(db)),
    ];
    summary.abuseSignals = {
      total: abuseSignals.length,
      concurrentSessions: abuseSignals.filter((s) => s.kind === "concurrent_sessions").length,
      failedLogins: abuseSignals.filter((s) => s.kind === "failed_logins").length,
      multipleIps: abuseSignals.filter((s) => s.kind === "multiple_ips").length,
      realtimeConcurrentSessions: abuseSignals.filter(
        (s) => s.kind === "realtime_concurrent_sessions"
      ).length,
      realtimeIpChange: abuseSignals.filter((s) => s.kind === "realtime_ip_change").length,
    };
    if (abuseSignals.length > 0) {
      const body = abuseSignals
        .map((s) => `・${s.actor}: ${ABUSE_LABELS[s.kind]} — ${s.detail}`)
        .join("\n");
      await notifyRole(
        ["R2"],
        `【不正利用検知】不審なログインシグナルを${abuseSignals.length}件検知しました`,
        body,
        "/admin"
      );
      // 監査記録（§3.3）。シグナル単位で残し、後追い調査できるようにする
      for (const s of abuseSignals) {
        await audit("system-cron", `abuse_${s.kind}`, `${s.actor}: ${s.detail}`, "detected");
      }
    }

    await audit("system-cron", "daily_batch", JSON.stringify(summary));
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    await audit("system-cron", "daily_batch", (e as Error).message, "failure");
    return Response.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    await db.$disconnect();
  }
}
