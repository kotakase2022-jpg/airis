import "server-only";
import nodemailer, { Transporter } from "nodemailer";

// SMTP設定（環境変数）:
//   SMTP_HOST / SMTP_PORT(既定587) / SMTP_USER / SMTP_PASS / SMTP_SECURE("true"で465系) / MAIL_FROM / APP_URL
// SMTP_HOST 未設定時は送信をスキップ（アプリ内通知のみ）。

export function mailConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!mailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  }
  return transporter;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  if (!to) return;
  const t = getTransporter();
  if (!t) {
    // SMTP未設定: 送信スキップ。開発環境ではコンソールに内容を出力する（§2: 開発=コンソール出力）
    if (process.env.NODE_ENV !== "production") {
      console.log(`[mail] (dev/console) To: ${to}\nSubject: ${subject}\n${text}`);
    }
    return;
  }
  try {
    await t.sendMail({
      from: process.env.MAIL_FROM ?? process.env.SMTP_USER,
      to,
      subject,
      text,
    });
  } catch (e) {
    // メール失敗は業務を止めない（アプリ内通知は別途記録済み）
    console.error("[mail] send failed:", (e as Error).message);
  }
}
