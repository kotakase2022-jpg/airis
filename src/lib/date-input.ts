// 日付入力（YYYY-MM-DD）の検証。**純粋関数のみ**（DB・現在時刻・環境変数に依存しない）。
//
// 経緯（QA loop3 で検出した欠陥）:
//   各画面がそれぞれ `const DATE_RE = /^\d{4}-\d{2}-\d{2}$/` を持ち、**形式だけ**を検査していた。
//   この正規表現は `9999-99-99` や `2026-02-31`（存在しない日）を通してしまうため、
//   - 窓口案件の対応期限に `9999-99-99` が保存され、督促バッチ（要件9-2）の期限判定が壊れる
//   - 訪販員申請の稼働開始日・終了日に存在しない日が入る（§7.4）
//   - 販売員の生年月日に存在しない日が入り、15歳判定（§6.2）が誤る
//   といった業務上の誤りにつながる。実在日チェックを本モジュールへ集約する。
//
// 「実在する日」の判定は new Date() のパースに頼らない（`2026-02-31` を 3/3 に繰り上げるため
// 検証に使えない）。年・月・日を分解し、月の日数（うるう年込み）と突き合わせる。

/** YYYY-MM-DD の形式だけを見る正規表現（実在判定には isCalendarDate を使う） */
export const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 月（YYYY-MM）の日数。うるう年（4年/100年/400年ルール）に対応する。
 * 不正な月は 0 を返す（呼び出し側は「日数0＝実在しない月」として扱える）。
 */
export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return 0;
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/**
 * 「YYYY-MM-DD 形式で、かつ実在する日付」か。
 * 形式違反・月13以上・日0・その月に存在しない日（例 2026-02-31）はすべて false。
 * 空文字・null・undefined も false（「任意項目で未入力」は呼び出し側で先に判定する）。
 */
export function isCalendarDate(v: string | null | undefined): boolean {
  if (!v || !DATE_FORMAT_RE.test(v)) return false;
  const days = daysInMonth(v.slice(0, 7));
  if (days === 0) return false;
  const d = Number(v.slice(8, 10));
  return d >= 1 && d <= days;
}

/**
 * 任意入力向け: 未入力（空文字・null・undefined）なら true、入力があるなら実在日であること。
 * 「入力されていれば正しい形式でなければならない」項目（稼働開始日・対応期限など）に使う。
 */
export function isBlankOrCalendarDate(v: string | null | undefined): boolean {
  if (v === null || v === undefined || v === "") return true;
  return isCalendarDate(v);
}

/**
 * 実在日ならそのまま返し、そうでなければ null。
 * URLクエリ・CSV列など「不正なら無かったことにする」入力の正規化に使う。
 */
export function normalizeCalendarDate(v: string | null | undefined): string | null {
  return isCalendarDate(v) ? (v as string) : null;
}
