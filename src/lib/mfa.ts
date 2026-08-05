import "server-only";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";
import type { Role } from "./roles";

// ===== MFA（TOTP / §4.2）=====
// ID/パスワード認証の後段としてTOTP（Google Authenticator等）を要求する。
// ①〜⑧⑩は必須（未登録なら初回ログイン時にQRコードで登録）、⑨販売員は機能必須・利用任意。

export const MFA_ISSUER = "Airis";
export const MFA_MAX_ATTEMPTS = 5; // 連続失敗でセッション破棄→ログインからやり直し

// 時計ずれ許容: 前後30秒（1ステップ）
const EPOCH_TOLERANCE_SEC = 30;

// ⑨（販売員）のみ利用任意（§4.2）。実効ロールでなく生ロールで判定する
// （稼働終了代理店の⑦⑧=⑩も必須のため）。
export function mfaRequiredForRole(rawRole: Role): boolean {
  return rawRole !== "R9";
}

export function generateMfaSecret(): string {
  return generateSecret(); // base32（160bit）
}

export function verifyMfaCode(code: string, secret: string): boolean {
  const token = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return verifySync({ secret, token, epochTolerance: EPOCH_TOLERANCE_SEC }).valid;
  } catch {
    return false;
  }
}

// otpauth:// URL とQRコード（data URL）。認証アプリ（推奨: Google Authenticator）で読み取る
export function mfaKeyUri(loginId: string, secret: string): string {
  return generateURI({ issuer: MFA_ISSUER, label: loginId, secret });
}

export async function mfaQrDataUrl(loginId: string, secret: string): Promise<string> {
  return QRCode.toDataURL(mfaKeyUri(loginId, secret), { width: 220, margin: 1 });
}
