// 上线演示的门禁（ADR-028）：设了 ACCESS_CODE 时，除了登录页和构建出的静态文件，页面、接口、模型文件都要先登录。
// 没设 ACCESS_CODE（本机开发、评委在自己电脑上运行）时什么都不拦。限流在各个接口里做（lib/server/access.ts）。

import { type NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, accessCode, verifyAccess } from "@/lib/server/access";

export function proxy(request: NextRequest) {
  const code = accessCode();
  if (!code || verifyAccess(code, request.cookies.get(ACCESS_COOKIE)?.value)) return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "需要先输入访问码：请打开 /login" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // 登录页、登录接口、构建出的 JS/CSS 和网站图标不拦；public 里的模型、音频脚本要拦（页面同源请求会带上 cookie）
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/login).*)"],
};
