// 把琪叶桃改成主视觉里定下的样子（2026-11-06，ADR-030）：
// - 白发：前发、后发的贴图按明暗换成白到灰蓝的色带（亮面、暗面各一张）；头顶天使环改成偏冷的白；前发、后发加一圈墨线；眉毛换成浅色；
// - 眼睛：圆瞳孔和新高光、加粗加深的上眼线（贴图在本机 Edge 里画，画法见 scripts/restyle-painters.js）；
//   眼白、瞳孔、眼线、睫毛、眉毛连同眼睛周围的皮肤往鼻梁收 4.5 毫米，瞳孔、高光两层放大 1.12 倍；
// - 刘海正中那一缕（J_Sec_Hair1_05）的静止方向往她右边摆 0.12 弧度，发梢指向两眼中间。
// 骨骼结构、蒙皮、表情变形都不动；眼睛透过刘海那一层是画的时候做的（components/VrmAvatar.tsx），不在模型里。
// 输入用 VRoid 原始导出版（贴图是 PNG），改完再压一遍：
//   npx tsx scripts/restyle-vrm.mts 原始导出版.vrm 白发版.vrm [--thumb 缩略图.png]
//   python -I scripts/shrink-vrm.py 白发版.vrm public/models/qiyetao.vrm

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import * as THREE from "three";

// 和主视觉小样第八轮的参数一样（颜色是 sRGB；材质系数是线性的）
const STYLE = {
  iris: {
    size: 1,
    stops: [
      [0, "#ffe6a6"],
      [0.2, "#ffb84c"],
      [0.42, "#f27c2e"],
      [0.62, "#bd3b1d"],
      [0.82, "#5c170f"],
      [1, "#2a0907"],
    ],
    lid: "rgba(32,7,6,0.8)",
    lidDepth: 0.45,
    pupil: 0.34,
    pupilY: -0.05,
    pupilColor: "#1b0605",
    collar: "rgba(255,150,70,0.45)",
    rim: "rgba(255,236,172,0.85)",
    ring: "rgba(34,8,6,0.95)",
    halo: "rgba(60,16,10,0.35)",
    fibers: 90,
    glints: 7,
    glint: "rgba(255,228,160,0.9)",
  },
  catch: {
    size: 1,
    color: "#ffffff",
    main: [-0.34, -0.38, 0.3, 0.2, -0.45],
    small: [0.4, 0.42, 0.1],
    star: [0.38, -0.34, 0.17],
    dots: [
      [-0.2, 0.56, 0.035, 0.9],
      [0.13, 0.66, 0.028, 0.8],
      [-0.52, 0.22, 0.03, 0.7],
    ],
  },
  line: { cut: 0.46, up: 4, dark: 0.5, darkLow: 0.2, ink: [26, 12, 10] },
  lash: { cut: 1, up: 0, dark: 0.35, darkLow: 0, ink: [26, 12, 10] },
  hair: {
    range: [60, 105],
    lit: [
      [0, "#c9cde0"],
      [0.55, "#e6e8f2"],
      [1, "#f7f7fb"],
    ],
    shade: [
      [0, "#7f84a8"],
      [1, "#a4a9c8"],
    ],
    emissive: [0.224, 0.238, 0.294], // 天使环：偏冷的白（乘在原来的天使环贴图上）
    outline: { width: 0.0011, color: [0.2, 0.21, 0.3] }, // 世界坐标的宽度（米）；深蓝黑的线在白头发上太扎眼
  },
  brow: "#aaa6ba",
  eyeSqueeze: 0.0045,
  irisScale: 1.12,
  bang: { node: "J_Sec_Hair1_05", euler: [0, 0, -0.12] as [number, number, number] }, // 按脸的坐标（x 朝左耳、y 朝上、z 朝前）
};

interface TexRef {
  index: number;
  extensions?: Record<string, unknown>;
}
interface Material {
  name: string;
  pbrMetallicRoughness?: { baseColorTexture?: TexRef };
  emissiveFactor?: number[];
  extensions?: { VRMC_materials_mtoon?: Record<string, unknown> & { shadeMultiplyTexture?: TexRef } };
}
interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}
interface Gltf {
  materials: Material[];
  textures: { sampler?: number; source: number }[];
  images: { name?: string; mimeType?: string; bufferView: number }[];
  accessors: Accessor[];
  bufferViews: BufferView[];
  buffers: { byteLength: number }[];
  meshes: { name?: string; primitives: Primitive[] }[];
  nodes: { name?: string; rotation?: number[]; children?: number[] }[];
  extensions: { VRMC_vrm: { meta: { thumbnailImage?: number } } };
}

function readGlb(file: string): { gl: Gltf; bin: Uint8Array } {
  const data = readFileSync(file);
  if (data.toString("latin1", 0, 4) !== "glTF" || data.readUInt32LE(4) !== 2) throw new Error("不是 glTF 2.0 二进制文件");
  const chunks: Buffer[] = [];
  for (let off = 12; off < data.length; ) {
    const len = data.readUInt32LE(off);
    chunks.push(data.subarray(off + 8, off + 8 + len));
    off += 8 + len;
  }
  const bin = new Uint8Array(chunks[1].length); // 拷一份：下面要按 4 字节对齐的位置直接改顶点
  bin.set(chunks[1]);
  return { gl: JSON.parse(chunks[0].toString("utf8")), bin };
}

function writeGlb(file: string, gl: Gltf, bin: Uint8Array) {
  let json = Buffer.from(JSON.stringify(gl), "utf8");
  json = Buffer.concat([json, Buffer.alloc(-json.length & 3, 0x20)]);
  const body = Buffer.concat([Buffer.from(bin), Buffer.alloc(-bin.length & 3)]);
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "latin1");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + body.length, 8);
  const chunk = (len: number, type: string) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(len, 0);
    b.write(type, 4, "latin1");
    return b;
  };
  writeFileSync(file, Buffer.concat([head, chunk(json.length, "JSON"), json, chunk(body.length, "BIN\0"), body]));
}

const viewBytes = (gl: Gltf, bin: Uint8Array, v: number) => {
  const bv = gl.bufferViews[v];
  return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
};

/** 按顺序重排数据块：换掉的图换成新字节，新加的图接在最后；每块按 4 字节对齐。返回新加的数据块序号 */
function rebuildBin(gl: Gltf, bin: Uint8Array, replaced: Map<number, Uint8Array>, appended: Uint8Array[]) {
  const parts: Uint8Array[] = [];
  let off = 0;
  const place = (bytes: Uint8Array) => {
    const pad = -off & 3;
    if (pad) parts.push(new Uint8Array(pad));
    off += pad;
    parts.push(bytes);
    off += bytes.length;
    return off - bytes.length;
  };
  const old = gl.bufferViews.map((_, i) => replaced.get(i) ?? viewBytes(gl, bin, i));
  gl.bufferViews.forEach((bv, i) => {
    bv.byteOffset = place(old[i]);
    bv.byteLength = old[i].length;
  });
  const added = appended.map((bytes) => {
    gl.bufferViews.push({ buffer: 0, byteOffset: place(bytes), byteLength: bytes.length });
    return gl.bufferViews.length - 1;
  });
  const out = new Uint8Array(off);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  gl.buffers[0].byteLength = out.length;
  return { bin: out, added };
}

function indexSet(gl: Gltf, bin: Uint8Array, prim: Primitive) {
  const a = gl.accessors[prim.indices ?? -1];
  if (!a || a.sparse || a.bufferView === undefined) throw new Error("面没有序号数组，脚本不支持");
  const start = bin.byteOffset + (gl.bufferViews[a.bufferView].byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (a.componentType === 5125) return new Set<number>(new Uint32Array(bin.buffer, start, a.count));
  if (a.componentType === 5123) return new Set<number>(new Uint16Array(bin.buffer, start, a.count));
  return new Set<number>(new Uint8Array(bin.buffer, start, a.count));
}

function bbox(pos: Float32Array, set: Iterable<number>) {
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const i of set) if (pos[i * 3] > 0) b.expandByPoint(v.fromArray(pos, i * 3));
  return b;
}

/** 眼睛往鼻梁收、瞳孔放大（和主视觉小样 squeezeEyes 一样：每个点挪多少只看它在正面的上下左右位置，叠在一起的几层挪得一样） */
function squeezeEyes(gl: Gltf, bin: Uint8Array) {
  const isMat = (p: Primitive, re: RegExp) => p.material !== undefined && re.test(gl.materials[p.material].name);
  const face = gl.meshes.find((m) => m.primitives.some((p) => isMat(p, /EyeWhite/)));
  if (!face) throw new Error("找不到眼白所在的网格");
  const posAcc = face.primitives[0].attributes.POSITION;
  if (face.primitives.some((p) => p.attributes.POSITION !== posAcc)) throw new Error("脸的几层没有共用顶点，脚本不支持");
  const a = gl.accessors[posAcc];
  const bv = gl.bufferViews[a.bufferView ?? -1];
  if (a.componentType !== 5126 || a.type !== "VEC3" || a.sparse || (bv.byteStride ?? 12) !== 12) throw new Error("顶点格式不支持");
  const pos = new Float32Array(bin.buffer, bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * 3);
  const sets = (re: RegExp) => face.primitives.filter((p) => isMat(p, re)).map((p) => indexSet(gl, bin, p));
  const [white] = sets(/EyeWhite/);
  const iris = new Set([...sets(/EyeIris|EyeHighlight/).flatMap((s) => [...s])]);
  for (const s of sets(/^(?!.*(EyeIris|EyeHighlight)).*$/))
    for (const i of s) if (iris.has(i)) throw new Error("瞳孔和别的层共用顶点，不能单独放大");
  const eyeBox = bbox(pos, white); // 她左眼（x > 0）的眼白；右眼左右对称
  const eyeC = eyeBox.getCenter(new THREE.Vector3());
  const eyeHalf = eyeBox.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const irisC = bbox(pos, sets(/EyeIris/)[0]).getCenter(new THREE.Vector3());
  const ss = THREE.MathUtils.smoothstep;
  const s = STYLE.eyeSqueeze;
  const k = STYLE.irisScale;
  for (let i = 0; i < a.count; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const ax = Math.abs(x);
    const inIris = iris.has(i);
    const xs = inIris ? Math.sign(x) * (irisC.x + (ax - irisC.x) * k) : x;
    const ys = inIris ? irisC.y + (y - irisC.y) * k : y;
    const u = (ax - eyeC.x) / eyeHalf.x; // 眼白内角 -1、外角 +1
    const v = (y - eyeC.y - 0.01) / (eyeHalf.y * 2.2); // 往上包住眉毛
    const wx = u < 0 ? ss(ax, 0.002, 0.016) : 1 - ss(u, 1.15, 1.55); // 内侧到鼻梁中线减到零，外侧在脸的轮廓前减到零
    const wy = 1 - ss(Math.abs(v), 0.9, 1.6);
    const front = ss(z, 0.0, 0.03); // 只动脸的正面
    pos[i * 3] = xs - Math.sign(x) * s * wx * wy * front;
    pos[i * 3 + 1] = ys;
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], pos[i]);
    hi[i % 3] = Math.max(hi[i % 3], pos[i]);
  }
  a.min = lo;
  a.max = hi;
  return { vertices: a.count, iris: iris.size };
}

/** 刘海正中那一缕的静止方向：转角按脸的坐标给，换算到它父骨骼自己的坐标里再乘上去（和主视觉小样 partBangs 一样） */
function turnBang(gl: Gltf) {
  const parent = new Map<number, number>();
  gl.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) parent.set(c, i);
  });
  const ni = gl.nodes.findIndex((n) => n.name === STYLE.bang.node);
  const pi = parent.get(ni);
  if (ni < 0 || pi === undefined) throw new Error(`找不到骨骼 ${STYLE.bang.node}`);
  const chain: number[] = [];
  for (let k: number | undefined = pi; k !== undefined; k = parent.get(k)) chain.unshift(k);
  const wp = new THREE.Quaternion();
  for (const k of chain) wp.multiply(new THREE.Quaternion().fromArray(gl.nodes[k].rotation ?? [0, 0, 0, 1]));
  const rw = new THREE.Quaternion().setFromEuler(new THREE.Euler(...STYLE.bang.euler));
  const q0 = new THREE.Quaternion().fromArray(gl.nodes[ni].rotation ?? [0, 0, 0, 1]);
  gl.nodes[ni].rotation = wp.clone().invert().multiply(rw).multiply(wp).multiply(q0).normalize().toArray();
}

async function paintTextures(jobs: Record<string, Uint8Array>) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><meta charset='utf-8'><body></body>");
    await page.addScriptTag({ content: readFileSync(path.join("scripts", "restyle-painters.js"), "utf8") });
    const input = Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
    // 页面里要跑的都在 restyle-painters.js 里（这里只调一次：tsx 转译时会给内部函数加 __name，页面里没有这个函数）
    const out: Record<string, string> = await page.evaluate(
      // biome-ignore lint/suspicious/noExplicitAny: 画法挂在页面的全局对象上
      ([input, style]) => (globalThis as any).restylePainters.paintAll(input, style),
      [input, STYLE] as const,
    );
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, "base64"))]));
  } finally {
    await browser.close();
  }
}

async function main() {
  const [input, output] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--thumb");
  if (!input || !output) {
    console.log("用法：npx tsx scripts/restyle-vrm.mts 原始导出版.vrm 白发版.vrm [--thumb 缩略图.png]");
    process.exit(1);
  }
  const thumbArg = process.argv.includes("--thumb") ? process.argv[process.argv.indexOf("--thumb") + 1] : null;
  const { gl, bin } = readGlb(input);

  const mat = (re: RegExp) => {
    const i = gl.materials.findIndex((m) => re.test(m.name));
    if (i < 0) throw new Error(`找不到材质 ${re}`);
    return i;
  };
  const M = {
    iris: mat(/EyeIris/),
    catch: mat(/EyeHighlight/),
    line: mat(/FaceEyeline/),
    lash: mat(/FaceEyelash/),
    brow: mat(/FaceBrow/),
    hair: mat(/(^|_)Hair_00_HAIR/),
    hairBack: mat(/HairBack_00_HAIR/),
  };
  const baseTex = (mi: number) => {
    const t = gl.materials[mi].pbrMetallicRoughness?.baseColorTexture?.index;
    if (t === undefined) throw new Error(`${gl.materials[mi].name} 没有颜色贴图`);
    return t;
  };
  const imageOf = (mi: number) => {
    const im = gl.images[gl.textures[baseTex(mi)].source];
    if (im.mimeType !== "image/png") throw new Error(`${gl.materials[mi].name} 的贴图不是 PNG：请用 VRoid 原始导出版`);
    return im;
  };
  const jobs = Object.fromEntries(Object.entries(M).map(([k, mi]) => [k, viewBytes(gl, bin, imageOf(mi).bufferView)]));
  const painted = await paintTextures(jobs);

  // 1. 贴图：眼睛几层、眉毛的颜色贴图和暗面贴图是同一张，直接换掉；头发的暗面另加一张
  const replaced = new Map<number, Uint8Array>();
  for (const k of ["iris", "catch", "line", "lash", "brow", "hair", "hairBack"] as const)
    replaced.set(imageOf(M[k]).bufferView, painted[k]);
  let thumb: Uint8Array | null = null;
  if (thumbArg) {
    thumb = new Uint8Array(readFileSync(thumbArg));
    const ti = gl.extensions.VRMC_vrm.meta.thumbnailImage;
    if (ti === undefined) throw new Error("模型没有缩略图");
    replaced.set(gl.images[ti].bufferView, thumb);
    gl.images[ti].mimeType = "image/png";
  }
  const shadeNames: [keyof typeof M, string][] = [
    ["hair", "hairShade"],
    ["hairBack", "hairBackShade"],
  ];
  const geo = squeezeEyes(gl, bin); // 2. 先在原数据上改顶点，再重排数据块
  turnBang(gl); // 3. 刘海
  const { bin: out, added } = rebuildBin(
    gl,
    bin,
    replaced,
    shadeNames.map(([, p]) => painted[p]),
  );
  shadeNames.forEach(([k], j) => {
    const m = gl.materials[M[k]];
    const mt = m.extensions?.VRMC_materials_mtoon;
    if (!mt) throw new Error(`${m.name} 不是 MToon 材质`);
    gl.images.push({ name: `${k}_shade_white`, mimeType: "image/png", bufferView: added[j] });
    gl.textures.push({ sampler: gl.textures[baseTex(M[k])].sampler, source: gl.images.length - 1 });
    mt.shadeMultiplyTexture = { ...(mt.shadeMultiplyTexture ?? {}), index: gl.textures.length - 1 };
    mt.shadeColorFactor = [1, 1, 1]; // 暗面颜色画在贴图里
    // 4. 头发的墨线和天使环
    mt.outlineWidthMode = "worldCoordinates";
    mt.outlineWidthFactor = STYLE.hair.outline.width;
    mt.outlineColorFactor = STYLE.hair.outline.color;
    mt.outlineLightingMixFactor = 0;
    if (k === "hair") m.emissiveFactor = STYLE.hair.emissive;
  });
  writeGlb(output, gl, out);
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`✓ ${output}  ${mb(readFileSync(output).length)}（原 ${mb(readFileSync(input).length)}）`);
  console.log(
    `  换了 ${replaced.size} 张贴图、加了 2 张头发暗面；挪了 ${geo.vertices} 个脸部顶点里眼睛附近的，放大瞳孔、高光 ${geo.iris} 个顶点；`,
  );
  console.log(`  刘海 ${STYLE.bang.node} 转 ${STYLE.bang.euler.join(", ")}；前发、后发加墨线${thumb ? "；换了缩略图" : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
