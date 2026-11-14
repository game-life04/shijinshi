// 攻防地图（ADR-038，借 promptfoo 风险报告的做法）：竖着是七样检查，横着是怎么攻（开场句 + 登记的 5 种套路），
// 每格「攻破几次 / 试了几次」；最右一列是正常题被误拦了几次（太冷也是失分寸）。
// 数据全部来自已经跑完的运行记录（lib/server/attack-map.ts 挑能放在一起比的），不调用模型、不新跑实验。
// 往深做（ADR-039，11-08）：点一格看明细（哪几题、那一句、她说了什么、被哪一层拦住，链到体检单那一例）；
//   「拦住攻击的是哪一层」和闯关四层同一个口径；三档对照。
// 看得懂（ADR-049，11-14 学妹评审：地图太抽象、作用看不出来，「怎么数的」那一串没人有耐心看）：
//   开头一句话先说结论（这一档攻了几题、被攻破几题、破在哪）；格子不再用墨色深浅，改盖「守 / 破 / 疑」印；
//   「拦住攻击的是哪一层」改成一层一行的条（她自己没说 → 规则 → 护栏模型 → 没拦住），三档对照时三档并排；
//   筛选的叫法改短（看哪一档 / 按哪句算 / 用哪批题 / 用哪几次），默认值不变；「怎么数的」留两行，其余收进「详细规则」。
//   数字一个不改：都直接取 AttackMap（说法在 ./summary.ts，各块在 ./parts.tsx）。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { VARIANT_SHORT } from "@/components/wording";
import { type MapLayer, OPENING } from "@/lib/domain/attack-map";
import type { DataLevel, SubjectVariant } from "@/lib/domain/types";
import { attackMap, MAP_VARIANTS, mapRuns } from "@/lib/server/attack-map";
import { loadStrategies } from "@/lib/server/tester";
import { CellDetail, Chip, Filter, HowCounted, MapHead, MapTable, Segs, StopLadder } from "./parts";
import { compareHeadline, headline, markOf, TIER_NAME } from "./summary";

export const dynamic = "force-dynamic";

const SUITE_NAME: Record<string, string> = { dev: "开发集", smoke: "冒烟题（草稿）", heldout: "保留集" };
const LEVEL_NAME: Record<DataLevel, string> = { live: "真实模型", simulation: "模拟数据（非真实模型）" };
const LAYERS: MapLayer[] = ["released", "raw"];
const LAYER_CHIP: Record<MapLayer, { name: string; note: string; title: string }> = {
  released: { name: "最终播出", note: "用户听到的", title: "最终播出（用户真的会听到的）：这题最终不合格就算攻破" },
  raw: { name: "角色原话", note: "护栏之前", title: "角色原话（护栏之前）：她自己的原话越界就算攻破" },
};

export default async function MapPage({ searchParams }: PageProps<"/map">) {
  const sp = await searchParams;
  const all = mapRuns();
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
  const href = (o: Partial<Record<"suite" | "variant" | "level" | "layer" | "runs" | "view" | "cell", string>>) =>
    `/map?${new URLSearchParams({ suite, variant, level, layer, runs: merge ? "all" : "latest", view, ...o }).toString()}`;
  const cellHref = (family: string, column: string) => `${href({ cell: `${family}.${column}` })}#detail`;
  // 点开的那一格：「类别.列」
  const [cellFamily, cellCol] = typeof sp.cell === "string" ? sp.cell.split(".") : [];
  const detailRow = map.rows.find((r) => r.family === cellFamily);
  const detailIdx = map.columns.findIndex((c) => c.id === cellCol);
  const detail = view === "one" && detailRow && detailIdx >= 0 ? detailRow.cells[detailIdx] : null;
  const hints: Record<string, string> = {
    [OPENING]: "用例里人工写好的句子",
    ...Object.fromEntries(loadStrategies().map((s) => [s.id, s.description])),
  };
  // 开头那句结论：一档一张图说这一档，三档对照说三档
  const one = view === "one" ? headline(map, variant, layer) : null;
  const said = one ?? compareHeadline(maps, layer);
  const spot = one?.spot ?? null;
  const unsure = one?.unsure ?? false;
  // 图例里的「疑」：图上有拿不准的格子才说（一档一张图看「疑 n」，三档对照看盖「疑」的格子）
  const legendUnsure =
    layer === "released" &&
    (view === "one"
      ? map.rows.some((r) => r.cells.some((c) => (c?.unsure ?? 0) > 0))
      : maps.some((x) => x.map.rows.some((r) => r.cells.some((c) => markOf(c) === "疑"))));

  return (
    <AppShell active="/map">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            攻防地图
          </h1>
          <p className="text-muted">从跑完的体检记录里数：哪样检查守住了，被哪种套路攻破了。</p>
        </header>

        {!all.length ? (
          <p className="rounded-sm border border-dashed border-border p-3 text-muted">
            还没有能画进地图的体检记录。到
            <Link className="link" href="/workbench">
              体检工作台
            </Link>
            用默认角色跑一次（放行方式用默认的边审边合成），这里就有数了。
          </p>
        ) : (
          <>
            <div className="atk-filters">
              <Filter label="看哪一档">
                {maps.map((x) => (
                  <Chip
                    key={x.v}
                    href={href({ view: "one", variant: x.v })}
                    on={view === "one" && x.v === variant}
                    title={VARIANT_SHORT[x.v]}
                  >
                    {TIER_NAME[x.v]}
                    {/* 这一档没有能放进来的体检时写「还没跑」：「攻破 0/0」会被读成「0 次被攻破」（ADR-049 深度测试） */}
                    <span className="atk-chip-sub">{x.runs.length ? `攻破 ${x.map.total.broken}/${x.map.total.tried}` : "还没跑"}</span>
                  </Chip>
                ))}
                <Chip href={href({ view: "compare" })} on={view === "compare"} title="三档并排：只有人设、加边界提示、再加护栏">
                  三档对照
                </Chip>
              </Filter>
              <div className="atk-filter-row">
                <Filter label="按哪句算">
                  {LAYERS.map((l) => (
                    <Chip key={l} href={href({ layer: l })} on={l === layer} title={LAYER_CHIP[l].title}>
                      {LAYER_CHIP[l].name}
                      <span className="atk-chip-sub">{LAYER_CHIP[l].note}</span>
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
            </div>

            <div className="atk-top" data-view={view}>
              <section className="atk-verdict" data-testid="map-summary" aria-label="结论">
                <p className="atk-lead">
                  <Segs segs={said.lead} />
                  {spot && (
                    <>
                      {" "}
                      <Link className="link atk-spot" href={cellHref(spot.family, spot.column)} scroll={false}>
                        看是哪几题
                      </Link>
                    </>
                  )}
                </p>
                {said.normal && (
                  <p>
                    <Segs segs={said.normal} />
                  </p>
                )}
                {unsure && (
                  <p className="text-muted">
                    {one?.unsureCount && map.total.broken
                      ? `其中 ${one.unsureCount} 题裁判拿不准，格子里标「疑」，不算攻破。`
                      : one?.unsureCount
                        ? "拿不准的格子标「疑」，不算攻破，也不算守住。"
                        : "另有题目裁判拿不准，格子里标「疑」，不算攻破。"}
                  </p>
                )}
                {level === "simulation" && <p className="text-warn">模拟数据只能看机制，不是实验结果。</p>}
                <p className="atk-context">
                  {LEVEL_NAME[level]} · {SUITE_NAME[suite] ?? suite}
                  {view === "one" && ` · ${VARIANT_SHORT[variant]}`}
                </p>
              </section>
              {layer === "released" ? (
                <StopLadder
                  items={(view === "one" ? [cur] : maps).map((x) => ({ v: x.v, stops: x.map.stops, tried: x.map.total.tried }))}
                />
              ) : (
                <p className="atk-panel atk-raw-note">看角色原话时不分是哪一层拦住的：原话在护栏之前。</p>
              )}
            </div>

            <section className="space-y-2" aria-labelledby="atk-map-title">
              <MapHead view={view} unsure={legendUnsure} />
              <MapTable
                view={view}
                layer={layer}
                map={map}
                maps={maps}
                cellHref={cellHref}
                selected={detail ? `${cellFamily}.${cellCol}` : null}
                hints={hints}
              />
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

            <HowCounted />

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
