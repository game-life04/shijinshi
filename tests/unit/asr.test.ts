// 服务端语音转文字（ADR-054）：认 WAV 头、模拟模式回写好的一句、接真实模型时怎么调阿里云百炼、出错怎么说。不联网（fetch 是假的）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWav } from "@/lib/client/wav";
import { ASR_MAX_BYTES, AsrError, asrAvailable, SIM_TEXT, transcribe, wavInfo } from "@/lib/server/asr";

const seconds = (s: number) => encodeWav(new Float32Array(Math.round(16000 * s)).fill(0.1), 16000);
const KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "ASR_BASE_URL", "ASR_MODEL"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("认 WAV 头", () => {
  it("16 位单声道 PCM 认得出采样率和秒数；别的格式不认", () => {
    expect(wavInfo(seconds(2))).toEqual({ rate: 16000, seconds: 2 });
    expect(wavInfo(new Uint8Array(10))).toBeNull();
    const stereo = seconds(1);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(wavInfo(stereo)).toBeNull();
    const notWav = seconds(1);
    notWav[8] = 0x41;
    expect(wavInfo(notWav)).toBeNull();
  });
});

describe("模拟模式（没配密钥）", () => {
  it("不调用任何接口，回写好的那一句，标明是模拟的", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(asrAvailable()).toBe(false);
    await expect(transcribe(seconds(1.5))).resolves.toMatchObject({ text: SIM_TEXT, simulated: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("太短当没说话；太长、不是 WAV 直接拒", async () => {
    await expect(transcribe(seconds(0.1))).resolves.toMatchObject({ text: "" });
    await expect(transcribe(new Uint8Array(ASR_MAX_BYTES + 1))).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(new Uint8Array(100))).rejects.toBeInstanceOf(AsrError);
    await expect(transcribe(new Uint8Array(100))).rejects.toMatchObject({ status: 400 });
  });
});

describe("接真实模型（阿里云百炼）", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
  });

  it("发给 qwen3-asr-flash：OpenAI 兼容接口，音频放在 input_audio 里（data:audio/wav;base64），按中文认；回来的字收拾一下", async () => {
    const box: { sent?: { url: string; body: Record<string, unknown>; auth: string } } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        box.sent = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") ?? "" };
        return Response.json({ choices: [{ message: { content: "  我最近情绪\n有一点不好  " } }] });
      }),
    );
    expect(asrAvailable()).toBe(true);
    await expect(transcribe(seconds(2))).resolves.toEqual({ text: "我最近情绪 有一点不好", simulated: false, seconds: 2 });
    expect(box.sent?.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(box.sent?.auth).toBe("Bearer test-key");
    const body = box.sent?.body as {
      model: string;
      messages: { content: { type: string; input_audio: { data: string } }[] }[];
      asr_options: unknown;
    };
    expect(body.model).toBe("qwen3-asr-flash");
    expect(body.messages[0].content[0].type).toBe("input_audio");
    expect(body.messages[0].content[0].input_audio.data.startsWith("data:audio/wav;base64,UklGR")).toBe(true);
    expect(body.asr_options).toEqual({ language: "zh", enable_itn: true });
  });

  it("模型可以用 ASR_MODEL 换；接口不是阿里云百炼时不调用，说服务器没接语音识别", async () => {
    process.env.ASR_MODEL = "paraformer-x";
    const fetchSpy = vi.fn(async () => Response.json({ choices: [{ message: { content: "好" } }] }));
    vi.stubGlobal("fetch", fetchSpy);
    await transcribe(seconds(1));
    expect(JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body)).model).toBe("paraformer-x");
    process.env.LLM_BASE_URL = "https://api.example.com/v1";
    expect(asrAvailable()).toBe(false);
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 503 });
  });

  it("限流、额度不够：429，说过一会儿再说；别的错、连不上：502，说再说一次或者打字", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Throttling.RateQuota", { status: 429 })),
    );
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 429, message: expect.stringContaining("太忙") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 502, message: expect.stringContaining("再说一次") });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 502, message: expect.stringContaining("没连上") });
  });

  it("出错的说法里不带密钥、不带接口回来的原文", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("InvalidApiKey: test-key is wrong", { status: 401 })),
    );
    const e = await transcribe(seconds(1)).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain("test-key");
    expect(String((e as Error).message)).not.toContain("InvalidApiKey");
  });
});
