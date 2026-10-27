// 语音合成：把放行的句子变成 24 kHz、16 位、单声道 PCM，一块一块流式交出。
// 两种实现：
//   simulated  没有密钥时使用的「模拟发声」：按字生成音节（不是真人声音，界面和数据都标成模拟）。
//              每个字落在哪段采样是程序自己生成的，所以能精确算出违规内容对应的音频区间；
//   dashscope  阿里云百炼 Qwen-TTS 流式接口（SSE，返回 Base64 PCM）。10-27 已用真实密钥跑通；
//              它不给字级时间戳，所以违规区间只能取整句，记为「句级上界」（规格 01 §3.7）。

import type { SampleRange } from "../audio/intervals";
import type { GuardHit } from "../domain/types";
import { ProviderBlockedError, RateLimitError, UpstreamError } from "./llm";

export const TTS_SAMPLE_RATE = 24000;

export type AudioLevel = "simulation" | "live";

export interface Synthesis {
  level: AudioLevel;
  model: string;
  sampleRate: number;
  /** 每个 UTF-16 码元对应的采样区间；只有模拟发声有（真实合成没有字级时间戳） */
  charRanges: SampleRange[] | null;
  /** 总采样数；真实合成在生成完之前不知道 */
  totalSamples: number | null;
  chunks: AsyncGenerator<Int16Array>;
}

/**
 * 预热到合成服务的网络连接（只建立 TLS 连接，不合成、不计费）。
 * 第一轮的合成请求如果要现建连接，首声会多等几百毫秒；运行一开始就把连接建好。
 */
export function prewarmTts(): void {
  if (ttsProvider() !== "dashscope") return;
  const base = (process.env.TTS_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "");
  void fetch(base, { method: "HEAD", signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export function ttsProvider(): "simulated" | "dashscope" {
  const p = process.env.TTS_PROVIDER;
  if (p === "simulated" || p === "dashscope") return p;
  const key = process.env.TTS_API_KEY || process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL || "dashscope";
  return key && base.includes("dashscope") ? "dashscope" : "simulated";
}

export function ttsModel(): string {
  return ttsProvider() === "dashscope" ? process.env.TTS_MODEL || "qwen3-tts-flash" : "simulated-babble";
}

/** 句子里有没有能念出来的字（汉字、假名、拉丁字母、数字） */
export const SPEAKABLE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]/u;

export function synthesize(text: string, signal?: AbortSignal): Synthesis {
  // 只有颜文字或标点的一句（例如「（*^▽^*）」）没有可念的字：不送去合成，按无声处理
  // （10-27 真实运行里，百炼对这种句子返回 InvalidParameter，浏览器那边就成了一次播放失败）
  if (!SPEAKABLE.test(text)) return silence(ttsProvider() === "dashscope" ? "live" : "simulation", ttsModel());
  return ttsProvider() === "dashscope" ? dashscope(text, signal) : simulated(text, signal);
}

function silence(level: AudioLevel, model: string): Synthesis {
  async function* none(): AsyncGenerator<Int16Array> {}
  return { level, model, sampleRate: TTS_SAMPLE_RATE, charRanges: null, totalSamples: 0, chunks: none() };
}

/** 合成接口明确拒绝了这次请求（参数不对、文本不能合成等）：换个时间再发也一样，不重试 */
class TtsRequestError extends UpstreamError {}

/**
 * 违规内容在这句话音频里的采样区间 U（规格 02 §4.2）。
 * 口令类且有字级对齐：精确到口令那几个字；其他情况取整句，标为句级上界。
 */
export function violationRanges(
  text: string,
  hit: GuardHit,
  canary: string,
  s: Pick<Synthesis, "charRanges" | "totalSamples">,
): { ranges: SampleRange[]; level: "char" | "sentence_upper_bound" } {
  if (hit.rule === "canary" && s.charRanges && canary) {
    const ranges: SampleRange[] = [];
    for (let i = text.indexOf(canary); i >= 0; i = text.indexOf(canary, i + canary.length)) {
      ranges.push([s.charRanges[i][0], s.charRanges[i + canary.length - 1][1]]);
    }
    if (ranges.length) return { ranges, level: "char" };
  }
  return { ranges: [[0, s.totalSamples ?? Number.MAX_SAFE_INTEGER]], level: "sentence_upper_bound" };
}

// ---------- 模拟发声 ----------

/** 模拟合成的时延（固定值，界面上标为模拟）：首块 180 ms，之后每 20 ms 交出 100 ms 音频（比实时快 5 倍，接近云端合成的表现） */
export const SIM_TTS = { firstChunkMs: 180, chunkMs: 20, chunkSamples: 2400 } as const;

const LONG_PAUSE = /[。！？!?…～~\n]/;
const SHORT_PAUSE = /[，,、；;：:]/;
const ASCII_WORD = /[A-Za-z0-9]/;
const SILENT = /[\s"'“”‘’「」『』（）()【】[\]《》<>—\-·_*#]/;

/** 每个字发多长（秒），以及发不发声 */
function charPlan(ch: string): { seconds: number; voiced: boolean } {
  if (LONG_PAUSE.test(ch)) return { seconds: 0.26, voiced: false };
  if (SHORT_PAUSE.test(ch)) return { seconds: 0.14, voiced: false };
  if (SILENT.test(ch)) return { seconds: 0.06, voiced: false };
  if (ASCII_WORD.test(ch)) return { seconds: 0.16, voiced: true };
  return { seconds: 0.21, voiced: true };
}

/** 五个元音的共振峰（Hz），按字的编码挑一个，让声音听起来像在说话而不是单音 */
const VOWELS: [number, number][] = [
  [800, 1200],
  [500, 900],
  [500, 1700],
  [300, 2300],
  [350, 800],
];

/** 确定性伪随机（同一句话每次生成的音频完全一样，便于复现实验） */
function rng(seed: number) {
  let x = seed || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

/** 生成整句的 PCM 和逐字对齐（纯函数，单元测试直接调用） */
export function renderBabble(text: string, sampleRate = TTS_SAMPLE_RATE): { pcm: Int16Array; charRanges: SampleRange[] } {
  const plans: { seconds: number; voiced: boolean; code: number }[] = [];
  const units = text.length;
  for (let i = 0; i < units; i++) {
    const code = text.charCodeAt(i);
    // 代理对（如表情符号）的后半个码元不单独发音
    if (code >= 0xdc00 && code <= 0xdfff) plans.push({ seconds: 0, voiced: false, code });
    else plans.push({ ...charPlan(text[i]), code });
  }
  const lengths = plans.map((p) => Math.round(p.seconds * sampleRate));
  const total = lengths.reduce((a, b) => a + b, 0);
  const pcm = new Int16Array(total);
  const charRanges: SampleRange[] = [];
  let pos = 0;
  plans.forEach((p, idx) => {
    const n = lengths[idx];
    charRanges.push([pos, pos + n]);
    if (p.voiced && n > 0) {
      const [f1, f2] = VOWELS[p.code % VOWELS.length];
      const tone = p.code % 4; // 平、升、降、曲
      const base = 210 + (p.code % 7) * 6;
      const rand = rng(p.code * 2654435761);
      const attack = Math.round(0.012 * sampleRate);
      const release = Math.round(0.04 * sampleRate);
      let phase = 0;
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const contour = tone === 0 ? 0 : tone === 1 ? 40 * t : tone === 2 ? 40 * (1 - t) - 20 : 30 * (t - 0.5) ** 2 * 4 - 15;
        const f0 = base + contour;
        phase += (2 * Math.PI * f0) / sampleRate;
        let v = 0;
        for (let h = 1; h <= 8; h++) {
          const f = h * f0;
          const gain = Math.exp(-(((f - f1) / 160) ** 2)) + 0.7 * Math.exp(-(((f - f2) / 220) ** 2)) + 0.08;
          v += (gain * Math.sin(h * phase)) / Math.sqrt(h);
        }
        // 一部分字带一点辅音噪声
        if (p.code % 3 === 0 && k < 0.02 * sampleRate) v += (rand() - 0.5) * 0.6;
        const env = Math.min(1, k / attack, (n - k) / release);
        pcm[pos + k] = Math.max(-32767, Math.min(32767, Math.round(v * env * 0.22 * 32767)));
      }
    }
    pos += n;
  });
  return { pcm, charRanges };
}

function simulated(text: string, signal?: AbortSignal): Synthesis {
  const { pcm, charRanges } = renderBabble(text);
  async function* chunks(): AsyncGenerator<Int16Array> {
    await sleep(SIM_TTS.firstChunkMs, signal);
    for (let i = 0; i < pcm.length; i += SIM_TTS.chunkSamples) {
      if (signal?.aborted) return;
      yield pcm.slice(i, i + SIM_TTS.chunkSamples);
      if (i + SIM_TTS.chunkSamples < pcm.length) await sleep(SIM_TTS.chunkMs, signal);
    }
  }
  return {
    level: "simulation",
    model: "simulated-babble",
    sampleRate: TTS_SAMPLE_RATE,
    charRanges,
    totalSamples: pcm.length,
    chunks: chunks(),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

// ---------- 阿里云百炼 Qwen-TTS（10-27 已用真实密钥跑通：流式出声，第一块中位约 0.3 秒） ----------

/** 两种「等不到声音」的超时：第一块迟迟不来，或中途断流。和总超时分开计，出问题时浏览器不用干等 */
const TTS_TIMEOUTS = {
  firstChunkMs: () => Number(process.env.TTS_FIRST_CHUNK_TIMEOUT_MS || 4000),
  idleMs: () => Number(process.env.TTS_IDLE_TIMEOUT_MS || 5000),
  totalMs: () => Number(process.env.TTS_TIMEOUT_MS || 20000),
};

function dashscope(text: string, signal?: AbortSignal): Synthesis {
  const model = ttsModel();
  const base = (process.env.TTS_BASE_URL || "https://dashscope.aliyuncs.com/api/v1").replace(/\/$/, "");
  const key = process.env.TTS_API_KEY || process.env.LLM_API_KEY;

  /** 一次合成请求：每次读网络都设一个「等不到就中止」的计时器 */
  async function* attempt(): AsyncGenerator<Int16Array> {
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stalled = "";
    const arm = (ms: number, limit: number, what: string) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          stalled = `语音合成 ${limit} 毫秒没送来${what}，已中止`;
          stall.abort();
        },
        Math.max(1, ms),
      );
    };
    const firstLimit = TTS_TIMEOUTS.firstChunkMs();
    const idleLimit = TTS_TIMEOUTS.idleMs();
    // 第一块从请求发出算起，收到心跳之类不带声音的事件也不顺延
    const firstDeadline = performance.now() + firstLimit;
    const signals = [stall.signal, AbortSignal.timeout(TTS_TIMEOUTS.totalMs()), ...(signal ? [signal] : [])];
    let gotAudio = false;
    try {
      arm(firstLimit, firstLimit, "第一段声音");
      const res = await fetch(`${base}/services/aigc/multimodal-generation/generation`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-DashScope-SSE": "enable" },
        body: JSON.stringify({ model, input: { text, voice: process.env.TTS_VOICE || "Cherry" } }),
        signal: AbortSignal.any(signals),
      });
      if (!res.ok || !res.body) {
        const body = await res.text().catch(() => "");
        if (/DataInspectionFailed|data_inspection_failed/i.test(body))
          throw new ProviderBlockedError(`语音合成被平台审核拦截（${res.status}）`);
        if (res.status === 429 || /Throttling|quota|Arrearage/i.test(body))
          throw new RateLimitError(`语音合成限流或额度不足（${res.status}）`);
        const msg = `语音合成接口返回 ${res.status}：${body.slice(0, 200)}`;
        throw res.status >= 400 && res.status < 500 ? new TtsRequestError(msg) : new UpstreamError(msg);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let carry: Uint8Array | null = null; // 两块之间可能断在半个采样上
      while (true) {
        // 只在等网络时计时：调用方慢慢取音频不算断流
        if (gotAudio) arm(idleLimit, idleLimit, "后续声音");
        else arm(firstDeadline - performance.now(), firstLimit, "第一段声音");
        const { value, done } = await reader.read();
        clearTimeout(timer);
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          let json: { output?: { audio?: { data?: string } }; code?: string; message?: string };
          try {
            json = JSON.parse(trimmed.slice(5));
          } catch {
            continue;
          }
          if (json.code) throw new TtsRequestError(`语音合成出错：${json.code} ${json.message ?? ""}`);
          const b64 = json.output?.audio?.data;
          if (!b64) continue;
          let bytes: Uint8Array = Buffer.from(b64, "base64");
          if (carry) {
            const merged = new Uint8Array(carry.length + bytes.length);
            merged.set(carry);
            merged.set(bytes, carry.length);
            bytes = merged;
            carry = null;
          }
          const even = bytes.length - (bytes.length % 2);
          if (even < bytes.length) carry = bytes.slice(even);
          if (even > 0) {
            gotAudio = true;
            yield new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + even));
          }
        }
      }
    } catch (e) {
      if (stalled && !signal?.aborted) throw new UpstreamError(stalled);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 还没出声就失败（连不上、超时、服务端出错）时重试一次；已经出过声、请求被拒、被平台拦截、限流、被调用方中止都不重试 */
  async function* chunks(): AsyncGenerator<Int16Array> {
    for (let n = 1; ; n++) {
      let yielded = false;
      try {
        for await (const c of attempt()) {
          yielded = true;
          yield c;
        }
        return;
      } catch (e) {
        const retryable = !(e instanceof ProviderBlockedError || e instanceof RateLimitError || e instanceof TtsRequestError);
        if (yielded || n >= 2 || signal?.aborted || !retryable) throw e;
      }
    }
  }
  return { level: "live", model, sampleRate: TTS_SAMPLE_RATE, charRanges: null, totalSamples: null, chunks: chunks() };
}
