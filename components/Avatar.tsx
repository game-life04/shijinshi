"use client";

// 角色形象（ADR-021、ADR-033）。两种取景：
//   bust：圆形月洞窗里的胸像，窗框外圈是状态环（工作台、三种结局）；
//   stage：闯关页的半身舞台，月洞窗（状态环）画在她身后，像主视觉那样。
// 表演由导演层算（lib/client/avatar/）：页面自己发提示时把 performer 传进来；没传的页面（三种结局）按 phase / expression 自动发。
// 优先显示 VRM 3D 模型（public/models/qiyetao.vrm，可用 NEXT_PUBLIC_VRM_URL 改）；不能用时换成平面示意形象，并在下方写明原因。

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { preload } from "react-dom";
import { type AvatarStage, useAvatarStage, usePerformer } from "@/lib/client/avatar/stage";
import type { PerformContext, Performer } from "@/lib/client/avatar/types";
import bustStill from "./avatar-art/qiyetao-bust.jpg";
import stageStill from "./avatar-art/qiyetao-stage.jpg";
import type { Expression } from "./FaceAvatar";
import StatusRing, { type Phase, PhaseLegend } from "./StatusRing";
import type { Framing } from "./VrmAvatar";

const VrmAvatar = dynamic(() => import("./VrmAvatar"), { ssr: false });

export const VRM_URL = process.env.NEXT_PUBLIC_VRM_URL || "/models/qiyetao.vrm";

export interface AvatarProps {
  phase?: Phase;
  /** 外部口型源（有声音时，按实际渲染的响度给 0～1）；返回 undefined 表示这一帧没有外部源，按文字念 */
  mouth?: () => number | undefined;
  /** 页面自己发表演提示时传进来；不传就按 phase / expression 自动发 */
  performer?: Performer;
  /** 没传 performer 时用：变成 confused 时做一次「被拦」的反应 */
  expression?: Expression;
  framing?: Framing;
  context?: PerformContext;
  /** 页面自己建了舞台（要读每一帧，比如打字机效果）时传进来；不传就自己建 */
  stage?: AvatarStage;
  /** 这一页不出声（文字运行、打字闯关）：「说」的说明不写「正在播放」 */
  silent?: boolean;
  /** 被测角色的名字：换成开发者自己的角色时，形象仍是琪叶桃，只作示意（评审 R33） */
  subjectName?: string;
}

/** 没改造的页面（三种结局）：状态环的几个阶段换成同名提示 */
export function useAvatarAdapter(p: Performer | undefined, phase: Phase, expression: Expression) {
  const n = useRef(0);
  useEffect(() => {
    if (!p) return;
    if (phase === "idle") p.cue({ type: "idle" });
    else if (phase === "listen") p.cue({ type: "listen" });
    else if (phase === "think" || phase === "check") p.cue({ type: "think" });
    else if (phase === "speak") p.cue({ type: "say", id: `a${++n.current}`, text: "", voiced: true });
    else if (phase === "blocked") {
      p.cue({ type: "cut" });
      p.cue({ type: "react", kind: "blocked" });
    }
  }, [p, phase]);
  useEffect(() => {
    if (p && expression === "confused") p.cue({ type: "react", kind: "blocked" });
  }, [p, expression]);
}

export default function Avatar({
  phase = "idle",
  mouth,
  performer,
  expression = "neutral",
  framing = "bust",
  context,
  stage: given,
  silent = false,
  subjectName,
}: AvatarProps) {
  // 模型文件（约 3.8 MB）原来要等 three.js 那几个大脚本下载完才开始拉；这里让浏览器提前下载，
  // 请求方式和 GLTFLoader 的 fetch 一致（同源、不带跨站凭据），浏览器才会复用这次下载（ADR-043）。
  // 提前到「页面能用以后」为止，不再写进首屏的 HTML（ADR-045）：11-13 在线上实测，跨境线路只有约 150 KB/s 时，
  // 写在首屏里的预加载会和页面自己的脚本抢带宽，一个 30 KB 的脚本被挤了 17 秒，页面 22 秒才能打字。
  // 放进 effect 里：页面先能用（这时显示静态图），模型和 three.js 的脚本一起在后面下载。
  useEffect(() => {
    preload(VRM_URL, { as: "fetch", crossOrigin: "anonymous" });
  }, []);
  const own = usePerformer(context ?? { page: "workbench" });
  const ownStage = useAvatarStage(performer ?? own, mouth, !given);
  const stage = given ?? ownStage;
  useAvatarAdapter(performer ? undefined : own, phase, expression);
  const greeted = useRef(false);
  const [fallback, setFallback] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const status = (
    <p className="mt-1 text-center text-[11px] text-muted" data-testid="avatar-status">
      <span className="mr-1 rounded-sm bg-foreground px-1 text-surface">AI 角色</span>
      {subjectName && subjectName !== "琪叶桃" ? `形象：琪叶桃（示意）· 被测角色：${subjectName}` : "琪叶桃"} ·{" "}
      {fallback ? `3D 形象没加载出来，先显示静态图（${fallback}）` : loaded ? "VRM 3D 形象" : "正在加载 3D 形象……"} · 不是真人
    </p>
  );
  // 静态图（评审 R48，scripts/avatar-stills.ts 用同一个模型、同样的取景渲的）：3D 出来之前先显示它，出来以后淡出；
  // 加载失败就停在它上面，不再是一个空圆，也不再换成和琪叶桃对不上的平面示意形象
  const still = (f: Framing) => (
    // biome-ignore lint/performance/noImgElement: 很小的静态图，不需要 next/image 现场转码
    <img
      src={(f === "stage" ? stageStill : bustStill).src}
      alt=""
      aria-hidden
      className={`pointer-events-none absolute inset-0 h-full w-full object-cover ${f === "stage" ? "object-bottom" : "object-center"} transition-opacity duration-500 ${loaded && !fallback ? "opacity-0" : "opacity-100"}`}
    />
  );
  const figure = (f: Framing) =>
    fallback ? (
      still(f)
    ) : (
      <>
        {still(f)}
        <VrmAvatar
          url={VRM_URL}
          stage={stage}
          framing={f}
          onFail={setFallback}
          onLoaded={() => {
            setLoaded(true);
            // 登场：她看见你了，闭眼一笑、点个头（只演一次）
            if (!greeted.current) (performer ?? own).cue({ type: "react", kind: "greet" });
            greeted.current = true;
          }}
        />
      </>
    );

  if (framing === "stage") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm bg-sunken" data-testid="avatar-stage">
          {/* 月洞窗：状态环画在人物身后（她站在窗前，像主视觉） */}
          <div className="pointer-events-none absolute top-[4%] left-1/2 aspect-square w-[82%] max-w-[34rem] -translate-x-1/2">
            <StatusRing phase={phase} stage={stage} thin />
          </div>
          <div className="absolute inset-0">{figure("stage")}</div>
        </div>
        <PhaseLegend phase={phase} silent={silent} />
        {status}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center">
      <div className="short-screen-avatar relative aspect-square w-full max-w-[15rem]">
        <StatusRing phase={phase} stage={stage} />
        <div className="absolute inset-[6%] overflow-hidden rounded-full bg-sunken shadow-[inset_0_0_0_1px_var(--foreground)]">
          {figure("bust")}
        </div>
      </div>
      <PhaseLegend phase={phase} silent={silent} />
      {status}
    </div>
  );
}
