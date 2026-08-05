import { describe, it, expect } from "vitest";
import { toCsv, parseCsv } from "@/lib/csv";

const BOM = "﻿";

describe("toCsv（§2 単体テスト: CSVエクスポート）", () => {
  it("UTF-8 BOM で始まる（Excel互換）", () => {
    const csv = toCsv(["a"], [["x"]]);
    expect(csv.startsWith(BOM)).toBe(true);
  });

  it("ヘッダ行 + データ行を CRLF で連結する", () => {
    const csv = toCsv(
      ["id", "name"],
      [
        ["1", "山田"],
        ["2", "佐藤"],
      ]
    );
    expect(csv).toBe(BOM + "id,name\r\n1,山田\r\n2,佐藤");
  });

  it("カンマを含む値は二重引用符で囲む", () => {
    const csv = toCsv(["memo"], [["a,b"]]);
    expect(csv).toBe(BOM + 'memo\r\n"a,b"');
  });

  it('二重引用符は "" にエスケープして引用する', () => {
    const csv = toCsv(["memo"], [['say "hi"']]);
    expect(csv).toBe(BOM + 'memo\r\n"say ""hi"""');
  });

  it("改行を含む値は二重引用符で囲む", () => {
    const csv = toCsv(["memo"], [["line1\nline2"]]);
    expect(csv).toBe(BOM + 'memo\r\n"line1\nline2"');
  });

  it("null / undefined は空文字として出力する", () => {
    const csv = toCsv(["a", "b", "c"], [[null, undefined, "x"]]);
    expect(csv).toBe(BOM + "a,b,c\r\n,,x");
  });

  it("数値は文字列化して出力する（エスケープ不要）", () => {
    const csv = toCsv(["n"], [[42], [0]]);
    expect(csv).toBe(BOM + "n\r\n42\r\n0");
  });
});

describe("parseCsv（§2 単体テスト: CSVインポート）", () => {
  it("単純な複数行CSVをパースする（LF区切り）", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("先頭のBOMを除去する", () => {
    expect(parseCsv(BOM + "a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("引用符内のカンマはフィールド区切りとして扱わない", () => {
    expect(parseCsv('name,memo\n"a,b",c')).toEqual([
      ["name", "memo"],
      ["a,b", "c"],
    ]);
  });

  it('引用符内の "" は " として復元する', () => {
    expect(parseCsv('memo\n"say ""hi"""')).toEqual([["memo"], ['say "hi"']]);
  });

  it("引用符内の改行はフィールド値として保持する", () => {
    expect(parseCsv('memo,x\n"line1\nline2",y')).toEqual([
      ["memo", "x"],
      ["line1\nline2", "y"],
    ]);
  });

  it("CRLF改行のCSVをパースできる", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("空行（全フィールドが空の行）はスキップする", () => {
    expect(parseCsv("a,b\n\n1,2\n,\n\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("末尾に改行が無い最終行も取り込む", () => {
    expect(parseCsv("a\n1")).toEqual([["a"], ["1"]]);
  });

  it("toCsv の出力を parseCsv で往復できる（エスケープ込み）", () => {
    const headers = ["id", "memo", "note"];
    const rows = [
      ["1", 'a,"b"', "line1\nline2"],
      ["2", "", "plain"],
    ];
    expect(parseCsv(toCsv(headers, rows))).toEqual([headers, ...rows]);
  });
});
