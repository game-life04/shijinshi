// 对话记录与证据：工作台和报告页共用。
// 证据按 [start, end) 位置在原文里画朱批（红笔波浪线），用户能直接看到结论依据的是哪几个字。

import { Bell, LogOut, ShieldX, Volume2 } from "lucide-react";
import { getAssertionDescription } from "@/lib/domain/labels";
import { type Evidence, FAMILY_LABEL, type Finding, GUARD_RULE_LABEL, type TurnAudio, type TurnRecord } from "@/lib/domain/types";
import { Badge, VerdictBadge } from "./ui";

export function Highlighted({ text, spans }: { text: string; spans: Evidence[] }) {
  if (!spans.length) return <>{text}</>;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  sorted.forEach((s, i) => {
    if (s.start < pos) return; // 重叠的跨度只高亮第一段
    if (s.start > pos) parts.push(text.slice(pos, s.start));
    parts.push(
      <mark key={`${s.start}-${i}`} className="zhupi">
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
      {turn.service.crisis_help_appended && (
        <Badge tone="primary" icon={<Bell size={12} aria-hidden />}>
          服务层补上了求助信息（角色这一轮没给）
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
        <div key={u.utterance_id} className="border-l-2 border-primary bg-primary-soft/60 px-2 py-1 text-xs">
          <ShieldX size={12} className="mr-1 inline text-primary" aria-hidden />
          {u.cut_after_release ? "先播后截（已放行后被截）" : "护栏拦下，未放行"}：
          <span className="line-through decoration-primary decoration-[1.5px]">{u.text}</span>
          {u.guard && (
            <span className="ml-1 text-muted">
              （{GUARD_RULE_LABEL[u.guard.rule] ?? u.guard.rule} · {u.guard.by === "rule" ? "规则" : "模型"} · {u.guard.ms} ms ·{" "}
              {u.guard.reason}）
            </span>
          )}
        </div>
      ))}
      {turn.utterances
        .filter((u) => u.guard_dismissed)
        .map((u) => (
          <p key={`${u.utterance_id}-dismissed`} className="text-xs text-muted">
            护栏模型提出疑问但没拦：{u.guard_dismissed}
          </p>
        ))}
      {turn.audio && <AudioLine audio={turn.audio} />}
    </div>
  );
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

export function FindingView({ f, clauseText }: { f: Finding; clauseText?: (id: string) => string | undefined }) {
  const effective = f.reviewed_verdict ?? f.verdict;
  return (
    <div className="space-y-1 border-b border-border py-2 text-sm last:border-b-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <VerdictBadge verdict={effective} />
        <span className="text-xs">{getAssertionDescription(f.rule_id) || f.rule_id}</span>
        <code className="text-[11px] text-muted">{f.rule_id}</code>
        {f.review_status === "pending" && <Badge tone="warn">待人工复核</Badge>}
        {f.review_status === "confirmed" && <Badge tone="ok">人工已确认</Badge>}
        {f.review_status === "overturned" && <Badge tone="primary">人工已改判（原判 {f.verdict}）</Badge>}
        <span className="text-xs text-muted">{f.by === "assertion" ? "程序判定" : "裁判模型判定"}</span>
      </div>
      <p className="text-xs text-muted">{f.reason_summary}</p>
      {f.evidence.map((e) => (
        <div key={`${e.turn_id}-${e.start}`} className="text-xs" title={`${e.turn_id} · 第 ${e.start}～${e.end} 个字`}>
          证据：「<mark className="zhupi">{e.quote}</mark>」
          <span className="text-muted">
            （{e.layer === "raw" ? "角色原话" : "最终播出"}
            {/#(\d+)$/.test(e.turn_id) ? ` · 第 ${e.turn_id.match(/#(\d+)$/)?.[1]} 轮` : ""}）
          </span>
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
