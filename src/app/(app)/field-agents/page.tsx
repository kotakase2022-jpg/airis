import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES, STAFF_STATUS_LABELS } from "@/lib/roles";
import { audit, formatHistory } from "@/lib/util";
import {
  Card,
  StatCard,
  Badge,
  StatusBadge,
  PageHeader,
  InfoBanner,
  EmptyState,
  SectionTitle,
  inputCls,
  btnOutline,
  btnSuccess,
  btnDanger,
  thCls,
  tdCls,
} from "@/components/ui";
import { ApplyForm, type StaffOption } from "./apply-form";
import {
  firstApproveAction,
  finalApproveAction,
  suspendAction,
  resumeAction,
  removeAction,
  restoreAction,
  updateSncFieldsAction,
} from "./actions";

const PAGE_SIZE = 50;

const STATUS_OPTIONS = ["applying", "provisional", "registered", "suspended", "deleted"];

function fmtJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export default async function FieldAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requirePage("field-agents");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const agencyFilter = typeof sp.agency === "string" ? sp.agency : "";
  const statusFilter =
    typeof sp.status === "string" && STATUS_OPTIONS.includes(sp.status) ? sp.status : "";
  const page = Math.max(1, Number(sp.page) || 1);

  const scope = await agencyScope(user); // null=全代理店（SNC系）/ 配列=そのIDのみ
  const isSnc = SNC_ADMIN_ROLES.includes(user.role); // ①②③（R4は含まない）
  const canApply = !user.dummy && ["R1", "R2", "R3", "R7", "R8"].includes(user.role);
  const canFirstApprove = !user.dummy && ["R1", "R2", "R3", "R7"].includes(user.role);
  const canFinalApprove = !user.dummy && isSnc;
  const canManage = !user.dummy && ["R1", "R2", "R3", "R7"].includes(user.role); // 停止/再開/削除/復旧（販売員IDと同権限）

  // スコープ条件（SNC全域参照時はダミー代理店データを除外）
  const scopeStaffCond: Prisma.SalesStaffWhereInput =
    scope === null ? { agency: { isDummy: false } } : { agencyId: { in: scope } };
  // 代理店フィルタはスコープ内のみ有効（クライアント由来IDを信用しない §3.1）
  const listStaffCond: Prisma.SalesStaffWhereInput = agencyFilter
    ? scope === null || scope.includes(agencyFilter)
      ? { agencyId: agencyFilter }
      : { agencyId: { in: [] } }
    : scopeStaffCond;

  const where: Prisma.FieldAgentApplicationWhereInput = {
    AND: [
      { salesStaff: { is: listStaffCond } },
      ...(statusFilter ? [{ status: statusFilter }] : []),
      ...(q
        ? [
            {
              OR: [
                { lastNameKana: { contains: q } },
                { firstNameKana: { contains: q } },
                { pledgeNo: { contains: q } },
                { salesStaff: { is: { salesId: { contains: q } } } },
                { salesStaff: { is: { lastName: { contains: q } } } },
                { salesStaff: { is: { firstName: { contains: q } } } },
              ],
            },
          ]
        : []),
    ],
  };

  const statsWhere: Prisma.FieldAgentApplicationWhereInput = {
    salesStaff: { is: scopeStaffCond },
  };

  const [total, applying, working, removed, count, apps, agencies] = await Promise.all([
    prisma.fieldAgentApplication.count({ where: statsWhere }),
    prisma.fieldAgentApplication.count({ where: { ...statsWhere, status: "applying" } }),
    prisma.fieldAgentApplication.count({
      where: { ...statsWhere, status: "registered", applicationType: "稼働" },
    }),
    prisma.fieldAgentApplication.count({
      where: { ...statsWhere, status: { in: ["deleted", "suspended"] } },
    }),
    prisma.fieldAgentApplication.count({ where }),
    prisma.fieldAgentApplication.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { salesStaff: { include: { agency: true } } },
    }),
    prisma.agency.findMany({
      where: scope === null ? { isDummy: false } : { id: { in: scope } },
      orderBy: [{ tier: "asc" }, { code: "asc" }],
      select: { id: true, name: true, code: true },
    }),
  ]);

  // 申請フォーム用: スコープ内の仮登録/本登録の販売員（販売員IDの登録後にのみ申請可能 §6.3-1）
  // TODO: 販売員が大量になった場合は検索型セレクトに置き換える
  const staffList = canApply
    ? await prisma.salesStaff.findMany({
        where: { ...scopeStaffCond, status: { in: ["provisional", "registered"] } },
        include: { agency: { include: { parent: true } } },
        orderBy: { salesId: "asc" },
        take: 500,
      })
    : [];
  const staffOptions: StaffOption[] = staffList.map((s) => ({
    id: s.id,
    salesId: s.salesId ?? "（未採番）",
    name: `${s.lastName} ${s.firstName}`,
    agencyName: s.agency.name,
    agencyCode: s.agency.code,
    primaryAgencyName: s.agency.tier === 1 ? s.agency.name : s.agency.parent?.name ?? "",
  }));

  // 機微データ閲覧の監査記録（ブラックリスト欄の表示は必須記録 §3.3）
  if (isSnc) {
    await audit(user.loginId, "訪販員申請一覧閲覧（ブラックリスト欄表示）", `page=${page}`);
  }

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const buildQuery = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (agencyFilter) params.set("agency", agencyFilter);
    if (statusFilter) params.set("status", statusFilter);
    params.set("page", String(p));
    return `/field-agents?${params.toString()}`;
  };
  const from = count === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, count);

  const btnSm = " px-2.5! py-1! text-xs!";

  return (
    <div>
      <PageHeader title="訪販員申請・管理" />

      {user.dummy && (
        <InfoBanner>
          SNC閲覧アカウントのため、架空のダミーデータを表示しています。申請・承認等の操作はできません。
        </InfoBanner>
      )}
      <InfoBanner>
        訪販員申請は<strong>販売員IDの登録後にのみ</strong>
        申請できます。訪販員IDは発行されず、登録有無のステータスのみで管理されます（申請区分「抹消」の最終承認で当該訪販員登録は抹消されます）。
      </InfoBanner>

      {/* 統計カード */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <StatCard value={total} label="申請総数" tone="blue" />
        <StatCard value={applying} label="申請中" tone="orange" />
        <StatCard value={working} label="稼働" tone="green" />
        <StatCard value={removed} label="抹消・停止" tone="red" />
      </div>

      {/* 申請フォーム（R4ダミーには非表示） */}
      {canApply && <ApplyForm staff={staffOptions} isSnc={isSnc} />}

      <SectionTitle
        right={
          <a href="/field-agents/csv" className={btnOutline}>
            訪販員申請一覧CSV出力
          </a>
        }
      >
        訪販員申請一覧
      </SectionTitle>

      {/* フィルタ: 検索 / 代理店 / 状態 */}
      <form method="get" action="/field-agents" className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-64">
          <input
            name="q"
            defaultValue={q}
            placeholder="氏名・フリガナ・販売員ID・誓約書No"
            className={inputCls}
          />
        </div>
        <div className="w-56">
          <select name="agency" defaultValue={agencyFilter} className={inputCls}>
            <option value="">すべての代理店</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.code}）
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <select name="status" defaultValue={statusFilter} className={inputCls}>
            <option value="">すべての状態</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STAFF_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button className={btnOutline}>検索</button>
        {(q || agencyFilter || statusFilter) && (
          <Link href="/field-agents" className="text-xs text-blue-600 hover:underline">
            クリア
          </Link>
        )}
      </form>

      <Card>
        <div className="mb-2 text-xs text-slate-500">
          全{count}件中 {from}–{to}件を表示
        </div>
        {apps.length === 0 ? (
          <EmptyState message="該当する訪販員申請はありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>販売員ID</th>
                  <th className={thCls}>氏名（フリガナ）</th>
                  <th className={thCls}>所属代理店</th>
                  <th className={thCls}>申請区分</th>
                  <th className={thCls}>取扱商材</th>
                  <th className={thCls}>ステータス</th>
                  <th className={thCls}>稼働月</th>
                  {isSnc && <th className={thCls}>ブラックリスト</th>}
                  <th className={thCls}>最終更新</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((a) => {
                  const s = a.salesStaff;
                  return (
                    <tr key={a.id}>
                      <td className={tdCls}>
                        <div className="font-medium">{s.salesId ?? "（未採番）"}</div>
                        <div className="text-xs text-slate-400">誓約書No: {a.pledgeNo}</div>
                        {a.pledgeFileId && (
                          <a
                            href={`/files/${a.pledgeFileId}`}
                            className="text-xs text-blue-600 hover:underline"
                          >
                            誓約書PDF
                          </a>
                        )}
                      </td>
                      <td className={tdCls}>
                        <div className="font-medium">
                          {s.lastName} {s.firstName}
                        </div>
                        <div className="text-xs text-slate-400">
                          {a.lastNameKana ?? ""} {a.firstNameKana ?? ""}
                        </div>
                      </td>
                      <td className={tdCls}>
                        <div>{a.agencyName ?? s.agency.name}</div>
                        {a.primaryAgencyName && (
                          <div className="text-xs text-slate-400">1次店: {a.primaryAgencyName}</div>
                        )}
                      </td>
                      <td className={tdCls}>
                        <StatusBadge label={a.applicationType} />
                      </td>
                      <td className={tdCls}>{a.products}</td>
                      <td className={tdCls}>
                        <StatusBadge label={STAFF_STATUS_LABELS[a.status] ?? a.status} />
                        <div className="mt-1 max-w-52 text-[10px] leading-4 text-slate-400">
                          {formatHistory(a.history)}
                        </div>
                      </td>
                      <td className={tdCls}>{a.workMonth ?? "—"}</td>
                      {isSnc && (
                        <td className={tdCls}>
                          {a.blacklistFlag === "★" ? (
                            <Badge tone="red">★</Badge>
                          ) : a.blacklistFlag === "1" ? (
                            <Badge tone="yellow">1</Badge>
                          ) : (
                            <span className="text-xs text-slate-400">無印</span>
                          )}
                          {a.sncMemo && (
                            <div
                              className="mt-1 max-w-36 truncate text-xs text-slate-500"
                              title={a.sncMemo}
                            >
                              {a.sncMemo}
                            </div>
                          )}
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-blue-600">
                              編集
                            </summary>
                            <form action={updateSncFieldsAction} className="mt-1 w-40 space-y-1">
                              <input type="hidden" name="id" value={a.id} />
                              <select
                                name="blacklistFlag"
                                defaultValue={a.blacklistFlag ?? ""}
                                className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
                              >
                                <option value="">無印（問題なし）</option>
                                <option value="★">★（ブラックリスト）</option>
                                <option value="1">1（要注意）</option>
                              </select>
                              <input
                                name="sncMemo"
                                defaultValue={a.sncMemo ?? ""}
                                placeholder="SNC用メモ"
                                className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
                              />
                              <button className={btnOutline + btnSm}>保存</button>
                            </form>
                          </details>
                        </td>
                      )}
                      <td className={tdCls}>
                        <span className="whitespace-nowrap text-xs">{fmtJst(a.updatedAt)}</span>
                      </td>
                      <td className={tdCls}>
                        <div className="flex flex-wrap gap-1">
                          {a.status === "applying" && canFirstApprove && (
                            <form action={firstApproveAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnSuccess + btnSm}>1次承認</button>
                            </form>
                          )}
                          {["applying", "provisional"].includes(a.status) && canFinalApprove && (
                            <form action={finalApproveAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnSuccess + btnSm}>
                                {a.applicationType === "抹消" ? "最終承認（抹消）" : "最終承認"}
                              </button>
                            </form>
                          )}
                          {["provisional", "registered"].includes(a.status) && canManage && (
                            <form action={suspendAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnDanger + btnSm}>停止</button>
                            </form>
                          )}
                          {a.status === "suspended" && canManage && (
                            <form action={resumeAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnOutline + btnSm}>再開</button>
                            </form>
                          )}
                          {a.status !== "deleted" && canManage && (
                            <form action={removeAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnOutline + btnSm}>削除</button>
                            </form>
                          )}
                          {a.status === "deleted" && canManage && (
                            <form action={restoreAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button className={btnOutline + btnSm}>復旧</button>
                            </form>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* ページネーション（50件/頁） */}
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
          <div className="text-xs text-slate-500">
            {page} / {totalPages} ページ
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={buildQuery(page - 1)} className={btnOutline + btnSm}>
                ← 前へ
              </Link>
            ) : (
              <span className={btnOutline + btnSm + " pointer-events-none opacity-40"}>← 前へ</span>
            )}
            {page < totalPages ? (
              <Link href={buildQuery(page + 1)} className={btnOutline + btnSm}>
                次へ →
              </Link>
            ) : (
              <span className={btnOutline + btnSm + " pointer-events-none opacity-40"}>次へ →</span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
