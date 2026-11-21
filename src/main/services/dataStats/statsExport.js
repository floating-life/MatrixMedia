"use strict";

/**
 * 作品与账号数据统计 Excel 导出模块。
 *
 * 导出面向 AI 分析的长表格式：
 * - 一行一条记录、不合并单元格、首行表头、无公式
 * - 数值为 number 类型，日期为 "YYYY-MM-DD" 文本，空值为空单元格（null）
 * - 文本首字符为 = + - @（含前置空白）或 \t \r \n 时前置单引号，防另存 CSV 公式注入
 * - 数据读取依赖均可注入，便于纯函数单测
 */

const fs = require("fs");
const path = require("path");
const xlsx = require("xlsx");
const {
  WORK_STAT_KEYS,
  DELETED_WORK_TITLE,
  normalizeMetric,
  buildWorkIntradayRows,
} = require("./statsTable");
const {
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
  normalizeUrl,
  isManagementUrl,
  isValidAutoContentKey,
  isUnstableRecordKey,
  makeWorkKey,
  makeWorkIdentityKey,
  getLinkResultMeta,
} = require("./contentLink");
const {
  DEFAULT_ANALYSIS_PERIOD,
  NEW_WORKS_FIRST_24H_DAYS,
  buildStatsAnalysis,
} = require("./statsAnalysis");

const UTC8_MS = 8 * 3600e3;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DEFAULT_RANGE_DAYS = 29; // 含起止日共 30 天
const DEFAULT_INTRADAY_DAYS = 3;
const MAX_INTRADAY_DAYS = 60;
const MAX_SHEET_ROWS = 200000;
const ROW_LIMIT_EXCEEDED_CODE = "ROW_LIMIT_EXCEEDED";
const FUTURE_DATE_RANGE_ERROR = "所选日期都在未来";

const SHEET_NAMES = [
  "作品日明细",
  "作品时段明细",
  "作品跨平台汇总",
  "平台日汇总",
  "账号日快照",
  "分析",
  "字段说明",
  "导出信息",
];

const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];
const PLATFORM_RANK_MAP = new Map(PLATFORM_ORDER.map((p, i) => [p, i]));

const DATE_DAYNUM_CACHE = new Map();
const DAYNUM_DATE_CACHE = new Map();
const MAX_DATE_CACHE_SIZE = 8192;

const ACCOUNT_METRIC_KEYS = [
  "fans",
  "plays",
  "likes",
  "comments",
  "favorites",
  "shares",
];

const WORK_DELTA_KEYS = [
  "playDelta",
  "likeDelta",
  "commentDelta",
  "shareDelta",
  "favoriteDelta",
  "fansDeltaDelta",
];

const VALID_EXPORT_MATCH_METHODS = new Set(["link", "title", "fuzzy", "manual"]);

const WORK_DAILY_HEADERS = [
  "日期",
  "平台",
  "分组",
  "内容ID",
  "关联方式",
  "匹配分数",
  "作品ID",
  "标题",
  "作品链接",
  "发布日期",
  "播放",
  "点赞",
  "评论",
  "分享",
  "收藏",
  "涨粉",
  "播放日增",
  "点赞日增",
  "评论日增",
  "分享日增",
  "收藏日增",
  "涨粉日增",
  "断档天数",
];

const WORK_INTRADAY_HEADERS = [
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
];

const SUMMARY_BASE_HEADERS = [
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
];

const PLATFORM_DAILY_HEADERS = [
  "日期",
  "平台",
  "有数据作品数",
  "播放日增合计",
  "点赞日增合计",
  "评论日增合计",
  "分享日增合计",
  "收藏日增合计",
  "涨粉日增合计",
];

const ACCOUNT_DAILY_HEADERS = [
  "日期",
  "平台",
  "分组",
  "粉丝",
  "总播放",
  "总点赞",
  "总评论",
  "总收藏",
  "总分享",
  "粉丝日增",
  "播放日增",
  "异常标注",
];

const SCHEMA_HEADERS = ["sheet", "列名", "英文键", "含义/口径"];
const META_HEADERS = ["项目", "值"];

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function safeOwnGet(obj, key) {
  if (key === "__proto__") {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    return desc ? desc.value : undefined;
  }
  return obj[key];
}

function fastNormalizeMetric(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v === 0 ? 0 : v;
  }
  if (v === null || v === undefined) return null;
  return normalizeMetric(v);
}

function dateStrToDayNum(s) {
  if (typeof s !== "string") return null;
  const cached = DATE_DAYNUM_CACHE.get(s);
  if (cached !== undefined) return cached;
  if (!DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    if (DATE_DAYNUM_CACHE.size < MAX_DATE_CACHE_SIZE) DATE_DAYNUM_CACHE.set(s, null);
    return null;
  }
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  const valid =
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  const res = valid ? Math.floor(ms / DAY_MS) : null;
  if (DATE_DAYNUM_CACHE.size >= MAX_DATE_CACHE_SIZE) DATE_DAYNUM_CACHE.clear();
  DATE_DAYNUM_CACHE.set(s, res);
  if (res !== null && DAYNUM_DATE_CACHE.size < MAX_DATE_CACHE_SIZE) {
    DAYNUM_DATE_CACHE.set(res, s);
  }
  return res;
}

function dayNumToDateStr(dayNum) {
  const cached = DAYNUM_DATE_CACHE.get(dayNum);
  if (cached !== undefined) return cached;
  const s = new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
  if (DAYNUM_DATE_CACHE.size >= MAX_DATE_CACHE_SIZE) DAYNUM_DATE_CACHE.clear();
  DAYNUM_DATE_CACHE.set(dayNum, s);
  if (DATE_DAYNUM_CACHE.size < MAX_DATE_CACHE_SIZE) DATE_DAYNUM_CACHE.set(s, dayNum);
  return s;
}

function isValidDateStr(s) {
  return dateStrToDayNum(s) !== null;
}

function shiftDateStr(ymd, deltaDays) {
  const dn = dateStrToDayNum(ymd);
  if (dn !== null) return dayNumToDateStr(dn + deltaDays);
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function formatUtc8Date(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return dayNumToDateStr(Math.floor((safeMs + UTC8_MS) / DAY_MS));
}

function formatUtc8DateTime(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + UTC8_MS).toISOString().slice(0, 19).replace("T", " ");
}

function rawTimestampToUtc8Date(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const shifted = new Date(ms + UTC8_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const y = shifted.getUTCFullYear();
  if (y < 1970 || y > 9999) return null;
  return shifted.toISOString().slice(0, 10);
}

/** 文本单元格规范化：空串/null 返回 null（空单元格）；防公式注入前置单引号 */
function sanitizeTextCell(value) {
  if (value == null) return null;
  const text = String(value);
  if (text === "") return null;
  if (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) {
    return "'" + text;
  }
  return text;
}

/** 数值单元格规范化：有限数字返回 number（-0 归 0），其余返回 null（空单元格） */
function sanitizeNumberCell(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePlatform(a, b) {
  const ia = PLATFORM_RANK_MAP.get(a);
  const ib = PLATFORM_RANK_MAP.get(b);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return compareText(a, b);
}

function parsePgKey(pgKey) {
  const sep = pgKey.indexOf("|");
  if (sep === -1) return { platform: pgKey, group: "" };
  return { platform: pgKey.slice(0, sep), group: pgKey.slice(sep + 1) };
}

function resolveAppVersion(injected) {
  if (typeof injected === "string" && injected.trim()) return injected.trim();
  try {
    const { app } = require("electron");
    if (app && typeof app.getVersion === "function") {
      const v = app.getVersion();
      if (v) return String(v);
    }
  } catch (_) {}
  try {
    const pkg = require("../../../../package.json");
    if (pkg && pkg.version) return String(pkg.version);
  } catch (_) {}
  return "";
}

function resolveIoDeps(options = {}, depsArg) {
  const injected =
    isPlainObject(depsArg)
      ? depsArg
      : isPlainObject(options.deps)
      ? options.deps
      : {};

  const getStore = () => require("./store");
  const getPushRecords = () => require("./pushRecords");

  const storeApi = isPlainObject(injected.store) ? injected.store : null;
  const hasInjectedDataSource = Boolean(
    storeApi ||
      typeof injected.listAccounts === "function" ||
      typeof injected.readWorks === "function" ||
      typeof injected.readWorksDaily === "function" ||
      typeof injected.readWorksIntraday === "function"
  );
  const emptyOverrides = () => ({
    version: 1,
    updatedAt: 0,
    contents: Object.create(null),
    overrides: Object.create(null),
  });
  const emptyIntraday = () => Object.create(null);

  return {
    listAccounts:
      typeof injected.listAccounts === "function"
        ? injected.listAccounts
        : storeApi && typeof storeApi.listAccounts === "function"
        ? () => storeApi.listAccounts()
        : () => getStore().listAccounts(),
    readWorks:
      typeof injected.readWorks === "function"
        ? injected.readWorks
        : storeApi && typeof storeApi.readWorks === "function"
        ? (g, p) => storeApi.readWorks(g, p)
        : (g, p) => getStore().readWorks(g, p),
    readWorksDaily:
      typeof injected.readWorksDaily === "function"
        ? injected.readWorksDaily
        : storeApi && typeof storeApi.readWorksDaily === "function"
        ? (g, p) => storeApi.readWorksDaily(g, p)
        : (g, p) => getStore().readWorksDaily(g, p),
    readWorksDailyLatestAsOf:
      typeof injected.readWorksDailyLatestAsOf === "function"
        ? injected.readWorksDailyLatestAsOf
        : typeof injected.readWorksDaily === "function"
        ? null
        : storeApi
        ? typeof storeApi.readWorksDailyLatestAsOf === "function"
          ? (g, p, cutoff) => storeApi.readWorksDailyLatestAsOf(g, p, cutoff)
          : null
        : (g, p, cutoff) => {
            const s = getStore();
            return typeof s.readWorksDailyLatestAsOf === "function"
              ? s.readWorksDailyLatestAsOf(g, p, cutoff)
              : null;
          },
    readWorksIntraday:
      typeof injected.readWorksIntraday === "function"
        ? injected.readWorksIntraday
        : storeApi && typeof storeApi.readWorksIntraday === "function"
        ? (g, p, range) => storeApi.readWorksIntraday(g, p, range)
        : hasInjectedDataSource
        ? emptyIntraday
        : (g, p, range) => {
            const s = getStore();
            return typeof s.readWorksIntraday === "function"
              ? s.readWorksIntraday(g, p, range)
              : emptyIntraday();
          },
    readWorksIntradayLatestCollectedAt:
      typeof injected.readWorksIntradayLatestCollectedAt === "function"
        ? injected.readWorksIntradayLatestCollectedAt
        : typeof injected.readWorksIntraday === "function"
        ? null
        : storeApi
        ? typeof storeApi.readWorksIntradayLatestCollectedAt === "function"
          ? (g, p, cutoff) => storeApi.readWorksIntradayLatestCollectedAt(g, p, cutoff)
          : null
        : hasInjectedDataSource
        ? emptyIntraday
        : (g, p, cutoff) => {
            const s = getStore();
            return typeof s.readWorksIntradayLatestCollectedAt === "function"
              ? s.readWorksIntradayLatestCollectedAt(g, p, cutoff)
              : null;
          },
    readDaily:
      typeof injected.readDaily === "function"
        ? injected.readDaily
        : storeApi && typeof storeApi.readDaily === "function"
        ? (g, p) => storeApi.readDaily(g, p)
        : (g, p) => getStore().readDaily(g, p),
    readPushRecords:
      typeof injected.readPushRecords === "function"
        ? injected.readPushRecords
        : () =>
            getPushRecords().readPushRecords(
              options.pushDataDir ? { dir: options.pushDataDir } : undefined
            ),
    readLinkOverrides: isPlainObject(options.linkOverrides)
      ? () => options.linkOverrides
      : typeof injected.readLinkOverrides === "function"
      ? injected.readLinkOverrides
      : storeApi && typeof storeApi.readLinkOverrides === "function"
      ? () => storeApi.readLinkOverrides()
      : hasInjectedDataSource
      ? emptyOverrides
      : () => {
          const s = getStore();
          return typeof s.readLinkOverrides === "function"
            ? s.readLinkOverrides()
            : emptyOverrides();
        },
    now: injected.now !== undefined ? injected.now : options.now,
    appVersion:
      injected.appVersion !== undefined ? injected.appVersion : options.appVersion,
  };
}

function resolveRecordGroup(rec) {
  if (!isPlainObject(rec)) return "";
  const g = typeof rec.group === "string" ? rec.group.trim() : "";
  if (g) return g;
  const p = typeof rec.phone === "string" ? rec.phone : "";
  return p.split("-")[0].trim();
}

function reduceWorksDailyAsOf(rawWorksDaily, cutoffDate) {
  const worksDaily = Object.create(null);
  let latestDate = "";
  if (!isPlainObject(rawWorksDaily)) return { worksDaily, latestDate };
  const workIds = Object.keys(rawWorksDaily);
  for (let wi = 0; wi < workIds.length; wi++) {
    const workId = workIds[wi];
    const dateMap = safeOwnGet(rawWorksDaily, workId);
    if (!isPlainObject(dateMap)) continue;
    let bestDate = "";
    let bestSnap = null;
    const dates = Object.keys(dateMap);
    for (let di = 0; di < dates.length; di++) {
      const d = dates[di];
      if (!isValidDateStr(d)) continue;
      if (cutoffDate && d > cutoffDate) continue;
      if (bestDate && d <= bestDate) continue;
      const snap = safeOwnGet(dateMap, d);
      if (!isPlainObject(snap)) continue;
      bestDate = d;
      bestSnap = snap;
    }
    if (bestSnap) {
      worksDaily[workId] = { [bestDate]: bestSnap };
      if (!latestDate || bestDate > latestDate) latestDate = bestDate;
    }
  }
  return { worksDaily, latestDate };
}

function reduceAllWorksDailyByGpAsOf(allWorksDailyByGp, cutoffDate) {
  const reduced = Object.create(null);
  if (!isPlainObject(allWorksDailyByGp)) return reduced;
  for (const gpKey of Object.keys(allWorksDailyByGp)) {
    const raw = safeOwnGet(allWorksDailyByGp, gpKey);
    reduced[gpKey] = reduceWorksDailyAsOf(raw, cutoffDate).worksDaily;
  }
  return reduced;
}

/**
 * GUI 与 Excel 共享的默认截止日解析函数：
 * 优先以作品快照（worksDaily）中的最新有效日期为准；
 * 仅当所有账号均无作品快照时，才回退取账号日快照（daily）中的最新有效日期。
 */
function resolveDefaultCutoffDate(accountsData, getFallbackDaily) {
  let latestWorksDate = "";
  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc) || !isPlainObject(acc.worksDaily)) continue;
    const workIds = Object.keys(acc.worksDaily);
    for (let wi = 0; wi < workIds.length; wi++) {
      const dateMap = safeOwnGet(acc.worksDaily, workIds[wi]);
      if (!isPlainObject(dateMap)) continue;
      const dates = Object.keys(dateMap);
      for (let di = 0; di < dates.length; di++) {
        const d = dates[di];
        if (!isValidDateStr(d)) continue;
        if (latestWorksDate && d <= latestWorksDate) continue;
        const snap = safeOwnGet(dateMap, d);
        if (!isPlainObject(snap)) continue;
        latestWorksDate = d;
      }
    }
  }
  if (latestWorksDate) return latestWorksDate;

  let latestDailyDate = "";
  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc)) continue;
    let daily = isPlainObject(acc.daily) && Object.keys(acc.daily).length > 0 ? acc.daily : null;
    if (!daily && typeof getFallbackDaily === "function") {
      const loaded = getFallbackDaily(acc.group, acc.platform);
      if (isPlainObject(loaded)) daily = loaded;
    }
    if (!daily) continue;
    const dates = Object.keys(daily);
    for (let di = 0; di < dates.length; di++) {
      const d = dates[di];
      if (!isValidDateStr(d)) continue;
      if (latestDailyDate && d <= latestDailyDate) continue;
      const snap = safeOwnGet(daily, d);
      if (!isPlainObject(snap)) continue;
      latestDailyDate = d;
    }
  }
  return latestDailyDate;
}

/**
 * 在全量分组上按作品身份裁决完归属后，按输出分组集合裁剪跨平台汇总行：
 * 保留全部未关联作品行、输出分组有作品关联到的内容行（含跨组手工引用目标）以及输出分组自有发布记录行，
 * 裁掉纯属其他分组且未被输出分组任何作品引用的空内容行。
 */
function filterSummaryRowsByGroupScope(
  summaryRows,
  allContents,
  link,
  outputAccountsData,
  groupSet,
  cutoffDate
) {
  if (!groupSet || groupSet.size === 0) return summaryRows;

  const ownContentKeys = new Set();
  for (const c of Array.isArray(allContents) ? allContents : []) {
    if (!isPlainObject(c) || !c.contentKey) continue;
    const rawContentDate = typeof c.firstPublishDate === "string" ? c.firstPublishDate.trim() : "";
    const contentDate = isValidDateStr(rawContentDate) ? rawContentDate : "";
    const targets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    for (const t of targets) {
      const rawTDate = typeof t.recordDate === "string" ? t.recordDate.trim() : "";
      const tDate = isValidDateStr(rawTDate)
        ? rawTDate
        : rawTimestampToUtc8Date(t.lastPublishAt) || contentDate;
      if (cutoffDate && tDate && tDate > cutoffDate) continue;
      const g = typeof t.group === "string" ? t.group.trim() : "";
      if (groupSet.has(g)) {
        ownContentKeys.add(c.contentKey);
        break;
      }
    }
  }

  const referencedKeys = new Set();
  if (link instanceof Map && Array.isArray(outputAccountsData)) {
    for (const acc of outputAccountsData) {
      if (!isPlainObject(acc)) continue;
      const group = acc.group == null ? "" : String(acc.group);
      const platform = acc.platform == null ? "" : String(acc.platform);
      for (const w of Array.isArray(acc.works) ? acc.works : []) {
        if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
        const entry = link.get(makeWorkKey(group, platform, String(w.workId)));
        if (entry && entry.contentKey) referencedKeys.add(entry.contentKey);
      }
      if (isPlainObject(acc.worksDaily)) {
        for (const workId of Object.keys(acc.worksDaily)) {
          if (!workId) continue;
          const entry = link.get(makeWorkKey(group, platform, workId));
          if (entry && entry.contentKey) referencedKeys.add(entry.contentKey);
        }
      }
    }
  }

  return summaryRows.filter((row) => {
    if (!isPlainObject(row)) return false;
    if (row.isUnlinked) return true;
    if (isPlainObject(row.perPlatform) && Object.keys(row.perPlatform).length > 0) return true;
    if (ownContentKeys.has(row.contentKey)) return true;
    if (referencedKeys.has(row.contentKey)) return true;
    return false;
  });
}

function loadRawDataset(options = {}, depsArg) {
  const io = resolveIoDeps(options, depsArg);
  const groupSet =
    Array.isArray(options.groups) && options.groups.length > 0
      ? new Set(options.groups.map((g) => String(g)))
      : null;

  const rawAccounts = io.listAccounts() || [];
  const allAccountsData = [];
  const allWorksDailyByGp = Object.create(null);

  for (const acc of rawAccounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    const inOutputScope = !groupSet || groupSet.has(group);

    const worksDoc = io.readWorks(group, platform);
    const works =
      worksDoc && Array.isArray(worksDoc.works)
        ? worksDoc.works
        : Array.isArray(worksDoc)
        ? worksDoc
        : [];
    const rawWorksDaily = io.readWorksDaily(group, platform);
    const worksDaily = isPlainObject(rawWorksDaily) ? rawWorksDaily : Object.create(null);
    const rawDaily = inOutputScope ? io.readDaily(group, platform) : {};
    const daily = isPlainObject(rawDaily) ? rawDaily : {};

    allAccountsData.push({ group, platform, works, worksDaily, daily });
    allWorksDailyByGp[`${group}|${platform}`] = worksDaily;
  }

  allAccountsData.sort((a, b) => {
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  const outputAccountsData = groupSet
    ? allAccountsData.filter((a) => groupSet.has(a.group))
    : allAccountsData;

  // 保留全量分组账号与发布记录用于全量作品身份归属裁决，输出阶段再按 groupSet 裁剪
  const allPushRecords = io.readPushRecords() || [];
  const latestDataDate = resolveDefaultCutoffDate(allAccountsData, (g, p) => io.readDaily(g, p));
  const linkOverrides = io.readLinkOverrides();

  return {
    io,
    groupSet,
    allAccountsData,
    allWorksDailyByGp,
    outputAccountsData,
    accountsData: outputAccountsData,
    worksDailyByGp: allWorksDailyByGp,
    allPushRecords,
    pushRecords: allPushRecords,
    linkOverrides,
    latestDataDate,
  };
}

/**
 * 仅加载「作品跨平台汇总」及写入校验截至 cutoffDate 所需数据：
 * - 不读取 daily.json（仅当所有作品快照均为空且未指定 date 时才兜底查最新快照日）
 * - 复用 store.readWorksDailyLatestAsOf 仅保留每作品 <= cutoffDate 的最新一条快照（不全量加载历史快照）
 * - 加载全量分组供作品身份归属裁决，输出阶段再按 groupSet 裁剪
 */
function loadSummaryDataset(options = {}, depsArg, explicitCutoffDate = "") {
  const io = resolveIoDeps(options, depsArg);
  const groupSet =
    Array.isArray(options.groups) && options.groups.length > 0
      ? new Set(options.groups.map((g) => String(g)))
      : null;

  const rawAccounts = io.listAccounts() || [];
  const allAccountsData = [];
  const allWorksDailyByGp = Object.create(null);

  for (const acc of rawAccounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);

    const worksDoc = io.readWorks(group, platform);
    const works =
      worksDoc && Array.isArray(worksDoc.works)
        ? worksDoc.works
        : Array.isArray(worksDoc)
        ? worksDoc
        : [];

    let res = null;
    if (typeof io.readWorksDailyLatestAsOf === "function") {
      res = io.readWorksDailyLatestAsOf(group, platform, explicitCutoffDate);
    }
    if (!res) {
      res = reduceWorksDailyAsOf(io.readWorksDaily(group, platform), explicitCutoffDate);
    }

    allAccountsData.push({ group, platform, works, worksDaily: res.worksDaily, daily: {} });
    allWorksDailyByGp[`${group}|${platform}`] = res.worksDaily;
  }

  allAccountsData.sort((a, b) => {
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  const outputAccountsData = groupSet
    ? allAccountsData.filter((a) => groupSet.has(a.group))
    : allAccountsData;

  // 保留全量分组账号与发布记录用于全量作品身份归属裁决，输出阶段再按 groupSet 裁剪
  const allPushRecords = io.readPushRecords() || [];
  const latestDataDate = explicitCutoffDate
    ? ""
    : resolveDefaultCutoffDate(allAccountsData, (g, p) => io.readDaily(g, p));
  const linkOverrides = io.readLinkOverrides();

  return {
    io,
    groupSet,
    allAccountsData,
    allWorksDailyByGp,
    outputAccountsData,
    accountsData: outputAccountsData,
    worksDailyByGp: allWorksDailyByGp,
    allPushRecords,
    pushRecords: allPushRecords,
    linkOverrides,
    latestDataDate,
  };
}

/**
 * 沿用跨平台汇总（buildContentSummaryRows）的去重与关联口径统计作品数与未关联作品数：
 * - buildContentSummaryRows 已按 platform|workId 跨组去重并处理冲突与未来作品过滤
 * - 每个已纳入汇总的作品仅出现在某一行的 perPlatform[*].workIds 中一次
 * - contentKey 以 "unlinked:" 开头的行即为未关联作品
 */
function computeWorkCountsFromSummaryRows(summaryRows) {
  let works = 0;
  let unlinkedWorks = 0;
  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!isPlainObject(row) || !isPlainObject(row.perPlatform)) continue;
    const isUnlinked =
      typeof row.contentKey === "string" && row.contentKey.startsWith("unlinked:");
    let rowWorkCount = 0;
    for (const cell of Object.values(row.perPlatform)) {
      if (cell && Array.isArray(cell.workIds)) {
        rowWorkCount += cell.workIds.length;
      }
    }
    works += rowWorkCount;
    if (isUnlinked) unlinkedWorks += rowWorkCount;
  }
  return { works, unlinkedWorks };
}

function countWorkDailyRows(accountsData, from, to) {
  let count = 0;
  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc) || !isPlainObject(acc.worksDaily)) continue;
    const workIds = Object.keys(acc.worksDaily);
    for (let wi = 0; wi < workIds.length; wi++) {
      const dateMap = safeOwnGet(acc.worksDaily, workIds[wi]);
      if (!isPlainObject(dateMap)) continue;
      const dates = Object.keys(dateMap);
      for (let di = 0; di < dates.length; di++) {
        const d = dates[di];
        if (!isValidDateStr(d)) continue;
        if (from && d < from) continue;
        if (to && d > to) continue;
        const snap = safeOwnGet(dateMap, d);
        if (!isPlainObject(snap)) continue;
        count += 1;
      }
    }
  }
  return count;
}

function countAccountDailyRows(accountsData, from, to) {
  let count = 0;
  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc) || !isPlainObject(acc.daily)) continue;
    for (const [d, snap] of Object.entries(acc.daily)) {
      if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
      if (from && d < from) continue;
      if (to && d > to) continue;
      count += 1;
    }
  }
  return count;
}

function loadAccountsWorksIntraday(accountsData, io, range) {
  const entries = [];
  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc)) continue;
    const raw =
      io && typeof io.readWorksIntraday === "function"
        ? io.readWorksIntraday(acc.group, acc.platform, range || {})
        : null;
    const worksIntraday = isPlainObject(raw) ? raw : Object.create(null);
    entries.push({ acc, worksIntraday });
  }
  return entries;
}

function countWorkIntradayRows(accountsWithIntraday, from, to) {
  let count = 0;
  for (const entry of Array.isArray(accountsWithIntraday) ? accountsWithIntraday : []) {
    const map = entry && isPlainObject(entry.worksIntraday) ? entry.worksIntraday : null;
    if (!map) continue;
    const workIds = Object.keys(map);
    for (let wi = 0; wi < workIds.length; wi++) {
      const list = safeOwnGet(map, workIds[wi]);
      if (!Array.isArray(list) || !list.length) continue;
      const seenSlots = new Set();
      for (let pi = 0; pi < list.length; pi++) {
        const pt = list[pi];
        if (!isPlainObject(pt)) continue;
        const d = typeof pt.date === "string" ? pt.date.trim() : "";
        const s = typeof pt.slot === "string" ? pt.slot.trim() : "";
        if (!isValidDateStr(d) || !SLOT_TIME_RE.test(s)) continue;
        if (from && d < from) continue;
        if (to && d > to) continue;
        const slotKey = `${d} ${s}`;
        if (!seenSlots.has(slotKey)) {
          seenSlots.add(slotKey);
          count += 1;
        }
      }
    }
  }
  return count;
}

function loadLatestCollectedAtByPwKey(accountsData, io, cutoffDate) {
  const latestByPwKey = new Map();
  if (!Array.isArray(accountsData) || !accountsData.length || !io) return latestByPwKey;
  for (const acc of accountsData) {
    if (!isPlainObject(acc)) continue;
    const platform = acc.platform == null ? "" : String(acc.platform);
    let perWork = null;
    if (typeof io.readWorksIntradayLatestCollectedAt === "function") {
      perWork = io.readWorksIntradayLatestCollectedAt(acc.group, acc.platform, cutoffDate);
    }
    if (isPlainObject(perWork)) {
      for (const workId of Object.keys(perWork)) {
        const ts = safeOwnGet(perWork, workId);
        if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
        const pwKey = `${platform}|${workId}`;
        const prev = latestByPwKey.get(pwKey);
        if (prev === undefined || ts > prev) latestByPwKey.set(pwKey, ts);
      }
      continue;
    }
    if (typeof io.readWorksIntraday !== "function") continue;
    const intraday = io.readWorksIntraday(
      acc.group,
      acc.platform,
      cutoffDate ? { to: cutoffDate } : {}
    );
    if (!isPlainObject(intraday)) continue;
    for (const workId of Object.keys(intraday)) {
      const list = safeOwnGet(intraday, workId);
      if (!Array.isArray(list)) continue;
      const pwKey = `${platform}|${workId}`;
      for (let i = 0; i < list.length; i++) {
        const pt = list[i];
        if (!isPlainObject(pt)) continue;
        const d = typeof pt.date === "string" ? pt.date.trim() : "";
        if (cutoffDate && d && d > cutoffDate) continue;
        const ts = parseRawTimestampMs(pt.collectedAt);
        if (ts === null) continue;
        if (cutoffDate && formatUtc8Date(ts) > cutoffDate) continue;
        const prev = latestByPwKey.get(pwKey);
        if (prev === undefined || ts > prev) latestByPwKey.set(pwKey, ts);
      }
    }
  }
  return latestByPwKey;
}

function enrichSummaryRowsLastCollectedAt(rows, latestByPwKey) {
  if (!Array.isArray(rows)) return;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!isPlainObject(row)) continue;
    let maxTs = null;
    if (isPlainObject(row.perPlatform)) {
      for (const [pgKey, cell] of Object.entries(row.perPlatform)) {
        if (!isPlainObject(cell)) continue;
        const { platform } = parsePgKey(pgKey);
        if (Array.isArray(cell.workIds)) {
          for (const wid of cell.workIds) {
            if (wid == null || wid === "") continue;
            const ts = latestByPwKey.get(`${platform}|${String(wid).trim()}`);
            if (ts !== undefined && (maxTs === null || ts > maxTs)) {
              maxTs = ts;
            }
          }
        }
        if (Array.isArray(cell.works)) {
          for (const w of cell.works) {
            if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
            const p =
              typeof w.platform === "string" && w.platform.trim()
                ? w.platform.trim()
                : platform;
            const ts = latestByPwKey.get(`${p}|${String(w.workId).trim()}`);
            w.lastCollectedAt = ts !== undefined ? ts : null;
            if (ts !== undefined && (maxTs === null || ts > maxTs)) {
              maxTs = ts;
            }
          }
        }
      }
    }
    row.lastCollectedAt = maxTs;
  }
}

function resolveMaxRows(raw) {
  if (raw === undefined || raw === null) return MAX_SHEET_ROWS;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  throw new Error(`maxRows 需为正整数：${raw}`);
}

function createRowLimitError(rowCount, maxRows, sheetName) {
  const err = new Error(`数据量过大（${rowCount} 行），请缩小日期范围后再导出`);
  err.code = ROW_LIMIT_EXCEEDED_CODE;
  err.rowCount = rowCount;
  err.maxRows = maxRows;
  if (sheetName) err.sheetName = sheetName;
  return err;
}

function validateOptionalDate(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") {
    throw new Error(`${label} 需为 YYYY-MM-DD 格式字符串`);
  }
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!isValidDateStr(trimmed)) {
    throw new Error(`${label} 不是合法日期（需 YYYY-MM-DD）：${trimmed}`);
  }
  return trimmed;
}

function validateExportDateRange(from, to) {
  const validFrom = validateOptionalDate(from, "from");
  const validTo = validateOptionalDate(to, "to");
  if (validFrom && validTo && validFrom > validTo) {
    throw new Error(`开始日期不能晚于结束日期（${validFrom} > ${validTo}）`);
  }
  return { from: validFrom, to: validTo };
}

/**
 * 校验导出日期区间与「≤ UTC+8 今天」的交集非空；
 * 若所选区间全部晚于今天则抛出明确错误「所选日期都在未来」。
 */
function assertExportRangeNotAllFuture(from, to, nowVal = Date.now()) {
  const todayUtc8 = formatUtc8Date(nowVal);
  if (from && from > todayUtc8) {
    throw new Error(FUTURE_DATE_RANGE_ERROR);
  }
  if (!from && to) {
    const impliedFrom = shiftDateStr(to, -DEFAULT_RANGE_DAYS);
    if (impliedFrom > todayUtc8) {
      throw new Error(FUTURE_DATE_RANGE_ERROR);
    }
    if (to > todayUtc8) {
      return { from: impliedFrom, to: todayUtc8, todayUtc8 };
    }
  }
  return {
    from: from || "",
    to: to && to > todayUtc8 ? todayUtc8 : to || "",
    todayUtc8,
  };
}

function buildDefaultExportFileName(from, to) {
  const f = typeof from === "string" ? from.trim() : "";
  const t = typeof to === "string" ? to.trim() : "";
  if (f && t) {
    return `MatrixMedia-作品数据-${f}_${t}.xlsx`;
  }
  if (!f && t) {
    const resolvedFrom = shiftDateStr(t, -DEFAULT_RANGE_DAYS);
    return `MatrixMedia-作品数据-${resolvedFrom}_${t}.xlsx`;
  }
  if (f && !t) {
    return `MatrixMedia-作品数据-${f}_起.xlsx`;
  }
  return "MatrixMedia-作品数据.xlsx";
}

/**
 * 构建跨平台内容汇总数据（供 GUI「作品汇总」tab / IPC stats:get-content-summary 复用）。
 * - 仅读取截止日所需快照（不读全量历史，不排序作品日明细）
 * - 先解析统一 cutoffDate（共享 resolveDefaultCutoffDate：以作品快照最新日为准），
 *   同一个 cutoff 用于关联、汇总、计数和页面回执，单次匹配复用
 */
function buildContentSummaryData(options = {}, depsArg) {
  const opts = isPlainObject(options) ? options : {};
  const dateStr = validateOptionalDate(opts.date, "date");
  const dataset = loadSummaryDataset(opts, depsArg, dateStr);
  const cutoffDate = dateStr || dataset.latestDataDate || "";
  const contents = buildContentIndex(dataset.allPushRecords);
  const link = linkWorks({
    contents,
    accounts: dataset.allAccountsData,
    worksDaily: dataset.allWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
  });
  let rows = buildContentSummaryRows({
    contents,
    accounts: dataset.allAccountsData,
    link,
    worksDaily: dataset.allWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
    groups: dataset.groupSet,
  });
  if (dataset.groupSet) {
    rows = filterSummaryRowsByGroupScope(
      rows,
      contents,
      link,
      dataset.outputAccountsData,
      dataset.groupSet,
      cutoffDate
    );
  }
  const latestCollectedByPwKey = loadLatestCollectedAtByPwKey(
    dataset.outputAccountsData,
    dataset.io,
    cutoffDate
  );
  enrichSummaryRowsLastCollectedAt(rows, latestCollectedByPwKey);
  const workCounts = computeWorkCountsFromSummaryRows(rows);

  return {
    rows,
    date: cutoffDate,
    counts: {
      accounts: dataset.outputAccountsData.length,
      works: workCounts.works,
      contents: rows.length,
      unlinkedWorks: workCounts.unlinkedWorks,
    },
  };
}

function parseRawTimestampMs(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + UTC8_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const y = shifted.getUTCFullYear();
  return y >= 2000 && y <= 2100 ? ms : null;
}

/**
 * 构建手工矫正写入校验上下文（供 dataStats/index.js 串行写入队列使用）：
 * - 复用 loadSummaryDataset 截至日读取路径（调用 store.readWorksDailyLatestAsOf，不全量加载历史快照）
 * - 按全量分组构建可分配目标集合、不稳定位置键集合、作品身份索引 `workInfoByPwKey` 与观测映射 `pwKeyByObsWorkKey`
 * - 提供纯内存 `evaluate(overridesDoc)`，支持批量 ops 逐条状态演进校验与写前最终归属一致校验
 */
function resolveLinkValidationContext(options = {}, depsArg) {
  const opts = isPlainObject(options) ? { ...options, groups: undefined } : {};
  const dateStr = validateOptionalDate(opts.date, "date");
  const dataset = loadSummaryDataset(opts, depsArg, dateStr);
  const cutoffDate = dateStr || dataset.latestDataDate || "";
  const contents = buildContentIndex(dataset.allPushRecords);

  const eligibleAssignableKeys = new Set();
  const unstableRecordKeys = new Set();
  for (const c of contents) {
    if (!isPlainObject(c) || !c.contentKey) continue;
    const rawContentDate = typeof c.firstPublishDate === "string" ? c.firstPublishDate.trim() : "";
    const contentDate = isValidDateStr(rawContentDate) ? rawContentDate : "";
    const rawTargets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    const hasTargets = rawTargets.length > 0;
    let eligibleTargets = 0;
    for (const t of rawTargets) {
      const rawTDate = typeof t.recordDate === "string" ? t.recordDate.trim() : "";
      const tDate = isValidDateStr(rawTDate)
        ? rawTDate
        : rawTimestampToUtc8Date(t.lastPublishAt) || contentDate;
      if (cutoffDate && tDate && tDate > cutoffDate) continue;
      eligibleTargets++;
    }
    const eligible = hasTargets
      ? eligibleTargets > 0
      : !cutoffDate || !contentDate || contentDate <= cutoffDate;
    if (!eligible) continue;
    if (c.assignable === false || isUnstableRecordKey(c.contentKey)) {
      unstableRecordKeys.add(c.contentKey);
    } else {
      eligibleAssignableKeys.add(c.contentKey);
    }
  }

  // 先扫描未来发布作品身份（与 linkWorks / buildContentSummaryRows 保持一致）
  const excludedFuturePwKeys = new Set();
  if (cutoffDate) {
    for (const acc of dataset.allAccountsData) {
      const platform = acc.platform;
      for (const w of Array.isArray(acc.works) ? acc.works : []) {
        if (!isPlainObject(w)) continue;
        const workId = w.workId == null ? "" : String(w.workId);
        if (!workId) continue;
        const pubMs = parseRawTimestampMs(w.publishTime);
        const pubDate = pubMs !== null ? formatUtc8Date(pubMs) : "";
        if (pubDate && pubDate > cutoffDate) {
          excludedFuturePwKeys.add(makeWorkIdentityKey(platform, workId));
        }
      }
    }
  }

  const workInfoByPwKey = new Map();
  const pwKeyByObsWorkKey = new Map();
  const seenWorkKeys = new Set();
  const gpInfoByKey = new Map();

  const mergePwInfo = (pwKey, obs) => {
    const prev = workInfoByPwKey.get(pwKey);
    if (!prev) {
      workInfoByPwKey.set(pwKey, {
        pwKey,
        platform: obs.platform,
        workId: obs.workId,
        title: obs.title,
        rawTitle: obs.rawTitle,
        pubMs: obs.pubMs,
        fromWorksJson: obs.fromWorksJson,
      });
      return;
    }
    if (obs.fromWorksJson && !prev.fromWorksJson) {
      prev.fromWorksJson = true;
      prev.title = obs.title;
      prev.rawTitle = obs.rawTitle;
    } else if (obs.fromWorksJson && !prev.rawTitle && obs.rawTitle) {
      prev.title = obs.title;
      prev.rawTitle = obs.rawTitle;
    }
    if (obs.pubMs !== null && (prev.pubMs === null || obs.pubMs < prev.pubMs)) {
      prev.pubMs = obs.pubMs;
    }
  };

  for (const acc of dataset.allAccountsData) {
    const group = acc.group;
    const platform = acc.platform;
    const gpKey = `${group}|${platform}`;
    if (!gpInfoByKey.has(gpKey)) gpInfoByKey.set(gpKey, { group, platform });
    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w)) continue;
      const workId = w.workId == null ? "" : String(w.workId);
      if (!workId) continue;
      const workKey = makeWorkKey(group, platform, workId);
      if (seenWorkKeys.has(workKey)) continue;
      seenWorkKeys.add(workKey);

      const pwKey = makeWorkIdentityKey(platform, workId);
      const pubMs = parseRawTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? formatUtc8Date(pubMs) : "";
      if (cutoffDate && ((pubDate && pubDate > cutoffDate) || excludedFuturePwKeys.has(pwKey))) {
        excludedFuturePwKeys.add(pwKey);
        continue;
      }

      const title = typeof w.title === "string" ? w.title : "";
      pwKeyByObsWorkKey.set(workKey, pwKey);
      mergePwInfo(pwKey, {
        platform,
        workId,
        title: title || "(无标题)",
        rawTitle: title,
        pubMs,
        fromWorksJson: true,
      });
    }
  }

  // 补齐仅存在于 works-daily 的作品（works.json 中已删除/缺失）
  for (const [gpKey, accWorksDaily] of Object.entries(dataset.allWorksDailyByGp)) {
    if (!isPlainObject(accWorksDaily)) continue;
    let gpInfo = gpInfoByKey.get(gpKey);
    if (!gpInfo) {
      const sep = gpKey.lastIndexOf("|");
      if (sep === -1) continue;
      gpInfo = { group: gpKey.slice(0, sep), platform: gpKey.slice(sep + 1) };
    }
    const { group, platform } = gpInfo;
    for (const workId of Object.keys(accWorksDaily)) {
      if (!workId) continue;
      const workKey = makeWorkKey(group, platform, workId);
      if (seenWorkKeys.has(workKey)) continue;
      const pwKey = makeWorkIdentityKey(platform, workId);
      if (excludedFuturePwKeys.has(pwKey)) continue;
      const dateMap = accWorksDaily[workId];
      if (!isPlainObject(dateMap)) continue;
      let hasSnap = false;
      for (const [d, snap] of Object.entries(dateMap)) {
        if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
        if (cutoffDate && d > cutoffDate) continue;
        hasSnap = true;
        break;
      }
      if (!hasSnap) continue;
      seenWorkKeys.add(workKey);

      pwKeyByObsWorkKey.set(workKey, pwKey);
      mergePwInfo(pwKey, {
        platform,
        workId,
        title: DELETED_WORK_TITLE,
        rawTitle: "",
        pubMs: null,
        fromWorksJson: false,
      });
    }
  }

  const evaluate = (overridesDoc) => {
    const link = linkWorks({
      contents,
      accounts: dataset.allAccountsData,
      worksDaily: dataset.allWorksDailyByGp,
      date: cutoffDate || undefined,
      overrides: overridesDoc,
    });
    const meta = getLinkResultMeta(link);
    const byWorkIdentity =
      meta && meta.byWorkIdentity ? meta.byWorkIdentity : new Map();
    const syntheticTitles =
      meta && meta.syntheticTitlesByKey ? meta.syntheticTitlesByKey : new Map();
    const autoClusters = new Map();
    for (const entry of byWorkIdentity.values()) {
      if (entry && isValidAutoContentKey(entry.contentKey) && !autoClusters.has(entry.contentKey)) {
        autoClusters.set(entry.contentKey, {
          title: syntheticTitles.get(entry.contentKey) || "(无标题)",
        });
      }
    }
    return { link, byWorkIdentity, autoClusters };
  };

  return {
    cutoffDate,
    eligibleAssignableKeys,
    unstableRecordKeys,
    workInfoByPwKey,
    pwKeyByObsWorkKey,
    evaluate,
  };
}

function parsePublishTimeForTable(raw) {
  if (raw == null || raw === "") return { ms: 0, iso: "", utc8Date: null };
  let ms = NaN;
  if (typeof raw === "number") {
    ms = raw;
  } else if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return { ms: 0, iso: "", utc8Date: null };
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms) || ms <= 0) return { ms: 0, iso: "", utc8Date: null };
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return { ms: 0, iso: "", utc8Date: null };
  const shiftedMs = t + UTC8_MS;
  const shiftedDate = new Date(shiftedMs);
  const y = shiftedDate.getUTCFullYear();
  const utc8Date =
    Number.isFinite(shiftedDate.getTime()) && y >= 1970 && y <= 9999
      ? dayNumToDateStr(Math.floor(shiftedMs / DAY_MS))
      : null;
  return { ms: t, iso: d.toISOString(), utc8Date };
}

/**
 * 拆出的作品日明细结构化读取函数（单遍扫描，按需产出 Sheet 1 行与分析用全量行）：
 * - GUI 入口（needSheetRows: false, needAnalysisRows: true）不排序全历史、不生成 Excel 二维表
 * - Excel 导出（needSheetRows: true, needAnalysisRows: true）单遍同时产出 [from, to] 的 Sheet 1 行（仅对该范围排序）
 *   以及全历史 analysisRows（含 >to 恢复快照，供分析层识别掉 0 异常）
 */
function collectWorkDailyStructured(
  accountsData,
  link,
  { from = "", to = "", needSheetRows = false, needAnalysisRows = false } = {}
) {
  const hasLink = link instanceof Map;
  const fromDayNum = from ? dateStrToDayNum(from) : null;
  const toDayNum = to ? dateStrToDayNum(to) : null;
  const sheetRows = needSheetRows ? [] : null;
  const analysisRows = needAnalysisRows ? [] : null;

  for (const acc of Array.isArray(accountsData) ? accountsData : []) {
    if (!isPlainObject(acc) || !isPlainObject(acc.worksDaily)) continue;
    const groupStr = acc.group == null ? "" : String(acc.group);
    const platformStr = acc.platform == null ? "" : String(acc.platform);
    const platformRankVal = PLATFORM_RANK_MAP.get(platformStr);
    const platformRank = platformRankVal !== undefined ? platformRankVal : 999;

    const workById = new Map();
    if (Array.isArray(acc.works)) {
      for (let i = 0; i < acc.works.length; i++) {
        const w = acc.works[i];
        if (w && w.workId != null && w.workId !== "") {
          workById.set(String(w.workId), w);
        }
      }
    }

    const workIds = Object.keys(acc.worksDaily);
    for (let wi = 0; wi < workIds.length; wi++) {
      const workId = workIds[wi];
      const dateMap = safeOwnGet(acc.worksDaily, workId);
      if (!isPlainObject(dateMap)) continue;

      const linkInfo = hasLink
        ? link.get(`${groupStr}|${platformStr}|${workId}`) ||
          link.get(`${platformStr}|${workId}`) ||
          null
        : null;
      const contentKey =
        hasLink && linkInfo && linkInfo.contentKey != null ? linkInfo.contentKey : null;
      const matchedBy =
        hasLink && linkInfo && linkInfo.matchedBy != null ? linkInfo.matchedBy : null;
      const matchScore =
        hasLink &&
        linkInfo &&
        linkInfo.matchedBy === "fuzzy" &&
        typeof linkInfo.score === "number" &&
        Number.isFinite(linkInfo.score)
          ? linkInfo.score
          : null;

      const meta = workById.get(workId);
      const title = meta ? meta.title || "(无标题)" : DELETED_WORK_TITLE;
      const url = meta ? meta.url || "" : "";
      const { ms: publishTimeMs, iso: publishTimeIso, utc8Date: publishDateStr } = meta
        ? parsePublishTimeForTable(meta.publishTime)
        : { ms: 0, iso: "", utc8Date: null };

      const rawDates = Object.keys(dateMap);
      const points = [];
      let sorted = true;
      let lastDayNum = -Infinity;
      for (let di = 0; di < rawDates.length; di++) {
        const date = rawDates[di];
        const dayNum = dateStrToDayNum(date);
        if (dayNum === null) continue;
        const snap = safeOwnGet(dateMap, date);
        if (!isPlainObject(snap)) continue;
        if (dayNum < lastDayNum) sorted = false;
        lastDayNum = dayNum;
        points.push({ date, dayNum, snap });
      }
      if (!points.length) continue;
      if (!sorted && points.length > 1) {
        points.sort((a, b) => a.dayNum - b.dayNum);
      }

      let prevDayNum = -1;
      let prevPlay = null;
      let prevLike = null;
      let prevComment = null;
      let prevShare = null;
      let prevFavorite = null;
      let prevFansDelta = null;
      let hasPrev = false;

      for (let pi = 0; pi < points.length; pi++) {
        const pt = points[pi];
        const snap = pt.snap;
        const play = hasOwn(snap, "play") ? fastNormalizeMetric(snap.play) : null;
        const like = hasOwn(snap, "like") ? fastNormalizeMetric(snap.like) : null;
        const comment = hasOwn(snap, "comment") ? fastNormalizeMetric(snap.comment) : null;
        const share = hasOwn(snap, "share") ? fastNormalizeMetric(snap.share) : null;
        const favorite = hasOwn(snap, "favorite") ? fastNormalizeMetric(snap.favorite) : null;
        const fansDelta = hasOwn(snap, "fansDelta") ? fastNormalizeMetric(snap.fansDelta) : null;

        if (needAnalysisRows) {
          analysisRows.push({
            date: pt.date,
            dayNum: pt.dayNum,
            group: groupStr,
            platform: platformStr,
            workId,
            title,
            url,
            publishTime: publishTimeMs || "",
            publishTimeMs,
            publishDate: publishDateStr || "",
            contentKey,
            play,
            like,
            comment,
            share,
            favorite,
            fansDelta,
          });
        }

        if (needSheetRows) {
          const playDelta = hasPrev && play !== null && prevPlay !== null ? play - prevPlay : null;
          const likeDelta = hasPrev && like !== null && prevLike !== null ? like - prevLike : null;
          const commentDelta =
            hasPrev && comment !== null && prevComment !== null ? comment - prevComment : null;
          const shareDelta =
            hasPrev && share !== null && prevShare !== null ? share - prevShare : null;
          const favoriteDelta =
            hasPrev && favorite !== null && prevFavorite !== null ? favorite - prevFavorite : null;
          const fansDeltaDelta =
            hasPrev && fansDelta !== null && prevFansDelta !== null
              ? fansDelta - prevFansDelta
              : null;
          const gapDays = hasPrev ? pt.dayNum - prevDayNum - 1 : null;

          hasPrev = true;
          prevDayNum = pt.dayNum;
          prevPlay = play;
          prevLike = like;
          prevComment = comment;
          prevShare = share;
          prevFavorite = favorite;
          prevFansDelta = fansDelta;

          if (fromDayNum !== null && pt.dayNum < fromDayNum) continue;
          if (toDayNum !== null && pt.dayNum > toDayNum) continue;

          sheetRows.push({
            date: pt.date,
            dayNum: pt.dayNum,
            platformRank,
            group: groupStr,
            platform: platformStr,
            workId,
            title,
            url,
            publishTime: publishTimeIso,
            publishDateStr,
            play,
            like,
            comment,
            share,
            favorite,
            fansDelta,
            playDelta,
            likeDelta,
            commentDelta,
            shareDelta,
            favoriteDelta,
            fansDeltaDelta,
            gapDays,
            contentKey,
            matchedBy,
            matchScore,
          });
        }
      }
    }
  }

  if (needSheetRows && sheetRows.length > 1) {
    sheetRows.sort((a, b) => {
      if (a.dayNum !== b.dayNum) return a.dayNum - b.dayNum;
      if (a.platformRank !== b.platformRank) return a.platformRank - b.platformRank;
      if (a.platform !== b.platform) return compareText(a.platform, b.platform);
      if (a.group !== b.group) return compareText(a.group, b.group);
      if (a.publishTime !== b.publishTime) {
        if (!a.publishTime) return 1;
        if (!b.publishTime) return -1;
        return a.publishTime > b.publishTime ? -1 : 1;
      }
      return compareText(a.workId, b.workId);
    });
  }

  return { sheetRows, analysisRows };
}

/** Sheet 1: 将排序后的结构化作品日明细行序列化为 Excel 二维数组（仅 Excel 导出调用） */
function formatWorkDailyAoa(rows) {
  const aoa = [WORK_DAILY_HEADERS.map(sanitizeTextCell)];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const matchedByExport =
      r.contentKey != null && VALID_EXPORT_MATCH_METHODS.has(r.matchedBy)
        ? sanitizeTextCell(r.matchedBy)
        : null;
    const matchScoreExport =
      r.contentKey != null && r.matchedBy === "fuzzy"
        ? sanitizeNumberCell(r.matchScore)
        : null;
    aoa.push([
      sanitizeTextCell(r.date),
      sanitizeTextCell(r.platform),
      sanitizeTextCell(r.group),
      sanitizeTextCell(r.contentKey),
      matchedByExport,
      matchScoreExport,
      sanitizeTextCell(r.workId),
      sanitizeTextCell(r.title),
      sanitizeTextCell(r.url),
      sanitizeTextCell(r.publishDateStr),
      sanitizeNumberCell(r.play),
      sanitizeNumberCell(r.like),
      sanitizeNumberCell(r.comment),
      sanitizeNumberCell(r.share),
      sanitizeNumberCell(r.favorite),
      sanitizeNumberCell(r.fansDelta),
      sanitizeNumberCell(r.playDelta),
      sanitizeNumberCell(r.likeDelta),
      sanitizeNumberCell(r.commentDelta),
      sanitizeNumberCell(r.shareDelta),
      sanitizeNumberCell(r.favoriteDelta),
      sanitizeNumberCell(r.fansDeltaDelta),
      sanitizeNumberCell(r.gapDays),
    ]);
  }
  return aoa;
}

function slotToUtc8Ms(dateStr, slotStr) {
  const dn = dateStrToDayNum(dateStr);
  if (dn === null) return null;
  const m = SLOT_TIME_RE.exec(typeof slotStr === "string" ? slotStr.trim() : "");
  if (!m) return null;
  return dn * DAY_MS + (Number(m[1]) * 60 + Number(m[2])) * 60000 - UTC8_MS;
}

function resolveIntradaySortTsMs(dateStr, slotStr, collectedAt) {
  if (typeof collectedAt === "number" && Number.isFinite(collectedAt) && collectedAt > 0) {
    return collectedAt;
  }
  return slotToUtc8Ms(dateStr, slotStr);
}

/**
 * 作品分时段明细结构化收集：
 * - worksIntraday 为空的账号立即跳过（不读取 acc.works 标题等元数据）
 * - sheetRows 复用 buildWorkIntradayRows（按实际 collectedAt 排序算增量与距上次小时数，保留跨 from 边界增量），跨账号按实际采集时间排序
 * - analysisRows 仅保留 [analysisFrom, analysisTo] 区间（近 7 天），且按实际 collectedAt 校验 UTC+8 日期 <= analysisTo
 */
function collectWorkIntradayStructured(
  accountsWithIntraday,
  link,
  {
    from = "",
    to = "",
    needSheetRows = false,
    needAnalysisRows = false,
    analysisFrom = "",
    analysisTo = "",
  } = {}
) {
  const hasLink = link instanceof Map;
  const sheetRows = needSheetRows ? [] : null;
  const analysisRows = needAnalysisRows ? [] : null;

  for (const entry of Array.isArray(accountsWithIntraday) ? accountsWithIntraday : []) {
    if (!entry || !isPlainObject(entry.acc) || !isPlainObject(entry.worksIntraday)) continue;
    const workIds = Object.keys(entry.worksIntraday);
    if (!workIds.length) continue;

    const acc = entry.acc;
    const groupStr = acc.group == null ? "" : String(acc.group);
    const platformStr = acc.platform == null ? "" : String(acc.platform);
    const platformRankVal = PLATFORM_RANK_MAP.get(platformStr);
    const platformRank = platformRankVal !== undefined ? platformRankVal : 999;

    if (needSheetRows) {
      const accRows = buildWorkIntradayRows({
        group: groupStr,
        platform: platformStr,
        works: acc.works,
        worksIntraday: entry.worksIntraday,
        from,
        to,
        link: hasLink ? link : undefined,
      });
      for (let i = 0; i < accRows.length; i++) {
        const r = accRows[i];
        sheetRows.push({
          ...r,
          platformRank,
          sortTsMs: resolveIntradaySortTsMs(r.date, r.slot, r.collectedAt),
        });
      }
    }

    if (needAnalysisRows) {
      const workById = new Map();
      if (Array.isArray(acc.works)) {
        for (let i = 0; i < acc.works.length; i++) {
          const w = acc.works[i];
          if (w && w.workId != null && w.workId !== "") {
            workById.set(String(w.workId), w);
          }
        }
      }
      for (let wi = 0; wi < workIds.length; wi++) {
        const workId = workIds[wi];
        const list = safeOwnGet(entry.worksIntraday, workId);
        if (!Array.isArray(list) || !list.length) continue;

        const linkInfo = hasLink
          ? link.get(`${groupStr}|${platformStr}|${workId}`) ||
            link.get(`${platformStr}|${workId}`) ||
            null
          : null;
        const contentKey =
          hasLink && linkInfo && linkInfo.contentKey != null ? linkInfo.contentKey : null;
        const meta = workById.get(workId);
        const title = meta ? meta.title || "(无标题)" : DELETED_WORK_TITLE;
        const { ms: publishTimeMs, utc8Date: publishDateStr } = meta
          ? parsePublishTimeForTable(meta.publishTime)
          : { ms: 0, utc8Date: null };

        for (let pi = 0; pi < list.length; pi++) {
          const pt = list[pi];
          if (!isPlainObject(pt)) continue;
          const date = typeof pt.date === "string" ? pt.date.trim() : "";
          const slot = typeof pt.slot === "string" ? pt.slot.trim() : "";
          if (!isValidDateStr(date) || !SLOT_TIME_RE.test(slot)) continue;
          if (analysisFrom && date < analysisFrom) continue;
          if (analysisTo && date > analysisTo) continue;
          const collectedAt = parseRawTimestampMs(pt.collectedAt);
          if (analysisTo && collectedAt !== null && formatUtc8Date(collectedAt) > analysisTo) {
            continue;
          }
          const play = hasOwn(pt, "play") ? fastNormalizeMetric(pt.play) : null;
          if (play === null) continue;
          analysisRows.push({
            date,
            slot,
            collectedAt,
            group: groupStr,
            platform: platformStr,
            workId,
            title,
            publishTime: publishTimeMs || "",
            publishTimeMs,
            publishDate: publishDateStr || "",
            contentKey,
            play,
          });
        }
      }
    }
  }

  if (needSheetRows && sheetRows.length > 1) {
    sheetRows.sort((a, b) => {
      if (a.sortTsMs !== null && b.sortTsMs !== null && a.sortTsMs !== b.sortTsMs) {
        return a.sortTsMs - b.sortTsMs;
      }
      if (a.sortTsMs !== null && b.sortTsMs === null) return -1;
      if (a.sortTsMs === null && b.sortTsMs !== null) return 1;
      if (a.date !== b.date) return compareText(a.date, b.date);
      if (a.slot !== b.slot) return compareText(a.slot, b.slot);
      if (a.platformRank !== b.platformRank) return a.platformRank - b.platformRank;
      if (a.platform !== b.platform) return compareText(a.platform, b.platform);
      if (a.group !== b.group) return compareText(a.group, b.group);
      if (a.publishTime !== b.publishTime) {
        if (!a.publishTime) return 1;
        if (!b.publishTime) return -1;
        return a.publishTime > b.publishTime ? -1 : 1;
      }
      return compareText(a.workId, b.workId);
    });
  }

  return { sheetRows, analysisRows };
}

/** Sheet 2: 作品时段明细 Excel 二维表格式化 */
function formatWorkIntradayAoa(rows) {
  const aoa = [WORK_INTRADAY_HEADERS.map(sanitizeTextCell)];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const matchedByExport =
      r.contentKey != null && VALID_EXPORT_MATCH_METHODS.has(r.matchedBy)
        ? sanitizeTextCell(r.matchedBy)
        : null;
    const collectedAtText =
      typeof r.collectedAt === "number" && Number.isFinite(r.collectedAt) && r.collectedAt > 0
        ? formatUtc8DateTime(r.collectedAt)
        : null;
    aoa.push([
      sanitizeTextCell(r.date),
      sanitizeTextCell(r.slot),
      sanitizeTextCell(collectedAtText),
      sanitizeTextCell(r.platform),
      sanitizeTextCell(r.group),
      sanitizeTextCell(r.contentKey),
      matchedByExport,
      sanitizeTextCell(r.workId),
      sanitizeTextCell(r.title),
      sanitizeNumberCell(r.play),
      sanitizeNumberCell(r.like),
      sanitizeNumberCell(r.comment),
      sanitizeNumberCell(r.share),
      sanitizeNumberCell(r.favorite),
      sanitizeNumberCell(r.fansDelta),
      sanitizeNumberCell(r.playDelta),
      sanitizeNumberCell(r.likeDelta),
      sanitizeNumberCell(r.commentDelta),
      sanitizeNumberCell(r.hoursSincePrev),
    ]);
  }
  return aoa;
}

function normalizeFullPathForKey(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\\/g, "/");
  if (!s) return "";
  const isUnc = s.startsWith("//");
  s = isUnc ? `//${s.slice(2).replace(/\/+/g, "/")}` : s.replace(/\/+/g, "/");
  if (s.endsWith("/")) return "";
  if (
    /^[a-zA-Z]:\/.+/.test(s) ||
    (!isUnc && /^\/.+/.test(s)) ||
    (isUnc && /^\/\/[^/]+\/[^/]+\/.+/.test(s))
  ) {
    return s;
  }
  return "";
}

function normalizeDirectUrlForExport(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  } catch (_) {
    return "";
  }
  if (isManagementUrl(trimmed)) return "";
  return normalizeUrl(trimmed);
}

/**
 * 提取单条发布记录的发布时间（按优先级）：
 * - tier 2：已确认的发布时间（lastPublishAt / 成功时间）
 * - tier 3：记录创建时间（createTime）
 * - tier 4：仅记录日期（date，无时分秒）
 */
function extractPushRecordPublishTime(rec, status, hasStatusField) {
  const baseDate =
    typeof rec.date === "string" && isValidDateStr(rec.date.trim()) ? rec.date.trim() : "";
  const lastMs = parseRawTimestampMs(rec.lastPublishAt);
  const lastDate = lastMs !== null ? formatUtc8Date(lastMs) : "";
  const isConfirmedRecord = status === "success" || !hasStatusField;
  if (isConfirmedRecord && lastMs !== null && (!baseDate || lastDate >= baseDate)) {
    return { ms: lastMs, date: lastDate, tier: 2 };
  }
  const createMs = parseRawTimestampMs(rec.createTime);
  const createDate = createMs !== null ? formatUtc8Date(createMs) : "";
  if (baseDate) {
    if (isConfirmedRecord && lastMs !== null && lastDate === baseDate) {
      return { ms: lastMs, date: baseDate, tier: 2 };
    }
    if (createMs !== null && createDate === baseDate) {
      return { ms: createMs, date: baseDate, tier: 3 };
    }
    return { ms: null, date: baseDate, tier: 4 };
  }
  if (isConfirmedRecord && lastMs !== null) {
    return { ms: lastMs, date: lastDate, tier: 2 };
  }
  if (createMs !== null) {
    return { ms: createMs, date: createDate, tier: 3 };
  }
  return { ms: null, date: "", tier: 5 };
}

function compareFallbackRecordTime(a, b) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.ms !== null && b.ms !== null && a.ms !== b.ms) return a.ms - b.ms;
  if (a.ms !== null && b.ms === null) return -1;
  if (a.ms === null && b.ms !== null) return 1;
  if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
  return 0;
}

/**
 * 按「作品」解析发布时间优先级并汇总每条内容截至 cutoffTo 的最早已知首发时间：
 * - 单作品优先级：平台实采 publishTime（tier 1） > 发布记录已确认发布时间 lastPublishAt（tier 2） > 记录创建时间 createTime（tier 3） > 仅日期（tier 4）
 * - 同一作品的发布记录（直链匹配或同组同平台且日期窗 ≤2 天无冲突直链）不得覆盖该作品的平台实采 publishTime
 * - 未匹配到已采集作品的发布记录视为独立作品（例如旧平台首发未采集、新平台后补发），继续参与内容级最早已知首发判定（补发不算新作品）
 * - 若已采集作品缺失平台 publishTime，返回 workFallbackByPwKey 供分析用 analysisRows 补齐
 */
function resolveAnalysisPublishTimes(
  summaryRows,
  allContents,
  allAccountsData,
  link,
  cutoffTo,
  allPushRecords
) {
  if (!Array.isArray(summaryRows) || summaryRows.length === 0) {
    return { summaryRows: [], workFallbackByPwKey: new Map() };
  }
  const linkMeta = link instanceof Map ? getLinkResultMeta(link) : null;
  const byWorkIdentity = linkMeta && linkMeta.byWorkIdentity ? linkMeta.byWorkIdentity : null;
  const excludedFuturePwKeys =
    linkMeta && linkMeta.excludedFuturePwKeys ? linkMeta.excludedFuturePwKeys : null;

  const contentKeySet = new Set();
  for (const c of Array.isArray(allContents) ? allContents : []) {
    if (isPlainObject(c) && c.contentKey) contentKeySet.add(String(c.contentKey));
  }

  // 1. 收集全量已采集作品（按 platform|workId 去重，归到 S6 关联后的 contentKey）
  const worksByContent = new Map();
  const workByPwKey = new Map();
  for (const acc of Array.isArray(allAccountsData) ? allAccountsData : []) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group).trim();
    const rawGroup = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform).trim();
    const rawPlatform = acc.platform == null ? "" : String(acc.platform);
    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const workId = String(w.workId);
      const pwKey = makeWorkIdentityKey(rawPlatform, workId);
      if (excludedFuturePwKeys && excludedFuturePwKeys.has(pwKey)) continue;
      const pubMs = parseRawTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? formatUtc8Date(pubMs) : "";
      if (cutoffTo && pubDate && pubDate > cutoffTo) continue;

      const linkEntry =
        (byWorkIdentity && byWorkIdentity.get(pwKey)) ||
        (link instanceof Map ? link.get(makeWorkKey(rawGroup, rawPlatform, workId)) : null);
      const ck =
        linkEntry && linkEntry.contentKey
          ? String(linkEntry.contentKey)
          : `unlinked:${rawPlatform}:${workId}`;

      const normUrl = normalizeDirectUrlForExport(w.url);
      let workInfo = workByPwKey.get(pwKey);
      if (!workInfo) {
        workInfo = {
          pwKey,
          contentKey: ck,
          platform,
          groups: new Set(),
          normUrl,
          pubMs,
          pubDate,
          dayNum: pubDate ? dateStrToDayNum(pubDate) : null,
          fallbackRec: null,
        };
        workByPwKey.set(pwKey, workInfo);
        let arr = worksByContent.get(ck);
        if (!arr) {
          arr = [];
          worksByContent.set(ck, arr);
        }
        arr.push(workInfo);
      } else {
        if (!workInfo.normUrl && normUrl) workInfo.normUrl = normUrl;
        if (pubMs !== null && (workInfo.pubMs === null || pubMs < workInfo.pubMs)) {
          workInfo.pubMs = pubMs;
          workInfo.pubDate = pubDate;
          workInfo.dayNum = dateStrToDayNum(pubDate);
        }
      }
      if (group) workInfo.groups.add(group);
    }
  }

  // 2. 收集全部有效发布记录（与 buildContentIndex 相同口径），按 contentKey 分组
  const recsByContent = new Map();
  if (Array.isArray(allPushRecords) && allPushRecords.length > 0 && contentKeySet.size > 0) {
    for (let idx = 0; idx < allPushRecords.length; idx++) {
      const rec = allPushRecords[idx];
      if (!isPlainObject(rec)) continue;
      const textType = typeof rec.textType === "string" ? rec.textType.trim().toLowerCase() : "";
      if (textType === "article") continue;
      const hasStatusField = hasOwn(rec, "publishStatus") && rec.publishStatus !== undefined;
      const status =
        typeof rec.publishStatus === "string" ? rec.publishStatus.trim().toLowerCase() : "";
      if (hasStatusField && status !== "success") continue;

      const rawLink = typeof rec.videoLink === "string" ? rec.videoLink.trim() : "";
      const repubCnt = fastNormalizeMetric(rec.republishCount);
      const attCnt = fastNormalizeMetric(rec.publishAttemptCount);
      const isRepub =
        (repubCnt !== null && repubCnt > 0) ||
        (repubCnt === null && attCnt !== null && attCnt > 1);
      const normUrl = !isRepub ? normalizeDirectUrlForExport(rawLink) : "";
      if (!hasStatusField && !normUrl) continue;

      const fullPath =
        normalizeFullPathForKey(rec.filePath) || normalizeFullPathForKey(rec.selectedFile);
      const recId =
        typeof rec.id === "string" || typeof rec.id === "number" ? String(rec.id).trim() : "";
      let ck = "";
      if (fullPath) {
        const cand = `file:${fullPath.toLowerCase()}`;
        if (contentKeySet.has(cand)) ck = cand;
      } else {
        const cands = recId
          ? [`record:id:${recId}`, `record:id:${recId}:pos:${idx}`, `record:pos:${idx}`]
          : [`record:pos:${idx}`];
        for (const cand of cands) {
          if (contentKeySet.has(cand)) {
            ck = cand;
            break;
          }
        }
      }
      if (!ck) continue;

      const recTime = extractPushRecordPublishTime(rec, status, hasStatusField);
      if (cutoffTo && recTime.date && recTime.date > cutoffTo) continue;
      if (!recTime.date && recTime.ms === null) continue;

      const platform = typeof rec.pt === "string" ? rec.pt.trim() : "";
      const group = resolveRecordGroup(rec);
      let arr = recsByContent.get(ck);
      if (!arr) {
        arr = [];
        recsByContent.set(ck, arr);
      }
      arr.push({
        platform,
        group,
        normUrl,
        ms: recTime.ms,
        date: recTime.date,
        dayNum: recTime.date ? dateStrToDayNum(recTime.date) : null,
        tier: recTime.tier,
      });
    }
  }

  // 3. 逐内容将发布记录匹配到对应作品，按「作品」决定优先级后再取内容最早已知首发时间
  const infoByContentKey = new Map();
  const workFallbackByPwKey = new Map();
  const allContentKeys = new Set([...worksByContent.keys(), ...recsByContent.keys()]);

  for (const ck of allContentKeys) {
    const works = worksByContent.get(ck) || [];
    const recs = recsByContent.get(ck) || [];
    const matchedWorkPwKeys = new Set();
    // 已被发布记录直链精确匹配的作品：日期兜底不再把其他（如同账号更早首发）记录吸到它身上
    const linkMatchedPwKeys = new Set();
    const unmatchedRecs = [];
    const remainingRecs = [];

    // Pass 1：直链精确 1:1 匹配同一作品
    for (const rec of recs) {
      if (rec.normUrl) {
        const urlMatch = works.find(
          (w) => w.normUrl && w.normUrl === rec.normUrl && (!rec.platform || w.platform === rec.platform)
        );
        if (urlMatch) {
          matchedWorkPwKeys.add(urlMatch.pwKey);
          linkMatchedPwKeys.add(urlMatch.pwKey);
          if (
            urlMatch.pubMs === null &&
            (!urlMatch.fallbackRec || compareFallbackRecordTime(rec, urlMatch.fallbackRec) < 0)
          ) {
            urlMatch.fallbackRec = rec;
          }
          continue;
        }
      }
      remainingRecs.push(rec);
    }

    // Pass 2：同平台同分组（无冲突直链、日期窗 ≤2 天或任一端缺日期）匹配同一作品
    for (const rec of remainingRecs) {
      let bestWork = null;
      let bestUnmatched = false;
      let bestDayDiff = Infinity;
      for (const w of works) {
        if (linkMatchedPwKeys.has(w.pwKey)) continue;
        if (rec.platform && w.platform !== rec.platform) continue;
        if (rec.group && w.groups.size > 0 && !w.groups.has(rec.group)) continue;
        if (rec.normUrl && w.normUrl && rec.normUrl !== w.normUrl) continue;
        let dayDiff = 3;
        if (w.dayNum !== null && rec.dayNum !== null) {
          dayDiff = Math.abs(w.dayNum - rec.dayNum);
          if (dayDiff > 2) continue;
        }
        const isUnmatched = !matchedWorkPwKeys.has(w.pwKey);
        if (
          !bestWork ||
          (isUnmatched && !bestUnmatched) ||
          (isUnmatched === bestUnmatched && dayDiff < bestDayDiff)
        ) {
          bestWork = w;
          bestUnmatched = isUnmatched;
          bestDayDiff = dayDiff;
        }
      }
      if (bestWork) {
        matchedWorkPwKeys.add(bestWork.pwKey);
        if (
          bestWork.pubMs === null &&
          (!bestWork.fallbackRec || compareFallbackRecordTime(rec, bestWork.fallbackRec) < 0)
        ) {
          bestWork.fallbackRec = rec;
        }
      } else {
        unmatchedRecs.push(rec);
      }
    }

    // 汇总本内容全部作品（已采集作品 + 未采集到的发布记录作品）的发布时间
    const resolvedWorkTimes = [];
    for (const w of works) {
      if (w.pubMs !== null) {
        // tier 1：平台实采 publishTime 优先级最高
        resolvedWorkTimes.push({ ms: w.pubMs, date: w.pubDate });
      } else if (w.fallbackRec) {
        const fb = { ms: w.fallbackRec.ms, date: w.fallbackRec.date };
        resolvedWorkTimes.push(fb);
        workFallbackByPwKey.set(w.pwKey, fb);
      }
    }
    for (const rec of unmatchedRecs) {
      resolvedWorkTimes.push({ ms: rec.ms, date: rec.date });
    }

    let earliestDate = "";
    for (const wt of resolvedWorkTimes) {
      if (wt.date && (!earliestDate || wt.date < earliestDate)) {
        earliestDate = wt.date;
      }
    }
    let earliestMs = null;
    if (earliestDate) {
      for (const wt of resolvedWorkTimes) {
        if (wt.date === earliestDate && wt.ms !== null) {
          if (earliestMs === null || wt.ms < earliestMs) {
            earliestMs = wt.ms;
          }
        }
      }
    }
    if (earliestDate || earliestMs !== null) {
      infoByContentKey.set(ck, { pubDate: earliestDate, pubMs: earliestMs });
    }
  }

  const enrichedSummaryRows = summaryRows.map((row) => {
    if (!isPlainObject(row) || !row.contentKey) return row;
    const info = infoByContentKey.get(String(row.contentKey));
    if (!info) return row;
    const curDate =
      typeof row.firstPublishDate === "string" && isValidDateStr(row.firstPublishDate.trim())
        ? row.firstPublishDate.trim()
        : "";
    return {
      ...row,
      firstPublishDate: info.pubDate || curDate,
      firstPublishTime: info.pubMs,
    };
  });

  return { summaryRows: enrichedSummaryRows, workFallbackByPwKey };
}

function applyWorkFallbackPublishTimes(analysisRows, workFallbackByPwKey) {
  if (!Array.isArray(analysisRows) || !(workFallbackByPwKey instanceof Map) || workFallbackByPwKey.size === 0) {
    return;
  }
  for (let i = 0; i < analysisRows.length; i++) {
    const row = analysisRows[i];
    if (row.publishTimeMs > 0 || row.publishDate) continue;
    const fb = workFallbackByPwKey.get(`${row.platform}|${row.workId}`);
    if (!fb) continue;
    if (fb.ms !== null) {
      row.publishTimeMs = fb.ms;
      row.publishTime = fb.ms;
    }
    if (fb.date) {
      row.publishDate = fb.date;
    }
  }
}

/** Sheet 2: 作品跨平台汇总 */
function buildContentSummarySheet(summaryRows) {
  const pgKeySet = new Set();
  for (const row of summaryRows) {
    if (!isPlainObject(row.perPlatform)) continue;
    for (const pgKey of Object.keys(row.perPlatform)) {
      pgKeySet.add(pgKey);
    }
  }

  const pgEntries = [...pgKeySet]
    .map((pgKey) => ({ pgKey, ...parsePgKey(pgKey) }))
    .sort((a, b) => {
      const pc = comparePlatform(a.platform, b.platform);
      if (pc !== 0) return pc;
      return compareText(a.group, b.group);
    });

  const dynamicHeaders = [];
  const dynamicSchemaEntries = [];
  for (const entry of pgEntries) {
    const prefix = entry.group ? `${entry.platform}·${entry.group}` : entry.platform;
    const labelPlay = `${prefix}·播放`;
    const labelLike = `${prefix}·点赞`;
    const labelComment = `${prefix}·评论`;
    dynamicHeaders.push(labelPlay, labelLike, labelComment);
    dynamicSchemaEntries.push(
      {
        col: labelPlay,
        key: `perPlatform.${entry.pgKey}.play`,
        desc: `截至结束日期（to），${prefix} 的最新累计播放量（累计值；无快照或平台缺项为空）。`,
      },
      {
        col: labelLike,
        key: `perPlatform.${entry.pgKey}.like`,
        desc: `截至结束日期（to），${prefix} 的最新累计点赞数（累计值；无快照或平台缺项为空）。`,
      },
      {
        col: labelComment,
        key: `perPlatform.${entry.pgKey}.comment`,
        desc: `截至结束日期（to），${prefix} 的最新累计评论数（累计值；无快照或平台缺项为空）。`,
      }
    );
  }

  const headers = [...SUMMARY_BASE_HEADERS, ...dynamicHeaders, "作品链接"];
  const aoa = [headers.map(sanitizeTextCell)];

  for (const row of summaryRows) {
    const matchMethodExport = VALID_EXPORT_MATCH_METHODS.has(row.matchMethod)
      ? sanitizeTextCell(row.matchMethod)
      : null;
    const cells = [
      sanitizeTextCell(row.contentKey),
      sanitizeTextCell(row.title),
      sanitizeTextCell(row.file),
      sanitizeTextCell(row.firstPublishDate),
      sanitizeNumberCell(row.platformCount),
      matchMethodExport,
      sanitizeNumberCell(row.totalPlay),
      sanitizeNumberCell(row.totalLike),
      sanitizeNumberCell(row.totalComment),
      sanitizeNumberCell(row.totalShare),
      sanitizeNumberCell(row.totalFavorite),
      sanitizeNumberCell(row.totalFansDelta),
    ];

    const urlList = [];
    const seenUrls = new Set();

    for (const entry of pgEntries) {
      const cell =
        isPlainObject(row.perPlatform) && hasOwn(row.perPlatform, entry.pgKey)
          ? row.perPlatform[entry.pgKey]
          : null;
      if (cell) {
        cells.push(
          sanitizeNumberCell(cell.play),
          sanitizeNumberCell(cell.like),
          sanitizeNumberCell(cell.comment)
        );
        if (Array.isArray(cell.urls)) {
          for (const u of cell.urls) {
            if (typeof u === "string" && u.trim() && !seenUrls.has(u.trim())) {
              seenUrls.add(u.trim());
              urlList.push(u.trim());
            }
          }
        }
      } else {
        cells.push(null, null, null);
      }
    }

    cells.push(sanitizeTextCell(urlList.length ? urlList.join("\n") : null));
    aoa.push(cells);
  }

  return { aoa, dynamicSchemaEntries };
}

/**
 * Sheet 3: 平台日汇总（由作品日明细按「日期+平台+作品ID」去重后按 日期+平台 求和；
 * 同一作品多分组只取按分组名排序第一组的一份观测，null 不计，全 null 为空）
 */
function buildPlatformDailySheet(workDailyRows) {
  const buckets = new Map();

  for (const r of workDailyRows) {
    const key = `${r.date}\0${r.platform}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        date: r.date,
        platform: r.platform,
        byWorkId: new Map(),
      };
      buckets.set(key, bucket);
    }

    const workId = r.workId == null ? "" : String(r.workId);
    const existing = bucket.byWorkId.get(workId);
    if (!existing || compareText(String(r.group || ""), String(existing.group || "")) < 0) {
      bucket.byWorkId.set(workId, r);
    }
  }

  const rows = [];
  for (const bucket of buckets.values()) {
    const agg = {
      date: bucket.date,
      platform: bucket.platform,
      workCount: 0,
      sums: Object.create(null),
    };
    for (const dk of WORK_DELTA_KEYS) agg.sums[dk] = null;

    for (const obs of bucket.byWorkId.values()) {
      const hasCumulativeData = WORK_STAT_KEYS.some((k) => obs[k] !== null);
      if (hasCumulativeData) agg.workCount += 1;

      for (const dk of WORK_DELTA_KEYS) {
        const val = obs[dk];
        if (typeof val === "number" && Number.isFinite(val)) {
          const next = agg.sums[dk] === null ? val : agg.sums[dk] + val;
          agg.sums[dk] = next === 0 ? 0 : next;
        }
      }
    }
    rows.push(agg);
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return compareText(a.date, b.date);
    return comparePlatform(a.platform, b.platform);
  });

  const aoa = [PLATFORM_DAILY_HEADERS.map(sanitizeTextCell)];
  for (const r of rows) {
    aoa.push([
      sanitizeTextCell(r.date),
      sanitizeTextCell(r.platform),
      sanitizeNumberCell(r.workCount),
      sanitizeNumberCell(r.sums.playDelta),
      sanitizeNumberCell(r.sums.likeDelta),
      sanitizeNumberCell(r.sums.commentDelta),
      sanitizeNumberCell(r.sums.shareDelta),
      sanitizeNumberCell(r.sums.favoriteDelta),
      sanitizeNumberCell(r.sums.fansDeltaDelta),
    ]);
  }

  return { aoa, rows };
}

/** 拆出的账号日快照结构化读取函数（daily.json，日增=与上一有记录日之差，不生成 Excel 二维表） */
function collectAccountDailyRows(accountsData, from, to, { sortRows = true } = {}) {
  const allRows = [];

  for (const acc of accountsData) {
    if (!isPlainObject(acc.daily)) continue;
    const dates = Object.keys(acc.daily)
      .filter((d) => isValidDateStr(d) && isPlainObject(safeOwnGet(acc.daily, d)))
      .sort(compareText);

    let prevFans = null;
    let prevPlays = null;

    for (let di = 0; di < dates.length; di++) {
      const date = dates[di];
      const snap = safeOwnGet(acc.daily, date);
      const vals = {};
      for (const k of ACCOUNT_METRIC_KEYS) {
        vals[k] = hasOwn(snap, k) ? fastNormalizeMetric(snap[k]) : null;
      }
      const isPlaysAnomaly = snap.playsAnomaly === true;
      if (isPlaysAnomaly) {
        vals.plays = null;
      }

      const fansDelta =
        vals.fans !== null && prevFans !== null ? vals.fans - prevFans : null;
      const playsDelta =
        !isPlaysAnomaly && vals.plays !== null && prevPlays !== null
          ? vals.plays - prevPlays
          : null;

      if (vals.fans !== null) prevFans = vals.fans;
      if (!isPlaysAnomaly && vals.plays !== null) prevPlays = vals.plays;

      if (to && date > to) continue;

      allRows.push({
        date,
        platform: acc.platform,
        group: acc.group,
        fans: vals.fans,
        plays: vals.plays,
        likes: vals.likes,
        comments: vals.comments,
        favorites: vals.favorites,
        shares: vals.shares,
        fansDelta: fansDelta === 0 ? 0 : fansDelta,
        playsDelta: playsDelta === 0 ? 0 : playsDelta,
        ...(isPlaysAnomaly
          ? {
              playsAnomaly: true,
              playsAnomalyDetail: isPlainObject(snap.playsAnomalyDetail)
                ? snap.playsAnomalyDetail
                : null,
            }
          : {}),
      });
    }
  }

  if (sortRows && allRows.length > 1) {
    allRows.sort((a, b) => {
      if (a.date !== b.date) return compareText(a.date, b.date);
      const pc = comparePlatform(a.platform, b.platform);
      if (pc !== 0) return pc;
      return compareText(a.group, b.group);
    });
  }

  const rows = from ? allRows.filter((r) => r.date >= from) : allRows;
  return { rows, allRows };
}

/** 用「分析」同款账号异常识别结果统一清洗「账号日快照」导出行（含旧 daily.json） */
function reconcileAccountDailyRowsWithAnalysis(rows, analysis) {
  const cleaned =
    analysis && Array.isArray(analysis._cleanedAccountRows)
      ? analysis._cleanedAccountRows
      : [];
  if (!cleaned.length) return rows;
  const byKey = new Map();
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (!c || !c.date || !c.platform) continue;
    byKey.set(`${c.date}\0${c.platform}\0${c.group || ""}`, c);
  }
  return rows.map((r) => {
    const c = byKey.get(`${r.date}\0${r.platform}\0${r.group || ""}`);
    if (!c) return r;
    const isAnom = Boolean(c.playsAnomaly);
    return {
      ...r,
      plays: isAnom ? null : c.plays,
      playsDelta: isAnom ? null : c.playsDelta,
      playsAnomaly: isAnom,
      playsAnomalyDetail: isAnom ? c.playsAnomalyDetail || r.playsAnomalyDetail || null : null,
      playsAnomalyNote: isAnom ? c.playsAnomalyNote || "播放异常（已排除播放日增）" : null,
    };
  });
}

/** Sheet 4: 账号日快照 Excel 二维表格式化（仅 Excel 导出调用） */
function formatAccountDailyAoa(rows) {
  const aoa = [ACCOUNT_DAILY_HEADERS.map(sanitizeTextCell)];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const anomNote = r.playsAnomaly
      ? r.playsAnomalyNote ||
        (r.playsAnomalyDetail && r.playsAnomalyDetail.reason
          ? `${r.playsAnomalyDetail.reason}（已排除播放日增）`
          : "播放异常（已排除播放日增）")
      : null;
    aoa.push([
      sanitizeTextCell(r.date),
      sanitizeTextCell(r.platform),
      sanitizeTextCell(r.group),
      sanitizeNumberCell(r.fans),
      sanitizeNumberCell(r.plays),
      sanitizeNumberCell(r.likes),
      sanitizeNumberCell(r.comments),
      sanitizeNumberCell(r.favorites),
      sanitizeNumberCell(r.shares),
      sanitizeNumberCell(r.fansDelta),
      sanitizeNumberCell(r.playsDelta),
      sanitizeTextCell(anomNote),
    ]);
  }
  return aoa;
}

/** Sheet 5: 分析（首块为文字小结，其后按 1–6 节输出长表，节间空一行，数值保持 number） */
function buildAnalysisSheet(analysis) {
  const aoa = [];
  const a = isPlainObject(analysis) ? analysis : {};
  const curRange = isPlainObject(a.currentRange) ? a.currentRange : { from: "", to: "" };
  const prevRange = isPlainObject(a.previousRange) ? a.previousRange : { from: "", to: "" };
  const period = typeof a.period === "number" ? a.period : DEFAULT_ANALYSIS_PERIOD;

  // 首块：文字小结（每行一句）
  aoa.push([sanitizeTextCell("文字小结")]);
  const summaryLines =
    isPlainObject(a.summary) && Array.isArray(a.summary.lines) ? a.summary.lines : [];
  for (const line of summaryLines) {
    aoa.push([sanitizeTextCell(line)]);
  }
  aoa.push([]);

  // 第 1 节：总览（本周期 vs 上一周期；明确统计区间与实际覆盖天数；涨粉以账号日快照为主、单作品为辅）
  const cov =
    isPlainObject(a.overview) && isPlainObject(a.overview.coverage)
      ? a.overview.coverage
      : isPlainObject(a.coverage)
      ? a.coverage
      : null;
  const overviewTitle = cov && cov.rangeText
    ? `一、总览（${cov.rangeText}；对比上周期 ${prevRange.from} ~ ${prevRange.to}）`
    : `一、总览（统计区间 ${curRange.from} ~ ${curRange.to}，对比上周期 ${prevRange.from} ~ ${prevRange.to}，周期 ${period} 天）`;
  aoa.push([sanitizeTextCell(overviewTitle)]);
  if (cov && cov.isPartial && cov.partialNotice) {
    aoa.push([sanitizeTextCell(`覆盖提示：${cov.partialNotice}`)]);
  }
  aoa.push(["指标", "本周期增量", "上周期增量", "环比(%)", "数据来源"].map(sanitizeTextCell));
  const overviewMetricRows =
    isPlainObject(a.overview) && Array.isArray(a.overview.metricRows)
      ? a.overview.metricRows
      : null;
  if (overviewMetricRows) {
    for (const m of overviewMetricRows) {
      if (!m) continue;
      aoa.push([
        sanitizeTextCell(m.label || m.key),
        sanitizeNumberCell(m.current),
        sanitizeNumberCell(m.previous),
        sanitizeNumberCell(m.momPct),
        sanitizeTextCell(m.source || null),
      ]);
    }
  } else {
    const metrics =
      isPlainObject(a.overview) && isPlainObject(a.overview.metrics) ? a.overview.metrics : {};
    for (const k of WORK_STAT_KEYS) {
      const m = metrics[k];
      if (!m) continue;
      aoa.push([
        sanitizeTextCell(m.label || k),
        sanitizeNumberCell(m.current),
        sanitizeNumberCell(m.previous),
        sanitizeNumberCell(m.momPct),
        sanitizeTextCell(m.source || null),
      ]);
    }
  }
  aoa.push([]);

  // 第 1 节（续）：各平台贡献占比（按播放日增）
  aoa.push([sanitizeTextCell("一（续）、各平台贡献占比（按播放日增）")]);
  aoa.push(
    [
      "平台",
      "播放日增",
      "播放占比(%)",
      "点赞日增",
      "评论日增",
      "分享日增",
      "收藏日增",
      "涨粉日增",
    ].map(sanitizeTextCell)
  );
  const contrib =
    isPlainObject(a.overview) && Array.isArray(a.overview.platformContribution)
      ? a.overview.platformContribution
      : [];
  for (const r of contrib) {
    aoa.push([
      sanitizeTextCell(r.platform),
      sanitizeNumberCell(r.play),
      sanitizeNumberCell(r.sharePct),
      sanitizeNumberCell(r.like),
      sanitizeNumberCell(r.comment),
      sanitizeNumberCell(r.share),
      sanitizeNumberCell(r.favorite),
      sanitizeNumberCell(r.fansDelta),
    ]);
  }
  aoa.push([]);

  // 第 2 节：平台对比（仅覆盖 >=2 平台内容）
  aoa.push([
    sanitizeTextCell(
      "二、平台对比（仅覆盖 ≥2 平台内容；加权互动率=Σ(点赞+评论+分享+收藏)/Σ播放，另附三项互动率供跨平台对比）"
    ),
  ]);
  aoa.push(
    [
      "平台",
      "样本数",
      "平均播放",
      "加权互动率(%)",
      "三项互动率(%)",
      "平均涨粉",
      "备注",
    ].map(sanitizeTextCell)
  );
  const pc = isPlainObject(a.platformComparison) ? a.platformComparison : {};
  for (const p of Array.isArray(pc.platforms) ? pc.platforms : []) {
    aoa.push([
      sanitizeTextCell(p.platform),
      sanitizeNumberCell(p.sampleCount),
      sanitizeNumberCell(p.avgPlay),
      sanitizeNumberCell(p.engagementRatePct),
      sanitizeNumberCell(p.engagementRate3Pct),
      sanitizeNumberCell(p.avgFansDelta),
      sanitizeTextCell(p.note || null),
    ]);
  }
  for (const c of Array.isArray(pc.conclusions) ? pc.conclusions : []) {
    aoa.push([sanitizeTextCell("结论"), sanitizeTextCell(c)]);
  }
  aoa.push([]);

  // 第 3 节：作品排行（总播放 / 互动率[总播放>=100] / 总涨粉 各 Top10 & Bottom10）
  aoa.push([
    sanitizeTextCell("三、作品排行（总播放 / 互动率[总播放≥100] / 总涨粉 Top10 & Bottom10）"),
  ]);
  aoa.push(
    [
      "榜单",
      "排名",
      "内容ID",
      "标题",
      "首发日期",
      "覆盖平台数",
      "总播放",
      "互动率(%)",
      "总涨粉",
    ].map(sanitizeTextCell)
  );
  const rk = isPlainObject(a.rankings) ? a.rankings : {};
  const rankGroups = [
    ["总播放 Top10", rk.byPlay && rk.byPlay.top],
    ["总播放 Bottom10", rk.byPlay && rk.byPlay.bottom],
    ["互动率 Top10", rk.byEngagement && rk.byEngagement.top],
    ["互动率 Bottom10", rk.byEngagement && rk.byEngagement.bottom],
    ["总涨粉 Top10", rk.byFans && rk.byFans.top],
    ["总涨粉 Bottom10", rk.byFans && rk.byFans.bottom],
  ];
  for (const [label, list] of rankGroups) {
    for (let i = 0; i < (Array.isArray(list) ? list.length : 0); i++) {
      const item = list[i];
      aoa.push([
        sanitizeTextCell(label),
        sanitizeNumberCell(i + 1),
        sanitizeTextCell(item.contentKey),
        sanitizeTextCell(item.title),
        sanitizeTextCell(item.firstPublishDate || null),
        sanitizeNumberCell(item.platformCount),
        sanitizeNumberCell(item.totalPlay),
        sanitizeNumberCell(item.engagementRatePct),
        sanitizeNumberCell(item.totalFansDelta),
      ]);
    }
  }
  aoa.push([]);

  // 第 3 节（续）：平台偏科
  aoa.push([sanitizeTextCell("三（续）、平台偏科（单平台播放 ≥ 其它平台均值 3 倍且 ≥ 500）")]);
  aoa.push(
    ["内容ID", "标题", "突出平台", "该平台播放", "其它平台均播", "倍数"].map(
      sanitizeTextCell
    )
  );
  for (const s of Array.isArray(rk.platformSkew) ? rk.platformSkew : []) {
    aoa.push([
      sanitizeTextCell(s.contentKey),
      sanitizeTextCell(s.title),
      sanitizeTextCell(s.platform),
      sanitizeNumberCell(s.platformPlay),
      sanitizeNumberCell(s.otherAvgPlay),
      sanitizeNumberCell(s.ratio),
    ]);
  }
  aoa.push([]);

  // 第 4 节：新作品走势（发布后第 1/3/7 天各平台累计播放）
  aoa.push([sanitizeTextCell("四、新作品走势（本周期发布，发布后 D1/D3/D7 累计播放）")]);
  aoa.push(
    [
      "内容ID",
      "标题",
      "平台",
      "发布日期",
      "D1播放",
      "D3播放",
      "D7播放",
      "D3/D1",
      "D7/D3",
      "走势分类",
      "分类依据",
    ].map(sanitizeTextCell)
  );
  const nw = isPlainObject(a.newWorks) && Array.isArray(a.newWorks.items) ? a.newWorks.items : [];
  for (const item of nw) {
    const plist = Array.isArray(item.platforms) ? item.platforms : [];
    if (plist.length === 0) {
      aoa.push([
        sanitizeTextCell(item.contentKey),
        sanitizeTextCell(item.title),
        null,
        sanitizeTextCell(item.publishDate || null),
        sanitizeNumberCell(item.d1Play),
        sanitizeNumberCell(item.d3Play),
        sanitizeNumberCell(item.d7Play),
        sanitizeNumberCell(item.d3ToD1),
        sanitizeNumberCell(item.d7ToD3),
        sanitizeTextCell(item.category),
        sanitizeTextCell(item.classificationBasis || null),
      ]);
      continue;
    }
    for (const p of plist) {
      aoa.push([
        sanitizeTextCell(item.contentKey),
        sanitizeTextCell(item.title),
        sanitizeTextCell(p.platform),
        sanitizeTextCell(p.publishDate || null),
        sanitizeNumberCell(p.d1Play),
        sanitizeNumberCell(p.d3Play),
        sanitizeNumberCell(p.d7Play),
        sanitizeNumberCell(p.d3ToD1),
        sanitizeNumberCell(p.d7ToD3),
        sanitizeTextCell(p.category),
        sanitizeTextCell(p.classificationBasis || null),
      ]);
    }
    if (plist.length > 1) {
      aoa.push([
        sanitizeTextCell(item.contentKey),
        sanitizeTextCell(item.title),
        sanitizeTextCell("全平台合计"),
        sanitizeTextCell(item.publishDate || null),
        sanitizeNumberCell(item.d1Play),
        sanitizeNumberCell(item.d3Play),
        sanitizeNumberCell(item.d7Play),
        sanitizeNumberCell(item.d3ToD1),
        sanitizeNumberCell(item.d7ToD3),
        sanitizeTextCell(item.category),
        sanitizeTextCell(item.classificationBasis || null),
      ]);
    }
  }
  aoa.push([]);

  // 第 5 节：发布时间分析
  aoa.push([sanitizeTextCell("五、发布时间分析（UTC+8 星期几 × 时段）")]);
  aoa.push(
    ["星期", "时段(UTC+8)", "样本数", "平均D7播放", "不足7天样本数", "备注"].map(
      sanitizeTextCell
    )
  );
  const pt =
    isPlainObject(a.publishTime) && Array.isArray(a.publishTime.groups)
      ? a.publishTime.groups
      : [];
  for (const g of pt) {
    aoa.push([
      sanitizeTextCell(g.weekdayLabel),
      sanitizeTextCell(g.slot),
      sanitizeNumberCell(g.sampleCount),
      sanitizeNumberCell(g.avgD7Play),
      sanitizeNumberCell(g.fallbackCount),
      sanitizeTextCell(g.note || null),
    ]);
  }
  aoa.push([]);

  // 第 6 节：异常提醒（疑似采集异常 + 疑似上推荐）
  aoa.push([sanitizeTextCell("六、异常提醒（疑似采集异常：掉0或缺失后回升，已在1–5节剔除）")]);
  aoa.push(
    [
      "日期",
      "平台",
      "作品ID",
      "标题",
      "指标",
      "异常值",
      "前有记录日",
      "前值",
      "后有记录日",
      "后值",
    ].map(sanitizeTextCell)
  );
  const an = isPlainObject(a.anomalies) ? a.anomalies : {};
  for (const col of Array.isArray(an.collectionAnomalies) ? an.collectionAnomalies : []) {
    aoa.push([
      sanitizeTextCell(col.date),
      sanitizeTextCell(col.platform),
      sanitizeTextCell(col.workId),
      sanitizeTextCell(col.title),
      sanitizeTextCell(col.metricLabel || col.metric),
      sanitizeNumberCell(col.value),
      sanitizeTextCell(col.prevDate),
      sanitizeNumberCell(col.prevValue),
      sanitizeTextCell(col.nextDate),
      sanitizeNumberCell(col.nextValue),
    ]);
  }
  aoa.push([]);

  aoa.push([
    sanitizeTextCell("六（续）、异常提醒（疑似上推荐：单日播放日增 ≥ 前7天日均×5 且 ≥ 1000）"),
  ]);
  aoa.push(
    ["日期", "平台", "作品ID", "标题", "单日播放日增", "前7天日均", "倍数"].map(
      sanitizeTextCell
    )
  );
  for (const rec of Array.isArray(an.recommendSpikes) ? an.recommendSpikes : []) {
    aoa.push([
      sanitizeTextCell(rec.date),
      sanitizeTextCell(rec.platform),
      sanitizeTextCell(rec.workId),
      sanitizeTextCell(rec.title),
      sanitizeNumberCell(rec.dailyPlayDelta),
      sanitizeNumberCell(rec.baselineAvg),
      sanitizeNumberCell(rec.ratio),
    ]);
  }

  return aoa;
}

/** Sheet 5: 字段说明（每个 sheet 每列一行，仅列出实际生成的列） */
function buildSchemaSheet(dynamicSchemaEntries) {
  const entries = [
    // 1. 作品日明细
    [
      "作品日明细",
      "日期",
      "date",
      "本地快照采集日期（YYYY-MM-DD，UTC+8），非平台自然日。平台数据本身存在 T+1 延迟（如抖音当天数据不可查，次日更新），采集值为采集时平台已开放的最新累计值。",
    ],
    [
      "作品日明细",
      "平台",
      "platform",
      "发布平台中文名（抖音/视频号/快手/哔哩哔哩/小红书/百家号/头条）。",
    ],
    [
      "作品日明细",
      "分组",
      "group",
      "账号分组名。本表保留分组明细不去重，同一账号挂多个分组时会出现重复行；另同组同平台挂多个账号时，本地统计按「分组/平台」合并存储，无法拆分到单账号。",
    ],
    [
      "作品日明细",
      "内容ID",
      "contentKey",
      "跨平台关联后的内容唯一键（file:<完整路径>、record:id:<id>、auto:<哈希> 或 manual:<id>）；未关联作品为空单元格。",
    ],
    [
      "作品日明细",
      "关联方式",
      "matchedBy",
      "跨平台关联依据：link（直链严格 1:1 匹配）、title（同组同平台唯一标题匹配）、fuzzy（标题模糊+时间窗自动匹配或无发布记录跨平台聚类；时间窗统一按 UTC+8 日历日相差 ≤2 天，缺时间时相似度门槛 +0.1）、manual（手工指定/合并/确认）；未关联为空。注意：模糊匹配可能合错，已手工确认的标 manual。",
    ],
    [
      "作品日明细",
      "匹配分数",
      "matchScore",
      "标题模糊匹配相似度分数（0~1 两位小数，数值类型）；仅关联方式为 fuzzy 时有值，其余方式及未关联为空单元格。模糊匹配可能合错，已手工确认的标 manual。",
    ],
    [
      "作品日明细",
      "作品ID",
      "workId",
      "平台侧作品唯一 ID（文本格式，避免长整数在表格软件中丢精度）。",
    ],
    [
      "作品日明细",
      "标题",
      "title",
      "作品标题；若 works.json 中已删除或未匹配则记为「(已删除或未匹配)」。",
    ],
    [
      "作品日明细",
      "作品链接",
      "url",
      "平台作品直链，无则为空单元格。",
    ],
    [
      "作品日明细",
      "发布日期",
      "publishDate",
      "作品发布日期（YYYY-MM-DD，UTC+8），无发布时间则为空单元格。",
    ],
    [
      "作品日明细",
      "播放",
      "play",
      "截至采集日的累计播放/阅读量（累计值，非日增；7 平台均有）。缺失为空单元格而非 0。已知问题：部分平台适配器可能把缺失指标写成 0，导致「掉 0 再回升」假波动。",
    ],
    [
      "作品日明细",
      "点赞",
      "like",
      "截至采集日的累计点赞/推荐数（累计值，非日增；7 平台均有）；缺失为空不是 0。",
    ],
    [
      "作品日明细",
      "评论",
      "comment",
      "截至采集日的累计评论数（累计值，非日增；7 平台均有）；缺失为空不是 0。",
    ],
    [
      "作品日明细",
      "分享",
      "share",
      "截至采集日的累计分享/转发数（累计值）。平台缺项为空不是 0（快手、头条无分享；抖音、视频号、哔哩哔哩、百家号、小红书有分享）。",
    ],
    [
      "作品日明细",
      "收藏",
      "favorite",
      "截至采集日的累计收藏数（累计值）。平台缺项为空不是 0（仅快手无收藏；抖音含 favorite_count、头条含 repinCount，与视频号/哔哩哔哩/百家号/小红书均有收藏）。",
    ],
    [
      "作品日明细",
      "涨粉",
      "fansDelta",
      "截至采集日该作品带来的累计涨粉数（累计值）。平台缺项为空不是 0（仅抖音、视频号有单作品涨粉；哔哩哔哩、百家号、头条、快手、小红书无单作品涨粉）。",
    ],
    [
      "作品日明细",
      "播放日增",
      "playDelta",
      "播放日增量（日增 vs 累计值）=当日累计播放 − 该作品上一次有记录日期的累计播放；首次记录或任一端缺失为空；断档天数 > 0 时日增跨多天；已知问题：作品日历史从启用本功能当天开始积累，无更早回溯。",
    ],
    [
      "作品日明细",
      "点赞日增",
      "likeDelta",
      "点赞日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；首次记录或缺失为空。",
    ],
    [
      "作品日明细",
      "评论日增",
      "commentDelta",
      "评论日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；首次记录或缺失为空。",
    ],
    [
      "作品日明细",
      "分享日增",
      "shareDelta",
      "分享日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；平台缺项（快手、头条无分享）为空不是 0。",
    ],
    [
      "作品日明细",
      "收藏日增",
      "favoriteDelta",
      "收藏日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；平台缺项（仅快手无收藏；抖音、头条等均有收藏）为空不是 0。",
    ],
    [
      "作品日明细",
      "涨粉日增",
      "fansDeltaDelta",
      "涨粉日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；仅抖音、视频号有单作品涨粉，哔哩哔哩/百家号/头条/快手/小红书无单作品涨粉，缺项为空不是 0。",
    ],
    [
      "作品日明细",
      "断档天数",
      "gapDays",
      "与该作品上一次有记录日期之间间隔的缺失天数（连续两天为 0；首次记录为空；断档天数 > 0 时同行的各项日增跨多天）。",
    ],

    // 2. 作品时段明细
    [
      "作品时段明细",
      "日期",
      "date",
      "分时段快照所属日期（YYYY-MM-DD，UTC+8）。自动采集按时段槽开始时刻所在日历日，手动采集按实际采集日历日。",
    ],
    [
      "作品时段明细",
      "时段",
      "slot",
      "分时段槽键（HH:mm，UTC+8）。自动采集为定时槽时刻，手动采集按实际采集时刻向下取整到整点（HH:00），同槽重复采集覆盖。",
    ],
    [
      "作品时段明细",
      "采集时间",
      "collectedAt",
      "实际落库采集时间戳（YYYY-MM-DD HH:mm:ss，UTC+8）；旧记录缺省时为空单元格。",
    ],
    [
      "作品时段明细",
      "平台",
      "platform",
      "发布平台中文名（抖音/视频号/快手/哔哩哔哩/小红书/百家号/头条）。",
    ],
    [
      "作品时段明细",
      "分组",
      "group",
      "账号分组名。本表保留分组明细不去重，同一账号挂多个分组时会出现重复行。",
    ],
    [
      "作品时段明细",
      "内容ID",
      "contentKey",
      "跨平台关联后的内容唯一键（file:<完整路径>、record:id:<id>、auto:<哈希> 或 manual:<id>）；未关联作品为空单元格。",
    ],
    [
      "作品时段明细",
      "关联方式",
      "matchedBy",
      "跨平台关联依据：link / title / fuzzy / manual；未关联为空单元格。",
    ],
    [
      "作品时段明细",
      "作品ID",
      "workId",
      "平台侧作品唯一 ID（文本格式，避免长整数丢精度）。",
    ],
    [
      "作品时段明细",
      "标题",
      "title",
      "作品标题；若 works.json 中已删除或未匹配则记为「(已删除或未匹配)」。",
    ],
    [
      "作品时段明细",
      "播放",
      "play",
      "该采集时点的累计播放/阅读量（累计值，非增量）；缺失为空单元格而非 0。",
    ],
    [
      "作品时段明细",
      "点赞",
      "like",
      "该采集时点的累计点赞/推荐数（累计值）；缺失为空单元格而非 0。",
    ],
    [
      "作品时段明细",
      "评论",
      "comment",
      "该采集时点的累计评论数（累计值）；缺失为空单元格而非 0。",
    ],
    [
      "作品时段明细",
      "分享",
      "share",
      "该采集时点的累计分享/转发数（累计值）；平台缺项（快手、头条无分享）为空单元格。",
    ],
    [
      "作品时段明细",
      "收藏",
      "favorite",
      "该采集时点的累计收藏数（累计值）；平台缺项（仅快手无收藏）为空单元格。",
    ],
    [
      "作品时段明细",
      "涨粉",
      "fansDelta",
      "该采集时点该作品带来的累计涨粉数（累计值）；仅抖音、视频号有单作品涨粉，其余平台为空单元格。",
    ],
    [
      "作品时段明细",
      "播放较上次增量",
      "playDelta",
      "当前时段累计播放 − 该作品上一次有效分时段快照的累计播放；首次记录或任一端缺失为空。",
    ],
    [
      "作品时段明细",
      "点赞较上次增量",
      "likeDelta",
      "当前时段累计点赞 − 该作品上一次有效分时段快照的累计点赞；首次记录或任一端缺失为空。",
    ],
    [
      "作品时段明细",
      "评论较上次增量",
      "commentDelta",
      "当前时段累计评论 − 该作品上一次有效分时段快照的累计评论；首次记录或任一端缺失为空。",
    ],
    [
      "作品时段明细",
      "距上次小时数",
      "hoursSincePrev",
      "本次采集时间与该作品上一次分时段快照采集时间的间隔小时数（保留 2 位小数）；首次记录或时间缺失/倒退为空。",
    ],

    // 3. 作品跨平台汇总
    [
      "作品跨平台汇总",
      "内容ID",
      "contentKey",
      "内容唯一键（file:<路径> / record:id:<id> / auto:<哈希> / manual:<id>）；未关联作品各自独立成行，键为 unlinked:<平台>:<作品ID>。",
    ],
    [
      "作品跨平台汇总",
      "标题",
      "title",
      "内容展示标题（已关联优先取最早发布记录标题，自动聚类/手工合并取簇内最早发布作品标题，未关联取作品标题）。",
    ],
    [
      "作品跨平台汇总",
      "素材文件",
      "file",
      "关联本地视频素材完整路径，无则为空单元格。",
    ],
    [
      "作品跨平台汇总",
      "首发日期",
      "firstPublishDate",
      "跨平台最早发布日期（YYYY-MM-DD，UTC+8，优先取已关联作品最早发布时间，其次取发布记录日期）。",
    ],
    [
      "作品跨平台汇总",
      "覆盖平台数",
      "platformCount",
      "截至结束日期（to）已采集到快照的去重平台数量。",
    ],
    [
      "作品跨平台汇总",
      "匹配方式",
      "matchMethod",
      "簇内跨平台关联方式汇总：有手工矫正或确认则标 manual，否则取簇内最弱的自动方式（fuzzy > title > link）；未关联或无已匹配作品为空。模糊匹配可能合错，已手工确认的标 manual。",
    ],
    [
      "作品跨平台汇总",
      "总播放",
      "totalPlay",
      "截至结束日期（to）各平台最新累计播放量之和（累计值；空值不计，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总点赞",
      "totalLike",
      "截至结束日期（to）各平台最新累计点赞数之和（累计值；空值不计，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总评论",
      "totalComment",
      "截至结束日期（to）各平台最新累计评论数之和（累计值；空值不计，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总分享",
      "totalShare",
      "截至结束日期（to）各平台最新累计分享数之和（累计值；快手、头条无分享为空不是 0，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总收藏",
      "totalFavorite",
      "截至结束日期（to）各平台最新累计收藏数之和（累计值；仅快手无收藏为空不是 0，抖音/头条等均有收藏，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总涨粉",
      "totalFansDelta",
      "截至结束日期（to）各平台最新累计涨粉数之和（累计值；仅抖音、视频号有单作品涨粉，哔哩哔哩/百家号/头条/快手/小红书无单作品涨粉，缺项为空不是 0）。",
    ],
  ];

  // 仅列出本次导出实际生成的动态列
  if (Array.isArray(dynamicSchemaEntries) && dynamicSchemaEntries.length > 0) {
    for (const d of dynamicSchemaEntries) {
      entries.push(["作品跨平台汇总", d.col, d.key, d.desc]);
    }
  }

  entries.push(
    [
      "作品跨平台汇总",
      "作品链接",
      "urls",
      "关联到的各平台作品直链，多条链接以换行分隔；无则为空单元格。",
    ],

    // 3. 平台日汇总
    [
      "平台日汇总",
      "日期",
      "date",
      "本地快照采集日期（YYYY-MM-DD，UTC+8），非平台自然日。平台数据本身存在 T+1 延迟（如抖音当天不可查）。",
    ],
    ["平台日汇总", "平台", "platform", "平台中文名。"],
    [
      "平台日汇总",
      "有数据作品数",
      "workCount",
      "当日该平台按「日期+平台+作品ID」去重后（同一作品跨多分组只取按分组名排序第一组的一份观测），至少有一项非空累计指标的作品数。",
    ],
    [
      "平台日汇总",
      "播放日增合计",
      "playDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重（多分组取分组名排序第一组）后对播放日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "点赞日增合计",
      "likeDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重（多分组取分组名排序第一组）后对点赞日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "评论日增合计",
      "commentDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重（多分组取分组名排序第一组）后对评论日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "分享日增合计",
      "shareDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重后对分享日增求和（空值不计，全空则为空；快手、头条无分享为空不是 0）。",
    ],
    [
      "平台日汇总",
      "收藏日增合计",
      "favoriteDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重后对收藏日增求和（空值不计，全空则为空；仅快手无收藏为空不是 0，抖音/头条等均有收藏）。",
    ],
    [
      "平台日汇总",
      "涨粉日增合计",
      "fansDeltaDeltaSum",
      "由「作品日明细」按「日期+平台+作品ID」去重后对涨粉日增求和（空值不计，全空则为空；仅抖音、视频号有单作品涨粉，哔哩哔哩/百家号/头条/快手/小红书无单作品涨粉）。",
    ],

    // 4. 账号日快照
    [
      "账号日快照",
      "日期",
      "date",
      "正常采集日为本地采集日期（YYYY-MM-DD，UTC+8；平台数据本身存在 T+1 延迟，如抖音当天不可查）。另：抖音（近 30 天 fansHistory）与视频号（fansHistory）会写入平台历史回填日，该类日期为平台历史自然日，仅回填粉丝数，其余指标为空。",
    ],
    ["账号日快照", "平台", "platform", "平台中文名。"],
    [
      "账号日快照",
      "分组",
      "group",
      "账号分组名。已知问题：同组同平台多账号合并统计。",
    ],
    [
      "账号日快照",
      "粉丝",
      "fans",
      "当日账号累计粉丝总数（累计值，来自 daily.json；7 平台均有；抖音/视频号历史回填日数据来自平台 fansHistory）。",
    ],
    [
      "账号日快照",
      "总播放",
      "plays",
      "当日账号累计总播放/阅读量（累计值；7 平台当日采集均有；抖音/视频号仅粉丝历史回填日为空；已知问题：部分适配器可能把缺失写成 0 导致假波动）。",
    ],
    [
      "账号日快照",
      "总点赞",
      "likes",
      "当日账号累计总点赞数（累计值；7 平台当日采集均有；历史粉丝回填日为空）。",
    ],
    [
      "账号日快照",
      "总评论",
      "comments",
      "当日账号累计总评论数（累计值；7 平台当日采集均有；历史粉丝回填日为空）。",
    ],
    [
      "账号日快照",
      "总收藏",
      "favorites",
      "当日账号累计总收藏数（累计值；仅快手无收藏为空不是 0，抖音/头条等均有收藏；历史粉丝回填日为空）。",
    ],
    [
      "账号日快照",
      "总分享",
      "shares",
      "当日账号累计总分享数（累计值；快手、头条无分享为空不是 0；历史粉丝回填日为空）。",
    ],
    [
      "账号日快照",
      "粉丝日增",
      "fansDelta",
      "当日粉丝数 − 该账号上一有粉丝记录日的粉丝数（日增口径，含平台历史粉丝回填日；断档跨天时为多天合计变化）。",
    ],
    [
      "账号日快照",
      "播放日增",
      "playsDelta",
      "当日总播放 − 该账号上一有播放记录日的总播放（日增口径，跳过仅粉丝历史回填日与播放异常日；断档跨天时为多天合计变化）。",
    ],
    [
      "账号日快照",
      "异常标注",
      "playsAnomalyNote",
      "当账号总播放较上次有效正值骤降（归 0 或降幅 ≥50%）且作品级无对应下降时标注异常说明，并将该日「总播放」「播放日增」置空，与「分析」sheet 口径保持一致（含旧 daily.json）。",
    ],

    // 5. 分析（纯规则分析，多节长表，与 GUI「数据分析」tab 共用计算函数）
    [
      "分析",
      "文字小结",
      "summary.lines",
      "基于第 1–6 节纯规则生成的 5–8 行中文要点（总量与环比、表现最好的平台、Top 作品、长尾作品数、推荐发布时段、异常条数）；按实际有作品快照天数判断，少于 14 天时附「数据积累少于 14 天，走势与发布时间结论仅供参考」。",
    ],
    [
      "分析",
      "总览与环比",
      "overview",
      "展示「统计区间 X ~ Y，其中作品日数据实际覆盖 A ~ B（共 K 天）」，K < 区间天数时明确提示。播放/点赞/评论/分享/收藏取作品日明细日增合计；总览涨粉优先采用《账号日快照》各平台区间首尾粉丝差合计（覆盖快手等无单作品涨粉的平台），并保留单作品涨粉日增合计作为辅助行，两行均在「数据来源」列标明口径。环比(%) = (本周期 − 上周期) / |上周期| × 100，上期为 0 或无数据时为空（不写 Infinity）。",
    ],
    [
      "分析",
      "平台对比与互动率公式",
      "platformComparison",
      "仅取覆盖 ≥2 个去重平台的同款内容，按平台统计平均播放、加权互动率(%)、三项互动率(%)、平均涨粉与样本数。平台级加权互动率 = Σ(点赞 + 评论 + 分享 + 收藏) / Σ播放（只统计 play > 0 的作品；平台缺失字段按 0 计：快手缺分享、收藏，头条缺分享，均在备注中注明）；同时保留不含收藏的「三项互动率(%) = Σ(点赞 + 评论 + 分享) / Σ播放」供跨平台对比；均播相差 <5% 视为并列并标注「播放接近」；样本数 <3 时标注「样本少，仅供参考」。",
    ],
    [
      "分析",
      "作品排行与平台偏科",
      "rankings",
      "按跨平台合并后的内容截至 to 的总播放 / 互动率（总播放 ≥100 才参与，公式为 (点赞 + 评论 + 分享 + 收藏) / 播放，按原始比率排序后输出舍入值）/ 总涨粉各取 Top10、Bottom10。平台偏科：同一内容某平台播放 ≥ 其它平台平均播放 × 3 且该平台播放 ≥ 500 时列出。",
    ],
    [
      "分析",
      "新作品走势（D1/D3/D7与分类阈值）",
      "newWorks",
      "周期内发布的内容（单作品发布时间优先级：平台实采 publishTime > 发布记录已确认发布时间 lastPublishAt > 记录创建时间 createTime，内容首发日取各作品最早已知首发，补发不算新作品）按作品各自发布日（UTC+8 日历日）起算发布后第 1/3/7 天（D1/D3/D7）累计播放再汇总到平台与内容（与发布时间共用里程碑）；无该天快照取 ≤ 该天最近一次有效快照，截止日上限为 UTC+8 今天，未到第 N 天为空。同行 D3/D1、D7/D3 按该行累计播放计算；分类阈值：长尾型（D7/D3 ≥ 1.5）、爆发后平稳（D3/D1 < 1.3 且 D7/D3 < 1.1）、数据不足、其它；走势分类仅使用在 D1/D3/D7 三个里程碑均有值的可比样本并在「分类依据」列注明，不存在可比样本时标「数据不足」。",
    ],
    [
      "分析",
      "发布时间",
      "publishTime",
      "按单作品发布时间优先级（平台实采 publishTime > 发布记录已确认发布时间 lastPublishAt > 记录创建时间 createTime）汇总出的内容最早已知首发时间（UTC+8）的星期几 × 时段（0-6 / 6-12 / 12-18 / 18-24）分组，与新作品走势共用按作品发布日期计算的 D7 里程碑再汇总（不足 7 天用截至 to 的最新累计并标注）；样本 <3 的组标「样本少」。",
    ],
    [
      "分析",
      "异常提醒与剔除说明",
      "anomalies",
      "异常规则：①疑似采集异常：某作品某指标某日为 0 或缺失，而前后有记录日都 >0（掉 0 又涨回），使用全历史快照（含截止日之后恢复快照）识别；以及账号级总播放相对上次有效正值骤降（归 0 或降幅 ≥50%）且作品级无对应下降时标为异常并剔除；剔除说明：此类异常点在第 1–5 节全部计算中剔除，并按截止日内有效快照重算日增、走势与排行。②疑似上推荐：仅对单日实测日增（断档后首日不触发）判定，单日播放日增 ≥ 前 7 个日历日窗口日均 × 5 且 ≥ 1000（窗内跨断档增量按天数均摊）。",
    ],

    // 6. 字段说明
    ["字段说明", "sheet", "sheet", "字段所属工作表名称。"],
    ["字段说明", "列名", "column", "对应工作表首行的中文列名（多节「分析」sheet 对应各节口径主题）。"],
    ["字段说明", "英文键", "key", "对应内部数据结构字段名，便于脚本或 AI 对齐。"],
    [
      "字段说明",
      "含义/口径",
      "description",
      "字段含义、累计值与日增口径、平台缺项规则及已知问题说明。",
    ],

    // 7. 导出信息
    ["导出信息", "项目", "item", "本次导出元信息条目名称。"],
    [
      "导出信息",
      "值",
      "value",
      "本次导出的元信息取值（导出时间、日期范围、应用版本、账号/作品/内容/未关联计数及分析周期 analysisPeriod；作品数与未关联作品数沿用作品跨平台汇总的去重与关联口径）。",
    ]
  );

  const aoa = [SCHEMA_HEADERS.map(sanitizeTextCell)];
  for (const row of entries) {
    aoa.push(row.map(sanitizeTextCell));
  }
  return aoa;
}

/** Sheet 7: 导出信息 */
function buildMetaSheet({ exportedAt, from, to, appVersion, counts, analysisPeriod }) {
  const aoa = [META_HEADERS.map(sanitizeTextCell)];
  aoa.push(
    [sanitizeTextCell("导出时间"), sanitizeTextCell(exportedAt)],
    [sanitizeTextCell("日期范围"), sanitizeTextCell(`${from} ~ ${to}`)],
    [sanitizeTextCell("应用版本"), sanitizeTextCell(appVersion)],
    [sanitizeTextCell("账号数"), sanitizeNumberCell(counts.accounts)],
    [sanitizeTextCell("作品数"), sanitizeNumberCell(counts.works)],
    [sanitizeTextCell("内容数"), sanitizeNumberCell(counts.contents)],
    [sanitizeTextCell("未关联作品数"), sanitizeNumberCell(counts.unlinkedWorks)],
    [sanitizeTextCell("analysisPeriod"), sanitizeNumberCell(analysisPeriod)]
  );
  return aoa;
}

function resolveAnalysisPeriodFromRange(from, to) {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return DEFAULT_ANALYSIS_PERIOD;
  }
  const rangeDays = Math.round((toMs - fromMs) / DAY_MS) + 1;
  return rangeDays < DEFAULT_ANALYSIS_PERIOD
    ? Math.max(1, rangeDays)
    : DEFAULT_ANALYSIS_PERIOD;
}

/**
 * 构建数据分析结果（供 GUI「数据分析」tab / IPC stats:get-analysis 复用）。
 * - 与 Excel 导出共用同一个默认截止日（resolveDefaultCutoffDate）、S6 关联逻辑与 buildStatsAnalysis
 * - 截止日上限为 UTC+8 今天（未来 to 自动夹到今天）
 * - 直接读取结构化行，不生成 Excel 二维表、不做全历史表格排序
 */
function buildStatsAnalysisData(options = {}, depsArg) {
  const opts = isPlainObject(options) ? options : {};
  const explicitTo = validateOptionalDate(opts.to, "to");
  const period =
    opts.period === undefined || opts.period === null || opts.period === ""
      ? DEFAULT_ANALYSIS_PERIOD
      : opts.period;
  if (typeof period !== "number" || !Number.isInteger(period) || period < 1 || period > 365) {
    throw new Error(`分析周期 period 需为 1–365 的正整数：${opts.period}`);
  }

  const dataset = loadRawDataset(opts, depsArg);
  const nowVal = dataset.io.now !== undefined ? dataset.io.now : Date.now();
  const todayUtc8 = formatUtc8Date(nowVal);
  let resolvedTo = explicitTo || dataset.latestDataDate || todayUtc8;
  if (resolvedTo > todayUtc8) resolvedTo = todayUtc8;
  const clampedDefaultCutoff =
    dataset.latestDataDate && dataset.latestDataDate > todayUtc8
      ? todayUtc8
      : dataset.latestDataDate || "";

  // 预归约截至 resolvedTo 的单日最新快照，避免 linkWorks / buildContentSummaryRows 重复遍历全历史
  const latestWorksDailyByGp = reduceAllWorksDailyByGpAsOf(
    dataset.allWorksDailyByGp,
    resolvedTo
  );

  const allContents = buildContentIndex(dataset.allPushRecords);
  const link = linkWorks({
    contents: allContents,
    accounts: dataset.allAccountsData,
    worksDaily: latestWorksDailyByGp,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
  });
  let summaryRows = buildContentSummaryRows({
    contents: allContents,
    accounts: dataset.allAccountsData,
    link,
    worksDaily: latestWorksDailyByGp,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
    groups: dataset.groupSet,
  });
  if (dataset.groupSet) {
    summaryRows = filterSummaryRowsByGroupScope(
      summaryRows,
      allContents,
      link,
      dataset.outputAccountsData,
      dataset.groupSet,
      resolvedTo
    );
  }

  // 仅收集分析用结构化全量行（含截止日后快照供掉 0 恢复识别；不生成 Excel 二维表）
  const { analysisRows } = collectWorkDailyStructured(dataset.outputAccountsData, link, {
    needSheetRows: false,
    needAnalysisRows: true,
  });
  const accountDaily = collectAccountDailyRows(dataset.outputAccountsData, "", resolvedTo, {
    sortRows: false,
  });
  const { summaryRows: analysisSummaryRows, workFallbackByPwKey } = resolveAnalysisPublishTimes(
    summaryRows,
    allContents,
    dataset.allAccountsData,
    link,
    resolvedTo,
    dataset.allPushRecords
  );
  applyWorkFallbackPublishTimes(analysisRows, workFallbackByPwKey);

  // 读取近 7 天分时段快照供「新作品前 24 小时」起量曲线分析
  const recent7From = shiftDateStr(resolvedTo, -(NEW_WORKS_FIRST_24H_DAYS - 1));
  const intradayEntries = loadAccountsWorksIntraday(dataset.outputAccountsData, dataset.io, {
    from: recent7From,
    to: resolvedTo,
  });
  const { analysisRows: intradayAnalysisRows } = collectWorkIntradayStructured(
    intradayEntries,
    link,
    {
      needSheetRows: false,
      needAnalysisRows: true,
      analysisFrom: recent7From,
      analysisTo: resolvedTo,
    }
  );
  applyWorkFallbackPublishTimes(intradayAnalysisRows, workFallbackByPwKey);

  const analysis = buildStatsAnalysis({
    dailyRows: analysisRows,
    summaryRows: analysisSummaryRows,
    accountRows: accountDaily.allRows,
    intradayRows: intradayAnalysisRows,
    to: resolvedTo,
    period,
    now: nowVal,
  });

  return {
    ...analysis,
    defaultCutoffDate: clampedDefaultCutoff,
  };
}

/**
 * 构建导出工作簿的全部纯数据二维数组（不写盘，便于单测）。
 *
 * @param {object} [options]
 * @param {string} [options.from]       起始日期 YYYY-MM-DD（含），默认 to 往前 29 天
 * @param {string} [options.to]         截止日期 YYYY-MM-DD（含），默认最新有数据日
 * @param {string[]} [options.groups]   可选，仅导出指定分组
 * @param {number} [options.maxRows]    可选，单 sheet 数据行上限（默认 200000）
 * @param {number|Date} [options.now]   可选，注入导出时间
 * @param {string} [options.appVersion] 可选，注入应用版本
 * @param {string} [options.pushDataDir] 可选，注入 pushData 目录
 * @param {object} [deps]               可选，注入 store/pushRecords 读函数
 */
function buildStatsWorkbookData(options = {}, deps) {
  const opts = isPlainObject(options) ? options : {};
  const { from: explicitFrom, to: explicitTo } = validateExportDateRange(
    opts.from,
    opts.to
  );
  const maxRows = resolveMaxRows(opts.maxRows);

  const earlyIo = resolveIoDeps(opts, deps);
  const earlyNowVal = earlyIo.now !== undefined ? earlyIo.now : Date.now();
  assertExportRangeNotAllFuture(explicitFrom, explicitTo, earlyNowVal);

  const dataset = loadRawDataset(opts, deps);
  const nowVal = dataset.io.now !== undefined ? dataset.io.now : earlyNowVal;
  const todayUtc8 = formatUtc8Date(nowVal);

  let rawFrom;
  let rawTo;
  if (explicitFrom && explicitTo) {
    rawFrom = explicitFrom;
    rawTo = explicitTo;
  } else if (explicitFrom && !explicitTo) {
    rawFrom = explicitFrom;
    rawTo = dataset.latestDataDate || todayUtc8;
    if (rawTo < rawFrom) rawTo = rawFrom;
  } else if (!explicitFrom && explicitTo) {
    rawTo = explicitTo;
    rawFrom = shiftDateStr(rawTo, -DEFAULT_RANGE_DAYS);
  } else {
    rawTo = dataset.latestDataDate || todayUtc8;
    if (rawTo > todayUtc8) rawTo = todayUtc8;
    rawFrom = shiftDateStr(rawTo, -DEFAULT_RANGE_DAYS);
  }

  // 导出区间先与「≤ UTC+8 今天」取交集；交集为空直接报错
  const resolvedFrom = rawFrom;
  const resolvedTo = rawTo > todayUtc8 ? todayUtc8 : rawTo;
  if (resolvedFrom > resolvedTo) {
    throw new Error(FUTURE_DATE_RANGE_ERROR);
  }

  // 构建前先计数「作品日明细」「作品时段明细」与「账号日快照」行数，超限直接拒绝，避免无谓排序与高内存占用
  const estWorkDailyRows = countWorkDailyRows(
    dataset.outputAccountsData,
    resolvedFrom,
    resolvedTo
  );
  if (estWorkDailyRows > maxRows) {
    throw createRowLimitError(estWorkDailyRows, maxRows, "作品日明细");
  }
  const outputIntradayEntries = loadAccountsWorksIntraday(dataset.outputAccountsData, dataset.io, {
    to: resolvedTo,
  });
  const estWorkIntradayRows = countWorkIntradayRows(
    outputIntradayEntries,
    resolvedFrom,
    resolvedTo
  );
  if (estWorkIntradayRows > maxRows) {
    throw createRowLimitError(estWorkIntradayRows, maxRows, "作品时段明细");
  }
  const estAccountDailyRows = countAccountDailyRows(
    dataset.outputAccountsData,
    resolvedFrom,
    resolvedTo
  );
  if (estAccountDailyRows > maxRows) {
    throw createRowLimitError(estAccountDailyRows, maxRows, "账号日快照");
  }

  // 预归约截至 resolvedTo 的单日最新快照，避免 linkWorks / buildContentSummaryRows 重复遍历全历史
  const latestWorksDailyByGp = reduceAllWorksDailyByGpAsOf(
    dataset.allWorksDailyByGp,
    resolvedTo
  );

  // 在全量分组上按作品身份做一次归属裁决，日明细与跨平台汇总共用该结果，之后再按导出分组裁剪
  const allContents = buildContentIndex(dataset.allPushRecords);
  const link = linkWorks({
    contents: allContents,
    accounts: dataset.allAccountsData,
    worksDaily: latestWorksDailyByGp,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
  });
  let summaryRows = buildContentSummaryRows({
    contents: allContents,
    accounts: dataset.allAccountsData,
    link,
    worksDaily: latestWorksDailyByGp,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
    groups: dataset.groupSet,
  });
  if (dataset.groupSet) {
    summaryRows = filterSummaryRowsByGroupScope(
      summaryRows,
      allContents,
      link,
      dataset.outputAccountsData,
      dataset.groupSet,
      resolvedTo
    );
  }
  if (summaryRows.length > maxRows) {
    throw createRowLimitError(summaryRows.length, maxRows, "作品跨平台汇总");
  }

  const { sheetRows: workDailyRows, analysisRows } = collectWorkDailyStructured(
    dataset.outputAccountsData,
    link,
    {
      from: resolvedFrom,
      to: resolvedTo,
      needSheetRows: true,
      needAnalysisRows: true,
    }
  );
  const workDailyAoa = formatWorkDailyAoa(workDailyRows);
  const recent7From = shiftDateStr(resolvedTo, -(NEW_WORKS_FIRST_24H_DAYS - 1));
  const { sheetRows: workIntradayRows, analysisRows: intradayAnalysisRows } =
    collectWorkIntradayStructured(outputIntradayEntries, link, {
      from: resolvedFrom,
      to: resolvedTo,
      needSheetRows: true,
      needAnalysisRows: true,
      analysisFrom: recent7From,
      analysisTo: resolvedTo,
    });
  const workIntradayAoa = formatWorkIntradayAoa(workIntradayRows);
  const contentSummary = buildContentSummarySheet(summaryRows);
  const platformDaily = buildPlatformDailySheet(workDailyRows);
  const accountDaily = collectAccountDailyRows(
    dataset.outputAccountsData,
    resolvedFrom,
    resolvedTo,
    { sortRows: true }
  );
  const analysisPeriod = resolveAnalysisPeriodFromRange(resolvedFrom, resolvedTo);
  const { summaryRows: analysisSummaryRows, workFallbackByPwKey } = resolveAnalysisPublishTimes(
    summaryRows,
    allContents,
    dataset.allAccountsData,
    link,
    resolvedTo,
    dataset.allPushRecords
  );
  applyWorkFallbackPublishTimes(analysisRows, workFallbackByPwKey);
  applyWorkFallbackPublishTimes(intradayAnalysisRows, workFallbackByPwKey);
  const analysis = buildStatsAnalysis({
    dailyRows: analysisRows,
    summaryRows: analysisSummaryRows,
    accountRows: accountDaily.allRows,
    intradayRows: intradayAnalysisRows,
    to: resolvedTo,
    period: analysisPeriod,
    now: nowVal,
  });
  const reconciledAccountDailyRows = reconcileAccountDailyRowsWithAnalysis(
    accountDaily.rows,
    analysis
  );
  const accountDailyAoa = formatAccountDailyAoa(reconciledAccountDailyRows);
  const analysisAoa = buildAnalysisSheet(analysis);
  const schemaAoa = buildSchemaSheet(contentSummary.dynamicSchemaEntries);

  const workCounts = computeWorkCountsFromSummaryRows(summaryRows);
  const counts = {
    accounts: dataset.outputAccountsData.length,
    works: workCounts.works,
    contents: summaryRows.length,
    unlinkedWorks: workCounts.unlinkedWorks,
    workDailyRows: workDailyRows.length,
    workIntradayRows: workIntradayRows.length,
    platformDailyRows: platformDaily.rows.length,
    accountDailyRows: accountDaily.rows.length,
  };

  const exportedAt = formatUtc8DateTime(nowVal);
  const appVersion = resolveAppVersion(dataset.io.appVersion);
  const metaAoa = buildMetaSheet({
    exportedAt,
    from: resolvedFrom,
    to: resolvedTo,
    appVersion,
    counts,
    analysisPeriod,
  });

  const sheets = {
    作品日明细: workDailyAoa,
    作品时段明细: workIntradayAoa,
    作品跨平台汇总: contentSummary.aoa,
    平台日汇总: platformDaily.aoa,
    账号日快照: accountDailyAoa,
    分析: analysisAoa,
    字段说明: schemaAoa,
    导出信息: metaAoa,
  };

  for (const name of SHEET_NAMES) {
    const aoa = sheets[name];
    const dataRows = Array.isArray(aoa) && aoa.length > 0 ? aoa.length - 1 : 0;
    if (dataRows > maxRows) {
      throw createRowLimitError(dataRows, maxRows, name);
    }
  }

  return {
    from: resolvedFrom,
    to: resolvedTo,
    analysisPeriod,
    exportedAt,
    appVersion,
    sheetOrder: [...SHEET_NAMES],
    sheets,
    counts,
    analysis,
  };
}

/** 估算字符串显示宽度（CJK 宽字符按 2 计，多行取最长行） */
function estimateDisplayWidth(value) {
  if (value == null) return 0;
  const text = String(value);
  let maxLine = 0;
  for (const line of text.split("\n")) {
    let w = 0;
    for (let i = 0; i < line.length; i++) {
      w += line.charCodeAt(i) > 0xff ? 2 : 1;
    }
    if (w > maxLine) maxLine = w;
  }
  return maxLine;
}

function computeColWidths(aoa, maxWidth = 48) {
  if (!Array.isArray(aoa) || !aoa.length) return [];
  const sampleLimit = Math.min(aoa.length, 500);
  let colCount = 0;
  for (let r = 0; r < sampleLimit; r++) {
    const row = aoa[r];
    if (Array.isArray(row) && row.length > colCount) {
      colCount = row.length;
    }
  }
  if (colCount === 0) return [];
  const widths = new Array(colCount).fill(10);
  for (let r = 0; r < sampleLimit; r++) {
    const row = aoa[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const w = estimateDisplayWidth(row[c]) + 2;
      if (w > widths[c]) widths[c] = w;
    }
  }
  return widths.map((w) => ({ wch: Math.max(10, Math.min(maxWidth, w)) }));
}

/**
 * 将 buildStatsWorkbookData 产出写入 .xlsx 文件。
 * 不合并单元格、无公式、保留数值为数字类型、空值为空单元格。
 * 原样使用 filePath（不做 trim），并在写盘前校验任一 sheet 行数不超上限。
 */
function writeStatsXlsx(data, filePath, options = {}) {
  if (!data || !isPlainObject(data.sheets)) {
    throw new Error("无效的工作簿数据");
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("导出路径不能为空");
  }
  const maxRows = resolveMaxRows(options && options.maxRows);
  const order =
    Array.isArray(data.sheetOrder) && data.sheetOrder.length
      ? data.sheetOrder
      : SHEET_NAMES;

  for (const name of order) {
    const aoa = Array.isArray(data.sheets[name]) ? data.sheets[name] : [];
    const dataRows = aoa.length > 0 ? aoa.length - 1 : 0;
    if (dataRows > maxRows) {
      throw createRowLimitError(dataRows, maxRows, name);
    }
  }

  const resolvedPath = path.resolve(filePath);
  const wb = xlsx.utils.book_new();

  for (const name of order) {
    const aoa = Array.isArray(data.sheets[name]) ? data.sheets[name] : [];
    const ws = xlsx.utils.aoa_to_sheet(aoa);
    const maxW = name === "字段说明" || name === "分析" ? 64 : 44;
    ws["!cols"] = computeColWidths(aoa, maxW);
    xlsx.utils.book_append_sheet(wb, ws, name);
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  fs.writeFileSync(resolvedPath, buf);
  return resolvedPath;
}

/**
 * 构建单条内容的各平台播放走势数据（供「作品汇总」tab 趋势弹窗 / IPC stats:get-content-trend 复用）。
 * - 复用与 buildContentSummaryData 同一套跨平台关联（自动 + link-overrides）与默认截止日
 * - 日播放累计与播放日增取自作品日明细（按 platform|workId 跨组去重，连续日期补空 null）
 */
function buildContentTrendData(options = {}, depsArg) {
  const opts = isPlainObject(options) ? options : {};
  const contentKey = typeof opts.contentKey === "string" ? opts.contentKey.trim() : "";
  if (!contentKey) {
    throw new Error("contentKey 不能为空");
  }
  const { from: validFrom, to: validTo } = validateExportDateRange(opts.from, opts.to);

  const dataset = loadRawDataset(opts, depsArg);
  const cutoffDate = validTo || dataset.latestDataDate || "";

  const latestWorksDailyByGp = reduceAllWorksDailyByGpAsOf(
    dataset.allWorksDailyByGp,
    cutoffDate
  );
  const allContents = buildContentIndex(dataset.allPushRecords);
  const link = linkWorks({
    contents: allContents,
    accounts: dataset.allAccountsData,
    worksDaily: latestWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
  });
  let summaryRows = buildContentSummaryRows({
    contents: allContents,
    accounts: dataset.allAccountsData,
    link,
    worksDaily: latestWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
    groups: dataset.groupSet,
  });
  if (dataset.groupSet) {
    summaryRows = filterSummaryRowsByGroupScope(
      summaryRows,
      allContents,
      link,
      dataset.outputAccountsData,
      dataset.groupSet,
      cutoffDate
    );
  }

  const targetRow = summaryRows.find((r) => r && r.contentKey === contentKey) || null;
  if (!targetRow) {
    return {
      found: false,
      contentKey,
      title: "",
      firstPublishDate: "",
      date: cutoffDate,
      from: validFrom || "",
      to: cutoffDate,
      dates: [],
      platforms: [],
      totalPlay: [],
      totalPlayDelta: [],
    };
  }

  const targetPwKeys = new Set();
  if (isPlainObject(targetRow.perPlatform)) {
    for (const [pgKey, cell] of Object.entries(targetRow.perPlatform)) {
      if (!isPlainObject(cell)) continue;
      const { platform } = parsePgKey(pgKey);
      if (Array.isArray(cell.workIds)) {
        for (const wid of cell.workIds) {
          if (wid != null && wid !== "") {
            targetPwKeys.add(`${platform}|${String(wid).trim()}`);
          }
        }
      }
      if (Array.isArray(cell.works)) {
        for (const w of cell.works) {
          if (isPlainObject(w) && w.workId != null && w.workId !== "") {
            const p =
              typeof w.platform === "string" && w.platform.trim()
                ? w.platform.trim()
                : platform;
            targetPwKeys.add(`${p}|${String(w.workId).trim()}`);
          }
        }
      }
    }
  }

  const cutoffDayNum = cutoffDate ? dateStrToDayNum(cutoffDate) : null;
  const fromDayNum = validFrom ? dateStrToDayNum(validFrom) : null;
  const rawByWork = new Map();

  for (const acc of dataset.outputAccountsData) {
    if (!isPlainObject(acc) || !isPlainObject(acc.worksDaily)) continue;
    const platform = acc.platform == null ? "" : String(acc.platform);
    const workIds = Object.keys(acc.worksDaily);
    for (let wi = 0; wi < workIds.length; wi++) {
      const workId = workIds[wi];
      const pwKey = `${platform}|${workId}`;
      if (!targetPwKeys.has(pwKey)) continue;
      const dateMap = safeOwnGet(acc.worksDaily, workId);
      if (!isPlainObject(dateMap)) continue;

      let bucket = rawByWork.get(pwKey);
      if (!bucket) {
        bucket = { platform, workId, byDayNum: new Map() };
        rawByWork.set(pwKey, bucket);
      }
      const rawDates = Object.keys(dateMap);
      for (let di = 0; di < rawDates.length; di++) {
        const d = rawDates[di];
        const dn = dateStrToDayNum(d);
        if (dn === null) continue;
        if (cutoffDayNum !== null && dn > cutoffDayNum) continue;
        if (bucket.byDayNum.has(dn)) continue;
        const snap = safeOwnGet(dateMap, d);
        if (!isPlainObject(snap)) continue;
        const play = hasOwn(snap, "play") ? fastNormalizeMetric(snap.play) : null;
        bucket.byDayNum.set(dn, { date: d, dayNum: dn, play });
      }
    }
  }

  const platformWorksMap = new Map();
  const platformActiveDays = new Map();
  const platformDeltaMap = new Map();
  let minDayNum = Infinity;
  let maxDayNum = -Infinity;

  for (const bucket of rawByWork.values()) {
    const pts = [...bucket.byDayNum.values()].sort((a, b) => a.dayNum - b.dayNum);
    let worksList = platformWorksMap.get(bucket.platform);
    if (!worksList) {
      worksList = [];
      platformWorksMap.set(bucket.platform, worksList);
    }
    worksList.push(pts);

    let prevPlay = null;
    let hasPrev = false;

    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      const play = pt.play;
      const playDelta = hasPrev && play !== null && prevPlay !== null ? play - prevPlay : null;
      hasPrev = true;
      prevPlay = play;

      if (fromDayNum !== null && pt.dayNum < fromDayNum) continue;
      if (cutoffDayNum !== null && pt.dayNum > cutoffDayNum) continue;

      if (pt.dayNum < minDayNum) minDayNum = pt.dayNum;
      if (pt.dayNum > maxDayNum) maxDayNum = pt.dayNum;

      let activeDays = platformActiveDays.get(bucket.platform);
      if (!activeDays) {
        activeDays = new Set();
        platformActiveDays.set(bucket.platform, activeDays);
      }
      activeDays.add(pt.dayNum);

      if (playDelta !== null) {
        let deltaMap = platformDeltaMap.get(bucket.platform);
        if (!deltaMap) {
          deltaMap = new Map();
          platformDeltaMap.set(bucket.platform, deltaMap);
        }
        const prevSum = deltaMap.has(pt.dayNum) ? deltaMap.get(pt.dayNum) : null;
        const nextDelta = prevSum === null ? playDelta : prevSum + playDelta;
        deltaMap.set(pt.dayNum, nextDelta === 0 ? 0 : nextDelta);
      }
    }
  }

  if (minDayNum > maxDayNum) {
    return {
      found: true,
      contentKey,
      title: targetRow.title || "(无标题)",
      firstPublishDate: targetRow.firstPublishDate || "",
      date: cutoffDate,
      from: validFrom || "",
      to: cutoffDate,
      dates: [],
      platforms: [],
      totalPlay: [],
      totalPlayDelta: [],
    };
  }

  const rangeStartDay = fromDayNum !== null ? fromDayNum : minDayNum;
  const rangeEndDay = validTo && cutoffDayNum !== null ? cutoffDayNum : maxDayNum;
  const spanDays = rangeEndDay - rangeStartDay + 1;
  const dates = new Array(spanDays);
  for (let i = 0; i < spanDays; i++) {
    dates[i] = dayNumToDateStr(rangeStartDay + i);
  }

  const sortedPlatforms = [...platformActiveDays.keys()].sort(comparePlatform);
  const totalPlay = new Array(spanDays).fill(null);
  const totalPlayDelta = new Array(spanDays).fill(null);

  const platforms = sortedPlatforms.map((platform) => {
    const worksList = platformWorksMap.get(platform) || [];
    const activeDays = platformActiveDays.get(platform);
    const deltaMap = platformDeltaMap.get(platform) || null;
    const workCount = worksList.length;
    const ptrs = new Int32Array(workCount);
    const curPlays = new Array(workCount).fill(null);
    const playArr = new Array(spanDays).fill(null);
    const deltaArr = new Array(spanDays).fill(null);

    for (let i = 0; i < spanDays; i++) {
      const dn = rangeStartDay + i;
      for (let w = 0; w < workCount; w++) {
        const pts = worksList[w];
        let p = ptrs[w];
        while (p < pts.length && pts[p].dayNum <= dn) {
          curPlays[w] = pts[p].play;
          p += 1;
        }
        ptrs[w] = p;
      }

      // 整平台当天无任何作品快照时保持留空（null），不伪造当日点
      if (!activeDays || !activeDays.has(dn)) continue;

      let sumPlay = null;
      for (let w = 0; w < workCount; w++) {
        if (curPlays[w] !== null) {
          sumPlay = sumPlay === null ? curPlays[w] : sumPlay + curPlays[w];
        }
      }
      if (sumPlay === 0) sumPlay = 0;
      const dayDelta = deltaMap && deltaMap.has(dn) ? deltaMap.get(dn) : null;

      playArr[i] = sumPlay;
      deltaArr[i] = dayDelta;
      if (sumPlay !== null) {
        const np = totalPlay[i] === null ? sumPlay : totalPlay[i] + sumPlay;
        totalPlay[i] = np === 0 ? 0 : np;
      }
      if (dayDelta !== null) {
        const nd =
          totalPlayDelta[i] === null ? dayDelta : totalPlayDelta[i] + dayDelta;
        totalPlayDelta[i] = nd === 0 ? 0 : nd;
      }
    }
    return {
      platform,
      play: playArr,
      playDelta: deltaArr,
    };
  });

  return {
    found: true,
    contentKey,
    title: targetRow.title || "(无标题)",
    firstPublishDate: targetRow.firstPublishDate || "",
    date: cutoffDate,
    from: dates[0],
    to: dates[dates.length - 1],
    dates,
    platforms,
    totalPlay,
    totalPlayDelta,
  };
}

/**
 * 构建单条内容的各平台分时段播放走势数据（供「作品汇总」趋势弹窗「按时段」/ IPC stats:get-content-intraday 复用）。
 * - 复用与 buildContentSummaryData 同一套跨平台关联（自动 + link-overrides）
 * - 默认最近 3 天（支持 1/3/7 等正整数天数），跨分组按 platform|workId 去重
 */
function buildContentIntradayData(options = {}, depsArg) {
  const opts = isPlainObject(options) ? options : {};
  const contentKey = typeof opts.contentKey === "string" ? opts.contentKey.trim() : "";
  if (!contentKey) {
    throw new Error("contentKey 不能为空");
  }
  const rawDays = opts.days;
  let days = DEFAULT_INTRADAY_DAYS;
  if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
    const parsedDays = typeof rawDays === "number" ? rawDays : Number(rawDays);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > MAX_INTRADAY_DAYS) {
      throw new Error(`days 需为 1–${MAX_INTRADAY_DAYS} 的正整数：${rawDays}`);
    }
    days = parsedDays;
  }
  const explicitTo = validateOptionalDate(opts.to, "to");

  const dataset = loadSummaryDataset(opts, depsArg, explicitTo);
  const cutoffDate = explicitTo || dataset.latestDataDate || "";

  const allContents = buildContentIndex(dataset.allPushRecords);
  const link = linkWorks({
    contents: allContents,
    accounts: dataset.allAccountsData,
    worksDaily: dataset.allWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
  });
  let summaryRows = buildContentSummaryRows({
    contents: allContents,
    accounts: dataset.allAccountsData,
    link,
    worksDaily: dataset.allWorksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
    groups: dataset.groupSet,
  });
  if (dataset.groupSet) {
    summaryRows = filterSummaryRowsByGroupScope(
      summaryRows,
      allContents,
      link,
      dataset.outputAccountsData,
      dataset.groupSet,
      cutoffDate
    );
  }

  const targetRow = summaryRows.find((r) => r && r.contentKey === contentKey) || null;
  if (!targetRow) {
    return {
      found: false,
      contentKey,
      title: "",
      firstPublishDate: "",
      date: cutoffDate,
      days,
      from: "",
      to: cutoffDate,
      timePoints: [],
      collectedAts: [],
      platforms: [],
      totalPlay: [],
      totalPlayDelta: [],
    };
  }

  const targetPwKeys = new Set();
  const targetPlatforms = new Set();
  if (isPlainObject(targetRow.perPlatform)) {
    for (const [pgKey, cell] of Object.entries(targetRow.perPlatform)) {
      if (!isPlainObject(cell)) continue;
      const { platform } = parsePgKey(pgKey);
      if (Array.isArray(cell.workIds)) {
        for (const wid of cell.workIds) {
          if (wid != null && wid !== "") {
            targetPwKeys.add(`${platform}|${String(wid).trim()}`);
            if (platform) targetPlatforms.add(platform);
          }
        }
      }
      if (Array.isArray(cell.works)) {
        for (const w of cell.works) {
          if (isPlainObject(w) && w.workId != null && w.workId !== "") {
            const p =
              typeof w.platform === "string" && w.platform.trim()
                ? w.platform.trim()
                : platform;
            targetPwKeys.add(`${p}|${String(w.workId).trim()}`);
            if (p) targetPlatforms.add(p);
          }
        }
      }
    }
  }

  const rawByWork = new Map();
  let latestIntradayDate = "";
  const io = dataset.io;
  const readRange = cutoffDate ? { to: cutoffDate } : {};

  for (const acc of dataset.outputAccountsData) {
    if (!isPlainObject(acc)) continue;
    const platform = acc.platform == null ? "" : String(acc.platform);
    if (!targetPlatforms.has(platform)) continue;
    const intradayMap =
      io && typeof io.readWorksIntraday === "function"
        ? io.readWorksIntraday(acc.group, acc.platform, readRange)
        : null;
    if (!isPlainObject(intradayMap)) continue;

    for (const workId of Object.keys(intradayMap)) {
      const pwKey = `${platform}|${workId}`;
      if (!targetPwKeys.has(pwKey)) continue;
      const list = safeOwnGet(intradayMap, workId);
      if (!Array.isArray(list) || !list.length) continue;

      let bucket = rawByWork.get(pwKey);
      if (!bucket) {
        bucket = { platform, workId, byTimeKey: new Map() };
        rawByWork.set(pwKey, bucket);
      }
      for (let i = 0; i < list.length; i++) {
        const pt = list[i];
        if (!isPlainObject(pt)) continue;
        const d = typeof pt.date === "string" ? pt.date.trim() : "";
        const s = typeof pt.slot === "string" ? pt.slot.trim() : "";
        if (!isValidDateStr(d) || !SLOT_TIME_RE.test(s)) continue;
        if (cutoffDate && d > cutoffDate) continue;
        const timeKey = `${d} ${s}`;
        // 跨分组保留排序第一组的观测
        if (bucket.byTimeKey.has(timeKey)) continue;
        const play = hasOwn(pt, "play") ? fastNormalizeMetric(pt.play) : null;
        const collectedAt = parseRawTimestampMs(pt.collectedAt);
        if (explicitTo && collectedAt !== null && formatUtc8Date(collectedAt) > explicitTo) {
          continue;
        }
        const sortTsMs = resolveIntradaySortTsMs(d, s, collectedAt);
        bucket.byTimeKey.set(timeKey, { date: d, slot: s, timeKey, collectedAt, sortTsMs, play });
        if (!latestIntradayDate || d > latestIntradayDate) {
          latestIntradayDate = d;
        }
      }
    }
  }

  const endDate = explicitTo || latestIntradayDate || cutoffDate;
  const fromDate = endDate ? shiftDateStr(endDate, -(days - 1)) : "";

  const comparePointEvent = (a, b) => {
    if (a.sortTsMs !== null && b.sortTsMs !== null && a.sortTsMs !== b.sortTsMs) {
      return a.sortTsMs - b.sortTsMs;
    }
    if (a.sortTsMs !== null && b.sortTsMs === null) return -1;
    if (a.sortTsMs === null && b.sortTsMs !== null) return 1;
    return compareText(a.timeKey, b.timeKey);
  };

  const platformWorksMap = new Map();
  for (const bucket of rawByWork.values()) {
    const pts = [...bucket.byTimeKey.values()].sort(comparePointEvent);
    let worksList = platformWorksMap.get(bucket.platform);
    if (!worksList) {
      worksList = [];
      platformWorksMap.set(bucket.platform, worksList);
    }
    worksList.push(pts);
  }

  // 按平台独立构建按实际 collectedAt（缺省回退槽时刻）升序的点列，增量严格按各自平台上一点计算
  const sortedPlatformNames = [...platformWorksMap.keys()].sort(comparePlatform);
  const platformSeriesList = [];
  for (const platform of sortedPlatformNames) {
    const worksList = platformWorksMap.get(platform) || [];
    const eventMap = new Map();
    for (let w = 0; w < worksList.length; w++) {
      const pts = worksList[w];
      for (let i = 0; i < pts.length; i++) {
        const pt = pts[i];
        const evKey = `${pt.sortTsMs !== null ? pt.sortTsMs : ""}|${pt.timeKey}`;
        const existing = eventMap.get(evKey);
        if (!existing) {
          eventMap.set(evKey, {
            sortTsMs: pt.sortTsMs,
            collectedAt: pt.collectedAt,
            date: pt.date,
            slot: pt.slot,
            timeKey: pt.timeKey,
          });
        } else if (
          pt.collectedAt !== null &&
          (existing.collectedAt === null || pt.collectedAt > existing.collectedAt)
        ) {
          existing.collectedAt = pt.collectedAt;
        }
      }
    }
    const events = [...eventMap.values()].sort(comparePointEvent);
    const workCount = worksList.length;
    const ptrs = new Int32Array(workCount);
    const curPlays = new Array(workCount).fill(null);
    let hasPrev = false;
    let prevPlay = null;
    const windowPoints = [];

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      for (let w = 0; w < workCount; w++) {
        const pts = worksList[w];
        let p = ptrs[w];
        while (p < pts.length && comparePointEvent(pts[p], ev) <= 0) {
          const nextPlay = pts[p].play;
          // 缺失播放（null）或已有正播放后出现假 0：沿用该作品上一次有效值，不产生负增量
          if (
            nextPlay !== null &&
            !(nextPlay === 0 && curPlays[w] !== null && curPlays[w] > 0)
          ) {
            curPlays[w] = nextPlay;
          }
          p += 1;
        }
        ptrs[w] = p;
      }

      let sumPlay = null;
      for (let w = 0; w < workCount; w++) {
        if (curPlays[w] !== null) {
          sumPlay = sumPlay === null ? curPlays[w] : sumPlay + curPlays[w];
        }
      }
      if (sumPlay === 0) sumPlay = 0;

      const rawDelta =
        hasPrev && sumPlay !== null && prevPlay !== null ? sumPlay - prevPlay : null;
      const playDelta = rawDelta === 0 ? 0 : rawDelta;
      hasPrev = true;
      prevPlay = sumPlay;

      if (fromDate && ev.date < fromDate) continue;
      if (endDate && ev.date > endDate) continue;

      const xMs = ev.collectedAt !== null ? ev.collectedAt : ev.sortTsMs;
      if (xMs === null) continue;
      windowPoints.push({
        collectedAt: xMs,
        date: ev.date,
        slot: ev.slot,
        timeKey: ev.timeKey,
        play: sumPlay,
        playDelta,
      });
    }

    if (windowPoints.length > 0) {
      platformSeriesList.push({ platform, points: windowPoints });
    }
  }

  if (!platformSeriesList.length) {
    return {
      found: true,
      contentKey,
      title: targetRow.title || "(无标题)",
      firstPublishDate: targetRow.firstPublishDate || "",
      date: cutoffDate || endDate,
      days,
      from: fromDate,
      to: endDate,
      timePoints: [],
      collectedAts: [],
      platforms: [],
      totalPlay: [],
      totalPlayDelta: [],
    };
  }

  // 全局时间线按实际 collectedAt 升序，不同平台的独立采集时刻不因槽键相同而折叠或倒序
  const globalBucketMap = new Map();
  for (const ps of platformSeriesList) {
    const usedKeyInPlatform = new Set();
    for (const pt of ps.points) {
      let key = String(pt.collectedAt);
      if (usedKeyInPlatform.has(key)) {
        key = `${pt.collectedAt}|${pt.timeKey}`;
      }
      usedKeyInPlatform.add(key);
      pt._globalKey = key;
      if (!globalBucketMap.has(key)) {
        globalBucketMap.set(key, {
          key,
          collectedAt: pt.collectedAt,
          timeKey: pt.timeKey,
        });
      }
    }
  }

  const timeline = [...globalBucketMap.values()].sort((a, b) => {
    if (a.collectedAt !== b.collectedAt) return a.collectedAt - b.collectedAt;
    return compareText(a.timeKey, b.timeKey);
  });
  const keyToIdx = new Map(timeline.map((e, idx) => [e.key, idx]));
  const collectedAts = timeline.map((e) => e.collectedAt);
  const timePoints = timeline.map((e) => e.timeKey);
  const totalPlay = new Array(timeline.length).fill(null);
  const totalPlayDelta = new Array(timeline.length).fill(null);

  const platforms = platformSeriesList.map((ps) => {
    const playArr = new Array(timeline.length).fill(null);
    const deltaArr = new Array(timeline.length).fill(null);
    const cleanPoints = ps.points.map((pt) => {
      const idx = keyToIdx.get(pt._globalKey);
      if (idx !== undefined) {
        playArr[idx] = pt.play;
        deltaArr[idx] = pt.playDelta;
        if (pt.play !== null) {
          const np = totalPlay[idx] === null ? pt.play : totalPlay[idx] + pt.play;
          totalPlay[idx] = np === 0 ? 0 : np;
        }
        if (pt.playDelta !== null) {
          const nd =
            totalPlayDelta[idx] === null ? pt.playDelta : totalPlayDelta[idx] + pt.playDelta;
          totalPlayDelta[idx] = nd === 0 ? 0 : nd;
        }
      }
      return {
        collectedAt: pt.collectedAt,
        date: pt.date,
        slot: pt.slot,
        timeKey: pt.timeKey,
        play: pt.play,
        playDelta: pt.playDelta,
      };
    });

    return {
      platform: ps.platform,
      points: cleanPoints,
      play: playArr,
      playDelta: deltaArr,
    };
  });

  return {
    found: true,
    contentKey,
    title: targetRow.title || "(无标题)",
    firstPublishDate: targetRow.firstPublishDate || "",
    date: cutoffDate || endDate,
    days,
    from: fromDate,
    to: endDate,
    timePoints,
    collectedAts,
    platforms,
    totalPlay,
    totalPlayDelta,
  };
}

module.exports = {
  SHEET_NAMES,
  MAX_SHEET_ROWS,
  ROW_LIMIT_EXCEEDED_CODE,
  FUTURE_DATE_RANGE_ERROR,
  WORK_DAILY_HEADERS,
  WORK_INTRADAY_HEADERS,
  SUMMARY_BASE_HEADERS,
  PLATFORM_DAILY_HEADERS,
  ACCOUNT_DAILY_HEADERS,
  SCHEMA_HEADERS,
  META_HEADERS,
  isValidDateStr,
  sanitizeTextCell,
  sanitizeNumberCell,
  validateExportDateRange,
  assertExportRangeNotAllFuture,
  buildDefaultExportFileName,
  resolveDefaultCutoffDate,
  resolveLinkValidationContext,
  countWorkDailyRows,
  countWorkIntradayRows,
  computeWorkCountsFromSummaryRows,
  buildContentSummaryData,
  buildContentTrendData,
  buildContentIntradayData,
  buildAnalysisSheet,
  buildStatsAnalysisData,
  buildStatsWorkbookData,
  writeStatsXlsx,
};
