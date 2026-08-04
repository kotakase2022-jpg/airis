import { PrismaClient } from "@prisma/client";

// 素のPrismaクライアント（RLS拡張なし）。
// セッション解決（非保護テーブルのみ参照）と、RLS拡張内部のset_configトランザクションに使用。
// APP_DATABASE_URL: RLSが適用される専用アプリロール(airis_app, NOBYPASSRLS)での接続。
// 未設定時は DATABASE_URL（オーナー接続。オーナーがBYPASSRLSを持つ環境ではRLS無効）。
const globalForPrisma = globalThis as unknown as { basePrisma?: PrismaClient };

export const basePrisma =
  globalForPrisma.basePrisma ??
  new PrismaClient({
    datasourceUrl: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.basePrisma = basePrisma;
