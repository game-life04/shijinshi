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
| 琪叶桃 VRM 模型 `public/models/qiyetao.vrm` | 队员 A 用 VRoid Studio 制作；模型信息里写明「部分素材来自 VRoid Studio 内置预设（pixiv Inc.）」 | 模型内写明的许可：VRM Public License 1.0，作者 game-life04，仅限个人非商业使用，他人不得再分发、不得改作。仓库里是用 `scripts/shrink-vrm.py` 压缩的版本（ADR-023、ADR-027）：网格形状、表情、骨骼、材质参数与导出版相同；贴图改存 WebP（颜色贴图有损，看得见的像素 PSNR 不低于 40 dB） |
| 模拟发声 | 程序生成（`lib/server/tts.ts` 的 `renderBabble`） | 不含任何录音或第三方音色 |
| 开发验证用的 VRM 示例模型 | three-vrm 官方仓库示例 | 只在本机验证加载，不进仓库、不出现在截图和演示里 |

## 主要依赖

Next.js、React、Tailwind CSS、Biome、Ajv、lucide-react、three、@pixiv/three-vrm、Vitest、Playwright、tsx。许可证以各自 package.json 为准（均为 MIT 或 Apache-2.0 等开源许可，提交前用 `npm ls` 复核）。
