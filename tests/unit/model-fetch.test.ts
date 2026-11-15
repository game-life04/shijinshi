// 3D 模型提前下载（lib/client/model-fetch.ts，ADR-049 复查）：同一个地址只下载一次；文件不在时带着状态码报错；失败了不记着。
// ADR-052：离开有形象的页面就暂停、已经下好的留着，回来带 Range、If-Range 接着下（下面第二组）。
import { afterEach, describe, expect, it, vi } from "vitest";

const load = async () => {
  vi.resetModules();
  return import("@/lib/client/model-fetch");
};
const ok = (bytes: number[]) => new Response(new Uint8Array(bytes), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe("fetchModel", () => {
  it("同一个地址只下载一次：提前下载和真正要用时拿到的是同一份数据", async () => {
    const fetchMock = vi.fn(async () => ok([1, 2, 3]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel } = await load();
    const early = fetchModel("/models/a.vrm");
    const later = fetchModel("/models/a.vrm");
    expect(later).toBe(early);
    expect(new Uint8Array(await later)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 和原来 GLTFLoader 的请求一样：只带同源凭据
    expect(fetchMock).toHaveBeenCalledWith("/models/a.vrm", expect.objectContaining({ credentials: "same-origin", priority: "low" }));
    // 下载完以后再要（换了一页）：还是这一份，不再发请求
    await fetchModel("/models/a.vrm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("换了地址重新下载", async () => {
    const fetchMock = vi.fn(async () => ok([1]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel } = await load();
    await fetchModel("/models/a.vrm");
    await fetchModel("/models/b.vrm");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("文件不在：报错带着 404（页面据此写「还没有放入 VRM 模型文件」）；失败了不记着，下次重新下载", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(ok([9]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel, ModelHttpError } = await load();
    const err = await fetchModel("/models/a.vrm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect((err as InstanceType<typeof ModelHttpError>).status).toBe(404);
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([9]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("登录过期被转到登录页（状态 200、内容是 HTML）：不当模型记下来，报错说明，下次重新下载", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>登录</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      )
      .mockResolvedValueOnce(ok([5]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel, ModelHttpError } = await load();
    const err = await fetchModel("/models/a.vrm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect((err as Error).message).toContain("不是模型文件");
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([5]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("下载下来却解析不了：forgetModel 以后重新下载；别的地址、已经重新下好的那一份不动", async () => {
    const fetchMock = vi.fn(async () => ok([1]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel, forgetModel } = await load();
    const bad = fetchModel("/models/a.vrm");
    await bad;
    forgetModel("/models/other.vrm", bad);
    await fetchModel("/models/a.vrm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    forgetModel("/models/a.vrm", bad);
    const fresh = fetchModel("/models/a.vrm");
    await fresh;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 另一处拿着旧的那一份也解析失败了：只清旧的，刚重新下好的不动
    forgetModel("/models/a.vrm", bad);
    expect(fetchModel("/models/a.vrm")).toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("网络断了：照样报错，下次重新下载", async () => {
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(ok([7]));
    vi.stubGlobal("fetch", fetchMock);
    const { fetchModel } = await load();
    await expect(fetchModel("/models/a.vrm")).rejects.toThrow("Failed to fetch");
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([7]));
  });
});

// ---------- 离开就暂停、回来接着下（ADR-052） ----------

/** 一份慢慢送来的回复：测试里一段一段地推字节；请求被停掉（signal）时它报错，和真的浏览器一样 */
function slow(init: RequestInit | undefined, o: { status?: number; headers?: Record<string, string> } = {}) {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  init?.signal?.addEventListener("abort", () => {
    try {
      ctrl.error(new DOMException("The operation was aborted.", "AbortError"));
    } catch {
      // 已经结束了
    }
  });
  return {
    res: new Response(o.status === 304 ? null : body, { status: o.status ?? 200, headers: o.headers }),
    push: (b: number[]) => ctrl.enqueue(new Uint8Array(b)),
    close: () => ctrl.close(),
    fail: (e: unknown) => ctrl.error(e),
  };
}

/** 等流里的字节被读完（流、Promise 都要走几轮） */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

const LM = "Fri, 06 Nov 2026 15:57:36 GMT";
type Part = ReturnType<typeof slow>;

/** 假的 fetch：第 n 次请求用 plan[n] 回（给 init 看是不是被停了），记下每次的 init */
function fakeFetch(plan: ((init: RequestInit | undefined) => Part | Promise<Response>)[]) {
  const inits: (RequestInit | undefined)[] = [];
  const parts: Part[] = [];
  const fn = vi.fn(async (_u: string, init?: RequestInit) => {
    inits.push(init);
    const step = plan[Math.min(inits.length - 1, plan.length - 1)](init);
    if (step instanceof Promise) return step;
    parts.push(step);
    return step.res;
  });
  vi.stubGlobal("fetch", fn);
  return { fn, inits, parts };
}

/** 浏览器的缓存存储：按地址存一份回复 */
function fakeCaches() {
  const store = new Map<string, Response>();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (url: string) => store.get(url)?.clone(),
      put: async (url: string, res: Response) => {
        store.set(url, res);
      },
      delete: async (url: string) => store.delete(url),
    }),
  });
  return store;
}

describe("离开就暂停、回来接着下（ADR-052）", () => {
  afterEach(() => vi.useRealTimers());
  const useTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("最后一个形象离开 0.3 秒后停掉请求，已经下好的留着；回来带 Range、If-Range 接着下，拼成整份", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM, "content-length": "6" } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 3-5/6" } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    const data = fetchModel("/models/a.vrm");
    let got: ArrayBuffer | null = null;
    void data.then((b) => {
      got = b;
    });
    await settle();
    f.parts[0].push([1, 2, 3]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS - 1);
    expect(f.inits[0]?.signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(f.inits[0]?.signal?.aborted).toBe(true);
    await settle();
    // 停着：数据没兑现，也不算失败
    expect(got).toBeNull();
    holdModel("/models/a.vrm");
    await settle();
    expect(f.fn).toHaveBeenCalledTimes(2);
    // 第一次照常走浏览器的 HTTP 缓存；续的那一次从第 3 个字节接着下，带着最后修改时间核对，不进缓存
    expect(f.inits[0]?.cache).toBeUndefined();
    expect(f.inits[0]?.headers).toBeUndefined();
    expect(f.inits[1]?.headers).toEqual({ Range: "bytes=3-", "If-Range": LM });
    expect(f.inits[1]?.cache).toBe("no-store");
    f.parts[1].push([4, 5, 6]);
    f.parts[1].close();
    expect(new Uint8Array(await data)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("0.3 秒内又有形象出来（换页时先卸后装）：不停", async () => {
    useTimers();
    const f = fakeFetch([(i) => slow(i)]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS / 2);
    holdModel("/models/a.vrm");
    vi.advanceTimersByTime(PAUSE_GRACE_MS * 2);
    expect(f.inits[0]?.signal?.aborted).toBe(false);
    f.parts[0].push([1]);
    f.parts[0].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1]));
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it("回来时服务器给的是整份（文件换过了、不认续传）：续传请求发了，回 200 就前面下的不要、从头来", async () => {
    useTimers();
    const f = fakeFetch([(i) => slow(i, { headers: { "last-modified": LM } })]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    await settle();
    expect(f.inits[1]?.headers).toEqual({ Range: "bytes=2-", "If-Range": LM });
    f.parts[1].push([7, 8, 9]);
    f.parts[1].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([7, 8, 9]));
  });

  it("接的位置对不上（Content-Range 不是从已有的字节数开始）：这一段不要，马上从头下一次", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 0-5/6" } }),
      (i) => slow(i, { headers: { "last-modified": LM } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    await settle();
    expect(f.inits).toHaveLength(3);
    expect(f.inits[1]?.signal?.aborted).toBe(true);
    expect(f.inits[2]?.headers).toBeUndefined();
    f.parts[2].push([1, 2, 3, 4, 5, 6]);
    f.parts[2].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("停的那一下正好又有形象出来：马上接着下，不会一直停着", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 1-1/2" } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    // 请求刚停掉、还没收尾，形象又出来了
    holdModel("/models/a.vrm");
    await settle();
    expect(f.inits).toHaveLength(2);
    expect(f.inits[1]?.headers).toEqual({ Range: "bytes=1-", "If-Range": LM });
    f.parts[1].push([2]);
    f.parts[1].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2]));
  });

  it("整份是压缩送来的、下得太少就离开：续的原文比从头下还多，回来从头下（照常走缓存）", async () => {
    useTimers();
    const f = fakeFetch([(i) => slow(i, { headers: { "last-modified": LM, "content-encoding": "gzip" } })]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2, 3]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    await settle();
    expect(f.inits[1]?.headers).toBeUndefined();
    expect(f.inits[1]?.cache).toBeUndefined();
    f.parts[1].push([1, 2, 3, 4]);
    f.parts[1].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("拿到回复以前就被停：回来不带 Range，照常走缓存", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => new Promise<Response>((_, rej) => i?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
      (i) => slow(i, { headers: { "last-modified": LM } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    await settle();
    expect(f.inits).toHaveLength(2);
    expect(f.inits[1]?.headers).toBeUndefined();
    expect(f.inits[1]?.cache).toBeUndefined();
    f.parts[0].push([5]);
    f.parts[0].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([5]));
  });

  it("半路断网：有形象占着就过 1 秒接着下（手里有字节就带 Range）；中间又下到字节重新数，连着 3 次都断才报错", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM, "content-length": "4" } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 1-3/4" } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 2-3/4" } }),
    ]);
    const { holdModel, fetchModel } = await load();
    holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1]);
    await settle();
    f.parts[0].fail(new TypeError("network error"));
    await settle();
    expect(f.inits).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    await settle();
    expect(f.inits[1]?.headers).toEqual({ Range: "bytes=1-", "If-Range": LM });
    // 又下到一个字节以后再断：重试次数从头数，还是 1 秒后接着下
    f.parts[1].push([2]);
    await settle();
    f.parts[1].fail(new TypeError("network error"));
    await settle();
    vi.advanceTimersByTime(1000);
    await settle();
    expect(f.inits[2]?.headers).toEqual({ Range: "bytes=2-", "If-Range": LM });
    f.parts[2].push([3, 4]);
    f.parts[2].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("一直连不上：连着 3 次以后才报错（报的是原来的错）", async () => {
    useTimers();
    const f = fakeFetch([() => Promise.reject(new TypeError("Failed to fetch"))]);
    const { holdModel, fetchModel } = await load();
    holdModel("/models/a.vrm");
    const data = fetchModel("/models/a.vrm");
    let err: unknown = null;
    data.catch((e: unknown) => {
      err = e;
    });
    for (let k = 1; k <= 3; k++) {
      await settle();
      expect(err).toBeNull();
      vi.advanceTimersByTime(1000 * k);
    }
    await settle();
    expect(f.fn).toHaveBeenCalledTimes(4);
    expect((err as Error).message).toBe("Failed to fetch");
  });

  it("知道总长的、读完了却不够长（Safari 会把半路断掉的当成读完了）：当成断网，接着下", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM, "content-length": "4" } }),
      (i) => slow(i, { status: 206, headers: { "content-range": "bytes 2-3/4" } }),
    ]);
    const { holdModel, fetchModel } = await load();
    holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2]);
    f.parts[0].close();
    await settle();
    vi.advanceTimersByTime(1000);
    await settle();
    expect(f.inits[1]?.headers).toEqual({ Range: "bytes=2-", "If-Range": LM });
    f.parts[1].push([3, 4]);
    f.parts[1].close();
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("续的时候回 416、文件总长就是已有的（停的那一下刚好读完）：直接拼起来，不再下", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM } }),
      (i) => slow(i, { status: 416, headers: { "content-range": "bytes */2" } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS } = await load();
    const release = holdModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2]));
    expect(f.inits).toHaveLength(2);
  });

  it("续的时候被转到登录页（200、内容是 HTML）：报错，不当模型拼进去", async () => {
    useTimers();
    const f = fakeFetch([
      (i) => slow(i, { headers: { "last-modified": LM } }),
      (i) => slow(i, { headers: { "content-type": "text/html; charset=utf-8" } }),
    ]);
    const { holdModel, fetchModel, PAUSE_GRACE_MS, ModelHttpError } = await load();
    const release = holdModel("/models/a.vrm");
    const data = fetchModel("/models/a.vrm");
    await settle();
    f.parts[0].push([1, 2]);
    await settle();
    release();
    vi.advanceTimersByTime(PAUSE_GRACE_MS);
    await settle();
    holdModel("/models/a.vrm");
    const err = await data.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect((err as Error).message).toContain("不是模型文件");
  });

  it("占着的下载出了真错（404）：是失败不是暂停，放开时不计时；占着的数照旧，再占着从头下", async () => {
    useTimers();
    const f = fakeFetch([
      () => Promise.resolve(new Response("not found", { status: 404 })),
      (i) => slow(i, { headers: { "last-modified": LM } }),
    ]);
    const { holdModel, fetchModel, ModelHttpError } = await load();
    const release = holdModel("/models/a.vrm");
    const err = await fetchModel("/models/a.vrm").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect(vi.getTimerCount()).toBe(0);
    // 3D 那边重新要一次（新的一次下载）：页面上还占着，离开这一页时照样会停
    const again = fetchModel("/models/a.vrm");
    await settle();
    expect(f.inits).toHaveLength(2);
    release();
    expect(vi.getTimerCount()).toBe(1);
    vi.runAllTimers();
    expect(f.inits[1]?.signal?.aborted).toBe(true);
    again.catch(() => {});
  });

  it("下完了以后离开、回来：不再请求", async () => {
    const fetchMock = vi.fn(async () => ok([1, 2]));
    vi.stubGlobal("fetch", fetchMock);
    const { holdModel, fetchModel } = await load();
    const release = holdModel("/models/a.vrm");
    expect(new Uint8Array(await fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2]));
    release();
    holdModel("/models/a.vrm");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("下完的存进缓存存储，下次先问变没变（ADR-052 复查）", () => {
  it("下完存一份；下次打开网站（模块重新加载）先带 If-Modified-Since 问，304 就用存着的", async () => {
    const store = fakeCaches();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "last-modified": LM } })),
    );
    const first = await load();
    await first.fetchModel("/models/a.vrm");
    await settle();
    expect(store.has("/models/a.vrm")).toBe(true);
    // 下次打开网站：模块里没记着，缓存存储里有
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        inits.push(init);
        return new Response(null, { status: 304 });
      }),
    );
    const second = await load();
    expect(new Uint8Array(await second.fetchModel("/models/a.vrm"))).toEqual(new Uint8Array([1, 2, 3]));
    expect(inits).toHaveLength(1);
    expect(inits[0]?.headers).toEqual({ "If-Modified-Since": LM });
    expect(inits[0]?.cache).toBe("no-store");
  });

  it("存着的那一份过期了（服务器回 200）：用新的，并换掉存着的；解析不了的连存着的一起删", async () => {
    const store = fakeCaches();
    store.set("/models/a.vrm", new Response(new Uint8Array([1]), { headers: { "last-modified": LM } }));
    const NEW = "Sat, 14 Nov 2026 10:00:00 GMT";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([9, 9]), { status: 200, headers: { "last-modified": NEW } })),
    );
    const { fetchModel, forgetModel } = await load();
    const data = fetchModel("/models/a.vrm");
    expect(new Uint8Array(await data)).toEqual(new Uint8Array([9, 9]));
    await settle();
    expect(store.get("/models/a.vrm")?.headers.get("last-modified")).toBe(NEW);
    forgetModel("/models/a.vrm", data);
    await settle();
    expect(store.has("/models/a.vrm")).toBe(false);
  });
});
