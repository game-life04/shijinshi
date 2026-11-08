// 驱动层（ADR-033）：把导演层算出的一帧（AvatarFrame）写进 VRM——表情、骨骼、视线。不调用 vrm.update、不渲染（由 VrmAvatar 在同一帧里接着做）。
// 通道名是「意思」，这里用一张表对到模型里的表情名（scripts/vrm-expressions.py 加的自定义表情 + VRM 预设）；模型里没有的通道直接丢掉，
// 别的 VRM（没有这些自定义表情）照样能用：情绪只剩骨骼、视线和眨眼，不会退回到会张嘴的整脸表情。

import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import type * as Three from "three";
import { type AvatarFrame, BONE_KEYS, type Euler3, FACE_KEYS, type FaceKey } from "./types";

/** 通道 → 模型里的表情名（第一个能找到的生效） */
export const EXPRESSION_MAP: Record<FaceKey, readonly string[]> = {
  aa: ["aa"],
  ih: ["ih"],
  ou: ["ou"],
  ee: ["ee"],
  oh: ["oh"],
  blink: ["blink"],
  eyeSmile: ["eyeFun"],
  eyeHappy: ["eyeJoy"],
  eyeSad: ["eyeSorrow"],
  eyeWide: ["eyeSurprised"],
  eyeFirm: ["eyeAngry"],
  winkLeft: ["eyeJoyLeft", "blinkLeft"],
  winkRight: ["eyeJoyRight", "blinkRight"],
  browUp: ["browSurprised"],
  browSad: ["browSorrow"],
  browJoy: ["browJoy"],
  browFirm: ["browAngry"],
  mouthSmile: ["mouthUp"],
  mouthFrown: ["mouthDown"],
  mouthPress: ["mouthClose"],
};

/** 整脸表情：自带张嘴（截断那一帧嘴会张着），一律不写，初始化时置 0 */
export const WHOLE_FACE = ["happy", "angry", "sad", "relaxed", "surprised", "neutral"] as const;

type ArmBone = "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm";
/**
 * 手臂两个姿势（试验台看过，lab-notes §3）：自然垂下（比原来 ±1.2 更收一点）、背到身后。中间用四元数插值，过渡要慢（袖子会摆）。
 * 小臂一往前弯、手往前抬，喇叭袖就像两个大圆盘对着镜头，所以不做别的手势。
 */
export const ARMS_DOWN: Record<ArmBone, Euler3> = {
  leftUpperArm: [0, -0.1, -1.35],
  rightUpperArm: [0, 0.1, 1.35],
  leftLowerArm: [0, -0.2, 0],
  rightLowerArm: [0, 0.2, 0],
};
export const ARMS_BACK: Record<ArmBone, Euler3> = {
  leftUpperArm: [0, 0.4, -1.3],
  rightUpperArm: [0, -0.4, 1.3],
  leftLowerArm: [0, 0.6, 0],
  rightLowerArm: [0, -0.6, 0],
};

export interface VrmDriver {
  apply(f: AvatarFrame): void;
  /** 清零：表情全 0、骨骼回静止姿势、视线正对，弹簧骨骼重新开始（页面切回来、取景变了、减少动态切换时用） */
  reset(): void;
  /** 模型里找不到的通道（被丢掉了） */
  readonly missing: readonly FaceKey[];
}

export function createVrmDriver(THREE: typeof Three, vrm: VRM): VrmDriver {
  const em = vrm.expressionManager;
  const names = {} as Record<FaceKey, string | null>;
  const missing: FaceKey[] = [];
  for (const k of FACE_KEYS) {
    const name = EXPRESSION_MAP[k].find((n) => em?.getExpression(n)) ?? null;
    names[k] = name;
    if (!name) missing.push(k);
  }
  for (const n of WHOLE_FACE) em?.setValue(n, 0);

  const node = (b: VRMHumanBoneName) => vrm.humanoid?.getNormalizedBoneNode(b) ?? null;
  const bones = BONE_KEYS.map((b) => [b, node(b)] as const);
  const euler = new THREE.Euler();
  const q = (e: Euler3) => new THREE.Quaternion().setFromEuler(euler.set(e[0], e[1], e[2]));
  const arms = (Object.keys(ARMS_DOWN) as ArmBone[]).map((b) => ({ node: node(b), down: q(ARMS_DOWN[b]), back: q(ARMS_BACK[b]) }));

  // three-vrm 的 lookAt 默认每帧自己朝 target 转；这里关掉，直接写导演层给的角度（结果确定，不用知道相机在哪）
  if (vrm.lookAt) {
    vrm.lookAt.autoUpdate = false;
    vrm.lookAt.target = null;
  }

  const apply = (f: AvatarFrame) => {
    if (em) for (const k of FACE_KEYS) if (names[k]) em.setValue(names[k], f.face[k]);
    for (const [b, n] of bones) {
      const e = f.bones[b];
      if (n) n.quaternion.setFromEuler(euler.set(e[0], e[1], e[2]));
    }
    const w = f.armsBack <= 0 ? 0 : f.armsBack >= 1 ? 1 : f.armsBack;
    for (const a of arms) a.node?.quaternion.slerpQuaternions(a.down, a.back, w);
    if (vrm.lookAt) {
      vrm.lookAt.yaw = f.look.yaw;
      vrm.lookAt.pitch = f.look.pitch;
    }
  };

  return {
    apply,
    missing,
    reset() {
      if (em) for (const k of FACE_KEYS) if (names[k]) em.setValue(names[k], 0);
      for (const [, n] of bones) n?.quaternion.identity();
      for (const a of arms) a.node?.quaternion.copy(a.down);
      if (vrm.lookAt) {
        vrm.lookAt.yaw = 0;
        vrm.lookAt.pitch = 0;
      }
      vrm.springBoneManager?.reset();
    },
  };
}
