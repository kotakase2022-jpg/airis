// ローカル作業が本番DBを書き換える事故を防ぐガード（scripts/assert-local-db.cjs）の単体テスト。
//
// 経緯（qa/BUG_REPORT.md BUG-OPS01 / QA loop4 で critical と判定）:
//   `.env.local` に本番 Neon の接続URLが置かれており、Next.js は .env より .env.local を
//   優先するため、ローカルで `npm run seed` や日次バッチを動かすと **本番DBを書き換えていた**。
//   実際に本番へテスト痕跡が混入した事故がある。
//   接続情報の置き場を .env.deploy へ分離したうえで、破壊的な npm script
//   （seed / rls / migrate / migrate:deploy）の前段にこのガードを噛ませている。
//
// ここでは実際にスクリプトを子プロセスで起動し、**終了コード**で検証する
// （環境変数の読み取り位置やホスト抽出の実装に依存しない、外形的な検証）。

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "assert-local-db.cjs");

function run(env: Record<string, string | undefined>) {
  // 親プロセスの DATABASE_URL 等を持ち込まないよう、必要な変数だけを渡す
  // このリポジトリは NODE_ENV を必須として型宣言しているため明示する（値は検査に影響しない）
  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "test",
    ...env,
  } as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [SCRIPT], { env: childEnv, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

const PROD = "postgresql://u:p@ep-dawn-shadow-awcd29b8-pooler.c-12.us-east-1.aws.neon.tech/neondb";
const LOCAL = "postgresql://postgres:postgres@localhost:5433/airis";

describe("assert-local-db（本番DBへの誤操作ガード）", () => {
  it("接続先が未設定なら通過する（DB以外の作業を止めない）", () => {
    expect(run({}).code).toBe(0);
  });

  it.each([
    ["localhost", LOCAL],
    ["127.0.0.1", "postgresql://postgres:postgres@127.0.0.1:5433/airis"],
    ["host.docker.internal", "postgresql://postgres:postgres@host.docker.internal:5433/airis"],
  ])("ローカル接続（%s）は通過する", (_label, url) => {
    expect(run({ DATABASE_URL: url }).code).toBe(0);
  });

  it("**本番（Neon）を指していたら非ゼロで中断する**", () => {
    const r = run({ DATABASE_URL: PROD });
    expect(r.code, "本番DBを指しているのに処理が続行された").not.toBe(0);
    expect(r.out).toContain("中断しました");
    expect(r.out).toContain("us-east-1"); // どの接続先が問題かを示す
  });

  it.each([
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "APP_DATABASE_URL",
    "RLS_DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
  ])("%s がリモートを指していても検出する（1つでも漏れたら事故になる）", (key) => {
    expect(run({ [key]: PROD }).code, `${key} が検査対象から漏れている`).not.toBe(0);
  });

  it("ローカルとリモートが混在していても中断する（安全側に倒す）", () => {
    expect(run({ DATABASE_URL: LOCAL, APP_DATABASE_URL: PROD }).code).not.toBe(0);
  });

  it("ALLOW_REMOTE_DB=1 を明示したときだけリモートを許可する（本番マイグレーション用）", () => {
    const r = run({ DATABASE_URL: PROD, ALLOW_REMOTE_DB: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ALLOW_REMOTE_DB=1"); // 許可したことを必ず表示する
  });

  it("ALLOW_REMOTE_DB が 1 以外なら許可しない（真偽値の取り違え防止）", () => {
    for (const v of ["0", "true", "yes", ""]) {
      expect(run({ DATABASE_URL: PROD, ALLOW_REMOTE_DB: v }).code, `ALLOW_REMOTE_DB=${v}`).not.toBe(
        0
      );
    }
  });

  it("パースできない接続文字列でもホストを拾って判定する", () => {
    expect(run({ DATABASE_URL: "not-a-url@ep-x.us-east-1.aws.neon.tech/db" }).code).not.toBe(0);
  });
});
