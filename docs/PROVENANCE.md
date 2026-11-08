# 来源与 AI 辅助说明

## AI 辅助开发

比赛允许使用 AI 辅助编程。本项目的初版代码（M0–M2 输出端）由 Claude Code 在队员 A 的指导下编写，提交记录里带有 `Co-Authored-By: Claude` 标注。A 负责逐个模块走读、修改和验证；每个核心模块的原理、遇到的真实失败、关键函数入口和答辩问题见 [walkthrough.md](walkthrough.md)。我们不把 AI 生成的内容伪装成手写。

## 数据与素材

| 内容 | 来源 | 许可 / 说明 |
|---|---|---|
| 新规条文 `kb/clauses.jsonl` | 湖南省人民政府网转载页（注明来源为国家互联网信息办公室网站），2026-10-17 抓取 | 法律、法规条文不受著作权法保护（著作权法第五条）；快照与 SHA-256 见 `kb/sources/` |
| 条文白话解释 `kb/annotations.json` | 队伍自写 | 草稿，待队员 B 与指导老师核对 |
| 用例 `suites/*.jsonl` | 队伍原创 | 当前全部为草稿，人工审核后才进入正式统计 |
| 测试策略 `suites/strategies.json` | 队伍原创 | 草稿 |
| 角色「琪叶桃」人设 | 队伍原创 | 不使用任何第三方游戏角色的名称、设定或素材 |
| 示意形象（SVG） | 队伍原创 | 没有 VRM 模型时的回退形象 |
| 琪叶桃 VRM 模型 `public/models/qiyetao.vrm` | 队员 A 用 VRoid Studio 制作；模型信息里写明「部分素材来自 VRoid Studio 内置预设（pixiv Inc.）」 | 模型内写明的许可：VRM Public License 1.0，作者 game-life04，仅限个人非商业使用，他人不得再分发、不得改作。仓库里是队伍自己改过的白发版（ADR-030）：头发、眉毛按明暗换色，瞳孔、高光、眼线由 `scripts/restyle-painters.js` 用浏览器画布重画，没有用别人的图；再用 `scripts/shrink-vrm.py` 压缩（ADR-023、ADR-027），贴图改存 WebP（颜色贴图有损，看得见的像素 PSNR 不低于 40 dB） |
| 模拟发声 | 程序生成（`lib/server/tts.ts` 的 `renderBabble`） | 不含任何录音或第三方音色 |
| 琪叶桃的细分表情（ADR-033） | VRoid 导出版里本来就有的眉、眼、嘴角变形，`scripts/vrm-expressions.py` 只是把其中 14 个登记成 VRM 自定义表情 | 网格和贴图一个字节没改；许可同上面的模型 |
| 汉字口型表 `lib/client/avatar/viseme-table.ts`（ADR-033） | 由 `scripts/build-visemes.py` 从 Unicode 官方 Unihan 数据库（`Unihan_Readings.txt` 的 kMandarin，Unicode 18.0.0，SHA-256 `4c93ea9c…d43e`）生成：每个字记一个口型类别 | Unicode License V3，原文附在本页末尾 |
| 登录页背景 `app/login/art/`（ADR-032） | 主视觉小样同一个场景另出的「登录版」（琪叶桃 3D 模型实时渲染 + 程序画的墨圈、纸条、花瓣，不带字），压成 AVIF / WebP | 队伍原创；画面上的字在网页里用 HTML 排；不用任何画师的作品 |
| 开发验证用的 VRM 示例模型 | three-vrm 官方仓库示例 | 只在本机验证加载，不进仓库、不出现在截图和演示里 |

## Unicode License V3（汉字口型表用到的 Unihan 数据）

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.
```

## 主要依赖

Next.js、React、Tailwind CSS、Biome、Ajv、lucide-react、three、@pixiv/three-vrm、Vitest、Playwright、tsx。许可证以各自 package.json 为准（均为 MIT 或 Apache-2.0 等开源许可，提交前用 `npm ls` 复核）。
