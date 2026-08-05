// 個人情報（PII）カラムの単一定義（§3.4 匿名化 / §8 スキーマ注釈）。
//
// prisma/schema.prisma の該当カラムには `/// @pii` を付与してあり、この定義とスキーマ注釈の
// 一致は tests/unit/pii.test.ts が schema.prisma を実際に読んで検証する。
// 匿名化バッチ（src/app/api/cron/daily/route.ts）は必ずこの定義を参照すること。
// server-only を import しないため単体テスト可能。

// 匿名化後の値。null許容カラムは null、必須カラムはセンチネル文字列に置き換える。
export const ANON_TEXT = "（匿名化済み）";

export type PiiField = { column: string; anonymizeTo: string | null };

// モデル名 → 匿名化対象カラムと置換値
export const PII_FIELDS: Record<string, PiiField[]> = {
  Account: [
    { column: "name", anonymizeTo: ANON_TEXT },
    { column: "email", anonymizeTo: null },
  ],
  AccountRequest: [
    // 申請レコードは承認後もメール・氏名を保持するため匿名化対象に含める
    { column: "name", anonymizeTo: ANON_TEXT },
    { column: "email", anonymizeTo: ANON_TEXT }, // 必須カラムのためセンチネル
  ],
  SalesStaff: [
    { column: "lastName", anonymizeTo: ANON_TEXT },
    { column: "firstName", anonymizeTo: "" },
    { column: "birthDate", anonymizeTo: "1900-01-01" },
    { column: "phone", anonymizeTo: "" },
    { column: "email", anonymizeTo: null },
  ],
  FieldAgentApplication: [
    { column: "lastNameKana", anonymizeTo: ANON_TEXT },
    { column: "firstNameKana", anonymizeTo: null },
    { column: "contractorName", anonymizeTo: null },
    { column: "contractorAddress", anonymizeTo: null },
    { column: "contractorPhone", anonymizeTo: null },
    { column: "pledgeFileId", anonymizeTo: null }, // 誓約書PDFは実体も削除する
  ],
};

// Prisma の update data オブジェクトを組み立てる（匿名化バッチ用）
export function anonymizeData(model: keyof typeof PII_FIELDS): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of PII_FIELDS[model]) out[f.column] = f.anonymizeTo;
  return out;
}
