// 攻防地图的说法和数法（ADR-049 起；ADR-053（11-16 队员 B 修改稿 3）改成「三张卡片 + 七项检查结果 + 本次要看的问题」）。
// 只管怎么说、怎么摆，数字一个不编：全部直接取 lib/domain/attack-map.ts 数出来的 AttackMap。
// 纯函数，服务端页面和单元测试（tests/unit/map-summary.test.ts）共用。
//
// 卡片和七项的口径（ADR-053）：
// - 测试了 = 攻击题（越界题 + 含糊题，跑完的；看角色原话时只算判得了原话的）= AttackMap.total.tried；
// - 没守住 = 被攻破的 = total.broken；
// - 拿不准 = 裁判拿不准的（只在看最终播出时有）= total.unsure，不算守住也不算没守住，单独标；
// - 守住了 = 测试了 − 没守住 − 拿不准。所以 守住了 + 没守住 + 拿不准 = 测试了，三张卡片对得上。
// - 正常题不是攻击，不进上面任何一个数；被误拦单独说（normalTotals、blockedNormals）。
// - 七项一样一行，用 MapRow.total（一题只算一次，和合计同一处加）：七行加起来就是卡片上的数。

import type { AttackMap, MapCaseRef, MapCell, MapEntry, MapTotal, StopTally } from "@/lib/domain/attack-map";
import { FAMILIES, type Family, type SubjectVariant } from "@/lib/domain/types";

/** 三档的叫法（三档对照、档位按钮共用；悬停写全名 VARIANT_SHORT） */
export const TIER_NAME: Record<string, string> = { B0: "只有人设", B1: "加边界提示", B2: "再加护栏" };

/** 一格盖什么印：攻破过盖墨色「破」；没攻破盖朱文「守」；全是「不确定」的盖淡墨虚线「疑」；没测过不盖 */
export type Mark = "破" | "守" | "疑";
export function markOf(cell: MapCell | null | undefined): Mark | null {
  if (!cell || !cell.tried) return null;
  if (cell.broken > 0) return "破";
  if (cell.unsure >= cell.tried) return "疑";
  return "守";
}

// ---------- 三张卡片、七项检查结果（ADR-053） ----------

/** 测试了 / 守住了 / 没守住 / 拿不准：守住了 = 测试了 − 没守住 − 拿不准（见文件开头） */
export interface Tally {
  tried: number;
  held: number;
  broken: number;
  unsure: number;
}
export function cardsOf(t: MapTotal): Tally {
  return { tried: t.tried, held: t.tried - t.broken - t.unsure, broken: t.broken, unsure: t.unsure };
}

/** 七项检查结果的一行：这一样检查的攻击题（一题只算一次）和它的正常题 */
export interface CheckRow extends Tally {
  family: Family;
  normal: { tried: number; blocked: number };
}
export function checkRows(map: AttackMap): CheckRow[] {
  return FAMILIES.flatMap((family) => {
    const r = map.rows.find((x) => x.family === family);
    return r ? [{ family, ...cardsOf(r.total), normal: { tried: r.normal.tried, blocked: r.normal.blocked } }] : [];
  });
}

/** 正常题合计：试了几题、被误拦几题（和地图上「正常题被误拦 x / y」那一列加起来同一个数） */
export function normalTotals(map: AttackMap): { tried: number; blocked: number } {
  return map.rows.reduce((s, r) => ({ tried: s.tried + r.normal.tried, blocked: s.blocked + r.normal.blocked }), { tried: 0, blocked: 0 });
}

// ---------- 本次要看的问题（ADR-053） ----------

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

/**
 * 没守住的问题：一个「检查 × 怎么攻」的格子一条（就是地图上盖「破」的格子），
 * 带上这一格试了几题、第一道被攻破的题（「打开对应体检单」链到它；合并几次时是最近那次的）。
 * 每条的「没守住几题」加起来就是卡片上的「没守住」：一题被攻破只记在攻破那一句的格子上。
 */
export interface Issue extends BrokenSpot {
  tried: number;
  first: MapEntry | null;
}
export function issues(map: AttackMap): Issue[] {
  return brokenSpots(map).map((s) => {
    const cell = map.rows.find((r) => r.family === s.family)?.cells[map.columns.findIndex((c) => c.id === s.column)];
    return { ...s, tried: cell?.tried ?? 0, first: cell?.entries.find((e) => e.broken) ?? null };
  });
}

/** 拿不准的题：按检查数（一题只算一次），「查看原话」点开这一样第一个有拿不准的格子 */
export interface UnsureCheck {
  family: Family;
  unsure: number;
  column: string;
}
export function unsureChecks(map: AttackMap): UnsureCheck[] {
  return FAMILIES.flatMap((family) => {
    const r = map.rows.find((x) => x.family === family);
    const i = r ? r.cells.findIndex((c) => (c?.unsure ?? 0) > 0) : -1;
    return r && r.total.unsure > 0 && i >= 0 ? [{ family, unsure: r.total.unsure, column: map.columns[i].id }] : [];
  });
}

/** 正常题被误拦：按检查一条，「打开对应体检单」链到第一道被误拦的题 */
export interface BlockedNormal {
  family: Family;
  tried: number;
  blocked: number;
  first: MapCaseRef | null;
}
export function blockedNormals(map: AttackMap): BlockedNormal[] {
  return FAMILIES.flatMap((family) => {
    const r = map.rows.find((x) => x.family === family);
    return r && r.normal.blocked > 0
      ? [{ family, tried: r.normal.tried, blocked: r.normal.blocked, first: r.normal.blocked_cases[0] ?? null }]
      : [];
  });
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
