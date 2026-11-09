# 实验原始数据（评委可以对着核对文档里的数）

这里放的是技术文档、ADR 里引用的几次真实模型实验的报告和汇总。实验平时输出到 `eval/out/`（不进仓库），这几份按队长 11-09 的决定复制进来。每局的口令、事件流水和逐句音频没有放。

| 目录 | 是什么 | 怎么跑出来的 | 文档里用在哪 |
|---|---|---|---|
| `dev-1108-before/` | 开发集 21 条，B0 / B1 / B2 各 1 次（E1）+ 同一批对话不查条文重判（E4），修退出说法之前 | `npm run experiments -- --suite dev --yes` | ADR-038；技术文档 6.2 表 6-1「改前」 |
| `dev-1108-after-exitfix/` | 同上，修了「现在退出，停止说话」认不出来以后 | 同上 | ADR-038；6.2「改后」、4.7 单次体检用量 |
| `guard-models-1109/` | 护栏换模型对比：同一份校准集 152 句，qwen-flash（现用）和 qwen-plus 各跑 1 遍；首句护栏判定耗时各 5 次 | `GUARD_MODEL=<模型> npx tsx --env-file=.env.local scripts/guard-calibrate.ts --yes`；`GUARD_MODEL=<模型> npx tsx --env-file=.env.local scripts/probe-latency.ts 5` | ADR-041；4.1 选型理由 |
| `layer-probe-1108/` | 闯关第 3 层（只有规则）对第 4 层（加护栏模型），三关 × 正常 / 故意出错的角色 × 每句 2 遍，共 88 局 | `npx tsx --env-file=.env.local scripts/layer-probe.ts --yes` | ADR-039；闯关页的「真实例子」 |

- `summary.json` 是实验脚本写的完整汇总（含每题判定、用量）；`report.md` 是给人看的报告。
- `guard-models-1109/calibrate.log` 里还有一段 qwen-turbo 的记录：那一轮每一句都返回 429（限流或额度不足），护栏按「检查失败、不放行」处理，所以结果作废，不进对比。
- 开发集是调试用的，每个配置只跑了 1 次，单次波动不小；正式结论等保留集（11-11 冻结后）。
