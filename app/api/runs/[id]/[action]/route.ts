// 暂停 / 继续 / 终止。暂停只阻止派发新用例；终止立即中止当前用例，不可恢复。

import { crossSite } from "@/lib/server/http";
import { cancelRun, pauseRun, resumeRun } from "@/lib/server/runs";

export const runtime = "nodejs";

const ACTIONS = { pause: pauseRun, resume: resumeRun, cancel: cancelRun } as const;

export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/[action]">) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const { id, action } = await ctx.params;
  // 只认自己登记的三个动作（用 in 或直接取属性，constructor、toString 这类原型上的名字也会被当成动作）
  if (!Object.hasOwn(ACTIONS, action)) return Response.json({ error: `不支持的操作 ${action}` }, { status: 404 });
  const fn = ACTIONS[action as keyof typeof ACTIONS];
  try {
    return Response.json(fn(id));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
