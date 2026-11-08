// 闯关里一句已放行句子的合成音频（ADR-037，用嘴套话、她用声音回答）：格式和工作台的 /api/runs/[id]/audio 一样，
// PCM 16 位小端、单声道，采样率见响应头。?s= 是这一局的编号，?u= 是句子编号。没放行、被拦下、这一局没开声音的一律 404。

import { requireSession } from "@/lib/server/auth";
import { openPlayAudio } from "@/lib/server/play";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  const a = openPlayAudio(sp.get("s") ?? "", sp.get("u") ?? "");
  if (!a) return Response.json({ error: "没有这句话的音频（未放行、已拦下，或这一局没开声音）" }, { status: 404 });
  return new Response(a.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Sample-Rate": String(a.sampleRate),
      "X-Audio-Level": a.level,
    },
  });
}
