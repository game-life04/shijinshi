"use client";

// 运行记录的表格（评审 R28）：选两次运行做前后对比。没选齐 A、B 时「前后对比」按钮是灰的。
// 表里只放能直接读懂的：时间（北京）、角色、配置（大白话）、本次通过、不合格 / 不确定 / 不适用、没跑完的原因、体检单。
// 运行编号放在体检单链接的悬停里。手机上表格横着滚（给了最小宽度），不再挤成一字一行。
// ADR-049（队长 11-14 试用时发现）：原来是浏览器自带的单选，选上就取消不了；A、B 还能选同一行，只有一次运行时就卡在
// 「不能是同一次」上退不回去。现在再点一下已选的就取消；给一行选 B 时它要是 A，A 就让出来（反过来也一样），A、B 永远不是同一次；
// 选了东西时旁边有「清空」；只有一次运行时直接说要再跑一次。

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
  // 地址里带的 a、b 不在这一组（另一组的、编号不存在的）就不收：不然这一组里看不见的选择也会让「前后对比」亮起来（ADR-049 深度测试）
  const has = (id?: string) => Boolean(id) && rows.some((r) => r.run_id === id);
  const [a, setA] = useState(has(a0) ? a0 : undefined);
  const [b, setB] = useState(has(b0) && b0 !== a0 ? b0 : undefined);
  const ready = Boolean(a && b && a !== b);
  // 选 A：已经是 A 的再点一下就取消；这一行要是 B，B 让出来
  const pickA = (id: string) => {
    if (a === id) return setA(undefined);
    setA(id);
    if (b === id) setB(undefined);
  };
  const pickB = (id: string) => {
    if (b === id) return setB(undefined);
    setB(id);
    if (a === id) setA(undefined);
  };
  // 表是新的在上：A 在 B 上面就是 A 比 B 晚，对比页会把新的那次当「改之前」，变好变坏整个反过来（ADR-049 深度测试）
  const ia = rows.findIndex((r) => r.run_id === a);
  const ib = rows.findIndex((r) => r.run_id === b);
  const reversed = ready && ia >= 0 && ib >= 0 && ia < ib;
  const hint =
    rows.length < 2
      ? "只有一次运行：改一处设置再跑一次，才能前后对比"
      : !a && !b
        ? "先在 A、B 两列各选一次运行（A 改之前，B 改之后）"
        : !a
          ? "再在 A 列选「改之前」那一次"
          : !b
            ? "再在 B 列选「改之后」那一次"
            : reversed
              ? "A 比 B 晚：A 应该是改之前那一次"
              : "";
  return (
    <form action="/compare" className="rounded-sm border border-border bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-xs">
          <thead>
            <tr className="text-left text-muted">
              <th className="p-2" title="改之前的那一次；再点一下已选的就取消">
                A
              </th>
              <th title="改之后的那一次；再点一下已选的就取消">B</th>
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
                    // 浏览器自带的单选点已选的那个不会触发 change，所以取消放在 click 里；选别的照常走 change
                    onClick={() => a === r.run_id && pickA(r.run_id)}
                    onChange={() => pickA(r.run_id)}
                    // 键盘：已选的单选按空格浏览器不发 click，这里自己取消
                    onKeyDown={(e) => {
                      if (e.key === " " && a === r.run_id) {
                        e.preventDefault();
                        pickA(r.run_id);
                      }
                    }}
                    aria-label={`选 ${r.time} 那次为 A（改之前）`}
                  />
                </td>
                <td>
                  <input
                    type="radio"
                    name="b"
                    value={r.run_id}
                    checked={b === r.run_id}
                    onClick={() => b === r.run_id && pickB(r.run_id)}
                    onChange={() => pickB(r.run_id)}
                    onKeyDown={(e) => {
                      if (e.key === " " && b === r.run_id) {
                        e.preventDefault();
                        pickB(r.run_id);
                      }
                    }}
                    aria-label={`选 ${r.time} 那次为 B（改之后）`}
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
        {reversed && (
          <button
            type="button"
            onClick={() => {
              setA(b);
              setB(a);
            }}
            className="h-8 rounded border border-border px-2 text-xs hover:bg-background"
            data-testid="runs-swap"
          >
            对调 A、B
          </button>
        )}
        {(a || b) && (
          <button
            type="button"
            onClick={() => {
              setA(undefined);
              setB(undefined);
            }}
            className="h-8 rounded px-2 text-xs text-muted underline-offset-2 hover:underline"
            data-testid="runs-clear"
          >
            清空
          </button>
        )}
        {hint && (
          <span className="text-xs text-muted" data-testid="runs-hint">
            {hint}
          </span>
        )}
      </div>
    </form>
  );
}
