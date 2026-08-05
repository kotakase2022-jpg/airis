"use client";

// 日報CSVアップロード（行単位検証→全件or拒否 §3.6）

import { useActionState } from "react";
import { uploadDailyCsv } from "./actions";
import type { CsvUploadState } from "./defs";
import { inputCls, labelCls, btnPrimary } from "@/components/ui";

export function CsvUpload() {
  const [state, formAction, pending] = useActionState<CsvUploadState, FormData>(uploadDailyCsv, {});

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <label className={labelCls}>日報タイプ</label>
          <select name="csvType" className={inputCls + " w-32"}>
            <option value="訪販">訪販</option>
            <option value="テレマ">テレマ</option>
          </select>
        </div>
        <div className="min-w-52 flex-1">
          <label className={labelCls}>CSVファイル</label>
          <input type="file" name="file" accept=".csv" required className={inputCls} />
        </div>
        <button disabled={pending} className={btnPrimary}>
          {pending ? "取込中..." : "CSVアップロード"}
        </button>
      </form>
      <p className="mt-1.5 text-xs text-slate-500">
        ※テンプレートのヘッダ形式のまま取り込んでください。エラーが1行でもあると全件取り込まれません。
      </p>
      {state.success && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.success}
        </p>
      )}
      {state.errors && state.errors.length > 0 && (
        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg bg-red-50 px-3 py-2">
          <p className="mb-1 text-sm font-semibold text-red-700">
            取込エラー（{state.errors.length}件）: 全件拒否しました
          </p>
          <ul className="list-inside list-disc text-xs text-red-600">
            {state.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
