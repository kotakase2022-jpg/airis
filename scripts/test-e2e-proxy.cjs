// プロキシ配下（TRUST_PROXY=true）で起動したサーバーに対して
// x-forwarded-for の末尾hop採用を検証する（§10.1）。
// QA_TRUST_PROXY=true を必ず設定して Playwright を起動するため、
// 実行者が環境変数を忘れても正しい構成で走る。
const { spawnSync } = require("child_process");

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(npx, ["playwright", "test", "e2e/18-access-log.spec.ts"], {
  stdio: "inherit",
  env: { ...process.env, QA_TRUST_PROXY: "true" },
});
process.exit(result.status ?? 1);
