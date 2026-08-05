import { PrismaClient } from "@prisma/client";
// パスワードのハッシュ化はアプリ実装と同一方式（Argon2id + 環境変数ペッパー §2/§10.3）を使う。
// 独自にbcryptでハッシュすると、アプリの verifyPassword と方式が食い違いログインできなくなる。
import { hashSync as argon2HashSync } from "@node-rs/argon2";
import crypto from "crypto";

// RLS(FORCE)適用後もシードできるよう、接続オプションで app.bypass=on を設定
// （Neonはプール接続でoptionsが通らないため、DATABASE_URL_UNPOOLED等の直接接続URLを使うこと）
const baseUrl = process.env.DATABASE_URL!;
const seedUrl = baseUrl + (baseUrl.includes("?") ? "&" : "?") + "options=-c%20app.bypass%3Don";
const prisma = new PrismaClient({ datasourceUrl: seedUrl });
// src/lib/auth.ts と同一のパラメータ・ペッパー適用（変更時は両方を揃えること）
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;
const pepper = process.env.PASSWORD_PEPPER_V1 ?? "";
const prehash = (pw: string) =>
  pepper ? crypto.createHmac("sha256", pepper).update(pw, "utf8").digest("hex") : pw;
const hash = (pw: string) => argon2HashSync(prehash(pw), ARGON2_OPTIONS);

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
  // §9-2: 1次店×3、各配下に2次店2〜3店。150008配下・190001配下を補充する（既存行は update: {} で不変更）
  await prisma.agency.upsert({
    where: { code: "250009" }, update: {},
    create: { code: "250009", name: "株式会社なにわ通信サービス", tier: 2, parentId: p2.id, representative: "渡辺 七郎", joinedAt: new Date("2025-03-01") },
  });
  // 稼働終了1次店（190001）配下は、親に合わせて稼働終了で登録する（§4.1 / §14-2）
  await prisma.agency.upsert({
    where: { code: "290001" }, update: {},
    create: { code: "290001", name: "札幌フィールドサービス株式会社", tier: 2, parentId: p3.id, representative: "中村 八郎", status: "closed", joinedAt: new Date("2023-11-01") },
  });
  await prisma.agency.upsert({
    where: { code: "290002" }, update: {},
    create: { code: "290002", name: "株式会社道東セールス", tier: 2, parentId: p3.id, representative: "小林 九郎", status: "closed", joinedAt: new Date("2024-02-01") },
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
      [`airis_1190001_${n3}`, "R7", `北海道テレコム 管理者${i}（稼働終了→⑩）`, p3.id, PASSWORDS.admin]
    );
  }
  for (const [loginId, role, name, agencyId, pw] of bulkAccounts) {
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
  // ⑨（販売員）×10: 110001C101〜C110（既存デモ販売員と重複しない番号帯）
  for (let i = 1; i <= 10; i++) {
    const salesId = `110001C${String(100 + i)}`;
    const acc = await prisma.account.upsert({
      where: { loginId: salesId }, update: {},
      create: {
        loginId: salesId, role: "R9", name: `MFAデモ 販売員${i}`, agencyId: p1.id,
        status: "active", passwordHash: hash(PASSWORDS.general), mustChangePassword: false,
      },
    });
    await prisma.salesStaff.upsert({
      where: { salesId }, update: {},
      create: {
        salesId, lastName: "MFAデモ", firstName: `販売員${i}`,
        birthDate: "1995-01-15", phone: `080-9999-9${String(100 + i)}`,
        agencyId: p1.id, status: "registered", firstApproved: true,
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

  // ---- ④ダミー表示用のお知らせ・ドキュメント（§3.5 / §5.2。実データと isDummy で分離）----
  const dummyAnnCount = await prisma.announcement.count({ where: { isDummy: true } });
  if (dummyAnnCount === 0) {
    await prisma.announcement.create({
      data: {
        audience: "all", title: "【サンプル】システムメンテナンスのお知らせ", isDummy: true,
        body: "（架空データ）8月20日 2:00〜5:00 にシステムメンテナンスを実施します。期間中はAirisをご利用いただけません。",
        sentAt: new Date(), createdBy: "airis_snc_ops_0001",
      },
    });
    await prisma.announcement.create({
      data: {
        audience: "all", title: "【サンプル・重要】当月提出物の締切について", important: true, isDummy: true,
        body: "（架空データ）当月の稼働提出物は25日までに提出をお願いします。",
        sentAt: new Date(), createdBy: "airis_snc_ops_0001",
      },
    });
  }
  // ---- ドキュメント（実データ。§9-4 / §7.12 公開範囲 all / primary / snc を網羅）----
  // Document には一意キーが無いためタイトルで存在確認して冪等にする（既存行は変更しない）
  const realDocs: [string, string, string, string, string][] = [
    // [title, category, visibility, fileName, content]
    ["販売代理店向け 業務マニュアル", "マニュアル", "all", "airis-sales-manual.txt", "Airis 販売代理店向け業務マニュアル（サンプル本文）。日報・提出物の提出手順を記載。"],
    ["1次代理店向け 2次店管理ガイド", "マニュアル", "primary", "primary-agency-guide.txt", "1次代理店向け 2次店管理ガイド（サンプル本文）。2次店の申請・1次承認の運用手順を記載。"],
    ["SNC内部 運用手順書（社内限り）", "運用", "snc", "snc-operation-manual.txt", "SNC内部向け運用手順書（サンプル本文）。エリア営業SVの承認オペレーションを記載。"],
  ];
  for (const [title, category, visibility, fileName, content] of realDocs) {
    const exists = await prisma.document.findFirst({ where: { title, isDummy: false } });
    if (exists) continue;
    const stored = await prisma.storedFile.create({
      data: {
        name: fileName, mime: "text/plain",
        size: Buffer.byteLength(content), data: Buffer.from(content), uploadedBy: "airis_snc_ops_0001",
      },
    });
    await prisma.document.create({
      data: {
        title, category, visibility,
        fileId: stored.id, fileName: stored.name, createdBy: "airis_snc_ops_0001",
      },
    });
  }

  const dummyDocCount = await prisma.document.count({ where: { isDummy: true } });
  if (dummyDocCount === 0) {
    const dummyDocs: [string, string, string][] = [
      // [title, fileName, content]
      ["【サンプル】販売マニュアル", "sample-sales-manual.txt", "（架空データ）サンプル販売マニュアルです。"],
      ["【サンプル】通知書類", "sample-notice.txt", "（架空データ）サンプル通知書類です。"],
    ];
    for (const [title, fileName, content] of dummyDocs) {
      const stored = await prisma.storedFile.create({
        data: {
          name: fileName, mime: "text/plain",
          size: Buffer.byteLength(content), data: Buffer.from(content), uploadedBy: null,
        },
      });
      await prisma.document.create({
        data: {
          title, category: "サンプル", visibility: "all", isDummy: true,
          fileId: stored.id, fileName: stored.name, createdBy: "airis_snc_ops_0001",
        },
      });
    }
  }

  console.log("Seed complete.");
  console.log("== ログイン情報 ==");
  console.log(`管理者系(①②③⑦): パスワード ${PASSWORDS.admin}`);
  console.log(`一般系(④⑤⑥⑧⑨): パスワード ${PASSWORDS.general}`);
  console.log(
    "MFAデモ用アカウント(②〜⑩ 各10): airis_snc_adm_002〜011 / airis_snc_ops_0002〜0011 / " +
      "airis_snc_vew_002〜011 / airis_snc_spt1_002〜011 / airis_snc_spt2_002〜011 / " +
      "airis_1110001_002〜011 / airis_2210001_002〜011 / 110001C101〜C110 / airis_1190001_002〜011"
  );
}

main().finally(() => prisma.$disconnect());
