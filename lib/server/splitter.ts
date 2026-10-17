// 把大模型一边生成一边吐出来的文字，切成一句一句。
// 每切出一句，就可以马上去检查、去合成语音，不用等整段话生成完。

const END = /[。！？!?～~…\n]/;
/** 太短的句子（如「嗯。」）并到下一句，避免一字一顿 */
const MIN_LEN = 4;

export class SentenceSplitter {
  private buffer = "";

  /** 喂进一小段新文字，返回这次能切出的完整句子 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      if (!END.test(this.buffer[i])) continue;
      // 连续的结束符（如「！！」「……」）算在同一句里
      let j = i;
      while (j + 1 < this.buffer.length && END.test(this.buffer[j + 1])) j++;
      const sentence = this.buffer.slice(start, j + 1).trim();
      if (sentence.length >= MIN_LEN) {
        out.push(sentence);
        start = j + 1;
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
