/**
 * Excel 导出（statsExport.js）、IPC（stats:export-xlsx / stats:get-content-summary）
 * 与 CLI（stats-export 参数解析与执行）单元测试（不依赖 Electron 运行环境）：
 *
 * 1. 纯函数注入依赖验证（空数据、分组过滤、公式注入防护、负数/0/空值类型）
 * 2. 临时 userData + documents 造 2 平台 × 2 分组 × 多天数据 + pushData：
 *    - 6 个 sheet 名称与顺序、表头、数值为 number、日期为 YYYY-MM-DD 文本、空值为空单元格
 *    - 无公式、无合并单元格
 *    - 作品日增与断档天数（gapDays）、平台日汇总求和（null 不计、全 null 为空）
 *    - 作品跨平台汇总动态列（平台·分组·播放/点赞/评论）与多行作品链接
 *    - 账号日快照日增（含粉丝回填日与断档日）
 *    - 字段说明覆盖全部列与必需口径/已知问题
 *    - 导出信息 7 项计数与默认 from/to（最新有数据日往前 29 天）
 *    - from/to 过滤（保留跨边界日增、汇总按 to 截断）
 *    - 公式注入前缀（= + - @ \t \r 及前导空格）
 *    - writeStatsXlsx 写出后用 xlsx 读回逐单元格验证
 * 3. IPC stats:export-xlsx 本地页面校验、取消保存、错误参数、默认文件名与 stats:get-content-summary
 * 4. CLI stats-export 参数解析（--out 缺失→2、日期非法→2、from>to→2）与执行（成功→0、异常→1）
 *
 * 运行：yarn test:stats-export
 */

"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
  presets: [
    ["@babel/preset-env", { targets: { node: "20" }, modules: "commonjs" }],
  ],
});

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xlsx = require("xlsx");

// 先不 mock electron 加载 statsExport，验证注入依赖模式下不强依赖 Electron
const statsExportPath = path.resolve(
  __dirname,
  "../src/main/services/dataStats/statsExport.js"
);
const statsExport = require(statsExportPath);
const {
  SHEET_NAMES,
  WORK_DAILY_HEADERS,
  PLATFORM_DAILY_HEADERS,
  ACCOUNT_DAILY_HEADERS,
  SCHEMA_HEADERS,
  META_HEADERS,
  sanitizeTextCell,
  buildContentSummaryData,
  buildStatsWorkbookData,
  writeStatsXlsx,
} = statsExport;

function captureConsole(fn) {
  const logs = [];
  const errors = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  const restore = () => {
    console.log = origLog;
    console.error = origErr;
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.then(
        (res) => {
          restore();
          return { res, logs, errors };
        },
        (err) => {
          restore();
          throw err;
        }
      );
    }
    restore();
    return { res: out, logs, errors };
  } catch (err) {
    restore();
    throw err;
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-export-test-"));
  const userDataDir = path.join(tmpRoot, "userData");
  const docsDir = path.join(tmpRoot, "Documents");
  const pushDataDir = path.join(docsDir, "MatrixMedia", "data", "pushData");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(pushDataDir, { recursive: true });

  try {
    /* ---------- 1. 纯注入模式：空数据、公式注入单测、负数与 0 ---------- */
    {
      const fixedNow = Date.parse("2026-11-19T02:00:00Z"); // UTC+8 2026-11-19 10:00:00
      const emptyData = buildStatsWorkbookData(
        { now: fixedNow, appVersion: "0.14.9-test" },
        {
          listAccounts: () => [],
          readWorks: () => ({ works: [] }),
          readWorksDaily: () => Object.create(null),
          readDaily: () => ({}),
          readPushRecords: () => [],
        }
      );

      assert.deepStrictEqual(emptyData.sheetOrder, [
        "作品日明细",
        "作品跨平台汇总",
        "平台日汇总",
        "账号日快照",
        "字段说明",
        "导出信息",
      ]);
      assert.strictEqual(emptyData.to, "2026-11-19");
      assert.strictEqual(emptyData.from, "2026-10-21", "默认 from 应为 to 往前 29 天");
      assert.strictEqual(emptyData.sheets["作品日明细"].length, 1);
      assert.strictEqual(emptyData.sheets["作品跨平台汇总"].length, 1);
      assert.strictEqual(emptyData.sheets["平台日汇总"].length, 1);
      assert.strictEqual(emptyData.sheets["账号日快照"].length, 1);
      assert.ok(emptyData.sheets["字段说明"].length > 40);
      assert.strictEqual(emptyData.sheets["导出信息"].length, 8);
      assert.deepStrictEqual(emptyData.counts, {
        accounts: 0,
        works: 0,
        contents: 0,
        unlinkedWorks: 0,
        workDailyRows: 0,
        platformDailyRows: 0,
        accountDailyRows: 0,
      });

      // 公式注入防护单测
      assert.strictEqual(sanitizeTextCell("=SUM(A1:A2)"), "'=SUM(A1:A2)");
      assert.strictEqual(sanitizeTextCell("+123"), "'+123");
      assert.strictEqual(sanitizeTextCell("-abc"), "'-abc");
      assert.strictEqual(sanitizeTextCell("@user"), "'@user");
      assert.strictEqual(sanitizeTextCell("  =1+1"), "'  =1+1");
      assert.strictEqual(sanitizeTextCell("\tformula"), "'\tformula");
      assert.strictEqual(sanitizeTextCell("\rformula"), "'\rformula");
      assert.strictEqual(sanitizeTextCell("普通标题"), "普通标题");
      assert.strictEqual(sanitizeTextCell("2026-11-19"), "2026-11-19");
      assert.strictEqual(sanitizeTextCell(""), null);
      assert.strictEqual(sanitizeTextCell(null), null);
      assert.strictEqual(sanitizeTextCell(undefined), null);
      console.log("✓ 注入模式空数据与公式注入单测通过");
    }

    /* ---------- 2. 临时 userData + pushData：2 平台 × 2 分组 × 多天端到端验证 ---------- */
    const ipcHandlers = new Map();
    const saveDialogCalls = [];
    let mockDialogResult = { canceled: false, filePath: "" };
    let mockWin = { id: 1 };

    const electronId = require.resolve("electron");
    const origElectronCache = require.cache[electronId];
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
          fromWebContents: () => mockWin,
        },
        dialog: {
          showSaveDialog: async (win, opts) => {
            saveDialogCalls.push({ win, opts });
            return mockDialogResult;
          },
        },
      },
    };

    const storeId = require.resolve("../src/main/services/dataStats/store.js");
    const indexId = require.resolve("../src/main/services/dataStats/index.js");
    const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
    const origCollectorCache = require.cache[collectorId];
    require.cache[collectorId] = {
      id: collectorId,
      filename: collectorId,
      loaded: true,
      exports: { collectAccount: async () => ({ overview: {}, fansHistory: [], works: [] }) },
    };
    delete require.cache[storeId];
    delete require.cache[indexId];

    const store = require(storeId);
    const { registerDataStatsIpc } = require(indexId);

    // 造数据时间戳（UTC+8 上午 10:00）
    const dayTs = (ymd) => Date.parse(`${ymd}T02:00:00Z`);

    // 2.1 写 pushData：2 个内容
    // 内容 1：/videos/dish1.mp4 -> A组 抖音（直链匹配 DY1）+ A组 快手（标题归一化匹配 KS1）
    // 内容 2：/videos/b1.mp4 -> B组 抖音（直链匹配 DY3）
    fs.writeFileSync(
      path.join(pushDataDir, "2026-11-09.json"),
      JSON.stringify(
        [
          {
            id: "p1",
            pt: "抖音",
            group: "A组",
            publishStatus: "success",
            title: "红烧肉教程",
            filePath: "/videos/dish1.mp4",
            videoLink: "https://www.douyin.com/video/1001",
            lastPublishAt: dayTs("2026-11-09"),
          },
          {
            id: "p2",
            pt: "快手",
            group: "A组",
            publishStatus: "success",
            title: "红烧肉教程",
            filePath: "/videos/dish1.mp4",
            videoLink: "",
            lastPublishAt: dayTs("2026-11-09"),
          },
          {
            id: "p3",
            pt: "抖音",
            group: "B组",
            publishStatus: "success",
            title: "-测试视频",
            filePath: "/videos/b1.mp4",
            videoLink: "https://www.douyin.com/video/2001",
            lastPublishAt: dayTs("2026-11-10"),
          },
        ],
        null,
        2
      )
    );

    // 2.2 写 4 个账号（2 平台 × 2 分组）多日 works + works-daily + daily
    // 日期：2026-11-10（Day1）、2026-11-11（Day2，连续 gap=0）、2026-11-14（Day5，断档 gap=2）
    // A组 · 抖音（抖音无收藏 favorite=null，有 fansDelta）
    store.mergeDaily(
      "A组",
      "抖音",
      { fans: 100, plays: 1000, likes: 50, comments: 5, shares: 2 },
      [{ date: "2026-11-09", value: 95 }],
      dayTs("2026-11-10")
    );
    store.mergeWorks(
      "A组",
      "抖音",
      [
        {
          workId: "DY1",
          title: "=SUM(A1:A2) 红烧肉教程",
          url: "https://www.douyin.com/video/1001",
          publishTime: dayTs("2026-11-09"),
          play: 100,
          like: 10,
          comment: 2,
          share: 1,
          favorite: null,
          fansDelta: 5,
        },
        {
          workId: "DY2",
          title: "+123 独立视频",
          url: "https://www.douyin.com/video/1002",
          publishTime: dayTs("2026-11-10"),
          play: 50,
          like: 4,
          comment: 1,
          share: 0,
          favorite: null,
          fansDelta: 2,
        },
      ],
      dayTs("2026-11-10")
    );

    store.mergeDaily(
      "A组",
      "抖音",
      { fans: 112, plays: 1350, likes: 70, comments: 8, shares: 4 },
      [],
      dayTs("2026-11-11")
    );
    store.mergeWorks(
      "A组",
      "抖音",
      [
        {
          workId: "DY1",
          title: "=SUM(A1:A2) 红烧肉教程",
          url: "https://www.douyin.com/video/1001",
          publishTime: dayTs("2026-11-09"),
          play: 260,
          like: 25,
          comment: 5,
          share: 3,
          favorite: null,
          fansDelta: 3, // 故意跌粉（delta = -2），验证负数保持 number 不被前置单引号
        },
        {
          workId: "DY2",
          title: "+123 独立视频",
          url: "https://www.douyin.com/video/1002",
          publishTime: dayTs("2026-11-10"),
          play: 90,
          like: 6,
          comment: 1,
          share: 0,
          favorite: null,
          fansDelta: 4,
        },
      ],
      dayTs("2026-11-11")
    );

    // 跳过 11-12、11-13，11-14 采集（gapDays = 2）
    store.mergeDaily(
      "A组",
      "抖音",
      { fans: 140, plays: 2000, likes: 110, comments: 15, shares: 9 },
      [{ date: "2026-11-12", value: 120 }], // 故意插入仅粉丝回填日，验证播放日增不丢失
      dayTs("2026-11-14")
    );
    store.mergeWorks(
      "A组",
      "抖音",
      [
        {
          workId: "DY1",
          title: "=SUM(A1:A2) 红烧肉教程",
          url: "https://www.douyin.com/video/1001",
          publishTime: dayTs("2026-11-09"),
          play: 500,
          like: 60,
          comment: 12,
          share: 8,
          favorite: null,
          fansDelta: 10,
        },
        {
          workId: "DY2",
          title: "+123 独立视频",
          url: "https://www.douyin.com/video/1002",
          publishTime: dayTs("2026-11-10"),
          play: 150,
          like: 10,
          comment: 2,
          share: 1,
          favorite: null,
          fansDelta: 5,
        },
      ],
      dayTs("2026-11-14")
    );

    // A组 · 快手（快手无分享、无收藏、无涨粉 → 全部 null）
    store.mergeDaily(
      "A组",
      "快手",
      { fans: 200, plays: 500, likes: 30, comments: 3 },
      [],
      dayTs("2026-11-10")
    );
    store.mergeWorks(
      "A组",
      "快手",
      [
        {
          workId: "KS1",
          title: "红烧肉教程 #美食",
          url: "https://www.kuaishou.com/short-video/ks1",
          publishTime: dayTs("2026-11-09"),
          play: 300,
          like: 20,
          comment: 4,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      dayTs("2026-11-10")
    );
    store.mergeDaily(
      "A组",
      "快手",
      { fans: 215, plays: 700, likes: 45, comments: 6 },
      [],
      dayTs("2026-11-11")
    );
    store.mergeWorks(
      "A组",
      "快手",
      [
        {
          workId: "KS1",
          title: "红烧肉教程 #美食",
          url: "https://www.kuaishou.com/short-video/ks1",
          publishTime: dayTs("2026-11-09"),
          play: 420,
          like: 30,
          comment: 7,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      dayTs("2026-11-11")
    );
    store.mergeDaily(
      "A组",
      "快手",
      { fans: 250, plays: 1100, likes: 80, comments: 11 },
      [],
      dayTs("2026-11-14")
    );
    store.mergeWorks(
      "A组",
      "快手",
      [
        {
          workId: "KS1",
          title: "红烧肉教程 #美食",
          url: "https://www.kuaishou.com/short-video/ks1",
          publishTime: dayTs("2026-11-09"),
          play: 700,
          like: 55,
          comment: 11,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      dayTs("2026-11-14")
    );

    // B组 · 抖音（标题以 - 开头测试公式注入防护）
    store.mergeDaily(
      "B组",
      "抖音",
      { fans: 50, plays: 200, likes: 12, comments: 1, shares: 0 },
      [],
      dayTs("2026-11-10")
    );
    store.mergeWorks(
      "B组",
      "抖音",
      [
        {
          workId: "DY3",
          title: "-测试视频",
          url: "https://www.douyin.com/video/2001",
          publishTime: dayTs("2026-11-10"),
          play: 200,
          like: 12,
          comment: 1,
          share: 0,
          favorite: null,
          fansDelta: 1,
        },
      ],
      dayTs("2026-11-10")
    );
    store.mergeDaily(
      "B组",
      "抖音",
      { fans: 58, plays: 310, likes: 18, comments: 2, shares: 1 },
      [],
      dayTs("2026-11-11")
    );
    store.mergeWorks(
      "B组",
      "抖音",
      [
        {
          workId: "DY3",
          title: "-测试视频",
          url: "https://www.douyin.com/video/2001",
          publishTime: dayTs("2026-11-10"),
          play: 310,
          like: 18,
          comment: 2,
          share: 1,
          favorite: null,
          fansDelta: 3,
        },
      ],
      dayTs("2026-11-11")
    );

    // B组 · 快手（标题以 @ 开头，play=0 验证真实 0 保留为 number）
    store.mergeDaily(
      "B组",
      "快手",
      { fans: 10, plays: 0, likes: 0, comments: 0 },
      [],
      dayTs("2026-11-11")
    );
    store.mergeWorks(
      "B组",
      "快手",
      [
        {
          workId: "KS2",
          title: "@用户 独立视频",
          url: "https://www.kuaishou.com/short-video/ks2",
          publishTime: dayTs("2026-11-11"),
          play: 0,
          like: 0,
          comment: 0,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      dayTs("2026-11-11")
    );

    // 2.3 默认范围导出（自动定位最新数据日 2026-11-14，往前 29 天 2026-10-16）
    const wbData = buildStatsWorkbookData({ now: dayTs("2026-11-19") });
    assert.deepStrictEqual(wbData.sheetOrder, SHEET_NAMES);
    assert.strictEqual(wbData.to, "2026-11-14", "默认 to 应取最新有数据日");
    assert.strictEqual(wbData.from, "2026-10-16", "默认 from 应为 to 往前 29 天");
    assert.strictEqual(wbData.counts.accounts, 4);
    assert.strictEqual(wbData.counts.works, 5); // DY1, DY2, KS1, DY3, KS2
    assert.strictEqual(wbData.counts.unlinkedWorks, 2); // DY2, KS2
    assert.strictEqual(wbData.counts.contents, 4); // dish1, b1, unlinked:DY2, unlinked:KS2

    // 验证 Sheet 1：作品日明细
    const s1 = wbData.sheets["作品日明细"];
    assert.deepStrictEqual(s1[0], WORK_DAILY_HEADERS);
    const s1Rows = s1.slice(1);
    const findS1 = (date, platform, group, workId) =>
      s1Rows.find(
        (r) => r[0] === date && r[1] === platform && r[2] === group && r[5] === workId
      );

    // DY1 Day1 (2026-11-10)：关联 link，首次记录日增与断档均为空，公式标题前置单引号
    const dy1d1 = findS1("2026-11-10", "抖音", "A组", "DY1");
    assert.ok(dy1d1, "应含 DY1 11-10 行");
    assert.strictEqual(dy1d1[3], "file:/videos/dish1.mp4");
    assert.strictEqual(dy1d1[4], "link");
    assert.strictEqual(dy1d1[6], "'=SUM(A1:A2) 红烧肉教程", "= 开头标题应前置单引号");
    assert.strictEqual(dy1d1[8], "2026-11-09", "发布日期应为 YYYY-MM-DD");
    assert.strictEqual(dy1d1[9], 100);
    assert.strictEqual(dy1d1[13], null, "抖音收藏为空单元格");
    assert.strictEqual(dy1d1[15], null, "首次记录播放日增应为空");
    assert.strictEqual(dy1d1[21], null, "首次记录断档天数应为空");

    // DY1 Day2 (2026-11-11)：连续一天 gapDays=0，playDelta=160，fansDeltaDelta=-2（负数 number）
    const dy1d2 = findS1("2026-11-11", "抖音", "A组", "DY1");
    assert.ok(dy1d2);
    assert.strictEqual(dy1d2[15], 160);
    assert.strictEqual(dy1d2[16], 15);
    assert.strictEqual(dy1d2[17], 3);
    assert.strictEqual(dy1d2[18], 2);
    assert.strictEqual(dy1d2[19], null);
    assert.strictEqual(typeof dy1d2[20], "number");
    assert.strictEqual(dy1d2[20], -2, "负日增必须保持数字类型且不前置单引号");
    assert.strictEqual(dy1d2[21], 0, "连续两天断档天数应为 0");

    // DY1 Day5 (2026-11-14)：断档 2 天，playDelta = 500 - 260 = 240
    const dy1d5 = findS1("2026-11-14", "抖音", "A组", "DY1");
    assert.ok(dy1d5);
    assert.strictEqual(dy1d5[15], 240);
    assert.strictEqual(dy1d5[20], 7);
    assert.strictEqual(dy1d5[21], 2, "11-11 到 11-14 断档天数应为 2");

    // 未关联作品 DY2 / KS2：内容ID 与 关联方式为空，+ / @ 开头标题前置单引号，真实 0 保持 number
    const dy2d1 = findS1("2026-11-10", "抖音", "A组", "DY2");
    assert.strictEqual(dy2d1[3], null, "未关联作品内容ID应为空");
    assert.strictEqual(dy2d1[4], null, "未关联作品关联方式应为空");
    assert.strictEqual(dy2d1[6], "'+123 独立视频");
    assert.strictEqual(dy2d1[12], 0, "真实 0 应保留为 number 0");

    const dy3d1 = findS1("2026-11-10", "抖音", "B组", "DY3");
    assert.strictEqual(dy3d1[6], "'-测试视频");

    const ks2d2 = findS1("2026-11-11", "快手", "B组", "KS2");
    assert.strictEqual(ks2d2[6], "'@用户 独立视频");
    assert.strictEqual(ks2d2[9], 0, "快手 play=0 应为数字 0");
    assert.strictEqual(ks2d2[12], null, "快手分享缺项为空");
    assert.strictEqual(ks2d2[13], null, "快手收藏缺项为空");
    assert.strictEqual(ks2d2[14], null, "快手涨粉缺项为空");

    // KS1 通过标题归一化关联到 dish1
    const ks1d2 = findS1("2026-11-11", "快手", "A组", "KS1");
    assert.strictEqual(ks1d2[3], "file:/videos/dish1.mp4");
    assert.strictEqual(ks1d2[4], "title");
    assert.strictEqual(ks1d2[15], 120);

    // 验证 Sheet 2：作品跨平台汇总（截至 2026-11-14）
    const s2 = wbData.sheets["作品跨平台汇总"];
    assert.deepStrictEqual(s2[0], [
      "内容ID",
      "标题",
      "素材文件",
      "首发日期",
      "覆盖平台数",
      "总播放",
      "总点赞",
      "总评论",
      "总分享",
      "总收藏",
      "总涨粉",
      "抖音·A组·播放",
      "抖音·A组·点赞",
      "抖音·A组·评论",
      "抖音·B组·播放",
      "抖音·B组·点赞",
      "抖音·B组·评论",
      "快手·A组·播放",
      "快手·A组·点赞",
      "快手·A组·评论",
      "快手·B组·播放",
      "快手·B组·点赞",
      "快手·B组·评论",
      "作品链接",
    ]);
    const dish1Row = s2.slice(1).find((r) => r[0] === "file:/videos/dish1.mp4");
    assert.ok(dish1Row, "跨平台汇总应含 dish1");
    assert.strictEqual(dish1Row[2], "/videos/dish1.mp4");
    assert.strictEqual(dish1Row[3], "2026-11-09");
    assert.strictEqual(dish1Row[4], 2, "覆盖平台数应为 2");
    assert.strictEqual(dish1Row[5], 500 + 700, "总播放 = DY1(500) + KS1(700)");
    assert.strictEqual(dish1Row[6], 60 + 55);
    assert.strictEqual(dish1Row[7], 12 + 11);
    assert.strictEqual(dish1Row[8], 8, "总分享仅抖音有值 8");
    assert.strictEqual(dish1Row[9], null, "总收藏两平台全空应为空单元格");
    assert.strictEqual(dish1Row[10], 10, "总涨粉仅抖音有值 10");
    assert.strictEqual(dish1Row[11], 500, "抖音·A组·播放");
    assert.strictEqual(dish1Row[12], 60, "抖音·A组·点赞");
    assert.strictEqual(dish1Row[13], 12, "抖音·A组·评论");
    assert.strictEqual(dish1Row[14], null, "抖音·B组 无此作品应为空");
    assert.strictEqual(dish1Row[17], 700, "快手·A组·播放");
    assert.strictEqual(dish1Row[18], 55, "快手·A组·点赞");
    assert.strictEqual(dish1Row[19], 11, "快手·A组·评论");
    assert.strictEqual(
      dish1Row[23],
      "https://www.douyin.com/video/1001\nhttps://www.kuaishou.com/short-video/ks1",
      "多条作品链接应用换行连接"
    );
    const b1Row = s2.slice(1).find((r) => r[0] === "file:/videos/b1.mp4");
    assert.strictEqual(b1Row[1], "'-测试视频", "跨平台汇总标题应同样防公式注入");
    const unlinkedDy2 = s2.slice(1).find((r) => r[0] === "unlinked:抖音:DY2");
    assert.strictEqual(unlinkedDy2[1], "'+123 独立视频");
    const unlinkedKs2 = s2.slice(1).find((r) => r[0] === "unlinked:快手:KS2");
    assert.strictEqual(unlinkedKs2[1], "'@用户 独立视频");

    // 验证 Sheet 3：平台日汇总
    const s3 = wbData.sheets["平台日汇总"];
    assert.deepStrictEqual(s3[0], PLATFORM_DAILY_HEADERS);
    const findS3 = (date, platform) =>
      s3.slice(1).find((r) => r[0] === date && r[1] === platform);

    // 2026-11-10 抖音：3 条作品（DY1, DY2, DY3），首次记录所有日增合计全为空
    const pDy10 = findS3("2026-11-10", "抖音");
    assert.deepStrictEqual(pDy10, [
      "2026-11-10",
      "抖音",
      3,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);

    // 2026-11-11 抖音：DY1(+160,+15,+3,+2,null,-2) + DY2(+40,+2,0,0,null,+2) + DY3(+110,+6,+1,+1,null,+2)
    const pDy11 = findS3("2026-11-11", "抖音");
    assert.deepStrictEqual(pDy11, [
      "2026-11-11",
      "抖音",
      3,
      310,
      23,
      4,
      3,
      null,
      2,
    ]);

    // 2026-11-11 快手：KS1(+120,+10,+3,null,null,null) + KS2(首次全 null，有数据作品数计入)
    const pKs11 = findS3("2026-11-11", "快手");
    assert.deepStrictEqual(pKs11, [
      "2026-11-11",
      "快手",
      2,
      120,
      10,
      3,
      null,
      null,
      null,
    ]);

    // 验证 Sheet 4：账号日快照
    const s4 = wbData.sheets["账号日快照"];
    assert.deepStrictEqual(s4[0], ACCOUNT_DAILY_HEADERS);
    const findS4 = (date, platform, group) =>
      s4.slice(1).find((r) => r[0] === date && r[1] === platform && r[2] === group);

    // A组·抖音：11-09 回填粉丝 95；11-10 粉丝 100（日增 5）播放 1000（日增 null）；
    // 11-11 粉丝 112（+12）播放 1350（+350）；11-12 回填粉丝 120（+8）播放 null；
    // 11-14 粉丝 140（+20）播放 2000（+650，相对 11-11 上一有播放记录日）
    const aDy09 = findS4("2026-11-09", "抖音", "A组");
    assert.deepStrictEqual(aDy09, [
      "2026-11-09",
      "抖音",
      "A组",
      95,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    const aDy10 = findS4("2026-11-10", "抖音", "A组");
    assert.strictEqual(aDy10[9], 5, "11-10 粉丝日增应相对 11-09 回填日计算");
    assert.strictEqual(aDy10[10], null, "11-10 首次出现总播放，播放日增为空");
    const aDy11 = findS4("2026-11-11", "抖音", "A组");
    assert.strictEqual(aDy11[9], 12);
    assert.strictEqual(aDy11[10], 350);
    const aDy12 = findS4("2026-11-12", "抖音", "A组");
    assert.strictEqual(aDy12[9], 8);
    assert.strictEqual(aDy12[10], null);
    const aDy14 = findS4("2026-11-14", "抖音", "A组");
    assert.strictEqual(aDy14[9], 20);
    assert.strictEqual(aDy14[10], 650, "中间夹粉丝回填日时，播放日增仍按上一有播放记录日计算");

    // 验证 Sheet 5：字段说明包含每个 sheet 每列与全部必需口径
    const s5 = wbData.sheets["字段说明"];
    assert.deepStrictEqual(s5[0], SCHEMA_HEADERS);
    const s5Text = s5.slice(1).map((r) => r.join(" ")).join("\n");
    for (const kw of [
      "累计值",
      "日增",
      "断档天数 > 0",
      "T+1",
      "抖音当天",
      "快手无收藏/分享",
      "抖音无收藏",
      "头条无收藏",
      "B站无单视频涨粉",
      "仅抖音/视频号有",
      "为空不是 0",
      "适配器可能把缺失指标写成 0",
      "同组同平台",
      "启用本功能当天开始积累",
    ]) {
      assert.ok(s5Text.includes(kw), `字段说明缺少关键口径：${kw}`);
    }
    // 校验前 4 个 sheet 的每个列名都在字段说明里有对应行
    for (const sheetName of SHEET_NAMES.slice(0, 4)) {
      const headers = wbData.sheets[sheetName][0];
      const documented = new Set(
        s5.slice(1).filter((r) => r[0] === sheetName).map((r) => r[1])
      );
      for (const h of headers) {
        assert.ok(documented.has(h), `字段说明缺少 ${sheetName}.${h}`);
      }
    }

    // 验证 Sheet 6：导出信息
    const s6 = wbData.sheets["导出信息"];
    assert.deepStrictEqual(s6[0], META_HEADERS);
    const s6Map = new Map(s6.slice(1).map((r) => [r[0], r[1]]));
    assert.strictEqual(s6Map.get("日期范围"), "2026-10-16 ~ 2026-11-14");
    assert.strictEqual(s6Map.get("应用版本"), "0.14.9-fork.test");
    assert.strictEqual(s6Map.get("账号数"), 4);
    assert.strictEqual(s6Map.get("作品数"), 5);
    assert.strictEqual(s6Map.get("内容数"), 4);
    assert.strictEqual(s6Map.get("未关联作品数"), 2);

    // 2.4 写出 .xlsx 并用 SheetJS 读回逐项校验
    const outXlsx = path.join(tmpRoot, "nested", "full-export.xlsx");
    writeStatsXlsx(wbData, outXlsx);
    assert.ok(fs.existsSync(outXlsx), "应写出 .xlsx 文件");

    const readWb = xlsx.readFile(outXlsx);
    assert.deepStrictEqual(readWb.SheetNames, SHEET_NAMES, "读回 sheet 名与顺序必须精确匹配");

    for (const sheetName of SHEET_NAMES) {
      const ws = readWb.Sheets[sheetName];
      assert.ok(ws, `读回缺少 sheet: ${sheetName}`);
      assert.strictEqual(ws["!merges"], undefined, `${sheetName} 不得合并单元格`);
      for (const [addr, cell] of Object.entries(ws)) {
        if (addr.startsWith("!")) continue;
        assert.strictEqual(cell.f, undefined, `${sheetName}!${addr} 不得含公式`);
      }
    }

    // 读回检查 Sheet 1 具体单元格类型（文本日期、number、0、负数、空单元格、公式注入前缀）
    const ws1 = readWb.Sheets["作品日明细"];
    const ws1Range = xlsx.utils.decode_range(ws1["!ref"]);
    let checkedDy1D2 = false;
    let checkedKs2D2 = false;
    for (let r = 1; r <= ws1Range.e.r; r++) {
      const cell = (c) => ws1[xlsx.utils.encode_cell({ r, c })];
      assert.strictEqual(cell(0).t, "s", "日期单元格必须为字符串类型");
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(cell(0).v), "日期格式必须为 YYYY-MM-DD");
      if (cell(0).v === "2026-11-11" && cell(1).v === "抖音" && cell(5).v === "DY1") {
        checkedDy1D2 = true;
        assert.strictEqual(cell(6).t, "s");
        assert.strictEqual(cell(6).v, "'=SUM(A1:A2) 红烧肉教程");
        assert.strictEqual(cell(8).t, "s");
        assert.strictEqual(cell(8).v, "2026-11-09");
        assert.strictEqual(cell(9).t, "n");
        assert.strictEqual(cell(9).v, 260);
        assert.strictEqual(cell(13), undefined, "抖音收藏空值必须为空单元格");
        assert.strictEqual(cell(15).t, "n");
        assert.strictEqual(cell(15).v, 160);
        assert.strictEqual(cell(20).t, "n");
        assert.strictEqual(cell(20).v, -2);
        assert.strictEqual(cell(21).t, "n");
        assert.strictEqual(cell(21).v, 0);
      }
      if (cell(0).v === "2026-11-11" && cell(1).v === "快手" && cell(5).v === "KS2") {
        checkedKs2D2 = true;
        assert.strictEqual(cell(3), undefined, "未关联内容ID为空单元格");
        assert.strictEqual(cell(4), undefined, "未关联方式为空单元格");
        assert.strictEqual(cell(6).v, "'@用户 独立视频");
        assert.strictEqual(cell(9).t, "n");
        assert.strictEqual(cell(9).v, 0, "真实 0 读回必须为数字 0");
        assert.strictEqual(cell(12), undefined, "快手分享为空单元格");
      }
    }
    assert.ok(checkedDy1D2 && checkedKs2D2, "读回校验应命中目标行");

    // 读回检查 Sheet 6 数值类型
    const ws6 = readWb.Sheets["导出信息"];
    assert.strictEqual(ws6.B5.t, "n", "导出信息账号数必须为数字类型");
    assert.strictEqual(ws6.B5.v, 4);
    assert.strictEqual(ws6.B6.t, "n");
    assert.strictEqual(ws6.B6.v, 5);

    // 2.5 from/to 过滤 + groups 过滤
    const filtered = buildStatsWorkbookData({
      from: "2026-11-11",
      to: "2026-11-11",
    });
    assert.strictEqual(filtered.from, "2026-11-11");
    assert.strictEqual(filtered.to, "2026-11-11");
    const fS1Rows = filtered.sheets["作品日明细"].slice(1);
    assert.ok(fS1Rows.length > 0);
    assert.ok(fS1Rows.every((r) => r[0] === "2026-11-11"), "Sheet 1 应仅保留 11-11 行");
    const fDy1 = fS1Rows.find((r) => r[5] === "DY1");
    assert.strictEqual(fDy1[15], 160, "过滤 from 后首日仍应相对 11-10 计算日增");
    const fDish1 = filtered.sheets["作品跨平台汇总"]
      .slice(1)
      .find((r) => r[0] === "file:/videos/dish1.mp4");
    assert.strictEqual(
      fDish1[5],
      260 + 420,
      "跨平台汇总应截至 to=11-11（不泄漏 11-14 数据）"
    );
    const fS4Rows = filtered.sheets["账号日快照"].slice(1);
    assert.ok(fS4Rows.every((r) => r[0] === "2026-11-11"), "Sheet 4 应仅保留 11-11 行");
    const fADy = fS4Rows.find((r) => r[1] === "抖音" && r[2] === "A组");
    assert.strictEqual(fADy[9], 12, "过滤后账号日快照仍保留跨边界粉丝日增");
    assert.strictEqual(fADy[10], 350, "过滤后账号日快照仍保留跨边界播放日增");

    const onlyA = buildStatsWorkbookData({ groups: ["A组"] });
    assert.strictEqual(onlyA.counts.accounts, 2);
    assert.ok(
      onlyA.sheets["作品日明细"].slice(1).every((r) => r[2] === "A组"),
      "groups 过滤应仅保留 A组"
    );
    assert.strictEqual(
      onlyA.sheets["作品跨平台汇总"].slice(1).some((r) => r[0] === "file:/videos/b1.mp4"),
      false,
      "groups 过滤不应混入 B组 pushData 内容"
    );
    console.log("✓ 2 平台 × 2 分组数据构建、from/to/groups 过滤与 xlsx 读回验证全部通过");

    /* ---------- 3. IPC 测试：stats:export-xlsx & stats:get-content-summary ---------- */
    registerDataStatsIpc();
    const exportHandler = ipcHandlers.get("stats:export-xlsx");
    const summaryHandler = ipcHandlers.get("stats:get-content-summary");
    assert.strictEqual(typeof exportHandler, "function");
    assert.strictEqual(typeof summaryHandler, "function");

    // 3a. 外部页面与非法参数拦截（绝不弹保存对话框）
    const beforeDialogs = saveDialogCalls.length;
    for (const url of [
      "https://creator.douyin.com",
      "http://localhost.evil/",
      "file://remote/app.html",
      "",
    ]) {
      const r = await exportHandler({ sender: {}, senderFrame: { url } }, {});
      assert.strictEqual(r.ok, false, `外部来源 ${url} 必须被拒绝`);
    }
    const badDateRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      { from: "2026-02-30" }
    );
    assert.strictEqual(badDateRes.ok, false);
    const badOrderRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      { from: "2026-11-15", to: "2026-11-10" }
    );
    assert.strictEqual(badOrderRes.ok, false);
    mockWin = null;
    const closedWinRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      {}
    );
    assert.strictEqual(closedWinRes.ok, false);
    mockWin = { id: 1 };
    assert.strictEqual(saveDialogCalls.length, beforeDialogs, "拦截场景不应弹出保存窗口");

    // 3b. 取消保存
    const ipcOutFile = path.join(tmpRoot, "ipc-exported.xlsx");
    mockDialogResult = { canceled: true, filePath: "" };
    const cancelRes = await exportHandler(
      { sender: {}, senderFrame: { url: "http://localhost:9080/#/dataStats" } },
      { from: "2026-11-10", to: "2026-11-14" }
    );
    assert.deepStrictEqual(cancelRes, { ok: false, canceled: true });
    assert.strictEqual(fs.existsSync(ipcOutFile), false);
    assert.strictEqual(
      saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath,
      path.join(docsDir, "MatrixMedia-作品数据-2026-11-10_2026-11-14.xlsx")
    );

    // 3c. 正常导出成功
    mockDialogResult = { canceled: false, filePath: ipcOutFile };
    const okRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      {}
    );
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.filePath, ipcOutFile);
    assert.strictEqual(okRes.counts.accounts, 4);
    assert.strictEqual(okRes.counts.works, 5);
    assert.strictEqual(
      saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath,
      path.join(docsDir, "MatrixMedia-作品数据-2026-10-16_2026-11-14.xlsx")
    );
    assert.deepStrictEqual(xlsx.readFile(ipcOutFile).SheetNames, SHEET_NAMES);

    // 3d. stats:get-content-summary
    const sumRes = await summaryHandler({}, {});
    assert.strictEqual(sumRes.date, "2026-11-14");
    assert.strictEqual(sumRes.rows.length, 4);
    const sumAsOf11 = await summaryHandler({}, { date: "2026-11-11" });
    assert.strictEqual(sumAsOf11.date, "2026-11-11");
    assert.strictEqual(
      sumAsOf11.rows.find((r) => r.contentKey === "file:/videos/dish1.mp4").totalPlay,
      680
    );
    const sumBad = await summaryHandler({}, { date: "2026-99-99" });
    assert.ok(sumBad.error);
    assert.deepStrictEqual(sumBad.rows, []);
    console.log("✓ IPC stats:export-xlsx（安全校验/默认路径/取消/导出）与 stats:get-content-summary 通过");

    /* ---------- 4. CLI 参数解析与执行测试 ---------- */
    const { parseStatsArgs, statsHelpText } = require("../src/main/cli/parseStatsArgs.js");
    const { runStatsCli } = require("../src/main/cli/runStatsCli.js");

    // 4a. 参数校验失败（CLI 主入口对应退出码 2）
    for (const [argv, reason] of [
      [[], "缺少 --out"],
      [["--out"], "--out 缺值"],
      [["--out", "--from", "2026-11-01"], "--out 值为下一选项"],
      [["--out="], "--out= 空值"],
      [["--out", "a.xlsx", "--from"], "--from 缺值"],
      [["--out", "a.xlsx", "--from", "2026-02-30"], "--from 非法日历日"],
      [["--out", "a.xlsx", "--from", "2026/11/01"], "--from 格式非法"],
      [["--out", "a.xlsx", "--to", "invalid"], "--to 非法"],
      [["--out", "a.xlsx", "--from", "2026-11-20", "--to", "2026-11-10"], "from > to"],
      [["--out", "a.xlsx", "--bad-flag"], "未知参数"],
    ]) {
      const parsed = parseStatsArgs(argv, "export");
      assert.strictEqual(parsed.ok, false, `应拒绝非法参数（${reason}）: ${argv.join(" ")}`);
    }

    // 4b. 合法参数 & 帮助文本
    assert.deepStrictEqual(parseStatsArgs(["--help"], "export"), {
      ok: true,
      value: { help: true },
    });
    const parsedOk = parseStatsArgs(
      ["--out", "report.xlsx", "--from", "2026-11-10", "--to", "2026-11-14"],
      "export"
    );
    assert.deepStrictEqual(parsedOk, {
      ok: true,
      value: {
        action: "export",
        out: "report.xlsx",
        from: "2026-11-10",
        to: "2026-11-14",
        json: false,
      },
    });
    const parsedEq = parseStatsArgs(
      ["--out=report2.xlsx", "--from=2026-11-10", "--to=2026-11-11", "--json"],
      "export"
    );
    assert.strictEqual(parsedEq.ok, true);
    assert.strictEqual(parsedEq.value.out, "report2.xlsx");
    assert.strictEqual(parsedEq.value.from, "2026-11-10");
    assert.strictEqual(parsedEq.value.to, "2026-11-11");
    assert.strictEqual(parsedEq.value.json, true);

    const helpTxt = statsHelpText("stats-export");
    assert.ok(helpTxt.includes("--out") && helpTxt.includes("--from") && helpTxt.includes("--to"));

    // 原有 stats / stats-work 参数解析不受影响
    assert.strictEqual(
      parseStatsArgs(["-p", "dy", "--phone", "A组"], "get").ok,
      true
    );
    assert.strictEqual(
      parseStatsArgs(["-p", "dy", "--phone", "A组"], "work").ok,
      false
    );

    // 4c. 验证 cli/index.js 退出码契约（--out 缺失 → 2、日期非法 → 2、--help → 0、正常 → 0）
    const cliOutFile = path.join(tmpRoot, "cli-export.xlsx");
    const runExportThroughStatsCli = async (argv) => {
      const parsed = parseStatsArgs(argv, "export");
      if (!parsed.ok) return { code: 2, error: parsed.error };
      if (parsed.value.help) return { code: 0, help: statsHelpText("stats-export") };
      const { res: code, logs } = await captureConsole(() => runStatsCli(parsed.value));
      return { code, json: JSON.parse(logs.join("\n")) };
    };

    assert.strictEqual((await runExportThroughStatsCli([])).code, 2);
    assert.strictEqual(
      (await runExportThroughStatsCli(["--out", cliOutFile, "--from", "2026-02-30"])).code,
      2
    );
    assert.strictEqual((await runExportThroughStatsCli(["--help"])).code, 0);

    const cliOk = await runExportThroughStatsCli([
      "--out",
      cliOutFile,
      "--from",
      "2026-11-10",
      "--to",
      "2026-11-14",
    ]);
    assert.strictEqual(cliOk.code, 0);
    assert.strictEqual(cliOk.json.success, true);
    assert.strictEqual(cliOk.json.out, path.resolve(cliOutFile));
    assert.strictEqual(cliOk.json.from, "2026-11-10");
    assert.strictEqual(cliOk.json.to, "2026-11-14");
    assert.strictEqual(cliOk.json.counts.accounts, 4);
    assert.deepStrictEqual(xlsx.readFile(cliOutFile).SheetNames, SHEET_NAMES);

    // 写入异常（目标为已存在目录）→ 退出码 1
    const dirTarget = path.join(tmpRoot, "existing-dir");
    fs.mkdirSync(dirTarget);
    const cliFail = await runExportThroughStatsCli(["--out", dirTarget]);
    assert.strictEqual(cliFail.code, 1);
    assert.strictEqual(cliFail.json.success, false);
    assert.ok(cliFail.json.error);

    // 确认 src/main/cli/index.js 已将 stats-export 接入 STATS_CMDS 体系
    const cliIndexSrc = fs.readFileSync(
      path.join(__dirname, "../src/main/cli/index.js"),
      "utf8"
    );
    assert.ok(
      cliIndexSrc.includes('"stats-export": "export"'),
      "src/main/cli/index.js 必须将 stats-export 接入 STATS_CMDS"
    );
    console.log("✓ CLI stats-export 参数解析、退出码契约（0/1/2）与导出验证全部通过");

    // 恢复 require.cache
    if (origElectronCache) require.cache[electronId] = origElectronCache;
    else delete require.cache[electronId];
    if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
    else delete require.cache[collectorId];
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log("\ntest-stats-export: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
