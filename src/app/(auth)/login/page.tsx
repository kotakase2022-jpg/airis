"use client";

import { useActionState } from "react";
import { loginAction } from "../actions";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F7FB] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-2xl font-bold text-white">
            A
          </div>
          <h1 className="text-lg font-bold text-slate-800">販売代理店支援ポータル</h1>
          <p className="mt-1 text-xs text-slate-500">Airis にログイン</p>
        </div>
        <form action={action} className="space-y-4">
          <div>
            <label className={labelCls}>ログインID（Airisアカウント / 販売員ID）</label>
            <input name="loginId" className={inputCls} autoComplete="username" required />
          </div>
          <div>
            <label className={labelCls}>パスワード</label>
            <input name="password" type="password" className={inputCls} autoComplete="current-password" required />
          </div>
          {state?.error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
          )}
          <button className={`${btnPrimary} w-full`} disabled={pending}>
            {pending ? "ログイン中..." : "ログイン"}
          </button>
        </form>
        <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-400">
          同じ権限を複数名で利用する場合も、利用者ごとに個別のアカウントを使用してください。
        </p>
      </div>
    </div>
  );
}
