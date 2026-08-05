"use client";

import Image from "next/image";
import { useActionState } from "react";
import { loginAction } from "../actions";
import { btnPrimary } from "@/components/ui";

// ログイン画面（発注者提供デザイン 2026-08-05 準拠）:
// Airisロゴカード → 「So-net光 販売代理店支援ポータル」見出し → 入力フォーム
export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  const label = "mb-2 block text-sm font-bold text-slate-700";
  const field =
    "w-full rounded-2xl border border-slate-200 bg-white px-5 py-4 text-base text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFBFC] px-4 py-10">
      <div className="w-full max-w-[620px]">
        {/* ロゴカード */}
        <div className="mx-auto mb-7 w-full max-w-[450px] rounded-3xl bg-white p-6 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.18)]">
          <Image
            src="/airis-logo.png"
            alt="Airis — AI Relation Insight Service"
            width={428}
            height={225}
            priority
            className="h-auto w-full"
          />
        </div>

        {/* 見出しは1行に収める（参照デザイン準拠。狭い画面では自動縮小） */}
        <h1 className="mb-9 whitespace-nowrap text-center text-[clamp(20px,5.4vw,38px)] font-bold leading-tight tracking-tight text-[#1B3B6F]">
          So-net光 販売代理店支援ポータル
        </h1>

        <form action={action} className="space-y-5">
          <div>
            <label htmlFor="loginId" className={label}>
              メールアドレス / ユーザーID
            </label>
            <input
              id="loginId"
              name="loginId"
              className={field}
              autoComplete="username"
              placeholder="user@example.com"
              required
            />
          </div>
          <div>
            <label htmlFor="password" className={label}>
              パスワード
            </label>
            <input
              id="password"
              name="password"
              type="password"
              className={field}
              autoComplete="current-password"
              placeholder="••••••••"
              required
            />
          </div>
          {state?.error && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600">{state.error}</p>
          )}
          <button className={`${btnPrimary} w-full rounded-2xl py-4 text-base`} disabled={pending}>
            {pending ? "ログイン中..." : "ログイン"}
          </button>
        </form>

        <p className="mt-6 text-center text-xs leading-relaxed text-slate-400">
          同じ権限を複数名で利用する場合も、利用者ごとに個別のアカウントを使用してください。
        </p>
      </div>
    </div>
  );
}
