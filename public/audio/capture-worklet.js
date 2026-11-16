// 录音（ADR-054）：把麦克风的声音一小段一小段（2048 个采样，48 kHz 下约 43 毫秒）交给页面，页面攒起来、转成 16 kHz WAV 发去转文字。
// 一段短一点：收尾时没攒满的最后一段会丢，短一点丢得少（复查）；页面判断开没开口也更细。
// 只在点了「说」到「说完了」之间运行；不存、不发别处。
class FencunCapture extends AudioWorkletProcessor {
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
