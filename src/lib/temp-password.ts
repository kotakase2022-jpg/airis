import "server-only";
import crypto from "crypto";
import { passwordMinLength, type PasswordPolicy } from "./password-policy";

// =============================================================================
// 管理者代行フローで発行する一時パスワードの生成（§4.2）
//
// 桁数は **パスワードポリシー（src/lib/password-policy.ts）から導出** する。
// 以前は呼び出し側で 24/16 を直書きしていたため、PASSWORD_MIN_ADMIN /
// PASSWORD_MIN_GENERAL を引き上げると「発行された一時パスワードが最小桁数を
// 満たさず、そのままでは変更画面を通らない」状態になり得た（SEC-004）。
// ここで最小桁数 + 余裕分を常に確保することで、ポリシーを変えても整合を保つ。
//
// 発行経路（いずれもこの関数を使う）:
//   - src/app/(app)/admin/actions.ts   管理者によるパスワードリセット
//   - src/app/(app)/account-requests/actions.ts  アカウント申請の最終承認時の初期発行
//   - src/app/(app)/sales-staff/actions.ts       販売員ID最終承認時のR9アカウント発行
// =============================================================================

// 最小桁数に対する上乗せ分。ポリシー最小＝弱い側の境界なので、発行値は必ず余裕を持たせる。
const EXTRA_LENGTH = 4;

// 紛らわしい文字（I/l/O/0/1）を除いた集合。電話・口頭での伝達ミスを防ぐ（§4.2 運用）。
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const ALL = UPPER + LOWER + DIGITS;

/**
 * ロールのポリシー最小桁数 + EXTRA_LENGTH の長さで一時パスワードを生成する。
 * 英大文字・英小文字・数字を必ず1文字以上含む（§4.2 の形式要件を満たす）。
 * 乱数は crypto.randomInt（一様分布。`% chars.length` の偏りを避ける）。
 */
export function generateTempPassword(role: string, policy?: PasswordPolicy): string {
  const len = tempPasswordLength(role, policy);
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS)];
  while (chars.length < len) chars.push(pick(ALL));
  // Fisher-Yates（先頭3文字が常に大・小・数字になるのを崩す）
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** 発行される一時パスワードの桁数（テストから検証できるよう分離 §13） */
export function tempPasswordLength(role: string, policy?: PasswordPolicy): number {
  return passwordMinLength(role, policy) + EXTRA_LENGTH;
}
