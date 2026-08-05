// 各種資料の提出 = 日報・稼働提出物（ページキー: "reports"、SPEC §7.5 / §7.6）

import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePage, agencyScope, type CurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  SNC_ADMIN_ROLES,
  SUBMISSION_KINDS,
  SUBMISSION_STATUS_LABELS,
  SUBMISSION_TEMPLATE_FILES,
} from "@/lib/roles";
import { can } from "@/lib/permissions";
import { formatHistory, today } from "@/lib/util";
import {
  Card,
  StatCard,
  Badge,
  StatusBadge,
  PageHeader,
  InfoBanner,
  EmptyState,
  SectionTitle,
  inputCls,
  labelCls,
  btnPrimary,
  btnOutline,
  btnDanger,
  btnSuccess,
  thCls,
  tdCls,
} from "@/components/ui";
import { calcSummaryKpi, calcVisitKpi, calcTeleKpi, monthRange, normalizeDate } from "./kpi";
import { DailyReportForm, type StaffOption } from "./daily-form";
import { CsvUpload } from "./csv-upload";
import { SubmissionForm, SubmissionReplaceForm, type AgencyOption } from "./submission-form";
import {
  approveSubmissionFirst,
  approveSubmissionFinal,
  rejectSubmission,
  deleteSubmission,
  deleteDailyReport,
} from "./actions";

const PAGE_SIZE = 50;
// SNC管理系ロールの集合は src/lib/roles.ts を唯一の情報源にする（§3.2）
const SNC_ADMIN: readonly string[] = SNC_ADMIN_ROLES;

type User = CurrentUser & { dummy: boolean };
type Params = Record<string, string>;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePage("reports");
  const sp = await searchParams;
  const p: Params = {};
  for (const [k, v] of Object.entries(sp)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) p[k] = s;
  }

  let tab = p.tab ?? "daily";
  if (!["daily", "submissions", "summary"].includes(tab)) tab = "daily";
  // R9（販売員）には稼働提出物タブを表示しない（§5.2）
  if (user.role === "R9" && tab === "submissions") tab = "daily";

  const scope = await agencyScope(user);

  const tabs = [
    { key: "daily", label: "稼働日報" },
    ...(user.role === "R9" ? [] : [{ key: "submissions", label: "稼働提出物" }]),
    { key: "summary", label: "集計・実績確認" },
  ];

  return (
    <div>
      <PageHeader title="日報・稼働提出物" />
      {/* セグメント型タブ: コンテナ内で選択タブのみ白く浮く */}
      <div className="mb-5 inline-flex rounded-xl bg-slate-200/70 p-1">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/reports?tab=${t.key}`}
            className={
              "rounded-lg px-4 py-1.5 text-sm transition " +
              (tab === t.key
                ? "bg-white font-semibold text-slate-800 shadow-sm"
                : "font-medium text-slate-500 hover:text-slate-700")
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "daily" && <DailyTab user={user} scope={scope} />}
      {tab === "submissions" && <SubmissionsTab user={user} scope={scope} p={p} />}
      {tab === "summary" && <SummaryTab user={user} scope={scope} p={p} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// タブ1: 稼働日報（スマホ最適化対象）
// ---------------------------------------------------------------------------

async function DailyTab({ user, scope }: { user: User; scope: string[] | null }) {
  let fixedStaff: StaffOption | null = null;
  let staffOptions: StaffOption[] = [];

  if (user.role === "R9") {
    const staff = await prisma.salesStaff.findUnique({
      where: { accountId: user.id },
      include: { agency: true },
    });
    if (staff) {
      fixedStaff = {
        id: staff.id,
        label: `${staff.salesId ?? "-"} ${staff.lastName}${staff.firstName}`,
        agencyName: staff.agency.name,
      };
    }
  } else {
    // TODO: 販売員が数百名を超える場合は検索付きセレクトに改善する（速度優先の割り切り）
    const staffList = await prisma.salesStaff.findMany({
      where: {
        ...(scope ? { agencyId: { in: scope } } : {}),
        salesId: { not: null },
        status: { in: ["provisional", "registered"] },
      },
      include: { agency: true },
      orderBy: { salesId: "asc" },
      take: 500,
    });
    staffOptions = staffList.map((s) => ({
      id: s.id,
      label: `${s.salesId} ${s.lastName}${s.firstName}`,
      agencyName: s.agency.name,
    }));
  }

  // 月初見込の初回のみ入力制御用（要件6-3 / BUG-007）:
  // 「販売員ID:タイプ:月:フィールド」→ 見込が最初に入ったレコードの日付。
  // フォーム側で該当月の見込フィールドをdisabledにする（確定判定はサーバ側でも行う）。
  const forecastHolders: Record<string, string> = {};
  const staffIds = fixedStaff ? [fixedStaff.id] : staffOptions.map((s) => s.id);

  // 提出済み日報の既存値プリフィル用（検収指摘 問題一覧No.1 / D-011）:
  // 「販売員ID|日付|タイプ」→ 既存レコードの値。フォームで同じ組み合わせを選ぶと
  // 既存値が読み込まれ、未変更の項目が0/空欄で上書きされる事故を防ぐ。
  // 取得範囲は **直近92日分**（最大500名×20列がRSCペイロードでクライアントへ転送されるため、
  // 範囲を広げると稼働日報タブの初期表示が肥大化する）。
  // 範囲外の過去日を編集する場合も、server action 側が「既存値を読み込んでいない送信では
  // 空欄を更新対象から外す」（prefilled / dropNulls）ため実績が消えることはない。
  const existingReports: Record<string, Record<string, number | string | null>> = {};
  if (!user.dummy && staffIds.length > 0) {
    const sinceBase = new Date(`${today()}T00:00:00Z`);
    sinceBase.setUTCDate(sinceBase.getUTCDate() - 92);
    const since = sinceBase.toISOString().slice(0, 10);
    const recent = await prisma.dailyReport.findMany({
      where: { salesStaffId: { in: staffIds }, date: { gte: since } },
      select: {
        salesStaffId: true,
        date: true,
        type: true,
        area: true,
        forecastAcq: true,
        acquisitions: true,
        workers: true,
        visits: true,
        meetings: true,
        negotiations: true,
        contracts: true,
        forecastHours: true,
        forecastEntries: true,
        actualHours: true,
        entries: true,
        appointments: true,
        closePassed: true,
        preConfirmPassed: true,
        activityContent: true,
        activityResult: true,
        notes: true,
      },
    });
    for (const r of recent) {
      const { salesStaffId, date, type, ...values } = r;
      existingReports[`${salesStaffId}|${date}|${type}`] = values;
    }
  }
  if (!user.dummy && staffIds.length > 0) {
    const forecastReports = await prisma.dailyReport.findMany({
      where: {
        salesStaffId: { in: staffIds },
        OR: [
          { forecastAcq: { not: null } },
          { forecastHours: { not: null } },
          { forecastEntries: { not: null } },
        ],
      },
      select: {
        salesStaffId: true,
        date: true,
        type: true,
        forecastAcq: true,
        forecastHours: true,
        forecastEntries: true,
      },
      orderBy: { date: "asc" },
    });
    for (const r of forecastReports) {
      const m = r.date.slice(0, 7);
      for (const f of ["forecastAcq", "forecastHours", "forecastEntries"] as const) {
        if (r[f] == null) continue;
        const key = `${r.salesStaffId}:${r.type}:${m}:${f}`;
        if (!(key in forecastHolders)) forecastHolders[key] = r.date; // date昇順→最初のみ採用
      }
    }
  }

  // 当月KPIタイル（§7.5「自動計算KPI（日報Excelの「自動→」行を再現。**一覧・集計画面に表示**）」）。
  // 保存後のフォーム応答だけでなく、タブを開いた時点で当月の値を表示する。
  // 集計対象は参照可能な日報（⑨は自分のみ / それ以外はスコープ内）。SNC閲覧アカウントはダミー代理店。
  const kpiMonth = today().slice(0, 7);
  // KPI計算に必要な数値項目だけを取得する（本文列 activityContent / notes 等は不要）
  const kpiReports =
    staffIds.length > 0
      ? await prisma.dailyReport.findMany({
          where: { salesStaffId: { in: staffIds }, date: { startsWith: kpiMonth } },
          select: {
            date: true,
            type: true,
            forecastAcq: true,
            acquisitions: true,
            workers: true,
            visits: true,
            meetings: true,
            negotiations: true,
            contracts: true,
            forecastHours: true,
            forecastEntries: true,
            actualHours: true,
            entries: true,
            appointments: true,
            closePassed: true,
            preConfirmPassed: true,
          },
        })
      : [];
  const visitKpi = calcVisitKpi(
    kpiReports.filter((r) => r.type === "訪販"),
    today()
  );
  const teleKpi = calcTeleKpi(kpiReports.filter((r) => r.type === "テレマ"));
  // 集計範囲をタイトルに出す。保存後に表示される「当月KPI（月 / タイプ）」は
  // **提出した販売員1名分** なので、同じ画面に範囲の違う2枚が並んでも誤読されないようにする。
  const kpiScopeLabel =
    user.role === "R9"
      ? "自分"
      : fixedStaff
        ? fixedStaff.label
        : `参照可能な販売員${staffIds.length}名の合計`;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <InfoBanner>
        稼働日報を提出します。同じ日付・タイプ・販売員IDの日報は再提出時に上書きされます。
        {user.dummy && "（SNC閲覧アカウントは閲覧専用のため提出できません）"}
      </InfoBanner>

      {/* 当月KPI（§7.5）。日報が1件も無い月は全タイル0表示になる（分母0は「0」表示） */}
      <Card className="mb-5" data-testid="kpi-current-month">
        <SectionTitle>{`当月KPI（${kpiMonth} / ${kpiScopeLabel}）`}</SectionTitle>
        <p className="mb-2 text-xs font-semibold text-slate-500">訪販</p>
        <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {visitKpi.map((k) => (
            <div key={k.label} className="rounded-xl bg-slate-50 p-2 text-center">
              <div className="text-base font-semibold text-slate-800">{k.value}</div>
              <div className="text-[11px] text-slate-500">{k.label}</div>
            </div>
          ))}
        </div>
        <p className="mb-2 text-xs font-semibold text-slate-500">テレマ</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          {teleKpi.map((k) => (
            <div key={k.label} className="rounded-xl bg-slate-50 p-2 text-center">
              <div className="text-base font-semibold text-slate-800">{k.value}</div>
              <div className="text-[11px] text-slate-500">{k.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          {user.role === "R9"
            ? "※自分の当月日報を集計しています。計算式は稼働日報Excel原本準拠です。"
            : "※参照可能な販売員の当月日報を集計しています。計算式は稼働日報Excel原本準拠です。"}
        </p>
      </Card>

      {!user.dummy && (
        <Card className="mb-5">
          <SectionTitle>日報入力</SectionTitle>
          {user.role === "R9" && !fixedStaff ? (
            <EmptyState message="あなたの販売員情報が見つかりません。管理者にお問い合わせください。" />
          ) : user.role !== "R9" && staffOptions.length === 0 ? (
            <EmptyState message="選択可能な販売員がいません。販売員IDの登録後に提出できます。" />
          ) : (
            <DailyReportForm
              staffOptions={staffOptions}
              fixedStaff={fixedStaff}
              defaultDate={today()}
              forecastHolders={forecastHolders}
              existing={existingReports}
            />
          )}
        </Card>
      )}

      <Card>
        <SectionTitle>CSVで一括提出</SectionTitle>
        <div className="mb-3 flex flex-wrap gap-2">
          <a href="/reports/csv?template=visit" className={btnOutline}>
            訪販日報CSVテンプレート
          </a>
          <a href="/reports/csv?template=tele" className={btnOutline}>
            テレマ日報CSVテンプレート
          </a>
        </div>
        {user.dummy ? (
          <p className="text-sm text-slate-400">
            閲覧専用アカウントのためCSVアップロードは利用できません。
          </p>
        ) : (
          <CsvUpload />
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// タブ2: 稼働提出物（R9非表示・R4はダミー閲覧のみ）
// ---------------------------------------------------------------------------

async function SubmissionsTab({
  user,
  scope,
  p,
}: {
  user: User;
  scope: string[] | null;
  p: Params;
}) {
  const currentMonth = today().slice(0, 7);
  const isSncAdmin = SNC_ADMIN.includes(user.role);

  // 提出フォームの提出元代理店の選択肢
  let fixedAgency: AgencyOption | null = null;
  let agencyOptions: AgencyOption[] = [];
  if (!user.dummy) {
    if (user.role === "R8" && user.agencyId) {
      fixedAgency = { id: user.agencyId, label: user.agencyName ?? "-" };
    } else if (user.role === "R7" && user.agencyId) {
      const list = await prisma.agency.findMany({
        where: { OR: [{ id: user.agencyId }, { parentId: user.agencyId }] },
        orderBy: [{ tier: "asc" }, { code: "asc" }],
      });
      agencyOptions = list.map((a) => ({
        id: a.id,
        label: `${a.name}（${a.code}）${a.id === user.agencyId ? " ※自店名義" : ""}`,
      }));
    } else if (isSncAdmin) {
      const list = await prisma.agency.findMany({
        where: { isDummy: false },
        orderBy: [{ tier: "asc" }, { code: "asc" }],
        take: 300,
      });
      agencyOptions = list.map((a) => ({ id: a.id, label: `${a.name}（${a.code}）` }));
    }
  }

  // 提出状況（scope内の二次代理店 × 対象月で n/6）
  const statusMonth = /^\d{4}-\d{2}$/.test(p.month ?? "") ? p.month : currentMonth;
  const secondaries = await prisma.agency.findMany({
    where: { tier: 2, ...(scope ? { id: { in: scope } } : { isDummy: false }) },
    orderBy: { code: "asc" },
    take: 50, // TODO: 二次代理店が50店超の場合のページネーションは未実装（速度優先）
  });
  const monthSubs = await prisma.submission.findMany({
    where: {
      targetMonth: statusMonth,
      submitterAgencyId: { in: secondaries.map((s) => s.id) },
      status: { not: "rejected" },
    },
    select: { submitterAgencyId: true, kind: true },
  });
  const kindsByAgency = new Map<string, Set<string>>();
  for (const s of monthSubs) {
    if (!kindsByAgency.has(s.submitterAgencyId)) kindsByAgency.set(s.submitterAgencyId, new Set());
    kindsByAgency.get(s.submitterAgencyId)!.add(s.kind);
  }

  // 提出物一覧フィルタ用: スコープ内の1次代理店（§7.6。2次代理店は提出状況の secondaries を流用）
  const primaries = await prisma.agency.findMany({
    where: { tier: 1, ...(scope ? { id: { in: scope } } : { isDummy: false }) },
    orderBy: { code: "asc" },
    take: 300,
  });

  // 提出物一覧（フィルタ + 50件/頁）
  const page = Math.max(1, Number(p.page ?? "1") || 1);
  const q = p.q ?? "";
  const kindFilter = p.kind ?? "";
  const fyFilter = p.fy ?? "";
  const fmonthFilter = p.fmonth ?? "";
  // 1次/2次代理店フィルタ（§7.6）。クライアント由来IDはスコープ内の選択肢に含まれるもののみ有効
  let paFilter = p.pa ?? "";
  let saFilter = p.sa ?? "";
  if (paFilter && !primaries.some((a) => a.id === paFilter)) paFilter = "";
  if (saFilter && !secondaries.some((a) => a.id === saFilter)) saFilter = "";
  const where: Prisma.SubmissionWhereInput = {
    ...(scope ? { submitterAgencyId: { in: scope } } : {}),
    ...(kindFilter ? { kind: kindFilter } : {}),
    ...(fyFilter ? { fiscalYear: Number(fyFilter) } : {}),
    ...(fmonthFilter ? { targetMonth: fmonthFilter } : {}),
    ...(paFilter ? { primaryAgencyId: paFilter } : {}),
    // saFilter はスコープ検証済みのため、scope の in 条件より狭い絞り込みとして上書きしてよい
    ...(saFilter ? { submitterAgencyId: saFilter } : {}),
    ...(q
      ? {
          OR: [
            { fileName: { contains: q } },
            { memo: { contains: q } },
            { submitterAgency: { name: { contains: q } } },
          ],
        }
      : {}),
  };
  const [total, submissions, fiscalYears] = await Promise.all([
    prisma.submission.count({ where }),
    prisma.submission.findMany({
      where,
      include: { submitterAgency: true, primaryAgency: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.submission.findMany({
      where: scope ? { submitterAgencyId: { in: scope } } : {},
      select: { fiscalYear: true },
      distinct: ["fiscalYear"],
      orderBy: { fiscalYear: "desc" },
    }),
  ]);

  const canDelete = (submitterAgencyId: string) =>
    !user.dummy &&
    (isSncAdmin ||
      ((user.role === "R7" || user.role === "R8") && !!scope && scope.includes(submitterAgencyId)));

  // 差し替え（§5.1 稼働提出物「変」= ①②③⑦⑧。⑦⑧は自店スコープ内。判定は permissions.can §3.2）
  const canReplace = (submitterAgencyId: string) =>
    !user.dummy &&
    can(user.role, "submission", "update") &&
    (!scope || scope.includes(submitterAgencyId));

  const baseParams: Params = { tab: "submissions" };
  if (statusMonth !== currentMonth) baseParams.month = statusMonth!;
  if (q) baseParams.q = q;
  if (kindFilter) baseParams.kind = kindFilter;
  if (fyFilter) baseParams.fy = fyFilter;
  if (fmonthFilter) baseParams.fmonth = fmonthFilter;
  if (paFilter) baseParams.pa = paFilter;
  if (saFilter) baseParams.sa = saFilter;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="blue">二段階承認</Badge>
        <span className="text-sm text-slate-600">
          二次代理店名義は一次承認後、一次代理店自身名義は直接SNCへ提出します。
        </span>
      </div>
      {user.dummy && <InfoBanner>SNC閲覧アカウントは閲覧専用です（ダミーデータ表示）。</InfoBanner>}

      <Card className="mb-5">
        <SectionTitle>提出用テンプレート（様式ダウンロード）</SectionTitle>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {SUBMISSION_KINDS.map((k) => (
            <a
              key={k}
              // ファイル名は様式名からの明示的な対応表で解決する（添字計算によるずれ防止 §7.6）
              href={`/templates/${SUBMISSION_TEMPLATE_FILES[k]}`}
              download={`${k}.xlsx`}
              className={btnOutline + " justify-start"}
            >
              {k}
            </a>
          ))}
        </div>
      </Card>

      {!user.dummy && user.role !== "R9" && (
        <Card className="mb-5">
          <SectionTitle>提出フォーム</SectionTitle>
          <SubmissionForm
            kinds={SUBMISSION_KINDS}
            agencyOptions={agencyOptions}
            fixedAgency={fixedAgency}
            defaultMonth={currentMonth}
          />
        </Card>
      )}

      <Card className="mb-5">
        <SectionTitle
          right={
            <form className="flex items-center gap-2">
              <input type="hidden" name="tab" value="submissions" />
              <input
                type="month"
                name="month"
                defaultValue={statusMonth}
                className={inputCls + " w-40"}
              />
              <button className={btnOutline}>表示</button>
            </form>
          }
        >
          提出状況（二次代理店 × {statusMonth}）
        </SectionTitle>
        {secondaries.length === 0 ? (
          <EmptyState message="対象の二次代理店がありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={thCls}>二次代理店</th>
                  <th className={thCls}>提出状況</th>
                  <th className={thCls}>未提出様式</th>
                </tr>
              </thead>
              <tbody>
                {secondaries.map((a) => {
                  const done = kindsByAgency.get(a.id) ?? new Set<string>();
                  const missing = SUBMISSION_KINDS.filter((k) => !done.has(k));
                  return (
                    <tr key={a.id}>
                      <td className={tdCls}>
                        <div className="font-medium text-slate-800">{a.name}</div>
                        <div className="text-xs text-slate-400">{a.code}</div>
                      </td>
                      <td className={tdCls}>
                        <Badge
                          tone={done.size === 6 ? "green" : done.size === 0 ? "gray" : "yellow"}
                        >
                          {done.size} / 6
                        </Badge>
                      </td>
                      <td className={tdCls}>
                        <span className="text-xs text-slate-500">
                          {missing.length === 0 ? "―" : missing.join(" / ")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>提出物一覧</SectionTitle>
        <form className="mb-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="submissions" />
          <div>
            <label className={labelCls}>検索</label>
            <input
              name="q"
              defaultValue={q}
              placeholder="代理店名・ファイル名・メモ"
              className={inputCls + " w-56"}
            />
          </div>
          <div>
            <label className={labelCls}>種別</label>
            <select name="kind" defaultValue={kindFilter} className={inputCls + " w-64"}>
              <option value="">すべて</option>
              {SUBMISSION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>1次代理店</label>
            <select name="pa" defaultValue={paFilter} className={inputCls + " w-48"}>
              <option value="">すべて</option>
              {primaries.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>2次代理店</label>
            <select name="sa" defaultValue={saFilter} className={inputCls + " w-48"}>
              <option value="">すべて</option>
              {secondaries.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>年度</label>
            <select name="fy" defaultValue={fyFilter} className={inputCls + " w-32"}>
              <option value="">すべて</option>
              {fiscalYears.map((f) => (
                <option key={f.fiscalYear} value={f.fiscalYear}>
                  {f.fiscalYear}年度
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>対象月</label>
            <input
              type="month"
              name="fmonth"
              defaultValue={fmonthFilter}
              className={inputCls + " w-40"}
            />
          </div>
          <button className={btnOutline}>絞り込み</button>
        </form>

        {submissions.length === 0 ? (
          <EmptyState message="提出物がありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={thCls}>種別</th>
                  <th className={thCls}>対象月 / 年度</th>
                  <th className={thCls}>提出元</th>
                  <th className={thCls}>ファイル</th>
                  <th className={thCls}>状態</th>
                  <th className={thCls}>履歴</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id}>
                    <td className={tdCls}>
                      <div className="font-medium text-slate-800">{s.kind}</div>
                      {s.memo && <div className="text-xs text-slate-400">{s.memo}</div>}
                    </td>
                    <td className={tdCls}>
                      {s.targetMonth}
                      <div className="text-xs text-slate-400">{s.fiscalYear}年度</div>
                    </td>
                    <td className={tdCls}>
                      <div>{s.submitterAgency.name}</div>
                      <div className="text-xs text-slate-400">一次: {s.primaryAgency.name}</div>
                    </td>
                    <td className={tdCls}>
                      <a href={`/files/${s.fileId}`} className="text-blue-600 hover:underline">
                        {s.fileName}
                      </a>
                    </td>
                    <td className={tdCls}>
                      <StatusBadge label={SUBMISSION_STATUS_LABELS[s.status] ?? s.status} />
                      {s.status === "rejected" && s.rejectReason && (
                        <div className="mt-1 text-xs text-red-500">理由: {s.rejectReason}</div>
                      )}
                    </td>
                    <td className={tdCls}>
                      <span className="text-xs text-slate-400">{formatHistory(s.history)}</span>
                    </td>
                    <td className={tdCls}>
                      {!user.dummy && (
                        <div className="flex flex-col items-start gap-1.5">
                          {user.role === "R7" && s.status === "pending_first" && (
                            <form action={approveSubmissionFirst}>
                              <input type="hidden" name="id" value={s.id} />
                              <button className={btnSuccess}>1次承認</button>
                            </form>
                          )}
                          {isSncAdmin && s.status === "pending_snc" && (
                            <form action={approveSubmissionFinal}>
                              <input type="hidden" name="id" value={s.id} />
                              <button className={btnSuccess}>最終承認</button>
                            </form>
                          )}
                          {((user.role === "R7" && s.status === "pending_first") ||
                            (isSncAdmin &&
                              (s.status === "pending_first" || s.status === "pending_snc"))) && (
                            <form action={rejectSubmission} className="flex items-center gap-1">
                              <input type="hidden" name="id" value={s.id} />
                              <input
                                name="reason"
                                placeholder="差戻し理由"
                                className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-xs"
                              />
                              <button className={btnDanger}>差戻し</button>
                            </form>
                          )}
                          {/* 差し替え（§5.1「変」）: ファイルを差し替えると承認ステータスが提出直後へ戻る（§6.4） */}
                          {canReplace(s.submitterAgencyId) && (
                            <SubmissionReplaceForm submissionId={s.id} />
                          )}
                          {canDelete(s.submitterAgencyId) && (
                            <form action={deleteSubmission}>
                              <input type="hidden" name="id" value={s.id} />
                              <button className={btnOutline + " !text-red-600"}>削除</button>
                            </form>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={total} params={baseParams} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// タブ3: 集計・実績確認
// ---------------------------------------------------------------------------

async function SummaryTab({ user, scope, p }: { user: User; scope: string[] | null; p: Params }) {
  // 期間フィルタの既定値は当月（§7.5 集計・実績確認）
  const defaultRange = monthRange(today().slice(0, 7));

  // ⑨（販売員）は §5.1 で日報の「閲」を持たない（「提（自己修正可）」のみ）ため、集計対象は自分の日報だけ
  // に固定する（販売員フィルタは自分固定。§7.5 / S5-040）。ロール直書きせず can() で判定する（§3.2）。
  // ④（SNC閲覧）はダミー代理店のデータ閲覧で販売員に紐づかないため、この固定の対象外（§3.5）。
  const ownReportsOnly = !user.dummy && !can(user.role, "daily-report", "view");
  let ownStaff: { id: string; label: string } | null = null;
  if (ownReportsOnly) {
    const staff = await prisma.salesStaff.findUnique({ where: { accountId: user.id } });
    if (staff)
      ownStaff = {
        id: staff.id,
        label: `${staff.salesId ?? "-"} ${staff.lastName}${staff.firstName}`,
      };
  }

  // ---- フィルタ（期間・代理店・販売員。S5-038 / S5-039 / S5-040）----
  // UI（選択肢）で絞るだけでなく、ここ（サーバ側の描画）でも値を再検証する（§3.2 認可は両層で）。
  // 不正な日付・スコープ外のIDは無視し、既定（当月・スコープ全体）へフォールバックする。
  const from = normalizeDate(p.from) ?? defaultRange.from;
  const to = normalizeDate(p.to) ?? defaultRange.to;

  // 代理店フィルタの選択肢はデータスコープ内のみ（§3.1 agencyScope）
  const agencies = await prisma.agency.findMany({
    where: scope ? { id: { in: scope } } : { isDummy: false },
    orderBy: [{ tier: "asc" }, { code: "asc" }],
    take: 300,
  });
  let agencyFilter = p.agency ?? "";
  if (agencyFilter && !agencies.some((a) => a.id === agencyFilter)) agencyFilter = "";

  // 販売員フィルタの選択肢もスコープ内（代理店フィルタ選択時はさらにその代理店内）に限定する。
  // 過去に稼働していた販売員の日報も集計対象になるためステータスでは絞らない（販売員IDありのみ）。
  const staffList = ownReportsOnly
    ? []
    : await prisma.salesStaff.findMany({
        where: {
          ...(scope ? { agencyId: { in: scope } } : {}),
          ...(agencyFilter ? { agencyId: agencyFilter } : {}),
          salesId: { not: null },
        },
        include: { agency: true },
        orderBy: { salesId: "asc" },
        take: 500, // TODO: 販売員が500名を超える場合は検索付きセレクトに改善する（速度優先の割り切り）
      });
  let staffFilter = ownReportsOnly ? "" : (p.staff ?? "");
  if (staffFilter && !staffList.some((s) => s.id === staffFilter)) staffFilter = "";

  const reportWhere: Prisma.DailyReportWhereInput = {
    ...(scope ? { agencyId: { in: scope } } : {}),
    // agencyFilter はスコープ内の選択肢であることを検証済みのため、scope の in 条件より狭い絞り込みとして上書きしてよい
    ...(agencyFilter ? { agencyId: agencyFilter } : {}),
    ...(ownReportsOnly
      ? { salesStaffId: ownStaff?.id ?? "__none__" }
      : staffFilter
        ? { salesStaffId: staffFilter }
        : {}),
    // date は YYYY-MM-DD の文字列カラムのため辞書順比較で期間指定できる
    date: { gte: from, lte: to },
  };

  // 稼働提出物の対象月（YYYY-MM）は期間の開始月〜終了月で絞る（§7.6）
  const subWhere: Prisma.SubmissionWhereInput = {
    targetMonth: { gte: from.slice(0, 7), lte: to.slice(0, 7) },
    ...(scope ? { submitterAgencyId: { in: scope } } : {}),
    ...(agencyFilter ? { submitterAgencyId: agencyFilter } : {}),
  };
  // ⑨は稼働提出物の権限が無いため0扱い（§5.2）。④はダミーデータの閲覧を続ける（§3.5）。
  const canViewSubmissions = user.dummy || can(user.role, "submission", "view");

  // 日報レコードリストは50件/頁。KPIカードと同一のフィルタ条件で集計するため件数は共用する。
  const page = Math.max(1, Number(p.page ?? "1") || 1);
  const [reportCount, agg, subCount, approvedCount, records] = await Promise.all([
    prisma.dailyReport.count({ where: reportWhere }),
    prisma.dailyReport.aggregate({
      where: reportWhere,
      _sum: {
        acquisitions: true,
        workers: true,
        negotiations: true,
        contracts: true,
        closePassed: true,
      },
    }),
    canViewSubmissions ? prisma.submission.count({ where: subWhere }) : Promise.resolve(0),
    canViewSubmissions
      ? prisma.submission.count({ where: { ...subWhere, status: "approved" } })
      : Promise.resolve(0),
    prisma.dailyReport.findMany({
      where: reportWhere,
      include: { salesStaff: true, agency: true },
      orderBy: [{ date: "desc" }, { updatedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
  ]);

  // KPIカード6枚の計算は純粋関数へ集約（分母0は「0」表示 §7.5。tests/unit/kpi.test.ts で検証）
  const kpi = calcSummaryKpi({
    reportCount,
    acquisitions: agg._sum.acquisitions ?? 0,
    closePassed: agg._sum.closePassed ?? 0,
    workers: agg._sum.workers ?? 0,
    negotiations: agg._sum.negotiations ?? 0,
    contracts: agg._sum.contracts ?? 0,
    submissionCount: subCount,
    approvedCount,
  });

  // 削除は権限保有者のみ（§7.5。§5.1 日報提出「削」= ①②③⑦⑧。スコープは reportWhere で担保）
  const canDeleteDaily = !user.dummy && can(user.role, "daily-report", "delete");

  // ページ送りでフィルタ条件を維持する（S5-038〜040）
  const baseParams: Params = { tab: "summary", from, to };
  if (agencyFilter) baseParams.agency = agencyFilter;
  if (staffFilter) baseParams.staff = staffFilter;

  return (
    <div>
      <InfoBanner>日報と提出物の集計です。CSV由来／入力由来の指標を確認できます。</InfoBanner>

      <Card className="mb-5">
        <SectionTitle>絞り込み</SectionTitle>
        <form method="get" action="/reports" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value="summary" />
          <div>
            <label className={labelCls}>開始日</label>
            <input type="date" name="from" defaultValue={from} className={inputCls + " w-40"} />
          </div>
          <div>
            <label className={labelCls}>終了日</label>
            <input type="date" name="to" defaultValue={to} className={inputCls + " w-40"} />
          </div>
          <div>
            <label className={labelCls}>代理店</label>
            <select name="agency" defaultValue={agencyFilter} className={inputCls + " w-56"}>
              <option value="">すべて</option>
              {agencies.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}（{a.code}）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>販売員</label>
            {ownReportsOnly ? (
              // ⑨は自分固定（§7.5）。値を送信させないため name を付けず、表示のみ行う
              <input
                defaultValue={ownStaff ? ownStaff.label : "-"}
                disabled
                className={inputCls + " w-56"}
              />
            ) : (
              <select name="staff" defaultValue={staffFilter} className={inputCls + " w-56"}>
                <option value="">すべて</option>
                {staffList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.salesId} {s.lastName}
                    {s.firstName}（{s.agency.name}）
                  </option>
                ))}
              </select>
            )}
          </div>
          <button className={btnPrimary}>絞り込み</button>
        </form>
        {ownReportsOnly && (
          <p className="mt-2 text-xs text-slate-400">
            ※販売員は自分固定です（自分の日報のみ集計されます）。
          </p>
        )}
      </Card>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard value={kpi.reportCount} label="日報件数" tone="blue" />
        <StatCard value={kpi.results} label="獲得/成果数" tone="green" />
        <StatCard value={kpi.productivity} label="生産性" tone="purple" />
        <StatCard value={kpi.closeRate} label="成約率" tone="orange" />
        <StatCard value={kpi.submissionCount} label="提出物" tone="blue" />
        <StatCard value={kpi.approvedCount} label="最終承認済み" tone="green" />
      </div>
      <p className="-mt-3 mb-4 text-xs text-slate-400">
        ※スコープ内・{from} 〜 {to} の集計です。
      </p>

      <Card>
        <SectionTitle>日報レコード</SectionTitle>
        {records.length === 0 ? (
          <EmptyState message="日報がありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className={thCls}>日付</th>
                  <th className={thCls}>種別</th>
                  <th className={thCls}>販売員ID</th>
                  <th className={thCls}>提出元</th>
                  <th className={thCls}>獲得</th>
                  <th className={thCls}>更新</th>
                  {canDeleteDaily && <th className={thCls}>操作</th>}
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td className={tdCls}>{r.date}</td>
                    <td className={tdCls}>
                      <Badge tone={r.type === "訪販" ? "blue" : "yellow"}>{r.type}</Badge>
                    </td>
                    <td className={tdCls}>
                      <div>{r.salesStaff.salesId ?? "-"}</div>
                      <div className="text-xs text-slate-400">
                        {r.salesStaff.lastName}
                        {r.salesStaff.firstName} / {r.agency.name}
                      </div>
                    </td>
                    <td className={tdCls}>
                      <Badge tone={r.source === "csv" ? "yellow" : "gray"}>
                        {r.source === "csv" ? "CSV" : "フォーム"}
                      </Badge>
                    </td>
                    <td className={tdCls}>
                      {r.type === "訪販" ? (r.acquisitions ?? 0) : (r.closePassed ?? 0)}
                    </td>
                    <td className={tdCls}>
                      <span className="text-xs text-slate-400">
                        {r.updatedAt.toISOString().slice(0, 10)}
                      </span>
                    </td>
                    {canDeleteDaily && (
                      <td className={tdCls}>
                        <form action={deleteDailyReport}>
                          <input type="hidden" name="id" value={r.id} />
                          <button className={btnDanger}>削除</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pager page={page} total={reportCount} params={baseParams} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ページネーション（50件/頁 + 件数表示 §11.3）
// ---------------------------------------------------------------------------

function Pager({ page, total, params }: { page: number; total: number; params: Params }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const qs = (n: number) =>
    "/reports?" + new URLSearchParams({ ...params, page: String(n) }).toString();
  return (
    <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
      <span>
        全{total}件（{page} / {pages}ページ）
      </span>
      <div className="flex gap-2">
        {page > 1 && (
          <Link href={qs(page - 1)} className={btnOutline}>
            前へ
          </Link>
        )}
        {page < pages && (
          <Link href={qs(page + 1)} className={btnOutline}>
            次へ
          </Link>
        )}
      </div>
    </div>
  );
}
