// 闯关开场白的声音（ADR-046，她先开口）：?level= 是哪一关。只念写好的固定句子（lib/domain/levels.ts 的 GREETINGS），
// 别的文字一律不念；格式和 /api/play/audio 一样（PCM 16 位小端、单声道，采样率见响应头）。固定句子合成一次就缓存，之后不再计费。

import { LEVEL_IDS, type LevelId } from "@/lib/domain/levels";
import { requireSession } from "@/lib/server/auth";
import { greetAudio } from "@/lib/server/play";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  const level = new URL(req.url).searchParams.get("level") ?? "";
  if (!LEVEL_IDS.includes(level as LevelId)) return Response.json({ error: "没有这一关" }, { status: 404 });
  const a = greetAudio(level as LevelId);
  return new Response(a.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      // 固定句子：让浏览器自己留一小时，同一关再念时不用再下载（跨境线路慢，一句 200～400 KB）。要登录才取得到，所以是 private。
      // 只留真实合成的：模拟发声要是也留着，之后接上真实合成，这个浏览器一小时内听到的还是旧的那一段
      "Cache-Control": a.level === "live" ? "private, max-age=3600" : "no-store",
      "X-Sample-Rate": String(a.sampleRate),
      "X-Audio-Level": a.level,
    },
  });
}
