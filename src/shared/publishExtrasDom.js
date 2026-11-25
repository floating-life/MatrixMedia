"use strict";

import {
  AI_CHAPTERS_STATUS,
  ORIGINAL_STATEMENT_STATUS,
  formatAiChaptersReceipt,
  createNoOriginalQualificationError,
  createOriginalStatementError,
} from "./publishExtras.js";

/**
 * 发布扩展能力（AI 自动章节 + 原创声明）浏览器端自包含 DOM 动作函数。
 *
 * 约束（严禁违反）：
 * - 所有传入 page.evaluate 的函数必须使用纯 ES5 语法（var / function / 索引 for 循环），
 *   严禁引用模块外部闭包变量，避免 webpack/babel 注入 helper 或序列化报错。
 * - 所有选择器与候选文案由各平台适配器（dy.js / ks.js / xhs.js / sph.js）集中定义并通过 payload.cfg 传入，
 *   便于 macon 真机存草稿校准。
 * - 内置提交按钮防误点守卫（submitSelectors + submitTexts），严禁误触发布/存草稿/暂存离开/取消按钮。
 */

/**
 * AI 自动章节浏览器端动作：inspect / click_opener / click_toggle / confirm_dialog / readback / cleanup
 */
export function runAiChaptersDomAction(payload) {
  var action = String((payload && payload.action) || "");
  var token = String((payload && payload.token) || "");
  var cfg = (payload && payload.cfg) || {};
  var wujieHost = cfg.wujieHost ? String(cfg.wujieHost) : "";
  var sectionKeywords = Array.isArray(cfg.sectionKeywords)
    ? cfg.sectionKeywords
    : [];
  var aiOptionKeywords = Array.isArray(cfg.aiOptionKeywords)
    ? cfg.aiOptionKeywords
    : [];
  var entryButtonKeywords = Array.isArray(cfg.entryButtonKeywords)
    ? cfg.entryButtonKeywords
    : [];
  var unsupportedPatterns = Array.isArray(cfg.unsupportedPatterns)
    ? cfg.unsupportedPatterns
    : [];
  var toggleSelectors = Array.isArray(cfg.toggleSelectors)
    ? cfg.toggleSelectors
    : [];
  var dialogSelectors = Array.isArray(cfg.dialogSelectors)
    ? cfg.dialogSelectors
    : [];
  var confirmButtonTexts = Array.isArray(cfg.confirmButtonTexts)
    ? cfg.confirmButtonTexts
    : ["确定", "确认", "完成", "应用"];
  var submitSelectors = Array.isArray(cfg.submitSelectors)
    ? cfg.submitSelectors
    : [];
  var submitTextsRaw = Array.isArray(cfg.submitTexts)
    ? cfg.submitTexts
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
  var dispatchMouseEvents = Boolean(cfg.dispatchMouseEvents);

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
  var root = (payload && payload.root) || null;
  if (!root && docRef) {
    if (wujieHost) {
      var host = null;
      try {
        host = docRef.querySelector(wujieHost);
      } catch (_) {}
      root = host && host.shadowRoot ? host.shadowRoot : null;
    } else {
      root = docRef;
    }
  }
  if (!root) {
    return { found: false, unsupported: true, reason: "no_root" };
  }

  var submitTextSet = {};
  for (var sti = 0; sti < submitTextsRaw.length; sti++) {
    var stN = norm(submitTextsRaw[sti]);
    if (stN) submitTextSet[stN] = true;
  }

  var matchesAnyKeyword = function (text, keywords) {
    var tNorm = norm(text).toLowerCase();
    if (!tNorm) return "";
    for (var i = 0; i < keywords.length; i++) {
      var kw = norm(keywords[i]).toLowerCase();
      if (kw && tNorm.indexOf(kw) !== -1) return String(keywords[i]);
    }
    return "";
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
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
      } catch (_) {}
    }
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
          var tp = String(
            (typeof node.getAttribute === "function" &&
              node.getAttribute("type")) ||
              ""
          )
            .trim()
            .toLowerCase();
          if (tp === "submit" || tp === "reset") {
            return "submit_control_depth_" + depth;
          }
        }
        var tNorm = norm(getText(node));
        if (tNorm && submitTextSet[tNorm]) {
          return "submit_text_depth_" + depth;
        }
        if (typeof node.getAttribute === "function") {
          var al = norm(node.getAttribute("aria-label"));
          if (al && submitTextSet[al]) return "submit_aria_depth_" + depth;
        }
      }
      if (node === root) break;
      node = node.parentElement;
    }
    return "";
  };

  var isDisabledControl = function (el, innerInput) {
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
          /\b(disabled|is-disabled|semi-switch-disabled|semi-checkbox-disabled|semi-radio-disabled|ant-switch-disabled|ant-checkbox-disabled|ant-checkbox-wrapper-disabled|ant-radio-disabled|ant-radio-wrapper-disabled|d-switch-disabled|d-checkbox-disabled|d-radio-disabled)\b/.test(
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

  var hasCheckedClass = function (el) {
    if (!el) return false;
    var cls = getClass(el);
    if (!cls) return false;
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i].toLowerCase();
      if (!tk) continue;
      if (/(?:un|in|not[-_]?|non[-_]?)(?:checked|active|selected)/.test(tk)) {
        continue;
      }
      if (/(?:^|[-_])(checked|active|selected)(?:$|[-_])/.test(tk)) {
        return true;
      }
    }
    return false;
  };

  var findInnerInput = function (el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      var tp = String(
        (typeof el.getAttribute === "function" && el.getAttribute("type")) ||
          el.type ||
          ""
      ).toLowerCase();
      if (tp === "checkbox" || tp === "radio") return el;
    }
    if (typeof el.querySelector === "function") {
      try {
        return el.querySelector('input[type="checkbox"], input[type="radio"]');
      } catch (_) {}
    }
    return null;
  };

  var readCheckedState = function (stateEl, innerInput) {
    var cands = [];
    if (stateEl) cands.push(stateEl);
    if (innerInput && innerInput !== stateEl) cands.push(innerInput);
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var roleSub = stateEl.querySelector(
          "[role='switch'], [role='checkbox'], [role='radio']"
        );
        if (roleSub && cands.indexOf(roleSub) === -1) cands.push(roleSub);
      } catch (_) {}
    }
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c || typeof c.getAttribute !== "function") continue;
      var ac = c.getAttribute("aria-checked");
      if (ac === "true") return { checked: true, source: "aria-checked" };
      if (ac === "false") return { checked: false, source: "aria-checked" };
      var as = c.getAttribute("aria-selected");
      if (as === "true") return { checked: true, source: "aria-selected" };
      if (as === "false") return { checked: false, source: "aria-selected" };
    }
    var inp = innerInput || findInnerInput(stateEl);
    if (inp) {
      if (typeof inp.checked === "boolean") {
        return { checked: inp.checked, source: "input.checked" };
      }
      if (typeof inp.getAttribute === "function") {
        var ca = inp.getAttribute("checked");
        if (ca !== null && ca !== "false") {
          return { checked: true, source: "attr:checked" };
        }
      }
    }
    if (hasCheckedClass(stateEl)) {
      return { checked: true, source: "class" };
    }
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var inner = stateEl.querySelector(
          ".semi-checkbox-inner, .semi-radio-inner, .ant-checkbox, .ant-radio, .d-checkbox-simulator, .d-switch-simulator"
        );
        if (inner && hasCheckedClass(inner)) {
          return { checked: true, source: "inner-class" };
        }
      } catch (_) {}
    }
    return { checked: false, source: "default" };
  };

  var performClick = function (el) {
    if (!el) return { ok: false, reason: "missing_el" };
    var rej = getSubmitRejectionReason(el);
    if (rej) return { ok: false, submitRejected: true, rejectReason: rej };
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    if (dispatchMouseEvents && typeof el.dispatchEvent === "function") {
      try {
        var r =
          typeof el.getBoundingClientRect === "function"
            ? el.getBoundingClientRect()
            : { left: 0, top: 0, width: 10, height: 10 };
        var opts = {
          bubbles: true,
          cancelable: true,
          clientX: (r.left || 0) + (r.width || 0) / 2,
          clientY: (r.top || 0) + (r.height || 0) / 2,
          button: 0,
        };
        if (typeof MouseEvent === "function") {
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          el.dispatchEvent(new MouseEvent("click", opts));
          return { ok: true, via: "mouse_events" };
        }
      } catch (_) {}
    }
    if (typeof el.click === "function") {
      el.click();
      return { ok: true, via: "click" };
    }
    return { ok: false, reason: "no_click_method" };
  };

  var getRowContextText = function (el, maxLen) {
    var limit = maxLen || 220;
    var best = clean(getText(el));
    var node = el ? el.parentElement : null;
    for (var depth = 0; node && node !== root && depth < 4; depth++) {
      var t = clean(getText(node));
      if (t && t.length <= limit) {
        best = t;
      } else if (t && t.length > limit) {
        break;
      }
      node = node.parentElement;
    }
    return best;
  };

  var queryList = function (container, selectors) {
    var out = [];
    if (!container || typeof container.querySelectorAll !== "function") {
      return out;
    }
    for (var i = 0; i < selectors.length; i++) {
      try {
        var nl = container.querySelectorAll(selectors[i]);
        for (var j = 0; j < nl.length; j++) {
          if (out.indexOf(nl[j]) === -1) out.push(nl[j]);
        }
      } catch (_) {}
    }
    return out;
  };

  var deduplicateOuter = function (list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var nested = false;
      for (var j = 0; j < list.length; j++) {
        if (i === j) continue;
        var other = list[j];
        if (other && typeof other.contains === "function" && other.contains(el)) {
          nested = true;
          break;
        }
      }
      if (!nested) out.push(el);
    }
    return out;
  };

  var inspectChapters = function () {
    // 1. 直接匹配候选 toggle（switch / checkbox / radio / label）
    var rawToggles = queryList(root, toggleSelectors);
    var visibleToggles = [];
    for (var vi = 0; vi < rawToggles.length; vi++) {
      var vt = rawToggles[vi];
      if (!isVisible(vt)) continue;
      if (getSubmitRejectionReason(vt)) continue;
      visibleToggles.push(vt);
    }
    var toggles = deduplicateOuter(visibleToggles);

    for (var ti = 0; ti < toggles.length; ti++) {
      var tg = toggles[ti];
      var innerInp = findInnerInput(tg);
      var ctxText = getRowContextText(tg, 240);
      var aiHit = matchesAnyKeyword(ctxText, aiOptionKeywords);
      if (aiHit) {
        var st = readCheckedState(tg, innerInp);
        var dis = isDisabledControl(tg, innerInp);
        var unsupHit = matchesAnyKeyword(ctxText, unsupportedPatterns);
        if (token && typeof tg.setAttribute === "function") {
          tg.setAttribute("data-mm-ai-ch-click", token);
          tg.setAttribute("data-mm-ai-ch-state", token);
        }
        return {
          found: true,
          checked: st.checked,
          stateSource: st.source,
          disabled: dis,
          unsupported: dis || Boolean(unsupHit),
          unsupportedReason: unsupHit
            ? "页面提示不支持（" + unsupHit + "）"
            : dis
            ? "AI 章节开关处于置灰禁用状态"
            : "",
          strategy: "direct_ai_toggle",
          matchedKeyword: aiHit,
          matchedText: ctxText.slice(0, 120),
        };
      }
    }

    // 2. 在章节区块容器内查找包含 AI/智能/自动 的选项或唯一开关
    var sectionContainers = [];
    try {
      var allBlocks = root.querySelectorAll("div, section, li, form");
      for (var bi = 0; bi < allBlocks.length; bi++) {
        var blk = allBlocks[bi];
        if (!isVisible(blk)) continue;
        var bText = clean(getText(blk));
        if (!bText || bText.length > 420) continue;
        if (matchesAnyKeyword(bText, sectionKeywords)) {
          sectionContainers.push({ el: blk, text: bText });
        }
      }
    } catch (_) {}

    // 按文本长度升序，优先最贴近章节项的容器
    sectionContainers.sort(function (a, b) {
      return a.text.length - b.text.length;
    });

    for (var si = 0; si < sectionContainers.length; si++) {
      var sc = sectionContainers[si];
      var subRaw = queryList(sc.el, toggleSelectors);
      var subVis = [];
      for (var sj = 0; sj < subRaw.length; sj++) {
        if (isVisible(subRaw[sj]) && !getSubmitRejectionReason(subRaw[sj])) {
          subVis.push(subRaw[sj]);
        }
      }
      var subToggles = deduplicateOuter(subVis);
      var picked = null;
      if (subToggles.length === 1 && matchesAnyKeyword(sc.text, aiOptionKeywords)) {
        picked = subToggles[0];
      } else {
        for (var sk = 0; sk < subToggles.length; sk++) {
          var stText = getRowContextText(subToggles[sk], 160);
          if (matchesAnyKeyword(stText, aiOptionKeywords)) {
            picked = subToggles[sk];
            break;
          }
        }
      }
      if (picked) {
        var pInp = findInnerInput(picked);
        var pState = readCheckedState(picked, pInp);
        var pDis = isDisabledControl(picked, pInp);
        var pUnsup = matchesAnyKeyword(sc.text, unsupportedPatterns);
        if (token && typeof picked.setAttribute === "function") {
          picked.setAttribute("data-mm-ai-ch-click", token);
          picked.setAttribute("data-mm-ai-ch-state", token);
        }
        return {
          found: true,
          checked: pState.checked,
          stateSource: pState.source,
          disabled: pDis,
          unsupported: pDis || Boolean(pUnsup),
          unsupportedReason: pUnsup
            ? "章节区提示不支持（" + pUnsup + "）"
            : pDis
            ? "章节开关置灰不可用"
            : "",
          strategy: "section_toggle",
          matchedText: sc.text.slice(0, 120),
        };
      }
    }

    // 3. 兜底：无标准 toggle 类名的可点击选项（button / role=option / role=tab / chip / label）
    var optNodes = queryList(root, [
      "button",
      "[role='button']",
      "[role='option']",
      "[role='tab']",
      "[role='menuitem']",
      "label",
      "li",
      "div",
      "span",
    ]);
    var bestOpt = null;
    var bestOptLen = 9999;
    for (var oi = 0; oi < optNodes.length; oi++) {
      var on = optNodes[oi];
      if (!isVisible(on) || getSubmitRejectionReason(on)) continue;
      var oText = clean(getText(on));
      if (!oText || oText.length > 48) continue;
      if (!matchesAnyKeyword(oText, aiOptionKeywords)) continue;
      if (oText.length < bestOptLen) {
        bestOpt = on;
        bestOptLen = oText.length;
      }
    }
    if (bestOpt) {
      var bInp = findInnerInput(bestOpt);
      var bState = readCheckedState(bestOpt, bInp);
      var bDis = isDisabledControl(bestOpt, bInp);
      var bCtx = getRowContextText(bestOpt, 200);
      var bUnsup = matchesAnyKeyword(bCtx, unsupportedPatterns);
      if (token && typeof bestOpt.setAttribute === "function") {
        bestOpt.setAttribute("data-mm-ai-ch-click", token);
        bestOpt.setAttribute("data-mm-ai-ch-state", token);
      }
      return {
        found: true,
        checked: bState.checked,
        stateSource: bState.source,
        disabled: bDis,
        unsupported: bDis || Boolean(bUnsup),
        unsupportedReason: bUnsup
          ? "章节选项提示不支持（" + bUnsup + "）"
          : bDis
          ? "AI 章节选项置灰禁用"
          : "",
        strategy: "text_option",
        matchedText: bCtx.slice(0, 120),
      };
    }

    // 4. 章节区明确提示不支持（如短视频时长不足）
    for (var ui = 0; ui < sectionContainers.length; ui++) {
      var uHit = matchesAnyKeyword(sectionContainers[ui].text, unsupportedPatterns);
      if (uHit) {
        return {
          found: false,
          unsupported: true,
          reason: "section_unsupported:" + uHit,
          matchedText: sectionContainers[ui].text.slice(0, 120),
        };
      }
    }

    // 5. 检查是否存在折叠/入口触发按钮（如「添加章节」「设置章节」）
    if (entryButtonKeywords.length > 0) {
      var triggers = queryList(root, [
        "button",
        "[role='button']",
        "a",
        "div",
        "span",
      ]);
      var bestOpener = null;
      var bestOpenerLen = 9999;
      for (var ei = 0; ei < triggers.length; ei++) {
        var tr = triggers[ei];
        if (!isVisible(tr) || getSubmitRejectionReason(tr)) continue;
        var trText = clean(getText(tr));
        if (!trText || trText.length > 30) continue;
        if (!matchesAnyKeyword(trText, entryButtonKeywords)) continue;
        if (trText.length < bestOpenerLen) {
          bestOpener = tr;
          bestOpenerLen = trText.length;
        }
      }
      if (bestOpener) {
        if (isDisabledControl(bestOpener, null)) {
          return {
            found: false,
            unsupported: true,
            reason: "opener_disabled:" + clean(getText(bestOpener)),
          };
        }
        if (token && typeof bestOpener.setAttribute === "function") {
          bestOpener.setAttribute("data-mm-ai-ch-opener", token);
        }
        return {
          found: false,
          hasOpener: true,
          openerText: clean(getText(bestOpener)),
        };
      }
    }

    return {
      found: false,
      unsupported: true,
      reason: "entry_not_found",
    };
  };

  if (action === "cleanup") {
    if (!token) return { ok: true };
    try {
      var attrs = [
        "data-mm-ai-ch-click",
        "data-mm-ai-ch-state",
        "data-mm-ai-ch-opener",
      ];
      for (var ai = 0; ai < attrs.length; ai++) {
        var nodes = root.querySelectorAll("[" + attrs[ai] + '="' + token + '"]');
        for (var ni = 0; ni < nodes.length; ni++) {
          nodes[ni].removeAttribute(attrs[ai]);
        }
      }
    } catch (_) {}
    return { ok: true };
  }

  if (action === "inspect") {
    return inspectChapters();
  }

  if (action === "click_opener") {
    var opener = token
      ? root.querySelector('[data-mm-ai-ch-opener="' + token + '"]')
      : null;
    if (!opener) return { ok: false, reason: "opener_missing" };
    return performClick(opener);
  }

  if (action === "click_toggle") {
    var clickEl = token
      ? root.querySelector('[data-mm-ai-ch-click="' + token + '"]')
      : null;
    if (!clickEl) return { ok: false, reason: "toggle_missing" };
    return performClick(clickEl);
  }

  if (action === "confirm_dialog") {
    var dialogs = queryList(root, dialogSelectors);
    for (var di = 0; di < dialogs.length; di++) {
      var dlg = dialogs[di];
      if (!isVisible(dlg)) continue;
      var dText = clean(getText(dlg));
      if (
        !matchesAnyKeyword(dText, sectionKeywords) &&
        !matchesAnyKeyword(dText, aiOptionKeywords)
      ) {
        continue;
      }
      var btns = queryList(dlg, ["button", "[role='button']"]);
      for (var bti = 0; bti < btns.length; bti++) {
        var btn = btns[bti];
        if (!isVisible(btn) || isDisabledControl(btn, null)) continue;
        var bNorm = norm(getText(btn));
        for (var ci = 0; ci < confirmButtonTexts.length; ci++) {
          if (bNorm === norm(confirmButtonTexts[ci])) {
            var res = performClick(btn);
            return {
              dialogFound: true,
              confirmed: Boolean(res && res.ok),
              buttonText: bNorm,
            };
          }
        }
      }
      return { dialogFound: true, confirmed: false, buttonText: "" };
    }
    return { dialogFound: false, confirmed: false, buttonText: "" };
  }

  if (action === "readback") {
    var stateEl = token
      ? root.querySelector('[data-mm-ai-ch-state="' + token + '"]')
      : null;
    if (stateEl && stateEl.isConnected !== false) {
      var inp = findInnerInput(stateEl);
      var rb = readCheckedState(stateEl, inp);
      return {
        found: true,
        checked: rb.checked,
        stateSource: rb.source,
        disabled: isDisabledControl(stateEl, inp),
      };
    }
    // DOM 重渲染导致标记丢失时重新定位一次
    return inspectChapters();
  }

  return { found: false, reason: "unknown_action:" + action };
}

/**
 * 原创声明浏览器端动作：inspect / click_entry / handle_dialog / readback / cleanup
 * 支持普通 document（小红书）与 wujie shadowRoot（视频号）。
 */
export function runOriginalStatementDomAction(payload) {
  var action = String((payload && payload.action) || "");
  var token = String((payload && payload.token) || "");
  var cfg = (payload && payload.cfg) || {};
  var wujieHost = cfg.wujieHost ? String(cfg.wujieHost) : "";
  var entrySelectors = Array.isArray(cfg.entrySelectors)
    ? cfg.entrySelectors
    : [];
  var entryContainerSelectors = Array.isArray(cfg.entryContainerSelectors)
    ? cfg.entryContainerSelectors
    : [];
  var entryKeywords = Array.isArray(cfg.entryKeywords)
    ? cfg.entryKeywords
    : ["原创声明", "声明原创"];
  var toggleSelectors = Array.isArray(cfg.toggleSelectors)
    ? cfg.toggleSelectors
    : [];
  var dialogSelectors = Array.isArray(cfg.dialogSelectors)
    ? cfg.dialogSelectors
    : [];
  var dialogKeywords = Array.isArray(cfg.dialogKeywords)
    ? cfg.dialogKeywords
    : ["原创", "声明原创", "原创声明", "协议", "条款"];
  var ignoreDialogPatterns = Array.isArray(cfg.ignoreDialogPatterns)
    ? cfg.ignoreDialogPatterns
    : ["将此次编辑保留"];
  var agreementSelectors = Array.isArray(cfg.agreementSelectors)
    ? cfg.agreementSelectors
    : [".protocol-text", 'input[type="checkbox"]', "[role='checkbox']", "label"];
  var agreementKeywords = Array.isArray(cfg.agreementKeywords)
    ? cfg.agreementKeywords
    : ["我已阅读并同意", "阅读并同意", "同意", "协议", "条款", "须知"];
  var confirmButtonSelectors = Array.isArray(cfg.confirmButtonSelectors)
    ? cfg.confirmButtonSelectors
    : ["button.weui-desktop-btn_primary", "button", "[role='button']"];
  var confirmButtonTexts = Array.isArray(cfg.confirmButtonTexts)
    ? cfg.confirmButtonTexts
    : ["声明原创", "确认声明", "同意并声明", "开启原创", "确定", "确认"];
  var noQualificationPatterns = Array.isArray(cfg.noQualificationPatterns)
    ? cfg.noQualificationPatterns
    : [
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
      ];
  var submitSelectors = Array.isArray(cfg.submitSelectors)
    ? cfg.submitSelectors
    : [];
  var submitTextsRaw = Array.isArray(cfg.submitTexts)
    ? cfg.submitTexts
    : [
        "发布",
        "发表",
        "立即发布",
        "定时发布",
        "存草稿",
        "保存草稿",
        "暂存离开",
        "保存",
        "取消",
        "取消发布",
        "确认发布",
      ];
  var dispatchMouseEvents = Boolean(cfg.dispatchMouseEvents);

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
  var root = (payload && payload.root) || null;
  if (!root && docRef) {
    if (wujieHost) {
      var host = null;
      try {
        host = docRef.querySelector(wujieHost);
      } catch (_) {}
      root = host && host.shadowRoot ? host.shadowRoot : null;
    } else {
      root = docRef;
    }
  }
  if (!root) {
    return { found: false, reason: "no_root" };
  }

  var submitTextSet = {};
  for (var sti = 0; sti < submitTextsRaw.length; sti++) {
    var stN = norm(submitTextsRaw[sti]);
    if (stN) submitTextSet[stN] = true;
  }

  var matchesAnyKeyword = function (text, keywords) {
    var tNorm = norm(text).toLowerCase();
    if (!tNorm) return "";
    for (var i = 0; i < keywords.length; i++) {
      var kw = norm(keywords[i]).toLowerCase();
      if (kw && tNorm.indexOf(kw) !== -1) return String(keywords[i]);
    }
    return "";
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
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
          return false;
        }
      } catch (_) {}
    }
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

  var isInsideDialog = function (el) {
    if (!el || typeof el.closest !== "function") return false;
    for (var i = 0; i < dialogSelectors.length; i++) {
      try {
        if (el.closest(dialogSelectors[i])) return true;
      } catch (_) {}
    }
    return false;
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
        var tNorm = norm(getText(node));
        if (tNorm && submitTextSet[tNorm]) {
          return "submit_text_depth_" + depth;
        }
      }
      if (node === root) break;
      node = node.parentElement;
    }
    return "";
  };

  var isDisabledControl = function (el, innerInput) {
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
          /\b(disabled|is-disabled|ant-checkbox-disabled|ant-checkbox-wrapper-disabled|ant-switch-disabled|weui-desktop-form__checkbox_disabled|weui-desktop-btn_disabled|d-switch-disabled|d-checkbox-disabled)\b/.test(
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

  var hasCheckedClass = function (el) {
    if (!el) return false;
    var cls = getClass(el);
    if (!cls) return false;
    var tokens = cls.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tk = tokens[i].toLowerCase();
      if (!tk) continue;
      if (/(?:un|in|not[-_]?|non[-_]?)(?:checked|active|selected)/.test(tk)) {
        continue;
      }
      if (/(?:^|[-_])(checked|active|selected)(?:$|[-_])/.test(tk)) {
        return true;
      }
    }
    return false;
  };

  var findInnerInput = function (el) {
    if (!el || el.nodeType !== 1) return null;
    var tag = String(el.tagName || "").toUpperCase();
    if (tag === "INPUT") {
      var tp = String(
        (typeof el.getAttribute === "function" && el.getAttribute("type")) ||
          el.type ||
          ""
      ).toLowerCase();
      if (tp === "checkbox" || tp === "radio") return el;
    }
    if (typeof el.querySelector === "function") {
      try {
        return el.querySelector('input[type="checkbox"], input[type="radio"]');
      } catch (_) {}
    }
    return null;
  };

  var readCheckedState = function (stateEl, innerInput) {
    var cands = [];
    if (stateEl) cands.push(stateEl);
    if (innerInput && innerInput !== stateEl) cands.push(innerInput);
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var roleSub = stateEl.querySelector(
          "[role='switch'], [role='checkbox']"
        );
        if (roleSub && cands.indexOf(roleSub) === -1) cands.push(roleSub);
      } catch (_) {}
    }
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (!c || typeof c.getAttribute !== "function") continue;
      var ac = c.getAttribute("aria-checked");
      if (ac === "true") return { checked: true, source: "aria-checked" };
      if (ac === "false") return { checked: false, source: "aria-checked" };
    }
    var inp = innerInput || findInnerInput(stateEl);
    if (inp) {
      if (typeof inp.checked === "boolean") {
        return { checked: inp.checked, source: "input.checked" };
      }
      if (typeof inp.getAttribute === "function") {
        var ca = inp.getAttribute("checked");
        if (ca !== null && ca !== "false") {
          return { checked: true, source: "attr:checked" };
        }
      }
    }
    if (hasCheckedClass(stateEl)) {
      return { checked: true, source: "class" };
    }
    if (stateEl && typeof stateEl.querySelector === "function") {
      try {
        var inner = stateEl.querySelector(
          ".ant-checkbox, .d-checkbox-simulator, .d-switch-simulator"
        );
        if (inner && hasCheckedClass(inner)) {
          return { checked: true, source: "inner-class" };
        }
      } catch (_) {}
    }
    return { checked: false, source: "default" };
  };

  var performClick = function (el, skipSubmitGuard) {
    if (!el) return { ok: false, reason: "missing_el" };
    if (!skipSubmitGuard) {
      var rej = getSubmitRejectionReason(el);
      if (rej) return { ok: false, submitRejected: true, rejectReason: rej };
    }
    if (typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch (_) {}
    }
    if (dispatchMouseEvents && typeof el.dispatchEvent === "function") {
      try {
        var r =
          typeof el.getBoundingClientRect === "function"
            ? el.getBoundingClientRect()
            : { left: 0, top: 0, width: 10, height: 10 };
        var opts = {
          bubbles: true,
          cancelable: true,
          clientX: (r.left || 0) + (r.width || 0) / 2,
          clientY: (r.top || 0) + (r.height || 0) / 2,
          button: 0,
        };
        if (typeof MouseEvent === "function") {
          el.dispatchEvent(new MouseEvent("mousedown", opts));
          el.dispatchEvent(new MouseEvent("mouseup", opts));
          el.dispatchEvent(new MouseEvent("click", opts));
          return { ok: true, via: "mouse_events" };
        }
      } catch (_) {}
    }
    if (typeof el.click === "function") {
      el.click();
      return { ok: true, via: "click" };
    }
    return { ok: false, reason: "no_click_method" };
  };

  var queryList = function (container, selectors) {
    var out = [];
    if (!container || typeof container.querySelectorAll !== "function") {
      return out;
    }
    for (var i = 0; i < selectors.length; i++) {
      try {
        var nl = container.querySelectorAll(selectors[i]);
        for (var j = 0; j < nl.length; j++) {
          if (out.indexOf(nl[j]) === -1) out.push(nl[j]);
        }
      } catch (_) {}
    }
    return out;
  };

  var getRowContextText = function (el, maxLen) {
    var limit = maxLen || 220;
    var best = clean(getText(el));
    var node = el ? el.parentElement : null;
    for (var depth = 0; node && node !== root && depth < 4; depth++) {
      var t = clean(getText(node));
      if (t && t.length <= limit) {
        best = t;
      } else if (t && t.length > limit) {
        break;
      }
      node = node.parentElement;
    }
    return best;
  };

  var findVisibleOriginalDialog = function () {
    var dialogs = queryList(root, dialogSelectors);
    for (var i = 0; i < dialogs.length; i++) {
      var dlg = dialogs[i];
      if (!isVisible(dlg)) continue;
      var text = clean(getText(dlg));
      if (!text) continue;
      if (matchesAnyKeyword(text, ignoreDialogPatterns)) continue;
      if (
        matchesAnyKeyword(text, dialogKeywords) ||
        matchesAnyKeyword(text, noQualificationPatterns)
      ) {
        return { el: dlg, text: text };
      }
    }
    return null;
  };

  var detectVisibleNoQualificationToast = function () {
    var toastNodes = queryList(root, [
      '[class*="toast"]',
      '[class*="Toast"]',
      '[class*="message"]',
      '[class*="tips"]',
      '[role="alert"]',
    ]);
    for (var i = 0; i < toastNodes.length; i++) {
      var node = toastNodes[i];
      if (!isVisible(node)) continue;
      var txt = clean(getText(node));
      if (!txt || txt.length > 200) continue;
      var hit = matchesAnyKeyword(txt, noQualificationPatterns);
      if (hit) return txt.slice(0, 120);
    }
    return "";
  };

  var inspectOriginalEntry = function () {
    var activeDialog = findVisibleOriginalDialog();
    if (activeDialog) {
      var dlgNoQual = matchesAnyKeyword(
        activeDialog.text,
        noQualificationPatterns
      );
      if (dlgNoQual) {
        return {
          found: true,
          dialogOpen: true,
          noQualification: true,
          noQualificationText: activeDialog.text.slice(0, 120),
          checked: false,
        };
      }
    }

    var toastNoQual = detectVisibleNoQualificationToast();
    if (toastNoQual) {
      return {
        found: true,
        dialogOpen: Boolean(activeDialog),
        noQualification: true,
        noQualificationText: toastNoQual,
        checked: false,
      };
    }

    // 1. 优先命中显式配置的选择器（例如视频号 .declare-original-checkbox .ant-checkbox-wrapper）
    var primaryHits = queryList(root, entrySelectors);
    for (var pi = 0; pi < primaryHits.length; pi++) {
      var pEl = primaryHits[pi];
      if (!isVisible(pEl) || isInsideDialog(pEl)) continue;
      if (getSubmitRejectionReason(pEl)) continue;
      var pInp = findInnerInput(pEl);
      var pState = readCheckedState(pEl, pInp);
      var pDis = isDisabledControl(pEl, pInp);
      var pCtx = getRowContextText(pEl, 240);
      var pNoQual = matchesAnyKeyword(pCtx, noQualificationPatterns);
      if (token && typeof pEl.setAttribute === "function") {
        pEl.setAttribute("data-mm-orig-click", token);
        pEl.setAttribute("data-mm-orig-state", token);
      }
      return {
        found: true,
        checked: pState.checked,
        stateSource: pState.source,
        disabled: pDis,
        noQualification: pDis || Boolean(pNoQual),
        noQualificationText: pNoQual
          ? pCtx.slice(0, 120)
          : pDis
          ? "原创声明入口置灰不可点击"
          : "",
        dialogOpen: Boolean(activeDialog),
        strategy: "primary_selector",
        matchedText: pCtx.slice(0, 120),
      };
    }

    // 2. 文案匹配 toggle（switch / checkbox / label）
    var rawToggles = queryList(root, toggleSelectors);
    for (var ti = 0; ti < rawToggles.length; ti++) {
      var tg = rawToggles[ti];
      if (!isVisible(tg) || isInsideDialog(tg)) continue;
      if (getSubmitRejectionReason(tg)) continue;
      var ctx = getRowContextText(tg, 240);
      var kwHit = matchesAnyKeyword(ctx, entryKeywords);
      if (!kwHit) continue;
      var tInp = findInnerInput(tg);
      var tState = readCheckedState(tg, tInp);
      var tDis = isDisabledControl(tg, tInp);
      var tNoQual = matchesAnyKeyword(ctx, noQualificationPatterns);
      if (token && typeof tg.setAttribute === "function") {
        tg.setAttribute("data-mm-orig-click", token);
        tg.setAttribute("data-mm-orig-state", token);
      }
      return {
        found: true,
        checked: tState.checked,
        stateSource: tState.source,
        disabled: tDis,
        noQualification: tDis || Boolean(tNoQual),
        noQualificationText: tNoQual
          ? ctx.slice(0, 120)
          : tDis
          ? "原创声明开关置灰不可用"
          : "",
        dialogOpen: Boolean(activeDialog),
        strategy: "keyword_toggle",
        matchedKeyword: kwHit,
        matchedText: ctx.slice(0, 120),
      };
    }

    // 3. 容器级检查：无控件但页面明确展示无原创资格提示
    var containers = queryList(root, entryContainerSelectors);
    for (var ci = 0; ci < containers.length; ci++) {
      var cont = containers[ci];
      if (!isVisible(cont) || isInsideDialog(cont)) continue;
      var cText = clean(getText(cont));
      if (!cText || cText.length > 260) continue;
      if (
        matchesAnyKeyword(cText, entryKeywords) &&
        matchesAnyKeyword(cText, noQualificationPatterns)
      ) {
        return {
          found: false,
          noQualification: true,
          noQualificationText: cText.slice(0, 120),
          dialogOpen: Boolean(activeDialog),
          reason: "container_no_qualification",
        };
      }
    }

    // 4. 全页区块文本兜底检查无原创资格提示
    try {
      var blocks = root.querySelectorAll("div, span, p, li, section");
      for (var bi = 0; bi < blocks.length; bi++) {
        var blk = blocks[bi];
        if (!isVisible(blk) || isInsideDialog(blk)) continue;
        var bText = clean(getText(blk));
        if (!bText || bText.length > 180) continue;
        if (
          matchesAnyKeyword(bText, entryKeywords) &&
          matchesAnyKeyword(bText, noQualificationPatterns)
        ) {
          return {
            found: false,
            noQualification: true,
            noQualificationText: bText.slice(0, 120),
            dialogOpen: Boolean(activeDialog),
            reason: "text_no_qualification",
          };
        }
      }
    } catch (_) {}

    return {
      found: false,
      noQualification: false,
      dialogOpen: Boolean(activeDialog),
      reason: "entry_not_found",
    };
  };

  if (action === "cleanup") {
    if (!token) return { ok: true };
    try {
      var attrs = [
        "data-mm-orig-click",
        "data-mm-orig-state",
        "data-mm-orig-agreed",
      ];
      for (var ai = 0; ai < attrs.length; ai++) {
        var nodes = root.querySelectorAll("[" + attrs[ai] + '="' + token + '"]');
        for (var ni = 0; ni < nodes.length; ni++) {
          nodes[ni].removeAttribute(attrs[ai]);
        }
      }
    } catch (_) {}
    return { ok: true };
  }

  if (action === "inspect") {
    return inspectOriginalEntry();
  }

  if (action === "click_entry") {
    var clickEl = token
      ? root.querySelector('[data-mm-orig-click="' + token + '"]')
      : null;
    if (!clickEl) return { ok: false, reason: "entry_missing" };
    return performClick(clickEl, false);
  }

  if (action === "handle_dialog") {
    var toastNoQual = detectVisibleNoQualificationToast();
    if (toastNoQual) {
      return {
        dialogOpen: false,
        noQualification: true,
        noQualificationText: toastNoQual,
      };
    }
    var dlgInfo = findVisibleOriginalDialog();
    if (!dlgInfo) {
      return { dialogOpen: false, noQualification: false };
    }
    var dlg = dlgInfo.el;
    var dlgText = dlgInfo.text;
    if (matchesAnyKeyword(dlgText, noQualificationPatterns)) {
      return {
        dialogOpen: true,
        noQualification: true,
        noQualificationText: dlgText.slice(0, 120),
      };
    }

    var agreementClicked = false;
    var agreeNodes = queryList(dlg, agreementSelectors);
    for (var gi = 0; gi < agreeNodes.length; gi++) {
      var ag = agreeNodes[gi];
      if (!isVisible(ag)) continue;
      var agText = getRowContextText(ag, 160);
      var agInp = findInnerInput(ag);
      var isProtocolLink =
        typeof ag.matches === "function" && ag.matches(".protocol-text");
      if (!isProtocolLink && !matchesAnyKeyword(agText, agreementKeywords)) {
        continue;
      }
      if (isProtocolLink) {
        if (
          typeof ag.getAttribute === "function" &&
          ag.getAttribute("data-mm-orig-agreed") === token
        ) {
          continue;
        }
        var pClick = performClick(ag, true);
        if (pClick && pClick.ok) {
          if (token && typeof ag.setAttribute === "function") {
            ag.setAttribute("data-mm-orig-agreed", token);
          }
          agreementClicked = true;
          break;
        }
      } else {
        var agState = readCheckedState(ag, agInp);
        if (!agState.checked) {
          var aClick = performClick(ag, true);
          if (aClick && aClick.ok) {
            agreementClicked = true;
            break;
          }
        }
      }
    }

    var confirmClicked = false;
    var confirmDisabled = false;
    var confirmText = "";
    var btns = queryList(dlg, confirmButtonSelectors);
    for (var cti = 0; cti < confirmButtonTexts.length && !confirmClicked; cti++) {
      var wanted = norm(confirmButtonTexts[cti]);
      for (var bi = 0; bi < btns.length; bi++) {
        var btn = btns[bi];
        if (!isVisible(btn)) continue;
        var bNorm = norm(getText(btn));
        if (!bNorm) continue;
        if (bNorm === "取消" || bNorm === "关闭" || bNorm === "暂不声明") {
          continue;
        }
        if (bNorm === wanted || bNorm.indexOf(wanted) !== -1) {
          if (isDisabledControl(btn, null)) {
            confirmDisabled = true;
            confirmText = bNorm;
            continue;
          }
          // 弹窗内确定按钮（如「声明原创」「确定」）允许跳过主表单提交守卫
          var cClick = performClick(btn, true);
          if (cClick && cClick.ok) {
            confirmClicked = true;
            confirmText = bNorm;
            break;
          }
        }
      }
    }

    return {
      dialogOpen: true,
      noQualification: false,
      agreementClicked: agreementClicked,
      confirmClicked: confirmClicked,
      confirmDisabled: confirmDisabled,
      confirmText: confirmText,
      dialogText: dlgText.slice(0, 140),
    };
  }

  if (action === "readback") {
    var rbToast = detectVisibleNoQualificationToast();
    var rbDlg = findVisibleOriginalDialog();
    if (rbToast) {
      return {
        found: true,
        checked: false,
        dialogOpen: Boolean(rbDlg),
        noQualification: true,
        noQualificationText: rbToast,
      };
    }
    if (rbDlg && matchesAnyKeyword(rbDlg.text, noQualificationPatterns)) {
      return {
        found: true,
        checked: false,
        dialogOpen: true,
        noQualification: true,
        noQualificationText: rbDlg.text.slice(0, 120),
      };
    }
    var stateEl = token
      ? root.querySelector('[data-mm-orig-state="' + token + '"]')
      : null;
    if (stateEl && stateEl.isConnected !== false) {
      var inp = findInnerInput(stateEl);
      var st = readCheckedState(stateEl, inp);
      var dis = isDisabledControl(stateEl, inp);
      var ctx = getRowContextText(stateEl, 240);
      var nq = matchesAnyKeyword(ctx, noQualificationPatterns);
      return {
        found: true,
        checked: st.checked,
        stateSource: st.source,
        disabled: dis,
        dialogOpen: Boolean(rbDlg),
        noQualification: dis || Boolean(nq),
        noQualificationText: nq ? ctx.slice(0, 120) : "",
      };
    }
    return inspectOriginalEntry();
  }

  return { found: false, reason: "unknown_action:" + action };
}

/**
 * 采集章节/原创区域的诊断 DOM 片段（outerHTML）与可见弹窗，便于 macon 真机存草稿校准。
 */
export function collectPublishExtrasDiagnosticsDom(payload) {
  var cfg = (payload && payload.cfg) || {};
  var wujieHost = cfg.wujieHost ? String(cfg.wujieHost) : "";
  var diagSelectors = Array.isArray(cfg.diagSelectors)
    ? cfg.diagSelectors
    : [];
  var diagKeywords = Array.isArray(cfg.diagKeywords) ? cfg.diagKeywords : [];
  var dialogSelectors = Array.isArray(cfg.dialogSelectors)
    ? cfg.dialogSelectors
    : [".weui-desktop-dialog", ".semi-modal", ".ant-modal", ".d-modal", "[role='dialog']"];

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

  var docRef = typeof document !== "undefined" ? document : null;
  var root = null;
  if (docRef) {
    if (wujieHost) {
      var host = null;
      try {
        host = docRef.querySelector(wujieHost);
      } catch (_) {}
      root = host && host.shadowRoot ? host.shadowRoot : null;
    } else {
      root = docRef;
    }
  }
  if (!root) {
    return { hasRoot: false, snippets: [], dialogs: [] };
  }

  var snippets = [];
  var seen = [];
  var pushSnippet = function (el) {
    if (!el || snippets.length >= 6 || seen.indexOf(el) !== -1) return;
    seen.push(el);
    var rect =
      typeof el.getBoundingClientRect === "function"
        ? el.getBoundingClientRect()
        : { x: 0, y: 0, width: 0, height: 0 };
    snippets.push({
      tag: String(el.tagName || ""),
      cls: String((typeof el.getAttribute === "function" && el.getAttribute("class")) || el.className || "").slice(0, 80),
      rect: {
        x: Math.round(rect.x || 0),
        y: Math.round(rect.y || 0),
        w: Math.round(rect.width || 0),
        h: Math.round(rect.height || 0),
      },
      text: clean(getText(el)).slice(0, 140),
      outerHTML: String(el.outerHTML || "").slice(0, 600),
    });
  };

  for (var si = 0; si < diagSelectors.length && snippets.length < 6; si++) {
    try {
      var nl = root.querySelectorAll(diagSelectors[si]);
      for (var ni = 0; ni < nl.length && snippets.length < 6; ni++) {
        pushSnippet(nl[ni]);
      }
    } catch (_) {}
  }

  if (snippets.length < 6 && diagKeywords.length > 0) {
    try {
      var blocks = root.querySelectorAll("div, section, label, li");
      for (var bi = 0; bi < blocks.length && snippets.length < 6; bi++) {
        var t = clean(getText(blocks[bi]));
        if (!t || t.length > 320) continue;
        for (var ki = 0; ki < diagKeywords.length; ki++) {
          if (t.indexOf(diagKeywords[ki]) !== -1) {
            pushSnippet(blocks[bi]);
            break;
          }
        }
      }
    } catch (_) {}
  }

  var dialogs = [];
  for (var di = 0; di < dialogSelectors.length && dialogs.length < 3; di++) {
    try {
      var dl = root.querySelectorAll(dialogSelectors[di]);
      for (var dj = 0; dj < dl.length && dialogs.length < 3; dj++) {
        var d = dl[dj];
        var dr =
          typeof d.getBoundingClientRect === "function"
            ? d.getBoundingClientRect()
            : { width: 1, height: 1 };
        if (dr && dr.width <= 0) continue;
        dialogs.push({
          cls: String((typeof d.getAttribute === "function" && d.getAttribute("class")) || d.className || "").slice(0, 80),
          text: clean(getText(d)).slice(0, 160),
          outerHTML: String(d.outerHTML || "").slice(0, 600),
        });
      }
    } catch (_) {}
  }

  return { hasRoot: true, snippets: snippets, dialogs: dialogs };
}

async function waitExtrasMs(page, ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return;
  if (page && typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(delay).catch(() => {});
  } else {
    await new Promise((r) => setTimeout(r, delay));
  }
}

export async function dumpExtrasDiagnostics(
  page,
  {
    platformTag,
    platformLabel,
    featureTag,
    stage,
    cfg,
    data,
    window,
    captureScreenshot,
  }
) {
  try {
    const diag = await page.evaluate(collectPublishExtrasDiagnosticsDom, {
      cfg: {
        wujieHost: cfg.wujieHost || "",
        diagSelectors: cfg.diagSelectors || [],
        diagKeywords: cfg.diagKeywords || [],
        dialogSelectors: cfg.dialogSelectors || [],
      },
    });
    console.warn(
      `[${platformTag}][${featureTag}][diag] stage=${stage} hasRoot=${Boolean(
        diag && diag.hasRoot
      )} dialogs=${JSON.stringify((diag && diag.dialogs) || []).slice(0, 1800)}`
    );
    console.warn(
      `[${platformTag}][${featureTag}][diag] stage=${stage} snippets=${JSON.stringify(
        (diag && diag.snippets) || []
      ).slice(0, 3200)}`
    );
  } catch (e) {
    console.warn(
      `[${platformTag}][${featureTag}][diag] 采集 DOM 诊断失败(stage=${stage}): ${
        (e && e.message) || e
      }`
    );
  }
  if (typeof captureScreenshot === "function") {
    try {
      const shot = await captureScreenshot(
        page,
        {
          ...(data || {}),
          pt: platformLabel,
          _diagStage: `${featureTag}-${stage}`,
        },
        { window }
      );
      if (shot) {
        console.warn(
          `[${platformTag}][${featureTag}][diag] stage=${stage} 诊断截图已保存: ${shot}`
        );
      }
    } catch (_) {
      /* 诊断截图失败不覆盖主流程 */
    }
  }
}

/**
 * 通用 AI 自动章节执行流程（抖音 / 快手 / 小红书共用）：
 * - 找不到入口 / 短视频不支持 / 开关置灰：打印诊断日志与截图，告警继续发布（不中止），回执「章节：不支持」
 * - 点选后回读未选中：重试一次；仍失败则打印诊断与截图、告警继续发布，回执「章节：失败」
 * - 成功或已开启：回执「章节：已开启」
 */
export async function executeAiChaptersFlow(
  page,
  {
    platformTag,
    platformLabel,
    cfg,
    data,
    window,
    captureScreenshot,
    timeouts = {},
  }
) {
  const afterClickDelayMs =
    timeouts.afterClickDelayMs !== undefined ? timeouts.afterClickDelayMs : 400;
  const readbackTimeoutMs =
    timeouts.readbackTimeoutMs !== undefined
      ? timeouts.readbackTimeoutMs
      : 1600;
  const pollIntervalMs =
    timeouts.pollIntervalMs !== undefined ? timeouts.pollIntervalMs : 250;
  const token = `mm_ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const diagPayload = (stage) => ({
    platformTag,
    platformLabel,
    featureTag: "ai-chapters",
    stage,
    cfg,
    data,
    window,
    captureScreenshot,
  });

  try {
    let inspected = await page.evaluate(runAiChaptersDomAction, {
      action: "inspect",
      token,
      cfg,
    });

    // 若章节区默认折叠，先尝试点击一次展开入口再查找 AI 章节开关
    if (inspected && !inspected.found && inspected.hasOpener) {
      console.log(
        `[${platformTag}][ai-chapters] 发现章节入口「${
          inspected.openerText || ""
        }」，尝试展开...`
      );
      const openRes = await page.evaluate(runAiChaptersDomAction, {
        action: "click_opener",
        token,
        cfg,
      });
      if (openRes && openRes.ok) {
        await waitExtrasMs(page, afterClickDelayMs);
        inspected = await page.evaluate(runAiChaptersDomAction, {
          action: "inspect",
          token,
          cfg,
        });
      }
    }

    if (!inspected || !inspected.found || inspected.unsupported) {
      const reason =
        (inspected && (inspected.unsupportedReason || inspected.reason)) ||
        "页面未提供 AI 章节入口或当前视频不支持";
      console.warn(
        `[${platformTag}][ai-chapters] 当前视频不支持或未找到 AI 自动章节入口（${reason}），告警并继续发布`
      );
      await dumpExtrasDiagnostics(page, diagPayload("unsupported"));
      return {
        status: AI_CHAPTERS_STATUS.UNSUPPORTED,
        receiptText: formatAiChaptersReceipt(AI_CHAPTERS_STATUS.UNSUPPORTED),
        reason,
        attempts: 0,
      };
    }

    if (inspected.checked === true) {
      console.log(
        `[${platformTag}][ai-chapters] AI 自动章节已开启（策略=${
          inspected.strategy || ""
        }，来源=${inspected.stateSource || ""}），无需重复点击`
      );
      return {
        status: AI_CHAPTERS_STATUS.ENABLED,
        receiptText: formatAiChaptersReceipt(AI_CHAPTERS_STATUS.ENABLED),
        alreadyEnabled: true,
        attempts: 0,
      };
    }

    let lastReason = "点选后回读仍为未选中状态";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const clickRes = await page.evaluate(runAiChaptersDomAction, {
        action: "click_toggle",
        token,
        cfg,
      });
      if (!clickRes || !clickRes.ok) {
        lastReason =
          clickRes && clickRes.submitRejected
            ? `目标疑似提交按钮被拦截(${clickRes.rejectReason})`
            : `点击开关失败(${(clickRes && clickRes.reason) || "unknown"})`;
      } else {
        await waitExtrasMs(page, afterClickDelayMs);
        const confirmRes = await page
          .evaluate(runAiChaptersDomAction, {
            action: "confirm_dialog",
            token,
            cfg,
          })
          .catch(() => null);
        if (confirmRes && confirmRes.confirmed) {
          await waitExtrasMs(page, afterClickDelayMs);
        }

        const deadline = Date.now() + Math.max(0, readbackTimeoutMs);
        let rb = null;
        do {
          rb = await page.evaluate(runAiChaptersDomAction, {
            action: "readback",
            token,
            cfg,
          });
          if (rb && rb.found && rb.checked === true) {
            console.log(
              `[${platformTag}][ai-chapters] AI 自动章节已开启并回读确认（第 ${attempt} 次尝试，来源=${
                rb.stateSource || ""
              }）`
            );
            return {
              status: AI_CHAPTERS_STATUS.ENABLED,
              receiptText: formatAiChaptersReceipt(AI_CHAPTERS_STATUS.ENABLED),
              alreadyEnabled: false,
              attempts: attempt,
            };
          }
          if (Date.now() < deadline) {
            await waitExtrasMs(page, pollIntervalMs);
          }
        } while (Date.now() < deadline);

        lastReason =
          rb && rb.disabled
            ? "点击后开关变为禁用"
            : rb && !rb.found
            ? "点击后回读未找到开关"
            : "点击后回读仍为未选中状态";
      }

      if (attempt < 2) {
        console.warn(
          `[${platformTag}][ai-chapters] 第 ${attempt} 次开启未确认（${lastReason}），重试一次...`
        );
        // 重试前重新定位一次，兼容重渲染
        await page
          .evaluate(runAiChaptersDomAction, {
            action: "inspect",
            token,
            cfg,
          })
          .catch(() => {});
      }
    }

    console.warn(
      `[${platformTag}][ai-chapters] 重试后开启 AI 自动章节仍失败（${lastReason}），告警并继续发布`
    );
    await dumpExtrasDiagnostics(page, diagPayload("readback-failed"));
    return {
      status: AI_CHAPTERS_STATUS.FAILED,
      receiptText: formatAiChaptersReceipt(AI_CHAPTERS_STATUS.FAILED),
      reason: lastReason,
      attempts: 2,
    };
  } catch (err) {
    const reason = (err && err.message) || String(err);
    console.warn(
      `[${platformTag}][ai-chapters] 执行异常（${reason}），告警并继续发布`
    );
    await dumpExtrasDiagnostics(page, diagPayload("exception"));
    return {
      status: AI_CHAPTERS_STATUS.FAILED,
      receiptText: formatAiChaptersReceipt(AI_CHAPTERS_STATUS.FAILED),
      reason,
      attempts: 1,
    };
  } finally {
    await page
      .evaluate(runAiChaptersDomAction, {
        action: "cleanup",
        token,
        cfg,
      })
      .catch(() => {});
  }
}

/**
 * 通用原创声明执行流程（小红书 / 视频号共用）：
 * - 账号无原创资格（页面提示无资格或入口置灰）：采集诊断并抛错中止发布，文案含「账号无原创资格，可在发布设置关闭原创声明」
 * - 未找到入口 / 确认弹窗失败 / 回读未选中：采集诊断并抛错中止发布（宁可不发）
 * - 支持连续多个确认弹窗（条款勾选 → 确认声明）
 */
export async function executeOriginalStatementFlow(
  page,
  {
    platformTag,
    platformLabel,
    cfg,
    data,
    window,
    captureScreenshot,
    timeouts = {},
  }
) {
  const afterClickDelayMs =
    timeouts.afterClickDelayMs !== undefined ? timeouts.afterClickDelayMs : 450;
  const agreementDelayMs =
    timeouts.agreementDelayMs !== undefined ? timeouts.agreementDelayMs : 300;
  const afterConfirmDelayMs =
    timeouts.afterConfirmDelayMs !== undefined
      ? timeouts.afterConfirmDelayMs
      : 500;
  const dialogTimeoutMs =
    timeouts.dialogTimeoutMs !== undefined ? timeouts.dialogTimeoutMs : 4000;
  const readbackTimeoutMs =
    timeouts.readbackTimeoutMs !== undefined
      ? timeouts.readbackTimeoutMs
      : 2500;
  const pollIntervalMs =
    timeouts.pollIntervalMs !== undefined ? timeouts.pollIntervalMs : 250;
  const token = `mm_orig_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const diagPayload = (stage) => ({
    platformTag,
    platformLabel,
    featureTag: "original-statement",
    stage,
    cfg,
    data,
    window,
    captureScreenshot,
  });

  try {
    const inspected = await page.evaluate(runOriginalStatementDomAction, {
      action: "inspect",
      token,
      cfg,
    });

    if (inspected && inspected.noQualification) {
      await dumpExtrasDiagnostics(page, diagPayload("no-qualification"));
      throw createNoOriginalQualificationError(
        platformLabel,
        inspected.noQualificationText || ""
      );
    }

    if (!inspected || !inspected.found) {
      await dumpExtrasDiagnostics(page, diagPayload("locate-failed"));
      throw createOriginalStatementError(
        platformLabel,
        "定位入口",
        (inspected && inspected.reason) || "未找到原创声明入口"
      );
    }

    if (inspected.checked === true && !inspected.dialogOpen) {
      console.log(
        `[${platformTag}][original] 原创声明已处于勾选状态（策略=${
          inspected.strategy || ""
        }，来源=${inspected.stateSource || ""}），无需重复点击`
      );
      return {
        status: ORIGINAL_STATEMENT_STATUS.ENABLED,
        alreadyEnabled: true,
      };
    }

    if (!inspected.checked) {
      const clickRes = await page.evaluate(runOriginalStatementDomAction, {
        action: "click_entry",
        token,
        cfg,
      });
      if (!clickRes || !clickRes.ok) {
        await dumpExtrasDiagnostics(page, diagPayload("click-failed"));
        throw createOriginalStatementError(
          platformLabel,
          "点击入口",
          clickRes && clickRes.submitRejected
            ? `目标疑似提交按钮被拦截(${clickRes.rejectReason})`
            : (clickRes && clickRes.reason) || "点击原创声明入口失败"
        );
      }
      await waitExtrasMs(page, afterClickDelayMs);
    }

    // 处理可能出现的 1～2 个条款/确认弹窗
    const dialogDeadline = Date.now() + Math.max(0, dialogTimeoutMs);
    let dialogRounds = 0;
    while (dialogRounds < 8) {
      dialogRounds += 1;
      const dlgRes = await page.evaluate(runOriginalStatementDomAction, {
        action: "handle_dialog",
        token,
        cfg,
      });
      if (dlgRes && dlgRes.noQualification) {
        await dumpExtrasDiagnostics(
          page,
          diagPayload("dialog-no-qualification")
        );
        throw createNoOriginalQualificationError(
          platformLabel,
          dlgRes.noQualificationText || ""
        );
      }
      if (!dlgRes || !dlgRes.dialogOpen) {
        break;
      }
      if (dlgRes.agreementClicked && !dlgRes.confirmClicked) {
        await waitExtrasMs(page, agreementDelayMs);
        continue;
      }
      if (dlgRes.confirmClicked) {
        console.log(
          `[${platformTag}][original] 已点击确认弹窗按钮「${
            dlgRes.confirmText || ""
          }」`
        );
        await waitExtrasMs(page, afterConfirmDelayMs);
        continue;
      }
      if (Date.now() >= dialogDeadline) {
        await dumpExtrasDiagnostics(page, diagPayload("dialog-confirm-failed"));
        throw createOriginalStatementError(
          platformLabel,
          "确认弹窗",
          dlgRes.confirmDisabled
            ? `确认按钮「${dlgRes.confirmText || "确定"}」处于置灰不可点击状态`
            : "确认弹窗未找到可点击的确认按钮"
        );
      }
      await waitExtrasMs(page, pollIntervalMs);
    }

    // 回读校验勾选终态且无残留弹窗
    const readbackDeadline = Date.now() + Math.max(0, readbackTimeoutMs);
    let rb = null;
    do {
      rb = await page.evaluate(runOriginalStatementDomAction, {
        action: "readback",
        token,
        cfg,
      });
      if (rb && rb.noQualification) {
        await dumpExtrasDiagnostics(
          page,
          diagPayload("readback-no-qualification")
        );
        throw createNoOriginalQualificationError(
          platformLabel,
          rb.noQualificationText || ""
        );
      }
      if (rb && rb.found && rb.checked === true && !rb.dialogOpen) {
        console.log(
          `[${platformTag}][original] 原创声明已开启并回读确认（来源=${
            rb.stateSource || ""
          }）`
        );
        return {
          status: ORIGINAL_STATEMENT_STATUS.ENABLED,
          alreadyEnabled: false,
        };
      }
      if (Date.now() < readbackDeadline) {
        await waitExtrasMs(page, pollIntervalMs);
      }
    } while (Date.now() < readbackDeadline);

    await dumpExtrasDiagnostics(page, diagPayload("readback-failed"));
    throw createOriginalStatementError(
      platformLabel,
      "状态回读",
      rb && rb.dialogOpen
        ? "原创声明确认弹窗仍未关闭"
        : rb && !rb.found
        ? "确认后回读未找到原创声明控件"
        : "勾选并确认后回读仍为未选中状态"
    );
  } finally {
    await page
      .evaluate(runOriginalStatementDomAction, {
        action: "cleanup",
        token,
        cfg,
      })
      .catch(() => {});
  }
}

