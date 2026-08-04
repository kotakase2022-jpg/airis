"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope, requireUser } from "@/lib/auth";
import { CASE_STATUSES, CASE_TEMPLATES, PageKey, canAccess } from "@/lib/roles";
import { can, caseFeature, type Operation } from "@/lib/permissions";
import { audit, notify, notifyRole, storeFile } from "@/lib/util";

type Series = "HL" | "CSC";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type CreateCaseState = { error?: string } | undefined;
export type ReplyState = { error?: string; ok?: boolean } | undefined;
// ステータス変更・緊急アラートの実行結果（権限不足・不正状態をユーザーへ表示するため）
export type CaseActionState = { error?: string; ok?: boolean } | undefined;

function sncPageKey(series: Series): PageKey {
  return series === "HL" ? "hotline" : "consumer-center";
}

function basePath(series: string): string {
  return series === "HL" ? "/hotline" : "/consumer-center";
}

function seriesLabel(series: string): string {
  return series === "HL" ? "ホットライン窓口" : "消費者センター窓口";
}

function revalidateCasePaths(series: string, caseId: string) {
  const base = basePath(series);
  revalidatePath(base);
  revalidatePath(`${base}/${caseId}`);
  revalidatePath("/agency-cases");
  revalidatePath(`/agency-cases/${caseId}`);
}

// SNC担当窓口ロールの権限チェック（server action側でも必ず実施）
// 操作権限は §5.1 の宣言的マップで判定する（§3.2）。
// ホットライン=①②③⑤ / 消費者センター=①②③⑥ が 作/変/停/削/閲、⑦⑩は閲覧+返信のみ。
async function requireSncCaseUser(series: Series, op: Operation): Promise<CurrentUser> {
  const user = await requireUser();
  // R4（ダミー表示）は窓口ページ自体にアクセス不可だが、防御的に拒否する
  if (user.isDummy || !canAccess(user.role, sncPageKey(series))) redirect("/dashboard");
  if (!can(user.role, caseFeature(series), op)) {
    await audit(user.loginId, `case_${op}`, `series=${series} role=${user.role}`, "denied");
    redirect("/dashboard");
  }
  return user;
}

// 当該一次代理店のR7アカウント全員へアプリ内通知
async function notifyAgencyR7(primaryAgencyId: string, title: string, body: string, link: string) {
  const accounts = await prisma.account.findMany({
    where: { role: "R7", agencyId: primaryAgencyId, status: "active" },
    select: { id: true },
  });
  // notify() はアプリ内通知＋メール（SMTP_HOST 設定時。未設定時は開発コンソール出力）を送信する（§3.7）。
  await Promise.all(accounts.map((a) => notify(a.id, title, body, link)));
  // Slack通知（SLACK_WEBHOOK_URL）は発注者確認により本フェーズ対象外（README「未実装」）。
}

// 新規起票（SNC側のみ。§7.8）
export async function createCaseAction(
  series: Series,
  _prev: CreateCaseState,
  formData: FormData
): Promise<CreateCaseState> {
  const user = await requireSncCaseUser(series, "create");

  const templateKind = String(formData.get("templateKind") ?? "");
  const primaryAgencyId = String(formData.get("primaryAgencyId") ?? "");
  const secondaryAgencyId = String(formData.get("secondaryAgencyId") ?? "");
  const ispNumber = String(formData.get("ispNumber") ?? "").trim();
  const deadline = String(formData.get("deadline") ?? "").trim() || null;
  const body = String(formData.get("body") ?? "").trim();
  let title = String(formData.get("title") ?? "").trim();

  if (!(CASE_TEMPLATES as readonly string[]).includes(templateKind)) {
    return { error: "依頼テンプレを選択してください。" };
  }
  if (!primaryAgencyId) return { error: "一次代理店を選択してください。" };
  if (!body) return { error: "本文を入力してください。" };

  const primary = await prisma.agency.findUnique({ where: { id: primaryAgencyId } });
  if (!primary || primary.tier !== 1 || primary.isDummy) {
    return { error: "一次代理店の指定が不正です。" };
  }
  let secondary = null;
  if (secondaryAgencyId) {
    secondary = await prisma.agency.findUnique({ where: { id: secondaryAgencyId } });
    if (!secondary || secondary.tier !== 2 || secondary.parentId !== primary.id) {
      return { error: "二次代理店の指定が不正です。" };
    }
  }

  // 件名の自動生成: テンプレ名称／代理店名称／ISP受付番号（【】等の接頭辞は付けない §7.8）
  if (!title) title = `${templateKind}／${primary.name}／${ispNumber}`;

  const caseNo = `${series === "HL" ? "HLC" : "CSC"}-${Date.now()}`;
  const created = await prisma.case.create({
    data: {
      series,
      caseNo,
      templateKind,
      title,
      primaryAgencyId: primary.id,
      secondaryAgencyId: secondary?.id ?? null,
      ispNumber: ispNumber || null,
      deadline,
      status: CASE_STATUSES[0], // 未対応
      createdBy: user.name,
      messages: { create: { senderSide: "snc", senderName: user.name, body } },
    },
  });

  // 起票時: 当該一次代理店のR7アカウント全員へ通知（要件9-2①）
  await notifyAgencyR7(
    primary.id,
    `${seriesLabel(series)}から新規依頼が届きました`,
    `${created.caseNo}: ${created.title}`,
    `/agency-cases/${created.id}`
  );

  await audit(user.loginId, "case_create", created.caseNo);
  revalidateCasePaths(series, created.id);
  redirect(`${basePath(series)}/${created.id}`);
}

// 返信（SNC側=添付可 / 代理店側=返信のみ・添付不可 §14-3）
export async function replyCaseAction(
  caseId: string,
  _prev: ReplyState,
  formData: FormData
): Promise<ReplyState> {
  const user = await requireUser();
  if (user.isDummy) return { error: "この操作は許可されていません。" };

  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return { error: "案件が見つかりません。" };
  const series = c.series as Series;

  // 返信権限（§5.1「返信」= send）: ①②③＋担当窓口⑤⑥、代理店側は⑦⑩のみ
  if (!can(user.role, caseFeature(series), "send")) {
    return { error: "この案件への返信権限がありません。" };
  }
  const isAgencySide = user.role === "R7" || user.role === "R10";
  if (isAgencySide) {
    if (!canAccess(user.role, "agency-cases")) return { error: "この案件への返信権限がありません。" };
    // 自店案件のみ返信可（§3.1 スコープ検証）
    const scope = await agencyScope(user);
    if (!scope || !scope.includes(c.primaryAgencyId)) {
      return { error: "この案件への返信権限がありません。" };
    }
  } else if (!canAccess(user.role, sncPageKey(series))) {
    return { error: "この案件への返信権限がありません。" };
  }

  const body = String(formData.get("body") ?? "").trim();
  if (!body) return { error: "本文を入力してください。" };

  // 添付ファイルはSNC側のみ許可（代理店側のフォームには添付UI自体が無いが、サーバ側でも拒否する）
  const attachments: { id: string; name: string }[] = [];
  if (!isAgencySide) {
    const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    for (const f of files) {
      const stored = await storeFile(f, user.loginId);
      if ("error" in stored) return { error: stored.error };
      attachments.push(stored);
    }
  }

  await prisma.caseMessage.create({
    data: {
      caseId: c.id,
      senderSide: isAgencySide ? "agency" : "snc",
      senderName: user.name,
      body,
      fileIds: attachments as never,
    },
  });
  // 一覧の「更新:」表示のため案件のupdatedAtを更新
  await prisma.case.update({ where: { id: c.id }, data: { updatedAt: new Date() } });

  if (isAgencySide) {
    // 代理店返信時: 担当窓口ロール（HL→R5 / CSC→R6）と R3 へ通知
    const counterRole = series === "HL" ? "R5" : "R6";
    await notifyRole(
      [counterRole, "R3"],
      `代理店から返信がありました（${c.caseNo}）`,
      c.title,
      `${basePath(series)}/${c.id}`
    );
  } else {
    // SNC返信時: 当該一次代理店のR7へ通知（ラリー中の見逃し防止 要件9-2②）
    await notifyAgencyR7(
      c.primaryAgencyId,
      `${seriesLabel(series)}から返信がありました（${c.caseNo}）`,
      c.title,
      `/agency-cases/${c.id}`
    );
  }

  await audit(user.loginId, "case_reply", c.caseNo);
  revalidateCasePaths(series, c.id);
  return { ok: true };
}

// 案件の編集（変更。§5.1「変」= ①②③ + 担当窓口⑤⑥。代理店⑦⑩は返信のみで変更不可）
// 対象は件名と対応期限（§7.8 の起票フォーム項目のうち後から修正が必要になるもの）。
// 変更前後の値は監査ログに残す（§3.3。Case には変更履歴テーブルが無いため）。
export async function updateCaseAction(caseId: string, formData: FormData): Promise<void> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return;
  const series = c.series as Series;
  const user = await requireSncCaseUser(series, "update");

  const title = String(formData.get("title") ?? "").trim();
  const deadlineRaw = String(formData.get("deadline") ?? "").trim();
  if (!title) {
    await audit(user.loginId, "case_update", `${c.caseNo}: 件名が未入力`, "failure");
    return;
  }
  if (deadlineRaw && !DATE_RE.test(deadlineRaw)) {
    await audit(user.loginId, "case_update", `${c.caseNo}: 対応期限の形式が不正`, "failure");
    return;
  }
  const deadline = deadlineRaw || null;
  if (title === c.title && deadline === c.deadline) return; // 変更なし

  await prisma.case.update({ where: { id: c.id }, data: { title, deadline } });
  await audit(
    user.loginId,
    "case_update",
    `${c.caseNo}: 件名「${c.title}」→「${title}」/ 対応期限 ${c.deadline ?? "-"} → ${deadline ?? "-"}`
  );
  revalidateCasePaths(series, c.id);
}

// ステータス変更・緊急アラート用の権限判定。
// requireSncCaseUser() と同じ判定を行うが、結果（error）を呼び出し元へ返すためリダイレクトしない。
// 拒否は監査ログに記録する（§3.3）。
async function sncCaseOperator(
  series: Series,
  op: Operation,
  action: string,
  caseNo: string
): Promise<{ user: CurrentUser } | { error: string }> {
  const user = await requireUser();
  if (
    user.isDummy ||
    !canAccess(user.role, sncPageKey(series)) ||
    !can(user.role, caseFeature(series), op)
  ) {
    await audit(user.loginId, action, `${caseNo} role=${user.role}`, "denied");
    return { error: "この操作を行う権限がありません。" };
  }
  return { user };
}

// ステータス変更（SNC側のみ。CaseStatusHistoryに記録 §7.8 / 要件9-4）
async function changeStatus(caseId: string, formData: FormData): Promise<CaseActionState> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return { error: "案件が見つかりません。" };
  const series = c.series as Series;
  const auth = await sncCaseOperator(series, "update", "case_status_change", c.caseNo);
  if ("error" in auth) return auth;
  const user = auth.user;

  const toStatus = String(formData.get("status") ?? "");
  if (!(CASE_STATUSES as readonly string[]).includes(toStatus)) {
    return { error: "ステータスの指定が不正です。" };
  }
  if (toStatus === c.status) return { error: `すでに「${c.status}」のため変更はありません。` };

  // RLS拡張（クエリ毎にset_configトランザクションで包む）と干渉するため逐次実行（速度優先）
  await prisma.case.update({ where: { id: c.id }, data: { status: toStatus } });
  await prisma.caseStatusHistory.create({
    data: { caseId: c.id, fromStatus: c.status, toStatus, changedBy: user.name },
  });

  await audit(user.loginId, "case_status_change", `${c.caseNo}: ${c.status} → ${toStatus}`);
  revalidateCasePaths(series, c.id);
  return { ok: true };
}

// 緊急アラート（R3全員 + 当該一次店R7全員へ通知。要件9-2③）
// §5.1 の操作列に無い通知機能。担当窓口（SNC側の窓口ページにアクセスできるロール）のみ実施できる。
async function urgentAlert(caseId: string): Promise<CaseActionState> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return { error: "案件が見つかりません。" };
  const series = c.series as Series;
  const auth = await sncCaseOperator(series, "view", "case_urgent_alert", c.caseNo);
  if ("error" in auth) return auth;
  const user = auth.user;

  const title = `【緊急アラート】${c.caseNo} の対応をお願いします`;
  // notifyRole() / notify() はアプリ内通知＋メールの2チャネルを送信する（§3.7 / lib/util.ts）。
  // Slack通知は発注者確認により本フェーズ対象外（README「未実装」/ SPEC §2）。
  await notifyRole(["R3"], title, c.title, `${basePath(series)}/${c.id}`);
  await notifyAgencyR7(c.primaryAgencyId, title, c.title, `/agency-cases/${c.id}`);

  await audit(user.loginId, "case_urgent_alert", c.caseNo);
  revalidateCasePaths(series, c.id);
  return { ok: true };
}

// --- server action エントリポイント -----------------------------------------
// 状態を返す版（useActionState 用）。権限不足・不正状態をフォーム上でメッセージ表示できる。
export async function changeStatusStateAction(
  caseId: string,
  _prev: CaseActionState,
  formData: FormData
): Promise<CaseActionState> {
  return changeStatus(caseId, formData);
}

export async function urgentAlertStateAction(
  caseId: string,
  _prev: CaseActionState
): Promise<CaseActionState> {
  void _prev; // useActionState のシグネチャ（prevState を第1引数で受ける）に合わせるための未使用引数
  return urgentAlert(caseId);
}

// void を前提とした <form action={...}> 互換版（現行の snc-case-detail.tsx が使用）。
// 呼び出し側を useActionState 化するまでメッセージは表示されないため、
// 拒否・失敗は監査ログ（result=denied）に残して追跡可能にする。
export async function changeStatusAction(caseId: string, formData: FormData): Promise<void> {
  await changeStatus(caseId, formData);
}

export async function urgentAlertAction(caseId: string): Promise<void> {
  await urgentAlert(caseId);
}
