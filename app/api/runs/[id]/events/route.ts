// 实时事件流：先补发已有事件，再推送新事件；运行结束后关闭。

import type { RunEvent } from "@/lib/domain/types";
import { requireSession } from "@/lib/server/auth";
import { getRun, subscribe } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]/events">) {
  const denied = requireSession(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  let view: ReturnType<typeof getRun> = null;
  try {
    view = getRun(id);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
  if (!view) return Response.json({ error: "运行不存在" }, { status: 404 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        unsub?.();
        controller.close();
      };
      const send = (e: RunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (e.type === "run_finished") close();
      };
      for (const e of view.events) send(e);
      if (closed) return;
      unsub = subscribe(id, send);
      if (!unsub) close(); // 历史运行已不在内存里：补发完就结束
      req.signal.addEventListener("abort", close);
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
