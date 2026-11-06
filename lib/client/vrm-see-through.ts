// 眼睛透过刘海（ADR-030）：刘海照常垂下来盖在眼睛上，盖住的地方把眼睛再淡淡画一层在头发上面，隔着头发也看得见眼睛
// （插画里常见的画法，主视觉小样第八轮定的）。用模板缓冲做，渲染器要开 stencil，分三步：
// 1. 不透明的东西画完、头发还没画的时候，把眼白再画一遍（不出颜色），露出来的地方记上 1，被眼皮盖住的地方不记；
// 2. 头发画到的地方记上 2，头发的墨线再把 2 擦掉（墨线还压在眼睛上面）；
// 3. 最后把眼白、瞳孔、高光、眼线、睫毛按原来的先后再画一遍，不比前后：眼白、瞳孔、高光只画在 1 和 2 都有的地方，
//    眼线、睫毛长在脸上，除了头发没有东西挡，只看 2；都是半透明的。
// 多画的这几份和原来的共用顶点、骨骼、表情权重，材质的贴图、颜色也共用，只有透明度自己管。
// three.js 是懒加载的（规格 R12），这里只用它的类型，命名空间由调用方传进来。

import type * as Three from "three";

type MToonLike = Three.ShaderMaterial & { isOutline?: boolean };

const OPACITY = { eye: 0.75, line: 0.85 };
const PARTS: [RegExp, keyof typeof OPACITY][] = [
  [/EyeWhite/, "eye"],
  [/EyeIris/, "eye"],
  [/EyeHighlight/, "eye"],
  [/FaceEyeline/, "line"],
  [/FaceEyelash/, "line"],
];

const firstMaterial = (o: Three.Mesh) => (Array.isArray(o.material) ? o.material[0] : o.material) as MToonLike;

/** 复制一份材质：除了透明度和透明裁切，uniforms 和原来的共用 */
function ghostMaterial(src: MToonLike, opts: Partial<Three.Material>) {
  const m = src.clone() as MToonLike;
  for (const k of Object.keys(src.uniforms)) if (k !== "opacity" && k !== "alphaTest") m.uniforms[k] = src.uniforms[k];
  return Object.assign(m, opts);
}

/** 同一份网格再挂一个：共用顶点、骨骼和表情权重（表情写在原来那份上，这里跟着变） */
function ghostMesh(THREE: typeof Three, src: Three.SkinnedMesh, mat: Three.Material, order: number) {
  const g = new THREE.SkinnedMesh(src.geometry, mat);
  g.bind(src.skeleton, src.bindMatrix);
  g.bindMode = src.bindMode;
  g.morphTargetInfluences = src.morphTargetInfluences;
  g.morphTargetDictionary = src.morphTargetDictionary;
  g.position.copy(src.position);
  g.quaternion.copy(src.quaternion);
  g.scale.copy(src.scale);
  g.renderOrder = order;
  g.frustumCulled = false;
  src.parent?.add(g);
  return g;
}

/** 在加进画面、编译着色器之前调用。渲染器没有模板缓冲时什么也不做（不然眼睛会画到眼皮外面），返回是否生效 */
export function seeThroughBangs(THREE: typeof Three, renderer: Three.WebGLRenderer, root: Three.Object3D) {
  if (!renderer.getContext().getContextAttributes()?.stencil) return false;
  const meshes: Three.Mesh[] = [];
  root.traverse((o) => {
    if ((o as Three.Mesh).isMesh) meshes.push(o as Three.Mesh);
  });
  const find = (re: RegExp) =>
    meshes.find((o) => (o as Three.SkinnedMesh).isSkinnedMesh && re.test(firstMaterial(o).name)) as Three.SkinnedMesh;
  const white = find(/EyeWhite/);
  const hair = meshes.filter((o) => [o.material].flat().some((m) => /_HAIR/.test(m.name)));
  if (!white || !hair.length || PARTS.some(([re]) => !find(re))) return false;

  // 不透明的东西按 renderOrder 排先后：眼白记号排在其余不透明的东西后面，头发再往后
  const top = Math.max(...meshes.filter((o) => ![o.material].flat().some((m) => m.transparent)).map((o) => o.renderOrder));
  const mark = { stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp };
  ghostMesh(
    THREE,
    white,
    ghostMaterial(firstMaterial(white), { ...mark, colorWrite: false, depthWrite: false, stencilRef: 1, stencilWriteMask: 1 }),
    top + 1,
  );
  for (const o of hair) {
    o.renderOrder = top + 2;
    for (const m of [o.material].flat() as MToonLike[]) Object.assign(m, mark, { stencilRef: m.isOutline ? 0 : 2, stencilWriteMask: 2 });
  }
  PARTS.forEach(([re, kind], k) => {
    const src = find(re);
    const ref = kind === "eye" ? 3 : 2;
    const m = ghostMaterial(firstMaterial(src), {
      transparent: true,
      depthTest: false,
      depthWrite: false,
      alphaTest: 0,
      opacity: OPACITY[kind],
      stencilWrite: true,
      stencilWriteMask: 0,
      stencilFunc: THREE.EqualStencilFunc,
      stencilRef: ref,
      stencilFuncMask: ref,
      stencilFail: THREE.KeepStencilOp,
      stencilZFail: THREE.KeepStencilOp,
      stencilZPass: THREE.KeepStencilOp,
    });
    m.uniforms.opacity.value = OPACITY[kind]; // MToon 平时每帧把 opacity 抄进 uniform，这份不在 VRM 的材质表里，自己设
    ghostMesh(THREE, src, m, 1000 + k);
  });
  return true;
}
