import path from "path";
import fs from "fs";
import * as coverCompat from "../coverCompat.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import maybeClosePublishWindow from "./closeWindow.js";
import { head, matchesHead, replaceAllText } from "./textReadback.js";
import { resolveVideoLinkOption } from "../../../shared/videoLink.js";
import {
  SPH_DRAFT_BUTTON_SELECTOR,
  SPH_PUBLISH_BUTTON_SELECTOR,
  ALL_PLATFORM_SUBMIT_SELECTORS,
} from "../../../shared/collectionShared.js";
import {
  isCreativeStatementNone,
  resolveSphCreativeStatementLabel,
} from "../../../shared/creativeStatement.js";
import {
  isOriginalStatementRequested,
  createNoOriginalQualificationError,
  createOriginalStatementError,
} from "../../../shared/publishExtras.js";
import {
  executeOriginalStatementFlow,
  runOriginalStatementDomAction,
  dumpExtrasDiagnostics,
} from "../../../shared/publishExtrasDom.js";
import { attachSphVideoLink } from "./sphLink.js";
import { selectPlatformCollection } from "./collection.js";

export { SPH_DRAFT_BUTTON_SELECTOR, SPH_PUBLISH_BUTTON_SELECTOR };
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";
import { buildPlatformVideoTextDetailed } from "../../../shared/videoMetadata.js";
import {
  formatRuleAdjustmentsSummary,
  mergeRuleAdjustments,
} from "../../../shared/platformRules.js";
import {
  readPageUrl,
  readPageText,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";

/**
 * 在 wujie 影子树里实时查询并点击。
 *
 * 不要对 wujie 内元素用 waitForSelector + ElementHandle.click()：
 * 视频处理完成等时机平台会整段重渲染影子树，句柄随即指向已分离节点，
 * CDP 取不到布局盒子，报「Node is either not clickable or not an HTMLElement」
 * （e2e 实测存草稿按钮点击因此炸掉整个流程）。这里改为点击瞬间重新查询节点
 * 并走 DOM click（与库内其余 sph evaluate 点击同一模式），带重试容忍短暂消失。
 *
 * @param {import("puppeteer-core").Page} page
 * @param {string} selector 影子树内的选择器（不含 wujie-app 前缀与 >>>）
 * @param {object} [options]
 * @param {number} [options.timeout] 轮询窗口总时长，默认 10s
 * @param {number} [options.interval] 轮询间隔，默认 400ms
 * @param {string} [options.label] 抛错时的业务名（如「视频号保存草稿按钮」）
 * @param {boolean} [options.focus] 点击后聚焦该元素（输入框用）
 * @returns {Promise<boolean>} 是否成功点击到节点
 */
async function clickSphShadow(
  page,
  selector,
  { timeout = 10000, interval = 400, label = "", focus = false } = {}
) {
  const deadline = Date.now() + Math.max(timeout, 0);
  do {
    let clicked = false;
    try {
      clicked = await page.evaluate(
        ({ sel, needFocus }) => {
          const app = document.querySelector("wujie-app.wujie_iframe");
          if (!app || !app.shadowRoot) return false;
          const el = app.shadowRoot.querySelector(sel);
          if (!el) return false;
          // 按钮 disabled（视频处理/封面裁剪未完成）或不可见时不硬点，等下一轮
          if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
          if (
            typeof el.checkVisibility === "function" &&
            !el.checkVisibility()
          ) {
            return false;
          }
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          if (needFocus && typeof el.focus === "function") el.focus();
          return true;
        },
        { sel: selector, needFocus: focus }
      );
    } catch (_) {
      // 页面跳转/执行上下文销毁时按未命中处理，下一轮再试
      clicked = false;
    }
    if (clicked) return true;
    if (Date.now() < deadline) {
      await page.waitForTimeout(interval).catch(() => {});
    }
  } while (Date.now() < deadline);
  if (label) throw new Error(`未找到${label}：${selector}`);
  return false;
}

/**
 * 视频号发布页「原创声明」选择器与候选文案集中配置（wujie shadowRoot 内执行）。
 * 主选择器沿用真机验证的 .declare-original-checkbox / .weui-desktop-dialog / .declare-original-dialog；
 * 兜底候选文案与无资格提示匹配【未经真机校准，待真机存草稿核对】。
 *
 * 策略（S18）：
 * - originalStatement=false 或未请求时，完全不触碰原创声明入口。
 * - originalStatement=true 时，必须勾选并走完确认弹窗且回读选中；
 *   任何失败或账号无原创资格（页面提示无资格/入口置灰）均中止本条视频号发布，不点发表/保存草稿。
 */
export const SPH_ORIGINAL_STATEMENT_SELECTORS = Object.freeze({
  wujieHost: "wujie-app.wujie_iframe",
  entrySelectors: [
    ".declare-original-checkbox .ant-checkbox-wrapper",
    ".declare-original-checkbox input[type='checkbox']",
    ".declare-original-checkbox",
  ],
  entryContainerSelectors: [
    ".declare-original-checkbox",
    "[class*='declare-original']",
    "[class*='original']",
  ],
  entryKeywords: ["声明原创", "原创声明", "原创"],
  toggleSelectors: [
    ".ant-checkbox-wrapper",
    ".ant-switch",
    "[role='checkbox']",
    "[role='switch']",
    "input[type='checkbox']",
    "label",
  ],
  dialogSelectors: [
    ".declare-original-dialog .weui-desktop-dialog",
    ".declare-original-dialog",
    ".weui-desktop-dialog",
    "[role='dialog']",
  ],
  originalDialogSelectors: [
    ".declare-original-dialog .weui-desktop-dialog",
    ".declare-original-dialog",
  ],
  dialogKeywords: ["声明原创", "原创声明", "原创权益", "原创"],
  ignoreDialogPatterns: ["将此次编辑保留", "编辑封面", "更换封面"],
  agreementSelectors: [
    ".weui-desktop-dialog__bd .protocol-text",
    ".protocol-text",
    "label.ant-checkbox-wrapper",
    "input[type='checkbox']",
    "[role='checkbox']",
    "label",
  ],
  agreementKeywords: ["我已阅读并同意", "阅读并同意", "同意", "协议", "条款", "须知"],
  confirmButtonSelectors: [
    "button.weui-desktop-btn_primary",
    "button",
    "[role='button']",
  ],
  confirmButtonTexts: [
    "声明原创",
    "确认声明",
    "同意并声明",
    "我已阅读并同意",
    "确定",
    "确认",
  ],
  noQualificationPatterns: [
    "无原创资格",
    "暂无原创资格",
    "未开通原创",
    "不满足原创",
    "不符合原创",
    "暂不支持原创",
    "无资格",
    "无法声明原创",
    "暂无权限",
    "暂未开放",
    "条件未满足",
    "未满足条件",
    "未达到原创",
    "粉丝数不足",
  ],
  submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
  submitTexts: [
    "发布",
    "发表",
    "立即发布",
    "立即发表",
    "定时发布",
    "存草稿",
    "保存草稿",
    "暂存离开",
    "保存",
    "提交",
    "取消",
    "取消发布",
    "确认发布",
    "确认发表",
  ],
  dispatchMouseEvents: false,
  diagSelectors: [
    ".declare-original-checkbox",
    ".declare-original-dialog",
    ".post-with-mark-tag",
    ".weui-desktop-dialog",
  ],
  diagKeywords: ["声明原创", "原创", "视频标注", "无资格", "未开通"],
});

export async function applySphOriginalStatement(
  page,
  { data, window, timeouts } = {}
) {
  return executeOriginalStatementFlow(page, {
    platformTag: "sph",
    platformLabel: "视频号",
    cfg: SPH_ORIGINAL_STATEMENT_SELECTORS,
    data,
    window,
    captureScreenshot: capturePublishFailureScreenshot,
    timeouts,
  });
}

/**
 * 统一复核视频号「视频标注（creativeStatement）」与「原创声明（originalStatement）」：
 * 确保二者互不覆盖、确认弹窗已完全关闭；若视频标注被重置则补选一次并复核原创仍在勾选态。
 */
export async function verifySphDeclarations(
  page,
  { creativeStatement, originalStatement, data, window } = {}
) {
  const label = !isCreativeStatementNone(creativeStatement)
    ? resolveSphCreativeStatementLabel(creativeStatement)
    : "";
  const wantCreative = Boolean(label && label !== "无标注" && label !== "无需标注");
  if (wantCreative) {
    const currentDisplay = await page
      .evaluate(
        "(function(){" +
          "var app=document.querySelector('wujie-app.wujie_iframe');" +
          "var root=app&&app.shadowRoot;" +
          "if(!root)return '';" +
          "var el=root.querySelector('.post-with-mark-tag .select-display');" +
          "return el?String(el.textContent||'').replace(/\\s+/g,'').trim():'';" +
          "})()"
      )
      .catch(() => "");
    if (!currentDisplay || currentDisplay.indexOf(label.replace(/\s+/g, "")) === -1) {
      console.warn(
        `[sph][verify] 联合复核发现视频标注「${label}」未保持（当前=${currentDisplay || "空"}），尝试补选一次`
      );
      try {
        await applySphCreativeStatement(page, creativeStatement);
      } catch (e) {
        console.warn("[sph][verify] 补选视频标注异常:", (e && e.message) || e);
      }
    }
  }

  if (originalStatement === true) {
    const check = await page.evaluate(runOriginalStatementDomAction, {
      action: "inspect",
      token: "",
      cfg: SPH_ORIGINAL_STATEMENT_SELECTORS,
    });
    if (check && check.noQualification) {
      await dumpExtrasDiagnostics(page, {
        platformTag: "sph",
        platformLabel: "视频号",
        featureTag: "original-statement",
        stage: "unified-verify-no-qual",
        cfg: SPH_ORIGINAL_STATEMENT_SELECTORS,
        data,
        window,
        captureScreenshot: capturePublishFailureScreenshot,
      });
      throw createNoOriginalQualificationError(
        "视频号",
        check.noQualificationText || ""
      );
    }
    if (!check || !check.found || check.checked !== true || check.dialogOpen) {
      await dumpExtrasDiagnostics(page, {
        platformTag: "sph",
        platformLabel: "视频号",
        featureTag: "original-statement",
        stage: "unified-verify-failed",
        cfg: SPH_ORIGINAL_STATEMENT_SELECTORS,
        data,
        window,
        captureScreenshot: capturePublishFailureScreenshot,
      });
      throw createOriginalStatementError(
        "视频号",
        "声明联检",
        check && check.dialogOpen
          ? "联合复核时原创声明确认弹窗仍未关闭"
          : "联合复核时原创声明未处于已勾选状态"
      );
    }
    console.log("[sph][verify] 视频标注与原创声明统一复核通过");
  }
}

/**
 * 视频号自定义封面（探针实证配方）：
 * 点 .vertical-cover-wrap 槽位 → weui-desktop-dialog「编辑封面」→「上传封面」→
 * .single-cover-uploader-wrap 内隐藏 file input（accept=jpeg/jpg/png，勿传 webp）注入 →
 * 「确定」→ 校验 .cover-img-vertical 槽位 img src 变化 + 弹窗已关闭。
 * 封面为「个人主页和分享卡片(3:4)」——3:4 竖图（如 1080x1440）恰好匹配。
 */
async function uploadSphCustomCover(page, coverPath) {
  if (!fs.existsSync(coverPath)) {
    throw new Error(`封面文件不存在: ${coverPath}`);
  }
  // 封面归一：视频号 file input 只收 jpeg/jpg/png，非 3:4 源图居中裁切成
  // 1080×1440 jpg（失败回退原图，不阻断发布）
  coverPath =
    typeof coverCompat.normalizeCoverForUpload === "function"
      ? await coverCompat.normalizeCoverForUpload(coverPath)
      : coverPath;

  const srcBefore = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    const img = root && root.querySelector(".cover-img-vertical");
    return img ? img.src : "";
  });

  const opened = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const slot =
      root.querySelector(".vertical-cover-wrap") ||
      root.querySelector(".cover-preview-wrap");
    if (!slot) return false;
    slot.click();
    return true;
  });
  if (!opened) throw new Error("未找到视频号封面编辑入口（.vertical-cover-wrap）");

  // 等「编辑封面」弹窗可见
  await page.waitForFunction(
    () => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      const root = app && app.shadowRoot;
      if (!root) return false;
      for (const d of root.querySelectorAll(".weui-desktop-dialog")) {
        const t = (d.textContent || "").replace(/\s+/g, "");
        const r = d.getBoundingClientRect();
        if (t.includes("编辑封面") && r.width > 0) return true;
      }
      return false;
    },
    { timeout: 15000 }
  );
  await page.waitForTimeout(1200);

  // 切到「上传封面」
  const tabbed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    if (!dlg) return false;
    for (const el of dlg.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || el.children.length > 2) continue;
      if (norm(el.textContent) === "上传封面") {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!tabbed) throw new Error("视频号封面弹窗内未找到「上传封面」入口");
  await page.waitForTimeout(1200);

  // 注入图片文件（探针实证：input 挂 .single-cover-uploader-wrap，隐藏可注入）
  const inputHandle = await page.evaluateHandle(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return null;
    return (
      root.querySelector('.single-cover-uploader-wrap input[type="file"]') ||
      [...root.querySelectorAll('input[type="file"]')].find((i) =>
        /image/.test(i.accept || "")
      ) ||
      null
    );
  });
  const inputEl = inputHandle.asElement();
  if (!inputEl) throw new Error("未找到视频号封面上传 file input");
  await inputEl.uploadFile(path.resolve(coverPath));
  console.log("[sph] 封面文件已注入上传区:", coverPath);

  // 等上传+裁剪视图落定（1080x1440 与 3:4 槽位同比，通常无强制裁剪步骤）
  await page.waitForTimeout(5000);

  // 点「确定」（兜底再试「确认」）
  const confirmed = await page.evaluate(() => {
    const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return { ok: false, reason: "no-shadow" };
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    if (!dlg) return { ok: false, reason: "no-dialog" };
    for (const label of ["确定", "确认"]) {
      for (const b of dlg.querySelectorAll(
        "button,.weui-desktop-btn,[role='button']"
      )) {
        const r = b.getBoundingClientRect();
        if (r.width > 0 && !b.disabled && norm(b.textContent) === label) {
          b.click();
          return { ok: true, label };
        }
      }
    }
    return { ok: false, reason: "no-确定/确认" };
  });
  if (!confirmed.ok) {
    throw new Error(`视频号封面弹窗确认失败: ${confirmed.reason}`);
  }
  console.log("[sph] 封面弹窗已点「" + confirmed.label + "」");
  await page.waitForTimeout(3500);

  // 校验：弹窗已关 + 槽位 img src 相对设置前变化；微信 CDN 域名为强信号
  const after = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return { src: "", dialogOpen: false };
    const img = root.querySelector(".cover-img-vertical");
    const dlg = [...root.querySelectorAll(".weui-desktop-dialog")].find(
      (d) =>
        (d.textContent || "").includes("编辑封面") &&
        d.getBoundingClientRect().width > 0
    );
    return { src: img ? img.src : "", dialogOpen: !!dlg };
  });
  const changed = !!after.src && after.src !== srcBefore;
  if (!changed) {
    throw new Error(
      `视频号封面设置后槽位图片未变化（src=${(after.src || "").slice(0, 120)}, 弹窗仍开=${after.dialogOpen}）`
    );
  }
  const cdn = /qpic|weixin|wechat|wx\.qq|qq\.com/.test(after.src);
  console.log(
    `[sph] 自定义封面已设置并校验通过（src变化=true, CDN=${cdn}, 弹窗已关=${!after.dialogOpen}）: ${after.src.slice(0, 120)}`
  );
  if (after.dialogOpen) {
    console.warn("[sph] ⚠️ 封面弹窗未关闭，尝试 Esc 收敛");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(1000);
  }
}

/**
 * 视频号横版封面（4:3）DOM 选择器集中配置【未经真机校准，待真机存草稿核对】。
 * 所有查询均在 wujie-app.wujie_iframe 的 shadowRoot 内执行；
 * 修改选择器只需改本对象，任何一步失败都会采集封面区 outerHTML 片段与诊断截图。
 */
export const SPH_HORIZONTAL_COVER_SELECTORS = Object.freeze({
  wujieHost: "wujie-app.wujie_iframe",
  // 竖封面槽位（排除用，避免误点竖封面）
  verticalSlotSelector: ".vertical-cover-wrap",
  // 横版封面槽位优先选择器
  slotSelectors: [
    ".horizon-cover-wrap",
    ".horizontal-cover-wrap",
    '[class*="horizon" i][class*="cover" i]',
    '[class*="horizontal" i][class*="cover" i]',
    '[class*="cover" i][class*="4-3" i]',
    '[class*="cover" i][class*="4_3" i]',
  ],
  // 横版封面槽位 img 优先选择器
  slotImgSelectors: [
    ".cover-img-horizon",
    ".cover-img-horizontal",
    ".horizon-cover-wrap img",
    ".horizontal-cover-wrap img",
    '[class*="horizon" i][class*="cover" i] img',
    '[class*="horizontal" i][class*="cover" i] img',
  ],
  // 文案兜底关键字（在非竖封面的 cover 容器里匹配）
  slotTextKeywords: ["4:3", "4：3", "横封面", "横版封面", "横屏封面", "朋友圈"],
  // 封面编辑弹窗
  dialogSelector: ".weui-desktop-dialog",
  dialogKeywords: ["编辑封面", "更换封面", "上传封面"],
  // 弹窗内上传封面入口文案
  uploadTabTexts: ["上传封面", "本地上传"],
  // 文件输入框
  fileInputSelectors: [
    '.single-cover-uploader-wrap input[type="file"]',
    '.weui-desktop-dialog input[type="file"]',
  ],
  // 确认按钮文案
  confirmButtonTexts: ["确定", "确认"],
  // 诊断采集容器选择器
  diagContainerSelector: '.cover-preview-wrap, .vertical-cover-wrap, [class*="cover"]',
});

async function dumpSphHorizontalCoverDiagnostics(page, stage, { data, window } = {}) {
  try {
    const diag = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
      const app = document.querySelector(cfg.wujieHost);
      const root = app && app.shadowRoot;
      if (!root) return { hasShadow: false, snippets: [], imgs: [], dialogs: [] };
      const nodes = Array.from(root.querySelectorAll(cfg.diagContainerSelector));
      const snippets = [];
      const imgs = [];
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
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
            imgCls: String(img.className || "").slice(0, 60),
            src: String(img.src || "").slice(0, 120),
          });
        }
      }
      const dialogs = Array.from(root.querySelectorAll(cfg.dialogSelector))
        .filter((d) => d.getBoundingClientRect().width > 0)
        .slice(0, 3)
        .map((d) => ({
          cls: String(d.className || "").slice(0, 80),
          text: norm(d.textContent).slice(0, 160),
          outerHTML: String(d.outerHTML || "").slice(0, 600),
        }));
      return { hasShadow: true, snippets, imgs, dialogs };
    }, SPH_HORIZONTAL_COVER_SELECTORS);
    console.warn(
      `[sph][cover-h][diag] stage=${stage} hasShadow=${diag.hasShadow} imgs=${JSON.stringify(
        diag.imgs
      )} dialogs=${JSON.stringify(diag.dialogs)}`
    );
    console.warn(
      `[sph][cover-h][diag] stage=${stage} coverAreaHTML=${JSON.stringify(
        diag.snippets
      ).slice(0, 3600)}`
    );
  } catch (e) {
    console.warn(
      `[sph][cover-h][diag] 采集 DOM 诊断失败(stage=${stage}): ${(e && e.message) || e}`
    );
  }
  try {
    const shot = await capturePublishFailureScreenshot(
      page,
      { ...(data || {}), pt: "视频号", _diagStage: `cover-h-${stage}` },
      { window }
    );
    if (shot) {
      console.warn(`[sph][cover-h][diag] stage=${stage} 诊断截图已保存: ${shot}`);
    }
  } catch (_) {
    /* 诊断截图失败不覆盖主错 */
  }
}

/**
 * 视频号上传自定义横版封面（4:3，1440×1080 JPEG）。
 * 校验与竖封面同等严格：弹窗必须关闭 且 横封面槽位 img src 相对设置前发生变化；
 * 任何一步失败均采集诊断日志（outerHTML 片段 + 截图）并抛错中止本条视频号发布。
 */
export async function uploadSphHorizontalCover(
  page,
  coverPathH,
  {
    data,
    window,
    alreadyNormalized = false,
    waitAfterUploadMs = 5000,
    pollTimeoutMs = 20000,
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
  const slotAttr = "data-mm-sph-cover-h-slot";
  const slotToken = `sph-ch-${Date.now()}`;
  let stage = "定位横封面槽位";

  try {
    // 1. 在 wujie 影子树中定位横封面槽位并记录原 src，然后点击打开弹窗
    const locateRes = await page.evaluate(
      (cfg, attr, token) => {
        const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
        const app = document.querySelector(cfg.wujieHost);
        const root = app && app.shadowRoot;
        if (!root) return { ok: false, reason: "no-shadow" };

        const verticalEl = root.querySelector(cfg.verticalSlotSelector);
        const isVerticalRelated = (el) => {
          if (!el || !verticalEl) return false;
          return (
            el === verticalEl ||
            verticalEl.contains(el) ||
            el.contains(verticalEl)
          );
        };
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 20;
        };

        let slot = null;
        let strategy = "";

        // 策略 1：优先匹配显式横封面选择器
        for (const sel of cfg.slotSelectors) {
          const cand = Array.from(root.querySelectorAll(sel)).find(
            (el) => isVisible(el) && !isVerticalRelated(el)
          );
          if (cand) {
            slot = cand;
            strategy = `selector:${sel}`;
            break;
          }
        }

        // 策略 2：按文案关键字（4:3 / 横封面 等）定位非竖封面槽位
        if (!slot) {
          const cands = Array.from(
            root.querySelectorAll('[class*="cover"], .cover-preview-wrap')
          ).filter((el) => {
            if (!isVisible(el) || isVerticalRelated(el)) return false;
            const t = norm(el.textContent);
            return (
              t.length <= 40 &&
              cfg.slotTextKeywords.some((kw) => t.includes(norm(kw)))
            );
          });
          if (cands.length > 0) {
            cands.sort((a, b) => {
              const aHasImg = a.querySelector("img") ? 0 : 1;
              const bHasImg = b.querySelector("img") ? 0 : 1;
              if (aHasImg !== bHasImg) return aHasImg - bHasImg;
              return norm(a.textContent).length - norm(b.textContent).length;
            });
            slot = cands[0];
            strategy = "keyword";
          }
        }

        // 策略 3：若存在多个 .cover-preview-wrap 且其一为竖封面，取非竖封面的槽位
        if (!slot) {
          const previews = Array.from(
            root.querySelectorAll(".cover-preview-wrap")
          ).filter((el) => isVisible(el) && !isVerticalRelated(el));
          if (previews.length > 0) {
            slot = previews[0];
            strategy = "other-cover-preview-wrap";
          }
        }

        if (!slot) return { ok: false, reason: "slot-not-found" };

        slot.setAttribute(attr, token);
        let img = slot.querySelector("img");
        if (!img) {
          for (const sel of cfg.slotImgSelectors) {
            const candidateImg = root.querySelector(sel);
            if (candidateImg) {
              img = candidateImg;
              break;
            }
          }
        }
        const srcBefore = img && img.src ? img.src : "";
        slot.click();
        return { ok: true, strategy, srcBefore };
      },
      SPH_HORIZONTAL_COVER_SELECTORS,
      slotAttr,
      slotToken
    );

    if (!locateRes || !locateRes.ok) {
      throw new Error(
        `未找到视频号横版封面(4:3)编辑入口（reason=${
          (locateRes && locateRes.reason) || "unknown"
        }）`
      );
    }
    console.log(
      `[sph][cover-h] 已点击横封面入口（策略=${locateRes.strategy}，原src=${String(
        locateRes.srcBefore || ""
      ).slice(0, 80)}）`
    );

    // 2. 等待编辑封面弹窗可见
    stage = "等待横封面弹窗";
    await page.waitForFunction(
      (cfg) => {
        const app = document.querySelector(cfg.wujieHost);
        const root = app && app.shadowRoot;
        if (!root) return false;
        for (const d of root.querySelectorAll(cfg.dialogSelector)) {
          const t = (d.textContent || "").replace(/\s+/g, "");
          const r = d.getBoundingClientRect();
          if (r.width > 0 && cfg.dialogKeywords.some((kw) => t.includes(kw))) {
            return true;
          }
        }
        return false;
      },
      { timeout: 15000 },
      SPH_HORIZONTAL_COVER_SELECTORS
    );
    await page.waitForTimeout(1000);

    // 3. 切到「上传封面」tab（若弹窗内未直接露出 file input）
    stage = "点击上传封面入口";
    const tabRes = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
      const app = document.querySelector(cfg.wujieHost);
      const root = app && app.shadowRoot;
      if (!root) return { ok: false, reason: "no-shadow" };
      const dlg = Array.from(root.querySelectorAll(cfg.dialogSelector)).find(
        (d) => {
          const t = norm(d.textContent);
          return (
            d.getBoundingClientRect().width > 0 &&
            cfg.dialogKeywords.some((kw) => t.includes(kw))
          );
        }
      );
      if (!dlg) return { ok: false, reason: "no-dialog" };
      for (const el of dlg.querySelectorAll("*")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || el.children.length > 2) continue;
        if (cfg.uploadTabTexts.includes(norm(el.textContent))) {
          el.click();
          return { ok: true, clickedTab: true };
        }
      }
      // 兜底：若弹窗直接内嵌了图片 file input，视为已在上传视图
      const directInput = dlg.querySelector('input[type="file"]');
      if (directInput) return { ok: true, clickedTab: false };
      return { ok: false, reason: "no-upload-tab" };
    }, SPH_HORIZONTAL_COVER_SELECTORS);
    if (!tabRes || !tabRes.ok) {
      throw new Error(
        `视频号横封面弹窗内未找到「上传封面」入口（${
          (tabRes && tabRes.reason) || "unknown"
        }）`
      );
    }
    if (tabRes.clickedTab) {
      await page.waitForTimeout(1000);
    }

    // 4. 注入 1440×1080 横版封面文件
    stage = "注入横封面文件";
    const inputHandle = await page.evaluateHandle((cfg) => {
      const app = document.querySelector(cfg.wujieHost);
      const root = app && app.shadowRoot;
      if (!root) return null;
      for (const sel of cfg.fileInputSelectors) {
        const found = root.querySelector(sel);
        if (found) return found;
      }
      return (
        Array.from(root.querySelectorAll('input[type="file"]')).find((i) =>
          /image/i.test(i.accept || "")
        ) || null
      );
    }, SPH_HORIZONTAL_COVER_SELECTORS);
    const inputEl = inputHandle && inputHandle.asElement ? inputHandle.asElement() : null;
    if (!inputEl) {
      throw new Error("未找到视频号横封面上传 file input");
    }
    await inputEl.uploadFile(path.resolve(effectivePath));
    console.log("[sph][cover-h] 横版封面文件已注入上传区:", effectivePath);

    if (waitAfterUploadMs > 0) {
      await page.waitForTimeout(waitAfterUploadMs);
    }

    // 5. 点「确定 / 确认」
    stage = "确认横封面弹窗";
    const confirmed = await page.evaluate((cfg) => {
      const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
      const app = document.querySelector(cfg.wujieHost);
      const root = app && app.shadowRoot;
      if (!root) return { ok: false, reason: "no-shadow" };
      const dlg = Array.from(root.querySelectorAll(cfg.dialogSelector)).find(
        (d) => {
          const t = norm(d.textContent);
          return (
            d.getBoundingClientRect().width > 0 &&
            cfg.dialogKeywords.some((kw) => t.includes(kw))
          );
        }
      );
      if (!dlg) return { ok: false, reason: "no-dialog" };
      for (const label of cfg.confirmButtonTexts) {
        for (const b of dlg.querySelectorAll(
          "button,.weui-desktop-btn,[role='button']"
        )) {
          const r = b.getBoundingClientRect();
          if (r.width > 0 && !b.disabled && norm(b.textContent) === label) {
            b.click();
            return { ok: true, label };
          }
        }
      }
      return { ok: false, reason: "no-confirm-btn" };
    }, SPH_HORIZONTAL_COVER_SELECTORS);
    if (!confirmed || !confirmed.ok) {
      throw new Error(
        `视频号横封面弹窗确认失败（${
          (confirmed && confirmed.reason) || "unknown"
        }）`
      );
    }
    console.log(`[sph][cover-h] 横封面弹窗已点「${confirmed.label}」`);

    // 6. 严格校验：弹窗必须已关闭 且 横封面槽位 img src 相对设置前变化
    stage = "校验横封面生效";
    const deadline = Date.now() + Math.max(0, pollTimeoutMs);
    let after = { src: "", dialogOpen: true };
    do {
      after = await page.evaluate(
        (cfg, attr, token) => {
          const norm = (t) => String(t || "").replace(/\s+/g, "").trim();
          const app = document.querySelector(cfg.wujieHost);
          const root = app && app.shadowRoot;
          if (!root) return { src: "", dialogOpen: false };
          const marked = root.querySelector(`[${attr}="${token}"]`);
          let img = marked ? marked.querySelector("img") : null;
          if (!img) {
            for (const sel of cfg.slotImgSelectors) {
              const cand = root.querySelector(sel);
              if (cand && cand.src) {
                img = cand;
                break;
              }
            }
          }
          const dlg = Array.from(root.querySelectorAll(cfg.dialogSelector)).find(
            (d) => {
              const t = norm(d.textContent);
              return (
                d.getBoundingClientRect().width > 0 &&
                cfg.dialogKeywords.some((kw) => t.includes(kw))
              );
            }
          );
          return { src: img && img.src ? img.src : "", dialogOpen: !!dlg };
        },
        SPH_HORIZONTAL_COVER_SELECTORS,
        slotAttr,
        slotToken
      );
      const changed = Boolean(after.src && after.src !== locateRes.srcBefore);
      if (!after.dialogOpen && changed) {
        break;
      }
      if (Date.now() < deadline) {
        await page.waitForTimeout(500);
      }
    } while (Date.now() < deadline);

    const changed = Boolean(after.src && after.src !== locateRes.srcBefore);
    if (after.dialogOpen || !changed) {
      throw new Error(
        `视频号横版封面(4:3)设置未确认生效（弹窗仍开=${after.dialogOpen}，槽位图片变化=${changed}，src=${String(
          after.src || ""
        ).slice(0, 120)}）`
      );
    }
    console.log(
      `[sph][cover-h] 横版封面(4:3)已设置并校验通过（src变化=true, 弹窗已关=true）: ${String(
        after.src
      ).slice(0, 120)}`
    );
  } catch (err) {
    await dumpSphHorizontalCoverDiagnostics(page, stage, { data, window });
    const msg = (err && err.message) || String(err);
    throw new Error(
      msg.includes("已中止")
        ? msg
        : `视频号横版封面(4:3)设置失败（${stage}）：${msg}，已中止本条视频号发布，未发布`
    );
  } finally {
    await page
      .evaluate((cfg, attr, token) => {
        const app = document.querySelector(cfg.wujieHost);
        const root = app && app.shadowRoot;
        const el = root && root.querySelector(`[${attr}="${token}"]`);
        if (el) el.removeAttribute(attr);
      }, SPH_HORIZONTAL_COVER_SELECTORS, slotAttr, slotToken)
      .catch(() => {});
  }
}

/**
 * 选择视频号「视频标注」（.post-with-mark-tag）。
 * 自行拍摄时间/地点、转载来源为平台选填，本轮只点主选项。
 */
async function applySphCreativeStatement(page, value) {
  if (isCreativeStatementNone(value)) return;
  const label = resolveSphCreativeStatementLabel(value);
  if (!label || label === "无标注" || label === "无需标注") return;

  const opened = await page.evaluate(() => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const trigger = root.querySelector(".post-with-mark-tag .select-display");
    if (!trigger) return false;
    trigger.click();
    return true;
  });
  if (!opened) {
    console.log("视频标注：未找到入口，跳过");
    return;
  }

  await page.waitForTimeout(300);
  const clicked = await page.evaluate((expected) => {
    const app = document.querySelector("wujie-app.wujie_iframe");
    const root = app && app.shadowRoot;
    if (!root) return false;
    const options = Array.from(root.querySelectorAll(".mark-tag-option"));
    const target = options.find((item) => {
      const main = item.querySelector(".option-main");
      return String((main && main.textContent) || "").trim() === expected;
    });
    if (!target) return false;
    target.click();
    return true;
  }, label);
  if (!clicked) {
    console.warn(`视频标注：未找到选项「${label}」，跳过`);
    return;
  }
  console.log(`[sph][mark-tag] 已选择：${label}`);
  await page.waitForTimeout(400);
}

async function clickSphDraftButton(page) {
  // 用实时查询点击：此前的 ElementHandle.click 在影子树重渲染瞬间会拿到
  // 已分离节点，报 not clickable 直接中断发布（e2e 实测）
  await clickSphShadow(page, SPH_DRAFT_BUTTON_SELECTOR, {
    timeout: WAIT_SELECTOR_APPEAR_MS,
    label: "视频号保存草稿按钮",
  });
  await page.waitForTimeout(1000);
}

/**
 * 读取发表页当前「可见」弹窗/toast 的文本。
 * 视频号保存成功的 toast 文案是「已保存」（绿色对勾，存活约 2-3 秒）；
 * 页面里还常驻着 display 之外的隐藏模板（如「将此次编辑保留？」确认框），
 * 只看 computed display/visibility 会把模板当真——必须用 checkVisibility。
 * @returns {Promise<string[]>} 当前可见的弹窗/toast 文本列表（可能多个并存）
 */
async function readVisibleSphDialogTexts(page) {
  try {
    return await page.evaluate(() => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      const root = app && app.shadowRoot;
      if (!root) return [];
      const nodes = root.querySelectorAll(
        '[class*="toast"], [class*="Toast"], [class*="dialog"], [class*="Dialog"], [class*="tips"]'
      );
      const out = [];
      for (const d of nodes) {
        let visible = false;
        try {
          visible =
            typeof d.checkVisibility === "function"
              ? d.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : d.getClientRects().length > 0;
        } catch (_) {
          visible = false;
        }
        if (!visible) continue;
        // 模板节点可能通过 checkVisibility（如常驻包装层）但实际不占渲染面积：
        // 再要求有真实尺寸且落在视口内，排除离屏/零尺寸的隐藏模板
        const rect = d.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        if (
          rect.right <= 0 ||
          rect.bottom <= 0 ||
          rect.left >= window.innerWidth ||
          rect.top >= window.innerHeight
        ) {
          continue;
        }
        const t = String(d.textContent || "").replace(/\s+/g, " ").trim();
        if (t) out.push(t.slice(0, 120));
        if (out.length >= 5) break;
      }
      return out;
    });
  } catch (_) {
    return [];
  }
}

async function clickSphPublishButton(page) {
  await clickSphShadow(page, SPH_PUBLISH_BUTTON_SELECTOR, {
    timeout: WAIT_SELECTOR_APPEAR_MS,
    label: "视频号发布按钮",
  });
  await page.waitForTimeout(1000);
}

async function waitSphUploadProcessing(page) {
  await pollPageUntil(
    page,
    () => {
      const app = document.querySelector("wujie-app.wujie_iframe");
      if (!app || !app.shadowRoot) return false;
      const tag = app.shadowRoot.querySelector(".tag-inner");
      return !!(tag && tag.textContent.trim() === "删除");
    },
    WAIT_UPLOAD_PROCESSING_MS,
    2000,
    "等待视频处理超时（未出现「删除」标签）"
  );
  await page.waitForTimeout(2000);
}

async function fallbackLinkFailureToDraft(page, data, window, event, error) {
  const detail =
    (error && error.message) ||
    (typeof error === "string" ? error : String(error));
  try {
    // 链接在表单前半段填写；失败时仍需等待视频处理完成后才能可靠保存草稿。
    await waitSphUploadProcessing(page);
    // 转存草稿前必须先完成合集选择 + 回读；合集失败则中止，不点保存草稿。
    await selectPlatformCollection(page, "视频号", data.publishOptions, {
      data,
      window,
    });
    await clickSphDraftButton(page);
    event.reply("puppeteerFile-done", {
      ...data,
      status: true,
      outcome: "draft_saved",
      publishMode: "draft",
      publishToDraft: true,
      needsAttention: true,
      failureStage: "video_link",
      message: `视频号链接添加失败，视频已保存为草稿：${detail}`,
    });
    maybeClosePublishWindow({ ...data, closeWindowAfterPublish: true }, window);
    return true;
  } catch (draftError) {
    if (draftError && draftError.isCollectionError) {
      draftError.message = `视频号链接添加失败（${detail}），转存草稿前选择合集失败：${draftError.message}`;
      throw draftError;
    }
    const draftDetail =
      (draftError && draftError.message) || String(draftError || "未知错误");
    throw new Error(
      `视频号链接添加失败：${detail}；保存草稿也失败：${draftDetail}`
    );
  }
}

export default async function (page, data, window, event, onFinish) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;

  console.log(data);
  await page.waitForTimeout(1000 * 5);
  try {
    const sel = 'wujie-app.wujie_iframe >>> input[type="file"]';

    const uploadInput = await page.waitForSelector(sel, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    if (!uploadInput) throw new Error("上传 input 不存在");
    await uploadInput.uploadFile(path.resolve(data.filePath));
    await uploadInput.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } catch (err) {
    console.error("❌ 文件上传失败:", err);
    // 上传失败必须阻断：文件没进上传区还继续填表点发表，会发出残缺作品（PR #52）
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: `视频号视频上传失败: ${(err && err.message) || String(err)}`,
      closeWindow: true,
    });
    return;
  }

  let sphRuleAdjustments = [];
  let sphAdjSummary = "";
  try {
    const text = buildPlatformVideoTextDetailed("视频号", data.data);
    sphRuleAdjustments = mergeRuleAdjustments(
      data.ruleAdjustments || (data.data && data.data.ruleAdjustments),
      text.adjustments
    );
    sphAdjSummary = formatRuleAdjustmentsSummary(sphRuleAdjustments);
    const isMac = process.platform === "darwin";

    /** 实时查询影子树里的输入字段内容（editor 读 textContent，input 读 value） */
    const readSphField = (sel, isValue) =>
      page.evaluate(
        ({ sel, isValue }) => {
          const app = document.querySelector("wujie-app.wujie_iframe");
          if (!app || !app.shadowRoot) return "";
          const el = app.shadowRoot.querySelector(sel);
          if (!el) return "";
          return isValue
            ? String(el.value || "")
            : String(el.textContent || el.innerText || "");
        },
        { sel, isValue }
      );
    const clearAndType = async () => {
      // 清掉旧内容再输入：视频号简介为「简介+标签」拼接，助手页若恢复上次草稿，
      // 不清空会把新内容追加成双份。wujie 影子树里 selection API 不可靠，用键盘全选。
      await page.keyboard.down(isMac ? "Meta" : "Control");
      await page.keyboard.press("a");
      await page.keyboard.up(isMac ? "Meta" : "Control");
      await page.keyboard.press("Backspace");
    };

    // 简介编辑器：点击聚焦后键盘输入，回读校验未生效则重试
    // （wujie 重渲染会让 ElementHandle/焦点静默失效，键盘输入落空且无报错——e2e 实测）
    const DESC_SEL = ".post-desc-box .input-editor";
    let descOk = false;
    for (let attempt = 1; attempt <= 3 && !descOk; attempt++) {
      await clickSphShadow(page, DESC_SEL, { timeout: 5000, focus: true });
      await clearAndType();
      if (text.description) {
        await page.keyboard.type(text.description, { delay: 50 });
      }
      await page.waitForTimeout(300);
      descOk = matchesHead(await readSphField(DESC_SEL, false), text.description);
      if (!descOk && attempt < 3) {
        console.warn(`[sph] 简介第 ${attempt} 次输入未生效，重输`);
      }
    }
    if (!descOk) {
      throw new Error(
        `描述未写入（期望含「${head(text.description)}」，回读校验失败）`
      );
    }

    const shortTitle = text.shortTitle;
    if (shortTitle) {
      const sel2 =
        'input[placeholder="填写短标题有机会获得更多流量"]';
      let newBt = shortTitle.replace(/[，。、\/,;:!?'"()\[\]{}<>]/g, " ");
      let btOk = false;
      for (let attempt = 1; attempt <= 3 && !btOk; attempt++) {
        await clickSphShadow(page, sel2, { timeout: 5000, focus: true });
        await clearAndType();
        await page.keyboard.type(newBt, { delay: 50 });
        await page.waitForTimeout(300);
        btOk = matchesHead(await readSphField(sel2, true), newBt);
        if (!btOk && attempt < 3) {
          console.warn(`[sph] 短标题第 ${attempt} 次输入未生效，重输`);
        }
      }
      if (!btOk) {
        throw new Error(
          `短标题未写入（期望含「${head(newBt)}」，回读校验失败）`
        );
      }
    } else {
      console.log("视频号短标题未填写，跳过");
    }
  } catch (err) {
    console.error("❌ 输入失败:", err);
    // 输入失败必须阻断：带空描述存草稿/发布会产出残缺作品（PR #52）
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: `视频号描述/短标题填写失败: ${(err && err.message) || String(err)}`,
      closeWindow: true,
    });
    return;
  }

  try {
    const link = resolveVideoLinkOption("视频号", data.publishOptions);
    if (link && link.enabled === true) {
      try {
        const selectedLink = await attachSphVideoLink(page, link);
        console.log(
          `[sph][link] 已添加 ${selectedLink.type} ${selectedLink.value}: ${
            selectedLink.label || ""
          }`
        );
      } catch (linkError) {
        console.error("[sph][link] 添加链接失败:", linkError);
        const handled = await fallbackLinkFailureToDraft(
          page,
          data,
          window,
          event,
          linkError
        );
        if (handled) return;
      }
    }

    // 先等视频上传处理完成，再执行视频标注与原创声明（避免转码中控件置灰误判为无原创资格）
    await waitSphUploadProcessing(page);

    try {
      await applySphCreativeStatement(
        page,
        data.data && data.data.creativeStatement
      );
    } catch (markError) {
      console.warn(
        "视频标注选择未完成:",
        markError && markError.message ? markError.message : markError
      );
    }

    // 原创声明（默认开启；关闭时不触碰页面；开启时失败或无资格中止本条发布，不点发表/保存草稿）
    let originalStatementResult = null;
    if (isOriginalStatementRequested(data)) {
      originalStatementResult = await applySphOriginalStatement(page, {
        data,
        window,
      });
      await verifySphDeclarations(page, {
        creativeStatement: data.data && data.data.creativeStatement,
        originalStatement: true,
        data,
        window,
      });
    }

    // 自定义封面（双比例：竖 3:4 + 横 4:3）：
    // - 给了 coverPath：先设竖封面（1080×1440）
    // - 给了 coverPathH：归一 1440×1080 后设横封面槽位
    // - 没给 coverPathH 但给了 coverPath：自动生成 1440×1080 后设横封面槽位；
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
        await uploadSphCustomCover(page, dualCovers.verticalPath || rawCoverPath);
      }
      if (dualCovers.horizontalPath) {
        await uploadSphHorizontalCover(page, dualCovers.horizontalPath, {
          data,
          window,
          alreadyNormalized: true,
        });
      } else if (dualCovers.horizontalGenWarning) {
        console.warn(
          `[sph] 横版封面自动生成失败（仅保留竖封面，不中止发布）：${dualCovers.horizontalGenWarning}`
        );
      }
    }

    // 选择合集（留空跳过；找不到入口/同名合集/回读不符时抛确定性错误中止发布且不重试）
    await selectPlatformCollection(page, "视频号", data.publishOptions, {
      data,
      window,
    });

    // 所有表单项（包括商品、合集）完成后，草稿和发布只能二选一执行。
    const urlBefore = readPageUrl(page);
    if (isDraftMode) await clickSphDraftButton(page);
    else await clickSphPublishButton(page);
    console.log(
      isDraftMode ? "✅ 视频号视频已保存草稿" : "✅ 视频号视频上传成功"
    );
    // 视频号存草稿不跳转，成功 toast 文案固定为「已保存」（e2e 截图实证），
    // 但渲染位置在 wujie 影子树/内部容器里且类名未知——点击后 6 秒内用
    // 全量文本轮询捕捉（模板噪音已核对不含「已保存」），同时盯可见弹窗：
    // 强拒绝（保存失败/网络异常）抛错走重试；校验提示（请先选择等）重试无用，
    // 归 needs_attention 人工处理
    const extraPayload = {};
    let draftVerdictOverride;
    if (isDraftMode) {
      let toastVerified = false;
      let rejectText = "";
      const deadline = Date.now() + 6000;
      do {
        try {
          const visible = await readVisibleSphDialogTexts(page);
          // 「将此次编辑保留?」为常驻隐藏模板（保存成功后仍会误捕），排除
          const bad = visible.find((t) => !/将此次编辑保留/.test(t));
          if (bad) {
            rejectText = bad;
            break;
          }
        } catch (_) {
          /* 页面跳转中，下一轮再试 */
        }
        try {
          const text = await readPageText(page);
          if (/已保存|保存成功|草稿已保存/.test(text)) {
            toastVerified = true;
            break;
          }
        } catch (_) {
          /* 下一轮再试 */
        }
        if (Date.now() < deadline) {
          await page.waitForTimeout(500).catch(() => {});
        }
      } while (Date.now() < deadline);
      if (rejectText) {
        if (/请(?:先)?(?:填写|输入|选择|上传|勾选|设置|完善)|不能为空|必填/.test(rejectText)) {
          draftVerdictOverride = {
            outcome: "unverified",
            evidence: `平台提示「${rejectText.slice(0, 40)}」，请检查表单后重试`,
          };
        } else {
          throw new Error(`保存草稿被平台拒绝：${rejectText}`);
        }
      } else {
        draftVerdictOverride = toastVerified
          ? { outcome: "verified", evidence: "发表页出现「已保存」提示" }
          : {
              outcome: "unverified",
              evidence: "未见保存成功提示（视频号存草稿无跳转，无法进一步核对）",
            };
      }
    }
    if (originalStatementResult) {
      extraPayload.originalStatementStatus = originalStatementResult.status;
    }
    if (sphRuleAdjustments.length > 0) {
      extraPayload.ruleAdjustments = sphRuleAdjustments;
      extraPayload.ruleAdjustmentsSummary = sphAdjSummary;
    }
    const sphBaseSuccessMsg = isDraftMode ? "保存草稿成功" : "上传成功";
    await replyPublishOutcome({
      page,
      data,
      window,
      event,
      urlBefore,
      isDraftMode,
      successMessage: sphAdjSummary
        ? `${sphBaseSuccessMsg}（规则调整：${sphAdjSummary}）`
        : sphBaseSuccessMsg,
      extraPayload,
      draftVerdictOverride,
    });
  } catch (err) {
    const detail =
      (err && err.message) || (typeof err === "string" ? err : String(err));
    const isCollectionError = Boolean(err && err.isCollectionError);
    const isOriginalError = Boolean(err && err.originalStatementError);
    console.error("❌ 视频号发布失败:", err);
    // 失败瞬间截图留证（登录过期 / 风控弹窗 / 元素改版 / 原创声明失败都能一眼看出）
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message:
        isCollectionError || isOriginalError
          ? detail
          : detail && detail.length > 400
          ? `${detail.slice(0, 400)}…`
          : detail || "上传失败",
      ...(isCollectionError
        ? {
            extraPayload: {
              outcome: "collection_failed",
              needsAttention: true,
              ...(err.failScreenshot
                ? { failScreenshot: err.failScreenshot }
                : {}),
            },
          }
        : isOriginalError
        ? {
            extraPayload: {
              originalStatementStatus: err.noOriginalQualification
                ? "no_qualification"
                : "failed",
              outcome: "original_statement_failed",
              needsAttention: true,
            },
          }
        : {}),
      closeWindow: true,
    });
  }
}
