import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { requirePage, agencyScope } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { STAFF_STATUS_LABELS } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import { audit, formatHistory } from "@/lib/util";
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
  btnOutline,
  btnPrimary,
  btnSuccess,
  btnDanger,
  thCls,
  tdCls,
} from "@/components/ui";
import { ApplyForm, type StaffOption } from "./apply-form";
import { CsvBulkForm } from "./csv-bulk-form";
import { FieldApplicationEditForm, type EditTarget } from "./edit-form";
import {
  firstApproveAction,
  finalApproveAction,
  suspendAction,
  resumeAction,
  removeAction,
  restoreAction,
  updateSncFieldsAction,
} from "./actions";

const PAGE_SIZE = 50;

const STATUS_OPTIONS = ["applying", "provisional", "registered", "suspended", "deleted"];

// 訪販員申請の登録後にのみ訪販員申請ができる販売員IDの状態（§6.3-1）
const APPLICABLE_STAFF_STATUS = ["provisional", "registered"];

function fmtJst(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// 訪販員申請状態（§7.4 一覧「訪販員申請状態（未申請・申請中・稼働・抹消）」）。
// §4.1 のDBステータス（申請中/仮登録/本登録/停止中/削除済）を一覧表示用の4値へ写す。
// 「未申請」はステータス値ではなく **申請レコードが無い** ことを表す表示上の状態（§4.1 / R-018）。
type FieldAgentState = "未申請" | "申請中" | "稼働" | "抹消";

function fieldAgentState(app: {
  status: string;
  applicationType: string;
  workMonth: string | null;
}): FieldAgentState {
  // 抹消申請の最終承認で当該登録は削除済へ遷移する（§4.1）→ 表示は「抹消」
  if (app.status === "deleted") return "抹消";
  if (app.status === "registered") return app.applicationType === "抹消" ? "抹消" : "稼働";
  // 停止中は4値に無いため、稼働月の有無で「稼働（停止中）」か「申請中（停止中）」に寄せ、
  // §4.1 のステータスを併記して停止中であることを示す。
  if (app.status === "suspended") return app.workMonth ? "稼働" : "申請中";
  return "申請中"; // applying（申請中）/ provisional（仮登録）はどちらも申請中
}

export default async function FieldAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const user = await requirePage("field-agents");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const agencyFilter = typeof sp.agency === "string" ? sp.agency : "";
  const statusFilter =
    typeof sp.status === "string" && STATUS_OPTIONS.includes(sp.status) ? sp.status : "";
  const page = Math.max(1, Number(sp.page) || 1);
  const editId = typeof sp.edit === "string" ? sp.edit : "";
  // 行内「訪販申請」ボタン（S4-025）から渡される販売員ID（申請フォームの初期選択）
  const applyStaffId = typeof sp.apply === "string" ? sp.apply : "";

  const scope = await agencyScope(user); // null=全代理店（SNC系）/ 配列=そのIDのみ
  // 権限判定は §5.1 の宣言的マップ（permissions.ts）だけを情報源とする（§3.2）。
  // SNC限定項目（ブラックリスト欄・SNC用メモ §7.4）の表示可否は「最終承認＝①②③」から導出する。
  const isSnc = can(user.role, "field-agent", "approve_final");
  // ブラックリスト欄の表示は監査ログ必須記録（§3.3）
  if (isSnc) {
    await audit(user.loginId, "view_blacklist_column", `role=${user.role} page=field-agents`);
  }
  const canApply = !user.dummy && can(user.role, "field-agent", "apply");
  const canFirstApprove = !user.dummy && canApproveFirst(user.role, "field-agent");
  const canFinalApprove = !user.dummy && can(user.role, "field-agent", "approve_final");
  const canSuspend = !user.dummy && can(user.role, "field-agent", "suspend");
  const canDelete = !user.dummy && can(user.role, "field-agent", "delete");
  // 業務項目の変更（§5.1 訪販員申請「変」= ①②③⑦）
  const canUpdate = !user.dummy && can(user.role, "field-agent", "update");

  // スコープ条件（SNC全域参照時はダミー代理店データを除外）
  const scopeStaffCond: Prisma.SalesStaffWhereInput =
    scope === null ? { agency: { isDummy: false } } : { agencyId: { in: scope } };
  // 代理店フィルタはスコープ内のみ有効（クライアント由来IDを信用しない §3.1）
  const listStaffCond: Prisma.SalesStaffWhereInput = agencyFilter
    ? scope === null || scope.includes(agencyFilter)
      ? { agencyId: agencyFilter }
      : { agencyId: { in: [] } }
    : scopeStaffCond;

  const where: Prisma.FieldAgentApplicationWhereInput = {
    AND: [
      { salesStaff: { is: listStaffCond } },
      ...(statusFilter ? [{ status: statusFilter }] : []),
      ...(q
        ? [
            {
              OR: [
                { lastNameKana: { contains: q } },
                { firstNameKana: { contains: q } },
                { pledgeNo: { contains: q } },
                { salesStaff: { is: { salesId: { contains: q } } } },
                { salesStaff: { is: { lastName: { contains: q } } } },
                { salesStaff: { is: { firstName: { contains: q } } } },
              ],
            },
          ]
        : []),
    ],
  };

  // 「未申請」行（§7.4 / §4.1 / R-018）: 訪販員申請レコードを1件も持たない販売員。
  // 申請ステータスでの絞り込み時は該当しないため対象外にする（未申請はステータス値ではない）。
  const includeUnapplied = !statusFilter;
  const unappliedWhere: Prisma.SalesStaffWhereInput = {
    AND: [
      listStaffCond,
      { fieldApplications: { none: {} } },
      ...(q
        ? [
            {
              OR: [
                { salesId: { contains: q } },
                { lastName: { contains: q } },
                { firstName: { contains: q } },
              ],
            },
          ]
        : []),
    ],
  };

  const statsWhere: Prisma.FieldAgentApplicationWhereInput = {
    salesStaff: { is: scopeStaffCond },
  };

  const [total, applying, working, removed, appCount, unappliedCount, agencies] = await Promise.all(
    [
      prisma.fieldAgentApplication.count({ where: statsWhere }),
      prisma.fieldAgentApplication.count({ where: { ...statsWhere, status: "applying" } }),
      prisma.fieldAgentApplication.count({
        where: { ...statsWhere, status: "registered", applicationType: "稼働" },
      }),
      prisma.fieldAgentApplication.count({
        where: { ...statsWhere, status: { in: ["deleted", "suspended"] } },
      }),
      prisma.fieldAgentApplication.count({ where }),
      includeUnapplied ? prisma.salesStaff.count({ where: unappliedWhere }) : Promise.resolve(0),
      prisma.agency.findMany({
        where: scope === null ? { isDummy: false } : { id: { in: scope } },
        orderBy: [{ tier: "asc" }, { code: "asc" }],
        select: { id: true, name: true, code: true },
      }),
    ]
  );

  // 申請レコードの行 → 未申請の行 の順で1つの一覧としてページングする
  const count = appCount + unappliedCount;
  const skip = (page - 1) * PAGE_SIZE;
  const appTake = Math.max(0, Math.min(PAGE_SIZE, appCount - skip));
  const unappliedTake = PAGE_SIZE - appTake;
  const unappliedSkip = Math.max(0, skip - appCount);

  const [apps, unappliedStaff] = await Promise.all([
    appTake > 0
      ? prisma.fieldAgentApplication.findMany({
          where,
          orderBy: { updatedAt: "desc" },
          skip,
          take: appTake,
          include: { salesStaff: { include: { agency: true } } },
        })
      : Promise.resolve([]),
    includeUnapplied && unappliedTake > 0
      ? prisma.salesStaff.findMany({
          where: unappliedWhere,
          orderBy: [{ salesId: "asc" }, { createdAt: "asc" }],
          skip: unappliedSkip,
          take: unappliedTake,
          include: { agency: { include: { parent: true } } },
        })
      : Promise.resolve([]),
  ]);

  // 行内「訪販申請」ボタンの出し分け（S4-025）: 申請区分「稼働」を受け付けられる行にのみ出す。
  // サーバ側の受付条件（§6.3-1 販売員IDが仮登録/本登録 + 有効な稼働申請が無い）と同じ判定を使う。
  const pageStaffIds = Array.from(new Set(apps.map((a) => a.salesStaffId)));
  const aliveWorkApps = pageStaffIds.length
    ? await prisma.fieldAgentApplication.findMany({
        where: {
          salesStaffId: { in: pageStaffIds },
          applicationType: "稼働",
          status: { in: ["applying", "provisional", "registered"] },
        },
        select: { salesStaffId: true },
      })
    : [];
  const hasAliveWork = new Set(aliveWorkApps.map((a) => a.salesStaffId));

  // 申請フォーム用: スコープ内の仮登録/本登録の販売員（販売員IDの登録後にのみ申請可能 §6.3-1）
  // TODO: 販売員が大量になった場合は検索型セレクトに置き換える
  const staffList = canApply
    ? await prisma.salesStaff.findMany({
        where: { ...scopeStaffCond, status: { in: APPLICABLE_STAFF_STATUS } },
        include: { agency: { include: { parent: true } } },
        orderBy: { salesId: "asc" },
        take: 500,
      })
    : [];
  const staffOptions: StaffOption[] = staffList.map((s) => ({
    id: s.id,
    salesId: s.salesId ?? "（未採番）",
    name: `${s.lastName} ${s.firstName}`,
    agencyName: s.agency.name,
    agencyCode: s.agency.code,
    primaryAgencyName: s.agency.tier === 1 ? s.agency.name : (s.agency.parent?.name ?? ""),
  }));
  // 行内「訪販申請」から来た販売員が上限500件に入っていない場合も選択できるよう補う
  let initialStaffId = "";
  if (canApply && applyStaffId) {
    if (staffOptions.some((o) => o.id === applyStaffId)) {
      initialStaffId = applyStaffId;
    } else {
      const target = await prisma.salesStaff.findFirst({
        where: { id: applyStaffId, ...scopeStaffCond, status: { in: APPLICABLE_STAFF_STATUS } },
        include: { agency: { include: { parent: true } } },
      });
      if (target) {
        staffOptions.unshift({
          id: target.id,
          salesId: target.salesId ?? "（未採番）",
          name: `${target.lastName} ${target.firstName}`,
          agencyName: target.agency.name,
          agencyCode: target.agency.code,
          primaryAgencyName:
            target.agency.tier === 1 ? target.agency.name : (target.agency.parent?.name ?? ""),
        });
        initialStaffId = target.id;
      }
    }
  }

  // 変更フォーム（?edit=<申請ID>）の対象。スコープ内かつ削除済以外のみ（server action 側でも再検証する §3.1）
  let editTarget: EditTarget | null = null;
  if (canUpdate && editId) {
    const target = await prisma.fieldAgentApplication.findFirst({
      where: { id: editId, salesStaff: { is: scopeStaffCond }, status: { not: "deleted" } },
      include: { salesStaff: { include: { agency: true } } },
    });
    if (target) {
      editTarget = {
        id: target.id,
        salesId: target.salesStaff.salesId ?? "（未採番）",
        staffName: `${target.salesStaff.lastName} ${target.salesStaff.firstName}`,
        agencyName: target.agencyName ?? target.salesStaff.agency.name,
        statusLabel: STAFF_STATUS_LABELS[target.status] ?? target.status,
        applicationType: target.applicationType,
        products: target.products,
        attribute: target.attribute ?? "社員/契約社員",
        lastNameKana: target.lastNameKana ?? "",
        firstNameKana: target.firstNameKana ?? "",
        identityType: target.identityType ?? "免許証",
        pledgeNo: target.pledgeNo,
        startDate: target.startDate ?? "",
        endDate: target.endDate ?? "",
        agencyCode1: target.agencyCode1,
        agencyCode2: target.agencyCode2 ?? "",
        contractorName: target.contractorName ?? "",
        contractorAddress: target.contractorAddress ?? "",
        contractorPhone: target.contractorPhone ?? "",
      };
    }
  }

  const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const filterParams = () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (agencyFilter) params.set("agency", agencyFilter);
    if (statusFilter) params.set("status", statusFilter);
    return params;
  };
  const buildQuery = (p: number) => {
    const params = filterParams();
    params.set("page", String(p));
    return `/field-agents?${params.toString()}`;
  };
  // 変更リンク / 変更をやめたときの戻り先（絞り込み条件とページを保持する）
  const listHref = (() => {
    const params = filterParams();
    if (page > 1) params.set("page", String(page));
    const qs = params.toString();
    return qs ? `/field-agents?${qs}` : "/field-agents";
  })();
  const editHref = (appId: string) => {
    const params = filterParams();
    if (page > 1) params.set("page", String(page));
    params.set("edit", appId);
    return `/field-agents?${params.toString()}`;
  };
  // 行内「訪販申請」: 当該販売員を初期選択した申請フォームを開く（S4-025）
  const applyHref = (staffId: string) => {
    const params = filterParams();
    if (page > 1) params.set("page", String(page));
    params.set("apply", staffId);
    return `/field-agents?${params.toString()}`;
  };
  const from = count === 0 ? 0 : skip + 1;
  const to = Math.min(skip + apps.length + unappliedStaff.length, count);

  const btnSm = " px-2.5! py-1! text-xs!";

  // 一覧の行（訪販員申請レコード + 申請レコードが無い販売員の「未申請」行）
  type ViewRow = {
    key: string;
    staffId: string;
    salesId: string;
    staffName: string;
    kana: string;
    agencyName: string;
    primaryAgencyName: string | null;
    staffStatusLabel: string; // 販売員IDステータス（§4.1 / S4-022）
    state: FieldAgentState; // 訪販員申請状態（4値 / S4-023）
    stateDetail: string | null; // §4.1 の申請ステータス（4値だけでは伝わらない場合に併記）
    applicationType: string | null;
    products: string | null;
    pledgeNo: string | null;
    pledgeFileId: string | null;
    workMonth: string | null;
    history: string;
    blacklistFlag: string | null;
    sncMemo: string | null;
    updatedAt: Date;
    appId: string | null;
    appStatus: string | null;
    canApplyRow: boolean;
  };

  const rows: ViewRow[] = [
    ...apps.map((a) => {
      const s = a.salesStaff;
      const state = fieldAgentState(a);
      const statusLabel = STAFF_STATUS_LABELS[a.status] ?? a.status;
      return {
        key: a.id,
        staffId: s.id,
        salesId: s.salesId ?? "（未採番）",
        staffName: `${s.lastName} ${s.firstName}`,
        kana: `${a.lastNameKana ?? ""} ${a.firstNameKana ?? ""}`.trim(),
        agencyName: a.agencyName ?? s.agency.name,
        primaryAgencyName: a.primaryAgencyName,
        staffStatusLabel: STAFF_STATUS_LABELS[s.status] ?? s.status,
        state,
        // 「仮登録（1次承認済み）」「停止中」「削除済」は4値からは読み取れないため併記する（§4.1）。
        // 「本登録」は state=稼働 + 稼働月で伝わるため重複表示しない。
        stateDetail: ["provisional", "suspended", "deleted"].includes(a.status)
          ? statusLabel
          : null,
        applicationType: a.applicationType,
        products: a.products,
        pledgeNo: a.pledgeNo,
        pledgeFileId: a.pledgeFileId,
        workMonth: a.workMonth,
        history: formatHistory(a.history),
        blacklistFlag: a.blacklistFlag,
        sncMemo: a.sncMemo,
        updatedAt: a.updatedAt,
        appId: a.id,
        appStatus: a.status,
        canApplyRow:
          canApply && APPLICABLE_STAFF_STATUS.includes(s.status) && !hasAliveWork.has(s.id),
      };
    }),
    ...unappliedStaff.map((s) => ({
      key: `staff-${s.id}`,
      staffId: s.id,
      salesId: s.salesId ?? "（未採番）",
      staffName: `${s.lastName} ${s.firstName}`,
      kana: "",
      agencyName: s.agency.name,
      primaryAgencyName: s.agency.tier === 1 ? s.agency.name : (s.agency.parent?.name ?? null),
      staffStatusLabel: STAFF_STATUS_LABELS[s.status] ?? s.status,
      state: "未申請" as FieldAgentState,
      stateDetail: null,
      applicationType: null,
      products: null,
      pledgeNo: null,
      pledgeFileId: null,
      workMonth: null,
      history: "",
      blacklistFlag: null,
      sncMemo: null,
      updatedAt: s.updatedAt,
      appId: null,
      appStatus: null,
      canApplyRow: canApply && APPLICABLE_STAFF_STATUS.includes(s.status),
    })),
  ];

  return (
    <div>
      <PageHeader title="訪販員申請・管理" />

      {user.dummy && (
        <InfoBanner>
          SNC閲覧アカウントのため、架空のダミーデータを表示しています。申請・承認等の操作はできません。
        </InfoBanner>
      )}
      <InfoBanner>
        訪販員申請は<strong>販売員IDの登録後にのみ</strong>
        申請できます。訪販員IDは発行されず、登録有無のステータスのみで管理されます（申請区分「抹消」の最終承認で当該訪販員登録は抹消されます）。
      </InfoBanner>

      {/* 統計カード */}
      <div className="mb-5 grid grid-cols-4 gap-4">
        <StatCard value={total} label="申請総数" tone="blue" />
        <StatCard value={applying} label="申請中" tone="orange" />
        <StatCard value={working} label="稼働" tone="green" />
        <StatCard value={removed} label="抹消・停止" tone="red" />
      </div>

      {/* 業務項目の変更（§5.1「変」）: ?edit=<申請ID> のときは変更フォームのみを表示する */}
      {editTarget ? (
        <FieldApplicationEditForm target={editTarget} backHref={listHref} />
      ) : (
        <>
          {/* 申請フォーム（R4ダミーには非表示）。行内「訪販申請」からは販売員を初期選択して開く */}
          {canApply && (
            <ApplyForm
              key={initialStaffId || "new"}
              staff={staffOptions}
              isSnc={isSnc}
              initialStaffId={initialStaffId}
            />
          )}
          {/* CSV一括申請（ひな形DL + CSV/誓約書PDF（zip一括）同時アップロード §7.4） */}
          {canApply && <CsvBulkForm />}
        </>
      )}
      {canUpdate && editId && !editTarget && (
        <InfoBanner>
          変更対象の訪販員申請が見つからないか、操作可能な範囲外・削除済のため変更できません。
        </InfoBanner>
      )}

      <SectionTitle
        right={
          <div className="flex flex-wrap gap-2">
            <a href="/field-agents/csv/template" className={btnOutline}>
              一括申請CSVひな形
            </a>
            <a href="/field-agents/csv" className={btnOutline}>
              訪販員申請一覧CSV出力
            </a>
          </div>
        }
      >
        訪販員申請一覧
      </SectionTitle>

      {/* フィルタ: 検索 / 代理店 / 状態 */}
      <form method="get" action="/field-agents" className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-64">
          <input
            name="q"
            defaultValue={q}
            placeholder="氏名・フリガナ・販売員ID・誓約書No"
            className={inputCls}
          />
        </div>
        <div className="w-56">
          <select name="agency" defaultValue={agencyFilter} className={inputCls}>
            <option value="">すべての代理店</option>
            {agencies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}（{a.code}）
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <select name="status" defaultValue={statusFilter} className={inputCls}>
            <option value="">すべての状態</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STAFF_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <button className={btnOutline}>検索</button>
        {(q || agencyFilter || statusFilter) && (
          <Link href="/field-agents" className="text-xs text-blue-600 hover:underline">
            クリア
          </Link>
        )}
      </form>

      <Card>
        <div className="mb-2 text-xs text-slate-500">
          全{count}件中 {from}–{to}件を表示
        </div>
        {rows.length === 0 ? (
          <EmptyState message="該当する訪販員申請はありません。" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse">
              <thead>
                <tr>
                  <th className={thCls}>販売員ID</th>
                  <th className={thCls}>氏名（フリガナ）</th>
                  <th className={thCls}>所属代理店</th>
                  <th className={thCls}>販売員IDステータス</th>
                  <th className={thCls}>申請区分</th>
                  <th className={thCls}>取扱商材</th>
                  <th className={thCls}>訪販員申請状態</th>
                  <th className={thCls}>稼働月</th>
                  {isSnc && <th className={thCls}>ブラックリスト</th>}
                  <th className={thCls}>最終更新</th>
                  <th className={thCls}>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className={tdCls}>
                      <div className="font-medium">{r.salesId}</div>
                      {r.pledgeNo ? (
                        <div className="text-xs text-slate-400">誓約書No: {r.pledgeNo}</div>
                      ) : (
                        <div className="text-xs text-slate-400">誓約書No: —</div>
                      )}
                      {r.pledgeFileId && (
                        <a
                          href={`/files/${r.pledgeFileId}`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          誓約書PDF
                        </a>
                      )}
                    </td>
                    <td className={tdCls}>
                      <div className="font-medium">{r.staffName}</div>
                      <div className="text-xs text-slate-400">{r.kana || "—"}</div>
                    </td>
                    <td className={tdCls}>
                      <div>{r.agencyName}</div>
                      {r.primaryAgencyName && (
                        <div className="text-xs text-slate-400">1次店: {r.primaryAgencyName}</div>
                      )}
                    </td>
                    {/* 販売員IDステータス（§4.1 のラベル / S4-022） */}
                    <td className={tdCls}>
                      <StatusBadge label={r.staffStatusLabel} />
                    </td>
                    <td className={tdCls}>
                      {r.applicationType ? (
                        <StatusBadge label={r.applicationType} />
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className={tdCls}>
                      {r.products ?? <span className="text-xs text-slate-400">—</span>}
                    </td>
                    {/* 訪販員申請状態（未申請・申請中・稼働・抹消 / S4-023・R-018） */}
                    <td className={tdCls}>
                      <StatusBadge label={r.state} />
                      {r.stateDetail && (
                        <div className="mt-1 text-[10px] leading-4 text-slate-500">
                          {r.stateDetail}
                        </div>
                      )}
                      {r.history && (
                        <div className="mt-1 max-w-52 text-[10px] leading-4 text-slate-400">
                          {r.history}
                        </div>
                      )}
                    </td>
                    <td className={tdCls}>{r.workMonth ?? "—"}</td>
                    {isSnc && (
                      <td className={tdCls}>
                        {r.appId === null ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          <>
                            {r.blacklistFlag === "★" ? (
                              <Badge tone="red">★</Badge>
                            ) : r.blacklistFlag === "1" ? (
                              <Badge tone="yellow">1</Badge>
                            ) : (
                              <span className="text-xs text-slate-400">無印</span>
                            )}
                            {r.sncMemo && (
                              <div
                                className="mt-1 max-w-36 truncate text-xs text-slate-500"
                                title={r.sncMemo}
                              >
                                {r.sncMemo}
                              </div>
                            )}
                            <details className="mt-1">
                              <summary className="cursor-pointer text-xs text-blue-600">
                                編集
                              </summary>
                              <form action={updateSncFieldsAction} className="mt-1 w-40 space-y-1">
                                <input type="hidden" name="id" value={r.appId} />
                                <select
                                  name="blacklistFlag"
                                  defaultValue={r.blacklistFlag ?? ""}
                                  className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
                                >
                                  <option value="">無印（問題なし）</option>
                                  <option value="★">★（ブラックリスト）</option>
                                  <option value="1">1（要注意）</option>
                                </select>
                                <input
                                  name="sncMemo"
                                  defaultValue={r.sncMemo ?? ""}
                                  placeholder="SNC用メモ"
                                  className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs"
                                />
                                <button className={btnOutline + btnSm}>保存</button>
                              </form>
                            </details>
                          </>
                        )}
                      </td>
                    )}
                    <td className={tdCls}>
                      <span className="text-xs whitespace-nowrap">{fmtJst(r.updatedAt)}</span>
                    </td>
                    <td className={tdCls}>
                      <div className="flex flex-wrap gap-1">
                        {/* 訪販申請（申請可能な状態の行にのみ表示 §7.4「操作」/ S4-025） */}
                        {r.canApplyRow && (
                          <Link href={applyHref(r.staffId)} className={btnPrimary + btnSm}>
                            訪販申請
                          </Link>
                        )}
                        {/* 業務項目の変更（§5.1「変」= ①②③⑦） */}
                        {r.appId && canUpdate && r.appStatus !== "deleted" && (
                          <Link href={editHref(r.appId)} className={btnOutline + btnSm}>
                            変更
                          </Link>
                        )}
                        {r.appId && r.appStatus === "applying" && canFirstApprove && (
                          <form action={firstApproveAction}>
                            <input type="hidden" name="id" value={r.appId} />
                            <button className={btnSuccess + btnSm}>1次承認</button>
                          </form>
                        )}
                        {r.appId &&
                          ["applying", "provisional"].includes(r.appStatus ?? "") &&
                          canFinalApprove && (
                            <form action={finalApproveAction}>
                              <input type="hidden" name="id" value={r.appId} />
                              <button className={btnSuccess + btnSm}>
                                {r.applicationType === "抹消" ? "最終承認（抹消）" : "最終承認"}
                              </button>
                            </form>
                          )}
                        {r.appId &&
                          ["provisional", "registered"].includes(r.appStatus ?? "") &&
                          canSuspend && (
                            <form action={suspendAction}>
                              <input type="hidden" name="id" value={r.appId} />
                              <button className={btnDanger + btnSm}>停止</button>
                            </form>
                          )}
                        {r.appId && r.appStatus === "suspended" && canSuspend && (
                          <form action={resumeAction}>
                            <input type="hidden" name="id" value={r.appId} />
                            <button className={btnOutline + btnSm}>再開</button>
                          </form>
                        )}
                        {r.appId && r.appStatus !== "deleted" && canDelete && (
                          <form action={removeAction}>
                            <input type="hidden" name="id" value={r.appId} />
                            <button className={btnOutline + btnSm}>削除</button>
                          </form>
                        )}
                        {r.appId && r.appStatus === "deleted" && canDelete && (
                          <form action={restoreAction}>
                            <input type="hidden" name="id" value={r.appId} />
                            <button className={btnOutline + btnSm}>復旧</button>
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ページネーション（50件/頁） */}
        <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
          <div className="text-xs text-slate-500">
            {page} / {totalPages} ページ
          </div>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={buildQuery(page - 1)} className={btnOutline + btnSm}>
                ← 前へ
              </Link>
            ) : (
              <span className={btnOutline + btnSm + " pointer-events-none opacity-40"}>← 前へ</span>
            )}
            {page < totalPages ? (
              <Link href={buildQuery(page + 1)} className={btnOutline + btnSm}>
                次へ →
              </Link>
            ) : (
              <span className={btnOutline + btnSm + " pointer-events-none opacity-40"}>次へ →</span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
