// 登录（11-06，ADR-032）：核对账号和密码，对了发签名 cookie、跳回原来要去的页面；不对、试得太频繁、配置有误，都带着原因跳回登录页。
// 用普通表单提交，不依赖页面脚本。服务器没配账号时不需要登录，直接跳回。
//   账号不存在、密码不对、账号名不合格式、密码超长，回的跳转地址一字不差，也都不发 cookie；账号不存在也照样算一次哈希，耗时一样。
//   限次数两道：同一来源每 10 分钟的尝试次数；同一账号名每 15 分钟输错的次数（不管从哪来、账号存不存在都照样计）。锁着的时候不算哈希。
//   不写登录日志；密码、cookie、账号记录、密钥一律不进日志。

import { loginLock, noteLoginFailure, rateLimit, safeNext } from "@/lib/server/access";
import { authConfig, isHttps, issueSession, normalizeAccount, openButNotLocal, sessionCookie } from "@/lib/server/auth";
import { crossSite } from "@/lib/server/http";
import { BusyError, normalizePassword, verifyPassword } from "@/lib/server/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 表单最多读这么多字节：账号最长 64、密码最长 256 个字，编码以后也远到不了 */
const MAX_BODY = 4096;
const MINUTE = 60_000;

/** 303：浏览器改用 GET 打开目标地址；相对地址由浏览器按当前网址补全 */
function seeOther(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** 边读边数，超过上限就不读了（请求头没写长度、或者写的长度不老实，都拦得住）；读坏了当空表单 */
async function readForm(req: Request): Promise<URLSearchParams | "too_large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY) return "too_large";
  if (!req.body) return new URLSearchParams();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return new URLSearchParams();
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / MINUTE));

export async function POST(req: Request) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return Response.json({ error: "登录只接受普通表单提交" }, { status: 415 });
  const form = await readForm(req);
  if (form === "too_large") return Response.json({ error: "提交的内容太长" }, { status: 413 });
  const next = safeNext(form.get("next"));
  const back = (error: string, retryMs?: number) =>
    seeOther(`/login?error=${error}${retryMs === undefined ? "" : `&retry=${minutes(retryMs)}`}&next=${encodeURIComponent(next)}`);
  const config = authConfig();
  // 没配账号不用登录，直接跳回；接了真实模型又不是从本机打开的除外（lib/server/auth.ts 的 openButNotLocal）
  if (config.mode === "open") return openButNotLocal(req.headers.get("host")) ? back("config") : seeOther(next);
  if (config.mode === "broken") return back("config");

  const rawAccount = form.get("account") ?? "";
  const rawPassword = form.get("password") ?? "";
  // 没填全不计次数、不算哈希
  if (!rawAccount.normalize("NFKC").trim() || !rawPassword) return back("missing");
  const limited = rateLimit(req, "login");
  if (limited) return back("limit", Number(limited.headers.get("Retry-After")) * 1000);
  const account = normalizeAccount(rawAccount);
  const password = normalizePassword(rawPassword);
  if (account) {
    const lock = loginLock(account);
    if (lock) return back("locked", lock.retryMs);
  }
  let ok: boolean;
  try {
    ok = await verifyPassword(password, account ? (config.accounts.get(account) ?? null) : null);
  } catch (e) {
    if (e instanceof BusyError) return back("busy");
    // 只记出错的种类，不带输入的内容
    console.error(`[登录] 核对密码时出错：${e instanceof Error ? e.message : String(e)}`);
    return back("config");
  }
  if (!ok || !account) {
    if (account) {
      noteLoginFailure(account);
      // 真有这个账号、刚好被锁住时记一行账号名，方便知道有人在猜；不存在的账号名不记（可能是把密码输进了账号框）
      const lock = config.accounts.has(account) ? loginLock(account) : null;
      if (lock) console.error(`[登录] 账号 ${account} 输错次数到了上限，锁 ${minutes(lock.retryMs)} 分钟`);
    }
    return back("auth");
  }
  const { value, maxAgeSeconds } = issueSession(account);
  return seeOther(next, sessionCookie(value, maxAgeSeconds, isHttps(req)));
}
