// ロール定義（指示書 §4 / §5）
export type Role =
  | "R1" // サスラボ社システム管理
  | "R2" // SNC管理者
  | "R3" // SNC運用者
  | "R4" // SNC閲覧（ダミー表示）
  | "R5" // SNCサポート（ホットライン窓口）
  | "R6" // SNCサポート（消費者センター窓口）
  | "R7" // 1次代理店管理者
  | "R8" // 2次代理店管理者
  | "R9" // 代理店一般（販売員ID）
  | "R10"; // 稼働終了代理店（実効ロール）

export const ROLE_LABELS: Record<Role, string> = {
  R1: "SLシステム管理",
  R2: "SNC管理者",
  R3: "SNC運用者",
  R4: "SNC閲覧者",
  R5: "SNCホットライン担当",
  R6: "SNC消費者センター担当",
  R7: "一次代理店管理者",
  R8: "二次代理店管理者",
  R9: "代理店一般（販売員）",
  R10: "稼働終了代理店",
};

export const ROLE_NUM: Record<Role, string> = {
  R1: "①",
  R2: "②",
  R3: "③",
  R4: "④",
  R5: "⑤",
  R6: "⑥",
  R7: "⑦",
  R8: "⑧",
  R9: "⑨",
  R10: "⑩",
};

// SNC系（テナント横断可）
export const SNC_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6"];
// SNC管理系（承認・作成の主体）
export const SNC_ADMIN_ROLES: Role[] = ["R1", "R2", "R3"];
// 管理者区分（パスワード20桁）
export const ADMIN_PW_ROLES: Role[] = ["R1", "R2", "R3", "R7"];

// お知らせの配信対象（§7.7）。配信範囲 all=代理店全員（⑦⑧⑨）/ primary=1次店管理者（⑦）のみ。
// ⑩（稼働終了）はDB上のロールが R7/R8 のまま（実効ロール §14-2）のため、この集合で拾われる。
export const ANNOUNCEMENT_AUDIENCE_ROLES: Record<"all" | "primary", Role[]> = {
  all: ["R7", "R8", "R9"],
  primary: ["R7"],
};
// 配信対象になり得る全ロール（既読率の母数）
export const ANNOUNCEMENT_TARGET_ROLES: Role[] = ANNOUNCEMENT_AUDIENCE_ROLES.all;

/**
 * そのロールに見せるお知らせを配信範囲で絞る必要があるか（§7.7）。
 * - 配信対象外（SNC系①〜⑥）: 絞らない（作成・管理のため全件見える） → null
 * - ⑦（1次店管理者）: primary 宛も all 宛も対象 → null
 * - ⑧⑨: all 宛のみ → "all"
 * 呼び出し側でロール名や配列を直書きしないための導出関数（§3.2）。
 */
export function announcementAudienceFilterFor(role: Role): "all" | null {
  if (!ANNOUNCEMENT_TARGET_ROLES.includes(role)) return null;
  if (ANNOUNCEMENT_AUDIENCE_ROLES.primary.includes(role)) return null;
  return "all";
}

/**
 * 申請が「1次承認を経る」申請元ロールか（§6.1「⑧からの申請は⑦の1次承認を経てSNCへ」/ §6.3）。
 * 2次代理店（⑧）の申請は親1次店（⑦）の1次承認を要する。
 * 承認経路の決定と通知宛先の決定に使う（誰が操作できるかの判定は permissions.ts が担う）。
 */
export const FIRST_APPROVAL_APPLICANT_ROLES: Role[] = ["R8"];

export function needsFirstApproval(role: Role): boolean {
  return FIRST_APPROVAL_APPLICANT_ROLES.includes(role);
}

export type PageKey =
  | "dashboard"
  | "account-requests"
  | "sales-staff"
  | "field-agents"
  | "reports"
  | "agencies"
  | "admin"
  | "hotline"
  | "consumer-center"
  | "agency-cases"
  | "announcements"
  | "documents";

// サイドメニュー（指示書 §11.1 の11項目 + 代理店向け統合ビュー）
export const MENU: {
  key: PageKey;
  label: string;
  href: string;
  roles: Role[];
  dummyFor?: Role[]; // ④はダミー表示
}[] = [
  {
    key: "dashboard",
    label: "ダッシュボード",
    href: "/dashboard",
    roles: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"],
  },
  {
    key: "account-requests",
    label: "Airisアカウント申請",
    href: "/account-requests",
    roles: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
  },
  {
    key: "sales-staff",
    label: "販売員ID管理",
    href: "/sales-staff",
    roles: ["R1", "R2", "R3", "R4", "R7", "R8"],
    dummyFor: ["R4"],
  },
  {
    key: "field-agents",
    label: "訪販員申請・管理",
    href: "/field-agents",
    roles: ["R1", "R2", "R3", "R4", "R7", "R8"],
    dummyFor: ["R4"],
  },
  {
    key: "reports",
    label: "各種資料の提出",
    href: "/reports",
    roles: ["R1", "R2", "R3", "R4", "R7", "R8", "R9"],
    dummyFor: ["R4"],
  },
  {
    key: "agencies",
    label: "下位代理店",
    href: "/agencies",
    roles: ["R1", "R2", "R3", "R4", "R7"],
    dummyFor: ["R4"],
  },
  // ③の管理画面アクセスは発注者指示（2026-08-05）により〇。§4.2「MFA・パスワードの
  // リセットは②③が実行」と整合させるため、③は閲覧+リセット系のみ可（停止/削除/ロール変更は①②のまま §5.1）
  {
    key: "admin",
    label: "管理画面",
    href: "/admin",
    roles: ["R1", "R2", "R3", "R4"],
    dummyFor: ["R4"],
  },
  { key: "hotline", label: "ホットライン窓口", href: "/hotline", roles: ["R1", "R2", "R3", "R5"] },
  {
    key: "consumer-center",
    label: "消費者センター窓口",
    href: "/consumer-center",
    roles: ["R1", "R2", "R3", "R6"],
  },
  { key: "agency-cases", label: "窓口案件", href: "/agency-cases", roles: ["R7", "R10"] },
  {
    key: "announcements",
    label: "お知らせ",
    href: "/announcements",
    roles: ["R1", "R2", "R3", "R4", "R7", "R8", "R9"],
    dummyFor: ["R4"],
  },
  {
    key: "documents",
    label: "ドキュメント",
    href: "/documents",
    roles: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"],
    dummyFor: ["R4"],
  },
];

export function canAccess(role: Role, page: PageKey): boolean {
  const item = MENU.find((m) => m.key === page);
  return !!item && item.roles.includes(role);
}

export function isDummyView(role: Role, page: PageKey): boolean {
  const item = MENU.find((m) => m.key === page);
  return !!item?.dummyFor?.includes(role);
}

// Airisアカウント申請で申請できるロール（§6.1）
// ⑨（販売員）はAirisアカウントの対象外（販売員ID管理で採番・発行する §6.2）。
// ②は①（サスラボシステム管理）を申請できない（発注者指示 2026-08-05）:
// 保守ベンダーである①の発行を発注者側の運用で増やせないようにするため、①の発行は①のみが行う。
export const REQUESTABLE_ROLES: Record<Role, Role[]> = {
  R1: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"],
  R2: ["R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"],
  R3: ["R3", "R4", "R5", "R6", "R7", "R8", "R10"],
  R4: ["R4"],
  R5: ["R5"],
  R6: ["R6"],
  R7: ["R7", "R8"],
  R8: ["R8"],
  R9: [],
  R10: [],
};

// ステータス表示ラベル（§4.1）
export const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  pending: "承認待ち",
  active: "登録済み",
  suspended: "停止",
  deleted: "削除済",
};

export const STAFF_STATUS_LABELS: Record<string, string> = {
  applying: "申請中",
  provisional: "仮登録",
  registered: "本登録",
  suspended: "停止中",
  deleted: "削除済",
};

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  pending_first: "一次承認待ち",
  pending_final: "承認待ち",
  approved: "登録済み",
  rejected: "差戻し・却下",
};

export const SUBMISSION_KINDS = [
  "【アライアンス申請書】",
  "【訪販用】稼働エリア申請フォーマット",
  "【ポスティング用】配布エリア申請フォーマット",
  "【独自特典】申請シート",
  "【催事用】稼働エリア申請フォーマット",
  "環境ヒアリングシート",
] as const;

/**
 * 稼働提出物の様式ファイル（§7.6「提出用テンプレート（様式ダウンロード）」）。
 *
 * 以前は `SUBMISSION_KINDS` の**配列添字**から `template${i + 1}.xlsx` を組み立てていたため、
 * 様式の追加・並べ替えでファイルと様式名の対応が静かにずれ、**別の様式が配布される**恐れがあった。
 * 様式名 → ファイル名の明示的な対応表にして、ずれを型で防ぐ（過不足は下の Record 型が検出する）。
 *
 * 実ファイルは発注者提供の原本（`public/templates/`）。原本は `docs/materials/フォーマット/` に
 * ①〜⑥の採番付きで同梱されており、`templateN.xlsx` の N はその採番と一致する。
 * 対応の正しさは `tests/unit/submission-templates.test.ts` がファイルの実体（シート名）まで見て検証する。
 */
export const SUBMISSION_TEMPLATE_FILES: Record<(typeof SUBMISSION_KINDS)[number], string> = {
  "【アライアンス申請書】": "template1.xlsx",
  "【訪販用】稼働エリア申請フォーマット": "template2.xlsx",
  "【ポスティング用】配布エリア申請フォーマット": "template3.xlsx",
  "【独自特典】申請シート": "template4.xlsx",
  "【催事用】稼働エリア申請フォーマット": "template5.xlsx",
  環境ヒアリングシート: "template6.xlsx",
};

export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  pending_first: "1次店確認中",
  pending_snc: "SNC確認中",
  approved: "最終承認済み",
  rejected: "差戻し",
};

export const CASE_STATUSES = ["未対応", "確認中", "対応中", "問題発生", "完了"] as const;

/**
 * 窓口案件の系列（HL=ホットライン / CSC=消費者センター）にロールを限定する宣言的マップ（§4 / §5.2）。
 *
 * ⑤（サポート窓口1）はホットライン窓口のみ、⑥（サポート窓口2）は消費者センター窓口のみを扱う。
 * それ以外のロールは系列で絞らない（①②③④は両系列、⑦⑧⑩は自代理店の案件）。
 * ダッシュボード等でロール名を直書きしないための情報源（§3.2）。
 */
export const CASE_SERIES_BY_ROLE: Partial<Record<Role, "HL" | "CSC">> = {
  R5: "HL",
  R6: "CSC",
};

/** ロールが単一系列に限定される場合その系列、しない場合 null（§4） */
export function caseSeriesForRole(role: Role): "HL" | "CSC" | null {
  return CASE_SERIES_BY_ROLE[role] ?? null;
}

export const CASE_TEMPLATES = [
  "音声提出依頼",
  "代理店様から顧客への架電依頼",
  "代理店確認依頼",
  "フリー入力",
] as const;

// ===== 将来機能の権限枠（§7.13 / §5.1。画面は未実装、権限定義のみ先行） =====
// AIチャット/AI研修/AIロープレ/ゲーミング要素（要件シート4・5欠番のため詳細未確定 §14-6）
export type FutureFeatureKey =
  | "ai-chat-all" // AIチャット（全体向け）
  | "ai-chat-primary" // AIチャット（1次店向け）
  | "ai-training" // AI研修
  | "ai-roleplay" // AIロープレ
  | "gaming"; // ゲーミング要素

// §5.1 の権限マトリクスどおりの利用可否（利用可= true）
export const FUTURE_FEATURE_ACCESS: Record<FutureFeatureKey, Role[]> = {
  "ai-chat-all": ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"],
  "ai-chat-primary": ["R1", "R2", "R3", "R4", "R5", "R6", "R7"],
  "ai-training": ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"], // ①②③=作成系, ④〜⑨=閲覧
  "ai-roleplay": ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"],
  gaming: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"],
};
