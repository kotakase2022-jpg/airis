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

-- ===== FieldAgentApplication（訪販員申請: primaryAgencyId / secondaryAgencyId 直接） =====
-- §3.1「全業務テーブルに代理店スコープ（primaryAgencyId / secondaryAgencyId）を持たせ」に合わせ、
-- 親SalesStaffへのEXISTS参照ではなく **自テーブルのスコープ列** で判定する。
--   1次代理店（⑦）: primaryAgencyId が自店（配下2次店の申請も1次店IDで一致）
--   2次代理店（⑧）: secondaryAgencyId が自店
-- 列は申請作成時に親SalesStaffの所属から解決して保存する
-- （src/app/(app)/field-agents/agency-scope.ts）。既存行は
-- `npx tsx "src/app/(app)/field-agents/backfill-scope.ts"` で一度だけ補完する。
-- スコープ列がNULLの行は代理店系ロールから一切見えない（fail-closed）。
-- スコープ列が未適用のDBに対して実行すると、DROP POLICY 後の CREATE POLICY が失敗して
-- 「ポリシー無し（全行拒否）」の状態で残ってしまうため、先に列の存在を確認して中断する。
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'FieldAgentApplication'
      AND column_name IN ('primaryAgencyId', 'secondaryAgencyId')
    GROUP BY table_name
    HAVING count(*) = 2
  ) THEN
    RAISE EXCEPTION 'FieldAgentApplication.primaryAgencyId / secondaryAgencyId が存在しません。先にマイグレーション（npm run migrate）を適用してから npm run rls を実行してください（§3.1 代理店スコープ列）';
  END IF;
END
$do$;

ALTER TABLE "FieldAgentApplication" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FieldAgentApplication" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "FieldAgentApplication";
CREATE POLICY rls_scope ON "FieldAgentApplication" FOR ALL
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

-- ===== AccountRequest（アカウント申請: agencyId 直接。§3.1 保護対象の拡大） =====
-- 代理店系ロール（⑦⑧）の申請は agencyId を持つ。SNC系ロール（①〜⑥）宛の申請は agencyId IS NULL。
-- ④ダミーは「自ロール④の申請のみ実データとして受け付ける」（§3.5 の例外）ため、
-- スコープが設定されている接続に限り agencyId IS NULL の行も許可する。
-- コンテキスト（app.bypass / app.scope）が無い接続からは 0 件（fail-closed）。
-- 表示範囲の絞り込み（自分が作成した申請のみ等）はアプリ層で行う（多層防御の外側）。
ALTER TABLE "AccountRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AccountRequest" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_scope ON "AccountRequest";
CREATE POLICY rls_scope ON "AccountRequest" FOR ALL
  USING (
    current_setting('app.bypass', true) = 'on'
    OR (
      coalesce(current_setting('app.scope', true), '') <> ''
      AND (
        "agencyId" IS NULL
        OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
      )
    )
  )
  WITH CHECK (
    current_setting('app.bypass', true) = 'on'
    OR (
      coalesce(current_setting('app.scope', true), '') <> ''
      AND (
        "agencyId" IS NULL
        OR "agencyId" = ANY(string_to_array(current_setting('app.scope', true), ','))
      )
    )
  );

-- ===== アプリロール airis_app（APP_DATABASE_URL）の作成と権限付与 =====
-- §3.1 の多層防御は「アプリが NOBYPASSRLS のロールで接続する」ことが前提。
-- このロールを作る処理がリポジトリのどこにも無く、開発者が手作業で作った環境でだけ動いていた。
-- そのためCIでは APP_DATABASE_URL の接続が失敗し、**ログインを伴う全E2Eが落ちていた**
-- （CIのE2Eは一度も完走していなかった。QA loop4 で検出）。
-- ここで冪等に作成し、どの環境でも同じ手順（migrate → rls → seed）で再現できるようにする。
--
-- パスワードは APP_DB_PASSWORD（未指定なら開発既定 airis_app_test）。
-- **本番では必ず APP_DB_PASSWORD を指定すること**（既定値のまま運用しない）。
-- __APP_DB_PASSWORD__ は scripts/apply-rls.ts が実行前に APP_DB_PASSWORD の値へ置換する
-- （セッション変数だと接続プールをまたいで失われるため、確実な文字列置換にしている）。
DO $role$
DECLARE
  pw text := '__APP_DB_PASSWORD__';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airis_app') THEN
    EXECUTE format('CREATE ROLE airis_app LOGIN PASSWORD %L', pw);
  ELSE
    EXECUTE format('ALTER ROLE airis_app LOGIN PASSWORD %L', pw);
  END IF;
  -- RLSを迂回させない（§3.1）。スーパーユーザ・テーブル所有者はRLSをバイパスするため、
  -- アプリはこの専用ロールで接続する必要がある。
  EXECUTE 'ALTER ROLE airis_app NOBYPASSRLS';
  -- 業務テーブルへの基本権限。列追加・テーブル追加に追従するようスキーマ単位で付与する。
  EXECUTE 'GRANT USAGE ON SCHEMA public TO airis_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO airis_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO airis_app';
  -- 以後 migrate で追加されるテーブルにも自動で付与する
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO airis_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO airis_app';
END
$role$;

-- ===== AuditLog（append-only の多層防御 §10.4 / SEC要件②#35,36） =====
-- 監査ログはアプリケーションから更新・削除できない設計とする。
-- アプリロール（airis_app = APP_DATABASE_URL）には INSERT / SELECT のみを残し、
-- UPDATE / DELETE / TRUNCATE を剥奪する（RLSではなくテーブル権限で強制）。
-- ※このファイルはオーナー（テーブル所有者）接続で適用すること（npm run rls）。
-- ※airis_app が存在しない開発環境（docker-compose 既定）でも失敗しないよう存在チェックする。
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM PUBLIC;
DO $do$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'airis_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "AuditLog" FROM airis_app;
    GRANT INSERT, SELECT ON TABLE "AuditLog" TO airis_app;
  END IF;
END
$do$;

-- 非保護テーブル（認証・共通基盤のため対象外）:
--   Account / Session / Agency / Announcement / AnnouncementRead /
--   Document / StoredFile / Notification / PasswordHistory
-- Agency は認証時のスコープ計算に必要なため対象外（アプリ層 agencyScope() で制御）。
-- Document / StoredFile / Notification はスコープ列を持たない（公開範囲・参照元・accountIdで判定）ため
-- 行単位ポリシーを書けない。アプリ層（canAccessFile() / 各ページ）で制御する。
-- AuditLog は全ロール横断の監査基盤のため行スコープは掛けず、上記の append-only 権限で保護する。
