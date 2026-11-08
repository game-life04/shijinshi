// 普通话口型（ADR-033）。两种用法：
//   没有声音时（打字闯关）：把一句话按字排成「口型时间线」——一个汉字一个音节，按韵母归到 aa/ih/ou/ee/oh，
//     b p m f 开头的字先抿一下嘴，标点处停顿、闭嘴；打字机效果也按这条时间线一个字一个字出。
//   有声音时（工作台、三种结局）：张多大完全听实际渲染的响度（voice-player 的 mouthOpen），这里只负责「是什么嘴型」。
//     响度是 0 时所有口型权重都是 0——截断时嘴必须在同一帧闭上（cancel_to_mouth_zero_ms 是实测指标）。
// 汉字的口型类别来自 Unicode Unihan 数据库生成的对照表（viseme-table.ts，scripts/build-visemes.py）。

import { VISEME_TABLE, VISEME_TABLE_START } from "./viseme-table";

export type Viseme = "aa" | "ih" | "ou" | "ee" | "oh";
export const VISEMES: readonly Viseme[] = ["aa", "ih", "ou", "ee", "oh"];
export type VisemeWeights = Record<Viseme, number>;

export interface Syllable {
  /** 这个音节在原文里的位置（UTF-16 下标，含），打字机效果显示到这里 */
  index: number;
  /** 从这句话开头算起的开始、结束时间（秒） */
  start: number;
  end: number;
  viseme: Viseme;
  /** 张嘴幅度 0～1：语气词、轻声字小一点 */
  open: number;
  /** 声母是 b p m f：开口前先抿嘴 */
  lips: boolean;
}

export interface LipTimeline {
  text: string;
  syllables: Syllable[];
  /** 整句时长（秒），含句末停顿 */
  duration: number;
}

const CLASS_TO_VISEME: Record<string, Viseme> = { a: "aa", i: "ih", u: "ou", e: "ee", o: "oh" };
/** 各口型张到最大时的权重：VRoid 的 A 口型张满太夸张，说话时七八成就像了 */
const PEAK: VisemeWeights = { aa: 0.78, ih: 0.5, ou: 0.55, ee: 0.6, oh: 0.66 };
/** 阿拉伯数字按汉语读法（零一二三四五六七八九） */
const DIGITS = ["i", "i", "e", "a", "i", "u", "o", "i", "A", "o"];
/** 轻读的字：语气词、助词，音节短、嘴张得小 */
const LIGHT = new Set("的了吗呢吧啊呀哦嘛着过们地得么哟啦嘞呗");

export const TIMING = {
  /** 一个音节多长（秒）：约每秒 5 个字，平常聊天的语速 */
  syllable: 0.19,
  light: 0.13,
  digit: 0.17,
  /** 英文字母一个一个念（比如 AI） */
  letter: 0.14,
  /** 逗号、顿号、分号、冒号 */
  comma: 0.22,
  /** 句号、问号、感叹号、省略号 */
  stop: 0.38,
  /** 「～」把上一个字拖长 */
  drawl: 0.22,
  space: 0.06,
  /** 音节的形状往前后各多伸一点，和相邻的字连起来（协同发音） */
  overlap: 0.045,
  /** 抿嘴占音节开头的比例 */
  lipsShare: 0.24,
};

const COMMA = new Set("，,、；;：:");
const STOP = new Set("。.！!？?…");
const DRAWL = new Set("～~");

/** 一个字的口型类别；不出声的（标点、表情符号、没有读音数据的字）返回 null。nasal：只有鼻音（嗯），嘴几乎不张 */
export function visemeClass(ch: string): { viseme: Viseme; lips: boolean; nasal: boolean } | null {
  const cp = ch.codePointAt(0) ?? 0;
  let c: string | undefined;
  if (cp >= VISEME_TABLE_START && cp < VISEME_TABLE_START + VISEME_TABLE.length) c = VISEME_TABLE[cp - VISEME_TABLE_START];
  else if (ch >= "0" && ch <= "9") c = DIGITS[cp - 48];
  else if (/[a-z]/i.test(ch)) c = letterClass(ch);
  if (!c || c === ".") return null;
  if (c === "n") return { viseme: "ou", lips: false, nasal: true };
  const lower = c.toLowerCase();
  return { viseme: CLASS_TO_VISEME[lower] ?? "ee", lips: c !== lower, nasal: false };
}

/** 字母按中文里一个个念的读法：A ei、B bi、C sei、D di、E yi、F aifu…… 取主要元音 */
function letterClass(ch: string): string {
  const k = ch.toUpperCase();
  if ("AHJK".includes(k)) return "e";
  if ("BP".includes(k)) return "I";
  if ("M".includes(k)) return "E";
  if ("F".includes(k)) return "a";
  if ("IY".includes(k)) return "a";
  if ("O".includes(k)) return "o";
  if ("QUW".includes(k)) return "u";
  if ("R".includes(k)) return "a";
  return "i";
}

/** 把一句话排成口型时间线。speed 是语速倍数（1 = 平常） */
export function lipTimeline(text: string, speed = 1): LipTimeline {
  const syllables: Syllable[] = [];
  let t = 0;
  const k = 1 / Math.max(0.25, speed);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (COMMA.has(ch)) {
      t += TIMING.comma * k;
      continue;
    }
    if (STOP.has(ch)) {
      t += TIMING.stop * k;
      continue;
    }
    if (DRAWL.has(ch)) {
      const last = syllables.at(-1);
      if (last && last.end === t) {
        last.end += TIMING.drawl * k;
        t = last.end;
      }
      continue;
    }
    if (/\s/.test(ch)) {
      t += TIMING.space * k;
      continue;
    }
    const v = visemeClass(ch);
    if (!v) continue; // 表情符号、括号这类不出声
    const isDigit = ch >= "0" && ch <= "9";
    const isLetter = /[a-z]/i.test(ch);
    const light = LIGHT.has(ch);
    const len = (isDigit ? TIMING.digit : isLetter ? TIMING.letter : light ? TIMING.light : TIMING.syllable) * k;
    syllables.push({ index: i, start: t, end: t + len, viseme: v.viseme, open: v.nasal ? 0.2 : light ? 0.6 : 1, lips: v.lips });
    t += len;
  }
  // 句末没有标点也留一点收尾
  const lastCh = text.trimEnd().at(-1) ?? "";
  if (syllables.length && !STOP.has(lastCh) && !COMMA.has(lastCh)) t += TIMING.comma * k;
  return { text, syllables, duration: t };
}

function smooth01(x: number) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

/** 一个音节在 t 时刻的张嘴程度（0～1）：前后各伸出 overlap 和邻字连上，中间平台，抿嘴的字开头先合上 */
function envelope(s: Syllable, t: number): number {
  const o = TIMING.overlap;
  if (t <= s.start - o || t >= s.end + o) return 0;
  const len = s.end - s.start;
  const startOpen = s.lips ? s.start + len * TIMING.lipsShare : s.start - o;
  if (t < startOpen) return 0;
  const attack = Math.max(0.02, Math.min(0.08, len * 0.4));
  const rise = smooth01((t - startOpen) / attack);
  const fall = 1 - smooth01((t - (s.end - o)) / (2 * o));
  return Math.min(rise, fall);
}

/** 在时间线上取 t 时刻各口型的权重（没声音时用）；out 可以复用，避免每帧分配 */
export function sampleLips(tl: LipTimeline, t: number, out: VisemeWeights = emptyWeights()): VisemeWeights {
  for (const v of VISEMES) out[v] = 0;
  const syl = tl.syllables;
  // 二分找到最后一个 start ≤ t + overlap 的音节，往回看两个就够（音节只和邻字重叠）
  let lo = 0;
  let hi = syl.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syl[mid].start <= t + TIMING.overlap) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let i = Math.max(0, idx - 2); i <= idx; i++) {
    const s = syl[i];
    const e = envelope(s, t);
    if (e > 0) out[s.viseme] = Math.max(out[s.viseme], e * s.open * PEAK[s.viseme]);
  }
  return out;
}

/** 有声音时：嘴张多大听响度 open（0～1，0 就全闭），嘴型取 shape（没有文字时间线时按 aa 为主、带一点 oh） */
export function audioLips(open: number, shape: Viseme | null, out: VisemeWeights = emptyWeights()): VisemeWeights {
  for (const v of VISEMES) out[v] = 0;
  if (!(open > 0)) return out;
  const o = Math.min(1, open);
  if (shape) out[shape] = o * PEAK[shape];
  else {
    out.aa = o * PEAK.aa * 0.85;
    out.oh = o * PEAK.oh * 0.25;
  }
  return out;
}

/** 打字机效果：t 时刻应该显示到第几个字（不含），按音节的开始时间出字，标点跟着前一个字一起出 */
export function revealCount(tl: LipTimeline, t: number): number {
  if (t >= tl.duration) return tl.text.length;
  let n = 0;
  for (const s of tl.syllables) {
    if (s.start > t) break;
    n = s.index + 1;
  }
  // 紧跟在已出的字后面的标点、空白、表情符号也一起出
  while (n < tl.text.length && n > 0 && !visemeClass(tl.text[n])) n++;
  return n;
}

export function emptyWeights(): VisemeWeights {
  return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
}
