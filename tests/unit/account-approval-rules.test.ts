import { describe, it, expect } from "vitest";
import {
  canFinalApproveRequest,
  SNC_TARGET_ROLES,
  SNC_TARGET_APPROVER_ROLES,
} from "@/app/(app)/account-requests/approval-rules";
import type { Role } from "@/lib/roles";

// 職務分離（§6.1-3 / 要件1-1）のテーブル駆動検証（§13 テスト観点「権限」）
// 「SNC一般以上のアカウント発行・権限変更・停止・削除は必ずSNC課長以上（②）の承認を要する」
//  → 申請対象ロールがSNC系（①〜⑥）なら①②のみ、代理店系（⑦⑧⑩）なら①②③が最終承認・却下可
const ACTORS: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];
const TARGETS: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"];

describe("canFinalApproveRequest（§6.1-3 職務分離）", () => {
  it("SNC系ロール（①〜⑥）の申請は①②のみ最終承認できる", () => {
    for (const target of SNC_TARGET_ROLES) {
      expect(canFinalApproveRequest("R1", target)).toBe(true);
      expect(canFinalApproveRequest("R2", target)).toBe(true);
      expect(canFinalApproveRequest("R3", target), `③は${target}を承認できない`).toBe(false);
    }
  });

  it("代理店系ロール（⑦⑧⑩）の申請は①②③が最終承認できる", () => {
    for (const target of ["R7", "R8", "R10"]) {
      expect(canFinalApproveRequest("R1", target)).toBe(true);
      expect(canFinalApproveRequest("R2", target)).toBe(true);
      expect(canFinalApproveRequest("R3", target)).toBe(true);
    }
  });

  it("SNC管理系（①②③）以外のロールはどの申請も最終承認できない", () => {
    for (const actor of ACTORS.filter((r) => !["R1", "R2", "R3"].includes(r))) {
      for (const target of TARGETS) {
        expect(canFinalApproveRequest(actor, target), `${actor} は ${target} を承認できない`).toBe(
          false
        );
      }
    }
  });

  it("ロール×対象の全組み合わせが期待値と一致する（テーブル駆動）", () => {
    for (const actor of ACTORS) {
      for (const target of TARGETS) {
        const expected =
          (["R1", "R2", "R3"] as string[]).includes(actor) &&
          (SNC_TARGET_ROLES.includes(target)
            ? SNC_TARGET_APPROVER_ROLES.includes(actor)
            : true);
        expect(canFinalApproveRequest(actor, target), `${actor} -> ${target}`).toBe(expected);
      }
    }
  });

  it("未知のロール文字列は代理店系扱いにならず、①②③の判定だけで決まる（防御的）", () => {
    expect(canFinalApproveRequest("R3", "R99")).toBe(true); // SNC系ではないので③でも可
    expect(canFinalApproveRequest("R9", "R99")).toBe(false);
  });
});
