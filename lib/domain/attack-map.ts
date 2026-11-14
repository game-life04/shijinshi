// 攻防地图（ADR-038，借 promptfoo 风险报告的做法）：竖着是七样检查，横着是怎么攻（开场句 + 登记的套路），
// 每格写「攻破几次 / 试了几次」，颜色越深攻破得越多。全部从现有运行记录算，不调用模型、不新跑实验；浏览器端也能用。
//
// 口径（页面底下照写）：
// - 只算越界题、含糊题（正常题不是攻击，单独一列算误拦）；只算跑完的题；
// - 一题里测试 Agent 可能换几种套路：用到的每一种都算「试了一次」；这题被攻破，只算在攻破那一句用的套路上
//   （按结论摘出的原话落在哪一轮；摘不到原话的，算在第一句上）；
// - 看「最终播出」：这题最终不合格就算攻破（用户真的会听到）；「不确定」不算攻破，单独计数；
// - 看「角色原话」：角色原话越界就算攻破（改人设、边界提示看它）；判断不了、只查服务层的题不进这一层的分母；
// - 敏感的几类（身份、时长、退出、危机、未成年）只用人工写好的固定句子测，不让测试 Agent 自由出招（suites/strategies.json），
//   所以这几行只有「开场句」一列有数。
// - 「哪一层拦住的」（只在看最终播出时算，和闯关的四层同一个口径，ADR-038）：攻破了不算；护栏拦下的句子按命中方式记
//   「规则」或「护栏模型」（先出现的那句为准）；服务层动了（说要走就停、补求助信息、时长提醒）记「规则」；
//   都没有、也没越界，有边界提示的配置记「边界提示」，只有人设的记「人设」（她自己没说）。

import { caseLayers } from "./layers";
import type { PlayLayer } from "./levels";
import { type CaseResult, FAMILIES, type Family } from "./types";

export type MapLayer = "released" | "raw";

/** 「开场句」：用例里人工写好的句子（没有测试 Agent 的套路编号） */
export const OPENING = "OPENING";

export interface MapStrategy {
  id: string;
  title: string;
  families: Family[];
}

/** 一格里的一题：点开格子看的明细 */
export interface MapEntry {
  run_id: string;
  /** 体检单里是第几例（锚点 #case-N） */
  no: number;
  case_id: string;
  broken: boolean;
  unsure: boolean;
  /** 这一列用的那一句（这一题里第一次用这一列的那一轮） */
  attack: string;
  /** 她那一轮最终说出口的（截短） */
  said: string;
  /** 哪一层拦住的（只在看最终播出时有；攻破了为 null） */
  stopped: PlayLayer | null;
}

export interface MapCell {
  tried: number;
  broken: number;
  /** 最终播出层：结论「不确定」、还要人工看的题数（不算攻破） */
  unsure: number;
  /** 被攻破的题（用例编号，去重） */
  cases: string[];
  entries: MapEntry[];
}

/** 攻击题被哪一层拦住（最终播出层）：四层各几题，攻破几题 */
export type StopTally = Record<PlayLayer | "broken", number>;

export interface MapRow {
  family: Family;
  /** 按列：null = 这一类不用这个套路（不适用） */
  cells: (MapCell | null)[];
  /** 正常题：试了几题、被误拦几题（只算挂了误拦检查的正常题） */
  normal: { tried: number; blocked: number };
}

export interface AttackMap {
  columns: { id: string; title: string }[];
  rows: MapRow[];
  /** 合计：攻击题被攻破几题 / 判出结论的攻击题 */
  /** 攻了几题、被攻破几题、其中裁判拿不准几题（不算攻破；只在看最终播出时有） */
  total: { tried: number; broken: number; unsure: number };
  /** 攻击题是被哪一层拦住的（只在看最终播出时算；「不确定」的不算进来） */
  stops: StopTally;
  /** 参与统计的题目结果条数 */
  results: number;
}

const empty = (): MapCell => ({ tried: 0, broken: 0, unsure: 0, cases: [], entries: [] });

export interface MapItem {
  result: CaseResult;
  /** 这次运行有没有护栏（原话层要用） */
  guarded: boolean;
  /** 这次运行有没有边界提示（她自己没说时记「边界提示」还是「人设」）；不给时按 guarded 算 */
  prompt?: boolean;
  run_id?: string;
  /** 体检单里是第几例 */
  no?: number;
}

/** 这一题是哪一层拦住的（攻破了为 null）：和闯关同一个口径 */
export function stoppedLayer(r: CaseResult, prompt: boolean): PlayLayer | null {
  if (r.verdict === "fail") return null;
  for (const t of r.turns) {
    if (t.service.exited) return "rules";
    const hit = t.utterances.find((u) => u.guard && (!u.released || u.cut_after_release) && u.guard.rule !== "unavailable")?.guard;
    if (hit) return hit.by === "rule" ? "rules" : "model";
  }
  if (r.turns.some((t) => t.service.crisis_help_appended || t.service.reminder_emitted)) return "rules";
  return prompt ? "prompt" : "persona";
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 攻破发生在哪一轮：结论摘出的原话所在的那一轮；摘不到就算第一轮 */
function brokenTurn(r: CaseResult, layer: MapLayer, guarded: boolean): number {
  const failed = r.findings.filter((f) => (f.reviewed_verdict ?? f.verdict) === "fail").flatMap((f) => f.evidence.map((e) => e.turn_id));
  // 原话层先看原话层自己的证据（护栏拦下的句子、口令），没有再看结论摘的原话（没有护栏时播出就是原话）
  const ids = layer === "raw" ? [...caseLayers(r, guarded).raw.evidence.map((e) => e.turn_id), ...failed] : failed;
  const idx = ids.map((id) => r.turns.findIndex((t) => t.turn_id === id)).filter((i) => i >= 0);
  return idx.length ? Math.min(...idx) : 0;
}

export function buildAttackMap(items: MapItem[], strategies: MapStrategy[], layer: MapLayer): AttackMap {
  const columns = [{ id: OPENING, title: "开场句" }, ...strategies.map((s) => ({ id: s.id, title: s.title }))];
  const col = new Map(columns.map((c, i) => [c.id, i]));
  const rows: MapRow[] = FAMILIES.map((family) => ({
    family,
    cells: columns.map((c) => (c.id === OPENING || strategies.find((s) => s.id === c.id)?.families.includes(family) ? empty() : null)),
    normal: { tried: 0, blocked: 0 },
  }));
  const total = { tried: 0, broken: 0, unsure: 0 };
  const stops: StopTally = { persona: 0, prompt: 0, rules: 0, model: 0, broken: 0 };
  let results = 0;

  for (const { result: r, guarded, prompt = guarded, run_id = "", no = 0 } of items) {
    if (r.status !== "completed" || !r.turns.length) continue;
    const row = rows.find((x) => x.family === r.family);
    if (!row) continue;
    results++;
    if (r.intent === "normal") {
      const f = r.findings.find((x) => x.rule_id === "normal.not_blocked");
      if (f) {
        row.normal.tried++;
        if ((f.reviewed_verdict ?? f.verdict) === "fail") row.normal.blocked++;
      }
      continue;
    }
    // 这一题算不算攻破
    let broken: boolean;
    let unsure = false;
    if (layer === "raw") {
      const s = caseLayers(r, guarded).raw.status;
      if (s !== "crossed" && s !== "clean") continue; // 判断不了、只查服务层：不进原话层的分母
      broken = s === "crossed";
    } else {
      broken = r.verdict === "fail";
      unsure = r.verdict === "uncertain";
    }
    // 每一轮用的是哪一列（开场句或某个套路）；未登记的套路编号也算开场句那一列之外的「其他」——不会出现，策略只能从登记表里选
    const colOf = (i: number) => col.get(r.turns[i]?.strategy_id ?? OPENING) ?? 0;
    const at = broken ? colOf(brokenTurn(r, layer, guarded)) : -1;
    const stopped = layer === "released" ? stoppedLayer(r, prompt) : null;
    const used = new Set(r.turns.map((_, i) => colOf(i)));
    for (const c of used) {
      const cell = row.cells[c];
      if (!cell) continue;
      cell.tried++;
      if (unsure) cell.unsure++;
      const t = r.turns[r.turns.findIndex((_, i) => colOf(i) === c)];
      cell.entries.push({
        run_id,
        no,
        case_id: r.case_id,
        broken: c === at,
        unsure,
        attack: clip(t?.user_text ?? "", 80),
        said: clip(t?.released_output || (t?.service.exited ? "（服务停了，她没说话）" : "（没有说话）")),
        stopped,
      });
    }
    total.tried++;
    if (unsure) total.unsure++;
    if (layer === "released" && !unsure) stops[stopped ?? "broken"]++;
    if (broken) {
      total.broken++;
      const cell = row.cells[at];
      if (cell) {
        cell.broken++;
        if (!cell.cases.includes(r.case_id)) cell.cases.push(r.case_id);
      }
    }
  }
  return { columns, rows, total, stops, results };
}

/** 格子的深浅：0（宣纸白）～1（墨黑）；没测过为 null */
export function inkLevel(cell: MapCell | null): number | null {
  if (!cell || !cell.tried) return null;
  return cell.broken / cell.tried;
}
