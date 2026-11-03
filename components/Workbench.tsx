"use client";

// 体检工作台（首屏）：上方配置（含角色设定：开发者粘贴自己的人设和边界），左侧月洞窗里的角色（外圈状态环）、耗时瀑布与用例进度，
// 中间对话，右侧三层结果（角色原话 / 护栏处理 / 最终播出）、证据与 Agent 工具调用，底部计量。
// 改一处再测：上一次跑完的运行记下来，这次跑完给出「和上一次比」的入口（ADR-022）。
// 运行过程通过事件流实时更新；每完成一例就取一次最新结果（含结论与证据）。
// 语音运行：事件流驱动播放器——句子放行就取音频播放，护栏截断或终止就按代际丢弃旧音频；
// 服务端开始等本轮播放结果时，把渲染区间和计时上报回去（漏出时长由服务端算）。

import { Pause, Play, RotateCcw, Square, TriangleAlert, UserRound } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VoicePlayer } from "@/lib/client/voice-player";
import { caseLayers } from "@/lib/domain/layers";
import { DEFAULT_PERSONA, isDefaultPersona, PERSONA_LIMITS, PERSONA_STORAGE_KEY, type PersonaConfig } from "@/lib/domain/persona";
import {
  type CaseResult,
  FAMILY_LABEL,
  type Family,
  GUARDED_VARIANTS,
  POLICY_LABEL,
  type ReleasePolicy,
  type RunEvent,
  type RunManifest,
  type SubjectVariant,
  type TurnRecord,
  VARIANT_LABEL,
  VARIANTS,
} from "@/lib/domain/types";
import Avatar from "./Avatar";
import type { Expression } from "./FaceAvatar";
import LatencyWaterfall, { latestTiming } from "./LatencyWaterfall";
import { LayerStrip } from "./Layers";
import type { Phase } from "./StatusRing";
import { FindingView, TurnView } from "./Transcript";
import { Badge, Button, CaseBadge, Metric, Panel } from "./ui";

interface CaseSummary {
  id: string;
  family: Family;
  modality: "text" | "voice";
  approval: string;
  inputs: string[];
  expected: string;
}
interface Status {
  live: boolean;
  models: Record<string, string>;
  suites: { id: string; file: string; errors: string[]; cases: CaseSummary[] }[];
  kb: { clauses: number; hash: string };
}
interface RunView {
  manifest: RunManifest;
  results: CaseResult[];
  events: RunEvent[];
  cases: { id: string }[];
}

const FINAL = new Set(["completed", "cancelled", "failed"]);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({ error: `请求失败（${res.status}）` }));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export default function Workbench() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suite, setSuite] = useState("smoke");
  const [variant, setVariant] = useState<SubjectVariant>("B2");
  const [policy, setPolicy] = useState<ReleasePolicy>("S2");
  const [voice, setVoice] = useState(false);
  const [guardDelay, setGuardDelay] = useState(0);
  const [judgeRag, setJudgeRag] = useState(true);
  const [includeDrafts, setIncludeDrafts] = useState(true);
  const [maxTurns, setMaxTurns] = useState(3);
  const [maxCases, setMaxCases] = useState(20);
  const [maxCalls, setMaxCalls] = useState(200);
  const [persona, setPersona] = useState<PersonaConfig>(DEFAULT_PERSONA);
  const [personaOpen, setPersonaOpen] = useState(false);
  /** 上一次跑完的运行：这次跑完后可以和它做前后对比 */
  const [prevRunId, setPrevRunId] = useState<string | null>(null);

  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [results, setResults] = useState<CaseResult[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [runCases, setRunCases] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"cases" | "dialog" | "evidence">("cases");

  const speakingRef = useRef(false);
  const speakTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [expression, setExpression] = useState<Expression>("neutral");
  const esRef = useRef<EventSource | null>(null);

  // 形象状态环：听 / 想 / 审 / 说 / 拦。「拦」和文字运行里的「说」要停留一会儿，期间来的新状态等它结束再换
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const holdRef = useRef<{ until: number; timer?: ReturnType<typeof setTimeout> }>({ until: 0 });
  const guardedRef = useRef(false);
  const setPhase = useCallback((p: Phase, holdMs = 0) => {
    const h = holdRef.current;
    const now = performance.now();
    clearTimeout(h.timer);
    const apply = () => {
      phaseRef.current = p;
      setPhaseState(p);
    };
    if (!holdMs && now < h.until) {
      h.timer = setTimeout(apply, h.until - now);
      return;
    }
    h.until = holdMs ? now + holdMs : 0;
    apply();
  }, []);
  useEffect(() => () => clearTimeout(holdRef.current.timer), []);

  // 语音：播放器只建一个（AudioContext 要用户点击才能启动，之后一直复用）
  const playerRef = useRef<VoicePlayer | null>(null);
  const voiceRunRef = useRef<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const player = () => {
    playerRef.current ??= new VoicePlayer();
    return playerRef.current;
  };
  useEffect(() => () => void playerRef.current?.close(), []);
  // 勾上「语音播放」就提前建好音频引擎，开始体检时第一轮不用再等加载
  useEffect(() => {
    if (!voice) return;
    playerRef.current ??= new VoicePlayer();
    void playerRef.current.prewarm();
  }, [voice]);
  /** 形象每帧读一次口型：语音运行按实际渲染的响度；文字运行按放行事件做示意 */
  const mouth = useCallback(() => {
    if (voiceRunRef.current && playerRef.current) return playerRef.current.mouthOpen();
    return speakingRef.current ? 0.3 + 0.6 * Math.abs(Math.sin(performance.now() / 80)) : 0;
  }, []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERSONA_STORAGE_KEY) ?? "null") as PersonaConfig | null;
      if (saved && typeof saved.name === "string" && typeof saved.persona === "string" && typeof saved.boundaries === "string") {
        setPersona(saved);
      }
    } catch {
      // 浏览器不让读本地存储：用默认角色
    }
  }, []);
  const updatePersona = (next: PersonaConfig) => {
    setPersona(next);
    try {
      if (isDefaultPersona(next)) localStorage.removeItem(PERSONA_STORAGE_KEY);
      else localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存不下就只在这次页面里有效
    }
  };

  const loadStatus = useCallback(() => {
    setLoadError(null);
    api<Status>("/api/status")
      .then(setStatus)
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);
  useEffect(() => () => esRef.current?.close(), []);

  const suiteInfo = status?.suites.find((s) => s.id === suite);
  const approvedCount = suiteInfo?.cases.filter((c) => c.approval === "approved").length ?? 0;

  const refresh = useCallback(async (id: string) => {
    const v = await api<RunView>(`/api/runs/${id}`);
    setManifest(v.manifest);
    setResults(v.results);
    setRunCases(new Set(v.cases.map((c) => c.id)));
  }, []);

  /** 语音运行的事件 → 播放器动作。按 seq 去重：断线重连会补发历史事件，不能重复播放 */
  const onVoiceEvent = useCallback((e: RunEvent) => {
    if (voiceRunRef.current !== e.run_id || seenRef.current.has(e.seq)) return;
    seenRef.current.add(e.seq);
    const p = playerRef.current;
    if (!p) return;
    if (e.type === "turn_started" && e.turn_id) p.beginTurn(e.turn_id);
    else if (e.type === "utterance_released" && e.turn_id && e.utterance_id) p.play(e.run_id, e.turn_id, e.utterance_id);
    else if (e.type === "utterance_cut") p.cut("cut");
    else if (e.type === "run_cancelling") p.cut("cancelled");
    else if (e.type === "playback_waiting" && e.turn_id) {
      void p
        .finishTurn(e.turn_id)
        .then((report) =>
          fetch(`/api/runs/${e.run_id}/playback`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
          }),
        )
        .catch(() => {});
    }
  }, []);

  const onEvent = useCallback(
    (e: RunEvent) => {
      setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e]));
      onVoiceEvent(e);
      if (e.type === "case_started" && e.case_id) setSelected((s) => s ?? e.case_id ?? null);
      const voiced = voiceRunRef.current === e.run_id;
      if (e.type === "run_started" || e.type === "case_started" || e.type === "judging") setPhase("listen");
      else if (e.type === "turn_started") setPhase("think");
      else if (e.type === "utterance_ready" && guardedRef.current && phaseRef.current !== "speak") setPhase("check");
      else if (e.type === "utterance_released") setPhase("speak", voiced ? 0 : Math.min(3000, String(e.data?.text ?? "").length * 120));
      else if (e.type === "utterance_blocked" || e.type === "utterance_cut") setPhase("blocked", 1500);
      else if (e.type === "playback_metrics" || e.type === "playback_timeout" || e.type === "turn_finished") setPhase("listen");
      else if (e.type === "run_finished" || e.type === "run_cancelling") setPhase("idle");
      if (e.type === "utterance_released") {
        const text = String(e.data?.text ?? "");
        speakingRef.current = true;
        clearTimeout(speakTimer.current);
        speakTimer.current = setTimeout(
          () => {
            speakingRef.current = false;
          },
          Math.min(3000, text.length * 120),
        );
        setExpression("neutral");
      }
      if (e.type === "utterance_blocked" || e.type === "utterance_cut") {
        speakingRef.current = false;
        setExpression("confused");
      }
      if (e.type === "case_finished" || e.type === "run_finished" || e.type.startsWith("run_")) {
        void refresh(e.run_id).catch(() => {});
      }
    },
    [refresh, onVoiceEvent, setPhase],
  );

  const start = async () => {
    setActionError(null);
    voiceRunRef.current = null;
    if (voice) {
      // 必须在这次点击里启动 AudioContext，否则浏览器不允许出声
      try {
        await player().unlock();
        player().reset();
      } catch (e) {
        setActionError((e as Error).message);
        return;
      }
    }
    setBusy(true);
    esRef.current?.close();
    if (manifest && FINAL.has(manifest.state)) setPrevRunId(manifest.run_id);
    guardedRef.current = GUARDED_VARIANTS.includes(variant);
    setPhase("listen");
    setEvents([]);
    setResults([]);
    setRunCases(new Set());
    setSelected(null);
    try {
      const m = await api<RunManifest>("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suite,
          variant,
          policy,
          judge_rag: judgeRag,
          include_drafts: includeDrafts,
          max_turns: maxTurns,
          max_cases: maxCases,
          max_llm_calls: maxCalls,
          voice,
          guard_delay_ms: guardDelay,
          persona: isDefaultPersona(persona) ? undefined : persona,
        }),
      });
      setManifest(m);
      if (voice) {
        seenRef.current = new Set();
        voiceRunRef.current = m.run_id;
        player().onError = (msg) => setActionError(`语音播放出错：${msg}`);
      }
      await refresh(m.run_id);
      const es = new EventSource(`/api/runs/${m.run_id}/events`);
      es.onmessage = (msg) => onEvent(JSON.parse(msg.data) as RunEvent);
      es.onerror = () => {
        es.close();
        // 断线后用一次查询把状态补齐；不会因为断线把结果当成通过
        void refresh(m.run_id).catch(() => setActionError("事件流断开，已停止实时更新，可刷新页面查看最新状态"));
      };
      esRef.current = es;
    } catch (e) {
      setActionError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: "pause" | "resume" | "cancel") => {
    if (!manifest) return;
    setActionError(null);
    try {
      setManifest(await api<RunManifest>(`/api/runs/${manifest.run_id}/${action}`, { method: "POST" }));
    } catch (e) {
      setActionError((e as Error).message);
    }
  };

  // 每个用例的实时状态：已有结果用结果，否则看事件
  const caseState = useMemo(() => {
    const m = new Map<string, { status?: CaseResult["status"] | "running"; verdict?: CaseResult["verdict"] }>();
    for (const e of events) {
      if (e.type === "case_started" && e.case_id) m.set(e.case_id, { status: "running" });
    }
    for (const r of results) m.set(r.case_id, { status: r.status, verdict: r.verdict });
    return m;
  }, [events, results]);

  const selectedResult = results.find((r) => r.case_id === selected);
  const liveTurns: TurnRecord[] = useMemo(() => {
    if (!selected || selectedResult) return [];
    // 结果还没出来时，用事件拼出正在进行的对话
    const turns = new Map<string, TurnRecord>();
    for (const e of events.filter((x) => x.case_id === selected && x.turn_id)) {
      const id = e.turn_id as string;
      const t =
        turns.get(id) ??
        ({
          turn_id: id,
          index: turns.size + 1,
          user_text: "",
          raw_output: "",
          released_output: "",
          utterances: [],
          service: { exited: false, reminder_emitted: false, reminder_simulated: false },
          provider_blocked: false,
          timing_ms: { total: 0 },
        } as TurnRecord);
      if (e.type === "turn_started") t.user_text = String(e.data?.user_text ?? "");
      if (e.type === "utterance_released") t.released_output += String(e.data?.text ?? "");
      if (e.type === "utterance_blocked")
        t.utterances.push({ utterance_id: e.utterance_id ?? "", text: String(e.data?.text ?? ""), released: false });
      if (e.type === "service_exited") t.service.exited = true;
      if (e.type === "usage_reminder") t.service.reminder_emitted = true;
      turns.set(id, t);
    }
    return [...turns.values()];
  }, [events, selected, selectedResult]);
  const toolSteps = events.filter((e) => e.case_id === selected && e.source === "tester");
  const audioStats = useMemo(() => summarizeAudio(events), [events]);
  const timing = useMemo(
    () =>
      latestTiming(
        events,
        manifest?.config.policy,
        Boolean(manifest?.config.voice),
        Boolean(manifest && GUARDED_VARIANTS.includes(manifest.config.variant)),
      ),
    [events, manifest],
  );

  const running = manifest && !FINAL.has(manifest.state);
  const cases = suiteInfo?.cases ?? [];
  // 运行开始后只列本次实际计划的用例（受草稿开关和数量上限影响）
  const shownCases = manifest && runCases.size ? cases.filter((c) => runCases.has(c.id)) : cases;
  const counts = manifest?.counts;

  if (loadError) {
    return (
      <div className="m-4 rounded-sm border border-bad/40 bg-bad-soft p-4 text-sm">
        <p className="flex items-center gap-1 font-medium text-bad">
          <TriangleAlert size={16} aria-hidden />
          工作台初始化失败：{loadError}
        </p>
        <p className="mt-1 text-muted">常见原因：用例文件校验没通过、条文库缺失。修好后点重试。</p>
        <div className="mt-2">
          <Button onClick={loadStatus}>
            <RotateCcw size={14} aria-hidden />
            重试
          </Button>
        </div>
      </div>
    );
  }
  if (!status) return <p className="p-4 text-sm text-muted">正在载入用例库和模型配置……</p>;

  const panelClass = (name: typeof tab) => `${tab === name ? "flex" : "hidden"} lg:flex`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      {/* 配置条 */}
      <div className="flex flex-wrap items-end gap-2 rounded-sm border border-border bg-surface p-2 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">被测配置</span>
          <select
            className="h-8 rounded border border-border bg-surface px-1"
            value={variant}
            onChange={(e) => setVariant(e.target.value as SubjectVariant)}
            disabled={Boolean(running)}
          >
            {VARIANTS.map((v) => (
              <option key={v} value={v}>
                {VARIANT_LABEL[v]}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">被测角色</span>
          <button
            type="button"
            onClick={() => setPersonaOpen((o) => !o)}
            aria-expanded={personaOpen}
            className="inline-flex h-8 items-center gap-1 rounded border border-border bg-surface px-2 hover:bg-background"
            data-testid="persona-toggle"
          >
            <UserRound size={14} aria-hidden />
            {persona.name}
            <span className="text-xs text-muted">{isDefaultPersona(persona) ? "（默认）" : "（自己的设定）"}</span>
          </button>
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">用例套件</span>
          <select
            className="h-8 rounded border border-border bg-surface px-1"
            value={suite}
            onChange={(e) => setSuite(e.target.value)}
            disabled={Boolean(running)}
          >
            {status.suites.map((s) => (
              <option key={s.id} value={s.id} disabled={s.errors.length > 0}>
                {s.id}（{s.cases.length} 例{s.errors.length ? "，校验失败" : ""}）
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">放行策略</span>
          <select
            className="h-8 rounded border border-border bg-surface px-1"
            value={policy}
            onChange={(e) => setPolicy(e.target.value as ReleasePolicy)}
            disabled={Boolean(running)}
          >
            {(Object.keys(POLICY_LABEL) as ReleasePolicy[]).map((p) => (
              <option key={p} value={p}>
                {POLICY_LABEL[p]}
                {p === "S2" ? "（默认）" : ""}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex flex-col gap-0.5"
          title="实验设定（规格 02 E2）：给每句护栏判定加一个固定、已知的延迟，用来观察放行策略的差别；不是真实模型的延迟"
        >
          <span className="text-xs text-muted">护栏固定延迟 ms</span>
          <input
            type="number"
            min={0}
            max={10000}
            step={100}
            className="h-8 w-20 rounded border border-border bg-surface px-1"
            value={guardDelay}
            onChange={(e) => setGuardDelay(Number(e.target.value))}
            disabled={Boolean(running)}
          />
        </label>
        <label className="flex flex-col gap-0.5" title="测试 Agent 每例最多几轮（规格上限 3）">
          <span className="text-xs text-muted">每例轮数</span>
          <input
            type="number"
            min={1}
            max={3}
            className="h-8 w-16 rounded border border-border bg-surface px-1"
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
            disabled={Boolean(running)}
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">最多用例</span>
          <input
            type="number"
            min={1}
            max={20}
            className="h-8 w-16 rounded border border-border bg-surface px-1"
            value={maxCases}
            onChange={(e) => setMaxCases(Number(e.target.value))}
            disabled={Boolean(running)}
          />
        </label>
        <label className="flex flex-col gap-0.5" title="含测试 Agent、被测角色、护栏、裁判的全部模型调用">
          <span className="text-xs text-muted">调用上限</span>
          <input
            type="number"
            min={1}
            max={500}
            className="h-8 w-20 rounded border border-border bg-surface px-1"
            value={maxCalls}
            onChange={(e) => setMaxCalls(Number(e.target.value))}
            disabled={Boolean(running)}
          />
        </label>
        <label className="flex h-8 items-center gap-1" title="放行的句子合成语音，在浏览器播放并计量；每轮播完才进入下一轮">
          <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} disabled={Boolean(running)} />
          语音播放
        </label>
        <label className="flex h-8 items-center gap-1">
          <input type="checkbox" checked={judgeRag} onChange={(e) => setJudgeRag(e.target.checked)} disabled={Boolean(running)} />
          裁判先查条文
        </label>
        <label className="flex h-8 items-center gap-1" title="草稿用例未经人工审核，只能作预览，不计入正式结果">
          <input type="checkbox" checked={includeDrafts} onChange={(e) => setIncludeDrafts(e.target.checked)} disabled={Boolean(running)} />
          包含草稿（预览）
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge
            tone={status.live ? "ok" : "warn"}
            title={status.live ? "使用真实云端模型" : "没有配置 LLM_API_KEY：使用确定性模拟器，结果不能当实验数据"}
          >
            {status.live ? "实时模型" : "模拟数据（非真实模型）"}
          </Badge>
          {!running && (
            <Button variant="primary" onClick={start} disabled={busy || !suiteInfo || suiteInfo.errors.length > 0}>
              <Play size={14} aria-hidden />
              开始体检
            </Button>
          )}
          {manifest?.state === "running" && (
            <Button onClick={() => act("pause")} title="当前用例跑完后暂停，不再派发新用例">
              <Pause size={14} aria-hidden />
              暂停
            </Button>
          )}
          {(manifest?.state === "paused" || manifest?.state === "pausing") && (
            <Button onClick={() => act("resume")}>
              <Play size={14} aria-hidden />
              继续
            </Button>
          )}
          {running && (
            <Button variant="danger" onClick={() => act("cancel")} title="立即中止当前用例，不可恢复">
              <Square size={14} aria-hidden />
              终止
            </Button>
          )}
        </div>
      </div>

      {personaOpen && (
        <PersonaPanel value={persona} disabled={Boolean(running)} onChange={updatePersona} onClose={() => setPersonaOpen(false)} />
      )}

      {!includeDrafts && approvedCount === 0 && (
        <p className="rounded border border-warn/50 bg-warn-soft px-3 py-1.5 text-xs">
          这个套件还没有经过人工审核的用例。正式运行只接受已审核用例；要先看效果，请勾选「包含草稿（预览）」。
        </p>
      )}
      {actionError && (
        <p role="alert" className="rounded border border-bad/40 bg-bad-soft px-3 py-1.5 text-xs text-bad">
          {actionError}
        </p>
      )}

      {/* 手机上的标签页 */}
      <div className="flex gap-1 lg:hidden" role="tablist">
        {(
          [
            ["cases", "用例"],
            ["dialog", "对话"],
            ["evidence", "证据"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`flex-1 rounded px-2 py-1 text-sm ${tab === k ? "bg-primary-soft text-primary" : "border border-border bg-surface"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.6fr)_minmax(0,1.3fr)]">
        {/* 左：角色 + 用例进度 */}
        <div className={`${panelClass("cases")} min-h-0 flex-col gap-2`}>
          <div className="rounded-sm border border-border bg-surface p-3">
            <Avatar mouth={mouth} expression={expression} phase={phase} />
            {manifest && (
              <div className="mt-2 border-t border-border pt-2">
                <LatencyWaterfall timing={timing} />
              </div>
            )}
            {manifest?.config.voice && <AudioMeters stats={audioStats} />}
          </div>
          <Panel title={`用例进度${manifest ? `（${manifest.counts.planned} 例）` : ""}`} className="min-h-[12rem] flex-1">
            <ul className="space-y-1">
              {shownCases.map((c) => {
                const s = caseState.get(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(c.id);
                        setTab("dialog");
                      }}
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${selected === c.id ? "bg-primary-soft" : "hover:bg-background"}`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-mono">{c.id}</span>
                        <span className="block truncate text-muted">
                          {FAMILY_LABEL[c.family]}
                          {c.approval !== "approved" ? " · 草稿" : ""}
                          {c.modality === "voice" ? " · 语音" : ""}
                        </span>
                      </span>
                      {manifest ? <CaseBadge status={s?.status ?? "queued"} verdict={s?.verdict} /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </div>

        {/* 中：对话 */}
        <Panel title={selected ? `对话 · ${selected}` : "对话"} className={`${panelClass("dialog")} min-h-[16rem]`}>
          {!manifest && <p className="text-sm text-muted">选好配置后点「开始体检」。左侧点任一用例可以看它的对话和证据。</p>}
          {manifest && !selected && <p className="text-sm text-muted">等待第一个用例开始……</p>}
          {selected && (
            <>
              <p className="mb-1 text-xs text-muted">期望：{cases.find((c) => c.id === selected)?.expected}</p>
              {(selectedResult?.turns ?? liveTurns).map((t) => (
                <TurnView key={t.turn_id} turn={t} evidence={selectedResult?.findings.flatMap((f) => f.evidence) ?? []} />
              ))}
              {selectedResult?.status === "not_run" && (
                <p className="text-sm text-muted">未执行：{selectedResult.error ?? "运行提前结束"}</p>
              )}
              {selectedResult?.error && selectedResult.status !== "not_run" && <p className="text-sm text-bad">{selectedResult.error}</p>}
            </>
          )}
        </Panel>

        {/* 右：结论、证据、工具调用 */}
        <Panel
          title="结论与证据"
          className={`${panelClass("evidence")} min-h-[16rem]`}
          actions={
            manifest && FINAL.has(manifest.state) ? (
              <span className="flex flex-wrap gap-2">
                <Link className="text-xs text-primary underline" href={`/reports/${manifest.run_id}`}>
                  打开体检单
                </Link>
                {prevRunId && (
                  <Link
                    className="text-xs text-primary underline"
                    href={`/compare?a=${prevRunId}&b=${manifest.run_id}`}
                    data-testid="compare-link"
                  >
                    和上一次比
                  </Link>
                )}
              </span>
            ) : null
          }
        >
          {!selectedResult && <p className="text-sm text-muted">用例跑完后，这里显示每条检查的结论、原文证据和依据条文。</p>}
          {selectedResult?.status === "completed" && manifest && (
            <div className="mb-2 space-y-1 border-b border-border pb-2">
              <LayerStrip layers={caseLayers(selectedResult, GUARDED_VARIANTS.includes(manifest.config.variant))} />
              <p className="text-xs text-muted">
                角色原话：{caseLayers(selectedResult, GUARDED_VARIANTS.includes(manifest.config.variant)).raw.note}
              </p>
            </div>
          )}
          {selectedResult?.findings.map((f) => (
            <FindingView key={f.finding_id} f={f} />
          ))}
          {toolSteps.length > 0 && (
            <div className="mt-2">
              <h3 className="text-xs font-semibold">测试 Agent 的工具调用</h3>
              <ol className="mt-1 space-y-1 text-xs">
                {toolSteps.map((s) => (
                  <li key={s.seq} className="rounded bg-background p-1.5">
                    <code>{String(s.data?.tool ?? s.type)}</code>{" "}
                    {s.data?.args ? <code className="text-muted">{JSON.stringify(s.data.args)}</code> : null}
                    <div className="text-muted">{String(s.data?.result ?? "")}</div>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>
      </div>

      {/* 底部计量 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-sm border border-border bg-surface px-3 py-2">
        <Metric label="运行状态" value={manifest ? stateLabel(manifest.state) : null} />
        <Metric
          label="对账（计划 = 完成 + 拦截 + 出错 + 取消 + 未执行）"
          value={
            counts
              ? `${counts.planned} = ${counts.completed} + ${counts.provider_blocked} + ${counts.error} + ${counts.cancelled} + ${counts.not_run}`
              : null
          }
        />
        <Metric
          label="合格 / 不合格 / 不确定 / 不适用"
          value={counts ? `${counts.pass} / ${counts.fail} / ${counts.uncertain} / ${counts.not_applicable}` : null}
        />
        <Metric label="模型调用" value={manifest ? `${manifest.usage.llm_calls} / ${manifest.config.max_llm_calls}` : null} />
        <Metric
          label="tokens（入/出）"
          value={manifest && status.live ? `${manifest.usage.prompt_tokens} / ${manifest.usage.completion_tokens}` : null}
          hint="模拟模式不产生 token"
        />
        {manifest?.preview && <Badge tone="warn">含草稿用例：预览结果，不计入正式统计</Badge>}
        {manifest?.failure_reason && <Badge tone="bad">{manifest.failure_reason}</Badge>}
      </div>
    </div>
  );
}

// ---------- 角色设定 ----------

/** 开发者粘贴自己角色的人设和边界提示；B0 只用人设，B1、B2 再加边界提示（B2 还有运行时护栏） */
function PersonaPanel({
  value,
  disabled,
  onChange,
  onClose,
}: {
  value: PersonaConfig;
  disabled: boolean;
  onChange: (p: PersonaConfig) => void;
  onClose: () => void;
}) {
  const field = "w-full rounded border border-border bg-surface p-1.5 text-sm";
  const count = (k: keyof PersonaConfig) => (
    <span className={`text-xs ${value[k].length > PERSONA_LIMITS[k] ? "text-bad" : "text-muted"}`}>
      {value[k].length} / {PERSONA_LIMITS[k]}
    </span>
  );
  return (
    <section className="space-y-2 rounded-sm border border-border bg-surface p-3 text-sm" aria-label="角色设定" data-testid="persona-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
          角色设定
        </h2>
        <span className="text-xs text-muted">
          粘贴你自己角色的人设和边界提示。B0 只用人设；B1 加边界提示；B2 再加运行时护栏。改一处再测，跑完点「和上一次比」。
        </span>
      </div>
      <label className="flex flex-col gap-0.5">
        <span className="flex justify-between text-xs text-muted">角色名 {count("name")}</span>
        <input
          className={`${field} h-8 max-w-xs`}
          value={value.name}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-xs text-muted">人设 {count("persona")}</span>
          <textarea
            className={field}
            rows={6}
            value={value.persona}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, persona: e.target.value })}
            data-testid="persona-text"
          />
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="flex justify-between text-xs text-muted">边界提示（B1、B2 才用） {count("boundaries")}</span>
          <textarea
            className={field}
            rows={6}
            value={value.boundaries}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, boundaries: e.target.value })}
            data-testid="boundaries-text"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onChange(DEFAULT_PERSONA)} disabled={disabled || isDefaultPersona(value)}>
          <RotateCcw size={14} aria-hidden />
          恢复默认角色
        </Button>
        <Button onClick={onClose}>收起</Button>
      </div>
    </section>
  );
}

// ---------- 语音计量 ----------

interface AudioUtt {
  utterance_id: string;
  rendered_ms: number;
  leak_rendered_ms: number | null;
  violation_level: "char" | "sentence_upper_bound" | null;
  cancel_to_stop_ms: number | null;
  cancel_to_mouth_zero_ms: number | null;
  outcome: string;
}

interface AudioStats {
  turns: number;
  timeouts: number;
  level?: string;
  firstLast?: number;
  firstMedian?: number;
  firstCount: number;
  cuts: AudioUtt[];
  guardLast?: number;
}

function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

function summarizeAudio(events: RunEvent[]): AudioStats {
  const metrics = events.filter((e) => e.type === "playback_metrics");
  const firsts = metrics.map((e) => e.data?.first_audio_ms).filter((x): x is number => typeof x === "number");
  const utts = metrics.flatMap((e) => (e.data?.utterances as AudioUtt[] | undefined) ?? []);
  const guard = events
    .filter((e) => e.type === "utterance_released" && typeof e.data?.guard_ms === "number")
    .map((e) => e.data?.guard_ms as number);
  return {
    turns: metrics.length,
    timeouts: events.filter((e) => e.type === "playback_timeout").length,
    level: metrics.at(-1)?.data?.level as string | undefined,
    firstLast: firsts.at(-1),
    firstMedian: median(firsts),
    firstCount: firsts.length,
    cuts: utts.filter((u) => u.violation_level !== null),
    guardLast: guard.at(-1),
  };
}

function AudioMeters({ stats }: { stats: AudioStats }) {
  const leak = stats.cuts.reduce((n, u) => n + (u.leak_rendered_ms ?? 0), 0);
  const upper = stats.cuts.some((u) => u.violation_level === "sentence_upper_bound");
  const lastCut = stats.cuts.at(-1);
  return (
    <div className="mt-2 space-y-1 border-t border-border pt-2 text-xs" data-testid="audio-meters">
      <div className="flex items-center justify-between gap-1">
        <span className="font-semibold">语音计量（浏览器渲染层）</span>
        {stats.level && <Badge tone={stats.level === "live" ? "ok" : "warn"}>{stats.level === "live" ? "真实合成" : "模拟发声"}</Badge>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
        <dt className="text-muted">违规音频渲染</dt>
        <dd data-testid="leak-meter">
          {stats.cuts.length
            ? `${Math.round(leak * 10) / 10} ms（${stats.cuts.length} 次截断，${upper ? "含句级上界" : "按字精确定位"}）`
            : "— 还没有截断"}
        </dd>
        <dt className="text-muted">首声等待</dt>
        <dd data-testid="first-audio-meter">
          {stats.firstLast !== undefined ? `最近 ${stats.firstLast} ms · 中位数 ${stats.firstMedian} ms（${stats.firstCount} 轮）` : "—"}
          {stats.guardLast !== undefined && <span className="text-muted"> · 其中护栏判定 {stats.guardLast} ms</span>}
        </dd>
        <dt className="text-muted">停止响应</dt>
        <dd>
          {lastCut?.cancel_to_stop_ms != null
            ? `≤ ${lastCut.cancel_to_stop_ms} ms · 口型归零 ${lastCut.cancel_to_mouth_zero_ms ?? "—"} ms`
            : "—"}
        </dd>
      </dl>
      {stats.timeouts > 0 && (
        <p className="text-warn">有 {stats.timeouts} 轮没等到浏览器的播放结果（标签页被关闭或切走），这些轮不计量。</p>
      )}
    </div>
  );
}

function stateLabel(s: RunManifest["state"]): string {
  return {
    queued: "排队",
    running: "运行中",
    pausing: "暂停中（等当前用例跑完）",
    paused: "已暂停",
    cancelling: "终止中",
    completed: "已完成",
    cancelled: "已终止",
    failed: "失败",
  }[s];
}
