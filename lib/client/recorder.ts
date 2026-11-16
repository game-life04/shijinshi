// 「说」的第二种做法（ADR-054，11-16）：录一整段，说完交给服务器转成文字（/api/play/asr，服务端用阿里云百炼的语音识别）。
// 浏览器自带的识别：Edge「连着听」只回空字；「一段一段听」每段之间要 0.3～1 秒才重新收音，句子中间会丢字；
// Chrome 连谷歌的服务，国内连不上。录一整段中间不断，哪个浏览器都一样。和 SpeechSession 一样的用法（开始、说完了、不要了），
// 一样的回调（onText 只在最后交一次整句），页面不用管是哪一种。
// 听没听到人说话按响度算：响度连着过门槛约 0.15 秒就算开口（顺带用来「你一开口就打断她」）；门槛按刚打开麦克风时的底噪定。
// 说过以后安静 4 秒、一直没说 10 秒、说满 30 秒都自动收尾（和点「说完了」一样）；几个时间都从麦克风真正打开时算
// （复查：原来从点「说」算，第一次用时权限弹窗看了 10 秒，一点「允许」就报没听到）。
// 没算上开口、但录到了一点声音（最响的一段过了很低的底），收尾时照样交去认，空不空让识别去判
// （复查：麦克风增益低、离得远时，小红点在动却说「没听到声音」，再说一次还是一样）。

import { EXPIRED_MESSAGE, toLoginIfExpired } from "./session-expired";
import type { SpeechEvents, SpeechState, Timers } from "./speech-input";
import { ERRORS, RECORD_ERRORS } from "./speech-messages";
import { concat, encodeWav, resample, rms } from "./wav";

export const RECORD_LIMITS = {
  /** 说过话以后，这么久没声音就当说完了 */
  silenceMs: 4000,
  /** 一直没听到说话，等这么久 */
  noSpeechMs: 10000,
  /** 一段最长：收尾时多出来的截掉，发出去的不超过这么长（服务端收到 31 秒为止，留了余量） */
  maxMs: 30000,
  /** 开口门槛的上下限（均方根，0～1；安静的房间一般 0.002～0.01，正常说话 0.03 以上）。门槛 = 底噪 × 3，夹在这两个数之间 */
  voiceRmsMin: 0.012,
  voiceRmsMax: 0.04,
  /** 底噪还没量出来时用的门槛 */
  voiceRms: 0.02,
  /** 麦克风打开后这么久里最安静的那一段，当底噪 */
  floorMs: 300,
  /** 连着这么久过门槛才算开口（滤掉敲桌子、点鼠标这种一下的声音） */
  voiceHoldMs: 150,
  /** 少于这么长的录音当没说话 */
  minMs: 300,
  /** 没算上开口时，最响的一段过了这个（很轻）就照样交去认 */
  faintRms: 0.004,
};

/** 开着的麦克风：采样率、关掉 */
export interface Mic {
  sampleRate: number;
  close: () => void;
}
/** 打开麦克风，每来一段声音调一次 onChunk */
export type OpenMic = (onChunk: (samples: Float32Array) => void) => Promise<Mic>;
/** 把 WAV 发去转文字 */
export type Upload = (wav: Uint8Array, signal: AbortSignal) => Promise<{ text: string; simulated?: boolean }>;

export interface RecordEvents extends SpeechEvents {
  /** 响度（0～1），给「在听」的那个小红点跟着声音变大变小 */
  onLevel?: (level: number) => void;
  /** 模拟模式：填进去的是写好的一句，不是真的认出来的 */
  onNote?: (note: string) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** 带着给用户看的话的错（打开麦克风以外的那几步出错时用） */
export class RecordError extends Error {}

/** 麦克风打不开的原因 → 人话 */
export function micError(e: unknown): string {
  if (e instanceof RecordError) return e.message;
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") return ERRORS["not-allowed"];
  if (name === "NotFoundError" || name === "OverconstrainedError") return ERRORS["audio-capture"];
  if (name === "NotReadableError" || name === "AbortError") return RECORD_ERRORS.busy;
  return RECORD_ERRORS.open;
}

export class RecordSession {
  state: SpeechState = "idle";
  private mic: Mic | null = null;
  private chunks: Float32Array[] = [];
  private rate = 48000;
  /** 麦克风真正打开的时刻；没打开前是 null（这时不按时间自动收尾） */
  private micAt: number | null = null;
  private lastVoice = 0;
  private voiceSince: number | null = null;
  private heardAny = false;
  private peak = 0;
  /** 开头那一小会儿各段的响度（量底噪）；量完了是 null */
  private floorLevels: number[] | null = [];
  private threshold: number;
  private cancelled = false;
  private tickTimer: unknown = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly ev: RecordEvents,
    private readonly openMic: OpenMic,
    private readonly upload: Upload,
    private readonly now: () => number = () => Date.now(),
    private readonly limits = RECORD_LIMITS,
    private readonly timers: Timers = realTimers,
  ) {
    this.threshold = limits.voiceRms;
  }

  /** 开始录（马上就算在听，按钮变「说完了」；麦克风在后台打开，打不开报原因） */
  start() {
    this.setState("listening");
    this.openMic((f) => this.onChunk(f)).then(
      (mic) => {
        // 还没打开就点了「说完了」或者不要了：打开了也马上关掉
        if (this.state !== "listening") {
          mic.close();
          return;
        }
        this.mic = mic;
        this.rate = mic.sampleRate;
        this.micAt = this.lastVoice = this.now();
      },
      (e) => {
        if (this.state !== "listening") return;
        this.timers.clear(this.tickTimer);
        this.setState("idle");
        this.ev.onError(micError(e));
        this.ev.onText("", true);
      },
    );
    this.tick();
  }

  private onChunk(f: Float32Array) {
    if (this.state !== "listening") return;
    this.chunks.push(f);
    const level = rms(f);
    this.ev.onLevel?.(level);
    if (level > this.peak) this.peak = level;
    const t = this.now();
    // 量底噪：麦克风打开后 floorMs 里最安静的那一段 × 3 当门槛（夹在上下限之间）
    if (this.floorLevels) {
      this.floorLevels.push(level);
      if (this.micAt !== null && t - this.micAt >= this.limits.floorMs) {
        const floor = Math.min(...this.floorLevels);
        this.threshold = Math.min(this.limits.voiceRmsMax, Math.max(this.limits.voiceRmsMin, floor * 3));
        this.floorLevels = null;
      }
    }
    if (level >= this.threshold) {
      this.voiceSince ??= t;
      // 连着过门槛够久才算开口（一段 2048 个采样，48 kHz 下约 43 毫秒，连着四段左右）；一段本身就够长时（低采样率）一段就算
      if (t - this.voiceSince >= this.limits.voiceHoldMs || (f.length / this.rate) * 1000 >= this.limits.voiceHoldMs) {
        if (!this.heardAny) this.ev.onSpeechStart();
        this.heardAny = true;
      }
      this.lastVoice = t;
    } else this.voiceSince = null;
  }

  /** 点了「说完了」（或者自动收尾）：在后台转文字，转好了交出来 */
  stop() {
    if (this.state !== "listening") return;
    this.timers.clear(this.tickTimer);
    this.mic?.close();
    this.mic = null;
    let samples = concat(this.chunks);
    this.chunks = [];
    // 收尾时多录的那一点（定时器每 250 毫秒看一次、页面忙时更晚）截掉：发出去的不超过 maxMs
    const max = Math.round((this.rate * this.limits.maxMs) / 1000);
    if (samples.length > max) samples = samples.subarray(0, max);
    const ms = (samples.length / this.rate) * 1000;
    if (ms < this.limits.minMs || !(this.heardAny || this.peak >= this.limits.faintRms)) {
      this.setState("idle");
      this.ev.onError(ERRORS["no-speech"]);
      this.ev.onText("", true);
      return;
    }
    this.setState("finishing");
    const wav = encodeWav(resample(samples, this.rate, 16000), 16000);
    this.abort = new AbortController();
    this.upload(wav, this.abort.signal).then(
      (r) => {
        if (this.cancelled) return;
        this.setState("idle");
        if (!r.text) this.ev.onError(RECORD_ERRORS.unclear);
        else if (r.simulated) this.ev.onNote?.("模拟模式：没有真的认，填进去的是写好的一句");
        this.ev.onText(r.text, true);
      },
      (e) => {
        if (this.cancelled) return;
        this.setState("idle");
        this.ev.onError(e instanceof Error && e.message ? e.message : RECORD_ERRORS.upload);
        this.ev.onText("", true);
      },
    );
  }

  /** 收尾时又要开新的一句：录着的先收尾；已经在转文字的照常等它回来 */
  finish() {
    if (this.state === "listening") this.stop();
  }

  /** 不要了（点了发送、换关、离开页面）：停录、不交 */
  cancel() {
    if (this.state === "idle") return;
    this.cancelled = true;
    this.timers.clear(this.tickTimer);
    this.mic?.close();
    this.mic = null;
    this.chunks = [];
    this.abort?.abort();
    this.setState("idle");
  }

  private setState(s: SpeechState) {
    this.state = s;
    this.ev.onState(s);
  }

  /** 每 250 毫秒看一眼：说过话以后安静太久、一直没人说话、说太长，自动收尾（时间从麦克风打开算） */
  private tick() {
    this.tickTimer = this.timers.set(() => {
      if (this.state !== "listening") return;
      if (this.micAt !== null) {
        const t = this.now();
        const quiet = this.heardAny ? t - this.lastVoice >= this.limits.silenceMs : t - this.micAt >= this.limits.noSpeechMs;
        if (quiet || t - this.micAt >= this.limits.maxMs) {
          this.stop();
          return;
        }
      }
      this.tick();
    }, 250);
  }
}

/** 浏览器里打开麦克风：AudioContext 要在点击里同步建（Safari 只认点击里建的），所以放在第一个 await 前面 */
export const openBrowserMic: OpenMic = async (onChunk) => {
  const ctx = new AudioContext();
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // 录音脚本取不到（网络抖了、登录过期被跳到登录页）单独说：按规范这时抛的也是 AbortError，不能说成麦克风被占着（复查）
    try {
      await ctx.audioWorklet.addModule("/audio/capture-worklet.js");
    } catch {
      throw new RecordError(RECORD_ERRORS.load);
    }
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "fencun-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // 接一个音量为 0 的出口到扬声器：有的浏览器不接到出口就不跑这个节点
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.port.onmessage = (e) => onChunk(e.data as Float32Array);
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const s = stream;
    return {
      sampleRate: ctx.sampleRate,
      close: () => {
        node.port.onmessage = null;
        src.disconnect();
        node.disconnect();
        mute.disconnect();
        for (const t of s.getTracks()) t.stop();
        void ctx.close().catch(() => {});
      },
    };
  } catch (e) {
    for (const t of stream?.getTracks() ?? []) t.stop();
    void ctx.close().catch(() => {});
    throw e;
  }
};

/** 这个浏览器能不能这样录：要有麦克风接口和 AudioWorklet（Edge、Chrome、Safari 14.1 起、Firefox 76 起都有） */
export function recordSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

/**
 * 几个中止信号合成一个、到点自己中止的信号。老一点的浏览器（Safari 17.4 以前、Chromium 116 以前、Firefox 124 以前）
 * 没有 AbortSignal.any / timeout，原来每次上传都失败、还一直让人「再说一次」（复查）
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => c.abort(s.reason), { once: true });
  }
  return c.signal;
}
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/** 发到 /api/play/asr 转文字；登录过期（401）和页面别处一样直接跳登录页 */
export const uploadWav: Upload = async (wav, signal) => {
  let res: Response;
  try {
    res = await fetch("/api/play/asr", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      // 直接发字节（不包成 Blob）：浏览器一样发，测试工具也读得到请求体
      body: wav as unknown as BodyInit,
      signal: anySignal([signal, timeoutSignal(20000)]),
    });
  } catch {
    throw new Error(RECORD_ERRORS.upload);
  }
  if (toLoginIfExpired(res.status)) throw new Error(EXPIRED_MESSAGE);
  const j = (await res.json().catch(() => null)) as { text?: string; simulated?: boolean; error?: string } | null;
  if (!res.ok) throw new Error(j?.error || RECORD_ERRORS.upload);
  return { text: j?.text ?? "", simulated: j?.simulated };
};
