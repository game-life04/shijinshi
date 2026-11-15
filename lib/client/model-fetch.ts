// 3D 模型（约 3.8 MB，线上 nginx 压缩后约 2.7 MB）提前下载：页面能用以后由 Avatar 开始下载，下载好的数据（一份 ArrayBuffer）记在这里，
// VrmAvatar 等 three.js 那几个脚本到了以后直接拿来解析（GLTFLoader.parseAsync），整个模型只下载一次（ADR-049 复查）。
// 原来用 <link rel="preload" as="fetch">（ADR-043，ADR-045 挪到页面能用以后）让 GLTFLoader 的请求去复用：
// 快线路上没问题，可线上跨境线路慢（约 150 KB/s），three.js 下载完、GLTFLoader 发出请求以前，浏览器就在控制台报
// 「预加载了但几秒内没用上」；更早还有一个 HEAD 探测和它对不上，报「请求方法不一样」。自己 fetch 就没有「配不配得上」这回事，
// 文件不在时也直接看状态码。
// 记着的这一份换页以后照样用（不再下载）；拿到的不是模型（比如登录过期被转到登录页）、文件不在、解析不了的都不记，下次重新下载。
//
// 离开就暂停、回来接着下（ADR-052，11-15 线上实测：浏览器在后台下模型时，跨境线路被占满，切到用例库、运行记录、攻防地图
// 这些没有形象的页面还要 6～10 秒才出来；ADR-051 标的低优先级只管什么时候开始下，开始以后照样占带宽）：
//   - 页面上有形象（Avatar）时占着下载（holdModel，按地址记有几个占着）；最后一个放开以后 0.3 秒还没有新的占着，就停掉这次请求，
//     已经下好的留着；
//   - 再有形象出来（或者 VrmAvatar 要数据），从停的地方接着下：带 Range: bytes=<已有>- 和 If-Range（文件的最后修改时间，没有就用 ETag），
//     服务器回 206 就接在后面，回 200（文件换过了）就从头来。线上 nginx 给整份下载做了压缩（约 0.68），续的那一段是不压缩的原文：
//     已经下好的不到 1.3 MB 时，续传要传的原文比从头下压缩的整份还多，就从头下（复查）；
//   - 半路断网、线路被重置：手里有字节就过一会儿接着下，最多 3 次；知道总长的，读完了先核对长度（Safari 会把半路断掉的分块响应当成读完了）；
//   - 下完的整份存进浏览器的缓存存储（Cache Storage）：续传、带条件的请求都不进浏览器的 HTTP 缓存（复查：原来被打断过一次的，
//     下次打开网站又要整份重下）。下次先问服务器文件变没变（If-Modified-Since），304 就直接用存着的；
//   - 线上核过（11-15，试用账号）：Range 请求回 206、Content-Range 总长 3990456；If-Range 带最后修改时间也是 206。

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

/** 读完了却不够长（Safari 会把半路断掉的分块响应当成读完了）：当成断网，接着下 */
class Interrupted extends Error {}

/** 最后一个形象离开以后，等这么久还没有新的形象出来，就暂停下载（同一次换页里先卸后装、开发时的重复挂载，都不停） */
export const PAUSE_GRACE_MS = 300;
/** 整份是压缩送来的时候，已经下好的（解压后的字节）少于这么多，续传不如从头下（3.99 MB 压到 2.7 MB，打平在 1.29 MB 左右） */
export const RESUME_MIN_BYTES = 1_300_000;
/** 半路断网连着最多接着下几次（每次多等 1 秒；中间又下到字节就重新数） */
export const MAX_RETRIES = 3;
/** 浏览器缓存存储里放模型的那一格 */
export const MODEL_CACHE = "fencun-model-v1";

interface Download {
  url: string;
  /** 整份数据：下完才兑现；暂停时一直等着，接着下完再兑现；出错时失败 */
  data: Promise<ArrayBuffer>;
  resolve: (b: ArrayBuffer) => void;
  reject: (e: unknown) => void;
  /** 已经下好的（解压后的字节） */
  chunks: Uint8Array[];
  received: number;
  /** 文件的最后修改时间（续传的 If-Range、存进缓存存储以后下次核对都用它） */
  lastModified?: string;
  etag?: string;
  /** 第一次整份是压缩送来的（续的那一段是原文，划不划算要比一比） */
  compressed: boolean;
  /** 原文总长：不压缩的整份看 Content-Length，续传看 Content-Range；压缩的整份不知道 */
  total?: number;
  /** 这次会话不再续传（回了 206 却读不到 Content-Range，比如模型放在别的域名、没暴露这个头） */
  noResume: boolean;
  /** 缓存存储已经查过、里面没有 */
  cacheMissed: boolean;
  retries: number;
  /** 正在下的那次请求；暂停了、下完了是 null */
  controller: AbortController | null;
  state: "running" | "paused" | "done" | "failed";
}

let current: Download | null = null;
/** 每个地址页面上有几个形象占着（按地址记：一次下载失败了重开，占着的数照旧，复查） */
const holders = new Map<string, number>();
const pauseTimers = new Map<string, ReturnType<typeof setTimeout>>();
const held = (url: string) => (holders.get(url) ?? 0) > 0;

function downloadFor(url: string): Download {
  if (current?.url === url) return current;
  let resolve!: (b: ArrayBuffer) => void;
  let reject!: (e: unknown) => void;
  const data = new Promise<ArrayBuffer>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // 没人等着的时候失败了也不算「未处理的拒绝」（谁要数据，谁拿到的还是这个失败）
  data.catch(() => {});
  const d: Download = {
    url,
    data,
    resolve,
    reject,
    chunks: [],
    received: 0,
    compressed: false,
    noResume: false,
    cacheMissed: false,
    retries: 0,
    controller: null,
    state: "paused",
  };
  current = d;
  return d;
}

/** 已经下好的不要了，下一次从头下 */
function restartFromScratch(d: Download) {
  d.chunks = [];
  d.received = 0;
  d.total = undefined;
}

function assemble(d: Download): ArrayBuffer {
  const all = new Uint8Array(d.received);
  let at = 0;
  for (const c of d.chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all.buffer;
}

/** 缓存存储里的那一份（以前下完存的）；没有、浏览器不让用（不是 https、隐私模式）都当没有 */
async function fromCache(url: string): Promise<{ buf: ArrayBuffer; lastModified: string } | null> {
  try {
    if (typeof caches === "undefined") return null;
    const hit = await (await caches.open(MODEL_CACHE)).match(url);
    const lastModified = hit?.headers.get("last-modified");
    if (!hit || !lastModified) return null;
    return { buf: await hit.arrayBuffer(), lastModified };
  } catch {
    return null;
  }
}

/** 下完的整份存进缓存存储（没有最后修改时间就没法核对，不存）；存不进去不要紧 */
function toCache(url: string, buf: ArrayBuffer, lastModified?: string) {
  if (!lastModified || typeof caches === "undefined") return;
  void caches
    .open(MODEL_CACHE)
    .then((c) =>
      c.put(url, new Response(buf.slice(0), { headers: { "last-modified": lastModified, "content-type": "application/octet-stream" } })),
    )
    .catch(() => {});
}

function complete(d: Download, buf: ArrayBuffer, store: boolean) {
  d.controller = null;
  d.chunks = [];
  d.state = "done";
  d.resolve(buf);
  if (store) toCache(d.url, buf, d.lastModified);
}

/** 开始或接着下（已经在下、下完了、失败了都不动） */
function run(d: Download) {
  if (d.state !== "paused") return;
  const ctl = new AbortController();
  d.controller = ctl;
  d.state = "running";
  void go(d, ctl).catch((e: unknown) => onError(d, ctl, e));
}

async function go(d: Download, ctl: AbortController) {
  const base: RequestInit = { credentials: "same-origin", priority: "low", signal: ctl.signal };
  // 1. 缓存存储里有整份：问服务器文件变没变，304 就直接用；200（换过了）照整份往下读
  if (d.received === 0 && !d.cacheMissed) {
    const hit = await fromCache(d.url);
    if (d.controller !== ctl) return;
    if (!hit) d.cacheMissed = true;
    else {
      const res = await fetch(d.url, { ...base, cache: "no-store", headers: { "If-Modified-Since": hit.lastModified } });
      if (d.controller !== ctl) return;
      if (res.status === 304) return complete(d, hit.buf, false);
      return consume(d, ctl, res, false);
    }
  }
  // 2. 续传还是从头下：压缩的整份下得太少时，续传的原文比从头下还多，不如从头下
  let resume = d.received > 0 && !d.noResume;
  if (resume && d.compressed && d.received < RESUME_MIN_BYTES) {
    restartFromScratch(d);
    resume = false;
  }
  const validator = d.lastModified ?? d.etag;
  const res = await fetch(
    d.url,
    resume
      ? { ...base, cache: "no-store", headers: { Range: `bytes=${d.received}-`, ...(validator ? { "If-Range": validator } : {}) } }
      : base,
  );
  if (d.controller !== ctl) return;
  return consume(d, ctl, res, resume);
}

/** 这一次请求不要了，马上从头再下一次（接的位置对不上、超出了文件） */
function again(d: Download, ctl: AbortController) {
  ctl.abort();
  restartFromScratch(d);
  d.controller = null;
  d.state = "paused";
  run(d);
}

async function consume(d: Download, ctl: AbortController, res: Response, resume: boolean) {
  if (resume && res.status === 206) {
    const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/.exec(res.headers.get("content-range") ?? "");
    // 读不到 Content-Range（模型放在别的域名、没暴露这个头）：这次会话不再续传，从头下
    if (!m) {
      d.noResume = true;
      return again(d, ctl);
    }
    // 接的位置要对得上：Content-Range 的开头就是已经有的字节数
    if (Number(m[1]) !== d.received) return again(d, ctl);
    if (m[2] !== "*") d.total = Number(m[2]);
  } else if (resume && res.status === 416) {
    // 已经下全了、只是还没来得及收尾（停的那一下刚好读完）：直接拼起来；别的情况从头下
    const n = Number(/bytes\s+\*\/(\d+)/.exec(res.headers.get("content-range") ?? "")?.[1]);
    if (n > 0 && n === d.received) return complete(d, assemble(d), true);
    return again(d, ctl);
  } else if (resume && res.status === 200) {
    // 服务器不认这一段（文件换过了，或者不支持续传），给的是整份：从头来
    restartFromScratch(d);
  } else if (!res.ok) {
    throw new ModelHttpError(res.status);
  }
  // 登录过期时门禁把请求转到登录页，拿到的是一页 HTML（状态 200）：不能当模型记下来
  if (/text\/html/i.test(res.headers.get("content-type") ?? "")) {
    throw new ModelHttpError(res.status, "拿到的不是模型文件（可能要重新登录）");
  }
  if (res.status === 200) {
    d.lastModified = res.headers.get("last-modified") ?? undefined;
    d.etag = res.headers.get("etag") ?? undefined;
    d.compressed = Boolean(res.headers.get("content-encoding"));
    const len = Number(res.headers.get("content-length"));
    d.total = !d.compressed && len > 0 ? len : undefined;
  }
  const push = (u: Uint8Array) => {
    d.chunks.push(u);
    d.received += u.byteLength;
    // 又下到字节了：断网重试的次数只算连着失败的
    d.retries = 0;
  };
  const reader = res.body?.getReader();
  if (!reader) push(new Uint8Array(await res.arrayBuffer()));
  else
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) push(value);
    }
  if (d.controller !== ctl) return;
  // 知道总长的，读完了先核对：不够长就是半路断了
  if (d.total !== undefined && d.received !== d.total) throw new Interrupted("模型没下全");
  complete(d, assemble(d), true);
}

function onError(d: Download, ctl: AbortController, e: unknown) {
  // 已经被下一次请求接手了（从头再下的那一次）：这一次的结果不管
  if (d.controller !== ctl) return;
  d.controller = null;
  // 暂停（离开了有形象的页面）：已经下好的留着，等下次接着下；data 一直等着，不算失败
  if (ctl.signal.aborted) {
    d.state = "paused";
    // 停的那一下正好又有形象出来了（占着的时候它看到还在下，没去续）：马上接着下
    if (held(d.url)) run(d);
    return;
  }
  // 半路断网、线路被重置、读完了不够长：页面上还有形象占着，就过一会儿接着下（手里有字节就续），最多 3 次
  if (!(e instanceof ModelHttpError) && d.retries < MAX_RETRIES && held(d.url)) {
    d.retries++;
    d.state = "paused";
    setTimeout(() => {
      if (d.state === "paused" && held(d.url)) run(d);
    }, 1000 * d.retries);
    return;
  }
  d.state = "failed";
  d.chunks = [];
  d.reject(e);
  if (current === d) current = null;
}

/**
 * 下载模型（同一个地址只下载一次；失败了不记着，下次重新下载）。暂停着的会接着下。
 * 和原来 GLTFLoader 的请求一样：同源、带同源凭据（登录以后的会话 cookie）。
 */
export function fetchModel(url: string): Promise<ArrayBuffer> {
  const d = downloadFor(url);
  run(d);
  return d.data;
}

/**
 * 页面上有形象：占着下载（没开始就开始，停着就接着下）。返回「放开」：最后一个形象放开以后 0.3 秒还没有新的占着，就暂停下载。
 */
export function holdModel(url: string): () => void {
  holders.set(url, (holders.get(url) ?? 0) + 1);
  clearTimeout(pauseTimers.get(url));
  run(downloadFor(url));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = Math.max(0, (holders.get(url) ?? 1) - 1);
    holders.set(url, n);
    if (n > 0) return;
    clearTimeout(pauseTimers.get(url));
    pauseTimers.set(
      url,
      setTimeout(() => {
        if (held(url)) return;
        const d = current;
        if (d?.url === url && d.state === "running") d.controller?.abort();
      }, PAUSE_GRACE_MS),
    );
  };
}

/** 这份数据解析不了（下载坏了）：别记着，下次重新下载；缓存存储里那一份也删掉。只清解析失败的那一份：中间已经重新下好的不动 */
export function forgetModel(url: string, data: Promise<ArrayBuffer>): void {
  if (current?.url === url && current.data === data) current = null;
  if (typeof caches !== "undefined")
    void caches
      .open(MODEL_CACHE)
      .then((c) => c.delete(url))
      .catch(() => {});
}
