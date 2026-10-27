"use client";

// 一轮的耗时瀑布（ADR-021）：从收到对方的话，到角色第一声出来，时间花在哪几段。
//   想  生成第一句（服务端：本轮开始 → 第一句生成好）
//   审  护栏判定（服务端：第一句生成好 → 放行）；朱红，表示「守分寸」花掉的时间
//   合  合成第一段声音（服务端：开始合成 → 第一块音频；边审边合成时和「审」同时进行）
//   达  送到浏览器并出声（浏览器计时的首声等待，减去服务端放行和合成就绪的时刻）
// 服务端各段和浏览器首声是两个时钟，中间差一次事件推送（本机实测几毫秒），所以「达」是估算，界面上写明。

import type { RunEvent } from "@/lib/domain/types";

export interface TurnTiming {
  turn_id: string;
  think?: number;
  release?: number;
  guard?: number;
  ttsStart?: number;
  tts?: number;
  firstAudio?: number;
  voice: boolean;
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
  const rel = mine.find((e) => e.type === "utterance_released");
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
    guarded,
  };
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
  if (t.think !== undefined) rows.push({ key: "think", char: "想", label: "生成第一句", from: 0, to: t.think });
  // 被拦下的一轮，放行的是兜底句，它本身不带护栏耗时；从第一句生成好到放行，仍然都是「审」
  if (t.guarded && t.think !== undefined && t.release !== undefined)
    rows.push({ key: "check", char: "审", label: "护栏判定", from: t.think, to: t.release, accent: true });
  if (t.voice && t.ttsStart !== undefined && t.tts !== undefined)
    rows.push({ key: "tts", char: "合", label: "合成第一段声音", from: t.ttsStart, to: t.ttsStart + t.tts });
  if (t.voice && t.firstAudio !== undefined && t.release !== undefined) {
    const ready = Math.max(t.release, t.ttsStart !== undefined && t.tts !== undefined ? t.ttsStart + t.tts : t.release);
    rows.push({
      key: "deliver",
      char: "达",
      label: "送到浏览器并出声",
      from: Math.min(ready, t.firstAudio),
      to: t.firstAudio,
      note: "估算",
    });
  }
  return rows;
}

export default function LatencyWaterfall({ timing }: { timing: TurnTiming | null }) {
  if (!timing) {
    return (
      <p className="text-xs text-muted" data-testid="latency-waterfall">
        跑完第一轮后，这里拆开显示时间花在哪几段。
      </p>
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
          这一轮的时间花在哪
        </span>
        <span className="font-mono tabular-nums">
          {timing.voice ? "首声" : "首句放行"} {end !== undefined ? `${Math.round(end)} ms` : "待测"}
        </span>
      </figcaption>
      <ol className="space-y-1">
        {rows.map((r) => (
          <li key={r.key} className="grid grid-cols-[1.1rem_1fr_3.6rem] items-center gap-1.5" title={r.label}>
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
              {Math.round(r.to - r.from)}
              {r.note ? "≈" : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[11px] leading-snug text-muted">
        {timing.guarded ? "朱红一段是「审」：守分寸花掉的时间。" : "这个配置没有护栏，不经过「审」。"}
        {timing.voice ? "「达」用浏览器计时估算。" : ""}
        {timing.voice && timing.ttsStart === timing.think ? "边审边合成，合成和审同时进行。" : ""}
      </p>
    </figure>
  );
}
