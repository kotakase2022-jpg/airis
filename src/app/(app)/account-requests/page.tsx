import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope } from "@/lib/auth";
import {
  REQUESTABLE_ROLES,
  REQUEST_STATUS_LABELS,
  ROLE_LABELS,
  ROLE_NUM,
  SNC_ADMIN_ROLES,
  Role,
} from "@/lib/roles";
import { formatHistory } from "@/lib/util";
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
} from "@/components/ui";
import { RequestForm, type Option } from "./request-form";
import { RowActions } from "./row-actions";
import { canFinalApproveRequest } from "./approval-rules";

const PAGE_SIZE = 50;

export default async function AccountRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requirePage("account-requests");
  const scope = await agencyScope(user);
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);

  const isSncAdmin = SNC_ADMIN_ROLES.includes(user.role);

  // 表示スコープ: ①②③=全件 / ⑦⑧=自店スコープ+自分の申請 / ④⑤⑥=自分の申請のみ
  // TODO: ④⑤⑥の閲覧範囲は仕様上明示が無いため「自分が作成した申請のみ」と暫定判断（§7.2）
  const baseWhere: Prisma.AccountRequestWhereInput = isSncAdmin
    ? {}
    : user.role === "R7" || user.role === "R8"
      ? { OR: [{ agencyId: { in: scope ?? [] } }, { createdBy: user.id }] }
      : { createdBy: user.id };

  const [total, pendingCount, approvedCount, rejectedCount, requests] = await Promise.all([
    prisma.accountRequest.count({ where: baseWhere }),
    prisma.accountRequest.count({
      where: { ...baseWhere, status: { in: ["pending_first", "pending_final"] } },
    }),
    prisma.accountRequest.count({ where: { ...baseWhere, status: "approved" } }),
    prisma.accountRequest.count({ where: { ...baseWhere, status: "rejected" } }),
    prisma.accountRequest.findMany({
      where: baseWhere,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // 所属表示用の代理店マップ（AccountRequest.agencyId はリレーション無しのため個別取得）
  const agencyIds = [...new Set(requests.map((r) => r.agencyId).filter((v): v is string => !!v))];
  const agencies = agencyIds.length
    ? await prisma.agency.findMany({ where: { id: { in: agencyIds } } })
    : [];
  const agencyMap = new Map(agencies.map((a) => [a.id, a]));

  // 申請フォーム用選択肢
  const requestableRoles: Option[] = REQUESTABLE_ROLES[user.role].map((r) => ({
    value: r,
    label: `${ROLE_NUM[r]} ${ROLE_LABELS[r]}`,
  }));
  const needsAgencyOptions = REQUESTABLE_ROLES[user.role].some(
    (r) => r === "R7" || r === "R8" || r === "R10"
  );
  let tier1: Option[] = [];
  let tier2: Option[] = [];
  if (!user.dummy && needsAgencyOptions) {
    // SNC系（scope=null）はtier一致する全代理店、⑦⑧は自店スコープ内から選択
    const agencyWhere: Prisma.AgencyWhereInput =
      scope === null ? { isDummy: false } : { id: { in: scope } };
    const list = await prisma.agency.findMany({ where: agencyWhere, orderBy: { code: "asc" } });
    tier1 = list.filter((a) => a.tier === 1).map((a) => ({ value: a.id, label: `${a.name}（${a.code}）` }));
    tier2 = list.filter((a) => a.tier === 2).map((a) => ({ value: a.id, label: `${a.name}（${a.code}）` }));
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
        <StatCard value={rejectedCount} label="差戻し・却下" tone="red" />
      </div>

      {!user.dummy && (
        <RequestForm roles={requestableRoles} tier1={tier1} tier2={tier2} />
      )}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-bold text-slate-800">申請一覧</h2>
          <span className="text-xs text-slate-500">
            全{total}件中 {from}〜{to}件を表示
          </span>
        </div>

        {requests.length === 0 ? (
          <EmptyState message="申請はまだありません" />
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
                  const canFirstApprove =
                    !user.dummy && user.role === "R7" && r.status === "pending_first" && inScope;
                  // 職務分離（§6.1-3 / 要件1-1）: SNC系ロール（①〜⑥）の申請は①②のみ
                  // 最終承認・却下できる（③には該当行のボタンを出さない）
                  const sncCanApproveTarget = isSncAdmin && canFinalApproveRequest(user.role, r.role);
                  const canFinalApprove =
                    !user.dummy && sncCanApproveTarget && r.status === "pending_final";
                  const canReject =
                    !user.dummy &&
                    ((sncCanApproveTarget &&
                      (r.status === "pending_first" || r.status === "pending_final")) ||
                      (user.role === "R7" && r.status === "pending_first" && inScope));
                  return (
                    <tr key={r.id}>
                      <td className={`${tdCls} whitespace-nowrap font-mono text-xs`}>{r.requestId}</td>
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
                            <div className="text-xs text-slate-500">
                              {agency.tier === 1 ? "一次" : "二次"}: {agency.code}
                            </div>
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
                            className="whitespace-nowrap text-xs text-blue-600 hover:underline"
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
                <Link href={`/account-requests?page=${page - 1}`} className={btnOutline}>
                  前へ
                </Link>
              ) : (
                <span className={`${btnOutline} pointer-events-none opacity-40`}>前へ</span>
              )}
              {page < totalPages ? (
                <Link href={`/account-requests?page=${page + 1}`} className={btnOutline}>
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
