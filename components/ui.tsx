// 小型共用组件：状态徽标、按钮、面板。颜色只用 globals.css 里的设计变量；状态同时有文字和图标，不只靠颜色。

import { Ban, CheckCircle2, CircleDashed, Clock, HelpCircle, MinusCircle, ShieldAlert, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { CaseStatus, Verdict } from "@/lib/domain/types";

type Tone = "ok" | "bad" | "warn" | "muted" | "primary";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  bad: "bg-bad-soft text-bad",
  warn: "bg-warn-soft text-warn",
  muted: "bg-background text-muted border border-border",
  primary: "bg-primary-soft text-primary",
};

export function Badge({ tone, icon, children, title }: { tone: Tone; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONE[tone]}`}
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

const STATUS: Record<Exclude<CaseStatus, "completed">, { tone: Tone; label: string; icon: ReactNode }> = {
  provider_blocked: { tone: "warn", label: "平台拦截", icon: <ShieldAlert size={13} aria-hidden /> },
  error: { tone: "bad", label: "出错", icon: <XCircle size={13} aria-hidden /> },
  cancelled: { tone: "muted", label: "已取消", icon: <Ban size={13} aria-hidden /> },
  not_run: { tone: "muted", label: "未执行", icon: <CircleDashed size={13} aria-hidden /> },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
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
    <section className={`flex min-h-0 flex-col rounded-md border border-border bg-surface ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
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
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger";
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const style =
    variant === "primary"
      ? "bg-primary text-white hover:opacity-90"
      : variant === "danger"
        ? "bg-bad text-white hover:opacity-90"
        : "border border-border bg-surface hover:bg-background";
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 ${style}`}
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
