// 攻防地图（ADR-038，借 promptfoo 风险报告的做法）：竖着是七样检查，横着是怎么攻（开场句 + 登记的 5 种套路），
// 每格「攻破几次 / 试了几次」，越深攻破得越多；最右一列是正常题被误拦了几次（太冷也是失分寸）。
// 数据全部来自已经跑完的运行记录（lib/server/attack-map.ts 挑能放在一起比的），不调用模型、不新跑实验。
// 切换：被测配置（只有人设 / 加边界提示 / 再加护栏）、看哪一层（最终播出 / 角色原话）、套件、数据等级、最近一次 / 合并全部。
// 往深做（11-08）：
//   点一格看明细：这一格是哪几题、那一句怎么攻的、她说了什么、被哪一层拦住，链到体检单那一例；
//   「拦住攻击的是哪一层」：和闯关四层同一个口径，从真实运行记录数出来（她自己没说 / 规则 / 护栏模型 / 没拦住）；
//   三档对照：每格里并排三档的深浅，三条「哪一层拦住」的条并排——一眼看出护栏为什么要分层。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { VARIANT_SHORT } from "@/components/wording";
import { type AttackMap, inkLevel, type MapCell, type MapLayer, type StopTally } from "@/lib/domain/attack-map";
import { type DataLevel, FAMILIES, FAMILY_LABEL, type Family, type SubjectVariant } from "@/lib/domain/types";
import { attackMap, MAP_VARIANTS, mapRuns } from "@/lib/server/attack-map";

export const dynamic = "force-dynamic";

const SUITE_NAME: Record<string, string> = { dev: "开发集", smoke: "冒烟题（草稿）", heldout: "保留集" };
const LAYER_NAME: Record<MapLayer, string> = { released: "最终播出（用户真的会听到的）", raw: "角色原话（护栏之前）" };
const LEVEL_NAME: Record<DataLevel, string> = { live: "真实模型", simulation: "模拟数据（非真实模型）" };
const LAYERS: MapLayer[] = ["released", "raw"];
const VARIANT_TINY: Record<string, string> = { B0: "人设", B1: "边界", B2: "护栏" };

/** 「哪一层拦住」的四段 + 没拦住：她自己没说用淡墨，规则、护栏模型用朱红（拦），没拦住用墨黑（同「不合格」） */
const STOP_PARTS: { key: keyof StopTally; label: string; bg: string; fg?: string }[] = [
  { key: "persona", label: "她自己没说（只靠人设）", bg: "color-mix(in srgb, var(--foreground) 10%, var(--surface))" },
  { key: "prompt", label: "她自己没说（边界提示管住了）", bg: "color-mix(in srgb, var(--foreground) 22%, var(--surface))" },
  { key: "rules", label: "规则拦住", bg: "color-mix(in srgb, var(--primary) 45%, var(--surface))" },
  { key: "model", label: "护栏模型拦住", bg: "var(--primary)", fg: "var(--surface)" },
  { key: "broken", label: "没拦住", bg: "color-mix(in srgb, var(--foreground) 88%, var(--surface))", fg: "var(--surface)" },
];

const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");
const ink = (level: number) => `color-mix(in srgb, var(--foreground) ${Math.round(level * 88)}%, var(--surface))`;
const hatch = { backgroundImage: "repeating-linear-gradient(135deg, transparent 0 6px, var(--border) 6px 7px)" };

function Cell({ cell, href, selected, delay }: { cell: MapCell | null; href: string; selected: boolean; delay: number }) {
  if (!cell) {
    return (
      <td
        className="border border-border px-2 py-2 text-center text-[11px] text-muted"
        style={hatch}
        title="这一类不让测试 Agent 用这个套路"
      >
        不适用
      </td>
    );
  }
  const level = inkLevel(cell);
  if (level === null) return <td className="border border-border px-2 py-2 text-center text-[11px] text-muted">没测</td>;
  const dark = level > 0.5;
  return (
    <td
      className={`ink-in border border-border p-0 text-center tabular-nums ${selected ? "outline-2 -outline-offset-2 outline-primary" : ""}`}
      style={{ background: ink(level), color: dark ? "var(--surface)" : undefined, animationDelay: `${delay}ms` }}
      title={cell.cases.length ? `被攻破的题：${cell.cases.join("、")}（点开看明细）` : "没被攻破（点开看明细）"}
      data-broken={cell.broken}
      data-tried={cell.tried}
    >
      <Link
        href={href}
        scroll={false}
        className="block px-2 py-2 hover:underline"
        aria-label={`攻破 ${cell.broken} 次，试了 ${cell.tried} 次，看明细`}
      >
        <span className="font-semibold">{cell.broken}</span>
        <span className={dark ? "" : "text-muted"}> / {cell.tried}</span>
        {cell.unsure > 0 && <span className="block text-[10px]">另 {cell.unsure} 题不确定</span>}
      </Link>
    </td>
  );
}

/** 三档对照的一格：三档各一个小方块，深浅是攻破率 */
function CompareCell({ cells }: { cells: { v: SubjectVariant; cell: MapCell | null }[] }) {
  if (cells.every((x) => !x.cell)) {
    return (
      <td className="border border-border px-2 py-2 text-center text-[11px] text-muted" style={hatch}>
        不适用
      </td>
    );
  }
  return (
    <td className="border border-border px-1.5 py-1.5">
      <div className="flex justify-center gap-0.5">
        {cells.map(({ v, cell }) => {
          const level = inkLevel(cell);
          return (
            <span
              key={v}
              className="flex h-9 w-9 flex-col items-center justify-center rounded-[2px] border border-border text-[10px] leading-tight tabular-nums"
              style={level === null ? undefined : { background: ink(level), color: level > 0.5 ? "var(--surface)" : undefined }}
              title={`${VARIANT_SHORT[v]}：${cell?.tried ? `攻破 ${cell.broken} / 试了 ${cell.tried}` : "没测"}`}
            >
              <span className="opacity-70">{VARIANT_TINY[v]}</span>
              <span>{cell?.tried ? `${cell.broken}/${cell.tried}` : "—"}</span>
            </span>
          );
        })}
      </div>
    </td>
  );
}

/** 「拦住攻击的是哪一层」：一条横条，按题数分段 */
function StopBar({ stops, label }: { stops: StopTally; label?: string }) {
  const n = STOP_PARTS.reduce((s, p) => s + stops[p.key], 0);
  if (!n) return null;
  return (
    <div className="space-y-1" data-testid="stop-bar">
      {label && <p className="text-[11px] text-muted">{label}</p>}
      <div
        className="bar-grow flex h-6 w-full overflow-hidden rounded-sm border border-border text-[11px]"
        role="img"
        aria-label={STOP_PARTS.filter((p) => stops[p.key])
          .map((p) => `${p.label} ${stops[p.key]} 题`)
          .join("，")}
      >
        {STOP_PARTS.filter((p) => stops[p.key]).map((p) => (
          <span
            key={p.key}
            className="flex items-center justify-center overflow-hidden whitespace-nowrap"
            style={{ width: `${(stops[p.key] / n) * 100}%`, background: p.bg, color: p.fg }}
            title={`${p.label} ${stops[p.key]} 题`}
          >
            {stops[p.key]}
          </span>
        ))}
      </div>
    </div>
  );
}

function StopLegend() {
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted" aria-hidden>
      {STOP_PARTS.map((p) => (
        <span key={p.key} className="inline-flex items-center gap-1">
          <span className="inline-block h-2.5 w-3.5 rounded-[2px] border border-border" style={{ background: p.bg }} />
          {p.label}
        </span>
      ))}
    </p>
  );
}

function stopSay(e: { broken: boolean; unsure: boolean; stopped: string | null }, layer: MapLayer): string {
  if (e.broken) return "就是这一句攻破的";
  if (e.unsure) return "裁判拿不准，等人工看";
  if (layer === "raw") return "原话没越界";
  return STOP_PARTS.find((p) => p.key === e.stopped)?.label ?? "这题在别的那一句被攻破了";
}

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={`rounded-sm px-2 py-1 whitespace-nowrap ${on ? "bg-foreground text-surface" : "border border-border hover:bg-background"}`}
    >
      {children}
    </Link>
  );
}

const TH = "border border-border bg-background px-2 py-1.5 font-medium";

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
  const normal = map.rows.reduce((s, r) => ({ tried: s.tried + r.normal.tried, blocked: s.blocked + r.normal.blocked }), {
    tried: 0,
    blocked: 0,
  });
  // 点开的那一格：「类别.列」
  const [cellFamily, cellCol] = typeof sp.cell === "string" ? sp.cell.split(".") : [];
  const detailRow = map.rows.find((r) => r.family === cellFamily);
  const detailIdx = map.columns.findIndex((c) => c.id === cellCol);
  const detail = view === "one" && detailRow && detailIdx >= 0 ? detailRow.cells[detailIdx] : null;
  const rowOf = (m: AttackMap, f: Family) => m.rows.find((r) => r.family === f);

  return (
    <AppShell active="/map">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            攻防地图
          </h1>
          <p
            className="text-muted"
            title="竖着是七样检查，横着是用例里写好的开场句和测试 Agent 能用的 5 种套路；每格「攻破几次 / 试了几次」。全部从跑完的体检记录里数出来，不新跑实验。"
          >
            越黑越容易被攻破，点一格看是哪几题。
          </p>
        </div>

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
            <div className="space-y-2 rounded-sm border border-border bg-surface p-3 text-xs">
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="怎么看">
                <span className="w-16 text-muted">怎么看</span>
                <Chip href={href({ view: "one" })} on={view === "one"}>
                  一档一张图
                </Chip>
                <Chip href={href({ view: "compare" })} on={view === "compare"}>
                  三档对照
                </Chip>
              </nav>
              {view === "one" && (
                <nav className="flex flex-wrap items-center gap-1.5" aria-label="被测配置">
                  <span className="w-16 text-muted">被测配置</span>
                  {maps.map((x) => (
                    <Chip key={x.v} href={href({ variant: x.v })} on={x.v === variant}>
                      {VARIANT_SHORT[x.v]} · 攻破 {x.map.total.broken}/{x.map.total.tried}
                    </Chip>
                  ))}
                </nav>
              )}
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="看哪一层">
                <span className="w-16 text-muted">看哪一层</span>
                {LAYERS.map((l) => (
                  <Chip key={l} href={href({ layer: l })} on={l === layer}>
                    {LAYER_NAME[l]}
                  </Chip>
                ))}
              </nav>
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="套件和数据">
                <span className="w-16 text-muted">用哪批题</span>
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
              </nav>
              <nav
                className="flex flex-wrap items-center gap-1.5"
                aria-label="用哪几次"
                title="代码一直在改，默认只看每个配置最近一次；合并以后次数多，但混着改之前的结果"
              >
                <span className="w-16 text-muted">用哪几次</span>
                <Chip href={href({ runs: "latest" })} on={!merge}>
                  每个配置最近一次
                </Chip>
                <Chip href={href({ runs: "all" })} on={merge}>
                  合并跑过的全部
                </Chip>
              </nav>
            </div>

            {view === "one" ? (
              <p className="text-xs" data-testid="map-summary">
                {LEVEL_NAME[level]} · {SUITE_NAME[suite] ?? suite} · {VARIANT_SHORT[variant]} · 看{LAYER_NAME[layer]}：攻击题被攻破{" "}
                <strong>
                  {map.total.broken} / {map.total.tried}
                </strong>
                （{pct(map.total.broken, map.total.tried)}）；正常题被误拦{" "}
                <strong>
                  {normal.blocked} / {normal.tried}
                </strong>
                。{level === "simulation" && <span className="text-warn"> 模拟数据只能看机制，不是实验结果。</span>}
              </p>
            ) : (
              <p className="text-xs" data-testid="map-summary">
                {LEVEL_NAME[level]} · {SUITE_NAME[suite] ?? suite} · 看{LAYER_NAME[layer]}
                ：每格里三个小方块依次是只有人设、加边界提示、再加护栏。
                {maps.map((x) => ` ${VARIANT_TINY[x.v]} 攻破 ${x.map.total.broken}/${x.map.total.tried}`).join("；")}。
                {level === "simulation" && <span className="text-warn"> 模拟数据只能看机制，不是实验结果。</span>}
              </p>
            )}

            {layer === "released" && (
              <section className="space-y-2 rounded-sm border border-border bg-surface p-3" aria-label="拦住攻击的是哪一层">
                <h2
                  className="text-sm"
                  style={{ fontFamily: "var(--font-kai)" }}
                  title="和打字闯关的四层同一个口径：护栏拦下的句子按规则判的、护栏模型判的分开记；服务层动了（说要走就停、补求助信息、时长提醒）算规则；都没动、也没越界，就是她自己没说。"
                >
                  拦住攻击的是哪一层
                </h2>
                {view === "one" ? (
                  <StopBar stops={map.stops} />
                ) : (
                  maps.map((x) => <StopBar key={x.v} stops={x.map.stops} label={VARIANT_SHORT[x.v]} />)
                )}
                <StopLegend />
              </section>
            )}

            <div className="overflow-x-auto" data-testid="attack-map">
              <table className="w-full min-w-[760px] border-collapse text-xs">
                <thead>
                  <tr>
                    <th className={`${TH} text-left`}>检查 ＼ 怎么攻</th>
                    {map.columns.map((c) => (
                      <th key={c.id} className={TH}>
                        {c.title}
                      </th>
                    ))}
                    <th className={TH} title="正常题不是攻击：被拦下就是误拦">
                      正常题被误拦
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {FAMILIES.map((family) => {
                    const r = rowOf(map, family);
                    if (!r) return null;
                    return (
                      <tr key={family}>
                        <th scope="row" className="border border-border px-2 py-1.5 text-left font-normal whitespace-nowrap">
                          {FAMILY_LABEL[family]}
                        </th>
                        {map.columns.map((c, i) =>
                          view === "one" ? (
                            <Cell
                              key={c.id}
                              cell={r.cells[i]}
                              href={`${href({ cell: `${family}.${c.id}` })}#detail`}
                              selected={family === cellFamily && c.id === cellCol}
                              delay={(FAMILIES.indexOf(family) + i) * 45}
                            />
                          ) : (
                            <CompareCell key={c.id} cells={maps.map((x) => ({ v: x.v, cell: rowOf(x.map, family)?.cells[i] ?? null }))} />
                          ),
                        )}
                        <td className="border border-border px-2 py-1.5 text-center tabular-nums">
                          {view === "one" ? (
                            r.normal.tried ? (
                              <>
                                <span className={r.normal.blocked ? "font-semibold text-bad" : ""}>{r.normal.blocked}</span>
                                <span className="text-muted"> / {r.normal.tried}</span>
                              </>
                            ) : (
                              <span className="text-[11px] text-muted">没测</span>
                            )
                          ) : (
                            <span className="text-[11px]">
                              {maps
                                .map((x) => {
                                  const n = rowOf(x.map, family)?.normal;
                                  return n?.tried ? `${n.blocked}/${n.tried}` : "—";
                                })
                                .join(" · ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted" aria-hidden>
              <span>没被攻破</span>
              <span
                className="h-2.5 w-40 rounded-sm border border-border"
                style={{ background: "linear-gradient(90deg, var(--surface), color-mix(in srgb, var(--foreground) 88%, var(--surface)))" }}
              />
              <span>每次都被攻破</span>
              {view === "one" && <span className="ml-2">点一格看明细</span>}
            </div>

            {detail && detailRow && (
              <section
                id="detail"
                className="scroll-mt-16 space-y-2 rounded-sm border border-foreground/30 bg-surface p-3"
                data-testid="map-detail"
              >
                <h2 className="text-sm">
                  <span style={{ fontFamily: "var(--font-kai)" }}>
                    {FAMILY_LABEL[detailRow.family]} × {map.columns[detailIdx].title}
                  </span>
                  <span className="ml-2 text-xs text-muted">
                    {VARIANT_SHORT[variant]} · 攻破 {detail.broken} / 试了 {detail.tried}
                  </span>
                  <Link href={href({ cell: "" })} scroll={false} className="link ml-2 text-xs">
                    收起
                  </Link>
                </h2>
                <ol className="space-y-2 text-xs">
                  {detail.entries.map((e) => (
                    <li key={`${e.run_id}-${e.case_id}`} className="rounded-sm border border-border p-2">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link className="link font-medium" href={`/reports/${e.run_id}#case-${e.no}`}>
                          {e.case_id}
                        </Link>
                        <span
                          className={
                            e.broken
                              ? "rounded-sm bg-foreground px-1 text-surface"
                              : e.stopped === "rules" || e.stopped === "model"
                                ? "text-primary"
                                : "text-muted"
                          }
                        >
                          {stopSay(e, layer)}
                        </span>
                      </p>
                      <p className="mt-1">
                        <span className="text-muted">这一句：</span>
                        {e.attack}
                      </p>
                      <p className="mt-0.5">
                        <span className="text-muted">她说出口的：</span>
                        {e.said}
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <details className="rounded-sm border border-border bg-surface p-3 text-xs">
              <summary className="cursor-pointer">怎么数的</summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                <li>只数越界题和含糊题；正常题不是攻击，单独算「被误拦」。只数跑完的题。</li>
                <li>
                  一题里测试 Agent
                  可能换几种套路：用到的每一种都算「试了一次」；这题被攻破，只算在攻破那一句用的套路上（看结论摘出的原话落在哪一轮，摘不到就算开场句）。
                </li>
                <li>
                  看最终播出：这题最终不合格就算攻破；「不确定」的不算攻破，格子里另写。看角色原话：角色原话越界就算攻破，判断不了、只查服务层的题不算进这一层。
                </li>
                <li>
                  身份、时长、退出、危机、未成年这几类只用人工写好的句子测，不让测试 Agent
                  自由出招（套路登记表里写着），所以这几行只有「开场句」一列有数。
                </li>
                <li>只放能放在一起比的记录：默认角色、边审边合成、没加护栏固定延迟；套件、配置、真实 / 模拟都分开算。</li>
                <li>
                  时长提醒、说要走就停是服务层做的，只有「再加护栏」这一档有；只有人设、加边界提示这两档，这两行在结构上就过不了，深色是意料之中的。
                </li>
              </ul>
            </details>

            <details className="rounded-sm border border-border bg-surface p-3 text-xs">
              <summary className="cursor-pointer">
                这张图用了哪几次体检（{view === "one" ? runs.length : maps.reduce((s, x) => s + x.runs.length, 0)} 次
                {view === "one" && !merge && available > 1 ? `，这个配置一共跑过 ${available} 次` : ""}）
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
