"use strict";

/**
 * coverCompat 单测：3:4 居中裁切数学 + 归一/回退行为。
 * Electron nativeImage 在纯 node 下不可用，测试通过 esbuild 打包
 * coverCompat.js（electron external）后注入 fake 实现验证逻辑：
 *   - 横图/竖图 → 居中裁切矩形正确，产物写入 tmpdir
 *   - 已是 1080×1440 的 jpg/png → 免重编码透传
 *   - 解不了的格式（webp/gif）/解码失败/无 nativeImage → 回退原图不抛错
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeFileBuf(magic, extra = 16) {
  return Buffer.concat([magic, Buffer.alloc(extra)]);
}

/** fake nativeImage：按源尺寸模拟 decode/crop/resize/toBitmap/createFromBitmap/toJPEG，记录调用参数 */
function makeFakeNativeImage(
  srcW,
  srcH,
  {
    decodable = true,
    withBitmap = true,
    bgColor = [100, 120, 140, 255],
    fgColor = [200, 210, 220, 255],
    failCreateFromBitmap = false,
  } = {}
) {
  const calls = { crop: [], resize: [], createFromBitmap: [] };
  const makeSolidBitmap = (w, h, rgba) => {
    const buf = Buffer.alloc(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = rgba[0];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[2];
      buf[i + 3] = rgba[3];
    }
    return buf;
  };
  const makeImgNode = (w, h, color) => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h }),
    crop: (rect) => {
      calls.crop.push(rect);
      return makeImgNode(rect.width, rect.height, bgColor);
    },
    resize: (opts) => {
      calls.resize.push(opts);
      const nextColor =
        opts.width === 36 || opts.height === 27 ? bgColor : color;
      return makeImgNode(opts.width, opts.height, nextColor);
    },
    ...(withBitmap
      ? {
          toBitmap: () => makeSolidBitmap(w, h, color),
        }
      : {}),
    toJPEG: (q) => Buffer.from(`fake-jpeg-${w}x${h}-q${q}`),
  });

  const api = {
    calls,
    createFromBuffer(buf) {
      if (!decodable) return { isEmpty: () => true };
      // 只认 JPEG/PNG 魔数（对齐真实 nativeImage：webp/gif 解不了 → isEmpty）
      const ok =
        (buf[0] === 0xff && buf[1] === 0xd8) ||
        (buf[0] === 0x89 && buf[1] === 0x50);
      if (!ok) return { isEmpty: () => true };
      return makeImgNode(srcW, srcH, fgColor);
    },
  };
  if (withBitmap) {
    api.createFromBitmap = (bitmapBuf, size) => {
      calls.createFromBitmap.push({
        byteLength: bitmapBuf.length,
        size,
        sampleEdge: [bitmapBuf[0], bitmapBuf[1], bitmapBuf[2], bitmapBuf[3]],
        bitmapBuf: Buffer.from(bitmapBuf),
      });
      if (failCreateFromBitmap) return { isEmpty: () => true };
      return makeImgNode(size.width, size.height, fgColor);
    };
  }
  return api;
}

async function main() {
  const root = path.join(__dirname, "..");
  const outDir = path.join(root, "test/.cache");
  fs.mkdirSync(outDir, { recursive: true });
  const bundlePath = path.join(outDir, "cover-compat.cjs");

  await build({
    entryPoints: [path.join(root, "src/main/services/coverCompat.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: bundlePath,
  });

  const {
    computeCenterCrop,
    computeHorizontalFromVerticalLayout,
    compositeCenteredBitmap,
    normalizeCoverForUpload,
    normalizeHorizontalCoverForUpload,
    generateHorizontalCoverFromVertical,
    resolveDualCoversForUpload,
    COVER_TARGET_WIDTH,
    COVER_TARGET_HEIGHT,
    COVER_H_TARGET_WIDTH,
    COVER_H_TARGET_HEIGHT,
    COVER_H_BLUR_WIDTH,
    COVER_H_BLUR_HEIGHT,
    COVER_H_BG_DARKEN_FACTOR,
  } = require(bundlePath);

  assert.strictEqual(COVER_TARGET_WIDTH, 1080);
  assert.strictEqual(COVER_TARGET_HEIGHT, 1440);
  assert.strictEqual(COVER_H_TARGET_WIDTH, 1440);
  assert.strictEqual(COVER_H_TARGET_HEIGHT, 1080);
  assert.strictEqual(COVER_H_BLUR_WIDTH, 36);
  assert.strictEqual(COVER_H_BLUR_HEIGHT, 27);
  assert.ok(COVER_H_BG_DARKEN_FACTOR > 0 && COVER_H_BG_DARKEN_FACTOR < 1);

  // ---- computeCenterCrop：居中裁切数学 ----
  // 横图 2000×1000：裁两侧留全高，crop 宽 = 1000*3/4 = 750，x 居中 625
  assert.deepStrictEqual(computeCenterCrop(2000, 1000), {
    x: 625,
    y: 0,
    width: 750,
    height: 1000,
  });
  // 竖长图 800×1600：裁上下留全宽，crop 高 = 800*4/3 ≈ 1067，y 居中
  assert.deepStrictEqual(computeCenterCrop(800, 1600), {
    x: 0,
    y: Math.round((1600 - Math.round(800 * 4 / 3)) / 2),
    width: 800,
    height: Math.round(800 * 4 / 3),
  });
  // 已是 3:4（含 1080×1440 本身）：无需裁切
  assert.strictEqual(computeCenterCrop(540, 720), null);
  assert.strictEqual(computeCenterCrop(1080, 1440), null);
  // 异常尺寸
  assert.strictEqual(computeCenterCrop(0, 100), null);
  assert.strictEqual(computeCenterCrop(100, 0), null);
  assert.strictEqual(computeCenterCrop(NaN, 100), null);
  // 4:3 居中裁切矩形
  // 16:9 (1920×1080) → 4:3：裁两侧留全高，crop 宽 = 1440，x = 240
  assert.deepStrictEqual(computeCenterCrop(1920, 1080, 1440, 1080), {
    x: 240,
    y: 0,
    width: 1440,
    height: 1080,
  });
  // 3:4 (1080×1440) → 4:3：裁上下留全宽，crop 高 = 810，y = 315
  assert.deepStrictEqual(computeCenterCrop(1080, 1440, 1440, 1080), {
    x: 0,
    y: 315,
    width: 1080,
    height: 810,
  });
  assert.strictEqual(computeCenterCrop(1440, 1080, 1440, 1080), null);
  console.log("computeCenterCrop passed");

  // ---- computeHorizontalFromVerticalLayout：3:4 竖图 → 1440×1080 布局 ----
  const layout34 = computeHorizontalFromVerticalLayout(1080, 1440);
  assert.deepStrictEqual(layout34, {
    targetW: 1440,
    targetH: 1080,
    fgW: 810,
    fgH: 1080,
    fgX: 315,
    fgY: 0,
    bgCrop: { x: 0, y: 315, width: 1080, height: 810 },
    blurW: 36,
    blurH: 27,
  });
  // 9:16 竖图 → 按高 1080 完整居中，宽 608，x=416
  const layout916 = computeHorizontalFromVerticalLayout(1080, 1920);
  assert.strictEqual(layout916.fgH, 1080);
  assert.strictEqual(layout916.fgW, 608);
  assert.strictEqual(layout916.fgX, 416);
  assert.strictEqual(layout916.fgY, 0);
  // 16:9 横图传入也能安全等比适配不越界
  const layout169 = computeHorizontalFromVerticalLayout(1920, 1080);
  assert.strictEqual(layout169.fgW, 1440);
  assert.strictEqual(layout169.fgH, 810);
  assert.strictEqual(layout169.fgX, 0);
  assert.strictEqual(layout169.fgY, 135);
  assert.strictEqual(computeHorizontalFromVerticalLayout(0, 100), null);
  assert.strictEqual(computeHorizontalFromVerticalLayout(100, -1), null);
  console.log("computeHorizontalFromVerticalLayout passed");

  // ---- compositeCenteredBitmap：背景压暗 + 居中前景 + alpha 混合 ----
  {
    const tinyLayout = {
      targetW: 4,
      targetH: 2,
      fgW: 2,
      fgH: 2,
      fgX: 1,
      fgY: 0,
    };
    const bgBuf = Buffer.alloc(4 * 2 * 4);
    for (let i = 0; i < bgBuf.length; i += 4) {
      bgBuf[i] = 100;
      bgBuf[i + 1] = 200;
      bgBuf[i + 2] = 50;
      bgBuf[i + 3] = 255;
    }
    const fgBuf = Buffer.alloc(2 * 2 * 4);
    // (0,0) 不透明红、(1,0) 半透明白、(0,1) 全透明、(1,1) 不透明蓝
    fgBuf.set([240, 10, 20, 255], 0);
    fgBuf.set([200, 200, 200, 128], 4);
    fgBuf.set([10, 20, 30, 0], 8);
    fgBuf.set([0, 0, 255, 255], 12);
    const merged = compositeCenteredBitmap(bgBuf, fgBuf, tinyLayout, {
      darkenFactor: 0.5,
    });
    assert.ok(Buffer.isBuffer(merged));
    // 左侧背景 (0,0) 应压暗为 (50, 100, 25, 255)
    assert.deepStrictEqual([...merged.slice(0, 4)], [50, 100, 25, 255]);
    // 前景 (1,0) 不透明保留原值 (240, 10, 20, 255)
    assert.deepStrictEqual([...merged.slice(4, 8)], [240, 10, 20, 255]);
    // 前景 (2,0) 半透明混合（alpha=128 与压暗背景 (50,100,25) 混合）
    assert.strictEqual(merged[8], Math.round((200 * 128 + 50 * 127) / 255));
    assert.strictEqual(merged[11], 255);
    // 前景 (1,1) 全透明露出压暗背景 (50, 100, 25, 255)
    const idx11 = (1 * 4 + 1) * 4;
    assert.deepStrictEqual([...merged.slice(idx11, idx11 + 4)], [50, 100, 25, 255]);
    // 尺寸不匹配返回 null
    assert.strictEqual(
      compositeCenteredBitmap(Buffer.alloc(4), fgBuf, tinyLayout),
      null
    );
  }
  console.log("compositeCenteredBitmap passed");

  // ---- normalizeCoverForUpload ----
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-cover-test-"));
  const created = [];
  try {
    // 1) 横图 jpg：居中裁切 → 缩放 1080×1440 → 写出 tmp jpg
    const landscape = path.join(workDir, "landscape.jpg");
    fs.writeFileSync(landscape, makeFileBuf(JPEG_MAGIC));
    const fake1 = makeFakeNativeImage(2000, 1000);
    const out1 = await normalizeCoverForUpload(landscape, {
      nativeImage: fake1,
    });
    assert.notStrictEqual(out1, landscape, "横图应产出归一后的新路径");
    assert.ok(fs.existsSync(out1), "归一产物应已写盘");
    assert.strictEqual(path.extname(out1), ".jpg", "产物应为 jpg");
    assert.strictEqual(out1.startsWith(os.tmpdir()), true, "产物应落在 tmpdir");
    assert.deepStrictEqual(fake1.calls.crop, [
      { x: 625, y: 0, width: 750, height: 1000 },
    ]);
    assert.deepStrictEqual(fake1.calls.resize, [
      { width: 1080, height: 1440, quality: "best" },
    ]);
    assert.strictEqual(
      fs.readFileSync(out1).toString(),
      "fake-jpeg-1080x1440-q92"
    );
    created.push(out1);
    console.log("landscape normalize passed");

    // 2) 竖长图 png：裁上下 → 缩放
    const tall = path.join(workDir, "tall.png");
    fs.writeFileSync(tall, makeFileBuf(PNG_MAGIC));
    const fake2 = makeFakeNativeImage(800, 1600);
    const out2 = await normalizeCoverForUpload(tall, { nativeImage: fake2 });
    assert.notStrictEqual(out2, tall);
    assert.strictEqual(fake2.calls.crop.length, 1);
    assert.strictEqual(fake2.calls.crop[0].width, 800);
    assert.strictEqual(fake2.calls.resize[0].width, 1080);
    assert.strictEqual(fake2.calls.resize[0].height, 1440);
    created.push(out2);
    console.log("tall normalize passed");

    // 3) 已是 1080×1440 jpg：免重编码透传
    const exact = path.join(workDir, "exact.jpg");
    fs.writeFileSync(exact, makeFileBuf(JPEG_MAGIC));
    const fake3 = makeFakeNativeImage(1080, 1440);
    const out3 = await normalizeCoverForUpload(exact, { nativeImage: fake3 });
    assert.strictEqual(out3, exact, "已是 3:4 目标尺寸的 jpg 应透传");
    assert.strictEqual(fake3.calls.crop.length, 0);
    assert.strictEqual(fake3.calls.resize.length, 0);
    console.log("exact-size jpg passthrough passed");

    // 4) 已是 1080×1440 png：透传（三平台均收 png，不白耗一次重编码）
    const exactPng = path.join(workDir, "exact.png");
    fs.writeFileSync(exactPng, makeFileBuf(PNG_MAGIC));
    const fake4 = makeFakeNativeImage(1080, 1440);
    const out4 = await normalizeCoverForUpload(exactPng, {
      nativeImage: fake4,
    });
    assert.strictEqual(out4, exactPng);
    console.log("exact-size png passthrough passed");

    // 5) nativeImage 解不了的格式（webp/gif 模拟：魔数不匹配）→ 回退原图
    const weird = path.join(workDir, "cover.webp");
    fs.writeFileSync(weird, Buffer.from("RIFF0000WEBPVP8 fake"));
    const fake5 = makeFakeNativeImage(800, 600);
    const out5 = await normalizeCoverForUpload(weird, { nativeImage: fake5 });
    assert.strictEqual(out5, weird, "解不了的格式应回退原图");
    console.log("undecodable fallback passed");

    // 6) 解码失败（isEmpty）→ 回退原图不抛错
    const broken = path.join(workDir, "broken.jpg");
    fs.writeFileSync(broken, makeFileBuf(JPEG_MAGIC));
    const fake6 = makeFakeNativeImage(800, 600, { decodable: false });
    const out6 = await normalizeCoverForUpload(broken, { nativeImage: fake6 });
    assert.strictEqual(out6, broken, "解码失败应回退原图");
    console.log("decode-failure fallback passed");

    // 7) 无 nativeImage（纯 node 环境）→ 回退原图不抛错
    const plain = path.join(workDir, "plain.jpg");
    fs.writeFileSync(plain, makeFileBuf(JPEG_MAGIC));
    const out7 = await normalizeCoverForUpload(plain);
    assert.strictEqual(out7, plain, "无 nativeImage 应回退原图");
    console.log("no-nativeImage fallback passed");

    // 8) 文件不存在 → 回退原路径不抛错
    const missing = path.join(workDir, "not-exist.jpg");
    const out8 = await normalizeCoverForUpload(missing, {
      nativeImage: makeFakeNativeImage(100, 100),
    });
    assert.strictEqual(out8, missing);
    console.log("missing-file fallback passed");

    // 9) 同一源图重复归一：产物路径稳定（重试复用，tmpdir 不膨胀）
    const out9 = await normalizeCoverForUpload(landscape, {
      nativeImage: makeFakeNativeImage(2000, 1000),
    });
    assert.strictEqual(out9, out1, "同源图归一产物路径应稳定");
    console.log("stable temp path passed");

    // 10) 横版封面 normalizeHorizontalCoverForUpload：16:9 居中裁切为 1440×1080 JPEG，不拉伸
    const wide169 = path.join(workDir, "wide169.jpg");
    fs.writeFileSync(wide169, makeFileBuf(JPEG_MAGIC));
    const fakeH1 = makeFakeNativeImage(1920, 1080);
    const outH1 = await normalizeHorizontalCoverForUpload(wide169, {
      nativeImage: fakeH1,
    });
    assert.notStrictEqual(outH1, wide169);
    assert.notStrictEqual(outH1, out1);
    assert.deepStrictEqual(fakeH1.calls.crop, [
      { x: 240, y: 0, width: 1440, height: 1080 },
    ]);
    assert.deepStrictEqual(fakeH1.calls.resize, [
      { width: 1440, height: 1080, quality: "best" },
    ]);
    assert.strictEqual(
      fs.readFileSync(outH1).toString(),
      "fake-jpeg-1440x1080-q92"
    );
    created.push(outH1);

    // 11) 已是 1440×1080 jpg：透传
    const exactH = path.join(workDir, "exact-h.jpg");
    fs.writeFileSync(exactH, makeFileBuf(JPEG_MAGIC));
    const fakeHExact = makeFakeNativeImage(1440, 1080);
    assert.strictEqual(
      await normalizeHorizontalCoverForUpload(exactH, { nativeImage: fakeHExact }),
      exactH
    );
    assert.strictEqual(fakeHExact.calls.crop.length, 0);
    console.log("normalizeHorizontalCoverForUpload passed");

    // 12) generateHorizontalCoverFromVertical：竖图(1080×1440) 自动生成 1440×1080（模糊压暗背景 + 居中主体）
    const verticalSrc = path.join(workDir, "vertical-34.jpg");
    fs.writeFileSync(verticalSrc, makeFileBuf(JPEG_MAGIC));
    const fakeGen = makeFakeNativeImage(1080, 1440, {
      bgColor: [100, 100, 100, 255],
      fgColor: [230, 240, 250, 255],
    });
    const genRes = await generateHorizontalCoverFromVertical(verticalSrc, {
      nativeImage: fakeGen,
    });
    assert.strictEqual(genRes.ok, true);
    assert.strictEqual(genRes.generated, true);
    assert.ok(fs.existsSync(genRes.coverPath));
    assert.strictEqual(path.extname(genRes.coverPath), ".jpg");
    assert.strictEqual(
      fs.readFileSync(genRes.coverPath).toString(),
      "fake-jpeg-1440x1080-q92"
    );
    // 验证确实走了 缩小到 36×27 → 放大回 1440×1080 近似模糊，以及前景等比缩放到 810×1080
    assert.ok(
      fakeGen.calls.resize.some((r) => r.width === 36 && r.height === 27),
      "应先缩放到 36×27 做近似模糊"
    );
    assert.ok(
      fakeGen.calls.resize.some((r) => r.width === 1440 && r.height === 1080),
      "应再放大到 1440×1080 铺满背景"
    );
    assert.ok(
      fakeGen.calls.resize.some((r) => r.width === 810 && r.height === 1080),
      "竖封面主体应按高度 1080 等比缩放到 810×1080（不硬裁 3:4）"
    );
    assert.strictEqual(fakeGen.calls.createFromBitmap.length, 1);
    const createdBmp = fakeGen.calls.createFromBitmap[0];
    // 左边缘 (x=0, y=0) 应为压暗后的背景像素
    assert.deepStrictEqual(createdBmp.sampleEdge, [62, 62, 62, 255]);
    // 正中央 (x=720, y=540) 应为完整未压暗的前景像素
    const centerOff = (540 * 1440 + 720) * 4;
    assert.deepStrictEqual(
      [...createdBmp.bitmapBuf.slice(centerOff, centerOff + 4)],
      [230, 240, 250, 255]
    );
    created.push(genRes.coverPath);

    // 13) generateHorizontalCoverFromVertical 失败不抛错（缺 bitmap API / 文件不存在）
    const genFailNoBmp = await generateHorizontalCoverFromVertical(verticalSrc, {
      nativeImage: makeFakeNativeImage(1080, 1440, { withBitmap: false }),
    });
    assert.strictEqual(genFailNoBmp.ok, false);
    assert.strictEqual(genFailNoBmp.coverPath, "");
    assert.ok(genFailNoBmp.reason);
    const genFailMissing = await generateHorizontalCoverFromVertical(missing, {
      nativeImage: makeFakeNativeImage(1080, 1440),
    });
    assert.strictEqual(genFailMissing.ok, false);
    console.log("generateHorizontalCoverFromVertical passed");

    // 14) resolveDualCoversForUpload：
    //   a) 同时给竖+横 → 各自归一，horizontalAutoGenerated=false
    const dualBoth = await resolveDualCoversForUpload(
      { coverPath: verticalSrc, coverPathH: wide169 },
      { nativeImage: makeFakeNativeImage(1920, 1080) }
    );
    assert.ok(dualBoth.verticalPath);
    assert.ok(dualBoth.horizontalPath);
    assert.strictEqual(dualBoth.horizontalAutoGenerated, false);
    created.push(dualBoth.verticalPath, dualBoth.horizontalPath);

    //   b) 只给竖 → 自动生成横，horizontalAutoGenerated=true
    const dualAuto = await resolveDualCoversForUpload(
      { coverPath: verticalSrc },
      { nativeImage: makeFakeNativeImage(1080, 1440) }
    );
    assert.strictEqual(dualAuto.verticalPath, verticalSrc);
    assert.ok(dualAuto.horizontalPath);
    assert.strictEqual(dualAuto.horizontalAutoGenerated, true);
    created.push(dualAuto.horizontalPath);

    //   c) 只给竖但横生成失败 → 保留竖封面 + 告警，不中止不抛错
    const dualWarn = await resolveDualCoversForUpload(
      { coverPath: verticalSrc },
      { nativeImage: makeFakeNativeImage(1080, 1440, { failCreateFromBitmap: true }) }
    );
    assert.strictEqual(dualWarn.verticalPath, verticalSrc);
    assert.strictEqual(dualWarn.horizontalPath, "");
    assert.strictEqual(dualWarn.horizontalAutoGenerated, false);
    assert.ok(dualWarn.horizontalGenWarning);

    //   d) 都没给封面 → 均为空（回归原行为）
    const dualEmpty = await resolveDualCoversForUpload({});
    assert.strictEqual(dualEmpty.verticalPath, "");
    assert.strictEqual(dualEmpty.horizontalPath, "");
    assert.strictEqual(dualEmpty.horizontalAutoGenerated, false);
    console.log("resolveDualCoversForUpload passed");
  } finally {
    for (const f of created) {
      try {
        fs.unlinkSync(f);
      } catch (_) {}
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log("test-cover-compat passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
