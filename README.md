# Airis — 販売代理店支援ポータル

通信キャリア（SNC）が販売代理店網（1次店 → 2次店 → 販売員）を管理する業務Webアプリ。
仕様書は [docs/SPEC.md](docs/SPEC.md)（機能要件・権限マトリクス・画面仕様の一次ソース）。

**本番環境**: https://airis-nine.vercel.app

## 技術スタック

- Next.js 16 (App Router) + TypeScript + Tailwind CSS
- PostgreSQL (Neon) + Prisma 6
- 認証: 自前実装（ID/パスワード + DBセッション。絶対24h / アイドル60分 / 10回失敗で30分ロック / 初回パスワード変更強制）
- デプロイ: Vercel（Neonインテグレーションで `DATABASE_URL` 自動設定）

## 開発環境

```bash
docker run -d --name airis-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=airis -p 5433:5432 postgres:16
npm install
npx prisma db push
npm run seed        # デモデータ投入（ログイン情報がコンソールに表示される）
npm run dev
```

`.env` はローカルDB向け。`.env.local`（gitignore済み）があるとそちらが優先される点に注意。

## 実装済み機能（速度優先ビルド）

- 10ロールRBAC + 代理店データスコープ（1次店=自店+配下 / 2次店=自店 / SNC=全店 / ④閲覧=ダミーデータ）
- サイドメニュー11項目: ダッシュボード / Airisアカウント申請 / 販売員ID管理 / 訪販員申請・管理 / 各種資料の提出（日報・稼働提出物）/ 下位代理店 / 管理画面 / ホットライン窓口 / 消費者センター窓口 / お知らせ / ドキュメント（代理店には窓口2つの代わりに統合ビュー「窓口案件」）
- 申請→1次承認→最終承認フロー（Airisアカウント / 販売員ID / 訪販員申請）、承認時のID自動採番・一時パスワード一回表示
- 日報（訪販/テレマ、上書き提出、KPI自動計算、CSVテンプレ/一括取込、スマホ対応）
- 稼働提出物（6様式テンプレDL、二段階承認、提出状況 n/6 マトリクス、年度自動計算)
- 窓口案件（テンプレ起票、スレッド返信、ステータス/期限バッジ、代理店既読、緊急アラート、代理店側は返信のみ・添付不可）
- お知らせ（全体/1次店向け、重要フラグ+既読率）、ドキュメント（公開範囲別）
- CSV入出力（棚卸 / GiGaCC連携 / 監査ログ）、アプリ内通知、監査ログ（最小限）

## メール通知（SMTP）

アプリ内通知と同じタイミング（窓口案件の起票/返信/緊急アラート、承認、お知らせ配信等）でメールも送信される。
環境変数 `SMTP_HOST` を設定すると有効化（未設定時は自動スキップ）:

| 変数 | 説明 |
|---|---|
| `SMTP_HOST` / `SMTP_PORT` | SMTPサーバ（ポート既定587） |
| `SMTP_USER` / `SMTP_PASS` | SMTP認証情報 |
| `SMTP_SECURE` | `true` でSMTPS(465) |
| `MAIL_FROM` | 差出人（省略時はSMTP_USER） |
| `APP_URL` | メール本文のリンク先（例 `https://airis-nine.vercel.app`） |

## Row-Level Security（RLS）

`prisma/rls.sql` のポリシーで、代理店スコープをDB層でも強制する（アプリ層 `agencyScope()` との多層防御 §3.1）。

- 保護テーブル: SalesStaff / FieldAgentApplication / DailyReport / Submission / Case / CaseMessage / CaseStatusHistory / CaseRead
- セッション変数 `app.bypass`（SNC系ロール）/ `app.scope`（代理店IDリスト）を、Prisma拡張（`src/lib/prisma.ts`）がクエリ毎に `set_config + クエリ` のトランザクションで注入する
- コンテキストが無い接続からは保護テーブルは**0件（既定拒否）**
- 本番はBYPASSRLSを持たない専用ロール **airis_app** で接続（`APP_DATABASE_URL`）。マイグレーション/シードはオーナー接続（`DATABASE_URL`）のまま
- ポリシー適用: `npm run rls`（Neonへは `RLS_DATABASE_URL=<非プールURL> npm run rls`）
- 注意: RLS拡張の都合で `prisma.$transaction` は使用しない（逐次実行にする）

## 日次バッチ（Vercel Cron）

`/api/cron/daily` を毎日 00:00 UTC（09:00 JST）に実行（`vercel.json`）。認証は `Authorization: Bearer ${CRON_SECRET}`（Vercelが自動付与。環境変数 `CRON_SECRET` 必須）。

1. **期限切れ案件リマインド**（§7.8 / 要件9-2 督促）: 期限超過かつ未完了の窓口案件について、当該1次店のR7へ案件ごとに督促通知、SNC運用者(R3)へサマリ通知。`REMINDER_MAIL_TO` 設定時は指定アドレスへメールも送信
2. **個人情報匿名化**（§3.4）: 削除後1年経過した Airisアカウント/販売員/訪販員申請 のPII（氏名・生年月日・電話・メール・カナ・業務委託先・誓約書PDF）を匿名化。数値実績は分析用に残す。冪等

バッチはセッションが無くRLSでfail-closedになるため、オーナー接続（`DATABASE_URL_UNPOOLED`）を使用する。
手動実行: `curl -H "Authorization: Bearer $CRON_SECRET" https://airis-nine.vercel.app/api/cron/daily`

## 未実装（本番リリース前に対応 — SPEC参照）

- MFA（TOTP/Google Authenticator）§4.2
- パスワード有効期限・履歴24世代 §4.2
- Slack通知（不要と確認済み 2026-08-05）
- 監査ログの網羅（閲覧イベント等）§3.3
- テスト一式 §13

> デモアカウントのパスワードは `prisma/seed.ts` を参照。**本番運用前に必ず変更すること。**
