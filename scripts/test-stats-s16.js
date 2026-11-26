#!/usr/bin/env node
"use strict";

/**
 * 卡 S16：数据分析按分组（两套矩阵分开看）单测
 *
 * 覆盖：
 * 1. 分组过滤：7 节分析（总览/平台对比/作品排行与偏科/新作品走势与前24h/发布时间/粉丝趋势/异常提醒与小结）、
 *    跨平台汇总、作品趋势（按天/按时段）、Excel 单分组导出全部按分组隔离
 * 2. 「全部」回归：未传 group 时全局分析结果与全局「分析」sheet、导出信息与改动前完全一致
 * 3. 跨组内容拆分：同一 contentKey 跨两个分组时按各作品所在分组拆分，首发日/平台数/总播放互不串组、不重复计入同一分组；
 *    同作品身份 platform|workId 挂两分组时全局导出分分组 sheet 与单分组分析 bit-for-bit 一致
 * 4. Excel 导出：保留全局「分析」sheet + 按 accountGroupOrder 为每组生成「分析-<分组名>」sheet；
 *    sheet 名超 31 字符、非法字符 : \ / ? * [ ]、单引号、emoji 代理对、冲突去重；
 *    「作品跨平台汇总」与「平台日汇总」补齐「分组」列且字段说明 1:1 对齐；SheetJS 写回读回校验
 * 5. S15 statsStartDate 在分组分析、分组导出、趋势与全局分分组 sheet 中按各自分组照旧生效
 * 6. CLI stats-export --group <名> / --group=<名>、省略 --group、空 --group（exit 2）、未知分组报错（exit 2 且不写文件）；
 *    核心 API / IPC 未知分组返回 UNKNOWN_GROUP 错误
 * 7. dataStats/index.vue 模板编译 & 组件交互：按 accountGroupOrder 排序分组、默认选第一组、localStorage 持久化与 try/catch 容错、
 *    切组/切「全部」重拉分析并重置子筛选、复制小结带分组名、单图与批量 PNG 导出带分组名（且主进程不重复前缀）、
 *    从数据分析页打开作品趋势弹窗透传 group 与 to（按天/按时段 + 趋势图导出带分组名）
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const xlsx = require("xlsx");
const { build } = require("esbuild");
const vueCompiler = require("vue-template-compiler");

const {
  buildStatsAnalysis,
  filterSummaryRowsForGroup,
} = require("../src/main/services/dataStats/statsAnalysis.js");
const {
  SHEET_NAMES,
  UNKNOWN_GROUP_CODE,
  EXCEL_SHEET_NAME_MAX_LEN,
  SUMMARY_BASE_HEADERS,
  PLATFORM_DAILY_HEADERS,
  sanitizeExcelSheetSegment,
  buildGroupAnalysisSheetName,
  buildDefaultExportFileName,
  buildContentSummaryData,
  buildContentTrendData,
  buildContentIntradayData,
  buildStatsAnalysisData,
  buildStatsWorkbookData,
  writeStatsXlsx,
} = require("../src/main/services/dataStats/statsExport.js");

const VALID_PNG_DATA_URL =
  "data:image/png;base64," +
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]).toString("base64");

function tsUtc8(dateStr, timeStr = "12:00:00") {
  return Date.parse(`${dateStr}T${timeStr}+08:00`);
}

function makeTwoMatrixDeps(extra = {}) {
  const G1 = "人间善恶录";
  const G2 = "赛博老司机";
  const now = tsUtc8("2026-11-20", "18:00:00");

  // 人间善恶录：视频号 / 抖音 / 快手 / 头条
  // 赛博老司机：视频号 / 小红书 / 百家号 / 哔哩哔哩
  // 含：
  // - G1 专属跨平台内容（file:/v/g1-main.mp4：抖音 + 快手，抖音掉0异常 + 11-18 上推荐爆发）
  // - G1 专属新作品（file:/v/g1-new.mp4：11-16 发布，带分时段快照）
  // - G2 专属跨平台内容（file:/v/g2-main.mp4：小红书 + 哔哩哔哩，小红书 11-19 偏科高播）
  // - G2 专属新作品（file:/v/g2-new.mp4：11-17 发布，带分时段快照）
  // - 极少见的跨组内容（file:/v/cross.mp4）：G1 抖音 11-05 发布(play 1200) + G1 快手 11-06 发布(play 800) + G2 小红书 11-15 发布(play 9000)
  // - 起点日期测试旧作品：G1 old(11-02)、G2 old(11-08)
  const accounts = [
    { group: G2, platform: "视频号" },
    { group: G2, platform: "小红书" },
    { group: G2, platform: "哔哩哔哩" },
    { group: G1, platform: "抖音" },
    { group: G1, platform: "快手" },
    { group: G1, platform: "视频号" },
  ];

  const worksByGp = {
    [`${G1}|抖音`]: [
      {
        workId: "G1_DY_1",
        title: "善恶故事第一期",
        url: "https://www.douyin.com/video/g1dy1",
        publishTime: tsUtc8("2026-11-10", "19:30:00"),
      },
      {
        workId: "G1_DY_NEW",
        title: "善恶新作品",
        url: "https://www.douyin.com/video/g1dynew",
        publishTime: tsUtc8("2026-11-16", "10:00:00"),
      },
      {
        workId: "G1_DY_CROSS",
        title: "跨矩阵共享专题",
        url: "https://www.douyin.com/video/cross1",
        publishTime: tsUtc8("2026-11-05", "09:00:00"),
      },
      {
        workId: "G1_DY_OLD",
        title: "善恶很早以前的老作品",
        url: "https://www.douyin.com/video/g1old",
        publishTime: tsUtc8("2026-11-02", "08:00:00"),
      },
    ],
    [`${G1}|快手`]: [
      {
        workId: "G1_KS_1",
        title: "善恶故事第一期",
        url: "https://www.kuaishou.com/short-video/g1ks1",
        publishTime: tsUtc8("2026-11-10", "20:00:00"),
      },
      {
        workId: "G1_KS_CROSS",
        title: "跨矩阵共享专题",
        url: "https://www.kuaishou.com/short-video/crossks",
        publishTime: tsUtc8("2026-11-06", "09:00:00"),
      },
    ],
    [`${G1}|视频号`]: [
      {
        workId: "G1_SPH_NEW",
        title: "善恶新作品",
        url: "https://channels.weixin.qq.com/post/g1sphnew",
        publishTime: tsUtc8("2026-11-16", "10:30:00"),
      },
    ],
    [`${G2}|小红书`]: [
      {
        workId: "G2_XHS_1",
        title: "AI前沿快报第一期",
        url: "https://www.xiaohongshu.com/explore/g2xhs1",
        publishTime: tsUtc8("2026-11-12", "14:00:00"),
      },
      {
        workId: "G2_XHS_NEW",
        title: "赛博新番评测",
        url: "https://www.xiaohongshu.com/explore/g2xhsnew",
        publishTime: tsUtc8("2026-11-17", "15:00:00"),
      },
      {
        workId: "G2_XHS_CROSS",
        title: "跨矩阵共享专题",
        url: "https://www.xiaohongshu.com/explore/crossxhs",
        publishTime: tsUtc8("2026-11-15", "21:00:00"),
      },
      {
        workId: "G2_XHS_OLD",
        title: "赛博起点前旧视频",
        url: "https://www.xiaohongshu.com/explore/g2old",
        publishTime: tsUtc8("2026-11-08", "12:00:00"),
      },
    ],
    [`${G2}|哔哩哔哩`]: [
      {
        workId: "G2_BL_1",
        title: "AI前沿快报第一期",
        url: "https://www.bilibili.com/video/BV1g2bl1",
        publishTime: tsUtc8("2026-11-12", "14:30:00"),
      },
      {
        workId: "G2_BL_NEW",
        title: "赛博新番评测",
        url: "https://www.bilibili.com/video/BV1g2blnew",
        publishTime: tsUtc8("2026-11-17", "15:30:00"),
      },
    ],
    [`${G2}|视频号`]: [],
  };

  const worksDailyByGp = {
    [`${G1}|抖音`]: {
      G1_DY_1: {
        "2026-11-10": { play: 1000, like: 50, comment: 10, share: 5, favorite: 20, fansDelta: 3 },
        "2026-11-11": { play: 1100, like: 55, comment: 11, share: 6, favorite: 22, fansDelta: 4 },
        "2026-11-12": { play: 1200, like: 60, comment: 12, share: 7, favorite: 24, fansDelta: 5 },
        "2026-11-13": { play: 0, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 }, // 掉 0 异常
        "2026-11-14": { play: 1400, like: 70, comment: 14, share: 9, favorite: 28, fansDelta: 7 },
        "2026-11-15": { play: 1500, like: 75, comment: 15, share: 10, favorite: 30, fansDelta: 8 },
        "2026-11-16": { play: 1600, like: 80, comment: 16, share: 11, favorite: 32, fansDelta: 9 },
        "2026-11-17": { play: 1700, like: 85, comment: 17, share: 12, favorite: 34, fansDelta: 10 },
        "2026-11-18": { play: 5700, like: 300, comment: 60, share: 40, favorite: 120, fansDelta: 45 }, // 单日+4000 上推荐
        "2026-11-19": { play: 5900, like: 310, comment: 62, share: 42, favorite: 125, fansDelta: 48 },
        "2026-11-20": { play: 6000, like: 320, comment: 65, share: 45, favorite: 130, fansDelta: 50 },
      },
      G1_DY_NEW: {
        "2026-11-16": { play: 400, like: 20, comment: 4, share: 2, favorite: 8, fansDelta: 2 },
        "2026-11-17": { play: 600, like: 30, comment: 6, share: 3, favorite: 12, fansDelta: 3 },
        "2026-11-18": { play: 900, like: 45, comment: 9, share: 5, favorite: 18, fansDelta: 5 },
        "2026-11-19": { play: 1100, like: 55, comment: 11, share: 6, favorite: 22, fansDelta: 6 },
        "2026-11-20": { play: 1300, like: 65, comment: 13, share: 7, favorite: 26, fansDelta: 8 },
      },
      G1_DY_CROSS: {
        "2026-11-10": { play: 1000, like: 40, comment: 5, share: 3, favorite: 10, fansDelta: 2 },
        "2026-11-20": { play: 1200, like: 50, comment: 6, share: 4, favorite: 12, fansDelta: 3 },
      },
      G1_DY_OLD: {
        "2026-11-10": { play: 20000, like: 500, comment: 40, share: 20, favorite: 80, fansDelta: 30 },
        "2026-11-20": { play: 20500, like: 520, comment: 42, share: 22, favorite: 85, fansDelta: 32 },
      },
    },
    [`${G1}|快手`]: {
      G1_KS_1: {
        "2026-11-10": { play: 500, like: 25, comment: 5 },
        "2026-11-17": { play: 800, like: 40, comment: 8 },
        "2026-11-20": { play: 1000, like: 50, comment: 10 },
      },
      G1_KS_CROSS: {
        "2026-11-10": { play: 600, like: 20, comment: 4 },
        "2026-11-20": { play: 800, like: 30, comment: 6 },
      },
    },
    [`${G1}|视频号`]: {
      G1_SPH_NEW: {
        "2026-11-16": { play: 300, like: 15, comment: 3, share: 2, favorite: 5, fansDelta: 1 },
        "2026-11-18": { play: 700, like: 35, comment: 7, share: 5, favorite: 12, fansDelta: 4 },
        "2026-11-20": { play: 1000, like: 50, comment: 10, share: 8, favorite: 18, fansDelta: 6 },
      },
    },
    [`${G2}|小红书`]: {
      G2_XHS_1: {
        "2026-11-12": { play: 2000, like: 200, comment: 30, share: 20, favorite: 150 },
        "2026-11-15": { play: 5000, like: 500, comment: 75, share: 50, favorite: 350 },
        "2026-11-19": { play: 9000, like: 900, comment: 135, share: 90, favorite: 600 },
        "2026-11-20": { play: 9500, like: 950, comment: 140, share: 95, favorite: 620 },
      },
      G2_XHS_NEW: {
        "2026-11-17": { play: 800, like: 80, comment: 12, share: 8, favorite: 60 },
        "2026-11-19": { play: 2400, like: 240, comment: 36, share: 24, favorite: 180 },
        "2026-11-20": { play: 3200, like: 320, comment: 48, share: 32, favorite: 240 },
      },
      G2_XHS_CROSS: {
        "2026-11-15": { play: 3000, like: 300, comment: 40, share: 25, favorite: 200 },
        "2026-11-17": { play: 6000, like: 600, comment: 80, share: 50, favorite: 400 },
        "2026-11-20": { play: 9000, like: 900, comment: 120, share: 75, favorite: 600 },
      },
      G2_XHS_OLD: {
        "2026-11-12": { play: 15000, like: 800, comment: 60, share: 30, favorite: 400 },
        "2026-11-20": { play: 15200, like: 810, comment: 62, share: 31, favorite: 405 },
      },
    },
    [`${G2}|哔哩哔哩`]: {
      G2_BL_1: {
        "2026-11-12": { play: 500, like: 30, comment: 10, share: 5, favorite: 25 },
        "2026-11-19": { play: 1200, like: 70, comment: 20, share: 10, favorite: 55 },
        "2026-11-20": { play: 1500, like: 90, comment: 25, share: 12, favorite: 65 },
      },
      G2_BL_NEW: {
        "2026-11-17": { play: 300, like: 18, comment: 6, share: 3, favorite: 15 },
        "2026-11-19": { play: 700, like: 42, comment: 12, share: 6, favorite: 35 },
        "2026-11-20": { play: 900, like: 55, comment: 15, share: 8, favorite: 45 },
      },
    },
    [`${G2}|视频号`]: {},
  };

  const intradayByGp = {
    [`${G1}|抖音`]: {
      G1_DY_NEW: [
        { date: "2026-11-16", slot: "12:00", collectedAt: tsUtc8("2026-11-16", "12:00:00"), play: 150 },
        { date: "2026-11-16", slot: "18:00", collectedAt: tsUtc8("2026-11-16", "18:00:00"), play: 400 },
        { date: "2026-11-17", slot: "08:00", collectedAt: tsUtc8("2026-11-17", "08:00:00"), play: 550 },
      ],
      G1_DY_CROSS: [
        { date: "2026-11-19", slot: "10:00", collectedAt: tsUtc8("2026-11-19", "10:00:00"), play: 1150 },
        { date: "2026-11-20", slot: "10:00", collectedAt: tsUtc8("2026-11-20", "10:00:00"), play: 1200 },
      ],
    },
    [`${G2}|小红书`]: {
      G2_XHS_NEW: [
        { date: "2026-11-17", slot: "16:00", collectedAt: tsUtc8("2026-11-17", "16:00:00"), play: 300 },
        { date: "2026-11-17", slot: "22:00", collectedAt: tsUtc8("2026-11-17", "22:00:00"), play: 800 },
        { date: "2026-11-18", slot: "10:00", collectedAt: tsUtc8("2026-11-18", "10:00:00"), play: 1600 },
      ],
      G2_XHS_CROSS: [
        { date: "2026-11-19", slot: "10:00", collectedAt: tsUtc8("2026-11-19", "10:00:00"), play: 8200 },
        { date: "2026-11-20", slot: "10:00", collectedAt: tsUtc8("2026-11-20", "10:00:00"), play: 9000 },
      ],
    },
  };

  const dailyByGp = {
    [`${G1}|抖音`]: {
      "2026-11-10": { fans: 1000, plays: 22000 },
      "2026-11-20": { fans: 1120, plays: 29000 },
    },
    [`${G1}|快手`]: {
      "2026-11-10": { fans: 500, plays: 1100 },
      "2026-11-20": { fans: 540, plays: 1800 },
    },
    [`${G1}|视频号`]: {
      "2026-11-16": { fans: 200, plays: 300 },
      "2026-11-20": { fans: 230, plays: 1000 },
    },
    [`${G2}|小红书`]: {
      "2026-11-12": { fans: 3000, plays: 17000 },
      "2026-11-20": { fans: 3600, plays: 36900 },
    },
    [`${G2}|哔哩哔哩`]: {
      "2026-11-12": { fans: 800, plays: 500 },
      "2026-11-20": { fans: 950, plays: 2400 },
    },
    [`${G2}|视频号`]: {
      "2026-11-12": { fans: 100, plays: 0 },
      "2026-11-20": { fans: 120, plays: 0 },
    },
  };

  const pushRecords = [
    {
      id: "p-g1-1",
      pt: "抖音",
      group: G1,
      publishStatus: "success",
      title: "善恶故事第一期",
      filePath: "/v/g1-main.mp4",
      videoLink: "https://www.douyin.com/video/g1dy1",
      lastPublishAt: tsUtc8("2026-11-10", "19:30:00"),
    },
    {
      id: "p-g1-2",
      pt: "快手",
      group: G1,
      publishStatus: "success",
      title: "善恶故事第一期",
      filePath: "/v/g1-main.mp4",
      videoLink: "https://www.kuaishou.com/short-video/g1ks1",
      lastPublishAt: tsUtc8("2026-11-10", "20:00:00"),
    },
    {
      id: "p-g1-new-1",
      pt: "抖音",
      group: G1,
      publishStatus: "success",
      title: "善恶新作品",
      filePath: "/v/g1-new.mp4",
      videoLink: "https://www.douyin.com/video/g1dynew",
      lastPublishAt: tsUtc8("2026-11-16", "10:00:00"),
    },
    {
      id: "p-g1-new-2",
      pt: "视频号",
      group: G1,
      publishStatus: "success",
      title: "善恶新作品",
      filePath: "/v/g1-new.mp4",
      videoLink: "https://channels.weixin.qq.com/post/g1sphnew",
      lastPublishAt: tsUtc8("2026-11-16", "10:30:00"),
    },
    {
      id: "p-g2-1",
      pt: "小红书",
      group: G2,
      publishStatus: "success",
      title: "AI前沿快报第一期",
      filePath: "/v/g2-main.mp4",
      videoLink: "https://www.xiaohongshu.com/explore/g2xhs1",
      lastPublishAt: tsUtc8("2026-11-12", "14:00:00"),
    },
    {
      id: "p-g2-2",
      pt: "哔哩哔哩",
      group: G2,
      publishStatus: "success",
      title: "AI前沿快报第一期",
      filePath: "/v/g2-main.mp4",
      videoLink: "https://www.bilibili.com/video/BV1g2bl1",
      lastPublishAt: tsUtc8("2026-11-12", "14:30:00"),
    },
    {
      id: "p-g2-new-1",
      pt: "小红书",
      group: G2,
      publishStatus: "success",
      title: "赛博新番评测",
      filePath: "/v/g2-new.mp4",
      videoLink: "https://www.xiaohongshu.com/explore/g2xhsnew",
      lastPublishAt: tsUtc8("2026-11-17", "15:00:00"),
    },
    {
      id: "p-g2-new-2",
      pt: "哔哩哔哩",
      group: G2,
      publishStatus: "success",
      title: "赛博新番评测",
      filePath: "/v/g2-new.mp4",
      videoLink: "https://www.bilibili.com/video/BV1g2blnew",
      lastPublishAt: tsUtc8("2026-11-17", "15:30:00"),
    },
    // 跨组内容：同一素材文件分别发到 G1（抖音/快手）与 G2（小红书）
    {
      id: "p-cross-1",
      pt: "抖音",
      group: G1,
      publishStatus: "success",
      title: "跨矩阵共享专题",
      filePath: "/v/cross.mp4",
      videoLink: "https://www.douyin.com/video/cross1",
      lastPublishAt: tsUtc8("2026-11-05", "09:00:00"),
    },
    {
      id: "p-cross-2",
      pt: "快手",
      group: G1,
      publishStatus: "success",
      title: "跨矩阵共享专题",
      filePath: "/v/cross.mp4",
      videoLink: "https://www.kuaishou.com/short-video/crossks",
      lastPublishAt: tsUtc8("2026-11-06", "09:00:00"),
    },
    {
      id: "p-cross-3",
      pt: "小红书",
      group: G2,
      publishStatus: "success",
      title: "跨矩阵共享专题",
      filePath: "/v/cross.mp4",
      videoLink: "https://www.xiaohongshu.com/explore/crossxhs",
      lastPublishAt: tsUtc8("2026-11-15", "21:00:00"),
    },
  ];

  const groupOrderMap = {
    [G1]: 0,
    [G2]: 1,
  };

  return {
    G1,
    G2,
    deps: {
      now,
      appVersion: "0.14.9-s16.test",
      listAccounts: () => accounts,
      readWorks: (g, p) => ({ works: worksByGp[`${g}|${p}`] || [] }),
      readWorksDaily: (g, p) => worksDailyByGp[`${g}|${p}`] || {},
      readWorksIntraday: (g, p) => intradayByGp[`${g}|${p}`] || {},
      readDaily: (g, p) => dailyByGp[`${g}|${p}`] || {},
      readPushRecords: () => pushRecords,
      readGroupOrderMap: () => groupOrderMap,
      readGroupSettings: () => extra.groupSettings || {},
      readLinkOverrides: () => extra.linkOverrides || { version: 1, updatedAt: 0, contents: {}, overrides: {} },
      ...(extra.depsOverrides || {}),
    },
  };
}

async function runTests() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s16-test-"));
  try {
    /* ---------- 1. 分组过滤（7 节分析 / 汇总 / 趋势 / 导出）+ 「全部」回归 ---------- */
    {
      const { G1, G2, deps } = makeTwoMatrixDeps();

      const allAnalysis = buildStatsAnalysisData({ period: 30, to: "2026-11-20" }, deps);
      const g1Analysis = buildStatsAnalysisData({ period: 30, to: "2026-11-20", group: G1 }, deps);
      const g2Analysis = buildStatsAnalysisData({ period: 30, to: "2026-11-20", group: G2 }, deps);

      assert.strictEqual(allAnalysis.group, null, "全局分析 group 应为 null");
      assert.strictEqual(g1Analysis.group, G1);
      assert.strictEqual(g2Analysis.group, G2);

      // 1a. 第 1 节总览：平台贡献隔离（G1 仅含抖音/快手/视频号；G2 仅含小红书/哔哩哔哩）
      const g1Platforms = new Set(g1Analysis.overview.platformContribution.map((r) => r.platform));
      const g2Platforms = new Set(g2Analysis.overview.platformContribution.map((r) => r.platform));
      assert.strictEqual(g1Platforms.has("小红书"), false, "人间善恶录不得混入小红书");
      assert.strictEqual(g1Platforms.has("哔哩哔哩"), false, "人间善恶录不得混入哔哩哔哩");
      assert.ok(g1Platforms.has("抖音") && g1Platforms.has("快手"));
      assert.strictEqual(g2Platforms.has("抖音"), false, "赛博老司机不得混入抖音");
      assert.strictEqual(g2Platforms.has("快手"), false, "赛博老司机不得混入快手");
      assert.ok(g2Platforms.has("小红书") && g2Platforms.has("哔哩哔哩"));

      // 1b. 两矩阵总播放增量之和 === 全局总播放增量（无共享 workId 时严格可加）
      assert.strictEqual(
        g1Analysis.overview.metrics.play.current + g2Analysis.overview.metrics.play.current,
        allAnalysis.overview.metrics.play.current,
        "两套独立矩阵播放日增之和应等于全局总播放日增"
      );
      assert.strictEqual(
        g1Analysis.overview.accountFansGrowth.current +
          g2Analysis.overview.accountFansGrowth.current,
        allAnalysis.overview.accountFansGrowth.current,
        "两套矩阵账号涨粉之和应等于全局账号涨粉"
      );

      // 1c. 第 2 节平台对比：仅统计各自分组覆盖 ≥2 平台的同款内容
      const g1CompPts = new Set(g1Analysis.platformComparison.platforms.map((p) => p.platform));
      const g2CompPts = new Set(g2Analysis.platformComparison.platforms.map((p) => p.platform));
      assert.strictEqual(g1CompPts.has("小红书"), false);
      assert.strictEqual(g2CompPts.has("抖音"), false);
      assert.ok(g1CompPts.has("抖音") && g1CompPts.has("快手"));
      assert.ok(g2CompPts.has("小红书") && g2CompPts.has("哔哩哔哩"));

      // 1d. 第 3 节排行 & 偏科：严格按分组隔离
      const g1RankKeys = new Set(g1Analysis.rankings.byPlay.top.map((r) => r.contentKey));
      const g2RankKeys = new Set(g2Analysis.rankings.byPlay.top.map((r) => r.contentKey));
      assert.ok(g1RankKeys.has("file:/v/g1-main.mp4"));
      assert.strictEqual(g1RankKeys.has("file:/v/g2-main.mp4"), false);
      assert.ok(g2RankKeys.has("file:/v/g2-main.mp4"));
      assert.strictEqual(g2RankKeys.has("file:/v/g1-main.mp4"), false);
      assert.ok(
        g2Analysis.rankings.platformSkew.some((r) => r.contentKey === "file:/v/g2-main.mp4" && r.platform === "小红书"),
        "赛博老司机偏科应命中 AI前沿快报第一期（小红书 9500 vs B站 1500）"
      );
      assert.strictEqual(
        g1Analysis.rankings.platformSkew.some((r) => r.contentKey === "file:/v/g2-main.mp4"),
        false,
        "人间善恶录偏科不得出现赛博老司机内容"
      );

      // 1e. 第 4 节新作品走势 & 前 24 小时
      const g1NewKeys = new Set(g1Analysis.newWorks.items.map((r) => r.contentKey));
      const g2NewKeys = new Set(g2Analysis.newWorks.items.map((r) => r.contentKey));
      assert.ok(g1NewKeys.has("file:/v/g1-new.mp4"));
      assert.strictEqual(g1NewKeys.has("file:/v/g2-new.mp4"), false);
      assert.ok(g2NewKeys.has("file:/v/g2-new.mp4"));
      assert.strictEqual(g2NewKeys.has("file:/v/g1-new.mp4"), false);

      const g1First24hKeys = new Set(g1Analysis.newWorksFirst24h.items.map((r) => r.contentKey));
      const g2First24hKeys = new Set(g2Analysis.newWorksFirst24h.items.map((r) => r.contentKey));
      assert.ok(g1First24hKeys.has("file:/v/g1-new.mp4"));
      assert.strictEqual(g1First24hKeys.has("file:/v/g2-new.mp4"), false);
      assert.ok(g2First24hKeys.has("file:/v/g2-new.mp4"));
      assert.strictEqual(g2First24hKeys.has("file:/v/g1-new.mp4"), false);

      // 1f. 第 6 节粉丝趋势：只含各自账号
      assert.ok(g1Analysis.fansTrend.accounts.every((a) => a.group === G1));
      assert.ok(g2Analysis.fansTrend.accounts.every((a) => a.group === G2));
      assert.strictEqual(g1Analysis.fansTrend.accounts.length, 3);
      assert.strictEqual(g2Analysis.fansTrend.accounts.length, 3);

      // 1g. 第 7 节异常提醒：G1 含掉 0 异常与 11-18 上推荐；G2 无 G1 异常
      assert.ok(
        g1Analysis.anomalies.collectionAnomalies.some((a) => a.workId === "G1_DY_1" && a.date === "2026-11-13"),
        "人间善恶录应检出 G1_DY_1 掉 0 异常"
      );
      assert.ok(
        g1Analysis.anomalies.recommendSpikes.some((a) => a.workId === "G1_DY_1" && a.date === "2026-11-18"),
        "人间善恶录应检出 G1_DY_1 上推荐爆发"
      );
      assert.strictEqual(g2Analysis.anomalies.collectionAnomalies.length, 0, "赛博老司机不得混入 G1 采集异常");
      assert.strictEqual(g2Analysis.anomalies.recommendSpikes.length, 0, "赛博老司机不得混入 G1 上推荐爆发");

      // 1h. 跨组内容拆分验证（file:/v/cross.mp4）：
      // 全局汇总：合并 3 平台，totalPlay = 1200 + 800 + 9000 = 11000，首发 11-05，分组 = "人间善恶录、赛博老司机"
      const allSum = buildContentSummaryData({ date: "2026-11-20" }, deps);
      const allCross = allSum.rows.find((r) => r.contentKey === "file:/v/cross.mp4");
      assert.ok(allCross);
      assert.strictEqual(allCross.platformCount, 3);
      assert.strictEqual(allCross.totalPlay, 11000);
      assert.strictEqual(allCross.firstPublishDate, "2026-11-05");
      assert.deepStrictEqual(allCross.groups, [G1, G2]);
      assert.strictEqual(allCross.group, `${G1}、${G2}`);

      // G1 视角：仅含抖音(1200)+快手(800)=2000，platformCount=2，首发 11-05（不计入小红书 9000）
      const g1Sum = buildContentSummaryData({ date: "2026-11-20", group: G1 }, deps);
      const g1Cross = g1Sum.rows.find((r) => r.contentKey === "file:/v/cross.mp4");
      assert.ok(g1Cross);
      assert.strictEqual(g1Cross.platformCount, 2);
      assert.strictEqual(g1Cross.totalPlay, 2000);
      assert.strictEqual(g1Cross.firstPublishDate, "2026-11-05");
      assert.deepStrictEqual(g1Cross.groups, [G1]);
      const g1CrossRank = g1Analysis.rankings.byPlay.top.find((r) => r.contentKey === "file:/v/cross.mp4");
      assert.ok(g1CrossRank);
      assert.strictEqual(g1CrossRank.totalPlay, 2000);
      assert.strictEqual(g1CrossRank.platformCount, 2);

      // G2 视角：仅含小红书(9000)，platformCount=1，首发 11-15（不被 G1 的 11-05 污染！）
      const g2Sum = buildContentSummaryData({ date: "2026-11-20", group: G2 }, deps);
      const g2Cross = g2Sum.rows.find((r) => r.contentKey === "file:/v/cross.mp4");
      assert.ok(g2Cross);
      assert.strictEqual(g2Cross.platformCount, 1);
      assert.strictEqual(g2Cross.totalPlay, 9000);
      assert.strictEqual(g2Cross.firstPublishDate, "2026-11-15");
      assert.deepStrictEqual(g2Cross.groups, [G2]);
      const g2CrossRank = g2Analysis.rankings.byPlay.top.find((r) => r.contentKey === "file:/v/cross.mp4");
      assert.ok(g2CrossRank);
      assert.strictEqual(g2CrossRank.totalPlay, 9000);
      assert.strictEqual(g2CrossRank.platformCount, 1);
      // 关键验证：对 period=7 (11-14 ~ 11-20)，跨组内容对 G2 首发于 11-15 属于本周期新作品，对 G1 首发于 11-05 不属于近 7 天新作品！
      const g1Analysis7 = buildStatsAnalysisData({ period: 7, to: "2026-11-20", group: G1 }, deps);
      const g2Analysis7 = buildStatsAnalysisData({ period: 7, to: "2026-11-20", group: G2 }, deps);
      assert.strictEqual(
        g1Analysis7.newWorks.items.some((r) => r.contentKey === "file:/v/cross.mp4"),
        false,
        "跨组内容对 G1 首发在 11-05，近 7 天不应算新作品"
      );
      assert.strictEqual(
        g2Analysis7.newWorks.items.some((r) => r.contentKey === "file:/v/cross.mp4"),
        true,
        "跨组内容对 G2 首发在 11-15，近 7 天应算新作品"
      );

      // 1i. 趋势（按天 & 按时段）按分组隔离跨组内容
      const trendAll = buildContentTrendData({ contentKey: "file:/v/cross.mp4", to: "2026-11-20" }, deps);
      const trendG1 = buildContentTrendData({ contentKey: "file:/v/cross.mp4", to: "2026-11-20", group: G1 }, deps);
      const trendG2 = buildContentTrendData({ contentKey: "file:/v/cross.mp4", to: "2026-11-20", group: G2 }, deps);
      assert.deepStrictEqual(trendAll.platforms.map((p) => p.platform), ["抖音", "快手", "小红书"]);
      assert.deepStrictEqual(trendG1.platforms.map((p) => p.platform), ["抖音", "快手"]);
      assert.deepStrictEqual(trendG2.platforms.map((p) => p.platform), ["小红书"]);
      assert.strictEqual(
        buildContentTrendData({ contentKey: "file:/v/g1-main.mp4", to: "2026-11-20", group: G2 }, deps).found,
        false,
        "G1 专属内容在 G2 趋势查询中应返回 found=false"
      );

      const intraG1 = buildContentIntradayData({ contentKey: "file:/v/cross.mp4", days: 3, to: "2026-11-20", group: G1 }, deps);
      const intraG2 = buildContentIntradayData({ contentKey: "file:/v/cross.mp4", days: 3, to: "2026-11-20", group: G2 }, deps);
      assert.deepStrictEqual(intraG1.platforms.map((p) => p.platform), ["抖音"]);
      assert.deepStrictEqual(intraG2.platforms.map((p) => p.platform), ["小红书"]);

      // 1j. filterSummaryRowsForGroup 纯函数验证：不重复计入同一分组的同一 workId / contentKey
      const dupWorkSummary = [
        {
          contentKey: "file:/v/dup.mp4",
          title: "重复验证",
          firstPublishDate: "2026-11-10",
          platformCount: 2,
          totalPlay: 300,
          perPlatform: {
            "抖音|组A": {
              play: 100,
              like: 10,
              workIds: ["W1"],
              works: [
                { workId: "W1", platform: "抖音", group: "组A", play: 100, like: 10 },
                { workId: "W1", platform: "抖音", group: "组A", play: 100, like: 10 },
              ],
            },
            "小红书|组B": {
              play: 200,
              like: 20,
              workIds: ["W2"],
              works: [{ workId: "W2", platform: "小红书", group: "组B", play: 200, like: 20 }],
            },
          },
        },
      ];
      const splitA = filterSummaryRowsForGroup(dupWorkSummary, "组A");
      assert.strictEqual(splitA.length, 1);
      assert.strictEqual(splitA[0].totalPlay, 100, "同一分组内重复作品不得重复累加");
      assert.strictEqual(splitA[0].platformCount, 1);
      assert.deepStrictEqual(splitA[0].groups, ["组A"]);

      // 1k. 「全部」回归：buildStatsAnalysis 不传 group 与全局结果 bit-for-bit 一致
      const wbGlobal = buildStatsWorkbookData({ from: "2026-10-22", to: "2026-11-20" }, deps);
      const stripMeta = (obj) => {
        const clone = { ...obj };
        delete clone.defaultCutoffDate;
        delete clone._cleanedAccountRows;
        return clone;
      };
      assert.deepStrictEqual(
        stripMeta(wbGlobal.analysis),
        stripMeta(allAnalysis),
        "「全部」全局分析与工作簿全局「分析」必须完全一致"
      );
      assert.strictEqual(wbGlobal.group, null);
      assert.strictEqual(wbGlobal.sheets["分析"][0][0], "文字小结");
      assert.strictEqual(
        String(wbGlobal.sheets["分析"][1][0] || "").startsWith("分组："),
        false,
        "全局「分析」sheet 不应额外插入分组行（保持改动前结构）"
      );
      const globalMetaMap = new Map(wbGlobal.sheets["导出信息"].slice(1).map((r) => [r[0], r[1]]));
      assert.strictEqual(globalMetaMap.has("导出分组"), false, "全局导出信息不得多出「导出分组」行");

      // 全局工作簿应按 accountGroupOrder（人间善恶录=0, 赛博老司机=1）附加分分组分析 sheet
      assert.deepStrictEqual(wbGlobal.sheetOrder, [
        "作品日明细",
        "作品时段明细",
        "作品跨平台汇总",
        "平台日汇总",
        "账号日快照",
        "分析",
        `分析-${G1}`,
        `分析-${G2}`,
        "字段说明",
        "导出信息",
      ]);
      // 分分组 sheet 分析结论必须与直接调 buildStatsAnalysisData({ group }) 完全一致！
      assert.deepStrictEqual(
        stripMeta(wbGlobal.groupAnalyses[G1]),
        stripMeta(g1Analysis),
        "全局导出「分析-人间善恶录」必须与单分组分析完全一致"
      );
      assert.deepStrictEqual(
        stripMeta(wbGlobal.groupAnalyses[G2]),
        stripMeta(g2Analysis),
        "全局导出「分析-赛博老司机」必须与单分组分析完全一致"
      );
      assert.strictEqual(wbGlobal.sheets[`分析-${G1}`][1][0], `分组：${G1}`);
      assert.strictEqual(wbGlobal.sheets[`分析-${G2}`][1][0], `分组：${G2}`);

      // 「作品跨平台汇总」和「平台日汇总」分组列 + 字段说明 1:1 校验
      assert.strictEqual(wbGlobal.sheets["作品跨平台汇总"][0][2], "分组");
      assert.strictEqual(wbGlobal.sheets["平台日汇总"][0][2], "分组");
      const crossExcelRow = wbGlobal.sheets["作品跨平台汇总"]
        .slice(1)
        .find((r) => r[0] === "file:/v/cross.mp4");
      assert.strictEqual(crossExcelRow[2], `${G1}、${G2}`, "跨平台汇总分组列按 accountGroupOrder 排序");
      const schemaRows = wbGlobal.sheets["字段说明"].slice(1);
      for (const sheetName of SHEET_NAMES) {
        if (sheetName === "分析") continue;
        const headers = wbGlobal.sheets[sheetName][0];
        const docs = schemaRows.filter((r) => r[0] === sheetName).map((r) => r[1]);
        assert.deepStrictEqual(docs, headers, `字段说明与 ${sheetName} 实际表头必须 1:1 对齐`);
      }

      // 单分组导出（options.group = G2）：所有 sheet 过滤为 G2，不再重复生成「分析-赛博老司机」
      const wbG2 = buildStatsWorkbookData({ from: "2026-10-22", to: "2026-11-20", group: G2 }, deps);
      assert.strictEqual(wbG2.group, G2);
      assert.deepStrictEqual(wbG2.sheetOrder, SHEET_NAMES, "单分组导出应保持 8 个标准 sheet");
      assert.ok(wbG2.sheets["作品日明细"].slice(1).every((r) => r[2] === G2));
      assert.ok(wbG2.sheets["作品时段明细"].slice(1).every((r) => r[4] === G2));
      assert.ok(wbG2.sheets["作品跨平台汇总"].slice(1).every((r) => r[2] === G2));
      assert.ok(wbG2.sheets["平台日汇总"].slice(1).every((r) => r[2] === G2));
      assert.ok(wbG2.sheets["账号日快照"].slice(1).every((r) => r[2] === G2));
      assert.strictEqual(wbG2.sheets["分析"][1][0], `分组：${G2}`);
      assert.deepStrictEqual(stripMeta(wbG2.analysis), stripMeta(g2Analysis));
      const g2MetaMap = new Map(wbG2.sheets["导出信息"].slice(1).map((r) => [r[0], r[1]]));
      assert.strictEqual(g2MetaMap.get("导出分组"), G2);

      // 写出并 SheetJS 读回验证
      const globalXlsx = path.join(tmpRoot, "global-s16.xlsx");
      writeStatsXlsx(wbGlobal, globalXlsx);
      const readGlobal = xlsx.readFile(globalXlsx);
      assert.deepStrictEqual(readGlobal.SheetNames, wbGlobal.sheetOrder);
      assert.strictEqual(readGlobal.Sheets[`分析-${G1}`].A2.v, `分组：${G1}`);
      assert.strictEqual(readGlobal.Sheets[`分析-${G2}`].A2.v, `分组：${G2}`);

      console.log("✓ 1. 分组过滤（7 节分析/汇总/趋势/导出）、跨组内容拆分与「全部」回归校验通过");
    }

    /* ---------- 2. 同一 platform|workId 挂两分组时，全局分分组 sheet 与单分组分析一致 ---------- */
    {
      const sharedDeps = {
        now: tsUtc8("2026-11-20", "18:00:00"),
        listAccounts: () => [
          { group: "甲组", platform: "抖音" },
          { group: "乙组", platform: "抖音" },
        ],
        readWorks: (g) => ({
          works: [
            {
              workId: "SHARED_W1",
              title: "共享账号视频",
              publishTime: tsUtc8("2026-11-10", "12:00:00"),
            },
            {
              workId: g === "甲组" ? "A_ONLY" : "B_ONLY",
              title: g === "甲组" ? "甲组专属" : "乙组专属",
              publishTime: tsUtc8("2026-11-12", "12:00:00"),
            },
          ],
        }),
        readWorksDaily: (g) =>
          g === "甲组"
            ? {
                SHARED_W1: { "2026-11-18": { play: 100 }, "2026-11-19": { play: 220 } },
                A_ONLY: { "2026-11-18": { play: 50 }, "2026-11-19": { play: 80 } },
              }
            : {
                SHARED_W1: { "2026-11-18": { play: 100 }, "2026-11-19": { play: 250 } },
                B_ONLY: { "2026-11-18": { play: 400 }, "2026-11-19": { play: 900 } },
              },
        readWorksIntraday: () => ({}),
        readDaily: () => ({}),
        readPushRecords: () => [],
        readGroupOrderMap: () => ({ 甲组: 0, 乙组: 1 }),
      };

      const wb = buildStatsWorkbookData({ from: "2026-11-01", to: "2026-11-19" }, sharedDeps);
      const aDirect = buildStatsAnalysisData({ period: 19, to: "2026-11-19", group: "甲组" }, sharedDeps);
      const bDirect = buildStatsAnalysisData({ period: 19, to: "2026-11-19", group: "乙组" }, sharedDeps);
      const strip = (x) => {
        const c = { ...x };
        delete c.defaultCutoffDate;
        delete c._cleanedAccountRows;
        return c;
      };
      assert.deepStrictEqual(strip(wb.groupAnalyses["甲组"]), strip(aDirect));
      assert.deepStrictEqual(strip(wb.groupAnalyses["乙组"]), strip(bDirect));
      // 乙组排行中必须看到 SHARED_W1 (play=250) 和 B_ONLY (play=900)，不得丢掉 SHARED_W1 或重复计数
      const bTopIds = bDirect.rankings.byPlay.top.map((r) => r.contentKey);
      assert.ok(bTopIds.includes("unlinked:抖音:SHARED_W1"));
      assert.ok(bTopIds.includes("unlinked:抖音:B_ONLY"));
      assert.strictEqual(bTopIds.includes("unlinked:抖音:A_ONLY"), false);
      console.log("✓ 2. 共享 workId 跨两分组场景分分组 sheet 与单分组分析一致通过");
    }

    /* ---------- 3. Excel sheet 名清洗（超 31 字符 / 非法字符 / 单引号 / 代理对 / 碰撞去重 / 写盘读回） ---------- */
    {
      const used = new Set(SHEET_NAMES.map((n) => n.toLowerCase()));
      const n1 = buildGroupAnalysisSheetName("A:B\\C/D?E*F[G]H", used);
      assert.strictEqual(n1, "分析-A_B_C_D_E_F_G_H");
      assert.ok(n1.length <= EXCEL_SHEET_NAME_MAX_LEN);
      assert.strictEqual(/[:\\/?*[\]]/.test(n1), false);

      const nQuote = buildGroupAnalysisSheetName("'带首尾单引号'", used);
      assert.strictEqual(nQuote, "分析-带首尾单引号");
      assert.strictEqual(nQuote.startsWith("'") || nQuote.endsWith("'"), false);

      const nEmpty = buildGroupAnalysisSheetName(":::???***", used);
      assert.strictEqual(nEmpty, "分析-分组");

      const longA = "这是一个超级无敌长到绝对超过三十一个字符的矩阵分组名称第一号";
      const longB = "这是一个超级无敌长到绝对超过三十一个字符的矩阵分组名称第二号";
      const sLongA = buildGroupAnalysisSheetName(longA, used);
      const sLongB = buildGroupAnalysisSheetName(longB, used);
      assert.ok(sLongA.length <= 31, `超长名长度超标: ${sLongA.length}`);
      assert.ok(sLongB.length <= 31, `冲突去重后长度超标: ${sLongB.length}`);
      assert.notStrictEqual(sLongA.toLowerCase(), sLongB.toLowerCase(), "截断碰撞必须去重");
      assert.ok(sLongB.endsWith("-2"));

      // 大小写不敏感碰撞去重
      const caseA = buildGroupAnalysisSheetName("Alpha", used);
      const caseB = buildGroupAnalysisSheetName("alpha", used);
      assert.strictEqual(caseA, "分析-Alpha");
      assert.strictEqual(caseB, "分析-alpha-2");

      // Emoji 代理对截断不得产生孤立高代理项
      const emojiGroup = "测试分组名称".repeat(4) + "😀😁😂😃😄";
      const sEmoji = buildGroupAnalysisSheetName(emojiGroup, used);
      assert.ok(sEmoji.length <= 31);
      const lastCode = sEmoji.charCodeAt(sEmoji.length - 1);
      assert.strictEqual(lastCode >= 0xd800 && lastCode <= 0xdbff, false, "截断不得留下孤立高代理项");

      // 端到端写入 SheetJS 并读回校验
      const dirtyGroups = [
        "矩阵:主号/1?*[测试]",
        longA,
        longB,
        "'单引号组'",
      ];
      const dirtyDeps = {
        now: tsUtc8("2026-11-20", "12:00:00"),
        listAccounts: () => dirtyGroups.map((g) => ({ group: g, platform: "抖音" })),
        readWorks: (g) => ({
          works: [{ workId: `W_${g.length}`, title: "测试", publishTime: tsUtc8("2026-11-18") }],
        }),
        readWorksDaily: (g) => ({ [`W_${g.length}`]: { "2026-11-19": { play: 100 } } }),
        readWorksIntraday: () => ({}),
        readDaily: () => ({}),
        readPushRecords: () => [],
      };
      const dirtyWb = buildStatsWorkbookData({ from: "2026-11-15", to: "2026-11-19" }, dirtyDeps);
      assert.strictEqual(dirtyWb.groupSheetNames.length, 4);
      for (const sn of dirtyWb.groupSheetNames) {
        assert.ok(sn.length <= 31, `sheet 名超长: ${sn}`);
        assert.strictEqual(/[:\\/?*[\]]/.test(sn), false, `sheet 名含非法字符: ${sn}`);
      }
      const dirtyPath = path.join(tmpRoot, "dirty-groups.xlsx");
      writeStatsXlsx(dirtyWb, dirtyPath);
      const dirtyRead = xlsx.readFile(dirtyPath);
      assert.deepStrictEqual(dirtyRead.SheetNames, dirtyWb.sheetOrder);

      // 默认导出文件名含分组名清洗
      assert.strictEqual(
        buildDefaultExportFileName("2026-11-01", "2026-11-20", "赛博老司机"),
        "MatrixMedia-作品数据-赛博老司机-2026-11-01_2026-11-20.xlsx"
      );
      assert.strictEqual(
        buildDefaultExportFileName("2026-11-01", "2026-11-20", ""),
        "MatrixMedia-作品数据-2026-11-01_2026-11-20.xlsx"
      );
      assert.strictEqual(
        sanitizeExcelSheetSegment("a/b:c*d?e[f]g\\h"),
        "a_b_c_d_e_f_g_h"
      );
      console.log("✓ 3. Excel sheet 名清洗（31 字符/非法字符/单引号/代理对/去重/写回读回）通过");
    }

    /* ---------- 4. S15 statsStartDate 在各分组分析与导出中独立生效 ---------- */
    {
      const { G1, G2, deps } = makeTwoMatrixDeps({
        groupSettings: {
          人间善恶录: "2026-11-05", // 排除 G1_DY_OLD (11-02)，保留 G1_DY_CROSS (11-05) 及以后
          赛博老司机: "2026-11-10", // 排除 G2_XHS_OLD (11-08)，保留 G2_XHS_1 (11-12) 及以后
        },
      });
      const g1A = buildStatsAnalysisData({ period: 30, to: "2026-11-20", group: G1 }, deps);
      const g2A = buildStatsAnalysisData({ period: 30, to: "2026-11-20", group: G2 }, deps);
      assert.strictEqual(
        g1A.rankings.byPlay.top.some((r) => r.contentKey === "unlinked:抖音:G1_DY_OLD"),
        false,
        "G1 起点日期 11-05 应排除 11-02 的 G1_DY_OLD"
      );
      assert.strictEqual(
        g1A.rankings.byPlay.top.some((r) => r.contentKey === "file:/v/cross.mp4"),
        true,
        "G1 起点日期 11-05 应保留 11-05 的跨组作品"
      );
      assert.strictEqual(
        g2A.rankings.byPlay.top.some((r) => r.contentKey === "unlinked:小红书:G2_XHS_OLD"),
        false,
        "G2 起点日期 11-10 应排除 11-08 的 G2_XHS_OLD"
      );
      assert.strictEqual(
        buildContentTrendData({ contentKey: "unlinked:抖音:G1_DY_OLD", to: "2026-11-20", group: G1 }, deps).found,
        false,
        "起点前作品在分组趋势查询中应被排除"
      );
      const wbAll = buildStatsWorkbookData({ from: "2026-11-01", to: "2026-11-20" }, deps);
      assert.strictEqual(
        wbAll.groupAnalyses[G1].rankings.byPlay.top.some((r) => r.contentKey === "unlinked:抖音:G1_DY_OLD"),
        false
      );
      assert.strictEqual(
        wbAll.groupAnalyses[G2].rankings.byPlay.top.some((r) => r.contentKey === "unlinked:小红书:G2_XHS_OLD"),
        false
      );
      console.log("✓ 4. S15 statsStartDate 按各自分组在分析/趋势/导出中独立生效通过");
    }

    /* ---------- 5. 未知分组报错 & CLI stats-export --group 测试 ---------- */
    {
      const { G1, G2, deps } = makeTwoMatrixDeps();

      // 5a. 核心函数未知分组均抛 UNKNOWN_GROUP
      for (const [label, fn] of [
        ["buildStatsAnalysisData", () => buildStatsAnalysisData({ group: "不存在分组" }, deps)],
        ["buildStatsWorkbookData", () => buildStatsWorkbookData({ group: "不存在分组" }, deps)],
        ["buildContentSummaryData", () => buildContentSummaryData({ group: "不存在分组" }, deps)],
        [
          "buildContentTrendData",
          () => buildContentTrendData({ contentKey: "file:/v/g1-main.mp4", group: "不存在分组" }, deps),
        ],
        [
          "buildContentIntradayData",
          () => buildContentIntradayData({ contentKey: "file:/v/g1-main.mp4", group: "不存在分组" }, deps),
        ],
      ]) {
        assert.throws(
          fn,
          (err) => {
            assert.strictEqual(err.code, UNKNOWN_GROUP_CODE, `${label} 应抛 UNKNOWN_GROUP`);
            assert.ok(err.message.includes("未知分组"), `${label} 报错应说明未知分组`);
            assert.ok(err.message.includes(G1) && err.message.includes(G2), "报错应列出可用分组");
            return true;
          },
          `${label} 未知分组应抛错`
        );
      }

      // 5b. 打包并测试 parseStatsArgs & runStatsCli
      const cliBundleDir = path.join(tmpRoot, "cli-bundle");
      fs.mkdirSync(cliBundleDir, { recursive: true });
      const parseOut = path.join(cliBundleDir, "parseStatsArgs.cjs");
      const runOut = path.join(cliBundleDir, "runStatsCli.cjs");
      await build({
        entryPoints: [path.resolve(__dirname, "../src/main/cli/parseStatsArgs.js")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: parseOut,
      });
      await build({
        entryPoints: [path.resolve(__dirname, "../src/main/cli/runStatsCli.js")],
        bundle: true,
        platform: "node",
        format: "cjs",
        external: ["electron", "xlsx"],
        outfile: runOut,
        plugins: [
          {
            name: "stub-collector",
            setup(b) {
              b.onResolve({ filter: /(collector|accountLookup)\.js$/ }, (args) => ({
                path: args.path,
                namespace: "stub",
              }));
              b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
                contents: "module.exports = { collectAccount: async () => ({}), resolveTaskPartition: () => '' };",
                loader: "js",
              }));
            },
          },
        ],
      });

      const { parseStatsArgs, statsHelpText } = require(parseOut);
      const origLoadCli = Module._load;
      Module._load = function (req, ...rest) {
        if (req === "electron") {
          return {
            app: { getPath: (name) => path.join(tmpRoot, name), getVersion: () => "0.14.9-s16.test" },
          };
        }
        if (req === "xlsx") return xlsx;
        return origLoadCli.call(this, req, ...rest);
      };
      let runStatsCli;
      try {
        ({ runStatsCli } = require(runOut));
      } finally {
        Module._load = origLoadCli;
      }

      // parseStatsArgs 校验
      const p1 = parseStatsArgs(["--out", "a.xlsx", "--group", G2], "export");
      assert.strictEqual(p1.ok, true);
      assert.strictEqual(p1.value.group, G2);

      const p2 = parseStatsArgs(["--out=a.xlsx", `--group=${G1}`], "export");
      assert.strictEqual(p2.ok, true);
      assert.strictEqual(p2.value.group, G1);

      const pEmpty1 = parseStatsArgs(["--out", "a.xlsx", "--group"], "export");
      assert.strictEqual(pEmpty1.ok, false);
      const pEmpty2 = parseStatsArgs(["--out", "a.xlsx", "--group="], "export");
      assert.strictEqual(pEmpty2.ok, false);
      assert.ok(statsHelpText("stats-export").includes("--group"), "help 文本应包含 --group 说明");

      const captureCli = async (params) => {
        const logs = [];
        const origLog = console.log;
        console.log = (...a) => logs.push(a.join(" "));
        try {
          const code = await runStatsCli(params);
          return { code, json: JSON.parse(logs.join("\n")) };
        } finally {
          console.log = origLog;
        }
      };

      // CLI --group 赛博老司机 → exit 0，仅导出赛博老司机
      const cliG2Path = path.join(tmpRoot, "cli-g2.xlsx");
      const resG2 = await captureCli({
        action: "export",
        out: cliG2Path,
        from: "2026-11-01",
        to: "2026-11-20",
        group: G2,
        deps,
      });
      assert.strictEqual(resG2.code, 0);
      assert.strictEqual(resG2.json.success, true);
      assert.strictEqual(resG2.json.group, G2);
      assert.ok(fs.existsSync(cliG2Path));
      const cliG2Wb = xlsx.readFile(cliG2Path);
      assert.deepStrictEqual(cliG2Wb.SheetNames, SHEET_NAMES);
      const cliG2Daily = xlsx.utils.sheet_to_json(cliG2Wb.Sheets["作品日明细"], { header: 1 }).slice(1);
      assert.ok(cliG2Daily.length > 0 && cliG2Daily.every((r) => r[2] === G2));

      // CLI 省略 --group → exit 0，含全局「分析」与两个分分组「分析-<分组>」
      const cliAllPath = path.join(tmpRoot, "cli-all.xlsx");
      const resAll = await captureCli({
        action: "export",
        out: cliAllPath,
        from: "2026-11-01",
        to: "2026-11-20",
        deps,
      });
      assert.strictEqual(resAll.code, 0);
      assert.strictEqual(resAll.json.success, true);
      assert.strictEqual(resAll.json.group, undefined);
      const cliAllWb = xlsx.readFile(cliAllPath);
      assert.ok(cliAllWb.SheetNames.includes("分析"));
      assert.ok(cliAllWb.SheetNames.includes(`分析-${G1}`));
      assert.ok(cliAllWb.SheetNames.includes(`分析-${G2}`));

      // CLI 未知分组 → exit 2，不写文件
      const cliUnknownPath = path.join(tmpRoot, "cli-unknown.xlsx");
      const resUnknown = await captureCli({
        action: "export",
        out: cliUnknownPath,
        group: "不存在分组",
        deps,
      });
      assert.strictEqual(resUnknown.code, 2, "未知分组必须返回退出码 2");
      assert.strictEqual(resUnknown.json.success, false);
      assert.strictEqual(resUnknown.json.group, "不存在分组");
      assert.ok(resUnknown.json.error.includes("未知分组"));
      assert.strictEqual(fs.existsSync(cliUnknownPath), false, "未知分组不得写出文件");

      console.log("✓ 5. CLI stats-export --group（单分组/全量/空值/未知分组 exit 2）与未知分组报错通过");
    }

    /* ---------- 6. IPC 层（stats:get-analysis / trend / intraday / export-xlsx / chart PNG group 命名） ---------- */
    {
      const { G1, G2, deps } = makeTwoMatrixDeps();
      const ipcHandlers = new Map();
      const saveDialogCalls = [];
      const openDialogCalls = [];
      const docsDir = path.join(tmpRoot, "docs");
      const batchParentDir = path.join(tmpRoot, "batch-charts");
      fs.mkdirSync(docsDir, { recursive: true });
      fs.mkdirSync(batchParentDir, { recursive: true });
      let mockSaveResult = { canceled: false, filePath: "" };

      const origLoad = Module._load;
      const indexPath = require.resolve("../src/main/services/dataStats/index.js");
      delete require.cache[indexPath];
      Module._load = function (req, ...rest) {
        if (req === "electron") {
          return {
            ipcMain: {
              handle: (ch, fn) => ipcHandlers.set(ch, fn),
            },
            BrowserWindow: { fromWebContents: () => ({}) },
            dialog: {
              showSaveDialog: async (_win, opts) => {
                saveDialogCalls.push(opts);
                return mockSaveResult;
              },
              showOpenDialog: async (_win, opts) => {
                openDialogCalls.push(opts);
                return { canceled: false, filePaths: [batchParentDir] };
              },
            },
            app: {
              getPath: (name) => (name === "documents" ? docsDir : path.join(tmpRoot, name)),
            },
          };
        }
        return origLoad.call(this, req, ...rest);
      };
      try {
        const { registerDataStatsIpc } = require(indexPath);
        registerDataStatsIpc({ exportDeps: deps });
        const localEv = { sender: {}, senderFrame: { url: "file:///app/index.html" } };

        // 6a. stats:get-analysis 支持 group，未知分组返回 UNKNOWN_GROUP
        const getAnalysis = ipcHandlers.get("stats:get-analysis");
        const rG2 = await getAnalysis(localEv, { period: 30, to: "2026-11-20", group: G2 });
        assert.strictEqual(rG2.ok, true);
        assert.strictEqual(rG2.group, G2);
        assert.ok(rG2.fansTrend.accounts.every((a) => a.group === G2));

        const rBad = await getAnalysis(localEv, { period: 30, group: "未知组" });
        assert.strictEqual(rBad.ok, false);
        assert.strictEqual(rBad.errorCode, UNKNOWN_GROUP_CODE);

        // 6b. stats:get-content-trend & stats:get-content-intraday 透传 group
        const getTrend = ipcHandlers.get("stats:get-content-trend");
        const rTrend = await getTrend(localEv, { contentKey: "file:/v/cross.mp4", to: "2026-11-20", group: G2 });
        assert.strictEqual(rTrend.ok, true);
        assert.deepStrictEqual(rTrend.platforms.map((p) => p.platform), ["小红书"]);

        const getIntraday = ipcHandlers.get("stats:get-content-intraday");
        const rIntra = await getIntraday(localEv, { contentKey: "file:/v/cross.mp4", days: 3, to: "2026-11-20", group: G1 });
        assert.strictEqual(rIntra.ok, true);
        assert.deepStrictEqual(rIntra.platforms.map((p) => p.platform), ["抖音"]);

        // 6c. stats:save-chart-image 单图带 group（不重复加前缀）
        const saveChart = ipcHandlers.get("stats:save-chart-image");
        const pngOut = path.join(tmpRoot, "single-chart.png");
        mockSaveResult = { canceled: false, filePath: pngOut };
        const rPng1 = await saveChart(localEv, {
          dataUrl: VALID_PNG_DATA_URL,
          name: `${G2}-平台对比`,
          group: G2,
          date: "2026-11-20",
        });
        assert.strictEqual(rPng1.ok, true);
        assert.strictEqual(
          path.basename(saveDialogCalls[saveDialogCalls.length - 1].defaultPath),
          `${G2}-平台对比-2026-11-20.png`,
          "name 已带分组前缀时不得重复拼接分组名"
        );

        const rPng2 = await saveChart(localEv, {
          dataUrl: VALID_PNG_DATA_URL,
          name: "粉丝趋势",
          group: G1,
          date: "2026-11-20",
        });
        assert.strictEqual(rPng2.ok, true);
        assert.strictEqual(
          path.basename(saveDialogCalls[saveDialogCalls.length - 1].defaultPath),
          `${G1}-粉丝趋势-2026-11-20.png`,
          "未带前缀时应自动拼接分组名"
        );

        // 6d. stats:save-chart-images-batch 目录名与文件名均带分组名
        const saveBatch = ipcHandlers.get("stats:save-chart-images-batch");
        const rBatch = await saveBatch(localEv, {
          group: G2,
          period: 30,
          date: "2026-11-20",
          items: [
            { name: `${G2}-1-总览-平台占比`, dataUrl: VALID_PNG_DATA_URL },
            { name: "2-平台对比", dataUrl: VALID_PNG_DATA_URL },
          ],
        });
        assert.strictEqual(rBatch.ok, true);
        assert.ok(
          path.basename(rBatch.dir).startsWith(`MatrixMedia-图表-${G2}-近30天-2026-11-20-`),
          `批量导出目录名应包含分组名，实际: ${path.basename(rBatch.dir)}`
        );
        assert.deepStrictEqual(
          rBatch.files.map((f) => path.basename(f)),
          [
            `${G2}-1-总览-平台占比-2026-11-20.png`,
            `${G2}-2-平台对比-2026-11-20.png`,
          ]
        );

        // 6e. stats:export-xlsx 带 group 时建议文件名带分组名且导出过滤
        const exportXlsx = ipcHandlers.get("stats:export-xlsx");
        const ipcXlsxOut = path.join(tmpRoot, "ipc-g1.xlsx");
        mockSaveResult = { canceled: false, filePath: ipcXlsxOut };
        const rExp = await exportXlsx(localEv, { from: "2026-11-01", to: "2026-11-20", group: G1 });
        assert.strictEqual(rExp.ok, true);
        assert.strictEqual(rExp.group, G1);
        assert.strictEqual(
          path.basename(saveDialogCalls[saveDialogCalls.length - 1].defaultPath),
          `MatrixMedia-作品数据-${G1}-2026-11-01_2026-11-20.xlsx`
        );
      } finally {
        Module._load = origLoad;
        delete require.cache[indexPath];
      }
      console.log("✓ 6. IPC 层分组参数（分析/趋势/单图&批量PNG/Excel导出）通过");
    }

    /* ---------- 7. GUI dataStats/index.vue 编译与分组切换/持久化/复制/PNG/趋势弹窗验证 ---------- */
    {
      const indexVuePath = path.resolve(__dirname, "../src/renderer/views/dataStats/index.vue");
      const sfc = vueCompiler.parseComponent(fs.readFileSync(indexVuePath, "utf8"));
      const compiled = vueCompiler.compile(sfc.template.content);
      assert.strictEqual(
        compiled.errors.length,
        0,
        `dataStats/index.vue 模板编译失败: ${compiled.errors.join("; ")}`
      );
      assert.ok(sfc.template.content.includes("analysis-group-select"), "模板应包含分组下拉选择器");
      assert.ok(sfc.template.content.includes("onAnalysisGroupChange"), "模板应绑定分组切换事件");
      // 校验作品趋势弹窗已移出 lazy 的作品汇总 tab（在 </el-tabs> 之后）
      const tabsCloseIdx = sfc.template.content.lastIndexOf("</el-tabs>");
      const trendDialogIdx = sfc.template.content.indexOf(":title=\"contentTrendDialogTitle\"");
      assert.ok(
        tabsCloseIdx > 0 && trendDialogIdx > tabsCloseIdx,
        "作品趋势弹窗必须位于 </el-tabs> 外，避免未访问「作品汇总」tab 时数据分析页弹窗无法打开"
      );

      const bundlePath = path.join(tmpRoot, "dataStats-index-s16.cjs");
      await build({
        stdin: {
          contents: sfc.script.content,
          resolveDir: path.dirname(indexVuePath),
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
                  "module.exports = { default: {}, dailyToRows: () => [], buildCollectAccounts: () => [], collectAccounts: async () => ({}), getCollectLogs: async () => [], getOverviewStats: async () => ({ daily: {}, accounts: [{ group: '赛博老司机', platform: '小红书' }, { group: '人间善恶录', platform: '抖音' }] }), onStatsProgress: () => () => {}, loadSettings: () => ({ enabled: false, time: '10:00', lastRunDate: '' }), subscribeRunComplete: () => () => {}, subscribeSettings: () => () => {}, updateSettings: () => ({ ok: true, settings: {} }) };",
                loader: "js",
              }));
            },
          },
        ],
      });

      const origLoad = Module._load;
      const origLS = global.localStorage;
      const lsMap = new Map();
      // 故意让「赛博老司机」groupOrder=0、「人间善恶录」groupOrder=1（与拼音相反）以检验按 accountGroupOrder 排序
      lsMap.set(
        "accountTree",
        JSON.stringify({
          人间善恶录: { meta: { groupOrder: 1 }, children: [{ meta: { pt: "抖音" } }] },
          赛博老司机: { meta: { groupOrder: 0 }, children: [{ meta: { pt: "小红书" } }] },
        })
      );
      global.localStorage = {
        getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
        setItem: (k, v) => lsMap.set(k, String(v)),
        removeItem: (k) => lsMap.delete(k),
      };

      const invokeCalls = [];
      let copiedText = "";
      Module._load = function (req, ...rest) {
        if (req === "electron") {
          return {
            ipcRenderer: {
              invoke: async (ch, payload) => {
                invokeCalls.push({ ch, payload });
                if (ch === "stats:get-analysis") {
                  return {
                    ok: true,
                    to: "2026-11-20",
                    period: payload.period || 30,
                    group: payload.group || null,
                    snapshotDays: 10,
                    summary: { lines: ["总播放 +1000"], text: "总播放 +1000" },
                    fansTrend: { accounts: [] },
                    newWorksFirst24h: { items: [] },
                  };
                }
                if (ch === "stats:save-chart-image") return { ok: true, filePath: "/tmp/c.png" };
                if (ch === "stats:save-chart-images-batch") {
                  return { ok: true, dir: "/tmp/batch", count: payload.items.length };
                }
                if (ch === "stats:get-content-trend" || ch === "stats:get-content-intraday") {
                  return { ok: true, found: true, title: "跨矩阵共享专题", date: "2026-11-20", dates: [], platforms: [] };
                }
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
        return origLoad.call(this, req, ...rest);
      };

      const mountCtx = (comp) => {
        const mockChartRef = { resize: () => {}, getDataURL: () => VALID_PNG_DATA_URL };
        const ctx = {
          ...comp.data(),
          $refs: {
            chartOverviewTrend: mockChartRef,
            chartOverviewPie: mockChartRef,
            chartPlatformCompare: mockChartRef,
            chartRankingTop10: mockChartRef,
            chartNewWorksLine: mockChartRef,
            chartNewWorksPie: mockChartRef,
            chartNewWorksFirst24h: mockChartRef,
            chartPublishTimeHeatmap: mockChartRef,
            chartFansTrend: mockChartRef,
            chartContentTrend: mockChartRef,
          },
          $nextTick: (fn) => fn(),
          $message: { success: () => {}, warning: () => {}, error: () => {} },
        };
        for (const [k, fn] of Object.entries(comp.computed)) {
          Object.defineProperty(ctx, k, { get: () => fn.call(ctx), configurable: true });
        }
        for (const [k, fn] of Object.entries(comp.methods)) {
          ctx[k] = fn.bind(ctx);
        }
        return ctx;
      };

      try {
        const comp = require(bundlePath).default;
        const ctx = mountCtx(comp);

        // 7a. 分组按 accountGroupOrder 排序，且默认选第一个分组（赛博老司机）
        assert.deepStrictEqual(ctx.analysisGroupOptions, ["赛博老司机", "人间善恶录"]);
        ctx.reconcileAnalysisGroupSelection();
        assert.strictEqual(ctx.analysisGroup, "赛博老司机", "首次无持久化选择时应默认选第一个分组");
        assert.strictEqual(ctx.activeAnalysisGroup, "赛博老司机");

        await ctx.loadAnalysis();
        assert.deepStrictEqual(invokeCalls[invokeCalls.length - 1], {
          ch: "stats:get-analysis",
          payload: { period: 30, group: "赛博老司机" },
        });

        // 7b. 复制小结带分组名
        await ctx.copyAnalysisSummary();
        assert.strictEqual(copiedText, "【赛博老司机】\n总播放 +1000");

        // 7c. 单图 & 批量 PNG 导出带分组名
        await ctx.saveChartImage("chartPlatformCompare", "平台对比", "2026-11-20");
        const singleCall = invokeCalls[invokeCalls.length - 1];
        assert.strictEqual(singleCall.ch, "stats:save-chart-image");
        assert.strictEqual(singleCall.payload.name, "赛博老司机-平台对比");
        assert.strictEqual(singleCall.payload.group, "赛博老司机");

        await ctx.exportAllCharts();
        const batchCall = invokeCalls[invokeCalls.length - 1];
        assert.strictEqual(batchCall.ch, "stats:save-chart-images-batch");
        assert.strictEqual(batchCall.payload.group, "赛博老司机");
        assert.ok(batchCall.payload.items.every((it) => it.name.startsWith("赛博老司机-")));

        // 7d. 从数据分析页打开作品趋势弹窗透传 group 与 to（含按时段 + 弹窗保存图片）
        await ctx.openContentTrend(
          { contentKey: "file:/v/cross.mp4", title: "跨矩阵共享专题" },
          { group: ctx.activeAnalysisGroup, to: ctx.analysisChartDate }
        );
        assert.strictEqual(ctx.contentTrendDialogTitle, "播放趋势 · 赛博老司机 · 跨矩阵共享专题");
        assert.deepStrictEqual(invokeCalls[invokeCalls.length - 1], {
          ch: "stats:get-content-trend",
          payload: { contentKey: "file:/v/cross.mp4", to: "2026-11-20", group: "赛博老司机" },
        });
        await ctx.loadContentIntraday();
        assert.deepStrictEqual(invokeCalls[invokeCalls.length - 1], {
          ch: "stats:get-content-intraday",
          payload: { contentKey: "file:/v/cross.mp4", days: 3, to: "2026-11-20", group: "赛博老司机" },
        });
        await ctx.saveChartImage("chartContentTrend", "作品趋势-跨矩阵共享专题", "2026-11-20");
        assert.strictEqual(invokeCalls[invokeCalls.length - 1].payload.group, "赛博老司机");
        assert.strictEqual(invokeCalls[invokeCalls.length - 1].payload.name, "赛博老司机-作品趋势-跨矩阵共享专题");
        ctx.resetContentTrendDialog();
        assert.strictEqual(ctx.contentTrendGroup, "");

        // 7e. 切换分组 → 持久化到 localStorage 并清空旧子筛选、重拉分析
        ctx.fansSelectedAccounts = ["赛博老司机|小红书"];
        ctx.newWorks24hPlatform = "小红书";
        await ctx.onAnalysisGroupChange("人间善恶录");
        assert.strictEqual(lsMap.get("stats:analysisGroup"), "人间善恶录");
        assert.deepStrictEqual(ctx.fansSelectedAccounts, []);
        assert.strictEqual(ctx.newWorks24hPlatform, "all");
        assert.deepStrictEqual(invokeCalls[invokeCalls.length - 1], {
          ch: "stats:get-analysis",
          payload: { period: 30, group: "人间善恶录" },
        });

        // 7f. 重新挂载组件时从 localStorage 恢复上次选择的分组
        const ctxRestored = mountCtx(comp);
        ctxRestored.reconcileAnalysisGroupSelection();
        assert.strictEqual(ctxRestored.analysisGroup, "人间善恶录", "应从 localStorage 恢复上次选择");

        // 7g. 切换回「全部」→ 不传 group，复制小结与 PNG 不加分组前缀
        await ctxRestored.onAnalysisGroupChange("all");
        assert.strictEqual(lsMap.get("stats:analysisGroup"), "all");
        assert.deepStrictEqual(invokeCalls[invokeCalls.length - 1], {
          ch: "stats:get-analysis",
          payload: { period: 30 },
        });
        await ctxRestored.copyAnalysisSummary();
        assert.strictEqual(copiedText, "总播放 +1000");

        // 7h. localStorage 抛异常时 try/catch 容错不崩溃
        global.localStorage = {
          getItem: () => {
            throw new Error("SecurityError: blocked");
          },
          setItem: () => {
            throw new Error("QuotaExceededError");
          },
        };
        const ctxSafe = mountCtx(comp);
        ctxSafe.overview = { daily: {}, accounts: [{ group: "人间善恶录", platform: "抖音" }] };
        ctxSafe.reconcileAnalysisGroupSelection();
        assert.strictEqual(ctxSafe.analysisGroup, "人间善恶录");
        await ctxSafe.onAnalysisGroupChange("all");
        assert.strictEqual(ctxSafe.analysisGroup, "all");
      } finally {
        Module._load = origLoad;
        global.localStorage = origLS;
      }
      console.log("✓ 7. dataStats/index.vue 模板编译与分组切换/持久化/容错/复制/PNG/趋势弹窗通过");
    }

    console.log("\nALL S16 TESTS PASSED");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
