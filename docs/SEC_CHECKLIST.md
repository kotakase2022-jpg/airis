# SECチェックリスト突合せ（docs/SEC_CHECKLIST.md）

要求仕様書 **§10 セキュリティ要件（リリース条件）** の各項目を1行1項目に分解し、実際のコードを確認して
実装状況を突合せた表。§12 M8成果物「SECチェックリスト突合せ」に相当する。

- 一次ソースは [docs/SPEC.md](SPEC.md) §10.1〜§10.6（= 発注元の要求仕様書）。
- **突合せ基準日: 2026-08-05**。「実装箇所」の行番号はこの時点のもの（並行開発中のためズレる可能性がある。
  関数名・定数名を併記してあるのでそちらで追跡すること）。
- 実装状況の凡例:
  | 表記 | 意味 |
  |---|---|
  | 実装済み | 要求内容をアプリ実装で満たしている |
  | 部分 | 一部のみ実装。未達部分を備考に明記 |
  | 未実装 | アプリ実装が存在しない |
  | インフラ側 | アプリ実装の対象外。インフラ・運用側で担保（§10.6 / docs/OPERATIONS.md） |
- **§10.6（インフラ側要件）は本書では扱わない → [docs/OPERATIONS.md](OPERATIONS.md) §4 を参照。**

---

## §10.1 認証・アカウント

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.1-1 | MFAはTOTP（ソフトウェアトークン） | 実装済み | `src/lib/mfa.ts:26` `verifyMfaCode()`（otplib TOTP）/ `src/lib/mfa.ts:18` `mfaRequiredForRole()`（⑨以外は必須）/ 登録UI `src/app/(auth)/mfa/setup/page.tsx` / 検証UI `src/app/(auth)/mfa/page.tsx` | `npm run test:e2e -- e2e/22-mfa.spec.ts`（未登録→QR登録→検証、5回失敗でセッション破棄） | 時計ずれ許容±30秒（`src/lib/mfa.ts:15`）。連続失敗上限は `MFA_MAX_ATTEMPTS=5`（`src/lib/mfa.ts:11`） |
| SEC-10.1-2 | SMS/EmailはMFA要素として不可 | 実装済み | 該当コードが存在しないこと（MFA経路は `src/lib/mfa.ts` のTOTPのみ。メール送信 `src/lib/mail.ts` は通知専用でコード送出に使っていない） | `grep -rn "sms\|otpMail\|mailCode" src/` が0件であること / e2e/22-mfa.spec.ts でTOTP以外の要素が提示されないこと | 「実装が存在しない」ことが要求充足になる項目 |
| SEC-10.1-3 | パスワードポリシーを §4.2 のとおりロール別に強制（桁数） | 実装済み | `src/app/(auth)/actions.ts:393-397`（①②③⑦=20桁 / その他=14桁 + 大文字・小文字・数字必須）/ ロール集合 `src/lib/roles.ts:45` `ADMIN_PW_ROLES` | `npm run test:e2e -- e2e/13-password-policy.spec.ts:371`（実効⑩は14桁） | 判定は実効ロール（稼働終了代理店の⑦⑧=⑩は一般ポリシー） |
| SEC-10.1-4 | パスワード有効期間をロール別に強制（§4.2: 90日 / 180日） | 実装済み | `src/app/(auth)/actions.ts:39-41` `passwordMaxAgeDays()` / 判定 `:245-246` → `mustChangePassword=true` で `/password` へ誘導 | `npm run test:e2e -- e2e/13-password-policy.spec.ts:238,285,299` | — |
| SEC-10.1-5 | パスワード再利用禁止（§4.2: 過去24世代） | 実装済み | `src/app/(auth)/actions.ts:21` `PW_HISTORY_GENERATIONS=24` / 照合 `:399-410` / 履歴保存・剪定 `:412-432`（`PasswordHistory`） | `npm run test:e2e -- e2e/13-password-policy.spec.ts:197`（24世代内は拒否・25世代前は再利用可） | — |
| SEC-10.1-6 | ポリシー値は設定で変更可能にする | 未実装 | 該当なし（値はソース定数: `src/app/(auth)/actions.ts:21,393` / `src/lib/roles.ts:45`） | `grep -rn "appSetting" src/` が0件（設定テーブル未参照） | `AppSetting` テーブルはスキーマに存在するがアプリから参照していない。現状ポリシー値の変更には**コード修正＋再デプロイ**が必要 |
| SEC-10.1-7 | パスワードは Argon2id + ソルト（+ペッパー）でハッシュ化 | 実装済み | `src/lib/auth.ts:33-38` `ARGON2_OPTIONS`（m=19MiB/t=2/p=1）/ `:55-57` `hashPassword()` / ペッパー前段 `:50-53` `prehash()`（HMAC-SHA256、鍵=`PASSWORD_PEPPER_V1`） | `npm run test:e2e -- e2e/13-password-policy.spec.ts` / DBで `passwordHash` が `$argon2id$v=19$m=19456,t=2,p=1$…` 形式であること | ソルトはArgon2が自動生成しハッシュ文字列に埋め込まれる |
| SEC-10.1-8 | 平文・可逆暗号でのパスワード保存禁止 | 実装済み | `prisma/schema.prisma:50` `Account.passwordHash` のみ（平文列なし）/ 一時パスワードは戻り値でのみ返しDB・URLに残さない（`src/app/(app)/admin/actions.ts:139-140`） | `grep -rn "password" prisma/schema.prisma` に平文列が無いこと / 管理画面のパスワードリセットで一時PWが画面表示のみであること（e2e/04-admin.spec.ts） | 旧bcryptハッシュはログイン成功時にArgon2idへ自動移行（`src/lib/auth.ts:96-100`, `src/app/(auth)/actions.ts:194-200`） |
| SEC-10.1-9 | アカウントロック: 30分10回失敗 → 30分ロック | 実装済み | `src/app/(auth)/actions.ts:27-29`（`LOCK_WINDOW_MS`/`LOCK_THRESHOLD=10`/`LOCK_DURATION_MS`）/ 集計 `:48-68` `recentLoginFailures()` / 判定 `:177-188` | `npm run test:e2e -- e2e/18-access-log.spec.ts:177`（AccessLogの直近30分集計でロック、ロック中の拒否も記録） | 30分スライディングウィンドウ集計のため古い失敗は自然失効。ロック満了時にカウンタを0へ戻す（`:142-150`） |
| SEC-10.1-10 | 認証エンドポイントにレート制限 | 実装済み | `src/app/(auth)/actions.ts:23-25`（同一IP+同一IDで1分5回）/ 判定 `:115-123`（アカウント探索・パスワード検証の前段で拒否） | `npm run test:e2e -- e2e/18-access-log.spec.ts:254`（偽装プレフィクスでは回避できない） | カウンタは `AccessLog` のDB集計。**IP単位のみ**（ID横断）の制限は無く、ID横断の総当たりは §10.4 のアラート（`AUTH_FAILURE_ALERT_GLOBAL_THRESHOLD`）で検知する設計 |
| SEC-10.1-11 | 初回ログイン時、パスワード変更完了まで他機能へ遷移不可 | 部分 | ページ層: `src/lib/auth.ts:205-209` `requireUser()`（`mustChangePassword` なら `/password` へリダイレクト。`requirePage()` も経由）/ Route Handler: `src/app/files/[id]/route.ts:11`、`src/app/(app)/admin/csv/route.ts:18`、`src/app/(app)/field-agents/csv/route.ts:14` | `npm run test:e2e -- e2e/01-auth.spec.ts` / `e2e/14-file-access.spec.ts:851`（mustChangePassword=trueで403） | **未達**: `src/app/(app)/reports/csv/route.ts`・`src/app/(app)/hotline/csv/route.ts`・`src/app/(app)/consumer-center/csv/route.ts` は `getCurrentUser()` のみで `mustChangePassword` を検査していないため、初回変更前でもCSV出力に到達できる（`sales-staff/csv/*` は `requirePage()` 経由のため対象外） |
| SEC-10.1-12 | 1人1ID（共有アカウント禁止） | 部分 | `prisma/schema.prisma:41` `Account.loginId @unique` / メール重複禁止 `src/app/(app)/admin/actions.ts:192-199` / 申請時のロール・所属整合 `:201-219` | `npm run test:unit`（`tests/unit/account-approval-rules.test.ts`）/ 管理画面でメール重複が拒否されること（e2e/04-admin.spec.ts） | 「共有させない」技術的強制（同時ログイン数制限）は無い。並行ログインの疑いは日次バッチで検知して②へ通知（`src/app/api/cron/daily/route.ts:70-90`） |
| SEC-10.1-13 | サスラボ社の保守アカウントも個人単位で発行し、同じ監査ログ基盤で記録 | 実装済み | 監査ログは全アカウント共通の1経路（`src/lib/util.ts:69-91` `audit()` → `AuditLog`）。保守アカウントも通常アカウントとして発行・同経路で記録される | `/admin` の監査ログビューア・`/admin/csv?type=audit` に保守アカウントの操作が出ること | 監査基盤の分岐は存在しない（=同一基盤）ため要求充足 |
| SEC-10.1-14 | 保守アカウントにベンダー区分属性を持たせる | 部分 | `prisma/schema.prisma:60` `Account.isVendor`（列のみ） | `grep -rn "isVendor" src/ prisma/seed.ts` が0件 | **未達**: 列は追加済みだがアプリ（申請・管理画面・監査ログ・シード）から一切参照・設定されていないため、実運用でベンダー区分を判別できない |
| SEC-10.1-15 | 管理系画面へのIP許可リスト制御を設定可能にする | 部分 | `src/lib/auth.ts:216-231` `isAdminIpAllowed()`（環境変数 `ADMIN_IP_ALLOWLIST`。未設定=無効、信頼IP不明=拒否のfail-closed）/ 適用: `/admin` ページ `src/lib/auth.ts:235-241`、`/admin/csv` `src/app/(app)/admin/csv/route.ts:27` / IP解決 `src/lib/client-ip.ts` | `npm run test:e2e -- e2e/17-security-hardening.spec.ts` / `npm run test:unit`（`tests/unit/trusted-ip.test.ts`）/ `ADMIN_IP_ALLOWLIST` を設定して `/admin` が403相当（`/dashboard?denied=admin`）になること | **未達**: 仕様の「環境変数/**設定テーブル**」のうち設定テーブル経由（`AppSetting`）は未実装のため、変更に再デプロイが必要。制御対象は管理画面（`admin`）系のみ |
| SEC-10.1-16 | IP許可リスト等の設定変更自体も監査ログ対象 | 未実装 | 該当なし（拒否イベントのみ記録: `src/lib/auth.ts:238`, `src/app/(app)/admin/csv/route.ts:29`） | `grep -rn "setting_change\|config_change" src/` が0件 | 設定は環境変数のためアプリ外（Vercel）で変更され、アプリの監査ログに残らない。変更手順・記録は [docs/OPERATIONS.md](OPERATIONS.md) §1「環境変数の所在」で運用担保 |

## §10.2 セッション

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.2-1 | セッション絶対期限 ≤24時間 | 実装済み | `src/lib/auth.ts:17` `ABS_HOURS`（既定24 / `SESSION_ABSOLUTE_HOURS`）/ 発行 `:125-139` / 失効判定 `src/lib/session.ts:53` | `Session.expiresAt` がログイン時刻+24hであること / e2e/01-auth.spec.ts | 環境変数で24hを**超える**値も設定できてしまう（上限クランプなし）。運用値は [docs/OPERATIONS.md](OPERATIONS.md) で固定する |
| SEC-10.2-2 | アイドル期限 ≤60分 | 実装済み | `src/lib/session.ts:8` `IDLE_MIN`（既定60 / `SESSION_IDLE_MINUTES`）/ 判定 `:54` / `lastSeenAt` 更新 `:56-58` | `Session.lastSeenAt` を61分前に書き換えて保護ページが `/login` へ落ちること（e2e/01-auth.spec.ts） | 同上（上限クランプなし）。MFA未完了セッションも60分で失効（`src/lib/auth.ts:188`） |
| SEC-10.2-3 | ログアウトでサーバ側セッション破棄 | 実装済み | `src/lib/auth.ts:141-148` `destroySession()`（`Session` 行削除＋Cookie削除）/ `src/app/(auth)/actions.ts:437-442` `logoutAction()` | e2e/01-auth.spec.ts（ログアウト後に戻るボタンで保護ページへ到達できないこと） | 停止・削除・ロール変更・パスワード/MFAリセットでも全セッションを破棄（`src/app/(app)/admin/actions.ts:85,105,136,151,237`） |
| SEC-10.2-4 | Cookie: `Secure` / `HttpOnly` / `SameSite=Lax` | 実装済み | `src/lib/auth.ts:131-138`（`httpOnly:true` / `secure: NODE_ENV==="production"` / `sameSite:"lax"` / `path:"/"`） | 本番（https）で `Set-Cookie` に `Secure; HttpOnly; SameSite=Lax` が付くこと（e2e-prod/prod-smoke.spec.ts で確認可） | `Secure` は本番のみ（開発はhttpのため）。本番相当環境では必ず `NODE_ENV=production` で起動する |
| SEC-10.2-5 | CSRF対策必須 | 実装済み | 更新系はすべて Server Action（POST）＝Next.jsが Origin と Host/X-Forwarded-Host の一致を検証（フレームワーク機構: `node_modules/next/dist/docs/01-app/02-guides/data-security.md` 「Allowed origins」）/ Route Handler は GET のみ（`grep` でPOST/PUT/DELETE/PATCH実装0件）/ Cookieは `SameSite=Lax`（`src/lib/auth.ts:134`） | `grep -rn "export async function POST" --include=route.ts src/` が0件 / 別オリジンからのServer Action呼び出しが拒否されること | リバースプロキシで別ドメインを挟む場合は `next.config.ts` の `experimental.serverActions.allowedOrigins` を設定する必要がある（現状未設定＝同一オリジンのみ許可） |

## §10.3 データ保護

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.3-1 | 通信は TLS1.2以上（TLS1.1以下無効）・HSTS | インフラ側 | 該当なし（`next.config.ts` にセキュリティヘッダ設定なし） | `curl -sI https://<本番URL> \| grep -i strict-transport-security` / SSL診断でTLS1.1以下が無効であること | Vercel既定でTLS1.2+。**HSTSヘッダの実在は未確認**（[docs/OPERATIONS.md](OPERATIONS.md) §4-14 に「要確認」として記載）。アプリ側で付ける場合は `next.config.ts` の `headers()` を追加する |
| SEC-10.3-2 | 保存データはサーバサイド暗号化（AES-256） | インフラ側 | 該当なし | Neon/Vercelの保存時暗号化の証跡（サービス仕様書・監査報告書）を取得 | [docs/OPERATIONS.md](OPERATIONS.md) §4-11。添付ファイルはDB（`StoredFile.data`）に格納するため、DBの保存時暗号化がそのまま効く |
| SEC-10.3-3 | SHA-1 / MD5 は用途を問わず使用禁止（CRYPTREC準拠のみ） | 実装済み | 使用箇所なし。使用しているのは Argon2id（`src/lib/auth.ts:55-57`）/ HMAC-SHA256（`:52`）/ `crypto.randomBytes`（`:126`）/ `crypto.randomInt`（`src/app/(app)/admin/actions.ts:31-36`） | `grep -rni "sha1\|md5\|createHash" src/` の結果がコメントのみであること | セッショントークンは256bit乱数（hex 64文字）でハッシュ関数を用いない |
| SEC-10.3-4 | シークレット（DBパスワード・ペッパー・Webhook等）はコードに含めない。`.env` + 本番はシークレットマネージャ | 実装済み | 参照はすべて `process.env`（例 `src/lib/auth.ts:41`, `src/lib/alert.ts:243,260`, `src/app/api/cron/daily/route.ts:220`）/ `.gitignore` で `.env*` を除外 | `git ls-files \| grep -i env` が0件であること / `grep -rn "postgres://\|Bearer [A-Za-z0-9]" src/` に実値が無いこと | 本番は Vercel 環境変数（= シークレットストア）。所在一覧は [docs/OPERATIONS.md](OPERATIONS.md) §1「環境変数の所在」。`prisma/seed.ts` の初期パスワードは開発・受入用デモデータ（§9）で本番では使用しない |
| SEC-10.3-5 | ペッパーはバージョンID付きで保持する | 部分 | `src/lib/auth.ts:28` `CURRENT_PEPPER_KEY="PASSWORD_PEPPER_V1"`（環境変数名でバージョンを表現）/ 監査記録 `src/app/(auth)/actions.ts:199`（`pepper_version=v1`） | `grep -n "PASSWORD_PEPPER" src/lib/auth.ts` / 再ハッシュ時の監査ログに `pepper_version` が出ること | **未達**: `prisma/schema.prisma:55` `Account.pepperVersion` 列がアプリから未参照（`grep -rn "pepperVersion" src/` が0件）。このため**行単位でどのペッパー版でハッシュされたかを判別できず**、旧版ペッパーの廃止可否（全件移行完了の確認）を集計で判断できない |
| SEC-10.3-6 | ログイン成功時に新バージョンで再ハッシュする方式 | 実装済み | `src/lib/auth.ts:86-101` `verifyPassword()`（ペッパー無し/旧アルゴリズムを検知して `needsRehash`）/ 実行 `src/app/(auth)/actions.ts:194-200` | ペッパー無しで作ったハッシュに対しログイン → `passwordHash` が更新され `password_rehash` の監査が残ること | 旧ペッパー版のハッシュも「現行ペッパーで不一致→ペッパー無しで照合」の経路を通るため、`PASSWORD_PEPPER_V2` へ切り替えても即日ログアウトは起きない |
| SEC-10.3-7 | 鍵・シークレットの交換手順を `docs/OPERATIONS.md` に文書化 | 実装済み | [docs/OPERATIONS.md](OPERATIONS.md) §2.1（ペッパー）/ §2.2（セッショントークン）/ §2.3（`CRON_SECRET`）/ §2.4（DB・SMTP資格情報） | 文書レビュー（年1回以上の交換手順が書かれていること） | 実際のローテーション実施記録はインフラ・運用側（§10.6 / KMS） |
| SEC-10.3-8 | データ保存先は国内リージョン（東京）前提 | インフラ側 | 該当なし | Neon/Vercelのリージョン設定を確認 | [docs/OPERATIONS.md](OPERATIONS.md) §4-12 に「**現状 us-east-1。東京リージョンへの移設が必要（リリース条件）**」として記載済み＝**未達の既知事項** |
| SEC-10.3-9 | テナント分離は §3.1（アプリ層 + RLS の多層防御） | 実装済み | アプリ層: `src/lib/auth.ts:268-289` `agencyScope()` / DB層: `prisma/rls.sql`（9テーブルに `ENABLE`+`FORCE ROW LEVEL SECURITY`）/ 受け渡し: `src/lib/prisma.ts:13-27`（クエリ毎に `set_config('app.bypass'/'app.scope')`）/ トランザクション版 `src/lib/util.ts` `withScopedTransaction()` | `npm run rls` 後に `npm run test:e2e -- e2e/17-security-hardening.spec.ts:250`（コンテキスト無しは0件=fail-closed）/ `e2e/20-permissions-unified.spec.ts` | 非保護テーブル（Account/Session/Agency/Announcement/Document/StoredFile/Notification 等）はアプリ層で制御。理由は `prisma/rls.sql:154-160` に明記 |
| SEC-10.3-10 | テナント単位のデータ一括削除機能 | 未実装 | 該当なし（代理店削除 `src/app/(app)/agencies/actions.ts:127-165` は**配下にアカウント・販売員・下位代理店・関連データが無い場合のみ**許可する安全側の実装） | `/agencies` で配下ありの代理店を削除しようとすると拒否されること（e2e/12-agencies-dashboard.spec.ts） | 解約時の一括削除（配下アカウント・販売員・日報・提出物・案件・添付の連鎖削除）は未実装。実装時は §3.4 の論理削除・保持期間と削除完了レポート（SEC-10.3-12）と整合させる必要がある |
| SEC-10.3-11 | 個人情報削除機能（§3.4 の匿名化と整合） | 部分 | 論理削除: `src/app/(app)/admin/actions.ts:97-109`（アカウント）ほか各機能の削除 / 1年経過後の自動匿名化: `src/app/api/cron/daily/route.ts:288-326` + 匿名化定義 `src/lib/pii.ts` | `npm run test:unit`（`tests/unit/pii.test.ts` が `/// @pii` 注釈と `src/lib/pii.ts` の一致を検証）/ `deletedAt` を1年以上前に設定して `/api/cron/daily` を叩き匿名化されること | **未達**: 「本人からの削除請求に即応する」オンデマンドの個人情報削除UI・APIが無い（現状は削除→1年後にバッチ匿名化のみ）。訪販員申請の誓約書PDFは匿名化時に物理削除される（`route.ts:313-316`） |
| SEC-10.3-12 | 削除完了レポートの出力（対象件数・データ種別・実行日時・実行者。削除証明用） | 未実装 | 該当なし（バッチの件数サマリは監査ログ1行にJSONとして残るのみ: `src/app/api/cron/daily/route.ts:363`） | `grep -rn "削除完了\|delete_report" src/` が0件 | SEC要件②#31 未達。レポート出力（画面/CSV/PDF）の実装が必要 |
| SEC-10.3-13 | 削除操作自体も監査ログ対象 | 実装済み | `src/app/(app)/admin/actions.ts:106`（`account_delete`）/ `src/app/(app)/agencies/actions.ts:162`（`agency_delete`）/ 各機能の削除アクション（例 `src/app/(app)/announcements/actions.ts` `deleteAnnouncementAction`）/ 記録経路 `src/lib/util.ts:69-91` | `/admin/csv?type=audit` に `*_delete` が出ること / e2e/04-admin.spec.ts・e2e/15-crud-operations.spec.ts | 削除は特権操作アラートの対象にもなる（`src/lib/alert.ts:44-64`） |

## §10.4 監査・監視

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.4-1 | 監査ログ（§3.3: いつ・誰が・何を・結果・IP） | 実装済み | `src/lib/util.ts:69-91` `audit()` / モデル `prisma/schema.prisma:411` `AuditLog`（actor/action/target/result/ip/createdAt）/ 閲覧 `src/app/(app)/admin/page.tsx:179` / 出力 `src/app/(app)/admin/csv/route.ts:56-64` | `npm run test:e2e -- e2e/04-admin.spec.ts` / `e2e/18-access-log.spec.ts`（ログイン系はアクセスログ `AccessLog` にも記録） | 認可拒否（`access_denied`）・閲覧イベント（`view_*`）・CSV出力・ファイルDLも記録（`src/lib/auth.ts:238,246,251-259`, `src/app/files/[id]/route.ts:25,31`） |
| SEC-10.4-2 | 監査ログの保存1年以上 | 部分 | 削除経路が存在しない（アプリからは `create` / `findMany` のみ: `src/lib/util.ts:84`, `src/app/(app)/admin/csv/route.ts:56`）ため自動失効しない | `grep -rn "auditLog.delete\|auditLog.update" src/` が0件 | 「1年以上保持される」ことはアプリ設計で担保されるが、**保持期間の保証・長期アーカイブ・WORM化はインフラ側**（[docs/OPERATIONS.md](OPERATIONS.md) §4-13）。DBの容量計画も運用側 |
| SEC-10.4-3 | 構造化ログ（JSON）で出力し、収集基盤に流せる形式に | 実装済み | `src/lib/util.ts:43` `auditLogRecord()` / `:76-82`（`console.log(JSON.stringify(...))` を DB書き込みより先に実行）/ アラートも同形式 `src/lib/alert.ts:278-286` | `npm run dev` でログイン等を行い、標準出力に1行JSON（`type`/`ts`/`actor`/`action`/`result`）が出ること | 収集基盤（SIEM）への転送はインフラ側（§10.6） |
| SEC-10.4-4 | `audit_logs` は append-only 設計（アプリから更新・削除するAPI/経路を持たない） | 実装済み | アプリ層: 更新・削除の呼び出しが存在しない / DB層: `prisma/rls.sql:138-152`（`REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog"` + `GRANT INSERT, SELECT` を `airis_app` に付与） | `npm run test:e2e -- e2e/17-security-hardening.spec.ts:35`（airis_appロールでUPDATE/DELETEが失敗しINSERT/SELECTは成功） | 管理者権限のUIからも編集不可。長期保管・WORM化はインフラ側（§10.6） |
| SEC-10.4-5 | 認証失敗急増のアラート設計（ログ出力+通知フックまで） | 実装済み | `src/lib/alert.ts:129-144` `recordAuthFailure()`（既定 10回/30分、ID横断は30回/30分。`AUTH_FAILURE_ALERT_*` で調整）/ 送出 `:278-286` `alert()` / 自動判定 `:292-325` `alertForAuditEvent()` ← `src/lib/util.ts:88-90` | `AUTH_FAILURE_ALERT_THRESHOLD=2` を設定して誤パスワードで2回ログイン → 標準出力に `"kind":"auth_failure_spike"` のJSONが出ること | しきい値カウンタはプロセス内メモリ（`src/lib/alert.ts:101`）のため、**複数インスタンス構成では取りこぼしがある**。恒久的な集計は日次バッチ（`src/app/api/cron/daily/route.ts:92-107`）と収集基盤側で担保 |
| SEC-10.4-6 | 特権操作のアラート設計 | 実装済み | `src/lib/alert.ts:44-64` `PRIVILEGED_ACTIONS`（アカウント停止/削除/復旧・ロール変更・パスワード/MFAリセット・販売員ID停止削除・代理店削除）/ 判定 `:147-149` / 送出 `:278-286` | 管理画面でアカウント停止 → 標準出力に `"kind":"privileged_operation"` が出ること（e2e/04-admin.spec.ts と併走で確認） | 拒否（`result=denied`）も同じ action 名で拾える |
| SEC-10.4-7 | エクスポート操作のアラート設計 | 実装済み | `src/lib/alert.ts:69-73` `EXPORT_ACTION_KEYWORDS`（`csv_export` / `CSV出力` / `CSVエクスポート`）/ 判定 `:152-154` | 各CSVをダウンロード → 標準出力に `"kind":"export_operation"` が出ること | 取込（`csv_import`）は対象外。severity は warning（`src/lib/alert.ts:32-36`） |
| SEC-10.4-8 | 通知フック（実装範囲の上限。SIEM連携はインフラ側） | 実装済み | `src/lib/alert.ts:242-257` 汎用Webhook（`ALERT_WEBHOOK_URL`、3秒タイムアウト）/ `:259-271` メール（`ALERT_MAIL_TO`） | `ALERT_WEBHOOK_URL` にテスト用エンドポイントを設定して特権操作を実行しPOSTが届くこと | 未設定なら黙ってスキップし、失敗しても業務を止めない（`:278-286`）。SIEM連携はインフラ側（§10.6） |

## §10.5 セキュア開発

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.5-1 | 入力検証（zod等） | 部分 | 各 server action での手書き検証（例 `src/app/(app)/admin/actions.ts:182-199` 必須・メール形式・重複、`src/app/(app)/announcements/actions.ts` 宛先ホワイトリスト・必須項目、`src/lib/util.ts:285` `storeFile()` のサイズ上限・拡張子ホワイトリスト `:252` `ALLOWED_EXT`）/ 入力ゆらぎ正規化 `src/lib/password-input.ts` | `npm run test:unit`（`tests/unit/csv.test.ts` / `password-candidates.test.ts` / `age.test.ts`）/ e2e/21-error-feedback.spec.ts（不正入力時のエラー表示） | **未達**: `zod` は依存に未導入（`package.json` に無い）＝スキーマ検証層が無く、検証はアクションごとの手書き。網羅性はレビュー依存 |
| SEC-10.5-2 | 出力エスケープ / XSS | 実装済み | React JSX の自動エスケープのみを使用。`dangerouslySetInnerHTML` / `innerHTML` の使用は0件 / ファイル配信時に `X-Content-Type-Options: nosniff` と `Content-Security-Policy: default-src 'none'; sandbox`（`src/app/files/[id]/route.ts:36-40`）/ 保存MIMEは拡張子から決定（`src/lib/util.ts:278-282` `safeMimeFor()`） | `grep -rn "dangerouslySetInnerHTML\|innerHTML" src/` が0件 / `e2e/14-file-access.spec.ts`（HTML添付が inline 表示されないこと） | CSV出力は式インジェクション（先頭 `=` `+` `-` `@`）の無害化を行っていない（`src/lib/csv.ts:2-10`）。Excelで開く運用のため要検討事項（仕様§10には明記なし） |
| SEC-10.5-3 | SQLi（ORM経由のみ） | 実装済み | データアクセスはすべて Prisma。生SQLは `set_config` の3箇所のみでタグ付きテンプレート＝パラメータ化（`src/lib/prisma.ts:19-20`, `src/lib/util.ts` `withScopedTransaction()`） | `grep -rn "queryRawUnsafe\|executeRawUnsafe" src/` が0件（`scripts/apply-rls.ts:76` のみ＝開発運用スクリプトで固定SQLファイルを適用） | ユーザー入力が生SQLに到達する経路は無い |
| SEC-10.5-4 | CSRF | 実装済み | → **SEC-10.2-5 と同一項目**（Server Action の Origin/Host 検証 + GETのみのRoute Handler + `SameSite=Lax`） | SEC-10.2-5 参照 | 重複記載を避けるため参照に留める |
| SEC-10.5-5 | 認可チェックのサーバ側徹底 | 実装済み | ページ: `src/lib/auth.ts:233-264` `requirePage()`（§5.2 `canAccess()`）/ server action・route handler: `src/lib/permissions.ts:163` `can()` を再検証（例 `src/app/(app)/admin/actions.ts:62`, `src/app/(app)/announcements/actions.ts`, `src/components/cases/csv-export.ts:17-24`）/ ④ダミーは書き込み全面禁止 | `npm run test:unit`（`tests/unit/permissions.test.ts` = §5.1マトリクスのテーブル駆動、`permissions-coverage.test.ts` = ロール配列直書きの検出）/ `npm run test:e2e -- e2e/20-permissions-unified.spec.ts` | UI層でボタンを隠すだけの箇所が無いことを `permissions-coverage.test.ts` とレビューで担保（AGENTS.md「認可はUIとAPIの両層で行う」） |
| SEC-10.5-6 | IDOR防止（すべての詳細取得APIでスコープ検証） | 実装済み | ファイル配信: `src/app/files/[id]/route.ts` + `src/lib/file-access.ts:10-126`（参照元エンティティを特定して権限判定／孤立ファイルは拒否＝fail-closed／存在有無を漏らさないため403統一）/ 詳細ページ: 各 `[id]/page.tsx` で `agencyScope()`・ダミー分離を検証（例 `src/app/(app)/announcements/[id]/page.tsx:26-43`）/ DB層はRLS | `npm run test:e2e -- e2e/14-file-access.spec.ts`（ロール×参照元の認可行列・孤立ファイル・存在しないID・未認証） | 窓口案件・提出物・日報の詳細も `agencyScope()` + RLS の二重防御 |
| SEC-10.5-7 | 依存ライブラリスキャンをCIに組み込む | 実装済み | `.github/workflows/ci.yml` `security-scan` ジョブ: `npm audit --audit-level=high`（high以上でCI失敗） | GitHub Actions の `security-scan` ジョブ結果 | 仕様の例示は `pnpm audit` / Dependabot だが、本プロジェクトはnpm（`package-lock.json`）のため `npm audit` を採用。**Dependabot設定（`.github/dependabot.yml`）は未作成**＝自動PRによる追随は無効 |
| SEC-10.5-8 | DockerイメージスキャンをCIに組み込む | 部分 | `.github/workflows/ci.yml` `security-scan` ジョブ: Trivy で `postgres:16` を HIGH,CRITICAL スキャン | GitHub Actions の Trivy ステップのログ | `exit-code: "0"`（検知してもCIを落とさない）＝ゲートとしては機能しない。本番はVercelマネージドでアプリコンテナを持たないため対象は開発用DBイメージのみ |
| SEC-10.5-9 | 本番/検証/開発の環境分離 | 部分 | 環境ごとの接続先を環境変数で分離（`DATABASE_URL` / `APP_DATABASE_URL` / `DATABASE_URL_UNPOOLED`）。開発DBは `docker-compose.yml`（localhost:5433）、E2Eは専用ポート3100（`playwright.config.ts`） | [docs/OPERATIONS.md](OPERATIONS.md) §1 の環境一覧と実際のVercel/Neonプロジェクト設定を突合 | 分離は設定・運用ルールで担保（技術的強制ではない）。検証環境の実体整備状況はインフラ側 |
| SEC-10.5-10 | 開発環境で本番データを使わない（使う場合はマスキング） | 部分 | シードは架空のデモデータのみ（`prisma/seed.ts`。④ダミー表示用データも `isDummy=true` で分離）/ ルールは [docs/OPERATIONS.md](OPERATIONS.md) §1「開発・検証で本番データを使わない（必須ルール）」 | 文書レビュー + 開発DBの内容確認（実在の個人情報が無いこと） | 技術的な持ち出し防止（本番DBダンプの禁止・マスキングツール）は未実装＝運用ルールでの担保 |

## §10.6 インフラ側要件

| 項目 | 要求内容 | 実装状況 | 実装箇所 | 検証方法 | 備考 |
|---|---|---|---|---|---|
| SEC-10.6-* | WAF/CDN/DDoS、脅威検知、バックアップ（RPO≤24h・3-2-1）、リストア試験・RTO、第三者脆弱性診断、パッチSLA、マルウェア対策、CISハードニング、KMS鍵管理、インシデント初報SLA・法定報告 | インフラ側 | 該当なし（アプリ実装外） | [docs/OPERATIONS.md](OPERATIONS.md) §4「インフラ側の前提条件」の表（#1〜#14）で担当・状況を管理 | **§10.6 は OPERATIONS.md 参照**。本書では重複記載しない。リリース条件に関わる未達（#5 第三者診断・#12 東京リージョン）は同表に明記済み |

---

## 突合せサマリ（2026-08-05 時点）

全53項目（§10.1=16 / §10.2=5 / §10.3=13 / §10.4=8 / §10.5=10 / §10.6=1）。

| 実装状況 | 件数 | 該当項目 |
|---|---|---|
| 実装済み | 34 | SEC-10.1-1,2,3,4,5,7,8,9,10,13 / SEC-10.2-1,2,3,4,5 / SEC-10.3-3,4,6,7,9,13 / SEC-10.4-1,3,4,5,6,7,8 / SEC-10.5-2,3,4,5,6,7 |
| 部分 | 11 | SEC-10.1-11,12,14,15 / SEC-10.3-5,11 / SEC-10.4-2 / SEC-10.5-1,8,9,10 |
| 未実装 | 4 | SEC-10.1-6（ポリシー値の設定変更）/ SEC-10.1-16（設定変更の監査）/ SEC-10.3-10（テナント一括削除）/ SEC-10.3-12（削除完了レポート） |
| インフラ側 | 4 | SEC-10.3-1（TLS/HSTS）/ SEC-10.3-2（保存時暗号化）/ SEC-10.3-8（国内リージョン）/ SEC-10.6-*（§10.6一式） |

### リリース前に判断が必要な未達（発注元確認事項）

1. **SEC-10.3-12 削除完了レポート**（SEC要件②#31）と **SEC-10.3-10 テナント単位一括削除** — 解約時の削除証明に直結する。
2. **SEC-10.1-11** 一部のCSV Route Handler が初回パスワード変更を強制していない（`reports/csv`・`hotline/csv`・`consumer-center/csv`）。
3. **SEC-10.1-14 ベンダー区分**・**SEC-10.3-5 ペッパーのバージョンID** — スキーマ列（`Account.isVendor` / `Account.pepperVersion`）はあるがアプリ未使用。
4. **SEC-10.1-6 / SEC-10.1-15** ポリシー値・IP許可リストの設定テーブル化（`AppSetting` 未使用。現状は再デプロイが必要）。
5. **SEC-10.3-8 国内リージョン**・**§10.6 #5 第三者脆弱性診断** — [docs/OPERATIONS.md](OPERATIONS.md) §4 記載のリリース条件。
