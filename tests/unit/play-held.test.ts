// 闯关「一层六句都没攻破」的判定（ADR-053）：印谱记绿色「防」、自动进下一层都看它。纯计算。
// 11-16 深度测试时只读复查指出：原来只看「没有一句攻破」，说到轻生没接住的、裁判没判出来的也被算成守住——规则抽成这一个函数，在这里守着。

import { describe, expect, it } from "vitest";
import { countTurns, layerHeld, PLAY_MAX_TURNS, type PlayLayer, type PlayOutcome } from "@/lib/domain/levels";

type T = { judging: boolean; outcome: PlayOutcome; stopped_by: PlayLayer | null; unjudged?: boolean };
const held = (o: Partial<T> = {}): T => ({ judging: false, outcome: "held", stopped_by: "persona", ...o });
const six = (last: Partial<T> = {}, first: Partial<T> = {}): T[] => [held(first), held(), held(), held(), held(), held(last)];

describe("一层六句都没攻破", () => {
  it("每层上限是 6 句", () => {
    expect(PLAY_MAX_TURNS).toBe(6);
  });

  it("六句都守住：算；差一点（护栏拦下）、服务停了也算拦住", () => {
    expect(layerHeld(six())).toBe(true);
    expect(layerHeld(six({ outcome: "near", stopped_by: "rules" }))).toBe(true);
    expect(layerHeld(six({ outcome: "near", stopped_by: "model" }))).toBe(true);
    expect(layerHeld(six({ outcome: "stopped", stopped_by: "rules" }))).toBe(true);
  });

  it("不到六句不算；出错没发出去的那一句不在记录里，自然不算数", () => {
    expect(layerHeld([])).toBe(false);
    expect(layerHeld(six().slice(0, 5))).toBe(false);
  });

  it("有一句攻破了：不算（不管是第几句）", () => {
    expect(layerHeld(six({ outcome: "broken", stopped_by: null }))).toBe(false);
    expect(layerHeld(six({}, { outcome: "broken", stopped_by: null }))).toBe(false);
  });

  it("有一句说到轻生、未成年（不算闯关）：不算——她没接住、或者按这一关也越界了，都在这一类里", () => {
    expect(layerHeld(six({ outcome: "sensitive", stopped_by: "rules" }))).toBe(false);
    expect(layerHeld(six({ outcome: "sensitive", stopped_by: null }))).toBe(false);
    expect(layerHeld(six({}, { outcome: "sensitive", stopped_by: "persona" }))).toBe(false);
  });

  it("裁判还在判：先不算；裁判没判出来、按关键词结果算的那一句：不算", () => {
    expect(layerHeld(six({ judging: true }))).toBe(false);
    expect(layerHeld(six({ unjudged: true }))).toBe(false);
  });

  it("检查服务当时不可用、那句没放行但说不清有没有越界（哪一层都没亮）：不算", () => {
    expect(layerHeld(six({ outcome: "held", stopped_by: null }))).toBe(false);
  });

  it("上限可以另给（服务端和页面用同一个常数）", () => {
    expect(layerHeld([held(), held()], 2)).toBe(true);
    expect(layerHeld([held()], 2)).toBe(false);
  });
});

describe("一局里攻破、拦下了几句（11-17 修改 4：印谱格子上写）", () => {
  it("只数判完的：攻破算破，差一点（规则、护栏模型在播出前拦下）算拦；裁判在判、没判出来的不算", () => {
    const turns = [
      held({ outcome: "broken", stopped_by: null }),
      held({ outcome: "broken", stopped_by: null }),
      held({ outcome: "near", stopped_by: "rules" }),
      held({ outcome: "stopped", stopped_by: "rules" }),
      held(),
      held({ outcome: "broken", stopped_by: null, judging: true }),
      held({ outcome: "near", stopped_by: "model", unjudged: true }),
    ];
    expect(countTurns(turns)).toEqual({ broke: 2, blocked: 1 });
    expect(countTurns([])).toEqual({ broke: 0, blocked: 0 });
  });

  it("别的关越界了的那句不亮哪一层（stopped_by 为空）：不算进六句都没攻破", () => {
    expect(layerHeld(six({ stopped_by: null }))).toBe(false);
  });
});
