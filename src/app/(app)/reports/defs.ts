// 日報・稼働提出物モジュール共有定義（SPEC §7.5 / §7.6）

// 訪販日報CSVテンプレートのヘッダ（要件6-1）
export const VISIT_CSV_HEADERS = [
  "日付",
  "販売員ID",
  "エリア",
  "獲得見込",
  "獲得",
  "稼働数",
  "訪問数",
  "対面数",
  "商談数",
  "成約数",
  "活動実施内容",
  "活動実施結果",
  "備考",
] as const;

// テレマ日報CSVテンプレートのヘッダ
export const TELE_CSV_HEADERS = [
  "日付",
  "販売員ID",
  "エリア",
  "稼働時間(月初見込)",
  "エントリー数(月初見込)",
  "稼働時間(実績)",
  "エントリー数(実績)",
  "アポ数(実績)",
  "クローズ通過数",
  "前確通過数(実績)",
  "活動実施内容",
  "活動実施結果",
  "備考",
] as const;

// テンプレート2行目の記入例（発注者指示 2026-08-05: 例文記載済みテンプレートを配布する）。
// 日付セルに「(例)」を付けているため、例文行を残したまま取り込むと日付形式エラーになり、
// 記入例が実データとして誤登録される事故を防げる（実データで上書きしてから取り込む運用）。
export const VISIT_CSV_EXAMPLE = [
  "(例)2026-08-01",
  "(例)999999C001",
  "東京都新宿区",
  "5",
  "3",
  "4",
  "40",
  "12",
  "6",
  "3",
  "新宿エリアの戸建てを中心に個別訪問",
  "3件成約。夕方の在宅率が高くアポ効率良好",
  "（記入例です。この行を実データに書き換えてください）",
] as const;

export const TELE_CSV_EXAMPLE = [
  "(例)2026-08-01",
  "(例)999999C001",
  "東京都新宿区",
  "8.0",
  "120",
  "7.5",
  "110",
  "15",
  "8",
  "5",
  "リストAへ架電。午前は不通率高",
  "アポ15件、前確通過5件",
  "（記入例です。この行を実データに書き換えてください）",
] as const;

export type KpiTile = { label: string; value: string };

export type DailyFormState = {
  error?: string;
  success?: string;
  kpiTitle?: string;
  kpi?: KpiTile[];
  kpiNote?: string;
};

export type CsvUploadState = {
  errors?: string[];
  success?: string;
};

export type SubmissionFormState = {
  error?: string;
  success?: string;
};
