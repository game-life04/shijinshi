// 攻防地图（ADR-038，借 promptfoo 风险报告的做法）：竖着是七样检查，横着是怎么攻（开场句 + 登记的 5 种套路），
// 每格「攻破几次 / 试了几次」；最右一列是正常题被误拦了几次（太冷也是失分寸）。
// 数据全部来自已经跑完的运行记录（lib/server/attack-map.ts 挑能放在一起比的），不调用模型、不新跑实验。
// 往深做（ADR-039，11-08）：点一格看明细（哪几题、那一句、她说了什么、被哪一层拦住，链到体检单那一例）；
//   「拦住攻击的是哪一层」和闯关四层同一个口径；三档对照。
// 看得懂（ADR-049，11-14 学妹评审：地图太抽象、作用看不出来，「怎么数的」那一串没人有耐心看）：
//   格子不再用墨色深浅，改盖「守 / 破 / 疑」印；「拦住攻击的是哪一层」改成一层一行的条；筛选的叫法改短，默认值不变。
// 只看自己的（ADR-051，11-15 队员 B：「还没开始测，为什么就有标记和统计图」——原来画的是全站所有人跑过的体检）：
//   配了账号时默认只数自己发起的（和运行记录页一样），自己还没跑过就说清楚、给去工作台的按钮，可以切到「全站」；
//   没配账号（本机、评委自己电脑上）不分人。
// ADR-053（11-16 队员 B 修改稿 3，「这是啥看不懂，换一种易懂形式」）：先看哪项没守住，再查看对应问题和原话。
//   筛选收成一条；第一行三张大卡片「测试了 / 守住了 / 没守住」；左下「七项检查结果」（一样一行：横条 + 守住几题），
//   右下「本次要看这 N 个问题」（没守住的格子一条：打开对应体检单、查看原话、查看三档对照）；
//   原来的地图、「拦住攻击的是哪一层」、怎么数的收进「详细矩阵」折叠，默认收着，点开一格（cell=…、#detail）时自己展开。
//   三档对照：三档各一组小卡片 + 七项三档并排，详细矩阵里是原来的三档对照。
//   数字一个不编：卡片 = cardsOf(map.total)，七项 = 每行的 MapRow.total（口径见 ./summary.ts 开头）。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { VARIANT_SHORT } from "@/components/wording";
import { type MapLayer, OPENING } from "@/lib/domain/attack-map";
import type { DataLevel, Family, SubjectVariant } from "@/lib/domain/types";
import { attackMap, MAP_VARIANTS, mapRuns } from "@/lib/server/attack-map";
import { authConfig } from "@/lib/server/auth";
import { getSession } from "@/lib/server/session";
import { loadStrategies } from "@/lib/server/tester";
import MatrixFold from "./MatrixFold";
import {
  Cards,
  CellDetail,
  CheckCompare,
  CheckList,
  Chip,
  Filter,
  HowCounted,
  IssueList,
  MapHead,
  MapTable,
  Seal,
  StopLadder,
  TierCards,
} from "./parts";
import { cardsOf, markOf, normalTotals, TIER_NAME } from "./summary";

export const dynamic = "force-dynamic";

// 保留集封存，不上地图（ADR-050）
const SUITE_NAME: Record<string, string> = { dev: "开发集", smoke: "冒烟题（草稿）" };
const LEVEL_NAME: Record<DataLevel, string> = { live: "真实模型", simulation: "模拟数据（非真实模型）" };
const LAYERS: MapLayer[] = ["released", "raw"];
const LAYER_CHIP: Record<MapLayer, { name: string; title: string }> = {
  released: { name: "最终播出", title: "最终播出（用户真的会听到的）：这题最终不合格就算没守住" },
  raw: { name: "角色原话", title: "角色原话（护栏之前）：她自己的原话越界就算没守住" },
};

/** 空地图里的两个按钮：和 components/ui.tsx 的 Button 一个样子 */
const mapButton =
  "inline-flex h-8 items-center gap-1.5 rounded-sm border border-border bg-surface px-3 text-sm font-medium hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  const sp = await searchParams;
  const everyone = mapRuns();
  const me = authConfig().mode === "accounts" ? (await getSession())?.account : undefined;
  const whose = me && sp.who !== "all" ? "mine" : "all";
  const all = whose === "mine" ? everyone.filter((m) => m.created_by === me) : everyone;
  const suites = [...new Set(all.map((m) => m.config.suite))].sort((a, b) => (a === "dev" ? -1 : b === "dev" ? 1 : a.localeCompare(b)));
  const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  const suite = pick(sp.suite, suites, suites[0] ?? "dev");
  const levels = [...new Set(all.filter((m) => m.config.suite === suite).map((m) => m.data_level))];
  const level = pick<DataLevel>(sp.level, levels, levels.includes("live") ? "live" : (levels[0] ?? "live"));
  const variant = pick<SubjectVariant>(sp.variant, MAP_VARIANTS, "B2");
  const layer = pick<MapLayer>(sp.layer, LAYERS, "released");
  const view = sp.view === "compare" ? "compare" : "one";
  const merge = sp.runs === "all";
  const maps = MAP_VARIANTS.map((v) => ({ v, ...attackMap({ suite, variant: v, level, layer, all: merge }, all) }));
  const cur = maps.find((x) => x.v === variant) ?? maps[0];
  const { runs, available, map } = cur;
  const href = (o: Partial<Record<"suite" | "variant" | "level" | "layer" | "runs" | "view" | "cell" | "who", string>>) =>
    `/map?${new URLSearchParams({ ...(me ? { who: whose } : {}), suite, variant, level, layer, runs: merge ? "all" : "latest", view, ...o }).toString()}`;
  const cellHref = (family: string, column: string) => `${href({ cell: `${family}.${column}` })}#detail`;
  // 「查看三档对照」：换到三档对照，详细矩阵展开，框出这一格、跳到这一样检查的三行（ADR-053）
  const compareHref = (family: Family, column: string) => `${href({ view: "compare", cell: `${family}.${column}` })}#cmp-${family}`;
  // 点开的那一格：「类别.列」（三档的行列一样，用这一档的图认）
  const [cellFamily, cellCol] = typeof sp.cell === "string" ? sp.cell.split(".") : [];
  const detailRow = map.rows.find((r) => r.family === cellFamily);
  const detailIdx = map.columns.findIndex((c) => c.id === cellCol);
  const picked = detailRow && detailIdx >= 0 && detailRow.cells[detailIdx] ? `${cellFamily}.${cellCol}` : null;
  const detail = view === "one" && picked && detailRow ? detailRow.cells[detailIdx] : null;
  const hints: Record<string, string> = {
    [OPENING]: "用例里人工写好的句子",
    ...Object.fromEntries(loadStrategies().map((s) => [s.id, s.description])),
  };
  // 图例里的「疑」：图上有拿不准的格子才说（一档一张图看「疑 n」，三档对照看盖「疑」的格子）
  const legendUnsure =
    layer === "released" &&
    (view === "one"
      ? map.rows.some((r) => r.cells.some((c) => (c?.unsure ?? 0) > 0))
      : maps.some((x) => x.map.rows.some((r) => r.cells.some((c) => markOf(c) === "疑"))));
  // 三张卡片（ADR-053）：测试了 = 守住了 + 没守住 + 拿不准（cardsOf，口径见 ./summary.ts 开头）；正常题另说
  const cards = cardsOf(map.total);
  const normal = normalTotals(map);

  return (
    <AppShell active="/map">
      <div className="atk-page mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            攻防地图
          </h1>
          <p className="text-muted">先看哪项没守住，再查看对应问题和原话。</p>
        </header>

        {!all.length ? (
          <>
            {me && (
              <Filter label="看谁的">
                <Chip href="/map" on={whose === "mine"}>
                  我的
                </Chip>
                <Chip href="/map?who=all" on={whose === "all"} title="网站上所有账号跑过的体检">
                  全站
                </Chip>
              </Filter>
            )}
            <div className="space-y-3 rounded-sm border border-dashed border-border p-4" data-testid="map-empty">
              <p>
                {whose === "mine" ? "你还没跑过体检，这里还没有你的数。" : "还没有能画进地图的体检记录。"}
                到体检工作台用默认角色点「开始体检」，跑完这里就画出来。
              </p>
              <div className="flex flex-wrap gap-2">
                <Link className={mapButton} href="/workbench">
                  去体检工作台
                </Link>
                {whose === "mine" && everyone.length > 0 && (
                  <Link className={mapButton} href="/map?who=all">
                    先看全站的（{everyone.length} 次体检）
                  </Link>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            {/* 筛选收成一条（ADR-053）：按钮里不再带小字，说明放在悬停里；这一档没跑过才写「还没跑」 */}
            <div className="atk-filters">
              {me && (
                <Filter label="看谁的">
                  <Chip href="/map" on={whose === "mine"}>
                    我的
                  </Chip>
                  <Chip href="/map?who=all" on={whose === "all"} title="网站上所有账号跑过的体检">
                    全站
                  </Chip>
                </Filter>
              )}
              <Filter label="看哪一档">
                {maps.map((x) => (
                  <Chip
                    key={x.v}
                    href={href({ view: "one", variant: x.v })}
                    on={view === "one" && x.v === variant}
                    title={VARIANT_SHORT[x.v]}
                  >
                    {TIER_NAME[x.v]}
                    {/* 这一档没有能放进来的体检时写「还没跑」：0 题会被读成「全守住了」（ADR-049 深度测试） */}
                    {!x.runs.length && <span className="atk-chip-sub">还没跑</span>}
                  </Chip>
                ))}
                <Chip href={href({ view: "compare" })} on={view === "compare"} title="三档并排：只有人设、加边界提示、再加护栏">
                  三档对照
                </Chip>
              </Filter>
              <Filter label="按哪句算">
                {LAYERS.map((l) => (
                  <Chip key={l} href={href({ layer: l })} on={l === layer} title={LAYER_CHIP[l].title}>
                    {LAYER_CHIP[l].name}
                  </Chip>
                ))}
              </Filter>
              <Filter label="用哪批题">
                {suites.map((s) => (
                  <Chip key={s} href={href({ suite: s, level: "" })} on={s === suite}>
                    {SUITE_NAME[s] ?? s}
                  </Chip>
                ))}
                {levels.length > 1 &&
                  levels.map((l) => (
                    <Chip key={l} href={href({ level: l })} on={l === level}>
                      {LEVEL_NAME[l]}
                    </Chip>
                  ))}
              </Filter>
              <Filter label="用哪几次" title="代码一直在改，默认只看每档最近一次；合并以后次数多，但混着改之前的结果">
                <Chip href={href({ runs: "latest" })} on={!merge}>
                  最近一次
                </Chip>
                <Chip href={href({ runs: "all" })} on={merge}>
                  合并全部
                </Chip>
              </Filter>
            </div>

            {view === "one" ? (
              <>
                <section
                  className="atk-summary"
                  data-testid="map-summary"
                  data-view="one"
                  data-layer={layer}
                  data-tried={cards.tried}
                  data-held={cards.held}
                  data-broken={cards.broken}
                  data-unsure={cards.unsure}
                  aria-label={`${TIER_NAME[variant]}这一档的结果`}
                >
                  <Cards t={cards} />
                  {/* 拿不准、正常题被误拦都单独说，不进上面三个数以外的地方（ADR-053） */}
                  <p className="atk-notes">
                    {cards.unsure > 0 && (
                      <span data-note="unsure">
                        <Seal mark="疑" small /> 拿不准 <b>{cards.unsure}</b> 题：不算守住，也不算没守住
                      </span>
                    )}
                    {normal.tried > 0 && (
                      <span data-note="normal">
                        正常题 <b>{normal.tried}</b> 题，被误拦 <b data-bad={normal.blocked ? "1" : undefined}>{normal.blocked}</b>{" "}
                        题（不算在上面）
                      </span>
                    )}
                    {layer === "raw" && <span>按角色原话算：判断不了原话的题不算</span>}
                    {level === "simulation" && <span className="text-warn">模拟数据只能看机制，不是实验结果。</span>}
                  </p>
                </section>
                <div className="atk-grid">
                  <CheckList map={map} layer={layer} />
                  <IssueList map={map} layer={layer} ran={runs.length > 0} hints={hints} cellHref={cellHref} compareHref={compareHref} />
                </div>
              </>
            ) : (
              <>
                <section
                  className="atk-summary"
                  data-testid="map-summary"
                  data-view="compare"
                  data-layer={layer}
                  aria-label="三档对照的结果"
                >
                  <TierCards
                    tiers={maps.map((x) => ({ v: x.v, map: x.map, ran: x.runs.length > 0 }))}
                    tierHref={(v) => href({ view: "one", variant: v })}
                  />
                  {(layer === "raw" || level === "simulation") && (
                    <p className="atk-notes">
                      {layer === "raw" && <span>按角色原话算：判断不了原话的题不算</span>}
                      {level === "simulation" && <span className="text-warn">模拟数据只能看机制，不是实验结果。</span>}
                    </p>
                  )}
                </section>
                <CheckCompare tiers={maps} layer={layer} />
              </>
            )}

            <MatrixFold
              openKey={picked ? `${view}:${picked}` : null}
              summary={
                <summary className="atk-fold-head">
                  <span className="atk-fold-title">详细矩阵</span>
                  <span className="atk-fold-sub">七样检查 × 怎么攻 · 拦住攻击的是哪一层 · 怎么数的</span>
                </summary>
              }
            >
              <div className="atk-fold-body">
                <section className="space-y-2" aria-labelledby="atk-map-title">
                  <MapHead view={view} unsure={legendUnsure} />
                  <MapTable view={view} layer={layer} map={map} maps={maps} cellHref={cellHref} selected={picked} hints={hints} />
                </section>

                {detail && detailRow && (
                  <CellDetail
                    family={detailRow.family}
                    title={map.columns[detailIdx].title}
                    tier={`${TIER_NAME[variant]}（${variant}）`}
                    cell={detail}
                    layer={layer}
                    closeHref={href({ cell: "" })}
                  />
                )}

                {layer === "released" ? (
                  <StopLadder
                    items={(view === "one" ? [cur] : maps).map((x) => ({ v: x.v, stops: x.map.stops, tried: x.map.total.tried }))}
                  />
                ) : (
                  <p className="atk-panel atk-raw-note">看角色原话时不分是哪一层拦住的：原话在护栏之前。</p>
                )}

                <HowCounted />
              </div>
            </MatrixFold>

            <details className="atk-panel text-xs">
              <summary className="cursor-pointer">
                这张图用了哪几次体检（{view === "one" ? runs.length : maps.reduce((s, x) => s + x.runs.length, 0)} 次
                {view === "one" && !merge && available > 1 ? `，这一档一共跑过 ${available} 次` : ""}）
              </summary>
              <ul className="mt-2 space-y-0.5">
                {(view === "one" ? [cur] : maps).flatMap((x) =>
                  x.runs.map((m) => (
                    <li key={m.run_id}>
                      <Link className="link" href={`/reports/${m.run_id}`}>
                        {m.run_id}
                      </Link>
                      <span className="text-muted">
                        {" "}
                        · {VARIANT_SHORT[m.config.variant]} · {m.counts.completed} 题 ·{" "}
                        {new Date(m.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                      </span>
                    </li>
                  )),
                )}
              </ul>
            </details>
          </>
        )}
      </div>
    </AppShell>
  );
}
