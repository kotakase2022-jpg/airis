// ステータスのマスタ化（§7.8「ステータス: 未対応 / 確認中 / 対応中 / 問題発生 / 完了 を案件画面から
// 変更可能（値はマスタ化して増減できる実装に）」）と、状態遷移履歴（§4.1）の単体テスト。
//
// 検証すること:
//  1. マスタ未投入時は コード側の既定値（roles.ts の CASE_STATUSES）へフォールバックする
//  2. マスタ投入時はマスタが優先される（既定値とマージしない = 値を「減らせる」）
//  3. active=false の行は除外される
//  4. sortOrder の昇順に並ぶ
//  5. recordStatusHistory が StatusHistory へ遷移イベントを記録する（reject も受け付ける）

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CASE_STATUSES } from "@/lib/roles";

// DBアクセスはモックする（単体テストは純粋なロジックのみを対象とする）。
// src/lib/status.ts は "./prisma"（= @/lib/prisma）を import するため、同じモジュールIDを差し替える。
const db = vi.hoisted(() => ({
  rows: [] as { value: string; sortOrder: number; tone: string | null; active: boolean }[],
  created: [] as Record<string, unknown>[],
  failMaster: false,
  failHistory: false,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    statusMaster: {
      findMany: async () => {
        if (db.failMaster) throw new Error('relation "StatusMaster" does not exist');
        return db.rows;
      },
    },
    statusHistory: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (db.failHistory) throw new Error('relation "StatusHistory" does not exist');
        db.created.push(data);
        return data;
      },
      findMany: async () => [],
    },
  },
}));

const {
  resolveStatusOptions,
  resolveStatusValues,
  caseStatusValues,
  caseStatusOptions,
  defaultCaseStatus,
  isCaseStatus,
  recordStatusHistory,
  statusEventLabel,
  STATUS_EVENTS,
  STATUS_KIND_CASE,
} = await import("@/lib/status");

type Row = { value: string; sortOrder: number; tone: string | null; active: boolean };
const row = (value: string, sortOrder: number, active = true, tone: string | null = null): Row => ({
  value,
  sortOrder,
  tone,
  active,
});

beforeEach(() => {
  db.rows = [];
  db.created = [];
  db.failMaster = false;
  db.failHistory = false;
});

describe("§7.8 ステータスマスタの解決（純粋関数）", () => {
  it("マスタ未投入時はコード側の既定値（CASE_STATUSES）へフォールバックする", () => {
    expect(resolveStatusValues([], CASE_STATUSES)).toEqual([
      "未対応",
      "確認中",
      "対応中",
      "問題発生",
      "完了",
    ]);
    // 仕様の5値がそのまま既定値であること（表記は §7.8 のとおり）
    expect(resolveStatusValues([], CASE_STATUSES)).toEqual([...CASE_STATUSES]);
  });

  it("マスタ投入時はマスタが優先される（既定値とマージせず、値を減らせる）", () => {
    const rows = [row("未対応", 10), row("完了", 20)];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual(["未対応", "完了"]);
  });

  it("マスタ投入時は既定値に無い値も選択肢に増える（コード変更なしの増設）", () => {
    const rows = [row("未対応", 10), row("エスカレーション中", 25), row("完了", 30)];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toContain("エスカレーション中");
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual([
      "未対応",
      "エスカレーション中",
      "完了",
    ]);
  });

  it("active=false の行は除外される", () => {
    const rows = [row("未対応", 10), row("問題発生", 20, false), row("完了", 30)];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual(["未対応", "完了"]);
  });

  it("すべて active=false の場合は既定値へフォールバックする（画面が空にならない）", () => {
    const rows = [row("未対応", 10, false), row("完了", 20, false)];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual([...CASE_STATUSES]);
  });

  it("sortOrder の昇順に並ぶ（取得順に依存しない）", () => {
    const rows = [
      row("完了", 50),
      row("未対応", 10),
      row("問題発生", 40),
      row("確認中", 20),
      row("対応中", 30),
    ];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual([
      "未対応",
      "確認中",
      "対応中",
      "問題発生",
      "完了",
    ]);
  });

  it("sortOrder が同値の行は取得順（DBのorderBy）を保つ（安定ソート）", () => {
    const rows = [row("A", 0), row("B", 0), row("C", 0)];
    expect(resolveStatusValues(rows, CASE_STATUSES)).toEqual(["A", "B", "C"]);
  });

  it("tone（バッジ色）はマスタの値を引き継ぐ / 未設定は null", () => {
    const rows = [row("未対応", 10, true, "gray"), row("完了", 20)];
    expect(resolveStatusOptions(rows, CASE_STATUSES)).toEqual([
      { value: "未対応", tone: "gray" },
      { value: "完了", tone: null },
    ]);
  });

  it("フォールバック時の tone は null（既定の色分け ui.tsx statusTone に委ねる）", () => {
    expect(resolveStatusOptions([], ["未対応"])).toEqual([{ value: "未対応", tone: null }]);
  });
});

describe("§7.8 窓口案件ステータスのマスタ読み出し（DBモック）", () => {
  it("kind は case（StatusMaster.kind）", () => {
    expect(STATUS_KIND_CASE).toBe("case");
  });

  it("マスタ未投入時は既定値、投入時はマスタ値を返す", async () => {
    expect(await caseStatusValues()).toEqual([...CASE_STATUSES]);

    // DBに1件INSERTした状態（コード変更なしに選択肢が増える §7.8）
    db.rows = [
      row("未対応", 10),
      row("確認中", 20),
      row("対応中", 30),
      row("問題発生", 40),
      row("完了", 50),
      row("SNC確認待ち", 60),
    ];
    expect(await caseStatusValues()).toEqual([
      "未対応",
      "確認中",
      "対応中",
      "問題発生",
      "完了",
      "SNC確認待ち",
    ]);
    expect(await caseStatusOptions()).toHaveLength(6);
  });

  it("既定ステータス（起票時）はマスタの先頭", async () => {
    expect(await defaultCaseStatus()).toBe("未対応");
    db.rows = [row("受付", 5), row("完了", 10)];
    expect(await defaultCaseStatus()).toBe("受付");
  });

  it("isCaseStatus はマスタ値のみ許可する（server action のバリデーション）", async () => {
    db.rows = [row("未対応", 10), row("SNC確認待ち", 20)];
    expect(await isCaseStatus("SNC確認待ち")).toBe(true);
    // マスタから外した値・存在しない値は拒否
    expect(await isCaseStatus("完了")).toBe(false);
    expect(await isCaseStatus("")).toBe(false);
    expect(await isCaseStatus("<script>")).toBe(false);
  });

  it("テーブル不在・DBエラー時も既定値で動作する（画面を落とさない）", async () => {
    db.failMaster = true;
    expect(await caseStatusValues()).toEqual([...CASE_STATUSES]);
  });
});

describe("§4.1 状態遷移履歴（StatusHistory）", () => {
  it("遷移イベントを時刻・実行者付きで記録する", async () => {
    await recordStatusHistory({
      entityType: "case",
      entityId: "case-1",
      event: "update",
      fromStatus: "未対応",
      toStatus: "対応中",
      changedBy: "snc-ope",
    });
    expect(db.created).toEqual([
      {
        entityType: "case",
        entityId: "case-1",
        event: "update",
        fromStatus: "未対応",
        toStatus: "対応中",
        reason: null,
        changedBy: "snc-ope",
      },
    ]);
  });

  it("§4.1 が例示する遷移イベントをすべて受け付ける（reject を含む）", async () => {
    for (const event of [
      "requested",
      "approve_first",
      "final_approve",
      "reject",
      "suspend",
      "resume",
      "delete",
    ] as const) {
      expect(STATUS_EVENTS).toContain(event);
    }
    await recordStatusHistory({
      entityType: "account_request",
      entityId: "req-1",
      event: "reject",
      fromStatus: "承認待ち",
      toStatus: "差戻し・却下",
      reason: "住所の記載が不足",
      changedBy: "snc-admin",
    });
    expect(db.created[0]).toMatchObject({
      entityType: "account_request",
      event: "reject",
      reason: "住所の記載が不足",
    });
  });

  it("記録の失敗で業務処理を止めない（例外を投げない）", async () => {
    db.failHistory = true;
    await expect(
      recordStatusHistory({
        entityType: "case",
        entityId: "case-1",
        event: "suspend",
        fromStatus: "対応中",
        toStatus: "停止",
        changedBy: "snc-ope",
      })
    ).resolves.toBeUndefined();
    expect(db.created).toEqual([]);
  });

  it("イベントの表示ラベルは §5.1 の凡例・§4.1 の用語に沿う", () => {
    expect(statusEventLabel("approve_first")).toBe("1次承認");
    expect(statusEventLabel("final_approve")).toBe("最終承認");
    expect(statusEventLabel("reject")).toBe("差戻し・却下");
    expect(statusEventLabel("suspend")).toBe("停止");
    expect(statusEventLabel("delete")).toBe("削除");
    // 未知のイベントはそのまま表示（欠落で画面が崩れない）
    expect(statusEventLabel("unknown_event")).toBe("unknown_event");
  });
});
