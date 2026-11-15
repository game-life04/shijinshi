// 切到这一页时先出来的占位（ADR-051，components/PageLoading.tsx）
import PageLoading from "@/components/PageLoading";

export default function Loading() {
  return <PageLoading active="/map" title="攻防地图" />;
}
