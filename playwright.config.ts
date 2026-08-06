import { defineConfig } from "@playwright/test";

// QA E2Eテスト設定
// 前提: ローカル検証サーバー（port 3100、ローカルDocker Postgres + RLS + airis_appロール）が起動済み
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/airis \
//   APP_DATABASE_URL=postgresql://airis_app:airis_app_test@localhost:5433/airis \
//   CRON_SECRET=qa-test-secret PASSWORD_PEPPER_V1=qa-test-pepper-v1 npx next start -p 3100

// パスワードのペッパーは**テストランナー側にも必要**。e2e/13-password-policy.spec.ts は
// アプリと同じ前段ハッシュ（HMAC-SHA256・鍵=ペッパー）を自前で計算してDBのハッシュと突合するため、
// ランナーにペッパーが無いと「無ペッパーで計算した別のハッシュ」と比較して不一致になり、
// アプリの不具合に見える失敗を3件出す（QA loop4・loop5 で2度踏んだ）。
// ローカル既定は上のサーバ起動コマンドと同じ値に合わせる（環境変数が指定済みならそれを尊重）。
process.env.PASSWORD_PEPPER_V1 ??= "qa-test-pepper-v1";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts", // シードアカウントへテスト用MFA秘密鍵を事前登録
  fullyParallel: false,
  workers: 1, // DBを共有するため直列実行（決定性優先）
  timeout: 30_000,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "../qa/evidence/playwright-results.json" }],
    ["html", { outputFolder: "../qa/evidence/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: process.env.QA_BASE_URL ?? "http://localhost:3100",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  outputDir: "../qa/evidence/test-artifacts",
});
