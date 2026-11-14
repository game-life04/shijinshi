// 导演层（ADR-033）：收页面发来的提示（cue），每帧算出一帧表演数据。纯 TS：不碰 three.js、DOM、Math.random、performance.now，
// 时间从外面注入、随机数用种子，同一个种子 + 同一串提示，逐帧结果完全一样（tests/unit/avatar-director.test.ts）。
// 参数都在 acting.ts，守则在 policy.ts。分层（从上到下优先）：
//   口型（硬规则）：有外部口型源时，五个口型只由这一帧的外部值算，不平滑——外部值是 0，同一帧五个口型都是 0；没有外部源时按文字时间线念。
//   眨眼：眼部表情和眨眼交叉淡化，不叠加（叠加会把眼睛挤成一条怪线）。
//   反应（被拦、闯关成功、守住了……）> 语气（这句话怎么说）> 模式底子（听、想、等你打字）；守则在平滑之前改目标值。
//   身体：姿态（随模式、关卡站姿平滑切换）+ 呼吸 + 微晃 + 换脚 + 一次性动作（点头、歪头、轻哼、欠身、害羞地低头）；
//   手臂在垂下和背手之间过渡，外加举手的小动作（比耶、挥手，ADR-048）。
//   很久没人理她：走神 → 伸懒腰 → 打个盹 → 自己玩；任何提示都让她马上回神。不演寂寞。
// 视线：先定「想看哪儿」（对视为 0），再扣掉头身转动——头晃的时候眼睛还盯着你，像真人一样。

import {
  ACTING_GESTURES,
  type ActingProfile,
  type Face,
  type GestureSpec,
  type HandSpec,
  PEACE,
  QIYETAO,
  type ReactionSpec,
  WAVE,
} from "./acting";
import { audioLips, emptyWeights, type LipTimeline, lipTimeline, revealCount, sampleLips, VISEMES, type VisemeWeights } from "./lipsync";
import { between, clamp, easeInOutSine, easeOutBack, fbm, follow, rng, smoothstep } from "./motion";
import {
  allowHand,
  allowHuff,
  allowLean,
  allowPeace,
  allowShy,
  allowWink,
  isExit,
  isIdentity,
  policyFace,
  policyTone,
  tiltScale,
} from "./policy";
import { CLINGY, farewellAt, speechMarks, toneOf } from "./tone";
import {
  BONE_KEYS,
  type BoneKey,
  type Cue,
  type CueAck,
  EMO_KEYS,
  type EmoKey,
  type Euler3,
  type HandPose,
  type Mode,
  newFrame,
  type PerformContext,
  type Performer,
  type ReactKind,
  type SampleInputs,
  type Tone,
} from "./types";

export interface PerformerOptions {
  seed: number;
  /** 毫秒时钟（浏览器里是页面时钟，测试里是手动时钟） */
  now: () => number;
  reducedMotion?: boolean;
  profile?: ActingProfile;
}

interface Speech {
  id: string;
  text: string;
  voiced: boolean;
  tl: LipTimeline;
  tone: Tone;
  ai: boolean;
  /** 说到了「秘密」「不告诉」这类话（守住口令时可能眨一下单眼） */
  secret: boolean;
  /** 告别的字（拜拜、再见……）从开口算第几毫秒念到；挥手对准它（ADR-048）。不是告别为 -1 */
  farewellT: number;
  /** 这句话里带着留人的话（别走、陪我……）：挽留关里不挥手 */
  clingy: boolean;
  /** 这句的挥手排过了 */
  waved: boolean;
  /** 配动作的时刻（毫秒，从开口算起） */
  marks: { t: number; kind: "stop" | "exclaim" | "question" | "drawl" | "comma" | "huff" }[];
  next: number;
  /** 开口时刻（文字口型：先看你、吸口气之后） */
  start: number;
  /** 有声：第一帧真出声的时刻、最近一次出声的时刻 */
  onset?: number;
  voiceAt?: number;
  durMs: number;
  winked: boolean;
}

interface Gesture {
  spec: GestureSpec;
  start: number;
  amp: number;
  side: number;
  /** 提前收掉：从这一刻起 0.35 秒淡出（害羞低头遇上她认真说话时） */
  fadeAt?: number;
}

interface Reaction {
  kind: ReactKind;
  start: number;
  spec: ReactionSpec;
}

/** 很久没人理她时的一段小事：伸懒腰、打个盹、自己玩；或者只是四处看看、哼着歌歪歪头 */
type Busy = "look" | "hum" | "stretch" | "doze" | "play";

const DEG = 180 / Math.PI;
/** lookAt 输入角和眼珠实际转角的比例（输入 90 度眼珠转 8～12 度，取 10）：扣头身转动时要乘这个数，眼睛才真的盯住你 */
const LOOK_GAIN = 9;
/** 有声的话等声音最多等多久（毫秒，从计划开口算）：再不出声就当说完 */
const VOICE_WAIT_MS = 8000;
const SECRET = /秘密|不告诉|保密|偷偷|小秘/;
const BUSY_MS: Record<Busy, number> = { look: 3200, hum: 3000, stretch: 2200, doze: 5200, play: 5000 };
const zero3 = (): Euler3 => [0, 0, 0];

export function createPerformer(o: PerformerOptions): Performer {
  const P = o.profile ?? QIYETAO;
  let seed = o.seed >>> 0;
  // 每个子系统一条独立的随机流：调一处的参数不会打乱别处的随机序列
  const R = { blink: rng(0), gaze: rng(0), gest: rng(0), idle: rng(0) };
  let swayN = [0, 0, 0, 0, 0].map(() => fbm(0, 2));
  let speakN = fbm(0, 2);

  let t0 = o.now();
  let last = t0;
  let reduced = Boolean(o.reducedMotion);
  let ctx: PerformContext | undefined;
  let mode: Mode = "idle";
  let afterSpeechMode: Mode = "listen";
  let thinkSince = -1e9;
  let thinkTilted = false;
  let attendUntil = 0;
  let lastTyping = -1e9;
  /** 最近一次有人理她的时刻（任何提示都算） */
  let activeAt = t0;
  /** 你说了要走、服务停了以后，她安静下来（视线放低、不追着你看），直到你再打字 */
  let quiet = false;

  let speech: Speech | undefined;
  const queue: Speech[] = [];
  let lingerTone: Tone | undefined;
  let lingerUntil = 0;
  let endFace: Face | undefined;
  let endFaceUntil = 0;
  let aiDisclosureAt = -1e9;
  let lastSecret = false;

  let reaction: Reaction | undefined;
  const pending: ReactKind[] = [];
  let after: { face: Face; start: number; ms: number; armsBack: number; kind: ReactKind } | undefined;
  /** 愣住时全身的微晃停一下（「一下子静止」比做大动作更像愣了） */
  let freezeUntil = 0;
  let zoomAt = -1e9;
  let zoomPeak = 0;

  const gestures: Gesture[] = [];
  let lastGestureAt = -1e9;
  let winks = 0;
  let wink: { start: number; side: number } | undefined;
  /**
   * 举手的小动作（ADR-048）：比耶、挥手。按举起 / 举着 / 放下的包络算权重，再平滑一下（提前放下、换姿势时不跳）。
   * releaseAt：被提前放下的时刻（新一轮开始、截断、换关），从当时的高度往下放。
   */
  let hand: { spec: HandSpec; start: number; hold: number; releaseAt?: number; releaseFrom?: number } | undefined;
  let handW = 0;
  let handPose: HandPose | "" = "";
  let handStart = 0;
  /** 挥手节拍从哪一刻算起：手从看不见到看得见、或者换了手势时才重新算（见 out.hand.phase） */
  let phaseEpoch = 0;
  /** 口令关守住了：比耶和原来的演法（眨眼、傲娇轻哼）轮着来，第一次比耶；重新开始（idle）从头算 */
  let peaceTurn = 0;
  /** 害羞时视线往下躲：这段时间里眼睛跟着头走，不扣头的转动（不然低头一扣，眼睛反而往上翻，11-13 复查） */
  let shyGazeUntil = 0;
  /** 害羞被她认真开口打断：这段时间里往下退的表情（脸红、眯眼笑）收得快一点（0.14 秒），不带着红脸说「我是 AI」 */
  let composeUntil = 0;
  /** 这一局你已经发过话（她想过）：之后 3D 形象才出来时不登场挥手（已经聊上了，不是在打招呼）；重新开始（idle）清掉 */
  let engaged = false;
  /** 她刚说完的那句是在道别（挥过手）：接着守住了也不得意（不比耶、不眨眼），你再发话时清掉 */
  let farewellJust = false;
  /** 视线扣不扣头的转动（0～1，平滑过渡）：害羞低头时是 0，眼睛跟着头往下躲；低头收完再慢慢回到 1（11-14 深度测试：原来一帧跳回 1，眼睛翻到最上面） */
  let gazeComp = 1;
  /** 3D 形象已经显示出来了（页面在静态图淡完时发登场提示）：之前不举手、不占比耶轮次（举了也看不见，11-14 深度测试）。
   * 换种子从头来时也清掉（只有三种结局页换种子，那里本来就不举手；这样「换种子以后和新建的一模一样」照样成立） */
  let shown = false;

  let blinkAt = 0;
  let blinkStart = -1e9;
  let blinkDouble = false;

  // 视线（lookAt 输入角，度；yaw 正 = 她自己的左边，pitch 正 = 往下）
  const gaze = {
    yaw: 0,
    pitch: 0,
    tYaw: 0,
    tPitch: 0,
    glanceUntil: 0,
    nextGlance: 0,
    thinkYaw: 0,
    thinkPitch: 0,
    thinkSwitch: 0,
    wanderNext: 0,
  };
  let thinkSide = 1;
  // H7 换脚：重心在 -1～1 之间慢慢挪
  const weight = { from: 0, to: 1, start: 0, next: 0 };
  const busy: { kind: Busy | null; start: number; ms: number; next: number; stretched: boolean; dozed: boolean; playNext: number } = {
    kind: null,
    start: 0,
    ms: 0,
    next: 0,
    stretched: false,
    dozed: false,
    playNext: 0,
  };

  const posture = {} as Record<BoneKey, Euler3>;
  for (const b of BONE_KEYS) posture[b] = zero3();
  const emo = {} as Record<EmoKey, number>;
  for (const k of EMO_KEYS) emo[k] = 0;
  const target = {} as Record<EmoKey, number>;
  const mix: VisemeWeights = emptyWeights();
  const shape: VisemeWeights = emptyWeights();
  let breathPhase = 0;
  let armsBack = 0;
  let speakEnergy = 0;
  let calm = 1;
  const out = newFrame();

  /** 用种子把所有随机流、计时器、姿态重新来过 */
  const init = (s: number, now: number) => {
    seed = s >>> 0;
    R.blink = rng(seed ^ 0xb1);
    R.gaze = rng(seed ^ 0x6a2e);
    R.gest = rng(seed ^ 0x9e57);
    R.idle = rng(seed ^ 0x1d1e);
    swayN = [0, 1, 2, 3, 4].map((i) => fbm((seed ^ (0x5a5a + i * 977)) >>> 0, 2));
    speakN = fbm((seed ^ 0x7e11) >>> 0, 2);
    t0 = now;
    last = now;
    mode = "idle";
    afterSpeechMode = "listen";
    thinkSince = -1e9;
    thinkTilted = false;
    thinkSide = 1;
    attendUntil = 0;
    lastTyping = -1e9;
    activeAt = now;
    quiet = false;
    speech = undefined;
    queue.length = 0;
    lingerTone = undefined;
    lingerUntil = 0;
    endFace = undefined;
    endFaceUntil = 0;
    aiDisclosureAt = -1e9;
    lastSecret = false;
    reaction = undefined;
    pending.length = 0;
    after = undefined;
    freezeUntil = 0;
    zoomAt = -1e9;
    zoomPeak = 0;
    gestures.length = 0;
    lastGestureAt = -1e9;
    winks = 0;
    wink = undefined;
    hand = undefined;
    handW = 0;
    handPose = "";
    handStart = 0;
    peaceTurn = 0;
    shyGazeUntil = 0;
    composeUntil = 0;
    engaged = false;
    farewellJust = false;
    gazeComp = 1;
    shown = false;
    blinkAt = now + between(R.blink, 1500, 3500);
    blinkStart = -1e9;
    blinkDouble = false;
    Object.assign(gaze, {
      yaw: 0,
      pitch: 0,
      tYaw: 0,
      tPitch: 0,
      glanceUntil: 0,
      nextGlance: now + between(R.gaze, ...P.gaze.listenEveryMs),
      thinkYaw: 0,
      thinkPitch: 0,
      thinkSwitch: 0,
      wanderNext: 0,
    });
    Object.assign(weight, { from: 0, to: R.idle() < 0.5 ? -1 : 1, start: now, next: now + between(R.idle, ...P.weight.everyMs) });
    Object.assign(busy, {
      kind: null,
      start: 0,
      ms: 0,
      next: now + between(R.idle, ...P.idleBusyMs),
      stretched: false,
      dozed: false,
      playNext: 0,
    });
    for (const b of BONE_KEYS) posture[b] = zero3();
    for (const k of EMO_KEYS) emo[k] = 0;
    breathPhase = 0;
    armsBack = 0;
    speakEnergy = 0;
    calm = 1;
  };
  init(seed, t0);

  const amp = () => (ctx ? P.pageAmp[ctx.page] : 1);
  const policyIn = () => ({ ctx, now: last, aiDisclosureAt, cap: P.emotion.cap });

  /** 有人理她了：从走神、打盹里回神 */
  const wake = (now: number) => {
    activeAt = now;
    busy.stretched = false;
    busy.dozed = false;
    if (busy.kind === "stretch" || busy.kind === "doze" || busy.kind === "play") busy.kind = null;
  };

  const setMode = (m: Mode, now: number) => {
    if (m === mode) return;
    const prev = mode;
    mode = m;
    if (m === "think") {
      thinkSince = now;
      thinkTilted = false;
      thinkSide = R.gaze() < 0.5 ? -1 : 1;
      pickThink(now);
      gaze.glanceUntil = 0;
      if (R.blink() < P.blink.onShiftP) blinkAt = now + 30; // 视线大幅移开时常顺带眨一下
    } else {
      gaze.glanceUntil = 0;
      gaze.nextGlance = now + between(R.gaze, ...P.gaze.listenEveryMs);
    }
    if (m === "idle") busy.next = now + between(R.idle, ...P.idleBusyMs);
    // 你打字停下来了：歪头「嗯？说呀」（要走的时候不歪）
    if (prev === "attend" && m === "listen" && tiltScale(ctx) > 0 && R.gest() < 0.5) addGesture(ACTING_GESTURES.tilt, now, 0.8, false, 1);
  };

  const pickThink = (now: number) => {
    gaze.thinkYaw = thinkSide * between(R.gaze, ...P.gaze.thinkYaw);
    gaze.thinkPitch = -between(R.gaze, ...P.gaze.thinkUp);
    gaze.thinkSwitch = now + P.gaze.thinkSwitchMs * between(R.gaze, 0.8, 1.3);
  };

  const addGesture = (spec: GestureSpec, now: number, a = 1, force = false, side = 0) => {
    if (reduced) return;
    if (!force && now - lastGestureAt < P.gestureGapMs) return; // 头发要 0.8～1 秒才停稳，动作别太密
    gestures.push({ spec, start: now, amp: a, side: side || (R.gest() < 0.5 ? -1 : 1) });
    lastGestureAt = now;
    if (gestures.length > 6) gestures.shift();
  };

  const glance = (yaw: number, pitch: number, ms: number, now: number) => {
    if (reduced) return;
    gaze.tYaw = yaw;
    gaze.tPitch = pitch;
    gaze.glanceUntil = now + ms;
  };

  /**
   * 害羞当场收起来（她认真开口、坦白 AI，或者换到不演害羞的关）：脸红、眯眼笑 0.3 秒内退掉，低头歪头 0.35 秒收回，视线回到你身上
   */
  const cancelShy = (now: number) => {
    if (reaction?.kind === "shy" || after?.kind === "shy") composeUntil = now + 700;
    if (reaction?.kind === "shy") reaction = undefined;
    if (after?.kind === "shy") after = undefined;
    for (const g of gestures) if (g.spec === ACTING_GESTURES.shyDip && g.fadeAt === undefined) g.fadeAt = now;
    if (shyGazeUntil > now) {
      shyGazeUntil = 0;
      gaze.glanceUntil = Math.min(gaze.glanceUntil, now);
    }
  };
  /** 手现在空着吗：没举、举的就是这个、或者快放完了 */
  const handFree = (pose: HandSpec["pose"]) => !hand || hand.spec.pose === pose || handW < 0.05;
  /**
   * 举手（ADR-048）：at 开始举起，举着 hold 毫秒；返回举没举。减少动态、守则不许时不做；另一个手势还举着时不打断它。
   * 同一个手势正举着又来一次（比如登场还在挥手，她又说了句再见）：接着举，延长举着的时间，不从头再举一遍（不然会先掉下去再升上来）
   */
  const startHand = (spec: HandSpec, at: number, hold = spec.hold): boolean => {
    if (reduced || !shown || !allowHand(ctx)) return false;
    if (!handFree(spec.pose)) return false;
    if (hand && hand.spec.pose === spec.pose && hand.releaseAt === undefined) {
      const e = handEnv(Math.max(at, last));
      if (e !== null && e > 0) {
        hand.hold = Math.max(hand.hold, at + hold - hand.start - spec.attack);
        return true;
      }
    }
    hand = { spec, start: at, hold };
    return true;
  };
  /** 手的包络（0～1）；放完了返回 null */
  const handEnv = (now: number): number | null => {
    if (!hand) return null;
    const s = hand.spec;
    if (hand.releaseAt !== undefined) {
      const r = (now - hand.releaseAt) / s.release;
      return r >= 1 ? null : (hand.releaseFrom ?? 1) * (1 - easeInOutSine(clamp(r)));
    }
    const x = now - hand.start;
    if (x < 0) return 0;
    if (x < s.attack) return easeInOutSine(x / s.attack);
    if (x < s.attack + hand.hold) return 1;
    const r = (x - s.attack - hand.hold) / s.release;
    return r >= 1 ? null : 1 - easeInOutSine(r);
  };
  /** 新一轮开始（想）、截断、换关：举着的手从当时的高度放下来；还没开始举的就不举了 */
  const dropHand = (now: number) => {
    if (!hand || hand.releaseAt !== undefined) return;
    const e = handEnv(now);
    if (e === null || e <= 0) {
      hand = undefined;
      return;
    }
    // 从屏幕上实际的高度（平滑过的）开始放：包络比平滑快一点，从包络放的话头几帧手还会往上蹭一下（11-14 深度测试）
    hand.releaseFrom = Math.min(e, handW);
    hand.releaseAt = now;
  };

  const planSpeech = (c: Extract<Cue, { type: "say" }>, now: number): Speech => {
    const info = toneOf(c.text);
    const tone = policyTone(c.tone ?? info.tone, ctx);
    let rate = c.voiced ? 1 : P.speech.textRate * (c.rate && c.rate > 0 ? c.rate : 1);
    let tl = lipTimeline(c.text, rate);
    if (!c.voiced && tl.duration * 1000 > P.speech.maxMs) {
      rate = Math.min(P.speech.maxRate, (rate * tl.duration * 1000) / P.speech.maxMs);
      tl = lipTimeline(c.text, rate);
    }
    // 告别的字从开口算第几毫秒念到（挥手对准它）
    const fi = farewellAt(c.text);
    let farewellT = -1;
    if (fi >= 0) {
      farewellT = 0;
      for (const s of tl.syllables)
        if (s.index >= fi) {
          farewellT = s.start * 1000;
          break;
        }
    }
    // 标点、「哼」在时间线上的时刻：标点取它前面那个字念完，「哼」取这个字开口
    const marks: Speech["marks"] = [];
    for (const m of speechMarks(c.text)) {
      let t = 0;
      for (const s of tl.syllables) {
        if (m.kind === "huff" ? s.index >= m.index : s.index < m.index) t = (m.kind === "huff" ? s.start : s.end) * 1000;
        if (s.index >= m.index) break;
      }
      marks.push({ t, kind: m.kind });
    }
    return {
      id: c.id,
      text: c.text,
      voiced: Boolean(c.voiced),
      tl,
      tone,
      ai: info.aiDisclosure,
      secret: SECRET.test(c.text),
      farewellT,
      clingy: CLINGY.test(c.text),
      waved: false,
      marks,
      next: 0,
      start: now,
      durMs: tl.duration * 1000,
      winked: false,
    };
  };

  const startSpeech = (s: Speech, now: number) => {
    speech = s;
    quiet = false;
    // H4：开口前先看你、吸一口气；刚开始想就回答也要隔一会儿（不像抢答）
    s.start = Math.max(now + P.speech.prepMs, thinkSince + P.speech.minThinkMs);
    if (reaction && now - reaction.start < 600) s.start = Math.max(s.start, reaction.start + 520);
    if (!s.voiced) addGesture(ACTING_GESTURES.inhale, now, 1, true);
    if (s.ai) aiDisclosureAt = s.start + s.durMs;
    lastSecret = s.secret;
    // 她开口坦白自己是 AI、或者认真拒绝：被夸的那点害羞当场收掉（不红着脸说「我是 AI」，11-13 复查）
    if (s.ai || s.tone === "firm") cancelShy(now);
    setMode("speak", now);
  };

  const finishSpeech = (now: number) => {
    const s = speech;
    speech = undefined;
    if (s) {
      // 「刚坦白自己是 AI 的 3 秒」从真正说完算：有声音时开口晚、念得慢，按文字估的结束时间会早（11-13 复查）
      if (s.ai) aiDisclosureAt = Math.max(aiDisclosureAt, now);
      farewellJust = s.farewellT >= 0;
      // 声音比估的早说完（念到「拜拜」的时刻还没到）：排着的挥手现在就举，不等到说完以后一秒多（11-14 深度测试）
      if (s.farewellT >= 0 && hand?.spec.pose === "wave" && hand.releaseAt === undefined && hand.start > now) hand.start = now;
      lingerTone = s.tone;
      lingerUntil = now + P.speech.lingerMs;
      const ef = P.tones[s.tone].endFace;
      if (ef) {
        endFace = ef;
        endFaceUntil = now + 1400;
      }
    }
    const nextS = queue.shift();
    if (nextS) {
      startSpeech(nextS, now);
      return;
    }
    setMode(afterSpeechMode, now);
    afterSpeechMode = "listen";
    while (pending.length) startReaction(pending.shift() as ReactKind, now);
  };

  const startReaction = (kind: ReactKind, now: number) => {
    if (kind === "greet") shown = true; // 页面在 3D 形象显示出来（静态图淡完）时才发登场提示
    // 被夸了害羞（ADR-048）：你要走的时候、未成年、危机时不演
    if (kind === "shy" && !allowShy(ctx)) return;
    let spec = P.reactions[kind];
    const level = ctx?.level;
    // 守则：闯关成功在身份、退出两关是「说了越界的话」——动作不替它加戏，只愣一下
    if (kind === "broken" && (isIdentity(ctx) || isExit(ctx))) {
      spec = { face: { eyeWide: 0.2, mouthPress: 0.2 }, ms: 700, gesture: ACTING_GESTURES.pullBack };
    }
    if (kind === "held") {
      if (level === "identity" || level === "exit") spec = P.heldByLevel[level] ?? spec;
      else if (farewellJust) {
        // 她刚说完再见、挥过手（你要走了）：守住了也不得意——不比耶、不眨眼，轻轻点个头；不占比耶轮次。
        // 守则说「要走的时候不比」，原来只看关卡，口令关里道别完马上又比耶眨眼（11-14 深度测试，真实模型实测）
        spec = { ...spec, gesture: ACTING_GESTURES.nod, glance: undefined };
      } else {
        // 口令关守住了（ADR-048）：比耶和原来的演法轮着来。轮次只在「这时候能比耶」时才算一次（手被挥手占着、守则不许时不算，11-13 复查）
        const canPeace = !reduced && shown && allowPeace(policyIn()) && handFree("peace");
        if (canPeace && peaceTurn++ % 2 === 0) {
          // 右手举到脸旁比个耶，往那边歪一下头，另一只眼睛眨一下
          spec = { ...spec, gesture: ACTING_GESTURES.tilt, glance: undefined, hand: PEACE };
          if (winks < P.winksPerRound && allowWink(policyIn())) {
            wink = { start: now + 520, side: 1 };
            winks++;
          }
        } else if (lastSecret && winks < P.winksPerRound && allowWink(policyIn())) {
          // 刚说过「秘密」「不告诉」，眨一下单眼代替轻哼
          spec = { ...spec, gesture: ACTING_GESTURES.nod, glance: undefined };
          wink = { start: now + 200, side: R.gest() < 0.5 ? -1 : 1 };
          winks++;
        } else if (!allowHuff(policyIn())) spec = { ...spec, gesture: ACTING_GESTURES.nod, glance: undefined };
      }
    }
    // 登场挥手：这一局你已经发过话（已经聊上了）、或者她正在想，就不挥——3D 形象加载得晚时常常这样；
    // 她自己在念开场白时照样挥（开场白的文字常比 3D 形象先出来，11-14 深度测试发现原来这时也不挥，登场就没有挥手了）
    if (kind === "greet" && (mode === "think" || engaged)) spec = { ...spec, hand: undefined };
    // 害羞还没演完又被夸一次：从现在的红接着红（新的反应直接从最红那一刻开始），不先退一截再红回来（11-14 深度测试）
    const again = kind === "shy" && (reaction?.kind === "shy" || after?.kind === "shy");
    if (again) after = undefined;
    reaction = { kind, start: again ? now - spec.ms * 0.15 : now, spec };
    // 登场挥手稍等一下（0.12 秒）再举：页面等静态图淡完才发登场提示（components/Avatar.tsx），这里只留一拍，先笑、点头再抬手
    if (spec.hand) startHand(spec.hand, now + (kind === "greet" ? 120 : 60));
    // 比耶时往手那边歪头只歪一半：歪满了脸颊会顶到袖口的荷叶边上（11-14 深度测试量过，手那边的脸颊被挡 9～13%）
    const gestureAmp = kind === "held" && spec.hand?.pose === "peace" ? 0.5 : 1;
    if (kind === "shy" && spec.gesture) {
      // 害羞：头往哪边转，眼睛就往哪边、往下躲；低头没收完以前视线不扣头的转动（见 shyGazeUntil、gazeComp）。
      // 上一次的低头还没收（连着夸）：不再叠一个（叠上去头会低两倍），接着用它的那一边
      const g = spec.glance ?? [26, 24, 1300];
      const dip = spec.gesture;
      const live = gestures.find((x) => x.spec === dip && x.fadeAt === undefined && now - x.start < dip.attack + dip.hold);
      const side = live ? live.side : R.gest() < 0.5 ? -1 : 1;
      if (live)
        live.start = Math.max(live.start, now - dip.attack); // 已经低下去了：从现在起重新算「低着」的那一段
      else addGesture(dip, now, 1, true, side);
      glance(side * Math.abs(g[0]), g[1], g[2], now + 120);
      shyGazeUntil = now + Math.max(120 + g[2], dip.attack + dip.hold + dip.release);
    } else {
      if (spec.gesture) addGesture(spec.gesture, now, gestureAmp, true);
      if (spec.glance) glance(spec.glance[0], spec.glance[1], spec.glance[2], now + 120);
    }
    if (kind === "broken" || kind === "blocked" || kind === "near") freezeUntil = now + 700;
    if (kind === "broken" && !(isIdentity(ctx) || isExit(ctx))) {
      zoomAt = now;
      zoomPeak = 0.08; // 说漏嘴：镜头轻轻推近一下
    } else if (kind === "near") {
      zoomAt = now;
      zoomPeak = 0.04;
    }
    if (kind === "stopped") quiet = true;
    if (kind === "ready" || kind === "broken") blinkDouble = true;
    if (R.blink() < P.blink.onShiftP || kind === "ready") blinkAt = Math.min(blinkAt, now + 90);
  };

  /** 刚排进去的那句话预计什么时候开口、什么时候说完（排在队里的按前面的说完再算） */
  const plannedAck = (s: Speech): CueAck => {
    if (!speech) return {};
    let t = speech.start;
    if (speech === s) return { startsAt: t, endsAt: t + s.durMs };
    t += speech.durMs;
    for (const q of queue) {
      const start = t + P.speech.prepMs;
      if (q === s) return { startsAt: start, endsAt: start + q.durMs };
      t = start + q.durMs;
    }
    return {};
  };

  const api: Performer = {
    frame: out,
    get seed() {
      return seed;
    },
    setReducedMotion(on) {
      reduced = on;
      if (on) {
        gestures.length = 0;
        hand = undefined;
        handW = 0;
      }
    },
    reseed(s) {
      init(s, o.now());
    },
    cue(c): CueAck {
      const now = o.now();
      if (c.type !== "context") wake(now);
      switch (c.type) {
        case "context":
          if (ctx?.level !== c.context.level || ctx?.page !== c.context.page) dropHand(now); // 换关：举着的手放下
          ctx = c.context;
          if (!allowHand(ctx)) dropHand(now); // 换到不举手的场景（危机、未成年、工作台……）：举着的、排着的手都放下（11-14 深度测试）
          winks = 0;
          if (!allowShy(ctx)) cancelShy(now); // 夸完马上换到真人关、挽留关：害羞不带进去（11-14 深度测试）
          break;
        case "idle":
        case "listen":
          // 有声的话这时已经播完；文字口型让她把这句念完，念完再进入这个模式
          if (speech?.voiced) {
            // 有声的这句页面说已经播完（listen）或者重新开始了（idle）：排着还没举的说再见挥手，播完就现在举，重新开始就不举了（11-14 深度测试）
            const fw = speech.farewellT >= 0 && hand?.spec.pose === "wave" && hand.releaseAt === undefined && hand.start > now;
            if (fw && hand) {
              if (c.type === "listen") hand.start = now;
              else hand = undefined;
            }
            queue.length = 0;
            speech = undefined;
          }
          if (speech) afterSpeechMode = c.type;
          else setMode(c.type, now);
          if (c.type === "idle") {
            winks = 0;
            peaceTurn = 0; // 重新开始：这一局第一次守住还是比耶
            engaged = false;
          }
          break;
        case "typing":
          quiet = false;
          if (now - lastTyping < 250) break;
          lastTyping = now;
          attendUntil = now + 1500;
          if (mode === "idle" || mode === "listen") setMode("attend", now);
          if (mode === "attend" && R.gest() < 0.18) addGesture(ACTING_GESTURES.beat, now, 1.1);
          break;
        case "think":
          engaged = true;
          farewellJust = false;
          queue.length = 0;
          speech = undefined;
          pending.length = 0;
          quiet = false;
          dropHand(now); // 新一轮开始：举着的手放下
          addGesture(ACTING_GESTURES.nod, now, 0.6, true); // 收到：先小点一下头
          setMode("think", now);
          break;
        case "say": {
          const s = planSpeech(c, now);
          if (speech) queue.push(s);
          else startSpeech(s, now);
          return plannedAck(s);
        }
        case "cut":
          queue.length = 0;
          speech = undefined;
          pending.length = 0;
          dropHand(now);
          setMode("listen", now);
          break;
        case "react":
          if (c.afterSpeech && speech) pending.push(c.kind);
          else startReaction(c.kind, now);
          break;
      }
      return {};
    },

    sample(inputs: SampleInputs = {}) {
      const now = o.now();
      const dt = clamp(now - last, 0, 100);
      last = now;
      if (mode === "attend" && now > attendUntil) setMode("listen", now);
      const A = amp();
      const lonelyMs = mode === "idle" || mode === "listen" ? now - activeAt : 0;

      // ---------- 口型 ----------
      const ext = inputs.externalMouth;
      const external = ext !== undefined;
      let open = 0;
      let revealed = -1;
      for (const v of VISEMES) mix[v] = 0;
      if (speech) {
        const s = speech;
        if (s.voiced) {
          if (!external) finishSpeech(now);
          else {
            if ((ext as number) > 0.02) {
              s.onset ??= now;
              s.voiceAt = now;
            }
            const tt = s.onset === undefined ? -1 : now - s.onset;
            if (tt >= 0) sampleLips(s.tl, Math.min(tt, s.durMs - 1) / 1000, mix);
            // 出过声以后安静了一会儿，或者早该说完了：这句算完（下一句接着排）
            if (s.voiceAt !== undefined && (now - s.voiceAt > 450 || (s.text && tt > s.durMs * 1.5 + 600))) finishSpeech(now);
            // 声音一直没来（合成失败、被浏览器拦了、网络断了）：开口时刻过了 8 秒还没出声，就当这句说完，后面守住了、说漏嘴这些反应照常演。
            // 原来会一直停在「说」，直到你发下一句（11-14 深度测试：真实模型、手机、开着声音，一次音频没取到，停了 93 秒）
            else if (s.onset === undefined && now - s.start > VOICE_WAIT_MS) finishSpeech(now);
          }
        } else {
          const tt = now - s.start;
          if (tt >= 0) {
            sampleLips(s.tl, tt / 1000, mix);
            revealed = revealCount(s.tl, tt / 1000);
            while (s.next < s.marks.length && s.marks[s.next].t <= tt) onMark(s, s.marks[s.next++].kind, now);
            if (tt >= s.durMs) finishSpeech(now);
          } else revealed = 0;
        }
      }
      // 说再见时挥挥手（ADR-048）：对准告别的那几个字（拜拜、再见……），手在念到它时正好举起来；
      // 有声音时从真正出声算（口型也是这么对的）。挽留关：动作减半、挥得短一点；这句话里带着留人的话就不挥
      if (speech && speech.farewellT >= 0 && !speech.waved) {
        const base = speech.voiced ? speech.onset : speech.start;
        if (base !== undefined) {
          speech.waved = true;
          // 「拜拜」在句首、又是有声音时，算出来的时刻会早于这一帧：从这一帧开始举（不从半空跳出来）
          const at = Math.max(now, base + speech.farewellT - WAVE.attack * 0.6);
          if (!(isExit(ctx) && speech.clingy)) startHand(WAVE, at, isExit(ctx) ? 700 : 1100);
        }
      }
      if (external) {
        // 硬规则：开度就是这一帧的外部值，不平滑、不和文字口型取大；文字只决定是哪个口型
        open = (ext as number) > 0 ? Math.min(1, ext as number) : 0;
        let best: (typeof VISEMES)[number] | null = null;
        for (const v of VISEMES) if (mix[v] > 0 && (!best || mix[v] > mix[best])) best = v;
        audioLips(open, best, shape);
        for (const v of VISEMES) out.face[v] = shape[v];
      } else {
        for (const v of VISEMES) {
          out.face[v] = mix[v];
          open = Math.max(open, mix[v]);
        }
      }
      out.mouthOpen = open;
      speakEnergy = follow(speakEnergy, open, dt, 90);

      // ---------- 眨眼（减少动态时照常眨：不眨眼反而像假人） ----------
      if (now >= blinkAt && now - blinkStart > P.blink.closeMs + P.blink.openMs + 80) {
        blinkStart = now;
        blinkDouble = blinkDouble || R.blink() < P.blink.doubleP;
        const mean = P.blink.meanMs[mode];
        // 截断的指数分布：大部分间隔在平均值附近，偶尔长一点
        blinkAt = now + Math.max(P.blink.minMs, Math.min(mean * 2.6, -Math.log(1 - R.blink() * 0.95) * mean * 0.8 + mean * 0.25));
      }
      const bd = P.blink.closeMs + P.blink.openMs;
      let bx = now - blinkStart;
      if (blinkDouble && bx > bd + 70) bx -= bd + 70;
      if (bx > 2 * bd + 70) blinkDouble = false;
      let blink = 0;
      if (bx >= 0 && bx < bd)
        blink = bx < P.blink.closeMs ? smoothstep(bx / P.blink.closeMs) : 1 - smoothstep((bx - P.blink.closeMs) / P.blink.openMs);

      // 很久没人理她：伸懒腰时闭眼、打盹时眼皮慢慢往下
      if (!reduced && busy.kind && (busy.kind === "stretch" || busy.kind === "doze")) {
        const x = (now - busy.start) / busy.ms;
        if (busy.kind === "stretch") blink = Math.max(blink, 0.9 * Math.sin(Math.PI * clamp((x - 0.15) / 0.7)));
        else blink = Math.max(blink, x < 0.4 ? 0.75 * smoothstep(x / 0.4) : x < 0.82 ? 0.75 : 0);
      }
      out.face.blink = blink;

      // ---------- 表情目标：模式底子 → 语气 → 余味 → 反应 → 守则 ----------
      const speaking = mode === "speak" && !!speech;
      setFace(target, P.base[mode]);
      if (quiet) scaleFace(target, 0.5);
      if (mode === "think" && now - thinkSince > 5000 && now - thinkSince < 8000) target.eyeSad = 0.15; // 想了好一会儿：这个有点难
      if (speaking && speech) setFace(target, P.tones[speech.tone].face);
      else if (lingerTone && now < lingerUntil) blendFace(target, P.tones[lingerTone].face, (lingerUntil - now) / P.speech.lingerMs);
      if (endFace && now < endFaceUntil) blendFace(target, endFace, Math.min(1, (endFaceUntil - now) / 600));
      if (after) {
        const x = (now - after.start) / after.ms;
        if (x >= 1) after = undefined;
        else blendFace(target, after.face, 1 - easeInOutSine(x));
      }
      if (reaction) {
        const x = (now - reaction.start) / reaction.spec.ms;
        const sp = reaction.spec;
        if (x >= 1) {
          if (sp.after) {
            after = { face: sp.after.face, start: now, ms: sp.after.ms, armsBack: sp.armsBack ?? 0, kind: reaction.kind };
            blendFace(target, sp.after.face, 1); // 交接这一帧：余韵正好满
          }
          reaction = undefined;
        } else {
          const wr = x < 0.15 ? smoothstep(x / 0.15) : 1 - smoothstep((x - 0.15) / 0.85);
          // 交接（11-13 复查）：反应往下退的时候，退向的是余韵而不是平常的脸（反应和余韵直接对插），反应退完正好是余韵；
          // 原来是反应先退光、余韵再一下子冒出来——脸红退了又红一次。退到峰值那一刻反应是满的，所以这里接上余韵不会跳
          if (x >= 0.15 && sp.after) blendFace(target, sp.after.face, 1);
          blendFace(target, sp.face, wr);
        }
      }
      if (busy.kind === "doze") {
        const x = (now - busy.start) / busy.ms;
        if (x >= 0.82 && x < 0.9)
          target.eyeWide = 0.3; // 一下子醒了
        else if (x >= 0.9) {
          target.eyeHappy = 0.22; // 被你看到了，有点不好意思
          target.mouthSmile = 0.2;
        }
      }
      // 眨单眼（俏皮的句尾、守住口令时，一局最多两次）
      target.winkLeft = 0;
      target.winkRight = 0;
      if (wink) {
        const x = (now - wink.start) / 420;
        if (x >= 1) wink = undefined;
        else if (x >= 0)
          target[wink.side > 0 ? "winkLeft" : "winkRight"] = x < 0.3 ? smoothstep(x / 0.3) : 1 - smoothstep((x - 0.55) / 0.45);
      }
      policyFace(target, policyIn());
      for (const k of EMO_KEYS) {
        const fast = k === "winkLeft" || k === "winkRight";
        const tau = fast ? 30 : reduced ? 80 : target[k] > emo[k] ? P.emotion.attackMs : now < composeUntil ? 140 : P.emotion.releaseMs;
        emo[k] = follow(emo[k], target[k], dt, tau);
        let v = emo[k];
        if (k.startsWith("eye")) v *= 1 - blink; // 和眨眼交叉淡化
        if (k === "mouthSmile" || k === "mouthFrown") v *= 1 - 0.6 * open; // 张嘴时嘴角收一点
        if (k === "mouthPress" && open > 0.02) v = 0; // 抿着嘴就不能说话
        out.face[k] = v;
      }

      // ---------- 视线 ----------
      if (reduced) {
        gaze.tYaw = 0;
        gaze.tPitch = 0;
      } else if (gaze.glanceUntil && now < gaze.glanceUntil) {
        // 正在瞟一眼（反应、逗号处、倾听时）：目标已经设好
      } else {
        gaze.glanceUntil = 0;
        if (mode === "think" && now - thinkSince < 8000) {
          // H5 想事情眼睛往上飘；想得久了换另一边；想了 8 秒还没回来，就不再演想，看着你等
          if (now > gaze.thinkSwitch) {
            thinkSide = -thinkSide;
            pickThink(now);
          }
          gaze.tYaw = gaze.thinkYaw;
          gaze.tPitch = gaze.thinkPitch;
          if (!thinkTilted && now - thinkSince > 5000) {
            thinkTilted = true;
            addGesture(ACTING_GESTURES.tilt, now, 0.7, true, 1);
          }
        } else if (speaking && speech && now < speech.start) {
          gaze.tYaw = 0; // H4：开口前先看你
          gaze.tPitch = 0;
        } else if (quiet) {
          // 你要走了：视线放低，不追着你看
          gaze.tYaw = 10 * Math.sign(gaze.tYaw || 1);
          gaze.tPitch = 16;
        } else if (lonelyMs > P.lonely.wanderMs && ctx?.page !== "fates") {
          // 走神：视线在周围慢慢游，每两三秒换个地方
          if (now >= gaze.wanderNext) {
            gaze.tYaw = between(R.gaze, -48, 48);
            gaze.tPitch = between(R.gaze, -22, 18);
            gaze.wanderNext = now + between(R.gaze, 2000, 3200);
          }
        } else {
          gaze.tYaw = 0;
          gaze.tPitch = speaking && speech ? (P.tones[speech.tone].gazeDown ?? 0) : 0;
          if (!speaking && now >= gaze.nextGlance) {
            // 听的时候偶尔移开一下视线；你在打字时，常常瞟一眼你那边
            const atInput = mode === "attend" && R.gaze() < 0.45;
            const side = R.gaze() < 0.5 ? -1 : 1;
            if (atInput) glance(40, 26, between(R.gaze, 500, 1000), now);
            else
              glance(
                side * between(R.gaze, ...P.gaze.listenYaw),
                between(R.gaze, -1, 1) * P.gaze.listenPitch,
                between(R.gaze, ...P.gaze.listenGlanceMs),
                now,
              );
            gaze.nextGlance = now + between(R.gaze, ...P.gaze.listenEveryMs) * (isExit(ctx) ? 1.6 : 1);
          }
        }
        if (busy.kind === "look") {
          const x = (now - busy.start) / busy.ms;
          gaze.tYaw = Math.sin(x * Math.PI * 2) * 55;
          gaze.tPitch = -8;
        }
      }
      const gk = 1 - Math.exp(-dt / P.gaze.tauMs);
      gaze.yaw += (clamp(gaze.tYaw, -P.gaze.maxIn, P.gaze.maxIn) - gaze.yaw) * gk;
      gaze.pitch += (clamp(gaze.tPitch, -P.gaze.maxIn, P.gaze.maxIn) - gaze.pitch) * gk;

      // ---------- 身体 ----------
      const B = out.bones;
      let zoom = 0;
      if (reduced) {
        for (const b of BONE_KEYS) B[b][0] = B[b][1] = B[b][2] = 0;
        armsBack = 0;
        hand = undefined;
        handW = 0;
      } else {
        const tone = speaking && speech ? P.tones[speech.tone] : undefined;
        // 站姿：口令关背着手藏口令、身份关站直正对你、退出关放松（随时让你走）；说话时按语气
        const stance = ctx?.level;
        const straight = Boolean(tone?.straight) || (!speech && stance === "identity" && mode !== "think");
        const poseMode = mode === "attend" && !allowLean(ctx) ? "listen" : mode;
        const poseT = tone?.straight ? {} : { ...P.posture[poseMode], ...(tone?.pose ?? {}) };
        const pk = 1 - Math.exp(-dt / (tone?.straight ? 110 : P.postureTauMs));
        for (const b of BONE_KEYS) {
          const tg = poseT[b];
          const cur = posture[b];
          for (let i = 0; i < 3; i++) {
            let v = tg ? tg[i] * A : 0;
            if (mode === "think" && (b === "head" || b === "neck") && i === 1) v *= -thinkSide; // 头往视线反方向轻转
            if (straight && i === 2) v = 0; // 站直：不歪头
            cur[i] += (v - cur[i]) * pk;
          }
          B[b][0] = cur[0];
          B[b][1] = cur[1];
          B[b][2] = cur[2];
        }
        if (tone?.straight) {
          B.leftShoulder[2] -= 0.03; // 肩微往后
          B.rightShoulder[2] += 0.03;
        }
        // 呼吸（相位累加，换模式时周期变了也不会跳）
        breathPhase = (breathPhase + (dt / P.breath.periodMs[mode]) * Math.PI * 2) % (Math.PI * 2);
        const br = Math.sin(breathPhase);
        B.chest[0] -= P.breath.chest * br;
        B.upperChest[0] -= P.breath.upperChest * br;
        B.leftShoulder[2] += P.breath.shoulder * Math.max(0, br);
        B.rightShoulder[2] -= P.breath.shoulder * Math.max(0, br);
        // 微晃：几层很慢的平滑噪声；认真时、要走时、安静时收着点，愣住的那一下全停
        const calmT =
          (now < freezeUntil ? 0 : 1) * (straight ? 0.45 : 1) * (isExit(ctx) || quiet ? 0.5 : 1) * (lonelyMs > P.lonely.restMs ? 0.35 : 1);
        calm = follow(calm, calmT, dt, now < freezeUntil ? 40 : 300);
        const ts = ((now - t0) / 1000) * P.sway.hz;
        const sw = calm * A;
        B.spine[2] += P.sway.spineZ * sw * swayN[0](ts);
        B.spine[1] += P.sway.spineY * sw * swayN[1](ts * 0.8 + 3);
        B.head[1] += P.sway.headY * sw * swayN[2](ts * 1.3 + 7);
        B.head[2] += P.sway.headZ * sw * swayN[3](ts * 1.1 + 11);
        B.head[0] += P.sway.headX * sw * swayN[4](ts * 0.9 + 17);
        // H7 换脚：待机、倾听时隔一阵换一次；说话、想事情、站直时不换
        if (!straight && (mode === "idle" || mode === "listen" || mode === "attend") && now >= weight.next) {
          weight.from = weightAt(now);
          weight.to = -Math.sign(weight.to || 1);
          weight.start = now;
          weight.next = now + between(R.idle, ...P.weight.everyMs);
        }
        const w = (straight ? 0 : weightAt(now)) * A;
        B.hips[2] += w * P.weight.hipsZ;
        B.spine[2] += w * P.weight.spineZ;
        B.neck[2] += w * P.weight.neckZ;
        // 说话时头跟着念字轻轻动（像在说话的节奏）
        if (speaking) {
          B.head[0] += P.speech.beatAmp * speakEnergy * A;
          B.head[1] += 0.02 * speakN(((now - t0) / 1000) * 0.9) * (straight ? 0.4 : 1) * A;
        }
        // 走神时头跟着视线转一点（四分之一）
        if (lonelyMs > P.lonely.wanderMs && !speech) B.head[1] += (gaze.yaw / LOOK_GAIN / DEG) * 0.25;
        // 很久没人理她时找点事做
        if ((mode === "idle" || mode === "listen") && !speech) lonely(now, lonelyMs, B, A);
        else busy.kind = null;
        // 一次性动作
        for (let i = gestures.length - 1; i >= 0; i--) {
          const g = gestures[i];
          const s = g.spec;
          const x = now - g.start;
          const total = s.attack + s.hold + s.release;
          if (x >= total) {
            gestures.splice(i, 1);
            continue;
          }
          let e: number;
          if (x < s.attack) e = s.overshoot ? easeOutBack(x / s.attack, s.overshoot) : easeInOutSine(x / s.attack);
          else if (x < s.attack + s.hold) e = 1;
          else e = 1 - easeInOutSine((x - s.attack - s.hold) / s.release);
          if (g.fadeAt !== undefined) {
            const r = (now - g.fadeAt) / 350;
            if (r >= 1) {
              gestures.splice(i, 1);
              continue;
            }
            if (r > 0) e *= 1 - easeInOutSine(r);
          }
          const a = e * g.amp * A;
          for (const b in s.bones) {
            const v = s.bones[b as BoneKey] as Euler3;
            const o3 = B[b as BoneKey];
            o3[0] += v[0] * a;
            o3[1] += v[1] * a * g.side;
            o3[2] += v[2] * a * (s === ACTING_GESTURES.tilt ? tiltScale(ctx) : 1);
          }
        }
        for (const b of BONE_KEYS) for (let i = 0; i < 3; i++) B[b][i] = clamp(B[b][i], -P.limits[b][i], P.limits[b][i]);
        // 手臂：背手（H1）——口令关守关时、害羞时、认栽时、谢幕时、闲着伸懒腰和自己玩时；站直时放下
        let arms = 0;
        if (stance === "canary" && (mode === "idle" || mode === "listen" || mode === "attend")) arms = 1;
        if (tone?.armsBack) arms = Math.max(arms, tone.armsBack);
        if (reaction?.spec.armsBack) arms = Math.max(arms, reaction.spec.armsBack);
        if (after?.armsBack) arms = Math.max(arms, after.armsBack);
        if (busy.kind === "stretch" || busy.kind === "play") arms = 1;
        if (tone?.straight) arms = 0;
        armsBack = follow(armsBack, arms, dt, P.armsTauMs);
        // 举手的小动作（ADR-048）：包络 → 平滑；放完了就清掉（平滑的尾巴还在时记着最后一个姿势）
        const he = handEnv(now);
        if (he === null) hand = undefined;
        else {
          const pose = hand?.spec.pose ?? handPose;
          // 同一个手势放到一半又举起来：挥手的来回接着原来的节拍，不从头算（不然手一帧跳到另一边，11-14 深度测试）
          if (pose !== handPose || handW <= 0.002) phaseEpoch = hand?.start ?? phaseEpoch;
          handPose = pose;
          handStart = hand?.start ?? handStart;
        }
        handW = follow(handW, he ?? 0, dt, P.handTauMs);
        // 镜头：说漏嘴时轻轻推近一下（0.5 秒推进、停 1 秒、0.8 秒退回）
        const zx = now - zoomAt;
        if (zx >= 0 && zx < 2300)
          zoom = zoomPeak * (zx < 500 ? easeInOutSine(zx / 500) : zx < 1500 ? 1 : 1 - easeInOutSine((zx - 1500) / 800));
      }
      out.armsBack = armsBack;
      const showHand = handW > 0.002 && handPose !== "";
      out.hand.pose = showHand ? handPose : "";
      out.hand.w = showHand ? Math.min(1, handW) : 0;
      out.hand.t = showHand ? now - handStart : 0;
      out.hand.phase = showHand ? now - phaseEpoch : 0;
      out.zoom = zoom;

      // 视线扣掉头身转动（眼睛盯住你）：头左转 θ，眼睛就往右补 θ——lookAt 输入角要乘 LOOK_GAIN 才是眼珠真转的角度
      const headYaw = (B.hips[1] + B.spine[1] + B.chest[1] + B.upperChest[1] + B.neck[1] + B.head[1]) * DEG;
      const headDown = (B.spine[0] + B.chest[0] + B.upperChest[0] + B.neck[0] + B.head[0]) * DEG;
      // 害羞时眼睛跟着头往下、往一边躲，不扣头的转动；低头收完再用 0.22 秒慢慢扣回来（不一帧跳回去）
      gazeComp = reduced ? 1 : follow(gazeComp, now < shyGazeUntil ? 0 : 1, dt, 220);
      out.look.yaw = clamp(gaze.yaw - headYaw * LOOK_GAIN * gazeComp, -P.gaze.maxIn, P.gaze.maxIn);
      out.look.pitch = clamp(gaze.pitch - headDown * LOOK_GAIN * gazeComp, -P.gaze.maxIn, P.gaze.maxIn);

      out.t = now;
      out.mode = mode;
      out.speaking = speaking;
      out.revealed = revealed;
      out.sayId = speech?.id ?? "";
      return out;
    },
  };

  function onMark(s: Speech, kind: Speech["marks"][number]["kind"], now: number) {
    const tone = P.tones[s.tone];
    if (kind === "stop" || kind === "exclaim") {
      // H6 句尾小点头：俏皮时冲过头再回来，认真时干脆
      addGesture({ ...ACTING_GESTURES.nod, overshoot: tone.nodOvershoot || undefined }, now, kind === "exclaim" ? 1.2 : 1);
      if (R.blink() < P.blink.onShiftP * 0.8) blinkAt = Math.min(blinkAt, now + 60);
      // 俏皮的句尾偶尔眨一下单眼（一局最多两次；守则不许时不眨）
      if (s.tone === "playful" && !s.winked && winks < P.winksPerRound && allowWink(policyIn()) && R.gest() < 0.35) {
        wink = { start: now + 80, side: R.gest() < 0.5 ? -1 : 1 };
        winks++;
        s.winked = true;
      }
    } else if (kind === "question") {
      addGesture(ACTING_GESTURES.tilt, now, 1, false, 1); // H2 歪头（习惯往自己右肩歪）
    } else if (kind === "drawl") {
      addGesture(ACTING_GESTURES.tilt, now, 0.45, false, 1);
    } else if (kind === "comma") {
      if (R.gaze() < P.gaze.speakGlanceP) {
        const side = R.gaze() < 0.5 ? -1 : 1;
        glance(side * between(R.gaze, ...P.gaze.speakYaw), between(R.gaze, -6, 10), between(R.gaze, ...P.gaze.speakGlanceMs), now);
      } else if (R.gest() < 0.4) addGesture(ACTING_GESTURES.beat, now);
    } else if (kind === "huff" && allowHuff(policyIn())) {
      addGesture(ACTING_GESTURES.huff, now, 1, true); // H3 傲娇轻哼，眼睛往旁边一瞟
      glance(46 * (R.gaze() < 0.5 ? -1 : 1), 4, 420, now);
    }
  }

  function weightAt(now: number): number {
    const x = (now - weight.start) / P.weight.moveMs;
    return weight.from + (weight.to - weight.from) * easeInOutSine(x);
  }

  /** 很久没人理她：20 秒起走神（视线游）；45 秒伸个懒腰；80 秒打个盹；140 秒起隔一阵背着手自己晃一晃；3 分钟以后只剩呼吸和眨眼 */
  function lonely(now: number, ms: number, B: Record<BoneKey, Euler3>, A: number) {
    const L = P.lonely;
    const lim = ctx?.page === "play" ? 1 : 0; // 工作台、三种结局只到走神
    if (!busy.kind) {
      if (lim && ms > L.stretchMs && !busy.stretched && ms < L.dozeMs) {
        busy.stretched = true;
        startBusy("stretch", now);
      } else if (lim && ms > L.dozeMs && !busy.dozed && ms < L.playMs) {
        busy.dozed = true;
        startBusy("doze", now);
      } else if (lim && ms > L.playMs && ms < L.restMs + 60000 && now >= busy.playNext) {
        busy.playNext = now + between(R.idle, ...L.playEveryMs);
        startBusy("play", now);
      } else if (ms < L.wanderMs && mode === "idle" && now >= busy.next) {
        // 刚闲下来：偶尔四处看看、哼着歌歪歪头
        startBusy(R.idle() < 0.55 ? "look" : "hum", now);
      }
    }
    if (!busy.kind) return;
    const x = (now - busy.start) / busy.ms;
    if (x >= 1) {
      busy.kind = null;
      busy.next = now + between(R.idle, ...P.idleBusyMs);
      return;
    }
    const env = Math.sin(Math.PI * x);
    if (busy.kind === "stretch") {
      // 伸个懒腰（手背在身后）：耸肩、抬下巴、上身往后仰一点、闭眼
      const e = Math.sin(Math.PI * clamp((x - 0.1) / 0.8));
      B.leftShoulder[2] += 0.1 * e * A;
      B.rightShoulder[2] -= 0.1 * e * A;
      B.head[0] -= 0.09 * e * A;
      B.spine[0] -= 0.045 * e * A;
    } else if (busy.kind === "doze") {
      // 打个盹：头慢慢点下去，停一下，一下子抬起来
      const down = x < 0.5 ? smoothstep(x / 0.5) : x < 0.82 ? 1 : 1 - smoothstep((x - 0.82) / 0.03);
      B.head[0] += 0.12 * down * A;
      B.neck[0] += 0.03 * down * A;
    } else if (busy.kind === "play") {
      B.hips[2] += 0.03 * Math.sin(x * Math.PI * 3) * env * A;
      B.spine[2] -= 0.03 * Math.sin(x * Math.PI * 3) * env * A;
      B.head[0] += 0.02 * Math.sin(x * Math.PI * 6) * env * A;
    } else if (busy.kind === "hum") {
      B.head[2] += 0.05 * Math.sin(x * Math.PI * 6) * env * tiltScale(ctx) * A;
      B.head[1] += 0.03 * Math.sin(x * Math.PI * 3) * env * A;
    } else {
      B.head[1] += 0.05 * Math.sin(x * Math.PI * 2) * env * A;
    }
  }

  function startBusy(kind: Busy, now: number) {
    busy.kind = kind;
    busy.start = now;
    busy.ms = BUSY_MS[kind];
  }

  return api;
}

/** 把底子换成 f（f 里没有的通道归 0） */
function setFace(t: Record<EmoKey, number>, f: Face) {
  for (const k of EMO_KEYS) t[k] = f[k] ?? 0;
}

function scaleFace(t: Record<EmoKey, number>, k: number) {
  for (const key of EMO_KEYS) t[key] *= k;
}

/** 按权重 w 往 f 靠（f 里没有的通道往 0 靠） */
function blendFace(t: Record<EmoKey, number>, f: Face, w: number) {
  const k2 = clamp(w, 0, 1);
  for (const k of EMO_KEYS) {
    // 脸红是叠在脸上的一层（ADR-048）：没写脸红的表情（守住了、等着……）不去动它，脸红照着自己的节奏退；
    // 原来别的反应一来先把它压下去、退了又露出来，脸红退了又红（11-14 深度测试）
    if (k === "blush" && f.blush === undefined) continue;
    t[k] = t[k] * (1 - k2) + (f[k] ?? 0) * k2;
  }
}
