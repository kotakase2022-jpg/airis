"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth";
import { announcementFeature, can } from "@/lib/permissions";
import { audit, notifyRole, storeFile } from "@/lib/util";

export type AnnouncementFormState = {
  error?: string;
  success?: string;
};

// 権限判定は §5.1 の宣言的マップに集約する（§3.2）。
// お知らせ（全体向け / 1次店向け）とも 登・送・変・停・削 は①②③のみ、⑦⑧⑨は閲覧のみ。

// 対象ロールへアプリ内通知（全体向け: ⑦⑧⑨ / 1次店向け: ⑦）
async function notifyAnnouncement(ann: {
  id: string;
  audience: string;
  title: string;
  body: string;
  important: boolean;
}) {
  const targetRoles = ann.audience === "all" ? ["R7", "R8", "R9"] : ["R7"];
  await notifyRole(
    targetRoles,
    ann.important ? `【重要】お知らせ: ${ann.title}` : `お知らせ: ${ann.title}`,
    ann.body.length > 100 ? ann.body.slice(0, 100) + "…" : ann.body,
    `/announcements/${ann.id}`
  );
  // TODO: メール・Slackチャネルは通知基盤の抽象化レイヤ実装後に接続（§3.7）
}

// お知らせ作成: 「作成して送信」=即送信 / 「下書き保存」=status=draft・sentAt=null・通知なし（§7.7）
export async function createAnnouncementAction(
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const user = await requirePage("announcements");
  const audience = String(formData.get("audience") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const important = formData.get("important") === "on";
  const isDraft = String(formData.get("intent") ?? "") === "draft";

  if (audience !== "all" && audience !== "primary") return { error: "宛先を選択してください" };
  const feature = announcementFeature(audience);
  if (
    user.dummy ||
    !can(user.role, feature, "create") ||
    (!isDraft && !can(user.role, feature, "send"))
  ) {
    return { error: "お知らせの登録・送信権限がありません" };
  }
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
      status: isDraft ? "draft" : "sent",
      sentAt: isDraft ? null : new Date(),
      fileIds: attachments as never,
      createdBy: user.loginId,
    },
  });

  if (isDraft) {
    // 下書き: 通知は送らない（送信時に notifyAnnouncement を実行）
    await audit(user.loginId, "announcement.create_draft", ann.id);
    revalidatePath("/announcements");
    return { success: "お知らせを下書き保存しました" };
  }

  await audit(user.loginId, "announcement.create_send", ann.id);
  await notifyAnnouncement(ann);

  revalidatePath("/announcements");
  return { success: "お知らせを送信しました" };
}

// 編集（変更。§5.1「変」= ①②③）
// 対象は送信済み（sent）・下書き（draft）のお知らせのタイトル・本文・重要フラグ。
// 宛先（audience）は配信対象そのものが変わるため変更不可（複製作成で対応 §7.7）。添付の差し替えも対象外。
export async function updateAnnouncementAction(
  _prev: AnnouncementFormState,
  formData: FormData
): Promise<AnnouncementFormState> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "対象のお知らせが指定されていません" };
  const ann = await prisma.announcement.findUnique({ where: { id } });
  // ④ダミー表示用データ（§3.5）は実データと分離するため編集させない
  if (!ann || ann.isDummy) return { error: "対象のお知らせが見つかりません" };
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "update")) {
    return { error: "お知らせの編集権限がありません" };
  }
  if (ann.status !== "sent" && ann.status !== "draft") {
    return { error: "送信済みまたは下書きのお知らせのみ編集できます" };
  }

  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const important = formData.get("important") === "on";
  if (!title) return { error: "タイトルを入力してください" };
  if (!body) return { error: "本文を入力してください" };

  await prisma.announcement.update({ where: { id }, data: { title, body, important } });
  await audit(user.loginId, "announcement.update", id);
  revalidatePath("/announcements");
  revalidatePath(`/announcements/${id}`);
  return { success: "お知らせを更新しました" };
}

// 下書きの送信（sentAt を設定して対象ロールへ通知 §7.7）
export async function sendAnnouncementAction(formData: FormData): Promise<void> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.isDummy || ann.status !== "draft") return;
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "send")) return;
  const sent = await prisma.announcement.update({
    where: { id },
    data: { status: "sent", sentAt: new Date() },
  });
  await audit(user.loginId, "announcement.send", id);
  await notifyAnnouncement(sent);
  revalidatePath("/announcements");
}

// 停止（閲覧側から非表示にする）
export async function stopAnnouncementAction(formData: FormData): Promise<void> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.isDummy || ann.status === "deleted") return;
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "suspend")) return;
  await prisma.announcement.update({ where: { id }, data: { status: "stopped" } });
  await audit(user.loginId, "announcement.stop", id);
  revalidatePath("/announcements");
}

// 削除（論理削除）
export async function deleteAnnouncementAction(formData: FormData): Promise<void> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.isDummy) return;
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "delete")) return;
  await prisma.announcement.update({ where: { id }, data: { status: "deleted" } });
  await audit(user.loginId, "announcement.delete", id);
  revalidatePath("/announcements");
}
