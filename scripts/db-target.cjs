/**
 * DB接続先が「ローカルか本番か」を判定する共通モジュール。
 *
 * `scripts/assert-local-db.cjs`（破壊的作業のガード）と `scripts/apply-rls.ts`
 * （本番パスワード上書きのガード）が**同じ判定**を使うために切り出している。
 * 判定が2箇所に複製されると、片方だけ直して片方が事故を起こす
 * （QA loop5 で e2e-prod のMFA処理が複製されていて実際にそれが起きた）。
 *
 * **環境変数だけでなく `.env.local` / `.env` も読む**のが要点（C4 の是正）:
 *   Prisma も Next.js も env ファイルを読むため、`process.env` だけを検査するガードは
 *   「`.env` に本番URLを書けば素通しできる」という穴になっていた。
 *   実際、旧実装は「接続先が未設定なら通過」を仕様として回帰テストで固定していたが、
 *   その"未設定"はファイル由来の値を見ていないだけだった。
 */
const fs = require("node:fs");
const path = require("node:path");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

// 検査対象の環境変数（DB接続に使われうるもの）
const KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "APP_DATABASE_URL",
  "RLS_DATABASE_URL",
  "QA_DATABASE_URL", // e2e/helpers.ts と e2e/global-setup.ts が使う（書き込みを伴う）
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
];

// 読み込む env ファイル（優先順は Next.js / Prisma と同じく .env.local が先）
const ENV_FILES = [".env.local", ".env"];

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

/** `KEY=VALUE` 形式を素朴にパースする（dotenv 依存を増やさないため自前） */
function parseEnvFile(file) {
  const out = {};
  let body;
  try {
    body = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    // 行末コメントは引用符が無い場合のみ落とす
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
    out[m[1]] = v;
  }
  return out;
}

/**
 * 接続先がローカルでないものを列挙する。
 * @param {string} cwd 解決の基準ディレクトリ（既定はプロセスのcwd）
 * @returns {{key:string, host:string, source:string}[]}
 */
function findRemoteTargets(cwd = process.cwd()) {
  // 優先順: process.env > .env.local > .env（先に見つかったものを採用）
  const layers = [{ source: "環境変数", values: process.env }];
  for (const f of ENV_FILES) {
    layers.push({ source: f, values: parseEnvFile(path.join(cwd, f)) });
  }

  const remote = [];
  for (const key of KEYS) {
    for (const layer of layers) {
      const v = layer.values[key];
      if (!v) continue; // この層には無い → 次の層を見る
      const host = hostOf(v);
      if (host && !LOCAL_HOSTS.has(host)) remote.push({ key, host, source: layer.source });
      break; // 優先順の上位で解決したらそのキーは確定
    }
  }
  return remote;
}

function isLocalHost(host) {
  return LOCAL_HOSTS.has(host);
}

module.exports = {
  LOCAL_HOSTS,
  KEYS,
  ENV_FILES,
  hostOf,
  parseEnvFile,
  findRemoteTargets,
  isLocalHost,
};
