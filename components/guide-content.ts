// 「用法」页（components/Guide.tsx）上的字和图：每一页一句话、至多三条小字、一张图，文字里用「」引到的按钮和链接。
// 只放数据、不带界面代码：单元测试（tests/unit/guide.test.ts）查字数、查「引到的按钮都登记了」，
// 端到端测试（e2e/guide.spec.ts）拿 ui 到各页核对这些按钮、链接真的还在——谁改了按钮上的字，测试直接报错。
// 端到端测试也会载入这个文件，所以这里用相对路径引用，不用 @/ 别名。

import { LEVELS, TIERS } from "../lib/domain/levels";
import { FATES_PAGE } from "../lib/server/guide";

/** 文字里引到的一个按钮或链接：name 是上面的字，整串一样或者是开头（「一键演示（约一分钟）」也算「一键演示」） */
export interface UiRef {
  role: "button" | "link";
  name: string;
}

/** 截图哪几边是从页面中间截断的：那几边淡出，看得出是有意截的 */
export type Fade = "bottom" | "right" | "both" | "none";

/** 用法页上的一项：一个页面 */
export interface Entry {
  href: string;
  /** 和顶栏导航上的名字一字不差（小实验和原理页上的入口同名） */
  name: string;
  /** 一句话，不超过 25 个字（单元测试守着） */
  line: string;
  /** 至多三条 */
  points: string[];
  /** line、points 里用「」引到的按钮、链接（单元测试、端到端测试守着） */
  ui: UiRef[];
}

/** 六个主要页面：每页再配一张图 */
export interface Module extends Entry {
  /** public/guide/ 下的图，宽高见 SHOT */
  shot: string;
  alt: string;
  fade: Fade;
}

/** 截图都是 16 : 10，导出成 960 × 600（scripts/guide-shots.ts） */
export const SHOT = { width: 960, height: 600 };

/** 先从这两页开始 */
export const MAIN: Module[] = [
  {
    href: "/workbench",
    name: "体检工作台",
    shot: "/guide/workbench.webp",
    alt: "体检工作台中间的对话：测试 Agent 套口令，琪叶桃的原话被划掉、盖了「拦」",
    line: "点「开始体检」，看她哪句越界、哪句被拦。",
    points: ["测试 Agent 换着法子套她的话", "跑完出体检单，能导出 PDF", "赶时间：点「一键演示」，约一分钟看完一遍"],
    ui: [
      { role: "button", name: "开始体检" },
      { role: "button", name: "一键演示" },
    ],
    fade: "bottom",
  },
  {
    href: "/play",
    name: "打字闯关",
    shot: "/guide/play.webp",
    alt: "打字闯关：琪叶桃和她身前的四层防守",
    line: "换你来套她的话，看四层防守哪一层拦住你。",
    points: [
      // 关名、层名直接取闯关页用的那一份（lib/domain/levels.ts），改了名这里跟着变
      `三关：${LEVELS.map((l) => l.title).join("、")}`,
      `四层：${TIERS.map((t) => t.short).join("、")}`,
      "点「说」讲完，看一眼再点「发送」；或点「看 AI 来套话」",
    ],
    ui: [
      { role: "button", name: "说" },
      { role: "button", name: "发送" },
      { role: "button", name: "看 AI 来套话" },
    ],
    fade: "bottom",
  },
];

/** 想看得更细 */
export const MORE: Module[] = [
  {
    href: "/suites",
    name: "用例库",
    shot: "/guide/suites.webp",
    alt: "用例库：每道题的编号、类别、审核状态、输入和期望",
    line: "体检考的每道题：问什么、期望怎么答、依据哪条。",
    points: ["审核过的题才算数，草稿题只能预览"],
    ui: [],
    fade: "bottom",
  },
  {
    href: "/runs",
    name: "运行记录",
    shot: "/guide/runs.webp",
    alt: "运行记录：每次体检一行，A、B 各选一次做前后对比",
    line: "每次体检都留档，挑两次比一比改了什么。",
    points: ["每行的「打开」：看那次的体检单", "A、B 各选一次，点「前后对比」"],
    ui: [
      { role: "link", name: "打开" },
      { role: "button", name: "前后对比" },
    ],
    // 整个表格的外框都在图里（截图时拿掉了中间几列），哪一边都不是从页面中间截断的：不淡出
    fade: "none",
  },
  {
    href: "/map",
    name: "攻防地图",
    shot: "/guide/map.webp",
    alt: "攻防地图：测试了几题、守住了几题、没守住几题，下面七项检查各守住几题",
    line: "先看哪项没守住，再点进去看对应的问题和原话。",
    points: ["全从跑完的体检里数出来，不另外调用模型", "点「三档对照」：只有人设、加边界提示、再加护栏"],
    ui: [{ role: "link", name: "三档对照" }],
    fade: "both",
  },
  {
    href: "/settings",
    name: "原理",
    shot: "/guide/settings.webp",
    alt: "原理：一次体检的七步，从测试 Agent 出招到体检单",
    line: "一次体检怎么跑：七步，从出招到体检单。",
    points: ["每一步都写了在哪里能看到", "用了哪些模型、条文从哪来"],
    ui: [],
    fade: "none",
  },
];

/** 小实验（原理页下面也有入口）：一行小卡，不配图（缩到卡片里图上的字认不出来，也不该和六个页面一样显眼）。字里的「审」「说」是两个步骤，不是按钮 */
export const LAB: Entry = {
  href: FATES_PAGE.href,
  name: FATES_PAGE.name,
  line: "同一句套话问三遍，只换「审」和「说」的先后。",
  points: [],
  ui: [],
};
