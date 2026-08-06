#!/usr/bin/env node
/**
 * 破壊的なローカル作業（seed / migrate / rls）が **本番DBへ向いていないこと** を確認するガード。
 *
 * 経緯（qa/BUG_REPORT.md BUG-OPS01）:
 *   `.env.local` に本番 Neon の接続URLが置かれており、Next.js は .env より .env.local を
 *   優先するため、ローカルで `npm run seed` や日次バッチを動かすと **本番DBを書き換えていた**。
 *   実際に本番へテスト痕跡（匿名化済み販売員1件）が混入した事故がある。
 *
 * 本スクリプトは接続先ホストを検査し、localhost 以外なら **非ゼロ終了して処理を止める**。
 * 本番に対して意図的に実行する場合のみ ALLOW_REMOTE_DB=1 を明示的に付ける
 * （例: 本番マイグレーション `ALLOW_REMOTE_DB=1 npm run migrate:deploy`）。
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

// 検査対象の環境変数（DB接続に使われうるもの）
const KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "APP_DATABASE_URL",
  "RLS_DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];

function hostOf(url) {
  try {
    // postgres:// は URL でパースできる（パスワードに記号があっても host は取れる）
    return new URL(url).hostname;
  } catch {
    // パースできない場合は @host:port 形式から拾う
    const m = String(url).match(/@([^/:?]+)/);
    return m ? m[1] : "";
  }
}

const remote = [];
for (const key of KEYS) {
  const v = process.env[key];
  if (!v) continue;
  const host = hostOf(v);
  if (host && !LOCAL_HOSTS.has(host)) remote.push({ key, host });
}

if (remote.length === 0) {
  process.exit(0);
}

if (process.env.ALLOW_REMOTE_DB === "1") {
  console.warn(
    `[assert-local-db] ALLOW_REMOTE_DB=1 のためリモートDBへの実行を許可します: ` +
      remote.map((r) => `${r.key}→${r.host}`).join(", ")
  );
  process.exit(0);
}

console.error(
  [
    "",
    "  ✖ 中断しました: DB接続先がローカルではありません。",
    "",
    ...remote.map((r) => `      ${r.key} → ${r.host}`),
    "",
    "  ローカル作業で本番DBを書き換える事故（qa/BUG_REPORT.md BUG-OPS01）を防ぐためのガードです。",
    "",
    "  対処:",
    "    - ローカル作業なら .env.local の接続URLを localhost:5433 に直してください",
    "      （本番の接続情報は .env.deploy に置きます。Next.js はこのファイルを読み込みません）",
    "    - 本番に対して意図的に実行するなら ALLOW_REMOTE_DB=1 を付けてください",
    "      例: ALLOW_REMOTE_DB=1 npm run migrate:deploy",
    "",
  ].join("\n")
);
process.exit(1);
