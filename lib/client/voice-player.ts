// 浏览器端语音播放控制（主线程）：从服务端取放行句子的 PCM，送进 AudioWorklet 播放，并收集计量。
// 计量口径（规格 02 §4.2–4.4，全部是浏览器渲染层，不是扬声器实听）：
//   rendered            AudioWorklet 实际渲染过的源采样区间（上报给服务端，由服务端和违规区间求交集）；
//   first_audio_ms      收到本轮输入事件 → 第一个非静音采样被渲染（同一个浏览器时钟）；
//   cancel_to_stop_ms   收到截断/终止 → 主线程收到 worklet「已丢弃旧音频」的确认。确认之后不可能再渲染旧音频，所以这是上界；
//   cancel_to_mouth_zero_ms  收到截断/终止 → 下一帧画面里口型为 0。
// 截断按 epoch（代际）进行：先把 epoch 加一，再通知 worklet 丢弃旧块；之后才到的旧音频在主线程和 worklet 两处都会被丢掉。

import { union } from "@/lib/audio/intervals";
import type { SampleRange, UtteranceAudio } from "@/lib/domain/types";

export const PLAYER_SAMPLE_RATE = 24000;

interface UttState {
  uttId: string;
  turnId: string;
  epoch: number;
  rendered: SampleRange[];
  outcome?: UtteranceAudio["outcome"];
  abort: AbortController;
  cutAt?: number;
  stopAt?: number;
  mouthZeroAt?: number;
  settled: boolean;
  settle: () => void;
  done: Promise<void>;
}

interface TurnState {
  startedAt: number;
  firstAudioAt?: number;
  utts: string[];
}

export interface TurnPlaybackReport {
  turn_id: string;
  first_audio_ms?: number;
  utterances: {
    utterance_id: string;
    rendered: SampleRange[];
    outcome: UtteranceAudio["outcome"];
    cancel_to_stop_ms?: number;
    cancel_to_mouth_zero_ms?: number;
  }[];
}

type WorkletMessage =
  | { type: "render"; segments: { uttId: string; start: number; end: number }[]; rms: number }
  | { type: "started"; uttId: string; frame: number; frameNow: number }
  | { type: "ended"; uttId: string }
  | { type: "flushed"; token: number };

const round1 = (x: number) => Math.round(x * 10) / 10;

export class VoicePlayer {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private epoch = 0;
  private token = 0;
  private utts = new Map<string, UttState>();
  private turns = new Map<string, TurnState>();
  private flushing = new Map<number, UttState[]>();
  private rms = 0;
  private mouth = 0;
  /** 有错误时通知界面（取音频失败等） */
  onError?: (message: string) => void;
  /** 音频从哪里取：默认是体检运行的 /api/runs/<编号>/audio；闯关页换成 /api/play/audio（ADR-037） */
  audioUrl?: (runId: string, uttId: string) => string;

  get ready(): boolean {
    return this.ctx?.state === "running";
  }

  /**
   * 提前建好音频引擎（不需要用户点击：新建的 AudioContext 处于暂停状态，加载 worklet 也不需要点击）。
   * 这样点「开始体检」时只剩恢复播放这一步，第一轮的首声不再包含加载 worklet 的时间。
   */
  async prewarm(): Promise<void> {
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") return;
    await this.ensureGraph().catch(() => {});
  }

  /** 必须在用户点击的处理函数里调用：浏览器只允许用户操作后开始播放声音 */
  async unlock(): Promise<void> {
    if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") {
      throw new Error("这个浏览器不支持 AudioWorklet，不能播放语音。请换用新版 Edge 或 Chrome。");
    }
    await this.ensureGraph();
    if (this.ctx && this.ctx.state !== "running") await this.ctx.resume();
    if (this.ctx?.state !== "running") throw new Error("浏览器没有允许播放声音：请先在页面上点一下，再开始体检。");
  }

  private graphReady?: Promise<void>;

  private ensureGraph(): Promise<void> {
    this.graphReady ??= this.buildGraph().catch((e) => {
      this.graphReady = undefined;
      throw e;
    });
    return this.graphReady;
  }

  private async buildGraph(): Promise<void> {
    if (!this.ctx) {
      // AudioContext 和合成都用 24 kHz：渲染区间直接就是源采样坐标，不用换算（设备重采样发生在渲染之后）
      this.ctx = new AudioContext({ sampleRate: PLAYER_SAMPLE_RATE, latencyHint: "interactive" });
      await this.ctx.audioWorklet.addModule("/audio/player-worklet.js");
      this.node = new AudioWorkletNode(this.ctx, "shijinshi-player", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.onMessage(e.data);
      this.node.connect(this.ctx.destination);
    }
  }

  /** 收到本轮输入事件时调用：首声等待从这里开始计时 */
  beginTurn(turnId: string) {
    this.turns.set(turnId, { startedAt: performance.now(), utts: [] });
  }

  /** 一句话放行了：开始取它的音频并排进播放队列 */
  play(runId: string, turnId: string, uttId: string) {
    if (!this.node || this.utts.has(uttId)) return;
    if (!this.turns.has(turnId)) this.beginTurn(turnId);
    let resolve: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    const st: UttState = {
      uttId,
      turnId,
      epoch: this.epoch,
      rendered: [],
      abort: new AbortController(),
      settled: false,
      settle: () => {
        if (st.settled) return;
        st.settled = true;
        resolve();
      },
      done,
    };
    this.turns.get(turnId)?.utts.push(uttId);
    this.utts.set(uttId, st);
    void this.stream(runId, st);
  }

  private async stream(runId: string, st: UttState) {
    const node = this.node as AudioWorkletNode;
    try {
      const url = this.audioUrl ? this.audioUrl(runId, st.uttId) : `/api/runs/${runId}/audio?u=${encodeURIComponent(st.uttId)}`;
      const res = await fetch(url, { signal: st.abort.signal });
      if (!res.ok || !res.body) throw new Error(`取不到这句话的音频（${res.status}）`);
      const reader = res.body.getReader();
      let offset = 0;
      let carry: number | null = null; // 网络分块可能断在半个采样上
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (st.epoch < this.epoch) {
          await reader.cancel();
          return; // 已经被截断：之后到达的旧音频不再送去播放
        }
        let bytes = value;
        if (carry !== null) {
          const merged = new Uint8Array(bytes.length + 1);
          merged[0] = carry;
          merged.set(bytes, 1);
          bytes = merged;
          carry = null;
        }
        const n = bytes.length >> 1;
        if (bytes.length % 2) carry = bytes[bytes.length - 1];
        if (!n) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        node.port.postMessage({ type: "chunk", epoch: st.epoch, uttId: st.uttId, offset, samples }, [samples.buffer]);
        offset += n;
      }
      if (st.epoch < this.epoch) return;
      node.port.postMessage({ type: "end", epoch: st.epoch, uttId: st.uttId });
      if (offset === 0) {
        st.outcome = "not_played";
        st.settle();
      }
    } catch (e) {
      if (st.epoch < this.epoch || st.abort.signal.aborted) return; // 截断引起的中止，由 flushed 收尾
      st.outcome = "failed";
      st.settle();
      this.onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 截断（S3 护栏判违规）或终止：先提升 epoch，再让 worklet 丢弃所有旧音频，口型立即归零。
   * 截断时生成也已停止，所以队列里所有旧代际的音频都要丢掉，不只是被判违规的那一句。
   */
  cut(reason: "cut" | "cancelled") {
    const at = performance.now();
    this.epoch++;
    const affected = [...this.utts.values()].filter((u) => !u.settled && u.epoch < this.epoch);
    for (const u of affected) {
      u.cutAt = at;
      u.outcome = reason;
      u.abort.abort();
    }
    this.rms = 0;
    this.mouth = 0;
    const token = ++this.token;
    this.flushing.set(token, affected);
    this.node?.port.postMessage({ type: "flush", epoch: this.epoch, token });
    // 下一帧画面：形象组件在同一帧里先读口型（已是 0）再绘制，这里记下这一帧的时间
    requestAnimationFrame(() => {
      const t = performance.now();
      for (const u of affected) u.mouthZeroAt ??= t;
    });
    if (!this.node) for (const u of affected) u.settle();
  }

  /** 还有没放完的句子（这一代里还没结束的）：闯关页用它判断「她正在说」，一开口就打断她（ADR-037）。口型在字和字之间会落到 0，不能拿它判断 */
  speaking(): boolean {
    for (const u of this.utts.values()) if (!u.settled && u.epoch === this.epoch) return true;
    return false;
  }

  /** 形象每帧调用一次：按响度张嘴，平滑一下避免抖动 */
  mouthOpen(): number {
    const target = Math.min(1, this.rms * 7);
    this.mouth += (target - this.mouth) * 0.45;
    if (this.mouth < 0.02) this.mouth = 0;
    return this.mouth;
  }

  private onMessage(m: WorkletMessage) {
    if (m.type === "render") {
      for (const s of m.segments) {
        const u = this.utts.get(s.uttId);
        if (!u) continue;
        const last = u.rendered[u.rendered.length - 1];
        if (last && last[1] === s.start) last[1] = s.end;
        else u.rendered.push([s.start, s.end]);
      }
      // 截断确认回来之前，不再用旧音频的响度张嘴
      if (this.flushing.size === 0) this.rms = m.rms;
    } else if (m.type === "started") {
      const u = this.utts.get(m.uttId);
      const turn = u ? this.turns.get(u.turnId) : undefined;
      if (turn && turn.firstAudioAt === undefined && this.ctx) {
        // 主线程收到通知的时刻，减去这个采样到发通知之间的音频时长（同一个渲染块内，≤128 帧）
        turn.firstAudioAt = performance.now() - ((m.frameNow - m.frame) / this.ctx.sampleRate) * 1000;
      }
    } else if (m.type === "ended") {
      const u = this.utts.get(m.uttId);
      if (u && !u.settled) {
        u.outcome ??= "ended";
        u.settle();
      }
    } else if (m.type === "flushed") {
      const t = performance.now();
      for (const u of this.flushing.get(m.token) ?? []) {
        u.stopAt = t;
        u.settle();
      }
      this.flushing.delete(m.token);
    }
  }

  /** 服务端开始等本轮播放结果时调用：等这一轮所有句子播完或被截，返回要上报的计量 */
  async finishTurn(turnId: string, timeoutMs = 60_000): Promise<TurnPlaybackReport> {
    const turn = this.turns.get(turnId);
    const utts = (turn?.utts ?? []).map((id) => this.utts.get(id)).filter((u): u is UttState => Boolean(u));
    await Promise.race([Promise.all(utts.map((u) => u.done)), new Promise((r) => setTimeout(r, timeoutMs))]);
    const report: TurnPlaybackReport = {
      turn_id: turnId,
      first_audio_ms: turn?.firstAudioAt === undefined ? undefined : round1(turn.firstAudioAt - turn.startedAt),
      utterances: utts.map((u) => ({
        utterance_id: u.uttId,
        rendered: union(u.rendered),
        outcome: u.settled ? (u.outcome ?? "ended") : "failed",
        cancel_to_stop_ms: u.cutAt !== undefined && u.stopAt !== undefined ? round1(u.stopAt - u.cutAt) : undefined,
        cancel_to_mouth_zero_ms: u.cutAt !== undefined && u.mouthZeroAt !== undefined ? round1(u.mouthZeroAt - u.cutAt) : undefined,
      })),
    };
    for (const u of utts) this.utts.delete(u.uttId);
    this.turns.delete(turnId);
    return report;
  }

  /** 新的一次运行开始前清空状态（不关闭 AudioContext，免得再要一次用户点击） */
  reset() {
    this.cut("cancelled");
    this.utts.clear();
    this.turns.clear();
  }

  async close() {
    this.reset();
    await this.ctx?.close().catch(() => {});
    this.ctx = undefined;
    this.node = undefined;
    this.graphReady = undefined;
  }
}
