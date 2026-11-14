// 虚拟人驱动层（ADR-033）：通道对到模型的表情名；整脸表情（自带张嘴）从来不写；骨骼按约定的方向转；手臂在垂下和背手之间插值；
// 模型里没有的通道丢掉、不报错。用 three.js 的真实类拼一个只有骨骼和表情表的假 VRM，不加载模型文件。
// ADR-048：脸红是贴在两颊前面的两片（挂在头骨上，深浅跟通道走，VRM0 也在脸前）；举手（比耶、挥手）只转右臂、右手和手指，权重回 0 手指回静止姿势；
// 举起、放下时手腕沿绕开身体的弧线走，不出画面（11-13 复查）。

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BONE_KEYS, newFrame } from "@/lib/client/avatar/types";
import { ARMS_BACK, ARMS_DOWN, createVrmDriver, HAND_POSES, WAVE_HZ, WHOLE_FACE } from "@/lib/client/avatar/vrm-driver";

const HAND_BONES = [...new Set([...Object.keys(HAND_POSES.peace), ...Object.keys(HAND_POSES.waveA), ...Object.keys(HAND_POSES.waveB)])];

/** withFace：加上头骨和两只眼睛（真实模型那样的位置），脸红才放得上去；vrm0：像 VRM0 模型那样整个场景转过 180 度（模型自己朝 -Z，转完朝 +Z） */
function fakeVrm(expressions: string[], withFace = false, vrm0 = false) {
  const values = new Map<string, number>();
  const writes: string[] = [];
  const nodes = new Map<string, THREE.Object3D>();
  for (const b of [...BONE_KEYS, "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm", ...HAND_BONES])
    nodes.set(b, new THREE.Object3D());
  const scene = new THREE.Group();
  const raw = new Map<string, THREE.Object3D>();
  if (withFace) {
    const k = vrm0 ? -1 : 1;
    if (vrm0) scene.rotation.y = Math.PI;
    const head = new THREE.Object3D();
    head.position.set(0, 1.4, -0.025 * k);
    scene.add(head);
    for (const [name, x] of [
      ["leftEye", 0.017],
      ["rightEye", -0.017],
    ] as const) {
      const eye = new THREE.Object3D();
      eye.position.set(x * k, 0.064, 0.022 * k);
      head.add(eye);
      raw.set(name, eye);
    }
    raw.set("head", head);
  }
  const lookAt = { autoUpdate: true, target: {} as unknown, yaw: 0, pitch: 0 };
  let resets = 0;
  const vrm = {
    scene,
    expressionManager: {
      getExpression: (n: string) => (expressions.includes(n) ? { name: n } : null),
      setValue: (n: string, v: number) => {
        writes.push(n);
        values.set(n, v);
      },
    },
    humanoid: { getNormalizedBoneNode: (b: string) => nodes.get(b) ?? null, getRawBoneNode: (b: string) => raw.get(b) ?? null },
    lookAt,
    springBoneManager: { reset: () => resets++ },
  };
  return { vrm, values, writes, nodes, raw, scene, lookAt, resets: () => resets };
}

const ALL = ["aa", "ih", "ou", "ee", "oh", "blink", "blinkLeft", "blinkRight", ...WHOLE_FACE];
const CUSTOM = ["eyeFun", "eyeJoy", "eyeSorrow", "eyeSurprised", "eyeAngry", "eyeJoyLeft", "eyeJoyRight"];
const CUSTOM2 = ["browSurprised", "browSorrow", "browJoy", "browAngry", "mouthUp", "mouthDown", "mouthClose"];

describe("驱动层", () => {
  it("通道写到对应的表情上；整脸表情只在初始化时置 0，之后从不写", () => {
    const m = fakeVrm([...ALL, ...CUSTOM, ...CUSTOM2], true);
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
    expect(d.missing).toContain("blush"); // 没有头骨、眼睛骨骼：脸红放不上去，算缺
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

  it.each([
    ["VRM1", false],
    ["VRM0（场景转过 180 度）", true],
  ])("脸红（ADR-048）：两颊前面各一片，挂在头骨上（跟着头动）；深浅跟通道走，0 时不画 —— %s", (_name, vrm0) => {
    const m = fakeVrm(ALL, true, vrm0);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    const head = m.raw.get("head") as THREE.Object3D;
    const pieces = head.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);
    expect(pieces).toHaveLength(2);
    // 一左一右，在眼睛下面、比眼睛靠前
    const world = pieces.map((p) => p.getWorldPosition(new THREE.Vector3()));
    const eyeY = (m.raw.get("leftEye") as THREE.Object3D).getWorldPosition(new THREE.Vector3()).y;
    const eyeZ = (m.raw.get("leftEye") as THREE.Object3D).getWorldPosition(new THREE.Vector3()).z;
    expect(world[0].x * world[1].x).toBeLessThan(0);
    for (const w of world) {
      expect(w.y).toBeLessThan(eyeY);
      expect(w.z).toBeGreaterThan(eyeZ);
    }
    const mat = pieces[0].material as THREE.MeshBasicMaterial;
    const f = newFrame();
    d.apply(f);
    expect(pieces.every((p) => !p.visible)).toBe(true);
    f.face.blush = 0.6;
    d.apply(f);
    expect(pieces.every((p) => p.visible)).toBe(true);
    expect(mat.opacity).toBeGreaterThan(0.3);
    expect(mat.depthWrite).toBe(false); // 刘海在前面时照样被挡住（开着深度测试），自己不挡别的
    // 头一动，脸红跟着动
    const before = pieces[0].getWorldPosition(new THREE.Vector3());
    head.rotation.set(0.3, 0, 0);
    m.scene.updateMatrixWorld(true);
    expect(pieces[0].getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeGreaterThan(0.005);
    d.reset();
    expect(pieces.every((p) => !p.visible)).toBe(true);
  });

  it("举手（ADR-048）：举到位（权重 1）时右臂、右手、手指正好是试验台调好的姿势，左臂不动；权重回 0 右臂回到底子、手指回静止姿势；挥手来回摆", () => {
    const m = fakeVrm(ALL);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    const q = (e: number[]) => new THREE.Quaternion().setFromEuler(new THREE.Euler(e[0], e[1], e[2]));
    const node = (b: string) => m.nodes.get(b) as THREE.Object3D;
    const f = newFrame();
    for (const armsBack of [0, 1]) {
      f.armsBack = armsBack;
      f.hand = { pose: "peace", w: 1, t: 500 };
      d.apply(f);
      for (const [b, e] of Object.entries(HAND_POSES.peace)) expect(node(b).quaternion.angleTo(q(e as number[]))).toBeLessThan(1e-6);
      expect(node("leftUpperArm").quaternion.angleTo(q(armsBack ? ARMS_BACK.leftUpperArm : ARMS_DOWN.leftUpperArm))).toBeLessThan(1e-6);
      // 举到一半：左臂照旧（背着手时比耶，左手还背着）；右上臂离开了底子、还没到比耶
      f.hand.w = 0.5;
      d.apply(f);
      expect(node("leftUpperArm").quaternion.angleTo(q(armsBack ? ARMS_BACK.leftUpperArm : ARMS_DOWN.leftUpperArm))).toBeLessThan(1e-6);
      const ua = node("rightUpperArm").quaternion;
      expect(ua.angleTo(q(armsBack ? ARMS_BACK.rightUpperArm : ARMS_DOWN.rightUpperArm))).toBeGreaterThan(0.1);
      expect(ua.angleTo(q(HAND_POSES.peace.rightUpperArm as number[]))).toBeGreaterThan(0.1);
      // 放下（权重 0）：右臂就是底子，手指回静止姿势
      f.hand = { pose: "", w: 0, t: 0 };
      d.apply(f);
      const base = armsBack ? ARMS_BACK : ARMS_DOWN;
      expect(node("rightUpperArm").quaternion.angleTo(q(base.rightUpperArm))).toBeLessThan(1e-6);
      expect(node("rightLowerArm").quaternion.angleTo(q(base.rightLowerArm))).toBeLessThan(1e-6);
      for (const b of HAND_BONES) if (!(b in ARMS_DOWN)) expect(node(b).quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    }
    // 挥手：手腕在两个位置之间来回摆（手臂不动，11-14 深度测试后改）；正好摆到两头时就是试验台调的两个姿势
    f.armsBack = 0;
    f.hand = { pose: "wave", w: 1, t: 0 };
    const at = (ms: number) => {
      f.hand.t = ms;
      d.apply(f);
      return { hand: node("rightHand").quaternion.clone(), arm: node("rightUpperArm").quaternion.clone() };
    };
    const period = 1000 / WAVE_HZ;
    const a0 = at(0);
    const a1 = at(period / 4); // 摆到 B
    const a2 = at(period / 2);
    expect(a0.hand.angleTo(a1.hand)).toBeGreaterThan(0.1);
    expect(a1.hand.angleTo(a2.hand)).toBeGreaterThan(0.1);
    expect(a0.arm.angleTo(a1.arm)).toBeLessThan(1e-3);
    expect(a1.hand.angleTo(q(HAND_POSES.waveB.rightHand as number[]))).toBeLessThan(1e-6);
    expect(at((period * 3) / 4).hand.angleTo(q(HAND_POSES.waveA.rightHand as number[]))).toBeLessThan(1e-6);
    // 挥手的节拍按 phase（同一个手势放到一半又举起来时接着走），没有 phase 时按 t
    f.hand = { pose: "wave", w: 1, t: 0, phase: period / 4 };
    d.apply(f);
    expect(node("rightHand").quaternion.angleTo(q(HAND_POSES.waveB.rightHand as number[]))).toBeLessThan(1e-6);
    d.reset();
    for (const b of HAND_BONES) if (!(b in ARMS_DOWN)) expect(node(b).quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it("举手过渡（11-13 复查）：从垂下、背手举到比耶或挥手的两头，一路上手腕离身体中线不超过 0.30 米（竖舞台半宽约 0.36 米），连续不跳", () => {
    const m = fakeVrm(ALL);
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    const d = createVrmDriver(THREE, m.vrm as any);
    const node = (b: string) => m.nodes.get(b) as THREE.Object3D;
    // 琪叶桃的右肩关节在中线右边 0.1086 米；上臂 0.2198、小臂 0.2147，静止时朝 -X
    const SHOULDER_X = -0.1086;
    const wrist = () => {
      const qu = node("rightUpperArm").quaternion;
      const ql = node("rightLowerArm").quaternion;
      const elbow = new THREE.Vector3(-1, 0, 0).applyQuaternion(qu).multiplyScalar(0.2198);
      return new THREE.Vector3(-1, 0, 0).applyQuaternion(ql).applyQuaternion(qu).multiplyScalar(0.2147).add(elbow);
    };
    const period = 1000 / WAVE_HZ;
    for (const armsBack of [0, 1])
      for (const [pose, t] of [
        ["peace", 0],
        ["wave", period / 4],
        ["wave", (period * 3) / 4],
      ] as const) {
        let prev: THREE.Vector3 | null = null;
        let far = 0;
        for (let i = 0; i <= 40; i++) {
          const f = newFrame();
          f.armsBack = armsBack;
          f.hand = { pose, w: i / 40, t };
          d.apply(f);
          const p = wrist();
          far = Math.min(far, SHOULDER_X + p.x);
          // 每一步（权重 0.025）手腕挪不到 3 厘米：没有跳变
          if (prev) expect(p.distanceTo(prev)).toBeLessThan(0.03);
          prev = p;
        }
        expect(far, `${armsBack ? "背手" : "垂下"} → ${pose}@${Math.round(t)}`).toBeGreaterThan(-0.3);
      }
  });
});
