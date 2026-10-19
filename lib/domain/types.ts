// 领域类型：UI、评测脚本、工具调用共用这一套定义（规格 01 §3.4、02 §4）。

export const FAMILIES = ["CANARY", "PERSONA", "AI_IDENTITY", "USAGE_REMINDER", "EXIT", "CRISIS_SUPPORT", "MINOR_BOUNDARY"] as const;
export type Family = (typeof FAMILIES)[number];

export const FAMILY_LABEL: Record<Family, string> = {
  CANARY: "无害口令不外泄",
  PERSONA: "不违背角色设定",
  AI_IDENTITY: "提示自己是 AI",
  USAGE_REMINDER: "连续使用提醒",
  EXIT: "要求退出就停止",
  CRISIS_SUPPORT: "危机时安抚并引导求助",
  MINOR_BOUNDARY: "不与未成年人建立亲密关系",
};

/** 前两类是工程测试，后五类是与新规条款有关的行为检查 */
export const ENGINEERING_FAMILIES: Family[] = ["CANARY", "PERSONA"];

export type Verdict = "pass" | "fail" | "uncertain" | "not_applicable";
export type CaseStatus = "completed" | "provider_blocked" | "error" | "cancelled" | "not_run";
export type RunState = "queued" | "running" | "pausing" | "paused" | "cancelling" | "completed" | "cancelled" | "failed";

/** 结果等级：真实云端 / 逻辑模拟（无密钥时的确定性模拟器）。不同等级不能混在一起求均值 */
export type DataLevel = "live" | "simulation";

/**
 * 被测配置（规格 02 E1）：
 * B0 基础角色提示；B1 同角色 + 明确边界提示；B2 = B1 + 运行时护栏与服务层机制；
 * FAULT 明确标记的无害故障注入角色，只用来验证检测与保护机制，单独统计。
 */
export type SubjectVariant = "B0" | "B1" | "B2" | "FAULT" | "FAULT_B2";
export const VARIANT_LABEL: Record<SubjectVariant, string> = {
  B0: "B0 基础角色（无边界提示、无护栏）",
  B1: "B1 基础角色 + 边界提示",
  B2: "B2 边界提示 + 运行时护栏",
  FAULT: "故障注入角色（验证检测）",
  FAULT_B2: "故障注入 + 运行时护栏（验证保护）",
};
export const VARIANTS = Object.keys(VARIANT_LABEL) as SubjectVariant[];

/** 有运行时护栏和服务层机制的配置 */
export const GUARDED_VARIANTS: SubjectVariant[] = ["B2", "FAULT_B2"];

/**
 * 放行策略（规格 02 E2）：S1 先审后播（默认）；S2 边审边合成，通过后才放出音频；
 * S3 先播后截（只允许用于无害口令对照实验）。文字层面 S1 和 S2 一样，差别只在语音合成开始的时机。
 */
export type ReleasePolicy = "S1" | "S2" | "S3";
export const POLICY_LABEL: Record<ReleasePolicy, string> = {
  S1: "S1 先审后播",
  S2: "S2 边审边合成",
  S3: "S3 先播后截（仅无害口令对照）",
};

// ---------- 用例（与 suites/case.schema.json 一致） ----------

export interface CaseV1 {
  schema_version: "1.0";
  id: string;
  base_case_id: string;
  split: "smoke" | "dev" | "heldout";
  family: Family;
  modality: "text" | "voice";
  approval: "draft" | "approved" | "rejected";
  inputs: { role: "user"; content: string; input_audio_asset_id?: string | null }[];
  expected: {
    observable_behavior: string;
    assertion_ids: string[];
    target_layer: "raw_subject_output" | "released_output" | "service_state" | "multi_layer";
    on_ambiguity: "human_review";
  };
  clause_refs: string[];
  conditions: {
    clock_mode: "real" | "simulated";
    elapsed_seconds: number;
    advance_seconds: number;
    voice_variant: "none" | "clean" | "homophone" | "interruption";
    canary_mode: "none" | "random_per_run";
  };
  source: {
    kind: "original" | "licensed_adaptation";
    reference: string;
    license: string;
    reviewer: string | null;
    reviewed_at: string | null;
  };
}

// ---------- 一轮对话的记录 ----------

export interface GuardHit {
  rule: "identity" | "exit" | "minor" | "crisis" | "canary";
  by: "rule" | "model";
  reason: string;
  ms: number;
}

export interface UtteranceRecord {
  utterance_id: string;
  text: string;
  /** 是否放行给用户（S1 下被拦的句子不放行；S3 下先放行、后标记被截） */
  released: boolean;
  cut_after_release?: boolean;
  guard?: GuardHit;
  /** 护栏对这一句的判定耗时（含实验设定的固定延迟）；没经过护栏为 undefined */
  guard_ms?: number;
}

/** 采样区间 [start, end)，坐标是这句话音频的源采样 */
export type SampleRange = [start: number, end: number];

/** 一句话在浏览器里的播放计量（规格 02 §4.2、§4.4） */
export interface UtteranceAudio {
  utterance_id: string;
  /** 浏览器 AudioWorklet 实际渲染过的源采样区间（已合并） */
  rendered: SampleRange[];
  rendered_ms: number;
  /** 被截的句子才有：违规内容的采样区间和定位精度 */
  violation?: SampleRange[];
  violation_level?: "char" | "sentence_upper_bound";
  /** 违规音频渲染时长 = 违规区间 ∩ 已渲染区间（服务端用浏览器上报的区间计算） */
  leak_rendered_ms?: number;
  /** 浏览器收到截断/终止 → 主线程收到「已停止渲染」确认（上界） */
  cancel_to_stop_ms?: number;
  /** 浏览器收到截断/终止 → 下一帧画面口型归零 */
  cancel_to_mouth_zero_ms?: number;
  /** 合成首块就绪耗时（服务端） */
  tts_first_chunk_ms?: number;
  outcome: "ended" | "cut" | "cancelled" | "failed" | "not_played";
}

export interface TurnAudio {
  status: "played" | "no_client" | "cancelled";
  level: "simulation" | "live";
  model: string;
  sample_rate: number;
  /** 浏览器收到本轮输入事件 → 第一个非静音采样开始渲染（浏览器同一时钟） */
  first_audio_ms?: number;
  utterances: UtteranceAudio[];
}

export interface TurnRecord {
  turn_id: string;
  index: number;
  user_text: string;
  /** 测试 Agent 用的策略（固定输入的用例为 undefined） */
  strategy_id?: string;
  /** 模型原始输出（所有句子拼起来） */
  raw_output: string;
  /** 用户实际看到/听到的输出（放行的句子 + 兜底句） */
  released_output: string;
  utterances: UtteranceRecord[];
  /** 服务层状态：是否已退出、是否发出时长提醒 */
  service: { exited: boolean; reminder_emitted: boolean; reminder_simulated: boolean };
  provider_blocked: boolean;
  timing_ms: { first_release?: number; total: number };
  /** 语音运行才有 */
  audio?: TurnAudio;
}

export type EvidenceLayer = "raw" | "released";

/** 证据：轮次 + 原文起止位置（JS UTF-16 码元，左闭右开）+ 原文子串 */
export interface Evidence {
  turn_id: string;
  layer: EvidenceLayer;
  start: number;
  end: number;
  quote: string;
}

export type ReviewStatus = "not_needed" | "pending" | "confirmed" | "overturned";

export interface Finding {
  finding_id: string;
  rule_id: string;
  verdict: Verdict;
  layer: CaseV1["expected"]["target_layer"];
  evidence: Evidence[];
  clause_refs: string[];
  by: "assertion" | "judge";
  review_status: ReviewStatus;
  /** 人工复核后的判定（复核前为 undefined） */
  reviewed_verdict?: Verdict;
  reason_summary: string;
}

export interface CaseResult {
  case_id: string;
  base_case_id: string;
  family: Family;
  approval: CaseV1["approval"];
  status: CaseStatus;
  verdict?: Verdict;
  turns: TurnRecord[];
  findings: Finding[];
  error?: string;
}

// ---------- 运行 ----------

export interface RunConfig {
  suite: string;
  case_ids?: string[];
  variant: SubjectVariant;
  policy: ReleasePolicy;
  judge_rag: boolean;
  /** 测试 Agent 每例最多几轮（规格默认 3） */
  max_turns: number;
  /** 本次最多跑几例（演示单次最多 20） */
  max_cases: number;
  /** 本次最多调用模型多少次（含测试 Agent、被测角色、护栏、裁判） */
  max_llm_calls: number;
  /** 允许运行草稿用例：结果会标成「预览」，不计入正式结果 */
  include_drafts: boolean;
  /** 语音播放：放行的句子合成语音，在浏览器播放并计量；每轮等浏览器播完再继续 */
  voice?: boolean;
  /** 实验设定：护栏每句判定额外等待的毫秒数（规格 02 E2「固定已知的判决延迟」），默认 0 */
  guard_delay_ms?: number;
}

export interface Counts {
  planned: number;
  completed: number;
  provider_blocked: number;
  error: number;
  cancelled: number;
  not_run: number;
  pass: number;
  fail: number;
  uncertain: number;
  not_applicable: number;
}

export interface Usage {
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** 送去语音合成的字数 */
  tts_chars?: number;
}

export interface RunManifest {
  schema_version: "1.0";
  run_id: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  state: RunState;
  config: RunConfig;
  data_level: DataLevel;
  /** 有草稿用例参与时为 true：只能当预览，不进入正式统计 */
  preview: boolean;
  models: Record<string, string>;
  hashes: { suite: string; kb: string; persona: string; guard_rules: string };
  canary_hash: string;
  counts: Counts;
  usage: Usage;
  failure_reason?: string;
}

export interface RunEvent {
  schema_version: "1.0";
  run_id: string;
  case_id?: string;
  turn_id?: string;
  utterance_id?: string;
  seq: number;
  epoch: number;
  source: "runner" | "tester" | "subject" | "guard" | "judge" | "tool" | "review";
  monotonic_ms: number;
  type: string;
  data?: Record<string, unknown>;
}
