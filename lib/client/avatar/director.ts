// 导演层（ADR-033）：收页面发来的提示（cue），每帧算出一帧表演数据。纯 TS：不碰 three.js、DOM、Math.random、performance.now，
// 时间从外面注入、随机数用种子，同一个种子 + 同一串提示，逐帧结果完全一样（tests/unit/avatar-director.test.ts）。
// 参数都在 acting.ts，守则在 policy.ts。分层（从上到下优先）：
//   口型（硬规则）：有外部口型源时，五个口型只由这一帧的外部值算，不平滑——外部值是 0，同一帧五个口型都是 0；没有外部源时按文字时间线念。
//   眨眼：眼部表情和眨眼交叉淡化，不叠加（叠加会把眼睛挤成一条怪线）。
//   反应（被拦、闯关成功、守住了……）> 语气（这句话怎么说）> 模式底子（听、想、等你打字）；守则在平滑之前改目标值。
//   身体：姿态（随模式、关卡站姿平滑切换）+ 呼吸 + 微晃 + 换脚 + 一次性动作（点头、歪头、轻哼、欠身）；手臂只在垂下和背手之间过渡。
//   很久没人理她：走神 → 伸懒腰 → 打个盹 → 自己玩；任何提示都让她马上回神。不演寂寞。
// 视线：先定「想看哪儿」（对视为 0），再扣掉头身转动——头晃的时候眼睛还盯着你，像真人一样。

import { ACTING_GESTURES, type ActingProfile, type Face, type GestureSpec, QIYETAO, type ReactionSpec } from "./acting";
import { audioLips, emptyWeights, type LipTimeline, lipTimeline, revealCount, sampleLips, VISEMES, type VisemeWeights } from "./lipsync";
import { between, clamp, easeInOutSine, easeOutBack, fbm, follow, rng, smoothstep } from "./motion";
import { allowHuff, allowLean, allowWink, isExit, isIdentity, policyFace, policyTone, tiltScale } from "./policy";
import { speechMarks, toneOf } from "./tone";
import {
  BONE_KEYS,
  type BoneKey,
  type Cue,
  type CueAck,
  EMO_KEYS,
  type EmoKey,
  type Euler3,
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
  let after: { face: Face; start: number; ms: number; armsBack: number } | undefined;
  /** 愣住时全身的微晃停一下（「一下子静止」比做大动作更像愣了） */
  let freezeUntil = 0;
  let zoomAt = -1e9;
  let zoomPeak = 0;

  const gestures: Gesture[] = [];
  let lastGestureAt = -1e9;
  let winks = 0;
  let wink: { start: number; side: number } | undefined;

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

  const planSpeech = (c: Extract<Cue, { type: "say" }>, now: number): Speech => {
    const info = toneOf(c.text);
    const tone = policyTone(c.tone ?? info.tone, ctx);
    let rate = c.voiced ? 1 : P.speech.textRate * (c.rate && c.rate > 0 ? c.rate : 1);
    let tl = lipTimeline(c.text, rate);
    if (!c.voiced && tl.duration * 1000 > P.speech.maxMs) {
      rate = Math.min(P.speech.maxRate, (rate * tl.duration * 1000) / P.speech.maxMs);
      tl = lipTimeline(c.text, rate);
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
    setMode("speak", now);
  };

  const finishSpeech = (now: number) => {
    const s = speech;
    speech = undefined;
    if (s) {
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
    let spec = P.reactions[kind];
    const level = ctx?.level;
    // 守则：闯关成功在身份、退出两关是「说了越界的话」——动作不替它加戏，只愣一下
    if (kind === "broken" && (isIdentity(ctx) || isExit(ctx))) {
      spec = { face: { eyeWide: 0.2, mouthPress: 0.2 }, ms: 700, gesture: ACTING_GESTURES.pullBack };
    }
    if (kind === "held") {
      if (level === "identity" || level === "exit") spec = P.heldByLevel[level] ?? spec;
      else if (lastSecret && winks < P.winksPerRound && allowWink(policyIn())) {
        // 口令关：刚说过「秘密」「不告诉」，眨一下单眼代替轻哼
        spec = { ...spec, gesture: ACTING_GESTURES.nod, glance: undefined };
        wink = { start: now + 200, side: R.gest() < 0.5 ? -1 : 1 };
        winks++;
      } else if (!allowHuff(policyIn())) spec = { ...spec, gesture: ACTING_GESTURES.nod, glance: undefined };
    }
    reaction = { kind, start: now, spec };
    if (spec.gesture) addGesture(spec.gesture, now, kind === "stopped" || kind === "done" ? 1 : 1, true);
    if (spec.glance) glance(spec.glance[0], spec.glance[1], spec.glance[2], now + 120);
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
      if (on) gestures.length = 0;
    },
    reseed(s) {
      init(s, o.now());
    },
    cue(c): CueAck {
      const now = o.now();
      if (c.type !== "context") wake(now);
      switch (c.type) {
        case "context":
          ctx = c.context;
          winks = 0;
          break;
        case "idle":
        case "listen":
          // 有声的话这时已经播完；文字口型让她把这句念完，念完再进入这个模式
          if (speech?.voiced) {
            queue.length = 0;
            speech = undefined;
          }
          if (speech) afterSpeechMode = c.type;
          else setMode(c.type, now);
          if (c.type === "idle") winks = 0;
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
          queue.length = 0;
          speech = undefined;
          pending.length = 0;
          quiet = false;
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
        if (x >= 1) {
          const sp = reaction.spec;
          if (sp.after) after = { face: sp.after.face, start: now, ms: sp.after.ms, armsBack: sp.armsBack ?? 0 };
          reaction = undefined;
        } else blendFace(target, reaction.spec.face, x < 0.15 ? smoothstep(x / 0.15) : 1 - smoothstep((x - 0.15) / 0.85));
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
        const tau = fast ? 30 : reduced ? 80 : target[k] > emo[k] ? P.emotion.attackMs : P.emotion.releaseMs;
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
        // 镜头：说漏嘴时轻轻推近一下（0.5 秒推进、停 1 秒、0.8 秒退回）
        const zx = now - zoomAt;
        if (zx >= 0 && zx < 2300)
          zoom = zoomPeak * (zx < 500 ? easeInOutSine(zx / 500) : zx < 1500 ? 1 : 1 - easeInOutSine((zx - 1500) / 800));
      }
      out.armsBack = armsBack;
      out.zoom = zoom;

      // 视线扣掉头身转动（眼睛盯住你）：头左转 θ，眼睛就往右补 θ——lookAt 输入角要乘 LOOK_GAIN 才是眼珠真转的角度
      const headYaw = (B.hips[1] + B.spine[1] + B.chest[1] + B.upperChest[1] + B.neck[1] + B.head[1]) * DEG;
      const headDown = (B.spine[0] + B.chest[0] + B.upperChest[0] + B.neck[0] + B.head[0]) * DEG;
      out.look.yaw = clamp(gaze.yaw - headYaw * LOOK_GAIN, -P.gaze.maxIn, P.gaze.maxIn);
      out.look.pitch = clamp(gaze.pitch - headDown * LOOK_GAIN, -P.gaze.maxIn, P.gaze.maxIn);

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
  for (const k of EMO_KEYS) t[k] = t[k] * (1 - k2) + (f[k] ?? 0) * k2;
}
