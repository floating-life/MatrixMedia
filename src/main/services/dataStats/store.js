"use strict";

/**
 * 数据统计本地存储（userData/data-stats/<分组>/<平台>/）：
 *   daily.json       每日总量快照 { "YYYY-MM-DD": { fans, plays, likes, comments, favorites, shares } }
 *   works.json       作品列表 + 发布增长封闭记录
 *   works-daily/     作品每日累计值快照目录（每日一文件 YYYY-MM-DD.json：{ date, updatedAt, works }）
 *   meta.json        { lastCollectAt, lastError, workCount }
 *
 * 日趋势口径：所有平台统一为「当日总量快照」；抖音/视频号额外回填粉丝历史（只补缺日期）。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const METRIC_KEYS = ["fans", "plays", "likes", "comments", "favorites", "shares"];

function baseDir() {
  return path.join(app.getPath("userData"), "data-stats");
}

function safeSeg(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g, "_");
}

function accountDir(group, platform) {
  return path.join(baseDir(), safeSeg(group), safeSeg(platform));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function todayStr(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/* ---------------- daily ---------------- */

function readDaily(group, platform) {
  return readJson(path.join(accountDir(group, platform), "daily.json"), {});
}

function writeDaily(group, platform, daily) {
  writeJson(path.join(accountDir(group, platform), "daily.json"), daily);
}

/**
 * 合并一次采集到 daily：写入当日总量快照；fansHistory 只回填缺失日期。
 */
function mergeDaily(group, platform, overview, fansHistory, now = Date.now()) {
  const daily = readDaily(group, platform);
  const today = todayStr(now);
  const snap = {};
  for (const k of METRIC_KEYS) {
    const v = Number(overview && overview[k]);
    if (Number.isFinite(v)) snap[k] = v;
  }
  daily[today] = { ...daily[today], ...snap };
  for (const point of fansHistory || []) {
    if (!point || !point.date) continue;
    if (!daily[point.date]) daily[point.date] = {};
    if (daily[point.date].fans == null) {
      daily[point.date].fans = Number(point.value) || 0;
    }
  }
  writeDaily(group, platform, daily);
  return daily;
}

/* ---------------- works（发布增长） ---------------- */

function normalizeAltTitles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!item.trim() || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function readWorks(group, platform) {
  const data = readJson(path.join(accountDir(group, platform), "works.json"), {
    works: [],
  });
  const works = Array.isArray(data && data.works)
    ? data.works.map((w) =>
        isPlainObject(w) ? { ...w, altTitles: normalizeAltTitles(w.altTitles) } : w
      )
    : [];
  return { ...(isPlainObject(data) ? data : {}), works };
}

function writeWorks(group, platform, data) {
  writeJson(path.join(accountDir(group, platform), "works.json"), data);
}

function pickStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) out[k] = w[k] == null ? null : w[k];
  return out;
}

const NAIVE_PUBLISH_TIME_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/;
const TZ_SUFFIX_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function parseValidPublishTime(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") {
    ms = raw;
  } else if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      ms = Number(s);
    } else if (TZ_SUFFIX_RE.test(s)) {
      ms = Date.parse(s.replace(/\//g, "-").replace(" ", "T"));
    } else {
      const m = NAIVE_PUBLISH_TIME_RE.exec(s);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const hh = m[4] ? Number(m[4]) : 0;
        const mm = m[5] ? Number(m[5]) : 0;
        const ss = m[6] ? Number(m[6]) : 0;
        const frac = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh <= 23 && mm <= 59 && ss <= 59) {
          const utcMs = Date.UTC(y, mo - 1, d, hh, mm, ss, frac);
          const check = new Date(utcMs);
          if (
            check.getUTCFullYear() === y &&
            check.getUTCMonth() === mo - 1 &&
            check.getUTCDate() === d
          ) {
            ms = utcMs - 8 * 3600e3;
          }
        }
      } else {
        ms = Date.parse(s);
      }
    }
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (!Number.isFinite(new Date(ms).getTime())) return null;
  return ms;
}

/**
 * 合并作品列表，实现「发布增长」口径：
 * - 新出现的作品：登记基线（首次见到时的值），并封闭「比它早且尚未封闭」的最近一条
 * - 已有作品：更新当前累计值；若重采得到有效 publishTime（>0 且可解析）同步更新
 * - 展示时优先用封闭值（closedStats），未封闭用当前值
 */
function mergeWorks(group, platform, newWorks, now = Date.now()) {
  const data = readWorks(group, platform);
  const byId = new Map(data.works.map((w) => [w.workId, w]));
  // 首次全量导入时不做封闭：封闭语义是「两次采集之间出现了新发布」，
  // 首次导入没有历史基线，全部登记为未封闭
  const isFirstImport = data.works.length === 0;

  // 接口返回按发布时间倒序；先升序处理，便于「上一条」封闭逻辑
  const sorted = [...(newWorks || [])]
    .filter((w) => w && w.workId)
    .sort((a, b) => (parseValidPublishTime(a.publishTime) || 0) - (parseValidPublishTime(b.publishTime) || 0));

  for (const w of sorted) {
    const validPubTime = parseValidPublishTime(w.publishTime);
    const existing = byId.get(w.workId);
    if (existing) {
      Object.assign(existing, pickStats(w), { updatedAt: now });
      if (w.title) existing.title = w.title;
      if (w.url) existing.url = w.url;
      if (validPubTime !== null) existing.publishTime = validPubTime;
      if (Array.isArray(w.altTitles)) {
        existing.altTitles = normalizeAltTitles(w.altTitles);
      } else if (!Array.isArray(existing.altTitles)) {
        existing.altTitles = [];
      }
      continue;
    }
    // 新作品：封闭比它早的最近一条未封闭作品（仅非首次导入时）
    const newPubTime = validPubTime !== null ? validPubTime : 0;
    if (!isFirstImport) {
      const earlier = data.works
        .filter((x) => !x.closedStats && (x.publishTime || 0) < newPubTime)
        .sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0))[0];
      if (earlier) {
        earlier.closedStats = pickStats(earlier);
        earlier.closedAt = now;
      }
    }
    const row = {
      workId: w.workId,
      title: w.title || "(无标题)",
      altTitles: normalizeAltTitles(w.altTitles),
      url: w.url || "",
      publishTime: newPubTime,
      ...pickStats(w),
      baselineStats: pickStats(w),
      closedStats: null,
      closedAt: null,
      firstSeenAt: now,
      updatedAt: now,
    };
    data.works.push(row);
    byId.set(row.workId, row);
  }

  // 展示按发布时间倒序
  data.works.sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0));
  writeWorks(group, platform, data);
  recordWorksDaily(group, platform, sorted, now);
  return data;
}

/* ---------------- works-daily（作品日快照，按天分文件） ---------------- */

const WORKS_DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WORKS_DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const WORKS_DAILY_RENAME_MAX_RETRIES = 3;
const WORKS_DAILY_RENAME_RETRY_DELAY_MS = 50;

const SLEEP_VIEW =
  typeof SharedArrayBuffer === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;

function sleepMs(ms) {
  if (!SLEEP_VIEW || !ms || ms <= 0) return;
  try {
    Atomics.wait(SLEEP_VIEW, 0, 0, ms);
  } catch (_) {}
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function worksDailyDir(group, platform) {
  return path.join(accountDir(group, platform), "works-daily");
}

function legacyWorksDailyFile(group, platform) {
  return path.join(accountDir(group, platform), "works-daily.json");
}

function pickWorkDailyStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) {
    out[k] = normalizeMetric(w[k]);
  }
  return out;
}

function writeAllSync(fd, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      const err = new Error("短写入：未能写入字节");
      err.code = "EIO";
      throw err;
    }
    offset += written;
  }
}

function renameWithRetrySync(src, dest, beforeRename) {
  for (let attempt = 0; attempt <= WORKS_DAILY_RENAME_MAX_RETRIES; attempt++) {
    // 每次替换前校验（如跨零点）：校验失败抛错，由调用方清理临时文件、保留旧文件
    if (beforeRename) beforeRename();
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const retryable = err && (err.code === "EPERM" || err.code === "EBUSY");
      if (!retryable || attempt === WORKS_DAILY_RENAME_MAX_RETRIES) {
        throw err;
      }
      sleepMs(WORKS_DAILY_RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * 原子写入单日文件：同目录唯一临时文件 → writeSync 全量 → fsync → renameSync 覆盖。
 * 任何步骤失败都删除临时文件并保留旧文件完整。
 */
function writeWorksDailyAtomic(file, payload, beforeRename) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  const rand = crypto.randomBytes(6).toString("hex");
  const tmpFile = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${rand}.tmp`);
  let fd = null;
  let tmpCreated = false;
  try {
    fd = fs.openSync(tmpFile, "wx");
    tmpCreated = true;
    writeAllSync(fd, buf);
    fs.fsyncSync(fd);
    const closeFd = fd;
    fd = null;
    fs.closeSync(closeFd);
    renameWithRetrySync(tmpFile, file, beforeRename);
    tmpCreated = false;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    if (tmpCreated) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
    throw err;
  }
}

/**
 * 解析单日快照文件，返回无原型 works 字典。
 * 不存在返回 null；JSON 损坏或结构无效告警并返回 null；读 I/O 错误上抛由调用方处理。
 */
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

/** 兼容读取旧版单文件 works-daily.json 作为补充来源（不删除、不迁移写入） */
function mergeLegacyWorksDaily(result, group, platform) {
  const file = legacyWorksDailyFile(group, platform);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    console.warn(`[dataStats] 读取旧 works-daily.json 失败 (${file}):`, (err && err.message) || err);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] 旧 works-daily.json JSON 损坏，已跳过 (${file}):`, (err && err.message) || err);
    return;
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[dataStats] 旧 works-daily.json 结构无效，已跳过 (${file})`);
    return;
  }
  for (const workId of Object.keys(parsed)) {
    const desc = Object.getOwnPropertyDescriptor(parsed, workId);
    const dateMap = desc ? desc.value : null;
    if (!isPlainObject(dateMap)) continue;
    for (const date of Object.keys(dateMap)) {
      if (!WORKS_DAILY_DATE_RE.test(date)) continue;
      const snapDesc = Object.getOwnPropertyDescriptor(dateMap, date);
      if (!snapDesc || !isPlainObject(snapDesc.value)) continue;
      if (!result[workId]) result[workId] = {};
      result[workId][date] = pickWorkDailyStats(snapDesc.value);
    }
  }
}

/**
 * 读取作品日快照，返回无原型字典 `{ workId: { "YYYY-MM-DD": stats } }`。
 * 遍历 works-daily/ 下 YYYY-MM-DD.json（以文件名日期为准），单文件损坏/读失败 warn 并跳过；
 * 若存在旧单文件 works-daily.json，作为补充来源合并（目录文件优先）。
 */
function readWorksDaily(group, platform) {
  const result = Object.create(null);
  mergeLegacyWorksDaily(result, group, platform);

  const dir = worksDailyDir(group, platform);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return result;
    console.warn(`[dataStats] 读取 works-daily 目录失败 (${dir}):`, (err && err.message) || err);
    return result;
  }

  entries.sort();
  for (const name of entries) {
    const match = WORKS_DAILY_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    const file = path.join(dir, name);
    let dayWorks;
    try {
      dayWorks = parseDayWorksFile(file);
    } catch (err) {
      console.warn(`[dataStats] 读取作品日快照失败，已跳过 (${file}):`, (err && err.message) || err);
      continue;
    }
    if (!dayWorks) continue;
    for (const workId of Object.keys(dayWorks)) {
      if (!result[workId]) result[workId] = {};
      result[workId][date] = dayWorks[workId];
    }
  }
  return result;
}

/**
 * 仅读取截至 cutoffDate 的每个作品最新一条快照（跳过 > cutoffDate 的日文件，内存保持 O(作品数)）。
 * 与 readWorksDaily 保持同一口径：目录文件优先于旧单文件 works-daily.json。
 * 返回 `{ worksDaily: { [workId]: { [bestDate]: stats } }, latestDate }`。
 */
function readWorksDailyLatestAsOf(group, platform, cutoffDate = "") {
  const dir = worksDailyDir(group, platform);
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
      if (!isValidAutoRunDate(date)) continue;
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
  const legacyFile = legacyWorksDailyFile(group, platform);
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
          if (!isValidAutoRunDate(d)) continue;
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

/**
 * 写入作品当日累计快照（UTC+8，只读写当天 YYYY-MM-DD.json，不加锁、不写非当天文件）。
 * 读当天文件（不存在/损坏视为空，损坏时 warn）→ 按 workId 合并 → 原子写；失败仅 warn，不影响 mergeWorks。
 */
function recordWorksDaily(group, platform, works, now = Date.now()) {
  if (!works || !works.length) return;
  const validWorks = [];
  for (const w of works) {
    if (w && w.workId) validWorks.push(w);
  }
  if (!validWorks.length) return;

  const today = todayStr(now);
  const file = path.join(worksDailyDir(group, platform), `${today}.json`);
  // 跨零点保护：写入耗时内若 UTC+8 日期已变，放弃替换，绝不改写已成为「昨天」的文件。
  // 用「注入的 now + 实际流逝时间」推算当前时刻，兼容测试注入时间。
  const startedReal = Date.now();
  const ensureSameDay = () => {
    if (todayStr(now + (Date.now() - startedReal)) !== today) {
      const err = new Error(`写入跨过零点，放弃改写 ${today} 的快照`);
      err.code = "EDAYROLL";
      throw err;
    }
  };
  try {
    const dayWorks = parseDayWorksFile(file) || Object.create(null);
    for (const w of validWorks) {
      dayWorks[String(w.workId)] = pickWorkDailyStats(w);
    }
    writeWorksDailyAtomic(file, {
      date: today,
      updatedAt: now,
      works: dayWorks,
    }, ensureSameDay);
  } catch (err) {
    console.warn(
      `[dataStats] 写入 works-daily/${today}.json 失败 (${group}/${platform}):`,
      (err && err.message) || err
    );
  }
}

/* ---------------- meta ---------------- */

function writeMeta(group, platform, patch) {
  const file = path.join(accountDir(group, platform), "meta.json");
  const meta = readJson(file, {});
  writeJson(file, { ...meta, ...patch });
}

/* ---------------- 采集日志 ---------------- */

const MAX_COLLECT_LOGS = 100;

function collectLogFile() {
  return path.join(baseDir(), "collect-logs.json");
}

/** 追加一次采集任务记录（新记录在前，最多保留 100 次） */
function appendCollectLog(taskLog) {
  const logs = readJson(collectLogFile(), []);
  logs.unshift(taskLog);
  writeJson(collectLogFile(), logs.slice(0, MAX_COLLECT_LOGS));
}

function readCollectLogs() {
  return readJson(collectLogFile(), []);
}

/* ---------------- auto-run（每日自动采集运行记录） ---------------- */

const MAX_AUTO_RUN_DATES = 14;

function autoRunFile() {
  return path.join(baseDir(), "auto-run.json");
}

function isValidAutoRunDate(str) {
  if (typeof str !== "string" || !WORKS_DAILY_DATE_RE.test(str)) return false;
  const [year, month, day] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function normalizeAutoRuns(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!isValidAutoRunDate(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out.slice(-MAX_AUTO_RUN_DATES);
}

/**
 * 读取 <userData>/data-stats/auto-run.json 中的已运行日期列表。
 * 不存在返回 []；JSON 损坏或结构无效告警并返回 []；读 I/O 错误上抛由调用方处理。
 */
function readAutoRuns() {
  const file = autoRunFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] auto-run.json JSON 损坏 (${file}):`, (err && err.message) || err);
    return [];
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.runs)) {
    console.warn(`[dataStats] auto-run.json 结构无效 (${file})`);
    return [];
  }
  return normalizeAutoRuns(parsed.runs);
}

/**
 * 追加运行日期到 <userData>/data-stats/auto-run.json（复用 S1 同款原子写，仅保留最近 14 个日期）。
 * 写入失败直接抛错，保留旧文件完整。
 */
function appendAutoRun(date) {
  if (!isValidAutoRunDate(date)) {
    throw new Error(`非法自动采集日期: ${date}`);
  }
  const runs = readAutoRuns();
  const normalized = normalizeAutoRuns([...runs, date]);
  writeWorksDailyAtomic(autoRunFile(), { runs: normalized });
  return normalized;
}

/* ---------------- link-overrides（跨平台关联手工矫正） ---------------- */

const LINK_OVERRIDES_VERSION = 1;

function linkOverridesFile() {
  return path.join(baseDir(), "link-overrides.json");
}

function emptyLinkOverrides() {
  return {
    version: LINK_OVERRIDES_VERSION,
    updatedAt: 0,
    contents: Object.create(null),
    excludedAuto: Object.create(null),
    overrides: Object.create(null),
  };
}

function isSyntheticContentKey(key) {
  return (
    typeof key === "string" &&
    ((key.startsWith("auto:") && key.length > "auto:".length) ||
      (key.startsWith("manual:") && key.length > "manual:".length))
  );
}

/** 校验作品身份键 `platform|workId`（恰含一个 `|` 且平台与作品 ID 均非空） */
function isValidWorkIdentityKey(key) {
  if (typeof key !== "string" || !key) return false;
  const sep = key.indexOf("|");
  if (sep <= 0 || sep >= key.length - 1) return false;
  return key.indexOf("|", sep + 1) === -1;
}

function normalizeLinkContentEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.title !== "string") return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  return {
    title: entry.title,
    createdAt: entry.createdAt,
  };
}

function normalizeLinkContentsMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const contentKey of Object.keys(rawMap)) {
    if (!isSyntheticContentKey(contentKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, contentKey);
    const normalized = normalizeLinkContentEntry(desc ? desc.value : null);
    if (normalized) {
      out[contentKey] = normalized;
    }
  }
  return out;
}

function normalizeExcludedAutoMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const pwKey of Object.keys(rawMap)) {
    if (!isValidWorkIdentityKey(pwKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, pwKey);
    if (desc && desc.value === true) {
      out[pwKey] = true;
    }
  }
  return out;
}

function normalizeLinkOverrideEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.action !== "string") return null;
  const action = entry.action;
  if (action === "detach") {
    return { action: "detach" };
  }
  if (action === "assign") {
    if (typeof entry.contentKey !== "string") return null;
    const contentKey = entry.contentKey.trim();
    if (!contentKey || contentKey.startsWith("unlinked:")) return null;
    return { action: "assign", contentKey };
  }
  return null;
}

function normalizeLinkOverridesMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const pwKey of Object.keys(rawMap)) {
    if (!isValidWorkIdentityKey(pwKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, pwKey);
    const normalized = normalizeLinkOverrideEntry(desc ? desc.value : null);
    if (normalized) {
      out[pwKey] = normalized;
    }
  }
  return out;
}

function syncExcludedAutoFromOverrides(excludedAuto, overrides, rawOverrides) {
  for (const pwKey of Object.keys(overrides)) {
    if (overrides[pwKey].action === "detach") {
      excludedAuto[pwKey] = true;
    } else if (isPlainObject(rawOverrides)) {
      const desc = Object.getOwnPropertyDescriptor(rawOverrides, pwKey);
      if (desc && isPlainObject(desc.value) && desc.value.excludeAuto === true) {
        excludedAuto[pwKey] = true;
      }
    }
  }
  return excludedAuto;
}

/**
 * 读取 <userData>/data-stats/link-overrides.json。
 * 不存在静默返回空；严格校验 version === 1、updatedAt 为有限数字、overrides/contents/excludedAuto 结构；
 * 条目结构不对的逐条丢弃；任何读取/解析/校验异常均 console.warn 并视为空配置，绝不抛错。
 */
function readLinkOverrides() {
  const file = linkOverridesFile();
  try {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return emptyLinkOverrides();
      console.warn(`[dataStats] 读取 link-overrides.json 失败 (${file}):`, (err && err.message) || err);
      return emptyLinkOverrides();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(`[dataStats] link-overrides.json JSON 损坏 (${file}):`, (err && err.message) || err);
      return emptyLinkOverrides();
    }
    if (!isPlainObject(parsed)) {
      console.warn(`[dataStats] link-overrides.json 结构无效 (${file})`);
      return emptyLinkOverrides();
    }
    if (parsed.version !== LINK_OVERRIDES_VERSION) {
      console.warn(
        `[dataStats] link-overrides.json version 无效（需 === ${LINK_OVERRIDES_VERSION}）(${file})`
      );
      return emptyLinkOverrides();
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      console.warn(`[dataStats] link-overrides.json updatedAt 无效（需有限数字）(${file})`);
      return emptyLinkOverrides();
    }
    if (!isPlainObject(parsed.overrides)) {
      console.warn(`[dataStats] link-overrides.json overrides 结构无效 (${file})`);
      return emptyLinkOverrides();
    }
    const hasContents =
      Object.prototype.hasOwnProperty.call(parsed, "contents") && parsed.contents !== undefined;
    if (hasContents && !isPlainObject(parsed.contents)) {
      console.warn(`[dataStats] link-overrides.json contents 结构无效 (${file})`);
      return emptyLinkOverrides();
    }
    const hasExcludedAuto =
      Object.prototype.hasOwnProperty.call(parsed, "excludedAuto") &&
      parsed.excludedAuto !== undefined;
    if (hasExcludedAuto && !isPlainObject(parsed.excludedAuto)) {
      console.warn(`[dataStats] link-overrides.json excludedAuto 结构无效 (${file})`);
      return emptyLinkOverrides();
    }
    const overrides = normalizeLinkOverridesMap(parsed.overrides);
    const excludedAuto = syncExcludedAutoFromOverrides(
      hasExcludedAuto ? normalizeExcludedAutoMap(parsed.excludedAuto) : Object.create(null),
      overrides,
      parsed.overrides
    );
    return {
      version: LINK_OVERRIDES_VERSION,
      updatedAt: parsed.updatedAt,
      contents: hasContents ? normalizeLinkContentsMap(parsed.contents) : Object.create(null),
      excludedAuto,
      overrides,
    };
  } catch (err) {
    console.warn(`[dataStats] 解析 link-overrides.json 异常 (${file}):`, (err && err.message) || err);
    return emptyLinkOverrides();
  }
}

/** 原子写入 <userData>/data-stats/link-overrides.json（复用 tmp + fsync + rename） */
function writeLinkOverrides(docOrMap, now = Date.now()) {
  const isDoc = isPlainObject(docOrMap) && isPlainObject(docOrMap.overrides);
  const rawMap = isDoc ? docOrMap.overrides : docOrMap;
  const rawContents = isDoc && isPlainObject(docOrMap.contents) ? docOrMap.contents : null;
  const rawExcludedAuto =
    isDoc && isPlainObject(docOrMap.excludedAuto) ? docOrMap.excludedAuto : null;
  const overrides = normalizeLinkOverridesMap(rawMap);
  const contents = normalizeLinkContentsMap(rawContents);
  const excludedAuto = syncExcludedAutoFromOverrides(
    normalizeExcludedAutoMap(rawExcludedAuto),
    overrides,
    rawMap
  );
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const payload = {
    version: LINK_OVERRIDES_VERSION,
    updatedAt: ts,
    contents,
    excludedAuto,
    overrides,
  };
  writeWorksDailyAtomic(linkOverridesFile(), payload);
  return payload;
}

function setLinkOverride(workKey, entry, now = Date.now(), contentMeta) {
  if (!isValidWorkIdentityKey(workKey)) {
    throw new Error("workKey 必须为有效的作品身份 platform|workId");
  }
  const normalized = normalizeLinkOverrideEntry(entry);
  if (!normalized) {
    throw new Error("无效的手动关联操作（需为 assign+contentKey 或 detach）");
  }
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const current = readLinkOverrides();
  if (normalized.action === "detach" || (entry && entry.excludeAuto === true)) {
    current.excludedAuto[workKey] = true;
  }
  current.overrides[workKey] = normalized;
  if (
    normalized.action === "assign" &&
    isSyntheticContentKey(normalized.contentKey) &&
    contentMeta &&
    !current.contents[normalized.contentKey]
  ) {
    const normMeta = normalizeLinkContentEntry({
      title: typeof contentMeta.title === "string" ? contentMeta.title : "",
      createdAt:
        typeof contentMeta.createdAt === "number" && Number.isFinite(contentMeta.createdAt)
          ? contentMeta.createdAt
          : ts,
    });
    if (normMeta) {
      current.contents[normalized.contentKey] = normMeta;
    }
  }
  return writeLinkOverrides(current, ts);
}

function clearLinkOverride(workKey, now = Date.now()) {
  if (!isValidWorkIdentityKey(workKey)) {
    throw new Error("workKey 必须为有效的作品身份 platform|workId");
  }
  const current = readLinkOverrides();
  delete current.overrides[workKey];
  delete current.excludedAuto[workKey];
  return writeLinkOverrides(current, now);
}

function mergeWorksOverride(workKeys, now = Date.now(), title = "") {
  if (!Array.isArray(workKeys)) {
    throw new Error("workKeys 必须为数组");
  }
  const uniqueKeys = [];
  const seen = new Set();
  for (const k of workKeys) {
    if (!isValidWorkIdentityKey(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueKeys.push(k);
  }
  if (uniqueKeys.length < 2) {
    throw new Error("至少需要选择 2 条作品才能合并");
  }
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const current = readLinkOverrides();
  const contentKey = `manual:${crypto.randomBytes(8).toString("hex")}`;
  current.contents[contentKey] = {
    title: typeof title === "string" ? title : "",
    createdAt: ts,
  };
  for (const k of uniqueKeys) {
    current.overrides[k] = { action: "assign", contentKey };
  }
  const doc = writeLinkOverrides(current, ts);
  return { contentKey, workKeys: uniqueKeys, doc };
}

/* ---------------- 读取与聚合 ---------------- */

/** 单账号完整数据（平台页用） */
function readAccount(group, platform) {
  return {
    group,
    platform,
    daily: readDaily(group, platform),
    works: readWorks(group, platform).works,
    meta: readJson(path.join(accountDir(group, platform), "meta.json"), {}),
  };
}

/** 列出已采集的账号 */
function listAccounts() {
  const out = [];
  const root = baseDir();
  if (!fs.existsSync(root)) return out;
  for (const group of fs.readdirSync(root)) {
    const gDir = path.join(root, group);
    if (!fs.statSync(gDir).isDirectory()) continue;
    for (const platform of fs.readdirSync(gDir)) {
      const pDir = path.join(gDir, platform);
      if (!fs.statSync(pDir).isDirectory()) continue;
      out.push({
        group,
        platform,
        meta: readJson(path.join(pDir, "meta.json"), {}),
      });
    }
  }
  return out;
}

/** 全账号按日聚合（所有账号总览页用）；accounts 附最新快照供平台分布/分组表使用 */
function readOverview() {
  const merged = {};
  const accounts = listAccounts().map((acc) => {
    const daily = readDaily(acc.group, acc.platform);
    const dates = Object.keys(daily).sort();
    const latest = dates.length ? daily[dates[dates.length - 1]] : null;
    for (const [date, snap] of Object.entries(daily)) {
      if (!merged[date]) {
        merged[date] = { fans: 0, plays: 0, likes: 0, comments: 0, favorites: 0, shares: 0 };
      }
      for (const k of METRIC_KEYS) {
        merged[date][k] += Number(snap[k]) || 0;
      }
    }
    return { ...acc, latest };
  });
  return { daily: merged, accounts };
}

module.exports = {
  METRIC_KEYS,
  WORK_STAT_KEYS,
  mergeDaily,
  mergeWorks,
  readDaily,
  readWorks,
  readWorksDaily,
  readWorksDailyLatestAsOf,
  readAccount,
  readOverview,
  listAccounts,
  writeMeta,
  appendCollectLog,
  readCollectLogs,
  MAX_AUTO_RUN_DATES,
  readAutoRuns,
  appendAutoRun,
  LINK_OVERRIDES_VERSION,
  readLinkOverrides,
  writeLinkOverrides,
  setLinkOverride,
  clearLinkOverride,
  mergeWorksOverride,
  todayStr,
};
