import { Prisma } from "@prisma/client";
import { basePrisma } from "./prisma-base";
import { resolveSession } from "./session";

// RLS: 各クエリを set_config + クエリ本体 のトランザクションで包み、
// Postgres 側の行レベルセキュリティポリシー（prisma/rls.sql）にスコープを伝える。
// セッションはリクエストキャッシュ（resolveSession）から解決する。
// セッションが無い場合（ログイン処理・非保護テーブルのみのパス）は素通し
// （保護テーブルはポリシーにより既定拒否 = fail-closed）。
function buildClient() {
  const client = basePrisma.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          const session = await resolveSession().catch(() => null);
          if (!session) return query(args);
          const { rls } = session;
          const setting = rls.bypass
            ? basePrisma.$executeRaw`SELECT set_config('app.bypass', 'on', TRUE)`
            : basePrisma.$executeRaw`SELECT set_config('app.bypass', 'off', TRUE), set_config('app.scope', ${rls.scope.join(",")}, TRUE)`;
          const [, result] = await basePrisma.$transaction([
            setting,
            query(args) as unknown as Prisma.PrismaPromise<unknown>,
          ]);
          return result;
        },
      },
    },
  });
  return client;
}

type ExtendedClient = ReturnType<typeof buildClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedClient };

export const prisma: ExtendedClient = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
