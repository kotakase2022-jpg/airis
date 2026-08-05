import { caseStatusValues } from "@/lib/status";
import { inputCls } from "@/components/ui";

// 窓口案件のステータス絞り込みセレクト（§7.8 検索 + ステータスフィルタ）。
//
// 選択肢はステータスマスタ（StatusMaster kind="case"）から描画するため、
// DBに行を足す/消すだけでコード変更・再デプロイなしに増減する（§7.8）。
// SNC側の一覧（snc-case-list.tsx）と代理店向けビュー（/agency-cases）で共有できるよう
// 独立したサーバコンポーネントにしてある。
export async function CaseStatusFilterSelect({
  value,
  // 停止・削除済（§5.1 停/削・§3.4 論理削除）。SNC側のみ絞り込んで参照・復旧できる
  lifecycleStatuses = [],
  className = `${inputCls} w-48`,
}: {
  value: string;
  lifecycleStatuses?: readonly string[];
  className?: string;
}) {
  const statusValues = await caseStatusValues();
  return (
    <select name="status" defaultValue={value} className={className}>
      <option value="">すべてのステータス</option>
      {statusValues.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
      {lifecycleStatuses.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
