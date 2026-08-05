"use client";

import Image from "next/image";
import { useActionState } from "react";
import { loginAction } from "../actions";
import { btnPrimary, SHARED_ACCOUNT_NOTICE_TEXT } from "@/components/ui";

// ログイン画面（発注者提供デザイン 2026-08-05 準拠）:
// Airisロゴカード → 「So-net光 販売代理店支援ポータル」見出し → 入力フォーム。
// スクロールせずにログインできることを優先し、ロゴ・余白は画面高に応じて縮める
// （ロゴカードの最大高さを vh 基準にし、縦の余白を詰める）。
export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, undefined);
  const label = "mb-1.5 block text-sm font-bold text-slate-700";
  const field =
    "w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 placeholder:text-slate-400 shadow-sm transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFBFC] px-4 py-6">
      <div className="w-full max-w-[620px]">
        {/* ロゴカード（画面が低いときはロゴを縮めてスクロールを避ける） */}
        <div className="mx-auto mb-4 w-full max-w-[400px] rounded-2xl bg-white p-4 shadow-[0_10px_32px_-14px_rgba(15,23,42,0.18)]">
          <Image
            src="/airis-logo.png"
            alt="Airis — AI Relation Insight Service"
            width={428}
            height={225}
            priority
            className="mx-auto h-auto max-h-[22vh] w-full object-contain"
          />
        </div>

        {/* 見出しは1行に収める（参照デザイン準拠。狭い画面では自動縮小） */}
        <h1 className="mb-6 text-center text-[clamp(20px,5.2vw,36px)] leading-tight font-bold tracking-tight whitespace-nowrap text-[#1B3B6F]">
          So-net光 販売代理店支援ポータル
        </h1>

        <form action={action} className="space-y-3.5">
          <div>
            <label htmlFor="loginId" className={label}>
              ログインID（Airisアカウント / 販売員ID）
            </label>
            <input
              id="loginId"
              name="loginId"
              className={field}
              autoComplete="username"
              placeholder="airis_xxx_xxx_001 / 110001C001"
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
            <p className="rounded-xl bg-red-50 px-4 py-2.5 text-sm text-red-600">{state.error}</p>
          )}
          <button className={`${btnPrimary} w-full rounded-xl py-3.5 text-base`} disabled={pending}>
            {pending ? "ログイン中..." : "ログイン"}
          </button>
        </form>

        {/* 1人1ID（共有アカウント禁止）§4.2 SEC要件① / §10.1。文言は ui.tsx の共通定数と共有する */}
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">
          {SHARED_ACCOUNT_NOTICE_TEXT}
        </p>
      </div>
    </div>
  );
}
