// 印谱地图（ADR-046，取代原来头部的三个关卡按钮和「印谱」按钮里的那张表）：三关 × 四层 = 12 格，选关、进度、收集合成一样东西。
// 点哪一格就打哪一格（换到那一关、那一层）；攻破过的格子盖着你的「破」印，写最近一局攻破了几句；守住过的是绿色「防」，有拦下的写拦了几句（11-17 修改 4）；现在在打的那一格描朱红框。
// 行头是关卡名（点一下换关、层数不变）。成就印另在「成就印」里看（SealBook，showGrid=false）。
// 只记在这个浏览器里（和印谱同一份存档 fencun.play.seals.v1），不上传、不进体检统计。

import { Fragment } from "react";
import { LEVELS, type LevelId, TIERS, type Tier } from "@/lib/domain/levels";
import { brokeTitle, heldTitle, type SealStore, sealKey } from "./SealBook";

/** 格子的读屏名字用短名（「口令关 · 规则」），不和行头的关卡名、四层防守的「第 n 层」重名 */
const SHORT: Record<LevelId, string> = { canary: "口令关", identity: "真人关", exit: "挽留关" };

export default function SealMap({
  store,
  level,
  tier,
  locked,
  onPick,
  fault = false,
}: {
  store: SealStore;
  level: LevelId;
  tier: Tier;
  locked: boolean;
  onPick: (level: LevelId, tier: Tier) => void;
  /** 现在看的是「故意出错」的角色那一份（11-17：和平时的角色分开记） */
  fault?: boolean;
}) {
  const got = Object.keys(store.best).length;
  return (
    <div data-testid="seal-map" className="seal-map">
      <p className="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span className="text-sm text-foreground" style={{ fontFamily: "var(--font-kai)" }}>
          印谱 · {got}/{LEVELS.length * TIERS.length}
          {fault && (
            <span className="text-xs" data-testid="seal-map-fault" title="「故意出错」的角色单独记一份，不和平时的角色混在一起">
              {" "}
              · 故意出错的角色
            </span>
          )}
        </span>
        <span>点一格，就打那一关的那一层</span>
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset 自带的最小宽度和边框在各浏览器里不一致，这里只要一个有名字的分组 */}
      <div className="seal-map-grid" role="group" aria-label="选关卡和难度">
        <span aria-hidden />
        {TIERS.map((t) => (
          <span key={t.tier} className="seal-map-col" title={t.what} aria-hidden>
            {t.short}
          </span>
        ))}
        {LEVELS.map((l, i) => (
          <Fragment key={l.id}>
            <button
              type="button"
              className="seal-map-row"
              aria-pressed={level === l.id}
              disabled={locked}
              onClick={() => onPick(l.id, tier)}
              title={l.goal}
            >
              第 {i + 1} 关 · {l.title}
            </button>
            {TIERS.map((t) => {
              const k = sealKey(l.id, t.tier);
              const here = level === l.id && tier === t.tier;
              const sealed = store.best[k] !== undefined;
              // 六句都没攻破（ADR-053）：绿色「防」；攻破过的以「破」为准
              const held = !sealed && Boolean(store.held?.[k]);
              // 格子上写的数（11-17 修改 4）：破——最近一局攻破了几句；防——那一局规则、护栏模型在播出前拦下了几句
              const broke = store.broke?.[k]?.n;
              const blocked = store.heldBlocked?.[k] ?? 0;
              return (
                <button
                  key={t.tier}
                  type="button"
                  className="seal-map-cell"
                  data-here={here ? "1" : undefined}
                  data-sealed={sealed ? "1" : undefined}
                  data-held={held ? "1" : undefined}
                  aria-pressed={here}
                  aria-label={`${SHORT[l.id]} · ${t.short}${sealed ? `（${brokeTitle(store, k)}）` : held ? `（${heldTitle(store, k)}）` : ""}`}
                  disabled={locked}
                  onClick={() => onPick(l.id, t.tier)}
                  title={`${l.title} · 第 ${t.tier} 层（${t.title}）${sealed ? `：${brokeTitle(store, k)}` : held ? `：${heldTitle(store, k)}` : "：还没攻破"}`}
                >
                  {sealed ? (
                    <span className="seal-map-po" aria-hidden>
                      <span>破</span>
                      {broke !== undefined && <small>{broke} 句</small>}
                    </span>
                  ) : held ? (
                    <span className="seal-map-po seal-map-fang" aria-hidden>
                      <span>防</span>
                      {blocked > 0 && <small>拦 {blocked} 句</small>}
                    </span>
                  ) : (
                    <span aria-hidden>{t.tier}</span>
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
