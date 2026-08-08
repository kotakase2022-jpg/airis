// 本番検証（e2e-prod）が**本番のデータを変更しない**ことを機械的に守る。
//
// 経緯（QA loop5 の事故）:
//   `e2e-prod` のログイン処理が、MFA未登録アカウントに対して `/mfa/setup` で
//   サーバ発行の秘密鍵を読み「登録して続行」を押し、**MFAを本登録**していた。
//   その秘密鍵はDBにしか無いため、利用者本人がログインできなくなった
//   （実測: ①airis_slb_sys_001 の mfa_enroll が 2026-08-05T12:11:42Z / IP=テスト実行元）。
//
//   さらに悪いことに、この処理は **prod-smoke と prod-authz-verify に複製**されており、
//   prod-smoke だけを修正した結果、複製側が本番アカウント2件（②③）を追加で登録した。
//   「同じ処理の複製」がこの事故を二段構えにした。
//
// そこで本テストは2点を固定する:
//   1. e2e-prod の spec は MFA登録操作（「登録して続行」）を持たない
//   2. 接続・ログイン・MFA通過は helpers.ts に集約され、spec 側に複製が無い

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIR = path.join(ROOT, "e2e-prod");

const specs = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".spec.ts"))
  .map((f) => ({ name: f, body: fs.readFileSync(path.join(DIR, f), "utf8") }));

const helpers = fs.readFileSync(path.join(DIR, "helpers.ts"), "utf8");

describe("本番検証は本番のMFA登録状態を変更しない（QA loop5 の事故の再発防止）", () => {
  it("spec ファイルを走査できている（空振り防止）", () => {
    expect(specs.length, "e2e-prod に spec が見つからない").toBeGreaterThan(1);
    expect(specs.map((s) => s.name)).toContain("prod-smoke.spec.ts");
    expect(specs.map((s) => s.name)).toContain("prod-authz-verify.spec.ts");
  });

  it("**どの spec も MFA登録ボタン（登録して続行）を押さない**", () => {
    const bad = specs.filter((s) => s.body.includes("登録して続行")).map((s) => s.name);
    expect(
      bad,
      `MFAを本登録する操作が含まれています。利用者が知らない秘密鍵で登録され、` +
        `本人がログインできなくなります: ${bad.join(", ")}`
    ).toEqual([]);
  });

  it("helpers も MFA登録ボタンを押さない（押すのは「認証する」のみ）", () => {
    // コメント中の説明（過去の経緯）は許容し、実際のクリック操作だけを見る
    const clicks = [...helpers.matchAll(/getByRole\("button",\s*\{\s*name:\s*([^}]+)\}\)/g)].map(
      (m) => m[1]
    );
    expect(clicks.length, "helpers にボタン操作が見つからない").toBeGreaterThan(0);
    for (const c of clicks) {
      expect(c, `MFA登録ボタンを押しています: ${c}`).not.toContain("登録して続行");
    }
    expect(helpers).toContain('name: "認証する"');
  });

  it("未登録（/mfa/setup）に到達したら失敗させる実装がある", () => {
    expect(helpers).toContain("/mfa/setup");
    expect(helpers, "/mfa/setup で例外を投げていない（登録に進んでしまう）").toMatch(
      /mfa\/setup[\s\S]{0,400}throw new Error/
    );
  });

  it("接続・ログイン・MFA通過は helpers.ts に集約され、spec に複製が無い", () => {
    // 複製があると「片方だけ直して片方が事故を起こす」を繰り返す
    for (const s of specs) {
      expect(
        s.body,
        `${s.name}: PrismaClient を自前生成しています（helpers.ts の db() を使うこと）`
      ).not.toContain("new PrismaClient(");
      expect(
        s.body,
        `${s.name}: MFAコード生成を自前で持っています（helpers.ts の passMfaOrFail を使うこと）`
      ).not.toContain("generateSync(");
      expect(s.body, `${s.name}: helpers.ts を import していません`).toMatch(
        /from\s+"\.\/helpers"/
      );
    }
  });

  it("検出器そのものが機能している（自己検査）", () => {
    const sample = `await page.getByRole("button", { name: /登録して続行|認証する/ }).click();`;
    expect(sample.includes("登録して続行"), "検出器が悪い例を見逃す").toBe(true);
    const ok = `await page.getByRole("button", { name: "認証する" }).click();`;
    expect(ok.includes("登録して続行")).toBe(false);
  });
});
