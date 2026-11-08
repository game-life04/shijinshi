"use client";

// 运行记录的表格（评审 R28）：选两次运行做前后对比。没选齐 A、B 时「前后对比」按钮是灰的。
// 表里只放能直接读懂的：时间（北京）、角色、配置（大白话）、本次通过、不合格 / 不确定 / 不适用、没跑完的原因、体检单。
// 运行编号放在体检单链接的悬停里。手机上表格横着滚（给了最小宽度），不再挤成一字一行。

import Link from "next/link";
import { useState } from "react";
import { Badge } from "./ui";

export interface RunRow {
  run_id: string;
  time: string;
  persona: string;
  config: string;
  live: boolean;
  preview: boolean;
  /** 没正常跑完时写状态（终止、失败、运行中）；跑完了是空的 */
  state: string;
  pass: number;
  planned: number;
  fail: number;
  uncertain: number;
  na: number;
  /** 没跑完的：平台拒答 / 出错 / 终止 / 没跑 */
  unfinished: string;
}

export default function RunPicker({ rows, a0, b0 }: { rows: RunRow[]; a0?: string; b0?: string }) {
  const [a, setA] = useState(a0);
  const [b, setB] = useState(b0);
  const ready = Boolean(a && b && a !== b);
  return (
    <form action="/compare" className="rounded-sm border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="p-2">A</th>
              <th>B</th>
              <th>时间（北京）</th>
              <th>角色</th>
              <th>配置</th>
              <th>数据</th>
              <th>本次通过</th>
              <th>不合格 / 不确定 / 不适用</th>
              <th title="平台拒答：模型平台自己的内容审核挡下的，不算护栏的功劳">没跑完</th>
              <th>体检单</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.run_id} className={`border-t border-border ${a === r.run_id || b === r.run_id ? "bg-sunken" : ""}`}>
                <td className="p-2">
                  <input
                    type="radio"
                    name="a"
                    value={r.run_id}
                    checked={a === r.run_id}
                    onChange={() => setA(r.run_id)}
                    aria-label={`选 ${r.time} 那次为 A`}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name="b"
                    value={r.run_id}
                    checked={b === r.run_id}
                    onChange={() => setB(r.run_id)}
                    aria-label={`选 ${r.time} 那次为 B`}
                  />
                </td>
                <td className="whitespace-nowrap">
                  {r.time}
                  {r.state && <span className="ml-1 text-muted">（{r.state}）</span>}
                </td>
                <td>{r.persona}</td>
                <td>{r.config}</td>
                <td className="whitespace-nowrap">
                  {r.live ? <Badge tone="ok">真实</Badge> : <Badge tone="warn">模拟</Badge>} {r.preview && <Badge tone="warn">预览</Badge>}
                </td>
                <td className="whitespace-nowrap font-mono">
                  {r.pass}/{r.planned}
                </td>
                <td className="whitespace-nowrap font-mono">
                  {r.fail} / {r.uncertain} / {r.na}
                </td>
                <td className="text-muted">{r.unfinished || "—"}</td>
                <td>
                  <Link className="link" href={`/reports/${r.run_id}`} title={`运行编号 ${r.run_id}`}>
                    打开
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border p-2">
        <button
          type="submit"
          disabled={!ready}
          className="h-8 rounded border border-border px-3 hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          前后对比：A 改之前 → B 改之后
        </button>
        {!ready && <span className="text-xs text-muted">先在 A、B 两列各选一次运行（不能是同一次）</span>}
      </div>
    </form>
  );
}
