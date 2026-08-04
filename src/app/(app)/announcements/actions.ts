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

// 配信一覧の行内操作（送信・停止・削除）の結果状態（§3.2）。
// 権限不足・状態不整合・DB例外をユーザーへ必ず可視化するため、void ではなく状態を返す。
// ts は「同じ文面が連続したときにも state 変化を検知させる」ためのタイムスタンプ。
export type AnnouncementRowState =
  | { error?: string; success?: string; ts?: number }
  | undefined;

function rowFail(error: string): AnnouncementRowState {
  return { error, ts: Date.now() };
}

function rowOk(success: string): AnnouncementRowState {
  return { success, ts: Date.now() };
}

const ANN_STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  sent: "送信済み",
  stopped: "停止",
  deleted: "削除済",
};

function statusLabel(status: string): string {
  return ANN_STATUS_LABELS[status] ?? status;
}

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

  // DB例外（接続断・制約違反など）もユーザーへ提示する（§3.2）
  let ann;
  try {
    ann = await prisma.announcement.create({
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
  } catch {
    await audit(user.loginId, "announcement.create", title, "failure");
    return { error: "お知らせの保存に失敗しました。時間をおいて再度お試しください" };
  }

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

  try {
    await prisma.announcement.update({ where: { id }, data: { title, body, important } });
  } catch {
    await audit(user.loginId, "announcement.update", id, "failure");
    return { error: "お知らせの更新に失敗しました。時間をおいて再度お試しください" };
  }
  await audit(user.loginId, "announcement.update", id);
  revalidatePath("/announcements");
  revalidatePath(`/announcements/${id}`);
  return { success: "お知らせを更新しました" };
}

// 下書きの送信（sentAt を設定して対象ロールへ通知 §7.7）
export async function sendAnnouncementAction(
  _prev: AnnouncementRowState,
  formData: FormData
): Promise<AnnouncementRowState> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return rowFail("対象のお知らせが指定されていません");
  const ann = await prisma.announcement.findUnique({ where: { id } });
  // ④ダミー表示用データ（§3.5）は実データと分離するため操作させない
  if (!ann || ann.isDummy) return rowFail("対象のお知らせが見つかりません");
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "send")) {
    await audit(user.loginId, "announcement.send", id, "denied");
    return rowFail("お知らせの送信権限がありません");
  }
  if (ann.status !== "draft") {
    return rowFail(`下書きのお知らせのみ送信できます（現在: ${statusLabel(ann.status)}）`);
  }
  let sent;
  try {
    sent = await prisma.announcement.update({
      where: { id },
      data: { status: "sent", sentAt: new Date() },
    });
  } catch {
    await audit(user.loginId, "announcement.send", id, "failure");
    return rowFail("送信処理に失敗しました。時間をおいて再度お試しください");
  }
  await audit(user.loginId, "announcement.send", id);
  await notifyAnnouncement(sent);
  revalidatePath("/announcements");
  // 文面は作成フォームの「お知らせを送信しました」と区別する（同一文面の重複表示を避ける）
  return rowOk("下書きのお知らせを送信しました");
}

// 停止（閲覧側から非表示にする）
export async function stopAnnouncementAction(
  _prev: AnnouncementRowState,
  formData: FormData
): Promise<AnnouncementRowState> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return rowFail("対象のお知らせが指定されていません");
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.isDummy) return rowFail("対象のお知らせが見つかりません");
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "suspend")) {
    await audit(user.loginId, "announcement.stop", id, "denied");
    return rowFail("お知らせの停止権限がありません");
  }
  if (ann.status === "deleted") return rowFail("削除済のお知らせは停止できません");
  if (ann.status === "stopped") return rowFail("このお知らせはすでに停止されています");
  try {
    await prisma.announcement.update({ where: { id }, data: { status: "stopped" } });
  } catch {
    await audit(user.loginId, "announcement.stop", id, "failure");
    return rowFail("停止処理に失敗しました。時間をおいて再度お試しください");
  }
  await audit(user.loginId, "announcement.stop", id);
  revalidatePath("/announcements");
  return rowOk("お知らせを停止しました（閲覧側からは非表示になります）");
}

// 削除（論理削除）
export async function deleteAnnouncementAction(
  _prev: AnnouncementRowState,
  formData: FormData
): Promise<AnnouncementRowState> {
  const user = await requirePage("announcements");
  const id = String(formData.get("id") ?? "");
  if (!id) return rowFail("対象のお知らせが指定されていません");
  const ann = await prisma.announcement.findUnique({ where: { id } });
  if (!ann || ann.isDummy) return rowFail("対象のお知らせが見つかりません");
  if (user.dummy || !can(user.role, announcementFeature(ann.audience), "delete")) {
    await audit(user.loginId, "announcement.delete", id, "denied");
    return rowFail("お知らせの削除権限がありません");
  }
  if (ann.status === "deleted") return rowFail("このお知らせはすでに削除されています");
  try {
    await prisma.announcement.update({ where: { id }, data: { status: "deleted" } });
  } catch {
    await audit(user.loginId, "announcement.delete", id, "failure");
    return rowFail("削除処理に失敗しました。時間をおいて再度お試しください");
  }
  await audit(user.loginId, "announcement.delete", id);
  revalidatePath("/announcements");
  return rowOk("お知らせを削除しました");
}
