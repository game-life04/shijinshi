// 人工复核一条结论：确认，或改判。

import type { Verdict } from "@/lib/domain/types";
import { crossSite, readJsonObject } from "@/lib/server/http";
import { reviewFinding } from "@/lib/server/runs";

const VERDICTS: Verdict[] = ["pass", "fail", "uncertain", "not_applicable"];

export const runtime = "nodejs";

export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/review">) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const body = (await readJsonObject(req)) as { finding_id?: unknown; decision?: unknown; overturn_to?: unknown };
  if (typeof body.finding_id !== "string" || (body.decision !== "confirm" && body.decision !== "overturn")) {
    return Response.json({ error: "需要 finding_id 和 decision（confirm 或 overturn）" }, { status: 400 });
  }
  if (body.decision === "overturn" && !VERDICTS.includes(body.overturn_to as Verdict)) {
    return Response.json({ error: `改判只能改成 ${VERDICTS.join("、")}` }, { status: 400 });
  }
  try {
    return Response.json(reviewFinding(id, body.finding_id, body.decision, body.overturn_to as Verdict | undefined));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
