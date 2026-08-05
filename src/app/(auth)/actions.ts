"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  createSession,
  destroySession,
  effectiveRole,
  getCurrentUser,
  getMfaPendingSession,
  hashPasswordWithPepperVersion,
  trustedIpFrom,
  verifyPassword,
  verifyPasswordLenient,
} from "@/lib/auth";
import { MFA_MAX_ATTEMPTS, mfaRequiredForRole, verifyMfaCode } from "@/lib/mfa";
import {
  isPasswordExpired,
  passwordPolicy,
  passwordReuseError,
  validateNewPassword,
} from "@/lib/password-policy";
import { Role } from "@/lib/roles";
import { audit } from "@/lib/util";

// 認証エンドポイントのレート制限（§10.1 / SEC要件②）: 同一IP+同一IDで1分に5回まで
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_FAILURES = 5;
// アカウントロック（§4.2 / SEC②#12）: 30分間に10回失敗 → 30分ロック
const LOCK_WINDOW_MS = 30 * 60 * 1000;
const LOCK_THRESHOLD = 10;
const LOCK_DURATION_MS = 30 * 60 * 1000;

const GENERIC_LOGIN_ERROR = "IDまたはパスワードが正しくありません";
const LOCK_ERROR = "アカウントがロックされています。しばらくしてから再試行してください";
const RATE_LIMIT_ERROR = "試行が多すぎます。しばらくしてからお試しください";
// アクセスログ（=ロック判定・レート制限の情報源）が記録できない場合はログインを拒否する（fail-closed）
const ACCESS_LOG_ERROR = "ログイン処理を完了できませんでした。しばらくしてから再試行してください";

// パスワードポリシー（桁数・有効期間・履歴世代数）は src/lib/password-policy.ts に集約し、
// 環境変数で変更できる（§10.1「ポリシー値は設定で変更可能に」）。既定値は §4.2 の表どおり。

// 直近ウィンドウ内のログイン失敗回数（AccessLog を唯一の情報源として集計 §3.3 / 要件1-6）。
// 監査ログ（AuditLog）は書き込み失敗を業務停止の理由にしない設計（util.audit は例外を飲む）ため、
// ロック判定・レート制限のカウンタは専用の AccessLog テーブルで数える。
// 同一IDでもログイン成功があればそれ以降の失敗のみを数える（成功でカウンタが実質リセットされる）。
// ip を渡した場合は「IP+ID単位」（レート制限用）、省略時は「ID単位」（ロック判定用）。
async function recentLoginFailures(
  loginId: string,
  windowMs: number,
  ip?: string
): Promise<number> {
  const since = new Date(Date.now() - windowMs);
  const lastSuccess = await prisma.accessLog.findFirst({
    where: { loginId, result: "success", createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const from = lastSuccess ? lastSuccess.createdAt : since;
  return prisma.accessLog.count({
    where: {
      loginId,
      result: "failure",
      createdAt: { gte: from },
      ...(ip ? { ip } : {}),
    },
  });
}

// アクセスログ用のIP・User-Agent（§3.3 要件1-6）
// IPは trustedIpFrom（x-vercel-forwarded-for 優先 / x-forwarded-for は末尾hop）で解決する。
async function requestMeta(): Promise<{ ip: string; ua: string }> {
  try {
    const h = await headers();
    return { ip: trustedIpFrom(h), ua: (h.get("user-agent") ?? "").slice(0, 512) };
  } catch {
    return { ip: "local", ua: "" };
  }
}

// アクセスログ記録（§3.3 / 要件1-6: ログイン日時・IP・User-Agent をアカウント単位で記録）。
// 戻り値 false = 記録できなかった。呼び出し側は fail-closed（ログインを拒否）とする。
async function recordAccess(entry: {
  loginId: string;
  accountId?: string | null;
  result: "success" | "failure" | "denied";
  ip: string;
  ua: string;
  reason?: string;
}): Promise<boolean> {
  try {
    await prisma.accessLog.create({
      data: {
        loginId: entry.loginId.slice(0, 255),
        accountId: entry.accountId ?? null,
        result: entry.result,
        ip: entry.ip,
        userAgent: entry.ua,
        reason: entry.reason ?? null,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function loginAction(_prev: { error?: string } | undefined, formData: FormData) {
  const loginId = String(formData.get("loginId") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!loginId || !password) return { error: "IDとパスワードを入力してください" };

  const { ip, ua } = await requestMeta();

  // ① レート制限（§10.1）: 同一IP+同一IDで直近1分の失敗が上限に達していれば
  //    パスワード検証もアカウント探索も行わずに拒否する（総当たり・ユーザー列挙の抑止）。
  //    拒否自体もアクセスログ・監査対象（result=denied なので失敗カウントには算入しない）。
  const rateFailures = await recentLoginFailures(loginId, RATE_WINDOW_MS, ip);
  if (rateFailures >= RATE_MAX_FAILURES) {
    await recordAccess({ loginId, result: "denied", ip, ua, reason: "rate_limit" });
    await audit(loginId, "login", "blocked=rate_limit", "denied", ip);
    return { error: RATE_LIMIT_ERROR };
  }

  const account = await prisma.account.findUnique({
    where: { loginId },
    include: { agency: true },
  });
  if (!account || account.status === "deleted" || account.status === "suspended") {
    const logged = await recordAccess({
      loginId,
      accountId: account?.id,
      result: "failure",
      ip,
      ua,
      reason: account ? `account_${account.status}` : "unknown_account",
    });
    await audit(loginId, "login", undefined, "failure", ip);
    return { error: logged ? GENERIC_LOGIN_ERROR : ACCESS_LOG_ERROR };
  }

  // ② ロック期限の満了処理（§4.2）: 満了していれば失敗カウンタも0へ戻す
  let lockedUntil = account.lockedUntil;
  if (lockedUntil && lockedUntil <= new Date()) {
    await prisma.account.update({
      where: { id: account.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    lockedUntil = null;
  }
  if (lockedUntil && lockedUntil > new Date()) {
    await recordAccess({
      loginId,
      accountId: account.id,
      result: "denied",
      ip,
      ua,
      reason: "locked",
    });
    await audit(loginId, "login", "blocked=locked", "denied", ip);
    return { error: LOCK_ERROR };
  }

  // 入力ゆらぎ（前後空白・全角英数・引用符の巻き込み）を吸収して照合する。
  // 一致した候補（check.matched）は再ハッシュの入力に使う。
  // 照合は account.pepperVersion のペッパーを最優先で試す（§10.3 / SEC②#42。pepper.ts）。
  const check = verifyPasswordLenient(password, account.passwordHash, account.pepperVersion);
  if (!check.ok) {
    const logged = await recordAccess({
      loginId,
      accountId: account.id,
      result: "failure",
      ip,
      ua,
      reason: "bad_password",
    });
    await audit(loginId, "login", undefined, "failure", ip);
    // ③ ロック判定（§4.2 / SEC②#12）: 30分のスライディングウィンドウで失敗回数を集計する。
    //    failedAttempts は「単調増加カウンタ」ではなくウィンドウ内の集計値で置き換えるため、
    //    古い失敗（30分より前）は自然に失効する。
    const windowFailures = await recentLoginFailures(loginId, LOCK_WINDOW_MS);
    await prisma.account.update({
      where: { id: account.id },
      data: {
        failedAttempts: windowFailures,
        lockedUntil:
          windowFailures >= LOCK_THRESHOLD ? new Date(Date.now() + LOCK_DURATION_MS) : null,
      },
    });
    return { error: logged ? GENERIC_LOGIN_ERROR : ACCESS_LOG_ERROR };
  }

  // 旧アルゴリズム（bcrypt）・旧バージョン／未適用のペッパーだったハッシュは、パスワード検証を
  // 通過した時点で Argon2id + 現行バージョンのペッパーへ再ハッシュし、適用済みバージョンIDを
  // Account.pepperVersion に記録する（§10.3 / SEC②#42。ペッパーの無停止ローテーション）。
  // passwordUpdatedAt は据え置く（パスワード自体は変わっていないため有効期限は延びない）。
  if (check.needsRehash) {
    const rehashed = hashPasswordWithPepperVersion(check.matched);
    await prisma.account.update({
      where: { id: account.id },
      data: { passwordHash: rehashed.hash, pepperVersion: rehashed.pepperVersion },
    });
    await audit(
      loginId,
      "password_rehash",
      `algorithm=argon2id pepper_version=${rehashed.pepperVersion ?? "none"}`
    );
  } else if ((account.pepperVersion ?? null) !== check.pepperVersion) {
    // ハッシュは現行方式のまま。記録されているバージョンIDだけが実態とずれている場合
    // （ペッパー導入前に作られた行など）は、再ハッシュせずメタデータのみ補正する。
    await prisma.account.update({
      where: { id: account.id },
      data: { pepperVersion: check.pepperVersion },
    });
  }

  // ===== MFA（TOTP §4.2）=====
  // 登録済みアカウントはコード検証（/mfa）へ、未登録でも必須ロール（⑨以外）は登録（/mfa/setup）へ。
  // この時点ではログイン完了ではない: 成功ログ・失敗カウンタのリセットはMFA完了時（finalizeLogin）に行い、
  // それまでのセッションは mfaPending=true（アプリ全体では未ログイン扱い・fail-closed）。
  if (account.mfaEnabled || mfaRequiredForRole(account.role as Role)) {
    const logged = await recordAccess({
      loginId,
      accountId: account.id,
      result: "denied",
      ip,
      ua,
      reason: "mfa_pending",
    });
    if (!logged) return { error: ACCESS_LOG_ERROR };
    await createSession(account.id, { mfaPending: true });
    redirect(account.mfaEnabled ? "/mfa" : "/mfa/setup");
  }

  // ⑨（販売員）でMFA未登録の場合のみ、パスワードのみでログイン完了（§4.2 利用任意）
  const fin = await finalizeLogin(account, ip, ua);
  if (!fin.ok) return { error: ACCESS_LOG_ERROR };
  await createSession(account.id);
  redirect(fin.mustChange ? "/password" : "/dashboard");
}

// ログイン完了処理（パスワードのみで完了する⑨と、MFA完了時の共通処理）。
// アクセスログ（§3.3 / 要件1-6）はセッション有効化より前に記録する。
// 記録できない場合はレート制限・ロック判定の情報源が欠落するため、ログインを許可しない（fail-closed）。
async function finalizeLogin(
  account: {
    id: string;
    loginId: string;
    role: string;
    mustChangePassword: boolean;
    passwordUpdatedAt: Date;
    agency: { status: string } | null;
  },
  ip: string,
  ua: string
): Promise<{ ok: boolean; mustChange: boolean }> {
  // パスワード有効期限（§4.2）: 期限超過なら強制変更フラグを立てて/passwordへ誘導。
  // 実効ロールで判定する（稼働終了代理店の⑦⑧=⑩は一般ポリシー180日）。
  const role = effectiveRole(account.role as Role, account.agency?.status);
  const expired = isPasswordExpired(account.passwordUpdatedAt, role, new Date());
  const logged = await recordAccess({
    loginId: account.loginId,
    accountId: account.id,
    result: "success",
    ip,
    ua,
  });
  if (!logged) return { ok: false, mustChange: false };
  await prisma.account.update({
    where: { id: account.id },
    data: {
      failedAttempts: 0,
      lockedUntil: null,
      ...(expired ? { mustChangePassword: true } : {}),
    },
  });
  await audit(account.loginId, "login", undefined, "success", ip);
  return { ok: true, mustChange: account.mustChangePassword || expired };
}

// ===== MFAコード検証（登録済みアカウントのログイン時 §4.2）=====
export async function verifyMfaAction(_prev: { error?: string } | undefined, formData: FormData) {
  const pending = await getMfaPendingSession();
  if (!pending) redirect("/login");
  const acc = pending.account;
  if (!acc.mfaEnabled || !acc.mfaSecret) redirect("/mfa/setup");
  const code = String(formData.get("code") ?? "");
  const { ip, ua } = await requestMeta();

  if (!verifyMfaCode(code, acc.mfaSecret)) {
    // TOTP総当たり対策: 失敗はアカウントロック（30分/10回）に算入し、
    // セッション単位でも5回でセッション破棄（ログインからやり直し）。
    await recordAccess({
      loginId: acc.loginId,
      accountId: acc.id,
      result: "failure",
      ip,
      ua,
      reason: "mfa_bad_code",
    });
    await audit(acc.loginId, "login", "mfa_bad_code", "failure", ip);
    const attempts = pending.mfaAttempts + 1;
    if (attempts >= MFA_MAX_ATTEMPTS) {
      await destroySession();
      redirect("/login");
    }
    await prisma.session.update({
      where: { id: pending.sessionId },
      data: { mfaAttempts: attempts },
    });
    return { error: "認証コードが正しくありません" };
  }

  const account = await prisma.account.findUnique({
    where: { id: acc.id },
    include: { agency: true },
  });
  if (!account) redirect("/login");
  const fin = await finalizeLogin(account, ip, ua);
  if (!fin.ok) return { error: ACCESS_LOG_ERROR };
  await prisma.session.update({
    where: { id: pending.sessionId },
    data: { mfaPending: false, mfaAttempts: 0, lastSeenAt: new Date() },
  });
  redirect(fin.mustChange ? "/password" : "/dashboard");
}

// ===== MFA登録（QRコード読み取り後のコード確認 §4.2）=====
// (a) mfaPendingセッション（必須ロールの初回登録）と (b) 通常セッションの任意登録（⑨）の両方に対応。
export async function enrollMfaAction(_prev: { error?: string } | undefined, formData: FormData) {
  const code = String(formData.get("code") ?? "");
  const { ip, ua } = await requestMeta();

  const pending = await getMfaPendingSession();
  if (pending) {
    const acc = pending.account;
    if (acc.mfaEnabled) redirect("/mfa");
    if (!acc.mfaSecret) return { error: "秘密鍵が未発行です。ページを再読み込みしてください" };
    if (!verifyMfaCode(code, acc.mfaSecret)) {
      await recordAccess({
        loginId: acc.loginId,
        accountId: acc.id,
        result: "denied",
        ip,
        ua,
        reason: "mfa_enroll_bad_code",
      });
      const attempts = pending.mfaAttempts + 1;
      if (attempts >= MFA_MAX_ATTEMPTS) {
        await destroySession();
        redirect("/login");
      }
      await prisma.session.update({
        where: { id: pending.sessionId },
        data: { mfaAttempts: attempts },
      });
      return { error: "認証コードが正しくありません。認証アプリの登録をやり直してください" };
    }
    await prisma.account.update({ where: { id: acc.id }, data: { mfaEnabled: true } });
    await audit(acc.loginId, "mfa_enroll", "totp", "success", ip);
    const account = await prisma.account.findUnique({
      where: { id: acc.id },
      include: { agency: true },
    });
    if (!account) redirect("/login");
    const fin = await finalizeLogin(account, ip, ua);
    if (!fin.ok) return { error: ACCESS_LOG_ERROR };
    await prisma.session.update({
      where: { id: pending.sessionId },
      data: { mfaPending: false, mfaAttempts: 0, lastSeenAt: new Date() },
    });
    redirect(fin.mustChange ? "/password" : "/dashboard");
  }

  // 通常セッションからの任意登録（⑨販売員など）
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mfaEnabled) redirect("/dashboard");
  const account = await prisma.account.findUnique({ where: { id: user.id } });
  if (!account?.mfaSecret) return { error: "秘密鍵が未発行です。ページを再読み込みしてください" };
  if (!verifyMfaCode(code, account.mfaSecret)) {
    return { error: "認証コードが正しくありません。認証アプリの登録をやり直してください" };
  }
  await prisma.account.update({ where: { id: user.id }, data: { mfaEnabled: true } });
  await audit(user.loginId, "mfa_enroll", "totp voluntary", "success", ip);
  redirect("/dashboard");
}

export async function changePasswordAction(
  _prev: { error?: string } | undefined,
  formData: FormData
) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const account = await prisma.account.findUnique({ where: { id: user.id } });
  // 現在パスワードの照合はログインと同じゆらぎ吸収を適用する（ログインで通った入力が
  // ここで弾かれる不整合を防ぐ）。新パスワードは入力そのままを尊重する。
  if (!account || !verifyPasswordLenient(current, account.passwordHash, account.pepperVersion).ok) {
    return { error: "現在のパスワードが正しくありません" };
  }
  if (next !== confirm) return { error: "新しいパスワードが一致しません" };
  // 桁数・文字種は実効ロールで判定（§4.2）。稼働終了代理店（⑦⑧→⑩）は一般ポリシー14桁。
  const policy = passwordPolicy();
  const formatError = validateNewPassword(next, user.role, policy);
  if (formatError) return { error: formatError };

  // 再利用禁止（§4.2: 過去24世代）: 現在のパスワード + PasswordHistory（直近24世代）と照合。
  // 履歴のハッシュはバージョン列を持たないため、pepperVersion 指定なしで既知の全バージョンを試す。
  const history = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: policy.historyGenerations,
  });
  if (
    verifyPassword(next, account.passwordHash, account.pepperVersion).ok ||
    history.some((h) => verifyPassword(next, h.hash).ok)
  ) {
    return { error: passwordReuseError(policy) };
  }

  // 旧パスワードを履歴へ保存してから更新（24世代を超える古い履歴は削除）。
  // 新しいハッシュに適用したペッパーのバージョンIDも記録する（SEC②#42）。
  await prisma.passwordHistory.create({
    data: { accountId: user.id, hash: account.passwordHash },
  });
  const hashed = hashPasswordWithPepperVersion(next);
  await prisma.account.update({
    where: { id: user.id },
    data: {
      passwordHash: hashed.hash,
      pepperVersion: hashed.pepperVersion,
      mustChangePassword: false,
      passwordUpdatedAt: new Date(),
    },
  });
  const excess = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: policy.historyGenerations,
    select: { id: true },
  });
  if (excess.length > 0) {
    await prisma.passwordHistory.deleteMany({ where: { id: { in: excess.map((e) => e.id) } } });
  }
  await audit(user.loginId, "password_change");
  redirect("/dashboard");
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) await audit(user.loginId, "logout");
  await destroySession();
  redirect("/login");
}
