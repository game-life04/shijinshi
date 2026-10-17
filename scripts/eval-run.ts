// 按配置跑一次体检并导出原始数据：npm run eval:run -- --config eval/configs/smoke-b2.json --output eval/out/smoke-b2
// 导出 manifest.json、results.jsonl、events.jsonl（与工作台用的是同一套服务）。
// 没有 LLM_API_KEY 时是模拟数据（data_level=simulation），不能当实验结果写进文档。

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { RunConfig } from "../lib/domain/types";
import { createRun, getRun, startRun } from "../lib/server/runs";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

const configFile = arg("config");
if (!configFile) {
  console.error("需要 --config <配置文件>");
  process.exit(2);
}
const output = arg("output", `eval/out/${path.basename(configFile, ".json")}`) as string;
const config = JSON.parse(readFileSync(configFile, "utf8")) as RunConfig;

const m = createRun(config);
startRun(m.run_id);
console.log(`运行 ${m.run_id}：${m.counts.planned} 例，数据等级 ${m.data_level}${m.preview ? "（含草稿，预览）" : ""}`);

const done = new Set(["completed", "cancelled", "failed"]);
const timer = setInterval(() => {
  const v = getRun(m.run_id);
  if (!v || !done.has(v.manifest.state)) return;
  clearInterval(timer);
  const src = path.join("data", "runs", m.run_id);
  mkdirSync(output, { recursive: true });
  for (const f of ["manifest.json", "results.jsonl", "events.jsonl"]) copyFileSync(path.join(src, f), path.join(output, f));
  const c = v.manifest.counts;
  console.log(`状态 ${v.manifest.state}${v.manifest.failure_reason ? `（${v.manifest.failure_reason}）` : ""}`);
  console.log(
    `计划 ${c.planned} = 完成 ${c.completed} + 平台拦截 ${c.provider_blocked} + 出错 ${c.error} + 取消 ${c.cancelled} + 未执行 ${c.not_run}`,
  );
  console.log(`完成里：合格 ${c.pass}，不合格 ${c.fail}，不确定 ${c.uncertain}，不适用 ${c.not_applicable}`);
  console.log(`模型调用 ${v.manifest.usage.llm_calls} 次；结果已导出到 ${output}`);
  for (const r of v.results) {
    console.log(`  ${r.case_id.padEnd(20)} ${r.status.padEnd(10)} ${r.verdict ?? "-"}${r.error ? `  ${r.error}` : ""}`);
  }
}, 200);
