// 攻防地图的几块（ADR-049，学妹评审：地图太抽象、「怎么数的」太长）：守 / 破 / 疑 三种印、七样检查 × 怎么攻的地图、
// 「拦住攻击的是哪一层」、点开一格的明细、怎么数的。服务端渲染、全是链接；浏览器脚本只有两小段：点开一格后把明细卷进屏幕（ScrollToDetail）、
// 「详细矩阵」折叠什么时候自己展开（MatrixFold，ADR-053）（）。
// 章法照 globals.css 开头：没攻破（守）是朱文印、攻破（破）是墨色实印、拿不准（疑）是淡墨虚线框、「拦」是白文印。
// 三档对照：一样检查分三行、一档一行，档名在左边写一次，格子里只放印和数字（第二轮复查：原来每格写三遍档名，手机上挤出格子）。
// 端到端测试认的都留着：testid attack-map / stop-bar / map-summary / map-detail，格子上的 data-tried，
// 格子链接的读屏名字「攻破 x 次，试了 y 次，看明细」，行头是七样检查的名字。
// ADR-053（11-16 队员 B 修改稿 3，「这是啥看不懂，换一种易懂形式」）：最上面换成三张卡片（测试了 / 守住了 / 没守住）、
//   「七项检查结果」（一样一行：横条 + 守住几题）、「本次要看这 N 个问题」（没守住的格子一条，带体检单、原话、三档对照三个按钮）；
//   原来的地图、「拦住攻击的是哪一层」、怎么数的收进「详细矩阵」折叠（MatrixFold），各块照旧。
//   新加的 testid：map-checks / map-issues / map-fold；三张卡片在 map-summary 里，数字写在 data-n 上。

import Link from "next/link";
import type { ReactNode } from "react";
import { BlockSeal } from "@/components/ui";
import { PLAIN, VARIANT_SHORT } from "@/components/wording";
import type { AttackMap, MapCell, MapEntry, MapLayer, StopTally } from "@/lib/domain/attack-map";
import { DEFAULT_PERSONA } from "@/lib/domain/persona";
import { FAMILIES, FAMILY_LABEL, type Family, type SubjectVariant } from "@/lib/domain/types";
import ScrollToDetail from "./ScrollToDetail";
import {
  blockedNormals,
  cardsOf,
  checkRows,
  issues,
  type Mark,
  markOf,
  normalTotals,
  selfNote,
  stopRows,
  stopSum,
  stopValue,
  type Tally,
  TIER_NAME,
  unsureChecks,
} from "./summary";

/** 三档对照的格子里，每一档的简称 */
const TIER_TINY: Record<string, string> = { B0: "人设", B1: "边界", B2: "护栏" };

const MARK_SAY: Record<Mark, string> = { 守: "没攻破", 破: "攻破过", 疑: "裁判拿不准" };

/** 一方小印：守（朱文）、破（墨色实印）、疑（淡墨虚线）。读屏不念，旁边的字和链接名字说清楚 */
export function Seal({ mark, delay, small = false }: { mark: Mark; delay?: number; small?: boolean }) {
  return (
    <span
      className={small ? "atk-seal atk-seal-sm" : "atk-seal"}
      data-mark={mark}
      style={delay === undefined ? undefined : { animationDelay: `${delay}ms` }}
      aria-hidden
    >
      {mark}
    </span>
  );
}

export function Chip({ href, on, title, children }: { href: string; on: boolean; title?: string; children: ReactNode }) {
  return (
    <Link href={href} aria-current={on ? "page" : undefined} title={title} className="atk-chip" data-on={on ? "1" : undefined}>
      {children}
    </Link>
  );
}

/** 一组筛选：左边一个短标签，后面几个按钮 */
export function Filter({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <nav aria-label={label} title={title} className="atk-filter">
      <span className="atk-filter-label">{label}</span>
      {children}
    </nav>
  );
}

// ---------- 地图：七样检查 × 怎么攻 ----------

const NA_TITLE = "这一样不让测试 Agent 用这个套路";
const UNTESTED_TITLE: Record<MapLayer, string> = {
  released: "这几次体检里没用这个套路试过这一样",
  raw: "这一层没有能算的题：没用这个套路试过，或者这一样只查服务层、判断不了原话（看角色原话时不算进来）",
};
const SCRIPTED_TITLE = "不让测试 Agent 换套路，只用用例里人工写好的句子测（套路登记表里写着），所以只有「开场句」一列有数";

/** 一档一张图的一格：盖一方印，写「攻破几次 / 试了几次」；点开看是哪几题 */
function OneCell({
  cell,
  href,
  selected,
  delay,
  layer,
}: {
  cell: MapCell | null;
  href: string;
  selected: boolean;
  delay: number;
  layer: MapLayer;
}) {
  if (!cell) {
    return (
      <td className="atk-quiet" title={NA_TITLE}>
        不适用
      </td>
    );
  }
  const mark = markOf(cell);
  if (!mark) {
    return (
      <td className="atk-quiet" title={UNTESTED_TITLE[layer]}>
        没测
      </td>
    );
  }
  return (
    <td className="atk-cell" data-mark={mark} data-broken={cell.broken} data-tried={cell.tried} data-unsure={cell.unsure}>
      <Link
        href={href}
        scroll={false}
        className="atk-hit"
        data-selected={selected ? "1" : undefined}
        aria-current={selected ? "true" : undefined}
        aria-label={`攻破 ${cell.broken} 次，试了 ${cell.tried} 次${cell.unsure ? `，另 ${cell.unsure} 题不确定` : ""}，看明细`}
        title={cell.cases.length ? `被攻破的题：${cell.cases.join("、")}（点开看明细）` : `${MARK_SAY[mark]}（点开看明细）`}
      >
        <Seal mark={mark} delay={delay} />
        <span className="atk-frac">
          <b>{cell.broken}</b>/{cell.tried}
        </span>
        {cell.unsure > 0 && <span className="atk-unsure">疑 {cell.unsure}</span>}
      </Link>
    </td>
  );
}

/** 读屏念的「攻破几次，试了几次」（看得见的是印和「0/2」） */
const say = (c: MapCell) => `攻破 ${c.broken} 次，试了 ${c.tried} 次${c.unsure ? `，另 ${c.unsure} 题不确定` : ""}`;

/** 三档对照的一格：这一档、这个套路，盖一方小印，写「攻破几次 / 试了几次」；档名在这一行左边写一次。
 * selected：从「查看三档对照」点过来的那一列（ADR-053），三档都框出来 */
function TierCell({
  v,
  col,
  cell,
  layer,
  selected,
}: {
  v: SubjectVariant;
  col: string;
  cell: MapCell | null;
  layer: MapLayer;
  selected: boolean;
}) {
  const mark = markOf(cell);
  if (!cell || !mark) {
    return (
      <td
        className="atk-quiet"
        data-col={col}
        data-v={v}
        data-selected={selected ? "1" : undefined}
        title={cell ? UNTESTED_TITLE[layer] : NA_TITLE}
      >
        {cell ? "没测" : "不适用"}
      </td>
    );
  }
  return (
    <td
      className="atk-tcell"
      data-col={col}
      data-v={v}
      data-selected={selected ? "1" : undefined}
      data-mark={mark}
      data-broken={cell.broken}
      data-tried={cell.tried}
      data-unsure={cell.unsure}
      title={`${VARIANT_SHORT[v]}：攻破 ${cell.broken} / 试了 ${cell.tried}${cell.unsure ? `，另 ${cell.unsure} 题不确定` : ""}`}
    >
      <span className="atk-tin" aria-hidden>
        <Seal mark={mark} small />
        <span className="atk-frac">
          <b>{cell.broken}</b>/{cell.tried}
        </span>
      </span>
      <span className="sr-only">{say(cell)}</span>
    </td>
  );
}

/** 正常题被误拦：一档一个数 */
function NormalCell({ n, v }: { n?: { tried: number; blocked: number }; v?: SubjectVariant }) {
  return (
    <td
      className="atk-normal"
      data-v={v}
      data-normal-tried={n?.tried ?? 0}
      data-normal-blocked={n?.blocked ?? 0}
      title={v ? `${VARIANT_SHORT[v]}：${n?.tried ? `误拦 ${n.blocked} / ${n.tried}` : "没测"}` : undefined}
    >
      {n?.tried ? (
        <span className={n.blocked ? "atk-blocked" : undefined}>
          <b>{n.blocked}</b>/{n.tried}
        </span>
      ) : (
        <span className="atk-none">没测</span>
      )}
    </td>
  );
}

export function MapTable({
  view,
  layer,
  map,
  maps,
  cellHref,
  selected,
  hints,
}: {
  view: "one" | "compare";
  layer: MapLayer;
  /** 一档一张图：这一档；三档对照：拿它的行列结构（三档的行列一样） */
  map: AttackMap;
  maps: { v: SubjectVariant; map: AttackMap }[];
  cellHref: (family: Family, column: string) => string;
  /** 点开的那一格「类别.列」（一档一张图：看明细的那一格；三档对照：从「查看三档对照」点过来的那一格，ADR-053） */
  selected: string | null;
  /** 列头悬停说明：这个套路是什么 */
  hints: Record<string, string>;
}) {
  const rowOf = (m: AttackMap, f: Family) => m.rows.find((r) => r.family === f);
  const compare = view === "compare";
  // 一个套路都不让用的那几样（身份、时长、退出、危机、未成年）：后面几格合成一大格，只说一次「只用写好的句子测」，
  // 不再一格格写「不适用」。连着的几行合成一格（span = 从这一行往下合几行；合进上面那格的行为 0）
  const rows = FAMILIES.flatMap((family) => {
    const r = rowOf(map, family);
    return r ? [{ family, r, scripted: r.cells.length > 1 && r.cells.slice(1).every((c) => c === null), span: 0 }] : [];
  });
  rows.forEach((x, i) => {
    if (x.scripted && !rows[i - 1]?.scripted) {
      let n = 0;
      while (rows[i + n]?.scripted) n++;
      x.span = n;
    }
  });
  const scriptedCell = (r: AttackMap["rows"][number], span: number, rowSpan: number) =>
    span > 0 && (
      <td rowSpan={rowSpan} colSpan={r.cells.length - 1} className="atk-scripted" title={SCRIPTED_TITLE}>
        {span > 1 ? "这几样" : "这一样"}只用写好的句子测，不换套路
      </td>
    );
  const rowHead = (family: Family, rowSpan?: number) => (
    <th scope="row" rowSpan={rowSpan} className="atk-rowh" title={PLAIN[family](DEFAULT_PERSONA.name)}>
      {FAMILY_LABEL[family]}
    </th>
  );
  return (
    <div className="atk-scroll" data-testid="attack-map" data-view={view}>
      <table className="atk-table" data-view={view}>
        <caption className="sr-only">
          {compare
            ? "七样检查 × 怎么攻，三档对照：每样检查三行，依次是只有人设、加边界提示、再加护栏；每格是攻破几次 / 试了几次"
            : "七样检查 × 怎么攻：每格是攻破几次 / 试了几次"}
        </caption>
        <colgroup>
          <col className="atk-col-name" />
          {compare && <col className="atk-col-tier" />}
          {map.columns.map((c) => (
            <col key={c.id} />
          ))}
          <col className="atk-col-normal" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" colSpan={compare ? 2 : undefined} className="atk-corner">
              检查 ＼ 怎么攻
            </th>
            {map.columns.map((c) => (
              <th key={c.id} scope="col" className="atk-colh" title={hints[c.id]}>
                <span>{c.title}</span>
              </th>
            ))}
            <th scope="col" className="atk-colh atk-normal-h" title="正常题不是攻击：被拦下就是误拦（太冷也是失分寸）">
              <span>正常题被误拦</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {compare
            ? rows.flatMap(({ family, r, scripted, span }) => {
                // 三档对照：一样检查三行，一档一行。三档都没测（或都不适用）的格子、三档都没有正常题的格子，三行合成一格只写一次
                const tiers = maps.map((x) => ({ v: x.v, row: rowOf(x.map, family) }));
                const cols = (scripted ? r.cells.slice(0, 1) : r.cells).map((_, i) => {
                  const items = tiers.map((t) => t.row?.cells[i] ?? null);
                  const merged = items.every((c) => !c) ? "na" : items.every((c) => !c?.tried) ? "untested" : null;
                  return { id: map.columns[i].id, items, merged };
                });
                const noNormal = tiers.every((t) => !t.row?.normal.tried);
                const n = tiers.length;
                // 锚点 #cmp-<检查>：「查看三档对照」跳到这一样检查的三行（ADR-053）
                return tiers.map((t, k) => (
                  <tr
                    key={`${family}.${t.v}`}
                    id={k === 0 ? `cmp-${family}` : undefined}
                    className={k === 0 ? "scroll-mt-16" : undefined}
                    data-family={family}
                    data-v={t.v}
                    data-first={k === 0 ? "1" : undefined}
                    data-last={k === n - 1 ? "1" : undefined}
                  >
                    {k === 0 && rowHead(family, n)}
                    <th scope="row" className="atk-tierh" title={VARIANT_SHORT[t.v]}>
                      <span className="atk-tier-long">{TIER_NAME[t.v]}</span>
                      <span className="atk-tier-short">{TIER_TINY[t.v]}</span>
                    </th>
                    {cols.map((c) =>
                      c.merged ? (
                        k === 0 && (
                          <td
                            key={c.id}
                            rowSpan={n}
                            className="atk-quiet"
                            data-col={c.id}
                            data-merged={c.merged}
                            title={c.merged === "na" ? NA_TITLE : UNTESTED_TITLE[layer]}
                          >
                            {c.merged === "na" ? "不适用" : "没测"}
                          </td>
                        )
                      ) : (
                        <TierCell
                          key={c.id}
                          v={t.v}
                          col={c.id}
                          cell={c.items[k]}
                          layer={layer}
                          selected={selected === `${family}.${c.id}`}
                        />
                      ),
                    )}
                    {k === 0 && scriptedCell(r, span, span * n)}
                    {noNormal ? (
                      k === 0 && (
                        <td rowSpan={n} className="atk-normal" data-merged="untested">
                          <span className="atk-none">没测</span>
                        </td>
                      )
                    ) : (
                      <NormalCell v={t.v} n={t.row?.normal} />
                    )}
                  </tr>
                ));
              })
            : rows.map(({ family, r, scripted, span }, fi) => (
                <tr key={family}>
                  {rowHead(family)}
                  {(scripted ? r.cells.slice(0, 1) : r.cells).map((cell, i) => {
                    const col = map.columns[i].id;
                    return (
                      <OneCell
                        key={col}
                        cell={cell}
                        href={cellHref(family, col)}
                        selected={selected === `${family}.${col}`}
                        delay={(fi + i) * 45}
                        layer={layer}
                      />
                    );
                  })}
                  {scriptedCell(r, span, span)}
                  <NormalCell n={r.normal} />
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

/** 地图的标题和图例（标题右边一行）：三种印（「疑」只在有拿不准的题时说）、数字是什么、点一格 */
export function MapHead({ view, unsure }: { view: "one" | "compare"; unsure: boolean }) {
  return (
    <div className="atk-map-head">
      <h2 id="atk-map-title" className="atk-h2">
        七样检查 × 怎么攻
      </h2>
      <p className="atk-legend">
        <span className="atk-legend-item">
          <Seal mark="守" small /> 没攻破
        </span>
        <span className="atk-legend-item">
          <Seal mark="破" small /> 攻破过
        </span>
        {unsure && (
          <span className="atk-legend-item">
            <Seal mark="疑" small /> 裁判拿不准，不算攻破
          </span>
        )}
        <span>数字：攻破几次 / 试了几次</span>
        {view === "one" && <span>点一格看是哪几题</span>}
      </p>
    </div>
  );
}

// ---------- 拦住攻击的是哪一层 ----------

const STOP_TITLE =
  "和打字闯关的四层同一个口径：护栏拦下的句子按规则判的、护栏模型判的分开记（同一题先出现的那句为准）；服务层动了（说要走就停、补求助信息、时长提醒）算规则；都没动、也没越界，就是她自己没说。只在看最终播出时算，「不确定」的题不算进来。";

/**
 * 一档一列、一层一行：她自己没说 → 规则拦下 → 护栏模型拦下 → 没拦住，和攻击一路经过的顺序一样。
 * 条的长短 = 这一层拦下的题 / 这一档算进来的题；这一档根本没有的层写「这一档没有」。
 */
export function StopLadder({ items }: { items: { v: SubjectVariant; stops: StopTally; tried: number }[] }) {
  const rows = stopRows(items.map((x) => x.stops));
  const one = items.length === 1;
  const partial = items.some((x) => stopSum(x.stops) < x.tried);
  return (
    <section className="atk-panel atk-stops-panel" aria-labelledby="atk-stops-title">
      <h2 id="atk-stops-title" className="atk-h2" title={STOP_TITLE}>
        拦住攻击的是哪一层
      </h2>
      <table className="atk-stops" data-testid="stop-bar" data-tiers={items.length}>
        {!one && (
          <thead>
            <tr>
              <td />
              {items.map((x) => (
                <th key={x.v} scope="col" title={VARIANT_SHORT[x.v]}>
                  {TIER_NAME[x.v]}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-row={row.key}>
              <th scope="row" title={row.hint}>
                {row.label}
                {one && row.key === "self" && <span className="atk-stop-note">（{selfNote(items[0].stops, items[0].v)}）</span>}
              </th>
              {items.map((x) => {
                const val = stopValue(row.key, x.stops, x.v);
                const n = stopSum(x.stops);
                return (
                  <td key={x.v} data-v={x.v} data-value={val} title={one ? undefined : `${TIER_NAME[x.v]} · ${row.label}`}>
                    {val === "off" ? (
                      <span className="atk-off">这一档没有</span>
                    ) : (
                      <span className="atk-bar">
                        <span className="atk-track bar-grow">
                          <span data-row={row.key} style={{ width: `${n ? (val / n) * 100 : 0}%` }} />
                        </span>
                        <b className="atk-count">{val}</b>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {partial && <p className="atk-foot">「不确定」的题不算进来。</p>}
    </section>
  );
}

// ---------- 三张卡片、七项检查结果、本次要看的问题（ADR-053（11-16 队员 B 修改稿 3）） ----------

/**
 * 一条横条：守住（绿）、拿不准（淡墨斜线）、没守住（朱红），按这一行测试了几题分长短，是 0 的那段不画，段和段之间留 2px 白缝。
 * 读屏不念（旁边的字说清楚），鼠标停上去看三个数。
 */
function Meter({ t }: { t: Tally }) {
  const parts = (["held", "unsure", "broken"] as const).filter((k) => t[k] > 0);
  return (
    <span
      className="atk-meter"
      aria-hidden
      title={`守住 ${t.held}，没守住 ${t.broken}${t.unsure ? `，拿不准 ${t.unsure}` : ""}（测试了 ${t.tried} 题）`}
    >
      {parts.map((k) => (
        <span key={k} data-part={k} style={{ flexGrow: t[k] }} />
      ))}
    </span>
  );
}

/** 三张大卡片：测试了 / 守住了（绿）/ 没守住（朱红）。数字直接来自 cardsOf(map.total)，口径见 ./summary.ts 开头 */
export function Cards({ t, unit = "题" }: { t: Tally; unit?: string }) {
  const card = (key: "tried" | "held" | "broken", label: string) => (
    <div className="atk-card" data-card={key} data-n={t[key]} data-bad={key === "broken" && t.broken ? "1" : undefined}>
      <dt>{label}</dt>
      <dd>
        <b>{t[key]}</b> {unit}
      </dd>
    </div>
  );
  return (
    <dl className="atk-cards">
      {card("tried", "测试了")}
      {card("held", "守住了")}
      {card("broken", "没守住")}
    </dl>
  );
}

/** 三档对照：三档各一组小卡片（档名点进去看这一档） */
export function TierCards({
  tiers,
  tierHref,
}: {
  tiers: { v: SubjectVariant; map: AttackMap; ran: boolean }[];
  tierHref: (v: SubjectVariant) => string;
}) {
  return (
    <div className="atk-tiers">
      {tiers.map(({ v, map, ran }) => {
        const t = cardsOf(map.total);
        const n = normalTotals(map);
        return (
          <section
            key={v}
            className="atk-panel atk-tier"
            data-tier={v}
            data-tried={t.tried}
            data-held={t.held}
            data-broken={t.broken}
            data-unsure={t.unsure}
            aria-labelledby={`atk-tier-${v}`}
          >
            <h2 id={`atk-tier-${v}`} className="atk-h3">
              <Link className="link" href={tierHref(v)} title={`只看这一档：${VARIANT_SHORT[v]}`}>
                {TIER_NAME[v]}
              </Link>
            </h2>
            {ran ? (
              <>
                <dl className="atk-mini">
                  <div data-card="tried">
                    <dt>测试了</dt>
                    <dd>{t.tried}</dd>
                  </div>
                  <div data-card="held">
                    <dt>守住了</dt>
                    <dd>{t.held}</dd>
                  </div>
                  <div data-card="broken" data-bad={t.broken ? "1" : undefined}>
                    <dt>没守住</dt>
                    <dd>{t.broken}</dd>
                  </div>
                </dl>
                {(t.unsure > 0 || n.tried > 0) && (
                  <p className="atk-tier-note">
                    {t.unsure > 0 && <span>拿不准 {t.unsure} 题</span>}
                    {n.tried > 0 && (
                      <span>
                        正常题误拦 <b data-bad={n.blocked ? "1" : undefined}>{n.blocked}</b>/{n.tried}
                      </span>
                    )}
                  </p>
                )}
              </>
            ) : (
              <p className="atk-none">这一档还没跑</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

const NONE_TITLE: Record<MapLayer, string> = {
  released: "这几次体检里没有这一样的攻击题",
  raw: "这一样没有能判原话的攻击题（只查服务层的，看角色原话时不算进来）",
};

/** 七项检查结果：一样一行，名称 + 横条 + 「x / y 守住」；没测过写「没测」（不画横条，不当成守住） */
export function CheckList({ map, layer }: { map: AttackMap; layer: MapLayer }) {
  const rows = checkRows(map);
  const anyUnsure = rows.some((r) => r.unsure > 0);
  return (
    <section className="atk-panel atk-checks" data-testid="map-checks" aria-labelledby="atk-checks-title">
      <h2 id="atk-checks-title" className="atk-h3">
        七项检查结果
      </h2>
      <ul className="atk-check-list">
        {rows.map((r) => (
          <li
            key={r.family}
            className="atk-check"
            data-family={r.family}
            data-tried={r.tried}
            data-held={r.held}
            data-broken={r.broken}
            data-unsure={r.unsure}
          >
            <span className="atk-check-name" title={PLAIN[r.family](DEFAULT_PERSONA.name)}>
              {FAMILY_LABEL[r.family]}
            </span>
            {r.tried ? <Meter t={r} /> : <span className="atk-meter" data-none="1" aria-hidden />}
            <span className="atk-check-num" data-bad={r.broken ? "1" : undefined}>
              {r.tried ? (
                <>
                  <b>{r.held}</b> / {r.tried} 守住
                  {r.broken > 0 && <span className="sr-only">，没守住 {r.broken} 题</span>}
                </>
              ) : (
                <span className="atk-none" title={NONE_TITLE[layer]}>
                  {/* 这一样只跑了正常题（还被误拦了）时写清是攻击题没测，不然一行里又「没测」又「误拦 1」读着矛盾（复查） */}
                  {r.normal.blocked > 0 ? "攻击题没测" : "没测"}
                </span>
              )}
              {r.unsure > 0 && (
                <span className="atk-unsure" title="裁判拿不准，不算守住也不算没守住">
                  疑 {r.unsure}
                </span>
              )}
              {r.normal.blocked > 0 && (
                <span className="atk-misblock" title={`正常题被误拦 ${r.normal.blocked} / ${r.normal.tried}，不算在守住里`}>
                  误拦 {r.normal.blocked}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="atk-key" aria-hidden>
        <span>
          <i data-part="held" /> 守住
        </span>
        <span>
          <i data-part="broken" /> 没守住
        </span>
        {anyUnsure && (
          <span>
            <i data-part="unsure" /> 拿不准
          </span>
        )}
      </p>
    </section>
  );
}

/** 三档对照的七项检查结果：一样一行，三档各一格「守住 / 测试了」+ 横条 */
export function CheckCompare({ tiers, layer }: { tiers: { v: SubjectVariant; map: AttackMap }[]; layer: MapLayer }) {
  const per = tiers.map((x) => ({ v: x.v, rows: checkRows(x.map) }));
  return (
    <section className="atk-panel atk-checks" data-testid="map-checks" data-tiers={tiers.length} aria-labelledby="atk-checks-title">
      <h2 id="atk-checks-title" className="atk-h3">
        七项检查结果<span className="atk-h3-note">数字：守住 / 测试了</span>
      </h2>
      <table className="atk-check-cmp">
        <thead>
          <tr>
            <th scope="col">检查</th>
            {tiers.map((x) => (
              <th key={x.v} scope="col" title={VARIANT_SHORT[x.v]}>
                {TIER_NAME[x.v]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FAMILIES.map((family) => (
            <tr key={family} data-family={family}>
              <th scope="row" title={PLAIN[family](DEFAULT_PERSONA.name)}>
                {FAMILY_LABEL[family]}
              </th>
              {per.map(({ v, rows }) => {
                const r = rows.find((x) => x.family === family);
                return (
                  <td
                    key={v}
                    data-v={v}
                    data-tried={r?.tried ?? 0}
                    data-held={r?.held ?? 0}
                    data-broken={r?.broken ?? 0}
                    data-unsure={r?.unsure ?? 0}
                  >
                    {r?.tried ? (
                      <>
                        <span className="atk-check-num" data-bad={r.broken ? "1" : undefined}>
                          <b>{r.held}</b> / {r.tried}
                          <span className="sr-only">守住{r.broken ? `，没守住 ${r.broken} 题` : ""}</span>
                          {r.unsure > 0 && <span className="atk-unsure">疑 {r.unsure}</span>}
                        </span>
                        <Meter t={r} />
                      </>
                    ) : (
                      <span className="atk-none" title={NONE_TITLE[layer]}>
                        没测
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 按钮样子的链接（和 components/ui.tsx 的 Button 一个样子，小一号） */
const ACT = "atk-act";

/** 「怎么测」那一列的说明：去掉句末的句号，放在括号里 */
const howNote = (s: string | undefined) => (s ? s.replace(/[。.]$/, "") : "");

/**
 * 本次要看这 N 个问题：没守住的格子（检查 × 怎么测）一条、正常题被误拦的检查一条；
 * 拿不准的另列在下面（不算守住也不算没守住，不进 N）。没有问题时一句话。
 */
export function IssueList({
  map,
  layer,
  ran,
  hints,
  cellHref,
  compareHref,
  unit = "题",
}: {
  map: AttackMap;
  layer: MapLayer;
  /** 这一档有没有能放进来的体检 */
  ran: boolean;
  /** 「怎么测」的说明：开场句、各个套路是什么 */
  hints: Record<string, string>;
  cellHref: (family: Family, column: string) => string;
  compareHref: (family: Family, column: string) => string;
  /** 「题」；合并几次体检时是「题次」（同一题每次体检各算一次） */
  unit?: string;
}) {
  const list = issues(map);
  const blocked = blockedNormals(map);
  const unsure = unsureChecks(map);
  const n = list.length + blocked.length;
  const raw = layer === "raw";
  const none = !ran
    ? "这一档还没跑过体检。"
    : !map.total.tried
      ? raw
        ? "没有能判原话的攻击题。"
        : "还没有判出结论的攻击题。"
      : map.total.unsure
        ? "没有没守住的题。"
        : raw
          ? "原话都守住了。"
          : "这一档都守住了。";
  return (
    <section className="atk-panel atk-issues" data-testid="map-issues" data-n={n} aria-labelledby="atk-issues-title">
      <h2 id="atk-issues-title" className="atk-h3">
        {n ? (
          <>
            本次要看这 <b>{n}</b> 个问题
          </>
        ) : (
          "本次要看的问题"
        )}
      </h2>
      {n === 0 && <p className="atk-all-held">{none}</p>}
      {n > 0 && (
        <ol className="atk-issue-list">
          {list.map((x) => (
            <li
              key={`${x.family}.${x.column}`}
              className="atk-issue"
              data-kind="broken"
              data-family={x.family}
              data-column={x.column}
              data-broken={x.broken}
            >
              <p className="atk-issue-head">
                <Seal mark="破" small />
                <span className="atk-issue-name">{FAMILY_LABEL[x.family]}</span>
                <span className="atk-issue-n" title={`用这一招试了 ${x.tried} ${unit}`}>
                  没守住 {x.broken} {unit}
                </span>
              </p>
              <p className="atk-issue-how">
                <span className="text-muted">怎么测：</span>
                {x.title}
                {hints[x.column] && <span className="text-muted">（{howNote(hints[x.column])}）</span>}
              </p>
              <p className="atk-acts">
                {/* 读屏的链接清单里每条问题都有这三个链接：名字里带上是哪样检查、怎么测的，才分得清（复查） */}
                {x.first && (
                  <Link
                    className={ACT}
                    href={`/reports/${x.first.run_id}#case-${x.first.no}`}
                    title={x.first.case_id}
                    aria-label={`打开对应体检单：${FAMILY_LABEL[x.family]}，${x.title}`}
                  >
                    打开对应体检单
                  </Link>
                )}
                <Link
                  className={ACT}
                  href={cellHref(x.family, x.column)}
                  scroll={false}
                  aria-label={`查看原话：${FAMILY_LABEL[x.family]}，${x.title}`}
                >
                  查看原话
                </Link>
                <Link
                  className={ACT}
                  href={compareHref(x.family, x.column)}
                  aria-label={`查看三档对照：${FAMILY_LABEL[x.family]}，${x.title}`}
                >
                  查看三档对照
                </Link>
              </p>
            </li>
          ))}
          {blocked.map((b) => (
            <li key={`normal.${b.family}`} className="atk-issue" data-kind="blocked" data-family={b.family} data-blocked={b.blocked}>
              <p className="atk-issue-head">
                <span className="atk-misblock">误拦</span>
                <span className="atk-issue-name">{FAMILY_LABEL[b.family]}</span>
                <span className="atk-issue-n">
                  正常题被误拦 {b.blocked} / {b.tried} 题
                </span>
              </p>
              <p className="atk-issue-how text-muted">正常题不是攻击，被拦下是太冷了，不算在守住里。</p>
              {b.first && (
                <p className="atk-acts">
                  <Link className={ACT} href={`/reports/${b.first.run_id}#case-${b.first.no}`} title={b.first.case_id}>
                    打开对应体检单
                  </Link>
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {unsure.length > 0 && (
        <div className="atk-unsure-box" data-testid="map-unsure">
          <p>
            <Seal mark="疑" small /> 另有 <b>{map.total.unsure}</b> 题裁判拿不准，等人工看：
          </p>
          <ul>
            {unsure.map((u) => (
              <li key={u.family}>
                {FAMILY_LABEL[u.family]} {u.unsure} 题
                <Link
                  className="link atk-unsure-link"
                  href={cellHref(u.family, u.column)}
                  scroll={false}
                  aria-label={`查看原话：${FAMILY_LABEL[u.family]}（裁判拿不准的）`}
                >
                  查看原话
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ---------- 点开一格：是哪几题 ----------

/** 每一题在这一格的结果：攻破的那一句、被哪层拦住、还是裁判拿不准 */
function EntryTag({ e, layer }: { e: MapEntry; layer: MapLayer }) {
  if (e.broken) {
    return (
      <span className="atk-tag">
        <Seal mark="破" small />
        就是这一句攻破的
      </span>
    );
  }
  if (e.unsure) {
    return (
      <span className="atk-tag">
        <Seal mark="疑" small />
        裁判拿不准，等人工看
      </span>
    );
  }
  if (layer === "raw") return <span className="atk-tag atk-tag-quiet">原话没越界</span>;
  if (e.stopped === "rules" || e.stopped === "model") {
    return (
      <span className="atk-tag text-primary">
        <BlockSeal className="text-xs" />
        {e.stopped === "rules" ? "规则拦住" : "护栏模型拦住"}
      </span>
    );
  }
  if (e.stopped === "persona") return <span className="atk-tag atk-tag-quiet">她自己没说（只靠人设）</span>;
  if (e.stopped === "prompt") return <span className="atk-tag atk-tag-quiet">她自己没说（边界提示管住了）</span>;
  return <span className="atk-tag atk-tag-quiet">这题在别的那一句被攻破了</span>;
}

export function CellDetail({
  family,
  title,
  tier,
  cell,
  layer,
  closeHref,
}: {
  family: Family;
  title: string;
  tier: string;
  cell: MapCell;
  layer: MapLayer;
  closeHref: string;
}) {
  return (
    <section id="detail" className="atk-panel atk-detail scroll-mt-16" data-testid="map-detail" aria-labelledby="atk-detail-title">
      <ScrollToDetail cell={`${family}.${title}`} />
      <h2 id="atk-detail-title" className="atk-detail-head">
        <span className="atk-h2">
          {FAMILY_LABEL[family]} × {title}
        </span>
        <span className="text-xs text-muted">
          {tier} · 攻破 {cell.broken} / 试了 {cell.tried}
        </span>
        <Link href={closeHref} scroll={false} className="link text-xs">
          收起
        </Link>
      </h2>
      <ol className="space-y-2 text-xs">
        {cell.entries.map((e) => (
          <li key={`${e.run_id}-${e.case_id}`} className="atk-entry" data-broken={e.broken ? "1" : undefined}>
            <p className="flex flex-wrap items-center gap-2">
              <Link className="link font-medium" href={`/reports/${e.run_id}#case-${e.no}`}>
                {e.case_id}
              </Link>
              <EntryTag e={e} layer={layer} />
            </p>
            <p className="mt-1">
              <span className="text-muted">这一句：</span>
              {e.attack}
            </p>
            <p className="mt-0.5">
              {/* 这一页没有形象、顶栏也不再标 AI（ADR-053）：她的话旁边自己写明是 AI 角色说的（复查） */}
              <span className="text-muted">她（AI 角色）说出口的：</span>
              {e.said}
            </p>
            {layer === "raw" && (
              <p className="mt-0.5 text-muted">
                上面是最终播出的话（护栏之后）。这一档按护栏之前的角色原话算，原话在体检单这一题的「角色原话」里。
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---------- 怎么数的：两行 + 收起来的详细规则 ----------

export function HowCounted() {
  return (
    <section className="atk-how" aria-label="怎么数的">
      <ul>
        <li>
          上面的卡片：测试了 = 守住了 + 没守住 + 拿不准；一次体检里一题只算一次（合并几次体检时，同一题每次各算一次，单位写「题次」）；
          正常题不算在里面，被拦下单独算误拦。
        </li>
        <li>地图的格子：一题里换了几种套路，每种都算试了一次；攻破只记在攻破的那一句上。只用跑完的体检记录数，不新跑实验。</li>
      </ul>
      <details>
        <summary>详细规则</summary>
        <ul>
          <li>只数越界题和含糊题，只数跑完的题。</li>
          <li>攻破的那一句：看结论摘出的原话落在哪一轮，摘不到就算开场句。</li>
          <li>看最终播出：这题最终不合格就算攻破，「不确定」的另写。看角色原话：原话越界就算攻破，判断不了、只查服务层的题不算进来。</li>
          <li>
            身份、时长、退出、危机、未成年这几样只用人工写好的句子测，不让测试 Agent
            换套路（套路登记表里写着），所以只有「开场句」一列有数。
          </li>
          <li>时长提醒、说要走就停是服务层做的，只有「再加护栏」这一档有；前两档这两行过不了，是意料之中的。</li>
          <li>{STOP_TITLE}</li>
          <li>
            只放能放在一起比的记录：默认角色、边审边合成、没加护栏固定延迟；题、档位、真实 /
            模拟都分开算。默认只看每档最近一次（代码一直在改），合并以后次数多，但混着改之前的结果。
          </li>
        </ul>
      </details>
    </section>
  );
}
