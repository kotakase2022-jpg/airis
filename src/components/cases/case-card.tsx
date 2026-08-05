import Link from "next/link";
import { Badge, EmptyState, StatusBadge, btnOutline } from "@/components/ui";
import { DeadlineBadge, SeriesBadge, fmtDateTime } from "./badges";

export type CaseCardData = {
  id: string;
  caseNo: string;
  series: string;
  templateKind: string;
  title: string;
  status: string;
  deadline: string | null;
  updatedAt: Date;
  primaryAgencyName: string;
  secondaryAgencyName?: string | null;
  // SNC一覧用: 代理店の既読/未読（null=非表示）
  readBadge?: "代理店既読" | "代理店未読" | null;
};

// 案件カード（§11.3: 件名 + メタ2行 + 右上にステータスバッジ・期限バッジ）
export function CaseCard({
  data,
  href,
  showSeries = false,
}: {
  data: CaseCardData;
  href: string;
  showSeries?: boolean;
}) {
  return (
    <Link
      href={href}
      className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-300"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {showSeries && <SeriesBadge series={data.series} />}
            <span className="truncate text-sm font-bold text-slate-800">{data.title}</span>
          </div>
          <div className="mt-1 truncate text-xs text-slate-500">
            {data.caseNo} / {data.templateKind} / 一次: {data.primaryAgencyName}
            {data.secondaryAgencyName ? `（二次: ${data.secondaryAgencyName}）` : ""}
          </div>
          <div className="mt-0.5 text-xs text-slate-400">
            期限: {data.deadline ?? "-"} / 更新: {fmtDateTime(data.updatedAt)}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex items-center gap-1.5">
            <StatusBadge label={data.status} />
            <DeadlineBadge deadline={data.deadline} />
          </div>
          {data.readBadge && (
            <Badge tone={data.readBadge === "代理店既読" ? "green" : "yellow"}>
              {data.readBadge}
            </Badge>
          )}
        </div>
      </div>
    </Link>
  );
}

export function CaseCardList({
  cases,
  hrefBase,
  showSeries = false,
  emptyMessage = "該当する案件はありません。",
}: {
  cases: CaseCardData[];
  hrefBase: string;
  showSeries?: boolean;
  emptyMessage?: string;
}) {
  if (cases.length === 0) return <EmptyState message={emptyMessage} />;
  return (
    <div className="space-y-3">
      {cases.map((c) => (
        <CaseCard key={c.id} data={c} href={`${hrefBase}/${c.id}`} showSeries={showSeries} />
      ))}
    </div>
  );
}

// ページネーション（50件/頁 + 件数表示 §11.3）
export function Pagination({
  page,
  total,
  perPage,
  baseHref,
}: {
  page: number;
  total: number;
  perPage: number;
  baseHref: string; // page以外のクエリを含んだURL
}) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const sep = baseHref.includes("?") ? "&" : "?";
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-slate-500">
      <span>
        全{total}件中 {from}〜{to}件を表示
      </span>
      <div className="flex items-center gap-2">
        {page > 1 && (
          <Link href={`${baseHref}${sep}page=${page - 1}`} className={btnOutline}>
            前へ
          </Link>
        )}
        <span>
          {page} / {totalPages} ページ
        </span>
        {page < totalPages && (
          <Link href={`${baseHref}${sep}page=${page + 1}`} className={btnOutline}>
            次へ
          </Link>
        )}
      </div>
    </div>
  );
}
