// 接口共用的小工具（11-03 深度测试后加）：
//   readJsonObject：读 JSON 请求体，坏 JSON、null、数组都当成空对象，接口不会因为请求体形状不对而 500；
//   crossSite：改数据的接口只接受本站页面发来的请求。别的网站借着用户的浏览器发起体检、改判（跨站请求伪造），
//              浏览器会带上 Origin 和 Sec-Fetch-Site，这里一看到「跨站」就拒绝。命令行脚本不带这两个头，照常放行。

export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const raw: unknown = await req.json().catch(() => null);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function crossSite(req: Request): Response | null {
  const reject = () => Response.json({ error: "只接受本站页面发来的请求" }, { status: 403 });
  if (req.headers.get("sec-fetch-site") === "cross-site") return reject();
  const origin = req.headers.get("origin");
  if (!origin) return null;
  try {
    if (new URL(origin).host === req.headers.get("host")) return null;
  } catch {
    // Origin 不是合法地址
  }
  return reject();
}
