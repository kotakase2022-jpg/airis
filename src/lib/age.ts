// 販売員ID申請の年齢制限（発注者指示 2026-08-05）:
// 生年月日カレンダーは「15年前の今日」（2026年時点では2011年の今日）をデフォルト表示し、
// 15歳未満（= 生年月日がその日より後）の申請はエラーにする。
// server-only を import しない純粋関数（tests/unit/age.test.ts で単体テスト）。

export const UNDER_AGE_ERROR = "15歳未満の方は申請できません";

// JSTの「今日」を YYYY-MM-DD で返す
export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 15年前の今日（YYYY-MM-DD）。うるう日（2/29）は 2/28 に丸める
export function fifteenYearsAgo(now: Date = new Date()): string {
  const today = jstToday(now);
  const [y, m, d] = today.split("-").map(Number);
  const targetYear = y - 15;
  // 2/29 → 対象年が平年なら 2/28
  const isLeap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const day = m === 2 && d === 29 && !isLeap(targetYear) ? 28 : d;
  return `${targetYear}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 15歳未満か（生年月日が「15年前の今日」より後 = まだ15歳の誕生日を迎えていない）。
// ちょうど15年前の今日生まれ（本日が15歳の誕生日）は申請可。
// birthDate は YYYY-MM-DD 前提（ISO形式は文字列比較で日付比較になる）
export function isUnder15(birthDate: string, now: Date = new Date()): boolean {
  return birthDate > fifteenYearsAgo(now);
}
