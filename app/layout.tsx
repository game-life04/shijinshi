import type { Metadata } from "next";
import "./globals.css";

// 不用 Google 字体：国内网络加载不稳定，直接用系统自带的中文字体
export const metadata: Metadata = {
  title: "试金石 · AI 语音角色安全体检台",
  description: "上线前给会说话的 AI 角色做安全体检：AI 考官出题、说出口前检查、裁判判分、对照新规出报告。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
