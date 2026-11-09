// 同一批对话，用现在的裁判说明再判一遍（ADR-042）：改了检查项的说明以后，只换裁判、不重新生成对话，
// 看哪些结论变了。两种用法（真实模型要花钱，不加 --yes 只打印计划）：
//   npx tsx --env-file=.env.local scripts/rejudge.ts --runs <run_id,run_id> --rules identity.no_human_claim [--yes]
//     体检运行：只重判用到这几个检查项的题（这些题交给裁判的说明变了；别的题说明没变，不重判）
//   npx tsx --env-file=.env.local scripts/rejudge.ts --probe <layer-probe 结果.json> --level identity [--yes]
//     闯关分层探针：用闯关同一套说法（play.ts 的 playCase）重判那一关每一句她说出口的话
// 结果存到 eval/out/rejudge-<时间>.json（不进仓库）；不改原来的运行记录。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getSuite } from "../lib/domain/cases";
import type { LevelId } from "../lib/domain/levels";
import type { CaseV1, Finding, RunManifest, TurnRecord, Verdict } from "../lib/domain/types";
import { judgeCase } from "../lib/server/judge";
import { isLive, UsageMeter } from "../lib/server/llm";
import { playCase } from "../lib/server/play";

const arg = (name: string) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined);

interface Change {
  where: string;
  rule_id: string;
  before: Verdict | string;
  after: Verdict;
  said: string;
  reason_before?: string;
  reason_after: string;
}

const meter = new UsageMeter(2000);
const changes: Change[] = [];
/** 每一条重判（不只变了的），方便核对裁判的理由 */
const all: Change[] = [];
let judged = 0;
let same = 0;

async function rejudgeRuns(runIds: string[], rules: string[]) {
  for (const runId of runIds) {
    const dir = path.join("data", "runs", runId);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as RunManifest;
    const suite = getSuite(manifest.config.suite);
    if (!suite) throw new Error(`找不到套件 ${manifest.config.suite}`);
    const canary = JSON.parse(readFileSync(path.join(dir, "secret.json"), "utf8")).canary as string;
    const results = readFileSync(path.join(dir, "results.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { case_id: string; status: string; turns: TurnRecord[]; findings: Finding[] });
    for (const r of results) {
      const c = suite.cases.find((x) => x.id === r.case_id);
      if (r.status !== "completed" || !c || !c.expected.assertion_ids.some((id) => rules.includes(id))) continue;
      const again = await judgeCase({
        c,
        turns: r.turns,
        canary,
        useRag: manifest.config.judge_rag,
        meter,
        runId: `${runId}-rejudge`,
        persona: manifest.config.persona,
      });
      for (const f of r.findings.filter((x) => x.by === "judge")) {
        const g = again.find((x) => x.rule_id === f.rule_id);
        if (!g) continue;
        judged++;
        // 原来的结论按复核后的为准
        const before = f.reviewed_verdict ?? f.verdict;
        const row: Change = {
          where: `${runId}（${manifest.config.variant}）${r.case_id}`,
          rule_id: f.rule_id,
          before,
          after: g.verdict,
          said: r.turns.map((t) => t.released_output).join(" / "),
          reason_before: f.reason_summary,
          reason_after: g.reason_summary,
        };
        all.push(row);
        if (before === g.verdict) same++;
        else changes.push(row);
      }
    }
    console.log(`${runId}：重判完成`);
  }
}

interface ProbeRow {
  level: LevelId;
  tier: number;
  fault: boolean;
  text: string;
  outcome: string;
  released: string;
  message: string;
}

async function rejudgeProbe(file: string, level: Exclude<LevelId, "canary">) {
  const rows = (JSON.parse(readFileSync(file, "utf8")) as { rows: ProbeRow[] }).rows.filter((r) => r.level === level && r.released.trim());
  for (const [i, r] of rows.entries()) {
    const c: CaseV1 = playCase(level, r.text);
    const t: TurnRecord = {
      turn_id: `PROBE#${i + 1}`,
      index: 1,
      user_text: r.text,
      raw_output: r.released,
      released_output: r.released,
      utterances: [],
      service: { exited: false, reminder_emitted: false, reminder_simulated: false },
      provider_blocked: false,
      timing_ms: { total: 0 },
    };
    const [g] = await judgeCase({ c, turns: [t], canary: "", useRag: false, meter, runId: `probe-rejudge-${i}` });
    // 闯关里「攻破」= 裁判判不合格且摘得出原话（play.ts 的 judgeHeard）
    const brokeBefore = r.outcome === "broken";
    const brokeAfter = Boolean(g && g.verdict === "fail" && g.evidence.length);
    judged++;
    const row: Change = {
      where: `探针 ${level} 第 ${r.tier} 层${r.fault ? "（故意出错的角色）" : "（正常角色）"}「${r.text}」`,
      rule_id: c.expected.assertion_ids[0],
      before: brokeBefore ? "fail" : "pass",
      after: brokeAfter ? "fail" : (g?.verdict ?? "uncertain"),
      said: r.released,
      reason_before: brokeBefore ? r.message : undefined,
      reason_after: g?.reason_summary ?? "",
    };
    all.push(row);
    if (brokeBefore === brokeAfter) same++;
    else changes.push(row);
  }
}

async function main() {
  const runs = arg("runs");
  const probe = arg("probe");
  if (!runs && !probe) throw new Error("用 --runs <run_id,...> --rules <检查项,...> 或 --probe <文件> --level <关>");
  console.log(`数据等级：${isLive() ? "真实模型" : "模拟数据（模拟裁判不看说明，重判没有意义）"}`);
  if (!isLive() || !process.argv.includes("--yes")) {
    console.log("真实模型要花钱：确认后加 --yes 再跑。");
    return;
  }
  if (runs) await rejudgeRuns(runs.split(","), (arg("rules") ?? "").split(",").filter(Boolean));
  if (probe) await rejudgeProbe(probe, (arg("level") ?? "identity") as Exclude<LevelId, "canary">);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const out = path.join("eval", "out", `rejudge-${stamp}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ judged, same, changes, all, usage: meter.usage }, null, 2), "utf8");
  console.log(`重判 ${judged} 条，结论不变 ${same} 条，变了 ${changes.length} 条：`);
  for (const x of changes) console.log(`- ${x.where} ${x.rule_id}：${x.before} → ${x.after}｜${x.said}`);
  console.log(`结果：${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
