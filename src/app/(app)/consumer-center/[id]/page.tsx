import { requirePage } from "@/lib/auth";
import { SncCaseDetailPage } from "@/components/cases/snc-case-detail";

// 消費者センター窓口 案件詳細（§7.9）
export default async function ConsumerCenterDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePage("consumer-center");
  const { id } = await params;
  return <SncCaseDetailPage user={user} series="CSC" id={id} />;
}
