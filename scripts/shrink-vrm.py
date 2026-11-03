"""把 VRoid 导出的 VRM（VRM 1.0，glTF 二进制）压小，不改网格、骨骼、材质和 VRM 信息。

做两件事：
1. 表情变形只留 VRM 表情（VRMC_vrm.expressions）实际绑定的那些，其余删掉（VRoid 会多导出眉毛、虎牙等细分形状）；
2. 边长超过 MAX_SIDE（1024）的贴图等比缩到 1024，缩略图缩到 THUMB_SIDE（512）；都按 PNG 重新压缩，保留透明通道。
然后把没人用的数据块清掉，重新拼成一个 GLB。

用法：python -I scripts/shrink-vrm.py 输入.vrm 输出.vrm（需要 Pillow：pip install pillow）
11-03 用它把 VRoid 导出的琪叶桃从 19.3 MB 压到 7.8 MB（ADR-023）；原始导出版不进仓库。
"""

import io
import json
import struct
import sys

from PIL import Image

MAX_SIDE = 1024
THUMB_SIDE = 512


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


def shrink_images(js, binary):
    """返回 {图片序号: 新的 PNG 字节}；只处理需要缩小的"""
    thumb = js["extensions"]["VRMC_vrm"].get("meta", {}).get("thumbnailImage")
    out = {}
    for i, im in enumerate(js["images"]):
        if im.get("mimeType") != "image/png" or "bufferView" not in im:
            continue
        img = Image.open(io.BytesIO(view_bytes(js, binary, im["bufferView"])))
        img.load()
        limit = THUMB_SIDE if i == thumb else MAX_SIDE
        w, h = img.size
        if max(w, h) <= limit:
            continue
        scale = limit / max(w, h)
        small = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        buf = io.BytesIO()
        small.save(buf, format="PNG", optimize=True)
        out[i] = buf.getvalue()
    return out


def rebuild(js, binary, new_images):
    """清掉没人引用的访问器和数据块，按 4 字节对齐重新拼二进制"""
    acc_used = set()

    def use_acc(i):
        acc_used.add(i)

    for mesh in js["meshes"]:
        for prim in mesh["primitives"]:
            for i in prim["attributes"].values():
                use_acc(i)
            if "indices" in prim:
                use_acc(prim["indices"])
            for t in prim.get("targets", []):
                for i in t.values():
                    use_acc(i)
    for skin in js.get("skins", []):
        if "inverseBindMatrices" in skin:
            use_acc(skin["inverseBindMatrices"])
    for anim in js.get("animations", []):
        for s in anim["samplers"]:
            use_acc(s["input"])
            use_acc(s["output"])

    acc_order = sorted(acc_used)
    acc_map = {old: new for new, old in enumerate(acc_order)}
    accessors = [js["accessors"][i] for i in acc_order]

    bv_used = []
    for a in accessors:
        if "bufferView" in a:
            bv_used.append(a["bufferView"])
        if "sparse" in a:
            bv_used += [a["sparse"]["indices"]["bufferView"], a["sparse"]["values"]["bufferView"]]
    bv_used += [im["bufferView"] for im in js["images"] if "bufferView" in im]
    bv_order = sorted(set(bv_used))
    bv_map = {old: new for new, old in enumerate(bv_order)}
    image_of_bv = {im["bufferView"]: i for i, im in enumerate(js["images"]) if "bufferView" in im}

    out = bytearray()
    views = []
    for old in bv_order:
        bv = dict(js["bufferViews"][old])
        data = view_bytes(js, binary, old)
        if old in image_of_bv and image_of_bv[old] in new_images:
            data = new_images[image_of_bv[old]]
        out += b"\x00" * (-len(out) % 4)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(data)
        out += data
        views.append(bv)

    for a in accessors:
        if "bufferView" in a:
            a["bufferView"] = bv_map[a["bufferView"]]
        if "sparse" in a:
            a["sparse"]["indices"]["bufferView"] = bv_map[a["sparse"]["indices"]["bufferView"]]
            a["sparse"]["values"]["bufferView"] = bv_map[a["sparse"]["values"]["bufferView"]]
    for im in js["images"]:
        if "bufferView" in im:
            im["bufferView"] = bv_map[im["bufferView"]]
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
    """自查：每个数据块不越界，每个访问器的数据都落在它的数据块里，每张图都能解码"""
    for bv in js["bufferViews"]:
        assert bv["byteOffset"] + bv["byteLength"] <= len(binary)
    for a in js["accessors"]:
        if "bufferView" not in a:
            continue
        bv = js["bufferViews"][a["bufferView"]]
        comp = {5126: 4, 5125: 4, 5123: 2, 5122: 2, 5121: 1, 5120: 1}[a["componentType"]]
        k = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[a["type"]]
        stride = bv.get("byteStride", comp * k)
        need = a.get("byteOffset", 0) + stride * (a["count"] - 1) + comp * k
        assert need <= bv["byteLength"], "访问器越界"
        assert (bv["byteOffset"] + a.get("byteOffset", 0)) % comp == 0, "对齐不对"
    for im in js["images"]:
        Image.open(io.BytesIO(view_bytes(js, binary, im["bufferView"]))).load()


def main(src, dst):
    js, binary = read_glb(src)
    morph = prune_morph_targets(js)
    new_images = shrink_images(js, binary)
    binary = rebuild(js, binary, new_images)
    check(js, binary)
    write_glb(dst, js, binary)
    js2, bin2 = read_glb(dst)
    check(js2, bin2)
    for name, (a, b) in morph.items():
        print(f"表情变形 {name}：{a} → {b}")
    print(f"缩小的贴图 {len(new_images)} 张")
    print(f"二进制 {len(bin2) / 1e6:.2f} MB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
