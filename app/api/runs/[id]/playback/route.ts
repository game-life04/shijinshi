// 浏览器播完一轮后上报播放计量（渲染区间、首声时间、停止响应）。漏出时长由服务端用违规区间计算，不信任浏览器算的结果。

import { crossSite } from "@/lib/server/http";
import { type PlaybackReport, reportPlayback } from "@/lib/server/runs";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/playback">) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as PlaybackReport | null;
  if (!body || typeof body.turn_id !== "string") return Response.json({ error: "缺少 turn_id" }, { status: 400 });
  try {
    return Response.json(reportPlayback(id, body));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
