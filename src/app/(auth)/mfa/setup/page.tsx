import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser, getMfaPendingSession } from "@/lib/auth";
import { basePrisma } from "@/lib/prisma-base";
import { generateMfaSecret, mfaQrDataUrl } from "@/lib/mfa";
import { AuthBrand } from "../../brand";
import { CancelLogin, EnrollForm } from "../forms";

export const dynamic = "force-dynamic";

// MFA（TOTP）登録画面（§4.2）。
// ①〜⑧⑩は初回ログイン時に必須登録（mfaPendingセッション）、⑨は任意登録（通常セッション）。
export default async function MfaSetupPage() {
  const pending = await getMfaPendingSession();
  let loginId: string;
  let accountId: string;
  let secret: string | null;
  let voluntary = false;

  if (pending) {
    if (pending.account.mfaEnabled) redirect("/mfa");
    loginId = pending.account.loginId;
    accountId = pending.account.id;
    secret = pending.account.mfaSecret;
  } else {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    if (user.mfaEnabled) redirect("/dashboard"); // 再登録は管理者によるMFAリセット後のみ
    const account = await basePrisma.account.findUnique({ where: { id: user.id } });
    if (!account) redirect("/login");
    loginId = account.loginId;
    accountId = account.id;
    secret = account.mfaSecret;
    voluntary = true;
  }

  // 秘密鍵は未発行時のみ生成（リロードしてもQRが変わらないように保持する）
  if (!secret) {
    secret = generateMfaSecret();
    await basePrisma.account.update({ where: { id: accountId }, data: { mfaSecret: secret } });
  }
  const qr = await mfaQrDataUrl(loginId, secret);

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFBFC] px-4 py-10">
      <div className="w-full max-w-md">
        <AuthBrand subtitle="多要素認証（MFA）の登録" />
        <div className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm">
          <p className="mb-4 text-center text-xs text-slate-500">{loginId}</p>
          <ol className="mb-4 list-decimal space-y-1 pl-5 text-xs leading-relaxed text-slate-600">
            <li>
              スマートフォンの認証アプリ（
              <span className="font-bold">推奨：Google Authenticator</span>
              ）で下のQRコードを読み取ってください。
            </li>
            <li>アプリに表示される6桁のコードを入力して登録を完了してください。</li>
          </ol>
          <div className="mb-3 flex justify-center rounded-xl border border-slate-200 bg-white p-3">
            {/* QRコードはサーバー側で生成した data URL（外部リクエストなし） */}
            <Image src={qr} alt="MFA登録用QRコード" width={220} height={220} unoptimized />
          </div>
          <p className="mb-4 text-center text-[11px] break-all text-slate-400">
            読み取れない場合はキーを手入力:{" "}
            <code data-testid="mfa-secret" className="font-mono text-slate-500">
              {secret}
            </code>
          </p>
          <EnrollForm />
          {voluntary ? (
            <p className="mt-4 text-center text-[11px] text-slate-400">
              登録を中止する場合はブラウザの「戻る」でダッシュボードへ戻れます。
            </p>
          ) : (
            <CancelLogin />
          )}
        </div>
      </div>
    </div>
  );
}
