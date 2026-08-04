"use server";

// 販売員ID管理 server actions（SPEC §6.2 / §7.3）
// すべての action で requirePage による認可 + agencyScope によるスコープ検証を行う。

import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { agencyScope, hashPassword, requirePage, type CurrentUser } from "@/lib/auth";
import { SNC_ADMIN_ROLES } from "@/lib/roles";
import { audit, notify, notifyRole, pushHistory } from "@/lib/util";
import { parseCsv } from "@/lib/csv";

export type ApplyState = { error?: string; success?: string } | undefined;
export type CsvApplyState = { error?: string; errors?: string[]; success?: string } | undefined;
export type FinalApproveState = { error?: string; salesId?: string; tempPassword?: string } | undefined;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 停止・削除を実施できるロール（権限一覧★: ①②③⑦。⑦は自店配下のみ = agencyScope で担保）
const MANAGE_ROLES = ["R1", "R2", "R3", "R7"];

// 一時パスワード生成（一般アカウント最小14桁 → 16桁。紛らわしい文字は除外）
function genTempPassword(): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnopqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const pick = (s: string) => s[crypto.randomInt(s.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < 16) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

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
  if (!DATE_RE.test(birthDate)) return { error: "生年月日は YYYY-MM-DD 形式で入力してください" };
  // R8 は自店固定（クライアント改ざん対策）
  if (user.role === "R8" && agencyId !== user.agencyId) return { error: "二次代理店は自店のみ申請できます" };
  if (scope && !scope.includes(agencyId)) return { error: "指定された代理店は操作対象外です" };
  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency || (!scope && agency.isDummy)) return { error: "代理店が見つかりません" };

  const staff = await prisma.salesStaff.create({
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
        notify(a.id, "販売員ID申請", `${lastName} ${firstName} さんの販売員ID申請が届きました`, "/sales-staff")
      )
    );
  }
  revalidatePath("/sales-staff");
  return { success: `${lastName} ${firstName} さんの販売員IDを申請しました（申請中）` };
}

// ============ CSV一括申請 ============
export async function csvBulkApplyAction(_prev: CsvApplyState, formData: FormData): Promise<CsvApplyState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません" };
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
    if (!DATE_RE.test(birthDate)) rowErrors.push("生年月日は YYYY-MM-DD 形式で入力してください");
    if (!phone) rowErrors.push("電話番号が未入力です");
    const agencyId = byCode.get(code);
    if (!code) rowErrors.push("代理店コードが未入力です");
    else if (!agencyId) rowErrors.push(`代理店コード「${code}」が存在しないか、操作対象外です`);
    if (rowErrors.length > 0) errors.push(`${line}行目: ${rowErrors.join("、")}`);
    else creates.push({ lastName, firstName, birthDate, phone, agencyId: agencyId!, email: email || null });
  });

  // エラーが1件でもあれば全件登録しない（§3.6 全件ロールバック）
  if (errors.length > 0) return { errors };

  await prisma.salesStaff.createMany({
    data: creates.map((c) => ({
      ...c,
      status: "applying",
      source: "csv",
      history: pushHistory([], "requested", user.loginId) as never,
    })),
  });
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

// ============ 1次承認（R7=自店配下のみ / R1・R2・R3） ============
export async function firstApproveAction(formData: FormData): Promise<void> {
  const user = await requirePage("sales-staff");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) return;
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff || staff.status !== "applying") return;

  await prisma.salesStaff.update({
    where: { id: staff.id },
    data: {
      firstApproved: true,
      status: "provisional",
      history: pushHistory(staff.history, "approve_first", user.loginId) as never,
    },
  });
  await audit(user.loginId, "sales_staff_first_approve", staff.id);
  await notifyRole(
    SNC_ADMIN_ROLES,
    "販売員ID最終承認待ち",
    `${staff.lastName} ${staff.firstName} さん（${staff.agency.name}）が1次承認されました`,
    "/sales-staff"
  );
  revalidatePath("/sales-staff");
}

// ============ 最終承認（R1・R2・R3。salesId採番 + R9アカウント発行） ============
export async function finalApproveAction(
  _prev: FinalApproveState,
  formData: FormData
): Promise<FinalApproveState> {
  const user = await requirePage("sales-staff");
  if (user.dummy) return { error: "閲覧専用アカウントのため操作できません" };
  if (!SNC_ADMIN_ROLES.includes(user.role)) return { error: "最終承認の権限がありません" };
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff) return { error: "対象の販売員が見つかりません" };
  if (staff.status !== "provisional") return { error: "仮登録（1次承認済み）の販売員のみ最終承認できます" };

  const code = staff.agency.code;
  const tempPassword = genTempPassword();
  try {
    const salesId = await prisma.$transaction(async (tx) => {
      // 採番: {代理店code}C{連番3桁}
      // TODO: 高並行時は unique 制約違反で失敗しうる（自動リトライなし・速度優先）
      const existing = await tx.salesStaff.findMany({
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
      const account = await tx.account.create({
        data: {
          loginId: newId,
          role: "R9",
          name: `${staff.lastName} ${staff.firstName}`,
          email: staff.email,
          agencyId: staff.agencyId,
          status: "active",
          passwordHash: hashPassword(tempPassword),
          mustChangePassword: true,
        },
      });
      await tx.salesStaff.update({
        where: { id: staff.id },
        data: {
          salesId: newId,
          status: "registered",
          accountId: account.id,
          history: pushHistory(staff.history, "final_approve", user.loginId) as never,
        },
      });
      return newId;
    });
    await audit(user.loginId, "sales_staff_final_approve", `${staff.id}:${salesId}`);
    revalidatePath("/sales-staff");
    return { salesId, tempPassword };
  } catch {
    await audit(user.loginId, "sales_staff_final_approve", staff.id, "failure");
    return { error: "最終承認に失敗しました（ID採番の競合の可能性があります）。再度お試しください" };
  }
}

// ============ 停止（R1・R2・R3・R7） ============
export async function suspendStaffAction(formData: FormData): Promise<void> {
  const user = await requirePage("sales-staff");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) return;
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff || !["provisional", "registered"].includes(staff.status)) return;

  await prisma.salesStaff.update({
    where: { id: staff.id },
    data: { status: "suspended", history: pushHistory(staff.history, "suspend", user.loginId) as never },
  });
  if (staff.accountId) {
    await prisma.account.update({ where: { id: staff.accountId }, data: { status: "suspended" } });
  }
  await audit(user.loginId, "sales_staff_suspend", staff.id);
  revalidatePath("/sales-staff");
}

// ============ 再開（R1・R2・R3・R7） ============
export async function resumeStaffAction(formData: FormData): Promise<void> {
  const user = await requirePage("sales-staff");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) return;
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff || staff.status !== "suspended") return;

  // 採番済みなら本登録へ、1次承認済みなら仮登録へ、それ以外は申請中へ戻す
  const next = staff.salesId ? "registered" : staff.firstApproved ? "provisional" : "applying";
  await prisma.salesStaff.update({
    where: { id: staff.id },
    data: { status: next, history: pushHistory(staff.history, "resume", user.loginId) as never },
  });
  if (staff.accountId) {
    await prisma.account.update({ where: { id: staff.accountId }, data: { status: "active" } });
  }
  await audit(user.loginId, "sales_staff_resume", staff.id);
  revalidatePath("/sales-staff");
}

// ============ 削除（論理削除。R1・R2・R3・R7。Accountはsuspended化） ============
export async function deleteStaffAction(formData: FormData): Promise<void> {
  const user = await requirePage("sales-staff");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) return;
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff || staff.status === "deleted") return;

  await prisma.salesStaff.update({
    where: { id: staff.id },
    data: {
      status: "deleted",
      deletedAt: new Date(),
      history: pushHistory(staff.history, "delete", user.loginId) as never,
    },
  });
  if (staff.accountId) {
    await prisma.account.update({ where: { id: staff.accountId }, data: { status: "suspended" } });
  }
  await audit(user.loginId, "sales_staff_delete", staff.id);
  revalidatePath("/sales-staff");
}

// ============ 復旧（R1・R2・R3。deleted → suspended） ============
export async function restoreStaffAction(formData: FormData): Promise<void> {
  const user = await requirePage("sales-staff");
  if (user.dummy || !SNC_ADMIN_ROLES.includes(user.role)) return;
  const staff = await loadStaffInScope(user, String(formData.get("staffId") ?? ""));
  if (!staff || staff.status !== "deleted") return;

  await prisma.salesStaff.update({
    where: { id: staff.id },
    data: {
      status: "suspended",
      deletedAt: null,
      history: pushHistory(staff.history, "restore", user.loginId) as never,
    },
  });
  await audit(user.loginId, "sales_staff_restore", staff.id);
  revalidatePath("/sales-staff");
}
