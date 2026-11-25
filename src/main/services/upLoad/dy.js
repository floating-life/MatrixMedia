import path from "path";
import fs from "fs";
import * as coverCompat from "../coverCompat.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import { resolveVideoLinkOption } from "../../../shared/videoLink.js";
import {
  DY_PUBLISH_BUTTON_SELECTOR,
  DY_DRAFT_BUTTON_SELECTOR,
  ALL_PLATFORM_SUBMIT_SELECTORS,
} from "../../../shared/collectionShared.js";
import { attachDyProductLink } from "./dyProductLink.js";
import { selectPlatformCollection } from "./collection.js";
import { resolveDyCreativeStatementLabel } from "../../../shared/creativeStatement.js";
import {
  readPageUrl,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";
import {
  buildPlatformVideoTextDetailed,
  normalizeVideoTags,
} from "../../../shared/videoMetadata.js";
import {
  formatRuleAdjustmentsSummary,
  mergeRuleAdjustments,
} from "../../../shared/platformRules.js";
import {
  head,
  matchesHead,
  normalizeForCompare,
  replaceAllText,
} from "./textReadback.js";
import {
  isAiChaptersRequested,
  appendPublishReceiptNote,
} from "../../../shared/publishExtras.js";
import { executeAiChaptersFlow } from "../../../shared/publishExtrasDom.js";

/**
 * 抖音发布页「AI 自动章节」选择器与候选文案集中配置【未经真机校准，待真机存草稿核对】。
 * 找不到入口或短视频不支持时告警并继续发布，回执写「章节：不支持」；
 * 点选后回读未选中时重试一次，仍失败则告警继续，回执写「章节：失败」。
 */
export const DY_AI_CHAPTERS_SELECTORS = Object.freeze({
  wujieHost: "",
  sectionKeywords: [
    "章节",
    "视频章节",
    "智能章节",
    "内容章节",
    "添加章节",
    "章节信息",
  ],
  aiOptionKeywords: [
    "AI自动添加章节",
    "AI自动生成章节",
    "AI智能生成章节",
    "智能生成章节",
    "自动生成章节",
    "自动添加章节",
    "AI章节",
    "智能章节",
    "AI智能章节",
  ],
  entryButtonKeywords: ["添加章节", "设置章节", "视频章节", "编辑章节"],
  unsupportedPatterns: [
    "不支持章节",
    "暂不支持",
    "时长不足",
    "视频过短",
    "无法生成章节",
    "不支持添加章节",
    "不支持自动章节",
    "暂无法生成章节",
    "小于",
    "不足",
  ],
  toggleSelectors: [
    ".semi-switch",
    ".semi-checkbox",
    ".semi-radio",
    "[role='switch']",
    "[role='checkbox']",
    "[role='radio']",
    "label",
    "input[type='checkbox']",
    "input[type='radio']",
  ],
  dialogSelectors: [
    ".semi-modal",
    ".semi-modal-content",
    ".dy-creator-content-modal-wrap",
    "[role='dialog']",
  ],
  confirmButtonTexts: ["确定", "确认", "完成", "应用"],
  submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
  submitTexts: [
    "发布",
    "发表",
    "立即发布",
    "定时发布",
    "存草稿",
    "保存草稿",
    "暂存离开",
    "保存",
    "提交",
    "取消",
    "取消发布",
    "确认发布",
  ],
  dispatchMouseEvents: false,
  diagSelectors: [
    "[class*='chapter']",
    "[class*='Chapter']",
    "[class*='section']",
  ],
  diagKeywords: ["章节", "AI", "智能生成", "自动添加"],
});

export async function applyDyAiChapters(
  page,
  { data, window, timeouts } = {}
) {
  return executeAiChaptersFlow(page, {
    platformTag: "dy",
    platformLabel: "抖音",
    cfg: DY_AI_CHAPTERS_SELECTORS,
    data,
    window,
    captureScreenshot: capturePublishFailureScreenshot,
    timeouts,
  });
}

async function dismissDyGuideModals(page) {
  const closed = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    let n = 0;
    for (const b of document.querySelectorAll("button, [role='button']")) {
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || b.disabled) continue;
      const t = norm(b.textContent);
      if (t === "我知道了" || t === "知道了") {
        b.click();
        n++;
      }
    }
    return n;
  });
  if (closed > 0) {
    console.log(`[dy] 已关闭 ${closed} 个引导弹窗`);
    await page.waitForTimeout(600);
  }
  return closed;
}

/**
 * 上传自定义竖封面（3:4）。流程经 DOM 探针实证（2026-10）：
 * 点「选择封面」槽位 → 封面弹窗(.dy-creator-content-modal-wrap) → 点「上传封面」→
 * 文件注入「点击上传文件或拖拽文件到这里」拖拽区的 input（页面同时存在多个 image
 * input：商品封面/AI参考图等，必须按容器文案定位，选错会把图喂给 AI 参考图功能）→
 * 「完成」→ 可能弹「设置横封面获更多流量」引导，点「暂不设置」（横封面会基于竖封面
 * 自动生成）→ 校验槽位文案变为「编辑封面」。
 */
async function uploadDyCustomCover(page, coverPath) {
  if (!fs.existsSync(coverPath)) {
    throw new Error(`封面文件不存在: ${coverPath}`);
  }
  // 封面归一：非 3:4 源图居中裁切成 1080×1440 jpg（失败回退原图，不阻断发布）
  coverPath =
    typeof coverCompat.normalizeCoverForUpload === "function"
      ? await coverCompat.normalizeCoverForUpload(coverPath)
      : coverPath;

  // 记录设置前封面槽位的 img src：平台自动截帧的默认封面本来就在抖音 CDN 域名下，
  // 只判「槽位出现 douyin 图」会让上传失败也通过校验；必须对比前后 src 变化（同 ks/sph）
  const slotSrcsBefore = await page.evaluate(() => {
    const srcs = [];
    for (const e of document.querySelectorAll('[class*="cover"],[class*="Cover"]')) {
      const r = e.getBoundingClientRect();
      if (r.width < 50 || r.height < 50 || r.width > 400) continue;
      const img = e.querySelector("img");
      if (img && img.src) srcs.push(img.src);
    }
    return srcs;
  });

  const opened = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const slots = [...document.querySelectorAll("div,span")].filter((e) => {
      const r = e.getBoundingClientRect();
      return (
        r.width > 30 &&
        r.height > 30 &&
        (norm(e.textContent) === "选择封面" || norm(e.textContent) === "编辑封面")
      );
    });
    if (!slots.length) return false;
    slots[0].click();
    return true;
  });
  if (!opened) throw new Error("未找到「选择封面」入口（视频可能未就绪）");
  await page.waitForSelector(".dy-creator-content-modal-wrap", {
    visible: true,
    timeout: 15000,
  });
  await page.waitForTimeout(1500);

  const panelClicked = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const cands = [...document.querySelectorAll("button,[role='button'],div,span,[class*='tab'],[class*='upload']")].filter((e) => {
      const r = e.getBoundingClientRect();
      const t = norm(e.textContent);
      return r.width > 0 && (t === "上传封面" || t === "+上传封面");
    });
    const exact = cands.find((e) => norm(e.textContent) === "上传封面") || cands[0];
    if (!exact) return false;
    exact.click();
    return true;
  });
  if (!panelClicked) throw new Error("封面弹窗内未找到「上传封面」入口");
  await page.waitForTimeout(1500);

  const inputHandle = await page.evaluateHandle(() => {
    const inputs = [...document.querySelectorAll("input[type=file]")].filter((i) =>
      /image/.test(i.accept || "")
    );
    for (const inp of inputs) {
      let a = inp;
      let text = "";
      for (let k = 0; k < 6 && a; k++) {
        a = a.parentElement;
        if (a) text = (a.textContent || "").replace(/\s+/g, " ");
        if (text.includes("拖拽文件到这里")) return inp;
      }
    }
    return null;
  });
  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error("未找到封面上传拖拽区的 file input");
  await inputEl.uploadFile(path.resolve(coverPath));
  console.log("[dy] 封面文件已注入上传区:", coverPath);

  await page.waitForTimeout(4000);
  const done = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const modal = document.querySelector(".dy-creator-content-modal-wrap");
    if (!modal) return false;
    const b = [...modal.querySelectorAll("button,[role='button']")].find(
      (x) => x.getBoundingClientRect().width > 0 && !x.disabled && norm(x.textContent) === "完成"
    );
    if (!b) return false;
    b.click();
    return true;
  });
  if (!done) throw new Error("封面弹窗内未找到「完成」按钮");
  await page.waitForTimeout(2500);

  // 「设置横封面获更多流量」引导弹窗 →「暂不设置」；横封面会基于竖封面自动生成
  await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const b = [...document.querySelectorAll("button,[role='button']")].find(
      (x) => x.getBoundingClientRect().width > 0 && norm(x.textContent) === "暂不设置"
    );
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  // 校验封面已设置：槽位 img src 相对设置前变化，且新 src 在抖音 CDN 域名下
  //（「编辑封面」是 hover 蒙层文案，innerText 不可见，不能作为校验信号；
  // 探针 v3 实证上传落定后槽位 img src 来自 *-creator-media-private.douyin.com）
  await page.waitForFunction(
    (prevSrcs) => {
      for (const e of document.querySelectorAll('[class*="cover"],[class*="Cover"]')) {
        const r = e.getBoundingClientRect();
        if (r.width < 50 || r.height < 50 || r.width > 400) continue;
        const img = e.querySelector("img");
        if (!img || !img.src) continue;
        if (/douyin/.test(img.src) && !prevSrcs.includes(img.src)) return true;
      }
      return false;
    },
    { timeout: 20000 },
    slotSrcsBefore
  ).catch(() => {
    throw new Error(
      `抖音封面设置后槽位图片未变化（设置前 src: ${JSON.stringify(
        slotSrcsBefore.map((s) => s.slice(0, 80))
      )}）`
    );
  });
  console.log("[dy] 自定义封面已设置并校验通过（槽位 src 变化且为抖音 CDN 图）");

  // 抖音把封面写入编辑态（暂存/恢复用）是异步落定的，无可观测信号：
  // 实证 校验通过后 2s 内「暂存离开」→ 恢复后封面丢失；35s 后暂存 → 封面完好。
  // 固定等待落定，宁可慢不可丢（封面是缩略图点击的命脉）。
  await page.waitForTimeout(25000);
  console.log("[dy] 封面落定等待完成（25s）");
}

/**
 * 抖音横版封面（4:3）DOM 选择器集中配置【未经真机校准，待真机存草稿核对】。
 * 修改选择器只需改本对象；任意步骤失败都会输出封面区 outerHTML 片段、图片列表与诊断截图。
 */
export const DY_HORIZONTAL_COVER_SELECTORS = Object.freeze({
  // 横版封面槽位优先选择器（按类名特征定位）
  slotSelectors: [
    '[class*="horizontal" i][class*="cover" i]',
    '[class*="cover" i][class*="horizontal" i]',
    '[class*="horizon" i][class*="cover" i]',
    '[class*="cover" i][class*="4-3" i]',
    '[class*="cover" i][class*="4_3" i]',
  ],
  // 通用封面区域选择器（用于文本匹配兜底与诊断采集）
  coverAreaSelector: '[class*="cover"],[class*="Cover"]',
  // 横版封面槽位文案关键字（优先于「第 2 个选择封面槽位」兜底）
  slotTextKeywords: ["横封面", "横版封面", "4:3", "4：3", "设置横封面", "选择横封面"],
  // 通用封面槽位文案（按左→右顺序，第 1 个为竖 3:4，第 2 个为横 4:3）
  genericSlotTexts: ["选择封面", "编辑封面", "更换封面", "修改封面"],
  // 封面编辑弹窗选择器
  modalSelectors: [
    ".dy-creator-content-modal-wrap",
    ".semi-modal-wrap",
    '[role="dialog"]',
  ],
  // 弹窗内上传封面入口文案
  uploadTabTexts: ["上传封面", "+上传封面", "本地上传"],
  // 拖拽上传区锚点文案
  uploadDropZoneKeyword: "拖拽文件到这里",
  // 弹窗确认按钮文案
  confirmButtonTexts: ["完成", "确定", "确认"],
});

async function dumpDyHorizontalCoverDiagnostics(page, stage, { data, window } = {}) {
  try {
    const diag = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const coverNodes = Array.from(document.querySelectorAll(cfg.coverAreaSelector));
      const snippets = [];
      const imgs = [];
      for (const el of coverNodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 20) continue;
        if (snippets.length < 6) {
          snippets.push({
            cls: String(el.className || "").slice(0, 80),
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
            },
            text: norm(el.textContent).slice(0, 80),
            outerHTML: String(el.outerHTML || "").slice(0, 600),
          });
        }
        const img = el.querySelector("img");
        if (img && img.src && imgs.length < 12) {
          imgs.push({
            parentCls: String(el.className || "").slice(0, 60),
            src: String(img.src || "").slice(0, 120),
          });
        }
      }
      const modals = Array.from(
        document.querySelectorAll(cfg.modalSelectors.join(","))
      )
        .filter((m) => {
          const r = m.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        })
        .slice(0, 3)
        .map((m) => ({
          cls: String(m.className || "").slice(0, 80),
          text: norm(m.textContent).slice(0, 160),
          outerHTML: String(m.outerHTML || "").slice(0, 600),
        }));
      return { snippets, imgs, modals };
    }, DY_HORIZONTAL_COVER_SELECTORS);
    console.warn(
      `[dy][cover-h][diag] stage=${stage} imgs=${JSON.stringify(diag.imgs)} modals=${JSON.stringify(
        diag.modals
      )}`
    );
    console.warn(
      `[dy][cover-h][diag] stage=${stage} coverAreaHTML=${JSON.stringify(
        diag.snippets
      ).slice(0, 3600)}`
    );
  } catch (e) {
    console.warn(
      `[dy][cover-h][diag] 采集 DOM 诊断失败(stage=${stage}): ${(e && e.message) || e}`
    );
  }
  try {
    const shot = await capturePublishFailureScreenshot(
      page,
      { ...(data || {}), pt: "抖音", _diagStage: `cover-h-${stage}` },
      { window }
    );
    if (shot) {
      console.warn(`[dy][cover-h][diag] stage=${stage} 诊断截图已保存: ${shot}`);
    }
  } catch (_) {
    /* 诊断截图失败不覆盖主错 */
  }
}

/**
 * 抖音上传自定义横版封面（4:3，1440×1080 JPEG）。
 * 校验与竖封面同等严格：弹窗必须关闭 且 横封面槽位 img src 相对设置前发生变化；
 * 任何一步失败均采集诊断日志（outerHTML 片段 + 截图）并抛错中止本条抖音发布。
 */
export async function uploadDyHorizontalCover(
  page,
  coverPathH,
  {
    data,
    window,
    alreadyNormalized = false,
    waitAfterUploadMs = 4000,
    pollTimeoutMs = 20000,
    settleMs = 15000,
  } = {}
) {
  if (!coverPathH || !fs.existsSync(coverPathH)) {
    throw new Error(`横版封面文件不存在: ${coverPathH}`);
  }
  const effectivePath = alreadyNormalized
    ? coverPathH
    : typeof coverCompat.normalizeHorizontalCoverForUpload === "function"
    ? await coverCompat.normalizeHorizontalCoverForUpload(coverPathH)
    : coverPathH;
  const slotAttr = "data-mm-dy-cover-h-slot";
  const slotToken = `dy-ch-${Date.now()}`;
  let stage = "定位横封面槽位";

  try {
    // 1. 定位横封面槽位并记录设置前 src，同时点击打开封面弹窗
    const locateRes = await page.evaluate(
      (cfg, attr, token) => {
        const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 30 || r.height < 20) return false;
          if (typeof getComputedStyle === "function") {
            const st = getComputedStyle(el);
            if (st && (st.display === "none" || st.visibility === "hidden")) {
              return false;
            }
          }
          return true;
        };
        const allCoverSrcs = [];
        for (const e of document.querySelectorAll(cfg.coverAreaSelector)) {
          const r = e.getBoundingClientRect();
          if (r.width < 40 || r.height < 30 || r.width > 500) continue;
          const img = e.querySelector("img");
          if (img && img.src) allCoverSrcs.push(img.src);
        }

        let target = null;
        let strategy = "";

        // 策略 1：按横封面专属选择器定位
        for (const sel of cfg.slotSelectors) {
          const cand = Array.from(document.querySelectorAll(sel)).find(isVisible);
          if (cand) {
            target = cand;
            strategy = `selector:${sel}`;
            break;
          }
        }

        // 策略 2：按横封面关键字（横封面 / 4:3 等）定位封面区容器
        if (!target) {
          const cands = Array.from(
            document.querySelectorAll(cfg.coverAreaSelector + ", div, span")
          ).filter((el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            if (r.width > 420 || r.height > 320) return false;
            const txt = norm(el.textContent);
            if (!txt || txt.length > 32) return false;
            return cfg.slotTextKeywords.some((kw) => txt.includes(norm(kw)));
          });
          if (cands.length > 0) {
            // 优先选包含 img 或文案最紧凑的卡片元素
            cands.sort((a, b) => {
              const aHasImg = a.querySelector("img") ? 0 : 1;
              const bHasImg = b.querySelector("img") ? 0 : 1;
              if (aHasImg !== bHasImg) return aHasImg - bHasImg;
              return norm(a.textContent).length - norm(b.textContent).length;
            });
            target = cands[0];
            strategy = "keyword";
          }
        }

        // 策略 3：同页面存在 ≥2 个通用封面槽位（选择封面/编辑封面），取第 2 个（左→右）
        if (!target) {
          const genericSlots = Array.from(
            document.querySelectorAll("div, span")
          ).filter((el) => {
            if (!isVisible(el)) return false;
            const t = norm(el.textContent);
            return cfg.genericSlotTexts.includes(t);
          });
          // 去重嵌套节点，只保留最内层按钮/槽位
          const deduped = genericSlots.filter(
            (el) => !genericSlots.some((o) => o !== el && el.contains(o))
          );
          if (deduped.length >= 2) {
            deduped.sort(
              (a, b) =>
                a.getBoundingClientRect().left - b.getBoundingClientRect().left
            );
            target = deduped[1];
            strategy = "second-generic-slot";
          }
        }

        if (!target) {
          return { ok: false, allCoverSrcs };
        }

        const slotContainer =
          target.closest(cfg.coverAreaSelector) || target.parentElement || target;
        slotContainer.setAttribute(attr, token);
        const imgBefore = slotContainer.querySelector("img");
        const slotSrcBefore = imgBefore && imgBefore.src ? imgBefore.src : "";
        target.click();
        return {
          ok: true,
          strategy,
          slotSrcBefore,
          allCoverSrcs,
        };
      },
      DY_HORIZONTAL_COVER_SELECTORS,
      slotAttr,
      slotToken
    );

    if (!locateRes || !locateRes.ok) {
      throw new Error("未找到抖音横版封面(4:3)入口槽位");
    }
    console.log(
      `[dy][cover-h] 已点击横封面入口（策略=${locateRes.strategy}，原src=${String(
        locateRes.slotSrcBefore || ""
      ).slice(0, 80)}）`
    );

    // 2. 等待封面弹窗出现
    stage = "等待横封面弹窗";
    const modalSel = DY_HORIZONTAL_COVER_SELECTORS.modalSelectors.join(", ");
    await page.waitForSelector(modalSel, {
      visible: true,
      timeout: 15000,
    });
    await page.waitForTimeout(1200);

    // 3. 切到「上传封面」面板（若弹窗内尚未直接露出拖拽上传区）
    stage = "点击上传封面入口";
    const tabRes = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
      const modals = Array.from(
        document.querySelectorAll(cfg.modalSelectors.join(","))
      ).filter((m) => m.getBoundingClientRect().width > 0);
      const scope = modals[modals.length - 1] || document;
      // 若拖拽上传区已存在则无需再切 tab
      if ((scope.textContent || "").includes(cfg.uploadDropZoneKeyword)) {
        return { ok: true, alreadyOnUpload: true };
      }
      const cands = Array.from(
        scope.querySelectorAll(
          "button,[role='button'],div,span,[class*='tab'],[class*='upload']"
        )
      ).filter((e) => {
        const r = e.getBoundingClientRect();
        const t = norm(e.textContent);
        return r.width > 0 && cfg.uploadTabTexts.includes(t);
      });
      const exact =
        cands.find((e) => norm(e.textContent) === "上传封面") || cands[0];
      if (!exact) return { ok: false };
      exact.click();
      return { ok: true, alreadyOnUpload: false };
    }, DY_HORIZONTAL_COVER_SELECTORS);
    if (!tabRes || !tabRes.ok) {
      throw new Error("抖音横封面弹窗内未找到「上传封面」入口");
    }
    if (!tabRes.alreadyOnUpload) {
      await page.waitForTimeout(1200);
    }

    // 4. 定位图片 file input 并注入 1440×1080 横版封面
    stage = "注入横封面文件";
    const inputHandle = await page.evaluateHandle((cfg) => {
      const modals = Array.from(
        document.querySelectorAll(cfg.modalSelectors.join(","))
      ).filter((m) => m.getBoundingClientRect().width > 0);
      const scope = modals[modals.length - 1] || document;
      const inputs = Array.from(scope.querySelectorAll("input[type=file]")).filter(
        (i) => !i.accept || /image/i.test(i.accept)
      );
      for (const inp of inputs) {
        let a = inp;
        for (let k = 0; k < 6 && a; k++) {
          a = a.parentElement;
          if (a && (a.textContent || "").includes(cfg.uploadDropZoneKeyword)) {
            return inp;
          }
        }
      }
      return inputs[0] || null;
    }, DY_HORIZONTAL_COVER_SELECTORS);
    const inputEl = inputHandle && inputHandle.asElement ? inputHandle.asElement() : null;
    if (!inputEl) {
      throw new Error("抖音横封面弹窗内未找到图片 file input");
    }
    await inputEl.uploadFile(path.resolve(effectivePath));
    console.log("[dy][cover-h] 横版封面文件已注入上传区:", effectivePath);

    if (waitAfterUploadMs > 0) {
      await page.waitForTimeout(waitAfterUploadMs);
    }

    // 5. 点击「完成/确定/确认」
    stage = "确认横封面弹窗";
    const confirmed = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
      const modals = Array.from(
        document.querySelectorAll(cfg.modalSelectors.join(","))
      ).filter((m) => m.getBoundingClientRect().width > 0);
      const scope = modals[modals.length - 1] || document;
      for (const label of cfg.confirmButtonTexts) {
        const b = Array.from(
          scope.querySelectorAll("button,[role='button']")
        ).find(
          (x) =>
            x.getBoundingClientRect().width > 0 &&
            !x.disabled &&
            norm(x.textContent) === label
        );
        if (b) {
          b.click();
          return { ok: true, label };
        }
      }
      return { ok: false };
    }, DY_HORIZONTAL_COVER_SELECTORS);
    if (!confirmed || !confirmed.ok) {
      throw new Error("抖音横封面弹窗内未找到「完成/确定」按钮");
    }
    console.log(`[dy][cover-h] 已点击横封面弹窗「${confirmed.label}」`);

    // 6. 严格校验：弹窗必须已关闭 且 横封面槽位 img src 相对设置前发生变化
    stage = "校验横封面生效";
    const deadline = Date.now() + Math.max(0, pollTimeoutMs);
    let verifyState = { modalOpen: true, slotSrc: "", changed: false };
    do {
      verifyState = await page.evaluate(
        (cfg, attr, token, prevSlotSrc, prevAllSrcs) => {
          const modals = Array.from(
            document.querySelectorAll(cfg.modalSelectors.join(","))
          ).filter((m) => {
            const r = m.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          const modalOpen = modals.length > 0;
          const marked = document.querySelector(`[${attr}="${token}"]`);
          let slotImg = marked ? marked.querySelector("img") : null;
          if (!slotImg) {
            for (const sel of cfg.slotSelectors) {
              const s = document.querySelector(sel);
              const img = s && s.querySelector("img");
              if (img && img.src) {
                slotImg = img;
                break;
              }
            }
          }
          const slotSrc = slotImg && slotImg.src ? slotImg.src : "";
          let changed = Boolean(slotSrc && slotSrc !== prevSlotSrc);
          if (!changed && !marked) {
            // 若 React 整节点重渲染丢失了标记，兜底检查封面区是否出现全新的非旧图 src
            for (const e of document.querySelectorAll(cfg.coverAreaSelector)) {
              const r = e.getBoundingClientRect();
              if (r.width < 40 || r.height < 30 || r.width > 500) continue;
              const img = e.querySelector("img");
              if (img && img.src && !prevAllSrcs.includes(img.src)) {
                return { modalOpen, slotSrc: img.src, changed: true };
              }
            }
          }
          return { modalOpen, slotSrc, changed };
        },
        DY_HORIZONTAL_COVER_SELECTORS,
        slotAttr,
        slotToken,
        locateRes.slotSrcBefore || "",
        locateRes.allCoverSrcs || []
      );
      if (!verifyState.modalOpen && verifyState.changed) {
        break;
      }
      if (Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
    } while (Date.now() < deadline);

    if (verifyState.modalOpen || !verifyState.changed) {
      throw new Error(
        `抖音横版封面(4:3)设置未确认生效（弹窗仍开=${verifyState.modalOpen}，槽位图片变化=${verifyState.changed}，当前src=${String(
          verifyState.slotSrc || ""
        ).slice(0, 100)}）`
      );
    }

    console.log(
      `[dy][cover-h] 横版封面(4:3)已设置并校验通过（弹窗已关=true, src变化=true）: ${String(
        verifyState.slotSrc
      ).slice(0, 120)}`
    );
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }
  } catch (err) {
    await dumpDyHorizontalCoverDiagnostics(page, stage, { data, window });
    const msg = (err && err.message) || String(err);
    throw new Error(
      msg.includes("已中止")
        ? msg
        : `抖音横版封面(4:3)设置失败（${stage}）：${msg}，已中止本条抖音发布，未发布`
    );
  } finally {
    await page
      .evaluate((attr, token) => {
        const el = document.querySelector(`[${attr}="${token}"]`);
        if (el) el.removeAttribute(attr);
      }, slotAttr, slotToken)
      .catch(() => {});
  }
}

async function selectDyCreativeStatement(page, data) {
  const value = data.data && data.data.creativeStatement;
  console.log("[dy] creativeStatement 值 =", value);
  // 注意：「无标注」对应抖音「无需添加自主声明」，也必须主动点选，不能跳过
  const label = resolveDyCreativeStatementLabel(value);
  console.log("[dy] 准备选择自主声明:", label);

  const opened = await page.evaluate(() => {
    const norm = (t) => String(t).replace(/\s+/g, "").trim();
    const keywords = ["请选择自主声明", "添加自主声明", "自主声明"];
    const isSelectText = (el) => {
      const cls = el.className;
      if (typeof cls !== "string") return false;
      return cls.split(/\s+/).some((c) => c.startsWith("selectText-"));
    };
    for (const el of document.querySelectorAll("[class]")) {
      if (!isSelectText(el)) continue;
      const text = norm(el.textContent);
      if (!keywords.some((k) => text.includes(norm(k)))) continue;
      el.click();
      return true;
    }
    for (const el of document.querySelectorAll(
      "span, div, label, [role='button'], .semi-select"
    )) {
      const text = norm(el.textContent);
      if (!keywords.some((k) => text.includes(norm(k)))) continue;
      if (text.length > 24) continue;
      el.click();
      return true;
    }
    return false;
  });
  if (!opened) {
    const e = new Error(
      "未找到抖音「请选择自主声明」入口（确定性失败：页面上无此入口元素，无需重试）"
    );
    e.dyDeterministic = true;
    throw e;
  }

  // 等待弹窗及选项出现；超时 = 下拉未真正打开，属确定性失败
  try {
    await page.waitForSelector(".semi-modal-body .semi-radio-addon", {
      visible: true,
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
  } catch (_waitErr) {
    const modalOpen = await page
      .evaluate(() => Boolean(document.querySelector(".semi-modal-body")))
      .catch(() => false);
    const e = new Error(
      modalOpen
        ? `抖音自主声明弹窗已出现但选项未加载（期望选项：${label}，确定性失败，不重试）`
        : `抖音自主声明下拉/弹窗未打开（期望选项：${label}，确定性失败，不重试）`
    );
    e.dyDeterministic = true;
    throw e;
  }

  const picked = await page.evaluate((text) => {
    const modal = document.querySelector(".semi-modal-body");
    if (!modal) return false;
    for (const addon of modal.querySelectorAll(".semi-radio-addon")) {
      if (addon.textContent.trim() !== text) continue;
      const labelEl = addon.closest("label.semi-radio");
      if (labelEl) {
        labelEl.click();
        return true;
      }
    }
    return false;
  }, label);

  if (!picked) {
    const e = new Error(
      `抖音自主声明弹窗中无目标选项「${label}」（确定性失败：弹窗里没有此选项文案，无需重试）`
    );
    e.dyDeterministic = true;
    throw e;
  }
  await page.waitForTimeout(400);

  // 点击弹窗里的「确认」按钮提交声明
  const confirmed = await page.evaluate(() => {
    const modal = document.querySelector(".semi-modal-body");
    const root = modal ? modal.closest(".semi-modal") || modal : document;
    const btn = root.querySelector(".semi-button.semi-button-primary");
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  if (!confirmed) {
    throw new Error("未找到抖音自主声明确认按钮");
  }
  console.log("[dy] 已点击声明确认按钮");
  await page.waitForTimeout(400);
}

async function selectDyCreativeStatementWithRetry(page, data, maxMs = 60000) {
  // 确定性失败（入口不存在、弹窗未打开、选项不在弹窗里）不重试，直接抛出。
  // 只有瞬时失败（页面仍在加载导致弹窗短暂不可得）才有限重试，最多 3 次。
  const MAX_TRANSIENT_RETRIES = 3;
  const RETRY_INTERVAL_MS = 2000;
  let attempt = 0;
  let lastErr = null;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await selectDyCreativeStatement(page, data);
      return;
    } catch (e) {
      if (e.dyDeterministic) {
        // 确定性失败：立即上抛，不再重试
        throw e;
      }
      lastErr = e;
      attempt += 1;
      if (attempt >= MAX_TRANSIENT_RETRIES) {
        throw lastErr;
      }
      await page.waitForTimeout(RETRY_INTERVAL_MS);
    }
  }
  throw lastErr || new Error("抖音自主声明选择失败");
}

async function clickDyPublish(page, isDraftMode) {
  const submitSelector = isDraftMode
    ? DY_DRAFT_BUTTON_SELECTOR
    : DY_PUBLISH_BUTTON_SELECTOR;
  const submitBtn = await page.waitForSelector(submitSelector, {
    timeout: WAIT_SELECTOR_APPEAR_MS,
  });
  await submitBtn.click({ delay: 200 });
  console.log(
    isDraftMode
      ? `[dy] 已点击存草稿按钮 (${DY_DRAFT_BUTTON_SELECTOR})`
      : `[dy] 已点击发布入口 (${DY_PUBLISH_BUTTON_SELECTOR})`
  );
}

export const DY_EDITOR_SELECTOR = ".zone-container.editor-kit-container";

/** 抖音简介编辑器文本归一：去空白/零宽字符与 #（话题转胶囊后 # 可能消失），用于回读比对 */
function normalizeDyEditorText(str) {
  return normalizeForCompare(str).replace(/#/g, "");
}

async function readDyEditorText(page) {
  return page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? String(el.textContent || "") : "";
    }, DY_EDITOR_SELECTOR)
    .catch(() => "");
}

/**
 * 简介落地判据（防重复发布的核心闸门）。旧判据（前缀 includes + 长度窗口）
 * 的两个漏网场景：
 * - 旧残留是上次草稿的另一个文案：includes 的前缀命中在中间也放行 → 发布时
 *   「残留+新文」一起出去；
 * - 残留文案较短时，叠加成双的长度仍落在以本次 expected 为基准的窗口内。
 * 新判据：
 * ① expected 为空 → landed 必须为空（防空简介发出）
 * ② landed 必须以 expected 头部（前 12 字）开头——锚定在位置 0，前面挂残留必拦
 * ③ 头部锚点不得二次出现——同文案叠加成双必拦
 * ④ 尾部锚点（后 12 字）必须出现——只写了一半必拦
 * ⑤ 长度上下限——下限容忍话题胶囊对中后段文本的改写，上限拦成双
 */
export function checkDescriptionOnce(landed, expected) {
  if (!expected) return !landed;
  if (!landed) return false;
  const prefix = expected.slice(0, 12);
  const suffix = expected.length > 12 ? expected.slice(-12) : "";
  // 话题 # 转胶囊后 # 会消失、空白被吃掉，因此锚点比对同时看「原始」和「归一后」两种视图。
  // normalizeDyEditorText 只抹掉改写差异（去 # / 去空白），不放宽内容本身。
  const normLanded = normalizeDyEditorText(landed);
  const normPrefix = normalizeDyEditorText(prefix);
  const normSuffix = normalizeDyEditorText(suffix);
  // ① 前缀锚定：锚在位置 0，原始或归一后命中其一即可（防前残留叠加）
  if (prefix && !landed.startsWith(prefix) && !(normPrefix && normLanded.startsWith(normPrefix))) {
    return false;
  }
  // ② 前缀不得二次出现：任一视图检测到二次出现即拦（防同文案叠加成双）
  if (
    prefix &&
    (landed.indexOf(prefix, 1) !== -1 ||
      (normPrefix && normLanded.indexOf(normPrefix, 1) !== -1))
  ) {
    return false;
  }
  // ③ 尾部锚点：同样在归一后文本上比对（防只写了一半）
  if (normSuffix && !normLanded.includes(normSuffix)) return false;
  // ④ 长度窗口：下限防只写一半，上限防成双
  if (landed.length < expected.length - 12) return false;
  return landed.length <= Math.ceil(expected.length * 1.3) + 8;
}

/**
 * 页面上下文内共用的 Slate fiber 探测：向上最多 60 层找带 text + onChange 的
 * memoizedProps。op="read" 读 Slate state；op="clear" 按 mode 重置 state。
 * 单独抽出来是因为 page.evaluate 的函数会被序列化、拿不到外部闭包，
 * readDySlateState 与 trySlateClear 只能共用这一份遍历逻辑。
 */
async function dySlateOp(page, { op = "read", mode } = {}) {
  return page
    .evaluate(({ sel, op, mode }) => {
      const root = document.querySelector(sel);
      if (!root) return { available: false, reason: "no-root" };
      const editable = root.matches('[contenteditable="true"]')
        ? root
        : root.querySelector('[contenteditable="true"]');
      const node = editable || root;
      const key = Object.keys(node).find(
        (k) =>
          k.startsWith("__reactFiber$") ||
          k.startsWith("__reactInternalInstance$")
      );
      if (!key) return { available: false, reason: "no-fiber" };
      let slate = null;
      for (let fiber = node[key], i = 0; fiber && i < 60; i++, fiber = fiber.return) {
        const p = fiber.memoizedProps || {};
        if (p.text !== undefined && typeof p.onChange === "function") {
          slate = p;
          break;
        }
      }
      if (!slate) return { available: false, reason: "no-editor-props" };
      const state = {
        available: true,
        text: String(slate.text ?? ""),
        textExtraLen: Array.isArray(slate.textExtra) ? slate.textExtra.length : -1,
      };
      if (op !== "clear") return state;
      const info = {
        textType: typeof slate.text,
        textPreview: String(slate.text || "").slice(0, 40),
        textExtraType: Array.isArray(slate.textExtra)
          ? `array(${slate.textExtra.length})`
          : typeof slate.textExtra,
      };
      try {
        if (mode === "empty") slate.onChange("");
        else if (mode === "emptyArray") slate.onChange("", []);
        else if (mode === "object") slate.onChange({ text: "", textExtra: [] });
        else return { available: true, ok: false, reason: "bad-mode", info };
      } catch (e) {
        return { available: true, ok: false, reason: String(e && e.message), info };
      }
      return { available: true, ok: true, info, mode };
    }, { sel: DY_EDITOR_SELECTOR, op, mode })
    .catch((e) => ({ available: false, reason: String(e && e.message) }));
}

/**
 * 判定回读是否「叠加成双」：expected 连续出现两次，或长度接近两倍。
 * 命中说明清空失效（Slate 旧 state 被重渲染），此时应重清而不是继续写。
 *
 * 注意：**不能**只看长度比例。3 字文案 + 3 字前残留也正好是 2 倍，
 * 那是「残留」不是「双份」，误判会跳过本该生效的 insertText 兜底。
 * 因此长度比例只在「文本确有重复痕迹」时才算数：要求首尾都命中 expected。
 */
export function looksLikeDoubledLanding(landed, expected) {
  const l = normalizeDyEditorText(landed || "");
  const e = normalizeDyEditorText(expected || "");
  if (!l || !e) return false;
  if (l.includes(e + e)) return true;
  // 胶囊改写可能让 e+e 对不上，但必须同时满足：以 expected 开头 且 以 expected 结尾
  // （即首尾各一份，中间被吃掉），且总长度落在两倍附近。
  const headTailDoubled =
    l.startsWith(e) &&
    l.endsWith(e) &&
    l.length >= e.length * 1.8 &&
    l.length <= e.length * 2.2;
  return headTailDoubled && l.length >= e.length * 2 - 2;
}

/**
 * 尝试用抖音简介编辑器的 Slate onChange 直接重置状态。
 * mode: object → onChange({text:"",textExtra:[]})（现网生效）；
 *       emptyArray → onChange("",[])；empty → onChange("")（兼容旧实现）。
 * 只返回“调用是否成功”，是否真正清空由 clearDyEditor 双视图回读判定。
 */
async function trySlateClear(page, mode) {
  const r = await dySlateOp(page, { op: "clear", mode });
  if (r && r.ok) return r;
  return {
    ok: false,
    reason: (r && r.reason) || "unknown",
    info: r && r.info,
  };
}

/**
 * 读取 Slate 内部 state（DOM textContent 之外的第二个视图）。
 * 拿不到 fiber 时返回 {available:false}——Windows 上常见，调用方不得据此
 * 认为“清空确定成功”。
 */
async function readDySlateState(page) {
  const r = await dySlateOp(page, { op: "read" });
  if (!r || !r.available) return { available: false };
  return {
    available: true,
    text: String(r.text ?? ""),
    textExtraLen: typeof r.textExtraLen === "number" ? r.textExtraLen : -1,
  };
}

/**
 * 双视图清空判定：DOM 回读为空 且（Slate 可得时）Slate state 也空。
 * 只看 DOM 会把「键盘全选只删 DOM、Slate state 仍保留旧值」误判为已清空，
 * 随后 type 会被 Slate 基于旧 state 重渲染成双份。
 * Slate 不可得时只能凭 DOM 判定，返回 verified=false（清空未验证）。
 */
export async function verifyDyEditorEmpty(page) {
  const domEmpty = !normalizeDyEditorText(await readDyEditorText(page));
  if (!domEmpty) return { cleared: false, verified: false };
  const slate = await readDySlateState(page);
  if (!slate.available) return { cleared: true, verified: false };
  const slateEmpty =
    !normalizeDyEditorText(slate.text) && slate.textExtraLen <= 0;
  return slateEmpty
    ? { cleared: true, verified: true }
    : { cleared: false, verified: false };
}

/**
 * 强制全选覆盖清空：execCommand selectAll + delete + insertText("") 能穿透到
 * Slate state，是键盘全选（只删 DOM 节点）失效时的兜底。
 */
async function forceOverwriteClearDyEditor(page) {
  const ran = await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      const editable = el.matches('[contenteditable="true"]')
        ? el
        : el.querySelector('[contenteditable="true"]') || el;
      editable.focus();
      try {
        if (!document.execCommand) return false;
        document.execCommand("selectAll");
        document.execCommand("delete");
        document.execCommand("insertText", false, "");
        return true;
      } catch (_) {
        return false;
      }
    }, DY_EDITOR_SELECTOR)
    .catch(() => false);
  if (!ran) return { cleared: false, verified: false };
  return verifyDyEditorEmpty(page);
}

/**
 * v0.13.5 时代实证有效的清空手法（抖音页面 13.5，见仓库提交 252cefb 的 dy.js）：
 * focus → selection.selectAllChildren → execCommand("delete")。
 * 部分电脑拿不到 Slate fiber props，这条是它们唯一可靠的清空路径；
 * 注意不做内层 editable 三击等会扰动光标/选区的操作。
 */
async function clearDyEditorLegacy(page) {
  await page
    .evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      el.focus();
      const s = window.getSelection && window.getSelection();
      if (s && s.selectAllChildren) {
        try {
          s.selectAllChildren(el);
          if (document.execCommand) document.execCommand("delete");
        } catch (_) {}
      }
    }, DY_EDITOR_SELECTOR)
    .catch(() => {});
  return verifyDyEditorEmpty(page);
}

/**
 * 清空抖音简介编辑器：Slate 状态重置优先（能清 #话题胶囊）→
 * v0.13.5 实证手法（focus+selectAllChildren+execCommand delete）→
 * 键盘全选/Control 兜底；返回回读是否为空。
 * 顺序依据：部分电脑（抖音页面 13.5）拿不到 Slate fiber，且「内层 editable
 * 三击 + Cmd+A」这类操作会扰动光标/选区，反而干扰其后才执行的 execCommand
 * 清空（2026-11 用户反馈有的电脑清空后简介叠加成双）。
 */
async function clearDyEditor(page) {
  const mod = process.platform === "darwin" ? "Meta" : "Control";

  // 1) Slate 编辑器状态重置：fiber 上暴露 text/textExtra/onChange，
  //    直接 onChange 清空可连 #话题胶囊一起清掉。异步函数不能塞进
  //    page.evaluate（Babel regenerator 在页面上下文未定义），故每次只调一种签名。
  let slateInfo = null;
  for (const mode of ["object", "emptyArray", "empty"]) {
    const r = await trySlateClear(page, mode);
    if (!r.ok) continue;
    slateInfo = r.info;
    let cleared = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(100);
      if (!normalizeDyEditorText(await readDyEditorText(page))) {
        cleared = true;
        break;
      }
    }
    if (cleared) {
      console.log(`[dy] 简介编辑器已清空（Slate onChange ${mode}）`);
      return verifyDyEditorEmpty(page);
    }
  }
  console.log(
    "[dy] Slate 状态重置未成功，走 v0.13.5 实证手法兜底",
    JSON.stringify(slateInfo)
  );

  // 2) v0.13.5 实证手法：selection API + execCommand("delete")
  const legacy = await clearDyEditorLegacy(page);
  if (legacy.cleared) {
    console.log("[dy] 简介编辑器已通过 selectAllChildren+execCommand 清空");
    return legacy;
  }

  // 3) 键盘兜底：点容器聚焦 → 全选 → 退格
  try {
    await page.click(DY_EDITOR_SELECTOR, { clickCount: 3, delay: 20 });
  } catch (_) {}
  try {
    await page.keyboard.down(mod);
    await page.keyboard.press("a");
    await page.keyboard.up(mod);
  } catch (_) {}
  try {
    await page.keyboard.press("Backspace");
  } catch (_) {}
  const keyboardCleared = await verifyDyEditorEmpty(page);
  if (keyboardCleared.cleared) {
    console.log("[dy] 简介编辑器已通过键盘全选清空");
    return keyboardCleared;
  }

  // 4) 换 Control 再试（部分 Chromium 构建把全选映射到 Ctrl）
  try {
    await page.click(DY_EDITOR_SELECTOR);
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
  } catch (_) {}
  return verifyDyEditorEmpty(page);
}

/**
 * 抖音简介（含 #标签）填写：确认清空 → 键盘输入 → 回读校验（checkDescriptionOnce
 * 防重复判据），未落地则分层重试：
 *   奇数次 = 现行流（Slate 状态重置清空 + 键盘输入）
 *   偶数次 = v0.13.5 原版流（容器 click 定位光标 → focus+selectAllChildren+
 *            execCommand 清空 → 键盘输入，见仓库提交 252cefb——抖音页面 13.5 上
 *            实证有效，兼容拿不到 Slate fiber 的机器）
 * 每次校验失败再走 execCommand insertText 整段兜底重写；
 * 重试 maxAttempts 次仍失败抛错中止发布（对齐快手 fillKsDescription 策略）：
 * 宁可走失败上报/自动重试，也不能发出空简介或与旧草稿叠加成双的作品。
 */
export async function fillDyDescription(
  page,
  description,
  pressSpaceAfter,
  { maxAttempts = 3 } = {}
) {
  await page.waitForSelector(DY_EDITOR_SELECTOR, {
    timeout: WAIT_SELECTOR_APPEAR_MS,
  });
  const expected = normalizeDyEditorText(description || "");
  const landedOk = (landed) => checkDescriptionOnce(landed, expected);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const legacyPath = attempt % 2 === 0;
    try {
      await page.click(DY_EDITOR_SELECTOR); // 定位光标 + 聚焦
    } catch (_) {
      /* click 偶发失败不致命，clearDyEditor 内有 focus 兜底 */
    }
    let cleared = { cleared: true, verified: true };
    if (legacyPath) {
      // B 流（v0.13.5 原版）：focus + selectAllChildren + execCommand 清空
      cleared = await clearDyEditorLegacy(page);
    } else {
      // A 流：Slate 状态重置优先 → v0.13.5 手法 → 键盘全选兜底
      cleared = await clearDyEditor(page);
    }
    if (!cleared.cleared) {
      console.warn(
        `[dy] 第 ${attempt} 次清空简介编辑器失败（旧内容仍在），重试`
      );
      continue;
    }
    // 双视图判定：DOM 空但 Slate state 未知时，先做「强制全选覆盖」——
    // execCommand selectAll+delete 走 Slate 编辑管线，能把 state 也清掉。
    // 强制覆盖后只要 DOM 空就放行输入：拿不到 fiber 的 Windows 机器 verified
    // 恒为 false，若因此跳过输入会永远发不出简介；残留叠加风险由回读 +
    // looksLikeDoubledLanding 兜底拦截（命中即跳过 insertText、换手法重试）。
    if (!cleared.verified) {
      const forced = await forceOverwriteClearDyEditor(page);
      if (!forced.cleared) {
        console.warn(
          `[dy] 第 ${attempt} 次清空未验证（Slate state 未知），强制覆盖后 DOM 仍非空，重试`
        );
        continue;
      }
    }
    if (description) {
      await page.keyboard.type(description, { delay: 50 });
    }
    // 抖音话题只有遇到空格/回车才会把当前 #xxx 转成话题胶囊；
    // 末尾补一次空格触发，否则最后一个标签不被识别。
    if (pressSpaceAfter) {
      await page.keyboard.press("Space");
    }

    let landed = normalizeDyEditorText(await readDyEditorText(page));
    if (landedOk(landed)) {
      if (attempt > 1) console.log(`[dy] 简介已在第 ${attempt} 次尝试写入`);
      return;
    }
    // 叠加成双 = 清空失效（Slate 旧 state 被重渲染）。此时 insertText 兜底是基于
    // 旧选区/旧 state 写入，只会继续叠加，必须跳过兜底、直接换更强的清空手法重试。
    if (looksLikeDoubledLanding(landed, expected)) {
      console.warn(
        `[dy] 第 ${attempt} 次简介叠加成双（期望 ${expected.length} 字，回读 ${landed.length} 字），判定为清空失效：跳过 insertText 兜底，改用强制覆盖清空后重试`
      );
      continue;
    }
    console.warn(
      `[dy] 第 ${attempt} 次简介未落地（期望 ${expected.length} 字，回读 ${landed.length} 字：「${landed.slice(0, 60)}」），execCommand insertText 兜底重写`
    );

    // 兜底：全选删除后 insertText 整段写入（对富文本组件比键盘事件可靠）
    await page.evaluate((payload) => {
      const el = document.querySelector(payload.sel);
      if (!el) return;
      el.focus();
      if (document.createRange && window.getSelection) {
        try {
          const r = document.createRange();
          r.selectNodeContents(el);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        } catch (_) {}
      }
      if (document.execCommand) {
        document.execCommand("delete");
        document.execCommand("insertText", false, payload.text);
      }
    }, { sel: DY_EDITOR_SELECTOR, text: description || "" });
    if (pressSpaceAfter) {
      await page.keyboard.press("Space");
    }

    landed = normalizeDyEditorText(await readDyEditorText(page));
    if (landedOk(landed)) {
      console.log(
        `[dy] 简介已通过 execCommand 兜底写入（第 ${attempt} 次尝试）`
      );
      return;
    }
  }

  const finalText = normalizeDyEditorText(await readDyEditorText(page));
  throw new Error(
    `抖音简介填写失败：尝试 ${maxAttempts} 次后文案仍未正确写入编辑器（编辑器当前 ${finalText.length} 字：「${finalText.slice(0, 60)}」，期望 ${expected.length} 字），为避免发出空简介/内容叠加的作品已中止本次发布`
  );
}

/** 标题复核：被动掉（简介区 Slate 重置/重填会触发重渲染）就重输一次，失败抛错 */
async function ensureDyTitleIntact(page, title, { context = "" } = {}) {
  const titleInput = await page.$(".semi-input");
  if (!titleInput) {
    throw new Error(`${context}未找到标题输入框`);
  }
  const readTitle = () =>
    titleInput
      .evaluate((el) => String(el.value || el.textContent || "").trim())
      .catch(() => "");
  const current = await readTitle();
  if (matchesHead(current, title)) return;
  console.warn(
    `[dy] ${context}标题被动掉（实得 ${current.length} 字），重输一次`
  );
  await replaceAllText(page, titleInput, title, 80);
  const again = await readTitle();
  if (!matchesHead(again, title)) {
    throw new Error(
      `${context}标题重输失败（期望含「${head(title)}」，实得 ${again.length} 字）`
    );
  }
}

/**
 * 发布前最后一道闸：复核简介未重复/未残缺。从填完简介到点发布之间还有
 * 封面设置（25s 落定等待）、引导弹窗、自主声明弹窗、商品挂车等步骤，都可能
 * 动过编辑器状态；点发布后再发现就晚了。复核不过先重填一轮（内部已有
 * 三层输入方式重试），再复核标题，仍不过则中止发布。
 */
async function verifyDyDescriptionBeforePublish(page, text, data) {
  const expected = normalizeDyEditorText(text.description || "");
  await page
    .waitForSelector(DY_EDITOR_SELECTOR, { timeout: WAIT_SELECTOR_APPEAR_MS })
    .catch(() => {});
  let landed = normalizeDyEditorText(await readDyEditorText(page));
  if (checkDescriptionOnce(landed, expected)) return;
  console.warn(
    `[dy] 发布前简介复核不通过（期望 ${expected.length} 字，实得 ${landed.length} 字：「${landed.slice(0, 60)}」），重填一轮`
  );
  await fillDyDescription(
    page,
    text.description,
    normalizeVideoTags(data.data.tags).length > 0
  );
  landed = normalizeDyEditorText(await readDyEditorText(page));
  if (!checkDescriptionOnce(landed, expected)) {
    throw new Error(
      `发布前简介复核失败（期望 ${expected.length} 字，实得 ${landed.length} 字：「${landed.slice(0, 60)}」），为避免发出重复/残缺简介的作品已中止本次发布`
    );
  }
  console.log("[dy] 发布前简介复核通过（已重填）");
  // 重填会触发描述区重渲染，复核标题没被顺手清掉（空标题发布后补不回来）
  await ensureDyTitleIntact(page, text.title, { context: "发布前复核重填后" });
}

export const DY_SYNC_TOUTIAO_SUBMIT_TEXTS = [
  "发布",
  "发表",
  "立即发布",
  "定时发布",
  "存草稿",
  "保存草稿",
  "暂存离开",
  "保存",
  "提交",
  "取消",
  "取消发布",
  "确认发布",
];

const DY_SYNC_TOUTIAO_DEFAULT_TIMEOUTS = {
  locateTimeoutMs: 3000,
  afterClickDelayMs: 500,
  readbackTimeoutMs: 3000,
  pollIntervalMs: 300,
};

export function isDySyncToutiaoRequested(data) {
  if (!data || typeof data !== "object") return false;
  return Boolean(
    (data.publishOptions && data.publishOptions.dySyncToutiao === true) ||
      data.dySyncToutiao === true ||
      (data.data && data.data.dySyncToutiao === true)
  );
}

/**
 * 浏览器端自包含动作：定位抖音发布页「同步到今日头条」开关/复选框、读取状态、安全点击与回读。
 * 严禁引用模块作用域闭包变量（会被 page.evaluate 序列化执行）。
 */
export function runDySyncToutiaoDomAction(payload) {
  var action = String((payload && payload.action) || "");
  var token = String((payload && payload.token) || "");
  var submitSelectors = Array.isArray(payload && payload.submitSelectors)
    ? payload.submitSelectors
    : [];
  var submitTextsRaw = Array.isArray(payload && payload.submitTexts)
    ? payload.submitTexts
    : [
        "发布",
        "发表",
        "立即发布",
        "定时发布",
        "存草稿",
        "保存草稿",
        "暂存离开",
        "保存",
        "提交",
        "取消",
        "取消发布",
        "确认发布",
      ];

  var norm = function (t) {
    return String(t == null ? "" : t)
      .replace(/[\uFEFF\u200B\u200C\u200D]/g, "")
      .replace(/\s+/g, "")
      .trim();
  };
  var clean = function (t) {
    return String(t == null ? "" : t)
      .replace(/[\uFEFF\u200B\u200C\u200D]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };
  var getText = function (node) {
    if (!node) return "";
    if (node.textContent != null) return String(node.textContent);
    if (node.innerText != null) return String(node.innerText);
    return "";
  };
  var getClass = function (node) {
    if (!node) return "";
    if (typeof node.getAttribute === "function") {
      var c = node.getAttribute("class");
      if (c != null) return String(c);
    }
    return typeof node.className === "string" ? node.className : "";
  };

  var docRef = typeof document !== "undefined" ? document : null;
  var root = (payload && payload.root) || docRef;
  if (!root) return { found: false, reason: "no_document" };

  var submitTextSet = {};
  for (var sti = 0; sti < submitTextsRaw.length; sti++) {
    var stNorm = norm(submitTextsRaw[sti]);
    if (stNorm) submitTextSet[stNorm] = true;
  }

  var resolveById = function (id) {
    if (!id) return null;
    if (typeof root.getElementById === "function") {
      try {
        var found = root.getElementById(id);
        if (found) return found;
      } catch (_) {}
    }
    if (typeof root.querySelector === "function") {
      try {
        var esc = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return root.querySelector('[id="' + esc + '"]');
      } catch (_) {}
    }
    return null;
  };

  var matchesAnySelector = function (node, selectors) {
    if (!node || typeof node.matches !== "function") return false;
    for (var i = 0; i < selectors.length; i++) {
      try {
        if (node.matches(selectors[i])) return true;
      } catch (_) {}
    }
    return false;
  };

  var isVisible = function (el) {
    if (!el || el.isConnected === false) return false;
    var node = el;
    while (node && node !== root && node.nodeType === 1) {
      if (node.hidden === true) return false;
      if (typeof node.getAttribute === "function") {
        if (node.getAttribute("hidden") !== null) return false;
        if (node.getAttribute("aria-hidden") === "true") return false;
      }
      if (typeof getComputedStyle === "function") {
        try {
          var style = getComputedStyle(node);
          if (
            style &&
            (style.display === "none" ||
              style.visibility === "hidden" ||
              String(style.opacity) === "0")
          ) {
            return false;
          }
        } catch (_) {}
      }
      node = node.parentElement;
    }
    if (typeof el.getBoundingClientRect === "function") {
      var rect = el.getBoundingClientRect();
      if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    }
    return true;
  };

  var getSubmitRejectionReason = function (el) {
    if (!el) return "empty_target";
    var node = el;
    for (var depth = 0; node && depth <= 8; depth++) {
      if (
        node === docRef ||
        (docRef && (node === docRef.body || node === docRef.documentElement))
      ) {
        break;
      }
      if (node.nodeType === 1) {
        if (matchesAnySelector(node, submitSelectors)) {
          return "submit_selector_depth_" + depth;
        }
        var tag = String(node.tagName || "").toUpperCase();
        if (tag === "BUTTON" || tag === "INPUT") {
          var explicitType = String(
            (typeof node.getAttribute === "function" &&
              node.getAttribute("type")) ||
              ""
          )
            .trim()
            .toLowerCase();
          if (explicitType === "submit" || explicitType === "reset") {
            return "submit_control_depth_" + depth;
          }
        }
        var parts = [];
        var tNorm = norm(getText(node));
        if (tNorm) parts.push(tNorm);
        if (typeof node.getAttribute === "function") {
          var al = norm(node.getAttribute("aria-label"));
          if (al) parts.push(al);
          var tt = norm(node.getAttribute("title"));
          if (tt) parts.push(tt);
          var av = norm(node.getAttribute("value"));
          if (av) parts.push(av);
          var alb = String(node.getAttribute("aria-labelledby") || "").trim();
          if (alb) {
            var lbIds = alb.split(/\s+/).filter(Boolean);
            var lbStr = "";
            for (var lbi = 0; lbi < lbIds.length; lbi++) {
              var ref = resolveById(lbIds[lbi]);
              if (ref) lbStr += norm(getText(ref));
            }
            if (lbStr) parts.push(lbStr);
          }
        }
        for (var pi = 0; pi < parts.length; pi++) {
          if (submitTextSet[parts[pi]]) {
            return "submit_accessible_name_depth_" + depth;
          }
        }
      }
      if (node === root) break;
      node = node.parentElement;
    }
    return "";
  };

  if (action === "cleanup") {
    if (!token) return { ok: true };
    try {
      var m1 = root.querySelectorAll('[data-mm-dy-sync-tt="' + token + '"]');
      for (var c1 = 0; c1 < m1.length; c1++) {
        m1[c1].removeAttribute("data-mm-dy-sync-tt");
      }
      var m2 = root.querySelectorAll(
        '[data-mm-dy-sync-tt-state="' + token + '"]'
      );
      for (var c2 = 0; c2 < m2.length; c2++) {
        m2[c2].removeAttribute("data-mm-dy-sync-tt-state");
      }
    } catch (_) {}
    return { ok: true };
  }

  if (action === "safe_click") {
    var target =
      (payload && payload.el) ||
      (token ? root.querySelector('[data-mm-dy-sync-tt="' + token + '"]') : null);
    if (!target) return { ok: false, reason: "marked_target_missing" };
    var rej = getSubmitRejectionReason(target);
    if (rej) {
      return { ok: false, submitRejected: true, rejectReason: rej };
    }
    if (typeof target.scrollIntoView === "function") {
      try {
        target.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    if (typeof target.click === "function") {
      target.click();
      return { ok: true };
    }
    return { ok: false, reason: "no_click_method" };
  }

  var isCheckboxInput = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (String(el.tagName || "").toUpperCase() !== "INPUT") return false;
    var tp = String(
      (typeof el.getAttribute === "function" && el.getAttribute("type")) ||
        el.type ||
        ""
    ).toLowerCase();
    return tp === "checkbox";
  };

  var isInsideModalOrPopup = function (el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
      return Boolean(
        el.closest(
          ".semi-modal, .semi-modal-content, .semi-modal-body, [role='dialog'], [role='listbox'], [role='menu'], .mix-dropdown, .semi-select-option-list"
        )
      );
    } catch (_) {
      return false;
    }
  };

  var isDisabledToggle = function (el, innerInput) {
    var targets = [];
    if (el) targets.push(el);
    if (innerInput && innerInput !== el) targets.push(innerInput);
    for (var ti = 0; ti < targets.length; ti++) {
      var node = targets[ti];
      for (var d = 0; node && node !== root && d < 3; d++) {
        if (node.disabled === true) return true;
        if (typeof node.getAttribute === "function") {
          if (
            node.getAttribute("disabled") !== null ||
            node.getAttribute("aria-disabled") === "true"
          ) {
            return true;
          }
        }
        var cls = getClass(node);
        if (
          /\b(semi-switch-disabled|semi-checkbox-disabled|is-disabled|disabled)\b/.test(
            cls
          )
        ) {
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  };

  var hasCheckedOrActiveClass = function (el) {
    if (!el) return false;
    var cls = getClass(el);
    if (!cls) return false;
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i].toLowerCase();
      if (!tk) continue;
      if (/(?:un|in|not[-_]?|non[-_]?)(?:checked|active)/.test(tk)) continue;
      if (/(?:^|[-_])(checked|active)(?:$|[-_])/.test(tk)) return true;
    }
    return false;
  };

  var readToggleState = function (stateEl, innerInput) {
    var ariaCandidates = [];
    if (stateEl) ariaCandidates.push(stateEl);
    if (innerInput && innerInput !== stateEl) ariaCandidates.push(innerInput);
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var roleSub = stateEl.querySelector(
          "[role='switch'], [role='checkbox']"
        );
        if (roleSub && ariaCandidates.indexOf(roleSub) === -1) {
          ariaCandidates.push(roleSub);
        }
      } catch (_) {}
    }
    for (var ai = 0; ai < ariaCandidates.length; ai++) {
      var ac = ariaCandidates[ai];
      if (!ac || typeof ac.getAttribute !== "function") continue;
      var av = ac.getAttribute("aria-checked");
      if (av === "true") return { checked: true, source: "aria-checked" };
      if (av === "false") return { checked: false, source: "aria-checked" };
    }
    var inp = innerInput || (isCheckboxInput(stateEl) ? stateEl : null);
    if (inp) {
      if (typeof inp.checked === "boolean") {
        return { checked: inp.checked, source: "input.checked" };
      }
      if (typeof inp.getAttribute === "function") {
        var cAttr = inp.getAttribute("checked");
        if (cAttr !== null && cAttr !== "false") {
          return { checked: true, source: "attr:checked" };
        }
      }
    }
    if (hasCheckedOrActiveClass(stateEl)) {
      return { checked: true, source: "class" };
    }
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var innerBox = stateEl.querySelector(
          ".semi-checkbox-inner, .semi-checkbox-inner-display"
        );
        if (innerBox && hasCheckedOrActiveClass(innerBox)) {
          return { checked: true, source: "inner-class" };
        }
      } catch (_) {}
    }
    return { checked: false, source: "default" };
  };

  var detectAuthBindModal = function () {
    var modals = [];
    try {
      modals = Array.from(
        root.querySelectorAll(
          ".semi-modal, .semi-modal-content, .semi-modal-body, [role='dialog'], [class*='modal-content'], [class*='dialog']"
        )
      ).filter(isVisible);
    } catch (_) {
      modals = [];
    }
    var authRe =
      /授权|绑定|未绑定|去绑定|前往绑定|立即绑定|账号绑定|绑定头条|同步授权|开通同步|扫码绑定/;
    var ttActionRe = /扫码|登录|开通|确认|绑定|授权|去设置|前往/;
    for (var mi = 0; mi < modals.length; mi++) {
      var m = modals[mi];
      var txt = clean(getText(m));
      if (!txt) continue;
      if (authRe.test(txt) || (txt.indexOf("头条") !== -1 && ttActionRe.test(txt))) {
        var masked = txt
          .replace(/\S*[A-Za-z0-9-]+\.[A-Za-z]{2,}\S*/g, "[url]")
          .replace(/(https?:|blob:|data:)\S*/gi, "[url]")
          .replace(/\d{5,}/g, "[n]")
          .replace(/\S*@\S+/g, "[at]");
        return {
          detected: true,
          snippet: masked.length > 24 ? masked.slice(0, 24) + "…" : masked,
        };
      }
    }
    return { detected: false, snippet: "" };
  };

  var isTier2SwitchCandidate = function (el) {
    if (!el || el.nodeType !== 1 || !isVisible(el)) return false;
    if (isInsideModalOrPopup(el)) return false;
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "IMG") {
      return false;
    }
    if (typeof el.getAttribute === "function") {
      var ac = el.getAttribute("aria-checked");
      if (ac === "true" || ac === "false") return true;
    }
    var cls = getClass(el);
    if (!cls) return false;
    var tokens = cls.split(/\s+/);
    var matchedSwitchToken = false;
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i].toLowerCase();
      if (!tk || tk.indexOf("switch") === -1) continue;
      if (
        /(?:wrap|wrapper|container|row|item|group|list|box|area|panel|card|section|label|title|text|desc|tip|knob|handle|icon|dot|inner|content|header|footer|modal|dialog)/.test(
          tk
        )
      ) {
        continue;
      }
      if (/(?:^|[-_])switch(?:$|[-_])/.test(tk)) {
        matchedSwitchToken = true;
        break;
      }
    }
    if (!matchedSwitchToken) return false;
    return norm(getText(el)).length <= 24;
  };

  var pickClickEl = function (stateEl, innerInput, fallbackLabel) {
    if (stateEl && typeof stateEl.querySelector === "function") {
      var hasLink = false;
      try {
        hasLink = Boolean(stateEl.querySelector("a"));
      } catch (_) {}
      if (hasLink) {
        try {
          var innerCtrl =
            stateEl.querySelector(".semi-checkbox-inner") ||
            (innerInput && isVisible(innerInput) ? innerInput : null);
          if (innerCtrl && isVisible(innerCtrl)) return innerCtrl;
        } catch (_) {}
      }
    }
    if (stateEl && isVisible(stateEl)) return stateEl;
    if (fallbackLabel && isVisible(fallbackLabel)) return fallbackLabel;
    if (innerInput && isVisible(innerInput)) return innerInput;
    return stateEl || fallbackLabel || innerInput;
  };

  var collectLogicalToggles = function (container) {
    if (!container || typeof container.querySelectorAll !== "function") {
      return [];
    }
    var rawWrappers = [];
    var tier1Sel =
      ".semi-switch, [role='switch'], .semi-checkbox, [role='checkbox']";
    try {
      rawWrappers = Array.from(container.querySelectorAll(tier1Sel)).filter(
        function (el) {
          return isVisible(el) && !isInsideModalOrPopup(el);
        }
      );
    } catch (_) {
      rawWrappers = [];
    }
    // 去重：若某 wrapper 嵌套在另一个 wrapper 内部，只保留外层语义控件
    var wrappers = rawWrappers.filter(function (el) {
      return !rawWrappers.some(function (other) {
        return (
          other !== el &&
          typeof other.contains === "function" &&
          other.contains(el)
        );
      });
    });

    var toggles = [];
    for (var wi = 0; wi < wrappers.length; wi++) {
      var w = wrappers[wi];
      var innerInp = null;
      if (isCheckboxInput(w)) {
        innerInp = w;
      } else if (typeof w.querySelector === "function") {
        try {
          innerInp = w.querySelector("input[type='checkbox']");
        } catch (_) {}
      }
      toggles.push({
        stateEl: w,
        clickEl: pickClickEl(w, innerInp, null),
        innerInput: innerInp,
      });
    }

    var rawInputs = [];
    try {
      rawInputs = Array.from(
        container.querySelectorAll("input[type='checkbox']")
      ).filter(function (inp) {
        return !isInsideModalOrPopup(inp);
      });
    } catch (_) {
      rawInputs = [];
    }
    for (var ii = 0; ii < rawInputs.length; ii++) {
      var inp = rawInputs[ii];
      var covered = toggles.some(function (tg) {
        return (
          tg.innerInput === inp ||
          tg.stateEl === inp ||
          (tg.stateEl &&
            typeof tg.stateEl.contains === "function" &&
            tg.stateEl.contains(inp))
        );
      });
      if (covered) continue;
      if (isVisible(inp)) {
        toggles.push({
          stateEl: inp,
          clickEl: inp,
          innerInput: inp,
        });
      } else {
        var wrapLabel =
          typeof inp.closest === "function" ? inp.closest("label") : null;
        if (!wrapLabel && typeof inp.getAttribute === "function") {
          var inpId = inp.getAttribute("id");
          if (inpId) {
            try {
              var escId = String(inpId).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              wrapLabel = root.querySelector('label[for="' + escId + '"]');
            } catch (_) {}
          }
        }
        if (wrapLabel && isVisible(wrapLabel)) {
          toggles.push({
            stateEl: inp,
            clickEl: pickClickEl(wrapLabel, inp, wrapLabel),
            innerInput: inp,
          });
        }
      }
    }

    if (toggles.length > 0) return toggles;

    // Tier 2 兜底：自定义 switch 组件（带 aria-checked 或独立 switch 类名）
    var fallbackRaw = [];
    try {
      fallbackRaw = Array.from(
        container.querySelectorAll(
          "[aria-checked], [class*='switch'], [class*='Switch']"
        )
      ).filter(isTier2SwitchCandidate);
    } catch (_) {
      fallbackRaw = [];
    }
    var fallbackTop = fallbackRaw.filter(function (el) {
      return !fallbackRaw.some(function (other) {
        return (
          other !== el &&
          typeof other.contains === "function" &&
          other.contains(el)
        );
      });
    });
    for (var fi = 0; fi < fallbackTop.length; fi++) {
      var fb = fallbackTop[fi];
      toggles.push({
        stateEl: fb,
        clickEl: fb,
        innerInput: null,
      });
    }
    return toggles;
  };

  var isExplicitRowContainer = function (node) {
    if (!node || node.nodeType !== 1 || typeof node.matches !== "function") {
      return false;
    }
    var cls = getClass(node);
    if (/(?:^|[\s_-])label(?:$|[\s_-])/i.test(cls)) return false;
    return matchesAnySelector(node, [
      "[class*='form-item']",
      "[class*='setting-item']",
      "[class*='form-row']",
      "[class*='setting-row']",
      "[class*='sync-item']",
      "[class*='field']",
    ]);
  };

  var isSyncGroupHeaderText = function (t) {
    if (!t) return true;
    var s = t.replace(/[:：*＊]+$/g, "");
    return /^(?:同步|同步发布|同步设置|同步到|同步至|同时发布|同时发布到|多平台同步|发布设置|其他设置|更多设置|选填|可选|必填|建议|非必填)$/.test(
      s
    );
  };

  var isBenignStatusText = function (t) {
    if (!t) return true;
    var s = t.replace(/[:：*＊·•\-—]+$/g, "");
    return /^(?:开|关|开启|关闭|已开启|未开启|开关|同步开关|同步|已同步|未同步|允许|不允许|选填|可选|必填|推荐|新|beta|new)$/i.test(
      s
    );
  };

  var OTHER_PLATFORM_OWN_RE =
    /西瓜|抖音|火山|快手|小红书|视频号|哔哩哔哩|b站|百家号|懂车帝|皮皮虾|番茄/i;
  var OTHER_PLATFORM_CONTAINER_RE =
    /西瓜|抖音火山|抖音精选|抖音极速|火山版|快手|小红书|视频号|哔哩哔哩|b站|百家号|懂车帝|皮皮虾|番茄/i;

  var hasToutiaoKeyword = function (text) {
    var t = norm(text);
    return t.indexOf("今日头条") !== -1 || t.indexOf("头条") !== -1;
  };

  var hasOtherPlatformOwnName = function (text) {
    var t = norm(text);
    if (!t) return false;
    return OTHER_PLATFORM_OWN_RE.test(t);
  };

  var hasOtherPlatformContainerName = function (text) {
    var t = norm(text);
    if (!t) return false;
    return OTHER_PLATFORM_CONTAINER_RE.test(t);
  };

  var getControlOwnLabels = function (toggle) {
    var labels = [];
    if (!toggle) return labels;
    var pushLabel = function (raw) {
      var s = norm(raw);
      if (s && labels.indexOf(s) === -1) labels.push(s);
    };
    var nodes = [];
    if (toggle.stateEl) nodes.push(toggle.stateEl);
    if (toggle.clickEl && nodes.indexOf(toggle.clickEl) === -1) {
      nodes.push(toggle.clickEl);
    }
    if (toggle.innerInput && nodes.indexOf(toggle.innerInput) === -1) {
      nodes.push(toggle.innerInput);
    }
    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      if (!node || node.nodeType !== 1) continue;
      if (!isCheckboxInput(node)) {
        pushLabel(getText(node));
      }
      if (typeof node.getAttribute === "function") {
        pushLabel(node.getAttribute("aria-label"));
        pushLabel(node.getAttribute("title"));
        var alb = String(node.getAttribute("aria-labelledby") || "").trim();
        if (alb) {
          var lbIds = alb.split(/\s+/).filter(Boolean);
          var lbCombined = "";
          for (var li = 0; li < lbIds.length; li++) {
            var refEl = resolveById(lbIds[li]);
            if (refEl) lbCombined += norm(getText(refEl));
          }
          pushLabel(lbCombined);
        }
        var nodeId = node.getAttribute("id");
        if (nodeId && typeof root.querySelectorAll === "function") {
          try {
            var escId = String(nodeId)
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"');
            var forLabels = root.querySelectorAll('label[for="' + escId + '"]');
            for (var fli = 0; fli < forLabels.length; fli++) {
              if (isVisible(forLabels[fli])) {
                pushLabel(getText(forLabels[fli]));
              }
            }
          } catch (_) {}
        }
      }
      if (typeof node.closest === "function") {
        try {
          var encLabel = node.closest("label");
          if (encLabel && isVisible(encLabel)) {
            pushLabel(getText(encLabel));
          }
        } catch (_) {}
      }
    }
    return labels;
  };

  var validateCandidateToggle = function (toggle, minimalContainer) {
    if (!toggle || !toggle.stateEl) return false;
    var ownLabels = getControlOwnLabels(toggle);
    var ownHasToutiao = false;
    for (var i = 0; i < ownLabels.length; i++) {
      var lt = ownLabels[i].replace(/[:：*＊]+$/g, "");
      if (!lt) continue;
      // 控件自身标签含「西瓜」「抖音」等其它平台名一律排除
      if (hasOtherPlatformOwnName(lt)) return false;
      if (hasToutiaoKeyword(lt)) {
        ownHasToutiao = true;
        continue;
      }
      if (!isBenignStatusText(lt) && !isSyncGroupHeaderText(lt)) {
        return false;
      }
    }
    var containerText = minimalContainer ? norm(getText(minimalContainer)) : "";
    if (containerText) {
      if (containerText.indexOf("西瓜") !== -1) return false;
      if (hasOtherPlatformContainerName(containerText)) return false;
    }
    var containerHasToutiao = hasToutiaoKeyword(containerText);
    return ownHasToutiao || containerHasToutiao;
  };

  var isUnboundEntryText = function (rawText) {
    var t = norm(rawText);
    if (!t) return false;
    var stripped = t.replace(/已绑定|已授权/g, "");
    return /(?:去绑定|立即绑定|前往绑定|未绑定|请绑定|账号绑定|绑定头条|绑定|去授权|立即授权|前往授权|未授权|请授权|授权)/.test(
      stripped
    );
  };

  var detectToutiaoUnboundEntry = function (anchors) {
    if (!Array.isArray(anchors) || anchors.length === 0) return false;
    for (var ai = 0; ai < anchors.length; ai++) {
      var anchor = anchors[ai];
      if (!anchor) continue;
      if (isUnboundEntryText(getText(anchor))) return true;
      var parent = anchor.parentElement;
      if (parent && parent.children && parent.children.length > 0) {
        var sibs = Array.from(parent.children);
        var idx = sibs.indexOf(anchor);
        var scanDirs = [
          [idx + 1, idx + 2],
          [idx - 1],
        ];
        for (var di = 0; di < scanDirs.length; di++) {
          var indices = scanDirs[di];
          for (var si = 0; si < indices.length; si++) {
            var pos = indices[si];
            if (pos < 0 || pos >= sibs.length) continue;
            var sib = sibs[pos];
            if (!isVisible(sib)) continue;
            var sibText = norm(getText(sib));
            if (hasOtherPlatformOwnName(sibText)) break;
            if (
              matchesAnySelector(sib, [
                ".semi-switch",
                "[role='switch']",
                ".semi-checkbox",
                "[role='checkbox']",
                "input[type='checkbox']",
              ])
            ) {
              break;
            }
            if (sibText && sibText.length <= 24 && isUnboundEntryText(sibText)) {
              return true;
            }
          }
        }
      }
      var cur = parent;
      for (var d = 0; cur && d < 3; d++) {
        if (
          cur === root ||
          cur === docRef ||
          (docRef && (cur === docRef.body || cur === docRef.documentElement))
        ) {
          break;
        }
        var cTag = String(cur.tagName || "").toUpperCase();
        if (
          cTag === "FORM" ||
          cTag === "MAIN" ||
          cTag === "BODY" ||
          cTag === "HTML"
        ) {
          break;
        }
        var curText = norm(getText(cur));
        if (
          !curText ||
          curText.length > 80 ||
          curText.indexOf("西瓜") !== -1 ||
          hasOtherPlatformContainerName(curText)
        ) {
          break;
        }
        if (isUnboundEntryText(curText)) return true;
        if (isExplicitRowContainer(cur)) break;
        cur = cur.parentElement;
      }
    }
    return false;
  };

  var isInteractiveToggleOrControl = function (el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = String(el.tagName || "").toUpperCase();
    if (
      tag === "INPUT" ||
      tag === "BUTTON" ||
      tag === "SELECT" ||
      tag === "TEXTAREA" ||
      tag === "A"
    ) {
      return true;
    }
    if (typeof el.getAttribute === "function") {
      var r = String(el.getAttribute("role") || "").toLowerCase();
      if (
        r === "switch" ||
        r === "checkbox" ||
        r === "radio" ||
        r === "button" ||
        r === "combobox"
      ) {
        return true;
      }
    }
    return matchesAnySelector(el, [
      ".semi-switch",
      ".semi-checkbox",
      ".semi-select",
    ]);
  };

  var branchHasUnrelatedLabel = function (branch) {
    if (!branch) return false;
    var nodes = [branch];
    try {
      nodes = nodes.concat(Array.from(branch.querySelectorAll("*")));
    } catch (_) {}
    for (var ni = 0; ni < nodes.length; ni++) {
      var n = nodes[ni];
      if (!isVisible(n)) continue;
      if (n.children && n.children.length > 0) continue;
      var tag = String(n.tagName || "").toUpperCase();
      if (
        tag === "SVG" ||
        tag === "PATH" ||
        tag === "IMG" ||
        tag === "I" ||
        tag === "INPUT"
      ) {
        continue;
      }
      var nt = norm(getText(n)).replace(/[:：*＊]+$/g, "");
      if (!nt) continue;
      if (hasOtherPlatformOwnName(nt)) return true;
      if (hasToutiaoKeyword(nt)) continue;
      if (nt.length <= 18 && !isBenignStatusText(nt)) {
        return true;
      }
    }
    return false;
  };

  var containerViolatesCrossRow = function (container, anchor, toggle) {
    if (
      !container ||
      container === root ||
      container === docRef ||
      (docRef &&
        (container === docRef.body || container === docRef.documentElement))
    ) {
      return true;
    }
    var tag = String(container.tagName || "").toUpperCase();
    if (tag === "FORM" || tag === "MAIN" || tag === "BODY" || tag === "HTML") {
      return true;
    }
    if (norm(getText(container)).length > 220) return true;

    // 1. 容器内包含 >= 2 个互不包含的显式行容器 → 多行父容器
    var nestedRows = [];
    try {
      nestedRows = Array.from(
        container.querySelectorAll(
          "[class*='form-item'], [class*='setting-item'], [class*='form-row'], [class*='setting-row'], [class*='sync-item'], [class*='field']"
        )
      ).filter(function (r) {
        return r !== container && isVisible(r) && isExplicitRowContainer(r);
      });
    } catch (_) {
      nestedRows = [];
    }
    var disjointRows = nestedRows.filter(function (r) {
      return !nestedRows.some(function (other) {
        return (
          other !== r &&
          typeof other.contains === "function" &&
          other.contains(r)
        );
      });
    });
    if (disjointRows.length >= 2) return true;

    // 2. 容器内有其他 <label> 或 label 类名节点（含候选复选框自身 label）指向非同步/非今日头条字段
    var labelLikes = [];
    try {
      labelLikes = Array.from(
        container.querySelectorAll("label, [class*='label']")
      );
    } catch (_) {
      labelLikes = [];
    }
    for (var li = 0; li < labelLikes.length; li++) {
      var ol = labelLikes[li];
      if (!isVisible(ol) || ol === anchor) continue;
      if (ol.tagName !== "LABEL" && !/(?:^|[\s_-])label(?:$|[\s_-])/i.test(getClass(ol))) {
        continue;
      }
      if (typeof anchor.contains === "function" && anchor.contains(ol)) continue;
      if (typeof ol.contains === "function" && ol.contains(anchor)) continue;
      var olText = norm(getText(ol)).replace(/[:：*＊]+$/g, "");
      if (olText) {
        if (hasOtherPlatformOwnName(olText)) return true;
        if (
          !hasToutiaoKeyword(olText) &&
          !isSyncGroupHeaderText(olText) &&
          !isBenignStatusText(olText)
        ) {
          return true;
        }
      }
    }

    // 3. 控件所在子分支与文本锚点不同时，该子分支不得自带独立表单标签（防止跨行误点相邻行/相邻平台开关）
    if (toggle && toggle.stateEl && container.children) {
      var directKids = Array.from(container.children);
      var anchorBranch = null;
      var toggleBranch = null;
      for (var dki = 0; dki < directKids.length; dki++) {
        var dk = directKids[dki];
        if (
          dk === anchor ||
          (typeof dk.contains === "function" && dk.contains(anchor))
        ) {
          anchorBranch = dk;
        }
        if (
          dk === toggle.stateEl ||
          (typeof dk.contains === "function" && dk.contains(toggle.stateEl))
        ) {
          toggleBranch = dk;
        }
      }
      if (
        toggleBranch &&
        toggleBranch !== anchorBranch &&
        branchHasUnrelatedLabel(toggleBranch)
      ) {
        return true;
      }
    }
    return false;
  };

  var findToutiaoToggle = function () {
    var scope = (docRef && docRef.body) || root;
    var allEls = [];
    try {
      allEls = Array.from(scope.querySelectorAll("*")).filter(function (el) {
        if (!isVisible(el)) return false;
        var tag = String(el.tagName || "").toUpperCase();
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "SVG" || tag === "IMG") {
          return false;
        }
        if (typeof el.closest === "function") {
          try {
            if (el.closest("nav, aside, header")) return false;
          } catch (_) {}
        }
        if (isInsideModalOrPopup(el)) return false;
        return true;
      });
    } catch (_) {
      allEls = [];
    }

    var anchors = allEls.filter(function (el) {
      var t = norm(getText(el));
      if (!t || t.length > 60 || t.indexOf("今日头条") === -1) return false;
      var kids = el.children ? Array.from(el.children) : [];
      for (var k = 0; k < kids.length; k++) {
        if (isVisible(kids[k]) && norm(getText(kids[k])).indexOf("今日头条") !== -1) {
          return false;
        }
      }
      return true;
    });

    var tightRe =
      /^(?:同步发布到|同时发布到|同步到|同步至|同步发到)?今日头条$/;
    anchors.sort(function (a, b) {
      var ta = norm(getText(a));
      var tb = norm(getText(b));
      var ra = tightRe.test(ta) ? 0 : ta.length <= 16 ? 1 : 2;
      var rb = tightRe.test(tb) ? 0 : tb.length <= 16 ? 1 : 2;
      if (ra !== rb) return ra - rb;
      return ta.length - tb.length;
    });

    for (var ai = 0; ai < anchors.length; ai++) {
      var anchor = anchors[ai];
      var anchorText = clean(getText(anchor)).slice(0, 40);

      // 优先 1：锚点自身就是开关/复选框，或与开关在同一 label / .semi-checkbox 容器内
      if (
        matchesAnySelector(anchor, [
          ".semi-switch",
          "[role='switch']",
          ".semi-checkbox",
          "[role='checkbox']",
          "input[type='checkbox']",
        ])
      ) {
        var selfInp = isCheckboxInput(anchor)
          ? anchor
          : typeof anchor.querySelector === "function"
          ? anchor.querySelector("input[type='checkbox']")
          : null;
        var selfToggle = {
          stateEl: anchor,
          clickEl: pickClickEl(anchor, selfInp, null),
          innerInput: selfInp,
        };
        if (validateCandidateToggle(selfToggle, anchor)) {
          return {
            found: true,
            strategy: "self",
            anchorText: anchorText,
            toggle: selfToggle,
          };
        }
      }

      var curLabel = anchor;
      for (var ld = 0; curLabel && ld < 4; ld++) {
        var lTag = String(curLabel.tagName || "").toUpperCase();
        var isLabelOrCheck =
          lTag === "LABEL" ||
          matchesAnySelector(curLabel, [
            ".semi-checkbox",
            "[role='checkbox']",
            ".semi-switch",
            "[role='switch']",
          ]);
        if (isLabelOrCheck && isVisible(curLabel) && !isInsideModalOrPopup(curLabel)) {
          if (lTag === "LABEL" && typeof curLabel.getAttribute === "function") {
            var forId = curLabel.getAttribute("for");
            if (forId) {
              var forTarget = resolveById(forId);
              if (
                forTarget &&
                (isCheckboxInput(forTarget) ||
                  matchesAnySelector(forTarget, [
                    ".semi-switch",
                    "[role='switch']",
                    ".semi-checkbox",
                    "[role='checkbox']",
                  ]))
              ) {
                var forToggle = {
                  stateEl: forTarget,
                  clickEl: pickClickEl(forTarget, isCheckboxInput(forTarget) ? forTarget : null, curLabel),
                  innerInput: isCheckboxInput(forTarget) ? forTarget : null,
                };
                if (validateCandidateToggle(forToggle, curLabel)) {
                  return {
                    found: true,
                    strategy: "label_for",
                    anchorText: anchorText,
                    toggle: forToggle,
                  };
                }
              }
            }
          }
          if (
            matchesAnySelector(curLabel, [
              ".semi-checkbox",
              "[role='checkbox']",
              ".semi-switch",
              "[role='switch']",
            ])
          ) {
            var innerI =
              typeof curLabel.querySelector === "function"
                ? curLabel.querySelector("input[type='checkbox']")
                : null;
            var wrapToggle = {
              stateEl: curLabel,
              clickEl: pickClickEl(curLabel, innerI, null),
              innerInput: innerI,
            };
            if (validateCandidateToggle(wrapToggle, curLabel)) {
              return {
                found: true,
                strategy: "same_label_wrapper",
                anchorText: anchorText,
                toggle: wrapToggle,
              };
            }
          }
          var inLabelToggles = collectLogicalToggles(curLabel);
          if (
            inLabelToggles.length === 1 &&
            validateCandidateToggle(inLabelToggles[0], curLabel)
          ) {
            return {
              found: true,
              strategy: "same_label",
              anchorText: anchorText,
              toggle: inLabelToggles[0],
            };
          }
          break;
        }
        curLabel = curLabel.parentElement;
      }

      // 优先 2：向上最多 4 层查找同一行容器，严格跨行保护 + 与「今日头条」可验证关联校验
      var container = anchor.parentElement;
      for (var depth = 0; container && depth < 4; depth++) {
        if (
          container === root ||
          container === docRef ||
          (docRef &&
            (container === docRef.body ||
              container === docRef.documentElement))
        ) {
          break;
        }
        var cToggles = collectLogicalToggles(container);
        if (cToggles.length > 1) {
          // 同容器出现多个开关：属于多选项/多行父容器，禁止猜测
          break;
        }
        if (cToggles.length === 1) {
          if (
            containerViolatesCrossRow(container, anchor, cToggles[0]) ||
            !validateCandidateToggle(cToggles[0], container)
          ) {
            break;
          }
          return {
            found: true,
            strategy: "same_row",
            anchorText: anchorText,
            toggle: cToggles[0],
          };
        }
        if (isExplicitRowContainer(container)) {
          break;
        }
        container = container.parentElement;
      }
    }

    var unbound = anchors.length > 0 && detectToutiaoUnboundEntry(anchors);
    return {
      found: false,
      hasToutiaoText: anchors.length > 0,
      unbound: unbound,
      anchorCount: anchors.length,
    };
  };

  if (action === "readback") {
    var modalInfo = detectAuthBindModal();
    if (modalInfo.detected) {
      return {
        found: true,
        checked: false,
        authModal: true,
        modalSnippet: modalInfo.snippet,
      };
    }
    var markedStateEl = token
      ? root.querySelector('[data-mm-dy-sync-tt-state="' + token + '"]')
      : null;
    if (markedStateEl && markedStateEl.isConnected !== false) {
      var markedInnerInp = isCheckboxInput(markedStateEl)
        ? markedStateEl
        : typeof markedStateEl.querySelector === "function"
        ? markedStateEl.querySelector("input[type='checkbox']")
        : null;
      var stMarked = readToggleState(markedStateEl, markedInnerInp);
      return {
        found: true,
        checked: stMarked.checked,
        stateSource: stMarked.source,
        disabled: isDisabledToggle(markedStateEl, markedInnerInp),
        authModal: false,
      };
    }
    var relocated = findToutiaoToggle();
    if (!relocated.found) {
      return {
        found: false,
        checked: false,
        authModal: false,
        hasToutiaoText: relocated.hasToutiaoText,
      };
    }
    var stReloc = readToggleState(
      relocated.toggle.stateEl,
      relocated.toggle.innerInput
    );
    return {
      found: true,
      checked: stReloc.checked,
      stateSource: stReloc.source,
      disabled: isDisabledToggle(
        relocated.toggle.stateEl,
        relocated.toggle.innerInput
      ),
      authModal: false,
    };
  }

  if (action === "inspect_and_mark") {
    var located = findToutiaoToggle();
    if (!located.found) {
      return {
        found: false,
        hasToutiaoText: located.hasToutiaoText,
        unbound: Boolean(located.unbound),
        anchorCount: located.anchorCount,
      };
    }
    var tg = located.toggle;
    var rejectClick = getSubmitRejectionReason(tg.clickEl);
    var rejectState = getSubmitRejectionReason(tg.stateEl);
    if (rejectClick || rejectState) {
      return {
        found: true,
        submitRejected: true,
        rejectReason: rejectClick || rejectState,
        strategy: located.strategy,
        anchorText: located.anchorText,
      };
    }
    var disabled = isDisabledToggle(tg.stateEl, tg.innerInput);
    var st = readToggleState(tg.stateEl, tg.innerInput);
    if (token) {
      if (tg.stateEl && typeof tg.stateEl.setAttribute === "function") {
        tg.stateEl.setAttribute("data-mm-dy-sync-tt-state", token);
      }
      if (!st.checked && !disabled && tg.clickEl) {
        if (typeof tg.clickEl.setAttribute === "function") {
          tg.clickEl.setAttribute("data-mm-dy-sync-tt", token);
        }
        if (typeof tg.clickEl.scrollIntoView === "function") {
          try {
            tg.clickEl.scrollIntoView({ block: "center", inline: "center" });
          } catch (_) {}
        }
      }
    }
    return {
      found: true,
      checked: st.checked,
      stateSource: st.source,
      disabled: disabled,
      strategy: located.strategy,
      anchorText: located.anchorText,
      markedForClick: !st.checked && !disabled && Boolean(token && tg.clickEl),
    };
  }

  return { found: false, reason: "unknown_action" };
}

/**
 * 失败诊断：输出同步今日头条区域的脱敏 DOM 轮廓（只保留 ≤12 字的 UI 文字，长文本打 [t:N]），
 * 便于真机校准选择器。浏览器端自包含函数，严禁引用模块作用域变量。
 */
export function collectDySyncToutiaoDomOutline(args) {
  var needles =
    (args && Array.isArray(args.needles) && args.needles.length > 0
      ? args.needles
      : ["今日头条", "同步", "同时发布", "发布设置"]);
  var budget = 3500;
  var docRef = typeof document !== "undefined" ? document : null;
  if (!docRef) return "";

  function visible(el) {
    if (!el || el.isConnected === false) return false;
    try {
      if (el.hidden === true) return false;
      if (typeof getComputedStyle === "function") {
        var cs = getComputedStyle(el);
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) {
          return false;
        }
      }
      if (typeof el.getBoundingClientRect === "function") {
        var r = el.getBoundingClientRect();
        if (r && (r.width <= 0 || r.height <= 0)) return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function ownText(el) {
    if (!el) return "";
    if (el.childNodes && el.childNodes.length) {
      var t = "";
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n && n.nodeType === 3) t += String(n.nodeValue || "");
      }
      return t.replace(/\s+/g, " ").trim();
    }
    if (typeof el._text === "string") {
      return el._text.replace(/\s+/g, " ").trim();
    }
    if (!el.children || el.children.length === 0) {
      return String(el.textContent || "").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function cls(el) {
    var c =
      (typeof el.getAttribute === "function" && el.getAttribute("class")) ||
      (typeof el.className === "string" ? el.className : "");
    return String(c || "")
      .split(/\s+/)
      .filter(function (x) {
        return x && !/[\/:?=]/.test(x);
      })
      .slice(0, 3)
      .map(function (x) {
        return "." + x;
      })
      .join("");
  }

  function safeAttrs(el) {
    if (!el || typeof el.getAttribute !== "function") return "";
    var out = [];
    var role = el.getAttribute("role");
    if (role) out.push("[role=" + role + "]");
    var ac = el.getAttribute("aria-checked");
    if (ac !== null) out.push("[aria-checked=" + ac + "]");
    var tp = el.getAttribute("type");
    if (tp === "checkbox") out.push("[type=checkbox]");
    if (typeof el.checked === "boolean" && tp === "checkbox") {
      out.push("[checked=" + el.checked + "]");
    }
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") {
      out.push("[disabled]");
    }
    return out.join("");
  }

  function maskText(raw) {
    if (!raw) return "";
    var len = Array.from(raw).length;
    if (len > 12) return "[t:" + len + "]";
    return raw
      .replace(/(https?:|blob:|data:)\S*/gi, "[url]")
      .replace(/\S*[A-Za-z0-9-]+\.[A-Za-z]{2,}\S*/g, "[url]")
      .replace(/\S*@\S+/g, "[at]")
      .replace(/\d{5,}/g, "[n]");
  }

  function dump(el, depth, lines) {
    if (depth > 7 || lines.length > 80) return;
    if (!visible(el)) return;
    var tag = String(el.tagName || "").toLowerCase();
    if (tag === "script" || tag === "style" || tag === "svg" || tag === "img") {
      return;
    }
    var t = maskText(ownText(el));
    lines.push(
      new Array(depth + 1).join("  ") +
        tag +
        cls(el) +
        safeAttrs(el) +
        (t ? ' "' + t + '"' : "")
    );
    var kids = el.children || [];
    for (var i = 0; i < kids.length && i < 15; i++) {
      dump(kids[i], depth + 1, lines);
    }
  }

  var roots = [];
  var pushRoot = function (r) {
    if (!r || roots.length >= 4) return;
    for (var j = 0; j < roots.length; j++) {
      if (
        roots[j] === r ||
        (typeof roots[j].contains === "function" && roots[j].contains(r))
      ) {
        return;
      }
    }
    roots.push(r);
  };

  var body = docRef.body || docRef;
  var all = [];
  try {
    all = Array.from(body.querySelectorAll("*"));
  } catch (_) {
    all = [];
  }

  for (var ni = 0; ni < needles.length && roots.length < 4; ni++) {
    var needle = needles[ni];
    if (!needle) continue;
    for (var i = 0; i < all.length && roots.length < 4; i++) {
      var el = all[i];
      var ot = ownText(el);
      if (!ot || ot.indexOf(needle) === -1 || !visible(el)) continue;
      if (typeof el.closest === "function" && el.closest("nav,aside,header")) {
        continue;
      }
      var rNode = el;
      for (
        var up = 0;
        up < 4 && rNode.parentElement && rNode.parentElement !== body;
        up++
      ) {
        rNode = rNode.parentElement;
      }
      pushRoot(rNode);
    }
    // 命中「今日头条」就优先只输出相关区域，不再泛扫后续回退词
    if (ni === 0 && roots.length > 0) break;
  }

  // 若存在可见弹窗，也一并输出脱敏轮廓
  try {
    var modals = Array.from(
      body.querySelectorAll(".semi-modal, [role='dialog']")
    ).filter(visible);
    for (var mi = 0; mi < modals.length && roots.length < 4; mi++) {
      pushRoot(modals[mi]);
    }
  } catch (_) {}

  var sections = [];
  for (var ri = 0; ri < roots.length; ri++) {
    var lines = [];
    dump(roots[ri], 0, lines);
    if (lines.length) {
      sections.push("#" + (ri + 1) + "\n" + lines.join("\n"));
    }
  }
  var text = sections.join("\n");
  return text.length > budget ? text.slice(0, budget) + "…(截断)" : text;
}

function waitSyncToutiaoMs(page, ms) {
  if (ms <= 0) return Promise.resolve();
  if (page && typeof page.waitForTimeout === "function") {
    return page.waitForTimeout(ms).catch(() => {});
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function logDySyncToutiaoDomOutline(page) {
  let timer = null;
  try {
    const outline = await Promise.race([
      page.evaluate(collectDySyncToutiaoDomOutline, {
        needles: ["今日头条", "同步", "同时发布", "发布设置"],
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(""), 3000);
        if (timer && typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (outline) {
      console.log(`[dy] 同步今日头条区域脱敏 DOM 轮廓:\n${outline}`);
    }
  } catch (_) {
    // 诊断日志采集失败不覆盖主错误
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 抖音发布页开启「同步到今日头条」并回读确认。
 * - 已开启：直接回读确认，不点击；
 * - 未开启：点一次（安全校验后走 page.click 或 safeClick），再回读确认；
 * - 找不到控件 / 遇授权绑定弹窗 / 回读仍未开：输出脱敏 DOM 轮廓并抛错中止发布（中止前未点发布，属可重试错误）；
 * - 草稿模式同样执行开关步骤（便于真机草稿 e2e 校准选择器），并在日志注明草稿不会触发同步。
 */
export async function ensureDySyncToutiao(page, options = {}) {
  const isDraftMode = Boolean(options && options.isDraftMode);
  const timeouts = {
    ...DY_SYNC_TOUTIAO_DEFAULT_TIMEOUTS,
    ...((options && options.timeouts) || {}),
  };
  const preferPageClick = !(options && options.preferPageClick === false);
  const token = `dytt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (isDraftMode) {
    console.log(
      "[dy] 草稿模式：仍执行同步今日头条开关步骤以便校准选择器（注意：存草稿不会触发同步发布到今日头条）"
    );
  }

  const abortWithOutline = async (reason) => {
    await logDySyncToutiaoDomOutline(page);
    throw new Error(`抖音同步到今日头条未能开启（原因：${reason}），已中止，未发布`);
  };

  try {
    // 1. 定位并读取当前状态
    let inspected = null;
    const locateDeadline = Date.now() + Math.max(0, timeouts.locateTimeoutMs);
    do {
      try {
        inspected = await page.evaluate(runDySyncToutiaoDomAction, {
          action: "inspect_and_mark",
          token,
          submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
          submitTexts: DY_SYNC_TOUTIAO_SUBMIT_TEXTS,
        });
      } catch (evalErr) {
        inspected = {
          found: false,
          error: (evalErr && evalErr.message) || String(evalErr),
        };
      }
      if (inspected && (inspected.found || inspected.unbound)) break;
      if (Date.now() < locateDeadline) {
        await waitSyncToutiaoMs(page, timeouts.pollIntervalMs);
      }
    } while (Date.now() < locateDeadline);

    if (!inspected || !inspected.found) {
      const reason =
        inspected && inspected.error
          ? `页面脚本异常：${inspected.error}`
          : inspected && inspected.unbound
          ? "今日头条未绑定"
          : inspected && inspected.hasToutiaoText
          ? "找到「今日头条」文案但附近未找到可交互开关"
          : "页面未找到「今日头条」同步开关";
      await abortWithOutline(reason);
    }

    if (inspected.submitRejected) {
      await abortWithOutline("目标控件疑似提交按钮，已拒绝点击");
    }

    if (inspected.disabled) {
      await abortWithOutline("同步开关处于禁用状态");
    }

    if (inspected.checked === true) {
      console.log(
        `[dy] 同步今日头条当前已开启（策略=${inspected.strategy || "unknown"}，来源=${
          inspected.stateSource || "unknown"
        }），跳过点击`
      );
      console.log("[dy] 同步今日头条已开启并回读确认");
      return {
        ok: true,
        alreadyEnabled: true,
        clicked: false,
        isDraftMode,
        strategy: inspected.strategy || "",
      };
    }

    // 2. 未开启：只点一次
    const markedSelector = `[data-mm-dy-sync-tt="${token}"]`;
    if (preferPageClick && typeof page.click === "function") {
      try {
        await page.click(markedSelector);
      } catch (clickErr) {
        await abortWithOutline(
          `点击开关失败：${(clickErr && clickErr.message) || String(clickErr)}`
        );
      }
    } else {
      let clickRes = null;
      try {
        clickRes = await page.evaluate(runDySyncToutiaoDomAction, {
          action: "safe_click",
          token,
          submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
          submitTexts: DY_SYNC_TOUTIAO_SUBMIT_TEXTS,
        });
      } catch (clickErr) {
        await abortWithOutline(
          `点击开关失败：${(clickErr && clickErr.message) || String(clickErr)}`
        );
      }
      if (!clickRes || !clickRes.ok) {
        const reason =
          clickRes && clickRes.submitRejected
            ? "目标控件疑似提交按钮，已拒绝点击"
            : `点击开关失败（${(clickRes && clickRes.reason) || "unknown"}）`;
        await abortWithOutline(reason);
      }
    }

    // 3. 等待状态更新并回读确认
    await waitSyncToutiaoMs(page, timeouts.afterClickDelayMs);

    let readback = null;
    const readbackDeadline =
      Date.now() + Math.max(0, timeouts.readbackTimeoutMs);
    do {
      try {
        readback = await page.evaluate(runDySyncToutiaoDomAction, {
          action: "readback",
          token,
          submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
          submitTexts: DY_SYNC_TOUTIAO_SUBMIT_TEXTS,
        });
      } catch (rbErr) {
        readback = {
          found: false,
          checked: false,
          error: (rbErr && rbErr.message) || String(rbErr),
        };
      }
      if (readback && readback.authModal) {
        const tip = readback.modalSnippet ? `「${readback.modalSnippet}」` : "";
        await abortWithOutline(`出现授权/绑定弹窗${tip}`);
      }
      if (readback && readback.found && readback.checked === true) {
        console.log("[dy] 同步今日头条已开启并回读确认");
        return {
          ok: true,
          alreadyEnabled: false,
          clicked: true,
          isDraftMode,
          strategy: inspected.strategy || "",
        };
      }
      if (Date.now() < readbackDeadline) {
        await waitSyncToutiaoMs(page, timeouts.pollIntervalMs);
      }
    } while (Date.now() < readbackDeadline);

    const failReason =
      readback && readback.error
        ? `回读异常：${readback.error}`
        : readback && !readback.found
        ? "点击后回读未找到同步开关"
        : "点击开关后回读仍为未开启状态";
    await abortWithOutline(failReason);
  } finally {
    await page
      .evaluate(runDySyncToutiaoDomAction, {
        action: "cleanup",
        token,
      })
      .catch(() => {});
  }
}

export default async function (page, data, window, event) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;
  // 文案在顶部解析：简介填写与发布前复核（第二个 try 块）都要用
  const text = buildPlatformVideoTextDetailed("抖音", data.data);
  const dyRuleAdjustments = mergeRuleAdjustments(
    data.ruleAdjustments || (data.data && data.data.ruleAdjustments),
    text.adjustments
  );
  const dyAdjSummary = formatRuleAdjustmentsSummary(dyRuleAdjustments);

  try {
    // 等待 name=upload-btn 的 input 出现
    await page.waitForSelector('input[name="upload-btn"]', {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    const uploadInputs = await page.$$('input[name="upload-btn"]');
    // 取最后一个 input 元素
    const uploadFileHandle = uploadInputs[uploadInputs.length - 1];
    await uploadFileHandle.uploadFile(path.resolve(data.filePath));
  } catch (e) {
    // 上传失败必须阻断：文件没进上传区还继续填表点发布，会发出残缺作品
    console.error("❌ 输入文件失败", e);
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: `抖音视频上传失败: ${(e && e.message) || String(e)}`,
      closeWindow: true,
    });
    return;
  }
  try {
    await page.waitForSelector(".semi-input", {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    // 获取元素句柄
    const input = await page.$(".semi-input");
    // 点击并清空内容
    await input.click({ clickCount: 3 }); // 三击全选
    await page.keyboard.press("Backspace"); // 删除内容
    await page.type(".semi-input", text.title, { delay: 50 });
    // 回读校验：标题空写不能放过（发布后才补不回来）。
    // 按码点取前 8 字比较（slice 会切出孤立代理对）；不一致先重输一次再判失败。
    const readTitle = () =>
      input
        .evaluate((el) => String(el.value || el.textContent || "").trim())
        .catch(() => "");
    let typedTitle = await readTitle();
    if (!matchesHead(typedTitle, text.title)) {
      console.warn(
        `[dy] 标题回读不一致，重输一次（期望含「${head(text.title)}」，实得 ${
          typedTitle.length
        } 字）`
      );
      await replaceAllText(page, input, text.title, 80);
      typedTitle = await readTitle();
      if (!matchesHead(typedTitle, text.title)) {
        throw new Error(
          `标题未写入（期望含「${head(text.title)}」，实得 ${typedTitle.length} 字）`
        );
      }
    }

    // 描述（含 #标签）填写：确认清空 + 键盘输入 + 回读校验 + execCommand 兜底。
    // 必须清掉旧内容：抖音创作页同分区会恢复上次编辑的简介，清空失效时
    // 新简介会追加在旧内容后面 → 内容和标签成双，多次发布无限累加
    //（Windows 后台窗口下 execCommand("delete") 静默失效，2026-11-01 用户反馈）。
    await fillDyDescription(
      page,
      text.description,
      normalizeVideoTags(data.data.tags).length > 0
    );

    // Slate 状态重置会触发描述区重渲染，复核标题没有被动掉（空标题发布后补不回来）
    await ensureDyTitleIntact(page, text.title, { context: "简介填写后" });
  } catch (e) {
    console.error("❌ 输入标题失败", e);
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: `抖音标题/简介填写失败: ${(e && e.message) || String(e)}`,
      closeWindow: true,
    });
    return;
  }

  try {
    // 不依赖会随打包变化的 container-xxx：等预览区 video（抖音 CDN）与同容器内的 rc 进度条同时出现
    await pollPageUntil(
      page,
      () => {
        for (const v of document.querySelectorAll("video")) {
          const src = v.currentSrc || v.getAttribute("src") || "";
          if (!src.includes("douyin.com")) continue;
          const parent = v.parentElement;
          if (
            parent &&
            parent.querySelector(".rc-slider.rc-slider-horizontal")
          ) {
            return true;
          }
        }
        return false;
      },
      WAIT_UPLOAD_PROCESSING_MS
    );

    // 「保存权限」区域往往在预览视频就绪后才挂载；放在预览等待之后，并放宽文案/控件匹配
    await page.waitForFunction(
      () => {
        const norm = (t) => String(t).replace(/\s+/g, "").trim();
        const hasSaveTitleIn = (root) =>
          [...root.querySelectorAll("span")].some((s) =>
            norm(s.textContent).includes("保存权限")
          );
        for (const label of document.querySelectorAll("label")) {
          if (!label.textContent.includes("不允许")) continue;
          const inp = label.querySelector('input[value="0"]');
          if (!inp || (inp.type !== "checkbox" && inp.type !== "radio"))
            continue;
          let a = label;
          for (let i = 0; i < 28 && a; i++) {
            if (hasSaveTitleIn(a)) return true;
            a = a.parentElement;
          }
        }
        return false;
      },
      { timeout: 30000 }
    );
    const saved = await page.evaluate(() => {
      const norm = (t) => String(t).replace(/\s+/g, "").trim();
      const hasSaveTitleIn = (root) =>
        [...root.querySelectorAll("span")].some((s) =>
          norm(s.textContent).includes("保存权限")
        );
      for (const label of document.querySelectorAll("label")) {
        if (!label.textContent.includes("不允许")) continue;
        const inp = label.querySelector('input[value="0"]');
        if (!inp || (inp.type !== "checkbox" && inp.type !== "radio")) continue;
        let a = label;
        for (let i = 0; i < 28 && a; i++) {
          if (hasSaveTitleIn(a)) {
            label.click();
            return true;
          }
          a = a.parentElement;
        }
      }
      return false;
    });
    if (!saved) throw new Error("未找到保存权限-不允许");

    // 引导浮层（如「视频预览功能」）会挡住后续点击，先关掉
    await dismissDyGuideModals(page);

    // 自定义封面（双比例：竖 3:4 + 横 4:3）：
    // - 给了 coverPath：先设竖封面（1080×1440）
    // - 给了 coverPathH：归一 1440×1080 后设横封面槽位
    // - 没给 coverPathH 但给了 coverPath：自动生成 1440×1080（竖居中+模糊压暗背景）后设横封面槽位；
    //   自动生成失败则只设竖封面、日志告警、不中止；横封面上传设置失败则中止本条发布。
    const rawCoverPath = (data.data && data.data.coverPath) || "";
    const rawCoverPathH =
      (data.data && data.data.coverPathH) ||
      (data.publishOptions && data.publishOptions.coverPathH) ||
      "";
    if (rawCoverPath || rawCoverPathH) {
      const dualCovers =
        typeof coverCompat.resolveDualCoversForUpload === "function"
          ? await coverCompat.resolveDualCoversForUpload({
              coverPath: rawCoverPath,
              coverPathH: rawCoverPathH,
            })
          : {
              verticalPath: rawCoverPath
                ? typeof coverCompat.normalizeCoverForUpload === "function"
                  ? await coverCompat.normalizeCoverForUpload(rawCoverPath)
                  : rawCoverPath
                : "",
              horizontalPath: rawCoverPathH || "",
              horizontalAutoGenerated: false,
              horizontalGenWarning: "",
            };
      if (rawCoverPath) {
        await uploadDyCustomCover(page, dualCovers.verticalPath || rawCoverPath);
        await dismissDyGuideModals(page);
      }
      if (dualCovers.horizontalPath) {
        await uploadDyHorizontalCover(page, dualCovers.horizontalPath, {
          data,
          window,
          alreadyNormalized: true,
        });
        await dismissDyGuideModals(page);
      } else if (dualCovers.horizontalGenWarning) {
        console.warn(
          `[dy] 横版封面自动生成失败（仅保留竖封面，不中止发布）：${dualCovers.horizontalGenWarning}`
        );
      }
    }

    // 自主声明入口在视频转码完成后才出现，必须在点击发布前完成
    await selectDyCreativeStatementWithRetry(page, data);

    // AI 自动章节（默认开启，关闭时不触碰页面；不支持或失败告警继续，不中止发布）
    let aiChaptersResult = null;
    if (isAiChaptersRequested(data)) {
      aiChaptersResult = await applyDyAiChapters(page, { data, window });
    }

    // 挂车未确认成功时必须进入同一失败分支，不能继续发布无商品的视频。
    const productLink = resolveVideoLinkOption("抖音", data.publishOptions);
    if (productLink.enabled) await attachDyProductLink(page, productLink);

    // 选择合集（留空跳过；找不到入口/同名合集/回读不符时抛确定性错误中止发布且不重试）
    await selectPlatformCollection(page, "抖音", data.publishOptions, {
      data,
      window,
    });

    // 同步发布到今日头条（可选：dySyncToutiao=true 时开启并回读确认；失败中止本次抖音发布）
    if (isDySyncToutiaoRequested(data)) {
      await ensureDySyncToutiao(page, { isDraftMode });
    }

    // 发布前最后一道闸：复核简介未重复/未残缺（中间步骤可能动过编辑器状态），
    // 复核不过自动重填一轮，仍不过则中止——绝不带重复/空简介点发布
    await verifyDyDescriptionBeforePublish(page, text, data);

    const urlBefore = readPageUrl(page);
    await clickDyPublish(page, isDraftMode);
    // 抖音网页端没有草稿箱：点击成功 ≠ 草稿已留底，回执必须如实标注（P1-4）
    console.log(
      isDraftMode
        ? "✅ 抖音已点击存草稿（网页端无草稿箱，未能核验）"
        : "✅ 抖音视频上传成功"
    );
    const dyBaseSuccessMsg = isDraftMode
      ? "已点击存草稿（抖音网页端无草稿箱，无法核验）"
      : "上传成功";
    const dyMsgWithAdj = dyAdjSummary
      ? `${dyBaseSuccessMsg}（规则调整：${dyAdjSummary}）`
      : dyBaseSuccessMsg;
    const dyFinalSuccessMsg =
      aiChaptersResult && aiChaptersResult.receiptText
        ? appendPublishReceiptNote(dyMsgWithAdj, aiChaptersResult.receiptText)
        : dyMsgWithAdj;
    await replyPublishOutcome({
      page,
      data,
      window,
      event,
      urlBefore,
      isDraftMode,
      // 抖音编辑页视频上传完常驻「上传成功」，发布模式不能把它当发布成功信号
      excludeSuccessToasts: ["上传成功", "草稿已保存"],
      successMessage: dyFinalSuccessMsg,
      extraPayload: {
        ...(isDraftMode ? { draftUnverified: true } : {}),
        ...(aiChaptersResult
          ? {
              aiChaptersStatus: aiChaptersResult.status,
              aiChaptersReceipt: aiChaptersResult.receiptText,
            }
          : {}),
        ...(dyRuleAdjustments.length > 0
          ? {
              ruleAdjustments: dyRuleAdjustments,
              ruleAdjustmentsSummary: dyAdjSummary,
            }
          : {}),
      },
    });
  } catch (e) {
    const detail = (e && e.message) || String(e);
    const isCollectionError = Boolean(e && e.isCollectionError);
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: isCollectionError
        ? detail
        : detail.length > 200
        ? `${detail.slice(0, 200)}…`
        : detail,
      ...(isCollectionError
        ? {
            extraPayload: {
              outcome: "collection_failed",
              needsAttention: true,
              ...(e.failScreenshot ? { failScreenshot: e.failScreenshot } : {}),
            },
          }
        : {}),
      // 抖音发布失败后窗口是否关闭沿用原行为（上游统一处理）
      closeWindow: false,
    });
    console.error("❌ 上传失败", e);
  }
}
