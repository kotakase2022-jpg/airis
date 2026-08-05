// ログイン入力のゆらぎ吸収（運用配慮）: コピー&ペースト時の前後空白・引用符の巻き込み、
// IMEの全角英数記号（例: ！→!、Ａ→A）は本人の入力意図が明確なため、原文で不一致の
// 場合に限り正規化した候補で再照合する。候補は「原文が先頭・重複なし」を保証する。
// 受理範囲を広げるだけで従来通る入力は一切変えない（tests/unit/password-candidates.test.ts）。
// server-only を import しないため単体テスト可能（client-ip.ts と同じ方針）。

const QUOTES = ['"', "'", "“", "”", "‘", "’", "「", "」"];

export function passwordInputCandidates(raw: string): string[] {
  const out: string[] = [raw];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  const trimmed = raw.trim();
  push(trimmed);
  push(trimmed.normalize("NFKC"));
  // 引用符ごと貼り付けた場合（例: seed.ts から "Airis-..." を引用符込みでコピー）
  if (
    trimmed.length > 2 &&
    QUOTES.includes(trimmed[0]) &&
    QUOTES.includes(trimmed[trimmed.length - 1])
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    push(unquoted);
    push(unquoted.normalize("NFKC"));
  }
  return out;
}
