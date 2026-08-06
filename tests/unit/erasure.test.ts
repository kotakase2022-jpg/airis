// 削除完了レポート（§10.3 / SEC要件②#31「削除証明用」）の単体テスト。
//
// 経緯（QA loop5 の独立監査で検出）:
//   QA成果物（qa/REQUIREMENTS_TRACEABILITY.csv の SEC-025 / SEC-027、docs/SEC_CHECKLIST.md の
//   SEC-10.3-10 / SEC-10.3-12）が検証証跡として **`tests/unit/erasure.test.ts` を挙げていたが、
//   このファイルは存在しなかった**。存在しないテストを根拠に要件を PASS と記録していた。
//   さらに削除・匿名化の動作を検証するテストは単体・E2E ともゼロだった。
//   本ファイルはその穴を埋める（citation を実体に合わせるのではなく、実体を作る）。
//
// ここで検証するのは **純粋関数**（DB・現在時刻に依存しない部分）:
//   - レポートの直列化 → 監査ログ target → 復元 の往復（削除証明の中核。ここが壊れると証明できない）
//   - 監査ログ行からのレポート組み立て（旧形式・欠損時のフォールバック含む）
//   - CSV の列と行（対象件数・データ種別・実行日時・実行者を含むこと）
// DBを伴う削除の動作は e2e/04-admin.spec.ts と（今後追加する）e2e の削除シナリオが担当する。

import { describe, it, expect } from "vitest";
import {
  ERASURE_ACTIONS,
  ERASURE_CSV_HEADERS,
  ERASURE_KIND_LABELS,
  erasureCsvRows,
  parseErasureReport,
  serializeErasureReport,
  toErasureReports,
  type ErasureReport,
} from "@/lib/erasure";

const BASE: ErasureReport = {
  kind: "agency",
  targetLabel: "110001 株式会社テスト東都",
  scopeLabel: "自店＋配下2次店2社",
  reason: "解約に伴うデータ削除依頼（2026-08-06 受領）",
  executedBy: "airis_slb_sys_001",
  vendor: true,
  executedAt: "2026-08-06 12:34",
  items: [
    { dataType: "アカウント", count: 12, treatment: "論理削除" },
    { dataType: "販売員", count: 30, treatment: "論理削除" },
    { dataType: "日報", count: 310, treatment: "論理削除" },
  ],
  total: 352,
};

describe("削除完了レポートの直列化 → 復元（§10.3 削除証明）", () => {
  it("往復で内容が保たれる（対象・範囲・件数・データ種別・実行日時・実行者・ベンダー区分）", () => {
    const target = serializeErasureReport(BASE);
    const back = parseErasureReport(BASE.executedBy, target);
    expect(back, "復元できない（削除証明が出せない）").not.toBeNull();
    expect(back!.kind).toBe("agency");
    expect(back!.executedBy).toBe(BASE.executedBy);
    expect(back!.vendor).toBe(true);
    expect(back!.total).toBe(352);
    expect(back!.executedAt).toBe("2026-08-06 12:34");
    // データ種別と件数が失われていないこと（§10.3 が要求する「対象件数・データ種別」）
    expect(back!.items.map((i) => `${i.dataType}:${i.count}`)).toEqual([
      "アカウント:12",
      "販売員:30",
      "日報:310",
    ]);
  });

  it("削除理由が保たれる（= を含んでいても壊れない）", () => {
    const r = { ...BASE, reason: "契約終了=2026-07-31 のため削除" };
    const back = parseErasureReport(r.executedBy, serializeErasureReport(r))!;
    // 直列化は `key=value` 形式なので、理由中の = は全角へ退避される（欠落してはいけない）
    expect(back.reason).toContain("契約終了");
    expect(back.reason).toContain("2026-07-31");
    expect(back.reason.length).toBeGreaterThan(10);
  });

  it("ベンダー操作でない場合は vendor=false として復元される（§10.1 保守区分の区別）", () => {
    const back = parseErasureReport(
      "airis_snc_adm_001",
      serializeErasureReport({ ...BASE, vendor: false })
    )!;
    expect(back.vendor).toBe(false);
  });

  it("個人情報匿名化（kind=pii）も往復できる", () => {
    const r: ErasureReport = {
      ...BASE,
      kind: "pii",
      targetLabel: "110001C001",
      scopeLabel: "販売員1件",
      items: [{ dataType: "販売員", count: 1, treatment: "匿名化" }],
      total: 1,
    };
    const back = parseErasureReport(r.executedBy, serializeErasureReport(r))!;
    expect(back.kind).toBe("pii");
    expect(back.items[0].treatment).toBe("匿名化");
  });

  it("削除以外の監査ログ target は復元しない（誤ってレポート化しない）", () => {
    expect(parseErasureReport("x", null)).toBeNull();
    expect(parseErasureReport("x", "")).toBeNull();
    expect(parseErasureReport("x", "airis_1110001_001 vendor=true")).toBeNull();
    expect(parseErasureReport("x", "account_suspend airis_2210001_001")).toBeNull();
  });

  it("action 値が ERASURE_ACTIONS と一致している（CSV・アラートの照合キー）", () => {
    expect(ERASURE_ACTIONS.agency).toBe("erasure_agency_bulk");
    expect(ERASURE_ACTIONS.pii).toBe("erasure_pii_anonymize");
    expect(Object.keys(ERASURE_KIND_LABELS).sort()).toEqual(["agency", "pii"]);
  });
});

describe("監査ログ行からのレポート組み立て（toErasureReports）", () => {
  const at = new Date("2026-08-06T03:34:00Z"); // JST 12:34

  it("新形式の target からレポートを復元し、監査ログIDを添える", () => {
    const [r] = toErasureReports([
      {
        id: "audit-1",
        actor: BASE.executedBy,
        action: ERASURE_ACTIONS.agency,
        target: serializeErasureReport(BASE),
        createdAt: at,
      },
    ]);
    expect(r.auditId).toBe("audit-1");
    expect(r.total).toBe(352);
    expect(r.executedAt).toBe("2026-08-06 12:34");
  });

  it("旧形式・target 欠損でも実行日時と実行者は残る（削除証明の最低要件）", () => {
    const [r] = toErasureReports([
      {
        id: "audit-2",
        actor: "airis_snc_adm_001",
        action: ERASURE_ACTIONS.pii,
        target: null,
        createdAt: at,
      },
    ]);
    expect(r.kind, "action から種別を判定できていない").toBe("pii");
    expect(r.executedBy).toBe("airis_snc_adm_001");
    // JST へ変換された実行日時が入ること（証明書に必要）
    expect(r.executedAt).toBe("2026-08-06 12:34");
    expect(r.auditId).toBe("audit-2");
  });

  it("実行日時は JST で表示される（§2 Asia/Tokyo 固定）", () => {
    // UTC 15:30 → JST 翌日 00:30。日付が繰り上がることを固定する
    const [r] = toErasureReports([
      {
        id: "a",
        actor: "x",
        action: ERASURE_ACTIONS.agency,
        target: null,
        createdAt: new Date("2026-08-06T15:30:00Z"),
      },
    ]);
    expect(r.executedAt).toBe("2026-08-07 00:30");
  });
});

describe("削除完了レポートCSV（§10.3 削除証明用の出力）", () => {
  it("列が §10.3 の要求（対象件数・データ種別・実行日時・実行者）を満たす", () => {
    for (const col of [
      "実行日時",
      "実行者",
      "操作種別",
      "対象",
      "データ種別",
      "件数",
      "削除理由",
    ]) {
      expect(ERASURE_CSV_HEADERS, `${col} 列が無い`).toContain(col);
    }
    // 監査ログIDが無いと「どの実行分か」を特定できない
    expect(ERASURE_CSV_HEADERS).toContain("監査ログID");
  });

  it("データ種別ごとに1行ずつ出力され、全列が埋まる", () => {
    const rows = erasureCsvRows([{ ...BASE, auditId: "audit-1" }]);
    expect(rows.length, "データ種別3件に対して3行にならない").toBe(3);
    for (const row of rows) {
      expect(row.length, "列数がヘッダと合わない").toBe(ERASURE_CSV_HEADERS.length);
      expect(row.every((c) => c !== undefined && c !== null)).toBe(true);
    }
    // 実行者・実行日時が全行に入る（行を切り出しても証明になるように）
    expect(rows.every((r) => r.includes("airis_slb_sys_001"))).toBe(true);
    expect(rows.every((r) => r.includes("2026-08-06 12:34"))).toBe(true);
  });

  it("件数が数値として出力される（合計の検算ができる）", () => {
    const rows = erasureCsvRows([{ ...BASE, auditId: "audit-1" }]);
    const idx = ERASURE_CSV_HEADERS.indexOf("件数");
    const sum = rows.reduce((s, r) => s + Number(r[idx]), 0);
    expect(sum, "データ種別ごとの件数の合計が total と一致しない").toBe(BASE.total);
  });

  it("ベンダー操作が区別できる（§10.1 / SEC要件①）", () => {
    const idx = ERASURE_CSV_HEADERS.indexOf("ベンダー操作");
    const vendor = erasureCsvRows([{ ...BASE, vendor: true, auditId: "a" }]);
    const normal = erasureCsvRows([{ ...BASE, vendor: false, auditId: "b" }]);
    expect(vendor[0][idx]).not.toBe(normal[0][idx]);
  });

  it("レポートが0件でも空配列を返す（CSV生成が落ちない）", () => {
    expect(erasureCsvRows([])).toEqual([]);
  });
});
