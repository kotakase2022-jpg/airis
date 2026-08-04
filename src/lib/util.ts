import "server-only";
import { prisma } from "./prisma";
import { sendMail } from "./mail";

export function today(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // JST
}

export function nowJst(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// 年度（4月〜翌3月）を対象月から算出（§7.6）
export function fiscalYearOf(targetMonth: string): number {
  const [y, m] = targetMonth.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

export async function audit(
  actor: string,
  action: string,
  target?: string,
  result = "success",
  ip?: string
) {
  try {
    await prisma.auditLog.create({ data: { actor, action, target, result, ip } });
  } catch {
    // 監査ログ失敗は業務を止めない
  }
}

function mailBody(body?: string, link?: string): string {
  const appUrl = process.env.APP_URL ?? "";
  const lines = [body ?? "", link ? `\n詳細: ${appUrl}${link}` : "", "\n--\nAiris 販売代理店支援ポータル（自動送信）"];
  return lines.filter(Boolean).join("\n");
}

export async function notify(accountId: string, title: string, body?: string, link?: string) {
  try {
    await prisma.notification.create({ data: { accountId, title, body, link } });
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { email: true, status: true },
    });
    if (account?.status === "active" && account.email) {
      await sendMail(account.email, `【Airis】${title}`, mailBody(body, link));
    }
  } catch {}
}

export async function notifyRole(roles: string[], title: string, body?: string, link?: string) {
  const accounts = await prisma.account.findMany({
    where: { role: { in: roles }, status: "active" },
    select: { id: true, email: true },
  });
  // アプリ内通知
  try {
    await prisma.notification.createMany({
      data: accounts.map((a) => ({ accountId: a.id, title, body, link })),
    });
  } catch {}
  // メール（TODO: 大規模配信はキュー化する。速度優先ビルドでは逐次送信）
  await Promise.allSettled(
    accounts
      .filter((a) => a.email)
      .map((a) => sendMail(a.email!, `【Airis】${title}`, mailBody(body, link)))
  );
}

// 履歴イベント追記用（日付はJST基準 §2）
export function pushHistory(history: unknown, event: string, by: string): object[] {
  const arr = Array.isArray(history) ? (history as object[]) : [];
  return [...arr, { event, at: today(), by }];
}

export function formatHistory(history: unknown): string {
  if (!Array.isArray(history)) return "";
  return (history as { event: string; at: string }[])
    .map((h) => `${h.event} ${h.at}`)
    .join(" / ");
}

// ファイル保存（DB格納・上限は既定20MB。環境変数 FILE_MAX_MB で変更可 §3.8）
export async function storeFile(file: File, uploadedBy: string): Promise<{ id: string; name: string } | { error: string }> {
  const maxMb = Number(process.env.FILE_MAX_MB) > 0 ? Number(process.env.FILE_MAX_MB) : 20;
  if (file.size === 0) return { error: "ファイルが空です" };
  if (file.size > maxMb * 1024 * 1024) return { error: `ファイルは${maxMb}MB以下にしてください` };
  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await prisma.storedFile.create({
    data: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, data: buf, uploadedBy },
  });
  return { id: stored.id, name: stored.name };
}
