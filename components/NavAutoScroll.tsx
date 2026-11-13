"use client";

// 窄屏上导航是横着滑的一行（ADR-047）：进页面时把当前页那一项滑到看得见的地方。
// 只动导航自己的横向滚动，不碰页面的滚动位置；导航没溢出（大屏）时什么都不做。

import { useEffect, useRef } from "react";

export default function NavAutoScroll() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const nav = ref.current?.parentElement;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return;
    const left = cur.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    nav.scrollLeft = Math.max(0, left - (nav.clientWidth - cur.offsetWidth) / 2);
  }, []);
  return <span ref={ref} hidden />;
}
