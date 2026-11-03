// 打字闯关：开一局（选关卡、护栏开关、可带自己的角色设定），然后一句一句地说；身份、退出两关的最终判定另取（裁判在后台判）。

import { LEVEL_IDS, type LevelId } from "@/lib/domain/levels";
import { parsePersona } from "@/lib/domain/persona";
import { crossSite, readJsonObject } from "@/lib/server/http";
import { sayPlay, startPlay, verdictPlay } from "@/lib/server/play";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const body = await readJsonObject(req);
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
    if (body.action === "verdict") {
      if (typeof body.session_id !== "string" || !Number.isInteger(body.index)) {
        return Response.json({ error: "缺少 session_id 或 index" }, { status: 400 });
      }
      return Response.json(await verdictPlay(body.session_id, body.index as number));
    }
    return Response.json({ error: "action 只能是 start、say 或 verdict" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
