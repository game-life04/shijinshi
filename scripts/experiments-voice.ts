// 三种放行方式的对照（规格 02 E2；ADR-025）：用浏览器反复打开「三种结局」页，
// 每次按先播后截、先审后播、边审边合成依次播放，记下浏览器实际渲染的声音——违规音频漏出多少毫秒、多久才开口。
//   npm run build   （先构建一次）
//   npm run experiments:voice -- [--runs 3] [--delays 0,4000] [--yes]
// 脚本自己起一个生产服务（端口 3300），用本机 Edge 打开页面，跑完关掉。
// 「护栏固定延迟」是实验设定（模拟护栏判得慢的时候），每组三遍用同一个值；0 就是按真实速度。
// 正式计数前空跑一次预热；之后每次轮换播放次序（?order=），消除先后顺序的影响。
// 真实模型、真实合成要花钱：没加 --yes 时只打印计划。结果：eval/out/exp-voice-<时间>/report.md、summary.json。

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { isLive } from "../lib/server/llm";

function arg(name: string, fallback: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const runs = Math.max(1, Number(arg("runs", "3")));
const delays = arg("delays", "0,4000")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x >= 0);
const PORT = 3300;
const BASE = `http://127.0.0.1:${PORT}`;
const stamp = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, "")
  .slice(0, 14);
const outDir = arg("out", path.join("eval", "out", `exp-voice-${stamp}`));
const POLICIES = ["S3", "S1", "S2"] as const;
const NAME: Record<(typeof POLICIES)[number], string> = { S3: "先播后截", S1: "先审后播", S2: "边审边合成" };

/** 播放次序轮换（拉丁方）：每种方式在第一、二、三遍各出现一次，消除先后顺序的影响 */
const ORDERS = [
  ["S3", "S1", "S2"],
  ["S1", "S2", "S3"],
  ["S2", "S3", "S1"],
] as const;

interface Sample {
  delay: number;
  run: number;
  order: string;
  /** 这一种方式是这次的第几遍（1～3） */
  position: number;
  policy: (typeof POLICIES)[number];
  run_id: string;
  leak_ms: number | null;
  leak_level: string;
  first_audio_ms: number | null;
  level: string;
  state: string;
}

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`${BASE}/api/status`);
      if (res.ok) return;
    } catch {
      // 还没起来
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("服务 60 秒内没起来");
}

function stopServer(p: ChildProcess) {
  if (!p.pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" });
    else p.kill("SIGTERM");
  } catch {
    // 已经停了
  }
}

const num = (x: string | null) => (x === null || x === "" ? null : Number(x));
const med = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

async function main() {
  const live = isLive();
  console.log(
    `计划：护栏固定延迟 ${delays.join(" / ")} ms，每组跑 ${runs} 次，每次三遍；${live ? "真实模型、真实合成" : "模拟数据（模拟发声）"}`,
  );
  if (live && !process.argv.includes("--yes")) {
    console.log("真实模型、真实合成要花钱：确认后加 --yes 再跑。");
    return;
  }
  if (!existsSync(path.join(".next", "BUILD_ID"))) throw new Error("还没构建：先 npm run build");
  mkdirSync(outDir, { recursive: true });

  // 生产服务；模拟模式下把密钥清空，免得 next 从 .env.local 读到
  const env = { ...process.env, ...(live ? {} : { LLM_API_KEY: "" }) };
  const server = spawn(`npx next start -p ${PORT}`, { env, shell: true, stdio: "ignore" });
  const samples: Sample[] = [];
  try {
    await waitForServer();
    const browser = await chromium.launch({ channel: "msedge", args: ["--no-proxy-server", "--autoplay-policy=no-user-gesture-required"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const playOnce = async (delay: number, order: readonly string[]) => {
      await page.goto(`${BASE}/fates?order=${order.join(",")}`);
      await page.getByLabel(/护栏固定延迟/).selectOption(String(delay));
      await page.getByRole("button", { name: "依次播放三种结局" }).click();
      await page.getByRole("button", { name: "停止" }).waitFor({ timeout: 10_000 });
      await page.getByRole("button", { name: "依次播放三种结局" }).waitFor({ timeout: 300_000 });
    };
    // 预热一次不计数：第一遍要建连接、加载形象，算进去会让排在前面的方式吃亏
    console.log("预热一次（不计数）……");
    await playOnce(0, ORDERS[0]);
    for (const delay of delays) {
      for (let run = 1; run <= runs; run++) {
        const order = ORDERS[(run - 1) % ORDERS.length];
        await playOnce(delay, order);
        for (const policy of POLICIES) {
          const card = page.getByTestId(`fate-${policy}`);
          const s: Sample = {
            delay,
            run,
            order: order.join("→"),
            position: order.indexOf(policy) + 1,
            policy,
            run_id: (await card.getAttribute("data-run-id")) ?? "",
            leak_ms: num(await card.getAttribute("data-leak-ms")),
            leak_level: (await card.getAttribute("data-leak-level")) ?? "",
            first_audio_ms: num(await card.getAttribute("data-first-audio-ms")),
            level: (await card.getAttribute("data-level")) ?? "",
            state: (await card.getAttribute("data-state")) ?? "",
          };
          samples.push(s);
        }
        const row = samples
          .slice(-3)
          .map((x) => `${NAME[x.policy]}（第 ${x.position} 遍）漏出 ${x.leak_ms ?? "—"} ms / 首声 ${x.first_audio_ms ?? "—"} ms`);
        console.log(`延迟 ${delay} ms 第 ${run} 次：${row.join("；")}`);
      }
    }
    await browser.close();
  } finally {
    stopServer(server);
  }

  // ---------- 报告 ----------
  const level = samples.find((x) => x.level)?.level;
  const lines = [
    `# 三种放行方式对照 ${stamp}`,
    "",
    `- 数据：${level === "live" ? "真实模型、真实合成" : "**模拟发声，只说明机制，不能当实验结果**"}；每组 ${runs} 次，每次三遍依次播放，同一句话、同一个故障注入角色加护栏`,
    "- 漏出：口令那几个字的音频里，浏览器实际渲染出来的时长（浏览器渲染层，不是扬声器实听；真实合成没有字级时间戳，按整句取上界）",
    "- 首声：发出这句话到第一个有声采样渲染出来；护栏固定延迟是实验设定，模拟护栏判得慢的时候",
    "- 次序：正式计数前先空跑一次预热；之后每次轮换三种方式的播放次序（每种方式轮流排第一、二、三遍），消除先后顺序的影响。次数是 3 的倍数时轮换才完整",
    "",
    "| 护栏固定延迟 | 放行方式 | 有效次数 | 漏出 ms（中位，最小～最大） | 首声 ms（中位，最小～最大） |",
    "|---|---|---|---|---|",
  ];
  for (const delay of delays) {
    for (const policy of POLICIES) {
      const xs = samples.filter((x) => x.delay === delay && x.policy === policy && x.state === "done");
      const leaks = xs.map((x) => x.leak_ms).filter((x): x is number => x !== null);
      const firsts = xs.map((x) => x.first_audio_ms).filter((x): x is number => x !== null);
      const span = (v: number[]) => (v.length ? `${med(v)}（${Math.min(...v)}～${Math.max(...v)}）` : "待测");
      lines.push(`| ${delay} ms | ${NAME[policy]} | ${xs.length} / ${runs} | ${span(leaks)} | ${span(firsts)} |`);
    }
  }
  lines.push("", "- 「有效次数」小于计划次数的，是那一遍没跑完（事件流断开或出错），不计入中位数。");
  writeFileSync(path.join(outDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ stamp, live, runs, delays, samples }, null, 2), "utf8");
  console.log(`\n报告：${path.join(outDir, "report.md")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
