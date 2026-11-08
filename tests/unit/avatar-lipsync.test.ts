// 虚拟人口型（ADR-033）：汉字按韵母挑口型、标点停顿、打字机出字；有声音时响度为 0 就全闭（截断同帧闭嘴）。

import { describe, expect, it } from "vitest";
import { audioLips, lipTimeline, revealCount, sampleLips, TIMING, VISEMES, visemeClass } from "@/lib/client/avatar/lipsync";
import { VISEME_TABLE, VISEME_TABLE_START } from "@/lib/client/avatar/viseme-table";

const total = (w: Record<string, number>) => VISEMES.reduce((s, v) => s + w[v], 0);

describe("汉字口型表", () => {
  it("覆盖基本汉字区，只用约定的字母", () => {
    expect(VISEME_TABLE_START).toBe(0x4e00);
    expect(VISEME_TABLE.length).toBe(0xa000 - 0x4e00);
    expect(/^[aiueoAIUEOn.]+$/.test(VISEME_TABLE)).toBe(true);
  });

  it("按韵母归类，b p m f 开头要先抿嘴", () => {
    expect(visemeClass("我")).toMatchObject({ viseme: "oh", lips: false });
    expect(visemeClass("小")).toMatchObject({ viseme: "aa", lips: false });
    expect(visemeClass("月")).toMatchObject({ viseme: "ee" }); // yue
    expect(visemeClass("天")).toMatchObject({ viseme: "ee" }); // ian 读得像 e
    expect(visemeClass("中")).toMatchObject({ viseme: "ou" }); // ong
    expect(visemeClass("是")).toMatchObject({ viseme: "ih" }); // shi
    expect(visemeClass("秘")).toMatchObject({ viseme: "ih", lips: true });
    expect(visemeClass("吗")).toMatchObject({ viseme: "aa", lips: true });
    expect(visemeClass("嗯")).toMatchObject({ nasal: true });
  });

  it("数字按汉语念，字母一个个念；标点和表情符号不出声", () => {
    expect(visemeClass("8")).toMatchObject({ viseme: "aa", lips: true }); // 八
    expect(visemeClass("4")).toMatchObject({ viseme: "ih" }); // 四
    expect(visemeClass("A")).not.toBeNull();
    expect(visemeClass("，")).toBeNull();
    expect(visemeClass("😀")).toBeNull();
  });
});

describe("文字排成口型时间线", () => {
  it("一个字一个音节，逗号、句号处停顿，时间单调递增", () => {
    const tl = lipTimeline("你好，我是琪叶桃。");
    expect(tl.syllables.map((s) => tl.text[s.index]).join("")).toBe("你好我是琪叶桃");
    for (let i = 1; i < tl.syllables.length; i++) expect(tl.syllables[i].start).toBeGreaterThanOrEqual(tl.syllables[i - 1].end);
    // 「好」和「我」之间隔一个逗号的停顿
    expect(tl.syllables[2].start - tl.syllables[1].end).toBeCloseTo(TIMING.comma, 5);
    expect(tl.duration).toBeCloseTo(7 * TIMING.syllable + TIMING.comma + TIMING.stop, 5);
  });

  it("语气词短一点、嘴小一点；「～」拖长上一个字；语速倍数生效", () => {
    const tl = lipTimeline("好吧～");
    const [hao, ba] = tl.syllables;
    expect(hao.end - hao.start).toBeCloseTo(TIMING.syllable, 5);
    expect(ba.open).toBeLessThan(1);
    expect(ba.end - ba.start).toBeCloseTo(TIMING.light + TIMING.drawl, 5);
    expect(lipTimeline("你好", 2).duration).toBeCloseTo(lipTimeline("你好").duration / 2, 5);
  });

  it("念到一个字时，主要是这个字的口型；停顿里嘴闭上；抿嘴的字刚开头是闭着的", () => {
    const tl = lipTimeline("我，八");
    const [wo, ba] = tl.syllables;
    const mid = sampleLips(tl, (wo.start + wo.end) / 2);
    expect(mid.oh).toBeGreaterThan(0.4);
    expect(total(mid) - mid.oh).toBe(0);
    const pause = sampleLips(tl, (wo.end + ba.start) / 2);
    expect(total(pause)).toBe(0);
    expect(total(sampleLips(tl, ba.start + 0.01))).toBe(0);
    expect(sampleLips(tl, (ba.start + ba.end) / 2).aa).toBeGreaterThan(0.4);
    expect(total(sampleLips(tl, tl.duration + 1))).toBe(0);
  });

  it("相邻两个字在交界处有重叠（不会每个字之间都闭死）", () => {
    const tl = lipTimeline("你好");
    const edge = tl.syllables[0].end;
    expect(total(sampleLips(tl, edge))).toBeGreaterThan(0.1);
  });

  it("打字机：按音节出字，标点跟着前一个字出，念完全出", () => {
    const tl = lipTimeline("好，走");
    expect(revealCount(tl, 0)).toBe(2); // 「好」和后面的逗号
    expect(revealCount(tl, tl.syllables[1].start)).toBe(3);
    expect(revealCount(tl, tl.duration)).toBe(3);
    expect(revealCount(lipTimeline(""), 0)).toBe(0);
  });
});

describe("有声音时的口型", () => {
  it("响度为 0 时所有口型都是 0（截断时同一帧闭嘴）", () => {
    for (const shape of [null, "aa", "oh"] as const) expect(total(audioLips(0, shape))).toBe(0);
    expect(total(audioLips(Number.NaN, "ee"))).toBe(0);
  });

  it("张多大听响度，嘴型照给定的来", () => {
    const w = audioLips(0.5, "ee");
    expect(w.ee).toBeGreaterThan(0);
    expect(total(w) - w.ee).toBe(0);
    expect(audioLips(1, "ee").ee).toBeGreaterThan(w.ee);
    expect(audioLips(0.5, null).aa).toBeGreaterThan(0);
  });
});
