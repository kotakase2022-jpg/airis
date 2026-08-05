// 訪販員申請の代理店スコープ列の解決（SPEC §3.1）
//
// §3.1「全業務テーブルに代理店スコープ（primaryAgencyId / secondaryAgencyId）を持たせ、
// 認証セッションから解決したスコープをサーバ側で必ず検証する」。
// FieldAgentApplication は親 SalesStaff の所属代理店からスコープを解決して**自テーブルに保持**し、
// PostgreSQL RLS（prisma/rls.sql）とアプリ層の双方がこの2列で直接判定する（親テーブルへの
// EXISTS 参照をやめる）。
//
// スコープ規則（§3.1）:
//   - 1次代理店（⑦）: 自店 + 配下の2次代理店 → primaryAgencyId で一致する
//   - 2次代理店（⑧）: 自店のみ            → secondaryAgencyId で一致する
//
// ※ 販売員の所属代理店を後から付け替える運用が入る場合は、この2列も追従更新すること
//   （現状の販売員ID管理では所属は登録時のみ確定するため追従処理は持たない）。
export type ScopeAgency = { id: string; tier: number; parentId: string | null };

export type AgencyScopeColumns = {
  primaryAgencyId: string | null;
  secondaryAgencyId: string | null;
};

export function resolveAgencyScope(agency: ScopeAgency): AgencyScopeColumns {
  // 1次代理店に所属する販売員: 1次店=自店。2次店スコープは持たない
  if (agency.tier === 1) return { primaryAgencyId: agency.id, secondaryAgencyId: null };
  // 2次代理店に所属する販売員: 1次店=親代理店 / 2次店=自店
  return { primaryAgencyId: agency.parentId, secondaryAgencyId: agency.id };
}
