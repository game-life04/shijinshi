// 调用大模型（OpenAI 兼容接口：阿里云百炼、DeepSeek、智谱等都支持）。
// 用原生 fetch 实现，不引入额外 SDK。三件事在这里统一处理：
//   1. 计量：每次调用记次数和 token，超出预算直接拒绝（规格 01 §4「先测量再排批次」）；
//   2. 错误分类：平台内容审核拦截、限流/额度不足、超时，各自是不同的结果，不能混成「通过」；
//   3. 没有填 LLM_API_KEY 时不调用任何接口，由 simulator.ts 提供明确标记的模拟输出。

import type { Usage } from "../domain/types";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ModelRole = "subject" | "tester" | "judge" | "guard";

const DEFAULT_MODEL: Record<ModelRole, string> = {
  subject: "qwen-flash",
  tester: "qwen-plus",
  judge: "qwen-plus",
  guard: "qwen-flash",
};
const ENV_KEY: Record<ModelRole, string> = {
  subject: "SUBJECT_MODEL",
  tester: "TESTER_MODEL",
  judge: "JUDGE_MODEL",
  guard: "GUARD_MODEL",
};

export function isLive(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

export function modelFor(role: ModelRole): string {
  if (!isLive()) return "simulator";
  return process.env[ENV_KEY[role]] || DEFAULT_MODEL[role];
}

// ---------- 错误分类 ----------

export class ProviderBlockedError extends Error {
  readonly kind = "provider_blocked";
}
export class RateLimitError extends Error {
  readonly kind = "rate_limited";
}
export class BudgetExceededError extends Error {
  readonly kind = "budget_exceeded";
}
export class UpstreamError extends Error {
  readonly kind = "upstream_error";
}

/** 一次运行共用一个计量器：记次数和 token，超过上限就拒绝再调用 */
export class UsageMeter {
  readonly usage: Usage = { llm_calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  constructor(readonly maxCalls: number) {}

  reserve() {
    if (this.usage.llm_calls >= this.maxCalls) {
      throw new BudgetExceededError(`已达到本次运行的模型调用上限（${this.maxCalls} 次）`);
    }
    this.usage.llm_calls++;
  }

  add(u?: { prompt_tokens?: number; completion_tokens?: number }) {
    this.usage.prompt_tokens += u?.prompt_tokens ?? 0;
    this.usage.completion_tokens += u?.completion_tokens ?? 0;
  }
}

function baseUrl(): string {
  return (process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.LLM_API_KEY}` },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.ok) return res;
  const text = await res.text().catch(() => "");
  // 百炼：内容审核拦截返回 400 + DataInspectionFailed；OpenAI 兼容平台常见 content_filter
  if (/DataInspectionFailed|data_inspection_failed|content_filter|inappropriate content/i.test(text)) {
    throw new ProviderBlockedError(`平台内容审核拦截（${res.status}）`);
  }
  if (res.status === 429 || /Throttling|rate limit|quota|Arrearage|insufficient/i.test(text)) {
    throw new RateLimitError(`限流或额度不足（${res.status}）：${text.slice(0, 200)}`);
  }
  throw new UpstreamError(`模型接口返回 ${res.status}：${text.slice(0, 200)}`);
}

/** 流式调用：一边生成一边交出新增文字 */
export async function* chatStream(
  role: ModelRole,
  messages: ChatMessage[],
  meter: UsageMeter,
  opts: { temperature?: number; signal?: AbortSignal } = {},
): AsyncGenerator<string> {
  meter.reserve();
  const res = await post(
    {
      model: modelFor(role),
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.7,
    },
    opts.signal,
  );
  if (!res.body) throw new UpstreamError("模型接口没有返回内容");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let json: {
        choices?: { delta?: { content?: string }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.usage) meter.add(json.usage);
      const choice = json.choices?.[0];
      if (choice?.finish_reason === "content_filter") throw new ProviderBlockedError("平台在生成途中拦截了内容");
      if (choice?.delta?.content) yield choice.delta.content;
    }
  }
}

/** 要求模型只输出一个 JSON 对象；validate 不通过会带着原因重试一次 */
export async function chatJSON<T>(
  role: ModelRole,
  messages: ChatMessage[],
  validate: (x: unknown) => x is T,
  meter: UsageMeter,
  opts: { temperature?: number } = {},
): Promise<{ value: T; attempts: number }> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    meter.reserve();
    const res = await post({
      model: modelFor(role),
      messages:
        attempt === 1
          ? messages
          : [...messages, { role: "user", content: `上一次的输出不合格（${lastError}），请只输出符合要求的 JSON。` }],
      temperature: opts.temperature ?? 0.2,
      response_format: { type: "json_object" },
    });
    const json = await res.json();
    meter.add(json.usage);
    const content: string = json.choices?.[0]?.message?.content ?? "";
    try {
      const parsed = JSON.parse(
        content
          .replace(/^\s*```(?:json)?/i, "")
          .replace(/```\s*$/, "")
          .trim(),
      );
      if (validate(parsed)) return { value: parsed, attempts: attempt };
      lastError = "字段不全或取值不对";
    } catch {
      lastError = "不是合法的 JSON";
    }
  }
  throw new UpstreamError(`模型两次都没有给出合格的 JSON：${lastError}`);
}

/** 带工具的调用：返回模型这一步的回复（可能是文字，也可能是要调用的工具） */
export async function chatTools(
  role: ModelRole,
  messages: ChatMessage[],
  tools: ToolDef[],
  meter: UsageMeter,
  opts: { temperature?: number; signal?: AbortSignal } = {},
): Promise<{ content: string; tool_calls: ToolCall[] }> {
  meter.reserve();
  const res = await post(
    { model: modelFor(role), messages, tools, tool_choice: "auto", temperature: opts.temperature ?? 0.7 },
    opts.signal,
  );
  const json = await res.json();
  meter.add(json.usage);
  const msg = json.choices?.[0]?.message ?? {};
  return { content: msg.content ?? "", tool_calls: (msg.tool_calls ?? []) as ToolCall[] };
}
