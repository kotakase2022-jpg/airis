"use client";

// 稼働提出物 提出フォーム（SPEC §7.6）
// 年度は対象月から自動計算して表示（4月〜翌3月を同一年度 = fiscalYearOf と同一ロジック）

import { useActionState, useState } from "react";
import { createSubmission } from "./actions";
import type { SubmissionFormState } from "./defs";
import { inputCls, labelCls, btnPrimary } from "@/components/ui";

export type AgencyOption = { id: string; label: string };

function fiscalYearLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return "-";
  const y = Number(m[1]);
  const mm = Number(m[2]);
  return `${mm >= 4 ? y : y - 1}年度`;
}

export function SubmissionForm({
  kinds,
  agencyOptions,
  fixedAgency,
  defaultMonth,
}: {
  kinds: readonly string[];
  agencyOptions: AgencyOption[];
  fixedAgency: AgencyOption | null; // R8は自店固定
  defaultMonth: string;
}) {
  const [state, formAction, pending] = useActionState<SubmissionFormState, FormData>(
    createSubmission,
    {}
  );
  const [month, setMonth] = useState(defaultMonth);

  return (
    <form action={formAction} className="grid grid-cols-3 gap-4">
      <div>
        <label className={labelCls}>提出物種別</label>
        <select name="kind" required className={inputCls}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>対象月</label>
        <input
          type="month"
          name="targetMonth"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          required
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>年度（自動計算）</label>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {fiscalYearLabel(month)}
        </div>
      </div>
      <div>
        <label className={labelCls}>提出元代理店</label>
        {fixedAgency ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            {fixedAgency.label}
          </div>
        ) : (
          <select name="submitterAgencyId" required className={inputCls}>
            {agencyOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div>
        <label className={labelCls}>ファイル（必須）</label>
        <input
          type="file"
          name="file"
          accept=".xlsx,.xls,.pdf,.png,.jpg,.jpeg,.zip"
          required
          className={inputCls}
        />
      </div>
      <div>
        <label className={labelCls}>メモ</label>
        <input name="memo" placeholder="補足事項があれば入力" className={inputCls} />
      </div>
      <div className="col-span-3">
        {state.error && (
          <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{state.error}</p>
        )}
        {state.success && (
          <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {state.success}
          </p>
        )}
        <button disabled={pending} className={btnPrimary}>
          {pending ? "提出中..." : "提出する"}
        </button>
      </div>
    </form>
  );
}
