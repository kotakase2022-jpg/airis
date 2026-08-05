import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canAccess, SUBMISSION_KINDS } from "@/lib/roles";
import { Card, PageHeader, SectionTitle, StatCard, InfoBanner } from "@/components/ui";
import { today } from "@/lib/util";

export const dynamic = "force-dynamic";

// 日報未提出者の母数となる販売員ステータス（日報を提出できるのは仮登録・本登録 §7.5）
const REPORTABLE_STAFF_STATUS = ["provisional", "registered"];

export default async function DashboardPage() {
  const user = await requirePage("dashboard");
  const scope = await agencyScope(user);
  const agencyFilter = scope === null ? {} : { agencyId: { in: scope } };
  const month = today().slice(0, 7);

  // Airisアカウント申請
  const [reqPending, reqApproved, reqRejected] = canAccess(user.role, "account-requests")
    ? await Promise.all([
        prisma.accountRequest.count({ where: { status: { in: ["pending_first", "pending_final"] } } }),
        prisma.accountRequest.count({ where: { status: "approved" } }),
        prisma.accountRequest.count({ where: { status: "rejected" } }),
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
  // ⑨販売員は稼働提出物=×（§5.2）。未提出者の集計も管理系ロール向けの指標のため出さない。
  const showReportAdmin = showReports && user.role !== "R9";
  const submissionScope = scope === null ? {} : { submitterAgencyId: { in: scope } };
  const reportCount = showReports
    ? await prisma.dailyReport.count({
        where: { date: { startsWith: month }, ...(scope === null ? {} : { agencyId: { in: scope } }) },
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
    canAccess(user.role, "hotline") || canAccess(user.role, "consumer-center") || canAccess(user.role, "agency-cases");
  const caseWhere = {
    ...(user.role === "R5" ? { series: "HL" } : user.role === "R6" ? { series: "CSC" } : {}),
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

  // お知らせ
  // ④ダミー表示（§3.5）: 閲覧アカウントにはシードの架空データ（isDummy=true）のみを出し、
  // 実データには一切アクセスさせない。逆に非ダミーロールにはサンプルデータを出さない。
  const showAnnouncements = canAccess(user.role, "announcements");
  const annWhere: Prisma.AnnouncementWhereInput = {
    status: "sent",
    isDummy: user.isDummy,
    ...(user.role === "R8" || user.role === "R9" ? { audience: "all" } : {}),
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

  const casesHref = canAccess(user.role, "agency-cases")
    ? "/agency-cases"
    : user.role === "R6"
      ? "/consumer-center"
      : "/hotline";

  return (
    <div>
      <PageHeader title="ダッシュボード" />
      {user.isDummy && (
        <InfoBanner>閲覧用アカウントのため、表示されているのはサンプルデータです。</InfoBanner>
      )}
      <div className="space-y-6">
        {canAccess(user.role, "account-requests") && (
          <section>
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/account-requests">Airisアカウント申請 →</Link>}>
              Airisアカウント申請
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={reqPending} label="承認待ち" tone="orange" />
              <StatCard value={reqApproved} label="登録済み" tone="green" />
              <StatCard value={reqRejected} label="差戻し・却下" tone="red" />
            </div>
          </section>
        )}
        {canAccess(user.role, "sales-staff") && (
          <section>
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/sales-staff">販売員ID管理 →</Link>}>
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
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/field-agents">訪販員申請・管理 →</Link>}>
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
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/reports">各種資料の提出 →</Link>}>
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
                <StatCard value={submissionApproved} label="提出物 最終承認済み（当月）" tone="green" />
              )}
            </div>
          </section>
        )}
        {(showAgencies || showCases) && (
          <div className="grid gap-6 md:grid-cols-2">
            {showAgencies && (
              <section>
                <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/agencies">下位代理店 →</Link>}>
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
                <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href={casesHref}>窓口案件 →</Link>}>
                  窓口案件
                </SectionTitle>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <StatCard value={caseOf("未対応")} label="未対応" tone="gray" />
                  <StatCard value={caseOf("確認中") + caseOf("対応中")} label="対応中" tone="blue" />
                  <StatCard value={caseOf("問題発生")} label="問題発生" tone="red" />
                  <StatCard value={overdue} label="期限超過" tone="red" />
                </div>
              </section>
            )}
          </div>
        )}
        {showAdminStats && (
          <section>
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/admin">管理画面 →</Link>}>
              管理（本日 {today()}）
            </SectionTitle>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <StatCard value={auditRecent} label="直近の監査イベント件数" tone="blue" />
              <StatCard value={alertRecent} label="不正利用アラート件数" tone="red" />
            </div>
            <p className="mt-2 text-xs text-slate-400">
              ※本日（JST）分の集計です。不正利用アラートは監査ログの失敗・拒否イベント（ログイン失敗・権限外アクセス）の件数です。並行ログイン・IP変化は日次バッチで検知し②へ通知（§3.3 / 要件1-9）。
            </p>
          </section>
        )}
        {showAnnouncements && (
          <section>
            <SectionTitle right={<Link className="text-xs text-blue-600 hover:underline" href="/announcements">お知らせ →</Link>}>
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
                        <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">重要</span>
                      )}
                      <Link href="/announcements" className="truncate text-sm text-slate-700 hover:text-blue-600">
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
