"use client";

// 稼働日報 入力フォーム（SPEC §7.5。唯一のスマホ最適化画面: 1カラム化+大きめ入力欄）

import { useActionState, useState } from "react";
import { saveDailyReport } from "./actions";
import type { DailyFormState } from "./defs";
import { SectionTitle, labelCls, btnPrimary } from "@/components/ui";

export type StaffOption = { id: string; label: string; agencyName: string };

// スマホで押しやすいよう通常より大きめの入力欄
const bigInput =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base sm:text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

const VISIT_FIELDS: { name: string; label: string }[] = [
  { name: "forecastAcq", label: "獲得見込（月初見込）" },
  { name: "acquisitions", label: "獲得" },
  { name: "workers", label: "稼働数" },
  { name: "visits", label: "訪問数" },
  { name: "meetings", label: "対面数" },
  { name: "negotiations", label: "商談数" },
  { name: "contracts", label: "成約数" },
];

const TELE_FIELDS: { name: string; label: string; float?: boolean }[] = [
  { name: "forecastHours", label: "稼働時間（月初見込）", float: true },
  { name: "forecastEntries", label: "エントリー数（月初見込）" },
  { name: "actualHours", label: "稼働時間（実績）", float: true },
  { name: "entries", label: "エントリー数（実績）" },
  { name: "appointments", label: "アポ数（実績）" },
  { name: "closePassed", label: "クローズ通過数" },
  { name: "preConfirmPassed", label: "前確通過数（実績）" },
];

// 月初見込フィールド（月の初回提出時のみ入力可 要件6-3）
const FORECAST_FIELDS = ["forecastAcq", "forecastHours", "forecastEntries"] as const;

export function DailyReportForm({
  staffOptions,
  fixedStaff,
  defaultDate,
  forecastHolders,
  existing = {},
}: {
  staffOptions: StaffOption[];
  fixedStaff: StaffOption | null; // R9は自分のSalesStaff固定
  defaultDate: string;
  // 「販売員ID:タイプ:月:フィールド」→ 月初見込が最初に入ったレコードの日付（BUG-007）
  forecastHolders: Record<string, string>;
  // 「販売員ID|日付|タイプ」→ 提出済み日報の既存値（問題一覧No.1 / D-011）。
  // 該当があればフォームへプリフィルし、未変更項目の消失（0/空欄上書き）を防ぐ
  existing?: Record<string, Record<string, number | string | null>>;
}) {
  const [state, formAction, pending] = useActionState<DailyFormState, FormData>(
    saveDailyReport,
    {}
  );
  const [type, setType] = useState<"訪販" | "テレマ">("訪販");
  const [date, setDate] = useState(defaultDate);
  const [staffId, setStaffId] = useState(fixedStaff ? fixedStaff.id : (staffOptions[0]?.id ?? ""));
  const agencyName = fixedStaff
    ? fixedStaff.agencyName
    : (staffOptions.find((s) => s.id === staffId)?.agencyName ?? "-");
  const currentStaffId = fixedStaff ? fixedStaff.id : staffId;

  // 選択中の（販売員×日付×タイプ）に提出済み日報があれば既存値を読み込む（問題一覧No.1）。
  // recKey を input の key に使い、選択が変わるたびに defaultValue を再適用（remount）する
  const recKey = `${currentStaffId}|${date}|${type}`;
  const rec = existing[recKey];
  const pre = (name: string): string => {
    const v = rec?.[name];
    return v === null || v === undefined ? "" : String(v);
  };

  // 月初見込は初回提出時のみ入力（要件6-3 / BUG-007）:
  // 選択中の販売員×タイプ×月に既存の見込があり、その「最初の見込」を書き換えうる
  // 日付（見込保持レコードの日付以前）を選択している場合はフィールドをdisabledにする。
  // サーバ側（saveDailyReport）でも同一条件で送信値を無視するため、UIはあくまで補助。
  const forecastLocked = (name: string): boolean => {
    if (!(FORECAST_FIELDS as readonly string[]).includes(name)) return false;
    const holder = forecastHolders[`${currentStaffId}:${type}:${date.slice(0, 7)}:${name}`];
    return !!holder && date <= holder;
  };

  return (
    <div>
      <form action={formAction} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls}>日付</label>
          <input
            type="date"
            name="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
            className={bigInput}
          />
        </div>
        <div>
          <label className={labelCls}>販売員ID</label>
          {fixedStaff ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-base text-slate-700 sm:text-sm">
              {fixedStaff.label}
            </div>
          ) : (
            <select
              name="salesStaffId"
              value={staffId}
              onChange={(e) => setStaffId(e.target.value)}
              required
              className={bigInput}
            >
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={labelCls}>代理店（自動）</label>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-base text-slate-700 sm:text-sm">
            {agencyName}
          </div>
        </div>

        <div>
          <label className={labelCls}>日報タイプ</label>
          <input type="hidden" name="type" value={type} />
          <div className="inline-flex w-full rounded-xl bg-slate-100 p-1">
            {(["訪販", "テレマ"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                className={
                  "flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition " +
                  (type === t
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-500 hover:text-slate-700")
                }
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {rec && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 sm:col-span-3">
            この日付・タイプの提出済み日報を読み込みました（編集モード）。変更した項目だけ書き換えて保存できます。
          </div>
        )}
        <div className="sm:col-span-2">
          <label className={labelCls}>エリア</label>
          <input
            key={`area-${recKey}`}
            name="area"
            defaultValue={pre("area")}
            placeholder="例: 東京都世田谷区"
            className={bigInput}
          />
        </div>

        {(type === "訪販" ? VISIT_FIELDS : TELE_FIELDS).map((f) => {
          const locked = forecastLocked(f.name);
          return (
            <div key={`${type}-${f.name}`}>
              <label className={labelCls}>{f.label}</label>
              <input
                key={`${f.name}-${recKey}`}
                type="number"
                name={f.name}
                defaultValue={pre(f.name)}
                min={0}
                step={"float" in f && f.float ? "0.5" : "1"}
                inputMode="numeric"
                placeholder="0"
                disabled={locked}
                className={bigInput + " disabled:bg-slate-100 disabled:text-slate-400"}
              />
              {locked && (
                <p className="mt-1 text-xs text-slate-500">月初見込は初回提出時のみ入力できます</p>
              )}
            </div>
          );
        })}

        <div className="sm:col-span-3">
          <label className={labelCls}>活動実施内容</label>
          <textarea
            key={`activityContent-${recKey}`}
            name="activityContent"
            defaultValue={pre("activityContent")}
            rows={3}
            className={bigInput}
          />
        </div>
        <div className="sm:col-span-3">
          <label className={labelCls}>活動実施結果</label>
          <textarea
            key={`activityResult-${recKey}`}
            name="activityResult"
            defaultValue={pre("activityResult")}
            rows={3}
            className={bigInput}
          />
        </div>
        <div className="sm:col-span-3">
          <label className={labelCls}>備考（その他トピックス）</label>
          <textarea
            key={`notes-${recKey}`}
            name="notes"
            defaultValue={pre("notes")}
            rows={2}
            className={bigInput}
          />
        </div>

        <div className="sm:col-span-3">
          {state.error && (
            <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">
              {state.error}
            </p>
          )}
          {state.success && (
            <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {state.success}
            </p>
          )}
          <button
            disabled={pending}
            className={`${btnPrimary} w-full py-3 text-base sm:w-auto sm:py-2 sm:text-sm`}
          >
            {pending ? "保存中..." : "日報を保存する"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            ※同じ日付・タイプ・販売員IDの日報は再提出時に上書きされます。
          </p>
        </div>
      </form>

      {state.kpi && (
        <div className="mt-6">
          <SectionTitle>{state.kpiTitle ?? "当月KPI"}</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {state.kpi.map((k) => (
              <div
                key={k.label}
                className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-center"
              >
                <div className="text-xl font-bold text-slate-800">{k.value}</div>
                <div className="mt-0.5 text-xs text-slate-500">{k.label}</div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-400">
            ※分母が0の指標は「0」表示です。
            {state.kpiNote && ` ${state.kpiNote}`}
          </p>
        </div>
      )}
    </div>
  );
}
