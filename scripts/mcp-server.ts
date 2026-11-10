// 分寸的 MCP 服务（ADR-043）：让 Claude Code、Claude Desktop、Cursor 这类支持 MCP 的工具直接调用体检。
// 开发者在编辑器里写好角色设定，就能让 AI 助手跑一次体检、查法规条文，不用切到网页。
//
// 用法（stdio，一行一条 JSON-RPC 消息）：
//   npx tsx --env-file=.env.local scripts/mcp-server.ts
// 在 Claude Code 里登记（在仓库根目录执行一次）：
//   claude mcp add fencun -- npx tsx --env-file=.env.local scripts/mcp-server.ts
// 没有 .env.local 或没填 LLM_API_KEY 时用模拟数据（结果标「模拟」，不能当实验数据）。
//
// 三个工具：
//   search_regulation  在《人工智能拟人化互动服务管理暂行办法》32 条原文里检索（和裁判用的是同一个 BM25）
//   run_checkup        用开发集（或 smoke 草稿）给一个角色设定跑一次体检，等跑完返回结论；体检单可以在网页里打开
//   get_report         按运行编号取一次体检的结论
// 和网页、命令行用的是同一套运行服务（lib/server/runs.ts），结果写进同一个 data/runs，网页的运行记录里也能看到。
// 不用 SDK，按 MCP 规范手写（和模型接入层 ADR-002 一个思路）：initialize、tools/list、tools/call、ping。

import path from "node:path";
import { createInterface } from "node:readline";

// stdout 只能写协议消息：别的模块打的日志一律改到 stderr
console.log = (...a: unknown[]) => console.error(...a);
console.info = console.log;
// 运行记录、条文库、用例都按仓库根目录（process.cwd()）找：不管客户端从哪个目录启动，先切到仓库根目录，再加载这些模块
process.chdir(path.resolve(__dirname, ".."));

/* eslint-disable @typescript-eslint/no-require-imports */
const { createRun, getRun, startRun } = require("../lib/server/runs") as typeof import("../lib/server/runs");
const { retrieve } = require("../lib/server/rag") as typeof import("../lib/server/rag");
const { getSuite } = require("../lib/domain/cases") as typeof import("../lib/domain/cases");
const { isLive } = require("../lib/server/llm") as typeof import("../lib/server/llm");
const { FAMILIES, FAMILY_LABEL } = require("../lib/domain/types") as typeof import("../lib/domain/types");
type RunView = NonNullable<ReturnType<typeof getRun>>;

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SUITES = ["dev", "smoke"];
const VARIANTS = ["B0", "B1", "B2"];
const DONE = new Set(["completed", "cancelled", "failed"]);
const WAIT_MS = Number(process.env.MCP_RUN_TIMEOUT_MS || 15 * 60_000);

const TOOLS = [
  {
    name: "search_regulation",
    title: "检索法规条文",
    description:
      "在《人工智能拟人化互动服务管理暂行办法》（2026-07-15 起施行）32 条原文里按关键词检索，返回条号和原文。和体检裁判用的是同一个检索（BM25）。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查的内容，例如「用户要求退出」「未成年人」「显著提示是 AI」" },
        k: { type: "integer", minimum: 1, maximum: 5, description: "返回几条，默认 3" },
      },
      required: ["query"],
    },
  },
  {
    name: "run_checkup",
    title: "给角色跑一次安全体检",
    description:
      "用审核过的题（开发集 21 题，七类检查：口令、角色设定、身份、时长提醒、退出、危机、未成年）测一个 AI 角色设定，等跑完返回每道题的结论和不合格的原话。只测本人原创或已获授权的角色。真实模型下会调用大模型（每次体检有调用上限），一次约一两分钟到几分钟。结论是自查辅助，不是合规认证。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "角色名，默认「琪叶桃」" },
        persona: { type: "string", description: "人设（不填用默认角色琪叶桃）" },
        boundaries: { type: "string", description: "边界提示（B1、B2 才用）" },
        variant: { type: "string", enum: VARIANTS, description: "B0 只有人设；B1 加边界提示；B2 再加运行时护栏和服务层（默认）" },
        families: {
          type: "array",
          items: { type: "string", enum: [...FAMILIES] },
          description: "只测这几类（不填就七类都测）",
        },
        max_cases: { type: "integer", minimum: 1, maximum: 21, description: "最多跑几题，默认 21" },
        suite: { type: "string", enum: SUITES, description: "dev（审核过的开发集，默认）或 smoke（草稿，只用来试）" },
      },
    },
  },
  {
    name: "get_report",
    title: "取一次体检的结论",
    description: "按运行编号取一次体检的结论（run_checkup 返回的编号，或网页运行记录里的编号）。",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
  },
];

class ToolError extends Error {}

function str(v: unknown, max = 4000): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;
}

function searchRegulation(args: Record<string, unknown>) {
  const query = str(args.query, 200);
  if (!query) throw new ToolError("query 不能为空");
  const k = Math.min(5, Math.max(1, Number(args.k) || 3));
  const hits = retrieve(query, k).map((r) => ({ id: r.clause.id, article: r.clause.article, text: r.clause.text }));
  const text = hits.length ? hits.map((h) => `第${h.article}条（${h.id}）：${h.text}`).join("\n\n") : "没有检索到相关条文";
  return { text, structured: { query, clauses: hits } };
}

/** 一次体检的结论：总数、每题判定、不合格的原话（和体检单同一套数据） */
function summarize(v: RunView) {
  const m = v.manifest;
  const verdictOf = (f: { verdict: string; reviewed_verdict?: string }) => f.reviewed_verdict ?? f.verdict;
  const cases = v.results.map((r) => ({
    case_id: r.case_id,
    check: FAMILY_LABEL[r.family],
    status: r.status,
    verdict: r.verdict ?? null,
    problems: r.findings
      .filter((f) => verdictOf(f) === "fail")
      .map((f) => ({ rule: f.rule_id, reason: f.reason_summary, quotes: f.evidence.map((e) => e.quote).slice(0, 3) })),
    needs_review: r.findings.some((f) => f.review_status === "pending"),
  }));
  const c = m.counts;
  const lines = [
    `体检 ${m.run_id}：${m.state}；数据：${m.data_level === "live" ? "真实模型" : "模拟（不能当实验数据）"}${m.preview ? "，含草稿题（预览）" : ""}`,
    `配置 ${m.config.variant}；${c.planned} 题：合格 ${c.pass}、不合格 ${c.fail}、不确定 ${c.uncertain}、不适用 ${c.not_applicable}；平台拦截 ${c.provider_blocked}、出错 ${c.error}、未执行 ${c.not_run}`,
    `模型调用 ${m.usage.llm_calls} 次（输入 ${m.usage.prompt_tokens} / 输出 ${m.usage.completion_tokens} token）`,
    ...cases
      .filter((x) => x.verdict === "fail" || x.status !== "completed")
      .map(
        (x) =>
          `- ${x.case_id}（${x.check}）${x.status === "completed" ? "不合格" : x.status}：${x.problems.map((p) => `${p.reason}${p.quotes.length ? `｜原话：「${p.quotes.join("」「")}」` : ""}`).join("；")}`,
      ),
    `完整体检单（三层结果、条文原文、人工复核）：在网页打开 /reports/${m.run_id}。结论是自查辅助，不是合规认证。`,
  ];
  return {
    text: lines.join("\n"),
    structured: { run_id: m.run_id, state: m.state, data_level: m.data_level, counts: c, usage: m.usage, cases },
  };
}

async function runCheckup(args: Record<string, unknown>) {
  const suiteId = SUITES.includes(String(args.suite)) ? String(args.suite) : "dev";
  const suite = getSuite(suiteId);
  if (!suite) throw new ToolError(`没有找到题库 ${suiteId}（开发集要先用 scripts/import-cases.py 导入）`);
  const variant = VARIANTS.includes(String(args.variant)) ? (String(args.variant) as "B0" | "B1" | "B2") : "B2";
  const families = Array.isArray(args.families) ? args.families.map(String).filter((f) => (FAMILIES as readonly string[]).includes(f)) : [];
  const persona = str(args.persona);
  const caseIds = families.length ? suite.cases.filter((c) => families.includes(c.family)).map((c) => c.id) : undefined;
  if (caseIds && !caseIds.length) throw new ToolError("所选题库里没有这几类的题");
  const m = createRun({
    suite: suiteId,
    case_ids: caseIds,
    variant,
    policy: "S2",
    judge_rag: true,
    max_turns: 3,
    max_cases: Math.min(21, Math.max(1, Number(args.max_cases) || 21)),
    max_llm_calls: 200,
    include_drafts: suiteId === "smoke",
    persona: persona ? { name: str(args.name, 40) ?? "被测角色", persona, boundaries: str(args.boundaries) ?? "" } : undefined,
  });
  startRun(m.run_id);
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const v = getRun(m.run_id);
    if (v && DONE.has(v.manifest.state)) return summarize(v);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new ToolError(`体检 ${m.run_id} 还没跑完（超过 ${Math.round(WAIT_MS / 60000)} 分钟），稍后用 get_report 查`);
}

function getReport(args: Record<string, unknown>) {
  const id = str(args.run_id, 80);
  if (!id || !/^[\w-]+$/.test(id)) throw new ToolError("run_id 不对");
  const v = getRun(id);
  if (!v) throw new ToolError(`没有找到体检 ${id}`);
  return summarize(v);
}

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id: unknown, result: Json) => send({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg: Json) {
  const { id, method } = msg;
  const params = (msg.params ?? {}) as Json;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return reply(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "fencun", title: "分寸：AI 语音角色安全体检台", version: "0.1.0" },
        instructions: `给 AI 角色做上线前的安全自查：run_checkup 跑体检，search_regulation 查条文。当前${isLive() ? "接了真实模型" : "没有模型密钥，结果是模拟数据"}。`,
      });
    }
    case "ping":
      return isRequest ? reply(id, {}) : undefined;
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Json;
      const run = { search_regulation: searchRegulation, run_checkup: runCheckup, get_report: getReport }[name];
      if (!run) return fail(id, -32602, `没有这个工具：${name}`);
      try {
        const r = await run(args);
        return reply(id, { content: [{ type: "text", text: r.text }], structuredContent: r.structured, isError: false });
      } catch (e) {
        // 工具自己的错误按 MCP 规范放在结果里（isError），让调用方的模型看得到原因
        return reply(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      // 通知（没有 id）不回；不认识的请求回「没有这个方法」
      if (isRequest) fail(id, -32601, `不支持的方法：${String(method)}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "不是合法的 JSON");
  }
  void handle(msg).catch((e) => fail(msg.id ?? null, -32603, e instanceof Error ? e.message : String(e)));
});
rl.on("close", () => process.exit(0));
