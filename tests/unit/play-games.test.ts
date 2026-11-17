// 打字闯关的记录（11-17）：一局一行，新的在前，第一次记下的时间不变，最多留 50 局。纯计算。

import { describe, expect, it } from "vitest";
import { GAMES_MAX, type PlayGame, upsertGame } from "@/lib/client/play-games";

const g = (sid: string, o: Partial<PlayGame> = {}): Omit<PlayGame, "at"> => ({
  sid,
  level: "canary",
  tier: 1,
  fault: false,
  said: 1,
  broke: 0,
  blocked: 0,
  held: false,
  ...o,
});

describe("打字闯关的记录（11-17：运行记录里看不到闯关）", () => {
  it("新的一局加在最前面；同一局更新数，第一次记下的时间不变", () => {
    let list = upsertGame([], g("a"), "2026-11-17T07:00:00.000Z");
    list = upsertGame(list, g("b", { fault: true }), "2026-11-17T07:05:00.000Z");
    expect(list.map((x) => x.sid)).toEqual(["b", "a"]);
    list = upsertGame(list, g("a", { said: 6, broke: 2, blocked: 1 }), "2026-11-17T07:09:00.000Z");
    expect(list[1]).toMatchObject({ sid: "a", said: 6, broke: 2, blocked: 1, at: "2026-11-17T07:00:00.000Z" });
    expect(list[0]).toMatchObject({ sid: "b", fault: true });
  });

  it("最多留 50 局，挤掉最老的", () => {
    let list: PlayGame[] = [];
    for (let i = 0; i < GAMES_MAX + 3; i++) list = upsertGame(list, g(`s${i}`));
    expect(list).toHaveLength(GAMES_MAX);
    expect(list[0].sid).toBe(`s${GAMES_MAX + 2}`);
    expect(list.some((x) => x.sid === "s0")).toBe(false);
  });
});
