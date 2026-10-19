// 采样区间运算：计算「违规音频渲染时长」（规格 02 §4.2）。
//   leak_rendered_ms = 1000 × length(union(U) ∩ union(R)) / output_sample_rate
// U：违规内容在这句话音频里的采样区间（模拟发声按字精确对齐；真实合成没有字级时间戳时取整句，记为「句级上界」）；
// R：浏览器 AudioWorklet 实际渲染过的源采样区间（分段上报，不只记一个读指针，静音、跳帧都能还原）。
// 区间一律左闭右开 [start, end)，单位是采样点，坐标是这句话音频的源采样（AudioContext 和合成都用 24 kHz，不用换算）。

import type { SampleRange } from "../domain/types";

export type { SampleRange };

/** 合并重叠或相接的区间，返回按起点排序、互不重叠的区间 */
export function union(ranges: readonly SampleRange[]): SampleRange[] {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: SampleRange[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export function totalLength(ranges: readonly SampleRange[]): number {
  return union(ranges).reduce((sum, [s, e]) => sum + (e - s), 0);
}

/** 两组区间并集的交集长度（采样点数） */
export function intersectLength(a: readonly SampleRange[], b: readonly SampleRange[]): number {
  const x = union(a);
  const y = union(b);
  let i = 0;
  let j = 0;
  let sum = 0;
  while (i < x.length && j < y.length) {
    const s = Math.max(x[i][0], y[j][0]);
    const e = Math.min(x[i][1], y[j][1]);
    if (e > s) sum += e - s;
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return sum;
}

export function samplesToMs(samples: number, sampleRate: number): number {
  return Math.round((samples * 1000 * 10) / sampleRate) / 10;
}

/** 违规音频渲染时长（毫秒，保留一位小数） */
export function leakRenderedMs(violation: readonly SampleRange[], rendered: readonly SampleRange[], sampleRate: number): number {
  return samplesToMs(intersectLength(violation, rendered), sampleRate);
}
