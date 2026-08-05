import { redirect } from "next/navigation";
import { getMfaPendingSession } from "@/lib/auth";
import { AuthBrand } from "../brand";
import { CancelLogin, VerifyForm } from "./forms";

export const dynamic = "force-dynamic";

// MFA（TOTP）コード検証画面（登録済みアカウントのログイン第2段階 §4.2）
export default async function MfaVerifyPage() {
  const pending = await getMfaPendingSession();
  if (!pending) redirect("/login");
  if (!pending.account.mfaEnabled) redirect("/mfa/setup");

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFBFC] px-4 py-10">
      <div className="w-full max-w-md">
        <AuthBrand subtitle="多要素認証（MFA）" />
        <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
          <p className="mb-1 text-center text-xs text-slate-500">{pending.account.loginId}</p>
          <p className="mb-5 text-sm leading-relaxed text-slate-600">
            認証アプリ（推奨：Google Authenticator）に表示されている6桁のコードを入力してください。
          </p>
          <VerifyForm />
          <CancelLogin />
        </div>
      </div>
    </div>
  );
}
