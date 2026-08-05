import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope } from "@/lib/auth";
import { REQUESTABLE_ROLES, REQUEST_STATUS_LABELS, ROLE_LABELS, ROLE_NUM, Role } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import { formatHistory, requiresAgency } from "@/lib/util";
import {
  Card,
  StatCard,
  StatusBadge,
  PageHeader,
  InfoBanner,
  EmptyState,
  thCls,
  tdCls,
  btnOutline,
  btnPrimary,
  inputCls,
  labelCls,
} from "@/components/ui";
import { RequestForm, type Option } from "./request-form";
import { RowActions } from "./row-actions";
import { canFinalApproveRequest } from "./approval-rules";

const PAGE_SIZE = 50;

export default async function AccountRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; filterRole?: string; status?: string }>;
}) {
  const user = await requirePage("account-requests");
  const scope = await agencyScope(user);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  // 検索・絞り込み（検収指摘 問題一覧No.19: 棚卸・調査用）
  const q = (sp.q ?? "").trim();
  const roleFilter = (sp.filterRole ?? "").trim();
  const statusFilter = (sp.status ?? "").trim();

  // §7.2「承認操作権限は申請中レコードの閲覧を内含する」= §5.1「Airisアカウント / 承」（①②③）
  const isFinalApprover = can(user.role, "airis-account", "approve_final");
  // 代理店系ロール（⑦=1次承認者 / ⑧=申請元）は自店スコープの申請を参照できる（§3.1 / §7.2）
  const isAgencyScoped = !isFinalApprover && requiresAgency(user.role);

  // 表示スコープ: ①②③=全件 / ⑦⑧=自店スコープ+自分の申請 / ④⑤⑥=自分の申請のみ
  // TODO: ④⑤⑥の閲覧範囲は仕様上明示が無いため「自分が作成した申請のみ」と暫定判断（§7.2）
  const scopeWhere: Prisma.AccountRequestWhereInput = isFinalApprover
    ? {}
    : isAgencyScoped
      ? { OR: [{ agencyId: { in: scope ?? [] } }, { createdBy: user.id }] }
      : { createdBy: user.id };

  // 検索条件（氏名・メール・申請ID）+ ロール + ステータス（スコープとANDで合成）
  const filters: Prisma.AccountRequestWhereInput[] = [scopeWhere];
  if (q) {
    filters.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        { requestId: { contains: q, mode: "insensitive" } },
        { issuedLoginId: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (roleFilter) filters.push({ role: roleFilter });
  if (statusFilter) {
    filters.push(
      statusFilter === "pending"
        ? { status: { in: ["pending_first", "pending_final"] } }
        : { status: statusFilter }
    );
  }
  const baseWhere: Prisma.AccountRequestWhereInput = { AND: filters };

  // 統計カード4枚は §7.2「表示対象 / 承認待ち / 登録済み / 停止・削除」。
  // 第4カードは却下件数ではなく **アカウントの停止中・削除済の件数**（ロールスコープを適用）。
  const [total, pendingCount, approvedCount, inactiveAccounts, requests] = await Promise.all([
    prisma.accountRequest.count({ where: baseWhere }),
    prisma.accountRequest.count({
      where: { ...baseWhere, status: { in: ["pending_first", "pending_final"] } },
    }),
    prisma.accountRequest.count({ where: { ...baseWhere, status: "approved" } }),
    prisma.account.count({
      where: {
        status: { in: ["suspended", "deleted"] },
        ...(scope === null
          ? { OR: [{ agencyId: null }, { agency: { isDummy: false } }] }
          : { agencyId: { in: scope } }),
      },
    }),
    prisma.accountRequest.findMany({
      where: baseWhere,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // 所属表示用の代理店マップ（AccountRequest.agencyId はリレーション無しのため個別取得）。
  // §7.2「所属（一次: コード・二次: コード）」を満たすため、二次店は親の一次店も併せて取得する。
  const agencyIds = [...new Set(requests.map((r) => r.agencyId).filter((v): v is string => !!v))];
  const agencies = agencyIds.length
    ? await prisma.agency.findMany({ where: { id: { in: agencyIds } } })
    : [];
  const parentIds = [...new Set(agencies.map((a) => a.parentId).filter((v): v is string => !!v))];
  const parents = parentIds.length
    ? await prisma.agency.findMany({ where: { id: { in: parentIds } } })
    : [];
  const agencyMap = new Map([...agencies, ...parents].map((a) => [a.id, a]));

  // 申請フォーム用選択肢
  const requestableRoles: Option[] = REQUESTABLE_ROLES[user.role].map((r) => ({
    value: r,
    label: `${ROLE_NUM[r]} ${ROLE_LABELS[r]}`,
  }));
  const needsAgencyOptions = REQUESTABLE_ROLES[user.role].some(requiresAgency);
  let tier1: Option[] = [];
  let tier2: Option[] = [];
  if (!user.dummy && needsAgencyOptions) {
    // SNC系（scope=null）はtier一致する全代理店、⑦⑧は自店スコープ内から選択
    const agencyWhere: Prisma.AgencyWhereInput =
      scope === null ? { isDummy: false } : { id: { in: scope } };
    const list = await prisma.agency.findMany({ where: agencyWhere, orderBy: { code: "asc" } });
    tier1 = list
      .filter((a) => a.tier === 1)
      .map((a) => ({ value: a.id, label: `${a.name}（${a.code}）` }));
    tier2 = list
      .filter((a) => a.tier === 2)
      .map((a) => ({ value: a.id, label: `${a.name}（${a.code}）` }));
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div>
      <PageHeader title="Airisアカウント申請" />

      <InfoBanner>
        Airisアカウント（①〜⑧⑩）の申請・承認を行います。⑧二次代理店の申請は⑦一次代理店の1次承認を経てSNCが最終承認します。
        最終承認時にアカウントIDが自動採番され、一時パスワードが承認者に一度だけ表示されます。
      </InfoBanner>

      <div className="mb-5 grid grid-cols-4 gap-4">
        <StatCard value={total} label="表示対象" tone="blue" />
        <StatCard value={pendingCount} label="承認待ち" tone="orange" />
        <StatCard value={approvedCount} label="登録済み" tone="green" />
        <StatCard value={inactiveAccounts} label="停止・削除" tone="gray" />
      </div>

      {!user.dummy && <RequestForm roles={requestableRoles} tier1={tier1} tier2={tier2} />}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800">申請一覧</h2>
          <span className="text-xs text-slate-500">
            全{total}件中 {from}〜{to}件を表示
          </span>
        </div>

        {/* 検索・絞り込み（問題一覧No.19: 氏名/メール/申請ID/発行ID・ロール・状態） */}
        <form
          method="get"
          action="/account-requests"
          className="mb-4 flex flex-wrap items-end gap-3"
        >
          <div className="w-64">
            <label className={labelCls}>検索（氏名・メール・申請ID・発行ID）</label>
            <input name="q" defaultValue={q} placeholder="キーワード" className={inputCls} />
          </div>
          <div className="w-52">
            <label className={labelCls}>ロール</label>
            <select name="filterRole" defaultValue={roleFilter} className={inputCls}>
              <option value="">すべて</option>
              {(Object.keys(ROLE_LABELS) as Role[])
                .filter((r) => r !== "R9")
                .map((r) => (
                  <option key={r} value={r}>
                    {ROLE_NUM[r]} {ROLE_LABELS[r]}
                  </option>
                ))}
            </select>
          </div>
          <div className="w-44">
            <label className={labelCls}>状態</label>
            <select name="status" defaultValue={statusFilter} className={inputCls}>
              <option value="">すべて</option>
              <option value="pending">承認待ち（一次含む）</option>
              <option value="pending_first">一次承認待ち</option>
              <option value="pending_final">承認待ち</option>
              <option value="approved">登録済み</option>
              <option value="rejected">差戻し・却下</option>
            </select>
          </div>
          <button className={btnPrimary}>絞り込み</button>
          <Link href="/account-requests" className={btnOutline}>
            クリア
          </Link>
        </form>

        {requests.length === 0 ? (
          <EmptyState
            message={
              q || roleFilter || statusFilter
                ? "条件に一致する申請がありません"
                : "申請はまだありません"
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>申請ID</th>
                  <th className={thCls}>種別・氏名</th>
                  <th className={thCls}>所属</th>
                  <th className={thCls}>状態</th>
                  <th className={thCls}>証跡</th>
                  <th className={thCls}>履歴</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => {
                  const agency = r.agencyId ? agencyMap.get(r.agencyId) : undefined;
                  const inScope = !!r.agencyId && (scope ?? []).includes(r.agencyId);
                  // §5.1「一承」= ⑦のみ（自店スコープ内の pending_first に限る §3.1）
                  const canFirstApprove =
                    !user.dummy &&
                    canApproveFirst(user.role, "airis-account") &&
                    r.status === "pending_first" &&
                    inScope;
                  // 職務分離（§6.1-3 / 要件1-1）: SNC系ロール（①〜⑥）の申請は①②のみ
                  // 最終承認・却下できる（③には該当行のボタンを出さない）
                  const sncCanApproveTarget =
                    isFinalApprover && canFinalApproveRequest(user.role, r.role);
                  const canFinalApprove =
                    !user.dummy && sncCanApproveTarget && r.status === "pending_final";
                  const canReject =
                    !user.dummy &&
                    ((sncCanApproveTarget &&
                      (r.status === "pending_first" || r.status === "pending_final")) ||
                      canFirstApprove);
                  return (
                    <tr key={r.id}>
                      <td className={`${tdCls} font-mono text-xs whitespace-nowrap`}>
                        {r.requestId}
                      </td>
                      <td className={tdCls}>
                        <div className="font-medium text-slate-800">
                          {ROLE_LABELS[r.role as Role] ?? r.role}・{r.name}
                        </div>
                        <div className="text-xs text-slate-500">{r.email}</div>
                        {r.issuedLoginId && (
                          <div className="mt-0.5 font-mono text-xs text-emerald-700">
                            発行ID: {r.issuedLoginId}
                          </div>
                        )}
                      </td>
                      <td className={tdCls}>
                        {agency ? (
                          <>
                            <div className="text-sm">{agency.name}</div>
                            {/* §7.2「所属（一次: コード・二次: コード）」: 二次店は親の一次店も併記する */}
                            {agency.tier === 2 &&
                            agency.parentId &&
                            agencyMap.get(agency.parentId) ? (
                              <>
                                <div className="text-xs text-slate-500">
                                  一次: {agencyMap.get(agency.parentId)!.name}（
                                  {agencyMap.get(agency.parentId)!.code}）
                                </div>
                                <div className="text-xs text-slate-500">二次: {agency.code}</div>
                              </>
                            ) : (
                              <div className="text-xs text-slate-500">
                                {agency.tier === 1 ? "一次" : "二次"}: {agency.code}
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">SNC・サスラボ</span>
                        )}
                      </td>
                      <td className={tdCls}>
                        <StatusBadge label={REQUEST_STATUS_LABELS[r.status] ?? r.status} />
                        {r.status === "rejected" && r.rejectReason && (
                          <div className="mt-1 max-w-40 text-[11px] leading-snug text-red-600">
                            理由: {r.rejectReason}
                          </div>
                        )}
                      </td>
                      <td className={tdCls}>
                        {r.evidenceFileId ? (
                          <a
                            href={`/files/${r.evidenceFileId}`}
                            target="_blank"
                            className="text-xs whitespace-nowrap text-blue-600 hover:underline"
                          >
                            証跡を確認
                          </a>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className={`${tdCls} max-w-52 text-xs text-slate-500`}>
                        {formatHistory(r.history) || "—"}
                      </td>
                      <td className={tdCls}>
                        <RowActions
                          id={r.id}
                          canFirstApprove={canFirstApprove}
                          canFinalApprove={canFinalApprove}
                          canReject={canReject}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
            <span className="text-xs text-slate-500">
              {page} / {totalPages} ページ
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={`/account-requests?${new URLSearchParams({ ...(q && { q }), ...(roleFilter && { filterRole: roleFilter }), ...(statusFilter && { status: statusFilter }), page: String(page - 1) })}`}
                  className={btnOutline}
                >
                  前へ
                </Link>
              ) : (
                <span className={`${btnOutline} pointer-events-none opacity-40`}>前へ</span>
              )}
              {page < totalPages ? (
                <Link
                  href={`/account-requests?${new URLSearchParams({ ...(q && { q }), ...(roleFilter && { filterRole: roleFilter }), ...(statusFilter && { status: statusFilter }), page: String(page + 1) })}`}
                  className={btnOutline}
                >
                  次へ
                </Link>
              ) : (
                <span className={`${btnOutline} pointer-events-none opacity-40`}>次へ</span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
