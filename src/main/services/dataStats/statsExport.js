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
const { WORK_STAT_KEYS, normalizeMetric, buildWorkDailyRows } = require("./statsTable");
const {
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
} = require("./contentLink");

const UTC8_MS = 8 * 3600e3;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WORKS_DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DEFAULT_RANGE_DAYS = 29; // 含起止日共 30 天
const MAX_SHEET_ROWS = 200000;
const ROW_LIMIT_EXCEEDED_CODE = "ROW_LIMIT_EXCEEDED";

const SHEET_NAMES = [
  "作品日明细",
  "作品跨平台汇总",
  "平台日汇总",
  "账号日快照",
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
];

const SCHEMA_HEADERS = ["sheet", "列名", "英文键", "含义/口径"];
const META_HEADERS = ["项目", "值"];

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s;
}

function shiftDateStr(ymd, deltaDays) {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function formatUtc8Date(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + UTC8_MS).toISOString().slice(0, 10);
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
  const ia = PLATFORM_ORDER.indexOf(a);
  const ib = PLATFORM_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
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

  let defaultStore = null;
  const getStore = () => {
    if (!defaultStore) defaultStore = require("./store");
    return defaultStore;
  };

  let defaultPushRecords = null;
  const getPushRecords = () => {
    if (!defaultPushRecords) defaultPushRecords = require("./pushRecords");
    return defaultPushRecords;
  };

  const storeApi = isPlainObject(injected.store) ? injected.store : null;
  const hasInjectedDataSource = Boolean(
    storeApi ||
      typeof injected.listAccounts === "function" ||
      typeof injected.readWorks === "function" ||
      typeof injected.readWorksDaily === "function"
  );
  const emptyOverrides = () => ({ version: 1, updatedAt: 0, overrides: Object.create(null) });

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
    readLinkOverrides:
      typeof injected.readLinkOverrides === "function"
        ? injected.readLinkOverrides
        : storeApi && typeof storeApi.readLinkOverrides === "function"
        ? () => storeApi.readLinkOverrides()
        : isPlainObject(options.linkOverrides)
        ? () => options.linkOverrides
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

function safeSeg(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g, "_");
}

function pickWorkDailyStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) {
    out[k] = hasOwn(w, k) ? normalizeMetric(w[k]) : null;
  }
  return out;
}

function parseDayWorksFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] 作品日快照 JSON 损坏 (${file}):`, (err && err.message) || err);
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.works)) {
    console.warn(`[dataStats] 作品日快照结构无效 (${file})`);
    return null;
  }
  const works = Object.create(null);
  for (const workId of Object.keys(parsed.works)) {
    const desc = Object.getOwnPropertyDescriptor(parsed.works, workId);
    if (desc && isPlainObject(desc.value)) {
      works[workId] = pickWorkDailyStats(desc.value);
    }
  }
  return works;
}

function canUseCutoffFsReader(options, depsArg) {
  const injected = isPlainObject(depsArg)
    ? depsArg
    : isPlainObject(options && options.deps)
    ? options.deps
    : null;
  if (
    injected &&
    (typeof injected.readWorksDaily === "function" ||
      (isPlainObject(injected.store) &&
        typeof injected.store.readWorksDaily === "function"))
  ) {
    return false;
  }
  try {
    const electron = require("electron");
    if (!electron || !electron.app || typeof electron.app.getPath !== "function") {
      return false;
    }
    const storeMod = require("./store");
    if (
      !storeMod ||
      typeof storeMod.readWorksDaily !== "function" ||
      typeof storeMod.mergeWorks !== "function" ||
      typeof storeMod.todayStr !== "function"
    ) {
      return false;
    }
    // 若单测覆盖/包装了 store.readWorksDaily，回退走 io.readWorksDaily 以尊重 mock/spy
    const fnSrc = Function.prototype.toString.call(storeMod.readWorksDaily);
    if (!fnSrc.includes("mergeLegacyWorksDaily")) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 仅读取截至 cutoffDate 的每个作品最新一条快照（跳过 > cutoffDate 的日文件，内存保持 O(作品数)）。
 * 与 store.readWorksDaily 保持同一口径：目录文件优先于旧单文件 works-daily.json。
 */
function readWorksDailyLatestAsOfFs(group, platform, cutoffDate) {
  const { app } = require("electron");
  const accDir = path.join(
    app.getPath("userData"),
    "data-stats",
    safeSeg(group),
    safeSeg(platform)
  );
  const dir = path.join(accDir, "works-daily");
  const bestByWork = Object.create(null);
  let latestDate = "";

  let entries = null;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 读取 works-daily 目录失败 (${dir}):`,
        (err && err.message) || err
      );
    }
  }

  if (Array.isArray(entries) && entries.length > 0) {
    const dayFiles = [];
    for (const name of entries) {
      const m = WORKS_DAILY_FILE_RE.exec(name);
      if (!m) continue;
      const date = m[1];
      if (!isValidDateStr(date)) continue;
      if (cutoffDate && date > cutoffDate) continue;
      dayFiles.push({ date, name });
    }
    // 倒序扫描：每个作品首次命中即为 <= cutoffDate 的最新快照
    dayFiles.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    for (const { date, name } of dayFiles) {
      const file = path.join(dir, name);
      let dayWorks;
      try {
        dayWorks = parseDayWorksFile(file);
      } catch (err) {
        console.warn(
          `[dataStats] 读取作品日快照失败，已跳过 (${file}):`,
          (err && err.message) || err
        );
        continue;
      }
      if (!dayWorks) continue;
      for (const workId of Object.keys(dayWorks)) {
        if (!bestByWork[workId]) {
          bestByWork[workId] = { date, snap: dayWorks[workId] };
          if (!latestDate || date > latestDate) latestDate = date;
        }
      }
    }
  }

  // 兼容旧单文件 works-daily.json（目录同日优先，仅更晚日期可补缺）
  const legacyFile = path.join(accDir, "works-daily.json");
  let legacyRaw = null;
  try {
    legacyRaw = fs.readFileSync(legacyFile, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 读取旧 works-daily.json 失败 (${legacyFile}):`,
        (err && err.message) || err
      );
    }
  }
  if (legacyRaw !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(legacyRaw);
    } catch (err) {
      console.warn(
        `[dataStats] 旧 works-daily.json JSON 损坏，已跳过 (${legacyFile}):`,
        (err && err.message) || err
      );
    }
    if (isPlainObject(parsed)) {
      for (const workId of Object.keys(parsed)) {
        const desc = Object.getOwnPropertyDescriptor(parsed, workId);
        const dateMap = desc ? desc.value : null;
        if (!isPlainObject(dateMap)) continue;
        for (const d of Object.keys(dateMap)) {
          if (!isValidDateStr(d)) continue;
          if (cutoffDate && d > cutoffDate) continue;
          const snapDesc = Object.getOwnPropertyDescriptor(dateMap, d);
          if (!snapDesc || !isPlainObject(snapDesc.value)) continue;
          const prev = bestByWork[workId];
          if (!prev || d > prev.date) {
            bestByWork[workId] = { date: d, snap: pickWorkDailyStats(snapDesc.value) };
            if (!latestDate || d > latestDate) latestDate = d;
          }
        }
      }
    }
  }

  const worksDaily = Object.create(null);
  for (const workId of Object.keys(bestByWork)) {
    const entry = bestByWork[workId];
    worksDaily[workId] = { [entry.date]: entry.snap };
  }
  return { worksDaily, latestDate };
}

function reduceWorksDailyAsOf(rawWorksDaily, cutoffDate) {
  const worksDaily = Object.create(null);
  let latestDate = "";
  if (!isPlainObject(rawWorksDaily)) return { worksDaily, latestDate };
  for (const workId of Object.keys(rawWorksDaily)) {
    const desc = Object.getOwnPropertyDescriptor(rawWorksDaily, workId);
    const dateMap = desc ? desc.value : null;
    if (!isPlainObject(dateMap)) continue;
    let bestDate = "";
    let bestSnap = null;
    for (const d of Object.keys(dateMap)) {
      if (!isValidDateStr(d)) continue;
      if (cutoffDate && d > cutoffDate) continue;
      const snapDesc = Object.getOwnPropertyDescriptor(dateMap, d);
      const snap = snapDesc ? snapDesc.value : null;
      if (!isPlainObject(snap)) continue;
      if (!bestDate || d > bestDate) {
        bestDate = d;
        bestSnap = snap;
      }
    }
    if (bestSnap) {
      worksDaily[workId] = { [bestDate]: bestSnap };
      if (!latestDate || bestDate > latestDate) latestDate = bestDate;
    }
  }
  return { worksDaily, latestDate };
}

function loadRawDataset(options = {}, depsArg) {
  const io = resolveIoDeps(options, depsArg);
  const groupSet =
    Array.isArray(options.groups) && options.groups.length > 0
      ? new Set(options.groups.map((g) => String(g)))
      : null;

  const rawAccounts = io.listAccounts() || [];
  const accountsData = [];
  const worksDailyByGp = Object.create(null);

  for (const acc of rawAccounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    if (groupSet && !groupSet.has(group)) continue;

    const worksDoc = io.readWorks(group, platform);
    const works =
      worksDoc && Array.isArray(worksDoc.works)
        ? worksDoc.works
        : Array.isArray(worksDoc)
        ? worksDoc
        : [];
    const rawWorksDaily = io.readWorksDaily(group, platform);
    const worksDaily = isPlainObject(rawWorksDaily) ? rawWorksDaily : Object.create(null);
    const rawDaily = io.readDaily(group, platform);
    const daily = isPlainObject(rawDaily) ? rawDaily : {};

    accountsData.push({ group, platform, works, worksDaily, daily });
    worksDailyByGp[`${group}|${platform}`] = worksDaily;
  }

  accountsData.sort((a, b) => {
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  const rawPushRecords = io.readPushRecords() || [];
  const filteredPushRecords = groupSet
    ? rawPushRecords.filter((rec) => groupSet.has(resolveRecordGroup(rec)))
    : rawPushRecords;

  const latestDataDate = findLatestDataDate(accountsData);
  const linkOverrides = io.readLinkOverrides();

  return {
    io,
    accountsData,
    worksDailyByGp,
    pushRecords: filteredPushRecords,
    linkOverrides,
    latestDataDate,
  };
}

/**
 * 仅加载「作品跨平台汇总」截至 cutoffDate 所需数据：
 * - 不读取 daily.json（仅当所有作品快照均为空且未指定 date 时才兜底查最新快照日）
 * - works-daily 仅保留每作品 <= cutoffDate 的最新一条快照（真实存储跳过 > cutoffDate 文件）
 */
function loadSummaryDataset(options = {}, depsArg, explicitCutoffDate = "") {
  const io = resolveIoDeps(options, depsArg);
  const groupSet =
    Array.isArray(options.groups) && options.groups.length > 0
      ? new Set(options.groups.map((g) => String(g)))
      : null;

  const rawAccounts = io.listAccounts() || [];
  const accountsData = [];
  const worksDailyByGp = Object.create(null);
  let latestWorksDate = "";
  const useFastFs = canUseCutoffFsReader(options, depsArg);

  for (const acc of rawAccounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    if (groupSet && !groupSet.has(group)) continue;

    const worksDoc = io.readWorks(group, platform);
    const works =
      worksDoc && Array.isArray(worksDoc.works)
        ? worksDoc.works
        : Array.isArray(worksDoc)
        ? worksDoc
        : [];

    const res = useFastFs
      ? readWorksDailyLatestAsOfFs(group, platform, explicitCutoffDate)
      : reduceWorksDailyAsOf(io.readWorksDaily(group, platform), explicitCutoffDate);

    if (res.latestDate && (!latestWorksDate || res.latestDate > latestWorksDate)) {
      latestWorksDate = res.latestDate;
    }

    accountsData.push({ group, platform, works, worksDaily: res.worksDaily, daily: {} });
    worksDailyByGp[`${group}|${platform}`] = res.worksDaily;
  }

  accountsData.sort((a, b) => {
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  const rawPushRecords = io.readPushRecords() || [];
  const filteredPushRecords = groupSet
    ? rawPushRecords.filter((rec) => groupSet.has(resolveRecordGroup(rec)))
    : rawPushRecords;

  let latestDataDate = latestWorksDate;
  if (!explicitCutoffDate && !latestDataDate) {
    for (const acc of accountsData) {
      const rawDaily = io.readDaily(acc.group, acc.platform);
      if (!isPlainObject(rawDaily)) continue;
      for (const [d, snap] of Object.entries(rawDaily)) {
        if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
        if (!latestDataDate || d > latestDataDate) latestDataDate = d;
      }
    }
  }

  const linkOverrides = io.readLinkOverrides();

  return {
    io,
    accountsData,
    worksDailyByGp,
    pushRecords: filteredPushRecords,
    linkOverrides,
    latestDataDate,
  };
}

function findLatestDataDate(accountsData) {
  let latest = "";
  for (const acc of accountsData) {
    for (const dateMap of Object.values(acc.worksDaily)) {
      if (!isPlainObject(dateMap)) continue;
      for (const [d, snap] of Object.entries(dateMap)) {
        if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
        if (!latest || d > latest) latest = d;
      }
    }
    for (const [d, snap] of Object.entries(acc.daily)) {
      if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
      if (!latest || d > latest) latest = d;
    }
  }
  return latest;
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
    for (const workId of Object.keys(acc.worksDaily)) {
      const desc = Object.getOwnPropertyDescriptor(acc.worksDaily, workId);
      const dateMap = desc ? desc.value : null;
      if (!isPlainObject(dateMap)) continue;
      for (const d of Object.keys(dateMap)) {
        if (!isValidDateStr(d)) continue;
        if (from && d < from) continue;
        if (to && d > to) continue;
        const snapDesc = Object.getOwnPropertyDescriptor(dateMap, d);
        if (!snapDesc || !isPlainObject(snapDesc.value)) continue;
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

function buildDefaultExportFileName(from, to, now = Date.now()) {
  const today = formatUtc8Date(now);
  let resolvedTo = to || today;
  if (!to && from && resolvedTo < from) {
    resolvedTo = from;
  }
  const resolvedFrom = from || shiftDateStr(resolvedTo, -DEFAULT_RANGE_DAYS);
  return `MatrixMedia-作品数据-${resolvedFrom}_${resolvedTo}.xlsx`;
}

/**
 * 构建跨平台内容汇总数据（供 GUI「作品汇总」tab / IPC stats:get-content-summary 复用）。
 * - 仅读取截止日所需快照（不读全量历史，不排序作品日明细）
 * - 先解析统一 cutoffDate（参数 date，缺省=最新快照日），同一个 cutoff 用于关联、汇总、计数和页面回执
 */
function buildContentSummaryData(options = {}, depsArg) {
  const opts = isPlainObject(options) ? options : {};
  const dateStr = validateOptionalDate(opts.date, "date");
  const dataset = loadSummaryDataset(opts, depsArg, dateStr);
  const cutoffDate = dateStr || dataset.latestDataDate || "";
  const contents = buildContentIndex(dataset.pushRecords);
  const rows = buildContentSummaryRows({
    contents,
    accounts: dataset.accountsData,
    worksDaily: dataset.worksDailyByGp,
    date: cutoffDate || undefined,
    overrides: dataset.linkOverrides,
  });
  const workCounts = computeWorkCountsFromSummaryRows(rows);

  return {
    rows,
    date: cutoffDate,
    counts: {
      accounts: dataset.accountsData.length,
      works: workCounts.works,
      contents: rows.length,
      unlinkedWorks: workCounts.unlinkedWorks,
    },
  };
}

/** Sheet 1: 作品日明细 */
function buildWorkDailySheet(accountsData, link, from, to) {
  const allRows = [];
  for (const acc of accountsData) {
    const rows = buildWorkDailyRows({
      group: acc.group,
      platform: acc.platform,
      works: acc.works,
      worksDaily: acc.worksDaily,
      from,
      to,
      link,
    });
    for (const r of rows) allRows.push(r);
  }

  allRows.sort((a, b) => {
    if (a.date !== b.date) return compareText(a.date, b.date);
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    const gc = compareText(a.group, b.group);
    if (gc !== 0) return gc;
    if (a.publishTime !== b.publishTime) {
      if (!a.publishTime) return 1;
      if (!b.publishTime) return -1;
      return a.publishTime > b.publishTime ? -1 : 1;
    }
    return compareText(a.workId, b.workId);
  });

  const aoa = [WORK_DAILY_HEADERS.map(sanitizeTextCell)];
  for (const r of allRows) {
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
      sanitizeTextCell(rawTimestampToUtc8Date(r.publishTime)),
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

  return { aoa, rows: allRows };
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

/** Sheet 4: 账号日快照（daily.json，日增=与上一有记录日之差） */
function buildAccountDailySheet(accountsData, from, to) {
  const rows = [];

  for (const acc of accountsData) {
    const dates = Object.keys(acc.daily)
      .filter((d) => isValidDateStr(d) && isPlainObject(acc.daily[d]))
      .sort(compareText);

    let prevFans = null;
    let prevPlays = null;

    for (const date of dates) {
      const snap = acc.daily[date];
      const vals = {};
      for (const k of ACCOUNT_METRIC_KEYS) {
        vals[k] = hasOwn(snap, k) ? normalizeMetric(snap[k]) : null;
      }

      const fansDelta =
        vals.fans !== null && prevFans !== null ? vals.fans - prevFans : null;
      const playsDelta =
        vals.plays !== null && prevPlays !== null ? vals.plays - prevPlays : null;

      if (vals.fans !== null) prevFans = vals.fans;
      if (vals.plays !== null) prevPlays = vals.plays;

      if (from && date < from) continue;
      if (to && date > to) continue;

      rows.push({
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
      });
    }
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return compareText(a.date, b.date);
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  const aoa = [ACCOUNT_DAILY_HEADERS.map(sanitizeTextCell)];
  for (const r of rows) {
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
    ]);
  }

  return { aoa, rows };
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
      "跨平台关联后的内容唯一键（file:<完整路径>、record:<日期>:<id>、auto:<哈希> 或 manual:<id>）；未关联作品为空单元格。",
    ],
    [
      "作品日明细",
      "关联方式",
      "matchedBy",
      "跨平台关联依据：link（直链严格 1:1 匹配）、title（同组同平台唯一标题匹配）、fuzzy（标题模糊+时间窗口自动匹配或无发布记录跨平台聚类）、manual（手工指定/合并/确认）；未关联为空。注意：模糊匹配可能合错，已手工确认的标 manual。",
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

    // 2. 作品跨平台汇总
    [
      "作品跨平台汇总",
      "内容ID",
      "contentKey",
      "内容唯一键（file:<路径> / record:<日期>:<id> / auto:<哈希> / manual:<id>）；未关联作品各自独立成行，键为 unlinked:<平台>:<作品ID>。",
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
      "当日总播放 − 该账号上一有播放记录日的总播放（日增口径，跳过仅粉丝历史回填日；断档跨天时为多天合计变化）。",
    ],

    // 5. 字段说明
    ["字段说明", "sheet", "sheet", "字段所属工作表名称。"],
    ["字段说明", "列名", "column", "对应工作表首行的中文列名。"],
    ["字段说明", "英文键", "key", "对应内部数据结构字段名，便于脚本或 AI 对齐。"],
    [
      "字段说明",
      "含义/口径",
      "description",
      "字段含义、累计值与日增口径、平台缺项规则及已知问题说明。",
    ],

    // 6. 导出信息
    ["导出信息", "项目", "item", "本次导出元信息条目名称。"],
    [
      "导出信息",
      "值",
      "value",
      "本次导出的元信息取值（导出时间、日期范围、应用版本及账号/作品/内容/未关联计数；作品数与未关联作品数沿用作品跨平台汇总的去重与关联口径）。",
    ]
  );

  const aoa = [SCHEMA_HEADERS.map(sanitizeTextCell)];
  for (const row of entries) {
    aoa.push(row.map(sanitizeTextCell));
  }
  return aoa;
}

/** Sheet 6: 导出信息 */
function buildMetaSheet({ exportedAt, from, to, appVersion, counts }) {
  const aoa = [META_HEADERS.map(sanitizeTextCell)];
  aoa.push(
    [sanitizeTextCell("导出时间"), sanitizeTextCell(exportedAt)],
    [sanitizeTextCell("日期范围"), sanitizeTextCell(`${from} ~ ${to}`)],
    [sanitizeTextCell("应用版本"), sanitizeTextCell(appVersion)],
    [sanitizeTextCell("账号数"), sanitizeNumberCell(counts.accounts)],
    [sanitizeTextCell("作品数"), sanitizeNumberCell(counts.works)],
    [sanitizeTextCell("内容数"), sanitizeNumberCell(counts.contents)],
    [sanitizeTextCell("未关联作品数"), sanitizeNumberCell(counts.unlinkedWorks)]
  );
  return aoa;
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

  const dataset = loadRawDataset(opts, deps);
  const nowVal = dataset.io.now !== undefined ? dataset.io.now : Date.now();
  const fallbackToday = formatUtc8Date(nowVal);

  let resolvedTo = explicitTo || dataset.latestDataDate || fallbackToday;
  if (!explicitTo && explicitFrom && resolvedTo < explicitFrom) {
    resolvedTo = explicitFrom;
  }
  const resolvedFrom = explicitFrom || shiftDateStr(resolvedTo, -DEFAULT_RANGE_DAYS);

  // 构建前先计数「作品日明细」与「账号日快照」行数，超限直接拒绝，避免无谓排序与高内存占用
  const estWorkDailyRows = countWorkDailyRows(
    dataset.accountsData,
    resolvedFrom,
    resolvedTo
  );
  if (estWorkDailyRows > maxRows) {
    throw createRowLimitError(estWorkDailyRows, maxRows, "作品日明细");
  }
  const estAccountDailyRows = countAccountDailyRows(
    dataset.accountsData,
    resolvedFrom,
    resolvedTo
  );
  if (estAccountDailyRows > maxRows) {
    throw createRowLimitError(estAccountDailyRows, maxRows, "账号日快照");
  }

  const contents = buildContentIndex(dataset.pushRecords);
  const link = linkWorks({
    contents,
    accounts: dataset.accountsData,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
  });
  const summaryRows = buildContentSummaryRows({
    contents,
    accounts: dataset.accountsData,
    worksDaily: dataset.worksDailyByGp,
    date: resolvedTo,
    overrides: dataset.linkOverrides,
  });
  if (summaryRows.length > maxRows) {
    throw createRowLimitError(summaryRows.length, maxRows, "作品跨平台汇总");
  }

  const workDaily = buildWorkDailySheet(
    dataset.accountsData,
    link,
    resolvedFrom,
    resolvedTo
  );
  const contentSummary = buildContentSummarySheet(summaryRows);
  const platformDaily = buildPlatformDailySheet(workDaily.rows);
  const accountDaily = buildAccountDailySheet(
    dataset.accountsData,
    resolvedFrom,
    resolvedTo
  );
  const schemaAoa = buildSchemaSheet(contentSummary.dynamicSchemaEntries);

  const workCounts = computeWorkCountsFromSummaryRows(summaryRows);
  const counts = {
    accounts: dataset.accountsData.length,
    works: workCounts.works,
    contents: summaryRows.length,
    unlinkedWorks: workCounts.unlinkedWorks,
    workDailyRows: workDaily.rows.length,
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
  });

  const sheets = {
    作品日明细: workDaily.aoa,
    作品跨平台汇总: contentSummary.aoa,
    平台日汇总: platformDaily.aoa,
    账号日快照: accountDaily.aoa,
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
    exportedAt,
    appVersion,
    sheetOrder: [...SHEET_NAMES],
    sheets,
    counts,
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
  const colCount = aoa[0].length;
  const widths = new Array(colCount).fill(10);
  const sampleLimit = Math.min(aoa.length, 500);
  for (let r = 0; r < sampleLimit; r++) {
    const row = aoa[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < colCount; c++) {
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
    const maxW = name === "字段说明" ? 64 : 44;
    ws["!cols"] = computeColWidths(aoa, maxW);
    xlsx.utils.book_append_sheet(wb, ws, name);
  }

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const buf = xlsx.write(wb, { type: "buffer", bookType: "xlsx" });
  fs.writeFileSync(resolvedPath, buf);
  return resolvedPath;
}

module.exports = {
  SHEET_NAMES,
  MAX_SHEET_ROWS,
  ROW_LIMIT_EXCEEDED_CODE,
  WORK_DAILY_HEADERS,
  SUMMARY_BASE_HEADERS,
  PLATFORM_DAILY_HEADERS,
  ACCOUNT_DAILY_HEADERS,
  SCHEMA_HEADERS,
  META_HEADERS,
  isValidDateStr,
  sanitizeTextCell,
  sanitizeNumberCell,
  validateExportDateRange,
  buildDefaultExportFileName,
  countWorkDailyRows,
  computeWorkCountsFromSummaryRows,
  buildContentSummaryData,
  buildStatsWorkbookData,
  writeStatsXlsx,
};
