"use client";

// 体检单逐例结果的「全部展开 / 只展开不合格的」（评审 R08）：默认只展开不合格的，整页不至于拉到七八千像素。

export default function CaseToggle() {
  const set = (all: boolean) => {
    for (const d of document.querySelectorAll<HTMLDetailsElement>("details[data-case]")) {
      d.open = all || d.dataset.verdict === "fail";
    }
  };
  return (
    <span className="no-print flex flex-wrap gap-3 text-xs">
      <button type="button" className="link" onClick={() => set(true)}>
        全部展开
      </button>
      <button type="button" className="link" onClick={() => set(false)}>
        只展开不合格的
      </button>
    </span>
  );
}
