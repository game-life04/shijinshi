"use client";

// 琪叶桃的 3D 形象（VRM）。three.js 和 three-vrm 在组件挂载后才动态加载，工作台先出来、模型后到（规格 R12 懒加载）。
// 每帧读一次口型（播放器按实际渲染的响度给出 0～1），驱动「aa」表情；被截断时口型当帧归零。
// 模型文件不存在、浏览器不支持 WebGL、加载失败时，交给外层换成平面示意形象，并说明原因。

import { useEffect, useRef } from "react";
import type { Expression } from "./FaceAvatar";

export interface VrmAvatarProps {
  url: string;
  mouth: () => number;
  expression: Expression;
  onFail: (reason: string) => void;
  onLoaded?: () => void;
}

export default function VrmAvatar({ url, mouth, expression, onFail, onLoaded }: VrmAvatarProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mouthRef = useRef(mouth);
  const exprRef = useRef(expression);
  const failRef = useRef(onFail);
  const loadedRef = useRef(onLoaded);
  mouthRef.current = mouth;
  exprRef.current = expression;
  failRef.current = onFail;
  loadedRef.current = onLoaded;

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

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      host.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
      const light = new THREE.DirectionalLight(0xffffff, Math.PI);
      light.position.set(1, 1.5, 2).normalize();
      scene.add(light, new THREE.AmbientLight(0xffffff, 0.6));

      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      resize();

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      let gltf: Awaited<ReturnType<typeof loader.loadAsync>>;
      try {
        gltf = await loader.loadAsync(url);
      } catch (e) {
        ro.disconnect();
        renderer.dispose();
        renderer.domElement.remove();
        return failRef.current(`模型加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
      if (disposed) {
        renderer.dispose();
        return;
      }
      const vrm = gltf.userData.vrm as import("@pixiv/three-vrm").VRM | undefined;
      if (!vrm) {
        ro.disconnect();
        renderer.dispose();
        renderer.domElement.remove();
        return failRef.current("文件不是 VRM 模型");
      }
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.combineSkeletons(gltf.scene);
      VRMUtils.rotateVRM0(vrm);
      scene.add(vrm.scene);

      // 放下手臂（默认是 T 字姿势），镜头对准胸口以上
      const bone = (name: Parameters<NonNullable<typeof vrm.humanoid>["getNormalizedBoneNode"]>[0]) =>
        vrm.humanoid?.getNormalizedBoneNode(name) ?? null;
      const lArm = bone("leftUpperArm");
      const rArm = bone("rightUpperArm");
      if (lArm) lArm.rotation.z = -1.2;
      if (rArm) rArm.rotation.z = 1.2;
      vrm.update(0);
      const headPos = new THREE.Vector3();
      (bone("head") ?? vrm.scene).getWorldPosition(headPos);
      camera.position.set(0, headPos.y + 0.02, headPos.z + 1.2);
      camera.lookAt(0, headPos.y - 0.04, headPos.z);

      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const clock = new THREE.Clock();
      const spine = bone("spine");
      const neck = bone("neck");
      let nextBlink = 2 + Math.random() * 3;
      let frames = 0;
      let fpsT = 0;
      let raf = 0;
      const em = vrm.expressionManager;
      const loop = () => {
        const dt = clock.getDelta();
        const t = clock.elapsedTime;
        const open = mouthRef.current();
        em?.setValue("aa", open);
        // 眨眼
        let blink = 0;
        if (!reduce && t > nextBlink) {
          const p = (t - nextBlink) / 0.15;
          blink = p < 1 ? Math.sin(p * Math.PI) : 0;
          if (p >= 1) nextBlink = t + 2.5 + Math.random() * 3;
        }
        em?.setValue("blink", blink);
        const confused = exprRef.current === "confused";
        em?.setValue("surprised", confused ? 0.5 : 0);
        if (!reduce) {
          if (spine) spine.rotation.x = Math.sin(t * 1.4) * 0.015;
          if (neck) neck.rotation.z = confused ? 0.12 : Math.sin(t * 0.7) * 0.02;
        }
        vrm.update(dt);
        renderer.render(scene, camera);
        frames++;
        fpsT += dt;
        if (fpsT >= 1) {
          host.dataset.fps = String(Math.round(frames / fpsT));
          frames = 0;
          fpsT = 0;
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
      host.dataset.vrm = "loaded";
      loadedRef.current?.();

      cleanup = () => {
        cancelAnimationFrame(raf);
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
  }, [url]);

  return <div ref={hostRef} className="h-full w-full" role="img" aria-label="琪叶桃 3D 形象" />;
}
