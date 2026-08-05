// 実効ロールの解決（§14-2）の単体テスト。
//
// §14 の確定事項（発注者回答 2026-08-05）:
//   「Agencyのステータスを『稼働終了』に切替えると **当該1次店の⑦と配下2次店の⑧** の
//     実効ロールが⑩に解決される」
//
// QA loop3 の独立監査で、**⑧が親1次店の稼働終了を見ていない**欠陥を検出した:
//   ②が /agencies で1次店だけを「稼働終了」に切替えると、配下2次店の⑧は⑧のまま
//   ログインでき、⑩では×の 販売員ID管理 / 訪販員申請 / 各種資料の提出 等を操作できた。
//   （シードは配下2次店も closed にしていたため露出していなかった＝データ規約への依存）

import { describe, it, expect } from "vitest";
import { effectiveRoleFor } from "@/lib/session";

describe("effectiveRoleFor（§14-2 稼働終了代理店の実効ロール）", () => {
  it("⑦: 自店（1次店）が稼働終了なら⑩", () => {
    expect(effectiveRoleFor("R7", "closed", null)).toBe("R10");
  });

  it("⑦: 自店が有効なら⑦のまま", () => {
    expect(effectiveRoleFor("R7", "active", null)).toBe("R7");
  });

  it("⑧: 自店（2次店）が稼働終了なら⑩", () => {
    expect(effectiveRoleFor("R8", "closed", "active")).toBe("R10");
  });

  it("⑧: **自店が有効でも親1次店が稼働終了なら⑩**（今回の是正点）", () => {
    expect(effectiveRoleFor("R8", "active", "closed")).toBe("R10");
  });

  it("⑧: 自店も親も有効なら⑧のまま", () => {
    expect(effectiveRoleFor("R8", "active", "active")).toBe("R8");
  });

  it("⑧: 親が不明（null）でも自店が有効なら⑧のまま（fail-open にしない範囲）", () => {
    expect(effectiveRoleFor("R8", "active", null)).toBe("R8");
  });

  it("⑦以外・⑧以外のロールは親の状態に影響されない", () => {
    for (const role of ["R1", "R2", "R3", "R4", "R5", "R6", "R9", "R10"]) {
      expect(effectiveRoleFor(role, "closed", "closed"), role).toBe(role);
    }
  });

  it("稼働終了以外のステータス文字列は⑩化しない（closed だけが対象）", () => {
    for (const s of ["active", "suspended", "", "CLOSED", "close"]) {
      expect(effectiveRoleFor("R7", s, null), `own=${s}`).toBe("R7");
      expect(effectiveRoleFor("R8", "active", s), `parent=${s}`).toBe("R8");
    }
  });
});
