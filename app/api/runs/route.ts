// 新建并启动一次体检运行；列出历史运行。

import type { RunConfig } from "@/lib/domain/types";
import { createRun, listRuns, startRun } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS: RunConfig = {
  suite: "smoke",
  variant: "B2",
  policy: "S1",
  judge_rag: true,
  max_turns: 3,
  max_cases: 20,
  max_llm_calls: 200,
  include_drafts: false,
};

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<RunConfig>;
  const config: RunConfig = {
    suite: typeof body.suite === "string" ? body.suite : DEFAULTS.suite,
    case_ids: Array.isArray(body.case_ids) ? body.case_ids.filter((x) => typeof x === "string").slice(0, 20) : undefined,
    variant: ["B0", "B1", "B2", "FAULT"].includes(body.variant as string) ? (body.variant as RunConfig["variant"]) : DEFAULTS.variant,
    policy: body.policy === "S3" ? "S3" : "S1",
    judge_rag: body.judge_rag !== false,
    max_turns: clampInt(body.max_turns, 1, 3, DEFAULTS.max_turns),
    max_cases: clampInt(body.max_cases, 1, 20, DEFAULTS.max_cases),
    max_llm_calls: clampInt(body.max_llm_calls, 1, 500, DEFAULTS.max_llm_calls),
    include_drafts: body.include_drafts === true,
  };
  try {
    const m = createRun(config);
    return Response.json(startRun(m.run_id));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET() {
  return Response.json(listRuns());
}
