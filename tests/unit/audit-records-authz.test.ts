// 監査記録（監査ログ / アクセスログ / 棚卸CSV）の閲覧・出力権限の単体テスト。
//
// 経緯:
//   発注者指示（2026-08-05）で③（SNC運用者）の管理画面アクセスを〇にした結果、
//   ③が全アカウント棚卸CSV・監査ログ全件・アクセスログ全件（IP/UA付き）にも到達できていた。
//   追加指示（2026-08-06）で「監査ログ全件・アクセスログ全件（IP/UA付き）・棚卸CSVには
//   到達不可」と確定したため、監査記録の閲覧を独立した権限として①②に限定した。
//
// ③に必要なのは §4.2 のリセット代行（代理店系のみ）であり、全社の監査記録の参照ではない。
// ③は人数が多い想定のロール（§4「PS2課の代理店担当（エリア営業SV含む）」）のため、
// IP/UA を含む全社のアクセス履歴を広く参照可能にしない（最小権限）。

import { describe, it, expect } from "vitest";
import { canViewAuditRecords, canResetCredentialsOn } from "@/app/(app)/admin/authz";
import { canAccess, type Role } from "@/lib/roles";

const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

describe("canViewAuditRecords（監査ログ・アクセスログ・棚卸CSV の閲覧 §7.1 / §7.2）", () => {
  it("①②のみが監査記録を閲覧できる", () => {
    expect(canViewAuditRecords("R1")).toBe(true);
    expect(canViewAuditRecords("R2")).toBe(true);
  });

  it("**③は監査記録を閲覧できない**（発注者指示 2026-08-06）", () => {
    expect(canViewAuditRecords("R3")).toBe(false);
  });

  it("④〜⑩も監査記録を閲覧できない", () => {
    for (const role of ["R4", "R5", "R6", "R7", "R8", "R9", "R10"] as Role[]) {
      expect(canViewAuditRecords(role), role).toBe(false);
    }
  });

  it("閲覧できるのはちょうど2ロール（①②）である", () => {
    expect(ALL_ROLES.filter((r) => canViewAuditRecords(r))).toEqual(["R1", "R2"]);
  });
});

describe("③に残す権限と外す権限の切り分け", () => {
  it("③は管理画面には入れる（発注者指示 OWN-014 は維持されている）", () => {
    expect(canAccess("R3", "admin")).toBe(true);
  });

  it("③は代理店系（⑦⑧⑨⑩）のリセット代行を行える（§4.2 を満たす）", () => {
    for (const target of ["R7", "R8", "R9", "R10"]) {
      expect(canResetCredentialsOn("R3", target), `R3→${target}`).toBe(true);
    }
  });

  it("③はSNC系（①〜⑥）のリセット代行を行えない（§6.1-3 職務分離）", () => {
    for (const target of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      expect(canResetCredentialsOn("R3", target), `R3→${target}`).toBe(false);
    }
  });

  it("③は監査記録を見られないが、管理画面のアカウント一覧には到達できる（両立していること）", () => {
    // 「管理画面に入れる」と「監査記録を見られる」が独立した判定になっていること。
    // 片方の変更でもう片方が巻き添えにならないことを型ではなく振る舞いで固定する。
    expect(canAccess("R3", "admin")).toBe(true);
    expect(canViewAuditRecords("R3")).toBe(false);
  });
});
