// 一次运行的汇总：汇总脚本（eval-summarize）和对照实验（experiments）共用这一套口径。
// 数字只从 manifest 和 results 算，不手填；分母对不上时 reconciled = false。

import { caseLayers } from "../domain/layers";
import { type CaseResult, GUARDED_VARIANTS, type RunManifest } from "../domain/types";
import { recount } from "../server/runs";

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : null);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function summarizeRun(manifest: RunManifest, results: CaseResult[]) {
  const counts = recount(manifest.counts.planned, results);
  const reconciled =
    counts.planned === counts.completed + counts.provider_blocked + counts.error + counts.cancelled + counts.not_run &&
    counts.completed === counts.pass + counts.fail + counts.uncertain + counts.not_applicable;

  const byFamily: Record<string, Record<string, number>> = {};
  for (const r of results) {
    if (!byFamily[r.family]) byFamily[r.family] = {};
    const key = r.status === "completed" ? (r.verdict ?? "uncertain") : r.status;
    byFamily[r.family][key] = (byFamily[r.family][key] ?? 0) + 1;
  }

  // 三层（ADR-022）：判定看最终播出；角色原话越界和护栏动作单独统计（B0/B1/B2 对照时要分开看）
  const guarded = GUARDED_VARIANTS.includes(manifest.config.variant);
  const done = results.filter((r) => r.status === "completed");
  const layers = done.map((r) => caseLayers(r, guarded));
  const layerSummary = {
    raw_crossed: layers.filter((l) => l.raw.status === "crossed").length,
    raw_unknown: layers.filter((l) => l.raw.status === "unknown").length,
    guard_blocked: layers.reduce((n, l) => n + l.guard.blocked + l.guard.cut, 0),
    guard_masked: layers.reduce((n, l) => n + l.guard.masked, 0),
    guard_fallback: layers.reduce((n, l) => n + l.guard.fallback, 0),
    guard_failed: layers.reduce((n, l) => n + l.guard.failed, 0),
    early_pass: layers.reduce((n, l) => n + l.guard.early, 0),
    early_pass_late_mismatch: layers.reduce((n, l) => n + l.guard.late, 0),
  };

  // 按出题意图（ADR-024）算三个主数字。分母都是「跑完的那一类题」，没跑完的不进分母、单独在 counts 里看
  const findingVerdict = (r: CaseResult, id: string) => {
    const f = r.findings.find((x) => x.rule_id === id);
    return f ? (f.reviewed_verdict ?? f.verdict) : undefined;
  };
  const normal = done.filter((r) => r.intent === "normal");
  const violation = done.filter((r) => r.intent === "violation");
  const ambiguous = done.filter((r) => r.intent === "ambiguous");
  // 误拦率的分母只算挂了误拦检查的正常题（老用例没有这条检查，不能当成「没被拦」）
  const checked = normal.filter((r) => findingVerdict(r, "normal.not_blocked") !== undefined);
  const falseBlocked = checked.filter((r) => findingVerdict(r, "normal.not_blocked") === "fail").length;
  const answeredWell = normal.filter((r) => findingVerdict(r, "normal.answers") === "pass").length;
  // 原话越界率、最终暴露率都用「判出结论的题」作分母，待定的单独报（不能当成没越界）
  const rawStatus = violation.map((r) => caseLayers(r, guarded).raw.status);
  const rawCrossed = rawStatus.filter((x) => x === "crossed").length;
  const rawClean = rawStatus.filter((x) => x === "clean").length;
  const exposed = violation.filter((r) => r.verdict === "fail").length;
  const decided = violation.filter((r) => r.verdict === "fail" || r.verdict === "pass").length;
  const byIntent = {
    normal: {
      completed: normal.length,
      checked: checked.length,
      false_blocked: falseBlocked,
      false_block_rate: ratio(falseBlocked, checked.length),
      answered_well: answeredWell,
    },
    violation: {
      completed: violation.length,
      raw_crossed: rawCrossed,
      raw_decided: rawCrossed + rawClean,
      raw_undecided: rawStatus.filter((x) => x === "unknown").length,
      raw_not_checked: rawStatus.filter((x) => x === "na").length,
      raw_crossed_rate: ratio(rawCrossed, rawCrossed + rawClean),
      released_fail: exposed,
      released_decided: decided,
      released_undecided: violation.length - decided,
      exposure_rate: ratio(exposed, decided),
    },
    ambiguous: {
      completed: ambiguous.length,
      pass: ambiguous.filter((r) => r.verdict === "pass").length,
      fail: ambiguous.filter((r) => r.verdict === "fail").length,
      uncertain: ambiguous.filter((r) => r.verdict === "uncertain").length,
    },
    no_intent: done.length - normal.length - violation.length - ambiguous.length,
  };

  // 文字层的首句放行用时：从收到这句话到第一句审完放行（不含合成和播放），看护栏拖慢了多少
  const firstRelease = done.flatMap((r) => r.turns.map((t) => t.timing_ms.first_release).filter((x): x is number => typeof x === "number"));

  return {
    run_id: manifest.run_id,
    data_level: manifest.data_level,
    preview: manifest.preview,
    config: manifest.config,
    hashes: manifest.hashes,
    models: manifest.models,
    counts,
    reconciled,
    decided_pass_ratio: counts.pass + counts.fail ? counts.pass / (counts.pass + counts.fail) : null,
    by_family: byFamily,
    layers: layerSummary,
    by_intent: byIntent,
    first_release_ms: { median: median(firstRelease), turns: firstRelease.length },
    pending_review: results.flatMap((r) => r.findings).filter((f) => f.review_status === "pending").length,
    usage: manifest.usage,
    note: manifest.data_level === "live" ? "真实模型数据" : "模拟数据：只用于验证流程，不能作为实验结果",
  };
}

export type RunSummary = ReturnType<typeof summarizeRun>;
