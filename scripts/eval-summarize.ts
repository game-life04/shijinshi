// 从导出的原始数据重算汇总：npm run eval:summarize -- --input eval/out/smoke-b2 --output eval/out/smoke-b2/summary.json
// 汇总只来自 manifest.json 与 results.jsonl，不手填任何数字；同时核对分母是否对得上。口径见 lib/eval/summary.ts。

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CaseResult, RunManifest } from "../lib/domain/types";
import { summarizeRun } from "../lib/eval/summary";

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

const summary = summarizeRun(manifest, results);
writeFileSync(output, JSON.stringify(summary, null, 2), "utf8");
console.log(`已写入 ${output}；分母${summary.reconciled ? "对账通过" : "对不上，请检查"}`);
if (!summary.reconciled) process.exit(1);
