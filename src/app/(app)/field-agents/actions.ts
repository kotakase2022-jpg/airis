"use server";

// 訪販員申請・管理 server actions（SPEC §6.3 / §7.4）
// - 全アクションで requirePage による権限チェック + agencyScope によるスコープ検証を行う
// - R4（SNC閲覧=ダミー表示）は書き込み拒否
import crypto from "crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePage, agencyScope, type CurrentUser } from "@/lib/auth";
import { STAFF_STATUS_LABELS, needsFirstApproval } from "@/lib/roles";
import { can, canApproveFirst } from "@/lib/permissions";
import { parseCsv } from "@/lib/csv";
import { audit, notify, notifyRole, pushHistory, storeFile, today } from "@/lib/util";
import { recordStatusHistory, type StatusEvent } from "@/lib/status";
import { isBlankOrCalendarDate } from "@/lib/date-input";
import { FIELD_AGENT_CSV_HEADERS, pledgePdfName } from "./csv-columns";
import { resolveAgencyScope } from "./agency-scope";
import { unzipEntries } from "./zip";

const APPLICATION_TYPES = ["稼働", "抹消"];
const PRODUCTS = ["マルチ", "auひかり", "コラボ"];
const ATTRIBUTES = ["社員/契約社員", "パート・アルバイト", "業務委託社員", "個人事業主"];
const IDENTITY_TYPES = ["免許証", "マイナンバーカード", "パスポート"];

// 権限判定は §5.1 の宣言的マップ（src/lib/permissions.ts）だけを情報源とする（§3.2）。
// この画面でロール配列を直書きしない（tests/unit/permissions-coverage.test.ts が検出する）。
//   申請=apply（①②③⑦⑧） / 1次承認=canApproveFirst（⑦ + 最終承認権限者①②③ §6.2-2）/
//   最終承認=approve_final（①②③） / 停止・再開=suspend（①②③⑦） / 削除・復旧=delete（①②③⑦）

export type FormState = { error?: string; success?: string };
export type CheckState = { error?: string; warnings?: string[]; checked?: boolean };
// CSV一括申請の結果（errors=行単位エラーレポート。1件でもあれば全件登録しない §3.6）
export type CsvBulkState = { error?: string; errors?: string[]; success?: string };

// SNC限定項目（ブラックリスト欄・SNC用メモ §7.4「SNCアカウント（①②③）でログインした場合のみ
// 表示・編集可」）と最終承認の主体は同一集合。§5.1「訪販員申請 / 承（最終承認）＝①②③」を
// 根拠に宣言的マップから導出する（§3.2。csv/route.ts と同じ導出）。
function isSncAdmin(user: CurrentUser) {
  return can(user.role, "field-agent", "approve_final");
}

// 状態遷移を StatusHistory（§4.1「遷移イベントを履歴テーブルに記録」）へ記録する。
// JSON列 history は画面表示用の軽量な履歴で、エンティティ横断の検索・監査には使えないため
// 両方に記録する（recordStatusHistory は失敗しても業務処理を止めない）。
function track(
  entityId: string,
  event: StatusEvent,
  fromStatus: string | null,
  toStatus: string | null,
  changedBy: string,
  reason?: string | null
) {
  return recordStatusHistory({
    entityType: "field_agent",
    entityId,
    event,
    fromStatus,
    toStatus,
    reason,
    changedBy,
  });
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
  if (!can(user.role, "field-agent", "apply")) {
    await audit(user.loginId, "訪販員申請作成", `role=${user.role}`, "denied");
    return { error: "訪販員申請の権限がありません。" };
  }

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
  if (!APPLICATION_TYPES.includes(applicationType))
    return { error: "申請区分を選択してください。" };
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
  // 実在する日付であること（形式だけの検証では 9999-99-99 / 2026-02-31 が通ってしまう §7.4）
  if (!isBlankOrCalendarDate(startDate)) {
    return { error: "稼働開始日は実在する日付を YYYY-MM-DD 形式で入力してください。" };
  }
  if (!isBlankOrCalendarDate(endDate)) {
    return { error: "稼働終了日は実在する日付を YYYY-MM-DD 形式で入力してください。" };
  }
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
    staff.agency.tier === 1 ? staff.agency.name : (staff.agency.parent?.name ?? null);
  // 代理店スコープ列（§3.1）: 親SalesStaffの所属から解決して保存する。RLS（prisma/rls.sql）は
  // この2列を直接照合するため、作成時に必ず埋める。
  const scopeColumns = resolveAgencyScope(staff.agency);

  const created = await prisma.fieldAgentApplication.create({
    data: {
      salesStaffId: staff.id,
      ...scopeColumns,
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

  await track(
    created.id,
    "requested",
    null,
    "applying",
    user.loginId,
    `申請区分: ${applicationType}`
  );
  await audit(user.loginId, "訪販員申請作成", `fieldAgentApplication:${created.id}`);
  // 通知: SNC承認者 + （2次店からの申請時）1次店管理者
  const staffLabel = `${staff.lastName} ${staff.firstName}（${staff.agency.name}）`;
  await notifyRole(
    ["R2", "R3"],
    "訪販員申請が提出されました",
    `${staffLabel} / 申請区分: ${applicationType}`,
    "/field-agents"
  );
  if (needsFirstApproval(user.role) && staff.agency.parentId) {
    const admins = await prisma.account.findMany({
      where: { role: "R7", agencyId: staff.agency.parentId, status: "active" },
      select: { id: true },
    });
    await Promise.all(
      admins.map((ad) =>
        notify(
          ad.id,
          "訪販員申請（1次承認待ち）",
          `${staffLabel} / 申請区分: ${applicationType}`,
          "/field-agents"
        )
      )
    );
  }

  revalidatePath("/field-agents");
  return { success: `訪販員申請（${applicationType}）を受け付けました。（申請中）` };
}

// ============================================================
// CSV一括申請（§7.4 / §3.6）
// - 行単位バリデーション → エラーが1件でもあれば「n行目: 理由」を返して**全件登録しない**
// - 誓約書PDFは `{誓約書No}-{連番3桁}.pdf` のファイル名でCSV行順に突合する
//   （例: 誓約書No 70 で30行 → 70-001.pdf 〜 70-030.pdf）
// - 受け取り方は2通り（どちらも同じファイル名規則で突合する）:
//     1. zip一括アップロード（§7.4「CSV と同時に zip で一括アップロード」）… name="pledgeZip"
//        展開は依存追加なしの自前実装（./zip.ts。Node標準 zlib の inflateRaw を使用）
//     2. 個別PDFの複数選択 … name="pledgeFiles"（少数件の追加・差し替え運用のため残す）
// ============================================================
const CSV_MAX_ROWS = 1000;

// CSV列インデックス（csv-columns.ts の FIELD_AGENT_CSV_HEADERS と同順）
const C_SALES_ID = 0;
const C_TYPE = 1;
const C_PRODUCTS = 2;
const C_ATTRIBUTE = 3;
const C_KANA_LAST = 4;
const C_KANA_FIRST = 5;
const C_IDENTITY = 6;
const C_PLEDGE_NO = 7;
const C_START_DATE = 8;
const C_CODE1 = 9;
const C_CODE2 = 10;
const C_CONTRACTOR_NAME = 11;
const C_CONTRACTOR_ADDRESS = 12;
const C_CONTRACTOR_PHONE = 13;

function csvSafeFileName(name: string): string {
  return name
    .replace(/^.*[\\/]/, "") // ブラウザによるパス付きファイル名・zip内のディレクトリ階層対策
    .replace(/[\\/\x00-\x1f]/g, "_")
    .slice(0, 255);
}

// zipに紛れ込むOS付随ファイル（macOSのリソースフォーク等）は突合対象外として無視する
function isZipMetaEntry(entryName: string): boolean {
  const base = entryName.replace(/^.*[\\/]/, "");
  return entryName.startsWith("__MACOSX/") || base.startsWith("._") || base === ".DS_Store";
}

// 誓約書PDF1件（zip展開・個別選択のどちらでも同じ扱いにするための正規化）
type PledgePdf = { name: string; size: number; read: () => Promise<Uint8Array<ArrayBuffer>> };

export async function csvBulkApplyAction(
  _prev: CsvBulkState,
  formData: FormData
): Promise<CsvBulkState> {
  const user = await requirePage("field-agents");
  if (user.dummy) return { error: "閲覧専用アカウントのため申請できません。" };
  if (!can(user.role, "field-agent", "apply")) {
    await audit(user.loginId, "訪販員申請CSV一括申請", `role=${user.role}`, "denied");
    return { error: "訪販員申請の権限がありません。" };
  }

  // ---- CSV本体 ----
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "CSVファイルを選択してください。" };
  }
  if (file.size > 4 * 1024 * 1024) return { error: "CSVファイルは4MB以下にしてください。" };

  const rows = parseCsv(await file.text());
  const hasHeader = (rows[0]?.[C_SALES_ID] ?? "").trim() === FIELD_AGENT_CSV_HEADERS[C_SALES_ID];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) return { error: "CSVにデータ行がありません。" };
  if (dataRows.length > CSV_MAX_ROWS) {
    return { error: `1回の一括申請は${CSV_MAX_ROWS}行以内にしてください。` };
  }

  // ---- 誓約書PDF（zip一括 or 個別複数選択）をファイル名で保持 ----
  const maxMb = Number(process.env.FILE_MAX_MB) > 0 ? Number(process.env.FILE_MAX_MB) : 20;
  // zip展開後の合計上限（zip爆弾対策 §3.8）。誓約書PDFは1件あたり数百KB想定のため、
  // 1ファイル上限（maxMb）の10倍を全体上限とする。
  const zipTotalLimit = maxMb * 10 * 1024 * 1024;
  const pdfs = new Map<string, PledgePdf>(); // key=小文字ファイル名
  const fileErrors: string[] = [];
  const addPdf = (pdf: PledgePdf) => {
    const key = pdf.name.toLowerCase();
    if (pdfs.has(key)) {
      fileErrors.push(`誓約書PDF「${pdf.name}」が重複しています（zipと個別選択の両方など）。`);
      return;
    }
    pdfs.set(key, pdf);
  };

  // (1) zip一括アップロード（§7.4）。展開できない形式は理由を返して取込しない（§3.6）
  const zipFile = formData.get("pledgeZip");
  if (zipFile instanceof File && zipFile.size > 0) {
    const zipName = csvSafeFileName(zipFile.name);
    if (!zipName.toLowerCase().endsWith(".zip")) {
      fileErrors.push(`「${zipName}」はzipファイルではありません。`);
    } else if (zipFile.size > maxMb * 1024 * 1024) {
      fileErrors.push(`zipファイル「${zipName}」は${maxMb}MBを超えています。`);
    } else {
      const unzipped = unzipEntries(Buffer.from(await zipFile.arrayBuffer()), {
        maxEntries: CSV_MAX_ROWS,
        maxTotalBytes: zipTotalLimit,
      });
      if ("error" in unzipped) {
        fileErrors.push(unzipped.error);
      } else {
        for (const entry of unzipped.entries) {
          if (isZipMetaEntry(entry.name)) continue; // __MACOSX/ や ._xxx 等の付随ファイル
          const name = csvSafeFileName(entry.name); // ディレクトリ階層は落としてファイル名で突合
          if (!name.toLowerCase().endsWith(".pdf")) {
            fileErrors.push(`zip内の「${name}」はPDFファイルではありません。`);
            continue;
          }
          if (entry.data.length > maxMb * 1024 * 1024) {
            fileErrors.push(`誓約書「${name}」は${maxMb}MBを超えています。`);
            continue;
          }
          addPdf({ name, size: entry.data.length, read: async () => entry.data });
        }
      }
    }
  }

  // (2) 個別PDFの複数選択（少数件の追加・差し替え運用のため維持）
  for (const entry of formData.getAll("pledgeFiles")) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    const name = csvSafeFileName(entry.name);
    if (!name.toLowerCase().endsWith(".pdf")) {
      fileErrors.push(`誓約書「${name}」はPDFファイルではありません。`);
      continue;
    }
    if (entry.size > maxMb * 1024 * 1024) {
      fileErrors.push(`誓約書「${name}」は${maxMb}MBを超えています。`);
      continue;
    }
    addPdf({
      name,
      size: entry.size,
      read: async () => new Uint8Array(await entry.arrayBuffer()),
    });
  }
  if (fileErrors.length > 0) return { errors: fileErrors };

  // ---- 販売員IDをスコープ内で一括解決（クライアント由来の値を信用しない §3.1） ----
  const scope = await agencyScope(user);
  const salesIds = Array.from(
    new Set(dataRows.map((r) => (r[C_SALES_ID] ?? "").trim()).filter(Boolean))
  );
  const staffRows = salesIds.length
    ? await prisma.salesStaff.findMany({
        where: {
          salesId: { in: salesIds },
          ...(scope === null ? { agency: { isDummy: false } } : { agencyId: { in: scope } }),
        },
        include: { agency: { include: { parent: true } } },
      })
    : [];
  const staffBySalesId = new Map(staffRows.map((s) => [s.salesId ?? "", s]));

  // 既存申請の状況（重複稼働申請・抹消対象の有無）を一括取得
  const staffIds = staffRows.map((s) => s.id);
  const [activeWorkApps, aliveApps] = staffIds.length
    ? await Promise.all([
        prisma.fieldAgentApplication.findMany({
          where: {
            salesStaffId: { in: staffIds },
            applicationType: "稼働",
            status: { in: ["applying", "provisional", "registered"] },
          },
          select: { salesStaffId: true },
        }),
        prisma.fieldAgentApplication.findMany({
          where: { salesStaffId: { in: staffIds }, status: { not: "deleted" } },
          select: { salesStaffId: true },
        }),
      ])
    : [[], []];
  const hasActiveWork = new Set(activeWorkApps.map((a) => a.salesStaffId));
  const hasAlive = new Set(aliveApps.map((a) => a.salesStaffId));

  type PendingRow = {
    line: number;
    staff: (typeof staffRows)[number];
    applicationType: string;
    products: string;
    attribute: string;
    lastNameKana: string;
    firstNameKana: string;
    identityType: string;
    pledgeNo: string;
    startDate: string;
    agencyCode1: string;
    agencyCode2: string;
    contractorName: string;
    contractorAddress: string;
    contractorPhone: string;
    pdfKey: string | null;
  };

  const errors: string[] = [];
  const creates: PendingRow[] = [];
  const pledgeSeq = new Map<string, number>(); // 誓約書Noごとの連番（CSV行順）
  const seenWorkStaff = new Set<string>();
  const usedPdfKeys = new Set<string>();

  dataRows.forEach((r, i) => {
    // TODO: parseCsv は空行を除外するため、空行を含むファイルでは行番号が原本とずれる可能性がある
    const line = i + (hasHeader ? 2 : 1);
    const g = (c: number) => (r[c] ?? "").trim();
    const salesId = g(C_SALES_ID);
    const applicationType = g(C_TYPE);
    const products = g(C_PRODUCTS);
    const attribute = g(C_ATTRIBUTE);
    const lastNameKana = g(C_KANA_LAST);
    const firstNameKana = g(C_KANA_FIRST);
    const identityType = g(C_IDENTITY);
    const pledgeNo = g(C_PLEDGE_NO);
    const startDate = g(C_START_DATE);
    const agencyCode1 = g(C_CODE1);
    const agencyCode2 = g(C_CODE2);
    const contractorName = g(C_CONTRACTOR_NAME);
    const contractorAddress = g(C_CONTRACTOR_ADDRESS);
    const contractorPhone = g(C_CONTRACTOR_PHONE);

    const e: string[] = [];

    // 販売員ID: 存在 + スコープ内 + 仮登録/本登録（§6.3-1）
    const staff = salesId ? staffBySalesId.get(salesId) : undefined;
    if (!salesId) e.push("販売員IDが未入力です");
    else if (!staff) e.push(`販売員ID「${salesId}」が存在しないか、操作可能な代理店の範囲外です`);
    else if (!["provisional", "registered"].includes(staff.status)) {
      e.push(
        `販売員ID「${salesId}」は仮登録または本登録ではありません（現在: ${STAFF_STATUS_LABELS[staff.status] ?? staff.status}）`
      );
    }

    if (!APPLICATION_TYPES.includes(applicationType)) {
      e.push(`申請区分は「${APPLICATION_TYPES.join("」「")}」のいずれかで入力してください`);
    }
    if (!PRODUCTS.includes(products)) {
      e.push(`取扱商材は「${PRODUCTS.join("」「")}」のいずれかで入力してください`);
    }
    if (!ATTRIBUTES.includes(attribute)) {
      e.push(`属性は「${ATTRIBUTES.join("」「")}」のいずれかで入力してください`);
    }
    if (!lastNameKana || !firstNameKana) e.push("フリガナ（姓・名）が未入力です");
    if (!IDENTITY_TYPES.includes(identityType)) {
      e.push(`本人性種別は「${IDENTITY_TYPES.join("」「")}」のいずれかで入力してください`);
    }
    if (!pledgeNo) e.push("誓約書Noが未入力です");
    if (!agencyCode1) e.push("使用代理店コード1が未入力です");
    // 取扱商材=マルチ → 使用代理店コードは2枠とも必須（§7.4）
    if (products === "マルチ" && !agencyCode2) {
      e.push("取扱商材が「マルチ」の場合、使用代理店コードは2枠とも必須です");
    }
    // CSV一括申請の列に稼働終了日は無い（`csv-columns.ts` の C_* 参照）ため開始日のみ検証する
    if (!isBlankOrCalendarDate(startDate)) {
      e.push("稼働開始日は実在する日付を YYYY-MM-DD 形式で入力してください");
    }
    // 属性=業務委託社員 のときのみ業務委託会社名・住所・連絡先が必須（§7.4）
    const isContractor = attribute === "業務委託社員";
    if (isContractor && (!contractorName || !contractorAddress || !contractorPhone)) {
      e.push("属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です");
    }

    // 重複申請・抹消対象の検証（単票申請と同一ルール）
    if (staff && applicationType === "稼働") {
      if (hasActiveWork.has(staff.id)) {
        e.push("この販売員には既に有効な訪販員申請（稼働）が存在します");
      } else if (seenWorkStaff.has(staff.id)) {
        e.push("同一販売員IDの稼働申請がCSV内で重複しています");
      } else {
        seenWorkStaff.add(staff.id);
      }
    }
    if (staff && applicationType === "抹消" && !hasAlive.has(staff.id)) {
      e.push("抹消申請の対象となる訪販員登録がありません");
    }

    // 誓約書PDFの突合（連番は誓約書Noごとの出現順=CSV行順。全行同一Noなら行番号と一致）
    let pdfKey: string | null = null;
    let seq = 0;
    if (pledgeNo) {
      seq = (pledgeSeq.get(pledgeNo) ?? 0) + 1;
      pledgeSeq.set(pledgeNo, seq);
    }
    if (pdfs.size > 0 && pledgeNo) {
      const expected = pledgePdfName(pledgeNo, seq);
      // CSV全体の行順で採番されたファイル名も許容する（誓約書Noが混在するCSV向け）
      const candidates = [expected, pledgePdfName(pledgeNo, i + 1)];
      const hit = candidates.map((c) => c.toLowerCase()).find((k) => pdfs.has(k));
      if (!hit) {
        e.push(`誓約書PDF「${expected}」が見つかりません（ファイル名は 誓約書No-連番3桁.pdf）`);
      } else {
        pdfKey = hit;
        usedPdfKeys.add(hit);
      }
    }

    if (e.length > 0) {
      errors.push(`${line}行目: ${e.join("、")}`);
      return;
    }
    creates.push({
      line,
      staff: staff!,
      applicationType,
      products,
      attribute,
      lastNameKana,
      firstNameKana,
      identityType,
      pledgeNo,
      startDate,
      agencyCode1,
      agencyCode2,
      contractorName,
      contractorAddress,
      contractorPhone,
      pdfKey,
    });
  });

  // CSVのどの行とも突合できなかった誓約書PDFもエラー行レポートの対象（§7.4）
  for (const [key, f] of pdfs) {
    if (!usedPdfKeys.has(key)) {
      errors.push(
        `誓約書PDF「${f.name}」はCSVのどの行とも突合できません（ファイル名は 誓約書No-連番3桁.pdf）`
      );
    }
  }

  // エラーが1件でもあれば全件登録しない（§3.6 全件ロールバック）
  if (errors.length > 0) {
    await audit(
      user.loginId,
      "訪販員申請CSV一括申請",
      `rows=${dataRows.length} errors=${errors.length}（全件未登録）`,
      "denied"
    );
    return { errors };
  }

  // ---- 登録（誓約書PDF保存 → 申請レコードを createMany で一括作成） ----
  // 数百件規模（§6.2-3）の一括申請でもラウンドトリップを増やさないため、storeFile() の
  // 1件ずつの保存ではなく createMany でまとめて保存する。検証内容は storeFile() と同じ
  // （拡張子ホワイトリスト=PDFのみ・上限MB・ファイル名サニタイズ §3.8）。
  const fileIdByLine = new Map<number, string>();
  const storedFiles: {
    id: string;
    name: string;
    mime: string;
    size: number;
    data: Uint8Array<ArrayBuffer>;
    uploadedBy: string;
  }[] = [];
  for (const c of creates) {
    if (!c.pdfKey) continue;
    const pdf = pdfs.get(c.pdfKey)!;
    const id = crypto.randomUUID();
    storedFiles.push({
      id,
      name: pdf.name,
      mime: "application/pdf", // 保存MIMEは拡張子から決定（クライアント申告値を信用しない §3.8）
      size: pdf.size,
      data: await pdf.read(),
      uploadedBy: user.loginId,
    });
    fileIdByLine.set(c.line, id);
  }
  if (storedFiles.length > 0) await prisma.storedFile.createMany({ data: storedFiles });

  await prisma.fieldAgentApplication.createMany({
    data: creates.map((c) => ({
      salesStaffId: c.staff.id,
      // 代理店スコープ列（§3.1）: 単票申請と同じく親SalesStaffの所属から解決して保存する
      ...resolveAgencyScope(c.staff.agency),
      applicationType: c.applicationType,
      products: c.products,
      attribute: c.attribute,
      lastNameKana: c.lastNameKana,
      firstNameKana: c.firstNameKana,
      identityType: c.identityType,
      pledgeNo: c.pledgeNo,
      pledgeFileId: fileIdByLine.get(c.line) ?? null,
      startDate: c.startDate || null,
      agencyCode1: c.agencyCode1,
      agencyCode2: c.agencyCode2 || null,
      contractorName: c.attribute === "業務委託社員" ? c.contractorName : null,
      contractorAddress: c.attribute === "業務委託社員" ? c.contractorAddress : null,
      contractorPhone: c.attribute === "業務委託社員" ? c.contractorPhone : null,
      status: "applying",
      primaryAgencyName:
        c.staff.agency.tier === 1 ? c.staff.agency.name : (c.staff.agency.parent?.name ?? null),
      agencyName: c.staff.agency.name,
      history: pushHistory([], "requested", user.loginId) as never,
    })),
  });

  await audit(
    user.loginId,
    "訪販員申請CSV一括申請",
    `${creates.length}件（誓約書PDF ${storedFiles.length}件）`
  );
  await notifyRole(
    ["R2", "R3"],
    "訪販員申請がCSVで一括提出されました",
    `${user.name} さんが${creates.length}件の訪販員申請を登録しました`,
    "/field-agents"
  );
  // 2次店からの一括申請は親1次店の管理者にも1次承認待ちを通知
  if (needsFirstApproval(user.role)) {
    const parentIds = Array.from(
      new Set(creates.map((c) => c.staff.agency.parentId).filter((v): v is string => !!v))
    );
    if (parentIds.length > 0) {
      const admins = await prisma.account.findMany({
        where: { role: "R7", agencyId: { in: parentIds }, status: "active" },
        select: { id: true },
      });
      await Promise.all(
        admins.map((ad) =>
          notify(
            ad.id,
            "訪販員申請（1次承認待ち）",
            `CSV一括申請で${creates.length}件が提出されました`,
            "/field-agents"
          )
        )
      );
    }
  }

  revalidatePath("/field-agents");
  return {
    success: `${creates.length}件の訪販員申請を登録しました。（申請中${
      storedFiles.length > 0 ? ` / 誓約書PDF ${storedFiles.length}件を突合` : ""
    }）`,
  };
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
  // 申請の事前チェックなので申請権限（§5.1 訪販員申請「申」）で判定する（§3.2）
  if (!can(user.role, "field-agent", "apply")) return { error: "権限がありません。" };

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
// §5.1 で「一承」を持つのは⑦のみだが、最終承認権限者（①②③）は自己承認可（§6.2-2）のため
// canApproveFirst() が中間状態への遷移も許可する（permissions.ts のコメント参照）。
export async function firstApproveAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !canApproveFirst(user.role, "field-agent")) {
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
  await track(app.id, "approve_first", app.status, "provisional", user.loginId);
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
    await track(app.id, "final_approve", app.status, "deleted", user.loginId, "抹消申請の最終承認");
    await track(app.id, "delete", app.status, "deleted", user.loginId, "抹消申請の最終承認");
    for (const o of others) {
      await prisma.fieldAgentApplication.update({
        where: { id: o.id },
        data: {
          status: "deleted",
          deletedAt: new Date(),
          history: pushHistory(o.history, "delete", user.loginId) as never,
        },
      });
      await track(
        o.id,
        "delete",
        o.status,
        "deleted",
        user.loginId,
        `他申請の抹消最終承認に伴う抹消（fieldAgentApplication:${app.id}）`
      );
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
    await track(app.id, "final_approve", app.status, "registered", user.loginId);
    await audit(user.loginId, "訪販員申請最終承認", `fieldAgentApplication:${app.id}`);
  }
  revalidatePath("/field-agents");
}

// 停止（§5.1 訪販員申請「停」= ①②③⑦）: provisional / registered → suspended
export async function suspendAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !can(user.role, "field-agent", "suspend")) {
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
  await track(app.id, "suspend", app.status, "suspended", user.loginId);
  await audit(user.loginId, "訪販員停止", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 再開（停止の解除なので §5.1「停」と同一権限 = ①②③⑦）: suspended → 元のステータス
export async function resumeAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !can(user.role, "field-agent", "suspend")) {
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
  await track(app.id, "resume", app.status, restoredStatus(app), user.loginId);
  await audit(user.loginId, "訪販員再開", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 削除（§5.1 訪販員申請「削」= ①②③⑦・論理削除 §3.4）
export async function removeAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !can(user.role, "field-agent", "delete")) {
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
  await track(app.id, "delete", app.status, "deleted", user.loginId);
  await audit(user.loginId, "訪販員申請削除", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// 復旧（誤削除バックアップ復旧 §3.4 なので §5.1「削」と同一権限 = ①②③⑦）: deleted → 元のステータス
export async function restoreAction(formData: FormData): Promise<void> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy || !can(user.role, "field-agent", "delete")) {
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
  await track(app.id, "restore", app.status, restoredStatus(app), user.loginId);
  await audit(user.loginId, "訪販員申請復旧", `fieldAgentApplication:${app.id}`);
  revalidatePath("/field-agents");
}

// ============================================================
// 業務項目の変更（§5.1 訪販員申請「変」= ①②③⑦。⑦は自店配下のみ）
// 対象: 申請区分 / 取扱商材 / 属性 / フリガナ / 本人性種別 / 誓約書No /
//       稼働開始日・終了日 / 使用代理店コード1・2 / 業務委託会社3項目（§7.4 列仕様）
// §7.4 のバリデーション（マルチ→2枠必須・業務委託社員→3項目必須）を再適用し、
// history に update を積み、監査ログに変更前後の値を残す（§3.3）。
// ============================================================
export async function updateFieldApplicationAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await requirePage("field-agents");
  const id = String(formData.get("id") ?? "");
  if (user.dummy) return { error: "閲覧専用アカウントのため変更できません。" };
  // 操作権限は §5.1 の宣言的マップで判定する（§3.2）
  if (!can(user.role, "field-agent", "update")) {
    await audit(user.loginId, "訪販員申請変更", `fieldAgentApplication:${id}`, "denied");
    return { error: "訪販員申請を変更する権限がありません。" };
  }
  const app = await appInScope(user, id);
  if (!app) {
    await audit(user.loginId, "訪販員申請変更", `fieldAgentApplication:${id}`, "denied");
    return { error: "対象の訪販員申請が見つからないか、操作可能な代理店の範囲外です。" };
  }
  if (app.status === "deleted") {
    return { error: "削除済の訪販員申請は変更できません。復旧してから変更してください。" };
  }

  const str = (k: string) => String(formData.get(k) ?? "").trim();
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

  // --- バリデーション（§7.4 列仕様。申請フォームと同一ルール） ---
  if (!APPLICATION_TYPES.includes(applicationType))
    return { error: "申請区分を選択してください。" };
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
  // 実在する日付であること（形式だけの検証では 9999-99-99 / 2026-02-31 が通ってしまう §7.4）
  if (!isBlankOrCalendarDate(startDate)) {
    return { error: "稼働開始日は実在する日付を YYYY-MM-DD 形式で入力してください。" };
  }
  if (!isBlankOrCalendarDate(endDate)) {
    return { error: "稼働終了日は実在する日付を YYYY-MM-DD 形式で入力してください。" };
  }
  // 属性=業務委託社員 のときのみ業務委託会社名・住所・連絡先が必須（他属性では保持しない）
  const isContractor = attribute === "業務委託社員";
  if (isContractor && (!contractorName || !contractorAddress || !contractorPhone)) {
    return { error: "属性が「業務委託社員」の場合、業務委託会社名・住所・連絡先は必須です。" };
  }

  // 申請区分を「稼働」へ変更する場合は重複申請チェック（作成時と同一ルール）
  if (applicationType === "稼働" && app.applicationType !== "稼働") {
    const existing = await prisma.fieldAgentApplication.count({
      where: {
        salesStaffId: app.salesStaffId,
        id: { not: app.id },
        applicationType: "稼働",
        status: { in: ["applying", "provisional", "registered"] },
      },
    });
    if (existing > 0) return { error: "この販売員には既に有効な訪販員申請（稼働）が存在します。" };
  }

  await prisma.fieldAgentApplication.update({
    where: { id: app.id },
    data: {
      applicationType,
      products,
      attribute,
      lastNameKana,
      firstNameKana,
      identityType,
      pledgeNo,
      startDate: startDate || null,
      endDate: endDate || null,
      agencyCode1,
      agencyCode2: agencyCode2 || null,
      contractorName: isContractor ? contractorName : null,
      contractorAddress: isContractor ? contractorAddress : null,
      contractorPhone: isContractor ? contractorPhone : null,
      history: pushHistory(app.history, "update", user.loginId) as never,
    },
  });

  // 変更前後の値を監査ログに残す（§3.3。差分のある項目のみ）
  const diffs: string[] = [];
  const pushDiff = (label: string, before: string | null, after: string | null) => {
    if ((before ?? "") !== (after ?? "")) diffs.push(`${label} ${before ?? "-"}→${after ?? "-"}`);
  };
  pushDiff("申請区分", app.applicationType, applicationType);
  pushDiff("取扱商材", app.products, products);
  pushDiff("属性", app.attribute, attribute);
  pushDiff("フリガナ姓", app.lastNameKana, lastNameKana);
  pushDiff("フリガナ名", app.firstNameKana, firstNameKana);
  pushDiff("本人性種別", app.identityType, identityType);
  pushDiff("誓約書No", app.pledgeNo, pledgeNo);
  pushDiff("稼働開始日", app.startDate, startDate || null);
  pushDiff("稼働終了日", app.endDate, endDate || null);
  pushDiff("使用代理店コード1", app.agencyCode1, agencyCode1);
  pushDiff("使用代理店コード2", app.agencyCode2, agencyCode2 || null);
  pushDiff("業務委託会社名", app.contractorName, isContractor ? contractorName : null);
  pushDiff("業務委託会社住所", app.contractorAddress, isContractor ? contractorAddress : null);
  pushDiff("業務委託会社連絡先", app.contractorPhone, isContractor ? contractorPhone : null);
  await audit(
    user.loginId,
    "訪販員申請変更",
    `fieldAgentApplication:${app.id} ${diffs.length ? diffs.join(" / ") : "変更なし"}`
  );

  revalidatePath("/field-agents");
  return { success: "訪販員申請の業務項目を更新しました。" };
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
