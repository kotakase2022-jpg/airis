"use server";

import { revalidatePath } from "next/cache";
import { agencyScope, requirePage } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SNC_ADMIN_ROLES } from "@/lib/roles";
import { audit } from "@/lib/util";

export type AgencyActionState = {
  ok?: boolean;
  error?: string;
  ts?: number; // 連続送信時に state 変化を検知するためのタイムスタンプ
};

function fail(error: string): AgencyActionState {
  return { error, ts: Date.now() };
}

// 書込権限チェック: SNC管理系（①②③）のみ。R4（SNC閲覧=ダミー表示）は user.dummy で必ず拒否（§3.5 / §7.11）
async function requireWriter() {
  const user = await requirePage("agencies");
  if (user.dummy) return null;
  if (!SNC_ADMIN_ROLES.includes(user.role)) return null;
  return user;
}

// 代理店の追加（1次 / 2次。§7.11 - SNCのみ）
export async function createAgencyAction(
  _prev: AgencyActionState,
  formData: FormData
): Promise<AgencyActionState> {
  const user = await requireWriter();
  if (!user) return fail("この操作を行う権限がありません。");

  const tier = Number(formData.get("tier"));
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const representative = String(formData.get("representative") ?? "").trim();
  const joinedAt = String(formData.get("joinedAt") ?? "").trim();
  const parentId = String(formData.get("parentId") ?? "").trim();

  if (tier !== 1 && tier !== 2) return fail("階層の指定が不正です。");
  if (!/^\d{6}$/.test(code)) return fail("代理店コードは6桁の数字で入力してください。");
  if (!name) return fail("代理店名を入力してください。");
  if (joinedAt && !/^\d{4}-\d{2}-\d{2}$/.test(joinedAt)) return fail("参加日の形式が不正です。");

  if (tier === 2) {
    if (!parentId) return fail("管轄する一次代理店を選択してください。");
    const parent = await prisma.agency.findUnique({ where: { id: parentId } });
    if (!parent || parent.tier !== 1 || parent.isDummy) {
      return fail("管轄一次代理店の指定が不正です。");
    }
  }

  // 代理店コードのユニーク検証
  const dup = await prisma.agency.findUnique({ where: { code } });
  if (dup) return fail(`代理店コード ${code} は既に使用されています。`);

  // DB例外（コードのユニーク制約競合・接続断など）もユーザーへ提示する（§3.2）
  let created;
  try {
    created = await prisma.agency.create({
      data: {
        code,
        name,
        tier,
        parentId: tier === 2 ? parentId : null,
        representative: representative || null,
        status: "active",
        joinedAt: joinedAt ? new Date(`${joinedAt}T00:00:00+09:00`) : new Date(),
      },
    });
  } catch {
    await audit(user.loginId, "agency_create", `${code} ${name}`, "failure");
    return fail("代理店の登録に失敗しました。代理店コードの重複がないか確認し、再度お試しください。");
  }
  await audit(user.loginId, "agency_create", `${created.code} ${created.name}`);
  revalidatePath("/agencies");
  return { ok: true, ts: Date.now() };
}

// 代理店の編集（名称・代表者・ステータス。§7.11 - SNCのみ）
// ステータスを closed（稼働終了）にすると、当該店の⑦⑧アカウントはログイン時に実効ロール⑩へ解決される（auth.ts）
export async function updateAgencyAction(
  _prev: AgencyActionState,
  formData: FormData
): Promise<AgencyActionState> {
  const user = await requireWriter();
  if (!user) return fail("この操作を行う権限がありません。");

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const representative = String(formData.get("representative") ?? "").trim();
  const status = String(formData.get("status") ?? "");

  if (!name) return fail("代理店名を入力してください。");
  if (status !== "active" && status !== "closed") return fail("ステータスの指定が不正です。");

  const agency = await prisma.agency.findUnique({ where: { id } });
  if (!agency || agency.isDummy) return fail("対象の代理店が見つかりません。");

  // 代理店スコープ検証（SNC管理系は null=全代理店だが、多層防御として必ず確認 §3.1）
  const scope = await agencyScope(user);
  if (scope && !scope.includes(id)) return fail("この代理店を操作する権限がありません。");

  try {
    await prisma.agency.update({
      where: { id },
      data: { name, representative: representative || null, status },
    });
  } catch {
    await audit(user.loginId, "agency_update", `${agency.code} ${name}`, "failure");
    return fail("代理店の更新に失敗しました。時間をおいて再度お試しください。");
  }
  await audit(
    user.loginId,
    "agency_update",
    `${agency.code} ${name} (status: ${agency.status} -> ${status})`
  );
  revalidatePath("/agencies");
  return { ok: true, ts: Date.now() };
}

// 代理店の削除（§7.11 - SNCのみ。配下にアカウント・販売員が存在する場合は拒否）
export async function deleteAgencyAction(
  _prev: AgencyActionState,
  formData: FormData
): Promise<AgencyActionState> {
  const user = await requireWriter();
  if (!user) return fail("この操作を行う権限がありません。");

  const id = String(formData.get("id") ?? "");
  const agency = await prisma.agency.findUnique({
    where: { id },
    include: { _count: { select: { accounts: true, salesStaff: true, children: true } } },
  });
  if (!agency || agency.isDummy) return fail("対象の代理店が見つかりません。");

  const scope = await agencyScope(user);
  if (scope && !scope.includes(id)) return fail("この代理店を操作する権限がありません。");

  if (agency._count.children > 0) {
    await audit(user.loginId, "agency_delete", `${agency.code} ${agency.name}`, "denied");
    return fail(`配下に下位代理店が ${agency._count.children} 店存在するため削除できません。`);
  }
  if (agency._count.accounts > 0 || agency._count.salesStaff > 0) {
    await audit(user.loginId, "agency_delete", `${agency.code} ${agency.name}`, "denied");
    return fail(
      `配下にアカウント ${agency._count.accounts} 件・販売員 ${agency._count.salesStaff} 名が存在するため削除できません。先に移管または削除してください。`
    );
  }

  try {
    await prisma.agency.delete({ where: { id } });
  } catch {
    // 日報・提出物・窓口案件等の関連データがFK制約で残っている場合
    await audit(user.loginId, "agency_delete", `${agency.code} ${agency.name}`, "denied");
    return fail("関連データ（日報・提出物・窓口案件等）が存在するため削除できません。");
  }
  await audit(user.loginId, "agency_delete", `${agency.code} ${agency.name}`);
  revalidatePath("/agencies");
  return { ok: true, ts: Date.now() };
}
