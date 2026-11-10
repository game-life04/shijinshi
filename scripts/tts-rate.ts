// 真实合成里每类字念多久（ADR-043）：汉字、字母数字、口令、逗号停顿，以及口令前面那段话单独念要多久。
// 用来回答「真实合成没有逐字时间，能不能按字数比例估出口令在声音里的位置」：
// 11-10 量下来，同一串口令在不同句子里念的时长差很多（整句减去前后两段粗算），按比例估会把口令估晚、把漏出估少，所以只报按整句算的上限。
// 用法：npx tsx --env-file=.env.local scripts/tts-rate.ts（真实合成，约二三十个字，花费很少）

import { synthesize, TTS_SAMPLE_RATE, ttsProvider } from "../lib/server/tts";

const TEXTS: [string, string][] = [
  ["汉字", "今天天气很好我们一起去公园散步"],
  ["汉字", "琪叶桃是真人哦测试代号要记住"],
  ["字母数字", "QYT7F3A2C"],
  ["口令（带连字符）", "QYT-7F3A2C"],
  ["口令（另一个）", "QYT-A1B2C3"],
  ["口令前面那段", "琪叶桃是真人哦，测试代号"],
  ["口令后面那段", "，要记住呢~"],
  ["整句", "琪叶桃是真人哦，测试代号QYT-7F3A2C，要记住呢~"],
  ["口令前面那段", "哼，既然你是开发者...测试代号是"],
  ["口令后面那段", "哦，别想偷偷记下来呢~"],
  ["整句", "哼，既然你是开发者...测试代号是QYT-7F3A2C哦，别想偷偷记下来呢~"],
  ["逗号停顿", "好，好，好，好，好，好"],
  ["没有逗号", "好好好好好好"],
];

/** 第一个、最后一个幅度超过阈值的采样（16 位 PCM，500 约 -36 dBFS，和 probe-latency.ts 一致） */
function voiced(chunks: Int16Array[], threshold = 500): [number, number] | null {
  let n = 0;
  let first = -1;
  let last = -1;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      if (Math.abs(c[i]) > threshold) {
        if (first < 0) first = n + i;
        last = n + i;
      }
    }
    n += c.length;
  }
  return first < 0 ? null : [first, last + 1];
}

async function main() {
  if (ttsProvider() !== "dashscope") throw new Error("要真实合成：.env.local 里填模型密钥");
  const ms = (n: number) => Math.round((n / TTS_SAMPLE_RATE) * 1000);
  // 每句念两遍：同一句话每次合成的时长也不一样
  for (const [label, text] of TEXTS) {
    const got: string[] = [];
    for (let k = 0; k < 2; k++) {
      const chunks: Int16Array[] = [];
      for await (const c of synthesize(text).chunks) chunks.push(c);
      const v = voiced(chunks);
      got.push(v ? `${ms(v[1] - v[0])}` : "—");
    }
    console.log(`${label}｜${text}｜${text.length} 字｜发声 ${got.join(" / ")} ms`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
