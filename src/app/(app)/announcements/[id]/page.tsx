import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES } from "@/lib/roles";
import { Card, Badge, PageHeader, SectionTitle, btnOutline } from "@/components/ui";

const AUDIENCE_LABELS: Record<string, string> = {
  all: "全体向け",
  primary: "1次店向け",
};

function fmtJst(d: Date | null): string {
  if (!d) return "-";
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

export default async function AnnouncementDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePage("announcements");
  const { id } = await params;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.status === "deleted") notFound();

  const isAdmin = !user.dummy && SNC_ADMIN_ROLES.includes(user.role);
  if (!isAdmin) {
    // 閲覧側: 自分が対象のお知らせのみ（⑧⑨は全体向けのみ）。停止中も非表示
    const audiences = user.role === "R7" || user.dummy ? ["all", "primary"] : ["all"];
    if (ann.status !== "sent" || !audiences.includes(ann.audience)) {
      redirect("/announcements");
    }
  }

  // 既読記録（重要以外も全部記録する。④ダミーは記録しない）
  if (!user.dummy) {
    await prisma.announcementRead.upsert({
      where: { announcementId_accountId: { announcementId: ann.id, accountId: user.id } },
      update: {},
      create: { announcementId: ann.id, accountId: user.id },
    });
  }

  const attachments = (Array.isArray(ann.fileIds) ? ann.fileIds : []) as {
    id: string;
    name: string;
  }[];

  return (
    <div>
      <PageHeader
        title="お知らせ詳細"
        action={
          <Link href="/announcements" className={btnOutline}>
            ← 一覧へ戻る
          </Link>
        }
      />
      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {ann.important && <Badge tone="red">重要</Badge>}
          <Badge tone={ann.audience === "primary" ? "yellow" : "blue"}>
            {AUDIENCE_LABELS[ann.audience] ?? ann.audience}
          </Badge>
          {ann.status === "stopped" && <Badge tone="gray">停止</Badge>}
          <span className="ml-auto text-xs text-slate-400">送信日時: {fmtJst(ann.sentAt)}</span>
        </div>
        <h2 className="mb-4 text-lg font-bold text-slate-800">{ann.title}</h2>
        <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">{ann.body}</p>

        {attachments.length > 0 && (
          <div className="mt-6 border-t border-slate-100 pt-4">
            <SectionTitle>添付ファイル</SectionTitle>
            <ul className="space-y-1">
              {attachments.map((f) => (
                <li key={f.id}>
                  <a
                    href={`/files/${f.id}`}
                    className="text-sm text-blue-600 hover:underline"
                  >
                    📎 {f.name}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
