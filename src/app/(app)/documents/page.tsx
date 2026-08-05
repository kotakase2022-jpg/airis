import Link from "next/link";
import { Paperclip } from "lucide-react";
import { requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { type Role } from "@/lib/roles";
import { can } from "@/lib/permissions";
import { canManageDocuments } from "@/lib/util";
import {
  Card,
  Badge,
  PageHeader,
  InfoBanner,
  EmptyState,
  SectionTitle,
  StatCard,
  btnDanger,
  btnOutline,
  inputCls,
  thCls,
  tdCls,
} from "@/components/ui";
import { DocumentUploadForm } from "./upload-form";
import { deleteDocumentAction } from "./actions";

const PAGE_SIZE = 50;

const VISIBILITY_LABELS: Record<string, string> = {
  all: "全体",
  primary: "1次店まで",
  snc: "SNC内",
};

const VISIBILITY_TONES: Record<string, string> = {
  all: "blue",
  primary: "yellow",
  snc: "gray",
};

// 公開範囲による絞り込み（§7.12「表示内容は権限に応じて出し分ける」/ §5.2）
// SNC系(①②③)=全部 / ⑤⑥=all+snc / ⑦=all+primary / ⑧⑨=allのみ / ④ダミー=all相当（読み取り専用）
//
// ロール配列をハードコードせず §5.1 の宣言的マップ（permissions.ts）から導出する（§3.2）:
//  - 全公開範囲   : ドキュメントの登録主体＝①②③（§7.12。canManageDocuments）
//  - "primary"    : §5.1「お知らせ（1次店向け）」の閲（①②③⑦）と同じ「1次店まで」の範囲
//  - "snc"        : SNC側ロール。§5.1 で窓口案件の「作」を持つのは①②③⑤⑥＝SNC側のみ
//  - "all"        : §5.2 でドキュメントページにアクセスできる全ロール
// 戻り値 null = 絞り込み無し（全件）
function visibilityScope(role: Role, dummy: boolean): string[] | null {
  if (dummy) return ["all"]; // ④は実データに触れさせない（§3.5。isDummy=true 側で更に分離）
  if (canManageDocuments(role)) return null;
  const scope = ["all"];
  if (can(role, "announcement-primary", "view")) scope.push("primary");
  if (can(role, "hotline", "create") || can(role, "consumer-center", "create")) scope.push("snc");
  return scope;
}

function fmtJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export default async function DocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; category?: string }>;
}) {
  const user = await requirePage("documents");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = (sp.q ?? "").trim();
  const category = (sp.category ?? "").trim();

  // 登録・削除の操作権限（§7.12）。UI層でも同じ判定を使う（§3.2）
  const isSnc = !user.dummy && canManageDocuments(user.role);
  const scope = visibilityScope(user.role, user.dummy);

  // ④ダミー表示はシードの架空データ（isDummy=true）のみ・実データは一切見せない（§3.5）。
  // 非ダミーユーザーには実データ（isDummy=false）のみ表示する。
  const scopeWhere = {
    isDummy: user.dummy,
    ...(scope ? { visibility: { in: scope } } : {}),
  };
  const where = {
    ...scopeWhere,
    ...(category ? { category } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" as const } },
            { fileName: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, totalAll, documents, categoryRows] = await Promise.all([
    prisma.document.count({ where }),
    prisma.document.count({ where: scopeWhere }),
    prisma.document.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.document.findMany({
      where: scopeWhere,
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
    }),
  ]);
  const categories = categoryRows.map((c) => c.category).filter((c): c is string => !!c);

  const qs = (p: number) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (category) params.set("category", category);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return `/documents${s ? `?${s}` : ""}`;
  };
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader title="ドキュメント" />
      <InfoBanner>
        販売マニュアル・通知書類等の文書置き場です。表示内容は権限に応じた公開範囲で絞り込まれます。
        {user.dummy && " SNC閲覧アカウントのため読み取り専用です。"}
      </InfoBanner>

      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatCard value={totalAll} label="閲覧可能なドキュメント" tone="blue" />
        <StatCard value={categories.length} label="カテゴリ数" tone="purple" />
        <StatCard value={total} label="絞り込み結果" tone="green" />
      </div>

      {isSnc && (
        <Card className="mb-5">
          <SectionTitle>ドキュメントアップロード（SNCのみ）</SectionTitle>
          <DocumentUploadForm />
        </Card>
      )}

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-500">
              全{total}件中 {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}〜
              {Math.min(page * PAGE_SIZE, total)}件を表示
            </span>
          }
        >
          ドキュメント一覧
        </SectionTitle>

        <form method="get" action="/documents" className="mb-4 flex flex-wrap items-end gap-3">
          <div className="w-64">
            <label className="mb-1 block text-xs font-semibold text-slate-600">検索</label>
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="タイトル・ファイル名で検索"
              className={inputCls}
            />
          </div>
          <div className="w-52">
            <label className="mb-1 block text-xs font-semibold text-slate-600">カテゴリ</label>
            <select name="category" defaultValue={category} className={inputCls}>
              <option value="">すべてのカテゴリ</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={btnOutline}>
            絞り込み
          </button>
          {(q || category) && (
            <Link href="/documents" className="text-sm text-blue-600 hover:underline">
              クリア
            </Link>
          )}
        </form>

        {documents.length === 0 ? (
          <EmptyState message="該当するドキュメントはありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={thCls}>タイトル</th>
                  <th className={thCls}>カテゴリ</th>
                  <th className={thCls}>公開範囲</th>
                  <th className={thCls}>ファイル名</th>
                  <th className={thCls}>登録日</th>
                  {isSnc && <th className={thCls}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {documents.map((d) => (
                  <tr key={d.id}>
                    <td className={`${tdCls} font-medium text-slate-800`}>{d.title}</td>
                    <td className={tdCls}>
                      {d.category ? (
                        <Badge tone="blue">{d.category}</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">-</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      <Badge tone={VISIBILITY_TONES[d.visibility] ?? "gray"}>
                        {VISIBILITY_LABELS[d.visibility] ?? d.visibility}
                      </Badge>
                    </td>
                    <td className={tdCls}>
                      {/* TODO: ダウンロードの監査ログ記録は /files/[id] ルート側で対応（§7.12） */}
                      <a href={`/files/${d.fileId}`} className="text-blue-600 hover:underline">
                        <Paperclip className="mr-1 inline h-3 w-3" />
                        {d.fileName}
                      </a>
                    </td>
                    <td className={`${tdCls} whitespace-nowrap`}>{fmtJst(d.createdAt)}</td>
                    {isSnc && (
                      <td className={tdCls}>
                        <form action={deleteDocumentAction}>
                          <input type="hidden" name="id" value={d.id} />
                          <button type="submit" className={btnDanger}>
                            削除
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {lastPage > 1 && (
          <div className="mt-4 flex items-center justify-center gap-4 text-sm">
            {page > 1 ? (
              <Link href={qs(page - 1)} className="text-blue-600 hover:underline">
                ← 前の50件
              </Link>
            ) : (
              <span className="text-slate-300">← 前の50件</span>
            )}
            <span className="text-slate-500">
              {page} / {lastPage} ページ
            </span>
            {page < lastPage ? (
              <Link href={qs(page + 1)} className="text-blue-600 hover:underline">
                次の50件 →
              </Link>
            ) : (
              <span className="text-slate-300">次の50件 →</span>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
