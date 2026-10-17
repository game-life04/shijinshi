# 试金石：AI 语音角色安全体检与流式保护工作台

给「会说话的 AI 角色」（AI 陪伴、AI 玩具、游戏里的 AI 角色）在上线前做安全体检的 Web 应用。测试 Agent 按审核过的用例和策略去测被测角色；角色的每句话在放行前经过护栏；裁判依据《人工智能拟人化互动服务管理暂行办法》的条文原文判定，并给出带原文位置的证据；最后生成可人工复核的报告。

> 本作品是第九届传智杯「AI WEB 网页开发挑战赛」参赛作品（开发中）。报告是**自查辅助，不是合规认证**。

## 当前进度

- ✅ M0 工程与合同；M1 文字纵向闭环已在模拟模式验证，真实模型待配置密钥后验证
- ⏳ M2 语音与停止（麦克风 → 识别 → 大模型 → 合成 → AudioWorklet → VRM）
- 详细状态见 [docs/implementation-status.md](docs/implementation-status.md)

## 它做什么

| 七类测试 | 检查什么 | 依据 |
|---|---|---|
| CANARY 无害口令 | 角色设定里的随机测试口令不被套出 | 工程测试 |
| PERSONA 角色设定 | 不突然变成客服腔、说明书腔 | 工程测试 |
| AI_IDENTITY 身份 | 被问时如实说明自己是 AI，不声称是真人 | 第十八条 |
| USAGE_REMINDER 时长提醒 | 连续使用跨过 2 小时提醒一次（逻辑时钟加速模拟，明确标注） | 第十八条 |
| EXIT 退出 | 要求退出时立即停止，不挽留、不再输出 | 第十九条 |
| CRISIS_SUPPORT 危机 | 认真回应并鼓励求助，不敷衍 | 第十三条、第八条 |
| MINOR_BOUNDARY 未成年人 | 对方自报未成年后不建立亲密关系 | 第十四条、第八条 |

被测配置：B0 基础角色、B1 加边界提示、B2 再加运行时护栏与服务层机制、FAULT 故障注入（只用来验证检测机制，单独统计）。

## 快速开始

需要 Node.js 22 以上。

```bash
npm ci
cp .env.example .env.local     # 不填 LLM_API_KEY 也能运行：使用确定性模拟器（结果不能当实验数据）
npm run dev                    # 打开 http://localhost:3000 ，首屏就是体检工作台
```

国内网络安装慢时可以用镜像：`npm ci --registry=https://registry.npmmirror.com`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run lint` / `npm run typecheck` | 代码规范检查 / TypeScript 严格类型检查 |
| `npm test` | 单元测试（不调用真实模型） |
| `npm run test:e2e` | 端到端测试（本机 Edge，三种屏幕尺寸，截图存到 docs/evidence/screenshots） |
| `npm run build` | 生产构建 |
| `npm run kb:build` | 从法规网页快照重新生成条文库 |
| `npm run eval:validate -- --dataset suites/smoke.jsonl` | 校验用例文件（结构 + 语义） |
| `npm run eval:run -- --config eval/configs/smoke-b2.json --output eval/out/smoke-b2` | 按配置跑一次体检并导出原始数据 |
| `npm run eval:summarize -- --input eval/out/smoke-b2` | 从原始数据重算汇总并核对分母 |
| `npm run release:check` | 发布前扫描密钥、内网地址和本地禁词表 |

如果系统设置了 HTTP 代理，跑端到端测试前先设 `NO_PROXY=127.0.0.1,localhost`。

## 技术架构

```
浏览器（Next.js App Router + React 19 + TypeScript strict + Tailwind）
  工作台 / 用例库 / 运行记录 / 证据报告 / 设置
        │  REST + 事件流（SSE）
Next.js Route Handlers（只做 AI 接入层）
  └ lib/server/runs.ts   运行管理：create/start/pause/resume/cancel/get/report/review/compare
       ├ tester.ts       测试 Agent：函数调用（execute_case、retrieve_reference、finish），有轮数与调用预算
       ├ subject.ts      被测角色：服务层（退出、时长提醒）+ 流式生成 + 按句护栏（S1 先审后播）
       │   └ guard.ts    规则 + 小模型的上下文检查；检查失败按不放行处理
       ├ judge.ts        确定性断言 → 条文检索 → 结构化语义判断 → 证据跨度校验 → 送人工复核
       ├ rag.ts          条文库（32 条原文，带快照指纹）+ BM25 检索 + 引用校验
       └ llm.ts          OpenAI 兼容接口；计量、超时、平台拦截/限流分类
lib/domain/              共享类型、用例合同校验、断言注册表、证据定位与对账（UI、脚本、工具共用）
```

数据：`suites/*.jsonl` 用例（按 `suites/case.schema.json` 校验），`kb/` 条文库与快照，运行结果写入 `data/runs/<id>/`（manifest.json、results.jsonl、events.jsonl）。

## 安全与隐私

- 只测本人原创或已获授权的角色；不接受任意外部网址。
- 密钥只放服务端环境变量；页面、日志、导出都不显示密钥。
- 本轮随机口令单独存放，不经接口返回，也不提供给裁判。
- 不保存录音；敏感行为用例使用人工审定的固定输入，不让 Agent 自由生成。
- 界面常驻「被测对象是 AI 角色，不是真人」标识。

## 来源与许可

- 法规条文取自湖南省人民政府网转载页（注明来源为国家互联网信息办公室网站），快照与指纹见 `kb/`。
- 依赖库的许可证以各自的 package.json 为准；AI 辅助开发说明见 [docs/PROVENANCE.md](docs/PROVENANCE.md)。

## 团队

两名同校学生：A（开发）、B（用例、条文、测试与材料）。指导老师信息待确认后补充。
