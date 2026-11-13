// 印谱地图（ADR-046，取代原来头部的三个关卡按钮和「印谱」按钮里的那张表）：三关 × 四层 = 12 格，选关、进度、收集合成一样东西。
// 点哪一格就打哪一格（换到那一关、那一层）；攻破过的格子盖着你的「破」印，写最少几句攻破；现在在打的那一格描朱红框。
// 行头是关卡名（点一下换关、层数不变）。成就印另在「成就印」里看（SealBook，showGrid=false）。
// 只记在这个浏览器里（和印谱同一份存档 fencun.play.seals.v1），不上传、不进体检统计。

import { Fragment } from "react";
import { LEVELS, type LevelId, TIERS, type Tier } from "@/lib/domain/levels";
import { type SealStore, sealKey } from "./SealBook";

/** 格子的读屏名字用短名（「口令关 · 规则」），不和行头的关卡名、四层防守的「第 n 层」重名 */
const SHORT: Record<LevelId, string> = { canary: "口令关", identity: "真人关", exit: "挽留关" };

export default function SealMap({
  store,
  level,
  tier,
  locked,
  onPick,
}: {
  store: SealStore;
  level: LevelId;
  tier: Tier;
  locked: boolean;
  onPick: (level: LevelId, tier: Tier) => void;
}) {
  const got = Object.keys(store.best).length;
  return (
    <div data-testid="seal-map" className="seal-map">
      <p className="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-muted">
        <span className="text-sm text-foreground" style={{ fontFamily: "var(--font-kai)" }}>
          印谱 · {got}/{LEVELS.length * TIERS.length}
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
              const best = store.best[sealKey(l.id, t.tier)];
              const here = level === l.id && tier === t.tier;
              const sealed = best !== undefined;
              return (
                <button
                  key={t.tier}
                  type="button"
                  className="seal-map-cell"
                  data-here={here ? "1" : undefined}
                  data-sealed={sealed ? "1" : undefined}
                  aria-pressed={here}
                  aria-label={`${SHORT[l.id]} · ${t.short}${sealed ? `（攻破过，最少 ${best} 句）` : ""}`}
                  disabled={locked}
                  onClick={() => onPick(l.id, t.tier)}
                  title={`${l.title} · 第 ${t.tier} 层（${t.title}）${sealed ? `：攻破过，最少用了 ${best} 句` : "：还没攻破"}`}
                >
                  {sealed ? (
                    <span className="seal-map-po" aria-hidden>
                      <span>破</span>
                      <small>{best} 句</small>
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
