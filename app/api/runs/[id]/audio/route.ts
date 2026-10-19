// 取一句已放行句子的合成音频：PCM 16 位小端、单声道，采样率见响应头。
// 句子用查询参数 ?u= 指定（编号里有 # 号，不放在路径里）。没放行、被拦下或不是语音运行的句子一律 404。

import { openAudio } from "@/lib/server/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: RouteContext<"/api/runs/[id]/audio">) {
  const { id } = await ctx.params;
  const utterance = new URL(req.url).searchParams.get("u") ?? "";
  const a = openAudio(id, utterance);
  if (!a) return Response.json({ error: "没有这句话的音频（未放行、已拦下，或这次运行没开语音）" }, { status: 404 });
  return new Response(a.stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Sample-Rate": String(a.sampleRate),
      "X-Audio-Level": a.level,
    },
  });
}
