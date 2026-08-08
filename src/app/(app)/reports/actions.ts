"use server";

// 日報・稼働提出物 server actions（SPEC §7.5 / §7.6 / §6.4）
// すべてのactionで requirePage("reports") による権限チェックと
// agencyScope() による代理店スコープ検証を行う。

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope, type CurrentUser } from "@/lib/auth";
import { audit, notify, notifyRole, pushHistory, storeFile, fiscalYearOf } from "@/lib/util";
import { parseCsv } from "@/lib/csv";
import { can } from "@/lib/permissions";
import { SNC_ADMIN_ROLES, SUBMISSION_KINDS, SUBMISSION_STATUS_LABELS } from "@/lib/roles";
import { isCalendarDate } from "@/lib/date-input";
import { recordStatusHistory, type StatusEvent } from "@/lib/status";

/**
 * 稼働提出物の状態遷移を StatusHistory（§4.1「遷移イベントを履歴テーブルに記録」）へ記録する。
 *
 * 経緯（QA loop5 / 監査計画 C6）:
 *   `submission` は `src/lib/status.ts` の `STATUS_ENTITY_TYPES` に宣言され、
 *   `schema.prisma` も StatusHistory を「正の追跡元とする」と書いているのに、
 *   このファイルは `@/lib/status` を **import すらしておらず**、7つの遷移
 *   （新規提出・再提出・差し替え・1次承認・最終承認・差戻し・削除）が1行も記録されていなかった。
 *   JSON列 `history` と監査ログにしか残らず、他4エンティティと追跡方法が食い違っていた。
 *
 * JSON履歴の `submitted` / `resubmit` は `STATUS_EVENTS` に無いため、
 * 遷移イベントとしては `requested`（新規提出）/ `update`（再提出・差し替え）に正規化する。
 * 他機能（sales-staff / admin / field-agents）と同じ形。
 */
function track(
  entityId: string,
  event: StatusEvent,
  fromStatus: string | null,
  toStatus: string | null,
  changedBy: string,
  reason?: string | null
) {
  return recordStatusHistory({
    entityType: "submission",
    entityId,
    event,
    fromStatus,
    toStatus,
    reason,
    changedBy,
  });
}
import {
  VISIT_CSV_HEADERS,
  TELE_CSV_HEADERS,
  type DailyFormState,
  type CsvUploadState,
  type SubmissionFormState,
} from "./defs";
// KPI計算・月初見込判定は純粋関数として kpi.ts に切り出してある（tests/unit/kpi.test.ts で検証 T-016）
import {
  calcVisitKpi,
  calcTeleKpi,
  firstForecast,
  firstForecastRec,
  type ForecastField,
  type ForecastRow,
  type ForecastSource,
} from "./kpi";

// SNC管理系ロールの集合は src/lib/roles.ts を唯一の情報源にする（§3.2。ロール配列を画面に直書きしない）
const SNC_ADMIN: readonly string[] = SNC_ADMIN_ROLES;

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

// 稼働提出物の通知宛先ロール（§5.1: 稼働提出物は⑦⑧のみ。⑨販売員は「×」のため配信しない）
// ※⑩（稼働終了）は実効ロールで、DB上のロールは R7/R8 のまま（§14-2）
const SUBMISSION_NOTIFY_ROLES = ["R7", "R8"];

// 代理店に紐づく有効アカウントへアプリ内通知（宛先ロールをスコープする §3.7 / §5.1）
// roles を明示しない呼び出しは稼働提出物系のため、既定は代理店管理者（R7/R8）のみ。
async function notifyAgencyAccounts(
  agencyId: string,
  title: string,
  body?: string,
  link?: string,
  roles: string[] = SUBMISSION_NOTIFY_ROLES
) {
  const accounts = await prisma.account.findMany({
    where: { agencyId, status: "active", role: { in: roles } },
    select: { id: true },
  });
  await Promise.all(accounts.map((a) => notify(a.id, title, body, link)));
}

// 月初見込ロック（要件6-3 / BUG-007 の回帰防止）— フォーム保存とCSV取込の共通ルール。
// 「月内に見込は1つだけ（最古日付のレコードのみが保持する）」を保証する:
//   1. 同月・同タイプ・同販売員の既存レコードに見込が確定している場合、その日付の値は不変とし、
//      今回保存する他の日付のレコードには見込を保存しない（null）。
//   2. 既存に見込が無い場合、今回保存する行のうち最古日付の見込のみを採用し、他はnullにする。
// 戻り値: 日付 → 保存すべき見込値。
function lockMonthForecast(
  existing: ForecastSource[],
  incoming: ForecastRow[],
  field: ForecastField
): Map<string, number | null> {
  const resolved = new Map<string, number | null>();
  const confirmed = firstForecastRec(existing, field); // 既存の確定済み月初見込
  const holder = confirmed ?? firstForecast(incoming); // 無ければ今回分の最古日付が月初見込になる
  for (const row of incoming) {
    if (!holder || row.date !== holder.date) {
      resolved.set(row.date, null);
      continue;
    }
    // 確定済みの見込は上書きさせない（CSV・フォームいずれの経路でも既存値を維持）
    resolved.set(row.date, confirmed ? confirmed.value : row.value);
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// タブ1: 稼働日報
// ---------------------------------------------------------------------------

export async function saveDailyReport(
  _prev: DailyFormState,
  formData: FormData
): Promise<DailyFormState> {
  const user = await requirePage("reports");
  if (user.dummy) return { error: "閲覧専用アカウントのため保存できません" };

  const date = String(formData.get("date") ?? "");
  // 実在する日付であること（形式のみでは 2026-02-31 が通り、当月KPIの稼働日数と噛み合わなくなる）
  if (!isCalendarDate(date)) return { error: "実在する日付を入力してください" };
  const type = String(formData.get("type") ?? "");
  if (type !== "訪販" && type !== "テレマ") return { error: "日報タイプが不正です" };
  const scope = await agencyScope(user);

  // 販売員の解決（R9は自分のSalesStaff固定。他ロールはscope内から選択）
  let staff;
  if (user.role === "R9") {
    staff = await prisma.salesStaff.findUnique({ where: { accountId: user.id } });
    if (!staff) return { error: "あなたの販売員情報が見つかりません" };
  } else {
    const salesStaffId = String(formData.get("salesStaffId") ?? "");
    if (!salesStaffId) return { error: "販売員を選択してください" };
    staff = await prisma.salesStaff.findUnique({ where: { id: salesStaffId } });
    if (!staff) return { error: "販売員が見つかりません" };
    if (scope && !scope.includes(staff.agencyId)) {
      await audit(user.loginId, "daily_report_upsert", staff.id, "denied");
      return { error: "この販売員の日報を提出する権限がありません" };
    }
  }

  // 数値入力の検証
  const errs: string[] = [];
  const gi = (name: string, label: string): number | null => {
    const s = String(formData.get(name) ?? "").trim();
    if (!s) return null;
    const v = Number(s);
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      errs.push(`${label}は0以上の整数で入力してください`);
      return null;
    }
    return v;
  };
  const gf = (name: string, label: string): number | null => {
    const s = String(formData.get(name) ?? "").trim();
    if (!s) return null;
    const v = Number(s);
    if (!Number.isFinite(v) || v < 0) {
      errs.push(`${label}は0以上の数値で入力してください`);
      return null;
    }
    return v;
  };

  const isVisit = type === "訪販";
  const nums = {
    // 訪販
    forecastAcq: isVisit ? gi("forecastAcq", "獲得見込") : null,
    acquisitions: isVisit ? gi("acquisitions", "獲得") : null,
    workers: isVisit ? gi("workers", "稼働数") : null,
    visits: isVisit ? gi("visits", "訪問数") : null,
    meetings: isVisit ? gi("meetings", "対面数") : null,
    negotiations: isVisit ? gi("negotiations", "商談数") : null,
    contracts: isVisit ? gi("contracts", "成約数") : null,
    // テレマ
    forecastHours: !isVisit ? gf("forecastHours", "稼働時間(月初見込)") : null,
    forecastEntries: !isVisit ? gi("forecastEntries", "エントリー数(月初見込)") : null,
    actualHours: !isVisit ? gf("actualHours", "稼働時間(実績)") : null,
    entries: !isVisit ? gi("entries", "エントリー数(実績)") : null,
    appointments: !isVisit ? gi("appointments", "アポ数(実績)") : null,
    closePassed: !isVisit ? gi("closePassed", "クローズ通過数") : null,
    preConfirmPassed: !isVisit ? gi("preConfirmPassed", "前確通過数(実績)") : null,
  };
  if (errs.length) return { error: errs.join(" / ") };

  const common = {
    area: str(formData.get("area")),
    activityContent: str(formData.get("activityContent")),
    activityResult: str(formData.get("activityResult")),
    notes: str(formData.get("notes")),
    source: "form",
  };

  // 月初見込は月の初回提出時のみ入力（要件6-3 / BUG-007）:
  // 同月・同タイプ・同販売員で既に見込が確定している場合は送信値を無視して既存値を維持し、
  // 他の日付のレコードには見込を保存しない（月内に見込は1つだけ）。
  // 判定ロジックは lockMonthForecast() に集約し、CSV取込（uploadDailyCsv）と共通化する。
  const month = date.slice(0, 7);
  const priorMonthReports = await prisma.dailyReport.findMany({
    where: { salesStaffId: staff.id, type, date: { startsWith: month } },
    select: { date: true, forecastAcq: true, forecastHours: true, forecastEntries: true },
  });
  const keepFirstForecast = (field: ForecastField) => {
    const resolved = lockMonthForecast(priorMonthReports, [{ date, value: nums[field] }], field);
    nums[field] = resolved.get(date) ?? null;
  };
  if (isVisit) keepFirstForecast("forecastAcq");
  else {
    keepFirstForecast("forecastHours");
    keepFirstForecast("forecastEntries");
  }

  // 同一（日付,タイプ,販売員ID）は上書き（要件6-1）。
  //
  // ただし**既存レコードがあるのにフォームへ既存値が読み込まれていない場合**（プリフィルの
  // 取得範囲外の古い日付など）に空欄のまま保存すると、未編集の項目まで null で潰れて実績が消える。
  // これを防ぐため、フォームが編集モード（既存値を読み込んだ状態）でない場合は、
  // 送信されなかった（= null の）項目を更新対象から除外して既存値を維持する。
  // 編集モードのときは空欄を「意図的なクリア」として扱い、従来どおりそのまま反映する。
  const prefilled = String(formData.get("prefilled") ?? "") === "1";
  const dropNulls = <T extends Record<string, unknown>>(o: T): Partial<T> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== "")) as Partial<T>;
  const updateData = prefilled
    ? { agencyId: staff.agencyId, ...common, ...nums }
    : { agencyId: staff.agencyId, ...dropNulls(common), ...dropNulls(nums) };
  await prisma.dailyReport.upsert({
    where: { date_type_salesStaffId: { date, type, salesStaffId: staff.id } },
    create: { date, type, salesStaffId: staff.id, agencyId: staff.agencyId, ...common, ...nums },
    update: updateData,
  });

  await audit(user.loginId, "daily_report_upsert", `${date}/${type}/${staff.salesId ?? staff.id}`);
  revalidatePath("/reports");

  // 保存後、当月KPIタイルを返す（訪販12タイル / テレマ専用タイル §7.5）
  const monthReports = await prisma.dailyReport.findMany({
    where: { salesStaffId: staff.id, type, date: { startsWith: month } },
  });
  // タイトルに販売員を明示する。稼働日報タブの先頭にはスコープ全体を集計した
  // 「当月KPI（月 / 参照可能な販売員N名の合計）」が別に表示されるため、
  // 範囲の違う2枚が並んでも数値の食い違いを誤読しないようにする（§7.5）。
  const staffLabel = staff.salesId ?? staff.id;
  return {
    success: `${date} の${type}日報を保存しました`,
    kpiTitle: `当月KPI（${month} / ${type} / ${staffLabel}）`,
    kpi: isVisit ? calcVisitKpi(monthReports, date) : calcTeleKpi(monthReports),
    // 残稼働のみ原本と構造差がある（原本は日次の未入力日から算出。要件6-3 は日次の見込列を持たない）
    kpiNote: isVisit
      ? undefined
      : "「残稼働」は月初見込−実績計で算出しています（Excel原本は実績未入力日の見込合計 §14-5）",
  };
}

type CsvUpsertRow = {
  date: string;
  staffId: string;
  agencyId: string;
  salesLabel: string;
  data: Record<string, string | number | null>;
};

// CSVアップロード（行単位検証 → エラーがあれば全件拒否 §3.6）
export async function uploadDailyCsv(
  _prev: CsvUploadState,
  formData: FormData
): Promise<CsvUploadState> {
  const user = await requirePage("reports");
  if (user.dummy) return { errors: ["閲覧専用アカウントのため取込できません"] };

  const csvType = String(formData.get("csvType") ?? "");
  if (csvType !== "訪販" && csvType !== "テレマ") return { errors: ["日報タイプが不正です"] };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { errors: ["CSVファイルを選択してください"] };
  if (file.size > 20 * 1024 * 1024) return { errors: ["CSVファイルは20MB以下にしてください"] }; // 上限は既定20MB（§3.8）

  const scope = await agencyScope(user);
  const isVisit = csvType === "訪販";
  const headers = isVisit ? VISIT_CSV_HEADERS : TELE_CSV_HEADERS;

  const rows = parseCsv(await file.text());
  if (rows.length === 0) return { errors: ["CSVが空です"] };
  if (rows[0].map((c) => c.trim()).join(",") !== headers.join(",")) {
    return { errors: [`ヘッダー行がテンプレート（${csvType}用）と一致しません`] };
  }
  if (rows.length === 1) return { errors: ["データ行がありません"] };

  // スコープ内の販売員（R9は自分のみ）
  const staffList =
    user.role === "R9"
      ? await prisma.salesStaff.findMany({ where: { accountId: user.id } })
      : await prisma.salesStaff.findMany({
          where: { ...(scope ? { agencyId: { in: scope } } : {}), salesId: { not: null } },
        });
  const staffBySalesId = new Map(
    staffList.filter((s) => s.salesId).map((s) => [s.salesId as string, s])
  );

  const errors: string[] = [];
  const seen = new Set<string>();
  const upserts: CsvUpsertRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    const raw = rows[i];
    if (raw.length > headers.length) {
      errors.push(`${line}行目: 列数が不正です（${headers.length}列以内）`);
      continue;
    }
    const cols = [...raw];
    while (cols.length < headers.length) cols.push("");
    const cell = (idx: number) => cols[idx].trim();

    const date = cell(0);
    // 実在する日付であること（形式のみの検証では 2026-02-31 が通り、月次集計の分母が壊れる）
    if (!isCalendarDate(date)) {
      errors.push(`${line}行目: 日付は実在する日付をYYYY-MM-DD形式で入力してください`);
      continue;
    }
    const salesId = cell(1);
    const staff = staffBySalesId.get(salesId);
    if (!staff) {
      errors.push(`${line}行目: 販売員ID「${salesId}」が操作可能な範囲に存在しません`);
      continue;
    }
    const key = `${date}|${salesId}`;
    if (seen.has(key)) {
      errors.push(`${line}行目: 同一日付・販売員IDの行が重複しています`);
      continue;
    }
    seen.add(key);

    let rowError = false;
    const numAt = (idx: number, integer: boolean): number | null => {
      const s = cell(idx);
      if (!s) return null;
      const v = Number(s);
      if (!Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
        errors.push(
          `${line}行目: 「${headers[idx]}」は0以上の${integer ? "整数" : "数値"}で入力してください`
        );
        rowError = true;
        return null;
      }
      return v;
    };

    const data: Record<string, string | number | null> = isVisit
      ? {
          forecastAcq: numAt(3, true),
          acquisitions: numAt(4, true),
          workers: numAt(5, true),
          visits: numAt(6, true),
          meetings: numAt(7, true),
          negotiations: numAt(8, true),
          contracts: numAt(9, true),
          forecastHours: null,
          forecastEntries: null,
          actualHours: null,
          entries: null,
          appointments: null,
          closePassed: null,
          preConfirmPassed: null,
        }
      : {
          forecastAcq: null,
          acquisitions: null,
          workers: null,
          visits: null,
          meetings: null,
          negotiations: null,
          contracts: null,
          forecastHours: numAt(3, false),
          forecastEntries: numAt(4, true),
          actualHours: numAt(5, false),
          entries: numAt(6, true),
          appointments: numAt(7, true),
          closePassed: numAt(8, true),
          preConfirmPassed: numAt(9, true),
        };
    if (rowError) continue;

    data.area = cell(2) || null;
    data.activityContent = cell(10) || null;
    data.activityResult = cell(11) || null;
    data.notes = cell(12) || null;
    data.source = "csv";

    upserts.push({ date, staffId: staff.id, agencyId: staff.agencyId, salesLabel: salesId, data });
  }

  // エラーが1件でもあれば全件拒否（部分取込しない §3.6）
  if (errors.length) return { errors };

  // 月初見込ロック（要件6-3 / BUG-007の回帰防止）:
  // CSV取込でも「同月・同タイプ・同販売員」単位でフォームと同じルールを適用する。
  // 既に確定済みの見込があればCSVの見込値を無視して既存値を維持し、月内の他の日付には見込を保存しない。
  const forecastFields: ForecastField[] = isVisit
    ? ["forecastAcq"]
    : ["forecastHours", "forecastEntries"];
  const monthGroups = new Map<string, { staffId: string; month: string; rows: CsvUpsertRow[] }>();
  for (const u of upserts) {
    const m = u.date.slice(0, 7);
    const key = `${u.staffId}|${m}`;
    if (!monthGroups.has(key)) monthGroups.set(key, { staffId: u.staffId, month: m, rows: [] });
    monthGroups.get(key)!.rows.push(u);
  }
  for (const g of monthGroups.values()) {
    const existing = await prisma.dailyReport.findMany({
      where: { salesStaffId: g.staffId, type: csvType, date: { startsWith: g.month } },
      select: { date: true, forecastAcq: true, forecastHours: true, forecastEntries: true },
    });
    for (const field of forecastFields) {
      const incoming = g.rows.map((r) => {
        const v = r.data[field];
        return { date: r.date, value: typeof v === "number" ? v : null };
      });
      const resolved = lockMonthForecast(existing, incoming, field);
      for (const r of g.rows) r.data[field] = resolved.get(r.date) ?? null;
    }
  }

  // RLS拡張と干渉するためトランザクションを使わず逐次実行（速度優先。検証済みデータのみここに到達する）
  for (const u of upserts) {
    await prisma.dailyReport.upsert({
      where: { date_type_salesStaffId: { date: u.date, type: csvType, salesStaffId: u.staffId } },
      create: {
        date: u.date,
        type: csvType,
        salesStaffId: u.staffId,
        agencyId: u.agencyId,
        ...u.data,
      },
      update: { agencyId: u.agencyId, ...u.data },
    });
  }

  await audit(user.loginId, "daily_report_csv_import", `${csvType} ${upserts.length}件`);
  revalidatePath("/reports");
  return {
    success: `${upserts.length}件の${csvType}日報を取り込みました（同一日付・タイプ・販売員IDは上書き）`,
  };
}

// 日報削除（権限保有者のみ: ①②③は全件 / ⑦⑧は自店スコープ内。⑨は再提出=上書きのみ）
export async function deleteDailyReport(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy) return;
  const id = String(formData.get("id") ?? "");
  if (!id) return;
  const report = await prisma.dailyReport.findUnique({ where: { id } });
  if (!report) return;

  const scope = await agencyScope(user);
  const allowed =
    SNC_ADMIN.includes(user.role) ||
    ((user.role === "R7" || user.role === "R8") && !!scope && scope.includes(report.agencyId));
  if (!allowed) {
    await audit(user.loginId, "daily_report_delete", id, "denied");
    return;
  }
  await prisma.dailyReport.delete({ where: { id } });
  await audit(
    user.loginId,
    "daily_report_delete",
    `${report.date}/${report.type}/${report.salesStaffId}`
  );
  revalidatePath("/reports");
}

// ---------------------------------------------------------------------------
// タブ2: 稼働提出物（二段階承認 §6.4）
// ---------------------------------------------------------------------------

// 提出物ファイルの許可拡張子（§3.8 のホワイトリストのうち稼働提出物で受け付けるもの）
const SUBMISSION_EXTS = ["xlsx", "xls", "pdf", "png", "jpg", "jpeg", "zip"];

function submissionExtError(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return SUBMISSION_EXTS.includes(ext)
    ? null
    : "許可されていないファイル形式です（xlsx/xls/pdf/png/jpg/zip）";
}

// 提出（および再提出＝差し替え）時のステータス（§6.4）:
//  ⑧提出 → pending_first（1次店確認中）
//  ⑦自身名義 or SNC → pending_snc（SNC確認中）
//  ⑦が配下2次店名義で提出 → 二次代理店名義は一次承認を経るため pending_first
function submissionStatusFor(
  user: CurrentUser,
  submitterAgencyId: string
): "pending_first" | "pending_snc" {
  if (user.role === "R8") return "pending_first";
  if (user.role === "R7") {
    return submitterAgencyId === user.agencyId ? "pending_snc" : "pending_first";
  }
  return "pending_snc";
}

// 提出・再提出後の通知（pending_first→1次店管理者 / pending_snc→SNC運用者③）
async function notifySubmissionRouted(
  status: string,
  primaryAgencyId: string,
  detail: string,
  firstTitle: string,
  sncTitle: string
) {
  if (status === "pending_first") {
    await notifyAgencyAccounts(primaryAgencyId, firstTitle, detail, "/reports?tab=submissions");
  } else {
    await notifyRole(["R3"], sncTitle, detail, "/reports?tab=submissions");
  }
}

export async function createSubmission(
  _prev: SubmissionFormState,
  formData: FormData
): Promise<SubmissionFormState> {
  const user = await requirePage("reports");
  if (user.dummy) return { error: "閲覧専用アカウントのため提出できません" };
  if (user.role === "R9") return { error: "販売員アカウントは稼働提出物を利用できません" };

  const kind = String(formData.get("kind") ?? "");
  if (!(SUBMISSION_KINDS as readonly string[]).includes(kind)) {
    return { error: "提出物種別が不正です" };
  }
  const targetMonth = String(formData.get("targetMonth") ?? "");
  if (!/^\d{4}-\d{2}$/.test(targetMonth)) return { error: "対象月を指定してください" };

  const scope = await agencyScope(user);
  // 提出元代理店（R8は自店固定 / R7は自店or配下2次店 / SNCは全代理店）
  let submitterAgencyId = String(formData.get("submitterAgencyId") ?? "");
  if (user.role === "R8") submitterAgencyId = user.agencyId ?? "";
  if (!submitterAgencyId) return { error: "提出元代理店を選択してください" };
  if (scope && !scope.includes(submitterAgencyId)) {
    await audit(user.loginId, "submission_create", submitterAgencyId, "denied");
    return { error: "提出元代理店を操作する権限がありません" };
  }
  const agency = await prisma.agency.findUnique({ where: { id: submitterAgencyId } });
  if (!agency) return { error: "提出元代理店が見つかりません" };
  if (scope === null && agency.isDummy) return { error: "この代理店には提出できません" };
  const primaryAgencyId = agency.tier === 1 ? agency.id : agency.parentId;
  if (!primaryAgencyId) return { error: "一次代理店が特定できません" };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "ファイルを選択してください" };
  const extError = submissionExtError(file);
  if (extError) return { error: extError };
  const stored = await storeFile(file, user.loginId);
  if ("error" in stored) return { error: stored.error };

  const status = submissionStatusFor(user, submitterAgencyId);
  const memo = str(formData.get("memo"));

  // 同一（種別 × 対象月 × 提出元代理店）の再提出は**上書き**（§5.1「変」/ §7.6 の一元管理）。
  // 新規レコードを増やさず既存の提出物のファイルを差し替え、承認ステータスを提出直後の状態へ戻す。
  const duplicate = await prisma.submission.findFirst({
    where: { kind, targetMonth, submitterAgencyId },
    orderBy: { createdAt: "desc" },
  });
  if (duplicate) {
    // 上書きは「変」に相当するため update 権限で判定する（§5.1: ①②③⑦⑧）
    if (!can(user.role, "submission", "update")) {
      await audit(user.loginId, "submission_update", duplicate.id, "denied");
      return { error: "既存の提出物を上書きする権限がありません" };
    }
    await prisma.submission.update({
      where: { id: duplicate.id },
      data: {
        fileId: stored.id,
        fileName: stored.name,
        memo,
        status,
        rejectReason: null,
        history: pushHistory(duplicate.history, "resubmit", user.loginId) as never,
      },
    });
    await track(
      duplicate.id,
      "update",
      duplicate.status,
      status,
      user.loginId,
      "再提出による上書き"
    );
    await audit(
      user.loginId,
      "submission_update",
      `${kind} ${targetMonth} (${duplicate.id}) 再提出`
    );
    await notifySubmissionRouted(
      status,
      primaryAgencyId,
      `${kind} / ${targetMonth} / ${agency.name}`,
      "稼働提出物が差し替えられました（1次承認待ち）",
      "稼働提出物が差し替えられました（SNC確認待ち）"
    );
    revalidatePath("/reports");
    return {
      success: `「${kind}」（${targetMonth}）を再提出しました（既存の提出物を上書き / ${SUBMISSION_STATUS_LABELS[status]}）`,
    };
  }

  const sub = await prisma.submission.create({
    data: {
      kind,
      fiscalYear: fiscalYearOf(targetMonth),
      targetMonth,
      primaryAgencyId,
      submitterAgencyId,
      fileId: stored.id,
      fileName: stored.name,
      memo,
      status,
      history: pushHistory([], "submitted", user.loginId) as never,
    },
  });

  await track(sub.id, "requested", null, status, user.loginId);
  await audit(user.loginId, "submission_create", `${kind} ${targetMonth} (${sub.id})`);
  await notifySubmissionRouted(
    status,
    primaryAgencyId,
    `${kind} / ${targetMonth} / ${agency.name}`,
    "稼働提出物が提出されました（1次承認待ち）",
    "稼働提出物が提出されました（SNC確認待ち）"
  );
  revalidatePath("/reports");
  return { success: `「${kind}」（${targetMonth}）を提出しました` };
}

// 差し替え（§5.1 稼働提出物「変」= ①②③⑦⑧。⑦⑧は自店スコープ内）
// 既存の提出物（同一 種別 × 対象月 × 提出元代理店）のファイルを差し替え、
// 承認ステータスを pending_first / pending_snc へ戻し、履歴に resubmit を記録する。
export async function updateSubmissionAction(
  _prev: SubmissionFormState,
  formData: FormData
): Promise<SubmissionFormState> {
  const user = await requirePage("reports");
  if (user.dummy) return { error: "閲覧専用アカウントのため差し替えできません" };
  // 操作権限は §5.1 の宣言的マップで判定する（§3.2）
  if (!can(user.role, "submission", "update")) {
    await audit(user.loginId, "submission_update", `role=${user.role}`, "denied");
    return { error: "稼働提出物を差し替える権限がありません" };
  }

  const id = String(formData.get("id") ?? "");
  const sub = await prisma.submission.findUnique({
    where: { id },
    include: { submitterAgency: true },
  });
  if (!sub) return { error: "提出物が見つかりません" };

  // 代理店スコープ検証（§3.1。⑦は自店＋配下2次店 / ⑧は自店のみ）
  const scope = await agencyScope(user);
  if (scope && !scope.includes(sub.submitterAgencyId)) {
    await audit(user.loginId, "submission_update", id, "denied");
    return { error: "この提出物を差し替える権限がありません" };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "差し替えるファイルを選択してください" };
  }
  const extError = submissionExtError(file);
  if (extError) return { error: extError };
  const stored = await storeFile(file, user.loginId);
  if ("error" in stored) return { error: stored.error };

  // メモは入力があったときのみ更新（空欄は既存メモを維持）
  const memo = str(formData.get("replaceMemo"));
  const status = submissionStatusFor(user, sub.submitterAgencyId);

  await prisma.submission.update({
    where: { id: sub.id },
    data: {
      fileId: stored.id,
      fileName: stored.name,
      ...(memo === null ? {} : { memo }),
      status,
      rejectReason: null,
      history: pushHistory(sub.history, "resubmit", user.loginId) as never,
    },
  });

  await track(sub.id, "update", sub.status, status, user.loginId, "ファイル差し替え");
  await audit(
    user.loginId,
    "submission_update",
    `${sub.kind} ${sub.targetMonth} (${sub.id}) 差し替え`
  );
  await notifySubmissionRouted(
    status,
    sub.primaryAgencyId,
    `${sub.kind} / ${sub.targetMonth} / ${sub.submitterAgency.name}`,
    "稼働提出物が差し替えられました（1次承認待ち）",
    "稼働提出物が差し替えられました（SNC確認待ち）"
  );
  revalidatePath("/reports");
  return {
    success: `「${sub.kind}」（${sub.targetMonth}）のファイルを差し替えました（${SUBMISSION_STATUS_LABELS[status]}）`,
  };
}

// 1次承認（R7: pending_first → pending_snc）
export async function approveSubmissionFirst(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy || user.role !== "R7") return;
  const id = String(formData.get("id") ?? "");
  const sub = await prisma.submission.findUnique({
    where: { id },
    include: { submitterAgency: true },
  });
  if (!sub || sub.status !== "pending_first") return;
  const scope = await agencyScope(user);
  if (scope && !scope.includes(sub.submitterAgencyId)) {
    await audit(user.loginId, "submission_approve_first", id, "denied");
    return;
  }
  await prisma.submission.update({
    where: { id },
    data: {
      status: "pending_snc",
      history: pushHistory(sub.history, "approve_first", user.loginId) as never,
    },
  });
  await track(id, "approve_first", sub.status, "pending_snc", user.loginId);
  await audit(user.loginId, "submission_approve_first", id);
  await notifyRole(
    ["R3"],
    "稼働提出物が1次承認されました（SNC確認待ち）",
    `${sub.kind} / ${sub.targetMonth} / ${sub.submitterAgency.name}`,
    "/reports?tab=submissions"
  );
  revalidatePath("/reports");
}

// 最終承認（R1/R2/R3: pending_snc → approved）
export async function approveSubmissionFinal(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy || !SNC_ADMIN.includes(user.role)) return;
  const id = String(formData.get("id") ?? "");
  const sub = await prisma.submission.findUnique({ where: { id } });
  if (!sub || sub.status !== "pending_snc") return;
  await prisma.submission.update({
    where: { id },
    data: {
      status: "approved",
      history: pushHistory(sub.history, "final_approve", user.loginId) as never,
    },
  });
  await track(id, "final_approve", sub.status, "approved", user.loginId);
  await audit(user.loginId, "submission_final_approve", id);
  await notifyAgencyAccounts(
    sub.submitterAgencyId,
    "稼働提出物が最終承認されました",
    `${sub.kind} / ${sub.targetMonth}`,
    "/reports?tab=submissions"
  );
  if (sub.primaryAgencyId !== sub.submitterAgencyId) {
    await notifyAgencyAccounts(
      sub.primaryAgencyId,
      "配下代理店の稼働提出物が最終承認されました",
      `${sub.kind} / ${sub.targetMonth}`,
      "/reports?tab=submissions"
    );
  }
  revalidatePath("/reports");
}

// 差戻し（R7: pending_first / R1・R2・R3: pending_first・pending_snc。理由付き）
export async function rejectSubmission(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy) return;
  const id = String(formData.get("id") ?? "");
  const reason = str(formData.get("reason")) ?? "差戻し";
  const sub = await prisma.submission.findUnique({ where: { id } });
  if (!sub) return;

  let allowed = false;
  if (SNC_ADMIN.includes(user.role)) {
    allowed = sub.status === "pending_first" || sub.status === "pending_snc";
  } else if (user.role === "R7") {
    const scope = await agencyScope(user);
    allowed = sub.status === "pending_first" && !!scope && scope.includes(sub.submitterAgencyId);
  }
  if (!allowed) {
    await audit(user.loginId, "submission_reject", id, "denied");
    return;
  }
  await prisma.submission.update({
    where: { id },
    data: {
      status: "rejected",
      rejectReason: reason,
      history: pushHistory(sub.history, "reject", user.loginId) as never,
    },
  });
  await track(id, "reject", sub.status, "rejected", user.loginId, reason);
  await audit(user.loginId, "submission_reject", `${id} (${reason})`);
  await notifyAgencyAccounts(
    sub.submitterAgencyId,
    "稼働提出物が差戻しされました",
    `${sub.kind} / ${sub.targetMonth} / 理由: ${reason}`,
    "/reports?tab=submissions"
  );
  revalidatePath("/reports");
}

// 削除（提出側: ⑦は自店スコープ内 / ⑧は自店分。①②③も可 §5.1）
export async function deleteSubmission(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy) return;
  const id = String(formData.get("id") ?? "");
  const sub = await prisma.submission.findUnique({ where: { id } });
  if (!sub) return;

  let allowed = SNC_ADMIN.includes(user.role);
  if (!allowed && (user.role === "R7" || user.role === "R8")) {
    const scope = await agencyScope(user);
    allowed = !!scope && scope.includes(sub.submitterAgencyId);
  }
  if (!allowed) {
    await audit(user.loginId, "submission_delete", id, "denied");
    return;
  }
  // 物理削除なので**削除前**に記録する（§3.4 の物理削除禁止は「アカウント系」限定で、
  // 稼働提出物は対象外。ただし遷移の追跡は必要 §4.1）
  await track(id, "delete", sub.status, null, user.loginId);
  await prisma.submission.delete({ where: { id } });
  await audit(user.loginId, "submission_delete", `${sub.kind} ${sub.targetMonth} (${id})`);
  revalidatePath("/reports");
}
