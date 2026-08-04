"use client";

import { useActionState } from "react";
import type { MouseEvent } from "react";
import { accountAction, type AdminActionState } from "./actions";
import { btnDanger, btnOutline, btnSuccess } from "@/components/ui";

// アカウント行の操作ボタン群（状態依存）+ 一時パスワードのインライン一回表示
export function AccountRowActions({
  id,
  status,
  isSelf,
}: {
  id: string;
  status: string;
  isSelf: boolean;
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
