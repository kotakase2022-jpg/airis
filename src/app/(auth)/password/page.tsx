"use client";

import { useActionState } from "react";
import { changePasswordAction } from "../actions";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";

export default function PasswordPage() {
  const [state, action, pending] = useActionState(changePasswordAction, undefined);
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F7FB] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-lg font-bold text-slate-800">パスワードの変更</h1>
        <p className="mb-5 text-xs leading-relaxed text-slate-500">
          初回ログイン時は初期パスワードからの変更が必要です。管理者アカウントは20桁以上、一般アカウントは14桁以上（大文字・小文字・数字を含む）。
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
      </div>
    </div>
  );
}
