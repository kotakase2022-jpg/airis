import { ReactNode } from "react";

// data-testid を明示的に受け取る（E2Eから領域を特定するため）。
// rest props の spread ではなく明示のプロパティにしているのは、`data-*` はハイフンを含むため
// TypeScript の余剰プロパティ検査が効かず、**転送されない属性を書いても tsc が通ってしまう**ため
// （QA loop3 で `<Card data-testid=…>` が DOM に出ていない事故を検出したので明示的に受ける）。
export function Card({
  children,
  className = "",
  "data-testid": testId,
}: {
  children: ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

export function StatCard({
  value,
  label,
  tone = "blue",
}: {
  value: ReactNode;
  label: string;
  tone?: "blue" | "green" | "purple" | "orange" | "gray" | "red";
}) {
  const tones: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    purple: "bg-violet-50 text-violet-600",
    orange: "bg-amber-50 text-amber-600",
    gray: "bg-slate-100 text-slate-500",
    red: "bg-red-50 text-red-600",
  };
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-lg font-bold ${tones[tone]}`}
      >
        ●
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-slate-800">{value}</div>
        <div className="truncate text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
}

const badgeTones: Record<string, string> = {
  yellow: "bg-amber-50 text-amber-700",
  green: "bg-emerald-50 text-emerald-700",
  gray: "bg-slate-100 text-slate-500",
  red: "bg-red-50 text-red-600",
  blue: "bg-blue-50 text-blue-700",
};

export function Badge({ children, tone = "gray" }: { children: ReactNode; tone?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${badgeTones[tone] ?? badgeTones.gray}`}
    >
      {children}
    </span>
  );
}

export function statusTone(label: string): string {
  if (
    [
      "承認待ち",
      "一次承認待ち",
      "申請中",
      "仮登録",
      "1次店確認中",
      "SNC確認中",
      "本日期限",
    ].includes(label)
  )
    return "yellow";
  if (["登録済み", "本登録", "最終承認済み", "有効", "完了", "記録済み"].includes(label))
    return "green";
  if (["停止", "停止中", "未対応", "未申請", "未設定", "稼働終了"].includes(label)) return "gray";
  if (["削除済", "差戻し", "差戻し・却下", "問題発生", "期限超過", "抹消"].includes(label))
    return "red";
  if (["確認中", "対応中", "稼働"].includes(label)) return "blue";
  return "gray";
}

export function StatusBadge({ label }: { label: string }) {
  return <Badge tone={statusTone(label)}>{label}</Badge>;
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="-mx-6 -mt-6 mb-5 flex items-center justify-between rounded-t-none border-b border-slate-200 bg-white px-6 py-4">
      <h1 className="text-xl font-bold text-slate-800">{title}</h1>
      {action}
    </div>
  );
}

export function InfoBanner({ children }: { children: ReactNode }) {
  return (
    <div className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-900">{children}</div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-slate-200 py-10 text-center text-sm text-slate-400">
      {message}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-base font-bold text-slate-800">{children}</h2>
      {right}
    </div>
  );
}

export const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 bg-white";
export const labelCls = "mb-1 block text-xs font-semibold text-slate-600";
export const btnPrimary =
  "inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50";
export const btnOutline =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50";
export const btnDanger =
  "inline-flex items-center justify-center rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700";
export const btnSuccess =
  "inline-flex items-center justify-center rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700";
export const thCls =
  "px-3 py-2 text-left text-xs font-semibold text-slate-500 bg-slate-50 whitespace-nowrap";
export const tdCls = "px-3 py-2.5 text-sm text-slate-700 border-t border-slate-100 align-top";

// ===== 共有アカウント禁止の注記（§4.2 SEC要件① / §10.1「1人1ID（共有アカウント禁止）」）=====
// 「同一権限を複数名で使う場合も個人ごとに発行（UIの説明文にも明記する）」を満たすための共通部品。
// ログイン画面と同じ文言を使い、アカウント申請フォーム・アカウント一覧にも設置する。
export const SHARED_ACCOUNT_NOTICE_TITLE = "1人1ID（共有アカウント禁止）";
export const SHARED_ACCOUNT_NOTICE_TEXT =
  "同じ権限を複数名で利用する場合も、利用者ごとに個別のアカウントを使用してください。";

export function SingleUserNotice({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600 ${className}`}
    >
      <span className="font-bold text-slate-700">{SHARED_ACCOUNT_NOTICE_TITLE}</span>
      <span className="mx-1 text-slate-400">/</span>
      {SHARED_ACCOUNT_NOTICE_TEXT}
    </div>
  );
}
