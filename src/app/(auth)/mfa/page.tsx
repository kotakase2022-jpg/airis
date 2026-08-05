import { redirect } from "next/navigation";
import { getMfaPendingSession } from "@/lib/auth";
import { CancelLogin, VerifyForm } from "./forms";

export const dynamic = "force-dynamic";

// MFA（TOTP）コード検証画面（登録済みアカウントのログイン第2段階 §4.2）
export default async function MfaVerifyPage() {
  const pending = await getMfaPendingSession();
  if (!pending) redirect("/login");
  if (!pending.account.mfaEnabled) redirect("/mfa/setup");

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F7FB] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-5 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-2xl font-bold text-white">
            A
          </div>
          <h1 className="text-lg font-bold text-slate-800">多要素認証（MFA）</h1>
          <p className="mt-1 text-xs text-slate-500">{pending.account.loginId}</p>
        </div>
        <p className="mb-4 text-xs leading-relaxed text-slate-600">
          認証アプリ（推奨：Google Authenticator）に表示されている6桁のコードを入力してください。
        </p>
        <VerifyForm />
        <CancelLogin />
      </div>
    </div>
  );
}
