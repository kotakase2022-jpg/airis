import { describe, it, expect } from "vitest";
import {
  MENU,
  canAccess,
  isDummyView,
  REQUESTABLE_ROLES,
  type PageKey,
  type Role,
} from "@/lib/roles";

const ALL_ROLES: Role[] = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"];

// §5.2 ページアクセス / §11.1 メニュー出し分けのマトリクス（〇のロールのみ列挙）
const PAGE_ACCESS: { page: PageKey; allowed: Role[] }[] = [
  { page: "dashboard", allowed: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10"] },
  { page: "account-requests", allowed: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"] },
  { page: "sales-staff", allowed: ["R1", "R2", "R3", "R4", "R7", "R8"] },
  { page: "field-agents", allowed: ["R1", "R2", "R3", "R4", "R7", "R8"] },
  { page: "reports", allowed: ["R1", "R2", "R3", "R4", "R7", "R8", "R9"] },
  { page: "agencies", allowed: ["R1", "R2", "R3", "R4", "R7"] },
  // ③は発注者指示（2026-08-05）で管理画面〇
  { page: "admin", allowed: ["R1", "R2", "R3", "R4"] },
  { page: "hotline", allowed: ["R1", "R2", "R3", "R5"] },
  { page: "consumer-center", allowed: ["R1", "R2", "R3", "R6"] },
  { page: "agency-cases", allowed: ["R7", "R10"] },
  { page: "announcements", allowed: ["R1", "R2", "R3", "R4", "R7", "R8", "R9"] },
  { page: "documents", allowed: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] },
];

// §11.1: ④（SNC閲覧）がダミー表示になるページ
const DUMMY_PAGES: PageKey[] = [
  "sales-staff",
  "field-agents",
  "reports",
  "agencies",
  "admin",
  "announcements",
  "documents",
];

describe("canAccess（§5.2 ページアクセスマトリクス・テーブル駆動）", () => {
  it.each(PAGE_ACCESS)("$page: 許可ロールのみ true", ({ page, allowed }) => {
    for (const role of ALL_ROLES) {
      expect(canAccess(role, page), `${role} × ${page}`).toBe(allowed.includes(role));
    }
  });

  it("未定義ページは全ロール false", () => {
    for (const role of ALL_ROLES) {
      expect(canAccess(role, "no-such-page" as PageKey)).toBe(false);
    }
  });
});

describe("isDummyView（§11.1 ④はダミー表示）", () => {
  it.each(DUMMY_PAGES.map((p) => ({ page: p })))("$page: R4 のみダミー", ({ page }) => {
    for (const role of ALL_ROLES) {
      expect(isDummyView(role, page), `${role} × ${page}`).toBe(role === "R4");
    }
  });

  it("ダッシュボード・アカウント申請・窓口はダミー扱いにならない", () => {
    const nonDummy: PageKey[] = [
      "dashboard",
      "account-requests",
      "hotline",
      "consumer-center",
      "agency-cases",
    ];
    for (const page of nonDummy) {
      for (const role of ALL_ROLES) {
        expect(isDummyView(role, page), `${role} × ${page}`).toBe(false);
      }
    }
  });
});

describe("MENU（§11.1 の11項目 + 代理店向け統合ビュー）", () => {
  it("§11.1 の11項目が仕様の順序で並び、窓口案件を加えた12エントリ", () => {
    expect(MENU.map((m) => m.key)).toEqual([
      "dashboard",
      "account-requests",
      "sales-staff",
      "field-agents",
      "reports",
      "agencies",
      "admin",
      "hotline",
      "consumer-center",
      "agency-cases",
      "announcements",
      "documents",
    ]);
    expect(MENU).toHaveLength(12);
  });

  it("メニューラベルが §11.1 の名称に一致する", () => {
    const labels = Object.fromEntries(MENU.map((m) => [m.key, m.label]));
    expect(labels["dashboard"]).toBe("ダッシュボード");
    expect(labels["account-requests"]).toBe("Airisアカウント申請");
    expect(labels["sales-staff"]).toBe("販売員ID管理");
    expect(labels["field-agents"]).toBe("訪販員申請・管理");
    expect(labels["reports"]).toBe("各種資料の提出");
    expect(labels["agencies"]).toBe("下位代理店");
    expect(labels["admin"]).toBe("管理画面");
    expect(labels["hotline"]).toBe("ホットライン窓口");
    expect(labels["consumer-center"]).toBe("消費者センター窓口");
    expect(labels["agency-cases"]).toBe("窓口案件");
    expect(labels["announcements"]).toBe("お知らせ");
    expect(labels["documents"]).toBe("ドキュメント");
  });

  const visibleMenu = (role: Role): PageKey[] =>
    MENU.filter((m) => m.roles.includes(role)).map((m) => m.key);

  it("①（R1）は11項目すべてを表示し、窓口案件は表示しない", () => {
    expect(visibleMenu("R1")).toEqual([
      "dashboard",
      "account-requests",
      "sales-staff",
      "field-agents",
      "reports",
      "agencies",
      "admin",
      "hotline",
      "consumer-center",
      "announcements",
      "documents",
    ]);
  });

  it("⑦（R7）は個別窓口の代わりに統合ビュー「窓口案件」を表示する", () => {
    const menu = visibleMenu("R7");
    expect(menu).toContain("agency-cases");
    expect(menu).not.toContain("hotline");
    expect(menu).not.toContain("consumer-center");
    expect(menu).not.toContain("admin");
  });

  it("⑩（R10）はダッシュボードと窓口案件のみ", () => {
    expect(visibleMenu("R10")).toEqual(["dashboard", "agency-cases"]);
  });

  it("⑨（R9）はダッシュボード・アカウント申請なし・資料提出・お知らせ・ドキュメント", () => {
    expect(visibleMenu("R9")).toEqual(["dashboard", "reports", "announcements", "documents"]);
  });

  it("⑤（R5）はホットライン窓口を、⑥（R6）は消費者センター窓口を表示する", () => {
    expect(visibleMenu("R5")).toEqual(["dashboard", "account-requests", "hotline", "documents"]);
    expect(visibleMenu("R6")).toEqual([
      "dashboard",
      "account-requests",
      "consumer-center",
      "documents",
    ]);
  });
});

describe("REQUESTABLE_ROLES（§6.1 申請できるロールの範囲）", () => {
  const CASES: { requester: Role; expected: Role[] }[] = [
    // ①→①〜⑩すべて（⑨販売員はAirisアカウント対象外 §6.1見出し「①〜⑧⑩」）
    { requester: "R1", expected: ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"] },
    // ②→②〜⑩（①=保守ベンダーは申請不可。発注者指示 2026-08-05）
    { requester: "R2", expected: ["R2", "R3", "R4", "R5", "R6", "R7", "R8", "R10"] },
    // ③→③〜⑩
    { requester: "R3", expected: ["R3", "R4", "R5", "R6", "R7", "R8", "R10"] },
    // ④→④のみ / ⑤→⑤のみ / ⑥→⑥のみ
    { requester: "R4", expected: ["R4"] },
    { requester: "R5", expected: ["R5"] },
    { requester: "R6", expected: ["R6"] },
    // ⑦→⑦⑧ / ⑧→⑧のみ
    { requester: "R7", expected: ["R7", "R8"] },
    { requester: "R8", expected: ["R8"] },
    // ⑨⑩は申請不可
    { requester: "R9", expected: [] },
    { requester: "R10", expected: [] },
  ];

  it.each(CASES)("$requester が申請できるのは $expected", ({ requester, expected }) => {
    expect(REQUESTABLE_ROLES[requester]).toEqual(expected);
  });
});
