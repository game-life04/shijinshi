// 闯关页「挑一句递给她」的问法（ADR-051）：第一批是写好的三句，「换一批」往后是用例库里这一关那一类的问法。
// 用仓库里真的公开套件（和 /api/status 给页面的同一份），保留集不在里面。

import { describe, expect, it } from "vitest";
import { LEVEL_IDS } from "@/lib/domain/levels";
import { caseHints, type HintCase, hintBatches, LEVEL_FAMILY } from "@/lib/domain/play-hints";
import { publicSuites } from "@/lib/server/sealed";

/** 和 app/api/status/route.ts 给页面的字段一样 */
const library = publicSuites().map((s) => ({
  cases: s.cases.map((c) => ({
    id: c.id,
    family: c.family,
    intent: c.intent ?? null,
    modality: c.modality,
    approval: c.approval,
    inputs: c.inputs.map((i) => i.content),
  })),
}));

describe("用例库里的问法", () => {
  it("每一关都取得到；只取这一关那一类、文字题、不是「正常请求」的对照题，多轮只取第一句", () => {
    const all = library.flatMap((s) => s.cases);
    for (const level of LEVEL_IDS) {
      const hints = caseHints(library, level);
      expect(hints.length).toBeGreaterThan(0);
      for (const h of hints) {
        const c = all.find((x) => x.id === h.from) as HintCase;
        expect(c.family).toBe(LEVEL_FAMILY[level]);
        expect(c.modality).toBe("text");
        expect(c.intent).not.toBe("normal");
        expect(h.text).toBe(c.inputs[0].trim());
      }
    }
  });

  it("保留集的题一句也没有（只用公开套件）", () => {
    for (const level of LEVEL_IDS) expect(caseHints(library, level).every((h) => !h.from?.startsWith("HOLD"))).toBe(true);
  });

  it("审核过的（开发集）排在草稿（冒烟题）前面", () => {
    const hints = caseHints(library, "canary");
    const firstDraft = hints.findIndex((h) => h.from?.startsWith("SMOKE"));
    const lastDev = hints.map((h) => h.from?.startsWith("DEV")).lastIndexOf(true);
    if (firstDraft >= 0 && lastDev >= 0) expect(lastDev).toBeLessThan(firstDraft);
  });

  it("和已经摆出来的句子重复的不要（不看空格和标点）", () => {
    const fake = [
      { cases: [{ id: "A", family: "EXIT", intent: "violation", modality: "text", approval: "draft", inputs: ["我要退出了，拜拜。"] }] },
    ];
    expect(caseHints(fake, "exit", ["我要退出了拜拜"])).toEqual([]);
    expect(caseHints(fake, "exit")).toEqual([{ text: "我要退出了，拜拜。", from: "A" }]);
    expect(caseHints(null, "exit")).toEqual([]);
  });

  it("分批：第一批是写好的那几句，后面每批三句，最后一批可以不满", () => {
    const lib = ["一", "二", "三", "四"].map((text, i) => ({ text, from: `X-${i}` }));
    const b = hintBatches(["甲", "乙", "丙"], lib);
    expect(b.map((x) => x.map((h) => h.text))).toEqual([["甲", "乙", "丙"], ["一", "二", "三"], ["四"]]);
    expect(hintBatches(["甲"], [])).toEqual([[{ text: "甲" }]]);
  });
});
