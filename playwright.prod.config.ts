import { defineConfig } from "@playwright/test";

// 本番スモークテスト設定（読み取り専用）
export default defineConfig({
  testDir: "./e2e-prod",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  retries: 1,
  reporter: [
    ["list"],
    ["json", { outputFile: "../qa/evidence/prod-smoke-results.json" }],
  ],
  use: {
    baseURL: "https://airis-nine.vercel.app",
    screenshot: "on",
  },
  outputDir: "../qa/evidence/prod-artifacts",
});
