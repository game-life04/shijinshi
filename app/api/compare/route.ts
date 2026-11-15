// 比较两次运行（同一套件版本、同一数据等级才可比）。

import { requireSession } from "@/lib/server/auth";
import { compareRuns } from "@/lib/server/runs";
import { isSealedRun, NO_SUCH_RUN, sealedSuiteMatcher } from "@/lib/server/sealed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const a = url.searchParams.get("a");
  const b = url.searchParams.get("b");
  if (!a || !b) return Response.json({ error: "需要参数 a 和 b" }, { status: 400 });
  // 封存的保留集运行当作不存在（ADR-050），和 compareRuns 找不到时同一句
  const sealed = sealedSuiteMatcher();
  if (isSealedRun(a, sealed) || isSealedRun(b, sealed)) return Response.json({ error: NO_SUCH_RUN }, { status: 404 });
  try {
    return Response.json(compareRuns(a, b));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
