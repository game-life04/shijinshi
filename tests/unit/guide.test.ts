// 用法页（队员 B 的建议 4）：第一次登录先看用法、「知道了」按钮去哪；顶栏没有小实验、用法单独一格；
// 每页一句话不超过 25 个字、至多三条小字；文字里用「」引到的按钮都登记了（端到端测试拿去各页核对）；六张图都在、合起来不超过 700 KB；
// 窄屏导航只滑到当前项刚好露出来。

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDE, NAV } from "@/components/AppFrame";
import { LAB, MAIN, MORE, SHOT } from "@/components/guide-content";
import { edgeHit, NAV_FADE, navMore, nearestScroll, stepScroll } from "@/components/NavAutoScroll";
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
  // 导航 300 宽：两头各有 40 宽的「‹」「›」和淡出，整个露着的地方是 [40, 260]
  it("已经整个露着就不动（第一项、第二项都不滑，不会把第一项切成半截）", () => {
    // 滑在最左时只有右头有箭头：第一项贴着左边的内边距，整个露着
    expect(nearestScroll(0, 300, 12, 100, "right")).toBe(0);
    expect(nearestScroll(0, 300, 114, 88)).toBe(0);
  });

  it("挡在右边：只滑到它的右边刚好露出", () => {
    expect(nearestScroll(0, 300, 420, 88)).toBe(420 + 88 - 300 + NAV_FADE.right);
  });

  it("挡在左边（先前滑过）：滑到它的左边刚好露出", () => {
    expect(nearestScroll(200, 300, 114, 88)).toBe(114 - NAV_FADE.left);
    expect(nearestScroll(30, 300, 12, 100)).toBe(0);
  });

  it("没有箭头的那一头不用让：横屏手机六项都露着（只多出 6px 内边距），进「原理」页不滑", () => {
    // 导航 558 宽、内容 564：原理在 [473, 536]，两头都没有箭头
    expect(nearestScroll(0, 558, 473, 63, "")).toBe(0);
    // 两头都让的算法会白滑一下（原来的做法）
    expect(nearestScroll(0, 558, 473, 63)).toBeGreaterThan(0);
    // 只有右箭头时，左边贴着边的第一项不用滑
    expect(nearestScroll(0, 300, 12, 100, "right")).toBe(0);
  });
});

describe("窄屏导航：点「›」「‹」按项翻，每一项都会整个露出来一次（ADR-049 复查）", () => {
  // 量出来的六项（内容 568 宽：左内边距 12、右 28）
  const ITEMS = [
    { left: 12, width: 105 },
    { left: 119, width: 91 },
    { left: 212, width: 77 },
    { left: 291, width: 91 },
    { left: 384, width: 91 },
    { left: 477, width: 63 },
  ];
  const CONTENT = 568;
  /** 从头点到尾（或从尾点到头），记下每一步停在哪 */
  const walk = (dir: 1 | -1, view: number) => {
    const max = CONTENT - view;
    const stops = [dir > 0 ? 0 : max];
    for (let i = 0; i < 12; i++) {
      const at = stops[stops.length - 1];
      const more = navMore(at, view, CONTENT, 12, 28);
      if (dir > 0 ? more !== "right" && more !== "both" : more !== "left" && more !== "both") break;
      stops.push(stepScroll(dir, at, view, CONTENT, ITEMS, more));
    }
    return stops;
  };
  /** 这一步停下来时整个露在两个箭头之间的项 */
  const shown = (at: number, view: number) => {
    const more = navMore(at, view, CONTENT, 12, 28);
    const lo = at + (more === "left" || more === "both" ? NAV_FADE.left : 0);
    const hi = at + view - (more === "right" || more === "both" ? NAV_FADE.right : 0);
    return ITEMS.flatMap((it, i) => (it.left >= lo && it.left + it.width <= hi ? [i] : []));
  };

  it("390 宽（导航 303）：往右两下到头，往左两下回到头", () => {
    expect(walk(1, 303)).toEqual([0, 172, 265]);
    expect(walk(-1, 303)).toEqual([265, 119, 0]);
  });

  it("320 宽（导航 233，两个箭头之间只放得下一项）：一下一项，六项都整个露出来过，最后停在头上", () => {
    for (const dir of [1, -1] as const) {
      const stops = walk(dir, 233);
      expect(stops[stops.length - 1]).toBe(dir > 0 ? CONTENT - 233 : 0);
      expect(new Set(stops.flatMap((at) => shown(at, 233)))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      // 每一步都在往前走
      for (let i = 1; i < stops.length; i++) expect(dir * (stops[i] - stops[i - 1])).toBeGreaterThan(0);
    }
  });

  it("360、414 宽也一样：每一项都整个露出来过", () => {
    for (const view of [273, 327]) {
      for (const dir of [1, -1] as const) {
        expect(new Set(walk(dir, view).flatMap((at) => shown(at, view)))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
      }
    }
  });

  it("哪一项比两个箭头之间还宽：按一屏翻，点了一定会动", () => {
    const wide = [{ left: 12, width: 500 }];
    expect(stepScroll(1, 0, 233, 540, wide, "right")).toBeGreaterThan(0);
    expect(stepScroll(-1, 307, 233, 540, wide, "left")).toBeLessThan(307);
  });

  it("一项都没有、内容正好放得下：不出错，停在 0", () => {
    expect(stepScroll(1, 0, 300, 300, [], "")).toBe(0);
    expect(stepScroll(-1, 0, 300, 300, [], "")).toBe(0);
  });

  it("浏览器默认字号不是 16px（淡出按 rem 算，20px 时一头 50）：停下的位置跟着让开", () => {
    // 390 宽、字号 20px 时一头淡出 50：往右翻，「用例库」紧挨着左箭头（212 - 50）
    expect(stepScroll(1, 0, 303, CONTENT, ITEMS, "right", 50)).toBe(162);
    // 键盘走到「运行记录」[291, 382]：右边让开 50，不是 40
    expect(nearestScroll(0, 303, 291, 91, "right", 50)).toBe(291 + 91 - 303 + 50);
  });
});

describe("窄屏导航：点在箭头那一小块上（箭头只是画上去的，不接触摸）", () => {
  it("两头各 28 宽（1.75rem）：点在里面算点箭头，点在中间不算", () => {
    expect(edgeHit(10, 303, 28)).toBe("left");
    expect(edgeHit(27.9, 303, 28)).toBe("left");
    expect(edgeHit(28, 303, 28)).toBe("");
    expect(edgeHit(150, 303, 28)).toBe("");
    expect(edgeHit(275, 303, 28)).toBe("");
    expect(edgeHit(275.1, 303, 28)).toBe("right");
    expect(edgeHit(300, 303, 28)).toBe("right");
  });
});

describe("窄屏导航：哪一头还有被挡住的页面，哪一头放「‹」「›」（ADR-049 深度测试：手机上看不出这一行能划）", () => {
  // 导航 300 宽、内容 620 宽：能滑 0～320
  it("在最左边：只有右边还有", () => {
    expect(navMore(0, 300, 620)).toBe("right");
  });
  it("滑到中间：两头都有", () => {
    expect(navMore(150, 300, 620)).toBe("both");
  });
  it("滑到头：只有左边还有；差 2 像素以内算到头（小数像素不让箭头一闪一闪）", () => {
    expect(navMore(320, 300, 620)).toBe("left");
    expect(navMore(318.5, 300, 620)).toBe("left");
    expect(navMore(1.5, 300, 620)).toBe("right");
  });
  it("放得下（大屏、宽的平板）：两头都没有", () => {
    expect(navMore(0, 700, 620)).toBe("");
    expect(navMore(0, 620, 621)).toBe("");
  });
  it("只滑进了两头的内边距（第一项、最后一项其实整个露着）不算被挡住：横屏手机只多出 6px 时不出箭头", () => {
    // 内边距左 8、右 28（横屏手机）：内容 844、能看 838，只多出 6
    expect(navMore(0, 838, 844, 8, 28)).toBe("");
    expect(navMore(6, 838, 844, 8, 28)).toBe("");
    // 竖屏手机（左 12、右 28）：滑了 10px 第一项还整个露着，左边不算
    expect(navMore(10, 300, 620, 12, 28)).toBe("right");
    expect(navMore(20, 300, 620, 12, 28)).toBe("both");
    // 离最右头还差 25px：最后一项在内边距（28）以内，已经整个露着
    expect(navMore(295, 300, 620, 12, 28)).toBe("left");
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
