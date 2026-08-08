// 本番DBへの事故を防ぐ2つのガードの検証（監査計画 C3 / C4）。
//
// C4: scripts/assert-local-db.cjs は `process.env` しか見ておらず、
//     `.env` / `.env.local` に本番URLを書けば**黙って通過**した。
//     後段の Prisma / prisma/seed.ts は env ファイルを読むため、そのまま本番へ書き込む。
//     しかも旧回帰テストが「接続先が未設定なら通過する」としてこの fail-open を仕様化していた。
//
// C3: scripts/apply-rls.ts は `APP_DB_PASSWORD` 未指定時に開発既定 `airis_app_test` を使う。
//     prisma/rls.sql の DO ブロックはロール既存時に `ALTER ROLE ... PASSWORD` を無条件実行するため、
//     本番で `npm run rls` を打つと**アプリロールのパスワードがリポジトリ既知の値に上書き**される。
//
// ガードは実際にプロセスを起動して終了コードで確認する（実装を読むだけの判定にしない）。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = path.join(ROOT, "scripts", "assert-local-db.cjs");
const LOCAL = "postgresql://postgres:postgres@localhost:5433/airis";
const REMOTE = "postgresql://u:p@ep-dawn-shadow-awcd29b8.c-12.us-east-1.aws.neon.tech/neondb";

// env ファイル経由の検査をするため、一時ディレクトリを cwd にしてガードを起動する
let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "airis-guard-"));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runGuard(env: Record<string, string>, files: Record<string, string> = {}) {
  for (const f of [".env", ".env.local"]) {
    const p = path.join(tmp, f);
    if (files[f] !== undefined) fs.writeFileSync(p, files[f]);
    else if (fs.existsSync(p)) fs.rmSync(p);
  }
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: tmp,
    // 親プロセスの DATABASE_URL 等を引き継がないよう最小限の env にする
    // このリポジトリの ProcessEnv 型は NODE_ENV を必須にしているため明示する
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      NODE_ENV: "test",
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("C4: 破壊的作業のガードは env ファイル経由の本番接続も止める", () => {
  it("接続先の指定がどこにも無ければ通過する（開発の初期状態を止めない）", () => {
    expect(runGuard({}).status).toBe(0);
  });

  it("環境変数がローカルなら通過する", () => {
    expect(runGuard({ DATABASE_URL: LOCAL }).status).toBe(0);
  });

  it("環境変数が本番なら中断する", () => {
    const r = runGuard({ DATABASE_URL: REMOTE });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("中断しました");
  });

  it("**`.env` に本番URLがあれば、環境変数が空でも中断する**（C4 の本体）", () => {
    const r = runGuard({}, { ".env": `DATABASE_URL=${REMOTE}\n` });
    expect(r.status, "env ファイル経由の本番接続を素通ししています").not.toBe(0);
    expect(r.out).toContain(".env");
  });

  it("**`.env.local` に本番URLがあれば中断する**（Next.js が優先して読むファイル）", () => {
    const r = runGuard({}, { ".env.local": `DATABASE_URL="${REMOTE}"\n` });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(".env.local");
  });

  it("env ファイルがローカルなら通過する（開発者の .env を誤検出しない）", () => {
    expect(runGuard({}, { ".env": `DATABASE_URL=${LOCAL}\n` }).status).toBe(0);
  });

  it("環境変数（ローカル）が env ファイル（本番）より優先される", () => {
    // 実行時に渡した値が実際に使われるため、上位層で解決したら下位は見ない
    const r = runGuard({ DATABASE_URL: LOCAL }, { ".env": `DATABASE_URL=${REMOTE}\n` });
    expect(r.status).toBe(0);
  });

  it("E2Eが使う QA_DATABASE_URL も検査対象（シード秘密鍵を書き込むため）", () => {
    const r = runGuard({ QA_DATABASE_URL: REMOTE });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("QA_DATABASE_URL");
  });

  it("ALLOW_REMOTE_DB=1 なら本番でも通過する（意図的な本番作業）", () => {
    const r = runGuard({ DATABASE_URL: REMOTE, ALLOW_REMOTE_DB: "1" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("ALLOW_REMOTE_DB=1");
  });

  it("ALLOW_REMOTE_DB=1 は env ファイル経由でも同様に効く", () => {
    const r = runGuard({ ALLOW_REMOTE_DB: "1" }, { ".env": `DATABASE_URL=${REMOTE}\n` });
    expect(r.status).toBe(0);
  });
});

describe("C3: 本番へのRLS適用は APP_DB_PASSWORD を必須にする", () => {
  it("ローカルなら未指定でも通過する（開発既定 airis_app_test で動く）", async () => {
    const { assertAppPasswordForRemote } = await import("../../scripts/apply-rls");
    const { isLocalHost, hostOf } = await import("../../scripts/db-target.cjs");
    expect(() => assertAppPasswordForRemote(LOCAL, undefined, isLocalHost, hostOf)).not.toThrow();
  });

  it("**リモートで未指定なら中断する**（パスワードが公開値に上書きされるのを防ぐ）", async () => {
    const { assertAppPasswordForRemote } = await import("../../scripts/apply-rls");
    const { isLocalHost, hostOf } = await import("../../scripts/db-target.cjs");
    expect(() => assertAppPasswordForRemote(REMOTE, undefined, isLocalHost, hostOf)).toThrow(
      /APP_DB_PASSWORD/
    );
  });

  it("空文字も未指定として扱う（?? を通り抜けるため）", async () => {
    const { assertAppPasswordForRemote } = await import("../../scripts/apply-rls");
    const { isLocalHost, hostOf } = await import("../../scripts/db-target.cjs");
    expect(() => assertAppPasswordForRemote(REMOTE, "", isLocalHost, hostOf)).toThrow();
    expect(() => assertAppPasswordForRemote(REMOTE, "   ", isLocalHost, hostOf)).toThrow();
  });

  it("リモートでも指定されていれば通過する", async () => {
    const { assertAppPasswordForRemote } = await import("../../scripts/apply-rls");
    const { isLocalHost, hostOf } = await import("../../scripts/db-target.cjs");
    expect(() =>
      assertAppPasswordForRemote(REMOTE, "prod-secret", isLocalHost, hostOf)
    ).not.toThrow();
  });

  it("rls.sql がロール既存時にパスワードを上書きする実装であること（ガードが必要な根拠）", () => {
    const sql = fs.readFileSync(path.join(ROOT, "prisma", "rls.sql"), "utf8");
    expect(sql).toContain("__APP_DB_PASSWORD__");
    expect(sql, "ALTER ROLE でのパスワード設定が無いなら前提が変わっている").toMatch(
      /ALTER ROLE airis_app[\s\S]{0,80}PASSWORD/
    );
  });
});

describe("判定ロジックが1箇所に集約されていること（複製による片側修正の防止）", () => {
  it("assert-local-db.cjs と apply-rls.ts は db-target.cjs を使う", () => {
    const guard = fs.readFileSync(GUARD, "utf8");
    const rls = fs.readFileSync(path.join(ROOT, "scripts", "apply-rls.ts"), "utf8");
    expect(guard).toContain("db-target.cjs");
    expect(rls).toContain("db-target.cjs");
    // ローカルホスト一覧を各自が持たない（持つと判定がずれる）
    expect(guard, "assert-local-db.cjs がローカルホスト一覧を再定義しています").not.toContain(
      "127.0.0.1"
    );
    expect(rls, "apply-rls.ts がローカルホスト一覧を再定義しています").not.toContain("127.0.0.1");
  });
});
