// 页面开着的时候会话失效了（cookie 到期、被改过、换了密码、删了账号，ADR-032），页面上的请求会回 401。
// 这时别只在页面上留一行「需要先登录」：带着当前地址跳到登录页，提示「登录已过期」，登录后回到原来的页面。
// 只有登录门禁会回 401（lib/server/auth.ts 的 authRequired），所以按状态码认就够了，不用读响应体。

/** 回了 401 就跳登录页并返回 true（调用方别再往下处理）；别的状态码返回 false */
export function toLoginIfExpired(status: number): boolean {
  if (status !== 401 || typeof window === "undefined") return false;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}&reason=expired`);
  return true;
}

/** 跳登录页时给调用方抛的错：页面跳走之前那一下，界面上显示的就是这句 */
export const EXPIRED_MESSAGE = "登录已过期，正在打开登录页……";
