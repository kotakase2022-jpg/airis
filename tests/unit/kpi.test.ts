// 日報の自動計算KPI（SPEC §7.5「自動計算KPI」）の単体テスト（T-016）。
//
// 検証方針:
//   - §7.5 のKPI定義（生産性・進捗・達成率・着地予想・着地差分・ペースメーカー・対面率・商談率・
//     成約率・訪問|対面|商談/日、テレマのアポ生産性・クローズ通過率・前確通過率・差分・残稼働、
//     集計・実績確認タブの6カード）について計算式と表示書式を突合する。
//   - §7.5「※端数・分母0は「0」表示」を満たすこと。**分母0のケースを必ず含め**、
//     どのタイルにも NaN / Infinity が現れないことを検証する。
//   - 計算対象は純粋関数（src/app/(app)/reports/kpi.ts）のみ。DB・現在時刻には依存しない。
//
// ※ docs/materials/稼働日報/ のExcel原本は本リポジトリに未同梱のため、期待値は §7.5 に明記された
//   計算式（例: 生産性=獲得/稼働数）から導出している。原本入手後は数式差分の確認が必要（§14-5）。

import { describe, it, expect } from "vitest";
import {
  num,
  div,
  round1,
  pct,
  fx,
  daysInMonth,
  firstForecast,
  firstForecastRec,
  calcVisitKpi,
  calcTeleKpi,
  calcSummaryKpi,
  normalizeDate,
  monthRange,
  type KpiReport,
} from "@/app/(app)/reports/kpi";

// タイル配列を { ラベル: 値 } に変換（順序に依存しない突合のため）
const byLabel = (tiles: { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(tiles.map((t) => [t.label, t.value]));

describe("表示ヘルパ（§7.5「端数・分母0は「0」表示」）", () => {
  it("num: 未入力・非数は0として扱う", () => {
    expect(num(3)).toBe(3);
    expect(num(0)).toBe(0);
    expect(num(null)).toBe(0);
    expect(num(undefined)).toBe(0);
    expect(num(NaN)).toBe(0);
    expect(num(Infinity)).toBe(0);
    expect(num(-Infinity)).toBe(0);
  });

  it("div: 分母0（および未入力・非数）は0を返す", () => {
    expect(div(10, 4)).toBe(2.5);
    expect(div(0, 4)).toBe(0);
    expect(div(10, 0)).toBe(0); // 分母0 → 0（NaN/Infinityにしない）
    expect(div(0, 0)).toBe(0);
    expect(div(10, null)).toBe(0);
    expect(div(10, undefined)).toBe(0);
    expect(div(null, 10)).toBe(0);
    expect(div(NaN, 10)).toBe(0);
    expect(div(10, NaN)).toBe(0);
    expect(Number.isFinite(div(10, 0))).toBe(true);
  });

  it("round1 / fx / pct: 小数第1位まで、非数は0表示", () => {
    expect(round1(1.75)).toBe(1.8);
    expect(round1(NaN)).toBe(0);
    expect(fx(0)).toBe("0");
    expect(fx(1.24)).toBe("1.2");
    expect(fx(-144.5)).toBe("-144.5");
    expect(fx(div(1, 0))).toBe("0"); // 分母0
    expect(pct(0)).toBe("0%");
    expect(pct(0.3333)).toBe("33.3%");
    expect(pct(div(1, 0))).toBe("0%"); // 分母0
    expect(pct(NaN)).toBe("0%");
  });
});

describe("daysInMonth（月日数。進捗・着地予想・ペースメーカーの分母）", () => {
  it.each([
    ["2026-01", 31],
    ["2026-02", 28],
    ["2024-02", 29], // うるう年
    ["2000-02", 29], // 400年ルール
    ["2100-02", 28], // 100年ルール
    ["2026-04", 30],
    ["2026-08", 31],
    ["2026-12", 31],
  ])("%s → %i日", (month, expected) => {
    expect(daysInMonth(month)).toBe(expected);
  });

  it("不正な月は0（分母0として div() が0を返す）", () => {
    expect(daysInMonth("2026-13")).toBe(0);
    expect(daysInMonth("2026-00")).toBe(0);
    expect(daysInMonth("")).toBe(0);
    expect(daysInMonth("abcd-ef")).toBe(0);
  });
});

describe("月初見込（要件6-3「月の初回提出時のみ入力」）", () => {
  it("月内で最古日付の見込を採用する（入力順に依存しない）", () => {
    expect(
      firstForecast([
        { date: "2026-08-10", value: 50 },
        { date: "2026-08-03", value: 30 },
        { date: "2026-08-20", value: 99 },
      ])
    ).toEqual({ date: "2026-08-03", value: 30 });
  });

  it("見込が1件も無ければ null（KPI側で0扱い＝達成率0%）", () => {
    expect(firstForecast([{ date: "2026-08-01", value: null }])).toBeNull();
    expect(firstForecastRec([{ date: "2026-08-01" }], "forecastAcq")).toBeNull();
  });

  it("フィールド別に判定する（訪販=forecastAcq / テレマ=forecastHours・forecastEntries）", () => {
    const rows = [
      { date: "2026-08-02", forecastAcq: null, forecastHours: 160 },
      { date: "2026-08-05", forecastAcq: 30, forecastHours: null },
    ];
    expect(firstForecastRec(rows, "forecastAcq")).toEqual({ date: "2026-08-05", value: 30 });
    expect(firstForecastRec(rows, "forecastHours")).toEqual({ date: "2026-08-02", value: 160 });
    expect(firstForecastRec(rows, "forecastEntries")).toBeNull();
  });
});

describe("calcVisitKpi（訪販12タイル §7.5）", () => {
  // 2026-08（31日）の5日時点。獲得計5 / 稼働計5 / 訪問計100 / 対面計50 / 商談計30 / 成約計10、
  // 月初見込30、日報提出日数2日。
  const REPORTS: KpiReport[] = [
    {
      date: "2026-08-01",
      forecastAcq: 30,
      acquisitions: 2,
      workers: 2,
      visits: 40,
      meetings: 20,
      negotiations: 10,
      contracts: 5,
    },
    {
      date: "2026-08-05",
      acquisitions: 3,
      workers: 3,
      visits: 60,
      meetings: 30,
      negotiations: 20,
      contracts: 5,
    },
  ];

  it("プロトタイプ準拠の12タイルがこの順で並ぶ（§7.5）", () => {
    expect(calcVisitKpi(REPORTS, "2026-08-05").map((t) => t.label)).toEqual([
      "生産性",
      "進捗",
      "達成率",
      "着地予想",
      "着地差分",
      "ペースメーカー",
      "対面率",
      "商談率",
      "成約率",
      "訪問/日",
      "対面/日",
      "商談/日",
    ]);
  });

  it("各KPIを §7.5 の定義どおり計算する", () => {
    const k = byLabel(calcVisitKpi(REPORTS, "2026-08-05"));
    expect(k["生産性"]).toBe("1"); // 獲得5 / 稼働5
    expect(k["進捗"]).toBe("16.1%"); // 経過5日 / 31日
    expect(k["達成率"]).toBe("16.7%"); // 獲得5 / 見込30
    expect(k["着地予想"]).toBe("31"); // (獲得5 / 経過5) × 31日
    expect(k["着地差分"]).toBe("1"); // 着地予想31 - 見込30
    expect(k["ペースメーカー"]).toBe("4.8"); // (見込30 / 31日) × 経過5日
    expect(k["対面率"]).toBe("50%"); // 対面50 / 訪問100
    expect(k["商談率"]).toBe("60%"); // 商談30 / 対面50
    expect(k["成約率"]).toBe("33.3%"); // 成約10 / 商談30
    expect(k["訪問/日"]).toBe("50"); // 訪問100 / 提出日数2
    expect(k["対面/日"]).toBe("25"); // 対面50 / 提出日数2
    expect(k["商談/日"]).toBe("15"); // 商談30 / 提出日数2
  });

  it("日報0件（全分母0）でも0表示になる（進捗のみ暦ベースなので残る）", () => {
    const tiles = calcVisitKpi([], "2026-08-05");
    expect(tiles).toHaveLength(12);
    for (const t of tiles) {
      // 「進捗」は月内経過日数ベース（§7.5）で日報の有無に依存しないため除外する
      if (t.label === "進捗") continue;
      expect(t.value, `${t.label} が0表示でない`).toMatch(/^0%?$/);
    }
    expect(byLabel(tiles)["進捗"]).toBe("16.1%"); // 経過5日 / 31日
  });

  it("分母0の項目だけが0になり、他の項目は計算される（稼働数0・訪問数0など）", () => {
    const k = byLabel(
      calcVisitKpi(
        [
          {
            date: "2026-08-05",
            forecastAcq: null, // 月初見込なし → 達成率・着地差分・ペースメーカーは0
            acquisitions: 4,
            workers: 0, // 生産性の分母0
            visits: 0, // 対面率の分母0
            meetings: 0, // 商談率の分母0
            negotiations: 0, // 成約率の分母0
            contracts: 3,
          },
        ],
        "2026-08-05"
      )
    );
    expect(k["生産性"]).toBe("0");
    expect(k["達成率"]).toBe("0%");
    expect(k["着地差分"]).toBe("0");
    expect(k["ペースメーカー"]).toBe("0");
    expect(k["対面率"]).toBe("0%");
    expect(k["商談率"]).toBe("0%");
    expect(k["成約率"]).toBe("0%");
    // 分母が0でない項目は計算される: 進捗=5/31、着地予想=(4/5)×31=24.8、訪問/日=0/1
    expect(k["進捗"]).toBe("16.1%");
    expect(k["着地予想"]).toBe("24.8");
    expect(k["訪問/日"]).toBe("0");
  });

  it("未入力（null/undefined）の項目は0として合算する", () => {
    const k = byLabel(
      calcVisitKpi(
        [
          { date: "2026-08-01", acquisitions: null, workers: 2, visits: 10, meetings: 5 },
          { date: "2026-08-02", acquisitions: 4, workers: undefined, visits: 10, meetings: 5 },
        ],
        "2026-08-02"
      )
    );
    expect(k["生産性"]).toBe("2"); // 獲得(0+4) / 稼働(2+0)
    expect(k["対面率"]).toBe("50%"); // 対面10 / 訪問20
  });

  it("経過日数0・月日数0（不正な日付）でも0除算にならない", () => {
    for (const date of ["2026-13-05", "", "2026-08-00"]) {
      for (const t of calcVisitKpi([{ date: "2026-08-01", acquisitions: 3 }], date)) {
        expect(t.value, `${date} / ${t.label}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });
});

describe("calcTeleKpi（テレマ §7.5）", () => {
  const REPORTS: KpiReport[] = [
    {
      date: "2026-08-01",
      forecastHours: 160,
      forecastEntries: 200,
      actualHours: 7.5,
      entries: 20,
      appointments: 4,
      closePassed: 2,
      preConfirmPassed: 1,
    },
    {
      date: "2026-08-02",
      actualHours: 8,
      entries: 10,
      appointments: 6,
      closePassed: 3,
      preConfirmPassed: 2,
    },
  ];

  it("アポ生産性・クローズ通過率・前確通過率・差分・残稼働を計算する", () => {
    const k = byLabel(calcTeleKpi(REPORTS));
    expect(k["アポ生産性"]).toBe("0.6"); // アポ10 / 稼働時間15.5
    expect(k["クローズ通過率"]).toBe("50%"); // クローズ通過5 / アポ10
    expect(k["前確通過率"]).toBe("60%"); // 前確通過3 / クローズ通過5
    expect(k["稼働時間差分"]).toBe("-144.5"); // 実績15.5 - 見込160
    expect(k["エントリー数差分"]).toBe("-170"); // 実績30 - 見込200
    expect(k["残稼働"]).toBe("144.5"); // 見込160 - 実績15.5
  });

  it("日報0件（全分母0）でも全タイルが0表示になる", () => {
    for (const t of calcTeleKpi([])) {
      expect(t.value, `${t.label} が0表示でない`).toMatch(/^0%?$/);
    }
  });

  it("稼働時間0・アポ0・クローズ通過0（分母0）でもNaN/Infinityにならない", () => {
    const k = byLabel(
      calcTeleKpi([
        {
          date: "2026-08-01",
          actualHours: 0, // アポ生産性の分母0
          entries: 5,
          appointments: 0, // クローズ通過率の分母0
          closePassed: 0, // 前確通過率の分母0
          preConfirmPassed: 0,
        },
      ])
    );
    expect(k["アポ生産性"]).toBe("0");
    expect(k["クローズ通過率"]).toBe("0%");
    expect(k["前確通過率"]).toBe("0%");
    expect(k["稼働時間差分"]).toBe("0");
    expect(k["エントリー数差分"]).toBe("5"); // 見込未入力(0) → 実績5との差分
    expect(k["残稼働"]).toBe("0");
  });
});

describe("calcSummaryKpi（集計・実績確認タブのKPIカード6枚 §7.5）", () => {
  it("生産性=獲得計/稼働数計、成約率=成約数計/商談数計", () => {
    expect(
      calcSummaryKpi({
        reportCount: 10,
        acquisitions: 7,
        closePassed: 5,
        workers: 4,
        negotiations: 30,
        contracts: 9,
        submissionCount: 3,
        approvedCount: 1,
      })
    ).toEqual({
      reportCount: 10,
      results: 12, // 獲得7 + クローズ通過5（暫定定義 §14-5）
      productivity: 1.8, // 7 / 4 = 1.75 → 小数第1位
      closeRate: "30%", // 9 / 30
      submissionCount: 3,
      approvedCount: 1,
    });
  });

  it("稼働数0・商談数0（分母0）でも0表示になる", () => {
    const kpi = calcSummaryKpi({
      reportCount: 0,
      acquisitions: 0,
      closePassed: 0,
      workers: 0,
      negotiations: 0,
      contracts: 0,
      submissionCount: 0,
      approvedCount: 0,
    });
    expect(kpi.productivity).toBe(0);
    expect(Number.isFinite(kpi.productivity)).toBe(true);
    expect(kpi.closeRate).toBe("0%");
    expect(kpi.results).toBe(0);
  });

  it("獲得はあるが稼働数0（0除算）でも生産性は0", () => {
    const kpi = calcSummaryKpi({
      reportCount: 1,
      acquisitions: 5,
      closePassed: 0,
      workers: 0,
      negotiations: 0,
      contracts: 2,
      submissionCount: 0,
      approvedCount: 0,
    });
    expect(kpi.productivity).toBe(0);
    expect(kpi.closeRate).toBe("0%");
    expect(String(kpi.productivity)).not.toMatch(/NaN|Infinity/);
  });
});

describe("集計・実績確認タブの期間フィルタ（S5-038）", () => {
  it("normalizeDate: YYYY-MM-DD かつ実在する日付のみ採用する", () => {
    expect(normalizeDate("2026-08-05")).toBe("2026-08-05");
    expect(normalizeDate("2024-02-29")).toBe("2024-02-29"); // うるう年
    expect(normalizeDate("2026-02-29")).toBeNull(); // 平年に29日は無い
    expect(normalizeDate("2026-13-01")).toBeNull();
    expect(normalizeDate("2026-08-00")).toBeNull();
    expect(normalizeDate("2026-8-5")).toBeNull();
    expect(normalizeDate("")).toBeNull();
    expect(normalizeDate(undefined)).toBeNull();
    expect(normalizeDate("2026-08-05'; DROP TABLE--")).toBeNull();
  });

  it("monthRange: 当月の初日〜末日を返す（期間フィルタの既定値）", () => {
    expect(monthRange("2026-08")).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2024-02")).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(monthRange("2026-13")).toEqual({ from: "", to: "" }); // 不正な月
  });
});

describe("全KPIタイルの不変条件（分母0でもNaN/Infinityを出さない）", () => {
  // 分母になり得る項目を0・null・未指定にした組み合わせを総当たりで通す
  const EDGE_REPORTS: KpiReport[][] = [
    [],
    [{ date: "2026-08-01" }],
    [{ date: "2026-08-01", acquisitions: 5 }],
    [{ date: "2026-08-01", workers: 0, visits: 0, meetings: 0, negotiations: 0, contracts: 0 }],
    [{ date: "2026-08-01", forecastAcq: 0, acquisitions: 3, workers: 0 }],
    [{ date: "2026-08-01", actualHours: 0, appointments: 0, closePassed: 0 }],
    [{ date: "2026-08-01", forecastHours: 0, forecastEntries: 0, actualHours: 0, entries: 0 }],
    [
      { date: "2026-08-01", acquisitions: null, workers: null, visits: null },
      { date: "2026-08-01", acquisitions: 1, workers: 1, visits: 1 }, // 同日重複（提出日数1）
    ],
  ];
  const DATES = ["2026-08-01", "2026-02-28", "2024-02-29", "2026-12-31"];

  it.each(EDGE_REPORTS.map((r, i) => [i, r] as const))(
    "パターン%i: 訪販・テレマの全タイルが有限値の0表示になる",
    (_i, reports) => {
      for (const date of DATES) {
        for (const t of [...calcVisitKpi(reports, date), ...calcTeleKpi(reports)]) {
          expect(t.value, `${date} / ${t.label}`).not.toMatch(/NaN|Infinity|undefined/);
          // 「12.3%」「-144.5」等を数値化して有限であることを確認する
          expect(Number.isFinite(Number(t.value.replace("%", ""))), `${t.label}`).toBe(true);
        }
      }
    }
  );
});
