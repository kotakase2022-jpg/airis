// 権限判定の実装カバレッジ（§3.2「機能×操作の権限は §5 の表をコードで表現し、API層・UI層の両方で判定する」）。
//
// 目的: 画面・APIに **ハードコードされたロール配列による権限判定** が残っていないことを
//       ソース走査で継続的に検証する。権限は必ず宣言的マップ（src/lib/permissions.ts の
//       can()/canApproveFirst()/isDummyFeature()、src/lib/roles.ts の canAccess()/MENU）
//       経由で判定し、仕様（§5.1 / §5.2）とコードの対応を1箇所に集約する。
//
// 検出対象の書き方（いずれも「その場でロール集合を決め打ちしている」形）:
//   A: `<なにか>.includes(user.role)` / `.includes(user.rawRole)`
//   B: `["R1", "R2", ...].includes(...)`（ロール文字列の配列リテラルに対する includes）
//
// 例外は ALLOWED に **理由付きで** 列挙する。例外に該当するのは
//   (1) 権限判定ではない判定（スコープ算出・パスワード桁数・所属整合など）
//   (2) §5.2 の宣言的マップ（MENU.roles）そのものを引いている箇所
//   (3) 本レビュー回で別担当が対応中のファイル（許可リストなので、修正されても本テストは緑のまま）
// のいずれか。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_DIR = path.join(REPO_ROOT, "src");

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: "includes(user.role)", re: /\.includes\(\s*user\.(?:role|rawRole)\b/g },
  { name: "ロール配列リテラル.includes()", re: /\[[^\]\n]*"R\d+"[^\]\n]*\]\s*\.includes\(/g },
];

// key: src からの相対パス（POSIX区切り） / value: 例外として許容する理由（仕様の根拠）
const ALLOWED: Record<string, string> = {
  // ---- (1) 権限判定ではない判定 ----
  "lib/auth.ts":
    "§3.1 データスコープの算出（agencyScope）。参照可能な代理店IDの決定であって機能権限の判定ではない",
  "lib/session.ts":
    "§3.1 RLSコンテキスト（app.bypass / app.scope）の算出。機能権限の判定ではない",
  "app/(auth)/actions.ts":
    "§4.2 パスワード最小桁数（管理者20桁/一般14桁）の判定。ADMIN_PW_ROLES は認証ポリシーの区分で機能権限ではない",

  // ---- (2) §5.2 の宣言的マップを引いている箇所 ----
  "app/(app)/layout.tsx":
    "§5.2/§11.1 の MENU.roles（宣言的マップ）によるサイドメニュー出し分け。canAccess() と同一の情報源",

  // ---- (3) 変更禁止ファイル / 本レビュー回の別担当領域 ----
  "lib/file-access.ts":
    "変更禁止ファイル。permissions.ts ベースに書き直し済みで、残る配列は §6.1-3（承認権限者=①②③）と §7.12（公開範囲）の判定",
  "app/(app)/agencies/actions.ts": "§7.11 代理店マスタ（別担当）",
  "app/(app)/agencies/page.tsx": "§7.11 代理店マスタ（別担当）",
  "app/(app)/announcements/page.tsx": "§7.7 お知らせ（別担当）",
  "app/(app)/announcements/[id]/page.tsx": "§7.7 お知らせ（別担当）",
  "app/(app)/field-agents/actions.ts": "§7.4 訪販員申請（別担当）",
  "app/(app)/field-agents/page.tsx": "§7.4 訪販員申請（別担当）",
  "app/(app)/reports/actions.ts": "§7.5/§7.6 日報・稼働提出物（別担当）",
  "app/(app)/reports/page.tsx": "§7.5/§7.6 日報・稼働提出物（別担当）",
  "app/(app)/sales-staff/actions.ts": "§7.3 販売員ID（別担当）",
  "app/(app)/sales-staff/page.tsx": "§7.3 販売員ID（別担当）",
};

// 本担当ファイル: ハードコード判定ゼロ + 宣言的マップ経由の判定を必ず含むこと
const PERMISSION_DRIVEN_FILES = [
  "app/(app)/account-requests/actions.ts",
  "app/(app)/account-requests/page.tsx",
  "app/(app)/documents/actions.ts",
  "app/(app)/documents/page.tsx",
  "app/(app)/sales-staff/csv/list/route.ts",
  "app/(app)/sales-staff/csv/gigacc/route.ts",
  "app/(app)/sales-staff/csv/template/route.ts",
  "app/(app)/reports/csv/route.ts",
  "app/(app)/field-agents/csv/route.ts",
  "app/(app)/admin/actions.ts",
  "lib/util.ts",
];

// 宣言的マップ経由の判定であることの目印（permissions.ts / roles.ts / util.ts のヘルパ）
const DECLARATIVE_CALL =
  /\b(?:can|canApproveFirst|isDummyFeature|canAccess|isDummyView|canViewFeatureInScope|canManageDocuments)\s*\(/;

type Finding = { file: string; line: number; pattern: string; text: string };

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function relFromSrc(absPath: string): string {
  return path.relative(SRC_DIR, absPath).split(path.sep).join("/");
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    const rel = relFromSrc(file);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      // コメント行（仕様の転記）は対象外
      if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return;
      for (const { name, re } of PATTERNS) {
        re.lastIndex = 0;
        if (re.test(text)) findings.push({ file: rel, line: i + 1, pattern: name, text: text.trim() });
      }
    });
  }
  return findings;
}

describe("§3.2 権限判定は宣言的マップ（permissions.ts / roles.ts）経由であること", () => {
  const findings = scan();

  it("src配下にハードコードされたロール配列による権限判定が残っていない（例外はALLOWEDに明記）", () => {
    const violations = findings.filter((f) => !(f.file in ALLOWED));
    const report = violations
      .map((v) => `${v.file}:${v.line} [${v.pattern}] ${v.text}`)
      .join("\n");
    expect(
      violations,
      `ハードコードされたロール判定が見つかりました。permissions.ts の can()/canApproveFirst()/isDummyFeature() ` +
        `または roles.ts の canAccess() に置き換えるか、権限判定でない場合は ALLOWED に理由を追記してください:\n${report}`
    ).toEqual([]);
  });

  it("走査パターンが機能している（既知の例外ファイルを実際に検出できる）", () => {
    // 検出ロジックが壊れた（=常に0件）ことに気付けるようにするための自己検証。
    // lib/session.ts は §3.1 のスコープ算出でロール配列リテラルを使う既知の例外。
    expect(findings.map((f) => f.file)).toContain("lib/session.ts");
  });

  it("ALLOWEDのエントリはすべて実在するファイルを指している（棚卸し）", () => {
    const missing = Object.keys(ALLOWED).filter(
      (rel) => !fs.existsSync(path.join(SRC_DIR, rel))
    );
    expect(missing, `存在しないパスがALLOWEDに残っています: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(PERMISSION_DRIVEN_FILES)(
    "%s は宣言的マップ経由で権限判定している（ハードコード判定なし）",
    (rel) => {
      const abs = path.join(SRC_DIR, rel);
      expect(fs.existsSync(abs), `${rel} が見つかりません`).toBe(true);
      const source = fs.readFileSync(abs, "utf8");
      expect(
        DECLARATIVE_CALL.test(source),
        `${rel} が can()/canAccess() 等の宣言的な権限判定を使っていません`
      ).toBe(true);
      expect(
        findings.filter((f) => f.file === rel),
        `${rel} にハードコードされたロール判定が残っています`
      ).toEqual([]);
    }
  );
});
