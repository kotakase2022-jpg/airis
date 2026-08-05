import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/util";
import {
  Card,
  EmptyState,
  PageHeader,
  SectionTitle,
  StatusBadge,
  btnOutline,
} from "@/components/ui";
import { DeadlineBadge, SeriesBadge, fmtDateTime, seriesLabel } from "@/components/cases/badges";
import { CaseThread, parseMessageFiles } from "@/components/cases/thread";
import { ReplyForm } from "@/components/cases/reply-form";

// 窓口案件 詳細（§7.10: スレッド閲覧+返信のみ。起票UI無し・ファイル添付不可・ステータス変更不可）
export default async function AgencyCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePage("agency-cases");
  const { id } = await params;

  const c = await prisma.case.findUnique({
    where: { id },
    include: {
      primaryAgency: true,
      secondaryAgency: true,
      messages: { orderBy: { createdAt: "asc" } },
      statusHistory: { orderBy: { changedAt: "desc" } },
    },
  });
  if (!c) notFound();

  // 自店案件のみ閲覧可（IDOR防止 §3.1）
  const scope = await agencyScope(user);
  if (!scope || !scope.includes(c.primaryAgencyId)) redirect("/agency-cases");

  // 閲覧で既読を記録（代理店単位 §7.8 既読管理）
  if (user.agencyId) {
    await prisma.caseRead.upsert({
      where: { caseId_agencyId: { caseId: c.id, agencyId: user.agencyId } },
      update: { readAt: new Date() },
      create: { caseId: c.id, agencyId: user.agencyId },
    });
  }

  // 窓口案件詳細の参照は監査ログ記録対象（§3.3）
  await audit(user.loginId, "case_view", c.caseNo);

  return (
    <div>
      <PageHeader
        title={c.title}
        action={
          <Link href="/agency-cases" className={btnOutline}>
            ← 一覧へ戻る
          </Link>
        }
      />

      <Card className="mb-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <SeriesBadge series={c.series} />
          <StatusBadge label={c.status} />
          <DeadlineBadge deadline={c.deadline} />
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
        {/* 代理店側は返信のみ可・ファイル添付不可（§14-3） */}
        <ReplyForm caseId={c.id} allowFiles={false} />
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
