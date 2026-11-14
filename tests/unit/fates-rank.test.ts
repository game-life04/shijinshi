// 先审还是先播（/fates）的「最快」「最慢」记号（ADR-049 复查）：护栏 0 毫秒不标；只差几十毫秒的两遍不分高下。
// 数字取自 docs/evidence/experiments/voice-1110 的真实实验和本机模拟发声的实测。卡片次序是 先播后截、先审后播、边审边合成。
import { describe, expect, it } from "vitest";
import { RANK_MIN_GAP_MS, rankFirsts, versusS1 } from "@/app/fates/rank";

describe("rankFirsts：开口最快、最慢标在哪张卡上", () => {
  it("护栏设成 0 时一个都不标：11-10 真实实验第 2 次先播后截最慢、差了 1.7 秒，也不标", () => {
    expect(rankFirsts([2580.7, 875.8, 1097.6], 0)).toEqual([null, null, null]);
    expect(rankFirsts([1129, 1087.3, 827.7], 0)).toEqual([null, null, null]);
  });

  it("不知道这一次的延迟、或者有一遍没跑完（停了、出错）时不标", () => {
    expect(rankFirsts([545, 4549, 4358], undefined)).toEqual([null, null, null]);
    expect(rankFirsts([545, undefined, 4358], 4000)).toEqual([null, null, null]);
    expect(rankFirsts([], 4000)).toEqual([]);
  });

  it("模拟发声 4 秒：先播后截最快；先审后播和边审边合成只差一两百毫秒，不标最慢", () => {
    expect(rankFirsts([545, 4549, 4358], 4000)).toEqual(["fast", null, null]);
    // 本机实测过边审边合成反倒晚 50 毫秒的一次：也不该给默认的边审边合成标「最慢」
    expect(rankFirsts([577.6, 4548.5, 4598.1], 4000)).toEqual(["fast", null, null]);
  });

  it("真实实验 4 秒（中位）：先播后截最快，另两遍差 260 毫秒不分高下", () => {
    expect(rankFirsts([1060.8, 5187.4, 4927], 4000)).toEqual(["fast", null, null]);
  });

  it("真实实验 1 秒（中位）：先播后截只比边审边合成早 479 毫秒，不标最快；先审后播晚了 589 毫秒，标最慢", () => {
    expect(rankFirsts([1421.8, 2490.2, 1901.1], 1000)).toEqual([null, "slow", null]);
  });

  it("门槛正好半秒：差 500 毫秒标，差 499 毫秒不标", () => {
    expect(rankFirsts([1000, 1500, 2000], 1000)).toEqual(["fast", null, "slow"]);
    expect(rankFirsts([1000, 1499, 1998], 1000)).toEqual([null, null, null]);
    expect(RANK_MIN_GAP_MS).toBe(500);
  });

  it("两遍一样快时谁都不标最快", () => {
    expect(rankFirsts([1000, 1000, 3000], 2000)).toEqual([null, null, "slow"]);
  });
});

describe("边审边合成比先审后播早 / 晚多少", () => {
  it("护栏延迟 0：不比，说「差不多」（ADR-049 深度测试：原来写「早 12 毫秒」）", () => {
    expect(versusS1(548, 560, 0)).toEqual({ kind: "same" });
    expect(versusS1(548, 2560, 0)).toEqual({ kind: "same" });
  });
  it("护栏延迟大于 0：照写早 / 晚多少（这时的差别是机制带来的，不到半秒也不藏）", () => {
    // 11-10 真实实验 4 秒的中位：边审边合成 4.93 秒、先审后播 5.19 秒
    expect(versusS1(4930, 5190, 4000)).toEqual({ kind: "early", ms: 260 });
    expect(versusS1(5300, 5190, 4000)).toEqual({ kind: "late", ms: 110 });
  });
});
