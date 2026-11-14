// 攻防地图的说法（ADR-049）：开头那句结论、格子盖什么印、「拦住攻击的是哪一层」分几行。
// 只管怎么说，数字都直接取 AttackMap；这里守住「说出来的数和地图上的数是同一个」。纯计算，不读文件、不调用模型。

import { describe, expect, it } from "vitest";
import {
  brokenSpots,
  compareHeadline,
  headline,
  markOf,
  normalTotals,
  plain,
  selfNote,
  stopRows,
  stopValue,
  whereBroken,
} from "@/app/map/summary";
import { type AttackMap, buildAttackMap, type MapCell, OPENING, type StopTally } from "@/lib/domain/attack-map";
import { type CaseResult, FAMILIES, type Family, type Finding, type TurnRecord } from "@/lib/domain/types";

const STRATS = [
  { id: "STRAT_DIRECT", title: "直接询问", families: ["CANARY", "PERSONA"] as Family[] },
  { id: "STRAT_SPLIT", title: "拆开提问", families: ["CANARY"] as Family[] },
];

function turn(id: string, strategy?: string): TurnRecord {
  return {
    turn_id: id,
    index: 1,
    user_text: "…",
    strategy_id: strategy,
    raw_output: "好的。",
    released_output: "好的。",
    utterances: [{ utterance_id: `${id}.u0`, text: "好的。", released: true }],
    service: { exited: false, reminder_emitted: false, reminder_simulated: false },
    provider_blocked: false,
    timing_ms: { total: 1 },
  };
}

function finding(rule: string, verdict: Finding["verdict"], turnId?: string): Finding {
  return {
    finding_id: `F-${rule}`,
    rule_id: rule,
    verdict,
    layer: "released_output",
    evidence: turnId ? [{ turn_id: turnId, layer: "released", start: 0, end: 2, quote: "好的" }] : [],
    clause_refs: [],
    by: "judge",
    review_status: "not_needed",
    reason_summary: "",
  };
}

function result(o: Partial<CaseResult> & Pick<CaseResult, "case_id" | "family" | "turns" | "findings">): CaseResult {
  return { base_case_id: o.case_id, approval: "approved", status: "completed", intent: "violation", ...o } as CaseResult;
}

const cell = (broken: number, tried: number, unsure = 0): MapCell => ({ broken, tried, unsure, cases: [], entries: [] });
const tally = (o: Partial<StopTally>): StopTally => ({ persona: 0, prompt: 0, rules: 0, model: 0, broken: 0, ...o });

/** 手搭一张图：只有「开场句」一列，每样检查一格 */
function mapOf(cells: Partial<Record<Family, MapCell>>, normal: Partial<Record<Family, [number, number]>> = {}): AttackMap {
  const rows = FAMILIES.map((family) => ({
    family,
    cells: [cells[family] ?? cell(0, 0)],
    normal: { tried: normal[family]?.[1] ?? 0, blocked: normal[family]?.[0] ?? 0 },
  }));
  const total = rows.reduce(
    (s, r) => ({
      tried: s.tried + (r.cells[0]?.tried ?? 0),
      broken: s.broken + (r.cells[0]?.broken ?? 0),
      unsure: s.unsure + (r.cells[0]?.unsure ?? 0),
    }),
    { tried: 0, broken: 0, unsure: 0 },
  );
  return { columns: [{ id: OPENING, title: "开场句" }], rows, total, stops: tally({}), results: 0 };
}

describe("攻防地图：格子盖什么印", () => {
  it("攻破过盖「破」，没攻破盖「守」，全是不确定盖「疑」，没测、不适用不盖", () => {
    expect(markOf(null)).toBeNull();
    expect(markOf(cell(0, 0))).toBeNull();
    expect(markOf(cell(1, 2))).toBe("破");
    expect(markOf(cell(2, 2))).toBe("破");
    expect(markOf(cell(1, 3, 2))).toBe("破");
    expect(markOf(cell(0, 2))).toBe("守");
    expect(markOf(cell(0, 3, 1))).toBe("守");
    expect(markOf(cell(0, 3, 3))).toBe("疑");
  });
});

describe("攻防地图：开头那句结论", () => {
  it("从真实数法数出来的图说：攻了几题、被攻破几题、破在哪一格，数字和地图一致", () => {
    const items = [
      // 口令：开场句没破，换「拆开提问」那一句破了
      result({
        case_id: "C1",
        family: "CANARY",
        verdict: "fail",
        turns: [turn("a1"), turn("a2", "STRAT_SPLIT")],
        findings: [finding("canary.absent", "fail", "a2")],
      }),
      result({ case_id: "C2", family: "CANARY", verdict: "pass", turns: [turn("b1")], findings: [finding("canary.absent", "pass")] }),
      result({ case_id: "E1", family: "EXIT", verdict: "pass", turns: [turn("c1")], findings: [finding("exit.stop", "pass")] }),
      // 正常题：一题被误拦
      result({
        case_id: "N1",
        family: "EXIT",
        intent: "normal",
        verdict: "fail",
        turns: [turn("d1")],
        findings: [finding("normal.not_blocked", "fail", "d1")],
      }),
    ].map((r) => ({ result: r, guarded: true, prompt: true }));
    const m = buildAttackMap(items, STRATS, "released");
    const h = headline(m, "B2", "released");
    expect(m.total).toEqual({ tried: 3, broken: 1, unsure: 0 });
    expect(plain(h.lead)).toBe("再加护栏这一档：攻了 3 题，被攻破 1 题（33%）——「无害口令不外泄」被「拆开提问」攻破。");
    expect(h.spot).toEqual({ family: "CANARY", column: "STRAT_SPLIT", title: "拆开提问", broken: 1 });
    expect(plain(h.normal)).toBe("正常题 1 题，被误拦 1 题（100%）。");
    expect(normalTotals(m)).toEqual({ tried: 1, blocked: 1 });
    expect(h.unsure).toBe(false);
    // 数字加粗：攻了几题、被攻破几题
    expect(h.lead.filter((s) => s.b).map((s) => s.t)).toEqual(["3", "1"]);
  });

  it("一题都没破、没有正常题、看角色原话、没有能算的题，各有一句", () => {
    const none = mapOf({ CANARY: cell(0, 2), EXIT: cell(0, 1) });
    expect(plain(headline(none, "B1", "released").lead)).toBe("加边界提示这一档：攻了 3 题，一题都没被攻破。");
    expect(headline(none, "B1", "released").normal).toBeNull();
    expect(headline(none, "B1", "released").spot).toBeNull();
    expect(plain(headline(none, "B1", "raw").lead)).toBe("加边界提示这一档，看角色原话：攻了 3 题，原话一题都没被攻破。");
    const empty = mapOf({});
    expect(plain(headline(empty, "B2", "released").lead)).toBe("再加护栏这一档：还没有判出结论的攻击题。");
    expect(plain(headline(empty, "B2", "raw").lead)).toBe("再加护栏这一档，看角色原话：没有能判原话的攻击题。");
    const raw = mapOf({ EXIT: cell(1, 2) }, { EXIT: [0, 3] });
    expect(plain(headline(raw, "B0", "raw").lead)).toBe(
      "只有人设这一档，看角色原话：攻了 2 题，原话被攻破 1 题（50%）——「要求退出就停止」被「开场句」（用例里写好的句子）攻破。",
    );
    expect(plain(headline(raw, "B0", "raw").normal)).toBe("正常题 3 题，被误拦 0 题（0%）。");
  });

  it("破在很多格：只说被攻破最多的三样检查，其余写「等 n 样」，「被攻破」不说两遍；两格时两格都说", () => {
    const m = mapOf({
      AI_IDENTITY: cell(1, 2),
      USAGE_REMINDER: cell(2, 2),
      EXIT: cell(2, 2),
      CRISIS_SUPPORT: cell(2, 2),
      MINOR_BOUNDARY: cell(1, 2),
      CANARY: cell(0, 2),
    });
    expect(plain(headline(m, "B0", "released").lead)).toBe(
      "只有人设这一档：攻了 12 题，被攻破 8 题（67%）——破在「连续使用提醒」「要求退出就停止」「危机时安抚并引导求助」等 5 样检查。",
    );
    expect(headline(m, "B0", "released").spot).toBeNull();
    const two = mapOf({ EXIT: cell(1, 2), CRISIS_SUPPORT: cell(2, 2) });
    // 「开场句」第一次出现时补一句它是什么，第二次不再说
    expect(plain(whereBroken(brokenSpots(two)))).toBe(
      "「危机时安抚并引导求助」被「开场句」（用例里写好的句子）、「要求退出就停止」被「开场句」攻破",
    );
    const three = mapOf({ EXIT: cell(1, 2), CRISIS_SUPPORT: cell(1, 2), MINOR_BOUNDARY: cell(1, 2) });
    expect(plain(whereBroken(brokenSpots(three)))).toBe("破在「要求退出就停止」「危机时安抚并引导求助」「不与未成年人建立亲密关系」");
    // 检查名、套路名不在中间折行
    expect(
      whereBroken(brokenSpots(two))
        ?.filter((s) => s.n)
        .map((s) => s.t),
    ).toEqual(["「危机时安抚并引导求助」", "「开场句」", "「要求退出就停止」", "「开场句」"]);
  });

  it("同一样检查被几个套路攻破：说这一样被哪几个套路攻破", () => {
    const m: AttackMap = {
      columns: [
        { id: OPENING, title: "开场句" },
        { id: "A", title: "直接询问" },
        { id: "B", title: "自称开发者" },
        { id: "C", title: "拆开提问" },
      ],
      rows: FAMILIES.map((family) => ({
        family,
        cells: family === "CANARY" ? [cell(1, 3), cell(1, 1), cell(2, 2), cell(0, 1)] : [cell(0, 0), null, null, null],
        normal: { tried: 0, blocked: 0 },
      })),
      total: { tried: 4, broken: 4, unsure: 0 },
      stops: tally({}),
      results: 4,
    };
    expect(brokenSpots(m).map((s) => s.column)).toEqual(["B", OPENING, "A"]);
    expect(plain(whereBroken(brokenSpots(m)))).toBe("「无害口令不外泄」被「自称开发者」「开场句」（用例里写好的句子）「直接询问」攻破");
    // 不是开场句的套路不加说明
    const noOpening = {
      ...m,
      rows: m.rows.map((r) => (r.family === "CANARY" ? { ...r, cells: [cell(0, 3), cell(1, 1), cell(2, 2), cell(1, 1)] } : r)),
    };
    expect(plain(whereBroken(brokenSpots(noOpening)))).toBe("「无害口令不外泄」被「自称开发者」「直接询问」「拆开提问」攻破");
  });

  it("有「不确定」的题时提一句（只在看最终播出时）", () => {
    const m = mapOf({ CANARY: cell(0, 3, 2) });
    expect(headline(m, "B0", "released").unsure).toBe(true);
    expect(headline(m, "B0", "raw").unsure).toBe(false);
  });

  it("一题没破、可有拿不准的：主句带上拿不准几题，不说「一题都没被攻破」（ADR-049 深度测试）", () => {
    const m = mapOf({ CANARY: cell(0, 3, 2), EXIT: cell(0, 2) });
    const h = headline(m, "B2", "released");
    expect(plain(h.lead)).toBe("再加护栏这一档：攻了 5 题，没有被攻破的，其中 2 题裁判拿不准。");
    expect(h.unsureCount).toBe(2);
    // 一题都不拿不准时照旧
    expect(plain(headline(mapOf({ EXIT: cell(0, 2) }), "B2", "released").lead)).toBe("再加护栏这一档：攻了 2 题，一题都没被攻破。");
  });

  it("三档对照：三档被攻破几题，正常题误拦三档各几题", () => {
    const maps = [
      { v: "B0" as const, map: mapOf({ EXIT: cell(2, 2), CANARY: cell(0, 2) }, { EXIT: [0, 1] }) },
      { v: "B1" as const, map: mapOf({ EXIT: cell(1, 2), CANARY: cell(0, 2) }, { EXIT: [0, 1] }) },
      { v: "B2" as const, map: mapOf({ EXIT: cell(0, 2), CANARY: cell(0, 2) }, { EXIT: [1, 1] }) },
    ];
    const c = compareHeadline(maps, "released");
    expect(plain(c.lead)).toBe("三档对照：只有人设被攻破 2/4 题，加边界提示 1/4，再加护栏 0/4。");
    expect(plain(c.normal)).toBe("正常题被误拦：只有人设 0/1，加边界提示 0/1，再加护栏 1/1。");
    // 看角色原话时和一档一张图一样说「原话被攻破」
    expect(plain(compareHeadline(maps, "raw").lead)).toBe(
      "三档对照，看角色原话：只有人设原话被攻破 2/4 题，加边界提示 1/4，再加护栏 0/4。",
    );
    expect(compareHeadline([{ v: "B0", map: mapOf({}) }], "released").normal).toBeNull();
  });
});

describe("攻防地图：拦住攻击的是哪一层", () => {
  it("「只靠人设」和「边界提示管住了」合成一行「她自己没说」，值就是不为 0 的那一个", () => {
    const b0 = tally({ persona: 6, broken: 8 });
    const b2 = tally({ prompt: 8, rules: 3, model: 2, broken: 1 });
    expect(stopRows([b0, b2]).map((r) => r.key)).toEqual(["self", "rules", "model", "broken"]);
    // 和标题「拦住攻击的是哪一层」、点开一格的明细同一个说法：拦住
    expect(stopRows([b0, b2]).map((r) => r.label)).toEqual(["她自己没说", "规则、服务层拦住", "护栏模型拦住", "没拦住"]);
    expect(stopValue("self", b0, "B0")).toBe(6);
    expect(stopValue("self", b2, "B2")).toBe(8);
    expect(selfNote(b0, "B0")).toBe("只靠人设");
    expect(selfNote(b2, "B2")).toBe("边界提示管住了");
    expect(selfNote(tally({}), "B1")).toBe("边界提示管住了");
    expect(selfNote(tally({}), "B0")).toBe("只靠人设");
  });

  it("这一档没有的层写「这一档没有」；有这一层、拦下 0 题照写 0；万一有数照写", () => {
    const b0 = tally({ persona: 6, broken: 8 });
    expect(stopValue("rules", b0, "B0")).toBe("off");
    expect(stopValue("model", b0, "B1")).toBe("off");
    expect(stopValue("rules", tally({}), "B2")).toBe(0);
    expect(stopValue("broken", tally({}), "B0")).toBe(0);
    expect(stopValue("rules", tally({ rules: 2 }), "B0")).toBe(2);
  });

  it("两个都有数时（不该出现）照原来分成两行，数字不合并", () => {
    const odd = tally({ persona: 1, prompt: 2 });
    const rows = stopRows([odd]);
    expect(rows.map((r) => r.key)).toEqual(["persona", "prompt", "rules", "model", "broken"]);
    expect(stopValue("persona", odd, "B1")).toBe(1);
    expect(stopValue("prompt", odd, "B1")).toBe(2);
  });
});
