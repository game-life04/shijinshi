"use client";

// 「详细矩阵」折叠（ADR-053（11-16 队员 B 修改稿 3）：原来的「七样检查 × 怎么攻」、「拦住攻击的是哪一层」、怎么数的收进来，默认收着）。
// 什么时候自己展开：
// - 地址里点开了一格（cell=…，点格子、「查看原话」「查看三档对照」都带它）：服务端出来就是展开的；页面不刷新、换一格时也展开。
//   用 useLayoutEffect：先展开，Next 再按 #detail / #cmp-… 卷过去，不然卷向一个藏着的元素不动；
// - 地址带 #detail、#matrix 或 #cmp-…（从别处链过来、刷新、或页内锚点）：展开，再卷到那个锚点
//   （直接打开带锚点的地址时，浏览器自己那一下卷动没卷到，自查时 #cmp-… 那一行还在屏幕外）。
// 展开以后只由用户自己收：open 只在第一次渲染时给，之后 React 不再改它（不然点明细的「收起」时整个矩阵会跟着收起来）。

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

const opensFold = (hash: string) => hash === "#detail" || hash === "#matrix" || hash.startsWith("#cmp-");

export default function MatrixFold({ openKey, summary, children }: { openKey: string | null; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [initial] = useState(Boolean(openKey));
  useLayoutEffect(() => {
    if (openKey && ref.current) ref.current.open = true;
  }, [openKey]);
  useEffect(() => {
    const open = () => {
      const hash = window.location.hash;
      if (!ref.current || !opensFold(hash)) return;
      ref.current.open = true;
      document.getElementById(decodeURIComponent(hash.slice(1)))?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);
  return (
    <details ref={ref} id="matrix" className="atk-fold scroll-mt-16" data-testid="map-fold" open={initial}>
      {summary}
      {children}
    </details>
  );
}
