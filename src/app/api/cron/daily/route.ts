import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { notify, notifyRole, audit, today } from "@/lib/util";
import { sendMail, mailConfigured } from "@/lib/mail";

// 日次バッチ（Vercel Cron から毎日実行。vercel.json 参照）
//  1) 期限切れ窓口案件の自動リマインド（SPEC §7.8 / 要件9-2 督促機能）
//  2) 削除後1年経過データの個人情報匿名化（SPEC §3.4）
//
// 認証: Authorization: Bearer ${CRON_SECRET}（Vercel Cronが自動付与）
// DB: バッチはセッションが無くRLSでfail-closedになるため、
//     オーナー接続（BYPASSRLS・非プール）の専用クライアントを使用する。

export const maxDuration = 60;

function batchClient() {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  });
}

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = batchClient();
  const summary = { overdueCases: 0, remindedAccounts: 0, anonymized: { accounts: 0, salesStaff: 0, fieldApplications: 0 } };

  try {
    // ============ 1) 期限切れ案件リマインド ============
    const overdue = await db.case.findMany({
      where: { status: { not: "完了" }, deadline: { lt: today(), not: null } },
      include: { primaryAgency: true },
      orderBy: { deadline: "asc" },
    });
    summary.overdueCases = overdue.length;

    if (overdue.length > 0) {
      // 当該1次店のR7へ案件ごとに督促（見落とし防止）
      for (const c of overdue) {
        const r7s = await db.account.findMany({
          where: { role: "R7", status: "active", agencyId: c.primaryAgencyId },
          select: { id: true },
        });
        await Promise.all(
          r7s.map((a) =>
            notify(
              a.id,
              `【督促】対応期限を過ぎた案件があります（期限: ${c.deadline}）`,
              c.title,
              "/agency-cases"
            )
          )
        );
        summary.remindedAccounts += r7s.length;
      }
      // SNC運用者(R3)へはサマリで通知（要件9-2: SNC運用者アカウントへ通知）
      const caseList = overdue.map((c) => `${c.caseNo}（期限: ${c.deadline} / ${c.primaryAgency.name}）`).join(" / ");
      await notifyRole(
        ["R3"],
        `【リマインド】期限超過の窓口案件が${overdue.length}件あります`,
        caseList,
        "/hotline"
      );
      // 指定メールアドレスへの通知（要件9-2: 指定のメールアドレスに通知。REMINDER_MAIL_TO で指定）
      if (mailConfigured() && process.env.REMINDER_MAIL_TO) {
        await sendMail(
          process.env.REMINDER_MAIL_TO,
          `【Airis】期限超過の窓口案件が${overdue.length}件あります`,
          caseList
        );
      }
    }

    // ============ 2) 個人情報の匿名化（削除後1年経過 §3.4） ============
    const cutoff = new Date(Date.now() - 365 * 24 * 3600 * 1000);

    // Airisアカウント（loginIdは監査追跡のため残す。ログインはstatus=deletedで不可）
    const accounts = await db.account.updateMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, NOT: { name: "（匿名化済み）" } },
      data: { name: "（匿名化済み）", email: null },
    });
    summary.anonymized.accounts = accounts.count;

    // 販売員（数値実績は分析用に残す）
    const staff = await db.salesStaff.updateMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, NOT: { lastName: "（匿名化済み）" } },
      data: { lastName: "（匿名化済み）", firstName: "", birthDate: "1900-01-01", phone: "", email: null },
    });
    summary.anonymized.salesStaff = staff.count;

    // 訪販員申請（業務委託先・カナ・SNCメモを消去。誓約書PDFも削除）
    const apps = await db.fieldAgentApplication.findMany({
      where: { status: "deleted", deletedAt: { lt: cutoff }, NOT: { lastNameKana: "（匿名化済み）" } },
      select: { id: true, pledgeFileId: true },
    });
    for (const a of apps) {
      if (a.pledgeFileId) {
        await db.storedFile.deleteMany({ where: { id: a.pledgeFileId } });
      }
      await db.fieldAgentApplication.update({
        where: { id: a.id },
        data: {
          lastNameKana: "（匿名化済み）",
          firstNameKana: null,
          contractorName: null,
          contractorAddress: null,
          contractorPhone: null,
          sncMemo: null,
          pledgeFileId: null,
        },
      });
    }
    summary.anonymized.fieldApplications = apps.length;

    await audit("system-cron", "daily_batch", JSON.stringify(summary));
    return Response.json({ ok: true, ...summary });
  } catch (e) {
    await audit("system-cron", "daily_batch", (e as Error).message, "failure");
    return Response.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    await db.$disconnect();
  }
}
