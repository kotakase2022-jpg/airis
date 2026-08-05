"use client";

import { useActionState, useState } from "react";
import type { MouseEvent } from "react";
import {
  accountAction,
  updateAccountAction,
  updateVendorFlagAction,
  type AdminActionState,
} from "./actions";
import {
  Badge,
  btnDanger,
  btnOutline,
  btnPrimary,
  btnSuccess,
  inputCls,
  labelCls,
} from "@/components/ui";

// ベンダー区分（Account.isVendor = サスラボ保守区分 §10.1 / SEC要件①）の表示と切り替え。
// 変更できるのは①のみ（判定は authz.ts の canManageVendorFlag。UI・API双方で検証する §3.2）。
export function VendorFlagCell({
  id,
  isVendor,
  canManage,
}: {
  id: string;
  isVendor: boolean;
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    updateVendorFlagAction,
    undefined
  );

  return (
    <div className="min-w-[120px]">
      {isVendor ? <Badge tone="red">ベンダー</Badge> : <Badge tone="gray">通常</Badge>}
      {canManage && (
        <form action={action} className="mt-1">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="isVendor" value={isVendor ? "false" : "true"} />
          <button
            className={btnOutline}
            disabled={pending}
            onClick={(e) => {
              if (
                !confirm(
                  isVendor
                    ? "ベンダー区分を解除しますか？（監査ログに記録されます）"
                    : "サスラボ社保守（ベンダー）区分に設定しますか？（監査ログに記録されます）"
                )
              )
                e.preventDefault();
            }}
          >
            {isVendor ? "ベンダー解除" : "ベンダーに設定"}
          </button>
        </form>
      )}
      {state?.message && <p className="mt-1 text-xs text-emerald-600">{state.message}</p>}
      {state?.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </div>
  );
}

// アカウント編集フォーム（氏名・メール・ロール変更 §5.1「変」）
export function AccountEditButton({
  id,
  name,
  email,
  role,
  hasAgency,
  isSelf,
}: {
  id: string;
  name: string;
  email: string;
  role: string;
  hasAgency: boolean;
  isSelf: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    updateAccountAction,
    undefined
  );
  // 送信成功でフォームを閉じる（レンダー中の状態調整パターン）
  const [closedFor, setClosedFor] = useState<unknown>(null);
  if (
    state &&
    "message" in (state as object) &&
    (state as { message?: string }).message &&
    closedFor !== state
  ) {
    setClosedFor(state);
    setOpen(false);
  }

  const roleOptions: [string, string][] = hasAgency
    ? [
        ["R7", "一次代理店管理者"],
        ["R8", "二次代理店管理者"],
      ]
    : [
        ["R1", "SLシステム管理"],
        ["R2", "SNC管理者"],
        ["R3", "SNC運用者"],
        ["R4", "SNC閲覧者"],
        ["R5", "SNCホットライン担当"],
        ["R6", "SNC消費者センター担当"],
      ];

  return (
    <div>
      <button type="button" className={btnOutline} onClick={() => setOpen((v) => !v)}>
        編集
      </button>
      {open && (
        <form
          action={action}
          className="mt-2 w-64 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
        >
          <input type="hidden" name="id" value={id} />
          <div>
            <label className={labelCls}>氏名</label>
            <input name="name" defaultValue={name} className={inputCls} required />
          </div>
          <div>
            <label className={labelCls}>メールアドレス</label>
            <input name="email" type="email" defaultValue={email} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>ロール{isSelf ? "（自分自身は変更不可）" : ""}</label>
            <select name="role" defaultValue={role} className={inputCls} disabled={isSelf}>
              {roleOptions.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
            {isSelf && <input type="hidden" name="role" value={role} />}
          </div>
          <div>
            {/* 変更理由は必須・監査ログに記録（検収指摘 問題一覧No.15） */}
            <label className={labelCls}>変更理由（必須・監査ログに記録されます）</label>
            <input
              name="reason"
              className={inputCls}
              required
              maxLength={200}
              placeholder="例: 組織変更に伴う権限見直し"
            />
          </div>
          <div className="flex gap-2">
            <button
              className={btnPrimary}
              disabled={pending}
              onClick={(e) => {
                if (!confirm("この内容でアカウント情報を変更しますか？")) e.preventDefault();
              }}
            >
              {pending ? "保存中..." : "保存"}
            </button>
            <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
              キャンセル
            </button>
          </div>
          {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
        </form>
      )}
      {state &&
        "message" in (state as object) &&
        (state as { message?: string }).message &&
        !open && (
          <p className="mt-1 text-xs text-emerald-600">{(state as { message?: string }).message}</p>
        )}
    </div>
  );
}

// アカウント行の操作ボタン群（状態依存）+ 一時パスワードのインライン一回表示
export function AccountRowActions({
  id,
  status,
  isSelf,
  mfaEnabled = false,
  // 操作ごとの可否は §5.1 の宣言的マップで解決した結果を親から受け取る
  // （③は閲覧+リセット代行のみ。停止・削除は①②のみ）
  canSuspend = true,
  canDelete = true,
  canReset = true,
}: {
  id: string;
  status: string;
  isSelf: boolean;
  mfaEnabled?: boolean;
  canSuspend?: boolean;
  canDelete?: boolean;
  canReset?: boolean;
}) {
  const [state, action, pending] = useActionState<AdminActionState, FormData>(
    accountAction,
    undefined
  );

  if (isSelf) {
    return <span className="text-xs text-slate-400">—（自分自身）</span>;
  }
  if (status === "pending") {
    return <span className="text-xs text-slate-400">申請ページで承認</span>;
  }

  const confirmClick = (msg: string) => (e: MouseEvent<HTMLButtonElement>) => {
    if (!confirm(msg)) e.preventDefault();
  };

  return (
    <div className="min-w-[190px]">
      <form action={action} className="flex flex-wrap gap-1.5">
        <input type="hidden" name="id" value={id} />
        {status === "active" && (
          <>
            {canSuspend && (
              <button
                name="op"
                value="suspend"
                disabled={pending}
                className={btnDanger}
                onClick={confirmClick("このアカウントを停止しますか？")}
              >
                停止
              </button>
            )}
            {canDelete && (
              <button
                name="op"
                value="delete"
                disabled={pending}
                className={btnOutline}
                onClick={confirmClick("このアカウントを削除しますか？（論理削除・1年間保持）")}
              >
                削除
              </button>
            )}
            {canReset && (
              <button
                name="op"
                value="reset_password"
                disabled={pending}
                className={btnOutline}
                onClick={confirmClick(
                  "パスワードをリセットしますか？一時パスワードは一度だけ表示されます。"
                )}
              >
                PWリセット
              </button>
            )}
            {canReset && mfaEnabled && (
              <button
                name="op"
                value="mfa_reset"
                disabled={pending}
                className={btnOutline}
                onClick={confirmClick(
                  "MFAをリセットしますか？対象者は次回ログイン時にQRコードから再登録します。"
                )}
              >
                MFAリセット
              </button>
            )}
          </>
        )}
        {status === "suspended" && (
          <>
            {canSuspend && (
              <button name="op" value="resume" disabled={pending} className={btnSuccess}>
                再開
              </button>
            )}
            {canDelete && (
              <button
                name="op"
                value="delete"
                disabled={pending}
                className={btnDanger}
                onClick={confirmClick("このアカウントを削除しますか？（論理削除・1年間保持）")}
              >
                削除
              </button>
            )}
          </>
        )}
        {status === "deleted" && canDelete && (
          <button name="op" value="restore" disabled={pending} className={btnOutline}>
            復旧
          </button>
        )}
      </form>

      {state?.tempPassword && (
        <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <div className="font-semibold">一時パスワード（{state.targetLoginId}）</div>
          <div className="mt-0.5 font-mono text-sm font-bold break-all select-all">
            {state.tempPassword}
          </div>
          <div className="mt-0.5 text-[11px]">
            この画面でのみ表示されます。必ず控えて利用者へ安全に伝達してください。
          </div>
        </div>
      )}
      {state?.message && !state.tempPassword && (
        <p className="mt-1 text-xs text-emerald-600">{state.message}</p>
      )}
      {state?.error && <p className="mt-1 text-xs text-red-600">{state.error}</p>}
    </div>
  );
}
