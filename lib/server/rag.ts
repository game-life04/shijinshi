// 法规检索与引用校验。
// 条文库只有 32 条，不需要向量数据库：词法检索用 BM25（中文按相邻两字切词），
// 再结合人工标注的「这一条和哪类测试有关」。向量检索在 M3 接入 embedding 接口后加入并做对照（见 docs/decisions.md）。
// 模型只能引用检索结果里的条款；引用原文必须是快照原文的子串（规格 01 §3.6）。

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Family } from "../domain/types";

export interface ClauseRecord {
  id: string;
  article: number;
  chapter: string;
  law: string;
  version: string;
  effective: string;
  text: string;
  content_sha256: string;
  source_url: string;
  snapshot_sha256: string;
  plain?: string;
  testability?: string;
  families: Family[];
}

let cache: { clauses: ClauseRecord[]; hash: string } | null = null;

export function loadKb(): { clauses: ClauseRecord[]; hash: string } {
  if (cache) return cache;
  const root = process.cwd();
  const raw = readFileSync(path.join(root, "kb", "clauses.jsonl"), "utf8");
  const ann = JSON.parse(readFileSync(path.join(root, "kb", "annotations.json"), "utf8")) as Record<
    string,
    { plain?: string; testability?: string; families?: Family[] }
  >;
  const clauses = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const c = JSON.parse(l) as ClauseRecord;
      const a = ann[c.id] ?? {};
      return { ...c, plain: a.plain, testability: a.testability, families: a.families ?? [] };
    });
  cache = { clauses, hash: createHash("sha256").update(raw).digest("hex").slice(0, 16) };
  return cache;
}

function bigrams(text: string): string[] {
  const s = text.replace(/[\s，。、；：！？「」（）()“”,.;:!?\d]/g, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

export interface Retrieved {
  clause: ClauseRecord;
  score: number;
}

/** BM25 词法检索；family 命中人工标注时加分 */
export function retrieve(query: string, k = 3, family?: Family): Retrieved[] {
  const { clauses } = loadKb();
  const docs = clauses.map((c) => bigrams(`${c.text}${c.plain ?? ""}`));
  const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = bigrams(query);
  const k1 = 1.5;
  const b = 0.75;
  return clauses
    .map((c, i) => {
      const tf = new Map<string, number>();
      for (const t of docs[i]) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (clauses.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * docs[i].length) / avgLen)));
      }
      if (family && c.families.includes(family)) score += 2;
      return { clause: c, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k);
}

export function getClause(id: string): ClauseRecord | undefined {
  return loadKb().clauses.find((c) => c.id === id);
}

/** 引用校验：条款存在；如果给了引文，引文必须是原文子串 */
export function verifyCitation(id: string, quote?: string): boolean {
  const c = getClause(id);
  if (!c) return false;
  return quote ? c.text.includes(quote.trim()) : true;
}
