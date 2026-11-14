// 第一次登录先看「用法」（队员 B 的建议 4）：这个浏览器第一次登录成功，先到 /guide 看一眼每页做什么，
// 原来要去的地址记在 next 里，用法页上一下就能接着去；以后再登录（退出、过期以后）照旧直接回原地址。
// 「看过没有」记在一个只有 1 的 cookie 里（GUIDE_COOKIE），只认浏览器、不认账号，登录接口发会话 cookie 时一起发。
// 没配账号的服务器（本机、评委自己运行）不用登录，也就不自动打开用法页；顶栏的「用法」随时能点。

import { FATES_PAGE } from "@/lib/domain/fates-page";
import { safeNext } from "./access";

export const GUIDE_COOKIE = "fencun_guide";
export const GUIDE_PATH = "/guide";

/** 原来的「三种结局」（/fates）：ADR-049 起不在顶栏，是「原理」页下面的一个小实验。名字只有一份，在 lib/domain/fates-page.ts */
export { FATES_PAGE };

/** 一年：换了电脑、清了浏览器数据才会再看到一次 */
const GUIDE_MAX_AGE = 365 * 24 * 3600;

/** 请求带的 cookie 里有没有「看过用法」的记号 */
export function guideSeen(cookieHeader: string | null | undefined): boolean {
  return (cookieHeader ?? "").split(";").some((part) => part.trim().startsWith(`${GUIDE_COOKIE}=`));
}

/** 地址是不是用法页自己（带不带参数都算） */
export function isGuidePath(href: string): boolean {
  return href === GUIDE_PATH || href.startsWith(`${GUIDE_PATH}?`) || href.startsWith(`${GUIDE_PATH}#`);
}

/**
 * 登录成功以后跳去哪：没看过用法的浏览器先到用法页，原来要去的地址放进 next（本来就要去用法页的不再套一层）；看过的照旧回原地址。
 * next 必须已经过 safeNext 规整（lib/server/access.ts），这里不再检查。
 */
export function afterLoginTarget(next: string, seen: boolean): string {
  if (seen || isGuidePath(next)) return next;
  return `${GUIDE_PATH}?next=${encodeURIComponent(next)}`;
}

/** 「看过用法」的记号：只有服务端读，所以 HttpOnly；https 时带 Secure */
export function guideCookie(secure: boolean): string {
  return `${GUIDE_COOKIE}=1; Path=/; Max-Age=${GUIDE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** 「知道了，去……」按钮上写的页面名字（和顶栏导航上的一样；小实验加书名号）；认不出来的写「刚才的页面」 */
const PLACES: [prefix: string, name: string][] = [
  ["/workbench", "体检工作台"],
  ["/play", "打字闯关"],
  ["/suites", "用例库"],
  ["/runs", "运行记录"],
  ["/map", "攻防地图"],
  ["/settings", "原理"],
  [FATES_PAGE.href, `「${FATES_PAGE.name}」`],
  ["/compare", "前后对比"],
  ["/reports/", "体检单"],
];

export function placeName(href: string): string {
  const path = href.split(/[?#]/)[0];
  const hit = PLACES.find(([p]) =>
    p.endsWith("/") ? path.startsWith(p) && path.length > p.length : path === p || path.startsWith(`${p}/`),
  );
  return hit ? hit[1] : "刚才的页面";
}

/**
 * 用法页地址里的 next → 右上角「知道了，去……」按钮去哪、写什么。没带 next（从顶栏点进来）就没有这个按钮。
 * next 先过 safeNext（和登录页、登录接口同一个函数：只认本站路径，登录页、接口不算）；指回用法页自己的改成回工作台。
 */
export function continueTarget(raw: unknown): { href: string; name: string } | undefined {
  if (typeof raw !== "string") return undefined;
  const safe = safeNext(raw);
  const href = isGuidePath(safe) ? "/workbench" : safe;
  return { href, name: placeName(href) };
}
