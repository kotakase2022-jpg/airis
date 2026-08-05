// パスワードポリシー（§4.2 / §10.1「ポリシー値は設定で変更可能に」/ SEC-004）
// 桁数20/14・有効期間90/180日・履歴24世代の既定値と、環境変数による変更を検証する。
import { describe, expect, it } from "vitest";
import { ADMIN_PW_ROLES, type Role } from "@/lib/roles";
import {
  DEFAULT_PASSWORD_POLICY,
  isAdminPasswordRole,
  isPasswordExpired,
  passwordMaxAgeDays,
  passwordMinLength,
  passwordPolicy,
  passwordReuseError,
  validateNewPassword,
} from "@/lib/password-policy";

const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

describe("既定値（§4.2 の表）", () => {
  it("桁数20/14・有効期間90/180日・履歴24世代", () => {
    expect(DEFAULT_PASSWORD_POLICY).toEqual({
      minLengthAdmin: 20,
      minLengthGeneral: 14,
      maxAgeAdminDays: 90,
      maxAgeGeneralDays: 180,
      historyGenerations: 24,
    });
  });

  it("環境変数が未設定なら既定値", () => {
    expect(passwordPolicy({})).toEqual(DEFAULT_PASSWORD_POLICY);
  });

  it("管理者区分（①②③⑦）は roles.ts の ADMIN_PW_ROLES に一致する", () => {
    // ロール配列をポリシー側に直書きしていないこと（AGENTS.md / §3.2）
    for (const role of ALL_ROLES) {
      expect(isAdminPasswordRole(role)).toBe(ADMIN_PW_ROLES.includes(role));
    }
    expect(ADMIN_PW_ROLES).toEqual(["R1", "R2", "R3", "R7"]);
  });

  it("ロール別の桁数・有効期間（稼働終了代理店の⑩は一般ポリシー）", () => {
    for (const role of ["R1", "R2", "R3", "R7"] as Role[]) {
      expect(passwordMinLength(role, DEFAULT_PASSWORD_POLICY)).toBe(20);
      expect(passwordMaxAgeDays(role, DEFAULT_PASSWORD_POLICY)).toBe(90);
    }
    for (const role of ["R4", "R5", "R6", "R8", "R9", "R10"] as Role[]) {
      expect(passwordMinLength(role, DEFAULT_PASSWORD_POLICY)).toBe(14);
      expect(passwordMaxAgeDays(role, DEFAULT_PASSWORD_POLICY)).toBe(180);
    }
  });
});

describe("環境変数による変更（SEC-004）", () => {
  it("5項目すべてを変更できる", () => {
    const policy = passwordPolicy({
      PASSWORD_MIN_ADMIN: "24",
      PASSWORD_MIN_GENERAL: "16",
      PASSWORD_MAX_AGE_ADMIN_DAYS: "60",
      PASSWORD_MAX_AGE_GENERAL_DAYS: "120",
      PASSWORD_HISTORY_GENERATIONS: "12",
    });
    expect(policy).toEqual({
      minLengthAdmin: 24,
      minLengthGeneral: 16,
      maxAgeAdminDays: 60,
      maxAgeGeneralDays: 120,
      historyGenerations: 12,
    });
    expect(passwordMinLength("R2", policy)).toBe(24);
    expect(passwordMinLength("R8", policy)).toBe(16);
    expect(passwordMaxAgeDays("R2", policy)).toBe(60);
    expect(passwordMaxAgeDays("R8", policy)).toBe(120);
  });

  it("不正値（空・0・負数・小数・非数値）は既定値へフォールバックする", () => {
    for (const bad of ["", " ", "0", "-1", "1.5", "abc", "20桁", "1e3"]) {
      expect(passwordPolicy({ PASSWORD_MIN_ADMIN: bad }).minLengthAdmin).toBe(20);
      expect(passwordPolicy({ PASSWORD_HISTORY_GENERATIONS: bad }).historyGenerations).toBe(24);
      expect(passwordPolicy({ PASSWORD_MAX_AGE_ADMIN_DAYS: bad }).maxAgeAdminDays).toBe(90);
    }
  });

  it("前後の空白は無視する", () => {
    expect(passwordPolicy({ PASSWORD_MIN_GENERAL: " 18 " }).minLengthGeneral).toBe(18);
  });
});

describe("新パスワードの形式検証（§4.2）", () => {
  const policy = DEFAULT_PASSWORD_POLICY;

  it("桁数不足はロール別の文言でエラー", () => {
    expect(validateNewPassword("Abcdefg1234567", "R8", policy)).toBeNull(); // 14桁
    expect(validateNewPassword("Abcdefg123456", "R8", policy)).toBe(
      "パスワードは14桁以上にしてください"
    );
    expect(validateNewPassword("Abcdefg1234567", "R2", policy)).toBe(
      "パスワードは20桁以上にしてください"
    );
    expect(validateNewPassword("Abcdefghij1234567890", "R2", policy)).toBeNull(); // 20桁
  });

  it("文字種（大文字・小文字・数字）を要求する", () => {
    const msg = "大文字・小文字・数字をそれぞれ含めてください";
    expect(validateNewPassword("abcdefg1234567", "R8", policy)).toBe(msg); // 大文字なし
    expect(validateNewPassword("ABCDEFG1234567", "R8", policy)).toBe(msg); // 小文字なし
    expect(validateNewPassword("Abcdefghijklmn", "R8", policy)).toBe(msg); // 数字なし
  });

  it("桁数の設定変更がエラー文言に反映される", () => {
    const custom = { ...policy, minLengthGeneral: 16 };
    expect(validateNewPassword("Abcdefg1234567", "R8", custom)).toBe(
      "パスワードは16桁以上にしてください"
    );
  });
});

describe("再利用禁止の文言（§4.2 過去24世代）", () => {
  it("既定は24世代", () => {
    expect(passwordReuseError(DEFAULT_PASSWORD_POLICY)).toBe(
      "過去24世代と同じパスワードは使用できません"
    );
  });

  it("設定値に追従する", () => {
    expect(passwordReuseError({ ...DEFAULT_PASSWORD_POLICY, historyGenerations: 12 })).toBe(
      "過去12世代と同じパスワードは使用できません"
    );
  });
});

describe("有効期間の超過判定（§4.2）", () => {
  const now = new Date("2026-08-05T09:00:00+09:00");
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600 * 1000);

  it("管理者は90日、一般は180日で超過する", () => {
    expect(isPasswordExpired(daysAgo(89), "R2", now, DEFAULT_PASSWORD_POLICY)).toBe(false);
    expect(isPasswordExpired(daysAgo(91), "R2", now, DEFAULT_PASSWORD_POLICY)).toBe(true);
    expect(isPasswordExpired(daysAgo(179), "R8", now, DEFAULT_PASSWORD_POLICY)).toBe(false);
    expect(isPasswordExpired(daysAgo(181), "R8", now, DEFAULT_PASSWORD_POLICY)).toBe(true);
  });

  it("ちょうど期限（90日/180日）は未超過（超過は「より前」）", () => {
    expect(isPasswordExpired(daysAgo(90), "R2", now, DEFAULT_PASSWORD_POLICY)).toBe(false);
    expect(isPasswordExpired(daysAgo(180), "R8", now, DEFAULT_PASSWORD_POLICY)).toBe(false);
  });

  it("有効期間の設定変更が反映される", () => {
    const custom = { ...DEFAULT_PASSWORD_POLICY, maxAgeAdminDays: 30, maxAgeGeneralDays: 60 };
    expect(isPasswordExpired(daysAgo(31), "R2", now, custom)).toBe(true);
    expect(isPasswordExpired(daysAgo(31), "R8", now, custom)).toBe(false);
    expect(isPasswordExpired(daysAgo(61), "R8", now, custom)).toBe(true);
  });
});
