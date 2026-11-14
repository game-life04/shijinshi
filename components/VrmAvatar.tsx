"use client";

// 琪叶桃的 3D 形象（VRM）。three.js 和 three-vrm 在组件挂载后才动态加载，页面先出来、模型后到（规格 R12 懒加载）。
// 自己不跑动画循环：订阅舞台（lib/client/avatar/stage.ts），每帧拿导演层算好的一帧，用驱动层写进模型（表情、骨骼、视线），
// 接着在同一个回调里 vrm.update + 渲染——截断那一帧口型已经是 0，画出来的嘴就是闭着的（ADR-033）。
// 取景：bust 是月洞窗里的胸像（工作台、三种结局）；stage 是闯关页的舞台，画布竖着时到腰、横着时到胸。
// 模型文件不存在、浏览器不支持 WebGL、加载失败时，交给外层换成平面示意形象，并说明原因。

import { useEffect, useRef } from "react";
import type { AvatarStage } from "@/lib/client/avatar/stage";
import { newFrame } from "@/lib/client/avatar/types";
import { createVrmDriver } from "@/lib/client/avatar/vrm-driver";
import { seeThroughBangs } from "@/lib/client/vrm-see-through";

export type Framing = "bust" | "stage";

export interface VrmAvatarProps {
  url: string;
  stage: AvatarStage;
  framing?: Framing;
  onFail: (reason: string) => void;
  onLoaded?: () => void;
}

/** 试验台（只在 ?avatarTest=1 时读）：摆骨骼、改表情、挪脸红的位置（ADR-048） */
interface VrmLab {
  pose?: Record<string, [number, number, number]>;
  face?: Record<string, number>;
  blush?: Record<string, number>;
  /** 举手过渡的路线参数（每帧读，试验台上调路线用；见 vrm-driver 的 HAND_PATH） */
  path?: { lead?: [number, number, number]; settle?: [number, number, number]; pole?: [number, number, number]; poleK?: number };
  /** 手的姿势（每帧读；peace / waveA / waveB → 骨骼名 → 弧度，覆盖 HAND_POSES） */
  poses?: Record<string, Record<string, [number, number, number]>>;
  /** 盖掉导演层这一帧的手、手臂（举手过渡逐帧截图用：指定权重和挥手的时刻，看袖子出不出画面） */
  frame?: { armsBack?: number; hand?: { pose: "peace" | "wave" | ""; w: number; t: number } };
}
/** 试验台的探针（只在 ?avatarTest=1 时有，深度测试用）：几根骨骼在画面上的位置（画布里的 CSS 像素）、驱动层每帧耗时、显存里的东西 */
export interface VrmProbe {
  w: number;
  h: number;
  bones: Record<string, { x: number; y: number; inFrame: boolean }>;
  /** 最近 120 帧驱动层（写表情、骨骼、视线、手、脸红）平均每帧几毫秒 */
  applyMs: number;
  fps: number;
  memory: { geometries: number; textures: number };
}
const NO_HAND = { pose: "" as const, w: 0, t: 0 };
declare global {
  interface Window {
    __vrmLab?: VrmLab;
    __vrmProbe?: () => VrmProbe;
  }
}

/** 量出来的几处高度（米）：头发顶比头骨高约 0.23（主视觉试验量过） */
const HAIR_ABOVE_HEAD = 0.25;

export default function VrmAvatar({ url, stage, framing = "bust", onFail, onLoaded }: VrmAvatarProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const failRef = useRef(onFail);
  const loadedRef = useRef(onLoaded);
  const framingRef = useRef(framing);
  failRef.current = onFail;
  loadedRef.current = onLoaded;
  framingRef.current = framing;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup = () => {};

    (async () => {
      const probe = document.createElement("canvas");
      if (!probe.getContext("webgl2") && !probe.getContext("webgl")) return failRef.current("浏览器不支持 WebGL");
      const head = await fetch(url, { method: "HEAD" }).catch(() => null);
      if (!head?.ok) return failRef.current("还没有放入 VRM 模型文件");

      const THREE = await import("three");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const { VRMLoaderPlugin, VRMUtils } = await import("@pixiv/three-vrm");
      if (disposed) return;

      // 带模板缓冲：眼睛透过刘海要用（lib/client/vrm-see-through.ts）
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
      renderer.setClearColor(0x000000, 0);
      host.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
      const light = new THREE.DirectionalLight(0xffffff, Math.PI);
      light.position.set(1, 1.5, 2).normalize();
      scene.add(light, new THREE.AmbientLight(0xffffff, 0.6));

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      let gltf: Awaited<ReturnType<typeof loader.loadAsync>>;
      try {
        gltf = await loader.loadAsync(url);
      } catch (e) {
        renderer.dispose();
        renderer.domElement.remove();
        return failRef.current(`模型加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (disposed) {
        renderer.dispose();
        renderer.domElement.remove();
        return;
      }
      const vrm = gltf.userData.vrm as import("@pixiv/three-vrm").VRM | undefined;
      if (!vrm) {
        renderer.dispose();
        renderer.domElement.remove();
        return failRef.current("文件不是 VRM 模型");
      }
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);
      // 刘海搭在眼睛上的地方，眼睛隔着头发淡淡透出来（ADR-030）
      seeThroughBangs(THREE, renderer, vrm.scene);

      // 驱动层：通道对到模型的表情；先摆成静止姿势（手臂放下）再量高度、定镜头
      const lab = new URLSearchParams(window.location.search).get("avatarTest") === "1";
      const applyTimes: number[] = [];
      const driver = createVrmDriver(
        THREE,
        vrm,
        lab
          ? {
              blush: window.__vrmLab?.blush,
              path: () => window.__vrmLab?.path,
              // biome-ignore lint/suspicious/noExplicitAny: 试验台的覆盖只在测试模式下用，键名由驱动层自己核对
              poses: () => window.__vrmLab?.poses as any,
            }
          : {},
      );
      driver.apply(newFrame());
      vrm.update(0);
      const bone = (name: "head" | "hips") => vrm.humanoid?.getNormalizedBoneNode(name) ?? vrm.scene;
      const headPos = new THREE.Vector3();
      const hipsPos = new THREE.Vector3();
      bone("head").getWorldPosition(headPos);
      bone("hips").getWorldPosition(hipsPos);

      // 像素比：按画布大小定初值（半身舞台画布大，像素多），跑起来以后帧率不够就往下降，最低 1
      let dpr = 1;
      // 镜头定好的位置和看向的点；说漏嘴时沿视线往前推一点（导演层给的 zoom）
      const camBase = new THREE.Vector3();
      const camTarget = new THREE.Vector3();
      let zoomNow = 0;
      let dprCeil = 2; // 只降不升
      // 很矮的长条舞台（手机键盘弹起、小窗口，舞台不到 140 像素高）：不画举手——比耶、挥手只有几个像素，大袖子却扫过一大片（11-14 深度测试）。
      // 脸上的眨眼、歪头、脸红照旧
      let tinyStage = false;
      const frame = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        const aspect = w / h;
        camera.aspect = aspect;
        tinyStage = framingRef.current === "stage" && h < 140;
        if (framingRef.current === "stage") {
          // 竖着的画布到腰带，方一点的到胸口，横着的只到肩（脸要够大，表情才看得清）
          const top = headPos.y + HAIR_ABOVE_HEAD;
          const bottom = aspect < 0.85 ? hipsPos.y + 0.24 : aspect < 1.25 ? headPos.y - 0.48 : headPos.y - 0.32;
          const half = (top - bottom) / 2;
          const vfov = (camera.fov * Math.PI) / 180;
          let dist = half / Math.tan(vfov / 2);
          // 横向也要装得下（喇叭袖展开约 0.7 米宽）：方一点的画布原来只留 0.6 米，横屏手机上举手时袖子被画面左边切掉（11-14 深度测试）
          const width = aspect < 1.25 ? 0.72 : 0.6;
          const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
          dist = Math.max(dist, width / 2 / Math.tan(hfov / 2));
          const cy = (top + bottom) / 2;
          camBase.set(0, cy + 0.03, headPos.z + dist);
          // 推近时对着脸推（看向点抬到下巴附近），不是对着画面中心
          camTarget.set(0, cy, headPos.z);
        } else {
          camBase.set(0, headPos.y + 0.02, headPos.z + 1.2);
          camTarget.set(0, headPos.y - 0.04, headPos.z);
        }
        camera.position.copy(camBase);
        camera.lookAt(camTarget);
        zoomNow = 0;
        camera.updateProjectionMatrix();
        const cap = framingRef.current === "stage" ? Math.sqrt(1.6e6 / (w * h)) : 2;
        dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, dprCeil, cap));
        renderer.setPixelRatio(dpr);
        renderer.setSize(w, h, false);
      };
      const ro = new ResizeObserver(frame);
      ro.observe(host);
      frame();

      // 先在后台把材质的着色器编译好再放进画面：否则第一帧要同步编译，主线程卡住，
      // 刚好赶上第一轮说话时会把首声一起拖慢（10-27 实测：模型还在加载时，第一轮首声多等 1～2 秒）
      await renderer.compileAsync(vrm.scene, camera, scene).catch(() => {});
      if (disposed) {
        ro.disconnect();
        VRMUtils.deepDispose(vrm.scene);
        renderer.dispose();
        renderer.domElement.remove();
        return;
      }
      scene.add(vrm.scene);

      // 不在视口里（手机上滚走了、切到别的页签）就不更新也不渲染
      let visible = true;
      const io = new IntersectionObserver((es) => {
        visible = es.some((e) => e.isIntersecting);
      });
      io.observe(host);

      const started = performance.now();
      let frames = 0;
      let fpsT = 0;
      const unsubscribe = stage.subscribe((f0, dtMs) => {
        if (!visible) return;
        const f = tinyStage && f0.hand.w > 0 ? { ...f0, hand: NO_HAND } : f0;
        if (lab) {
          const o = window.__vrmLab?.frame;
          const g = o ? { ...f, armsBack: o.armsBack ?? f.armsBack, hand: o.hand ?? f.hand } : f;
          const a0 = performance.now();
          driver.apply(g);
          applyTimes.push(performance.now() - a0);
          if (applyTimes.length > 120) applyTimes.shift();
        } else driver.apply(f);
        if (lab && window.__vrmLab) driver.debug(window.__vrmLab.pose, window.__vrmLab.face);
        if (framingRef.current === "stage" && f.zoom !== zoomNow) {
          zoomNow = f.zoom;
          camera.position.lerpVectors(camBase, camTarget, zoomNow);
          camera.position.y += (headPos.y - camTarget.y) * zoomNow * 0.6;
        }
        // 弹簧骨骼一步最多走 1/30 秒（页面卡一下也不会把头发甩飞）
        vrm.update(Math.min(dtMs / 1000, 1 / 30));
        renderer.render(scene, camera);
        frames++;
        fpsT += dtMs;
        if (fpsT >= 1500) {
          const fps = (frames * 1000) / fpsT;
          host.dataset.fps = String(Math.round(fps));
          // 前 2.5 秒不算（编译着色器、上传贴图）；之后帧率低于 45 就把像素比降 0.25
          if (performance.now() - started > 2500 && fps < 45 && dpr > 1) {
            dprCeil = Math.max(1, dpr - 0.25);
            dpr = dprCeil;
            renderer.setPixelRatio(dpr);
            renderer.setSize(host.clientWidth || 1, host.clientHeight || 1, false);
          }
          frames = 0;
          fpsT = 0;
        }
      });
      if (lab) {
        const v3 = new THREE.Vector3();
        const names = [
          "head",
          "leftEye",
          "rightEye",
          "rightHand",
          "rightIndexDistal",
          "rightMiddleDistal",
          "rightLowerArm",
          "rightUpperArm",
          "leftHand",
        ] as const;
        window.__vrmProbe = () => {
          const w = host.clientWidth || 1;
          const h = host.clientHeight || 1;
          const bones: VrmProbe["bones"] = {};
          for (const n of names) {
            const node = vrm.humanoid?.getRawBoneNode(n);
            if (!node) continue;
            node.getWorldPosition(v3).project(camera);
            bones[n] = { x: ((v3.x + 1) / 2) * w, y: ((1 - v3.y) / 2) * h, inFrame: Math.abs(v3.x) <= 1 && Math.abs(v3.y) <= 1 };
          }
          const applyMs = applyTimes.length ? applyTimes.reduce((s, x) => s + x, 0) / applyTimes.length : 0;
          return { w, h, bones, applyMs, fps: Number(host.dataset.fps || 0), memory: { ...renderer.info.memory } };
        };
      }
      host.dataset.vrm = "loaded";
      loadedRef.current?.();

      cleanup = () => {
        if (lab) window.__vrmProbe = undefined;
        unsubscribe();
        io.disconnect();
        ro.disconnect();
        VRMUtils.deepDispose(vrm.scene);
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch((e) => failRef.current(`3D 形象出错：${e instanceof Error ? e.message : String(e)}`));

    return () => {
      disposed = true;
      cleanup();
    };
  }, [url, stage]);

  return <div ref={hostRef} className="h-full w-full" role="img" aria-label="琪叶桃 3D 形象" data-framing={framing} />;
}
