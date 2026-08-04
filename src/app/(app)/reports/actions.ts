"use server";

// 日報・稼働提出物 server actions（SPEC §7.5 / §7.6 / §6.4）
// すべてのactionで requirePage("reports") による権限チェックと
// agencyScope() による代理店スコープ検証を行う。

import { revalidatePath } from "next/cache";
import type { DailyReport } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope } from "@/lib/auth";
import { audit, notify, notifyRole, pushHistory, storeFile, fiscalYearOf } from "@/lib/util";
import { parseCsv } from "@/lib/csv";
import { SUBMISSION_KINDS } from "@/lib/roles";
import {
  VISIT_CSV_HEADERS,
  TELE_CSV_HEADERS,
  type DailyFormState,
  type CsvUploadState,
  type SubmissionFormState,
  type KpiTile,
} from "./defs";

const SNC_ADMIN = ["R1", "R2", "R3"];

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

function str(v: FormDataEntryValue | null): string | null {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

// 代理店に紐づく有効アカウント全員へアプリ内通知
async function notifyAgencyAccounts(agencyId: string, title: string, body?: string, link?: string) {
  const accounts = await prisma.account.findMany({
    where: { agencyId, status: "active" },
    select: { id: true },
  });
  await Promise.all(accounts.map((a) => notify(a.id, title, body, link)));
}

// 分母0は0（SPEC §7.5「端数・分母0は「0」表示」）
function div(a: number, b: number): number {
  return b ? a / b : 0;
}
function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}
function fx(v: number): string {
  return String(Math.round(v * 10) / 10);
}

// 当月KPI 12タイル（訪販）。計算式は日報Excel準拠（詳細不明分は仮実装 §14-5）
// TODO(§14-5): テレマ用KPI（アポ生産性・クローズ通過率・前確通過率・残稼働等）は
// 入力項目/数式の原本が未確定のため未実装。テレマ日報保存時も本12タイル（訪販項目
// ベース）を表示するため、テレマのみの月は多くの指標が0表示になる。
function calcMonthlyKpi(reports: DailyReport[], date: string): KpiTile[] {
  const [y, m, d] = date.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const elapsed = d; // 経過日
  const sum = (f: (r: DailyReport) => number | null) =>
    reports.reduce((acc, r) => acc + (f(r) ?? 0), 0);
  const acq = sum((r) => r.acquisitions);
  const workers = sum((r) => r.workers);
  const visits = sum((r) => r.visits);
  const meetings = sum((r) => r.meetings);
  const negotiations = sum((r) => r.negotiations);
  const contracts = sum((r) => r.contracts);
  // 獲得見込は「月初見込」（月内の最大値を採用）
  const forecast = reports.reduce((acc, r) => Math.max(acc, r.forecastAcq ?? 0), 0);
  // TODO: 「訪問/日」等の分母は暫定で当月の日報提出日数を採用（Excel原本の数式確認要 §14-5）
  const reportDays = new Set(reports.map((r) => r.date)).size;
  const landing = div(acq, elapsed) * daysInMonth; // 着地予想

  return [
    { label: "生産性", value: fx(div(acq, workers)) },
    { label: "進捗", value: pct(div(elapsed, daysInMonth)) },
    { label: "達成率", value: pct(div(acq, forecast)) },
    { label: "着地予想", value: fx(landing) },
    { label: "着地差分", value: fx(forecast ? landing - forecast : 0) },
    { label: "ペースメーカー", value: fx(div(forecast, daysInMonth) * elapsed) },
    { label: "対面率", value: pct(div(meetings, visits)) },
    { label: "商談率", value: pct(div(negotiations, meetings)) },
    { label: "成約率", value: pct(div(contracts, negotiations)) },
    { label: "訪問/日", value: fx(div(visits, reportDays)) },
    { label: "対面/日", value: fx(div(meetings, reportDays)) },
    { label: "商談/日", value: fx(div(negotiations, reportDays)) },
  ];
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: "日付を入力してください" };
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

  // 同一（日付,タイプ,販売員ID）は上書き（要件6-1）
  await prisma.dailyReport.upsert({
    where: { date_type_salesStaffId: { date, type, salesStaffId: staff.id } },
    create: { date, type, salesStaffId: staff.id, agencyId: staff.agencyId, ...common, ...nums },
    update: { agencyId: staff.agencyId, ...common, ...nums },
  });

  await audit(user.loginId, "daily_report_upsert", `${date}/${type}/${staff.salesId ?? staff.id}`);
  revalidatePath("/reports");

  // 保存後、当月KPIタイル（12個）を返す
  const month = date.slice(0, 7);
  const monthReports = await prisma.dailyReport.findMany({
    where: { salesStaffId: staff.id, type, date: { startsWith: month } },
  });
  return {
    success: `${date} の${type}日報を保存しました`,
    kpiTitle: `当月KPI（${month} / ${type}）`,
    kpi: calcMonthlyKpi(monthReports, date),
    kpiNote:
      type === "テレマ"
        ? "テレマ専用KPI（アポ生産性・クローズ通過率等）は仮実装のため未表示です（TODO §14-5）"
        : undefined,
  };
}

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
  if (!(file instanceof File) || file.size === 0) return { errors: ["CSVファイルを選択してください"] };
  if (file.size > 4 * 1024 * 1024) return { errors: ["CSVファイルは4MB以下にしてください"] };

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
  const staffBySalesId = new Map(staffList.filter((s) => s.salesId).map((s) => [s.salesId as string, s]));

  const errors: string[] = [];
  const seen = new Set<string>();
  const upserts: {
    date: string;
    staffId: string;
    agencyId: string;
    salesLabel: string;
    data: Record<string, string | number | null>;
  }[] = [];

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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${line}行目: 日付はYYYY-MM-DD形式で入力してください`);
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
        errors.push(`${line}行目: 「${headers[idx]}」は0以上の${integer ? "整数" : "数値"}で入力してください`);
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

  await prisma.$transaction(
    upserts.map((u) =>
      prisma.dailyReport.upsert({
        where: { date_type_salesStaffId: { date: u.date, type: csvType, salesStaffId: u.staffId } },
        create: { date: u.date, type: csvType, salesStaffId: u.staffId, agencyId: u.agencyId, ...u.data },
        update: { agencyId: u.agencyId, ...u.data },
      })
    )
  );

  await audit(user.loginId, "daily_report_csv_import", `${csvType} ${upserts.length}件`);
  revalidatePath("/reports");
  return { success: `${upserts.length}件の${csvType}日報を取り込みました（同一日付・タイプ・販売員IDは上書き）` };
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
  await audit(user.loginId, "daily_report_delete", `${report.date}/${report.type}/${report.salesStaffId}`);
  revalidatePath("/reports");
}

// ---------------------------------------------------------------------------
// タブ2: 稼働提出物（二段階承認 §6.4）
// ---------------------------------------------------------------------------

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
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (!["xlsx", "xls", "pdf", "png", "jpg", "jpeg", "zip"].includes(ext)) {
    return { error: "許可されていないファイル形式です（xlsx/xls/pdf/png/jpg/zip）" };
  }
  const stored = await storeFile(file, user.loginId);
  if ("error" in stored) return { error: stored.error };

  // 提出時ステータス（§6.4）:
  //  R8提出 → pending_first（1次店確認中）
  //  R7自身名義 or SNC → pending_snc（SNC確認中）
  //  R7が配下2次店名義で提出 → 二次代理店名義は一次承認を経るため pending_first
  let status: string;
  if (user.role === "R8") status = "pending_first";
  else if (user.role === "R7") {
    status = submitterAgencyId === user.agencyId ? "pending_snc" : "pending_first";
  } else status = "pending_snc";

  const sub = await prisma.submission.create({
    data: {
      kind,
      fiscalYear: fiscalYearOf(targetMonth),
      targetMonth,
      primaryAgencyId,
      submitterAgencyId,
      fileId: stored.id,
      fileName: stored.name,
      memo: str(formData.get("memo")),
      status,
      history: pushHistory([], "submitted", user.loginId) as never,
    },
  });

  await audit(user.loginId, "submission_create", `${kind} ${targetMonth} (${sub.id})`);
  if (status === "pending_first") {
    // 1次代理店管理者へ通知
    await notifyAgencyAccounts(
      primaryAgencyId,
      "稼働提出物が提出されました（1次承認待ち）",
      `${kind} / ${targetMonth} / ${agency.name}`,
      "/reports?tab=submissions"
    );
  } else {
    // SNC運用者（エリア営業）へ通知
    await notifyRole(["R3"], "稼働提出物が提出されました（SNC確認待ち）", `${kind} / ${targetMonth} / ${agency.name}`, "/reports?tab=submissions");
  }
  revalidatePath("/reports");
  return { success: `「${kind}」（${targetMonth}）を提出しました` };
}

// 1次承認（R7: pending_first → pending_snc）
export async function approveSubmissionFirst(formData: FormData): Promise<void> {
  const user = await requirePage("reports");
  if (user.dummy || user.role !== "R7") return;
  const id = String(formData.get("id") ?? "");
  const sub = await prisma.submission.findUnique({ where: { id }, include: { submitterAgency: true } });
  if (!sub || sub.status !== "pending_first") return;
  const scope = await agencyScope(user);
  if (scope && !scope.includes(sub.submitterAgencyId)) {
    await audit(user.loginId, "submission_approve_first", id, "denied");
    return;
  }
  await prisma.submission.update({
    where: { id },
    data: { status: "pending_snc", history: pushHistory(sub.history, "approve_first", user.loginId) as never },
  });
  await audit(user.loginId, "submission_approve_first", id);
  await notifyRole(["R3"], "稼働提出物が1次承認されました（SNC確認待ち）", `${sub.kind} / ${sub.targetMonth} / ${sub.submitterAgency.name}`, "/reports?tab=submissions");
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
    data: { status: "approved", history: pushHistory(sub.history, "final_approve", user.loginId) as never },
  });
  await audit(user.loginId, "submission_final_approve", id);
  await notifyAgencyAccounts(sub.submitterAgencyId, "稼働提出物が最終承認されました", `${sub.kind} / ${sub.targetMonth}`, "/reports?tab=submissions");
  if (sub.primaryAgencyId !== sub.submitterAgencyId) {
    await notifyAgencyAccounts(sub.primaryAgencyId, "配下代理店の稼働提出物が最終承認されました", `${sub.kind} / ${sub.targetMonth}`, "/reports?tab=submissions");
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
  await audit(user.loginId, "submission_reject", `${id} (${reason})`);
  await notifyAgencyAccounts(sub.submitterAgencyId, "稼働提出物が差戻しされました", `${sub.kind} / ${sub.targetMonth} / 理由: ${reason}`, "/reports?tab=submissions");
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
  await prisma.submission.delete({ where: { id } });
  await audit(user.loginId, "submission_delete", `${sub.kind} ${sub.targetMonth} (${id})`);
  revalidatePath("/reports");
}
