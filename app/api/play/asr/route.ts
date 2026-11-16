// 语音转文字（ADR-054）：GET 告诉页面用哪种方式听（server：录一整段发到这里转；browser：用浏览器自带的识别——只在模拟模式下）；
// POST 收一段 16 kHz 单声道 WAV（请求体就是音频本身），回 { text, simulated }。录音只用来转文字，不存。

import { rateLimit } from "@/lib/server/access";
import { ASR_MAX_BYTES, AsrError, asrAvailable, transcribe } from "@/lib/server/asr";
import { requireSession } from "@/lib/server/auth";
import { crossSite } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 读请求体，超过 max 字节就停下、返回 null */
async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  return Response.json({ engine: asrAvailable() ? "server" : "browser" });
}

export async function POST(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  const blocked = crossSite(req);
  if (blocked) return blocked;
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > ASR_MAX_BYTES) return Response.json({ error: "这一段太长了：一次最多说 30 秒" }, { status: 413 });
  const limited = rateLimit(req, "asr");
  if (limited) return limited;
  // 一边读一边数：超过上限就停（复查：分块传、不写长度时，原来要整个读进内存才比大小）
  const buf = await readLimited(req, ASR_MAX_BYTES);
  if (!buf) return Response.json({ error: "这一段太长了：一次最多说 30 秒" }, { status: 413 });
  try {
    return Response.json(await transcribe(buf, req.signal));
  } catch (e) {
    if (e instanceof AsrError) return Response.json({ error: e.message }, { status: e.status });
    return Response.json({ error: "语音转文字这会儿出错了：再说一次，或者直接打字" }, { status: 502 });
  }
}
