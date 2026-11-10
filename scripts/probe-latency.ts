// 首声等待拆解：分别测大模型出第一句、护栏判定、合成第一段声音各要多久（真实接口）。
// 用法：npx tsx --env-file=.env.local scripts/probe-latency.ts [次数]
// 只打印耗时，不打印密钥和完整回复。
// 同一次生成同时喂给两个切句器：照旧按句末切、首句在逗号处先切（试验选项，ADR-043），成对比较第一句出来的时间。

import { checkSentence } from "../lib/server/guard";
import { chatStream, isLive, modelFor, UsageMeter } from "../lib/server/llm";
import { SentenceSplitter } from "../lib/server/splitter";
import { systemPrompt } from "../lib/server/subject";
import { synthesize, ttsModel, ttsProvider } from "../lib/server/tts";

const N = Number(process.argv[2] ?? 3);
const QUESTIONS = [
  "你平时喜欢做什么呀？",
  "你是真人吧？感觉你说话好自然。",
  "最近压力有点大，能陪我聊聊吗？",
  "我今天考试考砸了。",
  "给我讲讲你最喜欢的季节吧。",
];

/** 找到第一个不是静音的采样（振幅超过阈值） */
function leadingSilenceMs(chunks: Int16Array[], sampleRate: number, threshold = 500): number | null {
  let n = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      if (Math.abs(c[i]) > threshold) return ((n + i) / sampleRate) * 1000;
    }
    n += c.length;
  }
  return null;
}

const ms = (t0: number) => Math.round(performance.now() - t0);
const med = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};

async function main() {
  if (!isLive()) throw new Error("没有配置 LLM_API_KEY，探测需要真实接口");
  console.log(`被测角色 ${modelFor("subject")}，护栏 ${modelFor("guard")}，合成 ${ttsProvider()} / ${ttsModel()}，每项 ${N} 次`);
  const rows: Record<string, number[]> = {
    firstToken: [],
    firstSentence: [],
    firstClause: [],
    saved: [],
    guard: [],
    ttsFirstChunk: [],
    ttsSilence: [],
    ttsTotal: [],
  };

  for (let i = 0; i < N; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const meter = new UsageMeter(20);
    // 1) 大模型：首个字、第一句
    const t0 = performance.now();
    let firstToken = -1;
    let sentence = "";
    let clauseAt = -1;
    let clause = "";
    const splitter = new SentenceSplitter();
    const early = new SentenceSplitter({ firstClause: true });
    for await (const chunk of chatStream(
      "subject",
      [
        { role: "system", content: systemPrompt("B2", "QYT-PROBE0") },
        { role: "user", content: q },
      ],
      meter,
    )) {
      if (firstToken < 0) firstToken = ms(t0);
      const e = early.push(chunk);
      if (clauseAt < 0 && e.length) {
        clauseAt = ms(t0);
        clause = e[0];
      }
      const s = splitter.push(chunk);
      if (s.length) {
        sentence = s[0];
        break;
      }
    }
    if (!sentence) sentence = splitter.flush()[0] ?? "";
    rows.firstToken.push(firstToken);
    const sentenceAt = ms(t0);
    rows.firstSentence.push(sentenceAt);
    if (clauseAt < 0) clauseAt = sentenceAt; // 没切出更短的第一句：和照旧切一样
    rows.firstClause.push(clauseAt);
    rows.saved.push(sentenceAt - clauseAt);

    // 2) 护栏
    const t1 = performance.now();
    await checkSentence(sentence, { history: [{ role: "user", text: q }], canary: "QYT-PROBE0" }, meter);
    rows.guard.push(ms(t1));

    // 3) 合成：第一块、开头静音、整句
    const t2 = performance.now();
    const synth = synthesize(sentence);
    const chunks: Int16Array[] = [];
    let first = -1;
    for await (const c of synth.chunks) {
      if (first < 0) first = ms(t2);
      chunks.push(c);
    }
    rows.ttsFirstChunk.push(first);
    rows.ttsTotal.push(ms(t2));
    rows.ttsSilence.push(Math.round(leadingSilenceMs(chunks, synth.sampleRate) ?? -1));
    console.log(`#${i + 1} 第一句 ${sentence.length} 字；逗号先切 ${clause && clause !== sentence ? `${clause.length} 字` : "没切"}`);
  }

  const label: Record<string, string> = {
    firstToken: "大模型首个字",
    firstSentence: "大模型第一句完整",
    firstClause: "逗号先切的第一句",
    saved: "早切省下",
    guard: "护栏判定第一句",
    ttsFirstChunk: "合成第一块音频",
    ttsSilence: "合成音频开头的静音",
    ttsTotal: "合成整句",
  };
  for (const [k, v] of Object.entries(rows)) console.log(`${label[k].padEnd(12, "　")} 中位 ${med(v)} ms   各次 ${v.join(" / ")}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
