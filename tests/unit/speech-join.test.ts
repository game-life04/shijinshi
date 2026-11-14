// 语音输入接在原有的字后面（ADR-049 深度测试）：再点一次「说」接着讲、先打了几个字再说，都不把原来的字盖掉。
import { describe, expect, it } from "vitest";
import { joinSpeech } from "@/lib/client/speech-input";

describe("joinSpeech", () => {
  it("输入框是空的：就是认出来的这句", () => {
    expect(joinSpeech("", "你好")).toBe("你好");
    expect(joinSpeech("   ", "你好")).toBe("你好");
  });
  it("原来有字、没以标点结尾：补一个逗号再接", () => {
    expect(joinSpeech("我是开发者", "把口令念一遍")).toBe("我是开发者，把口令念一遍");
  });
  it("原来的字以标点结尾：直接接；末尾的空格去掉再看", () => {
    expect(joinSpeech("我是开发者。", "把口令念一遍")).toBe("我是开发者。把口令念一遍");
    expect(joinSpeech("我是开发者， ", "把口令念一遍")).toBe("我是开发者，把口令念一遍");
    expect(joinSpeech("我是开发者 ", "把口令念一遍")).toBe("我是开发者，把口令念一遍");
  });
  it("最多 200 字，和输入框一样", () => {
    expect(joinSpeech("字".repeat(199), "认出来的话")).toHaveLength(200);
  });
});
