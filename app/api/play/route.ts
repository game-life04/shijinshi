// 打字闯关：开一局（选关卡、第几层、可带自己的角色设定），然后一句一句地说；身份、退出两关的最终判定另取（裁判在后台判）。
// ADR-037：say 可以带 voice（这一局要声音，放行的句子当场合成）；next_attack 给「看 AI 打 AI」出下一招（算一次发言的次数）。

import { isTier, LEVEL_IDS, type LevelId } from "@/lib/domain/levels";
import { parsePersona } from "@/lib/domain/persona";
import { rateLimit } from "@/lib/server/access";
import { requireSession } from "@/lib/server/auth";
import { crossSite, readJsonObject } from "@/lib/server/http";
import { nextAttack, sayPlay, startPlay, verdictPlay } from "@/lib/server/play";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // proxy 之外再核一次会话，以后 matcher 写错了也不会漏放（ADR-032）
  const denied = requireSession(req);
  if (denied) return denied;
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const body = await readJsonObject(req);
  try {
    if (body.action === "start") {
      const level = LEVEL_IDS.includes(body.level as LevelId) ? (body.level as LevelId) : "canary";
      const persona = parsePersona(body.persona);
      if (persona.error) return Response.json({ error: persona.error }, { status: 400 });
      const limited = rateLimit(req, "play_start");
      if (limited) return limited;
      const tier = isTier(body.tier) ? body.tier : undefined;
      return Response.json(startPlay({ level, tier, guard: body.guard !== false, fault: body.fault === true, persona: persona.value }));
    }
    if (body.action === "say") {
      if (typeof body.session_id !== "string" || typeof body.text !== "string") {
        return Response.json({ error: "缺少 session_id 或 text" }, { status: 400 });
      }
      const limited = rateLimit(req, "play_say");
      if (limited) return limited;
      return Response.json(await sayPlay(body.session_id, body.text, { voice: body.voice === true }));
    }
    if (body.action === "next_attack") {
      if (typeof body.session_id !== "string") return Response.json({ error: "缺少 session_id" }, { status: 400 });
      const limited = rateLimit(req, "play_say");
      if (limited) return limited;
      return Response.json(await nextAttack(body.session_id));
    }
    if (body.action === "verdict") {
      if (typeof body.session_id !== "string" || !Number.isInteger(body.index)) {
        return Response.json({ error: "缺少 session_id 或 index" }, { status: 400 });
      }
      return Response.json(await verdictPlay(body.session_id, body.index as number));
    }
    return Response.json({ error: "action 只能是 start、say、next_attack 或 verdict" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
