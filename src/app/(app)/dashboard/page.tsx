import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  announcementAudienceFilterFor,
  canAccess,
  caseSeriesForRole,
  SUBMISSION_KINDS,
} from "@/lib/roles";
import { can } from "@/lib/permissions";
import { Card, PageHeader, SectionTitle, StatCard, InfoBanner } from "@/components/ui";
import { today } from "@/lib/util";

export const dynamic = "force-dynamic";

// 日報未提出者の母数となる販売員ステータス（日報を提出できるのは仮登録・本登録 §7.5）
const REPORTABLE_STAFF_STATUS = ["provisional", "registered"];

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ denied?: string }>;
}) {
  const user = await requirePage("dashboard");
  // 権限拒否でリダイレクトされてきた場合のバナー表示（404との区別。問題一覧No.34）
  const denied = (await searchParams)?.denied;
  const scope = await agencyScope(user);
  const agencyFilter = scope === null ? {} : { agencyId: { in: scope } };
  const month = today().slice(0, 7);

  // Airisアカウント申請（§7.1: 承認待ち / 登録済み / 停止・削除 の件数）。
  // 第3カードは「却下件数」ではなく **アカウントの停止中・削除済の件数**（§7.1 / §7.2 の統計カードと同義）。
  const [reqPending, reqApproved, acctInactive] = canAccess(user.role, "account-requests")
    ? await Promise.all([
        prisma.accountRequest.count({
          where: { status: { in: ["pending_first", "pending_final"] } },
        }),
        prisma.accountRequest.count({ where: { status: "approved" } }),
        // アカウントの停止中・削除済の件数。§5.1「Airisアカウント/閲」（①②③）を持つロールのみ
        // 実数を出す（権限が無いロールに全社の件数を見せない。④はダミー代理店のみ）。
        can(user.role, "airis-account", "view")
          ? prisma.account.count({
              where: {
                status: { in: ["suspended", "deleted"] },
                ...(user.dummy
                  ? { agency: { isDummy: true } }
                  : { OR: [{ agencyId: null }, { agency: { isDummy: false } }] }),
              },
            })
          : user.dummy
            ? prisma.account.count({
                where: { status: { in: ["suspended", "deleted"] }, agency: { isDummy: true } },
              })
            : prisma.account.count({
                where: { status: { in: ["suspended", "deleted"] }, agencyId: { in: scope ?? [] } },
              }),
      ])
    : [0, 0, 0];

  // 販売員ID
  const staffCounts = canAccess(user.role, "sales-staff")
    ? await prisma.salesStaff.groupBy({ by: ["status"], _count: true, where: agencyFilter })
    : [];
  const staffOf = (s: string) => staffCounts.find((c) => c.status === s)?._count ?? 0;

  // 訪販員申請
  const fieldCounts = canAccess(user.role, "field-agents")
    ? await prisma.fieldAgentApplication.groupBy({
        by: ["status"],
        _count: true,
        where: scope === null ? {} : { salesStaff: { agencyId: { in: scope } } },
      })
    : [];
  const fieldOf = (s: string) => fieldCounts.find((c) => c.status === s)?._count ?? 0;

  // 日報・提出物
  const showReports = canAccess(user.role, "reports");
  // 稼働提出物の指標は §5.1「稼働提出物」の閲覧権限を持つロールにのみ出す
  // （⑨販売員は×。ロール名を直書きせず宣言的マップから導出する §3.2）
  const showReportAdmin = showReports && can(user.role, "submission", "view");
  const submissionScope = scope === null ? {} : { submitterAgencyId: { in: scope } };
  const reportCount = showReports
    ? await prisma.dailyReport.count({
        where: {
          date: { startsWith: month },
          ...(scope === null ? {} : { agencyId: { in: scope } }),
        },
      })
    : 0;
  const [submissionPending, submissionApproved] = showReportAdmin
    ? await Promise.all([
        prisma.submission.count({
          where: {
            status: { in: ["pending_first", "pending_snc"] },
            ...submissionScope,
          },
        }),
        prisma.submission.count({
          where: {
            status: "approved",
            targetMonth: month,
            ...submissionScope,
          },
        }),
      ])
    : [0, 0];

  // 当月日報の未提出者数（§7.1「当月の日報提出状況（提出件数・未提出者）」）
  const unsubmittedStaff = showReportAdmin
    ? await prisma.salesStaff.count({
        where: {
          ...agencyFilter,
          status: { in: REPORTABLE_STAFF_STATUS },
          dailyReports: { none: { date: { startsWith: month } } },
        },
      })
    : 0;

  // 提出物の提出状況 n/6（§7.1「提出物の提出状況（n/6）」。当月・スコープ内で提出済みの様式数）
  const submittedKinds = showReportAdmin
    ? await prisma.submission.findMany({
        where: { targetMonth: month, status: { not: "rejected" }, ...submissionScope },
        select: { kind: true },
        distinct: ["kind"],
      })
    : [];

  // 下位代理店
  const showAgencies = canAccess(user.role, "agencies");
  const agencyWhere = scope === null ? { isDummy: user.isDummy } : { id: { in: scope } };
  const [agencyTotal, agencyActive, agencyClosed] = showAgencies
    ? await Promise.all([
        prisma.agency.count({ where: agencyWhere }),
        prisma.agency.count({ where: { status: "active", ...agencyWhere } }),
        // 稼働終了数（§7.1「下位代理店: 代理店数 / 有効数 / 稼働終了数」）
        prisma.agency.count({ where: { status: "closed", ...agencyWhere } }),
      ])
    : [0, 0, 0];

  // 窓口案件
  const showCases =
    canAccess(user.role, "hotline") ||
    canAccess(user.role, "consumer-center") ||
    canAccess(user.role, "agency-cases");
  // 系列の限定（⑤=HL / ⑥=CSC）は roles.ts の宣言的マップから導出する（§3.2）
  const roleSeries = caseSeriesForRole(user.role);
  const caseWhere = {
    ...(roleSeries ? { series: roleSeries } : {}),
    ...(scope === null ? {} : { primaryAgencyId: { in: scope } }),
  };
  const caseCounts = showCases
    ? await prisma.case.groupBy({ by: ["status"], _count: true, where: caseWhere })
    : [];
  const caseOf = (s: string) => caseCounts.find((c) => c.status === s)?._count ?? 0;
  const overdue = showCases
    ? await prisma.case.count({
        where: { ...caseWhere, status: { not: "完了" }, deadline: { lt: today() } },
      })
    : 0;
  // 返信状況（§7.1「窓口案件の対応状況・返信状況・期限超過のカード」/ 要件9-2⑩）:
  // 未完了案件のうち「相手方が最後に発言している=自分の返信待ち」の件数。
  // SNC系（①②③⑤⑥）は代理店側の最終発言、代理店系（⑦⑩）はSNC側の最終発言が返信待ちにあたる。
  let awaitingReply = 0;
  if (showCases) {
    // 代理店側か（§5.2「窓口案件（代理店側）」= /agency-cases に入れるロール ⑦⑩）。
    // ロール名を直書きせず、ページアクセスの宣言的マップから導出する（§3.2）
    const isAgencySide = canAccess(user.role, "agency-cases");
    const opposite = isAgencySide ? "snc" : "agency";
    const openCases = await prisma.case.findMany({
      where: { ...caseWhere, status: { notIn: ["完了", "停止", "削除済"] } },
      select: {
        id: true,
        messages: { orderBy: { createdAt: "desc" }, take: 1, select: { senderSide: true } },
      },
    });
    awaitingReply = openCases.filter((c) => c.messages[0]?.senderSide === opposite).length;
  }

  // お知らせ
  // ④ダミー表示（§3.5）: 閲覧アカウントにはシードの架空データ（isDummy=true）のみを出し、
  // 実データには一切アクセスさせない。逆に非ダミーロールにはサンプルデータを出さない。
  const showAnnouncements = canAccess(user.role, "announcements");
  // 配信範囲 primary（1次店管理者=⑦のみ宛）のお知らせは、⑦以外の代理店系（⑧⑨）には出さない。
  // 対象ロールは roles.ts の宣言的マップから導出する（§7.7 / §3.2）
  const audienceFilter = announcementAudienceFilterFor(user.role);
  const annWhere: Prisma.AnnouncementWhereInput = {
    status: "sent",
    isDummy: user.isDummy,
    ...(audienceFilter ? { audience: audienceFilter } : {}),
  };
  const announcements = showAnnouncements
    ? await prisma.announcement.findMany({
        where: annWhere,
        orderBy: { sentAt: "desc" },
        take: 5,
      })
    : [];
  // 未読お知らせ件数（§7.1。既読は AnnouncementRead で管理 §7.7）
  const [annTotal, annRead] = showAnnouncements
    ? await Promise.all([
        prisma.announcement.count({ where: annWhere }),
        prisma.announcementRead.count({ where: { accountId: user.id, announcement: annWhere } }),
      ])
    : [0, 0];
  const annUnread = Math.max(0, annTotal - annRead);

  // 管理画面向け（①②のみ §7.1）: 直近（本日JST）の監査イベント・不正利用アラート
  const showAdminStats = canAccess(user.role, "admin") && !user.isDummy;
  const since = new Date(`${today()}T00:00:00+09:00`);
  const [auditRecent, alertRecent] = showAdminStats
    ? await Promise.all([
        prisma.auditLog.count({ where: { createdAt: { gte: since } } }),
        // 不正利用検知（§3.3 / 要件1-9）は日次バッチ（api/cron/daily）で並行ログイン・IP変化・
        // 暫定で監査ログの失敗・拒否イベント（ログイン失敗／権限外アクセス）件数をアラート数とする。
        prisma.auditLog.count({ where: { createdAt: { gte: since }, result: { not: "success" } } }),
      ])
    : [0, 0];

  // 遷移先も宣言的マップから導出する（⑥はCSC窓口 §4 / §3.2）
  const casesHref = canAccess(user.role, "agency-cases")
    ? "/agency-cases"
    : caseSeriesForRole(user.role) === "CSC"
      ? "/consumer-center"
      : "/hotline";

  return (
    <div>
      <PageHeader title="ダッシュボード" />
      {denied && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          アクセスしようとしたページを表示する権限がありません（ご利用のロールでは利用できない機能です）。
        </div>
      )}
      {user.isDummy && (
        <InfoBanner>閲覧用アカウントのため、表示されているのはサンプルデータです。</InfoBanner>
      )}
      <div className="space-y-6">
        {canAccess(user.role, "account-requests") && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/account-requests">
                  Airisアカウント申請 →
                </Link>
              }
            >
              Airisアカウント申請
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={reqPending} label="承認待ち" tone="orange" />
              <StatCard value={reqApproved} label="登録済み" tone="green" />
              <StatCard value={acctInactive} label="停止・削除" tone="gray" />
            </div>
          </section>
        )}
        {canAccess(user.role, "sales-staff") && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/sales-staff">
                  販売員ID管理 →
                </Link>
              }
            >
              販売員ID
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard value={staffOf("applying")} label="申請中" tone="orange" />
              <StatCard value={staffOf("provisional")} label="仮登録" tone="orange" />
              <StatCard value={staffOf("registered")} label="本登録" tone="green" />
              <StatCard value={staffOf("suspended")} label="停止中" tone="gray" />
              <StatCard value={staffOf("deleted")} label="削除済" tone="red" />
            </div>
          </section>
        )}
        {canAccess(user.role, "field-agents") && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/field-agents">
                  訪販員申請・管理 →
                </Link>
              }
            >
              訪販員申請
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={fieldOf("applying")} label="申請中" tone="orange" />
              <StatCard value={fieldOf("provisional")} label="仮登録" tone="orange" />
              <StatCard value={fieldOf("registered")} label="稼働" tone="green" />
              <StatCard value={fieldOf("deleted")} label="抹消" tone="red" />
            </div>
          </section>
        )}
        {showReports && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/reports">
                  各種資料の提出 →
                </Link>
              }
            >
              日報・稼働提出物（{month}）
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
              <StatCard value={reportCount} label="当月の日報件数" tone="blue" />
              {showReportAdmin && (
                <StatCard value={unsubmittedStaff} label="当月日報の未提出者数" tone="orange" />
              )}
              {showReportAdmin && (
                <StatCard
                  value={`${submittedKinds.length} / ${SUBMISSION_KINDS.length}`}
                  label="提出物の提出状況（当月）"
                  tone="purple"
                />
              )}
              {showReportAdmin && (
                <StatCard value={submissionPending} label="提出物 承認待ち" tone="orange" />
              )}
              {showReportAdmin && (
                <StatCard
                  value={submissionApproved}
                  label="提出物 最終承認済み（当月）"
                  tone="green"
                />
              )}
            </div>
          </section>
        )}
        {(showAgencies || showCases) && (
          <div className="grid gap-6 md:grid-cols-2">
            {showAgencies && (
              <section>
                <SectionTitle
                  right={
                    <Link className="text-xs text-blue-600 hover:underline" href="/agencies">
                      下位代理店 →
                    </Link>
                  }
                >
                  代理店
                </SectionTitle>
                <div className="grid grid-cols-3 gap-3">
                  <StatCard value={agencyTotal} label="代理店数" tone="blue" />
                  <StatCard value={agencyActive} label="有効" tone="green" />
                  <StatCard value={agencyClosed} label="稼働終了" tone="gray" />
                </div>
              </section>
            )}
            {showCases && (
              <section>
                <SectionTitle
                  right={
                    <Link className="text-xs text-blue-600 hover:underline" href={casesHref}>
                      窓口案件 →
                    </Link>
                  }
                >
                  窓口案件
                </SectionTitle>
                {/* 5枚のためラベルが潰れないよう段階的に折り返す（PC標準幅でも判読できる） */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
                  <StatCard value={caseOf("未対応")} label="未対応" tone="gray" />
                  <StatCard
                    value={caseOf("確認中") + caseOf("対応中")}
                    label="対応中"
                    tone="blue"
                  />
                  <StatCard value={caseOf("問題発生")} label="問題発生" tone="red" />
                  {/* 返信状況（§7.1 / 要件9-2⑩）: 相手方が最後に発言している未完了案件 */}
                  <StatCard value={awaitingReply} label="返信状況（返信待ち）" tone="orange" />
                  <StatCard value={overdue} label="期限超過" tone="red" />
                </div>
              </section>
            )}
          </div>
        )}
        {showAdminStats && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/admin">
                  管理画面 →
                </Link>
              }
            >
              管理（本日 {today()}）
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={auditRecent} label="直近の監査イベント件数" tone="blue" />
              <StatCard value={alertRecent} label="不正利用アラート件数" tone="red" />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              ※本日（JST）分の集計です。不正利用アラートは監査ログの失敗・拒否イベント（ログイン失敗・権限外アクセス）の件数です。並行ログイン・IP変化は日次バッチで検知し②へ通知（§3.3
              / 要件1-9）。
            </p>
          </section>
        )}
        {showAnnouncements && (
          <section>
            <SectionTitle
              right={
                <Link className="text-xs text-blue-600 hover:underline" href="/announcements">
                  お知らせ →
                </Link>
              }
            >
              最新のお知らせ
            </SectionTitle>
            <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={annUnread} label="未読お知らせ件数" tone="orange" />
            </div>
            <Card>
              {announcements.length === 0 ? (
                <p className="py-4 text-center text-sm text-slate-400">お知らせはありません。</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {announcements.map((a) => (
                    <li key={a.id} className="flex items-center gap-2 py-2.5">
                      {a.important && (
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">
                          重要
                        </span>
                      )}
                      <Link
                        href="/announcements"
                        className="truncate text-sm text-slate-700 hover:text-blue-600"
                      >
                        {a.title}
                      </Link>
                      <span className="ml-auto shrink-0 text-xs text-slate-400">
                        {a.sentAt?.toISOString().slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        )}
      </div>
    </div>
  );
}
