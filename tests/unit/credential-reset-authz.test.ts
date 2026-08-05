// 資格情報リセット代行（パスワードリセット / MFAリセット §4.2）の職務分離の単体テスト。
//
// QA loop3 の独立監査で **critical** の認可バイパスを実証した:
//   ③（SNC運用者）が /admin から ①のアカウントに対して
//     1. MFAリセット → mfaEnabled=false / mfaSecret=null
//     2. パスワードリセット → 一時パスワードが③の画面に平文表示
//   を実行でき、その後③の端末で新しいTOTPを登録して①（全権）に成り代われた。
//
// §4.2 は「MFAリセット・パスワードリセットは管理者代行フローを用意（②③が実行）」と定めるが、
// §6.1-3 / 要件1-1 は「SNC一般以上のアカウント発行・権限変更・停止・削除は必ずSNC課長以上（②）」
// と定めている。リセットは実質的な権限奪取であるため、後者の職務分離を適用する。

import { describe, it, expect } from "vitest";
import {
  canFinalApproveRequest,
  canResetCredentialsFor,
} from "@/app/(app)/account-requests/approval-rules";
import type { Role } from "@/lib/roles";

const SNC_TARGETS: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6"];
const AGENCY_TARGETS: Role[] = ["R7", "R8", "R9", "R10"];
const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

describe("canResetCredentialsFor（§4.2 リセット代行 × §6.1-3 職務分離）", () => {
  it("①②はすべてのロールのリセット代行ができる", () => {
    for (const actor of ["R1", "R2"] as Role[]) {
      for (const target of ALL_ROLES) {
        expect(canResetCredentialsFor(actor, target), `${actor}→${target}`).toBe(true);
      }
    }
  });

  it("**③はSNC系（①〜⑥）のリセット代行ができない**（今回の是正点）", () => {
    for (const target of SNC_TARGETS) {
      expect(canResetCredentialsFor("R3", target), `R3→${target}`).toBe(false);
    }
  });

  it("③は代理店系（⑦⑧⑨⑩）のリセット代行ができる（§4.2 の「③が実行」を満たす）", () => {
    for (const target of AGENCY_TARGETS) {
      expect(canResetCredentialsFor("R3", target), `R3→${target}`).toBe(true);
    }
  });

  it("④〜⑩は誰のリセット代行もできない（管理画面の操作権限を持たない）", () => {
    for (const actor of ["R4", "R5", "R6", "R7", "R8", "R9", "R10"] as Role[]) {
      for (const target of ALL_ROLES) {
        expect(canResetCredentialsFor(actor, target), `${actor}→${target}`).toBe(false);
      }
    }
  });

  it("最終承認の職務分離と同一の規則である（規則の情報源が1つであること）", () => {
    for (const actor of ALL_ROLES) {
      for (const target of ALL_ROLES) {
        expect(
          canResetCredentialsFor(actor, target),
          `${actor}→${target} が最終承認の規則と食い違う`
        ).toBe(canFinalApproveRequest(actor, target));
      }
    }
  });

  it("乗っ取り経路が閉じている: ③は①②のMFAリセットもPWリセットも不可", () => {
    // 監査で実証された攻撃手順（MFAリセット→PWリセット）の起点を塞いでいることの明示
    expect(canResetCredentialsFor("R3", "R1")).toBe(false);
    expect(canResetCredentialsFor("R3", "R2")).toBe(false);
  });
});
