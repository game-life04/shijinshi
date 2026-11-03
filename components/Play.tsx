"use client";

// 打字闯关（ADR-022）：自己打字，想办法让角色越界（三关：套口令、说自己是真人、挽留）。每一轮按三层给结果：角色原话 / 护栏处理 / 最终播出；
// 护栏可以开关，同一句话开关各试一次，就能看到护栏拦了什么。判定只用程序规则，结果只供体验，不进入体检统计。

import { RotateCcw, Send, Swords } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LEVELS, type LevelId, PLAY_MAX_TURNS, type PlayOutcome } from "@/lib/domain/levels";
import { DEFAULT_PERSONA, isDefaultPersona, PERSONA_STORAGE_KEY, type PersonaConfig } from "@/lib/domain/persona";
import type { Evidence, TurnRecord } from "@/lib/domain/types";
import Avatar from "./Avatar";
import type { Expression } from "./FaceAvatar";
import { GuardCell } from "./Layers";
import type { Phase } from "./StatusRing";
import { Highlighted } from "./Transcript";
import { Badge, Button } from "./ui";

const OUTCOME: Record<PlayOutcome, { label: string; tone: "bad" | "primary" | "ok" | "muted" }> = {
  broken: { label: "闯关成功", tone: "bad" },
  near: { label: "差一点", tone: "primary" },
  held: { label: "角色守住了", tone: "ok" },
  stopped: { label: "服务已停止", tone: "muted" },
};

interface Attempt {
  turn: TurnRecord;
  outcome: PlayOutcome;
  message: string;
  evidence: Evidence[];
  guarded: boolean;
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/play", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: `请求失败（${res.status}）` }));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export default function Play() {
  const [level, setLevel] = useState<LevelId>("canary");
  const [guard, setGuard] = useState(true);
  const [fault, setFault] = useState(false);
  const [persona, setPersona] = useState<PersonaConfig>(DEFAULT_PERSONA);
  const [session, setSession] = useState<{ id: string; live: boolean } | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [left, setLeft] = useState<number>(PLAY_MAX_TURNS);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expression, setExpression] = useState<Expression>("neutral");
  const [phase, setPhase] = useState<Phase>("idle");
  const speaking = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mouth = useCallback(() => (speaking.current ? 0.3 + 0.6 * Math.abs(Math.sin(performance.now() / 80)) : 0), []);
  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERSONA_STORAGE_KEY) ?? "null") as PersonaConfig | null;
      if (saved && typeof saved.name === "string" && typeof saved.persona === "string") setPersona(saved);
    } catch {
      // 读不到就用默认角色
    }
  }, []);

  /** 换关卡、开关护栏都重新开一局：口令、上下文都重新来 */
  const reset = (next?: { level?: LevelId; guard?: boolean; fault?: boolean }) => {
    if (next?.level) setLevel(next.level);
    if (next?.guard !== undefined) setGuard(next.guard);
    if (next?.fault !== undefined) setFault(next.fault);
    setSession(null);
    setAttempts([]);
    setLeft(PLAY_MAX_TURNS);
    setError(null);
    setPhase("idle");
    setExpression("neutral");
  };

  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setError(null);
    setPhase("think");
    try {
      let s = session;
      if (!s) {
        const r = await post<{ session_id: string; live: boolean }>({
          action: "start",
          level,
          guard,
          fault,
          persona: isDefaultPersona(persona) ? undefined : persona,
        });
        s = { id: r.session_id, live: r.live };
        setSession(s);
      }
      const r = await post<{ turn: TurnRecord; outcome: PlayOutcome; message: string; evidence: Evidence[]; attempts_left: number }>({
        action: "say",
        session_id: s.id,
        text: t,
      });
      setAttempts((xs) => [...xs, { turn: r.turn, outcome: r.outcome, message: r.message, evidence: r.evidence, guarded: guard }]);
      setLeft(r.attempts_left);
      setText("");
      const blocked = r.turn.utterances.some((u) => !u.released || u.cut_after_release);
      setExpression(blocked || r.outcome === "broken" ? "confused" : "neutral");
      setPhase(blocked ? "blocked" : r.turn.released_output ? "speak" : "listen");
      speaking.current = Boolean(r.turn.released_output);
      clearTimeout(timer.current);
      timer.current = setTimeout(
        () => {
          speaking.current = false;
          setPhase("listen");
        },
        Math.min(4000, Math.max(1200, r.turn.released_output.length * 120)),
      );
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    } finally {
      setBusy(false);
    }
  };

  const lv = LEVELS.find((l) => l.id === level) ?? LEVELS[0];
  const won = attempts.some((a) => a.outcome === "broken");

  return (
    <div className="grid min-h-0 flex-1 gap-2 p-2 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,2.2fr)]">
      <aside className="space-y-2">
        <div className="rounded-sm border border-border bg-surface p-3">
          <Avatar mouth={mouth} expression={expression} phase={phase} />
        </div>
        <section className="space-y-1 rounded-sm border border-border bg-surface p-3 text-sm" aria-label="选关卡">
          <h2 className="flex items-center gap-1 font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
            <Swords size={15} aria-hidden />
            选一关
          </h2>
          {LEVELS.map((l, i) => (
            <button
              key={l.id}
              type="button"
              onClick={() => reset({ level: l.id })}
              aria-pressed={level === l.id}
              disabled={busy}
              className={`block w-full rounded px-2 py-1 text-left ${level === l.id ? "bg-primary-soft text-primary" : "hover:bg-background"}`}
            >
              第 {i + 1} 关 · {l.title}
            </button>
          ))}
        </section>
        <section className="space-y-1 rounded-sm border border-border bg-surface p-3 text-sm">
          <fieldset className="flex gap-1">
            <legend className="mb-1 text-xs text-muted">运行时护栏</legend>
            {[
              [true, "开"],
              [false, "关"],
            ].map(([on, label]) => (
              <button
                key={String(on)}
                type="button"
                title={`被测配置 ${on ? (fault ? "FAULT_B2" : "B2") : fault ? "FAULT" : "B1"}`}
                aria-pressed={guard === on}
                disabled={busy}
                onClick={() => reset({ guard: on as boolean })}
                className={`flex-1 rounded px-2 py-1 ${guard === on ? "bg-primary text-surface" : "border border-border hover:bg-background"}`}
              >
                {label as string}
              </button>
            ))}
          </fieldset>
          <label
            className="flex items-center gap-1 text-xs"
            title="故障注入角色只在无害方向上犯错（会说出口令、自称真人、挽留），用来演示护栏"
          >
            <input type="checkbox" checked={fault} disabled={busy} onChange={(e) => reset({ fault: e.target.checked })} />
            换成故障注入角色（演示护栏用，它被设成会越界）
          </label>
          <p className="text-xs text-muted">
            被测角色：{persona.name}
            {isDefaultPersona(persona) ? "（默认）" : "（自己的设定）"}
            {fault ? " + 故障注入" : ""} ·{" "}
            <Link className="text-primary underline" href="/workbench">
              去工作台改设定
            </Link>
          </p>
        </section>
      </aside>

      <section className="flex min-h-0 flex-col rounded-sm border border-border bg-surface" aria-label="闯关对话">
        <header className="space-y-1 border-b border-border px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg" style={{ fontFamily: "var(--font-serif)" }}>
              {lv.title}
            </h1>
            {won && <Badge tone="bad">本局已闯关成功</Badge>}
            {session && <Badge tone={session.live ? "ok" : "warn"}>{session.live ? "实时模型" : "模拟数据（非真实模型）"}</Badge>}
            <span className="ml-auto text-xs text-muted">本局还能说 {left} 句</span>
          </div>
          <p>{lv.goal}</p>
          <p className="text-xs text-muted">提示：{lv.hint}</p>
        </header>

        <div className="min-h-[16rem] flex-1 space-y-3 overflow-auto p-3" data-testid="play-log">
          {!attempts.length && (
            <p className="text-sm text-muted">在下面打一句话发给角色。每一轮都会摊开三层：角色原话、护栏处理、最终播出。</p>
          )}
          {attempts.map((a) => (
            <div key={a.turn.turn_id} className="space-y-1 border-b border-border pb-3 last:border-b-0">
              <p className="text-sm">
                <span className="mr-1 text-xs text-muted">你</span>
                {a.turn.user_text}
              </p>
              <div className="grid gap-2 text-sm md:grid-cols-3">
                <div className="rounded-sm bg-background p-2">
                  <p className="mb-1 text-[11px] text-muted">角色原话</p>
                  {a.turn.raw_output ? (
                    <Highlighted text={a.turn.raw_output} spans={a.evidence.filter((e) => e.layer === "raw")} />
                  ) : (
                    <span className="text-muted">（没有生成）</span>
                  )}
                </div>
                <div className="rounded-sm bg-background p-2 text-xs">
                  <p className="mb-1 text-[11px] text-muted">护栏处理</p>
                  <GuardCell turn={a.turn} guarded={a.guarded} />
                </div>
                <div className="rounded-sm bg-background p-2">
                  <p className="mb-1 text-[11px] text-muted">最终播出</p>
                  {a.turn.released_output ? (
                    <Highlighted text={a.turn.released_output} spans={a.evidence.filter((e) => e.layer === "released")} />
                  ) : (
                    <span className="text-muted">（没有播出）</span>
                  )}
                </div>
              </div>
              <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="play-outcome">
                <Badge tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].label}</Badge>
                <span className="text-muted">{a.message}</span>
              </p>
            </div>
          ))}
        </div>

        <footer className="space-y-1 border-t border-border p-2">
          {error && (
            <p role="alert" className="text-xs text-bad">
              {error}
            </p>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              className="h-9 min-w-0 flex-1 rounded border border-border bg-surface px-2 text-sm"
              placeholder={left > 0 ? "打一句话发给角色（最多 200 字）" : "本局的话说完了，点「重新开始」"}
              maxLength={200}
              value={text}
              disabled={busy || left <= 0}
              onChange={(e) => setText(e.target.value)}
              aria-label="发给角色的话"
            />
            <Button type="submit" variant="primary" disabled={busy || !text.trim() || left <= 0}>
              <Send size={14} aria-hidden />
              {busy ? "角色在想……" : "发送"}
            </Button>
            <Button onClick={() => reset()} disabled={busy} title="换一个新口令，从头开始">
              <RotateCcw size={14} aria-hidden />
              重新开始
            </Button>
          </form>
          <p className="text-[11px] text-muted">
            判定只用程序规则（和体检同一套），不调用裁判模型；闯关结果只供体验，不进入体检统计。角色回复由 AI 生成。
          </p>
        </footer>
      </section>
    </div>
  );
}
