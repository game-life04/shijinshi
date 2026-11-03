// 体检单三层（ADR-022）：角色原话 → 护栏处理 → 最终播出。
// 判定只看「最终播出」（用户实际看到、听到的）；另两层说明角色本身会不会越界、护栏中间做了什么。
// 工作台和报告页、前后对比页共用；不用浏览器专属的东西，服务端页面也能直接渲染。

import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import type { CaseLayers, RawLayer } from "@/lib/domain/layers";
import { type CaseResult, type Evidence, GUARD_RULE_LABEL, type TurnRecord, type UtteranceRecord } from "@/lib/domain/types";
import { AudioLine, Highlighted } from "./Transcript";
import { Badge, VerdictBadge } from "./ui";

/** 原话层的状态：越界用墨色实印（和「不合格」同一种形状），没越界只写字，待定用淡墨虚线框 */
export function RawBadge({ status }: { status: RawLayer["status"] }) {
  if (status === "crossed") {
    return (
      <span
        className="inline-flex items-center rounded-sm bg-foreground px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-surface"
        style={{ fontFamily: "var(--font-kai)" }}
        data-raw="crossed"
      >
        越界
      </span>
    );
  }
  return status === "clean" ? (
    <Badge tone="muted">没越界</Badge>
  ) : (
    <span className="inline-flex items-center rounded-sm border border-dashed border-warn px-1.5 py-0.5 text-xs whitespace-nowrap text-warn">
      待定
    </span>
  );
}

/** 一行看完三层：原话 → 护栏 → 播出 */
export function LayerStrip({ layers }: { layers: CaseLayers }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" data-testid="layer-strip">
      <span className="text-muted">角色原话</span>
      <RawBadge status={layers.raw.status} />
      <ArrowRight size={12} className="text-muted" aria-hidden />
      <span className="text-muted">护栏处理</span>
      <span>{layers.guard.summary}</span>
      <ArrowRight size={12} className="text-muted" aria-hidden />
      <span className="text-muted">最终播出</span>
      {layers.released ? <VerdictBadge verdict={layers.released} /> : <Badge tone="muted">未完成</Badge>}
    </div>
  );
}

const stopped = (u: UtteranceRecord) => Boolean(u.guard) && (!u.released || u.cut_after_release);

/** 一轮里护栏和服务层做了什么 */
export function GuardCell({ turn, guarded }: { turn: TurnRecord; guarded: boolean }) {
  if (turn.service.exited) return <p>服务层：按退出要求停止，没有再调用模型</p>;
  if (!guarded) return <p className="text-muted">没有护栏，原话直接播出</p>;
  const items: ReactNode[] = [];
  for (const u of turn.utterances) {
    if (stopped(u) && u.guard) {
      items.push(
        <li key={`${u.utterance_id}-stop`}>
          <span className="font-semibold">{u.cut_after_release ? "先播后截" : "拦下"}</span>（
          {GUARD_RULE_LABEL[u.guard.rule] ?? u.guard.rule} · {u.guard.by === "rule" ? "规则" : "模型"} · {u.guard.ms} ms）：
          <span className="line-through decoration-primary decoration-[1.5px]">{u.text}</span>
          <span className="block text-muted">{u.guard.reason}</span>
        </li>,
      );
    } else if (u.origin === "masked") {
      items.push(<li key={`${u.utterance_id}-mask`}>遮住口令后放行：「{u.text}」</li>);
    } else if (u.origin === "fallback") {
      items.push(<li key={`${u.utterance_id}-fb`}>换上兜底句：「{u.text}」</li>);
    } else if (u.origin === "service") {
      items.push(<li key={`${u.utterance_id}-svc`}>服务层加上：「{u.text}」</li>);
    }
    if (u.guard_dismissed) items.push(<li key={`${u.utterance_id}-dis`}>有疑问没拦：{u.guard_dismissed}</li>);
    if (u.guard_late) items.push(<li key={`${u.utterance_id}-late`}>提前放行后复核不一致：{u.guard_late}</li>);
  }
  const passed = turn.utterances.filter((u) => u.released && !u.cut_after_release && (u.origin ?? "role") === "role");
  const early = passed.filter((u) => u.guard_early).length;
  const ms = passed.map((u) => u.guard_ms).filter((x): x is number => typeof x === "number");
  return (
    <div className="space-y-1">
      {items.length > 0 && <ul className="space-y-1">{items}</ul>}
      {passed.length > 0 && (
        <p className="text-muted">
          审过放行 {passed.length} 句{early ? `（其中 ${early} 句提前放行）` : ""}
          {ms.length
            ? ` · 每句审 ${Math.min(...ms) === Math.max(...ms) ? Math.min(...ms) : `${Math.min(...ms)}～${Math.max(...ms)}`} ms`
            : ""}
        </p>
      )}
      {!items.length && !passed.length && <p className="text-muted">这一轮没有内容经过护栏</p>}
    </div>
  );
}

/** 三列：角色原话 | 护栏处理 | 最终播出，每轮一行；窄屏时上下排、每格带标题 */
export function LayeredTurns({
  result,
  layers,
  guarded,
  evidence,
}: {
  result: CaseResult;
  layers: CaseLayers;
  guarded: boolean;
  /** 结论的证据（最终播出层），用来在播出的原文上画朱批 */
  evidence: Evidence[];
}) {
  if (!result.turns.length) return <p className="text-sm text-muted">没有对话记录</p>;
  const cell = "rounded-sm bg-background p-2";
  const head = "mb-1 text-[11px] text-muted md:hidden";
  return (
    <div className="space-y-2 text-sm" data-testid="layered-turns">
      <div className="hidden grid-cols-3 gap-2 text-xs font-semibold md:grid">
        <span>角色原话</span>
        <span>护栏处理</span>
        <span>最终播出（判定看这一层）</span>
      </div>
      {result.turns.map((t) => (
        <div key={t.turn_id} className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
          <p className="text-xs">
            <span className="text-muted">
              第 {t.index} 轮{t.strategy_id ? ` · 测试策略 ${t.strategy_id}` : ""} · 用户：
            </span>
            {t.user_text}
          </p>
          <div className="grid gap-2 md:grid-cols-3">
            <div className={cell}>
              <p className={head}>角色原话</p>
              {t.raw_output ? (
                <Highlighted text={t.raw_output} spans={layers.raw.evidence.filter((e) => e.turn_id === t.turn_id && e.layer === "raw")} />
              ) : (
                <span className="text-muted">{t.service.exited ? "（服务已停止，没有生成）" : "（无输出）"}</span>
              )}
            </div>
            <div className={`${cell} text-xs`}>
              <p className={head}>护栏处理</p>
              <GuardCell turn={t} guarded={guarded} />
            </div>
            <div className={cell}>
              <p className={head}>最终播出</p>
              {t.released_output ? (
                <Highlighted text={t.released_output} spans={evidence.filter((e) => e.turn_id === t.turn_id && e.layer === "released")} />
              ) : (
                <span className="text-muted">{t.service.exited ? "（服务已停止，没有播出）" : "（无输出）"}</span>
              )}
              {t.audio && <AudioLine audio={t.audio} />}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
