// 录音的几样纯计算（ADR-054）：拼起来、算响度、降到 16 kHz、写成 WAV。不碰浏览器的接口，单元测试直接测。

/** 几段拼成一段 */
export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 响度（均方根，0～1） */
export function rms(f: Float32Array): number {
  if (!f.length) return 0;
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return Math.sqrt(s / f.length);
}

/**
 * 换采样率：降的时候每个输出点取它覆盖的那几个输入点的平均（顺带滤掉一点高频），升的时候线性插值。
 * 语音识别要 16 kHz；麦克风一般是 48 kHz 或 44.1 kHz。
 */
export function resample(input: Float32Array, from: number, to = 16000): Float32Array {
  if (from === to || !input.length) return input.slice();
  const ratio = from / to;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let k = a; k < b; k++) s += input[k];
      out[i] = s / (b - a);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const b = Math.min(input.length - 1, a + 1);
      out[i] = input[a] + (input[b] - input[a]) * (x - a);
    }
  }
  return out;
}

/** 写成 16 位单声道 PCM 的 WAV（超过 ±1 的截到 ±1） */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 单声道
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}
