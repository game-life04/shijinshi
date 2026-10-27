"use client";

// 月洞窗外圈的状态环（ADR-021）：一眼看出角色这会儿在「听、想、审、说」哪一步，被拦下时整圈变朱红并盖一个「拦」字。
//   听  等对方说话：淡墨细线，慢慢呼吸
//   想  角色在组织回答：一段墨色弧线绕圈
//   审  护栏在审这一句：朱红短划沿着圈走（像红笔一路批下去）
//   说  放行的话正在播放：整圈墨线，粗细跟着实际渲染的响度
//   拦  这一句没过审：整圈朱红，右下角盖「拦」字小印
// 用户要求减少动态时，环只换样式不转动（globals.css 里统一关掉动画）。

import { useEffect, useRef } from "react";

export type Phase = "idle" | "listen" | "think" | "check" | "speak" | "blocked";

export const PHASE_TEXT: Record<Phase, string> = {
  idle: "待命",
  listen: "听：等对方说话",
  think: "想：角色在组织回答",
  check: "审：护栏在审这一句，审过才说出口",
  speak: "说：放行的话正在播放",
  blocked: "拦：这一句没过审，换成兜底的话",
};

const R = 47;

export default function StatusRing({ phase, mouth }: { phase: Phase; mouth: () => number }) {
  const speakRef = useRef<SVGCircleElement>(null);
  const read = useRef(mouth);
  read.current = mouth;

  useEffect(() => {
    if (phase !== "speak") return;
    let frame = 0;
    const loop = () => {
      speakRef.current?.setAttribute("stroke-width", String(1 + read.current() * 2.6));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" data-phase={phase}>
      {/* 底圈：窗框 */}
      <circle cx="50" cy="50" r={R} fill="none" stroke="var(--border)" strokeWidth="0.8" />
      <g transform="rotate(-90 50 50)">
        {phase === "listen" && (
          <circle className="ring-breathe" cx="50" cy="50" r={R} fill="none" stroke="var(--foreground)" strokeWidth="0.9" />
        )}
        {phase === "think" && (
          <g className="ring-spin">
            <circle
              cx="50"
              cy="50"
              r={R}
              fill="none"
              stroke="var(--foreground)"
              strokeWidth="1.6"
              strokeLinecap="round"
              pathLength={100}
              strokeDasharray="22 78"
            />
          </g>
        )}
        {phase === "check" && (
          <circle
            className="ring-sweep"
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="1.8"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="6 4"
          />
        )}
        {phase === "speak" && <circle ref={speakRef} cx="50" cy="50" r={R} fill="none" stroke="var(--foreground)" strokeWidth="1" />}
        {phase === "blocked" && <circle cx="50" cy="50" r={R} fill="none" stroke="var(--primary)" strokeWidth="2.2" />}
      </g>
      {phase === "blocked" && (
        <g transform="translate(83 83) rotate(-8)">
          <rect x="-10" y="-10" width="20" height="20" rx="1.5" fill="var(--primary)" stroke="var(--surface)" strokeWidth="1" />
          <text x="0" y="5" textAnchor="middle" fontSize="14" fill="var(--surface)" style={{ fontFamily: "var(--font-kai)" }}>
            拦
          </text>
        </g>
      )}
    </svg>
  );
}

/** 窗下的四个字：听 · 想 · 审 · 说，当前这一步用朱红；被拦下时「审」换成「拦」 */
export function PhaseLegend({ phase }: { phase: Phase }) {
  const steps: { key: Phase; char: string }[] = [
    { key: "listen", char: "听" },
    { key: "think", char: "想" },
    { key: phase === "blocked" ? "blocked" : "check", char: phase === "blocked" ? "拦" : "审" },
    { key: "speak", char: "说" },
  ];
  return (
    <div className="mt-1 flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-1.5 text-base" style={{ fontFamily: "var(--font-kai)" }} aria-hidden>
        {steps.map((s, i) => (
          <span key={s.char} className="flex items-center gap-1.5">
            {i > 0 && <span className="text-border">·</span>}
            <span className={s.key === phase ? "font-bold text-primary" : "text-muted"}>{s.char}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted" aria-live="polite" data-testid="avatar-phase">
        {PHASE_TEXT[phase]}
      </p>
    </div>
  );
}
