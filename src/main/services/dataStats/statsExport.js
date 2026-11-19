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
  makeWorkKey,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
} = require("./contentLink");

const UTC8_MS = 8 * 3600e3;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 29; // 含起止日共 30 天

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

const WORK_DAILY_HEADERS = [
  "日期",
  "平台",
  "分组",
  "内容ID",
  "关联方式",
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

  return {
    io,
    accountsData,
    worksDailyByGp,
    pushRecords: filteredPushRecords,
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

function computeWorkCountsAsOf(accountsData, link, cutoffDate) {
  const workLinkedMap = new Map();

  for (const acc of accountsData) {
    for (const w of acc.works) {
      if (!isPlainObject(w)) continue;
      const workId = w.workId == null ? "" : String(w.workId);
      if (!workId) continue;
      const pubDate = rawTimestampToUtc8Date(w.publishTime);
      if (cutoffDate && pubDate && pubDate > cutoffDate) continue;
      const workKey = makeWorkKey(acc.group, acc.platform, workId);
      const entry = link.get(workKey);
      const linked = Boolean(entry && entry.contentKey != null && entry.contentKey !== "");
      if (!workLinkedMap.has(workKey)) {
        workLinkedMap.set(workKey, linked);
      }
    }
    for (const [workId, dateMap] of Object.entries(acc.worksDaily)) {
      if (!workId || !isPlainObject(dateMap)) continue;
      let hasSnapAsOf = false;
      for (const [d, snap] of Object.entries(dateMap)) {
        if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
        if (!cutoffDate || d <= cutoffDate) {
          hasSnapAsOf = true;
          break;
        }
      }
      if (!hasSnapAsOf) continue;
      const workKey = makeWorkKey(acc.group, acc.platform, workId);
      if (!workLinkedMap.has(workKey)) {
        workLinkedMap.set(workKey, false);
      }
    }
  }

  let unlinkedWorks = 0;
  for (const linked of workLinkedMap.values()) {
    if (!linked) unlinkedWorks++;
  }
  return {
    works: workLinkedMap.size,
    unlinkedWorks,
  };
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

/**
 * 构建跨平台内容汇总数据（供 GUI「作品汇总」tab / IPC stats:get-content-summary 复用）。
 */
function buildContentSummaryData(options = {}, depsArg) {
  const dateStr = validateOptionalDate(options.date, "date");
  const dataset = loadRawDataset(options, depsArg);
  const contents = buildContentIndex(dataset.pushRecords);
  const cutoffDate = dateStr || "";
  const link = linkWorks({
    contents,
    accounts: dataset.accountsData,
    date: cutoffDate || undefined,
  });
  const rows = buildContentSummaryRows({
    contents,
    accounts: dataset.accountsData,
    worksDaily: dataset.worksDailyByGp,
    date: cutoffDate || undefined,
  });
  const workCounts = computeWorkCountsAsOf(
    dataset.accountsData,
    link,
    cutoffDate
  );

  return {
    rows,
    date: dateStr || dataset.latestDataDate || "",
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
    aoa.push([
      sanitizeTextCell(r.date),
      sanitizeTextCell(r.platform),
      sanitizeTextCell(r.group),
      sanitizeTextCell(r.contentKey),
      sanitizeTextCell(r.matchedBy),
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
    const cells = [
      sanitizeTextCell(row.contentKey),
      sanitizeTextCell(row.title),
      sanitizeTextCell(row.file),
      sanitizeTextCell(row.firstPublishDate),
      sanitizeNumberCell(row.platformCount),
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

/** Sheet 3: 平台日汇总（由作品日明细按 日期+平台 求和，null 不计；全 null 为空） */
function buildPlatformDailySheet(workDailyRows) {
  const buckets = new Map();

  for (const r of workDailyRows) {
    const key = `${r.date}|${r.platform}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        date: r.date,
        platform: r.platform,
        workCount: 0,
        sums: Object.create(null),
      };
      for (const dk of WORK_DELTA_KEYS) agg.sums[dk] = null;
      buckets.set(key, agg);
    }

    const hasCumulativeData = WORK_STAT_KEYS.some((k) => r[k] !== null);
    if (hasCumulativeData) agg.workCount += 1;

    for (const dk of WORK_DELTA_KEYS) {
      const val = r[dk];
      if (typeof val === "number" && Number.isFinite(val)) {
        const next = agg.sums[dk] === null ? val : agg.sums[dk] + val;
        agg.sums[dk] = next === 0 ? 0 : next;
      }
    }
  }

  const rows = [...buckets.values()].sort((a, b) => {
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

/** Sheet 5: 字段说明（每个 sheet 每列一行） */
function buildSchemaSheet(dynamicSchemaEntries) {
  const entries = [
    // 1. 作品日明细
    [
      "作品日明细",
      "日期",
      "date",
      "快照采集日期（YYYY-MM-DD，UTC+8）。平台数据通常为 T+1 口径（如抖音当天数据不可查，次日更新）。",
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
      "账号分组名。已知问题：同组同平台挂多个账号时，本地统计按「分组/平台」合并存储，无法拆分到单账号。",
    ],
    [
      "作品日明细",
      "内容ID",
      "contentKey",
      "跨平台关联后的内容唯一键（file:<完整路径> 或 record:<日期>:<id>）；未关联作品为空单元格。",
    ],
    [
      "作品日明细",
      "关联方式",
      "matchedBy",
      "与本地发布记录的匹配依据：link（直链严格 1:1 匹配）或 title（同组同平台唯一标题匹配）；未关联为空。",
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
      "截至当日的累计播放量（累计值，非日增）。缺失为空单元格而非 0。已知问题：部分平台适配器可能把缺失指标写成 0，导致「掉 0 再回升」假波动。",
    ],
    [
      "作品日明细",
      "点赞",
      "like",
      "截至当日的累计点赞数（累计值，非日增）；缺失为空不是 0。",
    ],
    [
      "作品日明细",
      "评论",
      "comment",
      "截至当日的累计评论数（累计值，非日增）；缺失为空不是 0。",
    ],
    [
      "作品日明细",
      "分享",
      "share",
      "截至当日的累计分享数（累计值）。平台缺项为空不是 0（快手无分享）。",
    ],
    [
      "作品日明细",
      "收藏",
      "favorite",
      "截至当日的累计收藏数（累计值）。平台缺项为空不是 0（快手无收藏/分享、抖音无收藏、头条无收藏）。",
    ],
    [
      "作品日明细",
      "涨粉",
      "fansDelta",
      "截至当日该作品带来的累计涨粉数（累计值）。平台缺项为空不是 0（仅抖音/视频号有单作品涨粉，B站无单视频涨粉）。",
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
      "分享日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；平台缺项（快手无分享）为空不是 0。",
    ],
    [
      "作品日明细",
      "收藏日增",
      "favoriteDelta",
      "收藏日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；平台缺项（快手/抖音/头条无收藏）为空不是 0。",
    ],
    [
      "作品日明细",
      "涨粉日增",
      "fansDeltaDelta",
      "涨粉日增量=与该作品上一次有记录日期的差；断档天数 > 0 时日增跨多天；仅抖音/视频号有涨粉，B站无单视频涨粉，缺项为空不是 0。",
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
      "内容唯一键（file:<路径> / record:<日期>:<id>）；未关联作品各自独立成行，键为 unlinked:<平台>:<作品ID>。",
    ],
    [
      "作品跨平台汇总",
      "标题",
      "title",
      "内容展示标题（已关联优先取最早发布记录标题，未关联取作品标题）。",
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
      "截至结束日期（to）各平台最新累计分享数之和（累计值；快手无分享为空不是 0，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总收藏",
      "totalFavorite",
      "截至结束日期（to）各平台最新累计收藏数之和（累计值；快手/抖音/头条无收藏为空不是 0，全空则为空）。",
    ],
    [
      "作品跨平台汇总",
      "总涨粉",
      "totalFansDelta",
      "截至结束日期（to）各平台最新累计涨粉数之和（累计值；仅抖音/视频号有涨粉，B站无单视频涨粉，缺项为空不是 0）。",
    ],
  ];

  if (dynamicSchemaEntries && dynamicSchemaEntries.length > 0) {
    for (const d of dynamicSchemaEntries) {
      entries.push(["作品跨平台汇总", d.col, d.key, d.desc]);
    }
  } else {
    entries.push([
      "作品跨平台汇总",
      "<平台>·<分组>·播放/点赞/评论",
      "perPlatform.<platform|group>.play|like|comment",
      "动态列：每个出现过的「平台|分组」各占播放/点赞/评论 3 列（截至结束日期 to 的累计值）。",
    ]);
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
      "统计日期（YYYY-MM-DD，UTC+8）。数据 T+1（抖音当天不可查）。",
    ],
    ["平台日汇总", "平台", "platform", "平台中文名。"],
    [
      "平台日汇总",
      "有数据作品数",
      "workCount",
      "当日该平台在「作品日明细」中至少有一项非空累计指标的作品条数。",
    ],
    [
      "平台日汇总",
      "播放日增合计",
      "playDeltaSum",
      "由「作品日明细」按日期+平台对播放日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "点赞日增合计",
      "likeDeltaSum",
      "由「作品日明细」按日期+平台对点赞日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "评论日增合计",
      "commentDeltaSum",
      "由「作品日明细」按日期+平台对评论日增求和（日增口径；空值不计，全空则为空单元格）。",
    ],
    [
      "平台日汇总",
      "分享日增合计",
      "shareDeltaSum",
      "由「作品日明细」按日期+平台对分享日增求和（空值不计，全空则为空；快手无分享为空不是 0）。",
    ],
    [
      "平台日汇总",
      "收藏日增合计",
      "favoriteDeltaSum",
      "由「作品日明细」按日期+平台对收藏日增求和（空值不计，全空则为空；快手/抖音/头条无收藏为空不是 0）。",
    ],
    [
      "平台日汇总",
      "涨粉日增合计",
      "fansDeltaDeltaSum",
      "由「作品日明细」按日期+平台对涨粉日增求和（空值不计，全空则为空；仅抖音/视频号有涨粉，B站无单视频涨粉）。",
    ],

    // 4. 账号日快照
    [
      "账号日快照",
      "日期",
      "date",
      "账号日快照日期（YYYY-MM-DD，UTC+8，含抖音/视频号历史粉丝回填日期；数据 T+1）。",
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
      "当日账号累计粉丝总数（累计值，来自 daily.json）。",
    ],
    [
      "账号日快照",
      "总播放",
      "plays",
      "当日账号累计总播放量（累计值；仅粉丝历史回填日为空；已知问题：部分适配器可能把缺失写成 0 导致假波动）。",
    ],
    ["账号日快照", "总点赞", "likes", "当日账号累计总点赞数（累计值）。"],
    ["账号日快照", "总评论", "comments", "当日账号累计总评论数（累计值）。"],
    [
      "账号日快照",
      "总收藏",
      "favorites",
      "当日账号累计总收藏数（累计值；快手/抖音/头条无收藏为空不是 0）。",
    ],
    [
      "账号日快照",
      "总分享",
      "shares",
      "当日账号累计总分享数（累计值；快手无分享为空不是 0）。",
    ],
    [
      "账号日快照",
      "粉丝日增",
      "fansDelta",
      "当日粉丝数 − 该账号上一有粉丝记录日的粉丝数（日增口径；断档跨天时为多天合计变化）。",
    ],
    [
      "账号日快照",
      "播放日增",
      "playsDelta",
      "当日总播放 − 该账号上一有播放记录日的总播放（日增口径；断档跨天时为多天合计变化）。",
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
      "本次导出的元信息取值（导出时间、日期范围、应用版本及账号/作品/内容/未关联计数）。",
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
 * @param {number|Date} [options.now]   可选，注入导出时间
 * @param {string} [options.appVersion] 可选，注入应用版本
 * @param {string} [options.pushDataDir] 可选，注入 pushData 目录
 * @param {object} [deps]               可选，注入 store/pushRecords 读函数
 */
function buildStatsWorkbookData(options = {}, deps) {
  const opts = isPlainObject(options) ? options : {};
  const explicitFrom = validateOptionalDate(opts.from, "from");
  const explicitTo = validateOptionalDate(opts.to, "to");
  if (explicitFrom && explicitTo && explicitFrom > explicitTo) {
    throw new Error(`开始日期不能晚于结束日期（${explicitFrom} > ${explicitTo}）`);
  }

  const dataset = loadRawDataset(opts, deps);
  const nowVal = dataset.io.now !== undefined ? dataset.io.now : Date.now();
  const fallbackToday = formatUtc8Date(nowVal);

  let resolvedTo = explicitTo || dataset.latestDataDate || fallbackToday;
  if (!explicitTo && explicitFrom && resolvedTo < explicitFrom) {
    resolvedTo = explicitFrom;
  }
  const resolvedFrom = explicitFrom || shiftDateStr(resolvedTo, -DEFAULT_RANGE_DAYS);

  const contents = buildContentIndex(dataset.pushRecords);
  const link = linkWorks({
    contents,
    accounts: dataset.accountsData,
    date: resolvedTo,
  });
  const summaryRows = buildContentSummaryRows({
    contents,
    accounts: dataset.accountsData,
    worksDaily: dataset.worksDailyByGp,
    date: resolvedTo,
  });

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

  const workCounts = computeWorkCountsAsOf(dataset.accountsData, link, resolvedTo);
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

  return {
    from: resolvedFrom,
    to: resolvedTo,
    exportedAt,
    appVersion,
    sheetOrder: [...SHEET_NAMES],
    sheets: {
      作品日明细: workDaily.aoa,
      作品跨平台汇总: contentSummary.aoa,
      平台日汇总: platformDaily.aoa,
      账号日快照: accountDaily.aoa,
      字段说明: schemaAoa,
      导出信息: metaAoa,
    },
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
 */
function writeStatsXlsx(data, filePath) {
  if (!data || !isPlainObject(data.sheets)) {
    throw new Error("无效的工作簿数据");
  }
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("导出路径不能为空");
  }
  const resolvedPath = path.resolve(filePath.trim());
  const wb = xlsx.utils.book_new();
  const order =
    Array.isArray(data.sheetOrder) && data.sheetOrder.length
      ? data.sheetOrder
      : SHEET_NAMES;

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
  WORK_DAILY_HEADERS,
  SUMMARY_BASE_HEADERS,
  PLATFORM_DAILY_HEADERS,
  ACCOUNT_DAILY_HEADERS,
  SCHEMA_HEADERS,
  META_HEADERS,
  isValidDateStr,
  sanitizeTextCell,
  sanitizeNumberCell,
  buildContentSummaryData,
  buildStatsWorkbookData,
  writeStatsXlsx,
};
