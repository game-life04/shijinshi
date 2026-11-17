// AudioWorklet 播放队列的核心逻辑（纯 JS，不依赖浏览器，单元测试直接调用）。
// 规则（规格 01 §3.7「取消以 epoch 为边界」）：
//   - 每块音频带 epoch（代际）。flush(新 epoch) 之后，旧 epoch 的块立即丢弃，之后再到的旧块也一律不收，
//     所以「取消后才到达的旧音频」不可能重新开始播放；
//   - 按句子排队，播放顺序 = 排队的先后（主线程调用 play() 的顺序），不看哪句的音频先到。
//     一轮里几句话同时在下载，线上（HTTP/2 多路复用、网速慢）各句的网络分块是交错着到的：
//     只从排在最前面的那句取音频，它暂时没有音频就放静音等它，不跳到后面的句子；一句放完才轮到下一句；
//   - 预缓冲（可选，默认 0 = 收到就放）：每句开播前、中途断粮以后，先攒够 prerollSamples 个采样
//     （或者这句已经全部送来）再放，网络一抖不会放一下停一下；
//   - 每次渲染都记下实际送进输出的源采样区间 [start, end)，按句子分段上报，用来算违规音频渲染时长；
//   - 记下每句第一个非静音采样被渲染的位置，用来算首声等待。

/** 低于这个幅度算静音（约 -60 dBFS） */
export const SILENCE = 1e-3;

export class PlaybackCore {
  constructor() {
    this.epoch = 0;
    /**
     * 排着队的句子，按播放顺序。每句自己存收到的音频块，只从排在最前面的那句渲染。
     * buffered：收到了、还没渲染的采样数；ended：已经收到「这句没有更多音频」；
     * playing：已经开播，中途断粮时放回 false，要重新攒够才接着放
     * @type {{epoch:number, uttId:string, key:string, chunks:{offset:number, samples:Float32Array, pos:number}[], buffered:number, ended:boolean, playing:boolean}[]}
     */
    this.order = [];
    /**
     * 已经渲染出第一个非静音采样的句子，按「代际:句子编号」记：
     * 同一个句子编号在新的代际里重新播放（例如同一用例再跑一次），要重新报一次开口
     */
    this.started = new Set();
    /** 预缓冲：开播前、断粮后至少攒够多少个采样才放。0 = 收到就放 */
    this.prerollSamples = 0;
  }

  /**
   * 设置预缓冲的采样数（主线程建好 worklet 时发一次）。不是正数就当 0。
   * @param {{prerollSamples?:number}} m
   */
  configure(m) {
    const n = Math.floor(Number(m.prerollSamples));
    this.prerollSamples = n > 0 ? n : 0;
  }

  /**
   * 找到这句；还没排过队就排到最后（老的调用方式不发 queue，第一块音频到的时候才排上）
   * @param {number} epoch
   * @param {string} uttId
   */
  slot(epoch, uttId) {
    let u = this.order.find((q) => q.epoch === epoch && q.uttId === uttId);
    if (!u) {
      u = { epoch, uttId, key: `${epoch}:${uttId}`, chunks: [], buffered: 0, ended: false, playing: false };
      this.order.push(u);
    }
    return u;
  }

  /**
   * 一句话放行了：音频还没到，先排上队、占好播放顺序。旧 epoch 的直接丢弃，返回 false。
   * @param {{epoch:number, uttId:string}} m
   */
  queue(m) {
    if (m.epoch < this.epoch) return false;
    this.slot(m.epoch, m.uttId);
    return true;
  }

  /**
   * 收一块音频，放进它那句的缓冲。旧 epoch 的块直接丢弃，返回 false。
   * @param {{epoch:number, uttId:string, offset:number, samples:Float32Array}} c
   */
  push(c) {
    if (c.epoch < this.epoch) return false;
    const u = this.slot(c.epoch, c.uttId);
    if (c.samples.length) {
      u.chunks.push({ offset: c.offset, samples: c.samples, pos: 0 });
      u.buffered += c.samples.length;
    }
    return true;
  }

  /**
   * 这句话的音频已经全部送来。如果它已经没有要放的（放完了，或者一块都没收到：取音频失败、空音频），
   * 马上从队里拿掉、返回 true（调用方马上上报「播完」），后面的句子不用等它。
   * @param {{epoch:number, uttId:string}} m
   */
  end(m) {
    if (m.epoch < this.epoch) return false;
    const at = this.order.findIndex((q) => q.epoch === m.epoch && q.uttId === m.uttId);
    if (at < 0) return true;
    const u = this.order[at];
    if (u.buffered > 0) {
      u.ended = true;
      return false;
    }
    this.order.splice(at, 1);
    return true;
  }

  /**
   * 提升 epoch，丢掉所有旧代际的句子（排着的队和缓冲一起丢）。返回丢掉的、还没渲染的采样数。
   * @param {number} epoch
   */
  flush(epoch) {
    if (epoch > this.epoch) this.epoch = epoch;
    let dropped = 0;
    this.order = this.order.filter((u) => {
      if (u.epoch >= this.epoch) return true;
      dropped += u.buffered;
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
    while (this.order.length) {
      const u = this.order[0];
      if (!u.chunks.length) {
        if (u.ended) {
          // 这句放完了：报「播完」，在同一个处理块里接着放下一句，句子之间不多出空白
          this.order.shift();
          finished.push(u.uttId);
          continue;
        }
        // 排在最前面的这句暂时没有音频（网络慢）：放静音等它，不跳到后面的句子。
        // 这个块还没填满才算真断粮：已经开播的，要重新攒够才接着放
        if (i < out.length) u.playing = false;
        break;
      }
      if (i >= out.length) break;
      if (!u.playing) {
        // 开播前、断粮后：先攒够预缓冲；这句已经全部送来就不用再等
        if (u.buffered < this.prerollSamples && !u.ended) break;
        u.playing = true;
      }
      const c = u.chunks[0];
      const n = Math.min(out.length - i, c.samples.length - c.pos);
      // 开口只报一次：每块查一次，不在循环里每个采样拼一次键（音频线程里少造垃圾，免得回收内存时卡一下）
      let fresh = !this.started.has(u.key);
      for (let k = 0; k < n; k++) {
        const v = c.samples[c.pos + k];
        out[i + k] = v;
        sumSq += v * v;
        if (fresh && Math.abs(v) > SILENCE) {
          fresh = false;
          this.started.add(u.key);
          started.push({ uttId: u.uttId, offset: c.offset + c.pos + k, frame: frame + i + k });
        }
      }
      if (n > 0) segments.push({ uttId: u.uttId, start: c.offset + c.pos, end: c.offset + c.pos + n, frame: frame + i });
      c.pos += n;
      u.buffered -= n;
      i += n;
      if (c.pos >= c.samples.length) u.chunks.shift();
    }
    out.fill(0, i);
    return { segments, started, finished, sumSq, filled: i };
  }
}
