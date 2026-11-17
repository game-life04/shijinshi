"use client";

// 有体检还在跑（排队、运行中、暂停中、终止中）时，每隔几秒刷新一次这一页的服务端数据（11-17 修改 4：运行记录、攻防地图不会自己更新）。
// 只刷新数据，不整页重载：滚动位置、展开的折叠都还在。哪几种状态算「还在跑」在 lib/domain/types.ts 的 BUSY_RUN_STATES
// （这个文件只在浏览器里跑，服务端页面从这里拿不到普通的值）。

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function AutoRefresh({ on, ms = 3000 }: { on: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [on, ms, router]);
  return null;
}
