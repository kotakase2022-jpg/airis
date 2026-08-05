"use client";

// MFA（TOTP）のコード入力フォーム（登録確認 / ログイン時検証）§4.2

import { useActionState } from "react";
import { enrollMfaAction, logoutAction, verifyMfaAction } from "../actions";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";

function CodeForm({
  action,
  submitLabel,
}: {
  action: typeof enrollMfaAction;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label className={labelCls}>認証コード（6桁）</label>
        <input
          name="code"
          className={`${inputCls} text-center tracking-[0.3em]`}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          autoComplete="one-time-code"
          autoFocus
          required
        />
      </div>
      {state?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
      )}
      <button className={`${btnPrimary} w-full`} disabled={pending}>
        {pending ? "確認中..." : submitLabel}
      </button>
    </form>
  );
}

export function EnrollForm() {
  return <CodeForm action={enrollMfaAction} submitLabel="登録して続行" />;
}

export function VerifyForm() {
  return <CodeForm action={verifyMfaAction} submitLabel="認証する" />;
}

export function CancelLogin() {
  return (
    <form action={logoutAction} className="mt-4 text-center">
      <button className="text-xs text-slate-400 hover:underline">
        ログインからやり直す
      </button>
    </form>
  );
}
