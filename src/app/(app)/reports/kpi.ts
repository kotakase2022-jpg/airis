// 日報の自動計算KPI（SPEC §7.5「自動計算KPI」）と集計・実績確認タブのフィルタ補助。
//
// このモジュールは **純粋関数のみ** で構成する:
//   - server action（actions.ts）とサーバコンポーネント（page.tsx）の双方から使うため
//     DB・現在時刻・環境変数に一切依存させない（レンダー中に new Date() を呼ばない §2）
//   - 計算式と「分母0」の挙動を tests/unit/kpi.test.ts で検証するため（T-016 / §13）
//
// §7.5「※端数・分母0は「0」表示」を num() / div() / pct() / fx() の4関数に集約し、
// NaN・Infinity を戻り値として外に出さない。

import type { KpiTile } from "./defs";

/**
 * KPI計算に必要な日報のフィールドだけを構造的に要求する型。
 * Prisma の DailyReport（各項目 Int?/Float?）もそのまま渡せる。
 */
export type KpiReport = {
  date: string; // YYYY-MM-DD
  // 訪販
  forecastAcq?: number | null; // 獲得見込（月初見込）
  acquisitions?: number | null; // 獲得
  workers?: number | null; // 稼働数
  visits?: number | null; // 訪問数
  meetings?: number | null; // 対面数
  negotiations?: number | null; // 商談数
  contracts?: number | null; // 成約数
  // テレマ
  forecastHours?: number | null; // 稼働時間（月初見込）
  forecastEntries?: number | null; // エントリー数（月初見込）
  actualHours?: number | null; // 稼働時間（実績）
  entries?: number | null; // エントリー数（実績）
  appointments?: number | null; // アポ数（実績）
  closePassed?: number | null; // クローズ通過数
  preConfirmPassed?: number | null; // 前確通過数（実績）
};

/** 未入力（null / undefined）と非数（NaN / Infinity）は 0 として扱う（§7.5） */
export function num(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 除算。分母0（および非数）は 0 を返す — §7.5「端数・分母0は「0」表示」 */
export function div(a: number | null | undefined, b: number | null | undefined): number {
  const denom = num(b);
  if (denom === 0) return 0;
  const v = num(a) / denom;
  return Number.isFinite(v) ? v : 0;
}

/** 小数第1位までの丸め（表示用）。非数は 0 */
export function round1(v: number | null | undefined): number {
  return Math.round(num(v) * 10) / 10;
}

/** 率の表示（小数第1位まで）。分母0・非数は「0%」 */
export function pct(v: number | null | undefined): string {
  return `${Math.round(num(v) * 1000) / 10}%`;
}

/** 実数の表示（小数第1位まで）。分母0・非数は「0」 */
export function fx(v: number | null | undefined): string {
  return String(round1(v));
}

/**
 * 月（YYYY-MM）の日数。うるう年に対応する。
 * new Date() を使わない純粋計算にしてあるため、レンダー中から呼んでも安全（§2）。
 * 不正な月は 0（呼び出し側で div() を通すため 0除算にはならない）。
 */
export function daysInMonth(month: string): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) return 0;
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function sumOf(reports: KpiReport[], pick: (r: KpiReport) => number | null | undefined): number {
  return reports.reduce((acc, r) => acc + num(pick(r)), 0);
}

// ---------------------------------------------------------------------------
// 月初見込（要件6-3「月の初回提出時のみ入力」）
// ---------------------------------------------------------------------------

export type ForecastField = "forecastAcq" | "forecastHours" | "forecastEntries";
export type ForecastRow = { date: string; value: number | null };
/** 月初見込の判定に必要なフィールドのみ（Prisma の select 結果もそのまま渡せる） */
export type ForecastSource = { date: string } & Partial<Record<ForecastField, number | null>>;

/** 月内で最初（最古日付）に入力された見込を採用する（要件6-3） */
export function firstForecast(rows: ForecastRow[]): { date: string; value: number } | null {
  let holder: { date: string; value: number } | null = null;
  for (const r of rows) {
    if (r.value == null) continue;
    if (!holder || r.date < holder.date) holder = { date: r.date, value: r.value };
  }
  return holder;
}

export function firstForecastRec(
  reports: ForecastSource[],
  field: ForecastField
): { date: string; value: number } | null {
  return firstForecast(reports.map((r) => ({ date: r.date, value: r[field] ?? null })));
}

// ---------------------------------------------------------------------------
// 稼働日報タブのKPIタイル（§7.5「自動計算KPI」）
// ---------------------------------------------------------------------------

/**
 * 訪販の当月KPI 12タイル（プロトタイプ準拠のラベル。§7.5）。
 * 生産性=獲得/稼働数、進捗=経過日数/月日数、達成率=獲得/獲得見込、
 * 着地予想=（獲得/経過日数）×月日数、着地差分=着地予想-月初見込、
 * ペースメーカー=（月初見込/月日数）×経過日数、対面率=対面数/訪問数、
 * 商談率=商談数/対面数、成約率=成約数/商談数、訪問|対面|商談/日=各計/日報提出日数。
 * 計算式の詳細は日報Excel準拠（原本が未提供の項目は仮実装 §14-5）。
 */
export function calcVisitKpi(reports: KpiReport[], date: string): KpiTile[] {
  const days = daysInMonth(date.slice(0, 7));
  const elapsed = num(Number(date.slice(8, 10))); // 経過日（当日）
  const acq = sumOf(reports, (r) => r.acquisitions);
  const workers = sumOf(reports, (r) => r.workers);
  const visits = sumOf(reports, (r) => r.visits);
  const meetings = sumOf(reports, (r) => r.meetings);
  const negotiations = sumOf(reports, (r) => r.negotiations);
  const contracts = sumOf(reports, (r) => r.contracts);
  // 獲得見込は「月初見込」= 月内最初（最古日付）のレコードの見込を採用
  const forecast = firstForecastRec(reports, "forecastAcq")?.value ?? 0;
  // TODO: 「訪問/日」等の分母は暫定で当月の日報提出日数を採用（Excel原本の数式確認要 §14-5）
  const reportDays = new Set(reports.map((r) => r.date)).size;
  const landing = div(acq, elapsed) * days; // 着地予想

  return [
    { label: "生産性", value: fx(div(acq, workers)) },
    { label: "進捗", value: pct(div(elapsed, days)) },
    { label: "達成率", value: pct(div(acq, forecast)) },
    { label: "着地予想", value: fx(landing) },
    // 月初見込が未入力（=0）のときは差分を出さない（基準が無いため「0」表示 §7.5）
    { label: "着地差分", value: fx(forecast ? landing - forecast : 0) },
    { label: "ペースメーカー", value: fx(div(forecast, days) * elapsed) },
    { label: "対面率", value: pct(div(meetings, visits)) },
    { label: "商談率", value: pct(div(negotiations, meetings)) },
    { label: "成約率", value: pct(div(contracts, negotiations)) },
    { label: "訪問/日", value: fx(div(visits, reportDays)) },
    { label: "対面/日", value: fx(div(meetings, reportDays)) },
    { label: "商談/日", value: fx(div(negotiations, reportDays)) },
  ];
}

/**
 * テレマの当月KPIタイル（§7.5）:
 * アポ生産性=アポ数計/稼働時間計、クローズ通過率=クローズ通過数計/アポ数計、
 * 前確通過率=前確通過数計/クローズ通過数計、差分（見込vs実績）、残稼働=見込-実績計。分母0は0。
 * ※「獲得生産性」「後確通過率」は分子となる入力項目（獲得数・後確通過数）が要件6-3に存在しないため
 *   対象外（仮実装+TODO §14-5。呼び出し側が kpiNote で注記を表示する）
 */
export function calcTeleKpi(reports: KpiReport[]): KpiTile[] {
  const hours = sumOf(reports, (r) => r.actualHours);
  const entries = sumOf(reports, (r) => r.entries);
  const appointments = sumOf(reports, (r) => r.appointments);
  const closePassed = sumOf(reports, (r) => r.closePassed);
  const preConfirmPassed = sumOf(reports, (r) => r.preConfirmPassed);
  // 見込は月初見込（月内最初のレコードの見込）
  const forecastHours = firstForecastRec(reports, "forecastHours")?.value ?? 0;
  const forecastEntries = firstForecastRec(reports, "forecastEntries")?.value ?? 0;

  return [
    { label: "アポ生産性", value: fx(div(appointments, hours)) },
    { label: "クローズ通過率", value: pct(div(closePassed, appointments)) },
    { label: "前確通過率", value: pct(div(preConfirmPassed, closePassed)) },
    { label: "稼働時間差分", value: fx(hours - forecastHours) },
    { label: "エントリー数差分", value: fx(entries - forecastEntries) },
    { label: "残稼働", value: fx(forecastHours - hours) },
  ];
}

// ---------------------------------------------------------------------------
// 集計・実績確認タブ（§7.5）
// ---------------------------------------------------------------------------

/** KPIカード6枚の元になる集計値（DBの集計結果をそのまま渡す） */
export type SummaryTotals = {
  reportCount: number; // 日報件数
  acquisitions: number; // 訪販: 獲得計
  closePassed: number; // テレマ: クローズ通過数計
  workers: number; // 訪販: 稼働数計
  negotiations: number; // 商談数計
  contracts: number; // 成約数計
  submissionCount: number; // 稼働提出物の件数
  approvedCount: number; // 稼働提出物のうち最終承認済み
};

/** KPIカード6枚の表示値（ラベルはプロトタイプ準拠 §7.5） */
export type SummaryKpi = {
  reportCount: number; // 日報件数
  results: number; // 獲得/成果数
  productivity: number; // 生産性
  closeRate: string; // 成約率
  submissionCount: number; // 提出物
  approvedCount: number; // 最終承認済み
};

/**
 * 集計・実績確認タブのKPIカード6枚を計算する（§7.5）。
 * 生産性=獲得計/稼働数計、成約率=成約数計/商談数計。分母0は「0」表示（§7.5）。
 */
export function calcSummaryKpi(t: SummaryTotals): SummaryKpi {
  return {
    reportCount: num(t.reportCount),
    // TODO: 「獲得/成果数」は暫定で 訪販の獲得計+テレマのクローズ通過計 を採用（定義確認要 §14-5）
    results: num(t.acquisitions) + num(t.closePassed),
    productivity: round1(div(t.acquisitions, t.workers)),
    closeRate: pct(div(t.contracts, t.negotiations)),
    submissionCount: num(t.submissionCount),
    approvedCount: num(t.approvedCount),
  };
}

/** 期間フィルタの日付パラメータ検証。YYYY-MM-DD 形式かつ実在する日付のみ採用し、他は null（§7.5） */
export function normalizeDate(v: string | null | undefined): string | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const days = daysInMonth(v.slice(0, 7));
  const d = Number(v.slice(8, 10));
  if (days === 0 || d < 1 || d > days) return null;
  return v;
}

/** 月（YYYY-MM）の初日・末日。期間フィルタの既定値（当月）に使う（§7.5） */
export function monthRange(month: string): { from: string; to: string } {
  const days = daysInMonth(month);
  if (days === 0) return { from: "", to: "" }; // 不正な月は空（呼び出し側で期間指定なしとして扱う）
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}` };
}
