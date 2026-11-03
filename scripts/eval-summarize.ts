// 从导出的原始数据重算汇总：npm run eval:summarize -- --input eval/out/smoke-b2 --output eval/out/smoke-b2/summary.json
// 汇总只来自 manifest.json 与 results.jsonl，不手填任何数字；同时核对分母是否对得上。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { caseLayers } from "../lib/domain/layers";
import { type CaseResult, GUARDED_VARIANTS, type RunManifest } from "../lib/domain/types";
import { recount } from "../lib/server/runs";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const input = arg("input");
if (!input) {
  console.error("需要 --input <导出目录>");
  process.exit(2);
}
const output = arg("output") ?? path.join(input, "summary.json");
const manifest = JSON.parse(readFileSync(path.join(input, "manifest.json"), "utf8")) as RunManifest;
const results = readFileSync(path.join(input, "results.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CaseResult);

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
const layers = results.filter((r) => r.status === "completed").map((r) => caseLayers(r, guarded));
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

const summary = {
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
  pending_review: results.flatMap((r) => r.findings).filter((f) => f.review_status === "pending").length,
  usage: manifest.usage,
  note: manifest.data_level === "live" ? "真实模型数据" : "模拟数据：只用于验证流程，不能作为实验结果",
};
writeFileSync(output, JSON.stringify(summary, null, 2), "utf8");
console.log(`已写入 ${output}；分母${reconciled ? "对账通过" : "对不上，请检查"}`);
if (!reconciled) process.exit(1);
