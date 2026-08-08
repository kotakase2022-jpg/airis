// 論理削除は必ず `status:"deleted"` と `deletedAt` をセットで書くことを検査する（§3.4 / 監査計画 C5）。
//
// 経緯（QA loop5）:
//   `src/app/(app)/sales-staff/actions.ts` の販売員ID削除は、販売員本体を
//   `deleted` + `deletedAt` にする一方、紐づくログインアカウント（⑨）は
//   `status:"suspended"` だけにして `deletedAt` を打っていなかった。
//   日次の匿名化バッチの対象条件は
//     status="deleted" AND deletedAt < 1年前 AND anonymizedAt IS NULL
//   なので、**アカウントの氏名・メールが永久に匿名化されない**（§3.4 違反）。
//   このアカウントの name / email は販売員の姓名・メールから生成されるため、
//   実在の個人情報がそのまま残り続けていた。
//   同じ対象をテナント一括削除（src/lib/erasure.ts）は deleted + deletedAt にしており、
//   2経路で扱いが矛盾していた。
//
// 「宣言（1年保持して匿名化する）と実装（バッチに届かない）」の乖離であり、
// loop3〜loop5 で繰り返し出た欠陥型。静的検査で再発を止める。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// `deletedAt` 列を持つモデル（= §3.4 の1年保持・匿名化の対象になりうるもの）を schema から得る。
// 許可リストではなく**スキーマから導出**する。列を持たないモデル（例 Announcement）は
// そもそも保持期間の管理外なので、`status:"deleted"` だけで正しい。
function modelsWithDeletedAt(): Set<string> {
  const schema = fs.readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
  const out = new Set<string>();
  for (const m of schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    if (/\n\s*deletedAt\s+/.test(m[2])) out.add(m[1]);
  }
  return out;
}

/** Prisma のモデル名（PascalCase）→ クライアントのプロパティ名（camelCase） */
const toDelegate = (model: string) => model[0].toLowerCase() + model.slice(1);

/**
 * `prisma.<model>.update(...)` / `updateMany(...)` の `data: { ... }` のうち
 * `status: "deleted"` を書いている箇所を取り出す。
 * 同じオブジェクト直下に `deletedAt` があるかを見る（ネストは追わない素朴な走査で十分）。
 */
function findDeletedWrites(
  body: string,
  delegates?: Set<string>
): { snippet: string; hasDeletedAt: boolean }[] {
  const found: { snippet: string; hasDeletedAt: boolean }[] = [];
  const re = /data:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (delegates) {
      // 直前の 400 文字から呼び出し先モデルを推定し、deletedAt を持つモデルだけを対象にする
      const lead = body.slice(Math.max(0, m.index - 400), m.index);
      const call = [
        ...lead.matchAll(/(?:prisma|db|tx|client)\.(\w+)\.(?:update|updateMany)\s*\(/g),
      ];
      const model = call.length ? call[call.length - 1][1] : null;
      if (!model || !delegates.has(model)) continue;
    }
    // 対応する閉じ括弧まで取り出す
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const snippet = body.slice(start, i + 1);
    if (/status:\s*"deleted"/.test(snippet)) {
      found.push({ snippet, hasDeletedAt: /deletedAt/.test(snippet) });
    }
  }
  return found;
}

const DELEGATES = new Set([...modelsWithDeletedAt()].map(toDelegate));

const files = walk(SRC).map((f) => ({
  file: path.relative(ROOT, f).replaceAll("\\", "/"),
  body: strip(fs.readFileSync(f, "utf8")),
}));

describe("§3.4 論理削除は status と deletedAt をセットで書く（C5 の再発防止）", () => {
  it('走査で `status: "deleted"` の書き込みを検出できている（空振り防止）', () => {
    const total = files.flatMap((f) => findDeletedWrites(f.body, DELEGATES)).length;
    expect(total, "論理削除の書き込みを1件も拾えていない").toBeGreaterThan(2);
  });

  it("**すべての論理削除で deletedAt が同時に設定される**", () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const w of findDeletedWrites(f.body, DELEGATES)) {
        if (!w.hasDeletedAt)
          missing.push(`${f.file}: ${w.snippet.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(
      missing,
      'status:"deleted" にしているのに deletedAt を設定していません。' +
        "日次の匿名化バッチ（deletedAt < 1年前）に到達せず、個人情報が永久に残ります:\n  " +
        missing.join("\n  ")
    ).toEqual([]);
  });

  it("復旧側は deletedAt を null に戻す（片道にしない）", () => {
    const restores = files.filter((f) => /deletedAt:\s*null/.test(f.body)).map((f) => f.file);
    // 販売員・アカウントの復旧経路が存在すること（§3.4 / 要件1-5 バックアップ/復旧機能）
    expect(restores, "deletedAt を解除する経路が無い").toContain(
      "src/app/(app)/sales-staff/actions.ts"
    );
  });

  it("検出器そのものが機能している（自己検査）", () => {
    const bad = `await prisma.account.update({ where: { id }, data: { status: "deleted" } });`;
    const good = `await prisma.account.update({ where: { id }, data: { status: "deleted", deletedAt: new Date() } });`;
    expect(findDeletedWrites(bad)[0]?.hasDeletedAt, "悪い例を見逃している").toBe(false);
    expect(findDeletedWrites(good)[0]?.hasDeletedAt, "良い例を誤検出している").toBe(true);
    // status が deleted 以外の書き込みは対象外
    expect(findDeletedWrites(`data: { status: "suspended" }`)).toHaveLength(0);
  });
});

describe("検出対象モデルの導出（許可リストではなくスキーマ由来）", () => {
  it("deletedAt を持つモデルだけを対象にする", () => {
    const models = modelsWithDeletedAt();
    // §3.4 が保持期間を定める3種は必ず含まれる
    for (const m of ["Account", "SalesStaff", "FieldAgentApplication"]) {
      expect(models, `${m} に deletedAt が無い（前提が変わっている）`).toContain(m);
    }
    // 列を持たないモデルは対象外（保持期間の管理外。status だけで正しい）
    expect(models.has("Announcement"), "Announcement に deletedAt が増えたら検査対象に入る").toBe(
      false
    );
  });

  it("モデル名からデリゲート名を導出できる", () => {
    expect(toDelegate("SalesStaff")).toBe("salesStaff");
    expect(toDelegate("Account")).toBe("account");
  });
});
