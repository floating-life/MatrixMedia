"use strict";

/**
 * 卡 S14：抖音发布时可选「同步发布到今日头条」全链路单测
 *
 * 覆盖：
 * 1. CLI / HTTP 字段透传（--dy-sync-toutiao / --dySyncToutiao / dySyncToutiao / dy-sync-toutiao / platformOptions.dy）+ 缺省 false 不污染 publishOptions + help 文案
 * 2. dy.js 开关定位 / 状态读取 / 点击 / 回读（fake DOM）：
 *    - 已开不点（aria-checked="true"、semi-switch-checked、active、checkbox.checked=true）
 *    - 未开点一次后开（page.click 路径、safeClick 兜底路径、多平台同组不误点西瓜视频、label[for]、React 重渲染回读）
 *    - 找不到报错 + 跨行保护（提示文案跨行相邻开关、多平台缺开关不点隔壁、多开关歧义、禁用态、提交按钮红线）
 *    - 出现授权/绑定弹窗报错 + 脱敏 DOM 轮廓（≤12 字保留，>12 字打 [t:N]）
 *    - 点击后回读仍未开报错（只点一次不循环狂点）
 *    - 草稿模式（publishMode=draft）仍执行开关步骤并注明草稿不会触发同步
 * 3. dy.js handler 集成门禁：
 *    - dySyncToutiao=false 完全不碰同步开关
 *    - dySyncToutiao=true 失败中止且绝不点击发布/草稿按钮（属可重试错误，不设 noRetry）
 *    - dySyncToutiao=true 草稿模式先开开关再点存草稿
 * 4. 防重复（同时勾头条被拒）：
 *    - publishVideo.js（runSingleFilePublish / runMultiPlatformPublish / checkDySyncToutiaoConflict）
 *    - GUI LocalVideoPublish.vue（模板编译、localStorage 记住上次选择、仅抖音透传、onPlatformNext / doSubmitBatchPublish / submitDirBatchPublish 拦截）
 */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const vm = require("vm");
const { build, buildSync } = require("esbuild");
const compiler = require("vue-template-compiler");
const xlsx = require("xlsx");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "test/.cache/dy-sync-toutiao");
fs.mkdirSync(outDir, { recursive: true });

function bundle(relPath, outName, external = ["electron"]) {
  const outfile = path.join(outDir, outName);
  buildSync({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external,
  });
  delete require.cache[outfile];
  return require(outfile);
}

const parsePublish = bundle(
  "src/main/cli/parsePublishArgs.js",
  "parsePublishArgs.cjs"
);
const dyMod = bundle("src/main/services/upLoad/dy.js", "dy.cjs");
const {
  sanitizePublishCliArgs,
  sanitizePublishPayloadObject,
} = require(path.join(root, "src/shared/textSanitize.js"));

const CONFLICT_MSG =
  "已勾选头条账号，又开启抖音同步头条，会重复发布，请二选一";
const SUCCESS_LOG = "[dy] 同步今日头条已开启并回读确认";

/* ------------------------------------------------------------------ *
 * 迷你 DOM 引擎（参照 scripts/test-collection.js，无外部依赖）
 * ------------------------------------------------------------------ */

class FakeElement {
  constructor(tag = "div", text = "", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.isConnected = true;
    this._text = text;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.rect = { left: 10, top: 10, width: 120, height: 32 };
    this.onClick = null;
    this.events = [];
    if (this.tagName === "INPUT" && attrs.type === "checkbox") {
      this.type = "checkbox";
      this.checked =
        Object.prototype.hasOwnProperty.call(attrs, "checked") &&
        attrs.checked !== "false";
    }
  }
  append(...kids) {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
    }
    return this;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(
        (c) => c !== this
      );
      this.parentElement = null;
    }
    this.isConnected = false;
  }
  get className() {
    return String(this.attrs.class || "");
  }
  set className(v) {
    this.attrs.class = String(v == null ? "" : v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v == null ? "" : v);
    this.children = [];
  }
  get innerText() {
    return this.textContent;
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k)
      ? this.attrs[k]
      : null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  getBoundingClientRect() {
    return this.hidden ? { left: 0, top: 0, width: 0, height: 0 } : this.rect;
  }
  scrollIntoView() {}
  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  matchesSingle(simple) {
    const s = simple.trim();
    if (!s) return false;
    if (s === "*") return true;
    let rest = s;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    const idMatches = [...rest.matchAll(/#([\w-]+)/g)];
    if (idMatches.length) {
      const ownId = String(this.getAttribute("id") || "");
      for (const m of idMatches) {
        if (ownId !== m[1]) return false;
      }
      rest = rest.replace(/#[\w-]+/g, "");
    }
    const clsMatches = [...rest.matchAll(/\.([\w-]+)/g)];
    if (clsMatches.length) {
      const ownClasses = String(this.getAttribute("class") || "")
        .split(/\s+/)
        .filter(Boolean);
      for (const m of clsMatches) {
        if (!ownClasses.includes(m[1])) return false;
      }
      rest = rest.replace(/\.[\w-]+/g, "");
    }
    const attrMatches = [
      ...rest.matchAll(/\[([\w-]+)(?:([*^$]?)=["']([^"']*)["'])?\]/g),
    ];
    for (const m of attrMatches) {
      const attrVal = this.getAttribute(m[1]);
      if (m[2] === undefined && m[3] === undefined) {
        if (attrVal === null) return false;
      } else if (m[2] === "") {
        if (attrVal !== m[3]) return false;
      } else if (m[2] === "*") {
        if (!String(attrVal || "").includes(m[3])) return false;
      } else if (m[2] === "^") {
        if (!String(attrVal || "").startsWith(m[3])) return false;
      } else if (m[2] === "$") {
        if (!String(attrVal || "").endsWith(m[3])) return false;
      }
    }
    rest = rest.replace(/\[[\w-]+(?:[*^$]?=["'][^"']*["'])?\]/g, "");
    return rest.trim() === "";
  }
  matches(selector) {
    const matchCompoundChain = (el, chain) => {
      const checkAt = (node, idx) => {
        if (!node || !node.matchesSingle(chain[idx].sel)) return false;
        if (idx === 0) return true;
        const comb = chain[idx - 1].comb;
        if (comb === ">") return checkAt(node.parentElement, idx - 1);
        if (comb === "+") {
          const sibs = node.parentElement ? node.parentElement.children : [];
          const pos = sibs.indexOf(node);
          return pos > 0 ? checkAt(sibs[pos - 1], idx - 1) : false;
        }
        let anc = node.parentElement;
        while (anc) {
          if (checkAt(anc, idx - 1)) return true;
          anc = anc.parentElement;
        }
        return false;
      };
      return checkAt(el, chain.length - 1);
    };
    return String(selector || "")
      .split(",")
      .some((part) => {
        const trimmed = part.trim();
        if (!trimmed) return false;
        const normalized = trimmed.replace(/\s*([>+])\s*/g, " $1 ");
        const rawTokens = normalized.split(/\s+/).filter(Boolean);
        const chain = [];
        for (const tk of rawTokens) {
          if (tk === ">" || tk === "+") {
            if (!chain.length) return false;
            chain[chain.length - 1].comb = tk;
          } else {
            if (chain.length && !chain[chain.length - 1].comb) {
              chain[chain.length - 1].comb = " ";
            }
            chain.push({ sel: tk, comb: null });
          }
        }
        return chain.length > 0 && matchCompoundChain(this, chain);
      });
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    for (let n = this; n; n = n.parentElement) {
      if (n.matches(selector)) return n;
    }
    return null;
  }
  click() {
    this.events.push("click");
    if (this.onClick) this.onClick();
  }
}

function makeDoc() {
  const doc = new FakeElement("document");
  const body = new FakeElement("body");
  doc.body = body;
  doc.append(body);
  doc.getElementById = (id) => doc.querySelector(`[id="${id}"]`);
  return { doc, body };
}

function makeFakePage(doc, { withPageClick = true } = {}) {
  const clickedSelectors = [];
  const page = {
    clickedSelectors,
    async evaluate(fn, arg) {
      const prevDoc = global.document;
      const prevStyle = global.getComputedStyle;
      const prevWindow = global.window;
      global.document = doc;
      global.getComputedStyle = (el) => ({
        display: el && el.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      });
      global.window = {};
      try {
        const runner = new Function(
          "document",
          "getComputedStyle",
          "window",
          "arg",
          `return (${fn.toString()})(arg);`
        );
        return runner(doc, global.getComputedStyle, {}, arg);
      } finally {
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevStyle === undefined) delete global.getComputedStyle;
        else global.getComputedStyle = prevStyle;
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
      }
    },
    async waitForTimeout() {},
  };
  if (withPageClick) {
    page.click = async (sel) => {
      clickedSelectors.push(sel);
      const target = doc.querySelector(sel);
      if (!target) throw new Error(`No element matches ${sel}`);
      target.click();
    };
  }
  return page;
}

const FAST_TIMEOUTS = {
  locateTimeoutMs: 0,
  afterClickDelayMs: 0,
  readbackTimeoutMs: 0,
  pollIntervalMs: 0,
};

function captureLogs(fn) {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  const restore = () => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
  try {
    const res = fn(logs);
    if (res && typeof res.then === "function") {
      return res.then(
        (v) => {
          restore();
          return { result: v, logs };
        },
        (e) => {
          restore();
          e._capturedLogs = logs;
          throw e;
        }
      );
    }
    restore();
    return { result: res, logs };
  } catch (e) {
    restore();
    e._capturedLogs = logs;
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 1. CLI & HTTP 字段透传
 * ------------------------------------------------------------------ */
function testCliAndHttpPassthrough() {
  const base = ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题"];

  // 缺省 false，且不污染 publishOptions
  const off = parsePublish.parsePublishArgs(base);
  assert.strictEqual(off.ok, true);
  assert.strictEqual(off.value.dySyncToutiao, false);
  assert.deepStrictEqual(off.value.publishOptions, {});

  // CLI --dy-sync-toutiao 与 --dySyncToutiao
  for (const flag of ["--dy-sync-toutiao", "--dySyncToutiao"]) {
    const on = parsePublish.parsePublishArgs(
      sanitizePublishCliArgs([...base, flag])
    );
    assert.strictEqual(on.ok, true, on.error);
    assert.strictEqual(on.value.dySyncToutiao, true);
    assert.strictEqual(on.value.publishOptions.dySyncToutiao, true);
  }

  // 防吞 flag：-t --dy-sync-toutiao 必须报缺标题
  const swallowed = parsePublish.parsePublishArgs([
    "-p",
    "dy",
    "--phone",
    "13800138000",
    "-f",
    "./v.mp4",
    "-t",
    "--dy-sync-toutiao",
  ]);
  assert.strictEqual(swallowed.ok, false, "-t --dy-sync-toutiao 必须报错");

  // HTTP body: dySyncToutiao / dy-sync-toutiao / platformOptions.dy.dySyncToutiao
  assert.ok(
    parsePublish
      .publishBodyToArgv({ platform: "dy", dySyncToutiao: true })
      .includes("--dy-sync-toutiao")
  );
  assert.ok(
    parsePublish
      .publishBodyToArgv({ platform: "dy", "dy-sync-toutiao": true })
      .includes("--dy-sync-toutiao")
  );
  assert.ok(
    !parsePublish
      .publishBodyToArgv({ platform: "dy", dySyncToutiao: false })
      .includes("--dy-sync-toutiao")
  );
  assert.ok(
    parsePublish
      .publishBodyToArgv({
        platform: "dy",
        platformOptions: { dy: { dySyncToutiao: true } },
      })
      .includes("--dy-sync-toutiao")
  );

  const httpSingle = parsePublish.parsePublishRequest(
    sanitizePublishPayloadObject({
      platform: "dy",
      phone: "13800138000",
      file: "./v.mp4",
      title: "测试标题",
      dySyncToutiao: true,
    })
  );
  assert.strictEqual(httpSingle.ok, true, httpSingle.error);
  assert.strictEqual(httpSingle.value.dySyncToutiao, true);
  assert.strictEqual(httpSingle.value.publishOptions.dySyncToutiao, true);

  // HTTP 多平台共享透传 + 单目标覆盖关闭
  const httpMulti = parsePublish.parseMultiPublishRequest(
    sanitizePublishPayloadObject({
      phone: "13800138000",
      file: "./v.mp4",
      title: "测试标题",
      dySyncToutiao: true,
      platforms: [
        { platform: "dy" },
        { platform: "ks" },
        { platform: "dy", phone: "13900139000", dySyncToutiao: false },
      ],
    })
  );
  assert.strictEqual(httpMulti.ok, true, httpMulti.error);
  assert.strictEqual(httpMulti.value[0].dySyncToutiao, true);
  assert.strictEqual(httpMulti.value[1].dySyncToutiao, true);
  assert.strictEqual(httpMulti.value[2].dySyncToutiao, false);

  const help = parsePublish.publishHelpText();
  assert.ok(help.includes("--dy-sync-toutiao"));
  assert.ok(help.includes("dySyncToutiao"));

  console.log("✓ 1. CLI / HTTP dySyncToutiao 字段解析、透传与 help 文案通过");
}

/* ------------------------------------------------------------------ *
 * 2. Fake DOM：开关定位、状态判断、点击回读、异常与脱敏轮廓
 * ------------------------------------------------------------------ */
async function testFakeDomSyncToggle() {
  // 2a. 已开不点（aria-checked="true" / semi-switch-checked / active / checkbox.checked=true）
  {
    const cases = [
      {
        name: "aria-checked=true",
        build(body) {
          const row = new FakeElement("div", "", { class: "setting-row" });
          row.append(new FakeElement("span", "同步到今日头条"));
          const sw = new FakeElement("div", "", {
            class: "semi-switch",
            role: "switch",
            "aria-checked": "true",
          });
          row.append(sw);
          body.append(row);
          return sw;
        },
      },
      {
        name: "class=semi-switch-checked",
        build(body) {
          const row = new FakeElement("div", "", { class: "sync-item" });
          row.append(new FakeElement("span", "同时发布到今日头条"));
          const sw = new FakeElement("div", "", {
            class: "semi-switch semi-switch-checked",
          });
          row.append(sw);
          body.append(row);
          return sw;
        },
      },
      {
        name: "class=active",
        build(body) {
          const row = new FakeElement("div", "", { class: "sync-item" });
          row.append(new FakeElement("span", "今日头条"));
          const sw = new FakeElement("div", "", {
            class: "custom-switch active",
          });
          row.append(sw);
          body.append(row);
          return sw;
        },
      },
      {
        name: "semi-checkbox checked input",
        build(body) {
          const lb = new FakeElement("label", "", { class: "semi-checkbox" });
          const inp = new FakeElement("input", "", {
            type: "checkbox",
            checked: "checked",
          });
          lb.append(inp, new FakeElement("span", "今日头条"));
          body.append(lb);
          return lb;
        },
      },
    ];

    for (const c of cases) {
      const { doc, body } = makeDoc();
      const ctrl = c.build(body);
      let clicks = 0;
      ctrl.onClick = () => {
        clicks += 1;
      };
      const page = makeFakePage(doc);
      const { result, logs } = await captureLogs(() =>
        dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
      );
      assert.strictEqual(result.ok, true, `${c.name} 应成功`);
      assert.strictEqual(result.alreadyEnabled, true, `${c.name} 应识别为已开启`);
      assert.strictEqual(result.clicked, false, `${c.name} 不得点击`);
      assert.strictEqual(clicks, 0, `${c.name} 开关点击次数必须为 0`);
      assert.strictEqual(page.clickedSelectors.length, 0);
      assert.ok(
        logs.some((l) => l.includes(SUCCESS_LOG)),
        `${c.name} 应输出成功日志`
      );
    }
  }

  // 2b. 未开点一次后开（page.click + semi-switch aria-checked + 清理标记）
  {
    const { doc, body } = makeDoc();
    const row = new FakeElement("div", "", { class: "setting-row" });
    row.append(new FakeElement("span", "同步发布到今日头条"));
    const sw = new FakeElement("div", "", {
      class: "semi-switch semi-switch-unchecked",
      role: "switch",
      "aria-checked": "false",
    });
    let clicks = 0;
    sw.onClick = () => {
      clicks += 1;
      sw.setAttribute("aria-checked", "true");
      sw.setAttribute("class", "semi-switch semi-switch-checked");
    };
    row.append(sw);
    body.append(row);

    const page = makeFakePage(doc, { withPageClick: true });
    const { result, logs } = await captureLogs(() =>
      dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.alreadyEnabled, false);
    assert.strictEqual(result.clicked, true);
    assert.strictEqual(clicks, 1, "未开应精确点击一次");
    assert.strictEqual(sw.getAttribute("aria-checked"), "true");
    assert.strictEqual(
      sw.getAttribute("data-mm-dy-sync-tt"),
      null,
      "临时标记应清理"
    );
    assert.ok(logs.some((l) => l.includes(SUCCESS_LOG)));
  }

  // 2c. 未开点一次后开：多平台同组（西瓜视频 + 今日头条）只点今日头条，绝不误点西瓜视频
  {
    const { doc, body } = makeDoc();
    const group = new FakeElement("div", "", { class: "sync-platform-list" });

    let xgClicks = 0;
    const xgLb = new FakeElement("label", "", { class: "semi-checkbox" });
    const xgInp = new FakeElement("input", "", { type: "checkbox" });
    xgLb.append(xgInp, new FakeElement("span", "西瓜视频"));
    xgLb.onClick = () => {
      xgClicks += 1;
      xgInp.checked = !xgInp.checked;
    };

    let ttClicks = 0;
    const ttLb = new FakeElement("label", "", { class: "semi-checkbox" });
    const ttInp = new FakeElement("input", "", { type: "checkbox" });
    ttLb.append(ttInp, new FakeElement("span", "今日头条"));
    ttLb.onClick = () => {
      ttClicks += 1;
      ttInp.checked = true;
      ttLb.setAttribute("class", "semi-checkbox semi-checkbox-checked");
    };

    group.append(xgLb, ttLb);
    body.append(group);

    const page = makeFakePage(doc, { withPageClick: true });
    const { result } = await captureLogs(() =>
      dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(xgClicks, 0, "不得误点西瓜视频复选框");
    assert.strictEqual(ttClicks, 1, "应只点一次今日头条复选框");
    assert.strictEqual(ttInp.checked, true);
  }

  // 2d. label[for] 关联原生 checkbox + safeClick 兜底（page 无 click 方法）
  {
    const { doc, body } = makeDoc();
    const wrap = new FakeElement("div", "", { class: "sync-item" });
    const inp = new FakeElement("input", "", {
      id: "dy-sync-tt-cb",
      type: "checkbox",
    });
    let clicks = 0;
    inp.onClick = () => {
      clicks += 1;
      inp.checked = true;
    };
    const lb = new FakeElement("label", "同步到今日头条", {
      for: "dy-sync-tt-cb",
    });
    wrap.append(inp, lb);
    body.append(wrap);

    const page = makeFakePage(doc, { withPageClick: false });
    const { result } = await captureLogs(() =>
      dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(clicks, 1, "无 page.click 时应走 safeClick 点击一次");
    assert.strictEqual(inp.checked, true);
  }

  // 2e. 多平台卡片（西瓜视频开关 + 今日头条开关）+ 同行「同步发布」标题 + 点击后 React 重渲染替换节点
  {
    const { doc, body } = makeDoc();
    const section = new FakeElement("div", "", { class: "publish-sync-section" });
    section.append(new FakeElement("label", "同步发布"));

    let xgClicks = 0;
    const cardXg = new FakeElement("div", "", { class: "sync-card" });
    const swXg = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    swXg.onClick = () => {
      xgClicks += 1;
    };
    cardXg.append(new FakeElement("span", "西瓜视频"), swXg);

    let ttClicks = 0;
    const cardTt = new FakeElement("div", "", { class: "sync-card" });
    const swTt = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    swTt.onClick = () => {
      ttClicks += 1;
      // 模拟 React 重渲染替换掉原 DOM 节点（临时 data-mm-* 标记丢失）
      swTt.remove();
      const swTtNew = new FakeElement("div", "", {
        class: "semi-switch semi-switch-checked",
        role: "switch",
        "aria-checked": "true",
      });
      cardTt.append(swTtNew);
    };
    cardTt.append(new FakeElement("span", "今日头条"), swTt);
    section.append(cardXg, cardTt);
    body.append(section);

    const page = makeFakePage(doc);
    const { result } = await captureLogs(() =>
      dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(xgClicks, 0);
    assert.strictEqual(ttClicks, 1);
  }

  // 2f. 找不到控件报错 + 脱敏 DOM 轮廓（保留 ≤12 字，长文本打 [t:N]）
  {
    const { doc, body } = makeDoc();
    const longPrivacyText = "这是一段超过十二个字的私密视频简介正文不应泄露";
    const area = new FakeElement("div", "", { class: "publish-settings" });
    area.append(
      new FakeElement("span", "发布设置"),
      new FakeElement("p", longPrivacyText)
    );
    body.append(area);

    const page = makeFakePage(doc);
    let caught = null;
    try {
      await captureLogs(() =>
        dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "找不到同步开关必须抛错");
    assert.ok(
      caught.message.includes("抖音同步到今日头条未能开启") &&
        caught.message.includes("已中止，未发布"),
      `错误文案应符合约定，实际: ${caught.message}`
    );
    const joined = (caught._capturedLogs || []).join("\n");
    assert.ok(joined.includes("发布设置"), "≤12 字 UI 文案应保留在脱敏轮廓中");
    assert.ok(
      joined.includes(`[t:${Array.from(longPrivacyText).length}]`),
      "长文本应脱敏为 [t:N]"
    );
    assert.ok(
      !joined.includes("私密视频简介"),
      "长文本原文绝不能泄露到日志"
    );
  }

  // 2g. 跨行保护：提示文案提「今日头条」但相邻行是「保存权限」开关 → 0 点击并报错
  {
    const { doc, body } = makeDoc();
    const panel = new FakeElement("div", "", { class: "settings-group" });
    const tipRow = new FakeElement("div", "", { class: "tip-row" });
    tipRow.append(new FakeElement("span", "开通后可同步到今日头条"));
    const otherRow = new FakeElement("div", "", { class: "perm-row" });
    let otherClicks = 0;
    const otherSw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    otherSw.onClick = () => {
      otherClicks += 1;
    };
    otherRow.append(new FakeElement("span", "保存权限"), otherSw);
    panel.append(tipRow, otherRow);
    body.append(panel);

    const page = makeFakePage(doc);
    await assert.rejects(
      () =>
        captureLogs(() =>
          dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
        ),
      (e) =>
        e.message.includes("抖音同步到今日头条未能开启") &&
        e.message.includes("已中止，未发布")
    );
    assert.strictEqual(otherClicks, 0, "跨行保护必须阻止误点「保存权限」开关");
  }

  // 2h. 跨行保护：同组西瓜视频有开关、今日头条只有「去绑定」→ 0 点击并报「今日头条未绑定」
  {
    const { doc, body } = makeDoc();
    const list = new FakeElement("div", "", { class: "sync-list" });
    const item1 = new FakeElement("div", "", { class: "item" });
    let xgClicks = 0;
    const xgSw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    xgSw.onClick = () => {
      xgClicks += 1;
    };
    item1.append(new FakeElement("span", "西瓜视频"), xgSw);

    const item2 = new FakeElement("div", "", { class: "item" });
    item2.append(
      new FakeElement("span", "今日头条"),
      new FakeElement("span", "去绑定")
    );
    list.append(item1, item2);
    body.append(list);

    const page = makeFakePage(doc);
    await assert.rejects(
      () =>
        captureLogs(() =>
          dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
        ),
      (e) =>
        e.message.includes("抖音同步到今日头条未能开启") &&
        e.message.includes("今日头条未绑定")
    );
    assert.strictEqual(xgClicks, 0, "今日头条无开关时绝不能误点西瓜视频开关");
  }

  // 2h2. 回归 P2-1：同组仅西瓜视频复选框(<label class="semi-checkbox">) + 今日头条「去绑定」→ 报错「今日头条未绑定」且 0 点击（包装容器与平铺兄弟两种 DOM 均覆盖）
  {
    const variants = [
      {
        name: "wrapped_entry_xigua_checkbox",
        otherLabel: "西瓜视频",
        bindText: "去绑定",
        wrapToutiao: true,
      },
      {
        name: "flat_siblings_xigua_checkbox",
        otherLabel: "西瓜视频",
        bindText: "去绑定",
        wrapToutiao: false,
      },
      {
        name: "douyin_volcano_checkbox_with_auth",
        otherLabel: "抖音火山版",
        bindText: "去授权",
        wrapToutiao: true,
      },
    ];
    for (const variant of variants) {
      const { doc, body } = makeDoc();
      const group = new FakeElement("div", "", { class: "sync-platform-list" });
      let otherClicks = 0;
      const otherLb = new FakeElement("label", "", { class: "semi-checkbox" });
      const otherInp = new FakeElement("input", "", { type: "checkbox" });
      otherLb.append(otherInp, new FakeElement("span", variant.otherLabel));
      otherLb.onClick = () => {
        otherClicks += 1;
        otherInp.checked = true;
        otherLb.setAttribute("class", "semi-checkbox semi-checkbox-checked");
      };
      otherInp.onClick = () => {
        otherClicks += 1;
        otherInp.checked = true;
      };
      group.append(otherLb);
      if (variant.wrapToutiao) {
        const ttBox = new FakeElement("div", "", { class: "toutiao-entry" });
        ttBox.append(
          new FakeElement("span", "今日头条"),
          new FakeElement("a", variant.bindText, { href: "#bind" })
        );
        group.append(ttBox);
      } else {
        group.append(
          new FakeElement("span", "今日头条"),
          new FakeElement("a", variant.bindText, { href: "#bind" })
        );
      }
      body.append(group);

      const page = makeFakePage(doc, { withPageClick: true });
      await assert.rejects(
        () =>
          captureLogs(() =>
            dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
          ),
        (e) =>
          e.message.includes("抖音同步到今日头条未能开启") &&
          e.message.includes("今日头条未绑定") &&
          e.message.includes("已中止，未发布"),
        `${variant.name} 必须报「今日头条未绑定」并中止`
      );
      assert.strictEqual(
        otherClicks,
        0,
        `${variant.name} 绝不能误点击 ${variant.otherLabel} 复选框`
      );
      assert.strictEqual(
        otherInp.checked,
        false,
        `${variant.name} ${variant.otherLabel} 复选框状态必须保持未勾选`
      );
      assert.strictEqual(
        page.clickedSelectors.length,
        0,
        `${variant.name} 不应发起任何 page.click`
      );
    }

    // 控件通过 aria-label / label[for] 标记为「西瓜视频」时同样必须排除且 0 点击
    const { doc, body } = makeDoc();
    const row = new FakeElement("div", "", { class: "sync-row" });
    let xgForClicks = 0;
    const xgCb = new FakeElement("input", "", {
      id: "xg-only-cb",
      type: "checkbox",
      "aria-label": "西瓜视频",
    });
    xgCb.onClick = () => {
      xgForClicks += 1;
      xgCb.checked = true;
    };
    const xgForLabel = new FakeElement("label", "西瓜视频", { for: "xg-only-cb" });
    row.append(
      xgCb,
      xgForLabel,
      new FakeElement("span", "今日头条"),
      new FakeElement("span", "授权")
    );
    body.append(row);

    const page = makeFakePage(doc, { withPageClick: true });
    await assert.rejects(
      () =>
        captureLogs(() =>
          dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
        ),
      (e) => e.message.includes("今日头条未绑定")
    );
    assert.strictEqual(xgForClicks, 0);
    assert.strictEqual(xgCb.checked, false);
  }

  // 2i. 提交按钮安全保护：目标位于发布按钮容器内 → 0 点击并报错
  {
    const { doc, body } = makeDoc();
    let pubClicks = 0;
    const pubWrap = new FakeElement("div", "", { id: "popover-tip-container" });
    pubWrap.onClick = () => {
      pubClicks += 1;
    };
    const fakeSw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    fakeSw.onClick = () => {
      pubClicks += 1;
    };
    pubWrap.append(new FakeElement("span", "今日头条"), fakeSw);
    body.append(pubWrap);

    const page = makeFakePage(doc);
    await assert.rejects(
      () =>
        captureLogs(() =>
          dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
        ),
      (e) =>
        e.message.includes("抖音同步到今日头条未能开启") &&
        e.message.includes("提交按钮")
    );
    assert.strictEqual(pubClicks, 0, "提交按钮保护必须保证 0 点击");
  }

  // 2j. 点击后弹出授权/绑定弹窗 → 中止并输出脱敏 DOM 轮廓
  {
    const { doc, body } = makeDoc();
    const row = new FakeElement("div", "", { class: "sync-row" });
    row.append(new FakeElement("span", "同步到今日头条"));
    const sw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    sw.onClick = () => {
      const modal = new FakeElement("div", "", {
        class: "semi-modal",
        role: "dialog",
      });
      modal.append(
        new FakeElement("div", "账号绑定提示", { class: "semi-modal-title" }),
        new FakeElement(
          "div",
          "请先绑定今日头条账号后再开启视频同步功能，绑定账号13800138000",
          { class: "semi-modal-body" }
        )
      );
      body.append(modal);
    };
    row.append(sw);
    body.append(row);

    const page = makeFakePage(doc);
    let caught = null;
    try {
      await captureLogs(() =>
        dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
      );
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "出现授权/绑定弹窗必须中止抛错");
    assert.ok(
      caught.message.includes("抖音同步到今日头条未能开启") &&
        caught.message.includes("授权/绑定弹窗") &&
        caught.message.includes("已中止，未发布"),
      `实际文案: ${caught.message}`
    );
    const joined = (caught._capturedLogs || []).join("\n");
    assert.ok(joined.includes("账号绑定提示"), "弹窗短标题应出现在脱敏轮廓中");
    assert.ok(!joined.includes("13800138000"), "手机号等长文本不得泄露");
  }

  // 2k. 点击后回读仍未开启 → 只点一次并抛错
  {
    const { doc, body } = makeDoc();
    const row = new FakeElement("div", "", { class: "sync-row" });
    row.append(new FakeElement("span", "同步到今日头条"));
    let clicks = 0;
    const sw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    sw.onClick = () => {
      clicks += 1;
      // 模拟点击无响应，状态仍为 false
    };
    row.append(sw);
    body.append(row);

    const page = makeFakePage(doc);
    await assert.rejects(
      () =>
        captureLogs(() =>
          dyMod.ensureDySyncToutiao(page, { timeouts: FAST_TIMEOUTS })
        ),
      (e) =>
        e.message.includes("抖音同步到今日头条未能开启") &&
        e.message.includes("回读仍为未开启") &&
        e.message.includes("已中止，未发布")
    );
    assert.strictEqual(clicks, 1, "未开只允许点一次，不得重复点击");
  }

  // 2l. 草稿模式也执行开关步骤，并日志注明草稿不会触发同步
  {
    const { doc, body } = makeDoc();
    const row = new FakeElement("div", "", { class: "sync-row" });
    row.append(new FakeElement("span", "同步到今日头条"));
    let clicks = 0;
    const sw = new FakeElement("div", "", {
      class: "semi-switch",
      role: "switch",
      "aria-checked": "false",
    });
    sw.onClick = () => {
      clicks += 1;
      sw.setAttribute("aria-checked", "true");
    };
    row.append(sw);
    body.append(row);

    const page = makeFakePage(doc);
    const { result, logs } = await captureLogs(() =>
      dyMod.ensureDySyncToutiao(page, {
        isDraftMode: true,
        timeouts: FAST_TIMEOUTS,
      })
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.isDraftMode, true);
    assert.strictEqual(clicks, 1);
    assert.ok(
      logs.some((l) => l.includes("草稿") && l.includes("不会触发同步")),
      `草稿模式日志应注明不会触发同步，实际: ${logs.join(" | ")}`
    );
    assert.ok(logs.some((l) => l.includes(SUCCESS_LOG)));
  }

  console.log(
    "✓ 2. Fake DOM 开关定位、状态读取、已开不点、未开点一次、跨行保护、弹窗拦截、脱敏轮廓与草稿日志通过"
  );
}

/* ------------------------------------------------------------------ *
 * 3. dy.js handler 集成门禁（默认不触碰 / 失败不点发布 / 草稿执行开关）
 * ------------------------------------------------------------------ */
async function testDyHandlerIntegration() {
  const outFile = path.join(outDir, "dy-handler-gate.cjs");
  const stubMap = new Map([
    [
      "./collection.js",
      "export async function selectPlatformCollection(){ return { skipped: true, selected: false, name: '' }; }",
    ],
    [
      "./uploadTimeouts.js",
      "export const WAIT_SELECTOR_APPEAR_MS=1; export const WAIT_UPLOAD_PROCESSING_MS=1; export async function pollPageUntil(){return true;}",
    ],
    [
      "./failureScreenshot.js",
      "export async function capturePublishFailureScreenshot(){return '/tmp/dy-sync-shot.png';}",
    ],
    ["./closeWindow.js", "export default function maybeClosePublishWindow(){}"],
    [
      "../coverCompat.js",
      "export async function normalizeCoverForUpload(p){return p;}",
    ],
  ]);
  await build({
    entryPoints: [path.join(root, "src/main/services/upLoad/dy.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: outFile,
    external: ["electron"],
    plugins: [
      {
        name: "dy-sync-stubs",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            stubMap.has(args.path) ? { path: args.path, namespace: "stub" } : null
          );
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: stubMap.get(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });
  delete require.cache[outFile];
  const dyHandler = require(outFile).default;

  function buildHandlerPage({ hasSyncSwitch = true, initialChecked = false } = {}) {
    const { doc, body } = makeDoc();
    let syncClicks = 0;
    let publishClicked = false;
    let draftClicked = false;

    if (hasSyncSwitch) {
      const row = new FakeElement("div", "", { class: "sync-row" });
      row.append(new FakeElement("span", "同步到今日头条"));
      const sw = new FakeElement("div", "", {
        class: initialChecked ? "semi-switch semi-switch-checked" : "semi-switch",
        role: "switch",
        "aria-checked": initialChecked ? "true" : "false",
      });
      sw.onClick = () => {
        syncClicks += 1;
        sw.setAttribute("aria-checked", "true");
        sw.setAttribute("class", "semi-switch semi-switch-checked");
      };
      row.append(sw);
      body.append(row);
    }

    const domPage = makeFakePage(doc, { withPageClick: true });
    let currentUrl = "https://creator.douyin.com/creator-micro/content/upload";
    const handle = (sel) => ({
      async uploadFile() {},
      async click() {
        if (sel === "#popover-tip-container") {
          publishClicked = true;
          currentUrl = "https://creator.douyin.com/creator-micro/content/manage";
        }
        if (sel === "#popover-tip-container+button") {
          draftClicked = true;
          currentUrl = "https://creator.douyin.com/creator-micro/content/manage";
        }
      },
      async evaluate() {
        return "测试标题";
      },
    });
    const page = {
      async waitForSelector(sel) {
        return handle(sel);
      },
      async $(sel) {
        return handle(sel);
      },
      async $$(sel) {
        return [handle(sel)];
      },
      async click(sel) {
        if (typeof sel === "string" && sel.includes("data-mm-dy-sync-tt")) {
          return domPage.click(sel);
        }
      },
      async type() {},
      keyboard: {
        async down() {},
        async up() {},
        async press() {},
        async type() {},
      },
      async waitForFunction() {
        return true;
      },
      async waitForTimeout() {},
      async evaluate(fn, arg) {
        const src = String(fn && fn.toString ? fn.toString() : fn);
        if (
          src.includes("data-mm-dy-sync-tt") ||
          src.includes("collectDySyncToutiaoDomOutline") ||
          (arg &&
            typeof arg === "object" &&
            (arg.action === "inspect_and_mark" ||
              arg.action === "readback" ||
              arg.action === "safe_click" ||
              arg.action === "cleanup" ||
              Array.isArray(arg.needles)))
        ) {
          return domPage.evaluate(fn, arg);
        }
        if (arg && typeof arg === "object" && "mode" in arg) {
          return { ok: true, info: {}, mode: arg.mode };
        }
        if (typeof arg === "string") {
          if (src.includes("execCommand")) return true;
          return src.includes("semi-modal") || src.includes("semi-radio")
            ? true
            : "";
        }
        if (src.includes("我知道了")) return 0;
        return true;
      },
      url: () => currentUrl,
    };
    return {
      page,
      getStats: () => ({ syncClicks, publishClicked, draftClicked }),
    };
  }

  // 3a. dySyncToutiao=false：完全不触碰同步开关，正常点击发布
  {
    const { page, getStats } = buildHandlerPage({
      hasSyncSwitch: true,
      initialChecked: false,
    });
    const replies = [];
    await captureLogs(() =>
      dyHandler(
        page,
        {
          pt: "抖音",
          filePath: "demo.mp4",
          data: { title: "测试标题", description: "", tags: [], creativeStatement: "none" },
          publishOptions: {},
        },
        null,
        { reply: (_ch, p) => replies.push(p) }
      )
    );
    const st = getStats();
    assert.strictEqual(st.syncClicks, 0, "默认 false 不得触碰同步开关");
    assert.strictEqual(st.publishClicked, true, "默认 false 应正常点击发布");
    assert.strictEqual(replies[0].status, true);
  }

  // 3b. dySyncToutiao=true 且找不到开关：中止发布（0 点击发布，status:false，无 noRetry）
  {
    const { page, getStats } = buildHandlerPage({ hasSyncSwitch: false });
    const replies = [];
    await captureLogs(() =>
      dyHandler(
        page,
        {
          pt: "抖音",
          filePath: "demo.mp4",
          data: { title: "测试标题", description: "", tags: [], creativeStatement: "none" },
          publishOptions: { dySyncToutiao: true },
        },
        null,
        { reply: (_ch, p) => replies.push(p) }
      )
    );
    const st = getStats();
    assert.strictEqual(st.publishClicked, false, "同步开关失败绝不能点击发布");
    assert.strictEqual(st.draftClicked, false);
    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].status, false);
    assert.notStrictEqual(replies[0].noRetry, true, "未点发布前中止应属可重试错误");
    assert.ok(replies[0].message.includes("抖音同步到今日头条未能开启"));
  }

  // 3c. dySyncToutiao=true + publishMode="draft"：执行开关并记录草稿不触发同步，然后点存草稿
  {
    const { page, getStats } = buildHandlerPage({
      hasSyncSwitch: true,
      initialChecked: false,
    });
    const replies = [];
    const { logs } = await captureLogs(() =>
      dyHandler(
        page,
        {
          pt: "抖音",
          filePath: "demo.mp4",
          publishMode: "draft",
          publishToDraft: true,
          data: { title: "测试标题", description: "", tags: [], creativeStatement: "none" },
          publishOptions: { dySyncToutiao: true },
        },
        null,
        { reply: (_ch, p) => replies.push(p) }
      )
    );
    const st = getStats();
    assert.strictEqual(st.syncClicks, 1, "草稿模式也应执行开关步骤");
    assert.strictEqual(st.draftClicked, true, "开关确认后应点击存草稿");
    assert.strictEqual(st.publishClicked, false);
    assert.ok(logs.some((l) => l.includes("不会触发同步")));
    assert.ok(logs.some((l) => l.includes(SUCCESS_LOG)));
  }

  console.log("✓ 3. dy.js handler 集成门禁（默认不碰 / 失败中止可重试 / 草稿模式执行开关）通过");
}

/* ------------------------------------------------------------------ *
 * 4. 防重复：publishVideo.js 层拦截 + GUI LocalVideoPublish.vue 拦截与持久化
 * ------------------------------------------------------------------ */
async function testConflictAndGuiPersistence() {
  // 4a. publishVideo.js 层（stub puppeteerFile / changeData / throttle 验证纯拦截行为与预留释放）
  const releasedIds = [];
  let puppeteerStarted = 0;
  const pvOut = path.join(outDir, "publishVideo-gate.cjs");
  const pvStubs = new Map([
    [
      "./puppeteerFile",
      `export function runPuppeteerTask(){ globalThis.__PV_PUPPETEER_CALLS__ = (globalThis.__PV_PUPPETEER_CALLS__||0)+1; }`,
    ],
    [
      "./publishThrottle.js",
      `export function getDefaultCreativeStatement(){ return "none"; }
       export async function confirmThrottleReservation(){ return { ok: true }; }
       export async function recordThrottleEntryDirect(){ return { ok: true, id: "r1" }; }
       export async function releaseThrottleReservation(id){ (globalThis.__PV_RELEASED__||[]).push(id); }
       export function checkExistingScheduledCreativeConflict(){ return { conflict: false }; }
       export function formatUtc8DateTime(){ return ""; }`,
    ],
    [
      "./resolvePublishFile",
      `export function isRemotePublishFile(){ return false; }
       export async function resolvePublishFile(f){ throw new Error("不应进入文件下载: " + f); }
       export function guessFileNameFromUrl(u){ return u; }`,
    ],
    [
      "./accountPublishSettingsResolver.js",
      `export function resolveAccountPublishMode(){ return { publishMode: "publish", publishToDraft: false }; }`,
    ],
    [
      "./accountLookup.js",
      `export function resolveTaskPartition(x){ return x.partition || ""; }`,
    ],
    [
      "./scheduledPublish",
      `export function createScheduledRecord(r){ return r; }
       export function notifyScheduledPublishChanged(){}`,
    ],
    [
      "../server/utils",
      `export function changeData(){ return { success: true, data: {} }; }`,
    ],
  ]);
  await build({
    entryPoints: [path.join(root, "src/main/services/publishVideo.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: pvOut,
    external: ["electron"],
    plugins: [
      {
        name: "pv-stubs",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) =>
            pvStubs.has(args.path) ? { path: args.path, namespace: "stub" } : null
          );
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            contents: pvStubs.get(args.path),
            loader: "js",
          }));
        },
      },
    ],
  });
  delete require.cache[pvOut];
  globalThis.__PV_RELEASED__ = releasedIds;
  globalThis.__PV_PUPPETEER_CALLS__ = 0;
  const pvMod = require(pvOut);

  // checkDySyncToutiaoConflict 纯函数
  assert.strictEqual(
    pvMod.checkDySyncToutiaoConflict([
      { platform: "抖音", dySyncToutiao: true },
      { platform: "头条", dySyncToutiao: false },
    ]),
    CONFLICT_MSG
  );
  assert.strictEqual(
    pvMod.checkDySyncToutiaoConflict([
      { platform: "抖音", dySyncToutiao: true },
      { platform: "快手", dySyncToutiao: true },
    ]),
    ""
  );
  assert.strictEqual(
    pvMod.checkDySyncToutiaoConflict([
      { platform: "抖音", dySyncToutiao: false },
      { platform: "头条", dySyncToutiao: false },
    ]),
    ""
  );

  // CLI / HTTP 单平台：头条 + dySyncToutiao=true → 拒绝且释放预留
  const singleRej = await pvMod.runSingleFilePublish({
    platform: "头条",
    phone: "13800138000",
    file: "./demo.mp4",
    title: "标题",
    dySyncToutiao: true,
    throttleReservationId: "res-single-tt",
  });
  assert.strictEqual(singleRej.exitCode, 2);
  assert.strictEqual(singleRej.status, "failed");
  assert.strictEqual(singleRej.message, CONFLICT_MSG);
  assert.ok(releasedIds.includes("res-single-tt"), "拒绝前应释放节流预留");

  // HTTP 多平台：抖音 + 头条 + dySyncToutiao=true → 拒绝且释放全部预留、绝不启动发布
  const parsedMultiConflict = parsePublish.parseMultiPublishRequest({
    phone: "13800138000",
    file: "./demo.mp4",
    title: "标题",
    dySyncToutiao: true,
    platforms: ["dy", "tt"],
  });
  assert.strictEqual(parsedMultiConflict.ok, true, parsedMultiConflict.error);
  parsedMultiConflict.value[0].throttleReservationId = "res-multi-dy";
  parsedMultiConflict.value[1].throttleReservationId = "res-multi-tt";
  const multiRej = await pvMod.runMultiPlatformPublish(
    parsedMultiConflict.value
  );
  assert.strictEqual(multiRej.success, false);
  assert.strictEqual(multiRej.exitCode, 2);
  assert.strictEqual(multiRej.status, "failed");
  assert.strictEqual(multiRej.message, CONFLICT_MSG);
  assert.ok(releasedIds.includes("res-multi-dy"));
  assert.ok(releasedIds.includes("res-multi-tt"));
  assert.strictEqual(globalThis.__PV_PUPPETEER_CALLS__, 0);

  // HTTP 多平台：仅抖音目标开了 dySyncToutiao=true 且列表里有头条 → 同样拒绝
  const parsedMixedConflict = parsePublish.parseMultiPublishRequest({
    phone: "13800138000",
    file: "./demo.mp4",
    title: "标题",
    platforms: [
      { platform: "dy", dySyncToutiao: true },
      { platform: "tt" },
    ],
  });
  assert.strictEqual(parsedMixedConflict.ok, true);
  const mixedRej = await pvMod.runMultiPlatformPublish(
    parsedMixedConflict.value
  );
  assert.strictEqual(mixedRej.success, false);
  assert.strictEqual(mixedRej.exitCode, 2);
  assert.strictEqual(mixedRej.message, CONFLICT_MSG);

  // 4b. GUI LocalVideoPublish.vue：模板编译、持久化记忆、仅抖音透传、提交前防重复拦截
  const vueSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  const sfc = compiler.parseComponent(vueSrc);
  assert.ok(sfc.template && sfc.template.content);
  const compiled = compiler.compile(sfc.template.content);
  assert.strictEqual(
    compiled.errors.length,
    0,
    `LocalVideoPublish.vue 模板编译报错: ${compiled.errors.join("; ")}`
  );
  assert.ok(
    vueSrc.includes("抖音同步发布到今日头条（仅抖音生效）"),
    "UI 应包含复选框文案"
  );
  assert.ok(vueSrc.includes("form.dySyncToutiao"), "UI 应绑定 form.dySyncToutiao");

  const videoLink = bundle("src/shared/videoLink.js", "videoLink.cjs");
  const storageMap = new Map();
  const mockLocalStorage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  };

  const script = sfc.script.content
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace("export default", "globalThis.component =");
  const importedNames = [
    ...sfc.script.content.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm),
  ].flatMap((m) =>
    m[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/).pop())
      .filter(Boolean)
  );
  const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
  const ctx = vm.createContext({
    ...stubs,
    ...videoLink,
    localStorage: mockLocalStorage,
  });
  vm.runInContext(script, ctx);

  // 初始未记忆时默认为 false
  const initData = ctx.component.data();
  assert.strictEqual(initData.form.dySyncToutiao, false);

  const warnings = [];
  const state = {
    ...initData,
    $set: (o, k, v) => {
      o[k] = v;
    },
    $message: {
      warning: (m) => warnings.push(m),
      error: (m) => warnings.push(m),
      success: () => {},
    },
    $nextTick: () => {},
  };
  for (const [name, fn] of Object.entries(ctx.component.methods)) {
    state[name] = fn.bind(state);
  }
  state.getPlatformStatement = () => "none";
  state.loadPublishThrottleDefaults = async () => "none";

  // 持久化：记住上次选择（open / openDirectory / resetState 均保持）
  state.form.dySyncToutiao = true;
  state.saveDySyncToutiaoPreference(true);
  assert.strictEqual(
    mockLocalStorage.getItem("matrixmedia.publish.dySyncToutiao"),
    "true"
  );
  state.open("/tmp/test.mp4");
  assert.strictEqual(state.form.dySyncToutiao, true, "重新 open 应记住上次开启");
  state.resetState();
  assert.strictEqual(state.form.dySyncToutiao, true, "resetState 后仍应记住上次开启");
  state.openDirectory();
  assert.strictEqual(state.form.dySyncToutiao, true, "openDirectory 应记住上次开启");

  // 仅抖音透传 dySyncToutiao: true，其他平台忽略
  const dyNode = { id: "n-dy", pt: "抖音", phone: "a", url: "https://dy" };
  const ksNode = { id: "n-ks", pt: "快手", phone: "a", url: "https://ks" };
  const ttNode = { id: "n-tt", pt: "头条", phone: "a", url: "https://tt" };
  assert.strictEqual(
    state.buildPlatformVideoPayload(dyNode, { data: {} }).publishOptions
      .dySyncToutiao,
    true
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      state.buildPlatformVideoPayload(ksNode, { data: {} }).publishOptions,
      "dySyncToutiao"
    ),
    false
  );

  // UI 提交前防重复拦截：onPlatformNext + doSubmitBatchPublish + submitDirBatchPublish
  warnings.length = 0;
  state.checkedPlatformNodes = [dyNode, ttNode];
  state.attrsVisible = false;
  state.onPlatformNext();
  assert.strictEqual(state.attrsVisible, false, "同时勾头条时 onPlatformNext 必须拦截");
  assert.strictEqual(warnings[0], CONFLICT_MSG);

  warnings.length = 0;
  let dedupeOrThrottleTouched = 0;
  state.validatePlatformVideoLinks = () => {
    dedupeOrThrottleTouched += 1;
    return "";
  };
  state.checkRecentDuplicates = () => {
    dedupeOrThrottleTouched += 1;
    throw new Error("冲突拦截前不得触发历史查重");
  };
  state.planThrottleAndConfirm = async () => {
    dedupeOrThrottleTouched += 1;
    throw new Error("冲突拦截前不得触发节流排期");
  };
  state.localFilePath = "/tmp/demo.mp4";
  state.dirBatchFiles = [];
  state.$refs = { tree: { getCheckedNodes: () => [dyNode, ttNode] } };
  await state.doSubmitBatchPublish("publish");
  assert.strictEqual(warnings[0], CONFLICT_MSG, "doSubmitBatchPublish 必须拦截同时勾头条");
  assert.strictEqual(
    dedupeOrThrottleTouched,
    0,
    "GUI 单视频提交冲突拦截必须早于校验/历史查重/节流排期"
  );

  warnings.length = 0;
  await state.submitDirBatchPublish("publish");
  assert.strictEqual(warnings[0], CONFLICT_MSG, "submitDirBatchPublish 必须拦截同时勾头条");
  assert.strictEqual(
    dedupeOrThrottleTouched,
    0,
    "GUI 目录批量提交冲突拦截必须早于历史查重/节流排期"
  );

  // 关闭复选框后记住 false，且不再拦截
  state.form.dySyncToutiao = false;
  state.saveDySyncToutiaoPreference(false);
  state.open("/tmp/test2.mp4");
  assert.strictEqual(state.form.dySyncToutiao, false);
  assert.strictEqual(state.validateDySyncToutiaoConflict([dyNode, ttNode]), "");

  console.log(
    "✓ 4. 防重复拦截（publishVideo.js + LocalVideoPublish.vue）与 UI 持久化通过"
  );
}

/* ------------------------------------------------------------------ *
 * 5. P2-2：冲突检查须在任何历史查重/排期/节流之前执行（HTTP / CLI / GUI）
 * ------------------------------------------------------------------ */
async function testConflictBeforeDedupeAndThrottle() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s14-p2-conflict-"));
  const clip = path.join(tmpDir, "demo.mp4");
  fs.writeFileSync(clip, "fake-video");

  const guardStub = path.join(tmpDir, "guardStub.js");
  const pupStub = path.join(tmpDir, "pupStub.js");
  const alertStub = path.join(tmpDir, "alertStub.js");
  const entryJs = path.join(outDir, "p2-conflict-entry.js");
  const bundleCjs = path.join(outDir, "p2-conflict-bundle.cjs");

  globalThis.__S14_P2_PUP_CALLS__ = [];
  fs.writeFileSync(
    guardStub,
    `module.exports = { isTrustedLocalRequest: () => true };`
  );
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(taskPayload, transport, done) {
       globalThis.__S14_P2_PUP_CALLS__.push(taskPayload);
       setImmediate(() => {
         transport.reply("puppeteerFile-done", {
           taskId: taskPayload.taskId,
           status: true,
           message: "上传成功",
         });
         if (done) done();
       });
     }`
  );
  fs.writeFileSync(
    alertStub,
    `module.exports = { handleAccountCollectOutcome: () => ({ ok: true }) };`
  );
  fs.writeFileSync(
    entryJs,
    `
      export { default as router } from ${JSON.stringify(
        path.join(root, "src/main/server/routes/index.js")
      )};
      export { changeData } from ${JSON.stringify(
        path.join(root, "src/main/server/utils.js")
      )};
      export {
        getPublishThrottleLedgerPath,
        readPublishThrottleLedger,
        savePublishThrottleSettings,
      } from ${JSON.stringify(
        path.join(root, "src/main/services/publishThrottle.js")
      )};
      export { runCliMain } from ${JSON.stringify(
        path.join(root, "src/main/cli/index.js")
      )};
    `,
    "utf8"
  );

  await build({
    entryPoints: [entryJs],
    outfile: bundleCjs,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "express",
      "xlsx",
      "axios",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
    plugins: [
      {
        name: "s14-p2-conflict-stubs",
        setup(b) {
          b.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({
            path: guardStub,
          }));
          b.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({
            path: pupStub,
          }));
          b.onResolve({ filter: /collectAlert\.js$/ }, () => ({
            path: alertStub,
          }));
        },
      },
    ],
  });

  const expressMod = require("express");
  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === "express") return expressMod;
    if (request === "xlsx") return xlsx;
    if (request === "electron") {
      return {
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.15.0-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") return () => ({});
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    delete require.cache[bundleCjs];
    const mod = require(bundleCjs);
    mod.savePublishThrottleSettings({ enabled: true });

    const phone = "13800138000";
    const dupTitle = "重复历史头条标题";
    const today = new Date().toISOString().slice(0, 10);
    // 预埋一条近 7 天头条发布成功记录，用于触发头条历史查重
    mod.changeData({
      fileName: "pushData",
      type: "add",
      item: {
        date: today,
        pt: "头条",
        phone,
        partition: `persist:${phone}头条`,
        bt: dupTitle,
        title: dupTitle,
        textOtherName: "demo",
        textType: "local",
        publishStatus: "success",
        publishSuccessCount: 1,
        publishFailCount: 0,
        lastPublishAt: Date.now() - 3600 * 1000,
      },
    });

    const postPublish = mod.router.stack.find(
      (l) => l.route && l.route.path === "/publish" && l.route.methods.post
    ).route.stack[0].handle;

    const invokeHttp = async (body) => {
      let statusCode = 200;
      let payload = null;
      await postPublish(
        { method: "POST", body, headers: { origin: "http://localhost:30088" } },
        {
          status(c) {
            statusCode = c;
            return this;
          },
          json(p) {
            payload = p;
            return this;
          },
        }
      );
      return { statusCode, payload };
    };

    // 5a. HTTP 多平台：头条命中 7 天历史查重 + 抖音开启 dySyncToutiao → 绝不能先移除头条放行抖音，必须整体报冲突
    const multiDupBypass = await invokeHttp({
      phone,
      file: clip,
      title: dupTitle,
      dySyncToutiao: true,
      platforms: ["dy", "tt"],
    });
    assert.strictEqual(multiDupBypass.statusCode, 400);
    assert.strictEqual(multiDupBypass.payload.success, false);
    assert.strictEqual(multiDupBypass.payload.exitCode, 2);
    assert.strictEqual(multiDupBypass.payload.status, "failed");
    assert.strictEqual(multiDupBypass.payload.message, CONFLICT_MSG);
    assert.strictEqual(multiDupBypass.payload.total, 2);
    assert.strictEqual(multiDupBypass.payload.succeeded, 0);
    assert.strictEqual(multiDupBypass.payload.failed, 2);
    assert.strictEqual(
      globalThis.__S14_P2_PUP_CALLS__.length,
      0,
      "冲突拦截后绝不能启动抖音发布"
    );

    // 5b. HTTP 多平台：仅抖音目标设 dySyncToutiao: true + 头条目标命中历史查重 → 同样被拦截
    const mixedDupBypass = await invokeHttp({
      phone,
      file: clip,
      title: dupTitle,
      platforms: [
        { platform: "dy", dySyncToutiao: true },
        { platform: "tt" },
      ],
    });
    assert.strictEqual(mixedDupBypass.statusCode, 400);
    assert.strictEqual(mixedDupBypass.payload.exitCode, 2);
    assert.strictEqual(mixedDupBypass.payload.message, CONFLICT_MSG);
    assert.strictEqual(globalThis.__S14_P2_PUP_CALLS__.length, 0);

    // 5c. HTTP 单平台：头条命中历史查重 + dySyncToutiao: true → 优先报冲突 (400 / exitCode 2)，而非 duplicate (6)
    const singleDupBypass = await invokeHttp({
      platform: "tt",
      phone,
      file: clip,
      title: dupTitle,
      dySyncToutiao: true,
    });
    assert.strictEqual(singleDupBypass.statusCode, 400);
    assert.strictEqual(singleDupBypass.payload.exitCode, 2);
    assert.strictEqual(singleDupBypass.payload.status, "failed");
    assert.strictEqual(singleDupBypass.payload.message, CONFLICT_MSG);

    // 5d. CLI 单文件：头条命中历史查重 + --dy-sync-toutiao → 优先报冲突 (exitCode 2)，而非 duplicate (6)
    const { result: cliExit, logs: cliLogs } = await captureLogs(() =>
      mod.runCliMain([
        "node",
        "app",
        "cli",
        "publish",
        "-p",
        "tt",
        "--phone",
        phone,
        "-f",
        clip,
        "-t",
        dupTitle,
        "--dy-sync-toutiao",
      ])
    );
    assert.strictEqual(
      cliExit,
      2,
      `CLI 头条+dySyncToutiao 即使命中历史查重也必须先返回 exitCode 2，实际=${cliExit}`
    );
    assert.ok(
      cliLogs.some((l) => l.includes(CONFLICT_MSG)),
      `CLI 应输出冲突提示，实际=${cliLogs.join(" | ")}`
    );
    assert.strictEqual(globalThis.__S14_P2_PUP_CALLS__.length, 0);

    // 全程未触发任何节流排期与账本写入（账本文件未被创建，且导入后亦无任何 reserved 预留项）
    assert.strictEqual(
      fs.existsSync(mod.getPublishThrottleLedgerPath()),
      false,
      "冲突拦截在节流之前，不得触发节流账本写入"
    );
    const ledger = mod.readPublishThrottleLedger();
    const reservedEntries = (
      (ledger && Array.isArray(ledger.entries) ? ledger.entries : [])
    ).filter((e) => e && e.status === "reserved");
    assert.strictEqual(
      reservedEntries.length,
      0,
      "冲突拦截在节流之前，不得产生任何账本预留"
    );
  } finally {
    Module._load = origLoad;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(
    "✓ 5. HTTP / CLI 冲突检查早于历史查重与节流排期（防止头条查重移除绕过）通过"
  );
}

/* ------------------------------------------------------------------ *
 * 6. P2-3：定时任务复用一致性比较 dySyncToutiao（publishThrottle / publishVideo / cli/index）
 * ------------------------------------------------------------------ */
async function testScheduledReuseDySyncConsistency() {
  const throttleSvc = require(path.join(
    root,
    "src/main/services/publishThrottle.js"
  ));

  // 6a. 纯函数校验
  const existingOff = {
    id: "sched-dy-off",
    pt: "抖音",
    creativeStatement: "ai_generated",
    publishOptions: { collection: "民间故事" },
  };
  const existingOn = {
    id: "sched-dy-on",
    pt: "抖音",
    creativeStatement: "ai_generated",
    publishOptions: { collection: "民间故事", dySyncToutiao: true },
  };

  // 缺省视为 false：existing off vs requested true → 冲突
  const offVsOn = throttleSvc.checkExistingScheduledCreativeConflict(
    existingOff,
    "ai_generated",
    "民间故事",
    true
  );
  assert.strictEqual(offVsOn.conflict, true);
  assert.strictEqual(offVsOn.dySyncToutiaoConflict, true);
  assert.strictEqual(offVsOn.actualDySyncToutiao, false);
  assert.strictEqual(offVsOn.requestedDySyncToutiao, true);
  assert.ok(offVsOn.message.includes("抖音同步头条"));
  assert.ok(offVsOn.message.includes("关闭") && offVsOn.message.includes("开启"));

  // existing on vs requested false / 缺省 → 冲突
  const onVsOff = throttleSvc.checkExistingScheduledCreativeConflict(
    existingOn,
    "ai_generated",
    "民间故事",
    false
  );
  assert.strictEqual(onVsOff.conflict, true);
  assert.strictEqual(onVsOff.dySyncToutiaoConflict, true);
  assert.strictEqual(onVsOff.actualDySyncToutiao, true);
  assert.strictEqual(onVsOff.requestedDySyncToutiao, false);

  const onVsOmitted = throttleSvc.checkExistingScheduledCreativeConflict(
    existingOn,
    "ai_generated",
    { pt: "抖音", publishOptions: { collection: "民间故事" } }
  );
  assert.strictEqual(onVsOmitted.conflict, true);
  assert.strictEqual(onVsOmitted.dySyncToutiaoConflict, true);

  // 一致时允许复用
  assert.strictEqual(
    throttleSvc.checkExistingScheduledCreativeConflict(
      existingOn,
      "ai_generated",
      "民间故事",
      true
    ).conflict,
    false
  );
  assert.strictEqual(
    throttleSvc.checkExistingScheduledCreativeConflict(
      existingOff,
      "ai_generated",
      "民间故事",
      false
    ).conflict,
    false
  );

  // 非抖音平台忽略 dySyncToutiao
  assert.strictEqual(
    throttleSvc.checkExistingScheduledCreativeConflict(
      { id: "sched-ks", pt: "快手", creativeStatement: "none", publishOptions: {} },
      "none",
      "",
      true
    ).conflict,
    false
  );

  // 组合冲突（合集 + 抖音同步头条）文案同时提及两项
  const combo = throttleSvc.checkExistingScheduledCreativeConflict(
    existingOff,
    "ai_generated",
    "都市传说",
    true
  );
  assert.strictEqual(combo.conflict, true);
  assert.strictEqual(combo.collectionConflict, true);
  assert.strictEqual(combo.dySyncToutiaoConflict, true);
  assert.ok(combo.message.includes("合集") && combo.message.includes("抖音同步头条"));

  // 6b. 端到端验证 publishVideo.js、publishThrottle.js IPC 与 cli/index.js 三处复用分支
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s14-sched-reuse-"));
  const mediaDir = path.join(tmpDir, "videos");
  fs.mkdirSync(mediaDir, { recursive: true });
  const clip1 = path.join(mediaDir, "ep01.mp4");
  const clip2 = path.join(mediaDir, "ep02.mp4");
  fs.writeFileSync(clip1, "fake-video-1");
  fs.writeFileSync(clip2, "fake-video-2");

  const entryJs = path.join(outDir, "s14-sched-entry.js");
  const bundleCjs = path.join(outDir, "s14-sched-core.cjs");
  fs.writeFileSync(
    entryJs,
    `
      export { changeData } from ${JSON.stringify(
        path.join(root, "src/main/server/utils.js")
      )};
      export {
        createScheduledRecord,
        notifyScheduledPublishChanged,
        stopScheduledPublishScheduler,
      } from ${JSON.stringify(
        path.join(root, "src/main/services/scheduledPublish.js")
      )};
      export { findExistingScheduled } from ${JSON.stringify(
        path.join(root, "src/main/services/scheduledDedupe.js")
      )};
      export {
        registerPublishThrottleIpc,
        savePublishThrottleSettings,
      } from ${JSON.stringify(
        path.join(root, "src/main/services/publishThrottle.js")
      )};
      export { runSingleFilePublish } from ${JSON.stringify(
        path.join(root, "src/main/services/publishVideo.js")
      )};
      export { runCliMain } from ${JSON.stringify(
        path.join(root, "src/main/cli/index.js")
      )};
    `,
    "utf8"
  );

  await build({
    entryPoints: [entryJs],
    outfile: bundleCjs,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "xlsx",
      "axios",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
  });

  const origLoad = Module._load;
  const handlers = new Map();
  let core;
  try {
    Module._load = function (request) {
      if (request === "xlsx") return xlsx;
      if (request === "electron") {
        return {
          app: {
            getPath: () => tmpDir,
            getVersion: () => "0.15.0-test",
            on: () => {},
            once: () => {},
            commandLine: { getSwitchValue: () => "" },
          },
          ipcMain: {
            handle: (ch, fn) => handlers.set(ch, fn),
            on: () => {},
          },
          BrowserWindow: function () {},
          dialog: {},
        };
      }
      if (request === "puppeteer-extra") {
        return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
      }
      if (request === "puppeteer-extra-plugin-stealth") return () => ({});
      if (request.startsWith("puppeteer")) {
        return { use: () => {}, connect: () => {} };
      }
      return origLoad.apply(this, arguments);
    };

    delete require.cache[bundleCjs];
    core = require(bundleCjs);
    core.savePublishThrottleSettings({ enabled: false });
    core.registerPublishThrottleIpc(
      { handle: (ch, fn) => handlers.set(ch, fn) },
      {
        changeData: core.changeData,
        createScheduledRecord: core.createScheduledRecord,
        notifyScheduledPublishChanged: core.notifyScheduledPublishChanged,
        findExistingScheduled: core.findExistingScheduled,
      }
    );

    const phone = "13800138000";
    const partition = `persist:${phone}抖音`;
    const publishAt = "2099-11-25 14:00:00";

    // (1) publishVideo.js：先创建 dySyncToutiao=false 的定时任务
    const createdOff = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition,
      file: clip1,
      title: "初版关同步",
      publishAt,
      creativeStatement: "ai_generated",
      dySyncToutiao: false,
    });
    assert.strictEqual(createdOff.exitCode, 0);
    assert.strictEqual(createdOff.scheduled, true);

    // 再以 dySyncToutiao=true 提交同一视频同一时间 → 拒绝复用并返 exitCode 4 / needs_attention
    const conflictOffToOn = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition,
      file: clip1,
      title: "改开同步冲突",
      publishAt,
      creativeStatement: "ai_generated",
      dySyncToutiao: true,
      publishOptions: { dySyncToutiao: true },
    });
    assert.strictEqual(conflictOffToOn.exitCode, 4);
    assert.strictEqual(conflictOffToOn.status, "needs_attention");
    assert.strictEqual(conflictOffToOn.needsAttention, true);
    assert.strictEqual(conflictOffToOn.duplicate, true);
    assert.strictEqual(conflictOffToOn.dySyncToutiao, false);
    assert.strictEqual(conflictOffToOn.requestedDySyncToutiao, true);
    assert.ok(conflictOffToOn.message.includes("抖音同步头条"));

    // 相同 dySyncToutiao=false 仍正常复用
    const reuseOff = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition,
      file: clip1,
      title: "同开关复用",
      publishAt,
      creativeStatement: "ai_generated",
      dySyncToutiao: false,
    });
    assert.strictEqual(reuseOff.exitCode, 0);
    assert.strictEqual(reuseOff.scheduled, true);
    assert.strictEqual(reuseOff.duplicate, true);

    // (2) publishThrottle.js IPC（GUI 定时创建分支）：复用时也校验 dySyncToutiao
    const createScheduledIpc = handlers.get("publish-throttle:create-scheduled");
    assert.ok(createScheduledIpc, "应注册 publish-throttle:create-scheduled IPC");

    const ipcConflictOffToOn = await createScheduledIpc(null, {
      item: {
        pt: "抖音",
        phone,
        partition,
        filePath: clip1,
        selectedFile: "ep01.mp4",
        textOtherName: "ep01",
        textType: "local",
        title: "GUI改开同步",
        creativeStatement: "ai_generated",
        publishOptions: { dySyncToutiao: true },
        scheduledPublishAtText: publishAt,
      },
      publishAtText: publishAt,
    });
    assert.strictEqual(ipcConflictOffToOn.ok, false);
    assert.strictEqual(ipcConflictOffToOn.status, "needs_attention");
    assert.strictEqual(ipcConflictOffToOn.needsAttention, true);
    assert.strictEqual(ipcConflictOffToOn.duplicate, true);
    assert.strictEqual(ipcConflictOffToOn.dySyncToutiao, false);
    assert.strictEqual(ipcConflictOffToOn.requestedDySyncToutiao, true);
    assert.ok(ipcConflictOffToOn.message.includes("抖音同步头条"));

    // 再建一条 dySyncToutiao=true 的任务（clip2），测 true → false（缺省）冲突 + true → true 复用
    const createdOn = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition,
      file: clip2,
      title: "初版开同步",
      publishAt,
      creativeStatement: "ai_generated",
      dySyncToutiao: true,
      publishOptions: { dySyncToutiao: true },
    });
    assert.strictEqual(createdOn.exitCode, 0);
    assert.strictEqual(createdOn.scheduled, true);

    const ipcConflictOnToOff = await createScheduledIpc(null, {
      item: {
        pt: "抖音",
        phone,
        partition,
        filePath: clip2,
        selectedFile: "ep02.mp4",
        textOtherName: "ep02",
        textType: "local",
        title: "GUI缺省关同步",
        creativeStatement: "ai_generated",
        publishOptions: {},
        scheduledPublishAtText: publishAt,
      },
      publishAtText: publishAt,
    });
    assert.strictEqual(ipcConflictOnToOff.ok, false);
    assert.strictEqual(ipcConflictOnToOff.status, "needs_attention");
    assert.strictEqual(ipcConflictOnToOff.dySyncToutiao, true);
    assert.strictEqual(ipcConflictOnToOff.requestedDySyncToutiao, false);

    const ipcReuseOn = await createScheduledIpc(null, {
      item: {
        pt: "抖音",
        phone,
        partition,
        filePath: clip2,
        selectedFile: "ep02.mp4",
        textOtherName: "ep02",
        textType: "local",
        title: "GUI同开同步",
        creativeStatement: "ai_generated",
        publishOptions: { dySyncToutiao: true },
        scheduledPublishAtText: publishAt,
      },
      publishAtText: publishAt,
    });
    assert.strictEqual(ipcReuseOn.ok, true);
    assert.strictEqual(ipcReuseOn.duplicate, true);
    assert.strictEqual(ipcReuseOn.dySyncToutiao, true);

    // (3) cli/index.js 批量目录 --dir 复用分支：既有 ep01 为 dySyncToutiao=false，新带 --dy-sync-toutiao 必须报 needs_attention
    const xlsxPath = path.join(mediaDir, "batch.xlsx");
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([
      ["文件名", "标题", "简介", "标签", "创作声明"],
      ["ep01.mp4", "批量改开同步", "", "", "ai_generated"],
    ]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, xlsxPath);

    const { logs: batchLogs } = await captureLogs(() =>
      core.runCliMain([
        "node",
        "app",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        phone,
        "--dir",
        mediaDir,
        "--config",
        xlsxPath,
        "--publish-at",
        publishAt,
        "--dy-sync-toutiao",
      ])
    );
    const jsonLines = batchLogs
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
    const conflictRow = jsonLines.find(
      (r) => r.progress === true && r.fileName === "ep01.mp4"
    );
    assert.ok(conflictRow, `应输出 ep01 进度行，实际=${JSON.stringify(jsonLines)}`);
    assert.strictEqual(conflictRow.status, "needs_attention");
    assert.strictEqual(conflictRow.needsAttention, true);
    assert.strictEqual(conflictRow.duplicate, true);
    assert.strictEqual(conflictRow.dySyncToutiao, false);
    assert.strictEqual(conflictRow.requestedDySyncToutiao, true);
    assert.ok(conflictRow.message.includes("抖音同步头条"));
  } finally {
    if (core && typeof core.stopScheduledPublishScheduler === "function") {
      core.stopScheduledPublishScheduler();
    }
    Module._load = origLoad;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(
    "✓ 6. 定时任务复用一致性校验 dySyncToutiao（publishThrottle / publishVideo / cli/index）通过"
  );
}

/* ------------------------------------------------------------------ *
 * 7. P2-4：MCP publish_video schema 声明与 --dy-sync-toutiao 透传
 * ------------------------------------------------------------------ */
async function testMcpPublishVideoDySyncToutiao() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s14-mcp-"));
  const pubBundle = path.join(tmpDir, "publish.mjs");
  const argsLog = path.join(tmpDir, "argv.json");
  const modeFile = path.join(tmpDir, "mode.txt");
  const fakeBin = path.join(tmpDir, "fake-matrixmedia");
  const origBin = process.env.MATRIXMEDIA_BIN;

  try {
    await build({
      entryPoints: [path.join(root, "mcp/src/tools/publish.ts")],
      outfile: pubBundle,
      bundle: true,
      platform: "node",
      format: "esm",
      external: ["@modelcontextprotocol/sdk"],
    });
    const { publishVideoTool, handlePublishVideo } = await import(
      pathToFileURL(pubBundle).href
    );

    const prop =
      publishVideoTool &&
      publishVideoTool.inputSchema &&
      publishVideoTool.inputSchema.properties &&
      publishVideoTool.inputSchema.properties.dySyncToutiao;
    assert.ok(prop, "MCP publish_video schema 必须声明 dySyncToutiao");
    assert.strictEqual(prop.type, "boolean");
    assert.strictEqual(
      (publishVideoTool.inputSchema.required || []).includes("dySyncToutiao"),
      false,
      "dySyncToutiao 必须为可选字段"
    );
    assert.ok(
      /Douyin|dy/i.test(String(prop.description || "")) &&
        /Toutiao|tt/i.test(String(prop.description || "")),
      `dySyncToutiao description 应说明仅抖音生效且与头条互斥，实际=${prop.description}`
    );

    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
const mode = fs.existsSync(${JSON.stringify(modeFile)}) ? fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "ok";
if (mode === "sched_conflict") {
  console.log(JSON.stringify({
    success: false,
    status: "needs_attention",
    needsAttention: true,
    duplicate: true,
    id: "sched-1",
    publishAt: "2099-11-25 14:00:00",
    dySyncToutiao: false,
    requestedDySyncToutiao: true,
    message: "定时任务已存在，但抖音同步头条开关不一致",
  }));
  process.exit(4);
}
console.log(JSON.stringify({ channel: "puppeteerFile-done", status: true, resultStatus: "success", publishMode: "publish", message: "上传成功" }));
`,
      "utf8"
    );
    fs.chmodSync(fakeBin, 0o755);
    process.env.MATRIXMEDIA_BIN = fakeBin;

    // true → 转发 --dy-sync-toutiao
    fs.writeFileSync(modeFile, "ok");
    await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/v.mp4",
      title: "开同步发布",
      dySyncToutiao: true,
    });
    const argvOn = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.strictEqual(
      argvOn.includes("--dy-sync-toutiao"),
      true,
      `dySyncToutiao: true 必须向 CLI 转发 --dy-sync-toutiao，实际=${JSON.stringify(argvOn)}`
    );

    // false → 不转发
    await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/v.mp4",
      title: "关同步发布",
      dySyncToutiao: false,
    });
    const argvOff = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.strictEqual(argvOff.includes("--dy-sync-toutiao"), false);

    // 省略 → 不转发
    await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/v.mp4",
      title: "缺省发布",
    });
    const argvDefault = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.strictEqual(argvDefault.includes("--dy-sync-toutiao"), false);

    // exitCode 4 定时复用冲突回执透传 dySyncToutiao / requestedDySyncToutiao
    fs.writeFileSync(modeFile, "sched_conflict");
    const conflictResp = JSON.parse(
      await handlePublishVideo({
        platform: "dy",
        phone: "13800138000",
        file: "/tmp/v.mp4",
        title: "定时复用冲突",
        publishAt: "2099-11-25 14:00:00",
        dySyncToutiao: true,
      })
    );
    assert.strictEqual(conflictResp.status, "needs_attention");
    assert.strictEqual(conflictResp.duplicate, true);
    assert.strictEqual(conflictResp.dySyncToutiao, false);
    assert.strictEqual(conflictResp.requestedDySyncToutiao, true);
  } finally {
    if (origBin === undefined) delete process.env.MATRIXMEDIA_BIN;
    else process.env.MATRIXMEDIA_BIN = origBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("✓ 7. MCP publish_video dySyncToutiao schema 与 --dy-sync-toutiao 透传通过");
}

/* ------------------------------------------------------------------ *
 * 8. 返修第 2 轮：GUI 历史重发保留原任务 dySyncToutiao，不读也不覆盖 localStorage 偏好
 * ------------------------------------------------------------------ */
async function testGuiHistoryRepublishDySyncToutiao() {
  const vmSrc = fs.readFileSync(
    path.join(root, "src/renderer/views/videoManager/index.vue"),
    "utf8"
  );
  const vmSfc = compiler.parseComponent(vmSrc);
  assert.ok(vmSfc.template && vmSfc.template.content);
  const vmCompiled = compiler.compile(vmSfc.template.content);
  assert.strictEqual(
    vmCompiled.errors.length,
    0,
    `videoManager/index.vue 模板编译报错: ${vmCompiled.errors.join("; ")}`
  );

  const lvpSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  const lvpSfc = compiler.parseComponent(lvpSrc);
  assert.ok(lvpSfc.template && lvpSfc.template.content);
  const lvpCompiled = compiler.compile(lvpSfc.template.content);
  assert.strictEqual(
    lvpCompiled.errors.length,
    0,
    `LocalVideoPublish.vue 模板编译报错: ${lvpCompiled.errors.join("; ")}`
  );

  const videoLink = bundle("src/shared/videoLink.js", "videoLink-repub.cjs");
  const videoMetadata = bundle(
    "src/shared/videoMetadata.js",
    "videoMetadata-repub.cjs"
  );
  const accountIdentity = bundle(
    "src/shared/accountIdentity.js",
    "accountIdentity-repub.cjs"
  );

  function loadVueComponent(sfc, extraGlobals) {
    const importedNames = [
      ...sfc.script.content.matchAll(
        /^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm
      ),
    ].flatMap((m) =>
      m[1]
        .replace(/[{}]/g, "")
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/).pop())
        .filter(Boolean)
    );
    const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
    const ctx = vm.createContext({
      ...stubs,
      ...extraGlobals,
    });
    const script = sfc.script.content
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
      .replace("export default", "globalThis.component =");
    vm.runInContext(script, ctx);
    return ctx.component;
  }

  const STORAGE_KEY = "matrixmedia.publish.dySyncToutiao";
  const storageMap = new Map();
  let prefReads = 0;
  let prefWrites = 0;
  const mockLocalStorage = {
    getItem(k) {
      if (k === STORAGE_KEY) prefReads += 1;
      return storageMap.has(k) ? storageMap.get(k) : null;
    },
    setItem(k, v) {
      if (k === STORAGE_KEY) prefWrites += 1;
      storageMap.set(k, String(v));
    },
    removeItem(k) {
      storageMap.delete(k);
    },
  };
  const resetPrefCounters = () => {
    prefReads = 0;
    prefWrites = 0;
  };
  const setStoredPref = (val) => {
    storageMap.set(STORAGE_KEY, val ? "true" : "false");
    resetPrefCounters();
  };

  const lvpComp = loadVueComponent(lvpSfc, {
    ...videoLink,
    ...videoMetadata,
    ...accountIdentity,
    splitAndSanitizeTags: () => [],
    localStorage: mockLocalStorage,
  });
  const vmComp = loadVueComponent(vmSfc, {
    ...videoMetadata,
    ...accountIdentity,
    ipcRenderer: { invoke: async () => true },
  });

  const lvpState = {
    ...lvpComp.data(),
    $set: (o, k, v) => {
      o[k] = v;
    },
    $message: {
      warning: () => {},
      error: () => {},
      info: () => {},
      success: () => {},
    },
    $nextTick: () => {},
  };
  for (const [name, fn] of Object.entries(lvpComp.methods)) {
    lvpState[name] = fn.bind(lvpState);
  }
  lvpState.loadPublishThrottleDefaults = async () => "none";
  lvpState.loadAccounts = () => {};
  lvpState.getPlatformStatement = () => "none";

  let lastRepublishPayload = null;
  const historyVm = {
    isPublishFailed: vmComp.methods.isPublishFailed,
    $confirm: async () => {
      throw "cancel";
    },
    $message: {
      warning: () => {},
      error: () => {},
      info: () => {},
      success: () => {},
    },
    $refs: {
      localPublishRef: {
        openRepublish(payload) {
          lastRepublishPayload = payload;
          return lvpState.openRepublish(payload);
        },
      },
    },
  };

  async function triggerHistoryRepublish(records) {
    lastRepublishPayload = null;
    await vmComp.methods.handleRepublish.call(historyVm, {
      textType: "local",
      showAlltype: records,
    });
    return {
      payload: lastRepublishPayload,
      checkbox: lvpState.form.dySyncToutiao,
    };
  }

  const dyNode = { id: "n-dy", pt: "抖音", phone: "13800138000", url: "https://dy" };

  // 8a. 方向一：原任务开启（publishOptions.dySyncToutiao=true），当前偏好关闭（false）
  //     → 预填 true，透传 dySyncToutiao: true，且不读也不覆盖 localStorage 偏好
  setStoredPref(false);
  const dir1 = await triggerHistoryRepublish([
    {
      id: "rec-on",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-on",
      bt: "原任务开同步",
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      filePath: "/fake/clip-on.mp4",
      publishStatus: "failed",
      publishOptions: { dySyncToutiao: true, collection: "民间故事" },
    },
  ]);
  assert.strictEqual(dir1.payload.records[0].dySyncToutiao, true);
  // 只透传同步开关，不复制整份 publishOptions（避免回填旧商品/合集）
  assert.strictEqual(dir1.payload.records[0].publishOptions, undefined);
  assert.strictEqual(dir1.payload.form.dySyncToutiao, true);
  assert.strictEqual(dir1.checkbox, true, "原任务开启+当前偏好关闭：重发必须预填 true");
  assert.strictEqual(prefReads, 0, "历史重发不得读取 localStorage 偏好");
  assert.strictEqual(prefWrites, 0, "历史重发不得覆盖 localStorage 偏好");
  assert.strictEqual(storageMap.get(STORAGE_KEY), "false");
  assert.strictEqual(
    lvpState.buildPlatformVideoPayload(dyNode, { data: {} }).publishOptions
      .dySyncToutiao,
    true,
    "重发提交时应保持 dySyncToutiao: true"
  );

  // 8b. 方向二（显式 false）：原任务 publishOptions.dySyncToutiao=false，当前偏好开启（true）
  //     → 预填 false，提交不带 dySyncToutiao，且不读也不覆盖 localStorage 偏好
  setStoredPref(true);
  const dir2Explicit = await triggerHistoryRepublish([
    {
      id: "rec-explicit-off",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-off",
      bt: "原任务显式关同步",
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      filePath: "/fake/clip-off.mp4",
      publishStatus: "failed",
      publishOptions: { dySyncToutiao: false },
    },
  ]);
  assert.strictEqual(dir2Explicit.payload.records[0].dySyncToutiao, false);
  assert.strictEqual(dir2Explicit.payload.records[0].publishOptions, undefined);
  assert.strictEqual(dir2Explicit.payload.form.dySyncToutiao, false);
  assert.strictEqual(
    dir2Explicit.checkbox,
    false,
    "原任务显式 false + 当前偏好开启：重发必须预填 false"
  );
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      lvpState.buildPlatformVideoPayload(dyNode, { data: {} }).publishOptions,
      "dySyncToutiao"
    ),
    false,
    "原任务为 false 时重发提交不得带上 dySyncToutiao"
  );

  // 8c. 方向二（顶层显式 false）：record.dySyncToutiao=false，当前偏好开启（true）
  setStoredPref(true);
  const dir2TopFalse = await triggerHistoryRepublish([
    {
      id: "rec-top-off",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-top-off",
      bt: "原任务顶层关同步",
      pt: "抖音",
      phone: "13800138000",
      filePath: "/fake/clip-top-off.mp4",
      publishStatus: "failed",
      dySyncToutiao: false,
    },
  ]);
  assert.strictEqual(dir2TopFalse.payload.records[0].dySyncToutiao, false);
  assert.strictEqual(dir2TopFalse.checkbox, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  // 8d. 方向二（正常关同步记录 publishOptions: {}）：当前偏好开启（true）→ 预填 false
  setStoredPref(true);
  const dir2EmptyOpts = await triggerHistoryRepublish([
    {
      id: "rec-empty-opts",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-empty",
      bt: "原任务关同步空选项",
      pt: "抖音",
      phone: "13800138000",
      filePath: "/fake/clip-empty.mp4",
      publishStatus: "failed",
      publishOptions: {},
    },
  ]);
  assert.strictEqual(dir2EmptyOpts.checkbox, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  // 8e. 旧任务（无 publishOptions、无 dySyncToutiao 字段）：当前偏好开启（true）→ 按 false
  setStoredPref(true);
  const legacyTask = await triggerHistoryRepublish([
    {
      id: "rec-legacy",
      date: "2026-10-01",
      textType: "local",
      textOtherName: "clip-legacy",
      bt: "历史旧任务",
      pt: "抖音",
      phone: "13800138000",
      filePath: "/fake/clip-legacy.mp4",
      publishStatus: "failed",
    },
  ]);
  assert.strictEqual(legacyTask.checkbox, false, "旧任务无该字段必须按 false");
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  // 8f. 多平台合并记录：details[0] 为快手，details[1] 为抖音（dySyncToutiao: true），偏好关闭 → 仍识别抖音记录为 true
  setStoredPref(false);
  const multiPlatform = await triggerHistoryRepublish([
    {
      id: "rec-ks",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-multi",
      bt: "多平台发布",
      pt: "快手",
      phone: "13800138000",
      partition: "persist:13800138000快手",
      filePath: "/fake/clip-multi.mp4",
      publishStatus: "success",
      publishOptions: {},
    },
    {
      id: "rec-dy",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-multi",
      bt: "多平台发布",
      pt: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      filePath: "/fake/clip-multi.mp4",
      publishStatus: "failed",
      publishOptions: { dySyncToutiao: true },
    },
  ]);
  assert.strictEqual(multiPlatform.checkbox, true);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "false");

  // 8g. 同行多抖音账号：账号 A 成功且 dySyncToutiao=true，账号 B 失败且 dySyncToutiao=false → 优先按失败目标 B 预填 false
  setStoredPref(true);
  const multiDy = await triggerHistoryRepublish([
    {
      id: "rec-dy-a",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-multi-dy",
      bt: "双抖音",
      pt: "抖音",
      phone: "13800138001",
      partition: "persist:13800138001抖音",
      filePath: "/fake/clip-multi-dy.mp4",
      publishStatus: "success",
      publishOptions: { dySyncToutiao: true },
    },
    {
      id: "rec-dy-b",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-multi-dy",
      bt: "双抖音",
      pt: "抖音",
      phone: "13800138002",
      partition: "persist:13800138002抖音",
      filePath: "/fake/clip-multi-dy.mp4",
      publishStatus: "failed",
      publishOptions: { dySyncToutiao: false },
    },
  ]);
  assert.strictEqual(multiDy.checkbox, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  // 8h. 历史重发弹窗内手动切换复选框：不覆盖 localStorage 偏好；关闭重发后新发布仍沿用原偏好且可正常保存
  setStoredPref(true);
  await triggerHistoryRepublish([
    {
      id: "rec-toggle",
      date: "2026-11-23",
      textType: "local",
      textOtherName: "clip-toggle",
      bt: "重发内切换",
      pt: "抖音",
      phone: "13800138000",
      filePath: "/fake/clip-toggle.mp4",
      publishStatus: "failed",
      publishOptions: { dySyncToutiao: false },
    },
  ]);
  assert.strictEqual(lvpState.form.dySyncToutiao, false);
  lvpState.form.dySyncToutiao = true;
  lvpState.saveDySyncToutiaoPreference(true);
  lvpState.form.dySyncToutiao = false;
  lvpState.saveDySyncToutiaoPreference(false);
  assert.strictEqual(prefWrites, 0, "历史重发内切换复选框不得覆盖 localStorage 偏好");
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  lvpState.resetState();
  assert.strictEqual(lvpState.republishContext, null);
  assert.strictEqual(lvpState.form.dySyncToutiao, true, "退出重发后应恢复原 localStorage 偏好");
  lvpState.open("/fake/new.mp4");
  assert.strictEqual(lvpState.form.dySyncToutiao, true);
  lvpState.saveDySyncToutiaoPreference(false);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "false", "普通发布切换复选框应正常写入偏好");

  // 8i. 直接调用 LocalVideoPublish.openRepublish（不传 form.dySyncToutiao，仅靠 payload.records）同样两个方向准确且不碰偏好
  setStoredPref(false);
  lvpState.openRepublish({
    filePath: "/fake/direct-on.mp4",
    form: { bt1: "直接重发开" },
    records: [{ pt: "抖音", publishOptions: { dySyncToutiao: true } }],
  });
  assert.strictEqual(lvpState.form.dySyncToutiao, true);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "false");

  setStoredPref(true);
  lvpState.openRepublish({
    filePath: "/fake/direct-off.mp4",
    form: { bt1: "直接重发关" },
    records: [{ pt: "抖音", publishOptions: { dySyncToutiao: false } }],
  });
  assert.strictEqual(lvpState.form.dySyncToutiao, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  // 8j. 同账号合并行：一条关同步（失败）+ 一条开同步（待执行）→ 保守按 false，不误同步到头条
  setStoredPref(true);
  lvpState.openRepublish({
    filePath: "/fake/direct-merged.mp4",
    form: { bt1: "合并行" },
    records: [
      { pt: "抖音", partition: "persist:dyA", dySyncToutiao: false },
      { pt: "抖音", partition: "persist:dyA", dySyncToutiao: true },
    ],
    failedTargets: [{ pt: "抖音", partition: "persist:dyA" }],
  });
  assert.strictEqual(lvpState.form.dySyncToutiao, false, "合并行有关闭记录时必须按 false");

  setStoredPref(true);
  lvpState.openRepublish({
    filePath: "/fake/direct-legacy.mp4",
    form: { bt1: "直接重发旧任务" },
    records: [{ pt: "抖音" }],
  });
  assert.strictEqual(lvpState.form.dySyncToutiao, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  setStoredPref(true);
  lvpState.openRepublish({
    filePath: "/fake/direct-empty.mp4",
    form: { bt1: "直接重发无记录" },
    records: [],
  });
  assert.strictEqual(lvpState.form.dySyncToutiao, false);
  assert.strictEqual(prefReads, 0);
  assert.strictEqual(prefWrites, 0);
  assert.strictEqual(storageMap.get(STORAGE_KEY), "true");

  console.log(
    "✓ 8. GUI 历史重发保留原任务 dySyncToutiao（正反两向 + 旧任务按 false + 不读不覆盖偏好）通过"
  );
}

(async () => {
  testCliAndHttpPassthrough();
  await testFakeDomSyncToggle();
  await testDyHandlerIntegration();
  await testConflictAndGuiPersistence();
  await testConflictBeforeDedupeAndThrottle();
  await testScheduledReuseDySyncConsistency();
  await testMcpPublishVideoDySyncToutiao();
  await testGuiHistoryRepublishDySyncToutiao();
  console.log("\ntest-dy-sync-toutiao: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
