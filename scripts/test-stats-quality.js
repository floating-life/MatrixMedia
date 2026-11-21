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
const Module = require("module");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");

const { buildStatsAnalysis } = require("../src/main/services/dataStats/statsAnalysis.js");
const { buildWorkDailyRows, buildWorkIntradayRows } = require("../src/main/services/dataStats/statsTable.js");
const { buildPlatformComparisonOption } = require("../src/renderer/utils/statsChartOptions.js");

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

function loadWithMockElectron(tmpUserData, { onNotify } = {}) {
  const notifications = [];
  class MockNotification {
    constructor(opts) {
      this.opts = opts;
    }
    show() {
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
  const cleared = [
    path.resolve(root, "src/main/services/dataStats/store.js"),
    path.resolve(root, "src/main/services/dataStats/collectAlert.js"),
    path.resolve(root, "src/main/services/dataStats/index.js"),
    path.resolve(root, "src/main/services/dataStats/collector.js"),
  ];
  for (const f of cleared) delete require.cache[f];

  const xlsxMod = require("xlsx");
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return mockElectron;
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

async function main() {
  testS10Item2_WeightedEngagementAndFavorite();
  testS10Item3_OverviewCoverageAndFansSource();
  testS10Item4_FalseZeroGuard();
  await testS10Item5_CollectFailureAlerts();
  console.log("\ntest-stats-quality: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
