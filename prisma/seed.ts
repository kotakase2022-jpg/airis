import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
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

  console.log("Seed complete.");
  console.log("== ログイン情報 ==");
  console.log(`管理者系(①②③⑦): パスワード ${PASSWORDS.admin}`);
  console.log(`一般系(④⑤⑥⑧⑨): パスワード ${PASSWORDS.general}`);
}

main().finally(() => prisma.$disconnect());
