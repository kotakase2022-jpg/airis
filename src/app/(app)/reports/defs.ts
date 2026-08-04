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
