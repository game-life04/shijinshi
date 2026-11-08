"""生成「汉字 → 口型」对照表 lib/client/avatar/viseme-table.ts（虚拟人口型用，ADR-033）。

数据来自 Unicode 官方的 Unihan 数据库（Unihan_Readings.txt 的 kMandarin：每个字最常用的普通话读音）。
只取基本汉字区 U+4E00～U+9FFF（20992 个字），每个字记一个字母：
  a i u e o  这个字的主要口型（按韵母归类，对应 VRM 的 aa ih ou ee oh）
  A I U E O  同上，但声母是 b p m f（开口前先抿一下嘴）
  n          只有鼻音、不张嘴（嗯、呣）
  .          没有读音数据
归类：含 a 的韵母归 a（ian、üan 实际读得像 e，归 e）；o、uo、ou、iou 归 o；ong、iong 归 u；
e、ie、üe、ei、uei、en、uen、eng、ueng、er 归 e；i、in、ing（含 zhi chi shi ri zi ci si）归 i；u、ü、ün 归 u。
多音字只取 Unihan 给的第一个读音，个别字会对不上（比如「的」只按 de），口型看不出来。

用法：先下载固定版本的数据（Unicode 18.0.0），再运行：
  curl -o Unihan.zip https://www.unicode.org/Public/18.0.0/ucd/Unihan.zip
  python -I scripts/build-visemes.py Unihan.zip
Unihan.zip 不进仓库；脚本会核对它的 SHA-256。数据按 Unicode License V3 使用，许可原文见 docs/PROVENANCE.md。
"""

import hashlib
import sys
import unicodedata
import zipfile
from collections import Counter
from pathlib import Path

UNIHAN_SHA256 = "4c93ea9c1f636451729a840978f1667a53886af37ba854fdcce109721c63d43e"  # Unicode 18.0.0
START, END = 0x4E00, 0xA000
OUT = Path(__file__).resolve().parent.parent / "lib" / "client" / "avatar" / "viseme-table.ts"

INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w"]
LIPS = {"b", "p", "m", "f"}
# y、w 开头的拼写还原成韵母本来的样子；j q x 后面的 u 是 ü（记作 v）
Y_FINALS = {"i": "i", "a": "ia", "e": "ie", "ao": "iao", "ou": "iou", "an": "ian", "in": "in", "ang": "iang", "ing": "ing",
            "ong": "iong", "u": "v", "ue": "ve", "uan": "van", "un": "vn", "o": "io"}
W_FINALS = {"u": "u", "a": "ua", "o": "uo", "ai": "uai", "ei": "uei", "an": "uan", "en": "uen", "ang": "uang", "eng": "ueng"}
SHORT = {"iu": "iou", "ui": "uei", "un": "uen"}
NASAL = {"m", "n", "ng", "hm", "hng"}


def plain(pinyin: str) -> str:
    """去掉声调，ü 记成 v"""
    out = []
    for ch in unicodedata.normalize("NFD", pinyin.lower()):
        if ch == "̈":
            out.append("v")
        elif not unicodedata.combining(ch):
            out.append(ch)
    return "".join(out).replace("uv", "v")


def viseme(pinyin: str) -> str:
    s = plain(pinyin)
    if s in NASAL:
        return "n"
    initial = next((i for i in INITIALS if s.startswith(i) and len(s) > len(i)), "")
    final = s[len(initial):]
    if initial == "y":
        final = Y_FINALS.get(final, final)
    elif initial == "w":
        final = W_FINALS.get(final, final)
    elif initial in ("j", "q", "x") and final.startswith("u"):
        final = "v" + final[1:]
    final = SHORT.get(final, final)
    if final in ("ian", "van"):
        c = "e"
    elif final in ("ong", "iong"):
        c = "u"
    elif "a" in final:
        c = "a"
    elif final in ("o", "uo", "ou", "iou", "io"):
        c = "o"
    elif final in ("e", "ie", "ve", "ei", "uei", "en", "uen", "eng", "ueng", "er", "ê"):
        c = "e"
    elif final in ("i", "in", "ing"):
        c = "i"
    elif final in ("u", "v", "vn"):
        c = "u"
    else:
        raise ValueError(f"认不出的拼音：{pinyin}")
    return c.upper() if initial in LIPS else c


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) != 2:
        raise SystemExit("用法：python -I scripts/build-visemes.py Unihan.zip")
    data = Path(sys.argv[1]).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != UNIHAN_SHA256:
        raise SystemExit(f"Unihan.zip 的 SHA-256 是 {digest}，和 Unicode 18.0.0 版（{UNIHAN_SHA256}）不一样；请下载文件头写的固定版本")
    readings = {}
    with zipfile.ZipFile(sys.argv[1]) as z:
        for line in z.read("Unihan_Readings.txt").decode("utf-8").splitlines():
            if "\tkMandarin\t" in line:
                cp, _, value = line.split("\t")
                readings[int(cp[2:], 16)] = value.split()[0]
    table = "".join(viseme(readings[cp]) if cp in readings else "." for cp in range(START, END))
    stats = Counter(table)
    OUT.write_text(
        "// 由 scripts/build-visemes.py 生成，不要手改（ADR-033）。\n"
        "// 数据：Unicode Unihan 数据库 kMandarin（Unicode 18.0.0），Copyright © 1991-2026 Unicode, Inc.，按 Unicode License V3 使用（docs/PROVENANCE.md）。\n"
        "// 从 U+4E00 起每个字一个字母：a i u e o 是口型，大写表示 b p m f 开头（先抿嘴），n 只有鼻音，. 没有读音数据。\n"
        f"export const VISEME_TABLE_START = 0x{START:x};\n"
        f'export const VISEME_TABLE = "{table}";\n',
        encoding="utf-8",
        newline="\n",
    )
    print(f"写好 {OUT.relative_to(OUT.parent.parent.parent.parent)}：{len(table)} 个字，" + "，".join(f"{k} {v}" for k, v in sorted(stats.items())))


if __name__ == "__main__":
    main()
