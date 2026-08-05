import "server-only";
import { headers } from "next/headers";
import { prisma } from "./prisma";
import { UNKNOWN_IP, trustedIpFrom } from "./client-ip";
import { audit } from "./util";

// アプリ設定（§10.1「管理系画面へのIP許可リスト制御を設定可能にする（環境変数/設定テーブル。
// 設定変更自体も監査ログ対象）」/ §3.3 監査対象イベント「設定変更」）。
//
// 値の優先順位は **DB（AppSetting） → 環境変数 → コード既定値**。
// 環境変数だけでは再デプロイなしに変更できないため、DBを最優先の情報源とし、
// 未投入時は従来どおり環境変数へフォールバックする（既存環境と互換）。
//
// 変更は必ず setSetting() 経由で行い、監査ログ（AuditLog: action=setting_change、
// target に変更前後の値）と状態履歴（StatusHistory: entityType=app_setting）へ記録する。

export const ADMIN_IP_ALLOWLIST_KEY = "admin_ip_allowlist";

export type SettingKey = typeof ADMIN_IP_ALLOWLIST_KEY;

export type SettingSource = "db" | "env" | "default";

export type SettingDefinition = {
  key: SettingKey;
  /** 管理画面に出す表示名（§10.1 の用語に合わせる） */
  label: string;
  /** 入力欄の説明文 */
  description: string;
  /** フォールバック元の環境変数名（§10.1「環境変数/設定テーブル」） */
  envVar?: string;
  /** DB・環境変数の双方が無い場合の既定値 */
  defaultValue: string;
  /** 保存前の正規化（前後空白・区切りの揺れを吸収する） */
  normalize: (raw: string) => string;
  /** 妥当性検証。エラーメッセージ（画面表示用）または null */
  validate: (value: string) => string | null;
};

// IPv4（ドット4組）。許可リストの照合は完全一致（src/lib/auth.ts の isAdminIpAllowed）なので、
// CIDR表記は「設定しても一致しない」設定ミスになる。保存時に明示的に弾く。
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// IPv6（簡易形式チェック。16進とコロンのみ・コロンを含む）
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isIpAddress(value: string): boolean {
  if (IPV4_RE.test(value)) return true;
  return value.includes(":") && IPV6_RE.test(value);
}

/** カンマ区切りリストの正規化（空要素を除去し `a,b,c` 形式に揃える） */
export function normalizeCsvList(raw: string): string {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

export function validateIpAllowlist(value: string): string | null {
  if (value === "") return null; // 空 = 許可リスト無効（従来の環境変数未設定と同じ挙動）
  const entries = value.split(",");
  for (const entry of entries) {
    if (entry.includes("/")) {
      return `CIDR表記（${entry}）は未対応です。IPアドレスをカンマ区切りで指定してください`;
    }
    if (!isIpAddress(entry)) {
      return `IPアドレスの形式が不正です: ${entry}`;
    }
  }
  if (new Set(entries).size !== entries.length) return "同じIPアドレスが重複しています";
  return null;
}

export const SETTING_DEFINITIONS: Record<SettingKey, SettingDefinition> = {
  [ADMIN_IP_ALLOWLIST_KEY]: {
    key: ADMIN_IP_ALLOWLIST_KEY,
    label: "管理系画面のIP許可リスト",
    description:
      "管理系画面（管理画面・管理系CSV）へアクセスできるIPアドレスをカンマ区切りで指定します。空欄にすると許可リストによる制御は無効になります。",
    envVar: "ADMIN_IP_ALLOWLIST",
    defaultValue: "",
    normalize: normalizeCsvList,
    validate: validateIpAllowlist,
  },
};

export type SettingValue = {
  value: string;
  source: SettingSource;
  updatedBy: string | null;
  // 設定テーブルの読み出しに失敗したか（true のとき value は「未設定」と区別できない）。
  // 防御機構（IP許可リスト）の判定側は、この場合に許可へ倒さない（fail-closed）ために使う。
  dbUnavailable?: boolean;
};

/**
 * 設定値を DB → 環境変数 → 既定値 の順で解決する（§10.1）。
 * DBアクセスに失敗した場合も環境変数へフォールバックし、業務を止めない（fail-open は
 * 「設定の読み出し」に限る。IP許可リストの判定自体は値が不定なら fail-closed 側で拒否する）。
 */
export async function getSettingWithSource(key: SettingKey): Promise<SettingValue> {
  const def = SETTING_DEFINITIONS[key];
  let dbUnavailable = false;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    if (row) return { value: row.value, source: "db", updatedBy: row.updatedBy ?? null };
  } catch {
    // 設定テーブル未マイグレーション・接続断等。環境変数へフォールバックするが、
    // 「DBに設定が無い」のか「読めなかった」のか区別できないことを呼び出し側へ伝える。
    dbUnavailable = true;
  }
  const env = def.envVar ? process.env[def.envVar] : undefined;
  if (env !== undefined && env !== "") {
    return { value: env, source: "env", updatedBy: null, dbUnavailable };
  }
  return { value: def.defaultValue, source: "default", updatedBy: null, dbUnavailable };
}

/** 設定値（DB → 環境変数 → 既定値）。 */
export async function getSetting(key: SettingKey): Promise<string> {
  return (await getSettingWithSource(key)).value;
}

export type SetSettingResult =
  { ok: true; before: string; after: string; warning?: string } | { ok: false; error: string };

/**
 * 設定を変更し、監査ログ（§3.3「設定変更」）と状態履歴に記録する。
 * 認可（①②のみ = §5.1 Airisアカウントの「変」）は呼び出し側（server action）で
 * can() により判定すること。本関数は記録と検証に責任を持つ。
 */
export async function setSetting(
  key: SettingKey,
  rawValue: string,
  actor: { loginId: string; isVendor?: boolean },
  reason: string
): Promise<SetSettingResult> {
  const def = SETTING_DEFINITIONS[key];
  const after = def.normalize(rawValue);
  const invalid = def.validate(after);
  if (invalid) return { ok: false, error: invalid };

  const current = await getSettingWithSource(key);
  const before = current.value;

  // 自分自身をロックアウトする設定変更の防止（§10.1 の許可リストは完全一致判定）。
  // 接続元IPが決定できない環境（TRUST_PROXY未設定のローカル等）では判定できないため警告のみ。
  let warning: string | undefined;
  if (key === ADMIN_IP_ALLOWLIST_KEY && after !== "") {
    const ip = await currentTrustedIp();
    if (ip === UNKNOWN_IP) {
      warning =
        "接続元IPを判定できない環境です。許可リストを有効にすると管理系画面へアクセスできなくなる可能性があります。";
    } else if (!after.split(",").includes(ip)) {
      return {
        ok: false,
        error: `現在の接続元IP（${ip}）が許可リストに含まれていません。自分自身が管理画面へ入れなくなるため保存しませんでした`,
      };
    }
  }

  try {
    await prisma.appSetting.upsert({
      where: { key },
      create: { key, value: after, updatedBy: actor.loginId },
      update: { value: after, updatedBy: actor.loginId },
    });
  } catch {
    // 設定テーブル未作成（マイグレーション未適用）の環境では保存できない。
    // 監査ログに残らない「変更したつもり」を防ぐため、ここで明示的に失敗させる。
    await audit(actor.loginId, "setting_change", `key=${key}`, "failure");
    return {
      ok: false,
      error: "設定を保存できませんでした（設定テーブルのマイグレーション適用が必要です）",
    };
  }

  // §3.3「設定変更」を監査ログへ。変更前後の値を target に含める。
  // ベンダー（サスラボ社保守）操作は vendor=true で区別できるようにする（§10.1 / SEC要件①）。
  await audit(
    actor.loginId,
    "setting_change",
    `key=${key} before=${before || "(未設定)"} after=${after || "(未設定)"}${
      actor.isVendor ? " vendor=true" : ""
    } reason=${reason.replace(/=/g, "＝")}`
  );
  // 変更の追跡元（§4.1 の履歴テーブルを設定変更にも使う）
  try {
    await prisma.statusHistory.create({
      data: {
        entityType: "app_setting",
        entityId: key,
        event: "update",
        fromStatus: before,
        toStatus: after,
        reason,
        changedBy: actor.loginId,
      },
    });
  } catch {
    // 履歴記録の失敗で設定変更を巻き戻さない（監査ログ側に記録済み）
  }

  return { ok: true, before, after, warning };
}

async function currentTrustedIp(): Promise<string> {
  try {
    return trustedIpFrom(await headers());
  } catch {
    return UNKNOWN_IP;
  }
}

/**
 * 管理系画面のIP許可リスト（DBの値があればそれを返し、無ければ環境変数）。
 * ※ src/lib/auth.ts の isAdminIpAllowed() は環境変数のみを見る実装のままなので、
 *   参照の差し替え（auth.ts → 本関数）は統合担当が行う。
 */
export async function getAdminIpAllowlist(): Promise<string | undefined> {
  const { value } = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
  return value === "" ? undefined : value;
}

/**
 * 設定テーブル対応版の IP許可リスト判定（src/lib/auth.ts の isAdminIpAllowed() と同じ契約）。
 * - 許可リストが未設定（DB・環境変数ともに空）なら制御無効で allowed=true
 * - 信頼できる接続元IPが決定できない場合は拒否（fail-closed）
 * auth.ts を変更せずに管理系エンドポイントへ適用できるようにするための入口。
 */
export async function isAdminIpAllowedFromSettings(): Promise<{ allowed: boolean; ip: string }> {
  const setting = await getSettingWithSource(ADMIN_IP_ALLOWLIST_KEY);
  const list = setting.value === "" ? undefined : setting.value;
  if (!list) {
    // 設定テーブルが読めなかった場合、「未設定（制御無効）」なのか「設定済みだが読めない」のかを
    // 区別できない。防御機構を黙って無効化しないため **拒否** に倒す（fail-closed）。
    // 環境変数に許可リストがある場合は上の list に入るのでここには来ない。
    if (setting.dbUnavailable) {
      return { allowed: false, ip: "-" };
    }
    return { allowed: true, ip: "-" };
  }
  const ip = await currentTrustedIp();
  if (ip === UNKNOWN_IP) return { allowed: false, ip };
  return { allowed: list.split(",").includes(ip), ip };
}
