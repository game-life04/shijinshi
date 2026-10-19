// AudioWorklet 处理器：在音频线程里按顺序播放各句的 PCM，并把「实际渲染了哪些采样」报给主线程。
// 主线程 → 这里：chunk（一块音频）、end（这句没有更多音频）、flush（提升 epoch，丢弃旧音频）。
// 这里 → 主线程：render（每 4 个处理块一次：渲染分段 + 响度）、started（首个非静音采样）、ended（一句播完）、flushed（已停止旧音频）。
// 上报 started/ended/flushed 之前先把攒着的渲染分段发出去，主线程拿到「播完」时，渲染区间一定已经完整。

import { PlaybackCore } from "./playback-core.js";

const REPORT_EVERY = 4;

class ShijinshiPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new PlaybackCore();
    this.pending = [];
    this.sumSq = 0;
    this.count = 0;
    this.blocks = 0;
    this.lastRms = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "chunk") this.core.push(m);
      else if (m.type === "end") {
        if (this.core.end(m)) {
          this.report();
          this.port.postMessage({ type: "ended", uttId: m.uttId, frame: currentFrame });
        }
      } else if (m.type === "flush") {
        const dropped = this.core.flush(m.epoch);
        this.report();
        this.port.postMessage({ type: "flushed", epoch: m.epoch, token: m.token, frame: currentFrame, dropped });
      }
    };
  }

  /** 把攒着的渲染分段和响度发给主线程 */
  report() {
    const rms = this.count ? Math.sqrt(this.sumSq / this.count) : 0;
    if (this.pending.length || rms > 0 || this.lastRms > 0) {
      this.port.postMessage({ type: "render", segments: this.pending, rms, frameNow: currentFrame });
    }
    this.lastRms = rms;
    this.pending = [];
    this.sumSq = 0;
    this.count = 0;
    this.blocks = 0;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const ch = out[0];
    const r = this.core.render(ch, currentFrame);
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    for (const s of r.segments) this.pending.push(s);
    this.sumSq += r.sumSq;
    this.count += ch.length;
    this.blocks++;
    if (r.started.length || r.finished.length || this.blocks >= REPORT_EVERY) this.report();
    for (const s of r.started) this.port.postMessage({ type: "started", ...s, frameNow: currentFrame + ch.length });
    for (const u of r.finished) this.port.postMessage({ type: "ended", uttId: u, frame: currentFrame + ch.length });
    return true;
  }
}

registerProcessor("shijinshi-player", ShijinshiPlayer);
