/**
 * 卡 S15 综合单元测试（不依赖 Electron 运行环境）：
 *
 * 1. 分组统计起点日期（statsStartDate）：
 *    - group-settings.json 无原型字典清洗、坏数据回落、严格读报错、设置/清空持久化
 *    - 首次启动默认值迁移（两分组存在/单分组存在/均不存在/已存在含清空 `{}` 不覆盖，含 accountMigration 入口）
 *    - 全链路过滤：linkWorks / 作品跨平台汇总 / 未关联列表 / 分析 / 日趋势 / 分时段趋势 / Excel 全 sheet（含作品日明细、时段明细）
 *    - 账号级快照（daily.json、账号日快照 sheet、fansTrend、overview）不受影响
 *    - 原始数据不删除；清空起点立即恢复；发布时间缺失不排除；UTC+8 零点边界准确
 * 2. 按发布记录自动关联（record_time，不依赖标题）：
 *    - 同平台同账号（partition/accountKey/phone 归一，兼容改名后 accountPartitions）±3 小时唯一命中（含正好 3h 边界）
 *    - 超 3 小时、仅日期无时分、非 success 状态不触发
 *    - 多候选作品 / 多内容竞争均不关联（交回模糊/手工）
 *    - 手工 overrides 优先不覆盖（assign 占用同内容 target 防误吸、assign 到别处后释放唯一候选）
 *    - detach / excludeAuto 可撤销、clear 可恢复、多次执行幂等
 *    - 跨账号严格隔离不串号（同平台不同账号、同组同平台多账号无单作品标识）
 * 3. 分组改名迁移统计目录（groupMigration + stats:rename-group IPC）：
 *    - works.json（保留 baselineStats/firstSeenAt/closed*，新记录更新指标/标题/链接/updatedAt，lastPositivePlay 取大，altTitles 并集，仅新有加入）
 *    - works-daily/<date> 按作品合并冲突取 updatedAt 新者；works-intraday/<date> 按时段合并冲突取 collectedAt 新者
 *    - daily.json 按日期并集冲突取新；meta.json 取新；group-settings 键同步改名
 *    - 旧目录移入与 data-stats 同级的 data-stats-merged-old/ 备份，不物理删除
 *    - 读失败 / JSON 损坏报错中止且零写盘；采集进行中（collect 锁）拒绝并提示稍后重试
 * 4. UI 模板编译与交互（dataStats/index.vue 与 Sidebar/index.vue）
 *
 * 运行：node scripts/test-stats-s15.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

const { readPushRecords } = require("../src/main/services/dataStats/pushRecords.js");
const {
  RECORD_TIME_WINDOW_MS,
  normalizeGroupStartDates,
  isWorkBeforeGroupStartDate,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
} = require("../src/main/services/dataStats/contentLink.js");
const {
  buildContentSummaryData,
  buildContentTrendData,
  buildContentIntradayData,
  buildStatsAnalysisData,
  buildStatsWorkbookData,
} = require("../src/main/services/dataStats/statsExport.js");
const {
  renameStatsGroup,
  rollbackRenameStatsGroup,
  mergeWorksJsonDocs,
  mergeWorksDailyDocs,
  mergeWorksIntradayDocs,
  mergeDailyDocs,
  mergeMetaDocs,
} = require("../src/main/services/dataStats/groupMigration.js");

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

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const utc8Ms = (isoWithOffset) => Date.parse(isoWithOffset);

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-s15-test-"));
  const userDataDir = path.join(tmpRoot, "userData");
  const docsDir = path.join(tmpRoot, "Documents");
  const pushDataDir = path.join(docsDir, "MatrixMedia", "data", "pushData");
  const accountDataDir = path.join(docsDir, "MatrixMedia", "data", "account");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(pushDataDir, { recursive: true });
  fs.mkdirSync(accountDataDir, { recursive: true });

  const ipcHandlers = new Map();
  let nextCollectPromise = null;
  let collectCalls = 0;

  const electronId = require.resolve("electron");
  const origElectronCache = require.cache[electronId];
  const storeId = require.resolve("../src/main/services/dataStats/store.js");
  const indexId = require.resolve("../src/main/services/dataStats/index.js");
  const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
  const origStoreCache = require.cache[storeId];
  const origIndexCache = require.cache[indexId];
  const origCollectorCache = require.cache[collectorId];

  const localEvent = {
    sender: { send: () => {} },
    senderFrame: { url: "file:///app/index.html" },
  };
  const remoteEvent = {
    sender: { send: () => {} },
    senderFrame: { url: "https://evil.example.com/" },
  };

  try {
    // 注入模拟 electron 与 collector
    require.cache[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: {
        app: {
          getPath: (name) => {
            if (name === "userData") return userDataDir;
            if (name === "documents") return docsDir;
            return tmpRoot;
          },
          getVersion: () => "1.5.0-test",
        },
        ipcMain: {
          handle: (ch, fn) => ipcHandlers.set(ch, fn),
        },
        BrowserWindow: { fromWebContents: () => ({}) },
        dialog: { showSaveDialog: async () => ({ canceled: true }) },
      },
    };
    require.cache[collectorId] = {
      id: collectorId,
      filename: collectorId,
      loaded: true,
      exports: {
        collectAccount: async () => {
          collectCalls += 1;
          if (nextCollectPromise) {
            await nextCollectPromise;
          }
          return { overview: { fans: 100 }, works: [], fansHistory: [] };
        },
      },
    };
    delete require.cache[storeId];
    delete require.cache[indexId];

    const store = require("../src/main/services/dataStats/store.js");
    const { registerDataStatsIpc } = require("../src/main/services/dataStats/index.js");

    /* =====================================================================
     * 1. group-settings.json 持久化、无原型清洗、坏数据回落与首次默认迁移
     * ===================================================================== */
    {
      // 1a. 无原型字典清洗与坏数据过滤
      const dirty = JSON.parse(
        '{"__proto__":"2026-11-01","constructor":"2026-11-02","prototype":"2026-11-03","坏日期":"2026-02-31","非字符":123,"越界":"1800-01-01","人间善恶录":"2026-11-15","赛博老司机":{"statsStartDate":"2026-11-24"}}'
      );
      const cleaned = store.normalizeGroupSettings(dirty);
      assert.strictEqual(Object.getPrototypeOf(cleaned), null, "清洗结果必须为无原型字典");
      assert.strictEqual(cleaned["人间善恶录"], "2026-11-15");
      assert.strictEqual(cleaned["赛博老司机"], "2026-11-24");
      assert.strictEqual(Object.keys(cleaned).length, 2, "非法键与坏日期应全部被剔除");
      assert.strictEqual(({}).polluted, undefined);

      // 1b. 文件不存在 → 返回空无原型字典
      assert.strictEqual(Object.keys(store.readGroupSettings()).length, 0);
      assert.strictEqual(Object.getPrototypeOf(store.readGroupSettings()), null);

      // 1c. 坏 JSON / 结构无效：非 strict 回落空字典并 warn，strict 抛错
      fs.mkdirSync(store.baseDir(), { recursive: true });
      fs.writeFileSync(store.groupSettingsFile(), "{bad-json", "utf8");
      const badRead = captureWarn(() => store.readGroupSettings());
      assert.strictEqual(Object.keys(badRead.result).length, 0);
      assert.ok(badRead.warnings.length >= 1);
      assert.throws(() => store.readGroupSettings({ strict: true }), /JSON 损坏/);

      fs.writeFileSync(store.groupSettingsFile(), '["not","object"]', "utf8");
      const arrRead = captureWarn(() => store.readGroupSettings());
      assert.strictEqual(Object.keys(arrRead.result).length, 0);
      assert.throws(() => store.readGroupSettings({ strict: true }), /结构无效/);
      fs.unlinkSync(store.groupSettingsFile());

      // 1d. 首次启动默认值迁移：均不存在时不写盘
      const mNone = store.migrateDefaultGroupSettings({ existingGroups: ["其它分组"] });
      assert.strictEqual(mNone.migrated, false);
      assert.strictEqual(fs.existsSync(store.groupSettingsFile()), false);

      // 仅存在「人间善恶录」→ 只写这一个
      const mOne = store.migrateDefaultGroupSettings({ existingGroups: ["人间善恶录"] });
      assert.strictEqual(mOne.migrated, true);
      assert.deepStrictEqual({ ...store.readGroupSettings() }, { 人间善恶录: "2026-11-15" });

      // 已存在时绝不覆盖（哪怕此时两个分组都在）
      const mSkip = store.migrateDefaultGroupSettings({
        existingGroups: ["人间善恶录", "赛博老司机"],
      });
      assert.strictEqual(mSkip.migrated, false);
      assert.deepStrictEqual({ ...store.readGroupSettings() }, { 人间善恶录: "2026-11-15" });

      // 删除后两个分组都在 → 写入两个默认值
      fs.unlinkSync(store.groupSettingsFile());
      const mBoth = store.migrateDefaultGroupSettings({
        existingGroups: ["人间善恶录", "赛博老司机", "其他"],
      });
      assert.strictEqual(mBoth.migrated, true);
      assert.deepStrictEqual(
        { ...store.readGroupSettings() },
        { 人间善恶录: "2026-11-15", 赛博老司机: "2026-11-24" }
      );

      // 用户全部清空后 group-settings.json 为 `{}` → 再次启动迁移不得重新写回默认值
      store.setGroupStartDate("人间善恶录", "");
      store.setGroupStartDate("赛博老司机", null);
      assert.strictEqual(fs.existsSync(store.groupSettingsFile()), true);
      assert.deepStrictEqual({ ...store.readGroupSettings() }, {});
      const mAfterClear = store.migrateDefaultGroupSettings({
        existingGroups: ["人间善恶录", "赛博老司机"],
      });
      assert.strictEqual(mAfterClear.migrated, false);
      assert.deepStrictEqual({ ...store.readGroupSettings() }, {});

      // 参数校验：非法日期与原型污染键报错
      assert.throws(() => store.setGroupStartDate("__proto__", "2026-11-15"), /分组名称无效/);
      assert.throws(() => store.setGroupStartDate("人间善恶录", "2026-02-30"), /起点日期无效/);
      fs.unlinkSync(store.groupSettingsFile());

      // 1c-2. 起点设置写入前严格校验（返修 #6）：非 ENOENT 读失败（如 EBUSY）或 JSON 损坏/结构无效时拒绝写入，绝不以空配置覆盖
      store.writeGroupSettings({ 人间善恶录: "2026-11-15" });
      const gsFilePath = store.groupSettingsFile();
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(gsFilePath)) {
          const e = new Error("EBUSY: resource busy or locked");
          e.code = "EBUSY";
          throw e;
        }
        return origReadFileSync.call(this, p, ...rest);
      };
      try {
        assert.throws(
          () => store.setGroupStartDate("赛博老司机", "2026-11-24"),
          /EBUSY/,
          "读 group-settings.json 报 EBUSY 时必须拒绝写入并抛错"
        );
      } finally {
        fs.readFileSync = origReadFileSync;
      }
      assert.deepStrictEqual(
        { ...store.readGroupSettings() },
        { 人间善恶录: "2026-11-15" },
        "EBUSY 拒绝写入后，原有「人间善恶录」起点设置必须完好无损"
      );

      // JSON 损坏时 setGroupStartDate 拒绝写入、不覆盖原文件
      fs.writeFileSync(gsFilePath, "{corrupt-settings", "utf8");
      assert.throws(
        () => store.setGroupStartDate("赛博老司机", "2026-11-24"),
        /JSON 损坏/,
        "group-settings.json 解析失败时必须拒绝写入并抛错"
      );
      assert.strictEqual(
        fs.readFileSync(gsFilePath, "utf8"),
        "{corrupt-settings",
        "解析失败拒绝写入后不得覆盖原文件"
      );

      // 结构无效（数组）时 setGroupStartDate 拒绝写入、不覆盖原文件
      fs.writeFileSync(gsFilePath, '["bad-schema"]', "utf8");
      assert.throws(
        () => store.setGroupStartDate("赛博老司机", "2026-11-24"),
        /结构无效/,
        "group-settings.json 结构无效时必须拒绝写入并抛错"
      );
      assert.strictEqual(fs.readFileSync(gsFilePath, "utf8"), '["bad-schema"]');

      // ENOENT 时允许正常创建写入
      fs.unlinkSync(gsFilePath);
      store.setGroupStartDate("赛博老司机", "2026-11-24");
      assert.deepStrictEqual({ ...store.readGroupSettings() }, { 赛博老司机: "2026-11-24" });
      fs.unlinkSync(gsFilePath);

      // 1e. accountMigration.js 首次启动默认迁移 + 带连字符新分组名不被截回（返修 #2）
      // 准备统计目录：
      // - 赛博老司机-科普：当前存在的带连字符分组名，一律不动
      // - AI-效率组：当前存在的带连字符分组名（accountName 与 group 同名），一律不动
      // - 主号组-皇汉科技AI：历史 phone 全值目录（账号 group="主号组"），应归并到 主号组
      // - 已删组-留档：不属于任何历史账号 phone 的孤立带连字符目录，不动
      const statsRootForAccMig = path.join(userDataDir, "data-stats");
      writeJsonFile(path.join(statsRootForAccMig, "赛博老司机-科普", "视频号", "works.json"), {
        works: [{ workId: "hyphen_keep_1", title: "科普视频", play: 88 }],
      });
      writeJsonFile(path.join(statsRootForAccMig, "AI-效率组", "抖音", "works.json"), {
        works: [{ workId: "hyphen_keep_2", title: "效率工具", play: 66 }],
      });
      writeJsonFile(path.join(statsRootForAccMig, "主号组-皇汉科技AI", "抖音", "works.json"), {
        works: [{ workId: "legacy_phone_dir", title: "历史目录作品", play: 99 }],
      });
      writeJsonFile(path.join(statsRootForAccMig, "已删组-留档", "抖音", "works.json"), {
        works: [{ workId: "orphan_hyphen", title: "孤立目录作品", play: 11 }],
      });

      const migBundlePath = path.join(tmpRoot, "accountMigration.cjs");
      await build({
        entryPoints: [path.join(__dirname, "../src/main/services/accountMigration.js")],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: migBundlePath,
        plugins: [
          {
            name: "stub-server-utils",
            setup(b) {
              b.onResolve({ filter: /server\/utils\.js$/ }, () => ({
                path: "stub-utils",
                namespace: "stub-utils",
              }));
              b.onLoad({ filter: /.*/, namespace: "stub-utils" }, () => ({
                contents: `
                  module.exports = {
                    changeData: ({ type }) => {
                      if (type === "get") {
                        return {
                          success: true,
                          data: {
                            "2026-11-20": [
                              { id: 1, date: "2026-11-20", phone: "人间善恶录-主号", pt: "抖音", group: "人间善恶录", accountName: "主号", accountKey: "acc_ren" },
                              { id: 2, date: "2026-11-20", phone: "赛博老司机-主号", pt: "小红书", group: "赛博老司机", accountName: "主号", accountKey: "acc_sai" },
                              { id: 3, date: "2026-11-20", phone: "赛博老司机-科普-老司机", pt: "视频号", group: "赛博老司机-科普", accountName: "老司机", accountKey: "acc_sai" },
                              { id: 4, date: "2026-11-20", phone: "AI-效率组", pt: "抖音", group: "AI-效率组", accountName: "AI-效率组", accountKey: "AI效率组" },
                              { id: 5, date: "2026-11-20", phone: "主号组-皇汉科技AI", pt: "抖音" },
                            ],
                          },
                        };
                      }
                      return { success: true };
                    },
                  };
                `,
                loader: "js",
              }));
            },
          },
        ],
      });
      const origMigLoad = Module._load;
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return require.cache[electronId].exports;
        }
        return origMigLoad.call(this, request, ...rest);
      };
      try {
        const accMigMod = require(migBundlePath);
        accMigMod.ensureAccountRecordsMigrated();
      } finally {
        Module._load = origMigLoad;
      }
      assert.deepStrictEqual(
        { ...store.readGroupSettings() },
        { 人间善恶录: "2026-11-15", 赛博老司机: "2026-11-24" },
        "accountMigration 首次迁移应自动写入默认分组起点日期"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "赛博老司机-科普", "视频号", "works.json")),
        true,
        "当前存在的带连字符分组「赛博老司机-科普」统计目录绝不可被截回「赛博老司机」"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "赛博老司机")),
        false,
        "不得将「赛博老司机-科普」截回生成「赛博老司机」目录"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "AI-效率组", "抖音", "works.json")),
        true,
        "当前存在的带连字符分组「AI-效率组」统计目录必须原样保留"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "AI")),
        false,
        "不得将「AI-效率组」截回生成「AI」目录"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "已删组-留档", "抖音", "works.json")),
        true,
        "非历史账号 phone 全值的孤立带连字符目录不得误迁"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "主号组", "抖音", "works.json")),
        true,
        "历史 phone 全值目录「主号组-皇汉科技AI」应正常归并到「主号组」"
      );
      assert.strictEqual(
        fs.existsSync(path.join(statsRootForAccMig, "主号组-皇汉科技AI")),
        false
      );
      // 清理 accountMigration 测试目录，避免影响后续测试统计扫描
      for (const d of ["赛博老司机-科普", "AI-效率组", "主号组", "已删组-留档"]) {
        fs.rmSync(path.join(statsRootForAccMig, d), { recursive: true, force: true });
      }
      fs.unlinkSync(store.groupSettingsFile());
      console.log("✓ 1. group-settings 严格读保护、默认迁移与带连字符分组启动迁移保护通过");
    }

    /* =====================================================================
     * 2. 分组统计起点日期全链路过滤（汇总/未关联/分析/趋势/时段/Excel/账号快照不受影响/清空恢复/缺时间不排除）
     * ===================================================================== */
    {
      // UTC+8 边界：2026-11-14 23:59:59+08:00 排除；2026-11-15 00:00:00+08:00 保留
      assert.strictEqual(
        isWorkBeforeGroupStartDate({ publishTime: utc8Ms("2026-11-14T23:59:59+08:00") }, "2026-11-15"),
        true
      );
      assert.strictEqual(
        isWorkBeforeGroupStartDate({ publishTime: utc8Ms("2026-11-15T00:00:00+08:00") }, "2026-11-15"),
        false
      );
      assert.strictEqual(
        isWorkBeforeGroupStartDate({ publishTime: null }, "2026-11-15"),
        false,
        "缺发布时间不得排除"
      );
      assert.strictEqual(
        isWorkBeforeGroupStartDate({ publishTime: "" }, "2026-11-15"),
        false,
        "空发布时间不得排除"
      );
      assert.strictEqual(normalizeGroupStartDates({ __proto__: "2026-11-01" }).size, 0);

      // 构造真机结构测试集：人间善恶录（起点 2026-11-15）有老作品、边界新作品、缺时间作品；赛博老司机（起点 2026-11-24）有旧作品
      const accountsMock = [
        { group: "人间善恶录", platform: "抖音", partition: "persist:acc_ren抖音" },
        { group: "人间善恶录", platform: "快手", partition: "persist:acc_ren快手" },
        { group: "赛博老司机", platform: "小红书", partition: "persist:acc_sai小红书" },
      ];
      const worksByGp = {
        "人间善恶录|抖音": {
          works: [
            // 起点前老作品（UTC+8 2026-11-14 23:59:59）
            {
              workId: "dy_old",
              title: "2024年去海南的机票记录",
              url: "https://www.douyin.com/video/old1",
              publishTime: utc8Ms("2026-11-14T23:59:59+08:00"),
              play: 9000,
              like: 300,
              comment: 10,
            },
            // 起点当天零点作品（UTC+8 2026-11-15 00:00:00）
            {
              workId: "dy_new",
              title: "善恶故事第一集正式版",
              url: "https://www.douyin.com/video/new1",
              publishTime: utc8Ms("2026-11-15T00:00:00+08:00"),
              play: 1500,
              like: 120,
              comment: 20,
              share: 5,
              favorite: 30,
              fansDelta: 12,
            },
            // 发布时间缺失作品 → 不排除
            {
              workId: "dy_notime",
              title: "缺失发布时间的保留作品",
              url: "https://www.douyin.com/video/notime1",
              publishTime: null,
              play: 500,
              like: 20,
            },
          ],
        },
        "人间善恶录|快手": {
          works: [
            // 起点前同题老作品（若未排除则会与 dy_old 自动聚类）
            {
              workId: "ks_old",
              title: "2024年去海南的机票记录",
              url: "https://www.kuaishou.com/short-video/old1",
              publishTime: utc8Ms("2026-11-10T10:00:00+08:00"),
              play: 8000,
              like: 200,
            },
            // 起点后新作品
            {
              workId: "ks_new",
              title: "善恶故事第一集正式版",
              url: "https://www.kuaishou.com/short-video/new1",
              publishTime: utc8Ms("2026-11-15T01:00:00+08:00"),
              play: 2000,
              like: 150,
              comment: 18,
            },
          ],
        },
        "赛博老司机|小红书": {
          works: [
            {
              workId: "xhs_old",
              title: "隐藏的旧民间故事",
              url: "https://www.xiaohongshu.com/explore/oldxhs",
              publishTime: utc8Ms("2026-11-23T18:00:00+08:00"),
              play: 4000,
              like: 80,
            },
            {
              workId: "xhs_new",
              title: "赛博新车测评第一期",
              url: "https://www.xiaohongshu.com/explore/newxhs",
              publishTime: utc8Ms("2026-11-24T09:00:00+08:00"),
              play: 1200,
              like: 90,
            },
          ],
        },
      };
      const worksDailyByGp = {
        "人间善恶录|抖音": {
          dy_old: {
            "2026-11-23": { play: 8500, like: 280, comment: 9, share: 0, favorite: 0, fansDelta: 0 },
            "2026-11-24": { play: 9000, like: 300, comment: 10, share: 0, favorite: 0, fansDelta: 0 },
          },
          dy_new: {
            "2026-11-23": { play: 1000, like: 80, comment: 10, share: 3, favorite: 20, fansDelta: 8 },
            "2026-11-24": { play: 1500, like: 120, comment: 20, share: 5, favorite: 30, fansDelta: 12 },
          },
          dy_notime: {
            "2026-11-23": { play: 400, like: 15, comment: 2, share: 0, favorite: 0, fansDelta: 0 },
            "2026-11-24": { play: 500, like: 20, comment: 3, share: 0, favorite: 0, fansDelta: 0 },
          },
        },
        "人间善恶录|快手": {
          ks_old: {
            "2026-11-23": { play: 7500, like: 190, comment: 5, share: null, favorite: null, fansDelta: null },
            "2026-11-24": { play: 8000, like: 200, comment: 6, share: null, favorite: null, fansDelta: null },
          },
          ks_new: {
            "2026-11-23": { play: 1500, like: 100, comment: 10, share: null, favorite: null, fansDelta: null },
            "2026-11-24": { play: 2000, like: 150, comment: 18, share: null, favorite: null, fansDelta: null },
          },
        },
        "赛博老司机|小红书": {
          xhs_old: {
            "2026-11-23": { play: 3900, like: 75, comment: 4, share: 1, favorite: 5, fansDelta: null },
            "2026-11-24": { play: 4000, like: 80, comment: 5, share: 1, favorite: 5, fansDelta: null },
          },
          xhs_new: {
            "2026-11-24": { play: 1200, like: 90, comment: 12, share: 6, favorite: 40, fansDelta: null },
          },
        },
      };
      const worksIntradayByGp = {
        "人间善恶录|抖音": {
          dy_old: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 9000, like: 300 },
          ],
          dy_new: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 1300, like: 100 },
            { date: "2026-11-24", slot: "14:00", collectedAt: utc8Ms("2026-11-24T14:00:00+08:00"), play: 1500, like: 120 },
          ],
          dy_notime: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 500, like: 20 },
          ],
        },
        "人间善恶录|快手": {
          ks_old: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 8000, like: 200 },
          ],
          ks_new: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 2000, like: 150 },
          ],
        },
        "赛博老司机|小红书": {
          xhs_old: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 4000, like: 80 },
          ],
          xhs_new: [
            { date: "2026-11-24", slot: "10:00", collectedAt: utc8Ms("2026-11-24T10:00:00+08:00"), play: 1200, like: 90 },
          ],
        },
      };
      // 账号级快照包含起点前历史（11-10）与起点后（11-23/11-24）→ 必须全部保留！
      const accountDailyByGp = {
        "人间善恶录|抖音": {
          "2026-11-10": { fans: 1000, plays: 50000, likes: 2000 },
          "2026-11-23": { fans: 1200, plays: 60000, likes: 2400 },
          "2026-11-24": { fans: 1250, plays: 62000, likes: 2500 },
        },
        "人间善恶录|快手": {
          "2026-11-10": { fans: 800, plays: 30000, likes: 900 },
          "2026-11-24": { fans: 950, plays: 35000, likes: 1100 },
        },
        "赛博老司机|小红书": {
          "2026-11-10": { fans: 500, plays: 12000, likes: 400 },
          "2026-11-24": { fans: 560, plays: 15000, likes: 520 },
        },
      };
      const pushRecordsMock = [
        {
          pt: "抖音",
          group: "人间善恶录",
          partition: "persist:acc_ren抖音",
          title: "老记录",
          filePath: "D:/videos/old.mp4",
          publishStatus: "success",
          date: "2026-11-10",
          lastPublishAt: utc8Ms("2026-11-10T10:00:00+08:00"),
        },
        {
          pt: "抖音",
          group: "人间善恶录",
          partition: "persist:acc_ren抖音",
          title: "善恶故事第一集正式版",
          filePath: "D:/videos/ep1.mp4",
          publishStatus: "success",
          date: "2026-11-15",
          lastPublishAt: utc8Ms("2026-11-15T00:05:00+08:00"),
        },
        {
          pt: "快手",
          group: "人间善恶录",
          partition: "persist:acc_ren快手",
          title: "善恶故事第一集正式版",
          filePath: "D:/videos/ep1.mp4",
          publishStatus: "success",
          date: "2026-11-15",
          lastPublishAt: utc8Ms("2026-11-15T01:05:00+08:00"),
        },
      ];

      let activeGroupSettings = {
        人间善恶录: "2026-11-15",
        赛博老司机: "2026-11-24",
      };
      const mockDeps = {
        listAccounts: () => accountsMock,
        readWorks: (g, p) => worksByGp[`${g}|${p}`] || { works: [] },
        readWorksDaily: (g, p) => worksDailyByGp[`${g}|${p}`] || {},
        readWorksIntraday: (g, p) => worksIntradayByGp[`${g}|${p}`] || {},
        readDaily: (g, p) => accountDailyByGp[`${g}|${p}`] || {},
        readPushRecords: () => pushRecordsMock,
        readGroupSettings: () => activeGroupSettings,
        now: utc8Ms("2026-11-24T18:00:00+08:00"),
      };

      // 2a. linkWorks 不把起点前作品纳入返回 Map，也不参与自动聚类
      const contentsForLink = buildContentIndex(pushRecordsMock);
      const linkWithStart = linkWorks({
        contents: contentsForLink,
        accounts: accountsMock.map((a) => ({
          ...a,
          works: worksByGp[`${a.group}|${a.platform}`].works,
        })),
        worksDaily: worksDailyByGp,
        groupSettings: activeGroupSettings,
      });
      assert.strictEqual(linkWithStart.has("人间善恶录|抖音|dy_old"), false, "起点前作品不参与 linkWorks");
      assert.strictEqual(linkWithStart.has("人间善恶录|快手|ks_old"), false, "起点前作品不参与 linkWorks");
      assert.strictEqual(linkWithStart.has("赛博老司机|小红书|xhs_old"), false);
      assert.strictEqual(linkWithStart.get("人间善恶录|抖音|dy_new").contentKey, "file:d:/videos/ep1.mp4");
      assert.strictEqual(linkWithStart.has("人间善恶录|抖音|dy_notime"), true, "缺发布时间作品保留");

      // 2b. 作品跨平台汇总与待关联列表排除起点前作品，且给出排除计数
      const summaryFiltered = buildContentSummaryData({ date: "2026-11-24" }, mockDeps);
      assert.strictEqual(summaryFiltered.excludedBeforeStartCount, 3, "应排除 3 条起点前作品（dy_old/ks_old/xhs_old）");
      assert.deepStrictEqual(summaryFiltered.excludedBeforeStartByGroup, {
        人间善恶录: 2,
        赛博老司机: 1,
      });
      const summaryWorkIds = new Set();
      for (const r of summaryFiltered.rows) {
        assert.notStrictEqual(r.contentKey, "file:d:/videos/old.mp4", "起点前发布记录不得留空行");
        for (const cell of Object.values(r.perPlatform || {})) {
          for (const wid of cell.workIds || []) summaryWorkIds.add(wid);
        }
      }
      assert.deepStrictEqual(
        [...summaryWorkIds].sort(),
        ["dy_new", "dy_notime", "ks_new", "xhs_new"],
        "汇总应保留起点当天、起点后、缺发布时间作品，排除全部起点前作品"
      );
      const unlinkedIds = summaryFiltered.rows
        .filter((r) => r.isUnlinked)
        .flatMap((r) => Object.values(r.perPlatform).flatMap((c) => c.workIds));
      assert.deepStrictEqual(
        unlinkedIds.sort(),
        ["dy_notime", "xhs_new"],
        "待关联/未关联列表不得出现起点前老作品"
      );

      // 2c. 数据分析排除起点前作品，但账号日快照（粉丝趋势与账号涨粉）不受影响
      const analysisFiltered = buildStatsAnalysisData({ period: 30, to: "2026-11-24" }, mockDeps);
      const rankKeys = [
        ...(analysisFiltered.rankings.byPlay.top || []),
        ...(analysisFiltered.rankings.byPlay.bottom || []),
      ].map((x) => x.contentKey);
      assert.strictEqual(rankKeys.some((k) => k.includes("old")), false, "分析排行不得包含起点前作品");
      // 播放日增：dy_new(500) + dy_notime(100) + ks_new(500) = 1100（绝不含 dy_old 500、ks_old 500、xhs_old 100）
      assert.strictEqual(
        analysisFiltered.overview.metrics.play.current,
        1100,
        "分析总览播放日增应排除全部起点前作品"
      );
      // 账号粉丝趋势仍保留 2026-11-10（早于分组起点 2026-11-15）的账号级快照！
      assert.ok(
        analysisFiltered.fansTrend.dates.includes("2026-11-10"),
        "账号粉丝趋势不得受作品统计起点日期影响"
      );

      // 2d. 趋势与分时段趋势：起点前作品不可见，起点后作品正常
      const oldTrend = buildContentTrendData(
        { contentKey: "unlinked:抖音:dy_old", to: "2026-11-24" },
        mockDeps
      );
      assert.strictEqual(oldTrend.found, false, "起点前作品趋势应被排除");
      const oldIntraday = buildContentIntradayData(
        { contentKey: "unlinked:抖音:dy_old", to: "2026-11-24" },
        mockDeps
      );
      assert.strictEqual(oldIntraday.found, false, "起点前作品分时段趋势应被排除");
      const newTrend = buildContentTrendData(
        { contentKey: "file:d:/videos/ep1.mp4", to: "2026-11-24" },
        mockDeps
      );
      assert.strictEqual(newTrend.found, true);

      // 2e. Excel 导出各 sheet 校验
      const wbFiltered = buildStatsWorkbookData(
        { from: "2026-11-01", to: "2026-11-24" },
        mockDeps
      );
      const wdRows = wbFiltered.sheets["作品日明细"].slice(1);
      const wiRows = wbFiltered.sheets["作品时段明细"].slice(1);
      const sumRows = wbFiltered.sheets["作品跨平台汇总"].slice(1);
      const accDailyRows = wbFiltered.sheets["账号日快照"].slice(1);
      assert.strictEqual(
        wdRows.some((r) => ["dy_old", "ks_old", "xhs_old"].includes(r[6])),
        false,
        "作品日明细 sheet 不得包含起点前作品"
      );
      assert.strictEqual(
        wdRows.some((r) => r[6] === "dy_notime"),
        true,
        "作品日明细 sheet 必须保留缺发布时间作品"
      );
      assert.strictEqual(
        wiRows.some((r) => ["dy_old", "ks_old", "xhs_old"].includes(r[7])),
        false,
        "作品时段明细 sheet 不得包含起点前作品"
      );
      assert.strictEqual(
        sumRows.some((r) => String(r[0] || "").includes("old")),
        false,
        "作品跨平台汇总 sheet 不得包含起点前作品"
      );
      // 账号日快照 sheet 必须保留 2026-11-10（早于起点日期）的全部 3 条账号记录！
      const accDates1110 = accDailyRows.filter((r) => r[0] === "2026-11-10");
      assert.strictEqual(
        accDates1110.length,
        3,
        "账号日快照 sheet 不受分组统计起点日期影响，应保留全部 11-10 历史快照"
      );

      // 2f. 清空起点日期 → 原先排除的作品全部恢复（且原始数据从未删除）
      activeGroupSettings = {};
      const summaryRestored = buildContentSummaryData({ date: "2026-11-24" }, mockDeps);
      assert.strictEqual(summaryRestored.excludedBeforeStartCount, 0);
      const restoredWorkIds = new Set();
      for (const r of summaryRestored.rows) {
        for (const cell of Object.values(r.perPlatform || {})) {
          for (const wid of cell.workIds || []) restoredWorkIds.add(wid);
        }
      }
      assert.deepStrictEqual(
        [...restoredWorkIds].sort(),
        ["dy_new", "dy_notime", "dy_old", "ks_new", "ks_old", "xhs_new", "xhs_old"],
        "清空起点日期后全部 7 条作品均应恢复"
      );

      // 2g. 返修 #3：旧作品下架导致账号总播放真实下降（50000 -> 0）时，设置统计起点不得误报账号异常或留空导出
      {
        const dropGroup = "人间善恶录";
        const dropPlatform = "快手";
        const day1 = "2026-11-20";
        const day2 = "2026-11-21";
        const dropDeps = {
          listAccounts: () => [{ group: dropGroup, platform: dropPlatform }],
          readDaily: () => ({
            [day1]: { fans: 100, plays: 50000 },
            [day2]: { fans: 100, plays: 0 },
          }),
          readWorks: () => ({
            works: [
              {
                workId: "delisted_old",
                title: "起点前下架旧作品",
                publishTime: utc8Ms("2026-11-14T12:00:00+08:00"),
                play: 50000,
              },
              {
                workId: "recent_zero",
                title: "起点后在架零播放作品",
                publishTime: utc8Ms("2026-11-20T09:00:00+08:00"),
                play: 0,
              },
            ],
          }),
          readWorksDaily: () => ({
            delisted_old: { [day1]: { play: 50000 } },
            recent_zero: { [day1]: { play: 0 }, [day2]: { play: 0 } },
          }),
          readWorksIntraday: () => ({}),
          readPushRecords: () => [],
          readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
          now: utc8Ms("2026-11-24T12:00:00+08:00"),
        };

        const wbNoStart = buildStatsWorkbookData({ from: day1, to: day2 }, dropDeps);
        const wbWithStart = buildStatsWorkbookData(
          { from: day1, to: day2, groupSettings: { [dropGroup]: "2026-11-15" } },
          dropDeps
        );
        const snapNoStart = wbNoStart.sheets["账号日快照"].slice(1);
        const snapWithStart = wbWithStart.sheets["账号日快照"].slice(1);
        assert.deepStrictEqual(
          snapWithStart,
          snapNoStart,
          "设置统计起点后，账号日快照 sheet 口径必须与未设起点完全一致"
        );
        const day2Row = snapWithStart.find((r) => r[0] === day2);
        assert.ok(day2Row);
        assert.strictEqual(day2Row[4], 0, "旧作品下架真实降为 0 时，账号总播放必须显示 0");
        assert.strictEqual(day2Row[10], -50000, "旧作品下架真实下降时，账号播放日增必须显示 -50000");
        assert.strictEqual(day2Row[11], null, "旧作品下架真实下降不得写出异常备注");

        // 作品级导出仍按起点排除 delisted_old
        const wdWithStart = wbWithStart.sheets["作品日明细"].slice(1);
        assert.strictEqual(
          wdWithStart.some((r) => r[6] === "delisted_old"),
          false,
          "作品日明细仍应排除起点前下架作品"
        );
        assert.strictEqual(
          wdWithStart.some((r) => r[6] === "recent_zero"),
          true,
          "作品日明细应保留起点后作品"
        );

        // GUI 数据分析同样不误报账号异常且保留真实账号播放日增
        const guiAnalysisDrop = buildStatsAnalysisData(
          { period: 2, to: day2, groupSettings: { [dropGroup]: "2026-11-15" } },
          dropDeps
        );
        const accAnoms = guiAnalysisDrop.anomalies.collectionAnomalies.filter(
          (a) => a.scope === "account"
        );
        assert.strictEqual(accAnoms.length, 0, "旧作品下架导致账号总播放真实下降不得误报账号异常");
        assert.strictEqual(guiAnalysisDrop.overview.accountSummary.playsDelta.current, -50000);
      }
      console.log("✓ 2. 分组统计起点日期全链路过滤、账号口径豁免（含旧作品下架真实下降）、缺时间保留与清空恢复通过");
    }

    /* =====================================================================
     * 3. 按发布记录自动关联（record_time，不依赖标题）
     * ===================================================================== */
    {
      assert.strictEqual(RECORD_TIME_WINDOW_MS, 3 * 3600 * 1000);
      const baseT = utc8Ms("2026-11-20T12:00:00+08:00");

      // 3a. pushRecords.js 保留 partition 与 accountKey 字段
      writeJsonFile(path.join(pushDataDir, "2026-11-20.json"), [
        {
          id: "rec_rt_1",
          pt: "抖音",
          group: "人间善恶录",
          phone: "acc_ren-主号",
          partition: "persist:acc_ren抖音",
          accountKey: "acc_ren",
          title: "完全不同的发布记录标题A",
          filePath: "D:\\videos\\story_01.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
      ]);
      const parsedPush = readPushRecords({ dir: pushDataDir });
      assert.strictEqual(parsedPush[0].partition, "persist:acc_ren抖音");
      assert.strictEqual(parsedPush[0].accountKey, "acc_ren");

      // 3b. 唯一命中（含不同平台完全不同标题 + 恰好 3 小时整边界 + 改名后凭 accountPartitions 仍命中）
      const rtContents = buildContentIndex([
        {
          id: "rt_dy",
          pt: "抖音",
          group: "旧分组名",
          partition: "persist:acc_ren抖音",
          title: "记录标题一：古村奇案",
          filePath: "D:\\videos\\story_01.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        {
          id: "rt_ks",
          pt: "快手",
          group: "人间善恶录",
          accountKey: "acc_ren",
          title: "记录标题二：古村奇案",
          filePath: "D:\\videos\\story_01.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        {
          id: "rt_tt_edge",
          pt: "头条",
          group: "人间善恶录",
          phone: "acc_ren-头条号",
          title: "记录标题三：古村奇案",
          filePath: "D:\\videos\\story_01.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        // 超过 3 小时（+1秒）→ 不命中
        {
          id: "rt_over",
          pt: "视频号",
          group: "人间善恶录",
          partition: "persist:acc_ren视频号",
          title: "记录标题四：超窗测试",
          filePath: "D:\\videos\\story_over.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        // 非 success 状态 → 不命中
        {
          id: "rt_fail",
          pt: "哔哩哔哩",
          group: "赛博老司机",
          partition: "persist:acc_sai哔哩哔哩",
          title: "失败记录",
          filePath: "D:\\videos\\story_fail.mp4",
          publishStatus: "failed",
          lastPublishAt: baseT,
        },
      ]);
      const rtAccounts = [
        {
          // 即使分组已改名为「人间善恶录」，凭 accountPartitions 归一后仍能命中旧分组发布记录！
          group: "人间善恶录",
          platform: "抖音",
          accountPartitions: ["persist:acc_ren抖音"],
          works: [
            {
              workId: "w_dy_1",
              title: "村口老槐树下发生怪事",
              publishTime: baseT + 45 * 60 * 1000, // +45 分钟
            },
          ],
        },
        {
          group: "人间善恶录",
          platform: "快手",
          accountKey: "acc_ren",
          works: [
            {
              workId: "w_ks_1",
              title: "凌晨三点谁在敲门",
              publishTime: baseT - 2 * 3600 * 1000, // -2 小时
            },
          ],
        },
        {
          group: "人间善恶录",
          platform: "头条",
          phone: "acc_ren-任意后缀",
          works: [
            {
              workId: "w_tt_1",
              title: "深夜山村无人应答的红灯笼",
              publishTime: baseT + RECORD_TIME_WINDOW_MS, // 正好 +3 小时边界
            },
          ],
        },
        {
          group: "人间善恶录",
          platform: "视频号",
          partition: "persist:acc_ren视频号",
          works: [
            {
              workId: "w_sph_over",
              title: "完全不同的视频号标题",
              publishTime: baseT + RECORD_TIME_WINDOW_MS + 1000, // +3h 1s 超窗
            },
          ],
        },
        {
          group: "赛博老司机",
          platform: "哔哩哔哩",
          partition: "persist:acc_sai哔哩哔哩",
          works: [
            {
              workId: "w_bili_fail",
              title: "完全不同的B站标题",
              publishTime: baseT + 60 * 1000,
            },
          ],
        },
      ];

      const rtLink1 = linkWorks({ contents: rtContents, accounts: rtAccounts });
      const rtLink2 = linkWorks({ contents: rtContents, accounts: rtAccounts });
      assert.deepStrictEqual(rtLink1.get("人间善恶录|抖音|w_dy_1"), {
        contentKey: "file:d:/videos/story_01.mp4",
        matchedBy: "record_time",
      });
      assert.deepStrictEqual(rtLink1.get("人间善恶录|快手|w_ks_1"), {
        contentKey: "file:d:/videos/story_01.mp4",
        matchedBy: "record_time",
      });
      assert.deepStrictEqual(rtLink1.get("人间善恶录|头条|w_tt_1"), {
        contentKey: "file:d:/videos/story_01.mp4",
        matchedBy: "record_time",
      });
      assert.deepStrictEqual(rtLink1.get("人间善恶录|视频号|w_sph_over"), {
        contentKey: null,
        matchedBy: null,
      });
      assert.deepStrictEqual(rtLink1.get("赛博老司机|哔哩哔哩|w_bili_fail"), {
        contentKey: null,
        matchedBy: null,
      });
      // 幂等性校验
      assert.deepStrictEqual([...rtLink1.entries()], [...rtLink2.entries()], "record_time 必须幂等");

      // 汇总 matchMethod 与 Excel 导出均正确标出 record_time
      const rtDaily = {
        "人间善恶录|抖音": { w_dy_1: { "2026-11-20": { play: 300, like: 10 } } },
        "人间善恶录|快手": { w_ks_1: { "2026-11-20": { play: 500, like: 20 } } },
        "人间善恶录|头条": { w_tt_1: { "2026-11-20": { play: 200, like: 5 } } },
      };
      const rtSummary = buildContentSummaryRows({
        contents: rtContents,
        accounts: rtAccounts,
        link: rtLink1,
        worksDaily: rtDaily,
      });
      const storyRow = rtSummary.find((r) => r.contentKey === "file:d:/videos/story_01.mp4");
      assert.ok(storyRow);
      assert.strictEqual(storyRow.platformCount, 3);
      assert.strictEqual(storyRow.totalPlay, 1000);
      assert.strictEqual(storyRow.matchMethod, "record_time");

      const rtWb = buildStatsWorkbookData(
        { from: "2026-11-20", to: "2026-11-20" },
        {
          listAccounts: () => rtAccounts.slice(0, 3),
          readWorks: (g, p) => ({
            works: rtAccounts.find((a) => a.group === g && a.platform === p).works,
          }),
          readWorksDaily: (g, p) => rtDaily[`${g}|${p}`] || {},
          readDaily: () => ({}),
          readPushRecords: () => [
            {
              pt: "抖音",
              group: "旧分组名",
              partition: "persist:acc_ren抖音",
              title: "记录标题一",
              filePath: "D:\\videos\\story_01.mp4",
              publishStatus: "success",
              lastPublishAt: baseT,
            },
          ],
          now: baseT + 3600 * 1000,
        }
      );
      const dyDailyExportRow = rtWb.sheets["作品日明细"].find((r) => r[6] === "w_dy_1");
      assert.strictEqual(dyDailyExportRow[4], "record_time", "Excel 作品日明细应写出 record_time");

      // 3c. 多候选作品不关联（±3h 内 2 条作品 → 均不走 record_time）
      const multiWorkContents = buildContentIndex([
        {
          pt: "抖音",
          group: "G1",
          partition: "persist:acc1抖音",
          title: "多候选测试记录",
          filePath: "D:\\videos\\multi.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
      ]);
      const multiWorkAccounts = [
        {
          group: "G1",
          platform: "抖音",
          partition: "persist:acc1抖音",
          works: [
            { workId: "mw1", title: "毫无关系的甲标题", publishTime: baseT + 10 * 60 * 1000 },
            { workId: "mw2", title: "毫无关系的乙标题", publishTime: baseT + 20 * 60 * 1000 },
          ],
        },
      ];
      const multiWorkLink = linkWorks({
        contents: multiWorkContents,
        accounts: multiWorkAccounts,
      });
      assert.deepStrictEqual(multiWorkLink.get("G1|抖音|mw1"), { contentKey: null, matchedBy: null });
      assert.deepStrictEqual(multiWorkLink.get("G1|抖音|mw2"), { contentKey: null, matchedBy: null });

      // 3d. 多内容竞争同一作品不关联
      const multiTargetContents = buildContentIndex([
        {
          pt: "抖音",
          group: "G1",
          partition: "persist:acc1抖音",
          title: "素材甲",
          filePath: "D:\\videos\\a.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        {
          pt: "抖音",
          group: "G1",
          partition: "persist:acc1抖音",
          title: "素材乙",
          filePath: "D:\\videos\\b.mp4",
          publishStatus: "success",
          lastPublishAt: baseT + 30 * 60 * 1000,
        },
      ]);
      const multiTargetLink = linkWorks({
        contents: multiTargetContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [{ workId: "single_w", title: "未知视频", publishTime: baseT + 15 * 60 * 1000 }],
          },
        ],
      });
      assert.deepStrictEqual(multiTargetLink.get("G1|抖音|single_w"), {
        contentKey: null,
        matchedBy: null,
      });

      // 3e. 手工关联 overrides 优先 + excludeAuto 可撤销 + clear 可恢复
      const manualContents = buildContentIndex([
        {
          pt: "抖音",
          group: "G1",
          partition: "persist:acc1抖音",
          title: "内容A",
          filePath: "D:\\videos\\cA.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
        {
          pt: "抖音",
          group: "G1",
          partition: "persist:acc1抖音",
          title: "内容B",
          filePath: "D:\\videos\\cB.mp4",
          publishStatus: "success",
          lastPublishAt: baseT + 10 * 3600 * 1000,
        },
      ]);
      // 仅 1 条作品，但手工 assign 到 cB → 永远优先不覆盖
      const manualOverrideLink = linkWorks({
        contents: manualContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [{ workId: "ov1", title: "异题视频", publishTime: baseT + 5 * 60 * 1000 }],
          },
        ],
        overrides: {
          version: 1,
          overrides: { "抖音|ov1": { action: "assign", contentKey: "file:d:/videos/cb.mp4" } },
        },
      });
      assert.deepStrictEqual(manualOverrideLink.get("G1|抖音|ov1"), {
        contentKey: "file:d:/videos/cb.mp4",
        matchedBy: "manual",
      });

      // 返修 #4：2 条作品在 cA 的 ±3h 内，即使 ov1 被手工 assign 到 cB，时间窗内全量候选仍为 2 条 → ov2 不得自动命中 record_time
      const manualNoShrinkLink = linkWorks({
        contents: manualContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [
              { workId: "ov1", title: "异题视频一", publishTime: baseT + 5 * 60 * 1000 },
              { workId: "ov2", title: "异题视频二", publishTime: baseT + 15 * 60 * 1000 },
            ],
          },
        ],
        overrides: {
          version: 1,
          overrides: { "抖音|ov1": { action: "assign", contentKey: "file:d:/videos/cb.mp4" } },
        },
      });
      assert.deepStrictEqual(manualNoShrinkLink.get("G1|抖音|ov1"), {
        contentKey: "file:d:/videos/cb.mp4",
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualNoShrinkLink.get("G1|抖音|ov2"), {
        contentKey: null,
        matchedBy: null,
      });

      // 返修 #4a：时间窗内含已直链匹配的作品，不得先剔除已直链作品而把剩余无关作品误挂到另一条未采到作品的成功记录
      {
        const tNow = utc8Ms("2026-11-24T13:00:00+08:00");
        const directAndPendingContents = buildContentIndex([
          {
            pt: "小红书",
            group: "赛博老司机",
            partition: "persist:Cyber小红书",
            lastPublishAt: tNow,
            publishStatus: "success",
            title: "黎曼猜想",
            filePath: "D:/video/known.mp4",
            videoLink: "https://www.xiaohongshu.com/explore/known",
          },
          {
            pt: "小红书",
            group: "赛博老司机",
            partition: "persist:Cyber小红书",
            lastPublishAt: tNow + 20 * 60 * 1000,
            publishStatus: "success",
            title: "图灵传记",
            filePath: "D:/video/pending.mp4",
          },
        ]);
        const directShrinkLink = linkWorks({
          contents: directAndPendingContents,
          accounts: [
            {
              group: "赛博老司机",
              platform: "小红书",
              partition: "persist:Cyber小红书",
              works: [
                {
                  workId: "known",
                  title: "黎曼猜想",
                  publishTime: tNow,
                  url: "https://www.xiaohongshu.com/explore/known",
                },
                {
                  workId: "independent",
                  title: "旧账号故事补发",
                  publishTime: tNow + 60 * 60 * 1000,
                },
              ],
            },
          ],
        });
        assert.deepStrictEqual(directShrinkLink.get("赛博老司机|小红书|known"), {
          contentKey: "file:d:/video/known.mp4",
          matchedBy: "link",
        });
        assert.deepStrictEqual(
          directShrinkLink.get("赛博老司机|小红书|independent"),
          { contentKey: null, matchedBy: null },
          "同账号 ±3h 内共有 2 条作品（含已直链），不得将剩余无关作品误挂到 pending 记录"
        );
      }

      // 返修 #4b：record_time 优先级必须低于既有模糊匹配（③ 目标模糊 & ④ 跨平台聚类），绝不抢占
      {
        const tNow = utc8Ms("2026-11-24T13:00:00+08:00");
        // 目标模糊优先：w_fuzzy 与 targetB 标题高度相似（发布日差 1 天，不在 targetB 的 ±3h 内），
        // 同时无关 targetA 在 ±3h 内但标题完全不同 → 必须由 ③ 模糊匹配到 targetB，不得被 targetA 抢占
        const fuzzyPriorityContents = buildContentIndex([
          {
            pt: "抖音",
            group: "G1",
            partition: "persist:acc1抖音",
            lastPublishAt: tNow,
            publishStatus: "success",
            title: "完全无关的临时记录标题",
            filePath: "D:/video/unrelated_near.mp4",
          },
          {
            pt: "抖音",
            group: "G1",
            partition: "persist:acc1抖音",
            lastPublishAt: tNow - 24 * 3600 * 1000,
            publishStatus: "success",
            title: "深度解析人工智能芯片架构发展",
            filePath: "D:/video/real_ai_chip.mp4",
          },
        ]);
        const fuzzyPriorityLink = linkWorks({
          contents: fuzzyPriorityContents,
          accounts: [
            {
              group: "G1",
              platform: "抖音",
              partition: "persist:acc1抖音",
              works: [
                {
                  workId: "w_fuzzy",
                  title: "深度解析人工智能芯片架构发展趋势",
                  publishTime: tNow + 15 * 60 * 1000,
                },
              ],
            },
          ],
        });
        const wfRes = fuzzyPriorityLink.get("G1|抖音|w_fuzzy");
        assert.strictEqual(wfRes.contentKey, "file:d:/video/real_ai_chip.mp4");
        assert.strictEqual(wfRes.matchedBy, "fuzzy", "既有模糊匹配必须优先于 record_time，不得被时间窗抢占");

        // 跨平台模糊聚类（④）优先：抖音与快手两条作品标题完全相同，抖音侧恰好有一条无关成功发布记录在 ±3h 内 →
        // 两条作品应先走 ④ 跨平台聚类成 auto:*，不得被无关记录按 record_time 拆散抢占
        const clusterPriorityContents = buildContentIndex([
          {
            pt: "抖音",
            group: "G2",
            partition: "persist:acc2抖音",
            lastPublishAt: tNow,
            publishStatus: "success",
            title: "完全无关的另一条视频",
            filePath: "D:/video/other_dy.mp4",
          },
        ]);
        const clusterPriorityLink = linkWorks({
          contents: clusterPriorityContents,
          accounts: [
            {
              group: "G2",
              platform: "抖音",
              partition: "persist:acc2抖音",
              works: [
                {
                  workId: "c_dy",
                  title: "深夜探访古城百年老宅实拍记录",
                  publishTime: tNow + 10 * 60 * 1000,
                },
              ],
            },
            {
              group: "G2",
              platform: "快手",
              partition: "persist:acc2快手",
              works: [
                {
                  workId: "c_ks",
                  title: "深夜探访古城百年老宅实拍记录",
                  publishTime: tNow + 15 * 60 * 1000,
                },
              ],
            },
          ],
        });
        const cDyRes = clusterPriorityLink.get("G2|抖音|c_dy");
        const cKsRes = clusterPriorityLink.get("G2|快手|c_ks");
        assert.strictEqual(cDyRes.matchedBy, "fuzzy");
        assert.strictEqual(cKsRes.matchedBy, "fuzzy");
        assert.ok(cDyRes.contentKey && cDyRes.contentKey.startsWith("auto:"));
        assert.strictEqual(cDyRes.contentKey, cKsRes.contentKey, "跨平台模糊聚类不得被 record_time 抢占拆散");
      }

      // ov1 被手工确认（assign 到 cA 本身）→ cA 已被占用，不得改吸走同窗无关作品 ov2！
      const manualSameContentOccupies = linkWorks({
        contents: manualContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [
              { workId: "ov1", title: "异题视频一", publishTime: baseT + 5 * 60 * 1000 },
              { workId: "ov2", title: "异题视频二", publishTime: baseT + 15 * 60 * 1000 },
            ],
          },
        ],
        overrides: {
          version: 1,
          overrides: { "抖音|ov1": { action: "assign", contentKey: "file:d:/videos/ca.mp4" } },
        },
      });
      assert.deepStrictEqual(manualSameContentOccupies.get("G1|抖音|ov1"), {
        contentKey: "file:d:/videos/ca.mp4",
        matchedBy: "manual",
      });
      assert.deepStrictEqual(manualSameContentOccupies.get("G1|抖音|ov2"), {
        contentKey: null,
        matchedBy: null,
      });

      // excludeAuto / detach 撤销 record_time，清除后恢复
      const detachedLink = linkWorks({
        contents: manualContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [{ workId: "det1", title: "可撤销视频", publishTime: baseT + 5 * 60 * 1000 }],
          },
        ],
        overrides: {
          version: 1,
          excludedAuto: { "抖音|det1": true },
          overrides: { "抖音|det1": { action: "detach" } },
        },
      });
      assert.deepStrictEqual(detachedLink.get("G1|抖音|det1"), {
        contentKey: null,
        matchedBy: "manual-detach",
      });
      const clearedLink = linkWorks({
        contents: manualContents,
        accounts: [
          {
            group: "G1",
            platform: "抖音",
            partition: "persist:acc1抖音",
            works: [{ workId: "det1", title: "可撤销视频", publishTime: baseT + 5 * 60 * 1000 }],
          },
        ],
        overrides: { version: 1, excludedAuto: {}, overrides: {} },
      });
      assert.deepStrictEqual(clearedLink.get("G1|抖音|det1"), {
        contentKey: "file:d:/videos/ca.mp4",
        matchedBy: "record_time",
      });

      // 3f. 跨账号不串：同平台不同账号（分属不同分组 或 同组多账号无单作品标识）绝不串连
      const crossAccContents = buildContentIndex([
        {
          pt: "抖音",
          group: "A组",
          partition: "persist:accA抖音",
          title: "账号A视频",
          filePath: "D:\\videos\\accA.mp4",
          publishStatus: "success",
          lastPublishAt: baseT,
        },
      ]);
      const crossAccLink = linkWorks({
        contents: crossAccContents,
        accounts: [
          {
            group: "B组",
            platform: "抖音",
            partition: "persist:accB抖音",
            works: [{ workId: "wb1", title: "账号B视频", publishTime: baseT + 1000 }],
          },
          {
            // 同组同平台挂两个账号但作品无单账号标识 → 拒绝跨号猜测
            group: "A组",
            platform: "抖音",
            accountPartitions: ["persist:accA抖音", "persist:accA2抖音"],
            works: [{ workId: "wa_ambig", title: "未知归属作品", publishTime: baseT + 1000 }],
          },
        ],
      });
      assert.deepStrictEqual(crossAccLink.get("B组|抖音|wb1"), { contentKey: null, matchedBy: null });
      assert.deepStrictEqual(crossAccLink.get("A组|抖音|wa_ambig"), {
        contentKey: null,
        matchedBy: null,
      });

      // 3g. 返修 #5：换号防误挂（meta.workCountsByAccount > 1 个账号、历史账号与当前账号冲突、或无法确定账号归属时整桶跳过 record_time）
      {
        const tSwap = utc8Ms("2026-11-24T13:00:00+08:00");
        const swapContents = buildContentIndex([
          {
            pt: "视频号",
            group: "赛博老司机",
            partition: "persist:NewCyber视频号",
            title: "新账号刚发的视频",
            filePath: "D:/video/new-account.mp4",
            publishStatus: "success",
            lastPublishAt: tSwap - 5 * 60 * 1000,
          },
        ]);

        // (1) meta.workCountsByAccount 记录了 OldCyber + NewCyber 两个账号，即使当前账号表只剩 NewCyber 也必须跳过 record_time
        const swappedMetaLink = linkWorks({
          contents: swapContents,
          accounts: [
            {
              group: "赛博老司机",
              platform: "视频号",
              accountPartitions: ["persist:NewCyber视频号"],
              meta: {
                workCountsByAccount: {
                  OldCyber: { workCount: 1, lastPositiveWorkCount: 1, updatedAt: tSwap - 3600 * 1000 },
                  NewCyber: { workCount: 1, lastPositiveWorkCount: 1, updatedAt: tSwap },
                },
              },
              works: [
                {
                  workId: "archive_old",
                  title: "旧账号留存作品",
                  publishTime: tSwap - 90 * 60 * 1000,
                },
              ],
            },
          ],
        });
        assert.deepStrictEqual(
          swappedMetaLink.get("赛博老司机|视频号|archive_old"),
          { contentKey: null, matchedBy: null },
          "meta.workCountsByAccount 记录多于 1 个账号时必须跳过 record_time"
        );

        // (2) meta.workCountsByAccount 仅记录 OldCyber，而当前账号表已换成 NewCyber（尚未采集新号）→ 冲突跳过 record_time
        const swappedConflictLink = linkWorks({
          contents: swapContents,
          accounts: [
            {
              group: "赛博老司机",
              platform: "视频号",
              accountPartitions: ["persist:NewCyber视频号"],
              meta: {
                workCountsByAccount: {
                  OldCyber: { workCount: 1, lastPositiveWorkCount: 1, updatedAt: tSwap - 3600 * 1000 },
                },
              },
              works: [
                {
                  workId: "archive_old_only",
                  title: "旧账号留存作品",
                  publishTime: tSwap - 30 * 60 * 1000,
                },
              ],
            },
          ],
        });
        assert.deepStrictEqual(
          swappedConflictLink.get("赛博老司机|视频号|archive_old_only"),
          { contentKey: null, matchedBy: null },
          "meta 历史账号与当前账号不一致时必须跳过 record_time"
        );

        // (3) 桶上无任何账号标识（无 partition/accountKey/phone/accountPartitions/meta.workCountsByAccount）→
        //     无法确定作品归属，绝不回落猜测 group 名称，跳过 record_time
        const unknownAccContents = buildContentIndex([
          {
            pt: "视频号",
            group: "赛博老司机",
            partition: "persist:赛博老司机视频号",
            title: "同名分组发布记录",
            filePath: "D:/video/group-named.mp4",
            publishStatus: "success",
            lastPublishAt: tSwap,
          },
        ]);
        const unknownAccLink = linkWorks({
          contents: unknownAccContents,
          accounts: [
            {
              group: "赛博老司机",
              platform: "视频号",
              meta: {},
              works: [
                {
                  workId: "unknown_owner",
                  title: "无账号归属作品",
                  publishTime: tSwap + 10 * 60 * 1000,
                },
              ],
            },
          ],
        });
        assert.deepStrictEqual(
          unknownAccLink.get("赛博老司机|视频号|unknown_owner"),
          { contentKey: null, matchedBy: null },
          "无法确定作品所属账号时不得按 group 猜测，必须跳过 record_time"
        );

        // (4) 单账号且 meta 与当前账号一致 → 正常命中 record_time
        const confirmedSingleLink = linkWorks({
          contents: swapContents,
          accounts: [
            {
              group: "赛博老司机",
              platform: "视频号",
              accountPartitions: ["persist:NewCyber视频号"],
              meta: {
                workCountsByAccount: {
                  NewCyber: { workCount: 1, lastPositiveWorkCount: 1, updatedAt: tSwap },
                },
              },
              works: [
                {
                  workId: "new_work_ok",
                  title: "新账号真实作品",
                  publishTime: tSwap - 10 * 60 * 1000,
                },
              ],
            },
          ],
        });
        assert.deepStrictEqual(confirmedSingleLink.get("赛博老司机|视频号|new_work_ok"), {
          contentKey: "file:d:/video/new-account.mp4",
          matchedBy: "record_time",
        });

        // (5) 磁盘端到端复现验证：通过 store.mergeWorks + store.writeMeta 写入两号历史后，buildContentSummaryData 绝不误挂旧账号作品
        const swapDay = "2026-11-24";
        const swapPrevDay = "2026-11-23";
        const swapGroup = "换号验证组";
        const swapPt = "视频号";
        writeJsonFile(path.join(accountDataDir, `${swapDay}.json`), [
          { group: "别组", phone: "别组-旧账号", pt: swapPt, accountKey: "OldCyber" },
          { group: swapGroup, phone: `${swapGroup}-新账号`, pt: swapPt, accountKey: "NewCyber" },
        ]);
        store.mergeWorks(
          swapGroup,
          swapPt,
          [{ workId: "disk_archive", title: "旧账号留存作品", publishTime: tSwap - 90 * 60 * 1000, play: 100 }],
          tSwap
        );
        store.writeMeta(swapGroup, swapPt, { lastCollectAt: tSwap, workCount: 1 }, { accountKey: "OldCyber" });
        store.mergeWorks(
          swapGroup,
          swapPt,
          [{ workId: "disk_prev", title: "新账号昨日作品", publishTime: utc8Ms(`${swapPrevDay}T13:00:00+08:00`), play: 75 }],
          tSwap
        );
        store.writeMeta(swapGroup, swapPt, { lastCollectAt: tSwap, workCount: 1 }, { accountKey: "NewCyber" });
        store.writeGroupSettings({ [swapGroup]: swapDay });
        const swapPushDir = path.join(tmpRoot, "swap-push-data");
        writeJsonFile(path.join(swapPushDir, `${swapDay}.json`), [
          {
            pt: swapPt,
            group: swapGroup,
            partition: "persist:NewCyber视频号",
            publishStatus: "success",
            lastPublishAt: tSwap - 5 * 60 * 1000,
            title: "新账号等待展示的视频",
            filePath: "D:/video/new-account.mp4",
          },
        ]);
        const diskSwapSummary = buildContentSummaryData({
          date: swapDay,
          groups: [swapGroup],
          pushDataDir: swapPushDir,
        });
        const newAccRow = diskSwapSummary.rows.find(
          (r) => r.contentKey === "file:d:/video/new-account.mp4"
        );
        assert.ok(newAccRow, "发布记录行应存在");
        assert.strictEqual(
          newAccRow.platformCount,
          0,
          "磁盘端到端换号桶必须跳过 record_time，不得把旧账号作品挂到新账号记录"
        );
        assert.ok(
          diskSwapSummary.rows.some((r) => r.contentKey === `unlinked:${swapPt}:disk_archive`),
          "旧账号作品应保持未关联"
        );
        // 清理换号测试临时数据
        fs.rmSync(path.join(store.baseDir(), swapGroup), { recursive: true, force: true });
        fs.rmSync(path.join(accountDataDir, `${swapDay}.json`), { force: true });
        fs.rmSync(store.groupSettingsFile(), { force: true });
      }
      console.log("✓ 3. record_time 自动关联（全量候选/优先级/手工优先/excludeAuto撤销/跨账号与换号隔离）通过");
    }

    /* =====================================================================
     * 4. 分组改名迁移统计目录（合并规则/备份/读失败不写盘/采集锁互斥）
     * ===================================================================== */
    {
      // 4a. 纯合并函数单元测试
      const mergedWorks = mergeWorksJsonDocs(
        {
          works: [
            {
              workId: "w1",
              title: "旧标题",
              url: "https://old.example/w1",
              play: 1200,
              like: 50,
              comment: 5,
              lastPositivePlay: 1800,
              altTitles: ["别名A", "共同别名"],
              baselineStats: { play: 100, like: 2 },
              firstSeenAt: 1700000001000,
              closedStats: { play: 900, like: 30 },
              closedAt: 1700000050000,
              updatedAt: 1700000100000,
            },
            {
              workId: "w_only_old",
              title: "仅旧有作品",
              play: 400,
              firstSeenAt: 1700000002000,
            },
          ],
        },
        {
          works: [
            {
              workId: "w1",
              title: "新标题",
              url: "https://new.example/w1",
              play: 1500,
              like: 80,
              comment: 12,
              lastPositivePlay: 1500,
              altTitles: ["共同别名", "别名B"],
              baselineStats: { play: 1500, like: 80 }, // 不得覆盖旧 baselineStats
              firstSeenAt: 1700000999000, // 不得覆盖旧 firstSeenAt
              closedStats: null, // 不得清除旧 closedStats
              closedAt: null,
              updatedAt: 1700000999000,
            },
            {
              workId: "w_only_new",
              title: "仅新有作品",
              play: 600,
              firstSeenAt: 1700000800000,
            },
          ],
        }
      );
      const w1 = mergedWorks.works.find((w) => w.workId === "w1");
      assert.deepStrictEqual(w1.baselineStats, { play: 100, like: 2 }, "保留旧 baselineStats");
      assert.strictEqual(w1.firstSeenAt, 1700000001000, "保留旧 firstSeenAt");
      assert.deepStrictEqual(w1.closedStats, { play: 900, like: 30 }, "保留旧 closedStats");
      assert.strictEqual(w1.closedAt, 1700000050000, "保留旧 closedAt");
      assert.strictEqual(w1.play, 1500, "新记录更新当前指标");
      assert.strictEqual(w1.like, 80);
      assert.strictEqual(w1.title, "新标题", "新记录更新标题");
      assert.strictEqual(w1.url, "https://new.example/w1", "新记录更新链接");
      assert.strictEqual(w1.updatedAt, 1700000999000, "更新 updatedAt");
      assert.strictEqual(w1.lastPositivePlay, 1800, "lastPositivePlay 取大");
      assert.deepStrictEqual(w1.altTitles, ["别名A", "共同别名", "别名B"], "altTitles 取并集");
      assert.ok(mergedWorks.works.find((w) => w.workId === "w_only_old"), "旧有作品保留");
      assert.ok(mergedWorks.works.find((w) => w.workId === "w_only_new"), "仅新有作品加入");

      // works-daily 合并：冲突取 updatedAt 较新者
      const wdMerged = mergeWorksDailyDocs(
        {
          date: "2026-11-20",
          updatedAt: 2000,
          works: { w1: { play: 999 }, w_old: { play: 10 } },
        },
        {
          date: "2026-11-20",
          updatedAt: 1000,
          works: { w1: { play: 500 }, w_new: { play: 20 } },
        },
        "2026-11-20"
      );
      assert.strictEqual(wdMerged.works.w1.play, 999, "works-daily 冲突取 updatedAt 较新者");
      assert.strictEqual(wdMerged.works.w_old.play, 10);
      assert.strictEqual(wdMerged.works.w_new.play, 20);
      assert.strictEqual(wdMerged.updatedAt, 2000);

      // works-intraday 合并：时段并集，同槽冲突取 collectedAt 较新者
      const wiMerged = mergeWorksIntradayDocs(
        {
          date: "2026-11-20",
          slots: {
            "08:00": { collectedAt: 100, works: { w1: { play: 100 } } },
            "12:00": { collectedAt: 500, works: { w1: { play: 500 }, w_old: { play: 50 } } },
          },
        },
        {
          date: "2026-11-20",
          slots: {
            "12:00": { collectedAt: 300, works: { w1: { play: 300 }, w_new: { play: 60 } } },
            "16:00": { collectedAt: 900, works: { w1: { play: 900 } } },
          },
        },
        "2026-11-20"
      );
      assert.deepStrictEqual(Object.keys(wiMerged.slots), ["08:00", "12:00", "16:00"]);
      assert.strictEqual(wiMerged.slots["12:00"].collectedAt, 500, "同槽取 collectedAt 新者");
      assert.strictEqual(wiMerged.slots["12:00"].works.w1.play, 500);
      assert.strictEqual(wiMerged.slots["12:00"].works.w_old.play, 50);
      assert.strictEqual(wiMerged.slots["12:00"].works.w_new.play, 60);

      // daily.json 合并：日期并集冲突取新
      const dailyMerged = mergeDailyDocs(
        { "2026-11-18": { fans: 10 }, "2026-11-19": { fans: 20 } },
        { "2026-11-19": { fans: 25 }, "2026-11-20": { fans: 30 } }
      );
      assert.deepStrictEqual(
        { ...dailyMerged },
        { "2026-11-18": { fans: 10 }, "2026-11-19": { fans: 25 }, "2026-11-20": { fans: 30 } }
      );

      // meta.json 取新
      const metaMerged = mergeMetaDocs(
        { lastCollectAt: 1000, workCount: 5 },
        { lastCollectAt: 2000, workCount: 8 }
      );
      assert.strictEqual(metaMerged.lastCollectAt, 2000);
      assert.strictEqual(metaMerged.workCount, 8);

      // 4b. 端到端目录迁移：完整落盘 + group-settings 键改名 + 旧目录移至同级 data-stats-merged-old/
      const migBase = path.join(tmpRoot, "mig-case", "data-stats");
      writeJsonFile(path.join(migBase, "group-settings.json"), {
        旧分组: "2026-11-15",
        其他组: "2026-11-24",
      });
      writeJsonFile(path.join(migBase, "旧分组", "抖音", "works.json"), {
        works: [
          {
            workId: "w1",
            title: "旧标题",
            play: 100,
            lastPositivePlay: 300,
            baselineStats: { play: 50 },
            firstSeenAt: 1111,
            closedStats: { play: 250 },
            closedAt: 2222,
            altTitles: ["老别名"],
            updatedAt: 3000,
          },
        ],
      });
      writeJsonFile(path.join(migBase, "旧分组", "抖音", "daily.json"), {
        "2026-11-18": { fans: 100 },
        "2026-11-19": { fans: 110 },
      });
      writeJsonFile(path.join(migBase, "旧分组", "抖音", "meta.json"), {
        lastCollectAt: 3000,
        workCount: 1,
      });
      writeJsonFile(path.join(migBase, "旧分组", "抖音", "works-daily", "2026-11-19.json"), {
        date: "2026-11-19",
        updatedAt: 5000,
        works: { w1: { play: 120 }, w_old_day: { play: 30 } },
      });
      writeJsonFile(path.join(migBase, "旧分组", "抖音", "works-intraday", "2026-11-19.json"), {
        date: "2026-11-19",
        slots: {
          "08:00": { collectedAt: 4000, works: { w1: { play: 110 } } },
          "12:00": { collectedAt: 6000, works: { w1: { play: 125 } } },
        },
      });

      // 新分组目录已有部分数据
      writeJsonFile(path.join(migBase, "新分组", "抖音", "works.json"), {
        works: [
          {
            workId: "w1",
            title: "新标题",
            url: "https://www.douyin.com/video/w1",
            play: 200,
            lastPositivePlay: 200,
            baselineStats: { play: 200 },
            firstSeenAt: 9999,
            altTitles: ["新别名"],
            updatedAt: 8000,
          },
          {
            workId: "w2",
            title: "新作品2",
            play: 50,
            firstSeenAt: 7000,
          },
        ],
      });
      writeJsonFile(path.join(migBase, "新分组", "抖音", "daily.json"), {
        "2026-11-19": { fans: 115 },
        "2026-11-20": { fans: 130 },
      });
      writeJsonFile(path.join(migBase, "新分组", "抖音", "meta.json"), {
        lastCollectAt: 8000,
        workCount: 2,
      });
      writeJsonFile(path.join(migBase, "新分组", "抖音", "works-daily", "2026-11-19.json"), {
        date: "2026-11-19",
        updatedAt: 4000,
        works: { w1: { play: 115 }, w2: { play: 45 } },
      });
      writeJsonFile(path.join(migBase, "新分组", "抖音", "works-intraday", "2026-11-19.json"), {
        date: "2026-11-19",
        slots: {
          "12:00": { collectedAt: 5000, works: { w1: { play: 118 } } },
          "18:00": { collectedAt: 9000, works: { w1: { play: 200 }, w2: { play: 50 } } },
        },
      });

      const migRes = renameStatsGroup({
        baseDir: migBase,
        oldGroup: "旧分组",
        newGroup: "新分组",
        now: utc8Ms("2026-11-24T15:30:00+08:00"),
      });
      assert.strictEqual(migRes.ok, true);
      assert.deepStrictEqual(migRes.mergedPlatforms, ["抖音"]);
      assert.strictEqual(migRes.groupSettingsRenamed, true);
      assert.strictEqual(fs.existsSync(path.join(migBase, "旧分组")), false, "旧目录已移走");
      assert.ok(
        migRes.backupDir.startsWith(path.join(path.dirname(migBase), "data-stats-merged-old")),
        "旧目录应移入 data-stats 同级 data-stats-merged-old/ 备份"
      );
      assert.strictEqual(
        fs.existsSync(path.join(migRes.backupDir, "抖音", "works.json")),
        true,
        "备份目录完整保留旧数据，不删除"
      );

      // 校验合并后的新目录文件与 group-settings.json
      const newGs = readJsonFile(path.join(migBase, "group-settings.json"));
      assert.deepStrictEqual(newGs, { 新分组: "2026-11-15", 其他组: "2026-11-24" });
      const newWorks = readJsonFile(path.join(migBase, "新分组", "抖音", "works.json"));
      const mw1 = newWorks.works.find((w) => w.workId === "w1");
      assert.deepStrictEqual(mw1.baselineStats, { play: 50 });
      assert.strictEqual(mw1.firstSeenAt, 1111);
      assert.deepStrictEqual(mw1.closedStats, { play: 250 });
      assert.strictEqual(mw1.lastPositivePlay, 300);
      assert.strictEqual(mw1.play, 200);
      assert.strictEqual(mw1.title, "新标题");
      assert.deepStrictEqual(mw1.altTitles, ["老别名", "新别名"]);
      assert.ok(newWorks.works.find((w) => w.workId === "w2"));
      const newWd = readJsonFile(
        path.join(migBase, "新分组", "抖音", "works-daily", "2026-11-19.json")
      );
      assert.strictEqual(newWd.works.w1.play, 120, "updatedAt 5000 > 4000 取旧边较新值");
      assert.strictEqual(newWd.works.w_old_day.play, 30);
      assert.strictEqual(newWd.works.w2.play, 45);
      const newWi = readJsonFile(
        path.join(migBase, "新分组", "抖音", "works-intraday", "2026-11-19.json")
      );
      assert.deepStrictEqual(Object.keys(newWi.slots), ["08:00", "12:00", "18:00"]);
      assert.strictEqual(newWi.slots["12:00"].works.w1.play, 125, "12:00 冲突取 collectedAt 6000 > 5000");
      const newDaily = readJsonFile(path.join(migBase, "新分组", "抖音", "daily.json"));
      assert.deepStrictEqual(newDaily, {
        "2026-11-18": { fans: 100 },
        "2026-11-19": { fans: 115 },
        "2026-11-20": { fans: 130 },
      });
      const newMeta = readJsonFile(path.join(migBase, "新分组", "抖音", "meta.json"));
      assert.strictEqual(newMeta.lastCollectAt, 8000);

      // 4c. 读失败/JSON 损坏时报错中止且绝不写盘
      const failBase = path.join(tmpRoot, "mig-fail", "data-stats");
      writeJsonFile(path.join(failBase, "group-settings.json"), { 坏旧组: "2026-11-15" });
      writeJsonFile(path.join(failBase, "坏旧组", "抖音", "works.json"), {
        works: [{ workId: "ok1", title: "正常抖音", play: 10 }],
      });
      // 快手目录写入损坏的 works-intraday JSON
      fs.mkdirSync(path.join(failBase, "坏旧组", "快手", "works-intraday"), { recursive: true });
      fs.writeFileSync(
        path.join(failBase, "坏旧组", "快手", "works-intraday", "2026-11-20.json"),
        "{corrupt json!!!",
        "utf8"
      );
      const gsBefore = fs.readFileSync(path.join(failBase, "group-settings.json"), "utf8");
      assert.throws(
        () => renameStatsGroup({ baseDir: failBase, oldGroup: "坏旧组", newGroup: "坏新组" }),
        /JSON 损坏/
      );
      assert.strictEqual(
        fs.existsSync(path.join(failBase, "坏新组")),
        false,
        "读失败时绝不可写入任何新目录文件（包括前面正常的抖音）"
      );
      assert.strictEqual(
        fs.existsSync(path.join(failBase, "坏旧组")),
        true,
        "读失败时旧目录不得移走"
      );
      assert.strictEqual(
        fs.existsSync(path.join(path.dirname(failBase), "data-stats-merged-old")),
        false,
        "读失败时不得创建备份目录"
      );
      assert.strictEqual(
        fs.readFileSync(path.join(failBase, "group-settings.json"), "utf8"),
        gsBefore,
        "读失败时 group-settings.json 不得改动"
      );

      // 4d. 返修 #1：迁移回滚（rollbackRenameStatsGroup）完整恢复旧目录、新目录写前状态与 group-settings.json
      {
        const rbBase = path.join(tmpRoot, "mig-rollback", "data-stats");
        writeJsonFile(path.join(rbBase, "group-settings.json"), { 原始组: "2026-11-15", 旁组: "2026-11-24" });
        writeJsonFile(path.join(rbBase, "原始组", "抖音", "works.json"), {
          works: [{ workId: "rb1", title: "原始作品", play: 123 }],
        });
        writeJsonFile(path.join(rbBase, "原始组", "抖音", "daily.json"), {
          "2026-11-20": { fans: 50 },
        });
        const gsOrigRaw = fs.readFileSync(path.join(rbBase, "group-settings.json"), "utf8");
        const movedRes = renameStatsGroup({
          baseDir: rbBase,
          oldGroup: "原始组",
          newGroup: "目标新组",
          now: utc8Ms("2026-11-24T16:00:00+08:00"),
        });
        assert.strictEqual(fs.existsSync(path.join(rbBase, "原始组")), false);
        assert.strictEqual(fs.existsSync(path.join(rbBase, "目标新组", "抖音", "works.json")), true);
        assert.ok(movedRes._rollbackPlan && movedRes._rollbackPlan.hasChanges);

        const rbOut = rollbackRenameStatsGroup(movedRes._rollbackPlan);
        assert.strictEqual(rbOut.ok, true);
        assert.strictEqual(rbOut.rolledBack, true);
        assert.strictEqual(fs.existsSync(path.join(rbBase, "原始组", "抖音", "works.json")), true, "回滚后旧目录必须恢复");
        assert.strictEqual(fs.existsSync(path.join(rbBase, "目标新组")), false, "回滚后新建的目标目录应清理干净");
        assert.strictEqual(
          fs.readFileSync(path.join(rbBase, "group-settings.json"), "utf8"),
          gsOrigRaw,
          "回滚后 group-settings.json 必须恢复为写前原始内容"
        );
      }
      console.log("✓ 4. 分组改名统计目录合并规则、旧目录备份、迁移回滚与读失败零写盘通过");
    }

    /* =====================================================================
     * 5. IPC 测试：stats:get-group-settings / stats:set-group-start-date / stats:rename-group + collect 锁互斥
     * ===================================================================== */
    {
      // 准备真实 userData/data-stats 目录数据以测 IPC 完整链路
      writeJsonFile(path.join(store.baseDir(), "测试组A", "抖音", "works.json"), {
        works: [
          { workId: "ipc_old", title: "旧作品", publishTime: utc8Ms("2026-11-10T10:00:00+08:00"), play: 100 },
          { workId: "ipc_new", title: "新作品", publishTime: utc8Ms("2026-11-20T10:00:00+08:00"), play: 200 },
        ],
      });
      writeJsonFile(path.join(store.baseDir(), "测试组A", "抖音", "works-daily", "2026-11-20.json"), {
        date: "2026-11-20",
        updatedAt: 1000,
        works: { ipc_old: { play: 100 }, ipc_new: { play: 200 } },
      });

      registerDataStatsIpc();

      const getGs = ipcHandlers.get("stats:get-group-settings");
      const setGs = ipcHandlers.get("stats:set-group-start-date");
      const renameGs = ipcHandlers.get("stats:rename-group");
      const rollbackRenameGs = ipcHandlers.get("stats:rollback-rename-group");
      const collectFn = ipcHandlers.get("stats:collect");
      assert.strictEqual(typeof getGs, "function");
      assert.strictEqual(typeof setGs, "function");
      assert.strictEqual(typeof renameGs, "function");
      assert.strictEqual(typeof rollbackRenameGs, "function");

      // 外部页面拒绝
      assert.strictEqual((await getGs(remoteEvent)).ok, false);
      assert.strictEqual((await setGs(remoteEvent, { group: "测试组A", statsStartDate: "2026-11-15" })).ok, false);
      assert.strictEqual((await renameGs(remoteEvent, { oldGroup: "测试组A", newGroup: "测试组B" })).ok, false);
      assert.strictEqual((await rollbackRenameGs(remoteEvent, { rollbackId: "fake" })).ok, false);

      // 并发设置两个分组起点日期：串行写入不丢写
      const [r1, r2] = await Promise.all([
        setGs(localEvent, { group: "测试组A", statsStartDate: "2026-11-15" }),
        setGs(localEvent, { group: "测试组X", statsStartDate: "2026-11-18" }),
      ]);
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r2.ok, true);
      const afterGet = await getGs(localEvent);
      assert.strictEqual(afterGet.ok, true);
      assert.deepStrictEqual(afterGet.settings, {
        测试组A: "2026-11-15",
        测试组X: "2026-11-18",
      });
      assert.strictEqual(afterGet.excludedTotal, 1);
      assert.deepStrictEqual(afterGet.excludedByGroup, { 测试组A: 1 });

      // 返修 #6 IPC 校验：读失败（EBUSY）时 stats:set-group-start-date 报错且不抹除已有分组配置
      const ipcGsPath = store.groupSettingsFile();
      const origReadIpc = fs.readFileSync;
      fs.readFileSync = function (p, ...rest) {
        if (path.resolve(String(p)) === path.resolve(ipcGsPath)) {
          const e = new Error("EBUSY: locked");
          e.code = "EBUSY";
          throw e;
        }
        return origReadIpc.call(this, p, ...rest);
      };
      let ipcBusySetRes;
      try {
        ipcBusySetRes = await setGs(localEvent, { group: "测试组Y", statsStartDate: "2026-11-24" });
      } finally {
        fs.readFileSync = origReadIpc;
      }
      assert.strictEqual(ipcBusySetRes.ok, false, "IPC 读失败必须返回 ok=false");
      assert.deepStrictEqual((await getGs(localEvent)).settings, {
        测试组A: "2026-11-15",
        测试组X: "2026-11-18",
      });

      // 采集进行中（collect 锁）：stats:rename-group 必须拒绝并提示稍后重试
      let releaseCollect;
      nextCollectPromise = new Promise((resolve) => {
        releaseCollect = resolve;
      });
      const collectTask = collectFn(localEvent, {
        accounts: [{ group: "测试组A", platform: "抖音", partition: "persist:测试组A抖音" }],
      });
      // 等待进入 collectAccount
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(collectCalls, 1);
      const busyRes = await renameGs(localEvent, { oldGroup: "测试组A", newGroup: "测试组B" });
      assert.strictEqual(busyRes.ok, false);
      assert.strictEqual(busyRes.busy, true);
      assert.ok(busyRes.error.includes("稍后重试"), "采集期间应提示稍后重试");
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组A")), true, "被拒绝时不得迁移目录");

      releaseCollect();
      await collectTask;
      nextCollectPromise = null;

      // 采集结束后先测试迁移 + rollbackId 回滚 IPC，再重新迁移成功
      const firstRename = await renameGs(localEvent, { oldGroup: "测试组A", newGroup: "测试组B" });
      assert.strictEqual(firstRename.ok, true);
      assert.ok(firstRename.rollbackId, "有实际落盘的迁移应返回不透明 rollbackId");
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组A")), false);
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组B", "抖音", "works.json")), true);

      const rbIpcRes = await rollbackRenameGs(localEvent, { rollbackId: firstRename.rollbackId });
      assert.strictEqual(rbIpcRes.ok, true);
      assert.strictEqual(rbIpcRes.rolledBack, true);
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组A", "抖音", "works.json")), true);
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组B")), false);
      assert.deepStrictEqual((await getGs(localEvent)).settings, {
        测试组A: "2026-11-15",
        测试组X: "2026-11-18",
      });
      // 同一 rollbackId 不可重复回滚
      assert.strictEqual((await rollbackRenameGs(localEvent, { rollbackId: firstRename.rollbackId })).ok, false);

      // 再次调用 stats:rename-group 成功迁移
      const okRename = await renameGs(localEvent, { oldGroup: "测试组A", newGroup: "测试组B" });
      assert.strictEqual(okRename.ok, true);
      assert.strictEqual(okRename.groupSettingsRenamed, true);
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组B", "抖音", "works.json")), true);
      assert.strictEqual(fs.existsSync(path.join(store.baseDir(), "测试组A")), false);
      const gsAfterRename = await getGs(localEvent);
      assert.deepStrictEqual(gsAfterRename.settings, {
        测试组B: "2026-11-15",
        测试组X: "2026-11-18",
      });
      assert.deepStrictEqual(gsAfterRename.excludedByGroup, { 测试组B: 1 });
      console.log("✓ 5. IPC（分组起点严格写保护/并发串行/改名迁移与回滚/collect锁互斥）通过");
    }

    /* =====================================================================
     * 6. UI 模板编译与交互校验（dataStats/index.vue & Sidebar/index.vue）
     * ===================================================================== */
    {
      // 6a. dataStats/index.vue 模板编译 + record_time 标签 + 起点日期设置/清空交互
      const statsVuePath = path.join(__dirname, "../src/renderer/views/dataStats/index.vue");
      const statsVueSrc = fs.readFileSync(statsVuePath, "utf8");
      const statsParsed = vueCompiler.parseComponent(statsVueSrc);
      const statsCompiled = vueCompiler.compile(statsParsed.template.content);
      assert.strictEqual(
        statsCompiled.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${statsCompiled.errors.join("; ")}`
      );
      assert.ok(
        statsParsed.template.content.includes("已排除 {{ excludedBeforeStartTotal }} 条起点前作品"),
        "UI 应展示「已排除 N 条起点前作品」"
      );

      const bundlePath = path.join(tmpRoot, "dataStats-s15.cjs");
      await build({
        stdin: {
          contents: statsParsed.script.content,
          resolveDir: path.dirname(statsVuePath),
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

      const uiInvokeCalls = [];
      const origLoad = Module._load;
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return {
            ipcRenderer: {
              invoke: async (channel, payload) => {
                uiInvokeCalls.push({ channel, payload });
                if (channel === "stats:get-group-settings") {
                  return {
                    ok: true,
                    settings: { 人间善恶录: "2026-11-15" },
                    excludedByGroup: { 人间善恶录: 12 },
                    excludedTotal: 12,
                  };
                }
                if (channel === "stats:set-group-start-date") {
                  const isClear = !payload.statsStartDate;
                  return {
                    ok: true,
                    group: payload.group,
                    statsStartDate: payload.statsStartDate || "",
                    settings: isClear ? {} : { [payload.group]: payload.statsStartDate },
                    excludedByGroup: isClear ? {} : { [payload.group]: 8 },
                    excludedTotal: isClear ? 0 : 8,
                  };
                }
                if (channel === "stats:get-content-summary") {
                  return {
                    rows: [],
                    deletedRows: [],
                    date: "2026-11-24",
                    excludedBeforeStartCount: 0,
                    excludedBeforeStartByGroup: {},
                  };
                }
                return { ok: true };
              },
            },
            shell: { openExternal: async () => {} },
            clipboard: { writeText: () => {} },
          };
        }
        return origLoad.call(this, request, ...rest);
      };
      try {
        const comp = require(bundlePath).default;
        const toasts = [];
        const ctx = {
          ...comp.data(),
          overview: {
            daily: {},
            accounts: [
              { group: "人间善恶录", platform: "抖音" },
              { group: "赛博老司机", platform: "小红书" },
            ],
          },
          activeTab: "works",
          $refs: {},
          $nextTick: (cb) => cb(),
          $message: {
            success: (m) => toasts.push({ type: "success", m }),
            error: (m) => toasts.push({ type: "error", m }),
            warning: (m) => toasts.push({ type: "warning", m }),
          },
        };
        for (const [k, fn] of Object.entries(comp.methods)) ctx[k] = fn.bind(ctx);
        for (const [k, fn] of Object.entries(comp.computed)) {
          Object.defineProperty(ctx, k, { get: fn.bind(ctx), configurable: true });
        }

        // record_time 标签显示
        assert.deepStrictEqual(ctx.rowMatchTagInfo({ matchMethod: "record_time" }), {
          label: "发布记录",
          type: "success",
        });
        assert.deepStrictEqual(ctx.workMatchTagInfo({ matchedBy: "record_time" }), {
          label: "发布记录",
          type: "success",
        });

        // 加载与修改/清空起点日期
        await ctx.loadGroupSettings();
        assert.deepStrictEqual(ctx.groupStartDates, { 人间善恶录: "2026-11-15" });
        assert.strictEqual(ctx.excludedBeforeStartTotal, 12);
        assert.deepStrictEqual(ctx.statsGroupNames, ["人间善恶录", "赛博老司机"]);

        await ctx.onGroupStartDateChange("赛博老司机", "2026-11-24");
        const setCall = uiInvokeCalls.find(
          (c) => c.channel === "stats:set-group-start-date" && c.payload.group === "赛博老司机"
        );
        assert.ok(setCall);
        assert.strictEqual(setCall.payload.statsStartDate, "2026-11-24");

        await ctx.clearGroupStartDate("赛博老司机");
        const clearCall = uiInvokeCalls.find(
          (c) =>
            c.channel === "stats:set-group-start-date" &&
            c.payload.group === "赛博老司机" &&
            c.payload.statsStartDate === ""
        );
        assert.ok(clearCall);
        assert.strictEqual(ctx.excludedBeforeStartTotal, 0);
      } finally {
        Module._load = origLoad;
      }

      // 6b. Sidebar/index.vue 模板编译与 confirmRenameGroup 真实执行校验（返修 #1：先迁统计再改账号/采集忙拒绝/失败回滚/同名重试）
      const sidebarVuePath = path.join(
        __dirname,
        "../src/renderer/layout/components/Sidebar/index.vue"
      );
      const sidebarSrc = fs.readFileSync(sidebarVuePath, "utf8");
      const sidebarParsed = vueCompiler.parseComponent(sidebarSrc);
      const sidebarCompiled = vueCompiler.compile(sidebarParsed.template.content);
      assert.strictEqual(
        sidebarCompiled.errors.length,
        0,
        `Sidebar/index.vue 模板编译失败: ${sidebarCompiled.errors.join("; ")}`
      );
      assert.ok(
        sidebarSrc.includes('ipcRenderer.invoke("stats:rename-group"'),
        "Sidebar 重命名分组应调用 stats:rename-group IPC"
      );
      assert.ok(
        sidebarSrc.includes('ipcRenderer.invoke("stats:rollback-rename-group"'),
        "Sidebar 账号更新失败时应支持回滚统计迁移"
      );

      const sidebarScriptMatch = sidebarSrc.match(/<script(?:\s+setup)?>([\s\S]*?)<\/script>/);
      const sidebarScriptBody =
        (sidebarParsed.scriptSetup && sidebarParsed.scriptSetup.content) ||
        (sidebarParsed.script && sidebarParsed.script.content) ||
        (sidebarScriptMatch && sidebarScriptMatch[1]) ||
        "";
      assert.ok(sidebarScriptBody.trim().length > 0, "应成功解析 Sidebar/index.vue 脚本块");
      const sidebarBundlePath = path.join(tmpRoot, "sidebar-s15.cjs");
      await build({
        stdin: {
          contents: `${sidebarScriptBody}\nexport { openRenameDialog, confirmRenameGroup, renameVisible, renameOld, renameNew, pendingRetryRename, groupOptions };`,
          resolveDir: path.dirname(sidebarVuePath),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: sidebarBundlePath,
        plugins: [
          {
            name: "stub-sidebar-deps",
            setup(b) {
              b.onResolve({ filter: /^(vue|vuedraggable|element-ui|\.\/SidebarItem|@\/)/ }, (args) => ({
                path: args.path,
                namespace: "sidebar-stub",
              }));
              b.onLoad({ filter: /.*/, namespace: "sidebar-stub" }, (args) => {
                if (args.path === "vue") {
                  return {
                    contents: `
                      export function ref(v) { return { value: v }; }
                      export function computed(fn) { return { get value() { return fn(); } }; }
                      export function defineComponent(x) { return x; }
                      export function watch(getter, cb) {
                        if (globalThis.__sidebarHarness && typeof cb === "function") {
                          globalThis.__sidebarHarness.watchers.push(cb);
                        }
                      }
                    `,
                    loader: "js",
                  };
                }
                if (args.path === "element-ui") {
                  return {
                    contents: `
                      export const Message = {
                        success: (m) => globalThis.__sidebarHarness.toasts.push({ type: "success", m }),
                        warning: (m) => globalThis.__sidebarHarness.toasts.push({ type: "warning", m }),
                        error: (m) => globalThis.__sidebarHarness.toasts.push({ type: "error", m }),
                      };
                    `,
                    loader: "js",
                  };
                }
                if (args.path === "@/router") {
                  return {
                    contents: `
                      export default {
                        get currentRoute() { return { path: globalThis.__sidebarHarness.currentPath }; },
                        push: (p) => { globalThis.__sidebarHarness.pushed.push(p); return Promise.resolve(); },
                      };
                    `,
                    loader: "js",
                  };
                }
                if (args.path === "@/store/app") {
                  return {
                    contents: `export function useAppStore() { return { sidebarStatus: { opened: true }, isRoute: "accountManager" }; }`,
                    loader: "js",
                  };
                }
                if (args.path === "@/store/permission") {
                  return {
                    contents: `export function usePermissionStore() { return globalThis.__sidebarHarness.permissionStore; }`,
                    loader: "js",
                  };
                }
                if (args.path === "@/utils/dataRequest") {
                  return {
                    contents: `export default (req) => globalThis.__sidebarHarness.dataRequest(req);`,
                    loader: "js",
                  };
                }
                return { contents: "export default {};", loader: "js" };
              });
            },
          },
        ],
      });

      const sidebarHarness = {
        toasts: [],
        pushed: [],
        events: [],
        watchers: [],
        currentPath: "/accountManager/旧分组",
        accounts: [
          { id: "acc1", date: "2026-11-20", group: "旧分组", accountName: "主号", accountKey: "accA", phone: "旧分组-主号", pt: "抖音" },
          { id: "acc2", date: "2026-11-20", group: "旧分组", accountName: "副号", accountKey: "accB", phone: "旧分组-副号", pt: "快手" },
          { id: "acc3", date: "2026-11-20", group: "其他已有组", accountName: "别号", accountKey: "accC", phone: "其他已有组-别号", pt: "小红书" },
        ],
        statsBusy: false,
        failUpdatePredicate: null,
        permissionStore: null,
        syncRoutes() {
          const groups = [...new Set(this.accounts.map((a) => a.group))];
          this.permissionStore.routers = groups.map((g) => ({
            name: g,
            path: `/accountManager/${g}`,
            meta: { phone: g, navModule: "accountManager" },
          }));
          for (const cb of this.watchers) {
            cb();
          }
        },
        async dataRequest(req) {
          if (req.type === "get") {
            return { success: true, data: { "2026-11-20": this.accounts.map((a) => ({ ...a })) } };
          }
          if (req.type === "update") {
            this.events.push(`account:update:${req.item.id}->${req.item.group}`);
            if (typeof this.failUpdatePredicate === "function" && this.failUpdatePredicate(req.item)) {
              return { success: false, message: "模拟账号写入失败" };
            }
            const target = this.accounts.find((a) => a.id === req.item.id);
            if (target) {
              target.group = req.item.group;
              target.phone = req.item.phone;
            }
            return { success: true };
          }
          return { success: true };
        },
      };
      sidebarHarness.permissionStore = {
        routers: [],
        async GenerateRoutes() {
          sidebarHarness.syncRoutes();
        },
      };
      sidebarHarness.syncRoutes();
      globalThis.__sidebarHarness = sidebarHarness;

      const origSidebarLoad = Module._load;
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return {
            ipcRenderer: {
              invoke: async (channel, payload) => {
                sidebarHarness.events.push(`ipc:${channel}:${payload.oldGroup || payload.rollbackId || ""}`);
                if (channel === "stats:rename-group") {
                  if (sidebarHarness.statsBusy) {
                    return { ok: false, busy: true, error: "当前正在采集数据，请稍后重试" };
                  }
                  return { ok: true, moved: true, rollbackId: "rb-token-1" };
                }
                if (channel === "stats:rollback-rename-group") {
                  return { ok: true, rolledBack: true };
                }
                return { ok: true };
              },
            },
          };
        }
        return origSidebarLoad.call(this, request, ...rest);
      };
      try {
        const sidebarMod = require(sidebarBundlePath);
        // 同步初始 groupOptions（通过 openRenameDialog + 替换 routes 驱动）
        // 场景 A：采集中改名 → 直接拒绝，账号记录一条都不改，弹窗保持打开，采集完可原名重试
        sidebarHarness.statsBusy = true;
        sidebarMod.renameVisible.value = true;
        sidebarMod.renameOld.value = "旧分组";
        sidebarMod.renameNew.value = "新分组";
        await sidebarMod.confirmRenameGroup();
        assert.strictEqual(
          sidebarHarness.events.filter((e) => e.startsWith("account:update")).length,
          0,
          "采集忙时绝不可更新任何账号记录"
        );
        assert.deepStrictEqual(
          sidebarHarness.accounts.filter((a) => a.id !== "acc3").map((a) => a.group),
          ["旧分组", "旧分组"],
          "采集忙拒绝后账号分组必须保持旧分组"
        );
        assert.strictEqual(sidebarMod.renameVisible.value, true, "采集忙被拒后弹窗保持打开便于重试");
        assert.ok(sidebarHarness.toasts.some((t) => t.type === "warning"));

        // 场景 B：更新第 2 条账号失败，但第 1 条可回滚 → 自动回滚第 1 条账号 + 调用 stats:rollback-rename-group
        sidebarHarness.statsBusy = false;
        sidebarHarness.events.length = 0;
        sidebarHarness.toasts.length = 0;
        sidebarHarness.failUpdatePredicate = (item) => item.id === "acc2" && item.group === "新分组";
        await sidebarMod.confirmRenameGroup();
        assert.strictEqual(
          sidebarHarness.events[0],
          "ipc:stats:rename-group:旧分组",
          "必须先调主进程迁移统计目录再更新账号"
        );
        assert.ok(
          sidebarHarness.events.includes("ipc:stats:rollback-rename-group:rb-token-1"),
          "账号更新失败且账号已回滚时，必须自动回滚统计迁移"
        );
        assert.deepStrictEqual(
          sidebarHarness.accounts.filter((a) => a.id !== "acc3").map((a) => a.group),
          ["旧分组", "旧分组"],
          "第 1 条账号必须已回滚回旧分组"
        );
        assert.strictEqual(sidebarMod.pendingRetryRename.value, null);

        // 场景 C：更新第 2 条账号失败且第 1 条回滚也失败（半完成态，此时「新分组」已出现在 groupOptions）→
        //         必须开放同名重试，不被「分组已存在」拦死，且重试后全部完成！
        sidebarHarness.events.length = 0;
        sidebarHarness.toasts.length = 0;
        sidebarHarness.failUpdatePredicate = (item) =>
          (item.id === "acc2" && item.group === "新分组") ||
          (item.id === "acc1" && item.group === "旧分组");
        await sidebarMod.confirmRenameGroup();
        assert.deepStrictEqual(
          sidebarHarness.accounts.filter((a) => a.id !== "acc3").map((a) => a.group),
          ["新分组", "旧分组"],
          "模拟半完成态：acc1 已在新分组，acc2 仍在旧分组"
        );
        assert.deepStrictEqual(sidebarMod.pendingRetryRename.value, {
          oldName: "旧分组",
          newName: "新分组",
        });
        assert.strictEqual(
          sidebarHarness.events.some((e) => e.startsWith("ipc:stats:rollback-rename-group")),
          false,
          "账号未能完全回滚时保留统计在新分组，等待同名重试继续完成"
        );

        // 验证半完成态下 groupOptions 确实已同时包含「旧分组」和「新分组」
        assert.ok(sidebarMod.groupOptions.value.includes("新分组"), "半完成态下 groupOptions 应已包含「新分组」");
        assert.ok(sidebarMod.groupOptions.value.includes("旧分组"), "半完成态下 groupOptions 应仍包含「旧分组」");

        // 尝试改成另一个已存在的「其他已有组」仍会被「已存在」拦截且不调 IPC
        sidebarHarness.events.length = 0;
        sidebarHarness.toasts.length = 0;
        sidebarMod.renameOld.value = "旧分组";
        sidebarMod.renameNew.value = "其他已有组";
        await sidebarMod.confirmRenameGroup();
        assert.strictEqual(sidebarHarness.events.length, 0, "改到其他已存在分组时必须被拦截且不触发 IPC");
        assert.ok(sidebarHarness.toasts.some((t) => t.type === "warning" && t.m.includes("已存在")));

        // 重试前关闭再打开弹窗仍记住待重试分组
        sidebarMod.renameVisible.value = false;
        sidebarMod.openRenameDialog();
        assert.strictEqual(sidebarMod.renameOld.value, "旧分组");
        assert.strictEqual(sidebarMod.renameNew.value, "新分组");

        // 恢复磁盘写入，以相同新名称「新分组」重试 → 不被「新分组已存在」拦死，完成剩余账号迁移
        sidebarHarness.failUpdatePredicate = null;
        sidebarHarness.events.length = 0;
        sidebarHarness.toasts.length = 0;
        await sidebarMod.confirmRenameGroup();
        assert.deepStrictEqual(
          sidebarHarness.accounts.filter((a) => a.id !== "acc3").map((a) => a.group),
          ["新分组", "新分组"],
          "同名重试必须顺利完成剩余账号迁移，不得被「新分组已存在」拦死"
        );
        assert.strictEqual(sidebarMod.renameVisible.value, false);
        assert.strictEqual(sidebarMod.pendingRetryRename.value, null);
        assert.ok(sidebarHarness.toasts.some((t) => t.type === "success" && t.m.includes("新分组")));
      } finally {
        Module._load = origSidebarLoad;
        delete globalThis.__sidebarHarness;
      }
      console.log("✓ 6. dataStats/index.vue 与 Sidebar/index.vue（先迁统计/忙拒绝/失败回滚/同名重试）验证通过");
    }

    console.log("\nALL S15 TESTS PASSED");
  } finally {
    if (origElectronCache) require.cache[electronId] = origElectronCache;
    else delete require.cache[electronId];
    if (origStoreCache) require.cache[storeId] = origStoreCache;
    else delete require.cache[storeId];
    if (origIndexCache) require.cache[indexId] = origIndexCache;
    else delete require.cache[indexId];
    if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
    else delete require.cache[collectorId];
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
