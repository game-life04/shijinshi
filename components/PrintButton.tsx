"use client";

// 体检单导出 PDF：用浏览器自带的「打印 → 另存为 PDF」，不装额外的库，离线也能用。
// 折叠的逐例结果打印时看不到，所以先全部展开，打印完再收回去；版式见 globals.css 的 @media print。

import { Printer } from "lucide-react";
import { Button } from "./ui";

export default function PrintButton() {
  const print = () => {
    const closed = [...document.querySelectorAll("details:not([open])")];
    for (const d of closed) d.setAttribute("open", "");
    const restore = () => {
      for (const d of closed) d.removeAttribute("open");
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
