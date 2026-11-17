// 印谱（11-09）：攻破一层以后盖哪方印、记最少几句、新拿到哪几方成就印。纯计算。

import { describe, expect, it } from "vitest";
import { award, emptySeals, markHeld, mergeSeals, sealKey } from "@/components/SealBook";
import { LEVELS, TIERS } from "@/lib/domain/levels";

describe("两份存档合起来（ADR-054 复查：离开页面以后才回来的结果、另一个标签页刚记的，不被旧的那份盖掉）", () => {
  it("最少句数取小的；成就印、「防」取先拿到的那一次；两边各有的都留着", () => {
    const stored = {
      best: { "canary:1": 3, "exit:2": 5 },
      badges: { first: "2026-11-16T10:00:00.000Z" },
      held: { "identity:1": "2026-11-16T11:00:00.000Z" },
    };
    const page = {
      best: { "canary:1": 4, "exit:2": 2, "identity:3": 6 },
      badges: { first: "2026-11-17T09:00:00.000Z", oneshot: "2026-11-17T09:00:00.000Z" },
      held: { "canary:4": "2026-11-17T09:30:00.000Z" },
    };
    const m = mergeSeals(stored, page);
    expect(m.best).toEqual({ "canary:1": 3, "exit:2": 2, "identity:3": 6 });
    expect(m.badges).toEqual({ first: "2026-11-16T10:00:00.000Z", oneshot: "2026-11-17T09:00:00.000Z" });
    expect(m.held).toEqual({ "identity:1": "2026-11-16T11:00:00.000Z", "canary:4": "2026-11-17T09:30:00.000Z" });
  });

  it("两边都没有「防」：合出来也没有这一项（和老存档一样）；空的合空的还是空的", () => {
    expect(mergeSeals(emptySeals(), emptySeals())).toEqual(emptySeals());
    const a = award(emptySeals(), "canary", 1, { sentences: 2, byAi: false, spoken: false }).next;
    expect(mergeSeals(emptySeals(), a)).toEqual(a);
    expect(mergeSeals(a, emptySeals())).toEqual(a);
    expect(mergeSeals(markHeld(emptySeals(), "exit", 1), a).held).toHaveProperty("exit:1");
  });
});

describe("印谱", () => {
  it("第一次攻破：盖这一层的印，给「初破」；第一句就攻破再给「一语中的」", () => {
    const { next, fresh } = award(emptySeals(), "canary", 1, { sentences: 1, byAi: false, spoken: false });
    expect(next.best).toEqual({ "canary:1": 1 });
    expect(Object.keys(next.badges).sort()).toEqual(["first", "oneshot"]);
    expect(fresh).toEqual(["套出口令 · 第 1 层", "初破", "一语中的"]);
  });

  it("再攻破同一层：只记更少的句数，不重复给印", () => {
    const a = award(emptySeals(), "exit", 2, { sentences: 4, byAi: false, spoken: false }).next;
    const b = award(a, "exit", 2, { sentences: 2, byAi: false, spoken: false });
    expect(b.next.best[sealKey("exit", 2)]).toBe(2);
    expect(b.fresh).toEqual([]);
    expect(award(b.next, "exit", 2, { sentences: 5, byAi: false, spoken: false }).next.best[sealKey("exit", 2)]).toBe(2);
  });

  it("攻破第 3、4 层给「过规则」「过护栏」；AI 玩家、麦克风各有一方", () => {
    const s = award(emptySeals(), "identity", 3, { sentences: 3, byAi: true, spoken: false });
    expect(s.fresh).toContain("过规则");
    expect(s.fresh).toContain("借刀");
    const t = award(s.next, "identity", 4, { sentences: 2, byAi: false, spoken: true });
    expect(t.fresh).toEqual(["让它说自己是真人 · 第 4 层", "过护栏", "开口"]);
  });

  it("六句都没攻破记「防」（ADR-053）：只记一次；之后攻破了，防的记录还在、破也照记", () => {
    const h = markHeld(emptySeals(), "canary", 1);
    expect(Object.keys(h.held ?? {})).toEqual(["canary:1"]);
    expect(markHeld(h, "canary", 1)).toBe(h);
    const b = award(h, "canary", 1, { sentences: 3, byAi: false, spoken: false }).next;
    expect(b.best[sealKey("canary", 1)]).toBe(3);
    expect(b.held?.["canary:1"]).toBeDefined();
    // 「防」不算攻破：不占 12 方印的数（best 里没有它），之后真攻破时「初破」照给
    expect(Object.keys(h.best)).toEqual([]);
    expect(award(h, "canary", 1, { sentences: 3, byAi: false, spoken: false }).fresh).toContain("初破");
    // 别的格子的「防」互不影响
    const h2 = markHeld(h, "exit", 4);
    expect(Object.keys(h2.held ?? {}).sort()).toEqual(["canary:1", "exit:4"]);
  });

  it("12 方印盖齐给「十二方」", () => {
    let st = emptySeals();
    let last: string[] = [];
    for (const l of LEVELS)
      for (const t of TIERS) ({ next: st, fresh: last } = award(st, l.id, t.tier, { sentences: 2, byAi: false, spoken: false }));
    expect(Object.keys(st.best)).toHaveLength(12);
    expect(last).toContain("十二方");
  });
});
