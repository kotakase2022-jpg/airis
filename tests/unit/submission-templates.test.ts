// 稼働提出物の様式ダウンロード（§7.6）の検証。
//
// 「テンプレート差替え」の残存リスクは *ファイルが差し替わっていない* ことではなく、
// **様式名とファイルの対応がずれて別の様式が配布されること** にある。
// ここでは xlsx を実際に開いてシート名を確認し、対応表が実体と一致していることを検証する。
// （xlsx は zip なので依存を増やさず、`xl/workbook.xml` のシート名だけを素で読み出す）

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { SUBMISSION_KINDS, SUBMISSION_TEMPLATE_FILES } from "@/lib/roles";

const TEMPLATE_DIR = path.join(process.cwd(), "public", "templates");
const ORIGINAL_DIR = path.join(process.cwd(), "docs", "materials", "フォーマット");

// 配布ファイルの元になった原本（発注者提供。①〜⑥の採番付きファイル名）。
// **バイト一致**で突合するため、様式の取り違え・古いファイルの残存を確実に検出できる
// （シート名だけの比較では「注意事項」を共有する②③⑤を判別できなかった）。
const ORIGINAL_FILE: Record<(typeof SUBMISSION_KINDS)[number], string> = {
  "【アライアンス申請書】": "①【アライアンス申請書】_代理店様名.xlsx",
  "【訪販用】稼働エリア申請フォーマット": "②【訪販用】稼働エリア申請フォーマット_代理店様名.xlsx",
  "【ポスティング用】配布エリア申請フォーマット":
    "③【ポスティング用】配布エリア申請フォーマット_代理店様名.xlsx",
  "【独自特典】申請シート": "④【独自特典】申請シート_代理店様名.xlsx",
  "【催事用】稼働エリア申請フォーマット": "⑤【催事用】稼働エリア申請フォーマット_代理店様名.xlsx",
  環境ヒアリングシート: "⑥【代理店様名】環境ヒアリングシート.xlsx",
};

// 各様式のファイルに含まれていなければならないシート名（原本を開いて確認した実体）。
// ②③⑤は先頭シートが同じ「注意事項」なので、判別はバイト一致テストが担う。
const EXPECTED_SHEET: Record<(typeof SUBMISSION_KINDS)[number], string> = {
  "【アライアンス申請書】": "アライアンス申請書",
  "【訪販用】稼働エリア申請フォーマット": "注意事項",
  "【ポスティング用】配布エリア申請フォーマット": "注意事項",
  "【独自特典】申請シート": "独自特典",
  "【催事用】稼働エリア申請フォーマット": "注意事項",
  環境ヒアリングシート: "So-net代理店様向け環境ヒアリングシート",
};

const sha256 = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/**
 * xlsx（zip）から `xl/workbook.xml` を取り出してシート名の配列を返す。
 * zip の中央ディレクトリを走査し、対象エントリだけを inflate する（外部依存なし）。
 */
function sheetNames(file: string): string[] {
  const buf = fs.readFileSync(file);
  const target = Buffer.from("xl/workbook.xml");
  // ローカルファイルヘッダ（PK\x03\x04）を先頭から走査する
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x04034b50) continue;
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const nameStart = i + 30;
    const name = buf.subarray(nameStart, nameStart + nameLen);
    if (!name.equals(target)) continue;
    const dataStart = nameStart + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    // compSize=0 はデータディスクリプタ形式（本ファイル群では未使用）
    if (compSize === 0) return [];
    const xml = (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
    return [...xml.matchAll(/<sheet[^>]*name="([^"]*)"/g)].map((m) => m[1]);
  }
  return [];
}

describe("提出用テンプレート（§7.6 様式ダウンロード）", () => {
  it("SUBMISSION_KINDS の全様式に対応ファイルが定義されている", () => {
    for (const kind of SUBMISSION_KINDS) {
      expect(SUBMISSION_TEMPLATE_FILES[kind], `${kind} の様式ファイルが未定義`).toBeTruthy();
    }
    // 余分な定義が無いこと（様式を削除したときに孤児が残らない）
    expect(Object.keys(SUBMISSION_TEMPLATE_FILES).sort()).toEqual([...SUBMISSION_KINDS].sort());
  });

  it("同じファイルを2つの様式に割り当てていない（取り違えの検出）", () => {
    const files = Object.values(SUBMISSION_TEMPLATE_FILES);
    expect(new Set(files).size).toBe(files.length);
  });

  it.each(SUBMISSION_KINDS)("%s: ファイルが実在し、空でない", (kind) => {
    const file = path.join(TEMPLATE_DIR, SUBMISSION_TEMPLATE_FILES[kind]);
    expect(fs.existsSync(file), `${file} が存在しない`).toBe(true);
    // プレースホルダ（数百バイトの空ブック）ではなく実体のある様式であること
    expect(fs.statSync(file).size).toBeGreaterThan(4000);
  });

  it.each(SUBMISSION_KINDS)("%s: 配布ファイルが発注者提供の原本とバイト一致する", (kind) => {
    const served = path.join(TEMPLATE_DIR, SUBMISSION_TEMPLATE_FILES[kind]);
    const original = path.join(ORIGINAL_DIR, ORIGINAL_FILE[kind]);
    expect(fs.existsSync(original), `原本 ${ORIGINAL_FILE[kind]} が同梱されていない`).toBe(true);
    expect(
      sha256(served),
      `${kind} に割り当てた ${SUBMISSION_TEMPLATE_FILES[kind]} が原本 ${ORIGINAL_FILE[kind]} と一致しない（様式の取り違え／古いファイルの残存）`
    ).toBe(sha256(original));
  });

  it("配布ファイル同士が全て異なる（同じ原本を2様式に配ってしまっていない）", () => {
    const hashes = SUBMISSION_KINDS.map((k) =>
      sha256(path.join(TEMPLATE_DIR, SUBMISSION_TEMPLATE_FILES[k]))
    );
    expect(new Set(hashes).size).toBe(SUBMISSION_KINDS.length);
  });

  it.each(SUBMISSION_KINDS)("%s: ファイルの中身（シート名）が様式と一致する", (kind) => {
    const file = path.join(TEMPLATE_DIR, SUBMISSION_TEMPLATE_FILES[kind]);
    const sheets = sheetNames(file);
    expect(sheets.length, `${file} からシート名を読み出せない（xlsxが壊れている）`).toBeGreaterThan(
      0
    );
    expect(
      sheets,
      `${kind} に割り当てられた ${SUBMISSION_TEMPLATE_FILES[kind]} のシート ${sheets.join("/")} が様式と一致しない`
    ).toContain(EXPECTED_SHEET[kind]);
  });
});
