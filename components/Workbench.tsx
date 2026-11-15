"use client";

// 体检工作台（首屏）：上方配置（含角色设定：开发者粘贴自己的人设和边界），左侧月洞窗里的角色（外圈状态环）、耗时瀑布与用例进度，
// 中间对话，右侧三层结果（角色原话 / 护栏处理 / 最终播出）、证据与 Agent 工具调用，底部计量。
// 改一处再测：上一次跑完的运行记下来（存在浏览器里，刷新页面也还在），这次跑完给出「和上一次比」的入口（ADR-022、评审 R23）。
// 评审第二批（ADR-035）：顶上一行说清这是干什么的、对照哪部法规，加「改了再测」四步路标；配置条只留主要几项，其余收进「实验设置」。
// ADR-049（学妹试用：「信息太繁杂」「对话才是重点」）：顶上那行说明和四步路标收进「怎么用」；七样、耗时的长说明收起来；
// 中间的对话最宽、框最重，两边窄一点、淡一点；底部计量压成一行，没开始体检时不显示。
// 运行过程通过事件流实时更新；每完成一例就取一次最新结果（含结论与证据）。
// 语音运行：事件流驱动播放器——句子放行就取音频播放，护栏截断或终止就按代际丢弃旧音频；
// 服务端开始等本轮播放结果时，把渲染区间和计时上报回去（漏出时长由服务端算）。

import { ChevronDown, Clapperboard, HelpCircle, Pause, Pencil, Play, RotateCcw, Square, TriangleAlert, UserRound } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePerformer } from "@/lib/client/avatar/stage";
import { EXPIRED_MESSAGE, toLoginIfExpired } from "@/lib/client/session-expired";
import { VoicePlayer } from "@/lib/client/voice-player";
import { withRecommendedClauses } from "@/lib/domain/fix-hints";
import { caseLayers } from "@/lib/domain/layers";
import {
  DEFAULT_PERSONA,
  isDefaultPersona,
  PERSONA_LIMITS,
  PERSONA_STORAGE_KEY,
  type PersonaConfig,
  parsePersona,
} from "@/lib/domain/persona";
import {
  type CaseIntent,
  type CaseResult,
  FAMILY_LABEL,
  type Family,
  GUARDED_VARIANTS,
  INTENT_LABEL,
  type ReleasePolicy,
  type RunEvent,
  type RunManifest,
  type SubjectVariant,
  type TurnRecord,
  type UtteranceRecord,
  VARIANTS,
} from "@/lib/domain/types";
import Avatar from "./Avatar";
import { CaseCard, ChatIntro, ChatTurn, ChatTyping } from "./Chat";
import CheckList from "./CheckList";
import LatencyWaterfall, { latestTiming } from "./LatencyWaterfall";
import { LayerStrip } from "./Layers";
import type { Phase } from "./StatusRing";
import { FindingView, findingSpans } from "./Transcript";
import { Badge, Button, CaseBadge, VerdictBadge } from "./ui";
import {
  duration,
  LAW_EFFECTIVE,
  LAW_FULL,
  LAW_SHORT,
  leakHow,
  modelName,
  notRunReason,
  PLAIN,
  POLICY_SHORT,
  POLICY_SHOW,
  plainObservation,
  VARIANT_HINT,
  VARIANT_SHOW,
  withClauseNos,
} from "./wording";

interface CaseSummary {
  id: string;
  family: Family;
  intent: CaseIntent | null;
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
  /** 测试 Agent 的已审核策略（对话里写它这一轮用的套路） */
  strategies?: { id: string; title: string; description?: string }[];
}
interface RunView {
  manifest: RunManifest;
  results: CaseResult[];
  events: RunEvent[];
  cases: { id: string }[];
}

const FINAL = new Set(["completed", "cancelled", "failed"]);
/** 只跑指定几题的运行（一键演示）：不当「上一次」，也不给「和上一次比」 */
const picked = (m: { config: { case_ids?: string[] } }) => Boolean(m.config.case_ids?.length);

/** 上一次跑完的运行编号存在浏览器里：刷新页面以后「和上一次比」的入口还在（评审 R23） */
const LAST_RUN_KEY = "fencun.lastRun";

/**
 * 一键演示（评审 R01）：「故意出错」的角色 + 运行时护栏、开语音，只跑四道最有看点的题——口令被遮住、自称真人被换句、
 * 说要走服务直接停、危机时服务层补求助信息。只是界面上的预设，评分、护栏、裁判都不变。
 */
const DEMO = {
  suite: "smoke",
  case_ids: ["SMOKE_CANARY_003", "SMOKE_IDENTITY_001", "SMOKE_EXIT_001", "SMOKE_CRISIS_002"],
  variant: "FAULT_B2" as SubjectVariant,
  policy: "S2" as ReleasePolicy,
  includeDrafts: true,
  maxTurns: 2,
  maxCases: 4,
  voice: true,
  guardDelay: 0,
};

/** 「实验设置」的默认值：收着时按钮上只写题数和改过的几项（ADR-049），拿这几个值比 */
const DEFAULTS = { suite: "smoke", policy: "S2" as ReleasePolicy, maxTurns: 3 };

/** 这套题都是草稿时的提醒：写在顶上一行右边（和「模拟数据」放在一起：都是在说这次结果算不算数） */
const DRAFT_NOTE = "这套题都是草稿（还没经过人工审核）：结果只作预览，不计入正式统计";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  // 页面开着时会话失效：跳登录页，登录后回到这里（ADR-032）
  if (toLoginIfExpired(res.status)) throw new Error(EXPIRED_MESSAGE);
  const data = await res.json().catch(() => ({ error: `请求失败（${res.status}）` }));
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data as T;
}

export default function Workbench() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [suite, setSuite] = useState(DEFAULTS.suite);
  const [variant, setVariant] = useState<SubjectVariant>("B2");
  const [policy, setPolicy] = useState<ReleasePolicy>(DEFAULTS.policy);
  const [voice, setVoice] = useState(false);
  const [guardDelay, setGuardDelay] = useState(0);
  const [judgeRag, setJudgeRag] = useState(true);
  const [includeDrafts, setIncludeDrafts] = useState(true);
  const [maxTurns, setMaxTurns] = useState(DEFAULTS.maxTurns);
  const [maxCases, setMaxCases] = useState(20);
  const [maxCalls, setMaxCalls] = useState(200);
  const [persona, setPersona] = useState<PersonaConfig>(DEFAULT_PERSONA);
  const [personaOpen, setPersonaOpen] = useState(false);
  /** 「实验设置」折叠着：配置条只留主要几项（评审 R06） */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 「怎么用」：三栏各看什么、「改了再测」四步（ADR-049：四步路标原来常驻在顶上一行） */
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButtonRef = useRef<HTMLButtonElement>(null);
  /** 收起「怎么用」：按 Esc、点「收起」时焦点回到按钮上；点别处收起时不抢焦点 */
  const closeHelp = useCallback((refocus: boolean) => {
    setHelpOpen(false);
    if (refocus) helpButtonRef.current?.focus();
  }, []);
  /** 底部题数对账里「平台拒答」是什么：点这四个字展开一行说明（手机上没有鼠标悬停） */
  const [tallyHelp, setTallyHelp] = useState(false);
  /** 上一次跑完的运行：这次跑完后可以和它做前后对比 */
  const [prevRunId, setPrevRunId] = useState<string | null>(null);

  const [manifest, setManifest] = useState<RunManifest | null>(null);
  const [results, setResults] = useState<CaseResult[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [runCases, setRunCases] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"cases" | "dialog" | "evidence">("dialog");
  /** 用户自己点过某道题，就停在那道题；否则对话跟着正在跑的题走 */
  const pinnedRef = useRef(false);

  const esRef = useRef<EventSource | null>(null);
  // 形象的表演（ADR-033）：按运行事件发提示；正在测的类别交给表演守则（比如退出类题不演不舍）
  const [family, setFamily] = useState<string | undefined>(undefined);
  const performer = usePerformer({ page: "workbench", family });

  // 形象状态环：听 / 想 / 审 / 说 / 拦。「拦」和文字运行里的「说」要停留一会儿，期间来的新状态等它结束再换
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const holdRef = useRef<{ until: number; held: Phase | null; timer?: ReturnType<typeof setTimeout> }>({ until: 0, held: null });
  const guardedRef = useRef(false);
  /** 这一轮放行过句子没有：「审」只在第一句放行之前出现（之后边说边审，环上看得到「说」） */
  const releasedRef = useRef(false);
  const setPhase = useCallback((p: Phase, holdMs = 0) => {
    const h = holdRef.current;
    const now = performance.now();
    clearTimeout(h.timer);
    const apply = () => {
      phaseRef.current = p;
      setPhaseState(p);
      h.until = holdMs ? performance.now() + holdMs : 0;
      h.held = holdMs ? p : null;
    };
    // 「拦」停留的那 1.5 秒里，后来的状态（包括带停留的「说」）一律等它结束，不然兜底句一放行就把「拦」盖掉；
    // 别的停留只挡不带停留的状态
    if (now < h.until && (h.held === "blocked" || !holdMs)) {
      h.timer = setTimeout(apply, h.until - now);
      return;
    }
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
  /** 形象每帧读一次口型：语音运行按实际渲染的响度（截断时播放器当场置 0）；文字运行没有外部口型源，按放行的文字念 */
  const mouth = useCallback(() => (voiceRunRef.current && playerRef.current ? playerRef.current.mouthOpen() : undefined), []);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PERSONA_STORAGE_KEY) ?? "null") as PersonaConfig | null;
      if (saved && typeof saved.name === "string" && typeof saved.persona === "string" && typeof saved.boundaries === "string") {
        setPersona(saved);
      }
      const last = localStorage.getItem(LAST_RUN_KEY);
      if (last && /^\d{14}-[0-9a-f]{4}$/.test(last)) setPrevRunId((p) => p ?? last);
    } catch {
      // 浏览器不让读本地存储：用默认角色，「和上一次比」只在这次页面里有
    }
    // 体检单、对比页上点「改一处再测」过来的：直接打开角色设定（评审 R22）
    if (new URLSearchParams(window.location.search).get("persona") === "open") setPersonaOpen(true);
  }, []);
  // 跑完记下这一次：下次（哪怕刷新了页面）跑完，就拿它当「上一次」。一键演示这类只跑指定几题的不记：
  // 题不一样，通过数不能直接比（运行记录页也把它们分开放）；原来先点一键演示、再点开始体检，会给出「和上一次比」（ADR-049 深度测试）
  useEffect(() => {
    if (!manifest || !FINAL.has(manifest.state) || picked(manifest)) return;
    try {
      localStorage.setItem(LAST_RUN_KEY, manifest.run_id);
    } catch {
      // 存不下就只在这次页面里有效
    }
  }, [manifest]);
  const updatePersona = (next: PersonaConfig) => {
    setPersona(next);
    try {
      if (isDefaultPersona(next)) localStorage.removeItem(PERSONA_STORAGE_KEY);
      else localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 存不下就只在这次页面里有效
    }
  };

  // 任何设置或设定改了，上一次的出错提示就不再适用（评审 R46：改好以后旧红条不消失）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖就是这些设置本身，变了就清
  useEffect(() => {
    setActionError(null);
  }, [persona, variant, policy, suite, includeDrafts, maxCases, maxTurns, maxCalls, guardDelay, voice, judgeRag]);

  const loadStatus = useCallback(() => {
    setLoadError(null);
    api<Status>("/api/status")
      .then(setStatus)
      .catch((e: Error) => setLoadError(e.message));
  }, []);
  useEffect(loadStatus, [loadStatus]);
  useEffect(() => () => esRef.current?.close(), []);

  const suiteInfo = status?.suites.find((s) => s.id === suite);
  /** 题号 → 类别（运行事件里只有题号；用 ref 给事件回调读最新的用例表） */
  const familyOf = useRef<(id?: string) => string | undefined>(() => undefined);
  familyOf.current = (id) => suiteInfo?.cases.find((c) => c.id === id)?.family;
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
      if (e.type === "case_started" && e.case_id && !pinnedRef.current) setSelected(e.case_id);
      if (e.type === "case_started") setFamily(familyOf.current(e.case_id));
      const voiced = voiceRunRef.current === e.run_id;
      if (e.type === "run_started" || e.type === "case_started") {
        setPhase("listen");
        performer.cue({ type: "listen" });
      } else if (e.type === "judging") {
        setPhase("judge");
        performer.cue({ type: "react", kind: "wait", afterSpeech: true });
      } else if (e.type === "turn_started") {
        releasedRef.current = false;
        setPhase("think");
        performer.cue({ type: "think" });
      } else if (e.type === "utterance_ready" && guardedRef.current && !releasedRef.current) setPhase("check");
      else if (e.type === "utterance_released") {
        // 状态环的「说」是流水线走到哪了：文字运行只停 0.6 秒（下一步的「审」「听」及时出来）；她的嘴按字念（事件来得快，念快一点）
        releasedRef.current = true;
        performer.cue({ type: "say", id: e.utterance_id ?? `u${e.seq}`, text: String(e.data?.text ?? ""), voiced, rate: 1.35 });
        setPhase("speak", voiced ? 0 : 600);
      } else if (e.type === "utterance_blocked" || e.type === "utterance_cut") {
        setPhase("blocked", 1500);
        if (e.type === "utterance_cut") performer.cue({ type: "cut" });
        performer.cue({ type: "react", kind: "blocked" });
      } else if (e.type === "service_exited") performer.cue({ type: "react", kind: "stopped" });
      else if (e.type === "playback_metrics" || e.type === "playback_timeout" || e.type === "turn_finished") {
        setPhase("listen");
        performer.cue({ type: "listen" });
      } else if (e.type === "run_finished" || e.type === "run_cancelling") {
        setPhase("idle");
        if (e.type === "run_cancelling") performer.cue({ type: "cut" });
        performer.cue({ type: "idle" });
      }
      if (e.type === "case_finished" || e.type === "run_finished" || e.type.startsWith("run_")) {
        void refresh(e.run_id).catch(() => {});
      }
    },
    [refresh, onVoiceEvent, setPhase, performer],
  );

  const start = async (demo = false) => {
    // 一键演示：配置条也改成演示用的值（看得见现在跑的是什么），这次请求直接用演示的值
    const cfg = demo
      ? DEMO
      : { suite, case_ids: undefined, variant, policy, includeDrafts, maxTurns, maxCases, voice, guardDelay: guardDelay };
    if (demo) {
      setSuite(DEMO.suite);
      setVariant(DEMO.variant);
      setPolicy(DEMO.policy);
      setIncludeDrafts(true);
      setMaxTurns(DEMO.maxTurns);
      setMaxCases(DEMO.maxCases);
      setVoice(true);
      setGuardDelay(0);
    }
    setActionError(null);
    voiceRunRef.current = null;
    if (cfg.voice) {
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
    if (manifest && FINAL.has(manifest.state) && !picked(manifest)) setPrevRunId(manifest.run_id);
    guardedRef.current = GUARDED_VARIANTS.includes(cfg.variant);
    setPhase("listen");
    setEvents([]);
    setResults([]);
    setRunCases(new Set());
    setSelected(null);
    pinnedRef.current = false;
    try {
      const m = await api<RunManifest>("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suite: cfg.suite,
          case_ids: cfg.case_ids,
          variant: cfg.variant,
          policy: cfg.policy,
          judge_rag: judgeRag,
          include_drafts: cfg.includeDrafts,
          max_turns: cfg.maxTurns,
          max_cases: cfg.maxCases,
          max_llm_calls: maxCalls,
          voice: cfg.voice,
          guard_delay_ms: cfg.guardDelay,
          persona: isDefaultPersona(persona) ? undefined : persona,
        }),
      });
      setManifest(m);
      if (cfg.voice) {
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
      if (e.type === "utterance_released") {
        const text = String(e.data?.text ?? "");
        t.released_output += text;
        t.utterances.push({
          utterance_id: e.utterance_id ?? "",
          text,
          released: true,
          origin: (e.data?.origin as UtteranceRecord["origin"]) ?? undefined,
        });
      }
      if (e.type === "utterance_blocked")
        t.utterances.push({ utterance_id: e.utterance_id ?? "", text: String(e.data?.text ?? ""), released: false });
      if (e.type === "service_exited") t.service.exited = true;
      if (e.type === "usage_reminder") t.service.reminder_emitted = true;
      turns.set(id, t);
    }
    return [...turns.values()];
  }, [events, selected, selectedResult]);
  // 对话底下的「……」跟着这道题的事件走（不跟着状态环）：这一轮开始了、还没放行 → 在想或护栏在审；裁判在判 → 判
  const { openTurns, dialogPhase } = useMemo(() => {
    const mine = events.filter((e) => e.case_id === selected);
    const open = new Set<string>();
    for (const e of mine) {
      if (e.type === "turn_started" && e.turn_id) open.add(e.turn_id);
      if (e.type === "turn_finished" && e.turn_id) open.delete(e.turn_id);
    }
    const last = mine.at(-1);
    let p: Phase | null = "listen";
    if (last?.type === "judging") p = "judge";
    else if (open.size) {
      const inTurn = mine.filter((e) => e.turn_id && open.has(e.turn_id));
      if (inTurn.some((e) => e.type === "utterance_released")) p = null;
      else p = guardedRef.current && inTurn.some((e) => e.type === "utterance_ready") ? "check" : "think";
    }
    return { openTurns: open, dialogPhase: p };
  }, [events, selected]);
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
  // 正在跑的那道题是哪一类（完成横幅里写「正在跑第几题 · 什么题」）
  const lastStarted = [...events].reverse().find((e) => e.type === "case_started")?.case_id;
  const lastFamily = lastStarted ? cases0(lastStarted) : undefined;
  const currentFamily = lastFamily ? FAMILY_LABEL[lastFamily as Family] : undefined;
  // 点「开始体检」后这个按钮会消失，焦点掉到页面最外层；改落到「终止」上，键盘用户能接着操作
  useEffect(() => {
    if (running && document.activeElement === document.body) document.getElementById("stop-run")?.focus();
  }, [running]);
  const cases = suiteInfo?.cases ?? [];
  /** 设定哪里不合格（和服务端同一套检查，评审 R46） */
  const personaProblem = parsePersona(persona).error;
  /** 「开始体检」点不了的原因 */
  const startBlocked = personaProblem
    ? `角色设定：${personaProblem}`
    : cases.length && Math.min(maxCases, cases.filter((c) => includeDrafts || c.approval === "approved").length) === 0
      ? "这套题都是草稿：勾上「包含草稿」才能跑"
      : null;
  /** 这套题全是草稿：「草稿」只在套件那儿说一次，不在每道题上重复（评审 R29） */
  const allDraft = cases.length > 0 && cases.every((c) => c.approval !== "approved");
  /** 按现在的设置会跑几题（草稿开关、数量上限） */
  const plannedCount = Math.min(maxCases, cases.filter((c) => includeDrafts || c.approval === "approved").length);
  /** 模拟模式下，不确定的题里有几题是模拟裁判判不了（它不做语义判断，R16） */
  const simUnsure = status?.live
    ? 0
    : results.filter(
        (r) =>
          r.status === "completed" &&
          r.verdict === "uncertain" &&
          r.findings.some((f) => f.by !== "assertion" && (f.reviewed_verdict ?? f.verdict) === "uncertain"),
      ).length;
  function cases0(id: string) {
    return suiteInfo?.cases.find((c) => c.id === id)?.family;
  }
  // 运行开始后只列本次实际计划的用例（受草稿开关和数量上限影响）
  const shownCases = manifest && runCases.size ? cases.filter((c) => runCases.has(c.id)) : cases;
  const counts = manifest?.counts;
  const selectedCase = cases.find((c) => c.id === selected);
  const strategyTitle = (id?: string) =>
    !id ? undefined : id === "CASE_INPUT" ? "题目原句" : (status?.strategies?.find((x) => x.id === id)?.title ?? id);
  const pick = (id: string) => {
    pinnedRef.current = true;
    setSelected(id);
    setTab("dialog");
  };

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
  const finished = Boolean(manifest && FINAL.has(manifest.state));
  /** 「实验设置」的全部设定：放在按钮的悬停里 */
  const settingsSummary = `${suite} ${plannedCount} 题${allDraft ? "（都是草稿，结果只作预览）" : includeDrafts ? " · 含草稿" : ""} · ${POLICY_SHORT[policy]} · ${maxTurns} 轮${guardDelay ? ` · 护栏延迟 ${guardDelay} ms` : ""}`;
  /** 收着时按钮上只写题数和改过的几项：一段长摘要在配置条里注定被截成「smoke 16 题（都是草…」（ADR-049 复查） */
  const settingsShort = [
    suite !== DEFAULTS.suite ? suite : null,
    `${plannedCount} 题`,
    includeDrafts && !allDraft ? "含草稿" : null,
    policy !== DEFAULTS.policy ? POLICY_SHORT[policy] : null,
    maxTurns !== DEFAULTS.maxTurns ? `${maxTurns} 轮` : null,
    guardDelay ? `护栏延迟 ${guardDelay} ms` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // 「和上一次比」「对比上一次」两个入口用同一条规矩：这一次是一键演示（只跑指定几题）就不给（ADR-049 深度测试）
  const compareWith = prevRunId && manifest && prevRunId !== manifest.run_id && !picked(manifest) ? prevRunId : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:gap-2.5 lg:px-3">
      {/* 顶上一行（R05；ADR-049 改短成一句）：给谁用、做什么、对照哪部法规。右边是这次的结果算不算数（草稿题、模拟数据）和「怎么用」；
          「改了再测」四步路标（R22）和三栏各看什么收在「怎么用」里。「怎么用」的卡片紧跟在按钮后面（键盘按 Tab 直接进卡片），浮在下面 */}
      <div className="relative flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1">
        <p className="min-w-0 flex-1 basis-[20rem] text-[11px] leading-relaxed text-muted sm:text-xs">
          给 AI 陪聊、AI 玩具这类会说话的角色做上线前的安全体检，对照
          <span className="text-foreground" title={LAW_EFFECTIVE}>
            {LAW_FULL}
          </span>
          出体检单。
        </p>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {allDraft && includeDrafts && (
            <Badge tone="warn" title={DRAFT_NOTE}>
              草稿题 · 只作预览
            </Badge>
          )}
          <Badge
            tone={status.live ? "ok" : "warn"}
            title={
              status.live
                ? "使用真实云端模型，会产生调用费用"
                : "没配模型密钥：现在用的是模拟器，回答按固定规则生成，只能演示流程，数字不能当实验结果"
            }
          >
            {status.live ? "真实模型" : "模拟数据（非真实模型）"}
          </Badge>
          <button
            ref={helpButtonRef}
            type="button"
            onClick={() => setHelpOpen((o) => !o)}
            aria-expanded={helpOpen}
            aria-controls="workbench-help"
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-sm border border-border bg-surface px-2 text-xs font-medium hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <HelpCircle size={14} aria-hidden />
            怎么用
          </button>
        </div>
        {helpOpen && (
          <HelpCard onClose={closeHelp}>
            <LoopSteps
              step={running ? 2 : finished ? (personaOpen ? 4 : 3) : personaOpen ? 1 : 2}
              reportHref={finished && manifest ? `/reports/${manifest.run_id}` : undefined}
              onPersona={() => {
                closeHelp(false);
                setPersonaOpen(true);
              }}
            />
          </HelpCard>
        )}
      </div>

      {/* 配置条：被测配置、被测角色、语音播放、一键演示、开始体检，其余收进「实验设置」（R06）。
          放不下就折到下一行，不会把按钮挤出屏幕（ADR-049 复查：排成一行不许折时，长角色名把「开始体检」挤出去了） */}
      <div className="space-y-1.5 rounded-sm border border-border bg-surface px-2.5 py-1.5 text-[13px]">
        <div className="flex flex-wrap items-end gap-x-2.5 gap-y-1.5 sm:items-center">
          <label className="flex min-w-0 max-w-full flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-1.5" title={VARIANT_HINT[variant]}>
            <span className="shrink-0 text-xs text-muted">被测配置</span>
            <select
              className="h-7 min-w-0 max-w-[26rem] rounded border border-border bg-surface px-1"
              value={variant}
              onChange={(e) => setVariant(e.target.value as SubjectVariant)}
              disabled={Boolean(running)}
            >
              {VARIANTS.map((v) => (
                <option key={v} value={v}>
                  {VARIANT_SHOW[v]}
                </option>
              ))}
            </select>
          </label>
          <div className="flex min-w-0 max-w-full flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-1.5">
            <span className="shrink-0 text-xs text-muted">被测角色</span>
            {/* 角色名最长 20 个字：名字那一段可以截短（鼠标停上去看全名），按钮整个也能缩，不把右边的按钮挤出去 */}
            <button
              type="button"
              onClick={() => setPersonaOpen((o) => !o)}
              aria-expanded={personaOpen}
              className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded border border-border bg-surface px-2 hover:bg-background"
              data-testid="persona-toggle"
              title={`${persona.name}${isDefaultPersona(persona) ? "（默认）" : "（你的设定）"}：粘贴你自己角色的人设和边界提示，改一处再测`}
            >
              <UserRound size={14} className="shrink-0" aria-hidden />
              <span className="min-w-0 truncate xl:max-w-[9rem]">{persona.name}</span>
              <span className="shrink-0 whitespace-nowrap text-xs text-muted">
                {isDefaultPersona(persona) ? "（默认）" : "（你的设定）"} · 改人设和边界
              </span>
              <Pencil size={12} className="shrink-0 text-muted" aria-hidden />
            </button>
          </div>
          <label
            className="flex h-7 shrink-0 items-center gap-1 whitespace-nowrap"
            title="放行的句子合成语音，在浏览器播放并计量；每轮播完才进入下一轮"
          >
            <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} disabled={Boolean(running)} />
            语音播放
          </label>
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-controls="run-settings"
            title={settingsOpen ? undefined : `实验设置：${settingsSummary}`}
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded px-1.5 text-xs text-muted hover:bg-background hover:text-foreground"
          >
            <ChevronDown size={14} className={`shrink-0 transition-transform ${settingsOpen ? "rotate-180" : ""}`} aria-hidden />
            <span className="shrink-0 whitespace-nowrap">实验设置</span>
            {!settingsOpen && <span className="truncate">· {settingsShort}</span>}
          </button>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {!running && (
              <Button
                size="sm"
                onClick={() => void start(true)}
                disabled={busy || Boolean(personaProblem)}
                title="演示用的是「故意出错」的角色：故意设成会越界（说口令、自称真人、挽留），用来看护栏怎么拦；开语音，只跑四道题，约一分钟"
              >
                <Clapperboard size={14} aria-hidden />
                一键演示（约一分钟）
              </Button>
            )}
            {!running && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void start()}
                disabled={busy || !suiteInfo || suiteInfo.errors.length > 0 || Boolean(personaProblem) || plannedCount === 0}
                title={startBlocked ?? undefined}
              >
                <Play size={14} aria-hidden />
                开始体检
              </Button>
            )}
            {manifest?.state === "running" && (
              <Button size="sm" onClick={() => act("pause")} title="当前用例跑完后暂停，不再派发新用例">
                <Pause size={14} aria-hidden />
                暂停
              </Button>
            )}
            {(manifest?.state === "paused" || manifest?.state === "pausing") && (
              <Button size="sm" onClick={() => act("resume")}>
                <Play size={14} aria-hidden />
                继续
              </Button>
            )}
            {running && (
              <Button size="sm" id="stop-run" variant="danger" onClick={() => act("cancel")} title="立即中止当前用例，不可恢复">
                <Square size={14} aria-hidden />
                终止
              </Button>
            )}
          </div>
        </div>
        {/* 「开始体检」点不了的原因：单独一行，写在按钮下面（配置条排成一行时，挤在按钮旁边放不下） */}
        {!running && startBlocked && <p className="text-right text-xs text-bad">{startBlocked}</p>}
        {settingsOpen && (
          <div id="run-settings" className="flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-xs text-muted">用例套件</span>
              <select
                className="h-8 rounded border border-border bg-surface px-1"
                value={suite}
                onChange={(e) => setSuite(e.target.value)}
                disabled={Boolean(running)}
              >
                {status.suites.map((x) => (
                  <option key={x.id} value={x.id} disabled={x.errors.length > 0}>
                    {x.id}（{x.cases.length} 例{x.errors.length ? "，校验失败" : ""}）
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
                {(Object.keys(POLICY_SHOW) as ReleasePolicy[]).map((x) => (
                  <option key={x} value={x}>
                    {POLICY_SHOW[x]}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="flex flex-col gap-0.5"
              title="实验设定（ADR-014）：给每句护栏判定加一个固定、已知的延迟，用来观察放行策略的差别；不是真实模型的延迟"
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
            <label className="flex flex-col gap-0.5" title="测试 Agent 每例最多问几轮（最多 3 轮）">
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
            <label className="flex h-8 items-center gap-1">
              <input type="checkbox" checked={judgeRag} onChange={(e) => setJudgeRag(e.target.checked)} disabled={Boolean(running)} />
              裁判先查条文
            </label>
            <label className="flex h-8 items-center gap-1" title="草稿用例未经人工审核，只能作预览，不计入正式结果">
              <input
                type="checkbox"
                checked={includeDrafts}
                onChange={(e) => setIncludeDrafts(e.target.checked)}
                disabled={Boolean(running)}
              />
              包含草稿（预览）
            </label>
          </div>
        )}
      </div>

      {!manifest && !isDefaultPersona(persona) && (
        <p className="px-1 text-xs text-muted">用自己的设定：建议先跑 B1 看角色本身，再跑 B2 看加上分寸的护栏和服务层以后。</p>
      )}

      {manifest && <RunStrip manifest={manifest} events={events} current={currentFamily} prevRunId={compareWith} simUnsure={simUnsure} />}

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
            className={`flex-1 rounded px-2 py-1 text-sm ${tab === k ? "bg-foreground text-surface" : "border border-border bg-surface"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 大屏上三栏正好占满剩下的高度，各自滚动：用例多了也不会把对话框、证据框拉成一大片空白 */}
      {/* 角色设定：大屏上盖在三栏上面（抽屉），不把三栏往下挤；手机上排在页面里（评审 R34） */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-2">
        {personaOpen && (
          <PersonaPanel
            value={persona}
            disabled={Boolean(running)}
            onChange={updatePersona}
            onClose={() => setPersonaOpen(false)}
            live={status.live}
            model={modelName(status.models.subject ?? "")}
            problem={personaProblem}
          />
        )}
        {/* 三栏（ADR-049）：中间的对话是主角，最宽；左右两栏定宽、窄一点。
            左栏不窄于 15.5rem（ADR-049 定的；那时她下面那行是「AI 角色 琪叶桃 · VRM 3D 形象 · 不是真人」，ADR-051 起只剩「AI 角色 琪叶桃」） */}
        <div className="grid min-h-0 flex-1 gap-2 lg:grid-cols-[15.5rem_minmax(0,1fr)_19.5rem] lg:grid-rows-[minmax(0,1fr)] lg:gap-2.5 xl:grid-cols-[15.5rem_minmax(0,1fr)_22rem] 2xl:grid-cols-[17rem_minmax(0,1fr)_25rem]">
          {/* 左：角色 + 用例进度（淡一点，不抢中间对话的眼） */}
          <div className={`${panelClass("cases")} min-h-0 flex-col gap-2 lg:overflow-y-auto`}>
            <div className={`${SIDE_FRAME} p-3`}>
              {/* 月洞窗在工作台里小一号（globals.css 的 .workbench-avatar） */}
              <div className="workbench-avatar">
                <Avatar performer={performer} mouth={mouth} phase={phase} silent={!voice} subjectName={persona.name} />
              </div>
              <div className="mt-2 border-t border-border pt-2">
                <LatencyWaterfall timing={timing} simulated={!status.live} />
              </div>
              {manifest?.config.voice && <AudioMeters stats={audioStats} />}
            </div>
            <SidePanel
              title={`用例进度${manifest ? `（${manifest.counts.planned} 例）` : ""}`}
              className="min-h-[12rem] flex-1 lg:shrink-0 lg:basis-[12rem]"
            >
              <ul className="space-y-1">
                {shownCases.map((c) => {
                  const s = caseState.get(c.id);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pick(c.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs ${selected === c.id ? "bg-sunken" : "hover:bg-background"}`}
                      >
                        {/* 左栏窄了（ADR-049）：第一行只写哪一样，出题意图挪到题号后面，旁边的判定章不会把名字挤掉 */}
                        <span className="min-w-0">
                          <span className="block truncate text-[13px]">{FAMILY_LABEL[c.family]}</span>
                          <span className="block truncate text-xs text-muted">
                            <span className="font-mono text-[11px]">{c.id}</span>
                            {c.intent ? ` · ${INTENT_LABEL[c.intent]}题` : ""}
                            {c.approval !== "approved" && !allDraft ? " · 草稿" : ""}
                            {c.modality === "voice" ? " · 语音 · 本版不测" : ""}
                          </span>
                        </span>
                        {manifest ? <CaseBadge status={s?.status ?? "queued"} verdict={s?.verdict} /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </SidePanel>
          </div>

          {/* 中：对话（聊天记录的样子；还没开始时是一段示例）。这一页的主角：最宽、框最重、标题最大（ADR-049） */}
          <DialogPanel
            title={
              selected ? (
                <>
                  对话 · {selectedCase ? FAMILY_LABEL[selectedCase.family] : selected}
                  <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{selected}</span>
                </>
              ) : (
                "对话"
              )
            }
            className={`${panelClass("dialog")} min-h-[16rem] lg:min-h-0`}
          >
            {!manifest && <ChatIntro name={persona.name} strategies={status.strategies} />}
            {manifest && !selected && <ChatTyping phase="listen" name={persona.name} />}
            {selected && (
              <>
                {selectedCase && (
                  <CaseCard
                    plain={
                      PLAIN[selectedCase.family](persona.name) +
                      (selectedCase.family === "PERSONA" && !isDefaultPersona(persona)
                        ? `语气按你的设定看：「${persona.persona.split(/[。\n]/)[0].slice(0, 40)}」。`
                        : "")
                    }
                    expected={selectedCase.expected}
                    tags={[
                      FAMILY_LABEL[selectedCase.family],
                      ...(selectedCase.intent ? [`${INTENT_LABEL[selectedCase.intent]}题`] : []),
                      ...(allDraft ? [] : [selectedCase.approval === "approved" ? "已审核" : "草稿"]),
                      ...(selectedCase.modality === "voice" ? ["语音题 · 本版不测"] : []),
                    ]}
                  />
                )}
                {(selectedResult?.turns ?? liveTurns).map((t) => (
                  <ChatTurn
                    key={t.turn_id}
                    turn={t}
                    evidence={selectedResult ? findingSpans(selectedResult.findings) : []}
                    name={persona.name}
                    strategy={strategyTitle(t.strategy_id)}
                    live={!selectedResult && openTurns.has(t.turn_id)}
                    simulated={!status.live}
                  />
                ))}
                {running && !selectedResult && <ChatTyping phase={dialogPhase} name={persona.name} />}
                {selectedResult?.status === "completed" && selectedResult.verdict && (
                  <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted">
                    <span aria-hidden>——</span>
                    这道题聊完了
                    <VerdictBadge verdict={selectedResult.verdict} />
                    <span aria-hidden>——</span>
                  </p>
                )}
                {selectedResult?.status === "not_run" && (
                  <p className="text-sm text-muted">没跑：{notRunReason(selectedResult.error) ?? "运行提前结束"}</p>
                )}
                {selectedResult?.error && selectedResult.status !== "not_run" && <p className="text-sm text-bad">{selectedResult.error}</p>}
              </>
            )}
          </DialogPanel>

          {/* 右：七样、结论、证据、工具调用（淡一点、窄一点） */}
          <SidePanel
            title={manifest ? "结论与证据" : "这次查七样"}
            className={`${panelClass("evidence")} min-h-[16rem] lg:min-h-0`}
            actions={
              manifest && FINAL.has(manifest.state) ? (
                <span className="flex flex-wrap gap-2">
                  <Link className="text-xs link" href={`/reports/${manifest.run_id}`}>
                    打开体检单
                  </Link>
                  {compareWith && (
                    <Link className="text-xs link" href={`/compare?a=${compareWith}&b=${manifest.run_id}`} data-testid="compare-link">
                      和上一次比
                    </Link>
                  )}
                </span>
              ) : null
            }
          >
            <CheckList
              cases={shownCases}
              state={caseState}
              name={persona.name}
              started={Boolean(manifest)}
              selected={selected}
              compact={Boolean(selectedResult)}
              onPick={pick}
            />
            {selectedResult?.status === "completed" && manifest && (
              <div className="mb-2 space-y-1 border-b border-border pb-2">
                <LayerStrip layers={caseLayers(selectedResult, GUARDED_VARIANTS.includes(manifest.config.variant))} />
                <p className="text-xs text-muted">
                  角色原话：{caseLayers(selectedResult, GUARDED_VARIANTS.includes(manifest.config.variant)).raw.note}
                </p>
              </div>
            )}
            {selectedResult?.findings.map((f) => (
              <FindingView key={f.finding_id} f={f} simulated={!status?.live} />
            ))}
            {toolSteps.length > 0 && (
              <div className="mt-2">
                <h3 className="text-xs font-semibold">测试 Agent 怎么出的招</h3>
                <p className="text-[11px] text-muted">第 1 轮是题目原句；之后每一步都是测试 Agent 调用一次工具（函数调用）。</p>
                <ol className="mt-1 space-y-1 text-xs">
                  {toolSteps.map((s, i) => (
                    <li key={s.seq} className="rounded bg-background p-1.5">
                      <ToolStep
                        turn={
                          1 +
                          toolSteps.slice(0, i + 1).filter((x) => (x.data?.args as { message?: string } | null)?.message !== undefined)
                            .length
                        }
                        step={s}
                        strategyTitle={strategyTitle}
                      />
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </SidePanel>
        </div>
      </div>
      {/* 底部计量：名字和数字排一行（ADR-049）；题数对账的式子写在数字后面，灰字，手机上也看得见；
          「平台拒答」四个字点开有一行说明（手机上没有鼠标悬停）。没开始体检时没有可看的，整条不显示 */}
      {manifest && (
        <div className={`${SIDE_FRAME} flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5`}>
          <Stat label="运行状态" value={stateLabel(manifest.state)} />
          <Stat
            label="题数对账"
            title="平台拒答：模型平台自己的内容审核挡下的，不算护栏的功劳"
            value={
              counts
                ? `${counts.planned} = ${counts.completed} + ${counts.provider_blocked} + ${counts.error} + ${counts.cancelled} + ${counts.not_run}`
                : null
            }
          >
            <span className="text-xs text-muted">
              （计划 = 做完 +{" "}
              <button
                type="button"
                onClick={() => setTallyHelp((o) => !o)}
                aria-expanded={tallyHelp}
                aria-controls="tally-help"
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                平台拒答
              </button>{" "}
              + 出错 + 终止 + {running ? "排队" : "没跑"}）
            </span>
          </Stat>
          <Stat
            label="合格 / 不合格 / 不确定 / 不适用"
            value={counts ? `${counts.pass} / ${counts.fail} / ${counts.uncertain} / ${counts.not_applicable}` : null}
          />
          <Stat label="模型调用" value={`${manifest.usage.llm_calls} / ${manifest.config.max_llm_calls}`} />
          <Stat
            label="tokens（入/出）"
            value={!status.live ? "模拟不计" : `${manifest.usage.prompt_tokens} / ${manifest.usage.completion_tokens}`}
            title={!status.live ? "模拟模式不调用模型，没有 token" : undefined}
          />
          {manifest.preview && (
            <Badge tone="warn">{allDraft ? "这套题都是草稿：结果只作预览，不计入正式统计" : "含草稿用例：预览结果，不计入正式统计"}</Badge>
          )}
          {manifest.failure_reason && <Badge tone="bad">{manifest.failure_reason}</Badge>}
          {tallyHelp && (
            <p id="tally-help" className="basis-full text-xs text-muted">
              平台拒答：模型平台自己的内容审核挡下的，不算护栏的功劳。
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 版面（ADR-049） ----------

/** 两边栏和底部计量的框：比中间的对话淡一层 */
const SIDE_FRAME = "rounded-sm border border-border/80 bg-surface/60";

/** 中间的对话：这一页的主角。框最重（深一点的边、一层浅影子），标题最大；正文限宽，宽屏上一行不会拉得太长 */
function DialogPanel({ title, className = "", children }: { title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-sm border border-foreground/25 bg-surface shadow-[0_12px_32px_-20px_rgba(0,0,0,0.45)] ${className}`}
      data-testid="dialog-panel"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-base font-semibold tracking-wide" style={{ fontFamily: "var(--font-serif)" }}>
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <div className="mx-auto w-full max-w-[46rem] 2xl:max-w-[52rem]">{children}</div>
      </div>
    </section>
  );
}

/** 两边的面板：淡底、细边、小标题，不和中间的对话抢 */
function SidePanel({
  title,
  actions,
  className = "",
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`flex min-h-0 flex-col ${SIDE_FRAME} ${className}`}>
      <header className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <h2 className="text-[13px] font-semibold tracking-wide text-foreground/80" style={{ fontFamily: "var(--font-serif)" }}>
          {title}
        </h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-3 pt-1 pb-3">{children}</div>
    </section>
  );
}

/**
 * 底部计量的一项：名字和数字排一行（字号和 ui.tsx 的 Metric 一样：名字 12px、数字 14px）。
 * 指标没有结果时写「待测」，不能默认为 0（规格 01 §2.3）。数字单独一个元素：端到端测试按整串数字找它，后面的说明（children）另放。
 */
function Stat({ label, value, title, children }: { label: string; value?: string | null; title?: string; children?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" title={title}>
      <span className="text-xs text-muted">{label}</span>
      <span className="font-mono text-sm tabular-nums">{value === undefined || value === null || value === "" ? "待测" : value}</span>
      {children}
    </div>
  );
}

// ---------- 角色设定 ----------

/** 开发者粘贴自己角色的人设和边界提示；B0 只用人设，B1、B2 再加边界提示（B2 还有分寸的护栏和服务层） */
function PersonaPanel({
  value,
  disabled,
  onChange,
  onClose,
  live,
  model,
  problem,
}: {
  value: PersonaConfig;
  disabled: boolean;
  onChange: (p: PersonaConfig) => void;
  onClose: () => void;
  /** 设定哪里不合格（和服务端同一套检查），就地写出来（评审 R46） */
  problem?: string;
  /** 接没接真实模型：模拟模式下角色不读设定，要先说清（评审 R16） */
  live: boolean;
  /** 被测角色用的模型（评审 R20：测的是「设定 × 这个模型」，不是开发者线上的服务） */
  model: string;
}) {
  const field = "w-full rounded border border-border bg-surface p-1.5 text-sm";
  // 字数不算进输入框的名称（读屏软件念「人设」就够了）
  const count = (k: keyof PersonaConfig) => (
    <span aria-hidden className={`text-xs ${value[k].length > PERSONA_LIMITS[k] ? "text-bad" : "text-muted"}`}>
      {value[k].length} / {PERSONA_LIMITS[k]}
    </span>
  );
  // 按 Esc 收起面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section
      className="space-y-2 rounded-sm border border-border bg-surface p-3 text-sm lg:absolute lg:inset-y-0 lg:left-0 lg:z-30 lg:w-[36rem] lg:max-w-full lg:overflow-y-auto lg:shadow-[0_8px_32px_rgba(0,0,0,0.18)]"
      aria-label="角色设定"
      data-testid="persona-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
          角色设定
        </h2>
        <span className="text-xs text-muted">
          粘贴你自己角色的人设和边界提示。B0 只用人设；B1 加边界提示；B2 再加分寸的护栏和服务层。改一处再测，跑完点「和上一次比」。
        </span>
      </div>
      {!live && (
        <p className="rounded-sm border border-dashed border-warn px-2 py-1 text-xs text-warn">
          模拟模式：角色用固定的句子回答，不读你的设定，改了设定结果也不会变；要看改设定的效果，需要接真实模型。
        </p>
      )}
      {problem && (
        <p role="alert" className="text-xs text-bad">
          {problem}：改好以后才能开始体检。
        </p>
      )}
      <p className="text-xs text-muted">
        被测的是：你的设定 × {model}（分寸用这个模型照你的设定扮演角色），不是你线上的服务；换了模型或提示词的拼法，结果可能不同。
      </p>
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
        <Button
          onClick={() => onChange({ ...value, boundaries: withRecommendedClauses(value.boundaries) })}
          disabled={disabled || withRecommendedClauses(value.boundaries) === value.boundaries}
          title="把身份、告别、未成年、危机、内部代号五条推荐条款里还没有的，加到边界提示末尾（评审 R21）"
        >
          插入推荐边界条款
        </Button>
        <Button onClick={onClose} title="也可以按 Esc">
          收起
        </Button>
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
        <span className="font-semibold" title="浏览器里实际放出来的声音，一个采样一个采样地数">
          声音这边
        </span>
        {stats.level && <Badge tone={stats.level === "live" ? "ok" : "warn"}>{stats.level === "live" ? "真实合成" : "模拟发声"}</Badge>}
      </div>
      {/* 左栏窄了（ADR-049）：名字和数字接着排，一项折行也只多一行，不再挤成名字一栏、数字一栏 */}
      <dl className="space-y-0.5">
        <div>
          <dt className="mr-1.5 inline text-muted">违规的声音漏出</dt>
          <dd className="inline" data-testid="leak-meter">
            {stats.cuts.length
              ? `${duration(leak)}（${stats.cuts.length} 次截断，${upper ? "有的按整句算上限" : leakHow("char", stats.level === "simulation")}）`
              : "— 还没有截断"}
          </dd>
        </div>
        <div>
          <dt className="mr-1.5 inline text-muted">开口要等</dt>
          <dd className="inline" data-testid="first-audio-meter">
            {stats.firstLast !== undefined
              ? `最近 ${duration(stats.firstLast)} · 一般 ${duration(stats.firstMedian ?? stats.firstLast)}（${stats.firstCount} 轮）`
              : "—"}
            {stats.guardLast !== undefined && <span className="text-muted"> · 其中护栏 {duration(stats.guardLast)}</span>}
          </dd>
        </div>
        <div>
          <dt className="mr-1.5 inline text-muted">叫停到没声</dt>
          <dd className="inline">
            {lastCut?.cancel_to_stop_ms != null
              ? `≤ ${duration(lastCut.cancel_to_stop_ms)} · 嘴型 ${lastCut.cancel_to_mouth_zero_ms != null ? duration(lastCut.cancel_to_mouth_zero_ms) : "—"}停下`
              : "—"}
          </dd>
        </div>
      </dl>
      {stats.timeouts > 0 && <p className="text-warn">有 {stats.timeouts} 轮没等到浏览器回报（标签页被关掉或切走了），这几轮不算。</p>}
    </div>
  );
}

/**
 * 测试 Agent 的一步：出招（对角色说一句话）、查条文、收手（评审 R25）。
 * 出招按对话里的「第几轮」编号（第 1 轮是题目原句）；工具拿回来的观察原文是给测试 Agent 看的（实验流程，不改），
 * 这里换成大白话；函数名（execute_case 这些）做成小标签：评分表里的「Function Calling」看得见，又不抢大白话的位置。
 */
function ToolStep({ turn, step, strategyTitle }: { turn: number; step: RunEvent; strategyTitle: (id?: string) => string | undefined }) {
  const args = (step.data?.args ?? {}) as { strategy_id?: string; message?: string; query?: string; reason?: string };
  const result = String(step.data?.result ?? "");
  const tool = String(step.data?.tool ?? step.type);
  let head: string;
  if (args.message !== undefined) head = `第 ${turn} 轮 · ${strategyTitle(args.strategy_id) ?? "出招"}：「${args.message}」`;
  else if (args.query !== undefined) head = `查条文：${args.query}`;
  else if (args.reason !== undefined) head = `收手：${args.reason}`;
  else head = tool;
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <span>{head}</span>
        <code className="shrink-0 rounded-sm border border-border px-1 text-[10px] text-muted">{tool}</code>
      </div>
      {result && <div className="text-muted">{args.query !== undefined ? withClauseNos(result) : plainObservation(result)}</div>}
    </>
  );
}

/**
 * 「怎么用」（ADR-049）：怎么出题、怎么拦一句话，三栏各看什么，「改了再测」四步（R22，原来常驻在顶上一行）。
 * 这一页做什么、对照哪部法规（R05）还写在顶上那一行里。卡片在 DOM 里紧跟着按钮（键盘按 Tab 直接进来），浮在按钮下面，
 * 不把三栏往下挤；按 Esc、点「收起」或点别处就收起。
 */
function HelpCard({ onClose, children }: { onClose: (refocus: boolean) => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦点在卡片里才把焦点送回「怎么用」按钮；别处按 Esc（比如正在改角色设定）只收起，不抢焦点
      if (e.key === "Escape") onClose(Boolean(ref.current?.contains(document.activeElement)));
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t)) return;
      // 点的是「怎么用」按钮本身：交给按钮自己切换（这里先收起的话，按钮又会把它打开）
      if (t instanceof Element && t.closest("[aria-controls='workbench-help']")) return;
      onClose(false);
    };
    // 键盘 Tab 出了卡片（落到被卡片盖住的按钮上，看不见焦点在哪）就收起；回到「怎么用」按钮本身不算（ADR-049 深度测试）
    const onFocus = (e: FocusEvent) => {
      const t = e.target;
      if (!(t instanceof Node) || ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[aria-controls='workbench-help']")) return;
      onClose(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocus);
    };
  }, [onClose]);
  // 大屏上是三栏，手机上是三个标签页：同一句话两种叫法
  const where = (wide: string, narrow: string) => (
    <>
      <span className="hidden lg:inline">{wide}</span>
      <span className="lg:hidden">{narrow}</span>
    </>
  );
  return (
    <section
      ref={ref}
      id="workbench-help"
      aria-label="这一页怎么用"
      className="absolute top-full right-0 z-40 mt-1.5 w-[min(32rem,calc(100vw-1rem))] space-y-2.5 rounded-sm border border-border bg-surface p-3 text-xs leading-relaxed shadow-[0_8px_32px_rgba(0,0,0,0.18)]"
    >
      <h2 className="text-sm font-semibold" style={{ fontFamily: "var(--font-serif)" }}>
        这一页怎么用
      </h2>
      <p className="text-sm">
        测试 Agent 照用例库里的题目和套路去问她；默认配置（B2、边审边合成）下，每句话护栏审过才说出口；跑完对照{LAW_SHORT}（{LAW_EFFECTIVE}
        ）出体检单。
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">{where("左边", "「用例」")}</dt>
        <dd>她这会儿在听、想、审还是说；开口要等多久；这次的题</dd>
        <dt className="text-muted">{where("中间", "「对话」")}</dt>
        <dd>测试 Agent 怎么问、她怎么答；被护栏拦下的原话划掉摆出来</dd>
        <dt className="text-muted">{where("右边", "「证据」")}</dt>
        <dd>这次查七样：一格一道题，跑完盖章；点格子看那道题的结论和证据</dd>
      </dl>
      <div className="border-t border-border pt-2">{children}</div>
      <div className="flex items-center justify-between gap-2">
        {/* 别的页面怎么用：登录后第一次看到的那一页（ADR-049，队员 B 的建议 4），顶栏「用法」也能进 */}
        <Link className="link" href="/guide">
          每一页怎么用：看「用法」 →
        </Link>
        <Button onClick={() => onClose(true)}>收起</Button>
      </div>
    </section>
  );
}

/**
 * 「改了再测」四步路标（评审 R22）：① 配角色 → ② 体检 → ③ 看体检单 → ④ 改一处再测，走到哪一步那一步写成朱红。
 * ADR-049 起收在「怎么用」里，不再常驻顶上。
 * 不写「已完成」：端到端测试按这几个字找运行状态。
 */
function LoopSteps({ step, reportHref, onPersona }: { step: 1 | 2 | 3 | 4; reportHref?: string; onPersona: () => void }) {
  const items: { n: 1 | 2 | 3 | 4; label: string; act?: () => void; href?: string }[] = [
    { n: 1, label: "配角色", act: onPersona },
    { n: 2, label: "体检" },
    { n: 3, label: "看体检单", href: reportHref },
    { n: 4, label: "改一处再测", act: reportHref ? onPersona : undefined },
  ];
  return (
    <ol className="flex shrink-0 flex-wrap items-center gap-1" aria-label="改了再测的四步">
      {items.map((it, i) => {
        const now = it.n === step;
        const cls = `rounded-sm px-1 ${now ? "font-semibold text-primary" : "text-muted"}`;
        const text = `${"①②③④"[it.n - 1]} ${it.label}`;
        return (
          <li key={it.n} className="flex items-center gap-1" aria-current={now ? "step" : undefined}>
            {i > 0 && (
              <span className="text-muted" aria-hidden>
                →
              </span>
            )}
            {it.href ? (
              <Link href={it.href} className={`${cls} underline decoration-dotted underline-offset-2 hover:text-primary`}>
                {text}
              </Link>
            ) : it.act ? (
              <button type="button" onClick={it.act} className={`${cls} underline decoration-dotted underline-offset-2 hover:text-primary`}>
                {text}
              </button>
            ) : (
              <span className={cls}>{text}</span>
            )}
          </li>
        );
      })}
    </ol>
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

/**
 * 完成横幅（评审 R04）：配置条下面一条，三个标签页都看得到。跑的时候写第几题，跑完写结果和「看体检单」。
 * 不要写「已完成」「已终止」这几个字：端到端测试和巡检脚本按这几个字找运行状态，出现两处就会认错。
 */
function RunStrip({
  manifest,
  events,
  current,
  prevRunId,
  simUnsure = 0,
}: {
  manifest: RunManifest;
  events: RunEvent[];
  current?: string;
  prevRunId: string | null;
  /** 模拟模式下，不确定的题里有几题是模拟裁判判不了（R16） */
  simUnsure?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const c = manifest.counts;
  // 跑过的题（做完、平台拒答、出错、终止的都算）：底部对账里「做完」只数做完的，所以这里叫「跑过」，同一屏不出两个「做完」（ADR-049 深度测试）
  const done = c.completed + c.provider_blocked + c.error + c.cancelled;
  const mine = events.filter((e) => e.run_id === manifest.run_id);
  const blocked = mine.filter((e) => e.type === "utterance_blocked" || e.type === "utterance_cut").length;
  const service = mine.filter(
    (e) => e.type === "service_exited" || e.type === "usage_reminder" || e.type === "crisis_help_appended",
  ).length;
  const final = FINAL.has(manifest.state);
  // 手机上跑完，滚到这一条（不然第一屏和没跑之前一模一样）
  useEffect(() => {
    if (final && window.matchMedia("(max-width: 1023px)").matches) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [final]);
  let text: string;
  if (manifest.state === "completed")
    text = `体检完成 · 本次通过 ${c.pass}/${c.planned} 项 · 拦下 ${blocked} 句 · 服务层出手 ${service} 次${simUnsure ? ` · ${simUnsure} 题模拟裁判判不了（接上真实模型由裁判模型判）` : ""}`;
  else if (manifest.state === "cancelled") text = `体检停下了 · 跑过 ${done}/${c.planned} 题`;
  else if (manifest.state === "failed") text = `体检出错停下了 · 跑过 ${done}/${c.planned} 题`;
  else if (manifest.state === "paused" || manifest.state === "pausing") text = `暂停中 · 跑过 ${done}/${c.planned} 题`;
  else text = `正在跑第 ${Math.min(done + 1, c.planned)}/${c.planned} 题${current ? ` · ${current}` : ""} · 拦下 ${blocked} 句`;
  return (
    <div
      ref={ref}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-sm border px-3 py-1.5 text-sm ${final ? "border-foreground/30 bg-surface" : "border-border bg-background"}`}
      data-testid="run-strip"
    >
      <p aria-live="polite" className="min-w-0">
        {text}
      </p>
      {final && (
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <Link
            href={`/reports/${manifest.run_id}`}
            className="inline-flex h-8 items-center rounded-sm bg-primary px-3 text-sm font-medium text-surface hover:opacity-90"
          >
            看体检单
          </Link>
          {prevRunId && (
            <Link href={`/compare?a=${prevRunId}&b=${manifest.run_id}`} className="text-xs link">
              对比上一次
            </Link>
          )}
        </span>
      )}
    </div>
  );
}
