// 一次运行的语音缓存：句子的合成音频先留在服务端，句子放行以后浏览器才能取到。
// 三种放行策略在这里的差别只是「什么时候开始合成」（规格 02 E2）：
//   S1 先审后播：护栏通过、句子放行时才开始合成；
//   S2 边审边合成：句子一生成就开始合成，和护栏检查同时进行；通过才放出缓存，没通过就丢掉、不发给浏览器；
//   S3 先播后截：句子先放行（同时合成），护栏随后检查，发现违规再让浏览器掐断。
// 浏览器只能取已放行的句子；被拦下或被截的句子会停止合成。

import { type Synthesis, synthesize } from "./tts";

interface Entry {
  text: string;
  synth: Synthesis;
  chunks: Int16Array[];
  samples: number;
  done: boolean;
  error?: string;
  released: boolean;
  discarded: boolean;
  abort: AbortController;
  wake: Set<() => void>;
  preparedAt: number;
  firstChunkAt?: number;
}

export interface AudioInfo {
  level: Synthesis["level"];
  model: string;
  sampleRate: number;
  charRanges: Synthesis["charRanges"];
  totalSamples: number | null;
  /** 从开始合成到第一块音频就绪（服务端计时） */
  firstChunkMs?: number;
}

export class AudioStore {
  private entries = new Map<string, Entry>();
  /** 本次运行送去合成的字数（计费口径） */
  chars = 0;

  /** 开始合成（同一句只合成一次） */
  prepare(uttId: string, text: string) {
    if (this.entries.has(uttId) || !text.trim()) return;
    const abort = new AbortController();
    const e: Entry = {
      text,
      synth: synthesize(text, abort.signal),
      chunks: [],
      samples: 0,
      done: false,
      released: false,
      discarded: false,
      abort,
      wake: new Set(),
      preparedAt: performance.now(),
    };
    this.entries.set(uttId, e);
    this.chars += text.length;
    void this.pump(e);
  }

  private async pump(e: Entry) {
    try {
      for await (const c of e.synth.chunks) {
        if (e.discarded) break;
        e.chunks.push(c);
        e.samples += c.length;
        e.firstChunkAt ??= performance.now();
        this.notify(e);
      }
    } catch (err) {
      if (!e.discarded) e.error = err instanceof Error ? err.message : String(err);
    } finally {
      e.done = true;
      this.notify(e);
    }
  }

  private notify(e: Entry) {
    for (const w of e.wake) w();
    e.wake.clear();
  }

  release(uttId: string) {
    const e = this.entries.get(uttId);
    if (!e) return;
    e.released = true;
    this.notify(e);
  }

  /** 拦下或截断：停止合成，丢掉缓存 */
  discard(uttId: string) {
    const e = this.entries.get(uttId);
    if (!e || e.discarded) return;
    e.discarded = true;
    e.abort.abort();
    e.chunks = [];
    this.notify(e);
  }

  isReleased(uttId: string): boolean {
    return Boolean(this.entries.get(uttId)?.released);
  }

  info(uttId: string): AudioInfo | null {
    const e = this.entries.get(uttId);
    if (!e) return null;
    return {
      level: e.synth.level,
      model: e.synth.model,
      sampleRate: e.synth.sampleRate,
      charRanges: e.synth.charRanges,
      totalSamples: e.synth.totalSamples ?? (e.done ? e.samples : null),
      firstChunkMs: e.firstChunkAt === undefined ? undefined : Math.round(e.firstChunkAt - e.preparedAt),
    };
  }

  /** 浏览器取音频：先交出已缓存的块，再跟着合成进度往下交。未放行的句子返回 null */
  open(uttId: string): ReadableStream<Uint8Array> | null {
    const e = this.entries.get(uttId);
    if (!e || !e.released || e.discarded) return null;
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (true) {
          if (e.discarded) return controller.close();
          if (i < e.chunks.length) {
            const c = e.chunks[i++];
            controller.enqueue(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
            return;
          }
          if (e.done) return e.error ? controller.error(new Error(e.error)) : controller.close();
          await new Promise<void>((r) => e.wake.add(r));
        }
      },
    });
  }

  abortAll() {
    for (const id of this.entries.keys()) this.discard(id);
  }

  clear() {
    this.abortAll();
    this.entries.clear();
  }
}
