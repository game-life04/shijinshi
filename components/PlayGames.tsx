"use client";

// 运行记录页最下面：这个浏览器里打过的闯关（11-17：「运行记录也没有这次闯关的记录」）。
// 闯关只存在浏览器里（lib/client/play-games.ts），不进体检统计、不上攻防地图：一句一句手打的，和整套题的体检不能放在一起数。

import Link from "next/link";
import { useEffect, useState } from "react";
import { type PlayGame, readGames } from "@/lib/client/play-games";
import { LEVELS, TIERS } from "@/lib/domain/levels";

const time = (iso: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));

export default function PlayGames() {
  const [games, setGames] = useState<PlayGame[] | null>(null);
  useEffect(() => setGames(readGames()), []);
  if (games === null) return null;
  return (
    <section className="space-y-2 rounded-sm border border-border bg-surface p-3" data-testid="play-games" aria-label="打字闯关">
      <h2 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        打字闯关
        <span className="text-xs font-normal text-muted">这个浏览器里打过的，只存在这里；不算进上面的体检，也不上攻防地图</span>
      </h2>
      {games.length === 0 ? (
        <p className="text-xs text-muted">
          这个浏览器里还没打过闯关。
          <Link className="underline" href="/play">
            去打字闯关
          </Link>
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left text-xs">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2 font-normal">时间（北京）</th>
                <th className="py-1 pr-2 font-normal">关卡</th>
                <th className="py-1 pr-2 font-normal">难度</th>
                <th className="py-1 pr-2 font-normal">角色</th>
                <th className="py-1 pr-2 font-normal">说了</th>
                <th className="py-1 pr-2 font-normal">攻破</th>
                <th className="py-1 pr-2 font-normal">拦下</th>
                <th className="py-1 font-normal">结果</th>
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.sid} className="border-t border-border" data-fault={g.fault ? "1" : undefined}>
                  <td className="py-1 pr-2 whitespace-nowrap">{time(g.at)}</td>
                  <td className="py-1 pr-2">{LEVELS.find((l) => l.id === g.level)?.title ?? g.level}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    第 {g.tier} 层 · {TIERS.find((t) => t.tier === g.tier)?.short}
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap">{g.fault ? "故意出错" : "平时的角色"}</td>
                  <td className="py-1 pr-2">{g.said} 句</td>
                  <td className="py-1 pr-2">{g.broke} 句</td>
                  <td className="py-1 pr-2">{g.blocked} 句</td>
                  <td className="py-1 whitespace-nowrap">{g.broke > 0 ? "破" : g.held ? "防（六句都没攻破）" : "没打完"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
