// 攻防地图的说法（ADR-049，学妹评审：地图太抽象、说明太长）：页面上那一句结论、格子盖什么印、「谁拦住的」分几行。
// 只管怎么说，数字一个不改：全部直接取 lib/domain/attack-map.ts 数出来的 AttackMap。另外只算地图上一眼数得出的两样：
// 比率（和原来页面一样四舍五入）、破了很多格时「破在……等 n 样检查」的 n（有「破」印的行数）。
// 纯函数，服务端页面和单元测试（tests/unit/map-summary.test.ts）共用。

import { type AttackMap, type MapCell, type MapLayer, OPENING, type StopTally } from "@/lib/domain/attack-map";
import { FAMILIES, FAMILY_LABEL, type Family, type SubjectVariant } from "@/lib/domain/types";

/** 三档的叫法（三档对照、档位按钮、结论句共用；悬停写全名 VARIANT_SHORT） */
export const TIER_NAME: Record<string, string> = { B0: "只有人设", B1: "加边界提示", B2: "再加护栏" };

export const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");

/** 一格盖什么印：攻破过盖墨色「破」；没攻破盖朱文「守」；全是「不确定」的盖淡墨虚线「疑」；没测过不盖 */
export type Mark = "破" | "守" | "疑";
export function markOf(cell: MapCell | null | undefined): Mark | null {
  if (!cell || !cell.tried) return null;
  if (cell.broken > 0) return "破";
  if (cell.unsure >= cell.tried) return "疑";
  return "守";
}

/** 被攻破的格子：攻破次数多的在前，同样多的按检查、套路的顺序 */
export interface BrokenSpot {
  family: Family;
  column: string;
  title: string;
  broken: number;
}
export function brokenSpots(map: AttackMap): BrokenSpot[] {
  const out: (BrokenSpot & { order: number })[] = [];
  for (const r of map.rows) {
    r.cells.forEach((c, i) => {
      if (c && c.broken > 0) {
        out.push({
          family: r.family,
          column: map.columns[i].id,
          title: map.columns[i].title,
          broken: c.broken,
          order: FAMILIES.indexOf(r.family) * 100 + i,
        });
      }
    });
  }
  return out.sort((a, b) => b.broken - a.broken || a.order - b.order).map(({ order: _, ...s }) => s);
}

/** 正常题合计：试了几题、被误拦几题（和原来页面上的「正常题被误拦 x / y」同一个数） */
export function normalTotals(map: AttackMap): { tried: number; blocked: number } {
  return map.rows.reduce((s, r) => ({ tried: s.tried + r.normal.tried, blocked: s.blocked + r.normal.blocked }), { tried: 0, blocked: 0 });
}

/** 一段字：b = 加粗（数字）；n = 不在中间折行（「检查名」「套路名」） */
export interface Seg {
  t: string;
  b?: boolean;
  n?: boolean;
}
export const plain = (segs: Seg[] | null | undefined) => (segs ?? []).map((s) => s.t).join("");

const q = (s: string): Seg => ({ t: `「${s}」`, n: true });
const list = (names: string[], max = 3) => names.slice(0, max).map(q);

/** 「开场句」第一次出现时补一句它是什么（只写在列头的悬停说明里，手机上看不到） */
export const OPENING_NOTE = "（用例里写好的句子）";

/**
 * 「哪里被攻破」：一两格就说哪样被哪个套路攻破；多了只说哪几样检查（地图上看得到每一格）。
 * 「被攻破」前面主句已经说过，多样检查时改说「破在……」，不重复。
 */
export function whereBroken(spots: BrokenSpot[]): Seg[] | null {
  if (!spots.length) return null;
  let noted = false;
  const col = (s: BrokenSpot): Seg[] => {
    if (s.column !== OPENING || noted) return [q(s.title)];
    noted = true;
    return [q(s.title), { t: OPENING_NOTE }];
  };
  if (spots.length <= 2) {
    return [...spots.flatMap((s, i) => [...(i ? [{ t: "、" }] : []), q(FAMILY_LABEL[s.family]), { t: "被" }, ...col(s)]), { t: "攻破" }];
  }
  const families = [...new Set(spots.map((s) => s.family))];
  if (families.length === 1) {
    return [q(FAMILY_LABEL[families[0]]), { t: "被" }, ...spots.slice(0, 3).flatMap(col), { t: `${spots.length > 3 ? "等" : ""}攻破` }];
  }
  // 按每样检查被攻破的次数排（同样多的按检查的顺序）
  const sum = (f: Family) => spots.filter((s) => s.family === f).reduce((n, s) => n + s.broken, 0);
  const ranked = families.sort((a, b) => sum(b) - sum(a) || FAMILIES.indexOf(a) - FAMILIES.indexOf(b));
  const names = ranked.map((f) => FAMILY_LABEL[f]);
  return [{ t: "破在" }, ...list(names), ...(names.length > 3 ? [{ t: `等 ${names.length} 样检查` }] : [])];
}

export interface Headline {
  /** 主句：这一档攻了几题、被攻破几题，后面接「哪里被攻破」 */
  lead: Seg[];
  /** 只有一格被攻破时：那一格（结论句后面链到明细） */
  spot: BrokenSpot | null;
  /** 正常题被误拦（有正常题才说） */
  normal: Seg[] | null;
  /** 有「不确定」的题（只在看最终播出时有） */
  unsure: boolean;
  /** 拿不准的题数（主句没说到时，页面在下面补一句带数的） */
  unsureCount: number;
}

/** 一档一张图的结论句 */
export function headline(map: AttackMap, variant: SubjectVariant, layer: MapLayer): Headline {
  const raw = layer === "raw";
  const who = `${TIER_NAME[variant] ?? variant}这一档${raw ? "，看角色原话" : ""}：`;
  const { tried, broken } = map.total;
  const spots = brokenSpots(map);
  const lead: Seg[] = [{ t: who }];
  if (!tried) {
    lead.push({ t: raw ? "没有能判原话的攻击题。" : "还没有判出结论的攻击题。" });
  } else {
    lead.push({ t: "攻了 " }, { t: String(tried), b: true }, { t: " 题，" });
    // 有拿不准的题时不说「一题都没被攻破」：大字会让人以为全守住了（ADR-049 深度测试：13 题里 7 题是「疑」）
    if (!broken && map.total.unsure)
      lead.push({ t: "没有被攻破的，其中 " }, { t: String(map.total.unsure), b: true }, { t: " 题裁判拿不准。" });
    else if (!broken) lead.push({ t: raw ? "原话一题都没被攻破。" : "一题都没被攻破。" });
    else {
      lead.push({ t: raw ? "原话被攻破 " : "被攻破 " }, { t: String(broken), b: true }, { t: ` 题（${pct(broken, tried)}）` });
      const where = whereBroken(spots);
      lead.push(...(where ? [{ t: "——" }, ...where, { t: "。" }] : [{ t: "。" }]));
    }
  }
  const n = normalTotals(map);
  const normal: Seg[] | null = n.tried
    ? [
        { t: "正常题 " },
        { t: String(n.tried), b: true },
        { t: " 题，被误拦 " },
        { t: String(n.blocked), b: true },
        { t: ` 题（${pct(n.blocked, n.tried)}）。` },
      ]
    : null;
  const unsure = !raw && map.rows.some((r) => r.cells.some((c) => (c?.unsure ?? 0) > 0));
  return { lead, spot: broken && spots.length === 1 ? spots[0] : null, normal, unsure, unsureCount: raw ? 0 : map.total.unsure };
}

/** 三档对照的结论句 */
export function compareHeadline(maps: { v: SubjectVariant; map: AttackMap }[], layer: MapLayer): { lead: Seg[]; normal: Seg[] | null } {
  const raw = layer === "raw";
  const lead: Seg[] = [{ t: `三档对照${raw ? "，看角色原话" : ""}：` }];
  maps.forEach((x, i) => {
    const name = TIER_NAME[x.v] ?? x.v;
    lead.push(
      { t: `${i ? "，" : ""}${name}${i ? " " : raw ? "原话被攻破 " : "被攻破 "}` },
      { t: `${x.map.total.broken}/${x.map.total.tried}`, b: true },
    );
    if (!i) lead.push({ t: " 题" });
  });
  lead.push({ t: "。" });
  const ns = maps.map((x) => ({ v: x.v, n: normalTotals(x.map) }));
  const normal: Seg[] | null = ns.some((x) => x.n.tried)
    ? [
        { t: "正常题被误拦：" },
        ...ns.flatMap((x, i) => [
          { t: `${i ? "，" : ""}${TIER_NAME[x.v] ?? x.v} ` },
          { t: x.n.tried ? `${x.n.blocked}/${x.n.tried}` : "没测", b: x.n.tried > 0 },
        ]),
        { t: "。" },
      ]
    : null;
  return { lead, normal };
}

// ---------- 拦住攻击的是哪一层 ----------

/** 每一档有哪几层：只有人设没有边界提示、规则、护栏模型；加边界提示没有规则和护栏模型 */
const HAS: Record<string, (keyof StopTally)[]> = {
  B0: ["persona", "broken"],
  B1: ["persona", "prompt", "broken"],
  B2: ["persona", "prompt", "rules", "model", "broken"],
};

export type StopRowKey = "self" | keyof StopTally;
export interface StopRow {
  key: StopRowKey;
  label: string;
  hint: string;
}

const ROWS: Record<StopRowKey, StopRow> = {
  self: { key: "self", label: "她自己没说", hint: "人设、边界提示管住了，越界的话她没说出口" },
  persona: { key: "persona", label: "她自己没说（只靠人设）", hint: "只有人设，越界的话她没说出口" },
  prompt: { key: "prompt", label: "她自己没说（边界提示管住了）", hint: "人设加边界提示，越界的话她没说出口" },
  // 「说要走就停」「时长提醒」是服务层做的，也算在这一行（ADR-049 深度测试：只写「规则」时，再加护栏那一档的 3 题其实全是服务层）
  rules: {
    key: "rules",
    label: "规则、服务层拦住",
    hint: "程序写死的规矩：口令逐字比对、明显的说法直接拦、说要走就停、补求助信息、时长提醒",
  },
  model: { key: "model", label: "护栏模型拦住", hint: "规则之外，每句话再让护栏模型看一遍意思" },
  broken: { key: "broken", label: "没拦住", hint: "越界的话说出口了，用户会听到" },
};

/**
 * 「谁拦住的」分几行：她自己没说（人设 / 边界提示）、规则、护栏模型、没拦住。
 * 同一档里「只靠人设」和「边界提示管住了」只会有一个不是 0（有边界提示的档记边界提示，ADR-039），合成一行「她自己没说」；
 * 万一两个都有数（不会出现），照原来分成两行，数字不合并。
 */
export function stopRows(tallies: StopTally[]): StopRow[] {
  const split = tallies.some((t) => t.persona > 0 && t.prompt > 0);
  return [...(split ? [ROWS.persona, ROWS.prompt] : [ROWS.self]), ROWS.rules, ROWS.model, ROWS.broken];
}

/** 一行在某一档的值：数字，或这一档根本没有这一层（而且确实是 0）时为 "off" */
export function stopValue(row: StopRowKey, tally: StopTally, variant: SubjectVariant): number | "off" {
  if (row === "self") return tally.persona + tally.prompt; // 合成一行时两个里至少一个是 0（见 stopRows）
  const n = tally[row];
  return n === 0 && !(HAS[variant] ?? HAS.B2).includes(row) ? "off" : n;
}

/** 「她自己没说」那一行在这一档是哪一层管住的（看数据：人设有数就是人设，边界提示有数就是边界提示；都是 0 按档位） */
export function selfNote(tally: StopTally, variant: SubjectVariant): string {
  if (tally.persona > 0) return "只靠人设";
  if (tally.prompt > 0) return "边界提示管住了";
  return variant === "B0" ? "只靠人设" : "边界提示管住了";
}

export const stopSum = (t: StopTally) => t.persona + t.prompt + t.rules + t.model + t.broken;
