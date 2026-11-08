// 虚拟人导演层（ADR-033）：同一个种子 + 同一串提示逐帧完全一样；有外部口型源时截断那一帧五个口型都是 0；
// 眨眼频率像真人；眨眼时眼部表情让位；骨骼不超限；减少动态时身体不动、嘴和眨眼照常；表演守则；导演层不碰浏览器和 three.js。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QIYETAO } from "@/lib/client/avatar/acting";
import { createPerformer } from "@/lib/client/avatar/director";
import { rng } from "@/lib/client/avatar/motion";
import { toneOf } from "@/lib/client/avatar/tone";
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
