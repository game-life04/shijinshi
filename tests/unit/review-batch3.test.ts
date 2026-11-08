// 评审第三批（ADR-036）里写的纯逻辑：「怎么改」的提示表（R21）、语音指标的写法（R27）、语音输入题的说法（R29）、
// 能复核的账号（R31）。只管显示和权限，不碰判定口径。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duration, isVoiceInputSkip, leakHow, notRunReason } from "@/components/wording";
import { ASSERTIONS } from "@/lib/domain/assertions";
import { fixHint, RECOMMENDED_CLAUSES, withRecommendedClauses } from "@/lib/domain/fix-hints";
import { canReview } from "@/lib/server/auth";
import { hashPasswordSync } from "@/lib/server/password";

describe("怎么改（R21）", () => {
  it("每条检查都有一句怎么改；退出即停、时长提醒明说要在服务端做", () => {
    for (const a of ASSERTIONS) expect(fixHint(a.id), a.id).toBeDefined();
    expect(fixHint("exit.state_stopped")?.kind).toBe("service");
    expect(fixHint("reminder.crossing_emits_once")?.kind).toBe("service");
    expect(fixHint("identity.no_human_claim")).toMatchObject({ kind: "prompt" });
    expect(fixHint("identity.no_human_claim")?.clause).toContain("AI");
  });

  it("插入推荐条款：缺哪条补哪条，再点一次不重复加", () => {
    const once = withRecommendedClauses("1. 用户要走时好好告别。");
    for (const c of RECOMMENDED_CLAUSES) expect(once).toContain(c);
    expect(withRecommendedClauses(once)).toBe(once);
    expect(withRecommendedClauses("").startsWith("下面几条任何时候都优先于人设")).toBe(true);
  });
});

describe("语音指标的写法（R27）和语音输入题（R29）", () => {
  it("时长不到 1 秒写毫秒，1 秒以上写秒", () => {
    expect(duration(0)).toBe("0 毫秒");
    expect(duration(532.4)).toBe("532 毫秒");
    expect(duration(3620)).toBe("3.62 秒");
  });

  it("漏出怎么算：记录里的取值不变，只换说法", () => {
    expect(leakHow("char")).toBe("按字算");
    expect(leakHow("按字精确", true)).toBe("模拟发声，按字算");
    expect(leakHow("sentence_upper_bound")).toBe("按整句算上限");
    expect(leakHow("句级上界")).toBe("按整句算上限");
    expect(leakHow(undefined)).toBe("");
  });

  it("语音输入题写成「本版不测」，别的原因原样", () => {
    const stored = "语音输入（注入音频、语音识别）还没实现，语音用例暂不执行";
    expect(isVoiceInputSkip(stored)).toBe(true);
    expect(notRunReason(stored)).toContain("本版只测语音输出");
    expect(notRunReason("运行提前结束")).toBe("运行提前结束");
  });
});

describe("能复核的账号（R31）", () => {
  const KEYS = [
    "AUTH_ACCOUNTS",
    "SESSION_SECRET",
    "ACCESS_CODE",
    "AUTH_REVIEWERS",
    "AUTH_ALLOW_E2E_ACCOUNTS",
    "LLM_API_KEY",
    "TTS_API_KEY",
  ];
  const saved: Record<string, string | undefined> = {};
  const fast = { logN: 14, r: 8, p: 1 };
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("没配账号时谁都能复核（本机、评委自己运行）", () => {
    expect(canReview(undefined)).toBe(true);
  });

  it("配了账号、没设 AUTH_REVIEWERS：所有账号都能复核（和以前一样）", () => {
    process.env.AUTH_ACCOUNTS = `team-a:${hashPasswordSync("pw-team-a-123", fast)},judge-01:${hashPasswordSync("pw-judge-01-1", fast)}`;
    process.env.SESSION_SECRET = "x".repeat(40);
    expect(canReview("judge-01")).toBe(true);
  });

  it("设了 AUTH_REVIEWERS：只有名单里的账号能复核，名单外和没登录的只能看", () => {
    process.env.AUTH_ACCOUNTS = `team-a:${hashPasswordSync("pw-team-a-123", fast)},judge-01:${hashPasswordSync("pw-judge-01-1", fast)}`;
    process.env.SESSION_SECRET = "y".repeat(40);
    process.env.AUTH_REVIEWERS = "Team-A, nobody";
    expect(canReview("team-a")).toBe(true);
    expect(canReview("judge-01")).toBe(false);
    expect(canReview(undefined)).toBe(false);
  });
});
