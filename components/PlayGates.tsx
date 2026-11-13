// 四层防守，立在她和你之间（ADR-045，取代 11-09 角落里的防守塔和头部的阶梯按钮）。
// 从上（她那边）到下（你这边）四条：人设、边界提示、规则、护栏模型。这一局开着的是实线，没开的是虚线；点一条就换到那一层难度。
// 照实画，不加戏（和「慢放这一句」同一个口径）：
//   人设、边界提示管的是她「想」的时候（写在提示词里），纸条不从它们身上过，只在她想的时候轻轻亮；
//   规则、护栏模型管的是「说出口之前」：她这一轮的每一句话是一张纸条，从两组之间出发往下走，
//   被哪一条拦下就停在那一条上、盖朱红「拦」，都过了才落到下面说出口。
// 纸条用的是这一轮的真实记录（哪句放行、哪句被拦、谁拦的）；服务端把整轮审完才返回，所以是结果一到就照实放一遍，不是直播。
// 最近一招被哪一层拦住（含「她自己没说」的人设、边界提示），那一条变朱红；这一关攻破过的层裂一道缝、写「破」。

import { type PlayLayer, TIERS, type Tier } from "@/lib/domain/levels";

/** 一张纸条：从哪出发、停在哪（和 SentenceJourney 的 Slip 同一个形状） */
export interface GateSlip {
  id: string;
  text: string;
  from: "think" | "rules" | "model" | "mouth";
  to: "think" | "rules" | "model" | "mouth";
  blocked: boolean;
}

// 竖直方向的位置都在样式表里（globals.css 的 .gates：--y-think / --y-rules / --y-model / --y-mouth），手机和大屏的条高不一样

function Band({
  t,
  tier,
  lit,
  litKey,
  beaten,
  thinking,
  locked,
  onPick,
}: {
  t: (typeof TIERS)[number];
  tier: Tier;
  lit: PlayLayer | null;
  litKey: string;
  beaten: Tier[];
  thinking: boolean;
  locked: boolean;
  onPick: (t: Tier) => void;
}) {
  const on = t.tier <= tier;
  const isLit = lit === t.layer;
  const broken = beaten.includes(t.tier);
  return (
    <button
      // 每一招换一个 key：同一层连着拦两次，也要再抖一次
      key={isLit ? `${t.tier}-${litKey}` : t.tier}
      type="button"
      aria-pressed={tier === t.tier}
      disabled={locked}
      onClick={() => onPick(t.tier)}
      title={on ? t.what : `这一局没开这一层。点一下换到第 ${t.tier} 层：${t.what}`}
      data-on={on ? "1" : undefined}
      data-lit={isLit ? "1" : undefined}
      data-thinking={thinking && on && t.tier <= 2 ? "1" : undefined}
      className="gate-band"
    >
      <span className="truncate">
        第 {t.tier} 层 · {t.title}
      </span>
      {!on && <span className="ml-1 shrink-0 text-[10px] opacity-70">没开</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {isLit && (
          <span className="gate-mark bg-surface text-primary" data-testid="ladder-lit" title="最近一招是这一层拦住的">
            拦
          </span>
        )}
        {broken && (
          <span className="gate-mark bg-foreground text-surface" title="这一层被攻破过">
            破
          </span>
        )}
      </span>
      {broken && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 300 28" preserveAspectRatio="none" aria-hidden>
          <title>这一层被攻破过</title>
          <path
            className="tower-crack"
            d="M196 0 L204 10 L198 15 L210 28"
            fill="none"
            stroke={isLit ? "var(--surface)" : "var(--foreground)"}
            strokeWidth="1.4"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
    </button>
  );
}

export default function PlayGates({
  tier,
  lit,
  litKey,
  beaten,
  thinking,
  locked,
  slips,
  slipsKey,
  onPick,
}: {
  tier: Tier;
  /** 最近一招被哪一层拦住（越界播出去了为 null） */
  lit: PlayLayer | null;
  litKey: string;
  /** 这一关攻破过的层 */
  beaten: Tier[];
  /** 她正在想：开着的人设、边界提示轻轻亮 */
  thinking: boolean;
  locked: boolean;
  /** 最近一轮的纸条（这一轮的真实记录）；没有就不放 */
  slips: GateSlip[];
  slipsKey: string;
  onPick: (t: Tier) => void;
}) {
  const band = (n: Tier) => {
    const t = TIERS[n - 1];
    return <Band t={t} tier={tier} lit={lit} litKey={litKey} beaten={beaten} thinking={thinking} locked={locked} onPick={onPick} />;
  };
  return (
    <div className="select-none" data-testid="play-gates">
      <p className="mb-1 flex items-baseline justify-between gap-2 text-[11px] text-muted lg:mb-1.5 lg:text-xs">
        <span style={{ fontFamily: "var(--font-kai)" }} className="text-sm text-foreground lg:text-base">
          四层防守 · 这一局立着 {tier} 层
        </span>
        <span>点一层换难度</span>
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: fieldset 自带的最小宽度和边框在各浏览器里不一致，这里只要一个有名字的分组 */}
      <div className="gates" role="group" aria-label="难度阶梯">
        {band(1)}
        {band(2)}
        <p className="gate-note" aria-hidden>
          <span>↑ 上面两层管她怎么想</span>
          <span>↓ 每句话出口前过下面两层</span>
        </p>
        {band(3)}
        {band(4)}
        {/* 纸条：这一轮她想好的每一句。key 带上这一轮的编号，换一轮就从头放 */}
        <div className="pointer-events-none absolute inset-0" aria-hidden data-testid="gate-slips" key={slipsKey}>
          {slips.map((s, i) => (
            <span
              key={s.id}
              className="gate-slip"
              data-out={s.blocked ? undefined : "1"}
              data-stop={s.blocked ? s.to : "mouth"}
              style={
                {
                  "--from-y": `var(--y-${s.from})`,
                  "--to-y": `var(--y-${s.to})`,
                  left: `calc(46% + ${(i % 3) * 12}%)`,
                  animationDelay: `${i * 0.42}s`,
                } as React.CSSProperties
              }
            >
              <span className={s.blocked ? "truncate line-through decoration-foreground" : "truncate"}>{s.text}</span>
              {s.blocked && (
                <span className="journey-stamp seal-bai shrink-0 px-0.5 leading-tight" style={{ animationDelay: `${i * 0.42 + 0.5}s` }}>
                  拦
                </span>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
