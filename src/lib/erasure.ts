import "server-only";
import { prisma } from "./prisma";
import { anonymizeData } from "./pii";
import { nowJst } from "./util";

// 解約・削除要件（§10.3 / SEC要件②#31）:
//   - テナント（代理店）単位のデータ一括削除機能
//   - 個人情報のオンデマンド削除（匿名化。§3.4 の匿名化仕様と整合）
//   - 削除実行時に「対象件数・データ種別・実行日時・実行者」を含む削除完了レポートを出力
//   - 削除操作自体も監査ログ対象（前提機能ごとに action を分ける）
//
// 削除の意味は §3.4 に従う:
//   アカウント系（Airisアカウント・販売員ID・訪販員申請）は **物理削除せず**「削除済」
//   ステータス + deletedAt で1年間保持し、1年経過後に個人情報カラムのみ匿名化する。
//   日報・稼働提出物・窓口案件は個人情報カラム（/// @pii）を持たない業務実績で、
//   §3.4 の「分析用に残す」に該当するため保持し、レポートには件数のみ記載する。
//   個人情報のオンデマンド削除（本ファイルの anonymizeEntity）は、この1年待ちを行わずに
//   匿名化を即時実行する経路である。

export type ErasureKind = "agency" | "pii";

/** 削除完了レポートの1行（データ種別ごと） */
export type ErasureItem = {
  /** データ種別（§10.3 レポート必須項目） */
  dataType: string;
  /** 対象件数（§10.3 レポート必須項目） */
  count: number;
  /** 処理内容 */
  treatment: "論理削除" | "匿名化" | "保持（分析用）";
};

/** 削除完了レポート（削除証明用。SEC要件②#31） */
export type ErasureReport = {
  kind: ErasureKind;
  /** 対象（代理店コード・ログインID等の識別子） */
  targetLabel: string;
  /** 実行範囲の補足（自店のみ / 配下2次店を含む など） */
  scopeLabel: string;
  reason: string;
  /** 実行者（ログインID） */
  executedBy: string;
  /** ベンダー（サスラボ社保守）操作か（§10.1 / SEC要件①） */
  vendor: boolean;
  /** 実行日時（JST） */
  executedAt: string;
  items: ErasureItem[];
  /** 削除（論理削除・匿名化）した件数の合計 */
  total: number;
  /** 監査ログのID（レポートCSVの絞り込みキー） */
  auditId?: string;
};

// 前提機能ごとに action を分ける（SEC-028）
export const ERASURE_ACTIONS: Record<ErasureKind, string> = {
  agency: "erasure_agency_bulk", // テナント（代理店）単位のデータ一括削除
  pii: "erasure_pii_anonymize", // 個人情報のオンデマンド削除（匿名化）
};

export const ERASURE_KIND_LABELS: Record<ErasureKind, string> = {
  agency: "テナント一括削除",
  pii: "個人情報削除（匿名化）",
};

// 監査ログの target に入れるキー（key=value 形式。既存の監査ログ表記に合わせる）
const ITEM_SEP = ";";

function encodeItems(items: ErasureItem[]): string {
  return items.map((i) => `${i.dataType}:${i.count}:${i.treatment}`).join(ITEM_SEP);
}

function decodeItems(raw: string): ErasureItem[] {
  if (!raw) return [];
  return raw
    .split(ITEM_SEP)
    .map((chunk) => chunk.split(":"))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      dataType: parts[0],
      count: Number(parts[1]) || 0,
      treatment: (parts[2] as ErasureItem["treatment"]) ?? "論理削除",
    }));
}

/** 監査ログ target 用の直列化（reason は最後に置き、`=` は全角に置換して解析を壊さない） */
export function serializeErasureReport(r: ErasureReport): string {
  return [
    `erasure=${r.kind}`,
    `target=${r.targetLabel.replace(/[\s=]/g, "_")}`,
    `scope=${r.scopeLabel.replace(/[\s=]/g, "_")}`,
    `total=${r.total}`,
    `items=${encodeItems(r.items).replace(/[\s=]/g, "_")}`,
    r.vendor ? "vendor=true" : "vendor=false",
    `at=${r.executedAt.replace(/\s/g, "T")}`,
    `reason=${r.reason.replace(/=/g, "＝")}`,
  ].join(" ");
}

/** 監査ログ target から削除完了レポートを復元する（レポートCSV生成用） */
export function parseErasureReport(actor: string, target: string | null): ErasureReport | null {
  if (!target || !target.startsWith("erasure=")) return null;
  const fields: Record<string, string> = {};
  const re = /([a-zA-Z]+)=(.*?)(?=\s+[a-zA-Z]+=|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(target)) !== null) fields[m[1]] = m[2];
  const kind = (fields.erasure === "pii" ? "pii" : "agency") as ErasureKind;
  return {
    kind,
    targetLabel: fields.target ?? "",
    scopeLabel: fields.scope ?? "",
    reason: fields.reason ?? "",
    executedBy: actor,
    vendor: fields.vendor === "true",
    executedAt: (fields.at ?? "").replace("T", " "),
    items: decodeItems(fields.items ?? ""),
    total: Number(fields.total) || 0,
  };
}

// 削除操作の監査記録（§3.3 / SEC-028）。監査ログはappend-onlyのため作成のみ（§10.4）。
async function recordErasureAudit(report: ErasureReport): Promise<string | null> {
  try {
    const row = await prisma.auditLog.create({
      data: {
        actor: report.executedBy,
        action: ERASURE_ACTIONS[report.kind],
        target: serializeErasureReport(report),
        result: "success",
      },
    });
    return row.id;
  } catch {
    return null; // 監査ログ失敗は業務を止めない（util.audit と同じ方針）
  }
}

/** 状態履歴（§4.1）へ論理削除・匿名化イベントを記録する */
async function recordStatusHistory(
  rows: { entityType: string; entityId: string; fromStatus?: string | null }[],
  event: "delete" | "anonymize",
  toStatus: string | null,
  reason: string,
  changedBy: string
) {
  if (rows.length === 0) return;
  try {
    await prisma.statusHistory.createMany({
      data: rows.map((r) => ({
        entityType: r.entityType,
        entityId: r.entityId,
        event,
        fromStatus: r.fromStatus ?? null,
        toStatus,
        reason,
        changedBy,
      })),
    });
  } catch {
    // 履歴記録の失敗で削除処理を巻き戻さない（監査ログ側に記録済み）
  }
}

export type ErasureActor = { loginId: string; accountId: string; isVendor: boolean };

export type EraseAgencyInput = {
  agencyId: string;
  /** 1次代理店の配下2次代理店も対象に含めるか */
  includeChildren: boolean;
  reason: string;
  actor: ErasureActor;
};

export type ErasureResult = { ok: true; report: ErasureReport } | { ok: false; error: string };

/**
 * テナント（代理店）単位のデータ一括削除（SEC-025 / §10.3）。
 * アカウント系は §3.4 の論理削除（status=deleted + deletedAt）で1年間保持する。
 */
export async function eraseAgencyData(input: EraseAgencyInput): Promise<ErasureResult> {
  const { agencyId, includeChildren, reason, actor } = input;
  if (!agencyId) return { ok: false, error: "対象の代理店を選択してください" };
  if (!reason.trim()) return { ok: false, error: "削除理由を入力してください" };

  const agency = await prisma.agency.findUnique({ where: { id: agencyId } });
  if (!agency) return { ok: false, error: "対象の代理店が見つかりません" };
  // ④ダミー表示用のサンプル代理店（§3.5）は業務データではないため対象外
  if (agency.isDummy) return { ok: false, error: "サンプルデータの代理店は操作できません" };

  const children =
    includeChildren && agency.tier === 1
      ? await prisma.agency.findMany({ where: { parentId: agency.id }, select: { id: true } })
      : [];
  const agencyIds = [agency.id, ...children.map((c) => c.id)];

  const now = new Date();
  const items: ErasureItem[] = [];

  // 1) Airisアカウント（⑨販売員IDのログインアカウントを含む）
  const accounts = await prisma.account.findMany({
    where: {
      agencyId: { in: agencyIds },
      status: { not: "deleted" },
      id: { not: actor.accountId },
    },
    select: { id: true, loginId: true, status: true },
  });
  if (accounts.length > 0) {
    await prisma.account.updateMany({
      where: { id: { in: accounts.map((a) => a.id) } },
      data: { status: "deleted", deletedAt: now },
    });
    // 即時セッション破棄（停止・削除と同じ扱い）
    await prisma.session.deleteMany({ where: { accountId: { in: accounts.map((a) => a.id) } } });
    await recordStatusHistory(
      accounts.map((a) => ({ entityType: "account", entityId: a.id, fromStatus: a.status })),
      "delete",
      "deleted",
      reason,
      actor.loginId
    );
  }
  items.push({ dataType: "Airisアカウント", count: accounts.length, treatment: "論理削除" });

  // 2) 販売員ID
  const staff = await prisma.salesStaff.findMany({
    where: { agencyId: { in: agencyIds }, status: { not: "deleted" } },
    select: { id: true, status: true },
  });
  if (staff.length > 0) {
    await prisma.salesStaff.updateMany({
      where: { id: { in: staff.map((s) => s.id) } },
      data: { status: "deleted", deletedAt: now },
    });
    await recordStatusHistory(
      staff.map((s) => ({ entityType: "sales_staff", entityId: s.id, fromStatus: s.status })),
      "delete",
      "deleted",
      reason,
      actor.loginId
    );
  }
  items.push({ dataType: "販売員ID", count: staff.length, treatment: "論理削除" });

  // 3) 訪販員申請（代理店スコープ列 §3.1。旧レコードは親販売員の所属でも判定する）
  const apps = await prisma.fieldAgentApplication.findMany({
    where: {
      status: { not: "deleted" },
      OR: [
        { primaryAgencyId: { in: agencyIds } },
        { secondaryAgencyId: { in: agencyIds } },
        { salesStaff: { agencyId: { in: agencyIds } } },
      ],
    },
    select: { id: true, status: true },
  });
  if (apps.length > 0) {
    await prisma.fieldAgentApplication.updateMany({
      where: { id: { in: apps.map((a) => a.id) } },
      data: { status: "deleted", deletedAt: now },
    });
    await recordStatusHistory(
      apps.map((a) => ({ entityType: "field_agent", entityId: a.id, fromStatus: a.status })),
      "delete",
      "deleted",
      reason,
      actor.loginId
    );
  }
  items.push({ dataType: "訪販員申請", count: apps.length, treatment: "論理削除" });

  // 4) 日報・稼働提出物・窓口案件は個人情報カラムを持たない業務実績のため
  //    §3.4「分析用に残す」に従い保持し、レポートには件数のみ記載する。
  const [reports, submissions, cases] = await Promise.all([
    prisma.dailyReport.count({ where: { agencyId: { in: agencyIds } } }),
    prisma.submission.count({
      where: {
        OR: [{ primaryAgencyId: { in: agencyIds } }, { submitterAgencyId: { in: agencyIds } }],
      },
    }),
    prisma.case.count({
      where: {
        OR: [{ primaryAgencyId: { in: agencyIds } }, { secondaryAgencyId: { in: agencyIds } }],
      },
    }),
  ]);
  items.push({ dataType: "日報", count: reports, treatment: "保持（分析用）" });
  items.push({ dataType: "稼働提出物", count: submissions, treatment: "保持（分析用）" });
  items.push({ dataType: "窓口案件", count: cases, treatment: "保持（分析用）" });

  const report: ErasureReport = {
    kind: "agency",
    targetLabel: `${agency.code}（${agency.name}）`,
    scopeLabel: children.length > 0 ? `自店+配下2次店${children.length}店` : "自店のみ",
    reason,
    executedBy: actor.loginId,
    vendor: actor.isVendor,
    executedAt: nowJst(),
    items,
    total: accounts.length + staff.length + apps.length,
  };
  report.auditId = (await recordErasureAudit(report)) ?? undefined;
  return { ok: true, report };
}

// ===== 個人情報のオンデマンド削除（匿名化。SEC-026 / §10.3 / §3.4） =====

export type PiiEntityType = "account" | "sales_staff" | "field_agent";

export const PII_ENTITY_LABELS: Record<PiiEntityType, string> = {
  account: "Airisアカウント",
  sales_staff: "販売員ID",
  field_agent: "訪販員申請",
};

/** 入力欄のプレースホルダに使う識別子の説明 */
export const PII_ENTITY_KEY_HINTS: Record<PiiEntityType, string> = {
  account: "ログインID（例: airis_2210001_001）",
  sales_staff: "販売員ID（例: 210001C001）またはレコードID",
  field_agent: "申請のレコードID",
};

export type AnonymizeInput = {
  entityType: PiiEntityType;
  /** ログインID・販売員ID・レコードIDのいずれか */
  key: string;
  reason: string;
  actor: ErasureActor;
};

/**
 * 対象1件の個人情報を即時匿名化する（1年待たずに実行。§3.4 の匿名化定義 src/lib/pii.ts と同一）。
 * 個人情報を消したレコードは業務継続できないため、未削除の場合は併せて論理削除する（§3.4）。
 */
export async function anonymizeEntity(input: AnonymizeInput): Promise<ErasureResult> {
  const { entityType, key, reason, actor } = input;
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, error: "対象の識別子を入力してください" };
  if (!reason.trim()) return { ok: false, error: "削除理由を入力してください" };

  const now = new Date();
  let targetLabel = "";
  let dataType = "";

  if (entityType === "account") {
    const account = await prisma.account.findFirst({
      where: { OR: [{ loginId: trimmed }, { id: trimmed }] },
      include: { agency: true },
    });
    if (!account) return { ok: false, error: "対象のアカウントが見つかりません" };
    if (account.agency?.isDummy)
      return { ok: false, error: "サンプルデータのアカウントは操作できません" };
    if (account.id === actor.accountId)
      return { ok: false, error: "自分自身のアカウントは操作できません" };
    if (account.anonymizedAt) return { ok: false, error: "すでに匿名化済みです" };

    await prisma.account.update({
      where: { id: account.id },
      data: {
        ...anonymizeData("Account"),
        anonymizedAt: now,
        // 個人情報を消した状態で認証・運用は継続できないため、未削除なら論理削除も行う（§3.4）
        ...(account.status === "deleted" ? {} : { status: "deleted", deletedAt: now }),
      },
    });
    await prisma.session.deleteMany({ where: { accountId: account.id } });
    await recordStatusHistory(
      [{ entityType: "account", entityId: account.id, fromStatus: account.status }],
      "anonymize",
      "deleted",
      reason,
      actor.loginId
    );
    targetLabel = account.loginId;
    dataType = "Airisアカウント（氏名・メール）";
  } else if (entityType === "sales_staff") {
    const staff = await prisma.salesStaff.findFirst({
      where: { OR: [{ salesId: trimmed }, { id: trimmed }] },
      include: { agency: true },
    });
    if (!staff) return { ok: false, error: "対象の販売員が見つかりません" };
    if (staff.agency?.isDummy)
      return { ok: false, error: "サンプルデータの販売員は操作できません" };
    if (staff.anonymizedAt) return { ok: false, error: "すでに匿名化済みです" };

    await prisma.salesStaff.update({
      where: { id: staff.id },
      data: {
        ...anonymizeData("SalesStaff"),
        anonymizedAt: now,
        ...(staff.status === "deleted" ? {} : { status: "deleted", deletedAt: now }),
      },
    });
    if (staff.accountId) {
      await prisma.session.deleteMany({ where: { accountId: staff.accountId } });
    }
    await recordStatusHistory(
      [{ entityType: "sales_staff", entityId: staff.id, fromStatus: staff.status }],
      "anonymize",
      "deleted",
      reason,
      actor.loginId
    );
    targetLabel = staff.salesId ?? staff.id;
    dataType = "販売員ID（氏名・生年月日・電話・メール）";
  } else if (entityType === "field_agent") {
    const app = await prisma.fieldAgentApplication.findFirst({
      where: { id: trimmed },
      include: { salesStaff: { include: { agency: true } } },
    });
    if (!app) return { ok: false, error: "対象の訪販員申請が見つかりません" };
    if (app.salesStaff?.agency?.isDummy)
      return { ok: false, error: "サンプルデータの申請は操作できません" };
    if (app.anonymizedAt) return { ok: false, error: "すでに匿名化済みです" };

    // 誓約書PDFは実体も削除する（pii.ts の定義どおり。日次バッチと同じ扱い）
    if (app.pledgeFileId) {
      await prisma.storedFile.deleteMany({ where: { id: app.pledgeFileId } });
    }
    await prisma.fieldAgentApplication.update({
      where: { id: app.id },
      data: {
        ...anonymizeData("FieldAgentApplication"),
        sncMemo: null, // SNCメモはPII定義外だが個人情報を含みうるため消去（日次バッチと同じ）
        anonymizedAt: now,
        ...(app.status === "deleted" ? {} : { status: "deleted", deletedAt: now }),
      },
    });
    await recordStatusHistory(
      [{ entityType: "field_agent", entityId: app.id, fromStatus: app.status }],
      "anonymize",
      "deleted",
      reason,
      actor.loginId
    );
    targetLabel = app.id;
    dataType = "訪販員申請（カナ氏名・業務委託先・誓約書PDF）";
  }
  // 想定外の種別（呼び出し側の検証漏れ）は fail-closed で何もしない
  if (!dataType) return { ok: false, error: "不明な対象種別です" };

  const report: ErasureReport = {
    kind: "pii",
    targetLabel,
    scopeLabel: PII_ENTITY_LABELS[entityType],
    reason,
    executedBy: actor.loginId,
    vendor: actor.isVendor,
    executedAt: nowJst(),
    items: [{ dataType, count: 1, treatment: "匿名化" }],
    total: 1,
  };
  report.auditId = (await recordErasureAudit(report)) ?? undefined;
  return { ok: true, report };
}

// ===== 削除完了レポート（SEC-027。対象件数・データ種別・実行日時・実行者） =====

export const ERASURE_CSV_HEADERS = [
  "実行日時",
  "実行者",
  "ベンダー操作",
  "操作種別",
  "対象",
  "範囲",
  "データ種別",
  "件数",
  "処理",
  "削除理由",
  "監査ログID",
];

export type ErasureAuditRow = {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  createdAt: Date;
};

function jstFrom(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** 監査ログ行から削除完了レポートを組み立てる（表示・CSV共通） */
export function toErasureReports(rows: ErasureAuditRow[]): ErasureReport[] {
  return rows.map((r) => {
    const parsed = parseErasureReport(r.actor, r.target);
    if (parsed) {
      return {
        ...parsed,
        executedAt: parsed.executedAt || jstFrom(r.createdAt),
        auditId: r.id,
      };
    }
    // 旧形式・欠損時も実行日時と実行者だけは残す（削除証明の最低要件）
    return {
      kind: r.action === ERASURE_ACTIONS.pii ? "pii" : "agency",
      targetLabel: r.target ?? "",
      scopeLabel: "",
      reason: "",
      executedBy: r.actor,
      vendor: (r.target ?? "").includes("vendor=true"),
      executedAt: jstFrom(r.createdAt),
      items: [],
      total: 0,
      auditId: r.id,
    };
  });
}

/** 削除完了レポートCSVの行（データ種別ごとに1行。削除証明用） */
export function erasureCsvRows(reports: ErasureReport[]): string[][] {
  const rows: string[][] = [];
  for (const r of reports) {
    const head = [
      r.executedAt,
      r.executedBy,
      r.vendor ? "true" : "false",
      ERASURE_KIND_LABELS[r.kind],
      r.targetLabel,
      r.scopeLabel,
    ];
    if (r.items.length === 0) {
      rows.push([...head, "", String(r.total), "", r.reason, r.auditId ?? ""]);
      continue;
    }
    for (const item of r.items) {
      rows.push([
        ...head,
        item.dataType,
        String(item.count),
        item.treatment,
        r.reason,
        r.auditId ?? "",
      ]);
    }
  }
  return rows;
}
