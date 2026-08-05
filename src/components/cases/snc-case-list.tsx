import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/roles";
import { Badge, Card, InfoBanner, PageHeader, SectionTitle, btnOutline, btnPrimary, inputCls } from "@/components/ui";
import { today } from "@/lib/util";
import { seriesBasePath, seriesLabel } from "./badges";
import { CaseCardData, CaseCardList, Pagination } from "./case-card";
import { AgencyOption, NewCaseForm, type StaffPick } from "./new-case-form";

const PER_PAGE = 50;

// 停止・削除の状態値（actions.ts と同じ値を保持する。"use server" ファイルからは
// async 関数以外を export できないため定義を共有できない）
const CASE_SUSPENDED = "停止";
const CASE_DELETED = "削除済";
// SNC側の一覧は停止・削除済の案件も参照できる（論理削除 §3.4 / 復旧のため）。
// 代理店向けビュー（/agency-cases）からは除外する。
const CASE_LIFECYCLE_STATUSES = [CASE_SUSPENDED, CASE_DELETED] as const;

export type SearchParams = Record<string, string | string[] | undefined>;

// ホットライン窓口 / 消費者センター窓口 一覧（series="HL"/"CSC" のパラメタ違いで共通化 §7.8/§7.9）
export async function SncCaseListPage({
  user,
  series,
  sp,
}: {
  user: CurrentUser;
  series: "HL" | "CSC";
  sp: SearchParams;
}) {
  const base = seriesBasePath(series);
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const showNew = sp.new === "1" && !user.isDummy;

  // 代理店スコープ検証（SNC系は null=全代理店 §3.1）
  const scope = await agencyScope(user);

  const where: Prisma.CaseWhereInput = {
    series,
    ...(scope ? { primaryAgencyId: { in: scope } } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { caseNo: { contains: q, mode: "insensitive" } },
            { title: { contains: q } },
            { primaryAgency: { name: { contains: q } } },
            { secondaryAgency: { name: { contains: q } } },
          ],
        }
      : {}),
  };

  const [total, cases] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.findMany({
      where,
      include: { primaryAgency: true, secondaryAgency: true, reads: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
  ]);

  const agencies: AgencyOption[] = showNew
    ? await prisma.agency.findMany({
        where: { isDummy: false },
        orderBy: [{ tier: "asc" }, { code: "asc" }],
        select: { id: true, code: true, name: true, tier: true, parentId: true, status: true },
      })
    : [];

  // 販売員ID紐付け用の候補（問題一覧No.14）: 本登録・仮登録の販売員（ダミー除く）
  const staffPicks: StaffPick[] = showNew
    ? (
        await prisma.salesStaff.findMany({
          where: {
            status: { in: ["registered", "provisional"] },
            salesId: { not: null },
            agency: { isDummy: false },
          },
          select: {
            id: true,
            salesId: true,
            lastName: true,
            firstName: true,
            agencyId: true,
            agency: { select: { parentId: true } },
          },
          orderBy: { salesId: "asc" },
        })
      ).map((s) => ({
        id: s.id,
        salesId: s.salesId!,
        name: `${s.lastName} ${s.firstName}`,
        agencyId: s.agencyId,
        agencyParentId: s.agency.parentId,
      }))
    : [];

  // 集計（問題一覧No.14: 代理店別×ステータス・月別推移）。検索条件に依存せず系列全体を集計
  const statsWhere: Prisma.CaseWhereInput = {
    series,
    ...(scope ? { primaryAgencyId: { in: scope } } : {}),
  };
  const [byAgencyStatus, allForTrend] = await Promise.all([
    prisma.case.groupBy({
      by: ["primaryAgencyId", "status"],
      _count: { _all: true },
      where: statsWhere,
    }),
    prisma.case.findMany({ where: statsWhere, select: { createdAt: true } }),
  ]);
  const statAgencyIds = [...new Set(byAgencyStatus.map((r) => r.primaryAgencyId))];
  const statAgencies = statAgencyIds.length
    ? await prisma.agency.findMany({
        where: { id: { in: statAgencyIds } },
        select: { id: true, code: true, name: true },
      })
    : [];
  const statAgencyMap = new Map(statAgencies.map((a) => [a.id, a]));
  // 月別起票件数（直近6ヶ月）。基準月はJSTの今日（today()）から算出する
  const monthKeys: string[] = [];
  {
    const [ty, tm] = today().split("-").map(Number);
    for (let i = 5; i >= 0; i--) {
      const d = new Date(Date.UTC(ty, tm - 1 - i, 1));
      monthKeys.push(d.toISOString().slice(0, 7));
    }
  }
  const monthly = new Map<string, number>(monthKeys.map((m) => [m, 0]));
  for (const c of allForTrend) {
    const m = new Date(c.createdAt.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    if (monthly.has(m)) monthly.set(m, (monthly.get(m) ?? 0) + 1);
  }

  // 通知チャネル状態（環境変数の有無で表示切替 §7.8）
  // TODO: Slack/メールの実送信は未実装（アプリ内通知のみ）。Webhook/SMTP設定後に送信処理を追加する。
  const slackConfigured = !!process.env.SLACK_WEBHOOK_URL;
  const mailConfigured = !!process.env.SMTP_HOST;

  const cards: CaseCardData[] = cases.map((c) => {
    const read = c.reads.find((r) => r.agencyId === c.primaryAgencyId);
    // 代理店の既読/未読（最終更新より後に閲覧していれば既読）
    const readBadge = read && read.readAt >= c.updatedAt ? ("代理店既読" as const) : ("代理店未読" as const);
    return {
      id: c.id,
      caseNo: c.caseNo,
      series: c.series,
      templateKind: c.templateKind,
      title: c.title,
      status: c.status,
      deadline: c.deadline,
      updatedAt: c.updatedAt,
      primaryAgencyName: c.primaryAgency.name,
      secondaryAgencyName: c.secondaryAgency?.name ?? null,
      readBadge,
    };
  });

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const baseHref = qs.toString() ? `${base}?${qs.toString()}` : base;

  return (
    <div>
      <PageHeader
        title={seriesLabel(series)}
        action={
          !user.isDummy && (
            <Link href={`${base}?new=1`} className={btnPrimary}>
              新規依頼
            </Link>
          )
        }
      />

      <InfoBanner>
        SNCから代理店への依頼と返信履歴を案件単位で管理します。代理店側から新規起票はできません。
      </InfoBanner>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-500">通知チャネル:</span>
        <Badge tone="green">Airis内通知: 記録済み</Badge>
        <Badge tone={slackConfigured ? "green" : "gray"}>
          Slack: {slackConfigured ? "設定済み" : "未設定"}
        </Badge>
        <Badge tone={mailConfigured ? "green" : "gray"}>
          メール: {mailConfigured ? "設定済み" : "未設定"}
        </Badge>
      </div>

      {showNew && (
        <Card className="mb-5">
          <SectionTitle>新規依頼の起票</SectionTitle>
          <NewCaseForm series={series} basePath={base} agencies={agencies} staff={staffPicks} />
        </Card>
      )}

      {/* 集計（問題一覧No.14: 代理店別×ステータス・月別推移）とCSV出力（No.30） */}
      {!user.isDummy && (
        <Card className="mb-5">
          <div className="mb-3 flex items-center justify-between">
            <SectionTitle>集計</SectionTitle>
            <a href={`${base}/csv`} className={btnOutline} download>
              案件CSVダウンロード
            </a>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="overflow-x-auto">
              <div className="mb-1 text-xs font-semibold text-slate-500">代理店別×ステータス</div>
              <table className="w-full min-w-[420px] border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="px-2 py-1 text-left text-xs font-semibold text-slate-500">一次代理店</th>
                    {CASE_STATUSES.map((s) => (
                      <th key={s} className="px-2 py-1 text-right text-xs font-semibold text-slate-500">
                        {s}
                      </th>
                    ))}
                    <th className="px-2 py-1 text-right text-xs font-semibold text-slate-500">計</th>
                  </tr>
                </thead>
                <tbody>
                  {statAgencyIds.map((id) => {
                    const a = statAgencyMap.get(id);
                    const rowCounts = CASE_STATUSES.map(
                      (s) =>
                        byAgencyStatus.find((r) => r.primaryAgencyId === id && r.status === s)
                          ?._count._all ?? 0
                    );
                    return (
                      <tr key={id} className="border-t border-slate-100">
                        <td className="px-2 py-1 text-xs">
                          {a ? `${a.name}（${a.code}）` : id}
                        </td>
                        {rowCounts.map((n, i) => (
                          <td key={i} className="px-2 py-1 text-right text-xs">
                            {n}
                          </td>
                        ))}
                        <td className="px-2 py-1 text-right text-xs font-semibold">
                          {rowCounts.reduce((x, y) => x + y, 0)}
                        </td>
                      </tr>
                    );
                  })}
                  {statAgencyIds.length === 0 && (
                    <tr>
                      <td className="px-2 py-2 text-xs text-slate-400" colSpan={CASE_STATUSES.length + 2}>
                        案件がありません
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-500">月別起票件数（直近6ヶ月）</div>
              <div className="flex items-end gap-2">
                {monthKeys.map((m) => {
                  const n = monthly.get(m) ?? 0;
                  const max = Math.max(1, ...monthKeys.map((k) => monthly.get(k) ?? 0));
                  return (
                    <div key={m} className="flex flex-1 flex-col items-center gap-1">
                      <span className="text-xs font-semibold text-slate-700">{n}</span>
                      <div
                        className="w-full rounded-t bg-blue-200"
                        style={{ height: `${8 + (n / max) * 72}px` }}
                      />
                      <span className="text-[10px] text-slate-500">{m.slice(2)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Card>
      )}

      <form method="get" action={base} className="mb-4 flex flex-wrap items-center gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="案件ID・件名・代理店で検索"
          className={`${inputCls} max-w-xs`}
        />
        <select name="status" defaultValue={status} className={`${inputCls} w-48`}>
          <option value="">すべてのステータス</option>
          {CASE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
          {/* 停止・削除済（§5.1 停/削）もSNC側からは絞り込んで参照・復旧できる */}
          {CASE_LIFECYCLE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className={btnOutline}>検索</button>
      </form>

      <CaseCardList cases={cards} hrefBase={base} />
      <Pagination page={page} total={total} perPage={PER_PAGE} baseHref={baseHref} />
    </div>
  );
}
