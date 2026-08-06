// アカウント申請の「上長承認証跡ファイル」の参照可否（§6.1-3 職務分離 / §10.5 IDOR防止）。
//
// 経緯（QA loop4 の独立監査で検出 → 発注者指示 2026-08-06 で是正）:
//   src/lib/file-access.ts は `can(role, "airis-account", "view")` または `approve_final` を
//   持つロールに **全申請の証跡** を開放していた。その結果、③（SNC運用者）は
//   §6.1-3 により最終承認できない SNC系（①〜⑥）宛の申請についても、
//   添付された上長承認証跡を /files/<id> から取得できていた。
//   証跡は「承認判断のために見る」ものなので、承認できない申請の証跡を見る必要はない。
//
// ここでは判定規則（canFinalApproveRequest）が、証跡の参照可否として妥当な形になっているかを
// 全ロール × 全対象ロールの組み合わせで固定する。
// 実際のファイル配信の挙動は e2e/14-file-access.spec.ts が担当する。

import { describe, it, expect } from "vitest";
import { canFinalApproveRequest } from "@/app/(app)/account-requests/approval-rules";
import { canResetCredentialsFor } from "@/app/(app)/account-requests/approval-rules";
import type { Role } from "@/lib/roles";

const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];
const SNC_TARGETS: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6"];
const AGENCY_TARGETS: Role[] = ["R7", "R8", "R9", "R10"];

describe("証跡ファイルの参照可否（承認できる申請に限る）", () => {
  it("①②はすべてのロール宛の申請の証跡を参照できる", () => {
    for (const actor of ["R1", "R2"] as Role[]) {
      for (const target of ALL_ROLES) {
        expect(canFinalApproveRequest(actor, target), `${actor}→${target}`).toBe(true);
      }
    }
  });

  it("**③はSNC系（①〜⑥）宛の申請の証跡を参照できない**（今回の是正点）", () => {
    for (const target of SNC_TARGETS) {
      expect(canFinalApproveRequest("R3", target), `R3→${target}`).toBe(false);
    }
  });

  it("③は代理店系（⑦⑧⑨⑩）宛の申請の証跡を参照できる（承認できる範囲）", () => {
    for (const target of AGENCY_TARGETS) {
      expect(canFinalApproveRequest("R3", target), `R3→${target}`).toBe(true);
    }
  });

  it("④〜⑩は最終承認者ではないため、この経路では参照できない（⑦は別途1次承認の経路）", () => {
    for (const actor of ["R4", "R5", "R6", "R7", "R8", "R9", "R10"] as Role[]) {
      for (const target of ALL_ROLES) {
        expect(canFinalApproveRequest(actor, target), `${actor}→${target}`).toBe(false);
      }
    }
  });

  it("資格情報リセットの職務分離と同一の規則である（規則の情報源が1つであること）", () => {
    // 証跡参照・最終承認・リセット代行が別々の規則に分岐すると、
    // 片方だけ直して片方が開いたままになる（loop3/loop4 で実際に起きた事故の型）。
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        expect(
          canFinalApproveRequest(actor, target),
          `${actor}→${target} が資格情報リセットの規則と食い違う`
        ).toBe(canResetCredentialsFor(actor, target));
      }
    }
  });
});

describe("file-access.ts が職務分離の規則を通していること", () => {
  it("証跡の判定に canFinalApproveRequest を使っている（view/approve_final の直接判定に戻っていない）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const body = fs.readFileSync(path.join(process.cwd(), "src", "lib", "file-access.ts"), "utf8");
    // コメントを除いた実コードで確認する
    const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code, "canFinalApproveRequest を通していない").toContain(
      "canFinalApproveRequest(user.role, req.role)"
    );
    // 旧実装（全件開放）に戻っていないこと
    expect(
      /can\(user\.role, "airis-account", "(view|approve_final)"\)\s*\|\|/.test(code),
      "証跡の参照可否が airis-account の view/approve_final の直接判定に戻っている"
    ).toBe(false);
    // 判定に必要な role を SELECT していること（していないと undefined 判定になる）
    expect(code, "AccountRequest.role を select していない").toMatch(
      /evidenceFileId: fileId[\s\S]{0,200}?role: true/
    );
  });
});
