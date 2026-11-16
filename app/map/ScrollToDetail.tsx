"use client";

// 点开一格以后，把下面的明细卷到看得见的地方（ADR-049）：原来点了格子页面不动，大屏上明细出在屏幕底下，看不出点了有反应。
// 只卷最少的距离（block: nearest），地图尽量还留在屏幕上；系统设了减少动态时不做平滑滚动。和 NavAutoScroll 同一个做法。
// ADR-053（11-16 队员 B 修改稿 3）：明细在「详细矩阵」折叠里，从上面「查看原话」点过来时折叠可能还收着：先展开再卷。

import { useEffect, useRef } from "react";

export default function ScrollToDetail({ cell }: { cell: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!cell) return;
    const box = ref.current?.parentElement;
    if (!box) return;
    const fold = box.closest("details");
    if (fold && !fold.open) fold.open = true;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [cell]);
  return <span ref={ref} hidden />;
}
