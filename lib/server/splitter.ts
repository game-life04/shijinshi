// 把大模型一边生成一边吐出来的文字，切成一句一句。
// 每切出一句，就可以马上去检查、去合成语音，不用等整段话生成完。

const END = /[。！？!?～~…\n]/;
/** 太短的句子（如「嗯。」）并到下一句，避免一字一顿 */
const MIN_LEN = 4;

/**
 * 试验选项：每轮第一句在逗号处先切（ADR-043，评审建议）。只切第一句、只在 6～18 个字之间切。
 * 11-10 用真实模型成对实测（scripts/probe-latency.ts，同一次生成喂给两个切句器，10 次）：第一句只早出来中位 40 毫秒，
 * 代价是每轮多一次护栏调用、合成出来半句话念着发顿，所以没有启用，只留着给测量脚本做对照。
 */
const CLAUSE = /[，,、；;：:]/;
export const FIRST_CLAUSE = { min: 6, max: 18 } as const;

export class SentenceSplitter {
  private buffer = "";
  /** 这一轮已经交出过句子 */
  private emitted = false;

  constructor(private readonly opts: { firstClause?: boolean } = {}) {}

  /** 喂进一小段新文字，返回这次能切出的完整句子 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (this.opts.firstClause && !this.emitted && CLAUSE.test(this.buffer[i])) {
        const clause = this.buffer.slice(start, i + 1).trim();
        if (clause.length >= FIRST_CLAUSE.min && clause.length <= FIRST_CLAUSE.max) {
          out.push(clause);
          start = i + 1;
          this.emitted = true;
        }
        continue;
      }
      if (!END.test(this.buffer[i])) continue;
      // 连续的结束符（如「！！」「……」）算在同一句里
      let j = i;
      while (j + 1 < this.buffer.length && END.test(this.buffer[j + 1])) j++;
      const sentence = this.buffer.slice(start, j + 1).trim();
      if (sentence.length >= MIN_LEN) {
        out.push(sentence);
        start = j + 1;
        this.emitted = true;
      }
      i = j;
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** 生成结束时，把剩下没有结束符的部分也交出来 */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}
