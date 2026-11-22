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
      "[class*='content-']",
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

/**
 * 回读校验：控件上显示的已选文本包含目标合集名（去空白后比对）才算成功。
 * 例如控件显示「民间故事」或「已选：民间故事」均通过；「请选择合集」「都市传说」「」均不通过。
 */
export function matchesCollectionReadback(displayedText, targetName) {
  const d = normalizeCollectionMatchText(displayedText);
  const t = normalizeCollectionMatchText(targetName);
  return Boolean(d && t && d.includes(t));
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
 * 策略顺序：
 *   1. label_row：找到可见的合集表单标签（如「添加到合集」「合集」），在同行/近邻容器找交互控件；
 *   2. entry_text：直接按控件占位符/按钮可见文本（如「请选择合集」「选择合集」）定位。
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
        node.getAttribute("aria-disabled") === "true"
      ) {
        return true;
      }
      var cls = String((node.getAttribute && node.getAttribute("class")) || "");
      if (/\b(ant-select-disabled|semi-select-disabled|is-disabled)\b/.test(cls)) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  var triggerClick = function (el, useMouseSequence) {
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    if (useMouseSequence && typeof el.dispatchEvent === "function" && typeof MouseEvent === "function") {
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
  var triggerSelectors = cfg.triggerSelectors || [
    ".semi-select",
    ".ant-select-selector",
    ".ant-select",
    "[role='combobox']",
    "button",
    "[role='button']",
  ];

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

  // 策略 1：按表单行标签定位同行交互控件
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

  for (var li = 0; li < labelNodes.length && !chosenTrigger; li++) {
    var lb = labelNodes[li];
    var lbText = clean(lb.innerText != null ? lb.innerText : lb.textContent);
    var container = lb.parentElement;
    for (var depth = 0; container && container !== root && container !== document.body && depth < 6; depth++) {
      var containerLen = norm(
        container.innerText != null ? container.innerText : container.textContent
      ).length;
      if (containerLen > 600) break;
      var triggers = queryList(container, triggerSelectors).filter(function (el) {
        return (
          isVisible(el) &&
          !isDisabled(el) &&
          el !== lb &&
          (typeof el.contains !== "function" || !el.contains(lb))
        );
      });
      if (triggers.length > 0) {
        // 优先选带合集占位文案或语义下拉的触发器
        var preferred =
          triggers.find(function (el) {
            var txt = norm(el.innerText != null ? el.innerText : el.textContent);
            var ph = norm(
              typeof el.getAttribute === "function" ? el.getAttribute("placeholder") : ""
            );
            return matchEntryText(txt) || matchEntryText(ph);
          }) || triggers[0];
        chosenTrigger = preferred;
        chosenRow = container;
        strategy = "label_row";
        matchedLabel = lbText;
        break;
      }
      container = container.parentElement;
    }
  }

  // 策略 2：直接按控件可见文案/placeholder 定位
  if (!chosenTrigger) {
    var directTriggers = queryList(root, triggerSelectors).filter(function (el) {
      if (!isVisible(el) || isDisabled(el)) return false;
      var txt = norm(el.innerText != null ? el.innerText : el.textContent);
      var ph = norm(
        typeof el.getAttribute === "function" ? el.getAttribute("placeholder") : ""
      );
      return matchEntryText(txt) || matchEntryText(ph);
    });
    if (directTriggers.length > 0) {
      chosenTrigger = directTriggers[0];
      chosenRow = chosenTrigger.parentElement || chosenTrigger;
      strategy = "entry_trigger";
    }
  }

  // 策略 3：任意可见叶节点文本命中入口文案（兼容无标准 role/class 的自定义组件）
  if (!chosenTrigger) {
    var textLeaves = allEls.filter(function (el) {
      if (isDisabled(el)) return false;
      var txt = norm(el.innerText != null ? el.innerText : el.textContent);
      if (!matchEntryText(txt)) return false;
      var kids = el.children ? Array.from(el.children) : [];
      for (var k = 0; k < kids.length; k++) {
        if (
          isVisible(kids[k]) &&
          matchEntryText(
            norm(kids[k].innerText != null ? kids[k].innerText : kids[k].textContent)
          )
        ) {
          return false;
        }
      }
      return true;
    });
    if (textLeaves.length > 0) {
      chosenTrigger = textLeaves[0];
      chosenRow = chosenTrigger.parentElement || chosenTrigger;
      strategy = "entry_text_leaf";
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
      reason: "entry_not_found",
      diagnostics: {
        useShadowRoot: Boolean(cfg.useShadowRoot),
        shadowHost: cfg.shadowHostSelector || "",
        shadowFound: shadowFound,
        triedLabels: cfg.labelTexts || [],
        triedEntries: cfg.entryTexts || [],
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
 * 浏览器端：回读合集控件当前显示的已选文本（排除仍展开的弹层/下拉节点）。
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

  var entryEl = token
    ? root.querySelector('[data-mm-collection-entry="' + token + '"]')
    : null;
  var rowEl = token
    ? root.querySelector('[data-mm-collection-row="' + token + '"]')
    : null;

  // 若组件重渲染导致临时标记丢失，按行标签重新定位只读容器（不点击）
  if (!entryEl && !rowEl) {
    var labelTexts = (cfg.labelTexts || []).map(norm).filter(Boolean);
    var allEls = [];
    try {
      allEls = Array.from(root.querySelectorAll("*")).filter(isVisible);
    } catch (_) {
      allEls = [];
    }
    var lb = allEls.find(function (el) {
      var t = norm(el.innerText != null ? el.innerText : el.textContent).replace(
        /[:：*＊]+$/g,
        ""
      );
      return labelTexts.indexOf(t) !== -1;
    });
    if (lb && lb.parentElement) {
      rowEl = lb.parentElement;
    }
  }

  var readbackSelectors = cfg.readbackSelectors || [];
  var scopes = [entryEl, rowEl].filter(Boolean);
  for (var si = 0; si < scopes.length; si++) {
    var scope = scopes[si];
    for (var ri = 0; ri < readbackSelectors.length; ri++) {
      var nodes = [];
      try {
        nodes = Array.from(scope.querySelectorAll(readbackSelectors[ri]));
      } catch (_) {
        nodes = [];
      }
      for (var ni = 0; ni < nodes.length; ni++) {
        var n = nodes[ni];
        if (!isVisible(n) || isInsidePopup(n)) continue;
        var txt = clean(n.innerText != null ? n.innerText : n.textContent);
        if (txt) {
          return {
            ok: true,
            displayedText: txt,
            readbackSource: readbackSelectors[ri],
          };
        }
      }
    }
  }

  if (entryEl && isVisible(entryEl) && !isInsidePopup(entryEl)) {
    var entryText = clean(
      entryEl.innerText != null ? entryEl.innerText : entryEl.textContent
    );
    return { ok: true, displayedText: entryText, readbackSource: "entry" };
  }
  if (rowEl && isVisible(rowEl) && !isInsidePopup(rowEl)) {
    var rowText = clean(
      rowEl.innerText != null ? rowEl.innerText : rowEl.textContent
    );
    return { ok: true, displayedText: rowText, readbackSource: "row" };
  }
  return { ok: false, reason: "readback_target_missing", displayedText: "" };
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
    const reasonText =
      openResult && openResult.reason === "shadow_root_not_found"
        ? "未穿透 wujie 影子树（shadowRoot 不存在）"
        : openResult && openResult.error
        ? `页面脚本异常：${openResult.error}`
        : "页面未找到合集选择入口";
    const msg = `${canonicalPlatform}选择合集「${targetName}」失败：${reasonText}；入口查找：${entrySummary}；页面候选合集（最多${COLLECTION_CANDIDATE_LIMIT}个）：（未打开入口，无候选）`;
    await failWithScreenshot("collection_entry_not_found", msg, {
      targetName,
      entryLookup: (openResult && openResult.diagnostics) || null,
      candidates: [],
    });
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

    // ---------- 第 3 步：回读校验（控件上显示的已选文本必须包含目标合集名） ----------
    let readbackResult = null;
    let lastDisplayed = "";
    const readbackDeadline =
      Date.now() + Math.max(0, timeouts.readbackTimeoutMs);
    do {
      try {
        readbackResult = await page.evaluate(readSelectedCollectionInDom, {
          config,
          token,
        });
      } catch (evalErr) {
        readbackResult = {
          ok: false,
          reason: "evaluate_error",
          displayedText: "",
        };
      }
      lastDisplayed = String(
        (readbackResult && readbackResult.displayedText) || ""
      ).trim();
      if (
        readbackResult &&
        readbackResult.ok &&
        matchesCollectionReadback(lastDisplayed, targetName)
      ) {
        console.log(
          `[collection] ${canonicalPlatform} 回读校验通过：控件显示=「${lastDisplayed}」，目标=「${targetName}」（来源=${readbackResult.readbackSource || "entry"}）`
        );
        return {
          skipped: false,
          selected: true,
          name: targetName,
          displayedText: lastDisplayed,
          candidates: candidateNames,
        };
      }
      if (Date.now() < readbackDeadline) {
        await waitMs(page, timeouts.pollIntervalMs);
      }
    } while (Date.now() < readbackDeadline);

    const msg = `${canonicalPlatform}选择合集「${targetName}」失败：回读不符，控件显示=「${
      lastDisplayed || "（空）"
    }」不含目标合集名；入口查找：已打开（${entryInfoText}）；页面候选合集（最多${COLLECTION_CANDIDATE_LIMIT}个）：${candidateSummary}`;
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
