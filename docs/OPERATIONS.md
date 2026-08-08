# 運用ドキュメント（docs/OPERATIONS.md）

本書は **アプリ実装の外側にある運用・インフラ側の前提条件と手順** をまとめたものです。
仕様の一次ソースは [docs/SPEC.md](SPEC.md)（§10.3 / §10.5 / §10.6）です。

- 対象環境: 本番 https://airis-nine.vercel.app （Vercel + Neon PostgreSQL）
- 最終更新: 2026-08-05

---

## 1. 環境分離（§10.5）

| 環境 | 用途 | ホスティング | データベース | データ |
|---|---|---|---|---|
| **本番（production）** | 実業務 | Vercel Production | Neon（本番ブランチ） | 実データ |
| **検証（staging）** | リリース前の受入確認 | Vercel Preview（`main` 以外のブランチ） | Neon の**別ブランチ**（本番のスキーマのみ複製） | **マスキング済みデータまたはシードデータのみ** |
| **開発（development）** | 実装・単体/E2E | ローカル `next dev` / `next start -p 3100` | Docker `postgres:16`（`localhost:5433`） | `npm run seed` のデモデータのみ |

### 開発・検証で本番データを使わない（必須ルール）

- 開発・検証環境に**本番データを複製しない**。必要な場合は下記のマスキングを施したうえで、
  責任者の承認を得て実施し、利用後は速やかに破棄する。
- マスキング対象は `src/lib/pii.ts` の `PII_FIELDS`（`prisma/schema.prisma` の `/// @pii`
  注釈と一致することを `tests/unit/pii.test.ts` が検証している）:
  氏名 / 生年月日 / 電話 / メール / フリガナ / 業務委託先の名称・住所・連絡先 / 誓約書PDF。
- マスキング手順（例）: 本番からダンプ → 検証DBへリストア → `src/lib/pii.ts` の
  `anonymizeData()` 相当のUPDATEを全件に適用 → `passwordHash` を検証用の値へ差し替え →
  `AccessLog` / `AuditLog` を破棄。
- **`.env.local` に本番の接続URLを置かない**（過去にローカル実行のバッチが本番DBへ接続した
  事故がある。QA_REPORT の BUG-OPS01）。本番接続はVercelの環境変数のみで管理する。

### 環境変数の所在

| 変数 | 本番 | 検証 | 開発 |
|---|---|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Vercel（Neon連携が設定） | Vercel Preview | `.env` |
| `APP_DATABASE_URL`（RLS用・NOBYPASSRLS） | Vercel | Vercel Preview | `.env` |
| `PASSWORD_PEPPER_V1` / `PASSWORD_PEPPER_V2` … | Vercel（**ダッシュボードから設定**） | Vercel Preview | `.env` |
| `CURRENT_PEPPER_KEY` | Vercel | Vercel Preview | `.env` |
| `CRON_SECRET` | Vercel | — | `.env` |
| `APP_DB_PASSWORD`（RLS適用時のみ・**Vercelには置かない**） | 実行者が手で渡す秘密 | 同 | 未設定可（開発既定 `airis_app_test`） |
| `SMTP_*` / `MAIL_FROM` / `APP_URL` | Vercel | Vercel Preview | `.env`（未設定ならコンソール出力） |
| `ADMIN_IP_ALLOWLIST` | Vercel or 管理画面の設定（DBが優先） | 同 | `.env` |
| `TRUST_PROXY` / `TRUST_VERCEL_HEADERS` / `TRUSTED_PROXY_HOPS` | Vercel（`VERCEL=1` で自動） | 同 | `.env` |

> Vercel CLI のパイプ/リダイレクト経由では値が空で登録される事象を確認済み。
> **シークレットはVercelダッシュボードのUIから設定**し、`vercel env pull` で値が入っている
> ことを必ず確認する。

---

## 2. シークレット・暗号鍵の交換手順（§10.3 / SEC②#42）

年1回以上の交換を前提にする。**いずれの手順も無停止**で実施できる。

### 2.1 パスワードのペッパー（`PASSWORD_PEPPER_V*`）

アプリは複数バージョンのペッパーを同時に保持し、`Account.pepperVersion` にそのアカウントの
ハッシュへ適用済みのバージョンを記録する。ログイン成功時に現行バージョンで自動再ハッシュする。

1. 新しい値を生成する（32バイト以上のランダム。例 `openssl rand -base64 32`）。
2. Vercelダッシュボードで **新しい変数** `PASSWORD_PEPPER_V2` を追加する（**V1は消さない**）。
3. `CURRENT_PEPPER_KEY=v2` を設定する。
4. 再デプロイする。以降のログイン成功時に、旧バージョン（V1）または未適用のハッシュが
   V2で再ハッシュされ、`Account.pepperVersion` が `v2` に更新される。
5. 移行状況を確認する:
   ```sql
   SELECT "pepperVersion", count(*) FROM "Account" WHERE status <> 'deleted' GROUP BY 1;
   ```
6. 全アカウントが `v2` になったら `PASSWORD_PEPPER_V1` を削除する。
   （長期未ログインのアカウントが残る場合は、管理画面のパスワードリセットで移行させる）

### 2.2 セッショントークン

セッションは**乱数トークンをDBに保存**する方式（署名鍵を持たない）。鍵交換は不要。
全セッションを失効させたい場合は `DELETE FROM "Session";` を実行する（全ユーザーが再ログイン）。

### 2.3 `CRON_SECRET`

1. 新しい値をVercelダッシュボードで設定する。
2. 再デプロイする（Vercel Cron は環境変数の値で `Authorization: Bearer` を送るため、
   デプロイ完了と同時に切り替わる）。

### 2.4 DB資格情報 / SMTP資格情報

1. Neon / SMTPプロバイダ側で新しい資格情報を発行する。
2. Vercelの環境変数を更新して再デプロイする。
3. 旧資格情報を失効させる。
4. RLS用ロール `airis_app` のパスワードを変更する場合は `APP_DATABASE_URL` を同時に更新する。

---

## 3. 日次バッチ（Vercel Cron）

`/api/cron/daily` を 00:00 UTC（09:00 JST）に実行（`vercel.json`）。認証は
`Authorization: Bearer ${CRON_SECRET}`。処理内容は README を参照。

- 手動実行: `curl -H "Authorization: Bearer $CRON_SECRET" https://airis-nine.vercel.app/api/cron/daily`
- 失敗時は Vercel の Cron ログを確認する。冪等なので再実行して差し支えない。

---

## 4. インフラ側の前提条件（§10.6。アプリ実装の対象外）

下記はアプリでは実装せず、インフラ・運用側で担保する。**リリース前に担当・状況を埋めること。**

| # | 要件（§10.6） | 担当 | 状況 |
|---|---|---|---|
| 1 | WAF / CDN / DDoS対策 | インフラ | Vercel の CDN/DDoS 保護を利用。WAFルールは要設計 |
| 2 | 脅威検知（GuardDuty相当） | インフラ | 未設定 |
| 3 | バックアップ日次以上（RPO≤24h）+ 3-2-1ルール | インフラ | Neonの自動バックアップ。3-2-1（別媒体・別地域の副本）は要設計 |
| 4 | リストア手順書とリストア定期テスト・RTO定義 | インフラ | 未実施 |
| 5 | 第三者脆弱性診断（初回リリース前のWebアプリ診断） | 発注元 | 未実施（**リリース条件**） |
| 6 | パッチSLA（CVSS 9.0+ は1〜5日） | インフラ | CIの `npm audit` / Trivy で検知。適用SLAは要合意 |
| 7 | サーバ/コンテナのマルウェア対策・イメージ定期スキャン | インフラ | CIでTrivyスキャン。本番はVercelマネージド |
| 8 | CISベンチマーク準拠のハードニングと構成変更管理 | インフラ | Vercel/Neonマネージドのため適用範囲を要整理 |
| 9 | KMSによる鍵管理（年1回以上のローテーション） | インフラ | 現状はVercel環境変数。手順は本書§2 |
| 10 | インシデント初報SLA（重大時は原則1時間以内）・個人情報保護法の法定報告対応 | 発注元 | 体制要整備 |
| 11 | 保存データのサーバサイド暗号化（AES-256） | インフラ | Neon/Vercelの保存時暗号化に依拠（**証跡の提示が必要**） |
| 12 | データ保存先は国内リージョン（東京） | インフラ | **現状 us-east-1。東京リージョンへの移設が必要（リリース条件）** |
| 13 | 監査ログの長期保管・WORM化 | インフラ | アプリはappend-only（UPDATE/DELETE権限をREVOKE済み）。長期保管は要設計 |
| 14 | TLS1.2以上 / HSTS | インフラ | Vercel既定でTLS1.2+。HSTSヘッダは要確認 |

---

## 5. リリース手順

```bash
# 1. 検証（すべて通ること）
npm run lint && npm run format:check && npx tsc --noEmit && npm run test:unit && npm run build
npm run test:e2e          # 別ターミナルで port3100 のサーバーを起動しておく

# 2. 本番へマイグレーション適用（スキーマ変更がある場合）
ALLOW_REMOTE_DB=1 DATABASE_URL=<Neonの非プールURL> npm run migrate:deploy

# 3. RLSポリシー適用（ポリシー変更がある場合）
#    APP_DB_PASSWORD は必須。未指定だと rls.sql が airis_app のパスワードを
#    リポジトリ既知の開発既定値 airis_app_test で上書きし、Vercel の APP_DATABASE_URL と
#    食い違ってアプリがDBへ接続できなくなる（scripts/apply-rls.ts のガードが中断させる）。
ALLOW_REMOTE_DB=1 RLS_DATABASE_URL=<Neonの非プールURL> APP_DB_PASSWORD=<本番値> npm run rls

# PowerShell の場合（インライン指定は使えない）
#   $env:ALLOW_REMOTE_DB = "1"
#   $env:RLS_DATABASE_URL = "<Neonの非プールURL>"
#   $env:APP_DB_PASSWORD = "<本番値>"
#   npm run rls
#   Remove-Item Env:ALLOW_REMOTE_DB, Env:RLS_DATABASE_URL, Env:APP_DB_PASSWORD

# 4. デプロイ
vercel deploy --prod

# 5. 本番スモーク（全10ロールのログインとメニュー構成）
npx playwright test --config playwright.prod.config.ts
```

## 6. 本番運用開始前のチェックリスト

- [ ] `prisma/seed.ts` のデモアカウント・デモパスワードを削除または無効化する
- [ ] 全アカウントの `mustChangePassword` を `true` にする（初回ログイン時に強制変更）
- [ ] `PASSWORD_PEPPER_V1` をダッシュボードから設定する（未設定でも動作するが強く推奨）
- [ ] `ADMIN_IP_ALLOWLIST` を設定する（管理画面の接続元制限）
- [ ] `SMTP_*` と `APP_URL` を設定する（通知メールの実送信）
- [ ] Neonのリージョンを東京へ移設する（§10.3）
- [ ] 第三者脆弱性診断を実施する（§10.6）
- [ ] 上表§4のインフラ要件について担当と状況を確定する
