// 语音转文字（ADR-054，11-16）：浏览器把「说」的这一段录下来发过来，这里交给阿里云百炼的语音识别
// （qwen3-asr-flash，OpenAI 兼容接口；密钥默认和对话模型同一把，可以用 ASR_API_KEY 另配）转成文字。
// 录音有两种：浏览器支持时压成 WebM（Opus），30 秒约 120 KB；不支持时是 16 kHz 单声道 WAV，30 秒约 0.96 MB
// （11-17：线上「说完了」到出字要 5～10 秒，大半耗在传这近 1 MB 上，改成先压缩再传）。
// 为什么不用浏览器自带的识别：Edge「连着听」只回空字（11-16 实测，就是队员 B 说的「语音识别不了了」）；「一段一段听」每段之间
// 要 0.3～1 秒才重新收音，句子中间会丢字；Chrome 要连谷歌的服务，国内连不上。录一整段再转，中间不断，哪个浏览器都一样。
// 录音只用来转文字：程序不保存、不写日志、转完就丢（nginx 收大一点的请求体时会先写进临时文件，转发完就删）。
// 模拟模式（没配密钥）：不调用任何接口，回一句写好的话（端到端测试用），并标明是模拟的。

import { isLive } from "./llm";
import { looksWebm, webmOpusSeconds } from "./webm";

/** 一段最长多少秒（浏览器那边到点自己收尾、多录的截掉；也是为了请求体不超过 1 MB——nginx 默认上限） */
export const ASR_MAX_SECONDS = 30;
/** 请求体上限：16 kHz、16 位、单声道，按 31 秒算（比浏览器那边多 1 秒余量；复查：原来只多 0.128 秒，录满 30 秒常被当成太长）+ WAV 头 */
export const ASR_MAX_BYTES = 44 + 16000 * 2 * (ASR_MAX_SECONDS + 1) + 4096;
/** 压缩过的（WebM）上限：浏览器按每秒 32 千比特压，31 秒约 125 KB；放到 512 KB，码率高一点的浏览器也够 */
export const ASR_MAX_WEBM_BYTES = 512 * 1024;
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

/** 语音识别用的密钥：ASR_API_KEY 没配就用对话模型那把（复查：接口地址能单独改，密钥原来不能） */
function asrKey(): string | undefined {
  return process.env.ASR_API_KEY || process.env.LLM_API_KEY;
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

/** 发来的是哪种录音、多少秒；认不出、太长抛 AsrError（400 / 413） */
export function audioInfo(b: Uint8Array): { mime: "audio/wav" | "audio/webm"; seconds: number } {
  const tooLong = () => new AsrError(`这一段太长了：一次最多说 ${ASR_MAX_SECONDS} 秒`, 413);
  if (looksWebm(b)) {
    if (b.byteLength > ASR_MAX_WEBM_BYTES) throw tooLong();
    const seconds = webmOpusSeconds(b);
    if (seconds === null) throw new AsrError("录音格式不对（要 WebM 的 Opus，或者 16 位单声道 WAV）", 400);
    if (seconds > ASR_MAX_SECONDS + 1) throw tooLong();
    return { mime: "audio/webm", seconds };
  }
  if (b.byteLength > ASR_MAX_BYTES) throw tooLong();
  const info = wavInfo(b);
  if (!info) throw new AsrError("录音格式不对（要 WebM 的 Opus，或者 16 位单声道 WAV）", 400);
  if (info.seconds > ASR_MAX_SECONDS + 1) throw tooLong();
  return { mime: "audio/wav", seconds: info.seconds };
}

/**
 * 百炼回的错只记状态码和错误代号（复查：原来什么都不记，出了问题查不出是欠费还是限流）；不记密钥、不记原文、不记录音。
 * 错误代号只留字母数字和点、横线、下划线，最多 64 个字
 */
function upstreamCode(body: string): string {
  let code = "";
  try {
    const j = JSON.parse(body) as { code?: unknown; error?: { code?: unknown; type?: unknown } };
    code = String(j?.error?.code ?? j?.code ?? j?.error?.type ?? "");
  } catch {
    code = /^[A-Za-z][\w.]{2,63}/.exec(body.trim())?.[0] ?? "";
  }
  return code.replace(/[^\w.-]/g, "").slice(0, 64);
}

/** 认出来的字收拾一下：去掉首尾空白，最多 200 字（和输入框一样） */
export function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * 转文字。格式不对、太长抛 AsrError(400/413)；太短当没说话（返回空字）；接口出错抛 AsrError(502)，限流 429，
 * 欠费、额度用完、密钥不对 503（再说一次也没用）。
 * 返回 simulated：模拟模式回的是写好的那一句，不是真的认出来的。
 */
export async function transcribe(audio: Uint8Array, signal?: AbortSignal): Promise<{ text: string; simulated: boolean; seconds: number }> {
  const info = audioInfo(audio);
  if (info.seconds < ASR_MIN_SECONDS) return { text: "", simulated: !isLive(), seconds: info.seconds };
  if (!isLive()) return { text: SIM_TEXT, simulated: true, seconds: info.seconds };
  if (!asrAvailable()) throw new AsrError("服务器没有接语音识别：请直接打字", 503);
  const timeout = AbortSignal.timeout(Number(process.env.ASR_TIMEOUT_MS || 15000));
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${asrKey()}` },
      body: JSON.stringify({
        model: asrModel(),
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: `data:${info.mime};base64,${Buffer.from(audio).toString("base64")}` } }],
          },
        ],
        stream: false,
        asr_options: { language: "zh", enable_itn: true },
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
    // 页面那边不要了（点了发送、离开）不算出错，不记
    if (!signal?.aborted) console.warn(`[asr] 没连上百炼（${(e as Error)?.name === "TimeoutError" ? "超时" : "网络"}）`);
    throw new AsrError("语音转文字这会儿没连上：再说一次，或者直接打字");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const code = upstreamCode(body);
    console.warn(`[asr] 百炼回 ${res.status}${code ? ` ${code}` : ""}`);
    // 欠费、额度用完、密钥不对、没开通：等一会儿也不会好（复查：原来也说「过一会儿再说」）
    if (
      /Arrearage|AllocationQuota\.FreeTierOnly|insufficient|InvalidApiKey|invalid_api_key|AccessDenied|Unauthorized/i.test(
        `${code} ${body}`,
      ) ||
      res.status === 401 ||
      res.status === 403
    ) {
      throw new AsrError("语音转文字暂时用不了：请直接打字", 503);
    }
    if (res.status === 429 || /Throttling|rate.?limit|quota/i.test(`${code} ${body}`)) {
      throw new AsrError("语音转文字这会儿太忙了：过一会儿再说，或者直接打字", 429);
    }
    // 百炼退回压缩的那一份（多半是不认这种格式，比如 ASR_MODEL 换成了不收 WebM 的模型）：回 415，页面会改传 WAV（复查）
    if (info.mime === "audio/webm" && res.status === 400) throw new AsrError("百炼不收这种录音格式：改传 WAV", 415);
    throw new AsrError("语音转文字这会儿出错了：再说一次，或者直接打字");
  }
  const j = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown } }[] } | null;
  const content = j?.choices?.[0]?.message?.content;
  const text =
    typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string })?.text ?? "").join("") : "";
  return { text: tidy(text), simulated: false, seconds: info.seconds };
}
