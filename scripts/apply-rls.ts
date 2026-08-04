// RLSポリシー適用スクリプト: npm run rls
// 対象DB: 環境変数 RLS_DATABASE_URL > DATABASE_URL（Neonは非プール接続を使うこと）
import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const url = process.env.RLS_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const prisma = new PrismaClient({ datasourceUrl: url });

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "prisma", "rls.sql"), "utf8");
  const statements = sql
    .split(";")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log(`Applied ${statements.length} RLS statements.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
