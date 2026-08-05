"use client";

import { useActionState } from "react";
import { uploadDocumentAction, type DocumentFormState } from "./actions";
import { inputCls, labelCls, btnPrimary } from "@/components/ui";

const initialState: DocumentFormState = {};

export function DocumentUploadForm() {
  const [state, formAction, pending] = useActionState(uploadDocumentAction, initialState);

  return (
    <form action={formAction}>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>タイトル</label>
          <input
            type="text"
            name="title"
            className={inputCls}
            placeholder="例: 販売マニュアル 2026年度版"
            required
          />
        </div>
        <div>
          <label className={labelCls}>カテゴリ（自由入力）</label>
          <input
            type="text"
            name="category"
            className={inputCls}
            placeholder="例: 販売マニュアル / 通知書類"
          />
        </div>
        <div>
          <label className={labelCls}>公開範囲</label>
          <select name="visibility" className={inputCls} defaultValue="all" required>
            <option value="all">全体（全ロールに公開）</option>
            <option value="primary">1次店まで（SNC+1次店）</option>
            <option value="snc">SNC内のみ</option>
          </select>
        </div>
        <div className="col-span-3">
          <label className={labelCls}>ファイル</label>
          <input type="file" name="file" className={inputCls} required />
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
      <div className="mt-4">
        <button type="submit" className={btnPrimary} disabled={pending}>
          {pending ? "アップロード中…" : "アップロード"}
        </button>
      </div>
    </form>
  );
}
