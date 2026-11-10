// 真实接口路径上的时序逻辑（用假的 fetch 模拟百炼的流式返回，不调用真实接口）：
//   护栏读到「不违规」就放行、剩下的输出在后台读完并记入用量；违规时照旧读完整个 JSON 核对原话；
//   语音合成第一块迟迟不来时中止并重试一次，两次都卡住就报错（ADR-020）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioStore } from "@/lib/server/audio-store";
import { checkSentence, EARLY_PASS, FALLBACK } from "@/lib/server/guard";
import { chatJSON, fallbackModelFor, ProviderBlockedError, UpstreamError, UsageMeter } from "@/lib/server/llm";
import { clearFixedCache, registerFixedTexts, SPEAKABLE, synthesize } from "@/lib/server/tts";

const enc = new TextEncoder();
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (content: string) => sse({ choices: [{ delta: { content } }] });

/** 一个可以手动推进的流式响应：push 推一段，end 结束；调用方中止时流报错 */
function controlledResponse(signal?: AbortSignal) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      signal?.addEventListener("abort", () => c.error(signal.reason ?? new Error("aborted")), { once: true });
    },
  });
  return {
    response: new Response(body, { status: 200 }),
    push: (b: Uint8Array) => ctl.enqueue(b),
    end: () => ctl.close(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("护栏提前放行", () => {
  it("开头的形状判断：只有 violate 写在最前、值是 false 才算", () => {
    expect(EARLY_PASS.test('{"violate": false,')).toBe(true);
    expect(EARLY_PASS.test(' { "violate":false}')).toBe(true);
    expect(EARLY_PASS.test('{"violate": false')).toBe(false); // 还没读到分隔符，可能是 falsey 之类
    expect(EARLY_PASS.test('{"violate": true,')).toBe(false);
    expect(EARLY_PASS.test('{"rule": "none", "violate": false,')).toBe(false); // 顺序不同就读完整个 JSON
  });

  it("读到不违规立刻放行，不等理由写完；剩下的输出在后台读完，用量记全", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const r = controlledResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => r.response),
    );
    const meter = new UsageMeter(10);
    r.push(delta('{"violate": false, "rule"'));
    const decision = await checkSentence(
      "我平时喜欢看书。",
      { history: [{ role: "user", text: "你喜欢做什么？" }], canary: "QYT-ABC123" },
      meter,
    );
    expect(decision).toMatchObject({ ok: true, early: true }); // 理由和用量都还没到，判定已经出来了
    expect(meter.usage.completion_tokens).toBe(0);
    r.push(delta(': "none", "quote": "", "reason": "正常回答"}'));
    r.push(sse({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 25 } }));
    r.push(enc.encode("data: [DONE]\n\n"));
    r.end();
    await meter.drain();
    expect(meter.usage).toEqual({ llm_calls: 1, prompt_tokens: 300, completion_tokens: 25 });
    expect(await decision.late).toBeNull(); // 后台读完的完整判定和开头一致
  });

  it("提前放行后核对完整判定：键重复导致最后是违规时，记下不一致供复核（ADR-022）", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const r = controlledResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => r.response),
    );
    r.push(delta('{"violate": false, "rule": "identity", "quote": "", "reason": "x", "violate": true}'));
    r.push(enc.encode("data: [DONE]\n\n"));
    r.end();
    const decision = await checkSentence(
      "我平时喜欢看书。",
      { history: [{ role: "user", text: "你喜欢做什么？" }], canary: "QYT-ABC123" },
      new UsageMeter(10),
    );
    expect(decision.ok).toBe(true);
    expect(await decision.late).toContain("完整判定是违规");
  });

  it("护栏检查服务出错：按不放行处理，记为「检查失败」，兜底句是中性的一句，不冒充身份说明", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("GUARD_HEDGE_MS", "0");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream down", { status: 500 })),
    );
    const decision = await checkSentence(
      "今天天气不错。",
      { history: [{ role: "user", text: "天气怎么样" }], canary: "QYT-ABC123" },
      new UsageMeter(10),
    );
    expect(decision.ok).toBe(false);
    expect(decision.hit?.rule).toBe("unavailable");
    expect(FALLBACK.unavailable).not.toMatch(/AI|真人/);
  });

  it("模型判违规时读完整个 JSON，摘出的原话在句子里才拦", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const r = controlledResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => r.response),
    );
    r.push(delta('{"violate": true, "rule": "identity", '));
    r.push(delta('"quote": "我和你一样有血有肉", "reason": "暗示自己是真人"}'));
    r.push(enc.encode("data: [DONE]\n\n"));
    r.end();
    const decision = await checkSentence(
      "放心吧，我和你一样有血有肉的。",
      { history: [{ role: "user", text: "你是真人吗？" }], canary: "QYT-ABC123" },
      new UsageMeter(10),
    );
    expect(decision.ok).toBe(false);
    expect(decision.hit).toMatchObject({ rule: "identity", by: "model" });
    expect(decision.hit?.reason).toContain("我和你一样有血有肉");
  });

  it("第一次请求迟迟不判：过一会儿并行再问一次，用先判完的那次", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("GUARD_HEDGE_MS", "50");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls++;
        const r = controlledResponse(init?.signal ?? undefined);
        if (calls === 2) r.push(delta('{"violate": false, "rule": "none"'));
        return r.response; // 第一次：连上了但一直不出字
      }),
    );
    const t0 = performance.now();
    const decision = await checkSentence(
      "我平时喜欢看书。",
      { history: [{ role: "user", text: "你喜欢做什么？" }], canary: "QYT-ABC123" },
      new UsageMeter(10),
    );
    expect(decision).toMatchObject({ ok: true, early: true });
    expect(calls).toBe(2);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("真实语音合成的超时与重试", () => {
  const audioEvent = (samples: number[]) =>
    sse({ output: { audio: { data: Buffer.from(new Int16Array(samples).buffer).toString("base64") } } });

  it("只有颜文字或标点的一句不送去合成，按无声处理", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(SPEAKABLE.test("（*^▽^*）")).toBe(false);
    expect(SPEAKABLE.test("(｡･ω･｡)～")).toBe(false);
    expect(SPEAKABLE.test("好呀（*^▽^*）")).toBe(true);
    const s = synthesize("（*^▽^*）");
    const got: Int16Array[] = [];
    for await (const c of s.chunks) got.push(c);
    expect(got).toEqual([]);
    expect(s.totalSamples).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("固定句子（兜底句）合成过一次就走缓存：第二次不调接口、不计字数；角色自己的话照常现合成（ADR-043）", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    clearFixedCache();
    registerFixedTexts([FALLBACK.exit]);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        const r = controlledResponse();
        r.push(audioEvent([7, -7]));
        r.push(audioEvent([9]));
        r.end();
        return r.response;
      }),
    );
    const read = async (s: ReturnType<typeof synthesize>) => {
      const got: number[] = [];
      for await (const c of s.chunks) got.push(...c);
      return got;
    };
    const first = synthesize(FALLBACK.exit);
    expect(first.cached).toBeUndefined();
    expect(await read(first)).toEqual([7, -7, 9]);
    const second = synthesize(FALLBACK.exit);
    expect(second.cached).toBe(true);
    expect(second.totalSamples).toBe(3);
    expect(await read(second)).toEqual([7, -7, 9]);
    expect(calls).toBe(1);
    // 不是登记过的固定句子：每次都现合成
    await read(synthesize("这是她自己说的一句话。"));
    await read(synthesize("这是她自己说的一句话。"));
    expect(calls).toBe(3);
    // 语音缓存只给没走缓存的句子计字数
    const store = new AudioStore();
    store.prepare("u1", FALLBACK.exit);
    expect(store.chars).toBe(0);
    store.clear();
    clearFixedCache();
  });

  it("合成接口明确拒绝（参数不对等）：不重试，直接报错", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        const r = controlledResponse();
        r.push(sse({ code: "InvalidParameter", message: "Due to invalid text, invalid audio was returned." }));
        r.end();
        return r.response;
      }),
    );
    const run = async () => {
      for await (const _ of synthesize("你好。").chunks) {
      }
    };
    await expect(run()).rejects.toThrow(/InvalidParameter/);
    expect(calls).toBe(1);
  });

  it("第一块迟迟不来：中止后重试一次，第二次正常出声", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("TTS_FIRST_CHUNK_TIMEOUT_MS", "60");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls++;
        const r = controlledResponse(init?.signal ?? undefined);
        if (calls === 2) {
          r.push(audioEvent([100, -100, 200]));
          r.end();
        } // 第一次：只连上，不送声音
        return r.response;
      }),
    );
    const got: number[] = [];
    for await (const c of synthesize("你好呀。").chunks) got.push(...c);
    expect(calls).toBe(2);
    expect(got).toEqual([100, -100, 200]);
  });

  it("两次都卡住：报「没送来第一段声音」，不会让调用方一直等", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("TTS_FIRST_CHUNK_TIMEOUT_MS", "60");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => controlledResponse(init?.signal ?? undefined).response),
    );
    const t0 = performance.now();
    const run = async () => {
      for await (const _ of synthesize("你好呀。").chunks) {
      }
    };
    await expect(run()).rejects.toThrow(UpstreamError);
    await expect(run()).rejects.toThrow(/没送来第一段声音/);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("已经出过声以后断流：按「后续声音」超时报错，不重试（避免重复播放）", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("TTS_IDLE_TIMEOUT_MS", "60");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls++;
        const r = controlledResponse(init?.signal ?? undefined);
        r.push(audioEvent([1, 2]));
        return r.response;
      }),
    );
    const got: number[] = [];
    const run = async () => {
      for await (const c of synthesize("你好呀。").chunks) got.push(...c);
    };
    await expect(run()).rejects.toThrow(/没送来后续声音/);
    expect(calls).toBe(1);
    expect(got).toEqual([1, 2]);
  });
});

describe("备用模型（ADR-043）", () => {
  const okJSON = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), {
      status: 200,
    });
  const isOk = (x: unknown): x is { ok: boolean } => typeof x === "object" && x !== null && "ok" in x;

  it("设了备用模型：主模型 503 时换备用模型再试一次，记一次换模型、多算一次调用", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("JUDGE_FALLBACK_MODEL", "backup-model");
    const models: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        models.push(JSON.parse(String(init?.body)).model);
        return models.length === 1 ? new Response("服务暂时不可用", { status: 503 }) : okJSON('{"ok": true}');
      }),
    );
    const meter = new UsageMeter(10);
    const { value } = await chatJSON("judge", [{ role: "user", content: "判一下" }], isOk, meter);
    expect(value.ok).toBe(true);
    expect(models).toEqual(["qwen-plus", "backup-model"]);
    expect(meter.usage.llm_calls).toBe(2);
    expect(meter.usage.fallback_calls).toBe(1);
    // 按模型分开记用量：失败的那次没有用量，备用模型那次记 1 次调用和它的 token（算单次成本用）
    expect(meter.byModel).toEqual({ "backup-model": { calls: 1, prompt_tokens: 3, completion_tokens: 2 } });
  });

  it("限流也换；平台审核拦截、请求不合规（400）不换；没设备用模型时照旧报错", async () => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    vi.stubEnv("GUARD_FALLBACK_MODEL", "backup-model");
    const respond = (first: Response) => {
      const models: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          models.push(JSON.parse(String(init?.body)).model);
          return models.length === 1 ? first : okJSON('{"ok": true}');
        }),
      );
      return models;
    };
    let models = respond(new Response("Throttling", { status: 429 }));
    await chatJSON("guard", [{ role: "user", content: "x" }], isOk, new UsageMeter(10));
    expect(models).toEqual(["qwen-flash", "backup-model"]);

    models = respond(new Response('{"code":"DataInspectionFailed"}', { status: 400 }));
    await expect(chatJSON("guard", [{ role: "user", content: "x" }], isOk, new UsageMeter(10))).rejects.toBeInstanceOf(
      ProviderBlockedError,
    );
    expect(models).toEqual(["qwen-flash"]);

    models = respond(new Response("bad request", { status: 400 }));
    await expect(chatJSON("guard", [{ role: "user", content: "x" }], isOk, new UsageMeter(10))).rejects.toBeInstanceOf(UpstreamError);
    expect(models).toEqual(["qwen-flash"]);

    vi.stubEnv("GUARD_FALLBACK_MODEL", "");
    expect(fallbackModelFor("guard")).toBeUndefined();
    models = respond(new Response("服务暂时不可用", { status: 503 }));
    const meter = new UsageMeter(10);
    await expect(chatJSON("guard", [{ role: "user", content: "x" }], isOk, meter)).rejects.toBeInstanceOf(UpstreamError);
    expect(models).toEqual(["qwen-flash"]);
    expect(meter.usage.fallback_calls).toBeUndefined();
  });
});
