// 登录（ADR-028）：核对访问码，对了就发签名 cookie，跳回原来要去的页面；错了或试得太频繁，带着原因回登录页。
// 用普通表单提交，不依赖页面脚本。没设 ACCESS_CODE 时不需要登录，直接跳回。

import { ACCESS_COOKIE, accessCode, codeMatches, issueAccess, rateLimit, safeNext } from "@/lib/server/access";
import { crossSite } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 303：浏览器改用 GET 打开目标地址；相对地址由浏览器按当前网址补全 */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(req: Request) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const form = await req.formData().catch(() => null);
  const next = safeNext(form?.get("next"));
  const code = accessCode();
  if (!code) return seeOther(next);
  const back = (error: "code" | "limit") => seeOther(`/login?error=${error}&next=${encodeURIComponent(next)}`);
  if (rateLimit(req, "login")) return back("limit");
  if (!codeMatches(code, String(form?.get("code") ?? ""))) return back("code");
  const { value, maxAgeSeconds } = issueAccess(code);
  const https = new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  return seeOther(next, `${ACCESS_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${https ? "; Secure" : ""}`);
}
