"use client";

import { useActionState, useState } from "react";
import { firstApproveAction, finalApproveAction, rejectAction } from "./actions";
import { btnSuccess, btnOutline, btnDanger, inputCls } from "@/components/ui";

export function RowActions({
  id,
  canFirstApprove,
  canFinalApprove,
  canReject,
}: {
  id: string;
  canFirstApprove: boolean;
  canFinalApprove: boolean;
  canReject: boolean;
}) {
  const [firstState, firstFormAction, firstPending] = useActionState(firstApproveAction, undefined);
  const [finalState, finalFormAction, finalPending] = useActionState(finalApproveAction, undefined);
  const [rejectState, rejectFormAction, rejectPending] = useActionState(rejectAction, undefined);
  const [showReject, setShowReject] = useState(false);

  // 最終承認成功時: 一時パスワードを一度だけインライン表示（URL・DBには載せない）
  if (finalState?.ok && finalState.tempPassword) {
    return (
      <div className="min-w-56 rounded-lg border border-emerald-200 bg-emerald-50 p-2.5 text-xs text-slate-700">
        <div className="mb-1 font-bold text-emerald-700">最終承認しました</div>
        <div>
          発行ID: <span className="font-mono font-semibold">{finalState.issuedLoginId}</span>
        </div>
        <div>
          一時パスワード:{" "}
          <span className="select-all break-all font-mono font-semibold">{finalState.tempPassword}</span>
        </div>
        <div className="mt-1 text-[10px] leading-relaxed text-emerald-600">
          この一時パスワードは今回のみ表示されます。安全な方法で利用者本人へ伝達してください。
        </div>
      </div>
    );
  }

  const error = firstState?.error || finalState?.error || rejectState?.error;
  const message = firstState?.message || rejectState?.message;

  if (!canFirstApprove && !canFinalApprove && !canReject) {
    return <span className="text-xs text-slate-400">—</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {canFirstApprove && (
          <form action={firstFormAction}>
            <input type="hidden" name="id" value={id} />
            <button className={btnSuccess} disabled={firstPending}>
              {firstPending ? "処理中..." : "1次承認"}
            </button>
          </form>
        )}
        {canFinalApprove && (
          <form action={finalFormAction}>
            <input type="hidden" name="id" value={id} />
            <button className={btnSuccess} disabled={finalPending}>
              {finalPending ? "処理中..." : "最終承認"}
            </button>
          </form>
        )}
        {canReject && (
          <button type="button" className={btnOutline} onClick={() => setShowReject((v) => !v)}>
            却下
          </button>
        )}
      </div>
      {showReject && (
        <form action={rejectFormAction} className="flex items-center gap-1.5">
          <input type="hidden" name="id" value={id} />
          <input
            name="reason"
            required
            placeholder="却下理由（必須）"
            className={`${inputCls} !w-44 !py-1.5`}
          />
          <button className={btnDanger} disabled={rejectPending}>
            {rejectPending ? "処理中..." : "確定"}
          </button>
        </form>
      )}
      {error && <p className="max-w-56 text-[11px] leading-snug text-red-600">{error}</p>}
      {message && <p className="text-[11px] text-emerald-600">{message}</p>}
    </div>
  );
}
