"use client";

import { useActionState } from "react";
import { createAnnouncementAction, type AnnouncementFormState } from "./actions";
import { inputCls, labelCls, btnPrimary, btnOutline } from "@/components/ui";

const initialState: AnnouncementFormState = {};

export function AnnouncementForm() {
  const [state, formAction, pending] = useActionState(createAnnouncementAction, initialState);

  return (
    <form action={formAction}>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>宛先</label>
          <select name="audience" className={inputCls} defaultValue="all" required>
            <option value="all">全体向け（①②③⑦⑧⑨に周知）</option>
            <option value="primary">1次店向け（①②③⑦に周知）</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>重要フラグ</label>
          <label className="flex h-[38px] cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-700">
            <input type="checkbox" name="important" className="h-4 w-4 accent-red-600" />
            重要（既読管理の対象）
          </label>
        </div>
        <div>
          <label className={labelCls}>添付ファイル（複数可）</label>
          <input type="file" name="files" multiple className={inputCls} />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>タイトル</label>
          <input
            type="text"
            name="title"
            className={inputCls}
            placeholder="お知らせのタイトル"
            required
          />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>本文（自由記述）</label>
          <textarea
            name="body"
            rows={6}
            className={inputCls}
            placeholder="周知内容を入力してください"
            required
          />
        </div>
      </div>
      {state.error && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{state.error}</p>
      )}
      {state.success && (
        <p className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.success}
        </p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <button type="submit" name="intent" value="send" className={btnPrimary} disabled={pending}>
          {pending ? "送信中…" : "作成して送信"}
        </button>
        {/* 下書き保存: status=draft・sentAt=null・通知なし（§7.7） */}
        <button type="submit" name="intent" value="draft" className={btnOutline} disabled={pending}>
          下書き保存
        </button>
      </div>
    </form>
  );
}
