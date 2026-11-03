// 打字闯关：开一局（选关卡、护栏开关、可带自己的角色设定），然后一句一句地说。

import { LEVEL_IDS, type LevelId } from "@/lib/domain/levels";
import { parsePersona } from "@/lib/domain/persona";
import { sayPlay, startPlay } from "@/lib/server/play";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.action === "start") {
      const level = LEVEL_IDS.includes(body.level as LevelId) ? (body.level as LevelId) : "canary";
      const persona = parsePersona(body.persona);
      if (persona.error) return Response.json({ error: persona.error }, { status: 400 });
      return Response.json(startPlay({ level, guard: body.guard !== false, fault: body.fault === true, persona: persona.value }));
    }
    if (body.action === "say") {
      if (typeof body.session_id !== "string" || typeof body.text !== "string") {
        return Response.json({ error: "缺少 session_id 或 text" }, { status: 400 });
      }
      return Response.json(await sayPlay(body.session_id, body.text));
    }
    return Response.json({ error: "action 只能是 start 或 say" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
