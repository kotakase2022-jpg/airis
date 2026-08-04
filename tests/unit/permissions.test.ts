// §5.1 権限マトリクス（機能×操作×ロール）のテーブル駆動テスト（§13「§5 のマトリクスをそのまま
// テーブル駆動テスト化（ロール×機能×操作で許可/拒否を全数検証）」）。
//
// EXPECTED は指示書 §5.1 の表から独立に転記したもの（実装の PERMISSIONS を再利用しない）。
// 各機能について 10ロール × 10操作 = 100 通りを全数検証する。

import { describe, it, expect } from "vitest";
import type { Role } from "@/lib/roles";
import {
  PERMISSIONS,
  can,
  canApproveFirst,
  isDummyFeature,
  announcementFeature,
  caseFeature,
  DUMMY_FEATURES,
  type FeatureKey,
  type Operation,
} from "@/lib/permissions";

const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

const ALL_OPS: Operation[] = [
  "apply",
  "approve_first",
  "approve_final",
  "update",
  "suspend",
  "view",
  "delete",
  "submit",
  "create",
  "send",
];

const ALL_FEATURES: FeatureKey[] = [
  "airis-account",
  "sales-staff",
  "field-agent",
  "daily-report",
  "submission",
  "announcement-all",
  "announcement-primary",
  "hotline",
  "consumer-center",
];

// §5.1 の表（許可ロールのみ列挙。未列挙の操作は全ロール不可）
const EXPECTED: Record<FeatureKey, Partial<Record<Operation, Role[]>>> = {
  // 申/承/変/停/閲/削 | 申/承/変/停/閲/削 | 承/申 | 申 | 申 | 申 | 申/一承 | 申 | × | ×
  "airis-account": {
    apply: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2"],
    suspend: ["R1", "R2"],
    view: ["R1", "R2"],
    delete: ["R1", "R2"],
  },
  // 申/承/変/停/閲/削 ×3 | ダミー | × | × | 申/一承/変/閲/停/削 | 申 | × | ×
  "sales-staff": {
    apply: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7"],
    suspend: ["R1", "R2", "R3", "R7"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3", "R7"],
  },
  "field-agent": {
    apply: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7"],
    suspend: ["R1", "R2", "R3", "R7"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3", "R7"],
  },
  // 提/変/閲/削 ×3 | ダミー | × | × | 提/変/閲/削 | 提/変/閲/削 | 提（自己修正可） | ×
  "daily-report": {
    submit: ["R1", "R2", "R3", "R7", "R8", "R9"],
    update: ["R1", "R2", "R3", "R7", "R8"],
    view: ["R1", "R2", "R3", "R7", "R8"],
    delete: ["R1", "R2", "R3", "R7", "R8"],
  },
  // 承/提/変/閲/削 ×3 | ダミー | × | × | SNCへ提出/一承/変/削(+閲 §5.1補足) | 一次店へ提出/変/削(+閲) | × | ×
  submission: {
    submit: ["R1", "R2", "R3", "R7", "R8"],
    approve_first: ["R7"],
    approve_final: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3", "R7", "R8"],
    view: ["R1", "R2", "R3", "R7", "R8"],
    delete: ["R1", "R2", "R3", "R7", "R8"],
  },
  // 登/送/変/閲/停/削 ×3 | ダミー | × | × | 閲 | 閲 | 閲 | ×
  "announcement-all": {
    create: ["R1", "R2", "R3"],
    send: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3"],
    suspend: ["R1", "R2", "R3"],
    view: ["R1", "R2", "R3", "R7", "R8", "R9"],
    delete: ["R1", "R2", "R3"],
  },
  // 登/送/変/閲/停/削 ×3 | ダミー | × | × | 閲 | × | × | ×
  "announcement-primary": {
    create: ["R1", "R2", "R3"],
    send: ["R1", "R2", "R3"],
    update: ["R1", "R2", "R3"],
    suspend: ["R1", "R2", "R3"],
    view: ["R1", "R2", "R3", "R7"],
    delete: ["R1", "R2", "R3"],
  },
  // 作/変/閲/停/削 ×3 | × | 作/変/停/削/閲(⑤) | × | 閲/返信 | × | × | 閲/返信
  hotline: {
    create: ["R1", "R2", "R3", "R5"],
    update: ["R1", "R2", "R3", "R5"],
    suspend: ["R1", "R2", "R3", "R5"],
    view: ["R1", "R2", "R3", "R5", "R7", "R10"],
    delete: ["R1", "R2", "R3", "R5"],
    send: ["R1", "R2", "R3", "R5", "R7", "R10"],
  },
  // 作/変/閲/停/削 ×3 | × | × | 作/変/停/削/閲(⑥) | 閲/返信 | × | × | 閲/返信
  "consumer-center": {
    create: ["R1", "R2", "R3", "R6"],
    update: ["R1", "R2", "R3", "R6"],
    suspend: ["R1", "R2", "R3", "R6"],
    view: ["R1", "R2", "R3", "R6", "R7", "R10"],
    delete: ["R1", "R2", "R3", "R6"],
    send: ["R1", "R2", "R3", "R6", "R7", "R10"],
  },
};

// 検証ケースを 機能×操作 で展開（各ケース内で10ロールを全数検証）
const CASES = ALL_FEATURES.flatMap((feature) =>
  ALL_OPS.map((op) => ({ feature, op, allowed: EXPECTED[feature][op] ?? [] }))
);

describe("can（§5.1 機能×操作×ロールの全数検証）", () => {
  it("§5.1 の9機能がすべて宣言されている", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...ALL_FEATURES].sort());
  });

  it("検証ケース数 = 9機能 × 10操作", () => {
    expect(CASES).toHaveLength(90);
  });

  it.each(CASES)("$feature × $op: 許可は $allowed のみ", ({ feature, op, allowed }) => {
    for (const role of ALL_ROLES) {
      expect(can(role, feature, op), `${role} × ${feature} × ${op}`).toBe(allowed.includes(role));
    }
  });

  it("未定義の機能・操作は全ロール false", () => {
    for (const role of ALL_ROLES) {
      expect(can(role, "no-such-feature" as FeatureKey, "view")).toBe(false);
      expect(can(role, "sales-staff", "no-such-op" as Operation)).toBe(false);
    }
  });
});

describe("§13 停止・削除の対象エンティティ別検証", () => {
  it("Airisアカウントの停止・削除は①②のみ（§6.1-5）", () => {
    for (const role of ALL_ROLES) {
      const ok = role === "R1" || role === "R2";
      expect(can(role, "airis-account", "suspend")).toBe(ok);
      expect(can(role, "airis-account", "delete")).toBe(ok);
    }
    // ③は最終承認できるが停止・削除はできない
    expect(can("R3", "airis-account", "approve_final")).toBe(true);
    expect(can("R3", "airis-account", "delete")).toBe(false);
  });

  it("販売員ID・訪販員申請の停止・削除は①②③⑦（§14-11 で権限一覧★を正と確定）", () => {
    for (const feature of ["sales-staff", "field-agent"] as FeatureKey[]) {
      for (const role of ALL_ROLES) {
        const ok = ["R1", "R2", "R3", "R7"].includes(role);
        expect(can(role, feature, "suspend"), `${role} × ${feature} × suspend`).toBe(ok);
        expect(can(role, feature, "delete"), `${role} × ${feature} × delete`).toBe(ok);
      }
      // ⑧は申請のみ（変更・停止・削除は不可）
      expect(can("R8", feature, "apply")).toBe(true);
      expect(can("R8", feature, "update")).toBe(false);
      expect(can("R8", feature, "suspend")).toBe(false);
      expect(can("R8", feature, "delete")).toBe(false);
    }
  });
});

describe("変更（update）操作の権限（§5.1「変」）", () => {
  it("販売員ID・訪販員申請の変更は①②③⑦のみ", () => {
    for (const feature of ["sales-staff", "field-agent"] as FeatureKey[]) {
      for (const role of ALL_ROLES) {
        expect(can(role, feature, "update"), `${role} × ${feature}`).toBe(
          ["R1", "R2", "R3", "R7"].includes(role)
        );
      }
    }
  });

  it("お知らせの変更は①②③のみ（全体向け・1次店向けとも）", () => {
    for (const feature of ["announcement-all", "announcement-primary"] as FeatureKey[]) {
      for (const role of ALL_ROLES) {
        expect(can(role, feature, "update"), `${role} × ${feature}`).toBe(
          ["R1", "R2", "R3"].includes(role)
        );
      }
    }
    // 閲覧のみのロールは変更不可
    expect(can("R7", "announcement-all", "view")).toBe(true);
    expect(can("R7", "announcement-all", "update")).toBe(false);
    expect(can("R9", "announcement-all", "view")).toBe(true);
    expect(can("R9", "announcement-all", "update")).toBe(false);
  });

  it("窓口案件の変更は①②③＋担当窓口（HL=⑤ / 消セン=⑥）のみ。⑦⑩は返信・閲覧のみ", () => {
    for (const role of ALL_ROLES) {
      expect(can(role, "hotline", "update"), `${role} × hotline`).toBe(
        ["R1", "R2", "R3", "R5"].includes(role)
      );
      expect(can(role, "consumer-center", "update"), `${role} × consumer-center`).toBe(
        ["R1", "R2", "R3", "R6"].includes(role)
      );
    }
    for (const feature of ["hotline", "consumer-center"] as FeatureKey[]) {
      for (const role of ["R7", "R10"] as Role[]) {
        expect(can(role, feature, "view")).toBe(true);
        expect(can(role, feature, "send")).toBe(true); // 返信は代理店の唯一の書き込み手段
        expect(can(role, feature, "create")).toBe(false); // 代理店から新規起票は不可
        expect(can(role, feature, "update")).toBe(false);
        expect(can(role, feature, "suspend")).toBe(false);
        expect(can(role, feature, "delete")).toBe(false);
      }
    }
  });
});

describe("窓口の担当分離（§14-4 権限一覧★を正: ④=× / ⑤⑥は担当窓口のみフル操作）", () => {
  it("⑤はホットラインのみ、⑥は消費者センターのみ操作できる", () => {
    for (const op of ALL_OPS) {
      // ⑤: HLは 作/変/停/削/閲/返信、CSCは全操作不可
      expect(can("R6", "hotline", op), `R6 × hotline × ${op}`).toBe(false);
      expect(can("R5", "consumer-center", op), `R5 × consumer-center × ${op}`).toBe(false);
    }
    expect(can("R5", "hotline", "create")).toBe(true);
    expect(can("R6", "consumer-center", "create")).toBe(true);
  });

  it("④は窓口2機能のすべての操作が不可", () => {
    for (const op of ALL_OPS) {
      expect(can("R4", "hotline", op)).toBe(false);
      expect(can("R4", "consumer-center", op)).toBe(false);
    }
  });

  it("⑨は窓口2機能のすべての操作が不可", () => {
    for (const op of ALL_OPS) {
      expect(can("R9", "hotline", op)).toBe(false);
      expect(can("R9", "consumer-center", op)).toBe(false);
    }
  });
});

describe("⑨⑩の制約（§5.1）", () => {
  it("⑨はAirisアカウント・販売員ID・訪販員申請・稼働提出物のすべての操作が不可", () => {
    const denied: FeatureKey[] = ["airis-account", "sales-staff", "field-agent", "submission"];
    for (const feature of denied) {
      for (const op of ALL_OPS) {
        expect(can("R9", feature, op), `R9 × ${feature} × ${op}`).toBe(false);
      }
    }
    // ⑨に許されるのは日報の提出とお知らせ（全体向け）の閲覧
    expect(can("R9", "daily-report", "submit")).toBe(true);
    expect(can("R9", "announcement-all", "view")).toBe(true);
    expect(can("R9", "announcement-primary", "view")).toBe(false);
  });

  it("⑩は窓口案件の閲覧・返信以外のすべての機能・操作が不可", () => {
    const denied: FeatureKey[] = [
      "airis-account",
      "sales-staff",
      "field-agent",
      "daily-report",
      "submission",
      "announcement-all",
      "announcement-primary",
    ];
    for (const feature of denied) {
      for (const op of ALL_OPS) {
        expect(can("R10", feature, op), `R10 × ${feature} × ${op}`).toBe(false);
      }
    }
  });
});

describe("④ダミー表示（§3.5 / §5.1「ダミー」）", () => {
  it("ダミー対象機能は §5.1 で④が「ダミー」の6機能", () => {
    expect([...DUMMY_FEATURES].sort()).toEqual(
      [
        "announcement-all",
        "announcement-primary",
        "daily-report",
        "field-agent",
        "sales-staff",
        "submission",
      ].sort()
    );
  });

  it("isDummyFeature は④のみ true", () => {
    for (const feature of ALL_FEATURES) {
      for (const role of ALL_ROLES) {
        expect(isDummyFeature(role, feature), `${role} × ${feature}`).toBe(
          role === "R4" && DUMMY_FEATURES.includes(feature)
        );
      }
    }
  });

  it("④はダミー対象機能のすべての操作が不可（書き込みは全て無効化 §3.5）", () => {
    for (const feature of DUMMY_FEATURES) {
      for (const op of ALL_OPS) {
        expect(can("R4", feature, op), `R4 × ${feature} × ${op}`).toBe(false);
      }
    }
    // 例外: Airisアカウント申請は④も実データとして申請可（§3.5 / §6.1）
    expect(can("R4", "airis-account", "apply")).toBe(true);
  });
});

describe("canApproveFirst（最終承認権限は1次承認を内含 §6.2-2）", () => {
  it("販売員ID・訪販員申請・稼働提出物: ①②③⑦が1次承認できる", () => {
    for (const feature of ["sales-staff", "field-agent", "submission"] as FeatureKey[]) {
      for (const role of ALL_ROLES) {
        expect(canApproveFirst(role, feature), `${role} × ${feature}`).toBe(
          ["R1", "R2", "R3", "R7"].includes(role)
        );
      }
    }
  });

  it("Airisアカウント: 1次承認は⑦のみ（§6.1-3。内含を適用しない）", () => {
    for (const role of ALL_ROLES) {
      expect(canApproveFirst(role, "airis-account"), role).toBe(role === "R7");
    }
  });
});

describe("機能キーの解決", () => {
  it("announcementFeature: 宛先 all/primary で行が分かれる", () => {
    expect(announcementFeature("all")).toBe("announcement-all");
    expect(announcementFeature("primary")).toBe("announcement-primary");
  });

  it("caseFeature: HL=ホットライン / CSC=消費者センター", () => {
    expect(caseFeature("HL")).toBe("hotline");
    expect(caseFeature("CSC")).toBe("consumer-center");
  });
});
