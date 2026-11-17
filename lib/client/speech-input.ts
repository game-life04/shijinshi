"use client";

// 对着麦克风套话（ADR-037，借 AIRI、Open-LLM-VTuber 的语音对话）：用浏览器自带的语音识别（Web Speech API）。
// 识别由浏览器做：Edge、Chrome 会把声音发到它们自己的识别服务；分寸这边不录音、不存音频，只收到认出来的文字。
// 不支持的浏览器（比如 Firefox）按钮是灰的，照样能打字。端到端测试在页面里换一个假的识别器（e2e/play-voice.spec.ts）。
//
// ADR-051（11-15 队员 B 试用：①一句话长一点（五个字以上）说到一半就停了，录下来的是半句；②一两个字说完想关麦，按钮点不动，
// 要等一会儿才关得上；③声音小一点，它就直接停下开始认了）。原因：原来用的是「说一句就停」（continuous = false），
// 浏览器听到一个停顿就当这句说完了；点「停」以后要等识别服务把最后结果送回来（onend）按钮才变回来。现在：
//   - 一直听，直到你点「说完了」：continuous = true；浏览器自己停了（有的浏览器连着模式也会在停顿后收工），只要你没点停、
//     最近还听到过声音，就新开一个识别器接着听，前面认好的字留着（SpeechSession 里的 committed）；
//   - 点「说完了」按钮当场变回「说」，后台等最后几个字认出来，最多等 1.5 秒，到点就用已经认出来的；
//   - 收尾的时候又点「说」：先把上一句认出来的交出去，再开新的一句；
//   - 兜底：6 秒没新声音、或者一直没听到声音 10 秒、或者一口气说满 60 秒，自动收尾。
// 识别会话的逻辑在 SpeechSession（不依赖 React，单元测试 tests/unit/speech-session.test.ts 用假识别器和假时钟测）。
//
// ADR-054（11-16）：接了真实模型时改成「录一整段，说完交给服务器转文字」（lib/client/recorder.ts 的 RecordSession，
// 服务端 /api/play/asr 用阿里云百炼的语音识别）。浏览器自带的识别只在模拟模式下用（端到端测试换假识别器测的就是它）。
// 原因见 recorder.ts 开头：Edge 连着听只回空字、一段一段听每段之间会丢字、Chrome 在国内连不上。

import { useCallback, useEffect, useRef, useState } from "react";
import { type OpenMic, openBrowserMic, RecordSession, recordSupported, type Upload, uploadAudio } from "./recorder";
import { ERRORS, retryable } from "./speech-messages";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** 什么时候自动收尾（毫秒） */
export const SPEECH_LIMITS = {
  /** 听到过声音以后，这么久没有新的声音、新的字，就当说完了 */
  silenceMs: 6000,
  /** 一直没听到声音，等这么久 */
  noSpeechMs: 10_000,
  /** 一口气最多说这么久 */
  maxMs: 60_000,
  /** 点了「说完了」以后，最多等最后几个字这么久 */
  finishMs: 1500,
  /** 浏览器自己停了以后，最多接着重开这么多次 */
  maxRestarts: 30,
};

/**
 * 能不能用「连着听」：安卓上的 Chrome 连着听时，后一段结果会带上前面的全文（老毛病，复查提醒），拼出来会重复；
 * 11-16 队员 B 说电脑上也「识别不了了」（换成连着听以后），所以现在哪里都不用连着听。
 */
export function continuousOk(): boolean {
  // ADR-053（11-16 队员 B 修改稿 3：「语音识别不了了」）：一律一段一段地听（每段是原来那种「说一句就停」，ADR-051 以前她用着是好的），
  // 靠「浏览器停了就重开」接着听，长句、停顿照样不断；连着听只在单元测试里还会用到（SpeechSession 的参数）
  return false;
}

export type SpeechState = "listening" | "finishing" | "idle";

export interface SpeechEvents {
  /** 到现在为止认出来的整句（final：这一句收尾了，不会再变） */
  onText: (text: string, final: boolean) => void;
  /** 这一句第一次听到声音 */
  onSpeechStart: () => void;
  onState: (s: SpeechState) => void;
  onError: (message: string) => void;
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** 说一句（可能跨好几个识别器）：start → 一直听 → stop（或者自动收尾）→ 交出整句 */
export class SpeechSession {
  private rec: Recognition | null = null;
  /** 前面几个识别器（浏览器自己停了又重开之前）认好的字 */
  private committed = "";
  /** 当前识别器里认定了的字 */
  private finalText = "";
  /** 当前识别器里还没认定的字 */
  private interim = "";
  private startedAt = 0;
  private lastHeard = 0;
  private heardAny = false;
  private spoke = false;
  private wantStop = false;
  private fatal: string | null = null;
  private noSpeech = false;
  private restarts = 0;
  private finishTimer: unknown = null;
  private tickTimer: unknown = null;
  state: SpeechState = "idle";

  constructor(
    private readonly C: RecognitionCtor,
    private readonly ev: SpeechEvents,
    private readonly now: () => number = () => Date.now(),
    private readonly limits = SPEECH_LIMITS,
    private readonly timers: Timers = realTimers,
    private readonly continuous: boolean = continuousOk(),
  ) {}

  /** 开始听；浏览器不让开（start 抛错）时原样抛出 */
  start() {
    this.startedAt = this.lastHeard = this.now();
    this.spawn();
    this.setState("listening");
    this.tick();
  }

  /** 到现在为止认出来的整句 */
  text(): string {
    return (this.committed + this.finalText + this.interim).trim();
  }

  /** 点了「说完了」：按钮当场变回来；后台等最后几个字，最多 finishMs */
  stop() {
    if (this.state !== "listening") return;
    this.wantStop = true;
    this.setState("finishing");
    this.timers.clear(this.tickTimer);
    this.finishTimer = this.timers.set(() => this.finish(), this.limits.finishMs);
    try {
      this.rec?.stop();
    } catch {
      this.finish();
    }
  }

  /** 现在就收尾：认出来多少交多少（收尾时又点了「说」、等最后几个字等到点了、识别器停了） */
  finish() {
    if (this.state === "idle") return;
    this.close();
    if (this.fatal) this.ev.onError(this.fatal);
    else if (this.noSpeech && !this.text()) this.ev.onError(ERRORS["no-speech"]);
    this.ev.onText(this.text(), true);
  }

  /** 不要了（发出去了、离开页面）：停掉，认出来的也不交 */
  cancel() {
    if (this.state === "idle") return;
    this.close();
  }

  private close() {
    this.timers.clear(this.finishTimer);
    this.timers.clear(this.tickTimer);
    const r = this.rec;
    this.rec = null;
    if (r) {
      r.onresult = null;
      r.onspeechstart = null;
      r.onerror = null;
      r.onend = null;
      try {
        r.abort();
      } catch {
        // 已经停了
      }
    }
    this.setState("idle");
  }

  private setState(s: SpeechState) {
    if (this.state === s) return;
    this.state = s;
    this.ev.onState(s);
  }

  private heard(withText: boolean) {
    this.lastHeard = this.now();
    if (withText) this.heardAny = true;
    if (!this.spoke) {
      this.spoke = true;
      this.ev.onSpeechStart();
    }
  }

  private spawn() {
    const r = new this.C();
    r.lang = "zh-CN";
    r.interimResults = true;
    r.continuous = this.continuous;
    r.maxAlternatives = 1;
    this.finalText = "";
    this.interim = "";
    // 只认当前这个识别器：重开以后旧的那个要是还送东西来，不理（复查：会和前面认好的字重复，晚到的出错也会把新的标成出错）
    r.onspeechstart = () => {
      if (this.rec === r) this.heard(false);
    };
    r.onresult = (e) => {
      if (this.rec !== r) return;
      // 连着模式下 results 是这个识别器开始以来的全部结果：每次从头拼，不靠 resultIndex。
      // 有的浏览器后一段认定的结果会带上前面的全文（安卓 Chrome）：开头就是已经拼好的那一长段时，用后一段换掉，不重复拼
      let f = "";
      let i = "";
      for (let k = 0; k < e.results.length; k++) {
        const res = e.results[k];
        const t = res[0].transcript;
        if (!res.isFinal) i += t;
        else f = f.length >= 6 && t.startsWith(f) ? t : f + t;
      }
      const changed = f !== this.finalText || i !== this.interim;
      this.finalText = f;
      this.interim = i;
      if (changed && (f || i)) this.heard(true);
      if (this.state !== "idle") this.ev.onText(this.text(), false);
    };
    r.onerror = (e) => {
      if (this.rec !== r || e.error === "aborted") return;
      if (e.error === "no-speech") {
        this.noSpeech = true;
        return;
      }
      // 不认识的错误码不直接露英文（复查）：给能照着做的话，代码放在括号里方便反馈
      this.fatal = ERRORS[e.error] ?? `语音识别出错了（${e.error}）：换 Edge 浏览器试试，或者直接打字`;
    };
    r.onend = () => {
      if (this.rec !== r) return;
      // 这个识别器停了：它认出来的（连同没认定的半截）都留下
      this.committed += this.finalText + this.interim;
      this.finalText = "";
      this.interim = "";
      if (this.shouldRestart()) {
        this.restarts++;
        try {
          this.spawn();
          return;
        } catch {
          // 重开不了就收尾
        }
      }
      this.finish();
    };
    this.rec = r;
    r.start();
  }

  private shouldRestart(): boolean {
    if (this.wantStop || this.fatal || this.state !== "listening") return false;
    if (this.restarts >= this.limits.maxRestarts) return false;
    const t = this.now();
    if (t - this.startedAt >= this.limits.maxMs) return false;
    return this.heardAny ? t - this.lastHeard < this.limits.silenceMs : t - this.startedAt < this.limits.noSpeechMs;
  }

  /** 每半秒看一眼：太久没声音、说得太长，自动收尾（和点了「说完了」一样） */
  private tick() {
    this.tickTimer = this.timers.set(() => {
      if (this.state !== "listening") return;
      const t = this.now();
      const quiet = this.heardAny ? t - this.lastHeard >= this.limits.silenceMs : t - this.startedAt >= this.limits.noSpeechMs;
      if (quiet && !this.heardAny) this.noSpeech = true;
      if (quiet || t - this.startedAt >= this.limits.maxMs) {
        this.stop();
        return;
      }
      this.tick();
    }, 500);
  }
}

/**
 * 说一句：start() 开始听，一直听到 stop()（按钮「说完了」）或自动收尾；听的过程中认出来的字交给 onInterim（显示在输入框里），
 * 收尾时整句交给 onFinal。onSpeechStart：一开口就回调（她正在说话的话，页面在这里把她打断）。
 * listening：在听（按钮写「说完了」）；finishing：点了「说完了」、在等最后几个字（按钮已经变回「说」，可以马上再点）。
 */
/** 「说」用哪一种：server 录一整段发去转文字（ADR-054）；browser 浏览器自带识别 */
export type SpeechEngine = "server" | "browser";

/** 两种会话共用的样子 */
interface Listening {
  state: SpeechState;
  start: () => void;
  stop: () => void;
  finish: () => void;
  cancel: () => void;
}

export function useSpeechInput(o: {
  onFinal: (text: string) => void;
  onInterim?: (text: string) => void;
  onSpeechStart?: () => void;
  /** 用哪一种；null = 还不知道（页面在问服务器），这时候按钮先灰着。不传就是浏览器自带的 */
  engine?: SpeechEngine | null;
  /** 只给测试换的：打开麦克风、上传 */
  openMic?: OpenMic;
  upload?: Upload;
}) {
  const engine = o.engine === undefined ? "browser" : o.engine;
  // null：页面还没在浏览器里准备好、或者还不知道用哪一种（这时候按钮先灰着）；准备好以后是 true / false。
  // 不能一开始就当成 false：ADR-053 复查后「不支持」时按钮也能点（点了给说明），页面刚打开那一下点上去会误报「不支持」
  const [supported, setSupported] = useState<boolean | null>(null);
  const [state, setState] = useState<SpeechState>("idle");
  const [error, setError] = useState<string | null>(null);
  /** 录音时的响度（0～1，只在 server 那种里有），给「在听」的小红点跟着变大变小 */
  const [level, setLevel] = useState(0);
  /** 模拟模式下的说明（填进去的是写好的一句） */
  const [note, setNote] = useState<string | null>(null);
  /** 录音那种：麦克风真正开始收到声音了（小红点这时才变红，看得出可以开口了） */
  const [micReady, setMicReady] = useState(false);
  const session = useRef<Listening | null>(null);
  const cb = useRef(o);
  cb.current = o;

  useEffect(() => {
    if (engine === null) setSupported(null);
    else setSupported(engine === "server" ? recordSupported() : Boolean(ctor()));
  }, [engine]);
  useEffect(() => () => session.current?.cancel(), []);

  /** 上一句还在收尾（等最后几个字）：现在就交出来 */
  const flush = useCallback(() => {
    const s = session.current;
    if (s?.state === "finishing") s.finish();
  }, []);

  const start = useCallback(() => {
    const C = ctor();
    if (engine === null || (engine === "browser" && !C)) return;
    const cur = session.current;
    if (cur?.state === "listening") return;
    // 录音那种：上一段还在转文字时不开新的一段（页面上「说」这时是灰的）。
    // 复查：原来点了就开，上一段回来时接在点「说」那一刻的框内文字后面，下一段回来又把它盖掉
    if (cur?.state === "finishing" && engine === "server") return;
    if (cur?.state === "finishing") cur.finish();
    setError(null);
    setNote(null);
    setLevel(0);
    setMicReady(false);
    let s: Listening | null = null;
    const events = {
      onText: (t: string, final: boolean) => {
        if (final) {
          if (t) cb.current.onFinal(t);
        } else if (session.current === s) cb.current.onInterim?.(t);
      },
      onSpeechStart: () => {
        if (session.current === s) cb.current.onSpeechStart?.();
      },
      onState: (st: SpeechState) => {
        if (session.current === s) setState(st);
        if (st !== "listening" && session.current === s) setLevel(0);
      },
      // 只认当前这一句：被顶掉的旧会话晚到的错不往页面上报（复查）
      onError: (m: string) => {
        if (session.current === s) setError(m);
      },
      onLevel: (v: number) => {
        if (session.current !== s) return;
        setMicReady(true);
        // 一秒二十来次；只在变化明显时更新，省得整页跟着重画
        setLevel((x) => (Math.abs(x - v) < 0.01 ? x : v));
      },
      onNote: (m: string) => {
        if (session.current === s) setNote(m);
      },
    };
    s =
      engine === "server"
        ? new RecordSession(events, cb.current.openMic ?? openBrowserMic, cb.current.upload ?? uploadAudio)
        : new SpeechSession(C as RecognitionCtor, events);
    session.current = s;
    try {
      s.start();
    } catch (e) {
      s.cancel();
      session.current = null;
      setState("idle");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [engine]);

  const stop = useCallback(() => session.current?.stop(), []);
  /** 不要这一句了（已经点了「发送」）：停掉，后面认出来的也不往输入框里填 */
  const cancel = useCallback(() => {
    session.current?.cancel();
    session.current = null;
    setState("idle");
    // 上一次语音出的错也不留着（复查：报过「没听到声音」以后改成打字发送、换关，那行红字一直挂着）
    setError(null);
    setNote(null);
    setLevel(0);
  }, []);

  return {
    supported,
    listening: state === "listening",
    finishing: state === "finishing",
    error,
    /** 这个错再说一次可能就好（没听到、没听清、一时没连上）；麦克风权限、浏览器不支持这些，再点也是一样的错，不给「再说一次」 */
    canRetry: retryable(error),
    level,
    micReady,
    note,
    engine,
    start,
    stop,
    flush,
    cancel,
  };
}

/**
 * 认出来的话接在输入框原有的字后面（再点一次「说」接着讲、先打了几个字再说，都不盖掉）；
 * 原来的字（去掉末尾空格）没以标点结尾时补一个逗号；最多 200 字，和输入框一样。
 */
export function joinSpeech(base: string, heard: string): string {
  const b = base.trimEnd();
  if (!b) return heard.slice(0, 200);
  const sep = /[，。！？、；：,.!?;:]$/.test(b) ? "" : "，";
  return `${b}${sep}${heard}`.slice(0, 200);
}
