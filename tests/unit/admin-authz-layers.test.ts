// 管理画面の認可が **UI層とAPI層で同じ判定になること**を検査する（§3.2 多層防御）。
//
// 経緯（QA loop5 で乖離リスクとして検出）:
//   UI（src/app/(app)/admin/page.tsx）は `canSuspendAccount()` 等のラッパを使い、
//   API層（src/app/(app)/admin/actions.ts）は `can(role, "airis-account", ADMIN_OP_PERMISSION[op])`
//   と **同じ規則を二重に表現**していた。値は一致していたので不具合には至っていなかったが、
//   片方だけ変更しても誰も気付かない構造だった（ボタンは出るのにサーバが拒否する／
//   ボタンは隠れているのにサーバが通す、のどちらも起こりうる）。
//   現在は両者とも authz.ts の ADMIN_OP_PERMISSION から導出しており、
//   本テストがその一致と網羅を機械的に固定する。
//
// AGENTS.md「認可はUIとAPIの両層で行う。ボタンを隠すだけでは不十分」に対応する検査。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_OP_PERMISSION,
  canAdminAccountOp,
  canDeleteAccount,
  canResetCredentials,
  canResetCredentialsOn,
  canSuspendAccount,
} from "@/app/(app)/admin/authz";
import { can } from "@/lib/permissions";
import { ROLE_LABELS, type Role } from "@/lib/roles";

const ROLES = Object.keys(ROLE_LABELS) as Role[];
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ACTIONS = fs.readFileSync(path.join(ROOT, "src/app/(app)/admin/actions.ts"), "utf8");

describe("§3.2 管理画面の認可: UI層のラッパとAPI層の導出が一致する", () => {
  it("ロール10種すべてで canSuspendAccount と op=suspend/resume の判定が一致する", () => {
    for (const role of ROLES) {
      expect(canAdminAccountOp(role, "suspend"), `${role}: suspend`).toBe(canSuspendAccount(role));
      expect(canAdminAccountOp(role, "resume"), `${role}: resume`).toBe(canSuspendAccount(role));
    }
  });

  it("ロール10種すべてで canDeleteAccount と op=delete/restore の判定が一致する", () => {
    for (const role of ROLES) {
      expect(canAdminAccountOp(role, "delete"), `${role}: delete`).toBe(canDeleteAccount(role));
      expect(canAdminAccountOp(role, "restore"), `${role}: restore`).toBe(canDeleteAccount(role));
    }
  });

  it("ロール10種すべてで canResetCredentials と op=reset_password/mfa_reset の判定が一致する", () => {
    for (const role of ROLES) {
      expect(canAdminAccountOp(role, "reset_password"), `${role}: reset_password`).toBe(
        canResetCredentials(role)
      );
      expect(canAdminAccountOp(role, "mfa_reset"), `${role}: mfa_reset`).toBe(
        canResetCredentials(role)
      );
    }
  });

  it("未知の op は fail-closed で false（表に無い操作を通さない）", () => {
    for (const role of ROLES) {
      expect(canAdminAccountOp(role, "takeover")).toBe(false);
      expect(canAdminAccountOp(role, "")).toBe(false);
      expect(canAdminAccountOp(role, "__proto__")).toBe(false);
    }
  });
});

describe("§5.1 の権限表と ADMIN_OP_PERMISSION の対応", () => {
  it("停・削は①②のみ、リセット代行は①②③（§4.2「②③が実行」を満たす）", () => {
    // 期待値は §5.1 の原表。ここが崩れると仕様どおりの権限になっていない。
    expect(ROLES.filter(canSuspendAccount)).toEqual(["R1", "R2"]);
    expect(ROLES.filter(canDeleteAccount)).toEqual(["R1", "R2"]);
    expect(ROLES.filter(canResetCredentials)).toEqual(["R1", "R2", "R3"]);
  });

  it("各 op が参照する Operation は permissions.ts に存在する値である", () => {
    for (const [op, operation] of Object.entries(ADMIN_OP_PERMISSION)) {
      // can() が例外を投げず真偽値を返すこと（Operation 名の綴り間違い検出）
      expect(typeof can("R1", "airis-account", operation), `${op} → ${operation}`).toBe("boolean");
    }
  });
});

describe("ADMIN_OP_PERMISSION と accountAction の switch が網羅されている", () => {
  // 表にあるのに switch に case が無い → 権限判定は通るのに「不明な操作です」で落ちる
  // 表に無いのに case がある → 権限判定を経ずに処理される（重大）
  const cases = [...ACTIONS.matchAll(/case "(\w+)":/g)].map((m) => m[1]);

  it("switch の case を取得できている（検出器の空振り防止）", () => {
    expect(cases.length, "accountAction の case を1つも拾えていない").toBeGreaterThan(3);
  });

  it("表の全 op に対応する case が存在する", () => {
    const missing = Object.keys(ADMIN_OP_PERMISSION).filter((op) => !cases.includes(op));
    expect(missing, `ADMIN_OP_PERMISSION にあるが switch に無い op: ${missing.join(", ")}`).toEqual(
      []
    );
  });

  it("case にあるのに表に無い op が存在しない（権限判定を経ずに処理されない）", () => {
    const extra = cases.filter((c) => !(c in ADMIN_OP_PERMISSION));
    expect(
      extra,
      `switch にあるが ADMIN_OP_PERMISSION に無い op（権限判定を経ずに実行されます）: ${extra.join(", ")}`
    ).toEqual([]);
  });
});

describe("職務分離が操作権限に上乗せされていること（§6.1-3 / 要件1-1）", () => {
  it("③は代理店系（⑦〜⑩）へはリセット代行できるが、SNC系（①〜⑥）へはできない", () => {
    for (const target of ["R7", "R8", "R9", "R10"]) {
      expect(canResetCredentialsOn("R3", target), `R3 → ${target}`).toBe(true);
    }
    for (const target of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
      expect(canResetCredentialsOn("R3", target), `R3 → ${target} は拒否されるべき`).toBe(false);
    }
  });

  it("操作権限が無いロールは職務分離を通っても実行できない（AND条件）", () => {
    for (const role of ROLES.filter((r) => !canResetCredentials(r))) {
      for (const target of ["R7", "R8", "R9", "R10"]) {
        expect(canResetCredentialsOn(role, target), `${role} → ${target}`).toBe(false);
      }
    }
  });

  it("API層（actions.ts）も職務分離を再検証している（UIだけで隠していない）", () => {
    expect(
      ACTIONS.includes("canResetCredentialsFor("),
      "actions.ts が職務分離を再検証していません（ボタンを隠すだけになっています）"
    ).toBe(true);
  });
});
