// 新建并启动一次体检运行；列出历史运行。

import { isDefaultPersona, parsePersona } from "@/lib/domain/persona";
import { POLICY_LABEL, type ReleasePolicy, type RunConfig, type SubjectVariant, VARIANTS } from "@/lib/domain/types";
import { rateLimit, rateLimitEnabled } from "@/lib/server/access";
import { requireSession, sessionFromRequest } from "@/lib/server/auth";
import { crossSite, readJsonObject } from "@/lib/server/http";
import { createRun, listRuns, startRun } from "@/lib/server/runs";
import { publicRuns, sealedSuiteMatcher } from "@/lib/server/sealed";

const POLICIES = Object.keys(POLICY_LABEL) as ReleasePolicy[];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULTS: RunConfig = {
  suite: "smoke",
  variant: "B2",
  policy: "S2",
  judge_rag: true,
  max_turns: 3,
  max_cases: 20,
  max_llm_calls: 200,
  include_drafts: false,
  voice: false,
  guard_delay_ms: 0,
};

function clampInt(v: unknown, min: number, max: number, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export async function POST(req: Request) {
  // proxy 之外再核一次会话，以后 matcher 写错了也不会漏放（ADR-032）
  const denied = requireSession(req);
  if (denied) return denied;
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const body = (await readJsonObject(req)) as Partial<RunConfig>;
  // 写错的取值直接报错，不悄悄换成默认值（不然体检单上写的配置和用户以为的不一样）
  if (body.variant !== undefined && !VARIANTS.includes(body.variant as SubjectVariant)) {
    return Response.json({ error: `被测配置只能是 ${VARIANTS.join("、")}` }, { status: 400 });
  }
  if (body.policy !== undefined && !POLICIES.includes(body.policy as ReleasePolicy)) {
    return Response.json({ error: `放行策略只能是 ${POLICIES.join("、")}` }, { status: 400 });
  }
  if (body.suite !== undefined && (typeof body.suite !== "string" || !/^[\w-]{1,60}$/.test(body.suite))) {
    return Response.json({ error: "套件名不对" }, { status: 400 });
  }
  const persona = parsePersona(body.persona);
  if (persona.error) return Response.json({ error: persona.error }, { status: 400 });
  const config: RunConfig = {
    suite: typeof body.suite === "string" ? body.suite : DEFAULTS.suite,
    case_ids: Array.isArray(body.case_ids) ? body.case_ids.filter((x) => typeof x === "string").slice(0, 20) : undefined,
    variant: (body.variant as SubjectVariant | undefined) ?? DEFAULTS.variant,
    policy: (body.policy as ReleasePolicy | undefined) ?? DEFAULTS.policy,
    judge_rag: body.judge_rag !== false,
    max_turns: clampInt(body.max_turns, 1, 3, DEFAULTS.max_turns),
    max_cases: clampInt(body.max_cases, 1, 20, DEFAULTS.max_cases),
    // 上线演示开了限流时，单次体检的模型调用最多 200 次（ADR-028）
    max_llm_calls: clampInt(body.max_llm_calls, 1, rateLimitEnabled() ? 200 : 500, DEFAULTS.max_llm_calls),
    include_drafts: body.include_drafts === true,
    voice: body.voice === true,
    guard_delay_ms: clampInt(body.guard_delay_ms, 0, 10000, 0),
    // 和默认角色一字不差时不记，运行清单里没有 persona 就表示默认角色
    persona: persona.value && !isDefaultPersona(persona.value) ? persona.value : undefined,
  };
  // 保留集封存（ADR-050）：网页上不能拿它跑（正式实验在命令行里跑）。查最后真用的套件，放在限流前面：被拒的不算开跑次数
  if (sealedSuiteMatcher()(config.suite)) {
    return Response.json({ error: "保留集是封存的，网页上不能跑" }, { status: 403 });
  }
  const limited = rateLimit(req, "run");
  if (limited) return limited;
  try {
    // 配了账号时记下是谁发起的（体检单「和上一次比」只找自己的上一次）
    const m = createRun(config, { account: sessionFromRequest(req)?.account });
    return Response.json(startRun(m.run_id));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  return Response.json(publicRuns(listRuns()));
}
