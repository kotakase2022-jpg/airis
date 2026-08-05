"use client";

// 販売員ID管理 クライアントコンポーネント（申請フォーム / CSV一括申請 / 行内操作）

import { useActionState, useState } from "react";
import { btnDanger, btnOutline, btnPrimary, btnSuccess, inputCls, labelCls } from "@/components/ui";
import { fifteenYearsAgo } from "@/lib/age";
import {
  applyStaffAction,
  csvBulkApplyAction,
  deleteStaffAction,
  finalApproveAction,
  firstApproveAction,
  restoreStaffAction,
  resumeStaffAction,
  suspendStaffAction,
  updateStaffAction,
  type RowActionState,
} from "./actions";

type AgencyOption = { id: string; code: string; name: string; tier: number };

// 販売員IDの登録情報（編集フォームの初期値）
export type StaffEditable = {
  lastName: string;
  firstName: string;
  birthDate: string;
  phone: string;
  email: string;
};

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
          {/* デフォルトは「15年前の今日」= 申請可能な最も新しい生年月日（発注者指示）。
              これより後（15歳未満）はサーバー側で拒否される */}
          <input
            type="date"
            name="birthDate"
            required
            className={inputCls}
            defaultValue={fifteenYearsAgo()}
          />
        </div>
        <div>
          <label className={labelCls}>電話番号 *</label>
          {/* 0始まり10〜11桁・ハイフン任意（問題一覧No.32。入力時点で形式チェック） */}
          <input
            name="phone"
            required
            className={inputCls}
            placeholder="090-1234-5678"
            inputMode="tel"
            maxLength={13}
            pattern="0[0-9\-]{9,12}"
            title="0始まりの10〜11桁（ハイフン任意）で入力してください"
          />
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

// ============ 編集フォーム（§5.1「変」/ §7.3 操作列「編集」） ============
// 氏名・生年月日・電話番号・メールアドレスを編集する（販売員IDの登録情報 §6.2-1）。
function StaffEditForm({ staffId, initial }: { staffId: string; initial: StaffEditable }) {
  const [state, formAction, pending] = useActionState(updateStaffAction, undefined);
  return (
    <form action={formAction} className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3">
      <input type="hidden" name="staffId" value={staffId} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>姓 *</label>
          <input name="lastName" required defaultValue={initial.lastName} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>名 *</label>
          <input name="firstName" required defaultValue={initial.firstName} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>生年月日 *</label>
          <input
            type="date"
            name="birthDate"
            required
            defaultValue={initial.birthDate}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>電話番号 *</label>
          <input
            name="phone"
            required
            defaultValue={initial.phone}
            className={inputCls}
            inputMode="tel"
            maxLength={13}
            pattern="0[0-9\-]{9,12}"
            title="0始まりの10〜11桁（ハイフン任意）で入力してください"
          />
        </div>
        <div className="col-span-2">
          <label className={labelCls}>メールアドレス（任意）</label>
          <input type="email" name="email" defaultValue={initial.email} className={inputCls} />
        </div>
      </div>
      {state?.error && <p className="mt-2 text-[11px] text-red-600">{state.error}</p>}
      {state?.success && <p className="mt-2 text-[11px] text-emerald-600">{state.success}</p>}
      <div className="mt-2">
        <button disabled={pending} className={btnPrimary}>
          {pending ? "保存中..." : "保存"}
        </button>
      </div>
    </form>
  );
}

// 複数の行内操作のうち、最後に実行されたものの結果状態を返す（ts の大小で判定）
function latestRowState(states: RowActionState[]): RowActionState {
  let latest: RowActionState;
  for (const s of states) {
    if (!s) continue;
    if (!latest || (s.ts ?? 0) >= (latest.ts ?? 0)) latest = s;
  }
  return latest;
}

// ============ 行内操作（状態・権限依存） ============
// 最終承認の一時パスワードは useActionState の戻り値でインライン一度だけ表示する（URLに載せない）。
export function RowActions({
  staffId,
  status,
  initial,
  canUpdate,
  canFirstApprove,
  canFinalApprove,
  canSuspend,
  canDelete,
  canRestore,
}: {
  staffId: string;
  status: string;
  initial: StaffEditable;
  canUpdate: boolean;
  canFirstApprove: boolean;
  canFinalApprove: boolean;
  canSuspend: boolean;
  canDelete: boolean;
  canRestore: boolean;
}) {
  const [state, finalAction, pending] = useActionState(finalApproveAction, undefined);
  // 行内操作は結果状態（権限不足・状態不整合・DB例外）を必ず表示する（§3.2）。
  // hook は親（この行コンポーネント）に置くことで、成功時の revalidate による
  // 再レンダー後もメッセージが残る（子フォームは状態遷移で unmount されるため）。
  const [firstState, firstAction, firstPending] = useActionState(firstApproveAction, undefined);
  const [suspendState, suspendAction, suspendPending] = useActionState(
    suspendStaffAction,
    undefined
  );
  const [resumeState, resumeAction, resumePending] = useActionState(resumeStaffAction, undefined);
  const [deleteState, deleteAction, deletePending] = useActionState(deleteStaffAction, undefined);
  const [restoreState, restoreAction, restorePending] = useActionState(
    restoreStaffAction,
    undefined
  );
  const [editing, setEditing] = useState(false);
  // 直近に実行された行内操作の結果だけを表示する（ts で新旧を判定）
  const latest = latestRowState([firstState, suspendState, resumeState, deleteState, restoreState]);
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
      {status !== "deleted" && canUpdate && (
        <button type="button" className={btnOutline} onClick={() => setEditing((v) => !v)}>
          {editing ? "編集を閉じる" : "編集"}
        </button>
      )}
      {status === "applying" && canFirstApprove && (
        <form action={firstAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={firstPending} className={btnSuccess}>
            {firstPending ? "処理中..." : "1次承認"}
          </button>
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
        <form action={suspendAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={suspendPending} className={btnDanger}>
            {suspendPending ? "処理中..." : "停止"}
          </button>
        </form>
      )}
      {status === "suspended" && canSuspend && (
        <form action={resumeAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={resumePending} className={btnOutline}>
            {resumePending ? "処理中..." : "再開"}
          </button>
        </form>
      )}
      {status !== "deleted" && canDelete && (
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (
              !window.confirm("この販売員IDを削除します（論理削除・1年間保持）。よろしいですか？")
            ) {
              e.preventDefault();
            }
          }}
        >
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={deletePending} className={btnDanger}>
            {deletePending ? "処理中..." : "削除"}
          </button>
        </form>
      )}
      {status === "deleted" && canRestore && (
        <form action={restoreAction}>
          <input type="hidden" name="staffId" value={staffId} />
          <button disabled={restorePending} className={btnOutline}>
            {restorePending ? "処理中..." : "復旧"}
          </button>
        </form>
      )}
      {state?.error && <span className="w-full text-[11px] text-red-600">{state.error}</span>}
      {/* 行内操作の結果（権限不足・状態不整合・DB例外 → 必ずユーザーへ提示する §3.2） */}
      {latest?.error && (
        <p
          role="alert"
          data-testid="row-action-error"
          className="w-full text-[11px] font-semibold text-red-600"
        >
          {latest.error}
        </p>
      )}
      {latest?.success && (
        <p
          role="status"
          data-testid="row-action-success"
          className="w-full text-[11px] text-emerald-600"
        >
          {latest.success}
        </p>
      )}
      {editing && status !== "deleted" && canUpdate && (
        <StaffEditForm staffId={staffId} initial={initial} />
      )}
    </div>
  );
}
