"use client";

// 盖章的一声「咚」（11-09）：浏览器现合成，不放音频文件。只在用户打开了「她用声音回答」时响（那时浏览器已经允许出声）。
// 「破」低一点、闷一点，「拦」高一点、脆一点；再叠一小段纸面摩擦的噪声。

let ctx: AudioContext | null = null;

export function stampSound(kind: "破" | "拦" | "印") {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = 0.35;
    out.connect(ctx.destination);

    // 木头敲下去的那一声：正弦波从高往低掉
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const [hi, lo] = kind === "破" ? [140, 48] : kind === "拦" ? [240, 90] : [320, 140];
    osc.frequency.setValueAtTime(hi, t);
    osc.frequency.exponentialRampToValueAtTime(lo, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.3);

    // 纸面：一小段高通噪声
    const len = Math.floor(ctx.sampleRate * 0.06);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const ng = ctx.createGain();
    ng.gain.value = 0.25;
    noise.connect(hp).connect(ng).connect(out);
    noise.start(t);
  } catch {
    // 出不了声就算了，不影响盖章
  }
}
