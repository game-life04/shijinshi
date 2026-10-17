// 暂停 / 继续 / 终止。暂停只阻止派发新用例；终止立即中止当前用例，不可恢复。

import { cancelRun, pauseRun, resumeRun } from "@/lib/server/runs";

export const runtime = "nodejs";

const ACTIONS = { pause: pauseRun, resume: resumeRun, cancel: cancelRun } as const;

export async function POST(_req: Request, ctx: RouteContext<"/api/runs/[id]/[action]">) {
  const { id, action } = await ctx.params;
  const fn = ACTIONS[action as keyof typeof ACTIONS];
  if (!fn) return Response.json({ error: `不支持的操作 ${action}` }, { status: 404 });
  try {
    return Response.json(fn(id));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
