"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/auth";
import { audit, canManageDocuments, storeFile } from "@/lib/util";

export type DocumentFormState = {
  error?: string;
  success?: string;
};

// ドキュメントアップロード（SNC ①②③ のみ。§7.12）
export async function uploadDocumentAction(
  _prev: DocumentFormState,
  formData: FormData
): Promise<DocumentFormState> {
  const user = await requirePage("documents");
  // §7.12「SNC（①②③）がアップロード・整理」／④ダミーは書き込み全面禁止（§3.5）
  if (user.dummy || !canManageDocuments(user.role)) {
    await audit(user.loginId, "document.upload", `role=${user.role}`, "denied");
    return { error: "ドキュメントのアップロード権限がありません" };
  }

  const title = String(formData.get("title") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const visibility = String(formData.get("visibility") ?? "");
  const file = formData.get("file");

  if (!title) return { error: "タイトルを入力してください" };
  if (!["all", "primary", "snc"].includes(visibility)) return { error: "公開範囲を選択してください" };
  if (!(file instanceof File) || file.size === 0) return { error: "ファイルを選択してください" };

  const stored = await storeFile(file, user.id);
  if ("error" in stored) return { error: stored.error };

  const doc = await prisma.document.create({
    data: {
      title,
      category: category || null,
      visibility,
      fileId: stored.id,
      fileName: stored.name,
      createdBy: user.loginId,
    },
  });
  await audit(user.loginId, "document.upload", doc.id);
  revalidatePath("/documents");
  return { success: `「${title}」を登録しました` };
}

// ドキュメント削除（SNC ①②③ のみ）
export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const user = await requirePage("documents");
  // 削除も登録と同じ主体（①②③）に限る（§7.12）。④ダミーは書き込み不可（§3.5）
  if (user.dummy || !canManageDocuments(user.role)) {
    await audit(user.loginId, "document.delete", `role=${user.role}`, "denied");
    return;
  }
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return;
  await prisma.document.delete({ where: { id } });
  // 添付実体も削除（孤児ファイル防止）
  try {
    await prisma.storedFile.delete({ where: { id: doc.fileId } });
  } catch {
    // 他レコードと共有されている場合等は無視
  }
  await audit(user.loginId, "document.delete", id);
  revalidatePath("/documents");
}
