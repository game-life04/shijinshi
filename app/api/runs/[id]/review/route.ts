// 人工复核一条结论：确认，或改判。

import type { Verdict } from "@/lib/domain/types";
import { reviewFinding } from "@/lib/server/runs";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/review">) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { finding_id?: string; decision?: string; overturn_to?: Verdict };
  if (!body.finding_id || (body.decision !== "confirm" && body.decision !== "overturn")) {
    return Response.json({ error: "需要 finding_id 和 decision（confirm 或 overturn）" }, { status: 400 });
  }
  try {
    return Response.json(reviewFinding(id, body.finding_id, body.decision, body.overturn_to));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
