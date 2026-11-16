// 攻防地图的说法（ADR-049）：格子盖什么印、「拦住攻击的是哪一层」分几行；
// ADR-053（11-16 队员 B 修改稿 3）：三张卡片、七项检查结果、本次要看的问题。
// 只管怎么说，数字都直接取 AttackMap；这里守住「卡片、七项、问题上的数和地图上的数是同一个」。纯计算，不读文件、不调用模型。

import { describe, expect, it } from "vitest";
import {
  blockedNormals,
  brokenSpots,
  cardsOf,
  checkRows,
  issues,
  markOf,
  normalTotals,
  selfNote,
  stopRows,
  stopValue,
  unsureChecks,
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
    normal: { tried: normal[family]?.[1] ?? 0, blocked: normal[family]?.[0] ?? 0, blocked_cases: [] },
    total: { tried: cells[family]?.tried ?? 0, broken: cells[family]?.broken ?? 0, unsure: cells[family]?.unsure ?? 0 },
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

describe("攻防地图：三张卡片和七项检查结果（ADR-053）", () => {
  // 口令：一题换「拆开提问」那一句破了，一题守住；退出：一题守住、一题拿不准，正常题一题被误拦
  const items = [
    result({
      case_id: "C1",
      family: "CANARY",
      verdict: "fail",
      turns: [turn("a1"), turn("a2", "STRAT_SPLIT")],
      findings: [finding("canary.absent", "fail", "a2")],
    }),
    result({ case_id: "C2", family: "CANARY", verdict: "pass", turns: [turn("b1")], findings: [finding("canary.absent", "pass")] }),
    result({ case_id: "E1", family: "EXIT", verdict: "pass", turns: [turn("c1")], findings: [finding("exit.stop", "pass")] }),
    result({ case_id: "E2", family: "EXIT", intent: "ambiguous", verdict: "uncertain", turns: [turn("e1")], findings: [] }),
    result({
      case_id: "N1",
      family: "EXIT",
      intent: "normal",
      verdict: "fail",
      turns: [turn("d1")],
      findings: [finding("normal.not_blocked", "fail", "d1")],
    }),
  ].map((r, i) => ({ result: r, guarded: true, prompt: true, run_id: "R1", no: i + 1 }));

  it("测试了 = 守住了 + 没守住 + 拿不准，数字直接取地图的合计；正常题不在里面", () => {
    const m = buildAttackMap(items, STRATS, "released");
    expect(m.total).toEqual({ tried: 4, broken: 1, unsure: 1 });
    const c = cardsOf(m.total);
    expect(c).toEqual({ tried: 4, held: 2, broken: 1, unsure: 1 });
    expect(c.held + c.broken + c.unsure).toBe(c.tried);
    expect(normalTotals(m)).toEqual({ tried: 1, blocked: 1 });
  });

  it("七项一样一行、按七样检查的顺序；没测的那几样 0 题；七行加起来就是三张卡片", () => {
    const m = buildAttackMap(items, STRATS, "released");
    const rows = checkRows(m);
    expect(rows.map((r) => r.family)).toEqual(FAMILIES);
    expect(rows.find((r) => r.family === "CANARY")).toMatchObject({ tried: 2, held: 1, broken: 1, unsure: 0 });
    expect(rows.find((r) => r.family === "EXIT")).toMatchObject({
      tried: 2,
      held: 1,
      broken: 0,
      unsure: 1,
      normal: { tried: 1, blocked: 1 },
    });
    expect(rows.find((r) => r.family === "PERSONA")).toMatchObject({ tried: 0, held: 0, broken: 0, unsure: 0 });
    const sum = rows.reduce(
      (s, r) => ({ tried: s.tried + r.tried, held: s.held + r.held, broken: s.broken + r.broken, unsure: s.unsure + r.unsure }),
      { tried: 0, held: 0, broken: 0, unsure: 0 },
    );
    expect(sum).toEqual(cardsOf(m.total));
  });

  it("看角色原话：没有拿不准，守住了 = 测试了 − 没守住", () => {
    const m = buildAttackMap(items, STRATS, "raw");
    const c = cardsOf(m.total);
    expect(c.unsure).toBe(0);
    expect(c.held).toBe(c.tried - c.broken);
  });

  it("没有数据：三张卡片都是 0，没有要看的问题", () => {
    const m = mapOf({});
    expect(cardsOf(m.total)).toEqual({ tried: 0, held: 0, broken: 0, unsure: 0 });
    expect(issues(m)).toEqual([]);
    expect(unsureChecks(m)).toEqual([]);
    expect(blockedNormals(m)).toEqual([]);
  });
});

describe("攻防地图：本次要看的问题（ADR-053）", () => {
  it("一个被攻破的格子一条：哪样检查、用哪一列攻破的、第一道被攻破的题（链体检单）；几条加起来就是「没守住」", () => {
    const exits = [1, 2].map((k) =>
      result({
        case_id: `E${k}`,
        family: "EXIT",
        verdict: "fail",
        turns: [turn(`e${k}`)],
        findings: [finding("exit.stop", "fail", `e${k}`)],
      }),
    );
    const m = buildAttackMap(
      [
        ...exits,
        result({
          case_id: "C1",
          family: "CANARY",
          verdict: "fail",
          turns: [turn("a1"), turn("a2", "STRAT_SPLIT")],
          findings: [finding("canary.absent", "fail", "a2")],
        }),
        result({ case_id: "C2", family: "CANARY", verdict: "pass", turns: [turn("b1"), turn("b2", "STRAT_SPLIT")], findings: [] }),
      ].map((r, i) => ({ result: r, guarded: true, prompt: true, run_id: "R9", no: i + 1 })),
      STRATS,
      "released",
    );
    const list = issues(m);
    // 攻破多的在前
    expect(list.map((x) => [x.family, x.column, x.title, x.broken, x.tried])).toEqual([
      ["EXIT", OPENING, "开场句", 2, 2],
      ["CANARY", "STRAT_SPLIT", "拆开提问", 1, 2],
    ]);
    expect(list[0].first).toMatchObject({ run_id: "R9", no: 1, case_id: "E1", broken: true });
    expect(list[1].first).toMatchObject({ run_id: "R9", no: 3, case_id: "C1", broken: true });
    expect(list.reduce((n, x) => n + x.broken, 0)).toBe(m.total.broken);
    expect(brokenSpots(m).map((s) => s.column)).toEqual([OPENING, "STRAT_SPLIT"]);
  });

  it("同一样检查被几个套路攻破：一个套路一条，攻破多的在前，一样多按列的顺序", () => {
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
        normal: { tried: 0, blocked: 0, blocked_cases: [] },
        total: family === "CANARY" ? { tried: 4, broken: 4, unsure: 0 } : { tried: 0, broken: 0, unsure: 0 },
      })),
      total: { tried: 4, broken: 4, unsure: 0 },
      stops: tally({}),
      results: 4,
    };
    expect(issues(m).map((s) => [s.column, s.broken, s.tried])).toEqual([
      ["B", 2, 2],
      [OPENING, 1, 3],
      ["A", 1, 1],
    ]);
    // 手搭的格子里没有明细：不给体检单链接
    expect(issues(m)[0].first).toBeNull();
  });

  it("拿不准的按检查一条（一题只算一次），点开这一样第一个有拿不准的格子；正常题被误拦按检查一条，链到第一道", () => {
    const blocked = (id: string, t: string) =>
      result({
        case_id: id,
        family: "EXIT",
        intent: "normal",
        verdict: "fail",
        turns: [turn(t)],
        findings: [finding("normal.not_blocked", "fail", t)],
      });
    const m = buildAttackMap(
      [
        result({ case_id: "C9", family: "CANARY", verdict: "uncertain", turns: [turn("a1"), turn("a2", "STRAT_SPLIT")], findings: [] }),
        blocked("N1", "d1"),
        blocked("N2", "d2"),
      ].map((r, i) => ({ result: r, guarded: true, prompt: true, run_id: "R2", no: i + 1 })),
      STRATS,
      "released",
    );
    // 这一题用了两列，两格各记一次「疑」，按检查只算 1 题
    expect(m.rows.find((r) => r.family === "CANARY")?.cells.map((c) => c?.unsure)).toEqual([1, 0, 1]);
    expect(unsureChecks(m)).toEqual([{ family: "CANARY", unsure: 1, column: OPENING }]);
    expect(blockedNormals(m)).toEqual([{ family: "EXIT", tried: 2, blocked: 2, first: { run_id: "R2", no: 2, case_id: "N1" } }]);
    expect(cardsOf(m.total)).toEqual({ tried: 1, held: 0, broken: 0, unsure: 1 });
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
