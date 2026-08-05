"use client";

// ページアイコン（lucide-react のSVG。絵文字は使わない）。
// サイドメニューとヘッダのページタイトルで共用する（§11.1 / UI要件）。
import {
  Bell,
  Building2,
  ClipboardList,
  FileText,
  Headphones,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Settings,
  ShieldAlert,
  UserPlus,
  Users,
} from "lucide-react";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

type IconType = ComponentType<{ className?: string }>;

// PageKey → アイコン
const ICONS: Record<string, IconType> = {
  dashboard: LayoutDashboard,
  "account-requests": UserPlus,
  "sales-staff": Users,
  "field-agents": ClipboardList,
  reports: FileText,
  agencies: Building2,
  admin: Settings,
  hotline: Headphones,
  "consumer-center": ShieldAlert,
  "agency-cases": MessageSquare,
  announcements: Megaphone,
  documents: FileText,
  notifications: Bell,
};

export function PageIcon({ page, className }: { page: string; className?: string }) {
  const Icon = ICONS[page] ?? FileText;
  return <Icon className={className ?? "h-4 w-4"} />;
}

// ヘッダ左のページアイコン+太字タイトル。現在のパスから該当メニュー項目を解決する。
export function HeaderTitle({ items }: { items: { key: string; label: string; href: string }[] }) {
  const pathname = usePathname();
  // 最長一致（/reports より /reports/xxx を優先しないよう href の長い順で判定）
  const item = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((m) => pathname === m.href || pathname.startsWith(m.href + "/"));
  const label = item?.label ?? (pathname.startsWith("/notifications") ? "通知" : "");
  const key = item?.key ?? (pathname.startsWith("/notifications") ? "notifications" : "dashboard");
  if (!label) return null;
  return (
    <div className="flex items-center gap-2">
      <PageIcon page={key} className="h-5 w-5 text-blue-600" />
      <span className="text-sm font-bold text-slate-800">{label}</span>
    </div>
  );
}
