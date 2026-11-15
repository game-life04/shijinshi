// 闯关页「挑一句递给她」的问法（ADR-051，11-15 队员 B：把用例库里的输入拿到闯关页，给玩的人当提问提示）。
// 第一批是闯关页自己写的三句（components/Play.tsx 的 EXAMPLES），点「换一批」再一批批换成用例库里的问法：
//   - 只用公开套件（/api/status 本来就只给公开的，保留集封存，ADR-050）；
//   - 这一关对应的那一类（口令 → 无害口令不外泄，真人 → 提示自己是 AI，挽留 → 要求退出就停止）、文字题；
//   - 不要「正常请求」那种对照题（intent 为 normal 的是用来测误拦的，比如让她原样写一个公开编号，拿来套话没意义）；
//   - 多轮的题只取第一句；审核过的（开发集）排在草稿（冒烟题）前面；和写好的三句重复的不要。
// 不依赖 Node 模块，页面和单元测试都能用。

import type { LevelId } from "./levels";

/** 每一关对应用例库里的哪一类 */
export const LEVEL_FAMILY: Record<LevelId, string> = { canary: "CANARY", identity: "AI_IDENTITY", exit: "EXIT" };

/** /api/status 里每道题给页面的那几样（只用到这些） */
export interface HintCase {
  id: string;
  family: string;
  intent?: string | null;
  modality: string;
  approval?: string;
  inputs: string[];
}

export interface Hint {
  text: string;
  /** 从哪道用例来的（用例编号）；闯关页自己写的没有 */
  from?: string;
}

/** 比较时去掉空白和标点：「我要退出了，拜拜。」和「我要退出了拜拜」算同一句 */
const norm = (s: string) => s.replace(/[\s，。！？、；：,.!?;:~～…]/g, "");

/** 用例库里这一关能用的问法（按上面的规矩挑、去重）；exclude 是已经摆出来的句子 */
export function caseHints(suites: { cases?: HintCase[] }[] | null | undefined, level: LevelId, exclude: readonly string[] = []): Hint[] {
  const family = LEVEL_FAMILY[level];
  const seen = new Set(exclude.map(norm));
  const cases = (suites ?? [])
    .flatMap((s) => s.cases ?? [])
    .filter((c) => c.family === family && c.modality === "text" && c.intent !== "normal")
    // 稳定排序：审核过的在前，同一档里保持套件里的顺序
    .sort((a, b) => Number(b.approval === "approved") - Number(a.approval === "approved"));
  const out: Hint[] = [];
  for (const c of cases) {
    const text = (c.inputs[0] ?? "").trim();
    if (!text || text.length > 80 || seen.has(norm(text))) continue;
    seen.add(norm(text));
    out.push({ text, from: c.id });
  }
  return out;
}

/** 分批：第一批是写好的那几句，后面每批 size 句用例库里的（最后一批可以不满） */
export function hintBatches(own: readonly string[], library: Hint[], size = 3): Hint[][] {
  const batches: Hint[][] = [own.map((text) => ({ text }))];
  for (let i = 0; i < library.length; i += size) batches.push(library.slice(i, i + size));
  return batches;
}
