import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { canAccessFile } from "@/lib/file-access";
import { audit, safeMimeFor } from "@/lib/util";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  // 初回パスワード変更が未完了のうちは他機能を使わせない（§10.1）
  if (user.mustChangePassword) {
    return new Response("Password change required", { status: 403 });
  }

  const { id } = await params;
  const file = await prisma.storedFile.findUnique({ where: { id } });
  if (!file) return new Response("Not found", { status: 404 });

  // 参照元エンティティのスコープ・公開範囲で認可（§3.1 / §10.5 IDOR防止）
  if (!(await canAccessFile(user, id))) {
    await audit(user.loginId, "file_download", `${id}`, "denied");
    return new Response("Forbidden", { status: 403 });
  }

  // ファイルダウンロードの監査（§3.3）
  await audit(user.loginId, "file_download", `${file.name} (${id})`);

  return new Response(new Uint8Array(file.data), {
    headers: {
      // MIMEは拡張子から決定（保存値も検証済みだが二重に担保）
      "Content-Type": safeMimeFor(file.name),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
