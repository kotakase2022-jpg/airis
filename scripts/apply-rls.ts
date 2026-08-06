// RLSポリシー適用スクリプト: npm run rls
// 対象DB: 環境変数 RLS_DATABASE_URL > DATABASE_URL（Neonは非プール接続を使うこと）
// ※オーナー（テーブル所有者）接続で実行する。GRANT/REVOKE（§10.4 AuditLogのappend-only）を含むため。
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

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

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, "..", "prisma", "rls.sql"), "utf8");
  // アプリロール（airis_app）のパスワードを rls.sql のプレースホルダへ埋め込む（§3.1）。
  // セッション変数（SET LOCAL）は接続プールをまたぐと失われるため文字列置換にしている。
  // 未指定なら開発既定（airis_app_test）。**本番では必ず APP_DB_PASSWORD を指定すること**。
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
