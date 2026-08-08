// RLSポリシー適用スクリプト: npm run rls
// 対象DB: 環境変数 RLS_DATABASE_URL > DATABASE_URL（Neonは非プール接続を使うこと）
// ※オーナー（テーブル所有者）接続で実行する。GRANT/REVOKE（§10.4 AuditLogのappend-only）を含むため。
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";
// ローカル判定は scripts/db-target.cjs に集約（assert-local-db.cjs と同じ判定を使う）
const { isLocalHost, hostOf } = require("./db-target.cjs") as {
  isLocalHost: (host: string) => boolean;
  hostOf: (url: string) => string;
};

const url = process.env.RLS_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: url });

// SQLを文単位に分割する。
// 行コメント（--）を除去した上で、文字列リテラル（'...'）とドル引用符（$$ ... $$ / $tag$ ... $tag$）の
// 内側にあるセミコロンは区切りとして扱わない（DOブロックを1文として実行するため）。
export function splitStatements(sql: string): string[] {
  const src = sql.replace(/--[^\n]*/g, "");
  const statements: string[] = [];
  let buf = "";
  let inString = false;
  let dollarTag: string | null = null;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (dollarTag) {
      if (src.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
      } else {
        buf += ch;
        i += 1;
      }
      continue;
    }
    if (inString) {
      buf += ch;
      i += 1;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      buf += ch;
      i += 1;
      continue;
    }
    const dollar = /^\$[A-Za-z_0-9]*\$/.exec(src.slice(i));
    if (dollar) {
      dollarTag = dollar[0];
      buf += dollar[0];
      i += dollar[0].length;
      continue;
    }
    if (ch === ";") {
      statements.push(buf.trim());
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  statements.push(buf.trim());
  return statements.filter((s) => s.length > 0);
}

/**
 * 本番に対して `npm run rls` を実行するとき、`APP_DB_PASSWORD` の指定を必須にする（C3 の是正）。
 *
 * `prisma/rls.sql` の DO ブロックは、ロールが既に存在する場合に
 * `ALTER ROLE airis_app LOGIN PASSWORD %L` を**無条件で実行**する。
 * `APP_DB_PASSWORD` 未指定だと開発既定 `airis_app_test`（リポジトリに書かれている値）で
 * 上書きされ、**本番のアプリロールのパスワードが公開値になる**うえ、
 * Vercel 側の `APP_DATABASE_URL` と食い違ってアプリがDBに接続できなくなる。
 *
 * ローカル（localhost 等）では従来どおり既定値で動く。CI もローカルホストなので影響しない。
 */
export function assertAppPasswordForRemote(
  url: string,
  appPassword: string | undefined,
  isLocal: (host: string) => boolean,
  hostOf: (u: string) => string
): void {
  const host = hostOf(url);
  if (!host || isLocal(host)) return; // ローカルは既定値で可
  if (appPassword && appPassword.trim() !== "") return;
  throw new Error(
    [
      "",
      `  ✖ 中断しました: 本番等のリモートDB（${host}）に対して APP_DB_PASSWORD が未指定です。`,
      "",
      "  このまま実行すると prisma/rls.sql が airis_app のパスワードを",
      "  リポジトリに書かれた開発既定値 'airis_app_test' で**上書き**します。",
      "  本番のアプリロールのパスワードが公開値になり、Vercel の APP_DATABASE_URL とも",
      "  食い違ってアプリがDBへ接続できなくなります。",
      "",
      "  対処: 本番と同じ値を指定して実行してください。",
      "    ALLOW_REMOTE_DB=1 RLS_DATABASE_URL=<非プールURL> APP_DB_PASSWORD=<本番値> npm run rls",
      "",
      "  パスワードを変更する場合は、Vercel の APP_DATABASE_URL も同じ作業で更新すること",
      "  （docs/OPERATIONS.md §2.4）。",
      "",
    ].join("\n")
  );
}

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "prisma", "rls.sql"), "utf8");
  // アプリロール（airis_app）のパスワードを rls.sql のプレースホルダへ埋め込む（§3.1）。
  // セッション変数（SET LOCAL）は接続プールをまたぐと失われるため文字列置換にしている。
  // ローカルは開発既定（airis_app_test）。**リモートでは APP_DB_PASSWORD 必須**（上のガード）。
  assertAppPasswordForRemote(url!, process.env.APP_DB_PASSWORD, isLocalHost, hostOf);
  const appPassword = process.env.APP_DB_PASSWORD ?? "airis_app_test";
  const sql = raw.replaceAll("__APP_DB_PASSWORD__", appPassword.replace(/'/g, "''"));
  const statements = splitStatements(sql);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`Applied ${statements.length} RLS statements.`);
  console.log(
    `アプリロール airis_app を作成/更新しました（パスワードは ${
      process.env.APP_DB_PASSWORD ? "APP_DB_PASSWORD" : "開発既定 airis_app_test"
    }）。APP_DATABASE_URL はこのロールで接続します。`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
