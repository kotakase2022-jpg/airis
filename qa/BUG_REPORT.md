# BUG_REPORT.md — 不具合報告書

**対象**: Airis 販売代理店支援ポータル（github.com/kotakase2022-jpg/airis）
**QA期間**: 2026-08-05 03:05 〜 08:00 JST
**検証環境**: ローカル本番ビルド（port3100 / Docker PostgreSQL16 + RLS + airis_appロール）、本番 https://airis-nine.vercel.app
**仕様書**: `CODEX_INSTRUCTIONS.md`（564要件に分解・要件ID付与）

---

## 検出・修正サマリ

| 検出経路 | 検出数 | 修正 | 未修正（残存リスク） |
|---|---|---|---|
| ベースライン検証（lint/型/ビルド） | 1 | 1 | 0 |
| E2Eテスト作成（7領域・191テスト） | 12 | 12 | 0 |
| 静的検証（220要件のコード/DB/API照合） | 7 | 7 | 0 |
| **独立レビュー第1回**（未関与エージェント・実機再現） | 18（critical2/major8/minor8） | 18 | 0 |
| **独立レビュー第2回**（再検収） | 15（major6/minor9） | 13 | 2 |
| 本番ログイン検証（発注者報告・QA後） | 1（critical1） | 1 | 0 |
| **合計** | **54** | **52** | **2** |

重要度別（重複排除後の全期間）:

| 重要度 | 検出 | 修正済 | 残存 |
|---|---|---|---|
| critical | 3 | 3 | 0 |
| major | 21 | 20 | 1 |
| minor | 30 | 29 | 1 |

---

## critical（情報漏洩・認証基盤）

### BUG-C01 `/files/[id]` に認可が存在せず、全ユーザーが任意のファイルを取得できた（IDOR）
- **関連要件**: A-052, SEC-020, §3.1 / §3.8 / §10.5
- **再現手順**: 任意のロール（⑨販売員・⑧2次店・⑩稼働終了・④閲覧）でログインし、`GET /files/<他代理店の誓約書PDFのID>` を実行
- **期待結果**: 参照元エンティティのスコープ・公開範囲で認可され、権限外は403
- **実際の結果**: 200 + ファイル本体を取得。他代理店の**誓約書PDF（個人情報）・上長承認証跡・稼働提出物Excel・SNC限定ドキュメント**が全ロールから取得可能。さらに `mustChangePassword=true`（初回パスワード変更未完了）のセッションでも取得でき、§10.1のゲートも回避
- **原因**: `src/app/files/[id]/route.ts` がログイン有無のみ検証（ロール・代理店スコープ・公開範囲の判定コードが存在しなかった）
- **修正内容**: `src/lib/file-access.ts` を新設。fileIdの参照元（アカウント申請の証跡／訪販員申請の誓約書PDF／稼働提出物／案件添付／お知らせ添付／ドキュメント）を特定し、**§5.1の宣言的権限マップ（permissions.ts）** と `agencyScope()` で認可。孤立ファイルは拒否（fail-closed）。初回パスワード変更ゲート・`X-Content-Type-Options: nosniff`・CSP・サーバ側MIME決定を追加
- **変更ファイル**: `src/lib/file-access.ts`（新規）, `src/app/files/[id]/route.ts`
- **追加テスト**: `e2e/14-file-access.spec.ts`（全6分岐×全ロール、孤立ファイル、mustChangePassword）
- **回帰影響**: 既存テスト1件（孤立ファイルで200を期待）が失敗 → 業務実態（Documentに紐づくファイル）に前提を修正し、孤立ファイル403の検証を追加

### BUG-C02 パスワードハッシュがArgon2idでなく、ペッパーもレート制限も無かった
- **関連要件**: A-023, A-024, SEC-002, SEC-004, §2 / §10.1 / §10.3
- **再現手順**: DBの `Account.passwordHash` を確認 / `grep -rn "argon2\|pepper\|rateLimit" src/`
- **期待結果**: Argon2id + ソルト + 環境変数ペッパー（バージョン管理）、認証エンドポイントにレート制限
- **実際の結果**: bcrypt(cost10)のみ・ペッパー無し・レート制限無し
- **修正内容**: `@node-rs/argon2` を導入し **Argon2id（メモリ19MiB / 時間コスト2 / 並列度1、OWASP推奨）** へ移行。ペッパーはHMAC-SHA256前段（bcryptの72バイト切り詰め回避）+ バージョンID（`PASSWORD_PEPPER_V1`）。既存bcryptハッシュはログイン成功時に自動再ハッシュ（needsRehash）で無停止移行。レート制限はIP+ID単位で1分5回
- **変更ファイル**: `src/lib/auth.ts`, `src/app/(auth)/actions.ts`, `package.json`
- **追加テスト**: `e2e/01-auth.spec.ts`（Argon2id移行・ペッパー・レート制限）、`e2e/18-access-log.spec.ts`

### BUG-C03 本番環境で `prisma/seed.ts` 記載の全アカウントがログイン不能だった（発注者報告）
- **関連要件**: A-023, D-024, §4.2 / §9
- **再現手順**: https://airis-nine.vercel.app に `airis_snc_adm_001` / seed.ts記載のパスワードでログイン
- **期待結果**: ログイン成功しダッシュボードへ遷移
- **実際の結果**: 全アカウントで「IDまたはパスワードが正しくありません」。本番環境が利用不能
- **原因**: (1) BUG-C02修正でアプリを bcrypt → Argon2id+ペッパーへ移行した際、**seed.ts が bcrypt のまま取り残され**、シードが生成するハッシュをアプリの `verifyPassword()` が照合できなかった。(2) Vercel の `PASSWORD_PEPPER_V1` がCLIのパイプ渡し失敗により**空文字列**で登録されており、ペッパー前提もずれていた
- **修正内容**: seed.ts を `src/lib/auth.ts` と同一方式（Argon2id 19MiB/t=2/p=1 + `PASSWORD_PEPPER_V1` HMAC前段）へ統一（コミット 931b8ff）。空文字列のペッパー環境変数を削除し「未設定」で統一。seed の `upsert` は `update:{}` のため既存行のハッシュを更新しない仕様であることから、本番DBをクリアして再シード
- **検証**: 本番DBのハッシュを `@node-rs/argon2` で直接照合（①②⑦⑨サンプル全て true）→ 本番スモーク（全10ロール実ログイン）13/13 PASS → ローカルはペッパー**有効**構成で全E2E回帰 322 passed / 2 skipped（ペッパー有無の両構成で整合を確認）
- **再発防止**: README「シードとパスワードの整合（重要）」節を新設（シード時とアプリ実行時のペッパー一致、upsertの非更新挙動、後付けペッパーの自動再ハッシュ移行を明記）
- **追補（2026-08-05 11:20）**: 修正デプロイ後もログイン不可の報告あり。本番AccessLogで当該試行が bad_password（受信したパスワード文字列の不一致）であることを確認し、同時刻に正規の文字列では実ブラウザでログイン成功。入力ゆらぎ（前後空白・IME全角英数・引用符の巻き込み）を吸収する verifyPasswordLenient を追加（コミット 91cd3c9、原文で不一致の場合のみ正規化候補で再照合＝受理範囲の拡大のみ）。本番で「前後空白+全角！」「引用符ごと貼り付け」の両ケースのログイン成功を確認。単体223 / E2E 326 passed

---

## major（20件修正 / 1件残存）

| ID | 概要 | 関連要件 | 状態 |
|---|---|---|---|
| BUG-M01 | 管理画面の一覧・統計にSNC系（代理店非所属）アカウントが表示されず、①〜⑥を管理できなかった | §7.2 | 修正 |
| BUG-M02 | アクセスログ（ログイン日時・IP・UA）の記録機能とCSVが存在しなかった | 要件1-6, A-059 | 修正（AccessLogテーブル新設） |
| BUG-M03 | 月初見込が2回目以降の提出でも上書きでき、販売員が月間目標を後から書き換えられた | 要件6-3 | 修正 |
| BUG-M04 | 窓口返信の添付が4MB上限かつ約1MB超でエラー表示なく失敗（サイレント失敗） | §3.8 | 修正（20MB・bodySizeLimit・エラー表示） |
| BUG-M05 | ④SNC閲覧アカウントにお知らせ・ドキュメントの実データが表示された | §3.5 | 修正 |
| BUG-M06 | ダッシュボードのお知らせが双方向に混在（④に実データ／実ロールにサンプル） | §3.5 / §7.1 | 修正 |
| BUG-M07 | ③SNC運用者がSNC系アカウント申請を単独で最終承認でき、職務分離が成立していなかった | §6.1-3 / 要件1-1 | 修正 |
| BUG-M08 | 稼働提出物の通知が⑨販売員（権限×）にも配信された | §3.7 / §5.1 | 修正 |
| BUG-M09 | §5.1の「変更」操作が未実装（アカウント・販売員ID・訪販員申請・お知らせ・窓口案件） | §5.1 / §7.3 | 修正 |
| BUG-M10 | §5.1の窓口案件「停止」「削除」が未実装 | §5.1 | 修正 |
| BUG-M11 | 稼働提出物の「変更」（差し替え）が未実装 | §5.1 | 修正 |
| BUG-M12 | 訪販員申請のCSV一括申請＋誓約書PDF突合が未実装 | §7.4 / M3 | 修正 |
| BUG-M13 | アップロードの拡張子ホワイトリストが無く、text/htmlが受理されそのまま配信された | §3.8 | 修正 |
| BUG-M14 | ⑨が他代理店の稼働提出物ファイルを取得できた（file-access分岐3の権限判定誤り） | §5.1 / §3.1 | 修正 |
| BUG-M15 | SNC内部申請（agencyId=NULL）の上長承認証跡を無関係の⑦⑧が取得できた | §3.1 | 修正 |
| BUG-M16 | 下書きお知らせの添付が作成者①②③でも403になった（過剰制限） | §7.7 | 修正 |
| BUG-M17 | §5.1の宣言的権限マップが存在せず、各actionにロール配列が散在していた | §3.2 | 修正（permissions.ts + 全面適用） |
| BUG-M18 | 訪販員申請の業務項目（取扱商材・属性等）を編集する手段が無かった | §5.1 / §7.4 | 修正 |
| BUG-M19 | パスワード有効期限（90/180日）・履歴24世代が未実装 | §4.2 | 修正（PasswordHistory） |
| BUG-M20 | 単体テスト基盤（Vitest）・CI・docker-composeが存在しなかった | §2 | 修正 |
| **BUG-M21** | **ファイル実体をDB（bytea）に格納し、ストレージ抽象化・署名URLが無い** | **§2 / §3.8** | **未修正（残存リスク R-01）** |

---

## minor（29件修正 / 1件残存・抜粋）

| ID | 概要 | 状態 |
|---|---|---|
| BUG-N01 | lint 2エラー（react-hooks/set-state-in-effect） | 修正 |
| BUG-N02 | 履歴日付がUTC基準で、JST 00:00〜08:59の操作が前日付で記録された（§2） | 修正 |
| BUG-N03 | 代理店ロールの画面に「ブラックリスト」の文言が露出（§7.4） | 修正 |
| BUG-N04 | テレマ専用KPI（アポ生産性・クローズ通過率等）が未実装（§7.5） | 修正 |
| BUG-N05 | 提出物一覧に1次/2次代理店フィルタが無かった（§7.6） | 修正 |
| BUG-N06 | お知らせの下書きライフサイクルが未実装（§7.7） | 修正 |
| BUG-N07 | 下位代理店の統計・列が「進行中案件」でなく「販売員」だった（§7.11） | 修正 |
| BUG-N08 | アカウントロックの30分ウィンドウ未実装・満了後もカウンタ残存（§4.2） | 修正（AccessLogベースのスライディングウィンドウ） |
| BUG-N09 | X-Forwarded-For偽装でレート制限を回避できた | 修正（x-vercel-forwarded-for優先／末尾hop採用） |
| BUG-N10 | 停止したお知らせの添付が受信側から取得できた | 修正 |
| BUG-N11 | CSV一括取込が真のトランザクションでなかった（§3.6） | 修正（withScopedTransaction） |
| BUG-N12 | 多数のserver actionがエラーを表示せず無反応だった（§3.2） | 修正 |
| BUG-N13 | 不正利用検知アラートが未実装（要件1-9） | 修正（cron + リアルタイム検知） |
| BUG-N14 | Notification.channel列が無かった（§8） | 修正 |
| BUG-N15 | airis_appロールがAuditLogをUPDATE/DELETEできた（§10.4 append-only） | 修正（REVOKE） |
| BUG-N16 | ダッシュボードの欠落カード（未提出者・n/6・稼働終了数・未読件数・監査イベント） | 修正 |
| BUG-N17 | アカウント変更でtier不整合なロール変更が可能だった | 修正 |
| BUG-N18 | メール送信が開発環境でサイレントスキップだった（§2） | 修正（コンソール出力） |
| BUG-N19 | 匿名化済み判定がセンチネル文字列だった（anonymizedAt列を未使用） | 修正 |
| BUG-N20 | 統計カードのラベルが仕様§7.2と不一致 | 修正 |
| **BUG-N21** | **Prettier未導入（CIはESLint+tscのみ）** | **未修正（残存リスク R-10）** |

---

## QA作業中に発見した運用上の重大リスク

### BUG-OPS01 `.env.local` の本番DB URLにより、ローカル起動時もバッチが本番DBへ接続していた
- **再現手順**: ローカルで `next start` → `/api/cron/daily` を実行
- **実際の結果**: `.env.local` の `DATABASE_URL_UNPOOLED`（本番Neon）にフォールバックし、**本番DBのデータを更新**。QA中に本番へテスト痕跡（匿名化済み販売員1件）が混入した
- **影響**: 開発・テスト作業が本番データを破壊しうる
- **対処（一次・loop1）**: QA環境は全DB系環境変数を明示指定する起動スクリプトに隔離。混入データは除去済み
- **恒久対処（loop4 で実施。それまで「推奨・未実施」のまま残っていた）**:
  1. `.env.local` から本番URLを削除し、**ローカル（localhost:5433）専用**にした。
     ファイル冒頭に「本番URLを置いてはいけない」理由をコメントで明記。
  2. 本番の接続情報は **`.env.deploy`** へ分離した。このファイル名は Next.js の
     環境ファイル規約（`.env` / `.env.local` / `.env.<NODE_ENV>` / `.env.<NODE_ENV>.local`）に
     該当しないため **Next.js から自動読み込みされない**。`.gitignore` の `.env*` で追跡対象外。
     本番スモーク（`e2e-prod/*.spec.ts`）だけが明示的にこのファイルを読む。
  3. **ガードスクリプト `scripts/assert-local-db.cjs` を追加**し、破壊的な npm script
     （`seed` / `rls` / `migrate` / `migrate:deploy`）の前段に噛ませた。
     DB系環境変数7種のいずれかが localhost 以外を指していたら**非ゼロ終了して処理を止める**。
     本番へ意図的に実行する場合のみ `ALLOW_REMOTE_DB=1` を明示する
     （例: `ALLOW_REMOTE_DB=1 npm run migrate:deploy`）。
  4. 回帰テスト `tests/unit/assert-local-db.test.ts`（16件）で、
     ローカル通過・本番中断・7変数すべての検出・混在時は安全側・`ALLOW_REMOTE_DB` が
     `1` 以外なら不許可・パース不能な接続文字列でも検出、を固定した。
- **残る運用課題**: Vercel 側の環境変数管理（本番接続は Vercel の環境変数のみに限定する運用）は
  発注者側の設定作業。手順は [docs/OPERATIONS.md](../docs/OPERATIONS.md) §1 に記載。

---

## 修正の検証状況

全修正について、**期待値を仕様どおりに保ったまま**回帰テストを追加し、クリーンDBから全件再実行して確認済み:

| 検証 | 結果 |
|---|---|
| E2E 既定構成（Playwright・実ブラウザ・実DB・RLS有効・TRUST_PROXY未設定） | **322 passed / 2 skipped / 0 failed** |
| E2E プロキシ構成（TRUST_PROXY=true・XFF末尾hop検証） | **9 passed / 1 skipped / 0 failed** |
| 単体（Vitest。§5.1権限マトリクス全数テーブル駆動・IP信頼判定16件を含む） | **216 / 216 PASS** |
| 本番スモーク（全10ロール実ログイン・https://airis-nine.vercel.app） | **13 / 13 PASS** |
| lint / 型検査 / ビルド | すべて成功（0エラー） |

skipped 3件はいずれも「相互に排他な起動構成でのみ実行するテスト」（既定構成ではプロキシ専用2件がskip、プロキシ構成では既定専用1件がskip）であり、両構成を合わせると全テストが実行されています。

テストを弱めた箇所・スキップした箇所はありません。1件のみ、IDOR修正に伴い**テストの前提**（孤立ファイルで200期待）を業務実態に合わせて変更し、その正当性を本文書に記録しています。

---

# QA loop3（独立検収 + 発注者提供原本の突合）で検出・修正した不具合

本ループは「発注者から Excel 原本（稼働日報 / 稼働提出物テンプレート）が提供された」ことを起点に、
KPI 計算式の突合と、独立した第三者エージェント2名（観点: 認可バイパス / 回帰）による監査を行った。
**判定は実ブラウザ・実DB・実API での再現に基づく。コードの読み取りのみで PASS にした項目は無い。**

## critical

### BUG-L01 ③（SNC運用者）が①②アカウントを乗っ取れた（資格情報リセットに対象ロール制限が無い）
- **要件**: §4.2（リセット代行は②③）/ §6.1-3・要件1-1（SNC一般以上のアカウント発行・権限変更は必ず②）/ §10.5
- **原因**: 本QAループで「③が §4.2 のリセット代行を行えるように」`ADMIN_OP_PERMISSION` の
  `reset_password` / `mfa_reset` を `approve_final`（①②③）へ緩めた際、
  `account-requests` 側に既に存在した職務分離（`canFinalApproveRequest()`: SNC系①〜⑥が対象なら①②のみ）を
  **リセット経路へ適用し忘れた**。＝**私自身が作り込んだ退行**。
- **再現（独立監査エージェントが実証）**: ③でログイン → `/admin?q=<①のログインID>` →
  「MFAリセット」で `mfaEnabled=false` / `mfaSecret=null` → 「PWリセット」で **一時パスワードが③の画面に平文表示** →
  そのID＋一時パスワードでログインすると MFA 未登録のため `/mfa/setup` に落ち、
  **攻撃者の端末で新しいTOTPを登録**して①（全権）のセッションを確立できた。
  使い捨ての①アカウント（`ZZZAUDIT_slb_sys_900`）で実施し、シードは不変。
- **修正**: `canResetCredentialsFor(actorRole, targetRole)` を
  `src/app/(app)/account-requests/approval-rules.ts` に追加（最終承認と**同一規則**）。
  - サーバ側: `src/app/(app)/admin/actions.ts` の `accountAction` で `reset_password` / `mfa_reset` の前に検証し、
    拒否時は `denied` で監査記録
  - UI側: `canResetCredentialsOn(role, targetRole)` でボタン自体を出さない（§3.2 多層防御）
- **回帰テスト**: `tests/unit/credential-reset-authz.test.ts`（10ロール×10ロールの全数 + 「最終承認と同一規則であること」）

## major

### BUG-L02 §14-2 の実効ロール解決漏れ — 稼働終了1次店の配下2次店の⑧が⑩にならなかった
- **要件**: §14 確定事項「Agencyのステータスを『稼働終了』に切替えると **当該1次店の⑦と配下2次店の⑧** の実効ロールが⑩に解決される」
- **原因**: `src/lib/session.ts` / `src/lib/auth.ts` が **自アカウントの所属代理店の status しか見ていなかった**。
  シードは配下2次店も `closed` にしていたため露出しておらず、データ規約に依存していた。
- **再現（独立監査エージェントが実証）**: ②が `/agencies` で1次店(110001)のみ「稼働終了」に切替 →
  配下2次店の⑧が⑧のままログインでき、サイドバー7項目（⑩では×の販売員ID管理・訪販員申請・各種資料の提出・
  お知らせ・ドキュメント・Airisアカウント申請を含む）に到達できた。
- **修正**: 実効ロール解決を純粋関数 `effectiveRoleFor(rawRole, ownAgencyStatus, parentAgencyStatus)`
  に集約（`src/lib/session.ts`）。⑧は親1次店の稼働終了も対象。伝播は**読み取り時の解決**で行い、
  配下2次店のレコードは書き換えない（1次店を有効へ戻すと配下も自然に戻る）。
- **回帰テスト**: `tests/unit/effective-role.test.ts`（自店/親の組み合わせ全パターン）

### BUG-L03 窓口案件の対応期限に実在しない日付が保存された（形式のみの検証）
- **要件**: §7.8（起票フォームの対応期限）/ 要件9-2（期限超過の督促バッチ）/ §10.5（入力検証）
- **再現**: 起票フォームの `type="date"` をテキストに変えて `9999-99-99` を送信 → **そのままDBに保存された**。
  作成パスには検証が無く、更新パスの `/^\d{4}-\d{2}-\d{2}$/` は**形式のみ**で `9999-99-99` / `2026-02-31` を通した。
- **影響**: 対応期限が不正だと督促バッチ（要件9-2）の期限判定が壊れる。
  同じ形式のみの検証が **稼働開始日・稼働終了日・生年月日・代理店参加日・日報の日付（フォーム/CSV）** にも使われており、
  生年月日が不正だと15歳未満判定（発注者指示）が文字列比較のため誤る。
- **修正**: 実在日判定を `src/lib/date-input.ts`（純粋関数）へ集約し、**6ファイル10箇所**の
  形式のみの検証を置き換えた。`new Date()` のパース（`2026-02-31` を 3/3 に繰り上げる）に依存しない実装。
  `reports/kpi.ts` の `daysInMonth` / `normalizeDate` も同モジュールへ統一し、うるう年ロジックの二重実装を解消。
- **回帰テスト**: `tests/unit/date-input.test.ts`（境界値網羅）/ `e2e/27-date-validation.spec.ts`（実ブラウザ→実DB。案件・生年月日・日報CSV）

### BUG-L04 KPI計算式が Excel 原本と6指標で食い違っていた
- **要件**: §7.5 / §14-5 #5「Excel原本の数式を正として実装し、テストで突合」
- **原因**: 原本が未提供の期間の暫定実装がそのまま残っていた。
- **修正（原本を正として是正）**: 訪問/対面/商談/日 の分母を日報提出日数→**稼働数**（原本 T7/U7/V7）、
  ペースメーカーを **着地予想/獲得見込**（原本 J7、書式 `0%` なので率表示）、
  着地予想の日数基準を暦日→**稼働日数（日曜のみ休日）**（原本 G2/G3 の `NETWORKDAYS.INTL(...,11)`）。
  §7.5 が「分子となる入力項目が無い」として対象外にしていた **獲得生産性・後確通過率** は、
  原本 `C12 =C17/C9` / `C23 =C17/C16` でいずれも分子が「エントリー数（実績）」であり算出可能だったため実装（テレマは6→8タイル）。
- **自己修正**: 当初 xlsx パーサが自己終了セル `<c r="H7" s="18"/>` を開始タグと誤認し、
  **隣接セルの数式を1つずれて帰属**させていた（共有数式 `<f t="shared" si="N"/>` も「数式なし」と誤判定）。
  独立監査エージェントの指摘でパーサを修正し、キャッシュ値（`R7` の 0.67317 = 138/205 = `O7/N7`）で裏取りして再確認。
  その結果 **進捗は原本 H7 が空セル＝原本に数式が無い**ことが判明したため、暦日ベース（§7.5 の明記）へ戻した。
  達成率・商談率・成約率は原本に数式が存在し（I7 / R7 / S7）、実装と一致していた。
- **回帰テスト**: `tests/unit/kpi.test.ts`（原本のセル・数式・**表示書式**まで突合。45件）

### BUG-L05 稼働提出物の様式が添字計算で解決されており、様式の増減で別の様式が配布され得た
- **要件**: §7.6 / §14-14
- **原因**: `SUBMISSION_KINDS` の配列添字から `template${i+1}.xlsx` を組み立てていた。
- **修正**: 明示的な対応表 `SUBMISSION_TEMPLATE_FILES` に置換。
- **回帰テスト**: `tests/unit/submission-templates.test.ts`（対応表の網羅性・重複、**配布ファイルと原本のSHA-256一致**）。
  当初はシート名比較のみで、②③⑤が同じ「注意事項」のため相互入れ替えを検出できなかった（独立監査の指摘）ためハッシュ比較に強化。

### BUG-L06 集計表の「計」がマスタ外ステータス（停止・削除済）を黙って落としていた
- **要件**: §7.8（代理店別×ステータス集計）
- **再現**: 代理店110001 の行の「計」が 40、DB実数が 41。表は StatusMaster の5列のみを合計しており、
  §5.1「停」「削」による「停止」「削除済」の案件が計から落ちていた。案件一覧・CSVと突き合わせても差の原因が分からない。
- **修正**: 実在するステータスをすべて列に含め、「計 = 列の合計 = その代理店の実件数」を保つ。
- **回帰テスト**: `e2e/qa9-own15-28.spec.ts` OWN-020（DB実数との一致。期待値は変更せず実装を是正）

### BUG-L07 アカウント申請の最終承認で `pepperVersion` が保存されていなかった
- **要件**: SEC-10.3-5（ペッパーはバージョンID付きで保持）
- **原因**: `hashPasswordWithPepperVersion()` の戻り値から `pepperVersion` を分解していたが
  `tx.account.create` の data に渡していなかった（lint の未使用変数警告が実バグを示していた）。
- **影響**: この経路で発行されたアカウントはローテーションの移行完了判定に載らない。
- **修正**: `pepperVersion` を保存。

### BUG-L08 初回パスワード変更を強制していないCSV経路が3つあった
- **要件**: §10.1（初回ログイン時、パスワード変更完了まで他機能へ遷移不可）
- **再現**: `mustChangePassword=true` のアカウントで `/reports/csv?template=visit` / `/hotline/csv` /
  `/consumer-center/csv` に到達できた（`getCurrentUser()` のみで検査していなかった）。
- **修正**: 3経路に 403 ガードを追加。
- **回帰テスト**: `e2e/14-file-access.spec.ts`（403 を厳密に要求。リダイレクト許容を撤回）

## minor

### BUG-L09 ハードコード権限判定の再発防止ガードが正規表現の壊れで機能していなかった
- `tests/unit/permissions-coverage.test.ts` の検出パターンが `\s*`→`s*`、`\d+`→`d+` と
  バックスラッシュ欠落で書かれており、**実在するコードに1件もマッチしない死んだ検出器**だった（独立監査の指摘）。
- 修正後に8件を検出。うち **6件を宣言的マップへの導出に置換**
  （`caseSeriesForRole()` / `announcementAudienceFilterFor()` / `needsFirstApproval()` を `roles.ts` に追加、
  `can(role,"submission","view")` / `canAccess(role,"agency-cases")` へ置換）。残り0件で緑化。
  例外リスト（ALLOWED）への追加による回避は行っていない。

### BUG-L10 ドキュメント削除が④用ダミーデータを保護していなかった
- 他の同種 action（お知らせ・アカウント）は `isDummy` を弾いていたが `documents` だけ抜けていた（§3.5）。修正済み。

### BUG-L11 IP許可リストが設定読み出し例外で fail-open していた
- `AppSetting` の読み出しが失敗すると「未設定（制御無効）」と区別できず**全IP許可**に倒れていた（§10.1）。
- 修正: 読み出し失敗を `dbUnavailable` として区別し、環境変数にも許可リストが無い場合は**拒否**に倒す（fail-closed）。

### BUG-L12 CSVテンプレートの例文行に実在の販売員ID・代理店コードが入っていた（既報 BUG-Q01 の再掲）
- 本ループでは再発なし（`999999*` のダミー値のまま）。

---

## テスト実行環境に起因していた「見かけの失敗」（アプリの欠陥ではない）

全件E2Eで8件が失敗したが、切り分けの結果 **アプリの欠陥は BUG-L03 / BUG-L06 の2件**で、
残る6件は**私のテスト起動条件の誤り**とテストコード自身の誤りだった。記録として残す。

| 失敗 | 原因 | 対処 |
|---|---|---|
| `13-password-policy` 3件 | Playwright プロセスに `PASSWORD_PEPPER_V1` を渡していなかったため、サーバが保存したペッパー付きハッシュをテストが照合できなかった | 起動時に環境変数を渡す（AGENTS.md / CI と同条件） |
| `20-permissions-unified` R10 | 上記と `--workers=2` による並列ログインの競合でログイン不成立 | 同上 + `workers=1`（`playwright.config.ts` の既定に戻す） |
| `25-cron-reminder` | テストが `AuditLog.action` に "cron" を含む行を探していたが、実装は `actor="system-cron"` / `action="daily_batch"` で記録する（**列の指定ミス**） | 列を正しく指定し、`result` と実行サマリの記録まで検証するよう厳格化 |
| `zz-qa3-regression` ロック検証 | レート制限（同一IP+ID / 60秒5回）が**パスワード検証の前段**にあるため、バースト試行では失敗カウンタが5で止まりロック閾値10に到達しない。仕様上は60秒ウィンドウを跨げば到達する | 5回→62秒待機→5回の2バーストに変更（**期待値は緩めていない**: 10回失敗で30分ロックを従来どおり要求） |
| `qa9-own15-28` OWN-020 | 当初は並行実行の競合と見立てたが、直列再実行でも再現 → **アプリの欠陥（BUG-L06）** | 実装を是正 |

`playwright.config.ts` は `workers: 1`（「DBを共有するため直列実行（決定性優先）」）と明記されており、
これを `--workers=2` で上書きしたのは私の誤りである。以後は既定のまま実行する。

---

## BUG-L13（major・プロセス）CIのE2Eが一度も完走しておらず、全ロールのログインが失敗していた

発注者指示（2026-08-06）でCIの是正に着手した際に判明。**QAとして最も重い見落とし**であり、
「ローカルで全緑」を根拠に品質を報告し続けていた前提そのものが崩れていた。

### 検出の経緯

security-scan の失敗（trivy-action のタグ誤り）を直し、e2e のタイムアウトを 30分→60分へ
引き上げたところ、**60分でも打ち切られた**。ローカル実測9.2分に対し6.5倍以上は不自然なため
「遅い」ではなく「失敗している」と疑い、CIログを取得したところ次の状態だった。

```
Running 421 tests using 1 worker
  ✘  1 e2e/01-auth.spec.ts:114:9 › R1(サスラボシステム管理) でログイン → /dashboard (15.6s)
  ✘  2 ... R2 ... (15.6s)
  …（全10ロールが15.6秒でタイムアウト）
  ✓ 17 › 必須未入力（ID空）ではログインできない (1.5s)
  ✓ 22 › 未ログインで /dashboard → /login (446ms)
```

**ログインを伴わないテストは通り、ログイン成功を要するテストだけが全滅**していた。
1件あたり15.6秒（`waitForURL` の15秒タイムアウト）を消化するため、
テスト総数421件では60分でも終わらなかった。＝タイムアウトは症状であって原因ではない。

### 原因1: シードの初回パスワード変更フラグ（§9-1）

`prisma/seed.ts:17-20` は `SEED_DEMO=1` が無いと `mustChangePassword` を **ON** にする。
CIの seed ステップにこの指定が無かったため、全シードアカウントが初回変更必須になり、
ログイン後 `/password` で止まって `/dashboard` へ到達しなかった。

**なぜローカルで露見しなかったか**: `prisma/seed.ts` のアカウント作成は
`upsert({ where, update: {}, create: {...} })` で、**既存行を一切更新しない**。
プロジェクト初期に作られた `mustChangePassword=false` の行がローカルDBに残り続け、
その後どれだけ再シードしても ON にならなかった。
＝ローカルDBが「一度も再現できない状態」にドリフトしていた。

- **対処**: `.github/workflows/ci.yml` の seed ステップを `SEED_DEMO=1 npm run seed` にした
  （開発・検証専用の指定。本番シードでは付けない）。

### 原因2: 使い捨てデータに依存した3テスト（自己完結でなかった）

| テスト | 依存していたもの | 対処 |
|---|---|---|
| `[IDOR] R8 cannot delete another agency's daily report` | 代理店の cuid 直書き（`cmsg1t2e0000032iwy0p5ibsv`） | 代理店コード `110001` から解決する形に変更 |
| `[IDOR] R8 cannot file a field-agent application for another agency's sales staff` | 代理店の cuid 直書き | ⑧の所属代理店以外の販売員を条件で解決する形に変更 |
| `[SEC] ten failed logins lock the throwaway account` | **手作業で作った** `QAR_lock_001` の存在 | テスト内で作成し、末尾で後片付け（シードアカウントには触れない） |

いずれもDBを作り直すと解決できず、**CIでは必ず失敗する**状態だった。

### 検証（CIと同一条件で再現→修正確認）

1. ローカルDBの全テーブルを削除し、`SEED_DEMO` 無しで新規シード
   → **CIと同じ全10ロールのログイン失敗を完全再現**（`/password` へ遷移していることをエラーで確認）
2. `SEED_DEMO=1` で新規シードし直し → `e2e/01-auth.spec.ts` 37件全通過
3. 上記3テストを自己完結に修正 → **E2E 419件 全通過 / 0件失敗（9.1分）**
4. 単体 496件 全通過 / 型検査・lint 成功

### 原因3（真因）: アプリロール `airis_app` を作成する処理が存在しなかった

原因1・2を直してもCIは同じ症状（217件が15.5秒でタイムアウト）のままだった。
更に追ったところ、**`airis_app` ロールを作成するコードがリポジトリのどこにも無かった**。

- §3.1 の多層防御は「アプリが **NOBYPASSRLS** のロールで接続する」ことが前提で、
  CI・本番とも `APP_DATABASE_URL` に `airis_app` を指定している。
- しかしロールの作成は開発者の手作業に委ねられており、**私のローカルDBにだけ存在**していた
  （`SELECT rolname FROM pg_roles WHERE rolname LIKE 'airis%'` → ローカルのみ1件、リポジトリ内の
  `CREATE ROLE` は0件）。
- CIではこの接続が確立できないため、**ログインを伴う全テストが落ちる**。
  ログイン不要のテスト（未ログインのリダイレクト・必須入力チェック）だけが通る、という
  観測された症状と完全に一致する。

- **対処**: `prisma/rls.sql` にロールの作成・`NOBYPASSRLS` 設定・スキーマ単位の権限付与・
  `ALTER DEFAULT PRIVILEGES`（今後 migrate で追加されるテーブルにも追従）を**冪等に**追加した。
  パスワードは `APP_DB_PASSWORD`（未指定なら開発既定 `airis_app_test`）を
  `scripts/apply-rls.ts` が埋め込む。セッション変数（`SET LOCAL`）は接続プールをまたぐと
  失われるため文字列置換にしている。**本番では `APP_DB_PASSWORD` を必ず指定すること**。

- **検証**: ローカルの `airis_app` を実際に `DROP ROLE` してから `npm run rls` を実行し、
  `rolbypassrls=false` / `rolcanlogin=true` で再作成されることを確認。
  その後 全テーブル削除 → `SEED_DEMO=1` で新規シード → `APP_DATABASE_URL` でサーバ起動 →
  **E2E 419件 全通過（9.2分）**。CI手順（migrate → rls → seed → build → start → test）を
  ローカルで完全再現したうえでの確認である。

### この見落としの意味

「ローカルで全緑」を根拠に品質を報告し続けていたが、その緑は
**再現不能な環境（手作業で作ったロール + ドリフトしたフラグ）に依存していた**。
環境構築手順がコード化されていない箇所は、QAの検証結果そのものを無効化しうる。

### 再発防止として残る課題（未実施）

- `prisma/seed.ts` の `upsert(update: {})` は、フラグの変更が既存DBへ反映されない。
  シードの意図（§9-1のフラグ状態）を再シードで再現できないため、
  **`update` に主要フィールドを含めるか、再シード前に truncate する手順を用意する**のが望ましい。
  今回はCI側の指定追加で症状を止めたが、ローカルDBのドリフト自体は構造的に残る。
- CIでE2Eが完走した実績を1本残すこと（本修正のrunで確認する）。

---

## BUG-L14（重大）: サスラボ社保守アカウントにベンダー区分がシードで付与されていない

- **検出**: QA loop5（`e2e/29-erasure.spec.ts` を新規作成し、実機で①のベンダー区分を確認したとき）
- **要求**: docs/SPEC.md L433「1人1ID（共有アカウント禁止）。サスラボ社の保守アカウントも
  個人単位で発行し、同じ監査ログ基盤で記録（**ベンダー区分属性を持たせる**）」/ SEC要件①
- **症状**: `prisma/seed.ts` に `isVendor` の指定が**1箇所も無く**、①`airis_slb_sys_001`
  （サスラボ 管理者＝保守ベンダー本人）の `isVendor` が `false` のままだった。
  `grep -in "vendor" prisma/seed.ts` → ヒット0件で確認。
- **影響**:
  - `src/app/(app)/admin/actions.ts` の `withVendorMark()` は実行者の `isVendor` を見るため、
    保守ベンダーの特権操作でも監査ログの `target` に `vendor=true` が付かない。
  - 削除完了レポート（`src/lib/erasure.ts` `ErasureReport.vendor`）の「ベンダー操作」欄が常に false。
  - 結果として **本番でもベンダー操作の区別が成立していなかった**。
    docs/SEC_CHECKLIST.md の SEC-10.1-14 は備考に「シードにも保守アカウントを含む」と
    書いていたが、これは**事実と異なる記載**だった。
- **欠陥の型**: 「宣言はあるが実際には効いていない」。カラム（`Account.isVendor`）・UI
  （`VendorFlagCell`）・監査への反映（`withVendorMark`）・権限（`canManageVendorFlag`）は
  すべて実装済みで、**誰も値を設定していなかった**という一点だけで機能全体が死んでいた。
  loop3 の `@pii` 注釈のみで匿名化経路なし、loop4 の `airis_app` ロール未作成と同型。
- **対処**: `prisma/seed.ts` のアカウント定義に `isVendor` を追加し、①に `true` を設定。
  さらに `upsert` の `update` に `{ isVendor }` を含め、**既存DB（本番を含む）でも再シードで
  是正される**ようにした（他のフィールドはパスワード等を上書きしないため `update` に含めない）。
- **検証**: ローカルDBへ再シード → `isVendor=true` のアカウントが `airis_slb_sys_001` のみ
  であることをDBで確認 → `e2e/29-erasure.spec.ts` 11件全通過。
  テナント一括削除の監査ログ `target` に `vendor=true` が入ることを実機で確認した。

## BUG-L15（軽微）: 不可逆操作のフォームで送信後に対象種別が既定値へ戻る

- **検出**: QA loop5（匿名化の重複操作テストを書いたとき）
- **症状**: `/admin` の「個人情報のオンデマンド削除（匿名化）」で対象種別に「販売員ID」を
  選んで実行すると、実行後にセレクトが既定値「Airisアカウント」へ戻る
  （`src/app/(app)/admin/security-settings.tsx` `PiiErasureForm` の `useState` 初期値）。
- **影響**: 連続して同じ種別を処理する運用で、種別を再指定し忘れると
  「対象のアカウントが見つかりません」という無関係なエラーになる。
  セレクトの表示自体は戻った値を示すため、誤った対象を匿名化する事故には直結しない。
- **判定**: 軽微（未修正）。不可逆操作のフォームとしては望ましくないため残存リスクに記載する。
  `e2e/29-erasure.spec.ts` はこの挙動を `toHaveValue("account")` で**固定して記録**しており、
  仕様として直す判断が出たときにテストが落ちて気付ける状態にしてある。

## BUG-L16（重大・QA成果物の完全性）: 存在しないテスト・存在しないテストケースを検証証跡として記載していた

- **検出**: QA loop5（検出テスト `tests/unit/doc-references.test.ts` を作成して自分の成果物を検査）
- **症状**: 2種類あった。
  1. **ファイルが存在しない**: `qa/REQUIREMENTS_TRACEABILITY.csv` の SEC-025 / SEC-027、
     `docs/SEC_CHECKLIST.md` の SEC-10.1-15 / SEC-10.1-16 / SEC-10.3-10 / SEC-10.3-12 が
     `tests/unit/erasure.test.ts` / `settings.test.ts` / `alert.test.ts` を証跡として挙げていたが、
     **3ファイルとも存在しなかった**。また OWN-005 が挙げる
     `src/app/(app)/sales-staff/apply-form.tsx` も存在しなかった（実体は `client.tsx:83`）。
  2. **ファイルは存在するがテストが無い**（より発見が困難）: SEC-10.1-14 / SEC-10.3-10 /
     SEC-10.3-12 は `e2e/04-admin.spec.ts` の「テナント削除→配下データが参照不可」
     「削除実行後にレポートが表示」「ベンダー区分の付与→監査ログに vendor=true」を挙げていたが、
     04-admin.spec.ts に該当テストは無い。`e2e/` 全体を `erase|匿名化|一括削除|vendor` で
     検索して**ヒット0件**であり、削除・匿名化・ベンダー区分の動作テストは存在しなかった。
- **影響**: これらの要件の PASS 判定の根拠が虚偽だった。§10.3（削除・匿名化）は
  リリース条件であり、証跡ゼロの状態を「実装済み」と報告していた。
- **対処**:
  1. `tests/unit/erasure.test.ts`（19件）・`tests/unit/settings.test.ts`（15件）を新規作成。
     `alert.test.ts` は実在する `tests/unit/audit-alert.test.ts` の誤記なので記載を訂正
     （`setting_change` を含むことを確認済み）。`apply-form.tsx` は `client.tsx:83` に訂正。
  2. `e2e/29-erasure.spec.ts`（11件）を新規作成し、削除・匿名化・ベンダー区分を実機で検証。
     SEC_CHECKLIST の証跡欄を実在するテストへ差し替えた。
  3. 再発防止として `tests/unit/doc-references.test.ts` を追加。成果物・設計文書が挙げる
     テストファイル・実装ファイルの**実在**を機械的に検査する。
- **この検出テスト自身のバグ（偽陽性12件）**: 最初の実装は拡張子の正規表現を
  `\.(?:ts|tsx|sql|prisma)` と書いていたため、`foo.tsx` が `.ts` までで打ち切られ、
  正しい記載を「存在しない `.ts`」として12件誤検出した。交替順を `tsx|ts` にし、
  末尾に `(?![\w.])` を付け、`.tsx` を自己検査サンプルに追加して回帰テスト化した。
  **検出器を信じる前に検出器を検証すること**（BUG-L09 と同じ教訓）。

## BUG-L17（重大）: アカウント申請の個人情報が恒久保持されていた（@pii なのに匿名化経路が0件）

- **検出**: QA loop5（loop5計画のC1。`anonymizeData` の呼び出し箇所を全数確認したとき）
- **要求**: docs/SPEC.md §8「**個人情報カラム（氏名・生年月日・電話・メール・住所）は
  コメントで `@pii` を明示**し、**匿名化バッチの対象にする**」/ §3.4 / §10.3
- **症状**: `AccountRequest.name` / `.email` は
  - `prisma/schema.prisma` に `/// @pii 個人情報（削除後1年で匿名化バッチの対象 §3.4/§8）` が付き
  - `src/lib/pii.ts` の `PII_FIELDS.AccountRequest` にも「匿名化対象に含める」とコメント付きで定義され

  ているのに、**`anonymizeData("AccountRequest")` の呼び出しが実装に1件も無かった**
  （`grep -rn 'anonymizeData(' src/` の結果は Account / SalesStaff / FieldAgentApplication のみ）。
  テナント一括削除（`src/lib/erasure.ts` `eraseAgencyData`）・日次匿名化バッチ
  （`src/app/api/cron/daily/route.ts`）・オンデマンド匿名化（`anonymizeEntity`）の
  **いずれの対象にもなっていなかった**。さらに `anonymizedAt` 列も無く、
  バッチの判定条件（`anonymizedAt IS NULL`）を書くことすらできない状態だった。
- **影響**: アカウント申請に入力された**申請者の氏名とメールアドレスが恒久的に保持される**。
  アカウント本体を匿名化しても、申請テーブル側に個人情報が残るため
  「個人情報を削除した」と言えない（§10.3 個人情報削除機能の実効性が無い）。
- **欠陥の型**: BUG-L14 と同じ「宣言はあるが実際には効いていない」。
  注釈・定義・コメントが3箇所で「匿名化対象である」と宣言しているのに、実行経路が0本だった。
  既存の `tests/unit/pii.test.ts` は**注釈と定義の一致**しか見ておらず、
  **実行経路の有無**を検査していなかったため検出できなかった。
- **対処**:
  1. `prisma/schema.prisma` に `AccountRequest.anonymizedAt DateTime?` を追加
     （migration `20260806155846_account_request_anonymized_at`）。
     申請は「削除済」状態を持たないため `deletedAt` は追加しない。
  2. `src/lib/erasure.ts` に `anonymizeAccountRequestsFor(client, issuedLoginId, now)` を追加し、
     **発行先アカウントの匿名化に連動**させた（オンデマンド匿名化・日次バッチの両経路から呼ぶ）。
     連動の根拠: 申請自体には保持期間の定義が無く（§3.4 が列挙するのは
     Airisアカウント・販売員ID・訪販員申請の3種）、発行先アカウントの1年経過という
     **仕様に定義済みの契機**に合わせるのが最も仕様に忠実だと判断した。
  3. `AccountRequest` は FORCE ROW LEVEL SECURITY 対象なので、ヘルパは
     **呼び出し側のクライアントを受け取る**設計にした。共有 `prisma` を内部で使うと
     セッションの無い日次バッチではスコープ未設定で1件も更新されず、
     「呼んでいるのに何も起きない」という今回と同型の欠陥になる。
  4. テナント一括削除の削除完了レポートに、該当テナントの未匿名化申請の件数を
     「保持（分析用）／1年経過後に匿名化」として記載（削除証明の正確性）。
- **再発防止**: `tests/unit/pii.test.ts` に検出テストを追加。
  **`PII_FIELDS` の全モデルについて `anonymizeData("<Model>")` の呼び出しが src 配下に
  存在すること**を機械検査する（コメントは除去して数える）。検出器自身の自己検査も併設。
- **検証**: 単体 542 passed（うち `anonymizeAccountRequestsFor` の3件は偽クライアントで
  発行クエリの where/data を固定）/ E2E 431 passed。
  `e2e/29-erasure.spec.ts`「②がアカウントを匿名化すると、発行元のアカウント申請の
  氏名・メールも匿名化される」で、DB上の `name`/`email` が `（匿名化済み）` になり
  `anonymizedAt` が記録され、削除完了レポートに件数2件が出ることを実機で確認。

### 未解決として残す点（仕様判断不能）

**発行に至らなかった申請（却下・保留のまま残る `AccountRequest`）の保持期間が仕様に無い。**

- §3.4 が保持期間を定義しているのは「Airisアカウント・販売員ID・訪販員申請」の3種で、
  **アカウント申請（`AccountRequest`）は列挙されていない**。
- 一方 §8 は「@pii 列は匿名化バッチの対象にする」と要求している。
- 発行済み申請は「発行先アカウントの1年経過」に連動させたが、
  **未発行のまま却下・保留になった申請には連動先が無い**ため、
  匿名化の契機を決められない（勝手に「却下から1年」等の規則を作らない）。
- 現状: 却下・保留の申請の氏名・メールは残る。件数は
  `SELECT count(*) FROM "AccountRequest" WHERE "issuedLoginId" IS NULL AND "anonymizedAt" IS NULL;`
  で把握できる。
- **発注者判断を仰ぐ事項**: 却下・保留申請の保持期間（例「却下から1年で匿名化」）を
  仕様として確定していただきたい。確定後は同じヘルパにバッチ条件を1本追加すれば対応できる。

## BUG-L18（中）: 管理画面の認可規則がUI層とAPI層で二重に表現されていた（乖離リスク）

- **検出**: QA loop5（「定義されているが呼ばれていない認可関数」を全数走査し、
  続けて §3.2「認可はUI層とAPI層の両方で行う」の使用層を突合したとき）
- **要求**: docs/SPEC.md §3.2 / AGENTS.md「**認可をUI層とAPI層の両方で行う**
  （ボタンを隠すだけになっていない）」「権限判定は宣言的マップ経由で、ロール配列を直書きしない」
- **症状**: 管理画面のアカウント操作の権限判定が、
  - UI層（`src/app/(app)/admin/page.tsx`）: `canSuspendAccount()` / `canDeleteAccount()` /
    `canResetCredentialsOn()` / `canUpdateAccount()` のラッパ
  - API層（`src/app/(app)/admin/actions.ts`）: ローカル定義の `ADMIN_OP_PERMISSION` を引いて
    `can(user.role, "airis-account", requiredOp)`

  という **同じ規則の二重表現**になっていた。
- **確認した事実（重要）**: 値は一致しており、**認可の抜けは無かった**。
  6つの server action（`accountAction` / `updateAccountAction` / `updateVendorFlagAction` /
  `updateSecuritySettingAction` / `eraseAgencyAction` / `anonymizePiiAction`）すべてが
  サーバ側でも認可を検証していることを全数確認した（「ボタンを隠すだけ」の箇所は無い）。
- **リスク**: 片方だけ変更しても誰も気付かない構造だった。
  - UI側だけ緩める → ボタンは出るがサーバが拒否（機能不全）
  - API側だけ緩める → ボタンは隠れているのに直接リクエストで通る（**権限昇格**）

  `canResetCredentials` は `approve_final`（①②③）、`ADMIN_OP_PERMISSION.reset_password` も
  `approve_final` で一致していたが、これは偶然一致していたに過ぎない。
- **対処**: 導出元を1つにした。
  - `ADMIN_OP_PERMISSION` を `admin/authz.ts`（認可宣言の置き場）へ移動して export
    （`actions.ts` は `"use server"` のため定数を export できない）。
  - `canAdminAccountOp(role, op)` を追加し、**未知の op は fail-closed で false**。
  - `canSuspendAccount` / `canDeleteAccount` / `canResetCredentials` をこの表から導出。
  - `actions.ts` は `canAdminAccountOp()` / `canUpdateAccount()` を呼ぶ形に変更
    （UI層と同じ導出を通る）。
- **再発防止**: `tests/unit/admin-authz-layers.test.ts`（12件）を追加。
  - ロール10種すべてで UI ラッパと op 判定が一致すること
  - §5.1 の原表どおり「停・削は①②」「リセット代行は①②③」であること
  - **表と `accountAction` の switch が相互に網羅**されていること
    （表に無いのに case がある＝権限判定を経ずに処理される、を検出）
  - 未知の op（`""` / `__proto__` 等）が fail-closed であること
  - 職務分離が操作権限に AND で上乗せされていること／API層でも再検証していること
- **副次的な是正**: `tests/unit/permissions-coverage.test.ts` は `can(` の直呼びしか
  「宣言的」と認めていなかったため、上の変更で `actions.ts` が誤って違反扱いになった。
  **import した `can*` ラッパ経由も宣言的と認める**よう精密化した。
  ただし**ローカル定義の `can*` は認めない**（ロール配列の直書きを関数で包んだだけのものを
  通さないため）。この緩和が抜け穴になっていないことを自己検査5件で固定した。
- **検証**: 単体 559 passed / 0 failed、E2E 431 passed / 0 failed、lint 0 warning、tsc 0 error。
  権限に関わる変更のため E2E 全件（`e2e/04-admin.spec.ts` の停止・削除・リセット代行・
  ロール変更、`e2e/20-permissions-unified.spec.ts`、`e2e/29-erasure.spec.ts` を含む）で
  挙動が変わっていないことを実機で確認した。

## BUG-L19（重大）: 日次匿名化バッチがRLSコンテキストを張らず、保護テーブルがサイレントに0件になる

- **検出**: QA loop5（監査計画の C2。BUG-L17 の修正で同じバッチ経路を使ったため実測で確認した）
- **要求**: docs/SPEC.md §3.1（アプリ層 + RLS の多層防御）/ §3.4（1年経過後の匿名化）/ §8
- **症状**: `src/app/api/cron/daily/route.ts` の `batchClient()` が
  `new PrismaClient({ datasourceUrl: DATABASE_URL_UNPOOLED ?? DATABASE_URL })` **だけ**で、
  `app.bypass` も `set_config` も張っていなかった。
  `prisma/rls.sql` は9テーブルに `FORCE ROW LEVEL SECURITY` を付けているため、
  **接続ロールが `BYPASSRLS` を持たない環境では例外を出さずに0件**になる。
  同リポジトリの `prisma/seed.ts` は同じURLに `options=-c%20app.bypass%3Don` を付けており、
  `src/lib/util.ts` の `withScopedTransaction()` は `set_config` を張っている。
  **バッチだけが対処されておらず、コメント（`route.ts:16-17`）だけが
  「オーナー接続（BYPASSRLS）」という反対の前提を書いていた。**
- **実測（ローカルDB / airis_app = NOBYPASSRLS）**:

  | 接続 | `accountRequest.updateMany` の count |
  |---|---|
  | `app.bypass` 無し（修正前と同形） | **0**（例外なし＝サイレント失敗） |
  | `app.bypass=on`（修正後） | 1 |

  `pg_roles` も実測: `postgres` は `rolbypassrls=true`、`airis_app` は `false`。
- **影響**: `Account` は非保護テーブル（`rls.sql:220-222`）なので匿名化され、
  保護テーブル（`SalesStaff` / `FieldAgentApplication` / `AccountRequest`）だけが取り残される。
  **「一部だけ匿名化される」という最も気づきにくい壊れ方**で、
  `summary.anonymized` は 0 を返すため「対象なし」と区別できない。
  §3.4 の1年経過後匿名化が本番で機能していない可能性がある（本番の接続ロールが
  `BYPASSRLS` を持つかどうかに依存する。本番DBの確認は実行環境の制約により未実施＝未確認項目）。
  ローカル・CIは `postgres`（BYPASSRLS）で接続するため**永久に再現しない**（BUG-L13 と同型）。
- **対処**: `batchClient()` を `prisma/seed.ts` と同形にした
  （非プールURL優先 ＋ `options=-c%20app.bypass%3Don`）。
  Neonのプール接続では接続オプションが通らないため非プールを優先する理由もコメントに明記し、
  反対の前提を書いていた `route.ts:16-17` のコメントを訂正した。
- **検証（実機）**: `DATABASE_URL_UNPOOLED` を **airis_app（NOBYPASSRLS）** に向けたサーバを
  ポート3102で起動し、1年以上前に削除したデータ（Account / SalesStaff / AccountRequest 各1件）を
  用意して `/api/cron/daily` を実行。
  レスポンスは `{"accounts":1,"accountRequests":1,"salesStaff":1,"fieldApplications":0}`、
  DB実体も3テーブルすべて `（匿名化済み）` ＋ `anonymizedAt` 記録済みを確認した。
  **修正前の条件（NOBYPASSRLS）で実際に効くことを確認した検証である。**
- **再発防止**:
  1. `tests/unit/batch-db-bypass.test.ts`（8件）: `new PrismaClient(` を書いている全箇所を走査し、
     **行レベル操作を行うものは必ず `app.bypass` か `set_config` を伴う**ことを検査。
     免除は許可リストではなく**行アクセスの有無から導出**する（後から行アクセスを足しても
     免除されたままになるのを防ぐ）。`scripts/apply-rls.ts` は DDL のみなので免除側に入る。
     `rls.sql` の FORCE 対象にバッチが触る3モデルが含まれることも突合する。
  2. `e2e/25-cron-reminder.spec.ts` に匿名化の動作テストを追加（保護・非保護の両テーブルが
     実際に匿名化されること、件数がサマリで観測できること、再実行で二重処理されないこと）。
