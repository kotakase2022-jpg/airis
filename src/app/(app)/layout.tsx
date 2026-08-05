import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MENU, ROLE_LABELS } from "@/lib/roles";
import { Bell } from "lucide-react";
import { NavLinks } from "@/components/nav";
import { HeaderTitle } from "@/components/page-icons";
import { logoutAction } from "@/app/(auth)/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword) redirect("/password");

  const menu = MENU.filter((m) => m.roles.includes(user.role));
  const unread = await prisma.notification.count({
    where: { accountId: user.id, readAt: null },
  });

  return (
    <div className="flex min-h-screen bg-[#F5F7FB]">
      <aside className="fixed inset-y-0 left-0 flex w-64 flex-col border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-lg font-bold text-white">
              A
            </div>
            <div className="text-sm font-bold leading-tight text-slate-800">
              販売代理店支援
              <br />
              ポータル
            </div>
          </div>
          <span className="mt-2 inline-flex rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
            {ROLE_LABELS[user.role]}
          </span>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <NavLinks items={menu.map(({ key, label, href }) => ({ key, label, href }))} />
        </nav>
        <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
          <div className="mb-1 truncate font-medium text-slate-700">{user.name}</div>
          <div className="truncate">{user.loginId}</div>
          {!user.mfaEnabled && (
            // ⑨販売員はMFA利用任意（§4.2）。未登録の場合のみ任意登録への導線を出す
            <Link href="/mfa/setup" className="mt-2 inline-block text-blue-600 hover:underline">
              MFA設定（推奨）
            </Link>
          )}
        </div>
      </aside>
      <div className="ml-64 flex-1">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-200 bg-white px-6 py-3">
          {/* ヘッダ左: 現在ページのアイコン+太字タイトル */}
          <HeaderTitle items={menu.map(({ key, label, href }) => ({ key, label, href }))} />
          <div className="ml-auto flex items-center gap-3">
            {user.agencyName && (
              <span className="text-xs text-slate-500">{user.agencyName}</span>
            )}
            <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-700">
              {ROLE_LABELS[user.role]} モード
            </span>
            <form action={logoutAction}>
              <button className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                ログアウト
              </button>
            </form>
            <Link
              href="/notifications"
              aria-label="通知"
              className="relative rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-600 hover:bg-slate-50"
            >
              <Bell className="h-4 w-4" />
              {unread > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                  {unread}
                </span>
              )}
            </Link>
          </div>
        </header>
        <main className="p-6">{children}</main>
      </div>
    </div>
  );
}
