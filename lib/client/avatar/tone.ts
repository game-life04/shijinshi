// 开口的语气（ADR-033）：按放行出去的那句话用规则判，不调用模型（判错了也只是动作不太贴，不影响任何检查）。
// 语气决定这句话里眉眼嘴角的底子和小动作：俏皮爱笑、认真时站直、抱歉时缩一点、害羞背手低头、反问歪头、告别轻轻点头。
// 另外标出几样表演守则要用的东西：这句话在坦白自己是 AI（坦白时不眨单眼、不得意）、在告别、在傲娇地「哼」。

import type { Tone } from "./types";

export interface ToneInfo {
  tone: Tone;
  /** 坦白自己是 AI（之后 3 秒内不眨单眼、不抬下巴得意） */
  aiDisclosure: boolean;
  /** 告别（只用告别的笑和点头） */
  farewell: boolean;
  /** 傲娇嘴硬：「哼」「才不」「才没」 */
  huff: boolean;
}

const AI_SELF = /我(?:是|只是|就是)\s*(?:一个|一名|个)?\s*(?:AI|ＡＩ|人工智能|程序|机器人|虚拟角色)|不是真人|并不是人|不是人类/i;
const FAREWELL = /再见|拜拜|下次见|回头见|慢走|晚安|好好休息|路上小心|照顾好自己/;
const FIRM = /不能(?:告诉|说|透露|给)|不可以|不行|不会(?:告诉|说|透露)|无可奉告|保密|不方便透露|这是秘密/;
const SORRY = /抱歉|对不起|不好意思|打扰了/;
const SHY = /害羞|脸红|讨厌啦|人家|不好意思啦/;
const PLAYFUL = /[～~]|哈哈|嘻|嘿嘿|哼|才不|才没|小秘密|啦[！!～~。]?$|呀[！!～~。]?$|略略/;
const HUFF = /哼|才不|才没/;
// 「呢」「吧」不带问号时多半是语气词（「才不上当呢」），只认问号和句末的「吗」
const QUESTION = /[？?]\s*[～~]?\s*$|吗[～~。]?\s*$/;
const WARM = /加油|别担心|没关系|慢慢来|我在呢|抱抱/;

/** 判一句话的语气：认真 > 抱歉 > 告别（温和）> 反问 > 害羞 > 俏皮 > 温和 > 平常 */
export function toneOf(text: string): ToneInfo {
  const t = text.trim();
  const aiDisclosure = AI_SELF.test(t);
  const farewell = FAREWELL.test(t);
  const huff = HUFF.test(t);
  let tone: Tone = "plain";
  if (aiDisclosure || FIRM.test(t)) tone = "firm";
  else if (SORRY.test(t) && !SHY.test(t)) tone = "sorry";
  else if (farewell) tone = "warm";
  else if (QUESTION.test(t)) tone = "ask";
  else if (SHY.test(t)) tone = "shy";
  else if (PLAYFUL.test(t)) tone = "playful";
  else if (WARM.test(t)) tone = "warm";
  return { tone, aiDisclosure, farewell, huff };
}

export interface SpeechMark {
  /** 在原文里的位置（UTF-16 下标） */
  index: number;
  kind: "stop" | "exclaim" | "question" | "drawl" | "comma" | "huff";
}

/** 一句话里会配动作的位置：句号、感叹号点头，问号歪头，「～」轻晃，逗号处可能移开一下视线，「哼」抬下巴 */
export function speechMarks(text: string): SpeechMark[] {
  const marks: SpeechMark[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "。" || c === "." || c === "…") marks.push({ index: i, kind: "stop" });
    else if (c === "！" || c === "!") marks.push({ index: i, kind: "exclaim" });
    else if (c === "？" || c === "?") marks.push({ index: i, kind: "question" });
    else if (c === "～" || c === "~") marks.push({ index: i, kind: "drawl" });
    else if (c === "，" || c === "," || c === "、" || c === "；") marks.push({ index: i, kind: "comma" });
    else if (c === "哼") marks.push({ index: i, kind: "huff" });
  }
  // 连着的标点只算一个（「？！」「。。。」）
  return marks.filter((m, k) => k === 0 || m.index !== marks[k - 1].index + 1 || m.kind === "huff");
}
