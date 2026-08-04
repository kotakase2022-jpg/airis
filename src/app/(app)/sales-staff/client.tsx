"use client";

// 販売員ID管理 クライアントコンポーネント（申請フォーム / CSV一括申請 / 行内操作）

import { useActionState } from "react";
import { btnDanger, btnOutline, btnPrimary, btnSuccess, inputCls, labelCls } from "@/components/ui";
import {
  applyStaffAction,
  csvBulkApplyAction,
  deleteStaffAction,
  finalApproveAction,
  firstApproveAction,
  restoreStaffAction,
  resumeStaffAction,
  suspendStaffAction,
} from "./actions";

type AgencyOption = { id: string; code: string; name: string; tier: number };

// ============ ＋ 販売員ID申請フォーム ============
export function ApplyForm({
  agencies,
  fixedAgencyId,
}: {
  agencies: AgencyOption[];
  fixedAgencyId?: string;
}) {
  const [state, formAction, pending] = useActionState(applyStaffAction, undefined);
  const fixed = fixedAgencyId ? agencies.find((a) => a.id === fixedAgencyId) : undefined;
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>所属代理店 *</label>
          {fixed ? (
            <>
              <input type="hidden" name="agencyId" value={fixed.id} />
              <input className={inputCls} value={`${fixed.name}（${fixed.code}）`} disabled />
            </>
          ) : (
            <select name="agencyId" required defaultValue="" className={inputCls}>
              <option value="" disabled>
                選択してください
              </option>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tier === 2 ? "　" : ""}
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={labelCls}>姓 *</label>
          <input name="lastName" required className={inputCls} placeholder="山田" />
        </div>
        <div>
          <label className={labelCls}>名 *</label>
          <input name="firstName" required className={inputCls} placeholder="太郎" />
        </div>
        <div>
          <label className={labelCls}>生年月日 *</label>
          <input type="date" name="birthDate" required className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>電話番号 *</label>
          <input name="phone" required className={inputCls} placeholder="090-1234-5678" />
        </div>
        <div>
          <label className={labelCls}>メールアドレス（任意）</label>
          <input type="email" name="email" className={inputCls} placeholder="taro@example.com" />
        </div>
      </div>
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.success && <p className="text-sm text-emerald-600">{state.success}</p>}
      <button disabled={pending} className={btnPrimary}>
        {pending ? "送信中..." : "申請する"}
      </button>
    </form>
  );
}

// ============ CSV一括申請フォーム ============
export function CsvBulkForm() {
  const [state, formAction, pending] = useActionState(csvBulkApplyAction, undefined);
  return (
    <form action={formAction} className="space-y-3">
      <p className="text-xs text-slate-500">
        ひな形CSV（姓,名,生年月日,電話番号,代理店コード,メールアドレス）に沿って作成したファイルをアップロードしてください。
        エラーが1件でもある場合は全件登録されません。
      </p>
      <div className="flex items-center gap-3">
        <input type="file" name="file" accept=".csv,text/csv" required className="text-sm" />
        <button disabled={pending} className={btnPrimary}>
          {pending ? "取込中..." : "一括申請する"}
        </button>
      </div>
      {state?.errors && state.errors.length > 0 && (
        <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700">
          <div className="mb-1 font-semibold">取込エラー（全件登録されていません）</div>
          <ul className="list-disc pl-4">
            {state.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {state?.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state?.success && <p className="text-sm text-emerald-600">{state.success}</p>}
    </form>
  );
}

// ============ 行内操作（状態・権限依存） ============
// 最終承認の一時パスワードは useActionState の戻り値でインライン一度だけ表示する（URLに載せない）。
export function RowActions({
  staffId,
  status,
  canFirstApprove,
  canFinalApprove,
  canSuspend,
  canDelete,
  canRestore,
}: {
  staffId: string;
  status: string;
  canFirstApprove: boolean;
  canFinalApprove: boolean;
  canSuspend: boolean;
  canDelete: boolean;
  canRestore: boolean;
}) {
  const [state, finalAction, pending] = useActionState(finalApproveAction, undefined);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {state?.salesId && state?.tempPassword && (
        <div className="w-full rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-800">
          <div className="font-semibold">本登録が完了しました。</div>
          <div>
            販売員ID: <span className="font-mono font-bold">{state.salesId}</span>
          </div>
          <div>
            一時パスワード: <span className="font-mono font-bold">{state.tempPassword}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-emerald-600">
            ※この画面でのみ表示されます（再表示不可）。本人へ安全な方法で伝達してください。
          </div>
        </div>
      )}
      {status === "applying" && canFirstApprove && (
        <form action={firstApproveAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button className={btnSuccess}>1次承認</button>
        </form>
      )}
      {status === "provisional" && canFinalApprove && !state?.salesId && (
        <form action={finalAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={pending} className={btnSuccess}>
            {pending ? "処理中..." : "最終承認"}
          </button>
        </form>
      )}
      {(status === "provisional" || status === "registered") && canSuspend && (
        <form action={suspendStaffAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button className={btnDanger}>停止</button>
        </form>
      )}
      {status === "suspended" && canSuspend && (
        <form action={resumeStaffAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button className={btnOutline}>再開</button>
        </form>
      )}
      {status !== "deleted" && canDelete && (
        <form
          action={deleteStaffAction}
          onSubmit={(e) => {
            if (!window.confirm("この販売員IDを削除します（論理削除・1年間保持）。よろしいですか？")) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="staffId" value={staffId} />
          <button className={btnDanger}>削除</button>
        </form>
      )}
      {status === "deleted" && canRestore && (
        <form action={restoreStaffAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button className={btnOutline}>復旧</button>
        </form>
      )}
      {state?.error && <span className="w-full text-[11px] text-red-600">{state.error}</span>}
    </div>
  );
}
