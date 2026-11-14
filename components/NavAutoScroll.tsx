"use client";

// 窄屏上导航是横着滑的一行（ADR-047）：进页面时，当前页那一项要是没整个露出来，就滑到刚好露出来（和 scrollIntoView 的 inline: nearest 一样）。
// 不再滑到正中：「用法」钉在这一行右头以后（ADR-049），能滑的地方窄了，滑到正中会把第一项切成半截（复查时 320 宽的闯关页只露出「检工作台」）。
// 看得出还能滑（ADR-049 深度测试：手机 390 宽只露出前三项，「运行记录」只剩一道淡淡的图标边，第一次来的人看不出这一行能划）：
// 哪一头还有被挡住的页面，那一头才淡出，并且在那一头画一个「›」或「‹」；滑到头，那一头的箭头就收掉。
// 箭头只是画上去的记号，不接触摸（pointer-events: none）：手指从箭头上开始横着划，划的还是底下的导航
// （复查：原来箭头是盖在上面的按钮，从它上面开始划，导航一点不动）。点箭头那一小块，由导航自己认出来、翻到下一批。
// 键盘 Tab 到半露的那一项时浏览器自己不会滑（只有整个被挡住的才滑），这里把它滑到两个箭头之间。
// 转屏、窗口变宽变窄以后，当前页那一项重新滑出来一次。
// 大屏上导航不溢出：箭头和淡出都没有（globals.css 只在窄屏的版面里给它们样式）。只动导航自己的横向滚动，不碰页面的滚动位置。

import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

/** 一头的箭头加淡入一共多宽、其中箭头自己多宽（rem），和 globals.css 里 .app-nav[data-more] 的淡出、.app-nav-more 的宽度一致 */
const FADE_REM = 2.5;
const ARROW_REM = 1.75;
/** 默认字号 16px 时一头淡出的宽度（px）：「露出来」要算到这以外。浏览器默认字号不是 16px 时按量到的算（见下面的 sizes） */
export const NAV_FADE = { left: 16 * FADE_REM, right: 16 * FADE_REM };

/** 哪一头还有被挡住的页面（那一头才有箭头和淡出） */
export type NavMore = "" | "left" | "right" | "both";
const moreLeft = (m: NavMore) => m === "left" || m === "both";
const moreRight = (m: NavMore) => m === "right" || m === "both";

/**
 * 哪一头还有被挡住的页面。padStart、padEnd 是导航两头的内边距：只滑进了内边距（第一项、最后一项其实整个露着）不算被挡住，
 * 免得只多出几像素也冒出箭头（复查：横屏手机 844 宽只多出 6px，原来照样出「›」，点一下又变成「‹」盖住第一项的图标）；
 * 再差 2px 以内也算到头，小数像素不让箭头一闪一闪。
 */
export function navMore(scrollLeft: number, viewWidth: number, contentWidth: number, padStart = 0, padEnd = 0): NavMore {
  const left = scrollLeft > padStart + 2;
  const right = contentWidth - viewWidth - scrollLeft > padEnd + 2;
  return left && right ? "both" : left ? "left" : right ? "right" : "";
}

/**
 * 导航该滑到哪（scrollLeft）才让这一项整个露出来：已经露在箭头之间就不动；挡在左边就滑到它的左边刚好露出，挡在右边就滑到右边刚好露出。
 * itemLeft 是这一项在导航内容里的位置（从内容最左边算）。more 是现在哪一头有箭头：没有箭头的那一头不用让（默认两头都让）。
 * fade 是一头淡出的宽度。算出来的数可以超出能滑的范围，浏览器会自己收住。
 */
export function nearestScroll(
  scrollLeft: number,
  viewWidth: number,
  itemLeft: number,
  itemWidth: number,
  more: NavMore = "both",
  fade = NAV_FADE.left,
): number {
  const lo = scrollLeft + (moreLeft(more) ? fade : 0);
  const hi = scrollLeft + viewWidth - (moreRight(more) ? fade : 0);
  if (itemLeft >= lo && itemLeft + itemWidth <= hi) return scrollLeft;
  if (itemLeft < lo || itemWidth > viewWidth - fade * 2) return Math.max(0, itemLeft - fade);
  return itemLeft + itemWidth - viewWidth + fade;
}

/**
 * 点「›」「‹」滑到哪：按项翻，不按固定的距离（复查：320 宽时每次滑 140px，两个箭头之间只有 150 来宽，
 * 「打字闯关」「运行记录」一路点下来一次都没整个露出来过）。
 * 「›」：右边第一个没整个露出来的那一项，滑到紧挨着左箭头；「‹」：左边最后一个没整个露出来的，滑到紧挨着右箭头。
 * 所以每一项都会整个露出来一次。哪一项比两个箭头之间还宽（不会有）就按一屏翻，保证点了会动。
 */
export function stepScroll(
  dir: 1 | -1,
  scrollLeft: number,
  viewWidth: number,
  contentWidth: number,
  items: readonly { left: number; width: number }[],
  more: NavMore,
  fade = NAV_FADE.left,
): number {
  const max = Math.max(0, contentWidth - viewWidth);
  const lo = scrollLeft + (moreLeft(more) ? fade : 0);
  const hi = scrollLeft + viewWidth - (moreRight(more) ? fade : 0);
  const page = Math.max(48, viewWidth - fade * 2);
  if (dir > 0) {
    const next = items.find((it) => it.left + it.width > hi + 0.5);
    const to = next ? next.left - fade : max;
    return Math.min(max, to > scrollLeft + 1 ? to : scrollLeft + page);
  }
  const prev = [...items].reverse().find((it) => it.left < lo - 0.5);
  const to = prev ? prev.left + prev.width - viewWidth + fade : 0;
  return Math.max(0, to < scrollLeft - 1 ? to : scrollLeft - page);
}

/** 点了箭头那一小块（x 是点在导航里的位置）：点的是哪一头。两头各 arrow 宽 */
export function edgeHit(x: number, viewWidth: number, arrow: number): "" | "left" | "right" {
  return x < arrow ? "left" : x > viewWidth - arrow ? "right" : "";
}

/**
 * 点过箭头、滑停以后，箭头收掉的那一小块再挡多久的点击（毫秒）。挡着的时候点了会续上。
 * 取 1.2 秒：复查时一秒点一下的慢节奏，0.7 秒挡不住。点过哪头的箭头就挡哪头那一小块：左头底下是第一项的图标（点它的字不受影响），
 * 右头滑到底时底下只是内边距
 */
const GUARD_MS = 1200;

export default function NavScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // 先当右边还有：竖着拿的手机上导航总是放不下，脚本还没跑起来时（慢网速下要好几秒）也先看得到「›」。
  // 量过以前（data-measured 还没有），放得下的窄屏版面（平板、很宽的横屏）不显示它，见 globals.css；大屏上本来就不显示
  const [more, setMore] = useState<NavMore>("right");
  const [measured, setMeasured] = useState(false);

  useEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const pad = { start: 0, end: 0 };
    const sizes = { fade: NAV_FADE.left, arrow: 16 * ARROW_REM };
    // 连点「‹」滑到头，箭头收掉，那一小块底下就是第一项「体检工作台」，再点一下会点进那一页（复查时真的点进去了）：
    // 点过箭头以后，到滑停再过 GUARD_MS 为止，那一小块上的点击不算数
    let guardSide: "" | "left" | "right" = "";
    let guardTimer: number | undefined;
    const armGuard = (side: "left" | "right") => {
      guardSide = side;
      window.clearTimeout(guardTimer);
      guardTimer = window.setTimeout(() => {
        guardSide = "";
      }, GUARD_MS);
    };
    const now = () => navMore(nav.scrollLeft, nav.clientWidth, nav.scrollWidth, pad.start, pad.end);
    const update = () => {
      setMore(now());
      // 点箭头引出来的滑动还在走：挡点击的时间从滑停算起
      if (guardSide) armGuard(guardSide);
    };
    /** 把这一项滑到两个箭头之间（已经整个露着就不动） */
    const reveal = (el: HTMLElement | null) => {
      if (!el) return;
      const left = el.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
      const to = nearestScroll(nav.scrollLeft, nav.clientWidth, left, el.offsetWidth, now(), sizes.fade);
      if (to !== nav.scrollLeft) nav.scrollLeft = to;
    };
    const step = (dir: 1 | -1) => {
      const box = nav.getBoundingClientRect().left;
      const items = [...nav.querySelectorAll<HTMLElement>("a")].map((a) => ({
        left: a.getBoundingClientRect().left - box + nav.scrollLeft,
        width: a.offsetWidth,
      }));
      const to = stepScroll(dir, nav.scrollLeft, nav.clientWidth, nav.scrollWidth, items, now(), sizes.fade);
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      nav.scrollTo({ left: to, behavior: reduce ? "auto" : "smooth" });
      armGuard(dir < 0 ? "left" : "right");
    };
    let width = -1;
    // 内边距随版面变（横屏手机左边小一点），箭头和淡出的宽度随浏览器默认字号变（样式里用 rem 写的）：尺寸变了才重新读；
    // 宽度变了（转屏、拉窗口），当前页那一项重新滑出来一次
    const measure = () => {
      const cs = getComputedStyle(nav);
      pad.start = Number.parseFloat(cs.paddingLeft) || 0;
      pad.end = Number.parseFloat(cs.paddingRight) || 0;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      sizes.fade = rem * FADE_REM;
      sizes.arrow = rem * ARROW_REM;
      if (nav.clientWidth !== width) {
        width = nav.clientWidth;
        reveal(nav.querySelector<HTMLElement>('[aria-current="page"]'));
      }
      setMore(now());
      setMeasured(true);
    };
    // 键盘走到半露的那一项：滑到两个箭头之间。只管键盘（:focus-visible）：手指、鼠标点下去时要是也滑，按下和抬起就不在同一项上，点不中
    const onFocus = (e: FocusEvent) => {
      const a = e.target instanceof Element ? e.target.closest<HTMLElement>("a") : null;
      if (!a || !nav.contains(a)) return;
      let keyboard = false;
      try {
        keyboard = a.matches(":focus-visible");
      } catch {
        // 老浏览器不认 :focus-visible：不滑
      }
      if (keyboard) reveal(a);
    };
    // 手指（鼠标）真按下去的地方。手机浏览器有「触摸校正」：click 的坐标会被挪到附近链接的字或图标上，
    // 点在箭头靠里那几像素时挪出了箭头，原来就当成点了底下看不见的链接、跳到别的页（第三轮复查：扫 385 次有 7 次这样）。
    // 按下（pointerdown）的坐标是没挪过的，判断点没点在箭头上按它来
    let down: { x: number; y: number; t: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    };
    // 点在箭头那一小块上：有箭头就翻到下一批；刚滑到头、箭头收掉的那一会儿（GUARD_MS）点了不算。都不让它点进底下的链接。
    // 键盘回车（detail 是 0）不管；读屏、语音控制补发的点击没有位置（坐标是 0，落在导航上下范围外面）也不管，照常进那一页。
    // 在捕获阶段拦：链接自己的点击处理（Next 的站内跳转）收不到这一下
    const edgeOf = (e: MouseEvent) => {
      if (e.detail === 0) return null;
      // 这一下点击对应的按下：一秒以内的才算（长按、拖着不放的不会有 click）
      const p = down && e.timeStamp - down.t < 1000 ? down : { x: e.clientX, y: e.clientY };
      const box = nav.getBoundingClientRect();
      if (p.y < box.top || p.y > box.bottom) return null;
      const side = edgeHit(p.x - box.left, box.width, sizes.arrow);
      if (!side) return null;
      const m = now();
      const shown = side === "left" ? moreLeft(m) : moreRight(m);
      return shown || guardSide === side ? { side, shown } : null;
    };
    const onClick = (e: MouseEvent) => {
      const hit = edgeOf(e);
      down = null;
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      if (hit.shown) step(hit.side === "left" ? -1 : 1);
      else armGuard(hit.side);
    };
    // 鼠标中键点在箭头那一小块上：不在新标签里打开底下看不见的那一页（中键是 auxclick，不走 click）
    const onAuxClick = (e: MouseEvent) => {
      if (e.button !== 1 || !edgeOf(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    measure();
    nav.addEventListener("scroll", update, { passive: true });
    nav.addEventListener("focusin", onFocus);
    nav.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    nav.addEventListener("click", onClick, true);
    nav.addEventListener("auxclick", onAuxClick, true);
    // 老浏览器没有 ResizeObserver（iOS 13.4 以前）：只看窗口尺寸，不能因为一个小提示把整页弄坏
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(nav);
    else window.addEventListener("resize", measure);
    // 字体下载完以后每一项会变宽
    let alive = true;
    document.fonts?.ready
      .then(() => {
        if (alive) measure();
      })
      .catch(() => {});
    return () => {
      alive = false;
      nav.removeEventListener("scroll", update);
      nav.removeEventListener("focusin", onFocus);
      nav.removeEventListener("pointerdown", onDown, true);
      nav.removeEventListener("click", onClick, true);
      nav.removeEventListener("auxclick", onAuxClick, true);
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", measure);
      window.clearTimeout(guardTimer);
    };
  }, []);

  return (
    <div className="app-nav-scroller" data-measured={measured ? "1" : undefined}>
      <div ref={ref} className="app-nav" data-more={more || undefined}>
        {children}
      </div>
      {moreLeft(more) && (
        <span className="app-nav-more" data-side="left" aria-hidden>
          <ChevronLeft size={16} />
        </span>
      )}
      {moreRight(more) && (
        <span className="app-nav-more" data-side="right" aria-hidden>
          <ChevronRight size={16} />
        </span>
      )}
    </div>
  );
}
