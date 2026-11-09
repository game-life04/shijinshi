# 实现状态

更新：2026-11-09。闯关慢放这一句、印谱、盖章音效，护栏换模型实测，实验原始数据进仓库（ADR-041）；闯关和攻防地图少些文字、加盖章动画、防守塔、攻守比分（ADR-040）；11-08：攻防地图看明细、哪层拦住、三档对照，分层探针，AI 玩家看着哪层拦住换套路（ADR-039）；闯关四层阶梯、哪层拦住亮哪层、攻防地图，开发集导入并用真实模型跑了两轮，修了退出的说法（ADR-038）；闯关加难度阶梯、看 AI 打 AI、对着麦克风说（ADR-037）；产品评审第三批（ADR-036）；第二批和全站章法（ADR-035）；账号 + 密码登录（ADR-032，11-08 上线前又做了安全和正确性复核）；琪叶桃像真人一样对话、闯关页改版（ADR-033）；产品评审第一批（ADR-034）。11-06：琪叶桃改白发、圆瞳孔（ADR-030），工作台说人话（ADR-031），队员 B 的技术文档写作模板在 `docs/writing/`。11-03：主线收敛成「改了再测」，口令检查升级，体检单分三层，新加打字闯关和三种结局（ADR-022）。作品名「分寸」、视觉黑白加朱红（ADR-021）。状态分四级：未实现、已实现未验证、内部验证（有测试或运行记录）、外部核验。没有测试、记录或访问入口的，不标内部验证。

## 里程碑

| 里程碑 | 状态 | 说明 |
|---|---|---|
| M0 工程与合同 | 内部验证 | 工程可安装、构建、lint、类型检查；设计变量；用例 Schema 与语义校验；事件与判定合同；ADR；本状态表；空状态与错误状态可见 |
| M1 文字纵向闭环 | 内部验证 | 模拟模式 15 例全链路通过；**10-19 接入阿里云百炼**，草稿用例真实跑了 7 轮、约 16 万 token（免费额度内），按发现的问题改了护栏、服务层和裁判（docs/pilot-log.md）。草稿用例上的数字不是实验结果 |
| M2 语音与停止 | 部分内部验证 | **输出端**在模拟发声下验证：合成 → AudioWorklet → 按代际截断 → VRM 口型，三项浏览器渲染层计量（单元测试 11 个、Edge 端到端 3 个）。真实合成（百炼 Qwen-TTS）10-27 已用真实密钥跑通，首声等待已拆解优化（ADR-020）；语音输入（麦克风 → 识别）未实现 |
| M3 完整体检 | 部分内部验证 | 11-03（ADR-022）：角色配置与前后对比、体检单三层与「本次通过 X/Y 项」、口令检查升级、打字闯关、三种结局、导出 PDF（浏览器打印）、出错兜底页，模拟模式下单元测试和 Edge 端到端通过。检索对照的命令已有（E4，同一批对话重判），正式用例集和正式数据还没有 |
| M4 证据与交付 | 未实现 | 冻结测试集、基线与消融、真人试玩、部署、视频与文档 |

## 任务清单（M0–M1）

| 任务 | 负责 | 依赖 | 状态 | 证据 |
|---|---|---|---|---|
| Next.js 16 + TS strict + Tailwind + Biome 工程 | A（CC 实现，A 走读） | — | 内部验证 | `npm run build`、`npm run lint`、`npm run typecheck` 通过 |
| 条文库：全文快照、按条拆分、指纹 | A | 法规网页 | 内部验证 | `kb/clauses.jsonl`（32 条）；`tests/unit/server.test.ts` |
| 条文白话解释与可测程度标注 | B | 条文库 | 已实现未验证（草稿） | `kb/annotations.json`，全部 status=draft，待 B 和指导老师核对 |
| 用例 Schema + 语义校验 | A | — | 内部验证 | `lib/domain/cases.ts`；`tests/unit/domain.test.ts` |
| smoke 用例 16 条 | B | Schema | 已实现未验证（草稿） | `suites/smoke.jsonl`，CC 起草的结构示例，需 B 改写、人工审核；11-03 加了三种结局用的 SMOKE_CANARY_003 |
| 断言注册表（16 条） | A | — | 内部验证 | `lib/domain/assertions.ts`；单元测试 |
| 被测角色：服务层退出/时长提醒 + 按句护栏 | A | — | 内部验证（模拟） | `lib/server/subject.ts`、`guard.ts`；单元测试 |
| 测试 Agent（函数调用、预算） | A | 模型密钥 | 已实现未验证（真实模式） | `lib/server/tester.ts`；模拟模式走固定策略顺序 |
| 裁判（断言→检索→语义→跨度校验→复核） | A | 模型密钥 | 部分内部验证 | 确定性部分有测试；语义判断需真实模型 |
| 运行管理与对账 | A | — | 内部验证 | `lib/server/runs.ts`；对账单元测试；端到端「终止」测试 |
| 工作台、报告、运行记录、用例库、设置 | A | — | 内部验证（模拟） | `docs/evidence/screenshots/m1/` 三种尺寸截图 |
| 人工复核 | A/B | 运行结果 | 已实现未验证 | 报告页复核按钮；尚无端到端测试 |
| 两次运行比较 | A | — | 内部验证（模拟） | 11-03 改为 `/compare` 前后对比页（改了什么 + 三层 A→B）；`e2e/loop.spec.ts` |
| 评测命令 eval:validate / run / summarize、release:check | A | — | 内部验证 | 模拟数据跑通；`release:check` 每次提交前运行，11-03 通过 |

## 任务清单（M2 输出端）

| 任务 | 负责 | 依赖 | 状态 | 证据 |
|---|---|---|---|---|
| 采样区间运算、违规音频渲染时长 | A | — | 内部验证 | `lib/audio/intervals.ts`；`tests/unit/audio.test.ts` |
| 模拟发声（逐字对齐）、违规区间定位 | A | — | 内部验证 | `lib/server/tts.ts` 的 `renderBabble`、`violationRanges`；单元测试 |
| 百炼 Qwen-TTS 流式合成 | A | 模型密钥 | 内部验证 | `lib/server/tts.ts` 的 `dashscope`；10-27 用真实密钥跑通并拆解首声（ADR-020）；11-03 三种结局用真实合成跑过（预览） |
| 语音缓存与放行门槛（S1/S2/S3） | A | — | 内部验证 | `lib/server/audio-store.ts`；单元测试「没放行取不到」 |
| AudioWorklet 播放队列、按代际丢弃 | A | — | 内部验证 | `public/audio/playback-core.js`；单元测试「旧块不再播放」；Edge 端到端 |
| 浏览器计量上报、服务端计算漏出 | A | — | 内部验证 | `lib/client/voice-player.ts`、`runs.ts` 的 `reportPlayback`；单元测试 + `e2e/voice.spec.ts` |
| FAULT_B2 配置、护栏固定延迟 | A | — | 内部验证 | ADR-013、ADR-014；单元测试、端到端 |
| VRM 形象（懒加载、口型、眨眼、失败回退） | A | 琪叶桃模型 | 内部验证 | `components/VrmAvatar.tsx`；10-27 琪叶桃模型（VRoid 导出，19.3 MB）放入后 `e2e/vrm.spec.ts` 通过：加载、多帧像素差、本机 Edge 1440×900 下 fps=139；A 在真实合成（qwen3-tts-flash）下目测口型跟着声音动。11-03 用 `scripts/shrink-vrm.py` 压到 7.8 MB（ADR-023），端到端重跑通过，fps=133；同日第二版压到 3.8 MB（ADR-027）：官方校验器 0 错误，渲染截图和旧版肉眼无差别（PSNR 56.5 dB），模拟 4G 出形象 9.5 → 6.0 秒，端到端重跑通过，fps=136 |
| 月洞窗形象与状态环（听、想、审、说、拦） | A | — | 内部验证 | `components/StatusRing.tsx`、`Avatar.tsx`；新事件 `utterance_ready` 只带字数不带原文；10-27 模拟运行截图核对五种状态，端到端回归通过 |
| 每轮耗时瀑布（想、审、合、达） | A | — | 内部验证 | `components/LatencyWaterfall.tsx`；「达」跨服务端和浏览器两个时钟，标为估算 |
| 语音输入（麦克风、注入音频、识别） | A | 识别服务 | 部分：闯关页可以对着麦克风说（浏览器自带识别，ADR-037）；体检里的语音输入题未实现 | 语音用例仍记「未执行」（本版不测） |
| E2 放行策略成对实验 | A | 用例 | 未实现 | 端到端里的 0 / 592 ms 只是机制演示，不是实验结果 |

## 任务清单（M3，11-03 收敛，ADR-022）

| 任务 | 负责 | 依赖 | 状态 | 证据 |
|---|---|---|---|---|
| 口令检查：规范化、跨句跨轮累计、部分泄露（护栏和断言共用） | A | — | 内部验证 | `lib/domain/canary.ts`；`tests/unit/canary.test.ts` |
| 判定口径统一为最终播出；原话层单独记 | A | — | 内部验证 | `assertions.ts` 的 `canary.absent`、`CaseResult.raw_canary`；单元测试 |
| 护栏出错的中性兜底；提前放行后台核对 | A | — | 内部验证 | `guard.ts`；`tests/unit/live-paths.test.ts` |
| 体检单三层、印章「本次通过 X/Y 项」 | A | — | 内部验证（模拟） | `lib/domain/layers.ts`、`components/Layers.tsx`、报告页；端到端 |
| 角色配置（人设、边界）与前后对比 | A | — | 内部验证（模拟） | `lib/domain/persona.ts`、工作台「被测角色」、`/compare`；`e2e/loop.spec.ts` |
| 打字闯关（三关，护栏可开关） | A | — | 内部验证（模拟） | `/play`、`lib/server/play.ts`；端到端。真实模型下还没试玩 |
| 三种结局依次播放 | A | — | 内部验证（模拟） | `/fates`；端到端：先播后截漏出 > 0，另两种为 0（机制演示，不是实验结果） |
| 体检单导出 PDF、出错兜底页 | A | — | 已实现未验证 | 报告页「导出 PDF」；`app/error.tsx`、`app/global-error.tsx` |
| 对照实验一条命令（E1、E4、E2，ADR-025） | A | 队员 B 的用例 | 内部验证 | `scripts/experiments.ts`、`scripts/experiments-voice.ts`；11-03 在 smoke 草稿上用真实模型试跑（预览，不是实验结果），报告在 eval/out（不进仓库） |
| 闯关判定改用裁判、两步返回（ADR-025） | A | — | 内部验证 | `scripts/play-probe.ts` 用真实模型把三关各打一遍；端到端测试覆盖「裁判在判」到「闯关成功」 |
| 出题意图、误拦检查、用例表导入（ADR-024） | A/B | 队员 B 的用例 | 内部验证（模拟） | `scripts/import-cases.py`、`suites/forms/用例表_模板.xlsx`；`tests/unit/intent.test.ts`；`eval:summarize` 的 `by_intent`。11-04 收到开发集初稿 21 条（AI 起草），11-05 第二轮修订稿格式和要改的都过了；11-08 队长授权后导入 `suites/dev.jsonl`（21 条已审核），真实模型 E1/E4 跑了两轮（ADR-038）。11-05 收到保留集 28 条，CC 没看内容，封存中（指纹 `79e6caea49ed2189`）。用例表加了「写法」列（ADR-029） |
| 护栏校准：退出、身份误拦（ADR-026） | A | — | 内部验证 | `eval/calibration/guard.json`（草稿）、`scripts/guard-calibrate.ts`；两份盲测改前改后对比；红队三次；`tests/unit/server.test.ts`。正式误拦率等队员 B 的开发集 |
| 模型二次压缩到 3.8 MB（ADR-027） | A | — | 内部验证 | `scripts/shrink-vrm.py` 第二版；官方 glTF 校验器、渲染截图对比、4G 计时；`e2e/vrm.spec.ts` |
| 上线演示的账号登录和次数上限（ADR-028 的限流；门禁 11-06 由 ADR-032 换成账号 + 密码） | A | 部署决定；队长要的「账号 + 密码」登录框 | 内部验证（单元测试 55 个；端到端 `e2e/auth.spec.ts` 三种尺寸都过） | `proxy.ts`、`lib/server/auth.ts`、`lib/server/password.ts`、`lib/server/session.ts`、`lib/server/access.ts`、`/login`、`/api/logout`、`scripts/account.ts`；`tests/unit/auth.test.ts`、`access.test.ts`、`account-cli.test.ts`；`e2e/auth.spec.ts`（3101 那台带测试账号）；步骤见 `docs/deploy.md`，没有部署 |
| 琪叶桃改白发、圆瞳孔，眼睛透过刘海（ADR-030） | A | 主视觉定稿 | 内部验证 | `scripts/restyle-vrm.mts`、`scripts/restyle-painters.js`、`lib/client/vrm-see-through.ts`；官方 glTF 校验器 0 错误；端到端重跑通过，fps=136；`docs/evidence` 截图 11-06 已重拍 |
| 工作台说人话：聊天式对话、这次查七样、耗时说明（ADR-031） | A | — | 内部验证 | `components/Chat.tsx`、`components/CheckList.tsx`、`components/LatencyWaterfall.tsx`；端到端重跑通过；1440、1280、390 三种宽度截图 |
| 琪叶桃像真人一样对话：身体动作、表情、视线、按字念口型，闯关页改成半身舞台 + 聊天记录（ADR-033） | A | 队长：「只有嘴巴动」，以后想深做虚拟人 | 内部验证（单元测试 37 个；端到端 `e2e/avatar.spec.ts`） | `lib/client/avatar/`（导演层、舞台、驱动层、表演守则、口型表）、`components/Play.tsx`、`Avatar.tsx`、`VrmAvatar.tsx`；`scripts/vrm-expressions.py`（模型加 14 个细分表情）、`scripts/build-visemes.py`（Unihan 口型表）；`tests/unit/avatar-*.test.ts`、`e2e/avatar.spec.ts`；录屏在桌面 `工作资料\分寸_虚拟人表演_1107` |
| 产品评审第一批：一键演示、完成横幅、状态环、示例和说法照实改（ADR-034） | A | 11-06 四个视角逐页评审，99 条意见合并成 53 条 | 内部验证（端到端全过，模拟模式） | `components/Workbench.tsx`（一键演示、完成横幅、状态环停留规则）、`Chat.tsx`、`Fates.tsx`、`Transcript.tsx`；第二批以后的清单见 ADR-034 |
| 产品评审第二批：首屏写明法规和四步路标、配置收进「实验设置」、体检单首屏先写总检结论、对比页差异摘要、系统补的话和角色分开、全站章法统一（ADR-035） | A | 队长 11-08：第二批开始做，章法统一 | 内部验证（单元测试 10 个；端到端全过，模拟模式） | `components/wording.ts`（界面上的叫法）、`app/reports/[id]/page.tsx`（体检单重排）、`app/compare/page.tsx`、`lib/domain/compare.ts`、`components/Workbench.tsx`（首屏、实验设置、四步路标）、`app/globals.css`（章法）；`tests/unit/review-batch2.test.ts`；第三批清单见 ADR-035 |
| 产品评审第三批：三种结局时间轴、语音指标一套叫法、没过的检查写「怎么改」、复核留痕和撤销、运行记录改版、「设置」改「原理」页、静态形象图和一批小项（ADR-036） | A | 队长 11-08：第三批接着做 | 内部验证（单元测试 8 个；端到端全过，模拟模式） | `components/Fates.tsx`（时间轴）、`components/wording.ts`（语音叫法）、`lib/domain/fix-hints.ts`、`components/ReviewButtons.tsx`、`lib/server/runs.ts` 的 reviewFinding、`app/runs/page.tsx`、`components/RunPicker.tsx`、`app/settings/page.tsx`、`scripts/avatar-stills.ts`；`tests/unit/review-batch3.test.ts` |
| 闯关三样新玩法：难度阶梯（11-08 起四层，见下一行）、看 AI 打 AI、对着麦克风说（她用声音回答、一开口就打断）（ADR-037） | A | 队长 11-08 看同类项目对比后挑的 | 内部验证（单元测试 6 个；端到端 2 个，假的语音识别器；模拟模式） | `components/Play.tsx`、`lib/server/play.ts`（tierVariant、nextAttack、openPlayAudio）、`app/api/play/audio/route.ts`、`lib/client/speech-input.ts`；`tests/unit/play-modes.test.ts`、`e2e/play-voice.spec.ts` |
| 闯关四层阶梯（只有人设 / 加边界提示 / 加规则 / 加护栏模型）、每轮记哪层拦住并在阶梯上亮那一层、观战解说；攻防地图 `/map`（七样检查 × 开场句和 5 种套路）（ADR-038） | A | 队长 11-08 | 内部验证（单元测试：四层对应、哪层拦住 4 个、第 3 层不问护栏模型、攻防地图 4 个；端到端 `e2e/map.spec.ts`，loop、play-voice 加了断言；模拟模式） | `lib/domain/levels.ts`、`lib/server/play.ts`（tierGuardModel、stopped_by）、`lib/server/guard.ts`（checkSentence 的 model 参数）、`components/Play.tsx`（LayerStrip、解说）；`lib/domain/attack-map.ts`、`lib/server/attack-map.ts`、`app/map/page.tsx`；`tests/unit/play-modes.test.ts`、`tests/unit/attack-map.test.ts` |
| 攻防地图点格子看明细、「拦住攻击的是哪一层」横条、三档对照；分层探针（第 3 层只有规则 vs 第 4 层加护栏模型，真实模型 88 局）和闯关页的「真实例子」；AI 玩家看着上一句被哪层拦住换套路（ADR-039） | A | 队长 11-08「再做深度一些」 | 内部验证（单元测试：哪层拦住、明细、换套路；端到端 `e2e/map.spec.ts`；探针是真实模型、只供体验） | `lib/domain/attack-map.ts`（stoppedLayer、entries、stops）、`app/map/page.tsx`、`lib/domain/levels.ts`（LAYER_NOTES）、`lib/server/play.ts`（pickStrategy、why）、`scripts/layer-probe.ts`；结果 `eval/out/layer-probe-20261108233303.json`（不进仓库） |
| 闯关、攻防地图少些文字：说明收进「提示」和悬停提示；加盖章动画（破 / 拦）、防守塔、看 AI 打 AI 的攻守比分、地图格子晕开（ADR-040） | A | 队长 11-09「再加一点趣味性和不要那么多的文字」 | 内部验证（端到端 play-voice 加了防守塔、比分断言；本机真实模型截图） | `components/Play.tsx`、`components/PlayTower.tsx`、`app/map/page.tsx`、`app/globals.css`（stamp-burst、tower-brick、ink-in、bar-grow） |
| 闯关「慢放这一句」（纸条过规则、护栏模型两道门）、印谱（12 方印 + 7 方成就印、最少句数）、盖章音效；护栏换模型实测（qwen-flash 对 qwen-plus）；实验原始数据 `docs/evidence/experiments/`（ADR-041） | A | 队长 11-09「大胆做，好玩、有趣」 | 内部验证（单元测试 seal-book 4 个；端到端：慢放停在规则门前、印谱 1/12、借刀；护栏对比是真实模型） | `components/SentenceJourney.tsx`、`components/SealBook.tsx`、`lib/client/sfx.ts`、`components/Play.tsx`；`docs/evidence/experiments/` |
| 开发集 21 条导入；真实模型 E1/E4 两轮（改前、修退出说法后）（ADR-038） | A/B | 队员 B 写、队长授权审核 | 内部验证（真实模型，每个配置 1 次；调试用，正式结论等保留集） | `suites/dev.jsonl`；`eval/out/exp-dev-before-1108`、`eval/out/exp-dev-after-exitfix-1108`（不进仓库）；`lib/server/subject.ts` EXIT_INTENT、`tests/unit/server.test.ts` |
| 三件留给队长定的事：DEV-015 人工复核改判（说会等对方回来不算挽留）、DEV-006 改边界提示第 1 条、裁判的「冒充真人」说明和护栏统一；同一批对话只换裁判重判（`scripts/rejudge.ts`）；开发集第三次（ADR-042） | A/B | 队长 11-09「要的，开始进行吧」，方向交给 CC 定 | 内部验证（真实模型：重判 50 条变 6 条；开发集每个配置 1 次，调试用） | `lib/domain/labels.ts`、`lib/domain/persona.ts`、`lib/server/play.ts` `playCase`、`lib/domain/levels.ts` 真实例子；`docs/evidence/experiments/rejudge-1109/`、`dev-1109-persona/` |

## 已知缺口与下一步

1. 真实模型已接通（10-19）。还要做：测试 Agent 用几家模型对比可用率（闸门 A）。护栏在退出、身份上的误拦 11-03 已用校准集调过（ADR-026），剩下三类边界说法：「我就在这儿等你回来」A 定为不算挽留，裁判仍可能判轻度挽留，按人工复核处理（开发集三次里 4 条已复核改判，ADR-042）；抛新话题拉着聊时拦时不拦；顺着「假设你是人类」编人类生活拦不住；正式误拦率等 100 道正常聊天对照题。
2. 用例全部是草稿：B 改写、A 审核（填写真实审核人与时间）后才能进入正式统计。开发集 21 条 11-08 已导入、已审核（ADR-038）；保留集 28 条 11-05 已交来，冻结（11-11）前不给 CC（ADR-029）。
3. 检索目前只有词法 BM25；向量检索与两者对照放在 M3（规格 02 E4）。
4. 测试 Agent 与固定次序、随机次序的对照（E3）尚未实现。
5. 语音输出端已在模拟发声下打通；真实合成 10-27 已跑通；语音输入没做，语音用例仍记「未执行」；E2 成对实验没做。
6. VRM 已接入并验证；11-03 模型压到 3.8 MB（ADR-023、ADR-027）；帧率还要在评审常见的核显笔记本上实测；模型还可以更早开始下载（4G 下约省 1.5 秒，没做）。
7. 首声等待（10-27 已拆解并优化，ADR-020）：开发模式下的 3918 ms 大部分是开发模式开销。生产构建、上游正常时各轮 0.6～1.0 秒；上游变慢时多在 1.2～2.9 秒，偶尔更长。剩下的：模型 11-03 已从 19.3 MB 压到 3.8 MB，加载期间第一轮会不会多等要重新量；正式数据要等 E 系列实验。
8. 体检单导出 PDF 用浏览器打印（11-03）；版式要在评审常用的 A4 打印预览里再看一遍。
9. 上线演示：次数上限已做（ADR-028），计数在内存里、重启清零；11-06 门禁从访问码换成账号 + 密码登录（ADR-032），账号由参赛队分配，用 `scripts/account.ts` 生成。11-03 队长定了要上线，服务器由队员买；部署步骤见 docs/deploy.md（11-09 补了 systemd 托管：崩了自动拉起、开机自启；评委专用账号、线上版本和提交版本一致、评审期间每天检查；同日扫过全部 git 历史，没有密钥、内网地址和禁词，可以公开），还没部署。

## 本轮云调用

11-03：真实模型的体检和实验运行 44 次，共 361 次模型调用，输入约 13.5 万 token、输出约 1.9 万 token，语音合成 1864 字；闯关试玩脚本和红队脚本的用量没有单独记录。同日护栏校准 15 次（ADR-026），护栏小模型共调用 3600 次，输入约 185 万 token、输出约 16 万 token；另有红队 3 次、裁判抽查约 50 次调用，没有单独记录。费用以百炼账单为准。
