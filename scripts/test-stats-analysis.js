/**
 * S7 纯规则数据分析（statsAnalysis.js）、IPC（stats:get-analysis）
 * 与 GUI「数据分析」tab（dataStats/index.vue）单元测试（不依赖 Electron 运行环境）：
 *
 * 1. 3 平台 × 12 内容 × 30 天数据集，逐节断言第 1–7 节全部计算结果
 * 2. 环比上期为 0 或无数据 → null（绝不出现 Infinity / NaN）
 * 3. 平台对比互动率：播放为 0 或空不计入；样本 <3 注明「样本少，仅供参考」
 * 4. 作品排行（总播放 / 互动率[总播放>=100] / 总涨粉 Top10 & Bottom10）与偏科边界（3 倍且 >=500）
 * 5. 新作品走势 D1/D3/D7 取值（缺天取 ≤ 该天最近一次、异常点剔除回退、未到期为空）与 4 类分类边界
 * 6. 发布时间分组与 UTC+8 跨零点边界（0-6 / 6-12 / 12-18 / 18-24）、不足 7 天回退标注与样本少标注
 * 7. 掉 0 / 缺失后回升异常识别与剔除后日增重算；疑似上推荐识别（≥前7天日均×5 且 ≥1000）及双阈值边界
 * 8. 文字小结关键句验证（5–8 行）与 13 天（有提示）vs 14 天（无提示）
 * 9. 确定性（乱序输入多次执行输出完全一致）
 * 10. IPC stats:get-analysis 本地页面校验、参数校验、与 Excel 共享默认截止日与同结果 + Vue 模板/方法校验
 *
 * 运行：yarn test:stats-analysis
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

const {
  ENGAGEMENT_MIN_PLAY,
  RANKING_LIMIT,
  PLATFORM_SKEW_RATIO,
  PLATFORM_SKEW_MIN_PLAY,
  LONG_TAIL_D7_D3_RATIO,
  BURST_FLAT_D3_D1_RATIO,
  BURST_FLAT_D7_D3_RATIO,
  RECOMMEND_BASELINE_DAYS,
  RECOMMEND_SPIKE_MULTIPLIER,
  RECOMMEND_SPIKE_MIN_PLAY_DELTA,
  MIN_ACCUMULATED_DAYS_NOTICE,
  LOW_HISTORY_NOTICE_TEXT,
  ANALYSIS_THRESHOLDS,
  classifyTrajectory,
  buildStatsAnalysis,
} = require("../src/main/services/dataStats/statsAnalysis.js");

const {
  buildStatsAnalysisData,
  buildStatsWorkbookData,
} = require("../src/main/services/dataStats/statsExport.js");

const DAY_MS = 86400000;

function shiftDate(ymd, deltaDays) {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/** 构造 UTC+8 给定日期与小时分钟的 ISO 字符串 */
function utc8Iso(ymd, hour = 10, minute = 0, second = 0) {
  const baseMs = Date.parse(`${ymd}T00:00:00Z`);
  const utcMs = baseMs + (hour - 8) * 3600e3 + minute * 60e3 + second * 1000;
  return new Date(utcMs).toISOString();
}

/**
 * 构造 3 平台（抖音 / 视频号 / 快手）、12 条内容、30 天（2026-11-01 ~ 2026-11-30）完整测试数据。
 */
function buildRich30DayDataset() {
  const startDate = "2026-11-01";
  const to = "2026-11-30";
  const dailyRows = [];
  const summaryRows = [];
  const accountRows = [];

  // 辅助函数：向 dailyRows 添加连续（或指定日期）的累计序列，并记录截至 to 的最新累计值
  function addWorkTimeline({
    contentKey,
    title,
    platform,
    group = "主组",
    workId,
    publishTime,
    points, // Array<{ date, play, like, comment, share, favorite, fansDelta }>
    url = "",
  }) {
    for (const pt of points) {
      dailyRows.push({
        date: pt.date,
        group,
        platform,
        workId,
        title,
        url: url || `https://example.com/${platform}/${workId}`,
        publishTime,
        play: pt.play,
        like: pt.like,
        comment: pt.comment,
        share: pt.share,
        favorite: pt.favorite,
        fansDelta: pt.fansDelta,
        contentKey,
        matchedBy: contentKey ? "link" : null,
        matchScore: null,
      });
    }
    return points[points.length - 1];
  }

  function makeLinearPoints(fromYmd, toYmd, base, step, overridesByDate = {}) {
    const pts = [];
    let d = fromYmd;
    let idx = 0;
    while (d <= toYmd) {
      const ov = overridesByDate[d] || {};
      const val = (k) => {
        if (Object.prototype.hasOwnProperty.call(ov, k)) return ov[k];
        if (base[k] === null || base[k] === undefined) return null;
        return base[k] + (step[k] || 0) * idx;
      };
      pts.push({
        date: d,
        play: val("play"),
        like: val("like"),
        comment: val("comment"),
        share: val("share"),
        favorite: val("favorite"),
        fansDelta: val("fansDelta"),
      });
      d = shiftDate(d, 1);
      idx += 1;
    }
    return pts;
  }

  function pushSummaryRow({ contentKey, title, firstPublishDate, perPlatformMap, isUnlinked = false }) {
    const keys = ["play", "like", "comment", "share", "favorite", "fansDelta"];
    const totalKeys = {
      play: "totalPlay",
      like: "totalLike",
      comment: "totalComment",
      share: "totalShare",
      favorite: "totalFavorite",
      fansDelta: "totalFansDelta",
    };
    const row = {
      contentKey,
      title,
      file: isUnlinked ? "" : `/videos/${contentKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp4`,
      firstPublishDate,
      platformCount: Object.keys(perPlatformMap).length,
      isUnlinked,
      perPlatform: {},
    };
    for (const k of keys) row[totalKeys[k]] = null;
    for (const [pt, snap] of Object.entries(perPlatformMap)) {
      row.perPlatform[`${pt}|主组`] = {
        play: snap.play,
        like: snap.like,
        comment: snap.comment,
        share: snap.share,
        favorite: snap.favorite,
        fansDelta: snap.fansDelta,
        workIds: [snap.workId],
      };
      for (const k of keys) {
        if (snap[k] !== null && snap[k] !== undefined) {
          row[totalKeys[k]] = row[totalKeys[k]] === null ? snap[k] : row[totalKeys[k]] + snap[k];
        }
      }
    }
    summaryRows.push(row);
  }

  // C01（3 平台，11-01 20:00 周日 18-24 发布）：抖音在 11-26 故意掉 0，11-27 恢复！
  // 抖音：每天 +100 play（11-01=1000 → 11-25=3400, 11-26=0[异常!], 11-27=3600[剔除后日增=200], 11-30=3900）
  // 视频号：播放低于抖音，但互动率最高（15%）
  // 快手：无 share/favorite/fansDelta
  {
    const ck = "file:/v/c01.mp4";
    const pub = utc8Iso("2026-11-01", 20, 0);
    const dyPts = makeLinearPoints(
      startDate,
      to,
      { play: 1000, like: 30, comment: 5, share: 5, favorite: 10, fansDelta: 5 },
      { play: 100, like: 3, comment: 1, share: 1, favorite: 1, fansDelta: 1 },
      { "2026-11-26": { play: 0 } }
    );
    const sphPts = makeLinearPoints(
      startDate,
      to,
      { play: 500, like: 60, comment: 10, share: 5, favorite: 12, fansDelta: 10 },
      { play: 50, like: 6, comment: 1, share: 1, favorite: 1, fansDelta: 2 }
    );
    const ksPts = makeLinearPoints(
      startDate,
      to,
      { play: 600, like: 20, comment: 4, share: null, favorite: null, fansDelta: null },
      { play: 40, like: 2, comment: 0, share: null, favorite: null, fansDelta: null }
    );
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容01-红烧肉", platform: "抖音", workId: "C01_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容01-红烧肉", platform: "视频号", workId: "C01_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容01-红烧肉", platform: "快手", workId: "C01_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容01-红烧肉",
      firstPublishDate: "2026-11-01",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C01_DY" },
        视频号: { ...sphLast, workId: "C01_SPH" },
        快手: { ...ksLast, workId: "C01_KS" },
      },
    });
  }

  // C02（3 平台，11-08 20:00 周日 18-24 发布）：抖音在 11-28 爆发上推荐（前7天日均=100，当日+1200 >= 500 且 >= 1000）
  // 视频号当日 +800（虽 >= 前7天日均50×5=250，但 < 1000 不触发）；快手当日 +1200（虽 >= 1000，但 < 前7天日均300×5=1500 不触发）
  {
    const ck = "file:/v/c02.mp4";
    const pub = utc8Iso("2026-11-08", 20, 0);
    const dyPts = [];
    const sphPts = [];
    const ksPts = [];
    let dyPlay = 1000;
    let sphPlay = 500;
    let ksPlay = 1000;
    let d = "2026-11-08";
    let idx = 0;
    while (d <= to) {
      if (idx > 0) {
        dyPlay += d === "2026-11-28" ? 1200 : 100;
        sphPlay += d === "2026-11-28" ? 800 : 50;
        ksPlay += d === "2026-11-28" ? 1200 : 300;
      }
      dyPts.push({ date: d, play: dyPlay, like: 40 + idx * 2, comment: 6, share: 4, favorite: 8, fansDelta: 4 + idx });
      sphPts.push({ date: d, play: sphPlay, like: 120 + idx * 10, comment: 20, share: 15, favorite: 20, fansDelta: 8 + idx * 2 });
      ksPts.push({ date: d, play: ksPlay, like: 30 + idx * 3, comment: 5, share: null, favorite: null, fansDelta: null });
      d = shiftDate(d, 1);
      idx += 1;
    }
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容02-爆款推荐", platform: "抖音", workId: "C02_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容02-爆款推荐", platform: "视频号", workId: "C02_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容02-爆款推荐", platform: "快手", workId: "C02_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容02-爆款推荐",
      firstPublishDate: "2026-11-08",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C02_DY" },
        视频号: { ...sphLast, workId: "C02_SPH" },
        快手: { ...ksLast, workId: "C02_KS" },
      },
    });
  }

  // C03（3 平台，11-15 20:00 周日 18-24 发布 → 周日 18-24 满 3 样本！）：明显抖音偏科（3000 vs (600+400)/2=500 → 6x >= 3x 且 >= 500）
  {
    const ck = "file:/v/c03.mp4";
    const pub = utc8Iso("2026-11-15", 20, 0);
    const dyPts = makeLinearPoints("2026-11-15", to, { play: 1500, like: 45, comment: 10, share: 5, favorite: 15, fansDelta: 12 }, { play: 100, like: 2, comment: 0, share: 0, favorite: 0, fansDelta: 1 });
    const sphPts = makeLinearPoints("2026-11-15", to, { play: 300, like: 40, comment: 8, share: 4, favorite: 10, fansDelta: 6 }, { play: 20, like: 2, comment: 0, share: 0, favorite: 0, fansDelta: 1 });
    const ksPts = makeLinearPoints("2026-11-15", to, { play: 250, like: 10, comment: 2, share: null, favorite: null, fansDelta: null }, { play: 10, like: 0, comment: 0, share: null, favorite: null, fansDelta: null });
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容03-抖音偏科", platform: "抖音", workId: "C03_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容03-抖音偏科", platform: "视频号", workId: "C03_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容03-抖音偏科", platform: "快手", workId: "C03_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容03-抖音偏科",
      firstPublishDate: "2026-11-15",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C03_DY" },
        视频号: { ...sphLast, workId: "C03_SPH" },
        快手: { ...ksLast, workId: "C03_KS" },
      },
    });
  }

  // C04（3 平台，11-10 09:00 周二 6-12 发布）：偏科恰好边界（抖音=1500, 视频号=500, 快手=500 → ratio=3.0 触发）
  {
    const ck = "file:/v/c04.mp4";
    const pub = utc8Iso("2026-11-10", 9, 0);
    const dyPts = makeLinearPoints("2026-11-10", to, { play: 1500, like: 30, comment: 5, share: 5, favorite: 5, fansDelta: 3 }, { play: 0 });
    const sphPts = makeLinearPoints("2026-11-10", to, { play: 500, like: 50, comment: 10, share: 5, favorite: 8, fansDelta: 5 }, { play: 0 });
    const ksPts = makeLinearPoints("2026-11-10", to, { play: 500, like: 15, comment: 2, share: null, favorite: null, fansDelta: null }, { play: 0 });
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容04-偏科边界恰好3倍", platform: "抖音", workId: "C04_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容04-偏科边界恰好3倍", platform: "视频号", workId: "C04_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容04-偏科边界恰好3倍", platform: "快手", workId: "C04_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容04-偏科边界恰好3倍",
      firstPublishDate: "2026-11-10",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C04_DY" },
        视频号: { ...sphLast, workId: "C04_SPH" },
        快手: { ...ksLast, workId: "C04_KS" },
      },
    });
  }

  // C05（3 平台，11-12 14:00 周四 12-18 发布）：偏科不触发（抖音 450 < 500 门槛，虽 4.5 倍）
  {
    const ck = "file:/v/c05.mp4";
    const pub = utc8Iso("2026-11-12", 14, 0);
    const dyPts = makeLinearPoints("2026-11-12", to, { play: 450, like: 10, comment: 2, share: 1, favorite: 2, fansDelta: 1 }, { play: 0 });
    const sphPts = makeLinearPoints("2026-11-12", to, { play: 100, like: 15, comment: 3, share: 2, favorite: 3, fansDelta: 2 }, { play: 0 });
    const ksPts = makeLinearPoints("2026-11-12", to, { play: 100, like: 5, comment: 1, share: null, favorite: null, fansDelta: null }, { play: 0 });
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容05-播放不足500不偏科", platform: "抖音", workId: "C05_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容05-播放不足500不偏科", platform: "视频号", workId: "C05_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容05-播放不足500不偏科", platform: "快手", workId: "C05_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容05-播放不足500不偏科",
      firstPublishDate: "2026-11-12",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C05_DY" },
        视频号: { ...sphLast, workId: "C05_SPH" },
        快手: { ...ksLast, workId: "C05_KS" },
      },
    });
  }

  // C06（3 平台，11-13 02:00 周五 0-6 发布）：偏科不触发（抖音 1499 vs 500 → 2.998x < 3x）
  {
    const ck = "file:/v/c06.mp4";
    const pub = utc8Iso("2026-11-13", 2, 0);
    const dyPts = makeLinearPoints("2026-11-13", to, { play: 1499, like: 25, comment: 4, share: 3, favorite: 5, fansDelta: 4 }, { play: 0 });
    const sphPts = makeLinearPoints("2026-11-13", to, { play: 500, like: 45, comment: 8, share: 5, favorite: 8, fansDelta: 6 }, { play: 0 });
    const ksPts = makeLinearPoints("2026-11-13", to, { play: 500, like: 12, comment: 2, share: null, favorite: null, fansDelta: null }, { play: 0 });
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容06-2.998倍不偏科", platform: "抖音", workId: "C06_DY", publishTime: pub, points: dyPts });
    const sphLast = addWorkTimeline({ contentKey: ck, title: "内容06-2.998倍不偏科", platform: "视频号", workId: "C06_SPH", publishTime: pub, points: sphPts });
    const ksLast = addWorkTimeline({ contentKey: ck, title: "内容06-2.998倍不偏科", platform: "快手", workId: "C06_KS", publishTime: pub, points: ksPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容06-2.998倍不偏科",
      firstPublishDate: "2026-11-13",
      perPlatformMap: {
        抖音: { ...dyLast, workId: "C06_DY" },
        视频号: { ...sphLast, workId: "C06_SPH" },
        快手: { ...ksLast, workId: "C06_KS" },
      },
    });
  }

  // C07（11-20 发布，长尾型边界：D1=100, D3=200, D7=300 → D7/D3 = 1.5）
  {
    const ck = "file:/v/c07.mp4";
    const pub = utc8Iso("2026-11-20", 19, 0);
    const dyPts = [
      { date: "2026-11-21", play: 100, like: 5, comment: 1, share: 1, favorite: 2, fansDelta: 1 },
      { date: "2026-11-23", play: 200, like: 10, comment: 2, share: 2, favorite: 3, fansDelta: 2 },
      { date: "2026-11-27", play: 300, like: 18, comment: 4, share: 3, favorite: 5, fansDelta: 3 },
      { date: "2026-11-30", play: 360, like: 22, comment: 4, share: 3, favorite: 6, fansDelta: 4 },
    ];
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容07-长尾边界1.5", platform: "抖音", workId: "C07_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容07-长尾边界1.5",
      firstPublishDate: "2026-11-20",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C07_DY" } },
    });
  }

  // C08（11-20 发布，爆发后平稳：D1=1000, D3=1200[1.2<1.3], D7=1300[1.08<1.1]）
  {
    const ck = "file:/v/c08.mp4";
    const pub = utc8Iso("2026-11-20", 19, 30);
    const dyPts = [
      { date: "2026-11-21", play: 1000, like: 30, comment: 3, share: 2, favorite: 4, fansDelta: 5 },
      { date: "2026-11-23", play: 1200, like: 36, comment: 4, share: 2, favorite: 5, fansDelta: 6 },
      { date: "2026-11-27", play: 1300, like: 39, comment: 4, share: 3, favorite: 5, fansDelta: 6 },
      { date: "2026-11-30", play: 1320, like: 40, comment: 4, share: 3, favorite: 5, fansDelta: 6 },
    ];
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容08-爆发后平稳", platform: "抖音", workId: "C08_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容08-爆发后平稳",
      firstPublishDate: "2026-11-20",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C08_DY" } },
    });
  }

  // C09（11-20 发布，其它边界：D1=1000, D3=1300[=1.3 不<1.3], D7=1430[=1.1 不<1.1 且 <1.5]）
  {
    const ck = "file:/v/c09.mp4";
    const pub = utc8Iso("2026-11-20", 10, 0);
    const dyPts = [
      { date: "2026-11-21", play: 1000, like: 20, comment: 2, share: 1, favorite: 2, fansDelta: 2 },
      { date: "2026-11-23", play: 1300, like: 26, comment: 3, share: 1, favorite: 3, fansDelta: 3 },
      { date: "2026-11-27", play: 1430, like: 28, comment: 3, share: 2, favorite: 3, fansDelta: 3 },
      { date: "2026-11-30", play: 1450, like: 29, comment: 3, share: 2, favorite: 3, fansDelta: 3 },
    ];
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容09-其它边界", platform: "抖音", workId: "C09_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容09-其它边界",
      firstPublishDate: "2026-11-20",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C09_DY" } },
    });
  }

  // C10（11-26 发布，D1=11-27 有值，D3=11-29 缺当天取 11-28 最近一次！D7=12-03 未到期为空 → 数据不足）
  {
    const ck = "file:/v/c10.mp4";
    const pub = utc8Iso("2026-11-26", 15, 0);
    const dyPts = [
      { date: "2026-11-27", play: 200, like: 10, comment: 1, share: 1, favorite: 2, fansDelta: 2 },
      { date: "2026-11-28", play: 350, like: 18, comment: 2, share: 2, favorite: 3, fansDelta: 3 },
      // 故意跳过 11-29，验证 D3 取 <= 11-29 的最近一次快照 11-28 (350)
      { date: "2026-11-30", play: 480, like: 24, comment: 3, share: 2, favorite: 4, fansDelta: 4 },
    ];
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容10-未到D7且缺D3快照", platform: "抖音", workId: "C10_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容10-未到D7且缺D3快照",
      firstPublishDate: "2026-11-26",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C10_DY" } },
    });
  }

  // C11（11-29 发布，D1=11-30 有值，D3=12-02 与 D7=12-06 均未到期 → 空）
  {
    const ck = "file:/v/c11.mp4";
    const pub = utc8Iso("2026-11-29", 21, 0);
    const dyPts = [
      { date: "2026-11-30", play: 180, like: 9, comment: 1, share: 0, favorite: 1, fansDelta: 1 },
    ];
    const dyLast = addWorkTimeline({ contentKey: ck, title: "内容11-刚发布仅到D1", platform: "抖音", workId: "C11_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容11-刚发布仅到D1",
      firstPublishDate: "2026-11-29",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C11_DY" } },
    });
  }

  // C12（单平台低播放=80 < 100，高点赞=40，验证不参与互动率排行！）
  {
    const ck = "unlinked:抖音:C12_DY";
    const pub = utc8Iso("2026-11-18", 8, 0);
    const dyPts = makeLinearPoints("2026-11-18", to, { play: 80, like: 40, comment: 10, share: 5, favorite: 5, fansDelta: 0 }, { play: 0 });
    const dyLast = addWorkTimeline({ contentKey: null, title: "内容12-低播放不入互动榜", platform: "抖音", workId: "C12_DY", publishTime: pub, points: dyPts });
    pushSummaryRow({
      contentKey: ck,
      title: "内容12-低播放不入互动榜",
      firstPublishDate: "2026-11-18",
      perPlatformMap: { 抖音: { ...dyLast, workId: "C12_DY" } },
      isUnlinked: true,
    });
  }

  // 账号日快照（30 天）
  let d = startDate;
  let dayIdx = 0;
  while (d <= to) {
    accountRows.push({
      date: d,
      platform: "抖音",
      group: "主组",
      fans: 1000 + dayIdx * 10,
      plays: 10000 + dayIdx * 500,
      fansDelta: dayIdx === 0 ? null : 10,
      playsDelta: dayIdx === 0 ? null : 500,
    });
    d = shiftDate(d, 1);
    dayIdx += 1;
  }

  return { dailyRows, summaryRows, accountRows, to };
}

async function main() {
  /* ---------- 0. 导出常量校验 ---------- */
  assert.strictEqual(ENGAGEMENT_MIN_PLAY, 100);
  assert.strictEqual(RANKING_LIMIT, 10);
  assert.strictEqual(PLATFORM_SKEW_RATIO, 3);
  assert.strictEqual(PLATFORM_SKEW_MIN_PLAY, 500);
  assert.strictEqual(LONG_TAIL_D7_D3_RATIO, 1.5);
  assert.strictEqual(BURST_FLAT_D3_D1_RATIO, 1.3);
  assert.strictEqual(BURST_FLAT_D7_D3_RATIO, 1.1);
  assert.strictEqual(RECOMMEND_BASELINE_DAYS, 7);
  assert.strictEqual(RECOMMEND_SPIKE_MULTIPLIER, 5);
  assert.strictEqual(RECOMMEND_SPIKE_MIN_PLAY_DELTA, 1000);
  assert.strictEqual(MIN_ACCUMULATED_DAYS_NOTICE, 14);
  assert.strictEqual(ANALYSIS_THRESHOLDS.platformSkewRatio, 3);
  assert.strictEqual(ANALYSIS_THRESHOLDS.recommendSpikeMinPlayDelta, 1000);
  console.log("✓ 分析阈值导出常量校验通过");

  /* ---------- 1. 3 平台 × 12 内容 × 30 天全量 7 节验证 ---------- */
  const dataset = buildRich30DayDataset();
  const res7 = buildStatsAnalysis({
    ...dataset,
    period: 7,
    now: Date.parse("2026-11-30T06:00:00Z"),
  });
  const res30 = buildStatsAnalysis({
    ...dataset,
    period: 30,
    now: Date.parse("2026-11-30T06:00:00Z"),
  });

  // 日期范围与积累天数
  assert.strictEqual(res7.to, "2026-11-30");
  assert.deepStrictEqual(res7.currentRange, { from: "2026-11-24", to: "2026-11-30" });
  assert.deepStrictEqual(res7.previousRange, { from: "2026-11-17", to: "2026-11-23" });
  assert.strictEqual(res7.snapshotDays, 30);

  // 第 1 节：总览（含 11-26 掉 0 剔除后的精准日增！）
  // 核算 res7 (11-24 ~ 11-30) 本周期播放日增：
  // - C01_DY：11-24(+100), 11-25(+100), 11-26(掉0剔除!), 11-27(3600-3400=+200), 11-28..30(+300) = 700
  // - C01_SPH：7×50 = 350；C01_KS：7×40 = 280
  // - C02_DY：6×100 + 1200(11-28) = 1800；C02_SPH：6×50 + 800 = 1100；C02_KS：6×300 + 1200 = 3000
  // - C03_DY：7×100 = 700；C03_SPH：7×20 = 140；C03_KS：7×10 = 70
  // - C04..C06, C12：均为 0
  // - C07_DY：11-27(+100), 11-30(+60) = 160
  // - C08_DY：11-27(+100), 11-30(+20) = 120
  // - C09_DY：11-27(+130), 11-30(+20) = 150
  // - C10_DY：11-28(+150), 11-30(+130) = 280
  // - C11_DY：首次快照 11-30 delta=null
  // 合计：DY(700+1800+700+160+120+150+280=3910) + SPH(350+1100+140=1590) + KS(280+3000+70=3350) = 8850
  assert.strictEqual(
    res7.overview.metrics.play.current,
    8850,
    "掉 0 异常剔除重算后，近 7 天总播放日增应精确为 8850"
  );
  // 上周期（11-17 ~ 11-23）播放日增：
  // C01(700+350+280=1330) + C02(700+350+2100=3150) + C03(700+140+70=910) + C07(11-23:+100) + C08(11-23:+200) + C09(11-23:+300) = 5990
  assert.strictEqual(res7.overview.metrics.play.previous, 5990);
  const expectedMom = Math.round(((8850 - 5990) / 5990) * 100 * 100) / 100;
  assert.strictEqual(res7.overview.metrics.play.momPct, expectedMom);
  assert.strictEqual(res7.overview.platformContribution.length, 3);
  assert.strictEqual(res7.overview.platformContribution[0].platform, "抖音");
  assert.strictEqual(res7.overview.platformContribution[0].play, 3910);
  assert.strictEqual(
    res7.overview.platformContribution[0].sharePct,
    Math.round((3910 / 8850) * 100 * 100) / 100
  );

  // 第 2 节：平台对比（仅覆盖 >=2 平台的 C01..C06 共 6 条，排除单平台 C07..C12）
  assert.strictEqual(res30.platformComparison.multiPlatformContentCount, 6);
  assert.strictEqual(res30.platformComparison.lowSample, false);
  assert.strictEqual(res30.platformComparison.platforms.length, 3);
  const cmpDy = res30.platformComparison.platforms.find((p) => p.platform === "抖音");
  const cmpSph = res30.platformComparison.platforms.find((p) => p.platform === "视频号");
  const cmpKs = res30.platformComparison.platforms.find((p) => p.platform === "快手");
  assert.strictEqual(cmpDy.sampleCount, 6);
  assert.strictEqual(cmpSph.sampleCount, 6);
  assert.strictEqual(cmpKs.sampleCount, 6);
  assert.ok(cmpDy.avgPlay > cmpSph.avgPlay, "抖音均播应高于视频号");
  assert.ok(cmpSph.engagementRate > cmpDy.engagementRate, "视频号互动率应高于抖音");
  assert.strictEqual(cmpKs.avgFansDelta, null, "快手无单作品涨粉应为 null");
  assert.ok(
    res30.platformComparison.conclusions.length >= 1 &&
      res30.platformComparison.conclusions.length <= 3,
    "平台对比结论应为 1–3 句"
  );
  assert.ok(
    res30.platformComparison.conclusions[0].includes("视频号") &&
      res30.platformComparison.conclusions[0].includes("互动率最高"),
    `结论首句应指出视频号互动率最高，实际：${res30.platformComparison.conclusions[0]}`
  );

  // 第 3 节：作品排行与平台偏科
  assert.strictEqual(res30.rankings.byPlay.top.length, 10, "总播放 Top10 应截断为 10 条");
  assert.strictEqual(res30.rankings.byPlay.bottom.length, 10, "总播放 Bottom10 应截断为 10 条");
  assert.strictEqual(
    res30.rankings.byPlay.bottom[0].contentKey,
    "unlinked:抖音:C12_DY",
    "播放最低应为 80 的 C12"
  );
  assert.strictEqual(
    res30.rankings.byEngagement.eligibleCount,
    11,
    "12 条中 C12 总播放 80 < 100 应被排除，仅 11 条参与互动率排行"
  );
  assert.strictEqual(
    res30.rankings.byEngagement.top.some((r) => r.contentKey === "unlinked:抖音:C12_DY"),
    false,
    "总播放 < 100 的内容绝不能出现在互动率榜单"
  );
  // 平台偏科：仅 C03（6x）与 C04（3x）命中；C05（450<500）与 C06（2.998x<3）不命中
  const skewKeys = res30.rankings.platformSkew.map((s) => `${s.contentKey}|${s.platform}`);
  assert.deepStrictEqual(skewKeys, ["file:/v/c03.mp4|抖音", "file:/v/c04.mp4|抖音"]);
  assert.strictEqual(res30.rankings.platformSkew[0].ratio, 6);
  assert.strictEqual(res30.rankings.platformSkew[1].ratio, 3);

  // 第 4 节：新作品走势（近 30 天含全部 12 条发布，重点核验 C07..C11）
  const nwByKey = new Map(res30.newWorks.items.map((x) => [x.contentKey, x]));
  assert.strictEqual(nwByKey.get("file:/v/c07.mp4").category, "长尾型");
  assert.strictEqual(nwByKey.get("file:/v/c07.mp4").d7ToD3, 1.5);
  assert.strictEqual(nwByKey.get("file:/v/c08.mp4").category, "爆发后平稳");
  assert.strictEqual(nwByKey.get("file:/v/c09.mp4").category, "其它");
  // C10（11-26 发布）：D1=11-27(200), D3=11-29 缺当天取 11-28(350), D7=12-03 未到期(null)
  const nwC10 = nwByKey.get("file:/v/c10.mp4");
  assert.strictEqual(nwC10.d1Play, 200);
  assert.strictEqual(nwC10.d3Play, 350, "D3 无当天快照应取 <= D3 最近一次快照");
  assert.strictEqual(nwC10.d7Play, null, "未到 D7 必须为空");
  assert.strictEqual(nwC10.category, "数据不足");
  // C11（11-29 发布）：D1=11-30(180), D3=null, D7=null
  const nwC11 = nwByKey.get("file:/v/c11.mp4");
  assert.strictEqual(nwC11.d1Play, 180);
  assert.strictEqual(nwC11.d3Play, null);
  assert.strictEqual(nwC11.d7Play, null);
  assert.strictEqual(nwC11.category, "数据不足");

  // 第 5 节：发布时间（周日 18-24 有 C01, C02, C03, C11[不足7天] = 4 条 >= 3 不标样本少，但标含不足7天最新累计）
  const sunEve = res30.publishTime.groups.find(
    (g) => g.weekdayLabel === "周日" && g.slot === "18-24"
  );
  assert.ok(sunEve, "应有周日 18-24 分组");
  assert.strictEqual(sunEve.sampleCount, 4);
  assert.strictEqual(sunEve.lowSample, false, "样本数 4 >= 3 不应标样本少");
  assert.strictEqual(sunEve.fallbackCount, 1, "C11 发布不足 7 天应计为 1 条回退样本");
  assert.strictEqual(sunEve.hasFallback, true);
  assert.ok(sunEve.note.includes("不足7天"), "不足 7 天组应有标注");
  const tueMorn = res30.publishTime.groups.find(
    (g) => g.weekdayLabel === "周二" && g.slot === "6-12"
  );
  assert.ok(tueMorn && tueMorn.sampleCount === 1 && tueMorn.lowSample === true);
  assert.ok(tueMorn.note.includes("样本少"));

  // 第 6 节：异常提醒（C01_DY 11-26 掉 0 采集异常 + C02_DY 11-28 上推荐）
  assert.strictEqual(res7.anomalies.collectionAnomalies.length, 1);
  const colAnom = res7.anomalies.collectionAnomalies[0];
  assert.strictEqual(colAnom.workId, "C01_DY");
  assert.strictEqual(colAnom.date, "2026-11-26");
  assert.strictEqual(colAnom.metric, "play");
  assert.strictEqual(colAnom.value, 0);
  assert.strictEqual(colAnom.prevDate, "2026-11-25");
  assert.strictEqual(colAnom.prevValue, 3400);
  assert.strictEqual(colAnom.nextDate, "2026-11-27");
  assert.strictEqual(colAnom.nextValue, 3600);

  assert.strictEqual(res7.anomalies.recommendSpikes.length, 1, "仅 C02_DY 满足双阈值，C01_DY 掉0恢复与 C02_SPH/KS 均不得误报");
  const recSpike = res7.anomalies.recommendSpikes[0];
  assert.strictEqual(recSpike.workId, "C02_DY");
  assert.strictEqual(recSpike.date, "2026-11-28");
  assert.strictEqual(recSpike.dailyPlayDelta, 1200);
  assert.strictEqual(recSpike.baselineAvg, 100);
  assert.strictEqual(recSpike.ratio, 12);

  // 第 7 节：文字小结（30 天 >= 14 天，5–8 行，不含少于 14 天提示，包含全部关键句）
  assert.strictEqual(res7.summary.lowHistoryNotice, false);
  assert.ok(res7.summary.lines.length >= 5 && res7.summary.lines.length <= 8);
  assert.strictEqual(res7.summary.text.includes(LOW_HISTORY_NOTICE_TEXT), false);
  for (const kw of ["总量与环比", "平台表现", "Top 作品", "长尾型", "推荐发布时段", "异常提醒"]) {
    assert.ok(res7.summary.text.includes(kw), `文字小结缺少关键项：${kw}`);
  }
  console.log("✓ 3 平台 × 12 内容 × 30 天全量 7 节分析数值验证通过");

  /* ---------- 2. 环比上期为 0 或无数据 → 空（绝不写 Infinity） ---------- */
  {
    const zeroPrevRows = [
      // 上周期（11-01..11-07）日增严格为 0
      { date: "2026-11-01", platform: "抖音", workId: "Z1", title: "零基数", play: 100, like: 10, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      { date: "2026-11-05", platform: "抖音", workId: "Z1", title: "零基数", play: 100, like: 10, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
      // 本周期（11-08..11-14）有新增
      { date: "2026-11-10", platform: "抖音", workId: "Z1", title: "零基数", play: 500, like: 30, comment: 5, share: 2, favorite: 3, fansDelta: 4 },
    ];
    const rZero = buildStatsAnalysis({
      dailyRows: zeroPrevRows,
      summaryRows: [],
      accountRows: [],
      to: "2026-11-14",
      period: 7,
    });
    assert.strictEqual(rZero.overview.metrics.play.previous, 0);
    assert.strictEqual(rZero.overview.metrics.play.current, 400);
    assert.strictEqual(rZero.overview.metrics.play.momPct, null, "上期为 0 时环比必须为 null，不得为 Infinity");

    // 完全无上周期数据
    const noPrevRows = [
      { date: "2026-11-10", platform: "抖音", workId: "Z2", title: "无上期", play: 100 },
      { date: "2026-11-12", platform: "抖音", workId: "Z2", title: "无上期", play: 300 },
    ];
    const rNoPrev = buildStatsAnalysis({
      dailyRows: noPrevRows,
      summaryRows: [],
      accountRows: [],
      to: "2026-11-14",
      period: 7,
    });
    assert.strictEqual(rNoPrev.overview.metrics.play.previous, null);
    assert.strictEqual(rNoPrev.overview.metrics.play.momPct, null, "上期无数据时环比必须为 null");
    console.log("✓ 环比上期 0 / 无数据 → null（无 Infinity）验证通过");
  }

  /* ---------- 3. 互动率播放为 0 / 空不计 + 样本 <3 注明「样本少，仅供参考」 ---------- */
  {
    const cmpSummary = [
      {
        contentKey: "file:/zero/1.mp4",
        title: "含0播放作品",
        firstPublishDate: "2026-11-10",
        perPlatform: {
          "抖音|主组": { play: 0, like: 50, comment: 10, share: 5, favorite: 0, fansDelta: 2 },
          "视频号|主组": { play: 1000, like: 100, comment: 20, share: 30, favorite: 10, fansDelta: 5 },
        },
      },
      {
        contentKey: "file:/zero/2.mp4",
        title: "含空播放与正常作品",
        firstPublishDate: "2026-11-11",
        perPlatform: {
          "抖音|主组": { play: 1000, like: 50, comment: 0, share: 0, favorite: 0, fansDelta: 1 },
          "视频号|主组": { play: null, like: 99, comment: 10, share: 5, favorite: 0, fansDelta: 3 },
        },
      },
    ];
    const rCmp = buildStatsAnalysis({
      dailyRows: [],
      summaryRows: cmpSummary,
      accountRows: [],
      to: "2026-11-15",
      period: 7,
    });
    assert.strictEqual(rCmp.platformComparison.multiPlatformContentCount, 2);
    const dy = rCmp.platformComparison.platforms.find((p) => p.platform === "抖音");
    const sph = rCmp.platformComparison.platforms.find((p) => p.platform === "视频号");
    // 抖音：条1 play=0 不计入互动率，条2 play=1000 like=50 → 互动率 = 0.05 (5%)
    assert.strictEqual(dy.engagementSampleCount, 1);
    assert.strictEqual(dy.engagementRate, 0.05);
    assert.strictEqual(dy.engagementRatePct, 5);
    assert.strictEqual(dy.avgPlay, 500, "平均播放应计入合法 0（(0+1000)/2=500）");
    // 视频号：条2 play=null 不计入互动率，条1 (100+20+30)/1000 = 0.15 (15%)
    assert.strictEqual(sph.engagementSampleCount, 1);
    assert.strictEqual(sph.engagementRate, 0.15);
    assert.strictEqual(sph.lowSample, true);
    assert.ok(
      rCmp.platformComparison.conclusions.some((c) => c.includes("样本少，仅供参考")),
      "样本 <3 必须注明「样本少，仅供参考」"
    );
    console.log("✓ 互动率播放 0/空不计与低样本提示验证通过");
  }

  /* ---------- 4. 走势分类边界 + D3 掉 0 异常剔除回退 ---------- */
  {
    assert.strictEqual(classifyTrajectory(100, 200, 300), "长尾型"); // D7/D3 = 1.5
    assert.strictEqual(classifyTrajectory(100, 200, 299), "其它"); // D7/D3 = 1.495 < 1.5, D3/D1 = 2
    assert.strictEqual(classifyTrajectory(100, 129, 141), "爆发后平稳"); // 1.29 < 1.3, 141/129 = 1.093 < 1.1
    assert.strictEqual(classifyTrajectory(100, 130, 140), "其它"); // D3/D1 = 1.3 不 < 1.3
    assert.strictEqual(classifyTrajectory(100, 100, 110), "其它"); // D7/D3 = 1.1 不 < 1.1
    assert.strictEqual(classifyTrajectory(100, 100, null), "数据不足");
    assert.strictEqual(classifyTrajectory(null, 100, 105), "数据不足");
    assert.strictEqual(classifyTrajectory(null, 100, 150), "长尾型"); // D7/D3 = 1.5
    assert.strictEqual(classifyTrajectory(0, 100, 105), "数据不足");

    // 掉 0 异常恰好发生在 D3（11-04），11-03=200，11-04=0[异常]，11-05=260，D7(11-08)=400
    // 剔除 11-04 后，D3 应回退取 11-03 的 200，D7/D3 = 400/200 = 2.0 → 长尾型！
    const d3DropRows = [
      { date: "2026-11-02", platform: "抖音", workId: "D3A", title: "D3掉0回退", publishTime: utc8Iso("2026-11-01", 10), play: 100, contentKey: "file:/d3a.mp4" },
      { date: "2026-11-03", platform: "抖音", workId: "D3A", title: "D3掉0回退", publishTime: utc8Iso("2026-11-01", 10), play: 200, contentKey: "file:/d3a.mp4" },
      { date: "2026-11-04", platform: "抖音", workId: "D3A", title: "D3掉0回退", publishTime: utc8Iso("2026-11-01", 10), play: 0, contentKey: "file:/d3a.mp4" },
      { date: "2026-11-05", platform: "抖音", workId: "D3A", title: "D3掉0回退", publishTime: utc8Iso("2026-11-01", 10), play: 260, contentKey: "file:/d3a.mp4" },
      { date: "2026-11-08", platform: "抖音", workId: "D3A", title: "D3掉0回退", publishTime: utc8Iso("2026-11-01", 10), play: 400, contentKey: "file:/d3a.mp4" },
    ];
    const rD3Drop = buildStatsAnalysis({
      dailyRows: d3DropRows,
      summaryRows: [],
      accountRows: [],
      to: "2026-11-08",
      period: 30,
    });
    assert.strictEqual(rD3Drop.anomalies.collectionAnomalies.length, 1);
    assert.strictEqual(rD3Drop.anomalies.collectionAnomalies[0].date, "2026-11-04");
    const d3Item = rD3Drop.newWorks.items[0];
    assert.strictEqual(d3Item.d1Play, 100);
    assert.strictEqual(d3Item.d3Play, 200, "D3 当日掉 0 剔除后应回退取 <= D3 的最近有效快照 200");
    assert.strictEqual(d3Item.d7Play, 400);
    assert.strictEqual(d3Item.category, "长尾型");
    // 剔除 11-04 后总日增：100→200(+100), 200→260(+60), 260→400(+140) = 300
    assert.strictEqual(rD3Drop.overview.metrics.play.current, 300);
    console.log("✓ 走势分类边界与 D3 掉 0 剔除回退验证通过");
  }

  /* ---------- 5. 发布时间 UTC+8 边界（跨 UTC 日与 4 个时段） ---------- */
  {
    // 2026-11-10 是周二；2026-11-11 是周三
    const tzCases = [
      { id: "TZ1", iso: "2026-11-10T15:59:59.000Z", expectDay: "周二", expectSlot: "18-24", play: 1000 }, // UTC+8 11-10 23:59:59
      { id: "TZ2", iso: "2026-11-10T16:00:00.000Z", expectDay: "周三", expectSlot: "0-6", play: 2000 },   // UTC+8 11-11 00:00:00
      { id: "TZ3", iso: "2026-11-10T22:00:00.000Z", expectDay: "周三", expectSlot: "6-12", play: 3000 },  // UTC+8 11-11 06:00:00
      { id: "TZ4", iso: "2026-11-11T04:00:00.000Z", expectDay: "周三", expectSlot: "12-18", play: 4000 }, // UTC+8 11-11 12:00:00
      { id: "TZ5", iso: "2026-11-11T10:00:00.000Z", expectDay: "周三", expectSlot: "18-24", play: 5000 }, // UTC+8 11-11 18:00:00
    ];
    const tzRows = tzCases.map((tc) => ({
      date: tc.id === "TZ1" ? "2026-11-17" : "2026-11-18",
      platform: "抖音",
      workId: tc.id,
      title: tc.id,
      publishTime: tc.iso,
      play: tc.play,
      contentKey: `file:/tz/${tc.id}.mp4`,
    }));
    const rTz = buildStatsAnalysis({
      dailyRows: tzRows,
      summaryRows: [],
      accountRows: [],
      to: "2026-11-20",
      period: 30,
    });
    for (const tc of tzCases) {
      const g = rTz.publishTime.groups.find(
        (x) => x.weekdayLabel === tc.expectDay && x.slot === tc.expectSlot
      );
      assert.ok(g, `UTC ${tc.iso} 应按 UTC+8 落入 ${tc.expectDay} ${tc.expectSlot}`);
      assert.strictEqual(g.avgD7Play, tc.play);
    }
    console.log("✓ 发布时间 UTC+8 跨零点与 4 时段边界验证通过");
  }

  /* ---------- 6. 缺失（null）后回升异常 + 数据积累 13 天 vs 14 天提示 ---------- */
  {
    const makeDaysRows = (dayCount) => {
      const rows = [];
      for (let i = 0; i < dayCount; i++) {
        const d = shiftDate("2026-11-01", i);
        rows.push({
          date: d,
          platform: "抖音",
          workId: "H1",
          title: "历史天数测试",
          publishTime: utc8Iso("2026-11-01", 10),
          play: i === 5 ? null : 100 + i * 50, // 第 6 天缺失后第 7 天回升 → 采集异常
          like: 10 + i * 2,
          contentKey: "file:/h1.mp4",
        });
      }
      return rows;
    };
    const r13 = buildStatsAnalysis({
      dailyRows: makeDaysRows(13),
      summaryRows: [],
      accountRows: [],
      to: "2026-11-13",
      period: 30,
    });
    assert.strictEqual(r13.snapshotDays, 13);
    assert.strictEqual(r13.summary.lowHistoryNotice, true);
    assert.ok(
      r13.summary.text.includes(LOW_HISTORY_NOTICE_TEXT),
      "13 天快照必须附少于 14 天提示"
    );
    assert.strictEqual(r13.anomalies.collectionAnomalies.length, 1);
    assert.strictEqual(r13.anomalies.collectionAnomalies[0].value, null);
    assert.strictEqual(
      r13.overview.metrics.play.current,
      (100 + 12 * 50) - 100,
      "缺失点剔除重算后总日增应等于末日减首日"
    );

    const r14 = buildStatsAnalysis({
      dailyRows: makeDaysRows(14),
      summaryRows: [],
      accountRows: [],
      to: "2026-11-14",
      period: 30,
    });
    assert.strictEqual(r14.snapshotDays, 14);
    assert.strictEqual(r14.summary.lowHistoryNotice, false);
    assert.strictEqual(
      r14.summary.text.includes(LOW_HISTORY_NOTICE_TEXT),
      false,
      "满 14 天快照不应附少于 14 天提示"
    );
    console.log("✓ 缺失后回升异常剔除与 13 天/14 天历史提示边界验证通过");
  }

  /* ---------- 7. 确定性（乱序输入多次调用结果完全一致） ---------- */
  {
    const fixedNow = Date.parse("2026-11-30T06:00:00Z");
    const run1 = buildStatsAnalysis({ ...dataset, period: 30, now: fixedNow });
    const reversedDataset = {
      dailyRows: [...dataset.dailyRows].reverse(),
      summaryRows: [...dataset.summaryRows].reverse(),
      accountRows: [...dataset.accountRows].reverse(),
      to: dataset.to,
    };
    const run2 = buildStatsAnalysis({ ...reversedDataset, period: 30, now: fixedNow });
    assert.deepStrictEqual(run1, run2, "乱序输入必须产出完全一致的确定性结果");
    console.log("✓ 确定性（乱序输入 bit-for-bit 一致）验证通过");
  }

  /* ---------- 8. IPC stats:get-analysis、GUI/Excel 一致性与 dataStats/index.vue 模板/方法校验 ---------- */
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-analysis-test-"));
    const ipcHandlers = new Map();
    const electronId = require.resolve("electron");
    const origElectronCache = require.cache[electronId];
    const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
    const origCollectorCache = require.cache[collectorId];
    const storeId = require.resolve("../src/main/services/dataStats/store.js");
    const indexId = require.resolve("../src/main/services/dataStats/index.js");

    try {
      require.cache[electronId] = {
        id: electronId,
        filename: electronId,
        loaded: true,
        exports: {
          app: {
            getPath: () => tmpRoot,
            getVersion: () => "0.14.9-fork.test",
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
      const dayTs = (ymd) => Date.parse(`${ymd}T02:00:00Z`);
      const sharedDeps = {
        now: dayTs("2026-11-20"),
        listAccounts: () => [
          { group: "G1", platform: "抖音" },
          { group: "G1", platform: "视频号" },
        ],
        readWorks: (_g, p) => ({
          works: [
            {
              workId: p === "抖音" ? "DY_S7" : "SPH_S7",
              title: "共享截止日验证视频",
              url: `https://example.com/${p}/s7`,
              publishTime: dayTs("2026-11-10"),
            },
          ],
        }),
        readWorksDaily: (_g, p) =>
          p === "抖音"
            ? {
                DY_S7: {
                  "2026-11-11": { play: 100, like: 5, comment: 1, share: 1, favorite: 2, fansDelta: 1 },
                  "2026-11-13": { play: 200, like: 10, comment: 2, share: 2, favorite: 3, fansDelta: 2 },
                  "2026-11-17": { play: 400, like: 20, comment: 4, share: 3, favorite: 5, fansDelta: 4 },
                },
              }
            : {
                SPH_S7: {
                  "2026-11-11": { play: 50, like: 10, comment: 2, share: 2, favorite: 3, fansDelta: 2 },
                  "2026-11-13": { play: 100, like: 20, comment: 4, share: 4, favorite: 5, fansDelta: 4 },
                  "2026-11-17": { play: 200, like: 40, comment: 8, share: 8, favorite: 10, fansDelta: 8 },
                },
              },
        // 账号快照比作品快照晚 1 天（11-18），验证 GUI 分析与 Excel 共用默认截止日 11-17
        readDaily: () => ({
          "2026-11-17": { fans: 100, plays: 400 },
          "2026-11-18": { fans: 110, plays: 500 },
        }),
        readPushRecords: () => [
          {
            id: "s7-p1",
            pt: "抖音",
            group: "G1",
            publishStatus: "success",
            title: "共享截止日验证视频",
            filePath: "/videos/s7_shared.mp4",
            videoLink: "https://example.com/抖音/s7",
            lastPublishAt: dayTs("2026-11-10"),
          },
          {
            id: "s7-p2",
            pt: "视频号",
            group: "G1",
            publishStatus: "success",
            title: "共享截止日验证视频",
            filePath: "/videos/s7_shared.mp4",
            videoLink: "https://example.com/视频号/s7",
            lastPublishAt: dayTs("2026-11-10"),
          },
        ],
      };

      registerDataStatsIpc({ exportDeps: sharedDeps });
      const getAnalysis = ipcHandlers.get("stats:get-analysis");
      assert.strictEqual(typeof getAnalysis, "function");

      // 外部页面必须被拒绝
      for (const badUrl of ["https://evil.example.com", "file://remote/a.html", ""]) {
        const denied = await getAnalysis({ senderFrame: { url: badUrl } }, { period: 30 });
        assert.strictEqual(denied.ok, false, `外部来源 ${badUrl} 必须被拒绝`);
      }
      // 非法参数必须被拒绝
      const localEv = { senderFrame: { url: "file:///app/index.html" } };
      assert.strictEqual((await getAnalysis(localEv, { period: 0 })).ok, false);
      assert.strictEqual((await getAnalysis(localEv, { period: "30" })).ok, false);
      assert.strictEqual((await getAnalysis(localEv, { to: "2026-02-30" })).ok, false);

      // 默认截止日与 Excel 一致，且分析结果 100% 同源一致
      const ipcRes = await getAnalysis(localEv, { period: 30 });
      assert.strictEqual(ipcRes.ok, true);
      const wbRes = buildStatsWorkbookData({ now: dayTs("2026-11-20") }, sharedDeps);
      assert.strictEqual(ipcRes.to, "2026-11-17");
      assert.strictEqual(wbRes.to, "2026-11-17");
      assert.deepStrictEqual(ipcRes.overview, wbRes.analysis.overview);
      assert.deepStrictEqual(ipcRes.platformComparison, wbRes.analysis.platformComparison);
      assert.deepStrictEqual(ipcRes.rankings, wbRes.analysis.rankings);
      assert.deepStrictEqual(ipcRes.newWorks, wbRes.analysis.newWorks);
      assert.deepStrictEqual(ipcRes.publishTime, wbRes.analysis.publishTime);
      assert.deepStrictEqual(ipcRes.anomalies, wbRes.analysis.anomalies);
      assert.deepStrictEqual(ipcRes.summary, wbRes.analysis.summary);

      // 复用 buildStatsAnalysisData 校验 period: 7
      const res7Data = buildStatsAnalysisData({ period: 7 }, sharedDeps);
      assert.strictEqual(res7Data.to, "2026-11-17");
      assert.strictEqual(res7Data.period, 7);

      // 校验 dataStats/index.vue 模板编译与数据分析 tab 交互方法
      const vuePath = path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue");
      const sfc = vueCompiler.parseComponent(fs.readFileSync(vuePath, "utf8"));
      const compiled = vueCompiler.compile(sfc.template.content);
      assert.strictEqual(
        compiled.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${compiled.errors.join("; ")}`
      );
      assert.ok(sfc.template.content.includes('label="数据分析"'), "应包含「数据分析」tab");
      assert.strictEqual(
        sfc.template.content.includes("activeTab === 'analysis'"),
        false,
        "数据分析 tab 不应使用 v-if 销毁组件，应由 el-tab-pane 控制显隐"
      );

      const bundlePath = path.join(tmpRoot, "dataStats-analysis-view.cjs");
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
      const origLoad = Module._load;
      const invokeCalls = [];
      let copiedText = "";
      Module._load = function (request, ...rest) {
        if (request === "electron") {
          return {
            ipcRenderer: {
              invoke: async (ch, payload) => {
                invokeCalls.push({ ch, payload });
                if (ch === "stats:get-analysis") return ipcRes;
                return { ok: true };
              },
            },
            shell: { openExternal: async () => {} },
            clipboard: {
              writeText: (t) => {
                copiedText = t;
              },
            },
          };
        }
        return origLoad.call(this, request, ...rest);
      };
      try {
        const comp = require(bundlePath).default;
        const msgs = [];
        const ctx = {
          ...comp.data(),
          $refs: {},
          $message: {
            success: (m) => msgs.push({ type: "success", m }),
            warning: (m) => msgs.push({ type: "warning", m }),
            error: (m) => msgs.push({ type: "error", m }),
          },
        };
        for (const [k, fn] of Object.entries(comp.methods)) ctx[k] = fn.bind(ctx);
        for (const [k, fn] of Object.entries(comp.computed)) {
          Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
        }
        await ctx.loadAnalysis();
        assert.strictEqual(invokeCalls[0].ch, "stats:get-analysis");
        assert.deepStrictEqual(invokeCalls[0].payload, { period: 30 }, "未选截止日时不得传本地日期，走后端共享默认截止日");
        assert.strictEqual(ctx.analysisData.to, "2026-11-17");
        await ctx.copyAnalysisSummary();
        assert.strictEqual(copiedText, ipcRes.summary.text, "复制小结应写入完整文字小结到剪贴板");
        assert.ok(msgs.some((m) => m.type === "success"));
      } finally {
        Module._load = origLoad;
      }

      console.log("✓ IPC stats:get-analysis 安全校验、GUI/Excel 一致性与 dataStats/index.vue 校验通过");
    } finally {
      if (origElectronCache) require.cache[electronId] = origElectronCache;
      else delete require.cache[electronId];
      if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
      else delete require.cache[collectorId];
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log("\ntest-stats-analysis: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
