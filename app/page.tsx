import { redirect } from "next/navigation";

// 首屏就是可操作的体检工作台（规格 01 §2.1）
export default function Home() {
  redirect("/workbench");
}
