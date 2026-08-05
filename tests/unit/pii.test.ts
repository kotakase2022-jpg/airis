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
