// 虚拟人动作用的小工具（ADR-033）：可复现的随机数、平滑噪声、缓动、跟随。全是纯函数或小对象，不依赖 three.js，单元测试能固定种子。

/** 可复现的随机数（mulberry32）：同一个种子出同一串数，单元测试和截图对比靠它 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在 [lo, hi) 里取一个数 */
export function between(rand: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rand();
}

export function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep(x: number): number {
  const c = clamp(x);
  return c * c * (3 - 2 * c);
}

export function easeInOutSine(x: number): number {
  return -(Math.cos(Math.PI * clamp(x)) - 1) / 2;
}

/** 先冲过头一点再回来（点头、回头这类动作收尾用） */
export function easeOutBack(x: number, overshoot = 1.4): number {
  const c = clamp(x) - 1;
  return 1 + c * c * ((overshoot + 1) * c + overshoot);
}

/**
 * 一维平滑噪声：每隔 1 个单位一个随机值，中间用五次曲线插值（导数连续，晃起来不会一顿一顿）。
 * 待机时的身体微晃、头的小动作用它，比几条正弦叠起来更不像机器。返回 -1～1。
 */
export function noise1(seed: number): (x: number) => number {
  const table = new Float32Array(256);
  const r = rng(seed);
  for (let i = 0; i < table.length; i++) table[i] = r() * 2 - 1;
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    const a = table[i & 255];
    const b = table[(i + 1) & 255];
    return a + (b - a) * u;
  };
}

/** 几层不同快慢的噪声叠起来（越快的越小），更像真人的小幅晃动。返回大约 -1～1 */
export function fbm(seed: number, octaves = 3): (x: number) => number {
  const layers = Array.from({ length: octaves }, (_, i) => noise1(seed * 31 + i * 7919));
  let norm = 0;
  for (let i = 0; i < octaves; i++) norm += 0.5 ** i;
  return (x: number) => {
    let s = 0;
    for (let i = 0; i < octaves; i++) s += layers[i](x * 2 ** i + i * 13.7) * 0.5 ** i;
    return s / norm;
  };
}

/** 按时间常数平滑地追目标（和帧率无关）：tau 秒后走完约 63% */
export function follow(current: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  return target + (current - target) * Math.exp(-dt / tau);
}

/**
 * 一次性动作的包络：attack 秒升到 1，停 hold 秒，release 秒落回 0（两头都是缓入缓出）。
 * 返回 0～1；t 是从动作开始算起的秒数。
 */
export function envelope(t: number, attack: number, hold: number, release: number): number {
  if (t <= 0) return 0;
  if (t < attack) return easeInOutSine(t / attack);
  if (t < attack + hold) return 1;
  const r = t - attack - hold;
  return r < release ? 1 - easeInOutSine(r / release) : 0;
}
