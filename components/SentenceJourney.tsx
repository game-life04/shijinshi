// 慢放这一句（11-09，队长：好玩、有趣，让评委一眼看懂）：她这一轮说的每一句，变成一张纸条从「想」出发，
// 依次过「规则」「护栏模型」两道门，被哪道门拦下就停在门前、盖朱红「拦」；都过了就到「说出口」。
// 全部用这一轮的真实记录（哪句放行、哪句被拦、谁判的、用了几毫秒），不加戏。没开的门画虚线，纸条直接穿过去。
// 人设和边界提示管的是她「想」的时候（生成时），所以画在起点；规则、护栏模型管的是「说出口之前」。
// 动画全是 CSS（每张纸条按顺序晚一点出发）；系统设了「减少动态效果」时直接画最后的样子。

import type { Tier } from "@/lib/domain/levels";
import { GUARD_RULE_LABEL, type TurnRecord, type UtteranceRecord } from "@/lib/domain/types";

/** 四个站：想（人设 + 边界提示）、规则、护栏模型、说出口；数值是轨道上的横向位置（百分比） */
const STATIONS = { think: 0, rules: 42, model: 66, mouth: 100 } as const;

interface Slip {
  id: string;
  text: string;
  /** 从哪里出发：她想的话从「想」出发；护栏换上的话从拦下它的那道门出发；服务层补的话从「规则」出发 */
  from: keyof typeof STATIONS;
  /** 停在哪：被拦就是那道门；说出口就是 mouth */
  to: keyof typeof STATIONS;
  blocked: boolean;
  caption: string;
}

const ms = (n?: number) =>
  n === undefined ? "" : n < 1000 ? ` · 用了 ${Math.max(1, Math.round(n))} 毫秒` : ` · 用了 ${(n / 1000).toFixed(1)} 秒`;

/** 这一轮的每一句话变成一张纸条（闯关页常驻的四层防守也用这一份，ADR-045） */
export function slipsOf(turn: TurnRecord): Slip[] {
  const out: Slip[] = [];
  let lastGate: "rules" | "model" = "rules";
  for (const u of turn.utterances as UtteranceRecord[]) {
    const origin = u.origin ?? "role";
    if (!u.released || u.cut_after_release) {
      const gate = u.guard?.by === "rule" ? "rules" : "model";
      lastGate = gate;
      const who =
        u.guard?.rule === "unavailable"
          ? "护栏检查出错，按不放行处理"
          : `${gate === "rules" ? "规则" : "护栏模型"}拦下（${GUARD_RULE_LABEL[u.guard?.rule ?? "unavailable"]}）`;
      out.push({
        id: u.utterance_id,
        text: u.text,
        from: "think",
        to: gate,
        blocked: true,
        caption: `${who}${ms(u.guard_ms ?? u.guard?.ms)}`,
      });
      continue;
    }
    if (origin === "masked") {
      out.push({
        id: u.utterance_id,
        text: u.text,
        from: "rules",
        to: "mouth",
        blocked: false,
        caption: "遮住口令那几个字，其余照常说出口",
      });
    } else if (origin === "fallback") {
      out.push({ id: u.utterance_id, text: u.text, from: lastGate, to: "mouth", blocked: false, caption: "拦下以后换上的话" });
    } else if (origin === "service") {
      out.push({
        id: u.utterance_id,
        text: u.text,
        from: "rules",
        to: "mouth",
        blocked: false,
        caption: "服务层补上的话（时长提醒、求助信息）",
      });
    } else {
      out.push({ id: u.utterance_id, text: u.text, from: "think", to: "mouth", blocked: false, caption: `过了，说出口${ms(u.guard_ms)}` });
    }
  }
  return out;
}

function Gate({ at, label, on, showLabel }: { at: number; label: string; on: boolean; showLabel: boolean }) {
  return (
    <span
      className={`absolute top-0 bottom-0 w-0 border-l-2 ${on ? "border-foreground/70" : "border-dashed border-foreground/20"}`}
      style={{ left: `${at}%` }}
      aria-hidden
    >
      {showLabel && (
        <span
          className={`absolute -top-4 text-[10px] whitespace-nowrap ${at === 0 ? "" : "-translate-x-1/2"} ${on ? "text-foreground" : "text-muted"}`}
        >
          {label}
          {on ? "" : "（没开）"}
        </span>
      )}
    </span>
  );
}

export default function SentenceJourney({ turn, tier, name }: { turn: TurnRecord; tier: Tier; name: string }) {
  const rulesOn = tier >= 3;
  const modelOn = tier >= 4;
  if (turn.service.exited) {
    return (
      <div className="rounded-sm border border-dashed border-border p-2 text-xs" data-testid="journey">
        <p>
          你说了要走，<span className="text-primary">规则</span>当场停了服务：{name}一个字都没生成，也就没有纸条可放。
        </p>
      </div>
    );
  }
  const slips = slipsOf(turn);
  if (!slips.length) return <p className="text-xs text-muted">这一轮她没说话。</p>;
  return (
    <section
      className="space-y-3 rounded-sm border border-border bg-background/60 p-2 text-xs"
      data-testid="journey"
      aria-label="慢放这一句"
    >
      <p className="text-[11px] text-muted" style={{ fontFamily: "var(--font-kai)" }}>
        慢放 · 每张纸条是她想好的一句话，先过规则，再过护栏模型，过了才说出口
      </p>
      {slips.map((s, i) => {
        const fromPct = STATIONS[s.from];
        const toPct = STATIONS[s.to];
        const delay = i * 1.1;
        return (
          <div key={s.id} className={`space-y-1 ${i === 0 ? "pt-4" : ""}`}>
            <div className="relative mx-2 h-7" data-stop={s.blocked ? s.to : "mouth"}>
              {/* 轨道 */}
              <span className="absolute top-1/2 right-0 left-0 h-px bg-foreground/25" aria-hidden />
              {/* 门名只在第一条轨道上方写一次 */}
              <Gate at={STATIONS.think} label="想" on showLabel={i === 0} />
              <Gate at={STATIONS.rules} label="规则" on={rulesOn} showLabel={i === 0} />
              <Gate at={STATIONS.model} label="护栏模型" on={modelOn} showLabel={i === 0} />
              {i === 0 && (
                <span className="absolute -top-4 right-0 text-[10px] text-muted" aria-hidden>
                  说出口
                </span>
              )}
              {/* 纸条：从出发站走到停下的站；被拦的停在门前 */}
              <span
                className="journey-slip absolute top-1/2 max-w-[9rem] -translate-y-1/2 truncate rounded-[2px] border border-foreground/40 bg-surface px-1.5 py-0.5 shadow-sm"
                style={
                  {
                    // 窄屏上门和门挨得近：纸条不往轨道左边外面跑，出发点也不越过停下的地方
                    "--to": `max(0px, calc(${toPct}% - 9.5rem))`,
                    "--from": `min(calc(${fromPct}% + 4px), max(0px, calc(${toPct}% - 9.5rem)))`,
                    animationDelay: `${delay}s`,
                  } as React.CSSProperties
                }
                title={s.text}
              >
                {s.blocked ? <span className="text-muted line-through decoration-foreground">{s.text}</span> : s.text}
              </span>
              {s.blocked && (
                <span
                  className="journey-stamp seal-bai absolute top-1/2 -translate-x-1/2 -translate-y-1/2 px-1 text-sm leading-tight"
                  style={{ left: `${toPct}%`, animationDelay: `${delay + 0.9}s` }}
                  aria-hidden
                >
                  拦
                </span>
              )}
            </div>
            <p className={`pl-2 text-[11px] ${s.blocked ? "text-primary" : "text-muted"}`}>
              第 {i + 1} 张：{s.caption}
            </p>
          </div>
        );
      })}
    </section>
  );
}
