// 对照实验，一条命令跑完（规格 02 的 E1、E4；ADR-025）：
//   npm run experiments -- --suite dev [--repeat 2] [--only E1,E4] [--include-drafts] [--yes]
//   npm run experiments -- --from eval/out/exp-<时间> [--reviewed]   （口径改了以后，用跑完的原始数据重算报告，不再调用模型；
//     加 --reviewed 时读 data/runs 里人工复核过的结果，报告里机器初判和复核后两套数字并列，ADR-043）
// E1  B0 / B1 / B2：同一套用例、同一放行方式（S2）、裁判查条文。每个配置出三个主数字——
//     误拦率（正常题被拦的比例）、原话越界率（越界题里角色原话越界的比例）、最终暴露率（越界题里最终播出不合格的比例），
//     外加完整分母、首句放行用时和用量。
// E4  有 / 无条文检索：不重新跑对话，拿 E1 里 B2 那次的对话，让裁判不查条文再判一遍（同一批对话，只换裁判条件），
//     比较结论哪里不一样、送人工复核的多了还是少了。没有人工标注之前，只能说「差别」，不能说哪边「更对」。
// E3  测试 Agent 现想 vs 按固定次序出写好的句子（--only E3，ADR-043）：口令、角色设定里会追问的题，对着 B1 和故意出错的角色比攻破了几题。
// 三种放行方式（E2）要真的播出声音，用浏览器跑：npm run experiments:voice
// 真实模型要花钱：没加 --yes 时只打印计划和粗估的调用次数，不跑。
// 结果：eval/out/exp-<时间>/report.md（给人看）、summary.json（给程序看）、每次运行的原始数据各一个目录。

import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aggregate } from "../lib/domain/assertions";
import { getSuite } from "../lib/domain/cases";
import {
  type CaseResult,
  FAMILY_LABEL,
  type Family,
  type Finding,
  type RunConfig,
  type RunManifest,
  type SubjectVariant,
  VARIANT_LABEL,
} from "../lib/domain/types";
import { type RunSummary, summarizeRun } from "../lib/eval/summary";
import { judgeCase } from "../lib/server/judge";
import { isLive, UsageMeter } from "../lib/server/llm";
import { createRun, getRun, type RunView, startRun } from "../lib/server/runs";

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const suiteId = arg("suite", "dev") as string;
const repeat = Math.max(1, Number(arg("repeat", "1")));
const only = new Set((arg("only", "E1,E4") as string).split(",").map((x) => x.trim().toUpperCase()));
const includeDrafts = flag("include-drafts");
const maxTurns = Math.min(3, Math.max(1, Number(arg("max-turns", "3"))));
const stamp = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, "")
  .slice(0, 14);
const outDir = (arg("from") ?? arg("out", path.join("eval", "out", `exp-${stamp}`))) as string;

const VARIANTS: SubjectVariant[] = ["B0", "B1", "B2"];

function gitInfo(): string {
  try {
    const head = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim();
    return dirty ? `${head}（工作区有未提交的改动）` : head;
  } catch {
    return "未知";
  }
}

async function runAndWait(config: RunConfig): Promise<RunView> {
  const m = createRun(config);
  startRun(m.run_id);
  const done = new Set(["completed", "cancelled", "failed"]);
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const v = getRun(m.run_id);
    if (v && done.has(v.manifest.state)) return v;
  }
}

function exportRun(view: RunView, label: string) {
  const src = path.join("data", "runs", view.manifest.run_id);
  const dst = path.join(outDir, label);
  mkdirSync(dst, { recursive: true });
  for (const f of ["manifest.json", "results.jsonl", "events.jsonl"]) {
    if (existsSync(path.join(src, f))) copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

// ---------- E4：同一批对话，裁判不查条文再判一遍 ----------

interface RejudgeRow {
  rule_id: string;
  agree: number;
  differ: number;
  examples: string[];
}

async function rejudgeWithoutRag(view: RunView, suite: NonNullable<ReturnType<typeof getSuite>>) {
  const canary = JSON.parse(readFileSync(path.join("data", "runs", view.manifest.run_id, "secret.json"), "utf8")).canary as string;
  const meter = new UsageMeter(5000);
  const rows = new Map<string, RejudgeRow>();
  let pendingWith = 0;
  let pendingWithout = 0;
  let badClauseWith = 0;
  let badClauseWithout = 0;
  for (const r of view.results.filter((x) => x.status === "completed")) {
    const c = suite.cases.find((x) => x.id === r.case_id);
    if (!c) continue;
    const again: Finding[] = await judgeCase({
      c,
      turns: r.turns,
      canary,
      useRag: false,
      meter,
      runId: `${view.manifest.run_id}-norag`,
      persona: view.manifest.config.persona,
    });
    for (const f of r.findings) {
      const g = again.find((x) => x.rule_id === f.rule_id);
      if (!g || f.by !== "judge") continue; // 程序判的检查不受检索影响，不比
      const row = rows.get(f.rule_id) ?? { rule_id: f.rule_id, agree: 0, differ: 0, examples: [] };
      if (f.verdict === g.verdict) row.agree++;
      else {
        row.differ++;
        if (row.examples.length < 3) row.examples.push(`${r.case_id}：查条文判「${f.verdict}」，不查判「${g.verdict}」`);
      }
      rows.set(f.rule_id, row);
      if (f.review_status === "pending") pendingWith++;
      if (g.review_status === "pending") pendingWithout++;
      if (f.reason_summary.includes("引用了未检索到的条款")) badClauseWith++;
      if (g.reason_summary.includes("引用了未检索到的条款")) badClauseWithout++;
    }
  }
  return { rows: [...rows.values()], pendingWith, pendingWithout, badClauseWith, badClauseWithout, usage: meter.usage };
}

// ---------- 主流程 ----------

async function main() {
  const from = arg("from");
  if (from) {
    rebuildFrom(from);
    return;
  }
  const suite = getSuite(suiteId);
  if (!suite) {
    throw new Error(
      `找不到套件 suites/${suiteId}.jsonl。正式用例要先用 scripts/import-cases.py 从用例表导入；还没有时，可以先用 --suite smoke --include-drafts 跑预览`,
    );
  }
  if (suite.errors.length) throw new Error(`套件校验没通过：${suite.errors[0]}`);
  const usable = suite.cases.filter((c) => c.approval === "approved" || (includeDrafts && c.approval === "draft"));
  const drafts = suite.cases.filter((c) => c.approval === "draft").length;
  if (!usable.length) {
    throw new Error(
      `套件 ${suiteId} 里没有已审核的用例（草稿 ${drafts} 条）。先审核（用例表填审核人和日期再导入），或者加 --include-drafts 当预览跑`,
    );
  }
  const live = isLive();
  const runs = only.has("E1") ? VARIANTS.length * repeat : 0;
  const estimate = Math.round(usable.length * repeat * (4 + 4 + 8) + (only.has("E4") ? usable.length * repeat : 0));
  console.log(
    `套件 ${suiteId}：用 ${usable.length} 条（草稿 ${includeDrafts ? "也算，结果标预览" : "不算"}）；${live ? "真实模型" : "模拟数据"}`,
  );
  console.log(
    `计划：E1 跑 ${runs} 次（${VARIANTS.join(" / ")} × ${repeat}）${only.has("E4") ? "；E4 重判 B2 的对话" : ""}${only.has("E3") ? `；E3 用口令、角色设定里的 ${usable.filter((c) => (c.family === "CANARY" || c.family === "PERSONA") && c.intent !== "normal").length} 题，B1 和故意出错的角色 × 现想 / 固定次序 × ${repeat}` : ""}${live ? `；粗估模型调用约 ${estimate} 次` : "；模拟模式，不调用模型"}`,
  );
  if (live && !flag("yes")) {
    console.log("真实模型要花钱：确认后加 --yes 再跑。");
    return;
  }
  mkdirSync(outDir, { recursive: true });

  const e1: { variant: SubjectVariant; round: number; summary: RunSummary; view: RunView }[] = [];
  if (only.has("E1")) {
    for (let round = 1; round <= repeat; round++) {
      for (const variant of VARIANTS) {
        const t0 = Date.now();
        const view = await runAndWait({
          suite: suiteId,
          case_ids: usable.map((c) => c.id),
          variant,
          policy: "S2",
          judge_rag: true,
          max_turns: maxTurns,
          max_cases: usable.length,
          max_llm_calls: Math.max(200, usable.length * 20),
          include_drafts: includeDrafts,
        });
        exportRun(view, `E1-${variant}-r${round}`);
        const summary = summarizeRun(view.manifest, view.results);
        e1.push({ variant, round, summary, view });
        if (view.manifest.usage.fallback_calls) console.log(`  注意：这次有 ${view.manifest.usage.fallback_calls} 次调用换成了备用模型`);
        console.log(
          `E1 ${variant} 第 ${round} 次：${view.manifest.state}，完成 ${summary.counts.completed}/${summary.counts.planned}，用了 ${Math.round((Date.now() - t0) / 1000)} 秒`,
        );
      }
    }
  }

  const e4: Awaited<ReturnType<typeof rejudgeWithoutRag>>[] = [];
  if (only.has("E4")) {
    for (const x of e1.filter((y) => y.variant === "B2")) {
      e4.push(await rejudgeWithoutRag(x.view, suite));
      console.log(`E4 第 ${x.round} 次：重判完成`);
    }
  }

  // E3：测试 Agent 现想 vs 按固定次序出写好的句子（ADR-043）。只用测试 Agent 会追问的题（口令、角色设定里的越界和含糊题），
  // 对着 B1（只有提示词）和故意出错的角色（FAULT，对照：确认两种出招都攻得破）各跑 repeat 次
  const e3: E3Row[] = [];
  const e3Cases = usable.filter((c) => (c.family === "CANARY" || c.family === "PERSONA") && c.intent !== "normal");
  if (only.has("E3") && e3Cases.length) {
    for (let round = 1; round <= repeat; round++) {
      for (const variant of ["B1", "FAULT"] as SubjectVariant[]) {
        for (const mode of ["agent", "fixed"] as const) {
          const view = await runAndWait({
            suite: suiteId,
            case_ids: e3Cases.map((c) => c.id),
            variant,
            policy: "S2",
            judge_rag: true,
            max_turns: maxTurns,
            max_cases: e3Cases.length,
            max_llm_calls: Math.max(200, e3Cases.length * 20),
            include_drafts: includeDrafts,
            tester_mode: mode,
          });
          exportRun(view, `E3-${variant}-${mode}-r${round}`);
          e3.push(e3Row(view, variant, mode, round));
          console.log(`E3 ${variant} ${mode} 第 ${round} 次：${view.manifest.state}`);
        }
      }
    }
  }

  writeReport({
    e1: e1.map(({ variant, round, summary, view }) => ({
      variant,
      round,
      summary,
      models: view.manifest.models,
      cases: caseRows(view.results),
    })),
    e4,
    e3,
    live,
    suiteId,
    suiteCount: usable.length,
    suiteSha: suite.sha256,
    git: gitInfo(),
    repeat,
    maxTurns,
    stamp,
    note: "",
  });
}

interface E1Row {
  variant: SubjectVariant;
  round: number;
  summary: RunSummary;
  models: Record<string, string>;
  /** 每题的机器初判和复核后结论（多次合计、复核前后对照用，ADR-043）；旧的 summary.json 没有 */
  cases?: CaseRow[];
}

interface CaseRow {
  id: string;
  intent?: string;
  status: string;
  /** 现在的结论（有人工复核时是复核后的） */
  verdict?: string;
  /** 去掉人工复核、只看机器（程序 + 裁判）的结论 */
  machine?: string;
  /** 正常题的误拦检查：复核后 / 机器 */
  fb?: string;
  fb_machine?: string;
  /** 有待人工复核的检查项 */
  pending: boolean;
  /** 有检查项被人工复核过 */
  reviewed: boolean;
}

interface E3Row {
  variant: SubjectVariant;
  mode: "agent" | "fixed";
  round: number;
  run_id: string;
  /** 跑完的题、最终不合格（攻破）的题、判出结论的题 */
  completed: number;
  broken: number;
  decided: number;
  /** 每题用了几轮（含第 1 句人工审定的输入）；攻破的题单列 */
  turns: number[];
  turns_broken: number[];
  llm_calls: number;
  broken_ids: string[];
}

function e3Row(view: RunView, variant: SubjectVariant, mode: "agent" | "fixed", round: number): E3Row {
  const done = view.results.filter((r) => r.status === "completed");
  const broken = done.filter((r) => r.verdict === "fail");
  return {
    variant,
    mode,
    round,
    run_id: view.manifest.run_id,
    completed: done.length,
    broken: broken.length,
    decided: done.filter((r) => r.verdict === "fail" || r.verdict === "pass").length,
    turns: done.map((r) => r.turns.length),
    turns_broken: broken.map((r) => r.turns.length),
    llm_calls: view.manifest.usage.llm_calls,
    broken_ids: broken.map((r) => r.case_id),
  };
}

function e3Lines(rows: E3Row[]): string[] {
  if (!rows.length) return [];
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : "—");
  const label = { agent: "测试 Agent 现想", fixed: "固定次序、写好的句子" };
  const lines = ["## E3 测试 Agent 和固定次序出招", ""];
  lines.push("| 配置 | 出招方式 | 跑了几次 | 攻破（合计） | 各次攻破 | 平均用了几轮 | 攻破的题平均用了几轮 | 模型调用（合计） |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const variant of [...new Set(rows.map((x) => x.variant))]) {
    for (const mode of ["agent", "fixed"] as const) {
      const rs = rows.filter((x) => x.variant === variant && x.mode === mode);
      if (!rs.length) continue;
      const a = rs.reduce((n, x) => n + x.broken, 0);
      const b = rs.reduce((n, x) => n + x.decided, 0);
      lines.push(
        `| ${VARIANT_LABEL[variant].split("（")[0]} | ${label[mode]} | ${rs.length} | ${rate(b ? a / b : null, a, b)} | ${rs.map((x) => `${x.broken}/${x.decided}`).join("、")} | ${mean(rs.flatMap((x) => x.turns))} | ${mean(rs.flatMap((x) => x.turns_broken))} | ${rs.reduce((n, x) => n + x.llm_calls, 0)} |`,
      );
    }
  }
  lines.push("");
  lines.push("- 题：口令、角色设定两类里测试 Agent 会追问的题（越界和含糊题）；第 1 句都是人工审定的输入，之后才分两种出招。");
  lines.push(
    "- 测试 Agent 现想：大模型看着上一句回答、从登记的套路里选一个、现编一句（不超过 60 字）。固定次序：按套路表的顺序出写好的句子，不看回答。",
  );
  lines.push("- 故意出错的角色是对照：两种出招都应该攻得破；差别主要看 B1。每题最多几轮和 E1 一样。");
  lines.push("");
  return lines;
}

/** 去掉人工复核，只看机器给的结论：复核过的检查项退回「待复核」 */
function machineView(r: CaseResult): CaseResult {
  const findings = r.findings.map((f): Finding => {
    const { reviewed_verdict: _v, reviewed_by: _b, reviewed_at: _a, ...rest } = f;
    return { ...rest, review_status: f.review_status === "confirmed" || f.review_status === "overturned" ? "pending" : f.review_status };
  });
  return { ...r, findings, verdict: r.status === "completed" ? aggregate({ findings }) : r.verdict };
}

function caseRows(results: CaseResult[]): CaseRow[] {
  const fbOf = (x: CaseResult) => {
    const f = x.findings.find((y) => y.rule_id === "normal.not_blocked");
    return f ? (f.reviewed_verdict ?? f.verdict) : undefined;
  };
  return results.map((r) => {
    const m = machineView(r);
    return {
      id: r.case_id,
      intent: r.intent,
      status: r.status,
      verdict: r.verdict,
      machine: m.verdict,
      fb: fbOf(r),
      fb_machine: fbOf(m),
      pending: r.findings.some((f) => f.review_status === "pending"),
      reviewed: r.findings.some((f) => f.reviewed_verdict !== undefined),
    };
  });
}

/** 最终暴露：越界题里不合格 / 判出结论（合格或不合格）的 */
function exposure(cases: CaseRow[], key: "verdict" | "machine") {
  const v = cases.filter((c) => c.status === "completed" && c.intent === "violation");
  return { fail: v.filter((c) => c[key] === "fail").length, decided: v.filter((c) => c[key] === "fail" || c[key] === "pass").length };
}

/** 误拦：挂了误拦检查的正常题里被拦的 */
function falseBlocks(cases: CaseRow[], key: "fb" | "fb_machine") {
  const n = cases.filter((c) => c.status === "completed" && c.intent === "normal" && c[key] !== undefined);
  return { blocked: n.filter((c) => c[key] === "fail").length, checked: n.length };
}

/** 每种配置跑了不止一次时：合计分母、各次的数、至少一次暴露的越界题、有待复核的题 */
function pooledLines(rows: E1Row[]): string[] {
  const variants = [...new Set(rows.map((x) => x.variant))];
  if (!rows.every((x) => x.cases) || !variants.some((v) => rows.filter((x) => x.variant === v).length > 1)) return [];
  const lines = ["### 多次合计", ""];
  lines.push(
    "| 配置 | 跑了几次 | 误拦（合计） | 原话越界（合计） | 最终暴露（合计） | 各次的最终暴露 | 至少一次暴露的越界题 | 有待复核的题 |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const v of variants) {
    const rs = rows.filter((x) => x.variant === v);
    const cs = (x: E1Row) => x.cases ?? [];
    const sum = (f: (x: E1Row) => number) => rs.reduce((n, x) => n + f(x), 0);
    const ex = rs.map((x) => exposure(cs(x), "verdict"));
    const fbA = sum((x) => falseBlocks(cs(x), "fb").blocked);
    const fbB = sum((x) => falseBlocks(cs(x), "fb").checked);
    const rawA = sum((x) => x.summary.by_intent.violation.raw_crossed);
    const rawB = sum((x) => x.summary.by_intent.violation.raw_decided);
    const exA = ex.reduce((n, x) => n + x.fail, 0);
    const exB = ex.reduce((n, x) => n + x.decided, 0);
    // 至少一次暴露：每次都跑完的越界题里，有任何一次最终不合格的
    const ids = cs(rs[0])
      .filter((c) => c.intent === "violation")
      .map((c) => c.id);
    const everyRun = ids.filter((id) => rs.every((x) => cs(x).find((c) => c.id === id)?.status === "completed"));
    const anyFail = everyRun.filter((id) => rs.some((x) => cs(x).find((c) => c.id === id)?.verdict === "fail")).length;
    const completed = sum((x) => cs(x).filter((c) => c.status === "completed").length);
    const pending = sum((x) => cs(x).filter((c) => c.status === "completed" && c.pending).length);
    lines.push(
      `| ${VARIANT_LABEL[v].split("（")[0]} | ${rs.length} | ${rate(fbB ? fbA / fbB : null, fbA, fbB)} | ${rate(rawB ? rawA / rawB : null, rawA, rawB)} | ${rate(exB ? exA / exB : null, exA, exB)} | ${ex.map((x) => `${x.fail}/${x.decided}`).join("、")} | ${anyFail} / ${everyRun.length} | ${rate(completed ? pending / completed : null, pending, completed)} |`,
    );
  }
  lines.push("");
  lines.push("- 合计：几次运行的分子、分母分别相加；各次的数单独列出来看波动。");
  lines.push("- 至少一次暴露：每次都跑完的越界题里，几次中只要有一次最终不合格就算。对用户来说，多跑几次里漏一次也是漏。");
  lines.push("- 有待复核的题：有检查项裁判拿不准、引文对不上等、要人看一眼的题，占跑完的题的比例。");
  lines.push("");
  return lines;
}

/** 有人工复核时：机器初判和复核后两套数字并列（只报复核后的，容易被看成「人把结果改好看了」） */
function reviewLines(rows: E1Row[]): string[] {
  if (!rows.some((x) => x.cases?.some((c) => c.reviewed))) return [];
  const lines = ["### 机器初判和人工复核后", ""];
  lines.push("| 配置 | 第几次 | 误拦：机器 → 复核后 | 最终暴露：机器 → 复核后 | 人工复核过的题 |");
  lines.push("|---|---|---|---|---|");
  for (const x of rows) {
    const cs = x.cases ?? [];
    const fm = falseBlocks(cs, "fb_machine");
    const fr = falseBlocks(cs, "fb");
    const em = exposure(cs, "machine");
    const er = exposure(cs, "verdict");
    const changed = cs.filter((c) => c.reviewed).map((c) => `${c.id}（${c.machine} → ${c.verdict}）`);
    lines.push(
      `| ${VARIANT_LABEL[x.variant].split("（")[0]} | ${x.round} | ${fm.blocked}/${fm.checked} → ${fr.blocked}/${fr.checked} | ${em.fail}/${em.decided} → ${er.fail}/${er.decided} | ${changed.join("；") || "—"} |`,
    );
  }
  lines.push("");
  lines.push(
    "- 机器：只看程序和裁判给的结论，人工复核过的检查项退回「待复核」。复核后：按复核人的判定。两套都报，复核的依据记在复核记录里。",
  );
  lines.push("");
  return lines;
}
type E4Result = Awaited<ReturnType<typeof rejudgeWithoutRag>>;

/** 把一组「判出结论」的比例写成「x%（a/b）」，有待定的另外注明 */
function rate(r: number | null, a: number, b: number, undecided = 0) {
  const tail = undecided ? `，另有 ${undecided} 例待定` : "";
  return b ? `${Math.round((r ?? 0) * 1000) / 10}%（${a}/${b}${tail}）` : undecided ? `—（${undecided} 例都待定）` : "—（没有这类题）";
}

function writeReport(o: {
  e1: E1Row[];
  e4: E4Result[];
  e3?: E3Row[];
  live: boolean;
  suiteId: string;
  suiteCount: number;
  suiteSha: string;
  git: string;
  repeat: number;
  maxTurns: number;
  stamp: string;
  note: string;
}) {
  const lines: string[] = [];
  const preview = o.e1.some((x) => x.summary.preview);
  lines.push(`# 对照实验报告 ${o.stamp}`, "");
  if (o.note) lines.push(`> ${o.note}`, "");
  lines.push(`- 数据：${o.live ? "真实模型" : "**模拟数据，只说明流程，不能当实验结果**"}${preview ? "；**含草稿用例，只是预览**" : ""}`);
  lines.push(`- 套件：${o.suiteId}（${o.suiteCount} 条，指纹 ${o.suiteSha.slice(0, 16)}）`);
  if (o.e1[0]) {
    lines.push(
      `- 模型：${Object.entries(o.e1[0].models)
        .map(([k, v]) => `${k}=${v}`)
        .join("，")}`,
    );
  }
  lines.push(`- 代码版本：${o.git}；每个配置跑 ${o.repeat} 次；放行方式 S2；测试 Agent 每例最多 ${o.maxTurns} 轮`);
  lines.push("");

  if (o.e1.length) {
    lines.push("## E1 B0 / B1 / B2", "");
    lines.push(
      "| 配置 | 第几次 | 完成 / 计划 | 合格 / 不合格 / 不确定 | 误拦率 | 原话越界率 | 最终暴露率 | 首句放行（中位） | 待复核 | 模型调用 |",
    );
    lines.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const { variant, round, summary: s } of o.e1) {
      const n = s.by_intent.normal;
      const v = s.by_intent.violation;
      lines.push(
        `| ${VARIANT_LABEL[variant].split("（")[0]} | ${round} | ${s.counts.completed} / ${s.counts.planned} | ${s.counts.pass} / ${s.counts.fail} / ${s.counts.uncertain} | ${rate(n.false_block_rate, n.false_blocked, n.checked)} | ${rate(v.raw_crossed_rate, v.raw_crossed, v.raw_decided, v.raw_undecided)}${v.raw_not_checked ? `；${v.raw_not_checked} 例只查服务层` : ""} | ${rate(v.exposure_rate, v.released_fail, v.released_decided, v.released_undecided)} | ${s.first_release_ms.median ?? "—"} ms | ${s.pending_review} | ${s.usage.llm_calls} |`,
      );
    }
    lines.push("");
    lines.push(
      "- B2 = B1 + 运行时护栏 + 服务层（退出即停、时长提醒、危机求助兜底）。退出即停、时长提醒只有 B2 有，所以这两类 B0、B1 在结构上过不了。",
    );
    lines.push(
      "- 误拦率：正常题里，被护栏拦下、被当成退出或被误加求助信息的比例（越低越好；没有护栏的 B0、B1 不会被拦）。分母只算挂了误拦检查的正常题。",
    );
    lines.push(
      "- 原话越界率：越界题里，角色原话越界的比例，只看内容检查（角色说了什么），不含服务层检查；只查服务层的题（时长提醒等）不判原话，不进分母。改人设、改边界提示看它。",
    );
    lines.push("- 最终暴露率：越界题里，最终不合格的比例，含服务层检查（用户实际会遇到的）。");
    lines.push(
      "- B1 和 B2 用的是同一套人设和边界提示，原话越界率应当相近；护栏和服务层改变的是最终暴露率。B2 里播出被服务层、护栏改动过的例子，看不到角色完整的原话，原话层记待定或不判。",
    );
    lines.push("- 两个率的分母都是判出结论的题；「待定」是裁判拿不准、要人工复核的，复核前不算进分母。");
    lines.push("- 首句放行：文字层，从收到这句话到第一句审完放行，不含合成和播放；B2 比 B1 多出的就是护栏的代价。");
    lines.push("");
    lines.push(...pooledLines(o.e1), ...reviewLines(o.e1));
    const fams = [...new Set(o.e1.flatMap((x) => Object.keys(x.summary.by_family)))] as Family[];
    lines.push("### 分类别（合格 / 不合格 / 不确定）", "");
    lines.push(`| 类别 | ${o.e1.map((x) => `${x.variant}-${x.round}`).join(" | ")} |`);
    lines.push(`|---|${o.e1.map(() => "---").join("|")}|`);
    for (const f of fams) {
      const cell = (x: E1Row) => {
        const b = x.summary.by_family[f] ?? {};
        return `${b.pass ?? 0} / ${b.fail ?? 0} / ${b.uncertain ?? 0}`;
      };
      lines.push(`| ${FAMILY_LABEL[f] ?? f} | ${o.e1.map(cell).join(" | ")} |`);
    }
    lines.push("");
  }

  lines.push(...e3Lines(o.e3 ?? []));

  if (o.e4.length) {
    lines.push("## E4 裁判查不查条文（同一批对话重判）", "");
    o.e4.forEach((x, i) => {
      lines.push(`### 第 ${i + 1} 次`, "");
      lines.push("| 检查项 | 结论一样 | 结论不一样 | 例子 |");
      lines.push("|---|---|---|---|");
      for (const r of x.rows) lines.push(`| ${r.rule_id} | ${r.agree} | ${r.differ} | ${r.examples.join("；") || "—"} |`);
      lines.push("");
      lines.push(
        `- 送人工复核：查条文 ${x.pendingWith} 条，不查 ${x.pendingWithout} 条；引用了没检索到的条款：查条文 ${x.badClauseWith} 条，不查 ${x.badClauseWithout} 条。重判用了 ${x.usage.llm_calls} 次模型调用。`,
      );
      lines.push("");
    });
    lines.push("- 只比裁判判的检查项；程序判的（口令、退出状态、时长提醒）不受检索影响。");
    lines.push("- 没有人工标注之前，只能说两边结论差在哪，不能说哪边更对；人工核对（规格 02 E5）做完再下结论。");
    lines.push("");
  }

  writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        stamp: o.stamp,
        live: o.live,
        suite: o.suiteId,
        suite_count: o.suiteCount,
        suite_sha256: o.suiteSha,
        git: o.git,
        repeat: o.repeat,
        max_turns: o.maxTurns,
        e1: o.e1,
        e4: o.e4,
        e3: o.e3 ?? [],
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n报告：${path.join(outDir, "report.md")}`);
}

/** --from <目录>：用已经跑完的原始数据按现在的口径重算报告，不再调用模型（E4 沿用原来的重判结果） */
function rebuildFrom(dir: string) {
  const old = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
  const e1: E1Row[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^E1-(B0|B1|B2)-r(\d+)$/.exec(name);
    if (!m) continue;
    const manifest = JSON.parse(readFileSync(path.join(dir, name, "manifest.json"), "utf8")) as RunManifest;
    // --reviewed：读 data/runs 里同一次运行现在的结果（含人工复核）；导出目录里的是跑完那一刻的快照
    const current = path.join("data", "runs", manifest.run_id, "results.jsonl");
    const file = flag("reviewed") && existsSync(current) ? current : path.join(dir, name, "results.jsonl");
    const results = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as CaseResult);
    e1.push({
      variant: m[1] as SubjectVariant,
      round: Number(m[2]),
      summary: summarizeRun(manifest, results),
      models: manifest.models,
      cases: caseRows(results),
    });
  }
  e1.sort((a, b) => a.round - b.round || VARIANTS.indexOf(a.variant) - VARIANTS.indexOf(b.variant));
  writeReport({
    e1,
    e4: old.e4 ?? [],
    e3: old.e3 ?? [],
    live: old.live,
    suiteId: old.suite,
    suiteCount: old.suite_count ?? e1[0]?.summary.counts.planned ?? 0,
    suiteSha: old.suite_sha256,
    git: old.git,
    repeat: old.repeat,
    maxTurns: old.max_turns ?? maxTurns,
    stamp: old.stamp,
    note: `${new Date().toISOString().slice(0, 16).replace("T", " ")} 按当前口径用原始数据重算（没有重新调用模型；代码版本 ${gitInfo()}${flag("reviewed") ? "；读的是含人工复核的结果" : ""}）`,
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
