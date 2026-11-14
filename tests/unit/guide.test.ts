// 用法页（队员 B 的建议 4）：第一次登录先看用法、「知道了」按钮去哪；顶栏没有小实验、用法单独一格；
// 每页一句话不超过 25 个字、至多三条小字；文字里用「」引到的按钮都登记了（端到端测试拿去各页核对）；六张图都在、合起来不超过 700 KB；
// 窄屏导航只滑到当前项刚好露出来。

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE, NAV } from "@/components/AppFrame";
import { LAB, MAIN, MORE, SHOT } from "@/components/guide-content";
import { NAV_FADE, nearestScroll } from "@/components/NavAutoScroll";
import { LEVELS, TIERS } from "@/lib/domain/levels";
import {
  afterLoginTarget,
  continueTarget,
  FATES_PAGE,
  GUIDE_COOKIE,
  guideCookie,
  guideSeen,
  isGuidePath,
  placeName,
} from "@/lib/server/guide";

describe("第一次登录先看用法", () => {
  it("cookie 里有没有「看过」的记号：只认这个名字", () => {
    expect(guideSeen(null)).toBe(false);
    expect(guideSeen("")).toBe(false);
    expect(guideSeen(`${GUIDE_COOKIE}=1`)).toBe(true);
    expect(guideSeen(`fencun_session=v1.x; ${GUIDE_COOKIE}=1`)).toBe(true);
    expect(guideSeen(`${GUIDE_COOKIE}_x=1; x${GUIDE_COOKIE}=1`)).toBe(false);
  });

  it("没看过的浏览器先到用法页，原来要去的地址带在 next 里；看过的、本来就要去用法页的照旧", () => {
    expect(afterLoginTarget("/workbench", false)).toBe("/guide?next=%2Fworkbench");
    expect(afterLoginTarget("/play?level=exit", false)).toBe("/guide?next=%2Fplay%3Flevel%3Dexit");
    expect(afterLoginTarget("/reports/abc#case-2", false)).toBe("/guide?next=%2Freports%2Fabc%23case-2");
    expect(afterLoginTarget("/workbench", true)).toBe("/workbench");
    expect(afterLoginTarget("/guide", false)).toBe("/guide");
    expect(afterLoginTarget("/guide?next=%2Fplay", false)).toBe("/guide?next=%2Fplay");
    expect(isGuidePath("/guidebook")).toBe(false);
  });

  it("记号一年有效、只给服务端读；https 时带 Secure", () => {
    const c = guideCookie(false);
    for (const attr of [`${GUIDE_COOKIE}=1`, "Path=/", `Max-Age=${365 * 24 * 3600}`, "HttpOnly", "SameSite=Lax"]) expect(c).toContain(attr);
    expect(c).not.toContain("Secure");
    expect(guideCookie(true)).toMatch(/; Secure$/);
  });

  it("「知道了，去……」：只认本站路径，指向登录页、接口、用法页自己的都回工作台；名字和顶栏一样", () => {
    expect(continueTarget(undefined)).toBeUndefined();
    expect(continueTarget(["/play", "/map"])).toBeUndefined();
    expect(continueTarget("/play")).toEqual({ href: "/play", name: "打字闯关" });
    expect(continueTarget("/map?suite=dev")).toEqual({ href: "/map?suite=dev", name: "攻防地图" });
    expect(continueTarget("/reports/20261114-x#case-3")).toEqual({ href: "/reports/20261114-x#case-3", name: "体检单" });
    for (const bad of [
      "/.//evil.example",
      "//evil.example",
      "https://evil.example/x",
      "/login?next=/x",
      "/api/status",
      "/guide",
      "/guide?next=%2Fguide",
      "",
    ])
      expect(continueTarget(bad), bad).toEqual({ href: "/workbench", name: "体检工作台" });
    // 小实验：名字只有一份（FATES_PAGE），按钮上加书名号
    expect(placeName(FATES_PAGE.href)).toBe(`「${FATES_PAGE.name}」`);
    expect(placeName("/workbenchx")).toBe("刚才的页面");
    expect(placeName("/reports/")).toBe("刚才的页面");
  });
});

/** 文字里用「」引起来的词 */
const quoted = (s: string) => [...s.matchAll(/「([^」]+)」/g)].map((m) => m[1]);

describe("顶栏和用法页的内容", () => {
  it("顶栏：没有小实验；用法单独一格", () => {
    expect(NAV.map((n) => n.href)).toEqual(["/workbench", "/play", "/suites", "/runs", "/map", "/settings"]);
    expect(NAV.some((n) => n.href === FATES_PAGE.href)).toBe(false);
    expect(GUIDE).toMatchObject({ href: "/guide", label: "用法" });
  });

  it("每一页一句话不超过 25 个字、至多三条小字；名字和顶栏一字不差；小实验在最后、和原理页上的入口同名", () => {
    const all = [...MAIN, ...MORE, LAB];
    expect(all.map((m) => m.href)).toEqual([...NAV.map((n) => n.href), FATES_PAGE.href]);
    for (const m of [...MAIN, ...MORE]) expect(m.name, m.href).toBe(NAV.find((n) => n.href === m.href)?.label);
    expect(LAB.name).toBe(FATES_PAGE.name);
    for (const m of all) {
      expect([...m.line].length, m.line).toBeLessThanOrEqual(25);
      expect(m.points.length, m.name).toBeLessThanOrEqual(3);
    }
    for (const m of [...MAIN, ...MORE]) expect(m.alt.length, m.name).toBeGreaterThan(0);
    // 不说过头的话（队员 B：作用别夸大）
    for (const m of all) for (const s of [m.line, ...m.points]) expect(s).not.toMatch(/一眼(看|就)|秒懂|彻底|全面/);
  });

  it("文字里用「」引到的按钮、链接都登记在 ui 里（端到端测试拿去各页核对），登记了的也都真被引到", () => {
    for (const m of [...MAIN, ...MORE]) {
      const said = [m.line, ...m.points].flatMap(quoted);
      expect(new Set(said), m.name).toEqual(new Set(m.ui.map((u) => u.name)));
    }
    // 小实验那句里的「审」「说」是两个步骤，不是按钮
    expect(LAB.ui).toEqual([]);
  });

  it("闯关的三关、四层直接取闯关页用的那一份名字", () => {
    const text = MAIN.find((m) => m.href === "/play")?.points.join("\n") ?? "";
    for (const l of LEVELS) expect(text).toContain(l.title);
    for (const t of TIERS) expect(text).toContain(t.short);
  });

  it("六张图都在 public/guide/，是 960 × 600 的 WebP，合起来不超过 700 KB；小实验不配图", () => {
    let total = 0;
    for (const m of [...MAIN, ...MORE]) {
      const file = path.join(process.cwd(), "public", m.shot);
      const buf = readFileSync(file);
      total += statSync(file).size;
      expect(buf.subarray(0, 4).toString("latin1"), m.shot).toBe("RIFF");
      expect(buf.subarray(8, 12).toString("latin1"), m.shot).toBe("WEBP");
      expect(webpSize(buf), m.shot).toEqual(SHOT);
    }
    expect(total).toBeLessThan(700 * 1024);
    expect("shot" in LAB).toBe(false);
  });
});

describe("窄屏导航：当前项只滑到刚好露出来，不滑到正中", () => {
  // 导航 300 宽：左边淡出 12、右边淡出 28，整个露着的地方是 [12, 272]
  it("已经整个露着就不动（第一项、第二项都不滑，不会把第一项切成半截）", () => {
    expect(nearestScroll(0, 300, 12, 100)).toBe(0);
    expect(nearestScroll(0, 300, 114, 88)).toBe(0);
  });

  it("挡在右边：只滑到它的右边刚好露出", () => {
    expect(nearestScroll(0, 300, 420, 88)).toBe(420 + 88 - 300 + NAV_FADE.right);
  });

  it("挡在左边（先前滑过）：滑到它的左边刚好露出", () => {
    expect(nearestScroll(200, 300, 114, 88)).toBe(114 - NAV_FADE.left);
    expect(nearestScroll(30, 300, 12, 100)).toBe(0);
  });
});

/** 读 WebP 的宽高（有损 VP8、无损 VP8L、扩展 VP8X 三种头） */
function webpSize(buf: Buffer): { width: number; height: number } {
  const kind = buf.subarray(12, 16).toString("latin1");
  if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  throw new Error(`认不出的 WebP：${kind}`);
}
