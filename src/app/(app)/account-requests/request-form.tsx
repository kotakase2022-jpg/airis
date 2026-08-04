"use client";

import { useActionState, useState } from "react";
import { createRequestAction } from "./actions";
import { Card, inputCls, labelCls, btnPrimary, btnOutline } from "@/components/ui";

export type Option = { value: string; label: string };

export function RequestForm({
  roles,
  tier1,
  tier2,
}: {
  roles: Option[];
  tier1: Option[];
  tier2: Option[];
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(roles[0]?.value ?? "");
  const [state, action, pending] = useActionState(createRequestAction, undefined);

  if (roles.length === 0) return null;

  const needsAgency = role === "R7" || role === "R8" || role === "R10";
  const agencyOptions = role === "R7" ? tier1 : role === "R8" ? tier2 : [...tier1, ...tier2];

  return (
    <div className="mb-5">
      <div className="mb-3 flex justify-end">
        <button type="button" className={btnPrimary} onClick={() => setOpen((v) => !v)}>
          {open ? "× 申請フォームを閉じる" : "＋ アカウント申請"}
        </button>
      </div>
      {open && (
        <Card>
          <h2 className="mb-1 text-base font-bold text-slate-800">アカウント申請</h2>
          <p className="mb-4 text-xs text-slate-500">
            上長承認証跡ファイルの添付が必須です。同じ権限を複数名で利用する場合も、利用者ごとに個別に申請してください。
          </p>
          <form action={action} className="grid grid-cols-3 gap-4">
            <div>
              <label className={labelCls}>申請ロール *</label>
              <select
                name="role"
                className={inputCls}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                required
              >
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>氏名 *</label>
              <input name="name" className={inputCls} required placeholder="例: 山田 太郎" />
            </div>
            <div>
              <label className={labelCls}>メールアドレス *</label>
              <input
                name="email"
                type="email"
                className={inputCls}
                required
                placeholder="例: taro.yamada@example.co.jp"
              />
            </div>
            {needsAgency && (
              <div>
                <label className={labelCls}>所属代理店 *</label>
                <select name="agencyId" className={inputCls} required defaultValue="">
                  <option value="" disabled>
                    選択してください
                  </option>
                  {agencyOptions.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className={needsAgency ? "col-span-2" : "col-span-3"}>
              <label className={labelCls}>上長承認証跡ファイル *（4MBまで）</label>
              <input
                type="file"
                name="evidence"
                required
                className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700 hover:file:bg-blue-100"
              />
            </div>
            <div className="col-span-3 flex items-center gap-3 border-t border-slate-100 pt-4">
              <button className={btnPrimary} disabled={pending}>
                {pending ? "申請中..." : "申請する"}
              </button>
              <button type="button" className={btnOutline} onClick={() => setOpen(false)}>
                キャンセル
              </button>
              {state?.error && (
                <p className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600">{state.error}</p>
              )}
              {state?.ok && (
                <p className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700">
                  {state.message}
                </p>
              )}
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
