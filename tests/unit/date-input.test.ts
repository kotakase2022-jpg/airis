// 日付入力の実在判定（src/lib/date-input.ts）の単体テスト。
//
// 背景（QA loop3 で検出した実欠陥）:
//   各画面が形式のみの `/^\d{4}-\d{2}-\d{2}$/` で検証していたため、`9999-99-99` が
//   窓口案件の対応期限としてそのままDBに保存されていた（e2e で実際に再現）。
//   同じ正規表現は稼働開始日・稼働終了日・生年月日・代理店参加日・日報の日付にも使われており、
//   存在しない日（例 2026-02-31）を受け付けていた。
//
// ここでは「形式は正しいが存在しない日」を必ず拒否することを、境界値で網羅的に検証する。

import { describe, it, expect } from "vitest";
import {
  DATE_FORMAT_RE,
  daysInMonth,
  isCalendarDate,
  isBlankOrCalendarDate,
  normalizeCalendarDate,
} from "@/lib/date-input";

describe("daysInMonth（うるう年）", () => {
  it.each([
    ["2026-01", 31],
    ["2026-02", 28],
    ["2024-02", 29], // 4年ルール
    ["2000-02", 29], // 400年ルール
    ["2100-02", 28], // 100年ルール
    ["2026-04", 30],
    ["2026-12", 31],
  ])("%s → %i日", (month, expected) => {
    expect(daysInMonth(month)).toBe(expected);
  });

  it("不正な月は0", () => {
    for (const m of ["2026-13", "2026-00", "2026-99", "", "abcd-ef", "2026"]) {
      expect(daysInMonth(m), m).toBe(0);
    }
  });
});

describe("isCalendarDate（実在する日付か）", () => {
  it("実在する日付は true", () => {
    for (const d of [
      "2026-01-01",
      "2026-01-31",
      "2026-02-28",
      "2024-02-29", // うるう年の2/29
      "2026-04-30",
      "2026-12-31",
      "2000-02-29",
    ]) {
      expect(isCalendarDate(d), d).toBe(true);
    }
  });

  it("**形式は正しいが存在しない日**は false（この検証が欠けていた）", () => {
    for (const d of [
      "9999-99-99", // e2e で実際にDBへ保存されていた値
      "2026-02-29", // 平年の2/29
      "2100-02-29", // 100年ルールで平年
      "2026-02-31",
      "2026-04-31",
      "2026-06-31",
      "2026-09-31",
      "2026-11-31",
      "2026-13-01", // 月13
      "2026-00-10", // 月0
      "2026-01-00", // 日0
      "2026-01-32",
    ]) {
      expect(isCalendarDate(d), `${d} を実在日として受理してはいけない`).toBe(false);
    }
  });

  it("形式違反は false", () => {
    for (const d of [
      "2026/01/01",
      "26-01-01",
      "2026-1-1",
      "2026-01-01T00:00:00Z",
      " 2026-01-01",
      "2026-01-01 ",
      "abcd-ef-gh",
      "",
    ]) {
      expect(isCalendarDate(d), d).toBe(false);
    }
  });

  it("null / undefined は false（必須項目の判定に使える）", () => {
    expect(isCalendarDate(null)).toBe(false);
    expect(isCalendarDate(undefined)).toBe(false);
  });

  it("形式のみの正規表現では通ってしまう値を、実在判定は拒否する（回帰の要点）", () => {
    // DATE_FORMAT_RE を通るのに実在しない = 旧実装の穴そのもの
    for (const d of ["9999-99-99", "2026-02-31", "2026-13-01"]) {
      expect(DATE_FORMAT_RE.test(d), `${d} は形式は通る`).toBe(true);
      expect(isCalendarDate(d), `${d} は実在しない`).toBe(false);
    }
  });
});

describe("isBlankOrCalendarDate（任意入力向け）", () => {
  it("未入力（空文字・null・undefined）は true", () => {
    expect(isBlankOrCalendarDate("")).toBe(true);
    expect(isBlankOrCalendarDate(null)).toBe(true);
    expect(isBlankOrCalendarDate(undefined)).toBe(true);
  });

  it("入力があるなら実在日でなければ false", () => {
    expect(isBlankOrCalendarDate("2026-08-05")).toBe(true);
    expect(isBlankOrCalendarDate("9999-99-99")).toBe(false);
    expect(isBlankOrCalendarDate("2026-02-31")).toBe(false);
  });
});

describe("normalizeCalendarDate（不正なら null）", () => {
  it("実在日はそのまま、それ以外は null", () => {
    expect(normalizeCalendarDate("2026-08-05")).toBe("2026-08-05");
    expect(normalizeCalendarDate("2024-02-29")).toBe("2024-02-29");
    expect(normalizeCalendarDate("2026-02-29")).toBeNull();
    expect(normalizeCalendarDate("9999-99-99")).toBeNull();
    expect(normalizeCalendarDate("")).toBeNull();
    expect(normalizeCalendarDate(null)).toBeNull();
    expect(normalizeCalendarDate(undefined)).toBeNull();
  });
});

describe("new Date() のパースに依存していないこと", () => {
  it("new Date('2026-02-31') は 3/3 に繰り上がるが、実在判定は false を返す", () => {
    // この繰り上がりが「形式チェックだけで済ませてはいけない」理由そのもの
    expect(new Date("2026-02-31T00:00:00Z").getUTCDate()).toBe(3);
    expect(isCalendarDate("2026-02-31")).toBe(false);
  });
});
