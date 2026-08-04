"use client";

// 訪販員申請 CSV一括申請フォーム（SPEC §7.4 / §3.6）
// - ひな形CSVの列順どおりのファイルをアップロード
// - 誓約書PDFは `{誓約書No}-{連番3桁}.pdf` のファイル名で複数同時にアップロードし、CSV行順に突合
// - エラーが1件でもあれば「n行目: 理由」を一覧表示し、全件登録されない
import { useActionState, useState } from "react";
import { btnPrimary, btnOutline } from "@/components/ui";
import { csvBulkApplyAction, type CsvBulkState } from "./actions";
import { FIELD_AGENT_CSV_HEADERS } from "./csv-columns";

const initialState: CsvBulkState = {};

export function CsvBulkForm() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(csvBulkApplyAction, initialState);

  if (!open) {
    return (
      <div className="mb-4 flex items-center gap-3">
        <button type="button" className={btnOutline} onClick={() => setOpen(true)}>
          CSV一括申請
        </button>
        <a href="/field-agents/csv/template" className={btnOutline}>
          一括申請CSVひな形
        </a>
        {state.success && (
          <span className="text-sm font-medium text-emerald-600">{state.success}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">CSV一括申請</h2>
        <button
          type="button"
          className="text-sm text-slate-500 hover:underline"
          onClick={() => setOpen(false)}
        >
          閉じる
        </button>
      </div>

      <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-xs leading-relaxed text-blue-900">
        <div>
          CSVの列（この順序）: {FIELD_AGENT_CSV_HEADERS.join(",")}
        </div>
        <div className="mt-1">
          誓約書PDFは <strong>誓約書No-連番3桁.pdf</strong>（例: 誓約書No 70 で30行 →
          70-001.pdf〜70-030.pdf）のファイル名でCSVの行順に突合します。
          エラーが1件でもある場合は<strong>全件登録されません</strong>。
        </div>
      </div>

      <form action={formAction} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            一括申請CSV <span className="text-red-500">*</span>
          </label>
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-600">
            誓約書PDF（複数選択可・任意）
          </label>
          <input
            type="file"
            name="pledgeFiles"
            accept="application/pdf,.pdf"
            multiple
            className="w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700"
          />
        </div>

        {state.errors && state.errors.length > 0 && (
          <div className="rounded-xl bg-red-50 p-3 text-xs text-red-700">
            <div className="mb-1 font-bold">
              取込エラー（{state.errors.length}件・全件登録されていません）
            </div>
            <ul className="list-inside list-disc space-y-0.5">
              {state.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {state.error && (
          <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{state.error}</div>
        )}
        {state.success && (
          <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {state.success}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="submit" disabled={pending} className={btnPrimary}>
            {pending ? "取込中..." : "一括申請する"}
          </button>
          <a href="/field-agents/csv/template" className={btnOutline}>
            一括申請CSVひな形
          </a>
        </div>
      </form>
    </div>
  );
}
