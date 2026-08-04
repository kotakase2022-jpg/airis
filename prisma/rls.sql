-- PostgreSQL Row-Level Security（§3.1 多層防御）
-- セッション変数:
--   app.bypass = 'on'  … SNC系ロール/シード/管理バッチ（全行アクセス）
--   app.scope  = 'id1,id2,...' … 参照可能な代理店ID（代理店系ロール・④ダミー）
-- どちらも未設定の場合は既定拒否（fail-closed）。
-- 接続ユーザーがテーブルオーナーでも適用されるよう FORCE を併用。
-- 適用: npm run rls（scripts/apply-rls.ts）

-- ===== SalesStaff（販売員: agencyId 直接） =====
ALTER TABLE "SalesStaff" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SalesStaff" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "SalesStaff";
CREATE POLICY rls_scope ON "SalesStaff" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  );

-- ===== DailyReport（日報: agencyId 直接） =====
ALTER TABLE "DailyReport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DailyReport" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "DailyReport";
CREATE POLICY rls_scope ON "DailyReport" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  );

-- ===== Submission（提出物: 提出元 or 1次店がスコープ内） =====
ALTER TABLE "Submission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Submission" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "Submission";
CREATE POLICY rls_scope ON "Submission" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR "submitterAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
    OR "primaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR "submitterAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
    OR "primaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  );

-- ===== Case（窓口案件: 1次店 or 2次店がスコープ内） =====
ALTER TABLE "Case" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Case" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "Case";
CREATE POLICY rls_scope ON "Case" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR "primaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
    OR "secondaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR "primaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
    OR "secondaryAgencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  );

-- ===== CaseMessage / CaseStatusHistory（親Caseのポリシー経由） =====
ALTER TABLE "CaseMessage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CaseMessage" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "CaseMessage";
CREATE POLICY rls_scope ON "CaseMessage" FOR ALL
  USING (EXISTS (SELECT 1 FROM "Case" c WHERE c.id = "CaseMessage"."caseId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Case" c WHERE c.id = "CaseMessage"."caseId"));

ALTER TABLE "CaseStatusHistory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CaseStatusHistory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "CaseStatusHistory";
CREATE POLICY rls_scope ON "CaseStatusHistory" FOR ALL
  USING (EXISTS (SELECT 1 FROM "Case" c WHERE c.id = "CaseStatusHistory"."caseId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "Case" c WHERE c.id = "CaseStatusHistory"."caseId"));

-- ===== CaseRead（agencyId 直接） =====
ALTER TABLE "CaseRead" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CaseRead" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "CaseRead";
CREATE POLICY rls_scope ON "CaseRead" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
    OR EXISTS (SELECT 1 FROM "Case" c WHERE c.id = "CaseRead"."caseId")
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
  );

-- ===== FieldAgentApplication（親SalesStaffのポリシー経由） =====
ALTER TABLE "FieldAgentApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FieldAgentApplication" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "FieldAgentApplication";
CREATE POLICY rls_scope ON "FieldAgentApplication" FOR ALL
  USING (EXISTS (SELECT 1 FROM "SalesStaff" s WHERE s.id = "FieldAgentApplication"."salesStaffId"))
  WITH CHECK (EXISTS (SELECT 1 FROM "SalesStaff" s WHERE s.id = "FieldAgentApplication"."salesStaffId"));

-- 非保護テーブル（認証・共通基盤のため対象外）:
--   Account / Session / AccountRequest / Agency / Announcement / AnnouncementRead /
--   Document / StoredFile / Notification / AuditLog
-- Agency は認証時のスコープ計算に必要なため対象外（アプリ層 agencyScope() で制御）。
