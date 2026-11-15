"use client";

// 角色形象（ADR-021、ADR-033）。两种取景：
//   bust：圆形月洞窗里的胸像，窗框外圈是状态环（工作台、三种结局）；
//   stage：闯关页的半身舞台，月洞窗（状态环）画在她身后，像主视觉那样。
// 表演由导演层算（lib/client/avatar/）：页面自己发提示时把 performer 传进来；没传的页面（三种结局）按 phase / expression 自动发。
// 优先显示 VRM 3D 模型（public/models/qiyetao.vrm，可用 NEXT_PUBLIC_VRM_URL 改）；不能用时换成平面示意形象，并在下方写明原因。

import dynamic from "next/dynamic";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { type AvatarStage, useAvatarStage, usePerformer } from "@/lib/client/avatar/stage";
import type { PerformContext, Performer } from "@/lib/client/avatar/types";
import { holdModel } from "@/lib/client/model-fetch";
import bustStill from "./avatar-art/qiyetao-bust.jpg";
import stageTallStill from "./avatar-art/qiyetao-stage-tall.jpg";
import stageWideStill from "./avatar-art/qiyetao-stage-wide.jpg";
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
  /** 盖在舞台（月洞窗）上的一层，比如闯关里说要走时落下的帘子（ADR-046）；只在 stage 取景里画 */
  overlay?: ReactNode;
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
  overlay,
}: AvatarProps) {
  // 模型文件（约 3.8 MB）原来要等 three.js 那几个大脚本下载完才开始拉；这里提前下载（ADR-043），
  // 下载好的数据由 VrmAvatar 直接解析，只下载一次（lib/client/model-fetch.ts；ADR-049 复查起不再用 link preload，
  // 慢线路上浏览器会报「预加载了但几秒内没用上」）。
  // 提前到「页面能用以后」为止，不写进首屏的 HTML（ADR-045）：11-13 在线上实测，跨境线路只有约 150 KB/s 时，
  // 写在首屏里的预加载会和页面自己的脚本抢带宽，一个 30 KB 的脚本被挤了 17 秒，页面 22 秒才能打字。
  // 放进 effect 里：页面先能用（这时显示静态图），模型和 three.js 的脚本一起在后面下载。失败了这里不管，VrmAvatar 会再试一次并说明原因。
  // ADR-052：形象在页面上时占着下载，离开这一页（换到没有形象的页面）就暂停、已经下好的留着，回来接着下——不再和别的页面抢跨境带宽。
  // （这一句写在下面 fallback 后面：3D 出不来、已经退成静态图时不占着，不白下一份用不上的模型）
  const own = usePerformer(context ?? { page: "workbench" });
  const ownStage = useAvatarStage(performer ?? own, mouth, !given);
  const stage = given ?? ownStage;
  useAvatarAdapter(performer ? undefined : own, phase, expression);
  const greeted = useRef(false);
  const greetTimer = useRef<number | undefined>(undefined);
  const [fallback, setFallback] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => (fallback ? undefined : holdModel(VRM_URL)), [fallback]);
  // 登场：她看见你了，闭眼一笑、点个头、挥挥手（只演一次）。等静态图真正淡完再演：3D 形象刚出来那一下主线程会卡半秒多
  // （第一次画、编译着色器），淡出跟着往后推，按时钟等会和还没淡完的静态图叠在一起（11-14 量过：卡 0.56 秒，淡完在 1 秒左右）。
  // 淡出结束有事件；「减少动态」时没有过渡、不发事件，1.5 秒兜底
  const greet = () => {
    if (greeted.current) return;
    greeted.current = true;
    window.clearTimeout(greetTimer.current);
    (performer ?? own).cue({ type: "react", kind: "greet" });
  };
  useEffect(() => () => window.clearTimeout(greetTimer.current), []);
  const status = (
    <p
      className="mt-1 text-center text-[11px] text-muted"
      data-testid="avatar-status"
      data-state={fallback ? "fallback" : loaded ? "loaded" : "loading"}
    >
      <span className="mr-1 rounded-sm bg-foreground px-1 text-surface">AI 角色</span>
      {/* 常驻的只有「AI 角色」和名字（ADR-051，11-15 队员 B：名字后面的都不需要）：原来还写「VRM 3D 形象」「不是真人」，
          AI 标识顶栏一直挂着。形象还在下载、没加载出来时，名字后面临时写一句，出来了就没有。
          舞台很矮时（小屏手机）样式表把这一句收起来；再窄，名字也收起来，只留「AI 角色」（globals.css 里 .play-avatar 的 @container） */}
      <span className="avatar-status-name">
        {subjectName && subjectName !== "琪叶桃" ? `形象：琪叶桃（示意）· 被测角色：${subjectName}` : "琪叶桃"}
      </span>
      {(fallback || !loaded) && (
        <span className="avatar-status-how">
          {" · "}
          {fallback ? `3D 形象没加载出来，先显示静态图（${fallback}）` : "正在加载 3D 形象……"}
        </span>
      )}
    </p>
  );
  // 静态图（评审 R48，scripts/avatar-stills.ts 用同一个模型、同样的取景渲的）：3D 出来之前先显示它，出来以后淡出；
  // 加载失败就停在它上面，不再是一个空圆，也不再换成和琪叶桃对不上的平面示意形象。
  // 闯关页的舞台有两张，按舞台宽高比各摆各的（globals.css 里 .avatar-still-tall / .avatar-still-wide）：又高又窄的舞台（电脑、笔记本）
  // 用 tall 那张，方一点、横一点的（平板、手机、横屏）用 wide 那张；摆法照着 3D 那一段的取景算，所以淡出时和 3D 叠在一起是一个人。
  // ADR-049：原来只有一张、按铺满摆，电脑上静态图里的人比 3D 大一圈、偏上，手机上脸大了一圈，淡出那半秒叠出两个人
  const fade = `pointer-events-none transition-opacity duration-500 ${loaded && !fallback ? "opacity-0" : "opacity-100"}`;
  const onFadeEnd = (e: React.TransitionEvent<HTMLImageElement>) => {
    if (e.propertyName === "opacity" && loaded && !fallback) greet();
  };
  const still = (f: Framing) =>
    f === "stage" ? (
      <>
        {/* biome-ignore lint/performance/noImgElement: 很小的静态图，不需要 next/image 现场转码 */}
        <img src={stageTallStill.src} alt="" aria-hidden className={`avatar-still-tall ${fade}`} onTransitionEnd={onFadeEnd} />
        {/* biome-ignore lint/performance/noImgElement: 同上 */}
        <img src={stageWideStill.src} alt="" aria-hidden className={`avatar-still-wide ${fade}`} onTransitionEnd={onFadeEnd} />
      </>
    ) : (
      // biome-ignore lint/performance/noImgElement: 同上
      <img
        src={bustStill.src}
        alt=""
        aria-hidden
        className={`absolute inset-0 h-full w-full object-cover object-center ${fade}`}
        onTransitionEnd={onFadeEnd}
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
            if (!greeted.current) greetTimer.current = window.setTimeout(greet, 1500);
          }}
        />
      </>
    );

  if (framing === "stage") {
    return (
      <div className="avatar-stage-root relative flex h-full min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-sm bg-sunken [container-type:size]" data-testid="avatar-stage">
          {/* 月洞窗：状态环画在人物身后（她站在窗前，像主视觉）。舞台又矮又宽时（手机上）圆按高度收小，不然只剩一条弧 */}
          <div className="avatar-moon pointer-events-none absolute top-[4%] left-1/2 aspect-square -translate-x-1/2">
            <StatusRing phase={phase} stage={stage} thin />
          </div>
          <div className="absolute inset-0">{figure("stage")}</div>
          {overlay}
        </div>
        {/* 状态和「AI 角色」说明：平时在舞台下面；闯关页在手机上把它叠到舞台底边上，省出高度（样式在 globals.css 的 .play-avatar） */}
        <div className="avatar-meta">
          <PhaseLegend phase={phase} silent={silent} />
          {status}
        </div>
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
