// 服务端语音转文字（ADR-054）：认 WAV 头、认 WebM（Opus）有多长、模拟模式回写好的一句、接真实模型时怎么调阿里云百炼、
// 出错怎么说、记什么日志。不联网（fetch 是假的）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWav } from "@/lib/client/wav";
import { ASR_MAX_BYTES, ASR_MAX_WEBM_BYTES, AsrError, asrAvailable, SIM_TEXT, transcribe, wavInfo } from "@/lib/server/asr";
import { opusPacketMs, webmOpusSeconds } from "@/lib/server/webm";

const seconds = (s: number) => encodeWav(new Float32Array(Math.round(16000 * s)).fill(0.1), 16000);
const KEYS = ["LLM_API_KEY", "LLM_BASE_URL", "ASR_BASE_URL", "ASR_MODEL", "ASR_API_KEY"] as const;

/**
 * 拼一段最小的 WebM（Opus）：EBML 头（文档类型 webm）；Segment、Cluster 不写长度（和浏览器边录边写一样）；
 * 轨道写 A_OPUS；n 个块，每块一个 Opus 包（toc 默认 0xf8：CELT 全频带、20 毫秒一帧、一帧）
 */
function webm(n: number, o: { toc?: number; codec?: string; lace?: boolean; clusters?: number } = {}): Uint8Array {
  const size = (k: number) => (k < 127 ? [0x80 | k] : [0x40 | (k >> 8), k & 0xff]);
  const el = (id: number[], body: number[]) => [...id, ...size(body.length), ...body];
  const ascii = (t: string) => [...Buffer.from(t, "latin1")];
  const unknown = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const out = [
    ...el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii("webm"))),
    ...[0x18, 0x53, 0x80, 0x67, ...unknown],
    ...el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0x86], ascii(o.codec ?? "A_OPUS")))),
  ];
  const clusters = o.clusters ?? 1;
  for (let c = 0; c < clusters; c++) {
    out.push(0x1f, 0x43, 0xb6, 0x75, ...unknown, ...el([0xe7], [c]));
    for (let i = 0; i < n / clusters; i++) out.push(...el([0xa3], [0x81, 0, i & 0x7f, o.lace ? 0x82 : 0x80, o.toc ?? 0xf8, 1, 2, 3]));
  }
  return new Uint8Array(out);
}
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

describe("认 WebM（Opus）有多长：按音频包数，不看容器里写的时间", () => {
  it("100 个 20 毫秒的包是 2 秒；分在几个簇里也一样", () => {
    expect(webmOpusSeconds(webm(100))).toBe(2);
    expect(webmOpusSeconds(webm(100, { clusters: 4 }))).toBe(2);
  });

  it("一个包几帧、每帧多长看第一个字节：10 毫秒一帧的包、一包三帧都算对；超过 120 毫秒的包不认", () => {
    expect(webmOpusSeconds(webm(100, { toc: 0xf0 }))).toBe(1); // CELT 全频带 10 毫秒一帧
    expect(webmOpusSeconds(webm(100, { toc: 0x18 }))).toBe(6); // SILK 窄带 60 毫秒一帧
    expect(opusPacketMs(new Uint8Array([0xfb, 0x03]), 0, 2)).toBe(60); // 一包三帧
    expect(opusPacketMs(new Uint8Array([0xfb, 0x07]), 0, 2)).toBeNull(); // 七帧 140 毫秒
    expect(opusPacketMs(new Uint8Array([0xfb]), 0, 1)).toBeNull(); // 说了有几帧却没写
  });

  it("不是 Opus、块里打了包、结构坏了、截断了：都不认", () => {
    expect(webmOpusSeconds(webm(10, { codec: "A_VORBIS" }))).toBeNull();
    expect(webmOpusSeconds(webm(10, { lace: true }))).toBeNull();
    const cut = webm(10);
    expect(webmOpusSeconds(cut.subarray(0, cut.length - 3))).toBeNull();
    expect(webmOpusSeconds(webm(0))).toBeNull();
    expect(webmOpusSeconds(seconds(1))).toBeNull();
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

  it("WebM 也收：按包算出秒数；超过 31 秒、太大、认不出直接拒（页面会改传 WAV）", async () => {
    await expect(transcribe(webm(100))).resolves.toMatchObject({ text: SIM_TEXT, simulated: true, seconds: 2 });
    await expect(transcribe(webm(1600, { clusters: 8 }))).rejects.toMatchObject({ status: 413 });
    await expect(transcribe(webm(10, { lace: true }))).rejects.toMatchObject({ status: 400 });
    const big = new Uint8Array(ASR_MAX_WEBM_BYTES + 1);
    big.set([0x1a, 0x45, 0xdf, 0xa3]);
    await expect(transcribe(big)).rejects.toMatchObject({ status: 413 });
  });
});

describe("接真实模型（阿里云百炼）", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("WebM 原样转交（data:audio/webm;base64），不在服务器上转格式", async () => {
    let sent = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body)).messages[0].content[0].input_audio.data;
        return Response.json({ choices: [{ message: { content: "好" } }] });
      }),
    );
    await expect(transcribe(webm(100))).resolves.toEqual({ text: "好", simulated: false, seconds: 2 });
    expect(sent.startsWith("data:audio/webm;base64,GkXfo")).toBe(true);
  });

  it("百炼退回压缩的那一份（400，多半是不认这种格式）：回 415，好让页面改传 WAV；WAV 被退回还是照常报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: { code: "InvalidParameter", message: "audio format not supported" } }, { status: 400 })),
    );
    await expect(transcribe(webm(100))).rejects.toMatchObject({ status: 415 });
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 502, message: expect.stringContaining("再说一次") });
  });

  it("配了 ASR_API_KEY 就用它（接口地址单独改到另一个百炼账号时）；没配用对话模型那把", async () => {
    const auth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        auth.push(new Headers(init.headers).get("authorization") ?? "");
        return Response.json({ choices: [{ message: { content: "好" } }] });
      }),
    );
    await transcribe(seconds(1));
    process.env.ASR_API_KEY = "asr-key";
    await transcribe(seconds(1));
    expect(auth).toEqual(["Bearer test-key", "Bearer asr-key"]);
  });

  it("欠费、额度用完、密钥不对：503，说暂时用不了、请打字（不给「再说一次」）；服务端日志只记状态码和错误代号", async () => {
    const reply = (status: number, code: string) =>
      vi.fn(async () => Response.json({ error: { code, message: "Access denied, test-key 123 secret detail" } }, { status }));
    vi.stubGlobal("fetch", reply(400, "Arrearage"));
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 503, message: "语音转文字暂时用不了：请直接打字" });
    vi.stubGlobal("fetch", reply(403, "AllocationQuota.FreeTierOnly"));
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal("fetch", reply(401, "InvalidApiKey"));
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 503 });
    vi.stubGlobal("fetch", reply(429, "Throttling.AllocationQuota"));
    await expect(transcribe(seconds(1))).rejects.toMatchObject({ status: 429 });
    const logged = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(logged).toEqual([
      "[asr] 百炼回 400 Arrearage",
      "[asr] 百炼回 403 AllocationQuota.FreeTierOnly",
      "[asr] 百炼回 401 InvalidApiKey",
      "[asr] 百炼回 429 Throttling.AllocationQuota",
    ]);
    expect(logged.join(" ")).not.toMatch(/test-key|secret|Access denied/);
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
