import { requireSession } from "@/lib/server/auth";
import { getRun } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]">) {
  const denied = requireSession(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  try {
    const view = getRun(id);
    return view ? Response.json(view) : Response.json({ error: "运行不存在" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
