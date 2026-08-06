import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PII_FIELDS, anonymizeData } from "../../src/lib/pii";

// §8末尾「個人情報カラムは /// @pii をコメントで明示し、匿名化バッチの対象にする」
// スキーマ注釈（schema.prisma）と匿名化定義（src/lib/pii.ts）の一致を検証する。
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const schema = fs.readFileSync(path.join(REPO_ROOT, "prisma/schema.prisma"), "utf8");

// schema.prisma から「/// @pii が付いたカラム」を model 単位で抽出する
function annotatedPiiColumns(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let model: string | null = null;
  let pendingPii = false;
  for (const raw of schema.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^model\s+(\w+)\s*\{/);
    if (m) {
      model = m[1];
      pendingPii = false;
      continue;
    }
    if (line === "}") {
      model = null;
      pendingPii = false;
      continue;
    }
    if (line.startsWith("/// @pii")) {
      pendingPii = true;
      continue;
    }
    if (model && pendingPii) {
      const col = line.match(/^(\w+)\s/);
      if (col) {
        (out[model] = out[model] || []).push(col[1]);
        pendingPii = false;
      }
    }
  }
  return out;
}

describe("PII注釈と匿名化定義の一致（§3.4 / §8）", () => {
  const annotated = annotatedPiiColumns();

  it("schema.prisma に /// @pii 注釈が存在する", () => {
    expect(Object.keys(annotated).length).toBeGreaterThan(0);
    expect(schema).toContain("/// @pii");
  });

  it("注釈されたカラムはすべて匿名化定義（PII_FIELDS）に含まれる", () => {
    const missing: string[] = [];
    for (const [model, cols] of Object.entries(annotated)) {
      const defined = (PII_FIELDS[model] ?? []).map((f) => f.column);
      for (const c of cols) if (!defined.includes(c)) missing.push(`${model}.${c}`);
    }
    expect(missing, "@pii注釈があるのに匿名化対象になっていないカラム").toEqual([]);
  });

  it("匿名化定義のカラムはすべて schema.prisma で /// @pii 注釈されている", () => {
    const missing: string[] = [];
    for (const [model, fields] of Object.entries(PII_FIELDS)) {
      const cols = annotated[model] ?? [];
      for (const f of fields) if (!cols.includes(f.column)) missing.push(`${model}.${f.column}`);
    }
    expect(missing, "匿名化対象なのに@pii注釈が無いカラム").toEqual([]);
  });

  it("anonymizeData は全対象カラムを含む update data を返す", () => {
    for (const model of Object.keys(PII_FIELDS)) {
      const data = anonymizeData(model);
      expect(Object.keys(data).sort()).toEqual(PII_FIELDS[model].map((f) => f.column).sort());
    }
  });

  it("必須（non-null）カラムには null を割り当てない", () => {
    // SalesStaff.lastName/birthDate/phone と AccountRequest.name/email は必須カラム
    for (const [model, col] of [
      ["SalesStaff", "lastName"],
      ["SalesStaff", "birthDate"],
      ["SalesStaff", "phone"],
      ["AccountRequest", "name"],
      ["AccountRequest", "email"],
      ["Account", "name"],
    ] as const) {
      const f = PII_FIELDS[model].find((x) => x.column === col);
      expect(f?.anonymizeTo, `${model}.${col} は必須カラムのためnull不可`).not.toBeNull();
    }
  });
});

// 「定義はあるが誰も呼んでいない」を検出する（§8「@pii列は匿名化バッチの対象にする」）。
//
// 経緯（QA loop5 で検出）:
//   `PII_FIELDS.AccountRequest` は定義され、`schema.prisma` の name/email にも
//   `/// @pii 個人情報（削除後1年で匿名化バッチの対象 §3.4/§8）` が付いていたのに、
//   **`anonymizeData("AccountRequest")` の呼び出しがどこにも無かった**。
//   テナント一括削除・日次匿名化バッチ・オンデマンド匿名化のいずれの対象でもなく、
//   申請レコードの氏名・メールが恒久保持されていた。
//   注釈と定義の一致（上の describe）だけでは**実行経路の有無**を検出できない。
describe("匿名化定義に実行経路があること（宣言と実装の乖離検出）", () => {
  const SRC = path.join(fileURLToPath(new URL("../../", import.meta.url)), "src");

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(e.name)) out.push(full);
    }
    return out;
  }

  // 定義元（pii.ts 自身）を除いた実装コード。コメントは経路ではないので除去して数える。
  const bodies = walk(SRC)
    .filter((f) => !f.endsWith(path.join("lib", "pii.ts")))
    .map((f) =>
      fs
        .readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "")
    );

  it("PII_FIELDS の全モデルに anonymizeData の呼び出しが存在する", () => {
    const missing = Object.keys(PII_FIELDS).filter(
      (model) => !bodies.some((b) => b.includes(`anonymizeData("${model}")`))
    );
    expect(
      missing,
      `匿名化定義があるのに実行経路が無いモデルです（個人情報が恒久保持されます）: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("検出器そのものが機能している（存在しないモデル名は検出される）", () => {
    // 上のテストが常に空配列を返す（＝死んでいる）ことを防ぐ自己検査。
    expect(bodies.length, "src配下のファイルを読めていない").toBeGreaterThan(20);
    expect(bodies.some((b) => b.includes('anonymizeData("NoSuchModel")'))).toBe(false);
    // 実在する呼び出しは拾えること
    expect(bodies.some((b) => b.includes('anonymizeData("Account")'))).toBe(true);
  });
});
