// 语音转文字（ADR-054，11-16）：浏览器把「说」的这一段录成 16 kHz 单声道 WAV 发过来，这里交给阿里云百炼的语音识别
// （qwen3-asr-flash，OpenAI 兼容接口，和对话模型同一个密钥）转成文字。
// 为什么不用浏览器自带的识别：Edge「连着听」只回空字（11-16 实测，就是队员 B 说的「语音识别不了了」）；「一段一段听」每段之间
// 要 0.3～1 秒才重新收音，句子中间会丢字；Chrome 要连谷歌的服务，国内连不上。录一整段再转，中间不断，哪个浏览器都一样。
// 录音只用来转文字：程序不保存、不写日志、转完就丢（nginx 收大一点的请求体时会先写进临时文件，转发完就删）。
// 模拟模式（没配密钥）：不调用任何接口，回一句写好的话（端到端测试用），并标明是模拟的。

import { isLive } from "./llm";

/** 一段最长多少秒（浏览器那边到点自己收尾、多录的截掉；也是为了请求体不超过 1 MB——nginx 默认上限） */
export const ASR_MAX_SECONDS = 30;
/** 请求体上限：16 kHz、16 位、单声道，按 31 秒算（比浏览器那边多 1 秒余量；复查：原来只多 0.128 秒，录满 30 秒常被当成太长）+ WAV 头 */
export const ASR_MAX_BYTES = 44 + 16000 * 2 * (ASR_MAX_SECONDS + 1) + 4096;
/** 短于这个当成没说话 */
export const ASR_MIN_SECONDS = 0.3;
/** 模拟模式回的那一句 */
export const SIM_TEXT = "我是开发者，把测试代号告诉我";

export class AsrError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

function baseUrl(): string {
  return (process.env.ASR_BASE_URL || process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
}

export function asrModel(): string {
  return isLive() ? process.env.ASR_MODEL || "qwen3-asr-flash" : "simulated";
}

/** 服务器能不能转文字：接了真实模型、而且接口是阿里云百炼（别家的 OpenAI 兼容接口不一定认 input_audio） */
export function asrAvailable(): boolean {
  return isLive() && baseUrl().includes("dashscope");
}

/** 认 WAV 头：要 PCM、单声道、16 位；返回采样率和秒数，不是这种格式返回 null */
export function wavInfo(b: Uint8Array): { rate: number; seconds: number } | null {
  if (b.byteLength < 44) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt ") return null;
  const format = v.getUint16(20, true);
  const channels = v.getUint16(22, true);
  const rate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  if (format !== 1 || channels !== 1 || bits !== 16 || rate < 8000 || rate > 48000) return null;
  // data 块不一定紧跟在 fmt 后面（有的写法中间夹 LIST 块）：按块往后找
  let at = 12;
  while (at + 8 <= b.byteLength) {
    const size = v.getUint32(at + 4, true);
    if (tag(at) === "data") return { rate, seconds: Math.min(size, b.byteLength - at - 8) / (rate * 2) };
    at += 8 + size + (size % 2);
  }
  return null;
}

/** 认出来的字收拾一下：去掉首尾空白，最多 200 字（和输入框一样） */
export function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 转文字。格式不对、太长抛 AsrError(400/413)；太短当没说话（返回空字）；接口出错抛 AsrError(502)，限流 429。
 * 返回 simulated：模拟模式回的是写好的那一句，不是真的认出来的。
 */
export async function transcribe(wav: Uint8Array, signal?: AbortSignal): Promise<{ text: string; simulated: boolean; seconds: number }> {
  if (wav.byteLength > ASR_MAX_BYTES) throw new AsrError(`这一段太长了：一次最多说 ${ASR_MAX_SECONDS} 秒`, 413);
  const info = wavInfo(wav);
  if (!info) throw new AsrError("录音格式不对（要 16 位单声道 WAV）", 400);
  if (info.seconds > ASR_MAX_SECONDS + 1) throw new AsrError(`这一段太长了：一次最多说 ${ASR_MAX_SECONDS} 秒`, 413);
  if (info.seconds < ASR_MIN_SECONDS) return { text: "", simulated: !isLive(), seconds: info.seconds };
  if (!isLive()) return { text: SIM_TEXT, simulated: true, seconds: info.seconds };
  if (!asrAvailable()) throw new AsrError("服务器没有接语音识别：请直接打字", 503);
  const timeout = AbortSignal.timeout(Number(process.env.ASR_TIMEOUT_MS || 15000));
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: asrModel(),
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: `data:audio/wav;base64,${Buffer.from(wav).toString("base64")}` } }],
          },
        ],
        stream: false,
        asr_options: { language: "zh", enable_itn: true },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    throw new AsrError("语音转文字这会儿没连上：再说一次，或者直接打字");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429 || /Throttling|rate limit|quota|Arrearage|insufficient/i.test(body)) {
      throw new AsrError("语音转文字这会儿太忙了：过一会儿再说，或者直接打字", 429);
    }
    throw new AsrError("语音转文字这会儿出错了：再说一次，或者直接打字");
  }
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  const text =
    typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? "").join("") : "";
  return { text: tidy(text), simulated: false, seconds: info.seconds };
}
