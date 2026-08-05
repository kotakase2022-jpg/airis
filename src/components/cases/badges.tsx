import { Badge, StatusBadge } from "@/components/ui";

// JSTの本日（YYYY-MM-DD）
function todayJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

// 日時表示（YYYY-MM-DD HH:mm・JST）
export function fmtDateTime(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// 期限バッジ（§7.8）: 期限まで◯日(グレー) / 本日期限(黄) / 期限超過 ◯日(赤)
export function deadlineInfo(deadline: string | null): { label: string; tone: string } | null {
  if (!deadline) return null;
  const diff = Math.round((Date.parse(deadline) - Date.parse(todayJst())) / 86400000);
  if (Number.isNaN(diff)) return null;
  if (diff > 0) return { label: `期限まで${diff}日`, tone: "gray" };
  if (diff === 0) return { label: "本日期限", tone: "yellow" };
  return { label: `期限超過 ${-diff}日`, tone: "red" };
}

export function DeadlineBadge({ deadline }: { deadline: string | null }) {
  const info = deadlineInfo(deadline);
  if (!info) return null;
  return <Badge tone={info.tone}>{info.label}</Badge>;
}

// ステータスバッジ（§7.8 ステータスのマスタ化）。
// StatusMaster.tone が設定されていればマスタの色を使い（増やした値にも色を付けられる）、
// 未設定なら既定の色分け（ui.tsx の statusTone）に任せる。
export function CaseStatusBadge({ label, tone }: { label: string; tone?: string | null }) {
  if (tone) return <Badge tone={tone}>{label}</Badge>;
  return <StatusBadge label={label} />;
}

// 種別バッジ（§7.10: HL=青系「ホットライン」/ CSC=紫系「消費者センター」。件名に接頭辞は付けない）
export function SeriesBadge({ series }: { series: string }) {
  if (series === "HL") {
    return (
      <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-blue-700">
        ホットライン
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-violet-50 px-2.5 py-0.5 text-xs font-medium whitespace-nowrap text-violet-700">
      消費者センター
    </span>
  );
}

export function seriesLabel(series: string): string {
  return series === "HL" ? "ホットライン窓口" : "消費者センター窓口";
}

export function seriesBasePath(series: string): string {
  return series === "HL" ? "/hotline" : "/consumer-center";
}
