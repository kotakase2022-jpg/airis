"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { CurrentUser, agencyScope, requireUser } from "@/lib/auth";
import { CASE_TEMPLATES, PageKey, Role, SNC_ROLES, canAccess } from "@/lib/roles";
import { can, caseFeature, type Operation } from "@/lib/permissions";
import { audit, notify, notifyRole, storeFile } from "@/lib/util";
// ステータスはマスタ化（StatusMaster）してあり、値の増減はDBで行う（§7.8）。
// server action 側のバリデーションもマスタ値で行う（UI層のセレクトだけに頼らない）。
import {
  caseStatusValues,
  defaultCaseStatus,
  isCaseStatus,
  recordStatusHistory,
  type StatusEvent,
} from "@/lib/status";

type Series = "HL" | "CSC";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 窓口案件の「停」「削」用ステータス（§5.1 停=suspend / 削=delete）。
// スキーマ（Case.status）は自由文字列で、ステータスマスタ（StatusMaster kind="case" /
// 既定値は roles.ts の CASE_STATUSES = 未対応〜完了）は「案件の対応状況」の定義なので拡張せず、
// 停止・論理削除はこの2値で表現する（§3.4 論理削除）。
// ※ 同じ2値を snc-case-list.tsx / snc-case-detail.tsx でも定義している（"use server" ファイルは
//    async 関数以外を export できないため。値を変える場合は3ファイルを同時に更新すること）
const CASE_SUSPENDED = "停止";
const CASE_DELETED = "削除済";

// 停止・削除済の案件は「対応中の案件」ではないため、返信・編集・ステータス変更を受け付けない
function isInactive(status: string): boolean {
  return status === CASE_SUSPENDED || status === CASE_DELETED;
}

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

  // 販売員ID紐付け（任意。検収指摘 問題一覧No.14: ID単位の品質管理・集計用）。
  // 対象一次代理店（またはその配下2次店）に属する販売員のみ許可する
  const salesStaffIdInput = String(formData.get("salesStaffId") ?? "").trim();
  let salesStaffId: string | null = null;
  if (salesStaffIdInput) {
    const staff = await prisma.salesStaff.findUnique({
      where: { id: salesStaffIdInput },
      include: { agency: true },
    });
    if (!staff || staff.agency.isDummy) return { error: "販売員IDの指定が不正です。" };
    const inScope =
      staff.agencyId === primary.id ||
      staff.agency.parentId === primary.id ||
      (secondary ? staff.agencyId === secondary.id : false);
    if (!inScope) return { error: "指定した販売員は対象代理店に所属していません。" };
    salesStaffId = staff.id;
  }

  // 起票時の添付（SNC側は添付可 §14-3 / 検収指摘 問題一覧No.23）
  const attachments: { id: string; name: string }[] = [];
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  for (const f of files) {
    const stored = await storeFile(f, user.loginId);
    if ("error" in stored) return { error: stored.error };
    attachments.push({ id: stored.id, name: stored.name });
  }

  // 件名の自動生成: テンプレ名称／代理店名称／ISP受付番号（【】等の接頭辞は付けない §7.8）
  if (!title) title = `${templateKind}／${primary.name}／${ispNumber}`;

  const caseNo = `${series === "HL" ? "HLC" : "CSC"}-${Date.now()}`;
  // 起票時のステータスはマスタの先頭（既定では「未対応」）。マスタで並び順を変えれば追従する（§7.8）
  const initialStatus = await defaultCaseStatus();
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
      status: initialStatus,
      salesStaffId,
      createdBy: user.name,
      messages: {
        create: {
          senderSide: "snc",
          senderName: user.name,
          body,
          ...(attachments.length ? { fileIds: attachments as never } : {}),
        },
      },
    },
  });

  // 状態遷移履歴（§4.1 requested = 起票・申請）
  await recordStatusHistory({
    entityType: "case",
    entityId: created.id,
    event: "requested",
    fromStatus: null,
    toStatus: created.status,
    changedBy: user.loginId,
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
  // 停止・削除済の案件はやりとりを終了しているため返信できない（§5.1 停/削）
  if (isInactive(c.status)) {
    await audit(user.loginId, "case_reply", `${c.caseNo} status=${c.status}`, "denied");
    return { error: `この案件は「${c.status}」のため返信できません。` };
  }
  const isAgencySide = user.role === "R7" || user.role === "R10";
  if (isAgencySide) {
    if (!canAccess(user.role, "agency-cases"))
      return { error: "この案件への返信権限がありません。" };
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
    const files = formData
      .getAll("files")
      .filter((f): f is File => f instanceof File && f.size > 0);
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
  // 停止・削除済の案件は復旧してからでないと編集できない（§3.4 論理削除の一貫性）
  if (isInactive(c.status)) {
    await audit(user.loginId, "case_update", `${c.caseNo}: status=${c.status}`, "denied");
    return;
  }

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
  if (isInactive(c.status)) {
    await audit(user.loginId, "case_status_change", `${c.caseNo}: status=${c.status}`, "denied");
    return { error: `この案件は「${c.status}」です。復旧してからステータスを変更してください。` };
  }

  const toStatus = String(formData.get("status") ?? "");
  // マスタ（StatusMaster kind="case"）に存在する値のみ受け付ける。
  // マスタで値を増やせば、コード変更なしにこのバリデーションも追従する（§7.8）。
  if (!(await isCaseStatus(toStatus))) {
    return { error: "ステータスの指定が不正です。" };
  }
  if (toStatus === c.status) return { error: `すでに「${c.status}」のため変更はありません。` };

  // RLS拡張（クエリ毎にset_configトランザクションで包む）と干渉するため逐次実行（速度優先）
  await prisma.case.update({ where: { id: c.id }, data: { status: toStatus } });
  await prisma.caseStatusHistory.create({
    data: { caseId: c.id, fromStatus: c.status, toStatus, changedBy: user.name },
  });
  // 状態遷移履歴（§4.1）。ステータス変更は §5.1 凡例の「変」= update イベントとして記録する。
  await recordStatusHistory({
    entityType: "case",
    entityId: c.id,
    event: "update",
    fromStatus: c.status,
    toStatus,
    changedBy: user.loginId,
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

// ---------------------------------------------------------------------------
// 停止（§5.1「停」）/ 削除（§5.1「削」）/ 復旧
// 権限は can(role, caseFeature(series), 'suspend'|'delete') = ①②③ + 担当窓口（HL=⑤ / 消セン=⑥）。
// 代理店（⑦⑩）は返信のみのため実施できない。
// Case には status 以外の停止・削除フラグが無いため、status="停止" / "削除済" による論理削除とし、
// 遷移は CaseStatusHistory に記録して案件画面から追跡できるようにする（§3.4 / 要件9-4）。
// ---------------------------------------------------------------------------

async function changeCaseState(
  caseId: string,
  op: Operation,
  toStatus: string,
  action: string,
  event: StatusEvent
): Promise<CaseActionState> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return { error: "案件が見つかりません。" };
  const series = c.series as Series;
  const auth = await sncCaseOperator(series, op, action, c.caseNo);
  if ("error" in auth) return auth;
  const user = auth.user;
  if (c.status === toStatus) return { error: `すでに「${toStatus}」です。` };

  // RLS拡張と干渉するためトランザクションを使わず逐次実行（他のステータス変更と同方針）
  await prisma.case.update({ where: { id: c.id }, data: { status: toStatus } });
  await prisma.caseStatusHistory.create({
    data: { caseId: c.id, fromStatus: c.status, toStatus, changedBy: user.name },
  });
  // 状態遷移履歴（§4.1 suspend / delete）
  await recordStatusHistory({
    entityType: "case",
    entityId: c.id,
    event,
    fromStatus: c.status,
    toStatus,
    changedBy: user.loginId,
  });
  await audit(user.loginId, action, `${c.caseNo}: ${c.status} → ${toStatus}`);
  revalidateCasePaths(series, c.id);
  return { ok: true };
}

// 停止（①②③＋担当窓口）: 代理店側の一覧・詳細からは除外される
// 担当者アサイン（検収指摘 問題一覧No.23）。SNC窓口側の「変」権限で担当者を設定・解除する。
// 担当者はSNC系ロール（①②③⑤⑥）のactiveアカウントのみ許可。
export async function assignCaseAction(caseId: string, formData: FormData): Promise<void> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c) return;
  const series = c.series as Series;
  const user = await requireSncCaseUser(series, "update");
  const assigneeId = String(formData.get("assigneeAccountId") ?? "").trim();
  let assigneeLabel = "（解除）";
  if (assigneeId) {
    const assignee = await prisma.account.findUnique({ where: { id: assigneeId } });
    // 担当者になれるのはSNC本体の稼働アカウント（§4.1 SNC_ROLES）のうち、
    // 当該窓口機能に「変」権限を持つロール。④閲覧者は宣言的マップ側で除外される。
    const assignable =
      !!assignee &&
      assignee.status === "active" &&
      SNC_ROLES.includes(assignee.role as Role) &&
      can(assignee.role as Role, caseFeature(series), "update");
    if (!assignable) {
      return; // 不正な指定は無視（UIはセレクトのため通常到達しない）
    }
    assigneeLabel = `${assignee.loginId}（${assignee.name}）`;
  }
  await prisma.case.update({
    where: { id: caseId },
    data: { assigneeAccountId: assigneeId || null },
  });
  await audit(user.loginId, "case_assign", `${c.caseNo} -> ${assigneeLabel}`);
  revalidateCasePaths(series, caseId);
}

export async function suspendCaseAction(caseId: string): Promise<void> {
  await changeCaseState(caseId, "suspend", CASE_SUSPENDED, "case_suspend", "suspend");
}

// 削除（①②③＋担当窓口・論理削除 §3.4）
export async function deleteCaseAction(caseId: string): Promise<void> {
  await changeCaseState(caseId, "delete", CASE_DELETED, "case_delete", "delete");
}

// 復旧（停止解除・誤削除の復旧）。停止前／削除前のステータスへ戻す。
// 権限は元の状態に対応する操作（停止=停 / 削除済=削）で判定する。
export async function restoreCaseAction(caseId: string): Promise<void> {
  const c = await prisma.case.findUnique({ where: { id: caseId } });
  if (!c || !isInactive(c.status)) return;
  const series = c.series as Series;
  const op: Operation = c.status === CASE_DELETED ? "delete" : "suspend";
  const auth = await sncCaseOperator(series, op, "case_restore", c.caseNo);
  if ("error" in auth) return;
  const user = auth.user;

  // 停止・削除へ遷移したときの fromStatus を履歴から引き当てる（無ければ「未対応」へ戻す）
  const last = await prisma.caseStatusHistory.findFirst({
    where: { caseId: c.id, toStatus: c.status },
    orderBy: { changedAt: "desc" },
  });
  // 履歴の値がマスタから外された（active=false・削除された）場合もマスタの先頭へ戻す（§7.8）
  const masterValues = await caseStatusValues();
  const toStatus =
    last && !isInactive(last.fromStatus) && masterValues.includes(last.fromStatus)
      ? last.fromStatus
      : masterValues[0];

  await prisma.case.update({ where: { id: c.id }, data: { status: toStatus } });
  await prisma.caseStatusHistory.create({
    data: { caseId: c.id, fromStatus: c.status, toStatus, changedBy: user.name },
  });
  // 状態遷移履歴（§4.1。停止・削除からの復旧）
  await recordStatusHistory({
    entityType: "case",
    entityId: c.id,
    event: "restore",
    fromStatus: c.status,
    toStatus,
    changedBy: user.loginId,
  });
  await audit(user.loginId, "case_restore", `${c.caseNo}: ${c.status} → ${toStatus}`);
  revalidateCasePaths(series, c.id);
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
