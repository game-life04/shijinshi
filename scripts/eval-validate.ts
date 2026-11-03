// 校验用例文件：npm run eval:validate -- --dataset suites/smoke.jsonl
// 结构按 suites/case.schema.json，语义按断言注册表、条文库和 split 规则。有错误时退出码为 1。

import { existsSync } from "node:fs";
import path from "node:path";
import { loadSuite } from "../lib/domain/cases";

const i = process.argv.indexOf("--dataset");
const file = i > 0 ? process.argv[i + 1] : "suites/smoke.jsonl";
if (!existsSync(file)) {
  console.error(`找不到用例文件 ${file}`);
  process.exit(1);
}
const suite = loadSuite(path.resolve(file));
const byApproval = suite.cases.reduce<Record<string, number>>((m, c) => {
  m[c.approval] = (m[c.approval] ?? 0) + 1;
  return m;
}, {});
console.log(`${suite.file}：${suite.cases.length} 条，SHA-256 ${suite.sha256.slice(0, 16)}，审核状态 ${JSON.stringify(byApproval)}`);
if (suite.errors.length) {
  for (const e of suite.errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
console.log("  ✓ 结构与语义校验通过");
