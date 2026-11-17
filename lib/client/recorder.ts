// 「说」的第二种做法（ADR-054，11-16）：录一整段，说完交给服务器转成文字（/api/play/asr，服务端用阿里云百炼的语音识别）。
// 浏览器自带的识别：Edge「连着听」只回空字；「一段一段听」每段之间要 0.3～1 秒才重新收音，句子中间会丢字；
// Chrome 连谷歌的服务，国内连不上。录一整段中间不断，哪个浏览器都一样。和 SpeechSession 一样的用法（开始、说完了、不要了），
// 一样的回调（onText 只在最后交一次整句），页面不用管是哪一种。
// 听没听到人说话按响度算：响度连着过门槛约 0.15 秒就算开口（顺带用来「你一开口就打断她」）；门槛按刚打开麦克风时的底噪定。
// 说过以后安静 4 秒、一直没说 10 秒、说满 30 秒都自动收尾（和点「说完了」一样）；几个时间都从麦克风真正打开时算
// （复查：原来从点「说」算，第一次用时权限弹窗看了 10 秒，一点「允许」就报没听到）。
// 没算上开口、但录到了一点声音（最响的一段过了很低的底），收尾时照样交去认，空不空让识别去判
// （复查：麦克风增益低、离得远时，小红点在动却说「没听到声音」，再说一次还是一样）。
// 11-17 起浏览器支持时（Edge、Chrome、Firefox）另外同时压一份 WebM（Opus），说完先传压缩的（30 秒约 120 KB，WAV 约 0.96 MB）：
// 线上「说完了」到出字要 5～10 秒，大半耗在传这近 1 MB 上。服务端认不出、嫌太长，或者压缩那份没拿到，就改传 WAV。

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

/** 压缩过的一段录音 */
export interface Compressed {
  data: Uint8Array;
  mime: string;
}
/** 开着的麦克风：采样率、关掉；finish：收尾，交出同时压好的那一份再关掉（浏览器不支持压缩时没有这一项） */
export interface Mic {
  sampleRate: number;
  close: () => void;
  finish?: () => Promise<Compressed | null>;
}
/** 打开麦克风，每来一段声音调一次 onChunk */
export type OpenMic = (onChunk: (samples: Float32Array) => void) => Promise<Mic>;
/** 把录音发去转文字（mime：audio/webm 或 audio/wav） */
export type Upload = (audio: Uint8Array, mime: string, signal: AbortSignal) => Promise<{ text: string; simulated?: boolean }>;

/** 服务端不收压缩的这一份（认不出、太长）：改传 WAV */
export class FormatRejected extends Error {}

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
  /** 有声音（过了很低的底，比开口门槛低）：自动收尾看这个，不看开口门槛（复查：声音轻的人原来说到第 10 秒就被截掉） */
  private soundAny = false;
  private lastSound = 0;
  /** 量出来的底噪 */
  private floor = 0;
  private peak = 0;
  /** 开头那一小会儿各段的响度（量底噪）；量完了是 null */
  private floorLevels: number[] | null = [];
  private threshold: number;
  private cancelled = false;
  /** 收尾时在等它交出压缩那一份的麦克风：这时不要了，当场关掉（复查：原来要等那一份交出来，指示灯最多多亮 2 秒） */
  private closing: Mic | null = null;
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
        this.floor = Math.min(...this.floorLevels);
        this.threshold = Math.min(this.limits.voiceRmsMax, Math.max(this.limits.voiceRmsMin, this.floor * 3));
        this.floorLevels = null;
      }
    }
    // 有声音：底噪量出来以后，过了很低的底、又比底噪响一半以上（吵的房间里底噪本身不算）
    if (this.floorLevels === null && level >= Math.max(this.limits.faintRms, this.floor * 1.5)) {
      this.soundAny = true;
      this.lastSound = t;
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
    const mic = this.mic;
    this.mic = null;
    let samples = concat(this.chunks);
    this.chunks = [];
    // 收尾时多录的那一点（定时器每 250 毫秒看一次、页面忙时更晚）截掉：发出去的不超过 maxMs
    const max = Math.round((this.rate * this.limits.maxMs) / 1000);
    if (samples.length > max) samples = samples.subarray(0, max);
    const ms = (samples.length / this.rate) * 1000;
    if (ms < this.limits.minMs || !(this.heardAny || this.peak >= this.limits.faintRms)) {
      mic?.close();
      this.setState("idle");
      this.ev.onError(ERRORS["no-speech"]);
      this.ev.onText("", true);
      return;
    }
    this.setState("finishing");
    const abort = new AbortController();
    this.abort = abort;
    const rate = this.rate;
    const wav = () => this.upload(encodeWav(resample(samples, rate, 16000), 16000), "audio/wav", abort.signal);
    // 有压缩的那一份先传它；服务端不收（FormatRejected）、没拿到，传 WAV。别的错（没连上、限流）不重传，照常报
    const compressed: Promise<Compressed | null> = mic?.finish ? mic.finish().catch(() => null) : Promise.resolve(null);
    if (mic?.finish) this.closing = mic;
    else mic?.close();
    compressed
      .then((c) => {
        this.closing = null;
        if (this.cancelled) return { text: "", simulated: false };
        if (!c) return wav();
        return this.upload(c.data, c.mime, abort.signal).catch((e) => {
          if (e instanceof FormatRejected && !this.cancelled) return wav();
          throw e;
        });
      })
      .then(
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
    this.closing?.close();
    this.closing = null;
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
        const active = this.heardAny || this.soundAny;
        const last = Math.max(this.heardAny ? this.lastVoice : 0, this.soundAny ? this.lastSound : 0);
        const quiet = active ? t - last >= this.limits.silenceMs : t - this.micAt >= this.limits.noSpeechMs;
        if (quiet || t - this.micAt >= this.limits.maxMs) {
          this.stop();
          return;
        }
      }
      this.tick();
    }, 250);
  }
}

/**
 * 录音脚本（AudioWorklet）的代码：直接打包在页面里，用的时候生成一个 blob 地址交给浏览器（ADR-054 线上核对）。
 * 原来点「说」以后才去服务器取 /audio/capture-worklet.js，线上要 3 秒左右，这段时间没在收音，点完马上开口，
 * 头几个字就丢了（线上用 8 秒录音核对，只录进了后 5.4 秒）。public/audio/capture-worklet.js 留着同一份，
 * 浏览器不认 blob 地址时退回去取它（tests/unit/record-session.test.ts 核对两份一样）。
 */
export const CAPTURE_WORKLET_SOURCE = `class FencunCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      let i = 0;
      while (i < ch.length) {
        const take = Math.min(ch.length - i, this.buf.length - this.n);
        this.buf.set(ch.subarray(i, i + take), this.n);
        this.n += take;
        i += take;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("fencun-capture", FencunCapture);
`;
let workletUrl: string | null = null;
async function loadCaptureWorklet(ctx: AudioContext): Promise<void> {
  try {
    workletUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
  } catch {
    // 录音脚本取不到（网络抖了、登录过期被跳到登录页）单独说：按规范这时抛的也是 AbortError，不能说成麦克风被占着（复查）
    try {
      await ctx.audioWorklet.addModule("/audio/capture-worklet.js");
    } catch {
      throw new RecordError(RECORD_ERRORS.load);
    }
  }
}

/**
 * 浏览器里打开麦克风：AudioContext 要在点击里同步建（Safari 只认点击里建的），所以放在第一个 await 前面；
 * 要麦克风权限和装录音脚本同时做（原来一前一后）
 */
export const openBrowserMic: OpenMic = async (onChunk) => {
  const ctx = new AudioContext();
  let stream: MediaStream | null = null;
  try {
    const gum = navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const load = loadCaptureWorklet(ctx);
    // 麦克风先出错时，脚本那边的失败不再另外报（下面的 catch 只报麦克风的原因）
    load.catch(() => {});
    stream = await gum;
    // 拿到了麦克风、脚本却装不上：抛出去以后下面的 catch 会把麦克风关掉，指示灯不会一直亮
    await load;
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
    // 和收音同时开始压（同一路麦克风）；压不了就只有 WAV
    const packed = startCompressed(s);
    let capturing = true;
    let released = false;
    /** 不再收音（响度、WAV 那一份到此为止） */
    const stopCapture = () => {
      if (!capturing) return;
      capturing = false;
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      mute.disconnect();
    };
    /** 关掉麦克风（指示灯灭） */
    const release = () => {
      if (released) return;
      released = true;
      for (const t of s.getTracks()) t.stop();
      void ctx.close().catch(() => {});
    };
    return {
      sampleRate: ctx.sampleRate,
      close: () => {
        packed?.cancel();
        stopCapture();
        release();
      },
      // 收尾：先停收音，等压缩的那一份交出来再关麦克风（先关麦克风，最后一点可能就没了）
      finish: packed
        ? () => {
            stopCapture();
            return packed.finish().finally(release);
          }
        : undefined,
    };
  } catch (e) {
    for (const t of stream?.getTracks() ?? []) t.stop();
    void ctx.close().catch(() => {});
    throw e;
  }
};

/** 压成哪种：只用 WebM 的 Opus（服务端只认这一种）；浏览器不支持（比如老一点的 Safari 只有 mp4）就只传 WAV */
export function compressedType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : null;
}

/**
 * 同时压一份 WebM（Opus，每秒 32 千比特，一秒约 4 KB）。说完调 finish：等录音器把最后一点交出来（最多等 2 秒），
 * 拿不到就交 null（改传 WAV）。cancel：不要了，直接停
 */
function startCompressed(stream: MediaStream): { finish: () => Promise<Compressed | null>; cancel: () => void } | null {
  const type = compressedType();
  if (!type) return null;
  let rec: MediaRecorder;
  const parts: Blob[] = [];
  try {
    rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 32000 });
    rec.ondataavailable = (e) => {
      if (e.data.size) parts.push(e.data);
    };
    rec.start();
  } catch {
    return null;
  }
  /** 还在等的那次 finish：cancel 时直接交 null */
  let pending: ((v: Compressed | null) => void) | null = null;
  return {
    finish: () =>
      new Promise<Compressed | null>((resolve) => {
        let done = false;
        const end = (v: Compressed | null) => {
          if (done) return;
          done = true;
          pending = null;
          clearTimeout(timer);
          resolve(v);
        };
        pending = end;
        const timer = setTimeout(() => end(null), 2000);
        rec.onerror = () => end(null);
        rec.onstop = () => {
          new Blob(parts, { type: "audio/webm" }).arrayBuffer().then(
            (b) => end(b.byteLength ? { data: new Uint8Array(b), mime: "audio/webm" } : null),
            () => end(null),
          );
        };
        try {
          if (rec.state === "inactive") end(null);
          else rec.stop();
        } catch {
          end(null);
        }
      }),
    cancel: () => {
      rec.ondataavailable = null;
      rec.onstop = null;
      try {
        if (rec.state !== "inactive") rec.stop();
      } catch {
        // 已经停了
      }
      pending?.(null);
    },
  };
}

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

/**
 * 发到 /api/play/asr 转文字；登录过期（401）和页面别处一样直接跳登录页。
 * 压缩的那一份被服务端拒了（认不出 400、太长 413）抛 FormatRejected，好让会话改传 WAV
 */
export const uploadAudio: Upload = async (audio, mime, signal) => {
  let res: Response;
  try {
    res = await fetch("/api/play/asr", {
      method: "POST",
      headers: { "Content-Type": mime },
      // 直接发字节（不包成 Blob）：浏览器一样发，测试工具也读得到请求体
      body: audio as unknown as BodyInit,
      signal: anySignal([signal, timeoutSignal(20000)]),
    });
  } catch {
    throw new Error(RECORD_ERRORS.upload);
  }
  if (toLoginIfExpired(res.status)) throw new Error(EXPIRED_MESSAGE);
  const j = (await res.json().catch(() => null)) as { text?: string; simulated?: boolean; error?: string } | null;
  if (!res.ok && mime !== "audio/wav" && (res.status === 400 || res.status === 413 || res.status === 415))
    throw new FormatRejected(j?.error || RECORD_ERRORS.upload);
  if (!res.ok) throw new Error(j?.error || RECORD_ERRORS.upload);
  return { text: j?.text ?? "", simulated: j?.simulated };
};
