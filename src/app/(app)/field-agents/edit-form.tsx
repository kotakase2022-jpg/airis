"use client";

// 訪販員申請の業務項目 変更フォーム（SPEC §5.1 訪販員申請「変」/ §7.4 列仕様）
// - 対象: 申請区分 / 取扱商材 / 属性 / フリガナ / 本人性種別 / 誓約書No /
//         稼働開始日・終了日 / 使用代理店コード1・2 / 業務委託会社3項目
// - 取扱商材=マルチ → 使用代理店コード2枠必須（それ以外は1枠目のみ必須）
// - 属性=業務委託社員 のときのみ業務委託会社3項目を必須化（他属性では入力不可）
// - SNC限定項目（ブラックリスト欄・SNC用メモ）はこのフォームでは扱わない（一覧の行内フォームが担当 §7.4）
import Link from "next/link";
import { useActionState, useState } from "react";
import { updateFieldApplicationAction, type FormState } from "./actions";
import { inputCls, labelCls, btnPrimary, btnOutline } from "@/components/ui";

export type EditTarget = {
  id: string;
  salesId: string;
  staffName: string;
  agencyName: string;
  statusLabel: string;
  applicationType: string;
  products: string;
  attribute: string;
  lastNameKana: string;
  firstNameKana: string;
  identityType: string;
  pledgeNo: string;
  startDate: string;
  endDate: string;
  agencyCode1: string;
  agencyCode2: string;
  contractorName: string;
  contractorAddress: string;
  contractorPhone: string;
};

const initialState: FormState = {};

export function FieldApplicationEditForm({
  target,
  backHref,
}: {
  target: EditTarget;
  backHref: string;
}) {
  const [state, formAction, pending] = useActionState(updateFieldApplicationAction, initialState);
  const [products, setProducts] = useState(target.products);
  const [attribute, setAttribute] = useState(target.attribute);

  const isMulti = products === "マルチ";
  const isContractor = attribute === "業務委託社員";

  return (
    <div className="mb-4 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-slate-800">訪販員申請の業務項目を変更</h2>
        <Link href={backHref} className="text-sm text-slate-500 hover:underline">
          変更をやめる
        </Link>
      </div>
      <p className="mb-4 rounded-xl bg-blue-50 px-4 py-3 text-xs text-blue-900">
        対象: {target.salesId} / {target.staffName}（{target.agencyName}）／ 現在の状態:{" "}
        {target.statusLabel}
        <br />
        販売員ID・所属代理店は変更できません（販売員ID管理から変更してください）。
      </p>

      <form action={formAction}>
        <input type="hidden" name="id" value={target.id} />
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className={labelCls}>
              申請区分 <span className="text-red-500">*</span>
            </label>
            <select
              name="applicationType"
              required
              className={inputCls}
              defaultValue={target.applicationType}
            >
              <option value="稼働">稼働</option>
              <option value="抹消">抹消</option>
            </select>
          </div>
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
              本人性種別 <span className="text-red-500">*</span>
            </label>
            <select
              name="identityType"
              required
              className={inputCls}
              defaultValue={target.identityType}
            >
              <option value="免許証">免許証</option>
              <option value="マイナンバーカード">マイナンバーカード</option>
              <option value="パスポート">パスポート</option>
            </select>
          </div>

          <div>
            <label className={labelCls}>
              フリガナ（姓） <span className="text-red-500">*</span>
            </label>
            <input
              name="lastNameKana"
              required
              defaultValue={target.lastNameKana}
              className={inputCls}
              placeholder="ヤマダ"
            />
          </div>
          <div>
            <label className={labelCls}>
              フリガナ（名） <span className="text-red-500">*</span>
            </label>
            <input
              name="firstNameKana"
              required
              defaultValue={target.firstNameKana}
              className={inputCls}
              placeholder="タロウ"
            />
          </div>
          <div>
            <label className={labelCls}>
              誓約書No <span className="text-red-500">*</span>
            </label>
            <input
              name="pledgeNo"
              required
              defaultValue={target.pledgeNo}
              className={inputCls}
              placeholder="例: 70"
            />
          </div>

          <div>
            <label className={labelCls}>
              使用代理店コード（1枠目） <span className="text-red-500">*</span>
            </label>
            <input
              name="agencyCode1"
              required
              defaultValue={target.agencyCode1}
              className={inputCls}
              placeholder="例: 6YS008"
            />
          </div>
          <div>
            <label className={labelCls}>
              使用代理店コード（2枠目）
              {isMulti && <span className="text-red-500"> *（マルチは2枠必須）</span>}
            </label>
            <input
              name="agencyCode2"
              required={isMulti}
              defaultValue={target.agencyCode2}
              className={inputCls}
              placeholder="例: 666J08"
            />
          </div>
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
              defaultValue={target.contractorName}
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
              defaultValue={target.contractorAddress}
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
              defaultValue={target.contractorPhone}
              className={`${inputCls} disabled:bg-slate-100 disabled:text-slate-400`}
              placeholder={
                isContractor ? "03-0000-0000（半角ハイフンあり）" : "属性が業務委託社員の場合のみ"
              }
            />
          </div>

          {/* 稼働開始日 / 稼働終了日（カレンダー選択 §7.4） */}
          <div>
            <label className={labelCls}>稼働開始日</label>
            <input
              type="date"
              name="startDate"
              defaultValue={target.startDate}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls}>稼働終了日</label>
            <input type="date" name="endDate" defaultValue={target.endDate} className={inputCls} />
          </div>
        </div>

        {state.error && (
          <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        )}
        {state.success && (
          <div className="mt-4 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
            {state.success}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3">
          <button type="submit" disabled={pending} className={btnPrimary}>
            {pending ? "保存中..." : "変更を保存"}
          </button>
          <Link href={backHref} className={btnOutline}>
            一覧へ戻る
          </Link>
        </div>
      </form>
    </div>
  );
}
