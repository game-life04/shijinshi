"use client";

// 舞台（ADR-033）：全页只有这一个 requestAnimationFrame。每帧只读一次口型源（voice-player 的 mouthOpen 自带平滑，读两次会平滑两遍、
// 两边拿到的数还不一样），交给导演层算出这一帧，再在同一个回调里分给 3D 形象、平面形象、状态环。
// 这样截断后的第一帧里「读到 0 → 写进模型 → 画出来」是同一个回调：voice-player 在截断时登记的下一帧计时回调排在这个循环后面，
// 记下的「嘴型归零」时刻画面上嘴确实已经闭上（cancel_to_mouth_zero_ms 的含义不变）。
// 地址带 ?avatarTest=1 时，把导演层和逐帧记录挂到 window.__avatar 上给端到端测试用；不带时没有任何影响。

import { useEffect, useRef, useState } from "react";
import { createPerformer } from "./director";
import type { AvatarFrame, Cue, PerformContext, Performer } from "./types";

export type FrameListener = (f: AvatarFrame, dtMs: number) => void;

export interface AvatarStage {
  readonly performer: Performer;
  subscribe(fn: FrameListener): () => void;
}

interface TraceRow {
  t: number;
  mode: string;
  open: number;
  visemes: number;
  blink: number;
  armsBack: number;
  /** 举手的小动作（ADR-048）：权重、哪一个 */
  hand: number;
  handPose: string;
  blush: number;
  revealed: number;
  /** 这一帧所有骨骼偏移里最大的（弧度）：减少动态时应该一直是 0 */
  bonesMax: number;
}

declare global {
  interface Window {
    /** perf：最近 300 帧导演层（performer.sample）平均每帧几毫秒（深度测试用） */
    __avatar?: { performer: Performer; trace: TraceRow[]; cues: { t: number; cue: Cue }[]; perf?: { sampleMs: number } };
  }
}

function seedFromUrl(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const s = new URLSearchParams(window.location.search).get("avatarSeed");
  return s && /^\d+$/.test(s) ? Number(s) : undefined;
}

/** 每个形象一个导演；context 变了（换关卡）就发一条 context 提示 */
export function usePerformer(context: PerformContext): Performer {
  const [performer] = useState(() => {
    const seed = seedFromUrl() ?? crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
    return createPerformer({ seed, now: () => performance.now() });
  });
  const key = JSON.stringify(context);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 按内容比较，context 每次渲染都是新对象
  useEffect(() => {
    performer.cue({ type: "context", context });
  }, [performer, key]);
  return performer;
}

/**
 * 跑起这个导演的逐帧循环；mouth 是外部口型源（有声音时传，返回 undefined 表示这一帧没有外部源）。
 * enabled 为 false 时不跑（页面自己建了舞台传给形象时，形象里的这个就不用跑，全页仍只有一个循环）。
 */
export function useAvatarStage(performer: Performer, mouth?: () => number | undefined, enabled = true): AvatarStage {
  const mouthRef = useRef(mouth);
  mouthRef.current = mouth;
  const listeners = useRef(new Set<FrameListener>());
  const [stage] = useState<AvatarStage>(() => ({
    performer,
    subscribe(fn) {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
  }));

  useEffect(() => {
    if (!enabled) return;
    const test = new URLSearchParams(window.location.search).get("avatarTest") === "1";
    if (test) {
      const cues: { t: number; cue: Cue }[] = [];
      const cue = performer.cue.bind(performer);
      // 测试时记下每条提示（不改导演层本身）
      (performer as { cue: Performer["cue"] }).cue = (c) => {
        cues.push({ t: performance.now(), cue: c });
        return cue(c);
      };
      window.__avatar = { performer, trace: [], cues };
    }
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    performer.setReducedMotion(reduce.matches);
    const onReduce = () => performer.setReducedMotion(reduce.matches);
    reduce.addEventListener("change", onReduce);

    let raf = 0;
    let last = performance.now();
    const sampleTimes: number[] = [];
    const loop = () => {
      const now = performance.now();
      const dt = Math.min(100, now - last);
      last = now;
      const ext = mouthRef.current?.();
      const s0 = test ? performance.now() : 0;
      const f = performer.sample({ externalMouth: ext });
      if (test && window.__avatar) {
        sampleTimes.push(performance.now() - s0);
        if (sampleTimes.length > 300) sampleTimes.shift();
        window.__avatar.perf = { sampleMs: sampleTimes.reduce((a, x) => a + x, 0) / sampleTimes.length };
      }
      for (const fn of listeners.current) fn(f, dt);
      if (test && window.__avatar) {
        const tr = window.__avatar.trace;
        tr.push({
          t: Math.round(f.t),
          mode: f.mode,
          open: f.mouthOpen,
          visemes: f.face.aa + f.face.ih + f.face.ou + f.face.ee + f.face.oh,
          blink: f.face.blink,
          armsBack: f.armsBack,
          hand: f.hand.w,
          handPose: f.hand.pose,
          blush: f.face.blush,
          revealed: f.revealed,
          bonesMax: Math.max(...Object.values(f.bones).flatMap((e) => e.map(Math.abs))),
        });
        if (tr.length > 3000) tr.splice(0, tr.length - 3000);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      reduce.removeEventListener("change", onReduce);
    };
  }, [performer, enabled]);

  return stage;
}
