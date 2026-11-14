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
  // 模型里没有脸红的变形：画在两颊前面（下面的 createBlush）
  blush: [],
};

/**
 * 脸红摆在哪（米，相对两只眼睛的眼球中心）：往外、往下、往前多少，片有多大，往外转多少度。
 * 片浮在脸颊前面一点点，正面看贴着脸；刘海、侧发在它前面时照样挡住它（开着深度测试）。试验台上看过（ADR-048）。
 */
export interface BlushPlace {
  out: number;
  down: number;
  forward: number;
  w: number;
  h: number;
  yawDeg: number;
  /** 脸红到 1 时片的不透明度 */
  strength: number;
}
// 眼睛骨骼在眼球中心，离脸的表面还有好几厘米：往前 8 厘米才浮到脸颊前面（试验台上从 2.2 厘米试到 9 厘米）。
// 通道被守则封顶在 0.6，所以深浅放大 1.5 倍：0.6 时差不多不透明
export const BLUSH: BlushPlace = { out: 0.022, down: 0.03, forward: 0.08, w: 0.034, h: 0.017, yawDeg: 18, strength: 1.5 };

/** 一片脸红的贴图：中间粉、边上淡出，叠三道细斜线（动画里的「害羞线」） */
function blushTexture(THREE: typeof Three): Three.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(64, 32, 2, 64, 32, 62);
  grad.addColorStop(0, "rgba(255, 112, 138, 0.62)");
  grad.addColorStop(0.55, "rgba(255, 128, 150, 0.32)");
  grad.addColorStop(1, "rgba(255, 140, 160, 0)");
  g.save();
  g.translate(64, 32);
  g.scale(1, 0.5);
  g.translate(-64, -32);
  g.fillStyle = grad;
  g.fillRect(0, -32, 128, 128);
  g.restore();
  g.strokeStyle = "rgba(226, 78, 104, 0.7)";
  g.lineWidth = 3.2;
  g.lineCap = "round";
  for (const x of [44, 62, 80]) {
    g.beginPath();
    g.moveTo(x + 7, 20);
    g.lineTo(x - 5, 44);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 在两颊前面各放一片脸红，挂到头骨上（跟着头动）；返回设置深浅的函数。
 * 模型没有头骨、眼睛骨骼时什么都不做（这个通道算「缺」）；没有网页环境做不了贴图时（单元测试）用一块纯粉色代替。
 */
function createBlush(THREE: typeof Three, vrm: VRM, place: BlushPlace): ((v: number) => void) | null {
  const raw = vrm.humanoid && typeof vrm.humanoid.getRawBoneNode === "function" ? vrm.humanoid : null;
  const head = raw?.getRawBoneNode("head");
  const eyes = [raw?.getRawBoneNode("leftEye"), raw?.getRawBoneNode("rightEye")];
  if (!head || !eyes[0] || !eyes[1] || !vrm.scene) return null;
  vrm.scene.updateMatrixWorld(true);
  const tex = blushTexture(THREE);
  const mat = new THREE.MeshBasicMaterial({
    ...(tex ? { map: tex } : { color: 0xff8095 }),
    transparent: true,
    depthWrite: false,
    opacity: 0,
    toneMapped: false,
  });
  const geo = new THREE.PlaneGeometry(place.w, place.h);
  const meshes: Three.Mesh[] = [];
  eyes.forEach((eye, i) => {
    if (!eye) return;
    // 模型面朝 +Z；她的左边（leftEye）在 +X
    const side = i === 0 ? 1 : -1;
    const p = eye.getWorldPosition(new THREE.Vector3());
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.x + side * place.out, p.y - place.down, p.z + place.forward);
    m.rotation.set(0, (side * place.yawDeg * Math.PI) / 180, 0);
    m.renderOrder = 5;
    m.frustumCulled = false;
    m.visible = false;
    // 没有父节点时 attach 把它当前的变换当世界变换（不能先放进 vrm.scene：VRM0 模型的场景转过 180 度，片会跑到后脑勺）
    head.attach(m);
    meshes.push(m);
  });
  return (v: number) => {
    const o = Math.max(0, Math.min(1, v)) * place.strength;
    mat.opacity = o;
    for (const m of meshes) m.visible = o > 0.004;
  };
}

/** 整脸表情：自带张嘴（截断那一帧嘴会张着），一律不写，初始化时置 0 */
export const WHOLE_FACE = ["happy", "angry", "sad", "relaxed", "surprised", "neutral"] as const;

type ArmBone = "leftUpperArm" | "rightUpperArm" | "leftLowerArm" | "rightLowerArm";
/**
 * 手臂两个姿势（试验台看过，lab-notes §3）：自然垂下（比原来 ±1.2 更收一点）、背到身后。中间用四元数插值，过渡要慢（袖子会摆）。
 * 小臂一往前弯、手往前抬，喇叭袖就像两个大圆盘对着镜头，所以手不往前抬；举手的小动作只有比耶、挥手，手举在头侧边（HAND_POSES）。
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

/** 比耶的手指（右手）：食指、中指伸直分开，无名指、小指蜷起，大拇指收（试验台看过，ADR-048） */
const V_FINGERS: Partial<Record<VRMHumanBoneName, Euler3>> = {
  rightIndexProximal: [0, 0.16, 0],
  rightMiddleProximal: [0, -0.12, 0],
  rightRingProximal: [0, 0, 1.35],
  rightRingIntermediate: [0, 0, 1.5],
  rightRingDistal: [0, 0, 1.0],
  rightLittleProximal: [0, 0, 1.35],
  rightLittleIntermediate: [0, 0, 1.5],
  rightLittleDistal: [0, 0, 1.0],
  rightThumbProximal: [0, -0.5, 0.4],
  rightThumbDistal: [0, -0.6, 0.3],
};
/** 挥手的手指：张开、稍微分开 */
const OPEN_FINGERS: Partial<Record<VRMHumanBoneName, Euler3>> = {
  rightIndexProximal: [0, 0.1, 0],
  rightMiddleProximal: [0, 0.02, 0],
  rightRingProximal: [0, -0.06, 0.1],
  rightLittleProximal: [0, -0.14, 0.15],
  rightThumbProximal: [0, 0.3, 0],
};
/**
 * 举手的小动作（右手，ADR-048）：比耶，挥手（在 waveA、waveB 两个位置之间来回摆）。
 * 角度是按「手腕停在右脸旁边、手肘往下收、掌心朝你」反算的（试验台上反算，脚本在会话临时目录、不进仓库），在电脑和手机的舞台上都截图看过：
 * 喇叭袖很大，手一到脸前袖子就把脸整个挡住，所以手只举在头侧边、小臂竖着，V 从袖口上面伸出来。左手不动（垂下或背着）。
 */
export const HAND_POSES: Record<"peace" | "waveA" | "waveB", Partial<Record<VRMHumanBoneName, Euler3>>> = {
  peace: { rightUpperArm: [-0.119, 0.526, 0.435], rightLowerArm: [0.43, 0.165, -2.417], rightHand: [-0.716, 0, 0], ...V_FINGERS },
  waveA: { rightUpperArm: [-0.102, 0.509, 0.389], rightLowerArm: [0.354, 0.149, -2.351], rightHand: [-0.785, 0, 0], ...OPEN_FINGERS },
  // 挥手外侧（11-14 深度测试后改）：手臂和内侧一样不动，只有手腕往外摆（绕掌心的轴转 0.45）。原来是整只袖子轻轻晃、手掌绕小臂打转，
  // 屏幕上手只摆 7 度、看不出在挥手，往外晃时袖子还贴着画面左边；现在手摆 26 度，袖子不往外跑（电脑、手机、横屏手机量过）
  waveB: { rightUpperArm: [-0.102, 0.509, 0.389], rightLowerArm: [0.354, 0.149, -2.351], rightHand: [-1.012, -0.45, 0], ...OPEN_FINGERS },
};
/** 挥手每秒来回几次 */
export const WAVE_HZ = 1.8;
/**
 * 举手过渡时手腕走的路线（ADR-048，11-13 复查后改）：三次贝塞尔，从底子的手腕位置到目标位置。
 * lead：离开底子时手腕先往哪走（第一个控制点 = 底子 + lead）；settle：到目标前从哪边过来（第二个控制点 = 目标 + settle）；
 * 单位米，x 正 = 往身体中线（右手就是往她左边），y 往上，z 朝镜头。pole：中途手肘往哪边偏（同样的方向约定），偏多少 = poleK × 4w(1−w)。
 * 原来上臂、小臂各自从底子插值到终点，举到一半小臂横着朝外，手腕甩到身体中线外 0.45 米、出了画面；
 * 手腕往前绕又会让小臂正对镜头，喇叭袖成了一个大圆盘。现在的走法：先把手收到腰前（像手搭在腰上，袖子侧着），
 * 再横过胸前抬到脸旁，手肘往外下方偏一点——全程不挡脸、不碰画面边。取值是在试验台上换了 11 套参数逐帧截图挑的（11-13）。
 */
export interface HandPath {
  lead: Euler3;
  settle: Euler3;
  pole: Euler3;
  poleK: number;
}
export const HAND_PATH: HandPath = { lead: [0.18, 0.1, 0.1], settle: [0.04, -0.22, 0.03], pole: [-0.7, -0.8, 0], poleK: 0.5 };

export interface VrmDriver {
  apply(f: AvatarFrame): void;
  /**
   * 试验台（只在 ?avatarTest=1 时用）：在这一帧上再盖一层——任何人形骨骼的角度（VRM 骨骼名 → 弧度）、任何表情通道。
   * 用来摆新动作、截图看效果，不改导演层。
   */
  debug(pose?: Record<string, Euler3>, face?: Partial<Record<FaceKey, number>>): void;
  /** 清零：表情全 0、骨骼回静止姿势、视线正对，弹簧骨骼重新开始（页面切回来、取景变了、减少动态切换时用） */
  reset(): void;
  /** 模型里找不到的通道（被丢掉了） */
  readonly missing: readonly FaceKey[];
}

export function createVrmDriver(
  THREE: typeof Three,
  vrm: VRM,
  opts: {
    blush?: Partial<BlushPlace>;
    /** 试验台（?avatarTest=1）：每帧读的路线参数、手的姿势（覆盖 HAND_PATH、HAND_POSES，调参用） */
    path?: () => Partial<HandPath> | undefined;
    poses?: () => Partial<Record<keyof typeof HAND_POSES, Partial<Record<VRMHumanBoneName, Euler3>>>> | undefined;
  } = {},
): VrmDriver {
  const em = vrm.expressionManager;
  const names = {} as Record<FaceKey, string | null>;
  const missing: FaceKey[] = [];
  const blush = createBlush(THREE, vrm, { ...BLUSH, ...opts.blush });
  for (const k of FACE_KEYS) {
    const name = EXPRESSION_MAP[k].find((n) => em?.getExpression(n)) ?? null;
    names[k] = name;
    if (!name && !(k === "blush" && blush)) missing.push(k);
  }
  for (const n of WHOLE_FACE) em?.setValue(n, 0);

  const node = (b: VRMHumanBoneName) => vrm.humanoid?.getNormalizedBoneNode(b) ?? null;
  const bones = BONE_KEYS.map((b) => [b, node(b)] as const);
  const euler = new THREE.Euler();
  const q = (e: Euler3) => new THREE.Quaternion().setFromEuler(euler.set(e[0], e[1], e[2]));
  const arms = (Object.keys(ARMS_DOWN) as ArmBone[]).map((b) => ({ node: node(b), down: q(ARMS_DOWN[b]), back: q(ARMS_BACK[b]) }));
  // 举手的小动作（ADR-048）：每个姿势预先算好四元数；涉及的骨骼里，手臂的底子是上面垂下 / 背手插值出来的，手和手指的底子是静止姿势
  type QMap = Map<VRMHumanBoneName, Three.Quaternion>;
  const toQ = (m: Partial<Record<VRMHumanBoneName, Euler3>>): QMap =>
    new Map((Object.entries(m) as [VRMHumanBoneName, Euler3][]).map(([b, e]) => [b, q(e)]));
  let peaceQ = toQ(HAND_POSES.peace);
  let waveAQ = toQ(HAND_POSES.waveA);
  let waveBQ = toQ(HAND_POSES.waveB);
  let labPoses = "";
  const handBones = [...new Set([...peaceQ.keys(), ...waveAQ.keys(), ...waveBQ.keys()])].map((b) => ({
    bone: b,
    node: node(b),
    arm: b in ARMS_DOWN,
  }));
  const waveQ: QMap = new Map(handBones.map((h) => [h.bone, new THREE.Quaternion()]));
  const ident = new THREE.Quaternion();
  // 右臂两节的长度和静止方向：取归一化骨骼的局部位置（归一化骨骼静止时朝向和模型对齐，局部位置就是上一节到这一节的偏移）；
  // 量不到（单元测试的假模型）用琪叶桃的数
  const uaNode = node("rightUpperArm");
  const laNode = node("rightLowerArm");
  const handNode = node("rightHand");
  let UPPER = 0.2198;
  let FORE = 0.2147;
  const REST_U = new THREE.Vector3(-1, 0, 0);
  const REST_F = new THREE.Vector3(-1, 0, 0);
  if (laNode && handNode) {
    const lu = laNode.position.length();
    const lf = handNode.position.length();
    if (lu > 0.1 && lu < 0.45 && lf > 0.1 && lf < 0.45) {
      UPPER = lu;
      FORE = lf;
      REST_U.copy(laNode.position).normalize();
      REST_F.copy(handNode.position).normalize();
    }
  }
  const OUT = REST_U.x < 0 ? -1 : 1; // 右臂朝外是哪一边
  /** 正向：上臂、小臂的局部旋转 → 手肘方向（单位向量）和手腕位置（相对肩关节，在上臂父节点的坐标里） */
  const fk = (qu: Three.Quaternion, ql: Three.Quaternion, wrist: Three.Vector3, elbowDir: Three.Vector3) => {
    elbowDir.copy(REST_U).applyQuaternion(qu);
    wrist.copy(REST_F).applyQuaternion(ql).applyQuaternion(qu).multiplyScalar(FORE).addScaledVector(elbowDir, UPPER);
  };
  const qUB = new THREE.Quaternion();
  const qLB = new THREE.Quaternion();
  const qUT = new THREE.Quaternion();
  const qLT = new THREE.Quaternion();
  const qU = new THREE.Quaternion();
  const qL = new THREE.Quaternion();
  const qSw = new THREE.Quaternion();
  const qInv = new THREE.Quaternion();
  const baseW = new THREE.Vector3();
  const baseE = new THREE.Vector3();
  const tW = new THREE.Vector3();
  const tE = new THREE.Vector3();
  const curW = new THREE.Vector3();
  const curE = new THREE.Vector3();
  const c1 = new THREE.Vector3();
  const c2 = new THREE.Vector3();
  const poleV = new THREE.Vector3();
  const pref = new THREE.Vector3();
  const pathP = new THREE.Vector3();
  const dn = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const elbowP = new THREE.Vector3();
  const fCur = new THREE.Vector3();
  const fReq = new THREE.Vector3();
  /**
   * 手腕要到 p（相对肩关节）：手肘取离 prefDir 最近的那个可行位置，写进 elbowP；够不着时手臂伸直朝 p。返回手腕实际离肩多远。
   * 和试验台上反算用的是同一个算法
   */
  const solveElbow = (p: Three.Vector3, prefDir: Three.Vector3): number => {
    const len = Math.min(Math.max(p.length(), 1e-4), UPPER + FORE - 1e-4);
    dn.copy(p).normalize();
    const a = (UPPER * UPPER - FORE * FORE + len * len) / (2 * len);
    const r = Math.sqrt(Math.max(0, UPPER * UPPER - a * a));
    perp.copy(prefDir).addScaledVector(dn, -prefDir.dot(dn));
    if (perp.lengthSq() < 1e-10) {
      perp.set(0, Math.abs(dn.y) > 0.9 ? 0 : -1, Math.abs(dn.y) > 0.9 ? 1 : 0);
      perp.addScaledVector(dn, -perp.dot(dn));
    }
    perp.normalize();
    elbowP.copy(dn).multiplyScalar(a).addScaledVector(perp, r);
    return len;
  };

  // three-vrm 的 lookAt 默认每帧自己朝 target 转；这里关掉，直接写导演层给的角度（结果确定，不用知道相机在哪）
  if (vrm.lookAt) {
    vrm.lookAt.autoUpdate = false;
    vrm.lookAt.target = null;
  }

  const apply = (f: AvatarFrame) => {
    if (em) for (const k of FACE_KEYS) if (names[k]) em.setValue(names[k], f.face[k]);
    blush?.(f.face.blush);
    for (const [b, n] of bones) {
      const e = f.bones[b];
      if (n) n.quaternion.setFromEuler(euler.set(e[0], e[1], e[2]));
    }
    const w = f.armsBack <= 0 ? 0 : f.armsBack >= 1 ? 1 : f.armsBack;
    for (const a of arms) a.node?.quaternion.slerpQuaternions(a.down, a.back, w);
    // 举手：手和手指按权重从静止姿势转到比耶或挥手；两节手臂让手腕沿弧线走、每帧反算（见 HAND_PATH）。挥手在两个位置之间按时间来回摆
    if (opts.poses) {
      const o = opts.poses();
      const key = o ? JSON.stringify(o) : "";
      if (key !== labPoses) {
        labPoses = key;
        peaceQ = toQ({ ...HAND_POSES.peace, ...o?.peace });
        waveAQ = toQ({ ...HAND_POSES.waveA, ...o?.waveA });
        waveBQ = toQ({ ...HAND_POSES.waveB, ...o?.waveB });
      }
    }
    const hw = f.hand.w <= 0 ? 0 : f.hand.w >= 1 ? 1 : f.hand.w;
    const pose = hw > 0 ? f.hand.pose : "";
    const ph = f.hand.phase ?? f.hand.t;
    const s = pose === "wave" ? 0.5 + 0.5 * Math.sin((2 * Math.PI * WAVE_HZ * ph) / 1000) : 0;
    let fingers: QMap | null = null;
    if (pose === "peace") fingers = peaceQ;
    else if (pose === "wave") {
      for (const h of handBones) {
        const qa = waveAQ.get(h.bone);
        const qb = waveBQ.get(h.bone);
        if (qa && qb) waveQ.get(h.bone)?.slerpQuaternions(qa, qb, s);
      }
      fingers = waveQ;
    }
    for (const h of handBones) {
      if (!h.node || h.arm) continue;
      if (!fingers)
        h.node.quaternion.identity(); // 手和手指回到静止姿势
      else h.node.quaternion.slerpQuaternions(ident, fingers.get(h.bone) ?? ident, hw);
    }
    if (pose && uaNode && laNode) {
      // 两节手臂：先从底子（这一帧垂下 / 背手插值出来的）各自插值到目标——扭转、手心朝向都从这里来，所以举到位时和试验台调的一模一样；
      // 再把手腕挪到绕开身体的弧线上（见 HAND_PATH）：上臂只摆不扭，把手肘摆到反算出的位置；小臂同样只摆，指向弧线上的手腕。
      // 两头（权重 0、1）插值出来的手腕本来就在弧线端点上，挪动量是 0，所以和底子、目标都严丝合缝
      qUB.copy(uaNode.quaternion);
      qLB.copy(laNode.quaternion);
      const tq = pose === "peace" ? peaceQ : waveQ;
      qUT.copy(tq.get("rightUpperArm") ?? ident);
      qLT.copy(tq.get("rightLowerArm") ?? ident);
      qU.slerpQuaternions(qUB, qUT, hw);
      qL.slerpQuaternions(qLB, qLT, hw);
      if (hw < 1) {
        fk(qUB, qLB, baseW, baseE);
        fk(qUT, qLT, tW, tE);
        fk(qU, qL, curW, curE);
        // 路线：三次贝塞尔（见 HAND_PATH）；试验台可以每帧换参数
        const P = opts.path ? { ...HAND_PATH, ...opts.path() } : HAND_PATH;
        const inward = -OUT;
        c1.set(baseW.x + P.lead[0] * inward, baseW.y + P.lead[1], baseW.z + P.lead[2]);
        c2.set(tW.x + P.settle[0] * inward, tW.y + P.settle[1], tW.z + P.settle[2]);
        const u = 1 - hw;
        pathP
          .copy(baseW)
          .multiplyScalar(u * u * u)
          .addScaledVector(c1, 3 * u * u * hw)
          .addScaledVector(c2, 3 * u * hw * hw)
          .addScaledVector(tW, hw * hw * hw);
        poleV.set(P.pole[0] * inward, P.pole[1], P.pole[2]);
        if (poleV.lengthSq() > 1e-8) poleV.normalize();
        pref.copy(curE).addScaledVector(poleV, 4 * hw * u * P.poleK);
        if (pref.lengthSq() < 1e-8) pref.copy(curE);
        const len = solveElbow(pathP, pref.normalize());
        qSw.setFromUnitVectors(curE, fReq.copy(elbowP).normalize());
        qU.premultiply(qSw);
        qInv.copy(qU).invert();
        fCur.copy(REST_F).applyQuaternion(qL);
        fReq.copy(dn).multiplyScalar(len).sub(elbowP).normalize().applyQuaternion(qInv);
        qSw.setFromUnitVectors(fCur, fReq);
        qL.premultiply(qSw);
      }
      uaNode.quaternion.copy(qU);
      laNode.quaternion.copy(qL);
    }
    if (vrm.lookAt) {
      vrm.lookAt.yaw = f.look.yaw;
      vrm.lookAt.pitch = f.look.pitch;
    }
  };

  const debug = (pose?: Record<string, Euler3>, face?: Partial<Record<FaceKey, number>>) => {
    if (pose) for (const [b, e] of Object.entries(pose)) node(b as VRMHumanBoneName)?.quaternion.setFromEuler(euler.set(e[0], e[1], e[2]));
    if (face)
      for (const [k, v] of Object.entries(face) as [FaceKey, number][]) {
        if (k === "blush") blush?.(v);
        else if (em && names[k]) em.setValue(names[k], v);
      }
  };

  return {
    apply,
    debug,
    missing,
    reset() {
      if (em) for (const k of FACE_KEYS) if (names[k]) em.setValue(names[k], 0);
      blush?.(0);
      for (const [, n] of bones) n?.quaternion.identity();
      for (const a of arms) a.node?.quaternion.copy(a.down);
      for (const h of handBones) if (!h.arm) h.node?.quaternion.identity();
      if (vrm.lookAt) {
        vrm.lookAt.yaw = 0;
        vrm.lookAt.pitch = 0;
      }
      vrm.springBoneManager?.reset();
    },
  };
}
