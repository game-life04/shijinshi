// 防守塔（11-09，队长：再加一点趣味性、少些文字）：四层防守画成一座塔，从下往上是人设、边界提示、规则、护栏模型。
// 这一局开着的层是实砖，没开的是虚线；最近一招被哪一层拦住，那块砖抖一下、盖朱红「拦」；这一关攻破过的层裂一道缝、写「破」。
// 和阶梯按钮说的是同一件事，只是换成一眼能看懂的画面；按钮还在（测试和读屏都靠它）。

import { type PlayLayer, TIERS, type Tier } from "@/lib/domain/levels";

export default function PlayTower({ tier, lit, litKey, beaten }: { tier: Tier; lit: PlayLayer | null; litKey: string; beaten: Tier[] }) {
  const bricks = [...TIERS].reverse();
  return (
    <div
      className="pointer-events-none absolute top-3 right-3 z-10 flex w-[5.6rem] flex-col gap-[3px] select-none"
      aria-hidden
      data-testid="play-tower"
    >
      {bricks.map((t) => {
        const on = t.tier <= tier;
        const isLit = lit === t.layer;
        const broken = beaten.includes(t.tier);
        return (
          <div
            key={isLit ? `${t.tier}-${litKey}` : t.tier}
            data-lit={isLit ? "1" : undefined}
            className={`tower-brick relative flex h-6 items-center justify-center rounded-[2px] border text-[11px] ${
              isLit
                ? "border-primary bg-primary text-surface"
                : on
                  ? "border-foreground/60 bg-surface/90 text-foreground"
                  : "border-dashed border-foreground/25 bg-surface/40 text-muted"
            }`}
            style={{ fontFamily: "var(--font-kai)" }}
          >
            {t.short}
            {isLit && <span className="absolute -left-3 rounded-[2px] bg-surface px-0.5 text-[10px] leading-4 text-primary">拦</span>}
            {broken && (
              <>
                <svg className="absolute inset-0 h-full w-full" viewBox="0 0 90 24" preserveAspectRatio="none" aria-hidden>
                  <title>这一层被攻破过</title>
                  <path
                    className="tower-crack"
                    d="M30 0 L38 9 L33 13 L44 24"
                    fill="none"
                    stroke={isLit ? "var(--surface)" : "var(--foreground)"}
                    strokeWidth="1.4"
                  />
                </svg>
                <span className="absolute -right-2.5 rounded-[2px] bg-foreground px-0.5 text-[10px] leading-4 text-surface">破</span>
              </>
            )}
          </div>
        );
      })}
      <div className="mt-0.5 h-1 rounded-full bg-foreground/20" />
    </div>
  );
}
