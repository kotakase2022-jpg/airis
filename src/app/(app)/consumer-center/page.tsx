import { requirePage } from "@/lib/auth";
import { SncCaseListPage, SearchParams } from "@/components/cases/snc-case-list";

// 消費者センター窓口（§7.9: R1/R2/R3/R6。実装はHLとseriesパラメタ違いで共通化）
export default async function ConsumerCenterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePage("consumer-center");
  const sp = await searchParams;
  return <SncCaseListPage user={user} series="CSC" sp={sp} />;
}
