"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  createSession,
  destroySession,
  effectiveRole,
  getCurrentUser,
  hashPassword,
  trustedIpFrom,
  verifyPassword,
} from "@/lib/auth";
import { ADMIN_PW_ROLES, Role } from "@/lib/roles";
import { audit } from "@/lib/util";

const PW_HISTORY_GENERATIONS = 24; // §4.2 再利用禁止: 過去24世代

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

// パスワード有効期間（§4.2: ①②③⑦=90日 / その他=180日）
// 判定は実効ロール（稼働終了代理店の⑦⑧は⑩＝一般ポリシー）で行う。
function passwordMaxAgeDays(role: string): number {
  return ADMIN_PW_ROLES.includes(role as Role) ? 90 : 180;
}

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

  const account = await prisma.account.findUnique({ where: { loginId }, include: { agency: true } });
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

  const check = verifyPassword(password, account.passwordHash);
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

  // パスワード有効期限（§4.2）: 期限超過なら強制変更フラグを立てて/passwordへ誘導。
  // 実効ロールで判定する（稼働終了代理店の⑦⑧=⑩は一般ポリシー180日）。
  const role = effectiveRole(account.role, account.agency?.status);
  const maxAgeMs = passwordMaxAgeDays(role) * 24 * 3600 * 1000;
  const expired = Date.now() - account.passwordUpdatedAt.getTime() > maxAgeMs;
  const mustChangePassword = account.mustChangePassword || expired;

  // アクセスログ（§3.3 / 要件1-6）はセッション発行より前に記録する。
  // 記録できない場合はレート制限・ロック判定の情報源が欠落するため、ログインを許可しない
  // （fail-closed。監査ログ側の失敗は業務を止めない設計なので、こちらで担保する）。
  const logged = await recordAccess({
    loginId,
    accountId: account.id,
    result: "success",
    ip,
    ua,
  });
  if (!logged) return { error: ACCESS_LOG_ERROR };

  await prisma.account.update({
    where: { id: account.id },
    data: {
      failedAttempts: 0,
      lockedUntil: null,
      // 旧アルゴリズム（bcrypt）・ペッパー未適用の旧ハッシュは成功時に
      // Argon2id + 現行ペッパーで再ハッシュ（§10.3 / SEC②#42）。
      // passwordUpdatedAt は据え置く（有効期限の起点を変えない）。
      ...(check.needsRehash ? { passwordHash: hashPassword(password) } : {}),
      ...(expired ? { mustChangePassword: true } : {}),
    },
  });
  await createSession(account.id);
  await audit(loginId, "login", undefined, "success", ip);
  if (check.needsRehash) await audit(loginId, "password_rehash", "algorithm=argon2id pepper_version=v1");
  redirect(mustChangePassword ? "/password" : "/dashboard");
}

export async function changePasswordAction(_prev: { error?: string } | undefined, formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const account = await prisma.account.findUnique({ where: { id: user.id } });
  if (!account || !verifyPassword(current, account.passwordHash).ok) {
    return { error: "現在のパスワードが正しくありません" };
  }
  if (next !== confirm) return { error: "新しいパスワードが一致しません" };
  // 桁数は実効ロールで判定（§4.2）。稼働終了代理店（⑦⑧→⑩）は一般ポリシー14桁。
  const minLen = ADMIN_PW_ROLES.includes(user.role as Role) ? 20 : 14;
  if (next.length < minLen) return { error: `パスワードは${minLen}桁以上にしてください` };
  if (!/[A-Z]/.test(next) || !/[a-z]/.test(next) || !/[0-9]/.test(next)) {
    return { error: "大文字・小文字・数字をそれぞれ含めてください" };
  }

  // 再利用禁止（§4.2: 過去24世代）: 現在のパスワード + PasswordHistory（直近24世代）と照合
  const history = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PW_HISTORY_GENERATIONS,
  });
  if (
    verifyPassword(next, account.passwordHash).ok ||
    history.some((h) => verifyPassword(next, h.hash).ok)
  ) {
    return { error: "過去24世代と同じパスワードは使用できません" };
  }

  // 旧パスワードを履歴へ保存してから更新（24世代を超える古い履歴は削除）
  await prisma.passwordHistory.create({
    data: { accountId: user.id, hash: account.passwordHash },
  });
  await prisma.account.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(next), mustChangePassword: false, passwordUpdatedAt: new Date() },
  });
  const excess = await prisma.passwordHistory.findMany({
    where: { accountId: user.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: PW_HISTORY_GENERATIONS,
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
