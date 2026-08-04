import { requirePage } from "@/lib/auth";
import { SncCaseListPage, SearchParams } from "@/components/cases/snc-case-list";

// ホットライン窓口（§7.8: R1/R2/R3/R5）
export default async function HotlinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requirePage("hotline");
  const sp = await searchParams;
  return <SncCaseListPage user={user} series="HL" sp={sp} />;
}
