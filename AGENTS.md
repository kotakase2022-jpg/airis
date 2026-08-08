<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Airis — 開発ガイド（AGENTS.md）

**一次仕様は [docs/SPEC.md](docs/SPEC.md)**（= 発注元の要求仕様書）。実装・レビューで迷ったら
必ずこれを正とする。優先順位は 要件（§4〜§9） > セキュリティ要件（§10） > UI参考（§11）。
プロトタイプUIの細部（アップロード上限260KB等）は仕様ではない（§11.4）。

## 技術スタック

| 領域 | 採用 |
|---|---|
| フレームワーク | Next.js 16（App Router / React 19 / Server Actions） |
| 言語 | TypeScript（strict） |
| スタイル | Tailwind CSS v4 / アイコンは lucide-react（絵文字は使わない） |
| フォント | Noto Sans JP（`src/app/layout.tsx`） |
| DB | PostgreSQL 16 + Prisma 6（マイグレーションは Prisma Migrate） |
| 認証 | 自前実装（ID/パスワード + DBセッション） + MFA（TOTP / otplib） |
| パスワード | Argon2id（@node-rs/argon2）+ 環境変数ペッパー（バージョンID付き） |
| データ分離 | アプリ層 `agencyScope()` + PostgreSQL RLS の多層防御 |
| メール | nodemailer（SMTP未設定時は開発コンソール出力） |
| テスト | Vitest（単体）/ Playwright（E2E） |
| デプロイ | Vercel（本番 https://airis-nine.vercel.app ）+ Neon |

## コマンド

```bash
# 開発
npm install
docker run -d --name airis-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=airis -p 5433:5432 postgres:16
npm run migrate          # Prisma Migrate（スキーマ変更は必ずこれ。db push は使わない）
npm run rls              # RLSポリシー適用 + アプリロール airis_app の作成（**必須**）
SEED_DEMO=1 npm run seed # デモデータ投入（ログイン情報がコンソールに出る）
npm run dev

# 上の3ステップは順番も含めて必須。理由:
#   - npm run rls: アプリは NOBYPASSRLS の airis_app で接続する（§3.1 多層防御）。
#     このロールが無いと APP_DATABASE_URL の接続が失敗し、**ログインを伴う全機能が動かない**。
#     以前この作成が手作業任せでコード化されておらず、CIのE2Eが一度も完走していなかった
#     （qa/BUG_REPORT.md BUG-L13）。
#   - SEED_DEMO=1: 付けないと初回パスワード変更フラグ（§9-1）がONになり、
#     ログイン後 /password で止まる。開発・検証専用の指定で、本番シードでは付けない。
#   - seed の upsert は既存行を更新しないため、フラグを変えたいときは再シード前にDBを作り直すこと。

# 検証（PRを出す前に全部通す）
npm run lint             # ESLint
npm run format:check     # Prettier（--write で整形）
npx tsc --noEmit         # 型検査
npm run test:unit        # Vitest
npm run build            # 本番ビルド
npm run test:e2e         # Playwright（別ターミナルで port3100 のサーバーを起動しておく）

# E2Eは2構成で回して初めて全件検証になる。既定構成だけでは
# e2e/18-access-log.spec.ts の x-forwarded-for 関連2件が skip されたままになる。
#   TRUST_PROXY=true ... npx next start -p 3101   # プロキシ配下想定のサーバ
#   QA_BASE_URL=http://localhost:3101 npm run test:e2e:proxy

# その他
npm run migrate:status   # マイグレーション適用状況
npm run migrate:deploy   # 本番へマイグレーション適用
npm run rls              # RLSポリシー適用
#   本番へ適用するときは APP_DB_PASSWORD が必須（未指定だと airis_app のパスワードが
#   リポジトリ既知の開発既定値 airis_app_test で上書きされる。apply-rls.ts が中断させる）:
#   ALLOW_REMOTE_DB=1 RLS_DATABASE_URL=<非プールURL> APP_DB_PASSWORD=<本番値> npm run rls
```

E2E用サーバーの起動（ローカルDB + RLS有効）:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/airis \
DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@localhost:5433/airis \
APP_DATABASE_URL=postgresql://airis_app:airis_app_test@localhost:5433/airis \
CRON_SECRET=qa-test-secret PASSWORD_PEPPER_V1=qa-test-pepper-v1 npx next start -p 3100
```

## コーディング規約

- **UI言語は日本語**。ラベル・ステータス名・メッセージは SPEC の表記を**一字一句そのまま**使う
  （業務用語のため。例: `承認待ち` / `本登録` / `1次店確認中` / `最終承認済み`）。
- **権限判定は宣言的マップに集約する**（§3.2）。`src/lib/permissions.ts` の `can()` /
  `canApproveFirst()`、ページアクセスは `src/lib/roles.ts` の `canAccess()` を使う。
  ロール配列をファイル内に直書きしない（`tests/unit/permissions-coverage.test.ts` が検出する）。
- **認可はUIとAPIの両層で行う**。ボタンを隠すだけでは不十分（server action / route handler 側で
  必ず再検証する）。データスコープは `agencyScope()` を通す。
- **個人情報カラムには `/// @pii` を付ける**（§8）。匿名化対象の定義は `src/lib/pii.ts` に集約し、
  注釈との一致を `tests/unit/pii.test.ts` が検証する。
- **`prisma.$transaction` は使わない**（RLS拡張がクエリ毎に `set_config` を挟むため）。
  複数文の原子性が必要な場合は `withScopedTransaction()`（`src/lib/prisma.ts`）を使う。
- **日付は JST 基準**（§2 Asia/Tokyo固定）。`today()`（`src/lib/util.ts`）を使い、
  レンダー中に `Date.now()` / `new Date()` を直接呼ばない（ESLintの purity ルールが検出する）。
- コメントは「なぜそうしたか」を書く。仕様に基づく判断には根拠の節番号（例 `§7.5`）を添える。
- テストは**期待結果を仕様に合わせる**。通すために期待値を緩めたりスキップしたりしない。

## ディレクトリ

```
src/app/(auth)/      ログイン・MFA・パスワード変更（未認証で到達する画面）
src/app/(app)/       業務画面（認証済み。layout.tsx がサイドメニュー＋ヘッダ）
src/app/api/cron/    日次バッチ（Vercel Cron。Bearer CRON_SECRET）
src/components/      共通UI（ui.tsx / nav.tsx / page-icons.tsx / cases/）
src/lib/             認証・権限・スコープ・PII・CSV・メール等の共通ロジック
prisma/              schema.prisma / migrations/ / seed.ts / rls.sql
e2e/                 Playwright（ローカルDBに対して実行）
e2e-prod/            本番スモーク（読み取り中心）
tests/unit/          Vitest
qa/                  QA成果物（トレーサビリティ・テストケース・不具合報告）
```

## 変更の進め方

1. `docs/SPEC.md` の該当節を読む。仕様と実装が食い違う場合は仕様を正とする。
2. マイルストーン+機能名のブランチを切る（例 `feat/m3-field-agents`）。
3. 実装 → `npm run lint && npm run format:check && npx tsc --noEmit && npm run test:unit && npm run build`。
4. 影響範囲のE2Eを追加・更新し、**全件**（`npm run test:e2e`）を通す。
5. PRに「対応した仕様の節」「動作確認手順」「テスト結果」を記載する（§0）。
