// 販売員ID管理（ページキー: "sales-staff"。SPEC §6.2 / §7.3）
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { agencyScope, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES, STAFF_STATUS_LABELS } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import { formatHistory } from "@/lib/util";
import {
  Card,
  EmptyState,
  InfoBanner,
  PageHeader,
  SectionTitle,
  StatCard,
  StatusBadge,
  btnOutline,
  btnPrimary,
  inputCls,
  tdCls,
  thCls,
} from "@/components/ui";
import { ApplyForm, CsvBulkForm, RowActions } from "./client";

const PAGE_SIZE = 50;

function fmtJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export default async function SalesStaffPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; agency?: string; status?: string }>;
}) {
  const user = await requirePage("sales-staff");
  const scope = await agencyScope(user); // null=全代理店可 / 配列=そのIDのみ
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const agencyFilter = sp.agency ?? "";
  const statusFilter = sp.status ?? "";
  const page = Math.max(1, Number(sp.page ?? "1") || 1);

  // スコープ内の代理店（フィルタ・申請フォーム用）
  const agencies = await prisma.agency.findMany({
    where: scope ? { id: { in: scope } } : { isDummy: false },
    orderBy: [{ tier: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, tier: true, status: true },
  });

  const scopeWhere: Prisma.SalesStaffWhereInput = scope
    ? { agencyId: { in: scope } }
    : { agency: { isDummy: false } };

  const and: Prisma.SalesStaffWhereInput[] = [scopeWhere];
  if (q) {
    and.push({
      OR: [
        { lastName: { contains: q } },
        { firstName: { contains: q } },
        { salesId: { contains: q } },
        { email: { contains: q } },
        { phone: { contains: q } },
      ],
    });
  }
  if (agencyFilter && (!scope || scope.includes(agencyFilter)))
    and.push({ agencyId: agencyFilter });
  if (statusFilter && statusFilter in STAFF_STATUS_LABELS) and.push({ status: statusFilter });
  const where: Prisma.SalesStaffWhereInput = { AND: and };

  const [grouped, total, staffList] = await Promise.all([
    prisma.salesStaff.groupBy({ by: ["status"], _count: { _all: true }, where: scopeWhere }),
    prisma.salesStaff.count({ where }),
    prisma.salesStaff.findMany({
      where,
      include: { agency: true },
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);
  const cnt = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const totalAll = grouped.reduce((a, g) => a + g._count._all, 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  // 操作権限（§5.1 の宣言的マップで判定 §3.2。R4=ダミー表示は全書き込みUI非表示。server action 側でも拒否している）
  const canWrite = !user.dummy;
  const canApply = canWrite && can(user.role, "sales-staff", "apply");
  const canUpdate = canWrite && can(user.role, "sales-staff", "update");
  const canFirstApprove = canWrite && canApproveFirst(user.role, "sales-staff");
  const canFinalApprove = canWrite && can(user.role, "sales-staff", "approve_final");
  const canSuspend = canWrite && can(user.role, "sales-staff", "suspend");
  const canDelete = canWrite && can(user.role, "sales-staff", "delete");
  // 復旧は §5.1 の操作列に無い管理機能（§3.4）。SNC管理系（①②③）のみ。
  const canRestore = canWrite && SNC_ADMIN_ROLES.includes(user.role);

  const href = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (agencyFilter) u.set("agency", agencyFilter);
    if (statusFilter) u.set("status", statusFilter);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return `/sales-staff${s ? `?${s}` : ""}`;
  };

  // TODO: SNC系ロールによる個人情報閲覧の監査記録（§3.3）は詳細画面実装時に対応
  return (
    <div>
      <PageHeader title="販売員ID管理" />

      <InfoBanner>
        {scope === null ? (
          <>
            全代理店の販売員IDを申請・承認・管理できます。GiGaCC連携用CSVは本登録の販売員のみ出力されます。
          </>
        ) : (
          <>
            操作可能な代理店: {agencies.map((a) => `${a.name}（${a.code}）`).join("、") || "なし"}
          </>
        )}
      </InfoBanner>

      <div className="mb-4 grid grid-cols-4 gap-3">
        <StatCard value={totalAll} label="販売員ID総数" tone="blue" />
        <StatCard
          value={cnt("registered") + cnt("provisional")}
          label="本登録・仮登録"
          tone="green"
        />
        <StatCard value={cnt("applying")} label="申請中" tone="orange" />
        <StatCard value={cnt("suspended") + cnt("deleted")} label="停止・削除" tone="gray" />
      </div>

      {canApply && (
        <Card className="mb-4">
          <details>
            <summary className="cursor-pointer text-sm font-bold text-blue-700">
              ＋ 販売員ID申請
            </summary>
            <div className="mt-4">
              <ApplyForm
                agencies={agencies
                  .filter((a) => a.status === "active")
                  .map(({ id, code, name, tier }) => ({ id, code, name, tier }))}
                fixedAgencyId={user.role === "R8" ? (user.agencyId ?? undefined) : undefined}
              />
            </div>
          </details>
          <details className="mt-3 border-t border-slate-100 pt-3">
            <summary className="cursor-pointer text-sm font-bold text-blue-700">
              CSV一括申請（初回大量登録用）
            </summary>
            <div className="mt-4">
              <CsvBulkForm />
            </div>
          </details>
        </Card>
      )}

      <Card>
        <SectionTitle
          right={
            <div className="flex flex-wrap gap-2">
              <a href="/sales-staff/csv/template" className={btnOutline}>
                一括申請CSVひな形
              </a>
              <a href="/sales-staff/csv/list" className={btnOutline}>
                販売員一覧CSV出力
              </a>
              <a href="/sales-staff/csv/gigacc" className={btnOutline}>
                GiGaCC連携用CSV出力（本登録のみ）
              </a>
            </div>
          }
        >
          販売員一覧（全{total}件）
        </SectionTitle>

        <form method="get" className="mb-3 flex flex-wrap items-center gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="氏名・販売員ID・メール・電話で検索"
            className={`${inputCls} max-w-72`}
          />
          <select name="agency" defaultValue={agencyFilter} className={`${inputCls} max-w-64`}>
            <option value="">すべての代理店</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.tier === 2 ? "　" : ""}
                {a.name}（{a.code}）
              </option>
            ))}
          </select>
          <select name="status" defaultValue={statusFilter} className={`${inputCls} max-w-40`}>
            <option value="">すべての状態</option>
            {Object.entries(STAFF_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className={btnPrimary}>絞り込み</button>
          {(q || agencyFilter || statusFilter) && (
            <Link href="/sales-staff" className="text-sm text-blue-600 hover:underline">
              クリア
            </Link>
          )}
        </form>

        {staffList.length === 0 ? (
          <EmptyState message="条件に一致する販売員がいません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>販売員ID</th>
                  <th className={thCls}>氏名</th>
                  <th className={thCls}>所属代理店</th>
                  <th className={thCls}>ステータス</th>
                  <th className={thCls}>最終更新</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {staffList.map((s) => {
                  const label = STAFF_STATUS_LABELS[s.status] ?? s.status;
                  const history = formatHistory(s.history);
                  return (
                    <tr key={s.id}>
                      <td className={tdCls}>
                        {s.salesId ? (
                          <span className="font-mono font-semibold text-slate-800">
                            {s.salesId}
                          </span>
                        ) : (
                          <span className="text-slate-400">未採番</span>
                        )}
                      </td>
                      <td className={tdCls}>
                        <div className="font-medium text-slate-800">
                          {s.lastName} {s.firstName}
                        </div>
                        <div className="text-xs text-slate-500">
                          {s.birthDate} / {s.phone}
                          {s.email ? ` / ${s.email}` : ""}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div>{s.agency.name}</div>
                        <div className="text-xs text-slate-500">{s.agency.code}</div>
                      </td>
                      <td className={tdCls}>
                        <StatusBadge label={label} />
                        {s.firstApproved &&
                          (s.status === "applying" || s.status === "provisional") && (
                            <div className="mt-1 text-[11px] text-slate-500">1次承認済み</div>
                          )}
                        {history && (
                          <div className="mt-1 max-w-56 text-[11px] leading-relaxed text-slate-400">
                            {history}
                          </div>
                        )}
                      </td>
                      <td className={`${tdCls} whitespace-nowrap`}>{fmtJst(s.updatedAt)}</td>
                      <td className={`${tdCls} min-w-44`}>
                        {canWrite ? (
                          <RowActions
                            staffId={s.id}
                            status={s.status}
                            initial={{
                              lastName: s.lastName,
                              firstName: s.firstName,
                              birthDate: s.birthDate,
                              phone: s.phone,
                              email: s.email ?? "",
                            }}
                            canUpdate={canUpdate}
                            canFirstApprove={canFirstApprove}
                            canFinalApprove={canFinalApprove}
                            canSuspend={canSuspend}
                            canDelete={canDelete}
                            canRestore={canRestore}
                          />
                        ) : (
                          <span className="text-xs text-slate-400">閲覧のみ</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
          <span>
            全{total}件中 {from}〜{to}件を表示
          </span>
          <div className="flex items-center gap-2">
            {page > 1 ? (
              <Link href={href(page - 1)} className={btnOutline}>
                ← 前へ
              </Link>
            ) : (
              <span className={`${btnOutline} pointer-events-none opacity-40`}>← 前へ</span>
            )}
            <span>
              {page} / {totalPages} ページ
            </span>
            {page < totalPages ? (
              <Link href={href(page + 1)} className={btnOutline}>
                次へ →
              </Link>
            ) : (
              <span className={`${btnOutline} pointer-events-none opacity-40`}>次へ →</span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
