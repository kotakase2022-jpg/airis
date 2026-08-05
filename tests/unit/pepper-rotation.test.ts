// ペッパーのバージョンID管理とローテーション（§10.3 / SEC②#42 / SEC-021）
// 「暗号鍵・シークレットは年1回以上の交換を前提に設計する: ペッパーはバージョンID付きで保持し、
// ログイン成功時に新バージョンで再ハッシュする」の実装（src/lib/pepper.ts）を検証する。
//
// 最重要: **V1→V2 の切替で既存ユーザーがログイン不能にならないこと**（下の describe を参照）。
import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  DEFAULT_PEPPER_VERSION,
  activePepperVersion,
  currentPepper,
  currentPepperVersion,
  hashPasswordWithVersion,
  knownPepperVersions,
  normalizePepperVersion,
  pepperCandidates,
  pepperEnvName,
  pepperValue,
  prehash,
  verifyPasswordWithPepper,
  type PepperEnv,
} from "@/lib/pepper";

const PW = "Airis-Rotation-Test-2026!x"; // 20桁以上（管理者ポリシーでも通る長さ）

// 環境変数セット（テストは process.env を汚さず、引数で env を渡して検証する）
const ENV_NONE: PepperEnv = {}; // ペッパー未設定（導入前）
const ENV_V1: PepperEnv = { PASSWORD_PEPPER_V1: "pepper-value-v1" };
const ENV_V1_V2: PepperEnv = {
  PASSWORD_PEPPER_V1: "pepper-value-v1",
  PASSWORD_PEPPER_V2: "pepper-value-v2",
  CURRENT_PEPPER_KEY: "v2",
};
const ENV_V2_ONLY: PepperEnv = {
  PASSWORD_PEPPER_V2: "pepper-value-v2",
  CURRENT_PEPPER_KEY: "v2",
};

describe("バージョンIDの解決", () => {
  it("CURRENT_PEPPER_KEY 未設定なら v1（従来実装と同じ PASSWORD_PEPPER_V1 を使う）", () => {
    expect(currentPepperVersion(ENV_V1)).toBe(DEFAULT_PEPPER_VERSION);
    expect(currentPepperVersion(ENV_V1)).toBe("v1");
    expect(currentPepper(ENV_V1)).toBe("pepper-value-v1");
  });

  it("CURRENT_PEPPER_KEY は 'v2' / 'V2' / 'PASSWORD_PEPPER_V2' のいずれの表記でも受け付ける", () => {
    for (const raw of ["v2", "V2", " v2 ", "PASSWORD_PEPPER_V2", "password_pepper_v2"]) {
      expect(currentPepperVersion({ ...ENV_V1_V2, CURRENT_PEPPER_KEY: raw })).toBe("v2");
      expect(currentPepper({ ...ENV_V1_V2, CURRENT_PEPPER_KEY: raw })).toBe("pepper-value-v2");
    }
  });

  it("バージョンID ⇔ 環境変数名の対応", () => {
    expect(pepperEnvName("v2")).toBe("PASSWORD_PEPPER_V2");
    expect(pepperEnvName("PASSWORD_PEPPER_V3")).toBe("PASSWORD_PEPPER_V3");
    expect(normalizePepperVersion("PASSWORD_PEPPER_V10")).toBe("v10");
    expect(pepperValue("v1", ENV_V1_V2)).toBe("pepper-value-v1");
    expect(pepperValue("v9", ENV_V1_V2)).toBe(""); // 未設定は空（ペッパー無し扱い）
    expect(pepperValue(null, ENV_V1_V2)).toBe("");
  });

  it("ペッパー未設定なら活性バージョンは null（Account.pepperVersion も null）", () => {
    expect(activePepperVersion(ENV_NONE)).toBeNull();
    expect(activePepperVersion(ENV_V1)).toBe("v1");
    expect(activePepperVersion(ENV_V1_V2)).toBe("v2");
  });

  it("既知バージョンは現行を先頭に、以降は新しい順に並ぶ", () => {
    expect(knownPepperVersions(ENV_V1_V2)).toEqual(["v2", "v1"]);
    expect(
      knownPepperVersions({
        PASSWORD_PEPPER_V1: "a",
        PASSWORD_PEPPER_V2: "b",
        PASSWORD_PEPPER_V10: "c",
        CURRENT_PEPPER_KEY: "v2",
      })
    ).toEqual(["v2", "v10", "v1"]);
    expect(knownPepperVersions(ENV_NONE)).toEqual([]);
  });

  it("照合順序は ①アカウントのバージョン → ②他の既知バージョン → ③ペッパーなし", () => {
    expect(pepperCandidates("v1", ENV_V1_V2).map((c) => c.version)).toEqual(["v1", "v2", null]);
    expect(pepperCandidates(null, ENV_V1_V2).map((c) => c.version)).toEqual(["v2", "v1", null]);
    // 記録されたバージョンが撤去済み（環境変数に値が無い）なら飛ばす
    expect(pepperCandidates("v1", ENV_V2_ONLY).map((c) => c.version)).toEqual(["v2", null]);
    expect(pepperCandidates(null, ENV_NONE).map((c) => c.version)).toEqual([null]);
  });
});

describe("ハッシュ生成", () => {
  it("現行バージョンのペッパーで生成し、適用したバージョンIDを返す", () => {
    const v1 = hashPasswordWithVersion(PW, ENV_V1);
    expect(v1.pepperVersion).toBe("v1");
    expect(v1.hash.startsWith("$argon2id$")).toBe(true); // §2 Argon2id
    const v2 = hashPasswordWithVersion(PW, ENV_V1_V2);
    expect(v2.pepperVersion).toBe("v2");
    // ソルトが自動生成されるため、同じパスワード・同じペッパーでもハッシュは毎回異なる
    expect(hashPasswordWithVersion(PW, ENV_V1).hash).not.toBe(v1.hash);
  });

  it("ペッパー未設定でも生成でき、バージョンIDは null", () => {
    const none = hashPasswordWithVersion(PW, ENV_NONE);
    expect(none.pepperVersion).toBeNull();
    expect(verifyPasswordWithPepper(PW, none.hash, null, ENV_NONE)).toEqual({
      ok: true,
      needsRehash: false,
      pepperVersion: null,
    });
  });
});

describe("V1→V2 切替で既存ユーザーがログイン不能にならないこと（SEC-021の主題）", () => {
  it("V1で作られたハッシュは、現行がV2でもログインでき needsRehash=true になる", () => {
    // 切替前: V1でハッシュを作成（Account.pepperVersion = "v1"）
    const stored = hashPasswordWithVersion(PW, ENV_V1);
    expect(stored.pepperVersion).toBe("v1");

    // 切替後（PASSWORD_PEPPER_V2 追加 + CURRENT_PEPPER_KEY=v2）: そのままログインできる
    const r = verifyPasswordWithPepper(PW, stored.hash, stored.pepperVersion, ENV_V1_V2);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(true); // 現行(V2)ではないので再ハッシュ対象
    expect(r.pepperVersion).toBe("v1"); // 一致したのは旧バージョン

    // ログイン成功時の再ハッシュ後は、現行バージョンで一致し再ハッシュ不要になる
    const rehashed = hashPasswordWithVersion(PW, ENV_V1_V2);
    expect(rehashed.pepperVersion).toBe("v2");
    expect(verifyPasswordWithPepper(PW, rehashed.hash, rehashed.pepperVersion, ENV_V1_V2)).toEqual({
      ok: true,
      needsRehash: false,
      pepperVersion: "v2",
    });
  });

  it("Account.pepperVersion が未記録（null）でもV1ハッシュと照合できる", () => {
    // ペッパー導入初期に作られた行や、pepperVersion を保存しない経路で作られた行の互換性。
    const stored = hashPasswordWithVersion(PW, ENV_V1);
    const r = verifyPasswordWithPepper(PW, stored.hash, null, ENV_V1_V2);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(true);
    expect(r.pepperVersion).toBe("v1"); // 呼び出し側はこの値で pepperVersion を補正できる
  });

  it("ペッパー導入前（ペッパーなし）のハッシュもログインでき、現行バージョンへ移行できる", () => {
    const legacy = hashPasswordWithVersion(PW, ENV_NONE);
    const r = verifyPasswordWithPepper(PW, legacy.hash, null, ENV_V1_V2);
    expect(r.ok).toBe(true);
    expect(r.needsRehash).toBe(true);
    expect(r.pepperVersion).toBeNull();
  });

  it("現行バージョンで一致したハッシュは再ハッシュ不要（毎回の再ハッシュが起きない）", () => {
    const stored = hashPasswordWithVersion(PW, ENV_V1);
    expect(verifyPasswordWithPepper(PW, stored.hash, "v1", ENV_V1)).toEqual({
      ok: true,
      needsRehash: false,
      pepperVersion: "v1",
    });
  });

  it("V1を撤去した後はV1ハッシュと照合できない（＝全アカウント移行後に削除する運用が必要）", () => {
    // docs/OPERATIONS.md §2.1 の手順6「全アカウントが v2 になったら PASSWORD_PEPPER_V1 を削除」の根拠。
    const stored = hashPasswordWithVersion(PW, ENV_V1);
    const r = verifyPasswordWithPepper(PW, stored.hash, "v1", ENV_V2_ONLY);
    expect(r.ok).toBe(false);
  });

  it("誤ったパスワードはどのバージョンでも一致しない", () => {
    const stored = hashPasswordWithVersion(PW, ENV_V1);
    for (const env of [ENV_NONE, ENV_V1, ENV_V1_V2, ENV_V2_ONLY]) {
      expect(verifyPasswordWithPepper(PW + "x", stored.hash, "v1", env).ok).toBe(false);
    }
  });
});

describe("旧アルゴリズム（bcrypt）からの段階移行（§10.3）", () => {
  it("bcryptハッシュ（ペッパー無し）はログインでき needsRehash=true", () => {
    const legacy = bcrypt.hashSync(PW, 10);
    const r = verifyPasswordWithPepper(PW, legacy, null, ENV_V1_V2);
    expect(r).toEqual({ ok: true, needsRehash: true, pepperVersion: null });
  });

  it("bcryptハッシュ（V1ペッパー適用済み）もログインでき needsRehash=true", () => {
    const legacy = bcrypt.hashSync(prehash(PW, "pepper-value-v1"), 10);
    const r = verifyPasswordWithPepper(PW, legacy, "v1", ENV_V1_V2);
    expect(r).toEqual({ ok: true, needsRehash: true, pepperVersion: "v1" });
  });

  it("壊れたハッシュ文字列でも例外を投げず不一致として扱う", () => {
    expect(verifyPasswordWithPepper(PW, "not-a-hash", "v1", ENV_V1_V2).ok).toBe(false);
    expect(verifyPasswordWithPepper(PW, "", null, ENV_V1_V2).ok).toBe(false);
    expect(verifyPasswordWithPepper(PW, "$argon2id$broken", "v1", ENV_V1_V2).ok).toBe(false);
  });
});

describe("ペッパーの混ぜ方（§10.3 CRYPTREC準拠）", () => {
  it("HMAC-SHA256（鍵=ペッパー）の前段ハッシュ。ペッパー無しは素通し", () => {
    expect(prehash(PW, "")).toBe(PW);
    const mixed = prehash(PW, "pepper-value-v1");
    expect(mixed).toMatch(/^[0-9a-f]{64}$/); // SHA-256（SHA-1/MD5は使用禁止）
    expect(prehash(PW, "pepper-value-v2")).not.toBe(mixed); // バージョンごとに別の値になる
  });
});
