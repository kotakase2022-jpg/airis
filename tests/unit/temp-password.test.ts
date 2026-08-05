// 管理者代行フローで発行する一時パスワードの検証（§4.2 / SEC-004）。
//
// 検証の眼目は「発行された一時パスワードが、そのアカウントに適用される
// パスワードポリシーを**必ず満たす**」こと。以前は呼び出し側で 24/16 桁を直書きしていたため、
// PASSWORD_MIN_ADMIN / PASSWORD_MIN_GENERAL を引き上げるとポリシー違反の値が発行され得た。

import { describe, it, expect } from "vitest";
import { generateTempPassword, tempPasswordLength } from "@/lib/temp-password";
import { passwordMinLength, passwordPolicy, validateNewPassword } from "@/lib/password-policy";

const ADMIN_ROLES = ["R1", "R2", "R3", "R7"]; // §4.2 管理者区分（20桁）
const GENERAL_ROLES = ["R4", "R5", "R6", "R8", "R9", "R10"]; // 一般区分（14桁）

describe("tempPasswordLength（桁数はポリシーから導出する §4.2 / SEC-004）", () => {
  it.each([...ADMIN_ROLES, ...GENERAL_ROLES])("%s: ポリシー最小桁数を上回る", (role) => {
    expect(tempPasswordLength(role)).toBeGreaterThan(passwordMinLength(role));
  });

  it("管理者は一般より長い（管理者20桁 / 一般14桁 §4.2）", () => {
    expect(tempPasswordLength("R1")).toBeGreaterThan(tempPasswordLength("R9"));
  });

  it("ポリシーの最小桁数を引き上げると発行桁数も追従する（直書きでないこと）", () => {
    const strict = { ...passwordPolicy(), minLengthAdmin: 40, minLengthGeneral: 30 };
    expect(tempPasswordLength("R1", strict)).toBeGreaterThan(40);
    expect(tempPasswordLength("R9", strict)).toBeGreaterThan(30);
  });
});

describe("generateTempPassword（§4.2 の形式要件を満たす）", () => {
  it.each([...ADMIN_ROLES, ...GENERAL_ROLES])(
    "%s: 生成値がそのまま validateNewPassword を通る",
    (role) => {
      for (let i = 0; i < 20; i++) {
        const pw = generateTempPassword(role);
        expect(pw).toHaveLength(tempPasswordLength(role));
        // ポリシー検証（桁数・英大小・数字）を通ること = 発行値で変更画面が詰まらない
        expect(validateNewPassword(pw, role), `${role} の生成値 ${pw} がポリシー違反`).toBeNull();
      }
    }
  );

  it("英大文字・英小文字・数字をそれぞれ含む", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword("R9");
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
    }
  });

  it("紛らわしい文字（I / l / O / 0 / 1）を含まない（口頭伝達の誤りを防ぐ）", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTempPassword("R1")).not.toMatch(/[IlO01]/);
    }
  });

  it("毎回異なる値を返す（固定値・低エントロピーでない）", () => {
    const set = new Set(Array.from({ length: 200 }, () => generateTempPassword("R9")));
    expect(set.size).toBe(200);
  });

  it("先頭3文字が常に「大文字・小文字・数字」の並びにならない（シャッフルされている）", () => {
    // 生成実装は [大, 小, 数] から作って Fisher-Yates で混ぜる。混ぜていなければ
    // 全サンプルが同じ並びになるため、200件で1件も崩れないなら実装の欠陥。
    const fixed = Array.from({ length: 200 }, () => generateTempPassword("R9")).filter((pw) =>
      /^[A-Z][a-z][0-9]/.test(pw)
    );
    expect(fixed.length).toBeLessThan(200);
  });
});
