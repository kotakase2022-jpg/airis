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
// 日付の実在判定・月日数は入力検証（server action / CSV取込）と同じ実装を共有する
// （うるう年ロジックを二重に持つと片方だけ直して食い違う。src/lib/date-input.ts が唯一の実装）
import { daysInMonth, normalizeCalendarDate } from "@/lib/date-input";

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
 * 月（YYYY-MM）の日数。うるう年に対応する。不正な月は 0
 * （呼び出し側で div() を通すため 0除算にはならない）。
 * 実装は src/lib/date-input.ts に集約してある（入力検証と同じうるう年ロジックを共有するため）。
 * new Date() を使わない純粋計算なので、レンダー中から呼んでも安全（§2）。
 */
export { daysInMonth };

/**
 * 月末日（YYYY-MM-DD）を返す。不正な月は月初（呼び出し側の稼働日数が0になる）。
 */
export function monthEnd(month: string): string {
  const d = daysInMonth(month);
  return `${month}-${String(d || 1).padStart(2, "0")}`;
}

/**
 * 日曜のみを休日として数えた稼働日数。
 * Excel原本（docs/materials/稼働日報/）の `NETWORKDAYS.INTL(from, to, 11)` と同値
 * （第3引数 11 = 「日曜だけが休日」の週末指定）。
 * from > to のときは 0。不正な日付は 0（呼び出し側で div() を通すため 0除算にはならない）。
 */
export function workdaysExcludingSundays(from: string, to: string): number {
  const s = Date.parse(`${from}T00:00:00Z`);
  const e = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) return 0;
  let n = 0;
  for (let t = s; t <= e; t += 86400000) {
    if (new Date(t).getUTCDay() !== 0) n++; // 0 = 日曜
  }
  return n;
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
 * 訪販の当月KPI 12タイル（§7.5。計算式は **§14-5 #5「Excel原本の数式を正として実装」** に従う）。
 *
 * 原本 = `docs/materials/稼働日報/訪販日報.xlsx`（見出し=6行目 / 集計=7行目 / 8行目以降が日次）。
 * 原本から読み取った数式と、本実装の採否:
 *
 * 原本の読み取りは **共有数式（`<f t="shared" si="N"/>`）を定義元から解決**し、
 * キャッシュ値との整合で裏取りしてある（例 `R7` の値 0.67317 = 138/205 = `O7/N7`）。
 * 表示書式（`numFmtId`）も原本に合わせる（率は `pct()` / 実数は `fx()`）。
 *
 * | ラベル | 原本のセル・数式（実測） | 原本の書式 | 本実装 |
 * |---|---|---|---|
 * | 生産性 | `G7 =IFERROR(E7/F7,0)` | `0.00` | 獲得/稼働数 → `fx()` |
 * | 進捗 | `H7` **空セル（数式・値なし）** | — | 経過日数/月日数 → `pct()`（下記※1） |
 * | 達成率 | `I7 =IFERROR(E7/D7,0)` | `0%` | 獲得/獲得見込 → `pct()` |
 * | 着地予想 | `K7 =SUM(K8:K11)`（日次側は空欄） | `General` | 獲得/経過稼働日数×月の稼働日数 → `fx()`（下記※2） |
 * | 着地差分 | `L7 =K7-D7` | `#,##0`系 | 着地予想−獲得見込 → `fx()` |
 * | ペースメーカー | `J7 =IFERROR(K7/D7,0)` | **`0%`** | 着地予想/獲得見込 → `pct()`（下記※3） |
 * | 対面率 | `Q7 =IFERROR(N7/M7,0)` | `0%` | 対面数/訪問数 → `pct()` |
 * | 商談率 | `R7` 共有数式(si=6) → `=IFERROR(O7/N7,0)` | `0%` | 商談数/対面数 → `pct()` |
 * | 成約率 | `S7` 共有数式(si=6) → `=IFERROR(P7/O7,0)` | `0%` | 成約数/商談数 → `pct()` |
 * | 訪問/日 | `T7 =IFERROR(M7/F7,0)` | `General` | 訪問数/**稼働数** → `fx()` |
 * | 対面/日 | `U7 =IFERROR(N7/F7,0)` | `General` | 対面数/**稼働数** → `fx()` |
 * | 商談/日 | `V7 =IFERROR(O7/F7,0)` | `General` | 商談数/**稼働数** → `fx()` |
 *
 * ※1 「進捗」は原本の `H7` が**空セル**で数式が存在しない。したがって原本を根拠にできず、
 *    §7.5 の明記「進捗（月内経過日数ベースの進捗率）」に従って **経過暦日数 / 当月の暦日数** とする
 *    （§14-5 #5 の対象一覧にも「進捗」は挙がっていない = 原本委任の対象外）。
 *    達成率（`I7` = 獲得/獲得見込）とは別指標であり、原本・§7.5 とも矛盾しない。
 * ※2 原本 `G2 =NETWORKDAYS.INTL(D2, EOMONTH(D2,0), 11)`（注記「← 日曜日を休日とした場合の稼働日数」/
 *    実測値24 = 2026年2月の28日−日曜4日）、`G3 =NETWORKDAYS.INTL(DATE(YEAR(D3),MONTH(D3),1), D3, 11)`
 *    （注記「← 稼働実績日数を表示」/ 実測値13）。原本の着地予想は日次行 `K8:K11` の合計だが
 *    日次側の数式が空欄のため導出できない。この2セルが「実績ペースを月の稼働日数へ引き伸ばす」
 *    ための入力として置かれていることから、獲得/稼働実績日数×月の稼働日数 を採る（**推定**）。
 *    この推定は qa/REQUIREMENTS_TRACEABILITY.csv の OQ-005 行に根拠として記録している。
 * ※3 §7.5 の散文は「ペースメーカー（月初見込ベースの日割り進捗）」と記すが、
 *    §14-5 #5 が「ペースメーカー・着地予想・残稼働見込など」を名指しで
 *    **「Excel原本の数式を正として実装し、テストで突合」** と定めているため、原本 `J7` を採る。
 *    原本の書式が `0%` なので率として表示する（実数表示では「1.1件」と誤読される）。
 *
 * すべて原本は `IFERROR(..., 0)` で0除算を0に落としており、div() が同じ挙動（§7.5「分母0は0表示」）。
 */
export function calcVisitKpi(reports: KpiReport[], date: string): KpiTile[] {
  const month = date.slice(0, 7);
  // 進捗（※1）は §7.5 の「月内経過日数」= 暦日ベース
  const days = daysInMonth(month);
  const elapsed = num(Number(date.slice(8, 10)));
  // 着地予想（※2）は原本 G2/G3 の NETWORKDAYS.INTL(..., 11) = 日曜のみ休日として数えた稼働日数
  const monthWorkdays = workdaysExcludingSundays(`${month}-01`, monthEnd(month));
  const elapsedWorkdays = workdaysExcludingSundays(`${month}-01`, date);
  const acq = sumOf(reports, (r) => r.acquisitions);
  const workers = sumOf(reports, (r) => r.workers);
  const visits = sumOf(reports, (r) => r.visits);
  const meetings = sumOf(reports, (r) => r.meetings);
  const negotiations = sumOf(reports, (r) => r.negotiations);
  const contracts = sumOf(reports, (r) => r.contracts);
  // 獲得見込は「月初見込」= 月内最初（最古日付）のレコードの見込を採用
  const forecast = firstForecastRec(reports, "forecastAcq")?.value ?? 0;
  const landing = div(acq, elapsedWorkdays) * monthWorkdays; // 着地予想（※2）

  return [
    { label: "生産性", value: fx(div(acq, workers)) },
    { label: "進捗", value: pct(div(elapsed, days)) }, // ※1（暦日ベース。原本 H7 は空セル）
    { label: "達成率", value: pct(div(acq, forecast)) }, // 原本 I7
    { label: "着地予想", value: fx(landing) },
    // 月初見込が未入力（=0）のときは差分を出さない（基準が無いため「0」表示 §7.5）
    { label: "着地差分", value: fx(forecast ? landing - forecast : 0) },
    // 原本 J7 は書式 0% = 率。実数表示にすると「1.1件」と誤読されるため pct() を使う（※3）
    { label: "ペースメーカー", value: pct(div(landing, forecast)) },
    { label: "対面率", value: pct(div(meetings, visits)) },
    { label: "商談率", value: pct(div(negotiations, meetings)) },
    { label: "成約率", value: pct(div(contracts, negotiations)) },
    // 原本 T7/U7/V7 = 各数 / 稼働数（日報提出日数ではない）
    { label: "訪問/日", value: fx(div(visits, workers)) },
    { label: "対面/日", value: fx(div(meetings, workers)) },
    { label: "商談/日", value: fx(div(negotiations, workers)) },
  ];
}

/**
 * テレマの当月KPIタイル（§7.5。計算式は **§14-5 #5「Excel原本の数式を正として実装」** に従う）。
 *
 * 原本 = `docs/materials/稼働日報/テレマ日報.xlsx`（項目名=B列 / 月合計=C列 / D列以降が日次）。
 * 原本のファネルは **アポ数(C14) → クローズ通過数(C15) → 前確通過数(C16) → エントリー数(C17)** で、
 * 最終成果（＝獲得・後確通過）が「エントリー数」に相当する。
 *
 * | ラベル | 原本のセル・数式 | 本実装 |
 * |---|---|---|
 * | 獲得生産性 | `C12 =IFERROR(C17/C9,0)` | エントリー数/稼働時間（実績） |
 * | アポ生産性 | `C20 =IFERROR(C14/C9,0)` | アポ数/稼働時間（実績） |
 * | クローズ通過率 | `C21 =IFERROR(C15/C14,0)` | クローズ通過数/アポ数 |
 * | 前確通過率 | `C22 =IFERROR(C16/C15,0)` | 前確通過数/クローズ通過数 |
 * | 後確通過率 | `C23 =IFERROR(C17/C16,0)` | エントリー数/前確通過数 |
 * | 稼働時間差分 | `C10 =C9-C8` | 実績−見込 |
 * | エントリー数差分 | `C19 =C17-C18` | 実績−見込 |
 * | 残稼働 | `C28 =SUM(D28:AH28)`、`D28 =IF(D9="",D8,"")` | 月初見込−実績計（下記※） |
 *
 * ※ 原本の残稼働は「**実績が未入力の日**の見込稼働時間の合計」だが、要件6-3 は見込を
 *   「月の初回提出時のみ入力」＝日次の見込列を持たない設計のため、日単位での未入力判定ができない。
 *   月合計での等価式である「月初見込 − 実績計」を採る（構造差として §14-5 / qa/RESIDUAL_RISKS.md に記録）。
 *
 * なお §7.5 は「獲得生産性」「後確通過率」を *分子となる入力項目が無いため対象外* としていたが、
 * 原本ではいずれも分子が **エントリー数（実績）** であり既存の入力項目から算出できる。
 * §14-5 #5「原本の数式を正として実装」に従い、原本どおり実装する（§7.5 の前提の誤りを是正）。
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
    { label: "獲得生産性", value: fx(div(entries, hours)) },
    { label: "アポ生産性", value: fx(div(appointments, hours)) },
    { label: "クローズ通過率", value: pct(div(closePassed, appointments)) },
    { label: "前確通過率", value: pct(div(preConfirmPassed, closePassed)) },
    { label: "後確通過率", value: pct(div(entries, preConfirmPassed)) },
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

/**
 * 期間フィルタの日付パラメータ検証。YYYY-MM-DD 形式かつ実在する日付のみ採用し、他は null（§7.5）。
 * 判定は src/lib/date-input.ts の実在日チェックに委譲する（入力検証と同一ルールにするため）。
 */
export { normalizeCalendarDate as normalizeDate };

/** 月（YYYY-MM）の初日・末日。期間フィルタの既定値（当月）に使う（§7.5） */
export function monthRange(month: string): { from: string; to: string } {
  const days = daysInMonth(month);
  if (days === 0) return { from: "", to: "" }; // 不正な月は空（呼び出し側で期間指定なしとして扱う）
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}` };
}
