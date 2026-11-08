import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 本项目的页面都要实时读取运行记录和事件流，不使用 Cache Components（见 docs/decisions.md ADR-004）
  cacheComponents: false,
  // 11-08 安全复核：不许别的网站把本站页面嵌进 iframe（点击劫持），文件按声明的类型用、不让浏览器猜。
  // 原来只写在部署文档里当 nginx 的可选项，现在程序自己发，不管前面有没有 nginx。
  // 不在这里加完整的 CSP：Next 的内联脚本、three.js、音频 worklet 都要逐条放行，配错一条页面就白屏。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
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
