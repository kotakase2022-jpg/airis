import { describe, expect, it } from "vitest";
import { fifteenYearsAgo, isUnder15, jstToday } from "../../src/lib/age";

// 販売員ID申請の年齢制限（src/lib/age.ts / 発注者指示 2026-08-05）
describe("fifteenYearsAgo / isUnder15", () => {
  // JSTで 2026-08-05 になる時刻（UTC 2026-08-04 15:00 = JST 2026-08-05 00:00）
  const now = new Date("2026-08-05T03:00:00Z");

  it("jstToday はJST基準の今日を返す（UTC日付との境界）", () => {
    expect(jstToday(new Date("2026-08-04T15:00:00Z"))).toBe("2026-08-05");
    expect(jstToday(new Date("2026-08-04T14:59:59Z"))).toBe("2026-08-04");
  });

  it("デフォルト表示は「15年前の今日」= 2026年時点では2011年の今日", () => {
    expect(fifteenYearsAgo(now)).toBe("2011-08-05");
  });

  it("ちょうど15歳（本日が誕生日）は申請できる", () => {
    expect(isUnder15("2011-08-05", now)).toBe(false);
  });

  it("15歳未満（15年前の今日より後の生年月日）は拒否", () => {
    expect(isUnder15("2011-08-06", now)).toBe(true);
    expect(isUnder15("2020-01-01", now)).toBe(true);
  });

  it("15歳超は申請できる", () => {
    expect(isUnder15("2011-08-04", now)).toBe(false);
    expect(isUnder15("1990-04-01", now)).toBe(false);
  });

  it("うるう日境界: 2/29 の15年前が平年なら 2/28 に丸める", () => {
    // JST 2032-02-29（うるう年）→ 15年前の2017年は平年 → 2017-02-28
    const leap = new Date("2032-02-28T15:00:00Z"); // JST 2032-02-29 00:00
    expect(fifteenYearsAgo(leap)).toBe("2017-02-28");
  });
});
