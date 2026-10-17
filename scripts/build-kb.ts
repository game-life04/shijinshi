// 从存档的法规网页快照生成条文库 kb/clauses.jsonl。
// 用法：npx tsx scripts/build-kb.ts
// 原则：条文 text 字段是快照里的原文，不改字；白话解释、可测程度等人工字段单独存放（kb/annotations.json），不和原文混在一起。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = "kb/sources/anthropomorphic-2026.hunan.html";
const SOURCE = {
  law: "人工智能拟人化互动服务管理暂行办法",
  version: "2026-04-10 国家网信办等五部门令第21号",
  promulgated: "2026-04-10",
  effective: "2026-07-15",
  source_url: "https://www.hunan.gov.cn/zqt/zcsd/202604/t20260413_33952856.html",
  source_note: "湖南省人民政府网转载，页面注明信息来源为国家互联网信息办公室网站",
  fetched_at: "2026-10-17",
};

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToInt(s: string): number {
  // 只需要处理到「三十九」
  if (s === "十") return 10;
  const [tens, ones] = s.includes("十") ? s.split("十") : ["", s];
  return (tens ? CN_NUM[tens] : s.includes("十") ? 1 : 0) * 10 + (ones ? CN_NUM[ones] : 0);
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const raw = readFileSync(path.join(ROOT, SNAPSHOT));
const html = raw.toString("utf8");
const text = html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, "\n")
  .replace(/&nbsp;/g, " ")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&")
  .replace(/[ \t　 ]+/g, " ")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

// 正文从「人工智能拟人化互动服务管理暂行办法」标题后的「第一章」开始，到「第三十二条」那一行结束
const start = text.findIndex((l) => /^第一章/.test(l));
const endIdx = text.findIndex((l) => /^第三十二条/.test(l));
if (start < 0 || endIdx < 0) throw new Error("快照里找不到正文起止，网页结构可能变了");
const body = text.slice(start, endIdx + 1);

interface ClauseRow {
  id: string;
  article: number;
  chapter: string;
  text: string;
  content_sha256: string;
}
const clauses: ClauseRow[] = [];
let chapter = "";
for (const line of body) {
  const ch = line.match(/^第[一二三四五六七八九十]+章\s*(.*)$/);
  if (ch) {
    chapter = line.replace(/\s+/g, " ");
    continue;
  }
  const m = line.match(/^第([一二三四五六七八九十]+)条\s*/);
  if (m) {
    const article = cnToInt(m[1]);
    clauses.push({ id: `anthropomorphic-2026:${article}`, article, chapter, text: line, content_sha256: "" });
  } else if (clauses.length) {
    // 同一条的后续款，换行接上
    clauses[clauses.length - 1].text += `\n${line}`;
  }
}
for (const c of clauses) c.content_sha256 = sha256(c.text);

// 校验：条号连续、从 1 到 32
clauses.forEach((c, i) => {
  if (c.article !== i + 1) throw new Error(`条号不连续：第 ${i + 1} 个是第 ${c.article} 条`);
});

const snapshotSha = sha256(raw);
const out = clauses.map((c) => JSON.stringify({ ...SOURCE, ...c, snapshot: SNAPSHOT, snapshot_sha256: snapshotSha }));
writeFileSync(path.join(ROOT, "kb", "clauses.jsonl"), `${out.join("\n")}\n`, "utf8");

const annFile = path.join(ROOT, "kb", "annotations.json");
if (!existsSync(annFile)) throw new Error("缺少 kb/annotations.json（人工标注的白话解释与可测程度）");
const ann = JSON.parse(readFileSync(annFile, "utf8")) as Record<string, unknown>;
const missing = Object.keys(ann).filter((id) => !clauses.some((c) => c.id === id));
if (missing.length) throw new Error(`annotations.json 里有不存在的条款：${missing.join(", ")}`);

console.log(`共 ${clauses.length} 条；快照 SHA-256 ${snapshotSha}`);
