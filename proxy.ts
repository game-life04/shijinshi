// 上线演示的门禁（11-06，ADR-032 账号登录，取代 ADR-028 的访问码）：配了账号时，除了登录页、登录和退出接口、构建出的静态文件，
// 页面、接口、模型文件都要先登录。没配账号（本机开发、评委在自己电脑上运行）时什么都不拦；
// 接了真实模型却不是从本机打开的例外，照样当配置有问题拦住（lib/server/auth.ts 的 openButNotLocal）。
// 配置写错了（auth.ts 的 broken）就全站拦住：接口回 503，页面跳到登录页说明「登录设置有问题」。
// 这里只是第一道：每个接口开头还会再核一次会话（requireSession），页面外框 AppShell 也自己核（lib/server/session.ts）。
// 限流在各个接口里做（lib/server/access.ts）。

import { type NextRequest, NextResponse } from "next/server";
import { authBroken, authConfig, authRequired, openButNotLocal, SESSION_COOKIE, sessionFromRequest } from "@/lib/server/auth";

// 不用登录的地址按完整路径放行。不写进 matcher：matcher 的排除是按前缀匹配的，以后加了 /login-xxx、/api/login-xxx
// 这样的地址，会悄悄漏在门外（11-06 安全复核）
const PUBLIC = new Set(["/login", "/api/login", "/api/logout"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();
  const api = pathname.startsWith("/api/");
  const config = authConfig();
  const misconfigured = () => (api ? authBroken() : NextResponse.redirect(new URL("/login?error=config", request.url)));
  if (config.mode === "open") return openButNotLocal(request.headers.get("host")) ? misconfigured() : NextResponse.next();
  if (config.mode === "broken") return misconfigured();
  if (sessionFromRequest(request)) return NextResponse.next();
  if (api) return authRequired();
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  // 带着 cookie 却没通过（过期、被改过、换了密码、删了账号），登录页提示「登录已过期」
  if (request.cookies.has(SESSION_COOKIE)) login.searchParams.set("reason", "expired");
  return NextResponse.redirect(login);
}

export const config = {
  // 只有构建出的 JS/CSS/图片（登录页背景图也在 /_next/static/media 下）和网站图标不经过这里；public 里的模型、音频脚本，
  // 还有 /_next/image（本站没用 next/image）都要过门禁（页面同源请求会带上 cookie）
  matcher: ["/((?!_next/static/|favicon\\.ico$).*)"],
};
