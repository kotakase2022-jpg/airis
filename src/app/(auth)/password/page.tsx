import { passwordPolicy } from "@/lib/password-policy";
import { SingleUserNotice } from "@/components/ui";
import { ChangePasswordForm } from "./form";

export const dynamic = "force-dynamic";

// パスワード変更画面（§4.2）。桁数はロール別ポリシー（環境変数で変更可能 §10.1）を
// サーバ側で解決して表示する。ハードコードした桁数を画面に書かない。
export default async function PasswordPage() {
  const policy = passwordPolicy();
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F5F7FB] p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="mb-2 text-lg font-bold text-slate-800">パスワードの変更</h1>
        <ChangePasswordForm
          minLengthAdmin={policy.minLengthAdmin}
          minLengthGeneral={policy.minLengthGeneral}
        />
        {/* 1人1ID（共有アカウント禁止）§4.2 SEC要件① */}
        <SingleUserNotice className="mt-5" />
      </div>
    </div>
  );
}
