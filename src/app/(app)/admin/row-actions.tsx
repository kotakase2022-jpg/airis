"use client";

import { useActionState, useState } from "react";
import type { MouseEvent } from "react";
import { accountAction, updateAccountAction, type AdminActionState } from "./actions";
import { btnDanger, btnOutline, btnPrimary, btnSuccess, inputCls, labelCls } from "@/components/ui";

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
  if (state && "message" in (state as object) && (state as { message?: string }).message && closedFor !== state) {
    setClosedFor(state);
    setOpen(false);
  }

  const roleOptions: [string, string][] = hasAgency
    ? [["R7", "一次代理店管理者"], ["R8", "二次代理店管理者"]]
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
        <form action={action} className="mt-2 w-64 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
          <div className="flex gap-2">
            <button className={btnPrimary} disabled={pending}>
              {pending ? "保存中..." : "保存"}
            </button>
            <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
              キャンセル
            </button>
          </div>
          {state?.error && <p className="text-xs text-red-600">{state.error}</p>}
        </form>
      )}
      {state && "message" in (state as object) && (state as { message?: string }).message && !open && (
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
}: {
  id: string;
  status: string;
  isSelf: boolean;
  mfaEnabled?: boolean;
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

  const confirmClick =
    (msg: string) => (e: MouseEvent<HTMLButtonElement>) => {
      if (!confirm(msg)) e.preventDefault();
    };

  return (
    <div className="min-w-[190px]">
      <form action={action} className="flex flex-wrap gap-1.5">
        <input type="hidden" name="id" value={id} />
        {status === "active" && (
          <>
            <button
              name="op"
              value="suspend"
              disabled={pending}
              className={btnDanger}
              onClick={confirmClick("このアカウントを停止しますか？")}
            >
              停止
            </button>
            <button
              name="op"
              value="delete"
              disabled={pending}
              className={btnOutline}
              onClick={confirmClick("このアカウントを削除しますか？（論理削除・1年間保持）")}
            >
              削除
            </button>
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
            {mfaEnabled && (
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
            <button name="op" value="resume" disabled={pending} className={btnSuccess}>
              再開
            </button>
            <button
              name="op"
              value="delete"
              disabled={pending}
              className={btnDanger}
              onClick={confirmClick("このアカウントを削除しますか？（論理削除・1年間保持）")}
            >
              削除
            </button>
          </>
        )}
        {status === "deleted" && (
          <button name="op" value="restore" disabled={pending} className={btnOutline}>
            復旧
          </button>
        )}
      </form>

      {state?.tempPassword && (
        <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
          <div className="font-semibold">
            一時パスワード（{state.targetLoginId}）
          </div>
          <div className="mt-0.5 select-all break-all font-mono text-sm font-bold">
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
