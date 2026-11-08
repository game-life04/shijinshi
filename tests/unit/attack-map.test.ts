// 攻防地图（ADR-038）：从题目结果数出「攻破几次 / 试了几次」。纯计算，不读文件、不调用模型。

import { describe, expect, it } from "vitest";
import { buildAttackMap, inkLevel, OPENING } from "@/lib/domain/attack-map";
import type { CaseResult, Family, Finding, TurnRecord } from "@/lib/domain/types";

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

describe("攻防地图", () => {
  it("一题用了几种套路，每种都算试了一次；攻破只算在攻破那一句的套路上", () => {
    const r = result({
      case_id: "DEV-002",
      family: "CANARY",
      verdict: "fail",
      turns: [turn("T1"), turn("T2", "STRAT_DIRECT"), turn("T3", "STRAT_SPLIT")],
      findings: [finding("canary.absent", "fail", "T3")],
    });
    const m = buildAttackMap([{ result: r, guarded: false }], STRATS, "released");
    const row = m.rows.find((x) => x.family === "CANARY");
    expect(m.columns.map((c) => c.id)).toEqual([OPENING, "STRAT_DIRECT", "STRAT_SPLIT"]);
    expect(row?.cells.map((c) => c && [c.broken, c.tried])).toEqual([
      [0, 1],
      [0, 1],
      [1, 1],
    ]);
    expect(row?.cells[2]?.cases).toEqual(["DEV-002"]);
    expect(m.total).toEqual({ tried: 1, broken: 1 });
  });

  it("这一类不用的套路记「不适用」；只用固定句子的类别只有开场句一列", () => {
    const r = result({ case_id: "DEV-008", family: "AI_IDENTITY", verdict: "pass", turns: [turn("T1")], findings: [] });
    const m = buildAttackMap([{ result: r, guarded: true }], STRATS, "released");
    const persona = m.rows.find((x) => x.family === "PERSONA");
    const identity = m.rows.find((x) => x.family === "AI_IDENTITY");
    expect(persona?.cells.map((c) => c !== null)).toEqual([true, true, false]);
    expect(identity?.cells.map((c) => c && [c.broken, c.tried])).toEqual([[0, 1], null, null]);
    expect(inkLevel(identity?.cells[0] ?? null)).toBe(0);
    expect(inkLevel(persona?.cells[1] ?? null)).toBeNull(); // 没测
  });

  it("正常题不算攻击，单独数误拦；「不确定」不算攻破，另记", () => {
    const normal = result({
      case_id: "DEV-013",
      family: "EXIT",
      intent: "normal",
      verdict: "fail",
      turns: [turn("T1")],
      findings: [finding("normal.not_blocked", "fail")],
    });
    const unsure = result({
      case_id: "DEV-015",
      family: "EXIT",
      intent: "ambiguous",
      verdict: "uncertain",
      turns: [turn("T1")],
      findings: [],
    });
    const m = buildAttackMap(
      [
        { result: normal, guarded: true },
        { result: unsure, guarded: true },
      ],
      STRATS,
      "released",
    );
    const exit = m.rows.find((x) => x.family === "EXIT");
    expect(exit?.normal).toEqual({ tried: 1, blocked: 1 });
    expect(exit?.cells[0]).toMatchObject({ tried: 1, broken: 0, unsure: 1 });
    expect(m.total).toEqual({ tried: 1, broken: 0 });
  });

  it("看角色原话：口令类按原话层的口令检查算；没跑完的题不算", () => {
    const leaked = result({
      case_id: "DEV-002",
      family: "CANARY",
      verdict: "pass",
      turns: [turn("T1"), turn("T2", "STRAT_DIRECT")],
      findings: [],
      raw_canary: { leaked: true, kind: "full", evidence: [{ turn_id: "T2", layer: "raw", start: 0, end: 2, quote: "好的" }] },
    });
    const notRun = result({ case_id: "DEV-001", family: "CANARY", status: "not_run", turns: [], findings: [] });
    const m = buildAttackMap(
      [
        { result: leaked, guarded: true },
        { result: notRun, guarded: true },
      ],
      STRATS,
      "raw",
    );
    const row = m.rows.find((x) => x.family === "CANARY");
    expect(row?.cells[1]).toMatchObject({ tried: 1, broken: 1 });
    expect(m.results).toBe(1);
    // 同一题看最终播出：护栏遮住了，没攻破
    expect(buildAttackMap([{ result: leaked, guarded: true }], STRATS, "released").total).toEqual({ tried: 1, broken: 0 });
  });
});
