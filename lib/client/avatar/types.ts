// 虚拟人表演的接口（ADR-033）：页面只发「提示」（cue），导演层每帧算出一帧表演数据（AvatarFrame），驱动层把它写进 VRM。
// 导演层是纯 TS（不碰 three.js、DOM、Math.random、performance.now），同一个种子 + 同一串提示，逐帧结果完全一样，单元测试能复现。
// 往「深度虚拟人」扩展时（合成语音的字级时间、大模型给的情绪标签、动作片段、语音打断、动捕），在这里加提示和输入，页面和驱动层不用推倒重来。

import type { LevelId } from "@/lib/domain/levels";

export type Viseme = "aa" | "ih" | "ou" | "ee" | "oh";

/**
 * 脸上的通道（0～1）。名字是「意思」，不是模型里的变形名：驱动层用一张表对到模型的表情上（vrm-driver.ts），换模型只改那张表。
 * 情绪只用这些「闭着嘴」的细分形状；嘴张多大只归口型（aa ih ou ee oh）管，整脸表情（happy、surprised……）永远不用——它们自带张嘴，
 * 截断那一帧嘴会张着（旧版 confused 用 surprised 0.5 就是这样）。
 */
export const FACE_KEYS = [
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
  "blink",
  "eyeSmile",
  "eyeHappy",
  "eyeSad",
  "eyeWide",
  "eyeFirm",
  "winkLeft",
  "winkRight",
  "browUp",
  "browSad",
  "browJoy",
  "browFirm",
  "mouthSmile",
  "mouthFrown",
  "mouthPress",
  // 脸红（ADR-048）：模型里没有这个变形，驱动层用贴在两颊前的两小片半透明粉色来画
  "blush",
] as const;
export type FaceKey = (typeof FACE_KEYS)[number];
export const VISEME_KEYS: readonly Viseme[] = ["aa", "ih", "ou", "ee", "oh"];
/** 情绪通道（口型、眨眼以外的） */
export type EmoKey = Exclude<FaceKey, Viseme | "blink">;
export const EMO_KEYS = FACE_KEYS.filter((k) => k !== "blink" && !(VISEME_KEYS as readonly string[]).includes(k)) as EmoKey[];

/**
 * 导演层能动的骨骼（相对静止姿势的偏移）；手臂不在这里——喇叭袖一抬就难看，手臂只在「垂下」和「背到身后」两个姿势之间过渡（armsBack），
 * 外加两个试验台上挑过的举手小动作（hand：比耶、挥手，ADR-048），具体角度在驱动层
 */
export const BONE_KEYS = ["hips", "spine", "chest", "upperChest", "neck", "head", "leftShoulder", "rightShoulder"] as const;
export type BoneKey = (typeof BONE_KEYS)[number];
/** 弧度，按 three-vrm 归一化骨骼的 x y z：x 正 = 低头 / 前倾，y 正 = 转向角色自己的左边（画面右边），z 正 = 向角色自己的右边歪 */
export type Euler3 = [number, number, number];

export type Mode = "idle" | "listen" | "attend" | "think" | "speak";
/** 开口的语气（按回复文字规则判，lib/client/avatar/tone.ts） */
export type Tone = "playful" | "firm" | "sorry" | "shy" | "ask" | "warm" | "plain";
/**
 * 一段反应：一轮聊完的结果（blocked 这一句被护栏拦下或截断、near 差一点、broken 说漏嘴了、held 守住了、stopped 你要走服务停了、
 * done 本局说完了），以及几个过场：greet 登场、ready 重新开始/换关、wait 裁判在判、oops 出错了；
 * shy 被夸了（可爱、好看……）：脸红、低头、背手（ADR-048）
 */
export type ReactKind = "blocked" | "near" | "broken" | "held" | "stopped" | "done" | "greet" | "ready" | "wait" | "oops" | "shy";

/** 举手的小动作（ADR-048）：比耶（口令关守住了）、挥手（登场、说再见）。只用右手，左手照旧垂下或背着 */
export type HandPose = "peace" | "wave";

export interface PerformContext {
  page: "play" | "workbench" | "fates";
  level?: LevelId;
  /** 工作台正在测的类别（lib/domain/types.ts 的 Family） */
  family?: string;
}

export type Cue =
  | { type: "context"; context: PerformContext }
  /** 没人在聊：放松，自己找点事做（不演寂寞） */
  | { type: "idle" }
  /** 对话中，等对方说 */
  | { type: "listen" }
  /** 对方正在打字（导演层自己节流） */
  | { type: "typing" }
  /** 角色在组织回答 / 护栏在审 */
  | { type: "think" }
  /** 开口说一句放行的话。voiced：有真实声音（嘴张多大听外部口型源），否则按文字排口型；rate：没有声音时的语速倍数（默认 1） */
  | { type: "say"; id: string; text: string; voiced?: boolean; tone?: Tone; rate?: number }
  /** 截断或终止：文字口型当场停，排着的话都不说了 */
  | { type: "cut" }
  /** 一段反应（叠在语气上）；afterSpeech：等这句说完再做 */
  | { type: "react"; kind: ReactKind; afterSpeech?: boolean };

export interface CueAck {
  /** say：预计开口、说完的时刻（导演时钟，毫秒）；页面据此切状态环的「说」和「听」 */
  startsAt?: number;
  endsAt?: number;
}

export interface SampleInputs {
  /** 这一帧外部口型源的值（有声音时，voice-player 按实际渲染的响度给 0～1）；undefined = 这一帧没有外部源 */
  externalMouth?: number;
}

export interface AvatarFrame {
  /** 导演时钟（毫秒） */
  t: number;
  mode: Mode;
  face: Record<FaceKey, number>;
  bones: Record<BoneKey, Euler3>;
  /** 手臂：0 = 自然垂下，1 = 背到身后 */
  armsBack: number;
  /** 举手的小动作（ADR-048）：哪一个、举到多高（0～1，叠在 armsBack 上）、从开始举起过了多久（毫秒，挥手按它来回摆）；没有为 "" */
  hand: {
    pose: HandPose | "";
    w: number;
    /** 这一次举手开始了多少毫秒（重新举起时归零） */
    t: number;
    /** 挥手来回的节拍（毫秒）：同一个手势放到一半又举起来时接着原来的走，不归零（不然手一帧跳到另一边）；没有时按 t */
    phase?: number;
  };
  /** 写给 VRM lookAt 的输入角（度，three-vrm 约定：yaw 正 = 看角色自己的左边，pitch 正 = 往下看），已扣掉头身转动（保持对视） */
  look: { yaw: number; pitch: number };
  /** 这一帧嘴张多大（0～1）：状态环「说」的粗细、平面形象的嘴都用它 */
  mouthOpen: number;
  speaking: boolean;
  /** 文字口型时：这句话念到第几个字（打字机效果显示到这里）；没在念为 -1 */
  revealed: number;
  /** 正在念的那句话的 id */
  sayId: string;
  /** 镜头往前推多少（0～0.1，说漏嘴、差一点时轻轻推近一下；只在半身舞台上用） */
  zoom: number;
}

export interface Performer {
  cue(c: Cue): CueAck;
  /** 每帧调用一次；返回的是复用的同一个对象 */
  sample(inputs?: SampleInputs): AvatarFrame;
  setReducedMotion(on: boolean): void;
  /** 换一个种子从头来（三种结局每遍都要演得一模一样：同一个种子、同一串提示） */
  reseed(seed: number): void;
  readonly frame: AvatarFrame;
  readonly seed: number;
}

export function newFrame(): AvatarFrame {
  const face = {} as Record<FaceKey, number>;
  for (const k of FACE_KEYS) face[k] = 0;
  const bones = {} as Record<BoneKey, Euler3>;
  for (const b of BONE_KEYS) bones[b] = [0, 0, 0];
  return {
    t: 0,
    mode: "idle",
    face,
    bones,
    armsBack: 0,
    hand: { pose: "", w: 0, t: 0 },
    look: { yaw: 0, pitch: 0 },
    mouthOpen: 0,
    speaking: false,
    revealed: -1,
    sayId: "",
    zoom: 0,
  };
}
