// 琪叶桃新形象（ADR-030）的几张贴图怎么画。scripts/restyle-vrm.mts 在本机 Edge 里调用，画完写回模型；只用浏览器自带的画布，不连网。
// 画法和主视觉小样第八轮（2026-11-06）一样，位置、大小都照原贴图来（模型的 UV 不动）：
// - 瞳孔：圆瞳孔（原来是竖条的猫眼）；上面三四成被上眼睑压暗，下半透光、越往下越亮越暖，
//   底边一道亮弧，外圈一道深色边，中间几十道细放射纹，下半撒几颗暖色的小亮点。
// - 高光：另一层，左上一块大的，右下一个小的，再加一颗四角星和几粒小亮点。原贴图两只眼睛没有左右镜像，高光自然在同一边。
// - 眼线：上眼线颜色压深、往上加粗几个像素；下眼线只压深一点。
// - 头发：原贴图是棕色的上下渐变（发根暗、中段亮），按每个点的明暗换成一条白到灰蓝的色带；眉毛整张换成一个浅色。
(() => {
  const TAU = Math.PI * 2;
  const S = 2; // 眼睛按原贴图两倍的尺寸画，边缘更干净；写回模型前缩回原尺寸

  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function pixels(img) {
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const x = cv.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, cv.width, cv.height);
  }

  function canvasFor(img, scale) {
    const cv = document.createElement("canvas");
    cv.width = img.width * scale;
    cv.height = img.height * scale;
    return [cv, cv.getContext("2d")];
  }

  function toCanvas(data) {
    const cv = document.createElement("canvas");
    cv.width = data.width;
    cv.height = data.height;
    cv.getContext("2d").putImageData(data, 0, 0);
    return cv;
  }

  /** 原瞳孔贴图里左右两只瞳孔各占哪一块（按不透明的像素找，单位是原贴图的像素） */
  function irisBoxes(img) {
    const { data, width, height } = pixels(img);
    return [
      [0, width / 2],
      [width / 2, width],
    ].map(([x0, x1]) => {
      let a = 1e9;
      let b = -1;
      let c = 1e9;
      let d = -1;
      for (let y = 0; y < height; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * width + x) * 4 + 3] < 128) continue;
          a = Math.min(a, x);
          b = Math.max(b, x);
          c = Math.min(c, y);
          d = Math.max(d, y);
        }
      }
      return { cx: (a + b + 1) / 2, cy: (c + d + 1) / 2, rx: (b - a + 1) / 2, ry: (d - c + 1) / 2 };
    });
  }

  /** 瞳孔（两倍尺寸） */
  function paintIris(img, boxes, o) {
    const [cv, x] = canvasFor(img, S);
    const r = rng(17);
    for (const b of boxes) {
      const cx = b.cx * S;
      const cy = b.cy * S;
      const rx = b.rx * S * o.size;
      const ry = b.ry * S * o.size;
      // 外面一圈淡影，瞳孔边和眼白接得软一点
      x.save();
      x.filter = `blur(${rx * 0.05}px)`;
      x.fillStyle = o.halo;
      x.beginPath();
      x.ellipse(cx, cy, rx * 1.04, ry * 1.04, 0, 0, TAU);
      x.fill();
      x.restore();

      x.save();
      x.beginPath();
      x.ellipse(cx, cy, rx, ry, 0, 0, TAU);
      x.clip();
      // 1. 底色：光从下面透进来，越往上越暗（径向渐变，圆心在瞳孔下方）
      x.save();
      x.translate(cx, cy + ry * 0.55);
      x.scale(rx / ry, 1);
      const g = x.createRadialGradient(0, 0, 0, 0, 0, ry * 1.62);
      for (const [t, c] of o.stops) g.addColorStop(t, c);
      x.fillStyle = g;
      x.fillRect(-ry * 3, -ry * 3, ry * 6, ry * 6);
      x.restore();
      // 2. 放射纹：从瞳孔边往外，亮暗相间，下半亮纹多一些
      x.save();
      x.lineCap = "round";
      for (let i = 0; i < o.fibers; i++) {
        const a = (i / o.fibers) * TAU + (r() - 0.5) * 0.05;
        const lower = Math.sin(a) > 0; // 画布 y 朝下，sin > 0 是下半
        const light = r() < (lower ? 0.62 : 0.3);
        const r0 = o.pupil * (1.05 + r() * 0.2);
        const r1 = 0.55 + r() * 0.4;
        x.strokeStyle = light ? `rgba(255,214,150,${(lower ? 0.32 : 0.12) * (0.5 + r())})` : `rgba(40,8,6,${0.22 * (0.5 + r())})`;
        x.lineWidth = rx * (0.012 + r() * 0.018);
        x.beginPath();
        x.moveTo(cx + Math.cos(a) * rx * r0, cy + Math.sin(a) * ry * r0);
        x.lineTo(cx + Math.cos(a) * rx * r1, cy + Math.sin(a) * ry * r1);
        x.stroke();
      }
      x.restore();
      // 3. 上眼睑压下来的影子：顶上一道深色月牙，下沿和瞳孔上沿平行
      x.save();
      x.filter = `blur(${ry * 0.05}px)`;
      x.fillStyle = o.lid;
      x.beginPath();
      x.ellipse(cx, cy, rx * 1.2, ry * 1.2, 0, 0, TAU);
      x.ellipse(cx, cy + ry * o.lidDepth, rx * 1.18, ry * 1.06, 0, 0, TAU);
      x.fill("evenodd");
      x.restore();
      // 4. 瞳孔周围一圈稍亮的暖色，把瞳孔托出来
      x.save();
      x.filter = `blur(${rx * 0.06}px)`;
      x.strokeStyle = o.collar;
      x.lineWidth = rx * 0.12;
      x.beginPath();
      x.ellipse(cx, cy + ry * o.pupilY, rx * o.pupil * 1.32, ry * o.pupil * 1.32, 0, Math.PI * 0.05, Math.PI * 0.95);
      x.stroke();
      x.restore();
      // 5. 瞳孔：圆的（按瞳孔的长宽比，看上去是正圆），边缘略软
      x.save();
      x.translate(cx, cy + ry * o.pupilY);
      x.scale(1, ry / rx);
      const pg = x.createRadialGradient(0, 0, 0, 0, 0, rx * o.pupil);
      pg.addColorStop(0, o.pupilColor);
      pg.addColorStop(0.82, o.pupilColor);
      pg.addColorStop(1, "rgba(26,6,5,0)");
      x.fillStyle = pg;
      x.beginPath();
      x.arc(0, 0, rx * o.pupil, 0, TAU);
      x.fill();
      x.restore();
      // 6. 底边一道亮弧：光透过眼珠在下沿聚起来
      x.save();
      x.filter = `blur(${rx * 0.035}px)`;
      x.strokeStyle = o.rim;
      x.lineWidth = rx * 0.1;
      x.beginPath();
      x.ellipse(cx, cy, rx * 0.84, ry * 0.84, 0, Math.PI * 0.16, Math.PI * 0.84);
      x.stroke();
      x.restore();
      // 7. 下半几颗暖色小亮点（像透光的晶体）
      x.save();
      x.globalCompositeOperation = "lighter";
      for (let i = 0; i < o.glints; i++) {
        const a = Math.PI * (0.15 + r() * 0.7);
        const d = 0.45 + r() * 0.35;
        const gx = cx + Math.cos(a) * rx * d;
        const gy = cy + Math.sin(a) * ry * d;
        const gr = rx * (0.025 + r() * 0.03);
        const gg = x.createRadialGradient(gx, gy, 0, gx, gy, gr);
        gg.addColorStop(0, o.glint);
        gg.addColorStop(1, "rgba(255,200,120,0)");
        x.fillStyle = gg;
        x.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      }
      x.restore();
      x.restore(); // 去掉裁切
      // 8. 外圈深色边：一道实线加一道向里晕开的
      x.save();
      x.strokeStyle = o.ring;
      x.filter = `blur(${rx * 0.04}px)`;
      x.lineWidth = rx * 0.14;
      x.beginPath();
      x.ellipse(cx, cy, rx * 0.97, ry * 0.97, 0, 0, TAU);
      x.stroke();
      x.filter = "none";
      x.lineWidth = rx * 0.045;
      x.beginPath();
      x.ellipse(cx, cy, rx * 0.985, ry * 0.985, 0, 0, TAU);
      x.stroke();
      x.restore();
    }
    return cv;
  }

  /** 四角星：中间一个亮点，四道细光芒 */
  function star(x, cx, cy, s, a) {
    x.save();
    x.translate(cx, cy);
    x.rotate(a);
    x.beginPath();
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * TAU;
      x.lineTo(Math.cos(t) * s, Math.sin(t) * s);
      x.lineTo(Math.cos(t + TAU / 8) * s * 0.16, Math.sin(t + TAU / 8) * s * 0.16);
    }
    x.closePath();
    x.fill();
    x.restore();
  }

  /** 高光（单独一层，叠在瞳孔前面；两倍尺寸；位置按瞳孔贴图量出来的瞳孔，两张贴图排法一样） */
  function paintCatch(img, boxes, o) {
    const [cv, x] = canvasFor(img, S);
    for (const b of boxes) {
      const cx = b.cx * S;
      const cy = b.cy * S;
      const rx = b.rx * S * o.size;
      const ry = b.ry * S * o.size;
      x.fillStyle = o.color;
      // 大的：左上，略斜的圆角块
      const [mx, my, mw, mh, ma] = o.main;
      x.save();
      x.translate(cx + mx * rx, cy + my * ry);
      x.rotate(ma);
      x.beginPath();
      x.ellipse(0, 0, mw * rx, mh * ry, 0, 0, TAU);
      x.fill();
      x.restore();
      // 小的：右下
      const [sx, sy, sr] = o.small;
      x.beginPath();
      x.ellipse(cx + sx * rx, cy + sy * ry, sr * rx, sr * rx * 1.15, 0, 0, TAU);
      x.fill();
      // 四角星和小亮点
      star(x, cx + o.star[0] * rx, cy + o.star[1] * ry, o.star[2] * rx, 0.18);
      for (const [dx, dy, dr, a] of o.dots) {
        x.globalAlpha = a;
        x.beginPath();
        x.arc(cx + dx * rx, cy + dy * ry, dr * rx, 0, TAU);
        x.fill();
      }
      x.globalAlpha = 1;
    }
    return cv;
  }

  /** 眼线：上眼线压深、往上加粗；cut 以下是下眼线（只压深） */
  function paintLine(img, o) {
    const { data, width, height } = pixels(img);
    const out = new ImageData(width, height);
    const d = out.data;
    const cut = Math.round(height * o.cut);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // 上眼线：往下找几个像素，取最实的那个（线的上沿就往上长了几个像素）
        let best = (y * width + x) * 4;
        if (y < cut) {
          for (let k = 1; k <= o.up && y + k < cut; k++) {
            const j = ((y + k) * width + x) * 4;
            if (data[j + 3] > data[best + 3]) best = j;
          }
        }
        const i = (y * width + x) * 4;
        const k = y < cut ? o.dark : o.darkLow;
        for (let c = 0; c < 3; c++) d[i + c] = data[best + c] * (1 - k) + o.ink[c] * k;
        d[i + 3] = data[best + 3];
      }
    }
    return toCanvas(out);
  }

  /** 256 格的色带：stops 是 [位置 0～1, 颜色] */
  function ramp(stops) {
    const cv = document.createElement("canvas");
    cv.width = 256;
    cv.height = 1;
    const x = cv.getContext("2d", { willReadFrequently: true });
    const g = x.createLinearGradient(0, 0, 256, 0);
    for (const [t, c] of stops) g.addColorStop(t, c);
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 1);
    return x.getImageData(0, 0, 256, 1).data;
  }

  /** 按原贴图每个点的明暗查色带：明暗按 [lo, hi] 拉到 0～1（前发、后发用同一个范围，换完还是一样深浅）；透明度不动 */
  function paintRamp(img, stops, range) {
    const [lo, hi] = range;
    const data = pixels(img);
    const d = data.data;
    const r = ramp(stops);
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      const k = Math.round(Math.min(1, Math.max(0, (L - lo) / (hi - lo))) * 255) * 4;
      d[i] = r[k];
      d[i + 1] = r[k + 1];
      d[i + 2] = r[k + 2];
    }
    return toCanvas(data);
  }

  /** 整张换成一个颜色，透明度不动（眉毛） */
  function paintTint(img, color) {
    const data = pixels(img);
    const d = data.data;
    const [r, g, b] = ramp([
      [0, color],
      [1, color],
    ]);
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
    }
    return toCanvas(data);
  }

  /** 一次画完：input 是各张原贴图的 PNG（base64），返回画好的 PNG（base64）；眼睛缩回原尺寸 */
  async function paintAll(input, style) {
    const load = (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      // 和 three.js 读 glTF 贴图一样：不转色彩空间、不预乘透明度
      return createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    };
    const fit = (cv, w, h) => {
      const o = document.createElement("canvas");
      o.width = w;
      o.height = h;
      const x = o.getContext("2d");
      x.imageSmoothingQuality = "high";
      x.drawImage(cv, 0, 0, w, h);
      return o;
    };
    const png = (cv) => cv.toDataURL("image/png").split(",")[1];
    const img = {};
    for (const [k, v] of Object.entries(input)) img[k] = await load(v);
    if (img.catch.width !== img.iris.width || img.catch.height !== img.iris.height) throw new Error("高光贴图和瞳孔贴图大小不一样");
    const boxes = irisBoxes(img.iris);
    const { width: w, height: h } = img.iris;
    const { hair } = style;
    return {
      iris: png(fit(paintIris(img.iris, boxes, style.iris), w, h)),
      catch: png(fit(paintCatch(img.catch, boxes, style.catch), w, h)),
      line: png(paintLine(img.line, style.line)),
      lash: png(paintLine(img.lash, style.lash)),
      brow: png(paintTint(img.brow, style.brow)),
      hair: png(paintRamp(img.hair, hair.lit, hair.range)),
      hairShade: png(paintRamp(img.hair, hair.shade, hair.range)),
      hairBack: png(paintRamp(img.hairBack, hair.lit, hair.range)),
      hairBackShade: png(paintRamp(img.hairBack, hair.shade, hair.range)),
    };
  }

  globalThis.restylePainters = { paintAll };
})();
