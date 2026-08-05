import "server-only";
import { prisma } from "./prisma";
import { CASE_STATUSES } from "./roles";

// =============================================================================
// ステータスのマスタ化（§7.8）と状態遷移履歴（§4.1）
//
// §7.8「ステータス: `未対応` / `確認中` / `対応中` / `問題発生` / `完了` を案件画面から
//       変更可能（値はマスタ化して増減できる実装に）」
//   → DB（StatusMaster）を正の定義とし、**コード変更・再デプロイなしに値を増減できる**。
//     マスタ未投入（またはマイグレーション未適用）の環境では、コード側の既定値
//     （src/lib/roles.ts の CASE_STATUSES）へフォールバックして画面を壊さない。
//
// §4.1「状態遷移はサーバ側で厳密に制御し、遷移イベントを履歴テーブル（例: `requested` /
//       `approve_first` / `final_approve` / `reject` / `suspend` / `resume` / `delete`）に記録」
//   → StatusHistory へエンティティ横断で時刻付きに記録する（recordStatusHistory）。
// =============================================================================

// StatusMaster.kind（マスタの区分）。窓口案件のステータスは "case"。
export const STATUS_KIND_CASE = "case";

// StatusMaster から読み出す最小のかたち（純粋関数のテスト対象にするため型を切り出す）
export type StatusMasterRow = {
  value: string;
  sortOrder: number;
  tone: string | null;
  active: boolean;
};

// 画面のセレクト・バッジ描画に必要な情報
export type StatusOption = {
  value: string;
  // バッジ色（StatusMaster.tone。未設定なら null → 呼び出し側で既定の色分けに任せる）
  tone: string | null;
};

// ---------------------------------------------------------------------------
// 純粋関数（DBに依存しないため単体テスト対象。tests/unit/status-master.test.ts）
// ---------------------------------------------------------------------------

/**
 * マスタ行を画面用の選択肢へ解決する。
 * - `active=false` の行は除外する（値の「減」をコード変更なしに行えるようにする §7.8）
 * - `sortOrder` の昇順に並べる（同値は取得順を保つ = 安定ソート）
 * - 有効な行が1件も無ければ `fallback`（コード側の既定値）を返す
 */
export function resolveStatusOptions(
  rows: readonly StatusMasterRow[],
  fallback: readonly string[]
): StatusOption[] {
  const active = rows.filter((r) => r.active);
  if (active.length === 0) return fallback.map((value) => ({ value, tone: null }));
  // Array.prototype.sort は安定ソートのため、sortOrder が同値の行は取得順（DBのorderBy）が残る
  return [...active]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) => ({ value: r.value, tone: r.tone }));
}

/** resolveStatusOptions の値のみ版（セレクトの option / バリデーション用） */
export function resolveStatusValues(
  rows: readonly StatusMasterRow[],
  fallback: readonly string[]
): string[] {
  return resolveStatusOptions(rows, fallback).map((o) => o.value);
}

// ---------------------------------------------------------------------------
// マスタ読み出し（DBを正とし、未投入時はコード側の既定値へフォールバック）
// ---------------------------------------------------------------------------

/**
 * 指定 kind のステータス選択肢を返す。
 * StatusMaster が未投入・未マイグレーションでも既定値で動作する（fail-safe）。
 */
export async function statusOptions(
  kind: string,
  fallback: readonly string[]
): Promise<StatusOption[]> {
  let rows: StatusMasterRow[] = [];
  try {
    rows = await prisma.statusMaster.findMany({
      where: { kind },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { value: true, sortOrder: true, tone: true, active: true },
    });
  } catch {
    // マイグレーション未適用（テーブル不在）・一時的なDBエラーでも画面を落とさず既定値で描画する。
    // 既定値は仕様（§7.8）の5値なので、フォールバックしても仕様どおりの動作になる。
    rows = [];
  }
  return resolveStatusOptions(rows, fallback);
}

/** 窓口案件（HL/消セン）のステータス選択肢（§7.8） */
export async function caseStatusOptions(): Promise<StatusOption[]> {
  return statusOptions(STATUS_KIND_CASE, CASE_STATUSES);
}

/** 窓口案件のステータス値一覧（セレクトの option / server action のバリデーション用） */
export async function caseStatusValues(): Promise<string[]> {
  return (await caseStatusOptions()).map((o) => o.value);
}

/** 窓口案件の既定ステータス（起票時。マスタの先頭 = 既定では「未対応」） */
export async function defaultCaseStatus(): Promise<string> {
  const values = await caseStatusValues();
  return values[0] ?? CASE_STATUSES[0];
}

/**
 * ステータス値がマスタに存在するか（server action 側のバリデーション。§7.8）。
 * UI層のセレクトだけでなくAPI層でも必ず通す（AGENTS.md「認可はUIとAPIの両層で行う」）。
 */
export async function isCaseStatus(value: string): Promise<boolean> {
  return (await caseStatusValues()).includes(value);
}

// ---------------------------------------------------------------------------
// 状態遷移履歴（StatusHistory / §4.1）
// ---------------------------------------------------------------------------

// §4.1 の遷移イベント（例示された7種）+ スキーマのコメントにある restore / update。
export const STATUS_EVENTS = [
  "requested",
  "approve_first",
  "final_approve",
  "reject",
  "suspend",
  "resume",
  "delete",
  "restore",
  "update",
] as const;
export type StatusEvent = (typeof STATUS_EVENTS)[number];

// StatusHistory.entityType（スキーマのコメントに列挙された対象エンティティ）
export const STATUS_ENTITY_TYPES = [
  "account",
  "account_request",
  "sales_staff",
  "field_agent",
  "submission",
  "case",
] as const;
export type StatusEntityType = (typeof STATUS_ENTITY_TYPES)[number];

// イベントの日本語表示。§5.1 の凡例（一承=1次承認 / 承=最終承認 / 変=変更 / 停=停止 / 削=削除）と
// §4.1 の用語（差戻し・却下）に合わせる。
export const STATUS_EVENT_LABELS: Record<StatusEvent, string> = {
  requested: "申請",
  approve_first: "1次承認",
  final_approve: "最終承認",
  reject: "差戻し・却下",
  suspend: "停止",
  resume: "再開",
  delete: "削除",
  restore: "復旧",
  update: "変更",
};

export function statusEventLabel(event: string): string {
  return STATUS_EVENT_LABELS[event as StatusEvent] ?? event;
}

export type RecordStatusHistoryInput = {
  entityType: StatusEntityType;
  entityId: string;
  event: StatusEvent;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  // 実行者の loginId（監査ログの actor と同じ粒度で追跡できるようにする §3.3）
  changedBy: string;
};

/**
 * 状態遷移を StatusHistory に記録する（§4.1）。
 *
 * 記録の失敗で業務処理（ステータス変更そのもの）を止めないため例外は飲む。
 * 遷移は呼び出し側で必ず audit()（§3.3）にも記録しているので追跡は途切れない。
 */
export async function recordStatusHistory(input: RecordStatusHistoryInput): Promise<void> {
  try {
    await prisma.statusHistory.create({
      data: {
        entityType: input.entityType,
        entityId: input.entityId,
        event: input.event,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        reason: input.reason ?? null,
        changedBy: input.changedBy,
      },
    });
  } catch {
    // マイグレーション未適用の環境でも画面・操作が動くようにする（audit() と同方針）
  }
}

export type StatusHistoryEntry = {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  changedBy: string;
  changedAt: Date;
};

/** 対象エンティティの状態遷移履歴（新しい順。画面から時刻付きで参照する §4.1 / 要件9-4） */
export async function statusHistoryOf(
  entityType: StatusEntityType,
  entityId: string,
  take = 100
): Promise<StatusHistoryEntry[]> {
  try {
    return await prisma.statusHistory.findMany({
      where: { entityType, entityId },
      // 同一ミリ秒の遷移（連続実行）でも順序が揺れないよう id を第2キーにする（cuid は生成順に単調増加）
      orderBy: [{ changedAt: "desc" }, { id: "desc" }],
      take,
      select: {
        id: true,
        event: true,
        fromStatus: true,
        toStatus: true,
        reason: true,
        changedBy: true,
        changedAt: true,
      },
    });
  } catch {
    return [];
  }
}
