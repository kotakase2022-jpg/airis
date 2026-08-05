"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { CASE_TEMPLATES } from "@/lib/roles";
import { btnOutline, btnPrimary, inputCls, labelCls } from "@/components/ui";
import { createCaseAction, CreateCaseState } from "./actions";

export type AgencyOption = {
  id: string;
  code: string;
  name: string;
  tier: number;
  parentId: string | null;
  status: string;
};

// 販売員ID紐付け用（問題一覧No.14）。agencyId/parentIdで選択中の代理店に絞り込む
export type StaffPick = {
  id: string;
  salesId: string;
  name: string;
  agencyId: string;
  agencyParentId: string | null;
};

// 起票テンプレ雛形（§7.8 一字一句）。「代理店確認依頼」のみ ■顧客要望 → ■確認内容
const TEMPLATE_BODIES: Record<string, string> = {
  音声提出依頼:
    "■依頼理由\n\n■顧客要望\n\n■顧客情報\nISP受付番号：\n代理店コード：\n代理店名称：",
  代理店様から顧客への架電依頼:
    "■依頼理由\n\n■顧客要望\n\n■顧客情報\nISP受付番号：\n代理店コード：\n代理店名称：",
  代理店確認依頼:
    "■依頼理由\n\n■確認内容\n\n■顧客情報\nISP受付番号：\n代理店コード：\n代理店名称：",
  フリー入力: "",
};

export function NewCaseForm({
  series,
  basePath,
  agencies,
  staff = [],
}: {
  series: "HL" | "CSC";
  basePath: string;
  agencies: AgencyOption[];
  staff?: StaffPick[];
}) {
  const [state, formAction, pending] = useActionState(
    (prev: CreateCaseState, fd: FormData) => createCaseAction(series, prev, fd),
    undefined
  );

  const [templateKind, setTemplateKind] = useState<string>("");
  const [primaryId, setPrimaryId] = useState<string>("");
  const [isp, setIsp] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [body, setBody] = useState<string>("");

  const primaries = agencies.filter((a) => a.tier === 1);
  const secondaries = agencies.filter((a) => a.tier === 2 && a.parentId === primaryId);

  // 件名の自動生成: テンプレ名称／代理店名称／ISP受付番号（接頭辞【】は付けない）
  const autoTitle = (tpl: string, pid: string, ispNo: string) => {
    const agencyName = primaries.find((a) => a.id === pid)?.name ?? "";
    return `${tpl}／${agencyName}／${ispNo}`;
  };

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className={labelCls}>依頼テンプレ</label>
          <select
            name="templateKind"
            className={inputCls}
            required
            value={templateKind}
            onChange={(e) => {
              const tpl = e.target.value;
              setTemplateKind(tpl);
              // テンプレ選択でタイトル・本文雛形を自動セット（手入力済みの本文は上書きされる。TODO: 上書き前の確認は割愛）
              setBody(TEMPLATE_BODIES[tpl] ?? "");
              setTitle(autoTitle(tpl, primaryId, isp));
            }}
          >
            <option value="">選択してください</option>
            {CASE_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>一次代理店</label>
          <select
            name="primaryAgencyId"
            className={inputCls}
            required
            value={primaryId}
            onChange={(e) => {
              const pid = e.target.value;
              setPrimaryId(pid);
              if (templateKind) setTitle(autoTitle(templateKind, pid, isp));
            }}
          >
            <option value="">選択してください</option>
            {primaries.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
                {a.status === "closed" ? "（稼働終了）" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>二次代理店（任意）</label>
          <select name="secondaryAgencyId" className={inputCls} defaultValue="">
            <option value="">指定なし</option>
            {secondaries.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} {a.name}
                {a.status === "closed" ? "（稼働終了）" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>ISP受付番号</label>
          <input
            name="ispNumber"
            className={inputCls}
            placeholder="例: ISP-2026-000123"
            value={isp}
            onChange={(e) => {
              const v = e.target.value;
              setIsp(v);
              if (templateKind) setTitle(autoTitle(templateKind, primaryId, v));
            }}
          />
        </div>
        <div>
          <label className={labelCls}>対応期限</label>
          <input name="deadline" type="date" className={inputCls} required />
        </div>
        <div>
          {/* 販売員ID紐付け（任意。問題一覧No.14: ID単位の品質管理・代理店別集計用） */}
          <label className={labelCls}>販売員ID（任意）</label>
          <select name="salesStaffId" className={inputCls} defaultValue="" disabled={!primaryId}>
            <option value="">指定なし</option>
            {staff
              .filter(
                (s) =>
                  primaryId && (s.agencyId === primaryId || s.agencyParentId === primaryId)
              )
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.salesId} {s.name}
                </option>
              ))}
          </select>
          {!primaryId && (
            <p className="mt-1 text-[11px] text-slate-400">一次代理店を選択すると絞り込まれます</p>
          )}
        </div>
        <div className="col-span-2">
          {/* 起票時添付（SNC側は添付可 §14-3。問題一覧No.23） */}
          <label className={labelCls}>添付ファイル（任意・複数可）</label>
          <input name="files" type="file" multiple className="text-sm" />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>件名（テンプレ・代理店・ISP受付番号から自動生成）</label>
          <input
            name="title"
            className={inputCls}
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="col-span-3">
          <label className={labelCls}>本文</label>
          <textarea
            name="body"
            rows={9}
            className={inputCls}
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>
      </div>
      {state?.error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
      )}
      <div className="flex items-center gap-2">
        <button className={btnPrimary} disabled={pending}>
          {pending ? "起票中..." : "起票する"}
        </button>
        <Link href={basePath} className={btnOutline}>
          キャンセル
        </Link>
      </div>
    </form>
  );
}
