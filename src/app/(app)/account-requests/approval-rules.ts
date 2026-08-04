// Airisアカウント申請の最終承認・却下に関する職務分離ルール（SPEC §6.1-3 / 要件1-1）
//
// §6.1-3: 「SNC側の最終承認は基本③、②でも可。SNC内部からの申請は②が承認。
//          SNC一般以上のアカウント発行・権限変更・停止・削除は必ずSNC課長以上（②）の承認を要する」
// → 申請対象ロールがSNC系（①〜⑥）の申請は①②のみ最終承認・却下でき、③（SNC運用者）は
//   代理店系（⑦⑧⑩）の最終承認・却下に限定される（職務分離）。
// UI層（一覧の操作ボタン）とサーバ側（server action）の双方でこの判定を用いる（§3.2）。
import { SNC_ADMIN_ROLES, type Role } from "@/lib/roles";

// 申請対象ロールのうち「SNC系」= ①〜⑥（SNC一般以上のアカウント）
export const SNC_TARGET_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6"];

// SNC系ロールの申請を最終承認できるのは①②（SNC課長以上）のみ
export const SNC_TARGET_APPROVER_ROLES: Role[] = ["R1", "R2"];

export const SNC_TARGET_DENIED_MESSAGE =
  "SNC系ロール（①〜⑥）のアカウント発行はSNC課長以上（②）の承認が必要です";

// 最終承認（および却下）の可否。actorRole=操作者のロール / targetRole=申請対象ロール
export function canFinalApproveRequest(actorRole: Role, targetRole: string): boolean {
  if (!SNC_ADMIN_ROLES.includes(actorRole)) return false;
  if (SNC_TARGET_ROLES.includes(targetRole as Role)) {
    return SNC_TARGET_APPROVER_ROLES.includes(actorRole);
  }
  return true;
}
