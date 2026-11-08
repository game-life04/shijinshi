// 虚拟人驱动层（ADR-033）：通道对到模型的表情名；整脸表情（自带张嘴）从来不写；骨骼按约定的方向转；手臂在垂下和背手之间插值；
// 模型里没有的通道丢掉、不报错。用 three.js 的真实类拼一个只有骨骼和表情表的假 VRM，不加载模型文件。

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BONE_KEYS, newFrame } from "@/lib/client/avatar/types";
import { ARMS_BACK, ARMS_DOWN, createVrmDriver, WHOLE_FACE } from "@/lib/client/avatar/vrm-driver";

function fakeVrm(expressions: string[]) {
  const values = new Map<string, number>();
  const writes: string[] = [];
  const nodes = new Map<string, THREE.Object3D>();
  for (const b of [...BONE_KEYS, "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"]) nodes.set(b, new THREE.Object3D());
  const lookAt = { autoUpdate: true, target: {} as unknown, yaw: 0, pitch: 0 };
  let resets = 0;
  const vrm = {
    expressionManager: {
      getExpression: (n: string) => (expressions.includes(n) ? { name: n } : null),
      setValue: (n: string, v: number) => {
        writes.push(n);
        values.set(n, v);
      },
    },
    humanoid: { getNormalizedBoneNode: (b: string) => nodes.get(b) ?? null },
    lookAt,
    springBoneManager: { reset: () => resets++ },
  };
  return { vrm, values, writes, nodes, lookAt, resets: () => resets };
}

const ALL = ["aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", ...WHOLE_FACE];
const CUSTOM = ["eyeFun", "eyeJoy", "eyeSorrow", "eyeSurprised", "eyeAngry", "eyeJoyLeft", "eyeJoyRight"];
const CUSTOM2 = ["browSurprised", "browSorrow", "browJoy", "browAngry", "mouthUp", "mouthDown", "mouthClose"];

describe("驱动层", () => {
  it("通道写到对应的表情上；整脸表情只在初始化时置 0，之后从不写", () => {
    const m = fakeVrm([...ALL, ...CUSTOM, ...CUSTOM2]);
    // biome-ignore lint/suspicious/noExplicitAny: 假 VRM 只实现驱动层用到的部分
    const d = createVrmDriver(THREE, m.vrm as any);
    expect(d.missing).toEqual([]);
    m.writes.length = 0;
    const f = newFrame();
    f.face.aa = 0.5;
    f.face.eyeSmile = 0.3;
    f.face.mouthSmile = 0.2;
    f.face.winkLeft = 1;
    d.apply(f);
    expect(m.values.get("aa")).toBe(0.5);
    expect(m.values.get("eyeFun")).toBe(0.3);
    expect(m.values.get("mouthUp")).toBe(0.2);
    expect(m.values.get("eyeJoyLeft")).toBe(1);
    for (const w of WHOLE_FACE) expect(m.writes).not.toContain(w);
  });

  it("模型里没有细分表情时：那些通道丢掉，不退回整脸表情；眨单眼退回 blinkLeft", () => {
    const m = fakeVrm(ALL);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    expect(d.missing).toContain("eyeSmile");
    expect(d.missing).not.toContain("winkLeft");
    m.writes.length = 0;
    const f = newFrame();
    f.face.eyeSmile = 0.4;
    f.face.winkLeft = 1;
    d.apply(f);
    expect(m.values.get("blinkLeft")).toBe(1);
    for (const w of WHOLE_FACE) expect(m.writes).not.toContain(w);
  });

  it("骨骼按约定转（头 x 正 = 低头：脸朝前的方向往下偏）；视线直接写角度、不追目标", () => {
    const m = fakeVrm(ALL);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    expect(m.lookAt.autoUpdate).toBe(false);
    expect(m.lookAt.target).toBeNull();
    const f = newFrame();
    f.bones.head = [0.1, 0, 0];
    f.look = { yaw: 30, pitch: -10 };
    d.apply(f);
    const front = new THREE.Vector3(0, 0, 1).applyQuaternion((m.nodes.get("head") as THREE.Object3D).quaternion);
    expect(front.y).toBeLessThan(0);
    expect(m.lookAt.yaw).toBe(30);
    expect(m.lookAt.pitch).toBe(-10);
  });

  it("手臂：0 是垂下，1 是背手，中间平滑插值；reset 回到垂下并重置弹簧骨骼", () => {
    const m = fakeVrm(ALL);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    const arm = m.nodes.get("leftUpperArm") as THREE.Object3D;
    const q = (e: number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2]));
    const f = newFrame();
    f.armsBack = 0;
    d.apply(f);
    expect(arm.quaternion.angleTo(q(ARMS_DOWN.leftUpperArm))).toBeLessThan(1e-6);
    f.armsBack = 1;
    d.apply(f);
    expect(arm.quaternion.angleTo(q(ARMS_BACK.leftUpperArm))).toBeLessThan(1e-6);
    f.armsBack = 0.5;
    d.apply(f);
    const half = arm.quaternion.angleTo(q(ARMS_DOWN.leftUpperArm));
    expect(half).toBeGreaterThan(0.05);
    expect(Math.abs(half - arm.quaternion.angleTo(q(ARMS_BACK.leftUpperArm)))).toBeLessThan(1e-6);
    d.reset();
    expect(arm.quaternion.angleTo(q(ARMS_DOWN.leftUpperArm))).toBeLessThan(1e-6);
    expect(m.resets()).toBe(1);
  });
});
