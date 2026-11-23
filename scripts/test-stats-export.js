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
const vm = require("vm");
const xlsx = require("xlsx");
const vueCompiler = require("vue-template-compiler");

// 先不 mock electron 加载 statsExport，验证注入依赖模式下不强依赖 Electron
const statsExportPath = path.resolve(
  __dirname,
  "../src/main/services/dataStats/statsExport.js"
);
const statsExport = require(statsExportPath);
const {
  SHEET_NAMES,
  MAX_SHEET_ROWS,
  ROW_LIMIT_EXCEEDED_CODE,
  WORK_DAILY_HEADERS,
  WORK_INTRADAY_HEADERS,
  PLATFORM_DAILY_HEADERS,
  ACCOUNT_DAILY_HEADERS,
  SCHEMA_HEADERS,
  META_HEADERS,
  sanitizeTextCell,
  buildDefaultExportFileName,
  resolveDefaultCutoffDate,
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
        "作品时段明细",
        "作品跨平台汇总",
        "平台日汇总",
        "账号日快照",
        "分析",
        "字段说明",
        "导出信息",
      ]);
      assert.strictEqual(emptyData.to, "2026-11-19");
      assert.strictEqual(emptyData.from, "2026-10-21", "默认 from 应为 to 往前 29 天");
      assert.strictEqual(emptyData.analysisPeriod, 30, "默认导出分析周期应为 30 天");
      assert.strictEqual(emptyData.sheets["作品日明细"].length, 1);
      assert.strictEqual(emptyData.sheets["作品时段明细"].length, 1);
      assert.deepStrictEqual(emptyData.sheets["作品时段明细"][0], WORK_INTRADAY_HEADERS);
      assert.strictEqual(emptyData.sheets["作品跨平台汇总"].length, 1);
      assert.strictEqual(emptyData.sheets["平台日汇总"].length, 1);
      assert.strictEqual(emptyData.sheets["账号日快照"].length, 1);
      assert.ok(emptyData.sheets["分析"].length > 10, "分析 sheet 应含小结与各节结构");
      assert.ok(emptyData.sheets["字段说明"].length > 45);
      assert.strictEqual(emptyData.sheets["导出信息"].length, 9);
      // P3：无动态列时，字段说明不得包含不存在的动态列占位符，且与单表 sheet 实际表头 1:1 严格一致
      const emptySchemaRows = emptyData.sheets["字段说明"].slice(1);
      assert.strictEqual(
        emptySchemaRows.some((r) => String(r[1]).includes("<平台>")),
        false,
        "无动态列时字段说明不应包含占位列"
      );
      for (const sheetName of SHEET_NAMES) {
        if (sheetName === "分析") {
          const analysisDocs = emptySchemaRows.filter((r) => r[0] === "分析");
          assert.ok(analysisDocs.length >= 6, "字段说明应覆盖分析 sheet 各节口径");
          continue;
        }
        const expectedCols = emptyData.sheets[sheetName][0];
        const documentedCols = emptySchemaRows
          .filter((r) => r[0] === sheetName)
          .map((r) => r[1]);
        assert.deepStrictEqual(
          documentedCols,
          expectedCols,
          `空数据下字段说明与 ${sheetName} 实际表头必须 1:1 一致`
        );
      }
      assert.deepStrictEqual(emptyData.counts, {
        accounts: 0,
        works: 0,
        contents: 0,
        unlinkedWorks: 0,
        workDailyRows: 0,
        workIntradayRows: 0,
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
      // \r 统一为 \n（避免 xlsx 写出字面量 _x000d_），仍保留防注入前缀
      assert.strictEqual(sanitizeTextCell("\rformula"), "'\nformula");
      assert.strictEqual(sanitizeTextCell("标题\r\n正文"), "标题\n正文");
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
    // A组 · 抖音（本样例故意将 favorite 置 null 以测试空单元格与全空求和，实际抖音适配器输出 favorite_count；有 fansDelta）
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
    assert.strictEqual(s1[0][4], "关联方式");
    assert.strictEqual(s1[0][5], "匹配分数");
    const s1Rows = s1.slice(1);
    const findS1 = (date, platform, group, workId) =>
      s1Rows.find(
        (r) => r[0] === date && r[1] === platform && r[2] === group && r[6] === workId
      );

    // DY1 Day1 (2026-11-10)：关联 link，匹配分数为空，首次记录日增与断档均为空，公式标题前置单引号
    const dy1d1 = findS1("2026-11-10", "抖音", "A组", "DY1");
    assert.ok(dy1d1, "应含 DY1 11-10 行");
    assert.strictEqual(dy1d1[3], "file:/videos/dish1.mp4");
    assert.strictEqual(dy1d1[4], "link");
    assert.strictEqual(dy1d1[5], null, "link 关联匹配分数应为空");
    assert.strictEqual(dy1d1[7], "'=SUM(A1:A2) 红烧肉教程", "= 开头标题应前置单引号");
    assert.strictEqual(dy1d1[9], "2026-11-09", "发布日期应为 YYYY-MM-DD");
    assert.strictEqual(dy1d1[10], 100);
    assert.strictEqual(dy1d1[14], null, "抖音收藏为空单元格");
    assert.strictEqual(dy1d1[16], null, "首次记录播放日增应为空");
    assert.strictEqual(dy1d1[22], null, "首次记录断档天数应为空");

    // DY1 Day2 (2026-11-11)：连续一天 gapDays=0，playDelta=160，fansDeltaDelta=-2（负数 number）
    const dy1d2 = findS1("2026-11-11", "抖音", "A组", "DY1");
    assert.ok(dy1d2);
    assert.strictEqual(dy1d2[16], 160);
    assert.strictEqual(dy1d2[17], 15);
    assert.strictEqual(dy1d2[18], 3);
    assert.strictEqual(dy1d2[19], 2);
    assert.strictEqual(dy1d2[20], null);
    assert.strictEqual(typeof dy1d2[21], "number");
    assert.strictEqual(dy1d2[21], -2, "负日增必须保持数字类型且不前置单引号");
    assert.strictEqual(dy1d2[22], 0, "连续两天断档天数应为 0");

    // DY1 Day5 (2026-11-14)：断档 2 天，playDelta = 500 - 260 = 240
    const dy1d5 = findS1("2026-11-14", "抖音", "A组", "DY1");
    assert.ok(dy1d5);
    assert.strictEqual(dy1d5[16], 240);
    assert.strictEqual(dy1d5[21], 7);
    assert.strictEqual(dy1d5[22], 2, "11-11 到 11-14 断档天数应为 2");

    // 未关联作品 DY2 / KS2：内容ID、关联方式、匹配分数为空，+ / @ 开头标题前置单引号，真实 0 保持 number
    const dy2d1 = findS1("2026-11-10", "抖音", "A组", "DY2");
    assert.strictEqual(dy2d1[3], null, "未关联作品内容ID应为空");
    assert.strictEqual(dy2d1[4], null, "未关联作品关联方式应为空");
    assert.strictEqual(dy2d1[5], null, "未关联作品匹配分数应为空");
    assert.strictEqual(dy2d1[7], "'+123 独立视频");
    assert.strictEqual(dy2d1[13], 0, "真实 0 应保留为 number 0");

    const dy3d1 = findS1("2026-11-10", "抖音", "B组", "DY3");
    assert.strictEqual(dy3d1[7], "'-测试视频");

    const ks2d2 = findS1("2026-11-11", "快手", "B组", "KS2");
    assert.strictEqual(ks2d2[7], "'@用户 独立视频");
    assert.strictEqual(ks2d2[10], 0, "快手 play=0 应为数字 0");
    assert.strictEqual(ks2d2[13], null, "快手分享缺项为空");
    assert.strictEqual(ks2d2[14], null, "快手收藏缺项为空");
    assert.strictEqual(ks2d2[15], null, "快手涨粉缺项为空");

    // KS1 通过标题归一化关联到 dish1
    const ks1d2 = findS1("2026-11-11", "快手", "A组", "KS1");
    assert.strictEqual(ks1d2[3], "file:/videos/dish1.mp4");
    assert.strictEqual(ks1d2[4], "title");
    assert.strictEqual(ks1d2[5], null, "title 关联匹配分数应为空");
    assert.strictEqual(ks1d2[16], 120);

    // 验证 Sheet 2：作品跨平台汇总（截至 2026-11-14）
    const s2 = wbData.sheets["作品跨平台汇总"];
    assert.deepStrictEqual(s2[0], [
      "内容ID",
      "标题",
      "素材文件",
      "首发日期",
      "覆盖平台数",
      "匹配方式",
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
    assert.strictEqual(dish1Row[5], "title", "dish1 含 link+title，簇内最弱方式应为 title");
    assert.strictEqual(dish1Row[6], 500 + 700, "总播放 = DY1(500) + KS1(700)");
    assert.strictEqual(dish1Row[7], 60 + 55);
    assert.strictEqual(dish1Row[8], 12 + 11);
    assert.strictEqual(dish1Row[9], 8, "总分享仅抖音有值 8");
    assert.strictEqual(dish1Row[10], null, "总收藏两平台全空应为空单元格");
    assert.strictEqual(dish1Row[11], 10, "总涨粉仅抖音有值 10");
    assert.strictEqual(dish1Row[12], 500, "抖音·A组·播放");
    assert.strictEqual(dish1Row[13], 60, "抖音·A组·点赞");
    assert.strictEqual(dish1Row[14], 12, "抖音·A组·评论");
    assert.strictEqual(dish1Row[15], null, "抖音·B组 无此作品应为空");
    assert.strictEqual(dish1Row[18], 700, "快手·A组·播放");
    assert.strictEqual(dish1Row[19], 55, "快手·A组·点赞");
    assert.strictEqual(dish1Row[20], 11, "快手·A组·评论");
    assert.strictEqual(
      dish1Row[24],
      "https://www.douyin.com/video/1001\nhttps://www.kuaishou.com/short-video/ks1",
      "多条作品链接应用换行连接"
    );
    const b1Row = s2.slice(1).find((r) => r[0] === "file:/videos/b1.mp4");
    assert.strictEqual(b1Row[1], "'-测试视频", "跨平台汇总标题应同样防公式注入");
    assert.strictEqual(b1Row[5], "link", "b1 仅直链匹配应标 link");
    const unlinkedDy2 = s2.slice(1).find((r) => r[0] === "unlinked:抖音:DY2");
    assert.strictEqual(unlinkedDy2[1], "'+123 独立视频");
    assert.strictEqual(unlinkedDy2[5], null, "未关联行匹配方式应为空");
    const unlinkedKs2 = s2.slice(1).find((r) => r[0] === "unlinked:快手:KS2");
    assert.strictEqual(unlinkedKs2[1], "'@用户 独立视频");
    assert.strictEqual(unlinkedKs2[5], null);

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

    // 验证 Sheet 5：字段说明包含每个 sheet 每列与全部必需口径（按 adapters.js 实际输出核对）
    const s5 = wbData.sheets["字段说明"];
    assert.deepStrictEqual(s5[0], SCHEMA_HEADERS);
    const s5Text = s5.slice(1).map((r) => r.join(" ")).join("\n");
    for (const kw of [
      "累计值",
      "日增",
      "断档天数 > 0",
      "采集日期（YYYY-MM-DD，UTC+8）",
      "T+1 延迟",
      "抖音当天",
      "同一账号挂多个分组时会出现重复行",
      "日期+平台+作品ID",
      "快手、头条无分享",
      "仅快手无收藏",
      "favorite_count",
      "repinCount",
      "仅抖音、视频号有单作品涨粉",
      "哔哩哔哩、百家号、头条、快手、小红书无单作品涨粉",
      "fansHistory",
      "历史回填日",
      "为空不是 0",
      "适配器可能把缺失指标写成 0",
      "同组同平台",
      "启用本功能当天开始积累",
      "匹配分数",
      "匹配方式",
      "UTC+8 日历日相差 ≤2 天",
      "模糊匹配可能合错，已手工确认的标 manual",
      "互动率公式",
      "环比",
      "D1/D3/D7",
      "分类阈值",
      "异常规则",
      "剔除说明",
      "analysisPeriod",
    ]) {
      assert.ok(s5Text.includes(kw), `字段说明缺少关键口径：${kw}`);
    }
    assert.strictEqual(
      s5Text.includes("抖音无收藏"),
      false,
      "抖音适配器实际输出 favorite_count，字段说明不得误写抖音无收藏"
    );
    assert.strictEqual(
      s5Text.includes("头条无收藏"),
      false,
      "头条适配器实际输出 repinCount，字段说明不得误写头条无收藏"
    );
    // 校验所有单表 sheet 的表头与字段说明 1:1 严格一致，分析 sheet 具备完整口径条目
    for (const sheetName of SHEET_NAMES) {
      if (sheetName === "分析") {
        const analysisDocs = s5.slice(1).filter((r) => r[0] === "分析");
        assert.ok(analysisDocs.length >= 6, "字段说明必须记录分析 sheet 各节口径");
        continue;
      }
      const headers = wbData.sheets[sheetName][0];
      const documented = s5
        .slice(1)
        .filter((r) => r[0] === sheetName)
        .map((r) => r[1]);
      assert.deepStrictEqual(
        documented,
        headers,
        `字段说明与 ${sheetName} 实际表头必须 1:1 一致`
      );
    }

    // 验证 Sheet 5：分析（在字段说明前，首块为文字小结，其后长表数值为 number）
    assert.strictEqual(
      wbData.sheetOrder.indexOf("分析"),
      wbData.sheetOrder.indexOf("字段说明") - 1,
      "分析 sheet 必须紧挨在字段说明之前"
    );
    const sAnalysis = wbData.sheets["分析"];
    assert.strictEqual(sAnalysis[0][0], "文字小结", "分析 sheet 首块应为文字小结");
    const overviewPlayRow = sAnalysis.find((r) => r[0] === "播放");
    assert.ok(overviewPlayRow, "分析 sheet 应含总览播放行");
    assert.strictEqual(typeof overviewPlayRow[1], "number", "分析 sheet 本周期播放日增应为 number");
    assert.strictEqual(overviewPlayRow[1], 160 + 240 + 40 + 60 + 110 + 120 + 280);

    // 验证 Sheet 7：导出信息（含 analysisPeriod）
    const s6 = wbData.sheets["导出信息"];
    assert.deepStrictEqual(s6[0], META_HEADERS);
    const s6Map = new Map(s6.slice(1).map((r) => [r[0], r[1]]));
    assert.strictEqual(s6Map.get("日期范围"), "2026-10-16 ~ 2026-11-14");
    assert.strictEqual(s6Map.get("应用版本"), "0.14.9-fork.test");
    assert.strictEqual(s6Map.get("账号数"), 4);
    assert.strictEqual(s6Map.get("作品数"), 5);
    assert.strictEqual(s6Map.get("内容数"), 4);
    assert.strictEqual(s6Map.get("未关联作品数"), 2);
    assert.strictEqual(s6Map.get("analysisPeriod"), 30);

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
      if (cell(0).v === "2026-11-11" && cell(1).v === "抖音" && cell(6).v === "DY1") {
        checkedDy1D2 = true;
        assert.strictEqual(cell(5), undefined, "link 关联匹配分数必须为空单元格");
        assert.strictEqual(cell(7).t, "s");
        assert.strictEqual(cell(7).v, "'=SUM(A1:A2) 红烧肉教程");
        assert.strictEqual(cell(9).t, "s");
        assert.strictEqual(cell(9).v, "2026-11-09");
        assert.strictEqual(cell(10).t, "n");
        assert.strictEqual(cell(10).v, 260);
        assert.strictEqual(cell(14), undefined, "抖音收藏空值必须为空单元格");
        assert.strictEqual(cell(16).t, "n");
        assert.strictEqual(cell(16).v, 160);
        assert.strictEqual(cell(21).t, "n");
        assert.strictEqual(cell(21).v, -2);
        assert.strictEqual(cell(22).t, "n");
        assert.strictEqual(cell(22).v, 0);
      }
      if (cell(0).v === "2026-11-11" && cell(1).v === "快手" && cell(6).v === "KS2") {
        checkedKs2D2 = true;
        assert.strictEqual(cell(3), undefined, "未关联内容ID为空单元格");
        assert.strictEqual(cell(4), undefined, "未关联方式为空单元格");
        assert.strictEqual(cell(5), undefined, "未关联匹配分数为空单元格");
        assert.strictEqual(cell(7).v, "'@用户 独立视频");
        assert.strictEqual(cell(10).t, "n");
        assert.strictEqual(cell(10).v, 0, "真实 0 读回必须为数字 0");
        assert.strictEqual(cell(13), undefined, "快手分享为空单元格");
      }
    }
    assert.ok(checkedDy1D2 && checkedKs2D2, "读回校验应命中目标行");

    // 读回检查 Sheet「分析」存在、顺序在字段说明前、数值单元格为 number 类型
    assert.strictEqual(
      readWb.SheetNames.indexOf("分析"),
      readWb.SheetNames.indexOf("字段说明") - 1,
      "读回 xlsx 中「分析」sheet 必须在「字段说明」之前"
    );
    const wsAnalysis = readWb.Sheets["分析"];
    assert.ok(wsAnalysis && wsAnalysis["!ref"], "读回 xlsx 必须包含「分析」sheet");
    const wsAnalysisRange = xlsx.utils.decode_range(wsAnalysis["!ref"]);
    let analysisNumberCellCount = 0;
    let foundPlayOverviewNum = false;
    for (let r = 0; r <= wsAnalysisRange.e.r; r++) {
      const c0 = wsAnalysis[xlsx.utils.encode_cell({ r, c: 0 })];
      const c1 = wsAnalysis[xlsx.utils.encode_cell({ r, c: 1 })];
      if (c0 && c0.v === "播放" && c1) {
        assert.strictEqual(c1.t, "n", "「分析」sheet 总览播放日增必须为数字类型");
        assert.strictEqual(c1.v, 1010);
        foundPlayOverviewNum = true;
      }
      for (let c = 0; c <= wsAnalysisRange.e.c; c++) {
        const cell = wsAnalysis[xlsx.utils.encode_cell({ r, c })];
        if (cell && cell.t === "n") analysisNumberCellCount += 1;
      }
    }
    assert.ok(foundPlayOverviewNum, "应读回「分析」sheet 总览播放日增数值");
    assert.ok(analysisNumberCellCount >= 10, "「分析」sheet 应包含多个 number 类型数值单元格");

    // 读回检查 Sheet 7 导出信息数值类型（含 analysisPeriod）
    const ws6 = readWb.Sheets["导出信息"];
    assert.strictEqual(ws6.B5.t, "n", "导出信息账号数必须为数字类型");
    assert.strictEqual(ws6.B5.v, 4);
    assert.strictEqual(ws6.B6.t, "n");
    assert.strictEqual(ws6.B6.v, 5);
    assert.strictEqual(ws6.A9.v, "analysisPeriod");
    assert.strictEqual(ws6.B9.t, "n", "导出信息 analysisPeriod 必须为数字类型");
    assert.strictEqual(ws6.B9.v, 30);

    // 2.5 from/to 过滤 + groups 过滤（含导出区间 <30 天时 analysisPeriod 自动缩为区间天数）
    const filtered = buildStatsWorkbookData({
      from: "2026-11-11",
      to: "2026-11-11",
    });
    assert.strictEqual(filtered.from, "2026-11-11");
    assert.strictEqual(filtered.to, "2026-11-11");
    assert.strictEqual(filtered.analysisPeriod, 1, "单日导出区间 analysisPeriod 应为 1");
    const filteredMetaMap = new Map(filtered.sheets["导出信息"].slice(1).map((r) => [r[0], r[1]]));
    assert.strictEqual(filteredMetaMap.get("analysisPeriod"), 1);

    const filtered5d = buildStatsWorkbookData({
      from: "2026-11-10",
      to: "2026-11-14",
    });
    assert.strictEqual(filtered5d.analysisPeriod, 5, "5 天导出区间 analysisPeriod 应为 5");
    const fS1Rows = filtered.sheets["作品日明细"].slice(1);
    assert.ok(fS1Rows.length > 0);
    assert.ok(fS1Rows.every((r) => r[0] === "2026-11-11"), "Sheet 1 应仅保留 11-11 行");
    const fDy1 = fS1Rows.find((r) => r[6] === "DY1");
    assert.strictEqual(fDy1[16], 160, "过滤 from 后首日仍应相对 11-10 计算日增");
    const fDish1 = filtered.sheets["作品跨平台汇总"]
      .slice(1)
      .find((r) => r[0] === "file:/videos/dish1.mp4");
    assert.strictEqual(
      fDish1[6],
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
    let exportHandler = ipcHandlers.get("stats:export-xlsx");
    let summaryHandler = ipcHandlers.get("stats:get-content-summary");
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
      assert.strictEqual(r.ok, false, `外部来源 ${url} 必须被导出 IPC 拒绝`);
      const sr = await summaryHandler({ sender: {}, senderFrame: { url } }, {});
      assert.ok(sr.error, `外部来源 ${url} 必须被作品汇总 IPC 拒绝`);
      assert.deepStrictEqual(sr.rows, []);
    }
    const noFrameSum = await summaryHandler({}, {});
    assert.ok(noFrameSum.error, "无 senderFrame 的作品汇总请求必须被拒绝");
    assert.deepStrictEqual(noFrameSum.rows, []);

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

    // 3b. P1：对话框取消时不读任何数据（mock 读函数计数必须全为 0）
    {
      const readCounts = {
        listAccounts: 0,
        readWorks: 0,
        readWorksDaily: 0,
        readDaily: 0,
        readPushRecords: 0,
      };
      registerDataStatsIpc({
        exportDeps: {
          listAccounts: () => {
            readCounts.listAccounts += 1;
            return [];
          },
          readWorks: () => {
            readCounts.readWorks += 1;
            return { works: [] };
          },
          readWorksDaily: () => {
            readCounts.readWorksDaily += 1;
            return Object.create(null);
          },
          readDaily: () => {
            readCounts.readDaily += 1;
            return {};
          },
          readPushRecords: () => {
            readCounts.readPushRecords += 1;
            return [];
          },
        },
      });
      const spyExport = ipcHandlers.get("stats:export-xlsx");
      const spySummary = ipcHandlers.get("stats:get-content-summary");

      // 外部来源调用 summary 也不读数据
      const extSum = await spySummary(
        { sender: {}, senderFrame: { url: "https://evil.example.com" } },
        {}
      );
      assert.ok(extSum.error);
      assert.deepStrictEqual(readCounts, {
        listAccounts: 0,
        readWorks: 0,
        readWorksDaily: 0,
        readDaily: 0,
        readPushRecords: 0,
      });

      // 取消保存（带日期范围 + 不带日期范围）均不读任何数据
      mockDialogResult = { canceled: true, filePath: "" };
      const cancelWithRange = await spyExport(
        { sender: {}, senderFrame: { url: "http://localhost:9080/#/dataStats" } },
        { from: "2026-11-10", to: "2026-11-14" }
      );
      assert.deepStrictEqual(cancelWithRange, { ok: false, canceled: true });
      assert.strictEqual(
        saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath,
        path.join(docsDir, "MatrixMedia-作品数据-2026-11-10_2026-11-14.xlsx")
      );

      const cancelNoRange = await spyExport(
        { sender: {}, senderFrame: { url: "file:///app/index.html" } },
        {}
      );
      assert.deepStrictEqual(cancelNoRange, { ok: false, canceled: true });
      assert.deepStrictEqual(
        readCounts,
        {
          listAccounts: 0,
          readWorks: 0,
          readWorksDaily: 0,
          readDaily: 0,
          readPushRecords: 0,
        },
        "对话框取消时不得读取任何本地数据"
      );

      // 确认保存后才读数据
      const spyOutFile = path.join(tmpRoot, "spy-confirmed.xlsx");
      mockDialogResult = { canceled: false, filePath: spyOutFile };
      const confirmRes = await spyExport(
        { sender: {}, senderFrame: { url: "file:///app/index.html" } },
        { from: "2026-11-10", to: "2026-11-14" }
      );
      assert.strictEqual(confirmRes.ok, true);
      assert.strictEqual(readCounts.listAccounts, 1, "确认保存后应读取账号列表");
      assert.strictEqual(readCounts.readPushRecords, 1, "确认保存后应读取发布记录");
      assert.ok(fs.existsSync(spyOutFile));

      // 恢复真实 store 绑定的 IPC handler
      registerDataStatsIpc();
      exportHandler = ipcHandlers.get("stats:export-xlsx");
      summaryHandler = ipcHandlers.get("stats:get-content-summary");
    }

    // 3c. 正常导出成功 + P2：原样使用对话框返回路径（含尾部空格不做 trim）
    const ipcOutFile = path.join(tmpRoot, "ipc-exported.xlsx");
    mockDialogResult = { canceled: false, filePath: ipcOutFile };
    const okRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      {}
    );
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.filePath, ipcOutFile);
    assert.strictEqual(okRes.from, "2026-10-16");
    assert.strictEqual(okRes.to, "2026-11-14");
    assert.strictEqual(okRes.counts.accounts, 4);
    assert.strictEqual(okRes.counts.works, 5);
    assert.strictEqual(
      saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath,
      path.join(docsDir, buildDefaultExportFileName("", ""))
    );
    assert.deepStrictEqual(xlsx.readFile(ipcOutFile).SheetNames, SHEET_NAMES);

    const trailingSpacePath = path.join(tmpRoot, "trailing-space.xlsx ");
    mockDialogResult = { canceled: false, filePath: trailingSpacePath };
    const spaceRes = await exportHandler(
      { sender: {}, senderFrame: { url: "file:///app/index.html" } },
      { from: "2026-11-10", to: "2026-11-14" }
    );
    assert.strictEqual(spaceRes.ok, true);
    assert.strictEqual(spaceRes.filePath, trailingSpacePath);
    assert.strictEqual(
      fs.existsSync(trailingSpacePath),
      true,
      "GUI 导出必须原样写入对话框返回路径（保留尾部空格）"
    );
    assert.strictEqual(
      fs.existsSync(trailingSpacePath.trim()),
      false,
      "不得 trim 改写对话框返回路径"
    );

    // 3d. stats:get-content-summary（本地页面校验通过 + 跳过截止日之后的文件 + 不读 daily）
    const localEv = { sender: {}, senderFrame: { url: "file:///app/index.html" } };
    const sumRes = await summaryHandler(localEv, {});
    assert.strictEqual(sumRes.date, "2026-11-14");
    assert.strictEqual(sumRes.rows.length, 4);
    const sumLocalhost = await summaryHandler(
      { sender: {}, senderFrame: { url: "http://localhost:9080/#/dataStats" } },
      { date: "2026-11-11" }
    );
    assert.strictEqual(sumLocalhost.date, "2026-11-11");
    assert.strictEqual(
      sumLocalhost.rows.find((r) => r.contentKey === "file:/videos/dish1.mp4").totalPlay,
      680
    );
    const sumBad = await summaryHandler(localEv, { date: "2026-99-99" });
    assert.ok(sumBad.error);
    assert.deepStrictEqual(sumBad.rows, []);

    // 验证 stats:get-content-summary 仅读截止日所需文件：在 2026-11-25 放损坏 JSON，查询 <= 2026-11-11 不应触发打开/告警
    {
      const futureBadFile = path.join(
        userDataDir,
        "data-stats",
        "A组",
        "抖音",
        "works-daily",
        "2026-11-25.json"
      );
      fs.writeFileSync(futureBadFile, "{broken json", "utf8");
      const warns = [];
      const origWarn = console.warn;
      console.warn = (...a) => warns.push(a.join(" "));
      try {
        const res11 = buildContentSummaryData({ date: "2026-11-11" });
        assert.strictEqual(res11.date, "2026-11-11");
        assert.strictEqual(
          warns.length,
          0,
          "查询 date=2026-11-11 不应打开/解析 2026-11-25.json"
        );
      } finally {
        console.warn = origWarn;
        fs.rmSync(futureBadFile, { force: true });
      }
    }
    console.log("✓ IPC stats:export-xlsx（取消不读数据/安全校验/原样路径/导出）与 stats:get-content-summary 通过");

    /* ---------- 4. P1 行上限测试（可注入阈值 maxRows） ---------- */
    {
      assert.strictEqual(MAX_SHEET_ROWS, 200000);
      // 造 15 个作品 × 8 天 = 120 条作品日明细
      const works15 = [];
      const daily120 = Object.create(null);
      for (let w = 1; w <= 15; w++) {
        const wid = `W${w}`;
        works15.push({
          workId: wid,
          title: `作品 ${w}`,
          url: `https://www.douyin.com/video/${w}`,
          publishTime: dayTs("2026-11-01"),
          play: 100 * w,
          like: 10,
          comment: 1,
          share: 1,
          favorite: 2,
          fansDelta: 1,
        });
        daily120[wid] = {};
        for (let d = 1; d <= 8; d++) {
          const ymd = `2026-11-${String(d).padStart(2, "0")}`;
          daily120[wid][ymd] = {
            play: 100 * w + d * 10,
            like: 10 + d,
            comment: 1,
            share: 1,
            favorite: 2,
            fansDelta: 1,
          };
        }
      }
      const bigDeps = {
        listAccounts: () => [{ group: "大表组", platform: "抖音" }],
        readWorks: () => ({ works: works15 }),
        readWorksDaily: () => daily120,
        readDaily: () => ({}),
        readPushRecords: () => [],
      };

      // 恰好等于上限（120 <= 120）应通过
      const passData = buildStatsWorkbookData(
        { from: "2026-11-01", to: "2026-11-08", maxRows: 120 },
        bigDeps
      );
      assert.strictEqual(passData.counts.workDailyRows, 120);

      // 超过上限（120 > 119）应直接拒绝且消息精确匹配
      assert.throws(
        () =>
          buildStatsWorkbookData(
            { from: "2026-11-01", to: "2026-11-08", maxRows: 119 },
            bigDeps
          ),
        (err) => {
          assert.strictEqual(err.code, ROW_LIMIT_EXCEEDED_CODE);
          assert.strictEqual(
            err.message,
            "数据量过大（120 行），请缩小日期范围后再导出"
          );
          return true;
        }
      );

      // writeStatsXlsx 兜底校验：超限时拒绝且绝不建目录/不写文件
      const blockedXlsx = path.join(tmpRoot, "never-created-dir", "too-big.xlsx");
      assert.throws(
        () => writeStatsXlsx(passData, blockedXlsx, { maxRows: 119 }),
        (err) => {
          assert.strictEqual(err.code, ROW_LIMIT_EXCEEDED_CODE);
          assert.strictEqual(
            err.message,
            "数据量过大（120 行），请缩小日期范围后再导出"
          );
          return true;
        }
      );
      assert.strictEqual(fs.existsSync(blockedXlsx), false, "超限时不得写出文件");
      assert.strictEqual(
        fs.existsSync(path.dirname(blockedXlsx)),
        false,
        "超限时不得创建目标目录"
      );

      // IPC 层超限拒绝且不写文件
      registerDataStatsIpc({ exportMaxRows: 119, exportDeps: bigDeps });
      const limitExportHandler = ipcHandlers.get("stats:export-xlsx");
      const ipcBlockedFile = path.join(tmpRoot, "ipc-blocked.xlsx");
      mockDialogResult = { canceled: false, filePath: ipcBlockedFile };
      const ipcLimitRes = await limitExportHandler(localEv, {
        from: "2026-11-01",
        to: "2026-11-08",
      });
      assert.deepStrictEqual(ipcLimitRes, {
        ok: false,
        message: "数据量过大（120 行），请缩小日期范围后再导出",
      });
      assert.strictEqual(fs.existsSync(ipcBlockedFile), false, "IPC 超限时不得写文件");

      // 恢复真实 IPC handler
      registerDataStatsIpc();
      exportHandler = ipcHandlers.get("stats:export-xlsx");
      summaryHandler = ipcHandlers.get("stats:get-content-summary");
      console.log("✓ P1 单表行上限（构建前计数 / writeStatsXlsx / IPC 拒绝不写盘）通过");
    }

    /* ---------- 5. P2 跨组同作品去重（平台日汇总 + 导出信息 + 作品日明细保留） ---------- */
    {
      // 同一抖音账号同时挂在 B组 和 A组（故意把 B组 排在前面验证按分组名排序取第一组 A组）
      // DY_DUP：只有 A组 有发布记录；Day1=100，Day2 A组=120(+20) / B组=125(+25)
      // DY_UNL：两组均无发布记录；Day1=50，Day2 A组=70(+20) / B组=75(+25)
      const dupDeps = {
        listAccounts: () => [
          { group: "B组", platform: "抖音" },
          { group: "A组", platform: "抖音" },
        ],
        readWorks: (group) => ({
          works: [
            {
              workId: "DY_DUP",
              title: "跨组同作品",
              url: "https://www.douyin.com/video/9001",
              publishTime: dayTs("2026-11-10"),
              play: group === "A组" ? 120 : 125,
              like: 10,
              comment: 2,
              share: 1,
              favorite: 3,
              fansDelta: 1,
            },
            {
              workId: "DY_UNL",
              title: "跨组未关联作品",
              url: "https://www.douyin.com/video/9002",
              publishTime: dayTs("2026-11-10"),
              play: group === "A组" ? 70 : 75,
              like: 5,
              comment: 1,
              share: 0,
              favorite: 1,
              fansDelta: 0,
            },
          ],
        }),
        readWorksDaily: (group) => ({
          DY_DUP: {
            "2026-11-10": { play: 100, like: 8, comment: 1, share: 0, favorite: 2, fansDelta: 0 },
            "2026-11-11": {
              play: group === "A组" ? 120 : 125,
              like: group === "A组" ? 10 : 12,
              comment: 2,
              share: 1,
              favorite: 3,
              fansDelta: 1,
            },
          },
          DY_UNL: {
            "2026-11-10": { play: 50, like: 4, comment: 0, share: 0, favorite: 1, fansDelta: 0 },
            "2026-11-11": {
              play: group === "A组" ? 70 : 75,
              like: 5,
              comment: 1,
              share: 0,
              favorite: 1,
              fansDelta: 0,
            },
          },
        }),
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "dup-p1",
            pt: "抖音",
            group: "A组",
            publishStatus: "success",
            title: "跨组同作品",
            filePath: "/videos/dup.mp4",
            videoLink: "https://www.douyin.com/video/9001",
            lastPublishAt: dayTs("2026-11-10"),
          },
        ],
      };

      const dupWb = buildStatsWorkbookData({ now: dayTs("2026-11-12") }, dupDeps);
      // 作品日明细保留分组明细不去重：2天 × 2组 × 2作品 = 8 行
      assert.strictEqual(dupWb.counts.workDailyRows, 8, "作品日明细应保留分组明细不去重");

      // 平台日汇总按「日期+平台+作品ID」去重，取分组名排序第一组（A组）
      const dupS3 = dupWb.sheets["平台日汇总"].slice(1);
      const dupD10 = dupS3.find((r) => r[0] === "2026-11-10" && r[1] === "抖音");
      const dupD11 = dupS3.find((r) => r[0] === "2026-11-11" && r[1] === "抖音");
      assert.strictEqual(dupD10[2], 2, "Day1 有数据作品数应去重为 2（而非 4）");
      assert.strictEqual(dupD11[2], 2, "Day2 有数据作品数应去重为 2（而非 4）");
      assert.strictEqual(
        dupD11[3],
        20 + 20,
        "Day2 播放日增合计应取 A组 观测（20+20=40），不得重复累加 B组"
      );
      assert.strictEqual(dupD11[4], 2 + 1, "Day2 点赞日增合计应取 A组 观测（2+1=3）");

      // 导出信息作品数/未关联作品数沿用跨平台汇总去重与关联口径：
      // DY_DUP 已由 A组 关联，不计入未关联；DY_UNL 去重计 1 个未关联
      assert.strictEqual(dupWb.counts.works, 2, "作品数应跨组去重为 2");
      assert.strictEqual(dupWb.counts.unlinkedWorks, 1, "仅 DY_UNL 为未关联（应为 1，非 3）");
      assert.strictEqual(dupWb.counts.contents, 2, "内容数应为 2（dup.mp4 + unlinked:DY_UNL）");

      const dupSummary = buildContentSummaryData({}, dupDeps);
      assert.strictEqual(dupSummary.counts.works, 2);
      assert.strictEqual(dupSummary.counts.unlinkedWorks, 1);
      assert.strictEqual(dupSummary.counts.contents, 2);
      console.log("✓ P2 跨组同作品去重（平台日汇总取首组 + 导出信息沿用跨平台汇总口径）通过");
    }

    /* ---------- 6. P2 统一 cutoff（最新快照 11-18，11-19 新发布不泄漏） ---------- */
    {
      let readDailyCalls = 0;
      const cutoffDeps = {
        listAccounts: () => [{ group: "主组", platform: "抖音" }],
        readWorks: () => ({
          works: [
            {
              workId: "W18",
              title: "18日作品",
              url: "https://www.douyin.com/video/18",
              publishTime: dayTs("2026-11-18"),
              play: 300,
              like: 30,
              comment: 3,
              share: 2,
              favorite: 5,
              fansDelta: 1,
            },
            {
              workId: "W19",
              title: "19日新作品",
              url: "https://www.douyin.com/video/19",
              publishTime: dayTs("2026-11-19"),
              play: 10,
              like: 1,
              comment: 0,
              share: 0,
              favorite: 0,
              fansDelta: 0,
            },
          ],
        }),
        readWorksDaily: () => ({
          W18: {
            "2026-11-18": { play: 300, like: 30, comment: 3, share: 2, favorite: 5, fansDelta: 1 },
          },
        }),
        readDaily: () => {
          readDailyCalls += 1;
          return { "2026-11-18": { fans: 100, plays: 300 } };
        },
        readPushRecords: () => [
          {
            id: "r18",
            pt: "抖音",
            group: "主组",
            publishStatus: "success",
            title: "18日作品",
            filePath: "/videos/v18.mp4",
            videoLink: "https://www.douyin.com/video/18",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "r19",
            pt: "抖音",
            group: "主组",
            publishStatus: "success",
            title: "19日新作品",
            filePath: "/videos/v19.mp4",
            videoLink: "https://www.douyin.com/video/19",
            lastPublishAt: dayTs("2026-11-19"),
          },
        ],
      };

      const sumDefault = buildContentSummaryData({}, cutoffDeps);
      assert.strictEqual(readDailyCalls, 0, "worksDaily 有快照时 buildContentSummaryData 不应读取 daily");
      assert.strictEqual(sumDefault.date, "2026-11-18", "缺省 cutoff 应解析为最新快照日 11-18");
      assert.strictEqual(sumDefault.rows.length, 1, "截至 11-18 不应包含 11-19 新发布记录");
      assert.strictEqual(sumDefault.rows[0].contentKey, "file:/videos/v18.mp4");
      assert.strictEqual(sumDefault.counts.works, 1);

      const wbDefault = buildStatsWorkbookData({ now: dayTs("2026-11-19") }, cutoffDeps);
      assert.strictEqual(wbDefault.to, "2026-11-18");
      assert.strictEqual(wbDefault.counts.contents, sumDefault.counts.contents);
      assert.strictEqual(wbDefault.counts.works, sumDefault.counts.works);

      const sum19 = buildContentSummaryData({ date: "2026-11-19" }, cutoffDeps);
      assert.strictEqual(sum19.date, "2026-11-19");
      assert.strictEqual(sum19.rows.length, 2, "显式查 11-19 应包含 11-19 发布记录");
      console.log("✓ P2 统一 cutoff（缺省=最新快照日，关联/汇总/计数/回执一致且不读 daily）通过");
    }

    /* ---------- 7. P2 字段说明与 adapters.js 7 平台实际输出一致性核验 ---------- */
    {
      const { ADAPTERS } = require("../src/main/services/dataStats/adapters.js");
      const mockFetch = async (url) => {
        const respond = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
        if (url.includes("/overview/dashboard")) {
          return respond({
            status_code: 0,
            metrics: [
              {
                english_metric_name: "total_fans_cnt",
                metric_value: 100,
                trends: [{ date_time: "20261110", value: 99 }],
              },
            ],
          });
        }
        if (url.includes("/pc/work_list")) {
          return respond({
            status_code: 0,
            has_more: false,
            items: [
              {
                id: "dy1",
                description: "dy",
                create_time: 1700000000,
                metrics: {
                  view_count: 10,
                  like_count: 2,
                  comment_count: 1,
                  share_count: 3,
                  favorite_count: 4,
                  subscribe_count: 5,
                },
              },
            ],
          });
        }
        if (url.includes("/statistic/fans_trend")) {
          return respond({ errCode: 0, data: { total: [10, 12] } });
        }
        if (url.includes("/post/post_list")) {
          return respond({
            errCode: 0,
            data: {
              continueFlag: false,
              lastBuff: "",
              list: [
                {
                  objectId: "sph1",
                  desc: { description: "sph" },
                  createTime: 1700000000,
                  readCount: 10,
                  favCount: 2,
                  commentCount: 1,
                  forwardCount: 3,
                  likeCount: 4,
                  followCount: 5,
                },
              ],
            },
          });
        }
        if (url.includes("/x/web/data/index/stat")) {
          return respond({
            code: 0,
            data: {
              total_fans: 10,
              total_click: 100,
              total_like: 5,
              total_reply: 1,
              total_share: 2,
              total_fav: 3,
            },
          });
        }
        if (url.includes("/x/web/archives")) {
          return respond({
            code: 0,
            data: {
              page: { count: 1 },
              arc_audits: [
                {
                  Archive: { bvid: "BV1", title: "bili", ptime: 1700000000 },
                  stat: { view: 10, like: 2, reply: 1, share: 3, favorite: 4 },
                },
              ],
            },
          });
        }
        if (url.includes("/pcui/home/index")) {
          return respond({ data: { coreData: { fansCount: 10, viewCount: 100 } } });
        }
        if (url.includes("/pcui/article/lists")) {
          return respond({
            data: {
              page: { totalPage: 1 },
              list: [
                {
                  article_id: "bjh1",
                  url: "https://mbd.baidu.com/1",
                  title: "bjh",
                  publish_time: "2026-11-10 10:00:00",
                  read_amount: 10,
                  like_amount: 2,
                  comment_amount: 1,
                  share_amount: 3,
                  collection_amount: 4,
                },
              ],
            },
          });
        }
        if (url.includes("/home/merge_v2")) {
          return respond({
            data: {
              statistic: {
                data: { total_subscribe_count: 10, total_read_play_count: 100 },
              },
            },
          });
        }
        if (url.includes("/api/feed/mp_provider/v1/")) {
          return respond({
            has_more: false,
            data: [
              {
                assembleCell: {
                  itemCell: {
                    articleBase: { gidStr: "tt1", title: "tt", publishTime: 1700000000 },
                    itemCounter: {
                      videoWatchCount: 10,
                      diggCount: 2,
                      commentCount: 1,
                      repinCount: 4,
                    },
                  },
                },
              },
            ],
          });
        }
        if (url.includes("/home/userInfo")) {
          return respond({ result: 1, data: { coreUserInfo: { fansNum: 10 } } });
        }
        if (url.includes("/home/personal_info")) {
          return respond({ code: 0, data: { fans_count: 10 } });
        }
        if (url.includes("/note/user/posted")) {
          return respond({
            code: 0,
            data: {
              page: -1,
              notes: [
                {
                  id: "xhs1",
                  display_title: "xhs",
                  time: "2026-11-10 10:00:00",
                  view_count: 10,
                  likes: 2,
                  comments_count: 1,
                  shared_count: 3,
                  collected_count: 4,
                },
              ],
            },
          });
        }
        throw new Error(`未 mock 的适配器 URL: ${url}`);
      };

      const nullByField = {
        play: [],
        like: [],
        comment: [],
        share: [],
        favorite: [],
        fansDelta: [],
      };
      const fansHistoryPlatforms = [];

      for (const [pt, adapter] of Object.entries(ADAPTERS)) {
        const winObj = {
          scrollTo: () => {},
          _webmsxyw: () => ({ "X-s": "s", "X-t": "1", "X-s-common": "c" }),
          __mmSniffed: [
            {
              url: "https://cp.kuaishou.com/rest/cp/works/v2/video/pc/photo/list",
              json: {
                result: 1,
                data: {
                  total: 1,
                  nextCursor: "no_more",
                  list: [
                    {
                      workId: "ks1",
                      title: "ks",
                      uploadTime: 1700000000000,
                      playCount: 10,
                      likeCount: 2,
                      commentCount: 1,
                    },
                  ],
                },
              },
            },
          ],
        };
        const sandbox = {
          fetch: mockFetch,
          window: winObj,
          document: {
            cookie: "kuaishou.web.cp.api_ph=abc",
            title: "test",
            body: { innerText: "" },
            documentElement: { scrollHeight: 100 },
            querySelectorAll: () => [],
          },
          location: { href: adapter.landingPage },
          localStorage: {
            getItem: () => JSON.stringify({ user_unique_id: "uid1" }),
          },
          console,
          setTimeout,
          clearTimeout,
          Date,
          JSON,
          Number,
          String,
          Math,
          Set,
          Object,
          Array,
          Promise,
          Error,
          Infinity,
          isFinite,
          encodeURIComponent,
        };
        const out = await vm.runInNewContext(adapter.collectScript(), sandbox);
        assert.strictEqual(out.works.length, 1, `${pt} 适配器应产出 1 条样例作品`);
        const w = out.works[0];
        for (const k of Object.keys(nullByField)) {
          if (w[k] === null) nullByField[k].push(pt);
        }
        if (Array.isArray(out.fansHistory) && out.fansHistory.length > 0) {
          fansHistoryPlatforms.push(pt);
        }
      }

      assert.deepStrictEqual(nullByField.play, []);
      assert.deepStrictEqual(nullByField.like, []);
      assert.deepStrictEqual(nullByField.comment, []);
      assert.deepStrictEqual(nullByField.share.sort(), ["头条", "快手"].sort());
      assert.deepStrictEqual(nullByField.favorite.sort(), ["快手"]);
      assert.deepStrictEqual(
        nullByField.fansDelta.sort(),
        ["哔哩哔哩", "百家号", "头条", "快手", "小红书"].sort()
      );
      assert.deepStrictEqual(fansHistoryPlatforms.sort(), ["抖音", "视频号"].sort());
      console.log("✓ P2 全部 7 平台 adapters.js 实跑字段缺项与字段说明一致");
    }

    /* ---------- 8. CLI 参数解析、退出码契约（0/1/2/3）与 stdout 纯 JSON 测试 ---------- */
    const { parseStatsArgs, statsHelpText } = require("../src/main/cli/parseStatsArgs.js");
    const { runStatsCli } = require("../src/main/cli/runStatsCli.js");

    // 8a. 参数校验失败（CLI 主入口对应退出码 2）
    for (const [argv, reason] of [
      [[], "缺少 --out"],
      [["--out"], "--out 缺值"],
      [["--out", "--from", "2026-11-01"], "--out 值为下一选项"],
      [["--out="], "--out= 空值"],
      [["--out", "   "], "--out 仅空白"],
      [["--out", "stats.csv"], "--out 非 .xlsx（.csv）"],
      [["--out", "stats.xls"], "--out 非 .xlsx（.xls）"],
      [["--out", "stats"], "--out 无后缀"],
      [["--out", "stats.xlsx "], "--out 尾空格不以 .xlsx 结尾"],
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

    // 8b. 合法参数（含 .XLSX 大小写不敏感）& 帮助文本
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
    const parsedUpper = parseStatsArgs(["--out", "REPORT.XLSX"], "export");
    assert.strictEqual(parsedUpper.ok, true, "应接受大写 .XLSX 后缀");
    assert.strictEqual(parsedUpper.value.out, "REPORT.XLSX");

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
    assert.ok(helpTxt.includes("3"), "帮助文本应包含退出码 3 说明");

    // 原有 stats / stats-work 参数解析不受影响
    assert.strictEqual(
      parseStatsArgs(["-p", "dy", "--phone", "A组"], "get").ok,
      true
    );
    assert.strictEqual(
      parseStatsArgs(["-p", "dy", "--phone", "A组"], "work").ok,
      false
    );

    // 8c. 从 src/main/index.js 启动入口验证 CLI stdout 纯 JSON + [startup] 去向 stderr + 退出码 0/1/2/3
    const mainIndexSrc = fs.readFileSync(
      path.join(__dirname, "../src/main/index.js"),
      "utf8"
    );
    const cliIndexSrc = fs.readFileSync(
      path.join(__dirname, "../src/main/cli/index.js"),
      "utf8"
    );
    assert.ok(
      cliIndexSrc.includes('"stats-export": "export"'),
      "src/main/cli/index.js 必须将 stats-export 接入 STATS_CMDS"
    );

    const startSource = mainIndexSrc.slice(
      mainIndexSrc.indexOf("async function startApplication()"),
      mainIndexSrc.indexOf("startApplication();") + "startApplication();".length
    );
    const dispatchSource = cliIndexSrc.slice(
      cliIndexSrc.indexOf("  // 数据统计："),
      cliIndexSrc.indexOf("  // 评论互动：")
    );
    const { initializeElectronRuntime } = require("../src/main/services/electronStartup.js");

    async function probeStartupCli(subArgs, { maxRows, cliMode = true } = {}) {
      const stdout = [];
      const stderr = [];
      const fakeConsole = {
        log: (...a) => stdout.push(a.join(" ")),
        error: (...a) => stderr.push(a.join(" ")),
        warn: (...a) => stderr.push(a.join(" ")),
      };
      const wrappedRunStatsCli = (opts) =>
        runStatsCli(maxRows !== undefined ? { ...opts, maxRows } : opts);
      const runCliMain = vm.runInNewContext(
        "(async (argv) => { const sub = argv.slice(2); const cmd = sub[0]; " +
          dispatchSource +
          " return 2; })",
        {
          parseStatsArgs,
          statsHelpText,
          runStatsCli: wrappedRunStatsCli,
          console: fakeConsole,
        }
      );

      let exitCode;
      let guiReady = false;
      const origLog = console.log;
      const origErr = console.error;
      console.log = fakeConsole.log;
      console.error = fakeConsole.error;
      try {
        await vm.runInNewContext(startSource, {
          app: {
            commandLine: { getSwitchValue: () => "9222" },
            isReady: () => false,
            whenReady: () => Promise.resolve(),
            exit: (c) => {
              exitCode = c;
            },
          },
          pie: { initialize: () => Promise.resolve() },
          console: fakeConsole,
          cliMode,
          initializeElectronRuntime,
          runCliMain,
          onAppReady: () => {
            guiReady = true;
          },
          ensureAccountRecordsMigrated: () => {
            fakeConsole.log("[account-migration] 模拟迁移日志");
          },
          reportUsageTelemetry: () => Promise.resolve(),
          process: { argv: ["electron", "cli", "stats-export", ...subArgs] },
        });
      } finally {
        console.log = origLog;
        console.error = origErr;
      }

      const rawStdout = stdout.join("\n");
      let parsedJson = null;
      let parseable = false;
      try {
        parsedJson = JSON.parse(rawStdout);
        parseable = true;
      } catch (_) {}
      return { exitCode, guiReady, stdout, stderr, rawStdout, parseable, json: parsedJson };
    }

    // 成功（exit 0，stdout 仅一份纯 JSON，[startup] 和迁移日志都在 stderr）
    const cliOutFile = path.join(tmpRoot, "cli-export.xlsx");
    const probeOk = await probeStartupCli([
      "--out",
      cliOutFile,
      "--from",
      "2026-11-10",
      "--to",
      "2026-11-14",
    ]);
    assert.strictEqual(probeOk.exitCode, 0);
    assert.strictEqual(probeOk.parseable, true, `stdout 必须是可直解的纯 JSON，实际: ${probeOk.rawStdout}`);
    assert.strictEqual(probeOk.json.success, true);
    assert.strictEqual(probeOk.json.out, path.resolve(cliOutFile));
    assert.strictEqual(probeOk.json.from, "2026-11-10");
    assert.strictEqual(probeOk.json.to, "2026-11-14");
    assert.strictEqual(probeOk.json.counts.accounts, 4);
    assert.ok(probeOk.stderr.some((l) => l.includes("[startup]")), "[startup] 日志应输出到 stderr");
    assert.ok(
      probeOk.stderr.some((l) => l.includes("[account-migration]")),
      "CLI 模式迁移诊断日志应输出到 stderr"
    );
    assert.deepStrictEqual(xlsx.readFile(cliOutFile).SheetNames, SHEET_NAMES);

    // 大写 .XLSX 后缀 → exit 0
    const cliUpperOut = path.join(tmpRoot, "CLI-UPPER.XLSX");
    const probeUpper = await probeStartupCli(["--out", cliUpperOut]);
    assert.strictEqual(probeUpper.exitCode, 0);
    assert.strictEqual(probeUpper.parseable, true);
    assert.strictEqual(probeUpper.json.success, true);
    assert.ok(fs.existsSync(cliUpperOut));

    // 非 .xlsx 后缀 → exit 2，不写文件，stdout 为纯 JSON
    const csvOut = path.join(tmpRoot, "bad.csv");
    const probeCsv = await probeStartupCli(["--out", csvOut]);
    assert.strictEqual(probeCsv.exitCode, 2);
    assert.strictEqual(probeCsv.parseable, true, "参数错误时 stdout 应为单份 JSON");
    assert.strictEqual(probeCsv.json.success, false);
    assert.ok(probeCsv.json.error.includes(".xlsx"));
    assert.strictEqual(fs.existsSync(csvOut), false, "非 .xlsx 不得写出文件");

    // 缺少 --out → exit 2，stdout 为纯 JSON
    const probeMissing = await probeStartupCli([]);
    assert.strictEqual(probeMissing.exitCode, 2);
    assert.strictEqual(probeMissing.parseable, true);
    assert.strictEqual(probeMissing.json.success, false);

    // 日期非法 → exit 2
    const probeBadDate = await probeStartupCli(["--out", cliOutFile, "--from", "2026-02-30"]);
    assert.strictEqual(probeBadDate.exitCode, 2);
    assert.strictEqual(probeBadDate.parseable, true);
    assert.strictEqual(probeBadDate.json.success, false);

    // 超行上限 → exit 3（业务失败），不写文件，stdout 为纯 JSON
    const cliLimitOut = path.join(tmpRoot, "cli-over-limit.xlsx");
    const probeLimit = await probeStartupCli(
      ["--out", cliLimitOut, "--from", "2026-11-10", "--to", "2026-11-14"],
      { maxRows: 5 }
    );
    assert.strictEqual(probeLimit.exitCode, 3, "超行上限必须返回退出码 3");
    assert.strictEqual(probeLimit.parseable, true);
    assert.strictEqual(probeLimit.json.success, false);
    assert.ok(
      /^数据量过大（\d+ 行），请缩小日期范围后再导出$/.test(probeLimit.json.error),
      `超限报错格式不符: ${probeLimit.json.error}`
    );
    assert.strictEqual(fs.existsSync(cliLimitOut), false, "CLI 超限不得写文件");

    // 写入异常（目标为已存在 .xlsx 同名目录）→ exit 1，stdout 为纯 JSON
    const dirTarget = path.join(tmpRoot, "existing-dir.xlsx");
    fs.mkdirSync(dirTarget);
    const probeWriteErr = await probeStartupCli(["--out", dirTarget]);
    assert.strictEqual(probeWriteErr.exitCode, 1);
    assert.strictEqual(probeWriteErr.parseable, true);
    assert.strictEqual(probeWriteErr.json.success, false);
    assert.ok(probeWriteErr.json.error);

    // GUI 模式（cliMode=false）不受影响：[startup] 仍走 console.log
    const probeGui = await probeStartupCli([], { cliMode: false });
    assert.strictEqual(probeGui.guiReady, true);
    assert.ok(
      probeGui.stdout.some((l) => l.includes("[startup]")),
      "GUI 模式 [startup] 日志仍应保留在 console.log"
    );
    console.log("✓ CLI stats-export 参数解析、退出码契约（0/1/2/3）与 stdout 纯 JSON 验证全部通过");

    /* ---------- 9. P3：dataStats/index.vue 模板编译与 el-tab-pane 状态保留校验 ---------- */
    {
      const vuePath = path.resolve(
        __dirname,
        "../src/renderer/views/dataStats/index.vue"
      );
      const sfc = vueCompiler.parseComponent(fs.readFileSync(vuePath, "utf8"));
      const compiled = vueCompiler.compile(sfc.template.content);
      assert.strictEqual(
        compiled.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${compiled.errors.join("; ")}`
      );
      assert.strictEqual(
        sfc.template.content.includes("activeTab === 'overview'"),
        false,
        "账号总览 tab 不应使用 v-if 销毁图表实例，应交由 el-tab-pane 控制显隐"
      );
      assert.strictEqual(
        sfc.template.content.includes("activeTab === 'works'"),
        false,
        "作品汇总 tab 不应使用 v-if 销毁表格实例，应交由 el-tab-pane 控制显隐"
      );
      console.log("✓ P3 dataStats/index.vue 模板编译通过且 el-tab-pane 保留组件状态");
    }

    /* ---------- 10. S6 导出新列：作品日明细「匹配分数」与跨平台汇总「匹配方式」 ---------- */
    {
      const s6Deps = {
        listAccounts: () => [
          { group: "S6组", platform: "抖音" },
          { group: "S6组", platform: "快手" },
        ],
        readWorks: (_g, p) =>
          p === "抖音"
            ? {
                works: [
                  {
                    workId: "S6_DY_LINK",
                    title: "秘制红烧肉教程完整详细步骤",
                    url: "https://www.douyin.com/video/s601",
                    publishTime: dayTs("2026-11-10"),
                  },
                  {
                    workId: "S6_DY_MAN",
                    title: "人工指定视频抖音版",
                    url: "https://www.douyin.com/video/s602",
                    publishTime: dayTs("2026-11-10"),
                  },
                ],
              }
            : {
                works: [
                  {
                    workId: "S6_KS_FUZZY",
                    title: "秘制红烧肉教程完整详细", // 截断 0.95 模糊匹配
                    url: "https://www.kuaishou.com/short-video/s601",
                    publishTime: dayTs("2026-11-11"),
                  },
                  {
                    workId: "S6_KS_MAN",
                    title: "完全改写标题快手版",
                    url: "https://www.kuaishou.com/short-video/s602",
                    publishTime: dayTs("2026-11-11"),
                  },
                ],
              },
        readWorksDaily: (_g, p) =>
          p === "抖音"
            ? {
                S6_DY_LINK: { "2026-11-12": { play: 100, like: 10 } },
                S6_DY_MAN: { "2026-11-12": { play: 200, like: 20 } },
              }
            : {
                S6_KS_FUZZY: { "2026-11-12": { play: 300, like: 30 } },
                S6_KS_MAN: { "2026-11-12": { play: 400, like: 40 } },
              },
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "s6-1",
            pt: "抖音",
            group: "S6组",
            publishStatus: "success",
            title: "秘制红烧肉教程完整详细步骤",
            filePath: "/videos/s6_hsr.mp4",
            videoLink: "https://www.douyin.com/video/s601",
            lastPublishAt: dayTs("2026-11-10"),
          },
          {
            id: "s6-2",
            pt: "快手",
            group: "S6组",
            publishStatus: "success",
            title: "秘制红烧肉教程完整详细步骤",
            filePath: "/videos/s6_hsr.mp4",
            videoLink: "",
            lastPublishAt: dayTs("2026-11-10"),
          },
        ],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: dayTs("2026-11-12"),
          contents: {
            "manual:s6merge": {
              title: "人工指定视频抖音版",
              createdAt: dayTs("2026-11-12"),
            },
          },
          overrides: {
            "抖音|S6_DY_MAN": { action: "assign", contentKey: "manual:s6merge" },
            "快手|S6_KS_MAN": { action: "assign", contentKey: "manual:s6merge" },
          },
        }),
      };

      const s6Wb = buildStatsWorkbookData({ now: dayTs("2026-11-12") }, s6Deps);
      const s6Daily = s6Wb.sheets["作品日明细"].slice(1);
      const rLink = s6Daily.find((r) => r[6] === "S6_DY_LINK");
      const rFuzzy = s6Daily.find((r) => r[6] === "S6_KS_FUZZY");
      const rMan = s6Daily.find((r) => r[6] === "S6_KS_MAN");
      assert.strictEqual(rLink[4], "link");
      assert.strictEqual(rLink[5], null);
      assert.strictEqual(rFuzzy[4], "fuzzy");
      assert.strictEqual(typeof rFuzzy[5], "number");
      assert.strictEqual(rFuzzy[5], 0.95);
      assert.strictEqual(rMan[4], "manual");
      assert.strictEqual(rMan[5], null);

      const s6Sum = s6Wb.sheets["作品跨平台汇总"].slice(1);
      const sumHsr = s6Sum.find((r) => r[0] === "file:/videos/s6_hsr.mp4");
      const sumMan = s6Sum.find((r) => r[0] === "manual:s6merge");
      assert.strictEqual(sumHsr[5], "fuzzy", "含 link+fuzzy 的簇汇总匹配方式应取最弱 fuzzy");
      assert.strictEqual(sumMan[5], "manual", "含手动矫正的簇汇总匹配方式应标 manual");

      const s6File = path.join(tmpRoot, "s6-new-cols.xlsx");
      writeStatsXlsx(s6Wb, s6File);
      const s6Read = xlsx.readFile(s6File);
      const ws1S6 = s6Read.Sheets["作品日明细"];
      const rangeS6 = xlsx.utils.decode_range(ws1S6["!ref"]);
      let foundFuzzyCell = false;
      for (let r = 1; r <= rangeS6.e.r; r++) {
        const widCell = ws1S6[xlsx.utils.encode_cell({ r, c: 6 })];
        if (widCell && widCell.v === "S6_KS_FUZZY") {
          foundFuzzyCell = true;
          const mCell = ws1S6[xlsx.utils.encode_cell({ r, c: 4 })];
          const scCell = ws1S6[xlsx.utils.encode_cell({ r, c: 5 })];
          assert.strictEqual(mCell.t, "s");
          assert.strictEqual(mCell.v, "fuzzy");
          assert.strictEqual(scCell.t, "n", "匹配分数读回必须为 number 类型");
          assert.strictEqual(scCell.v, 0.95);
        }
      }
      assert.ok(foundFuzzyCell, "应读回 S6_KS_FUZZY 的 fuzzy 与数值分数");
      console.log("✓ S6 导出新列：作品日明细匹配分数(number)与跨平台汇总匹配方式(fuzzy/manual)校验通过");
    }

    /* ---------- 11. S6-fix#10 与 S6-fix#7：全量解析跨组手工引用再裁剪 + 共享默认截止日 + 单次匹配复用 ---------- */
    {
      // S6-fix#10a: A 组作品手工指向仅由 B 组发布记录提供的内容，只导出 A 组时仍保持 manual 关联，且不混入 B 组无关内容
      const crossRefDeps = {
        listAccounts: () => [
          { group: "A组", platform: "抖音" },
          { group: "B组", platform: "抖音" },
        ],
        readWorks: (group) =>
          group === "A组"
            ? {
                works: [
                  {
                    workId: "A_W1",
                    title: "A组作品手工指向B组素材",
                    url: "https://www.douyin.com/video/aw1",
                    publishTime: dayTs("2026-11-18"),
                  },
                ],
              }
            : {
                works: [
                  {
                    workId: "B_W1",
                    title: "B组自有作品",
                    url: "https://www.douyin.com/video/bw1",
                    publishTime: dayTs("2026-11-18"),
                  },
                ],
              },
        readWorksDaily: (group) =>
          group === "A组"
            ? { A_W1: { "2026-11-18": { play: 500, like: 50 } } }
            : { B_W1: { "2026-11-18": { play: 900, like: 90 } } },
        // 故意让账号日快照比作品快照晚一天（11-19），顺带测试 S6-fix#10b 共享默认截止日
        readDaily: () => ({
          "2026-11-18": { fans: 100, plays: 500 },
          "2026-11-19": { fans: 110, plays: 600 },
        }),
        readPushRecords: () => [
          {
            id: "b-only-1",
            pt: "抖音",
            group: "B组",
            publishStatus: "success",
            title: "仅B组发布的共享素材",
            filePath: "/videos/b_shared_target.mp4",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "b-other-1",
            pt: "抖音",
            group: "B组",
            publishStatus: "success",
            title: "B组无关内容",
            filePath: "/videos/b_unrelated.mp4",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "a-future-19",
            pt: "抖音",
            group: "A组",
            publishStatus: "success",
            title: "19日才出现的新目标",
            filePath: "/videos/only_on_19.mp4",
            lastPublishAt: dayTs("2026-11-19"),
          },
        ],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: dayTs("2026-11-18"),
          contents: {},
          overrides: {
            "抖音|A_W1": { action: "assign", contentKey: "file:/videos/b_shared_target.mp4" },
          },
        }),
      };

      // S6-fix#10b: 作品快照最新 11-18、账号快照最新 11-19 → GUI 与 Excel 默认截止日一致取 11-18
      assert.strictEqual(
        resolveDefaultCutoffDate([
          {
            group: "A组",
            platform: "抖音",
            worksDaily: { A_W1: { "2026-11-18": { play: 500 } } },
            daily: { "2026-11-19": { fans: 110 } },
          },
        ]),
        "2026-11-18"
      );
      const guiSum = buildContentSummaryData({}, crossRefDeps);
      const fullWb = buildStatsWorkbookData({ now: dayTs("2026-11-20") }, crossRefDeps);
      assert.strictEqual(guiSum.date, "2026-11-18", "GUI 默认截止日以作品快照最新日 11-18 为准");
      assert.strictEqual(
        fullWb.to,
        "2026-11-18",
        "S6-fix#10: Excel 默认截止日必须与 GUI 一致以作品快照最新日 11-18 为准，而非账号快照 11-19"
      );
      assert.strictEqual(
        fullWb.sheets["作品跨平台汇总"].slice(1).some((r) => r[0] === "file:/videos/only_on_19.mp4"),
        false,
        "19 日才出现的新目标不得在默认 11-18 导出中生效"
      );

      // S6-fix#10a: 只导出 A 组时，A_W1 手工指向仅由 B 组提供的 b_shared_target.mp4 必须仍保持 manual
      const onlyAWb = buildStatsWorkbookData({ groups: ["A组"], now: dayTs("2026-11-20") }, crossRefDeps);
      assert.strictEqual(onlyAWb.to, "2026-11-18");
      const onlyAS1 = onlyAWb.sheets["作品日明细"].slice(1);
      assert.strictEqual(onlyAS1.length, 1);
      assert.strictEqual(onlyAS1[0][3], "file:/videos/b_shared_target.mp4");
      assert.strictEqual(onlyAS1[0][4], "manual", "S6-fix#10: 只导出 A 组不得丢掉跨组手工引用");
      const onlyAS2 = onlyAWb.sheets["作品跨平台汇总"].slice(1);
      const crossTargetRow = onlyAS2.find((r) => r[0] === "file:/videos/b_shared_target.mp4");
      assert.ok(crossTargetRow, "S6-fix#10: 只导出 A 组汇总应保留被 A 组手工引用的跨组内容行");
      assert.strictEqual(crossTargetRow[5], "manual");
      assert.strictEqual(crossTargetRow[6], 500);
      assert.strictEqual(
        onlyAS2.some((r) => r[0] === "file:/videos/b_unrelated.mp4"),
        false,
        "S6-fix#10: B 组无关发布记录仍须裁剪掉"
      );

      // S6-fix#7: 验证同一次 buildStatsWorkbookData 导出内对同一数据集+cutoff 只跑 1 次 linkWorks
      let titleReadCount = 0;
      const singlePassDeps = {
        listAccounts: () => [{ group: "P组", platform: "抖音" }],
        readWorks: () => ({
          works: [
            {
              workId: "SP1",
              get title() {
                titleReadCount++;
                return "单次匹配复用验证标题完整内容";
              },
              url: "",
              publishTime: dayTs("2026-11-18"),
            },
          ],
        }),
        readWorksDaily: () => ({ SP1: { "2026-11-18": { play: 100 } } }),
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "sp-1",
            pt: "抖音",
            group: "P组",
            publishStatus: "success",
            title: "单次匹配复用验证标题完整内容教学",
            filePath: "/videos/sp1.mp4",
            lastPublishAt: dayTs("2026-11-18"),
          },
        ],
      };
      // 直接对比：若只跑 1 次 linkWorks + 1 次 buildContentSummaryRows(复用) + 1 次 buildWorkDailyRows：
      // linkWorks 读 title 2 次（normalizeTitle + prepareCore）+ buildContentSummaryRows 读 1 次 + buildWorkDailyRows 读 1 次 = 4 次；
      // 若 buildContentSummaryRows 重复跑了 linkWorks，则会读 6 次！
      buildStatsWorkbookData({ now: dayTs("2026-11-18") }, singlePassDeps);
      assert.strictEqual(
        titleReadCount,
        4,
        `S6-fix#7: 单次导出内对同一数据集+cutoff 应仅跑 1 次 linkWorks（预期读 title 4 次，实际 ${titleReadCount} 次）`
      );
      // S6-r3#10(testS6r3DefaultExportCutoffVsExplicitTo):
      // 未传 from/to 时用共享默认截止日 11-18（排除 11-19 新目标）；显式传手动调整区间 to=11-19 时才纳入 11-19 目标
      const explicitRangeWb = buildStatsWorkbookData(
        { from: "2026-11-01", to: "2026-11-19", now: dayTs("2026-11-20") },
        crossRefDeps
      );
      assert.strictEqual(explicitRangeWb.to, "2026-11-19");
      assert.strictEqual(
        explicitRangeWb.sheets["作品跨平台汇总"].slice(1).some((r) => r[0] === "file:/videos/only_on_19.mp4"),
        true,
        "S6-r3#10: 手动指定 to=2026-11-19 时应纳入 19 日发布目标"
      );

      // S6-r3#1(testS6r3ExportCrossGroupWorkIdentity):
      // 同一作品跨 A/B 两组观测时：全量按作品身份 platform|workId 裁决一次，日明细/全量汇总/GUI/单组导出必须完全一致
      const crossWorkIdDeps = {
        listAccounts: () => [
          { group: "A组", platform: "抖音" },
          { group: "B组", platform: "抖音" },
        ],
        readWorks: () => ({
          works: [
            {
              workId: "SHARED_1",
              title: "跨组共享已拆出作品",
              url: "https://www.douyin.com/video/shared1",
              publishTime: dayTs("2026-11-18"),
            },
            {
              workId: "CONF_1",
              title: "跨组归属冲突作品",
              url: "https://www.douyin.com/video/conf1",
              publishTime: dayTs("2026-11-18"),
            },
          ],
        }),
        readWorksDaily: (group) =>
          group === "A组"
            ? {
                SHARED_1: { "2026-11-18": { play: 100 } },
                CONF_1: { "2026-11-18": { play: 200 } },
              }
            : {
                SHARED_1: { "2026-11-18": { play: 100 } },
                CONF_1: { "2026-11-18": { play: 200 } },
              },
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "sh-a",
            pt: "抖音",
            group: "A组",
            publishStatus: "success",
            title: "跨组共享已拆出作品",
            filePath: "/videos/shared_1.mp4",
            videoLink: "https://www.douyin.com/video/shared1",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "sh-b",
            pt: "抖音",
            group: "B组",
            publishStatus: "success",
            title: "跨组共享已拆出作品",
            filePath: "/videos/shared_1.mp4",
            videoLink: "https://www.douyin.com/video/shared1",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "cf-a",
            pt: "抖音",
            group: "A组",
            publishStatus: "success",
            title: "冲突素材甲",
            filePath: "/videos/conf_a.mp4",
            videoLink: "https://www.douyin.com/video/conf1",
            lastPublishAt: dayTs("2026-11-18"),
          },
          {
            id: "cf-b",
            pt: "抖音",
            group: "B组",
            publishStatus: "success",
            title: "冲突素材乙",
            filePath: "/videos/conf_b.mp4",
            videoLink: "https://www.douyin.com/video/conf1",
            lastPublishAt: dayTs("2026-11-18"),
          },
        ],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: dayTs("2026-11-18"),
          contents: {},
          overrides: {
            "抖音|SHARED_1": { action: "detach" },
          },
        }),
      };

      const cwGui = buildContentSummaryData({}, crossWorkIdDeps);
      const cwFullWb = buildStatsWorkbookData({ now: dayTs("2026-11-18") }, crossWorkIdDeps);
      const cwOnlyBWb = buildStatsWorkbookData({ groups: ["B组"], now: dayTs("2026-11-18") }, crossWorkIdDeps);

      assert.ok(cwGui.rows.find((r) => r.contentKey === "unlinked:抖音:SHARED_1"));
      assert.ok(cwGui.rows.find((r) => r.contentKey === "unlinked:抖音:CONF_1"));
      const cwFullDaily = cwFullWb.sheets["作品日明细"].slice(1);
      assert.strictEqual(cwFullDaily.length, 4);
      assert.ok(
        cwFullDaily.every((r) => r[3] === null && r[4] === null),
        "S6-r3#1: 全量日明细中拆出作品与跨组冲突作品在两组观测下均必须为空归属"
      );
      const cwOnlyBDaily = cwOnlyBWb.sheets["作品日明细"].slice(1);
      assert.strictEqual(cwOnlyBDaily.length, 2);
      assert.ok(
        cwOnlyBDaily.every((r) => r[3] === null && r[4] === null),
        "S6-r3#1: 只导 B 组日明细复用全量按作品身份裁决结果，拆出与冲突作品均须保持未关联"
      );
      const cwOnlyBSum = cwOnlyBWb.sheets["作品跨平台汇总"].slice(1);
      assert.ok(cwOnlyBSum.find((r) => r[0] === "unlinked:抖音:SHARED_1"));
      assert.ok(cwOnlyBSum.find((r) => r[0] === "unlinked:抖音:CONF_1"));

      console.log("✓ S6-fix#10(跨组手工引用先解析后裁剪+共享默认截止日) & S6-fix#7(同次导出单次匹配复用) & S6-r3#1/#10 通过");
    }

    /* ---------- 12. S6-r4#1 & #8 端到端回归：视频号 altTitles 回放防误合 + 默认导出建议文件名无日期 ---------- */
    {
      // S6-r4#1(testS6r4SphReplayAltTitlesEndToEnd):
      // 回放视频号采集脚本第2集（描述带「第2集」、短标题无集数）→ store.mergeWorks 原样保存 altTitles →
      // 旧数据缺省 altTitles 读回为空数组 → GUI 汇总与 Excel 导出在 ②唯一标题 与 ③模糊阶段均拒绝挂到第1集
      const { ADAPTERS } = require("../src/main/services/dataStats/adapters.js");
      const sphReplayFetch = async (url) => {
        const respond = (obj) => ({ status: 200, text: async () => JSON.stringify(obj) });
        if (url.includes("/statistic/fans_trend")) {
          return respond({ errCode: 0, data: { total: [10, 12] } });
        }
        if (url.includes("/post/post_list")) {
          return respond({
            errCode: 0,
            data: {
              continueFlag: false,
              lastBuff: "",
              list: [
                {
                  objectId: "sph_replay_ep2",
                  desc: {
                    shortTitle: [{ shortTitle: "家庭红烧肉完整教程" }],
                    description: "家庭红烧肉完整教程第2集 #美食教程",
                  },
                  createTime: Math.floor(dayTs("2026-11-18") / 1000),
                  readCount: 320,
                  favCount: 25,
                  commentCount: 5,
                  forwardCount: 3,
                  likeCount: 8,
                  followCount: 2,
                },
              ],
            },
          });
        }
        throw new Error(`未 mock 的视频号 URL: ${url}`);
      };
      const sphReplayOut = await vm.runInNewContext(ADAPTERS["视频号"].collectScript(), {
        fetch: sphReplayFetch,
        console,
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Number,
        String,
        Math,
        Set,
        Object,
        Array,
        Promise,
        Error,
        Infinity,
        isFinite,
      });
      assert.strictEqual(sphReplayOut.works.length, 1);
      assert.strictEqual(sphReplayOut.works[0].title, "家庭红烧肉完整教程");
      assert.strictEqual(Array.isArray(sphReplayOut.works[0].altTitles), true);
      assert.deepStrictEqual(
        Array.from(sphReplayOut.works[0].altTitles),
        ["家庭红烧肉完整教程第2集 #美食教程"],
        "S6-r4#1: 视频号采集必须同时保留短标题与描述标题（altTitles）"
      );

      // store.mergeWorks 原样保存 altTitles，读回完整；旧版缺 altTitles 的 works.json 读回缺省为空数组
      const sphGroup = "S6R4视频号组";
      store.mergeWorks(sphGroup, "视频号", sphReplayOut.works, dayTs("2026-11-18"));
      const storedWorks = store.readWorks(sphGroup, "视频号").works;
      assert.strictEqual(storedWorks.length, 1);
      assert.deepStrictEqual(
        storedWorks[0].altTitles,
        ["家庭红烧肉完整教程第2集 #美食教程"],
        "S6-r4#1: store 必须原样保存 altTitles"
      );

      const legacyWorksFile = path.join(userDataDir, "data-stats", "S6R4旧数据组", "视频号", "works.json");
      fs.mkdirSync(path.dirname(legacyWorksFile), { recursive: true });
      fs.writeFileSync(
        legacyWorksFile,
        JSON.stringify({ works: [{ workId: "legacy_w1", title: "旧版视频号作品", publishTime: dayTs("2026-11-10") }] }),
        "utf8"
      );
      const legacyRead = store.readWorks("S6R4旧数据组", "视频号").works;
      assert.deepStrictEqual(
        legacyRead[0].altTitles,
        [],
        "S6-r4#1: 旧数据缺少 altTitles 字段时 store 读回必须缺省为空数组"
      );

      // GUI 与 Excel 验证：分别针对「无短标题第1集目标(③模糊)」和「同短标题第1集目标(②唯一标题)」均不得误合
      for (const [caseName, rec] of [
        [
          "③模糊阶段(无短标题目标)",
          {
            id: "sph-r4-ep1-fuzzy",
            pt: "视频号",
            group: sphGroup,
            publishStatus: "success",
            title: "家庭红烧肉完整教程第1集",
            filePath: "/videos/sph_hsr_ep1.mp4",
            lastPublishAt: dayTs("2026-11-18"),
          },
        ],
        [
          "②唯一标题阶段(同短标题目标)",
          {
            id: "sph-r4-ep1-title",
            pt: "视频号",
            group: sphGroup,
            publishStatus: "success",
            title: "家庭红烧肉完整教程第1集",
            shortTitle: "家庭红烧肉完整教程",
            filePath: "/videos/sph_hsr_ep1.mp4",
            lastPublishAt: dayTs("2026-11-18"),
          },
        ],
      ]) {
        const sphDeps = {
          listAccounts: () => [{ group: sphGroup, platform: "视频号" }],
          readWorks: (g, p) => store.readWorks(g, p),
          readWorksDaily: (g, p) => store.readWorksDaily(g, p),
          readWorksDailyLatestAsOf: (g, p, d) => store.readWorksDailyLatestAsOf(g, p, d),
          readDaily: () => ({}),
          readPushRecords: () => [rec],
          readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
        };
        const guiRes = buildContentSummaryData({ date: "2026-11-18" }, sphDeps);
        assert.ok(
          guiRes.rows.find((r) => r.contentKey === "unlinked:视频号:sph_replay_ep2"),
          `S6-r4#1(${caseName}): GUI 汇总中第2集作品必须保持未关联，不得挂到第1集`
        );
        const ep1GuiRow = guiRes.rows.find((r) => r.contentKey === "file:/videos/sph_hsr_ep1.mp4");
        assert.ok(ep1GuiRow && ep1GuiRow.platformCount === 0, `S6-r4#1(${caseName}): 第1集目标不得吸收第2集`);

        const wbRes = buildStatsWorkbookData({ to: "2026-11-18", now: dayTs("2026-11-18") }, sphDeps);
        const dailyRows = wbRes.sheets["作品日明细"].slice(1);
        assert.strictEqual(dailyRows.length, 1);
        assert.strictEqual(
          dailyRows[0][3],
          null,
          `S6-r4#1(${caseName}): Excel 作品日明细中第2集内容ID必须为 null`
        );
        assert.strictEqual(
          dailyRows[0][4],
          null,
          `S6-r4#1(${caseName}): Excel 作品日明细中第2集关联方式必须为 null`
        );
      }

      // S6-r4#8(testS6r4DefaultExportFileNameWithoutDates):
      // 未手动调整区间的默认导出保存框建议文件名不带日期（MatrixMedia-作品数据.xlsx），显式区间仍带日期
      assert.strictEqual(buildDefaultExportFileName("", ""), "MatrixMedia-作品数据.xlsx");
      assert.strictEqual(buildDefaultExportFileName(undefined, undefined), "MatrixMedia-作品数据.xlsx");
      assert.strictEqual(
        buildDefaultExportFileName("2026-11-01", "2026-11-18"),
        "MatrixMedia-作品数据-2026-11-01_2026-11-18.xlsx"
      );
      assert.strictEqual(
        buildDefaultExportFileName("", "2026-11-18"),
        "MatrixMedia-作品数据-2026-10-20_2026-11-18.xlsx"
      );
      assert.strictEqual(
        buildDefaultExportFileName("2026-11-01", ""),
        "MatrixMedia-作品数据-2026-11-01_起.xlsx"
      );

      // 评审 #8 端到端复现：系统日期为 11 月 19 日、最新作品快照为 11 月 18 日
      const r4ExportOut = path.join(tmpRoot, "r4-default-export.xlsx");
      const r4ExplicitOut = path.join(tmpRoot, "r4-explicit-export.xlsx");
      const r4ExportDeps = {
        listAccounts: () => [{ group: sphGroup, platform: "视频号" }],
        readWorks: (g, p) => store.readWorks(g, p),
        readWorksDaily: (g, p) => store.readWorksDaily(g, p),
        readWorksDailyLatestAsOf: (g, p, d) => store.readWorksDailyLatestAsOf(g, p, d),
        readDaily: () => ({}),
        readPushRecords: () => [],
        readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
      };
      registerDataStatsIpc({ exportDeps: r4ExportDeps });
      const r4ExportHandler = ipcHandlers.get("stats:export-xlsx");
      const origDateNow = Date.now;
      Date.now = () => dayTs("2026-11-19");
      try {
        mockDialogResult = { canceled: false, filePath: r4ExportOut };
        const defRes = await r4ExportHandler(
          { sender: {}, senderFrame: { url: "file:///app/index.html" } },
          {}
        );
        assert.strictEqual(defRes.ok, true);
        assert.strictEqual(defRes.to, "2026-11-18", "默认导出工作簿截止日应为最新快照日 2026-11-18");
        const defSuggestedPath = saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath;
        assert.strictEqual(
          path.basename(defSuggestedPath),
          "MatrixMedia-作品数据.xlsx",
          `S6-r4#8(testS6r4DefaultExportFileNameWithoutDates): 默认导出保存框建议文件名不得带系统日期，实际 ${path.basename(defSuggestedPath)}`
        );
        const defWb = xlsx.readFile(r4ExportOut);
        const metaRows = xlsx.utils.sheet_to_json(defWb.Sheets["导出信息"], { header: 1 });
        const dateRangeRow = metaRows.find((r) => r[0] === "日期范围");
        assert.ok(dateRangeRow && String(dateRangeRow[1]).endsWith("2026-11-18"));

        mockDialogResult = { canceled: false, filePath: r4ExplicitOut };
        const expRes = await r4ExportHandler(
          { sender: {}, senderFrame: { url: "file:///app/index.html" } },
          { from: "2026-11-01", to: "2026-11-18" }
        );
        assert.strictEqual(expRes.ok, true);
        const expSuggestedPath = saveDialogCalls[saveDialogCalls.length - 1].opts.defaultPath;
        assert.strictEqual(
          path.basename(expSuggestedPath),
          "MatrixMedia-作品数据-2026-11-01_2026-11-18.xlsx",
          "S6-r4#8: 显式区间导出保存框建议文件名仍须带日期"
        );
      } finally {
        Date.now = origDateNow;
      }

      console.log("✓ S6-r4#1(testS6r4SphReplayAltTitlesEndToEnd) & S6-r4#8(testS6r4DefaultExportFileNameWithoutDates) 通过");
    }

    /* ---------- 11. S7-fix 导出同步校验（历史掉0全历史识别不污染 Sheet1 + 未来截止日夹紧） ---------- */
    {
      const pubDrop = Date.parse("2026-11-12T10:00:00+08:00");
      const s7ExportDeps = {
        now: Date.parse("2026-11-17T10:00:00+08:00"),
        listAccounts: () => [{ group: "导出组", platform: "抖音" }],
        readWorks: () => [{ workId: "EXP_D0", title: "导出掉0回溯", publishTime: pubDrop }],
        readWorksDaily: () => ({
          EXP_D0: {
            "2026-11-14": { play: 1000, like: 50 },
            "2026-11-15": { play: 0, like: 50 },
            "2026-11-16": { play: 1300, like: 60 },
          },
        }),
        readDaily: () => ({}),
        readPushRecords: () => [],
      };
      const wbDrop = buildStatsWorkbookData({ from: "2026-11-12", to: "2026-11-15" }, s7ExportDeps);
      // Sheet 1 作品日明细不得泄漏截止日 11/15 之后的 11/16 快照
      assert.strictEqual(
        wbDrop.sheets["作品日明细"].slice(1).every((r) => r[0] <= "2026-11-15"),
        true,
        "作品日明细 sheet 必须严格截至 to=2026-11-15"
      );
      // Sheet「分析」必须利用 11/16 恢复快照识别并剔除 11/15 掉 0
      assert.strictEqual(wbDrop.analysis.anomalies.collectionAnomalies.length, 1);
      assert.strictEqual(wbDrop.analysis.overview.metrics.play.current, null);
      assert.strictEqual(wbDrop.analysis.rankings.byPlay.top[0].totalPlay, 1000);
      assert.strictEqual(wbDrop.analysis.newWorks.items[0].d3Play, 1000);
      const analysisPlayRow = wbDrop.sheets["分析"].find((r) => r[0] === "播放");
      assert.strictEqual(analysisPlayRow[1], null, "Excel 分析 sheet 总览播放日增不得为 -1000");

      // 导出分析 sheet 同样把未来 to 夹到 UTC+8 今天，不提前填充 D3/D7
      const s7FutureDeps = {
        now: Date.parse("2026-11-20T10:00:00+08:00"),
        listAccounts: () => [{ group: "导出组", platform: "抖音" }],
        readWorks: () => [
          { workId: "EXP_F1", title: "未来截止测试", publishTime: Date.parse("2026-11-19T18:00:00+08:00") },
        ],
        readWorksDaily: () => ({ EXP_F1: { "2026-11-20": { play: 1000 } } }),
        readDaily: () => ({}),
        readPushRecords: () => [],
      };
      const wbFuture = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-29" }, s7FutureDeps);
      assert.strictEqual(wbFuture.from, "2026-11-19");
      assert.strictEqual(wbFuture.to, "2026-11-20", "导出区间与 ≤ UTC+8 今天取交集后 to 应为 2026-11-20");
      assert.strictEqual(wbFuture.analysisPeriod, 2, "交集为 11/19~11/20 共 2 天，analysisPeriod 应为 2");
      assert.strictEqual(wbFuture.analysis.to, "2026-11-20");
      assert.strictEqual(wbFuture.analysis.newWorks.items[0].d3Play, null);
      assert.strictEqual(wbFuture.analysis.newWorks.items[0].d7Play, null);
      console.log("✓ S7-fix 导出同步校验(testS7FixExportAnalysisSync) 通过");
    }

    /* ---------- 12. S7-r3#1 & #3 专项回归：走势表同行倍数+分类依据同步 Excel、未来日期交集校验 ---------- */
    {
      // testS7r3ExportDateRangeIntersectTodayAndRejectFuture（评审 S7-review2 #3：当前 11/20，作品 11/19=100、11/20=250，选 11/21 单日）
      const r3FutureDeps = {
        now: Date.parse("2026-11-20T10:00:00+08:00"),
        listAccounts: () => [{ group: "创作组", platform: "抖音" }],
        readWorks: () => [
          {
            workId: "R3_F1",
            title: "未来日期导出校验",
            publishTime: Date.parse("2026-11-18T10:00:00+08:00"),
          },
        ],
        readWorksDaily: () => ({
          R3_F1: {
            "2026-11-19": { play: 100 },
            "2026-11-20": { play: 250 },
          },
        }),
        readDaily: () => ({}),
        readPushRecords: () => [],
      };

      // 1) 选明天单日（11/21 ~ 11/21）→ 交集为空 → 报错「所选日期都在未来」，不生成文件
      assert.throws(
        () => buildStatsWorkbookData({ from: "2026-11-21", to: "2026-11-21" }, r3FutureDeps),
        (err) => err && err.message === "所选日期都在未来",
        "S7-r3#3: 仅选未来单日 11/21 必须报错「所选日期都在未来」"
      );
      // 2) 全在未来的多日区间、仅 from 在未来、仅 to 远在未来（to-29 > today）均报错「所选日期都在未来」
      for (const badRange of [
        { from: "2026-11-21", to: "2026-11-25" },
        { from: "2026-11-21" },
        { to: "2026-12-31" },
      ]) {
        assert.throws(
          () => buildStatsWorkbookData(badRange, r3FutureDeps),
          (err) => err && err.message === "所选日期都在未来",
          `S7-r3#3: 全未来区间 ${JSON.stringify(badRange)} 必须报错「所选日期都在未来」`
        );
      }

      // 3) IPC 层选 11/21 单日 → 直接返回 { ok: false, message: "所选日期都在未来" }，不弹保存框、不生成文件
      const beforeDialogsR3 = saveDialogCalls.length;
      const neverWrittenFile = path.join(tmpRoot, "r3-future-never-written.xlsx");
      registerDataStatsIpc({ exportDeps: r3FutureDeps });
      const r3ExportHandler = ipcHandlers.get("stats:export-xlsx");
      mockDialogResult = { canceled: false, filePath: neverWrittenFile };
      const ipcFutureRes = await r3ExportHandler(
        { sender: {}, senderFrame: { url: "file:///app/index.html" } },
        { from: "2026-11-21", to: "2026-11-21" }
      );
      assert.strictEqual(ipcFutureRes.ok, false);
      assert.strictEqual(ipcFutureRes.message, "所选日期都在未来");
      assert.strictEqual(saveDialogCalls.length, beforeDialogsR3, "S7-r3#3: 全未来区间不得弹出保存框");
      assert.strictEqual(fs.existsSync(neverWrittenFile), false, "S7-r3#3: 全未来区间不得生成文件");

      // 4) 部分跨未来区间：11/19 ~ 11/25 与 ≤11/20 取交集 → 11/19 ~ 11/20，analysisPeriod=2，新增播放 150
      const wbIntersect2 = buildStatsWorkbookData(
        { from: "2026-11-19", to: "2026-11-25" },
        r3FutureDeps
      );
      assert.strictEqual(wbIntersect2.from, "2026-11-19");
      assert.strictEqual(wbIntersect2.to, "2026-11-20");
      assert.strictEqual(wbIntersect2.analysisPeriod, 2);
      assert.strictEqual(wbIntersect2.analysis.to, "2026-11-20");
      assert.strictEqual(wbIntersect2.analysis.period, 2);
      assert.strictEqual(wbIntersect2.analysis.overview.metrics.play.current, 150);
      const intersectMetaMap = new Map(
        wbIntersect2.sheets["导出信息"].slice(1).map((r) => [r[0], r[1]])
      );
      assert.strictEqual(intersectMetaMap.get("日期范围"), "2026-11-19 ~ 2026-11-20");
      assert.strictEqual(intersectMetaMap.get("analysisPeriod"), 2);

      // 5) 跨未来且交集超过 30 天（10/01 ~ 11/25 → 交集 51 天）→ analysisPeriod 上限 30
      const wbIntersectCap = buildStatsWorkbookData(
        { from: "2026-10-01", to: "2026-11-25" },
        r3FutureDeps
      );
      assert.strictEqual(wbIntersectCap.from, "2026-10-01");
      assert.strictEqual(wbIntersectCap.to, "2026-11-20");
      assert.strictEqual(wbIntersectCap.analysisPeriod, 30);

      // 6) GUI 导出日期选择器同步绑定禁选未来日期 picker-options
      const vueSrc = fs.readFileSync(
        path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue"),
        "utf8"
      );
      const exportPickerMatch = vueSrc.match(/class="export-date-picker"[\s\S]*?\/>/);
      assert.ok(
        exportPickerMatch && exportPickerMatch[0].includes(':picker-options="analysisDatePickerOptions"'),
        "S7-r3#3: 导出日期选择器应绑定禁选 UTC+8 未来日期的 picker-options"
      );
      console.log("✓ S7-r3#3(testS7r3ExportDateRangeIntersectTodayAndRejectFuture) 通过");

      // testS7r3ExportTrajectoryExcelSync（评审 S7-review2 #1：Excel「分析」sheet 同行倍数与分类依据列同步）
      const pubMs = Date.parse("2026-11-01T10:00:00+08:00");
      const r3TrajDeps = {
        now: Date.parse("2026-11-20T10:00:00+08:00"),
        listAccounts: () => [
          { group: "账号一", platform: "抖音" },
          { group: "账号二", platform: "抖音" },
          { group: "创作组", platform: "抖音" },
          { group: "创作组", platform: "快手" },
        ],
        readWorks: (g, p) => {
          if (g === "账号一" && p === "抖音") {
            return [{ workId: "M_DY1", title: "双号同款走势", publishTime: pubMs }];
          }
          if (g === "账号二" && p === "抖音") {
            return [{ workId: "M_DY2", title: "双号同款走势", publishTime: pubMs }];
          }
          if (g === "创作组" && p === "抖音") {
            return [{ workId: "C_DY", title: "跨平台走势", url: "https://www.douyin.com/video/cdy", publishTime: pubMs }];
          }
          if (g === "创作组" && p === "快手") {
            return [{ workId: "C_KS", title: "跨平台走势", url: "https://www.kuaishou.com/short-video/cks", publishTime: pubMs }];
          }
          return [];
        },
        readWorksDaily: (g, p) => {
          if (g === "账号一" && p === "抖音") {
            return { M_DY1: { "2026-11-02": { play: 100 }, "2026-11-04": { play: 100 }, "2026-11-08": { play: 100 } } };
          }
          if (g === "账号二" && p === "抖音") {
            return { M_DY2: { "2026-11-08": { play: 200 } } };
          }
          if (g === "创作组" && p === "抖音") {
            return { C_DY: { "2026-11-02": { play: 100 }, "2026-11-04": { play: 100 }, "2026-11-08": { play: 100 } } };
          }
          if (g === "创作组" && p === "快手") {
            return { C_KS: { "2026-11-08": { play: 200 } } };
          }
          return {};
        },
        readDaily: () => ({}),
        readPushRecords: () => [],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: Date.parse("2026-11-08T12:00:00+08:00"),
          contents: {
            "manual:r3_dual_dy": { title: "双号同款走势", createdAt: Date.parse("2026-11-08T12:00:00+08:00") },
          },
          excludedAuto: {},
          overrides: {
            "抖音|M_DY1": { action: "assign", contentKey: "manual:r3_dual_dy" },
            "抖音|M_DY2": { action: "assign", contentKey: "manual:r3_dual_dy" },
          },
        }),
      };
      const wbTraj = buildStatsWorkbookData({ to: "2026-11-08" }, r3TrajDeps);
      const trajSheet = wbTraj.sheets["分析"];
      const trajHeader = trajSheet.find((r) => r[0] === "内容ID" && r[4] === "D1播放");
      assert.deepStrictEqual(
        trajHeader,
        ["内容ID", "标题", "平台", "发布日期", "D1播放", "D3播放", "D7播放", "D3/D1", "D7/D3", "走势分类", "分类依据"]
      );
      // 跨平台「全平台合计」行：D1=100, D3=100, D7=300, D3/D1=1, D7/D3=3（不再是 1），分类=爆发后平稳，分类依据=抖音
      const crossTotalRow = trajSheet.find((r) => r[1] === "跨平台走势" && r[2] === "全平台合计");
      assert.ok(crossTotalRow, "Excel 分析 sheet 应有跨平台全平台合计行");
      assert.strictEqual(crossTotalRow[4], 100);
      assert.strictEqual(crossTotalRow[5], 100);
      assert.strictEqual(crossTotalRow[6], 300);
      assert.strictEqual(crossTotalRow[7], 1);
      assert.strictEqual(crossTotalRow[8], 3);
      assert.strictEqual(crossTotalRow[9], "爆发后平稳");
      assert.strictEqual(crossTotalRow[10], "抖音");

      // 双抖音号合并行：D1=100, D3=100, D7=300, D3/D1=1, D7/D3=3，分类=爆发后平稳，分类依据=抖音（1/2条）
      const dualDyRow = trajSheet.find((r) => r[0] === "manual:r3_dual_dy" && r[2] === "抖音");
      assert.ok(dualDyRow, "Excel 分析 sheet 应有双抖音号合并行");
      assert.strictEqual(dualDyRow[4], 100);
      assert.strictEqual(dualDyRow[5], 100);
      assert.strictEqual(dualDyRow[6], 300);
      assert.strictEqual(dualDyRow[7], 1);
      assert.strictEqual(dualDyRow[8], 3);
      assert.strictEqual(dualDyRow[9], "爆发后平稳");
      assert.strictEqual(dualDyRow[10], "抖音（1/2条）");

      // 写出并读回验证数字单元格与分类依据文本列
      const r3TrajXlsx = path.join(tmpRoot, "r3-traj-sync.xlsx");
      writeStatsXlsx(wbTraj, r3TrajXlsx);
      const readTrajWb = xlsx.readFile(r3TrajXlsx);
      const readTrajRows = xlsx.utils.sheet_to_json(readTrajWb.Sheets["分析"], { header: 1 });
      const readCrossRow = readTrajRows.find((r) => r[1] === "跨平台走势" && r[2] === "全平台合计");
      assert.strictEqual(readCrossRow[8], 3);
      assert.strictEqual(readCrossRow[10], "抖音");
      console.log("✓ S7-r3#1(testS7r3ExportTrajectoryExcelSync) 通过");
    }

    /* ---------- S9: 作品时段明细 sheet 顺序、表头、增量与距上次小时数、行数上限 ---------- */
    {
      const ts = (ymd, hh, mm = 0) => Date.parse(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
      const intradayDeps = {
        now: ts("2026-11-20", 14, 0),
        listAccounts: () => [
          { group: "G1", platform: "抖音" },
          { group: "G1", platform: "快手" },
        ],
        readWorks: (g, p) => {
          if (p === "抖音") {
            return [{ workId: "DY_S9", title: "=红烧肉分时段", url: "https://www.douyin.com/video/s9", publishTime: ts("2026-11-19", 9, 0) }];
          }
          return [{ workId: "KS_S9", title: "快手分时段", url: "https://www.kuaishou.com/short-video/s9", publishTime: ts("2026-11-19", 9, 0) }];
        },
        readWorksDaily: (g, p) => {
          if (p === "抖音") {
            return { DY_S9: { "2026-11-19": { play: 100, like: 10, comment: 2 }, "2026-11-20": { play: 320, like: 35, comment: 7 } } };
          }
          return { KS_S9: { "2026-11-20": { play: 50, like: 5, comment: 1 } } };
        },
        readWorksIntraday: (g, p) => {
          if (p === "抖音") {
            return {
              DY_S9: [
                { date: "2026-11-19", slot: "22:00", collectedAt: ts("2026-11-19", 22, 0), play: 100, like: 10, comment: 2, share: 1, favorite: 3, fansDelta: 1 },
                { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 30), play: 220, like: 22, comment: 5, share: 2, favorite: 6, fansDelta: 3 },
                { date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 320, like: 35, comment: 7, share: 4, favorite: 9, fansDelta: 5 },
              ],
            };
          }
          return {
            KS_S9: [
              { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 15), play: 50, like: 5, comment: 1, share: null, favorite: null, fansDelta: null },
            ],
          };
        },
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "rec-s9-1",
            filePath: "/v/s9.mp4",
            title: "红烧肉分时段",
            pt: "抖音",
            group: "G1",
            videoLink: "https://www.douyin.com/video/s9",
            publishStatus: "success",
            lastPublishAt: ts("2026-11-19", 9, 0),
          },
        ],
      };

      // 仅导出 2026-11-20，验证跨 from 边界增量与距上次小时数
      const wbS9 = buildStatsWorkbookData(
        { from: "2026-11-20", to: "2026-11-20" },
        intradayDeps
      );
      assert.strictEqual(
        wbS9.sheetOrder.indexOf("作品时段明细"),
        wbS9.sheetOrder.indexOf("作品日明细") + 1,
        "「作品时段明细」必须紧跟「作品日明细」之后"
      );
      const sIntra = wbS9.sheets["作品时段明细"];
      assert.deepStrictEqual(sIntra[0], [
        "日期",
        "时段",
        "采集时间",
        "平台",
        "分组",
        "内容ID",
        "关联方式",
        "作品ID",
        "标题",
        "播放",
        "点赞",
        "评论",
        "分享",
        "收藏",
        "涨粉",
        "播放较上次增量",
        "点赞较上次增量",
        "评论较上次增量",
        "距上次小时数",
      ]);
      assert.strictEqual(wbS9.counts.workIntradayRows, 3);
      assert.strictEqual(sIntra.length, 4);

      // 按实际 collectedAt 升序：
      // 第 1 行：2026-11-20 08:00 快手 KS_S9（08:15:00，首次记录，增量与距上次小时数均为 null）
      assert.deepStrictEqual(sIntra[1], [
        "2026-11-20",
        "08:00",
        "2026-11-20 08:15:00",
        "快手",
        "G1",
        null,
        null,
        "KS_S9",
        "快手分时段",
        50,
        5,
        1,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      // 第 2 行：2026-11-20 08:00 抖音 DY_S9（08:30:00，跨边界减 11-19 22:00：+120, +12, +3, 10.5h）
      assert.deepStrictEqual(sIntra[2], [
        "2026-11-20",
        "08:00",
        "2026-11-20 08:30:00",
        "抖音",
        "G1",
        "file:/v/s9.mp4",
        "link",
        "DY_S9",
        "'=红烧肉分时段",
        220,
        22,
        5,
        2,
        6,
        3,
        120,
        12,
        3,
        10.5,
      ]);
      // 第 3 行：2026-11-20 10:00 抖音 DY_S9（减 08:30：+100, +13, +2, 1.5h）
      assert.deepStrictEqual(sIntra[3], [
        "2026-11-20",
        "10:00",
        "2026-11-20 10:00:00",
        "抖音",
        "G1",
        "file:/v/s9.mp4",
        "link",
        "DY_S9",
        "'=红烧肉分时段",
        320,
        35,
        7,
        4,
        9,
        5,
        100,
        13,
        2,
        1.5,
      ]);

      // 字段说明中「作品时段明细」1:1 匹配 19 列
      const s9SchemaCols = wbS9.sheets["字段说明"]
        .slice(1)
        .filter((r) => r[0] === "作品时段明细")
        .map((r) => r[1]);
      assert.deepStrictEqual(s9SchemaCols, WORK_INTRADAY_HEADERS);

      // 写出并读回 .xlsx 校验
      const s9Xlsx = path.join(tmpRoot, "s9-intraday.xlsx");
      writeStatsXlsx(wbS9, s9Xlsx);
      const readS9Wb = xlsx.readFile(s9Xlsx);
      assert.deepStrictEqual(readS9Wb.SheetNames, SHEET_NAMES);
      const wsIntra = readS9Wb.Sheets["作品时段明细"];
      assert.strictEqual(wsIntra["A2"].v, "2026-11-20");
      assert.strictEqual(wsIntra["B2"].v, "08:00");
      assert.strictEqual(wsIntra["C2"].v, "2026-11-20 08:15:00");
      assert.strictEqual(wsIntra["P3"].t, "n");
      assert.strictEqual(wsIntra["P3"].v, 120);
      assert.strictEqual(wsIntra["S3"].t, "n");
      assert.strictEqual(wsIntra["S3"].v, 10.5);

      // 行上限：作品时段明细超过 maxRows（3 > 2）应直接抛 ROW_LIMIT_EXCEEDED 并提示缩短区间
      assert.throws(
        () =>
          buildStatsWorkbookData(
            { from: "2026-11-20", to: "2026-11-20", maxRows: 2 },
            intradayDeps
          ),
        (err) => {
          assert.strictEqual(err.code, ROW_LIMIT_EXCEEDED_CODE);
          assert.strictEqual(err.sheetName, "作品时段明细");
          assert.strictEqual(
            err.message,
            "数据量过大（3 行），请缩小日期范围后再导出"
          );
          return true;
        }
      );

      // testS9Fix6_ExcelIntradaySheetSortedByActualCollectedAt
      // 评审 #6：10:30 自动槽在 10:31 采到 100，10:40 手动采到 150 归入 10:00 → Excel 按实际 collectedAt 排序，增量 +50、距上次 0.15 小时
      const fix6Deps = {
        now: ts("2026-11-20", 12, 0),
        listAccounts: () => [{ group: "G1", platform: "抖音" }],
        readWorks: () => [{ workId: "W_SORT", title: "短片", publishTime: ts("2026-11-20", 8, 0) }],
        readWorksDaily: () => ({ W_SORT: { "2026-11-20": { play: 150, like: 15, comment: 3 } } }),
        readWorksIntraday: () => ({
          W_SORT: [
            // 故意以槽字符串顺序传入（10:00 在 10:30 前）验证按实际 collectedAt 排序
            { date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 40), play: 150, like: 15, comment: 3 },
            { date: "2026-11-20", slot: "10:30", collectedAt: ts("2026-11-20", 10, 31), play: 100, like: 10, comment: 2 },
          ],
        }),
        readDaily: () => ({}),
        readPushRecords: () => [],
      };
      const wbFix6 = buildStatsWorkbookData({ from: "2026-11-20", to: "2026-11-20" }, fix6Deps);
      const fix6Sheet = wbFix6.sheets["作品时段明细"];
      assert.strictEqual(fix6Sheet.length, 3);
      assert.strictEqual(fix6Sheet[1][1], "10:30");
      assert.strictEqual(fix6Sheet[1][2], "2026-11-20 10:31:00");
      assert.strictEqual(fix6Sheet[1][9], 100);
      assert.strictEqual(fix6Sheet[1][15], null);
      assert.strictEqual(fix6Sheet[1][18], null);
      assert.strictEqual(fix6Sheet[2][1], "10:00");
      assert.strictEqual(fix6Sheet[2][2], "2026-11-20 10:40:00");
      assert.strictEqual(fix6Sheet[2][9], 150);
      assert.strictEqual(fix6Sheet[2][15], 50, "播放较上次增量必须为 +50 而非 -50");
      assert.strictEqual(fix6Sheet[2][16], 5);
      assert.strictEqual(fix6Sheet[2][17], 1);
      assert.strictEqual(fix6Sheet[2][18], 0.15, "距上次小时数必须为 0.15");
      console.log("✓ S9 作品时段明细 sheet（顺序/19列/跨边界增量/距上次小时数/字段说明/行上限）与 [S9-fix #6] 通过");
    }

    /* ---------- S13: deletedContents 全链路过滤（汇总/分析/趋势/xlsx所有sheet/CLI stats-export/恢复） ---------- */
    {
      const ts = (ymd, hh, mm = 0) =>
        Date.parse(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
      const emptyKey = "file:c:/users/ggcle/downloads/empty_relinked.mp4";
      const delWithWorksKey = "file:c:/users/ggcle/downloads/drop_with_works.mp4";
      const keepKey = "file:c:/users/ggcle/downloads/keep_main.mp4";
      const unlinkedDelKey = "unlinked:快手:KS_UNL_DEL";

      let currentLinkOverrides = {
        version: 1,
        updatedAt: ts("2026-11-20", 12, 0),
        contents: {},
        excludedAuto: {},
        deletedContents: {
          [emptyKey]: { deletedAt: ts("2026-11-20", 12, 0) },
          [delWithWorksKey]: { deletedAt: ts("2026-11-20", 12, 1) },
          [unlinkedDelKey]: { deletedAt: ts("2026-11-20", 12, 2) },
        },
        overrides: {
          // 模拟原空行作品被手工改关联到 keepKey；另一条新作品被关联到已删除的 emptyKey（以删除为准继续隐藏）
          "抖音|DY_MOVED": { action: "assign", contentKey: keepKey },
          "抖音|DY_NEW_INTO_DEL": { action: "assign", contentKey: emptyKey },
        },
      };

      const s13Deps = {
        now: ts("2026-11-20", 15, 0),
        listAccounts: () => [
          { group: "G1", platform: "抖音" },
          { group: "G1", platform: "快手" },
        ],
        readWorks: (_g, p) => {
          if (p === "抖音") {
            return [
              { workId: "DY_KEEP", title: "保留内容主视频", url: "https://www.douyin.com/video/s13_keep", publishTime: ts("2026-11-18", 10, 0) },
              { workId: "DY_MOVED", title: "从空行改关联过来的视频", publishTime: ts("2026-11-18", 11, 0) },
              { workId: "DY_DROP", title: "挂在已删内容上的抖音作品", url: "https://www.douyin.com/video/s13_drop", publishTime: ts("2026-11-18", 12, 0) },
              { workId: "DY_NEW_INTO_DEL", title: "之后关联进已删内容的作品", publishTime: ts("2026-11-19", 10, 0) },
            ];
          }
          return [
            { workId: "KS_DROP", title: "挂在已删内容上的快手作品", url: "https://www.kuaishou.com/short-video/s13_drop", publishTime: ts("2026-11-18", 12, 0) },
            { workId: "KS_UNL_DEL", title: "已删除的未关联作品", publishTime: ts("2026-11-19", 9, 0) },
          ];
        },
        readWorksDaily: (_g, p) => {
          if (p === "抖音") {
            return {
              DY_KEEP: {
                "2026-11-19": { play: 100, like: 10, comment: 2 },
                "2026-11-20": { play: 300, like: 30, comment: 5 },
              },
              DY_MOVED: {
                "2026-11-20": { play: 50, like: 5, comment: 1 },
              },
              DY_DROP: {
                "2026-11-19": { play: 9000, like: 900, comment: 90 },
                "2026-11-20": { play: 12000, like: 1200, comment: 120 },
              },
              DY_NEW_INTO_DEL: {
                "2026-11-20": { play: 777, like: 77, comment: 7 },
              },
            };
          }
          return {
            KS_DROP: {
              "2026-11-20": { play: 4000, like: 400, comment: 40 },
            },
            KS_UNL_DEL: {
              "2026-11-20": { play: 666, like: 66, comment: 6 },
            },
          };
        },
        readWorksIntraday: (_g, p) => {
          if (p === "抖音") {
            return {
              DY_KEEP: [
                { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 0), play: 200, like: 20, comment: 3 },
                { date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 300, like: 30, comment: 5 },
              ],
              DY_DROP: [
                { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 0), play: 10000, like: 1000, comment: 100 },
              ],
              DY_NEW_INTO_DEL: [
                { date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 777, like: 77, comment: 7 },
              ],
            };
          }
          return {
            KS_DROP: [
              { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 0), play: 4000, like: 400, comment: 40 },
            ],
            KS_UNL_DEL: [
              { date: "2026-11-20", slot: "08:00", collectedAt: ts("2026-11-20", 8, 0), play: 666, like: 66, comment: 6 },
            ],
          };
        },
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "s13-rec-empty",
            filePath: "C:\\Users\\ggcle\\Downloads\\empty_relinked.mp4",
            title: "原0平台空行",
            pt: "抖音",
            group: "G1",
            publishStatus: "success",
            lastPublishAt: ts("2026-11-18", 9, 0),
          },
          {
            id: "s13-rec-keep",
            filePath: "C:\\Users\\ggcle\\Downloads\\keep_main.mp4",
            title: "保留内容主视频",
            pt: "抖音",
            group: "G1",
            videoLink: "https://www.douyin.com/video/s13_keep",
            publishStatus: "success",
            lastPublishAt: ts("2026-11-18", 10, 0),
          },
          {
            id: "s13-rec-drop-dy",
            filePath: "C:\\Users\\ggcle\\Downloads\\drop_with_works.mp4",
            title: "挂作品待删内容",
            pt: "抖音",
            group: "G1",
            videoLink: "https://www.douyin.com/video/s13_drop",
            publishStatus: "success",
            lastPublishAt: ts("2026-11-18", 12, 0),
          },
          {
            id: "s13-rec-drop-ks",
            filePath: "C:\\Users\\ggcle\\Downloads\\drop_with_works.mp4",
            title: "挂作品待删内容",
            pt: "快手",
            group: "G1",
            videoLink: "https://www.kuaishou.com/short-video/s13_drop",
            publishStatus: "success",
            lastPublishAt: ts("2026-11-18", 12, 0),
          },
        ],
        readLinkOverrides: () => currentLinkOverrides,
      };

      // 1) 汇总：仅剩 keepKey（含 DY_KEEP + DY_MOVED）
      const sumDel = buildContentSummaryData({ date: "2026-11-20" }, s13Deps);
      assert.deepStrictEqual(sumDel.rows.map((r) => r.contentKey), [keepKey]);
      assert.strictEqual(sumDel.rows[0].totalPlay, 350);
      assert.strictEqual(sumDel.counts.contents, 1);
      assert.strictEqual(sumDel.counts.works, 2);
      assert.strictEqual(sumDel.deletedRows.length, 3);

      // 2) 趋势与分时段趋势：被删内容返回 found=false
      const { buildContentTrendData, buildContentIntradayData, buildStatsAnalysisData } = require("../src/main/services/dataStats/statsExport.js");
      assert.strictEqual(buildContentTrendData({ contentKey: delWithWorksKey, to: "2026-11-20" }, s13Deps).found, false);
      assert.strictEqual(buildContentIntradayData({ contentKey: delWithWorksKey, to: "2026-11-20" }, s13Deps).found, false);
      assert.strictEqual(buildContentTrendData({ contentKey: emptyKey, to: "2026-11-20" }, s13Deps).found, false);
      assert.strictEqual(buildContentTrendData({ contentKey: keepKey, to: "2026-11-20" }, s13Deps).found, true);

      // 3) 分析页：不含已删内容及其挂着的作品
      const analysisDel = buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, s13Deps);
      assert.deepStrictEqual(
        analysisDel.rankings.byPlay.top.map((x) => x.contentKey),
        [keepKey],
        "分析页排行不得出现已删内容"
      );
      assert.strictEqual(
        analysisDel.overview.metrics.play.current,
        200,
        "分析页总览播放日增应仅统计未删作品（DY_KEEP +200），不含 DY_DROP(+3000)"
      );
      assert.strictEqual(
        analysisDel.newWorksFirst24h.items.some((it) => it.contentKey === delWithWorksKey || it.contentKey === emptyKey),
        false,
        "新作品前 24 小时不得包含已删内容"
      );

      // 4) Excel 导出所有 sheet（含验证过滤后行数不会触发误超限）：
      //    未过滤前作品日明细有 7 行，过滤后仅 3 行（DY_KEEP 2 天 + DY_MOVED 1 天）
      assert.throws(
        () => buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20", maxRows: 2 }, s13Deps),
        (err) => err.code === ROW_LIMIT_EXCEEDED_CODE && err.sheetName === "作品日明细" && err.rowCount === 3
      );
      const wbDel = buildStatsWorkbookData(
        { from: "2026-11-19", to: "2026-11-20" },
        s13Deps
      );
      assert.deepStrictEqual(
        wbDel.sheets["作品跨平台汇总"].slice(1).map((r) => r[0]),
        [keepKey],
        "作品跨平台汇总仅含未删内容"
      );
      assert.deepStrictEqual(
        wbDel.sheets["作品日明细"].slice(1).map((r) => r[6]).sort(),
        ["DY_KEEP", "DY_KEEP", "DY_MOVED"],
        "作品日明细必须排除挂在已删内容上的作品及已删未关联作品"
      );
      assert.deepStrictEqual(
        wbDel.sheets["作品时段明细"].slice(1).map((r) => r[7]),
        ["DY_KEEP", "DY_KEEP"],
        "作品时段明细必须排除已删内容作品"
      );
      // 平台日汇总：仅抖音（快手全部作品均在已删内容下，不应出现快手）
      assert.deepStrictEqual(
        [...new Set(wbDel.sheets["平台日汇总"].slice(1).map((r) => r[1]))],
        ["抖音"]
      );
      // 写出并读回 .xlsx 验证所有 sheet 均不含已删内容键与已删作品 ID
      const s13Xlsx = path.join(tmpRoot, "s13-deleted-filter.xlsx");
      writeStatsXlsx(wbDel, s13Xlsx);
      const readS13Wb = xlsx.readFile(s13Xlsx);
      for (const sName of readS13Wb.SheetNames) {
        const txt = JSON.stringify(xlsx.utils.sheet_to_json(readS13Wb.Sheets[sName], { header: 1 }));
        assert.strictEqual(txt.includes(emptyKey), false, `${sName} 不得含已删空行`);
        assert.strictEqual(txt.includes(delWithWorksKey), false, `${sName} 不得含已删挂作品内容`);
        assert.strictEqual(txt.includes("DY_DROP"), false, `${sName} 不得含已删内容的抖音作品`);
        assert.strictEqual(txt.includes("KS_DROP"), false, `${sName} 不得含已删内容的快手作品`);
        assert.strictEqual(txt.includes("DY_NEW_INTO_DEL"), false, `${sName} 不得含后关联进已删内容的作品`);
        assert.strictEqual(txt.includes("KS_UNL_DEL"), false, `${sName} 不得含已删未关联作品`);
      }

      // 5) CLI stats-export 走同一导出函数并遵守 deletedContents
      const { runStatsCli } = require("../src/main/cli/runStatsCli.js");
      const cliOutPath = path.join(tmpRoot, "s13-cli-export.xlsx");
      const cliRun = await captureConsole(() =>
        runStatsCli({
          action: "export",
          out: cliOutPath,
          from: "2026-11-19",
          to: "2026-11-20",
          deps: s13Deps,
        })
      );
      assert.strictEqual(cliRun.res, 0);
      const cliJson = JSON.parse(cliRun.logs.join("\n"));
      assert.strictEqual(cliJson.success, true);
      assert.strictEqual(cliJson.counts.contents, 1);
      assert.strictEqual(cliJson.counts.works, 2);
      const cliWb = xlsx.readFile(cliOutPath);
      assert.strictEqual(xlsx.utils.sheet_to_json(cliWb.Sheets["作品跨平台汇总"], { header: 1 }).length, 2);

      // 6) 恢复全部已删内容后，汇总/趋势/分析/导出全部恢复正常（含之前关联进 emptyKey 的 DY_NEW_INTO_DEL）
      currentLinkOverrides = {
        ...currentLinkOverrides,
        deletedContents: {},
      };
      const sumRestored = buildContentSummaryData({ date: "2026-11-20" }, s13Deps);
      assert.strictEqual(sumRestored.rows.length, 4);
      assert.strictEqual(sumRestored.deletedRows.length, 0);
      assert.strictEqual(buildContentTrendData({ contentKey: delWithWorksKey, to: "2026-11-20" }, s13Deps).found, true);
      assert.strictEqual(buildContentIntradayData({ contentKey: delWithWorksKey, to: "2026-11-20" }, s13Deps).found, true);
      const wbRestored = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, s13Deps);
      assert.strictEqual(wbRestored.counts.contents, 4);
      assert.strictEqual(wbRestored.counts.works, 6);
      assert.strictEqual(wbRestored.counts.workDailyRows, 8);
      assert.strictEqual(wbRestored.counts.workIntradayRows, 6);
      console.log("✓ S13 deletedContents 全链路过滤（空行/挂作品/后关联/趋势/分析/xlsx全sheet/CLI/恢复）通过");
    }

    /* ---------- S13-r1: 返修回归（历史截止导出、第三平台加入自动聚类、record:pos 错位、Rule 3 空行隐藏） ---------- */
    {
      const ts = (ymd, hh, mm = 0) =>
        Date.parse(`${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
      const {
        buildContentTrendData,
        buildContentIntradayData,
        buildStatsAnalysisData,
        resolveDeleteContentSnapshots,
      } = require("../src/main/services/dataStats/statsExport.js");
      const { runStatsCli } = require("../src/main/cli/runStatsCli.js");

      // 1) P2 #1：作品手工关联到较晚日期内容并删除 → 按更早截止日期导出（汇总/日明细/时段明细/分析/CLI/趋势）仍隐藏；
      //    同时覆盖 Rule 3（若该作品在更早日期自动落回未删内容且使其变为 0 平台，该内容行也一并隐藏）
      {
        const keepKey = "file:c:/v/hist_keep.mp4";
        const lateTargetKey = "file:c:/v/hist_late.mp4";
        const earlyAutoKey = "file:c:/v/hist_early_auto.mp4";
        let overrides = {
          version: 1,
          updatedAt: ts("2026-11-20", 12, 0),
          contents: {},
          excludedAuto: {},
          deletedContents: {},
          overrides: {
            "抖音|W_HIST_UNL": { action: "assign", contentKey: lateTargetKey },
            "抖音|W_HIST_FALLBACK": { action: "assign", contentKey: lateTargetKey },
          },
        };
        const histDeps = {
          now: ts("2026-11-20", 15, 0),
          listAccounts: () => [{ group: "G1", platform: "抖音" }],
          readWorks: () => [
            { workId: "W_HIST_KEEP", title: "正常保留作品", url: "https://www.douyin.com/video/hist_keep", publishTime: ts("2026-11-10", 9, 0) },
            { workId: "W_HIST_UNL", title: "手工挂到较晚内容的无记录作品", publishTime: ts("2026-11-10", 10, 0) },
            { workId: "W_HIST_FALLBACK", title: "更早日期会回落旧内容的已删作品", url: "https://www.douyin.com/video/hist_fb", publishTime: ts("2026-11-10", 11, 0) },
          ],
          readWorksDaily: () => ({
            W_HIST_KEEP: {
              "2026-11-11": { play: 100, like: 10 },
              "2026-11-12": { play: 220, like: 22 },
              "2026-11-20": { play: 500, like: 50 },
            },
            W_HIST_UNL: {
              "2026-11-11": { play: 1000, like: 100 },
              "2026-11-12": { play: 2500, like: 250 },
              "2026-11-20": { play: 4000, like: 400 },
            },
            W_HIST_FALLBACK: {
              "2026-11-11": { play: 600, like: 60 },
              "2026-11-12": { play: 900, like: 90 },
              "2026-11-20": { play: 1200, like: 120 },
            },
          }),
          readWorksIntraday: () => ({
            W_HIST_KEEP: [
              { date: "2026-11-12", slot: "10:00", collectedAt: ts("2026-11-12", 10, 0), play: 220 },
            ],
            W_HIST_UNL: [
              { date: "2026-11-12", slot: "10:00", collectedAt: ts("2026-11-12", 10, 0), play: 2500 },
            ],
            W_HIST_FALLBACK: [
              { date: "2026-11-12", slot: "10:00", collectedAt: ts("2026-11-12", 10, 0), play: 900 },
            ],
          }),
          readDaily: () => ({}),
          readPushRecords: () => [
            {
              id: "hist-keep-rec",
              filePath: "C:\\v\\hist_keep.mp4",
              title: "正常保留作品",
              pt: "抖音",
              group: "G1",
              videoLink: "https://www.douyin.com/video/hist_keep",
              publishStatus: "success",
              lastPublishAt: ts("2026-11-10", 9, 0),
            },
            {
              id: "hist-early-auto-rec",
              filePath: "C:\\v\\hist_early_auto.mp4",
              title: "更早日期会回落旧内容的已删作品",
              pt: "抖音",
              group: "G1",
              videoLink: "https://www.douyin.com/video/hist_fb",
              publishStatus: "success",
              lastPublishAt: ts("2026-11-10", 11, 0),
            },
            {
              id: "hist-late-rec",
              filePath: "C:\\v\\hist_late.mp4",
              title: "较晚日期被删目标",
              pt: "抖音",
              group: "G1",
              publishStatus: "success",
              lastPublishAt: ts("2026-11-18", 10, 0),
            },
          ],
          readLinkOverrides: () => overrides,
        };

        // 在最新日期（2026-11-20）按真实删除流程生成快照
        const { snapshotByKey } = resolveDeleteContentSnapshots([lateTargetKey], overrides, histDeps);
        const snap = snapshotByKey.get(lateTargetKey);
        assert.strictEqual(snap.title, "较晚日期被删目标");
        assert.deepStrictEqual(snap.pwKeys, ["抖音|W_HIST_FALLBACK", "抖音|W_HIST_UNL"]);
        overrides = {
          ...overrides,
          deletedContents: {
            [lateTargetKey]: { deletedAt: ts("2026-11-20", 12, 5), title: snap.title, pwKeys: snap.pwKeys },
          },
        };

        // 按更早截止日期 2026-11-12 查询/导出：lateTargetKey 被日期裁掉，W_HIST_UNL / W_HIST_FALLBACK 均不得漏出
        const sumHist = buildContentSummaryData({ date: "2026-11-12" }, histDeps);
        assert.deepStrictEqual(sumHist.rows.map((r) => r.contentKey), [keepKey]);
        assert.strictEqual(sumHist.counts.works, 1);
        assert.strictEqual(sumHist.counts.unlinkedWorks, 0);
        assert.strictEqual(
          sumHist.rows.some((r) => r.contentKey === earlyAutoKey),
          false,
          "Rule 3: 所有作品均被隐藏且变为 0 平台的内容行在历史汇总中也应隐藏"
        );
        assert.strictEqual(buildContentTrendData({ contentKey: "unlinked:抖音:W_HIST_UNL", to: "2026-11-12" }, histDeps).found, false);
        assert.strictEqual(buildContentIntradayData({ contentKey: "unlinked:抖音:W_HIST_UNL", to: "2026-11-12" }, histDeps).found, false);

        const analysisHist = buildStatsAnalysisData({ period: 7, to: "2026-11-12" }, histDeps);
        assert.deepStrictEqual(analysisHist.rankings.byPlay.top.map((x) => x.contentKey), [keepKey]);
        assert.strictEqual(analysisHist.overview.metrics.play.current, 120, "仅计 W_HIST_KEEP 日增 +120");

        const wbHist = buildStatsWorkbookData({ from: "2026-11-11", to: "2026-11-12" }, histDeps);
        assert.deepStrictEqual(wbHist.sheets["作品跨平台汇总"].slice(1).map((r) => r[0]), [keepKey]);
        assert.deepStrictEqual(wbHist.sheets["作品日明细"].slice(1).map((r) => r[6]), ["W_HIST_KEEP", "W_HIST_KEEP"]);
        assert.deepStrictEqual(wbHist.sheets["作品时段明细"].slice(1).map((r) => r[7]), ["W_HIST_KEEP"]);
        assert.strictEqual(wbHist.counts.works, 1);
        assert.strictEqual(wbHist.counts.unlinkedWorks, 0);

        const cliHistOut = path.join(tmpRoot, "s13-r1-hist-cli.xlsx");
        const cliHist = await captureConsole(() =>
          runStatsCli({
            action: "export",
            out: cliHistOut,
            from: "2026-11-11",
            to: "2026-11-12",
            deps: histDeps,
          })
        );
        assert.strictEqual(cliHist.res, 0);
        const cliHistJson = JSON.parse(cliHist.logs.join("\n"));
        assert.strictEqual(cliHistJson.counts.works, 1);
        assert.strictEqual(cliHistJson.counts.unlinkedWorks, 0);
        const histWbDisk = xlsx.readFile(cliHistOut);
        for (const sName of histWbDisk.SheetNames) {
          const txt = JSON.stringify(xlsx.utils.sheet_to_json(histWbDisk.Sheets[sName], { header: 1 }));
          assert.strictEqual(txt.includes("W_HIST_UNL"), false, `${sName} 不得漏出历史已删作品 W_HIST_UNL`);
          assert.strictEqual(txt.includes("W_HIST_FALLBACK"), false, `${sName} 不得漏出历史已删作品 W_HIST_FALLBACK`);
        }
      }

      // 2) P2 #2：删除双平台自动聚类后第三平台加入使成员哈希变化，原两平台作品在汇总/日明细/时段明细/分析/导出中仍保持隐藏
      {
        let hasThirdPlatform = false;
        let overrides = {
          version: 1,
          updatedAt: ts("2026-11-20", 12, 0),
          contents: {},
          excludedAuto: {},
          deletedContents: {},
          overrides: {},
        };
        const autoDeps = {
          now: ts("2026-11-20", 15, 0),
          listAccounts: () =>
            hasThirdPlatform
              ? [
                  { group: "G1", platform: "抖音" },
                  { group: "G1", platform: "快手" },
                  { group: "G1", platform: "小红书" },
                ]
              : [
                  { group: "G1", platform: "抖音" },
                  { group: "G1", platform: "快手" },
                ],
          readWorks: (_g, p) => {
            if (p === "抖音") {
              return [{ workId: "AUTO_DY", title: "秋季徒步登山装备推荐清单完整版", publishTime: ts("2026-11-18", 10, 0) }];
            }
            if (p === "快手") {
              return [{ workId: "AUTO_KS", title: "秋季徒步登山装备推荐清单完整版", publishTime: ts("2026-11-18", 11, 0) }];
            }
            return [{ workId: "AUTO_XHS", title: "秋季徒步登山装备推荐清单完整版", publishTime: ts("2026-11-19", 10, 0) }];
          },
          readWorksDaily: (_g, p) => {
            if (p === "抖音") return { AUTO_DY: { "2026-11-19": { play: 1000 }, "2026-11-20": { play: 1500 } } };
            if (p === "快手") return { AUTO_KS: { "2026-11-19": { play: 2000 }, "2026-11-20": { play: 2600 } } };
            return { AUTO_XHS: { "2026-11-20": { play: 300 } } };
          },
          readWorksIntraday: (_g, p) => {
            if (p === "抖音") return { AUTO_DY: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 1500 }] };
            if (p === "快手") return { AUTO_KS: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 2600 }] };
            return { AUTO_XHS: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 300 }] };
          },
          readDaily: () => ({}),
          readPushRecords: () => [],
          readLinkOverrides: () => overrides,
        };

        const sum2p = buildContentSummaryData({ date: "2026-11-20" }, autoDeps);
        assert.strictEqual(sum2p.rows.length, 1);
        const autoOldKey = sum2p.rows[0].contentKey;
        assert.ok(autoOldKey.startsWith("auto:"));

        const { snapshotByKey } = resolveDeleteContentSnapshots([autoOldKey], overrides, autoDeps);
        const autoSnap = snapshotByKey.get(autoOldKey);
        assert.deepStrictEqual(autoSnap.pwKeys, ["快手|AUTO_KS", "抖音|AUTO_DY"]);
        overrides = {
          ...overrides,
          deletedContents: {
            [autoOldKey]: { deletedAt: ts("2026-11-20", 12, 10), title: autoSnap.title, pwKeys: autoSnap.pwKeys },
          },
        };

        // 采到第三平台小红书，成员哈希变化：只要任一成员作品 pwKey 命中删除快照 pwKeys，整行连同后来加入的小红书作品一律隐藏
        hasThirdPlatform = true;
        const sum3p = buildContentSummaryData({ date: "2026-11-20" }, autoDeps);
        assert.strictEqual(
          sum3p.rows.length,
          0,
          "S13-r2#1: 新平台加入已删除自动聚类后，整行（含小红书）必须一律隐藏"
        );
        assert.strictEqual(sum3p.counts.works, 0);
        assert.strictEqual(sum3p.deletedRows[0].contentKey, autoOldKey);
        assert.strictEqual(sum3p.deletedRows[0].workCount, 2);

        // 计算三平台加入后的新 auto 键以校验趋势/分时段趋势均不可见
        const all3pRows = buildContentSummaryData(
          { date: "2026-11-20", linkOverrides: { version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, deletedContents: {}, overrides: {} } },
          autoDeps
        );
        assert.strictEqual(all3pRows.rows.length, 1);
        const autoNewKey = all3pRows.rows[0].contentKey;
        assert.notStrictEqual(autoNewKey, autoOldKey, "三平台后 auto contentKey 哈希必须变化");

        const wb3p = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, autoDeps);
        assert.deepStrictEqual(wb3p.sheets["作品跨平台汇总"].slice(1), []);
        assert.deepStrictEqual(wb3p.sheets["作品日明细"].slice(1), []);
        assert.deepStrictEqual(wb3p.sheets["作品时段明细"].slice(1), []);
        assert.deepStrictEqual(wb3p.sheets["平台日汇总"].slice(1), []);
        assert.strictEqual(wb3p.counts.works, 0);
        assert.strictEqual(buildContentTrendData({ contentKey: autoNewKey, to: "2026-11-20" }, autoDeps).found, false);
        assert.strictEqual(buildContentIntradayData({ contentKey: autoNewKey, to: "2026-11-20" }, autoDeps).found, false);
        assert.strictEqual(buildContentTrendData({ contentKey: autoOldKey, to: "2026-11-20" }, autoDeps).found, false);

        const analysis3p = buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, autoDeps);
        assert.deepStrictEqual(analysis3p.rankings.byPlay.top, []);

        // 恢复 autoOldKey 后三平台全部恢复出表
        overrides = { ...overrides, deletedContents: {} };
        const sum3pRestored = buildContentSummaryData({ date: "2026-11-20" }, autoDeps);
        assert.strictEqual(sum3pRestored.rows.length, 1);
        assert.strictEqual(sum3pRestored.rows[0].contentKey, autoNewKey);
        assert.strictEqual(sum3pRestored.rows[0].platformCount, 3);
        assert.strictEqual(sum3pRestored.rows[0].totalPlay, 4400);
        const wb3pRestored = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, autoDeps);
        assert.deepStrictEqual(
          [...new Set(wb3pRestored.sheets["作品日明细"].slice(1).map((r) => r[6]))].sort(),
          ["AUTO_DY", "AUTO_KS", "AUTO_XHS"]
        );
      }

      // 2b) S13-r2#1：非 auto 内容行（如 file:）只要有一个成员作品 pwKey 命中删除快照 pwKeys，整行及新平台作品同样一律隐藏
      {
        const sharedFileKey = "file:c:/v/shared_member_hit.mp4";
        const overrides = {
          version: 1,
          updatedAt: ts("2026-11-20", 12, 0),
          contents: {},
          excludedAuto: {},
          deletedContents: {
            "unlinked:抖音:MEM_DEL": {
              deletedAt: ts("2026-11-20", 12, 5),
              title: "已删单平台作品",
              pwKeys: ["抖音|MEM_DEL"],
            },
          },
          overrides: {},
        };
        const memDeps = {
          now: ts("2026-11-20", 15, 0),
          listAccounts: () => [
            { group: "G1", platform: "抖音" },
            { group: "G1", platform: "小红书" },
          ],
          readWorks: (_g, p) =>
            p === "抖音"
              ? [{ workId: "MEM_DEL", title: "同一素材跨平台作品", publishTime: ts("2026-11-18", 10, 0) }]
              : [{ workId: "MEM_NEW_XHS", title: "同一素材跨平台作品", publishTime: ts("2026-11-19", 10, 0) }],
          readWorksDaily: (_g, p) =>
            p === "抖音"
              ? { MEM_DEL: { "2026-11-20": { play: 500 } } }
              : { MEM_NEW_XHS: { "2026-11-20": { play: 900 } } },
          readWorksIntraday: (_g, p) =>
            p === "抖音"
              ? { MEM_DEL: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 500 }] }
              : { MEM_NEW_XHS: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 900 }] },
          readDaily: () => ({}),
          readPushRecords: () => [
            { id: "m-dy", filePath: "C:\\v\\shared_member_hit.mp4", pt: "抖音", group: "G1", title: "同一素材跨平台作品", publishStatus: "success", date: "2026-11-18" },
            { id: "m-xhs", filePath: "C:\\v\\shared_member_hit.mp4", pt: "小红书", group: "G1", title: "同一素材跨平台作品", publishStatus: "success", date: "2026-11-19" },
          ],
          readLinkOverrides: () => overrides,
        };
        const sumMem = buildContentSummaryData({ date: "2026-11-20" }, memDeps);
        assert.deepStrictEqual(sumMem.rows, [], "file: 内容行有任一成员作品命中 deletedPwKeys 时整行必须隐藏");
        const wbMem = buildStatsWorkbookData({ from: "2026-11-20", to: "2026-11-20" }, memDeps);
        assert.deepStrictEqual(wbMem.sheets["作品跨平台汇总"].slice(1), []);
        assert.deepStrictEqual(wbMem.sheets["作品日明细"].slice(1), []);
        assert.deepStrictEqual(wbMem.sheets["作品时段明细"].slice(1), []);
        assert.strictEqual(buildContentTrendData({ contentKey: sharedFileKey, to: "2026-11-20" }, memDeps).found, false);
        assert.strictEqual(buildContentIntradayData({ contentKey: sharedFileKey, to: "2026-11-20" }, memDeps).found, false);
        assert.deepStrictEqual(buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, memDeps).rankings.byPlay.top, []);
      }

      // 3) P2 #3：旧发布记录位置键 record:pos:0 删除记录 A 后记录 B 接用同一位置键，记录 B 不得在任何链路被误隐藏
      {
        let pushRecs = [
          { pt: "抖音", group: "G1", title: "无ID位置记录A", publishStatus: "success", date: "2026-11-18" },
          { pt: "抖音", group: "G1", title: "无ID位置记录B", publishStatus: "success", date: "2026-11-18" },
        ];
        let overrides = {
          version: 1,
          updatedAt: ts("2026-11-20", 12, 0),
          contents: {},
          excludedAuto: {},
          deletedContents: {},
          overrides: {},
        };
        const posDeps = {
          now: ts("2026-11-20", 15, 0),
          listAccounts: () => [{ group: "G1", platform: "抖音" }],
          readWorks: () => [
            { workId: "POS_WA", title: "无ID位置记录A", publishTime: ts("2026-11-18", 10, 0) },
            { workId: "POS_WB", title: "无ID位置记录B", publishTime: ts("2026-11-18", 11, 0) },
          ],
          readWorksDaily: () => ({
            POS_WA: { "2026-11-19": { play: 700 }, "2026-11-20": { play: 900 } },
            POS_WB: { "2026-11-19": { play: 300 }, "2026-11-20": { play: 450 } },
          }),
          readWorksIntraday: () => ({
            POS_WA: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 900 }],
            POS_WB: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 450 }],
          }),
          readDaily: () => ({}),
          readPushRecords: () => pushRecs,
          readLinkOverrides: () => overrides,
        };

        const { snapshotByKey } = resolveDeleteContentSnapshots(["record:pos:0"], overrides, posDeps);
        const posSnap = snapshotByKey.get("record:pos:0");
        assert.strictEqual(posSnap.title, "无ID位置记录A");
        assert.deepStrictEqual(posSnap.pwKeys, ["抖音|POS_WA"]);
        overrides = {
          ...overrides,
          deletedContents: {
            "record:pos:0": { deletedAt: ts("2026-11-20", 12, 20), title: posSnap.title, pwKeys: posSnap.pwKeys },
          },
        };

        // 删除记录 A 后，记录 B 接用 record:pos:0
        pushRecs = [
          { pt: "抖音", group: "G1", title: "无ID位置记录B", publishStatus: "success", date: "2026-11-18" },
        ];
        const sumPosShift = buildContentSummaryData({ date: "2026-11-20" }, posDeps);
        assert.strictEqual(sumPosShift.rows.length, 1);
        assert.strictEqual(sumPosShift.rows[0].contentKey, "record:pos:0");
        assert.strictEqual(sumPosShift.rows[0].title, "无ID位置记录B");
        assert.strictEqual(sumPosShift.rows[0].totalPlay, 450);
        assert.strictEqual(sumPosShift.deletedRows[0].title, "无ID位置记录A");

        const wbPosShift = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, posDeps);
        assert.deepStrictEqual(wbPosShift.sheets["作品跨平台汇总"].slice(1).map((r) => [r[0], r[1]]), [
          ["record:pos:0", "无ID位置记录B"],
        ]);
        assert.deepStrictEqual(wbPosShift.sheets["作品日明细"].slice(1).map((r) => r[6]), ["POS_WB", "POS_WB"]);
        assert.deepStrictEqual(wbPosShift.sheets["作品时段明细"].slice(1).map((r) => r[7]), ["POS_WB"]);
        const analysisPosShift = buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, posDeps);
        assert.deepStrictEqual(analysisPosShift.rankings.byPlay.top.map((x) => x.title), ["无ID位置记录B"]);
        assert.strictEqual(analysisPosShift.overview.metrics.play.current, 150, "仅计 POS_WB 日增 +150");
        const trendPosB = buildContentTrendData({ contentKey: "record:pos:0", to: "2026-11-20" }, posDeps);
        assert.strictEqual(trendPosB.found, true);
        assert.strictEqual(trendPosB.title, "无ID位置记录B");

        // 无 title 的旧格式 record:pos:0 条目也不得误隐藏记录 B
        overrides = {
          ...overrides,
          deletedContents: {
            "record:pos:0": { deletedAt: ts("2026-11-20", 12, 20) },
          },
        };
        const sumLegacyPos = buildContentSummaryData({ date: "2026-11-20" }, posDeps);
        assert.ok(
          sumLegacyPos.rows.some((r) => r.contentKey === "record:pos:0" && r.title === "无ID位置记录B"),
          "record:pos: 条目缺少 title 时不得误隐藏接用该位置键的内容"
        );
      }

      // 4) S13-r2#2：同一素材展示标题变化不让稳定键（file:/record:id:）删除失效，后续关联进来的作品也保持隐藏
      {
        const stableFileKey = "file:c:/v/multi_title.mp4";
        const stableRecIdKey = "record:id:stable-rec-1";
        let pushRecs = [
          {
            id: "mt-1",
            filePath: "C:\\v\\multi_title.mp4",
            pt: "抖音",
            group: "G1",
            title: "最早平台旧标题",
            publishStatus: "success",
            date: "2026-11-17",
          },
          {
            id: "mt-2",
            filePath: "C:\\v\\multi_title.mp4",
            pt: "快手",
            group: "G1",
            title: "第二平台新标题",
            publishStatus: "success",
            date: "2026-11-18",
          },
          {
            id: "stable-rec-1",
            pt: "抖音",
            group: "G1",
            title: "稳定记录原标题",
            publishStatus: "success",
            date: "2026-11-18",
          },
        ];
        let worksByPt = { 抖音: [], 快手: [] };
        let dailyByPt = { 抖音: {}, 快手: {} };
        let intradayByPt = { 抖音: {}, 快手: {} };
        let overrides = {
          version: 1,
          updatedAt: ts("2026-11-20", 12, 0),
          contents: {},
          excludedAuto: {},
          deletedContents: {},
          overrides: {},
        };
        const titleShiftDeps = {
          now: ts("2026-11-20", 15, 0),
          listAccounts: () => [
            { group: "G1", platform: "抖音" },
            { group: "G1", platform: "快手" },
          ],
          readWorks: (_g, p) => worksByPt[p] || [],
          readWorksDaily: (_g, p) => dailyByPt[p] || {},
          readWorksIntraday: (_g, p) => intradayByPt[p] || {},
          readDaily: () => ({}),
          readPushRecords: () => pushRecs,
          readLinkOverrides: () => overrides,
        };

        // 初始均为空行并删除（快照记录旧标题）
        const { snapshotByKey } = resolveDeleteContentSnapshots(
          [stableFileKey, stableRecIdKey],
          overrides,
          titleShiftDeps
        );
        assert.strictEqual(snapshotByKey.get(stableFileKey).title, "最早平台旧标题");
        assert.strictEqual(snapshotByKey.get(stableRecIdKey).title, "稳定记录原标题");
        overrides = {
          ...overrides,
          deletedContents: {
            [stableFileKey]: { deletedAt: ts("2026-11-20", 12, 30), title: "最早平台旧标题", pwKeys: [] },
            [stableRecIdKey]: { deletedAt: ts("2026-11-20", 12, 31), title: "稳定记录原标题", pwKeys: [] },
          },
        };

        // 移除最早一条发布记录，使 file: 行展示标题变为「第二平台新标题」，且随后快手作品关联进来
        pushRecs = [
          {
            id: "mt-2",
            filePath: "C:\\v\\multi_title.mp4",
            pt: "快手",
            group: "G1",
            title: "第二平台新标题",
            publishStatus: "success",
            date: "2026-11-18",
          },
          {
            id: "stable-rec-1",
            pt: "抖音",
            group: "G1",
            title: "稳定记录改名后标题",
            publishStatus: "success",
            date: "2026-11-18",
          },
        ];
        worksByPt = {
          抖音: [{ workId: "W_REC_SHIFT", title: "稳定记录改名后标题", publishTime: ts("2026-11-18", 10, 0) }],
          快手: [{ workId: "W_FILE_SHIFT", title: "第二平台新标题", publishTime: ts("2026-11-18", 11, 0) }],
        };
        dailyByPt = {
          抖音: { W_REC_SHIFT: { "2026-11-19": { play: 100 }, "2026-11-20": { play: 200 } } },
          快手: { W_FILE_SHIFT: { "2026-11-19": { play: 300 }, "2026-11-20": { play: 500 } } },
        };
        intradayByPt = {
          抖音: { W_REC_SHIFT: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 200 }] },
          快手: { W_FILE_SHIFT: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 500 }] },
        };

        const sumShift = buildContentSummaryData({ date: "2026-11-20" }, titleShiftDeps);
        assert.deepStrictEqual(
          sumShift.rows,
          [],
          "S13-r2#2: file: 与 record:id: 展示标题变化后仍须按 contentKey 保持隐藏"
        );
        assert.strictEqual(sumShift.deletedRows.length, 2);
        const wbShift = buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, titleShiftDeps);
        assert.deepStrictEqual(wbShift.sheets["作品跨平台汇总"].slice(1), []);
        assert.deepStrictEqual(wbShift.sheets["作品日明细"].slice(1), []);
        assert.deepStrictEqual(wbShift.sheets["作品时段明细"].slice(1), []);
        assert.deepStrictEqual(wbShift.sheets["平台日汇总"].slice(1), []);
        assert.strictEqual(buildContentTrendData({ contentKey: stableFileKey, to: "2026-11-20" }, titleShiftDeps).found, false);
        assert.strictEqual(buildContentIntradayData({ contentKey: stableFileKey, to: "2026-11-20" }, titleShiftDeps).found, false);
        assert.deepStrictEqual(buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, titleShiftDeps).rankings.byPlay.top, []);

        const cliShiftOut = path.join(tmpRoot, "s13-r2-title-shift-cli.xlsx");
        const cliShift = await captureConsole(() =>
          runStatsCli({
            action: "export",
            out: cliShiftOut,
            from: "2026-11-19",
            to: "2026-11-20",
            deps: titleShiftDeps,
          })
        );
        assert.strictEqual(cliShift.res, 0);
        const shiftBook = xlsx.readFile(cliShiftOut);
        assert.deepStrictEqual(
          xlsx.utils.sheet_to_json(shiftBook.Sheets["作品跨平台汇总"], { header: 1 }).slice(1),
          []
        );
        assert.deepStrictEqual(
          xlsx.utils.sheet_to_json(shiftBook.Sheets["作品日明细"], { header: 1 }).slice(1),
          []
        );
      }

      // 5) S13-r2#4：读 link-overrides.json 失败（EBUSY / 损坏 JSON / 非法结构，非 ENOENT）时，导出/汇总/分析/趋势/CLI 一律报错中止，不回退为空配置
      {
        const store = require(path.resolve(__dirname, "../src/main/services/dataStats/store.js"));
        const ovPath = path.join(userDataDir, "data-stats", "link-overrides.json");
        const r2FileKey = "file:c:/v/ebusy_guard.mp4";
        const r2Deps = {
          store,
          now: ts("2026-11-20", 15, 0),
          listAccounts: () => [{ group: "G1", platform: "抖音" }],
          readWorks: () => [{ workId: "W_EBUSY_HIDE", title: "已删不得漏出", publishTime: ts("2026-11-19", 10, 0) }],
          readWorksDaily: () => ({ W_EBUSY_HIDE: { "2026-11-19": { play: 100 }, "2026-11-20": { play: 250 } } }),
          readWorksIntraday: () => ({
            W_EBUSY_HIDE: [{ date: "2026-11-20", slot: "10:00", collectedAt: ts("2026-11-20", 10, 0), play: 250 }],
          }),
          readDaily: () => ({}),
          readPushRecords: () => [
            {
              id: "eb-rec-1",
              filePath: "C:\\v\\ebusy_guard.mp4",
              pt: "抖音",
              group: "G1",
              title: "已删不得漏出",
              publishStatus: "success",
              date: "2026-11-19",
            },
          ],
        };

        // 5a) ENOENT（文件不存在）正常返回空配置，不报错
        fs.rmSync(ovPath, { force: true });
        assert.strictEqual(buildContentSummaryData({ date: "2026-11-20" }, r2Deps).rows.length, 1);
        assert.strictEqual(buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, r2Deps).counts.works, 1);
        assert.strictEqual(buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, r2Deps).rankings.byPlay.top.length, 1);
        assert.strictEqual(buildContentTrendData({ contentKey: r2FileKey, to: "2026-11-20" }, r2Deps).found, true);
        assert.strictEqual(buildContentIntradayData({ contentKey: r2FileKey, to: "2026-11-20" }, r2Deps).found, true);

        // 写入有效删除配置，确认正常隐藏
        store.deleteContentsOverride(
          [{ contentKey: r2FileKey, title: "已删不得漏出", pwKeys: ["抖音|W_EBUSY_HIDE"] }],
          ts("2026-11-20", 12, 0)
        );
        assert.strictEqual(buildContentSummaryData({ date: "2026-11-20" }, r2Deps).rows.length, 0);

        // 5b) 注入 EBUSY 临时读失败：所有读/导出路径（含 storeApi 与 readLinkOverrides: store.readLinkOverrides）报错中止，CLI 退出码 1 且不写 xlsx
        const depsViaFn = { ...r2Deps, store: undefined, readLinkOverrides: store.readLinkOverrides };
        const origReadFileSync = fs.readFileSync;
        fs.readFileSync = function patchedEbusy(target, ...rest) {
          if (path.resolve(String(target)) === path.resolve(ovPath)) {
            const err = new Error("EBUSY: resource busy or locked");
            err.code = "EBUSY";
            throw err;
          }
          return origReadFileSync.call(this, target, ...rest);
        };
        const cliEbusyOut = path.join(tmpRoot, "s13-r2-ebusy-cli.xlsx");
        try {
          for (const d of [r2Deps, depsViaFn]) {
            assert.throws(
              () => buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, d),
              (err) => err && err.code === "EBUSY" && err.isLinkOverridesReadError === true
            );
            assert.throws(
              () => buildContentSummaryData({ date: "2026-11-20" }, d),
              (err) => err && err.code === "EBUSY" && err.isLinkOverridesReadError === true
            );
            assert.throws(
              () => buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, d),
              (err) => err && err.code === "EBUSY" && err.isLinkOverridesReadError === true
            );
            assert.throws(
              () => buildContentTrendData({ contentKey: r2FileKey, to: "2026-11-20" }, d),
              (err) => err && err.code === "EBUSY" && err.isLinkOverridesReadError === true
            );
            assert.throws(
              () => buildContentIntradayData({ contentKey: r2FileKey, to: "2026-11-20" }, d),
              (err) => err && err.code === "EBUSY" && err.isLinkOverridesReadError === true
            );
          }
          const cliBusy = await captureConsole(() =>
            runStatsCli({
              action: "export",
              out: cliEbusyOut,
              from: "2026-11-19",
              to: "2026-11-20",
              deps: r2Deps,
            })
          );
          assert.strictEqual(cliBusy.res, 1, "S13-r2#4: EBUSY 时 CLI stats-export 必须返回失败退出码 1");
          const cliBusyJson = JSON.parse(cliBusy.logs.join("\n"));
          assert.strictEqual(cliBusyJson.success, false);
          assert.strictEqual(fs.existsSync(cliEbusyOut), false, "S13-r2#4: 读失败中止时不得写出 xlsx 文件");
        } finally {
          fs.readFileSync = origReadFileSync;
        }

        // 5c) JSON 损坏同样报错中止
        fs.writeFileSync(ovPath, "{broken json", "utf8");
        assert.throws(
          () => buildStatsWorkbookData({ from: "2026-11-19", to: "2026-11-20" }, r2Deps),
          (err) => err && err.code === "LINK_OVERRIDES_PARSE_ERROR" && err.isLinkOverridesReadError === true
        );
        assert.throws(
          () => buildContentSummaryData({ date: "2026-11-20" }, r2Deps),
          (err) => err && err.code === "LINK_OVERRIDES_PARSE_ERROR"
        );
        assert.throws(
          () => buildStatsAnalysisData({ period: 7, to: "2026-11-20" }, r2Deps),
          (err) => err && err.code === "LINK_OVERRIDES_PARSE_ERROR"
        );
        assert.throws(
          () => buildContentTrendData({ contentKey: r2FileKey, to: "2026-11-20" }, r2Deps),
          (err) => err && err.code === "LINK_OVERRIDES_PARSE_ERROR"
        );
        assert.throws(
          () => buildContentIntradayData({ contentKey: r2FileKey, to: "2026-11-20" }, r2Deps),
          (err) => err && err.code === "LINK_OVERRIDES_PARSE_ERROR"
        );
        fs.rmSync(ovPath, { force: true });
      }

      console.log("✓ S13-r1/r2 返修回归（历史截止导出/第三平台整行隐藏/稳定键标题变化/record:pos错位/读失败中止）全通过");
    }

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
