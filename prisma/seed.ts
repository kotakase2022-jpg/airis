import { PrismaClient } from "@prisma/client";
// パスワードのハッシュ化はアプリ実装と同一方式（Argon2id + 環境変数ペッパー §2/§10.3）を使う。
// 独自にbcryptでハッシュすると、アプリの verifyPassword と方式が食い違いログインできなくなる。
// アルゴリズム・ペッパーのバージョン管理はアプリと同一モジュール（src/lib/pepper.ts）を共有する。
import { activePepperVersion, hashPasswordWithVersion } from "../src/lib/pepper";

// RLS(FORCE)適用後もシードできるよう、接続オプションで app.bypass=on を設定
// （Neonはプール接続でoptionsが通らないため、DATABASE_URL_UNPOOLED等の直接接続URLを使うこと）
const baseUrl = process.env.DATABASE_URL!;
const seedUrl = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "options=-c%20app.bypass%3Don";
const prisma = new PrismaClient({ datasourceUrl: seedUrl });
const hash = (pw: string) => hashPasswordWithVersion(pw).hash;
// ハッシュに適用したペッパーのバージョンID（Account.pepperVersion。未設定なら null）
const PEPPER_VERSION = activePepperVersion();

// 初回ログイン時のパスワード変更フラグ（§9-1「全アカウントの初回変更フラグON」）。
// 既定は true。デモ・E2Eの利便性が必要な場合のみ SEED_DEMO=1 で false にする
// （SEED_DEMO=1 は開発・検証専用。本番シードでは付けない）。
const SEED_DEMO = process.env.SEED_DEMO === "1";
const MUST_CHANGE_PASSWORD = !SEED_DEMO;

// デモ用初期パスワード（本番運用前に必ず変更すること）
export const PASSWORDS = {
  admin: "Airis-Demo-Admin-2026!x", // 20桁以上（①②③⑦）
  general: "Airis-Demo-2026!", // 14桁以上（④⑤⑥⑧⑨⑩）
};

async function main() {
  console.log("Seeding...");

  // ---- 代理店 ----
  const p1 = await prisma.agency.upsert({
    where: { code: "110001" },
    update: {},
    create: {
      code: "110001",
      name: "東都ネットワーク販売株式会社",
      tier: 1,
      representative: "山田 一郎",
      joinedAt: new Date("2024-04-01"),
    },
  });
  const p2 = await prisma.agency.upsert({
    where: { code: "150008" },
    update: {},
    create: {
      code: "150008",
      name: "関西コミュニケーションズ株式会社",
      tier: 1,
      representative: "田中 次郎",
      joinedAt: new Date("2024-06-01"),
    },
  });
  const p3 = await prisma.agency.upsert({
    where: { code: "190001" },
    update: {},
    create: {
      code: "190001",
      name: "北海道テレコム販売株式会社",
      tier: 1,
      representative: "佐藤 三郎",
      status: "closed",
      joinedAt: new Date("2023-10-01"),
    },
  });
  const s1 = await prisma.agency.upsert({
    where: { code: "210001" },
    update: {},
    create: {
      code: "210001",
      name: "株式会社セールスパートナー東京",
      tier: 2,
      parentId: p1.id,
      representative: "鈴木 四郎",
      joinedAt: new Date("2024-08-01"),
    },
  });
  const s2 = await prisma.agency.upsert({
    where: { code: "210002" },
    update: {},
    create: {
      code: "210002",
      name: "株式会社フィールドプロ埼玉",
      tier: 2,
      parentId: p1.id,
      representative: "高橋 五郎",
      joinedAt: new Date("2025-01-15"),
    },
  });
  const s3 = await prisma.agency.upsert({
    where: { code: "250008" },
    update: {},
    create: {
      code: "250008",
      name: "近畿セールスサポート株式会社",
      tier: 2,
      parentId: p2.id,
      representative: "伊藤 六郎",
      joinedAt: new Date("2024-11-01"),
    },
  });
  // §9-2: 1次店×3、各配下に2次店2〜3店。150008配下・190001配下を補充する（既存行は update: {} で不変更）
  const s4 = await prisma.agency.upsert({
    where: { code: "250009" },
    update: {},
    create: {
      code: "250009",
      name: "株式会社なにわ通信サービス",
      tier: 2,
      parentId: p2.id,
      representative: "渡辺 七郎",
      joinedAt: new Date("2025-03-01"),
    },
  });
  // 稼働終了1次店（190001）配下は、親に合わせて稼働終了で登録する（§4.1 / §14-2）
  await prisma.agency.upsert({
    where: { code: "290001" },
    update: {},
    create: {
      code: "290001",
      name: "札幌フィールドサービス株式会社",
      tier: 2,
      parentId: p3.id,
      representative: "中村 八郎",
      status: "closed",
      joinedAt: new Date("2023-11-01"),
    },
  });
  await prisma.agency.upsert({
    where: { code: "290002" },
    update: {},
    create: {
      code: "290002",
      name: "株式会社道東セールス",
      tier: 2,
      parentId: p3.id,
      representative: "小林 九郎",
      status: "closed",
      joinedAt: new Date("2024-02-01"),
    },
  });
  // ④ダミー表示用の架空データ
  const d1 = await prisma.agency.upsert({
    where: { code: "990001" },
    update: {},
    create: {
      code: "990001",
      name: "サンプル一次代理店株式会社",
      tier: 1,
      representative: "見本 太郎",
      isDummy: true,
    },
  });
  const d2 = await prisma.agency.upsert({
    where: { code: "991001" },
    update: {},
    create: {
      code: "991001",
      name: "サンプル二次代理店株式会社",
      tier: 2,
      parentId: d1.id,
      representative: "見本 次郎",
      isDummy: true,
    },
  });

  // ---- 10ロールのアカウント ----
  const accounts: [string, string, string, string | null, string][] = [
    // [loginId, role, name, agencyId, password]
    ["airis_slb_sys_001", "R1", "サスラボ 管理者", null, PASSWORDS.admin],
    ["airis_snc_adm_001", "R2", "SNC 課長", null, PASSWORDS.admin],
    ["airis_snc_ops_0001", "R3", "SNC 運用担当", null, PASSWORDS.admin],
    ["airis_snc_vew_001", "R4", "SNC 閲覧ユーザー", null, PASSWORDS.general],
    ["airis_snc_spt1_001", "R5", "ホットライン 窓口担当", null, PASSWORDS.general],
    ["airis_snc_spt2_001", "R6", "消費者センター 窓口担当", null, PASSWORDS.general],
    ["airis_1110001_001", "R7", "東都NW 管理者", p1.id, PASSWORDS.admin],
    ["airis_2210001_001", "R8", "セールスパートナー東京 管理者", s1.id, PASSWORDS.general],
    // R9 は販売員IDとして下で作成
    ["airis_1190001_001", "R7", "北海道テレコム 管理者（稼働終了→⑩）", p3.id, PASSWORDS.admin],
  ];
  for (const [loginId, role, name, agencyId, pw] of accounts) {
    await prisma.account.upsert({
      where: { loginId },
      update: {},
      create: {
        loginId,
        role,
        name,
        agencyId,
        status: "active",
        passwordHash: hash(pw),
        pepperVersion: PEPPER_VERSION,
        mustChangePassword: MUST_CHANGE_PASSWORD,
        email: `${loginId}@example.com`,
      },
    });
  }

  // アカウントのステータス混在（§9-3 / §7.2 統計カード「停止・削除」の検証用）。
  // 停止中・削除済（論理削除・deletedAt付き）を各1件用意する。
  const lifecycleAccounts: [string, string, string, string | null, string, Date | null][] = [
    ["airis_snc_spt1_900", "R5", "SNC 停止中ユーザー", null, "suspended", null],
    ["airis_snc_spt2_900", "R6", "SNC 削除済ユーザー", null, "deleted", new Date("2026-06-20")],
  ];
  for (const [loginId, role, name, agencyId, status, deletedAt] of lifecycleAccounts) {
    await prisma.account.upsert({
      where: { loginId },
      update: {},
      create: {
        loginId,
        role,
        name,
        agencyId,
        status,
        passwordHash: hash(PASSWORDS.general),
        pepperVersion: PEPPER_VERSION,
        mustChangePassword: MUST_CHANGE_PASSWORD,
        email: `${loginId}@example.com`,
        ...(deletedAt ? { deletedAt } : {}),
      },
    });
  }

  // ---- MFAデモ用の追加アカウント（発注者指示 2026-08-05: ②〜⑩ 各10 = 計90）----
  // いずれもMFA未登録の状態で作成し、初回ログイン時にQRコードから登録する。
  // ⑨は販売員IDのため SalesStaff 行も併せて作成する（下の bulkStaff）。
  const bulkAccounts: [string, string, string, string | null, string][] = [];
  for (let i = 2; i <= 11; i++) {
    const n3 = String(i).padStart(3, "0");
    const n4 = String(i).padStart(4, "0");
    bulkAccounts.push(
      [`airis_snc_adm_${n3}`, "R2", `SNC 管理者${i}`, null, PASSWORDS.admin],
      [`airis_snc_ops_${n4}`, "R3", `SNC 運用担当${i}`, null, PASSWORDS.admin],
      [`airis_snc_vew_${n3}`, "R4", `SNC 閲覧ユーザー${i}`, null, PASSWORDS.general],
      [`airis_snc_spt1_${n3}`, "R5", `ホットライン 窓口担当${i}`, null, PASSWORDS.general],
      [`airis_snc_spt2_${n3}`, "R6", `消費者センター 窓口担当${i}`, null, PASSWORDS.general],
      [`airis_1110001_${n3}`, "R7", `東都NW 管理者${i}`, p1.id, PASSWORDS.admin],
      [`airis_2210001_${n3}`, "R8", `セールスパートナー東京 管理者${i}`, s1.id, PASSWORDS.general],
      [
        `airis_1190001_${n3}`,
        "R7",
        `北海道テレコム 管理者${i}（稼働終了→⑩）`,
        p3.id,
        PASSWORDS.admin,
      ]
    );
  }
  for (const [loginId, role, name, agencyId, pw] of bulkAccounts) {
    await prisma.account.upsert({
      where: { loginId },
      update: {},
      create: {
        loginId,
        role,
        name,
        agencyId,
        status: "active",
        passwordHash: hash(pw),
        pepperVersion: PEPPER_VERSION,
        mustChangePassword: MUST_CHANGE_PASSWORD,
        email: `${loginId}@example.com`,
      },
    });
  }
  // ⑨（販売員）×10: 110001C101〜C110（既存デモ販売員と重複しない番号帯）
  for (let i = 1; i <= 10; i++) {
    const salesId = `110001C${String(100 + i)}`;
    const acc = await prisma.account.upsert({
      where: { loginId: salesId },
      update: {},
      create: {
        loginId: salesId,
        role: "R9",
        name: `MFAデモ 販売員${i}`,
        agencyId: p1.id,
        status: "active",
        passwordHash: hash(PASSWORDS.general),
        pepperVersion: PEPPER_VERSION,
        mustChangePassword: MUST_CHANGE_PASSWORD,
      },
    });
    await prisma.salesStaff.upsert({
      where: { salesId },
      update: {},
      create: {
        salesId,
        lastName: "MFAデモ",
        firstName: `販売員${i}`,
        birthDate: "1995-01-15",
        phone: `080-9999-9${String(100 + i)}`,
        agencyId: p1.id,
        status: "registered",
        firstApproved: true,
        accountId: acc.id,
        history: [{ event: "requested", at: "2026-08-05", by: "seed" }],
      },
    });
  }

  // ---- 販売員（⑨含む）----
  const staffData: [string, string, string, string, string, string, string][] = [
    // [salesId, last, first, birth, phone, agencyId, status]
    ["110001C001", "営業", "太郎", "1990-04-01", "080-1111-1001", p1.id, "registered"],
    ["110001C002", "営業", "花子", "1992-08-15", "080-1111-1002", p1.id, "provisional"],
    ["210001C001", "販売", "一郎", "1988-12-03", "080-2222-1001", s1.id, "registered"],
    ["210001C002", "販売", "二郎", "1995-06-20", "080-2222-1002", s1.id, "applying"],
    ["210002C001", "現場", "三子", "1998-02-10", "080-3333-1001", s2.id, "provisional"],
    ["150008C001", "関西", "四郎", "1985-09-25", "080-4444-1001", p2.id, "registered"],
    ["250008C001", "近畿", "五子", "1993-11-11", "080-5555-1001", s3.id, "suspended"],
    // §9-3「販売員20名（各ステータス混在）」を満たすため、5ステータス（申請中/仮登録/本登録/
    // 停止中/削除済）を網羅する形で追加する
    ["110001C003", "東都", "六郎", "1991-03-12", "080-1111-1003", p1.id, "registered"],
    ["110001C004", "東都", "七子", "1996-07-08", "080-1111-1004", p1.id, "suspended"],
    ["110001C005", "東都", "八郎", "1989-10-30", "080-1111-1005", p1.id, "deleted"],
    ["210001C003", "販売", "九子", "1994-01-22", "080-2222-1003", s1.id, "registered"],
    ["210001C004", "販売", "十郎", "1987-05-17", "080-2222-1004", s1.id, "deleted"],
    ["210002C002", "現場", "十一", "1999-09-02", "080-3333-1002", s2.id, "applying"],
    ["210002C003", "現場", "十二", "1992-12-25", "080-3333-1003", s2.id, "registered"],
    ["150008C002", "関西", "十三", "1986-04-14", "080-4444-1002", p2.id, "provisional"],
    ["150008C003", "関西", "十四", "1997-08-19", "080-4444-1003", p2.id, "registered"],
    ["250008C002", "近畿", "十五", "1990-11-05", "080-5555-1002", s3.id, "applying"],
    ["250009C001", "浪速", "十六", "1993-02-28", "080-6666-1001", s4.id, "registered"],
    ["250009C002", "浪速", "十七", "1995-06-11", "080-6666-1002", s4.id, "provisional"],
    ["190001C001", "北海", "十八", "1988-07-21", "080-7777-1001", p3.id, "suspended"],
  ];
  for (const [salesId, lastName, firstName, birthDate, phone, agencyId, status] of staffData) {
    const isRegistered = status === "registered";
    let accountId: string | null = null;
    if (isRegistered) {
      const acc = await prisma.account.upsert({
        where: { loginId: salesId },
        update: {},
        create: {
          loginId: salesId,
          role: "R9",
          name: `${lastName} ${firstName}`,
          agencyId,
          status: "active",
          passwordHash: hash(PASSWORDS.general),
          pepperVersion: PEPPER_VERSION,
          mustChangePassword: MUST_CHANGE_PASSWORD,
        },
      });
      accountId = acc.id;
    }
    await prisma.salesStaff.upsert({
      where: { salesId },
      update: {},
      create: {
        salesId,
        lastName,
        firstName,
        birthDate,
        phone,
        agencyId,
        status,
        firstApproved: status !== "applying",
        accountId,
        // 削除済みは論理削除日時を持たせる（§3.4。棚卸CSVの削除日時列・匿名化バッチの対象条件）
        ...(status === "deleted" ? { deletedAt: new Date("2026-06-15") } : {}),
        history: [{ event: "requested", at: "2026-07-01", by: "seed" }],
      },
    });
  }

  // ダミー販売員（R4用）
  for (let i = 1; i <= 3; i++) {
    await prisma.salesStaff.upsert({
      where: { salesId: `990001C00${i}` },
      update: {},
      create: {
        salesId: `990001C00${i}`,
        lastName: "見本",
        firstName: `販売員${i}`,
        birthDate: "1990-01-01",
        phone: "080-0000-0000",
        agencyId: i === 1 ? d1.id : d2.id,
        status: i === 3 ? "applying" : "registered",
        firstApproved: i !== 3,
      },
    });
  }

  // ---- 日報（当月分のサンプル）----
  const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  const staff1 = await prisma.salesStaff.findUnique({ where: { salesId: "210001C001" } });
  const staff2 = await prisma.salesStaff.findUnique({ where: { salesId: "110001C001" } });
  if (staff1 && staff2) {
    // §9-4「日報1ヶ月分（訪販・テレマ両方、月初見込あり）」: 当月1日〜末日を生成する。
    // 値は日付から決まる決定的な擬似乱数（再実行しても同じデータ）。
    const daysInMonth = new Date(
      Number(month.slice(0, 4)),
      Number(month.slice(5, 7)),
      0
    ).getUTCDate();
    const pseudo = (seed: number, min: number, max: number) =>
      min + (((seed * 2654435761) % 4294967296) % (max - min + 1));
    const reports: [string, string, number, number, number, number, number][] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      for (const [idx, st] of [staff1, staff2].entries()) {
        const s = d * 10 + idx;
        reports.push([
          date,
          st.id,
          pseudo(s, 0, 3), // 獲得
          pseudo(s + 1, 1, 3), // 稼働
          pseudo(s + 2, 40, 120), // 訪問
          pseudo(s + 3, 10, 45), // 対面
          pseudo(s + 4, 5, 33), // 商談
        ]);
      }
    }
    for (const [date, salesStaffId, acq, workers, visits, meetings, negotiations] of reports) {
      const st = salesStaffId === staff1.id ? staff1 : staff2;
      await prisma.dailyReport.upsert({
        where: { date_type_salesStaffId: { date, type: "訪販", salesStaffId } },
        update: {},
        create: {
          date,
          type: "訪販",
          salesStaffId,
          agencyId: st.agencyId,
          area: "新宿区",
          forecastAcq: 30,
          acquisitions: acq,
          workers,
          visits,
          meetings,
          negotiations,
          contracts: Math.min(acq, negotiations),
          activityContent: "戸建てエリアの巡回訪問",
          activityResult: "在宅率高め、好反応",
        },
      });
    }
    // テレマ日報も当月1ヶ月分（月初見込は初日のみ。要件6-3の「初回提出時のみ」に整合）
    for (let d = 1; d <= daysInMonth; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      const s = d * 7;
      await prisma.dailyReport.upsert({
        where: { date_type_salesStaffId: { date, type: "テレマ", salesStaffId: staff2.id } },
        update: {},
        create: {
          date,
          type: "テレマ",
          salesStaffId: staff2.id,
          agencyId: staff2.agencyId,
          ...(d === 1 ? { forecastHours: 160, forecastEntries: 200 } : {}),
          actualHours: pseudo(s, 5, 8) + 0.5,
          entries: pseudo(s + 1, 8, 20),
          appointments: pseudo(s + 2, 1, 6),
          closePassed: pseudo(s + 3, 0, 4),
          preConfirmPassed: pseudo(s + 4, 0, 3),
          activityContent: "既存リストへの架電",
          activityResult: "アポ獲得あり",
        },
      });
    }
  }

  // ---- ステータスマスタ（§7.8「値はマスタ化して増減できる実装に」）----
  // 既定の5値をマスタへ投入しておく。マスタが空だとコード側の既定値にフォールバックするが、
  // 空のまま1件だけ追加すると既存の5値が選択肢から消え、既存案件のステータス変更ができなくなる。
  // マスタを正にするため、初期値としてここで投入する（増減は管理者がDB/画面から行う）。
  const CASE_STATUS_MASTER: [string, number, string][] = [
    ["未対応", 10, "gray"],
    ["確認中", 20, "blue"],
    ["対応中", 30, "blue"],
    ["問題発生", 40, "red"],
    ["完了", 50, "green"],
  ];
  for (const [value, sortOrder, tone] of CASE_STATUS_MASTER) {
    await prisma.statusMaster.upsert({
      where: { kind_value: { kind: "case", value } },
      update: {},
      create: { kind: "case", value, sortOrder, tone, active: true },
    });
  }

  // ---- 窓口案件 ----
  const r7 = await prisma.account.findUnique({ where: { loginId: "airis_1110001_001" } });
  const mkCase = async (
    series: string,
    no: string,
    tpl: string,
    title: string,
    status: string,
    deadline: string,
    primaryId: string
  ) => {
    const exists = await prisma.case.findUnique({ where: { caseNo: no } });
    if (exists) return exists;
    const c = await prisma.case.create({
      data: {
        series,
        caseNo: no,
        templateKind: tpl,
        title,
        primaryAgencyId: primaryId,
        ispNumber: "9999999999",
        deadline,
        status,
        createdBy: series === "HL" ? "airis_snc_spt1_001" : "airis_snc_spt2_001",
      },
    });
    await prisma.caseMessage.create({
      data: {
        caseId: c.id,
        senderSide: "snc",
        senderName: series === "HL" ? "ホットライン窓口" : "消費者センター窓口",
        body: "■依頼理由\n顧客からの問い合わせ対応のため\n\n■顧客情報\nISP受付番号：9999999999\n代理店コード：110001\n代理店名称：東都ネットワーク販売株式会社",
      },
    });
    if (r7) {
      await prisma.notification.create({
        data: {
          accountId: r7.id,
          title: `新しい${series === "HL" ? "ホットライン" : "消費者センター"}案件`,
          body: title,
          link: "/agency-cases",
        },
      });
    }
    return c;
  };
  const dl = (d: number) =>
    new Date(Date.now() + d * 86400000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
  await mkCase(
    "HL",
    "HLC-1000000000001",
    "代理店確認依頼",
    "代理店確認依頼／東都ネットワーク販売株式会社／9999999999",
    "確認中",
    dl(3),
    p1.id
  );
  await mkCase(
    "HL",
    "HLC-1000000000002",
    "音声提出依頼",
    "音声提出依頼／東都ネットワーク販売株式会社／9999999999",
    "未対応",
    dl(-1),
    p1.id
  );
  await mkCase(
    "CSC",
    "CSC-1000000000001",
    "代理店様から顧客への架電依頼",
    "代理店様から顧客への架電依頼／東都ネットワーク販売株式会社／9999999999",
    "対応中",
    dl(5),
    p1.id
  );

  // §9-4「HL/CSC案件各5件（未対応/確認中/期限超過/完了、返信ラリー付き）」を満たすよう補充する。
  // 既存3件に加えて各5件へ増やし、ステータスを網羅し、SNC⇔代理店の往復メッセージを入れる。
  const extraCases: [string, string, string, string, string, string][] = [
    // [series, caseNo, templateKind, status, deadline, primaryAgencyId]
    ["HL", "HLC-1000000000003", "代理店様から顧客への架電依頼", "完了", dl(-10), p1.id],
    ["HL", "HLC-1000000000004", "フリー入力", "対応中", dl(7), p2.id],
    ["HL", "HLC-1000000000005", "音声提出依頼", "問題発生", dl(-3), p2.id],
    ["CSC", "CSC-1000000000002", "代理店確認依頼", "確認中", dl(2), p1.id],
    ["CSC", "CSC-1000000000003", "音声提出依頼", "完了", dl(-8), p2.id],
    ["CSC", "CSC-1000000000004", "フリー入力", "未対応", dl(-2), p2.id],
    ["CSC", "CSC-1000000000005", "代理店様から顧客への架電依頼", "対応中", dl(9), p1.id],
  ];
  for (const [series, no, tpl, status, deadline, primaryId] of extraCases) {
    const label = series === "HL" ? "ホットライン窓口" : "消費者センター窓口";
    const agencyName =
      primaryId === p1.id ? "東都ネットワーク販売株式会社" : "関西モバイルサポート株式会社";
    const c = await mkCase(
      series,
      no,
      tpl,
      `${tpl}／${agencyName}／9999999999`,
      status,
      deadline,
      primaryId
    );
    // 返信ラリー（SNC→代理店→SNC→代理店の往復。既存メッセージがある場合は追加しない）
    const msgCount = await prisma.caseMessage.count({ where: { caseId: c.id } });
    if (msgCount <= 1) {
      const rally: [string, string, string][] = [
        ["agency", "代理店担当", "ご連絡ありがとうございます。担当者に確認のうえ折り返します。"],
        ["snc", label, "ご確認ありがとうございます。期限までのご回答をお願いします。"],
        ["agency", "代理店担当", "確認が取れました。対応内容を報告します。"],
      ];
      if (status === "完了") {
        rally.push(["snc", label, "ご対応ありがとうございました。本件は完了とします。"]);
      }
      for (const [senderSide, senderName, body] of rally) {
        await prisma.caseMessage.create({ data: { caseId: c.id, senderSide, senderName, body } });
      }
      // ステータス履歴（§7.8: ステータス変更の履歴を残す）
      await prisma.caseStatusHistory.create({
        data: { caseId: c.id, fromStatus: "未対応", toStatus: status, changedBy: "seed" },
      });
    }
  }

  // ---- 訪販員申請（§9-3: 10件。申請中/仮登録/本登録・稼働/抹消を混在）----
  const faStaff = await prisma.salesStaff.findMany({
    where: {
      salesId: { not: null },
      status: { in: ["registered", "provisional"] },
      agency: { isDummy: false },
    },
    include: { agency: true },
    orderBy: { salesId: "asc" },
    take: 10,
  });
  const FA_STATUS = ["applying", "provisional", "registered"] as const;
  const FA_TYPE = ["稼働", "抹消"] as const;
  const FA_PRODUCT = ["マルチ", "auひかり", "コラボ"] as const;
  const FA_ATTR = ["社員/契約社員", "パート・アルバイト", "業務委託社員", "個人事業主"] as const;
  for (const [i, st] of faStaff.entries()) {
    const pledgeNo = `PL-2026-${String(i + 1).padStart(3, "0")}`;
    const exists = await prisma.fieldAgentApplication.findFirst({ where: { pledgeNo } });
    if (exists) continue;
    const status = FA_STATUS[i % FA_STATUS.length];
    const attribute = FA_ATTR[i % FA_ATTR.length];
    const isContractor = attribute === "業務委託社員";
    const parent = st.agency.parentId
      ? await prisma.agency.findUnique({ where: { id: st.agency.parentId } })
      : null;
    await prisma.fieldAgentApplication.create({
      data: {
        salesStaffId: st.id,
        // 代理店スコープ列（§3.1。RLSとアプリ層がこの2列で直接判定するため必ず埋める）
        primaryAgencyId: st.agency.tier === 1 ? st.agency.id : st.agency.parentId,
        secondaryAgencyId: st.agency.tier === 2 ? st.agency.id : null,
        applicationType: FA_TYPE[i % FA_TYPE.length],
        products: FA_PRODUCT[i % FA_PRODUCT.length],
        attribute,
        lastNameKana: "ヤマダ",
        firstNameKana: "タロウ",
        identityType: "免許証",
        pledgeNo,
        startDate: `${month}-01`,
        agencyCode1: (parent ?? st.agency).code,
        agencyCode2: st.agency.tier === 2 ? st.agency.code : null,
        ...(isContractor
          ? {
              contractorName: "株式会社サンプル業務委託",
              contractorAddress: "東京都新宿区西新宿1-1-1",
              contractorPhone: "03-1234-5678",
            }
          : {}),
        status,
        firstApproved: status !== "applying",
        ...(status === "registered" ? { workMonth: month } : {}),
        primaryAgencyName: (parent ?? st.agency).name,
        agencyName: st.agency.name,
        history: [{ event: "requested", at: `${month}-01`, by: "seed" }],
      },
    });
  }

  // ---- 稼働提出物（§9-4: 提出済み/承認中/差戻し を混在。未提出は行が無いことで表現）----
  // 6様式（src/lib/roles.ts の SUBMISSION_KINDS と同一。seedはsrcに依存しないため値を持つ）
  const SUB_KINDS = [
    "【アライアンス申請書】",
    "【訪販用】稼働エリア申請フォーマット",
    "【ポスティング用】配布エリア申請フォーマット",
    "【独自特典】申請シート",
    "【催事用】稼働エリア申請フォーマット",
    "環境ヒアリングシート",
  ];
  const subAgencies = [
    { primary: p1, submitter: p1 },
    { primary: p1, submitter: s1 },
    { primary: p2, submitter: p2 },
  ];
  const SUB_STATUS = ["pending_first", "pending_snc", "approved", "rejected"] as const;
  let subIdx = 0;
  for (const { primary, submitter } of subAgencies) {
    // 6様式のうち4様式のみ提出（残り2様式は「未提出」として n/6 表示を成立させる）
    for (const kind of SUB_KINDS.slice(0, 4)) {
      const exists = await prisma.submission.findFirst({
        where: { kind, targetMonth: month, submitterAgencyId: submitter.id },
      });
      if (exists) continue;
      const content = `${kind} ${submitter.name} ${month}（シードのサンプル）`;
      const stored = await prisma.storedFile.create({
        data: {
          name: `${kind}_${submitter.code}_${month}.txt`,
          mime: "text/plain",
          size: Buffer.byteLength(content),
          data: Buffer.from(content),
          uploadedBy: "seed",
        },
      });
      const status = SUB_STATUS[subIdx % SUB_STATUS.length];
      subIdx++;
      await prisma.submission.create({
        data: {
          kind,
          fiscalYear: Number(month.slice(0, 4)),
          targetMonth: month,
          primaryAgencyId: primary.id,
          submitterAgencyId: submitter.id,
          fileId: stored.id,
          fileName: stored.name,
          status,
          ...(status === "rejected" ? { rejectReason: "記載内容に不備があるため差戻します" } : {}),
          history: [{ event: "submitted", at: `${month}-05`, by: "seed" }],
        },
      });
    }
  }

  // ---- お知らせ ----
  const annCount = await prisma.announcement.count();
  if (annCount === 0) {
    await prisma.announcement.create({
      data: {
        audience: "all",
        title: "【重要】8月度の提出物締切について",
        important: true,
        body: "8月度の稼働提出物は8月25日までに提出をお願いします。\n未提出の場合は稼働継続に影響する場合があります。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "all",
        title: "夏季休業期間のサポート窓口について",
        body: "8月13日〜15日は窓口対応をお休みします。緊急時はAiris内の窓口案件からご連絡ください。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "primary",
        title: "【1次店向け】下期インセンティブ制度の説明会",
        body: "9月開始の新インセンティブ制度について、オンライン説明会を実施します。",
        sentAt: new Date(),
        createdBy: "airis_snc_adm_001",
      },
    });
    // §9-4「お知らせ5件（重要1件）」: 上記3件に加えて2件（重要フラグは上の1件のみ）
    await prisma.announcement.create({
      data: {
        audience: "all",
        title: "販売員IDの一括申請CSVひな形を更新しました",
        body: "ひな形の2行目に記入例を追加しました。取込時は記入例の行を実データに書き換えてご利用ください。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "primary",
        title: "【1次店向け】訪販員申請の受付スケジュール",
        body: "翌月稼働分の訪販員申請は前月20日までに提出をお願いします。誓約書PDFの命名規則にご注意ください。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
  }

  // ---- ④ダミー表示用の業務データ（§3.5 / §9-5）----
  // ④はダミー代理店スコープのみを参照するため、各画面が空表示にならないよう
  // 訪販員申請・日報・提出物・アカウントもダミー代理店配下に投入する。
  const dummyStaff = await prisma.salesStaff.findMany({
    where: { agency: { isDummy: true } },
    include: { agency: true },
    orderBy: { salesId: "asc" },
  });
  for (const [i, st] of dummyStaff.entries()) {
    // 訪販員申請（ダミー）
    const pledgeNo = `PL-SAMPLE-${String(i + 1).padStart(3, "0")}`;
    if (!(await prisma.fieldAgentApplication.findFirst({ where: { pledgeNo } }))) {
      await prisma.fieldAgentApplication.create({
        data: {
          salesStaffId: st.id,
          // 代理店スコープ列（§3.1。④のダミー表示もこの2列で絞られる）
          primaryAgencyId: st.agency.tier === 1 ? st.agency.id : st.agency.parentId,
          secondaryAgencyId: st.agency.tier === 2 ? st.agency.id : null,
          applicationType: i % 2 === 0 ? "稼働" : "抹消",
          products: ["マルチ", "auひかり", "コラボ"][i % 3],
          attribute: "社員/契約社員",
          lastNameKana: "ミホン",
          firstNameKana: "タロウ",
          identityType: "免許証",
          pledgeNo,
          startDate: `${month}-01`,
          agencyCode1: st.agency.tier === 1 ? st.agency.code : "990001",
          agencyCode2: st.agency.tier === 2 ? st.agency.code : null,
          status: ["applying", "provisional", "registered"][i % 3],
          firstApproved: i % 3 !== 0,
          ...(i % 3 === 2 ? { workMonth: month } : {}),
          primaryAgencyName: "サンプル一次代理店株式会社",
          agencyName: st.agency.name,
          history: [{ event: "requested", at: `${month}-01`, by: "seed" }],
        },
      });
    }
    // 日報（ダミー・当月5日分）
    for (let d = 1; d <= 5; d++) {
      const date = `${month}-${String(d).padStart(2, "0")}`;
      await prisma.dailyReport.upsert({
        where: { date_type_salesStaffId: { date, type: "訪販", salesStaffId: st.id } },
        update: {},
        create: {
          date,
          type: "訪販",
          salesStaffId: st.id,
          agencyId: st.agencyId,
          area: "サンプル区",
          forecastAcq: 10,
          acquisitions: d % 3,
          workers: 1,
          visits: 30 + d,
          meetings: 10 + d,
          negotiations: 5 + d,
          contracts: d % 2,
          activityContent: "（架空データ）サンプル巡回",
          activityResult: "（架空データ）反応良好",
        },
      });
    }
  }
  // 提出物（ダミー・4様式のみ提出＝未提出2様式が残る）
  if (dummyStaff.length > 0) {
    for (const kind of SUB_KINDS.slice(0, 4)) {
      if (
        await prisma.submission.findFirst({
          where: { kind, targetMonth: month, submitterAgencyId: d1.id },
        })
      )
        continue;
      const content = `（架空データ）${kind} サンプル一次代理店株式会社 ${month}`;
      const stored = await prisma.storedFile.create({
        data: {
          name: `SAMPLE_${kind}_${month}.txt`,
          mime: "text/plain",
          size: Buffer.byteLength(content),
          data: Buffer.from(content),
          uploadedBy: "seed",
        },
      });
      await prisma.submission.create({
        data: {
          kind,
          fiscalYear: Number(month.slice(0, 4)),
          targetMonth: month,
          primaryAgencyId: d1.id,
          submitterAgencyId: d1.id,
          fileId: stored.id,
          fileName: stored.name,
          status: ["pending_first", "pending_snc", "approved", "rejected"][
            SUB_KINDS.indexOf(kind) % 4
          ],
          history: [{ event: "submitted", at: `${month}-05`, by: "seed" }],
        },
      });
    }
  }
  // アカウント（ダミー・管理画面のダミー表示用）
  for (const [i, ag] of [d1, d2].entries()) {
    const loginId = `airis_1${ag.code}_00${i + 1}`;
    await prisma.account.upsert({
      where: { loginId },
      update: {},
      create: {
        loginId,
        role: ag.tier === 1 ? "R7" : "R8",
        name: `見本 ${ag.tier === 1 ? "一次" : "二次"}管理者`,
        agencyId: ag.id,
        status: "active",
        passwordHash: hash(PASSWORDS.general),
        pepperVersion: PEPPER_VERSION,
        mustChangePassword: MUST_CHANGE_PASSWORD,
        email: `${loginId}@example.com`,
      },
    });
  }

  // ---- ④ダミー表示用のお知らせ・ドキュメント（§3.5 / §5.2。実データと isDummy で分離）----
  const dummyAnnCount = await prisma.announcement.count({ where: { isDummy: true } });
  if (dummyAnnCount === 0) {
    await prisma.announcement.create({
      data: {
        audience: "all",
        title: "【サンプル】システムメンテナンスのお知らせ",
        isDummy: true,
        body: "（架空データ）8月20日 2:00〜5:00 にシステムメンテナンスを実施します。期間中はAirisをご利用いただけません。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "all",
        title: "【サンプル・重要】当月提出物の締切について",
        important: true,
        isDummy: true,
        body: "（架空データ）当月の稼働提出物は25日までに提出をお願いします。",
        sentAt: new Date(),
        createdBy: "airis_snc_ops_0001",
      },
    });
  }
  // ---- ドキュメント（実データ。§9-4 / §7.12 公開範囲 all / primary / snc を網羅）----
  // Document には一意キーが無いためタイトルで存在確認して冪等にする（既存行は変更しない）
  const realDocs: [string, string, string, string, string][] = [
    // [title, category, visibility, fileName, content]
    [
      "販売代理店向け 業務マニュアル",
      "マニュアル",
      "all",
      "airis-sales-manual.txt",
      "Airis 販売代理店向け業務マニュアル（サンプル本文）。日報・提出物の提出手順を記載。",
    ],
    [
      "1次代理店向け 2次店管理ガイド",
      "マニュアル",
      "primary",
      "primary-agency-guide.txt",
      "1次代理店向け 2次店管理ガイド（サンプル本文）。2次店の申請・1次承認の運用手順を記載。",
    ],
    [
      "SNC内部 運用手順書（社内限り）",
      "運用",
      "snc",
      "snc-operation-manual.txt",
      "SNC内部向け運用手順書（サンプル本文）。エリア営業SVの承認オペレーションを記載。",
    ],
  ];
  for (const [title, category, visibility, fileName, content] of realDocs) {
    const exists = await prisma.document.findFirst({ where: { title, isDummy: false } });
    if (exists) continue;
    const stored = await prisma.storedFile.create({
      data: {
        name: fileName,
        mime: "text/plain",
        size: Buffer.byteLength(content),
        data: Buffer.from(content),
        uploadedBy: "airis_snc_ops_0001",
      },
    });
    await prisma.document.create({
      data: {
        title,
        category,
        visibility,
        fileId: stored.id,
        fileName: stored.name,
        createdBy: "airis_snc_ops_0001",
      },
    });
  }

  const dummyDocCount = await prisma.document.count({ where: { isDummy: true } });
  if (dummyDocCount === 0) {
    const dummyDocs: [string, string, string][] = [
      // [title, fileName, content]
      [
        "【サンプル】販売マニュアル",
        "sample-sales-manual.txt",
        "（架空データ）サンプル販売マニュアルです。",
      ],
      ["【サンプル】通知書類", "sample-notice.txt", "（架空データ）サンプル通知書類です。"],
    ];
    for (const [title, fileName, content] of dummyDocs) {
      const stored = await prisma.storedFile.create({
        data: {
          name: fileName,
          mime: "text/plain",
          size: Buffer.byteLength(content),
          data: Buffer.from(content),
          uploadedBy: null,
        },
      });
      await prisma.document.create({
        data: {
          title,
          category: "サンプル",
          visibility: "all",
          isDummy: true,
          fileId: stored.id,
          fileName: stored.name,
          createdBy: "airis_snc_ops_0001",
        },
      });
    }
  }

  console.log("Seed complete.");
  console.log("== ログイン情報 ==");
  console.log(
    SEED_DEMO
      ? "初回パスワード変更フラグ: OFF（SEED_DEMO=1 のデモ・E2E用。そのままダッシュボードへ入れる）"
      : "初回パスワード変更フラグ: ON（§9-1。初回ログイン時にパスワード変更が必要。" +
          "デモ・E2Eで省略したい場合は SEED_DEMO=1 を付けて再シードする）"
  );
  console.log(`ペッパーのバージョンID: ${PEPPER_VERSION ?? "（ペッパー未設定）"}`);
  console.log(`管理者系(①②③⑦): パスワード ${PASSWORDS.admin}`);
  console.log(`一般系(④⑤⑥⑧⑨): パスワード ${PASSWORDS.general}`);
  console.log(
    "MFAデモ用アカウント(②〜⑩ 各10): airis_snc_adm_002〜011 / airis_snc_ops_0002〜0011 / " +
      "airis_snc_vew_002〜011 / airis_snc_spt1_002〜011 / airis_snc_spt2_002〜011 / " +
      "airis_1110001_002〜011 / airis_2210001_002〜011 / 110001C101〜C110 / airis_1190001_002〜011"
  );
}

main().finally(() => prisma.$disconnect());
