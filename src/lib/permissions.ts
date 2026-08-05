// 権限マトリクス（§5.1「アカウント権限一覧★」の完全転記）を宣言的マップで表現する（§3.2）。
//
// - §5 冒頭のとおり **この表が権限の唯一の正**。他シート・フロー図と食い違う場合も本表を優先する。
// - 凡例: 申=申請 / 一承=1次承認 / 承=最終承認 / 変=変更 / 停=停止 / 閲=閲覧 / 削=削除 /
//         提=提出 / 作=作成 / 登=登録 / 送=送信 / ×=不可 / ダミー=ダミー表示（§3.5）
// - 本ファイルは純粋関数のみ（`server-only` を import しない）。API層・UI層の双方および
//   単体テスト（§13「§5 のマトリクスをそのままテーブル駆動テスト化」）から利用する。
// - 表に現れない（機能, 操作）の組み合わせは **全ロール不可** として扱う。

import type { Role } from "./roles";

// §5.1 の「機能」列
export type FeatureKey =
  | "airis-account" // Airisアカウント
  | "sales-staff" // 販売員ID
  | "field-agent" // 訪販員申請
  | "daily-report" // 日報提出
  | "submission" // 稼働提出物
  | "announcement-all" // お知らせ（全体向け）
  | "announcement-primary" // お知らせ（1次店向け）
  | "hotline" // ホットライン情報
  | "consumer-center"; // 消費者センター案件情報

// §5.1 の「操作」（凡例）
export type Operation =
  | "apply" // 申（申請）
  | "approve_first" // 一承（1次承認）
  | "approve_final" // 承（最終承認）
  | "update" // 変（変更）
  | "suspend" // 停（停止）
  | "view" // 閲（閲覧）
  | "delete" // 削（削除）
  | "submit" // 提（提出）
  | "create" // 作 / 登（作成・登録）
  | "send"; // 送（送信）。窓口案件では「返信」を指す（§5.1 補足・§7.10）

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  "airis-account": "Airisアカウント",
  "sales-staff": "販売員ID",
  "field-agent": "訪販員申請",
  "daily-report": "日報提出",
  submission: "稼働提出物",
  "announcement-all": "お知らせ（全体向け）",
  "announcement-primary": "お知らせ（1次店向け）",
  hotline: "ホットライン情報",
  "consumer-center": "消費者センター案件情報",
};

// ===== §5.1 機能×操作×ロール =====
// 各機能のコメントに原表の行をそのまま転記してある（①〜⑩の順）。
export const PERMISSIONS: Record<FeatureKey, Partial<Record<Operation, readonly Role[]>>> = {
  // Airisアカウント | 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | 承/申 | 申 | 申 | 申 | 申/一承 | 申 | × | ×
  // 停止・削除は①②のみ（§6.1-5）。⑦のみ「一承」を持つ（⑧の申請を1次承認する §6.1-3）。
  // 「閲」は発注者指示（2026-08-05「③の管理画面を〇」）により③を追加。
  // ③は管理画面の閲覧と、§4.2 が定めるリセット代行（approve_final で判定）までを行う。
  // 変更・停止・削除は原表どおり①②のみ。
  "airis-account": {
    apply: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2"],
    suspend: ["R1", "R2"],
    view: ["R1", "R2", "R3"],
    delete: ["R1", "R2"],
  },

  // 販売員ID | 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | ダミー | × | × | 申/一承/変/閲/停/削 | 申 | × | ×
  // ⑦は自店配下のみ（スコープは §3.1 の agencyScope で担保。§14-11 で確定）。
  "sales-staff": {
    apply: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7"],
    suspend: ["R1", "R2", "R3", "R7"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3", "R7"],
  },

  // 訪販員申請 | 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | ダミー | × | × | 申/一承/変/閲/停/削 | 申 | × | ×
  "field-agent": {
    apply: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7"],
    suspend: ["R1", "R2", "R3", "R7"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3", "R7"],
  },

  // 日報提出 | 提/変/閲/削 | 提/変/閲/削 | 提/変/閲/削 | ダミー | × | × | 提/変/閲/削 | 提/変/閲/削 | 提（自己修正可） | ×
  // ⑨は「提」のみ。自己修正は同一（日付×タイプ×販売員ID）の再提出＝上書きで実現する（§7.5 / 要件6-1）。
  "daily-report": {
    submit: ["R1", "R2", "R3", "R7", "R8", "R9"],
    update: ["R1", "R2", "R3", "R7", "R8"],
    view: ["R1", "R2", "R3", "R7", "R8"],
    delete: ["R1", "R2", "R3", "R7", "R8"],
  },

  // 稼働提出物 | 承/提/変/閲/削 | 承/提/変/閲/削 | 承(エリア営業)/提/変/閲/削 | ダミー | × | × | SNCへ提出/一承/変/削 | 一次店へ提出/変/削 | × | ×
  // §5.1 補足: ⑦⑧の閲覧は原表に明記が無いが、提出状況確認（§7.6）に不可欠なため自店スコープの「閲」を含める。
  submission: {
    submit: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7", "R8"],
    view: ["R1", "R2", "R3", "R7", "R8"],
    delete: ["R1", "R2", "R3", "R7", "R8"],
  },

  // お知らせ（全体向け） | 登/送/変/閲/停/削 | 登/送/変/閲/停/削 | 登/送/変/閲/停/削 | ダミー | × | × | 閲 | 閲 | 閲 | ×
  "announcement-all": {
    create: ["R1", "R2", "R3"],
    send: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3"],
    suspend: ["R1", "R2", "R3"],
    view: ["R1", "R2", "R3", "R7", "R8", "R9"],
    delete: ["R1", "R2", "R3"],
  },

  // お知らせ（1次店向け） | 登/送/変/閲/停/削 | 登/送/変/閲/停/削 | 登/送/変/閲/停/削 | ダミー | × | × | 閲 | × | × | ×
  "announcement-primary": {
    create: ["R1", "R2", "R3"],
    send: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3"],
    suspend: ["R1", "R2", "R3"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3"],
  },

  // ホットライン情報 | 作/変/閲/停/削 | 作/変/閲/停/削 | 作/変/閲/停/削 | × | 作/変/停/削/閲 | × | 閲/返信（自店案件のみ） | × | × | 閲/返信（自店案件のみ）
  // 「返信」= send。代理店（⑦⑩）からの唯一の書き込み手段で、新規起票は不可（§5.1 補足 / §7.10）。
  hotline: {
    create: ["R1", "R2", "R3", "R5"],
    update: ["R1", "R2", "R3", "R5"],
    suspend: ["R1", "R2", "R3", "R5"],
    view: ["R1", "R2", "R3", "R5", "R7", "R10"],
    delete: ["R1", "R2", "R3", "R5"],
    send: ["R1", "R2", "R3", "R5", "R7", "R10"],
  },

  // 消費者センター案件情報 | 作/変/閲/停/削 | 作/変/閲/停/削 | 作/変/閲/停/削 | × | × | 作/変/停/削/閲 | 閲/返信（自店案件のみ） | × | × | 閲/返信（自店案件のみ）
  "consumer-center": {
    create: ["R1", "R2", "R3", "R6"],
    update: ["R1", "R2", "R3", "R6"],
    suspend: ["R1", "R2", "R3", "R6"],
    view: ["R1", "R2", "R3", "R6", "R7", "R10"],
    delete: ["R1", "R2", "R3", "R6"],
    send: ["R1", "R2", "R3", "R6", "R7", "R10"],
  },
};

// §5.1 で ④（SNC閲覧）が「ダミー」となる機能。実データへは一切アクセスさせず、書き込みは全て無効（§3.5）。
export const DUMMY_FEATURES: readonly FeatureKey[] = [
  "sales-staff",
  "field-agent",
  "daily-report",
  "submission",
  "announcement-all",
  "announcement-primary",
];

/**
 * §5.1 の権限判定。API層・UI層の両方でこれを使う（§3.2）。
 * 表に無い（機能, 操作）は全ロール false。
 */
export function can(role: Role, feature: FeatureKey, op: Operation): boolean {
  // 未知のキー（型を外れた実行時の値）は不可として扱う（fail-closed）
  return PERMISSIONS[feature]?.[op]?.includes(role) ?? false;
}

/** ④のダミー表示対象機能か（§3.5）。true の場合、実データの参照・書き込みを行わせない。 */
export function isDummyFeature(role: Role, feature: FeatureKey): boolean {
  return role === "R4" && DUMMY_FEATURES.includes(feature);
}

/**
 * 1次承認の実施可否。
 * §5.1 で「一承」を持つのは⑦のみだが、最終承認権限者（①②③）は §6.2-2「①②③は自ら申請した案件を
 * 自己承認（最終承認）することも可能」を満たすため中間状態への遷移も実施できる必要がある。
 * よって「最終承認権限は1次承認を内含する」と解釈する（§7.2 の「承認操作権限は申請中レコードの閲覧を内含する」と同趣旨）。
 * ※ Airisアカウント（airis-account）はこの内含を適用しない — §6.1-3 で1次承認者が⑦に限定されているため。
 */
export function canApproveFirst(role: Role, feature: FeatureKey): boolean {
  if (can(role, feature, "approve_first")) return true;
  if (feature === "airis-account") return false;
  return can(role, feature, "approve_final");
}

/** お知らせの宛先（all / primary）から機能キーを解決する（§5.1 は2チャネルで別行）。 */
export function announcementFeature(audience: string): FeatureKey {
  return audience === "primary" ? "announcement-primary" : "announcement-all";
}

/** 窓口案件の系列（HL / CSC）から機能キーを解決する（§7.8 / §7.9 は別ページ・別データ系列）。 */
export function caseFeature(series: string): FeatureKey {
  return series === "HL" ? "hotline" : "consumer-center";
}
