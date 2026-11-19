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
      // S6-fix#8: link-overrides.json 严格校验（version===1 / updatedAt 有限数字 / 坏条目逐条丢弃 / 绝不抛）
      for (const badContent of [
        "{broken json",
        "[]",
        "null",
        '{"version":1,"updatedAt":1000,"overrides":[]}',
        '{"version":2,"updatedAt":1000,"overrides":{"G1|抖音|a":{"action":"detach"}}}',
        '{"version":"1","updatedAt":1000,"overrides":{"G1|抖音|a":{"action":"detach"}}}',
        '{"version":1,"updatedAt":{"toString":null},"overrides":{"G1|抖音|a":{"action":"detach"}}}',
        '{"version":1,"updatedAt":"1000","overrides":{"G1|抖音|a":{"action":"detach"}}}',
        '{"version":1,"updatedAt":null,"overrides":{"G1|抖音|a":{"action":"detach"}}}',
        '{"version":1,"updatedAt":1000,"contents":[],"overrides":{}}',
      ]) {
        fs.writeFileSync(overridesFile, badContent, "utf8");
        const { result: badRes, warnings } = captureWarn(() => store.readLinkOverrides());
        assert.strictEqual(badRes.version, 1);
        assert.strictEqual(badRes.updatedAt, 0);
        assert.deepStrictEqual(Object.keys(badRes.overrides), []);
        assert.deepStrictEqual(Object.keys(badRes.contents), []);
        assert.ok(warnings.some((w) => w.includes("link-overrides.json")), `损坏/非法内容 ${badContent} 应 warn`);
      }

      // 条目结构不对的逐条丢弃，合法条目保留
      fs.writeFileSync(
        overridesFile,
        JSON.stringify({
          version: 1,
          updatedAt: 5000,
          contents: {
            "manual:good1": { title: "有效手工标题", createdAt: 5000 },
            "auto:good2": { title: "有效自动标题", createdAt: 5001 },
            "file:/bad": { title: "非合成键应丢弃", createdAt: 5002 },
            "manual:bad_ts": { title: "非数字时间", createdAt: "5000" },
            "manual:bad_title": { title: 123, createdAt: 5000 },
            "auto:bad_obj": null,
          },
          overrides: {
            "G1|抖音|ok1": { action: "detach" },
            "G1|抖音|ok2": { action: "assign", contentKey: "manual:good1" },
            "G1|抖音|bad_action": { action: "unknown" },
            "G1|抖音|bad_ck_obj": { action: "assign", contentKey: { toString: null } },
            "G1|抖音|bad_ck_unlinked": { action: "assign", contentKey: "unlinked:抖音:1" },
            "G1|抖音|bad_entry": "not-an-object",
          },
        }),
        "utf8"
      );
      const { result: partialRes, warnings: partialWarns } = captureWarn(() => store.readLinkOverrides());
      assert.deepStrictEqual(partialWarns, []);
      assert.strictEqual(partialRes.updatedAt, 5000);
      assert.deepStrictEqual(Object.keys(partialRes.contents).sort(), ["auto:good2", "manual:good1"]);
      assert.deepStrictEqual(Object.keys(partialRes.overrides).sort(), ["G1|抖音|ok1", "G1|抖音|ok2"]);

      fs.rmSync(overridesFile, { force: true });
      fs.mkdirSync(overridesFile);
      const { result: dirRes, warnings: dirWarns } = captureWarn(() => store.readLinkOverrides());
      assert.deepStrictEqual(Object.keys(dirRes.overrides), []);
      assert.ok(dirWarns.some((w) => w.includes("link-overrides.json")), "读失败(EISDIR)应 warn 且不抛");
      fs.rmdirSync(overridesFile);

      console.log("✓ store.js link-overrides 原子读写、严格校验(S6-fix#8)、损坏/读失败视为空+warn 与原型防护通过");
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

      // 2d. S6-fix#4 悬空 manual:/auto:（未在 contents 表注册）必须被忽略
      const danglingLink = linkWorks({
        contents,
        accounts,
        overrides: {
          version: 1,
          updatedAt: 1000,
          contents: {},
          overrides: {
            "G1|抖音|dy_free": { action: "assign", contentKey: "manual:never_created" },
            "G1|抖音|dy_auto": { action: "assign", contentKey: "auto:1111222233334444" },
            "G1|快手|ks_auto": { action: "assign", contentKey: "auto:1111222233334444" },
          },
        },
      });
      assert.deepStrictEqual(
        danglingLink.get("G1|抖音|dy_free"),
        { contentKey: null, matchedBy: null },
        "S6-fix#4: 不在 contents 表的悬空 manual: 键必须被忽略"
      );
      assert.strictEqual(
        danglingLink.get("G1|抖音|dy_auto").contentKey,
        autoKey,
        "S6-fix#4: 两条指向未在 contents 表注册的假 auto: 键必须被忽略并保持自动结果"
      );
      assert.strictEqual(danglingLink.get("G1|抖音|dy_auto").matchedBy, "fuzzy");

      // 2e. 有效 assign + 确认 auto 簇（带 contents 表持久化）+ 手工合并两个未关联作品（manual:*）
      const manualOverrides = {
        version: 1,
        updatedAt: 2000,
        contents: {
          [autoKey]: { title: "周末户外露营必带十件实用装备清单", createdAt: 2000 },
          "manual:custom001": { title: "周末清晨爬山看日出记录", createdAt: 2000 },
        },
        overrides: {
          // 把原本模糊配给 hsr 的作品改合并到 steak
          "G1|抖音|dy_fuzzy": { action: "assign", contentKey: "file:d:/v/steak.mp4" },
          // 把 auto 簇固化为 manual
          "G1|抖音|dy_auto": { action: "assign", contentKey: autoKey },
          "G1|快手|ks_auto": { action: "assign", contentKey: autoKey },
          // 合并两个未关联作品为 manual:*
          "G1|抖音|dy_free": { action: "assign", contentKey: "manual:custom001" },
          "G1|快手|ks_free": { action: "assign", contentKey: "manual:custom001" },
        },
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

      // S6-fix#4: 确认 auto 簇其中一条后拆出另一条，已确认成员仍保留该内容及持久化标题
      const partialConfirmDetach = {
        version: 1,
        updatedAt: 2500,
        contents: {
          [autoKey]: { title: "周末户外露营必带十件实用装备清单", createdAt: 2500 },
        },
        overrides: {
          "G1|抖音|dy_auto": { action: "assign", contentKey: autoKey },
          "G1|快手|ks_auto": { action: "detach" },
        },
      };
      const partialConfirmLink = linkWorks({ contents, accounts, overrides: partialConfirmDetach });
      assert.deepStrictEqual(
        partialConfirmLink.get("G1|抖音|dy_auto"),
        { contentKey: autoKey, matchedBy: "manual" },
        "S6-fix#4: 拆出 auto 簇另一条后，已确认成员仍应保留该 auto: 内容"
      );
      assert.deepStrictEqual(partialConfirmLink.get("G1|快手|ks_auto"), {
        contentKey: null,
        matchedBy: "manual-detach",
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

      // S6-fix#1: 确认/assign 作品照常参与①–④占位，绝不把另一条相似作品吸进同一 target
      {
        const s1Contents = buildContentIndex([
          {
            pt: "抖音",
            group: "G1",
            title: "居家健身核心力量训练完整版教学视频",
            filePath: "D:\\fit\\core.mp4",
            publishStatus: "success",
            date: "2026-11-10",
          },
        ]);
        const s1Accounts = [
          {
            group: "G1",
            platform: "抖音",
            works: [
              // 0.95 截断匹配 target
              {
                workId: "fit_exact",
                title: "居家健身核心力量训练完整版",
                publishTime: dayTs("2026-11-10"),
              },
              // 与 target 相似度 ~0.7x（无集数差异），未确认前因 fit_exact 占位而未关联
              {
                workId: "fit_other",
                title: "居家健身核心力量训练基础教程",
                publishTime: dayTs("2026-11-10"),
              },
            ],
          },
        ];
        const beforeConfirm = linkWorks({ contents: s1Contents, accounts: s1Accounts });
        assert.strictEqual(beforeConfirm.get("G1|抖音|fit_exact").contentKey, "file:d:/fit/core.mp4");
        assert.strictEqual(beforeConfirm.get("G1|抖音|fit_exact").matchedBy, "fuzzy");
        assert.deepStrictEqual(beforeConfirm.get("G1|抖音|fit_other"), {
          contentKey: null,
          matchedBy: null,
        });

        // 确认 fit_exact（assign 到同一 target）后，fit_other 绝不能趁机补占 target
        const afterConfirm = linkWorks({
          contents: s1Contents,
          accounts: s1Accounts,
          overrides: {
            "G1|抖音|fit_exact": { action: "assign", contentKey: "file:d:/fit/core.mp4" },
          },
        });
        assert.deepStrictEqual(afterConfirm.get("G1|抖音|fit_exact"), {
          contentKey: "file:d:/fit/core.mp4",
          matchedBy: "manual",
        });
        assert.deepStrictEqual(
          afterConfirm.get("G1|抖音|fit_other"),
          { contentKey: null, matchedBy: null },
          "S6-fix#1: 确认/assign 作品不得改变其他作品的自动匹配结果，fit_other 必须保持未关联"
        );
      }

      // S6-fix#5: 跨组 file: 键仅对 B 组观测手工 assign 同一键，不得改变既有归组列（指标仍归 A 组列）
      {
        const cgContents = buildContentIndex([
          {
            pt: "抖音",
            group: "组A",
            title: "跨组归组测试视频",
            filePath: "D:\\cg\\same.mp4",
            publishStatus: "success",
            videoLink: "https://www.douyin.com/video/cg1",
            date: "2026-11-10",
          },
          {
            pt: "抖音",
            group: "组B",
            title: "跨组归组测试视频",
            filePath: "D:\\cg\\same.mp4",
            publishStatus: "success",
            videoLink: "https://www.douyin.com/video/cg1",
            date: "2026-11-10",
          },
        ]);
        const cgAccounts = [
          {
            group: "组B",
            platform: "抖音",
            works: [
              {
                workId: "cg1",
                title: "跨组归组测试视频",
                url: "https://www.douyin.com/video/cg1",
                publishTime: dayTs("2026-11-10"),
              },
            ],
          },
          {
            group: "组A",
            platform: "抖音",
            works: [
              {
                workId: "cg1",
                title: "跨组归组测试视频",
                url: "https://www.douyin.com/video/cg1",
                publishTime: dayTs("2026-11-10"),
              },
            ],
          },
        ];
        const cgDaily = {
          "组A|抖音": { cg1: { "2026-11-10": { play: 100 } } },
          "组B|抖音": { cg1: { "2026-11-11": { play: 180 } } },
        };
        const beforeManualCg = buildContentSummaryRows({
          contents: cgContents,
          accounts: cgAccounts,
          worksDaily: cgDaily,
        });
        assert.ok(beforeManualCg[0].perPlatform["抖音|组A"]);
        assert.strictEqual(beforeManualCg[0].perPlatform["抖音|组A"].play, 180);
        assert.strictEqual(beforeManualCg[0].perPlatform["抖音|组B"], undefined);

        const afterManualBCg = buildContentSummaryRows({
          contents: cgContents,
          accounts: cgAccounts,
          worksDaily: cgDaily,
          overrides: {
            "组B|抖音|cg1": { action: "assign", contentKey: "file:d:/cg/same.mp4" },
          },
        });
        assert.ok(
          afterManualBCg[0].perPlatform["抖音|组A"],
          "S6-fix#5: 对 B 组观测手工 assign 同一 file: 键后，指标必须留在既有 抖音|组A 列"
        );
        assert.strictEqual(afterManualBCg[0].perPlatform["抖音|组A"].play, 180);
        assert.strictEqual(
          afterManualBCg[0].perPlatform["抖音|组B"],
          undefined,
          "S6-fix#5: 不得把指标移到 抖音|组B 列"
        );
        assert.strictEqual(afterManualBCg[0].matchMethod, "manual");
        assert.strictEqual(
          afterManualBCg[0].perPlatform["抖音|组A"].works[0].workKey,
          "组B|抖音|cg1",
          "操作用 workKey 应指向持有 override 的真实观测"
        );
      }

      console.log("✓ contentLink.js overrides：assign/detach/merge/clear、S6-fix#1/#4/#5 均通过");
    }

    /* ---------- 3. IPC 安全校验、参数校验、并发串行写不丢写 + 汇总/导出一致性 ---------- */
    {
      registerDataStatsIpc();
      const getOverrides = ipcHandlers.get("stats:get-link-overrides");
      const setOverride = ipcHandlers.get("stats:set-link-override");
      const mergeWorks = ipcHandlers.get("stats:merge-works");
      const clearOverride = ipcHandlers.get("stats:clear-link-override");
      const applyOverrides = ipcHandlers.get("stats:apply-link-overrides");
      const getSummary = ipcHandlers.get("stats:get-content-summary");

      assert.strictEqual(typeof getOverrides, "function");
      assert.strictEqual(typeof setOverride, "function");
      assert.strictEqual(typeof mergeWorks, "function");
      assert.strictEqual(typeof clearOverride, "function");
      assert.strictEqual(typeof applyOverrides, "function");

      const localEv = { sender: {}, senderFrame: { url: "file:///app/index.html" } };

      // 3a. 外部页面拦截
      for (const badUrl of ["https://creator.douyin.com", "http://localhost.evil/", "file://remote/a.html", ""]) {
        const extEv = { sender: {}, senderFrame: { url: badUrl } };
        assert.strictEqual((await getOverrides(extEv)).ok, false);
        assert.strictEqual((await setOverride(extEv, { workKey: "G|抖|1", action: "detach" })).ok, false);
        assert.strictEqual((await mergeWorks(extEv, { workKeys: ["G|抖|1", "G|快|2"] })).ok, false);
        assert.strictEqual((await clearOverride(extEv, { workKey: "G|抖|1" })).ok, false);
        assert.strictEqual(
          (await applyOverrides(extEv, { ops: [{ action: "detach", workKey: "G|抖|1" }] })).ok,
          false
        );
      }

      // 3b. 非法参数与目标不存在拒绝（S6-fix#4 写入时校验目标存在）
      assert.strictEqual((await setOverride(localEv, null)).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "", action: "detach" })).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "G|抖|1", action: "bad" })).ok, false);
      assert.strictEqual((await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "" })).ok, false);
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "unlinked:抖音:1" })).ok,
        false
      );
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "file:/not-exist.mp4" })).ok,
        false,
        "S6-fix#4: 写入不存在的 file: 目标必须拒绝"
      );
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "manual:never_created" })).ok,
        false,
        "S6-fix#4: 写入不在 contents 表的 manual: 目标必须拒绝"
      );
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "auto:deadbeefdeadbeef" })).ok,
        false,
        "S6-fix#4: 写入不存在的 auto: 目标必须拒绝"
      );
      assert.strictEqual(
        (await setOverride(localEv, { workKey: "G|抖|1", action: "assign", contentKey: "record:2026-11-10:pos:0" })).ok,
        false,
        "S6-fix#13: 写入不稳定位置键必须拒绝"
      );
      assert.strictEqual((await mergeWorks(localEv, { workKeys: ["G|抖|1"] })).ok, false);
      assert.strictEqual((await clearOverride(localEv, { workKey: "" })).ok, false);
      assert.strictEqual((await applyOverrides(localEv, { ops: [] })).ok, false);

      // 3c. 并发 Promise.all 串行写入不丢写（先准备合法 file: 目标，同时写 10 条不同 workKey）
      const batchPushFile = path.join(pushDataDir, "2026-11-09.json");
      const batchRecs = [];
      for (let i = 0; i < 10; i++) {
        batchRecs.push({
          id: `batch_r_${i}`,
          pt: "抖音",
          group: "并发组",
          publishStatus: "success",
          title: `并发测试视频_${i}`,
          filePath: `/videos/batch_${i}.mp4`,
          lastPublishAt: dayTs("2026-11-09"),
        });
      }
      fs.writeFileSync(batchPushFile, JSON.stringify(batchRecs), "utf8");

      const concurrentCalls = [];
      for (let i = 0; i < 10; i++) {
        concurrentCalls.push(
          setOverride(localEv, {
            workKey: `并发组|抖音|cw_${i}`,
            action: "assign",
            contentKey: `file:/videos/batch_${i}.mp4`,
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
          { action: "assign", contentKey: `file:/videos/batch_${i}.mp4` },
          `并发写入第 ${i} 条不应丢失`
        );
      }

      // 清理并发测试脏数据
      fs.rmSync(overridesFile, { force: true });
      fs.rmSync(batchPushFile, { force: true });

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

      // 3e. S6-fix#4 端到端：确认 auto 簇单条写入 contents 表，拆出另一条后已确认成员保留；
      //     stats:apply-link-overrides 一次原子写盘，批内有非法 op 时整批回滚不写盘
      store.mergeWorks(
        "主组",
        "抖音",
        [
          {
            workId: "W_AUTO_1",
            title: "高原自驾游必看防高反实用物品清单",
            url: "https://www.douyin.com/video/auto1",
            publishTime: dayTs("2026-11-10"),
            play: 600,
          },
        ],
        dayTs("2026-11-12")
      );
      store.mergeWorks(
        "主组",
        "快手",
        [
          {
            workId: "W_AUTO_2",
            title: "高原自驾游必看防高反实用物品",
            url: "https://www.kuaishou.com/short-video/auto2",
            publishTime: dayTs("2026-11-11"),
            play: 400,
          },
        ],
        dayTs("2026-11-12")
      );
      const beforeAutoSum = await getSummary(localEv, {});
      const autoRow = beforeAutoSum.rows.find(
        (r) => typeof r.contentKey === "string" && r.contentKey.startsWith("auto:")
      );
      assert.ok(autoRow, "W_AUTO_1 与 W_AUTO_2 应自动聚成 auto: 簇");
      const persistedAutoKey = autoRow.contentKey;

      // 批量原子回滚测试：第 1 条合法、第 2 条目标不存在 → 整批拒绝，磁盘字节不变
      const bytesBeforeRollback = fs.readFileSync(overridesFile, "utf8");
      const badBatchRes = await applyOverrides(localEv, {
        ops: [
          { action: "assign", workKey: "主组|抖音|W_AUTO_1", contentKey: persistedAutoKey },
          { action: "assign", workKey: "主组|快手|W_AUTO_2", contentKey: "file:/does/not/exist.mp4" },
        ],
      });
      assert.strictEqual(badBatchRes.ok, false, "S6-fix#4: 批内存在非法目标时必须整批拒绝");
      assert.strictEqual(
        fs.readFileSync(overridesFile, "utf8"),
        bytesBeforeRollback,
        "S6-fix#4: 批量原子写失败不得留下部分确认"
      );

      // 确认其中一条 W_AUTO_1（持久化 auto 身份到 contents 表），再拆出另一条 W_AUTO_2
      const confirmOneRes = await setOverride(localEv, {
        workKey: "主组|抖音|W_AUTO_1",
        action: "assign",
        contentKey: persistedAutoKey,
      });
      assert.strictEqual(confirmOneRes.ok, true);
      const ovAfterConfirmOne = await getOverrides(localEv);
      assert.ok(
        ovAfterConfirmOne.contents && ovAfterConfirmOne.contents[persistedAutoKey],
        "S6-fix#4: 确认 auto 簇必须将 contentKey+标题持久化写入 contents 表"
      );
      assert.strictEqual(
        ovAfterConfirmOne.contents[persistedAutoKey].title,
        "高原自驾游必看防高反实用物品清单"
      );

      const detachOtherRes = await setOverride(localEv, {
        workKey: "主组|快手|W_AUTO_2",
        action: "detach",
      });
      assert.strictEqual(detachOtherRes.ok, true);
      const afterDetachAutoSum = await getSummary(localEv, {});
      const survivingAutoRow = afterDetachAutoSum.rows.find((r) => r.contentKey === persistedAutoKey);
      assert.ok(
        survivingAutoRow,
        "S6-fix#4: 拆出 auto 簇另一条后，已确认成员 W_AUTO_1 必须仍保留在该内容下"
      );
      assert.strictEqual(survivingAutoRow.title, "高原自驾游必看防高反实用物品清单");
      assert.strictEqual(survivingAutoRow.totalPlay, 600);
      assert.strictEqual(survivingAutoRow.matchMethod, "manual");
      assert.ok(
        afterDetachAutoSum.rows.find((r) => r.contentKey === "unlinked:快手:W_AUTO_2"),
        "被拆出的 W_AUTO_2 应变为未关联行"
      );

      // 3f. S6-fix#6 端到端：仅存在于 works-daily（不在 works.json）的两条作品纳入手工覆盖，
      //     且并发合并同一来源在串行队列内复核拒绝
      const dyDailyFile = path.join(
        userDataDir,
        "data-stats",
        "主组",
        "抖音",
        "works-daily",
        "2026-11-12.json"
      );
      const ksDailyFile = path.join(
        userDataDir,
        "data-stats",
        "主组",
        "快手",
        "works-daily",
        "2026-11-12.json"
      );
      const dyDailyDoc = JSON.parse(fs.readFileSync(dyDailyFile, "utf8"));
      dyDailyDoc.works.ONLY_DAILY_1 = { play: 111, like: 11, comment: 1, share: 0, favorite: 2, fansDelta: 0 };
      dyDailyDoc.works.ONLY_DAILY_3 = { play: 333, like: 33, comment: 3, share: 0, favorite: 4, fansDelta: 0 };
      fs.writeFileSync(dyDailyFile, JSON.stringify(dyDailyDoc, null, 2), "utf8");
      const ksDailyDoc = JSON.parse(fs.readFileSync(ksDailyFile, "utf8"));
      ksDailyDoc.works.ONLY_DAILY_2 = { play: 222, like: 22, comment: 2, share: null, favorite: null, fansDelta: null };
      fs.writeFileSync(ksDailyFile, JSON.stringify(ksDailyDoc, null, 2), "utf8");

      // 并发两次合并争抢同一条 ONLY_DAILY_1：仅第一次成功，第二次在串行队列复核时因已关联被拒绝
      const [race1, race2] = await Promise.all([
        applyOverrides(localEv, {
          ops: [{ action: "merge", workKeys: ["主组|抖音|ONLY_DAILY_1", "主组|快手|ONLY_DAILY_2"] }],
        }),
        mergeWorks(localEv, {
          workKeys: ["主组|抖音|ONLY_DAILY_1", "主组|抖音|ONLY_DAILY_3"],
        }),
      ]);
      assert.strictEqual(race1.ok, true, "第一次合并仅存于 works-daily 的未关联作品应成功");
      assert.ok(race1.contentKey && race1.contentKey.startsWith("manual:"));
      assert.strictEqual(
        race2.ok,
        false,
        "S6-fix#6: 串行队列内复核到 ONLY_DAILY_1 已关联，第二次合并必须拒绝"
      );

      const dailyOnlySum = await getSummary(localEv, {});
      const dailyMergedGui = dailyOnlySum.rows.find((r) => r.contentKey === race1.contentKey);
      assert.ok(
        dailyMergedGui,
        "S6-fix#6: 仅存在于 works-daily 的作品手工合并后必须在汇总中生成对应 manual 行"
      );
      assert.strictEqual(dailyMergedGui.totalPlay, 333);
      assert.strictEqual(dailyMergedGui.platformCount, 2);
      assert.strictEqual(dailyMergedGui.matchMethod, "manual");
      assert.strictEqual(
        dailyOnlySum.rows.find((r) => r.contentKey === "unlinked:抖音:ONLY_DAILY_1"),
        undefined
      );

      const dailyOnlyWb = buildStatsWorkbookData({ now: dayTs("2026-11-12") });
      const dailyOnlyS1 = dailyOnlyWb.sheets["作品日明细"]
        .slice(1)
        .find((r) => r[6] === "ONLY_DAILY_1");
      assert.strictEqual(dailyOnlyS1[3], race1.contentKey, "Excel 日明细也应同步仅 works-daily 作品的手工归属");
      assert.strictEqual(dailyOnlyS1[4], "manual");
      const dailyOnlyS2 = dailyOnlyWb.sheets["作品跨平台汇总"]
        .slice(1)
        .find((r) => r[0] === race1.contentKey);
      assert.ok(dailyOnlyS2);
      assert.strictEqual(dailyOnlyS2[6], 333);

      console.log("✓ IPC 安全/参数/并发串行写入 + S6-fix#4/#6/#13 端到端与导出一致性全通过");
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
        // 模拟 Element UI el-table（仅 currentRow 变化时触发 current-change，点击始终触发 row-click）
        let tableCurrentRow = null;
        let setCurrentRowCalls = 0;
        const mockReassignTable = {
          setCurrentRow(row) {
            setCurrentRowCalls++;
            const next = row === undefined ? null : row;
            if (tableCurrentRow !== next) {
              tableCurrentRow = next;
              ctx.onSelectReassignTarget(next);
            }
          },
          simulateUserClickRow(row) {
            if (tableCurrentRow !== row) {
              tableCurrentRow = row;
              ctx.onSelectReassignTarget(row);
            }
            ctx.onClickReassignTarget(row);
          },
        };
        const ctx = {
          ...comp.data(),
          $refs: { reassignTable: mockReassignTable },
          $nextTick: (cb) => cb(),
          $message: {
            success: (m) => messages.push({ type: "success", m }),
            error: (m) => messages.push({ type: "error", m }),
            warning: (m) => messages.push({ type: "warning", m }),
          },
        };
        for (const [k, fn] of Object.entries(comp.methods)) {
          ctx[k] = fn.bind(ctx);
        }
        for (const [k, fn] of Object.entries(comp.computed)) {
          Object.defineProperty(ctx, k, { get: fn.bind(ctx), configurable: true });
        }

        // 测试 rowMatchTagInfo 展示口径
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "link" }).label, "链接");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "title" }).label, "标题");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "fuzzy", matchScore: 0.87 }).label, "模糊 87%");
        assert.strictEqual(ctx.rowMatchTagInfo({ matchMethod: "manual" }).label, "手动");

        // S6-fix#4: 测试确认模糊匹配行（改用 stats:apply-link-overrides 一次原子写盘 + 刷新汇总）
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
        const applyCalls = invokeCalls.filter((c) => c.channel === "stats:apply-link-overrides");
        assert.strictEqual(applyCalls.length, 1, "S6-fix#4: 整行确认应通过 stats:apply-link-overrides 一次写盘");
        assert.strictEqual(applyCalls[0].payload.ops.length, 2, "整行确认应包含 2 条 assign 操作");
        assert.strictEqual(
          invokeCalls.filter((c) => c.channel === "stats:set-link-override").length,
          0,
          "整行确认不得再循环逐条调 stats:set-link-override"
        );
        assert.ok(
          invokeCalls.some((c) => c.channel === "stats:get-content-summary"),
          "确认后应刷新汇总"
        );

        // S6-fix#4: 合并未关联作品也走 stats:apply-link-overrides
        ctx.selectedUnlinkedWorks = [{ workKey: "G1|抖音|u1" }, { workKey: "G1|快手|u2" }];
        await ctx.mergeSelectedUnlinked();
        const mergeApplyCall = invokeCalls.filter((c) => c.channel === "stats:apply-link-overrides")[1];
        assert.ok(mergeApplyCall);
        assert.strictEqual(mergeApplyCall.payload.ops[0].action, "merge");
        assert.deepStrictEqual(mergeApplyCall.payload.ops[0].workKeys, ["G1|抖音|u1", "G1|快手|u2"]);

        // S6-fix#13: 前端合并弹窗过滤掉无法稳定的旧位置键（canAssignTarget=false 或 :pos:N）
        ctx.contentSummaryRows = [
          { contentKey: "file:/v/stable.mp4", title: "稳定内容", isUnlinked: false, canAssignTarget: true },
          { contentKey: "record:2026-11-10:pos:0", title: "不稳定旧位置记录", isUnlinked: false, canAssignTarget: false },
          { contentKey: "unlinked:抖音:u1", title: "未关联", isUnlinked: true, canAssignTarget: false },
        ];
        assert.deepStrictEqual(
          ctx.reassignTargetRows.map((r) => r.contentKey),
          ["file:/v/stable.mp4"],
          "S6-fix#13: 不稳定旧位置键不得显示为合并弹窗可选目标"
        );

        // S6-fix#14: 合并弹窗重开清空表格当前行，再次点击同一高亮行可更新 reassignTargetKey 并提交
        const targetRow = ctx.contentSummaryRows[0];
        ctx.openReassignDialog({ workKey: "G1|抖音|u1", platform: "抖音", group: "G1", title: "作品1" }, null);
        mockReassignTable.simulateUserClickRow(targetRow);
        assert.strictEqual(ctx.reassignTargetKey, "file:/v/stable.mp4");
        assert.strictEqual(tableCurrentRow, targetRow);

        // 取消关闭后重开
        ctx.resetReassignDialog();
        assert.strictEqual(ctx.reassignTargetKey, "");
        assert.strictEqual(tableCurrentRow, null, "S6-fix#14: 弹窗重置必须通过 setCurrentRow() 清空表格当前行");
        assert.ok(setCurrentRowCalls > 0);

        ctx.openReassignDialog({ workKey: "G1|抖音|u1", platform: "抖音", group: "G1", title: "作品1" }, null);
        // 即使表格意外仍停在 targetRow，行点击仍能正确选中并允许提交
        mockReassignTable.simulateUserClickRow(targetRow);
        assert.strictEqual(
          ctx.reassignTargetKey,
          "file:/v/stable.mp4",
          "S6-fix#14: 重开弹窗再次点击同一目标行必须选中并解锁确定按钮"
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

      console.log("✓ dataStats/index.vue 模板编译、批量原子确认/合并(S6-fix#4)、过滤不稳定键(S6-fix#13)与重开弹窗选同行(S6-fix#14)通过");
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
