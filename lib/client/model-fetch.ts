// 3D 模型（约 3.8 MB）提前下载：页面能用以后由 Avatar 发一个普通的 fetch，下载好的数据（一份 ArrayBuffer）记在这里，
// VrmAvatar 等 three.js 那几个脚本到了以后直接拿来解析（GLTFLoader.parseAsync），整个模型只下载一次（ADR-049 复查）。
// 原来用 <link rel="preload" as="fetch">（ADR-043，ADR-045 挪到页面能用以后）让 GLTFLoader 的请求去复用：
// 快线路上没问题，可线上跨境线路慢（约 150 KB/s），three.js 下载完、GLTFLoader 发出请求以前，浏览器就在控制台报
// 「预加载了但几秒内没用上」；更早还有一个 HEAD 探测和它对不上，报「请求方法不一样」。自己 fetch 就没有「配不配得上」这回事，
// 文件不在时也直接看状态码。
// 记着的这一份换页以后照样用（不再下载）；下载失败、拿到的不是模型（比如登录过期被转到登录页）、解析不了的都不记，下次重新下载。

/** 模型文件请求失败：带着状态码（404 就是还没放模型文件） */
export class ModelHttpError extends Error {
  constructor(
    readonly status: number,
    message = `模型文件请求失败（HTTP ${status}）`,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

let cached: { url: string; data: Promise<ArrayBuffer> } | null = null;

/**
 * 下载模型（同一个地址只下载一次；失败了不记着，下次重新下载）。
 * 和原来 GLTFLoader 的请求一样：同源、带同源凭据（登录以后的会话 cookie）。
 */
export function fetchModel(url: string): Promise<ArrayBuffer> {
  if (cached?.url === url) return cached.data;
  const data = fetch(url, { credentials: "same-origin" }).then((res) => {
    if (!res.ok) throw new ModelHttpError(res.status);
    // 登录过期时门禁把请求转到登录页，拿到的是一页 HTML（状态 200）：不能当模型记下来
    if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
      throw new ModelHttpError(res.status, "拿到的不是模型文件（可能要重新登录）");
    }
    return res.arrayBuffer();
  });
  const entry = { url, data };
  cached = entry;
  data.catch(() => {
    if (cached === entry) cached = null;
  });
  return data;
}

/** 这份数据解析不了（下载坏了）：别记着，下次重新下载。只清解析失败的那一份：中间已经重新下好的不动 */
export function forgetModel(url: string, data: Promise<ArrayBuffer>): void {
  if (cached?.url === url && cached.data === data) cached = null;
}
