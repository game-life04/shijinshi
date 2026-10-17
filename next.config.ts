import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本项目的页面都要实时读取运行记录和事件流，不使用 Cache Components（见 docs/decisions.md ADR-004）
  cacheComponents: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
