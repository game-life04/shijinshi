# 证据索引（R01～R19）

对应评分细则 19 个考察点。只列已经存在的代码、测试和产物；没有的写「未完成」，不用计划路径冒充证据。视频时间码和文档页码要等材料制作时填写。

| ID | 考察点（权重） | 代码 | 测试 / 记录 | 视频时间码 | 文档页码 | 状态 |
|---|---|---|---|---|---|---|
| R01 | 大模型集成（8） | lib/server/llm.ts、subject.ts、judge.ts、guard.ts | 10-19 百炼真实试跑 7 轮（docs/pilot-log.md）：被测角色、测试 Agent、裁判、护栏四个角色都跑通；结构化输出校验与重试；11-10 加了备用模型（主模型限流、出错、超时时换备用模型再试一次，默认不设，换过的次数记进运行清单，单元测试；ADR-043） | 未完成 | 未完成 | 部分内部验证 |
| R02 | Agent/工作流（8） | lib/server/tester.ts、runs.ts | 10-19 真实试跑里测试 Agent 用 qwen-plus 真实选策略、调用工具（docs/pilot-log.md）；与固定次序对照（E3）11-10 在保留集上跑了：B1 上 Agent 现想攻破 8/18、固定次序 12/18，口令题 Agent 更会套（5/9 对 3/9），角色设定题固定次序更能让她破功（ADR-044） | 未完成 | 未完成 | 部分内部验证 |
| R03 | RAG（6） | lib/server/rag.ts、kb/ | tests/unit/server.test.ts（条文完整、检索、引用校验）；冻结查询集未完成 | 未完成 | 未完成 | 部分内部验证 |
| R04 | 多模态（5） | lib/server/tts.ts、audio-store.ts、lib/client/voice-player.ts、public/audio/、components/VrmAvatar.tsx | tests/unit/audio.test.ts；e2e/voice.spec.ts（Edge 里真实的 AudioWorklet 渲染）；截图 docs/evidence/screenshots/m2/；tests/unit/live-paths.test.ts（真实合成的超时、重试）。真实合成 10-27 内部跑通，首声测量见 ADR-020；语音输入未实现 | 未完成 | 未完成 | 部分内部验证（模拟发声） |
| R05 | 安全可控（4） | lib/server/guard.ts、subject.ts、audio-store.ts（ADR-016～018；真实试跑里规则拦下 4 次真实口令泄漏） | 护栏规则与服务层单元测试；S1 拦下不合成、S3 截断后停止渲染（单元 + 端到端）；端到端「终止」测试 | 未完成 | 未完成 | 部分内部验证 |
| R06 | MCP/工具（4） | lib/server/tester.ts（函数调用） | 10-19 真实试跑里函数调用跑通；11-10 加了 MCP 服务 scripts/mcp-server.ts（三个工具：查条文、跑体检、取结论；单元测试起子进程走一遍协议，ADR-043） | 未完成 | 未完成 | 部分内部验证 |
| R07 | 选题创新（10） | — | 需求核验与外部访谈未完成 | 未完成 | 未完成 | 未完成 |
| R08 | 技术方案创新（8） | subject.ts（S1/S2/S3）、audio-store.ts、lib/audio/intervals.ts | 违规音频渲染时长按采样交集计量：端到端里同一口令句在判决延迟 1000 / 4000 ms 下漏出 0 / 592 ms（模拟发声，机制演示，不是实验结果）；E2 11-10 真实模型每组 3 次：护栏真实速度下都不漏，固定延迟 1 / 4 秒时只有先播后截漏（docs/evidence/experiments/voice-1110/，ADR-043） | 未完成 | 未完成 | 部分内部验证 |
| R09 | 交互模式创新（7） | components/Workbench.tsx、Transcript.tsx | 截图 docs/evidence/screenshots/m1/ | 未完成 | 未完成 | 部分内部验证 |
| R10 | 代码质量（4） | 全仓库 | lint、typecheck、单元测试 207 个、端到端 53 个通过（三种尺寸合计，另 28 个按设计跳过；2026-11-08） | 未完成 | 未完成 | 内部验证 |
| R11 | 组件与架构（3） | lib/domain（共享）、lib/server、components | UI、评测脚本共用 runs.ts 服务 | 未完成 | 未完成 | 内部验证 |
| R12 | 前端性能（3） | components/Avatar.tsx（next/dynamic 懒加载）、VrmAvatar.tsx（帧率写在 data-fps）；音频在 AudioWorklet 线程 | e2e/vrm.spec.ts 用示例模型验证过加载和画面在动；规定设备的加载时间和帧率未测 | 未完成 | 未完成 | 已实现未验证 |
| R13 | 真实场景（5） | — | 外部角色作者需求未核验 | 未完成 | 未完成 | 未完成 |
| R14 | 方案有效性（5） | — | 与手工测试对比未完成 | 未完成 | 未完成 | 未完成 |
| R15 | UI 视觉（4） | app/globals.css（设计变量）、components/ui.tsx | 三种尺寸截图 | 未完成 | 未完成 | 部分内部验证 |
| R16 | 前端交互（3） | Workbench.tsx（开始/暂停/继续/终止、标签页） | 端到端测试 | 未完成 | 未完成 | 部分内部验证 |
| R17 | AI 交互（3） | 事件流实时展示、阶段状态 | 模拟模式验证 | 未完成 | 未完成 | 部分内部验证 |
| R18 | 社会价值（5） | 退出、身份、未成年、危机四类用例；报告「测不到的义务」「局限」；危机求助服务层兜底（ADR-017） | 真实试跑里四类都跑过（草稿题）；文档里的社会价值章节未写 | 未完成 | 未完成 | 部分内部验证 |
| R19 | 商业潜力（5） | — | 单次成本：保留集 B2 一次（28 题、文字）按模型分开记的用量 × 2026-11-10 官网单价约 0.041～0.042 元（ADR-044）；语音合成单价待核对 | 未完成 | 未完成 | 未完成 |
