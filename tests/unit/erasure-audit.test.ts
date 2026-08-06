// 削除操作（テナント一括削除 / 個人情報匿名化）が **監査基盤を経由すること** の単体テスト。
//
// 経緯（QA loop4 の独立監査で検出）:
//   src/lib/erasure.ts の recordErasureAudit() が util.audit() を経由せず
//   prisma.auditLog.create を直に呼んでいたため、**最も破壊的な2操作だけ**が
//     - §10.4 が要求する構造化ログ（JSON）に出力されない
//     - src/lib/alert.ts の特権操作アラートに載らない
//   という状態だった。SIEM 側から見ると一括削除・匿名化の記録が欠落する。
//
// ここでは「経路が1本であること」と「アラート定数が実際の action 値と一致すること」を固定する。
// 実際の削除の動作は tests/unit/erasure.test.ts と e2e/04-admin.spec.ts が担当する。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ERASURE_ACTIONS } from "@/lib/erasure";
import { PRIVILEGED_ACTIONS, isPrivilegedAction, classifyAlert } from "@/lib/alert";

const SRC = path.join(process.cwd(), "src");
const read = (p: string) => fs.readFileSync(path.join(SRC, p), "utf8");

describe("削除操作の action 値とアラート定数の一致", () => {
  it("ERASURE_ACTIONS の全 action が特権操作として登録されている", () => {
    for (const [kind, action] of Object.entries(ERASURE_ACTIONS)) {
      expect(
        PRIVILEGED_ACTIONS.includes(action),
        `${kind} の action "${action}" が PRIVILEGED_ACTIONS に無い`
      ).toBe(true);
      expect(isPrivilegedAction(action), action).toBe(true);
    }
  });

  it("削除操作はアラートに分類される（成功時も特権操作として通知される）", () => {
    for (const action of Object.values(ERASURE_ACTIONS)) {
      expect(classifyAlert(action, "success"), action).not.toBeNull();
    }
  });

  it("action 値そのものが変わっていないこと（CSVエクスポートや文書の参照が壊れる）", () => {
    expect(ERASURE_ACTIONS).toEqual({
      agency: "erasure_agency_bulk",
      pii: "erasure_pii_anonymize",
    });
  });
});

describe("監査ログの書き込み経路が1本であること（§10.4）", () => {
  it("prisma.auditLog.create を直に呼ぶのは util.ts の audit() だけ", () => {
    // 直呼びが増えると、その経路だけ構造化ログとアラートを迂回する。
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(e.name)) continue;
        const rel = path.relative(SRC, p).replace(/\\/g, "/");
        if (rel === "lib/util.ts") continue; // 正規の1経路
        // コメント（// と /* */）を除いた実コードだけを見る。
        // 「直に呼ばないこと」を説明するコメント自体が誤検出されるため。
        const code = fs
          .readFileSync(p, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (/prisma\.auditLog\.create|tx\.auditLog\.create/.test(code)) offenders.push(rel);
      }
    };
    walk(SRC);
    expect(
      offenders,
      `監査ログを直接作成している箇所があります（util.audit() を経由してください）: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it("erasure.ts は util.audit() を使って削除を記録する", () => {
    const body = read("lib/erasure.ts");
    expect(body, "erasure.ts が util.audit() を import していない").toMatch(
      /import \{[^}]*\baudit\b[^}]*\} from "\.\/util"/
    );
    expect(body, "recordErasureAudit が audit() を呼んでいない").toMatch(
      /recordErasureAudit[\s\S]{0,400}?return audit\(/
    );
  });

  it("audit() は作成した監査ログのIDを返す（削除完了レポートの特定に使う）", () => {
    const body = read("lib/util.ts");
    expect(body).toMatch(/export async function audit\([\s\S]*?\): Promise<string \| null>/);
    expect(body, "audit() が作成行のIDを返していない").toMatch(/id = row\.id/);
  });
});
