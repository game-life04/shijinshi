"use client";

// 体检工作台（首屏）：上方配置，左侧角色，中间用例进度与对话，右侧证据与 Agent 工具调用，底部计量。
// 运行过程通过事件流实时更新；每完成一例就取一次最新结果（含结论与证据）。

import { Pause, Play, RotateCcw, Square, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CaseResult,
  FAMILY_LABEL,
  type Family,
  type RunEvent,
  type RunManifest,
  type SubjectVariant,
  type TurnRecord,
  VARIANT_LABEL,
} from "@/lib/domain/types";
import FaceAvatar, { type Expression } from "./FaceAvatar";
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
  const [policy, setPolicy] = useState<"S1" | "S3">("S1");
  const [judgeRag, setJudgeRag] = useState(true);
  const [includeDrafts, setIncludeDrafts] = useState(true);
  const [maxTurns, setMaxTurns] = useState(3);
  const [maxCases, setMaxCases] = useState(20);
  const [maxCalls, setMaxCalls] = useState(200);

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

  const onEvent = useCallback(
    (e: RunEvent) => {
      setEvents((prev) => (prev.some((x) => x.seq === e.seq) ? prev : [...prev, e]));
      if (e.type === "case_started" && e.case_id) setSelected((s) => s ?? e.case_id ?? null);
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
      if (e.type === "utterance_blocked") {
        speakingRef.current = false;
        setExpression("confused");
      }
      if (e.type === "case_finished" || e.type === "run_finished" || e.type.startsWith("run_")) {
        void refresh(e.run_id).catch(() => {});
      }
    },
    [refresh],
  );

  const start = async () => {
    setActionError(null);
    setBusy(true);
    esRef.current?.close();
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
        }),
      });
      setManifest(m);
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

  const running = manifest && !FINAL.has(manifest.state);
  const cases = suiteInfo?.cases ?? [];
  // 运行开始后只列本次实际计划的用例（受草稿开关和数量上限影响）
  const shownCases = manifest && runCases.size ? cases.filter((c) => runCases.has(c.id)) : cases;
  const counts = manifest?.counts;

  if (loadError) {
    return (
      <div className="m-4 rounded-md border border-bad/40 bg-bad-soft p-4 text-sm">
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
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border bg-surface p-2 text-sm">
        <label className="flex flex-col gap-0.5">
          <span className="text-xs text-muted">被测配置</span>
          <select
            className="h-8 rounded border border-border bg-surface px-1"
            value={variant}
            onChange={(e) => setVariant(e.target.value as SubjectVariant)}
            disabled={Boolean(running)}
          >
            {(Object.keys(VARIANT_LABEL) as SubjectVariant[]).map((v) => (
              <option key={v} value={v}>
                {VARIANT_LABEL[v]}
              </option>
            ))}
          </select>
        </label>
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
            onChange={(e) => setPolicy(e.target.value as "S1" | "S3")}
            disabled={Boolean(running)}
          >
            <option value="S1">S1 先审后播（默认）</option>
            <option value="S3">S3 先播后截（仅无害口令对照）</option>
          </select>
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
          <div className="rounded-md border border-border bg-surface p-2">
            <div className="mx-auto aspect-square max-h-44">
              <FaceAvatar speakingRef={speakingRef} expression={expression} />
            </div>
            <p className="mt-1 text-center text-xs text-muted">琪叶桃 · 示意形象（VRM 在 M2 接入）· AI 角色，非真人</p>
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
              <Link className="text-xs text-primary underline" href={`/reports/${manifest.run_id}`}>
                打开完整报告
              </Link>
            ) : null
          }
        >
          {!selectedResult && <p className="text-sm text-muted">用例跑完后，这里显示每条检查的结论、原文证据和依据条文。</p>}
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border border-border bg-surface px-3 py-2">
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
