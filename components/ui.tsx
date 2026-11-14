// 小型共用组件：状态徽标、按钮、面板。颜色只用 globals.css 里的设计变量；状态同时有文字和图标或形状，不只靠颜色。
// 判定徽标（ADR-021，章法见 globals.css 开头）：合格是朱文印，不合格是墨色实印，不确定是淡墨虚线框，不适用只写字；「拦」是白文印。

import { Ban, CheckCircle2, CircleDashed, Clock, HelpCircle, MinusCircle, ShieldAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CaseStatus, Verdict } from "@/lib/domain/types";

type Tone = "ok" | "bad" | "warn" | "muted" | "primary" | "ink";

const TONE: Record<Tone, string> = {
  ok: "border border-ok text-ok",
  bad: "bg-bad text-surface",
  warn: "border border-dashed border-warn text-warn",
  muted: "border border-border text-muted",
  primary: "bg-primary-soft text-primary",
  // 墨色实印：越界、不合格（和 VerdictBadge 的「不合格」一个样子）
  ink: "bg-foreground text-surface",
};

/** 白文印「拦」：朱红实底、宣纸色字（对话里被拦下的原话、闯关、三种结局都用这一个） */
export function BlockSeal({ className = "" }: { className?: string }) {
  return (
    <span className={`seal-bai inline-block px-1 py-0.5 text-sm leading-none ${className}`} aria-hidden>
      拦
    </span>
  );
}

export function Badge({
  tone,
  icon,
  children,
  title,
  wrap,
}: {
  tone: Tone;
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
  /** 允许折行：放在窄栏里的长徽章（小实验页 320 宽时「模拟数据（非真实模型）」伸出卡片，ADR-049 深度测试） */
  wrap?: boolean;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium ${wrap ? "" : "whitespace-nowrap"} ${TONE[tone]}`}
    >
      {icon}
      {children}
    </span>
  );
}

const VERDICT: Record<Verdict, { tone: Tone; label: string; icon: ReactNode }> = {
  pass: { tone: "ok", label: "合格", icon: <CheckCircle2 size={13} aria-hidden /> },
  fail: { tone: "bad", label: "不合格", icon: <XCircle size={13} aria-hidden /> },
  uncertain: { tone: "warn", label: "不确定", icon: <HelpCircle size={13} aria-hidden /> },
  not_applicable: { tone: "muted", label: "不适用", icon: <MinusCircle size={13} aria-hidden /> },
};

// 叫法和工作台、运行记录一样（ADR-049 深度测试：体检单上同一个数原来叫「平台拦截 / 已取消 / 未执行」，别的页叫「平台拒答 / 终止 / 没跑」）
const STATUS: Record<Exclude<CaseStatus, "completed">, { tone: Tone; label: string; icon: ReactNode }> = {
  provider_blocked: { tone: "warn", label: "平台拒答", icon: <ShieldAlert size={13} aria-hidden /> },
  error: { tone: "bad", label: "出错", icon: <XCircle size={13} aria-hidden /> },
  cancelled: { tone: "muted", label: "终止", icon: <Ban size={13} aria-hidden /> },
  not_run: { tone: "muted", label: "没跑", icon: <CircleDashed size={13} aria-hidden /> },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  if (verdict === "pass") {
    return (
      <span className="seal inline-flex items-center px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap" data-verdict="pass">
        合格
      </span>
    );
  }
  if (verdict === "fail") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-sm bg-foreground px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-surface"
        style={{ fontFamily: "var(--font-kai)" }}
        data-verdict="fail"
      >
        {v.icon}
        不合格
      </span>
    );
  }
  return (
    <Badge tone={v.tone} icon={v.icon}>
      {v.label}
    </Badge>
  );
}

/** 用例状态：完成的显示判定，其余显示状态；没开始的显示「排队」 */
export function CaseBadge({ status, verdict }: { status?: CaseStatus | "running" | "queued"; verdict?: Verdict }) {
  if (status === "completed" && verdict) return <VerdictBadge verdict={verdict} />;
  if (status === "running") {
    return (
      <Badge tone="primary" icon={<Clock size={13} aria-hidden />}>
        进行中
      </Badge>
    );
  }
  if (!status || status === "queued" || status === "completed") {
    return (
      <Badge tone="muted" icon={<CircleDashed size={13} aria-hidden />}>
        排队
      </Badge>
    );
  }
  const s = STATUS[status];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

export function Panel({
  title,
  actions,
  children,
  className = "",
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col rounded-sm border border-border bg-surface ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold tracking-wide" style={{ fontFamily: "var(--font-serif)" }}>
          {title}
        </h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  title,
  type = "button",
  id,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
  id?: string;
}) {
  const style =
    variant === "primary"
      ? "bg-primary text-surface hover:opacity-90"
      : variant === "danger"
        ? "border border-bad text-bad hover:bg-bad-soft"
        : "border border-border bg-surface hover:bg-background";
  return (
    <button
      id={id}
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
    >
      {children}
    </button>
  );
}

/** 指标没有结果时显示「待测」，不能默认为 0（规格 01 §2.3） */
export function Metric({ label, value, hint }: { label: string; value?: string | number | null; hint?: string }) {
  return (
    <div className="min-w-[7rem]" title={hint}>
      <div className="text-xs text-muted">{label}</div>
      <div className="font-mono text-sm tabular-nums">{value === undefined || value === null || value === "" ? "待测" : value}</div>
    </div>
  );
}

/**
 * 通过数「本次通过 X/Y 项」（ADR-022）。只说这一次、这些用例里通过了几项，不是「合格」认证；
 * 分母是计划的全部用例，没跑完、出错的都在分母里。
 * 章法（R19）：写成墨字大号，不再用朱红章——「1/16 项」盖着朱红章，看上去也像盖了合格章。
 * 朱红章只在体检单末尾当出具章（IssueSeal）。测试按 testid「tally-seal」和「本次通过 X/Y 项」这几个字找它。
 */
export function TallySeal({ pass, total, simulated = false }: { pass: number; total: number; simulated?: boolean }) {
  return (
    <div
      className="inline-flex shrink-0 flex-col items-start leading-tight"
      data-testid="tally-seal"
      role="img"
      aria-label={`本次通过 ${pass}/${total} 项${simulated ? "（模拟数据）" : ""}`}
    >
      <span className="text-xs text-muted">本次通过</span>
      <span className="text-3xl tabular-nums" style={{ fontFamily: "var(--font-serif)" }}>
        {pass}/{total} 项
      </span>
      {simulated && <span className="mt-0.5 border border-dashed border-warn px-1 text-[11px] text-warn">模拟数据</span>}
    </div>
  );
}

/** 体检单末尾的出具章：朱红「分寸」印，旁边写清这是什么、不是什么 */
export function IssueSeal() {
  return (
    <div className="flex items-center gap-3" data-testid="issue-seal">
      <span className="seal inline-grid h-12 w-12 shrink-0 place-items-center text-base leading-none" aria-hidden>
        <span className="flex flex-col items-center">
          <span>分</span>
          <span>寸</span>
        </span>
      </span>
      <span className="text-xs text-muted">「分寸」AI 语音角色安全体检台出具。AI 辅助生成；自查辅助，不是合规认证。</span>
    </div>
  );
}
