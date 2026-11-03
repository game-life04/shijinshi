// 护栏校准：拿校准集（eval/calibration/guard.json）里的每一句过一遍护栏（规则 + 模型），数误拦和漏拦。
//   真实模型：npx tsx --env-file=.env.local scripts/guard-calibrate.ts --yes [--repeat 3] [--split blind] [--guard 另一份护栏模块]
// 每句跑 repeat 遍（模型有随机性，温度 0 也不保证完全一样），按多数结果算。结果写到 eval/out/guard-calib-<时间>.json（不进仓库）。
// 校准集分三份：tune 是调护栏时看的；check 是改之前写好的新说法；blind 是另一个助手只按条文写、没看护栏代码的句子（各份的来历见 guard.json 的 note）。
// --guard 用来拿旧版护栏（例如 git show 出来的改前版本）跑同一批句子，做前后对比。
// 校准集是 CC 起草的草稿，用来改护栏时做前后对比；正式的误拦率以队员 B 的开发集、保留集为准。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { checkSentence as CheckSentence } from "../lib/server/guard";
import { isLive, UsageMeter } from "../lib/server/llm";

interface Item {
  id: string;
  split?: "tune" | "check" | "blind" | "blind2";
  rule: string;
  user: string;
  sentence: string;
  expect: "block" | "pass";
}

interface Row {
  id: string;
  split: string;
  rule: string;
  expect: string;
  blocks: number;
  got: "block" | "pass";
  reasons: string[];
  dismissed: string[];
}

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const repeat = Math.max(1, Number(arg("--repeat") ?? "1"));
const CONCURRENCY = 4;

async function judge(checkSentence: typeof CheckSentence, it: Item, meter: UsageMeter): Promise<Row> {
  let blocks = 0;
  const reasons: string[] = [];
  const dismissed: string[] = [];
  for (let k = 0; k < repeat; k++) {
    const d = await checkSentence(it.sentence, { history: [{ role: "user", text: it.user }], canary: "QYT-ABC123" }, meter);
    if (!d.ok) {
      blocks++;
      reasons.push(`${d.hit?.rule}/${d.hit?.by}：${d.hit?.reason}`);
    }
    if (d.dismissed) dismissed.push(d.dismissed);
  }
  const got = blocks * 2 > repeat ? "block" : "pass";
  return { id: it.id, split: it.split ?? "tune", rule: it.rule, expect: it.expect, blocks, got, reasons, dismissed };
}

async function main() {
  const all = (JSON.parse(readFileSync(path.join("eval", "calibration", "guard.json"), "utf8")) as { items: Item[] }).items;
  const only = arg("--split");
  const items = only ? all.filter((it) => (it.split ?? "tune") === only) : all;
  const guardModule = arg("--guard") ?? "../lib/server/guard";
  const { checkSentence } = (await import(guardModule)) as { checkSentence: typeof CheckSentence };
  if (arg("--guard")) console.log(`护栏模块：${guardModule}`);
  const live = isLive();
  console.log(`校准集 ${items.length} 句 × ${repeat} 遍；${live ? "真实模型" : "模拟数据（只跑规则，不调用模型）"}`);
  if (live && !process.argv.includes("--yes")) {
    console.log("真实模型要花钱：确认后加 --yes 再跑。");
    return;
  }
  const meter = new UsageMeter(items.length * repeat * 3 + 10);
  const rows: Row[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const i = next++;
        rows[i] = await judge(checkSentence, items[i], meter);
      }
    }),
  );
  await meter.drain();
  for (const [i, r] of rows.entries()) {
    const mark = r.got === r.expect ? "    " : r.got === "block" ? "误拦" : "漏拦";
    const why = r.reasons[0] ?? (r.dismissed[0] ? `（没拦）${r.dismissed[0]}` : "");
    console.log(`${mark} ${r.id} 拦 ${r.blocks}/${repeat}  ${items[i].sentence}${why ? `  ← ${why.slice(0, 80)}` : ""}`);
  }
  console.log("");
  for (const split of ["tune", "check", "blind", "blind2"]) {
    const part = rows.filter((r) => r.split === split);
    if (!part.length) continue;
    const fp = part.filter((r) => r.expect === "pass" && r.got === "block");
    const fn = part.filter((r) => r.expect === "block" && r.got === "pass");
    const nPass = part.filter((r) => r.expect === "pass").length;
    const nBlock = part.filter((r) => r.expect === "block").length;
    console.log(
      `${split}：误拦 ${fp.length}/${nPass}（该放行的被拦）；漏拦 ${fn.length}/${nBlock}（该拦的放了）${
        fp.length + fn.length ? `  → ${[...fp, ...fn].map((r) => r.id).join(" ")}` : ""
      }`,
    );
  }
  console.log(`模型调用 ${meter.usage.llm_calls} 次`);
  const out = path.join(
    "eval",
    "out",
    `guard-calib-${new Date()
      .toISOString()
      .replace(/[-:T.Z]/g, "")
      .slice(0, 14)}.json`,
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify({ live, repeat, label: arg("--label") ?? null, guard: guardModule, rows, usage: meter.usage }, null, 2),
    "utf8",
  );
  console.log(`已存：${out}`);
}

void main();
