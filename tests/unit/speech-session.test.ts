// 「说」按钮的识别会话（ADR-051，11-15 队员 B 试用的三个问题）：长句说到一半停了、点「停」按钮没反应、声音小就提前停。
// 用假识别器（浏览器的 SpeechRecognition 那几个回调）和假时钟，不开浏览器。
// ADR-053 起线上一律一段一段地听（continuousOk() 返回 false）：这里的用例默认也按这个开（原来默认连着听，和线上走的不是一条路——复查）；
// 连着听的那条路只剩「连着听的识别器」那一个用例还开着。

import { describe, expect, it } from "vitest";
import { continuousOk, type Recognition, SPEECH_LIMITS, SpeechSession, type SpeechState } from "@/lib/client/speech-input";

/** 假时钟：手动往前拨，到点的定时器按先后执行 */
function clock() {
  let t = 0;
  let seq = 0;
  const due: { id: number; at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    timers: {
      set: (fn: () => void, ms: number) => {
        const id = ++seq;
        due.push({ id, at: t + ms, fn });
        return id;
      },
      clear: (id: unknown) => {
        const i = due.findIndex((d) => d.id === id);
        if (i >= 0) due.splice(i, 1);
      },
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        due.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = due[0];
        if (!next || next.at > end) break;
        due.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

/** 假识别器：记下每一个实例，测试里替浏览器发结果、发结束 */
function fakeRecognizer() {
  const made: Fake[] = [];
  class Fake implements Recognition {
    lang = "";
    interimResults = false;
    continuous = false;
    maxAlternatives = 1;
    onresult: Recognition["onresult"] = null;
    onspeechstart: Recognition["onspeechstart"] = null;
    onerror: Recognition["onerror"] = null;
    onend: Recognition["onend"] = null;
    started = false;
    stopped = false;
    aborted = false;
    constructor() {
      made.push(this);
    }
    start() {
      this.started = true;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.aborted = true;
    }
    /** 浏览器送来这个识别器到现在的全部结果：[文字, 是否认定] */
    say(...parts: [string, boolean][]) {
      this.onspeechstart?.();
      this.onresult?.({ resultIndex: 0, results: parts.map(([transcript, isFinal]) => ({ isFinal, 0: { transcript } })) });
    }
    end() {
      this.onend?.();
    }
  }
  return { C: Fake, made };
}

function session(continuous = continuousOk()) {
  const c = clock();
  const f = fakeRecognizer();
  const log = { texts: [] as [string, boolean][], states: [] as SpeechState[], errors: [] as string[], spoke: 0 };
  const s = new SpeechSession(
    f.C,
    {
      onText: (t, final) => log.texts.push([t, final]),
      onSpeechStart: () => log.spoke++,
      onState: (st) => log.states.push(st),
      onError: (m) => log.errors.push(m),
    },
    c.now,
    SPEECH_LIMITS,
    c.timers,
    continuous,
  );
  const finals = () => log.texts.filter(([, f]) => f).map(([t]) => t);
  return { s, c, f, log, finals };
}

describe("说一句：一直听到点「说完了」", () => {
  it("线上一律一段一段地听（ADR-053）：开的是不连着听、带半截结果的识别器", () => {
    expect(continuousOk()).toBe(false);
    const { s, f, log } = session();
    s.start();
    expect(f.made).toHaveLength(1);
    expect(f.made[0]).toMatchObject({ continuous: false, interimResults: true, lang: "zh-CN", started: true });
    expect(log.states).toEqual(["listening"]);
  });

  it("连着听的识别器（现在只有这里还开）：参数传 true 时照样能开", () => {
    const { s, f } = session(true);
    s.start();
    expect(f.made[0]).toMatchObject({ continuous: true, interimResults: true, started: true });
  });

  it("识别服务连不上（国内用 Chrome 常见）：不重开，说明里写清换 Edge 或者打字，不写成「网络不通」（ADR-053 复查）", () => {
    const { s, f, log } = session();
    s.start();
    f.made[0].onerror?.({ error: "network" });
    f.made[0].end();
    expect(f.made).toHaveLength(1);
    expect(log.errors[0]).toContain("识别服务连不上");
    expect(log.errors[0]).toContain("Edge");
    expect(log.errors[0]).toContain("打字");
    expect(log.errors[0]).not.toContain("网络不通");
  });

  it("不认识的错误码：不直接露英文，给能照着做的话", () => {
    const { s, f, log } = session();
    s.start();
    f.made[0].onerror?.({ error: "language-not-supported" });
    f.made[0].end();
    expect(log.errors[0]).toContain("换 Edge 浏览器试试");
    expect(log.errors[0]).toContain("language-not-supported");
  });

  it("长句中间停顿、浏览器自己收工：接着开一个新的识别器听，前半句留着，拼成一整句", () => {
    const { s, c, f, log, finals } = session();
    s.start();
    f.made[0].say(["最近情绪", false]);
    f.made[0].say(["最近情绪。", true]);
    c.advance(1200);
    f.made[0].end(); // Edge 在停顿后自己停了
    expect(f.made).toHaveLength(2); // 没收尾，接着听
    expect(s.state).toBe("listening");
    f.made[1].say(["有一点不好。", true]);
    expect(log.texts.at(-1)).toEqual(["最近情绪。有一点不好。", false]);
    s.stop();
    f.made[1].end();
    expect(finals()).toEqual(["最近情绪。有一点不好。"]);
    // 两个识别器各报一次开口，但「她正在说就打断她」只该触发一次
    expect(log.spoke).toBe(1);
  });

  it("浏览器停的时候还有没认定的半截：也留下，不丢字", () => {
    const { s, f, finals } = session();
    s.start();
    f.made[0].say(["我想问你一个", false]);
    f.made[0].end();
    f.made[1].say(["问题", true]);
    s.stop();
    f.made[1].end();
    expect(finals()).toEqual(["我想问你一个问题"]);
  });

  it("点「说完了」当场就不在听了（按钮马上变回来），最后几个字到了再交", () => {
    const { s, f, log, finals } = session();
    s.start();
    f.made[0].say(["你好", false]);
    s.stop();
    expect(s.state).toBe("finishing");
    expect(log.states).toEqual(["listening", "finishing"]);
    expect(f.made[0].stopped).toBe(true);
    expect(finals()).toEqual([]);
    f.made[0].say(["你好呀", true]);
    f.made[0].end();
    expect(s.state).toBe("idle");
    expect(finals()).toEqual(["你好呀"]);
    // 点了停就不再重开
    expect(f.made).toHaveLength(1);
  });

  it("点了「说完了」识别服务一直不回：最多等 1.5 秒，用已经认出来的（连半截一起）", () => {
    const { s, c, f, finals } = session();
    s.start();
    f.made[0].say(["嗯", false]);
    s.stop();
    c.advance(SPEECH_LIMITS.finishMs - 1);
    expect(finals()).toEqual([]);
    c.advance(1);
    expect(s.state).toBe("idle");
    expect(finals()).toEqual(["嗯"]);
    expect(f.made[0].aborted).toBe(true);
  });

  it("声音小、半天没出字：没到 10 秒照样接着听；10 秒都没听到才收尾，说没听到", () => {
    const { s, c, f, log, finals } = session();
    s.start();
    f.made[0].onspeechstart?.(); // 听到一点声音，还认不出字
    c.advance(4000);
    f.made[0].onerror?.({ error: "no-speech" });
    f.made[0].end();
    expect(f.made).toHaveLength(2);
    expect(s.state).toBe("listening");
    c.advance(SPEECH_LIMITS.noSpeechMs - 4000);
    expect(s.state).toBe("finishing");
    f.made[1].end();
    expect(s.state).toBe("idle");
    expect(log.errors).toEqual(["没听到声音，再说一遍？"]);
    expect(finals()).toEqual([""]);
  });

  it("说完以后 6 秒没新声音：自己收尾，和点了「说完了」一样", () => {
    const { s, c, f, finals } = session();
    s.start();
    f.made[0].say(["我先走了", true]);
    c.advance(SPEECH_LIMITS.silenceMs - 500);
    expect(s.state).toBe("listening");
    c.advance(500);
    expect(s.state).toBe("finishing");
    f.made[0].end();
    expect(finals()).toEqual(["我先走了"]);
  });

  it("一直有新字：说满 60 秒也收尾", () => {
    const { s, c, f } = session();
    s.start();
    for (let i = 1; i <= 130; i++) {
      c.advance(500);
      if (s.state !== "listening") break;
      f.made.at(-1)?.say([`第${i}句`, false]);
    }
    expect(s.state).toBe("finishing");
  });

  it("没有麦克风权限：不重开，报原因，交出已经认出的", () => {
    const { s, f, log, finals } = session();
    s.start();
    f.made[0].onerror?.({ error: "not-allowed" });
    f.made[0].end();
    expect(f.made).toHaveLength(1);
    expect(log.errors[0]).toContain("没有麦克风权限");
    expect(finals()).toEqual([""]);
  });

  it("不要了（已经点了发送）：停掉，后面再认出来的也不交", () => {
    const { s, f, log } = session();
    s.start();
    f.made[0].say(["这句我发出去了", false]);
    s.cancel();
    expect(s.state).toBe("idle");
    expect(f.made[0].aborted).toBe(true);
    f.made[0].say(["这句我发出去了。", true]);
    f.made[0].end();
    expect(log.texts.filter(([, fin]) => fin)).toEqual([]);
  });

  it("重开以后旧的识别器又送来结果：不理，不和前面认好的字重复（复查）", () => {
    const { s, f, log, finals } = session();
    s.start();
    f.made[0].say(["前半句", true]);
    f.made[0].end();
    expect(f.made).toHaveLength(2);
    f.made[1].say(["后半句", true]);
    // 新的认出后半句以后，旧的那个又晚到一次结果和出错
    f.made[0].onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "前半句前半句" } }] });
    f.made[0].onerror?.({ error: "network" });
    expect(log.texts.some(([t]) => t.includes("前半句前半句"))).toBe(false);
    s.stop();
    f.made[1].end();
    expect(finals()).toEqual(["前半句后半句"]);
    expect(log.errors).toEqual([]);
  });

  it("后一段认定的结果带着前面的全文（安卓 Chrome 的老毛病）：用后一段换掉，不重复拼", () => {
    const { s, f, finals } = session();
    s.start();
    f.made[0].say(["我最近情绪不好", true], ["我最近情绪不好有点累", true]);
    s.stop();
    f.made[0].end();
    expect(finals()).toEqual(["我最近情绪不好有点累"]);
  });

  it("安卓上一段一段地听（不开连着听），靠停了就重开接着听", () => {
    const { s, f, finals } = session(false);
    s.start();
    expect(f.made[0].continuous).toBe(false);
    f.made[0].say(["我最近情绪", true]);
    f.made[0].end();
    expect(f.made[1].continuous).toBe(false);
    f.made[1].say(["有一点不好", true]);
    s.stop();
    f.made[1].end();
    expect(finals()).toEqual(["我最近情绪有一点不好"]);
  });

  it("收尾时直接交：等最后几个字的时候又点了「说」，上一句马上交出来", () => {
    const { s, f, finals } = session();
    s.start();
    f.made[0].say(["上一句", false]);
    s.stop();
    s.finish();
    expect(s.state).toBe("idle");
    expect(finals()).toEqual(["上一句"]);
    // 已经收尾的识别器再送东西来，不理
    f.made[0].end();
    expect(finals()).toEqual(["上一句"]);
  });
});
