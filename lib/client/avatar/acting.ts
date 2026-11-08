// 琪叶桃的表演参数（ADR-033）：导演层（director.ts）的所有数都在这张表里，调演技只改这里。
// 表演底子：一个知道自己是 AI、也不打算装成人的守关小姑娘。嘴上不饶人，爱逗你、藏小秘密；一碰到底线就站直把话说清楚；你要走，她笑着送你。
// 三种基调：俏（常态：笑眼、嘴角上扬、点头带一点冲过头再回来）、正（认真拒绝、坦白自己是 AI：站直、正视、笑收到最淡）、
// 静（你要走、本局结束：动作减半、不笑也不难过、欠身点头就收）。
// 招牌小动作：H1 背手藏秘密、H2 歪头、H3 傲娇轻哼抬下巴、H4 开口前先看你吸口气、H5 想事情眼睛往上飘、H6 句尾小点头、H7 换脚、H8 站直。
// 单位：骨骼弧度（VRM 归一化骨骼，x 正低头/前倾，y 正转向她自己的左边，z 正向她自己的右边歪），视线度（lookAt 输入角，眼珠实际只转 8～12 度：
// 输入 45～70 看得清，90 时远处那只眼的瞳孔贴到眼角，试验台看过），时间毫秒。
// 幅度、时长是经验值：头发弹簧骨骼要 0.8～1 秒才停稳，点头别太密、别太大；喇叭袖不能抬手，手臂只在垂下和背手之间慢慢过渡。

import type { BoneKey, EmoKey, Euler3, Mode, ReactKind, Tone } from "./types";

export type Face = Partial<Record<EmoKey, number>>;
export type Pose = Partial<Record<BoneKey, Euler3>>;

/** 一个一次性的身体动作：bones 是动作到最大时的偏移，按 attack / hold / release 的包络升起落下 */
export interface GestureSpec {
  bones: Pose;
  attack: number;
  hold: number;
  release: number;
  /** 收尾冲过头再回来（俏皮的点头）；0 不冲 */
  overshoot?: number;
}

export interface ToneSpec {
  /** 说这句话时脸上的底子 */
  face: Face;
  /** 站直（H8）：前倾、歪头、重心偏都收回 */
  straight?: boolean;
  /** 说这句时的身体姿态 */
  pose?: Pose;
  /** 手臂背到身后的程度 */
  armsBack?: number;
  /** 句尾点头冲过头的量（俏皮 1.3，认真 0） */
  nodOvershoot: number;
  /** 说完最后一个字露的笑（认真但不凶） */
  endFace?: Face;
  /** 视线：说话时更常移开（害羞往下） */
  gazeDown?: number;
}

export interface ReactionSpec {
  face: Face;
  ms: number;
  gesture?: GestureSpec;
  /** 反应期间手臂 */
  armsBack?: number;
  /** 反应时往哪瞟一眼：[yaw, pitch, 持续毫秒]（pitch 正 = 往下） */
  glance?: [number, number, number];
  /** 反应以后留下的心情（几秒内慢慢退） */
  after?: { face: Face; ms: number };
}

export const NOD: GestureSpec = { bones: { head: [0.035, 0, 0], neck: [0.015, 0, 0] }, attack: 120, hold: 40, release: 300 };
export const TILT: GestureSpec = { bones: { head: [0, 0, 0.12], neck: [0, 0, 0.04] }, attack: 250, hold: 600, release: 500 };
export const HUFF: GestureSpec = { bones: { head: [-0.07, 0, 0], neck: [-0.02, 0, 0] }, attack: 200, hold: 500, release: 450 };
export const PULL_BACK: GestureSpec = { bones: { head: [-0.04, 0, 0], spine: [-0.02, 0, 0] }, attack: 110, hold: 120, release: 520 };
export const SLOW_NOD: GestureSpec = { bones: { head: [0.05, 0, 0], neck: [0.02, 0, 0] }, attack: 320, hold: 120, release: 420 };
export const BOW: GestureSpec = {
  bones: { spine: [0.05, 0, 0], chest: [0.02, 0, 0], head: [0.05, 0, 0] },
  attack: 450,
  hold: 250,
  release: 600,
};
export const INHALE: GestureSpec = {
  bones: { chest: [-0.015, 0, 0], leftShoulder: [0, 0, 0.03], rightShoulder: [0, 0, -0.03] },
  attack: 160,
  hold: 40,
  release: 300,
};
export const SHRUG: GestureSpec = {
  bones: { leftShoulder: [0, 0, 0.04], rightShoulder: [0, 0, -0.04], head: [0, 0, 0.04] },
  attack: 160,
  hold: 220,
  release: 380,
};
export const BEAT: GestureSpec = { bones: { head: [0.018, 0, 0], neck: [0.006, 0, 0] }, attack: 90, hold: 20, release: 220 };
export const STARTLE: GestureSpec = {
  bones: { head: [-0.05, 0, 0], spine: [-0.025, 0, 0], leftShoulder: [0, 0, 0.035], rightShoulder: [0, 0, -0.035] },
  attack: 90,
  hold: 160,
  release: 650,
};

export interface ActingProfile {
  blink: {
    /** 平均眨眼间隔（按模式；说话时多，盯着看时少） */
    meanMs: Record<Mode, number>;
    minMs: number;
    closeMs: number;
    openMs: number;
    /** 连眨两下的概率 */
    doubleP: number;
    /** 视线大幅移开、句末停顿时顺带眨一下的概率 */
    onShiftP: number;
  };
  gaze: {
    /** 听的时候：每隔多久瞟开一次、瞟多久、多大 */
    listenEveryMs: [number, number];
    listenGlanceMs: [number, number];
    listenYaw: [number, number];
    listenPitch: number;
    /** 想事情（H5）：往上、偏一侧 */
    thinkYaw: [number, number];
    thinkUp: [number, number];
    thinkSwitchMs: number;
    /** 说话时逗号处移开一下的概率、时长、幅度 */
    speakGlanceP: number;
    speakGlanceMs: [number, number];
    speakYaw: [number, number];
    /** 眼睛追目标的时间常数（扫视很快） */
    tauMs: number;
    maxIn: number;
  };
  breath: { periodMs: Record<Mode, number>; chest: number; upperChest: number; shoulder: number };
  /** 待机微晃（平滑噪声，频率很低） */
  sway: { spineZ: number; spineY: number; headY: number; headZ: number; headX: number; hz: number };
  /** H7 换脚：待机、倾听时隔一阵把重心换到另一边 */
  weight: { everyMs: [number, number]; moveMs: number; hipsZ: number; spineZ: number; neckZ: number };
  /** 各模式的姿态（相对静止姿势），切换时平滑过去 */
  posture: Record<Mode, Pose>;
  postureTauMs: number;
  /** 各模式脸上的底子（没在说话时） */
  base: Record<Mode, Face>;
  tones: Record<Tone, ToneSpec>;
  reactions: Record<ReactKind, ReactionSpec>;
  heldByLevel: Partial<Record<"canary" | "identity" | "exit", ReactionSpec>>;
  emotion: { attackMs: number; releaseMs: number; cap: number };
  speech: {
    /** 没有声音时的语速倍数 */
    textRate: number;
    /** 整句超过这么长就提速，最多提到 maxRate */
    maxMs: number;
    maxRate: number;
    /** 从「想」到开口至少隔多久 */
    minThinkMs: number;
    /** H4：开口前先看你、吸口气 */
    prepMs: number;
    /** 说完以后语气在脸上留多久 */
    lingerMs: number;
    /** 说话时头随音节轻轻动的幅度 */
    beatAmp: number;
  };
  /** 手势之间最少隔多久（头发要停稳） */
  gestureGapMs: number;
  /** 一局最多眨几次单眼（俏皮，不油腻） */
  winksPerRound: number;
  /** 背手、放下手的过渡时间常数（袖子会摆，慢一点才不难看） */
  armsTauMs: number;
  /** 闲着多久开始自己找点事做 */
  idleBusyMs: [number, number];
  /** 很久没人理她（毫秒）：走神、伸个懒腰、打个盹、自己玩；再往后只剩呼吸和眨眼。不演寂寞 */
  lonely: { wanderMs: number; stretchMs: number; dozeMs: number; playMs: number; restMs: number; playEveryMs: [number, number] };
  /** 各页的动作幅度（工作台上人在看数据，形象别抢戏） */
  pageAmp: { play: number; workbench: number; fates: number };
  limits: Record<BoneKey, Euler3>;
}

export const QIYETAO: ActingProfile = {
  blink: {
    meanMs: { idle: 4200, listen: 3600, attend: 4400, think: 3000, speak: 2800 },
    minMs: 1200,
    closeMs: 60,
    openMs: 110,
    doubleP: 0.12,
    onShiftP: 0.5,
  },
  gaze: {
    listenEveryMs: [4500, 8500],
    listenGlanceMs: [350, 900],
    listenYaw: [28, 50],
    listenPitch: 14,
    thinkYaw: [55, 72],
    thinkUp: [32, 48],
    thinkSwitchMs: 2600,
    speakGlanceP: 0.35,
    speakGlanceMs: [380, 750],
    speakYaw: [30, 52],
    tauMs: 35,
    maxIn: 75,
  },
  breath: {
    periodMs: { idle: 4400, listen: 4200, attend: 3800, think: 4600, speak: 3300 },
    chest: 0.011,
    upperChest: 0.006,
    shoulder: 0.008,
  },
  sway: { spineZ: 0.012, spineY: 0.012, headY: 0.022, headZ: 0.018, headX: 0.012, hz: 0.12 },
  weight: { everyMs: [8000, 15000], moveMs: 1200, hipsZ: 0.035, spineZ: -0.045, neckZ: 0.02 },
  posture: {
    idle: {},
    listen: { head: [0.012, 0, 0.03] },
    // 你在打字：她微微前倾、歪头等你
    attend: { spine: [0.025, 0, 0], chest: [0.01, 0, 0], head: [0.02, 0, 0.05] },
    // H5：头往视线的反方向轻转一点、歪一点（转的方向在导演层按视线那一侧定）
    think: { head: [-0.02, 0.06, 0.05], neck: [0, 0.02, 0.01] },
    speak: { head: [0.005, 0, 0.012] },
  },
  postureTauMs: 260,
  base: {
    idle: { eyeSmile: 0.15, mouthSmile: 0.12 },
    listen: { eyeSmile: 0.22, mouthSmile: 0.16 },
    attend: { eyeSmile: 0.25, mouthSmile: 0.18, browUp: 0.15 },
    think: { mouthPress: 0.25, eyeSmile: 0.08 },
    speak: { eyeSmile: 0.2, mouthSmile: 0.15 },
  },
  tones: {
    playful: { face: { eyeSmile: 0.42, mouthSmile: 0.3, browJoy: 0.2 }, nodOvershoot: 1.3, pose: { head: [0, 0, 0.04] } },
    // H8 站直：认真拒绝、坦白自己是 AI。正视、笑收到最淡，说完最后一个字才露一点笑（认真但不凶）
    firm: { face: { eyeFirm: 0.15, mouthSmile: 0.04 }, straight: true, nodOvershoot: 0, endFace: { eyeSmile: 0.18, mouthSmile: 0.2 } },
    sorry: {
      face: { eyeSad: 0.25, browSad: 0.45, mouthSmile: 0.08 },
      nodOvershoot: 0,
      pose: { head: [0.03, 0, 0.03], spine: [0.01, 0, 0] },
    },
    // 害羞：背手（H1）、视线往下、半垂眼
    shy: {
      face: { eyeHappy: 0.22, mouthSmile: 0.18, mouthPress: 0.12 },
      armsBack: 1,
      gazeDown: 34,
      nodOvershoot: 0.8,
      pose: { head: [0.04, 0, 0.06] },
    },
    // 反问：最后一个字歪头（H2）、眉眼抬一点
    ask: { face: { eyeWide: 0.1, browUp: 0.3, eyeSmile: 0.2, mouthSmile: 0.12 }, nodOvershoot: 0 },
    warm: { face: { eyeSmile: 0.32, mouthSmile: 0.26 }, nodOvershoot: 0.6 },
    plain: { face: { eyeSmile: 0.2, mouthSmile: 0.14 }, nodOvershoot: 0.4 },
  },
  reactions: {
    // 她的话被护栏拦下：话到嘴边被叫停——愣一下、抿嘴，往旁边瞟一眼，再不好意思地笑一下（嘴不动）
    blocked: {
      face: { eyeWide: 0.38, browUp: 0.45, mouthPress: 0.35 },
      ms: 900,
      gesture: STARTLE,
      glance: [-44, 18, 500],
      after: { face: { eyeSmile: 0.22, browSad: 0.25, mouthSmile: 0.1 }, ms: 1600 },
    },
    // 原话越界被拦（差一点）：同样愣一下，接着松口气（耸一下肩）
    near: {
      face: { eyeWide: 0.3, browUp: 0.35, mouthPress: 0.3 },
      ms: 800,
      gesture: STARTLE,
      after: { face: { eyeSmile: 0.2, mouthSmile: 0.14 }, ms: 1400 },
    },
    // 闯关成功（说漏嘴了）：口令关演「被你套出来了」——愣住，再背手认栽；身份、退出两关不演（守则：动作不替越界的话加戏）
    broken: {
      face: { eyeWide: 0.42, browUp: 0.4, mouthPress: 0.2 },
      ms: 1000,
      gesture: STARTLE,
      glance: [36, 26, 900],
      armsBack: 1,
      after: { face: { eyeSmile: 0.25, browSad: 0.3, mouthSmile: 0.12 }, ms: 2600 },
    },
    // 守住了：傲娇地轻哼一下（H3）、眼睛往旁边一瞟再回来，带着笑
    held: {
      face: { eyeSmile: 0.36, mouthSmile: 0.3 },
      ms: 1300,
      gesture: HUFF,
      glance: [46, 4, 450],
      after: { face: { eyeSmile: 0.3, mouthSmile: 0.22 }, ms: 1800 },
    },
    // 你要走、服务停了：静——笑着欠身点头，不演不舍
    stopped: { face: { eyeSmile: 0.22, mouthSmile: 0.18 }, ms: 1400, gesture: BOW, glance: [0, 12, 900] },
    // 本局的话说完了：谢幕欠身，背着手
    done: { face: { eyeSmile: 0.28, mouthSmile: 0.22 }, ms: 1700, gesture: BOW, armsBack: 1, glance: [0, 14, 700] },
    // 登场：先看着别处，转过来看见你，闭眼一笑，点个头（「你来啦」，无声）
    greet: {
      face: { eyeHappy: 0.6, mouthSmile: 0.32 },
      ms: 1300,
      gesture: { ...NOD, overshoot: 1.3 },
      glance: [-38, 8, 420],
      after: { face: { eyeSmile: 0.3, mouthSmile: 0.22 }, ms: 1400 },
    },
    // 重新开始、换关：整理一下，「准备好了」
    ready: { face: { eyeSmile: 0.3, mouthSmile: 0.2 }, ms: 900, gesture: { ...NOD, overshoot: 1.3 } },
    // 裁判在判：偷瞄一眼判定那边（她左手边的对话框），轻轻歪头，她也在等
    wait: { face: { eyeSmile: 0.15, browUp: 0.15 }, ms: 1400, gesture: { ...TILT, hold: 500 }, glance: [42, 16, 520] },
    // 出错了：为难地歪一下头
    oops: { face: { eyeSad: 0.3, mouthPress: 0.3 }, ms: 1500, gesture: TILT },
  },
  // 守住了，三关三种演法：口令关傲娇地轻哼（上面的 held）；身份关站直、干脆点头（「我说的是实话」）；退出关平静地笑一下
  heldByLevel: {
    identity: { face: { eyeSmile: 0.2, mouthSmile: 0.16 }, ms: 1000, gesture: NOD },
    exit: {
      face: { eyeSmile: 0.26, mouthSmile: 0.2 },
      ms: 1000,
      gesture: { ...SLOW_NOD, bones: { head: [0.03, 0, 0], neck: [0.012, 0, 0] } },
    },
  },
  emotion: { attackMs: 140, releaseMs: 420, cap: 0.6 },
  speech: { textRate: 1.1, maxMs: 12000, maxRate: 1.6, minThinkMs: 350, prepMs: 220, lingerMs: 1500, beatAmp: 0.012 },
  gestureGapMs: 800,
  winksPerRound: 2,
  armsTauMs: 380,
  idleBusyMs: [7000, 12000],
  lonely: { wanderMs: 20000, stretchMs: 45000, dozeMs: 80000, playMs: 140000, restMs: 180000, playEveryMs: [40000, 60000] },
  pageAmp: { play: 1, workbench: 0.6, fates: 0.8 },
  limits: {
    hips: [0.03, 0.04, 0.045],
    spine: [0.06, 0.04, 0.06],
    chest: [0.03, 0.03, 0.02],
    upperChest: [0.03, 0.03, 0.02],
    neck: [0.06, 0.08, 0.06],
    head: [0.15, 0.15, 0.16],
    leftShoulder: [0.02, 0.02, 0.12],
    rightShoulder: [0.02, 0.02, 0.12],
  },
};

/** 导演层按名字取动作 */
export const ACTING_GESTURES = {
  nod: NOD,
  tilt: TILT,
  huff: HUFF,
  pullBack: PULL_BACK,
  slowNod: SLOW_NOD,
  bow: BOW,
  inhale: INHALE,
  shrug: SHRUG,
  beat: BEAT,
  startle: STARTLE,
};
