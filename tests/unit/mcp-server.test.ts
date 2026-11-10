// MCP 服务（ADR-043）：按协议起一个真的子进程，一行一条 JSON-RPC 消息，走一遍握手、列工具、查条文、跑体检（模拟数据）。

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SUBDIR = "runs-mcp-unit";
let child: ChildProcessWithoutNullStreams;
const pending = new Map<number, (m: Record<string, unknown>) => void>();
let next = 0;

function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = ++next;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

beforeAll(() => {
  const env: NodeJS.ProcessEnv = { ...process.env, SHIJINSHI_RUNS_SUBDIR: SUBDIR };
  delete env.LLM_API_KEY; // 模拟数据，不调用真实模型
  child = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), "scripts/mcp-server.ts"], { env });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  });
});

afterAll(() => {
  child.kill();
  rmSync(path.join("data", SUBDIR), { recursive: true, force: true });
});

describe("MCP 服务", () => {
  it("握手、列工具；stdout 上只有协议消息", { timeout: 30_000 }, async () => {
    const init = (await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } }))
      .result as Record<string, unknown>;
    expect(init.protocolVersion).toBe("2025-06-18");
    expect((init.serverInfo as { name: string }).name).toBe("fencun");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const list = (await call("tools/list")).result as { tools: { name: string; inputSchema: object }[] };
    expect(list.tools.map((t) => t.name)).toEqual(["search_regulation", "run_checkup", "get_report"]);
    expect((await call("ping")).result).toEqual({});
  });

  it("查条文：和裁判同一个检索，返回条号和原文", { timeout: 30_000 }, async () => {
    const r = (await call("tools/call", { name: "search_regulation", arguments: { query: "用户要求退出", k: 2 } })).result as {
      structuredContent: { clauses: { article: number }[] };
      isError: boolean;
    };
    expect(r.isError).toBe(false);
    expect(r.structuredContent.clauses.map((c) => c.article)).toContain(19);
  });

  it("跑体检：等跑完返回结论和体检单地址；错误参数作为工具错误返回", { timeout: 60_000 }, async () => {
    const r = (await call("tools/call", { name: "run_checkup", arguments: { variant: "B2", families: ["EXIT"], max_cases: 1 } }))
      .result as { content: { text: string }[]; structuredContent: { run_id: string; state: string; data_level: string } };
    expect(r.structuredContent.state).toBe("completed");
    expect(r.structuredContent.data_level).toBe("simulation");
    expect(r.content[0].text).toContain(`/reports/${r.structuredContent.run_id}`);
    const again = (await call("tools/call", { name: "get_report", arguments: { run_id: r.structuredContent.run_id } })).result as {
      structuredContent: { run_id: string };
    };
    expect(again.structuredContent.run_id).toBe(r.structuredContent.run_id);
    const bad = (await call("tools/call", { name: "get_report", arguments: { run_id: "../etc" } })).result as { isError: boolean };
    expect(bad.isError).toBe(true);
    const unknown = await call("no/such/method");
    expect((unknown.error as { code: number }).code).toBe(-32601);
  });
});
