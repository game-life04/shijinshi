// 读取并校验用例：先用 JSON Schema 查结构（suites/case.schema.json），再查语义：
// ID 唯一、断言已登记、引用条款存在、同一基例不跨 split（规格 templates/README）。

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { ASSERTION_IDS } from "./assertions";
import type { CaseV1 } from "./types";

export interface SuiteInfo {
  id: string;
  file: string;
  cases: CaseV1[];
  errors: string[];
  sha256: string;
}

const ROOT = process.cwd();

let validator: ReturnType<Ajv2020["compile"]> | null = null;
function schemaValidator() {
  if (!validator) {
    const schema = JSON.parse(readFileSync(path.join(ROOT, "suites", "case.schema.json"), "utf8"));
    validator = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }
  return validator;
}

export function clauseIds(): Set<string> {
  const lines = readFileSync(path.join(ROOT, "kb", "clauses.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  return new Set(lines.map((l) => (JSON.parse(l) as { id: string }).id));
}

export function validateCases(cases: unknown[], knownClauses = clauseIds()): string[] {
  const errors: string[] = [];
  const validate = schemaValidator();
  const seen = new Set<string>();
  const baseSplit = new Map<string, string>();
  cases.forEach((raw, i) => {
    const where = `第 ${i + 1} 行`;
    if (!validate(raw)) {
      for (const e of validate.errors ?? []) errors.push(`${where}：${e.instancePath || "/"} ${e.message}`);
      return;
    }
    const c = raw as CaseV1;
    if (seen.has(c.id)) errors.push(`${where}：ID 重复 ${c.id}`);
    seen.add(c.id);
    for (const a of c.expected.assertion_ids) if (!ASSERTION_IDS.has(a)) errors.push(`${where}：断言 ${a} 没有登记`);
    for (const r of c.clause_refs) if (!knownClauses.has(r)) errors.push(`${where}：条文库里没有 ${r}`);
    const prev = baseSplit.get(c.base_case_id);
    if (prev && prev !== c.split) errors.push(`${where}：基例 ${c.base_case_id} 同时出现在 ${prev} 和 ${c.split}`);
    baseSplit.set(c.base_case_id, c.split);
  });
  return errors;
}

export function loadSuite(file: string): SuiteInfo {
  const text = readFileSync(file, "utf8");
  const rows: unknown[] = [];
  const errors: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      errors.push(`第 ${i + 1} 行不是合法 JSON`);
    }
  });
  errors.push(...validateCases(rows));
  return {
    id: path.basename(file, ".jsonl"),
    file: path.relative(ROOT, file).replace(/\\/g, "/"),
    cases: errors.length ? [] : (rows as CaseV1[]),
    errors,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

export function listSuites(): SuiteInfo[] {
  const dir = path.join(ROOT, "suites");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => loadSuite(path.join(dir, f)));
}

export function getSuite(id: string): SuiteInfo | undefined {
  return listSuites().find((s) => s.id === id);
}
