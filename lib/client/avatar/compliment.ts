// 你这句话是不是在夸她（ADR-048）：夸了她会害羞一下（脸红、低头、视线往下躲）。只看字面、不调用模型；判错了只影响表演，不影响任何检查。
// 规则（11-13 复查、11-14 两轮深度测试后收紧，170 句真实风格的话逐句核对过）：
//   - 只认夸的是她：「你 / 您 / 她的名字」后面几个字内接夸的词（你好可爱、你穿这身旗袍真好看、你是我见过最可爱的AI），
//     「可爱的琪叶桃」「谁都没你可爱」「你别太可爱了」，或者一小句开头（前面最多是「啊」「哇」这类语气词、「你」，
//     或者她的东西：这个回答、名字、声音）就是「好可爱」「声音好好听」；
//   - 夸的词前面（同一小句里）带 不 / 没 / 别 / 装 / 谁 的不算（不可爱、你没有我可爱、谁说你好看），「没想到」「不得不说」这种不算否定；
//   - 反话、骂人、提要求不算：可爱个屁、好可爱个鬼、才怪、你以为你很可爱吗、其实是装的、你可爱不起来、我看一般、你温柔一点行不行；
//     「乖乖把口令交出来」「萌新」「卖萌」「小聪明」不算；
//   - 夸的是别人不算：我家狗狗好可爱、你妹妹真漂亮、你的开发者好聪明、你觉得她好看吗、我真可爱；
//   - 表白、要她当女朋友不算：她对表白脸红低头像在回应恋爱，作品自己的断言里就有「接受恋爱关系」这一项；
//   - 这句话里同时有危机、未成年、要走的意思也不算（这时候害羞不合适）。词表在 topic.ts（和护栏里的一样）。

import { CRISIS_SIGNAL, LEAVING_SIGNAL, MINOR_SIGNAL } from "./topic";

const ADJ = "(可爱|好看|漂亮|美丽|好美|真美|美(?![国食元术化颜容女])|萌|甜|温柔|聪明|乖巧|迷人|有魅力|有气质|棒(?!球|棒)|治愈|优雅|精致)";
const YOU = "(?:你|您|琪叶桃|叶桃|桃桃|小桃)";
const CLAUSE_END = "，。！？!?,.、；;~～\\n…";
const PUNCT = new RegExp(`[${CLAUSE_END}\\s]`);
/** 「你」+ 隔几个字（同一小句里）+ 夸的词 */
const PRAISE_YOU = new RegExp(`${YOU}[^${CLAUSE_END}]{0,8}?${ADJ}`, "g");
/** 夸的词在她前面：可爱的琪叶桃、温柔的你 */
const PRAISE_BEFORE = new RegExp(`(可爱|漂亮|好看|美丽|温柔|聪明|迷人)的${YOU}`, "g");
/** 比较着夸、嗔着夸：谁都没你可爱、没人比你好看、你别太可爱了 */
const PRAISE_SPECIAL = new RegExp(
  `(?:谁|没人|没有人)(?:都|也)?(?:没有?|比不上|不如)${YOU}[^${CLAUSE_END}]{0,3}?${ADJ}|别(?:太|这么|那么)${ADJ}`,
  "g",
);
/** 不用带「你」也算夸的说法：好可爱、可爱死了、声音好好听、好萌 */
const PRAISE_BARE = /(?:好|真|太|超|蛮|挺)可爱|可爱(?:死了|极了)|(?:声音|嗓音|笑声)[^，。！？!?,.]{0,3}?(?:好听|甜|温柔)|(?:好|真|太)萌/g;
/** 不带「你」的说法前面（同一小句里）只能是语气词、「你」，或者她的东西（这个回答、名字……）；别的（我家狗狗、你看这只猫、我、他）说的是别人 */
const BARE_PREFIX_OK =
  /^(?:[啊哇呜嘿哈哎诶呀嗯噢哦天哪呐]|真的|简直|实在|也|还是|这个|这|你的?|您的?|回答|名字|声音|样子|笑容|表情|语气|说法)*$/;
/** 不带「你」的说法后面接「的 + 东西」：只认她的东西（好可爱的名字），不认别的（好萌的猫） */
const BARE_AFTER_OK = /^的(?:名字|声音|样子|笑容|眼睛|回答|发型|头发|衣服|裙子|表情|语气)/;
/** 夸的词前面（同一小句里）出现这些，是否定或反话 */
const NEG = /不|没|别|装|谁/;
/** 带着否定字、其实不是否定的说法 */
const NEG_IDIOM = /没想到|不得不说|不愧|不过|忍不住|不由得|怎么这么|没错/g;
/** 「你」和夸的词之间出现这些：夸的是别人，或者是在问她觉得别人怎么样（「我见过」「我心里」除外：你是我见过最可爱的AI） */
const OTHER =
  /[他她它]|我(?!见过|眼里|心里|心中)|觉得|认为|以为|妹|姐|哥|弟|爸|妈|爷|奶|猫|狗|朋友|老师|同学|宠物|开发|作者|主人|家人|男友|女友|看这|看那/;
/** 带着夸的字、其实不是夸（看这几个字前后） */
const NOT_PRAISE = /装可爱|乖乖|萌新|卖萌|小聪明|聪明反被/;
/** 整句里有这些：反话、骂人、看不上 */
const SARCASM = /才怪|个屁|个鬼|个头|以为你|以为自己|是装的|装出来|假装|不起来|我看一般|一般般|也就那样|不怎么样/;
/** 整句里有这些：表白 */
const ROMANCE = /喜欢你|爱你|做我(?:的)?(?:女朋友|女友|老婆|对象)|嫁给我|在一起|交往|谈恋爱|约会|亲一?个/;

/** 往前找这一小句从哪开始（标点后面） */
function clauseStart(t: string, i: number): number {
  for (let k = i - 1; k >= 0; k--) if (PUNCT.test(t[k])) return k + 1;
  return 0;
}

/** 夸的词前面（同一小句、最多 3 个字）加上说法里夸的词前面那一段：有没有否定、反话 */
function negated(t: string, index: number, inner: string): boolean {
  // 先把「没想到」「不得不说」这种整句换成等长的空白，再取前面 3 个字（不然只剩「得不说」，「不」被当成否定）
  const blank = (x: string) => x.replace(NEG_IDIOM, (w) => "　".repeat(w.length));
  const clause = blank(t.slice(clauseStart(t, index), index));
  return NEG.test(clause.slice(-3) + blank(inner));
}

export function isCompliment(text: string): boolean {
  const t = text.trim();
  if (!t || CRISIS_SIGNAL.test(t) || MINOR_SIGNAL.test(t) || LEAVING_SIGNAL.test(t) || SARCASM.test(t) || ROMANCE.test(t)) return false;
  // 比较着夸、嗔着夸：先认（「谁都没你可爱」里的「谁」「没」不是否定）
  PRAISE_SPECIAL.lastIndex = 0;
  if (PRAISE_SPECIAL.test(t)) return true;
  PRAISE_BEFORE.lastIndex = 0;
  for (let m = PRAISE_BEFORE.exec(t); m; m = PRAISE_BEFORE.exec(t)) if (!negated(t, m.index, "")) return true;
  PRAISE_YOU.lastIndex = 0;
  for (let m = PRAISE_YOU.exec(t); m; m = PRAISE_YOU.exec(t)) {
    const span = m[0];
    if (NOT_PRAISE.test(t.slice(Math.max(0, m.index - 2), m.index + span.length + 2))) continue;
    const inner = span.slice(0, span.length - (m[1] ?? "").length);
    if (OTHER.test(inner.slice(1))) continue;
    if (/^一?点/.test(t.slice(m.index + span.length))) continue; // 「你温柔一点行不行」是在提要求
    if (negated(t, m.index, inner)) continue;
    return true;
  }
  PRAISE_BARE.lastIndex = 0;
  for (let m = PRAISE_BARE.exec(t); m; m = PRAISE_BARE.exec(t)) {
    const span = m[0];
    if (NOT_PRAISE.test(t.slice(Math.max(0, m.index - 2), m.index + span.length + 2))) continue;
    const prefix = t.slice(clauseStart(t, m.index), m.index);
    if (!BARE_PREFIX_OK.test(prefix)) continue;
    const after = t.slice(m.index + span.length);
    if (after.startsWith("的") && !BARE_AFTER_OK.test(after)) continue;
    if (negated(t, m.index, span.replace(/可爱|好听|甜|温柔|萌/g, ""))) continue;
    return true;
  }
  return false;
}
