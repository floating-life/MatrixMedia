"use strict";

/**
 * S10 #2 / #3 / #4 / #5 数据质量与采集告警综合单测（修前失败、修后通过）：
 * - #2 分析页平台互动率改加权（含收藏四项 + 不含收藏三项）+ 缺项备注 + 作品排行 play>=100 含收藏 + Excel/图表同步
 * - #3 总览「统计区间 X ~ Y，其中作品日数据实际覆盖 A ~ B（共 K 天）」与不足提示 + 总览涨粉（账号日快照优先 + 单作品辅助，标清来源）
 * - #4 防假 0 覆写：作品历史 play>0 本次 0/缺失写 null 不产生大负增量；账号级总播放骤降且作品级无对应下降标 anomaly 并剔除增量
 * - #5 采集失败告警：报错或「上次作品数>0 本次=0」连续 2 次持久化 + 弹一次 Electron 通知（恢复前不重复弹）+ 成功清除 + cli stats --json 输出 + Vue 模板编译
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");

const { buildStatsAnalysis } = require("../src/main/services/dataStats/statsAnalysis.js");
const { buildWorkDailyRows, buildWorkIntradayRows } = require("../src/main/services/dataStats/statsTable.js");
const { buildPlatformComparisonOption } = require("../src/renderer/utils/statsChartOptions.js");
const { ADAPTERS } = require("../src/main/services/dataStats/adapters.js");

function withStubElectron(fn) {
  const origLoad = Module._load;
  const exportPath = path.resolve(root, "src/main/services/dataStats/statsExport.js");
  const storePath = path.resolve(root, "src/main/services/dataStats/store.js");
  delete require.cache[exportPath];
  delete require.cache[storePath];
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => os.tmpdir(),
          getVersion: () => "0.14.9-test",
        },
      };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    return fn(require(exportPath));
  } finally {
    Module._load = origLoad;
    delete require.cache[exportPath];
    delete require.cache[storePath];
  }
}

function createTempUserData(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadWithMockElectron(tmpUserData, { onNotify, showImpl, collectAccountImpl } = {}) {
  const notifications = [];
  class MockNotification {
    constructor(opts) {
      this.opts = opts;
    }
    show() {
      if (typeof showImpl === "function") {
        showImpl(this.opts);
      }
      notifications.push(this.opts);
      if (typeof onNotify === "function") onNotify(this.opts);
    }
    static isSupported() {
      return true;
    }
  }
  const ipcHandlers = new Map();
  const mockElectron = {
    app: {
      getPath: () => tmpUserData,
      getVersion: () => "0.14.9-test",
      on: () => {},
      once: () => {},
      commandLine: { getSwitchValue: () => "" },
    },
    Notification: MockNotification,
    ipcMain: {
      handle: (ch, fn) => ipcHandlers.set(ch, fn),
      removeHandler: (ch) => ipcHandlers.delete(ch),
    },
    BrowserWindow: { fromWebContents: () => null },
    dialog: {},
  };

  const origLoad = Module._load;
  const collectorPath = path.resolve(root, "src/main/services/dataStats/collector.js");
  const cleared = [
    path.resolve(root, "src/main/services/dataStats/store.js"),
    path.resolve(root, "src/main/services/dataStats/collectAlert.js"),
    path.resolve(root, "src/main/services/dataStats/index.js"),
    collectorPath,
  ];
  for (const f of cleared) delete require.cache[f];

  const xlsxMod = require("xlsx");
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return mockElectron;
    if (
      typeof collectAccountImpl === "function" &&
      (request === "./collector" ||
        request === "./collector.js" ||
        (parent && path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, "") === collectorPath.replace(/\.js$/, "")))
    ) {
      return { collectAccount: collectAccountImpl };
    }
    if (request === "xlsx") return xlsxMod;
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) return { use: () => {}, connect: () => {} };
    return origLoad.apply(this, arguments);
  };

  const store = require("../src/main/services/dataStats/store.js");
  const collectAlert = require("../src/main/services/dataStats/collectAlert.js");

  const restore = () => {
    Module._load = origLoad;
    for (const f of cleared) delete require.cache[f];
  };

  return { store, collectAlert, notifications, ipcHandlers, mockElectron, restore };
}

/* ---------- S10 #2：平台加权互动率 + 三项互动率 + 缺项备注 + 作品排行含收藏 ---------- */
function testS10Item2_WeightedEngagementAndFavorite() {
  const summaryRows = [
    {
      contentKey: "file:/v/a.mp4",
      title: "小播放高互动",
      firstPublishDate: "2026-11-10",
      perPlatform: {
        // 抖音 play=100, like=40, comment=5, share=5, favorite=20 => 4项70, 3项50
        "抖音|主组": { play: 100, like: 40, comment: 5, share: 5, favorite: 20, fansDelta: 2 },
        // 快手缺 share/favorite（null）
        "快手|主组": { play: 200, like: 20, comment: 10, share: null, favorite: null, fansDelta: null },
        // 头条缺 share（null），有 favorite
        "头条|主组": { play: 500, like: 20, comment: 5, share: null, favorite: 25, fansDelta: null },
      },
      totalPlay: 800,
      totalLike: 80,
      totalComment: 20,
      totalShare: 5,
      totalFavorite: 45,
      totalFansDelta: 2,
    },
    {
      contentKey: "file:/v/b.mp4",
      title: "大播放低互动",
      firstPublishDate: "2026-11-12",
      perPlatform: {
        // 抖音 play=9900, like=20, comment=5, share=5, favorite=100 => 4项130, 3项30
        "抖音|主组": { play: 9900, like: 20, comment: 5, share: 5, favorite: 100, fansDelta: 10 },
        "快手|主组": { play: 800, like: 10, comment: 10, share: null, favorite: null, fansDelta: null },
        "头条|主组": { play: 500, like: 10, comment: 5, share: null, favorite: 15, fansDelta: null },
      },
      totalPlay: 11200,
      totalLike: 40,
      totalComment: 20,
      totalShare: 5,
      totalFavorite: 115,
      totalFansDelta: 10,
    },
    {
      contentKey: "file:/v/c.mp4",
      title: "低播不进排行",
      firstPublishDate: "2026-11-13",
      perPlatform: {
        "抖音|主组": { play: 99, like: 50, comment: 10, share: 10, favorite: 20, fansDelta: 1 },
      },
      totalPlay: 99,
      totalLike: 50,
      totalComment: 10,
      totalShare: 10,
      totalFavorite: 20,
      totalFansDelta: 1,
    },
  ];

  const res = buildStatsAnalysis({
    dailyRows: [],
    summaryRows,
    accountRows: [],
    to: "2026-11-20",
    period: 14,
    now: Date.parse("2026-11-20T12:00:00+08:00"),
  });

  const dy = res.platformComparison.platforms.find((p) => p.platform === "抖音");
  const ks = res.platformComparison.platforms.find((p) => p.platform === "快手");
  const tt = res.platformComparison.platforms.find((p) => p.platform === "头条");

  // 抖音加权：Σ4项=(70+130)=200, Σplay=(100+9900)=10000 => 2.00%；三项=(50+30)/10000 = 0.80%
  // 若按旧非加权均值会变成 (70%+1.31%)/2 ≈ 35.66%，加权后精确为 2%
  assert.strictEqual(dy.engagementRate, 0.02);
  assert.strictEqual(dy.engagementRatePct, 2);
  assert.strictEqual(dy.engagementRate3, 0.008);
  assert.strictEqual(dy.engagementRate3Pct, 0.8);
  assert.deepStrictEqual(dy.missingFields, []);

  // 快手：缺分享、收藏（按0计），Σ=(30+20)/1000 = 5%
  assert.strictEqual(ks.engagementRatePct, 5);
  assert.strictEqual(ks.engagementRate3Pct, 5);
  assert.deepStrictEqual(ks.missingFields, ["分享", "收藏"]);
  assert.ok(ks.note.includes("缺分享、收藏"), `快手备注应注明缺项: ${ks.note}`);

  // 头条：缺分享（按0计），含收藏=(50+30)/1000 = 8%，三项=(25+15)/1000 = 4%
  assert.strictEqual(tt.engagementRatePct, 8);
  assert.strictEqual(tt.engagementRate3Pct, 4);
  assert.deepStrictEqual(tt.missingFields, ["分享"]);
  assert.ok(tt.note.includes("缺分享"), `头条备注应注明缺分享: ${tt.note}`);

  // 作品排行：play=99 被 play>=100 门槛过滤；含收藏计算互动率
  const engTop = res.rankings.byEngagement.top;
  assert.strictEqual(engTop.length, 2, "play=99 不得进入作品互动率排行");
  const itemA = engTop.find((x) => x.title === "小播放高互动");
  // (80+20+5+45)/800 = 150/800 = 0.1875 (18.75%)
  assert.strictEqual(itemA.engagementRate, 0.1875);
  assert.strictEqual(itemA.engagementRatePct, 18.75);
  assert.strictEqual(itemA.engagementRate3Pct, 13.13); // 105/800 = 13.125 -> 13.13

  // 图表 tooltip 含加权互动率、三项互动率与缺项口径提示
  const cmpOpt = buildPlatformComparisonOption(res);
  const ksIdx = cmpOpt.xAxis.data.indexOf("快手");
  const tipHtml = cmpOpt.tooltip.formatter([{ dataIndex: ksIdx }]);
  assert.ok(tipHtml.includes("加权互动率"), "tooltip 应标明加权互动率");
  assert.ok(tipHtml.includes("三项互动率"), "tooltip 应展示三项互动率");
  assert.ok(tipHtml.includes("缺分享、收藏"), "tooltip 应提示快手缺失字段");

  // Excel「分析」sheet 与「字段说明」同步校验
  const wb = withStubElectron(({ buildStatsWorkbookData }) =>
    buildStatsWorkbookData(
      { from: "2026-11-10", to: "2026-11-20", now: Date.parse("2026-11-20T12:00:00+08:00") },
      {
        listAccounts: () => [
          { group: "主组", platform: "抖音", meta: {} },
          { group: "主组", platform: "快手", meta: {} },
        ],
        readAccount: (g, p) => ({
          group: g,
          platform: p,
          daily: {
            "2026-11-10": { fans: 100, plays: 1000 },
            "2026-11-20": { fans: 150, plays: 2000 },
          },
          works: [{ workId: p === "抖音" ? "W1" : "W2", title: "同款内容", publishTime: Date.parse("2026-11-10T10:00:00+08:00") }],
          meta: {},
        }),
        readWorksDaily: (_g, p) =>
          p === "抖音"
            ? { W1: { "2026-11-20": { play: 1000, like: 50, comment: 10, share: 10, favorite: 30, fansDelta: 5 } } }
            : { W2: { "2026-11-20": { play: 1000, like: 50, comment: 10, share: null, favorite: null, fansDelta: null } } },
        readWorksIntraday: () => ({}),
        readPushRecords: () => [
          { id: "r1", pt: "抖音", phone: "主组", title: "同款内容", filePath: "/v/same.mp4", date: "2026-11-10", publishStatus: "success" },
          { id: "r2", pt: "快手", phone: "主组", title: "同款内容", filePath: "/v/same.mp4", date: "2026-11-10", publishStatus: "success" },
        ],
        readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
      }
    )
  );
  const analysisSheet = wb.sheets["分析"];
  const cmpHeaderRow = analysisSheet.find(
    (r) => Array.isArray(r) && r.includes("加权互动率(%)") && r.includes("三项互动率(%)")
  );
  assert.ok(cmpHeaderRow, "Excel 分析 sheet 第 2 节必须包含「加权互动率(%)」与「三项互动率(%)」列");
  const schemaText = wb.sheets["字段说明"].map((r) => r.join(" ")).join("\n");
  assert.ok(schemaText.includes("三项互动率(%)"), "字段说明应包含三项互动率口径");
  assert.ok(schemaText.includes("快手缺分享、收藏"), "字段说明应注明快手缺项");

  console.log("✓ S10 #2 平台加权互动率、三项互动率、缺项备注与作品排行含收藏验证通过");
}

/* ---------- S10 #3：总览实际覆盖口径 + 总览涨粉（账号日快照优先 + 单作品辅助） ---------- */
function testS10Item3_OverviewCoverageAndFansSource() {
  // 统计区间近 30 天（2026-10-22 ~ 2026-11-20），作品日快照仅覆盖 2026-11-16 ~ 2026-11-20 共 5 天
  const dailyRows = [
    { date: "2026-11-16", platform: "抖音", group: "主组", workId: "D1", title: "视频1", play: 100, like: 10, comment: 1, share: 1, favorite: 2, fansDelta: 5 },
    { date: "2026-11-17", platform: "抖音", group: "主组", workId: "D1", title: "视频1", play: 200, like: 20, comment: 2, share: 2, favorite: 4, fansDelta: 15 },
    { date: "2026-11-18", platform: "抖音", group: "主组", workId: "D1", title: "视频1", play: 300, like: 30, comment: 3, share: 3, favorite: 6, fansDelta: 25 },
    { date: "2026-11-19", platform: "抖音", group: "主组", workId: "D1", title: "视频1", play: 400, like: 40, comment: 4, share: 4, favorite: 8, fansDelta: 35 },
    { date: "2026-11-20", platform: "抖音", group: "主组", workId: "D1", title: "视频1", play: 500, like: 50, comment: 5, share: 5, favorite: 10, fansDelta: 45 },
  ];
  // 账号日快照覆盖抖音（1000->1060 = +60）+ 快手（2000->2240 = +240，无单作品涨粉）=> 合计 +300
  const accountRows = [
    { date: "2026-11-16", platform: "抖音", group: "主组", fans: 1000, plays: 5000 },
    { date: "2026-11-20", platform: "抖音", group: "主组", fans: 1060, plays: 5400 },
    { date: "2026-11-16", platform: "快手", group: "主组", fans: 2000, plays: 8000 },
    { date: "2026-11-20", platform: "快手", group: "主组", fans: 2240, plays: 8500 },
  ];

  const res = buildStatsAnalysis({
    dailyRows,
    summaryRows: [],
    accountRows,
    to: "2026-11-20",
    period: 30,
    now: Date.parse("2026-11-20T12:00:00+08:00"),
  });

  // 实际覆盖口径
  assert.strictEqual(
    res.coverage.rangeText,
    "统计区间 2026-10-22 ~ 2026-11-20，其中作品日数据实际覆盖 2026-11-16 ~ 2026-11-20（共 5 天）"
  );
  assert.strictEqual(res.coverage.coveredDays, 5);
  assert.strictEqual(res.coverage.periodDays, 30);
  assert.strictEqual(res.coverage.isPartial, true);
  assert.ok(res.coverage.partialNotice.includes("5") && res.coverage.partialNotice.includes("30"));
  assert.ok(
    res.summary.lines[0].includes("统计区间 2026-10-22 ~ 2026-11-20，其中作品日数据实际覆盖 2026-11-16 ~ 2026-11-20（共 5 天）"),
    `小结首行应采用实际覆盖口径: ${res.summary.lines[0]}`
  );

  // 总览涨粉：账号日快照主口径 = 60 + 240 = 300；单作品涨粉辅助行 = 45 - 5 = 40
  assert.strictEqual(res.overview.accountFansGrowth.current, 300);
  assert.ok(res.overview.accountFansGrowth.source.includes("账号日快照"));
  assert.strictEqual(res.overview.workFansGrowth.current, 40);
  assert.ok(res.overview.workFansGrowth.source.includes("单作品"));
  assert.strictEqual(res.overview.primaryFansGrowth.current, 300);
  assert.ok(res.summary.lines[0].includes("300"), "小结应优先展示账号日快照涨粉 300");

  // 表格行顺序：账号快照主口径在单作品辅助行之前，且均标来源
  const rows = res.overview.metricRows;
  const accIdx = rows.findIndex((r) => r.key === "accountFansGrowth");
  const workIdx = rows.findIndex((r) => r.key === "workFansDelta");
  assert.ok(accIdx !== -1 && workIdx !== -1 && accIdx < workIdx);
  assert.ok(rows[accIdx].source && rows[workIdx].source);

  // 全覆盖（period=5 且 5 天都有数据）不提示不足
  const resFull = buildStatsAnalysis({
    dailyRows,
    summaryRows: [],
    accountRows,
    to: "2026-11-20",
    period: 5,
    now: Date.parse("2026-11-20T12:00:00+08:00"),
  });
  assert.strictEqual(resFull.coverage.isPartial, false);
  assert.strictEqual(resFull.coverage.partialNotice, "");

  console.log("✓ S10 #3 分析总览实际覆盖口径与账号日快照涨粉主口径验证通过");
}

/* ---------- S10 #4：防假 0 覆写（作品级 + 账号级） ---------- */
function testS10Item4_FalseZeroGuard() {
  const tmpUserData = createTempUserData("mm-s10-zero-");
  const env = loadWithMockElectron(tmpUserData);
  try {
    const { store } = env;
    const t1 = Date.parse("2026-11-19T10:00:00+08:00");
    const t2 = Date.parse("2026-11-20T10:00:00+08:00");
    const t3 = Date.parse("2026-11-20T14:00:00+08:00");

    // Day 1 正常采集：W1 play=5000，全新作品 W_NEW play=0，账号总播放 50000
    store.mergeDaily("A组", "抖音", { fans: 1000, plays: 50000, likes: 500 }, [], t1, {
      works: [
        { workId: "W1", title: "老视频", publishTime: t1 - 86400000, play: 5000, like: 100, comment: 10, share: 5, favorite: 20, fansDelta: 3 },
        { workId: "W_NEW", title: "新发0播", publishTime: t1, play: 0, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      ],
    });
    store.mergeWorks(
      "A组",
      "抖音",
      [
        { workId: "W1", title: "老视频", publishTime: t1 - 86400000, play: 5000, like: 100, comment: 10, share: 5, favorite: 20, fansDelta: 3 },
        { workId: "W_NEW", title: "新发0播", publishTime: t1, play: 0, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      ],
      t1
    );

    // Day 2 异常接口：W1 返回假 0（like 正常涨到 120），W_NEW 仍为真实 0；账号总播放骤降至 0（作品级未降）
    store.mergeDaily("A组", "抖音", { fans: 1020, plays: 0, likes: 530 }, [], t2, {
      works: [
        { workId: "W1", title: "老视频", publishTime: t1 - 86400000, play: 0, like: 120, comment: 12, share: 6, favorite: 25, fansDelta: 4 },
        { workId: "W_NEW", title: "新发0播", publishTime: t1, play: 0, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      ],
    });
    store.mergeWorks(
      "A组",
      "抖音",
      [
        { workId: "W1", title: "老视频", publishTime: t1 - 86400000, play: 0, like: 120, comment: 12, share: 6, favorite: 25, fansDelta: 4 },
        { workId: "W_NEW", title: "新发0播", publishTime: t1, play: 0, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      ],
      t2
    );

    // 验证作品级快照：W1 play 写 null、like 正常写 120；W_NEW 仍写 0
    const worksDaily = store.readWorksDaily("A组", "抖音");
    assert.strictEqual(worksDaily.W1["2026-11-20"].play, null, "历史 play>0 本次返回 0 时，日快照 play 必须写 null");
    assert.strictEqual(worksDaily.W1["2026-11-20"].like, 120, "其他字段 like 必须正常写入");
    assert.strictEqual(worksDaily.W_NEW["2026-11-20"].play, 0, "从未 play>0 的新作品 0 应保留为 0");

    // works.json 不被假 0 覆写
    const savedWorks = store.readWorks("A组", "抖音").works;
    const savedW1 = savedWorks.find((w) => w.workId === "W1");
    assert.strictEqual(savedW1.play, 5000, "works.json 中 W1.play 不得被假 0 覆写");
    assert.strictEqual(savedW1.like, 120, "works.json 中 W1.like 应正常更新");

    // 日增与分时段增量不得出现大负数 -5000
    const dailyTableRows = buildWorkDailyRows({
      group: "A组",
      platform: "抖音",
      works: savedWorks,
      worksDaily,
    });
    const w1Day2 = dailyTableRows.find((r) => r.workId === "W1" && r.date === "2026-11-20");
    assert.strictEqual(w1Day2.play, null);
    assert.strictEqual(w1Day2.playDelta, null, "作品日增 playDelta 不得出现大负数");
    assert.strictEqual(w1Day2.likeDelta, 20, "其他字段日增应正常计算");

    const intradayRows = buildWorkIntradayRows({
      group: "A组",
      platform: "抖音",
      works: savedWorks,
      worksIntraday: store.readWorksIntraday("A组", "抖音"),
    });
    const w1Slot2 = intradayRows.find((r) => r.workId === "W1" && r.date === "2026-11-20");
    assert.strictEqual(w1Slot2.play, null);
    assert.strictEqual(w1Slot2.playDelta, null, "分时段增量 playDelta 不得出现大负数");
    assert.strictEqual(w1Slot2.likeDelta, 20);

    // 验证账号级总播放假 0：标记 playsAnomaly=true，plays=null，不参与增量且写入 anomalies.collectionAnomalies
    const daily = store.readDaily("A组", "抖音");
    assert.strictEqual(daily["2026-11-20"].plays, null);
    assert.strictEqual(daily["2026-11-20"].playsAnomaly, true);
    assert.strictEqual(daily["2026-11-20"].fans, 1020, "账号级粉丝字段应正常写入");

    const analysis = buildStatsAnalysis({
      dailyRows: [
        { date: "2026-11-19", platform: "抖音", group: "A组", workId: "W1", title: "老视频", play: 5000 },
        { date: "2026-11-20", platform: "抖音", group: "A组", workId: "W1", title: "老视频", play: 5100 },
      ],
      summaryRows: [],
      accountRows: [
        { date: "2026-11-19", platform: "抖音", group: "A组", fans: 1000, plays: 50000 },
        { date: "2026-11-20", platform: "抖音", group: "A组", fans: 1020, plays: 1000 },
      ],
      to: "2026-11-20",
      period: 7,
      now: t3,
    });
    assert.strictEqual(analysis.overview.accountSummary.playsDelta.current, null, "账号总播放骤降异常不得参与增量");
    assert.ok(
      analysis.anomalies.collectionAnomalies.some((a) => a.scope === "account" && a.metric === "plays"),
      "账号总播放骤降应复用 anomalies.collectionAnomalies 上报"
    );

    // 若作品级也有对应大幅下降（如删大爆款视频），则不应误报 anomaly
    store.mergeDaily("B组", "抖音", { fans: 100, plays: 10000 }, [], t1, {
      works: [{ workId: "BIG", title: "大爆款", publishTime: t1, play: 9000 }],
    });
    store.mergeWorks("B组", "抖音", [{ workId: "BIG", title: "大爆款", publishTime: t1, play: 9000 }], t1);
    store.mergeDaily("B组", "抖音", { fans: 100, plays: 1000 }, [], t2, {
      works: [{ workId: "SMALL", title: "小视频", publishTime: t2, play: 1000 }],
    });
    const bDaily = store.readDaily("B组", "抖音");
    assert.strictEqual(bDaily["2026-11-20"].plays, 1000, "作品级同步下降时账号总播放应正常记录");
    assert.ok(!bDaily["2026-11-20"].playsAnomaly);

    console.log("✓ S10 #4 作品级与账号级防假 0 / 骤降覆写及 anomaly 复用验证通过");
  } finally {
    env.restore();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
}

/* ---------- S10 #5：采集失败告警（持久化 + 通知一次 + 成功清除 + cli stats --json + Vue 模板） ---------- */
async function testS10Item5_CollectFailureAlerts() {
  const tmpUserData = createTempUserData("mm-s10-alert-");
  const env = loadWithMockElectron(tmpUserData);
  try {
    const { store, collectAlert, notifications } = env;
    const { handleAccountCollectOutcome } = collectAlert;
    const t0 = Date.parse("2026-11-20T09:00:00+08:00");

    // 预置有数据的账号（2 条作品）
    store.mergeDaily("A组", "视频号", { fans: 500, plays: 2000 }, [], t0);
    store.mergeWorks(
      "A组",
      "视频号",
      [
        { workId: "S1", title: "视频1", publishTime: t0, play: 1000 },
        { workId: "S2", title: "视频2", publishTime: t0, play: 1000 },
      ],
      t0
    );
    store.writeMeta("A组", "视频号", { lastCollectAt: t0, lastError: "", workCount: 2 });

    // 第 1 次失败（登录失效）：持久化 consecutiveFailures=1，尚不告警、不弹通知
    const r1 = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: false,
      error: "登录态已失效，请重新扫码",
      now: t0 + 60000,
    });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.alert.consecutiveFailures, 1);
    assert.strictEqual(r1.alert.alerted, false);
    assert.strictEqual(r1.notified, false);
    assert.strictEqual(notifications.length, 0, "仅失败 1 次不得弹通知");
    assert.strictEqual(store.getAccountCollectAlert("A组", "视频号"), null, "仅失败 1 次不展示活跃告警");

    // 第 2 次连续失败：触发持久化 alerted=true + 弹一次 Electron 系统通知
    const r2 = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: false,
      error: "登录态已失效，请重新扫码",
      now: t0 + 120000,
    });
    assert.strictEqual(r2.alert.consecutiveFailures, 2);
    assert.strictEqual(r2.alert.alerted, true);
    assert.strictEqual(r2.alert.isLoginError, true);
    assert.strictEqual(r2.alert.firstFailedAt, t0 + 60000, "首次失败时间应保留第 1 次失败时刻");
    assert.strictEqual(r2.notified, true);
    assert.strictEqual(notifications.length, 1, "连续失败 2 次应恰好弹 1 次系统通知");

    // 第 3 次连续失败：累加次数但不再重复弹通知
    const r3 = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: false,
      error: "登录态已失效，请重新扫码",
      now: t0 + 180000,
    });
    assert.strictEqual(r3.alert.consecutiveFailures, 3);
    assert.strictEqual(r3.notified, false);
    assert.strictEqual(notifications.length, 1, "恢复成功前不得重复弹系统通知");

    // readOverview / readAccount / cli stats --json 均带上告警状态
    const ov = store.readOverview();
    assert.strictEqual(ov.collectAlerts.length, 1);
    assert.strictEqual(ov.collectAlerts[0].platform, "视频号");
    assert.strictEqual(ov.collectAlerts[0].consecutiveFailures, 3);
    const accData = store.readAccount("A组", "视频号");
    assert.ok(accData.collectAlert && accData.collectAlert.alerted === true);

    // 验证 cli stats --json（经 esbuild 打包 cli/index.js 验证 runStatsGetWithAlerts）
    const cliOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-cli-stats-"));
    try {
      const cliBundle = path.join(cliOutDir, "cliIndex.cjs");
      esbuild.buildSync({
        entryPoints: [path.join(root, "src/main/cli/index.js")],
        outfile: cliBundle,
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron", "puppeteer-core", "puppeteer-extra", "puppeteer-extra-plugin-stealth", "puppeteer-in-electron", "xlsx"],
      });
      const { runStatsGetWithAlerts } = require(cliBundle);
      const logs = [];
      const code = await runStatsGetWithAlerts(
        { action: "get", platform: "视频号", phone: "A组", json: true },
        { store, log: (s) => logs.push(s) }
      );
      assert.strictEqual(code, 0);
      const parsedJson = JSON.parse(logs[0]);
      assert.strictEqual(parsedJson.hasCollectAlert, true);
      assert.strictEqual(parsedJson.collectAlert.platform, "视频号");
      assert.strictEqual(parsedJson.collectAlert.consecutiveFailures, 3);
      assert.strictEqual(parsedJson.collectAlert.firstFailedAt, t0 + 60000);
    } finally {
      fs.rmSync(cliOutDir, { recursive: true, force: true });
    }

    // 有效成功 1 次即清除告警
    const rOk = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: true,
      works: [{ workId: "S1", title: "视频1", play: 1100 }],
      now: t0 + 240000,
    });
    assert.strictEqual(rOk.ok, true);
    assert.strictEqual(store.getAccountCollectAlert("A组", "视频号"), null, "成功一次应立即清除告警");

    // 场景 B：「上次作品数 > 0，本次 = 0」连续 2 次触发告警与通知
    const z1 = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: true,
      works: [],
      now: t0 + 300000,
    });
    assert.strictEqual(z1.ok, false);
    assert.strictEqual(z1.zeroWorksAnomaly, true);
    assert.strictEqual(notifications.length, 1);

    const z2 = handleAccountCollectOutcome({
      group: "A组",
      platform: "视频号",
      success: true,
      works: [],
      now: t0 + 360000,
    });
    assert.strictEqual(z2.ok, false);
    assert.strictEqual(z2.zeroWorksAnomaly, true);
    assert.strictEqual(z2.alert.alerted, true);
    assert.strictEqual(z2.notified, true);
    assert.strictEqual(notifications.length, 2, "清除后再次连续 2 次 0 作品异常应新弹 1 次通知");

    // Vue 模板编译校验（dataStats/index.vue, group.vue, GroupStatsTable.vue）
    for (const rel of [
      "src/renderer/views/dataStats/index.vue",
      "src/renderer/views/dataStats/group.vue",
      "src/renderer/views/dataStats/components/GroupStatsTable.vue",
    ]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      const sfc = compiler.parseComponent(src);
      assert.ok(sfc.template && sfc.template.content, `${rel} 应含 <template>`);
      const compiled = compiler.compile(sfc.template.content);
      assert.strictEqual(
        compiled.errors.length,
        0,
        `${rel} 模板编译报错: ${compiled.errors.join("; ")}`
      );
    }

    console.log("✓ S10 #5 采集失败告警持久化、系统通知防重、成功清除、cli stats --json 与 GUI 模板校验通过");
  } finally {
    env.restore();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
}

/* ---------- S10-fix #2：有播放互动全缺计入分母 + 合并内容零播放作品互动不计入 ---------- */
function testS10Fix2_WeightedDenominatorAndZeroPlayExclusion() {
  // 2a: 两条参与跨平台对比的抖音作品：「100 播放、10 赞、5 收藏」与「900 播放、互动全缺」
  // 期望四项=15/1000=1.5%，三项=10/1000=1%（GUI 与 Excel 同步）
  const wb2a = withStubElectron(({ buildStatsWorkbookData }) =>
    buildStatsWorkbookData(
      { from: "2026-11-10", to: "2026-11-20", now: Date.parse("2026-11-20T12:00:00+08:00") },
      {
        listAccounts: () => [
          { group: "主组", platform: "抖音", meta: {} },
          { group: "主组", platform: "快手", meta: {} },
        ],
        readDaily: () => ({ "2026-11-20": { fans: 100, plays: 1000 } }),
        readWorks: (_g, p) => ({
          works:
            p === "抖音"
              ? [
                  { workId: "DY1", title: "跨平台实测内容甲", publishTime: Date.parse("2026-11-10T10:00:00+08:00") },
                  { workId: "DY2", title: "跨平台实测内容乙", publishTime: Date.parse("2026-11-12T10:00:00+08:00") },
                ]
              : [
                  { workId: "KS1", title: "跨平台实测内容甲", publishTime: Date.parse("2026-11-10T10:00:00+08:00") },
                  { workId: "KS2", title: "跨平台实测内容乙", publishTime: Date.parse("2026-11-12T10:00:00+08:00") },
                ],
        }),
        readWorksDaily: (_g, p) =>
          p === "抖音"
            ? {
                DY1: { "2026-11-20": { play: 100, like: 10, comment: null, share: null, favorite: 5, fansDelta: null } },
                DY2: { "2026-11-20": { play: 900, like: null, comment: null, share: null, favorite: null, fansDelta: null } },
              }
            : {
                KS1: { "2026-11-20": { play: 200, like: 4, comment: 0, share: null, favorite: null, fansDelta: null } },
                KS2: { "2026-11-20": { play: 200, like: 6, comment: 0, share: null, favorite: null, fansDelta: null } },
              },
        readWorksIntraday: () => ({}),
        readPushRecords: () => [
          { id: "p1", pt: "抖音", phone: "主组", title: "跨平台实测内容甲", filePath: "/v/a.mp4", date: "2026-11-10", publishStatus: "success" },
          { id: "p2", pt: "快手", phone: "主组", title: "跨平台实测内容甲", filePath: "/v/a.mp4", date: "2026-11-10", publishStatus: "success" },
          { id: "p3", pt: "抖音", phone: "主组", title: "跨平台实测内容乙", filePath: "/v/b.mp4", date: "2026-11-12", publishStatus: "success" },
          { id: "p4", pt: "快手", phone: "主组", title: "跨平台实测内容乙", filePath: "/v/b.mp4", date: "2026-11-12", publishStatus: "success" },
        ],
        readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
      }
    )
  );
  const dy2a = wb2a.analysis.platformComparison.platforms.find((p) => p.platform === "抖音");
  assert.strictEqual(dy2a.engagementRate, 0.015, "有播放互动全缺的作品必须保留在分母：四项应为 1.5%");
  assert.strictEqual(dy2a.engagementRatePct, 1.5);
  assert.strictEqual(dy2a.engagementRate3, 0.01, "三项应为 1%");
  assert.strictEqual(dy2a.engagementRate3Pct, 1);
  const cmpRow2a = wb2a.sheets["分析"].find((r) => Array.isArray(r) && r[0] === "抖音" && r[1] === 2);
  assert.ok(cmpRow2a, "Excel 分析 sheet 应含抖音平台对比行");
  assert.strictEqual(cmpRow2a[3], 1.5, "Excel 四项加权互动率应为 1.5");
  assert.strictEqual(cmpRow2a[4], 1, "Excel 三项互动率应为 1");

  // 2b: 同款内容合并两条抖音作品「100 播放、10 赞、5 收藏」和「0 播放、30 赞、5 收藏」
  // 期望先按作品判断 play>0 再合并，零播放作品的 30 赞 5 收藏不计入，四项=15%、三项=10%
  const wb2b = withStubElectron(({ buildStatsWorkbookData }) =>
    buildStatsWorkbookData(
      { from: "2026-11-10", to: "2026-11-20", now: Date.parse("2026-11-20T12:00:00+08:00") },
      {
        listAccounts: () => [
          { group: "主组", platform: "抖音", meta: {} },
          { group: "主组", platform: "快手", meta: {} },
        ],
        readDaily: () => ({ "2026-11-20": { fans: 100, plays: 100 } }),
        readWorks: (_g, p) => ({
          works:
            p === "抖音"
              ? [
                  { workId: "DY_POS", title: "同款内容", publishTime: Date.parse("2026-11-10T10:00:00+08:00") },
                  { workId: "DY_ZERO", title: "同款内容补发", publishTime: Date.parse("2026-11-11T10:00:00+08:00") },
                ]
              : [{ workId: "KS_ONE", title: "同款内容", publishTime: Date.parse("2026-11-10T10:00:00+08:00") }],
        }),
        readWorksDaily: (_g, p) =>
          p === "抖音"
            ? {
                DY_POS: { "2026-11-20": { play: 100, like: 10, comment: 0, share: 0, favorite: 5, fansDelta: 0 } },
                DY_ZERO: { "2026-11-20": { play: 0, like: 30, comment: 0, share: 0, favorite: 5, fansDelta: 0 } },
              }
            : {
                KS_ONE: { "2026-11-20": { play: 200, like: 10, comment: 0, share: null, favorite: null, fansDelta: null } },
              },
        readWorksIntraday: () => ({}),
        readPushRecords: () => [
          { id: "m1", pt: "抖音", phone: "主组", title: "同款内容", filePath: "/v/m.mp4", date: "2026-11-10", publishStatus: "success" },
          { id: "m2", pt: "快手", phone: "主组", title: "同款内容", filePath: "/v/m.mp4", date: "2026-11-10", publishStatus: "success" },
        ],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: Date.parse("2026-11-15T10:00:00+08:00"),
          contents: { "manual:m1": { title: "同款内容", createdAt: Date.parse("2026-11-15T10:00:00+08:00") } },
          excludedAuto: {},
          overrides: {
            "抖音|DY_POS": { action: "assign", contentKey: "manual:m1" },
            "抖音|DY_ZERO": { action: "assign", contentKey: "manual:m1" },
            "快手|KS_ONE": { action: "assign", contentKey: "manual:m1" },
          },
        }),
      }
    )
  );
  const dy2b = wb2b.analysis.platformComparison.platforms.find((p) => p.platform === "抖音");
  assert.strictEqual(dy2b.engagementRate, 0.15, "合并同款内容后零播放作品的互动不得计入，四项应为 15%");
  assert.strictEqual(dy2b.engagementRatePct, 15);
  assert.strictEqual(dy2b.engagementRate3, 0.1, "三项应为 10%");
  assert.strictEqual(dy2b.engagementRate3Pct, 10);

  // 同理验证仅传 summaryRows（无 dailyRows，但含 cell.works 或同平台跨分组双单元格）也遵循先判 play>0 再合并
  const r2bDirect = buildStatsAnalysis({
    dailyRows: [],
    summaryRows: [
      {
        contentKey: "file:/v/merged.mp4",
        title: "合并内容",
        firstPublishDate: "2026-11-10",
        perPlatform: {
          "抖音|A组": {
            play: 100,
            like: 40,
            comment: 0,
            share: 0,
            favorite: 10,
            works: [
              { workId: "W1", platform: "抖音", play: 100, like: 10, comment: 0, share: 0, favorite: 5 },
              { workId: "W2", platform: "抖音", play: 0, like: 30, comment: 0, share: 0, favorite: 5 },
            ],
          },
          "快手|A组": { play: 100, like: 5, comment: 0, share: null, favorite: null },
        },
      },
    ],
    accountRows: [],
    to: "2026-11-20",
    period: 14,
  });
  const dyDirect = r2bDirect.platformComparison.platforms.find((p) => p.platform === "抖音");
  assert.strictEqual(dyDirect.engagementRatePct, 15);
  assert.strictEqual(dyDirect.engagementRate3Pct, 10);

  console.log("✓ S10-fix #2 有播放互动全缺入分母与合并内容零播放互动排除验证通过");
}

/* ---------- S10-fix #4：作品假 0 联动账号异常、同日比较、时段沿用有效值、旧快照导出口径一致 ---------- */
function testS10Fix4_AccountAnomalyLinkageSameDayIntradayAndLegacyExport() {
  const tmpUserData = createTempUserData("mm-s10-fix4-");
  const env = loadWithMockElectron(tmpUserData);
  try {
    const { store } = env;
    const tYest = Date.parse("2026-11-19T10:00:00+08:00");
    const tToday10 = Date.parse("2026-11-20T10:00:00+08:00");
    const tToday14 = Date.parse("2026-11-20T14:00:00+08:00");
    const tToday16 = Date.parse("2026-11-20T16:00:00+08:00");

    // 4a: 抖音仅 1 条作品，昨日作品和账号总播放均为 100000，今日接口均返回 0
    // 严格按真实采集顺序：先 mergeDaily 再 mergeWorks
    store.mergeDaily("D组", "抖音", { fans: 500, plays: 100000 }, [], tYest, {
      works: [{ workId: "DY_ONLY", title: "唯一爆款", publishTime: tYest - 86400000, play: 100000, like: 500 }],
    });
    store.mergeWorks(
      "D组",
      "抖音",
      [{ workId: "DY_ONLY", title: "唯一爆款", publishTime: tYest - 86400000, play: 100000, like: 500 }],
      tYest
    );

    store.mergeDaily("D组", "抖音", { fans: 510, plays: 0 }, [], tToday10, {
      works: [{ workId: "DY_ONLY", title: "唯一爆款", publishTime: tYest - 86400000, play: 0, like: 520 }],
    });
    store.mergeWorks(
      "D组",
      "抖音",
      [{ workId: "DY_ONLY", title: "唯一爆款", publishTime: tYest - 86400000, play: 0, like: 520 }],
      tToday10
    );

    const dyWorkDaily = store.readWorksDaily("D组", "抖音");
    assert.strictEqual(dyWorkDaily.DY_ONLY["2026-11-20"].play, null, "4a: 作品假 0 应置空");
    const dyDaily = store.readDaily("D组", "抖音");
    assert.strictEqual(dyDaily["2026-11-20"].plays, null, "4a: 作品假 0 联动账号总播放也置空");
    assert.strictEqual(dyDaily["2026-11-20"].playsAnomaly, true, "4a: 账号总播放应标 playsAnomaly");

    // 4b: B 站账号昨日 1000，今天 10:00 为 9000（作品 9000），14:00 降到 2000（作品 9100）
    store.mergeDaily("B站组", "哔哩哔哩", { fans: 100, plays: 1000 }, [], tYest, {
      works: [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 1000 }],
    });
    store.mergeWorks("B站组", "哔哩哔哩", [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 1000 }], tYest);

    store.mergeDaily("B站组", "哔哩哔哩", { fans: 110, plays: 9000 }, [], tToday10, {
      works: [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 9000 }],
    });
    store.mergeWorks("B站组", "哔哩哔哩", [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 9000 }], tToday10);

    store.mergeDaily("B站组", "哔哩哔哩", { fans: 112, plays: 2000 }, [], tToday14, {
      works: [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 9100 }],
    });
    store.mergeWorks("B站组", "哔哩哔哩", [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 9100 }], tToday14);

    const blblDaily14 = store.readDaily("B站组", "哔哩哔哩");
    assert.strictEqual(blblDaily14["2026-11-20"].plays, null, "4b: 同日 14:00 相对 10:00 的 9000 骤降至 2000 应置空");
    assert.strictEqual(blblDaily14["2026-11-20"].playsAnomaly, true, "4b: 同日骤降应标 playsAnomaly");
    assert.strictEqual(blblDaily14["2026-11-20"].playsAnomalyDetail.prevDate, "2026-11-20");
    assert.strictEqual(blblDaily14["2026-11-20"].playsAnomalyDetail.prevValue, 9000);

    // 16:00 继续异常返回 2500 仍相对当日 9000 判异常；恢复 9200 后解除异常
    store.mergeDaily("B站组", "哔哩哔哩", { fans: 113, plays: 2500 }, [], tToday16, {
      works: [{ workId: "BV1", title: "B站视频", publishTime: tYest - 86400000, play: 9150 }],
    });
    assert.strictEqual(store.readDaily("B站组", "哔哩哔哩")["2026-11-20"].playsAnomaly, true);

    // 验证 4a 与 4b 在同一份 Excel「账号日快照」均置空并标注
    const wb4ab = withStubElectron(({ buildStatsWorkbookData }) =>
      buildStatsWorkbookData(
        { from: "2026-11-19", to: "2026-11-20", now: tToday16 },
        {
          listAccounts: () => [
            { group: "D组", platform: "抖音", meta: {} },
            { group: "B站组", platform: "哔哩哔哩", meta: {} },
          ],
          readDaily: (g, p) => store.readDaily(g, p),
          readWorks: (g, p) => store.readWorks(g, p),
          readWorksDaily: (g, p) => store.readWorksDaily(g, p),
          readWorksIntraday: (g, p, r) => store.readWorksIntraday(g, p, r),
          readPushRecords: () => [],
          readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
        }
      )
    );
    const s4ab = wb4ab.sheets["账号日快照"].slice(1);
    const dyRow20 = s4ab.find((r) => r[0] === "2026-11-20" && r[1] === "抖音" && r[2] === "D组");
    assert.strictEqual(dyRow20[4], null, "4a Excel 账号日快照总播放应为空");
    assert.strictEqual(dyRow20[10], null, "4a Excel 账号日快照播放日增应为空（不为 -100000）");
    assert.ok(dyRow20[11] && dyRow20[11].includes("骤降"), `4a 异常标注应非空: ${dyRow20[11]}`);
    const blblRow20 = s4ab.find((r) => r[0] === "2026-11-20" && r[1] === "哔哩哔哩" && r[2] === "B站组");
    assert.strictEqual(blblRow20[4], null, "4b Excel 账号日快照总播放应为空（不为 2000）");
    assert.strictEqual(blblRow20[10], null, "4b Excel 账号日快照播放日增应为空（不为 +1000）");
    assert.ok(blblRow20[11] && blblRow20[11].includes("9000"), `4b 异常标注应指明相对 9000 骤降: ${blblRow20[11]}`);

    // 4c: 合并内容下两条同平台作品时段分别为 10000 -> 假 0(null) 与 100 -> 120，时段图不出现 -9980
    const intradaySeries = withStubElectron(({ buildContentIntradayData }) =>
      buildContentIntradayData(
        { contentKey: "manual:intraday1", date: "2026-11-20", days: 3, now: tToday16 },
        {
          listAccounts: () => [{ group: "主组", platform: "抖音", meta: {} }],
          readDaily: () => ({ "2026-11-20": { fans: 100, plays: 10120 } }),
          readWorks: () => ({
            works: [
              { workId: "IW1", title: "作品1", publishTime: tYest },
              { workId: "IW2", title: "作品2", publishTime: tYest },
            ],
          }),
          readWorksDaily: () => ({
            IW1: { "2026-11-20": { play: 10000, like: 10 } },
            IW2: { "2026-11-20": { play: 120, like: 2 } },
          }),
          readWorksIntraday: () => ({
            IW1: [
              { date: "2026-11-20", slot: "10:00", collectedAt: tToday10, play: 10000 },
              { date: "2026-11-20", slot: "14:00", collectedAt: tToday14, play: null },
            ],
            IW2: [
              { date: "2026-11-20", slot: "10:00", collectedAt: tToday10, play: 100 },
              { date: "2026-11-20", slot: "14:00", collectedAt: tToday14, play: 120 },
            ],
          }),
          readPushRecords: () => [],
          readLinkOverrides: () => ({
            version: 1,
            updatedAt: tYest,
            contents: { "manual:intraday1": { title: "合并时段测试", createdAt: tYest } },
            excludedAuto: {},
            overrides: {
              "抖音|IW1": { action: "assign", contentKey: "manual:intraday1" },
              "抖音|IW2": { action: "assign", contentKey: "manual:intraday1" },
            },
          }),
        }
      )
    );
    assert.strictEqual(intradaySeries.found, true);
    const dyIntraday = intradaySeries.platforms.find((p) => p.platform === "抖音");
    assert.deepStrictEqual(dyIntraday.play, [10100, 10120], "4c: 缺失播放应沿用上一次有效值 10000");
    assert.deepStrictEqual(dyIntraday.playDelta, [null, 20], "4c: 合并内容时段增量应为 +20，不得出现 -9980");

    // 4d: 旧 daily.json（未写 playsAnomaly 标志）50000 -> 0 且无对应作品下降，导出「分析」与「账号日快照」口径完全一致
    const wb4d = withStubElectron(({ buildStatsWorkbookData }) =>
      buildStatsWorkbookData(
        { from: "2026-11-18", to: "2026-11-20", now: tToday16 },
        {
          listAccounts: () => [{ group: "老组", platform: "抖音", meta: {} }],
          readDaily: () => ({
            "2026-11-18": { fans: 100, plays: 50000 },
            "2026-11-19": { fans: 105, plays: 0 }, // 旧数据无 playsAnomaly 标志
            "2026-11-20": { fans: 110, plays: 52000 },
          }),
          readWorks: () => ({
            works: [{ workId: "OLD1", title: "旧作品", publishTime: Date.parse("2026-11-17T10:00:00+08:00") }],
          }),
          readWorksDaily: () => ({
            OLD1: {
              "2026-11-18": { play: 50000, like: 100 },
              "2026-11-19": { play: 50500, like: 105 },
              "2026-11-20": { play: 52000, like: 110 },
            },
          }),
          readWorksIntraday: () => ({}),
          readPushRecords: () => [],
          readLinkOverrides: () => ({ version: 1, updatedAt: 0, contents: {}, excludedAuto: {}, overrides: {} }),
        }
      )
    );
    assert.ok(
      wb4d.analysis.anomalies.collectionAnomalies.some((a) => a.scope === "account" && a.date === "2026-11-19"),
      "4d: 分析 sheet 应识别旧 daily.json 50000->0 异常"
    );
    const s4Legacy = wb4d.sheets["账号日快照"].slice(1);
    const legacy19 = s4Legacy.find((r) => r[0] === "2026-11-19");
    const legacy20 = s4Legacy.find((r) => r[0] === "2026-11-20");
    assert.strictEqual(legacy19[4], null, "4d: 旧快照异常日账号日快照总播放应置空");
    assert.strictEqual(legacy19[10], null, "4d: 旧快照异常日账号日快照播放日增应置空（不为 -50000）");
    assert.ok(legacy19[11] && legacy19[11].includes("50000→0"), `4d: 异常标注应写明 50000→0: ${legacy19[11]}`);
    assert.strictEqual(legacy20[10], 2000, "4d: 次日播放日增应跳过异常日按 52000-50000=2000 计算");

    console.log("✓ S10-fix #4 作品假 0 联动账号异常、同日比较、时段沿用有效值与旧快照导出口径一致验证通过");
  } finally {
    env.restore();
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  }
}

/* ---------- S10-fix #5：多账号隔离、一轮只计一次、适配器报错不吞、502 非登录、通知失败下轮重试 ---------- */
async function testS10Fix5_AlertIsolationAdapterErrorsLoginSignalAndNotifyRetry() {
  // 5a: 同组同平台两个账号隔离 + 一轮内同账号只计一次（真实跑 dataStats/index.js stats:collect IPC）
  {
    const tmpUserData = createTempUserData("mm-s10-fix5a-");
    let roundPlan = null;
    const env = loadWithMockElectron(tmpUserData, {
      collectAccountImpl: async ({ partition, platform }) => {
        const fn = roundPlan && roundPlan[partition];
        if (!fn) throw new Error(`unexpected partition: ${partition}`);
        return fn(platform);
      },
    });
    try {
      const { store, notifications, ipcHandlers } = env;
      const { registerDataStatsIpc } = require("../src/main/services/dataStats/index.js");
      registerDataStatsIpc();
      const collectHandler = ipcHandlers.get("stats:collect");
      assert.ok(typeof collectHandler === "function");

      const accA = { group: "同组", platform: "抖音", accountKey: "accA", partition: "persist:accA抖音" };
      const accB = { group: "同组", platform: "抖音", accountKey: "accB", partition: "persist:accB抖音" };

      // 两轮均为 A 登录失效、B 成功：期望 B 不清除 A，A 在第二轮告警并弹 1 次通知
      roundPlan = {
        "persist:accA抖音": async () => {
          const e = new Error("登录态已失效，请先在「媒体平台管理」重新登录");
          e.code = "NOT_LOGGED_IN";
          throw e;
        },
        "persist:accB抖音": async () => ({
          overview: { fans: 100, plays: 500 },
          fansHistory: [],
          works: [{ workId: "WB1", title: "正常视频", publishTime: Date.now() - 86400000, play: 500 }],
        }),
      };

      await collectHandler({}, { accounts: [accA, accB] });
      const stateA1 = store.getAccountCollectFailureState("同组", "抖音", accA);
      assert.strictEqual(stateA1 && stateA1.consecutiveFailures, 1, "5a: 第 1 轮 B 成功不得清掉 A 的失败计数");
      assert.strictEqual(stateA1.alerted, false);
      assert.strictEqual(store.getAccountCollectFailureState("同组", "抖音", accB), null);
      assert.strictEqual(notifications.length, 0);

      await collectHandler({}, { accounts: [accA, accB] });
      const stateA2 = store.getAccountCollectFailureState("同组", "抖音", accA);
      assert.strictEqual(stateA2 && stateA2.consecutiveFailures, 2, "5a: 第 2 轮 A 应累计 2 次并告警");
      assert.strictEqual(stateA2.alerted, true);
      assert.strictEqual(stateA2.isLoginError, true);
      assert.strictEqual(notifications.length, 1, "5a: 第 2 轮 A 应弹 1 次通知");

      // 反过来：同组同平台两个新账号 C、D 在同一轮各失败一次，期望两者各记 1 次、均不告警
      const accC = { group: "同组", platform: "快手", accountKey: "accC", partition: "persist:accC快手" };
      const accD = { group: "同组", platform: "快手", accountKey: "accD", partition: "persist:accD快手" };
      roundPlan = {
        "persist:accC快手": async () => {
          throw new Error("采集接口错误(HTTP 503): /rest/cp/creator/pc/home/userInfo");
        },
        "persist:accD快手": async () => {
          throw new Error("采集接口错误(HTTP 503): /rest/cp/creator/pc/home/userInfo");
        },
      };
      // 同时验证一轮内同账号（accC）重复传入两次也只计 1 次
      await collectHandler({}, { accounts: [accC, accD, accC] });
      const stateC = store.getAccountCollectFailureState("同组", "快手", accC);
      const stateD = store.getAccountCollectFailureState("同组", "快手", accD);
      assert.strictEqual(stateC && stateC.consecutiveFailures, 1, "5a: 同账号一轮内重复失败只计 1 次");
      assert.strictEqual(stateC.alerted, false, "5a: C 单轮不得提前告警");
      assert.strictEqual(stateD && stateD.consecutiveFailures, 1, "5a: D 独立计 1 次");
      assert.strictEqual(stateD.alerted, false, "5a: D 单轮不得提前告警");
      assert.strictEqual(notifications.length, 1, "5a: C/D 各失败 1 次不得弹出连续 2 次通知");
    } finally {
      env.restore();
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  }

  // 5b & 5c: 百家号 503 JSON 错误体不当空列表 + B 站 502 HTML 不误报登录失效
  {
    const tmpUserData = createTempUserData("mm-s10-fix5bc-");
    const env = loadWithMockElectron(tmpUserData);
    try {
      const { store, collectAlert, notifications } = env;
      const { handleAccountCollectOutcome } = collectAlert;
      const baseNow = Date.parse("2026-11-21T10:00:00+08:00");

      // 5b: 新百家号账号（历史上无作品）首页正常，作品列表连续两次 HTTP 503 + JSON 错误体
      const runBjhAdapter = async (listStatus, listBody) => {
        const sandbox = {
          fetch: async (url) => {
            if (url.includes("/pcui/home/index")) {
              return { status: 200, text: async () => JSON.stringify({ data: { coreData: { fansCount: 0, viewCount: 0 } } }) };
            }
            if (url.includes("/pcui/article/lists")) {
              return { status: listStatus, text: async () => listBody };
            }
            throw new Error(`unexpected url: ${url}`);
          },
          setTimeout: (fn) => setImmediate(fn),
          Date,
          JSON,
          Number,
          String,
          Array,
          Object,
          Error,
          Promise,
        };
        return vm.runInNewContext(ADAPTERS["百家号"].collectScript(), sandbox);
      };

      for (let round = 1; round <= 2; round++) {
        let caught = null;
        try {
          await runBjhAdapter(503, JSON.stringify({ errno: 503, errmsg: "service unavailable" }));
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, `5b: 第 ${round} 次百家号 HTTP 503 必须判失败，不能当空列表成功`);
        const out = handleAccountCollectOutcome({
          group: "新百家号",
          platform: "百家号",
          accountKey: "bjhNew",
          success: false,
          error: caught.message,
          errorObj: caught,
          now: baseNow + round * 60000,
        });
        assert.strictEqual(out.alert.isLoginError, false, "5b: 503 错误体不是登录失效");
        assert.strictEqual(out.alert.errorType, "api_error", "5b: 错误类型应为 api_error");
        assert.strictEqual(out.alert.errorTypeLabel, "接口错误");
        if (round === 2) {
          assert.strictEqual(out.alert.alerted, true, "5b: 第二次 503 应触发告警");
          assert.strictEqual(out.notified, true);
        }
      }
      // 同样验证 HTTP 200 返回 JSON 错误体或缺少 list 字段也必须失败
      let bjhErr200 = null;
      try {
        await runBjhAdapter(200, JSON.stringify({ errno: 500, errmsg: "internal error" }));
      } catch (e) {
        bjhErr200 = e;
      }
      assert.ok(bjhErr200 && bjhErr200.message.includes("采集接口错误"), "5b: HTTP 200 错误 JSON 必须判失败");

      // 5c: B 站接口连续两次返回 HTTP 502 HTML 页面，期望显示采集接口错误（不是「需重新登录」）
      const runBlblAdapter = async (status, body) => {
        const sandbox = {
          fetch: async () => ({ status, text: async () => body }),
          setTimeout: (fn) => setImmediate(fn),
          Date,
          JSON,
          Number,
          String,
          Array,
          Object,
          Error,
          Promise,
        };
        return vm.runInNewContext(ADAPTERS["哔哩哔哩"].collectScript(), sandbox);
      };

      const notifBefore5c = notifications.length;
      for (let round = 1; round <= 2; round++) {
        let caught = null;
        try {
          await runBlblAdapter(502, "<html><body><h1>502 Bad Gateway</h1></body></html>");
        } catch (err) {
          caught = err;
        }
        assert.ok(caught, "5c: B 站 502 HTML 必须抛错");
        const out = handleAccountCollectOutcome({
          group: "B站号",
          platform: "哔哩哔哩",
          accountKey: "blbl1",
          success: false,
          error: caught.message,
          errorObj: caught,
          now: baseNow + (round + 10) * 60000,
        });
        assert.strictEqual(out.alert.isLoginError, false, "5c: 502 网关错误绝不能误判为登录失效");
        assert.strictEqual(out.alert.errorType, "api_error");
        assert.strictEqual(out.alert.errorTypeLabel, "接口错误");
      }
      assert.strictEqual(notifications.length, notifBefore5c + 1);
      const blblNotif = notifications[notifications.length - 1];
      assert.ok(!blblNotif.title.includes("需重新登录"), `5c: 通知标题不得误报需重新登录: ${blblNotif.title}`);

      // 直接验证 classifyCollectError：Unexpected token / HTTP 200 非 JSON 不算登录失效；401/403/B站-101/跳登录页算登录失效
      assert.strictEqual(store.classifyCollectError("Unexpected token '<', \"<html>502\" is not valid JSON").isLoginError, false);
      assert.strictEqual(store.classifyCollectError("采集接口错误(非JSON响应, HTTP 200): /x/web/archives").isLoginError, false);
      assert.strictEqual(store.classifyCollectError("接口认证失效(HTTP 401): /x/web/data/index/stat").isLoginError, true);
      assert.strictEqual(store.classifyCollectError("接口认证失效(HTTP 403): /pcui/home/index").isLoginError, true);
      assert.strictEqual(store.classifyCollectError("index/stat: code=-101 账号未登录").isLoginError, true);
      const redirErr = new Error("redirect");
      redirErr.code = "NOT_LOGGED_IN";
      assert.strictEqual(store.classifyCollectError("redirect", redirErr).isLoginError, true);
    } finally {
      env.restore();
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  }

  // 5d: 第二次连续失败时 Electron show() 抛错，第三次恢复可用 -> 第三次成功弹出 1 次通知，第四次不再重复
  {
    const tmpUserData = createTempUserData("mm-s10-fix5d-");
    let showAttempt = 0;
    const env = loadWithMockElectron(tmpUserData, {
      showImpl: () => {
        showAttempt += 1;
        if (showAttempt === 1) {
          throw new Error("Electron Notification show failed");
        }
      },
    });
    try {
      const { store, collectAlert, notifications } = env;
      const { handleAccountCollectOutcome } = collectAlert;
      const t = Date.parse("2026-11-21T11:00:00+08:00");

      const r1 = handleAccountCollectOutcome({
        group: "通知组",
        platform: "抖音",
        accountKey: "notifyAcc",
        success: false,
        error: "采集接口错误(HTTP 503): /janus/douyin",
        now: t,
      });
      assert.strictEqual(r1.notified, false);
      assert.strictEqual(notifications.length, 0);

      // 第 2 次：show() 抛错 -> 不得置 notified=true
      const r2 = handleAccountCollectOutcome({
        group: "通知组",
        platform: "抖音",
        accountKey: "notifyAcc",
        success: false,
        error: "采集接口错误(HTTP 503): /janus/douyin",
        now: t + 60000,
      });
      assert.strictEqual(r2.alert.alerted, true);
      assert.strictEqual(r2.notified, false, "5d: show() 抛错时 notified 必须为 false");
      assert.strictEqual(
        store.getAccountCollectAlert("通知组", "抖音", { accountKey: "notifyAcc" }).notified,
        false,
        "5d: 落盘状态 notified 必须保持 false 以便下轮重试"
      );
      assert.strictEqual(notifications.length, 0);

      // 第 3 次：show() 恢复可用 -> 补发成功 1 次通知并置 notified=true
      const r3 = handleAccountCollectOutcome({
        group: "通知组",
        platform: "抖音",
        accountKey: "notifyAcc",
        success: false,
        error: "采集接口错误(HTTP 503): /janus/douyin",
        now: t + 120000,
      });
      assert.strictEqual(r3.notified, true, "5d: 第三次应补发成功");
      assert.strictEqual(notifications.length, 1, "5d: 最终应成功弹出 1 次通知");
      assert.strictEqual(
        store.getAccountCollectAlert("通知组", "抖音", { accountKey: "notifyAcc" }).notified,
        true
      );

      // 第 4 次：已成功通知过，不再重复弹
      const r4 = handleAccountCollectOutcome({
        group: "通知组",
        platform: "抖音",
        accountKey: "notifyAcc",
        success: false,
        error: "采集接口错误(HTTP 503): /janus/douyin",
        now: t + 180000,
      });
      assert.strictEqual(r4.notified, false);
      assert.strictEqual(notifications.length, 1);
    } finally {
      env.restore();
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  }

  console.log("✓ S10-fix #5 多账号隔离、一轮计一次、适配器报错/502 分类与通知失败重试验证通过");
}

async function main() {
  testS10Item2_WeightedEngagementAndFavorite();
  testS10Fix2_WeightedDenominatorAndZeroPlayExclusion();
  testS10Item3_OverviewCoverageAndFansSource();
  testS10Item4_FalseZeroGuard();
  testS10Fix4_AccountAnomalyLinkageSameDayIntradayAndLegacyExport();
  await testS10Item5_CollectFailureAlerts();
  await testS10Fix5_AlertIsolationAdapterErrorsLoginSignalAndNotifyRetry();
  console.log("\ntest-stats-quality: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
