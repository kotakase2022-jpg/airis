import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope } from "@/lib/auth";
import { CASE_STATUSES } from "@/lib/roles";
import { can, caseFeature } from "@/lib/permissions";
import { audit } from "@/lib/util";
import { Badge, Card, EmptyState, InfoBanner, PageHeader, SectionTitle, StatusBadge, btnDanger, btnOutline, btnPrimary, inputCls, labelCls } from "@/components/ui";
import { DeadlineBadge, fmtDateTime, seriesBasePath, seriesLabel } from "./badges";
import { CaseThread, parseMessageFiles } from "./thread";
import { ReplyForm } from "./reply-form";
import {
  changeStatusAction,
  deleteCaseAction,
  restoreCaseAction,
  suspendCaseAction,
  updateCaseAction,
  urgentAlertAction,
} from "./actions";

// 停止・削除の状態値（actions.ts と同じ値を保持する。"use server" ファイルからは
// async 関数以外を export できないため定義を共有できない）
const CASE_SUSPENDED = "停止";
const CASE_DELETED = "削除済";

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

  // 変更（§5.1「変」）: ①②③ + 担当窓口（HL=⑤ / 消セン=⑥）。server action 側でも再検証する。
  const isSuspended = c.status === CASE_SUSPENDED;
  const isDeleted = c.status === CASE_DELETED;
  const isInactive = isSuspended || isDeleted;
  const canUpdate = !user.isDummy && can(user.role, caseFeature(series), "update") && !isInactive;
  // 停止（§5.1「停」）/ 削除（§5.1「削」）: ①②③ + 担当窓口。判定は permissions.can（§3.2）
  const canSuspend = !user.isDummy && can(user.role, caseFeature(series), "suspend");
  const canDelete = !user.isDummy && can(user.role, caseFeature(series), "delete");
  const canRestore = isDeleted ? canDelete : isSuspended && canSuspend;

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

      {isInactive && (
        <InfoBanner>
          この案件は「{c.status}」です。代理店側（窓口案件ビュー）からは参照・返信できません。
          {canRestore && "復旧すると停止・削除前のステータスに戻ります。"}
        </InfoBanner>
      )}

      <Card className="mb-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatusBadge label={c.status} />
          <DeadlineBadge deadline={c.deadline} />
          <Badge tone={agencyRead ? "green" : "yellow"}>{agencyRead ? "代理店既読" : "代理店未読"}</Badge>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {canUpdate && (
              <>
                <form action={changeStatusAction.bind(null, c.id)} className="flex items-center gap-2">
                  <select name="status" defaultValue={c.status} className={`${inputCls} w-32`}>
                    {CASE_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <button className={btnOutline + " whitespace-nowrap"}>ステータス変更</button>
                </form>
                <form action={urgentAlertAction.bind(null, c.id)}>
                  <button className={btnDanger + " whitespace-nowrap"}>緊急アラート</button>
                </form>
              </>
            )}
            {/* 停止（§5.1「停」）: 代理店側の一覧・詳細から除外される */}
            {canSuspend && !isInactive && (
              <form action={suspendCaseAction.bind(null, c.id)}>
                <button className={btnOutline + " whitespace-nowrap !text-amber-700"}>
                  案件を停止
                </button>
              </form>
            )}
            {/* 削除（§5.1「削」）: 論理削除（§3.4） */}
            {canDelete && !isDeleted && (
              <form action={deleteCaseAction.bind(null, c.id)}>
                <button className={btnOutline + " whitespace-nowrap !text-red-600"}>案件を削除</button>
              </form>
            )}
            {canRestore && (
              <form action={restoreCaseAction.bind(null, c.id)}>
                <button className={btnPrimary + " whitespace-nowrap"}>復旧</button>
              </form>
            )}
          </div>
        </div>

        {/* 案件の編集（§5.1「変」）: 件名・対応期限。変更前後の値は監査ログに記録される（§3.3） */}
        {canUpdate && (
          <details className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <summary className="cursor-pointer text-sm font-bold text-blue-700">
              案件を編集（件名・対応期限）
            </summary>
            <form
              action={updateCaseAction.bind(null, c.id)}
              className="mt-3 grid grid-cols-3 items-end gap-3"
            >
              <div className="col-span-2">
                <label className={labelCls}>件名 *</label>
                <input name="title" defaultValue={c.title} required className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>対応期限（空欄可）</label>
                <input
                  type="date"
                  name="deadline"
                  defaultValue={c.deadline ?? ""}
                  className={inputCls}
                />
              </div>
              <div className="col-span-3">
                <button className={btnPrimary}>保存</button>
              </div>
            </form>
          </details>
        )}

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
        {/* 停止・削除済の案件は返信不可（server action 側でも拒否する） */}
        {!user.isDummy && !isInactive && <ReplyForm caseId={c.id} allowFiles />}
        {isInactive && (
          <p className="mt-3 text-sm text-slate-400">
            「{c.status}」の案件のため返信できません。
          </p>
        )}
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
