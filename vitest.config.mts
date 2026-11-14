import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    // 单元测试一律不调用真实模型；要建运行的测试（audio.test.ts）写到 data/runs-unit，不混进 data/runs 里的实验记录
    // （ADR-049：原来每跑一次单元测试，运行记录里就多一条一题的模拟运行，10-18 以来攒了 101 条）
    env: { LLM_API_KEY: "", SHIJINSHI_RUNS_SUBDIR: "runs-unit" },
  },
});
