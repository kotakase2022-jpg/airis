// `STATUS_ENTITY_TYPES` に宣言したエンティティに、実際の記録経路があることを検査する（§4.1 / 監査計画 C6）。
//
// 経緯（QA loop5）:
//   `submission` は `src/lib/status.ts` の `STATUS_ENTITY_TYPES` に宣言され、
//   `prisma/schema.prisma` も StatusHistory を「本テーブルを正の追跡元とする」と書いていたのに、
//   `src/app/(app)/reports/actions.ts` は `@/lib/status` を **import すらしておらず**、
//   7つの遷移（新規提出・再提出・差し替え・1次承認・最終承認・差戻し・削除）が
//   StatusHistory に1行も記録されていなかった。
//   さらに qa/REQUIREMENTS_TRACEABILITY.csv の R-022 が「case / submission は既存」として
//   PASS 判定になっており、**宣言・文書・判定の3つが揃って実態と食い違っていた**。
//
// 「宣言はあるが実行経路が無い」— loop3〜loop5 で繰り返し出た欠陥型。静的検査で再発を止める。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_ENTITY_TYPES } from "@/lib/status";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = path.join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const strip = (b: string) => b.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// 定義元（status.ts 自身）を除いた実装コード
const bodies = walk(SRC)
  .filter((f) => !f.endsWith(path.join("lib", "status.ts")))
  .map((f) => ({
    file: path.relative(ROOT, f).replaceAll("\\", "/"),
    body: strip(fs.readFileSync(f, "utf8")),
  }));

describe("§4.1 状態遷移履歴: 宣言したエンティティには記録経路がある（C6 の再発防止）", () => {
  it("走査対象を読めている（空振り防止）", () => {
    expect(bodies.length).toBeGreaterThan(20);
    expect(STATUS_ENTITY_TYPES.length).toBeGreaterThan(3);
  });

  it('**STATUS_ENTITY_TYPES の全種別に `entityType: "<種別>"` の書き込みが存在する**', () => {
    const missing = STATUS_ENTITY_TYPES.filter(
      (t) => !bodies.some((b) => b.body.includes(`entityType: "${t}"`))
    );
    expect(
      missing,
      `StatusHistory に宣言されているのに記録経路が無い種別です（§4.1 の追跡が成立しません）: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("稼働提出物の7遷移すべてが記録される（新規・再提出・差し替え・1次承認・最終承認・差戻し・削除）", () => {
    const reports = bodies.find((b) => b.file === "src/app/(app)/reports/actions.ts");
    expect(reports, "reports/actions.ts が見つからない").toBeTruthy();
    const calls = [...reports!.body.matchAll(/await track\(/g)].length;
    expect(
      calls,
      "稼働提出物の遷移記録が7箇所に届いていません（新規/再提出/差し替え/1次承認/最終承認/差戻し/削除）"
    ).toBeGreaterThanOrEqual(7);
    // 記録している種別が submission であること
    expect(reports!.body).toContain('entityType: "submission"');
  });

  it("記録に使うイベント名は STATUS_EVENTS の値である（綴り違いを防ぐ）", async () => {
    const { STATUS_EVENTS } = await import("@/lib/status");
    const reports = bodies.find((b) => b.file === "src/app/(app)/reports/actions.ts")!;
    const used = [...reports.body.matchAll(/await track\(\s*[^,]+,\s*"(\w+)"/g)].map((m) => m[1]);
    expect(used.length, "track の呼び出しからイベント名を取得できない").toBeGreaterThan(0);
    for (const e of used) {
      expect(STATUS_EVENTS as readonly string[], `未定義のイベント名: ${e}`).toContain(e);
    }
  });

  it("検出器そのものが機能している（自己検査）", () => {
    // 存在しない種別は検出される＝空振りしていない
    expect(bodies.some((b) => b.body.includes('entityType: "no_such_entity"'))).toBe(false);
    // 実在する種別は拾える
    expect(bodies.some((b) => b.body.includes('entityType: "sales_staff"'))).toBe(true);
  });
});
