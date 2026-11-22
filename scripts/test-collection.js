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
const os = require("os");
const path = require("path");
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
    // 分离 tag、.class、[attr="val"]、[attr*='val']
    let rest = s;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      if (this.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
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
      }
    }
    return true;
  }
  matches(selector) {
    return String(selector || "")
      .split(",")
      .some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return false;
        if (!this.matchesSingle(tokens[tokens.length - 1])) return false;
        let ancestor = this.parentElement;
        for (let i = tokens.length - 2; i >= 0; i--) {
          let matched = false;
          while (ancestor) {
            if (ancestor.matchesSingle(tokens[i])) {
              matched = true;
              ancestor = ancestor.parentElement;
              break;
            }
            ancestor = ancestor.parentElement;
          }
          if (!matched) return false;
        }
        return true;
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
        : "semi-select";
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
          : "semi-select-option-list mm-test-popup";
      const optClass =
        platformKey === "ks"
          ? "ant-select-item-option"
          : platformKey === "sph"
          ? "option-item"
          : "semi-select-option";
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
            displaySpan.textContent =
              platformKey === "sph" ? `已选：${title}` : title;
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
  console.log("✓ 3. CLI 与 HTTP 入参解析、覆盖优先级及帮助文案通过");
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
    collectionMod.matchesCollectionReadback("已选：民 间 故 事", "民间故事"),
    true,
    "控件显示含目标合集名（去空白）应通过回读"
  );
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

(async () => {
  testSharedCollectionResolution();
  testExcelCollectionColumn();
  testCliAndHttpInputs();
  testGuiLocalVideoPublish();
  testMatchingHelpers();
  await testFakePageFlows();
  await testHandlerCollectionFailureGates();
  console.log("\ntest-collection: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
