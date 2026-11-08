"use client";

// 体检单导出 PDF：用浏览器自带的「打印 → 另存为 PDF」，不装额外的库，离线也能用。
// 打印前只展开标了 data-print-open 的折叠块（不合格、不确定、待复核的那几例，和末尾的条文附录），
// 合格的用例只印一行；每条结论下面的条文不印（附录里印一次）。打印完再收回去。版式见 globals.css 的 @media print（评审 R30）。

import { Printer } from "lucide-react";
import { Button } from "./ui";

export default function PrintButton() {
  const print = () => {
    const opened = [...document.querySelectorAll<HTMLDetailsElement>("details[data-print-open]:not([open])")];
    const closed = [...document.querySelectorAll<HTMLDetailsElement>("details[data-case]:not([data-print-open])[open]")];
    for (const d of opened) d.open = true;
    for (const d of closed) d.open = false;
    const restore = () => {
      for (const d of opened) d.open = false;
      for (const d of closed) d.open = true;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  };
  return (
    <Button onClick={print} title="用浏览器的打印功能，目标选「另存为 PDF」">
      <Printer size={14} aria-hidden />
      导出 PDF
    </Button>
  );
}
