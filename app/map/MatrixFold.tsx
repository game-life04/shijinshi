"use client";

// 「详细矩阵」折叠（ADR-053（11-16 队员 B 修改稿 3）：原来的「七样检查 × 怎么攻」、「拦住攻击的是哪一层」、怎么数的收进来，默认收着）。
// 什么时候自己展开：
// - 地址里点开了一格（cell=…，点格子、「查看原话」「查看三档对照」都带它）：服务端出来就是展开的；页面不刷新、换一格时也展开。
//   用 useLayoutEffect：先展开，再卷过去（#detail 由 ScrollToDetail 卷，#cmp-… 由 Next 卷），不然卷向一个藏着的元素不动；
// - 地址带 #detail、#matrix 或 #cmp-…（从别处链过来、刷新）：展开，再卷到那个锚点
//   （直接打开带锚点的地址时，浏览器自己那一下卷动没卷到，自查时 #cmp-… 那一行还在屏幕外）；
// - 再点一次同一个「查看原话」「查看三档对照」（复查）：地址没变，上面两条都不会再跑——用户把折叠收起来、或者卷回顶上以后再点，
//   原来没有任何反应。所以另外听页面上的点击：点的链接要去的就是现在这个地址、锚点又在折叠里，就先展开、再卷过去。
// 展开以后只由用户自己收：open 只在第一次渲染时给，之后 React 不再改它（不然点明细的「收起」时整个矩阵会跟着收起来）。

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

const opensFold = (hash: string) => hash === "#detail" || hash === "#matrix" || hash.startsWith("#cmp-");

/** 锚点指的那个元素。名字都是字母数字，照理不用解码；手改地址带了坏掉的 %xx 时解码会抛错，那就原样用（复查：原来整页报错） */
function targetOf(hash: string): HTMLElement | null {
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // 原样用
  }
  return id ? document.getElementById(id) : null;
}

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
      targetOf(hash)?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    // 再点一次同一个链接：地址不变，Next 不重新渲染、也不触发 hashchange
    const again = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      const fold = ref.current;
      if (!a || !fold || !opensFold(a.hash)) return;
      // 只管「要去的就是现在这个地址」的：换了地址的那种照原来的路走（服务端按 cell= 展开、ScrollToDetail 卷）
      if (a.pathname !== window.location.pathname || a.search !== window.location.search) return;
      fold.open = true;
      // 等折叠展开、排好版再卷（当场卷，目标还没有高度）
      requestAnimationFrame(() => {
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        (targetOf(a.hash) ?? fold).scrollIntoView({
          block: a.hash === "#detail" ? "nearest" : "start",
          behavior: reduce ? "auto" : "smooth",
        });
      });
    };
    document.addEventListener("click", again);
    return () => {
      window.removeEventListener("hashchange", open);
      document.removeEventListener("click", again);
    };
  }, []);
  return (
    <details ref={ref} id="matrix" className="atk-fold scroll-mt-16" data-testid="map-fold" open={initial}>
      {summary}
      {children}
    </details>
  );
}
