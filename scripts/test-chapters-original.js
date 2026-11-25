"use strict";

/**
 * S18 综合单测：发布时 AI 自动章节（抖音/快手/小红书）+ 原创声明（小红书/视频号）
 *
 * 覆盖：
 * 1. 字段解析与默认值（publishExtras / publishThrottle / xlsx / CLI / HTTP / MCP）
 * 2. 平台适用性过滤（未支持平台忽略且不污染 options/records）
 * 3. AI 自动章节（dy/ks/xhs）：已开启、点选成功、首次未选中重试一次成功、重试失败告警继续+诊断、
 *    短视频不支持/无入口告警继续+诊断、关闭时不触碰页面、回执「章节：已开启/不支持/失败」
 * 4. 原创声明（xhs/xhsChrome/sph）：勾选+条款+确认弹窗+回读成功、无原创资格（置灰或页面提示）中止且文案含
 *    「账号无原创资格，可在发布设置关闭原创声明」、入口缺失/弹窗失败/回读失败中止（绝不点发布/草稿）、
 *    关闭时不触碰页面（sph 不再静默点击）
 * 5. 与 creativeStatement 并存与统一复核（回归）：互不覆盖、互不关闭弹窗、联检补选创作声明并复核原创、
 *    历史记录 CSV 独立列与 GUI Vue 模板编译检查
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "test/.cache/s18");
fs.mkdirSync(outDir, { recursive: true });

// --- 轻量假 DOM 引擎（支持 document + wujie shadowRoot + CSS 选择器子集） ---
class FakeElement {
  constructor(tag, { attrs = {}, text = "", checked = false, disabled = false, hidden = false, rect = { x: 10, y: 10, width: 120, height: 32 }, onClick = null } = {}) {
    this.nodeType = 1;
    this.tagName = String(tag || "div").toUpperCase();
    this.attrs = {};
    for (const [k, v] of Object.entries(attrs || {})) {
      this.attrs[k] = String(v);
    }
    this._text = String(text || "");
    this.children = [];
    this.parentElement = null;
    this.checked = Boolean(checked);
    this.disabled = Boolean(disabled);
    this.hidden = Boolean(hidden);
    this._rect = rect;
    this._onClick = onClick;
    this.shadowRoot = null;
    this.isConnected = true;
    this.clickCount = 0;
    this.events = [];
  }
  get className() {
    return this.attrs.class || "";
  }
  set className(v) {
    this.attrs.class = String(v || "");
  }
  get id() {
    return this.attrs.id || "";
  }
  set id(v) {
    this.attrs.id = String(v || "");
  }
  get type() {
    return this.attrs.type || "";
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v || "");
    this.children = [];
  }
  get innerText() {
    return this.textContent;
  }
  get outerHTML() {
    const attrStr = Object.entries(this.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    const open = attrStr ? `<${this.tagName.toLowerCase()} ${attrStr}>` : `<${this.tagName.toLowerCase()}>`;
    return `${open}${this.textContent}</${this.tagName.toLowerCase()}>`;
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      child.parentElement = null;
      child.isConnected = false;
    }
  }
  getAttribute(name) {
    if (name === "disabled" && this.disabled) return "";
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attrs[name];
  }
  getBoundingClientRect() {
    return this.hidden ? { x: 0, y: 0, width: 0, height: 0 } : this._rect;
  }
  checkVisibility() {
    let cur = this;
    while (cur) {
      if (cur.hidden) return false;
      cur = cur.parentElement;
    }
    return this._rect.width > 0 && this._rect.height > 0;
  }
  scrollIntoView() {}
  focus() {}
  async uploadFile() {}
  async boundingBox() {
    return this.getBoundingClientRect();
  }
  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  matches(selector) {
    return matchSelectorList(this, selector);
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matches(selector)) out.push(ch);
        walk(ch);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  click() {
    this.clickCount += 1;
    if (typeof this._onClick === "function") {
      this._onClick(this);
    }
  }
  dispatchEvent(ev) {
    this.events.push(ev && ev.type);
    if (ev && ev.type === "click") {
      this.click();
    }
    return true;
  }
}

function matchSimpleSelector(el, simple) {
  let s = simple.trim();
  if (!s) return false;
  if (s === "*") return true;
  // 伪类 :first-child / :last-child
  let pseudo = "";
  const pseudoMatch = s.match(/:(first-child|last-child)$/);
  if (pseudoMatch) {
    pseudo = pseudoMatch[1];
    s = s.slice(0, -pseudoMatch[0].length);
  }
  if (pseudo) {
    const siblings = (el.parentElement && el.parentElement.children) || [];
    if (pseudo === "first-child" && siblings[0] !== el) return false;
    if (pseudo === "last-child" && siblings[siblings.length - 1] !== el) return false;
  }
  // 提取属性选择器 [k="v"] / [k*='v'] / [k]
  const attrRegex = /\[([^\]=*]+)(?:(\*?=)(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g;
  let m;
  while ((m = attrRegex.exec(s)) !== null) {
    const key = m[1].trim();
    const op = m[2];
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5];
    const actual = el.getAttribute(key);
    if (!op) {
      if (actual === null) return false;
    } else if (op === "=") {
      if (actual !== val) return false;
    } else if (op === "*=") {
      if (actual === null || !String(actual).includes(val)) return false;
    }
  }
  s = s.replace(attrRegex, "");
  // 类名与标签
  const parts = s.split(".").filter((p, idx) => idx === 0 || p.length > 0);
  const tagPart = s.startsWith(".") ? "" : parts.shift() || "";
  if (tagPart) {
    const idSplit = tagPart.split("#");
    const tag = idSplit[0];
    const id = idSplit[1];
    if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    if (id && el.id !== id) return false;
  }
  const classTokens = String(el.className || "").split(/\s+/).filter(Boolean);
  for (const cls of parts) {
    const cleanCls = cls.split("#")[0];
    if (cleanCls && !classTokens.includes(cleanCls)) return false;
    const idInCls = cls.split("#")[1];
    if (idInCls && el.id !== idInCls) return false;
  }
  return true;
}

function matchComplexSelector(el, complex) {
  const normalized = complex.trim().replace(/\s*>\s*/g, " > ");
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (!matchSimpleSelector(el, tokens[tokens.length - 1])) return false;
  let cur = el.parentElement;
  let i = tokens.length - 2;
  while (i >= 0) {
    if (tokens[i] === ">") {
      i -= 1;
      if (i < 0 || !cur || !matchSimpleSelector(cur, tokens[i])) return false;
      cur = cur.parentElement;
      i -= 1;
      continue;
    }
    let found = false;
    while (cur) {
      if (matchSimpleSelector(cur, tokens[i])) {
        found = true;
        cur = cur.parentElement;
        break;
      }
      cur = cur.parentElement;
    }
    if (!found) return false;
    i -= 1;
  }
  return true;
}

function matchSelectorList(el, selector) {
  const list = String(selector || "").split(",");
  for (const item of list) {
    if (item.trim() && matchComplexSelector(el, item)) return true;
  }
  return false;
}

function createFakePage(rootEl) {
  const body = rootEl || new FakeElement("body");
  const fakeDoc = {
    body,
    documentElement: body,
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    getElementById: (id) => body.querySelector(`[id="${id}"]`),
  };
  let mouseClicks = 0;
  let currentUrl = "https://creator.example.test/publish";
  const page = {
    _doc: fakeDoc,
    _body: body,
    _setUrl(u) { currentUrl = u; },
    url() { return currentUrl; },
    async waitForTimeout() {},
    async waitForSelector(sel) {
      const el = fakeDoc.querySelector(sel);
      if (el) return el;
      return {
        uploadFile: async () => {},
        click: async () => {},
        evaluate: async () => "测试标题",
        boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 80 }),
      };
    },
    async $(sel) {
      const el = fakeDoc.querySelector(sel);
      if (el) {
        return Object.assign(el, {
          uploadFile: async () => {},
          boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 80 }),
        });
      }
      return {
        uploadFile: async () => {},
        click: async () => {},
        evaluate: async () => "测试标题",
        boundingBox: async () => ({ x: 0, y: 0, width: 600, height: 80 }),
      };
    },
    async $$(sel) {
      return [await page.$(sel)];
    },
    async click(sel) {
      const el = fakeDoc.querySelector(sel);
      if (el) el.click();
    },
    async type() {},
    async waitForFunction() { return true; },
    keyboard: {
      async press() {},
      async down() {},
      async up() {},
      async type() {},
    },
    mouse: {
      async move() {},
      async click() {
        mouseClicks += 1;
        const btn = fakeDoc.querySelector("xhs-publish-btn");
        if (btn && btn.parentElement) btn.parentElement.removeChild(btn);
        currentUrl = "https://creator.xiaohongshu.com/publish/success";
      },
    },
    getMouseClicks() { return mouseClicks; },
    async evaluate(fnOrStr, ...args) {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevMouseEvent = global.MouseEvent;
      global.document = fakeDoc;
      global.window = { innerWidth: 1280, innerHeight: 800, getSelection: () => null };
      global.MouseEvent = function MouseEvent(type, opts) {
        this.type = type;
        Object.assign(this, opts || {});
      };
      try {
        if (typeof fnOrStr === "string") {
          return eval(fnOrStr); // eslint-disable-line no-eval
        }
        return fnOrStr(...args);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.MouseEvent = prevMouseEvent;
      }
    },
  };
  return page;
}

// --- 使用 esbuild 打包待测 ESM 模块（mock 截图与外围边界） ---
async function bundleForTest(entryRel, outName, extraPlugins = []) {
  const outfile = path.join(outDir, outName);
  await esbuild.build({
    entryPoints: [path.join(root, entryRel)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external: ["electron", "puppeteer-core"],
    plugins: extraPlugins,
  });
  delete require.cache[require.resolve(outfile)];
  return require(outfile);
}

const mockShotPath = path.join(outDir, "mock-shot.cjs");
fs.writeFileSync(
  mockShotPath,
  `"use strict";
global.__s18ShotCalls = global.__s18ShotCalls || [];
module.exports = {
  capturePublishFailureScreenshot: async function(page, data) {
    global.__s18ShotCalls.push({ pt: data && data.pt, stage: data && data._diagStage });
    return "/tmp/mock-diag.png";
  },
};
`
);

const mockClosePath = path.join(outDir, "mock-close.cjs");
fs.writeFileSync(
  mockClosePath,
  `"use strict"; module.exports = function maybeClosePublishWindow() {}; module.exports.default = module.exports;\n`
);

const mockTimeoutsPath = path.join(outDir, "mock-timeouts.cjs");
fs.writeFileSync(
  mockTimeoutsPath,
  `"use strict";
module.exports = {
  WAIT_SELECTOR_APPEAR_MS: 50,
  WAIT_UPLOAD_PROCESSING_MS: 50,
  CLI_PUBLISH_TIMEOUT_MS: 5000,
  pollPageUntil: async function() { return true; },
};
`
);

const uploadMockPlugin = {
  name: "upload-mocks",
  setup(b) {
    b.onResolve({ filter: /failureScreenshot\.js$/ }, () => ({ path: mockShotPath }));
    b.onResolve({ filter: /closeWindow\.js$/ }, () => ({ path: mockClosePath }));
    b.onResolve({ filter: /uploadTimeouts\.js$/ }, () => ({ path: mockTimeoutsPath }));
  },
};

const fastTimeouts = {
  afterClickDelayMs: 0,
  agreementDelayMs: 0,
  afterConfirmDelayMs: 0,
  dialogTimeoutMs: 60,
  readbackTimeoutMs: 60,
  pollIntervalMs: 10,
};

async function runTests() {
  const origWarn = console.warn;
  const origLog = console.log;
  const origError = console.error;
  const capturedWarns = [];
  const quiet = (fn) => async () => {
    console.warn = (...a) => capturedWarns.push(a.join(" "));
    console.log = () => {};
    console.error = () => {};
    try {
      return await fn();
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
    }
  };

  // ================================================================
  // 1. 共享模块 publishExtras / publishThrottle / textSanitize / CSV
  // ================================================================
  const publishExtras = await bundleForTest("src/shared/publishExtras.js", "publishExtras.cjs");
  const parsePublishArgsMod = await bundleForTest("src/main/cli/parsePublishArgs.js", "parsePublishArgs.cjs");
  const publishHistoryCsv = await bundleForTest("src/shared/publishHistoryCsv.js", "publishHistoryCsv.cjs");
  const publishThrottle = require("../src/shared/publishThrottle.js");
  const textSanitize = require("../src/shared/textSanitize.js");

  // 1a. 平台适用性过滤
  for (const pt of ["抖音", "dy", "快手", "ks", "小红书", "xhs"]) {
    assert.strictEqual(publishExtras.platformSupportsAiChapters(pt), true, `aiChapters 应支持 ${pt}`);
  }
  for (const pt of ["视频号", "sph", "哔哩哔哩", "blbl", "百家号", "bjh", "头条", "tt", "番茄视频", "fqsp"]) {
    assert.strictEqual(publishExtras.platformSupportsAiChapters(pt), false, `aiChapters 不应支持 ${pt}`);
  }
  for (const pt of ["小红书", "xhs", "视频号", "sph"]) {
    assert.strictEqual(publishExtras.platformSupportsOriginalStatement(pt), true, `originalStatement 应支持 ${pt}`);
  }
  for (const pt of ["抖音", "dy", "快手", "ks", "哔哩哔哩", "blbl", "百家号", "bjh", "头条", "tt", "番茄视频", "fqsp"]) {
    assert.strictEqual(publishExtras.platformSupportsOriginalStatement(pt), false, `originalStatement 不应支持 ${pt}`);
  }

  // 1b. 默认值与优先级（显式 > 账号设置 > 全局设置 > true）
  const rDefaultXhs = publishExtras.resolvePublishExtrasForPlatform("小红书", {});
  assert.strictEqual(rDefaultXhs.aiChapters, true);
  assert.strictEqual(rDefaultXhs.originalStatement, true);

  const rGlobalOff = publishExtras.resolvePublishExtrasForPlatform("小红书", {
    globalSettings: { defaultAiChapters: false, defaultOriginalStatement: false },
  });
  assert.strictEqual(rGlobalOff.aiChapters, false);
  assert.strictEqual(rGlobalOff.originalStatement, false);

  const rAccOverride = publishExtras.resolvePublishExtrasForPlatform("小红书", {
    accountSettings: { aiChapters: true, originalStatement: false },
    globalSettings: { defaultAiChapters: false, defaultOriginalStatement: true },
  });
  assert.strictEqual(rAccOverride.aiChapters, true);
  assert.strictEqual(rAccOverride.originalStatement, false);

  const rExplicitOverride = publishExtras.resolvePublishExtrasForPlatform("小红书", {
    explicitAiChapters: false,
    explicitOriginalStatement: true,
    accountSettings: { aiChapters: true, originalStatement: false },
    globalSettings: { defaultAiChapters: true, defaultOriginalStatement: false },
  });
  assert.strictEqual(rExplicitOverride.aiChapters, false);
  assert.strictEqual(rExplicitOverride.originalStatement, true);

  const rUnsupportedBjh = publishExtras.resolvePublishExtrasForPlatform("百家号", {
    explicitAiChapters: true,
    explicitOriginalStatement: true,
  });
  assert.strictEqual(rUnsupportedBjh.aiChapters, undefined);
  assert.strictEqual(rUnsupportedBjh.originalStatement, undefined);
  assert.deepStrictEqual(publishExtras.buildPlatformExtrasPatch("百家号", rUnsupportedBjh), {});

  // 1c. 回执文案与无原创资格报错文案
  assert.strictEqual(publishExtras.formatAiChaptersReceipt("enabled"), "章节：已开启");
  assert.strictEqual(publishExtras.formatAiChaptersReceipt("unsupported"), "章节：不支持");
  assert.strictEqual(publishExtras.formatAiChaptersReceipt("failed"), "章节：失败");
  assert.strictEqual(publishExtras.appendPublishReceiptNote("上传成功", "章节：已开启"), "上传成功（章节：已开启）");
  assert.strictEqual(
    publishExtras.appendPublishReceiptNote("上传成功（章节：已开启）", "章节：已开启"),
    "上传成功（章节：已开启）"
  );
  const noQualErr = publishExtras.createNoOriginalQualificationError("视频号", "按钮置灰");
  assert.ok(
    noQualErr.message.includes("账号无原创资格，可在发布设置关闭原创声明"),
    noQualErr.message
  );
  assert.strictEqual(noQualErr.originalStatementError, true);
  assert.strictEqual(noQualErr.noOriginalQualification, true);

  // 1d. publishThrottle 全局默认设置
  const defThrottle = publishThrottle.createDefaultPublishThrottleSettings();
  assert.strictEqual(defThrottle.defaultAiChapters, true);
  assert.strictEqual(defThrottle.defaultOriginalStatement, true);
  const normThrottle = publishThrottle.normalizePublishThrottleSettings({
    defaultAiChapters: false,
    defaultOriginalStatement: false,
  });
  assert.strictEqual(normThrottle.defaultAiChapters, false);
  assert.strictEqual(normThrottle.defaultOriginalStatement, false);
  assert.strictEqual(
    publishThrottle.validatePublishThrottleSettings({ defaultAiChapters: "yes" }).ok,
    false
  );
  assert.strictEqual(
    publishThrottle.validatePublishThrottleSettings({ defaultOriginalStatement: 1 }).ok,
    false
  );

  // 1e. xlsx 列「AI章节」「原创声明」解析，与「创作声明」互不覆盖
  const xlsxRows = textSanitize.normalizeBatchXlsxRows([
    { 文件名: "a.mp4", 标题: "视频A", 创作声明: "ai_generated", AI章节: "否", 原创声明: "是" },
    { 文件名: "b.mp4", 标题: "视频B", 创作声明: "none", AI章节: "是", 原创声明: "否" },
    { 文件名: "c.mp4", 标题: "视频C" },
  ]);
  assert.strictEqual(xlsxRows[0].creativeStatement, "ai_generated");
  assert.strictEqual(xlsxRows[0].aiChapters, false);
  assert.strictEqual(xlsxRows[0].originalStatement, true);
  assert.strictEqual(xlsxRows[1].creativeStatement, "none");
  assert.strictEqual(xlsxRows[1].aiChapters, true);
  assert.strictEqual(xlsxRows[1].originalStatement, false);
  assert.strictEqual(xlsxRows[2].aiChapters, null);
  assert.strictEqual(xlsxRows[2].originalStatement, null);

  // ================================================================
  // 2. CLI 与 HTTP 参数解析 + 平台过滤 + 优先级 + 回归
  // ================================================================
  const cliDyOff = parsePublishArgsMod.parsePublishArgs([
    "-p", "dy", "--phone", "13800138000", "-f", "/tmp/a.mp4", "-t", "标题",
    "--no-ai-chapters", "--original",
  ]);
  assert.strictEqual(cliDyOff.ok, true);
  assert.strictEqual(cliDyOff.value.aiChapters, false);
  assert.strictEqual(cliDyOff.value.originalStatement, null); // 抖音不支持原创声明 → 忽略
  assert.deepStrictEqual(cliDyOff.value.publishOptions, {}); // 不污染 publishOptions

  const cliSphOff = parsePublishArgsMod.parsePublishArgs([
    "-p", "sph", "--phone", "13800138000", "-f", "/tmp/a.mp4", "-t", "标题",
    "--ai-chapters", "--no-original", "--cs", "ai_generated",
  ]);
  assert.strictEqual(cliSphOff.ok, true);
  assert.strictEqual(cliSphOff.value.aiChapters, null); // 视频号不支持 AI 章节 → 忽略
  assert.strictEqual(cliSphOff.value.originalStatement, false);
  assert.strictEqual(cliSphOff.value.creativeStatement, "ai_generated");

  const cliXhsBoth = parsePublishArgsMod.parsePublishArgs([
    "-p", "xhs", "--phone", "13800138000", "-f", "/tmp/a.mp4", "-t", "标题",
    "--ai-chapters", "--original", "--cs", "fiction",
  ]);
  assert.strictEqual(cliXhsBoth.ok, true);
  assert.strictEqual(cliXhsBoth.value.aiChapters, true);
  assert.strictEqual(cliXhsBoth.value.originalStatement, true);
  assert.strictEqual(cliXhsBoth.value.creativeStatement, "fiction");

  const helpTxt = parsePublishArgsMod.publishHelpText();
  assert.ok(helpTxt.includes("--ai-chapters") && helpTxt.includes("--no-ai-chapters"));
  assert.ok(helpTxt.includes("--original") && helpTxt.includes("--no-original"));
  assert.ok(helpTxt.includes("AI章节") && helpTxt.includes("原创声明"));

  // HTTP 多平台解析 + 默认开启 + 按平台过滤 + 账号设置回退 + 覆盖
  const httpMulti = parsePublishArgsMod.parseMultiPublishRequest(
    {
      file: "/tmp/a.mp4",
      title: "多平台测试",
      phone: "13800138000",
      creativeStatement: "ai_generated",
      platforms: [
        { platform: "dy" },
        { platform: "ks", aiChapters: false },
        { platform: "xhs" },
        { platform: "sph" },
        { platform: "bjh", aiChapters: true, originalStatement: true },
      ],
    },
    {
      defaultAiChapters: true,
      defaultOriginalStatement: true,
      resolveAccountSettings: ({ pt }) =>
        pt === "视频号" ? { originalStatement: false } : {},
    }
  );
  assert.strictEqual(httpMulti.ok, true);
  const byPt = Object.fromEntries(httpMulti.value.map((v) => [v.platform, v]));
  assert.strictEqual(byPt["抖音"].aiChapters, true);
  assert.strictEqual(byPt["抖音"].originalStatement, undefined);
  assert.strictEqual(byPt["快手"].aiChapters, false);
  assert.strictEqual(byPt["快手"].originalStatement, undefined);
  assert.strictEqual(byPt["小红书"].aiChapters, true);
  assert.strictEqual(byPt["小红书"].originalStatement, true);
  assert.strictEqual(byPt["小红书"].creativeStatement, "ai_generated");
  assert.strictEqual(byPt["视频号"].aiChapters, undefined);
  assert.strictEqual(byPt["视频号"].originalStatement, false); // 来自账号发布设置
  assert.strictEqual(byPt["百家号"].aiChapters, undefined);
  assert.strictEqual(byPt["百家号"].originalStatement, undefined);

  // HTTP 单平台 platformOptions 优先于顶层
  const httpPlatOpt = parsePublishArgsMod.parseMultiPublishRequest({
    platform: "dy",
    file: "/tmp/a.mp4",
    title: "测试",
    phone: "13800138000",
    aiChapters: false,
    platformOptions: { dy: { aiChapters: true } },
  });
  assert.strictEqual(httpPlatOpt.ok, true);
  assert.strictEqual(httpPlatOpt.value.aiChapters, true);

  // HTTP 非法非布尔参数应返回 400 错误
  const httpBad = parsePublishArgsMod.parseMultiPublishRequest({
    platform: "xhs",
    file: "/tmp/a.mp4",
    title: "测试",
    phone: "13800138000",
    originalStatement: "invalid_val",
  });
  assert.strictEqual(httpBad.ok, false);

  // ================================================================
  // 3. MCP publish.ts 工具定义、参数透传与错误透传
  // ================================================================
  const mockRunnerPath = path.join(outDir, "mock-mcp-runner.cjs");
  fs.writeFileSync(
    mockRunnerPath,
    `"use strict";
global.__s18McpCalls = [];
global.__s18McpNextResult = { exitCode: 0, lastJson: { status: true, resultStatus: "success", aiChapters: true, aiChaptersStatus: "enabled", originalStatement: true, originalStatementStatus: "enabled", message: "上传成功（章节：已开启）" }, stderr: "" };
module.exports = {
  runCli: async function(cliArgs) {
    global.__s18McpCalls.push(cliArgs);
    return global.__s18McpNextResult;
  },
};
`
  );
  const mcpPublish = await bundleForTest("mcp/src/tools/publish.ts", "mcpPublish.cjs", [
    {
      name: "mock-runner",
      setup(b) {
        b.onResolve({ filter: /runner\.js$/ }, () => ({ path: mockRunnerPath }));
      },
    },
  ]);
  assert.strictEqual(mcpPublish.publishVideoTool.inputSchema.properties.aiChapters.type, "boolean");
  assert.strictEqual(mcpPublish.publishVideoTool.inputSchema.properties.originalStatement.type, "boolean");

  // 显式传 false 透传 --no-ai-chapters / --no-original
  const mcpRes1 = JSON.parse(
    await mcpPublish.handlePublishVideo({
      platform: "xhs",
      file: "/tmp/a.mp4",
      title: "MCP测试",
      phone: "13800138000",
      aiChapters: false,
      originalStatement: false,
    })
  );
  const lastArgs1 = global.__s18McpCalls[global.__s18McpCalls.length - 1];
  assert.ok(lastArgs1.includes("--no-ai-chapters"));
  assert.ok(lastArgs1.includes("--no-original"));
  assert.strictEqual(mcpRes1.aiChaptersStatus, "enabled");
  assert.strictEqual(mcpRes1.originalStatementStatus, "enabled");

  // 未传时不注入开关（交由 CLI 账号/全局设置生效）
  await mcpPublish.handlePublishVideo({
    platform: "xhs",
    file: "/tmp/a.mp4",
    title: "MCP默认",
    phone: "13800138000",
  });
  const lastArgs2 = global.__s18McpCalls[global.__s18McpCalls.length - 1];
  assert.ok(!lastArgs2.includes("--ai-chapters") && !lastArgs2.includes("--no-ai-chapters"));
  assert.ok(!lastArgs2.includes("--original") && !lastArgs2.includes("--no-original"));

  // exitCode 3 原创资格失败透传 stderr 明确报错
  global.__s18McpNextResult = {
    exitCode: 3,
    lastJson: null,
    stderr: "小红书原创声明失败：账号无原创资格，可在发布设置关闭原创声明，已中止本条小红书发布，未发布",
  };
  await assert.rejects(
    mcpPublish.handlePublishVideo({
      platform: "xhs",
      file: "/tmp/a.mp4",
      title: "MCP无资格",
      phone: "13800138000",
    }),
    /账号无原创资格，可在发布设置关闭原创声明/
  );

  // ================================================================
  // 4. 平台 DOM 自动化：dy / ks / xhs AI 自动章节
  // ================================================================
  const dyMod = await bundleForTest("src/main/services/upLoad/dy.js", "dy.cjs", [uploadMockPlugin]);
  const ksMod = await bundleForTest("src/main/services/upLoad/ks.js", "ks.cjs", [uploadMockPlugin]);
  const xhsMod = await bundleForTest("src/main/services/upLoad/xhs.js", "xhs.cjs", [uploadMockPlugin]);
  const xhsChromeMod = await bundleForTest("src/main/services/upLoad/xhsChrome.js", "xhsChrome.cjs", [uploadMockPlugin]);
  const sphMod = await bundleForTest("src/main/services/upLoad/sph.js", "sph.cjs", [uploadMockPlugin]);

  // 检查集中配置导出存在
  assert.ok(dyMod.DY_AI_CHAPTERS_SELECTORS.aiOptionKeywords.length > 0);
  assert.ok(ksMod.KS_AI_CHAPTERS_SELECTORS.aiOptionKeywords.length > 0);
  assert.ok(xhsMod.XHS_AI_CHAPTERS_SELECTORS.aiOptionKeywords.length > 0);
  assert.ok(xhsMod.XHS_ORIGINAL_STATEMENT_SELECTORS.noQualificationPatterns.length > 0);
  assert.ok(sphMod.SPH_ORIGINAL_STATEMENT_SELECTORS.noQualificationPatterns.length > 0);

  // 4a. 抖音 AI 章节：首次未选中 → 重试一次成功
  await quiet(async () => {
    const body = new FakeElement("body");
    const row = body.appendChild(new FakeElement("div", { attrs: { class: "chapter-row" } }));
    row.appendChild(new FakeElement("span", { text: "AI自动添加章节" }));
    let clicks = 0;
    const sw = row.appendChild(
      new FakeElement("div", {
        attrs: { class: "semi-switch", role: "switch", "aria-checked": "false" },
        onClick(self) {
          clicks += 1;
          if (clicks >= 2) self.setAttribute("aria-checked", "true");
        },
      })
    );
    const page = createFakePage(body);
    const res = await dyMod.applyDyAiChapters(page, { data: { pt: "抖音" }, timeouts: fastTimeouts });
    assert.strictEqual(res.status, "enabled");
    assert.strictEqual(res.receiptText, "章节：已开启");
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(sw.clickCount, 2);
  })();

  // 4b. 快手 AI 章节：重试两次仍未选中 → 告警 + 截图，不抛错中止，返回「章节：失败」
  await quiet(async () => {
    global.__s18ShotCalls = [];
    const body = new FakeElement("body");
    const row = body.appendChild(new FakeElement("div", { attrs: { class: "chapter-block" } }));
    row.appendChild(new FakeElement("span", { text: "智能生成章节" }));
    const sw = row.appendChild(
      new FakeElement("button", {
        attrs: { class: "ant-switch", role: "switch", "aria-checked": "false" },
        onClick() { /* 模拟页面吞点击，状态不变 */ },
      })
    );
    const page = createFakePage(body);
    const res = await ksMod.applyKsAiChapters(page, { data: { pt: "快手" }, timeouts: fastTimeouts });
    assert.strictEqual(res.status, "failed");
    assert.strictEqual(res.receiptText, "章节：失败");
    assert.strictEqual(res.attempts, 2);
    assert.strictEqual(sw.clickCount, 2);
    assert.ok(global.__s18ShotCalls.length >= 1, "失败应留诊断截图");
  })();

  // 4c. 小红书 AI 章节：短视频不支持（无入口或明确提示时长不足）→ 不抛错，返回「章节：不支持」
  await quiet(async () => {
    global.__s18ShotCalls = [];
    const body = new FakeElement("body");
    body.appendChild(new FakeElement("div", { text: "视频章节：当前视频时长不足，暂不支持自动生成章节" }));
    const page = createFakePage(body);
    const res = await xhsMod.applyXhsAiChapters(page, { data: { pt: "小红书" }, timeouts: fastTimeouts });
    assert.strictEqual(res.status, "unsupported");
    assert.strictEqual(res.receiptText, "章节：不支持");
    assert.ok(global.__s18ShotCalls.length >= 1, "不支持应留诊断截图以便校准");
  })();

  // 4d. 折叠入口展开后勾选 AI 章节（dy）
  await quiet(async () => {
    const body = new FakeElement("body");
    const opener = body.appendChild(
      new FakeElement("button", {
        text: "添加章节",
        onClick() {
          const panel = body.appendChild(new FakeElement("div", { attrs: { class: "chapter-panel" } }));
          const lb = panel.appendChild(new FakeElement("label", { attrs: { class: "semi-checkbox" }, text: "AI自动生成章节" }));
          const inp = lb.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));
          lb._onClick = () => { inp.checked = true; };
        },
      })
    );
    const page = createFakePage(body);
    const res = await dyMod.applyDyAiChapters(page, { data: { pt: "抖音" }, timeouts: fastTimeouts });
    assert.strictEqual(opener.clickCount, 1);
    assert.strictEqual(res.status, "enabled");
    assert.strictEqual(res.receiptText, "章节：已开启");
  })();

  // ================================================================
  // 5. 原创声明（xhs & sph）：成功 / 无资格中止 / 失败中止 / 关闭不触碰 / 联检回归
  // ================================================================

  // 5a. 小红书原创声明：勾选 → 条款弹窗 + 确认 → 回读成功
  await quiet(async () => {
    const body = new FakeElement("body");
    const row = body.appendChild(new FakeElement("div", { attrs: { class: "original-row" } }));
    const cbWrap = row.appendChild(new FakeElement("label", { attrs: { class: "d-checkbox" }, text: "原创声明" }));
    const cbInp = cbWrap.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));

    cbWrap._onClick = () => {
      // 弹出原创条款确认弹窗
      const modal = body.appendChild(new FakeElement("div", { attrs: { class: "d-modal", role: "dialog" } }));
      modal.appendChild(new FakeElement("div", { text: "原创声明确认：请阅读原创保护条款" }));
      const agreeLabel = modal.appendChild(new FakeElement("label", { attrs: { class: "d-checkbox" }, text: "我已阅读并同意原创声明协议" }));
      const agreeInp = agreeLabel.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));
      const confirmBtn = modal.appendChild(new FakeElement("button", { text: "确认声明", disabled: true }));
      agreeLabel._onClick = () => {
        agreeInp.checked = true;
        confirmBtn.disabled = false;
      };
      confirmBtn._onClick = () => {
        cbInp.checked = true;
        body.removeChild(modal);
      };
    };

    const page = createFakePage(body);
    const res = await xhsMod.applyXhsOriginalStatement(page, { data: { pt: "小红书" }, timeouts: fastTimeouts });
    assert.strictEqual(res.status, "enabled");
    assert.strictEqual(cbInp.checked, true);
  })();

  // 5b. 小红书原创声明：入口置灰 / 无资格提示 → 抛错含精准文案
  await quiet(async () => {
    const body = new FakeElement("body");
    const row = body.appendChild(new FakeElement("div", { attrs: { class: "original-row" } }));
    const sw = row.appendChild(
      new FakeElement("div", {
        attrs: { class: "d-switch d-switch-disabled", role: "switch", "aria-disabled": "true" },
        text: "原创声明（暂无原创资格）",
      })
    );
    const page = createFakePage(body);
    await assert.rejects(
      xhsMod.applyXhsOriginalStatement(page, { data: { pt: "小红书" }, timeouts: fastTimeouts }),
      (err) => {
        assert.ok(err.message.includes("账号无原创资格，可在发布设置关闭原创声明"), err.message);
        assert.strictEqual(err.originalStatementError, true);
        assert.strictEqual(err.noOriginalQualification, true);
        return true;
      }
    );
    assert.strictEqual(sw.clickCount, 0);
  })();

  // 5c. 视频号原创声明（wujie shadowRoot）：两步确认弹窗成功
  function createSphShadowBody() {
    const body = new FakeElement("body");
    const host = body.appendChild(new FakeElement("wujie-app", { attrs: { class: "wujie_iframe" } }));
    const shadow = new FakeElement("div");
    host.shadowRoot = shadow;
    return { body, shadow };
  }

  await quiet(async () => {
    const { body, shadow } = createSphShadowBody();
    const wrap = shadow.appendChild(new FakeElement("div", { attrs: { class: "declare-original-checkbox" } }));
    const label = wrap.appendChild(new FakeElement("label", { attrs: { class: "ant-checkbox-wrapper" }, text: "声明原创" }));
    const inp = label.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));

    label._onClick = () => {
      // 弹窗 1：协议弹窗
      const dlg1 = shadow.appendChild(new FakeElement("div", { attrs: { class: "weui-desktop-dialog" } }));
      const bd1 = dlg1.appendChild(new FakeElement("div", { attrs: { class: "weui-desktop-dialog__bd" } }));
      const proto = bd1.appendChild(new FakeElement("span", { attrs: { class: "protocol-text" }, text: "原创声明协议" }));
      const btn1 = dlg1.appendChild(new FakeElement("button", { attrs: { class: "weui-desktop-btn_primary" }, text: "声明原创", disabled: true }));
      proto._onClick = () => { btn1.disabled = false; };
      btn1._onClick = () => {
        shadow.removeChild(dlg1);
        // 弹窗 2：二次确认框
        const outer2 = shadow.appendChild(new FakeElement("div", { attrs: { class: "declare-original-dialog" } }));
        const dlg2 = outer2.appendChild(new FakeElement("div", { attrs: { class: "weui-desktop-dialog" } }));
        const ag2 = dlg2.appendChild(new FakeElement("label", { attrs: { class: "ant-checkbox-wrapper" }, text: "我已阅读并同意条款" }));
        const ag2Inp = ag2.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));
        const btn2 = dlg2.appendChild(new FakeElement("button", { attrs: { class: "weui-desktop-btn_primary" }, text: "确定", disabled: true }));
        ag2._onClick = () => {
          ag2Inp.checked = true;
          btn2.disabled = false;
        };
        btn2._onClick = () => {
          inp.checked = true;
          shadow.removeChild(outer2);
        };
      };
    };

    const page = createFakePage(body);
    const res = await sphMod.applySphOriginalStatement(page, { data: { pt: "视频号" }, timeouts: fastTimeouts });
    assert.strictEqual(res.status, "enabled");
    assert.strictEqual(inp.checked, true);
  })();

  // 5d. 视频号原创声明：点击后弹窗提示「暂无原创资格」→ 中止发布且文案准确
  await quiet(async () => {
    const { body, shadow } = createSphShadowBody();
    const wrap = shadow.appendChild(new FakeElement("div", { attrs: { class: "declare-original-checkbox" } }));
    const label = wrap.appendChild(new FakeElement("label", { attrs: { class: "ant-checkbox-wrapper" }, text: "声明原创" }));
    label.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false }));
    label._onClick = () => {
      const dlg = shadow.appendChild(new FakeElement("div", { attrs: { class: "weui-desktop-dialog" } }));
      dlg.appendChild(new FakeElement("div", { text: "当前账号未满足条件，暂无原创资格" }));
    };
    const page = createFakePage(body);
    await assert.rejects(
      sphMod.applySphOriginalStatement(page, { data: { pt: "视频号" }, timeouts: fastTimeouts }),
      /账号无原创资格，可在发布设置关闭原创声明/
    );
  })();

  // 5e. 视频号端到端流：originalStatement=false 不触碰原创框；originalStatement=true 无资格中止且绝不点发表/草稿
  await quiet(async () => {
    const makeSphFullPage = ({ allowOriginal, noQual }) => {
      const { body, shadow } = createSphShadowBody();
      // 描述与短标题输入框（让前段顺利通过）
      const descBox = shadow.appendChild(new FakeElement("div", { attrs: { class: "post-desc-box" } }));
      descBox.appendChild(new FakeElement("div", { attrs: { class: "input-editor" }, text: "测试描述" }));
      // 视频标注（creativeStatement）
      const mark = shadow.appendChild(new FakeElement("div", { attrs: { class: "post-with-mark-tag" } }));
      const selDisp = mark.appendChild(new FakeElement("div", { attrs: { class: "select-display" }, text: "无标注" }));
      selDisp._onClick = () => {
        const opt = shadow.appendChild(new FakeElement("div", { attrs: { class: "mark-tag-option" } }));
        opt.appendChild(new FakeElement("span", { attrs: { class: "option-main" }, text: "含AI生成内容" }));
        opt._onClick = () => {
          selDisp.textContent = "含AI生成内容";
          shadow.removeChild(opt);
        };
      };
      // 原创声明框
      const origWrap = shadow.appendChild(new FakeElement("div", { attrs: { class: "declare-original-checkbox" } }));
      const origLabel = origWrap.appendChild(
        new FakeElement("label", {
          attrs: { class: noQual ? "ant-checkbox-wrapper ant-checkbox-wrapper-disabled" : "ant-checkbox-wrapper" },
          text: noQual ? "声明原创（无原创资格）" : "声明原创",
          disabled: Boolean(noQual),
        })
      );
      const origInp = origLabel.appendChild(
        new FakeElement("input", { attrs: { type: "checkbox" }, checked: false, disabled: Boolean(noQual) })
      );
      if (allowOriginal) {
        origLabel._onClick = () => { origInp.checked = true; };
      }
      // 发表/保存草稿按钮（对齐 SPH_DRAFT_BUTTON_SELECTOR / SPH_PUBLISH_BUTTON_SELECTOR）
      const submitWrap = shadow.appendChild(new FakeElement("div", { attrs: { class: "form-btns" } }));
      const draftDiv = submitWrap.appendChild(new FakeElement("div"));
      const draftBtn = draftDiv.appendChild(new FakeElement("button", { attrs: { class: "weui-desktop-btn_default" }, text: "保存草稿" }));
      const pubDiv = submitWrap.appendChild(new FakeElement("div"));
      const pubBtn = pubDiv.appendChild(new FakeElement("button", { attrs: { class: "weui-desktop-btn_primary" }, text: "发表" }));
      pubBtn._onClick = () => { page._setUrl("https://channels.weixin.qq.com/platform/post/list"); };
      const page = createFakePage(body);
      // Mock readSphField 的 desc/shortTitle 写入
      const origEval = page.evaluate.bind(page);
      page.evaluate = async (fn, ...a) => {
        if (typeof fn === "function" && fn.toString().includes("isValue")) return "测试描述";
        return origEval(fn, ...a);
      };
      return { page, origLabel, origInp, pubBtn, draftBtn, selDisp };
    };

    // Case 1: originalStatement=false → 完全不触碰原创框，creativeStatement 正常选中并发表
    const s1 = makeSphFullPage({ allowOriginal: true, noQual: false });
    const replies1 = [];
    await sphMod.default(
      s1.page,
      {
        pt: "视频号",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "测试描述", tags: [], creativeStatement: "ai_generated", originalStatement: false },
      },
      {},
      { reply: (_ch, p) => replies1.push(p) }
    );
    assert.strictEqual(s1.origLabel.clickCount, 0, "originalStatement=false 不应点击视频号原创框");
    assert.strictEqual(s1.selDisp.textContent, "含AI生成内容");
    assert.strictEqual(s1.pubBtn.clickCount, 1);
    assert.strictEqual(replies1[0].status, true);

    // Case 2: originalStatement=true 且无原创资格 → 中止发布，绝不点击发表或保存草稿，报错文案精准
    const s2 = makeSphFullPage({ allowOriginal: false, noQual: true });
    const replies2 = [];
    await sphMod.default(
      s2.page,
      {
        pt: "视频号",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "测试描述", tags: [], creativeStatement: "ai_generated", originalStatement: true },
      },
      {},
      { reply: (_ch, p) => replies2.push(p) }
    );
    assert.strictEqual(s2.pubBtn.clickCount, 0, "无原创资格绝不能点击发表");
    assert.strictEqual(s2.draftBtn.clickCount, 0, "无原创资格绝不能点击保存草稿");
    assert.strictEqual(replies2[0].status, false);
    assert.ok(
      replies2[0].message.includes("账号无原创资格，可在发布设置关闭原创声明"),
      replies2[0].message
    );
    assert.strictEqual(replies2[0].originalStatementStatus, "no_qualification");

    // Case 3: originalStatement=true 且与 creativeStatement 并存 → 两者同时选中并联合复核通过
    const s3 = makeSphFullPage({ allowOriginal: true, noQual: false });
    const replies3 = [];
    await sphMod.default(
      s3.page,
      {
        pt: "视频号",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "测试描述", tags: [], creativeStatement: "ai_generated", originalStatement: true },
      },
      {},
      { reply: (_ch, p) => replies3.push(p) }
    );
    assert.strictEqual(s3.selDisp.textContent, "含AI生成内容");
    assert.strictEqual(s3.origInp.checked, true);
    assert.strictEqual(s3.pubBtn.clickCount, 1);
    assert.strictEqual(replies3[0].status, true);
    assert.strictEqual(replies3[0].originalStatementStatus, "enabled");
  })();

  // 5f. 统一复核（verifySphDeclarations & verifyXhsDeclarations）捕获丢态
  await quiet(async () => {
    const { body, shadow } = createSphShadowBody();
    const mark = shadow.appendChild(new FakeElement("div", { attrs: { class: "post-with-mark-tag" } }));
    const selDisp = mark.appendChild(new FakeElement("div", { attrs: { class: "select-display" }, text: "无标注" }));
    selDisp._onClick = () => {
      const opt = shadow.appendChild(new FakeElement("div", { attrs: { class: "mark-tag-option" } }));
      opt.appendChild(new FakeElement("span", { attrs: { class: "option-main" }, text: "含AI生成内容" }));
      opt._onClick = () => { selDisp.textContent = "含AI生成内容"; shadow.removeChild(opt); };
    };
    const wrap = shadow.appendChild(new FakeElement("div", { attrs: { class: "declare-original-checkbox" } }));
    const lb = wrap.appendChild(new FakeElement("label", { attrs: { class: "ant-checkbox-wrapper" }, text: "声明原创" }));
    const inp = lb.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: true }));
    const page = createFakePage(body);
    // 创作声明被清空但原创仍在 → 联检补选创作声明并通过
    await sphMod.verifySphDeclarations(page, { creativeStatement: "ai_generated", originalStatement: true });
    assert.strictEqual(selDisp.textContent, "含AI生成内容");
    assert.strictEqual(inp.checked, true);

    // 若原创勾选丢失 → 联检必须抛错中止
    inp.checked = false;
    await assert.rejects(
      sphMod.verifySphDeclarations(page, { creativeStatement: "ai_generated", originalStatement: true }),
      /原创声明设置失败/
    );
  })();

  // 5g. 小红书（含 xhsChrome）端到端：原创开启成功 + 章节不支持不中止 + creativeStatement 并存；原创失败中止不点发布
  await quiet(async () => {
    const makeXhsFullPage = ({ origNoQual, chaptersEnabled }) => {
      const body = new FakeElement("body");
      body.appendChild(new FakeElement("input", { attrs: { class: "upload-input", type: "file" } }));
      const titleBox = body.appendChild(new FakeElement("div", { attrs: { class: "publish-page-content-base" } }));
      const editC = titleBox.appendChild(new FakeElement("div", { attrs: { class: "edit-container" } }));
      const dIn = editC.appendChild(new FakeElement("div", { attrs: { class: "d-input" } }));
      dIn.appendChild(new FakeElement("input", { attrs: { class: "d-text" } }));
      body.appendChild(new FakeElement("div", { attrs: { class: "tiptap ProseMirror" }, text: "正文" }));
      // 内容类型声明 .d-select
      const stmtSel = body.appendChild(new FakeElement("div", { attrs: { class: "d-select" } }));
      const stmtPh = stmtSel.appendChild(new FakeElement("span", { attrs: { class: "d-select-placeholder" }, text: "添加内容类型声明" }));
      stmtSel._onClick = () => {
        const optsWrap = body.appendChild(new FakeElement("div", { attrs: { class: "d-options-wrapper" } }));
        const gi = optsWrap.appendChild(new FakeElement("div", { attrs: { class: "d-grid-item", style: "grid-area: 1 / 1" } }));
        const optRow = gi.appendChild(new FakeElement("div", { attrs: { class: "d-option" } }));
        optRow.appendChild(new FakeElement("span", { attrs: { class: "d-option-name" }, text: "笔记含AI合成内容" }));
        optRow._onClick = () => {
          stmtPh.textContent = "笔记含AI合成内容";
          body.removeChild(optsWrap);
        };
      };
      // 原创声明
      const origRow = body.appendChild(new FakeElement("div", { attrs: { class: "original-row" } }));
      const origCb = origRow.appendChild(
        new FakeElement("label", {
          attrs: { class: origNoQual ? "d-checkbox d-checkbox-disabled" : "d-checkbox" },
          text: origNoQual ? "原创声明（暂无原创资格）" : "原创声明",
          disabled: Boolean(origNoQual),
        })
      );
      const origInp = origCb.appendChild(new FakeElement("input", { attrs: { type: "checkbox" }, checked: false, disabled: Boolean(origNoQual) }));
      origCb._onClick = () => { if (!origNoQual) origInp.checked = true; };

      // 章节（可选）
      if (chaptersEnabled) {
        const chRow = body.appendChild(new FakeElement("div", { attrs: { class: "chapter-row" } }));
        const chSw = chRow.appendChild(new FakeElement("div", { attrs: { class: "d-switch", role: "switch", "aria-checked": "false" }, text: "AI自动添加章节" }));
        chSw._onClick = () => { chSw.setAttribute("aria-checked", "true"); };
      }

      const pubBtn = body.appendChild(new FakeElement("xhs-publish-btn", { attrs: { "submit-disabled": "false" } }));
      const page = createFakePage(body);
      return { page, origCb, origInp, stmtPh, pubBtn };
    };

    // 通过 xhsChrome：原创成功 + 章节不支持告警继续 + 回执写「章节：不支持」
    let disconnected = false;
    const browser = { disconnect: () => { disconnected = true; } };
    const x1 = makeXhsFullPage({ origNoQual: false, chaptersEnabled: false });
    const x1Replies = [];
    await xhsChromeMod.default(
      x1.page,
      {
        pt: "小红书",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "正文", tags: [], creativeStatement: "ai_generated", aiChapters: true, originalStatement: true },
      },
      browser,
      { reply: (_ch, p) => x1Replies.push(p) }
    );
    assert.strictEqual(disconnected, true);
    assert.strictEqual(x1.origInp.checked, true);
    assert.strictEqual(x1.stmtPh.textContent, "笔记含AI合成内容");
    assert.strictEqual(x1.page.getMouseClicks(), 1);
    assert.strictEqual(x1Replies[0].status, true, `x1 reply failed: ${JSON.stringify(x1Replies[0])}`);
    assert.strictEqual(x1Replies[0].aiChaptersStatus, "unsupported");
    assert.strictEqual(x1Replies[0].originalStatementStatus, "enabled");
    assert.ok(x1Replies[0].message.includes("章节：不支持"), x1Replies[0].message);

    // 小红书原创无资格：中止发布，绝不点击发布按钮
    const x2 = makeXhsFullPage({ origNoQual: true, chaptersEnabled: true });
    const x2Replies = [];
    await xhsMod.default(
      x2.page,
      {
        pt: "小红书",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "正文", tags: [], creativeStatement: "ai_generated", aiChapters: true, originalStatement: true },
      },
      {},
      { reply: (_ch, p) => x2Replies.push(p) }
    );
    assert.strictEqual(x2.page.getMouseClicks(), 0, "小红书无原创资格绝不能点击发布");
    assert.strictEqual(x2Replies[0].status, false);
    assert.ok(x2Replies[0].message.includes("账号无原创资格，可在发布设置关闭原创声明"), x2Replies[0].message);
    assert.strictEqual(x2Replies[0].originalStatementStatus, "no_qualification");

    // 小红书 aiChapters=false & originalStatement=false → 均不触碰
    const x3 = makeXhsFullPage({ origNoQual: false, chaptersEnabled: true });
    const x3Replies = [];
    await xhsMod.default(
      x3.page,
      {
        pt: "小红书",
        filePath: "fixture.mp4",
        data: { title: "测试", description: "正文", tags: [], creativeStatement: "ai_generated", aiChapters: false, originalStatement: false },
      },
      {},
      { reply: (_ch, p) => x3Replies.push(p) }
    );
    assert.strictEqual(x3.origCb.clickCount, 0);
    assert.strictEqual(x3.origInp.checked, false);
    assert.strictEqual(x3Replies[0].status, true);
    assert.ok(!x3Replies[0].message.includes("章节："));
  })();

  // ================================================================
  // 6. 历史 CSV 独立列与 GUI Vue 模板编译校验
  // ================================================================
  const csvRes = publishHistoryCsv.buildPublishHistoryCsv({
    "2026-11-25": [
      {
        bt: "历史独立列测试",
        phone: "A组",
        showAlltype: [
          {
            pt: "小红书",
            phone: "A组",
            creativeStatement: "ai_generated",
            aiChapters: true,
            aiChaptersStatus: "enabled",
            originalStatement: true,
            originalStatementStatus: "enabled",
            publishStatus: "success",
            lastPublishMessage: "上传成功（章节：已开启）",
          },
          {
            pt: "视频号",
            phone: "A组",
            creativeStatement: "fiction",
            originalStatement: true,
            originalStatementStatus: "no_qualification",
            publishStatus: "failed",
            lastPublishMessage: "账号无原创资格，可在发布设置关闭原创声明",
          },
          {
            pt: "百家号",
            phone: "A组",
            creativeStatement: "ai_generated",
            publishStatus: "success",
            lastPublishMessage: "上传成功",
          },
        ],
      },
    ],
  });
  assert.strictEqual(csvRes.recordCount, 3);
  const csvLines = csvRes.csv.replace(/^\uFEFF/, "").split("\r\n");
  assert.ok(csvLines[0].includes('"创作声明","AI章节","原创声明"'), csvLines[0]);
  assert.ok(csvLines[1].includes('"AI生成","已开启","已开启"'), csvLines[1]);
  assert.ok(csvLines[2].includes('"虚构演绎","","无原创资格"'), csvLines[2]);
  assert.ok(csvLines[3].includes('"AI生成","",""'), csvLines[3]);

  // 校验四个 Vue SFC 模板编译零错误且关键绑定完整
  for (const vueRel of [
    "src/renderer/components/LocalVideoPublish.vue",
    "src/renderer/components/PublishThrottleSettingsCard.vue",
    "src/renderer/views/accountManager/index.vue",
    "src/renderer/views/videoManager/index.vue",
  ]) {
    const src = fs.readFileSync(path.join(root, vueRel), "utf8");
    const sfc = compiler.parseComponent(src);
    assert.ok(sfc.template && sfc.template.content, `${vueRel} 应含 template`);
    const compiled = compiler.compile(sfc.template.content);
    assert.deepStrictEqual(compiled.errors, [], `${vueRel} 模板编译报错: ${compiled.errors}`);
  }
  const lvpSrc = fs.readFileSync(path.join(root, "src/renderer/components/LocalVideoPublish.vue"), "utf8");
  assert.ok(lvpSrc.includes("getPlatformAiChapters") && lvpSrc.includes("getPlatformOriginalStatement"));
  const cardSrc = fs.readFileSync(path.join(root, "src/renderer/components/PublishThrottleSettingsCard.vue"), "utf8");
  assert.ok(cardSrc.includes("defaultAiChapters") && cardSrc.includes("defaultOriginalStatement"));
  const amSrc = fs.readFileSync(path.join(root, "src/renderer/views/accountManager/index.vue"), "utf8");
  assert.ok(amSrc.includes("supportsAiChapters") && amSrc.includes("supportsOriginalStatement"));
  const vmSrc = fs.readFileSync(path.join(root, "src/renderer/views/videoManager/index.vue"), "utf8");
  assert.ok(vmSrc.includes("getHistoryExtrasTags") && vmSrc.includes("formatCreativeStatementBadge"));

  // ================================================================
  // 7. publishVideo.js 编排集成：默认值解析、账号设置优先、pushData 独立存取与回执拼装
  // ================================================================
  const mockPvUtils = path.join(outDir, "mock-pv-utils.cjs");
  fs.writeFileSync(
    mockPvUtils,
    `"use strict";
global.__s18PvStore = { account: {}, pushData: [] };
function changeData(opts) {
  if (opts.fileName === "account" && opts.type === "get") {
    return { success: true, data: global.__s18PvStore.account };
  }
  if (opts.fileName === "pushData") {
    if (opts.type === "get") return { success: true, data: { "2026-11-25": global.__s18PvStore.pushData } };
    if (opts.type === "add") {
      const rec = { ...opts.item, id: "rec_" + (global.__s18PvStore.pushData.length + 1) };
      global.__s18PvStore.pushData.push(rec);
      return { success: true, data: global.__s18PvStore.pushData };
    }
    if (opts.type === "update") {
      const idx = global.__s18PvStore.pushData.findIndex((r) => r.id === opts.item.id);
      if (idx >= 0) global.__s18PvStore.pushData[idx] = { ...global.__s18PvStore.pushData[idx], ...opts.item };
      return { success: true, data: global.__s18PvStore.pushData };
    }
  }
  return { success: true, data: {} };
}
module.exports = { changeData };
`
  );
  const mockPvPuppeteer = path.join(outDir, "mock-pv-puppeteer.cjs");
  fs.writeFileSync(
    mockPvPuppeteer,
    `"use strict";
global.__s18PvLastTask = null;
global.__s18PvNextReply = { status: true, message: "上传成功", aiChaptersStatus: "enabled", originalStatementStatus: "enabled" };
module.exports = {
  runPuppeteerTask: function(task, transport) {
    global.__s18PvLastTask = task;
    setImmediate(() => {
      transport.reply("puppeteerFile-done", {
        taskId: task.taskId,
        ...global.__s18PvNextReply,
      });
    });
  },
};
`
  );
  const mockPvThrottle = path.join(outDir, "mock-pv-throttle.cjs");
  fs.writeFileSync(
    mockPvThrottle,
    `"use strict";
global.__s18PvThrottleSettings = { defaultCreativeStatement: "ai_generated", defaultAiChapters: true, defaultOriginalStatement: true };
module.exports = {
  readPublishThrottleSettings: () => global.__s18PvThrottleSettings,
  getDefaultCreativeStatement: () => global.__s18PvThrottleSettings.defaultCreativeStatement,
  confirmThrottleReservation: async () => ({ ok: true }),
  recordThrottleEntryDirect: async () => ({ ok: true, id: "t1" }),
  releaseThrottleReservation: async () => ({ ok: true }),
  checkExistingScheduledCreativeConflict: () => ({ conflict: false, message: "" }),
  formatUtc8DateTime: () => "2026-11-25 20:00:00",
};
`
  );
  const mockPvResolveFile = path.join(outDir, "mock-pv-resolve-file.cjs");
  fs.writeFileSync(
    mockPvResolveFile,
    `"use strict";
module.exports = {
  isRemotePublishFile: () => false,
  resolvePublishFile: async (p) => ({ localPath: p, cleanup: null }),
  guessFileNameFromUrl: () => "demo.mp4",
};
`
  );
  const mockPvSched = path.join(outDir, "mock-pv-sched.cjs");
  fs.writeFileSync(
    mockPvSched,
    `"use strict";
module.exports = {
  createScheduledRecord: (item, publishAt) => ({ ...item, scheduledTask: true, scheduledPublishAt: Date.now() + 60000, scheduledPublishAtText: publishAt }),
  notifyScheduledPublishChanged: () => {},
};
`
  );
  const publishVideoMod = await bundleForTest("src/main/services/publishVideo.js", "publishVideo.cjs", [
    {
      name: "pv-mocks",
      setup(b) {
        b.onResolve({ filter: /server\/utils(\.js)?$/ }, () => ({ path: mockPvUtils }));
        b.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: mockPvPuppeteer }));
        b.onResolve({ filter: /publishThrottle\.js$/ }, () => ({ path: mockPvThrottle }));
        b.onResolve({ filter: /resolvePublishFile(\.js)?$/ }, () => ({ path: mockPvResolveFile }));
        b.onResolve({ filter: /scheduledPublish(\.js)?$/ }, () => ({ path: mockPvSched }));
        b.onResolve({ filter: /uploadTimeouts\.js$/ }, () => ({ path: mockTimeoutsPath }));
      },
    },
  ]);

  // 7a. 小红书默认开启 aiChapters & originalStatement，与 creativeStatement 并存并写入独立记录与回执
  global.__s18PvStore = { account: {}, pushData: [] };
  global.__s18PvNextReply = {
    status: true,
    message: "上传成功",
    aiChaptersStatus: "enabled",
    originalStatementStatus: "enabled",
  };
  const pvXhs = await publishVideoMod.runSingleFilePublish({
    platform: "小红书",
    phone: "13800138000",
    partition: "persist:13800138000小红书",
    file: "/tmp/demo.mp4",
    title: "小红书并存测试",
    creativeStatement: "ai_generated",
    aiChapters: null,
    originalStatement: null,
    publishOptions: {},
  });
  assert.strictEqual(pvXhs.exitCode, 0);
  assert.strictEqual(pvXhs.creativeStatement, "ai_generated");
  assert.strictEqual(pvXhs.aiChapters, true);
  assert.strictEqual(pvXhs.originalStatement, true);
  assert.strictEqual(pvXhs.aiChaptersStatus, "enabled");
  assert.strictEqual(pvXhs.originalStatementStatus, "enabled");
  assert.ok(pvXhs.message.includes("章节：已开启"), pvXhs.message);
  assert.strictEqual(global.__s18PvLastTask.data.aiChapters, true);
  assert.strictEqual(global.__s18PvLastTask.data.originalStatement, true);
  assert.strictEqual(global.__s18PvLastTask.publishOptions.aiChapters, true);
  assert.strictEqual(global.__s18PvLastTask.publishOptions.originalStatement, true);
  assert.strictEqual(global.__s18PvStore.pushData[0].aiChaptersStatus, "enabled");
  assert.strictEqual(global.__s18PvStore.pushData[0].originalStatementStatus, "enabled");
  assert.strictEqual(global.__s18PvStore.pushData[0].creativeStatement, "ai_generated");

  // 7b. 视频号账号在发布设置中关闭了 originalStatement，且请求未显式传 → 生效为 false，且不包含 aiChapters
  global.__s18PvStore = {
    account: {
      "2026-11-25": [
        { phone: "13800138000", pt: "视频号", originalStatement: false },
      ],
    },
    pushData: [],
  };
  global.__s18PvNextReply = { status: true, message: "上传成功" };
  const pvSph = await publishVideoMod.runSingleFilePublish({
    platform: "视频号",
    phone: "13800138000",
    partition: "persist:13800138000视频号",
    file: "/tmp/demo.mp4",
    title: "视频号账号关闭原创测试",
    explicitOriginalStatement: null,
    originalStatement: true, // 即使外层带了默认值，也必须以 explicit=null → 账号设置 false 为准
    publishOptions: {},
  });
  assert.strictEqual(pvSph.exitCode, 0);
  assert.strictEqual(pvSph.originalStatement, false);
  assert.strictEqual(pvSph.aiChapters, undefined);
  assert.strictEqual(global.__s18PvLastTask.data.originalStatement, false);
  assert.strictEqual(global.__s18PvLastTask.data.aiChapters, undefined);

  console.log("test-chapters-original passed (all S18 unit & DOM & UI assertions green)");
}

runTests().catch((err) => {
  console.error("test-chapters-original FAILED:", err);
  process.exit(1);
});
