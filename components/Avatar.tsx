"use client";

// 角色形象：放在圆形的月洞窗里，窗框外圈是状态环（ADR-021）。
// 优先显示 VRM 3D 模型（public/models/qiyetao.vrm，可用 NEXT_PUBLIC_VRM_URL 改）；
// 不能用时换成平面示意形象，并在下方写明原因。

import dynamic from "next/dynamic";
import { useState } from "react";
import FaceAvatar, { type Expression } from "./FaceAvatar";
import StatusRing, { type Phase, PhaseLegend } from "./StatusRing";

const VrmAvatar = dynamic(() => import("./VrmAvatar"), { ssr: false });

export const VRM_URL = process.env.NEXT_PUBLIC_VRM_URL || "/models/qiyetao.vrm";

export default function Avatar({ mouth, expression, phase = "idle" }: { mouth: () => number; expression: Expression; phase?: Phase }) {
  const [fallback, setFallback] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="flex flex-col items-center">
      <div className="relative aspect-square w-full max-w-[15rem]">
        <StatusRing phase={phase} mouth={mouth} />
        <div className="absolute inset-[6%] overflow-hidden rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--foreground)]">
          {fallback ? (
            <FaceAvatar mouth={mouth} expression={expression} />
          ) : (
            <VrmAvatar url={VRM_URL} mouth={mouth} expression={expression} onFail={setFallback} onLoaded={() => setLoaded(true)} />
          )}
        </div>
      </div>
      <PhaseLegend phase={phase} />
      <p className="mt-1 text-center text-[11px] text-muted" data-testid="avatar-status">
        琪叶桃 · {fallback ? `平面示意形象（${fallback}）` : loaded ? "VRM 3D 形象" : "正在加载 3D 形象……"} · AI 角色，非真人
      </p>
    </div>
  );
}
