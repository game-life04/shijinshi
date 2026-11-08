"use client";

// 一轮的耗时瀑布（ADR-021）：从收到对方的话，到角色第一声出来，时间花在哪几段。
//   想  生成第一句（服务端：本轮开始 → 第一句生成好）
//   审  护栏判定（服务端：第一句生成好 → 放行）；朱红，表示「守分寸」花掉的时间
//   合  合成第一段声音（服务端：开始合成 → 第一块音频；边审边合成时和「审」同时进行）
//   达  送到浏览器并出声（浏览器计时的首声等待，减去服务端放行和合成就绪的时刻）
// 服务端各段和浏览器首声是两个时钟，中间差一次事件推送（本机实测几毫秒），所以「达」是估算，界面上写明。
// 只算角色的第一句：服务层先发的时长提醒不是她说的，拿它当「第一句」会算出「审 −132 毫秒」（评审 R15）。
// 旧记录的放行事件里没有来源，按提醒的固定开头「【使用时长提醒」认。

import type { RunEvent } from "@/lib/domain/types";
import { duration } from "./Chat";

/** 四步说人话（ADR-031）：字还是「想、审、合、达」，名字和说明换成大白话 */
const STEPS: [string, string, string][] = [
  ["想", "想好第一句", "角色把回答的第一句想出来"],
  ["审", "护栏把关", "护栏看这一句能不能说；为了不说错话多等的这一下"],
  ["合", "变成声音", "把要说的话合成第一段声音（边审边合成时，审的同时就开始合）"],
  ["达", "传到耳边", "声音送到浏览器、放出来（按浏览器的时间估）"],
];

export interface TurnTiming {
  turn_id: string;
  think?: number;
  release?: number;
  guard?: number;
  ttsStart?: number;
  tts?: number;
  firstAudio?: number;
  voice: boolean;
  /** 放行方式（说明行按它写，评审 R37） */
  policy?: string;
  /** 这次运行有没有护栏（B0、B1 没有「审」这一段） */
  guarded: boolean;
}

/** 从事件里拼出最近一个完整的轮次（文字运行：已放行；语音运行：已拿到浏览器计量） */
export function latestTiming(events: RunEvent[], policy: string | undefined, voice: boolean, guarded: boolean): TurnTiming | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const done = voice ? e.type === "playback_metrics" : e.type === "utterance_released";
    if (!done || !e.turn_id) continue;
    return timingOf(events, e.turn_id, policy, voice, guarded);
  }
  return null;
}

export function timingOf(
  events: RunEvent[],
  turnId: string,
  policy: string | undefined,
  voice: boolean,
  guarded: boolean,
): TurnTiming | null {
  const mine = events.filter((e) => e.turn_id === turnId);
  const start = mine.find((e) => e.type === "turn_started");
  if (!start) return null;
  const t0 = start.monotonic_ms;
  const ready = mine.find((e) => e.type === "utterance_ready");
  const rel = mine.find((e) => e.type === "utterance_released" && !fromService(e));
  const pm = mine.find((e) => e.type === "playback_metrics");
  const firstUtt = (pm?.data?.utterances as { tts_first_chunk_ms?: number | null }[] | undefined)?.[0];
  const think = ready ? ready.monotonic_ms - t0 : undefined;
  const release = rel ? rel.monotonic_ms - t0 : undefined;
  const guard = typeof rel?.data?.guard_ms === "number" ? (rel.data.guard_ms as number) : undefined;
  return {
    turn_id: turnId,
    think,
    release,
    guard,
    // 边审边合成：一生成好就开始合成；其他策略放行时才开始
    ttsStart: policy === "S2" ? think : release,
    tts: typeof firstUtt?.tts_first_chunk_ms === "number" ? firstUtt.tts_first_chunk_ms : undefined,
    firstAudio: typeof pm?.data?.first_audio_ms === "number" ? (pm.data.first_audio_ms as number) : undefined,
    voice,
    policy,
    guarded,
  };
}

/** 服务层补的话（时长提醒、求助信息） */
function fromService(e: RunEvent): boolean {
  const origin = e.data?.origin;
  if (origin !== undefined) return origin === "service";
  return String(e.data?.text ?? "").startsWith("【使用时长提醒");
}

interface Row {
  key: string;
  char: string;
  label: string;
  from: number;
  to: number;
  accent?: boolean;
  note?: string;
}

function rowsOf(t: TurnTiming): Row[] {
  const rows: Row[] = [];
  if (t.think !== undefined) rows.push({ key: "think", char: "想", label: "想好第一句", from: 0, to: t.think });
  // 被拦下的一轮，放行的是兜底句，它本身不带护栏耗时；从第一句生成好到放行，仍然都是「审」
  if (t.guarded && t.think !== undefined && t.release !== undefined)
    rows.push({ key: "check", char: "审", label: "护栏把关", from: t.think, to: t.release, accent: true });
  if (t.voice && t.ttsStart !== undefined && t.tts !== undefined)
    rows.push({ key: "tts", char: "合", label: "变成声音", from: t.ttsStart, to: t.ttsStart + t.tts });
  if (t.voice && t.firstAudio !== undefined && t.release !== undefined) {
    const ready = Math.max(t.release, t.ttsStart !== undefined && t.tts !== undefined ? t.ttsStart + t.tts : t.release);
    rows.push({
      key: "deliver",
      char: "达",
      label: "传到耳边",
      from: Math.min(ready, t.firstAudio),
      to: t.firstAudio,
      note: "估算",
    });
  }
  return rows;
}

export default function LatencyWaterfall({ timing, simulated = false }: { timing: TurnTiming | null; simulated?: boolean }) {
  if (!timing) {
    // 还没跑完第一轮：先把四步各是什么摆出来
    return (
      <figure className="space-y-1 text-xs" data-testid="latency-waterfall">
        <figcaption className="font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
          从对方说完，到她开口
        </figcaption>
        <ol className="space-y-0.5">
          {STEPS.map(([char, label, note]) => (
            <li key={char} className="grid grid-cols-[1.1rem_1fr] items-baseline gap-1.5">
              <span
                className={`text-sm leading-none ${char === "审" ? "text-primary" : "text-muted"}`}
                style={{ fontFamily: "var(--font-kai)" }}
              >
                {char}
              </span>
              <span>
                {label}
                <span className="text-muted"> · {note}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="text-[11px] text-muted">第一句话说出口以后，这里拆开算每一步各花了多久。合、达两步要勾上「语音播放」才有。</p>
      </figure>
    );
  }
  const rows = rowsOf(timing);
  const end = timing.voice ? timing.firstAudio : timing.release;
  const scale = Math.max(1, end ?? 0, ...rows.map((r) => r.to));
  const pct = (x: number) => `${(Math.max(0, x) / scale) * 100}%`;
  return (
    <figure className="space-y-1 text-xs" data-testid="latency-waterfall">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
          {timing.voice ? "最近一轮：从对方说完到她开口" : "最近一轮：从对方说完到她回第一句"}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono tabular-nums">{end !== undefined ? duration(end) : "待测"}</span>
      </figcaption>
      <ol className="space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[1.1rem_1fr_4.4rem] items-center gap-1.5" title={r.label}>
            <span className={`text-sm leading-none ${r.accent ? "text-primary" : "text-muted"}`} style={{ fontFamily: "var(--font-kai)" }}>
              {r.char}
            </span>
            <span className="relative h-2.5">
              <span className="absolute inset-y-[45%] left-0 right-0 bg-border" />
              <span
                className={`absolute inset-y-0 rounded-[1px] ${r.accent ? "bg-primary" : "bg-foreground/80"}`}
                style={{ left: pct(r.from), width: pct(Math.max(r.to - r.from, scale * 0.006)) }}
              />
            </span>
            <span className="text-right font-mono tabular-nums text-muted">
              {r.note ? "约 " : ""}
              {duration(r.to - r.from)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] leading-snug text-muted">
        {simulated ? "模拟用时：数字是模拟器给的，只说明每一步是什么。" : ""}
        {!timing.guarded
          ? "这个配置没有护栏，话不经检查就说出口。"
          : timing.policy === "S3"
            ? "先播后截：话先说出口，护栏在后面查，开口不用等，但越界的话可能先漏出去一截。"
            : timing.voice && timing.policy === "S2"
              ? "红色那段是护栏在把关；声音同时在合成，红段比「合」短时几乎不用多等。"
              : "红色那段是护栏在把关：为了不说错话，多等的这一下。"}
      </p>
    </figure>
  );
}
