import "server-only";
import { prisma } from "./prisma";

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

export async function audit(actor: string, action: string, target?: string, result = "success") {
  try {
    await prisma.auditLog.create({ data: { actor, action, target, result } });
  } catch {
    // 監査ログ失敗は業務を止めない
  }
}

export async function notify(accountId: string, title: string, body?: string, link?: string) {
  try {
    await prisma.notification.create({ data: { accountId, title, body, link } });
  } catch {}
}

export async function notifyRole(roles: string[], title: string, body?: string, link?: string) {
  const accounts = await prisma.account.findMany({
    where: { role: { in: roles }, status: "active" },
    select: { id: true },
  });
  await Promise.all(accounts.map((a) => notify(a.id, title, body, link)));
}

// 履歴イベント追記用
export function pushHistory(history: unknown, event: string, by: string): object[] {
  const arr = Array.isArray(history) ? (history as object[]) : [];
  return [...arr, { event, at: new Date().toISOString().slice(0, 10), by }];
}

export function formatHistory(history: unknown): string {
  if (!Array.isArray(history)) return "";
  return (history as { event: string; at: string }[])
    .map((h) => `${h.event} ${h.at}`)
    .join(" / ");
}

// ファイル保存（DB格納・上限4MB）
export async function storeFile(file: File, uploadedBy: string): Promise<{ id: string; name: string } | { error: string }> {
  if (file.size === 0) return { error: "ファイルが空です" };
  if (file.size > 4 * 1024 * 1024) return { error: "ファイルは4MB以下にしてください" };
  const buf = Buffer.from(await file.arrayBuffer());
  const stored = await prisma.storedFile.create({
    data: { name: file.name, mime: file.type || "application/octet-stream", size: file.size, data: buf, uploadedBy },
  });
  return { id: stored.id, name: stored.name };
}
