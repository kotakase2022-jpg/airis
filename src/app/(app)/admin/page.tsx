import Link from "next/link";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { agencyScope, requirePage } from "@/lib/auth";
import { ACCOUNT_STATUS_LABELS, ROLE_LABELS, ROLE_NUM, Role } from "@/lib/roles";
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
  btnPrimary,
  inputCls,
  labelCls,
  tdCls,
  thCls,
} from "@/components/ui";
import { today } from "@/lib/util";
import { AccountRowActions } from "./row-actions";

const PAGE_SIZE = 50;

function jst(d: Date, len = 10): string {
  return new Date(d.getTime() + 9 * 3600 * 1000)
    .toISOString()
    .slice(0, len)
    .replace("T", " ");
}

type AuditRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  result: string;
};

// R4（SNC閲覧）用の架空監査ログ（実データへは一切アクセスさせない §3.5）
function dummyAuditRows(): AuditRow[] {
  const d = today();
  return [
    { id: "d1", at: `${d} 09:12`, actor: "airis_snc_adm_001", action: "login", target: "", result: "success" },
    { id: "d2", at: `${d} 09:15`, actor: "airis_snc_adm_001", action: "account_suspend", target: "airis_2990002_001", result: "success" },
    { id: "d3", at: `${d} 09:20`, actor: "airis_snc_ops_0001", action: "final_approve", target: "REQ-990013", result: "success" },
    { id: "d4", at: `${d} 10:02`, actor: "airis_1990001_001", action: "login", target: "", result: "failure" },
    { id: "d5", at: `${d} 10:41`, actor: "airis_snc_adm_001", action: "csv_export", target: "accounts_inventory", result: "success" },
  ];
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePage("admin");
  const scope = await agencyScope(user);
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");
  const q = str(sp.q).trim();
  const roleFilter = str(sp.role);
  const statusFilter = str(sp.status);
  const page = Math.max(1, Number(str(sp.page)) || 1);

  // 代理店スコープ（§3.1）: R4はダミー代理店のみ / R1・R2は実データ（ダミー代理店を除外）
  const scopeFilter: Prisma.AccountWhereInput =
    scope !== null
      ? { agencyId: { in: scope } }
      : { OR: [{ agencyId: null }, { agency: { isDummy: false } }] };

  const filters: Prisma.AccountWhereInput[] = [scopeFilter];
  if (q) {
    filters.push({
      OR: [
        { loginId: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (roleFilter) filters.push({ role: roleFilter });
  if (statusFilter) filters.push({ status: statusFilter });
  const where: Prisma.AccountWhereInput = { AND: filters };

  const [grouped, totalCount, accounts, auditLogs] = await Promise.all([
    prisma.account.groupBy({ by: ["status"], _count: { _all: true }, where: scopeFilter }),
    prisma.account.count({ where }),
    prisma.account.findMany({
      where,
      include: { agency: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    user.dummy
      ? Promise.resolve([])
      : prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);

  const countOf = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;
  const totalAll = grouped.reduce((n, g) => n + g._count._all, 0);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const from = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, totalCount);
  const pageHref = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (roleFilter) params.set("role", roleFilter);
    if (statusFilter) params.set("status", statusFilter);
    params.set("page", String(p));
    return `/admin?${params.toString()}`;
  };

  const auditRows: AuditRow[] = user.dummy
    ? dummyAuditRows()
    : auditLogs.map((l) => ({
        id: l.id,
        at: jst(l.createdAt, 16),
        actor: l.actor,
        action: l.action,
        target: l.target ?? "",
        result: l.result,
      }));

  return (
    <div>
      <PageHeader title="管理画面（Airisアカウント管理）" />

      {user.dummy && (
        <InfoBanner>
          ダミー表示モード: 表示されているのは架空データです。操作・CSV出力はできません。
        </InfoBanner>
      )}

      {/* TODOバナー（SPEC §4.2） */}
      <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        TODO: MFA(TOTP)・パスワード有効期限/履歴24世代は本番リリースまでに実装（SPEC §4.2）
      </div>

      {/* 統計カード */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard value={totalAll} label="アカウント総数" tone="blue" />
        <StatCard value={countOf("active")} label="登録済み（有効）" tone="green" />
        <StatCard value={countOf("suspended")} label="停止" tone="gray" />
        <StatCard value={countOf("deleted")} label="削除済" tone="red" />
      </div>

      {/* アカウント一覧 */}
      <SectionTitle
        right={
          !user.dummy ? (
            <a href="/admin/csv?type=inventory" className={btnOutline}>
              棚卸CSV出力
            </a>
          ) : undefined
        }
      >
        全Airisアカウント一覧
      </SectionTitle>
      <Card className="mb-6">
        <form method="get" action="/admin" className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-64">
            <label className={labelCls}>検索（ID・氏名・メール）</label>
            <input name="q" defaultValue={q} placeholder="キーワード" className={inputCls} />
          </div>
          <div className="w-52">
            <label className={labelCls}>ロール</label>
            <select name="role" defaultValue={roleFilter} className={inputCls}>
              <option value="">すべて</option>
              {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_NUM[r]} {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className={labelCls}>ステータス</label>
            <select name="status" defaultValue={statusFilter} className={inputCls}>
              <option value="">すべて</option>
              {Object.entries(ACCOUNT_STATUS_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button className={btnPrimary}>絞り込み</button>
          <Link href="/admin" className={btnOutline}>
            クリア
          </Link>
        </form>

        {accounts.length === 0 ? (
          <EmptyState message="条件に一致するアカウントがありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className={thCls}>ログインID</th>
                  <th className={thCls}>ロール</th>
                  <th className={thCls}>氏名・メール</th>
                  <th className={thCls}>所属代理店</th>
                  <th className={thCls}>ステータス</th>
                  <th className={thCls}>最終PW変更日</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td className={`${tdCls} font-mono text-xs`}>{a.loginId}</td>
                    <td className={tdCls}>
                      <span className="whitespace-nowrap text-xs">
                        {ROLE_NUM[a.role as Role] ?? ""} {ROLE_LABELS[a.role as Role] ?? a.role}
                      </span>
                    </td>
                    <td className={tdCls}>
                      <div className="font-medium text-slate-800">{a.name}</div>
                      {a.email && <div className="text-xs text-slate-500">{a.email}</div>}
                    </td>
                    <td className={tdCls}>
                      {a.agency ? (
                        <span className="text-xs">
                          {a.agency.name}
                          <span className="ml-1 text-slate-400">（{a.agency.code}）</span>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <StatusBadge label={ACCOUNT_STATUS_LABELS[a.status] ?? a.status} />
                    </td>
                    <td className={`${tdCls} whitespace-nowrap text-xs`}>
                      {jst(a.passwordUpdatedAt)}
                    </td>
                    <td className={tdCls}>
                      {user.dummy ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <AccountRowActions
                          id={a.id}
                          status={a.status}
                          isSelf={a.id === user.id}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ページネーション（50件/頁）+ 件数表示 */}
        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-xs text-slate-500">
            全{totalCount}件中 {from}〜{to}件を表示（{page}/{totalPages}ページ）
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Link href={pageHref(page - 1)} className={btnOutline}>
                ← 前へ
              </Link>
            )}
            {page < totalPages && (
              <Link href={pageHref(page + 1)} className={btnOutline}>
                次へ →
              </Link>
            )}
          </div>
        </div>
      </Card>

      {/* 監査ログ簡易ビューア */}
      <SectionTitle
        right={
          !user.dummy ? (
            <a href="/admin/csv?type=audit" className={btnOutline}>
              監査ログCSV出力
            </a>
          ) : undefined
        }
      >
        監査ログ（直近100件）
      </SectionTitle>
      <Card>
        {auditRows.length === 0 ? (
          <EmptyState message="監査ログはまだありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead>
                <tr>
                  <th className={thCls}>日時</th>
                  <th className={thCls}>actor</th>
                  <th className={thCls}>action</th>
                  <th className={thCls}>target</th>
                  <th className={thCls}>result</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.map((l) => (
                  <tr key={l.id}>
                    <td className={`${tdCls} whitespace-nowrap text-xs`}>{l.at}</td>
                    <td className={`${tdCls} font-mono text-xs`}>{l.actor}</td>
                    <td className={`${tdCls} text-xs`}>{l.action}</td>
                    <td className={`${tdCls} font-mono text-xs`}>{l.target || "—"}</td>
                    <td className={tdCls}>
                      <Badge tone={l.result === "success" ? "green" : "red"}>{l.result}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
