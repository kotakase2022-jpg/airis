// 誓約書PDFのzip一括アップロード用の最小ZIP展開（SPEC §7.4 / §3.8）
//
// §7.4「誓約書PDFは CSV と同時に zip で一括アップロードし、`誓約書No-連番.pdf` のファイル名で
// CSV 行順に突合する」。**依存追加なし**（package.json は変更しない）で実現するため、
// ZIPのセントラルディレクトリを自前で解析し、各エントリを Node 標準の zlib（inflateRaw）で
// 展開する。ZIPで実際に使われる圧縮方式は stored(0) と deflate(8) の2種で、deflate は
// zlib の raw inflate で展開できる（ZIP は zlib ヘッダを持たない raw deflate ストリーム）。
//
// 対応しないもの（明示的にエラーにして取込を止める。§3.6 部分取込しない）:
//   - ZIP64（4GB超・65535エントリ超）/ 暗号化zip / deflate以外の圧縮方式（bzip2・LZMA等）
//
// セキュリティ（§3.8）:
//   - エントリ名はパス要素を落として **ファイル名のみ** を使う（呼び出し側でサニタイズ）
//   - 展開後の総バイト数・エントリ数に上限を設ける（zip爆弾対策）
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50; // End of Central Directory
const CEN_SIG = 0x02014b50; // Central Directory File Header
const LOC_SIG = 0x04034b50; // Local File Header
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

export type ZipEntry = { name: string; data: Uint8Array<ArrayBuffer> };
export type UnzipResult = { entries: ZipEntry[] } | { error: string };
export type UnzipLimits = { maxEntries: number; maxTotalBytes: number };

function findEocd(buf: Buffer): number {
  const start = Math.max(0, buf.length - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buf.length - EOCD_MIN_SIZE; i >= start; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** zipのエントリ（ディレクトリを除く）を展開する。読めない形式は理由付きでエラーを返す。 */
export function unzipEntries(buf: Buffer, limits: UnzipLimits): UnzipResult {
  if (buf.length < EOCD_MIN_SIZE) return { error: "zipファイルとして読み取れません（サイズ不足）" };
  const eocd = findEocd(buf);
  if (eocd < 0) {
    return { error: "zipファイルとして読み取れません（zip形式ではない可能性があります）" };
  }
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cenOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cenOffset === 0xffffffff) {
    return { error: "ZIP64形式のzipには対応していません（zipを分割して再作成してください）" };
  }
  if (totalEntries === 0) return { entries: [] };
  if (totalEntries > limits.maxEntries) {
    return { error: `zip内のファイル数が上限（${limits.maxEntries}件）を超えています` };
  }

  const entries: ZipEntry[] = [];
  let totalBytes = 0;
  let p = cenOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      return { error: "zipの構造を解析できません（セントラルディレクトリが壊れています）" };
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const locOffset = buf.readUInt32LE(p + 42);
    // ファイル名はUTF-8フラグ（bit11）が立っていればUTF-8。立っていない場合もPDFの命名規則
    // （数字とハイフンのASCII）は同一バイト列になるため utf8 として読む。
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || name.endsWith("\\")) continue; // ディレクトリエントリ
    if (flags & 0x1) return { error: "暗号化されたzipには対応していません" };
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
      return { error: "ZIP64形式のzipには対応していません" };
    }
    if (locOffset + 30 > buf.length || buf.readUInt32LE(locOffset) !== LOC_SIG) {
      return { error: `zip内の「${name}」を読み取れません（ローカルヘッダが不正）` };
    }
    const lNameLen = buf.readUInt16LE(locOffset + 26);
    const lExtraLen = buf.readUInt16LE(locOffset + 28);
    const from = locOffset + 30 + lNameLen + lExtraLen;
    const to = from + compSize;
    if (to > buf.length) {
      return { error: `zip内の「${name}」を読み取れません（データが途中で切れています）` };
    }

    let data: Uint8Array<ArrayBuffer>;
    if (method === 0) {
      data = new Uint8Array(buf.subarray(from, to)); // stored（無圧縮）
    } else if (method === 8) {
      try {
        // ZIPのdeflateは zlib ヘッダなしの raw deflate ストリーム
        data = new Uint8Array(inflateRawSync(buf.subarray(from, to)));
      } catch {
        return { error: `zip内の「${name}」を展開できませんでした（データが壊れています）` };
      }
    } else {
      return {
        error: `zip内の「${name}」の圧縮方式に対応していません（zipは「標準（deflate）」で作成してください）`,
      };
    }
    if (uncompSize > 0 && data.length !== uncompSize) {
      return { error: `zip内の「${name}」の展開結果がサイズ情報と一致しません` };
    }

    totalBytes += data.length;
    if (totalBytes > limits.maxTotalBytes) {
      return {
        error: `zipの展開後の合計サイズが上限（${Math.floor(limits.maxTotalBytes / (1024 * 1024))}MB）を超えています`,
      };
    }
    entries.push({ name, data });
  }
  return { entries };
}
