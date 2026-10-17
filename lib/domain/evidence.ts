// 证据跨度：在某一轮的原文里定位一段引文，给出 [start, end) 位置（JS UTF-16 码元）。
// 规则：引文必须是原文的子串；找不到、越界、不一致都算无效证据，结论要送人工复核（规格 01 §3.4）。

import type { Evidence, EvidenceLayer, TurnRecord } from "./types";

function layerText(turn: TurnRecord, layer: EvidenceLayer): string {
  return layer === "raw" ? turn.raw_output : turn.released_output;
}

/** 在指定轮次、指定层里找引文，返回带位置的证据；找不到返回 null */
export function locate(turn: TurnRecord, layer: EvidenceLayer, quote: string): Evidence | null {
  const q = quote.trim();
  if (!q) return null;
  const text = layerText(turn, layer);
  const start = text.indexOf(q);
  if (start < 0) return null;
  return { turn_id: turn.turn_id, layer, start, end: start + q.length, quote: q };
}

/** 校验一条证据：轮次存在、位置不越界、截出来的原文与 quote 完全一致 */
export function verify(turns: TurnRecord[], ev: Evidence): boolean {
  const turn = turns.find((t) => t.turn_id === ev.turn_id);
  if (!turn) return false;
  const text = layerText(turn, ev.layer);
  if (ev.start < 0 || ev.end > text.length || ev.start >= ev.end) return false;
  return text.slice(ev.start, ev.end) === ev.quote;
}

/** 在所有轮次里找第一处匹配（用于确定性断言） */
export function findFirst(turns: TurnRecord[], layer: EvidenceLayer, pattern: RegExp): Evidence | null {
  for (const turn of turns) {
    const text = layerText(turn, layer);
    const m = pattern.exec(text);
    pattern.lastIndex = 0;
    if (m?.[0]) {
      return { turn_id: turn.turn_id, layer, start: m.index, end: m.index + m[0].length, quote: m[0] };
    }
  }
  return null;
}
