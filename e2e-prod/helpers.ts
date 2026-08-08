// 本番検証（e2e-prod）の共通ヘルパー。
//
// **1箇所に集約する理由**（QA loop5 の事故を受けた措置）:
//   以前は prod-smoke.spec.ts と prod-authz-verify.spec.ts が `db()` とMFA通過処理を
//   **それぞれ複製**していた。MFAを登録してしまう不具合を prod-smoke 側だけ直した結果、
//   複製側が残って**本番アカウント2件（②③）を新たに登録してしまった**。
//   同じ乖離を繰り返さないため、両specはこのモジュールだけを使う。

import { expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { generateSync } from "otplib";
import fs from "node:fs";

export const PW_ADMIN = "Airis-Demo-Admin-2026!x";
export const PW_GENERAL = "Airis-Demo-2026!";

let _db: PrismaClient | null = null;

/**
 * 本番DBへの読み取り用クライアント。
 * 接続情報は `.env.deploy` から読む（Next.js が読み込まないファイル）。
 * `.env.local` に本番URLを置くと `npm run dev` / `npm run seed` / 日次バッチが
 * 本番DBへ書き込む（BUG-OPS01 の再発防止）。
 */
export function db(): PrismaClient {
  if (!_db) {
    const raw = fs.readFileSync(".env.deploy", "utf8");
    const m = raw.match(/^DATABASE_URL_UNPOOLED="?([^"\r\n]+)/m);
    if (!m)
      throw new Error(".env.deploy に DATABASE_URL_UNPOOLED がありません（本番接続情報の置き場）");
    _db = new PrismaClient({ datasourceUrl: m[1] });
  }
  return _db;
}

export async function disconnectDb(): Promise<void> {
  await _db?.$disconnect();
  _db = null;
}

/**
 * ログイン後にMFAの**検証**画面が出たら、登録済みの秘密鍵からコードを生成して通過する。
 * ⑨（MFA任意）などMFAが出ない場合はそのまま返る。
 *
 * **MFAの登録は絶対に行わない。**
 *   以前の実装は `/mfa/setup`（未登録アカウントの初回登録画面）に到達すると、
 *   サーバが発行した秘密鍵をDBから読んでそのまま「登録して続行」を押していた。
 *   その結果、**利用者が知らない秘密鍵でMFAが本登録され、本人がログインできなくなった**
 *   （実測: ①airis_slb_sys_001 の最後の mfa_enroll が 2026-08-05T12:11:42Z /
 *   IP 150.249.201.199 = テスト実行元。利用者自身の登録 04:06 を上書きしていた）。
 *   本番は実運用に入っており、検証が本番のMFA状態を変えてはならない。
 *
 * 未登録アカウントに当たった場合は**前提不成立として明示的に失敗**させる（登録しない・skipしない）。
 */
export async function passMfaOrFail(page: Page, loginId: string): Promise<void> {
  await page.waitForURL(/\/(dashboard|password|mfa)/, { timeout: 30_000 });
  if (!page.url().includes("/mfa")) return;

  if (page.url().includes("/mfa/setup")) {
    // ここでコードを入力するとMFAを本登録してしまう。何もせずに失敗させる。
    throw new Error(
      `${loginId}: MFA未登録のため検証できません（前提不成立）。` +
        `この検証は本番のMFA登録状態を変更しません。` +
        `管理画面またはQRコードから当該アカウントのMFAを登録してから再実行してください。`
    );
  }

  const acc = await db().account.findUnique({ where: { loginId } });
  expect(acc?.mfaSecret, `${loginId}: 登録済みの秘密鍵が読めること`).toBeTruthy();
  expect(acc?.mfaEnabled, `${loginId}: MFAが有効化済みであること（登録は行わない）`).toBe(true);
  await page.locator('input[name="code"]').fill(generateSync({ secret: acc!.mfaSecret! }));
  await page.getByRole("button", { name: "認証する" }).click(); // 「登録して続行」は押さない
  await page.waitForURL(/\/(dashboard|password)/, { timeout: 30_000 });
}

/** ID/パスワードでログインし、MFA検証まで通す（登録は行わない） */
export async function login(page: Page, loginId: string, pw: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="loginId"]').fill(loginId);
  await page.locator('input[name="password"]').fill(pw);
  await page.getByRole("button", { name: "ログイン" }).click();
  await passMfaOrFail(page, loginId);
}
