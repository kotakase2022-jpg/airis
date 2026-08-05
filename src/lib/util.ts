import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { basePrisma } from "./prisma-base";
import { resolveSession, type RlsContext } from "./session";
import { mailConfigured, sendMail } from "./mail";
import { canAccess, type Role } from "./roles";
import { can, isDummyFeature, type FeatureKey } from "./permissions";
import { alertForAuditEvent } from "./alert";

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

// 監査ログの構造化ログ（JSON）出力（§10.4 SEC-030）。
// 収集基盤（SIEM）へはインフラ側で標準出力を転送する前提なので、1イベント=1行のJSONで出す。
// 項目は audit_logs に保存する内容と同一（追加の個人情報は載せない §10.3）。
// target は標準出力の肥大化を防ぐため切り詰める（全文はDBに残る）。
const MAX_LOG_TARGET_LEN = 1000;

type AuditLogRecord = {
  type: "audit";
  ts: string;
  actor: string;
  action: string;
  target?: string;
  result: string;
  ip?: string;
  env?: string;
  app: "airis";
};

export function auditLogRecord(
  actor: string,
  action: string,
  target: string | undefined,
  result: string,
  ip: string | undefined,
  ts: string
): AuditLogRecord {
  return {
    type: "audit",
    ts,
    actor,
    action,
    target:
      target && target.length > MAX_LOG_TARGET_LEN
        ? `${target.slice(0, MAX_LOG_TARGET_LEN)}…`
        : target,
    result,
    ip,
    env: process.env.NODE_ENV,
    app: "airis",
  };
}

// 監査ログ記録（§3.3）。DB記録＋構造化ログ出力（§10.4 SEC-030）＋アラート判定（§10.4 SEC-032）。
// シグネチャは変更しない（呼び出し箇所が多数あるため後方互換必須）。
export async function audit(
  actor: string,
  action: string,
  target?: string,
  result = "success",
  ip?: string
) {
  const ts = new Date().toISOString();
  // DB書き込みが失敗しても痕跡が残るよう、構造化ログを先に出す（§10.4）
  try {
    console.log(JSON.stringify(auditLogRecord(actor, action, target, result, ip, ts)));
  } catch {
    // ログ整形の失敗は業務を止めない
  }
  try {
    await prisma.auditLog.create({ data: { actor, action, target, result, ip } });
  } catch {
    // 監査ログ失敗は業務を止めない
  }
  // 認証失敗急増・特権操作・エクスポート操作のアラート（§10.4）。
  // 判定を audit() 側に寄せることで呼び出し側の改修を不要にしている（src/lib/alert.ts）。
  await alertForAuditEvent({ actor, action, target, result, ip });
}

function mailBody(body?: string, link?: string): string {
  const appUrl = process.env.APP_URL ?? "";
  const lines = [
    body ?? "",
    link ? `\n詳細: ${appUrl}${link}` : "",
    "\n--\nAiris 販売代理店支援ポータル（自動送信）",
  ];
  return lines.filter(Boolean).join("\n");
}

// ===== 通知チャネル（§3.7 / §8 Notification.channel） =====
// §8 の `channel` 列は「どのチャネルで配信したか」を表す。
// アプリ内通知（ベルアイコン・/notifications）は Notification に channel="inapp" で1件だけ残す。
// メール配信は Notification に別レコード（channel="mail"）を作ると
// ヘッダのベル未読件数・/notifications 一覧が二重計上されてしまうため、
// **配信記録は監査ログ（§3.3）に channel=mail として残す**方式を採る。
// Slack配信（窓口機能 §7.8）も同様にチャネル別の配信記録が必要になった場合はここに集約する。
export const INAPP_CHANNEL = "inapp";

// メール配信の記録（§3.3 / §8）。SMTP未設定時は送信スキップなので result="skipped"（§14-8）。
async function auditMailChannel(recipients: string[], title: string) {
  if (recipients.length === 0) return;
  const to = recipients.length === 1 ? recipients[0] : `${recipients.length}件`;
  await audit(
    "system",
    "notify_mail",
    `channel=mail to=${to} title=${title}`,
    mailConfigured() ? "success" : "skipped"
  );
}

export async function notify(accountId: string, title: string, body?: string, link?: string) {
  try {
    // アプリ内通知は channel="inapp" を明示して記録する（§8）
    await prisma.notification.create({
      data: { accountId, title, body, link, channel: INAPP_CHANNEL },
    });
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: { loginId: true, email: true, status: true },
    });
    if (account?.status === "active" && account.email) {
      await sendMail(account.email, `【Airis】${title}`, mailBody(body, link));
      // メールアドレスそのものはログに残さない（§10.3 個人情報）。宛先はログインIDで記録する。
      await auditMailChannel([account.loginId], title);
    }
  } catch {}
}

export async function notifyRole(roles: string[], title: string, body?: string, link?: string) {
  const accounts = await prisma.account.findMany({
    where: { role: { in: roles }, status: "active" },
    select: { id: true, loginId: true, email: true },
  });
  // アプリ内通知（channel="inapp" §8）
  try {
    await prisma.notification.createMany({
      data: accounts.map((a) => ({
        accountId: a.id,
        title,
        body,
        link,
        channel: INAPP_CHANNEL,
      })),
    });
  } catch {}
  // メール（TODO: 大規模配信はキュー化する。速度優先ビルドでは逐次送信）
  const mailTargets = accounts.filter((a) => a.email);
  await Promise.allSettled(
    mailTargets.map((a) => sendMail(a.email!, `【Airis】${title}`, mailBody(body, link)))
  );
  await auditMailChannel(
    mailTargets.map((a) => a.loginId),
    title
  );
}

// ===== 真のトランザクション（§3.6 全件ロールバック / §3.1 RLS との併用） =====
// `prisma`（src/lib/prisma.ts）のRLS拡張は「set_config + クエリ本体」をクエリ1件ごとの
// バッチトランザクションで包む実装なので、複数テーブルへの書き込みを1トランザクションに
// まとめられない（各クエリが独立コミットされる）。
// そこで RLS 拡張を通さない basePrisma で interactive transaction を張り、その内側で
// set_config を **同一トランザクション内に** 明示実行して §3.1 のスコープを Postgres 側へ渡す。
// rls は resolveSession() が算出した RlsContext（currentRls() で取得できる）。
// rls=null（セッション外）は bypass=off / scope="" となり、保護テーブルは既定拒否（fail-closed）。
export async function withScopedTransaction<T>(
  rls: RlsContext | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return basePrisma.$transaction(async (tx) => {
    if (rls?.bypass) {
      await tx.$executeRaw`SELECT set_config('app.bypass', 'on', TRUE)`;
    } else {
      const scope = rls?.scope.join(",") ?? "";
      await tx.$executeRaw`SELECT set_config('app.bypass', 'off', TRUE), set_config('app.scope', ${scope}, TRUE)`;
    }
    return fn(tx);
  });
}

/** 現在のセッションのRLSコンテキスト（§3.1）。セッション外（バッチ等）は null。 */
export async function currentRls(): Promise<RlsContext | null> {
  const session = await resolveSession().catch(() => null);
  return session?.rls ?? null;
}

// ===== §5.1 / §5.2 由来の権限判定ヘルパ（§3.2 宣言的マップの共有） =====
// ハードコードしたロール配列を画面・APIに散らさないため、permissions.ts / roles.ts の
// 宣言的マップから導出する判定をここに集約する（根拠となる仕様節をコメントで明記する）。

/**
 * 「自店スコープでの参照」を含む閲覧可否（§5.1 + §5.1 補足 + §3.5）。
 * §5.1 の原表は⑧に「申」しか与えていないが、§5.1 補足のとおり **自店スコープの閲覧は
 * 機能上不可欠**（提出状況・申請状況の確認）なので、申請・提出権限を閲覧権に内含させる。
 * 実際に見える範囲は agencyScope()（§3.1）とRLS（prisma/rls.sql）で自店に限定される。
 * ④は §5.1 で「ダミー」の機能に限りダミーデータのみを参照できる（§3.5）。
 */
export function canViewFeatureInScope(role: Role, feature: FeatureKey): boolean {
  return (
    isDummyFeature(role, feature) ||
    can(role, feature, "view") ||
    can(role, feature, "apply") ||
    can(role, feature, "submit")
  );
}

/**
 * ドキュメントの登録・削除権限（§7.12「SNC（①②③）がアップロード・整理し、閲覧範囲を文書ごとに設定」）。
 * §5.1 の表に「ドキュメント」行は無いため、
 *  - ページアクセス可否は §5.2 の宣言（canAccess）
 *  - 登録・削除の主体は §5.1「お知らせ（全体向け）」の登録権（登=①②③）と同一範囲
 * として導出する（どちらも「SNCが文書・情報を登録し代理店へ周知する」同種の操作）。
 */
export function canManageDocuments(role: Role): boolean {
  return canAccess(role, "documents") && can(role, "announcement-all", "create");
}

/**
 * 代理店所属が必須のロール（§4 のID体系: ⑦⑧⑩は代理店コードをアカウントIDに含む）。
 * 権限判定ではなく「所属と役割の整合」チェックに使う（申請フォーム §6.1 / 権限変更 要件1-1）。
 */
export function requiresAgency(role: Role): boolean {
  return role === "R7" || role === "R8" || role === "R10";
}

// 履歴イベント追記用（日付はJST基準 §2）
export function pushHistory(history: unknown, event: string, by: string): object[] {
  const arr = Array.isArray(history) ? (history as object[]) : [];
  return [...arr, { event, at: today(), by }];
}

export function formatHistory(history: unknown): string {
  if (!Array.isArray(history)) return "";
  return (history as { event: string; at: string }[]).map((h) => `${h.event} ${h.at}`).join(" / ");
}

// アップロード許可拡張子・MIMEホワイトリスト（§3.8）
// 検収指摘（問題一覧No.13）: 実運用の周知資料・上長承認証跡に合わせ、Office文書と
// Outlookメール(.msg)を追加（2026-08-05）。形式の増減は発注者確認のうえhere一箇所で行う。
const ALLOWED_EXT: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  msg: "application/vnd.ms-outlook",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  zip: "application/zip",
  csv: "text/csv",
  txt: "text/plain",
};

function safeName(name: string): string {
  // パス要素・制御文字を除去（ディレクトリトラバーサル防止）
  return name
    .replace(/[\\/\x00-\x1f]/g, "_")
    .replace(/\.\.+/g, ".")
    .slice(0, 255);
}

// 配信時に信頼できる MIME を拡張子から決定（クライアント申告値を信用しない）
export function safeMimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ALLOWED_EXT[ext] ?? "application/octet-stream";
}

// ファイル保存（DB格納・上限は既定20MB。環境変数 FILE_MAX_MB で変更可 §3.8）
// 拡張子＋ファイル名をホワイトリスト方式で検証・サニタイズする。
export async function storeFile(
  file: File,
  uploadedBy: string
): Promise<{ id: string; name: string } | { error: string }> {
  const maxMb = Number(process.env.FILE_MAX_MB) > 0 ? Number(process.env.FILE_MAX_MB) : 20;
  if (file.size === 0) return { error: "ファイルが空です" };
  if (file.size > maxMb * 1024 * 1024) return { error: `ファイルは${maxMb}MB以下にしてください` };
  const name = safeName(file.name);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXT[ext]) {
    return {
      error: `この形式のファイルは受け付けられません（許可: ${Object.keys(ALLOWED_EXT).join(", ")}）`,
    };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  // 保存MIMEは拡張子から決定（クライアント申告のtext/html等を保存しない）
  const stored = await prisma.storedFile.create({
    data: { name, mime: safeMimeFor(name), size: file.size, data: buf, uploadedBy },
  });
  return { id: stored.id, name: stored.name };
}
