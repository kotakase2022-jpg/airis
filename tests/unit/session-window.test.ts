// セッションの失効ウィンドウ（§10.2 / SEC②#13 / T-008）
// 「絶対期限 ≤24時間、アイドル ≤60分」はリリース条件のため、設定で**短縮のみ**できることを検証する。
// 実際のブラウザ経由の失効は e2e/24-session-expiry.spec.ts で検証する。
import { describe, expect, it } from "vitest";
import {
  SESSION_ABSOLUTE_HOURS_MAX,
  SESSION_IDLE_MINUTES_MAX,
  sessionAbsoluteHours,
  sessionExpiryReason,
  sessionIdleMinutes,
} from "@/lib/session-window";

describe("設定値（§10.2 の上限）", () => {
  it("既定は絶対24時間 / アイドル60分", () => {
    expect(SESSION_ABSOLUTE_HOURS_MAX).toBe(24);
    expect(SESSION_IDLE_MINUTES_MAX).toBe(60);
    expect(sessionAbsoluteHours({})).toBe(24);
    expect(sessionIdleMinutes({})).toBe(60);
  });

  it("短縮する設定は反映される", () => {
    expect(sessionAbsoluteHours({ SESSION_ABSOLUTE_HOURS: "8" })).toBe(8);
    expect(sessionIdleMinutes({ SESSION_IDLE_MINUTES: "15" })).toBe(15);
  });

  it("上限を超える設定は仕様の上限へ丸める（要件違反の設定を許さない）", () => {
    expect(sessionAbsoluteHours({ SESSION_ABSOLUTE_HOURS: "48" })).toBe(24);
    expect(sessionIdleMinutes({ SESSION_IDLE_MINUTES: "120" })).toBe(60);
  });

  it("不正値（空・0・負数・非数値）は上限（既定）へフォールバックする", () => {
    for (const bad of ["", " ", "0", "-5", "abc"]) {
      expect(sessionAbsoluteHours({ SESSION_ABSOLUTE_HOURS: bad })).toBe(24);
      expect(sessionIdleMinutes({ SESSION_IDLE_MINUTES: bad })).toBe(60);
    }
  });
});

describe("失効理由の判定", () => {
  const now = new Date("2026-08-05T12:00:00+09:00");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const ahead = (ms: number) => new Date(now.getTime() + ms);
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  it("有効なセッションは null", () => {
    expect(
      sessionExpiryReason(
        { createdAt: ago(2 * HOUR), lastSeenAt: ago(30 * MIN), expiresAt: ahead(22 * HOUR) },
        now,
        {}
      )
    ).toBeNull();
  });

  it("expiresAt 到達で absolute", () => {
    expect(
      sessionExpiryReason(
        { createdAt: ago(25 * HOUR), lastSeenAt: now, expiresAt: ago(1 * HOUR) },
        now,
        {}
      )
    ).toBe("absolute");
  });

  it("createdAt から24時間を超えていれば expiresAt が未来でも absolute（多層防御）", () => {
    expect(
      sessionExpiryReason(
        { createdAt: ago(25 * HOUR), lastSeenAt: now, expiresAt: ahead(1 * HOUR) },
        now,
        {}
      )
    ).toBe("absolute");
  });

  it("lastSeenAt から60分を超えていれば idle", () => {
    expect(
      sessionExpiryReason(
        { createdAt: ago(2 * HOUR), lastSeenAt: ago(61 * MIN), expiresAt: ahead(22 * HOUR) },
        now,
        {}
      )
    ).toBe("idle");
    // ちょうど60分は未超過
    expect(
      sessionExpiryReason(
        { createdAt: ago(2 * HOUR), lastSeenAt: ago(60 * MIN), expiresAt: ahead(22 * HOUR) },
        now,
        {}
      )
    ).toBeNull();
  });

  it("絶対期限とアイドルの両方が超過していれば absolute を優先して返す", () => {
    expect(
      sessionExpiryReason(
        { createdAt: ago(30 * HOUR), lastSeenAt: ago(2 * HOUR), expiresAt: ago(6 * HOUR) },
        now,
        {}
      )
    ).toBe("absolute");
  });

  it("短縮設定でも判定される", () => {
    const session = {
      createdAt: ago(9 * HOUR),
      lastSeenAt: ago(20 * MIN),
      expiresAt: ahead(15 * HOUR),
    };
    expect(sessionExpiryReason(session, now, {})).toBeNull();
    expect(sessionExpiryReason(session, now, { SESSION_ABSOLUTE_HOURS: "8" })).toBe("absolute");
    expect(sessionExpiryReason(session, now, { SESSION_IDLE_MINUTES: "15" })).toBe("idle");
  });
});
