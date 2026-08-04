"use client";

// お知らせの編集UI（§5.1「変」= ①②③）。一覧の「編集」ボタンからインラインで開く。
// タイトル・本文・重要フラグを編集する（宛先・添付は対象外 → actions.ts のコメント参照）。

import { useActionState, useState } from "react";
import { updateAnnouncementAction, type AnnouncementFormState } from "./actions";
import { inputCls, labelCls, btnPrimary, btnOutline } from "@/components/ui";

const initialState: AnnouncementFormState = {};

export function AnnouncementEditForm({
  id,
  title,
  body,
  important,
}: {
  id: string;
  title: string;
  body: string;
  important: boolean;
}) {
  const [state, formAction, pending] = useActionState(updateAnnouncementAction, initialState);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className={btnOutline} onClick={() => setOpen(true)}>
        編集
      </button>
    );
  }

  return (
    <div className="w-72 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <form action={formAction}>
        <input type="hidden" name="id" value={id} />
        <div>
          <label className={labelCls}>タイトル</label>
          <input type="text" name="title" defaultValue={title} className={inputCls} required />
        </div>
        <div className="mt-2">
          <label className={labelCls}>本文</label>
          <textarea name="body" rows={5} defaultValue={body} className={inputCls} required />
        </div>
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-700">
          <input
            type="checkbox"
            name="important"
            defaultChecked={important}
            className="h-4 w-4 accent-red-600"
          />
          重要（既読管理の対象）
        </label>
        {state.error && <p className="mt-2 text-xs text-red-600">{state.error}</p>}
        {state.success && <p className="mt-2 text-xs text-emerald-700">{state.success}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button type="submit" className={btnPrimary} disabled={pending}>
            {pending ? "保存中…" : "保存"}
          </button>
          <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
            閉じる
          </button>
        </div>
      </form>
    </div>
  );
}
