"use client";

// お知らせ配信一覧の行内操作（送信・停止・削除）クライアントコンポーネント。
// server action の結果状態を useActionState で受け取り、権限不足・状態不整合・DB例外を
// その場でユーザーへ提示する（§3.2「APIでは403を返し監査ログに記録」＋UIでの可視化）。

import { useActionState } from "react";
import { btnDanger, btnOutline, btnPrimary } from "@/components/ui";
import {
  deleteAnnouncementAction,
  sendAnnouncementAction,
  stopAnnouncementAction,
  type AnnouncementRowState,
} from "./actions";

// 複数操作のうち最後に実行されたものの結果だけを表示する（ts の大小で判定）
function latestState(states: AnnouncementRowState[]): AnnouncementRowState {
  let latest: AnnouncementRowState;
  for (const s of states) {
    if (!s) continue;
    if (!latest || (s.ts ?? 0) >= (latest.ts ?? 0)) latest = s;
  }
  return latest;
}

export function AnnouncementRowActions({ id, status }: { id: string; status: string }) {
  const [sendState, sendAction, sendPending] = useActionState(sendAnnouncementAction, undefined);
  const [stopState, stopAction, stopPending] = useActionState(stopAnnouncementAction, undefined);
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteAnnouncementAction,
    undefined
  );
  const latest = latestState([sendState, stopState, deleteState]);

  return (
    <div className="flex flex-wrap items-start gap-2">
      {status === "draft" && (
        <form action={sendAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" disabled={sendPending} className={btnPrimary}>
            {sendPending ? "送信中..." : "送信"}
          </button>
        </form>
      )}
      {status === "sent" && (
        <form action={stopAction}>
          <input type="hidden" name="id" value={id} />
          <button type="submit" disabled={stopPending} className={btnOutline}>
            {stopPending ? "処理中..." : "停止"}
          </button>
        </form>
      )}
      <form action={deleteAction}>
        <input type="hidden" name="id" value={id} />
        <button type="submit" disabled={deletePending} className={btnDanger}>
          {deletePending ? "処理中..." : "削除"}
        </button>
      </form>
      {latest?.error && (
        <p
          role="alert"
          data-testid="announcement-row-error"
          className="w-full text-[11px] font-semibold text-red-600"
        >
          {latest.error}
        </p>
      )}
      {latest?.success && (
        <p
          role="status"
          data-testid="announcement-row-success"
          className="w-full text-[11px] text-emerald-600"
        >
          {latest.success}
        </p>
      )}
    </div>
  );
}
