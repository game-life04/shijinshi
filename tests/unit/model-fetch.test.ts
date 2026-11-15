// 3D 模型提前下载（lib/client/model-fetch.ts，ADR-049 复查）：同一个地址只下载一次；文件不在时带着状态码报错；失败了不记着。
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
    expect(fetchMock).toHaveBeenCalledWith("/models/a.vrm", { credentials: "same-origin", priority: "low" });
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
