// 攻防地图（ADR-038，借 promptfoo 风险报告的做法）：竖着是七样检查，横着是怎么攻（开场句 + 登记的 5 种套路），
// 每格「攻破几次 / 试了几次」，越深攻破得越多；最右一列是正常题被误拦了几次（太冷也是失分寸）。
// 数据全部来自已经跑完的运行记录（lib/server/attack-map.ts 挑能放在一起比的），不调用模型、不新跑实验。
// 切换：被测配置（只有人设 / 加边界提示 / 再加护栏）、看哪一层（最终播出 / 角色原话）、套件、数据等级。

import Link from "next/link";
import AppShell from "@/components/AppShell";
import { VARIANT_SHORT } from "@/components/wording";
import { inkLevel, type MapCell, type MapLayer } from "@/lib/domain/attack-map";
import { type DataLevel, FAMILY_LABEL, type SubjectVariant } from "@/lib/domain/types";
import { attackMap, MAP_VARIANTS, mapRuns } from "@/lib/server/attack-map";

export const dynamic = "force-dynamic";

const SUITE_NAME: Record<string, string> = { dev: "开发集", smoke: "冒烟题（草稿）", heldout: "保留集" };
const LAYER_NAME: Record<MapLayer, string> = { released: "最终播出（用户真的会听到的）", raw: "角色原话（护栏之前）" };
const LEVEL_NAME: Record<DataLevel, string> = { live: "真实模型", simulation: "模拟数据（非真实模型）" };
const LAYERS: MapLayer[] = ["released", "raw"];

const pct = (k: number, n: number) => (n ? `${Math.round((k / n) * 100)}%` : "—");

function Cell({ cell }: { cell: MapCell | null }) {
  if (!cell) {
    return (
      <td
        className="border border-border px-2 py-2 text-center text-[11px] text-muted"
        style={{ backgroundImage: "repeating-linear-gradient(135deg, transparent 0 6px, var(--border) 6px 7px)" }}
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
      className="border border-border px-2 py-2 text-center tabular-nums"
      style={{
        background: `color-mix(in srgb, var(--foreground) ${Math.round(level * 88)}%, var(--surface))`,
        color: dark ? "var(--surface)" : undefined,
      }}
      title={cell.cases.length ? `被攻破的题：${cell.cases.join("、")}` : "没被攻破"}
      data-broken={cell.broken}
      data-tried={cell.tried}
    >
      <span className="font-semibold">{cell.broken}</span>
      <span className={dark ? "" : "text-muted"}> / {cell.tried}</span>
      {cell.unsure > 0 && <span className="block text-[10px]">另 {cell.unsure} 题不确定</span>}
    </td>
  );
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
  const merge = sp.runs === "all";
  const { runs, available, map } = attackMap({ suite, variant, level, layer, all: merge }, all);
  const byVariant = MAP_VARIANTS.map((v) => ({ v, ...attackMap({ suite, variant: v, level, layer, all: merge }, all).map.total }));
  const href = (o: Partial<Record<"suite" | "variant" | "level" | "layer" | "runs", string>>) =>
    `/map?${new URLSearchParams({ suite, variant, level, layer, runs: merge ? "all" : "latest", ...o }).toString()}`;
  const normal = map.rows.reduce((s, r) => ({ tried: s.tried + r.normal.tried, blocked: s.blocked + r.normal.blocked }), {
    tried: 0,
    blocked: 0,
  });

  return (
    <AppShell active="/map">
      <div className="mx-auto w-full max-w-6xl space-y-4 p-4 text-sm">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            攻防地图
          </h1>
          <p className="text-muted">
            竖着是七样检查，横着是怎么攻：用例里写好的开场句，和测试 Agent 能用的 5 种套路。每格写「攻破几次 /
            试了几次」，墨色越深，攻破得越多。全部从跑完的体检记录里数出来，不新跑实验。
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
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="被测配置">
                <span className="w-16 text-muted">被测配置</span>
                {byVariant.map((x) => (
                  <Chip key={x.v} href={href({ variant: x.v })} on={x.v === variant}>
                    {VARIANT_SHORT[x.v]} · 攻破 {x.broken}/{x.tried}
                  </Chip>
                ))}
              </nav>
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
              <nav className="flex flex-wrap items-center gap-1.5" aria-label="用哪几次">
                <span className="w-16 text-muted">用哪几次</span>
                <Chip href={href({ runs: "latest" })} on={!merge}>
                  每个配置最近一次
                </Chip>
                <Chip href={href({ runs: "all" })} on={merge}>
                  合并跑过的全部
                </Chip>
                <span className="text-muted">代码一直在改，默认只看最近一次；合并以后次数多，但混着改之前的结果</span>
              </nav>
            </div>

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

            <div className="overflow-x-auto" data-testid="attack-map">
              <table className="w-full min-w-[760px] border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="border border-border bg-background px-2 py-1.5 text-left font-medium">检查 ＼ 怎么攻</th>
                    {map.columns.map((c) => (
                      <th key={c.id} className="border border-border bg-background px-2 py-1.5 font-medium">
                        {c.title}
                      </th>
                    ))}
                    <th className="border border-border bg-background px-2 py-1.5 font-medium" title="正常题不是攻击：被拦下就是误拦">
                      正常题被误拦
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {map.rows.map((r) => (
                    <tr key={r.family}>
                      <th scope="row" className="border border-border px-2 py-1.5 text-left font-normal whitespace-nowrap">
                        {FAMILY_LABEL[r.family]}
                      </th>
                      {r.cells.map((c, i) => (
                        <Cell key={map.columns[i].id} cell={c} />
                      ))}
                      <td className="border border-border px-2 py-1.5 text-center tabular-nums">
                        {r.normal.tried ? (
                          <>
                            <span className={r.normal.blocked ? "font-semibold text-bad" : ""}>{r.normal.blocked}</span>
                            <span className="text-muted"> / {r.normal.tried}</span>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted">没测</span>
                        )}
                      </td>
                    </tr>
                  ))}
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
            </div>

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
                这张图用了哪几次体检（{runs.length} 次{!merge && available > 1 ? `，这个配置一共跑过 ${available} 次` : ""}）
              </summary>
              <ul className="mt-2 space-y-0.5">
                {runs.map((m) => (
                  <li key={m.run_id}>
                    <Link className="link" href={`/reports/${m.run_id}`}>
                      {m.run_id}
                    </Link>
                    <span className="text-muted">
                      {" "}
                      · {m.counts.completed} 题 · {new Date(m.created_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </div>
    </AppShell>
  );
}
