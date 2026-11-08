"use client";

// 平面示意形象：没有 VRM 模型文件、浏览器不支持 WebGL 或模型加载失败时使用（界面上明确标注）。
// 和 3D 形象读同一个舞台（lib/client/avatar/stage.ts）：嘴张多大、是不是愣住了，每帧直接改 SVG，不触发 React 重渲染。

import { useEffect, useRef } from "react";
import type { AvatarStage } from "@/lib/client/avatar/stage";

/** 旧接口留着：页面没有自己发提示时，confused 会转成一次「被拦」的反应（components/Avatar.tsx） */
export type Expression = "neutral" | "confused";

const BROW_CALM = ["M70 80 q10 -6 20 0", "M110 80 q10 -6 20 0"];
const BROW_UP = ["M70 82 q10 -8 20 0", "M110 78 q10 4 20 -2"];

export default function FaceAvatar({ stage }: { stage: AvatarStage }) {
  const mouthRef = useRef<SVGEllipseElement>(null);
  const browL = useRef<SVGPathElement>(null);
  const browR = useRef<SVGPathElement>(null);

  useEffect(
    () =>
      stage.subscribe((f) => {
        mouthRef.current?.setAttribute("ry", String(1.5 + f.mouthOpen * 8));
        const up = f.face.eyeWide + f.face.browUp > 0.3 || f.face.browSad > 0.2;
        const b = up ? BROW_UP : BROW_CALM;
        browL.current?.setAttribute("d", b[0]);
        browR.current?.setAttribute("d", b[1]);
      }),
    [stage],
  );

  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" role="img" aria-label="琪叶桃示意形象">
      <path d="M40 118 q-8 -88 60 -92 q68 4 60 92 l6 76 h-132 z" fill="#eef1f6" stroke="#cfd6e2" />
      <ellipse cx="100" cy="110" rx="50" ry="55" fill="#fde7dc" />
      <path d="M50 98 q20 -58 50 -53 q30 -5 50 53 q-20 -24 -50 -27 q-30 3 -50 27 z" fill="#f4f6fa" stroke="#d6dce6" />
      <path ref={browL} d={BROW_CALM[0]} stroke="#5b4a5e" strokeWidth="3" fill="none" />
      <path ref={browR} d={BROW_CALM[1]} stroke="#5b4a5e" strokeWidth="3" fill="none" />
      <ellipse cx="80" cy="100" rx="7" ry="9" fill="#7a5ea8" />
      <ellipse cx="120" cy="100" rx="7" ry="9" fill="#7a5ea8" />
      <circle cx="82" cy="97" r="2.2" fill="#fff" />
      <circle cx="122" cy="97" r="2.2" fill="#fff" />
      <ellipse cx="68" cy="122" rx="8" ry="4" fill="#f8b9b0" opacity="0.6" />
      <ellipse cx="132" cy="122" rx="8" ry="4" fill="#f8b9b0" opacity="0.6" />
      <ellipse ref={mouthRef} cx="100" cy="138" rx="7" ry="1.5" fill="#c4565b" />
    </svg>
  );
}
