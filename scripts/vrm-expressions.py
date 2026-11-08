"""给琪叶桃的 VRM 加「细分表情」（虚拟人表演用，ADR-033）。

VRoid 导出的脸上有 57 个变形，但 VRM 的预设表情只绑了 14 个（整脸的喜怒哀乐惊、五个口型、眨眼），
压缩脚本只留表情绑定到的变形，所以眉毛、眼睛、嘴角分开的形状都被删了。
说话时要「嘴在说、眉眼在笑」，就得把这些分开的形状留下来：这里把它们加成 VRM 1.0 的自定义表情
（VRMC_vrm.expressions.custom），只改模型里的 JSON，网格和贴图一个字节不动。

流程（public/models/README.md）：
  npx tsx scripts/restyle-vrm.mts 原始导出版.vrm 白发版.vrm
  python -I scripts/vrm-expressions.py 白发版.vrm 白发版_细分表情.vrm
  python -I scripts/shrink-vrm.py 白发版_细分表情.vrm public/models/qiyetao.vrm
"""

import json
import struct
import sys

# 自定义表情名 → VRoid 变形名。名字照 VRM 预设表情的写法（小写开头的驼峰），左右是角色自己的左右（和 blinkLeft 一样）。
# 只加导演层用到的（lib/client/avatar/vrm-driver.ts 的 EXPRESSION_MAP），而且全是「闭着嘴」的形状：嘴张多大只归五个口型管，
# 截断那一帧嘴要立刻闭上。VRoid 的 Fcl_MTH_Joy、Surprised、Sorrow、Small、Angry、Large 这些会张嘴，一个都不加。
CUSTOM = {
    "eyeFun": "Fcl_EYE_Fun",  # 笑眼（下眼睑抬起）
    "eyeJoy": "Fcl_EYE_Joy",  # 眯眼笑
    "eyeJoyLeft": "Fcl_EYE_Joy_L",  # 眨单眼
    "eyeJoyRight": "Fcl_EYE_Joy_R",
    "eyeSorrow": "Fcl_EYE_Sorrow",  # 委屈、抱歉
    "eyeSurprised": "Fcl_EYE_Surprised",  # 愣住
    "eyeAngry": "Fcl_EYE_Angry",  # 认真
    "browJoy": "Fcl_BRW_Joy",
    "browSorrow": "Fcl_BRW_Sorrow",
    "browSurprised": "Fcl_BRW_Surprised",
    "browAngry": "Fcl_BRW_Angry",
    "mouthUp": "Fcl_MTH_Up",  # 嘴角上扬（嘴唇仍闭合）
    "mouthDown": "Fcl_MTH_Down",
    "mouthClose": "Fcl_MTH_Close",  # 抿嘴
}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 3:
        raise SystemExit("用法：python -I scripts/vrm-expressions.py 输入.vrm 输出.vrm")
    data = open(sys.argv[1], "rb").read()
    magic, version, length = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2 and length == len(data), "不是 glTF 2.0 二进制文件"
    jlen, jtype = struct.unpack("<I4s", data[12:20])
    assert jtype == b"JSON"
    js = json.loads(data[20 : 20 + jlen])
    rest = data[20 + jlen :]  # BIN 块原样保留

    vrm = js["extensions"]["VRMC_vrm"]
    faces = [
        (ni, n["mesh"])
        for ni, n in enumerate(js["nodes"])
        if "mesh" in n and "Fcl_MTH_A" in (js["meshes"][n["mesh"]].get("extras", {}).get("targetNames") or [])
    ]
    assert len(faces) == 1, f"要正好一个带 VRoid 脸部变形的网格，找到 {len(faces)} 个"
    node, mesh = faces[0]
    names = js["meshes"][mesh]["extras"]["targetNames"]
    preset = vrm.get("expressions", {}).get("preset", {})
    custom = vrm.setdefault("expressions", {}).setdefault("custom", {})
    for key, target in CUSTOM.items():
        assert key not in preset, f"{key} 和预设表情重名"
        if target not in names:
            raise SystemExit(f"模型里没有变形 {target}（这份导出不是 VRoid 的完整版？）")
        custom[key] = {
            "morphTargetBinds": [{"node": node, "index": names.index(target), "weight": 1.0}],
            "isBinary": False,
            "overrideBlink": "none",
            "overrideLookAt": "none",
            "overrideMouth": "none",
        }

    jbytes = json.dumps(js, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    jbytes += b" " * (-len(jbytes) % 4)
    out = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(jbytes) + len(rest)) + struct.pack("<I4s", len(jbytes), b"JSON") + jbytes + rest
    with open(sys.argv[2], "wb") as f:
        f.write(out)
    print(f"加了 {len(CUSTOM)} 个自定义表情（脸部网格节点 {node}），预设表情 {len(preset)} 个不变")


if __name__ == "__main__":
    main()
