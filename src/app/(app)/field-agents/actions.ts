"use server";

// 訪販員申請・管理 server actions（SPEC §6.3 / §7.4）
// - 全アクションで requirePage による権限チェック + agencyScope によるスコープ検証を行う
// - R4（SNC閲覧=ダミー表示）は書き込み拒否
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope, type CurrentUser } from "@/lib/auth";
import { SNC_ADMIN_ROLES, STAFF_STATUS_LABELS, type Role } from "@/lib/roles";
import { audit, notify, notifyRole, pushHistory, storeFile, today } from "@/lib/util";

const APPLICATION_TYPES = ["稼働", "抹消"];
const PRODUCTS = ["マルチ", "auひかり", "コラボ"];
const ATTRIBUTES = ["社員/契約社員", "パート・アルバイト", "業務委託社員", "個人事業主"];
const IDENTITY_TYPES = ["免許証", "マイナンバーカード", "パスポート"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 申請可: ①②③⑦⑧ / 1次承認: ①②③⑦ / 最終承認: ①②③ / 停止・再開・削除・復旧: ①②③⑦（販売員IDと同権限 §6.2-6）
const APPLY_ROLES: Role[] = ["R1", "R2", "R3", "R7", "R8"];
const MANAGE_ROLES: Role[] = ["R1", "R2", "R3", "R7"];

export type FormState = { error?: string; success?: string };
export type CheckState = { error?: string; warnings?: string[]; checked?: boolean };

function isSncAdmin(user: CurrentUser) {
  return SNC_ADMIN_ROLES.includes(user.role);
}

async function staffInScope(user: CurrentUser, staffId: string) {
  const staff = await prisma.salesStaff.findUnique({
    where: { id: staffId },
    include: { agency: { include: { parent: true } } },
  });
  if (!staff) return null;
  const scope = await agencyScope(user);
  if (scope !== null && !scope.includes(staff.agencyId)) return null;
  return staff;
}

async function appInScope(user: CurrentUser, id: string) {
  if (!id) return null;
  const app = await prisma.fieldAgentApplication.findUnique({
    where: { id },
    include: { salesStaff: { include: { agency: true } } },
  });
  if (!app) return null;
  const scope = await agencyScope(user);
  if (scope !== null && !scope.includes(app.salesStaff.agencyId)) return null;
  return app;
}

// 復旧・再開時の戻り先ステータス（TODO: 遷移前ステータスは保持していないため履歴から推定）
function restoredStatus(app: { firstApproved: boolean; workMonth: string | null }): string {
  if (app.workMonth) return "registered";
  if (app.firstApproved) return "provisional";
  return "applying";
}

// ============================================================
// 訪販員申請の作成（status="applying"）
// ============================================================
export async function createFieldAgentApplication(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await requirePage("field-agents");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません。" };
  if (!APPLY_ROLES.includes(user.role)) return { error: "訪販員申請の権限がありません。" };

  const str = (k: string) => String(formData.get(k) ?? "").trim();

  const salesStaffId = str("salesStaffId");
  const applicationType = str("applicationType");
  const products = str("products");
  const attribute = str("attribute");
  const lastNameKana = str("lastNameKana");
  const firstNameKana = str("firstNameKana");
  const identityType = str("identityType");
  const pledgeNo = str("pledgeNo");
  const startDate = str("startDate");
  const endDate = str("endDate");
  const agencyCode1 = str("agencyCode1");
  const agencyCode2 = str("agencyCode2");
  const contractorName = str("contractorName");
  const contractorAddress = str("contractorAddress");
  const contractorPhone = str("contractorPhone");
  const primaryAgencyName = str("primaryAgencyName");
  const agencyName = str("agencyName");

  // --- バリデーション（§7.4 列仕様） ---
  if (!salesStaffId) return { error: "販売員IDを選択してください。" };
  const staff = await staffInScope(user, salesStaffId);
  if (!staff) return { error: "選択された販売員が見つからないか、操作可能な代理店の範囲外です。" };
  // 販売員IDの登録後（仮登録 or 本登録）にのみ申請可能（§6.3-1）
  if (!["provisional", "registered"].includes(staff.status)) {
    return { error: "訪販員申請は仮登録または本登録済みの販売員IDに対してのみ可能です。" };
  }
  if (!APPLICATION_TYPES.includes(applicationType)) return { error: "申請区分を選択してください。" };
  if (!PRODUCTS.includes(products)) return { error: "取扱商材を選択してください。" };
  if (!ATTRIBUTES.includes(attribute)) return { error: "属性を選択してください。" };
  if (!lastNameKana || !firstNameKana) return { error: "フリガナ（姓・名）を入力してください。" };
  if (!IDENTITY_TYPES.includes(identityType)) return { error: "本人性種別を選択してください。" };
  if (!pledgeNo) return { error: "誓約書Noは入力必須です。" };
  if (!agencyCode1) return { error: "使用代理店コード（1枠目）は必須です。" };
  // 取扱商材=マルチ → 2枠とも必須 / auひかり・コラボ → 1枠目のみ必須（§7.4）
  if (products === "マルチ" && !agencyCode2) {
    return { error: "取扱商材が「マルチ」の場合、使用代理店コードは2枠とも必須です。" };
  }
  if (startDate && !DATE_RE.test(startDate)) return { error: "稼働開始日の形式が不正です。" };
  if (endDate && !DATE_RE.test(endDate)) return { error: "稼働終了日の形式が不正です。" };
  // 属性=業務委託社員 のときのみ業務委託会社名・住所・連絡先が必須（他属性では入力不可）
  const isContractor = attribute === "業務委託社員";
  if (isContractor && (!contractorName || !contractorAddress || !contractorPhone)) {
    return { error: "属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です。" };
  }

  // 重複申請チェック
  if (applicationType === "稼働") {
    const existing = await prisma.fieldAgentApplication.count({
      where: {
        salesStaffId: staff.id,
        applicationType: "稼働",
        status: { in: ["applying", "provisional", "registered"] },
      },
    });
    if (existing > 0) return { error: "この販売員には既に有効な訪販員申請（稼働）が存在します。" };
  } else {
    const target = await prisma.fieldAgentApplication.count({
      where: { salesStaffId: staff.id, status: { not: "deleted" } },
    });
    if (target === 0) return { error: "抹消申請の対象となる訪販員登録がありません。" };
  }

  // 誓約書PDF（任意添付）
  let pledgeFileId: string | null = null;
  const pledgeFile = formData.get("pledgeFile");
  if (pledgeFile instanceof File && pledgeFile.size > 0) {
    const isPdf =
      pledgeFile.type === "application/pdf" || pledgeFile.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) return { error: "誓約書はPDFファイルを添付してください。" };
    const stored = await storeFile(pledgeFile, user.loginId);
    if ("error" in stored) return { error: stored.error };
    pledgeFileId = stored.id;
  }

  // SNC限定項目（ブラックリスト欄・SNC用メモ）はSNC①②③以外からの入力を無視（§7.4）
  const snc = isSncAdmin(user);
  const blacklistFlagRaw = str("blacklistFlag");
  const blacklistFlag = snc && ["★", "1"].includes(blacklistFlagRaw) ? blacklistFlagRaw : null;
  const sncMemo = snc ? str("sncMemo") || null : null;

  const defaultPrimaryName =
    staff.agency.tier === 1 ? staff.agency.name : staff.agency.parent?.name ?? null;

  const created = await prisma.fieldAgentApplication.create({
    data: {
      salesStaffId: staff.id,
      applicationType,
      products,
      attribute,
      lastNameKana,
      firstNameKana,
      identityType,
      pledgeNo,
      pledgeFileId,
      startDate: startDate || null,
      endDate: endDate || null,
      agencyCode1,
      agencyCode2: agencyCode2 || null,
      contractorName: isContractor ? contractorName : null,
      contractorAddress: isContractor ? contractorAddress : null,
      contractorPhone: isContractor ? contractorPhone : null,
      blacklistFlag,
      sncMemo,
      status: "applying",
      primaryAgencyName: primaryAgencyName || defaultPrimaryName,
      agencyName: agencyName || staff.agency.name,
      history: pushHistory([], "requested", user.loginId) as never,
    },
  });

  await audit(user.loginId, "訪販員申請作成", `fieldAgentApplication:${created.id}`);
  // 通知: SNC承認者 + （2次店からの申請時）1次店管理者
  const staffLabel = `${staff.lastName} ${staff.firstName}（${staff.agency.name}）`;
  await notifyRole(
    ["R2", "R3"],
    "訪販員申請が提出されました",
    `${staffLabel} / 申請区分: ${applicationType}`,
    "/field-agents"
  );
  if (user.role === "R8" && staff.agency.parentId) {
    const admins = await prisma.account.findMany({
      where: { role: "R7", agencyId: staff.agency.parentId, status: "active" },
      select: { id: true },
    });
    await Promise.all(
      admins.map((ad) =>
        notify(ad.id, "訪販員申請（1次承認待ち）", `${staffLabel} / 申請区分: ${applicationType}`, "/field-agents")
      )
    );
  }

  revalidatePath("/field-agents");
  return { success: `訪販員申請（${applicationType}）を受け付けました。（申請中）` };
}

// ============================================================
// 同姓同名・ブラックリスト簡易チェック（§7.4 補助機能）
// ============================================================
export async function duplicateCheckAction(
  _prev: CheckState,
  formData: FormData
): Promise<CheckState> {
  const user = await requirePage("field-agents");
  if (user.dummy) return { error: "閲覧専用アカウントのため利用できません。" };
  if (!APPLY_ROLES.includes(user.role)) return { error: "権限がありません。" };

  const salesStaffId = String(formData.get("salesStaffId") ?? "").trim();
  if (!salesStaffId) return { error: "先に販売員IDを選択してください。" };
  const staff = await staffInScope(user, salesStaffId);
  if (!staff) return { error: "選択された販売員が見つからないか、操作可能な代理店の範囲外です。" };

  const scope = await agencyScope(user);
  const snc = isSncAdmin(user);
  const warnings: string[] = [];
  // 代理店ロールには他店の名称を開示しない（スコープ外は「他代理店」表記）
  const agencyLabel = (a: { id: string; name: string }) =>
    scope === null || scope.includes(a.id) ? a.name : "他代理店";

  // 同姓同名の販売員ID（全代理店横断・ダミー除外）
  const sameNameStaff = await prisma.salesStaff.findMany({
    where: {
      lastName: staff.lastName,
      firstName: staff.firstName,
      id: { not: staff.id },
      agency: { isDummy: false },
    },
    include: { agency: true },
  });
  for (const s of sameNameStaff) {
    warnings.push(
      `同姓同名の販売員IDが存在します: ${s.salesId ?? "（未採番）"} / ${agencyLabel(s.agency)} / ${STAFF_STATUS_LABELS[s.status] ?? s.status}`
    );
  }

  // 同姓同名の訪販員申請
  const sameNameApps = await prisma.fieldAgentApplication.findMany({
    where: {
      salesStaffId: { not: staff.id },
      salesStaff: {
        lastName: staff.lastName,
        firstName: staff.firstName,
        agency: { isDummy: false },
      },
    },
    include: { salesStaff: { include: { agency: true } } },
  });
  for (const a of sameNameApps) {
    warnings.push(
      `同姓同名の訪販員申請が存在します: ${agencyLabel(a.salesStaff.agency)} / 申請区分: ${a.applicationType} / ${STAFF_STATUS_LABELS[a.status] ?? a.status}`
    );
  }

  // ブラックリスト該当（SNC①②③にのみ表示。代理店側には一切見せない §7.4）
  // TODO: 生年月日等を含む本人性の厳密な突合は未実装（同姓同名の簡易チェックのみ）
  if (snc) {
    const blacklisted = await prisma.fieldAgentApplication.findMany({
      where: {
        blacklistFlag: { not: null },
        salesStaff: {
          lastName: staff.lastName,
          firstName: staff.firstName,
          agency: { isDummy: false },
        },
      },
      include: { salesStaff: { include: { agency: true } } },
    });
    for (const a of blacklisted) {
      warnings.push(
        `【ブラックリスト】同姓同名にブラックリスト欄「${a.blacklistFlag}」の登録があります: ${a.salesStaff.agency.name} / ${STAFF_STATUS_LABELS[a.status] ?? a.status}`
      );
    }
  }

  // 機微データ閲覧の監査記録（§3.3 ブラックリスト欄の表示は必須記録）
  await audit(user.loginId, "同姓同名・ブラックリスト簡易チェック", `salesStaff:${staff.id}`);
  return { warnings, checked: true };
}

// ============================================================
// 承認フロー・状態遷移（history + audit を必ず記録）
// ============================================================

// 1次承認（⑦ or SNC①②③）: applying → provisional
export async function firstApproveAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) {
    await audit(user.loginId, "訪販員申請1次承認", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || app.status !== "applying") return;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      status: "provisional",
      firstApproved: true,
      history: pushHistory(app.history, "approve_first", user.loginId) as never,
    },
  });
  await audit(user.loginId, "訪販員申請1次承認", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 最終承認（①②③のみ。自己承認可 §6.2）:
// - 稼働: → registered（workMonth=当月）
// - 抹消: → deleted（当該訪販員登録＝他の有効申請も抹消 §4.1）
export async function finalApproveAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !isSncAdmin(user)) {
    await audit(user.loginId, "訪販員申請最終承認", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || !["applying", "provisional"].includes(app.status)) return;

  if (app.applicationType === "抹消") {
    await prisma.fieldAgentApplication.update({
      where: { id: app.id },
      data: {
        status: "deleted",
        firstApproved: true,
        deletedAt: new Date(),
        history: pushHistory(
          pushHistory(app.history, "final_approve", user.loginId),
          "delete",
          user.loginId
        ) as never,
      },
    });
    // 当該訪販員のその他の有効な登録も抹消（削除済へ遷移）
    const others = await prisma.fieldAgentApplication.findMany({
      where: { salesStaffId: app.salesStaffId, id: { not: app.id }, status: { not: "deleted" } },
    });
    for (const o of others) {
      await prisma.fieldAgentApplication.update({
        where: { id: o.id },
        data: {
          status: "deleted",
          deletedAt: new Date(),
          history: pushHistory(o.history, "delete", user.loginId) as never,
        },
      });
    }
    await audit(user.loginId, "訪販員抹消（最終承認）", `fieldAgentApplication:${app.id}`);
  } else {
    await prisma.fieldAgentApplication.update({
      where: { id: app.id },
      data: {
        status: "registered",
        firstApproved: true,
        workMonth: today().slice(0, 7), // 稼働月=当月（YYYY-MM）
        history: pushHistory(app.history, "final_approve", user.loginId) as never,
      },
    });
    await audit(user.loginId, "訪販員申請最終承認", `fieldAgentApplication:${app.id}`);
  }
  revalidatePath("/field-agents");
}

// 停止（①②③⑦）: provisional / registered → suspended
export async function suspendAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) {
    await audit(user.loginId, "訪販員停止", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || !["provisional", "registered"].includes(app.status)) return;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      status: "suspended",
      history: pushHistory(app.history, "suspend", user.loginId) as never,
    },
  });
  await audit(user.loginId, "訪販員停止", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 再開（①②③⑦）: suspended → 元のステータス
export async function resumeAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) {
    await audit(user.loginId, "訪販員再開", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || app.status !== "suspended") return;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      status: restoredStatus(app),
      history: pushHistory(app.history, "resume", user.loginId) as never,
    },
  });
  await audit(user.loginId, "訪販員再開", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 削除（①②③⑦・論理削除 §3.4）
export async function removeAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) {
    await audit(user.loginId, "訪販員申請削除", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || app.status === "deleted") return;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      status: "deleted",
      deletedAt: new Date(),
      history: pushHistory(app.history, "delete", user.loginId) as never,
    },
  });
  await audit(user.loginId, "訪販員申請削除", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 復旧（①②③⑦）: deleted → 元のステータス（誤削除バックアップ復旧 §3.4）
export async function restoreAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !MANAGE_ROLES.includes(user.role)) {
    await audit(user.loginId, "訪販員申請復旧", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app || app.status !== "deleted") return;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      status: restoredStatus(app),
      deletedAt: null,
      history: pushHistory(app.history, "restore", user.loginId) as never,
    },
  });
  await audit(user.loginId, "訪販員申請復旧", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// SNC限定項目（ブラックリスト欄・SNC用メモ）の更新（①②③のみ）
export async function updateSncFieldsAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !isSncAdmin(user)) {
    await audit(user.loginId, "ブラックリスト欄変更", `fieldAgentApplication:${id}`, "denied");
    return;
  }
  const app = await appInScope(user, id);
  if (!app) return;
  const flagRaw = String(formData.get("blacklistFlag") ?? "").trim();
  const blacklistFlag = ["★", "1"].includes(flagRaw) ? flagRaw : null;
  const sncMemo = String(formData.get("sncMemo") ?? "").trim() || null;
  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: { blacklistFlag, sncMemo },
  });
  await audit(
    user.loginId,
    "ブラックリスト欄変更",
    `fieldAgentApplication:${app.id} flag=${blacklistFlag ?? "無印"}`
  );
  revalidatePath("/field-agents");
}
