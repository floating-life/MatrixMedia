"use strict";

/**
 * 发布时选择合集（抖音 / 快手 / 视频号）公共自动化模块 + 平台配置常量。
 *
 * 设计约束：
 * 1. 各平台入口文案、触发器选择器、弹层/选项选择器、回读选择器集中在
 *    `PLATFORM_COLLECTION_CONFIGS` 常量中，便于真机采集 DOM 证据后直接校准。
 * 2. 视频号（sph）发布页跑在 `wujie-app.wujie_iframe` 的 shadowRoot 里，
 *    参考 sphSeries.js / sphEntityLink.js 的 shadowRoot 穿透方式，全流程
 *    在 evaluate 内实时查询并点击（避免 wujie 重渲染导致 ElementHandle 失效）。
 * 3. 快手（ks）为 Ant Design，下拉触发与选项点击需派发 mousedown → mouseup → click。
 * 4. 所有传入 `page.evaluate` 的浏览器端函数必须完全自包含，不得引用模块作用域闭包变量。
 * 5. 找不到入口 / 找不到同名合集 / 回读不符均抛确定性错误（deterministic=true），
 *    带候选合集名（最多 10 个）与入口查找详情，并调用 failureScreenshot 留证，
 *    上层中止发布且不重试。
 */

import {
  collapseCollectionText,
  getCollectionCanonicalPlatform,
  getCollectionPlatformKey,
  normalizeCollectionName,
  resolveCollectionOption,
} from "../../../shared/videoLink.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";

export const COLLECTION_CANDIDATE_LIMIT = 10;

/**
 * 禁止作为合集入口点击的表单提交/动作按钮文案常量（安全红线）：
 * 候选入口本身及其祖先/后代按钮含这些文案的一律排除，绝不允许误点发布/存草稿/取消等按钮。
 */
export const FORBIDDEN_ENTRY_ACTION_TEXTS = [
  "发布",
  "立即发布",
  "确认发布",
  "定时发布",
  "发表",
  "立即发表",
  "存草稿",
  "保存草稿",
  "暂存离开",
  "暂存草稿",
  "保存",
  "提交",
  "取消",
  "取消发布",
  "离开",
  "放弃",
  "删除",
];

export const COLLECTION_DEFAULT_TIMEOUTS = {
  entryTimeoutMs: 5000,
  optionTimeoutMs: 5000,
  readbackTimeoutMs: 3000,
  pollIntervalMs: 300,
  afterOpenDelayMs: 400,
  afterSelectDelayMs: 400,
};

/**
 * 各平台合集控件定位与回读配置常量（供真机校准）。
 * - labelTexts: 表单行左侧标签文案候选（优先按行定位控件，避免误点页面其他下拉）
 * - entryTexts: 控件自身占位符/按钮文案候选（行标签未命中时兜底定位触发器）
 * - triggerSelectors: 触发器候选选择器
 * - popupSelectors: 展开后的下拉列表 / 弹窗容器选择器
 * - optionSelectors: 合集候选项选择器
 * - optionTextSelectors: 候选项内部提取合集标题的子节点选择器（避免带上视频数等副文案）
 * - readbackSelectors: 选完后在入口/表单行内读取已选合集文案的选择器
 * - confirmButtonLabels: 若平台以弹窗呈现合集选择，点击候选项后尝试点击的确认按钮文案
 */
export const PLATFORM_COLLECTION_CONFIGS = {
  dy: {
    platformKey: "dy",
    platformName: "抖音",
    useShadowRoot: false,
    shadowHostSelector: "",
    dispatchMouseDown: false,
    labelTexts: ["添加到合集", "作品合集", "合集"],
    entryTexts: [
      "请选择合集",
      "选择合集",
      "添加到合集",
      "添加合集",
      "不加入合集",
      "不添加到合集",
    ],
    rowContainerSelectors: [
      "[class*='collection']",
      "[class*='mix']",
      "[class*='form-item']",
      "[class*='setting-item']",
      "[class*='form-field']",
    ],
    triggerSelectors: [
      ".semi-select",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "button",
      "[role='button']",
    ],
    popupSelectors: [
      ".semi-select-option-list",
      ".semi-portal .semi-popover-content",
      ".semi-popover",
      ".semi-modal-body",
      "[role='listbox']",
      "[role='menu']",
    ],
    optionSelectors: [
      ".semi-select-option",
      "[role='option']",
      "[role='menuitem']",
      "label.semi-radio",
      "li",
    ],
    optionTextSelectors: [
      ".semi-select-option-text",
      ".semi-radio-addon",
      ".title",
      ".name",
    ],
    readbackSelectors: [
      ".semi-select-selection-text",
      ".semi-select-selection",
      ".semi-tag-content",
      ".title",
      ".name",
    ],
    confirmButtonLabels: ["确定", "确认", "完成"],
  },
  ks: {
    platformKey: "ks",
    platformName: "快手",
    useShadowRoot: false,
    shadowHostSelector: "",
    dispatchMouseDown: true,
    labelTexts: ["合集", "选择合集", "添加到合集", "作品合集", "所属合集"],
    entryTexts: [
      "请选择合集",
      "选择合集",
      "添加到合集",
      "添加至合集",
      "不加入合集",
      "暂不选择",
    ],
    rowContainerSelectors: [
      "[class*='edit-form-item']",
      "[class*='form-item']",
      "[class*='collection']",
      "[class*='serial']",
    ],
    triggerSelectors: [
      ".ant-select-selector",
      ".ant-select",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
      "button",
      "[role='button']",
    ],
    popupSelectors: [
      ".ant-select-dropdown",
      ".ant-modal-content",
      ".ant-popover-inner",
      "[role='listbox']",
      "[role='menu']",
    ],
    optionSelectors: [
      ".ant-select-item-option",
      ".ant-select-item",
      "[role='option']",
      "[role='menuitem']",
      ".ant-radio-wrapper",
      "li",
    ],
    optionTextSelectors: [
      ".ant-select-item-option-content",
      ".title",
      ".name",
    ],
    readbackSelectors: [
      ".ant-select-selection-item",
      ".ant-select-selector",
      ".title",
      ".name",
    ],
    confirmButtonLabels: ["确定", "确认", "完成"],
  },
  sph: {
    platformKey: "sph",
    platformName: "视频号",
    useShadowRoot: true,
    shadowHostSelector: "wujie-app.wujie_iframe",
    dispatchMouseDown: false,
    labelTexts: ["添加到合集", "合集", "选择合集", "视频合集"],
    entryTexts: [
      "请选择合集",
      "选择合集",
      "添加到合集",
      "暂不添加",
      "不添加到合集",
      "未选择",
    ],
    rowContainerSelectors: [
      ".post-album-wrap",
      "[class*='album']",
      "[class*='collection']",
      ".form-item",
      "[class*='form-item']",
    ],
    triggerSelectors: [
      ".post-album-display",
      ".album-select",
      ".select-display",
      ".ant-select-selector",
      ".ant-select",
      ".weui-desktop-form__dropdown",
      "[role='combobox']",
      "[role='button']",
      "button",
    ],
    popupSelectors: [
      ".common-option-list-wrap",
      ".option-list-wrap",
      ".album-list",
      ".ant-select-dropdown",
      ".weui-desktop-dropdown__list",
      ".weui-desktop-dialog",
      ".weui-desktop-popover",
      "[role='listbox']",
      "[role='menu']",
    ],
    optionSelectors: [
      ".option-item",
      ".album-item",
      ".ant-select-item-option",
      ".weui-desktop-dropdown__list-ele",
      ".weui-desktop-form__check-label",
      "[role='option']",
      "li",
      "tr",
    ],
    optionTextSelectors: [
      ".option-main",
      ".album-name",
      ".title",
      ".name",
      ".ant-select-item-option-content",
    ],
    readbackSelectors: [
      ".post-album-display",
      ".select-display",
      ".ant-select-selection-item",
      ".choosen-name",
      ".album-name",
      ".name",
    ],
    confirmButtonLabels: ["确定", "确认", "完成"],
  },
};

/**
 * 合集控件占位/未选入口文案全集（回读时一律不得视为已选合集值）。
 */
export const COLLECTION_PLACEHOLDER_TEXTS = Array.from(
  new Set([
    ...PLATFORM_COLLECTION_CONFIGS.dy.entryTexts,
    ...PLATFORM_COLLECTION_CONFIGS.ks.entryTexts,
    ...PLATFORM_COLLECTION_CONFIGS.sph.entryTexts,
    "请选择合集",
    "选择合集",
    "添加到合集",
    "添加合集",
    "添加至合集",
    "暂不添加",
    "暂不选择",
    "未选择",
    "不加入合集",
    "不添加到合集",
    "暂不加入",
    "不选择",
    "无合集",
  ])
);

export function getPlatformCollectionConfig(platform) {
  const key = getCollectionPlatformKey(platform);
  return key ? PLATFORM_COLLECTION_CONFIGS[key] || null : null;
}

/** 归一化合集名称文本（去除全部空白），用于严格匹配与回读校验 */
export function normalizeCollectionMatchText(text) {
  return collapseCollectionText(text);
}

/** 判断候选项名称与目标合集名是否去空白后完全相等 */
export function isExactCollectionMatch(candidateText, targetName) {
  const c = normalizeCollectionMatchText(candidateText);
  const t = normalizeCollectionMatchText(targetName);
  return Boolean(c && t && c === t);
}

/** 判断文本是否属于合集占位/未选文案（不得视为已选合集值） */
export function isCollectionPlaceholderText(text, extraPlaceholders = []) {
  const d = normalizeCollectionMatchText(text);
  if (!d) return true;
  const set = new Set(
    COLLECTION_PLACEHOLDER_TEXTS.map((p) => normalizeCollectionMatchText(p)).filter(
      Boolean
    )
  );
  if (Array.isArray(extraPlaceholders)) {
    for (let i = 0; i < extraPlaceholders.length; i++) {
      const np = normalizeCollectionMatchText(extraPlaceholders[i]);
      if (np) set.add(np);
    }
  }
  return set.has(d);
}

/**
 * 严格回读校验（严禁 includes）：
 * - 任何占位/未选入口文案（如「请选择合集」「选择合集」「添加到合集」「暂不添加」「未选择」「不加入合集」等）
 *   一律视为未选，返回 false；
 * - 支持传入字符串、已选标签文本数组、或 readSelectedCollectionInDom 返回对象；
 * - 必须去空白后与目标合集名完全相等，或控件内某已选标签节点文本去空白后恰等于目标合集名。
 */
export function matchesCollectionReadback(
  displayedOrResult,
  targetName,
  options = {}
) {
  const targetNorm = normalizeCollectionMatchText(targetName);
  if (!targetNorm) return false;
  const extraPlaceholders =
    options && Array.isArray(options.placeholders) ? options.placeholders : [];
  const isExactNonPlaceholder = (raw) => {
    const d = normalizeCollectionMatchText(raw);
    if (!d) return false;
    if (isCollectionPlaceholderText(d, extraPlaceholders)) return false;
    return d === targetNorm;
  };

  if (Array.isArray(displayedOrResult)) {
    return displayedOrResult.some(isExactNonPlaceholder);
  }
  if (displayedOrResult && typeof displayedOrResult === "object") {
    if (
      Array.isArray(displayedOrResult.selectedTexts) &&
      displayedOrResult.selectedTexts.length > 0 &&
      displayedOrResult.selectedTexts.some(isExactNonPlaceholder)
    ) {
      return true;
    }
    if (displayedOrResult.isPlaceholder === true) return false;
    return isExactNonPlaceholder(displayedOrResult.displayedText);
  }
  return isExactNonPlaceholder(displayedOrResult);
}

/** 整理页面候选合集名（去重、去空、最多保留 limit 个） */
export function formatCollectionCandidates(
  candidates,
  limit = COLLECTION_CANDIDATE_LIMIT
) {
  const list = Array.isArray(candidates) ? candidates : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const cleaned = normalizeCollectionName(list[i]);
    if (!cleaned) continue;
    const key = collapseCollectionText(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

export function createCollectionError(code, platform, message, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.deterministic = true;
  err.isCollectionError = true;
  err.platform = platform;
  err.details = details;
  if (details && details.failScreenshot) {
    err.failScreenshot = details.failScreenshot;
  }
  return err;
}

function waitMs(page, ms) {
  if (ms <= 0) return Promise.resolve();
  if (page && typeof page.waitForTimeout === "function") {
    return page.waitForTimeout(ms).catch(() => {});
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * 浏览器端函数（page.evaluate 序列化执行，严禁引用模块作用域变量）
 * ------------------------------------------------------------------ */

/**
 * 浏览器端：查找合集入口控件并点击展开。
 * 安全红线：
 *   1. 候选入口一律排除 FORBIDDEN_ENTRY_ACTION_TEXTS（「发布」「存草稿」「暂存离开」「保存草稿」「发表」「取消」等）
 *      及其祖先/后代含这些文案的按钮与 submit/reset 控件；
 *   2. 入口必须与「合集」表单标签处在同一表单行容器内，绝不越界到整页/表单级容器；
 *   3. 入口缺失或 disabled 直接返回失败，不做任何宽松兜底点击。
 */
export function openCollectionEntryInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var token = String((payload && payload.token) || "");
  var norm = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, "").trim();
  };
  var clean = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  };

  var root = document;
  var shadowFound = true;
  if (cfg.useShadowRoot) {
    var host = document.querySelector(
      cfg.shadowHostSelector || "wujie-app.wujie_iframe"
    );
    root = host && host.shadowRoot ? host.shadowRoot : null;
    shadowFound = Boolean(root);
    if (!root) {
      return {
        ok: false,
        reason: "shadow_root_not_found",
        diagnostics: {
          useShadowRoot: true,
          shadowHost: cfg.shadowHostSelector || "wujie-app.wujie_iframe",
          shadowFound: false,
          triedLabels: cfg.labelTexts || [],
          triedEntries: cfg.entryTexts || [],
          nearbyKeywords: [],
          formLabels: [],
        },
      };
    }
  }

  var isVisible = function (el) {
    if (!el || el.isConnected === false) return false;
    var node = el;
    while (node && node !== root && node.nodeType === 1) {
      if (node.hidden === true) return false;
      if (
        typeof node.getAttribute === "function" &&
        node.getAttribute("aria-hidden") === "true"
      ) {
        return false;
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

  var isDisabled = function (el) {
    var node = el;
    for (var depth = 0; node && node !== root && depth < 4; depth++) {
      if (node.disabled === true) return true;
      if (
        typeof node.getAttribute === "function" &&
        (node.getAttribute("disabled") !== null ||
          node.getAttribute("aria-disabled") === "true")
      ) {
        return true;
      }
      var cls = String((node.getAttribute && node.getAttribute("class")) || "");
      if (
        /\b(ant-select-disabled|semi-select-disabled|is-disabled|disabled|weui-desktop-btn_disabled)\b/.test(
          cls
        )
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  var forbiddenTexts = (
    (payload && Array.isArray(payload.forbiddenActionTexts)
      ? payload.forbiddenActionTexts
      : null) || [
      "发布",
      "立即发布",
      "确认发布",
      "定时发布",
      "发表",
      "立即发表",
      "存草稿",
      "保存草稿",
      "暂存离开",
      "暂存草稿",
      "保存",
      "提交",
      "取消",
      "取消发布",
      "离开",
      "放弃",
      "删除",
    ]
  )
    .map(norm)
    .filter(Boolean);

  var isForbiddenText = function (raw) {
    var t = norm(raw);
    if (!t) return false;
    for (var i = 0; i < forbiddenTexts.length; i++) {
      if (t === forbiddenTexts[i] || t.indexOf(forbiddenTexts[i]) !== -1) {
        return true;
      }
    }
    return false;
  };

  var nodeHasForbiddenText = function (node) {
    if (!node) return false;
    var txt = node.innerText != null ? node.innerText : node.textContent;
    if (isForbiddenText(txt)) return true;
    if (typeof node.getAttribute === "function") {
      if (isForbiddenText(node.getAttribute("aria-label"))) return true;
      if (isForbiddenText(node.getAttribute("title"))) return true;
      if (isForbiddenText(node.getAttribute("value"))) return true;
    }
    if (node.value != null && isForbiddenText(node.value)) return true;
    return false;
  };

  var isButtonLike = function (node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = String(node.tagName || "").toUpperCase();
    if (tag === "BUTTON" || tag === "A") return true;
    if (tag === "INPUT") {
      var inputType = String(
        (node.getAttribute && node.getAttribute("type")) || node.type || ""
      ).toLowerCase();
      if (
        inputType === "submit" ||
        inputType === "button" ||
        inputType === "reset"
      ) {
        return true;
      }
    }
    var role = String(
      (node.getAttribute && node.getAttribute("role")) || ""
    ).toLowerCase();
    if (role === "button") return true;
    var cls = String((node.getAttribute && node.getAttribute("class")) || "");
    if (/(?:^|[\s_-])(?:btn|button)(?:$|[\s_-])/i.test(cls)) return true;
    return false;
  };

  var isForbiddenEntryCandidate = function (el) {
    if (!el) return true;
    var tag = String(el.tagName || "").toUpperCase();
    var typeAttr = String(
      (el.getAttribute && el.getAttribute("type")) || el.type || ""
    ).toLowerCase();
    if (
      (tag === "BUTTON" || tag === "INPUT") &&
      (typeAttr === "submit" || typeAttr === "reset")
    ) {
      return true;
    }
    if (nodeHasForbiddenText(el)) return true;
    // 排除祖先中存在含提交/动作文案的按钮
    var anc = el.parentElement;
    while (anc && anc !== root && anc.nodeType === 1) {
      if (isButtonLike(anc) && nodeHasForbiddenText(anc)) return true;
      anc = anc.parentElement;
    }
    // 排除后代中存在含提交/动作文案的元素或 submit/reset 按钮
    if (typeof el.querySelectorAll === "function") {
      var desc = [];
      try {
        desc = Array.from(el.querySelectorAll("*"));
      } catch (_) {
        desc = [];
      }
      for (var di = 0; di < desc.length; di++) {
        var dTag = String(desc[di].tagName || "").toUpperCase();
        var dType = String(
          (desc[di].getAttribute && desc[di].getAttribute("type")) ||
            desc[di].type ||
            ""
        ).toLowerCase();
        if (
          (dTag === "BUTTON" || dTag === "INPUT") &&
          (dType === "submit" || dType === "reset")
        ) {
          return true;
        }
        if (nodeHasForbiddenText(desc[di])) return true;
      }
    }
    return false;
  };

  var triggerClick = function (el, useMouseSequence) {
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    if (
      useMouseSequence &&
      typeof el.dispatchEvent === "function" &&
      typeof MouseEvent === "function"
    ) {
      var rect =
        typeof el.getBoundingClientRect === "function"
          ? el.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 };
      var opts = {
        bubbles: true,
        cancelable: true,
        view: typeof window !== "undefined" ? window : undefined,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));
      return;
    }
    if (typeof el.click === "function") {
      el.click();
    }
  };

  var queryList = function (container, selectors) {
    var out = [];
    if (!container || typeof container.querySelectorAll !== "function") return out;
    for (var i = 0; i < selectors.length; i++) {
      var found = [];
      try {
        found = Array.from(container.querySelectorAll(selectors[i]));
      } catch (_) {
        found = [];
      }
      for (var j = 0; j < found.length; j++) {
        if (out.indexOf(found[j]) === -1) out.push(found[j]);
      }
    }
    return out;
  };

  var labelTexts = (cfg.labelTexts || []).map(norm).filter(Boolean);
  var entryTexts = (cfg.entryTexts || []).map(norm).filter(Boolean);
  var rowContainerSelectors = cfg.rowContainerSelectors || [
    "[class*='collection']",
    "[class*='album']",
    "[class*='form-item']",
    "[class*='setting-item']",
    "[class*='form-field']",
  ];
  var triggerSelectors = cfg.triggerSelectors || [
    ".semi-select",
    ".ant-select-selector",
    ".ant-select",
    "[role='combobox']",
    "button",
    "[role='button']",
  ];
  var semanticSelectSelectors = triggerSelectors.filter(function (sel) {
    var s = String(sel || "").trim().toLowerCase();
    return s !== "button" && s !== "[role='button']" && s !== '[role="button"]';
  });

  var allEls = [];
  try {
    allEls = Array.from(root.querySelectorAll("*")).filter(isVisible);
  } catch (_) {
    allEls = [];
  }

  var matchLabelText = function (text) {
    if (!text || text.length > 18) return false;
    var stripped = text.replace(/[:：*＊]+$/g, "");
    for (var i = 0; i < labelTexts.length; i++) {
      if (stripped === labelTexts[i]) return true;
    }
    return false;
  };

  var matchEntryText = function (text) {
    if (!text || text.length > 24) return false;
    for (var i = 0; i < entryTexts.length; i++) {
      if (text === entryTexts[i] || text.indexOf(entryTexts[i]) !== -1) {
        return true;
      }
    }
    return false;
  };

  var isSemanticSelect = function (el) {
    if (!el || typeof el.matches !== "function") return false;
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "SELECT") return true;
    for (var i = 0; i < semanticSelectSelectors.length; i++) {
      try {
        if (el.matches(semanticSelectSelectors[i])) return true;
      } catch (_) {}
    }
    return false;
  };

  var isLabelWrapper = function (node, lbNormText) {
    if (!node || node.nodeType !== 1) return false;
    var cls = String((node.getAttribute && node.getAttribute("class")) || "");
    if (/(?:^|[\s_-])label(?:$|[\s_-])/i.test(cls)) return true;
    var nodeText = norm(
      node.innerText != null ? node.innerText : node.textContent
    ).replace(/[:：*＊]+$/g, "");
    return Boolean(nodeText && nodeText === lbNormText);
  };

  var matchesRowContainerSelector = function (node) {
    if (!node || typeof node.matches !== "function") return false;
    for (var i = 0; i < rowContainerSelectors.length; i++) {
      try {
        if (node.matches(rowContainerSelectors[i])) return true;
      } catch (_) {}
    }
    return false;
  };

  var isWholeFormOrMultiRowContainer = function (node, lb, lbNormText) {
    if (
      !node ||
      node === root ||
      node === document ||
      node === document.body ||
      node === document.documentElement
    ) {
      return true;
    }
    var tag = String(node.tagName || "").toUpperCase();
    if (tag === "FORM" || tag === "MAIN" || tag === "BODY" || tag === "HTML") {
      return true;
    }
    var txtLen = norm(
      node.innerText != null ? node.innerText : node.textContent
    ).length;
    if (txtLen > 240) return true;
    if (typeof node.querySelectorAll === "function") {
      var btns = [];
      try {
        btns = Array.from(
          node.querySelectorAll(
            "button, [role='button'], input[type='submit'], input[type='button']"
          )
        );
      } catch (_) {
        btns = [];
      }
      for (var bi = 0; bi < btns.length; bi++) {
        if (isVisible(btns[bi]) && isForbiddenEntryCandidate(btns[bi])) {
          return true;
        }
      }
      var otherLabels = [];
      try {
        otherLabels = Array.from(node.querySelectorAll("label"));
      } catch (_) {
        otherLabels = [];
      }
      for (var oli = 0; oli < otherLabels.length; oli++) {
        var ol = otherLabels[oli];
        if (!isVisible(ol) || ol === lb) continue;
        if (typeof lb.contains === "function" && lb.contains(ol)) continue;
        if (typeof ol.contains === "function" && ol.contains(lb)) continue;
        var olText = norm(
          ol.innerText != null ? ol.innerText : ol.textContent
        ).replace(/[:：*＊]+$/g, "");
        if (olText && olText !== lbNormText) return true;
      }
      var nestedRows = queryList(node, [
        ".form-item",
        "[class*='form-item']",
        "[class*='setting-item']",
        "[class*='form-field']",
      ]).filter(function (r) {
        return (
          r !== node &&
          isVisible(r) &&
          !isLabelWrapper(r, lbNormText) &&
          !isSemanticSelect(r)
        );
      });
      // 仅统计互不包含的独立表单行，避免把行内子节点（如 ant-form-item-control）算成多行
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
    }
    return false;
  };

  // 严格策略：只认与「合集」表单标签处于同一表单行容器内的合集入口控件，
  // 排除所有提交/动作类按钮；不做任何跨行/全页宽松兜底点击。
  var labelNodes = allEls.filter(function (el) {
    var t = norm(el.innerText != null ? el.innerText : el.textContent);
    if (!matchLabelText(t)) return false;
    var kids = el.children ? Array.from(el.children) : [];
    for (var k = 0; k < kids.length; k++) {
      if (
        isVisible(kids[k]) &&
        matchLabelText(
          norm(kids[k].innerText != null ? kids[k].innerText : kids[k].textContent)
        )
      ) {
        return false;
      }
    }
    return true;
  });

  var chosenTrigger = null;
  var chosenRow = null;
  var strategy = "";
  var matchedLabel = "";
  var disabledCandidate = null;
  var disabledLabel = "";

  for (var li = 0; li < labelNodes.length && !chosenTrigger; li++) {
    var lb = labelNodes[li];
    var lbText = clean(lb.innerText != null ? lb.innerText : lb.textContent);
    var lbNormText = norm(lbText).replace(/[:：*＊]+$/g, "");
    var container = lb.parentElement;
    for (var depth = 0; container && depth < 5; depth++) {
      if (
        container === root ||
        container === document ||
        container === document.body ||
        container === document.documentElement
      ) {
        break;
      }
      var containerIsLabelWrap = isLabelWrapper(container, lbNormText);
      if (containerIsLabelWrap) {
        container = container.parentElement;
        continue;
      }
      if (isWholeFormOrMultiRowContainer(container, lb, lbNormText)) {
        break;
      }
      var rowCandidates = queryList(container, triggerSelectors).filter(function (
        el
      ) {
        if (!isVisible(el)) return false;
        if (el === lb) return false;
        if (typeof el.contains === "function" && el.contains(lb)) return false;
        if (isForbiddenEntryCandidate(el)) return false;
        if (isSemanticSelect(el)) return true;
        var txt = norm(el.innerText != null ? el.innerText : el.textContent);
        var ph = norm(
          typeof el.getAttribute === "function"
            ? el.getAttribute("placeholder")
            : ""
        );
        return (
          matchEntryText(txt) ||
          matchEntryText(ph) ||
          txt.indexOf("合集") !== -1
        );
      });
      if (rowCandidates.length > 0) {
        var enabledTriggers = rowCandidates.filter(function (el) {
          return !isDisabled(el);
        });
        if (enabledTriggers.length > 0) {
          var preferred =
            enabledTriggers.find(function (el) {
              var txt = norm(
                el.innerText != null ? el.innerText : el.textContent
              );
              var ph = norm(
                typeof el.getAttribute === "function"
                  ? el.getAttribute("placeholder")
                  : ""
              );
              return matchEntryText(txt) || matchEntryText(ph);
            }) || enabledTriggers[0];
          chosenTrigger = preferred;
          chosenRow = container;
          strategy = "label_row";
          matchedLabel = lbText;
          break;
        }
        if (!disabledCandidate) {
          disabledCandidate = rowCandidates[0];
          disabledLabel = lbText;
        }
        break;
      }
      if (matchesRowContainerSelector(container)) {
        break;
      }
      container = container.parentElement;
    }
  }

  if (!chosenTrigger) {
    var nearbyKeywords = [];
    var nearbySeen = {};
    var formLabels = [];
    var formLabelSeen = {};
    for (var ai = 0; ai < allEls.length; ai++) {
      var node = allEls[ai];
      var tClean = clean(node.innerText != null ? node.innerText : node.textContent);
      var tNorm = norm(tClean);
      if (!tNorm || tNorm.length > 24) continue;
      if (
        /合集|系列|剧集|专题|专栏|更多设置|声明/.test(tNorm) &&
        !nearbySeen[tNorm] &&
        nearbyKeywords.length < 10
      ) {
        nearbySeen[tNorm] = true;
        nearbyKeywords.push(tClean);
      }
      if (
        node.tagName === "LABEL" &&
        !formLabelSeen[tNorm] &&
        formLabels.length < 10
      ) {
        formLabelSeen[tNorm] = true;
        formLabels.push(tClean);
      }
    }
    return {
      ok: false,
      reason: disabledCandidate ? "entry_disabled" : "entry_not_found",
      diagnostics: {
        useShadowRoot: Boolean(cfg.useShadowRoot),
        shadowHost: cfg.shadowHostSelector || "",
        shadowFound: shadowFound,
        triedLabels: cfg.labelTexts || [],
        triedEntries: cfg.entryTexts || [],
        matchedLabel: disabledLabel,
        disabledEntryText: disabledCandidate
          ? clean(
              disabledCandidate.innerText != null
                ? disabledCandidate.innerText
                : disabledCandidate.textContent
            ).slice(0, 60)
          : "",
        nearbyKeywords: nearbyKeywords,
        formLabels: formLabels,
      },
    };
  }

  if (token && typeof chosenTrigger.setAttribute === "function") {
    chosenTrigger.setAttribute("data-mm-collection-entry", token);
  }
  if (token && chosenRow && typeof chosenRow.setAttribute === "function") {
    chosenRow.setAttribute("data-mm-collection-row", token);
  }

  var entryText = clean(
    chosenTrigger.innerText != null
      ? chosenTrigger.innerText
      : chosenTrigger.textContent
  ).slice(0, 60);

  triggerClick(chosenTrigger, Boolean(cfg.dispatchMouseDown));

  return {
    ok: true,
    strategy: strategy,
    matchedLabel: matchedLabel,
    entryText: entryText,
    shadowFound: shadowFound,
  };
}

/**
 * 浏览器端：扫描已打开的合集弹层/下拉列表，收集候选合集名（最多 10 个），
 * 并点击与目标合集名「去空白后完全相等」的选项。
 */
export function selectCollectionOptionInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var targetName = String((payload && payload.targetName) || "");
  var token = String((payload && payload.token) || "");
  var candidateLimit = Number((payload && payload.candidateLimit) || 10);
  var norm = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, "").trim();
  };
  var clean = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  };
  var targetNorm = norm(targetName);

  var root = document;
  if (cfg.useShadowRoot) {
    var host = document.querySelector(
      cfg.shadowHostSelector || "wujie-app.wujie_iframe"
    );
    root = host && host.shadowRoot ? host.shadowRoot : null;
    if (!root) {
      return {
        ok: false,
        reason: "shadow_root_not_found",
        popupFound: false,
        candidates: [],
      };
    }
  }

  var isVisible = function (el) {
    if (!el || el.isConnected === false) return false;
    var node = el;
    while (node && node !== root && node.nodeType === 1) {
      if (node.hidden === true) return false;
      if (
        typeof node.getAttribute === "function" &&
        node.getAttribute("aria-hidden") === "true"
      ) {
        return false;
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

  var isOptionDisabled = function (el) {
    if (!el) return true;
    if (el.disabled === true) return true;
    if (
      typeof el.getAttribute === "function" &&
      el.getAttribute("aria-disabled") === "true"
    ) {
      return true;
    }
    var cls = String((el.getAttribute && el.getAttribute("class")) || "");
    return /\b(ant-select-item-option-disabled|semi-select-option-disabled|is-disabled|disabled)\b/.test(
      cls
    );
  };

  var queryList = function (container, selectors) {
    var out = [];
    if (!container || typeof container.querySelectorAll !== "function") return out;
    for (var i = 0; i < selectors.length; i++) {
      var found = [];
      try {
        found = Array.from(container.querySelectorAll(selectors[i]));
      } catch (_) {
        found = [];
      }
      for (var j = 0; j < found.length; j++) {
        if (out.indexOf(found[j]) === -1) out.push(found[j]);
      }
    }
    return out;
  };

  var entryEl = token
    ? root.querySelector('[data-mm-collection-entry="' + token + '"]')
    : null;

  // 1. 优先通过 entry 的 aria-controls / aria-owns 关联弹层
  var popups = [];
  if (entryEl && typeof entryEl.getAttribute === "function") {
    var idAttrs = [
      entryEl.getAttribute("aria-controls"),
      entryEl.getAttribute("aria-owns"),
    ];
    for (var ia = 0; ia < idAttrs.length; ia++) {
      var ids = String(idAttrs[ia] || "")
        .split(/\s+/)
        .filter(Boolean);
      for (var ib = 0; ib < ids.length; ib++) {
        var linked =
          (typeof root.getElementById === "function"
            ? root.getElementById(ids[ib])
            : root.querySelector('[id="' + ids[ib] + '"]')) || null;
        if (linked && !isVisible(linked) && linked.parentElement) {
          var p = linked.parentElement;
          for (var d = 0; p && !isVisible(p) && d < 3; d++) p = p.parentElement;
          if (p) linked = p;
        }
        if (linked && isVisible(linked) && popups.indexOf(linked) === -1) {
          popups.push(linked);
        }
      }
    }
  }

  // 2. 按平台 popupSelectors 收集可见弹层（倒序优先最近打开的弹层）
  var foundPopups = queryList(root, cfg.popupSelectors || []).filter(isVisible);
  for (var pi = foundPopups.length - 1; pi >= 0; pi--) {
    if (popups.indexOf(foundPopups[pi]) === -1) {
      popups.push(foundPopups[pi]);
    }
  }

  if (popups.length === 0) {
    return {
      ok: false,
      reason: "popup_not_found",
      popupFound: false,
      candidates: [],
    };
  }

  var optionSelectors = cfg.optionSelectors || [
    ".semi-select-option",
    ".ant-select-item-option",
    "[role='option']",
    "li",
  ];
  var optionTextSelectors = cfg.optionTextSelectors || [".title", ".name"];

  var extractOptionName = function (opt) {
    if (typeof opt.getAttribute === "function") {
      var attrLabel = clean(opt.getAttribute("label") || opt.getAttribute("title") || "");
      if (attrLabel) return attrLabel;
    }
    for (var ti = 0; ti < optionTextSelectors.length; ti++) {
      try {
        var sub = opt.querySelector(optionTextSelectors[ti]);
        if (sub && isVisible(sub)) {
          var subText = clean(
            sub.innerText != null ? sub.innerText : sub.textContent
          );
          if (subText) return subText;
        }
      } catch (_) {}
    }
    return clean(opt.innerText != null ? opt.innerText : opt.textContent);
  };

  var candidates = [];
  var seen = {};
  var matchedOption = null;
  var matchedPopup = null;
  var matchedName = "";

  for (var pIdx = 0; pIdx < popups.length; pIdx++) {
    var popup = popups[pIdx];
    var opts = queryList(popup, optionSelectors).filter(function (el) {
      return isVisible(el) && el !== entryEl;
    });
    for (var oi = 0; oi < opts.length; oi++) {
      var opt = opts[oi];
      var name = extractOptionName(opt);
      var key = norm(name);
      if (!key) continue;
      if (!seen[key]) {
        seen[key] = true;
        candidates.push(name);
      }
      if (!matchedOption && key === targetNorm) {
        matchedOption = opt;
        matchedPopup = popup;
        matchedName = name;
      }
    }
    if (matchedOption) break;
  }

  if (!matchedOption) {
    return {
      ok: false,
      reason: candidates.length === 0 ? "options_empty" : "option_not_found",
      popupFound: true,
      candidates: candidates.slice(0, candidateLimit),
      totalCandidates: candidates.length,
    };
  }

  if (isOptionDisabled(matchedOption)) {
    return {
      ok: false,
      reason: "option_disabled",
      popupFound: true,
      candidates: candidates.slice(0, candidateLimit),
      totalCandidates: candidates.length,
    };
  }

  if (typeof matchedOption.scrollIntoView === "function") {
    try {
      matchedOption.scrollIntoView({ block: "center", inline: "center" });
    } catch (_) {}
  }

  if (
    cfg.dispatchMouseDown &&
    typeof matchedOption.dispatchEvent === "function" &&
    typeof MouseEvent === "function"
  ) {
    var rect =
      typeof matchedOption.getBoundingClientRect === "function"
        ? matchedOption.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
    var mOpts = {
      bubbles: true,
      cancelable: true,
      view: typeof window !== "undefined" ? window : undefined,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    matchedOption.dispatchEvent(new MouseEvent("mousedown", mOpts));
    matchedOption.dispatchEvent(new MouseEvent("mouseup", mOpts));
    matchedOption.dispatchEvent(new MouseEvent("click", mOpts));
  } else if (typeof matchedOption.click === "function") {
    matchedOption.click();
  }

  var popupClass = String(
    (matchedPopup &&
      matchedPopup.getAttribute &&
      matchedPopup.getAttribute("class")) ||
      ""
  );
  var inModal = /dialog|modal/i.test(popupClass);

  return {
    ok: true,
    matchedName: matchedName,
    candidates: candidates.slice(0, candidateLimit),
    totalCandidates: candidates.length,
    inModal: inModal,
  };
}

/**
 * 浏览器端：若合集选择在弹窗内完成且存在可用的「确定/确认/完成」按钮，则点击确认。
 */
export function clickCollectionModalConfirmInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var labels = (cfg.confirmButtonLabels || ["确定", "确认", "完成"]).map(
    function (s) {
      return String(s || "").replace(/\s+/g, "");
    }
  );
  var root = document;
  if (cfg.useShadowRoot) {
    var host = document.querySelector(
      cfg.shadowHostSelector || "wujie-app.wujie_iframe"
    );
    root = host && host.shadowRoot ? host.shadowRoot : null;
    if (!root) return { ok: false, clicked: false };
  }
  var isVisible = function (el) {
    if (!el || el.isConnected === false) return false;
    if (typeof el.getBoundingClientRect === "function") {
      var rect = el.getBoundingClientRect();
      if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
    }
    return true;
  };
  var modals = Array.from(
    root.querySelectorAll(
      ".semi-modal, .ant-modal-content, .weui-desktop-dialog, [role='dialog']"
    )
  ).filter(isVisible);
  if (!modals.length) return { ok: true, clicked: false };
  var modal = modals[modals.length - 1];
  var btns = Array.from(
    modal.querySelectorAll("button, .weui-desktop-btn, [role='button']")
  ).filter(isVisible);
  for (var i = 0; i < labels.length; i++) {
    var target = btns.find(function (b) {
      var t = String(b.textContent || "").replace(/\s+/g, "");
      return t === labels[i] && !b.disabled;
    });
    if (target) {
      target.click();
      return { ok: true, clicked: true, label: labels[i] };
    }
  }
  return { ok: true, clicked: false };
}

/**
 * 浏览器端：回读合集控件当前显示的已选文本（排除仍展开的弹层/下拉节点与表单标签，
 * 并显式过滤占位/未选文案，避免把「请选择合集」或行标签「合集」误判为已选合集）。
 */
export function readSelectedCollectionInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var token = String((payload && payload.token) || "");
  var norm = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, "").trim();
  };
  var clean = function (t) {
    return String(t == null ? "" : t).replace(/\s+/g, " ").trim();
  };

  var root = document;
  if (cfg.useShadowRoot) {
    var host = document.querySelector(
      cfg.shadowHostSelector || "wujie-app.wujie_iframe"
    );
    root = host && host.shadowRoot ? host.shadowRoot : null;
    if (!root) {
      return {
        ok: false,
        reason: "shadow_root_not_found",
        displayedText: "",
        selectedTexts: [],
        isPlaceholder: false,
      };
    }
  }

  var isVisible = function (el) {
    if (!el || el.isConnected === false) return false;
    var node = el;
    while (node && node !== root && node.nodeType === 1) {
      if (node.hidden === true) return false;
      if (
        typeof node.getAttribute === "function" &&
        node.getAttribute("aria-hidden") === "true"
      ) {
        return false;
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

  var isInsidePopup = function (el) {
    if (!el || typeof el.closest !== "function") return false;
    try {
      return Boolean(
        el.closest(
          "[role='listbox'], [role='option'], .ant-select-dropdown, .semi-select-option-list, .common-option-list-wrap, .weui-desktop-dropdown__list"
        )
      );
    } catch (_) {
      return false;
    }
  };

  var isPlaceholderNode = function (el) {
    if (!el || typeof el.getAttribute !== "function") return false;
    var cls = String(el.getAttribute("class") || "");
    return /(?:^|[\s_-])placeholder(?:$|[\s_-])/i.test(cls);
  };

  var placeholderList = (
    (payload && Array.isArray(payload.placeholders)
      ? payload.placeholders
      : null) || [
      "请选择合集",
      "选择合集",
      "添加到合集",
      "添加合集",
      "添加至合集",
      "暂不添加",
      "暂不选择",
      "未选择",
      "不加入合集",
      "不添加到合集",
      "暂不加入",
      "不选择",
      "无合集",
    ]
  ).concat(Array.isArray(cfg.entryTexts) ? cfg.entryTexts : []);
  var placeholderSet = {};
  for (var phIdx = 0; phIdx < placeholderList.length; phIdx++) {
    var phNorm = norm(placeholderList[phIdx]);
    if (phNorm) placeholderSet[phNorm] = true;
  }
  var isPlaceholderText = function (txt) {
    var n = norm(txt);
    return !n || Boolean(placeholderSet[n]);
  };

  var labelTexts = (cfg.labelTexts || []).map(norm).filter(Boolean);
  var isFormLabelNode = function (el) {
    if (!el || el.nodeType !== 1) return false;
    if (String(el.tagName || "").toUpperCase() === "LABEL") return true;
    var cls = String((el.getAttribute && el.getAttribute("class")) || "");
    if (/(?:^|[\s_-])label(?:$|[\s_-])/i.test(cls)) return true;
    return false;
  };

  var entryEl = token
    ? root.querySelector('[data-mm-collection-entry="' + token + '"]')
    : null;
  var rowEl = token
    ? root.querySelector('[data-mm-collection-row="' + token + '"]')
    : null;

  // 若组件重渲染导致临时标记丢失，按行标签重新定位只读控件（不点击，且绝不把行标签当成已选值）
  var rowLabelEl = null;
  if (!entryEl && !rowEl) {
    var allEls = [];
    try {
      allEls = Array.from(root.querySelectorAll("*")).filter(isVisible);
    } catch (_) {
      allEls = [];
    }
    rowLabelEl = allEls.find(function (el) {
      var t = norm(el.innerText != null ? el.innerText : el.textContent).replace(
        /[:：*＊]+$/g,
        ""
      );
      return labelTexts.indexOf(t) !== -1;
    });
    if (rowLabelEl && rowLabelEl.parentElement) {
      rowEl = rowLabelEl.parentElement;
    }
  }

  // 若 entryEl 丢失但 rowEl 存在，优先在 rowEl 中重定位交互控件（排除 label）
  if (!entryEl && rowEl && typeof rowEl.querySelectorAll === "function") {
    var triggerSelectors = cfg.triggerSelectors || [
      ".semi-select",
      ".ant-select-selector",
      ".ant-select",
      ".post-album-display",
      "[role='combobox']",
    ];
    for (var ti = 0; ti < triggerSelectors.length && !entryEl; ti++) {
      var foundTriggers = [];
      try {
        foundTriggers = Array.from(rowEl.querySelectorAll(triggerSelectors[ti]));
      } catch (_) {
        foundTriggers = [];
      }
      for (var tj = 0; tj < foundTriggers.length; tj++) {
        var cand = foundTriggers[tj];
        if (!isVisible(cand) || isInsidePopup(cand) || isFormLabelNode(cand)) {
          continue;
        }
        if (
          rowLabelEl &&
          (cand === rowLabelEl ||
            (typeof cand.contains === "function" && cand.contains(rowLabelEl)))
        ) {
          continue;
        }
        entryEl = cand;
        break;
      }
    }
  }

  var readbackSelectors = cfg.readbackSelectors || [];
  var selectedTexts = [];
  var selectedSeen = {};
  var firstDisplayText = "";
  var firstReadbackSource = "";

  var pushCandidate = function (txt, source) {
    var c = clean(txt);
    if (!c) return;
    if (!firstDisplayText) {
      firstDisplayText = c;
      firstReadbackSource = source;
    }
    if (isPlaceholderText(c)) return;
    var k = norm(c);
    if (k && !selectedSeen[k]) {
      selectedSeen[k] = true;
      selectedTexts.push(c);
    }
  };

  var readScope = entryEl || rowEl;
  if (readScope && isVisible(readScope) && !isInsidePopup(readScope)) {
    // 1. 按平台 readbackSelectors 收集控件内已选标签/回读节点文本
    for (var ri = 0; ri < readbackSelectors.length; ri++) {
      var nodes = [];
      try {
        nodes = Array.from(readScope.querySelectorAll(readbackSelectors[ri]));
      } catch (_) {
        nodes = [];
      }
      for (var ni = 0; ni < nodes.length; ni++) {
        var n = nodes[ni];
        if (!isVisible(n) || isInsidePopup(n) || isPlaceholderNode(n)) continue;
        if (!entryEl && isFormLabelNode(n)) continue;
        if (
          rowLabelEl &&
          (n === rowLabelEl ||
            (typeof n.contains === "function" && n.contains(rowLabelEl)))
        ) {
          continue;
        }
        var txt = clean(n.innerText != null ? n.innerText : n.textContent);
        if (txt) {
          pushCandidate(txt, readbackSelectors[ri]);
        }
      }
    }

    // 2. 若定位到了明确入口控件 entryEl，同时收集其内部可见叶节点标签文本（不含占位节点）与控件自身文本
    if (entryEl && isVisible(entryEl) && !isInsidePopup(entryEl)) {
      if (typeof entryEl.querySelectorAll === "function") {
        var leaves = [];
        try {
          leaves = Array.from(entryEl.querySelectorAll("*"));
        } catch (_) {
          leaves = [];
        }
        for (var li = 0; li < leaves.length; li++) {
          var leaf = leaves[li];
          if (!isVisible(leaf) || isInsidePopup(leaf) || isPlaceholderNode(leaf)) {
            continue;
          }
          if (leaf.children && leaf.children.length > 0) continue;
          var leafTxt = clean(
            leaf.innerText != null ? leaf.innerText : leaf.textContent
          );
          if (leafTxt) {
            pushCandidate(leafTxt, "entry_tag");
          }
        }
      }
      var entryText = clean(
        entryEl.innerText != null ? entryEl.innerText : entryEl.textContent
      );
      if (entryText) {
        pushCandidate(entryText, "entry");
      }
    }

    if (firstDisplayText || selectedTexts.length > 0) {
      return {
        ok: true,
        displayedText: selectedTexts[0] || firstDisplayText,
        selectedTexts: selectedTexts,
        isPlaceholder:
          selectedTexts.length === 0 && isPlaceholderText(firstDisplayText),
        readbackSource: firstReadbackSource || (entryEl ? "entry" : "row"),
      };
    }
  }

  return {
    ok: false,
    reason: "readback_target_missing",
    displayedText: "",
    selectedTexts: [],
    isPlaceholder: false,
  };
}

export function cleanupCollectionMarkersInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var token = String((payload && payload.token) || "");
  if (!token) return;
  var root = document;
  if (cfg.useShadowRoot) {
    var host = document.querySelector(
      cfg.shadowHostSelector || "wujie-app.wujie_iframe"
    );
    root = host && host.shadowRoot ? host.shadowRoot : null;
    if (!root) return;
  }
  try {
    var entries = root.querySelectorAll('[data-mm-collection-entry="' + token + '"]');
    for (var i = 0; i < entries.length; i++) {
      entries[i].removeAttribute("data-mm-collection-entry");
    }
    var rows = root.querySelectorAll('[data-mm-collection-row="' + token + '"]');
    for (var j = 0; j < rows.length; j++) {
      rows[j].removeAttribute("data-mm-collection-row");
    }
  } catch (_) {}
}

/* ------------------------------------------------------------------ *
 * Node 侧主编排流程
 * ------------------------------------------------------------------ */

function formatEntryLookupSummary(diag) {
  if (!diag || typeof diag !== "object") return "未获取入口诊断信息";
  const parts = [];
  if (diag.useShadowRoot) {
    parts.push(
      `shadowRoot(${diag.shadowHost || "wujie-app.wujie_iframe"})=${
        diag.shadowFound ? "已穿透" : "未找到"
      }`
    );
  }
  if (Array.isArray(diag.triedLabels) && diag.triedLabels.length) {
    parts.push(`查找标签=[${diag.triedLabels.join("/")}]`);
  }
  if (Array.isArray(diag.triedEntries) && diag.triedEntries.length) {
    parts.push(`查找入口文案=[${diag.triedEntries.join("/")}]`);
  }
  if (Array.isArray(diag.nearbyKeywords) && diag.nearbyKeywords.length) {
    parts.push(`页面相近文案=[${diag.nearbyKeywords.slice(0, 10).join("、")}]`);
  } else {
    parts.push("页面相近文案=（无）");
  }
  if (Array.isArray(diag.formLabels) && diag.formLabels.length) {
    parts.push(`可见表单标签=[${diag.formLabels.slice(0, 10).join("、")}]`);
  }
  return parts.join("；");
}

function formatCandidateListSummary(candidates) {
  const cleaned = formatCollectionCandidates(
    candidates,
    COLLECTION_CANDIDATE_LIMIT
  );
  return cleaned.length > 0 ? cleaned.join("、") : "（无）";
}

/**
 * 发布时选择合集主入口（抖音 / 快手 / 视频号共用）。
 *
 * - 未配置或留空：立即返回 `{ skipped: true, selected: false, name: "" }`，完全不触碰 page。
 * - 任一步失败（入口缺失 / 同名合集缺失 / 回读不符）：
 *   先截图（复用 failureScreenshot），打 `[collection] <平台> …` 日志，
 *   再抛带 `deterministic=true`、`isCollectionError=true` 的错误中止发布。
 *
 * @param {import("puppeteer-core").Page} page
 * @param {string} platform 平台名或短码（抖音/快手/视频号/dy/ks/sph）
 * @param {object} publishOptions
 * @param {object} [context]
 * @param {object} [context.data]
 * @param {object} [context.window]
 * @param {object} [context.timeouts]
 * @param {Function} [context.captureScreenshot] 单测可注入截图桩
 * @returns {Promise<{ skipped: boolean, selected: boolean, name: string, displayedText?: string, candidates?: string[] }>}
 */
export async function selectPlatformCollection(
  page,
  platform,
  publishOptions = {},
  context = {}
) {
  const resolved = resolveCollectionOption(platform, publishOptions);
  if (!resolved || resolved.enabled !== true || !resolved.name) {
    return { skipped: true, selected: false, name: "" };
  }

  const canonicalPlatform =
    getCollectionCanonicalPlatform(platform) || String(platform || "");
  const config = getPlatformCollectionConfig(canonicalPlatform);
  if (!config) {
    return { skipped: true, selected: false, name: "" };
  }

  const targetName = resolved.name;
  const timeouts = {
    ...COLLECTION_DEFAULT_TIMEOUTS,
    ...((context && context.timeouts) || {}),
  };
  const token = `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const failWithScreenshot = async (code, message, details = {}) => {
    const captureFn =
      (context &&
        typeof context.captureScreenshot === "function" &&
        context.captureScreenshot) ||
      capturePublishFailureScreenshot;
    let shot = "";
    try {
      shot = await captureFn(
        page,
        (context && context.data) || { pt: canonicalPlatform },
        { window: context && context.window }
      );
    } catch (_) {
      shot = "";
    }
    console.error(
      `[collection] ${canonicalPlatform} 失败(${code}): ${message}${
        shot ? `（截图：${shot}）` : ""
      }`
    );
    throw createCollectionError(code, canonicalPlatform, message, {
      ...details,
      failScreenshot: shot,
    });
  };

  console.log(
    `[collection] ${canonicalPlatform} 开始选择合集：「${targetName}」`
  );
  console.log(
    `[collection] ${canonicalPlatform} 查找合集入口（标签=${config.labelTexts.join(
      "/"
    )}，入口=${config.entryTexts.join("/")}）`
  );

  // ---------- 第 1 步：定位并打开合集选择入口 ----------
  let openResult = null;
  const entryDeadline = Date.now() + Math.max(0, timeouts.entryTimeoutMs);
  do {
    try {
      openResult = await page.evaluate(openCollectionEntryInDom, {
        config,
        token,
        forbiddenActionTexts: FORBIDDEN_ENTRY_ACTION_TEXTS,
      });
    } catch (evalErr) {
      openResult = {
        ok: false,
        reason: "evaluate_error",
        error: (evalErr && evalErr.message) || String(evalErr),
      };
    }
    if (openResult && openResult.ok) break;
    if (Date.now() < entryDeadline) {
      await waitMs(page, timeouts.pollIntervalMs);
    }
  } while (Date.now() < entryDeadline);

  if (!openResult || !openResult.ok) {
    const entrySummary = formatEntryLookupSummary(
      openResult && openResult.diagnostics
    );
    const isEntryDisabled =
      openResult && openResult.reason === "entry_disabled";
    const reasonText =
      openResult && openResult.reason === "shadow_root_not_found"
        ? "未穿透 wujie 影子树（shadowRoot 不存在）"
        : isEntryDisabled
        ? "合集选择入口处于禁用状态（disabled）"
        : openResult && openResult.error
        ? `页面脚本异常：${openResult.error}`
        : "页面未找到合集选择入口";
    const msg = `${canonicalPlatform}选择合集「${targetName}」失败：${reasonText}；入口查找：${entrySummary}；页面候选合集（最多${COLLECTION_CANDIDATE_LIMIT}个）：（未打开入口，无候选）`;
    await failWithScreenshot(
      isEntryDisabled
        ? "collection_entry_disabled"
        : "collection_entry_not_found",
      msg,
      {
        targetName,
        entryLookup: (openResult && openResult.diagnostics) || null,
        candidates: [],
      }
    );
  }

  const entryInfoText = `策略=${openResult.strategy}${
    openResult.matchedLabel ? `，标签=「${openResult.matchedLabel}」` : ""
  }，入口文案=「${openResult.entryText || ""}」`;
  console.log(
    `[collection] ${canonicalPlatform} 已打开合集入口（${entryInfoText}）`
  );

  try {
    await waitMs(page, timeouts.afterOpenDelayMs);

    // ---------- 第 2 步：在展开的列表/弹窗中精确匹配并点击目标合集 ----------
    let pickResult = null;
    const optionDeadline = Date.now() + Math.max(0, timeouts.optionTimeoutMs);
    do {
      try {
        pickResult = await page.evaluate(selectCollectionOptionInDom, {
          config,
          targetName,
          token,
          candidateLimit: COLLECTION_CANDIDATE_LIMIT,
        });
      } catch (evalErr) {
        pickResult = {
          ok: false,
          reason: "evaluate_error",
          error: (evalErr && evalErr.message) || String(evalErr),
          candidates: [],
        };
      }
      if (pickResult && pickResult.ok) break;
      // 弹层已出现且已渲染出候选项但无同名项 / 选项被禁用：属确定性结果，无需空转等待
      if (
        pickResult &&
        (pickResult.reason === "option_not_found" ||
          pickResult.reason === "option_disabled")
      ) {
        break;
      }
      if (Date.now() < optionDeadline) {
        await waitMs(page, timeouts.pollIntervalMs);
      }
    } while (Date.now() < optionDeadline);

    const candidateNames = formatCollectionCandidates(
      pickResult && pickResult.candidates,
      COLLECTION_CANDIDATE_LIMIT
    );
    const candidateSummary = formatCandidateListSummary(candidateNames);

    if (!pickResult || !pickResult.ok) {
      const reasonDesc =
        pickResult && pickResult.reason === "popup_not_found"
          ? "点击入口后未检测到合集列表弹层"
          : pickResult && pickResult.reason === "options_empty"
          ? "合集列表已打开但未读取到任何合集项"
          : pickResult && pickResult.reason === "option_disabled"
          ? `合集「${targetName}」处于不可选状态`
          : `未找到名称完全匹配的合集「${targetName}」`;
      const msg = `${canonicalPlatform}选择合集「${targetName}」失败：${reasonDesc}；入口查找：已打开（${entryInfoText}）；页面候选合集（最多${COLLECTION_CANDIDATE_LIMIT}个）：${candidateSummary}`;
      await failWithScreenshot("collection_option_not_found", msg, {
        targetName,
        entryLookup: openResult,
        reason: (pickResult && pickResult.reason) || "option_not_found",
        candidates: candidateNames,
      });
    }

    console.log(
      `[collection] ${canonicalPlatform} 已点击匹配合集：「${pickResult.matchedName}」（候选=${candidateNames.length}个：[${candidateSummary}]）`
    );

    // 若平台以弹窗呈现合集选择，点击可选的「确定/确认/完成」按钮
    if (pickResult.inModal) {
      await waitMs(page, Math.min(250, timeouts.afterSelectDelayMs));
      const confirmed = await page
        .evaluate(clickCollectionModalConfirmInDom, { config })
        .catch(() => null);
      if (confirmed && confirmed.clicked) {
        console.log(
          `[collection] ${canonicalPlatform} 已点击合集弹窗确认按钮：「${confirmed.label}」`
        );
      }
    }

    await waitMs(page, timeouts.afterSelectDelayMs);

    // ---------- 第 3 步：严格回读校验（去空白后完全等于目标名或控件内已选标签恰为目标名，排除占位文案） ----------
    let readbackResult = null;
    let lastDisplayed = "";
    const readbackDeadline =
      Date.now() + Math.max(0, timeouts.readbackTimeoutMs);
    do {
      try {
        readbackResult = await page.evaluate(readSelectedCollectionInDom, {
          config,
          token,
          placeholders: COLLECTION_PLACEHOLDER_TEXTS,
        });
      } catch (evalErr) {
        readbackResult = {
          ok: false,
          reason: "evaluate_error",
          displayedText: "",
          selectedTexts: [],
          isPlaceholder: false,
        };
      }
      lastDisplayed = String(
        (readbackResult && readbackResult.displayedText) || ""
      ).trim();
      if (
        readbackResult &&
        readbackResult.ok &&
        matchesCollectionReadback(readbackResult, targetName, {
          placeholders: config.entryTexts,
        })
      ) {
        const matchedDisplay =
          (Array.isArray(readbackResult.selectedTexts) &&
            readbackResult.selectedTexts.find((t) =>
              matchesCollectionReadback(t, targetName, {
                placeholders: config.entryTexts,
              })
            )) ||
          lastDisplayed;
        console.log(
          `[collection] ${canonicalPlatform} 回读校验通过：控件显示=「${matchedDisplay}」，目标=「${targetName}」（来源=${readbackResult.readbackSource || "entry"}）`
        );
        return {
          skipped: false,
          selected: true,
          name: targetName,
          displayedText: matchedDisplay,
          candidates: candidateNames,
        };
      }
      if (Date.now() < readbackDeadline) {
        await waitMs(page, timeouts.pollIntervalMs);
      }
    } while (Date.now() < readbackDeadline);

    const msg = `${canonicalPlatform}选择合集「${targetName}」失败：回读不符，控件显示=「${
      lastDisplayed || "（空）"
    }」与目标合集名不匹配；入口查找：已打开（${entryInfoText}）；页面候选合集（最多${COLLECTION_CANDIDATE_LIMIT}个）：${candidateSummary}`;
    await failWithScreenshot("collection_readback_mismatch", msg, {
      targetName,
      displayedText: lastDisplayed,
      entryLookup: openResult,
      candidates: candidateNames,
    });
  } finally {
    await page
      .evaluate(cleanupCollectionMarkersInDom, { config, token })
      .catch(() => {});
  }
}
