"use server";

// 販売員ID管理 server actions（SPEC §6.2 / §7.3）
// すべての action で requirePage による認可 + agencyScope によるスコープ検証を行う。

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { agencyScope, requirePage, type CurrentUser, hashedForAccount } from "@/lib/auth";
import { SNC_ADMIN_ROLES, STAFF_STATUS_LABELS } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import { UNDER_AGE_ERROR, isUnder15 } from "@/lib/age";
import { audit, notify, notifyRole, pushHistory } from "@/lib/util";
import { recordStatusHistory, type StatusEvent } from "@/lib/status";
import { generateTempPassword } from "@/lib/temp-password";
import { isCalendarDate } from "@/lib/date-input";
import { parseCsv } from "@/lib/csv";

export type ApplyState = { error?: string; success?: string } | undefined;
export type UpdateState = { error?: string; success?: string } | undefined;
export type CsvApplyState = { error?: string; errors?: string[]; success?: string } | undefined;
export type FinalApproveState =
  { error?: string; salesId?: string; tempPassword?: string } | undefined;

// 行内操作（1次承認・停止・再開・削除・復旧）の結果状態（§3.2）。
// 権限不足・状態不整合・DB例外をユーザーへ必ず可視化するため、void ではなく状態を返す。
// ts は「同じ文面が連続したときにも state 変化を検知させる」ためのタイムスタンプ。
export type RowActionState = { error?: string; success?: string; ts?: number } | undefined;

function rowFail(error: string): RowActionState {
  return { error, ts: Date.now() };
}

function rowOk(success: string): RowActionState {
  return { success, ts: Date.now() };
}

// 状態遷移を StatusHistory（§4.1「遷移イベントを履歴テーブルに記録」）へ記録する。
// JSON列 history は画面表示用の軽量な履歴で、エンティティ横断の検索・監査には使えないため
// 両方に記録する（recordStatusHistory は失敗しても業務処理を止めない）。
function track(
  entityId: string,
  event: StatusEvent,
  fromStatus: string | null,
  toStatus: string | null,
  changedBy: string,
  reason?: string | null
) {
  return recordStatusHistory({
    entityType: "sales_staff",
    entityId,
    event,
    fromStatus,
    toStatus,
    reason,
    changedBy,
  });
}

function statusLabel(status: string): string {
  return STAFF_STATUS_LABELS[status] ?? status;
}

// 電話番号（検収指摘 問題一覧No.32）: ハイフン任意・0始まり10〜11桁（携帯/固定）。
// 表記ゆれ防止のためハイフンを除いた数字で検証する。※形式は仮確定（発注者確認事項）
const PHONE_ERROR = "電話番号は0始まりの10〜11桁（ハイフン任意）で入力してください";
function isValidPhone(phone: string): boolean {
  if (!/^[\d-]+$/.test(phone)) return false;
  const digits = phone.replace(/-/g, "");
  return /^0\d{9,10}$/.test(digits);
}
// 権限判定は §5.1 の宣言的マップ（@/lib/permissions）に集約する（§3.2）。
// 販売員ID: 申=①②③⑦⑧ / 一承=⑦（+最終承認権限者は内含 §6.2-2） / 承=①②③ / 変・停・削=①②③⑦。
// ⑦の「自店配下のみ」は agencyScope（§3.1）で担保する。
const FEATURE = "sales-staff" as const;

// staffId をスコープ検証付きで取得（対象外・ダミー混入は null）
async function loadStaffInScope(user: CurrentUser, staffId: string) {
  if (!staffId) return null;
  const scope = await agencyScope(user);
  const staff = await prisma.salesStaff.findUnique({
    where: { id: staffId },
    include: { agency: true },
  });
  if (!staff) return null;
  if (scope && !scope.includes(staff.agencyId)) return null;
  if (!scope && staff.agency.isDummy) return null;
  return staff;
}

// ============ 申請（個別フォーム） ============
export async function applyStaffAction(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません" };
  if (!can(user.role, FEATURE, "apply")) return { error: "販売員IDの申請権限がありません" };
  const scope = await agencyScope(user);

  const agencyId = String(formData.get("agencyId") ?? "");
  const lastName = String(formData.get("lastName") ?? "").trim();
  const firstName = String(formData.get("firstName") ?? "").trim();
  const birthDate = String(formData.get("birthDate") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (!agencyId || !lastName || !firstName || !birthDate || !phone) {
    return { error: "必須項目（代理店・姓・名・生年月日・電話番号）を入力してください" };
  }
  // 実在する日付であること。形式のみの検証では 2011-02-31 のような値が通り、
  // 15歳判定（isUnder15 §6.2 / 発注者指示）が文字列比較のため誤った結果になる。
  if (!isCalendarDate(birthDate)) {
    return { error: "生年月日は実在する日付を YYYY-MM-DD 形式で入力してください" };
  }
  if (isUnder15(birthDate)) return { error: UNDER_AGE_ERROR }; // 15歳未満は申請不可（発注者指示）
  if (!isValidPhone(phone)) return { error: PHONE_ERROR };
  // R8 は自店固定（クライアント改ざん対策）
  if (user.role === "R8" && agencyId !== user.agencyId)
    return { error: "二次代理店は自店のみ申請できます" };
  if (scope && !scope.includes(agencyId)) return { error: "指定された代理店は操作対象外です" };
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency || (!scope && agency.isDummy)) return { error: "代理店が見つかりません" };

  // DB例外（接続断・制約違反など）もユーザーへ提示する（§3.2）
  let staff;
  try {
    staff = await prisma.salesStaff.create({
      data: {
        lastName,
        firstName,
        birthDate,
        phone,
        email: email || null,
        agencyId,
        status: "applying",
        source: "form",
        history: pushHistory([], "requested", user.loginId) as never,
      },
    });
  } catch {
    await audit(user.loginId, "sales_staff_apply", `${lastName} ${firstName}`, "failure");
    return { error: "販売員IDの申請登録に失敗しました。時間をおいて再度お試しください" };
  }

  await track(staff.id, "requested", null, "applying", user.loginId);
  await audit(user.loginId, "sales_staff_apply", staff.id);
  // 対象1次店の⑦（1次承認者）へ通知
  const primaryId = agency.tier === 2 ? agency.parentId : agency.id;
  if (primaryId) {
    const approvers = await prisma.account.findMany({
      where: { role: "R7", agencyId: primaryId, status: "active" },
      select: { id: true },
    });
    await Promise.all(
      approvers.map((a) =>
        notify(
          a.id,
          "販売員ID申請",
          `${lastName} ${firstName} さんの販売員ID申請が届きました`,
          "/sales-staff"
        )
      )
    );
  }
  revalidatePath("/sales-staff");
  return { success: `${lastName} ${firstName} さんの販売員IDを申請しました（申請中）` };
}

// ============ CSV一括申請 ============
export async function csvBulkApplyAction(
  _prev: CsvApplyState,
  formData: FormData
): Promise<CsvApplyState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません" };
  if (!can(user.role, FEATURE, "apply")) return { error: "販売員IDの申請権限がありません" };
  const scope = await agencyScope(user);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "CSVファイルを選択してください" };
  if (file.size > 4 * 1024 * 1024) return { error: "CSVファイルは4MB以下にしてください" };

  const rows = parseCsv(await file.text());
  if (rows.length === 0) return { error: "CSVにデータ行がありません" };

  // ヘッダ行（1列目が「姓」）はスキップ
  const hasHeader = (rows[0][0] ?? "").trim() === "姓";
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) return { error: "CSVにデータ行がありません" };

  // 参照される代理店コードをスコープ内で一括解決
  const codes = Array.from(new Set(dataRows.map((r) => (r[4] ?? "").trim()).filter(Boolean)));
  const agencies = await prisma.agency.findMany({
    where: {
      code: { in: codes },
      ...(scope ? { id: { in: scope } } : { isDummy: false }),
    },
    select: { id: true, code: true },
  });
  const byCode = new Map(agencies.map((a) => [a.code, a.id]));

  const errors: string[] = [];
  const creates: {
    lastName: string;
    firstName: string;
    birthDate: string;
    phone: string;
    agencyId: string;
    email: string | null;
  }[] = [];

  dataRows.forEach((r, i) => {
    // TODO: parseCsv は空行を除外するため、空行を含むファイルでは行番号が原本とずれる可能性がある（速度優先）
    const line = i + (hasHeader ? 2 : 1);
    const get = (c: number) => (r[c] ?? "").trim();
    const lastName = get(0);
    const firstName = get(1);
    const birthDate = get(2);
    const phone = get(3);
    const code = get(4);
    const email = get(5);
    const rowErrors: string[] = [];
    if (!lastName) rowErrors.push("姓が未入力です");
    if (!firstName) rowErrors.push("名が未入力です");
    if (!isCalendarDate(birthDate))
      rowErrors.push("生年月日は実在する日付を YYYY-MM-DD 形式で入力してください");
    else if (isUnder15(birthDate)) rowErrors.push(UNDER_AGE_ERROR); // 15歳未満は申請不可
    if (!phone) rowErrors.push("電話番号が未入力です");
    else if (!isValidPhone(phone)) rowErrors.push(PHONE_ERROR);
    const agencyId = byCode.get(code);
    if (!code) rowErrors.push("代理店コードが未入力です");
    else if (!agencyId) rowErrors.push(`代理店コード「${code}」が存在しないか、操作対象外です`);
    if (rowErrors.length > 0) errors.push(`${line}行目: ${rowErrors.join("、")}`);
    else
      creates.push({
        lastName,
        firstName,
        birthDate,
        phone,
        agencyId: agencyId!,
        email: email || null,
      });
  });

  // エラーが1件でもあれば全件登録しない（§3.6 全件ロールバック）
  if (errors.length > 0) return { errors };

  try {
    await prisma.salesStaff.createMany({
      data: creates.map((c) => ({
        ...c,
        status: "applying",
        source: "csv",
        history: pushHistory([], "requested", user.loginId) as never,
      })),
    });
  } catch {
    // createMany は単一SQLのため部分登録は発生しない（§3.6 全件ロールバック）
    await audit(user.loginId, "sales_staff_csv_apply", `${creates.length}件`, "failure");
    return {
      error: "CSVの取込に失敗しました（全件登録されていません）。時間をおいて再度お試しください",
    };
  }
  await audit(user.loginId, "sales_staff_csv_apply", `${creates.length}件`);
  await notifyRole(
    SNC_ADMIN_ROLES,
    "販売員ID一括申請",
    `${user.name} さんがCSVで${creates.length}件の販売員ID申請を登録しました`,
    "/sales-staff"
  );
  revalidatePath("/sales-staff");
  return { success: `${creates.length}件の販売員ID申請を登録しました（申請中）` };
}

// ============ 編集（変更。§5.1「変」= ①②③⑦。⑦は自店配下のみ / §7.3 操作列「編集」） ============
// 編集対象は販売員IDの登録情報（氏名・生年月日・電話番号・メールアドレス。§6.2-1）。
// 代理店の付け替えは所属変更＝別業務のため対象外（TODO: 要件確認後に対応）。
export async function updateStaffAction(
  _prev: UpdateState,
  formData: FormData
): Promise<UpdateState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため編集できません" };
  if (!can(user.role, FEATURE, "update")) return { error: "販売員IDの編集権限がありません" };
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff) return { error: "対象の販売員が見つかりません" };
  if (staff.status === "deleted") {
    return { error: "削除済の販売員IDは編集できません（復旧してから編集してください）" };
  }

  const lastName = String(formData.get("lastName") ?? "").trim();
  const firstName = String(formData.get("firstName") ?? "").trim();
  const birthDate = String(formData.get("birthDate") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();

  if (!lastName || !firstName || !birthDate || !phone) {
    return { error: "必須項目（姓・名・生年月日・電話番号）を入力してください" };
  }
  // 実在する日付であること。形式のみの検証では 2011-02-31 のような値が通り、
  // 15歳判定（isUnder15 §6.2 / 発注者指示）が文字列比較のため誤った結果になる。
  if (!isCalendarDate(birthDate)) {
    return { error: "生年月日は実在する日付を YYYY-MM-DD 形式で入力してください" };
  }
  if (isUnder15(birthDate)) return { error: UNDER_AGE_ERROR }; // 登録情報変更でも15歳未満は不可
  if (!isValidPhone(phone)) return { error: PHONE_ERROR };

  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        lastName,
        firstName,
        birthDate,
        phone,
        email: email || null,
        history: pushHistory(staff.history, "update", user.loginId) as never,
      },
    });
    // 発行済みのR9アカウント（ログインID＝販売員ID）の氏名・メールも同期して齟齬を防ぐ
    if (staff.accountId) {
      await prisma.account.update({
        where: { id: staff.accountId },
        data: { name: `${lastName} ${firstName}`, email: email || null },
      });
    }
  } catch {
    await audit(user.loginId, "sales_staff_update", staff.id, "failure");
    return { error: "登録情報の更新に失敗しました。時間をおいて再度お試しください" };
  }

  await track(staff.id, "update", staff.status, staff.status, user.loginId);
  await audit(user.loginId, "sales_staff_update", staff.id);
  revalidatePath("/sales-staff");
  return { success: `${lastName} ${firstName} さんの登録情報を更新しました` };
}

// ============ 1次承認（R7=自店配下のみ / R1・R2・R3） ============
export async function firstApproveAction(
  _prev: RowActionState,
  formData: FormData
): Promise<RowActionState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return rowFail("閲覧専用アカウントのため操作できません");
  if (!canApproveFirst(user.role, FEATURE)) {
    await audit(
      user.loginId,
      "sales_staff_first_approve",
      String(formData.get("staffId") ?? ""),
      "denied"
    );
    return rowFail("販売員IDの1次承認権限がありません");
  }
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff)
    return rowFail("対象の販売員が見つかりません（操作可能な代理店の販売員ではありません）");
  if (staff.status !== "applying") {
    return rowFail(`申請中の販売員のみ1次承認できます（現在: ${statusLabel(staff.status)}）`);
  }

  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        firstApproved: true,
        status: "provisional",
        history: pushHistory(staff.history, "approve_first", user.loginId) as never,
      },
    });
  } catch {
    await audit(user.loginId, "sales_staff_first_approve", staff.id, "failure");
    return rowFail("1次承認の保存に失敗しました。時間をおいて再度お試しください");
  }
  await track(staff.id, "approve_first", staff.status, "provisional", user.loginId);
  await audit(user.loginId, "sales_staff_first_approve", staff.id);
  await notifyRole(
    SNC_ADMIN_ROLES,
    "販売員ID最終承認待ち",
    `${staff.lastName} ${staff.firstName} さん（${staff.agency.name}）が1次承認されました`,
    "/sales-staff"
  );
  revalidatePath("/sales-staff");
  return rowOk(`${staff.lastName} ${staff.firstName} さんを1次承認しました（仮登録）`);
}

// ============ 最終承認（R1・R2・R3。salesId採番 + R9アカウント発行） ============
export async function finalApproveAction(
  _prev: FinalApproveState,
  formData: FormData
): Promise<FinalApproveState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };
  if (!can(user.role, FEATURE, "approve_final")) return { error: "最終承認の権限がありません" };
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff) return { error: "対象の販売員が見つかりません" };
  if (staff.status !== "provisional")
    return { error: "仮登録（1次承認済み）の販売員のみ最終承認できます" };

  const code = staff.agency.code;
  // 発行対象は⑨（販売員）。桁数はポリシー最小桁数から導出する（§4.2 / SEC-004）
  const tempPassword = generateTempPassword("R9");
  try {
    // 採番: {代理店code}C{連番3桁}
    // RLS拡張と干渉するためトランザクションを使わず逐次実行（速度優先）
    // TODO: 高並行時は unique 制約違反で失敗しうる（自動リトライなし・速度優先）
    const existing = await prisma.salesStaff.findMany({
      where: { salesId: { startsWith: `${code}C` } },
      select: { salesId: true },
    });
    let max = 0;
    for (const e of existing) {
      const n = Number(e.salesId?.slice(code.length + 1));
      if (Number.isFinite(n) && n > max) max = n;
    }
    const newId = `${code}C${String(max + 1).padStart(3, "0")}`;
    // R9（代理店一般）アカウントを同時作成。仮パスワードは保存せず戻り値で一度だけ表示。
    const account = await prisma.account.create({
      data: {
        loginId: newId,
        role: "R9",
        name: `${staff.lastName} ${staff.firstName}`,
        email: staff.email,
        agencyId: staff.agencyId,
        status: "active",
        ...hashedForAccount(tempPassword), // passwordHash + pepperVersion（SEC-021）
        mustChangePassword: true,
      },
    });
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        salesId: newId,
        status: "registered",
        accountId: account.id,
        history: pushHistory(staff.history, "final_approve", user.loginId) as never,
      },
    });
    const salesId = newId;
    await track(
      staff.id,
      "final_approve",
      staff.status,
      "registered",
      user.loginId,
      `salesId=${salesId}`
    );
    await audit(user.loginId, "sales_staff_final_approve", `${staff.id}:${salesId}`);
    revalidatePath("/sales-staff");
    return { salesId, tempPassword };
  } catch {
    await audit(user.loginId, "sales_staff_final_approve", staff.id, "failure");
    return {
      error: "最終承認に失敗しました（ID採番の競合の可能性があります）。再度お試しください",
    };
  }
}

// ============ 停止（R1・R2・R3・R7） ============
export async function suspendStaffAction(
  _prev: RowActionState,
  formData: FormData
): Promise<RowActionState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return rowFail("閲覧専用アカウントのため操作できません");
  if (!can(user.role, FEATURE, "suspend")) {
    await audit(
      user.loginId,
      "sales_staff_suspend",
      String(formData.get("staffId") ?? ""),
      "denied"
    );
    return rowFail("販売員IDの停止権限がありません");
  }
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff)
    return rowFail("対象の販売員が見つかりません（操作可能な代理店の販売員ではありません）");
  if (!["provisional", "registered"].includes(staff.status)) {
    return rowFail(`仮登録・本登録の販売員のみ停止できます（現在: ${statusLabel(staff.status)}）`);
  }

  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        status: "suspended",
        history: pushHistory(staff.history, "suspend", user.loginId) as never,
      },
    });
    if (staff.accountId) {
      await prisma.account.update({
        where: { id: staff.accountId },
        data: { status: "suspended" },
      });
    }
  } catch {
    await audit(user.loginId, "sales_staff_suspend", staff.id, "failure");
    return rowFail("停止処理に失敗しました。時間をおいて再度お試しください");
  }
  await track(staff.id, "suspend", staff.status, "suspended", user.loginId);
  await audit(user.loginId, "sales_staff_suspend", staff.id);
  revalidatePath("/sales-staff");
  return rowOk(`${staff.lastName} ${staff.firstName} さんの販売員IDを停止しました`);
}

// ============ 再開（R1・R2・R3・R7） ============
export async function resumeStaffAction(
  _prev: RowActionState,
  formData: FormData
): Promise<RowActionState> {
  const user = await requirePage("sales-staff");
  // 再開（停止の解除）は停止権限と同一（§5.1「停」）
  if (user.dummy) return rowFail("閲覧専用アカウントのため操作できません");
  if (!can(user.role, FEATURE, "suspend")) {
    await audit(
      user.loginId,
      "sales_staff_resume",
      String(formData.get("staffId") ?? ""),
      "denied"
    );
    return rowFail("販売員IDの再開権限がありません");
  }
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff)
    return rowFail("対象の販売員が見つかりません（操作可能な代理店の販売員ではありません）");
  if (staff.status !== "suspended") {
    return rowFail(`停止中の販売員のみ再開できます（現在: ${statusLabel(staff.status)}）`);
  }

  // 採番済みなら本登録へ、1次承認済みなら仮登録へ、それ以外は申請中へ戻す
  const next = staff.salesId ? "registered" : staff.firstApproved ? "provisional" : "applying";
  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: { status: next, history: pushHistory(staff.history, "resume", user.loginId) as never },
    });
    if (staff.accountId) {
      await prisma.account.update({ where: { id: staff.accountId }, data: { status: "active" } });
    }
  } catch {
    await audit(user.loginId, "sales_staff_resume", staff.id, "failure");
    return rowFail("再開処理に失敗しました。時間をおいて再度お試しください");
  }
  await track(staff.id, "resume", staff.status, next, user.loginId);
  await audit(user.loginId, "sales_staff_resume", staff.id);
  revalidatePath("/sales-staff");
  return rowOk(
    `${staff.lastName} ${staff.firstName} さんの販売員IDを再開しました（${statusLabel(next)}）`
  );
}

// ============ 削除（論理削除。R1・R2・R3・R7。Accountはsuspended化） ============
export async function deleteStaffAction(
  _prev: RowActionState,
  formData: FormData
): Promise<RowActionState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return rowFail("閲覧専用アカウントのため操作できません");
  if (!can(user.role, FEATURE, "delete")) {
    await audit(
      user.loginId,
      "sales_staff_delete",
      String(formData.get("staffId") ?? ""),
      "denied"
    );
    return rowFail("販売員IDの削除権限がありません");
  }
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff)
    return rowFail("対象の販売員が見つかりません（操作可能な代理店の販売員ではありません）");
  if (staff.status === "deleted") return rowFail("この販売員IDはすでに削除されています");

  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        status: "deleted",
        deletedAt: new Date(),
        history: pushHistory(staff.history, "delete", user.loginId) as never,
      },
    });
    if (staff.accountId) {
      // 販売員IDに紐づくログインアカウント（⑨）も**削除済**にする。
      //
      // 以前は `status: "suspended"` だけで `deletedAt` を打っていなかった。
      // 日次の匿名化バッチ（src/app/api/cron/daily/route.ts）の対象条件は
      // `status="deleted" AND deletedAt < 1年前 AND anonymizedAt IS NULL` なので、
      // suspended のままだと **アカウントの氏名・メールが永久に匿名化されない**（§3.4 違反）。
      // このアカウントの name / email は販売員の姓名・メールから生成されるため、
      // 実在の個人情報がそのまま残り続けていた（QA loop5 / 監査計画 C5）。
      // テナント一括削除（src/lib/erasure.ts）は同じ対象を deleted + deletedAt にしており、
      // 2経路で扱いが矛盾していた。こちらを合わせる。
      await prisma.account.update({
        where: { id: staff.accountId },
        data: { status: "deleted", deletedAt: new Date() },
      });
      // 削除済みアカウントでの操作を続けさせない（停止・削除と同じ扱い）
      await prisma.session.deleteMany({ where: { accountId: staff.accountId } });
    }
  } catch {
    await audit(user.loginId, "sales_staff_delete", staff.id, "failure");
    return rowFail("削除処理に失敗しました。時間をおいて再度お試しください");
  }
  await track(staff.id, "delete", staff.status, "deleted", user.loginId);
  await audit(user.loginId, "sales_staff_delete", staff.id);
  revalidatePath("/sales-staff");
  return rowOk(`${staff.lastName} ${staff.firstName} さんの販売員IDを削除しました（1年間保持）`);
}

// ============ 復旧（R1・R2・R3。deleted → suspended） ============
// 復旧は §5.1 の操作列に無い管理機能（§3.4 誤削除対応）。既存どおりSNC管理系（①②③）に限定する。
export async function restoreStaffAction(
  _prev: RowActionState,
  formData: FormData
): Promise<RowActionState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return rowFail("閲覧専用アカウントのため操作できません");
  if (!SNC_ADMIN_ROLES.includes(user.role)) {
    await audit(
      user.loginId,
      "sales_staff_restore",
      String(formData.get("staffId") ?? ""),
      "denied"
    );
    return rowFail("販売員IDの復旧権限がありません（SNC管理系のみ）");
  }
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff)
    return rowFail("対象の販売員が見つかりません（操作可能な代理店の販売員ではありません）");
  if (staff.status !== "deleted") {
    return rowFail(`削除済の販売員IDのみ復旧できます（現在: ${statusLabel(staff.status)}）`);
  }

  try {
    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        status: "suspended",
        deletedAt: null,
        history: pushHistory(staff.history, "restore", user.loginId) as never,
      },
    });
    if (staff.accountId) {
      // 削除時にアカウントも deleted + deletedAt にしているので、復旧も対称に戻す。
      // 戻し先が「停止中」なのは販売員側と揃えるため（復旧＝即ログイン可ではない §3.4 / 要件1-5）。
      // 匿名化済み（anonymizedAt あり）のアカウントは個人情報が失われており復旧しても運用できないため、
      // ステータスだけを戻して個人情報は復元しない（匿名化は不可逆 §3.4）。
      await prisma.account.update({
        where: { id: staff.accountId },
        data: { status: "suspended", deletedAt: null },
      });
    }
  } catch {
    await audit(user.loginId, "sales_staff_restore", staff.id, "failure");
    return rowFail("復旧処理に失敗しました。時間をおいて再度お試しください");
  }
  await track(staff.id, "restore", staff.status, "suspended", user.loginId);
  await audit(user.loginId, "sales_staff_restore", staff.id);
  revalidatePath("/sales-staff");
  return rowOk(`${staff.lastName} ${staff.firstName} さんの販売員IDを復旧しました（停止中）`);
}
