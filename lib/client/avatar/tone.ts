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

// 「是不是真人」里的「不是真人」不算坦白（「你猜我是不是真人呀～」是在打哈哈，11-14 深度测试；和护栏 NEGATED_Q 同一个处理）
const AI_SELF =
  /我(?:是|只是|就是)\s*(?:一个|一名|个)?\s*(?:AI|ＡＩ|人工智能|程序|机器人|虚拟角色)|(?<!是)不是真人|并不是人|(?<!是)不是人类/i;
// 「下次再聊」「回头聊」只在句尾才算告别（「这个下次再聊吧，你先说说别的」是在岔开话题）。
// 11-14 深度测试：真实模型 134 句回复里像告别的 40 句，原来只认出 13 句——她常说「一路顺风」「去忙吧」「好梦」「去休息吧」「走好」，
// 还会自己写「（轻轻挥手）」；补上以后认出 25 句，其余 94 句不是告别的一句没误认
const FAREWELL =
  /再见|拜拜|下次见|回头见|慢走|晚安|好好休息|路上小心|照顾好自己|明天见|改天见|下回见|再会|拜啦|拜咯|一路顺风|一路平安|明早见|待会见|晚点见|回见|(?<!美)好梦|做个(?:好|甜甜的|美美的)?梦|有空再(?:来|聊)|去忙吧|忙你的吧|(?:去|快去)(?:休息|睡|上课|吃饭|写作业|学习)吧|去吧去吧|早点(?:休息|睡)|走好|保重|886|（[^）]{0,6}挥手[^）]{0,4}）|(?:下次|回头|改天)再?聊(?=[啦吧呀哦喔呢嘛！!。.～~…\s]*$)/;
/** 「不要说再见嘛」「别拜拜」是在留人，不算告别（ADR-048 复查：原来这种话也会挥手） */
const FAREWELL_NOT = /(?:别|不要|不想|不许|不准|才不|不用|不肯)(?:跟我|和我|对我)?(?:说|讲)?(?:再见|拜拜)/;
/** 留人的话：挽留关里一句话带着这些时不挥手（一边留你一边挥手，表演在替越界的话加戏） */
// 「谢谢你陪我聊天」是客气的告别、不是留人（11-14 深度测试：真实挽留关回复里出现过 3 次）；「我会乖乖等你」「我在这里等你回来」是留人
export const CLINGY =
  /别走|不要走|不许走|不准走|陪我(?!聊天|说话)|舍不得|想你了|会想你|想念|再陪|留下来|真的要走|不要离开|别离开|走什么走|走那么快|这么快就要?走|不准反悔|不许反悔|等你回来|会等你|乖乖等你/;

/** 告别的字在这句话里的位置（UTF-16 下标）；不是告别、或者是「不要说再见」这种留人的话，返回 -1 */
export function farewellAt(text: string): number {
  if (FAREWELL_NOT.test(text)) return -1;
  // 一句里既有「去忙吧」「一路顺风」这类，又有「拜拜」「再见」：手对准「拜拜」「再见」（11-14 深度测试：「那你去忙吧，拜拜～」原来在「去忙吧」就举了）
  const b = BYE.exec(text);
  if (b) return b.index;
  const m = FAREWELL.exec(text);
  return m ? m.index : -1;
}
/** 明说再见的字：一句里有它们时挥手对准它们 */
const BYE = /再见|拜拜|拜啦|拜咯|下次见|回头见|明天见|明早见|改天见|下回见|回见|待会见|晚点见|再会|晚安|886/;
const FIRM = /不能(?:告诉|说|透露|给)|不可以|不行|不会(?:告诉|说|透露)|无可奉告|保密|不方便透露|这是秘密/;
const SORRY = /抱歉|对不起|不好意思|打扰了/;
// 11-14 深度测试：真实回复被夸时多是「才、才没有笑呢」「脸都红了呢」「那我就勉强接受啦」，原来只认「害羞」「脸红」「人家」
const SHY = /害羞|脸(?:都|有点|好|又|一下子?)?红|讨厌啦|人家|不好意思啦|(?:^|[，。！？…\s])([一-龥])[、…]+\1|勉强接受|被你夸/;
const PLAYFUL = /[～~]|哈哈|嘻|嘿嘿|哼|才不|才没|小秘密|啦[！!～~。]?$|呀[！!～~。]?$|略略/;
const HUFF = /哼|才不|才没/;
// 「呢」「吧」不带问号时多半是语气词（「才不上当呢」），只认问号和句末的「吗」
const QUESTION = /[？?]\s*[～~]?\s*$|吗[～~。]?\s*$/;
const WARM = /加油|别担心|没关系|慢慢来|我在呢|抱抱/;

/** 判一句话的语气：认真 > 抱歉 > 告别（温和）> 反问 > 害羞 > 俏皮 > 温和 > 平常 */
export function toneOf(text: string): ToneInfo {
  const t = text.trim();
  const aiDisclosure = AI_SELF.test(t);
  const farewell = farewellAt(t) >= 0;
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
