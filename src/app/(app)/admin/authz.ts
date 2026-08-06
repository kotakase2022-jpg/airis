// 管理画面の操作権限（§5.1 / §5.2 の宣言的マップから導出する。ロール配列は直書きしない §3.2）。
//
// UI層（page.tsx / クライアントコンポーネント）と API層（server action / route handler）の
// 双方から同じ関数を呼ぶことで、ボタンの出し分けと再検証を一致させる。

import { REQUESTABLE_ROLES, type Role } from "@/lib/roles";
import { can, type Operation } from "@/lib/permissions";
import { canResetCredentialsFor } from "../account-requests/approval-rules";

/**
 * 管理画面のアカウント操作（`accountAction` の `op`）と §5.1 の操作権限の対応表。
 *
 * **UI層とAPI層が同じ導出を使うための単一の情報源**（§3.2）。
 * 以前は UI が `canSuspendAccount()` 等のラッパ、API層（actions.ts）が
 * `can(role, "airis-account", ADMIN_OP_PERMISSION[op])` と**同じ規則を二重に表現**しており、
 * 片方だけ変更すると気付かずに UI とサーバの判定が食い違う状態だった
 * （値は一致していたので不具合には至っていないが、QA loop5 で乖離リスクとして検出）。
 * 現在は下のラッパもこの表から導出し、`tests/unit/admin-authz-layers.test.ts` が
 * UI とサーバの判定一致・表と switch の網羅を機械検査する。
 *
 * `actions.ts` は `"use server"` のため定数を export できない。宣言の置き場はこのモジュール。
 */
export const ADMIN_OP_PERMISSION: Record<string, Operation> = {
  suspend: "suspend", // 停
  resume: "suspend", // 停止の解除は「停」権限の範囲
  delete: "delete", // 削（§3.4 論理削除）
  restore: "delete", // 論理削除の復旧は「削」権限の範囲（§3.4 / 要件1-5）
  // リセット代行は §4.2「MFAリセット・パスワードリセットは管理者代行フローを用意（②③が実行）」。
  // ②③が共通で持つ操作は「承」（approve_final = ①②③）なのでこれで判定する。
  // 「変」（update = ①②）で判定すると③が実行できず §4.2 を満たせない。
  reset_password: "approve_final",
  mfa_reset: "approve_final",
};

/** `accountAction` の op 単位の実行可否（未知の op は fail-closed で false） */
export function canAdminAccountOp(role: Role, op: string): boolean {
  const required = ADMIN_OP_PERMISSION[op];
  return required ? can(role, "airis-account", required) : false;
}

/**
 * 「①（サスラボ社システム管理アカウント）だけができる操作」の判定。
 * §5.1 の表に「①のみ」という粒度の行は無いため、roles.ts の宣言的マップ
 * REQUESTABLE_ROLES（①を発行できるのは①のみ = 保守ベンダーの発行を増やせないようにする
 * 発注者指示）を情報源として「ベンダー管理者か」を導出する。
 */
function isVendorAdminRole(role: Role): boolean {
  return REQUESTABLE_ROLES[role].includes("R1");
}

/**
 * セキュリティ設定（IP許可リスト等）の変更可否（§10.1）。
 * 設定変更は管理系の「変更」操作なので §5.1「Airisアカウント / 変」（①②）と同一範囲とする。
 */
export function canUpdateSettings(role: Role): boolean {
  return can(role, "airis-account", "update");
}

/**
 * 監査記録の閲覧・出力の可否（監査ログ / アクセスログ / 棚卸CSV）。
 *
 * §7.1「管理画面（①②のみ）: 直近の監査イベント・不正利用アラート」/
 * §7.2「Airisアカウント管理ページ（①②のみ）: … 棚卸CSV、アクセスログCSV」に従い **①②のみ**。
 *
 * 発注者指示（2026-08-05）で③の管理画面アクセスを〇にしたが、
 * 追加指示（2026-08-06）で「監査ログ全件・アクセスログ全件（IP/UA付き）・棚卸CSVには到達不可」と
 * 確定した。③に必要なのは §4.2 のリセット代行（代理店系のみ。canResetCredentialsOn）であり、
 * 全社の監査記録を参照する必要はない。
 * ③は人数が多い想定のロール（§4「PS2課の代理店担当（エリア営業SV含む）」）のため、
 * IP/UA を含む全社のアクセス履歴を広く参照可能にしない（最小権限）。
 *
 * 「変更」（update = ①②）を情報源にしているのは、§5.1 の原表で③が持たない操作のうち
 * 管理系の主体を表すのがこの列だからである（ロール配列は直書きしない §3.2）。
 */
export function canViewAuditRecords(role: Role): boolean {
  return can(role, "airis-account", "update");
}

/**
 * ベンダー区分（Account.isVendor = サスラボ社保守区分）の変更可否（§10.1 / SEC要件①）。
 * 保守ベンダー自身の区分付与なので、①の発行と同じ主体（①のみ）に限定する。
 */
export function canManageVendorFlag(role: Role): boolean {
  return canUpdateSettings(role) && isVendorAdminRole(role);
}

/**
 * テナント（代理店）単位のデータ一括削除の実行可否（§10.3 / SEC要件②#31）。
 * 影響範囲が代理店配下の全業務データに及ぶ不可逆性の高い操作のため、
 * §5.1「Airisアカウント / 削」（①②）のうち①に限定する。
 */
export function canEraseTenantData(role: Role): boolean {
  return can(role, "airis-account", "delete") && isVendorAdminRole(role);
}

/**
 * 個人情報のオンデマンド削除（匿名化）の実行可否（§10.3 / §3.4）。
 * 対象1件の個人情報カラムのみを消す操作なので §5.1「Airisアカウント / 削」（①②）と同一範囲。
 */
export function canAnonymizePii(role: Role): boolean {
  return can(role, "airis-account", "delete");
}

/**
 * パスワード・MFAのリセット代行の実行可否（§4.2「②③が実行、監査ログ必須」）。
 * ②③が共通で持つ操作は「承」（approve_final = ①②③）なのでこれで判定する。
 * 「変」（update = ①②）で判定すると③が実行できず §4.2 を満たせない。
 * 発注者指示（2026-08-05「③の管理画面を〇」）と整合する。
 *
 * ただし **これは「操作そのものを持つか」の判定にとどまる**。
 * 実際にどのアカウントへ実行できるかは対象ロールによる職務分離（§6.1-3 / 要件1-1）で更に絞る。
 * ボタンの出し分けには対象ロールも渡す `canResetCredentialsOn()` を使うこと。
 */
export function canResetCredentials(role: Role): boolean {
  return canAdminAccountOp(role, "reset_password");
}

/**
 * 「このアカウントに対して」リセット代行できるか（操作権限 + 職務分離）。
 * UI（ボタンの出し分け）とサーバ側（accountAction）の双方で同じ規則を使う（§3.2 多層防御）。
 * 職務分離の規則は最終承認と共通（account-requests/approval-rules.ts）。
 */
export function canResetCredentialsOn(role: Role, targetRole: string): boolean {
  return canResetCredentials(role) && canResetCredentialsFor(role, targetRole);
}

/** アカウントの停止・再開の可否（§5.1「停」= ①②）。判定は ADMIN_OP_PERMISSION から導出する */
export function canSuspendAccount(role: Role): boolean {
  return canAdminAccountOp(role, "suspend");
}

/** アカウントの削除・復旧の可否（§5.1「削」= ①②）。判定は ADMIN_OP_PERMISSION から導出する */
export function canDeleteAccount(role: Role): boolean {
  return canAdminAccountOp(role, "delete");
}

/** アカウント情報・ロールの変更可否（§5.1「変」= ①②） */
export function canUpdateAccount(role: Role): boolean {
  return can(role, "airis-account", "update");
}
