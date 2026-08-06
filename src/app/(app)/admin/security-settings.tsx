"use client";

import { useActionState, useState } from "react";
import type { MouseEvent } from "react";
import {
  anonymizePiiAction,
  eraseAgencyAction,
  updateSecuritySettingAction,
  type ErasureActionState,
  type SettingActionState,
} from "./actions";
import type { ErasureReport } from "@/lib/erasure";
import { btnDanger, btnPrimary, inputCls, labelCls, tdCls, thCls } from "@/components/ui";

// 管理画面の「セキュリティ設定」「データ削除」セクション（§10.1 / §10.3）。
// 認可はUI（ボタン出し分け）とAPI（server action 内の再検証）の両層で行う（§3.2）。

export type SettingView = {
  key: string;
  label: string;
  description: string;
  value: string;
  /** 値の出どころ（DB設定 / 環境変数 / 未設定） */
  sourceLabel: string;
  updatedBy: string | null;
  envVar?: string;
};

export type AgencyOption = { id: string; code: string; name: string; tier: number };

const confirmClick = (msg: string) => (e: MouseEvent<HTMLButtonElement>) => {
  if (!confirm(msg)) e.preventDefault();
};

// ===== SEC-011 / A-054: IP許可リストを管理画面から変更する（設定変更は監査ログ対象 §3.3） =====
export function SecuritySettingForm({
  setting,
  canUpdate,
}: {
  setting: SettingView;
  canUpdate: boolean;
}) {
  const [state, action, pending] = useActionState<SettingActionState, FormData>(
    updateSecuritySettingAction,
    undefined
  );

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="key" value={setting.key} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[280px] flex-1">
          <label className={labelCls}>{setting.label}</label>
          <input
            name="settingValue"
            defaultValue={setting.value}
            className={inputCls}
            placeholder="203.0.113.10,203.0.113.11（空欄で無効）"
            disabled={!canUpdate}
          />
        </div>
        <div className="min-w-[240px] flex-1">
          <label className={labelCls}>変更理由（必須・監査ログに記録されます）</label>
          <input
            name="settingReason"
            className={inputCls}
            required
            maxLength={200}
            placeholder="例: 拠点追加に伴う許可IPの追加"
            disabled={!canUpdate}
          />
        </div>
        {canUpdate && (
          <button
            className={btnPrimary}
            disabled={pending}
            onClick={confirmClick(
              "IP許可リストを変更しますか？（設定変更は監査ログに記録されます）"
            )}
          >
            {pending ? "反映中..." : "IP許可リストを更新する"}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500">{setting.description}</p>
      <p className="text-xs text-slate-500">
        現在の値: <span className="font-mono">{setting.value || "(未設定)"}</span>（
        {setting.sourceLabel}
        {setting.updatedBy ? ` / 最終変更者: ${setting.updatedBy}` : ""}）
        {setting.envVar ? `。DBに値が無い場合は環境変数 ${setting.envVar} を使用します。` : ""}
      </p>
      {!canUpdate && (
        <p className="text-xs text-slate-500">
          この設定を変更する権限がありません（変更できるのは①②です）。
        </p>
      )}
      {state?.message && <p className="text-xs text-emerald-600">{state.message}</p>}
      {state?.warning && <p className="text-xs text-amber-600">{state.warning}</p>}
      {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
    </form>
  );
}

// ===== SEC-025: テナント（代理店）単位のデータ一括削除 =====
export function TenantErasureForm({
  agencies,
  canExecute,
}: {
  agencies: AgencyOption[];
  canExecute: boolean;
}) {
  const [state, action, pending] = useActionState<ErasureActionState, FormData>(
    eraseAgencyAction,
    undefined
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        指定した代理店に紐づく業務データ（Airisアカウント・販売員ID・訪販員申請）を
        §3.4の論理削除（「削除済」ステータスで1年間保持）にします。物理削除は行いません。
        日報・稼働提出物・窓口案件は個人情報カラムを持たないため分析用に保持し、件数のみ
        削除完了レポートに記載します。
      </p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="w-72">
          <label className={labelCls}>対象テナント（代理店）</label>
          <select name="agencyId" className={inputCls} required disabled={!canExecute}>
            <option value="">選択してください</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.tier === 1 ? "1次" : "2次"} {a.code} {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[240px] flex-1">
          <label className={labelCls}>削除理由（必須・監査ログに記録されます）</label>
          <input
            name="erasureReason"
            className={inputCls}
            required
            maxLength={200}
            placeholder="例: 代理店契約解約に伴うデータ削除依頼"
            disabled={!canExecute}
          />
        </div>
        <label className="flex items-center gap-2 pb-2 text-xs text-slate-600">
          <input type="checkbox" name="includeChildren" disabled={!canExecute} />
          配下の2次代理店も対象に含める
        </label>
        {canExecute && (
          <button
            className={btnDanger}
            disabled={pending}
            onClick={confirmClick(
              "選択したテナントのデータを一括削除しますか？この操作は監査ログに記録され、削除完了レポートが発行されます。"
            )}
          >
            {pending ? "実行中..." : "テナントデータを一括削除する"}
          </button>
        )}
      </form>
      {!canExecute && (
        <p className="text-xs text-slate-500">
          この操作を実行する権限がありません（実行できるのは①サスラボ社システム管理アカウントです）。
        </p>
      )}
      <ErasureResultBox state={state} />
    </div>
  );
}

// ===== SEC-026: 個人情報のオンデマンド削除（匿名化） =====
export function PiiErasureForm({
  entityOptions,
  canExecute,
}: {
  entityOptions: { value: string; label: string; hint: string }[];
  canExecute: boolean;
}) {
  const [state, action, pending] = useActionState<ErasureActionState, FormData>(
    anonymizePiiAction,
    undefined
  );
  const [entityType, setEntityType] = useState(entityOptions[0]?.value ?? "account");
  const hint = entityOptions.find((o) => o.value === entityType)?.hint ?? "";

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-600">
        対象を指定して個人情報カラムのみを即時匿名化します（§3.4の匿名化仕様と同一定義。
        削除後1年の経過を待ちません）。個人情報を消したレコードは運用を継続できないため、
        未削除の場合は併せて論理削除します。数値実績は分析用に残ります。
      </p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="w-52">
          <label className={labelCls}>対象種別</label>
          <select
            name="entityType"
            className={inputCls}
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            disabled={!canExecute}
          >
            {entityOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="w-72">
          <label className={labelCls}>対象の識別子</label>
          <input
            name="targetKey"
            className={inputCls}
            required
            placeholder={hint}
            disabled={!canExecute}
          />
        </div>
        <div className="min-w-[240px] flex-1">
          <label className={labelCls}>削除理由（必須・監査ログに記録されます）</label>
          <input
            name="anonymizeReason"
            className={inputCls}
            required
            maxLength={200}
            placeholder="例: 本人からの個人情報削除請求"
            disabled={!canExecute}
          />
        </div>
        {canExecute && (
          <button
            className={btnDanger}
            disabled={pending}
            onClick={confirmClick(
              "対象の個人情報を匿名化しますか？匿名化した個人情報は復元できません。"
            )}
          >
            {pending ? "実行中..." : "個人情報を匿名化する"}
          </button>
        )}
      </form>
      {!canExecute && (
        <p className="text-xs text-slate-500">
          この操作を実行する権限がありません（実行できるのは①②です）。
        </p>
      )}
      <ErasureResultBox state={state} />
    </div>
  );
}

// ===== SEC-027: 削除完了レポート（対象件数・データ種別・実行日時・実行者） =====
function ErasureResultBox({ state }: { state: ErasureActionState }) {
  if (!state) return null;
  return (
    <div>
      {state.message && <p className="text-xs text-emerald-600">{state.message}</p>}
      {state.error && <p className="text-xs text-red-600">{state.error}</p>}
      {state.report && <ErasureReportCard report={state.report} />}
    </div>
  );
}

function ErasureReportCard({ report }: { report: ErasureReport }) {
  return (
    <div
      // 削除証明の検証（e2e/29-erasure.spec.ts）でカード全体を一意に掴むための目印。
      // 見出し文言で div を絞ると祖先も一致して不安定になるため testid を置く。
      data-testid="erasure-report"
      className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700"
    >
      <div className="font-semibold text-slate-800">削除完了レポート（削除証明用）</div>
      <div className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
        <div>
          実行日時: <span className="font-mono">{report.executedAt}</span>
        </div>
        <div>
          実行者: <span className="font-mono">{report.executedBy}</span>
          {report.vendor ? "（ベンダー操作）" : ""}
        </div>
        <div>対象: {report.targetLabel}</div>
        <div>範囲: {report.scopeLabel}</div>
        <div>削除件数合計: {report.total}件</div>
        <div>削除理由: {report.reason}</div>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {report.items.map((item) => (
          <li key={`${item.dataType}-${item.treatment}`}>
            ・{item.dataType}: {item.count}件（{item.treatment}）
          </li>
        ))}
      </ul>
      <a
        href={
          report.auditId
            ? `/admin/csv?type=erasure&id=${encodeURIComponent(report.auditId)}`
            : "/admin/csv?type=erasure"
        }
        className="mt-2 inline-block font-semibold text-blue-600 underline"
      >
        このレポートをCSVで出力
      </a>
    </div>
  );
}

// 削除実績の一覧（監査ログから復元したレポート。SEC-027 / SEC-028 の確認用）
export function ErasureHistoryTable({ reports }: { reports: ErasureReport[] }) {
  if (reports.length === 0) {
    return (
      <p className="text-xs text-slate-500">
        削除の実行記録はまだありません。実行するとここに削除完了レポートが表示されます。
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[820px]">
        <thead>
          <tr>
            <th className={thCls}>実行日時</th>
            <th className={thCls}>実行者</th>
            <th className={thCls}>操作種別</th>
            <th className={thCls}>対象</th>
            <th className={thCls}>データ種別・件数</th>
            <th className={thCls}>削除理由</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.auditId}>
              <td className={`${tdCls} text-xs whitespace-nowrap`}>{r.executedAt}</td>
              <td className={`${tdCls} font-mono text-xs`}>
                {r.executedBy}
                {r.vendor && <span className="ml-1 text-amber-600">（ベンダー）</span>}
              </td>
              <td className={`${tdCls} text-xs`}>
                {r.kind === "pii" ? "個人情報削除（匿名化）" : "テナント一括削除"}
              </td>
              <td className={`${tdCls} text-xs`}>
                {r.targetLabel}
                {r.scopeLabel && <span className="text-slate-400"> / {r.scopeLabel}</span>}
              </td>
              <td className={`${tdCls} text-xs`}>
                {r.items.length === 0
                  ? `${r.total}件`
                  : r.items.map((i) => `${i.dataType}:${i.count}`).join(" / ")}
              </td>
              <td className={`${tdCls} text-xs`}>{r.reason || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
