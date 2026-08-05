import { describe, it, expect } from "vitest";
import {
  UNKNOWN_IP,
  pickTrustedHop,
  resolveTrustedIp,
  ipTrustConfigFromEnv,
  type IpTrustConfig,
} from "@/lib/client-ip";

// Headers 互換の最小スタブ（大文字小文字を区別しない）
function h(map: Record<string, string>): { get(name: string): string | null } {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

const OFF: IpTrustConfig = { trustProxy: false, trustVercelHeaders: false, hops: 1 };
const PROXY: IpTrustConfig = { trustProxy: true, trustVercelHeaders: false, hops: 1 };
const VERCEL: IpTrustConfig = { trustProxy: false, trustVercelHeaders: true, hops: 1 };

describe("§10.1 接続元IPの信頼モデル（既定は fail-closed）", () => {
  it("既定（TRUST_PROXY/TRUST_VERCEL_HEADERS いずれも未設定）では x-forwarded-for を信頼しない", () => {
    expect(resolveTrustedIp(h({ "x-forwarded-for": "203.0.113.77" }), OFF)).toBe(UNKNOWN_IP);
    expect(resolveTrustedIp(h({ "x-forwarded-for": "203.0.113.1, 198.51.100.9" }), OFF)).toBe(
      UNKNOWN_IP
    );
  });

  it("既定では x-vercel-forwarded-for も信頼しない（Vercel以外ではクライアントが偽装できる）", () => {
    expect(resolveTrustedIp(h({ "x-vercel-forwarded-for": "10.9.9.9" }), OFF)).toBe(UNKNOWN_IP);
    expect(
      resolveTrustedIp(
        h({ "x-vercel-forwarded-for": "10.9.9.9", "x-forwarded-for": "10.9.9.9" }),
        OFF
      )
    ).toBe(UNKNOWN_IP);
  });

  it("ヘッダが無い場合は unknown", () => {
    expect(resolveTrustedIp(h({}), OFF)).toBe(UNKNOWN_IP);
    expect(resolveTrustedIp(h({}), PROXY)).toBe(UNKNOWN_IP);
    expect(resolveTrustedIp(h({}), VERCEL)).toBe(UNKNOWN_IP);
  });
});

describe("TRUST_PROXY=true のとき x-forwarded-for の末尾hopのみ信頼する", () => {
  it("先頭の偽装値ではなく末尾hopを採用する", () => {
    expect(resolveTrustedIp(h({ "x-forwarded-for": "203.0.113.1, 198.51.100.9" }), PROXY)).toBe(
      "198.51.100.9"
    );
  });

  it("偽装プレフィクスを増やしても末尾hopは変わらない", () => {
    expect(
      resolveTrustedIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3, 198.51.100.9" }), PROXY)
    ).toBe("198.51.100.9");
  });

  it("要素が1個（プロキシ未経由の可能性）でも hops=1 なら末尾＝その値を採用する", () => {
    expect(resolveTrustedIp(h({ "x-forwarded-for": "198.51.100.9" }), PROXY)).toBe("198.51.100.9");
  });

  it("hops=2 のとき末尾から2番目を採用し、要素不足なら unknown", () => {
    const twoHops: IpTrustConfig = { ...PROXY, hops: 2 };
    expect(
      resolveTrustedIp(h({ "x-forwarded-for": "spoof, 198.51.100.9, 10.0.0.1" }), twoHops)
    ).toBe("198.51.100.9");
    expect(resolveTrustedIp(h({ "x-forwarded-for": "198.51.100.9" }), twoHops)).toBe(UNKNOWN_IP);
  });

  it("TRUST_PROXY=true でも x-vercel-forwarded-for は採用しない", () => {
    expect(resolveTrustedIp(h({ "x-vercel-forwarded-for": "10.9.9.9" }), PROXY)).toBe(UNKNOWN_IP);
  });
});

describe("TRUST_VERCEL_HEADERS=true（VERCEL=1）のとき x-vercel-forwarded-for を信頼する", () => {
  it("末尾hopを採用する（多段でも耐偽装）", () => {
    expect(
      resolveTrustedIp(h({ "x-vercel-forwarded-for": "spoof, 198.51.100.9" }), VERCEL)
    ).toBe("198.51.100.9");
    expect(resolveTrustedIp(h({ "x-vercel-forwarded-for": "198.51.100.9" }), VERCEL)).toBe(
      "198.51.100.9"
    );
  });

  it("TRUST_VERCEL_HEADERSのみ有効な場合、x-forwarded-forは無視する", () => {
    expect(resolveTrustedIp(h({ "x-forwarded-for": "203.0.113.77" }), VERCEL)).toBe(UNKNOWN_IP);
  });
});

describe("pickTrustedHop", () => {
  it("空・空白のみのヘッダは null", () => {
    expect(pickTrustedHop("", 1)).toBeNull();
    expect(pickTrustedHop("  ,  ", 1)).toBeNull();
  });

  it("空白を取り除いて解釈する", () => {
    expect(pickTrustedHop("  1.1.1.1 ,  2.2.2.2  ", 1)).toBe("2.2.2.2");
  });
});

describe("ipTrustConfigFromEnv", () => {
  it("未設定ならすべて無効・hops=1", () => {
    expect(ipTrustConfigFromEnv({})).toEqual({
      trustProxy: false,
      trustVercelHeaders: false,
      hops: 1,
    });
  });

  it("VERCEL=1 で Vercelヘッダ信頼が自動的に有効になる", () => {
    expect(ipTrustConfigFromEnv({ VERCEL: "1" }).trustVercelHeaders).toBe(true);
  });

  it('TRUST_PROXY は文字列 "true" のみ有効（"1" や "yes" は無効）', () => {
    expect(ipTrustConfigFromEnv({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(ipTrustConfigFromEnv({ TRUST_PROXY: "1" }).trustProxy).toBe(false);
    expect(ipTrustConfigFromEnv({ TRUST_PROXY: "yes" }).trustProxy).toBe(false);
  });

  it("TRUSTED_PROXY_HOPS は1未満・非数値なら1に丸める", () => {
    expect(ipTrustConfigFromEnv({ TRUSTED_PROXY_HOPS: "3" }).hops).toBe(3);
    expect(ipTrustConfigFromEnv({ TRUSTED_PROXY_HOPS: "0" }).hops).toBe(1);
    expect(ipTrustConfigFromEnv({ TRUSTED_PROXY_HOPS: "abc" }).hops).toBe(1);
  });
});

// 要件1-9: 不正利用検知のIPシグナルは、信頼できないIP（UNKNOWN_IP）を除外して判定する。
// 除外しないと (a) IP信頼が無効な環境では全件同値で検知が沈黙し、
// (b) 一部リクエストのみヘッダ欠落だと「別IP」と誤判定して誤発報する。
describe("要件1-9 IPシグナルからのセンチネル除外", () => {
  type Row = { ip: string | null };
  // src/app/api/cron/daily/route.ts と同じフィルタ条件
  const usableIps = (rows: Row[]) =>
    rows.filter((r) => r.ip && r.ip !== UNKNOWN_IP).map((r) => r.ip!);

  it("unknown のみのログからは有効IPが得られない（検知が誤発報しない）", () => {
    const rows: Row[] = [{ ip: UNKNOWN_IP }, { ip: UNKNOWN_IP }, { ip: UNKNOWN_IP }];
    expect(usableIps(rows)).toEqual([]);
    expect(new Set(usableIps(rows)).size, "複数IP検知は発火しない").toBe(0);
  });

  it("実IPとunknownが混在しても、unknownを別IPとして数えない", () => {
    const rows: Row[] = [
      { ip: "203.0.113.10" },
      { ip: UNKNOWN_IP },
      { ip: "203.0.113.10" },
      { ip: null },
    ];
    expect(new Set(usableIps(rows)).size, "実IPは1種類として扱う").toBe(1);
  });

  it("異なる実IPが3種類あれば複数IP検知の閾値に達する", () => {
    const rows: Row[] = [
      { ip: "203.0.113.1" },
      { ip: "203.0.113.2" },
      { ip: UNKNOWN_IP },
      { ip: "203.0.113.3" },
    ];
    expect(new Set(usableIps(rows)).size).toBe(3);
  });
});
