"use client";

// 角色形象：优先显示 VRM 3D 模型（public/models/qiyetao.vrm，可用 NEXT_PUBLIC_VRM_URL 改）；
// 不能用时换成平面示意形象，并在下方写明原因。

import dynamic from "next/dynamic";
import { useState } from "react";
import FaceAvatar, { type Expression } from "./FaceAvatar";

const VrmAvatar = dynamic(() => import("./VrmAvatar"), { ssr: false });

export const VRM_URL = process.env.NEXT_PUBLIC_VRM_URL || "/models/qiyetao.vrm";

export default function Avatar({ mouth, expression }: { mouth: () => number; expression: Expression }) {
  const [fallback, setFallback] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  return (
    <div>
      <div className="mx-auto aspect-square max-h-56">
        {fallback ? (
          <FaceAvatar mouth={mouth} expression={expression} />
        ) : (
          <VrmAvatar url={VRM_URL} mouth={mouth} expression={expression} onFail={setFallback} onLoaded={() => setLoaded(true)} />
        )}
      </div>
      <p className="mt-1 text-center text-xs text-muted" data-testid="avatar-status">
        琪叶桃 · {fallback ? `平面示意形象（${fallback}）` : loaded ? "VRM 3D 形象" : "正在加载 3D 形象……"} · AI 角色，非真人
      </p>
    </div>
  );
}
