// 人工复核一条结论：确认、改判，或撤销上一次复核（评审 R31）。记下复核的账号；设了 AUTH_REVIEWERS 时只有名单里的账号能复核。

import type { Verdict } from "@/lib/domain/types";
import { canReview, requireSession, sessionFromRequest } from "@/lib/server/auth";
import { crossSite, readJsonObject } from "@/lib/server/http";
import { reviewFinding } from "@/lib/server/runs";
import { isSealedRun, NO_SUCH_RUN } from "@/lib/server/sealed";

const VERDICTS: Verdict[] = ["pass", "fail", "uncertain", "not_applicable"];

export const runtime = "nodejs";

export async function POST(req: Request, ctx: RouteContext<"/api/runs/[id]/review">) {
  const denied = requireSession(req);
  if (denied) return denied;
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const body = (await readJsonObject(req)) as { finding_id?: unknown; decision?: unknown; overturn_to?: unknown };
  if (typeof body.finding_id !== "string" || (body.decision !== "confirm" && body.decision !== "overturn" && body.decision !== "undo")) {
    return Response.json({ error: "需要 finding_id 和 decision（confirm、overturn 或 undo）" }, { status: 400 });
  }
  const account = sessionFromRequest(req)?.account;
  if (!canReview(account)) return Response.json({ error: "这个账号只能看，不能复核" }, { status: 403 });
  if (body.decision === "overturn" && !VERDICTS.includes(body.overturn_to as Verdict)) {
    return Response.json({ error: `改判只能改成 ${VERDICTS.join("、")}` }, { status: 400 });
  }
  try {
    // 封存的保留集运行当作不存在（ADR-050）：和 reviewFinding 找不到运行时回的一样
    if (isSealedRun(id)) throw new Error(NO_SUCH_RUN);
    return Response.json(reviewFinding(id, body.finding_id, body.decision, body.overturn_to as Verdict | undefined, { account }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
