import path from "path";
import {
  readPageUrl,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";
import { resolveBjhCreativeStatementLabel } from "../../../shared/creativeStatement.js";
import { buildPlatformVideoTextDetailed } from "../../../shared/videoMetadata.js";
import {
  formatRuleAdjustmentsSummary,
  mergeRuleAdjustments,
} from "../../../shared/platformRules.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";

async function selectBjhCreativeStatement(page, data) {
  const value = data.data && data.data.creativeStatement;
  console.log("[bjh] creativeStatement 值 =", value);
  // 注意：「无标注」对应百家号「无需声明」，也必须主动点选，不能跳过
  const label = resolveBjhCreativeStatementLabel(value);
  console.log("[bjh] 准备选择创作声明:", label);

  // 1. 触发创作声明 modal：input 通常是只读的，单点 input 不一定能打开，
  //    所以依次尝试在 DOM 层面派发 click 到 input / 其外层 .form-inner-wrap，并 focus 一下。
  try {
    await page.waitForSelector('input[placeholder="请选择创作声明"]', {
      visible: true,
      timeout: 15000,
    });
  } catch (_) {
    console.warn("未找到百家号创作声明输入框，跳过");
    return;
  }
  const triggerInfo = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder="请选择创作声明"]');
    if (!input) return { ok: false, reason: "no-input" };
    const wrap = input.closest(".form-inner-wrap") || input.parentElement;
    // 先 focus，再分别点 input 和外层包裹（点哪个生效取决于站点的事件绑定位置）
    try {
      input.focus();
    } catch (_) {}
    try {
      input.click();
    } catch (_) {}
    if (wrap && wrap !== input) {
      try {
        wrap.click();
      } catch (_) {}
    }
    return {
      ok: true,
      wrapTag: wrap ? wrap.tagName : null,
      wrapCls: wrap ? wrap.className : null,
    };
  });
  console.log("[bjh] 已触发声明 input:", triggerInfo);

  // 2. 等弹窗出现（最长等 15s，弹窗未出现也可能是已经出现过被关掉/被遮罩盖住）
  try {
    await page.waitForSelector(
      ".cheetah-modal-content .cheetah-radio-wrapper",
      {
        visible: true,
        timeout: 15000,
      }
    );
  } catch (e) {
    console.warn("百家号创作声明弹窗未出现:", e?.message || e);
    return;
  }

  // 3. 在「必选声明」区点选对应文案的 radio：
  //    新版弹窗可能只渲染 .cheetah-modal-body，扩大根容器查找范围；
  //    同时把所有 radio 行文本列出来便于排查未命中时的真实文案。
  const pickResult = await page.evaluate((text) => {
    const modal =
      document.querySelector(".cheetah-modal-content") ||
      document.querySelector(".cheetah-modal-body") ||
      document.querySelector(".cheetah-modal") ||
      document;
    const norm = (t) =>
      String(t || "")
        .replace(/\s+/g, "")
        .trim();
    const target = norm(text);

    var wrappers = modal.querySelectorAll(".cheetah-radio-wrapper");
    var rowTexts = [];
    var getRow = function (w) {
      return w.closest(".flex.items-center") || w.parentElement || w;
    };
    for (var i = 0; i < wrappers.length; i++) {
      rowTexts.push(norm(getRow(wrappers[i]).textContent || ""));
    }

    // 1) 精确等于
    for (var i1 = 0; i1 < wrappers.length; i1++) {
      var w1 = wrappers[i1];
      var row1 = getRow(w1);
      if (norm(row1.textContent) === target) {
        var inp1 = w1.querySelector("input.cheetah-radio-input");
        if (inp1)
          try {
            inp1.click();
          } catch (_) {}
        try {
          w1.click();
        } catch (_) {}
        return { ok: true, mode: "row-equal", rows: rowTexts };
      }
    }
    // 2) 行文本包含
    for (var i2 = 0; i2 < wrappers.length; i2++) {
      var w2 = wrappers[i2];
      var row2 = getRow(w2);
      if (norm(row2.textContent).indexOf(target) !== -1) {
        var inp2 = w2.querySelector("input.cheetah-radio-input");
        if (inp2)
          try {
            inp2.click();
          } catch (_) {}
        try {
          w2.click();
        } catch (_) {}
        return { ok: true, mode: "row-includes", rows: rowTexts };
      }
    }
    // 3) span 文本反查
    var spans = modal.querySelectorAll("span");
    for (var i3 = 0; i3 < spans.length; i3++) {
      var sp = spans[i3];
      if (norm(sp.textContent) !== target) continue;
      var row3 = sp.parentElement;
      for (var k = 0; row3 && k < 6; k++) {
        var ri = row3.querySelector("input.cheetah-radio-input");
        var rl = row3.querySelector(".cheetah-radio-wrapper");
        if (ri || rl) {
          if (ri)
            try {
              ri.click();
            } catch (_) {}
          if (rl)
            try {
              rl.click();
            } catch (_) {}
          return { ok: true, mode: "span-walkup", rows: rowTexts };
        }
        row3 = row3.parentElement;
      }
    }
    return { ok: false, rows: rowTexts };
  }, label);

  console.log(
    `[bjh] radio 命中模式=${
      pickResult && pickResult.mode ? pickResult.mode : "miss"
    }; 弹窗里 ${
      pickResult && pickResult.rows ? pickResult.rows.length : 0
    } 个 radio 行文本: ${JSON.stringify((pickResult && pickResult.rows) || [])}`
  );
  const picked = pickResult && pickResult.ok;

  if (!picked) {
    console.warn(`未找到百家号创作声明选项: ${label}`);
    return;
  }
  await page.waitForTimeout(300);

  // 4. 点击弹窗底部「确定」按钮
  try {
    const confirmed = await page.evaluate(() => {
      const modal = document.querySelector(".cheetah-modal-content");
      if (!modal) return false;
      // 优先在 .cheetah-modal-footer 范围内取 primary 按钮
      const footer = modal.querySelector(".cheetah-modal-footer");
      const scope = footer || modal;
      const btn = scope.querySelector("button.cheetah-btn-primary");
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (!confirmed) {
      console.warn("未找到百家号创作声明确认按钮 button.cheetah-btn-primary");
    } else {
      console.log("[bjh] 已点击声明确认按钮");
    }
    await page.waitForTimeout(400);
  } catch (e) {
    console.warn("点击百家号声明确认按钮失败:", e?.message || e);
  }
}

/** 百家号底部操作区根节点 */
const BJH_OPERATOR_ROOT = "#new-operator-content .op-list-right";

/** 等待发布/存草稿按钮变为可点击（disabled 解除） */
async function waitForBjhActionButtonReady(page, buttonText, totalMs = 120000) {
  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    const ok = await page
      .evaluate((text) => {
        const norm = (t) =>
          String(t || "")
            .replace(/\s+/g, "")
            .trim();
        const isReady = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            !el.disabled &&
            el.getAttribute("aria-disabled") !== "true" &&
            el.getAttribute("disabled") === null
          );
        };
        const root =
          document.querySelector("#new-operator-content .op-list-right") ||
          document;
        if (text === "发布") {
          const byTestId = root.querySelector(
            'button[data-testid="publish-btn"]'
          );
          if (isReady(byTestId)) return true;
        }
        for (const btn of root.querySelectorAll("button")) {
          if (norm(btn.textContent) === text && isReady(btn)) return true;
        }
        return false;
      }, buttonText)
      .catch(() => false);
    if (ok) return;
    await page.waitForTimeout(2000);
  }
  const err = new Error(`等待百家号「${buttonText}」按钮可点击超时`);
  err.name = "TimeoutError";
  throw err;
}

/** 读取发布/存草稿按钮当前状态，便于 disabled 时给出明确失败原因 */
async function getBjhActionButtonState(page, buttonText) {
  return page.evaluate(
    (rootSel, text) => {
      const norm = (t) =>
        String(t || "")
          .replace(/\s+/g, "")
          .trim();
      const root = document.querySelector(rootSel) || document;
      let btn = null;
      if (text === "发布") {
        btn = root.querySelector('button[data-testid="publish-btn"]');
      }
      if (!btn) {
        for (const b of root.querySelectorAll("button")) {
          if (norm(b.textContent) === text) {
            btn = b;
            break;
          }
        }
      }
      if (!btn) return { found: false };
      const disabled =
        btn.disabled ||
        btn.hasAttribute("disabled") ||
        btn.getAttribute("aria-disabled") === "true";
      return {
        found: true,
        disabled,
        text: norm(btn.textContent),
        testId: btn.getAttribute("data-testid") || "",
        cls: btn.className || "",
      };
    },
    BJH_OPERATOR_ROOT,
    buttonText
  );
}

/** 仅当按钮可点击时才触发 click，避免 disabled 灰色按钮误点 */
async function clickBjhActionButton(page, buttonText) {
  return page.evaluate(
    (rootSel, text) => {
      const norm = (t) =>
        String(t || "")
          .replace(/\s+/g, "")
          .trim();
      const isReady = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !el.disabled &&
          el.getAttribute("aria-disabled") !== "true" &&
          el.getAttribute("disabled") === null
        );
      };
      const root = document.querySelector(rootSel) || document;
      let btn = null;
      if (text === "发布") {
        btn = root.querySelector('button[data-testid="publish-btn"]');
      }
      if (!btn) {
        for (const b of root.querySelectorAll("button")) {
          if (norm(b.textContent) === text) {
            btn = b;
            break;
          }
        }
      }
      if (!btn && text === "发布") {
        btn = root.querySelector(
          "button.cheetah-btn-primary.cheetah-btn-solid"
        );
      }
      if (!btn) return { ok: false, reason: "not-found" };
      if (!isReady(btn)) {
        return {
          ok: false,
          reason: "disabled",
          text: norm(btn.textContent),
          testId: btn.getAttribute("data-testid") || "",
        };
      }
      btn.click();
      return { ok: true, text: norm(btn.textContent) };
    },
    BJH_OPERATOR_ROOT,
    buttonText
  );
}

// 新版百家号视频发布页没有独立标题框，唯一 contenteditable div（class 形如 FeEditorApp-xxx-contentEditable）
// 是「作品描述」（上限 50 字）；hash 中段每次构建可能变，用前缀+后缀模糊匹配。
export const BJH_DESC_SELECTOR =
  'div[contenteditable="true"][class*="contentEditable"], div[contenteditable="true"][class*="FeEditorApp"]';

export function normBjhDesc(s) {
  return String(s == null ? "" : s)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 百家号作品描述严格相等校验：
 * 回读 textContent 归一后必须完全等于期望文本（不是「包含」/前缀放行，也不再做 fileStem 猜测）；
 * 任何文件名残留、重复叠加、截断或多余内容一律判失败。
 */
export function bjhDescOk(cur, want) {
  const expected = normBjhDesc(want);
  if (!expected) return true;
  return normBjhDesc(cur) === expected;
}

/** 构造百家号确定性失败错误（标记 noRetry + bjhDeterministic，避免外层 5 次重复上传） */
export function createBjhDeterministicError(
  message,
  code = "BJH_DESC_DETERMINISTIC"
) {
  const err = new Error(message);
  err.bjhDeterministic = true;
  err.noRetry = true;
  err.code = code;
  return err;
}

export function isBjhNoRetryError(err) {
  return Boolean(
    err && (err.noRetry === true || err.bjhDeterministic === true)
  );
}

/** 关闭浮在作品描述框上的「新增智能文案…」蓝色引导气泡（有则点 ×，没有跳过） */
export async function dismissBjhSmartCopyBubble(page) {
  try {
    const result = await page.evaluate(function () {
      var isVisible = function (el) {
        if (!el || el.isConnected === false) return false;
        var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (rect && (rect.width <= 0 || rect.height <= 0)) return false;
        if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
          var st = window.getComputedStyle(el);
          if (
            st &&
            (st.display === "none" ||
              st.visibility === "hidden" ||
              String(st.opacity) === "0")
          ) {
            return false;
          }
        }
        return true;
      };
      var norm = function (t) {
        return String(t || "").replace(/\s+/g, "");
      };
      var keywords = ["新增智能文案", "AI为您生成优质文案", "快来试试吧"];
      var candidates = document.querySelectorAll(
        '[class*="popover"], [class*="tooltip"], [class*="guide"], [class*="tip"], [class*="bubble"], [role="tooltip"], div'
      );
      var targetBubble = null;
      var bestLen = Infinity;
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!isVisible(el)) continue;
        var txt = norm(el.textContent);
        if (!txt || txt.length > 120) continue;
        var hit = false;
        for (var k = 0; k < keywords.length; k++) {
          if (txt.indexOf(keywords[k]) !== -1) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        if (txt.length < bestLen) {
          bestLen = txt.length;
          targetBubble = el;
        }
      }
      if (!targetBubble) return { found: false, closed: false };

      var scopes = [targetBubble];
      if (
        targetBubble.parentElement &&
        norm(targetBubble.parentElement.textContent).length <= 160
      ) {
        scopes.push(targetBubble.parentElement);
      }
      var closeSelectors = [
        '[aria-label="close"]',
        '[aria-label*="关闭"]',
        'button[class*="close"]',
        'span[class*="close"]',
        'i[class*="close"]',
        '[class*="close"]',
        "button",
        "svg",
      ];
      for (var s = 0; s < scopes.length; s++) {
        var scope = scopes[s];
        for (var c = 0; c < closeSelectors.length; c++) {
          var nodes = scope.querySelectorAll(closeSelectors[c]);
          for (var j = 0; j < nodes.length; j++) {
            var n = nodes[j];
            if (!isVisible(n)) continue;
            var nt = norm(n.textContent);
            if (
              (closeSelectors[c] === "button" || closeSelectors[c] === "svg") &&
              nt &&
              nt !== "×" &&
              nt !== "✕" &&
              nt !== "x" &&
              nt !== "X"
            ) {
              continue;
            }
            var clickTarget =
              n.tagName &&
              n.tagName.toLowerCase() === "svg" &&
              n.parentElement
                ? n.parentElement
                : n;
            try {
              clickTarget.click();
              return {
                found: true,
                closed: true,
                selector: closeSelectors[c],
                bubbleText: norm(targetBubble.textContent).slice(0, 60),
              };
            } catch (_) {}
          }
        }
        var allKids = scope.querySelectorAll("span, i, div, a");
        for (var m = 0; m < allKids.length; m++) {
          var kid = allKids[m];
          if (!isVisible(kid)) continue;
          var kt = norm(kid.textContent);
          if (kt === "×" || kt === "✕" || kt === "x" || kt === "X") {
            try {
              kid.click();
              return {
                found: true,
                closed: true,
                selector: "text-x",
                bubbleText: norm(targetBubble.textContent).slice(0, 60),
              };
            } catch (_) {}
          }
        }
      }
      return {
        found: true,
        closed: false,
        bubbleText: norm(targetBubble.textContent).slice(0, 60),
      };
    });
    if (result && result.found) {
      console.log("[bjh][desc] 智能文案引导气泡处理:", JSON.stringify(result));
      if (result.closed) {
        await page.waitForTimeout(200);
      }
    }
    return result || { found: false, closed: false };
  } catch (e) {
    console.warn("[bjh][desc] 检测/关闭智能文案气泡异常（跳过）:", e?.message || e);
    return { found: false, closed: false };
  }
}

/** 读取作品描述编辑器当前 textContent 与计数器文本（如 38/50），用于校验与诊断日志 */
export async function readBjhDescSnapshot(page) {
  const snap = await page.evaluate(function (sel) {
    var el = document.querySelector(sel);
    if (!el) {
      return {
        found: false,
        rawText: "",
        counterText: "",
        activeInside: false,
      };
    }
    var rawText = String(el.textContent || "");
    var active = document.activeElement;
    var activeInside = Boolean(
      active && (active === el || (el.contains && el.contains(active)))
    );
    var counterText = "";
    var container = el.parentElement;
    for (var depth = 0; container && depth < 6 && !counterText; depth++) {
      var nodes = container.querySelectorAll
        ? container.querySelectorAll("span, div, p")
        : [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n === el || (el.contains && el.contains(n))) continue;
        var t = String(n.textContent || "").trim();
        if (/^\d+\s*\/\s*\d+$/.test(t)) {
          counterText = t;
          break;
        }
      }
      if (!counterText) {
        var ct = String(container.textContent || "");
        var m = ct.match(/\b\d+\s*\/\s*50\b/);
        if (m) counterText = m[0];
      }
      container = container.parentElement;
    }
    return {
      found: true,
      rawText: rawText,
      counterText: counterText,
      activeInside: activeInside,
    };
  }, BJH_DESC_SELECTOR);
  const s = snap || {
    found: false,
    rawText: "",
    counterText: "",
    activeInside: false,
  };
  return {
    ...s,
    normText: normBjhDesc(s.rawText),
  };
}

/**
 * 可靠清空并写入百家号「作品描述」：
 * 1. 先关掉可能遮挡点击的「智能文案」引导气泡；
 * 2. 在编辑器内用 DOM Range (selectNodeContents) 选中全部内容后 execCommand('delete') 清空；
 * 3. 若仍有残留，仅在确认焦点位于该编辑器内时才补发 Ctrl/Cmd+A + Backspace；
 * 4. 选中整个编辑器内容并用 execCommand('insertText') 覆盖写入（绝不在残留文本前追加）；
 * 5. 回读 textContent 归一后必须与期望文本完全相等，不等则清空重写，最多 3 次，仍不等抛确定性失败（noRetry=true）。
 */
export async function fillBjhDescription(
  page,
  desc,
  { maxAttempts = 3 } = {}
) {
  const fillText = String(desc == null ? "" : desc)
    .replace(/\r?\n+/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  const wantNorm = normBjhDesc(fillText);
  if (!wantNorm) return { ok: true, text: "", counterText: "" };

  let lastAfter = {
    found: false,
    rawText: "",
    normText: "",
    counterText: "",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await dismissBjhSmartCopyBubble(page);

    const before = await readBjhDescSnapshot(page);
    console.log(
      `[bjh][desc] 第 ${attempt}/${maxAttempts} 次写入前: found=${
        before.found
      } textContent=${JSON.stringify(before.rawText)} counter=${JSON.stringify(
        before.counterText || "未读到"
      )}`
    );
    if (!before.found) {
      throw createBjhDeterministicError(
        "未找到百家号作品描述编辑器（确定性失败：页面可能改版，不再重试）",
        "BJH_DESC_EDITOR_MISSING"
      );
    }

    // 1. DOM Range 全选编辑器内容 + execCommand('delete')
    const clearRes = await page.evaluate(function (sel) {
      var el = document.querySelector(sel);
      if (!el) return { ok: false, focused: false, rangeSelected: false, deleted: false, remain: "" };
      try {
        if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
      } catch (_) {}
      try {
        el.focus();
      } catch (_) {}
      var active = document.activeElement;
      var focused = Boolean(
        active && (active === el || (el.contains && el.contains(active)))
      );
      var rangeSelected = false;
      if (
        document.createRange &&
        typeof window !== "undefined" &&
        window.getSelection
      ) {
        try {
          var range = document.createRange();
          range.selectNodeContents(el);
          var selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
            rangeSelected = true;
          }
        } catch (_) {}
      }
      var deleted = false;
      if (document.execCommand) {
        try {
          deleted = Boolean(document.execCommand("delete", false, null));
        } catch (_) {}
      }
      return {
        ok: true,
        focused: focused,
        rangeSelected: rangeSelected,
        deleted: deleted,
        remain: String(el.textContent || ""),
      };
    }, BJH_DESC_SELECTOR);

    await page.waitForTimeout(100);

    // 2. delete 后若仍有残留，仅在焦点确认处于该编辑器内时才补发 Ctrl/Cmd+A + Backspace
    let afterClear = await readBjhDescSnapshot(page);
    if (afterClear.normText) {
      const focusOk = await page
        .evaluate(function (sel) {
          var el = document.querySelector(sel);
          if (!el) return false;
          try {
            el.focus();
          } catch (_) {}
          var active = document.activeElement;
          return Boolean(
            active && (active === el || (el.contains && el.contains(active)))
          );
        }, BJH_DESC_SELECTOR)
        .catch(() => false);

      console.log(
        `[bjh][desc] 第 ${attempt}/${maxAttempts} 次 delete 后残留: remain=${JSON.stringify(
          afterClear.rawText
        )} focusInside=${focusOk} clearRes=${JSON.stringify(clearRes)}`
      );

      if (focusOk && page.keyboard) {
        const modKey = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.down(modKey);
        await page.keyboard.press("KeyA");
        await page.keyboard.up(modKey);
        await page.waitForTimeout(80);
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(150);
        afterClear = await readBjhDescSnapshot(page);
      }
    }

    // 3. 再次用 selectNodeContents 覆盖选区后 execCommand('insertText') 写入（防止在残留文本前追加）
    const insertRes = await page.evaluate(
      function (payload) {
        var el = document.querySelector(payload.sel);
        if (!el) return { ok: false, inserted: false, afterInsert: "" };
        try {
          el.focus();
        } catch (_) {}
        if (
          document.createRange &&
          typeof window !== "undefined" &&
          window.getSelection
        ) {
          try {
            var range = document.createRange();
            range.selectNodeContents(el);
            var selection = window.getSelection();
            if (selection) {
              selection.removeAllRanges();
              selection.addRange(range);
            }
          } catch (_) {}
        }
        var inserted = false;
        if (document.execCommand) {
          try {
            inserted = Boolean(
              document.execCommand("insertText", false, payload.text)
            );
          } catch (_) {}
        }
        return {
          ok: true,
          inserted: inserted,
          afterInsert: String(el.textContent || ""),
        };
      },
      { sel: BJH_DESC_SELECTOR, text: fillText }
    );

    await page.waitForTimeout(250);
    let after = await readBjhDescSnapshot(page);

    // 4. 仅当编辑器已彻底清空（normText === ""）但 insertText 未生效且焦点在编辑器内时，才走 keyboard.type 兜底；
    //    若编辑器非空则绝不 keyboard.type，避免在旧文本前重复叠加。
    if (!bjhDescOk(after.rawText, wantNorm) && after.normText === "") {
      const focusOk = await page
        .evaluate(function (sel) {
          var el = document.querySelector(sel);
          if (!el) return false;
          try {
            el.focus();
          } catch (_) {}
          var active = document.activeElement;
          return Boolean(
            active && (active === el || (el.contains && el.contains(active)))
          );
        }, BJH_DESC_SELECTOR)
        .catch(() => false);
      if (focusOk && page.keyboard && typeof page.keyboard.type === "function") {
        console.log(
          `[bjh][desc] 第 ${attempt}/${maxAttempts} 次 insertText 未落地且编辑器为空，改用 keyboard.type 兜底`
        );
        await page.keyboard.type(fillText, { delay: 30 });
        await page.waitForTimeout(250);
        after = await readBjhDescSnapshot(page);
      }
    }

    lastAfter = after;
    console.log(
      `[bjh][desc] 第 ${attempt}/${maxAttempts} 次写入后: textContent=${JSON.stringify(
        after.rawText
      )} norm=${JSON.stringify(after.normText)} expect=${JSON.stringify(
        wantNorm
      )} counter=${JSON.stringify(
        after.counterText || "未读到"
      )} insertOk=${Boolean(insertRes && insertRes.inserted)}`
    );

    if (bjhDescOk(after.rawText, wantNorm)) {
      if (attempt > 1) {
        console.log(`[bjh][desc] 作品描述已在第 ${attempt} 次重写后完全一致`);
      }
      return {
        ok: true,
        text: after.normText,
        counterText: after.counterText,
      };
    }

    console.warn(
      `[bjh][desc] 第 ${attempt}/${maxAttempts} 次写入校验不相等: 当前=${JSON.stringify(
        after.normText
      )} 期望=${JSON.stringify(wantNorm)} 计数器=${JSON.stringify(
        after.counterText || "未读到"
      )}`
    );
    if (attempt < maxAttempts) {
      await page.waitForTimeout(300);
    }
  }

  throw createBjhDeterministicError(
    `百家号作品描述写入校验失败（尝试 ${maxAttempts} 次后仍与期望不一致，确定性失败，不再重试）：当前="${
      lastAfter.normText
    }"，期望="${wantNorm}"，计数器="${lastAfter.counterText || "未读到"}"`,
    "BJH_DESC_WRITE_MISMATCH"
  );
}

// 发布前终检：百家号在视频解析完成后可能异步把文件名回填进作品描述。
// 这里只做完全相等校验，不等则走 fillBjhDescription 清空重写（绝不追加），仍不等抛确定性失败中止发布。
export async function ensureBjhDescription(
  page,
  desc,
  { maxAttempts = 3 } = {}
) {
  const wantNorm = normBjhDesc(desc);
  if (!wantNorm) return { ok: true, text: "", counterText: "" };

  const before = await readBjhDescSnapshot(page);
  console.log(
    `[bjh][desc] 发布前终检读取: found=${before.found} textContent=${JSON.stringify(
      before.rawText
    )} counter=${JSON.stringify(before.counterText || "未读到")} expect=${JSON.stringify(
      wantNorm
    )}`
  );
  if (!before.found) {
    throw createBjhDeterministicError(
      "百家号作品描述终检找不到编辑器（确定性失败：页面可能改版，不再重试）",
      "BJH_DESC_EDITOR_MISSING"
    );
  }
  if (bjhDescOk(before.rawText, wantNorm)) {
    return {
      ok: true,
      text: before.normText,
      counterText: before.counterText,
    };
  }
  console.warn(
    `[bjh][desc] 发布前终检不一致，当前=${JSON.stringify(
      before.normText
    )}，期望=${JSON.stringify(wantNorm)}，开始清空重写`
  );
  const rewritten = await fillBjhDescription(page, desc, { maxAttempts });
  await page.waitForTimeout(800);
  const verified = await readBjhDescSnapshot(page);
  console.log(
    `[bjh][desc] 发布前终检复核: textContent=${JSON.stringify(
      verified.rawText
    )} counter=${JSON.stringify(verified.counterText || "未读到")}`
  );
  if (!bjhDescOk(verified.rawText, wantNorm)) {
    throw createBjhDeterministicError(
      `百家号作品描述被页面改写且无法纠正（确定性失败，不再重试）：当前="${
        verified.normText
      }"，期望="${wantNorm}"，计数器="${verified.counterText || "未读到"}"`,
      "BJH_DESC_REWRITTEN"
    );
  }
  return {
    ok: true,
    text: verified.normText,
    counterText: verified.counterText || rewritten.counterText,
  };
}

export default async function (page, data, window, event) {
  // 发布模式下一旦派发过点击，后续任何异常都无法排除已发出 → 外层不得整体重试（宁漏勿重）
  let bjhClickDispatched = false;
  const text = buildPlatformVideoTextDetailed("百家号", data.data || {});
  const wantDesc = text.description || text.ksFillText || text.title || "";
  const bjhRuleAdjustments = mergeRuleAdjustments(
    data.ruleAdjustments || (data.data && data.data.ruleAdjustments),
    text.adjustments
  );
  const bjhAdjSummary = formatRuleAdjustmentsSummary(bjhRuleAdjustments);
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;
  // 使用try-catch包装所有可能出错的操作
  try {
    await page.waitForTimeout(2000);
    // 百家号新版页面把上传 input 挂到了 .pages-videoV2-index 下；
    // 兼容老版 .video-main-container：用 OR 选择器一起等。
    const UPLOAD_SELECTORS = [
      '.pages-videoV2-index input[type="file"]',
      '.video-main-container input[type="file"]',
    ];
    const combinedSelector = UPLOAD_SELECTORS.join(", ");
    await page.waitForSelector(combinedSelector, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    const uploadInputs = await page.$$(combinedSelector);
    if (!uploadInputs.length) throw new Error("未找到百家号上传 input");
    const uploadFileHandle = uploadInputs[0];
    await uploadFileHandle.uploadFile(path.resolve(data.filePath));
    console.log(`[bjh] 已通过 ${combinedSelector} 上传文件`);
  } catch (err) {
    console.error("文件上传失败:", err);
    // 不抛出错误，继续执行后续步骤
  }

  // 表单填写（作品描述 + 创作声明）与提交统一纳入顶层失败上报，
  // 确保描述写入/校验等确定性失败立即带 noRetry:true 中止，不触发外层 5 次重复上传。
  try {
    console.log("[bjh] 等待发布表单就绪...");
    // 上传完成后页面会重渲染，先等"创作声明" input 出现，作为表单完整渲染的信号
    try {
      await page.waitForSelector('input[placeholder="请选择创作声明"]', {
        visible: true,
        timeout: 60 * 1000,
      });
      console.log("[bjh] 发布表单已就绪（声明 input 已出现）");
    } catch (_) {
      console.warn("[bjh] 等待声明 input 超时，按当前 DOM 继续尝试找作品描述框");
    }
    // 再等一拍，避免 transition 过程中 DOM 还在变
    await page.waitForTimeout(800);

    // 打印页面上所有 input / textarea / contenteditable，便于定位表单真实选择器
    const fieldDump = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll("input")].map((el) => ({
        tag: "input",
        id: el.id || "",
        placeholder: el.placeholder || "",
        type: el.type || "",
        maxlength: el.getAttribute("maxlength") || "",
        readonly: el.readOnly,
      }));
      const textareas = [...document.querySelectorAll("textarea")].map(
        (el) => ({
          tag: "textarea",
          id: el.id || "",
          placeholder: el.placeholder || "",
          maxlength: el.getAttribute("maxlength") || "",
          readonly: el.readOnly,
          class: el.className || "",
        })
      );
      const editables = [
        ...document.querySelectorAll('[contenteditable="true"]'),
      ].map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        class: el.className || "",
        placeholder:
          el.getAttribute("data-placeholder") ||
          el.getAttribute("placeholder") ||
          "",
        text: (el.textContent || "").slice(0, 60),
      }));
      return { inputs, textareas, editables };
    });
    console.log("[bjh] inputs:", JSON.stringify(fieldDump.inputs));
    console.log("[bjh] textareas:", JSON.stringify(fieldDump.textareas));
    console.log("[bjh] contenteditable:", JSON.stringify(fieldDump.editables));

    try {
      await page.waitForSelector(BJH_DESC_SELECTOR, { timeout: 20 * 1000 });
    } catch (_) {
      throw createBjhDeterministicError(
        "未找到百家号作品描述 contenteditable 编辑器（确定性失败：页面可能改版，不再重试）",
        "BJH_DESC_EDITOR_MISSING"
      );
    }

    await fillBjhDescription(page, wantDesc);
    console.log("[bjh] 作品描述已写入并通过严格校验");

    // 作品描述填完后立即选择创作声明（必须声明）
    try {
      console.log("选择创作声明");
      await selectBjhCreativeStatement(page, data);
    } catch (e) {
      console.warn("百家号创作声明选择未完成:", e?.message || e);
    }

    // 等待 .upload-step-progress  .progress-container.uploading 消失
    // 用 pollPageUntil 替代 waitForSelector，避免 puppeteer 默认 protocolTimeout
    // (约 180s) 在弱网/大文件下把 CDP Runtime.callFunctionOn 提前砍掉。
    await pollPageUntil(
      page,
      () =>
        !document.querySelector(
          ".upload-step-progress .progress-container.uploading"
        ),
      WAIT_UPLOAD_PROCESSING_MS,
      2000,
      "等待百家号视频上传完成超时"
    );
    await page.waitForTimeout(1000);

    const actionText = isDraftMode ? "存草稿" : "发布";

    // 草稿 / 发布 二选一点击，不能两个都点（先点存草稿会改变页面状态，发布按钮就摸不到了）
    try {
      await waitForBjhActionButtonReady(page, actionText);
    } catch (waitErr) {
      const btnState = await getBjhActionButtonState(page, actionText);
      console.log(`[bjh] ${actionText}按钮状态:`, JSON.stringify(btnState));
      if (btnState.found && btnState.disabled) {
        throw new Error(
          `${actionText}按钮不可用（视频质量不足或未满足发布条件），请在本页查看原因`
        );
      }
      throw waitErr;
    }

    // 基于操作区容器左上角的固定偏移量点击：
    //   存草稿：left 500px, top 30px
    //   发布：  left 700px, top 30px
    const opRoot = await page.$(".op-list.op-list-wrap-videoV2");
    const box = opRoot ? await opRoot.boundingBox() : null;
    if (!box)
      throw new Error(
        "未找到百家号操作区容器或无 boundingBox (.op-list .op-list-wrap-videoV2)"
      );
    console.log(
      "[bjh] 操作区 box=",
      JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height })
    );

    const cx = box.x + (isDraftMode ? 500 : 700);
    const cy = box.y + 30;

    // 点击前先等 #cover-tabs-container 下的 .cheetah-progress-inner 消失，
    // 有则表示视频仍在上传中，等待最长 5 分钟。
    console.log(
      "[bjh] 检查视频是否仍在上传（#cover-tabs-container .cheetah-progress-inner）..."
    );
    await pollPageUntil(
      page,
      "(function(){" +
        "var container = document.querySelector('#cover-tabs-container');" +
        "if (!container) return true;" +
        "return !container.querySelector('.cheetah-progress-inner');" +
        "})()",
      5 * 60 * 1000,
      2000,
      "等待百家号视频上传进度条消失超时"
    ).catch((e) =>
      console.warn("[bjh] 进度条等待超时，强行继续:", e?.message || e)
    );
    console.log("[bjh] 视频上传进度条已消失，准备点击");

    // 2026-11-22 线上事故：成功提示图标不是 info-circle 时被当失败，循环连点「发布」，
    // 同一视频被发了 5 次。规则（宁漏勿重）：发布与存草稿都只点一次，点过之后任何失败
    // 都不在本窗口重点、也不让外层重开窗口（catch 里带 noRetry），交用户核对后手动补发。
    const urlBefore = readPageUrl(page);
    // 视频解析完成后百家号可能把文件名回填进作品描述：先终检并清空重写，再等旧提示消失，
    // 最后只读复核；若等待期间又被回填，清空重写后再等一次提示消失，确保点击前内容完全一致。
    await ensureBjhDescription(page, wantDesc);
    const waitToastHidden = () =>
      page
        .waitForSelector(".cheetah-message.cheetah-message-top", {
          hidden: true,
          timeout: 8000,
        })
        .then(() => true)
        .catch(() => false);
    let staleToastBefore = !(await waitToastHidden());
    const descSnapNow = await readBjhDescSnapshot(page).catch(() => ({
      found: false,
      rawText: "",
      normText: "",
      counterText: "",
    }));
    if (normBjhDesc(wantDesc) && !bjhDescOk(descSnapNow.rawText, wantDesc)) {
      console.warn(
        `[bjh][desc] 等待提示期间作品描述变为 ${JSON.stringify(
          descSnapNow.normText
        )}（计数器=${JSON.stringify(
          descSnapNow.counterText || "未读到"
        )}），重新清空写入`
      );
      await ensureBjhDescription(page, wantDesc);
      staleToastBefore = !(await waitToastHidden());
      const descSnapFinal = await readBjhDescSnapshot(page).catch(() => ({
        found: false,
        rawText: "",
        normText: "",
        counterText: "",
      }));
      if (!bjhDescOk(descSnapFinal.rawText, wantDesc)) {
        throw createBjhDeterministicError(
          `百家号作品描述点击前再次被页面改写（确定性失败，不再重试）：当前="${
            descSnapFinal.normText
          }"，期望="${normBjhDesc(wantDesc)}"，计数器="${
            descSnapFinal.counterText || "未读到"
          }"，已停止${isDraftMode ? "存草稿" : "发布"}`,
          "BJH_DESC_REWRITTEN_BEFORE_CLICK"
        );
      }
    }
    if (staleToastBefore) console.warn("[bjh] 点击前旧提示未消失，点击后读到的提示可能是残留");

    bjhClickDispatched = true;
    await page.mouse.click(cx, cy, { delay: 80 });
    console.log(
      `[bjh] 点击「${actionText}」at (${Math.round(cx)}, ${Math.round(cy)})（只点一次）`
    );

    let msg = null;
    try {
      const appeared = await page
        .waitForSelector(".cheetah-message.cheetah-message-top", {
          visible: true,
          timeout: 10000,
        })
        .then(() => true)
        .catch(() => false);
      if (appeared) {
        msg = await page.evaluate(function () {
          var el = document.querySelector(".cheetah-message.cheetah-message-top");
          if (!el) return null;
          var icon = el.querySelector('span[role="img"]');
          return {
            type: icon ? icon.getAttribute("aria-label") || "unknown" : "unknown",
            text: (el.innerText || el.textContent || "").trim().slice(0, 120),
          };
        });
      }
    } catch (readErr) {
      console.log(`[bjh] 读取提示出错（多半页面已跳转），视为已点击: ${readErr?.message || readErr}`);
      msg = null;
    }

    if (msg) console.log(`[bjh] 消息提示: type=${msg.type} text="${msg.text}"`);
    else console.log(`[bjh] 未读到提示，视为已点击`);
    if (msg && msg.type === "close-circle" && !/成功/.test(msg.text)) {
      const preValidation =
        !staleToastBefore &&
        /^(请|未)先?(添加|上传|填写|选择|设置|输入|完成)|不能为空|不能少于|不能超过/.test(
          msg.text || ""
        );
      throw new Error(
        preValidation
          ? `百家号点击「${actionText}」后出现校验提示：${msg.text}。未自动重试；请先到百家号后台核对是否已${isDraftMode ? "存成草稿" : "发出"}，确认没有再处理后手动重发`
          : `百家号点击「${actionText}」后出现失败提示：${msg.text || msg.type}。为防重复${isDraftMode ? "存草稿" : "发布"}未自动重试，请先到百家号后台核对是否已${isDraftMode ? "存成" : "发出"}再决定是否重发`
      );
    }

    console.log(
      isDraftMode ? "✅ 百家号视频已保存草稿" : "✅ 百家号视频上传成功"
    );
    const bjhBaseSuccessMsg = isDraftMode ? "保存草稿成功" : "上传成功";
    await replyPublishOutcome({
      page,
      data,
      window,
      event,
      urlBefore,
      isDraftMode,
      successMessage: bjhAdjSummary
        ? `${bjhBaseSuccessMsg}（规则调整：${bjhAdjSummary}）`
        : bjhBaseSuccessMsg,
      extraPayload:
        bjhRuleAdjustments.length > 0
          ? {
              ruleAdjustments: bjhRuleAdjustments,
              ruleAdjustmentsSummary: bjhAdjSummary,
            }
          : {},
    });
  } catch (err) {
    const failMessage = err?.message || "上传失败";
    const noRetry = bjhClickDispatched || isBjhNoRetryError(err);
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: failMessage,
      closeWindow: false,
      extraPayload:
        // 1) 发布/存草稿一旦派发过点击，任何失败（含「请添加横版封面」等校验提示）都不整体重试（宁漏勿重）；
        // 2) 作品描述写入/校验等确定性失败同样标记 noRetry，避免外层 5 次重复上传视频。
        noRetry ? { noRetry: true } : {},
    });
    console.error("百家号发布失败:", err);
  }
}
