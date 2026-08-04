import { describe, it, expect, vi } from "vitest";

// util.ts は `import "server-only"` に加え prisma / mail に依存するため、
// server-only は vitest.config.ts の resolve.alias で空モジュールにスタブし、
// prisma / mail は vi.mock でモックして純粋関数のみをテストする（§2）。
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/mail", () => ({
  mailConfigured: () => false,
  sendMail: vi.fn(async () => {}),
}));

import { fiscalYearOf, pushHistory, formatHistory } from "@/lib/util";

describe("fiscalYearOf（§7.6 年度 = 4月〜翌3月）", () => {
  const CASES: { targetMonth: string; expected: number }[] = [
    { targetMonth: "2026-04", expected: 2026 }, // 年度開始月
    { targetMonth: "2026-09", expected: 2026 }, // 年度中盤
    { targetMonth: "2026-12", expected: 2026 }, // 暦年末も同年度
    { targetMonth: "2027-01", expected: 2026 }, // 年明けは前年扱い
    { targetMonth: "2027-03", expected: 2026 }, // 年度末月
    { targetMonth: "2027-04", expected: 2027 }, // 翌年度開始
    { targetMonth: "2026-03", expected: 2025 }, // 前年度末
  ];

  it.each(CASES)("$targetMonth → $expected 年度", ({ targetMonth, expected }) => {
    expect(fiscalYearOf(targetMonth)).toBe(expected);
  });
});

describe("pushHistory（履歴イベント追記）", () => {
  // 履歴日付は Asia/Tokyo 基準（§2 タイムゾーン Asia/Tokyo固定）
  const todayJst = () =>
    new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  it("履歴が null でも新規配列としてイベントを追加する", () => {
    expect(pushHistory(null, "申請", "R7")).toEqual([
      { event: "申請", at: todayJst(), by: "R7" },
    ]);
  });

  it("既存の履歴配列の末尾に追記し、元の配列は破壊しない", () => {
    const before = [{ event: "申請", at: "2026-04-01", by: "R8" }];
    const after = pushHistory(before, "一次承認", "R7");
    expect(after).toEqual([
      { event: "申請", at: "2026-04-01", by: "R8" },
      { event: "一次承認", at: todayJst(), by: "R7" },
    ]);
    expect(before).toHaveLength(1);
  });

  it("配列以外（不正なJSON値）は空履歴として扱う", () => {
    expect(pushHistory("broken", "承認", "R2")).toEqual([
      { event: "承認", at: todayJst(), by: "R2" },
    ]);
  });
});

describe("formatHistory（履歴の表示整形）", () => {
  it('複数イベントを "event at / event at" 形式で連結する', () => {
    const history = [
      { event: "申請", at: "2026-04-01" },
      { event: "承認", at: "2026-04-02" },
    ];
    expect(formatHistory(history)).toBe("申請 2026-04-01 / 承認 2026-04-02");
  });

  it("空配列は空文字を返す", () => {
    expect(formatHistory([])).toBe("");
  });

  it("配列以外は空文字を返す", () => {
    expect(formatHistory(null)).toBe("");
    expect(formatHistory("x")).toBe("");
    expect(formatHistory({ event: "a" })).toBe("");
  });
});
