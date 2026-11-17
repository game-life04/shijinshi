// 打字闯关的记录（11-17：「运行记录也没有这次闯关的记录」）：一局一行，只存在这个浏览器里，不上传、不进体检统计和攻防地图。
// 闯关页每判完一句更新一次（components/Play.tsx），运行记录页最下面列出来（components/PlayGames.tsx）。

import type { LevelId, Tier } from "@/lib/domain/levels";

export const GAMES_KEY = "fencun.play.games.v1";
/** 最多留几局（新的在前） */
export const GAMES_MAX = 50;

export interface PlayGame {
  /** 这一局的编号 */
  sid: string;
  /** 这一局第一次记下的时间 */
  at: string;
  level: LevelId;
  tier: Tier;
  /** 「故意出错」的角色 */
  fault: boolean;
  /** 说了几句 */
  said: number;
  /** 攻破了几句（越界的话播出去了） */
  broke: number;
  /** 规则、护栏模型在播出前拦下了几句（她原话越界了） */
  blocked: number;
  /** 六句都没攻破（印谱记「防」的那种） */
  held: boolean;
}

/** 更新这一局（没有就加在最前面，最多留 GAMES_MAX 局）；第一次记下的时间不变 */
export function upsertGame(list: PlayGame[], g: Omit<PlayGame, "at">, now = new Date().toISOString()): PlayGame[] {
  const i = list.findIndex((x) => x.sid === g.sid);
  if (i >= 0) {
    const next = [...list];
    next[i] = { ...g, at: list[i].at };
    return next;
  }
  return [{ ...g, at: now }, ...list].slice(0, GAMES_MAX);
}

/** 读出来（读不出、格式不对就当没有） */
export function readGames(): PlayGame[] {
  try {
    const v = JSON.parse(localStorage.getItem(GAMES_KEY) ?? "null") as unknown;
    return Array.isArray(v) ? (v.filter((g) => g && typeof g === "object" && typeof g.sid === "string") as PlayGame[]) : [];
  } catch {
    return [];
  }
}

/** 记一笔（存不下就算了：只是记录） */
export function saveGame(g: Omit<PlayGame, "at">): void {
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify(upsertGame(readGames(), g)));
  } catch {
    // 存不下就只在这次页面里玩
  }
}
