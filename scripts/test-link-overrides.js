/**
 * 跨平台作品关联手工矫正（link-overrides.json）全链路单元测试（不依赖 Electron 运行环境）：
 *
 * 1. store.js：readLinkOverrides / writeLinkOverrides / setLinkOverride / mergeWorksOverride / clearLinkOverride
 *    - 不存在静默返回空；JSON 损坏 / 结构无效 / EISDIR 视为空并 console.warn，不抛
 *    - 原子写失败（ENOSPC）保留旧文件完整、清理临时文件；特殊 key 防原型污染
 * 2. contentLink.js：assign / detach / merge / clear 应用顺序与边界
 *    - detach 后不被 ③ 模糊匹配或 ④ 跨平台聚类重新合并；拆出 auto 簇一员不留孤儿簇
 *    - assign 指向不存在 contentKey（已删素材/无效 auto）被忽略并保持自动结果
 *    - 确认模糊匹配（固化为 assign）与合并多条未关联作品（manual:<id>）
 * 3. IPC（dataStats/index.js）：stats:get-link-overrides / stats:set-link-override / stats:merge-works / stats:clear-link-override
 *    - 本地页面安全校验、参数校验、正常读写、并发 Promise.all 串行写入不丢写
 * 4. 汇总与导出一致性：stats:get-content-summary / buildContentSummaryData / buildStatsWorkbookData / .xlsx 读回均读到 overrides
 * 5. dataStats/index.vue 关键矫正交互方法与模板编译验证
 *
 * 运行：yarn test:link-overrides
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xlsx = require("xlsx");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

const {
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
} = require("../src/main/services/dataStats/contentLink.js");
const {
  buildContentSummaryData,
  buildStatsWorkbookData,
  writeStatsXlsx,
} = require("../src/main/services/dataStats/statsExport.js");

function captureWarn(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = origWarn;
  }
}

const dayTs = (ymd) => Date.parse(`${ymd}T02:00:00Z`);

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-link-overrides-test-"));
  const userDataDir = path.join(tmpRoot, "userData");
  const docsDir = path.join(tmpRoot, "Documents");
  const pushDataDir = path.join(docsDir, "MatrixMedia", "data", "pushData");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(pushDataDir, { recursive: true });

  const ipcHandlers = new Map();
  const electronId = require.resolve("electron");
  const origElectronCache = require.cache[electronId];
  const storeId = require.resolve("../src/main/services/dataStats/store.js");
  const indexId = require.resolve("../src/main/services/dataStats/index.js");
  const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
  const origStoreCache = require.cache[storeId];
  const origIndexCache = require.cache[indexId];
  const origCollectorCache = require.cache[collectorId];

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      app: {
        getPath: (name) => (name === "documents" ? docsDir : userDataDir),
        getVersion: () => "0.14.9-fork.test",
      },
      ipcMain: {
        handle: (channel, fn) => ipcHandlers.set(channel, fn),
      },
      BrowserWindow: {
        fromWebContents: () => ({ id: 1 }),
      },
      dialog: {
        showSaveDialog: async () => ({ canceled: true, filePath: "" }),
      },
    },
  };
  require.cache[collectorId] = {
    id: collectorId,
    filename: collectorId,
    loaded: true,
    exports: { collectAccount: async () => ({ overview: {}, fansHistory: [], works: [] }) },
  };
  delete require.cache[storeId];
  delete require.cache[indexId];

  try {
    const store = require(storeId);
    const { registerDataStatsIpc } = require(indexId);
    const overridesFile = path.join(userDataDir, "data-stats", "link-overrides.json");

    /* ---------- 1. store.js：读写、原子写容错、损坏文件视为空+warn ---------- */
    {
      // 1a. 文件不存在：静默返回空
      const { result: emptyDoc, warnings: emptyWarns } = captureWarn(() => store.readLinkOverrides());
      assert.strictEqual(emptyDoc.version, 1);
      assert.deepStrictEqual(Object.keys(emptyDoc.overrides), []);
      assert.deepStrictEqual(emptyWarns, []);

      // 1b. set / merge / clear 往返
      const d1 = store.setLinkOverride("G1|抖音|w1", { action: "assign", contentKey: "file:/v/a.mp4" }, 1000);
      assert.strictEqual(d1.version, 1);
      assert.strictEqual(d1.updatedAt, 1000);
      assert.deepStrictEqual(d1.overrides["G1|抖音|w1"], { action: "assign", contentKey: "file:/v/a.mp4" });
      assert.ok(fs.existsSync(overridesFile));

      const d2 = store.setLinkOverride("G1|快手|w2", { action: "detach" }, 2000);
      assert.deepStrictEqual(d2.overrides["G1|快手|w2"], { action: "detach" });

      const merged = store.mergeWorksOverride(["G1|抖音|u1", "G1|小红书|u2", "G1|抖音|u1"], 3000);
      assert.ok(merged.contentKey.startsWith("manual:"));
      assert.deepStrictEqual(merged.workKeys, ["G1|抖音|u1", "G1|小红书|u2"]);
      assert.deepStrictEqual(merged.doc.overrides["G1|抖音|u1"], {
        action: "assign",
        contentKey: merged.contentKey,
      });
      assert.deepStrictEqual(merged.doc.overrides["G1|小红书|u2"], {
        action: "assign",
        contentKey: merged.contentKey,
      });

      // 少于 2 条不允许合并
      assert.throws(() => store.mergeWorksOverride(["G1|抖音|only1"]));
      assert.throws(() => store.mergeWorksOverride(["G1|抖音|dup", "G1|抖音|dup"]));

      // clear 清除单条
      const d3 = store.clearLinkOverride("G1|快手|w2", 4000);
      assert.strictEqual(d3.overrides["G1|快手|w2"], undefined);
      assert.deepStrictEqual(d3.overrides["G1|抖音|w1"], { action: "assign", contentKey: "file:/v/a.mp4" });

      // 特殊 key（__proto__）不发生原型污染
      store.setLinkOverride("G1|抖音|__proto__", { action: "detach" }, 4500);
      const rereadProto = store.readLinkOverrides();
      assert.deepStrictEqual(rereadProto.overrides["G1|抖音|__proto__"], { action: "detach" });
      assert.strictEqual(({}).action, undefined);

      // 1c. 原子写失败（fsync ENOSPC）保留旧文件完整、无 .tmp 残留
      const intactBytes = fs.readFileSync(overridesFile, "utf8");
      const origFsync = fs.fsyncSync;
      fs.fsyncSync = () => {
        const err = new Error("ENOSPC: disk full");
        err.code = "ENOSPC";
        throw err;
      };
      try {
        assert.throws(() => store.setLinkOverride("G1|抖音|fail", { action: "detach" }), /ENOSPC/);
      } finally {
        fs.fsyncSync = origFsync;
      }
      assert.strictEqual(fs.readFileSync(overridesFile, "utf8"), intactBytes);
      const leftovers = fs
        .readdirSync(path.dirname(overridesFile))
        .filter((f) => f.endsWith(".tmp"));
      assert.deepStrictEqual(leftovers, [], "原子写失败不得残留 .tmp 文件");

      // 1d. 损坏 JSON / 非法结构 / 读 I/O 失败（EISDIR）→ 视为空并 console.warn，不抛
      for (const badContent of ["{broken json", "[]", "null", '{"version":1,"overrides":[]}']) {
        fs.writeFileSync(overridesFile, badContent, "utf8");
        const { result: badRes, warnings } = captureWarn(() => store.readLinkOverrides());
        assert.strictEqual(badRes.version, 1);
        assert.deepStrictEqual(Object.keys(badRes.overrides), []);
        assert.ok(warnings.some((w) => w.includes("link-overrides.json")), `损坏内容 ${badContent} 应 warn`);
      }

      fs.rmSync(overridesFile, { force: true });
      fs.mkdirSync(overridesFile);
      const { result: dirRes, warnings: dirWarns } = captureWarn(() => store.readLinkOverrides());
      assert.deepStrictEqual(Object.keys(dirRes.overrides), []);
      assert.ok(dirWarns.some((w) => w.includes("link-overrides.json")), "读失败(EISDIR)应 warn 且不抛");
      fs.rmdirSync(overridesFile);

      console.log("✓ store.js link-overrides 原子读写、损坏/读失败视为空+warn 与原型防护通过");
    }

    /* ---------- 2. contentLink.js：assign/detach/merge/clear、detach 阻断模糊重合、无效 key 忽略 ---------- */
    {
      const contents = buildContentIndex([
        {
          pt: "抖音",
          group: "G1",
          title: "手把手教你做正宗秘制红烧肉软烂入味完整版",
          filePath: "D:\\v\\hsr.mp4",
          publishStatus: "success",
          date: "2026-11-10",
        },
        {
          pt: "快手",
          group: "G1",
          title: "零基础三步学会煎牛排外焦里嫩完整版",
          filePath: "D:\\v\\steak.mp4",
          publishStatus: "success",
          date: "2026-11-10",
        },
      ]);
      const accounts = [
        {
          group: "G1",
          platform: "抖音",
          works: [
            // 会模糊匹配到 hsr.mp4
            { workId: "dy_fuzzy", title: "手把手教你做正宗秘制红烧肉", publishTime: dayTs("2026-11-10") },
            // 会和 ks_auto 经 ④ 自动聚成 auto:*
            { workId: "dy_auto", title: "周末户外露营必带十件实用装备清单", publishTime: dayTs("2026-11-10") },
            // 完全无关联作品
            { workId: "dy_free", title: "周末清晨爬山看日出记录", publishTime: dayTs("2026-11-10") },
          ],
        },
        {
          group: "G1",
          platform: "快手",
          works: [
            { workId: "ks_auto", title: "周末户外露营 #露营 必带十件实用装备", publishTime: dayTs("2026-11-11") },
            { workId: "ks_free", title: "厨房台面收纳整理好物分享", publishTime: dayTs("2026-11-11") },
          ],
        },
      ];

      // 2a. 无 overrides 时的自动基线
      const baseLink = linkWorks({ contents, accounts });
      assert.strictEqual(baseLink.get("G1|抖音|dy_fuzzy").contentKey, "file:d:/v/hsr.mp4");
      assert.strictEqual(baseLink.get("G1|抖音|dy_fuzzy").matchedBy, "fuzzy");
      const autoKey = baseLink.get("G1|抖音|dy_auto").contentKey;
      assert.ok(autoKey && autoKey.startsWith("auto:"));
      assert.strictEqual(baseLink.get("G1|快手|ks_auto").contentKey, autoKey);
      assert.strictEqual(baseLink.get("G1|抖音|dy_free").contentKey, null);
      assert.strictEqual(baseLink.get("G1|快手|ks_free").contentKey, null);

      // 2b. detach 后不再被 ③ 模糊匹配或 ④ 跨平台聚类重新合并；且拆出 auto 簇一员不留孤儿簇
      const detachedLink = linkWorks({
        contents,
        accounts,
        overrides: {
          "G1|抖音|dy_fuzzy": { action: "detach" },
          "G1|抖音|dy_auto": { action: "detach" },
        },
      });
      assert.deepStrictEqual(detachedLink.get("G1|抖音|dy_fuzzy"), {
        contentKey: null,
        matchedBy: "manual-detach",
      });
      assert.deepStrictEqual(detachedLink.get("G1|抖音|dy_auto"), {
        contentKey: null,
        matchedBy: "manual-detach",
      });
      assert.deepStrictEqual(
        detachedLink.get("G1|快手|ks_auto"),
        { contentKey: null, matchedBy: null },
        "从 2 条作品的 auto 簇拆出 1 条后，剩余 1 条不得留孤儿 auto 簇"
      );

      // 2c. assign 指向不存在 contentKey（素材被删 / 无效 auto）→ 忽略该条并保持自动结果
      const badAssignLink = linkWorks({
        contents,
        accounts,
        overrides: {
          "G1|抖音|dy_fuzzy": { action: "assign", contentKey: "file:d:/v/deleted_forever.mp4" },
          "G1|抖音|dy_auto": { action: "assign", contentKey: "auto:0000000000000000" },
        },
      });
      assert.strictEqual(
        badAssignLink.get("G1|抖音|dy_fuzzy").contentKey,
        "file:d:/v/hsr.mp4",
        "assign 指向已删除素材必须被忽略，保持自动模糊结果"
      );
      assert.strictEqual(badAssignLink.get("G1|抖音|dy_fuzzy").matchedBy, "fuzzy");
      assert.strictEqual(
        badAssignLink.get("G1|抖音|dy_auto").contentKey,
        autoKey,
        "assign 指向不存在的 auto key 必须被忽略，保持自动聚类结果"
      );

      // 2d. 有效 assign + 确认 auto 簇 + 手工合并两个未关联作品（manual:*）
      const manualOverrides = {
        // 把原本模糊配给 hsr 的作品改合并到 steak
        "G1|抖音|dy_fuzzy": { action: "assign", contentKey: "file:d:/v/steak.mp4" },
        // 把 auto 簇固化为 manual
        "G1|抖音|dy_auto": { action: "assign", contentKey: autoKey },
        "G1|快手|ks_auto": { action: "assign", contentKey: autoKey },
        // 合并两个未关联作品为 manual:*
        "G1|抖音|dy_free": { action: "assign", contentKey: "manual:custom001" },
        "G1|快手|ks_free": { action: "assign", contentKey: "manual:custom001" },
      };
      const manualLink = linkWorks({ contents, accounts, overrides: manualOverrides });
      assert.deepStrictEqual(manualLink.get("G1|抖音|dy_fuzzy"), {
        contentKey: "file:d:/v/steak.mp4",
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualLink.get("G1|抖音|dy_auto"), {
        contentKey: autoKey,
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualLink.get("G1|快手|ks_auto"), {
        contentKey: autoKey,
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualLink.get("G1|抖音|dy_free"), {
        contentKey: "manual:custom001",
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualLink.get("G1|快手|ks_free"), {
        contentKey: "manual:custom001",
        matchedBy: "manual",
      });

      const summary = buildContentSummaryRows({
        contents,
        accounts,
        worksDaily: {
          "G1|抖音": {
            dy_fuzzy: { "2026-11-12": { play: 100 } },
            dy_auto: { "2026-11-12": { play: 200 } },
            dy_free: { "2026-11-12": { play: 300 } },
          },
          "G1|快手": {
            ks_auto: { "2026-11-12": { play: 400 } },
            ks_free: { "2026-11-12": { play: 500 } },
          },
        },
        overrides: manualOverrides,
      });
      const manualMergedRow = summary.find((r) => r.contentKey === "manual:custom001");
      assert.ok(manualMergedRow);
      assert.strictEqual(manualMergedRow.title, "周末清晨爬山看日出记录", "manual 合并标题应取最早发布作品");
      assert.strictEqual(manualMergedRow.file, "");
      assert.strictEqual(manualMergedRow.platformCount, 2);
      assert.strictEqual(manualMergedRow.totalPlay, 800);
      assert.strictEqual(manualMergedRow.matchMethod, "manual");
      assert.strictEqual(manualMergedRow.hasFuzzy, false);

      const confirmedAutoRow = summary.find((r) => r.contentKey === autoKey);
      assert.ok(confirmedAutoRow);
      assert.strictEqual(confirmedAutoRow.matchMethod, "manual");
      assert.strictEqual(confirmedAutoRow.hasFuzzy, false);

      console.log("✓ contentLink.js overrides：assign/detach/merge/clear、阻断模糊重合与忽略无效 key 通过");
    }

    /* ---------- 3. IPC 安全校验、参数校验、并发串行写不丢写 + 汇总/导出一致性 ---------- */
    {
      registerDataStatsIpc();
      const getOverrides = ipcHandlers.get("stats:get-link-overrides");
      const setOverride = ipcHandlers.get("stats:set-link-override");
      const mergeWorks = ipcHandlers.get("stats:merge-works");
      const clearOverride = ipcHandlers.get("stats:clear-link-override");
      const getSummary = ipcHandlers.get("stats:get-content-summary");

      assert.strictEqual(typeof getOverrides, "function");
      assert.strictEqual(typeof setOverride, "function");
      assert.strictEqual(typeof mergeWorks, "function");
      assert.strictEqual(typeof clearOverride, "function");

      const localEv = { sender: {}, senderFrame: { url: "file:///app/index.html" } };

      // 3a. 外部页面拦截
      for (const badUrl of ["https://creator.douyin.com", "http://localhost.evil/", "file://remote/a.html", ""]) {
        const extEv = { sender: {}, senderFrame: { url: badUrl } };
        assert.strictEqual((await getOverrides(extEv)).ok, false);
        assert.strictEqual((await setOverride(extEv, { workKey: "G|抖|1", action: "detach" })).ok, false);
        assert.strictEqual((await mergeWorks(extEv, { workKeys: ["G|抖|1", "G|快|2"] })).ok, false);
        assert.strictEqual((await clearOverride(extEv, { workKey: "G|抖|1" })).ok, false);
      }

      // 3b. 非法参数拒绝
      assert.strictEqual((await setOverride(localEv, null)).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "", action: "detach" })).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "G|抖|1", action: "bad" })).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "" })).ok, false);
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "unlinked:抖音:1" })).ok,
        false
      );
      assert.strictEqual((await mergeWorks(localEv, { workKeys: ["G|抖|1"] })).ok, false);
      assert.strictEqual((await clearOverride(localEv, { workKey: "" })).ok, false);

      // 3c. 并发 Promise.all 串行写入不丢写（同时写 10 条不同 workKey）
      const concurrentCalls = [];
      for (let i = 0; i < 10; i++) {
        concurrentCalls.push(
          setOverride(localEv, {
            workKey: `并发组|抖音|cw_${i}`,
            action: "assign",
            contentKey: `manual:batch_${i}`,
          })
        );
      }
      const concurrentResults = await Promise.all(concurrentCalls);
      assert.ok(concurrentResults.every((r) => r.ok === true));
      const afterConcurrent = await getOverrides(localEv);
      assert.strictEqual(afterConcurrent.ok, true);
      for (let i = 0; i < 10; i++) {
        assert.deepStrictEqual(
          afterConcurrent.overrides[`并发组|抖音|cw_${i}`],
          { action: "assign", contentKey: `manual:batch_${i}` },
          `并发写入第 ${i} 条不应丢失`
        );
      }

      // 清理并发测试脏数据
      fs.rmSync(overridesFile, { force: true });

      // 3d. 端到端数据：准备 pushData + store 作品日快照，通过 IPC 做 assign/detach/merge/clear，验证界面汇总与 Excel 导出完全一致
      fs.writeFileSync(
        path.join(pushDataDir, "2026-11-10.json"),
        JSON.stringify([
          {
            id: "r1",
            pt: "抖音",
            group: "主组",
            publishStatus: "success",
            title: "零基础学会做正宗红烧肉软烂入味完整教学",
            filePath: "/videos/dish_hsr.mp4",
            videoLink: "",
            lastPublishAt: dayTs("2026-11-10"),
          },
        ]),
        "utf8"
      );

      store.mergeWorks(
        "主组",
        "抖音",
        [
          {
            workId: "W_FUZZY",
            title: "零基础学会做正宗红烧肉软烂入味", // 截断模糊匹配 dish_hsr.mp4 (0.95)
            url: "https://www.douyin.com/video/11",
            publishTime: dayTs("2026-11-10"),
            play: 1000,
            like: 80,
          },
          {
            workId: "W_U1",
            title: "随手拍生活片段一",
            url: "https://www.douyin.com/video/12",
            publishTime: dayTs("2026-11-10"),
            play: 200,
            like: 10,
          },
        ],
        dayTs("2026-11-12")
      );
      store.mergeWorks(
        "主组",
        "快手",
        [
          {
            workId: "W_U2",
            title: "完全不同的快手标题二",
            url: "https://www.kuaishou.com/short-video/22",
            publishTime: dayTs("2026-11-11"),
            play: 350,
            like: 15,
          },
        ],
        dayTs("2026-11-12")
      );

      // 初始状态：W_FUZZY 是 fuzzy(0.95)，W_U1 / W_U2 未关联
      let sum = await getSummary(localEv, {});
      let wb = buildStatsWorkbookData({ now: dayTs("2026-11-12") });
      const initDish = sum.rows.find((r) => r.contentKey === "file:/videos/dish_hsr.mp4");
      assert.strictEqual(initDish.matchMethod, "fuzzy");
      assert.strictEqual(initDish.matchScore, 0.95);
      assert.strictEqual(sum.counts.unlinkedWorks, 2);
      assert.strictEqual(wb.counts.unlinkedWorks, 2);

      // 操作 1：通过 IPC 合并 W_U1 + W_U2 为 manual key，并 detach W_FUZZY
      const mergeRes = await mergeWorks(localEv, {
        workKeys: ["主组|抖音|W_U1", "主组|快手|W_U2"],
      });
      assert.strictEqual(mergeRes.ok, true);
      assert.ok(mergeRes.contentKey.startsWith("manual:"));

      const detachRes = await setOverride(localEv, {
        workKey: "主组|抖音|W_FUZZY",
        action: "detach",
      });
      assert.strictEqual(detachRes.ok, true);

      // 验证汇总 IPC 与 Excel 导出均读到 overrides 且完全一致
      sum = await getSummary(localEv, {});
      wb = buildStatsWorkbookData({ now: dayTs("2026-11-12") });
      const directSum = buildContentSummaryData({});
      assert.deepStrictEqual(sum.counts, directSum.counts);
      assert.strictEqual(sum.counts.unlinkedWorks, 1, "W_FUZZY 拆出后仅剩 1 条未关联");
      assert.strictEqual(wb.counts.unlinkedWorks, 1, "Excel 导出未关联数与界面汇总一致");
      assert.strictEqual(wb.counts.contents, sum.counts.contents);

      const mergedRowGui = sum.rows.find((r) => r.contentKey === mergeRes.contentKey);
      assert.ok(mergedRowGui);
      assert.strictEqual(mergedRowGui.matchMethod, "manual");
      assert.strictEqual(mergedRowGui.totalPlay, 550);
      assert.strictEqual(mergedRowGui.platformCount, 2);

      const detachedRowGui = sum.rows.find((r) => r.contentKey === "unlinked:抖音:W_FUZZY");
      assert.ok(detachedRowGui, "W_FUZZY 拆出后不再被模糊重新合并");
      assert.strictEqual(detachedRowGui.isManualDetach, true);

      // 写出 .xlsx 并读回校验明细与汇总中的 manual 与 detach
      const outFile = path.join(tmpRoot, "overrides-export.xlsx");
      writeStatsXlsx(wb, outFile);
      const readWb = xlsx.readFile(outFile);
      const s1Rows = xlsx.utils.sheet_to_json(readWb.Sheets["作品日明细"], { header: 1 }).slice(1);
      const s2Rows = xlsx.utils.sheet_to_json(readWb.Sheets["作品跨平台汇总"], { header: 1 }).slice(1);

      const wU1Daily = s1Rows.find((r) => r[6] === "W_U1");
      assert.strictEqual(wU1Daily[3], mergeRes.contentKey);
      assert.strictEqual(wU1Daily[4], "manual");
      assert.strictEqual(wU1Daily[5], undefined, "manual 行匹配分数应为空单元格");

      const wFuzzyDaily = s1Rows.find((r) => r[6] === "W_FUZZY");
      assert.strictEqual(wFuzzyDaily[3], undefined, "detach 后作品日明细内容ID为空");
      assert.strictEqual(wFuzzyDaily[4], undefined, "detach 后作品日明细关联方式为空");
      assert.strictEqual(wFuzzyDaily[5], undefined);

      const mergedRowXlsx = s2Rows.find((r) => r[0] === mergeRes.contentKey);
      assert.ok(mergedRowXlsx);
      assert.strictEqual(mergedRowXlsx[5], "manual", "作品跨平台汇总匹配方式列应为 manual");
      assert.strictEqual(mergedRowXlsx[6], 550);

      // 操作 2：clear W_FUZZY 的 detach → 恢复模糊匹配 fuzzy(0.95)
      const clearRes = await clearOverride(localEv, { workKey: "主组|抖音|W_FUZZY" });
      assert.strictEqual(clearRes.ok, true);
      sum = await getSummary(localEv, {});
      wb = buildStatsWorkbookData({ now: dayTs("2026-11-12") });
      assert.strictEqual(sum.counts.unlinkedWorks, 0);
      assert.strictEqual(wb.counts.unlinkedWorks, 0);
      const restoredDish = sum.rows.find((r) => r.contentKey === "file:/videos/dish_hsr.mp4");
      assert.strictEqual(restoredDish.matchMethod, "fuzzy");
      assert.strictEqual(restoredDish.matchScore, 0.95);

      const s1Restored = wb.sheets["作品日明细"].slice(1).find((r) => r[6] === "W_FUZZY");
      assert.strictEqual(s1Restored[4], "fuzzy");
      assert.strictEqual(s1Restored[5], 0.95);
      const s2Restored = wb.sheets["作品跨平台汇总"].slice(1).find((r) => r[0] === "file:/videos/dish_hsr.mp4");
      assert.strictEqual(s2Restored[5], "fuzzy");

      console.log("✓ IPC 安全/参数/并发串行写入 + 汇总与 Excel 导出 overrides 一致性全通过");
    }

    /* ---------- 4. dataStats/index.vue 模板编译与手工矫正交互方法校验 ---------- */
    {
      const vuePath = path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue");
      const sfc = vueCompiler.parseComponent(fs.readFileSync(vuePath, "utf8"));
      const compiled = vueCompiler.compile(sfc.template.content);
      assert.strictEqual(
        compiled.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${compiled.errors.join("; ")}`
      );

      const bundlePath = path.join(tmpRoot, "dataStats-view.cjs");
      await build({
        stdin: {
          contents: sfc.script.content,
          resolveDir: path.dirname(vuePath),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: bundlePath,
        plugins: [
          {
            name: "stub-vue-deps",
            setup(b) {
              b.onResolve({ filter: /(\.vue$|^@\/|\.?\/components\/|\.?\/statsUtils)/ }, (args) => ({
                path: args.path,
                namespace: "stub",
              }));
              b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
                contents:
                  "module.exports = { default: {}, dailyToRows: () => [], buildCollectAccounts: () => [], collectAccounts: async () => ({}), getCollectLogs: async () => [], getOverviewStats: async () => ({ daily: {}, accounts: [] }), onStatsProgress: () => () => {}, loadSettings: () => ({ enabled: false, time: '10:00', lastRunDate: '' }), subscribeRunComplete: () => () => {}, subscribeSettings: () => () => {}, updateSettings: () => ({ ok: true, settings: {} }) };",
                loader: "js",
              }));
            },
          },
        ],
      });

      const Module = require("module");
      const invokeCalls = [];
      let nextInvokeResult = { ok: true };
      const origLoad = Module._load;
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return {
            ipcRenderer: {
              invoke: async (channel, payload) => {
                invokeCalls.push({ channel, payload });
                if (channel === "stats:get-content-summary") return { rows: [], date: "2026-11-12" };
                return nextInvokeResult;
              },
            },
            shell: { openExternal: async () => {} },
          };
        }
        return origLoad.call(this, request, ...rest);
      };
      try {
        const comp = require(bundlePath).default;
        const messages = [];
        const ctx = {
          ...comp.data(),
          $refs: {},
          $message: {
            success: (m) => messages.push({ type: "success", m }),
            error: (m) => messages.push({ type: "error", m }),
            warning: (m) => messages.push({ type: "warning", m }),
          },
        };
        for (const [k, fn] of Object.entries(comp.methods)) {
          ctx[k] = fn.bind(ctx);
        }

        // 测试 rowMatchTagInfo 展示口径
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "link" }).label, "链接");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "title" }).label, "标题");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "fuzzy", matchScore: 0.87 }).label, "模糊 87%");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "manual" }).label, "手动");

        // 测试确认模糊匹配行（auto: 簇固化全部成员 + 刷新汇总）
        await ctx.confirmFuzzyRow({
          contentKey: "auto:1234567890abcdef",
          matchMethod: "fuzzy",
          perPlatform: {
            "抖音|G1": {
              works: [{ workKey: "G1|抖音|w1", matchedBy: "fuzzy", score: 0.9 }],
            },
            "快手|G1": {
              works: [{ workKey: "G1|快手|w2", matchedBy: "fuzzy", score: 0.9 }],
            },
          },
        });
        assert.strictEqual(
          invokeCalls.filter((c) => c.channel === "stats:set-link-override").length,
          2,
          "确认 auto 簇应固化 2 条作品"
        );
        assert.ok(
          invokeCalls.some((c) => c.channel === "stats:get-content-summary"),
          "确认后应刷新汇总"
        );

        // 测试拆出失败时 $message.error 报错
        nextInvokeResult = { ok: false, error: "模拟写入失败" };
        await ctx.detachWork({ workKey: "G1|抖音|w1" });
        assert.ok(
          messages.some((x) => x.type === "error" && x.m.includes("模拟写入失败")),
          "操作失败时必须调用 $message.error 报错"
        );
      } finally {
        Module._load = origLoad;
        delete require.cache[bundlePath];
      }

      console.log("✓ dataStats/index.vue 模板编译、标签口径、确认/拆出/报错与刷新逻辑通过");
    }
  } finally {
    if (origElectronCache) require.cache[electronId] = origElectronCache;
    else delete require.cache[electronId];
    if (origStoreCache) require.cache[storeId] = origStoreCache;
    else delete require.cache[storeId];
    if (origIndexCache) require.cache[indexId] = origIndexCache;
    else delete require.cache[indexId];
    if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
    else delete require.cache[collectorId];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log("\ntest-link-overrides: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
