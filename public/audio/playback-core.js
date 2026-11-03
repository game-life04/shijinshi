// AudioWorklet 播放队列的核心逻辑（纯 JS，不依赖浏览器，单元测试直接调用）。
// 规则（规格 01 §3.7「取消以 epoch 为边界」）：
//   - 每块音频带 epoch（代际）。flush(新 epoch) 之后，旧 epoch 的块立即丢弃，之后再到的旧块也一律不收，
//     所以「取消后才到达的旧音频」不可能重新开始播放；
//   - 每次渲染都记下实际送进输出的源采样区间 [start, end)，按句子分段上报，用来算违规音频渲染时长；
//   - 记下每句第一个非静音采样被渲染的位置，用来算首声等待。

/** 低于这个幅度算静音（约 -60 dBFS） */
export const SILENCE = 1e-3;

export class PlaybackCore {
  constructor() {
    this.epoch = 0;
    /** @type {{epoch:number, uttId:string, offset:number, samples:Float32Array, pos:number}[]} */
    this.queue = [];
    /** 已经收到「这句没有更多音频」的句子 */
    this.ended = new Set();
    /**
     * 已经渲染出第一个非静音采样的句子，按「代际:句子编号」记：
     * 同一个句子编号在新的代际里重新播放（例如同一用例再跑一次），要重新报一次开口
     */
    this.started = new Set();
  }

  /**
   * 收一块音频。旧 epoch 的块直接丢弃，返回 false。
   * @param {{epoch:number, uttId:string, offset:number, samples:Float32Array}} c
   */
  push(c) {
    if (c.epoch < this.epoch) return false;
    this.queue.push({ epoch: c.epoch, uttId: c.uttId, offset: c.offset, samples: c.samples, pos: 0 });
    return true;
  }

  /**
   * 这句话的音频已经全部送来。如果它在队列里已经播完，返回 true（调用方马上上报「播完」）。
   * @param {{epoch:number, uttId:string}} m
   */
  end(m) {
    if (m.epoch < this.epoch) return false;
    if (this.queue.some((q) => q.uttId === m.uttId)) {
      this.ended.add(m.uttId);
      return false;
    }
    return true;
  }

  /**
   * 提升 epoch，丢掉所有旧块。返回丢掉的、还没渲染的采样数。
   * @param {number} epoch
   */
  flush(epoch) {
    if (epoch > this.epoch) this.epoch = epoch;
    let dropped = 0;
    this.queue = this.queue.filter((q) => {
      if (q.epoch >= this.epoch) return true;
      dropped += q.samples.length - q.pos;
      this.ended.delete(q.uttId);
      return false;
    });
    return dropped;
  }

  /**
   * 渲染一个处理块（通常 128 帧）。没有音频的部分填 0。
   * @param {Float32Array} out
   * @param {number} frame 这个块第一个采样在 AudioContext 里的帧号
   */
  render(out, frame) {
    /** @type {{uttId:string, start:number, end:number, frame:number}[]} */
    const segments = [];
    /** @type {{uttId:string, offset:number, frame:number}[]} */
    const started = [];
    /** @type {string[]} */
    const finished = [];
    let sumSq = 0;
    let i = 0;
    while (i < out.length && this.queue.length) {
      const c = this.queue[0];
      const n = Math.min(out.length - i, c.samples.length - c.pos);
      for (let k = 0; k < n; k++) {
        const v = c.samples[c.pos + k];
        out[i + k] = v;
        sumSq += v * v;
        if (Math.abs(v) > SILENCE && !this.started.has(`${c.epoch}:${c.uttId}`)) {
          this.started.add(`${c.epoch}:${c.uttId}`);
          started.push({ uttId: c.uttId, offset: c.offset + c.pos + k, frame: frame + i + k });
        }
      }
      if (n > 0) segments.push({ uttId: c.uttId, start: c.offset + c.pos, end: c.offset + c.pos + n, frame: frame + i });
      c.pos += n;
      i += n;
      if (c.pos >= c.samples.length) {
        this.queue.shift();
        if (this.ended.has(c.uttId) && !this.queue.some((q) => q.uttId === c.uttId)) {
          this.ended.delete(c.uttId);
          finished.push(c.uttId);
        }
      }
    }
    out.fill(0, i);
    return { segments, started, finished, sumSq, filled: i };
  }
}
