"use client";

import { useActionState } from "react";
import { changePasswordAction } from "../actions";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";

// パスワード変更フォーム（§4.2 初回ログイン時の強制変更 / 有効期限切れの変更）。
// 桁数の説明文はサーバ側のポリシー（環境変数で変更可能。src/lib/password-policy.ts）から受け取る。
export function ChangePasswordForm({
  minLengthAdmin,
  minLengthGeneral,
}: {
  minLengthAdmin: number;
  minLengthGeneral: number;
}) {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  return (
    <>
      <p className="mb-5 text-xs leading-relaxed text-slate-500">
        初回ログイン時は初期パスワードからの変更が必要です。管理者アカウントは{minLengthAdmin}
        桁以上、一般アカウントは{minLengthGeneral}桁以上（大文字・小文字・数字を含む）。
      </p>
      <form action={action} className="space-y-4">
        <div>
          <label className={labelCls}>現在のパスワード</label>
          <input name="current" type="password" className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>新しいパスワード</label>
          <input name="next" type="password" className={inputCls} required />
        </div>
        <div>
          <label className={labelCls}>新しいパスワード（確認）</label>
          <input name="confirm" type="password" className={inputCls} required />
        </div>
        {state?.error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
        )}
        <button className={`${btnPrimary} w-full`} disabled={pending}>
          {pending ? "変更中..." : "変更する"}
        </button>
      </form>
    </>
  );
}
