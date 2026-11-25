import path from "path";
import {
  readPageUrl,
  replyPublishFailure,
  replyPublishOutcome,
} from "./publishOutcome.js";
import {
  isCreativeStatementNone,
  resolveXhsCreativeStatementLabel,
} from "../../../shared/creativeStatement.js";
import {
  WAIT_SELECTOR_APPEAR_MS,
  WAIT_UPLOAD_PROCESSING_MS,
  pollPageUntil,
} from "./uploadTimeouts.js";
import {
  getRandomDelayMs,
  getXhsSecondClickDelayMs,
} from "../../../shared/xhsPublishPolicy.js";
import {
  buildPlatformVideoTextDetailed,
  normalizeVideoTags,
} from "../../../shared/videoMetadata.js";
import {
  formatRuleAdjustmentsSummary,
  mergeRuleAdjustments,
} from "../../../shared/platformRules.js";
import { capturePublishFailureScreenshot } from "./failureScreenshot.js";
import { ALL_PLATFORM_SUBMIT_SELECTORS } from "../../../shared/collectionShared.js";
import {
  isAiChaptersRequested,
  isOriginalStatementRequested,
  appendPublishReceiptNote,
  createNoOriginalQualificationError,
  createOriginalStatementError,
} from "../../../shared/publishExtras.js";
import {
  executeAiChaptersFlow,
  executeOriginalStatementFlow,
  runOriginalStatementDomAction,
  dumpExtrasDiagnostics,
} from "../../../shared/publishExtrasDom.js";

/**
 * 小红书发布页「AI 自动章节」选择器与候选文案集中配置【未经真机校准，待真机存草稿核对】。
 * 找不到入口或短视频不支持时告警并继续发布，回执写「章节：不支持」；
 * 点选后回读未选中时重试一次，仍失败则告警继续，回执写「章节：失败」。
 */
export const XHS_AI_CHAPTERS_SELECTORS = Object.freeze({
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
    ".d-switch",
    ".d-checkbox",
    ".d-radio",
    "[role='switch']",
    "[role='checkbox']",
    "[role='radio']",
    "label",
    "input[type='checkbox']",
    "input[type='radio']",
  ],
  dialogSelectors: [
    ".d-modal",
    ".d-dialog",
    "[role='dialog']",
    "[class*='modal']",
    "[class*='dialog']",
  ],
  confirmButtonTexts: ["确定", "确认", "完成", "应用"],
  submitSelectors: [...ALL_PLATFORM_SUBMIT_SELECTORS, "xhs-publish-btn"],
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
  dispatchMouseEvents: true,
  diagSelectors: [
    "[class*='chapter']",
    "[class*='Chapter']",
    ".publish-page-content-base",
  ],
  diagKeywords: ["章节", "AI", "智能生成", "自动添加"],
});

/**
 * 小红书发布页「原创声明」选择器与候选文案集中配置【未经真机校准，待真机存草稿核对】。
 * 开启时设置失败或账号无原创资格（页面提示无资格/入口置灰）均中止本条发布。
 */
export const XHS_ORIGINAL_STATEMENT_SELECTORS = Object.freeze({
  wujieHost: "",
  entrySelectors: [
    "[class*='original'] .d-switch",
    "[class*='original'] .d-checkbox",
    "[class*='original'] input[type='checkbox']",
    "[class*='Original'] .d-switch",
    "[class*='Original'] .d-checkbox",
    "[class*='Original'] input[type='checkbox']",
  ],
  entryContainerSelectors: [
    "[class*='original']",
    "[class*='Original']",
  ],
  entryKeywords: ["原创声明", "声明原创", "申请原创", "原创保护", "标记原创"],
  toggleSelectors: [
    ".d-switch",
    ".d-checkbox",
    "[role='switch']",
    "[role='checkbox']",
    "label",
    "input[type='checkbox']",
  ],
  dialogSelectors: [
    ".d-modal",
    ".d-dialog",
    "[role='dialog']",
    "[class*='modal']",
    "[class*='dialog']",
  ],
  dialogKeywords: ["原创", "原创声明", "声明原创", "原创保护", "协议", "条款", "须知"],
  ignoreDialogPatterns: ["将此次编辑保留"],
  agreementSelectors: [
    ".d-checkbox",
    "[role='checkbox']",
    "input[type='checkbox']",
    "label",
  ],
  agreementKeywords: ["我已阅读并同意", "阅读并同意", "同意", "协议", "条款", "须知"],
  confirmButtonSelectors: ["button", "[role='button']", ".d-button"],
  confirmButtonTexts: [
    "确认声明",
    "声明原创",
    "同意并声明",
    "开启原创",
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
  submitSelectors: [...ALL_PLATFORM_SUBMIT_SELECTORS, "xhs-publish-btn"],
  submitTexts: [
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
  ],
  dispatchMouseEvents: true,
  diagSelectors: [
    "[class*='original']",
    "[class*='Original']",
    ".d-modal",
    "[role='dialog']",
  ],
  diagKeywords: ["原创声明", "声明原创", "原创", "内容类型声明"],
});

export async function applyXhsAiChapters(
  page,
  { data, window, timeouts } = {}
) {
  return executeAiChaptersFlow(page, {
    platformTag: "xhs",
    platformLabel: "小红书",
    cfg: XHS_AI_CHAPTERS_SELECTORS,
    data,
    window,
    captureScreenshot: capturePublishFailureScreenshot,
    timeouts,
  });
}

export async function applyXhsOriginalStatement(
  page,
  { data, window, timeouts } = {}
) {
  return executeOriginalStatementFlow(page, {
    platformTag: "xhs",
    platformLabel: "小红书",
    cfg: XHS_ORIGINAL_STATEMENT_SELECTORS,
    data,
    window,
    captureScreenshot: capturePublishFailureScreenshot,
    timeouts,
  });
}

async function ensureXhsStatementDropdownClosed(page) {
  try {
    const open = await page.evaluate(
      "(function(){" +
        "var w=document.querySelector('.d-options-wrapper');" +
        "if(!w)return false;" +
        "var r=typeof w.getBoundingClientRect==='function'?w.getBoundingClientRect():{width:1,height:1};" +
        "return !!(r&&r.width>0&&r.height>0);" +
        "})()"
    );
    if (open && page.keyboard && typeof page.keyboard.press === "function") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(200).catch(() => {});
    }
  } catch (_) {}
}

/**
 * 统一复核小红书「内容类型声明（creativeStatement）」与「原创声明（originalStatement）」：
 * 确认二者互不覆盖、未互相关闭或丢失状态；若创作声明被重置则补选一次并复核原创声明仍在勾选态。
 */
export async function verifyXhsDeclarations(
  page,
  { creativeStatement, originalStatement, data, window } = {}
) {
  await ensureXhsStatementDropdownClosed(page);

  const wantCreative =
    !isCreativeStatementNone(creativeStatement) &&
    XHS_SUPPORTED_STATEMENT_LABELS.has(
      resolveXhsCreativeStatementLabel(creativeStatement)
    );
  if (wantCreative) {
    const expectedLabel = resolveXhsCreativeStatementLabel(creativeStatement);
    const currentLabel = await page
      .evaluate(
        "(function(targetLabel){" +
          "var norm=function(t){return String(t||'').replace(/\\s+/g,'').trim();};" +
          "var wanted=norm(targetLabel);" +
          "var sels=document.querySelectorAll('.d-select');" +
          "for(var i=0;i<sels.length;i++){" +
          "var t=norm(sels[i].textContent||'');" +
          "if(t.indexOf(wanted)!==-1)return t;" +
          "}" +
          "return '';" +
          "})(" +
          JSON.stringify(expectedLabel) +
          ")"
      )
      .catch(() => "");
    if (!currentLabel) {
      console.warn(
        `[xhs][verify] 联合复核发现内容类型声明「${expectedLabel}」未保持，尝试补选一次`
      );
      try {
        await selectXhsCreativeStatement(page, data || { data: { creativeStatement } });
        await ensureXhsStatementDropdownClosed(page);
      } catch (e) {
        console.warn("[xhs][verify] 补选内容类型声明异常:", (e && e.message) || e);
      }
    }
  }

  if (originalStatement === true) {
    const check = await page.evaluate(runOriginalStatementDomAction, {
      action: "inspect",
      token: "",
      cfg: XHS_ORIGINAL_STATEMENT_SELECTORS,
    });
    if (check && check.noQualification) {
      await dumpExtrasDiagnostics(page, {
        platformTag: "xhs",
        platformLabel: "小红书",
        featureTag: "original-statement",
        stage: "unified-verify-no-qual",
        cfg: XHS_ORIGINAL_STATEMENT_SELECTORS,
        data,
        window,
        captureScreenshot: capturePublishFailureScreenshot,
      });
      throw createNoOriginalQualificationError(
        "小红书",
        check.noQualificationText || ""
      );
    }
    if (!check || !check.found || check.checked !== true || check.dialogOpen) {
      await dumpExtrasDiagnostics(page, {
        platformTag: "xhs",
        platformLabel: "小红书",
        featureTag: "original-statement",
        stage: "unified-verify-failed",
        cfg: XHS_ORIGINAL_STATEMENT_SELECTORS,
        data,
        window,
        captureScreenshot: capturePublishFailureScreenshot,
      });
      throw createOriginalStatementError(
        "小红书",
        "声明联检",
        check && check.dialogOpen
          ? "联合复核时原创声明确认弹窗仍未关闭"
          : "联合复核时原创声明未处于已勾选状态"
      );
    }
    console.log("[xhs][verify] 内容类型声明与原创声明统一复核通过");
  }
}

/**
 * 生成 [min, max] 范围内的随机整数，用于像素偏移、步数等非时间场景。
 * 与 getRandomDelayMs 实现一致，但语义更清晰。
 */
function getRandomInt(min, max) {
  const safeMin = Number(min) || 0;
  const safeMax = Math.max(safeMin, Number(max) || safeMin);
  return Math.round(safeMin + (safeMax - safeMin) * Math.random());
}

// 小红书下拉里直接展示的支持选项；未匹配则跳过。
const XHS_SUPPORTED_STATEMENT_LABELS = new Set([
  "笔记含AI合成内容",
  "虚构演绎，仅供娱乐",
  "内容包含营销广告",
]);

async function selectXhsCreativeStatement(page, data) {
  const value = data.data && data.data.creativeStatement;
  console.log("[xhs] creativeStatement 值 =", value);
  if (isCreativeStatementNone(value)) {
    console.log("[xhs] 无标注，小红书保持不选");
    return;
  }
  const label = resolveXhsCreativeStatementLabel(value);
  if (!XHS_SUPPORTED_STATEMENT_LABELS.has(label)) {
    console.warn(`[xhs] 当前声明值 "${value}" 在小红书没有对应选项，跳过`);
    return;
  }
  console.log("[xhs] 准备选择内容类型声明:", label);

  // 1. 找到「添加内容类型声明」对应的 .d-select 触发器，给它打临时 id 让 page.click 命中
  //    （小红书的 d-select 实际监听 mousedown，纯 el.click() 不会打开下拉）
  const triggerId = await page.evaluate(
    "(function(){" +
      "var ps=document.querySelectorAll('.d-select-placeholder');" +
      "for(var i=0;i<ps.length;i++){" +
      "if((ps[i].textContent||'').replace(/\\s+/g,'').trim()==='添加内容类型声明'){" +
      "var sel=ps[i].closest('.d-select')||ps[i].parentElement;" +
      "if(!sel)return '';" +
      "var id='__xhs_stmt_'+Date.now();" +
      "sel.setAttribute('id',id);" +
      "return id;" +
      "}" +
      "}" +
      "return '';" +
      "})()"
  );
  if (!triggerId) {
    console.warn("未找到小红书「添加内容类型声明」入口，跳过");
    return;
  }
  try {
    await page.click("#" + triggerId, { delay: 80 });
    console.log("[xhs] 已 page.click 打开内容类型声明下拉");
  } catch (e) {
    console.warn(
      "[xhs] page.click 失败，尝试 DOM 派发 mousedown:",
      e?.message || e
    );
    await page.evaluate(
      "(function(id){" +
        "var el=document.getElementById(id);" +
        "if(!el)return;" +
        "var r=el.getBoundingClientRect();" +
        "var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};" +
        "el.dispatchEvent(new MouseEvent('mousedown',o));" +
        "el.dispatchEvent(new MouseEvent('mouseup',o));" +
        "el.dispatchEvent(new MouseEvent('click',o));" +
        "})(" +
        JSON.stringify(triggerId) +
        ")"
    );
  }

  // 2. 等下拉项渲染（字符串 evaluate，避开 babel 转译）
  try {
    await page.waitForFunction(
      "(function(){" +
        "var ns=document.querySelectorAll('.d-options-wrapper .d-option-name');" +
        "for(var i=0;i<ns.length;i++){" +
        "if((ns[i].textContent||'').replace(/\\s+/g,'').trim()===" +
        JSON.stringify(label.replace(/\s+/g, "").trim()) +
        ")return true;" +
        "}" +
        "return false;" +
        "})()",
      { timeout: WAIT_SELECTOR_APPEAR_MS }
    );
  } catch (e) {
    console.warn("小红书声明下拉项未出现:", e?.message || e);
    return;
  }

  // 3. 找目标行对应的 handler：.d-options 里 handler 和 content 是兄弟 grid-item，
  //    用 style="grid-area: N / x / ..." 里的行号 N 对齐。打临时 id 后用 page.click 真鼠标事件。
  const optId = await page.evaluate(
    "(function(){" +
      "var target=" +
      JSON.stringify(label.replace(/\s+/g, "").trim()) +
      ";" +
      "var items=document.querySelectorAll('.d-options-wrapper .d-option-name');" +
      "for(var i=0;i<items.length;i++){" +
      "var t=(items[i].textContent||'').replace(/\\s+/g,'').trim();" +
      "if(t!==target)continue;" +
      "var row=items[i].closest('.d-grid-item');" +
      "if(!row)return '';" +
      // 解析 grid-area 起始行号
      "var ga=row.getAttribute('style')||'';" +
      "var m=ga.match(/grid-area:\\s*(\\d+)/);" +
      "var rowNum=m?m[1]:'';" +
      "var handler=null;" +
      "if(rowNum&&row.parentElement){" +
      "var sibs=row.parentElement.querySelectorAll('.d-grid-item');" +
      "for(var s=0;s<sibs.length;s++){" +
      "var sga=sibs[s].getAttribute('style')||'';" +
      "var sm=sga.match(/grid-area:\\s*(\\d+)/);" +
      "if(sm&&sm[1]===rowNum){" +
      "var h=sibs[s].querySelector('.d-option-handler');" +
      "if(h){handler=h;break;}" +
      "}" +
      "}" +
      "}" +
      // 兜底：找不到对应行的 handler 就退到 content 行容器
      "if(!handler)handler=items[i].closest('.d-option')||row;" +
      "var id='__xhs_opt_'+Date.now();" +
      "handler.setAttribute('id',id);" +
      "return id;" +
      "}" +
      "return '';" +
      "})()"
  );
  if (!optId) {
    console.warn("未找到小红书声明选项: " + label);
    return;
  }
  try {
    await page.click("#" + optId, { delay: 80 });
  } catch (e) {
    console.warn("[xhs] 点击选项 page.click 失败，DOM 派发:", e?.message || e);
    await page.evaluate(
      "(function(id){" +
        "var el=document.getElementById(id);" +
        "if(!el)return;" +
        "var r=el.getBoundingClientRect();" +
        "var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};" +
        "el.dispatchEvent(new MouseEvent('mousedown',o));" +
        "el.dispatchEvent(new MouseEvent('mouseup',o));" +
        "el.dispatchEvent(new MouseEvent('click',o));" +
        "})(" +
        JSON.stringify(optId) +
        ")"
    );
  }
  await page.waitForTimeout(400);

  // 4. 验证：只看声明 select 自己的 placeholder/description（按 triggerId 限定范围），
  //    避免把页面其它 .d-select-placeholder（如"添加地点"）当成结果。
  const selectedNow = await page.evaluate(
    "(function(id){" +
      "var sel=document.getElementById(id);" +
      "if(!sel)return '';" +
      "var d=sel.querySelector('.d-select-description');" +
      "var dt=d?(d.textContent||'').replace(/\\s+/g,'').trim():'';" +
      "if(dt)return dt;" +
      "var p=sel.querySelector('.d-select-placeholder');" +
      "var pt=p?(p.textContent||'').replace(/\\s+/g,'').trim():'';" +
      "if(pt&&pt!=='添加内容类型声明')return pt;" +
      "return '';" +
      "})(" +
      JSON.stringify(triggerId) +
      ")"
  );
  if (selectedNow) {
    console.log(
      "[xhs] 已选择内容类型声明: " + label + "（页面显示=" + selectedNow + "）"
    );
  } else {
    console.warn(
      "[xhs] 点了选项但未观察到 placeholder 被替换，可能没真正选中: " + label
    );
  }
}

async function closeCheckedXhsPkCoverSwitch(page) {
  const switchId = await page.evaluate(
    "(function(){" +
      "var input=document.querySelector('.pk-cover-title-wrapper input[type=\"checkbox\"]');" +
      "if(!input||!input.checked)return '';" +
      "var id='__xhs_pk_cover_switch_'+Date.now();" +
      "input.setAttribute('id',id);" +
      "return id;" +
      "})()"
  );
  if (!switchId) {
    console.log("[xhs] PK封面开关未开启，无需关闭");
    return;
  }

  try {
    await page.click("#" + switchId, { delay: 80 });
  } catch (e) {
    console.warn("[xhs] page.click 关闭PK封面失败，DOM 派发:", e?.message || e);
    await page.evaluate(
      "(function(id){" +
        "var el=document.getElementById(id);" +
        "if(!el)return;" +
        "var r=el.getBoundingClientRect();" +
        "var o={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2,button:0};" +
        "el.dispatchEvent(new MouseEvent('mousedown',o));" +
        "el.dispatchEvent(new MouseEvent('mouseup',o));" +
        "el.dispatchEvent(new MouseEvent('click',o));" +
        "})(" +
        JSON.stringify(switchId) +
        ")"
    );
  }
  await page.waitForTimeout(300);

  const stillChecked = await page.evaluate(
    "(function(id){" +
      "var el=document.getElementById(id);" +
      "if(!el)return false;" +
      "var input=el.matches('input[type=\"checkbox\"]')?el:el.querySelector('input[type=\"checkbox\"]');" +
      "return !!(input&&input.checked);" +
      "})(" +
      JSON.stringify(switchId) +
      ")"
  );
  if (stillChecked) {
    console.warn("[xhs] 已点击PK封面开关，但页面仍显示开启");
  } else {
    console.log("[xhs] 已关闭PK封面开关");
  }
}

function xhsTypeDelay() {
  return getRandomDelayMs(80, 180);
}

async function waitXhs(page, min = 1500, max = 4000) {
  await page.waitForTimeout(getRandomDelayMs(min, max));
}

export default async function (page, data, window, event) {
  const isDraftMode =
    data.publishMode === "draft" || data.publishToDraft === true;
  const text = buildPlatformVideoTextDetailed("小红书", data.data || {});
  const xhsRuleAdjustments = mergeRuleAdjustments(
    data.ruleAdjustments || (data.data && data.data.ruleAdjustments),
    text.adjustments
  );
  const xhsAdjSummary = formatRuleAdjustmentsSummary(xhsRuleAdjustments);
  console.log("小红书上传开始:", data);

  try {
    const uploadSelector = "input.upload-input[type='file']";
    await page.waitForSelector(uploadSelector, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    const uploadInput = await page.$(uploadSelector);
    if (!uploadInput) throw new Error("未找到上传 input");
    await uploadInput.uploadFile(path.resolve(data.filePath));
  } catch (err) {
    console.error("❌ 小红书文件上传失败:", err);
    // 文件上传是流程起点，失败必须重试，把异常抛给 puppeteerFile 的 actionCheckTimer
    throw new Error(`小红书文件上传失败：${err?.message || err}`);
  }

  try {
    const titleSelector =
      ".publish-page-content-base .edit-container .d-input input.d-text";
    await page.waitForSelector(titleSelector, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    const titleInput = await page.$(titleSelector);
    if (!titleInput) throw new Error("未找到标题输入框");
    // 标题上限（20字）及截断已由 src/shared/platformRules.js 统一处理
    const titleText = text.title;
    await titleInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    if (titleText) {
      await page.type(titleSelector, titleText, { delay: xhsTypeDelay() });
    }
  } catch (err) {
    console.error("❌ 小红书标题填写失败:", err);
    // 标题也是必填，挂了直接抛触发重试
    throw new Error(`小红书标题填写失败：${err?.message || err}`);
  }

  await waitXhs(page);

  // 正文/标签：用 keyboard.type + 字符串形式的 page.evaluate（避免 webpack 转译炸 "n is not defined"）
  try {
    const editorSelector = ".tiptap.ProseMirror";
    await page.waitForSelector(editorSelector, {
      timeout: WAIT_SELECTOR_APPEAR_MS,
    });
    const editor = await page.$(editorSelector);
    if (!editor) throw new Error("未找到正文编辑器");

    const descText = String(text.bodyDescription || "").trim();
    const tags = Array.isArray(text.tags)
      ? text.tags
      : normalizeVideoTags(data.data?.tags);

    // 聚焦编辑器（先 puppeteer click 定位 caret，再字符串 evaluate 调 .focus() 双保险）
    await editor.click({ clickCount: 2 });
    await waitXhs(page, 1500, 2500);
    // 注意：page.evaluate 传字符串而不是函数，webpack/babel 不会去转译它，避免 "n is not defined"
    await page.evaluate(
      "(function(){var el=document.querySelector(" +
        JSON.stringify(editorSelector) +
        ");if(el)el.focus();})()"
    );
    await waitXhs(page, 1500, 2500);
    // 清掉旧内容再输入：小红书简介为「正文+#标签」拼接，同分区恢复草稿 / 重试残留
    // 时不清空会把新正文追加成双份。与快手适配器同一套 selectAllChildren + delete。
    await page.evaluate(
      "(function(){var el=document.querySelector(" +
        JSON.stringify(editorSelector) +
        ");if(!el)return;el.focus();var s=window.getSelection();if(s&&s.selectAllChildren){s.selectAllChildren(el);if(document.execCommand)document.execCommand('delete');}})()"
    );
    await waitXhs(page, 1500, 2500);

    // 输入正文描述
    if (descText) {
      await page.keyboard.type(descText, { delay: xhsTypeDelay() });
      await waitXhs(page);
      // 校验是否真的写进去了；没有则 fallback 用 execCommand insertText
      const ok = await page.evaluate(
        "(function(){var el=document.querySelector(" +
          JSON.stringify(editorSelector) +
          ");return !!(el && (el.textContent||'').trim());})()"
      );
      if (!ok) {
        console.warn("[xhs] keyboard.type 未写入正文，尝试 execCommand 兜底");
        await page.evaluate(
          "(function(){var el=document.querySelector(" +
            JSON.stringify(editorSelector) +
            ");if(!el)return;el.focus();document.execCommand('insertText',false," +
            JSON.stringify(descText) +
            ");})()"
        );
        await waitXhs(page, 1500, 2500);
      }
    }

    // 输入标签：每个 #xxx 后 Enter 选中候选弹窗第一项
    if (tags.length) {
      if (descText) {
        await page.keyboard.press("Enter");
        await waitXhs(page);
      }
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        await page.keyboard.type("#" + tag, { delay: xhsTypeDelay() });
        await waitXhs(page); // 等小红书话题候选弹窗
        await page.keyboard.press("Enter"); // 选候选第一条 → 变成话题胶囊
        await waitXhs(page, 1500, 3000);
        if (i < tags.length - 1) {
          await page.keyboard.type(" ", { delay: xhsTypeDelay() });
        }
      }
    }
  } catch (err) {
    console.error("❌ 小红书正文/标签填写失败:", err);
    throw new Error(`小红书正文/标签填写失败：${err?.message || err}`);
  }

  await waitXhs(page);

  // === PK封面开关：不需要 PK 封面，若页面默认开启则关闭 ===
  try {
    await closeCheckedXhsPkCoverSwitch(page);
  } catch (err) {
    console.warn("小红书PK封面开关处理未完成:", err?.message || err);
  }

  // 选择内容类型声明（无标注 / 不支持值会跳过）；收起下拉避免与原创声明弹窗互相干扰
  try {
    await selectXhsCreativeStatement(page, data);
    await ensureXhsStatementDropdownClosed(page);
  } catch (e) {
    console.warn("小红书内容类型声明选择未完成:", e?.message || e);
  }

  let aiChaptersResult = null;
  let originalStatementResult = null;
  const wantOriginal = isOriginalStatementRequested(data);
  const wantAiChapters = isAiChaptersRequested(data);

  try {
    // 原创声明（默认开启；关闭时不触碰页面；开启时失败或无资格中止本条发布，绝不点击发布/暂存离开）
    if (wantOriginal) {
      originalStatementResult = await applyXhsOriginalStatement(page, {
        data,
        window,
      });
      // 与内容类型声明统一复核，确保互不覆盖且无残留弹窗
      await verifyXhsDeclarations(page, {
        creativeStatement: data.data && data.data.creativeStatement,
        originalStatement: true,
        data,
        window,
      });
    }

    // 等视频上传完成：新版小红书在 .video-plugin-title-action 出现 "重新上传" 文案表示上传完成。
    // 老版兼容：找任何带 src 的 <video>。超时 2 分钟，到点不抛错继续。
    try {
      await pollPageUntil(
        page,
        "(function(){" +
          // 1) 新版：.video-plugin-title-action 含"重新上传"
          "var actions=document.querySelectorAll('.video-plugin-title-action');" +
          "for(var i=0;i<actions.length;i++){" +
          "var t=(actions[i].textContent||'').replace(/\\s+/g,'').trim();" +
          "if(t.indexOf('重新上传')!==-1)return true;" +
          "}" +
          // 2) 老版兜底：任何 video 元素有 src
          "var vs=document.querySelectorAll('video');" +
          "for(var j=0;j<vs.length;j++){" +
          "var s=vs[j].getAttribute('src')||vs[j].currentSrc||'';" +
          "if(String(s).trim().length>0)return true;" +
          "}" +
          "return false;" +
          "})()",
        WAIT_UPLOAD_PROCESSING_MS
      );
      console.log("[xhs] 视频上传完成（重新上传按钮已出现）");
    } catch (_) {
      console.log("[xhs] 视频上传等待超时，继续走发布流程");
    }

    // AI 自动章节（视频上传就绪后处理；默认开启，关闭时不触碰页面；不支持/失败告警继续）
    if (wantAiChapters) {
      aiChaptersResult = await applyXhsAiChapters(page, { data, window });
      if (wantOriginal) {
        await verifyXhsDeclarations(page, {
          creativeStatement: data.data && data.data.creativeStatement,
          originalStatement: true,
          data,
          window,
        });
      }
    }

    // 新版发布按钮在 <xhs-publish-btn> 的 closed shadow root 里，
    // 标准 DOM API 拿不到内部 button。改用鼠标坐标点击：浏览器会自然把点击事件路由进 shadow 内部。
    // 宿主元素属性: is-publish="true" is-save-draft="true" submit-text="发布" save-text="暂存离开"
    // 内部布局是 .publish-page-publish-btn 横向 flex：左=暂存离开，右=发布
    console.log("[xhs] 等 xhs-publish-btn 宿主出现...");
    let hostHandle = null;
    try {
      hostHandle = await page.waitForSelector("xhs-publish-btn", {
        visible: true,
        timeout: 30 * 1000,
      });
    } catch (e) {
      console.warn("[xhs] 未找到 xhs-publish-btn 宿主元素:", e?.message || e);
    }
    if (!hostHandle) {
      // 老版兜底：直接找 .publish-page-publish-btn 里的 button
      hostHandle = await page.$(".publish-page-publish-btn");
    }
    if (!hostHandle) throw new Error("未找到任何可点击的发布按钮容器");

    // 等按钮变成"可点击"状态：宿主的 submit-disabled / save-disabled 属性为 false
    if (!isDraftMode) {
      console.log("[xhs] 等发布按钮 enable...");
      try {
        await pollPageUntil(
          page,
          "(function(){" +
            "var h=document.querySelector('xhs-publish-btn');" +
            "if(!h)return false;" +
            "return h.getAttribute('submit-disabled')==='false';" +
            "})()",
          30 * 1000
        );
        console.log("[xhs] 发布按钮已可用");
      } catch (_) {
        console.log("[xhs] 等发布按钮 enable 超时（30s），强行点击");
      }
    }

    // 用 page.mouse.click 在宿主对应位置点 —— 坐标会被浏览器路由进 closed shadow 内部 button
    const box = await hostHandle.boundingBox();
    if (!box) throw new Error("发布按钮宿主无 boundingBox（未渲染或被遮挡）");
    console.log(
      "[xhs] 宿主 box=",
      JSON.stringify({ x: box.x, y: box.y, w: box.width, h: box.height })
    );
    // 基于 .publish-page-publish-btn 左上角的偏移量，加入随机抖动避免被风控识别为固定坐标点击
    //   暂存离开：left ~300px, top ~40px
    //   发布：    left ~450px, top ~40px
    const jitterX = getRandomInt(-12, 12);
    const jitterY = getRandomInt(-8, 8);
    const baseX = isDraftMode ? 300 : 450;
    const baseY = 40;
    const cx = box.x + baseX + jitterX;
    const cy = box.y + baseY + jitterY;

    const targetText = isDraftMode ? "暂存离开" : "发布";
    const urlBefore = readPageUrl(page);
    let clickedOk = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // 模拟鼠标移动轨迹：先移到附近位置，再点击，避免从 (0,0) 直接跳变
      const preX = cx + getRandomInt(-20, 20);
      const preY = cy + getRandomInt(-15, 15);
      await page.mouse.move(preX, preY, { steps: getRandomInt(3, 8) });
      await page.waitForTimeout(getRandomInt(30, 80));
      await page.mouse.click(cx, cy, { delay: 80 });
      console.log(
        `[xhs] 第 ${attempt} 次点击「${targetText}」at (${Math.round(
          cx
        )},${Math.round(cy)})`
      );
      if (attempt < 2) {
        const secondClickDelay = getXhsSecondClickDelayMs();
        console.log(`[xhs] 等待 ${secondClickDelay}ms 后判断是否第二次点击`);
        await page.waitForTimeout(secondClickDelay);
      } else {
        await waitXhs(page, 2500, 4500);
      }
      // 验证成功：宿主消失/换页/属性变化
      const stillThere = await page.evaluate(
        "(function(){return !!document.querySelector('xhs-publish-btn');})()"
      );
      if (!stillThere) {
        console.log(`[xhs] xhs-publish-btn 宿主已消失，发布动作生效`);
        clickedOk = true;
        break;
      }
    }

    if (!clickedOk) {
      // 最后 dump 一下宿主属性，便于排查
      const attrDump = await page.evaluate(
        "(function(){" +
          "var h=document.querySelector('xhs-publish-btn');" +
          "if(!h)return 'host-gone';" +
          "var o={};for(var i=0;i<h.attributes.length;i++){o[h.attributes[i].name]=h.attributes[i].value;}return o;" +
          "})()"
      );
      console.warn("[xhs] 2 次点击后宿主仍在，属性:", JSON.stringify(attrDump));
      throw new Error(`未能成功点击「${targetText}」按钮`);
    }

    console.log(
      isDraftMode ? "✅ 小红书视频已保存草稿" : "✅ 小红书视频上传成功"
    );
    const xhsBaseSuccessMsg = isDraftMode ? "保存草稿成功" : "上传成功";
    const xhsMsgWithAdj = xhsAdjSummary
      ? `${xhsBaseSuccessMsg}（规则调整：${xhsAdjSummary}）`
      : xhsBaseSuccessMsg;
    const xhsFinalSuccessMsg =
      aiChaptersResult && aiChaptersResult.receiptText
        ? appendPublishReceiptNote(xhsMsgWithAdj, aiChaptersResult.receiptText)
        : xhsMsgWithAdj;
    await replyPublishOutcome({
      page,
      data,
      window,
      event,
      urlBefore,
      isDraftMode,
      successMessage: xhsFinalSuccessMsg,
      extraPayload: {
        ...(aiChaptersResult
          ? {
              aiChaptersStatus: aiChaptersResult.status,
              aiChaptersReceipt: aiChaptersResult.receiptText,
            }
          : {}),
        ...(originalStatementResult
          ? { originalStatementStatus: originalStatementResult.status }
          : {}),
        ...(xhsRuleAdjustments.length > 0
          ? {
              ruleAdjustments: xhsRuleAdjustments,
              ruleAdjustmentsSummary: xhsAdjSummary,
            }
          : {}),
      },
      // 草稿保存成功后用户需回到矩媒手动发布，web 窗口已无用，强制关闭；
      // 直接发布仍保留保守模式（closeWindowAfterPublish=false）让用户核对。
      closeWindowData: isDraftMode
        ? { ...data, closeWindowAfterPublish: true }
        : data,
    });
  } catch (err) {
    // 失败瞬间截图留证：小红书风控弹窗（如「操作过于频繁」）或原创声明失败只有截图能看出来
    const isOriginalErr = Boolean(err && err.originalStatementError);
    await replyPublishFailure({
      page,
      data,
      window,
      event,
      message: err?.message || "上传失败",
      ...(isOriginalErr
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
      closeWindow: data.closeWindowAfterPublish !== false,
    });
    console.error("❌ 小红书发布失败:", err);
  }
}
