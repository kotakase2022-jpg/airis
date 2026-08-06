// アプリ設定（§10.1 管理系画面のIP許可リスト / SEC-10.1-15）の単体テスト。
//
// 経緯（QA loop5 の独立監査で検出）:
//   docs/SEC_CHECKLIST.md の SEC-10.1-15 が検証証跡として `tests/unit/settings.test.ts` を
//   挙げていたが、**このファイルは存在しなかった**。存在しないテストを根拠に「実装済み」と
//   記録していた。加えて、SEC-10.1-15 の主張の中核である
//   **値の解決順（DB → 環境変数 → 既定値）と、DBが読めないときの fail-closed** は
//   単体テストで固定されていなかった（tests/unit/trusted-ip.test.ts はIPの信頼モデルのみ）。
//   本ファイルはその穴を埋める。
//
// 特にここで守りたいのは **防御機構を黙って無効化しないこと**:
//   許可リストが設定されているのにDBが読めない場合、「未設定＝制御無効」と区別できない。
//   このとき許可へ倒すと、DB障害がIP制限の全解除になる。実装は拒否へ倒す（fail-closed）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findUnique = vi.fn();
const headerStore = { value: new Headers() };

vi.mock("@/lib/prisma", () => ({
  prisma: { appSetting: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
vi.mock("next/headers", () => ({ headers: async () => headerStore.value }));
// 監査ログはDBを伴うためこのテストの対象外（setSetting の監査記録は e2e/zz-qa3-regression.spec.ts）
vi.mock("@/lib/util", () => ({
  audit: vi.fn().mockResolvedValue("audit-id"),
  today: () => "2026-08-06",
}));

import {
  ADMIN_IP_ALLOWLIST_KEY,
  SETTING_DEFINITIONS,
  getSettingWithSource,
  isAdminIpAllowedFromSettings,
  normalizeCsvList,
  validateIpAllowlist,
} from "@/lib/settings";

const ENV_VAR = "ADMIN_IP_ALLOWLIST";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  findUnique.mockReset();
  headerStore.value = new Headers();
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
});

describe("normalizeCsvList（保存前の正規化）", () => {
  it("空白を除き、空要素を落として詰める", () => {
    expect(normalizeCsvList(" 203.0.113.1 , 198.51.100.2 ")).toBe("203.0.113.1,198.51.100.2");
    expect(normalizeCsvList("203.0.113.1,,198.51.100.2,")).toBe("203.0.113.1,198.51.100.2");
  });

  it("空文字・空白のみは空になる（＝許可リスト無効）", () => {
    expect(normalizeCsvList("")).toBe("");
    expect(normalizeCsvList("   ,  , ")).toBe("");
  });
});

describe("validateIpAllowlist（不正な許可リストを保存させない）", () => {
  it("空は有効（許可リストによる制御を無効化する明示的な設定）", () => {
    expect(validateIpAllowlist("")).toBeNull();
  });

  it("IPv4・IPv6の羅列は有効", () => {
    expect(validateIpAllowlist("203.0.113.1")).toBeNull();
    expect(validateIpAllowlist("203.0.113.1,198.51.100.2")).toBeNull();
    expect(validateIpAllowlist("2001:db8::1")).toBeNull();
  });

  it("CIDR表記は未対応として明示的に拒否する（黙って1IP扱いにしない）", () => {
    const err = validateIpAllowlist("203.0.113.0/24");
    expect(err).not.toBeNull();
    expect(err).toContain("CIDR");
  });

  it("IPの形式が不正なら拒否する", () => {
    expect(validateIpAllowlist("not-an-ip")).not.toBeNull();
    expect(validateIpAllowlist("203.0.113.999")).not.toBeNull();
    // 1件でも不正なら全体を拒否する（部分適用で穴が空くのを防ぐ）
    expect(validateIpAllowlist("203.0.113.1,not-an-ip")).not.toBeNull();
  });

  it("重複を拒否する", () => {
    const err = validateIpAllowlist("203.0.113.1,203.0.113.1");
    expect(err).not.toBeNull();
    expect(err).toContain("重複");
  });
});

describe("設定定義の結線（SETTING_DEFINITIONS）", () => {
  it("IP許可リストが環境変数 ADMIN_IP_ALLOWLIST と対応し、正規化・検証が結線されている", () => {
    const def = SETTING_DEFINITIONS[ADMIN_IP_ALLOWLIST_KEY];
    expect(def.envVar, "環境変数名が変わると既存環境の設定が黙って無効になる").toBe(ENV_VAR);
    expect(def.defaultValue).toBe("");
    // 「定義はあるが呼ばれていない」を防ぐ（loop3/loop4 で繰り返した欠陥型）
    expect(def.normalize(" 203.0.113.1 ")).toBe("203.0.113.1");
    expect(def.validate("203.0.113.0/24")).not.toBeNull();
  });
});

describe("値の解決順（DB → 環境変数 → 既定値）", () => {
  it("DBに行があればDBを採用する（環境変数より優先＝再デプロイなしで変更できる）", async () => {
    process.env[ENV_VAR] = "198.51.100.2";
    findUnique.mockResolvedValue({ value: "203.0.113.1", updatedBy: "airis_snc_adm_001" });
    const r = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
    expect(r.value).toBe("203.0.113.1");
    expect(r.source).toBe("db");
    expect(r.updatedBy).toBe("airis_snc_adm_001");
  });

  it("DBに行が無ければ環境変数を採用する（既存環境との互換）", async () => {
    process.env[ENV_VAR] = "198.51.100.2";
    findUnique.mockResolvedValue(null);
    const r = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
    expect(r.value).toBe("198.51.100.2");
    expect(r.source).toBe("env");
    expect(r.dbUnavailable).toBe(false);
  });

  it("空文字の環境変数は「未設定」として扱い既定値へ落ちる", async () => {
    process.env[ENV_VAR] = "";
    findUnique.mockResolvedValue(null);
    const r = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
    expect(r.value).toBe("");
    expect(r.source).toBe("default");
  });

  it("DBも環境変数も無ければ既定値（空＝制御無効）", async () => {
    findUnique.mockResolvedValue(null);
    const r = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
    expect(r.source).toBe("default");
    expect(r.value).toBe("");
  });

  it("DB読み出しが失敗しても環境変数へフォールバックし、失敗を dbUnavailable で伝える", async () => {
    process.env[ENV_VAR] = "198.51.100.2";
    findUnique.mockRejectedValue(new Error("connection refused"));
    const r = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
    expect(r.value).toBe("198.51.100.2");
    expect(r.source).toBe("env");
    expect(r.dbUnavailable, "DB障害を呼び出し側へ伝えないと fail-closed に倒せない").toBe(true);
  });
});

describe("IP許可リストの判定（isAdminIpAllowedFromSettings / fail-closed）", () => {
  const trustedHeaders = () => {
    process.env.TRUST_PROXY = "true";
    return new Headers({ "x-forwarded-for": "203.0.113.1" });
  };

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it("許可リスト未設定なら制御無効で許可する", async () => {
    findUnique.mockResolvedValue(null);
    const r = await isAdminIpAllowedFromSettings();
    expect(r.allowed).toBe(true);
  });

  it("**DBが読めず許可リストも取れない場合は拒否する（fail-closed）**", async () => {
    findUnique.mockRejectedValue(new Error("connection refused"));
    const r = await isAdminIpAllowedFromSettings();
    expect(
      r.allowed,
      "DB障害がIP許可リストの全解除になっています（防御機構の黙示的な無効化）"
    ).toBe(false);
  });

  it("許可リストに接続元IPが含まれていれば許可する", async () => {
    headerStore.value = trustedHeaders();
    findUnique.mockResolvedValue({ value: "203.0.113.1,198.51.100.2", updatedBy: null });
    const r = await isAdminIpAllowedFromSettings();
    expect(r.allowed).toBe(true);
    expect(r.ip).toBe("203.0.113.1");
  });

  it("許可リストに含まれないIPは拒否する", async () => {
    headerStore.value = trustedHeaders();
    findUnique.mockResolvedValue({ value: "198.51.100.2", updatedBy: null });
    const r = await isAdminIpAllowedFromSettings();
    expect(r.allowed).toBe(false);
    expect(r.ip).toBe("203.0.113.1");
  });

  it("**接続元IPを信頼できない場合は拒否する（fail-closed）**", async () => {
    // TRUST_PROXY 未設定 → x-forwarded-for は信頼しない → unknown
    headerStore.value = new Headers({ "x-forwarded-for": "203.0.113.1" });
    findUnique.mockResolvedValue({ value: "203.0.113.1", updatedBy: null });
    const r = await isAdminIpAllowedFromSettings();
    expect(r.allowed, "偽装可能なヘッダで許可リストを通過できています").toBe(false);
  });

  it("部分一致では通さない（前方一致・部分文字列の取りこぼし防止）", async () => {
    headerStore.value = trustedHeaders();
    // "203.0.113.1" は "203.0.113.10" の部分文字列。includes による誤許可を防ぐ
    findUnique.mockResolvedValue({ value: "203.0.113.10", updatedBy: null });
    const r = await isAdminIpAllowedFromSettings();
    expect(r.allowed).toBe(false);
  });

  it("環境変数だけに許可リストがある場合も判定に使われる", async () => {
    headerStore.value = trustedHeaders();
    process.env[ENV_VAR] = "203.0.113.1";
    findUnique.mockResolvedValue(null);
    expect((await isAdminIpAllowedFromSettings()).allowed).toBe(true);
    process.env[ENV_VAR] = "198.51.100.2";
    expect((await isAdminIpAllowedFromSettings()).allowed).toBe(false);
  });
});
