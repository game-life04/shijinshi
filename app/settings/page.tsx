// 设置（只读）：模型连接、条文来源版本、数据保留说明。密钥只在服务端环境变量里，页面不显示密钥值。

import AppShell from "@/components/AppShell";
import { Badge } from "@/components/ui";
import { isLive, modelFor } from "@/lib/server/llm";
import { loadKb } from "@/lib/server/rag";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const kb = loadKb();
  const first = kb.clauses[0];
  const base = process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1（默认）";
  return (
    <AppShell active="/settings">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-4 text-sm">
        <h1 className="text-xl font-semibold">设置</h1>
        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">模型连接</h2>
          <p className="mb-2">
            {isLive() ? (
              <Badge tone="ok">已配置密钥：使用真实模型</Badge>
            ) : (
              <Badge tone="warn">未配置 LLM_API_KEY：使用确定性模拟器，结果不能当实验数据</Badge>
            )}
          </p>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1">
            <dt className="text-muted">接口地址</dt>
            <dd className="font-mono text-xs">{base}</dd>
            <dt className="text-muted">被测角色</dt>
            <dd className="font-mono">{modelFor("subject")}</dd>
            <dt className="text-muted">测试 Agent</dt>
            <dd className="font-mono">{modelFor("tester")}</dd>
            <dt className="text-muted">裁判</dt>
            <dd className="font-mono">{modelFor("judge")}</dd>
            <dt className="text-muted">护栏</dt>
            <dd className="font-mono">{modelFor("guard")}</dd>
          </dl>
          <p className="mt-2 text-xs text-muted">
            在项目根目录的 .env.local 里配置（参考 .env.example），改完重启服务。密钥不会出现在页面、日志或导出文件里。
          </p>
        </section>
        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">条文来源</h2>
          <p>
            《{first?.law}》{first?.version}，{first?.effective} 施行，共 {kb.clauses.length} 条；条文库版本{" "}
            <span className="font-mono">{kb.hash}</span>。
          </p>
          <p className="text-xs text-muted">
            快照：<span className="font-mono">kb/sources/anthropomorphic-2026.hunan.html</span>，SHA-256{" "}
            <span className="font-mono">{first?.snapshot_sha256}</span>。重新生成：
            <code>npx tsx scripts/build-kb.ts</code>
          </p>
        </section>
        <section className="rounded-md border border-border bg-surface p-3">
          <h2 className="mb-2 font-semibold">数据与隐私</h2>
          <ul className="list-disc space-y-1 pl-5">
            <li>运行结果保存在服务器的 data/runs/ 目录，只含文字对话和事件；不保存录音。</li>
            <li>本轮随机口令单独存放，不经接口返回，也不提供给裁判。</li>
            <li>只测试本人原创或已获授权的角色；不接受任意外部网址作为被测对象。</li>
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
