import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES, ROLE_LABELS, type Role } from "@/lib/roles";
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
  btnPrimary,
  thCls,
  tdCls,
} from "@/components/ui";
import { AnnouncementForm } from "./new-form";
import { AnnouncementEditForm } from "./edit-form";
import {
  stopAnnouncementAction,
  deleteAnnouncementAction,
  sendAnnouncementAction,
} from "./actions";

const PAGE_SIZE = 50;

const AUDIENCE_LABELS: Record<string, string> = {
  all: "全体向け",
  primary: "1次店向け",
};

const ANN_STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  sent: "送信済み",
  stopped: "停止",
  deleted: "削除済",
};

const ANN_STATUS_TONES: Record<string, string> = {
  draft: "gray",
  sent: "green",
  stopped: "gray",
  deleted: "red",
};

function fmtJst(d: Date | null): string {
  if (!d) return "-";
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function audienceTargetRoles(audience: string): Role[] {
  return audience === "all" ? ["R7", "R8", "R9"] : ["R7"];
}

export default async function AnnouncementsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requirePage("announcements");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const isAdmin = !user.dummy && SNC_ADMIN_ROLES.includes(user.role);

  if (isAdmin) {
    return <AdminView page={page} />;
  }
  return <ViewerView page={page} userId={user.id} role={user.role} dummy={user.dummy} />;
}

// ─────────────────────────────────────────────
// SNC管理側（①②③）: 作成・送信・停止・削除・既読率
// ─────────────────────────────────────────────
async function AdminView({ page }: { page: number }) {
  // 実データのみ（④ダミー表示用データは isDummy=true で分離 §3.5）
  const where = { status: { not: "deleted" }, isDummy: false };
  const [total, importantCount, stoppedCount, announcements] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.count({ where: { ...where, important: true } }),
    prisma.announcement.count({ where: { status: "stopped", isDummy: false } }),
    prisma.announcement.findMany({
      where,
      orderBy: [{ important: "desc" }, { sentAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // 重要お知らせの既読率（対象=有効な⑦⑧⑨アカウント。ダミー代理店所属は除外）
  // TODO: 稼働終了代理店（実効⑩）の⑦⑧を母数から除くかは運用確認待ち（現状は含む）
  const importantIds = announcements.filter((a) => a.important).map((a) => a.id);
  const [targets, reads] = await Promise.all([
    prisma.account.findMany({
      where: {
        role: { in: ["R7", "R8", "R9"] },
        status: "active",
        OR: [{ agencyId: null }, { agency: { isDummy: false } }],
      },
      select: { id: true, loginId: true, name: true, role: true },
      orderBy: { loginId: "asc" },
    }),
    importantIds.length
      ? prisma.announcementRead.findMany({
          where: { announcementId: { in: importantIds } },
          select: { announcementId: true, accountId: true },
        })
      : Promise.resolve([] as { announcementId: string; accountId: string }[]),
  ]);
  const readMap = new Map<string, Set<string>>();
  for (const r of reads) {
    if (!readMap.has(r.announcementId)) readMap.set(r.announcementId, new Set());
    readMap.get(r.announcementId)!.add(r.accountId);
  }

  return (
    <div>
      <PageHeader title="お知らせ・情報周知" />
      <InfoBanner>
        全体向け（①②③⑦⑧⑨に周知）と1次店向け（①②③⑦に周知）の2チャネルで配信します。作成すると即時送信され、対象アカウントへアプリ内通知が届きます。重要フラグ付きのお知らせは既読状況を管理できます。
      </InfoBanner>

      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatCard value={total} label="お知らせ件数（削除済を除く）" tone="blue" />
        <StatCard value={importantCount} label="重要お知らせ" tone="red" />
        <StatCard value={stoppedCount} label="停止中" tone="gray" />
      </div>

      <Card className="mb-5">
        <SectionTitle>お知らせ作成・送信</SectionTitle>
        <AnnouncementForm />
      </Card>

      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-500">
              全{total}件中 {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}〜
              {Math.min(page * PAGE_SIZE, total)}件を表示
            </span>
          }
        >
          配信一覧
        </SectionTitle>
        {announcements.length === 0 ? (
          <EmptyState message="お知らせはまだありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={thCls}>宛先</th>
                  <th className={thCls}>タイトル</th>
                  <th className={thCls}>送信日時</th>
                  <th className={thCls}>状態</th>
                  <th className={thCls}>既読率（重要のみ）</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {announcements.map((a) => {
                  const targetList = a.important
                    ? targets.filter((t) => audienceTargetRoles(a.audience).includes(t.role as Role))
                    : [];
                  const readSet = readMap.get(a.id) ?? new Set<string>();
                  const readCount = targetList.filter((t) => readSet.has(t.id)).length;
                  const unreadList = targetList.filter((t) => !readSet.has(t.id));
                  return (
                    <tr key={a.id}>
                      <td className={tdCls}>
                        <Badge tone={a.audience === "primary" ? "yellow" : "blue"}>
                          {AUDIENCE_LABELS[a.audience] ?? a.audience}
                        </Badge>
                      </td>
                      <td className={tdCls}>
                        <div className="flex items-center gap-2">
                          {a.important && <Badge tone="red">重要</Badge>}
                          <Link
                            href={`/announcements/${a.id}`}
                            className="font-medium text-blue-700 hover:underline"
                          >
                            {a.title}
                          </Link>
                        </div>
                      </td>
                      <td className={`${tdCls} whitespace-nowrap`}>{fmtJst(a.sentAt)}</td>
                      <td className={tdCls}>
                        <Badge tone={ANN_STATUS_TONES[a.status] ?? "gray"}>
                          {ANN_STATUS_LABELS[a.status] ?? a.status}
                        </Badge>
                      </td>
                      <td className={tdCls}>
                        {a.important ? (
                          <div>
                            <span className="text-sm font-semibold text-slate-800">
                              {readCount} / {targetList.length}
                            </span>
                            <span className="ml-1 text-xs text-slate-500">
                              （{targetList.length === 0 ? 0 : Math.round((readCount / targetList.length) * 100)}%）
                            </span>
                            {unreadList.length > 0 && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-xs text-blue-600 hover:underline">
                                  未読者一覧（{unreadList.length}名）
                                </summary>
                                <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg bg-slate-50 p-2">
                                  {unreadList.map((t) => (
                                    <li key={t.id} className="text-xs text-slate-600">
                                      {t.name}（{t.loginId} / {ROLE_LABELS[t.role as Role]}）
                                    </li>
                                  ))}
                                </ul>
                              </details>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </td>
                      <td className={tdCls}>
                        <div className="flex flex-wrap items-start gap-2">
                          {(a.status === "sent" || a.status === "draft") && (
                            <AnnouncementEditForm
                              id={a.id}
                              title={a.title}
                              body={a.body}
                              important={a.important}
                            />
                          )}
                          {a.status === "draft" && (
                            <form action={sendAnnouncementAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button type="submit" className={btnPrimary}>
                                送信
                              </button>
                            </form>
                          )}
                          {a.status === "sent" && (
                            <form action={stopAnnouncementAction}>
                              <input type="hidden" name="id" value={a.id} />
                              <button type="submit" className={btnOutline}>
                                停止
                              </button>
                            </form>
                          )}
                          <form action={deleteAnnouncementAction}>
                            <input type="hidden" name="id" value={a.id} />
                            <button type="submit" className={btnDanger}>
                              削除
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={total} />
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────
// 閲覧側（⑦⑧⑨、④ダミー）
// ─────────────────────────────────────────────
async function ViewerView({
  page,
  userId,
  role,
  dummy,
}: {
  page: number;
  userId: string;
  role: Role;
  dummy: boolean;
}) {
  // ⑦は全体向け+1次店向け、⑧⑨は全体向けのみ。④ダミーは両方（読み取り専用）
  const audiences = role === "R7" || dummy ? ["all", "primary"] : ["all"];
  // ④ダミー表示はシードの架空データ（isDummy=true）のみ・実データは一切見せない（§3.5）。
  // 非ダミーユーザーには実データ（isDummy=false）のみ表示する。
  const where = { status: "sent", audience: { in: audiences }, isDummy: dummy };
  const [total, announcements] = await Promise.all([
    prisma.announcement.count({ where }),
    prisma.announcement.findMany({
      where,
      orderBy: [{ important: "desc" }, { sentAt: "desc" }, { createdAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  const reads = await prisma.announcementRead.findMany({
    where: { accountId: userId, announcementId: { in: announcements.map((a) => a.id) } },
    select: { announcementId: true },
  });
  const readSet = new Set(reads.map((r) => r.announcementId));
  const unreadCount = announcements.filter((a) => !readSet.has(a.id)).length;

  return (
    <div>
      <PageHeader title="お知らせ" />
      {dummy && (
        <InfoBanner>
          SNC閲覧アカウントのため読み取り専用です。既読は記録されません。
        </InfoBanner>
      )}
      <div className="mb-5 grid grid-cols-3 gap-4">
        <StatCard value={total} label="お知らせ件数" tone="blue" />
        <StatCard value={unreadCount} label="未読（このページ内）" tone="orange" />
        <StatCard
          value={announcements.filter((a) => a.important).length}
          label="重要お知らせ（このページ内）"
          tone="red"
        />
      </div>
      <Card>
        <SectionTitle
          right={
            <span className="text-xs text-slate-500">
              全{total}件中 {total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}〜
              {Math.min(page * PAGE_SIZE, total)}件を表示
            </span>
          }
        >
          お知らせ一覧
        </SectionTitle>
        {announcements.length === 0 ? (
          <EmptyState message="お知らせはありません。" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {announcements.map((a) => {
              const attachments = Array.isArray(a.fileIds) ? (a.fileIds as unknown[]) : [];
              return (
                <li key={a.id} className="py-3">
                  <div className="flex items-center gap-2">
                    {!readSet.has(a.id) && !dummy && (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" title="未読" />
                    )}
                    {a.important && <Badge tone="red">重要</Badge>}
                    {role === "R7" || dummy ? (
                      <Badge tone={a.audience === "primary" ? "yellow" : "blue"}>
                        {AUDIENCE_LABELS[a.audience] ?? a.audience}
                      </Badge>
                    ) : null}
                    <Link
                      href={`/announcements/${a.id}`}
                      className="text-sm font-medium text-slate-800 hover:text-blue-700 hover:underline"
                    >
                      {a.title}
                    </Link>
                    {attachments.length > 0 && (
                      <span className="text-xs text-slate-400">📎{attachments.length}</span>
                    )}
                    <span className="ml-auto whitespace-nowrap text-xs text-slate-400">
                      {fmtJst(a.sentAt)}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <Pager page={page} total={total} />
      </Card>
    </div>
  );
}

function Pager({ page, total }: { page: number; total: number }) {
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (lastPage <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-center gap-4 text-sm">
      {page > 1 ? (
        <Link href={`/announcements?page=${page - 1}`} className="text-blue-600 hover:underline">
          ← 前の50件
        </Link>
      ) : (
        <span className="text-slate-300">← 前の50件</span>
      )}
      <span className="text-slate-500">
        {page} / {lastPage} ページ
      </span>
      {page < lastPage ? (
        <Link href={`/announcements?page=${page + 1}`} className="text-blue-600 hover:underline">
          次の50件 →
        </Link>
      ) : (
        <span className="text-slate-300">次の50件 →</span>
      )}
    </div>
  );
}
