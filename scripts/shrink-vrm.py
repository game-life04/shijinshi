"""把 VRoid 导出的 VRM（VRM 1.0，glTF 二进制）压小，不改网格形状、骨骼、材质参数和 VRM 信息。

做五件事：
1. 表情变形只留 VRM 表情（VRMC_vrm.expressions）实际绑定的那些，其余删掉（VRoid 会多导出眉毛、虎牙等细分形状）；
2. 边长超过 MAX_SIDE（1024）的贴图等比缩到 1024；缩略图只在模型列表里显示、页面用不到，缩到 THUMB_SIDE（256），仍存 PNG
   （VRM 规定缩略图用 PNG 或 JPEG）；
3. 贴图改存 WebP（glTF 扩展 EXT_texture_webp）：法线、描边宽度这类数据贴图无损；颜色贴图有损，每张从质量 90 起试，
   看得见的像素（不透明度大于 0）PSNR 不到 TARGET_PSNR（40 dB）就提高质量，到 100 还不够就改无损；
   透明处的颜色原样保留（不然头发、睫毛这类镂空贴图的边缘会发黑）；
4. 表情变形只存真正动了的顶点（glTF 稀疏存储，无损）；
5. 顶点序号、骨骼序号换成够用的最小整数类型（无损）；蒙皮权重存成 16 位定点数，每个顶点的权重加起来仍正好是 1。
然后重新拼成一个 GLB 并自查：数据块不越界、对齐，每张图能解码；网格、表情、序号还原后和压缩前逐个相等，权重误差打印出来。

用法：python -I scripts/shrink-vrm.py 输入.vrm 输出.vrm（需要 Pillow 和 NumPy：pip install -r scripts/requirements.txt）
11-03：第一版只做 1、2 两步，把 VRoid 导出的琪叶桃从 19.3 MB 压到 7.8 MB（ADR-023）；第二版加了 3～5 步（ADR-026）。
原始导出版不进仓库。
"""

import copy
import io
import json
import struct
import sys
from collections import defaultdict

import numpy as np
from PIL import Image

MAX_SIDE = 1024
THUMB_SIDE = 256
WEBP_QUALITIES = (90, 94, 97, 100)
TARGET_PSNR = 40.0
# 只有这些槽位的贴图按颜色看待、可以有损；其余（法线、描边宽度、阴影偏移、遮罩等）都是数据，只能无损
COLOR_SLOTS = {"baseColorTexture", "shadeMultiplyTexture", "emissiveTexture", "matcapTexture", "rimMultiplyTexture"}

COMPONENT = {5126: "<f4", 5125: "<u4", 5123: "<u2", 5122: "<i2", 5121: "u1", 5120: "i1"}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def read_glb(path):
    data = open(path, "rb").read()
    magic, version, length = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2 and length == len(data), "不是 glTF 2.0 二进制文件"
    off, chunks = 12, []
    while off < len(data):
        clen, ctype = struct.unpack("<I4s", data[off : off + 8])
        chunks.append((ctype, data[off + 8 : off + 8 + clen]))
        off += 8 + clen
    assert chunks[0][0] == b"JSON" and chunks[1][0] == b"BIN\x00"
    return json.loads(chunks[0][1]), chunks[1][1]


def write_glb(path, js, binary):
    jbytes = json.dumps(js, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    jbytes += b" " * (-len(jbytes) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    total = 12 + 8 + len(jbytes) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(jbytes), b"JSON") + jbytes)
        f.write(struct.pack("<I4s", len(binary), b"BIN\x00") + binary)


def view_bytes(js, binary, bv_index):
    bv = js["bufferViews"][bv_index]
    start = bv.get("byteOffset", 0)
    return binary[start : start + bv["byteLength"]]


def read_accessor(js, binary, i):
    """把访问器还原成 (count, 分量数) 的数组：支持没有数据块（全 0）和稀疏存储；不支持交错存储"""
    a = js["accessors"][i]
    dt = np.dtype(COMPONENT[a["componentType"]])
    k = WIDTH[a["type"]]
    if "bufferView" in a:
        bv = js["bufferViews"][a["bufferView"]]
        assert bv.get("byteStride", dt.itemsize * k) == dt.itemsize * k, "不支持交错存储的顶点数据"
        start = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
        out = np.frombuffer(binary, dtype=dt, count=a["count"] * k, offset=start).reshape(a["count"], k).copy()
    else:
        out = np.zeros((a["count"], k), dtype=dt)
    if "sparse" in a:
        sp = a["sparse"]
        idx = np.frombuffer(
            view_bytes(js, binary, sp["indices"]["bufferView"]),
            dtype=COMPONENT[sp["indices"]["componentType"]],
            count=sp["count"],
            offset=sp["indices"].get("byteOffset", 0),
        )
        vals = np.frombuffer(
            view_bytes(js, binary, sp["values"]["bufferView"]), dtype=dt, count=sp["count"] * k, offset=sp["values"].get("byteOffset", 0)
        )
        out[idx] = vals.reshape(-1, k)
    return out


def prune_morph_targets(js):
    """只留被 VRM 表情绑定的变形；返回 {网格: (原数量, 现数量)}"""
    vrm = js["extensions"]["VRMC_vrm"]
    groups = [vrm.get("expressions", {}).get("preset", {}), vrm.get("expressions", {}).get("custom", {})]
    used = {}  # mesh index -> set of target indices
    for g in groups:
        for expr in g.values():
            for b in expr.get("morphTargetBinds", []):
                mesh = js["nodes"][b["node"]]["mesh"]
                used.setdefault(mesh, set()).add(b["index"])
    report = {}
    for mi, mesh in enumerate(js["meshes"]):
        n = len(mesh["primitives"][0].get("targets", []))
        if not n:
            continue
        keep = sorted(used.get(mi, set()))
        if not keep:
            continue  # 没有表情绑定它：保守起见不动
        remap = {old: new for new, old in enumerate(keep)}
        for prim in mesh["primitives"]:
            prim["targets"] = [prim["targets"][i] for i in keep]
            names = prim.get("extras", {}).get("targetNames")
            if names:
                prim["extras"]["targetNames"] = [names[i] for i in keep]
        if "weights" in mesh:
            mesh["weights"] = [mesh["weights"][i] for i in keep]
        names = mesh.get("extras", {}).get("targetNames")
        if names:
            mesh["extras"]["targetNames"] = [names[i] for i in keep]
        for g in groups:
            for expr in g.values():
                for b in expr.get("morphTargetBinds", []):
                    if js["nodes"][b["node"]]["mesh"] == mi:
                        b["index"] = remap[b["index"]]
        report[mesh.get("name", mi)] = (n, len(keep))
    return report


def image_slots(js):
    """每张图被哪些材质槽位用到（经过 textures 间接引用）"""
    slots = defaultdict(set)

    def use(slot, info):
        if isinstance(info, dict) and "index" in info:
            t = js["textures"][info["index"]]
            src = t.get("source", t.get("extensions", {}).get("EXT_texture_webp", {}).get("source"))
            if src is not None:
                slots[src].add(slot)

    for m in js.get("materials", []):
        pbr = m.get("pbrMetallicRoughness", {})
        use("baseColorTexture", pbr.get("baseColorTexture"))
        use("metallicRoughnessTexture", pbr.get("metallicRoughnessTexture"))
        for k in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            use(k, m.get(k))
        for k, v in m.get("extensions", {}).get("VRMC_materials_mtoon", {}).items():
            if k.endswith("Texture"):
                use(k, v)
    return slots


def webp_bytes(img, quality=100, lossless=False):
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=quality, lossless=lossless, method=6, exact=True)
    return buf.getvalue()


def visible_psnr(img, data):
    """只算看得见的像素（不透明度大于 0）的颜色误差"""
    a = np.asarray(img.convert("RGBA"), dtype=np.float64)
    b = np.asarray(Image.open(io.BytesIO(data)).convert("RGBA"), dtype=np.float64)
    vis = a[..., 3] > 0
    if not vis.any():
        return 99.0
    mse = float(np.mean((a[..., :3][vis] - b[..., :3][vis]) ** 2))
    return 99.0 if mse == 0 else 10 * np.log10(255**2 / mse)


def encode_images(js, binary):
    """缩图、改存 WebP。返回 ({图片序号: 新字节}, 每张图的说明, 颜色贴图的最低 PSNR)；同时改好 images、textures 的 JSON"""
    thumb = js["extensions"]["VRMC_vrm"].get("meta", {}).get("thumbnailImage")
    slots = image_slots(js)
    out, notes, psnrs, webp = {}, [], [], set()
    for i, im in enumerate(js["images"]):
        if "bufferView" not in im:
            continue
        old = view_bytes(js, binary, im["bufferView"])
        img = Image.open(io.BytesIO(old))
        img.load()
        resized = False
        limit = THUMB_SIDE if i == thumb else MAX_SIDE
        if max(img.size) > limit:
            scale = limit / max(img.size)
            img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
            resized = True
        if i == thumb or i not in slots:
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            if resized or len(buf.getvalue()) < len(old):
                out[i] = buf.getvalue()
            notes.append((i, "缩略图 PNG" if i == thumb else "PNG（没有贴图用它）", len(old), len(out.get(i, old))))
            continue
        lossy = slots[i] <= COLOR_SLOTS
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
        how = "WebP 无损"
        for q in WEBP_QUALITIES if lossy else ():
            data = webp_bytes(img, quality=q)
            p = visible_psnr(img, data)
            if p >= TARGET_PSNR:
                psnrs.append(p)
                how = f"WebP 有损（质量 {q}，{p:.1f} dB）"
                break
        else:
            data = webp_bytes(img, lossless=True)
            back = Image.open(io.BytesIO(data)).convert(img.mode)
            assert np.array_equal(np.asarray(img), np.asarray(back)), f"图 {i} 无损 WebP 还原后不一致"
        if len(data) >= len(old) and not resized:
            notes.append((i, "保留 PNG（WebP 不更小）", len(old), len(old)))
            continue
        out[i] = data
        im["mimeType"] = "image/webp"
        webp.add(i)
        notes.append((i, how, len(old), len(data)))
    for t in js.get("textures", []):
        if t.get("source") in webp:
            t.setdefault("extensions", {})["EXT_texture_webp"] = {"source": t.pop("source")}
    if webp:
        for key in ("extensionsUsed", "extensionsRequired"):
            js.setdefault(key, [])
            if "EXT_texture_webp" not in js[key]:
                js[key].append("EXT_texture_webp")
    return out, notes, (min(psnrs) if psnrs else None)


def accessor_roles(js):
    roles = defaultdict(set)
    for mesh in js["meshes"]:
        for prim in mesh["primitives"]:
            for name, i in prim["attributes"].items():
                roles[i].add(name)
            if "indices" in prim:
                roles[prim["indices"]].add("INDICES")
            for t in prim.get("targets", []):
                for name, i in t.items():
                    roles[i].add("TARGET_" + name)
    for skin in js.get("skins", []):
        if "inverseBindMatrices" in skin:
            roles[skin["inverseBindMatrices"]].add("IBM")
    for anim in js.get("animations", []):
        for s in anim["samplers"]:
            roles[s["input"]].add("ANIM")
            roles[s["output"]].add("ANIM")
    return roles


def quantize_weights(w):
    """浮点权重 → 16 位定点数；每个顶点四舍五入后的差额补到最大的那个权重上，保证加起来正好是 65535（= 1）。
    原来不是 0 的权重至少留 1：哪根骨骼有影响和原来一致（不然会出现「权重是 0、骨骼序号却不是 0」，glTF 校验器会提示）"""
    w = w.astype(np.float64)
    s = w.sum(axis=1)
    live = s > 0
    w[live] /= s[live, None]
    q = np.rint(w * 65535).astype(np.int64)
    q[(w > 0) & (q == 0)] = 1
    rows = np.flatnonzero(live)
    big = np.argmax(q[rows], axis=1)
    q[rows, big] += 65535 - q[rows].sum(axis=1)
    assert (q >= 0).all() and (q <= 65535).all()
    return q.astype("<u2")


def encode_accessors(js, binary):
    """决定每个用到的访问器怎么存，并改好它的 JSON（componentType、normalized）。返回 ({访问器: (方式, 数据…)}, 各类数据前后大小)"""
    plan, stats = {}, defaultdict(lambda: [0, 0])
    for i, r in sorted(accessor_roles(js).items()):
        a = js["accessors"][i]
        arr = read_accessor(js, binary, i)
        before = arr.nbytes
        kind = None
        if r == {"INDICES"} and a["componentType"] == 5125 and arr.max() < 65535:
            arr, a["componentType"], kind = arr.astype("<u2"), 5123, "顶点序号"
        elif all(x.startswith("JOINTS_") for x in r) and arr.max() < 256 and a["componentType"] != 5121:
            arr, a["componentType"], kind = arr.astype("u1"), 5121, "骨骼序号"
            a.pop("min", None), a.pop("max", None)
        elif all(x.startswith("WEIGHTS_") for x in r) and a["componentType"] == 5126:
            arr, a["componentType"], a["normalized"], kind = quantize_weights(arr), 5123, True, "蒙皮权重"
            a.pop("min", None), a.pop("max", None)
        target = ELEMENT_ARRAY_BUFFER if r == {"INDICES"} else None if r & {"IBM", "ANIM"} else ARRAY_BUFFER
        if all(x.startswith("TARGET_") for x in r):
            kind = "表情变形"
            rows = np.flatnonzero(np.any(arr != 0, axis=1))
            idx_dt = "u1" if a["count"] <= 256 else "<u2" if a["count"] <= 65536 else "<u4"
            sparse_size = len(rows) * (np.dtype(idx_dt).itemsize + arr.itemsize * arr.shape[1])
            if len(rows) == 0:
                plan[i] = ("zeros",)
            elif sparse_size < arr.nbytes:
                plan[i] = ("sparse", rows.astype(idx_dt), arr[rows])
            else:
                plan[i] = ("dense", arr, ARRAY_BUFFER)
            after = 0 if len(rows) == 0 else min(sparse_size, arr.nbytes)
        else:
            plan[i] = ("dense", arr, target)
            after = arr.nbytes
        if kind is None:
            first = sorted(r)[0]
            kind = {"POSITION": "顶点位置", "NORMAL": "法线", "TEXCOORD_0": "贴图坐标", "INDICES": "顶点序号", "IBM": "骨骼矩阵"}.get(first, first)
        stats[kind][0] += before
        stats[kind][1] += after
    return plan, dict(stats)


def rebuild(js, binary, new_images, plan):
    """按新的存法重新拼二进制：每个访问器、每张图各占一个数据块，4 字节对齐"""
    image_data = {}
    for i, im in enumerate(js["images"]):
        if "bufferView" in im:
            image_data[i] = new_images.get(i, view_bytes(js, binary, im["bufferView"]))
    out = bytearray()
    views = []

    def add_view(data, target=None):
        out.extend(b"\x00" * (-len(out) % 4))
        v = {"buffer": 0, "byteOffset": len(out), "byteLength": len(data)}
        if target:
            v["target"] = target
        out.extend(data)
        views.append(v)
        return len(views) - 1

    order = sorted(plan)
    acc_map = {old: new for new, old in enumerate(order)}
    accessors = []
    for old in order:
        a = js["accessors"][old]
        for k in ("bufferView", "byteOffset", "sparse"):
            a.pop(k, None)
        p = plan[old]
        if p[0] == "dense":
            a["bufferView"] = add_view(p[1].tobytes(), p[2])
        elif p[0] == "sparse":
            rows, vals = p[1], p[2]
            a["sparse"] = {
                "count": len(rows),
                "indices": {"bufferView": add_view(rows.tobytes()), "componentType": {1: 5121, 2: 5123, 4: 5125}[rows.itemsize]},
                "values": {"bufferView": add_view(vals.tobytes())},
            }
        accessors.append(a)
    for i, im in enumerate(js["images"]):
        if i in image_data:
            im["bufferView"] = add_view(image_data[i])

    for mesh in js["meshes"]:
        for prim in mesh["primitives"]:
            prim["attributes"] = {k: acc_map[v] for k, v in prim["attributes"].items()}
            if "indices" in prim:
                prim["indices"] = acc_map[prim["indices"]]
            if prim.get("targets"):
                prim["targets"] = [{k: acc_map[v] for k, v in t.items()} for t in prim["targets"]]
    for skin in js.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = acc_map[skin["inverseBindMatrices"]]
    for anim in js.get("animations", []):
        for s in anim["samplers"]:
            s["input"] = acc_map[s["input"]]
            s["output"] = acc_map[s["output"]]

    js["accessors"] = accessors
    js["bufferViews"] = views
    js["buffers"] = [{"byteLength": len(out)}]
    return bytes(out)


def check(js, binary):
    """自查：数据块不越界；访问器（含稀疏部分）落在数据块里、对齐；顶点数据每个元素 4 字节对齐；每张图都能解码"""
    for bv in js["bufferViews"]:
        assert bv["byteOffset"] % 4 == 0 and bv["byteOffset"] + bv["byteLength"] <= len(binary), "数据块越界或没对齐"

    def fits(view, offset, comp, nbytes):
        bv = js["bufferViews"][view]
        assert offset + nbytes <= bv["byteLength"], "访问器越界"
        assert (bv["byteOffset"] + offset) % comp == 0, "对齐不对"

    for a in js["accessors"]:
        comp = np.dtype(COMPONENT[a["componentType"]]).itemsize
        k = WIDTH[a["type"]]
        if "bufferView" in a:
            fits(a["bufferView"], a.get("byteOffset", 0), comp, a["count"] * comp * k)
            if js["bufferViews"][a["bufferView"]].get("target") == ARRAY_BUFFER:
                assert (comp * k) % 4 == 0, "顶点数据的每个元素要 4 字节对齐"
        if "sparse" in a:
            sp = a["sparse"]
            icomp = np.dtype(COMPONENT[sp["indices"]["componentType"]]).itemsize
            fits(sp["indices"]["bufferView"], sp["indices"].get("byteOffset", 0), icomp, sp["count"] * icomp)
            fits(sp["values"]["bufferView"], sp["values"].get("byteOffset", 0), comp, sp["count"] * comp * k)
    for im in js["images"]:
        Image.open(io.BytesIO(view_bytes(js, binary, im["bufferView"]))).load()


def compare(js_a, bin_a, js_b, bin_b):
    """网格逐个比：除蒙皮权重外必须完全相等；返回权重的最大误差"""
    worst = 0.0
    for ma, mb in zip(js_a["meshes"], js_b["meshes"], strict=True):
        for pa, pb in zip(ma["primitives"], mb["primitives"], strict=True):
            pairs = [(pa["attributes"][k], pb["attributes"][k], k) for k in pa["attributes"]]
            pairs.append((pa["indices"], pb["indices"], "INDICES"))
            for ta, tb in zip(pa.get("targets", []), pb.get("targets", []), strict=True):
                pairs += [(ta[k], tb[k], "TARGET") for k in ta]
            for ia, ib, name in pairs:
                a = read_accessor(js_a, bin_a, ia)
                b = read_accessor(js_b, bin_b, ib)
                if name.startswith("WEIGHTS_"):
                    w = a.astype(np.float64)
                    s = w.sum(axis=1, keepdims=True)
                    w /= np.where(s > 0, s, 1)
                    q = b.astype(np.float64) / 65535
                    assert np.allclose(q.sum(axis=1)[s[:, 0] > 0], 1.0, atol=1e-9), "权重加起来不是 1"
                    worst = max(worst, float(np.abs(q - w).max()))
                else:
                    assert np.array_equal(a.astype(np.float64), b.astype(np.float64)), f"{name} 压缩前后不一致"
    return worst


def main(src, dst):
    js, binary = read_glb(src)
    morph = prune_morph_targets(js)
    before = copy.deepcopy(js)
    new_images, notes, min_psnr = encode_images(js, binary)
    plan, stats = encode_accessors(js, binary)
    binary_out = rebuild(js, binary, new_images, plan)
    check(js, binary_out)
    write_glb(dst, js, binary_out)
    js2, bin2 = read_glb(dst)
    check(js2, bin2)
    worst = compare(before, binary, js2, bin2)
    for name, (a, b) in morph.items():
        print(f"表情变形 {name}：{a} → {b}")
    total_old = sum(n[2] for n in notes)
    total_new = sum(n[3] for n in notes)
    psnr = f"；有损的颜色贴图看得见的像素最低 PSNR {min_psnr:.1f} dB" if min_psnr is not None else ""
    print(f"贴图 {len(notes)} 张：{total_old / 1e6:.2f} → {total_new / 1e6:.2f} MB{psnr}")
    for i, how, a, b in notes:
        print(f"  图 {i} {js2['images'][i].get('name', '')}：{how} {a / 1e3:.0f} → {b / 1e3:.0f} KB")
    for kind, (a, b) in stats.items():
        print(f"{kind}：{a / 1e6:.2f} → {b / 1e6:.2f} MB")
    print(f"蒙皮权重最大误差 {worst:.2e}（网格、表情、序号逐个比对一致）")
    with open(dst, "rb") as f:
        print(f"文件 {len(f.read()) / 1e6:.2f} MB")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1], sys.argv[2])
