import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// RLS(FORCE)適用後もシードできるよう、接続オプションで app.bypass=on を設定
// （Neonはプール接続でoptionsが通らないため、DATABASE_URL_UNPOOLED等の直接接続URLを使うこと）
const baseUrl = process.env.DATABASE_URL!;
const seedUrl = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "options=-c%20app.bypass%3Don";
const prisma = new PrismaClient({ datasourceUrl: seedUrl });
const hash = (pw: string) => bcrypt.hashSync(pw, 10);

// デモ用初期パスワード（本番運用前に必ず変更すること）
export const PASSWORDS = {
  admin: "Airis-Demo-Admin-2026!x", // 20桁以上（①②③⑦）
  general: "Airis-Demo-2026!", // 14桁以上（④⑤⑥⑧⑨⑩）
};

async function main() {
  console.log("Seeding...");

  // ---- 代理店 ----
  const p1 = await prisma.agency.upsert({
    where: { code: "110001" }, update: {},
    create: { code: "110001", name: "東都ネットワーク販売株式会社", tier: 1, representative: "山田 一郎", joinedAt: new Date("2024-04-01") },
  });
  const p2 = await prisma.agency.upsert({
    where: { code: "150008" }, update: {},
    create: { code: "150008", name: "関西コミュニケーションズ株式会社", tier: 1, representative: "田中 次郎", joinedAt: new Date("2024-06-01") },
  });
  const p3 = await prisma.agency.upsert({
    where: { code: "190001" }, update: {},
    create: { code: "190001", name: "北海道テレコム販売株式会社", tier: 1, representative: "佐藤 三郎", status: "closed", joinedAt: new Date("2023-10-01") },
  });
  const s1 = await prisma.agency.upsert({
    where: { code: "210001" }, update: {},
    create: { code: "210001", name: "株式会社セールスパートナー東京", tier: 2, parentId: p1.id, representative: "鈴木 四郎", joinedAt: new Date("2024-08-01") },
  });
  const s2 = await prisma.agency.upsert({
    where: { code: "210002" }, update: {},
    create: { code: "210002", name: "株式会社フィールドプロ埼玉", tier: 2, parentId: p1.id, representative: "高橋 五郎", joinedAt: new Date("2025-01-15") },
  });
  const s3 = await prisma.agency.upsert({
    where: { code: "250008" }, update: {},
    create: { code: "250008", name: "近畿セールスサポート株式会社", tier: 2, parentId: p2.id, representative: "伊藤 六郎", joinedAt: new Date("2024-11-01") },
  });
  // ④ダミー表示用の架空データ
  const d1 = await prisma.agency.upsert({
    where: { code: "990001" }, update: {},
    create: { code: "990001", name: "サンプル一次代理店株式会社", tier: 1, representative: "見本 太郎", isDummy: true },
  });
  const d2 = await prisma.agency.upsert({
    where: { code: "991001" }, update: {},
    create: { code: "991001", name: "サンプル二次代理店株式会社", tier: 2, parentId: d1.id, representative: "見本 次郎", isDummy: true },
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
      where: { loginId }, update: {},
      create: {
        loginId, role, name, agencyId,
        status: "active",
        passwordHash: hash(pw),
        mustChangePassword: false, // デモ用（本番は true にすること）
        email: `${loginId}@example.com`,
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
  ];
  for (const [salesId, lastName, firstName, birthDate, phone, agencyId, status] of staffData) {
    const isRegistered = status === "registered";
    let accountId: string | null = null;
    if (isRegistered) {
      const acc = await prisma.account.upsert({
        where: { loginId: salesId }, update: {},
        create: {
          loginId: salesId, role: "R9", name: `${lastName} ${firstName}`, agencyId,
          status: "active", passwordHash: hash(PASSWORDS.general), mustChangePassword: false,
        },
      });
      accountId = acc.id;
    }
    await prisma.salesStaff.upsert({
      where: { salesId }, update: {},
      create: {
        salesId, lastName, firstName, birthDate, phone, agencyId, status,
        firstApproved: status !== "applying",
        accountId,
        history: [{ event: "requested", at: "2026-07-01", by: "seed" }],
      },
    });
  }

  // ダミー販売員（R4用）
  for (let i = 1; i <= 3; i++) {
    await prisma.salesStaff.upsert({
      where: { salesId: `990001C00${i}` }, update: {},
      create: {
        salesId: `990001C00${i}`, lastName: "見本", firstName: `販売員${i}`,
        birthDate: "1990-01-01", phone: "080-0000-0000", agencyId: i === 1 ? d1.id : d2.id,
        status: i === 3 ? "applying" : "registered", firstApproved: i !== 3,
      },
    });
  }

  // ---- 日報（当月分のサンプル）----
  const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
  const staff1 = await prisma.salesStaff.findUnique({ where: { salesId: "210001C001" } });
  const staff2 = await prisma.salesStaff.findUnique({ where: { salesId: "110001C001" } });
  if (staff1 && staff2) {
    const reports: [string, string, number, number, number, number, number][] = [
      // [date, staff, 獲得, 稼働, 訪問, 対面, 商談]
      [`${month}-01`, staff1.id, 1, 2, 67, 15, 8],
      [`${month}-02`, staff1.id, 2, 2, 93, 16, 7],
      [`${month}-03`, staff1.id, 0, 1, 55, 12, 10],
      [`${month}-01`, staff2.id, 2, 3, 113, 45, 33],
      [`${month}-02`, staff2.id, 1, 3, 58, 20, 12],
    ];
    for (const [date, salesStaffId, acq, workers, visits, meetings, negotiations] of reports) {
      const st = salesStaffId === staff1.id ? staff1 : staff2;
      await prisma.dailyReport.upsert({
        where: { date_type_salesStaffId: { date, type: "訪販", salesStaffId } },
        update: {},
        create: {
          date, type: "訪販", salesStaffId, agencyId: st.agencyId,
          area: "新宿区", forecastAcq: 30, acquisitions: acq, workers,
          visits, meetings, negotiations, contracts: Math.min(acq, negotiations),
          activityContent: "戸建てエリアの巡回訪問", activityResult: "在宅率高め、好反応",
        },
      });
    }
    await prisma.dailyReport.upsert({
      where: { date_type_salesStaffId: { date: `${month}-02`, type: "テレマ", salesStaffId: staff2.id } },
      update: {},
      create: {
        date: `${month}-02`, type: "テレマ", salesStaffId: staff2.id, agencyId: staff2.agencyId,
        forecastHours: 160, forecastEntries: 200, actualHours: 7.5, entries: 12,
        appointments: 3, closePassed: 2, preConfirmPassed: 1,
        activityContent: "既存リストへの架電", activityResult: "アポ3件獲得",
      },
    });
  }

  // ---- 窓口案件 ----
  const r7 = await prisma.account.findUnique({ where: { loginId: "airis_1110001_001" } });
  const mkCase = async (series: string, no: string, tpl: string, title: string, status: string, deadline: string, primaryId: string) => {
    const exists = await prisma.case.findUnique({ where: { caseNo: no } });
    if (exists) return exists;
    const c = await prisma.case.create({
      data: {
        series, caseNo: no, templateKind: tpl, title,
        primaryAgencyId: primaryId, ispNumber: "9999999999", deadline, status,
        createdBy: series === "HL" ? "airis_snc_spt1_001" : "airis_snc_spt2_001",
      },
    });
    await prisma.caseMessage.create({
      data: {
        caseId: c.id, senderSide: "snc",
        senderName: series === "HL" ? "ホットライン窓口" : "消費者センター窓口",
        body: "■依頼理由\n顧客からの問い合わせ対応のため\n\n■顧客情報\nISP受付番号：9999999999\n代理店コード：110001\n代理店名称：東都ネットワーク販売株式会社",
      },
    });
    if (r7) {
      await prisma.notification.create({
        data: { accountId: r7.id, title: `新しい${series === "HL" ? "ホットライン" : "消費者センター"}案件`, body: title, link: "/agency-cases" },
      });
    }
    return c;
  };
  const dl = (d: number) => new Date(Date.now() + d * 86400000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
  await mkCase("HL", "HLC-1000000000001", "代理店確認依頼", "代理店確認依頼／東都ネットワーク販売株式会社／9999999999", "確認中", dl(3), p1.id);
  await mkCase("HL", "HLC-1000000000002", "音声提出依頼", "音声提出依頼／東都ネットワーク販売株式会社／9999999999", "未対応", dl(-1), p1.id);
  await mkCase("CSC", "CSC-1000000000001", "代理店様から顧客への架電依頼", "代理店様から顧客への架電依頼／東都ネットワーク販売株式会社／9999999999", "対応中", dl(5), p1.id);

  // ---- お知らせ ----
  const annCount = await prisma.announcement.count();
  if (annCount === 0) {
    await prisma.announcement.create({
      data: {
        audience: "all", title: "【重要】8月度の提出物締切について", important: true,
        body: "8月度の稼働提出物は8月25日までに提出をお願いします。\n未提出の場合は稼働継続に影響する場合があります。",
        sentAt: new Date(), createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "all", title: "夏季休業期間のサポート窓口について",
        body: "8月13日〜15日は窓口対応をお休みします。緊急時はAiris内の窓口案件からご連絡ください。",
        sentAt: new Date(), createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "primary", title: "【1次店向け】下期インセンティブ制度の説明会",
        body: "9月開始の新インセンティブ制度について、オンライン説明会を実施します。",
        sentAt: new Date(), createdBy: "airis_snc_adm_001",
      },
    });
  }

  console.log("Seed complete.");
  console.log("== ログイン情報 ==");
  console.log(`管理者系(①②③⑦): パスワード ${PASSWORDS.admin}`);
  console.log(`一般系(④⑤⑥⑧⑨): パスワード ${PASSWORDS.general}`);
}

main().finally(() => prisma.$disconnect());
