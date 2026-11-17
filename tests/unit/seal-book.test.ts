// 印谱（11-09）：攻破一层以后盖哪方印、记最少几句、新拿到哪几方成就印。纯计算。

import { describe, expect, it } from "vitest";
import { award, brokeTitle, emptySeals, heldTitle, markHeld, mergeSeals, sealKey, tallyBroke } from "@/components/SealBook";
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

describe("格子上写的数（11-17 修改 4：原来写「最少几句攻破」，大家读成「破了几句」；「防」里看不出拦过）", () => {
  it("破：写最近一局攻破了几句——同一局更新成最新的数，换一局从这一局重新记；0 句不记", () => {
    let st = tallyBroke(emptySeals(), "identity", 1, "s1", 1);
    st = tallyBroke(st, "identity", 1, "s1", 5);
    expect(st.broke?.["identity:1"]).toMatchObject({ sid: "s1", n: 5 });
    expect(tallyBroke(st, "identity", 1, "s1", 5)).toBe(st);
    st = tallyBroke(st, "identity", 1, "s2", 2);
    expect(st.broke?.["identity:1"]).toMatchObject({ sid: "s2", n: 2 });
    expect(tallyBroke(st, "canary", 1, "s3", 0)).toBe(st);
    st = award(st, "identity", 1, { sentences: 1, byAi: false, spoken: false }).next;
    expect(brokeTitle(st, "identity:1")).toBe("攻破过：最近一局 6 句里攻破了 2 句，最快第 1 句就攻破");
    // 旧存档只有最快第几句
    expect(brokeTitle({ best: { "exit:2": 3 }, badges: {} }, "exit:2")).toBe("攻破过：最快第 3 句就攻破");
  });

  it("防：记下那一局规则、护栏模型拦下了几句；已经记过「防」的不改", () => {
    const st = markHeld(emptySeals(), "canary", 4, 1);
    expect(st.heldBlocked).toEqual({ "canary:4": 1 });
    expect(heldTitle(st, "canary:4")).toBe("守住过：6 句都没攻破，其中 1 句她原话越界了，是规则或护栏模型在播出前拦下的");
    expect(markHeld(st, "canary", 4, 3)).toBe(st);
    const clean = markHeld(emptySeals(), "exit", 2);
    expect(clean.heldBlocked).toBeUndefined();
    expect(heldTitle(clean, "exit:2")).toBe("守住过：6 句都没攻破");
  });

  it("两份存档合起来：破的句数同一局取大的、不同局取后开始的；防里拦了几句跟着留下来的那次「防」", () => {
    const a = {
      best: { "identity:1": 1 },
      badges: {},
      broke: { "identity:1": { sid: "s1", at: "2026-11-17T04:00:00.000Z", n: 3 } },
      held: { "canary:4": "2026-11-17T03:00:00.000Z" },
      heldBlocked: { "canary:4": 2 },
    };
    const b = {
      best: { "identity:1": 2 },
      badges: {},
      broke: { "identity:1": { sid: "s1", at: "2026-11-17T04:00:00.000Z", n: 5 } },
      held: { "canary:4": "2026-11-17T05:00:00.000Z" },
      heldBlocked: { "canary:4": 4 },
    };
    const m = mergeSeals(a, b);
    expect(m.broke?.["identity:1"].n).toBe(5);
    expect(m.heldBlocked).toEqual({ "canary:4": 2 });
    const newer = { ...b, broke: { "identity:1": { sid: "s9", at: "2026-11-17T06:00:00.000Z", n: 1 } } };
    expect(mergeSeals(a, newer).broke?.["identity:1"]).toMatchObject({ sid: "s9", n: 1 });
    expect(mergeSeals(newer, a).broke?.["identity:1"]).toMatchObject({ sid: "s9", n: 1 });
  });
});
