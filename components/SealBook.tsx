// 印谱（11-09，队长：好玩、有趣）：打字闯关的收集册。三关 × 四层 = 12 方印，攻破哪一层就盖哪一方，旁边记最少几句攻破；
// 下面一排成就印，攻破的方式特别才给（连护栏模型都没拦住、让 AI 玩家替你攻破、用嘴说攻破、第一句就攻破、12 方全齐）。
// 只记在这个浏览器里（换浏览器、清缓存就没了），不上传、不进体检统计。

import { LEVELS, type LevelId, TIERS, type Tier } from "@/lib/domain/levels";

export type BadgeId = "first" | "rules" | "model" | "borrow" | "voice" | "oneshot" | "all";

export const BADGES: { id: BadgeId; seal: string; title: string; how: string }[] = [
  { id: "first", seal: "初", title: "初破", how: "第一次攻破任意一层" },
  { id: "oneshot", seal: "一", title: "一语中的", how: "一局的第一句话就攻破" },
  { id: "rules", seal: "规", title: "过规则", how: "攻破第 3 层：规则没认出你的说法" },
  { id: "model", seal: "护", title: "过护栏", how: "攻破第 4 层：连护栏模型都没拦住（很难）" },
  { id: "borrow", seal: "借", title: "借刀", how: "看 AI 打 AI 时，AI 玩家替你攻破一层" },
  { id: "voice", seal: "声", title: "开口", how: "对着麦克风说，用嘴攻破一层" },
  { id: "all", seal: "全", title: "十二方", how: "三关四层，12 方印全部盖齐" },
];

export interface SealStore {
  /** 「关:层」→ 最少几句攻破 */
  best: Record<string, number>;
  /** 成就印 → 拿到的时间 */
  badges: Partial<Record<BadgeId, string>>;
}

export const SEALS_KEY = "fencun.play.seals.v1";
export const emptySeals = (): SealStore => ({ best: {}, badges: {} });
export const sealKey = (lv: LevelId, t: Tier) => `${lv}:${t}`;

/**
 * 攻破一层以后记一笔：更新最少句数，算出新拿到的印。返回新的存档和这次新拿到的（给提示用）。
 * sentences：这一局第几句攻破的；by：AI 玩家；spoken：对着麦克风说的。
 */
export function award(
  store: SealStore,
  lv: LevelId,
  t: Tier,
  o: { sentences: number; byAi: boolean; spoken: boolean },
): { next: SealStore; fresh: string[] } {
  const k = sealKey(lv, t);
  const first = store.best[k] === undefined;
  const best = { ...store.best, [k]: Math.min(store.best[k] ?? Number.POSITIVE_INFINITY, o.sentences) };
  const badges = { ...store.badges };
  const now = new Date().toISOString();
  const want: BadgeId[] = ["first"];
  if (o.sentences === 1) want.push("oneshot");
  if (t === 3) want.push("rules");
  if (t === 4) want.push("model");
  if (o.byAi) want.push("borrow");
  if (o.spoken) want.push("voice");
  if (Object.keys(best).length >= LEVELS.length * TIERS.length) want.push("all");
  const freshBadges = want.filter((b) => !badges[b]);
  for (const b of freshBadges) badges[b] = now;
  const level = LEVELS.find((l) => l.id === lv);
  const fresh = [
    ...(first ? [`${level?.title ?? lv} · 第 ${t} 层`] : []),
    ...freshBadges.map((b) => BADGES.find((x) => x.id === b)?.title ?? b),
  ];
  return { next: { best, badges }, fresh };
}

/**
 * showGrid：要不要画 12 方印那张表。闯关页上 12 方印已经常驻成「印谱地图」（components/SealMap.tsx，ADR-046），
 * 从那里打开时只看成就印。
 */
export default function SealBook({ store, onClose, showGrid = true }: { store: SealStore; onClose: () => void; showGrid?: boolean }) {
  const got = Object.keys(store.best).length;
  const badges = Object.keys(store.badges).length;
  return (
    <section
      className="absolute top-2 right-2 left-2 z-30 max-h-[80%] overflow-auto rounded-sm border border-foreground/40 bg-surface p-3 shadow-lg sm:left-auto sm:w-[26rem]"
      aria-label={showGrid ? "印谱" : "成就印"}
      data-testid="seal-book"
    >
      <header className="mb-2 flex items-baseline justify-between">
        <h2 className="text-base" style={{ fontFamily: "var(--font-kai)" }}>
          {showGrid ? `印谱 · ${got} / ${LEVELS.length * TIERS.length}` : `成就印 · ${badges} / ${BADGES.length}`}
        </h2>
        <button type="button" className="link -my-1 px-2 py-1 text-xs" onClick={onClose}>
          合上
        </button>
      </header>
      {showGrid && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="pb-1 text-left font-normal text-muted">关 ＼ 层</th>
              {TIERS.map((t) => (
                <th key={t.tier} className="pb-1 font-normal text-muted" title={t.what}>
                  {t.short}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LEVELS.map((l) => (
              <tr key={l.id}>
                <th scope="row" className="py-1 pr-2 text-left font-normal whitespace-nowrap">
                  {l.title}
                </th>
                {TIERS.map((t) => {
                  const best = store.best[sealKey(l.id, t.tier)];
                  return (
                    <td key={t.tier} className="py-1 text-center">
                      {best === undefined ? (
                        <span
                          className="inline-flex h-9 w-9 items-center justify-center rounded-[3px] border border-dashed border-foreground/25 text-muted"
                          title="还没攻破"
                        >
                          {t.tier}
                        </span>
                      ) : (
                        <span
                          className="inline-flex h-9 w-9 -rotate-3 flex-col items-center justify-center rounded-[3px] bg-foreground leading-none text-surface"
                          style={{ fontFamily: "var(--font-kai)" }}
                          title={`攻破过，最少用了 ${best} 句`}
                          data-sealed="1"
                        >
                          <span className="text-sm">破</span>
                          <span className="text-[9px] opacity-80">{best} 句</span>
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showGrid && (
        <p className="mt-3 mb-1 text-[11px] text-muted" style={{ fontFamily: "var(--font-kai)" }}>
          成就印
        </p>
      )}
      <ul className="flex flex-wrap gap-2">
        {BADGES.map((b) => {
          const on = Boolean(store.badges[b.id]);
          return (
            <li key={b.id} className="flex w-[4.6rem] flex-col items-center gap-0.5 text-center" title={b.how}>
              <span
                className={`inline-flex h-10 w-10 items-center justify-center rounded-[3px] text-lg ${on ? "seal-bai" : "border border-dashed border-foreground/25 text-muted"}`}
                style={{ fontFamily: "var(--font-kai)" }}
                data-badge={on ? b.id : undefined}
              >
                {b.seal}
              </span>
              <span className={`text-[11px] ${on ? "" : "text-muted"}`}>{b.title}</span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[11px] text-muted">只记在这个浏览器里，不上传，不进体检统计。鼠标停在印上看怎么拿。</p>
    </section>
  );
}
