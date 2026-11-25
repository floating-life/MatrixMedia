import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

/**
 * 封面归一（cover compat）：源图尺寸/比例五花八门（用户随手截图、横图、webp），
 * 平台封面上传框对标准比例体验最好：
 *   - 竖版封面（3:4）：1080×1440 JPEG（抖音 / 快手 / 视频号）
 *   - 横版封面（4:3）：1440×1080 JPEG（抖音 / 视频号）
 *     - 用户提供了横版封面 coverPathH：按 4:3 居中裁切（只裁不拉伸）再缩放到 1440×1080 JPEG
 *     - 用户未提供横版封面但提供了竖版封面：自动生成 1440×1080 JPEG ——
 *       竖封面按高度 1080 完整居中，两侧用同图 4:3 放大铺满 + 缩小再放大近似模糊 + 略压暗作背景
 *       （不把 3:4 硬裁成 4:3 砍掉主体）。自动生成失败时记录告警并返回失败结果，调用方仅设竖封面、不中止发布。
 *
 * 原则：归一只是「锦上添花」，任何一步失败（非 Electron 环境跑测试、
 * nativeImage 解不了 webp/gif、写盘失败……）都回退原图继续走上传，
 * 绝不能因为归一失败把整个发布流程阻断。
 */

export const COVER_TARGET_WIDTH = 1080;
export const COVER_TARGET_HEIGHT = 1440;

export const COVER_H_TARGET_WIDTH = 1440;
export const COVER_H_TARGET_HEIGHT = 1080;

/** 近似模糊缩放尺寸（保持 4:3 比例，先缩到此尺寸再放大到 1440×1080） */
export const COVER_H_BLUR_WIDTH = 36;
export const COVER_H_BLUR_HEIGHT = 27;

/** 模糊背景压暗系数（0~1，越小越暗；0.62 略压暗突出居中主体） */
export const COVER_H_BG_DARKEN_FACTOR = 0.62;

/**
 * 居中裁切矩形计算（纯函数，便于单测）。
 * 默认按 3:4（1080×1440），传入 1440×1080 即按 4:3 计算。
 * 同比例（含误差容限）返回 null 表示无需裁切；异常尺寸也返回 null。
 */
export function computeCenterCrop(
  srcW,
  srcH,
  targetW = COVER_TARGET_WIDTH,
  targetH = COVER_TARGET_HEIGHT
) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) return null;
  if (!Number.isFinite(targetW) || !Number.isFinite(targetH)) return null;
  if (srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) return null;
  const targetAspect = targetW / targetH;
  const srcAspect = srcW / srcH;
  if (Math.abs(srcAspect - targetAspect) < 1e-6) return null; // 同比：不裁
  let x = 0;
  let y = 0;
  let w;
  let h;
  if (srcAspect > targetAspect) {
    // 偏宽（含横图）：裁两侧，保留全高
    h = srcH;
    w = Math.round(srcH * targetAspect);
    x = Math.round((srcW - w) / 2);
  } else {
    // 偏高（含竖图）：裁上下，保留全宽
    w = srcW;
    h = Math.round(srcW / targetAspect);
    y = Math.round((srcH - h) / 2);
  }
  // 防御：数值异常时不越界（越界 crop 在 nativeImage 上产出空图）
  w = Math.min(w, srcW);
  h = Math.min(h, srcH);
  x = Math.max(0, Math.min(x, srcW - w));
  y = Math.max(0, Math.min(y, srcH - h));
  if (w <= 0 || h <= 0) return null;
  return { x, y, width: w, height: h };
}

/**
 * 计算「竖封面 → 4:3 横封面（1440×1080）」合成布局（纯函数，便于单测）：
 * - 前景：按高度 targetH（1080）完整等比缩放居中（若源图已比目标更宽则按宽适配，永不越界）
 * - 背景：同图按 4:3 居中裁切铺满 → 缩到 blurW×blurH → 放大至 targetW×targetH 近似模糊
 *
 * @returns {{ targetW: number, targetH: number, fgW: number, fgH: number, fgX: number, fgY: number, bgCrop: object|null, blurW: number, blurH: number } | null}
 */
export function computeHorizontalFromVerticalLayout(
  srcW,
  srcH,
  targetW = COVER_H_TARGET_WIDTH,
  targetH = COVER_H_TARGET_HEIGHT
) {
  if (!Number.isFinite(srcW) || !Number.isFinite(srcH)) return null;
  if (!Number.isFinite(targetW) || !Number.isFinite(targetH)) return null;
  if (srcW <= 0 || srcH <= 0 || targetW <= 0 || targetH <= 0) return null;

  const scale = Math.min(targetH / srcH, targetW / srcW);
  let fgW = Math.round(srcW * scale);
  let fgH = Math.round(srcH * scale);
  fgW = Math.max(1, Math.min(targetW, fgW));
  fgH = Math.max(1, Math.min(targetH, fgH));
  const fgX = Math.floor((targetW - fgW) / 2);
  const fgY = Math.floor((targetH - fgH) / 2);

  const bgCrop = computeCenterCrop(srcW, srcH, targetW, targetH);
  const blurW = Math.max(8, Math.min(targetW, Math.round(COVER_H_BLUR_WIDTH)));
  const blurH = Math.max(6, Math.min(targetH, Math.round(COVER_H_BLUR_HEIGHT)));

  return {
    targetW,
    targetH,
    fgW,
    fgH,
    fgX,
    fgY,
    bgCrop,
    blurW,
    blurH,
  };
}

/**
 * 将「模糊背景 bitmap（targetW×targetH×4）」压暗并叠加「居中前景 bitmap（fgW×fgH×4）」（纯函数，便于单测）。
 * Electron nativeImage.toBitmap() 产出 4 字节/像素（BGRA/RGBA，前三字节为三原色，第 4 字节为 Alpha），
 * 对前三通道统一乘以 darkenFactor 与通道顺序无关，跨 Windows/macOS/Linux 一致。
 *
 * @param {Buffer} bgBuf
 * @param {Buffer} fgBuf
 * @param {{ targetW: number, targetH: number, fgW: number, fgH: number, fgX: number, fgY: number }} layout
 * @param {{ darkenFactor?: number }} [opts]
 * @returns {Buffer|null}
 */
export function compositeCenteredBitmap(bgBuf, fgBuf, layout, opts = {}) {
  if (!Buffer.isBuffer(bgBuf) || !Buffer.isBuffer(fgBuf) || !layout) {
    return null;
  }
  const { targetW, targetH, fgW, fgH, fgX, fgY } = layout;
  const expectedBgBytes = targetW * targetH * 4;
  const expectedFgBytes = fgW * fgH * 4;
  if (
    expectedBgBytes <= 0 ||
    expectedFgBytes <= 0 ||
    bgBuf.length !== expectedBgBytes ||
    fgBuf.length !== expectedFgBytes
  ) {
    return null;
  }
  if (
    fgX < 0 ||
    fgY < 0 ||
    fgX + fgW > targetW ||
    fgY + fgH > targetH
  ) {
    return null;
  }

  const rawDarken =
    typeof opts.darkenFactor === "number" && Number.isFinite(opts.darkenFactor)
      ? opts.darkenFactor
      : COVER_H_BG_DARKEN_FACTOR;
  const darken = Math.max(0, Math.min(1, rawDarken));

  const out = Buffer.allocUnsafe(expectedBgBytes);
  // 1. 压暗背景（三色通道乘 darken，Alpha 置 255）
  for (let i = 0; i < expectedBgBytes; i += 4) {
    out[i] = Math.round(bgBuf[i] * darken);
    out[i + 1] = Math.round(bgBuf[i + 1] * darken);
    out[i + 2] = Math.round(bgBuf[i + 2] * darken);
    out[i + 3] = 255;
  }

  // 2. 居中叠放前景（支持透明 PNG 像素按 alpha 混合）
  for (let row = 0; row < fgH; row++) {
    const srcRowStart = row * fgW * 4;
    const dstRowStart = ((fgY + row) * targetW + fgX) * 4;
    for (let col = 0; col < fgW; col++) {
      const si = srcRowStart + col * 4;
      const di = dstRowStart + col * 4;
      const a = fgBuf[si + 3];
      if (a === 255) {
        out[di] = fgBuf[si];
        out[di + 1] = fgBuf[si + 1];
        out[di + 2] = fgBuf[si + 2];
        out[di + 3] = 255;
      } else if (a > 0) {
        const inv = 255 - a;
        out[di] = Math.round((fgBuf[si] * a + out[di] * inv) / 255);
        out[di + 1] = Math.round((fgBuf[si + 1] * a + out[di + 1] * inv) / 255);
        out[di + 2] = Math.round((fgBuf[si + 2] * a + out[di + 2] * inv) / 255);
        out[di + 3] = 255;
      }
    }
  }

  return out;
}

function isJpeg(buf) {
  return (
    buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8
  );
}

function isPng(buf) {
  return (
    buf &&
    buf.length > 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  );
}

/**
 * 惰性取 Electron nativeImage：
 * - 打包/运行于 Electron main 进程：require("electron") 返回 API 对象
 * - 纯 node（跑测试/CLI 直跑脚本）：require("electron") 返回二进制路径字符串
 *   或抛错 → 返回 null，上层回退原图
 * 不用顶层 import，保证本模块在纯 node 下可加载（测试直接 esbuild 打包）。
 */
let cachedNativeImage;
function loadNativeImage() {
  if (cachedNativeImage !== undefined) return cachedNativeImage;
  try {
    // eslint-disable-next-line global-require
    const electron = require("electron");
    cachedNativeImage =
      electron &&
      typeof electron === "object" &&
      electron.nativeImage &&
      typeof electron.nativeImage.createFromBuffer === "function"
        ? electron.nativeImage
        : null;
  } catch (_) {
    cachedNativeImage = null;
  }
  return cachedNativeImage;
}

/** 归一产物路径：按源路径+大小+mtime+规格标签 hash 命名，同一源图重试复用同一产物，tmpdir 不膨胀 */
function tempCoverPath(coverPath, stat, variant = "") {
  const seed = variant
    ? `${coverPath}|${stat.size}|${stat.mtimeMs}|${variant}`
    : `${coverPath}|${stat.size}|${stat.mtimeMs}`;
  const key = crypto
    .createHash("sha1")
    .update(seed)
    .digest("hex")
    .slice(0, 16);
  const prefix = variant ? `mm-cover-${variant.replace(/[^a-z0-9_-]/gi, "")}-` : "mm-cover-";
  return path.join(os.tmpdir(), `${prefix}${key}.jpg`);
}

/**
 * 归一封面到指定尺寸（默认 1080×1440，3:4 居中裁切不拉伸，JPEG 输出）。
 * 返回可用封面路径：归一成功 → tmpdir 内的 jpg；任何失败 → 原路径（回退）。
 * opts.nativeImage 供测试注入 fake 实现；缺省在 Electron main 下取真实实现。
 */
export async function normalizeCoverForUpload(coverPath, opts = {}) {
  const targetW = opts.width || COVER_TARGET_WIDTH;
  const targetH = opts.height || COVER_TARGET_HEIGHT;
  const variant =
    opts.variant !== undefined
      ? opts.variant
      : targetW === COVER_TARGET_WIDTH && targetH === COVER_TARGET_HEIGHT
      ? ""
      : `${targetW}x${targetH}`;
  try {
    const stat = fs.statSync(coverPath);
    if (!stat.isFile()) return coverPath;

    const nativeImage = opts.nativeImage || loadNativeImage();
    if (!nativeImage) {
      console.warn(
        "[cover-compat] 无 nativeImage（非 Electron 环境），使用原封面:",
        coverPath
      );
      return coverPath;
    }

    const srcBuf = fs.readFileSync(coverPath);
    const img = nativeImage.createFromBuffer(srcBuf);
    if (!img || img.isEmpty()) {
      // webp/gif 等 nativeImage 解不了的格式：回退原图（平台上传框自己处理）
      console.warn(
        "[cover-compat] nativeImage 无法解析封面格式，使用原封面:",
        coverPath
      );
      return coverPath;
    }
    const { width: srcW, height: srcH } = img.getSize();
    if (!srcW || !srcH) return coverPath;

    // 已是目标尺寸的 jpg/png：免重编码透传（保画质、省时间）
    if (srcW === targetW && srcH === targetH && (isJpeg(srcBuf) || isPng(srcBuf))) {
      return coverPath;
    }

    let work = img;
    const rect = computeCenterCrop(srcW, srcH, targetW, targetH);
    if (rect) work = img.crop(rect);
    const resized = work.resize({ width: targetW, height: targetH, quality: "best" });
    if (!resized || resized.isEmpty()) {
      console.warn("[cover-compat] 裁切/缩放失败，使用原封面:", coverPath);
      return coverPath;
    }
    const jpg = resized.toJPEG(92);
    if (!jpg || !jpg.length) {
      console.warn("[cover-compat] JPEG 编码失败，使用原封面:", coverPath);
      return coverPath;
    }

    const outPath = tempCoverPath(coverPath, stat, variant);
    fs.writeFileSync(outPath, jpg);
    console.log(
      `[cover-compat] 封面已归一 ${srcW}×${srcH} → ${targetW}×${targetH} (jpg): ${outPath}`
    );
    return outPath;
  } catch (e) {
    console.warn(
      `[cover-compat] 封面归一失败，使用原封面: ${(e && e.message) || e}`
    );
    return coverPath;
  }
}

/**
 * 归一横版封面到 1440×1080（4:3 居中裁切不拉伸，JPEG 输出）。
 */
export async function normalizeHorizontalCoverForUpload(coverPathH, opts = {}) {
  return normalizeCoverForUpload(coverPathH, {
    ...opts,
    width: opts.width || COVER_H_TARGET_WIDTH,
    height: opts.height || COVER_H_TARGET_HEIGHT,
    variant: opts.variant || "h1440x1080",
  });
}

/**
 * 从竖版封面自动生成 1440×1080（4:3）横版封面 JPEG：
 * - 前景：竖封面按高度 1080 完整等比居中（不把 3:4 硬裁成 4:3）
 * - 背景：同图按 4:3 放大铺满 → 先缩到 36×27 再放大到 1440×1080（近似模糊）+ 略压暗（0.62）
 *
 * 失败绝不抛错：返回 `{ ok: false, coverPath: "", reason }` 并打告警日志，
 * 调用方只设竖封面，不中止发布。
 *
 * @param {string} verticalCoverPath
 * @param {{ nativeImage?: object, width?: number, height?: number, darkenFactor?: number }} [opts]
 * @returns {Promise<{ ok: boolean, coverPath: string, generated?: boolean, layout?: object, reason?: string }>}
 */
export async function generateHorizontalCoverFromVertical(
  verticalCoverPath,
  opts = {}
) {
  const targetW = opts.width || COVER_H_TARGET_WIDTH;
  const targetH = opts.height || COVER_H_TARGET_HEIGHT;
  const fail = (reason) => {
    console.warn(
      `[cover-compat] 自动生成横版封面(4:3)失败，将仅设竖封面: ${reason}`
    );
    return { ok: false, coverPath: "", generated: false, reason };
  };

  try {
    if (!verticalCoverPath || !fs.existsSync(verticalCoverPath)) {
      return fail(`竖封面文件不存在: ${verticalCoverPath || "(空)"}`);
    }
    const stat = fs.statSync(verticalCoverPath);
    if (!stat.isFile()) {
      return fail(`竖封面路径不是文件: ${verticalCoverPath}`);
    }

    const nativeImage = opts.nativeImage || loadNativeImage();
    if (
      !nativeImage ||
      typeof nativeImage.createFromBuffer !== "function" ||
      typeof nativeImage.createFromBitmap !== "function"
    ) {
      return fail("无可用 nativeImage（需 Electron 环境且支持 createFromBitmap）");
    }

    const srcBuf = fs.readFileSync(verticalCoverPath);
    const img = nativeImage.createFromBuffer(srcBuf);
    if (!img || img.isEmpty()) {
      return fail(`nativeImage 无法解析竖封面格式: ${verticalCoverPath}`);
    }
    const { width: srcW, height: srcH } = img.getSize();
    const layout = computeHorizontalFromVerticalLayout(srcW, srcH, targetW, targetH);
    if (!layout) {
      return fail(`竖封面尺寸异常: ${srcW}×${srcH}`);
    }

    // 1. 生成模糊背景：按 4:3 居中裁切铺满 → 缩到极小尺寸 → 放大回 1440×1080
    let bgWork = img;
    if (layout.bgCrop) {
      bgWork = img.crop(layout.bgCrop);
    }
    if (!bgWork || bgWork.isEmpty()) {
      return fail("背景裁切失败");
    }
    const bgSmall = bgWork.resize({
      width: layout.blurW,
      height: layout.blurH,
      quality: "good",
    });
    if (!bgSmall || bgSmall.isEmpty()) {
      return fail("背景模糊缩小失败");
    }
    const bgBlurred = bgSmall.resize({
      width: layout.targetW,
      height: layout.targetH,
      quality: "best",
    });
    if (!bgBlurred || bgBlurred.isEmpty() || typeof bgBlurred.toBitmap !== "function") {
      return fail("背景模糊放大或导出 bitmap 失败");
    }

    // 2. 生成居中前景：按高度 1080 完整等比缩放
    const fgImg =
      srcW === layout.fgW && srcH === layout.fgH
        ? img
        : img.resize({
            width: layout.fgW,
            height: layout.fgH,
            quality: "best",
          });
    if (!fgImg || fgImg.isEmpty() || typeof fgImg.toBitmap !== "function") {
      return fail("前景缩放或导出 bitmap 失败");
    }

    const bgBitmap = bgBlurred.toBitmap();
    const fgBitmap = fgImg.toBitmap();
    const mergedBitmap = compositeCenteredBitmap(bgBitmap, fgBitmap, layout, {
      darkenFactor: opts.darkenFactor,
    });
    if (!mergedBitmap) {
      return fail("合成 4:3 横版封面 bitmap 失败（尺寸不匹配）");
    }

    const outImg = nativeImage.createFromBitmap(mergedBitmap, {
      width: layout.targetW,
      height: layout.targetH,
    });
    if (!outImg || outImg.isEmpty()) {
      return fail("createFromBitmap 产出空图");
    }
    const jpg = outImg.toJPEG(92);
    if (!jpg || !jpg.length) {
      return fail("横版封面 JPEG 编码失败");
    }

    const outPath = tempCoverPath(
      verticalCoverPath,
      stat,
      `autoh${layout.targetW}x${layout.targetH}`
    );
    fs.writeFileSync(outPath, jpg);
    console.log(
      `[cover-compat] 已由竖封面(${srcW}×${srcH})自动生成横版封面 ${layout.targetW}×${layout.targetH}（主体居中 ${layout.fgW}×${layout.fgH} @ x=${layout.fgX}, 两侧模糊压暗）: ${outPath}`
    );
    return {
      ok: true,
      coverPath: outPath,
      generated: true,
      layout,
    };
  } catch (e) {
    return fail((e && e.message) || String(e));
  }
}

/**
 * 为双比例封面平台（抖音 / 视频号）解析最终竖封面与横封面：
 * - 有 coverPath：归一为 1080×1440（3:4）
 * - 有 coverPathH：归一为 1440×1080（4:3 居中裁切）
 * - 无 coverPathH 但有 coverPath：自动由竖封面生成 1440×1080（生成失败仅告警、horizontalPath=""、不中止）
 * - 都无：均返回 ""
 */
export async function resolveDualCoversForUpload(
  { coverPath = "", coverPathH = "" } = {},
  opts = {}
) {
  const rawV = String(coverPath || "").trim();
  const rawH = String(coverPathH || "").trim();
  let verticalPath = "";
  let horizontalPath = "";
  let horizontalAutoGenerated = false;
  let horizontalGenWarning = "";

  if (rawV) {
    verticalPath = await normalizeCoverForUpload(rawV, opts);
  }
  if (rawH) {
    horizontalPath = await normalizeHorizontalCoverForUpload(rawH, opts);
  } else if (rawV) {
    const gen = await generateHorizontalCoverFromVertical(
      verticalPath || rawV,
      opts
    );
    if (gen.ok && gen.coverPath) {
      horizontalPath = gen.coverPath;
      horizontalAutoGenerated = true;
    } else {
      horizontalGenWarning = gen.reason || "自动生成横版封面失败";
    }
  }

  return {
    verticalPath,
    horizontalPath,
    horizontalAutoGenerated,
    horizontalGenWarning,
  };
}
