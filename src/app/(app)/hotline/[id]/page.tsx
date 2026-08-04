import { requirePage } from "@/lib/auth";
import { SncCaseDetailPage } from "@/components/cases/snc-case-detail";

// ホットライン窓口 案件詳細（§7.8）
export default async function HotlineDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePage("hotline");
  const { id } = await params;
  return <SncCaseDetailPage user={user} series="HL" id={id} />;
}
