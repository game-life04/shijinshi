// 前后对比页的逐题比较和差异摘要（评审 R24、R23）。只读运行记录，不改任何判定口径；浏览器端、服务端都能用。
//   - 两次跑的题不一样时（比如 16 题和 1 题），只比两次都跑了的题，并说清楚通过数不能直接比；
//   - 每题标「变好 / 变差 / 没变」：先看最终播出的判定，判定一样再看角色原话层；护栏处理的说法变了只算小变化；
//   - 摘要一句话说清多过、少过了哪几样，少过的都是服务层的检查时点明（B1 没有分寸的服务层）。
//   摘要里不写「改了」两个字：巡检脚本数「改了」出现几次，用来判断「改了什么」那张表。

import { type CaseLayers, caseLayers, isServiceCheck } from "./layers";
import { type CaseResult, FAMILY_LABEL, type Family, type Verdict } from "./types";

export type Trend = "better" | "worse" | "same";

export interface CompareRow {
  case_id: string;
  family: Family;
  a?: CaseResult;
  b?: CaseResult;
  la?: CaseLayers;
  lb?: CaseLayers;
  trend: Trend;
  /** 最终播出的判定（或没跑完的状态）变了 */
  verdictChanged: boolean;
  /** 角色原话层变了 */
  rawChanged: boolean;
  /** 只是护栏处理的说法变了（比如 B2 → B1：「全部放行」变成「没有护栏」） */
  guardChanged: boolean;
}

const VERDICT_SCORE: Record<Verdict, number> = { pass: 3, not_applicable: 2, uncertain: 1, fail: 0 };

/** 判定的好坏：合格 > 不适用 > 不确定 > 不合格 > 没跑完 */
function verdictScore(r?: CaseResult): number | undefined {
  if (!r) return undefined;
  return r.status === "completed" && r.verdict ? VERDICT_SCORE[r.verdict] : -1;
}

const RAW_SCORE: Record<string, number | undefined> = { clean: 1, crossed: 0 };

const outcome = (r?: CaseResult) => (r ? (r.status === "completed" ? r.verdict : r.status) : undefined);

/** 两次都跑了的题；只跑了一边的另外返回 */
export function caseSets(A: CaseResult[], B: CaseResult[]): { both: string[]; onlyA: string[]; onlyB: string[]; same: boolean } {
  const a = new Set(A.map((r) => r.case_id));
  const b = new Set(B.map((r) => r.case_id));
  const both = [...a].filter((id) => b.has(id));
  const onlyA = [...a].filter((id) => !b.has(id));
  const onlyB = [...b].filter((id) => !a.has(id));
  return { both, onlyA, onlyB, same: onlyA.length === 0 && onlyB.length === 0 };
}

/** 逐题比较：只比两次都跑了的题；有变化的排前面（变差的在最前），其余保持原来的顺序 */
export function compareRows(A: CaseResult[], B: CaseResult[], guardedA: boolean, guardedB: boolean): CompareRow[] {
  const { both } = caseSets(A, B);
  const rows = both.map((id): CompareRow => {
    const a = A.find((r) => r.case_id === id);
    const b = B.find((r) => r.case_id === id);
    const la = a ? caseLayers(a, guardedA) : undefined;
    const lb = b ? caseLayers(b, guardedB) : undefined;
    const verdictChanged = outcome(a) !== outcome(b);
    const rawChanged = la?.raw.status !== lb?.raw.status;
    const guardChanged = la?.guard.summary !== lb?.guard.summary;
    let trend: Trend = "same";
    const sa = verdictScore(a);
    const sb = verdictScore(b);
    if (sa !== undefined && sb !== undefined && sa !== sb) trend = sb > sa ? "better" : "worse";
    else if (rawChanged) {
      const ra = RAW_SCORE[la?.raw.status ?? ""];
      const rb = RAW_SCORE[lb?.raw.status ?? ""];
      if (ra !== undefined && rb !== undefined && ra !== rb) trend = rb > ra ? "better" : "worse";
    }
    return { case_id: id, family: (a ?? b)?.family ?? "CANARY", a, b, la, lb, trend, verdictChanged, rawChanged, guardChanged };
  });
  const rank = (r: CompareRow) => (r.trend === "worse" ? 0 : r.trend === "better" ? 1 : r.verdictChanged || r.rawChanged ? 2 : 3);
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => rank(x.r) - rank(y.r) || x.i - y.i)
    .map((x) => x.r);
}

/** 「要求退出就停止 2 项、连续使用提醒 1 项」 */
function byFamily(rows: CompareRow[]): string {
  const order = Object.keys(FAMILY_LABEL) as Family[];
  return order
    .map((f) => [f, rows.filter((r) => r.family === f).length] as const)
    .filter(([, n]) => n > 0)
    .map(([f, n]) => `${FAMILY_LABEL[f]} ${n} 项`)
    .join("、");
}

/** 这一题在 B 里没过，是不是只因为服务层的检查（退出即停、时长提醒）没过 */
function failedOnlyOnService(r?: CaseResult): boolean {
  if (!r || r.status !== "completed") return false;
  const bad = r.findings.filter(
    (f) => (f.reviewed_verdict ?? f.verdict) !== "pass" && (f.reviewed_verdict ?? f.verdict) !== "not_applicable",
  );
  return bad.length > 0 && bad.every((f) => isServiceCheck(f));
}

/** 两个通过数之间的一句话摘要 */
export function compareSummary(rows: CompareRow[], opts: { guardedA: boolean; guardedB: boolean }): string {
  const passed = (r?: CaseResult) => r?.status === "completed" && r.verdict === "pass";
  const gained = rows.filter((r) => !passed(r.a) && passed(r.b));
  const lost = rows.filter((r) => passed(r.a) && !passed(r.b));
  const otherVerdict = rows.filter((r) => r.verdictChanged && !gained.includes(r) && !lost.includes(r)).length;
  const rawOnly = rows.filter((r) => !r.verdictChanged && r.rawChanged).length;
  if (!gained.length && !lost.length && !otherVerdict) {
    return `${rows.length} 道题的判定都没变${rawOnly ? `；角色原话层有 ${rawOnly} 道不一样` : ""}。`;
  }
  const parts: string[] = [];
  if (lost.length) {
    let s = `B 比 A 少过 ${lost.length} 项：${byFamily(lost)}`;
    if (lost.every((r) => failedOnlyOnService(r.b)))
      s += opts.guardedA && !opts.guardedB ? "，都是服务层的检查（B 没有分寸的服务层）" : "，都是服务层的检查";
    parts.push(s);
  }
  if (gained.length) parts.push(`B 比 A 多过 ${gained.length} 项：${byFamily(gained)}`);
  if (otherVerdict) parts.push(`另有 ${otherVerdict} 道判定不一样，但都不是合格`);
  return `${parts.join("；")}。`;
}
