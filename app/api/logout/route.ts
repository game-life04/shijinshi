// 退出登录（11-06，ADR-032）：清掉会话 cookie，回登录页并提示「已退出登录」。
// 只收 POST：GET 由 Next 回 405，免得链接预取把人登出；从别的网站提交的一律拒绝（不然别人能借着你的浏览器把你登出）。
// proxy 不拦这个接口：会话已经过期、被改过的人也要能退出、把 cookie 清掉。

import { authEnabled, clearSessionCookie, isHttps } from "@/lib/server/auth";
import { crossSite } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  // 没配账号时没有登录页可回，直接回工作台
  const headers = new Headers({ Location: authEnabled() ? "/login?bye=1" : "/workbench", "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearSessionCookie(isHttps(req)));
  return new Response(null, { status: 303, headers });
}
