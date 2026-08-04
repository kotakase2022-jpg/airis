// 訪販員申請 CSV一括申請の列定義（SPEC §7.4）
// ひな形DL（csv/template）・取込（csvBulkApplyAction）・UI説明文で共有する。
export const FIELD_AGENT_CSV_HEADERS = [
  "販売員ID",
  "申請区分",
  "取扱商材",
  "属性",
  "フリガナ(姓)",
  "フリガナ(名)",
  "本人性種別",
  "誓約書No",
  "稼働開始日",
  "使用代理店コード1",
  "使用代理店コード2",
  "業務委託会社名",
  "業務委託会社住所",
  "業務委託会社連絡先",
] as const;

// 誓約書PDFのファイル名規則: {誓約書No}-{連番3桁}.pdf（§7.4）
export function pledgePdfName(pledgeNo: string, seq: number): string {
  return `${pledgeNo}-${String(seq).padStart(3, "0")}.pdf`;
}
