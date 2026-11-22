"use strict";

/**
 * S12 任务 B：发布时选择合集（collection）全链路单测
 * 1. 共享字段解析与覆盖优先级（resolveCollectionOption / buildCollectionOption / 平台支持表 / getPublishAttemptLimit）
 * 2. Excel 导入识别「合集」列（含 _x000d_ 清洗与空值）
 * 3. CLI (--collection) 与 HTTP POST /publish (collection / collections / platformOptions.<pt>.collection / platforms[]) 入参与优先级 + help 文案
 * 4. GUI LocalVideoPublish.vue 模板编译 + 批量合集输入 / 单账号覆盖 / Excel 行合并 / 重发回填
 * 5. 回读匹配与精确匹配纯函数（isExactCollectionMatch / matchesCollectionReadback / formatCollectionCandidates）
 * 6. 留空不调用平台逻辑（page 零访问）
 * 7. 假 page DOM 集成（抖音 Semi / 快手 Ant mousedown / 视频号 wujie shadowRoot）：
 *    - 成功选择 + 回读校验 + [collection] 诊断日志
 *    - 失败路径 1：入口缺失（含 shadowRoot 未找到）→ 确定性错误 + 入口查找详情 + 截图
 *    - 失败路径 2：同名合集缺失（含前缀相近干扰项，最多列 10 个候选）→ 确定性错误 + 候选清单 + 截图
 *    - 失败路径 3：回读不符 → 确定性错误 + 控件实读文案 + 候选清单 + 截图
 * 8. 平台 handler 门禁（dy.js / ks.js / sph.js）：合集失败不点击发布/草稿按钮，回执带完整错误与截图
 */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const vm = require("vm");
const xlsx = require("xlsx");
const { build, buildSync } = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "test/.cache/collection");
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

const videoLink = bundle("src/shared/videoLink.js", "videoLink.cjs");
const xhsPolicy = bundle("src/shared/xhsPublishPolicy.js", "xhsPublishPolicy.cjs");
const parsePublish = bundle("src/main/cli/parsePublishArgs.js", "parsePublishArgs.cjs");
const collectionMod = bundle("src/main/services/upLoad/collection.js", "collection.cjs");
const {
  normalizeBatchXlsxRows,
  sanitizePublishCliArgs,
  sanitizePublishPayloadObject,
} = require(path.join(root, "src/shared/textSanitize.js"));

/* ------------------------------------------------------------------ *
 * 迷你 DOM 引擎（支持普通 DOM 与 wujie shadowRoot、class/attr/id/后代选择器、MouseEvent）
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
    this.shadowRoot = null;
    this.rect = { left: 10, top: 10, width: 120, height: 32 };
    this.onClick = null;
    this.events = [];
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
    const pseudoMatches = [...rest.matchAll(/:(first-child|last-child)/g)];
    for (const m of pseudoMatches) {
      const siblings = this.parentElement ? this.parentElement.children : [];
      if (!siblings.length) return false;
      if (m[1] === "first-child" && siblings[0] !== this) return false;
      if (m[1] === "last-child" && siblings[siblings.length - 1] !== this) {
        return false;
      }
    }
    rest = rest.replace(/:(first-child|last-child)/g, "");
    return rest.trim() === "";
  }
  matches(selector) {
    const matchCompoundChain = (el, chain) => {
      // chain 形如 [{ sel, comb }, ...] 从左到右，最后一项 comb 为 null
      const checkAt = (node, idx) => {
        if (!node || !node.matchesSingle(chain[idx].sel)) return false;
        if (idx === 0) return true;
        const comb = chain[idx - 1].comb;
        if (comb === ">") {
          return checkAt(node.parentElement, idx - 1);
        }
        if (comb === "+") {
          const sibs = node.parentElement ? node.parentElement.children : [];
          const pos = sibs.indexOf(node);
          return pos > 0 ? checkAt(sibs[pos - 1], idx - 1) : false;
        }
        // 默认后代组合符 " "
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
        // 拆出选择器段与组合符（>、+、空格）
        const normalized = trimmed.replace(/\s*([>+])\s*/g, " $1 ");
        const rawTokens = normalized.split(/\s+/).filter(Boolean);
        const chain = [];
        for (let i = 0; i < rawTokens.length; i++) {
          const tk = rawTokens[i];
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
        if (!chain.length) return false;
        return matchCompoundChain(this, chain);
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
  dispatchEvent(ev) {
    this.events.push(ev && ev.type ? ev.type : "event");
    if (ev && ev.type === "mousedown" && this.onMouseDown) this.onMouseDown();
    if (ev && ev.type === "click" && this.onClick) this.onClick();
  }
}

class FakeMouseEvent {
  constructor(type, opts) {
    this.type = type;
    this.opts = opts;
  }
}

/**
 * 构建指定平台的假页面 DOM：
 * mode: "success" | "missing_entry" | "missing_shadow" | "missing_option" | "readback_mismatch"
 */
function buildFakeCollectionPage(platformKey, mode = "success", extra = {}) {
  const doc = new FakeElement("document");
  const body = new FakeElement("body");
  doc.body = body;
  doc.append(body);
  doc.getElementById = (id) => doc.querySelector(`[id="${id}"]`);

  let root = body;
  if (platformKey === "sph") {
    if (mode !== "missing_shadow") {
      const wujie = new FakeElement("wujie-app", "", { class: "wujie_iframe" });
      const shadow = new FakeElement("shadow-root");
      shadow.getElementById = (id) => shadow.querySelector(`[id="${id}"]`);
      wujie.shadowRoot = shadow;
      body.append(wujie);
      root = shadow;
    }
  }

  const state = {
    entryClicked: false,
    entryEvents: [],
    optionClicked: "",
    optionEvents: [],
    readbackNode: null,
  };

  if (mode === "missing_entry") {
    const otherRow = new FakeElement("div", "", { class: "form-item" });
    otherRow.append(
      new FakeElement("label", "作者声明"),
      new FakeElement("span", "更多设置")
    );
    root.append(otherRow);
  } else if (mode !== "missing_shadow") {
    const row = new FakeElement("div", "", {
      class:
        platformKey === "ks"
          ? "edit-form-item"
          : platformKey === "sph"
          ? "post-album-wrap"
          : "setting-item",
    });
    const labelText =
      platformKey === "ks"
        ? "合集"
        : platformKey === "sph"
        ? "添加到合集"
        : "添加到合集";
    const label = new FakeElement("label", labelText);

    const triggerClass =
      platformKey === "ks"
        ? "ant-select-selector"
        : platformKey === "sph"
        ? "post-album-display"
        : "semi-select select-collection-nkL6sA";
    const trigger = new FakeElement("div", "", {
      class: triggerClass,
      role: "combobox",
    });
    const displaySpan = new FakeElement("span", "请选择合集", {
      class:
        platformKey === "ks"
          ? "ant-select-selection-item"
          : platformKey === "sph"
          ? "album-name"
          : "semi-select-selection-text",
    });
    trigger.append(displaySpan);
    row.append(label, trigger);
    root.append(row);
    state.readbackNode = displaySpan;

    const openPopup = () => {
      state.entryClicked = true;
      state.entryEvents = trigger.events.slice();
      if (root.querySelector(".mm-test-popup")) return;
      const popupClass =
        platformKey === "ks"
          ? "ant-select-dropdown mm-test-popup"
          : platformKey === "sph"
          ? "common-option-list-wrap mm-test-popup"
          : "mix-dropdown semi-select-option-list mm-test-popup";
      const optClass =
        platformKey === "ks"
          ? "ant-select-item-option"
          : platformKey === "sph"
          ? "option-item"
          : "semi-select-option collection-option";
      const popup = new FakeElement("div", "", {
        class: popupClass,
        role: "listbox",
      });

      const list =
        extra.candidates ||
        (mode === "missing_option"
          ? [
              "民间故事番外",
              "都市传说",
              "悬疑奇闻",
              "历史野史",
              "山海异志",
              "乡野笔记",
              "奇谈录",
              "夜话集",
              "古今奇案",
              "灵异档案",
              "第11个合集",
              "第12个合集",
            ]
          : ["民间故事番外", "都市传说", "民间 故事", "悬疑奇闻"]);

      for (const title of list) {
        const opt = new FakeElement("div", "", {
          class: optClass,
          role: "option",
          ...(platformKey === "ks" ? { title } : {}),
        });
        opt.append(new FakeElement("span", title, { class: "title" }));
        const onPick = () => {
          state.optionClicked = title;
          state.optionEvents = opt.events.slice();
          if (mode === "success") {
            if (platformKey === "sph") {
              // 视频号控件外层可含「已选：」前缀，但已选标签子节点 .album-name 文本恰为目标名
              trigger.children = [];
              trigger.append(
                new FakeElement("span", "已选：", { class: "prefix" }),
                new FakeElement("span", title, { class: "album-name" })
              );
            } else {
              displaySpan.textContent = title;
            }
          } else if (mode === "readback_mismatch") {
            displaySpan.textContent = extra.wrongReadback || "都市传说";
          }
          popup.remove();
        };
        if (platformKey === "ks") {
          opt.onMouseDown = onPick;
        } else {
          opt.onClick = onPick;
        }
        popup.append(opt);
      }
      root.append(popup);
    };

    if (platformKey === "ks") {
      // Ant Design Select 监听 mousedown 展开下拉，故意不绑 onClick 以验证确实派发了 mousedown
      trigger.onMouseDown = openPopup;
    } else {
      trigger.onClick = openPopup;
    }
  }

  const page = {
    async evaluate(fn, arg) {
      const prevDoc = global.document;
      const prevStyle = global.getComputedStyle;
      const prevMouse = global.MouseEvent;
      const prevWindow = global.window;
      global.document = doc;
      global.getComputedStyle = (el) => ({
        display: el && el.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      });
      global.MouseEvent = FakeMouseEvent;
      global.window = {};
      try {
        const runner = new Function(
          "document",
          "getComputedStyle",
          "MouseEvent",
          "window",
          "arg",
          `return (${fn.toString()})(arg);`
        );
        return runner(doc, global.getComputedStyle, FakeMouseEvent, {}, arg);
      } finally {
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevStyle === undefined) delete global.getComputedStyle;
        else global.getComputedStyle = prevStyle;
        if (prevMouse === undefined) delete global.MouseEvent;
        else global.MouseEvent = prevMouse;
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
      }
    },
    async waitForTimeout() {},
  };

  return { page, state };
}

/* ------------------------------------------------------------------ *
 * 1. 字段解析 / 覆盖优先级 / 平台能力 / 重试上限
 * ------------------------------------------------------------------ */
function testSharedCollectionResolution() {
  assert.strictEqual(videoLink.platformSupportsCollection("抖音"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("dy"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("快手"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("ks"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("视频号"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("sph"), true);
  assert.strictEqual(videoLink.platformSupportsCollection("哔哩哔哩"), false);
  assert.strictEqual(videoLink.platformSupportsCollection("百家号"), false);
  assert.strictEqual(videoLink.platformSupportsCollection("小红书"), false);

  assert.strictEqual(
    videoLink.normalizeCollectionName("  民间_x000d_\r\n故事  "),
    "民间 故事"
  );
  assert.strictEqual(videoLink.normalizeCollectionName("   "), "");
  assert.strictEqual(videoLink.normalizeCollectionName(null), "");

  // 留空
  assert.deepStrictEqual(videoLink.resolveCollectionOption("抖音", {}), {
    enabled: false,
    name: "",
    platformKey: "dy",
    supported: true,
    failurePolicy: "stop",
  });
  assert.strictEqual(
    videoLink.resolveCollectionOption("抖音", { collection: "   " }).enabled,
    false
  );

  // 全局 collection（字符串与对象形态）
  assert.deepStrictEqual(
    videoLink.resolveCollectionOption("抖音", { collection: " 民间故事 " }),
    {
      enabled: true,
      name: "民间故事",
      platformKey: "dy",
      supported: true,
      failurePolicy: "stop",
    }
  );
  assert.strictEqual(
    videoLink.resolveCollectionOption("快手", {
      collection: { enabled: true, name: "民间故事" },
    }).name,
    "民间故事"
  );
  assert.strictEqual(
    videoLink.resolveCollectionOption("快手", {
      collection: { enabled: false, name: "民间故事" },
    }).enabled,
    false
  );

  // 覆盖优先级：platformOptions[pt].collection > collections[pt] > collection（全局）
  const layered = {
    collection: "全局合集",
    collections: { dy: "抖音Map合集", 快手: "快手Map合集", sph: "" },
    platformOptions: {
      dy: { collection: "抖音PlatformOpts合集" },
    },
  };
  assert.strictEqual(
    videoLink.resolveCollectionOption("抖音", layered).name,
    "抖音PlatformOpts合集"
  );
  assert.strictEqual(
    videoLink.resolveCollectionOption("快手", layered).name,
    "快手Map合集"
  );
  // 显式按平台覆盖为空串：关闭该平台合集，不回退全局
  assert.strictEqual(
    videoLink.resolveCollectionOption("视频号", layered).enabled,
    false
  );
  assert.strictEqual(
    videoLink.resolveCollectionOption("视频号", layered).name,
    ""
  );
  // 未在覆写表中的平台回退全局
  assert.strictEqual(
    videoLink.resolveCollectionOption("视频号", {
      collection: "全局合集",
      collections: { dy: "抖音专属" },
    }).name,
    "全局合集"
  );
  // 不支持平台始终 disabled
  assert.strictEqual(
    videoLink.resolveCollectionOption("哔哩哔哩", { collection: "全局合集" })
      .enabled,
    false
  );

  // 重试上限：显式启用合集时 dy/ks/sph 均限 1 次（不重试）；留空或不支持平台维持默认 5 次
  for (const pt of ["抖音", "快手", "视频号"]) {
    assert.strictEqual(
      xhsPolicy.getPublishAttemptLimit({
        pt,
        publishOptions: { collection: "民间故事" },
      }),
      1,
      `${pt} 启用合集时不得重试`
    );
    assert.strictEqual(
      xhsPolicy.getPublishAttemptLimit({ pt, publishOptions: {} }),
      5,
      `${pt} 未启用合集保持默认重试上限`
    );
  }
  assert.strictEqual(
    xhsPolicy.getPublishAttemptLimit({
      pt: "哔哩哔哩",
      publishOptions: { collection: "民间故事" },
    }),
    5,
    "不支持合集的平台重试上限不变"
  );
  console.log("✓ 1. 共享合集解析、覆盖优先级与重试上限校验通过");
}

/* ------------------------------------------------------------------ *
 * 2. Excel 导入识别「合集」列
 * ------------------------------------------------------------------ */
function testExcelCollectionColumn() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-col-xlsx-"));
  try {
    const xlsxPath = path.join(tmpDir, "batch.xlsx");
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([
      {
        文件名: "ep01.mp4",
        标题: "第一集",
        简介: "简介1",
        标签: "故事",
        合集: "  民间故事_x000d_\n",
      },
      {
        文件名: "ep02.mp4",
        标题: "第二集",
        简介: "简介2",
        标签: "故事",
        合集: "",
      },
    ]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, xlsxPath);

    const readWb = xlsx.readFile(xlsxPath);
    const rawRows = xlsx.utils.sheet_to_json(
      readWb.Sheets[readWb.SheetNames[0]],
      { defval: "" }
    );
    const rows = normalizeBatchXlsxRows(rawRows);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].collection, "民间故事");
    assert.strictEqual(rows[1].collection, "");

    // 兼容英文列名 collection 与「合集名称」
    const altRows = normalizeBatchXlsxRows([
      { fileName: "a.mp4", collection: "都市传说" },
      { 文件名: "b.mp4", 合集名称: "山海异志" },
    ]);
    assert.strictEqual(altRows[0].collection, "都市传说");
    assert.strictEqual(altRows[1].collection, "山海异志");
    console.log("✓ 2. Excel 导入「合集」列解析与清洗通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 3. CLI / HTTP 入参、优先级与帮助文本
 * ------------------------------------------------------------------ */
function testCliAndHttpInputs() {
  // CLI --collection（支持空格分隔与 = 写法）
  const cliDy = parsePublish.parsePublishArgs(
    sanitizePublishCliArgs([
      "-p",
      "dy",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "标题",
      "--collection",
      " 民间故事_x000d_ ",
    ])
  );
  assert.strictEqual(cliDy.ok, true, cliDy.error);
  assert.strictEqual(cliDy.value.collection, "民间故事");
  assert.strictEqual(cliDy.value.publishOptions.collection, "民间故事");

  const cliSphEq = parsePublish.parsePublishArgs(
    sanitizePublishCliArgs([
      "-p",
      "sph",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "标题",
      "--collection=民间故事",
    ])
  );
  assert.strictEqual(cliSphEq.ok, true, cliSphEq.error);
  assert.strictEqual(cliSphEq.value.publishOptions.collection, "民间故事");

  // CLI 留空 / 未传 → publishOptions 无 collection 键
  const cliEmpty = parsePublish.parsePublishArgs([
    "-p",
    "ks",
    "--phone",
    "13800138000",
    "-f",
    "./v.mp4",
    "-t",
    "标题",
  ]);
  assert.strictEqual(cliEmpty.ok, true);
  assert.deepStrictEqual(cliEmpty.value.publishOptions, {});

  // CLI 非支持平台（B 站）→ 忽略且不污染 publishOptions
  const cliBlbl = parsePublish.parsePublishArgs([
    "-p",
    "blbl",
    "--phone",
    "13800138000",
    "-f",
    "./v.mp4",
    "-t",
    "标题",
    "--collection",
    "民间故事",
  ]);
  assert.strictEqual(cliBlbl.ok, true);
  assert.deepStrictEqual(cliBlbl.value.publishOptions, {});

  // HTTP 单平台
  const httpSingle = parsePublish.parseMultiPublishRequest(
    sanitizePublishPayloadObject({
      platform: "dy",
      phone: "13800138000",
      file: "./v.mp4",
      title: "标题",
      collection: "民间故事_x000d_",
    })
  );
  assert.strictEqual(httpSingle.ok, true, httpSingle.error);
  assert.strictEqual(httpSingle.value.publishOptions.collection, "民间故事");

  // HTTP 多平台覆盖优先级：target.collection > target.platformOptions > body.platformOptions > body.collections > body.collection
  const httpMulti = parsePublish.parseMultiPublishRequest(
    sanitizePublishPayloadObject({
      phone: "13800138000",
      file: "./v.mp4",
      title: "标题",
      collection: "全局合集",
      collections: { ks: "快手Map合集", sph: "视频号Map合集" },
      platformOptions: {
        sph: { collection: "视频号PlatformOpts合集" },
      },
      platforms: [
        { platform: "dy" }, // 走全局
        { platform: "ks", collection: "" }, // 显式空串取消全局与 Map
        { platform: "sph" }, // 走 body.platformOptions.sph.collection
        { platform: "dy", phone: "13900139000", collection: "抖音单账号覆写" },
        { platform: "blbl" }, // 不支持平台忽略
      ],
    })
  );
  assert.strictEqual(httpMulti.ok, true, httpMulti.error);
  assert.strictEqual(httpMulti.value[0].publishOptions.collection, "全局合集");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      httpMulti.value[1].publishOptions,
      "collection"
    ),
    false,
    "显式空串覆盖应取消合集"
  );
  assert.strictEqual(
    httpMulti.value[2].publishOptions.collection,
    "视频号PlatformOpts合集"
  );
  assert.strictEqual(
    httpMulti.value[3].publishOptions.collection,
    "抖音单账号覆写"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      httpMulti.value[4].publishOptions,
      "collection"
    ),
    false
  );

  // HTTP 非法类型拦截
  const httpBad = parsePublish.parseMultiPublishRequest({
    platform: "dy",
    phone: "13800138000",
    file: "./v.mp4",
    title: "标题",
    collection: ["民间故事"],
  });
  assert.strictEqual(httpBad.ok, false);
  assert.ok(httpBad.error.includes("collection"));

  // CLI 帮助文本
  const help = parsePublish.publishHelpText();
  assert.ok(help.includes("--collection"), "CLI 帮助应包含 --collection");
  assert.ok(help.includes("合集"), "CLI 帮助应说明合集功能");

  // S12-fix1(3)：取值型参数缺值或下一个 token 以 -- 开头时报参数错误，绝不吞掉后面的 flag
  {
    const swallowed = parsePublish.parsePublishArgs([
      "-p",
      "dy",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "标题",
      "--collection",
      "--draft",
    ]);
    assert.strictEqual(
      swallowed.ok,
      false,
      "--collection --draft 必须报参数错误，不得把 --draft 吞成合集名"
    );
    assert.ok(swallowed.error.includes("--collection"));

    const trailingMissing = parsePublish.parsePublishArgs([
      "-p",
      "dy",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "标题",
      "--collection",
    ]);
    assert.strictEqual(trailingMissing.ok, false, "末尾缺值 --collection 必须报错");

    const okWithDraft = parsePublish.parsePublishArgs([
      "-p",
      "dy",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "标题",
      "--collection",
      "民间故事",
      "--draft",
    ]);
    assert.strictEqual(okWithDraft.ok, true, okWithDraft.error);
    assert.strictEqual(okWithDraft.value.draft, true);
    assert.strictEqual(okWithDraft.value.collection, "民间故事");
    assert.strictEqual(okWithDraft.value.publishOptions.collection, "民间故事");

    // 其他取值型参数同样不得吞掉后续 --flag 或末尾缺值
    for (const badArgs of [
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "--draft"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "--allow-duplicate"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "--help"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "-h"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--cover", "--draft"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--tags", "--draft"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--cs", "--draft"],
      ["-p", "sph", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--sph-product-id", "--draft"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--description"],
      // S12-fix2(C8)：严格取值型参数下一个 token 以 "-" 开头（含短选项 -t/-p/-h 与 --help）即报缺值
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--collection", "--help"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--collection", "-h"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--collection", "-t", "x"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--collection=-t"],
      ["-p", "-t", "标题", "--phone", "13800138000", "-f", "./v.mp4"],
      ["-p", "dy", "-f", "-t", "标题", "--phone", "13800138000"],
      ["-p", "dy", "--phone", "-t", "标题", "-f", "./v.mp4"],
      ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "标题", "--publish-at", "-h"],
    ]) {
      const r = parsePublish.parsePublishArgs(badArgs);
      assert.strictEqual(
        r.ok,
        false,
        `取值型参数缺值或吞 flag 必须报错: ${JSON.stringify(badArgs)}`
      );
    }

    // S12-fix2(C8)：正文类参数按字面取非开关 token；HTTP 草稿请求简介「--开场--」正常解析
    const literalDescHttp = parsePublish.parsePublishRequest({
      platform: "dy",
      phone: "13800138000",
      file: "./v.mp4",
      title: "--标题--",
      description: "--开场--",
      draft: true,
    });
    assert.strictEqual(
      literalDescHttp.ok,
      true,
      `HTTP 草稿请求简介「--开场--」应正常解析，实际: ${literalDescHttp.error}`
    );
    assert.strictEqual(literalDescHttp.value.title, "--标题--");
    assert.strictEqual(literalDescHttp.value.description, "--开场--");
    assert.strictEqual(literalDescHttp.value.draft, true);

    const literalDescCli = parsePublish.parsePublishArgs([
      "-p",
      "dy",
      "--phone",
      "13800138000",
      "-f",
      "./v.mp4",
      "-t",
      "--开场标题--",
      "--description",
      "--开场--",
      "--draft",
    ]);
    assert.strictEqual(literalDescCli.ok, true, literalDescCli.error);
    assert.strictEqual(literalDescCli.value.title, "--开场标题--");
    assert.strictEqual(literalDescCli.value.description, "--开场--");
    assert.strictEqual(literalDescCli.value.draft, true);

    // 独立 --help / -h 仍正常返回帮助
    assert.deepStrictEqual(parsePublish.parsePublishArgs(["--help"]), {
      ok: true,
      value: { help: true },
    });
    assert.deepStrictEqual(parsePublish.parsePublishArgs(["-p", "dy", "-h"]), {
      ok: true,
      value: { help: true },
    });
    assert.ok(
      parsePublish.KNOWN_PUBLISH_SWITCHES.has("--draft") &&
        parsePublish.KNOWN_PUBLISH_SWITCHES.has("--allow-duplicate") &&
        parsePublish.KNOWN_PUBLISH_SWITCHES.has("--help") &&
        parsePublish.KNOWN_PUBLISH_SWITCHES.has("-h"),
      "KNOWN_PUBLISH_SWITCHES 应包含全部无值开关"
    );
  }
  console.log("✓ 3. CLI 与 HTTP 入参解析、缺值/吞 flag 防护、覆盖优先级及帮助文案通过");
}

/* ------------------------------------------------------------------ *
 * 4. GUI LocalVideoPublish.vue 模板编译与合集方法验证
 * ------------------------------------------------------------------ */
function testGuiLocalVideoPublish() {
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
  assert.ok(vueSrc.includes("batchCollection"), "批量设置区应含合集输入框绑定");

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
  const ctx = vm.createContext({ ...stubs, ...videoLink });
  vm.runInContext(script, ctx);

  const state = {
    platformVideoLinks: {},
    platformCollections: {},
    batchCollection: "",
    checkedPlatformNodes: [],
    $set: (o, k, v) => {
      o[k] = v;
    },
  };
  for (const [name, fn] of Object.entries(ctx.component.methods)) {
    state[name] = fn.bind(state);
  }
  state.getPlatformStatement = () => "none";

  const dyNode = { id: "n-dy", pt: "抖音", phone: "a" };
  const ksNode = { id: "n-ks", pt: "快手", phone: "a" };
  const blblNode = { id: "n-blbl", pt: "哔哩哔哩", phone: "a" };

  // 留空：publishOptions 不带 collection
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      state.buildPlatformVideoPayload(dyNode, { data: {} }).publishOptions,
      "collection"
    ),
    false
  );

  // 批量输入：对支持平台生效、不支持平台忽略
  state.batchCollection = "民间故事";
  assert.strictEqual(
    state.buildPlatformVideoPayload(dyNode, { data: {} }).publishOptions.collection,
    "民间故事"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      state.buildPlatformVideoPayload(blblNode, { data: {} }).publishOptions,
      "collection"
    ),
    false
  );

  // 单账号覆盖（含显式清空）
  state.setPlatformCollection(ksNode.id, "");
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(
      state.buildPlatformVideoPayload(ksNode, { data: {} }).publishOptions,
      "collection"
    ),
    false
  );
  state.setPlatformCollection(ksNode.id, "快手专属");
  assert.strictEqual(
    state.buildPlatformVideoPayload(ksNode, { data: {} }).publishOptions.collection,
    "快手专属"
  );

  // Excel 行合集合并：未单独覆盖时 Excel 行优先于 batchCollection；单独覆盖优先于 Excel 行
  assert.strictEqual(
    state.resolvePlatformCollectionValue(dyNode.id, dyNode.pt, "Excel行合集"),
    "Excel行合集"
  );
  assert.strictEqual(
    state.resolvePlatformCollectionValue(dyNode.id, dyNode.pt, ""),
    "民间故事"
  );
  assert.strictEqual(
    state.resolvePlatformCollectionValue(ksNode.id, ksNode.pt, "Excel行合集"),
    "快手专属"
  );

  // 重发回填
  state.resetPlatformCollections();
  state.getAllPlatformLeafNodes = () => [dyNode, ksNode];
  state.findRepublishRecord = (pt) =>
    pt === "抖音" ? { publishOptions: { collection: "历史合集" } } : null;
  state.applyRepublishPlatformCollections();
  assert.strictEqual(state.getPlatformCollection(dyNode.id, dyNode.pt), "历史合集");
  assert.strictEqual(state.getPlatformCollection(ksNode.id, ksNode.pt), "");
  console.log("✓ 4. GUI LocalVideoPublish.vue 模板编译与合集交互逻辑通过");
}

/* ------------------------------------------------------------------ *
 * 5. 回读匹配与精确匹配纯函数
 * ------------------------------------------------------------------ */
function testMatchingHelpers() {
  assert.strictEqual(
    collectionMod.isExactCollectionMatch("民间故事", "民间故事"),
    true
  );
  assert.strictEqual(
    collectionMod.isExactCollectionMatch("  民 间 故 事  ", "民间故事"),
    true,
    "去空白后相等应匹配"
  );
  assert.strictEqual(
    collectionMod.isExactCollectionMatch("民间故事2", "民间故事"),
    false,
    "子串不得算完全匹配"
  );
  assert.strictEqual(
    collectionMod.isExactCollectionMatch("", "民间故事"),
    false
  );

  assert.strictEqual(
    collectionMod.matchesCollectionReadback("民间故事", "民间故事"),
    true
  );
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("  民 间 故 事  ", "民间故事"),
    true,
    "去空白后完全相等应通过回读"
  );
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("已选：民 间 故 事", "民间故事"),
    false,
    "平铺字符串含前缀不得用 includes 放行"
  );
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("民间故事番外", "民间故事"),
    false,
    "子串/前缀包含不得算回读通过"
  );
  assert.strictEqual(
    collectionMod.matchesCollectionReadback(
      { displayedText: "已选：民 间 故 事", selectedTexts: ["民 间 故 事"] },
      "民间故事"
    ),
    true,
    "控件内已选标签节点文本去空白后恰等于目标名应通过回读"
  );
  // S12-fix1(2)：占位文案全集不得视为已选值；目标名为「合集」、显示「请选择合集」必须失败
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("请选择合集", "合集"),
    false,
    "目标名为「合集」、显示「请选择合集」必须失败"
  );
  for (const ph of [
    "请选择合集",
    "选择合集",
    "添加到合集",
    "添加合集",
    "暂不添加",
    "未选择",
    "不加入合集",
    "不添加到合集",
    "暂不选择",
  ]) {
    assert.strictEqual(
      collectionMod.matchesCollectionReadback(ph, "合集"),
      false,
      `占位文案「${ph}」不得匹配「合集」`
    );
    assert.strictEqual(
      collectionMod.matchesCollectionReadback(ph, ph),
      false,
      `占位文案「${ph}」本身亦不得视为已选值`
    );
  }
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("请选择合集", "民间故事"),
    false
  );
  assert.strictEqual(
    collectionMod.matchesCollectionReadback("都市传说", "民间故事"),
    false
  );
  assert.strictEqual(collectionMod.matchesCollectionReadback("", "民间故事"), false);

  const formatted = collectionMod.formatCollectionCandidates(
    Array.from({ length: 15 }, (_, i) => `合集${i + 1}`).concat(["合集1", "  "]),
    10
  );
  assert.strictEqual(formatted.length, 10, "候选合集名最多保留 10 个");
  assert.strictEqual(formatted[0], "合集1");
  assert.strictEqual(formatted[9], "合集10");
  console.log("✓ 5. 精确匹配、回读匹配与候选列表截断函数通过");
}

/* ------------------------------------------------------------------ *
 * 6. 留空不调用平台逻辑 + 7. 假 page 成功/三条失败路径（dy/ks/sph）
 * ------------------------------------------------------------------ */
async function testFakePageFlows() {
  const fastTimeouts = {
    entryTimeoutMs: 0,
    optionTimeoutMs: 0,
    readbackTimeoutMs: 0,
    pollIntervalMs: 0,
    afterOpenDelayMs: 0,
    afterSelectDelayMs: 0,
  };

  // 6. 留空不触碰 page
  const forbiddenPage = {
    evaluate() {
      throw new Error("留空时不得调用 page.evaluate");
    },
    click() {
      throw new Error("留空时不得调用 page.click");
    },
    screenshot() {
      throw new Error("留空时不得调用 page.screenshot");
    },
  };
  for (const opts of [
    {},
    { collection: "" },
    { collection: "   " },
    { collection: "民间故事", collections: { dy: "" } },
  ]) {
    const res = await collectionMod.selectPlatformCollection(
      forbiddenPage,
      "抖音",
      opts,
      { timeouts: fastTimeouts }
    );
    assert.deepStrictEqual(res, { skipped: true, selected: false, name: "" });
  }
  const unsupportedRes = await collectionMod.selectPlatformCollection(
    forbiddenPage,
    "哔哩哔哩",
    { collection: "民间故事" },
    { timeouts: fastTimeouts }
  );
  assert.deepStrictEqual(unsupportedRes, {
    skipped: true,
    selected: false,
    name: "",
  });

  // 7. 三平台成功路径 + 三条失败路径
  const platforms = [
    ["dy", "抖音"],
    ["ks", "快手"],
    ["sph", "视频号"],
  ];

  const origLog = console.log;
  const origError = console.error;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));

  try {
    for (const [key, ptName] of platforms) {
      // 7a. 成功路径
      logs.length = 0;
      const okCtx = buildFakeCollectionPage(key, "success");
      const res = await collectionMod.selectPlatformCollection(
        okCtx.page,
        ptName,
        { collection: "民间故事" },
        { timeouts: fastTimeouts }
      );
      assert.strictEqual(res.skipped, false, `${ptName} 成功不应跳过`);
      assert.strictEqual(res.selected, true, `${ptName} 应选中成功`);
      assert.strictEqual(res.name, "民间故事");
      assert.ok(
        collectionMod.matchesCollectionReadback(res.displayedText, "民间故事"),
        `${ptName} 回读应包含目标合集`
      );
      assert.strictEqual(okCtx.state.entryClicked, true);
      assert.strictEqual(
        okCtx.state.optionClicked,
        "民间 故事",
        `${ptName} 应精确命中去空白相等项，不误选「民间故事番外」`
      );
      if (key === "ks") {
        assert.ok(
          okCtx.state.entryEvents.includes("mousedown") &&
            okCtx.state.optionEvents.includes("mousedown"),
          "快手 Ant Design 触发器与选项必须派发 mousedown"
        );
      }
      assert.ok(
        logs.some((line) => line.includes(`[collection] ${ptName}`)),
        `${ptName} 应打印 [collection] 诊断日志`
      );

      // 7b. 失败路径 1：入口缺失
      let shots = 0;
      const missingEntry = buildFakeCollectionPage(key, "missing_entry");
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            missingEntry.page,
            ptName,
            { collection: "民间故事" },
            {
              timeouts: fastTimeouts,
              captureScreenshot: async () => {
                shots += 1;
                return `/tmp/fail-${key}-entry.png`;
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_entry_not_found");
          assert.strictEqual(err.deterministic, true);
          assert.strictEqual(err.isCollectionError, true);
          assert.strictEqual(err.failScreenshot, `/tmp/fail-${key}-entry.png`);
          assert.ok(err.message.includes("入口查找"));
          assert.ok(err.message.includes("更多设置"));
          return true;
        }
      );
      assert.strictEqual(shots, 1, `${ptName} 入口缺失必须截图`);

      // 7c. 失败路径 2：同名合集缺失（页面有 12 个候选，含前缀相近「民间故事番外」）
      shots = 0;
      const missingOpt = buildFakeCollectionPage(key, "missing_option");
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            missingOpt.page,
            ptName,
            { collection: "民间故事" },
            {
              timeouts: fastTimeouts,
              captureScreenshot: async () => {
                shots += 1;
                return `/tmp/fail-${key}-option.png`;
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_option_not_found");
          assert.strictEqual(err.deterministic, true);
          assert.strictEqual(err.failScreenshot, `/tmp/fail-${key}-option.png`);
          assert.strictEqual(
            err.details.candidates.length,
            10,
            `${ptName} 候选合集列表应截断为最多 10 个`
          );
          assert.ok(err.message.includes("民间故事番外"));
          assert.ok(!err.message.includes("第11个合集"), "超过 10 个候选不应全部拼入");
          assert.ok(err.message.includes("入口查找"));
          return true;
        }
      );
      assert.strictEqual(shots, 1, `${ptName} 同名缺失必须截图`);

      // 7d. 失败路径 3：回读不符
      shots = 0;
      const mismatch = buildFakeCollectionPage(key, "readback_mismatch", {
        wrongReadback: "都市传说",
      });
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            mismatch.page,
            ptName,
            { collection: "民间故事" },
            {
              timeouts: fastTimeouts,
              captureScreenshot: async () => {
                shots += 1;
                return `/tmp/fail-${key}-readback.png`;
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_readback_mismatch");
          assert.strictEqual(err.deterministic, true);
          assert.strictEqual(err.failScreenshot, `/tmp/fail-${key}-readback.png`);
          assert.ok(err.message.includes("回读不符"));
          assert.ok(err.message.includes("都市传说"));
          assert.ok(err.message.includes("入口查找"));
          assert.ok(err.message.includes("页面候选合集"));
          return true;
        }
      );
      assert.strictEqual(shots, 1, `${ptName} 回读不符必须截图`);
    }

    // 7e. 视频号 wujie shadowRoot 缺失场景
    {
      let shots = 0;
      const noShadow = buildFakeCollectionPage("sph", "missing_shadow");
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            noShadow.page,
            "视频号",
            { collection: "民间故事" },
            {
              timeouts: fastTimeouts,
              captureScreenshot: async () => {
                shots += 1;
                return "/tmp/fail-sph-shadow.png";
              },
            }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_entry_not_found");
          assert.ok(err.message.includes("shadowRoot"));
          return true;
        }
      );
      assert.strictEqual(shots, 1);
    }

    // 7f. S12-fix1(1) 安全红线：假 DOM 只有发布/存草稿/暂存离开/保存草稿/发表/取消按钮、无合集入口
    //     （含：无合集标签 / 有合集标签但同行无入口 / 同行里混入发布按钮 / 入口 disabled / 非合集行有同名占位符）
    //     → 所有提交类按钮点击次数均为 0 且抛确定性错误
    {
      const makeEvalPage = (doc) => ({
        async evaluate(fn, arg) {
          const prevDoc = global.document;
          const prevStyle = global.getComputedStyle;
          const prevMouse = global.MouseEvent;
          const prevWindow = global.window;
          global.document = doc;
          global.getComputedStyle = (el) => ({
            display: el && el.hidden ? "none" : "block",
            visibility: "visible",
            opacity: "1",
          });
          global.MouseEvent = FakeMouseEvent;
          global.window = {};
          try {
            const runner = new Function(
              "document",
              "getComputedStyle",
              "MouseEvent",
              "window",
              "arg",
              `return (${fn.toString()})(arg);`
            );
            return runner(doc, global.getComputedStyle, FakeMouseEvent, {}, arg);
          } finally {
            if (prevDoc === undefined) delete global.document;
            else global.document = prevDoc;
            if (prevStyle === undefined) delete global.getComputedStyle;
            else global.getComputedStyle = prevStyle;
            if (prevMouse === undefined) delete global.MouseEvent;
            else global.MouseEvent = prevMouse;
            if (prevWindow === undefined) delete global.window;
            else global.window = prevWindow;
          }
        },
        async waitForTimeout() {},
      });

      const makeDocWithRoot = () => {
        const doc = new FakeElement("document");
        const body = new FakeElement("body");
        doc.body = body;
        doc.append(body);
        doc.getElementById = (id) => doc.querySelector(`[id="${id}"]`);
        return { doc, body };
      };

      // 7f-1：只有提交类按钮、完全无合集入口
      {
        const { doc, body } = makeDocWithRoot();
        const form = new FakeElement("div", "", { class: "publish-form" });
        const actionLabels = ["发布", "存草稿", "暂存离开", "保存草稿", "发表", "取消"];
        let actionClicks = 0;
        for (const text of actionLabels) {
          const btn = new FakeElement("button", text);
          btn.onClick = () => {
            actionClicks += 1;
          };
          form.append(btn);
        }
        body.append(form);
        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "民间故事" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s1.png" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_entry_not_found");
            assert.strictEqual(err.deterministic, true);
            return true;
          }
        );
        assert.strictEqual(actionClicks, 0, "无合集入口时提交类按钮点击次数必须为 0");
      }

      // 7f-2：存在「合集」标签但该表单行内无合集入口，外层紧邻「发布」「存草稿」按钮
      {
        const { doc, body } = makeDocWithRoot();
        const form = new FakeElement("div", "", { class: "publish-form" });
        const emptyRow = new FakeElement("div", "", { class: "form-item" });
        emptyRow.append(new FakeElement("label", "合集"));
        const footer = new FakeElement("div", "", { class: "form-actions" });
        let publishClicks = 0;
        const pubBtn = new FakeElement("button", "");
        pubBtn.append(new FakeElement("span", "发布"));
        pubBtn.onClick = () => {
          publishClicks += 1;
        };
        const draftBtn = new FakeElement("button", "存草稿");
        draftBtn.onClick = () => {
          publishClicks += 1;
        };
        footer.append(pubBtn, draftBtn);
        form.append(emptyRow, footer);
        body.append(form);
        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "民间故事" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s2.png" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_entry_not_found");
            assert.strictEqual(err.deterministic, true);
            return true;
          }
        );
        assert.strictEqual(publishClicks, 0, "合集行缺入口时绝不能越界点击发布/存草稿按钮");
      }

      // 7f-3：同一容器里紧挨「合集」标签放着带嵌套 span 的发布/暂存离开按钮
      {
        const { doc, body } = makeDocWithRoot();
        const row = new FakeElement("div", "", { class: "setting-item" });
        row.append(new FakeElement("label", "合集"));
        let btnClicks = 0;
        const pubBtn = new FakeElement("button", "");
        pubBtn.append(new FakeElement("span", "发布"));
        pubBtn.onClick = () => {
          btnClicks += 1;
        };
        const leaveBtn = new FakeElement("div", "", { role: "button" });
        leaveBtn.append(new FakeElement("span", "暂存离开"));
        leaveBtn.onClick = () => {
          btnClicks += 1;
        };
        row.append(pubBtn, leaveBtn);
        body.append(row);
        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "民间故事" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s3.png" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_entry_not_found");
            assert.strictEqual(err.deterministic, true);
            return true;
          }
        );
        assert.strictEqual(btnClicks, 0, "含提交文案及其后代的按钮一律不得被点击");
      }

      // 7f-4：合集入口存在但处于 disabled，外层有发布按钮 → 两者点击均为 0 且抛确定性错误
      {
        const { doc, body } = makeDocWithRoot();
        const form = new FakeElement("div", "", { class: "publish-form" });
        const row = new FakeElement("div", "", { class: "setting-item" });
        row.append(new FakeElement("label", "添加到合集"));
        let disabledClicks = 0;
        const disabledSel = new FakeElement("div", "请选择合集", {
          class: "semi-select select-collection-x semi-select-disabled",
          role: "combobox",
          "aria-disabled": "true",
        });
        disabledSel.onClick = () => {
          disabledClicks += 1;
        };
        row.append(disabledSel);
        let pubClicks = 0;
        const pubBtn = new FakeElement("button", "发布");
        pubBtn.onClick = () => {
          pubClicks += 1;
        };
        form.append(row, pubBtn);
        body.append(form);
        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "民间故事" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s4.png" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_entry_disabled");
            assert.strictEqual(err.deterministic, true);
            assert.ok(err.message.includes("disabled"));
            return true;
          }
        );
        assert.strictEqual(disabledClicks, 0, "disabled 入口不得被点击");
        assert.strictEqual(pubClicks, 0, "disabled 时绝不兜底点击发布按钮");
      }

      // 7f-5：非「合集」表单行里出现「未选择」「请选择合集」等文案 → 不在同一合集行内，不得点击
      {
        const { doc, body } = makeDocWithRoot();
        const otherRow = new FakeElement("div", "", { class: "setting-item" });
        otherRow.append(new FakeElement("label", "拍摄地点"));
        let otherClicks = 0;
        const otherSel = new FakeElement("div", "请选择合集", {
          class: "semi-select",
          role: "combobox",
        });
        otherSel.onClick = () => {
          otherClicks += 1;
        };
        otherRow.append(otherSel);
        body.append(otherRow);
        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "民间故事" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s5.png" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_entry_not_found");
            assert.strictEqual(err.deterministic, true);
            return true;
          }
        );
        assert.strictEqual(otherClicks, 0, "未与「合集」标签同行的控件不得被点击");
      }
    }

    // 7g. S12-fix1(2) 端到端回读：目标名为「合集」、点击后控件仍显示「请选择合集」→ 回读失败
    {
      const placeholderStay = buildFakeCollectionPage("ks", "readback_mismatch", {
        candidates: ["合集", "都市传说"],
        wrongReadback: "请选择合集",
      });
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            placeholderStay.page,
            "快手",
            { collection: "合集" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "/tmp/s-ph.png" }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_readback_mismatch");
          assert.strictEqual(err.deterministic, true);
          assert.ok(err.message.includes("请选择合集"));
          return true;
        }
      );
    }
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  console.log("✓ 6-7. 留空短路 + 抖音/快手/视频号假 page 成功与三条失败路径通过");
}

/* ------------------------------------------------------------------ *
 * 8. 平台 handler 门禁：合集失败中止发布（不点击发布/草稿、保留完整错误与截图）
 * ------------------------------------------------------------------ */
async function testHandlerCollectionFailureGates() {
  const errMsg =
    "测试平台选择合集「民间故事」失败：未找到名称完全匹配的合集「民间故事」；入口查找：已打开（策略=label_row）；页面候选合集（最多10个）：" +
    Array.from({ length: 10 }, (_, i) => `超长候选合集名称示例编号第${i + 1}期故事集`).join("、");
  assert.ok(errMsg.length > 220, "构造超过 200 字的诊断消息，验证不被 200 字截断");

  const stubCollection = `
    export async function selectPlatformCollection(page, platform, publishOptions) {
      if (!publishOptions || !publishOptions.collection) return { skipped: true, selected: false, name: "" };
      const err = new Error(${JSON.stringify(errMsg)});
      err.code = "collection_option_not_found";
      err.deterministic = true;
      err.isCollectionError = true;
      err.failScreenshot = "/tmp/collection-gate-shot.png";
      throw err;
    }
  `;

  async function buildHandlerWithStubs(entryRel) {
    const outFile = path.join(outDir, `${path.basename(entryRel, ".js")}-gate.cjs`);
    const stubMap = new Map([
      ["./collection.js", stubCollection],
      [
        "./uploadTimeouts.js",
        "export const WAIT_SELECTOR_APPEAR_MS=1; export const WAIT_UPLOAD_PROCESSING_MS=1; export async function pollPageUntil(){return true;}",
      ],
      [
        "./failureScreenshot.js",
        "export async function capturePublishFailureScreenshot(){return '/tmp/fallback-shot.png';}",
      ],
      ["./closeWindow.js", "export default function maybeClosePublishWindow(){}"],
      ["../coverCompat.js", "export async function normalizeCoverForUpload(p){return p;}"],
    ]);
    await build({
      entryPoints: [path.join(root, entryRel)],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: outFile,
      external: ["electron"],
      plugins: [
        {
          name: "col-gate-stubs",
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
    return require(outFile).default;
  }

  const dyHandler = await buildHandlerWithStubs("src/main/services/upLoad/dy.js");
  const ksHandler = await buildHandlerWithStubs("src/main/services/upLoad/ks.js");
  const sphHandler = await buildHandlerWithStubs("src/main/services/upLoad/sph.js");

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    for (const [pt, handler] of [
      ["抖音", dyHandler],
      ["快手", ksHandler],
      ["视频号", sphHandler],
    ]) {
      let submitClicked = false;
      let typed = "";
      const replies = [];
      const handle = (sel) => ({
        async uploadFile() {},
        async click() {
          if (
            sel === "#popover-tip-container" ||
            sel === "#popover-tip-container+button"
          ) {
            submitClicked = true;
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
        async click() {},
        async type(_sel, t) {
          typed += String(t || "");
        },
        keyboard: {
          async down() {},
          async up() {},
          async press() {},
          async type(t) {
            typed += String(t || "");
          },
        },
        async waitForFunction() {
          return true;
        },
        async waitForTimeout() {},
        async evaluate(fn, arg) {
          const src = String(fn && fn.toString ? fn.toString() : fn);
          if (pt === "快手" && src.includes("#setting-tours + div")) {
            submitClicked = true;
            return { ok: true, via: "button" };
          }
          if (
            pt === "视频号" &&
            arg &&
            typeof arg === "object" &&
            typeof arg.sel === "string" &&
            arg.sel.includes(".form-btns")
          ) {
            submitClicked = true;
            return true;
          }
          if (pt === "视频号" && arg && typeof arg === "object" && "isValue" in arg) {
            return "测试标题";
          }
          if (arg && typeof arg === "object" && "mode" in arg) {
            return { ok: true, info: {}, mode: arg.mode };
          }
          if (typeof arg === "string") {
            if (arg.includes("#work-description-edit")) return typed;
            if (src.includes("execCommand")) return true;
            return src.includes("semi-modal") || src.includes("semi-radio")
              ? true
              : "";
          }
          if (src.includes("我知道了")) return 0;
          return true;
        },
        url: () => "https://creator.example.com/publish",
      };

      const event = {
        reply(ch, payload) {
          assert.strictEqual(ch, "puppeteerFile-done");
          replies.push(payload);
        },
      };

      await handler(
        page,
        {
          pt,
          filePath: "demo.mp4",
          data: { title: "测试标题", description: "", tags: [], creativeStatement: "none" },
          publishOptions: { collection: "民间故事" },
        },
        null,
        event
      );

      assert.strictEqual(submitClicked, false, `${pt} 合集失败后绝不能点击发布/草稿按钮`);
      assert.strictEqual(replies.length, 1, `${pt} 应仅发送一次失败回执`);
      assert.strictEqual(replies[0].status, false, `${pt} 合集失败应返回 status:false`);
      assert.strictEqual(replies[0].outcome, "collection_failed");
      assert.strictEqual(replies[0].failScreenshot, "/tmp/collection-gate-shot.png");
      assert.strictEqual(
        replies[0].message,
        errMsg,
        `${pt} 合集失败诊断消息不得被 200 字截断`
      );
    }
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  console.log("✓ 8. dy.js / ks.js / sph.js 合集失败门禁（中止发布 + 完整诊断 + 截图）通过");
}

/* ------------------------------------------------------------------ *
 * 9. S12-fix1(5)：sph.js 挂车/挂剧失败转存草稿前先选合集 + 回读；失败中止且不点存草稿
 * ------------------------------------------------------------------ */
async function testSphLinkFallbackCollectionGate() {
  async function buildSphWithStubs(colMode) {
    const outFile = path.join(outDir, `sph-link-fallback-${colMode}.cjs`);
    const stubLink = `
      export async function attachSphVideoLink() {
        throw new Error("模拟商品ID未找到");
      }
    `;
    const stubCol =
      colMode === "fail"
        ? `
      export async function selectPlatformCollection(page, platform, publishOptions) {
        globalThis.__SPH_FALLBACK_ORDER__.push("collection");
        const err = new Error("视频号选择合集「民间故事」失败：页面未找到合集选择入口");
        err.code = "collection_entry_not_found";
        err.deterministic = true;
        err.isCollectionError = true;
        err.failScreenshot = "/tmp/sph-fallback-col-fail.png";
        throw err;
      }
    `
        : `
      export async function selectPlatformCollection(page, platform, publishOptions) {
        globalThis.__SPH_FALLBACK_ORDER__.push("collection");
        return { skipped: false, selected: true, name: publishOptions.collection, displayedText: publishOptions.collection };
      }
    `;
    const stubMap = new Map([
      ["./sphLink.js", stubLink],
      ["./collection.js", stubCol],
      [
        "./uploadTimeouts.js",
        "export const WAIT_SELECTOR_APPEAR_MS=1; export const WAIT_UPLOAD_PROCESSING_MS=1; export async function pollPageUntil(){return true;}",
      ],
      [
        "./failureScreenshot.js",
        "export async function capturePublishFailureScreenshot(){return '/tmp/fallback-shot.png';}",
      ],
      ["./closeWindow.js", "export default function maybeClosePublishWindow(){}"],
      ["../coverCompat.js", "export async function normalizeCoverForUpload(p){return p;}"],
    ]);
    await build({
      entryPoints: [path.join(root, "src/main/services/upLoad/sph.js")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: outFile,
      external: ["electron"],
      plugins: [
        {
          name: "sph-fallback-stubs",
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
    return require(outFile).default;
  }

  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = console.warn = console.error = () => {};
  try {
    const runCase = async (colMode) => {
      const handler = await buildSphWithStubs(colMode);
      const order = [];
      globalThis.__SPH_FALLBACK_ORDER__ = order;
      let draftClicked = false;
      const replies = [];
      const page = {
        async waitForSelector() {
          return {
            async uploadFile() {},
            async evaluate() {},
          };
        },
        keyboard: {
          async down() {},
          async up() {},
          async press() {},
          async type() {},
        },
        async waitForTimeout() {},
        async evaluate(_fn, arg) {
          if (arg && typeof arg === "object" && typeof arg.sel === "string") {
            if (arg.sel.includes(".form-btns>div:first-child")) {
              draftClicked = true;
              order.push("draft");
              return true;
            }
            if ("isValue" in arg) return "测试标题";
            return true;
          }
          return true;
        },
        url: () => "https://channels.weixin.qq.com/platform/post/create",
      };
      const event = {
        reply(ch, payload) {
          assert.strictEqual(ch, "puppeteerFile-done");
          replies.push(payload);
        },
      };
      await handler(
        page,
        {
          pt: "视频号",
          filePath: "demo.mp4",
          data: { title: "测试标题", description: "", tags: [], creativeStatement: "none" },
          publishOptions: {
            link: { enabled: true, type: "product", value: "10000591263144" },
            collection: "民间故事",
          },
        },
        null,
        event
      );
      delete globalThis.__SPH_FALLBACK_ORDER__;
      return { order, draftClicked, replies };
    };

    // 9a. 挂车失败 + 合集失败 → 中止，绝不点保存草稿
    const failRes = await runCase("fail");
    assert.strictEqual(failRes.draftClicked, false, "合集失败时绝不能点击保存草稿");
    assert.deepStrictEqual(failRes.order, ["collection"]);
    assert.strictEqual(failRes.replies.length, 1);
    assert.strictEqual(failRes.replies[0].status, false);
    assert.strictEqual(failRes.replies[0].outcome, "collection_failed");
    assert.strictEqual(failRes.replies[0].failScreenshot, "/tmp/sph-fallback-col-fail.png");
    assert.ok(failRes.replies[0].message.includes("选择合集失败"));

    // 9b. 挂车失败 + 合集成功 → 先选合集再点保存草稿
    const okRes = await runCase("ok");
    assert.strictEqual(okRes.draftClicked, true, "合集成功后才点击保存草稿");
    assert.deepStrictEqual(okRes.order, ["collection", "draft"]);
    assert.strictEqual(okRes.replies.length, 1);
    assert.strictEqual(okRes.replies[0].status, true);
    assert.strictEqual(okRes.replies[0].outcome, "draft_saved");
    assert.strictEqual(okRes.replies[0].failureStage, "video_link");
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  console.log("✓ 9. sph.js 挂车失败转存草稿分支：先选合集+回读，失败中止不点草稿 通过");
}

/* ------------------------------------------------------------------ *
 * 10. S12-fix1(6)：定时复用排期比较 collection（publishThrottle / publishVideo / cli/index）
 * ------------------------------------------------------------------ */
async function testScheduledReuseCollectionConflict() {
  const sharedThrottle = require(path.join(root, "src/shared/publishThrottle.js"));
  const existingRec = {
    id: "sched-1",
    pt: "抖音",
    creativeStatement: "ai_generated",
    publishOptions: { collection: "民间故事" },
  };

  // 纯函数校验
  const sameRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    existingRec,
    "ai_generated",
    "民间故事"
  );
  assert.strictEqual(sameRes.conflict, false, "声明与合集一致允许复用");

  const diffColRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    existingRec,
    "ai_generated",
    "都市传说"
  );
  assert.strictEqual(diffColRes.conflict, true, "合集不同必须判冲突");
  assert.strictEqual(diffColRes.collectionConflict, true);
  assert.strictEqual(diffColRes.actualCollection, "民间故事");
  assert.strictEqual(diffColRes.requestedCollection, "都市传说");
  assert.ok(diffColRes.message.includes("民间故事"));
  assert.ok(diffColRes.message.includes("都市传说"));

  const emptyColRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    existingRec,
    "ai_generated",
    ""
  );
  assert.strictEqual(emptyColRes.conflict, true, "既有有合集、新请求无合集必须判冲突");
  assert.strictEqual(emptyColRes.requestedCollection, "");

  const nonSupportRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    { id: "b-1", pt: "哔哩哔哩", creativeStatement: "none", publishOptions: {} },
    "none",
    "民间故事"
  );
  assert.strictEqual(nonSupportRes.conflict, false, "不支持合集的平台不产生合集冲突");

  // S12-fix2(D9)：排期复用比较使用与页面匹配同一个归一函数 collapseCollectionText，「民 间故事」与「民间故事」视为相同
  const spacedSameRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    existingRec,
    "ai_generated",
    "民 间故事"
  );
  assert.strictEqual(
    spacedSameRes.conflict,
    false,
    "「民 间故事」与「民间故事」去空白后等价，不应报合集冲突"
  );
  assert.strictEqual(spacedSameRes.collectionConflict, false);

  const spacedExistingRes = sharedThrottle.checkExistingScheduledCreativeConflict(
    { ...existingRec, publishOptions: { collection: "民  间_x000d_\n故事" } },
    "ai_generated",
    "民间故事"
  );
  assert.strictEqual(
    spacedExistingRes.conflict,
    false,
    "既有任务合集含空白/转义与请求合集等价时不应报冲突"
  );

  // 单一来源校验：src/shared/collectionShared.js 导出的 collapseCollectionText 与页面匹配函数一致
  const sharedCollection = require(path.join(root, "src/shared/collectionShared.js"));
  assert.strictEqual(
    sharedCollection.collapseCollectionText("民 间故事"),
    collectionMod.normalizeCollectionMatchText("民间故事")
  );

  // 端到端验证 publishThrottle IPC、publishVideo.js 与 cli/index.js 三处复用分支
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-col-sched-conflict-"));
  const mediaDir = path.join(tmpDir, "videos");
  fs.mkdirSync(mediaDir, { recursive: true });
  const clip = path.join(mediaDir, "ep01.mp4");
  fs.writeFileSync(clip, "fake-video");

  const coreBundle = path.join(outDir, "s12-sched-core.cjs");
  const entryJs = path.join(outDir, "s12-sched-entry.js");
  fs.writeFileSync(
    entryJs,
    `
      export { changeData } from ${JSON.stringify(path.join(root, "src/main/server/utils.js"))};
      export { createScheduledRecord, notifyScheduledPublishChanged, stopScheduledPublishScheduler } from ${JSON.stringify(path.join(root, "src/main/services/scheduledPublish.js"))};
      export { findExistingScheduled } from ${JSON.stringify(path.join(root, "src/main/services/scheduledDedupe.js"))};
      export { registerPublishThrottleIpc, savePublishThrottleSettings } from ${JSON.stringify(path.join(root, "src/main/services/publishThrottle.js"))};
      export { runSingleFilePublish } from ${JSON.stringify(path.join(root, "src/main/services/publishVideo.js"))};
      export { runCliMain } from ${JSON.stringify(path.join(root, "src/main/cli/index.js"))};
    `,
    "utf8"
  );
  await build({
    entryPoints: [entryJs],
    outfile: coreBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "xlsx", "axios", "puppeteer-core", "puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer-in-electron"],
  });

  const origLoad = Module._load;
  const handlers = new Map();
  let core;
  try {
    Module._load = function (request) {
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
      if (request.startsWith("puppeteer")) return { use: () => {}, connect: () => {} };
      return origLoad.apply(this, arguments);
    };
    delete require.cache[coreBundle];
    core = require(coreBundle);
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

    const publishAt = "2099-11-21 13:00:00";
    const phone = "13800138000";

    // 10a. publishVideo.js: 创建带合集「民间故事」的定时任务，再次提交不同合集 → needs_attention (exitCode 4)
    const created = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition: "persist:13800138000抖音",
      file: clip,
      title: "初版任务",
      publishAt,
      creativeStatement: "ai_generated",
      collection: "民间故事",
      publishOptions: { collection: "民间故事" },
    });
    assert.strictEqual(created.exitCode, 0);
    assert.strictEqual(created.scheduled, true);

    const conflictSingle = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition: "persist:13800138000抖音",
      file: clip,
      title: "改合集冲突",
      publishAt,
      creativeStatement: "ai_generated",
      collection: "都市传说",
      publishOptions: { collection: "都市传说" },
    });
    assert.strictEqual(conflictSingle.exitCode, 4, "publishVideo 复用排期合集不同必须返回 exitCode=4");
    assert.strictEqual(conflictSingle.status, "needs_attention");
    assert.strictEqual(conflictSingle.needsAttention, true);
    assert.strictEqual(conflictSingle.scheduled, false);
    assert.strictEqual(conflictSingle.duplicate, true);
    assert.strictEqual(conflictSingle.collection, "民间故事");
    assert.strictEqual(conflictSingle.requestedCollection, "都市传说");

    const reuseSame = await core.runSingleFilePublish({
      platform: "抖音",
      phone,
      partition: "persist:13800138000抖音",
      file: clip,
      title: "同合集复用",
      publishAt,
      creativeStatement: "ai_generated",
      collection: "民间故事",
      publishOptions: { collection: "民间故事" },
    });
    assert.strictEqual(reuseSame.exitCode, 0, "声明与合集均一致允许复用");
    assert.strictEqual(reuseSame.scheduled, true);
    assert.strictEqual(reuseSame.duplicate, true);

    // 10b. publishThrottle.js IPC (publish-throttle:create-scheduled)：合集不同返回 needs_attention，不复用旧任务
    const createScheduledIpc = handlers.get("publish-throttle:create-scheduled");
    const ipcConflict = await createScheduledIpc(null, {
      item: {
        pt: "抖音",
        phone,
        partition: "persist:13800138000抖音",
        filePath: clip,
        textType: "local",
        textOtherName: "ep01",
        selectedFile: "ep01.mp4",
        title: "GUI改合集",
        creativeStatement: "ai_generated",
        publishOptions: { collection: "都市传说" },
      },
      publishAtText: publishAt,
    });
    assert.strictEqual(ipcConflict.ok, false, "publish-throttle:create-scheduled 合集冲突必须返回 ok:false");
    assert.strictEqual(ipcConflict.status, "needs_attention");
    assert.strictEqual(ipcConflict.needsAttention, true);
    assert.strictEqual(ipcConflict.duplicate, true);
    assert.strictEqual(ipcConflict.collection, "民间故事");
    assert.strictEqual(ipcConflict.requestedCollection, "都市传说");

    // 10c. cli/index.js 批量 --dir 定时复用分支：xlsx 合集列不同 → needs_attention，不复用
    const xlsxPath = path.join(mediaDir, "batch.xlsx");
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet([
      { 文件名: "ep01.mp4", 标题: "批量改合集", 简介: "", 标签: "", 创作声明: "ai_generated", 合集: "都市传说" },
    ]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    xlsx.writeFile(wb, xlsxPath);

    const outLines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => outLines.push(a.join(" "));
    console.error = () => {};
    let batchExit;
    try {
      batchExit = await core.runCliMain([
        "electron",
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
        "--no-throttle",
        "--allow-duplicate",
      ]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const batchSummary = outLines
      .filter((s) => s.trim().startsWith("{"))
      .map((s) => JSON.parse(s))
      .find((o) => o.summary === true);
    assert.ok(batchSummary, "应输出批量摘要");
    assert.notStrictEqual(batchExit, 0, "批量复用存在合集冲突时不应退出码 0");
    assert.strictEqual(batchSummary.results[0].status, "needs_attention");
    assert.strictEqual(batchSummary.results[0].needsAttention, true);
    assert.strictEqual(batchSummary.results[0].scheduled, false);
    assert.strictEqual(batchSummary.results[0].collection, "民间故事");
    assert.strictEqual(batchSummary.results[0].requestedCollection, "都市传说");

    // 10d. S12-fix2(C8)：真实 CLI 入口 `--collection --help` 必须退 2，不得当帮助退出 0
    const origErr2 = console.error;
    const origLog2 = console.log;
    const helpErrs = [];
    console.error = (...a) => helpErrs.push(a.join(" "));
    console.log = () => {};
    let colHelpExit;
    try {
      colHelpExit = await core.runCliMain([
        "electron",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        phone,
        "-f",
        clip,
        "-t",
        "例子",
        "--collection",
        "--help",
      ]);
    } finally {
      console.error = origErr2;
      console.log = origLog2;
    }
    assert.strictEqual(
      colHelpExit,
      2,
      `cli publish --collection --help 必须报参数错误退 2，实际=${colHelpExit}`
    );
    assert.ok(
      helpErrs.some((line) => line.includes("--collection")),
      `报错信息应指出 --collection，实际=${JSON.stringify(helpErrs)}`
    );
  } finally {
    if (core && core.stopScheduledPublishScheduler) {
      core.stopScheduledPublishScheduler();
    }
    Module._load = origLoad;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log("✓ 10. publishThrottle / publishVideo / cli/index 定时复用合集冲突返回 needs_attention 通过");
}

/* ------------------------------------------------------------------ *
 * 11. S12-fix1(7 & 8)：MCP publish_video 转发 --collection + e2e collectEvidence 保留 [collection]
 * ------------------------------------------------------------------ */
async function testMcpCollectionAndE2eEvidence() {
  // 11a. MCP publish_video schema + --collection 转发 + exitCode 4 合集冲突字段透传
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-col-mcp-"));
  const pubBundle = path.join(tmpDir, "publish.mjs");
  const argsLog = path.join(tmpDir, "args.json");
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
    assert.strictEqual(
      publishVideoTool.inputSchema.properties.collection.type,
      "string",
      "MCP publish_video schema 必须声明 string collection"
    );

    fs.writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ channel: 'puppeteerFile-done', status: true, resultStatus: 'success', publishMode: 'publish', message: '上传成功' }));
`,
      "utf8"
    );
    fs.chmodSync(fakeBin, 0o755);
    process.env.MATRIXMEDIA_BIN = fakeBin;

    await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/v.mp4",
      title: "带合集发布",
      collection: "民间故事",
    });
    const argvWithCol = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    const colIdx = argvWithCol.indexOf("--collection");
    assert.ok(colIdx >= 0, `MCP 必须转发 --collection，实际 argv=${JSON.stringify(argvWithCol)}`);
    assert.strictEqual(argvWithCol[colIdx + 1], "民间故事");

    await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/v.mp4",
      title: "不带合集发布",
    });
    const argvNoCol = JSON.parse(fs.readFileSync(argsLog, "utf8"));
    assert.strictEqual(
      argvNoCol.includes("--collection"),
      false,
      "未传 collection 时不得透传 --collection"
    );
  } finally {
    if (origBin === undefined) delete process.env.MATRIXMEDIA_BIN;
    else process.env.MATRIXMEDIA_BIN = origBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // 11b. e2e/lib/cli.js collectEvidence 保留 [collection] 诊断行
  const { collectEvidence } = require(path.join(root, "e2e/lib/cli.js"));
  const filtered = collectEvidence([
    "无关启动日志",
    "[collection] 抖音 开始选择合集：「民间故事」",
    "[collection] 视频号 回读校验通过：控件显示=「民间故事」",
    "[publish] 抖音 发布判定 signal=url_changed → 成功",
    "plain line",
  ]);
  assert.strictEqual(filtered.length, 3);
  assert.ok(filtered[0].includes("[collection] 抖音"));
  assert.ok(filtered[1].includes("[collection] 视频号"));
  assert.ok(filtered[2].includes("[publish] 抖音"));
  console.log("✓ 11. MCP publish_video --collection 转发与 e2e collectEvidence [collection] 保留通过");
}

/* ------------------------------------------------------------------ *
 * 12. S12-fix2(A1~A4)：safeClick 唯一出口、跨行隔离、「校园发布会」、内嵌 span 占位回读
 * ------------------------------------------------------------------ */
async function testS12Fix2StructuralGuards() {
  const fastTimeouts = {
    entryTimeoutMs: 0,
    optionTimeoutMs: 0,
    readbackTimeoutMs: 0,
    pollIntervalMs: 0,
    afterOpenDelayMs: 0,
    afterSelectDelayMs: 0,
  };
  const makeDoc = () => {
    const doc = new FakeElement("document");
    const body = new FakeElement("body");
    doc.body = body;
    doc.documentElement = doc;
    doc.append(body);
    doc.getElementById = (id) => doc.querySelector(`[id="${id}"]`);
    return { doc, body };
  };
  const makeEvalPage = (doc) => ({
    async evaluate(fn, arg) {
      const prevDoc = global.document;
      const prevStyle = global.getComputedStyle;
      const prevMouse = global.MouseEvent;
      const prevWindow = global.window;
      global.document = doc;
      global.getComputedStyle = (el) => ({
        display: el && el.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      });
      global.MouseEvent = FakeMouseEvent;
      global.window = {};
      try {
        const runner = new Function(
          "document",
          "getComputedStyle",
          "MouseEvent",
          "window",
          "arg",
          `return (${fn.toString()})(arg);`
        );
        return runner(doc, global.getComputedStyle, FakeMouseEvent, {}, arg);
      } finally {
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevStyle === undefined) delete global.getComputedStyle;
        else global.getComputedStyle = prevStyle;
        if (prevMouse === undefined) delete global.MouseEvent;
        else global.MouseEvent = prevMouse;
        if (prevWindow === undefined) delete global.window;
        else global.window = prevWindow;
      }
    },
    async waitForTimeout() {},
  });

  // 12a. A1 静态检验：collection.js 只有 safeClick 一个 DOM 点击/事件派发出口
  const colSrc = fs.readFileSync(
    path.join(root, "src/main/services/upLoad/collection.js"),
    "utf8"
  );
  const directClicks = colSrc.match(/\.\s*click\s*\(/g) || [];
  const directDispatches = colSrc.match(/\.\s*dispatchEvent\s*\(/g) || [];
  assert.strictEqual(directClicks.length, 1, "collection.js 内只允许存在 1 处 .click()（位于 safeClick）");
  assert.strictEqual(directDispatches.length, 3, "collection.js 内只允许 safeClick 内的 3 处 dispatchEvent(mousedown/mouseup/click)");

  // 12b. A1 safeClick 拒绝 dy/ks/sph 平台提交按钮选择器及 8 层祖先链、精确提交词表与 aria-labelledby
  {
    const { doc, body } = makeDoc();
    let clickedCount = 0;
    const markClick = (el) => {
      el.onClick = () => {
        clickedCount += 1;
      };
      return el;
    };

    // dy: #popover-tip-container 及其 8 层后代、#popover-tip-container+button
    const dyPub = markClick(new FakeElement("div", "动作", { id: "popover-tip-container" }));
    let cur = dyPub;
    for (let d = 1; d <= 8; d++) {
      const child = markClick(new FakeElement("div", d === 8 ? "选择方式" : ""));
      cur.append(child);
      cur = child;
    }
    const dyDeepChild = cur;
    const dyDraft = markClick(new FakeElement("button", "草稿入口"));
    body.append(dyPub, dyDraft);

    // ks: #setting-tours + div 下 button 与行
    const ksTours = new FakeElement("div", "", { id: "setting-tours" });
    const ksBar = new FakeElement("div", "");
    const ksRow = markClick(new FakeElement("div", ""));
    const ksBtn = markClick(new FakeElement("button", "未知文案"));
    const ksInnerSpan = markClick(new FakeElement("span", "图标"));
    ksBtn.append(ksInnerSpan);
    ksRow.append(ksBtn);
    ksBar.append(ksRow);
    body.append(ksTours, ksBar);

    // sph: .form-btns>div:first-child button 与 :last-child button（复用 sph.js 常量）
    const sphBtns = new FakeElement("div", "", { class: "form-btns" });
    const sphDraftWrap = new FakeElement("div", "");
    const sphDraftBtn = markClick(new FakeElement("button", "无文案图标"));
    const sphDraftIcon = markClick(new FakeElement("span", ""));
    sphDraftBtn.append(sphDraftIcon);
    sphDraftWrap.append(sphDraftBtn);
    const sphPubWrap = new FakeElement("div", "");
    const sphPubBtn = markClick(new FakeElement("button", "无文案图标2"));
    sphPubWrap.append(sphPubBtn);
    sphBtns.append(sphDraftWrap, sphPubWrap);
    body.append(sphBtns);

    // aria-labelledby 指向外部提交文案
    const extCaption = new FakeElement("span", "保存草稿", { id: "ext-draft-cap" });
    const labelledBtn = markClick(
      new FakeElement("button", "", {
        type: "button",
        "aria-haspopup": "listbox",
        "aria-labelledby": "ext-draft-cap",
      })
    );
    body.append(labelledBtn, extCaption);

    // 12 个精确提交词表 + aria-label / title / value
    const exactWordEls = collectionMod.SUBMIT_BUTTON_EXACT_TEXTS.map((w) =>
      markClick(new FakeElement("button", w, { type: "button" }))
    );
    const ariaLabelEl = markClick(
      new FakeElement("div", "", { role: "button", "aria-label": "立即发布" })
    );
    const titleEl = markClick(
      new FakeElement("div", "", { role: "button", title: "暂存离开" })
    );
    const valueEl = markClick(
      new FakeElement("input", "", { type: "button", value: "确认发布" })
    );
    const submitTypeEl = markClick(
      new FakeElement("button", "非提交文案", { type: "submit" })
    );
    const submitChild = markClick(new FakeElement("span", "请选择合集"));
    submitTypeEl.append(submitChild);
    body.append(...exactWordEls, ariaLabelEl, titleEl, valueEl, submitTypeEl);

    const prevDoc = global.document;
    global.document = doc;
    try {
      const mustReject = [
        dyPub,
        dyDeepChild,
        dyDraft,
        ksRow,
        ksBtn,
        ksInnerSpan,
        sphDraftBtn,
        sphDraftIcon,
        sphPubBtn,
        labelledBtn,
        ...exactWordEls,
        ariaLabelEl,
        titleEl,
        valueEl,
        submitTypeEl,
        submitChild,
      ];
      for (const el of mustReject) {
        assert.throws(
          () => collectionMod.safeClick(el, { root: doc }),
          (err) => {
            assert.strictEqual(err.deterministic, true);
            assert.ok(
              err.message.includes("合集操作被拒：目标疑似提交按钮"),
              `应抛确定性拒绝文案，实际: ${err.message}`
            );
            return true;
          }
        );
      }
      assert.strictEqual(clickedCount, 0, "被 safeClick 拒绝的元素点击次数必须严格为 0");

      // 合法控件（含「校园发布会」字样）允许通过 safeClick
      let legitClicked = 0;
      const legit = new FakeElement("div", "校园发布会", {
        class: "semi-select",
        title: "校园发布会",
      });
      legit.onClick = () => {
        legitClicked += 1;
      };
      body.append(legit);
      assert.strictEqual(collectionMod.safeClick(legit, { root: doc }), true);
      assert.strictEqual(legitClicked, 1, "合法合集控件「校园发布会」应正常通过 safeClick");
    } finally {
      if (prevDoc === undefined) delete global.document;
      else global.document = prevDoc;
    }
  }

  // 12c. A1 + A2：同行 aria-labelledby 提交按钮 / submit 祖先 / 跨行（.field 与无类名）均 0 点击且抛错
  const origLog = console.log;
  const origError = console.error;
  console.log = console.error = () => {};
  try {
    // 12c-1：同行 aria-labelledby="external-caption" 指向「发布」/「保存草稿」→ 0 点击
    for (const [ptName, capText] of [
      ["抖音", "发布"],
      ["快手", "保存草稿"],
    ]) {
      const { doc, body } = makeDoc();
      let actionClicks = 0;
      const row = new FakeElement("div", "", { class: "collection-form-item" });
      row.append(new FakeElement("label", "合集"));
      const btn = new FakeElement("button", "", {
        type: "button",
        "aria-haspopup": "listbox",
        "aria-labelledby": "external-caption",
      });
      btn.onClick = () => {
        actionClicks += 1;
      };
      row.append(btn);
      body.append(row, new FakeElement("span", capText, { id: "external-caption" }));
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            ptName,
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => err.deterministic === true
      );
      assert.strictEqual(actionClicks, 0, `${ptName} aria-labelledby="${capText}" 绝不能被点击`);
    }

    // 12c-2：review2 跨行复现：.field 只有「合集」，相邻 .field 有「同步设置」与 #popover-tip-container
    {
      const { doc, body } = makeDoc();
      let pubClicks = 0;
      const settings = new FakeElement("div", "", { class: "settings" });
      const field1 = new FakeElement("div", "", { class: "field" });
      field1.append(new FakeElement("span", "合集"));
      const field2 = new FakeElement("div", "", { class: "field" });
      field2.append(new FakeElement("span", "同步设置"));
      const popover = new FakeElement("div", "", { id: "popover-tip-container" });
      popover.onClick = () => {
        pubClicks += 1;
      };
      const inner = new FakeElement("div", "选择方式", { "aria-haspopup": "listbox" });
      inner.onClick = () => {
        pubClicks += 1;
      };
      popover.append(new FakeElement("span", "发布"), inner);
      field2.append(popover);
      settings.append(field1, field2);
      body.append(settings);

      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            "抖音",
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => {
          assert.strictEqual(err.code, "collection_entry_not_found");
          assert.strictEqual(err.deterministic, true);
          return true;
        }
      );
      assert.strictEqual(pubClicks, 0, "跨行查找绝不能点到抖音发布按钮");
    }

    // 12c-3：无标准类名的跨行容器（同含另一表单标签「同步设置」）→ 0 点击
    {
      const { doc, body } = makeDoc();
      let otherClicks = 0;
      const wrapper = new FakeElement("div", "", { class: "box-group" });
      const r1 = new FakeElement("div", "", { class: "box" });
      r1.append(new FakeElement("span", "合集"));
      const r2 = new FakeElement("div", "", { class: "box" });
      r2.append(new FakeElement("span", "同步设置"));
      const otherSel = new FakeElement("div", "请选择", { class: "semi-select" });
      otherSel.onClick = () => {
        otherClicks += 1;
      };
      r2.append(otherSel);
      wrapper.append(r1, r2);
      body.append(wrapper);

      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            "抖音",
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => err.code === "collection_entry_not_found" && err.deterministic === true
      );
      assert.strictEqual(otherClicks, 0, "含其他表单标签的跨行控件绝不能被点击");
    }

    // 12c-4：<button type="submit"> 包裹「合集」和 .semi-select → 0 点击
    {
      const { doc, body } = makeDoc();
      let submitClicks = 0;
      const submitBtn = new FakeElement("button", "", { type: "submit" });
      submitBtn.onClick = () => {
        submitClicks += 1;
      };
      const innerSel = new FakeElement("span", "请选择合集", { class: "semi-select" });
      innerSel.onClick = () => {
        submitClicks += 1;
      };
      submitBtn.append(new FakeElement("span", "合集"), innerSel);
      body.append(submitBtn);
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            "抖音",
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => err.deterministic === true
      );
      assert.strictEqual(submitClicks, 0, "submit 按钮内部节点绝不能被点击");
    }

    // 12d. A3：「校园发布会」合集名与当前已选显示值正常打开、选中和回读
    {
      const { doc, body } = makeDoc();
      const row = new FakeElement("div", "", { class: "collection-form-item" });
      row.append(new FakeElement("label", "合集"));
      const sel = new FakeElement("div", "", {
        class: "semi-select select-collection-x",
        role: "combobox",
        "aria-controls": "campus-list",
      });
      const selText = new FakeElement("span", "校园发布会", {
        class: "semi-select-selection-text",
      });
      sel.append(selText);
      row.append(sel);
      body.append(row);

      let opened = 0;
      let picked = "";
      sel.onClick = () => {
        opened += 1;
        if (doc.querySelector("#campus-list")) return;
        const popup = new FakeElement("div", "", {
          id: "campus-list",
          class: "mix-dropdown semi-select-option-list",
          role: "listbox",
        });
        for (const name of ["校园发布会", "民间故事"]) {
          const opt = new FakeElement("div", name, {
            class: "semi-select-option collection-option",
            role: "option",
          });
          opt.onClick = () => {
            picked = name;
            selText.textContent = name;
            popup.remove();
          };
          popup.append(opt);
        }
        body.append(popup);
      };

      const res = await collectionMod.selectPlatformCollection(
        makeEvalPage(doc),
        "抖音",
        { collection: "校园发布会" },
        { timeouts: fastTimeouts, captureScreenshot: async () => "" }
      );
      assert.strictEqual(res.selected, true, "「校园发布会」必须正常选择和回读");
      assert.strictEqual(res.displayedText, "校园发布会");
      assert.strictEqual(opened, 1);
      assert.strictEqual(picked, "校园发布会");
    }

    // 12f. 2026-11-22 抖音真机结构：左侧导航 li、行内「类型」select 在前、首项「不选择合集」、
    //      选项名在 option-title、旁有「共N个作品」→ 只能打开 select-collection 并选中「民间故事」
    {
      const { doc, body } = makeDoc();
      const nav = new FakeElement("ul", "", { role: "menu" });
      for (const n of ["首页", "内容管理", "民间故事"]) nav.append(new FakeElement("li", n, { role: "menuitem" }));
      body.append(nav);
      const row = new FakeElement("div", "", { class: "content-obt4oA" });
      const titleWrap = new FakeElement("div", "", { class: "title-dS7kae" });
      titleWrap.append(new FakeElement("span", "添加合集", { class: "title-content-oaqcSp" }));
      const head = new FakeElement("div", "");
      head.append(titleWrap);
      row.append(head);
      let typeOpened = 0;
      // 真机第 3 轮：类型控件已选中，显示「合集」；两个 semi-select 均不假设有 role
      const typeSel = new FakeElement("div", "", { class: "semi-select select-mix-type-G9iqb2" });
      typeSel.append(new FakeElement("span", "合集", { class: "semi-select-selection-text" }));
      typeSel.onClick = () => { typeOpened += 1; };
      const sel = new FakeElement("div", "", { class: "semi-select select-collection-nkL6sA" });
      const selText = new FakeElement("span", "请选择合集", { class: "semi-select-selection-text" });
      sel.append(selText);
      const ctl = new FakeElement("div", "", { class: "content-child-V0CB7w" });
      const area = new FakeElement("div", "", { class: "sel-area-uXj3oO" });
      area.append(typeSel, sel);
      ctl.append(area);
      row.append(ctl);
      body.append(row);
      let picked = "";
      sel.onClick = () => {
        if (doc.querySelector(".mix-dropdown")) return;
        const pop = new FakeElement("div", "", { class: "semi-popover-content" });
        const dd = new FakeElement("div", "", { class: "mix-dropdown" });
        const list = new FakeElement("div", "", { class: "semi-select-option-list" });
        const none = new FakeElement("div", "", { class: "semi-select-option" });
        none.append(new FakeElement("div", "不选择合集", { class: "semi-select-option-text" }));
        none.onClick = () => { picked = "不选择合集"; };
        list.append(none);
        for (const [name, cnt] of [["民间故事", "共21个作品"], ["钟馗说案", "共10个作品"]]) {
          const opt = new FakeElement("div", "", { class: "semi-select-option collection-option" });
          opt.append(new FakeElement("span", name, { class: "option-title-WKxxu3" }));
          opt.append(new FakeElement("span", cnt, { class: "option-extra-text-i_ch3r" }));
          // 真机第 4 轮：选中后控件渲染整条选项文本「民间故事共21个作品」
          opt.onClick = () => { picked = name; selText.textContent = name + cnt; pop.remove(); };
          list.append(opt);
        }
        dd.append(list);
        pop.append(dd);
        body.append(pop);
      };
      const res = await collectionMod.selectPlatformCollection(
        makeEvalPage(doc),
        "抖音",
        { collection: "民间故事" },
        { timeouts: fastTimeouts, captureScreenshot: async () => "" }
      );
      assert.strictEqual(res.selected, true, "真机结构下必须选中「民间故事」");
      assert.strictEqual(picked, "民间故事");
      assert.strictEqual(typeOpened, 0, "不得打开合集类型控件");
      assert.strictEqual(res.displayedText, "民间故事");
    }

    // 12g. 评审复现：真名「民间故事共3个作品」被选中时，option-title 不剥后缀 → 对目标「民间故事」判不符
    {
      const { doc, body } = makeDoc();
      const row = new FakeElement("div", "", { class: "content-obt4oA" });
      row.append(new FakeElement("span", "添加合集", { class: "title-content-oaqcSp" }));
      const sel = new FakeElement("div", "", { class: "semi-select select-collection-nkL6sA" });
      const selText = new FakeElement("span", "请选择合集", { class: "semi-select-selection-text" });
      sel.append(selText);
      row.append(sel);
      body.append(row);
      sel.onClick = () => {
        if (doc.querySelector(".mix-dropdown")) return;
        const dd = new FakeElement("div", "", { class: "mix-dropdown" });
        const opt = new FakeElement("div", "", { class: "semi-select-option collection-option" });
        opt.append(new FakeElement("span", "民间故事", { class: "option-title-a" }));
        opt.onClick = () => {
          // 平台实际选中了另一个真名为「民间故事共3个作品」的合集
          selText.textContent = "";
          selText.append(new FakeElement("span", "民间故事共3个作品", { class: "option-title-a" }));
          selText.append(new FakeElement("span", "共8个作品", { class: "option-extra-text-b" }));
          dd.remove();
        };
        dd.append(opt);
        body.append(dd);
      };
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            "抖音",
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => err.code === "collection_readback_mismatch"
      );
    }

    // 12h. 评审复现：真名「民间故事共3个作品」在 option-title，计数在 selection-text 同级 → 仍须判不符
    {
      const { doc, body } = makeDoc();
      const row = new FakeElement("div", "", { class: "content-obt4oA" });
      row.append(new FakeElement("span", "添加合集", { class: "title-content-oaqcSp" }));
      const sel = new FakeElement("div", "", { class: "semi-select select-collection-nkL6sA" });
      const selection = new FakeElement("div", "", { class: "semi-select-selection" });
      const selText = new FakeElement("span", "请选择合集", { class: "semi-select-selection-text" });
      selection.append(selText);
      sel.append(selection);
      row.append(sel);
      body.append(row);
      sel.onClick = () => {
        if (doc.querySelector(".mix-dropdown")) return;
        const dd = new FakeElement("div", "", { class: "mix-dropdown" });
        const opt = new FakeElement("div", "", { class: "semi-select-option collection-option" });
        opt.append(new FakeElement("span", "民间故事", { class: "option-title-a" }));
        opt.onClick = () => {
          selText.textContent = "";
          selText.append(new FakeElement("span", "民间故事共3个作品", { class: "option-title-a" }));
          selection.append(new FakeElement("span", "共8个作品", { class: "option-extra-text-b" }));
          dd.remove();
        };
        dd.append(opt);
        body.append(dd);
      };
      await assert.rejects(
        () =>
          collectionMod.selectPlatformCollection(
            makeEvalPage(doc),
            "抖音",
            { collection: "民间故事" },
            { timeouts: fastTimeouts, captureScreenshot: async () => "" }
          ),
        (err) => err.code === "collection_readback_mismatch"
      );
    }

    // 12e. A4：带内嵌 span 的占位文案「请选择<span>合集</span>」对目标名「合集」必须判未选失败；
    //      真正选中「合集」后回读才通过
    {
      // 12e-1：点击选项后控件仍保持「请选择<span>合集</span>」→ 回读失败
      for (const phClass of ["semi-select-selection-placeholder", "semi-select-selection-text"]) {
        const { doc, body } = makeDoc();
        const row = new FakeElement("div", "", { class: "collection-form-item" });
        row.append(new FakeElement("label", "合集"));
        const sel = new FakeElement("div", "", {
          class: "semi-select select-collection-x",
          role: "combobox",
          "aria-controls": "album-opts",
        });
        const phOuter = new FakeElement("span", "请选择", { class: phClass });
        phOuter.append(new FakeElement("span", "合集"));
        sel.append(phOuter);
        row.append(sel);
        body.append(row);

        sel.onClick = () => {
          if (doc.querySelector("#album-opts")) return;
          const popup = new FakeElement("div", "", {
            id: "album-opts",
            class: "mix-dropdown semi-select-option-list",
            role: "listbox",
          });
          const opt = new FakeElement("div", "合集", {
            class: "semi-select-option collection-option",
            role: "option",
          });
          opt.onClick = () => {
            // 模拟选中未生效：占位文本「请选择<span>合集</span>」未变
            popup.remove();
          };
          popup.append(opt);
          body.append(popup);
        };

        await assert.rejects(
          () =>
            collectionMod.selectPlatformCollection(
              makeEvalPage(doc),
              "抖音",
              { collection: "合集" },
              { timeouts: fastTimeouts, captureScreenshot: async () => "" }
            ),
          (err) => {
            assert.strictEqual(err.code, "collection_readback_mismatch");
            assert.strictEqual(err.deterministic, true);
            assert.ok(err.message.includes("请选择合集"));
            return true;
          }
        );
      }

      // 12e-2：目标名恰为「合集」且选中后控件真实显示「合集」→ 回读通过
      {
        const { doc, body } = makeDoc();
        const row = new FakeElement("div", "", { class: "collection-form-item" });
        row.append(new FakeElement("label", "合集"));
        const sel = new FakeElement("div", "", {
          class: "semi-select select-collection-x",
          role: "combobox",
          "aria-controls": "album-opts-ok",
        });
        const phOuter = new FakeElement("span", "请选择", {
          class: "semi-select-selection-placeholder",
        });
        phOuter.append(new FakeElement("span", "合集"));
        sel.append(phOuter);
        row.append(sel);
        body.append(row);

        sel.onClick = () => {
          if (doc.querySelector("#album-opts-ok")) return;
          const popup = new FakeElement("div", "", {
            id: "album-opts-ok",
            class: "mix-dropdown semi-select-option-list",
            role: "listbox",
          });
          const opt = new FakeElement("div", "合集", {
            class: "semi-select-option collection-option",
            role: "option",
          });
          opt.onClick = () => {
            sel.children = [];
            sel.append(
              new FakeElement("span", "合集", {
                class: "semi-select-selection-text",
              })
            );
            popup.remove();
          };
          popup.append(opt);
          body.append(popup);
        };

        const okRes = await collectionMod.selectPlatformCollection(
          makeEvalPage(doc),
          "抖音",
          { collection: "合集" },
          { timeouts: fastTimeouts, captureScreenshot: async () => "" }
        );
        assert.strictEqual(okRes.selected, true, "目标名恰为「合集」且真实选中后应回读通过");
        assert.strictEqual(okRes.displayedText, "合集");
      }
    }
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  console.log("✓ 12. S12-fix2 safeClick 唯一出口、跨行隔离、「校园发布会」与内嵌 span 占位回读通过");
}

(async () => {
  testSharedCollectionResolution();
  testExcelCollectionColumn();
  testCliAndHttpInputs();
  testGuiLocalVideoPublish();
  testMatchingHelpers();
  await testFakePageFlows();
  await testHandlerCollectionFailureGates();
  await testSphLinkFallbackCollectionGate();
  await testScheduledReuseCollectionConflict();
  await testMcpCollectionAndE2eEvidence();
  await testS12Fix2StructuralGuards();
  console.log("\ntest-collection: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
