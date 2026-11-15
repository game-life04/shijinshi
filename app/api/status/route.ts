// 工作台初始化用：当前是真实模型还是模拟、用的模型、可用套件及其校验结果、已登记的策略。
// 套件只给公开的：保留集封存，题目不经这里发出去（ADR-050）。

import { requireSession } from "@/lib/server/auth";
import { isLive, modelFor } from "@/lib/server/llm";
import { loadKb } from "@/lib/server/rag";
import { publicSuites } from "@/lib/server/sealed";
import { loadStrategies } from "@/lib/server/tester";
import { ttsProvider } from "@/lib/server/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = requireSession(req);
  if (denied) return denied;
  try {
    const suites = publicSuites().map((s) => ({
      id: s.id,
      file: s.file,
      errors: s.errors,
      sha256: s.sha256.slice(0, 16),
      cases: s.cases.map((c) => ({
        id: c.id,
        family: c.family,
        intent: c.intent ?? null,
        modality: c.modality,
        approval: c.approval,
        inputs: c.inputs.map((i) => i.content),
        expected: c.expected.observable_behavior,
        assertion_ids: c.expected.assertion_ids,
        clause_refs: c.clause_refs,
      })),
    }));
    const kb = loadKb();
    return Response.json({
      live: isLive(),
      // 语音合成是真实的（dashscope）还是模拟发声（simulated）：闯关页据此决定「她用声音回答」默认开不开（ADR-045）
      voice: ttsProvider(),
      models: { subject: modelFor("subject"), tester: modelFor("tester"), judge: modelFor("judge"), guard: modelFor("guard") },
      suites,
      strategies: loadStrategies(),
      kb: { hash: kb.hash, clauses: kb.clauses.length, source: kb.clauses[0]?.source_url, snapshot_sha256: kb.clauses[0]?.snapshot_sha256 },
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
