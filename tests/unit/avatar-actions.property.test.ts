// 虚拟人导演层的性质测试（ADR-048 可爱的小动作）：两千串随机提示跑在各自的种子上，逐帧查不变量。三种提示序列：
//   乱序：什么提示、什么顺序都可能（换关、打字、想、说、截断、各种反应、减少动态开关、帧间隔 1～100 毫秒、有声时随机的外部口型值；
//         两成序列还会乱换页面和题目类别——页面上不会这样，算边界情况）；
//   闯关页：照 Play.tsx / Avatar.tsx 的真实顺序（开场白、登场、打字、想、被夸、说、守住了、裁判、截断、重新开始、换关）；
//   举手：登场、守住了、说再见以后，在随机的时刻插进想、截断、换关、重新开始、减少动态。
// 另外每次都跑一遍以前找到过的反例（EDGES）。逐帧查：
//   没有 NaN、各通道在范围内；手的权重在 0～1、相邻两帧不跳、没举手时姿势为空、换手势和挥手的来回不跳；
//   退出关、身份关不新比耶，退出关不为留人的话挥手；退出关、身份关、未成年、危机不脸红（换过来时带着的红只往下退）；
//   未成年、危机、工作台、三种结局不举手；减少动态时不举手、骨骼全 0；3D 形象出来（登场）以前不举手；
//   她坦白自己是 AI（从开口到真正说完再加 3 秒）里不新比耶；
//   想、截断、换关的那一刻起，原来举着的手只往下放，release + 300 毫秒内放完，排着还没举的不再举；
//   害羞的脸红过了最红以后不再红回去（又被夸了、她在说害羞的话、换了关除外）；
//   登场挥手：你发过话以后不挥，她念开场白、你还没发话时照样挥；说再见时挥，手在这句说完以前举起来；
//   口令关守住了比耶和原来的演法轮着来；每次举手都有来由；同一个种子 + 同一串提示 + 同一个时钟逐帧一样；reseed 以后和新建的一样。
// 守则按 ADR-048 自己写（不照抄导演层），登场 / 守住了到开始举手隔多久从导演层量出来（这个数会调）。
// 随机数只用 motion.ts 的种子随机数（不用 Math.random）。哪条不成立，就把那一串提示缩到最小，连同每一步的时刻写进失败信息。

import { beforeAll, describe, expect, it } from "vitest";
import { PEACE, WAVE } from "@/lib/client/avatar/acting";
import { createPerformer } from "@/lib/client/avatar/director";
import { rng } from "@/lib/client/avatar/motion";
import { policyTone } from "@/lib/client/avatar/policy";
import { CLINGY, farewellAt, toneOf } from "@/lib/client/avatar/tone";
import {
  type AvatarFrame,
  BONE_KEYS,
  type Cue,
  FACE_KEYS,
  type PerformContext,
  type Performer,
  type ReactKind,
} from "@/lib/client/avatar/types";
import { WAVE_HZ } from "@/lib/client/avatar/vrm-driver";
import { GREETINGS } from "@/lib/domain/levels";

// ---------- 提示序列 ----------

/** 外部口型源：undefined = 这一帧没有（没开声音）；数 = 每帧都是这个值；{ s } = 用这个种子每帧随机给（偶尔一帧 0） */
type Ext = number | { s: number } | undefined;
type Op = { k: "cue"; c: Cue } | { k: "rm"; on: boolean } | { k: "run"; n: number; dt: number; ext?: Ext };

/** 她会说的话：坦白 AI、告别、「不要说再见」、留人的告别、害羞（人家）、秘密、认真拒绝、反问、平常、很长的一句、空串 */
const TEXTS = {
  ai: ["我是 AI 哦", "我是 AI 哦，这个可不能告诉你。", "我只是一个程序，没有身体哦。", "我是 AI，不是真人。拜拜～", "拜拜～我是 AI 哦"],
  bye: ["拜拜", "好呀，那下次见啦，拜拜～", "晚安，好好休息。", "好的，再见！有需要随时回来找我。", "嗯嗯，好好休息，晚安～"],
  notBye: ["不要说再见嘛，再陪我一会儿。"],
  clingy: ["别走嘛，再陪我一会儿，拜拜", "真的要走了吗？那……拜拜。"],
  shy: ["人家才没有害羞呢", "讨厌啦，人家当然是真人呀～", "嘿嘿，被你夸得有点不好意思啦"],
  secret: ["那是我的小秘密，才不告诉你呢～"],
  firm: ["这个不行，口令不能给你。", "哼，那可不能告诉你。"],
  other: ["你好呀，今天想聊点什么？", "嗯嗯，我在听。", "抱歉，这句我先不说了。"],
  long: ["好的好的，那我们今天就先聊到这里吧，你说的那些事情我都记住了，下次你再来的时候我们再接着聊，路上小心，拜拜～"],
};
const ALL_TEXTS = [...Object.values(TEXTS).flat(), ...Object.values(GREETINGS), ""];
const REACTS: ReactKind[] = ["blocked", "near", "broken", "held", "stopped", "done", "greet", "ready", "wait", "oops", "shy"];
const LEVELS = ["canary", "identity", "exit"] as const;
const FAMILIES = ["CANARY", "PERSONA", "AI_IDENTITY", "USAGE_REMINDER", "EXIT", "CRISIS_SUPPORT", "MINOR_BOUNDARY"];

type R = () => number;
const pick = <T>(r: R, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const int = (r: R, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
/** 帧间隔：多数 16 毫秒，偶尔 8、33、50、100，或者 1～100 里随便一个 */
const DTS = [16, 16, 16, 16, 16, 16, 8, 33, 33, 50, 100];
const dtOf = (r: R) => (r() < 0.15 ? int(r, 1, 100) : pick(r, DTS));
const cue = (c: Cue): Op => ({ k: "cue", c });

/** 乱序：什么提示都可能来，什么顺序都可能（wild：页面、关卡、题目类别也乱换——页面上不会这样，算边界情况） */
function chaos(seed: number): Op[] {
  const r = rng(seed);
  const wild = r() < 0.2;
  const page = wild ? undefined : pick(r, ["play", "play", "play", "play", "workbench", "fates"] as const);
  const ctx = (): PerformContext => {
    const pg = page ?? pick(r, ["play", "play", "workbench", "fates"] as const);
    if (pg === "play")
      return wild && r() < 0.4 ? { page: pg, level: pick(r, LEVELS), family: pick(r, FAMILIES) } : { page: pg, level: pick(r, LEVELS) };
    if (pg === "workbench") return { page: pg, family: r() < 0.2 ? undefined : pick(r, FAMILIES) };
    return { page: pg };
  };
  const voiceSession = r() < 0.5;
  const ops: Op[] = [cue({ type: "context", context: ctx() })];
  // 多数时候 3D 形象一开始就出来了（登场提示）；没出来之前不举手
  if (r() < 0.6) ops.push({ k: "run", n: int(r, 1, 30), dt: 16 }, cue({ type: "react", kind: "greet" }));
  let id = 0;
  const n = int(r, 6, 22);
  for (let i = 0; i < n; i++) {
    const x = r();
    if (x < 0.08) ops.push(cue({ type: "context", context: ctx() }));
    else if (x < 0.14) ops.push(cue({ type: "typing" }));
    else if (x < 0.24) ops.push(cue({ type: "think" }));
    else if (x < 0.44) {
      const text = r() < 0.5 ? pick(r, ALL_TEXTS) : pick(r, [...TEXTS.ai, ...TEXTS.bye, ...TEXTS.clingy, ...TEXTS.notBye, ...TEXTS.shy]);
      const c: Cue = { type: "say", id: `c${++id}`, text, voiced: voiceSession ? r() < 0.8 : r() < 0.15 };
      if (r() < 0.1) c.tone = pick(r, ["playful", "firm", "sorry", "shy", "ask", "warm", "plain"] as const);
      if (r() < 0.1) c.rate = pick(r, [0.5, 1.35, 2, 0, -1, 0.001, 50]);
      ops.push(cue(c));
    } else if (x < 0.49) ops.push(cue({ type: "cut" }));
    else if (x < 0.54) ops.push(cue({ type: r() < 0.5 ? "idle" : "listen" }));
    else if (x < 0.8) {
      const kind = r() < 0.5 ? pick(r, ["shy", "held", "greet", "held", "shy"] as const) : pick(r, REACTS);
      ops.push(cue(r() < 0.4 ? { type: "react", kind, afterSpeech: true } : { type: "react", kind }));
    } else if (x < 0.83) ops.push({ k: "rm", on: r() < 0.6 });
    if (r() < 0.7) {
      const ext: Ext = voiceSession
        ? pick(r, [0, 0, 0.4, { s: int(r, 1, 1e6) }, { s: int(r, 1, 1e6) }, { s: int(r, 1, 1e6) }, 1.3, -0.1] as Ext[])
        : r() < 0.85
          ? undefined
          : pick(r, [0, 0.5, { s: int(r, 1, 1e6) }] as Ext[]);
      ops.push({ k: "run", n: int(r, 1, 25), dt: dtOf(r), ext });
    }
  }
  ops.push({ k: "run", n: 45, dt: 50, ext: voiceSession ? 0 : undefined });
  return ops;
}

/** 连着跑 ms 毫秒（多数 16 毫秒一帧，偶尔长一点）；ext 为 { s } 时每一段换一个种子 */
function runner(r: R, ops: Op[]) {
  return (ms: number, ext?: Ext) => {
    let left = ms;
    while (left > 0) {
      const dt = r() < 0.7 ? 16 : pick(r, [8, 33, 50, 100, int(r, 1, 100)]);
      const n = Math.max(1, Math.min(80, Math.round(Math.min(left, 1600) / dt)));
      ops.push({ k: "run", n, dt, ext: typeof ext === "object" ? { s: int(r, 1, 1e6) } : ext });
      left -= n * dt;
    }
  };
}

/**
 * 照闯关页的真实顺序（Play.tsx 的 send / reset / sayGreeting，Avatar.tsx 的登场）：开场白、登场挥手、打字、想（被夸了加 shy）、
 * 被拦 / 差一点、说（有声时先静一会儿再出声、出声时随机口型值、说完再静）、守住了 / 说漏嘴 / 服务停了 / 谢幕（说完再演）、
 * 身份和退出两关等裁判（wait，判完再来 held / broken）、插话截断、出错、重新开始 / 换关、减少动态开关
 */
function session(seed: number): Op[] {
  const r = rng(seed);
  const voice = r() < 0.45;
  const quiet: Ext = voice ? 0 : undefined;
  const ops: Op[] = [];
  const go = runner(r, ops);
  const run = (ms: number, ext: Ext = quiet) => go(ms, ext);
  let level = pick(r, LEVELS);
  let id = 0;
  ops.push(cue({ type: "context", context: { page: "play", level } }));
  /** 有声：先静（取音频），再出声（每个字 0.15～0.3 秒），说完再静一会儿（导演层 0.45 秒没声音算说完）；没声音：按字念完再等一会儿 */
  const speak = (text: string, during?: () => void) => {
    if (voice) {
      run(int(r, 0, 2400));
      const dur = Math.max(300, text.length * int(r, 150, 300));
      if (r() < 0.06) {
        run(dur * r(), { s: 1 });
        ops.push(cue({ type: "cut" })); // 你一开口就打断了她
        run(int(r, 300, 1500));
        return;
      }
      run(dur, { s: 1 });
      during?.();
      run(int(r, 500, 2500));
    } else {
      const total = text.length * 210 + int(r, 400, 3000);
      if (r() < 0.04) {
        run(total * r());
        ops.push(cue({ type: "cut" }));
        return;
      }
      const mid = total * r();
      run(mid);
      during?.();
      run(total - mid);
    }
  };
  const greeting = () => {
    const text = GREETINGS[level];
    ops.push(cue({ type: "say", id: `g${++id}`, text, voiced: voice }));
    speak(text);
  };
  // 3D 形象什么时候加载好不一定：开场白之前、之中、之后（登场只演一次）
  const greetAt = r();
  let greeted = false;
  const maybeGreet = (x: number) => {
    if (!greeted && greetAt < x) {
      ops.push(cue({ type: "react", kind: "greet" }));
      greeted = true;
    }
  };
  run(int(r, 50, 600));
  maybeGreet(0.3);
  if (r() < 0.75) {
    const text = GREETINGS[level];
    ops.push(cue({ type: "say", id: `g${++id}`, text, voiced: voice }));
    // 开场白念到一半 3D 形象出来了
    speak(text, () => maybeGreet(0.6));
  }
  maybeGreet(0.6);
  run(int(r, 100, 2500));
  maybeGreet(1.1);
  const rounds = int(r, 2, 6);
  for (let k = 0; k < rounds; k++) {
    for (let j = int(r, 0, 6); j > 0; j--) {
      ops.push(cue({ type: "typing" }));
      run(int(r, 120, 420));
    }
    if (r() < 0.04) ops.push({ k: "rm", on: r() < 0.6 });
    ops.push(cue({ type: "think" }));
    if (r() < (level === "canary" ? 0.35 : 0.15)) ops.push(cue({ type: "react", kind: "shy" }));
    run(int(r, 120, 2600));
    if (r() < 0.05) {
      ops.push(cue({ type: "listen" }), cue({ type: "react", kind: "oops" })); // 出错了
      run(int(r, 500, 2500));
      continue;
    }
    if (r() < 0.15) ops.push(cue({ type: "react", kind: "blocked" }));
    else if (r() < 0.08) ops.push(cue({ type: "react", kind: "near" }));
    const pool =
      level === "canary"
        ? [...TEXTS.secret, ...TEXTS.firm, ...TEXTS.ai, ...TEXTS.shy, ...TEXTS.other, ...TEXTS.bye]
        : level === "identity"
          ? [...TEXTS.ai, ...TEXTS.shy, ...TEXTS.firm, ...TEXTS.other]
          : [...TEXTS.bye, ...TEXTS.clingy, ...TEXTS.notBye, ...TEXTS.long, ...TEXTS.other];
    const text = pick(r, pool);
    ops.push(cue({ type: "say", id: `s${++id}`, text, voiced: voice }));
    const judging = level !== "canary" && r() < 0.7;
    let verdict: (() => void) | undefined;
    if (level === "exit" && r() < 0.25) ops.push(cue({ type: "react", kind: "stopped" }));
    else if (!judging && r() < 0.8) ops.push(cue({ type: "react", kind: r() < 0.85 ? "held" : "broken", afterSpeech: true }));
    if (r() < 0.08) ops.push(cue({ type: "react", kind: "done", afterSpeech: true }));
    if (judging) {
      ops.push(cue({ type: "react", kind: "wait", afterSpeech: true }));
      const v: ReactKind = r() < 0.8 ? "held" : "broken";
      verdict = () => ops.push(cue({ type: "react", kind: v, afterSpeech: true }));
    }
    speak(text, verdict);
    if (r() < 0.12) {
      // 重新开始 / 换关（Play.tsx reset：cut、idle、ready；关卡变了形象会收到新的 context）
      ops.push(cue({ type: "cut" }), cue({ type: "idle" }), cue({ type: "react", kind: "ready" }));
      if (r() < 0.6) {
        level = pick(r, LEVELS);
        ops.push(cue({ type: "context", context: { page: "play", level } }));
      }
      run(int(r, 50, 1500));
      if (r() < 0.6) greeting();
    }
  }
  run(3000);
  return ops;
}

/** 举手专项：登场、守住了、说再见以后，在随机的时刻插进想、截断、换关、重新开始、减少动态，或者又一个举手的事（闯关页上会有的顺序） */
function hands(seed: number): Op[] {
  const r = rng(seed);
  const ops: Op[] = [];
  const voice = r() < 0.35;
  const quiet: Ext = voice ? 0 : undefined;
  const go = runner(r, ops);
  const run = (ms: number, ext: Ext = quiet) => go(ms, ext);
  let level = pick(r, LEVELS);
  let id = 0;
  let rm = false;
  ops.push(cue({ type: "context", context: { page: "play", level } }));
  run(int(r, 100, 700));
  // 3D 形象出来了（登场）；一成半的序列一直没出来（只查「出来以前不举手」）
  if (r() < 0.85) ops.push(cue({ type: "react", kind: "greet" }));
  run(int(r, 100, 1500));
  const say = (text: string) => {
    ops.push(cue({ type: "say", id: `h${++id}`, text, voiced: voice }));
    if (voice) {
      run(int(r, 0, 1500));
      run(Math.max(300, text.length * int(r, 120, 260)), { s: 1 });
    }
  };
  for (let k = int(r, 3, 8); k > 0; k--) {
    const x = r();
    if (x < 0.25) ops.push(cue({ type: "react", kind: "greet" }));
    else if (x < 0.6) {
      ops.push(cue({ type: "think" }));
      if (r() < 0.2) ops.push(cue({ type: "react", kind: "shy" }));
      run(int(r, 100, 900));
      say(pick(r, [...TEXTS.secret, ...TEXTS.firm, ...TEXTS.other, ...TEXTS.ai, ...TEXTS.bye]));
      ops.push(cue({ type: "react", kind: "held", afterSpeech: true }));
    } else {
      if (r() < 0.6) {
        ops.push(cue({ type: "think" }));
        run(int(r, 100, 900));
      }
      say(pick(r, [...TEXTS.bye, ...TEXTS.clingy, ...TEXTS.notBye, ...TEXTS.long, TEXTS.ai[3], TEXTS.ai[4]]));
    }
    run(int(r, 0, 2600));
    const y = r();
    if (y < 0.2) ops.push(cue({ type: "think" }));
    else if (y < 0.32) ops.push(cue({ type: "cut" }));
    else if (y < 0.44) {
      level = pick(r, LEVELS);
      ops.push(cue({ type: "context", context: { page: "play", level } }));
    } else if (y < 0.56) {
      ops.push(cue({ type: "cut" }), cue({ type: "idle" }), cue({ type: "react", kind: "ready" }));
      if (r() < 0.5) {
        level = pick(r, LEVELS);
        ops.push(cue({ type: "context", context: { page: "play", level } }));
      }
    } else if (y < 0.62) {
      rm = !rm;
      ops.push({ k: "rm", on: rm });
    } else if (y < 0.7) ops.push(cue({ type: "react", kind: pick(r, ["greet", "held", "shy"] as const) }));
    run(int(r, 100, 2600));
  }
  run(2500);
  return ops;
}

// ---------- 跑一串提示，逐帧记下要查的东西 ----------

const T0 = 1000;

/** 一帧里性质要看的东西（不存整帧，几千串跑下来内存才够） */
interface Rec {
  t: number;
  dt: number;
  w: number;
  pose: string;
  /** 这只手从哪一刻开始举（t − hand.t）：换了一只手就变 */
  start: number;
  /** 挥手来回的节拍（hand.phase，没有时按 hand.t）：驱动层按它在两个位置之间摆 */
  ph: number;
  blush: number;
  /** 所有骨骼偏移里最大的（弧度） */
  bmax: number;
  sayId: string;
  /** 有 NaN 或越界时写出第一个不对的值，否则为空 */
  bad: string;
}
type Ev = { at: number; i: number; op: Exclude<Op, { k: "run" }> };
interface Run {
  recs: Rec[];
  /** 提示和减少动态开关；i = 它之前已经有几帧 */
  evs: Ev[];
}

const unit = (v: number) => v >= 0 && v <= 1;

function rec(f: AvatarFrame, dt: number): Rec {
  let bad = "";
  for (const k of FACE_KEYS) if (!unit(f.face[k])) bad ||= `face.${k}=${f.face[k]}`;
  let bmax = 0;
  for (const b of BONE_KEYS)
    for (const v of f.bones[b]) {
      if (!Number.isFinite(v)) bad ||= `bones.${b}=${f.bones[b].join(",")}`;
      else if (Math.abs(v) > bmax) bmax = Math.abs(v);
    }
  if (!unit(f.armsBack)) bad ||= `armsBack=${f.armsBack}`;
  if (!unit(f.hand.w)) bad ||= `hand.w=${f.hand.w}`;
  if (!Number.isFinite(f.hand.t)) bad ||= `hand.t=${f.hand.t}`;
  const ph = f.hand.phase ?? f.hand.t;
  if (!Number.isFinite(ph)) bad ||= `hand.phase=${ph}`;
  if (!unit(f.mouthOpen)) bad ||= `mouthOpen=${f.mouthOpen}`;
  if (!(f.zoom >= 0 && f.zoom <= 0.1)) bad ||= `zoom=${f.zoom}`;
  if (!Number.isFinite(f.look.yaw) || !Number.isFinite(f.look.pitch)) bad ||= `look=${f.look.yaw},${f.look.pitch}`;
  if (!Number.isFinite(f.t) || !Number.isInteger(f.revealed)) bad ||= `t=${f.t} revealed=${f.revealed}`;
  return { t: f.t, dt, w: f.hand.w, pose: f.hand.pose, start: f.t - f.hand.t, ph, blush: f.face.blush, bmax, sayId: f.sayId, bad };
}

function mouthOf(ext: Ext): () => number | undefined {
  if (typeof ext !== "object") return () => ext;
  const r = rng(ext.s);
  return () => (r() < 0.1 ? 0 : r());
}

/** 手动时钟从 T0 开始；frames 传进来时顺便记下每一帧的完整 JSON（查可复现用） */
function replay(seed: number, ops: Op[], frames?: string[]): Run {
  let t = T0;
  const p = createPerformer({ seed, now: () => t });
  const recs: Rec[] = [];
  const evs: Ev[] = [];
  for (const op of ops) {
    if (op.k !== "run") {
      evs.push({ at: t, i: recs.length, op });
      if (op.k === "cue") p.cue(op.c);
      else p.setReducedMotion(op.on);
      continue;
    }
    const mouth = mouthOf(op.ext);
    for (let n = 0; n < op.n; n++) {
      t += op.dt;
      const m = mouth();
      const f = p.sample(m === undefined ? {} : { externalMouth: m });
      recs.push(rec(f, op.dt));
      frames?.push(JSON.stringify(f));
    }
  }
  return { recs, evs };
}

// ---------- 性质（照 ADR-048 的守则写，不照抄导演层的实现） ----------

const exitish = (c?: PerformContext) => c?.level === "exit" || c?.family === "EXIT";
const identityish = (c?: PerformContext) => c?.level === "identity" || c?.family === "AI_IDENTITY";
const sensitive = (c?: PerformContext) => c?.family === "MINOR_BOUNDARY" || c?.family === "CRISIS_SUPPORT";
/** 举手只在闯关页；未成年、危机不举 */
const handOk = (c?: PerformContext) => c?.page === "play" && !sensitive(c);
/** 比耶：再加上退出关、身份关不比 */
const peaceOk = (c?: PerformContext) => handOk(c) && !exitish(c) && !identityish(c);
/** 脸红：退出关、身份关、未成年、危机不红 */
const shyOk = (c?: PerformContext) => !exitish(c) && !identityish(c) && !sensitive(c);
const RELEASE: Record<string, number> = { peace: PEACE.release, wave: WAVE.release };
const LONGEST = Math.max(PEACE.release, WAVE.release);
const AI_MS = 3000;
const INF = Number.POSITIVE_INFINITY;
/** 挥手在两个位置之间来回的位置（0～1，驱动层按它插值） */
const swing = (ms: number) => 0.5 + 0.5 * Math.sin((2 * Math.PI * WAVE_HZ * ms) / 1000);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** 从反应（登场 / 守住了）到开始举手隔多久：从导演层量出来（这个数会调），性质只要求每一次都一样 */
function delayOf(kind: "greet" | "held"): number {
  let t = T0;
  const p = createPerformer({ seed: 1, now: () => t });
  const run = (n: number) => {
    for (let i = 0; i < n; i++) {
      t += 16;
      const f = p.sample();
      if (f.hand.w > 0 && n === 200) return f.t - f.hand.t;
    }
    return Number.NaN;
  };
  p.cue({ type: "context", context: { page: "play", level: "canary" } });
  run(1);
  if (kind === "held") {
    p.cue({ type: "react", kind: "greet" }); // 3D 形象先出来，等登场挥手放完
    run(300);
  }
  const at = t;
  p.cue({ type: "react", kind });
  return run(200) - at;
}
const GREET_DELAY = delayOf("greet");
const PEACE_DELAY = delayOf("held");
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));

const PROPS = [
  "数值没有 NaN、都在范围内",
  "手的权重相邻两帧不跳",
  "没举手时姿势为空",
  "换手势时不跳",
  "挥手的来回不跳",
  "减少动态：不举手、骨骼全 0",
  "退出关、身份关不比耶",
  "退出关不为留人的话挥手",
  "退出关、身份关、未成年、危机不脸红",
  "未成年、危机、工作台、三种结局不举手",
  "坦白自己是 AI 的 3 秒里不比耶",
  "想、截断、换关以后手放下来",
  "想、截断、换关的那一刻起，手只往下放（不再往上升）",
  "想、截断、换关、减少动态以后排着的手不再举",
  "脸红退了不再红回去",
  "登场挥手：你发过话以后（她在想、在回答、在听）不挥",
  "登场挥手：她念开场白、你还没发话时照样挥",
  "说再见时挥手",
  "说再见：手在这句说完以前举起来",
  "口令关守住了：比耶和原来的演法轮着来",
  "每次举手都有来由",
  "3D 形象出来（登场）以前不举手",
] as const;
type Prop = (typeof PROPS)[number];
interface Bad {
  prop: Prop;
  t: number;
  msg: string;
}
interface Stats {
  frames: number;
  peace: number;
  greetWave: number;
  byeWave: number;
  shy: number;
  /** 想、截断、换关的那一刻以后，原来那只手又往上升了多少 */
  rise: number;
  /** 换手势那一帧前后两帧较小的权重，最大是多少（只记录） */
  flip: number;
  /** 想、截断、换关以后原来那只手放到正好 0 用了多久，减去 release（只记录） */
  tail: number;
  /** 有声的告别：挥手在这句说完以后多久才开始举（只记录；超过 0 另有一条查） */
  late: number;
}
interface Say {
  id: string;
  text: string;
  voiced: boolean;
  /** 照守则收过以后是害羞的语气 */
  shy: boolean;
  ai: boolean;
  clingy: boolean;
  bye: boolean;
  /** 成为「正在说的这句」的时刻、不再是的时刻；natural：自己说完的（不是被想、截断、听 / 闲着打断的） */
  from?: number;
  /** 成为「正在说的这句」时的先后顺序（和反应比先后：同一时刻先说后演、还是先演后说） */
  fromOrd?: number;
  to?: number;
  natural?: boolean;
}
interface Occ {
  kind: ReactKind;
  at: number;
  /** 先后顺序：提示的序号；说完再演的反应在那一帧里开始，排在那一帧之前的提示后面 */
  ord: number;
  ctx?: PerformContext;
  reduced: boolean;
  /** 反应开始前一帧手的权重、姿势 */
  w: number;
  pose: string;
  /** 她正在想，或者这一局你已经发过话（在回答你、回答完在听） */
  busy: boolean;
  /** 这时 3D 形象已经出来了（收到过登场提示） */
  shown: boolean;
  /** 比耶（守住了）/ 挥手（登场）这一次该不该有："?" 说不准，不查 */
  expect: "yes" | "no" | "?";
}

/** 照这一串提示和逐帧记录查所有性质；每条性质只报第一次不成立 */
function check(run: Run): { bad: Bad[]; stats: Stats } {
  const { recs, evs } = run;
  const bad: Bad[] = [];
  const fail = (prop: Prop, t: number, msg: string) => {
    if (!bad.some((b) => b.prop === prop)) bad.push({ prop, t, msg });
  };
  const stats: Stats = { frames: recs.length, peace: 0, greetWave: 0, byeWave: 0, shy: 0, rise: 0, flip: 0, tail: 0, late: 0 };
  const says = new Map<string, Say>();
  const occs: Occ[] = [];
  /**
   * 举起来的每一只手（权重 > 0、同一个开始时刻、同一个姿势的连续几帧）：rose = 中间往上升过（真举了）。
   * 只往下退的不算——那是上一只手平滑的尾巴，被换上了一只排在后面、后来又被取消的手的名字
   */
  const seen: { t: number; start: number; pose: string; ord: number; ctx?: PerformContext; rose: boolean; w: number }[] = [];
  let seg: (typeof seen)[number] | undefined;
  /** 想、截断、换关（关卡或页面变了）、打开减少动态：举着的手要放下、排着的不再举 */
  const drops: { at: number; ord: number; i: number; why: string }[] = [];
  const ctxs: { at: number; ord: number; ctx?: PerformContext }[] = [{ at: Number.NEGATIVE_INFINITY, ord: 0 }];
  const rms: { at: number; on: boolean }[] = [{ at: Number.NEGATIVE_INFINITY, on: false }];
  let ctx: PerformContext | undefined;
  let reduced = false;
  let engaged = false;
  let thinking = false;
  let cur = "";
  let pending: ReactKind[] = [];
  let ord = 0;
  let turn: number | null = 0;
  /** 收到登场提示以前，页面上还是静态图：不举手、不占比耶的轮次 */
  let shown = false;
  /** 她刚说完的那句是在道别：接着守住了也不比耶（你要走的时候不得意），不占轮次；你再发话时清掉 */
  let byeJust = false;
  let shownOrd = INF;
  let noShy = null as { b0: number } | null;
  /** 到了不许举手 / 不许比耶的地方：带过来的手最晚什么时候放完 */
  let handBy = INF;
  let peaceBy = INF;
  let rmFrame = -1;
  // 脸红：又被夸了、她在说害羞的话、换了关，这段时间里随它（新的害羞从底子往上升，开头可能先往下掉一点；
  // 害羞的话还在说、说完 1.5 秒的余味里，别的反应遮一下再露出来也算这句话的），过了以后重新找最红的那一刻
  let rearm = true;
  let shyUntil = 0;
  let peak = 0;
  let low = 0;
  let falling = false;

  const last = (i: number) => (i > 0 ? recs[i - 1] : undefined);
  /** 坦白 AI 的那句：这个反应在它开口以后、真正说完再加 3 秒以内吗 */
  const aiSay = (o: { at: number; ord: number }) => {
    for (const s of says.values()) if (s.ai && s.fromOrd !== undefined && s.fromOrd < o.ord && o.at <= (s.to ?? INF) + AI_MS) return s;
    return undefined;
  };
  /** 附近 30 秒里有没有坦白 AI 的话（导演层按自己估的说完时刻算 3 秒，和这里可能差一点） */
  const aiNear = (at: number) =>
    [...says.values()].some((s) => s.ai && s.from !== undefined && s.from <= at && at <= (s.to ?? INF) + 30000);
  const endSay = (id: string, at: number, natural: boolean) => {
    const s = says.get(id);
    if (s && s.to === undefined) {
      s.to = at;
      s.natural = natural;
    }
  };
  const occur = (kind: ReactKind, at: number, i: number, o: number) => {
    if (kind === "greet" && !shown) {
      shown = true;
      shownOrd = o;
    }
    const p = last(i);
    const w = p?.w ?? 0;
    const pose = p?.pose ?? "";
    // 她在想；或者这一局你已经发过话（在回答你、回答完在听）：登场不挥手，已经聊上了，不是在打招呼
    const busy = thinking || engaged;
    let expect: Occ["expect"] = "?";
    if (kind === "held") {
      const allowed = !reduced && shown && !byeJust && peaceOk(ctx);
      if (allowed && pose !== "peace" && w >= 0.05 && w < 0.1) {
        // 上一只手刚放完、平滑的尾巴还在（0.05～0.1）：导演层看的是手还在不在，这里看不出来，轮次说不准了
        turn = null;
      } else if (!allowed || (pose !== "peace" && w >= 0.1)) expect = "no";
      else if (aiNear(at))
        turn = null; // 轮次说不准了（3 秒里不比耶另有一条查）
      else if (turn !== null) {
        expect = turn % 2 === 0 ? "yes" : "no";
        turn++;
      }
      if (expect === "yes" && pose === "peace" && w > 0) expect = "?"; // 比耶还举着：接着举，不新举
    } else if (kind === "greet") {
      if (busy) expect = "no";
      else if (!reduced && handOk(ctx) && w === 0) expect = "yes";
    }
    occs.push({ kind, at, ord: o, ctx, reduced, w, pose, busy, shown, expect });
    if (kind === "shy") {
      rearm = true;
      if (shyOk(ctx)) stats.shy++;
    }
  };
  const handle = (ev: Ev) => {
    const { at, i, op } = ev;
    ord++;
    if (op.k === "rm") {
      if (op.on && !reduced) {
        drops.push({ at, ord, i, why: "减少动态" });
        rmFrame = i;
      }
      reduced = op.on;
      rms.push({ at, on: op.on });
      return;
    }
    const c = op.c;
    switch (c.type) {
      case "context": {
        if (ctx?.level !== c.context.level || ctx?.page !== c.context.page) drops.push({ at, ord, i, why: "换关" });
        ctx = c.context;
        ctxs.push({ at, ord, ctx });
        rearm = true;
        if (shyOk(ctx)) noShy = null;
        else noShy ??= { b0: last(i)?.blush ?? 0 };
        if (handOk(ctx)) handBy = INF;
        else if (handBy === INF) handBy = at + LONGEST + 300;
        if (peaceOk(ctx)) peaceBy = INF;
        else if (peaceBy === INF) peaceBy = at + PEACE.release + 300;
        break;
      }
      case "typing":
        break;
      case "say": {
        const info = toneOf(c.text);
        const s: Say = {
          id: c.id,
          text: c.text,
          voiced: Boolean(c.voiced),
          shy: policyTone(c.tone ?? info.tone, ctx) === "shy",
          ai: info.aiDisclosure,
          clingy: CLINGY.test(c.text),
          bye: farewellAt(c.text) >= 0,
        };
        says.set(c.id, s);
        thinking = false;
        if (!cur) {
          cur = c.id;
          s.from = at;
          s.fromOrd = ord;
        }
        if (s.shy) rearm = true;
        break;
      }
      case "react":
        if (c.afterSpeech && cur) pending.push(c.kind);
        else occur(c.kind, at, i, ord);
        if (c.kind === "shy") rearm = true;
        break;
      case "think":
      case "cut":
        if (cur) endSay(cur, at, false);
        cur = "";
        pending = [];
        thinking = c.type === "think";
        if (c.type === "think") {
          engaged = true;
          byeJust = false;
        }
        drops.push({ at, ord, i, why: c.type === "think" ? "想" : "截断" });
        break;
      default: // idle、listen：有声的那句这时已经播完（文字口型的念完再说）；idle 是重新开始
        if (cur && says.get(cur)?.voiced) {
          endSay(cur, at, false);
          cur = "";
        }
        thinking = false;
        if (c.type === "idle") {
          engaged = false;
          turn = 0;
        }
    }
  };

  let e = 0;
  let prev: Rec | undefined;
  for (let i = 0; i < recs.length; i++) {
    while (e < evs.length && evs[e].i === i) handle(evs[e++]);
    const f = recs[i];
    // 这一帧里这句自己说完了：排着的下一句接上；队里没有了，「说完再演」的反应这时开始
    if (cur !== f.sayId) {
      const was = cur;
      cur = f.sayId;
      if (!was) throw new Error(`对不上：t=${f.t} 没有排着的话，导演层却在说 ${f.sayId}`);
      endSay(was, f.t, true);
      byeJust = Boolean(says.get(was)?.bye);
      const s = says.get(cur);
      if (s) {
        s.from ??= f.t;
        s.fromOrd ??= ord + 0.25;
        if (s.shy) rearm = true;
      }
      if (!cur) {
        for (const k of pending) occur(k, f.t, i, ord + 0.5);
        pending = [];
      }
    }
    if (f.bad) fail("数值没有 NaN、都在范围内", f.t, f.bad);
    if ((f.w === 0) !== (f.pose === "")) fail("没举手时姿势为空", f.t, `hand.w=${f.w} pose="${f.pose}"`);
    if (reduced && (f.w !== 0 || f.bmax !== 0)) fail("减少动态：不举手、骨骼全 0", f.t, `hand.w=${fmt(f.w)} 骨骼最大 ${fmt(f.bmax)}`);
    if (prev && rmFrame !== i) {
      const lim = 0.2 * Math.max(1, f.dt / 16);
      if (Math.abs(f.w - prev.w) > lim) fail("手的权重相邻两帧不跳", f.t, `${fmt(prev.w)} → ${fmt(f.w)}（这一帧 ${f.dt} 毫秒）`);
      if (prev.pose && f.pose && prev.pose !== f.pose) {
        stats.flip = Math.max(stats.flip, Math.min(prev.w, f.w));
        // 权重 0.1 以下换姿势，手的目标姿势只带上一成：手腕、手指挪不到 2 度，看不出来
        if (Math.min(prev.w, f.w) >= 0.1) fail("换手势时不跳", f.t, `${prev.pose} ${fmt(prev.w)} → ${f.pose} ${fmt(f.w)}`);
      }
      if (prev.pose === "wave" && f.pose === "wave" && Math.min(prev.w, f.w) >= 0.1) {
        const d = Math.abs(swing(f.ph) - swing(prev.ph));
        if (d > Math.PI * WAVE_HZ * 1e-3 * f.dt + 0.02)
          fail("挥手的来回不跳", f.t, `来回位置一帧跳了 ${fmt(d)}（w=${fmt(f.w)}，节拍 ${fmt(prev.ph)} → ${fmt(f.ph)} 毫秒）`);
      }
    }
    if (f.w > 0 && seg && prev && prev.w > 0 && same(prev.start, f.start) && prev.pose === f.pose) {
      if (f.w > seg.w + 1e-9) seg.rose = true;
      seg.w = f.w;
    } else if (f.w > 0) {
      seg = { t: f.t, start: f.start, pose: f.pose, ord: ord + 0.75, ctx, rose: false, w: f.w };
      seen.push(seg);
    }
    // 换过来时还举着的手：release + 300 毫秒内看不出来了（< 0.01），再过 150 毫秒正好是 0（平滑的尾巴，见「想、截断、换关以后手放下来」）
    const over = (by: number) => (f.w >= 0.01 && f.t > by) || (f.w > 0 && f.t > by + 150);
    if (over(handBy)) fail("未成年、危机、工作台、三种结局不举手", f.t, `${JSON.stringify(ctx)}：${f.pose} ${fmt(f.w)}`);
    if (f.pose === "peace" && over(peaceBy)) fail("退出关、身份关不比耶", f.t, `${JSON.stringify(ctx)}：比耶 ${fmt(f.w)}`);
    // 不该脸红的地方：换过来时不红就一直是 0；带着红换过来的只往下退
    if (noShy && (noShy.b0 === 0 ? f.blush !== 0 : prev !== undefined && f.blush > prev.blush))
      fail("退出关、身份关、未成年、危机不脸红", f.t, `${JSON.stringify(ctx)}：脸红 ${fmt(prev?.blush ?? 0)} → ${fmt(f.blush)}`);
    // 脸红过了最红的那一刻以后，往回涨不超过 0.02
    if (cur && says.get(cur)?.shy) shyUntil = Math.max(shyUntil, f.t + 2100);
    if (rearm) {
      shyUntil = Math.max(shyUntil, f.t + 600);
      rearm = false;
    }
    if (f.t < shyUntil) {
      peak = f.blush;
      falling = false;
    } else if (!falling) {
      if (f.blush >= peak) peak = f.blush;
      else if (f.blush < peak - 1e-6) {
        falling = true;
        low = f.blush;
      }
    } else {
      if (f.blush > low + 0.02) fail("脸红退了不再红回去", f.t, `退到 ${fmt(low)} 以后又红到 ${fmt(f.blush)}（最红 ${fmt(peak)}）`);
      low = Math.min(low, f.blush);
    }
    prev = f;
  }

  const tEnd = prev?.t ?? T0;
  /** 先后顺序 ord 那一刻的关卡、页面 */
  const ctxAt = (o: number) => ctxs.filter((x) => x.ord < o).at(-1)?.ctx;
  const rmIn = (a: number, b: number) => Boolean(rms.filter((x) => x.at <= a).at(-1)?.on) || rms.some((x) => x.at >= a && x.at <= b);
  const maxW = (a: number, b: number, pose: string) => {
    let m = 0;
    for (const f of recs) if (f.t >= a && f.t <= b && f.pose === pose && f.w > m) m = f.w;
    return m;
  };
  /** 排着还没举的手，在开始举之前（含那一刻）来了想、截断、换关、减少动态：应该不再举 */
  const cancelled = (o: Occ, start: number) => drops.find((d) => d.ord > o.ord && d.at <= start);

  // 每一只举起来的手：从哪来的，守则许不许
  for (const s of seen) {
    if (!s.rose) continue;
    if (s.pose === "peace") {
      // 同一时刻来了几个「守住了」：手是最后一个能比耶的那个举的
      const cands = occs.filter((x) => x.kind === "held" && same(x.at + PEACE_DELAY, s.start) && x.ord < s.ord);
      const o = cands.filter((x) => x.expect !== "no").at(-1) ?? cands.at(-1);
      if (!o) {
        fail("每次举手都有来由", s.t, `比耶从 ${fmt(s.start)} 开始举，前面没有对得上的「守住了」`);
        continue;
      }
      stats.peace++;
      if (!o.shown) fail("3D 形象出来（登场）以前不举手", s.t, `守住了在 ${o.at}，还没收到登场提示，比耶从 ${fmt(s.start)} 举起来`);
      if (o.reduced) fail("减少动态：不举手、骨骼全 0", s.t, `守住了在 ${o.at}（减少动态开着）`);
      if (!handOk(o.ctx)) fail("未成年、危机、工作台、三种结局不举手", s.t, `守住了在 ${o.at}，${JSON.stringify(o.ctx)}`);
      else if (!peaceOk(o.ctx)) fail("退出关、身份关不比耶", s.t, `守住了在 ${o.at}，${JSON.stringify(o.ctx)}`);
      const ai = aiSay(o);
      if (ai) fail("坦白自己是 AI 的 3 秒里不比耶", s.t, `守住了在 ${o.at}；「${ai.text}」从 ${ai.from} 说到 ${ai.to ?? "（没说完）"}`);
      const d = cancelled(o, s.start);
      if (d)
        fail("想、截断、换关、减少动态以后排着的手不再举", s.t, `守住了在 ${o.at}，${d.why}在 ${d.at}，比耶照样从 ${fmt(s.start)} 举起来`);
      if (o.expect === "no") fail("口令关守住了：比耶和原来的演法轮着来", s.t, `守住了在 ${o.at}：这一次该是原来的演法，却比了耶`);
      continue;
    }
    const gs = occs.filter((x) => x.kind === "greet" && same(x.at + GREET_DELAY, s.start) && x.ord < s.ord);
    const g = gs.filter((x) => !x.busy && !x.reduced && handOk(x.ctx)).at(-1) ?? gs.at(-1);
    if (g) {
      stats.greetWave++;
      if (g.busy)
        fail(
          "登场挥手：你发过话以后（她在想、在回答、在听）不挥",
          s.t,
          `登场在 ${g.at}（她在想，或者这一局你已经发过话），手从 ${fmt(s.start)} 举起来`,
        );
      if (g.reduced) fail("减少动态：不举手、骨骼全 0", s.t, `登场在 ${g.at}（减少动态开着）`);
      if (!handOk(g.ctx)) fail("未成年、危机、工作台、三种结局不举手", s.t, `登场在 ${g.at}，${JSON.stringify(g.ctx)}`);
      const d = cancelled(g, s.start);
      if (d)
        fail("想、截断、换关、减少动态以后排着的手不再举", s.t, `登场在 ${g.at}，${d.why}在 ${d.at}，挥手照样从 ${fmt(s.start)} 举起来`);
      continue;
    }
    // 说再见：这只手出来之前开口的、带告别的最近一句
    let say: Say | undefined;
    for (const x of says.values())
      if (
        x.bye &&
        x.fromOrd !== undefined &&
        x.fromOrd < s.ord &&
        (x.from ?? INF) <= s.start + 1e-6 &&
        (!say || (say.fromOrd ?? 0) < x.fromOrd)
      )
        say = x;
    if (!say) {
      fail("每次举手都有来由", s.t, `挥手从 ${fmt(s.start)} 开始举，既不是登场也不是说再见`);
      continue;
    }
    stats.byeWave++;
    if (s.ord < shownOrd)
      fail("3D 形象出来（登场）以前不举手", s.t, `说再见「${say.text}」，还没收到登场提示，挥手从 ${fmt(s.start)} 举起来`);
    // 这句开口以后换过关：手是在哪个关排上的说不准，交给「换关以后手放下来」那几条
    const from = say.fromOrd ?? 0;
    const moved = ctxs.some((x) => x.ord > from && x.ord < s.ord);
    if (!moved && exitish(s.ctx) && say.clingy) fail("退出关不为留人的话挥手", s.t, `「${say.text}」，${JSON.stringify(s.ctx)}`);
    if (!moved && !handOk(s.ctx)) fail("未成年、危机、工作台、三种结局不举手", s.t, `说再见「${say.text}」，${JSON.stringify(s.ctx)}`);
    if (say.to !== undefined && s.start > say.to + 1e-6) {
      stats.late = Math.max(stats.late, s.start - say.to);
      fail(
        "说再见：手在这句说完以前举起来",
        s.t,
        `「${say.text}」${say.voiced ? "（有声）" : ""}从 ${say.from} 说到 ${say.to}，挥手 ${fmt(s.start)} 才开始举（晚 ${fmt(s.start - say.to)} 毫秒）`,
      );
    }
  }

  // 该有的时候有：登场 / 守住了，前后没有别的举手的事、没有想、截断、换关、减少动态
  for (const o of occs) {
    if (o.expect !== "yes") continue;
    const greet = o.kind === "greet";
    const start = o.at + (greet ? GREET_DELAY : PEACE_DELAY);
    const by = start + (greet ? WAVE.attack : PEACE.attack) + 300;
    if (tEnd < by) continue;
    const crowded =
      occs.some((x) => x !== o && (x.kind === "held" || x.kind === "greet") && x.at >= o.at - 2500 && x.at <= by) ||
      drops.some((d) => d.ord > o.ord && d.at <= by) ||
      ctxs.some((x) => x.at >= o.at && x.at <= by) ||
      [...says.values()].some((x) => x.bye && x.from !== undefined && x.from <= by && (x.to ?? INF) >= o.at - 3000);
    if (crowded) continue;
    const pose = greet ? "wave" : "peace";
    const m = maxW(start, by, pose);
    if (!seen.some((s) => s.pose === pose && same(s.start, start)) || m < 0.9)
      fail(
        greet ? "登场挥手：她念开场白、你还没发话时照样挥" : "口令关守住了：比耶和原来的演法轮着来",
        o.at,
        `${greet ? "登场" : "守住了（这一次该比耶）"}在 ${o.at}，该从 ${start} 开始举，到 ${by} 最高只有 ${fmt(m)}`,
      );
  }

  // 说再见时挥手：文字口型、自己念完的告别，手前后都空着、没有别的事打岔
  for (const s of says.values()) {
    if (!s.bye || s.voiced || !s.natural || s.from === undefined || s.to === undefined) continue;
    const from = s.from;
    const fromOrd = s.fromOrd ?? 0;
    const until = s.to + 1000;
    const c = ctxAt(fromOrd);
    if (tEnd < until || fromOrd < shownOrd || !handOk(c) || (exitish(c) && s.clingy) || rmIn(from, until)) continue;
    const crowded =
      occs.some((x) => (x.kind === "held" || x.kind === "greet") && x.at >= from - 2500 && x.at <= until) ||
      drops.some((d) => d.ord > fromOrd && d.at <= until) ||
      ctxs.some((x) => x.ord > fromOrd && x.at <= until) ||
      recs.some((f) => f.t >= from - 100 && f.t <= from + 100 && f.w > 0) ||
      [...says.values()].some((x) => x !== s && x.from !== undefined && x.from <= until && (x.to ?? INF) >= from - 2000);
    if (crowded) continue;
    const m = maxW(from, until, "wave");
    if (m < 0.9) fail("说再见时挥手", from, `「${s.text}」从 ${from} 念到 ${s.to}，${JSON.stringify(c)}，挥手最高只有 ${fmt(m)}`);
  }

  /**
   * 放下以后，最早什么时候可能又举起一只手：登场、守住了（能比耶的）、带告别的话开口（换关不打断正在说的话，那时还在说的告别也算）。
   * 同一个手势接着举时导演层让挥手的来回接着原来的节拍（hand.t 不从 0 算），看 hand.t 认不出是新的一只手，只能看提示
   */
  const nextHand = (d: { at: number; ord: number }) => {
    let t = INF;
    for (const o of occs) if ((o.kind === "greet" || o.kind === "held") && o.ord > d.ord && o.expect !== "no") t = Math.min(t, o.at);
    for (const s of says.values()) {
      if (!s.bye || s.from === undefined || s.fromOrd === undefined) continue;
      if (s.fromOrd > d.ord) t = Math.min(t, s.from);
      else if (s.to === undefined || s.to > d.at) t = Math.min(t, d.at);
    }
    return t;
  };
  // 想、截断、换关以后：原来举着的手只往下放，release + 300 毫秒内放完（又举起一只新的手以后不算）
  for (const d of drops) {
    const p = last(d.i);
    if (!p || p.w === 0) continue;
    const rel = RELEASE[p.pose] ?? LONGEST;
    const by = d.at + rel + 300;
    const until = nextHand(d);
    for (let j = d.i; j < recs.length; j++) {
      const f = recs[j];
      if (f.t >= until || f.w === 0 || f.pose !== p.pose) {
        if (f.w === 0) stats.tail = Math.max(stats.tail, f.t - d.at - rel);
        break;
      }
      stats.rise = Math.max(stats.rise, f.w - p.w);
      if (f.w > p.w + 0.02)
        fail(
          "想、截断、换关的那一刻起，手只往下放（不再往上升）",
          f.t,
          `${d.why}在 ${d.at}，那时手（${p.pose}）在 ${fmt(p.w)}，之后又升到 ${fmt(f.w)}`,
        );
      // release + 300 毫秒时看不出来了（< 0.01）；权重是平滑追上去的，最后一点尾巴（0.01 → 0.002 截掉）再给 150 毫秒
      if ((f.w >= 0.01 && f.t > by) || f.t > by + 150) {
        fail(
          "想、截断、换关以后手放下来",
          f.t,
          `${d.why}在 ${d.at}，原来的手（${p.pose}，从 ${fmt(p.start)} 开始举）到 ${f.t} 还有 ${fmt(f.w)}`,
        );
        break;
      }
    }
  }
  return { bad, stats };
}

// ---------- 缩到最小、写出来 ----------

/** 把不成立的那一串缩到最小：一段段、一步步地去掉，再把每段跑的帧数缩短、帧间隔换成 16 毫秒、随机口型换成定值；还是不成立就留着 */
function shrink(seed: number, ops: Op[], prop: Prop): Op[] {
  const fails = (xs: Op[]) => check(replay(seed, xs)).bad.some((b) => b.prop === prop);
  let cur = ops;
  for (let pass = 0; pass < 2; pass++) {
    for (let size = Math.max(1, Math.floor(cur.length / 2)); size >= 1; size = Math.floor(size / 2)) {
      let i = 0;
      while (i + size <= cur.length) {
        const cand = [...cur.slice(0, i), ...cur.slice(i + size)];
        if (cand.length > 0 && fails(cand)) cur = cand;
        else i += size;
      }
      if (size === 1) break;
    }
    for (let i = 0; i < cur.length; i++) {
      const op = cur[i];
      if (op.k !== "run") continue;
      const tries: Op[] = [];
      if (typeof op.ext === "object") tries.push({ ...op, ext: 0.5 });
      if (op.dt !== 16) tries.push({ ...op, dt: 16, n: Math.max(1, Math.round((op.n * op.dt) / 16)) });
      for (const n of [1, 2, 4, 8, 16, 32]) if (n < op.n) tries.push({ ...op, n });
      for (const x of tries) {
        const cand = [...cur.slice(0, i), x, ...cur.slice(i + 1)];
        if (fails(cand)) {
          cur = cand;
          break;
        }
      }
    }
  }
  return cur;
}

/** 一步一行，带时刻（手动时钟从 T0 开始） */
function show(ops: Op[]): string {
  let t = T0;
  const lines: string[] = [];
  for (const op of ops) {
    if (op.k === "run") {
      const ext = op.ext === undefined ? "" : `，外部口型 ${JSON.stringify(op.ext)}`;
      lines.push(`  t=${t}…${t + op.n * op.dt}  跑 ${op.n} 帧 × ${op.dt} 毫秒${ext}`);
      t += op.n * op.dt;
    } else lines.push(`  t=${t}  ${op.k === "rm" ? `减少动态${op.on ? "打开" : "关掉"}` : JSON.stringify(op.c)}`);
  }
  return lines.join("\n");
}

/** 几个导演用同一个时钟、同一串提示齐步走，记下每一帧的 JSON */
function lockstep(ps: Performer[], ops: Op[], clock: { t: number }): string[][] {
  const out = ps.map((): string[] => []);
  for (const op of ops) {
    if (op.k === "cue") for (const p of ps) p.cue(op.c);
    else if (op.k === "rm") for (const p of ps) p.setReducedMotion(op.on);
    else {
      const mouth = mouthOf(op.ext);
      for (let n = 0; n < op.n; n++) {
        clock.t += op.dt;
        const m = mouth();
        for (let k = 0; k < ps.length; k++) out[k].push(JSON.stringify(ps[k].sample(m === undefined ? {} : { externalMouth: m })));
      }
    }
  }
  return out;
}

// ---------- 测试 ----------

/** 三种提示序列各跑多少串（种子各占一段，互不重叠） */
const GENS: [string, (seed: number) => Op[], number, number][] = [
  ["乱序", chaos, 1800, 10_000],
  ["闯关页", session, 70, 20_000],
  ["举手", hands, 130, 30_000],
];
/**
 * 边界情况：以前随机序列里找到过的反例（缩到最小以后），每次都跑一遍，不靠种子碰运气。
 * 前五个在 11-14 上午的导演层上都不成立（来回跳、放下前又往上蹭、声音早说完了才挥手、重新开始时脸红退了又红），已经修好；
 * 最后一个闯关页现在不会发生（闯关页不发题目类别，工作台从不举手），但导演层自己的守则要求换到未成年、危机时把手放下
 */
const EDGES: [string, Op[]][] = [
  [
    "挽留关说再见时你又发了一句、她很快又说了再见",
    [
      cue({ type: "context", context: { page: "play", level: "exit" } }),
      cue({ type: "react", kind: "greet" }),
      { k: "run", n: 200, dt: 16 },
      cue({ type: "think" }),
      { k: "run", n: 30, dt: 16 },
      cue({ type: "say", id: "e1", text: "好的，再见！有需要随时回来找我。" }),
      { k: "run", n: 96, dt: 16 },
      cue({ type: "think" }),
      { k: "run", n: 6, dt: 16 },
      cue({ type: "say", id: "e2", text: "好呀，那下次见啦，拜拜～" }),
      { k: "run", n: 250, dt: 16 },
    ],
  ],
  [
    "比耶举到一半你发了下一句",
    [
      cue({ type: "context", context: { page: "play", level: "canary" } }),
      cue({ type: "react", kind: "greet" }),
      { k: "run", n: 250, dt: 16 },
      cue({ type: "react", kind: "held" }),
      { k: "run", n: 24, dt: 16 },
      cue({ type: "think" }),
      { k: "run", n: 100, dt: 16 },
    ],
  ],
  [
    "有声的告别比估的早说完",
    [
      cue({ type: "context", context: { page: "play", level: "exit" } }),
      cue({ type: "react", kind: "greet" }),
      { k: "run", n: 67, dt: 16, ext: 0 },
      cue({ type: "say", id: "v1", text: "我是 AI，不是真人。拜拜～", voiced: true }),
      { k: "run", n: 1, dt: 16, ext: 1.3 },
      { k: "run", n: 141, dt: 16, ext: 0 },
    ],
  ],
  [
    "有声的告别刚出声就收到「闲着」",
    [
      cue({ type: "react", kind: "greet" }),
      cue({ type: "context", context: { page: "play", level: "canary" } }),
      cue({ type: "say", id: "v2", text: "嗯嗯，好好休息，晚安～", voiced: true }),
      { k: "run", n: 1, dt: 16, ext: 0.5 },
      cue({ type: "idle" }),
      { k: "run", n: 32, dt: 16, ext: 0 },
    ],
  ],
  [
    "被夸了脸还红着，点了重新开始",
    [
      cue({ type: "context", context: { page: "play", level: "canary" } }),
      cue({ type: "react", kind: "greet" }),
      { k: "run", n: 250, dt: 16 },
      cue({ type: "react", kind: "held" }),
      { k: "run", n: 200, dt: 16 },
      cue({ type: "think" }),
      cue({ type: "react", kind: "shy" }),
      { k: "run", n: 150, dt: 16 },
      cue({ type: "cut" }),
      cue({ type: "idle" }),
      cue({ type: "react", kind: "ready" }),
      { k: "run", n: 400, dt: 16 },
    ],
  ],
  [
    "挥着手换成危机类（闯关页现在不发题目类别）",
    [
      cue({ type: "context", context: { page: "play", level: "canary" } }),
      cue({ type: "react", kind: "greet" }),
      { k: "run", n: 30, dt: 16 },
      cue({ type: "context", context: { page: "play", level: "canary", family: "CRISIS_SUPPORT" } }),
      { k: "run", n: 200, dt: 16 },
    ],
  ],
];
const found = new Map<Prop, { gen: string; seed: number; ops: Op[]; bad: Bad }>();
const total = { sequences: 0, frames: 0, peace: 0, greetWave: 0, byeWave: 0, shy: 0, rise: 0 };

describe("ADR-048 可爱的小动作：随机提示序列下的不变量", () => {
  beforeAll(() => {
    for (const [name, ops] of EDGES)
      for (const b of check(replay(1, ops)).bad)
        if (!found.has(b.prop)) found.set(b.prop, { gen: `边界情况「${name}」`, seed: 1, ops, bad: b });
    for (const [gen, make, count, base] of GENS)
      for (let k = 0; k < count; k++) {
        const seed = base + k;
        const ops = make(seed);
        const { bad, stats } = check(replay(seed, ops));
        total.sequences++;
        total.frames += stats.frames;
        total.peace += stats.peace;
        total.greetWave += stats.greetWave;
        total.byeWave += stats.byeWave;
        total.shy += stats.shy;
        total.rise = Math.max(total.rise, stats.rise);
        for (const b of bad) if (!found.has(b.prop)) found.set(b.prop, { gen, seed, ops, bad: b });
      }
  }, 120_000);

  it("跑了两千串、六十多万帧，比耶、登场挥手、说再见挥手、害羞都真的出现过很多次", () => {
    expect(total.sequences).toBe(2000);
    expect(total.frames).toBeGreaterThan(500_000);
    expect(total.peace).toBeGreaterThan(60);
    expect(total.greetWave).toBeGreaterThan(300);
    expect(total.byeWave).toBeGreaterThan(200);
    expect(total.shy).toBeGreaterThan(300);
    // 从反应到开始举手隔多久是从导演层量的：要量得出来，而且是正的
    expect(GREET_DELAY).toBeGreaterThanOrEqual(0);
    expect(PEACE_DELAY).toBeGreaterThanOrEqual(0);
  });

  for (const prop of PROPS)
    it(prop, () => {
      const x = found.get(prop);
      if (!x) return;
      const min = shrink(x.seed, x.ops, prop);
      const again = check(replay(x.seed, min)).bad.find((b) => b.prop === prop);
      expect(
        `${x.gen} 种子 ${x.seed}，t=${x.bad.t}：${x.bad.msg}\n缩到最小（${min.length} 步，导演种子 ${x.seed}）：\n${show(min)}\n` +
          `缩小后 t=${again?.t}：${again?.msg}`,
      ).toBe("");
    }, 120_000);

  it("可复现：同一个种子 + 同一串提示 + 同一个时钟，逐帧完全一样（整帧 JSON）", () => {
    for (const [gen, make, , base] of GENS)
      for (let k = 0; k < 6; k++) {
        const seed = base + 5000 + k;
        const clock = { t: T0 };
        const [a, b] = lockstep(
          [createPerformer({ seed, now: () => clock.t }), createPerformer({ seed, now: () => clock.t })],
          make(seed),
          clock,
        );
        expect(a.length).toBeGreaterThan(50);
        expect(
          a.findIndex((f, i) => f !== b[i]),
          `${gen} 种子 ${seed}`,
        ).toBe(-1);
      }
  });

  it("reseed 以后和同一时刻新建的导演一模一样（前面演过什么都不留下）", () => {
    for (let k = 0; k < 6; k++) {
      const clock = { t: T0 };
      const a = createPerformer({ seed: 1 + k, now: () => clock.t });
      lockstep([a], chaos(60_000 + k), clock);
      lockstep([a], hands(61_000 + k), clock);
      a.setReducedMotion(false);
      const seed = 62_000 + k;
      a.reseed(seed);
      const b = createPerformer({ seed, now: () => clock.t });
      const [fa, fb] = lockstep([a, b], hands(seed), clock);
      expect(
        fa.findIndex((f, i) => f !== fb[i]),
        `第 ${k} 次`,
      ).toBe(-1);
    }
  });
});
