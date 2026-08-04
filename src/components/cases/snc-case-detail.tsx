import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/roles";
import { audit } from "@/lib/util";
import { Badge, Card, EmptyState, PageHeader, SectionTitle, StatusBadge, btnDanger, btnOutline, inputCls } from "@/components/ui";
import { DeadlineBadge, fmtDateTime, seriesBasePath, seriesLabel } from "./badges";
import { CaseThread, parseMessageFiles } from "./thread";
import { ReplyForm } from "./reply-form";
import { changeStatusAction, urgentAlertAction } from "./actions";

// SNC側 案件詳細（スレッド + 返信（添付可） + ステータス変更 + 緊急アラート §7.8）
export async function SncCaseDetailPage({
  user,
  series,
  id,
}: {
  user: CurrentUser;
  series: "HL" | "CSC";
  id: string;
}) {
  const base = seriesBasePath(series);

  const c = await prisma.case.findUnique({
    where: { id },
    include: {
      primaryAgency: true,
      secondaryAgency: true,
      messages: { orderBy: { createdAt: "asc" } },
      statusHistory: { orderBy: { changedAt: "desc" } },
      reads: true,
    },
  });
  if (!c || c.series !== series) notFound();

  // 代理店スコープ検証（SNC系はnull=全代理店 §3.1）
  const scope = await agencyScope(user);
  if (scope && !scope.includes(c.primaryAgencyId)) redirect(base);

  // 窓口案件詳細の参照は監査ログ記録対象（§3.3）
  await audit(user.loginId, "case_view", c.caseNo);

  const read = c.reads.find((r) => r.agencyId === c.primaryAgencyId);
  const agencyRead = !!read && read.readAt >= c.updatedAt;

  return (
    <div>
      <PageHeader
        title={c.title}
        action={
          <Link href={base} className={btnOutline}>
            ← 一覧へ戻る
          </Link>
        }
      />

      <Card className="mb-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatusBadge label={c.status} />
          <DeadlineBadge deadline={c.deadline} />
          <Badge tone={agencyRead ? "green" : "yellow"}>{agencyRead ? "代理店既読" : "代理店未読"}</Badge>
          {!user.isDummy && (
            <div className="ml-auto flex items-center gap-2">
              <form action={changeStatusAction.bind(null, c.id)} className="flex items-center gap-2">
                <select name="status" defaultValue={c.status} className={`${inputCls} w-36`}>
                  {CASE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button className={btnOutline}>ステータス変更</button>
              </form>
              <form action={urgentAlertAction.bind(null, c.id)}>
                <button className={btnDanger}>緊急アラート</button>
              </form>
            </div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-xs font-semibold text-slate-500">案件ID</div>
            <div className="text-slate-800">{c.caseNo}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">窓口</div>
            <div className="text-slate-800">{seriesLabel(c.series)}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">依頼種別</div>
            <div className="text-slate-800">{c.templateKind}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">一次代理店</div>
            <div className="text-slate-800">
              {c.primaryAgency.name}（{c.primaryAgency.code}）
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">二次代理店</div>
            <div className="text-slate-800">
              {c.secondaryAgency ? `${c.secondaryAgency.name}（${c.secondaryAgency.code}）` : "-"}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">ISP受付番号</div>
            <div className="text-slate-800">{c.ispNumber ?? "-"}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">対応期限</div>
            <div className="text-slate-800">{c.deadline ?? "-"}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">起票者</div>
            <div className="text-slate-800">{c.createdBy ?? "-"}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-slate-500">起票日時</div>
            <div className="text-slate-800">{fmtDateTime(c.createdAt)}</div>
          </div>
        </div>
      </Card>

      <Card className="mb-5">
        <SectionTitle>やりとり（スレッド）</SectionTitle>
        <CaseThread
          messages={c.messages.map((m) => ({
            id: m.id,
            senderSide: m.senderSide,
            senderName: m.senderName,
            body: m.body,
            createdAt: m.createdAt,
            files: parseMessageFiles(m.fileIds),
          }))}
        />
        {!user.isDummy && <ReplyForm caseId={c.id} allowFiles />}
      </Card>

      <Card>
        <SectionTitle>ステータス変更履歴</SectionTitle>
        {c.statusHistory.length === 0 ? (
          <EmptyState message="ステータス変更履歴はありません。" />
        ) : (
          <ul className="space-y-2">
            {c.statusHistory.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{fmtDateTime(h.changedAt)}</span>
                <StatusBadge label={h.fromStatus} />
                <span>→</span>
                <StatusBadge label={h.toStatus} />
                <span>（{h.changedBy}）</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
