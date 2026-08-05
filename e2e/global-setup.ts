// E2E実行前の準備: シード済みテストアカウントへ既知のTOTP秘密鍵を事前登録する（§4.2）。
// これによりログインは常に「検証」1ステップで決定的に通過できる（helpers.completeMfaIfNeeded）。
// MFA登録フロー自体は e2e/22-mfa.spec.ts が未登録アカウント（シードのMFAデモ用）で検証する。
import { PrismaClient } from "@prisma/client";
import { ACCOUNTS, TEST_MFA_SECRET } from "./helpers";

export default async function globalSetup() {
  const db = new PrismaClient({
    datasourceUrl: "postgresql://postgres:postgres@localhost:5433/airis",
  });
  const loginIds = Object.values(ACCOUNTS).map((a) => a.loginId);
  await db.account.updateMany({
    where: { loginId: { in: loginIds } },
    data: { mfaSecret: TEST_MFA_SECRET, mfaEnabled: true },
  });
  await db.$disconnect();
}
