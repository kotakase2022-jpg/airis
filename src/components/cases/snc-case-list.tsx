import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/roles";
import { Badge, Card, InfoBanner, PageHeader, SectionTitle, btnOutline, btnPrimary, inputCls } from "@/components/ui";
import { seriesBasePath, seriesLabel } from "./badges";
import { CaseCardData, CaseCardList, Pagination } from "./case-card";
import { AgencyOption, NewCaseForm } from "./new-case-form";

const PER_PAGE = 50;

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
          <NewCaseForm series={series} basePath={base} agencies={agencies} />
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
        </select>
        <button className={btnOutline}>検索</button>
      </form>

      <CaseCardList cases={cards} hrefBase={base} />
      <Pagination page={page} total={total} perPage={PER_PAGE} baseHref={baseHref} />
    </div>
  );
}
