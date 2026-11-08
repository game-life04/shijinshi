// 服务端组件读当前登录的账号（11-06，ADR-032）：自己用 cookies() 取 cookie、再核一遍签名，不信 proxy 加的请求头
// （matcher 排除的路径上 proxy 根本不跑，浏览器自己带的请求头会原样传到页面，可以伪造）。
// 必须无条件先调用 cookies()，页面因此改成按请求渲染。要是先判断「没配账号」就直接返回，构建时没配账号，
// 就会把「没登录」写死进构建出的静态页，线上配了账号，顶栏也显示不出账号。
// 用 React 的 cache 包着：同一次渲染里多处调用只核一次。

import { cookies } from "next/headers";
import { cache } from "react";
import { SESSION_COOKIE, type Session, verifySession } from "./auth";

export const getSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  return verifySession(jar.get(SESSION_COOKIE)?.value);
});
