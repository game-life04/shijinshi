"use client";

// 窄屏上导航是横着滑的一行（ADR-047）：进页面时，当前页那一项要是没整个露出来，就滑到刚好露出来（和 scrollIntoView 的 inline: nearest 一样）。
// 不再滑到正中：「用法」钉在这一行右头以后（ADR-049），能滑的地方窄了，滑到正中会把第一项切成半截（复查时 320 宽的闯关页只露出「检工作台」）。
// 两头各有一段淡出（globals.css 的 .app-nav），「露出来」要算到淡出以外。只动导航自己的横向滚动，不碰页面的滚动位置；导航没溢出（大屏）时什么都不做。

import { useEffect, useRef } from "react";

/** 导航两头淡出的宽度，和 globals.css 里 .app-nav 的 mask-image 一致（左 0.75rem、右 1.75rem） */
export const NAV_FADE = { left: 12, right: 28 };

/**
 * 导航该滑到哪（scrollLeft）：当前项已经整个露在两头淡出之间就不动；挡在左边就滑到它的左边刚好露出，挡在右边就滑到右边刚好露出。
 * itemLeft 是当前项在导航内容里的位置（从内容最左边算）。
 */
export function nearestScroll(scrollLeft: number, viewWidth: number, itemLeft: number, itemWidth: number): number {
  const lo = scrollLeft + NAV_FADE.left;
  const hi = scrollLeft + viewWidth - NAV_FADE.right;
  if (itemLeft >= lo && itemLeft + itemWidth <= hi) return scrollLeft;
  if (itemLeft < lo || itemWidth > viewWidth - NAV_FADE.left - NAV_FADE.right) return Math.max(0, itemLeft - NAV_FADE.left);
  return itemLeft + itemWidth - viewWidth + NAV_FADE.right;
}

export default function NavAutoScroll() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const nav = ref.current?.parentElement;
    const cur = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return;
    const left = cur.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    const to = nearestScroll(nav.scrollLeft, nav.clientWidth, left, cur.offsetWidth);
    if (to !== nav.scrollLeft) nav.scrollLeft = to;
  }, []);
  return <span ref={ref} hidden />;
}
