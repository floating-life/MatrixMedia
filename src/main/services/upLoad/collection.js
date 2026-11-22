"use strict";

/**
 * 发布时选择合集（抖音 / 快手 / 视频号）公共自动化模块 + 平台配置常量。
 *
 * 设计约束：
 * 1. 各平台入口文案、触发器选择器、弹层/选项选择器、回读选择器集中在
 *    `PLATFORM_COLLECTION_CONFIGS` 常量中，便于真机采集 DOM 证据后直接校准。
 * 2. 视频号（sph）发布页跑在 `wujie-app.wujie_iframe` 的 shadowRoot 里，
 *    参考 sphSeries.js / sphEntityLink.js 的 shadowRoot 穿透方式，全流程
 *    在 evaluate 内实时查询并交互（避免 wujie 重渲染导致 ElementHandle 失效）。
 * 3. 快手（ks）为 Ant Design，下拉触发与选项交互需派发完整鼠标事件序列。
 * 4. 模块内所有 DOM 触发操作统一经唯一安全出口 `safeClick(el)` 执行，
 *    拒绝一切提交/存草稿类元素及其 8 层祖先链命中项，防止误触发发布或存草稿。
 * 5. 所有传入 `page.evaluate` 的浏览器端函数必须完全自包含，不得引用模块作用域闭包变量。
 * 6. 找不到入口 / 找不到同名合集 / 回读不符 / 命中提交按钮红线均抛确定性错误（deterministic=true），
 *    带候选合集名（最多 10 个）与入口查找详情，并调用 failureScreenshot 留证，
 *    上层中止发布且不重试。
 */

import {
  ALL_PLATFORM_SUBMIT_SELECTORS,
  PLATFORM_SUBMIT_SELECTORS,
  collapseCollectionText,
  normalizeCollectionName,
} from "../../../shared/collectionShared.js";
import {
  getCollectionCanonicalPlatform,
  getCollectionPlatformKey,
  resolveCollectionOption,
} from "../../../shared/videoLink.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";

export { PLATFORM_SUBMIT_SELECTORS, ALL_PLATFORM_SUBMIT_SELECTORS };

export const COLLECTION_CANDIDATE_LIMIT = 10;

export const COLLECTION_CLICK_REJECTED_MESSAGE =
  "合集操作被拒：目标疑似提交按钮";

/**
 * 提交类可访问名精确词表（安全红线，仅做去空白后的完全相等比对，绝不用包含匹配，
 * 避免误伤「校园发布会」等合法合集名或已选显示值）。
 */
export const SUBMIT_BUTTON_EXACT_TEXTS = [
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

/** 兼容导出名，指向同一精确提交词表 */
export const FORBIDDEN_ENTRY_ACTION_TEXTS = SUBMIT_BUTTON_EXACT_TEXTS;

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
      "[class*='form-row']",
      "[class*='setting-row']",
      "[class*='field']",
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
      "[class*='form-field']",
      "[class*='form-row']",
      "[class*='field']",
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
      "[class*='form-field']",
      "[class*='form-row']",
      "[class*='field']",
    ],
    triggerSelectors: [
      ".post-album-display",
      ".album-select",
      ".select-display",
      ".ant-select-selector",
      ".ant-select",
      ".weui-desktop-form__dropdown",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
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

/** 归一化合集名称文本（去除全部空白），与排期冲突比较共享单一来源 collapseCollectionText */
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
    COLLECTION_PLACEHOLDER_TEXTS.map((p) =>
      normalizeCollectionMatchText(p)
    ).filter(Boolean)
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
 * - 任何占位/未选入口文案（含内嵌 span 拼接后的「请选择合集」等全集）一律视为未选，返回 false；
 * - 否则必须去空白后与目标合集名完全相等（目标名本身恰为「合集」时同样适用）。
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
    if (displayedOrResult.isPlaceholder === true) return false;
    if (
      Array.isArray(displayedOrResult.selectedTexts) &&
      displayedOrResult.selectedTexts.length > 0
    ) {
      return displayedOrResult.selectedTexts.some(isExactNonPlaceholder);
    }
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

function isClickRejectedError(err) {
  const msg = String((err && err.message) || err || "");
  return (
    (err && err.code === "collection_click_rejected") ||
    msg.includes(COLLECTION_CLICK_REJECTED_MESSAGE)
  );
}

/* ------------------------------------------------------------------ *
 * 浏览器端自包含动作分发器（page.evaluate 序列化执行，严禁引用模块闭包）
 * 模块内唯一交互出口 `safeClick` 集中定义于此，所有入口/选项/弹窗确认均经它执行。
 * ------------------------------------------------------------------ */

export function runCollectionDomAction(payload) {
  var action = String((payload && payload.action) || "");
  var cfg = (payload && payload.config) || {};
  var token = String((payload && payload.token) || "");
  var rejectedMessage = String(
    (payload && payload.rejectedMessage) || "合集操作被拒：目标疑似提交按钮"
  );
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

  var submitTextSet = {};
  for (var sti = 0; sti < submitTextsRaw.length; sti++) {
    var stNorm = norm(submitTextsRaw[sti]);
    if (stNorm) submitTextSet[stNorm] = true;
  }

  var docRef = typeof document !== "undefined" ? document : null;
  var root = (payload && payload.root) || docRef;
  var shadowFound = true;
  if (action !== "safe_click" && cfg.useShadowRoot) {
    var host = docRef
      ? docRef.querySelector(cfg.shadowHostSelector || "wujie-app.wujie_iframe")
      : null;
    root = host && host.shadowRoot ? host.shadowRoot : null;
    shadowFound = Boolean(root);
    if (!root) {
      if (action === "open_entry") {
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
      if (action === "select_option") {
        return {
          ok: false,
          reason: "shadow_root_not_found",
          popupFound: false,
          candidates: [],
        };
      }
      return { ok: false, confirmed: false };
    }
  }

  var resolveRootForNode = function (el) {
    if (root) return root;
    if (el && typeof el.getRootNode === "function") {
      try {
        var rn = el.getRootNode();
        if (rn) return rn;
      } catch (_) {}
    }
    var cur = el;
    while (cur && cur.parentElement) cur = cur.parentElement;
    return cur || docRef;
  };

  var resolveById = function (id, scopeRoot) {
    if (!id) return null;
    var roots = [];
    if (scopeRoot) roots.push(scopeRoot);
    if (docRef && roots.indexOf(docRef) === -1) roots.push(docRef);
    var escaped = String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    for (var ri = 0; ri < roots.length; ri++) {
      var r = roots[ri];
      if (!r) continue;
      if (typeof r.getElementById === "function") {
        try {
          var byId = r.getElementById(id);
          if (byId) return byId;
        } catch (_) {}
      }
      if (typeof r.querySelector === "function") {
        try {
          var q = r.querySelector('[id="' + escaped + '"]');
          if (q) return q;
        } catch (_) {}
      }
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

  var isAccessibleNameExactSubmit = function (node, scopeRoot) {
    if (!node || node.nodeType !== 1) return false;
    var parts = [];
    var textNorm = norm(getText(node));
    if (textNorm) parts.push(textNorm);

    var valueNorm = "";
    if (typeof node.getAttribute === "function") {
      var ariaLabelNorm = norm(node.getAttribute("aria-label"));
      if (ariaLabelNorm) parts.push(ariaLabelNorm);

      var labelledByRaw = String(node.getAttribute("aria-labelledby") || "").trim();
      if (labelledByRaw) {
        var ids = labelledByRaw.split(/\s+/).filter(Boolean);
        var lbPieces = [];
        for (var li = 0; li < ids.length; li++) {
          var refEl = resolveById(ids[li], scopeRoot);
          if (refEl) {
            var refText = norm(getText(refEl));
            if (refText) lbPieces.push(refText);
          }
        }
        var labelledByNorm = lbPieces.join("");
        if (labelledByNorm) parts.push(labelledByNorm);
      }

      var titleNorm = norm(node.getAttribute("title"));
      if (titleNorm) parts.push(titleNorm);

      var attrVal = node.getAttribute("value");
      if (attrVal != null) {
        valueNorm = norm(attrVal);
      }
    }
    if (!valueNorm && typeof node.value === "string") {
      valueNorm = norm(node.value);
    }
    if (valueNorm) parts.push(valueNorm);

    if (parts.length === 0) return false;

    for (var pi = 0; pi < parts.length; pi++) {
      if (submitTextSet[parts[pi]]) return true;
    }
    var uniqueJoined = "";
    var seen = {};
    for (var ui = 0; ui < parts.length; ui++) {
      if (!seen[parts[ui]]) {
        seen[parts[ui]] = true;
        uniqueJoined += parts[ui];
      }
    }
    if (uniqueJoined && submitTextSet[uniqueJoined]) return true;

    var rawJoined = parts.join("");
    if (rawJoined && submitTextSet[rawJoined]) return true;

    return false;
  };

  var isExplicitSubmitControl = function (node) {
    if (!node || node.nodeType !== 1) return false;
    var tag = String(node.tagName || "").toUpperCase();
    if (tag !== "BUTTON" && tag !== "INPUT") return false;
    var explicitType = String(
      (typeof node.getAttribute === "function" && node.getAttribute("type")) ||
        ""
    )
      .trim()
      .toLowerCase();
    return explicitType === "submit" || explicitType === "reset";
  };

  var getSubmitRejectionReason = function (el) {
    if (!el) return "empty_target";
    var scopeRoot = resolveRootForNode(el);
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
        if (isExplicitSubmitControl(node)) {
          return "submit_control_depth_" + depth;
        }
        if (isAccessibleNameExactSubmit(node, scopeRoot)) {
          return "submit_accessible_name_depth_" + depth;
        }
      }
      if (node === scopeRoot) break;
      node = node.parentElement;
    }
    return "";
  };

  // 模块唯一 DOM 触发出口：全部入口打开、选项选中、弹窗确认均经过 safeClick
  function safeClick(el, clickOpts) {
    var rejectReason = getSubmitRejectionReason(el);
    if (rejectReason) {
      var rejectErr = new Error(rejectedMessage);
      rejectErr.code = "collection_click_rejected";
      rejectErr.deterministic = true;
      rejectErr.isCollectionError = true;
      rejectErr.rejectReason = rejectReason;
      throw rejectErr;
    }
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    var useMouseSequence = Boolean(clickOpts && clickOpts.useMouseSequence);
    if (
      useMouseSequence &&
      typeof el.dispatchEvent === "function" &&
      typeof MouseEvent === "function"
    ) {
      var rect =
        typeof el.getBoundingClientRect === "function"
          ? el.getBoundingClientRect()
          : { left: 0, top: 0, width: 0, height: 0 };
      var evOpts = {
        bubbles: true,
        cancelable: true,
        view: typeof window !== "undefined" ? window : undefined,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        button: 0,
      };
      el.dispatchEvent(new MouseEvent("mousedown", evOpts));
      el.dispatchEvent(new MouseEvent("mouseup", evOpts));
      el.dispatchEvent(new MouseEvent("click", evOpts));
      return true;
    }
    if (typeof el.click === "function") {
      el.click();
      return true;
    }
    return false;
  }

  if (action === "safe_click") {
    return safeClick(payload.el, payload.options || {});
  }

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

  var queryList = function (container, selectors) {
    var out = [];
    if (!container || typeof container.querySelectorAll !== "function") {
      return out;
    }
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

  /* -------------------- action: open_entry -------------------- */
  if (action === "open_entry") {
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
        var cls = String(
          (node.getAttribute && node.getAttribute("class")) || ""
        );
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

    var labelTexts = (cfg.labelTexts || []).map(norm).filter(Boolean);
    var entryTexts = (cfg.entryTexts || []).map(norm).filter(Boolean);
    var rowContainerSelectors = cfg.rowContainerSelectors || [
      "[class*='collection']",
      "[class*='album']",
      "[class*='form-item']",
      "[class*='setting-item']",
      "[class*='form-field']",
      "[class*='form-row']",
      "[class*='setting-row']",
      "[class*='field']",
    ];
    var triggerSelectors = cfg.triggerSelectors || [
      ".semi-select",
      ".ant-select-selector",
      ".ant-select",
      "[role='combobox']",
      "[aria-haspopup='listbox']",
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

    var isInteractiveNode = function (el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = String(el.tagName || "").toUpperCase();
      if (
        tag === "BUTTON" ||
        tag === "A" ||
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA"
      ) {
        return true;
      }
      if (typeof el.getAttribute === "function") {
        var role = String(el.getAttribute("role") || "").toLowerCase();
        if (
          role === "button" ||
          role === "combobox" ||
          role === "listbox" ||
          role === "switch" ||
          role === "checkbox" ||
          role === "radio"
        ) {
          return true;
        }
        if (el.getAttribute("aria-haspopup")) return true;
      }
      return isSemanticSelect(el);
    };

    var isLabelClassNode = function (node) {
      if (!node || node.nodeType !== 1) return false;
      var cls = String((node.getAttribute && node.getAttribute("class")) || "");
      return /(?:^|[\s_-])label(?:$|[\s_-])/i.test(cls);
    };

    var isControlColumnNode = function (node) {
      if (!node || node.nodeType !== 1) return false;
      var cls = String((node.getAttribute && node.getAttribute("class")) || "");
      return /(?:^|[\s_-])(?:form-item-control|form-item-content|control)(?:$|[\s_-])/i.test(
        cls
      );
    };

    var matchesExplicitRowContainer = function (node) {
      if (!node || node.nodeType !== 1 || typeof node.matches !== "function") {
        return false;
      }
      if (isLabelClassNode(node) || isControlColumnNode(node)) return false;
      if (isInteractiveNode(node)) return false;
      return matchesAnySelector(node, rowContainerSelectors);
    };

    var isOptionalBadgeText = function (t) {
      if (!t) return true;
      return (
        /^[*＊:：·•\-—]+$/.test(t) ||
        /^[\(\（]?(?:选填|可选|必填|建议|非必填)[\)\）]?$/.test(t)
      );
    };

    var isLabelInsideInteractive = function (el) {
      var cur = el ? el.parentElement : null;
      while (cur && cur !== root && cur.nodeType === 1) {
        var tag = String(cur.tagName || "").toUpperCase();
        if (tag === "BUTTON" || tag === "A") return true;
        cur = cur.parentElement;
      }
      return false;
    };

    var containerHasOtherFormLabel = function (container, lb, lbNormText) {
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
      if (
        tag === "FORM" ||
        tag === "MAIN" ||
        tag === "BODY" ||
        tag === "HTML" ||
        tag === "BUTTON" ||
        tag === "A" ||
        tag === "INPUT" ||
        tag === "SELECT" ||
        tag === "TEXTAREA"
      ) {
        return true;
      }
      if (norm(getText(container)).length > 240) return true;
      if (typeof container.querySelectorAll !== "function") return false;

      // 1. 同容器内存在其他 <label> 或带 label 类名的表单标签
      var labelLikeNodes = queryList(container, [
        "label",
        "[class*='label']",
      ]);
      for (var li = 0; li < labelLikeNodes.length; li++) {
        var ol = labelLikeNodes[li];
        if (!isVisible(ol) || ol === lb) continue;
        if (ol.tagName !== "LABEL" && !isLabelClassNode(ol)) continue;
        if (typeof lb.contains === "function" && lb.contains(ol)) continue;
        if (typeof ol.contains === "function" && ol.contains(lb)) continue;
        if (isInteractiveNode(ol)) continue;
        var olText = norm(getText(ol)).replace(/[:：*＊]+$/g, "");
        if (olText && !isOptionalBadgeText(olText) && olText !== lbNormText) {
          return true;
        }
      }

      // 2. 同容器内包含 >= 2 个互不包含的独立行容器 → 属多行/表单级容器
      var nestedRows = queryList(container, [
        ".form-item",
        "[class*='form-item']",
        "[class*='setting-item']",
        "[class*='form-field']",
        "[class*='form-row']",
        "[class*='setting-row']",
        "[class*='field']",
      ]).filter(function (r) {
        return (
          r !== container &&
          isVisible(r) &&
          !isLabelClassNode(r) &&
          !isControlColumnNode(r) &&
          !isInteractiveNode(r)
        );
      });
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

      // 3. 结构化跨行检测（不依赖类名）：若除 lb 所在子分支外的其他子分支里，
      //    在交互控件之前出现独立的短文本标签（如 <span>同步设置</span>），视为另一表单行
      var directKids = container.children ? Array.from(container.children) : [];
      var lbBranch = null;
      for (var dki = 0; dki < directKids.length; dki++) {
        var dk = directKids[dki];
        if (dk === lb || (typeof dk.contains === "function" && dk.contains(lb))) {
          lbBranch = dk;
          break;
        }
      }
      var hasInteractiveAncestorWithin = function (node, stopEl) {
        var cur = node;
        while (cur && cur !== stopEl && cur.nodeType === 1) {
          if (isInteractiveNode(cur)) return true;
          cur = cur.parentElement;
        }
        return false;
      };
      var seenDirectOtherLabel = false;
      var seenDirectInteractiveAfterOtherLabel = false;
      for (var obi = 0; obi < directKids.length; obi++) {
        var branch = directKids[obi];
        if (!isVisible(branch) || branch === lbBranch) continue;
        if (isInteractiveNode(branch)) {
          if (seenDirectOtherLabel) {
            seenDirectInteractiveAfterOtherLabel = true;
          }
          continue;
        }
        if (!branch.children || branch.children.length === 0) {
          var bTag = String(branch.tagName || "").toUpperCase();
          if (
            bTag !== "SVG" &&
            bTag !== "PATH" &&
            bTag !== "IMG" &&
            bTag !== "I"
          ) {
            var bText = norm(getText(branch)).replace(/[:：*＊]+$/g, "");
            if (
              bText &&
              bText.length <= 18 &&
              !isOptionalBadgeText(bText) &&
              bText !== lbNormText
            ) {
              seenDirectOtherLabel = true;
            }
          }
          continue;
        }
        var branchNodes = [];
        try {
          branchNodes = Array.from(branch.querySelectorAll("*"));
        } catch (_) {
          branchNodes = [];
        }
        var seenInteractive = false;
        var foundLeadingLabel = false;
        for (var bni = 0; bni < branchNodes.length; bni++) {
          var bn = branchNodes[bni];
          if (!isVisible(bn)) continue;
          if (isInteractiveNode(bn)) {
            seenInteractive = true;
            continue;
          }
          if (seenInteractive) continue;
          if (hasInteractiveAncestorWithin(bn, branch)) continue;
          if (bn.children && bn.children.length > 0) continue;
          var bnTag = String(bn.tagName || "").toUpperCase();
          if (
            bnTag === "SVG" ||
            bnTag === "PATH" ||
            bnTag === "IMG" ||
            bnTag === "I"
          ) {
            continue;
          }
          var bnText = norm(getText(bn)).replace(/[:：*＊]+$/g, "");
          if (
            bnText &&
            bnText.length <= 18 &&
            !isOptionalBadgeText(bnText) &&
            bnText !== lbNormText
          ) {
            foundLeadingLabel = true;
          }
        }
        if (foundLeadingLabel && seenInteractive) return true;
        if (seenInteractive && seenDirectOtherLabel) {
          seenDirectInteractiveAfterOtherLabel = true;
        }
      }
      if (seenDirectOtherLabel && seenDirectInteractiveAfterOtherLabel) {
        return true;
      }

      return false;
    };

    var labelNodes = allEls.filter(function (el) {
      if (isInsidePopup(el) || isLabelInsideInteractive(el)) return false;
      var t = norm(getText(el));
      if (!matchLabelText(t)) return false;
      var kids = el.children ? Array.from(el.children) : [];
      for (var k = 0; k < kids.length; k++) {
        if (isVisible(kids[k]) && matchLabelText(norm(getText(kids[k])))) {
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
      var lbText = clean(getText(lb));
      var lbNormText = norm(lbText).replace(/[:：*＊]+$/g, "");
      var container = lb.parentElement;
      // 最多向上查找 4 层最近的行容器；行容器内不得含另一个表单标签；跨行一律不认
      for (var depth = 0; container && depth < 4; depth++) {
        if (
          container === root ||
          container === docRef ||
          (docRef &&
            (container === docRef.body || container === docRef.documentElement))
        ) {
          break;
        }
        if (containerHasOtherFormLabel(container, lb, lbNormText)) {
          break;
        }
        var isExplicitRow = matchesExplicitRowContainer(container);
        if (isLabelClassNode(container) && !isExplicitRow) {
          container = container.parentElement;
          continue;
        }

        var rowCandidates = queryList(container, triggerSelectors).filter(
          function (el) {
            if (!isVisible(el) || isInsidePopup(el)) return false;
            if (el === lb) return false;
            if (typeof el.contains === "function" && el.contains(lb)) {
              return false;
            }
            if (getSubmitRejectionReason(el)) return false;
            if (isSemanticSelect(el)) return true;
            var txt = norm(getText(el));
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
          }
        );

        if (rowCandidates.length > 0) {
          var enabledTriggers = rowCandidates.filter(function (el) {
            return !isDisabled(el);
          });
          if (enabledTriggers.length > 0) {
            var preferred =
              enabledTriggers.find(function (el) {
                var txt = norm(getText(el));
                var ph = norm(
                  typeof el.getAttribute === "function"
                    ? el.getAttribute("placeholder")
                    : ""
                );
                return matchEntryText(txt) || matchEntryText(ph);
              }) ||
              enabledTriggers.find(isSemanticSelect) ||
              enabledTriggers[0];
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

        // 已抵达最近的行容器仍无合法入口：立刻停止，绝不越界到外层多行容器
        if (isExplicitRow) {
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
        var tClean = clean(getText(node));
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
            ? clean(getText(disabledCandidate)).slice(0, 60)
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

    var entryText = clean(getText(chosenTrigger)).slice(0, 60);
    safeClick(chosenTrigger, {
      useMouseSequence: Boolean(cfg.dispatchMouseDown),
    });

    return {
      ok: true,
      strategy: strategy,
      matchedLabel: matchedLabel,
      entryText: entryText,
      shadowFound: shadowFound,
    };
  }

  /* -------------------- action: select_option -------------------- */
  if (action === "select_option") {
    var targetName = String((payload && payload.targetName) || "");
    var candidateLimit = Number((payload && payload.candidateLimit) || 10);
    var targetNorm = norm(targetName);

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

    var entryEl = token
      ? root.querySelector('[data-mm-collection-entry="' + token + '"]')
      : null;

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
          var linked = resolveById(ids[ib], root);
          if (linked && !isVisible(linked) && linked.parentElement) {
            var p = linked.parentElement;
            for (var d = 0; p && !isVisible(p) && d < 3; d++) {
              p = p.parentElement;
            }
            if (p) linked = p;
          }
          if (linked && isVisible(linked) && popups.indexOf(linked) === -1) {
            popups.push(linked);
          }
        }
      }
    }

    var foundPopups = queryList(root, cfg.popupSelectors || []).filter(
      isVisible
    );
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
        var attrLabel = clean(
          opt.getAttribute("label") || opt.getAttribute("title") || ""
        );
        if (attrLabel) return attrLabel;
      }
      for (var ti = 0; ti < optionTextSelectors.length; ti++) {
        try {
          var sub = opt.querySelector(optionTextSelectors[ti]);
          if (sub && isVisible(sub)) {
            var subText = clean(getText(sub));
            if (subText) return subText;
          }
        } catch (_) {}
      }
      return clean(getText(opt));
    };

    var candidates = [];
    var seenCand = {};
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
        if (!seenCand[key]) {
          seenCand[key] = true;
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

    safeClick(matchedOption, {
      useMouseSequence: Boolean(cfg.dispatchMouseDown),
    });

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

  /* -------------------- action: confirm_modal -------------------- */
  if (action === "confirm_modal") {
    var confirmLabels = (cfg.confirmButtonLabels || ["确定", "确认", "完成"]).map(
      function (s) {
        return norm(s);
      }
    );
    var modals = Array.from(
      root.querySelectorAll(
        ".semi-modal, .ant-modal-content, .weui-desktop-dialog, [role='dialog']"
      )
    ).filter(isVisible);
    if (!modals.length) return { ok: true, confirmed: false };
    var modal = modals[modals.length - 1];
    var btns = Array.from(
      modal.querySelectorAll("button, .weui-desktop-btn, [role='button']")
    ).filter(isVisible);
    for (var ci = 0; ci < confirmLabels.length; ci++) {
      var targetBtn = btns.find(function (b) {
        return norm(getText(b)) === confirmLabels[ci] && !b.disabled;
      });
      if (targetBtn) {
        safeClick(targetBtn, { useMouseSequence: false });
        return { ok: true, confirmed: true, label: confirmLabels[ci] };
      }
    }
    return { ok: true, confirmed: false };
  }

  return { ok: false, reason: "unknown_action" };
}

/** 模块唯一对外交互出口（委托给 runCollectionDomAction 内的 safeClick 实现） */
export function safeClick(el, options = {}) {
  return runCollectionDomAction({
    action: "safe_click",
    el,
    options,
    root: options && options.root ? options.root : null,
    submitSelectors:
      (options && options.submitSelectors) || ALL_PLATFORM_SUBMIT_SELECTORS,
    submitTexts: (options && options.submitTexts) || SUBMIT_BUTTON_EXACT_TEXTS,
    rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
  });
}

/** 浏览器端：查找合集入口控件并经 safeClick 打开 */
export function openCollectionEntryInDom(payload) {
  return runCollectionDomAction({
    ...(payload || {}),
    action: "open_entry",
    submitSelectors:
      (payload && payload.submitSelectors) || ALL_PLATFORM_SUBMIT_SELECTORS,
    submitTexts: (payload && payload.submitTexts) || SUBMIT_BUTTON_EXACT_TEXTS,
    rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
  });
}

/** 浏览器端：扫描已打开的合集弹层并经 safeClick 选中同名合集 */
export function selectCollectionOptionInDom(payload) {
  return runCollectionDomAction({
    ...(payload || {}),
    action: "select_option",
    submitSelectors:
      (payload && payload.submitSelectors) || ALL_PLATFORM_SUBMIT_SELECTORS,
    submitTexts: (payload && payload.submitTexts) || SUBMIT_BUTTON_EXACT_TEXTS,
    rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
  });
}

/** 浏览器端：若合集选择在弹窗内完成且存在确认按钮，经 safeClick 确认 */
export function clickCollectionModalConfirmInDom(payload) {
  return runCollectionDomAction({
    ...(payload || {}),
    action: "confirm_modal",
    submitSelectors:
      (payload && payload.submitSelectors) || ALL_PLATFORM_SUBMIT_SELECTORS,
    submitTexts: (payload && payload.submitTexts) || SUBMIT_BUTTON_EXACT_TEXTS,
    rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
  });
}

/**
 * 浏览器端（只读）：回读合集控件当前显示的已选文本。
 * - 先取控件整体 textContent（去空白），若属于占位/入口文案全集（含带内嵌 span 的
 *   「请选择<span>合集</span>」拼接后为「请选择合集」）直接视为未选，不再拆叶节点；
 * - 否则仅收集 readbackSelectors 节点（排除自身或祖先含 placeholder 类的节点）与控件完整文本，
 *   由调用方做严格完全相等比对（目标名本身恰为「合集」时同样适用）。
 */
export function readSelectedCollectionInDom(payload) {
  var cfg = (payload && payload.config) || {};
  var token = String((payload && payload.token) || "");
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

  var isInsidePlaceholderNode = function (el, stopNode) {
    var cur = el;
    while (cur && cur !== root && cur.nodeType === 1) {
      if (typeof cur.getAttribute === "function") {
        var cls = String(cur.getAttribute("class") || "");
        if (/(?:^|[\s_-])placeholder(?:$|[\s_-])/i.test(cls)) return true;
      }
      if (cur === stopNode) break;
      cur = cur.parentElement;
    }
    return false;
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

  var rowLabelEl = null;
  if (!entryEl && !rowEl) {
    var allEls = [];
    try {
      allEls = Array.from(root.querySelectorAll("*")).filter(isVisible);
    } catch (_) {
      allEls = [];
    }
    rowLabelEl = allEls.find(function (el) {
      var t = norm(getText(el)).replace(/[:：*＊]+$/g, "");
      return labelTexts.indexOf(t) !== -1;
    });
    if (rowLabelEl && rowLabelEl.parentElement) {
      rowEl = rowLabelEl.parentElement;
    }
  }

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

  var readScope = entryEl || rowEl;
  if (readScope && isVisible(readScope) && !isInsidePopup(readScope)) {
    // 1. 先检查控件完整拼接后的 textContent（含带内嵌 span 的「请选择<span>合集</span>」）：
    //    若整体属于占位/入口文案全集，直接判为未选，绝不拆解内层 span 误认成目标名。
    var entryFullText =
      entryEl && isVisible(entryEl) && !isInsidePopup(entryEl)
        ? clean(getText(entryEl))
        : "";
    if (entryFullText && isPlaceholderText(entryFullText)) {
      return {
        ok: true,
        displayedText: entryFullText,
        selectedTexts: [],
        isPlaceholder: true,
        readbackSource: "entry_placeholder",
      };
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

    // 2. 按平台 readbackSelectors 收集可见且非占位节点（含祖先链检查）的完整文本
    for (var ri = 0; ri < readbackSelectors.length; ri++) {
      var nodes = [];
      try {
        nodes = Array.from(readScope.querySelectorAll(readbackSelectors[ri]));
      } catch (_) {
        nodes = [];
      }
      for (var ni = 0; ni < nodes.length; ni++) {
        var n = nodes[ni];
        if (
          !isVisible(n) ||
          isInsidePopup(n) ||
          isInsidePlaceholderNode(n, readScope)
        ) {
          continue;
        }
        if (!entryEl && isFormLabelNode(n)) continue;
        if (
          rowLabelEl &&
          (n === rowLabelEl ||
            (typeof n.contains === "function" && n.contains(rowLabelEl)))
        ) {
          continue;
        }
        var txt = clean(getText(n));
        if (txt) {
          pushCandidate(txt, readbackSelectors[ri]);
        }
      }
    }

    // 3. 控件完整文本（已排除占位文案，不再扫描任意内层叶 span）
    if (entryFullText && !isInsidePlaceholderNode(entryEl, readScope)) {
      pushCandidate(entryFullText, "entry");
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
    var entries = root.querySelectorAll(
      '[data-mm-collection-entry="' + token + '"]'
    );
    for (var i = 0; i < entries.length; i++) {
      entries[i].removeAttribute("data-mm-collection-entry");
    }
    var rows = root.querySelectorAll(
      '[data-mm-collection-row="' + token + '"]'
    );
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
 * - 任一步失败（入口缺失 / 同名合集缺失 / 回读不符 / 命中提交按钮保护）：
 *   先截图（复用 failureScreenshot），打 `[collection] <平台> …` 日志，
 *   再抛带 `deterministic=true`、`isCollectionError=true` 的错误中止发布。
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

  // ---------- 第 1 步：定位并经 safeClick 打开合集选择入口 ----------
  let openResult = null;
  const entryDeadline = Date.now() + Math.max(0, timeouts.entryTimeoutMs);
  do {
    try {
      openResult = await page.evaluate(runCollectionDomAction, {
        action: "open_entry",
        config,
        token,
        submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
        submitTexts: SUBMIT_BUTTON_EXACT_TEXTS,
        rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
      });
    } catch (evalErr) {
      if (isClickRejectedError(evalErr)) {
        await failWithScreenshot(
          "collection_click_rejected",
          `${canonicalPlatform}选择合集「${targetName}」失败：${COLLECTION_CLICK_REJECTED_MESSAGE}`,
          { targetName, candidates: [] }
        );
      }
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

    // ---------- 第 2 步：在展开的列表/弹窗中精确匹配并经 safeClick 选中目标合集 ----------
    let pickResult = null;
    const optionDeadline = Date.now() + Math.max(0, timeouts.optionTimeoutMs);
    do {
      try {
        pickResult = await page.evaluate(runCollectionDomAction, {
          action: "select_option",
          config,
          targetName,
          token,
          candidateLimit: COLLECTION_CANDIDATE_LIMIT,
          submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
          submitTexts: SUBMIT_BUTTON_EXACT_TEXTS,
          rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
        });
      } catch (evalErr) {
        if (isClickRejectedError(evalErr)) {
          await failWithScreenshot(
            "collection_click_rejected",
            `${canonicalPlatform}选择合集「${targetName}」失败：${COLLECTION_CLICK_REJECTED_MESSAGE}`,
            { targetName, entryLookup: openResult, candidates: [] }
          );
        }
        pickResult = {
          ok: false,
          reason: "evaluate_error",
          error: (evalErr && evalErr.message) || String(evalErr),
          candidates: [],
        };
      }
      if (pickResult && pickResult.ok) break;
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
          ? "打开入口后未检测到合集列表弹层"
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
      `[collection] ${canonicalPlatform} 已选中匹配合集：「${pickResult.matchedName}」（候选=${candidateNames.length}个：[${candidateSummary}]）`
    );

    // 若平台以弹窗呈现合集选择，经 safeClick 触发可选的「确定/确认/完成」按钮
    if (pickResult.inModal) {
      await waitMs(page, Math.min(250, timeouts.afterSelectDelayMs));
      let confirmed = null;
      try {
        confirmed = await page.evaluate(runCollectionDomAction, {
          action: "confirm_modal",
          config,
          submitSelectors: ALL_PLATFORM_SUBMIT_SELECTORS,
          submitTexts: SUBMIT_BUTTON_EXACT_TEXTS,
          rejectedMessage: COLLECTION_CLICK_REJECTED_MESSAGE,
        });
      } catch (confirmErr) {
        if (isClickRejectedError(confirmErr)) {
          await failWithScreenshot(
            "collection_click_rejected",
            `${canonicalPlatform}选择合集「${targetName}」失败：${COLLECTION_CLICK_REJECTED_MESSAGE}`,
            {
              targetName,
              entryLookup: openResult,
              candidates: candidateNames,
            }
          );
        }
        confirmed = null;
      }
      if (confirmed && confirmed.confirmed) {
        console.log(
          `[collection] ${canonicalPlatform} 已触发合集弹窗确认按钮：「${confirmed.label}」`
        );
      }
    }

    await waitMs(page, timeouts.afterSelectDelayMs);

    // ---------- 第 3 步：严格回读校验（排除占位文案全集，去空白后完全等于目标名） ----------
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
          `[collection] ${canonicalPlatform} 回读校验通过：控件显示=「${matchedDisplay}」，目标=「${targetName}」（来源=${
            readbackResult.readbackSource || "entry"
          }）`
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
