// 对话记录与证据：工作台和报告页共用。
// 证据按 [start, end) 位置在原文里高亮，用户能直接看到结论依据的是哪几个字。

import { Bell, LogOut, ShieldX } from "lucide-react";
import { getAssertionDescription } from "@/lib/domain/labels";
import { type Evidence, FAMILY_LABEL, type Finding, type TurnRecord } from "@/lib/domain/types";
import { Badge, VerdictBadge } from "./ui";

function Highlighted({ text, spans }: { text: string; spans: Evidence[] }) {
  if (!spans.length) return <>{text}</>;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  sorted.forEach((s, i) => {
    if (s.start < pos) return; // 重叠的跨度只高亮第一段
    if (s.start > pos) parts.push(text.slice(pos, s.start));
    parts.push(
      <mark key={`${s.start}-${i}`} className="rounded bg-warn-soft px-0.5 text-foreground ring-1 ring-warn">
        {text.slice(s.start, s.end)}
      </mark>,
    );
    pos = s.end;
  });
  parts.push(text.slice(pos));
  return <>{parts}</>;
}

export function TurnView({ turn, evidence = [] }: { turn: TurnRecord; evidence?: Evidence[] }) {
  const mine = evidence.filter((e) => e.turn_id === turn.turn_id);
  const blocked = turn.utterances.filter((u) => !u.released || u.cut_after_release);
  return (
    <div className="space-y-1.5 border-b border-border py-2 last:border-b-0">
      <div className="text-xs text-muted">
        第 {turn.index} 轮{turn.strategy_id ? ` · 测试策略 ${turn.strategy_id}` : ""}
        {turn.timing_ms.first_release !== undefined ? ` · 首句放行 ${turn.timing_ms.first_release} ms` : ""}
      </div>
      <div className="text-sm">
        <span className="mr-1 text-xs text-muted">用户</span>
        {turn.user_text}
      </div>
      {turn.service.reminder_emitted && (
        <Badge tone="primary" icon={<Bell size={12} aria-hidden />}>
          服务层发出使用时长提醒{turn.service.reminder_simulated ? "（加速模拟）" : ""}
        </Badge>
      )}
      {turn.service.exited ? (
        <Badge tone="primary" icon={<LogOut size={12} aria-hidden />}>
          服务按退出要求停止，未再生成任何内容
        </Badge>
      ) : (
        <div className="text-sm">
          <span className="mr-1 text-xs text-muted">角色（放行）</span>
          {turn.released_output ? (
            <Highlighted text={turn.released_output} spans={mine.filter((e) => e.layer === "released")} />
          ) : (
            <span className="text-muted">（无输出）</span>
          )}
        </div>
      )}
      {blocked.map((u) => (
        <div key={u.utterance_id} className="rounded border border-bad/40 bg-bad-soft px-2 py-1 text-xs">
          <ShieldX size={12} className="mr-1 inline text-bad" aria-hidden />
          {u.cut_after_release ? "先播后截（已放行后被截）" : "护栏拦下，未放行"}：<span className="line-through">{u.text}</span>
          {u.guard && (
            <span className="ml-1 text-muted">
              （{u.guard.rule} · {u.guard.by === "rule" ? "规则" : "模型"} · {u.guard.ms} ms · {u.guard.reason}）
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function FindingView({ f, clauseText }: { f: Finding; clauseText?: (id: string) => string | undefined }) {
  const effective = f.reviewed_verdict ?? f.verdict;
  return (
    <div className="space-y-1 border-b border-border py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <VerdictBadge verdict={effective} />
        <code className="text-xs">{f.rule_id}</code>
        <span className="text-xs text-muted">{getAssertionDescription(f.rule_id)}</span>
        {f.review_status === "pending" && <Badge tone="warn">待人工复核</Badge>}
        {f.review_status === "confirmed" && <Badge tone="ok">人工已确认</Badge>}
        {f.review_status === "overturned" && <Badge tone="primary">人工已改判（原判 {f.verdict}）</Badge>}
        <span className="text-xs text-muted">{f.by === "assertion" ? "确定性断言" : "裁判"}</span>
      </div>
      <p className="text-xs text-muted">{f.reason_summary}</p>
      {f.evidence.map((e) => (
        <div key={`${e.turn_id}-${e.start}`} className="text-xs">
          证据：<code>{e.turn_id}</code> · {e.layer === "raw" ? "原始输出" : "放行输出"} [{e.start}, {e.end})：
          <mark className="rounded bg-warn-soft px-0.5 ring-1 ring-warn">{e.quote}</mark>
        </div>
      ))}
      {f.clause_refs.map((id) => (
        <details key={id} className="text-xs">
          <summary className="cursor-pointer text-primary">
            依据 {id.replace("anthropomorphic-2026:", "拟人化办法第 ")}
            {id.includes(":") ? " 条" : ""}
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded bg-background p-2">{clauseText?.(id) ?? "（条文原文见报告页）"}</p>
        </details>
      ))}
    </div>
  );
}

export function familyLabel(f: keyof typeof FAMILY_LABEL) {
  return FAMILY_LABEL[f];
}
