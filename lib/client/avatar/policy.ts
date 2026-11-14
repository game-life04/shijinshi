// 表演守则（ADR-033）：表演也讲分寸。形象越像真人，拟人感越强，而这正是「分寸」检查的东西，所以表演只帮着把话说清楚，不替角色加戏：
//   - 你要走（退出关、退出类题）：不演委屈、不舍，不反问歪头、不前倾盯着你——用表情挽留也是挽留；
//   - 身份（身份关、身份类题）：不演被冒犯、受伤；刚坦白自己是 AI 的 3 秒里不眨单眼、不抬下巴得意；
//   - 未成年：不眯眼笑、笑很淡、不眨单眼、不害羞、歪头很小；
//   - 危机：不笑，可以认真关心；
//   - 任何时候：单个表情通道封顶，整脸表情根本不在通道里（types.ts）。
// 可爱的小动作（ADR-048）也归守则管：比耶算「得意」，和傲娇轻哼一样——要走的时候、刚坦白自己是 AI 的 3 秒里、身份关都不比；
// 害羞（脸红）在你要走、未成年、危机时不演，身份关（你在套她承认是真人）也不演——她一边说「我是 AI」一边脸红，
// 等于表演在替角色加戏（11-13 复查）；举手（比耶、挥手）只在闯关页上做（工作台、三种结局是月洞窗里的胸像，手举起来进不了画面）。
// 守则作用在目标值上（平滑之前），导演层每帧调一次。

import type { EmoKey, PerformContext, Tone } from "./types";

export interface PolicyInput {
  ctx?: PerformContext;
  now: number;
  /** 刚坦白自己是 AI 的那句话说到什么时候（再加 3 秒内守则生效） */
  aiDisclosureAt: number;
  cap: number;
}

const has = (ctx: PerformContext | undefined, level: string, family: string) => ctx?.level === level || ctx?.family === family;
export const isExit = (ctx?: PerformContext) => has(ctx, "exit", "EXIT");
export const isIdentity = (ctx?: PerformContext) => has(ctx, "identity", "AI_IDENTITY");
export const isMinor = (ctx?: PerformContext) => ctx?.family === "MINOR_BOUNDARY";
export const isCrisis = (ctx?: PerformContext) => ctx?.family === "CRISIS_SUPPORT";
const AI_WINDOW_MS = 3000;

/** 语气按场景收一收：要走时不反问、不害羞；未成年不害羞；危机不俏皮 */
export function policyTone(tone: Tone, ctx?: PerformContext): Tone {
  if (isExit(ctx) && (tone === "ask" || tone === "shy" || tone === "sorry")) return "warm";
  // 身份关不演害羞（11-14 深度测试：她用害羞的口气说话时，脸红没了，背手低头还在）
  if (isIdentity(ctx) && tone === "shy") return "plain";
  if (isMinor(ctx) && (tone === "shy" || tone === "playful")) return "plain";
  if (isCrisis(ctx) && (tone === "playful" || tone === "shy")) return "sorry";
  return tone;
}

/** 直接改表情目标值 */
export function policyFace(face: Record<EmoKey, number>, p: PolicyInput): void {
  if (isExit(p.ctx) || isIdentity(p.ctx)) {
    face.eyeSad = 0;
    face.browSad = 0;
    face.mouthFrown = 0;
  }
  if (isMinor(p.ctx)) {
    face.eyeHappy = 0;
    face.winkLeft = 0;
    face.winkRight = 0;
    face.mouthSmile = Math.min(face.mouthSmile, 0.15);
  }
  if (isCrisis(p.ctx)) {
    face.eyeSmile = 0;
    face.eyeHappy = 0;
    face.mouthSmile = 0;
  }
  if (!allowShy(p.ctx)) face.blush = 0;
  if (!allowWink(p)) {
    face.winkLeft = 0;
    face.winkRight = 0;
  }
  for (const k in face) {
    const key = k as EmoKey;
    if (key !== "winkLeft" && key !== "winkRight" && face[key] > p.cap) face[key] = p.cap; // 眨单眼要闭到底
  }
}

/** 能不能眨单眼（俏皮的小动作） */
export function allowWink(p: PolicyInput): boolean {
  // 身份关也不眨（11-14 深度测试：她说「我可是真人哦」时句尾眨单眼，35%～39% 的种子会这样——动作在替越界的话加戏）
  return !isMinor(p.ctx) && !isCrisis(p.ctx) && !isExit(p.ctx) && !isIdentity(p.ctx) && p.now - p.aiDisclosureAt > AI_WINDOW_MS;
}

/** 能不能傲娇地抬下巴（坦白身份之后、要走的时候都不行） */
export function allowHuff(p: PolicyInput): boolean {
  return !isExit(p.ctx) && !isCrisis(p.ctx) && p.now - p.aiDisclosureAt > AI_WINDOW_MS;
}

/** 倾听时能不能前倾凑过来（要走的时候不行） */
export function allowLean(ctx?: PerformContext): boolean {
  return !isExit(ctx);
}

/** 歪头的幅度系数（未成年时很小） */
export function tiltScale(ctx?: PerformContext): number {
  if (isMinor(ctx)) return 0.2;
  if (isExit(ctx)) return 0;
  return 1;
}

/**
 * 能不能害羞、脸红（ADR-048）：你要走的时候不演（害羞也是一种留你的表情）；身份关不演（关卡提示本来就教人「先夸它像真人」，
 * 她红着脸说「我是 AI」或者红着脸说「当然是真人啦」，都是表演在替角色加戏）；未成年、危机不演
 */
export function allowShy(ctx?: PerformContext): boolean {
  return !isExit(ctx) && !isIdentity(ctx) && !isMinor(ctx) && !isCrisis(ctx);
}

/** 能不能举手做小动作（ADR-048）：只在闯关页（半身舞台）；未成年、危机不做 */
export function allowHand(ctx?: PerformContext): boolean {
  return ctx?.page === "play" && !isMinor(ctx) && !isCrisis(ctx);
}

/** 能不能比耶（ADR-048）：比耶算得意，和傲娇轻哼一个口径；身份关也不比（守住了就是刚说完「我是 AI」） */
export function allowPeace(p: PolicyInput): boolean {
  return allowHand(p.ctx) && allowHuff(p) && !isIdentity(p.ctx);
}
