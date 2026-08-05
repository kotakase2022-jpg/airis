import Image from "next/image";

// 認証画面（ログイン / MFA / パスワード変更）共通のブランドヘッダ。
// 発注者提供デザイン 2026-08-05 準拠: Airisロゴカード + サービス名見出し。
export function AuthBrand({ subtitle }: { subtitle?: string }) {
  return (
    <>
      <div className="mx-auto mb-6 w-full max-w-sm rounded-3xl bg-white p-6 shadow-[0_10px_40px_-12px_rgba(15,23,42,0.18)]">
        <Image
          src="/airis-logo.png"
          alt="Airis — AI Relation Insight Service"
          width={428}
          height={225}
          priority
          className="h-auto w-full"
        />
      </div>
      <h1 className="mb-2 text-center text-[clamp(16px,4.2vw,28px)] leading-tight font-bold tracking-tight whitespace-nowrap text-[#1B3B6F]">
        So-net光 販売代理店支援ポータル
      </h1>
      {subtitle && <p className="mb-7 text-center text-sm text-slate-500">{subtitle}</p>}
    </>
  );
}
