// 发布前检查：npm run release:check
// 1. 扫描准备提交的文件里有没有密钥、私钥、内网地址；
// 2. 如果本地有 .release-denylist.txt（每行一个不能公开的词，比如单位和客户名称），也一并扫描。
//    这份禁词表本身已在 .gitignore 里，绝不提交。
// 3. 核对必须存在的交付文件。

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PATTERNS: [string, RegExp][] = [
  ["疑似 API 密钥（sk- 开头）", /\bsk-[A-Za-z0-9]{16,}/],
  ["疑似私钥", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  // 只看同一行：等号后面有非空内容才算填了密钥
  ["环境变量里填了密钥", /^[ \t]*LLM_API_KEY[ \t]*=[ \t]*\S+/m],
  ["内网地址 10.x", /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
  ["内网地址 192.168.x", /\b192\.168\.\d{1,3}\.\d{1,3}\b/],
];

// core.quotepath=off：中文文件名原样输出（不然 git 会把它转义，脚本找不到文件就会漏扫）
const listed = execSync("git -c core.quotepath=off ls-files -z --cached --others --exclude-standard", { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !f.startsWith("kb/sources/") && !/\.(png|jpg|ico|vrm|glb|wasm|onnx|xlsx)$/i.test(f));
const missing = listed.filter((f) => !existsSync(f));
const files = listed.filter((f) => existsSync(f));
if (missing.length) console.log(`（${missing.length} 个文件在 git 里登记了但磁盘上没有，没扫：${missing.slice(0, 5).join("、")}）`);

const deny = existsSync(".release-denylist.txt")
  ? readFileSync(".release-denylist.txt", "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"))
  : [];

const problems: string[] = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [label, re] of PATTERNS) if (re.test(text)) problems.push(`${f}：${label}`);
  for (const w of deny) if (text.includes(w)) problems.push(`${f}：包含禁词（见本地 .release-denylist.txt）`);
}

for (const required of [
  "README.md",
  ".env.example",
  "package-lock.json",
  "suites/case.schema.json",
  "kb/clauses.jsonl",
  "docs/implementation-status.md",
]) {
  if (!existsSync(required)) problems.push(`缺少交付文件 ${required}`);
}

console.log(
  `检查了 ${files.length} 个文件；禁词表 ${deny.length ? `${deny.length} 个词` : "未配置（可在本地新建 .release-denylist.txt）"}`,
);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("  ✓ 没有发现密钥、内网地址或禁词；必需文件齐全");
