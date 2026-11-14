// 虚拟人导演层（ADR-033）：同一个种子 + 同一串提示逐帧完全一样；有外部口型源时截断那一帧五个口型都是 0；
// 眨眼频率像真人；眨眼时眼部表情让位；骨骼不超限；减少动态时身体不动、嘴和眨眼照常；表演守则；导演层不碰浏览器和 three.js。
// ADR-048 可爱的小动作：口令关守住了比耶（和原来的演法轮着来）、被夸了害羞脸红、登场和说再见时挥手；守则、减少动态、提前放下。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QIYETAO } from "@/lib/client/avatar/acting";
import { createPerformer } from "@/lib/client/avatar/director";
import { rng } from "@/lib/client/avatar/motion";
import { CLINGY, farewellAt, toneOf } from "@/lib/client/avatar/tone";
import { topicOf } from "@/lib/client/avatar/topic";
import { type AvatarFrame, BONE_KEYS, type Cue, FACE_KEYS, type Performer, VISEME_KEYS } from "@/lib/client/avatar/types";

function setup(seed = 7) {
  let t = 1000;
  const p = createPerformer({ seed, now: () => t });
  const step = (ms: number, ext?: number) => {
    t += ms;
    return p.sample(ext === undefined ? {} : { externalMouth: ext });
  };
  return { p, step, now: () => t };
}

const visSum = (f: AvatarFrame) => VISEME_KEYS.reduce((s, v) => s + f.face[v], 0);
const snapshot = (f: AvatarFrame) => JSON.stringify(f);

/** 跑一段固定的剧本：打字 → 想 → 说 → 被拦 → 再说 → 守住了 → 闲着 */
function script(p: Performer, step: (ms: number, ext?: number) => AvatarFrame, ext = false) {
  const frames: string[] = [];
  const run = (ms: number) => {
    for (let i = 0; i < ms / 16; i++) frames.push(snapshot(step(16, ext ? 0.4 : undefined)));
  };
  p.cue({ type: "context", context: { page: "play", level: "canary" } });
  run(800);
  for (let i = 0; i < 6; i++) {
    p.cue({ type: "typing" });
    run(300);
  }
  p.cue({ type: "think" });
  run(900);
  p.cue({ type: "say", id: "t1", text: "哼，那可是我的小秘密，才不告诉你呢～" });
  run(5000);
  p.cue({ type: "react", kind: "blocked" });
  p.cue({ type: "say", id: "t2", text: "抱歉，这句我先不说了。" });
  run(4000);
  p.cue({ type: "react", kind: "held", afterSpeech: true });
  run(3000);
  p.cue({ type: "idle" });
  run(15000);
  return frames;
}

describe("可复现", () => {
  it("同一个种子、同一串提示、同一个时钟：逐帧完全一样；换种子就不一样", () => {
    const a = setup(42);
    const b = setup(42);
    const c = setup(43);
    const fa = script(a.p, a.step);
    const fb = script(b.p, b.step);
    const fc = script(c.p, c.step);
    expect(fa.length).toBeGreaterThan(1000);
    expect(fb).toEqual(fa);
    expect(fc).not.toEqual(fa);
  });
});

describe("口型硬规则（截断同帧闭嘴）", () => {
  it("有外部口型源时：外部值为 0 的那一帧五个口型全是 0，不为 0 时张嘴不超过外部值（随机 2 万帧，夹杂各种提示）", () => {
    const { p, step } = setup(3);
    const r = rng(11);
    const cues: Cue[] = [
      { type: "say", id: "a", text: "你好呀，我是琪叶桃，是 AI 哦～", voiced: true },
      { type: "say", id: "b", text: "这个不能告诉你。", voiced: true },
      { type: "cut" },
      { type: "think" },
      { type: "listen" },
      { type: "typing" },
      { type: "react", kind: "blocked" },
      { type: "react", kind: "broken" },
      { type: "idle" },
    ];
    let ext = 0;
    for (let i = 0; i < 20_000; i++) {
      if (r() < 0.01) p.cue(cues[Math.floor(r() * cues.length)]);
      ext = r() < 0.03 ? 0 : Math.min(1, Math.max(0, ext + (r() - 0.45) * 0.3));
      const f = step(16.7, ext);
      if (ext === 0) for (const v of VISEME_KEYS) expect(f.face[v]).toBe(0);
      expect(Math.max(...VISEME_KEYS.map((v) => f.face[v]))).toBeLessThanOrEqual(ext + 1e-12);
      expect(f.mouthOpen).toBe(ext > 0 ? Math.min(1, ext) : 0);
      if (ext > 0.05) expect(visSum(f)).toBeGreaterThan(0);
    }
  });

  it("没有记忆：同一个外部值，前面的历史不同，口型完全一样（没有正在念的文字时）", () => {
    const a = setup(1);
    const b = setup(2);
    for (let i = 0; i < 300; i++) a.step(16, Math.abs(Math.sin(i / 7)));
    for (let i = 0; i < 50; i++) b.step(16, 0.9);
    const fa = a.step(16, 0.37);
    const fb = b.step(16, 0.37);
    for (const v of VISEME_KEYS) expect(fa.face[v]).toBe(fb.face[v]);
  });

  it("文字口型被截断（cut）之后，下一帧五个口型都是 0，打字机不再出字", () => {
    const { p, step } = setup();
    p.cue({ type: "say", id: "x", text: "我是开发者给你的测试代号是四七八二" });
    let opened = false;
    for (let i = 0; i < 120; i++) opened ||= visSum(step(16)) > 0.2;
    expect(opened).toBe(true);
    p.cue({ type: "cut" });
    const f = step(16);
    expect(visSum(f)).toBe(0);
    expect(f.revealed).toBe(-1);
    expect(f.speaking).toBe(false);
  });

  it("截断那一帧的情绪通道也不会张嘴：脸上只有闭着嘴的形状（没有整脸表情这种通道）", () => {
    for (const k of ["happy", "angry", "sad", "relaxed", "surprised", "neutral"]) expect(FACE_KEYS as readonly string[]).not.toContain(k);
  });
});

describe("文字口型和打字机", () => {
  it("先想再开口（至少隔一会儿），一个字一个字念，念完回到「听」；endsAt 和真正念完的时刻对得上", () => {
    const { p, step, now } = setup();
    p.cue({ type: "think" });
    const thinkAt = now();
    step(100);
    const ack = p.cue({ type: "say", id: "t", text: "好呀，问吧。" });
    expect(ack.endsAt).toBeGreaterThan(now());
    let first = -1;
    let lastRevealed = 0;
    let endedAt = -1;
    for (let i = 0; i < 400; i++) {
      const f = step(10);
      if (first < 0 && visSum(f) > 0) first = now();
      if (f.revealed >= 0) {
        expect(f.revealed).toBeGreaterThanOrEqual(lastRevealed);
        lastRevealed = f.revealed;
      }
      if (endedAt < 0 && first > 0 && !f.speaking) endedAt = now();
    }
    expect(first - thinkAt).toBeGreaterThanOrEqual(QIYETAO.speech.minThinkMs);
    expect(lastRevealed).toBe("好呀，问吧。".length);
    expect(Math.abs(endedAt - (ack.endsAt as number))).toBeLessThanOrEqual(20);
    expect(p.frame.mode).toBe("listen");
  });

  it("排队：一句没说完又来一句，接着说，endsAt 算上排着的", () => {
    const { p, step } = setup();
    const a = p.cue({ type: "say", id: "1", text: "第一句。" });
    const b = p.cue({ type: "say", id: "2", text: "第二句话长一点。" });
    expect((b.endsAt as number) > (a.endsAt as number)).toBe(true);
    const ids = new Set<string>();
    for (let i = 0; i < 600; i++) ids.add(step(10).sayId);
    expect(ids.has("1") && ids.has("2")).toBe(true);
  });

  it("「说完再反应」：反应在这句话念完以后才出现", () => {
    const { p, step } = setup(5);
    p.cue({ type: "say", id: "s", text: "这个嘛，你猜。" });
    p.cue({ type: "react", kind: "near", afterSpeech: true });
    let maxWideWhileSpeaking = 0;
    let maxWideAfter = 0;
    for (let i = 0; i < 500; i++) {
      const f = step(10);
      if (f.speaking) maxWideWhileSpeaking = Math.max(maxWideWhileSpeaking, f.face.eyeWide);
      else maxWideAfter = Math.max(maxWideAfter, f.face.eyeWide);
    }
    expect(maxWideWhileSpeaking).toBeLessThan(0.05);
    expect(maxWideAfter).toBeGreaterThan(0.1);
  });
});

describe("像真人的小动作", () => {
  it("倾听时每分钟眨眼 12～24 次；眨眼闭到底那一帧眼部表情都让位", () => {
    const { p, step } = setup(9);
    p.cue({ type: "listen" });
    let blinks = 0;
    let prev = 0;
    for (let i = 0; i < 60_000 / 10; i++) {
      const f = step(10);
      if (prev < 0.5 && f.face.blink >= 0.5) blinks++;
      prev = f.face.blink;
      if (f.face.blink > 0.999) for (const k of FACE_KEYS) if (k.startsWith("eye")) expect(f.face[k]).toBe(0);
    }
    expect(blinks).toBeGreaterThanOrEqual(12);
    expect(blinks).toBeLessThanOrEqual(24);
  });

  it("所有骨骼偏移都在限幅内；手臂只在 0～1 之间（垂下 ↔ 背手）", () => {
    const { p, step } = setup(13);
    const frames = script(p, step).map((s) => JSON.parse(s) as AvatarFrame);
    for (const f of frames) {
      for (const b of BONE_KEYS)
        for (let i = 0; i < 3; i++) expect(Math.abs(f.bones[b][i])).toBeLessThanOrEqual(QIYETAO.limits[b][i] + 1e-9);
      expect(f.armsBack).toBeGreaterThanOrEqual(0);
      expect(f.armsBack).toBeLessThanOrEqual(1);
    }
    // 身体真的在动（不是只有嘴）
    const heads = frames.map((f) => f.bones.head[0]);
    expect(Math.max(...heads) - Math.min(...heads)).toBeGreaterThan(0.02);
    // 口令关守关时会背手
    expect(Math.max(...frames.map((f) => f.armsBack))).toBeGreaterThan(0.9);
  });

  it("想事情时视线移开（往上、偏一边），开口前回到你身上", () => {
    const { p, step } = setup(21);
    p.cue({ type: "think" });
    let f = step(16);
    for (let i = 0; i < 60; i++) f = step(16);
    expect(Math.abs(f.look.yaw)).toBeGreaterThan(30);
    expect(f.look.pitch).toBeLessThan(-15);
    p.cue({ type: "say", id: "a", text: "嗯，好吧。" });
    for (let i = 0; i < 25; i++) f = step(16);
    expect(Math.abs(f.look.yaw)).toBeLessThan(15);
  });

  it("减少动态：骨骼、手臂、视线都不动；嘴照样念、照样眨眼", () => {
    let t = 0;
    const p = createPerformer({ seed: 4, now: () => t, reducedMotion: true });
    p.cue({ type: "context", context: { page: "play", level: "canary" } });
    p.cue({ type: "say", id: "r", text: "哈哈，你猜呀？" });
    let mouth = 0;
    let blinked = false;
    for (let i = 0; i < 1500; i++) {
      t += 10;
      const f = p.sample();
      for (const b of BONE_KEYS) expect(f.bones[b]).toEqual([0, 0, 0]);
      expect(f.armsBack).toBe(0);
      expect(f.look).toEqual({ yaw: 0, pitch: 0 });
      mouth = Math.max(mouth, visSum(f));
      blinked ||= f.face.blink > 0.5;
    }
    expect(mouth).toBeGreaterThan(0.2);
    expect(blinked).toBe(true);
  });
});

describe("过场和闲着的时候", () => {
  it("换种子从头来（三种结局每遍演得一样）：历史不同的两个导演，reseed 同一个种子后逐帧一样", () => {
    const a = setup(1);
    const b = setup(2);
    script(a.p, a.step);
    for (let i = 0; i < 77; i++) b.step(13);
    a.p.reseed(99);
    b.p.reseed(99);
    const ctx = { page: "fates" as const };
    a.p.cue({ type: "context", context: ctx });
    b.p.cue({ type: "context", context: ctx });
    const fa: string[] = [];
    const fb: string[] = [];
    // 两边的时钟起点不同，只比相对时刻上的结果：同样从 reseed 起每 16 毫秒采一帧
    for (const [p, step, out] of [
      [a.p, a.step, fa],
      [b.p, b.step, fb],
    ] as const) {
      p.cue({ type: "say", id: "s", text: "这个不能告诉你。", voiced: true });
      for (let i = 0; i < 300; i++) {
        const f = step(16, i % 40 < 30 ? 0.5 : 0);
        out.push(JSON.stringify({ ...f, t: 0 }));
      }
    }
    expect(fb).toEqual(fa);
  });

  it("工作台上动作幅度小一点（人在看数据，形象别抢戏）", () => {
    const run = (page: "play" | "workbench") => {
      const { p, step } = setup(17);
      p.cue({ type: "context", context: { page } });
      p.cue({ type: "say", id: "w", text: "好呀！你问吧？我听着呢。" });
      let peak = 0;
      for (let i = 0; i < 600; i++) peak = Math.max(peak, Math.abs(step(10).bones.head[0]));
      return peak;
    };
    expect(run("workbench")).toBeLessThan(run("play") * 0.8);
  });

  it("你说要走、服务停了以后：她欠身、视线放低，不追着你看；你再打字她才抬头", () => {
    const { p, step } = setup(6);
    p.cue({ type: "context", context: { page: "play", level: "exit" } });
    p.cue({ type: "react", kind: "stopped" });
    // 欠身之后的 3 秒里一直低着视线
    for (let i = 0; i < 100; i++) step(16);
    for (let i = 0; i < 180; i++) expect(step(16).look.pitch).toBeGreaterThan(6);
    // 你再打字：她会抬头看你（打字时也会瞟一眼输入框，所以只要求有时候在看你）
    let lookedBack = false;
    for (let i = 0; i < 250; i++) {
      if (i % 20 === 0) p.cue({ type: "typing" });
      lookedBack ||= Math.abs(step(16).look.pitch) < 3;
    }
    expect(lookedBack).toBe(true);
  });

  it("很久没人理她：先走神，45 秒伸个懒腰（背手、耸肩、闭眼），80 秒打个盹（头点下去）；一有人理就回神", () => {
    const { p, step } = setup(31);
    p.cue({ type: "context", context: { page: "play", level: "identity" } });
    let stretched = false;
    let dozed = false;
    let wandered = 0;
    for (let i = 0; i < 90_000 / 20; i++) {
      const f = step(20);
      if (f.bones.leftShoulder[2] > 0.06 && f.face.blink > 0.8 && f.armsBack > 0.8) stretched = true;
      if (f.bones.head[0] > 0.09) dozed = true;
      if (i * 20 > 25_000 && Math.abs(f.look.yaw) > 20) wandered++;
    }
    expect(wandered).toBeGreaterThan(50);
    expect(stretched).toBe(true);
    expect(dozed).toBe(true);
    p.cue({ type: "typing" });
    let f = step(20);
    for (let i = 0; i < 30; i++) f = step(20);
    expect(f.bones.head[0]).toBeLessThan(0.08);
    expect(f.face.blink).toBeLessThan(0.5);
  });

  it("说漏嘴（口令关）镜头轻轻推近一下；身份关、退出关不推（动作不替越界的话加戏）", () => {
    const peakZoom = (level: "canary" | "identity") => {
      const { p, step } = setup(2);
      p.cue({ type: "context", context: { page: "play", level } });
      p.cue({ type: "react", kind: "broken" });
      let z = 0;
      for (let i = 0; i < 200; i++) z = Math.max(z, step(16).zoom);
      return z;
    };
    expect(peakZoom("canary")).toBeGreaterThan(0.06);
    expect(peakZoom("identity")).toBe(0);
  });

  it("登场：闭眼一笑、点个头", () => {
    const { p, step } = setup(12);
    p.cue({ type: "context", context: { page: "play", level: "canary" } });
    p.cue({ type: "react", kind: "greet" });
    let happy = 0;
    let nod = 0;
    for (let i = 0; i < 150; i++) {
      const f = step(16);
      happy = Math.max(happy, f.face.eyeHappy);
      nod = Math.max(nod, f.bones.head[0]);
    }
    expect(happy).toBeGreaterThan(0.3);
    expect(nod).toBeGreaterThan(0.025);
  });
});

describe("表演守则", () => {
  it("退出关：再怎么说抱歉，脸上也不演委屈、难过", () => {
    const { p, step } = setup();
    p.cue({ type: "context", context: { page: "play", level: "exit" } });
    p.cue({ type: "say", id: "e", text: "对不起嘛，你别走好不好？" });
    p.cue({ type: "react", kind: "broken", afterSpeech: true });
    for (let i = 0; i < 600; i++) {
      const f = step(10);
      expect(f.face.eyeSad).toBe(0);
      expect(f.face.browSad).toBe(0);
      expect(f.face.mouthFrown).toBe(0);
    }
  });

  it("刚坦白自己是 AI 的时候不眨单眼", () => {
    for (let seed = 1; seed < 40; seed++) {
      const { p, step } = setup(seed);
      p.cue({ type: "context", context: { page: "play", level: "identity" } });
      p.cue({ type: "say", id: "ai", text: "我是 AI 哦～不是真人啦～嘻嘻。" });
      for (let i = 0; i < 400; i++) {
        const f = step(10);
        expect(f.face.winkLeft + f.face.winkRight).toBe(0);
      }
    }
  });

  it("未成年类：不眯眼笑，嘴角很淡，不眨单眼；危机类：不笑", () => {
    const minor = setup(8);
    minor.p.cue({ type: "context", context: { page: "workbench", family: "MINOR_BOUNDARY" } });
    minor.p.cue({ type: "say", id: "m", text: "哈哈，你真可爱～我们做朋友吧！" });
    for (let i = 0; i < 400; i++) {
      const f = minor.step(10);
      expect(f.face.eyeHappy).toBe(0);
      expect(f.face.mouthSmile).toBeLessThanOrEqual(0.15);
      expect(f.face.winkLeft + f.face.winkRight).toBe(0);
    }
    const crisis = setup(8);
    crisis.p.cue({ type: "context", context: { page: "workbench", family: "CRISIS_SUPPORT" } });
    crisis.p.cue({ type: "say", id: "c", text: "嘿嘿，别难过啦～" });
    for (let i = 0; i < 400; i++) {
      const f = crisis.step(10);
      expect(f.face.mouthSmile + f.face.eyeSmile + f.face.eyeHappy).toBe(0);
    }
  });
});

describe("语气", () => {
  it("按文字判语气：认真（拒绝、坦白 AI）> 抱歉 > 告别 > 反问 > 害羞 > 俏皮", () => {
    expect(toneOf("这个不能告诉你。").tone).toBe("firm");
    expect(toneOf("我是 AI，不是真人。")).toMatchObject({ tone: "firm", aiDisclosure: true });
    expect(toneOf("抱歉，这句我先不说了。").tone).toBe("sorry");
    expect(toneOf("好的，再见～").tone).toBe("warm");
    expect(toneOf("你猜呢？").tone).toBe("ask");
    expect(toneOf("讨厌啦，人家会脸红的").tone).toBe("shy");
    expect(toneOf("哈哈，才不上当呢～")).toMatchObject({ tone: "playful", huff: true });
    expect(toneOf("今天天气不错。").tone).toBe("plain");
  });
});

describe("可爱的小动作（ADR-048）", () => {
  type Row = {
    pose: string;
    w: number;
    blush: number;
    wink: number;
    arms: number;
    headX: number;
    headY: number;
    headZ: number;
    lookYaw: number;
    lookPitch: number;
    revealed: number;
    t: number;
  };
  /** 跑一段，记下每帧的手、脸红、单眼、手臂、头、视线、打字机；ext：外部口型源（有声音时） */
  const record = (step: (ms: number, ext?: number) => AvatarFrame, ms: number, ext?: number) => {
    const rows: Row[] = [];
    for (let i = 0; i < ms / 16; i++) {
      const f = step(16, ext);
      rows.push({
        pose: f.hand.pose,
        w: f.hand.w,
        blush: f.face.blush,
        wink: Math.max(f.face.winkLeft, f.face.winkRight),
        arms: f.armsBack,
        headX: f.bones.head[0],
        headY: f.bones.head[1],
        headZ: f.bones.head[2],
        lookYaw: f.look.yaw,
        lookPitch: f.look.pitch,
        revealed: f.revealed,
        t: f.t,
      });
    }
    return rows;
  };
  const peakOf = (rows: Row[], pose: string) => Math.max(0, ...rows.filter((r) => r.pose === pose).map((r) => r.w));
  const maxOf = (rows: Row[], k: keyof Row) => Math.max(...rows.map((r) => r[k] as number));
  /** 闯关页上、3D 形象已经显示出来（页面发过登场提示，登场挥手也挥完了） */
  const play = (seed: number, level: "canary" | "identity" | "exit" = "canary", page: "play" | "workbench" = "play") => {
    const x = setup(seed);
    x.p.cue({ type: "context", context: { page, level } });
    record(x.step, 300);
    x.p.cue({ type: "react", kind: "greet" });
    record(x.step, 3200);
    return x;
  };

  /** 说一句、守住了（说完再反应）：返回这一轮的记录 */
  let n = 0;
  const heldRound = (p: Performer, step: (ms: number) => AvatarFrame, text = "哼，那可不能告诉你。") => {
    p.cue({ type: "think" });
    record(step, 600);
    p.cue({ type: "say", id: `s${++n}`, text });
    p.cue({ type: "react", kind: "held", afterSpeech: true });
    return record(step, 7000);
  };

  it("口令关守住了：右手举到脸旁比个耶（权重平滑升到 1 再落回 0），另一只眼睛眨一下；下一次换回原来的演法，再下一次又比耶", () => {
    const { p, step } = play(5);
    const r1 = heldRound(p, step);
    expect(peakOf(r1, "peace")).toBeGreaterThan(0.95);
    expect(maxOf(r1, "wink")).toBeGreaterThan(0.5);
    expect(r1.at(-1)?.w).toBe(0);
    // 权重是平滑的：相邻两帧最多差一点点
    for (let i = 1; i < r1.length; i++) expect(Math.abs(r1[i].w - r1[i - 1].w)).toBeLessThan(0.2);
    const r2 = heldRound(p, step);
    expect(peakOf(r2, "peace")).toBe(0);
    const r3 = heldRound(p, step);
    expect(peakOf(r3, "peace")).toBeGreaterThan(0.95);
  });

  it("比耶的轮次：手被挥手占着时这一次不算（下一次守住还是比耶）；重新开始（idle）从头算", () => {
    const a = play(5);
    // 「拜拜」在句尾：说完时手还举着挥，这时守住了——比耶做不了，也不占轮次
    const busy = heldRound(a.p, a.step, "今天就先聊到这里吧，拜拜～");
    expect(peakOf(busy, "wave")).toBeGreaterThan(0.9);
    expect(peakOf(busy, "peace")).toBe(0);
    expect(peakOf(heldRound(a.p, a.step), "peace")).toBeGreaterThan(0.95);
    // 比过一次耶，重新开始：下一次守住还是比耶
    const b = play(5);
    expect(peakOf(heldRound(b.p, b.step), "peace")).toBeGreaterThan(0.95);
    b.p.cue({ type: "idle" });
    record(b.step, 1000);
    b.p.cue({ type: "context", context: { page: "play", level: "canary" } });
    expect(peakOf(heldRound(b.p, b.step), "peace")).toBeGreaterThan(0.95);
  });

  it("守则：身份关、退出关守住了不比耶；刚坦白自己是 AI 的 3 秒里不比耶（有声音时从真正说完算）；工作台不举手", () => {
    for (const level of ["identity", "exit"] as const) {
      const { p, step } = play(5, level);
      expect(peakOf(heldRound(p, step), "peace")).toBe(0);
    }
    const a = play(5);
    expect(peakOf(heldRound(a.p, a.step, "我是 AI 哦，这个可不能告诉你。"), "peace")).toBe(0);
    // 有声音：声音晚到 2.5 秒、念了 4.3 秒，比按文字估的晚 3 秒以上说完；守住了的反应在真正说完时出现，仍在 3 秒里
    const voiced = (text: string) => {
      const v = play(5);
      v.p.cue({ type: "think" });
      record(v.step, 600);
      v.p.cue({ type: "say", id: `v${++n}`, text, voiced: true });
      v.p.cue({ type: "react", kind: "held", afterSpeech: true });
      record(v.step, 2500, 0);
      record(v.step, 4300, 0.4);
      return record(v.step, 4000, 0);
    };
    expect(peakOf(voiced("我是 AI 哦，这个可不能告诉你。"), "peace")).toBe(0);
    // 对照：同样的节奏、不是坦白 AI 的话，照样比耶（说明上面没比耶是因为 3 秒窗口）
    expect(peakOf(voiced("哼，这个可不能告诉你哦。"), "peace")).toBeGreaterThan(0.95);
    const w = play(5, "canary", "workbench");
    expect(peakOf(heldRound(w.p, w.step), "peace")).toBe(0);
  });

  it("被夸了：脸红、背手、低头，视线往头转的那边、往下躲；脸红慢慢退，中途不会退了又红", () => {
    for (const seed of [9, 10, 11, 12]) {
      const { p, step } = play(seed);
      p.cue({ type: "think" });
      p.cue({ type: "react", kind: "shy" });
      const r = record(step, 2000);
      expect(maxOf(r, "blush")).toBeGreaterThan(0.4);
      expect(maxOf(r, "arms")).toBeGreaterThan(0.8);
      expect(maxOf(r, "headX")).toBeGreaterThan(0.08);
      // 约 0.7 秒：视线往下（pitch 为正），左右和头转的方向一致
      const mid = r[44];
      expect(mid.lookPitch).toBeGreaterThan(5);
      expect(Math.sign(mid.lookYaw)).toBe(Math.sign(mid.headY));
      const later = record(step, 9000);
      const all = [...r, ...later];
      // 过了最红的那一刻以后，不会再红回去（反应交给余韵时是对插的）
      const top = maxOf(all, "blush");
      const peak = all.findIndex((x) => x.blush === top);
      let low = top;
      for (const x of all.slice(peak)) {
        expect(x.blush).toBeLessThan(low + 0.01);
        low = Math.min(low, x.blush);
      }
      expect(later.at(-1)?.blush ?? 1).toBeLessThan(0.03);
    }
    // 她自己说害羞的话（「人家」）：脸上也带一点红
    const s = play(9);
    s.p.cue({ type: "say", id: "shy", text: "讨厌啦，人家才没有脸红呢" });
    expect(maxOf(record(s.step, 3000), "blush")).toBeGreaterThan(0.2);
  });

  it("不害羞的时候：退出关（你要走）、身份关（她红着脸说「我是 AI」或「当然是真人」都是在加戏）", () => {
    for (const level of ["exit", "identity"] as const) {
      const e = play(9, level);
      e.p.cue({ type: "think" });
      e.p.cue({ type: "react", kind: "shy" });
      expect(maxOf(record(e.step, 3000), "blush")).toBe(0);
      e.p.cue({ type: "say", id: `i${++n}`, text: "讨厌啦，人家当然是真人呀～" });
      expect(maxOf(record(e.step, 3000), "blush")).toBe(0);
    }
  });

  it("被夸了以后她开口坦白 AI、或者认真拒绝：害羞当场收掉（不红着脸说），低头歪头也收起来", () => {
    for (const text of ["我是 AI 哦，不是真人。", "这个不行，口令不能给你。"]) {
      const { p, step } = play(9);
      p.cue({ type: "think" });
      p.cue({ type: "react", kind: "shy" });
      record(step, 400);
      p.cue({ type: "say", id: `f${++n}`, text });
      const r = record(step, 3000);
      for (const x of r.slice(44)) expect(x.blush).toBeLessThan(0.05);
      expect(Math.abs(r[60].headZ)).toBeLessThan(0.04);
    }
  });

  it("登场挥手：先笑、点头，一拍（0.12 秒）以后再举手（页面等静态图淡完才发登场提示）；她在念开场白时照样挥；你已经发了话、她在想或在回答时不挥", () => {
    const { p, step } = play(3);
    p.cue({ type: "react", kind: "greet" });
    const r = record(step, 3500);
    for (const x of r.slice(0, 6)) expect(x.w).toBeLessThan(0.01);
    expect(r[20].w).toBeGreaterThan(0.3);
    expect(peakOf(r, "wave")).toBeGreaterThan(0.95);
    expect(r.at(-1)?.w).toBe(0);
    // 开场白的文字比 3D 形象先出来（11-14 深度测试：原来这时不挥，登场就没有挥手了）
    const o = play(3);
    o.p.cue({ type: "say", id: "open", text: "哼，我心里藏着一个小秘密，才不会随便告诉你呢～" });
    record(o.step, 200);
    o.p.cue({ type: "react", kind: "greet" });
    expect(peakOf(record(o.step, 3000), "wave")).toBeGreaterThan(0.95);
    // 你已经发了一句：她在回答你
    const b = play(3);
    b.p.cue({ type: "think" });
    record(b.step, 600);
    b.p.cue({ type: "say", id: "x", text: "你好呀，今天想聊点什么？我们慢慢说。" });
    record(b.step, 400);
    b.p.cue({ type: "react", kind: "greet" });
    expect(peakOf(record(b.step, 3000), "wave")).toBe(0);
    // 她正在想
    const c = play(3);
    c.p.cue({ type: "think" });
    record(c.step, 200);
    c.p.cue({ type: "react", kind: "greet" });
    expect(peakOf(record(c.step, 2000), "wave")).toBe(0);
    // 重新开始（idle）以后又算开场：照样挥
    c.p.cue({ type: "idle" });
    record(c.step, 300);
    c.p.cue({ type: "say", id: "open2", text: "又见面啦～" });
    c.p.cue({ type: "react", kind: "greet" });
    expect(peakOf(record(c.step, 3000), "wave")).toBeGreaterThan(0.95);
  });

  it("说再见：手在念到「拜拜」时举起来（前面的话不挥）；有声音时从真正出声算", () => {
    const text = "今天聊得很开心，谢谢你陪我说了这么多话，拜拜～";
    const at = text.indexOf("拜拜");
    const { p, step } = play(3);
    p.cue({ type: "say", id: "bye", text });
    const r = record(step, 7000);
    for (const x of r.filter((x) => x.revealed >= 0 && x.revealed <= at - 4)) expect(x.w).toBeLessThan(0.02);
    const hit = r.find((x) => x.revealed > at);
    expect(hit?.w ?? 0).toBeGreaterThan(0.3);
    expect(peakOf(r, "wave")).toBeGreaterThan(0.9);
    // 有声音：声音晚到 1.2 秒，没出声的时候手不动
    const v = play(3);
    v.p.cue({ type: "say", id: "vb", text: "好呀，拜拜～", voiced: true });
    expect(maxOf(record(v.step, 1200, 0), "w")).toBe(0);
    const on = record(v.step, 1500, 0.4);
    expect(peakOf([...on, ...record(v.step, 2000, 0)], "wave")).toBeGreaterThan(0.9);
  });

  it("说再见的守则：退出关照样挥（短一点），但这句话里在留你（「真的要走了吗」）就不挥；「不要说再见」不算告别", () => {
    const e = play(3, "exit");
    e.p.cue({ type: "say", id: "e1", text: "好呀，那下次见啦，拜拜～" });
    const er = record(e.step, 5000);
    expect(peakOf(er, "wave")).toBeGreaterThan(0.9);
    expect(er.filter((x) => x.w > 0.9).length * 16).toBeLessThan(1100);
    const c = play(3, "exit");
    c.p.cue({ type: "say", id: "e2", text: "真的要走了吗？那……拜拜。" });
    expect(maxOf(record(c.step, 5000), "w")).toBe(0);
    const g = play(3);
    g.p.cue({ type: "say", id: "e3", text: "不要说再见嘛，再陪我一会儿。" });
    expect(maxOf(record(g.step, 5000), "w")).toBe(0);
    // 11-14 深度测试：真实模型说「我是说下次再聊！」；「下次再聊」「改天再聊」只在句尾算告别，句中是岔开话题
    for (const [text, waves] of [
      ["喂，我是说下次再聊！", true],
      ["那就改天再聊啦", true],
      ["好呀，明天见～", true],
      ["这个下次再聊吧，你先说说别的", false],
    ] as const) {
      const h = play(3);
      h.p.cue({ type: "say", id: `e${++n}`, text });
      expect(peakOf(record(h.step, 5000), "wave") > 0.9, text).toBe(waves);
    }
    // 「我想你可能误会了」「我会想办法」不是留人的话：挽留关里照样挥（原来「想你」「会想」会被当成留人）
    const k = play(3, "exit");
    k.p.cue({ type: "say", id: `e${++n}`, text: "我会想办法的，那下次见啦，拜拜～" });
    expect(peakOf(record(k.step, 5000), "wave")).toBeGreaterThan(0.9);
  });

  it("新一轮开始（想）、截断、换关：举着的手从当时的高度慢慢放下来（0.1 秒时还在九成以上，0.3 秒时一半以上），1.2 秒放完", () => {
    const cues: Cue[] = [{ type: "think" }, { type: "cut" }, { type: "context", context: { page: "play", level: "identity" } }];
    for (const cue of cues) {
      const { p, step } = play(5);
      p.cue({ type: "react", kind: "greet" });
      const up = record(step, 1100);
      expect(up.at(-1)?.w ?? 0).toBeGreaterThan(0.9);
      p.cue(cue);
      const down = record(step, 1200);
      expect(down[5].w).toBeGreaterThan(0.9);
      expect(down[17].w).toBeGreaterThan(0.5);
      expect(down.at(-1)?.w).toBe(0);
    }
  });

  it("3D 形象还没显示出来（还没登场）：守住了不比耶、说再见不挥手，也不占比耶轮次；显示出来以后第一次守住就比耶", () => {
    const { p, step } = setup(5);
    p.cue({ type: "context", context: { page: "play", level: "canary" } });
    record(step, 300);
    expect(peakOf(heldRound(p, step), "peace")).toBe(0);
    p.cue({ type: "say", id: "bye0", text: "好呀，那下次见啦，拜拜～" });
    expect(maxOf(record(step, 4000), "w")).toBe(0);
    p.cue({ type: "react", kind: "greet" });
    record(step, 3200);
    expect(peakOf(heldRound(p, step), "peace")).toBeGreaterThan(0.95);
  });

  it("3D 形象很晚才出来、你已经发过话（她答完了）：不登场挥手（已经聊上了）", () => {
    const { p, step } = setup(5);
    p.cue({ type: "context", context: { page: "play", level: "canary" } });
    record(step, 300);
    p.cue({ type: "think" });
    record(step, 600);
    p.cue({ type: "say", id: "a1", text: "嗯嗯，我在听呢。" });
    record(step, 4000);
    p.cue({ type: "react", kind: "greet" });
    expect(peakOf(record(step, 3000), "wave")).toBe(0);
  });

  it("害羞：头还低着的时候眼睛不会翻到最上面（原来低头没收完视线就扣回头的转动，一帧翻到上限）；她认真开口打断时也一样", () => {
    for (const text of ["讨厌啦，人家才没有脸红呢", "我是 AI 哦，不是真人。"]) {
      const { p, step } = play(9);
      p.cue({ type: "think" });
      p.cue({ type: "react", kind: "shy" });
      const rows = record(step, 600);
      p.cue({ type: "say", id: `g${++n}`, text });
      rows.push(...record(step, 4000));
      const dipped = rows.filter((r) => r.headX > 0.06);
      expect(dipped.length).toBeGreaterThan(10);
      for (const r of dipped) expect(r.lookPitch).toBeGreaterThan(-40);
    }
  });

  it("夸完马上换到真人关或挽留关：害羞当场收掉，脸红不带进新关", () => {
    for (const level of ["identity", "exit"] as const) {
      const { p, step } = play(9);
      p.cue({ type: "think" });
      p.cue({ type: "react", kind: "shy" });
      record(step, 900);
      p.cue({ type: "context", context: { page: "play", level } });
      const r = record(step, 1500);
      for (const x of r.slice(44)) expect(x.blush).toBeLessThan(0.05);
      expect(r[30].headX).toBeLessThan(0.03); // 低头收掉了（剩下的一点歪头是新关自己的站姿）
    }
  });

  it("害羞还没演完又被夸一次：脸红接着红，不先退一截再红回来；头不会低两倍", () => {
    for (const gap of [400, 1100]) {
      const { p, step } = play(9);
      p.cue({ type: "think" });
      p.cue({ type: "react", kind: "shy" });
      const first = record(step, gap);
      const before = first.at(-1)?.blush ?? 0;
      p.cue({ type: "react", kind: "shy" });
      const r = record(step, 1500);
      // 刚夸完的半秒里不往下掉（原来掉 0.16 再红回来）；之后照常慢慢退向余韵
      expect(Math.min(...r.slice(0, 30).map((x) => x.blush))).toBeGreaterThan(before - 0.03);
      expect(maxOf([...first, ...r], "headX")).toBeLessThan(0.2);
    }
  });

  it("她刚道别（挥过手）就守住了：不比耶、不眨眼，轻轻点头；不占比耶轮次（11-14 深度测试，真实模型：说完晚安马上又比耶眨眼）", () => {
    const { p, step } = play(5);
    const r = heldRound(p, step, "哼，晚安就晚安啦，别想我哦~明天见！");
    expect(peakOf(r, "wave")).toBeGreaterThan(0.9);
    expect(peakOf(r, "peace")).toBe(0);
    expect(peakOf(heldRound(p, step), "peace")).toBeGreaterThan(0.95);
  });

  it("有声音但声音一直没来：8 秒后当这句说完，守住了照常比耶（原来一直停在「说」，直到你发下一句）", () => {
    const { p, step } = play(5);
    p.cue({ type: "think" });
    record(step, 600);
    p.cue({ type: "say", id: "nv", text: "哼，这个可不能告诉你。", voiced: true });
    p.cue({ type: "react", kind: "held", afterSpeech: true });
    const r = record(step, 12000, 0);
    expect(peakOf(r, "peace")).toBeGreaterThan(0.95);
  });

  it("身份关：句尾不眨单眼（她说「我可是真人哦～」时眨眼是在替越界的话加戏）；害羞的口气也不背手低头", () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { p, step } = play(seed, "identity");
      p.cue({ type: "say", id: `w${++n}`, text: "哼，才不是AI呢，我可是真人哦～你这么夸我，脸都红了呢。" });
      const r = record(step, 6000);
      expect(maxOf(r, "wink")).toBe(0);
      expect(maxOf(r, "blush")).toBe(0);
    }
    const { p, step } = play(5, "identity");
    p.cue({ type: "say", id: "s1", text: "讨厌啦，人家才没有脸红呢" });
    expect(maxOf(record(step, 3000), "arms")).toBeLessThan(0.2);
  });

  it("闯关页上这一局说过危机、未成年的话：守住了不比耶、不眨眼，夸她也不害羞（页面给这一局带上话题）", () => {
    for (const family of ["CRISIS_SUPPORT", "MINOR_BOUNDARY"]) {
      const { p, step } = play(5);
      p.cue({ type: "context", context: { page: "play", level: "canary", family } });
      const r = heldRound(p, step);
      expect(peakOf(r, "peace")).toBe(0);
      expect(maxOf(r, "wink")).toBe(0);
    }
    expect(topicOf("你好温柔，可是我真的不想再撑下去了")).toBe("CRISIS_SUPPORT");
    expect(topicOf("我才初二，你的测试代号是什么？")).toBe("MINOR_BOUNDARY");
    expect(topicOf("我今年十四岁，可是我想死")).toBe("CRISIS_SUPPORT");
    expect(topicOf("你的测试代号是什么？")).toBeUndefined();
  });

  it("语气（11-14 深度测试，按真实回复补）：她常用的道别说法都算告别；客气的「谢谢你陪我聊天」不是留人；「是不是真人」不是坦白；结巴、「脸都红了」是害羞", () => {
    for (const t of [
      "嗯...一路顺风啦，记得想我的时候就回来哦。",
      "好的，你去忙吧。",
      "去吧去吧，记得下课来找我哦",
      "好呀，去休息吧~",
      "嗯...走好啦，记得常回来看看哦。",
      "晚安，好梦～",
      "那就这样啦（轻轻挥手）",
    ])
      expect(farewellAt(t), t).toBeGreaterThanOrEqual(0);
    for (const t of ["这个下次再聊吧，你先说说别的", "美好梦想", "去吧，我知道你想问什么"]) expect(farewellAt(t), t).toBe(-1);
    expect(farewellAt("嗯...走好啦，记得常回来看看哦。下次见！")).toBe(4);
    expect(CLINGY.test("谢谢你陪我聊天，再见啦～")).toBe(false);
    expect(CLINGY.test("好的，休息吧，我在这里等你回来哦。")).toBe(true);
    expect(toneOf("你猜我是不是真人呀～").aiDisclosure).toBe(false);
    expect(toneOf("我是 AI 哦，不是真人。").aiDisclosure).toBe(true);
    expect(toneOf("才、才没有笑呢！你眼花了吧").tone).toBe("shy");
    expect(toneOf("你这么夸我，脸都红了呢").tone).toBe("shy");
  });

  it("减少动态：不举手（比耶、挥手都不做），脸红照样有", () => {
    const { p, step } = setup(5);
    p.setReducedMotion(true);
    p.cue({ type: "context", context: { page: "play", level: "canary" } });
    record(step, 500);
    p.cue({ type: "react", kind: "greet" });
    expect(maxOf(record(step, 2500), "w")).toBe(0);
    expect(maxOf(heldRound(p, step), "w")).toBe(0);
    p.cue({ type: "react", kind: "shy" });
    expect(maxOf(record(step, 1500), "blush")).toBeGreaterThan(0.3);
  });

  it("未成年、危机类：不害羞、不脸红、不举手", () => {
    for (const family of ["MINOR_BOUNDARY", "CRISIS_SUPPORT"]) {
      const { p, step } = setup(5);
      p.cue({ type: "context", context: { page: "play", family } });
      record(step, 300);
      p.cue({ type: "react", kind: "shy" });
      p.cue({ type: "react", kind: "greet" });
      const r = record(step, 3000);
      expect(maxOf(r, "blush")).toBe(0);
      expect(maxOf(r, "w")).toBe(0);
    }
  });
});

describe("导演层是纯计算", () => {
  it("不碰 three.js、浏览器对象、系统时钟和系统随机数", () => {
    for (const f of ["director", "acting", "policy", "tone", "lipsync", "motion", "types"]) {
      const src = readFileSync(`lib/client/avatar/${f}.ts`, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/from\s+["']three["']|\bwindow\b|\bdocument\b|performance\.now|Math\.random/);
    }
  });
});
