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
      const driver = createVrmDriver(THREE, vrm);
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
      const frame = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        const aspect = w / h;
        camera.aspect = aspect;
        if (framingRef.current === "stage") {
          // 竖着的画布到腰带，方一点的到胸口，横着的只到肩（脸要够大，表情才看得清）
          const top = headPos.y + HAIR_ABOVE_HEAD;
          const bottom = aspect < 0.85 ? hipsPos.y + 0.24 : aspect < 1.25 ? headPos.y - 0.48 : headPos.y - 0.32;
          const half = (top - bottom) / 2;
          const vfov = (camera.fov * Math.PI) / 180;
          let dist = half / Math.tan(vfov / 2);
          // 横向也要装得下（喇叭袖展开约 0.7 米宽）
          const width = aspect < 0.85 ? 0.72 : 0.6;
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
      const unsubscribe = stage.subscribe((f, dtMs) => {
        if (!visible) return;
        driver.apply(f);
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
      host.dataset.vrm = "loaded";
      loadedRef.current?.();

      cleanup = () => {
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
