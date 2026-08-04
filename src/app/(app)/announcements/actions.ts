"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth";
import { SNC_ADMIN_ROLES } from "@/lib/roles";
import { audit, notifyRole, storeFile } from "@/lib/util";

export type AnnouncementFormState = {
  error?: string;
  success?: string;
};

// お知らせ作成=即送信（§7.7。下書き運用は行わない割り切り — TODO: 必要なら下書き対応）
export async function createAnnouncementAction(
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const user = await requirePage("announcements");
  if (user.dummy || !SNC_ADMIN_ROLES.includes(user.role)) {
    return { error: "お知らせの登録・送信権限がありません" };
  }

  const audience = String(formData.get("audience") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const important = formData.get("important") === "on";

  if (audience !== "all" && audience !== "primary") return { error: "宛先を選択してください" };
  if (!title) return { error: "タイトルを入力してください" };
  if (!body) return { error: "本文を入力してください" };

  // 添付ファイル（複数可）
  const attachments: { id: string; name: string }[] = [];
  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);
  for (const f of files) {
    const stored = await storeFile(f, user.id);
    if ("error" in stored) return { error: `添付ファイル「${f.name}」: ${stored.error}` };
    attachments.push(stored);
  }

  const ann = await prisma.announcement.create({
    data: {
      audience,
      title,
      body,
      important,
      status: "sent",
      sentAt: new Date(),
      fileIds: attachments as never,
      createdBy: user.loginId,
    },
  });

  await audit(user.loginId, "announcement.create_send", ann.id);

  // 対象ロールへアプリ内通知（全体向け: ⑦⑧⑨ / 1次店向け: ⑦）
  const targetRoles = audience === "all" ? ["R7", "R8", "R9"] : ["R7"];
  await notifyRole(
    targetRoles,
    important ? `【重要】お知らせ: ${title}` : `お知らせ: ${title}`,
    body.length > 100 ? body.slice(0, 100) + "…" : body,
    `/announcements/${ann.id}`
  );
  // TODO: メール・Slackチャネルは通知基盤の抽象化レイヤ実装後に接続（§3.7）

  revalidatePath("/announcements");
  return { success: "お知らせを送信しました" };
}

// 停止（閲覧側から非表示にする）
export async function stopAnnouncementAction(formData: FormData): Promise<void> {
  const user = await requirePage("announcements");
  if (user.dummy || !SNC_ADMIN_ROLES.includes(user.role)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.status === "deleted") return;
  await prisma.announcement.update({ where: { id }, data: { status: "stopped" } });
  await audit(user.loginId, "announcement.stop", id);
  revalidatePath("/announcements");
}

// 削除（論理削除）
export async function deleteAnnouncementAction(formData: FormData): Promise<void> {
  const user = await requirePage("announcements");
  if (user.dummy || !SNC_ADMIN_ROLES.includes(user.role)) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann) return;
  await prisma.announcement.update({ where: { id }, data: { status: "deleted" } });
  await audit(user.loginId, "announcement.delete", id);
  revalidatePath("/announcements");
}
