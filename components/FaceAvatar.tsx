"use client";

// 平面示意形象：没有 VRM 模型文件、浏览器不支持 WebGL 或模型加载失败时使用（界面上明确标注）。
// 每帧读一次口型（0～1）；有句子被拦下时露出困惑表情。用 requestAnimationFrame 直接改 SVG，不触发 React 重渲染。

import { useEffect, useRef } from "react";

export type Expression = "neutral" | "confused";

export default function FaceAvatar({ mouth, expression }: { mouth: () => number; expression: Expression }) {
  const mouthRef = useRef<SVGEllipseElement>(null);
  const read = useRef(mouth);
  read.current = mouth;

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      mouthRef.current?.setAttribute("ry", String(1.5 + read.current() * 8));
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

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
