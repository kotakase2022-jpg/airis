import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { revalidatePath } from "next/cache";

export default async function NotificationsPage() {
  const user = await requireUser();
  const notifications = await prisma.notification.findMany({
    where: { accountId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  async function markAllRead() {
    "use server";
    const u = await requireUser();
    await prisma.notification.updateMany({
      where: { accountId: u.id, readAt: null },
      data: { readAt: new Date() },
    });
    revalidatePath("/notifications");
  }

  return (
    <div>
      <PageHeader
        title="通知"
        action={
          <form action={markAllRead}>
            <button className="text-sm text-blue-600 hover:underline">すべて既読にする</button>
          </form>
        }
      />
      <Card>
        {notifications.length === 0 ? (
          <EmptyState message="通知はありません。" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {notifications.map((n) => (
              <li key={n.id} className="py-3">
                <div className="flex items-center gap-2">
                  {!n.readAt && <span className="h-2 w-2 rounded-full bg-blue-500" />}
                  <span className="text-sm font-medium text-slate-800">{n.title}</span>
                  <span className="ml-auto text-xs text-slate-400">
                    {n.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                </div>
                {n.body && <p className="mt-1 text-xs text-slate-500">{n.body}</p>}
                {n.link && (
                  <Link href={n.link} className="mt-1 inline-block text-xs text-blue-600 hover:underline">
                    詳細を見る →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
