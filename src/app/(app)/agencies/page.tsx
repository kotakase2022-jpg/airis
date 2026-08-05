import Link from "next/link";
import { agencyScope, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES } from "@/lib/roles";
import { today } from "@/lib/util";
import {
  Badge,
  Card,
  EmptyState,
  InfoBanner,
  PageHeader,
  SectionTitle,
  StatCard,
  StatusBadge,
  btnOutline,
  inputCls,
  labelCls,
  tdCls,
  thCls,
} from "@/components/ui";
import { AddAgencyButton, DeleteAgencyForm, EditAgencyButton } from "./client";
import { AGENCY_STATUS_LABELS } from "./labels";

const PER_PAGE = 50;

// JST日付表示（YYYY-MM-DD）
function fmtDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function AgenciesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; status?: string }>;
}) {
  const user = await requirePage("agencies");
  const scope = await agencyScope(user); // null = 全代理店（SNC系）/ 配列 = そのIDのみ
  const canEdit = SNC_ADMIN_ROLES.includes(user.role) && !user.dummy; // R4ダミーは閲覧のみ

  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const statusFilter = sp.status && sp.status in AGENCY_STATUS_LABELS ? sp.status : "all";
  const page = Math.max(1, Number(sp.page) || 1);

  // スコープ条件（R4ダミーはダミー代理店IDに、⑦は自店+配下にスコープされる）
  const baseWhere = scope ? { id: { in: scope } } : { isDummy: false };
  const staffCountFilter = { where: { status: { not: "deleted" } } };
  const accountCountFilter = { where: { status: { not: "deleted" } } };

  // 統計カード + 階層ツリー用データ
  const [subTotal, subActive, primaries] = await Promise.all([
    prisma.agency.count({ where: { ...baseWhere, tier: 2 } }),
    prisma.agency.count({ where: { ...baseWhere, tier: 2, status: "active" } }),
    prisma.agency.findMany({
      where: { ...baseWhere, tier: 1 },
      orderBy: { code: "asc" },
      include: {
        _count: { select: { accounts: accountCountFilter, salesStaff: staffCountFilter } },
        children: {
          where: scope ? { id: { in: scope } } : {},
          orderBy: { code: "asc" },
          include: {
            _count: { select: { accounts: accountCountFilter, salesStaff: staffCountFilter } },
          },
        },
      },
    }),
  ]);

  // 総ユーザー数（Account数）・管轄内進行中案件（scope内の未完了Case件数 §7.11）はスコープ内代理店で集計
  const scopedIds = (await prisma.agency.findMany({ where: baseWhere, select: { id: true } })).map(
    (a) => a.id
  );
  const [userTotal, ongoingCaseTotal] = await Promise.all([
    prisma.account.count({
      where: { agencyId: { in: scopedIds }, status: { not: "deleted" } },
    }),
    prisma.case.count({
      where: { primaryAgencyId: { in: scopedIds }, status: { not: "完了" } },
    }),
  ]);

  // 下位代理店（2次店）一覧: 検索 + ステータスフィルタ + ページネーション（50件/頁）
  const listWhere = {
    ...baseWhere,
    tier: 2,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(q
      ? {
          OR: [
            { code: { contains: q } },
            { name: { contains: q } },
            { representative: { contains: q } },
          ],
        }
      : {}),
  };
  const total = await prisma.agency.count({ where: listWhere });
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const current = Math.min(page, totalPages);
  const rows = await prisma.agency.findMany({
    where: listWhere,
    orderBy: { code: "asc" },
    skip: (current - 1) * PER_PAGE,
    take: PER_PAGE,
    include: {
      parent: { select: { name: true, code: true } },
      _count: { select: { accounts: accountCountFilter, salesStaff: staffCountFilter } },
    },
  });
  const from = total === 0 ? 0 : (current - 1) * PER_PAGE + 1;
  const to = Math.min(current * PER_PAGE, total);

  // 一覧列「進行中案件」: 当該代理店が primary の未完了Case件数（§7.11）
  const ongoingCaseRows = rows.length
    ? await prisma.case.groupBy({
        by: ["primaryAgencyId"],
        where: { primaryAgencyId: { in: rows.map((a) => a.id) }, status: { not: "完了" } },
        _count: { _all: true },
      })
    : [];
  const ongoingCaseByAgency = new Map(
    ongoingCaseRows.map((c) => [c.primaryAgencyId, c._count._all])
  );

  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("page", String(p));
    return `/agencies?${params.toString()}`;
  };

  const primaryOptions = primaries
    .filter((p) => p.status === "active")
    .map((p) => ({ id: p.id, code: p.code, name: p.name }));

  return (
    <div>
      <PageHeader
        title="下位代理店"
        action={
          canEdit ? (
            <AddAgencyButton primaries={primaryOptions} defaultJoinedAt={today()} />
          ) : undefined
        }
      />

      <InfoBanner>
        {user.role === "R7"
          ? "配下の下位代理店を確認できます。"
          : "全一次代理店の下位代理店を管理しています。追加時は管轄する一次代理店を選択してください。"}
      </InfoBanner>

      {/* 統計カード */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <StatCard value={subTotal} label="下位代理店数" tone="blue" />
        <StatCard value={subActive} label="有効代理店" tone="green" />
        <StatCard value={userTotal} label="総ユーザー数" tone="purple" />
        <StatCard value={ongoingCaseTotal} label="管轄内進行中案件" tone="orange" />
      </div>

      {/* 代理店階層ツリー */}
      <Card className="mb-5">
        <SectionTitle>代理店階層ツリー</SectionTitle>
        {primaries.length === 0 ? (
          <EmptyState message="表示できる代理店がありません。" />
        ) : (
          <div className="space-y-4">
            {primaries.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-l-4 border-slate-200 border-l-emerald-500 bg-white px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-bold text-slate-800">{p.name}</span>
                  <Badge tone="green">ID: {p.code}</Badge>
                  <Badge tone="blue">下位 {p.children.length} 店</Badge>
                  <StatusBadge label={AGENCY_STATUS_LABELS[p.status] ?? p.status} />
                  <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                    ユーザー {p._count.accounts} / 販売員 {p._count.salesStaff}
                    {canEdit && (
                      <EditAgencyButton
                        agency={{
                          id: p.id,
                          code: p.code,
                          name: p.name,
                          representative: p.representative,
                          status: p.status,
                          tier: p.tier,
                        }}
                      />
                    )}
                  </span>
                </div>
                {p.children.length > 0 && (
                  <div className="mt-3 ml-6 space-y-2">
                    {p.children.map((c) => (
                      <div
                        key={c.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-l-4 border-slate-200 border-l-blue-500 bg-slate-50 px-3 py-2"
                      >
                        <span className="text-sm font-medium text-slate-700">{c.name}</span>
                        <Badge tone="blue">ID: {c.code}</Badge>
                        <span className="text-xs text-slate-500">
                          ユーザー {c._count.accounts} / 販売員 {c._count.salesStaff}
                        </span>
                        <span className="ml-auto">
                          <StatusBadge label={AGENCY_STATUS_LABELS[c.status] ?? c.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 下位代理店一覧 */}
      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-500">
              全{total}件中 {from}〜{to}件を表示
            </span>
          }
        >
          下位代理店一覧
        </SectionTitle>

        {/* 検索 + ステータスフィルタ */}
        <form action="/agencies" method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-64">
            <label className={labelCls}>検索</label>
            <input
              name="q"
              defaultValue={q}
              className={inputCls}
              placeholder="コード・代理店名・代表者"
            />
          </div>
          <div className="w-40">
            <label className={labelCls}>ステータス</label>
            <select name="status" defaultValue={statusFilter} className={inputCls}>
              <option value="all">すべて</option>
              <option value="active">{AGENCY_STATUS_LABELS.active}</option>
              <option value="closed">{AGENCY_STATUS_LABELS.closed}</option>
            </select>
          </div>
          <button className={btnOutline}>絞り込む</button>
        </form>

        {rows.length === 0 ? (
          <EmptyState message="条件に一致する下位代理店がありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className={thCls}>ID</th>
                  <th className={thCls}>代理店名</th>
                  <th className={thCls}>一次代理店</th>
                  <th className={thCls}>代表者</th>
                  <th className={thCls}>ステータス</th>
                  <th className={thCls}>登録ユーザー</th>
                  <th className={thCls}>進行中案件</th>
                  <th className={thCls}>参加日</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className={tdCls}>
                      <span className="font-mono text-xs">{a.code}</span>
                    </td>
                    <td className={`${tdCls} font-medium text-slate-800`}>{a.name}</td>
                    <td className={tdCls}>
                      {a.parent ? (
                        <>
                          {a.parent.name}
                          <span className="ml-1 text-xs text-slate-400">({a.parent.code})</span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={tdCls}>{a.representative ?? "—"}</td>
                    <td className={tdCls}>
                      <StatusBadge label={AGENCY_STATUS_LABELS[a.status] ?? a.status} />
                    </td>
                    <td className={tdCls}>{a._count.accounts}</td>
                    <td className={tdCls}>{ongoingCaseByAgency.get(a.id) ?? 0}</td>
                    <td className={tdCls}>{fmtDate(a.joinedAt)}</td>
                    <td className={tdCls}>
                      {canEdit ? (
                        <div className="flex items-start gap-2">
                          <EditAgencyButton
                            agency={{
                              id: a.id,
                              code: a.code,
                              name: a.name,
                              representative: a.representative,
                              status: a.status,
                              tier: a.tier,
                            }}
                          />
                          <DeleteAgencyForm id={a.id} name={a.name} />
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">閲覧のみ</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ページネーション（50件/頁） */}
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3 text-sm">
            {current > 1 ? (
              <Link href={pageHref(current - 1)} className={btnOutline}>
                ← 前へ
              </Link>
            ) : (
              <span className={`${btnOutline} pointer-events-none opacity-40`}>← 前へ</span>
            )}
            <span className="text-slate-500">
              {current} / {totalPages} ページ
            </span>
            {current < totalPages ? (
              <Link href={pageHref(current + 1)} className={btnOutline}>
                次へ →
              </Link>
            ) : (
              <span className={`${btnOutline} pointer-events-none opacity-40`}>次へ →</span>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
