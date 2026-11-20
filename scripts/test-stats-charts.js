/**
 * S8 数据可视化单元测试（不依赖真实 Electron 窗口）：
 *
 * 1. PLATFORM_COLORS / getPlatformColor 全页 7 平台配色固定与一致性
 * 2. statsChartOptions.js 全部 9 个 option 构造函数：
 *    - series 数量 / 类型、平台色一致、空数据返回 { __empty: true } 占位标记
 *    - 总览折线：6 指标切换、堆叠面积切换、采集异常空心灰点与上推荐红标 markPoint、缺天补空连续 x 轴与 connectNulls:false
 *    - 平台对比：平均播放柱 + 互动率折线副轴
 *    - 作品排行：Top10 按平台堆叠横向条形图（播放 / 互动率 / 涨粉）
 *    - 新作品走势：D1/D3/D7 最多 10 条按 D7 排序 + 分类占比小饼图
 *    - 发布时间：星期 × 时段热力图、tooltip 样本数、样本 <3 半透明
 *    - 粉丝趋势：账号筛选、缺天补空、同平台色一致
 *    - 作品汇总趋势弹窗：各平台累计播放折线 + 播放日增柱、连续日期
 * 3. 折线数据点 > 2000 自动启用 sampling: "lttb"
 * 4. 性能验收：2000 内容 × 90 天分析 + 全部「数据分析」图表 option 组装 < 1.5s
 * 5. IPC 校验：
 *    - stats:save-chart-image（非 PNG、假 PNG 头、>10MB、非本地页面 → 拒绝；正常保存写盘与取消）
 *    - stats:save-chart-images-batch（单次目录对话框批量保存全部图表 PNG）
 *    - stats:get-content-trend（与 stats:get-content-summary 同一套关联结果、手工合并/拆出与默认截止日）
 * 6. StatsChart.vue 与 dataStats/index.vue 模板/脚本编译与组件生命周期（el-tabs 初始 0 宽延迟 init / resize / dispose / getDataURL）
 *
 * 运行：yarn test:stats-charts
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

const { buildStatsAnalysis } = require("../src/main/services/dataStats/statsAnalysis.js");
const {
  buildContentSummaryData,
  buildContentTrendData,
} = require("../src/main/services/dataStats/statsExport.js");
const statsChartOptions = require("../src/renderer/utils/statsChartOptions.js");
const {
  PLATFORM_COLORS,
  PLATFORM_ORDER,
  LTTB_POINT_THRESHOLD,
  getPlatformColor,
  buildContinuousDates,
  isEmptyChartOption,
  buildOverviewTrendOption,
  buildOverviewPieOption,
  buildPlatformComparisonOption,
  buildRankingTop10Option,
  buildNewWorksTrajectoryOption,
  buildNewWorksCategoryPieOption,
  buildNewWorksFirst24hOption,
  buildPublishTimeHeatmapOption,
  buildFansTrendOption,
  buildContentTrendOption,
  buildContentIntradayOption,
} = statsChartOptions;

const DAY_MS = 86400000;

// 合法 1×1 透明 PNG 文件（8 字节 PNG 魔数 + IHDR + IDAT + IEND）
const VALID_1X1_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_1X1_PNG_B64}`;

function shiftDate(ymd, deltaDays) {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function utc8Iso(ymd, hour = 10, minute = 0) {
  const baseMs = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(baseMs + (hour - 8) * 3600e3 + minute * 60e3).toISOString();
}

function buildSampleAnalysis() {
  const dailyRows = [];
  const summaryRows = [];
  const accountRows = [];
  const to = "2026-11-20";
  const platforms = ["抖音", "快手", "视频号"];

  // 构造 12 条跨平台内容，覆盖掉 0 采集异常、上推荐爆发、缺天断档、D1/D3/D7 走势、不同发布时段
  for (let i = 1; i <= 12; i++) {
    const ck = `file:/v/c${i}.mp4`;
    const pubDate = i <= 4 ? "2026-11-05" : i <= 8 ? "2026-11-10" : "2026-11-12";
    const hour = i <= 4 ? 20 : i <= 8 ? 9 : 14;
    const pubIso = utc8Iso(pubDate, hour);
    const perPlatform = {};
    let totalPlay = 0;
    let totalLike = 0;
    let totalComment = 0;
    let totalShare = 0;
    let totalFavorite = 0;
    let totalFansDelta = 0;

    for (const pt of platforms) {
      const workId = `W_${i}_${pt}`;
      let play = 500 + i * 100;
      let like = 30 + i * 5;
      let comment = 5 + i;
      let share = pt === "快手" ? null : 4 + i;
      let favorite = pt === "快手" ? null : 8 + i;
      let fansDelta = pt === "快手" ? null : 2 + i;

      let d = pubDate;
      let step = 0;
      while (d <= to) {
        // 故意在 2026-11-15 留缺天断档（测试 x 轴连续补空）
        if (d !== "2026-11-15") {
          if (step > 0) {
            const isSpike = i === 1 && pt === "抖音" && d === "2026-11-18";
            play += isSpike ? 2500 : pt === "抖音" ? 100 : pt === "视频号" ? 60 : 40;
            like += 5;
            comment += 1;
            if (share !== null) share += 1;
            if (favorite !== null) favorite += 1;
            if (fansDelta !== null) fansDelta += 1;
          }
          const isDropZero = i === 2 && pt === "抖音" && d === "2026-11-17";
          dailyRows.push({
            date: d,
            group: "主组",
            platform: pt,
            workId,
            title: `示例内容${String(i).padStart(2, "0")}`,
            publishTime: pubIso,
            contentKey: ck,
            play: isDropZero ? 0 : play,
            like,
            comment,
            share,
            favorite,
            fansDelta,
          });
        }
        d = shiftDate(d, 1);
        step += 1;
      }

      perPlatform[`${pt}|主组`] = {
        play,
        like,
        comment,
        share,
        favorite,
        fansDelta,
        workIds: [workId],
      };
      totalPlay += play;
      totalLike += like;
      totalComment += comment;
      if (share !== null) totalShare += share;
      if (favorite !== null) totalFavorite += favorite;
      if (fansDelta !== null) totalFansDelta += fansDelta;
    }

    summaryRows.push({
      contentKey: ck,
      title: `示例内容${String(i).padStart(2, "0")}`,
      firstPublishDate: pubDate,
      firstPublishTime: Date.parse(pubIso),
      platformCount: platforms.length,
      perPlatform,
      totalPlay,
      totalLike,
      totalComment,
      totalShare,
      totalFavorite,
      totalFansDelta,
    });
  }

  // 账号日快照（3 个账号，2026-11-15 同样缺天）
  let ad = "2026-11-05";
  let idx = 0;
  while (ad <= to) {
    if (ad !== "2026-11-15") {
      accountRows.push(
        { date: ad, platform: "抖音", group: "主组", fans: 1000 + idx * 15, fansDelta: idx === 0 ? null : 15 },
        { date: ad, platform: "抖音", group: "副组", fans: 400 + idx * 5, fansDelta: idx === 0 ? null : 5 },
        { date: ad, platform: "视频号", group: "主组", fans: 800 + idx * 10, fansDelta: idx === 0 ? null : 10 }
      );
    }
    ad = shiftDate(ad, 1);
    idx += 1;
  }

  return buildStatsAnalysis({
    dailyRows,
    summaryRows,
    accountRows,
    to,
    period: 16,
    now: Date.parse("2026-11-20T12:00:00+08:00"),
  });
}

async function main() {
  /* ---------- 1. 固定平台配色校验 ---------- */
  {
    const sevenPlatforms = ["抖音", "快手", "视频号", "小红书", "哔哩哔哩", "头条", "百家号"];
    const colors = sevenPlatforms.map((p) => getPlatformColor(p));
    assert.strictEqual(new Set(colors).size, 7, "7 个平台必须各自拥有互不相同的固定颜色");
    for (const c of colors) {
      assert.match(c, /^#[0-9a-f]{6}$/i, `颜色应为 6 位十六进制：${c}`);
    }
    assert.strictEqual(getPlatformColor("B站"), getPlatformColor("哔哩哔哩"), "B站别名应与哔哩哔哩同色");
    assert.strictEqual(PLATFORM_COLORS["抖音"], getPlatformColor("抖音"));
    assert.strictEqual(getPlatformColor("未知平台X"), getPlatformColor("未知平台X"), "未知平台兜底色应确定性一致");
    console.log("✓ 7 平台固定配色常量校验通过");
  }

  /* ---------- 2. 全部 9 个 option 构造函数测试 ---------- */
  const analysis = buildSampleAnalysis();

  // 2.1 总览日趋势折线（指标切换 + 堆叠面积 + 异常点标注 + 缺天连续日期）
  {
    const optPlay = buildOverviewTrendOption(analysis, { metric: "play", stacked: false });
    assert.strictEqual(isEmptyChartOption(optPlay), false);
    assert.strictEqual(optPlay.series.length, 3, "3 个平台应生成 3 条折线 series");
    assert.strictEqual(optPlay.xAxis.data.length, 16, "11-05 ~ 11-20 应为连续 16 天");
    const gapIdx = optPlay.xAxis.data.indexOf("2026-11-15");
    assert.ok(gapIdx > 0, "缺天 2026-11-15 必须保留在连续 x 轴中");

    for (const s of optPlay.series) {
      assert.strictEqual(s.type, "line");
      assert.strictEqual(s.connectNulls, false, "缺天必须断开不连线（connectNulls:false）");
      assert.strictEqual(s.data[gapIdx], null, "缺天位置必须补 null");
      assert.strictEqual(s.itemStyle.color, getPlatformColor(s.name), `${s.name} 折线颜色必须与平台色表一致`);
      assert.strictEqual(s.lineStyle.color, getPlatformColor(s.name));
      assert.strictEqual(s.stack, undefined);
      assert.strictEqual(s.areaStyle, undefined);
    }

    // 异常点标注：抖音在 11-17 有采集异常（空心灰点）、在 11-18 有疑似上推荐（红标 markPoint）
    const dySeries = optPlay.series.find((s) => s.name === "抖音");
    assert.ok(dySeries && dySeries.markPoint && Array.isArray(dySeries.markPoint.data));
    const colMp = dySeries.markPoint.data.find((m) => m.anomalyType === "collection");
    const recMp = dySeries.markPoint.data.find((m) => m.anomalyType === "recommend");
    assert.ok(colMp, "应包含疑似采集异常 markPoint");
    assert.strictEqual(colMp.coord[0], "2026-11-17");
    assert.strictEqual(colMp.symbol, "emptyCircle", "疑似采集异常必须用空心圆点");
    assert.strictEqual(colMp.itemStyle.color, "#909399", "疑似采集异常应为灰色");
    assert.ok(recMp, "应包含疑似上推荐 markPoint");
    assert.strictEqual(recMp.coord[0], "2026-11-18");
    assert.strictEqual(recMp.itemStyle.color, "#f56c6c", "疑似上推荐应为红色标注");

    // 切换指标到点赞：不再显示 play 的上推荐 markPoint 与 play 的采集异常
    const optLike = buildOverviewTrendOption(analysis, { metric: "like", stacked: false });
    assert.strictEqual(isEmptyChartOption(optLike), false);
    assert.strictEqual(optLike.yAxis.name, "点赞日增");
    const dyLike = optLike.series.find((s) => s.name === "抖音");
    assert.strictEqual(Boolean(dyLike.markPoint), false, "非播放指标不应挂载播放上推荐或播放采集异常点");

    // 切换堆叠面积模式
    const optStacked = buildOverviewTrendOption(analysis, { metric: "play", stacked: true });
    for (const s of optStacked.series) {
      assert.strictEqual(s.stack, "total");
      assert.ok(s.areaStyle && s.areaStyle.opacity > 0, "堆叠面积模式必须包含 areaStyle");
    }

    // 稀疏输入直接调用 buildOverviewTrendOption 也能补齐连续日期
    const sparseOpt = buildOverviewTrendOption({
      overview: {
        dailyTrend: {
          dates: ["2026-11-01", "2026-11-04"],
          platforms: [{ platform: "抖音", play: [100, 300] }],
        },
      },
    });
    assert.deepStrictEqual(sparseOpt.xAxis.data, ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    assert.deepStrictEqual(sparseOpt.series[0].data, [100, null, null, 300]);
    assert.strictEqual(sparseOpt.series[0].connectNulls, false);

    // 空数据返回占位标记
    const emptyTrend = buildOverviewTrendOption(null);
    assert.strictEqual(emptyTrend.__empty, true);
    assert.strictEqual(isEmptyChartOption(emptyTrend), true);
    console.log("✓ 总览日趋势折线（指标/堆叠/异常标注/连续日期/空占位）校验通过");
  }

  // 2.2 总览平台占比环形图
  {
    const pieOpt = buildOverviewPieOption(analysis);
    assert.strictEqual(isEmptyChartOption(pieOpt), false);
    assert.strictEqual(pieOpt.series.length, 1);
    assert.strictEqual(pieOpt.series[0].type, "pie");
    assert.ok(Array.isArray(pieOpt.series[0].radius) && pieOpt.series[0].radius.length === 2, "应为环形图");
    for (const d of pieOpt.series[0].data) {
      assert.strictEqual(d.itemStyle.color, getPlatformColor(d.name), `环形图 ${d.name} 颜色必须一致`);
    }
    assert.strictEqual(buildOverviewPieOption({ overview: { platformContribution: [] } }).__empty, true);
    console.log("✓ 总览平台占比环形图校验通过");
  }

  // 2.3 平台对比（平均播放柱 + 互动率折线副轴）
  {
    const cmpOpt = buildPlatformComparisonOption(analysis);
    assert.strictEqual(isEmptyChartOption(cmpOpt), false);
    assert.strictEqual(cmpOpt.series.length, 2);
    assert.strictEqual(cmpOpt.series[0].type, "bar");
    assert.strictEqual(cmpOpt.series[0].yAxisIndex, 0);
    assert.strictEqual(cmpOpt.series[1].type, "line");
    assert.strictEqual(cmpOpt.series[1].yAxisIndex, 1);
    assert.strictEqual(cmpOpt.series[1].connectNulls, false);
    assert.strictEqual(cmpOpt.yAxis.length, 2, "必须具备左右双 Y 轴");
    for (const barDatum of cmpOpt.series[0].data) {
      assert.strictEqual(barDatum.itemStyle.color, getPlatformColor(barDatum.platform));
    }
    assert.strictEqual(buildPlatformComparisonOption({ platformComparison: { platforms: [] } }).__empty, true);
    console.log("✓ 平台对比分组柱+折线副轴图校验通过");
  }

  // 2.4 作品排行 Top10 横向堆叠条形图（播放 / 互动率 / 涨粉）
  {
    for (const metric of ["play", "engagement", "fans"]) {
      const rkOpt = buildRankingTop10Option(analysis, { metric });
      assert.strictEqual(isEmptyChartOption(rkOpt), false, `排行指标 ${metric} 不应为空`);
      assert.strictEqual(rkOpt.yAxis.type, "category");
      assert.strictEqual(rkOpt.yAxis.inverse, true, "第 1 名应在顶部");
      assert.strictEqual(rkOpt.xAxis.type, "value");
      assert.strictEqual(rkOpt.yAxis.data.length, 10, "Top10 应严格展示 10 条");
      assert.strictEqual(rkOpt.series.length, 3, "应按 3 个平台堆叠");
      for (const s of rkOpt.series) {
        assert.strictEqual(s.type, "bar");
        assert.strictEqual(s.stack, "total", "Top10 必须按平台堆叠");
        assert.strictEqual(s.itemStyle.color, getPlatformColor(s.name), `Top10 平台 ${s.name} 颜色必须一致`);
      }
    }
    assert.strictEqual(buildRankingTop10Option(null, { metric: "play" }).__empty, true);
    console.log("✓ 作品排行 Top10 按平台堆叠横向条形图（3 指标）校验通过");
  }

  // 2.5 新作品走势（D1/D3/D7 最多 10 条按 D7 降序 + 分类占比小饼图）
  {
    const nwLineOpt = buildNewWorksTrajectoryOption(analysis);
    assert.strictEqual(isEmptyChartOption(nwLineOpt), false);
    assert.deepStrictEqual(nwLineOpt.xAxis.data, ["D1", "D3", "D7"]);
    assert.strictEqual(nwLineOpt.series.length, 10, "12 条新作品应最多截取 10 条");
    assert.strictEqual(nwLineOpt.legend.selectedMode, true, "图例必须可点选");
    // 校验按 D7 降序排列
    for (let i = 1; i < nwLineOpt.series.length; i++) {
      assert.strictEqual(nwLineOpt.series[i].type, "line");
      assert.strictEqual(nwLineOpt.series[i].connectNulls, false);
      const prevD7 = nwLineOpt.series[i - 1].data[2];
      const curD7 = nwLineOpt.series[i].data[2];
      if (prevD7 !== null && curD7 !== null) {
        assert.ok(prevD7 >= curD7, "新作品走势折线必须按 D7 降序排列");
      }
    }
    assert.strictEqual(buildNewWorksTrajectoryOption({ newWorks: { items: [] } }).__empty, true);

    const nwPieOpt = buildNewWorksCategoryPieOption(analysis);
    assert.strictEqual(isEmptyChartOption(nwPieOpt), false);
    assert.strictEqual(nwPieOpt.series.length, 1);
    assert.strictEqual(nwPieOpt.series[0].type, "pie");
    assert.ok(nwPieOpt.series[0].data.every((d) => d.value > 0));
    assert.strictEqual(
      buildNewWorksCategoryPieOption({ newWorks: { categoryCounts: { 长尾型: 0, 爆发后平稳: 0, 其它: 0, 数据不足: 0 } } }).__empty,
      true
    );
    console.log("✓ 新作品 D1/D3/D7 走势折线与分类占比饼图校验通过");
  }

  // 2.6 发布时间热力图（样本 <3 半透明 + tooltip 显示样本数）
  {
    // 构造精确含样本 >=3 与样本 <3 的热力图输入
    const hmOpt = buildPublishTimeHeatmapOption({
      publishTime: {
        totalSamples: 5,
        groups: [
          { weekday: 2, weekdayLabel: "周二", slot: "18-24", sampleCount: 3, avgD7Play: 3000, lowSample: false, hasFallback: false, fallbackCount: 0, note: "" },
          { weekday: 5, weekdayLabel: "周五", slot: "6-12", sampleCount: 2, avgD7Play: 1800, lowSample: true, hasFallback: true, fallbackCount: 1, note: "样本少" },
        ],
      },
    });
    assert.strictEqual(isEmptyChartOption(hmOpt), false);
    assert.strictEqual(hmOpt.series.length, 1);
    assert.strictEqual(hmOpt.series[0].type, "heatmap");
    assert.strictEqual(hmOpt.xAxis.data.length, 7);
    assert.strictEqual(hmOpt.yAxis.data.length, 4);
    const sufficientCell = hmOpt.series[0].data.find((d) => d.sampleCount === 3);
    const lowCell = hmOpt.series[0].data.find((d) => d.sampleCount === 2);
    assert.strictEqual(sufficientCell.itemStyle.opacity, 1, "样本 >=3 应不透明");
    assert.ok(lowCell.itemStyle.opacity > 0 && lowCell.itemStyle.opacity < 1, "样本 <3 必须半透明");
    const tipHtml = hmOpt.tooltip.formatter({ data: lowCell });
    assert.ok(tipHtml.includes("样本数") && tipHtml.includes("2"), "tooltip 必须显示样本数");
    assert.strictEqual(buildPublishTimeHeatmapOption({ publishTime: { groups: [] } }).__empty, true);
    console.log("✓ 发布时间热力图（样本<3 半透明与 tooltip 样本数）校验通过");
  }

  // 2.7 粉丝趋势（多账号、可选账号筛选、平台色一致、缺天断连）
  {
    const fansAll = buildFansTrendOption(analysis);
    assert.strictEqual(isEmptyChartOption(fansAll), false);
    assert.strictEqual(fansAll.series.length, 3, "应展示全部 3 个账号");
    const gapIdx = fansAll.xAxis.data.indexOf("2026-11-15");
    assert.ok(gapIdx > 0);
    for (const s of fansAll.series) {
      assert.strictEqual(s.type, "line");
      assert.strictEqual(s.connectNulls, false);
      assert.strictEqual(s.data[gapIdx], null, "粉丝趋势缺天必须补 null");
      assert.strictEqual(s.itemStyle.color, getPlatformColor(s.platform), "账号折线必须使用所属平台固定色");
    }
    const dyFansSeries = fansAll.series.filter((s) => s.platform === "抖音");
    assert.strictEqual(dyFansSeries.length, 2);
    assert.notStrictEqual(dyFansSeries[0].lineStyle.type, dyFansSeries[1].lineStyle.type, "同平台多账号线型应有区分");

    const fansFiltered = buildFansTrendOption(analysis, { selectedAccounts: ["视频号|主组"] });
    assert.strictEqual(fansFiltered.series.length, 1);
    assert.strictEqual(fansFiltered.series[0].platform, "视频号");
    assert.strictEqual(fansFiltered.series[0].itemStyle.color, getPlatformColor("视频号"));

    assert.strictEqual(buildFansTrendOption({ fansTrend: { dates: [], accounts: [] } }).__empty, true);
    console.log("✓ 粉丝趋势折线（账号筛选/平台色/缺天补空）校验通过");
  }

  // 2.8 作品汇总单内容趋势图（累计播放折线 + 播放日增柱 + 连续日期 + 平台色一致）
  {
    const ctOpt = buildContentTrendOption({
      dates: ["2026-11-01", "2026-11-03"],
      platforms: [
        { platform: "抖音", play: [100, 260], playDelta: [null, 160] },
        { platform: "快手", play: [50, 90], playDelta: [null, 40] },
      ],
      totalPlayDelta: [null, 200],
    });
    assert.strictEqual(isEmptyChartOption(ctOpt), false);
    assert.deepStrictEqual(ctOpt.xAxis.data, ["2026-11-01", "2026-11-02", "2026-11-03"]);
    assert.strictEqual(ctOpt.series.length, 3, "2 个平台折线 + 1 个播放日增柱");
    const lines = ctOpt.series.filter((s) => s.type === "line");
    const bars = ctOpt.series.filter((s) => s.type === "bar");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(bars.length, 1);
    assert.strictEqual(bars[0].yAxisIndex, 1);
    assert.deepStrictEqual(bars[0].data, [null, null, 200]);
    for (const ln of lines) {
      assert.strictEqual(ln.yAxisIndex, 0);
      assert.strictEqual(ln.connectNulls, false);
      assert.strictEqual(ln.data[1], null, "缺天 11-02 必须补 null");
      assert.strictEqual(ln.itemStyle.color, getPlatformColor(ln.name));
    }
    assert.strictEqual(buildContentTrendOption(null).__empty, true);
    assert.strictEqual(buildContentTrendOption({ dates: [], platforms: [] }).__empty, true);
    console.log("✓ 作品汇总单内容趋势图（折线+日增柱/连续日期/平台色）校验通过");
  }

  /* ---------- 3. 折线数据点 > 2000 启用 sampling: 'lttb' ---------- */
  {
    assert.strictEqual(LTTB_POINT_THRESHOLD, 2000);
    const bigDates = buildContinuousDates(["2021-01-01", "2026-10-01"]);
    assert.ok(bigDates.length > 2000, `应超过 2000 天，实际 ${bigDates.length}`);
    const bigVals = bigDates.map((_, idx) => idx * 10);

    const bigOverview = buildOverviewTrendOption({
      overview: {
        dailyTrend: {
          dates: bigDates,
          platforms: [{ platform: "抖音", play: bigVals }],
        },
      },
    });
    assert.strictEqual(bigOverview.series[0].sampling, "lttb", "总览折线 >2000 点必须启用 sampling:'lttb'");

    const smallOverview = buildOverviewTrendOption({
      overview: {
        dailyTrend: {
          dates: bigDates.slice(0, 30),
          platforms: [{ platform: "抖音", play: bigVals.slice(0, 30) }],
        },
      },
    });
    assert.strictEqual(smallOverview.series[0].sampling, undefined, "小数据量不应强制开启 sampling");

    const bigFans = buildFansTrendOption({
      fansTrend: {
        dates: bigDates,
        accounts: [{ accountKey: "抖音|主组", platform: "抖音", group: "主组", label: "抖音·主组", fans: bigVals }],
      },
    });
    assert.strictEqual(bigFans.series[0].sampling, "lttb", "粉丝趋势 >2000 点必须启用 sampling:'lttb'");

    const bigContent = buildContentTrendOption({
      dates: bigDates,
      platforms: [{ platform: "抖音", play: bigVals, playDelta: bigVals }],
      totalPlayDelta: bigVals,
    });
    assert.strictEqual(bigContent.series[0].sampling, "lttb", "内容趋势折线 >2000 点必须启用 sampling:'lttb'");
    console.log("✓ 折线 >2000 点自动启用 sampling:'lttb' 校验通过");
  }

  /* ---------- 4. 性能验收：2000 内容 × 90 天 数据分析 + 全部图表 option 组装 < 1.5s ---------- */
  {
    const accounts = ["抖音", "快手", "视频号"].flatMap((platform) =>
      ["创作组A", "创作组B", "创作组C"].map((group) => ({ group, platform }))
    );
    const dates = Array.from({ length: 90 }, (_, i) => shiftDate("2026-08-23", i));
    const to = dates[dates.length - 1];
    const perfDailyRows = [];
    const perfSummaryRows = [];
    const perfAccountRows = [];
    const pubMs = Date.parse("2026-08-22T13:00:00+08:00");

    for (let i = 0; i < 2000; i++) {
      const { group, platform } = accounts[i % accounts.length];
      const workId = String(80000000 + i);
      const title = `性能测试视频第${i + 1}集`;
      const contentKey = `file:/perf/v-${i}.mp4`;
      for (let j = 0; j < dates.length; j++) {
        perfDailyRows.push({
          group,
          platform,
          workId,
          title,
          publishTime: pubMs,
          date: dates[j],
          play: 500 + i + j * 12,
          like: 40 + j * 2,
          comment: 10 + j,
          share: 5 + j,
          favorite: 8 + j,
          fansDelta: j,
          contentKey,
        });
      }
      const lastPlay = 500 + i + 89 * 12;
      perfSummaryRows.push({
        contentKey,
        title,
        firstPublishDate: "2026-08-22",
        firstPublishTime: pubMs,
        totalPlay: lastPlay,
        totalLike: 40 + 89 * 2,
        totalComment: 10 + 89,
        totalShare: 5 + 89,
        totalFavorite: 8 + 89,
        totalFansDelta: 89,
        perPlatform: {
          [`${platform}|${group}`]: {
            play: lastPlay,
            like: 40 + 89 * 2,
            comment: 10 + 89,
            share: 5 + 89,
            favorite: 8 + 89,
            fansDelta: 89,
            workIds: [workId],
          },
        },
      });
    }
    for (const acc of accounts) {
      for (let j = 0; j < dates.length; j++) {
        perfAccountRows.push({
          date: dates[j],
          platform: acc.platform,
          group: acc.group,
          fans: 1000 + j * 10,
          fansDelta: j === 0 ? null : 10,
        });
      }
    }

    const t0 = performance.now();
    const bigAnalysis = buildStatsAnalysis({
      dailyRows: perfDailyRows,
      summaryRows: perfSummaryRows,
      accountRows: perfAccountRows,
      to,
      period: 90,
      now: Date.parse("2026-11-20T12:00:00+08:00"),
    });
    const tAnalysis = performance.now();
    const allChartOptions = [
      buildOverviewTrendOption(bigAnalysis, { metric: "play", stacked: false }),
      buildOverviewPieOption(bigAnalysis),
      buildPlatformComparisonOption(bigAnalysis),
      buildRankingTop10Option(bigAnalysis, { metric: "play" }),
      buildNewWorksTrajectoryOption(bigAnalysis),
      buildNewWorksCategoryPieOption(bigAnalysis),
      buildPublishTimeHeatmapOption(bigAnalysis),
      buildFansTrendOption(bigAnalysis),
    ];
    const tEnd = performance.now();
    const analysisMs = Math.round(tAnalysis - t0);
    const optionsMs = Math.round(tEnd - tAnalysis);
    const totalMs = Math.round(tEnd - t0);

    assert.strictEqual(allChartOptions.length, 8);
    assert.strictEqual(isEmptyChartOption(allChartOptions[0]), false);
    assert.strictEqual(isEmptyChartOption(allChartOptions[3]), false);
    assert.strictEqual(isEmptyChartOption(allChartOptions[7]), false);
    console.log(
      `✓ 性能验收（2000 内容 × 90 天）：analysis=${analysisMs}ms, 8 图表 options=${optionsMs}ms, 合计=${totalMs}ms（要求 < 1500ms）`
    );
    assert.ok(totalMs < 1500, `2000×90 全部图表数据组装耗时过长：${totalMs}ms >= 1500ms`);
  }

  /* ---------- 5. IPC 校验：stats:save-chart-image / batch / stats:get-content-trend ---------- */
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-charts-ipc-"));
    const docsDir = path.join(tmpRoot, "Documents");
    fs.mkdirSync(docsDir, { recursive: true });
    const ipcHandlers = new Map();
    const electronId = require.resolve("electron");
    const origElectronCache = require.cache[electronId];
    const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
    const origCollectorCache = require.cache[collectorId];
    const storeId = require.resolve("../src/main/services/dataStats/store.js");
    const indexId = require.resolve("../src/main/services/dataStats/index.js");

    let saveDialogCalls = [];
    let nextSaveDialogResult = { canceled: false, filePath: path.join(docsDir, "saved-chart.png") };
    let openDialogCalls = [];
    let nextOpenDialogResult = { canceled: false, filePaths: [path.join(tmpRoot, "batch-out")] };

    try {
      const mockWin = { id: 1 };
      require.cache[electronId] = {
        id: electronId,
        filename: electronId,
        loaded: true,
        exports: {
          app: {
            getPath: (name) => (name === "documents" ? docsDir : tmpRoot),
            getVersion: () => "0.14.9-fork.test",
          },
          BrowserWindow: {
            fromWebContents: (sender) => (sender ? mockWin : null),
          },
          dialog: {
            showSaveDialog: async (_win, opts) => {
              saveDialogCalls.push(opts);
              return nextSaveDialogResult;
            },
            showOpenDialog: async (_win, opts) => {
              openDialogCalls.push(opts);
              return nextOpenDialogResult;
            },
          },
          ipcMain: {
            handle: (ch, fn) => ipcHandlers.set(ch, fn),
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

      const { registerDataStatsIpc } = require(indexId);

      // 构造含手工合并（manual:m1）、自动直链、未关联、以及未来快照（测 cutoff）的数据
      const pubMs = Date.parse("2026-11-10T10:00:00+08:00");
      const trendDeps = {
        now: Date.parse("2026-11-20T12:00:00+08:00"),
        listAccounts: () => [
          { group: "主组", platform: "抖音" },
          { group: "主组", platform: "快手" },
          { group: "副组", platform: "抖音" },
        ],
        readWorks: (g, p) => {
          if (g === "主组" && p === "抖音") {
            return [
              { workId: "DY_LINK", title: "直链视频", url: "https://www.douyin.com/video/101", publishTime: pubMs },
              { workId: "DY_MAN", title: "手工合并视频A", publishTime: pubMs },
              { workId: "DY_UNL", title: "独立未关联视频", publishTime: pubMs },
            ];
          }
          if (g === "主组" && p === "快手") {
            return [
              { workId: "KS_LINK", title: "直链视频", url: "https://www.kuaishou.com/short-video/202", publishTime: pubMs },
              { workId: "KS_MAN", title: "手工合并视频B", publishTime: pubMs },
            ];
          }
          // 副组挂了同一个抖音作品 DY_LINK，验证跨组不重复求和
          if (g === "副组" && p === "抖音") {
            return [
              { workId: "DY_LINK", title: "直链视频", url: "https://www.douyin.com/video/101", publishTime: pubMs },
            ];
          }
          return [];
        },
        readWorksDaily: (g, p) => {
          if (p === "抖音" && (g === "主组" || g === "副组")) {
            const base = {
              DY_LINK: {
                "2026-11-11": { play: 100, like: 10 },
                "2026-11-12": { play: 180, like: 18 },
                // 故意跳过 11-13
                "2026-11-14": { play: 300, like: 30 },
                "2026-11-16": { play: 500, like: 50 },
              },
            };
            if (g === "主组") {
              base.DY_MAN = {
                "2026-11-12": { play: 400 },
                "2026-11-14": { play: 700 },
              };
              base.DY_UNL = {
                "2026-11-13": { play: 80 },
                "2026-11-14": { play: 120 },
              };
            }
            return base;
          }
          if (g === "主组" && p === "快手") {
            return {
              KS_LINK: {
                "2026-11-11": { play: 50, like: 5 },
                "2026-11-12": { play: 90, like: 9 },
                "2026-11-14": { play: 150, like: 15 },
              },
              KS_MAN: {
                "2026-11-12": { play: 200 },
                "2026-11-14": { play: 350 },
              },
            };
          }
          return {};
        },
        readDaily: () => ({}),
        readPushRecords: () => [
          {
            id: "pr-1",
            pt: "抖音",
            group: "主组",
            publishStatus: "success",
            title: "直链视频",
            filePath: "/videos/linked_demo.mp4",
            videoLink: "https://www.douyin.com/video/101",
            lastPublishAt: pubMs,
          },
          {
            id: "pr-2",
            pt: "快手",
            group: "主组",
            publishStatus: "success",
            title: "直链视频",
            filePath: "/videos/linked_demo.mp4",
            videoLink: "https://www.kuaishou.com/short-video/202",
            lastPublishAt: pubMs,
          },
        ],
        readLinkOverrides: () => ({
          version: 1,
          updatedAt: pubMs,
          contents: {
            "manual:m1": { title: "手工合并组", createdAt: pubMs },
          },
          excludedAuto: {},
          overrides: {
            "抖音|DY_MAN": { action: "assign", contentKey: "manual:m1" },
            "快手|KS_MAN": { action: "assign", contentKey: "manual:m1" },
          },
        }),
      };

      registerDataStatsIpc({ exportDeps: trendDeps });
      const saveImage = ipcHandlers.get("stats:save-chart-image");
      const saveBatch = ipcHandlers.get("stats:save-chart-images-batch");
      const getContentTrend = ipcHandlers.get("stats:get-content-trend");
      const getContentSummary = ipcHandlers.get("stats:get-content-summary");
      assert.strictEqual(typeof saveImage, "function");
      assert.strictEqual(typeof saveBatch, "function");
      assert.strictEqual(typeof getContentTrend, "function");

      const localEv = { senderFrame: { url: "file:///app/index.html" }, sender: {} };
      const localhostEv = { senderFrame: { url: "http://localhost:9080/" }, sender: {} };

      // 5.1 save-chart-image 拒绝非本地页面
      for (const badUrl of ["https://evil.example.com", "file://remote/index.html", ""]) {
        const denied = await saveImage(
          { senderFrame: { url: badUrl }, sender: {} },
          { dataUrl: VALID_PNG_DATA_URL, name: "总览" }
        );
        assert.strictEqual(denied.ok, false, `外部来源 ${badUrl} 必须被拒绝`);
      }
      assert.strictEqual(saveDialogCalls.length, 0, "被拒绝的请求不得弹出保存对话框");

      // 5.2 save-chart-image 拒绝非 PNG 与伪造 PNG 头
      const badPayloads = [
        null,
        {},
        { dataUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" },
        { dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
        { dataUrl: "not-a-data-url" },
        { dataUrl: "data:image/png;base64," },
        { dataUrl: "data:image/png;base64,!!!invalid!!!" },
        { dataUrl: `data:image/png;base64,${Buffer.from("not-real-png-bytes").toString("base64")}` },
      ];
      for (const bad of badPayloads) {
        const res = await saveImage(localEv, bad);
        assert.strictEqual(res.ok, false, `非法 dataUrl 必须被拒绝：${JSON.stringify(bad)}`);
      }

      // 5.3 save-chart-image 拒绝 >10MB 超大 PNG
      const oversizeBuf = Buffer.alloc(10 * 1024 * 1024 + 16, 0);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizeBuf, 0);
      const oversizeRes = await saveImage(localEv, {
        dataUrl: `data:image/png;base64,${oversizeBuf.toString("base64")}`,
        name: "超大图表",
      });
      assert.strictEqual(oversizeRes.ok, false, "超过 10MB 的 PNG 必须被拒绝");
      assert.ok((oversizeRes.message || "").includes("10MB"));
      assert.strictEqual(saveDialogCalls.length, 0, "校验失败前不得弹出保存对话框");

      // 5.4 save-chart-image 正常保存与取消
      const savedPath = path.join(docsDir, "chart-ok.png");
      nextSaveDialogResult = { canceled: false, filePath: savedPath };
      const okSave = await saveImage(localhostEv, {
        dataUrl: VALID_PNG_DATA_URL,
        name: "总览/日趋势:*?",
        date: "2026-11-20",
      });
      assert.strictEqual(okSave.ok, true);
      assert.strictEqual(okSave.filePath, savedPath);
      assert.strictEqual(saveDialogCalls.length, 1);
      assert.ok(saveDialogCalls[0].defaultPath.startsWith(docsDir), "默认路径应位于 Documents");
      assert.ok(saveDialogCalls[0].defaultPath.includes("2026-11-20"), "默认文件名应包含日期");
      assert.ok(saveDialogCalls[0].defaultPath.endsWith(".png"));
      assert.deepStrictEqual(fs.readFileSync(savedPath), Buffer.from(VALID_1X1_PNG_B64, "base64"));

      nextSaveDialogResult = { canceled: true, filePath: "" };
      const canceledSave = await saveImage(localEv, { dataUrl: VALID_PNG_DATA_URL, name: "取消测试" });
      assert.strictEqual(canceledSave.ok, false);
      assert.strictEqual(canceledSave.canceled, true);

      // 5.5 save-chart-images-batch 批量导出（单次目录选择对话框 + 重名自动编号）
      const batchDenied = await saveBatch(
        { senderFrame: { url: "https://evil.example.com" }, sender: {} },
        { items: [{ dataUrl: VALID_PNG_DATA_URL, name: "A" }] }
      );
      assert.strictEqual(batchDenied.ok, false);
      const batchBadItem = await saveBatch(localEv, {
        items: [{ dataUrl: "data:image/jpeg;base64,AAAA", name: "坏图" }],
      });
      assert.strictEqual(batchBadItem.ok, false);
      assert.strictEqual(openDialogCalls.length, 0);

      const batchOutDir = path.join(tmpRoot, "batch-out");
      nextOpenDialogResult = { canceled: false, filePaths: [batchOutDir] };
      const batchOk = await saveBatch(localEv, {
        date: "2026-11-20",
        items: [
          { dataUrl: VALID_PNG_DATA_URL, name: "总览-日趋势" },
          { dataUrl: VALID_PNG_DATA_URL, name: "总览-日趋势" },
          { dataUrl: VALID_PNG_DATA_URL, name: "平台对比" },
        ],
      });
      assert.strictEqual(batchOk.ok, true);
      assert.strictEqual(openDialogCalls.length, 1, "批量导出应仅弹出一次目录选择对话框");
      assert.strictEqual(batchOk.count, 3);
      for (const f of batchOk.files) {
        assert.ok(fs.existsSync(f), `批量导出的文件必须存在：${f}`);
        assert.deepStrictEqual(fs.readFileSync(f), Buffer.from(VALID_1X1_PNG_B64, "base64"));
      }
      console.log("✓ stats:save-chart-image 与 stats:save-chart-images-batch IPC 安全/功能校验通过");

      // 5.6 stats:get-content-trend 安全校验与汇总关联/截止日完全一致
      const trendDenied = await getContentTrend(
        { senderFrame: { url: "https://evil.example.com" } },
        { contentKey: "file:/videos/linked_demo.mp4" }
      );
      assert.strictEqual(trendDenied.ok, false);
      assert.strictEqual((await getContentTrend(localEv, { contentKey: "" })).ok, false);
      assert.strictEqual(
        (await getContentTrend(localEv, { contentKey: "file:/videos/linked_demo.mp4", from: "2026-11-15", to: "2026-11-10" })).ok,
        false
      );

      const summaryRes = await getContentSummary(localEv, {});
      const summaryDirect = buildContentSummaryData({}, trendDeps);
      assert.strictEqual(summaryRes.date, "2026-11-16");
      assert.strictEqual(summaryDirect.date, "2026-11-16");

      // ① 自动直链内容（跨组去重 + 缺天补空 + 与汇总截止日 11-16 一致）
      const linkedTrend = await getContentTrend(localEv, {
        contentKey: "file:/videos/linked_demo.mp4",
      });
      assert.strictEqual(linkedTrend.ok, true);
      assert.strictEqual(linkedTrend.found, true);
      assert.strictEqual(linkedTrend.date, summaryRes.date, "默认截止日必须与作品汇总完全一致");
      assert.deepStrictEqual(linkedTrend.dates, [
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
        "2026-11-16",
      ]);
      const linkedSummaryRow = summaryRes.rows.find((r) => r.contentKey === "file:/videos/linked_demo.mp4");
      const dyPt = linkedTrend.platforms.find((p) => p.platform === "抖音");
      const ksPt = linkedTrend.platforms.find((p) => p.platform === "快手");
      // 抖音跨主组/副组去重后不得翻倍：100, 180, null, 300, null, 500
      assert.deepStrictEqual(dyPt.play, [100, 180, null, 300, null, 500]);
      assert.deepStrictEqual(dyPt.playDelta, [null, 80, null, 120, null, 200]);
      assert.deepStrictEqual(ksPt.play, [50, 90, null, 150, null, null]);
      assert.deepStrictEqual(ksPt.playDelta, [null, 40, null, 60, null, null]);
      assert.deepStrictEqual(linkedTrend.totalPlayDelta, [null, 120, null, 180, null, 200]);
      // 抖音末值 500 + 快手末值 150 = 汇总 row.totalPlay (650)
      assert.strictEqual(dyPt.play[5] + ksPt.play[3], linkedSummaryRow.totalPlay);

      // ② 指定 from/to 区间：首日 11-12 仍保留相对 11-11 的日增 (+80/+40 = +120)，且受 to 截止约束
      const rangedTrend = buildContentTrendData(
        { contentKey: "file:/videos/linked_demo.mp4", from: "2026-11-12", to: "2026-11-14" },
        trendDeps
      );
      assert.strictEqual(rangedTrend.date, "2026-11-14");
      assert.deepStrictEqual(rangedTrend.dates, ["2026-11-12", "2026-11-13", "2026-11-14"]);
      assert.deepStrictEqual(rangedTrend.totalPlayDelta, [120, null, 180]);

      // ③ 手工合并内容（manual:m1）：与汇总共用 link-overrides 关联结果
      const manualSummaryRow = summaryRes.rows.find((r) => r.contentKey === "manual:m1");
      assert.ok(manualSummaryRow, "汇总应包含手工合并内容 manual:m1");
      const manualTrend = await getContentTrend(localEv, { contentKey: "manual:m1" });
      assert.strictEqual(manualTrend.ok, true);
      assert.strictEqual(manualTrend.found, true);
      assert.strictEqual(manualTrend.platforms.length, 2, "手工合并的抖音与快手作品应同时出现");
      assert.deepStrictEqual(manualTrend.totalPlay, [600, null, 1050]);
      assert.strictEqual(manualTrend.totalPlay[2], manualSummaryRow.totalPlay, "趋势最新累计必须等于汇总总播放");

      // ④ 未关联作品（unlinked:抖音:DY_UNL）同样可查趋势
      const unlinkedTrend = await getContentTrend(localEv, { contentKey: "unlinked:抖音:DY_UNL" });
      assert.strictEqual(unlinkedTrend.ok, true);
      assert.strictEqual(unlinkedTrend.found, true);
      assert.deepStrictEqual(unlinkedTrend.dates, ["2026-11-13", "2026-11-14"]);
      assert.deepStrictEqual(unlinkedTrend.platforms[0].play, [80, 120]);
      assert.deepStrictEqual(unlinkedTrend.totalPlayDelta, [null, 40]);

      // ⑤ 不存在的内容键安全返回 found:false
      const missingTrend = await getContentTrend(localEv, { contentKey: "file:/not/exist.mp4" });
      assert.strictEqual(missingTrend.ok, true);
      assert.strictEqual(missingTrend.found, false);
      assert.deepStrictEqual(missingTrend.dates, []);
      console.log("✓ stats:get-content-trend 与作品汇总关联/截止日一致性校验通过");
    } finally {
      if (origElectronCache) require.cache[electronId] = origElectronCache;
      else delete require.cache[electronId];
      if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
      else delete require.cache[collectorId];
      delete require.cache[storeId];
      delete require.cache[indexId];
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  /* ---------- 6. StatsChart.vue 与 dataStats/index.vue 编译与组件行为校验 ---------- */
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-charts-vue-"));
    try {
      // 6.1 编译 StatsChart.vue 模板并打包脚本（真实解析 echarts/core 模块化引入）
      const statsChartPath = path.resolve(__dirname, "../src/renderer/components/StatsChart.vue");
      const chartSfc = vueCompiler.parseComponent(fs.readFileSync(statsChartPath, "utf8"));
      const chartTpl = vueCompiler.compile(chartSfc.template.content);
      assert.strictEqual(
        chartTpl.errors.length,
        0,
        `StatsChart.vue 模板编译失败: ${chartTpl.errors.join("; ")}`
      );

      const chartBundle = path.join(tmpDir, "StatsChart.cjs");
      await build({
        stdin: {
          contents: chartSfc.script.content,
          resolveDir: path.dirname(statsChartPath),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: chartBundle,
      });

      const chartMod = require(chartBundle);
      const chartComp = chartMod.default;
      assert.strictEqual(chartComp.name, "StatsChart");
      assert.strictEqual(chartMod.PLATFORM_COLORS["抖音"], PLATFORM_COLORS["抖音"], "StatsChart.vue 应导出固定平台配色常量");
      assert.strictEqual(chartMod.getPlatformColor("快手"), getPlatformColor("快手"));

      // 验证生命周期：el-tabs 初始宽度 0 延迟 init → 切回后 resize 初始化 → setOption(notMerge=true) → getDataURL → dispose
      const chartBundleMocked = path.join(tmpDir, "StatsChart-mocked.cjs");
      await build({
        stdin: {
          contents: chartSfc.script.content,
          resolveDir: path.dirname(statsChartPath),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
        outfile: chartBundleMocked,
      });

      const origLoad = Module._load;
      const origRO = global.ResizeObserver;
      let roCallback = null;
      let roDisconnected = false;
      const echartsCalls = { init: 0, setOption: [], resize: 0, dispose: 0, clear: 0 };

      global.ResizeObserver = class MockRO {
        constructor(cb) {
          roCallback = cb;
        }
        observe() {}
        disconnect() {
          roDisconnected = true;
        }
      };
      Module._load = function (req, ...rest) {
        if (req === "echarts/core") {
          return {
            use: () => {},
            init: () => {
              echartsCalls.init += 1;
              return {
                setOption: (opt, notMerge) => echartsCalls.setOption.push({ opt, notMerge }),
                resize: () => {
                  echartsCalls.resize += 1;
                },
                clear: () => {
                  echartsCalls.clear += 1;
                },
                showLoading: () => {},
                hideLoading: () => {},
                getDataURL: () => VALID_PNG_DATA_URL,
                dispose: () => {
                  echartsCalls.dispose += 1;
                },
              };
            },
          };
        }
        if (req === "echarts/charts" || req === "echarts/components" || req === "echarts/renderers") {
          return {};
        }
        return origLoad.call(this, req, ...rest);
      };

      try {
        const compDef = require(chartBundleMocked).default;
        const canvasEl = { clientWidth: 0, clientHeight: 0 };
        const ctx = {
          option: buildOverviewPieOption(analysis),
          height: "320px",
          loading: false,
          emptyText: "暂无数据",
          $refs: { root: {}, canvas: canvasEl },
          $nextTick: (fn) => fn(),
        };
        for (const [k, fn] of Object.entries(compDef.computed)) {
          Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
        }
        for (const [k, fn] of Object.entries(compDef.methods)) {
          ctx[k] = fn.bind(ctx);
        }

        // 初始在隐藏 el-tab-pane 下宽为 0：不强行 init
        compDef.mounted.call(ctx);
        assert.strictEqual(echartsCalls.init, 0, "容器宽为 0 时应延迟初始化，避免 ECharts 0 宽异常");

        // 切回 tab 后容器恢复宽度，ResizeObserver 触发 resize → 自动 init + setOption(notMerge=true)
        canvasEl.clientWidth = 640;
        canvasEl.clientHeight = 320;
        assert.strictEqual(typeof roCallback, "function");
        roCallback();
        assert.strictEqual(echartsCalls.init, 1, "容器恢复可见宽度后应自动初始化");
        assert.strictEqual(echartsCalls.setOption.length, 1);
        assert.strictEqual(echartsCalls.setOption[0].notMerge, true, "setOption 必须传 notMerge=true");
        assert.strictEqual(ctx.getDataURL(), VALID_PNG_DATA_URL);

        // 切到空数据时清空画布且 getDataURL 返回空串
        ctx.option = { __empty: true, emptyText: "暂无数据" };
        ctx.syncOption();
        assert.strictEqual(echartsCalls.clear, 1);
        assert.strictEqual(ctx.getDataURL(), "");

        // 销毁时 dispose 与断开 ResizeObserver
        compDef.beforeDestroy.call(ctx);
        assert.strictEqual(echartsCalls.dispose, 1);
        assert.strictEqual(roDisconnected, true);
      } finally {
        Module._load = origLoad;
        if (origRO === undefined) delete global.ResizeObserver;
        else global.ResizeObserver = origRO;
      }

      // 6.2 编译 dataStats/index.vue 模板并校验可视化方法
      const indexVuePath = path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue");
      const indexSfc = vueCompiler.parseComponent(fs.readFileSync(indexVuePath, "utf8"));
      const indexTpl = vueCompiler.compile(indexSfc.template.content);
      assert.strictEqual(
        indexTpl.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${indexTpl.errors.join("; ")}`
      );
      assert.ok(indexSfc.template.content.includes("导出全部图表"), "应包含「导出全部图表」按钮");
      assert.ok(indexSfc.template.content.includes("openContentTrend"), "作品汇总应包含「趋势」入口");
      assert.ok(indexSfc.template.content.includes("stats-chart"), "应挂载 StatsChart 组件");

      const indexBundle = path.join(tmpDir, "dataStats-index.cjs");
      await build({
        stdin: {
          contents: indexSfc.script.content,
          resolveDir: path.dirname(indexVuePath),
          loader: "js",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron"],
        outfile: indexBundle,
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

      const origLoad2 = Module._load;
      const invokeLog = [];
      Module._load = function (req, ...rest) {
        if (req === "electron") {
          return {
            ipcRenderer: {
              invoke: async (ch, payload) => {
                invokeLog.push({ ch, payload });
                if (ch === "stats:save-chart-image") return { ok: true, filePath: "/tmp/a.png" };
                if (ch === "stats:save-chart-images-batch") return { ok: true, dir: "/tmp/out", count: payload.items.length };
                if (ch === "stats:get-content-trend") {
                  return {
                    ok: true,
                    found: true,
                    title: "视频A",
                    date: "2026-11-20",
                    dates: ["2026-11-19", "2026-11-20"],
                    platforms: [{ platform: "抖音", play: [100, 200], playDelta: [null, 100] }],
                    totalPlayDelta: [null, 100],
                  };
                }
                return { ok: true };
              },
            },
            shell: { openExternal: async () => {} },
            clipboard: { writeText: () => {} },
          };
        }
        return origLoad2.call(this, req, ...rest);
      };
      try {
        const idxComp = require(indexBundle).default;
        let resizedCount = 0;
        const mockChartRef = {
          resize: () => {
            resizedCount += 1;
          },
          getDataURL: () => VALID_PNG_DATA_URL,
        };
        const msgs = [];
        const ctx = {
          ...idxComp.data(),
          analysisData: analysis,
          contentSummaryDate: "2026-11-20",
          $refs: {
            chartOverviewTrend: mockChartRef,
            chartOverviewPie: mockChartRef,
            chartPlatformCompare: mockChartRef,
            chartRankingTop10: mockChartRef,
            chartNewWorksLine: mockChartRef,
            chartNewWorksPie: mockChartRef,
            chartPublishTimeHeatmap: mockChartRef,
            chartFansTrend: mockChartRef,
            chartContentTrend: mockChartRef,
          },
          $nextTick: (fn) => fn(),
          $message: {
            success: (m) => msgs.push({ type: "success", m }),
            warning: (m) => msgs.push({ type: "warning", m }),
            error: (m) => msgs.push({ type: "error", m }),
          },
        };
        for (const [k, fn] of Object.entries(idxComp.computed)) {
          Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
        }
        for (const [k, fn] of Object.entries(idxComp.methods)) {
          ctx[k] = fn.bind(ctx);
        }

        // 1) 单图保存
        await ctx.saveChartImage("chartOverviewTrend", "总览-日趋势-播放");
        assert.strictEqual(invokeLog[0].ch, "stats:save-chart-image");
        assert.strictEqual(invokeLog[0].payload.dataUrl, VALID_PNG_DATA_URL);
        assert.strictEqual(invokeLog[0].payload.date, "2026-11-20");

        // 2) 批量导出全部 8 张图表（同时携带周期 period 与截止日 date）
        await ctx.exportAllCharts();
        assert.strictEqual(invokeLog[1].ch, "stats:save-chart-images-batch");
        assert.strictEqual(invokeLog[1].payload.items.length, 8);
        assert.strictEqual(invokeLog[1].payload.period, analysis.period);
        assert.strictEqual(invokeLog[1].payload.date, analysis.to);
        assert.ok(resizedCount >= 8);

        // 3) 作品汇总「趋势」弹窗打开并透传汇总截止日
        await ctx.openContentTrend({ contentKey: "file:/v/c1.mp4", title: "示例内容01" });
        assert.strictEqual(ctx.contentTrendVisible, true);
        assert.strictEqual(invokeLog[2].ch, "stats:get-content-trend");
        assert.deepStrictEqual(invokeLog[2].payload, { contentKey: "file:/v/c1.mp4", to: "2026-11-20" });
        assert.strictEqual(isEmptyChartOption(ctx.contentTrendOption), false);
      } finally {
        Module._load = origLoad2;
      }

      console.log("✓ StatsChart.vue 与 dataStats/index.vue 编译及组件交互校验通过");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /* ---------- 7. S8-fix 评审返修 1–9 回归用例 ---------- */
  await runS8FixRegressions(analysis);

  console.log("\ntest-stats-charts: 全部断言通过");
}

/* ======================== S8-fix 1–9 回归用例 ======================== */

// 1. content-trend 同平台多作品累计播放=截至当天最新快照之和，整平台当天无快照→空
function testFix1_ContentTrendCumulativeSumAcrossSamePlatformWorks() {
  const pubMs = Date.parse("2026-11-10T10:00:00+08:00");
  const deps = {
    now: Date.parse("2026-11-20T12:00:00+08:00"),
    listAccounts: () => [{ group: "主组", platform: "抖音" }],
    readWorks: () => [
      { workId: "DY_A", title: "手工合并作品A", publishTime: pubMs },
      { workId: "DY_B", title: "手工合并作品B", publishTime: pubMs },
    ],
    readWorksDaily: () => ({
      DY_A: {
        "2026-11-11": { play: 550 },
        // 11-12 与 11-13 均无 DY_A 新快照
      },
      DY_B: {
        // 仅在 11-13 采到 200（11-12 整平台无任何快照）
        "2026-11-13": { play: 200 },
      },
    }),
    readDaily: () => ({}),
    readPushRecords: () => [],
    readLinkOverrides: () => ({
      version: 1,
      updatedAt: pubMs,
      contents: { "manual:same-pt": { title: "同平台合并视频", createdAt: pubMs } },
      excludedAuto: {},
      overrides: {
        "抖音|DY_A": { action: "assign", contentKey: "manual:same-pt" },
        "抖音|DY_B": { action: "assign", contentKey: "manual:same-pt" },
      },
    }),
  };

  const summary = buildContentSummaryData({}, deps);
  const summaryRow = summary.rows.find((r) => r.contentKey === "manual:same-pt");
  assert.ok(summaryRow, "汇总表应包含 manual:same-pt");
  assert.strictEqual(summaryRow.totalPlay, 750, "汇总表总播放应为 550 + 200 = 750");

  const trend = buildContentTrendData({ contentKey: "manual:same-pt" }, deps);
  assert.strictEqual(trend.found, true);
  assert.deepStrictEqual(trend.dates, ["2026-11-11", "2026-11-12", "2026-11-13"]);
  const dyPt = trend.platforms.find((p) => p.platform === "抖音");
  assert.ok(dyPt, "应包含抖音平台序列");
  // 11-11: 550; 11-12: 整平台无快照 → null; 11-13: DY_A最新(550) + DY_B最新(200) = 750
  assert.deepStrictEqual(dyPt.play, [550, null, 750], "同平台多作品累计播放必须等于截至当天各作品最新快照之和，整平台缺天仍留空");
  assert.deepStrictEqual(trend.totalPlay, [550, null, 750]);

  // 指定 from=2026-11-13 时仍应计入 DY_A 在 from 之前（11-11）的最新快照 550
  const tailTrend = buildContentTrendData(
    { contentKey: "manual:same-pt", from: "2026-11-13", to: "2026-11-13" },
    deps
  );
  assert.deepStrictEqual(tailTrend.dates, ["2026-11-13"]);
  assert.deepStrictEqual(tailTrend.platforms[0].play, [750]);
  console.log("✓ [S8-fix #1] content-trend 同平台多作品累计播放与汇总一致、整平台缺天留空");
}

// 2. StatsChart 隐藏时收到新 option 保存为 pending，恢复可见后先 setOption 再 resize
async function testFix2_StatsChartPendingOptionWhenHiddenAppliesBeforeResize(analysis) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s8fix2-"));
  const origLoad = Module._load;
  const origRO = global.ResizeObserver;
  try {
    const statsChartPath = path.resolve(__dirname, "../src/renderer/components/StatsChart.vue");
    const chartSfc = vueCompiler.parseComponent(fs.readFileSync(statsChartPath, "utf8"));
    const chartTpl = vueCompiler.compile(chartSfc.template.content);
    assert.strictEqual(chartTpl.errors.length, 0);

    const outBundle = path.join(tmpDir, "StatsChart-pending.cjs");
    await build({
      stdin: {
        contents: chartSfc.script.content,
        resolveDir: path.dirname(statsChartPath),
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
      outfile: outBundle,
    });

    let roCb = null;
    const ops = [];
    global.ResizeObserver = class MockRO {
      constructor(cb) {
        roCb = cb;
      }
      observe() {}
      disconnect() {}
    };
    Module._load = function (req, ...rest) {
      if (req === "echarts/core") {
        return {
          use: () => {},
          init: () => ({
            setOption: (opt, notMerge) => ops.push({ type: "setOption", opt, notMerge }),
            resize: () => ops.push({ type: "resize" }),
            clear: () => ops.push({ type: "clear" }),
            on: () => {},
            off: () => {},
            showLoading: () => {},
            hideLoading: () => {},
            getDataURL: () => VALID_PNG_DATA_URL,
            dispose: () => ops.push({ type: "dispose" }),
          }),
        };
      }
      if (req === "echarts/charts" || req === "echarts/components" || req === "echarts/renderers") {
        return {};
      }
      return origLoad.call(this, req, ...rest);
    };

    const compDef = require(outBundle).default;
    const canvasEl = { clientWidth: 640, clientHeight: 320 };
    const optOld = buildOverviewTrendOption(analysis, { metric: "play", stacked: false });
    const optNew = buildOverviewTrendOption(analysis, { metric: "like", stacked: false });
    const ctx = {
      option: optOld,
      height: "320px",
      loading: false,
      emptyText: "暂无数据",
      $refs: { root: {}, canvas: canvasEl },
      $nextTick: (fn) => fn(),
    };
    for (const [k, fn] of Object.entries(compDef.computed)) {
      Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
    }
    for (const [k, fn] of Object.entries(compDef.methods)) {
      ctx[k] = fn.bind(ctx);
    }

    // 先在可见状态完成首次初始化
    compDef.mounted.call(ctx);
    assert.strictEqual(ops.length, 1);
    assert.strictEqual(ops[0].type, "setOption");
    assert.strictEqual(ops[0].opt.yAxis.name, "播放日增");

    // 切走页面容器隐藏（宽高变 0），期间后台刷新推送新 option
    ops.length = 0;
    canvasEl.clientWidth = 0;
    canvasEl.clientHeight = 0;
    ctx.option = optNew;
    compDef.watch.option.handler.call(ctx);
    assert.strictEqual(ops.length, 0, "隐藏时不得直接对 0 宽画布 setOption 或 resize");

    // 切回页面容器恢复可见，activated/ResizeObserver 触发 resize()
    canvasEl.clientWidth = 640;
    canvasEl.clientHeight = 320;
    roCb();
    assert.ok(ops.length >= 2, `恢复可见后必须先 setOption 再 resize，实际调用：${JSON.stringify(ops.map((o) => o.type))}`);
    assert.strictEqual(ops[0].type, "setOption", "恢复可见后第一步必须先应用 pending option");
    assert.strictEqual(ops[0].notMerge, true);
    assert.strictEqual(ops[0].opt.yAxis.name, "点赞日增", "应用的必须是隐藏期间收到的最新 option");
    assert.strictEqual(ops[1].type, "resize", "setOption 之后再调用 resize");

    // 后续无 option 变更再次 resize 时不应重复 setOption
    ops.length = 0;
    ctx.resize();
    assert.deepStrictEqual(ops.map((o) => o.type), ["resize"]);

    compDef.beforeDestroy.call(ctx);
    console.log("✓ [S8-fix #2] StatsChart 隐藏时保留 pending option，恢复可见先 setOption 再 resize");
  } finally {
    Module._load = origLoad;
    if (origRO === undefined) delete global.ResizeObserver;
    else global.ResizeObserver = origRO;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 3. 批量导出全部图表在所选目录下新建独立子目录 MatrixMedia-图表-<周期>-<截止日>-<HHmmss>
async function testFix3_BatchExportCreatesIsolatedTimestampedSubdir() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s8fix3-"));
  const chosenDir = path.join(tmpRoot, "exports");
  fs.mkdirSync(chosenDir, { recursive: true });
  const ipcHandlers = new Map();
  const electronId = require.resolve("electron");
  const origElectronCache = require.cache[electronId];
  const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
  const origCollectorCache = require.cache[collectorId];
  const storeId = require.resolve("../src/main/services/dataStats/store.js");
  const indexId = require.resolve("../src/main/services/dataStats/index.js");

  try {
    const mockWin = { id: 1 };
    require.cache[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: {
        app: { getPath: () => tmpRoot, getVersion: () => "0.14.9-fork.test" },
        BrowserWindow: { fromWebContents: (s) => (s ? mockWin : null) },
        dialog: {
          showSaveDialog: async () => ({ canceled: true }),
          showOpenDialog: async () => ({ canceled: false, filePaths: [chosenDir] }),
        },
        ipcMain: { handle: (ch, fn) => ipcHandlers.set(ch, fn) },
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

    const { registerDataStatsIpc } = require(indexId);
    registerDataStatsIpc({
      exportDeps: { now: Date.parse("2026-11-20T14:25:36+08:00") },
    });
    const saveBatch = ipcHandlers.get("stats:save-chart-images-batch");
    const localEv = { senderFrame: { url: "file:///app/index.html" }, sender: {} };

    // 同一截止日、同一所选目录先导出近 30 天（2 张），再导出近 7 天（仅 1 张），再同秒再导一次近 7 天
    const res30 = await saveBatch(localEv, {
      period: 30,
      date: "2026-11-20",
      items: [
        { dataUrl: VALID_PNG_DATA_URL, name: "1-总览-日趋势-播放" },
        { dataUrl: VALID_PNG_DATA_URL, name: "2-平台对比" },
      ],
    });
    const res7 = await saveBatch(localEv, {
      period: 7,
      date: "2026-11-20",
      items: [{ dataUrl: VALID_PNG_DATA_URL, name: "1-总览-日趋势-播放" }],
    });
    const res7Second = await saveBatch(localEv, {
      period: 7,
      date: "2026-11-20",
      items: [{ dataUrl: VALID_PNG_DATA_URL, name: "1-总览-日趋势-播放" }],
    });

    assert.strictEqual(res30.ok, true);
    assert.strictEqual(res7.ok, true);
    assert.strictEqual(res7Second.ok, true);
    assert.strictEqual(path.dirname(res30.dir), chosenDir, "近 30 天应在所选目录下新建子目录");
    assert.strictEqual(path.dirname(res7.dir), chosenDir, "近 7 天应在所选目录下新建子目录");
    assert.strictEqual(path.basename(res30.dir), "MatrixMedia-图表-近30天-2026-11-20-142536");
    assert.strictEqual(path.basename(res7.dir), "MatrixMedia-图表-近7天-2026-11-20-142536");
    assert.notStrictEqual(res7Second.dir, res7.dir, "同秒重复导出不得覆盖已有目录");
    assert.strictEqual(path.basename(res7Second.dir), "MatrixMedia-图表-近7天-2026-11-20-142536-2");
    assert.strictEqual(fs.readdirSync(res30.dir).length, 2, "近 30 天目录两张旧图应完好保留");
    assert.strictEqual(fs.readdirSync(res7.dir).length, 1, "近 7 天目录只应包含本次导出的 1 张图，不混入旧图");
    console.log("✓ [S8-fix #3] 批量导出新建独立子目录 MatrixMedia-图表-<周期>-<截止日>-<HHmmss>");
  } finally {
    if (origElectronCache) require.cache[electronId] = origElectronCache;
    else delete require.cache[electronId];
    if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
    else delete require.cache[collectorId];
    delete require.cache[storeId];
    delete require.cache[indexId];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// 4. Top/Bottom 10 切换图表与表格共用同一数据，图名与导出名同步
async function testFix4_RankingBottom10SharesDataAndSyncsTitleExportName(analysis) {
  // 纯函数：order="bottom" 返回 Bottom 10，且支持传入与表格共用的 items
  const topOpt = buildRankingTop10Option(analysis, { metric: "play", order: "top" });
  const bottomOpt = buildRankingTop10Option(analysis, { metric: "play", order: "bottom" });
  const bottomList = analysis.rankings.byPlay.bottom;
  const topList = analysis.rankings.byPlay.top;
  assert.notStrictEqual(topList[0].contentKey, bottomList[0].contentKey, "12 条样本下 Top1 与 Bottom1 必须不同");
  assert.ok(
    bottomOpt.yAxis.data[0].includes(bottomList[0].title),
    `Bottom10 图表首项应为表格 Bottom1(${bottomList[0].title})，实际：${bottomOpt.yAxis.data[0]}`
  );
  assert.notStrictEqual(topOpt.yAxis.data[0], bottomOpt.yAxis.data[0], "Top10 与 Bottom10 图表内容必须不同");

  const sharedOpt = buildRankingTop10Option(analysis, {
    metric: "play",
    order: "bottom",
    items: bottomList,
  });
  assert.deepStrictEqual(sharedOpt.yAxis.data, bottomOpt.yAxis.data);

  // Vue 组件：切换 analysisRankOrder="bottom" 后图表、表格、图名与导出名完全同步
  const { compDef, template, cleanup } = await loadDataStatsIndexComponent();
  try {
    const ctx = createDataStatsCtx(compDef, analysis);
    ctx.analysisRankOrder = "bottom";
    ctx.analysisRankMetric = "play";
    assert.strictEqual(ctx.analysisDisplayedRankRows[0].contentKey, bottomList[0].contentKey);
    assert.ok(
      ctx.rankingTop10Option.yAxis.data[0].includes(ctx.analysisDisplayedRankRows[0].title),
      "切换 Bottom 10 后图表应与表格展示同一批作品"
    );
    const rankSpec = ctx.getAnalysisChartSpecs().find((s) => s.ref === "chartRankingTop10");
    assert.ok(
      rankSpec && rankSpec.name.includes("Bottom10") && !rankSpec.name.includes("Top10"),
      `批量导出图名应同步为 Bottom10，实际：${rankSpec && rankSpec.name}`
    );
    assert.ok(
      !template.includes("Top 10 横向对比（按平台堆叠"),
      "模板图表标题不得写死 Top 10"
    );
    assert.ok(
      !template.includes("'作品排行Top10-'"),
      "模板单图导出名不得写死作品排行Top10"
    );
    console.log("✓ [S8-fix #4] Top/Bottom 10 图表与表格共用数据，图名与导出名同步");
  } finally {
    cleanup();
  }
}

// 5. 超过 45 天时间轴上的孤立有效点必须保留 symbol
function testFix5_IsolatedValidPointsKeepSymbolOnLongRange() {
  const longDates = buildContinuousDates(["2026-09-22", "2026-11-20"]); // 60 天 > 45
  assert.ok(longDates.length > 45);

  // 5a. 作品趋势：仅采到 1 次播放的旧作品（孤立点在索引 3）
  const soloPlay = new Array(longDates.length).fill(null);
  soloPlay[3] = 520;
  const soloOpt = buildContentTrendOption({
    dates: longDates,
    platforms: [{ platform: "抖音", play: soloPlay, playDelta: new Array(longDates.length).fill(null) }],
    totalPlayDelta: new Array(longDates.length).fill(null),
  });
  const soloLine = soloOpt.series.find((s) => s.type === "line");
  assert.strictEqual(soloLine.showSymbol, true, "含孤立有效点的 >45 天折线必须开启 showSymbol");
  assert.strictEqual(soloLine.showAllSymbol, true, "含孤立有效点时必须 showAllSymbol:true 防止被刻度抽稀隐藏");
  const soloSymbolAt3 =
    typeof soloLine.symbol === "function"
      ? soloLine.symbol(520, { dataIndex: 3 })
      : soloLine.symbol;
  assert.notStrictEqual(soloSymbolAt3, "none", "唯一孤立有效点必须保留可见 symbol");

  // 5b. 混合场景：既有连续段（索引 10..15）又有孤立点（索引 40）
  const mixedPlay = new Array(longDates.length).fill(null);
  for (let i = 10; i <= 15; i++) mixedPlay[i] = 100 + i;
  mixedPlay[40] = 900;
  const mixedOpt = buildContentTrendOption({
    dates: longDates,
    platforms: [{ platform: "快手", play: mixedPlay, playDelta: new Array(longDates.length).fill(null) }],
    totalPlayDelta: new Array(longDates.length).fill(null),
  });
  const mixedLine = mixedOpt.series.find((s) => s.type === "line");
  assert.strictEqual(mixedLine.showSymbol, true);
  assert.strictEqual(mixedLine.showAllSymbol, true);
  assert.strictEqual(typeof mixedLine.symbol, "function", "混合长序列应按点判断，仅孤立点显示 symbol");
  assert.strictEqual(mixedLine.symbol(900, { dataIndex: 40 }), "circle");
  assert.strictEqual(mixedLine.symbol(112, { dataIndex: 12 }), "none");

  // 5c. 总览折线与粉丝趋势在 >45 天同样保留孤立有效点 symbol
  const ovSolo = buildOverviewTrendOption({
    overview: { dailyTrend: { dates: longDates, platforms: [{ platform: "抖音", play: soloPlay }] } },
  });
  assert.strictEqual(ovSolo.series[0].showSymbol, true);
  assert.strictEqual(ovSolo.series[0].showAllSymbol, true);

  const fansSolo = buildFansTrendOption({
    fansTrend: {
      dates: longDates,
      accounts: [{ accountKey: "抖音|主组", platform: "抖音", group: "主组", label: "抖音·主组", fans: soloPlay }],
    },
  });
  assert.strictEqual(fansSolo.series[0].showSymbol, true);
  assert.strictEqual(fansSolo.series[0].showAllSymbol, true);

  // 5d. 无孤立点的连续长序列仍保持 showSymbol:false 避免密密麻麻圆点
  const densePlay = longDates.map((_, idx) => 100 + idx);
  const denseOpt = buildContentTrendOption({
    dates: longDates,
    platforms: [{ platform: "抖音", play: densePlay, playDelta: new Array(longDates.length).fill(1) }],
    totalPlayDelta: new Array(longDates.length).fill(1),
  });
  assert.strictEqual(denseOpt.series.find((s) => s.type === "line").showSymbol, false);
  console.log("✓ [S8-fix #5] >45 天时间轴孤立有效点保留 symbol（内容/总览/粉丝折线）");
}

// 6. 平台占比环形图标签使用后端 sharePct 且禁止图例筛除扇区
function testFix6_OverviewPieUsesBackendSharePctAndDisablesLegendToggle() {
  const pieOpt = buildOverviewPieOption({
    overview: {
      platformContribution: [
        { platform: "抖音", play: 100, sharePct: 33.33 },
        { platform: "快手", play: 100, sharePct: 33.33 },
        { platform: "视频号", play: 100, sharePct: 33.33 },
      ],
    },
  });
  assert.strictEqual(pieOpt.legend.selectedMode, false, "环形图图例必须禁止筛除扇区以保持分母与表格一致");
  const labelFmt = pieOpt.series[0].label.formatter;
  assert.strictEqual(typeof labelFmt, "function", "环形图标签 formatter 必须为函数以读取后端 sharePct");
  // 即使模拟 ECharts 传入不同的重算 percent=50，标签仍必须显示后端 sharePct=33.33%
  const labelText = labelFmt({
    name: "抖音",
    value: 100,
    percent: 50,
    data: pieOpt.series[0].data[0],
  });
  assert.strictEqual(labelText, "抖音 33.33%");
  console.log("✓ [S8-fix #6] 环形图标签使用后端 sharePct 且 legend.selectedMode=false");
}

// 7. 堆叠面积图图例筛选后按可见系列重算异常标记坐标
async function testFix7_StackedAreaRecomputesMarkPointsOnLegendSelectChanged() {
  const analysisFixture = {
    currentRange: { from: "2026-11-18", to: "2026-11-18" },
    overview: {
      dailyTrend: {
        dates: ["2026-11-18"],
        platforms: [
          { platform: "抖音", play: [100] },
          { platform: "快手", play: [100] },
        ],
      },
    },
    anomalies: {
      collectionAnomalies: [],
      recommendSpikes: [
        { date: "2026-11-18", platform: "快手", title: "爆款视频", dailyPlayDelta: 100, ratio: 6 },
      ],
    },
  };

  const stackedOpt = buildOverviewTrendOption(analysisFixture, { metric: "play", stacked: true });
  const ksSeriesBefore = stackedOpt.series.find((s) => s.name === "快手");
  assert.deepStrictEqual(ksSeriesBefore.markPoint.data[0].coord, ["2026-11-18", 200]);

  assert.strictEqual(
    typeof statsChartOptions.recomputeStackedMarkPoints,
    "function",
    "statsChartOptions 必须导出 recomputeStackedMarkPoints"
  );
  const recomputedHidden = statsChartOptions.recomputeStackedMarkPoints(stackedOpt, {
    抖音: false,
    快手: true,
  });
  const ksHidden = recomputedHidden.series.find((s) => s.name === "快手");
  assert.deepStrictEqual(
    ksHidden.markPoint.data[0].coord,
    ["2026-11-18", 100],
    "隐藏下层平台抖音后，快手「荐」标记坐标必须重算为 100"
  );

  const recomputedRestored = statsChartOptions.recomputeStackedMarkPoints(stackedOpt, {
    抖音: true,
    快手: true,
  });
  assert.deepStrictEqual(
    recomputedRestored.series.find((s) => s.name === "快手").markPoint.data[0].coord,
    ["2026-11-18", 200],
    "重新显示抖音后，快手标记应恢复为 200"
  );

  // 验证 StatsChart.vue 监听 legendselectchanged 并调用 setOption(patch, false) 重算标记
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s8fix7-"));
  const origLoad = Module._load;
  const origRO = global.ResizeObserver;
  try {
    const statsChartPath = path.resolve(__dirname, "../src/renderer/components/StatsChart.vue");
    const chartSfc = vueCompiler.parseComponent(fs.readFileSync(statsChartPath, "utf8"));
    const outBundle = path.join(tmpDir, "StatsChart-legend.cjs");
    await build({
      stdin: {
        contents: chartSfc.script.content,
        resolveDir: path.dirname(statsChartPath),
        loader: "js",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["echarts/core", "echarts/charts", "echarts/components", "echarts/renderers"],
      outfile: outBundle,
    });

    const listeners = new Map();
    const setOptionCalls = [];
    global.ResizeObserver = class MockRO {
      observe() {}
      disconnect() {}
    };
    Module._load = function (req, ...rest) {
      if (req === "echarts/core") {
        return {
          use: () => {},
          init: () => ({
            setOption: (opt, notMerge) => setOptionCalls.push({ opt, notMerge }),
            resize: () => {},
            clear: () => {},
            on: (evt, fn) => listeners.set(evt, fn),
            off: (evt) => listeners.delete(evt),
            showLoading: () => {},
            hideLoading: () => {},
            getDataURL: () => VALID_PNG_DATA_URL,
            dispose: () => {},
          }),
        };
      }
      if (req === "echarts/charts" || req === "echarts/components" || req === "echarts/renderers") {
        return {};
      }
      return origLoad.call(this, req, ...rest);
    };

    const compDef = require(outBundle).default;
    const ctx = {
      option: stackedOpt,
      height: "320px",
      loading: false,
      emptyText: "暂无数据",
      $refs: { root: {}, canvas: { clientWidth: 640, clientHeight: 320 } },
      $nextTick: (fn) => fn(),
    };
    for (const [k, fn] of Object.entries(compDef.computed)) {
      Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
    }
    for (const [k, fn] of Object.entries(compDef.methods)) {
      ctx[k] = fn.bind(ctx);
    }

    compDef.mounted.call(ctx);
    const legendListener = listeners.get("legendselectchanged");
    assert.strictEqual(typeof legendListener, "function", "StatsChart 必须注册 legendselectchanged 监听");
    legendListener({ selected: { 抖音: false, 快手: true } });

    const lastCall = setOptionCalls[setOptionCalls.length - 1];
    assert.strictEqual(lastCall.notMerge, false, "图例筛选重算标记应采用合并更新 notMerge=false 保留图例选择状态");
    const patchedKs = lastCall.opt.series.find((s) => s.name === "快手");
    assert.deepStrictEqual(patchedKs.markPoint.data[0].coord, ["2026-11-18", 100]);

    compDef.beforeDestroy.call(ctx);
    assert.strictEqual(listeners.has("legendselectchanged"), false, "销毁时应解绑 legendselectchanged");

    // 额外用真实 ECharts 实例验证 legendToggleSelect → 重算 markPoint 坐标且保持图例状态无报错
    const realEcharts = require("echarts");
    const realChart = realEcharts.init(null, null, { renderer: "svg", ssr: true, width: 640, height: 320 });
    try {
      realChart.on("legendselectchanged", (params) => {
        const patch = statsChartOptions.buildStackedMarkPointPatch(stackedOpt, params.selected);
        if (patch) realChart.setOption(patch, false);
      });
      realChart.setOption(stackedOpt, true);
      assert.deepStrictEqual(realChart.getOption().series[1].markPoint.data[0].coord, ["2026-11-18", 200]);
      realChart.dispatchAction({ type: "legendToggleSelect", name: "抖音" });
      assert.deepStrictEqual(realChart.getOption().series[1].markPoint.data[0].coord, ["2026-11-18", 100]);
      assert.strictEqual(realChart.getOption().legend[0].selected["抖音"], false);
      realChart.dispatchAction({ type: "legendToggleSelect", name: "抖音" });
      assert.deepStrictEqual(realChart.getOption().series[1].markPoint.data[0].coord, ["2026-11-18", 200]);
    } finally {
      realChart.dispose();
    }
    console.log("✓ [S8-fix #7] 堆叠面积图图例筛选时按可见系列重算异常标记坐标");
  } finally {
    Module._load = origLoad;
    if (origRO === undefined) delete global.ResizeObserver;
    else global.ResizeObserver = origRO;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// 8. 互动率堆叠用原始贡献值绘图，显示时再舍入，合计与表格一致
function testFix8_EngagementRankingStacksRawContribAndRoundsOnDisplay() {
  const analysis = buildStatsAnalysis({
    summaryRows: [
      {
        contentKey: "file:/v/eng-round.mp4",
        title: "互动率舍入校验",
        firstPublishDate: "2026-11-18",
        perPlatform: {
          "抖音|主组": { play: 600, like: 20, comment: 0, share: 0 },
          "快手|主组": { play: 600, like: 20, comment: 0, share: 0 },
        },
        totalPlay: 1200,
        totalLike: 40,
        totalComment: 0,
        totalShare: 0,
      },
    ],
    to: "2026-11-20",
    now: Date.parse("2026-11-20T12:00:00+08:00"),
  });

  const row = analysis.rankings.byEngagement.top[0];
  assert.strictEqual(row.engagementRatePct, 3.33, "表格互动率合计应为 3.33%");

  const rkOpt = buildRankingTop10Option(analysis, { metric: "engagement" });
  const stackedSum = rkOpt.series.reduce((sum, s) => sum + (s.data[0] || 0), 0);
  const roundedStackedSum = Math.round(stackedSum * 100) / 100;
  assert.strictEqual(
    roundedStackedSum,
    row.engagementRatePct,
    `互动率堆叠柱总和应舍入为 ${row.engagementRatePct}%（不提前舍入成 3.34%），实际堆叠和=${stackedSum}`
  );

  // tooltip 单项与合计在展示时均应舍入为两位小数，不出现长浮点尾巴
  const tipHtml = rkOpt.tooltip.formatter(
    rkOpt.series.map((s) => ({
      dataIndex: 0,
      seriesName: s.name,
      value: s.data[0],
      marker: "●",
    }))
  );
  assert.ok(tipHtml.includes("3.33%"), `tooltip 合计应显示 3.33%，实际：${tipHtml}`);
  assert.ok(tipHtml.includes("1.67%"), `tooltip 单平台贡献应舍入显示 1.67%，实际：${tipHtml}`);
  assert.ok(!tipHtml.includes("1.6666"), `tooltip 不得直接输出未舍入长小数：${tipHtml}`);
  console.log("✓ [S8-fix #8] 互动率堆叠按原始值绘图、显示时再舍入，合计与表格一致");
}

// 9. 每张图保存 PNG 文件名使用该图自身的截止日
async function testFix9_SaveChartImageUsesOwnCutoffDate(analysis) {
  const { compDef, template, invokeLog, cleanup } = await loadDataStatsIndexComponent();
  try {
    const ctx = createDataStatsCtx(compDef, { ...analysis, to: "2026-11-13" });
    ctx.contentSummaryDate = "2026-11-20";
    ctx.contentTrendData = {
      found: true,
      date: "2026-11-20",
      from: "2026-11-18",
      to: "2026-11-20",
      dates: ["2026-11-18", "2026-11-19", "2026-11-20"],
      platforms: [{ platform: "抖音", play: [100, 150, 200], playDelta: [null, 50, 50] }],
      totalPlayDelta: [null, 50, 50],
    };

    // 即使只传 2 参，保存作品趋势图也必须取作品趋势自身截止日 2026-11-20，而非数据分析的 2026-11-13
    await ctx.saveChartImage("chartContentTrend", "作品趋势-示例");
    assert.strictEqual(invokeLog[0].ch, "stats:save-chart-image");
    assert.strictEqual(
      invokeLog[0].payload.date,
      "2026-11-20",
      `作品趋势 PNG 截止日应为 2026-11-20，实际：${invokeLog[0].payload.date}`
    );

    // 显式传入自身截止日同样正确；数据分析图使用数据分析自身截止日 2026-11-13
    await ctx.saveChartImage("chartOverviewTrend", "总览-日趋势-播放", ctx.analysisChartDate);
    assert.strictEqual(invokeLog[1].payload.date, "2026-11-13");

    // 模板中每个保存按钮都应显式传入各自截止日
    assert.ok(template.includes("contentTrendChartDate"), "作品趋势保存按钮应显式传入 contentTrendChartDate");
    assert.ok(template.includes("analysisChartDate"), "数据分析图表保存按钮应显式传入 analysisChartDate");
    console.log("✓ [S8-fix #9] 单图保存 PNG 均使用各自图表的截止日");
  } finally {
    cleanup();
  }
}

async function loadDataStatsIndexComponent() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s8fix-idx-"));
  const indexVuePath = path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue");
  const indexSfc = vueCompiler.parseComponent(fs.readFileSync(indexVuePath, "utf8"));
  const indexBundle = path.join(tmpDir, "dataStats-index-fix.cjs");
  await build({
    stdin: {
      contents: indexSfc.script.content,
      resolveDir: path.dirname(indexVuePath),
      loader: "js",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    outfile: indexBundle,
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

  const origLoad = Module._load;
  const invokeLog = [];
  Module._load = function (req, ...rest) {
    if (req === "electron") {
      return {
        ipcRenderer: {
          invoke: async (ch, payload) => {
            invokeLog.push({ ch, payload });
            if (ch === "stats:save-chart-image") return { ok: true, filePath: "/tmp/a.png" };
            if (ch === "stats:save-chart-images-batch") return { ok: true, dir: "/tmp/out", count: payload.items.length };
            return { ok: true };
          },
        },
        shell: { openExternal: async () => {} },
        clipboard: { writeText: () => {} },
      };
    }
    return origLoad.call(this, req, ...rest);
  };
  const compDef = require(indexBundle).default;
  return {
    compDef,
    template: indexSfc.template.content,
    invokeLog,
    cleanup: () => {
      Module._load = origLoad;
      delete require.cache[indexBundle];
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createDataStatsCtx(compDef, analysis) {
  const mockChartRef = {
    resize: () => {},
    getDataURL: () => VALID_PNG_DATA_URL,
  };
  const ctx = {
    ...compDef.data(),
    analysisData: analysis,
    contentSummaryDate: "2026-11-20",
    $refs: {
      chartOverviewTrend: mockChartRef,
      chartOverviewPie: mockChartRef,
      chartPlatformCompare: mockChartRef,
      chartRankingTop10: mockChartRef,
      chartNewWorksLine: mockChartRef,
      chartNewWorksPie: mockChartRef,
      chartPublishTimeHeatmap: mockChartRef,
      chartFansTrend: mockChartRef,
      chartContentTrend: mockChartRef,
    },
    $nextTick: (fn) => fn(),
    $message: { success: () => {}, warning: () => {}, error: () => {} },
  };
  for (const [k, fn] of Object.entries(compDef.computed)) {
    Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
  }
  for (const [k, fn] of Object.entries(compDef.methods)) {
    ctx[k] = fn.bind(ctx);
  }
  return ctx;
}

async function testS9_IntradayAndFirst24hCharts() {
  // 1. buildContentIntradayOption：空数据占位 + 正常多平台折线/增量柱/平台色 + LTTB
  assert.strictEqual(isEmptyChartOption(buildContentIntradayOption(null)), true);
  assert.strictEqual(
    isEmptyChartOption(buildContentIntradayOption({ timePoints: [], platforms: [] })),
    true
  );

  const intraOpt = buildContentIntradayOption({
    timePoints: ["2026-11-19 10:00", "2026-11-19 12:00", "2026-11-20 08:00"],
    platforms: [
      { platform: "快手", play: [null, 80, 180], playDelta: [null, null, 100] },
      { platform: "抖音", play: [100, 220, 400], playDelta: [null, 120, 180] },
    ],
    totalPlay: [100, 300, 580],
    totalPlayDelta: [null, 120, 280],
  });
  assert.strictEqual(isEmptyChartOption(intraOpt), false);
  assert.deepStrictEqual(intraOpt.xAxis.data, [
    "2026-11-19 10:00",
    "2026-11-19 12:00",
    "2026-11-20 08:00",
  ]);
  assert.strictEqual(intraOpt.xAxis.axisLabel.formatter("2026-11-19 10:00"), "11-19 10:00");
  assert.strictEqual(intraOpt.series.length, 3, "2 个平台折线 + 1 条较上次增量柱");
  assert.strictEqual(intraOpt.series[0].name, "抖音");
  assert.strictEqual(intraOpt.series[0].type, "line");
  assert.strictEqual(intraOpt.series[0].connectNulls, false);
  assert.strictEqual(intraOpt.series[0].itemStyle.color, PLATFORM_COLORS["抖音"]);
  assert.strictEqual(intraOpt.series[1].name, "快手");
  assert.strictEqual(intraOpt.series[1].itemStyle.color, PLATFORM_COLORS["快手"]);
  assert.strictEqual(intraOpt.series[2].name, "较上次增量");
  assert.strictEqual(intraOpt.series[2].type, "bar");
  assert.strictEqual(intraOpt.series[2].yAxisIndex, 1);
  assert.deepStrictEqual(intraOpt.series[2].data, [null, 120, 280]);

  const tipHtml = intraOpt.tooltip.formatter([
    { dataIndex: 2, seriesType: "line", seriesName: "抖音", value: 400, marker: "*" },
    { dataIndex: 2, seriesType: "bar", seriesName: "较上次增量", value: 280, marker: "#" },
  ]);
  assert.ok(tipHtml.includes("2026-11-20 08:00") && tipHtml.includes("+180") && tipHtml.includes("+280"));

  // LTTB (> 2000 点自动开启)
  const manyPts = [];
  const manyPlay = [];
  const manyDelta = [];
  for (let i = 0; i < 1100; i++) {
    manyPts.push(`2026-11-01 ${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`);
    manyPlay.push(i * 10);
    manyDelta.push(10);
  }
  const lttbIntra = buildContentIntradayOption({
    timePoints: manyPts,
    platforms: [
      { platform: "抖音", play: manyPlay, playDelta: manyDelta },
      { platform: "快手", play: manyPlay, playDelta: manyDelta },
    ],
    totalPlayDelta: manyDelta,
  });
  assert.strictEqual(lttbIntra.series[0].sampling, "lttb");

  // 2. buildNewWorksFirst24hOption + buildStatsAnalysis(intradayRows)：近 7 天过滤、24h 截断、最多 10 条、平台色与筛选
  const cnMs = (d, hh, mm = 0) => Date.parse(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);
  const intradayRows = [];
  // 12 条近 7 天内发布的新作品（验证最多 10 条上限），其中第 1 条同时有抖音+快手
  for (let i = 1; i <= 12; i++) {
    const day = `2026-11-${String(14 + (i % 7)).padStart(2, "0")}`;
    const pubMs = cnMs(day, 8, 0);
    const plat = i % 2 === 1 ? "抖音" : "快手";
    intradayRows.push(
      {
        date: day,
        slot: "10:00",
        collectedAt: cnMs(day, 10, 0),
        group: "G1",
        platform: plat,
        workId: `NW_${i}`,
        title: `新作品 ${i}`,
        publishTime: pubMs,
        publishTimeMs: pubMs,
        publishDate: day,
        contentKey: `file:/v/nw_${i}.mp4`,
        play: 100 * i,
      },
      {
        date: day,
        slot: "14:00",
        collectedAt: cnMs(day, 14, 0),
        group: "G1",
        platform: plat,
        workId: `NW_${i}`,
        title: `新作品 ${i}`,
        publishTime: pubMs,
        publishTimeMs: pubMs,
        publishDate: day,
        contentKey: `file:/v/nw_${i}.mp4`,
        play: 250 * i,
      }
    );
    // 给第 1 条增加一个 > 24h 的点（应被截断排除）
    if (i === 1) {
      intradayRows.push({
        date: "2026-11-16",
        slot: "12:00",
        collectedAt: cnMs("2026-11-16", 12, 0),
        group: "G1",
        platform: plat,
        workId: "NW_1",
        title: "新作品 1",
        publishTime: pubMs,
        publishTimeMs: pubMs,
        publishDate: day,
        contentKey: "file:/v/nw_1.mp4",
        play: 99999,
      });
    }
  }
  // 8 天前发布的旧作品（2026-11-13，不在 [11-14, 11-20] 7 天窗口内，应排除）
  const oldPubMs = cnMs("2026-11-13", 8, 0);
  intradayRows.push({
    date: "2026-11-13",
    slot: "10:00",
    collectedAt: cnMs("2026-11-13", 10, 0),
    group: "G1",
    platform: "视频号",
    workId: "OLD_1",
    title: "超7天旧作品",
    publishTime: oldPubMs,
    publishTimeMs: oldPubMs,
    publishDate: "2026-11-13",
    contentKey: "file:/v/old_1.mp4",
    play: 5000,
  });

  const s9Analysis = buildStatsAnalysis({
    intradayRows,
    to: "2026-11-20",
    now: cnMs("2026-11-20", 20, 0),
  });
  assert.strictEqual(s9Analysis.newWorksFirst24h.from, "2026-11-14");
  assert.strictEqual(s9Analysis.newWorksFirst24h.to, "2026-11-20");
  assert.strictEqual(s9Analysis.newWorksFirst24h.items.length, 12, "应过滤掉超过 7 天的旧作品");
  const nw1 = s9Analysis.newWorksFirst24h.items.find((x) => x.contentKey === "file:/v/nw_1.mp4");
  assert.ok(nw1);
  assert.deepStrictEqual(
    nw1.points.map((p) => p.hours),
    [2, 6],
    "> 24h 的采集点必须排除"
  );

  const first24hOpt = buildNewWorksFirst24hOption(s9Analysis);
  assert.strictEqual(isEmptyChartOption(first24hOpt), false);
  assert.strictEqual(first24hOpt.series.length, 10, "新作品前 24 小时最多显示 10 条折线");
  assert.strictEqual(first24hOpt.xAxis.type, "value");
  assert.strictEqual(first24hOpt.xAxis.min, 0);
  assert.strictEqual(first24hOpt.xAxis.max, 24);
  for (const s of first24hOpt.series) {
    assert.strictEqual(s.itemStyle.color, PLATFORM_COLORS[s.platform], "折线颜色必须复用平台色");
    for (const pt of s.data) {
      assert.ok(pt.value[0] >= 0 && pt.value[0] <= 24);
    }
  }
  // 按平台筛选
  const dyOnly24h = buildNewWorksFirst24hOption(s9Analysis, { platform: "抖音" });
  assert.strictEqual(dyOnly24h.series.length, 6);
  assert.ok(dyOnly24h.series.every((s) => s.platform === "抖音" && s.itemStyle.color === PLATFORM_COLORS["抖音"]));
  // 空数据占位
  assert.strictEqual(isEmptyChartOption(buildNewWorksFirst24hOption({})), true);
  assert.strictEqual(
    isEmptyChartOption(buildNewWorksFirst24hOption(s9Analysis, { platform: "百家号" })),
    true
  );

  // 3. dataStats/index.vue：弹窗按天/按时段切换、1/3/7 天区间、新作品前 24 小时与设置栏风险提示
  const { compDef, template, invokeLog, cleanup } = await loadDataStatsIndexComponent();
  try {
    assert.ok(
      template.includes("采集越频繁越容易触发平台风控；部分平台作品数据本身每天才更新，分时段曲线可能是平的"),
      "设置栏在 interval 模式必须包含风控与平曲线提示"
    );
    assert.ok(template.includes("最近采集"), "作品汇总表必须含「最近采集」列");
    assert.ok(template.includes("按时段"), "趋势弹窗必须含「按天 / 按时段」切换");
    assert.ok(template.includes("新作品前 24 小时"), "数据分析必须含「新作品前 24 小时」节");
    assert.ok(template.includes("chartNewWorksFirst24h"), "应复用 StatsChart 渲染前 24 小时图");

    const ctx = createDataStatsCtx(compDef, s9Analysis);
    assert.strictEqual(isEmptyChartOption(ctx.newWorksFirst24hOption), false);
    assert.strictEqual(ctx.newWorksFirst24hOption.series.length, 10);

    await ctx.openContentTrend({ contentKey: "file:/v/nw_1.mp4", title: "新作品 1" });
    assert.strictEqual(ctx.contentTrendMode, "daily");
    assert.strictEqual(invokeLog[0].ch, "stats:get-content-trend");

    ctx.contentTrendMode = "intraday";
    await ctx.onContentTrendModeChange("intraday");
    assert.strictEqual(invokeLog[1].ch, "stats:get-content-intraday");
    assert.strictEqual(invokeLog[1].payload.contentKey, "file:/v/nw_1.mp4");
    assert.strictEqual(invokeLog[1].payload.days, 3);

    ctx.contentIntradayDays = 7;
    await ctx.loadContentIntraday();
    assert.strictEqual(invokeLog[2].ch, "stats:get-content-intraday");
    assert.strictEqual(invokeLog[2].payload.days, 7);
  } finally {
    cleanup();
  }
  console.log("✓ [S9] 分时段趋势 option、新作品前 24 小时 option 与 dataStats/index.vue 联动通过");

  // 4. testS9Fix6And7_IntradayOptionOrderAndFirst24hStartAndCutoff
  // 评审 #6/#7 图表层回归：按实际 collectedAt 排序出图（+50 非 -50）、首发用归一化 firstPublishTimeMs（>24h 不画）、按 collectedAt 校验分析截止日
  {
    const cnMs2 = (d, hh, mm = 0) =>
      Date.parse(`${d}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`);

    // #6：10:30 自动槽 @ 10:31 (100) + 10:00 手动槽 @ 10:40 (150) → 图表折线 [100, 150]、增量柱 [null, 50]
    const sortDeps = {
      now: cnMs2("2026-11-20", 12, 0),
      listAccounts: () => [{ group: "G1", platform: "抖音" }],
      readWorks: () => [{ workId: "W_C6", title: "短片", publishTime: cnMs2("2026-11-20", 8, 0) }],
      readWorksDaily: () => ({ W_C6: { "2026-11-20": { play: 150 } } }),
      readWorksIntraday: () => ({
        W_C6: [
          { date: "2026-11-20", slot: "10:00", collectedAt: cnMs2("2026-11-20", 10, 40), play: 150 },
          { date: "2026-11-20", slot: "10:30", collectedAt: cnMs2("2026-11-20", 10, 31), play: 100 },
        ],
      }),
      readDaily: () => ({}),
      readPushRecords: () => [],
    };
    const { buildContentIntradayData } = require("../src/main/services/dataStats/statsExport.js");
    const intra6 = buildContentIntradayData({ contentKey: "unlinked:抖音:W_C6" }, sortDeps);
    const opt6 = buildContentIntradayOption(intra6);
    assert.deepStrictEqual(opt6.xAxis.data, ["2026-11-20 10:30", "2026-11-20 10:00"]);
    assert.deepStrictEqual(opt6.series[0].data, [100, 150]);
    assert.deepStrictEqual(opt6.series[1].data, [null, 50]);

    // #7a：归一化 firstPublishTimeMs（11-19 08:00 首发，11-20 10:00 补发，11-20 12:00 采集距首发 28h）→ 超过 24h 不画
    const firstPub = cnMs2("2026-11-19", 8, 0);
    const repostPub = cnMs2("2026-11-20", 10, 0);
    const analysis7a = buildStatsAnalysis({
      summaryRows: [
        {
          contentKey: "file:/v/repost.mp4",
          title: "补发测试",
          firstPublishDate: "2026-11-19",
          firstPublishTime: firstPub,
          perPlatform: {
            "抖音|G1": { play: 100, workIds: ["DY_19"] },
            "快手|G1": { play: 250, workIds: ["KS_20"] },
          },
          totalPlay: 350,
        },
      ],
      dailyRows: [
        {
          date: "2026-11-19",
          group: "G1",
          platform: "抖音",
          workId: "DY_19",
          title: "补发测试",
          publishTime: firstPub,
          contentKey: "file:/v/repost.mp4",
          play: 100,
        },
      ],
      intradayRows: [
        {
          date: "2026-11-20",
          slot: "12:00",
          collectedAt: cnMs2("2026-11-20", 12, 0),
          group: "G1",
          platform: "快手",
          workId: "KS_20",
          title: "补发测试",
          publishTime: repostPub,
          publishTimeMs: repostPub,
          publishDate: "2026-11-20",
          contentKey: "file:/v/repost.mp4",
          play: 250,
        },
      ],
      to: "2026-11-20",
      now: cnMs2("2026-11-20", 12, 0),
    });
    assert.strictEqual(analysis7a.newWorksFirst24h.items.length, 0, "距最早首发 28h 超过 24h 不得产出曲线");
    assert.strictEqual(isEmptyChartOption(buildNewWorksFirst24hOption(analysis7a)), true);

    // #7b：23:00-05:00 跨零点，11-21 00:05 采集归入 11-20 23:00 槽，分析截止日 11-20 时不得纳入该点
    const pub20 = cnMs2("2026-11-20", 22, 0);
    const analysis7b = buildStatsAnalysis({
      intradayRows: [
        {
          date: "2026-11-20",
          slot: "23:00",
          collectedAt: cnMs2("2026-11-21", 0, 5),
          group: "G1",
          platform: "抖音",
          workId: "CROSS_23",
          title: "跨零点截止测试",
          publishTime: pub20,
          publishTimeMs: pub20,
          publishDate: "2026-11-20",
          contentKey: "file:/v/cross23.mp4",
          play: 300,
        },
      ],
      to: "2026-11-20",
      now: cnMs2("2026-11-21", 10, 0),
    });
    assert.strictEqual(analysis7b.newWorksFirst24h.items.length, 0, "collectedAt 在 11-21 的点不得出现在截止日 11-20 分析中");
    assert.strictEqual(isEmptyChartOption(buildNewWorksFirst24hOption(analysis7b)), true);

    const analysis7bNext = buildStatsAnalysis({
      intradayRows: [
        {
          date: "2026-11-20",
          slot: "23:00",
          collectedAt: cnMs2("2026-11-21", 0, 5),
          group: "G1",
          platform: "抖音",
          workId: "CROSS_23",
          title: "跨零点截止测试",
          publishTime: pub20,
          publishTimeMs: pub20,
          publishDate: "2026-11-20",
          contentKey: "file:/v/cross23.mp4",
          play: 300,
        },
      ],
      to: "2026-11-21",
      now: cnMs2("2026-11-21", 10, 0),
    });
    assert.strictEqual(analysis7bNext.newWorksFirst24h.items.length, 1);
    assert.strictEqual(analysis7bNext.newWorksFirst24h.items[0].points[0].hours, 2.08);
    assert.strictEqual(isEmptyChartOption(buildNewWorksFirst24hOption(analysis7bNext)), false);
    console.log("✓ [S9-fix #6/#7] testS9Fix6And7_IntradayOptionOrderAndFirst24hStartAndCutoff 通过");
  }
}

async function runS8FixRegressions(analysis) {
  testFix1_ContentTrendCumulativeSumAcrossSamePlatformWorks();
  await testFix2_StatsChartPendingOptionWhenHiddenAppliesBeforeResize(analysis);
  await testFix3_BatchExportCreatesIsolatedTimestampedSubdir();
  await testFix4_RankingBottom10SharesDataAndSyncsTitleExportName(analysis);
  testFix5_IsolatedValidPointsKeepSymbolOnLongRange();
  testFix6_OverviewPieUsesBackendSharePctAndDisablesLegendToggle();
  await testFix7_StackedAreaRecomputesMarkPointsOnLegendSelectChanged();
  testFix8_EngagementRankingStacksRawContribAndRoundsOnDisplay();
  await testFix9_SaveChartImageUsesOwnCutoffDate(analysis);
  await testS9_IntradayAndFirst24hCharts();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
