// 对话记录与证据：工作台、体检单、闯关共用。
// 证据按 [start, end) 位置在原文里画朱批（红笔波浪线），用户能直接看到结论依据的是哪几个字。

import { ChevronRight, Volume2 } from "lucide-react";
import { getAssertionDescription } from "@/lib/domain/labels";
import { type Evidence, FAMILY_LABEL, type Finding, type TurnAudio, type TurnRecord, type Verdict } from "@/lib/domain/types";
import { Badge, VerdictBadge } from "./ui";
import { clauseNo, findingTitle, LAW_SHORT, withClauseNos } from "./wording";

/** 证据跨度；ok 表示它是合格结论的依据（画淡墨点线），否则是问题出处（画红波浪线） */
export type MarkedEvidence = Evidence & { ok?: boolean };

const VERDICT_TEXT: Record<Verdict, string> = { pass: "合格", fail: "不合格", uncertain: "不确定", not_applicable: "不适用" };

/** 把一道题的结论摊成证据跨度：按结论（复核后的为准）分成问题出处和合格依据 */
export function findingSpans(findings: Finding[]): MarkedEvidence[] {
  return findings.flatMap((f) => f.evidence.map((e) => ({ ...e, ok: (f.reviewed_verdict ?? f.verdict) === "pass" })));
}

export function Highlighted({ text, spans }: { text: string; spans: MarkedEvidence[] }) {
  if (!spans.length) return <>{text}</>;
  // 同一处既是问题出处又是合格依据时，问题出处优先
  const sorted = [...spans].sort((a, b) => a.start - b.start || Number(Boolean(a.ok)) - Number(Boolean(b.ok)));
  const parts: React.ReactNode[] = [];
  let pos = 0;
  sorted.forEach((s, i) => {
    if (s.start < pos) return; // 重叠的跨度只高亮第一段
    if (s.start > pos) parts.push(text.slice(pos, s.start));
    const quote = text.slice(s.start, s.end);
    parts.push(
      // 短的证据（比如口令 QYT-5F8E0E）不折行：在连字符处断开，波浪线会断成两截（评审 R43）
      <mark key={`${s.start}-${i}`} className={`${s.ok ? "zhupi-ok" : "zhupi"}${quote.length <= 24 ? " whitespace-nowrap" : ""}`}>
        {quote}
      </mark>,
    );
    pos = s.end;
  });
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

/** 放出去的一句话：角色说的，还是系统补的（时长提醒、求助信息） */
export interface ReleasedPart {
  text: string;
  /** 在 released_output 里从第几个字开始（证据的位置按整段算） */
  start: number;
  service: boolean;
}

/**
 * 放出去的话按句拆开（评审 R15）。released_output 就是放行的各句按顺序拼起来的；
 * 拼不上的（旧记录、事件流里拼出来的进行中的一轮）整段当角色的话，不猜。
 */
export function releasedParts(turn: Pick<TurnRecord, "utterances" | "released_output">): ReleasedPart[] {
  const parts: ReleasedPart[] = [];
  let pos = 0;
  for (const u of turn.utterances) {
    if (!u.released) continue;
    parts.push({ text: u.text, start: pos, service: u.origin === "service" });
    pos += u.text.length;
  }
  if (parts.map((p) => p.text).join("") !== turn.released_output) {
    return turn.released_output ? [{ text: turn.released_output, start: 0, service: false }] : [];
  }
  return parts;
}

/** 一句话加上落在它上面的证据（证据位置按整段算，这里换成句内位置） */
export function PartText({ part, spans }: { part: ReleasedPart; spans: MarkedEvidence[] }) {
  const end = part.start + part.text.length;
  const local = spans
    .filter((s) => s.start < end && s.end > part.start)
    .map((s) => ({ ...s, start: Math.max(s.start, part.start) - part.start, end: Math.min(s.end, end) - part.start }));
  return <Highlighted text={part.text} spans={local} />;
}

/** 一轮的语音计量（浏览器渲染层）：首声等待、渲染时长；被截的句子另列违规音频渲染时长和停止响应 */
export function AudioLine({ audio }: { audio: TurnAudio }) {
  if (audio.status !== "played") {
    return (
      <p className="text-xs text-muted">
        <Volume2 size={12} className="mr-1 inline" aria-hidden />
        语音：{audio.status === "cancelled" ? "运行已终止，" : "没有浏览器在播放，"}这一轮不计量
      </p>
    );
  }
  const rendered = audio.utterances.reduce((n, u) => n + u.rendered_ms, 0);
  return (
    <div className="text-xs text-muted">
      <p>
        <Volume2 size={12} className="mr-1 inline" aria-hidden />
        语音（{audio.level === "simulation" ? "模拟发声" : `真实合成 ${audio.model}`}）：首声等待 {audio.first_audio_ms ?? "—"} ms · 已渲染{" "}
        {Math.round(rendered)} ms
      </p>
      {audio.utterances
        .filter((u) => u.violation)
        .map((u) => (
          <p key={u.utterance_id} className="text-bad">
            截断 {u.utterance_id.split(".").at(-1)}：违规音频渲染 {u.leak_rendered_ms ?? "—"} ms（
            {u.violation_level === "char" ? "按字精确定位" : "句级上界：没有字级时间戳，按整句算"}）· 截断前已渲染 {u.rendered_ms} ms · 停止
            ≤ {u.cancel_to_stop_ms ?? "—"} ms · 口型归零 {u.cancel_to_mouth_zero_ms ?? "—"} ms
          </p>
        ))}
    </div>
  );
}

export function FindingView({
  f,
  clauseText,
  simulated = false,
}: {
  f: Finding;
  clauseText?: (id: string) => string | undefined;
  /** 模拟模式：裁判是模拟器，没有真的判 */
  simulated?: boolean;
}) {
  const effective = f.reviewed_verdict ?? f.verdict;
  // 待复核的「合格」先按不确定算（体检单的计分就是这样），不盖合格印
  const pendingPass = f.review_status === "pending" && effective === "pass";
  // 断言说明太长的用短标题，长说明收进折叠；断言编号放进悬停（评审 R25、R26）
  const { title, more } = findingTitle(f.rule_id, getAssertionDescription(f.rule_id));
  return (
    <div className="space-y-1 border-b border-border py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        {pendingPass ? <Badge tone="warn">暂判合格 · 待复核（先按不确定算）</Badge> : <VerdictBadge verdict={effective} />}
        <span className="text-xs" title={`检查编号 ${f.rule_id}`}>
          {title}
        </span>
        {f.review_status === "pending" && !pendingPass && <Badge tone="warn">待人工复核</Badge>}
        {f.review_status === "confirmed" && <Badge tone="ok">人工已确认</Badge>}
        {f.review_status === "overturned" && <Badge tone="muted">人工已改判（原判 {VERDICT_TEXT[f.verdict]}）</Badge>}
        <span className="text-xs text-muted">
          {f.by === "assertion" ? "程序判定" : simulated ? "模拟裁判（没有真的判）" : "裁判模型判定"}
        </span>
      </div>
      {more && (
        <details className="group text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-0.5 text-muted [&::-webkit-details-marker]:hidden">
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden />
            这一条具体怎么判
          </summary>
          <p className="mt-1 text-muted">{more}</p>
        </details>
      )}
      <p className="text-xs text-muted">{withClauseNos(f.reason_summary)}</p>
      {f.evidence.map((e) => (
        <div key={`${e.turn_id}-${e.start}`} className="text-xs" title={`${e.turn_id} · 第 ${e.start}～${e.end} 个字`}>
          证据：「
          <mark className={`${effective === "pass" ? "zhupi-ok" : "zhupi"}${e.quote.length <= 24 ? " whitespace-nowrap" : ""}`}>
            {e.quote}
          </mark>
          」
          <span className="text-muted">
            （{e.layer === "raw" ? "角色原话" : "最终播出"}
            {/#(\d+)$/.test(e.turn_id) ? ` · 第 ${e.turn_id.match(/#(\d+)$/)?.[1]} 轮` : ""}）
          </span>
        </div>
      ))}
      {f.clause_refs.map((id) => (
        // 导出 PDF 时不在每条结论下面重复印条文：体检单末尾的附录里统一印一次（评审 R30）
        <details key={id} className="no-print text-xs">
          <summary className="cursor-pointer text-muted underline decoration-dotted underline-offset-2">
            依据 {LAW_SHORT}
            {clauseNo(id)}
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded bg-background p-2">{clauseText?.(id) ?? "（条文原文见体检单末尾的附录）"}</p>
        </details>
      ))}
    </div>
  );
}

export function familyLabel(f: keyof typeof FAMILY_LABEL) {
  return FAMILY_LABEL[f];
}
