// 接続元IPの解決（§10.1 / X-Forwarded-For 偽装対策）
//
// クライアントは x-forwarded-for / x-vercel-forwarded-for を自由に偽装できるため、
// **実行環境がそのヘッダを付与すると分かっている場合のみ** 信頼する（オプトイン）。
// 信頼できるIPが決定できない場合は UNKNOWN_IP を返し、呼び出し側（IP許可リスト）は
// fail-closed で拒否する。
//
// 環境変数:
//   TRUST_PROXY=true           … リバースプロキシ配下で x-forwarded-for を信頼する
//   TRUST_VERCEL_HEADERS=true  … x-vercel-forwarded-for を信頼する（VERCEL=1 でも自動的に有効）
//   TRUSTED_PROXY_HOPS=n       … 信頼できるプロキシの段数（既定1）
//
// server-only を import しないため単体テスト可能（tests/unit/trusted-ip.test.ts）。

export const UNKNOWN_IP = "unknown";

export type IpTrustConfig = {
  trustProxy: boolean;
  trustVercelHeaders: boolean;
  hops: number;
};

export function ipTrustConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): IpTrustConfig {
  const hops = Math.max(1, Math.trunc(Number(env.TRUSTED_PROXY_HOPS)) || 1);
  return {
    trustProxy: env.TRUST_PROXY === "true",
    trustVercelHeaders: env.VERCEL === "1" || env.TRUST_VERCEL_HEADERS === "true",
    hops,
  };
}

// 信頼できるプロキシは「自分が見た接続元」を末尾へ追記するため、末尾の hops 個だけが
// プロキシ由来（偽装不可）。実クライアントIPはそのうち最も左＝末尾から hops 番目。
// 要素数が hops に満たない＝想定した段数のプロキシを経ていない → 信頼できる値なし。
export function pickTrustedHop(headerValue: string, hops: number): string | null {
  const list = headerValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length < hops) return null;
  return list[list.length - hops] ?? null;
}

type HeaderLike = { get(name: string): string | null };

export function resolveTrustedIp(h: HeaderLike, config: IpTrustConfig): string {
  if (config.trustVercelHeaders) {
    const vercel = h.get("x-vercel-forwarded-for");
    if (vercel) {
      const ip = pickTrustedHop(vercel, config.hops);
      if (ip) return ip;
    }
  }
  if (config.trustProxy) {
    const fwd = h.get("x-forwarded-for");
    if (fwd) {
      const ip = pickTrustedHop(fwd, config.hops);
      if (ip) return ip;
    }
  }
  return UNKNOWN_IP;
}

export function trustedIpFrom(h: HeaderLike): string {
  return resolveTrustedIp(h, ipTrustConfigFromEnv());
}
