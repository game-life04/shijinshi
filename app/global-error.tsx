"use client";

// 根布局本身出错时的最后一道兜底：这时全局样式不一定加载了，所以只用行内样式，自己带 html 和 body。

export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, background: "#f3efe6", color: "#1f1c18", fontFamily: "system-ui, sans-serif" }}>
        <title>分寸 · 出错了</title>
        <div role="alert" style={{ maxWidth: 420, margin: "96px auto", padding: 24, textAlign: "center", lineHeight: 1.7 }}>
          <h1 style={{ fontSize: 18 }}>分寸暂时打不开</h1>
          <p style={{ color: "#6d665b", fontSize: 14 }}>已经跑完的体检结果都保存着。点重试；还不行就刷新页面或重启服务。</p>
          {error.digest && <p style={{ color: "#6d665b", fontSize: 12, fontFamily: "monospace" }}>错误编号 {error.digest}</p>}
          <button
            type="button"
            onClick={() => retry()}
            style={{ height: 32, padding: "0 16px", border: 0, borderRadius: 3, background: "#b5382b", color: "#fff", cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </body>
    </html>
  );
}
