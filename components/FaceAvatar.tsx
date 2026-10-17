"use client";

// 示意形象：琪叶桃的 VRM 模型在 M2 接入，之前用这个平面头像占位（界面上明确标注）。
// 有角色句子放行时嘴巴动；有句子被拦下时露出困惑表情。用 requestAnimationFrame 直接改 SVG，不触发 React 重渲染。

import { type RefObject, useEffect, useRef } from "react";

export type Expression = "neutral" | "confused";

export default function FaceAvatar({ speakingRef, expression }: { speakingRef: RefObject<boolean>; expression: Expression }) {
  const mouthRef = useRef<SVGEllipseElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const loop = (t: number) => {
      const open = speakingRef.current && !reduce ? 0.3 + 0.6 * Math.abs(Math.sin(t / 80)) : 0;
      mouthRef.current?.setAttribute("ry", String(1.5 + open * 8));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [speakingRef]);

  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" role="img" aria-label="琪叶桃示意形象">
      <path d="M40 118 q-8 -88 60 -92 q68 4 60 92 l6 76 h-132 z" fill="#eef1f6" stroke="#cfd6e2" />
      <ellipse cx="100" cy="110" rx="50" ry="55" fill="#fde7dc" />
      <path d="M50 98 q20 -58 50 -53 q30 -5 50 53 q-20 -24 -50 -27 q-30 3 -50 27 z" fill="#f4f6fa" stroke="#d6dce6" />
      {expression === "confused" ? (
        <>
          <path d="M70 82 q10 -8 20 0" stroke="#5b4a5e" strokeWidth="3" fill="none" />
          <path d="M110 78 q10 4 20 -2" stroke="#5b4a5e" strokeWidth="3" fill="none" />
        </>
      ) : (
        <>
          <path d="M70 80 q10 -6 20 0" stroke="#5b4a5e" strokeWidth="3" fill="none" />
          <path d="M110 80 q10 -6 20 0" stroke="#5b4a5e" strokeWidth="3" fill="none" />
        </>
      )}
      <ellipse cx="80" cy="100" rx="7" ry="9" fill="#7a5ea8" />
      <ellipse cx="120" cy="100" rx="7" ry="9" fill="#7a5ea8" />
      <circle cx="82" cy="97" r="2.2" fill="#fff" />
      <circle cx="122" cy="97" r="2.2" fill="#fff" />
      <ellipse cx="68" cy="122" rx="8" ry="4" fill="#f8b9b0" opacity="0.6" />
      <ellipse cx="132" cy="122" rx="8" ry="4" fill="#f8b9b0" opacity="0.6" />
      <ellipse ref={mouthRef} cx={expression === "confused" ? 104 : 100} cy="138" rx="7" ry="1.5" fill="#c4565b" />
    </svg>
  );
}
