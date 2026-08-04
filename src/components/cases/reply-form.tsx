"use client";

import { useActionState } from "react";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";
import { replyCaseAction, ReplyState } from "./actions";

// 返信フォーム（SNC側: 添付可 / 代理店側: 本文のみ）
export function ReplyForm({ caseId, allowFiles }: { caseId: string; allowFiles: boolean }) {
  const [state, formAction, pending] = useActionState(
    (prev: ReplyState, fd: FormData) => replyCaseAction(caseId, prev, fd),
    undefined
  );

  return (
    <form action={formAction} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
      <div>
        <label className={labelCls}>返信</label>
        <textarea name="body" rows={4} className={inputCls} placeholder="返信内容を入力してください" required />
      </div>
      {allowFiles && (
        <div>
          <label className={labelCls}>添付ファイル（複数可・1ファイル4MBまで）</label>
          <input type="file" name="files" multiple className="text-sm text-slate-600" />
        </div>
      )}
      {state?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
      )}
      {state?.ok && !pending && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">返信を送信しました。</p>
      )}
      <button className={btnPrimary} disabled={pending}>
        {pending ? "送信中..." : "返信を送信"}
      </button>
    </form>
  );
}
