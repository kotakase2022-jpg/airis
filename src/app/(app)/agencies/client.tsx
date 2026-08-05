"use client";

import { ReactNode, useActionState, useState } from "react";
import { btnDanger, btnOutline, btnPrimary, inputCls, labelCls } from "@/components/ui";
import {
  AgencyActionState,
  createAgencyAction,
  deleteAgencyAction,
  updateAgencyAction,
} from "./actions";
import { AGENCY_STATUS_LABELS } from "./labels";

const initialState: AgencyActionState = {};

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-bold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="閉じる"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ＋ 下位代理店を追加（1次代理店の追加も可 §7.11-6）
export function AddAgencyButton({
  primaries,
  defaultJoinedAt,
}: {
  primaries: { id: string; code: string; name: string }[];
  defaultJoinedAt: string;
}) {
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState("2");
  const [state, formAction, pending] = useActionState(createAgencyAction, initialState);

  // 送信成功時にモーダルを閉じる（レンダー中の状態調整パターン）
  const [closedForState, setClosedForState] = useState<unknown>(null);
  if (state.ok && closedForState !== state) {
    setClosedForState(state);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className={btnPrimary} onClick={() => setOpen(true)}>
        ＋ 下位代理店を追加
      </button>
      {open && (
        <Modal title="代理店を追加" onClose={() => setOpen(false)}>
          <form action={formAction} className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>階層</label>
                <select
                  name="tier"
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  className={inputCls}
                >
                  <option value="2">2次代理店</option>
                  <option value="1">1次代理店</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>
                  管轄1次代理店{tier === "2" ? "（必須）" : "（1次店は不要）"}
                </label>
                <select
                  name="parentId"
                  className={inputCls}
                  disabled={tier === "1"}
                  required={tier === "2"}
                  defaultValue=""
                >
                  <option value="">選択してください</option>
                  {primaries.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}（{p.code}）
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelCls}>代理店コード（6桁）</label>
                <input
                  name="code"
                  className={inputCls}
                  required
                  pattern="\d{6}"
                  maxLength={6}
                  title="6桁の数字で入力してください"
                  placeholder="例: 210001"
                />
              </div>
              <div>
                <label className={labelCls}>代理店名</label>
                <input name="name" className={inputCls} required placeholder="例: 株式会社◯◯" />
              </div>
              <div>
                <label className={labelCls}>代表者</label>
                <input name="representative" className={inputCls} placeholder="例: 山田 太郎" />
              </div>
              <div>
                <label className={labelCls}>参加日</label>
                <input
                  type="date"
                  name="joinedAt"
                  className={inputCls}
                  defaultValue={defaultJoinedAt}
                />
              </div>
            </div>
            {state.error && <p className="text-sm text-red-600">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
                キャンセル
              </button>
              <button className={btnPrimary} disabled={pending}>
                {pending ? "登録中..." : "登録する"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// 編集（名称・代表者・ステータス）
export function EditAgencyButton({
  agency,
}: {
  agency: {
    id: string;
    code: string;
    name: string;
    representative: string | null;
    status: string;
    tier: number;
  };
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(updateAgencyAction, initialState);

  // 送信成功時にモーダルを閉じる（レンダー中の状態調整パターン）
  const [closedForState, setClosedForState] = useState<unknown>(null);
  if (state.ok && closedForState !== state) {
    setClosedForState(state);
    setOpen(false);
  }

  return (
    <>
      <button type="button" className={btnOutline} onClick={() => setOpen(true)}>
        編集
      </button>
      {open && (
        <Modal
          title={`代理店を編集（${agency.code}・${agency.tier === 1 ? "1次" : "2次"}）`}
          onClose={() => setOpen(false)}
        >
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="id" value={agency.id} />
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>代理店名</label>
                <input name="name" className={inputCls} required defaultValue={agency.name} />
              </div>
              <div>
                <label className={labelCls}>代表者</label>
                <input
                  name="representative"
                  className={inputCls}
                  defaultValue={agency.representative ?? ""}
                />
              </div>
              <div>
                <label className={labelCls}>ステータス</label>
                <select name="status" className={inputCls} defaultValue={agency.status}>
                  <option value="active">{AGENCY_STATUS_LABELS.active}</option>
                  <option value="closed">{AGENCY_STATUS_LABELS.closed}</option>
                </select>
              </div>
            </div>
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              注記:
              ステータスを「稼働終了」にすると、当該店の代理店管理者アカウント（⑦⑧）は実効ロール⑩（稼働終了代理店）となり、窓口案件のみ利用可能になります。
            </p>
            {state.error && <p className="text-sm text-red-600">{state.error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
                キャンセル
              </button>
              <button className={btnPrimary} disabled={pending}>
                {pending ? "保存中..." : "保存する"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

// 削除（配下にアカウント・販売員があれば server 側で拒否 → エラーメッセージをインライン表示）
export function DeleteAgencyForm({ id, name }: { id: string; name: string }) {
  const [state, formAction, pending] = useActionState(deleteAgencyAction, initialState);
  return (
    <div>
      <form
        action={formAction}
        onSubmit={(e) => {
          if (!confirm(`代理店「${name}」を削除します。よろしいですか？`)) e.preventDefault();
        }}
      >
        <input type="hidden" name="id" value={id} />
        <button className={btnDanger} disabled={pending}>
          {pending ? "削除中..." : "削除"}
        </button>
      </form>
      {state.error && <p className="mt-1 max-w-52 text-xs text-red-600">{state.error}</p>}
    </div>
  );
}
