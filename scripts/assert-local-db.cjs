#!/usr/bin/env node
/**
 * 破壊的なローカル作業（seed / migrate / rls / E2E）が **本番DBへ向いていないこと** を確認するガード。
 *
 * 経緯（qa/BUG_REPORT.md BUG-OPS01）:
 *   `.env.local` に本番 Neon の接続URLが置かれており、Next.js は .env より .env.local を
 *   優先するため、ローカルで `npm run seed` や日次バッチを動かすと **本番DBを書き換えていた**。
 *   実際に本番へテスト痕跡（匿名化済み販売員1件）が混入した事故がある。
 *
 * **C4 の是正（QA loop5）**:
 *   旧実装は `process.env` しか見ておらず、`.env` / `.env.local` に本番URLを書けば
 *   ガードを黙って通過した（後段の Prisma / seed はファイルを読むため本番へ書き込む）。
 *   しかも回帰テストが「接続先が未設定なら通過する」としてこの fail-open を仕様化していた。
 *   現在は scripts/db-target.cjs が env ファイルも含めて解決する。
 *
 * 接続先がローカル以外なら **非ゼロ終了して処理を止める**。
 * 本番に対して意図的に実行する場合のみ ALLOW_REMOTE_DB=1 を明示的に付ける
 * （例: 本番マイグレーション `ALLOW_REMOTE_DB=1 npm run migrate:deploy`）。
 */
const { findRemoteTargets } = require("./db-target.cjs");

const remote = findRemoteTargets();

if (remote.length === 0) {
  process.exit(0);
}

if (process.env.ALLOW_REMOTE_DB === "1") {
  console.warn(
    `[assert-local-db] ALLOW_REMOTE_DB=1 のためリモートDBへの実行を許可します: ` +
      remote.map((r) => `${r.key}→${r.host}（${r.source}）`).join(", ")
  );
  process.exit(0);
}

console.error(
  [
    "",
    "  ✖ 中断しました: DB接続先がローカルではありません。",
    "",
    ...remote.map((r) => `      ${r.key} → ${r.host}   （検出元: ${r.source}）`),
    "",
    "  ローカル作業で本番DBを書き換える事故（qa/BUG_REPORT.md BUG-OPS01）を防ぐためのガードです。",
    "",
    "  対処:",
    "    - ローカル作業なら .env.local / .env の接続URLを localhost:5433 に直してください",
    "      （本番の接続情報は .env.deploy に置きます。Next.js はこのファイルを読み込みません）",
    "    - 本番に対して意図的に実行するなら ALLOW_REMOTE_DB=1 を付けてください",
    "      例: ALLOW_REMOTE_DB=1 npm run migrate:deploy",
    "",
  ].join("\n")
);
process.exit(1);
