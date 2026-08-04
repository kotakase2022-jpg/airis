import { Prisma } from "@prisma/client";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { CASE_STATUSES } from "@/lib/roles";
import { InfoBanner, PageHeader, btnOutline, inputCls } from "@/components/ui";
import { CaseCardData, CaseCardList, Pagination } from "@/components/cases/case-card";

const PER_PAGE = 50;

// 窓口案件（§7.10: R7/R10 代理店向け統合ビュー。HL/CSC両series混在・自店案件のみ）
export default async function AgencyCasesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePage("agency-cases");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const page = Math.max(1, Number(sp.page) || 1);

  // 自店（1次店）スコープの案件のみ（§3.1）
  const scope = await agencyScope(user);
  const scopeIds = scope ?? [];

  const where: Prisma.CaseWhereInput = {
    primaryAgencyId: { in: scopeIds },
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
      include: { primaryAgency: true, secondaryAgency: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PER_PAGE,
      take: PER_PAGE,
    }),
  ]);

  const cards: CaseCardData[] = cases.map((c) => ({
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
  }));

  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const baseHref = qs.toString() ? `/agency-cases?${qs.toString()}` : "/agency-cases";

  return (
    <div>
      <PageHeader title="窓口案件" />

      <InfoBanner>
        ホットライン窓口・消費者センター窓口からの依頼案件を確認し、返信できます。代理店側からの新規起票はできません。
      </InfoBanner>

      <form method="get" action="/agency-cases" className="mb-4 flex flex-wrap items-center gap-2">
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

      <CaseCardList
        cases={cards}
        hrefBase="/agency-cases"
        showSeries
        emptyMessage="自店宛の窓口案件はありません。"
      />
      <Pagination page={page} total={total} perPage={PER_PAGE} baseHref={baseHref} />
    </div>
  );
}
