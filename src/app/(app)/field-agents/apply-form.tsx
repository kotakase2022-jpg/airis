"use client";

// 訪販員申請フォーム（SPEC §7.4 列仕様）
// - 販売員ID選択で氏名・所属代理店・1次店名を自動表示
// - 取扱商材=マルチ → 使用代理店コード2枠必須（それ以外は1枠目のみ必須）
// - 属性=業務委託社員 のときのみ業務委託会社3項目を必須化（他属性では入力不可）
// - SNC限定項目（ブラックリスト欄・SNC用メモ）は isSnc のときのみ描画
import { useActionState, useState } from "react";
import {
  createFieldAgentApplication,
  duplicateCheckAction,
  type FormState,
  type CheckState,
} from "./actions";
import { inputCls, labelCls, btnPrimary, btnOutline } from "@/components/ui";

export type StaffOption = {
  id: string;
  salesId: string;
  name: string;
  agencyName: string;
  agencyCode: string;
  primaryAgencyName: string;
};

const initialForm: FormState = {};
const initialCheck: CheckState = {};

export function ApplyForm({ staff, isSnc }: { staff: StaffOption[]; isSnc: boolean }) {
  const [open, setOpen] = useState(false);
  const [createState, createAction, creating] = useActionState(
    createFieldAgentApplication,
    initialForm
  );
  const [checkState, checkAction, checking] = useActionState(duplicateCheckAction, initialCheck);
  const [selectedId, setSelectedId] = useState("");
  const [products, setProducts] = useState("マルチ");
  const [attribute, setAttribute] = useState("社員/契約社員");

  const selected = staff.find((s) => s.id === selectedId) ?? null;
  const isContractor = attribute === "業務委託社員";
  const isMulti = products === "マルチ";

  if (!open) {
    return (
      <div className="mb-4">
        <button type="button" className={btnPrimary} onClick={() => setOpen(true)}>
          ＋ 訪販員申請
        </button>
        {createState.success && (
          <span className="ml-3 text-sm font-medium text-emerald-600">{createState.success}</span>
        )}
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">訪販員申請</h2>
        <button
          type="button"
          className="text-sm text-slate-500 hover:underline"
          onClick={() => setOpen(false)}
        >
          閉じる
        </button>
      </div>
      <p className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-xs text-blue-900">
        訪販員申請は販売員IDの登録（仮登録・本登録）後にのみ可能です。訪販員IDは発行されず、登録有無のステータスのみで管理されます。
      </p>

      <form action={createAction}>
        <div className="grid grid-cols-3 gap-4">
          {/* 販売員ID選択 → 氏名・所属代理店・1次店名を自動表示 */}
          <div>
            <label className={labelCls}>
              販売員ID <span className="text-red-500">*</span>
            </label>
            <select
              name="salesStaffId"
              required
              className={inputCls}
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              <option value="">選択してください</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.salesId} / {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>氏名（自動表示）</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {selected ? selected.name : "—"}
            </div>
          </div>
          <div>
            <label className={labelCls}>所属代理店（自動表示）</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {selected ? `${selected.agencyName}（${selected.agencyCode}）` : "—"}
            </div>
          </div>

          {/* 1次店名（自動既定入力・変更可）/ 所属代理店名（自由記述・既定入力） */}
          <div>
            <label className={labelCls}>1次店名（変更可）</label>
            <input
              key={`p-${selectedId}`}
              name="primaryAgencyName"
              defaultValue={selected?.primaryAgencyName ?? ""}
              className={inputCls}
              placeholder="1次店名"
            />
          </div>
          <div>
            <label className={labelCls}>所属代理店名（自由記述）</label>
            <input
              key={`a-${selectedId}`}
              name="agencyName"
              defaultValue={selected?.agencyName ?? ""}
              className={inputCls}
              placeholder="所属代理店名"
            />
          </div>
          <div>
            <label className={labelCls}>
              申請区分 <span className="text-red-500">*</span>
            </label>
            <select name="applicationType" required className={inputCls} defaultValue="稼働">
              <option value="稼働">稼働</option>
              <option value="抹消">抹消</option>
            </select>
          </div>

          {/* 取扱商材と使用代理店コード2枠 */}
          <div>
            <label className={labelCls}>
              取扱商材 <span className="text-red-500">*</span>
            </label>
            <select
              name="products"
              required
              className={inputCls}
              value={products}
              onChange={(e) => setProducts(e.target.value)}
            >
              <option value="マルチ">マルチ</option>
              <option value="auひかり">auひかり</option>
              <option value="コラボ">コラボ</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>
              使用代理店コード（1枠目） <span className="text-red-500">*</span>
            </label>
            <input name="agencyCode1" required className={inputCls} placeholder="例: 6YS008" />
          </div>
          <div>
            <label className={labelCls}>
              使用代理店コード（2枠目）
              {isMulti && <span className="text-red-500"> *（マルチは2枠必須）</span>}
            </label>
            <input
              name="agencyCode2"
              required={isMulti}
              className={inputCls}
              placeholder="例: 666J08"
            />
          </div>

          {/* フリガナ（姓・名 別枠） */}
          <div>
            <label className={labelCls}>
              フリガナ（姓） <span className="text-red-500">*</span>
            </label>
            <input name="lastNameKana" required className={inputCls} placeholder="ヤマダ" />
          </div>
          <div>
            <label className={labelCls}>
              フリガナ（名） <span className="text-red-500">*</span>
            </label>
            <input name="firstNameKana" required className={inputCls} placeholder="タロウ" />
          </div>
          <div>
            <label className={labelCls}>
              本人性種別 <span className="text-red-500">*</span>
            </label>
            <select name="identityType" required className={inputCls} defaultValue="免許証">
              <option value="免許証">免許証</option>
              <option value="マイナンバーカード">マイナンバーカード</option>
              <option value="パスポート">パスポート</option>
            </select>
          </div>

          {/* 属性 + 業務委託3項目 */}
          <div>
            <label className={labelCls}>
              属性 <span className="text-red-500">*</span>
            </label>
            <select
              name="attribute"
              required
              className={inputCls}
              value={attribute}
              onChange={(e) => setAttribute(e.target.value)}
            >
              <option value="社員/契約社員">社員/契約社員</option>
              <option value="パート・アルバイト">パート・アルバイト</option>
              <option value="業務委託社員">業務委託社員</option>
              <option value="個人事業主">個人事業主</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>
              業務委託会社名
              {isContractor && <span className="text-red-500"> *</span>}
            </label>
            <input
              name="contractorName"
              disabled={!isContractor}
              required={isContractor}
              className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-400`}
              placeholder={isContractor ? "株式会社〇〇" : "属性が業務委託社員の場合のみ"}
            />
          </div>
          <div>
            <label className={labelCls}>
              業務委託会社住所
              {isContractor && <span className="text-red-500"> *</span>}
            </label>
            <input
              name="contractorAddress"
              disabled={!isContractor}
              required={isContractor}
              className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-400`}
              placeholder={isContractor ? "〒100-0000 東京都…" : "属性が業務委託社員の場合のみ"}
            />
          </div>
          <div>
            <label className={labelCls}>
              業務委託会社連絡先
              {isContractor && <span className="text-red-500"> *</span>}
            </label>
            <input
              name="contractorPhone"
              disabled={!isContractor}
              required={isContractor}
              className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-400`}
              placeholder={isContractor ? "03-0000-0000（半角ハイフンあり）" : "属性が業務委託社員の場合のみ"}
            />
          </div>

          {/* 誓約書 */}
          <div>
            <label className={labelCls}>
              誓約書No <span className="text-red-500">*</span>
            </label>
            <input name="pledgeNo" required className={inputCls} placeholder="例: 70" />
          </div>
          <div>
            <label className={labelCls}>誓約書PDF（任意・4MBまで）</label>
            <input
              type="file"
              name="pledgeFile"
              accept="application/pdf,.pdf"
              className="w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-blue-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-blue-700"
            />
          </div>

          {/* 稼働開始日 / 稼働終了日（カレンダー選択） */}
          <div>
            <label className={labelCls}>稼働開始日</label>
            <input type="date" name="startDate" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>稼働終了日</label>
            <input type="date" name="endDate" className={inputCls} />
          </div>
        </div>

        {/* SNC限定項目（①②③のみ表示・編集。代理店側には一切出さない §7.4） */}
        {isSnc && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="mb-2 text-xs font-bold text-amber-800">
              SNC限定項目（代理店側には表示されません）
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>ブラックリスト欄</label>
                <select name="blacklistFlag" defaultValue="" className={inputCls}>
                  <option value="">無印（問題なし）</option>
                  <option value="★">★（ブラックリスト）</option>
                  <option value="1">1（要注意）</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className={labelCls}>備考（SNC用メモ）</label>
                <input name="sncMemo" className={inputCls} placeholder="SNC内部メモ" />
              </div>
            </div>
          </div>
        )}

        {/* 簡易チェック結果 */}
        {checkState.error && (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {checkState.error}
          </div>
        )}
        {checkState.checked &&
          (checkState.warnings && checkState.warnings.length > 0 ? (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <div className="mb-1 font-bold">簡易チェックの警告（{checkState.warnings.length}件）</div>
              <ul className="list-inside list-disc space-y-0.5">
                {checkState.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              簡易チェックで警告はありません。
            </div>
          ))}

        {/* 申請結果 */}
        {createState.error && (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {createState.error}
          </div>
        )}
        {createState.success && (
          <div className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {createState.success}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button
            type="submit"
            formAction={checkAction}
            formNoValidate
            disabled={checking || creating}
            className={btnOutline}
          >
            {/* ブラックリストの存在自体をSNC系(①②③)以外には見せない（§7.4） */}
            {checking ? "確認中..." : isSnc ? "同姓同名・ブラックリスト確認" : "同姓同名確認"}
          </button>
          <button type="submit" disabled={creating || checking} className={btnPrimary}>
            {creating ? "申請中..." : "申請する"}
          </button>
        </div>
      </form>
    </div>
  );
}
