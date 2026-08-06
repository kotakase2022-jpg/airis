// 文書・成果物が「証跡」として挙げているファイルが**実在すること**を検査する（T2）。
//
// 経緯（QA loop5 の独立監査で検出）:
//   QA成果物（qa/REQUIREMENTS_TRACEABILITY.csv / qa/*.md / docs/*.md）が検証証跡として
//   `tests/unit/erasure.test.ts` / `settings.test.ts` / `alert.test.ts` を挙げていたが、
//   **これらのファイルは存在しなかった**。存在しないテストを根拠に要件を PASS と記録していた。
//   ＝「宣言（証跡の記載）と実際（ファイルの実在）」の乖離であり、
//   loop3/loop4 で繰り返した型そのものが、QAの成果物自身にも起きていた。
//
// このテストは、文書中に現れるテストファイルへの参照をすべて拾い、実在しないものを列挙する。
// 参照の形式を増やすときは EXTRACTORS に足すこと。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// 走査対象（成果物・設計文書・コード中のコメント）
const SCAN_DIRS = ["qa", "docs"];
const SCAN_FILES = ["AGENTS.md", "README.md"];
const SCAN_EXT = /\.(md|csv)$/;

function collect(dir: string, out: string[]) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      // 証跡フォルダ（スクリーンショット・trace）は対象外
      if (/evidence|screenshots|materials|test-artifacts/.test(e.name)) continue;
      collect(rel, out);
      continue;
    }
    if (SCAN_EXT.test(e.name)) out.push(rel);
  }
}

const targets: string[] = [];
for (const d of SCAN_DIRS) collect(d, targets);
for (const f of SCAN_FILES) if (fs.existsSync(path.join(ROOT, f))) targets.push(f);

// テストファイルへの参照を拾う正規表現。
// 例: tests/unit/kpi.test.ts / e2e/07-reports-daily.spec.ts / e2e-prod/prod-smoke.spec.ts
const TEST_REF = /\b((?:tests\/[\w./-]*|e2e(?:-prod)?\/[\w./-]*)\.(?:test|spec)\.tsx?)(?![\w.])/g;

// 実装ファイルへの参照（`src/...` / `prisma/...` / `scripts/...`）。
// 行番号付き（path:123）でも拾い、パス部分の実在を見る。
//
// 拡張子の**交替順に注意**: `ts|tsx` の順にすると `foo.tsx` が `.ts` までで止まり、
// 正しい記載を「存在しない .ts」と誤検出する（この検出器を最初に書いたとき実際に12件の
// 偽陽性を出した）。長い方を先に置き、後ろに `(?![\w.])` を付けて途中打ち切りを防ぐ。
const SRC_REF = /\b((?:src|prisma|scripts)\/[\w./()\[\]-]*\.(?:tsx|ts|sql|prisma))(?![\w.])/g;

// 「存在しないパスを挙げていたこと自体が不具合内容」である記述だけを、
// 理由付きで明示的に許可する。行の文言（「存在しない」等）で自動的に免除すると、
// その一語を書き足すだけで検出を無効化できる抜け穴になるため、**個別列挙**にしている。
const KNOWN_ABSENT: { file: string; ref: string; why: string }[] = [
  {
    file: "qa/BUG_REPORT.md",
    ref: "src/app/(app)/sales-staff/apply-form.tsx",
    why: "BUG-L16 の不具合内容そのもの（実体は src/app/(app)/sales-staff/client.tsx:83）",
  },
  {
    file: "qa/QA_REPORT.md",
    ref: "src/app/(app)/sales-staff/apply-form.tsx",
    why: "loop5 追補で BUG-L16 の内容として引用（実体は src/app/(app)/sales-staff/client.tsx:83）",
  },
];

function isKnownAbsent(file: string, ref: string): boolean {
  const norm = file.replaceAll("\\", "/");
  return KNOWN_ABSENT.some((k) => k.file === norm && k.ref === ref);
}

function refsIn(file: string, re: RegExp): { ref: string; line: number }[] {
  const body = fs.readFileSync(path.join(ROOT, file), "utf8");
  const found: { ref: string; line: number }[] = [];
  body.split("\n").forEach((text, i) => {
    for (const m of text.matchAll(re)) found.push({ ref: m[1], line: i + 1 });
  });
  return found;
}

describe("成果物が挙げる証跡ファイルが実在すること（T2）", () => {
  it("走査対象の文書が見つかっている（空振り防止）", () => {
    expect(targets.length, "走査対象が0件（パスの想定が変わっている）").toBeGreaterThan(5);
  });

  it("**テストファイルへの参照はすべて実在する**", () => {
    const missing: string[] = [];
    for (const file of targets) {
      for (const { ref, line } of refsIn(file, TEST_REF)) {
        if (!fs.existsSync(path.join(ROOT, ref))) missing.push(`${file}:${line} → ${ref}`);
      }
    }
    expect(
      [...new Set(missing)],
      `存在しないテストファイルを証跡として記載しています（PASS の根拠が虚偽になります）:\n  ${[...new Set(missing)].join("\n  ")}`
    ).toEqual([]);
  });

  it("実装ファイルへの参照はすべて実在する", () => {
    const missing: string[] = [];
    for (const file of targets) {
      for (const { ref, line } of refsIn(file, SRC_REF)) {
        // 行番号やメソッド名が付いた表記はパス部分だけを見る
        const p = ref.replace(/[:#].*$/, "");
        if (isKnownAbsent(file, p)) continue;
        if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${file}:${line} → ${p}`);
      }
    }
    expect(
      [...new Set(missing)],
      `存在しない実装ファイルを参照しています:\n  ${[...new Set(missing)].join("\n  ")}`
    ).toEqual([]);
  });
});

describe("検出器そのものが機能していること（T11 の一部）", () => {
  it("既知の違反サンプルを検出できる", () => {
    // BUG-L09（正規表現のバックスラッシュ欠落で1件もマッチしない死んだ検出器）の再発防止。
    const samples = [
      "tests/unit/erasure.test.ts",
      "e2e/07-reports-daily.spec.ts",
      "e2e-prod/prod-smoke.spec.ts",
      "tests/unit/nested/foo.test.ts",
    ];
    for (const s of samples) {
      expect([...s.matchAll(TEST_REF)].length, `検出器が ${s} を拾えない`).toBeGreaterThan(0);
    }
    for (const s of ["src/lib/pii.ts", "prisma/schema.prisma", "scripts/apply-rls.ts"]) {
      expect([...s.matchAll(SRC_REF)].length, `検出器が ${s} を拾えない`).toBeGreaterThan(0);
    }
  });

  it("`.tsx` を `.ts` として途中で切り出さない（偽陽性の再発防止）", () => {
    // 交替順のバグでこの検出器が12件の偽陽性を出した回帰テスト。
    for (const s of [
      "src/components/cases/snc-case-list.tsx",
      "src/app/(app)/reports/page.tsx",
      "src/app/(app)/agency-cases/[id]/page.tsx",
    ]) {
      const m = [...s.matchAll(SRC_REF)];
      expect(m.length, `検出器が ${s} を拾えない`).toBe(1);
      expect(m[0][1], "拡張子が途中で切られている（偽陽性の原因）").toBe(s);
    }
    // 行番号付きの表記でもパス全体を拾えること
    const withLine = "src/components/cases/snc-case-list.tsx:120";
    expect([...withLine.matchAll(SRC_REF)][0][1]).toBe("src/components/cases/snc-case-list.tsx");
  });

  it("許可リストは実際に「存在しないパス」に対してのみ使われている（免除の乱用防止）", () => {
    // 実在するパスが許可リストに残っていると、そのファイルの参照ミスを永久に見逃す。
    for (const k of KNOWN_ABSENT) {
      expect(
        fs.existsSync(path.join(ROOT, k.ref)),
        `${k.ref} は実在するので許可リストから外してください`
      ).toBe(false);
      expect(fs.existsSync(path.join(ROOT, k.file)), `${k.file} が存在しません`).toBe(true);
      expect(k.why.length, "免除には理由が必要").toBeGreaterThan(10);
    }
  });

  it("実在するテストを誤検出しない", () => {
    const real = "tests/unit/kpi.test.ts";
    expect(fs.existsSync(path.join(ROOT, real))).toBe(true);
    expect([...real.matchAll(TEST_REF)][0][1]).toBe(real);
  });
});
