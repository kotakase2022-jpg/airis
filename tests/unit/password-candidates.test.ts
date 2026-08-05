import { describe, expect, it } from "vitest";
import { passwordInputCandidates } from "../../src/lib/password-input";

// ログイン入力のゆらぎ吸収（src/lib/password-input.ts）。
// 「原文が先頭・重複なし・受理範囲を広げるだけ」の保証を検証する。
describe("passwordInputCandidates", () => {
  it("正しい入力は原文1件のみ（余計な照合をしない）", () => {
    expect(passwordInputCandidates("Airis-Demo-Admin-2026!x")).toEqual(["Airis-Demo-Admin-2026!x"]);
  });

  it("原文が常に先頭（従来通る入力の挙動を変えない）", () => {
    for (const raw of [" pw ", '"pw!"', "ｐｗ！", "pw\n"]) {
      expect(passwordInputCandidates(raw)[0]).toBe(raw);
    }
  });

  it("前後の空白・改行を吸収する", () => {
    expect(passwordInputCandidates(" Airis-Demo-2026! ")).toContain("Airis-Demo-2026!");
    expect(passwordInputCandidates("Airis-Demo-2026!\n")).toContain("Airis-Demo-2026!");
    expect(passwordInputCandidates("\tAiris-Demo-2026!")).toContain("Airis-Demo-2026!");
  });

  it("IMEの全角英数記号をNFKCで半角へ吸収する", () => {
    expect(passwordInputCandidates("Ａｉｒｉｓ－Ｄｅｍｏ－２０２６！")).toContain(
      "Airis-Demo-2026!"
    );
    // 全角スペース（U+3000）はNFKC後もtrim済みであること
    expect(passwordInputCandidates("　Airis-Demo-2026!　")).toContain("Airis-Demo-2026!");
  });

  it("引用符ごとの貼り付けを吸収する（seed.tsからのコピー想定）", () => {
    expect(passwordInputCandidates('"Airis-Demo-Admin-2026!x"')).toContain(
      "Airis-Demo-Admin-2026!x"
    );
    expect(passwordInputCandidates("'Airis-Demo-2026!'")).toContain("Airis-Demo-2026!");
    expect(passwordInputCandidates("「Airis-Demo-2026!」")).toContain("Airis-Demo-2026!");
    // 全角引用符 + 全角英数の複合
    expect(passwordInputCandidates("”Ａｉｒｉｓ－Ｄｅｍｏ－２０２６！”")).toContain(
      "Airis-Demo-2026!"
    );
  });

  it("重複なし・空文字を含まない", () => {
    for (const raw of ["pw", " pw ", '"pw"', "''", " ", "ｐｗ"]) {
      const list = passwordInputCandidates(raw);
      expect(new Set(list).size).toBe(list.length);
      expect(list.filter((s, i) => i > 0 && !s)).toEqual([]);
    }
  });

  it("引用符の中身が引用符のみでも壊れない（境界）", () => {
    expect(passwordInputCandidates('"a"')).toEqual(['"a"', "a"]);
    expect(passwordInputCandidates('""')).toEqual(['""']);
  });
});
