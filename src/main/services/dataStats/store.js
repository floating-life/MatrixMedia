"use strict";

/**
 * 数据统计本地存储（userData/data-stats/<分组>/<平台>/）：
 *   daily.json       每日总量快照 { "YYYY-MM-DD": { fans, plays, likes, comments, favorites, shares } }
 *   works.json       作品列表 + 发布增长封闭记录
 *   works-daily.json 作品每日累计值快照 { "<workId>": { "YYYY-MM-DD": { play, like, comment, share, favorite, fansDelta } } }
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

function readWorks(group, platform) {
  return readJson(path.join(accountDir(group, platform), "works.json"), {
    works: [],
  });
}

function writeWorks(group, platform, data) {
  writeJson(path.join(accountDir(group, platform), "works.json"), data);
}

function pickStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) out[k] = w[k] == null ? null : w[k];
  return out;
}

/**
 * 合并作品列表，实现「发布增长」口径：
 * - 新出现的作品：登记基线（首次见到时的值），并封闭「比它早且尚未封闭」的最近一条
 * - 已有作品：更新当前累计值
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
    .sort((a, b) => (a.publishTime || 0) - (b.publishTime || 0));

  for (const w of sorted) {
    const existing = byId.get(w.workId);
    if (existing) {
      Object.assign(existing, pickStats(w), { updatedAt: now });
      if (w.title) existing.title = w.title;
      if (w.url) existing.url = w.url;
      continue;
    }
    // 新作品：封闭比它早的最近一条未封闭作品（仅非首次导入时）
    if (!isFirstImport) {
      const earlier = data.works
        .filter((x) => !x.closedStats && (x.publishTime || 0) < (w.publishTime || 0))
        .sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0))[0];
      if (earlier) {
        earlier.closedStats = pickStats(earlier);
        earlier.closedAt = now;
      }
    }
    const row = {
      workId: w.workId,
      title: w.title || "(无标题)",
      url: w.url || "",
      publishTime: w.publishTime || 0,
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

/* ---------------- works-daily（作品日快照） ---------------- */

const WORKS_DAILY_LOCK_TIMEOUT_MS = 5000;
const WORKS_DAILY_LOCK_STALE_MS = 30000;
const WORKS_DAILY_LOCK_RETRY_MS = 25;
const WORKS_DAILY_RENAME_MAX_RETRIES = 3;
const WORKS_DAILY_RENAME_RETRY_DELAY_MS = 50;

const SLEEP_VIEW =
  typeof SharedArrayBuffer === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  if (SLEEP_VIEW) {
    try {
      Atomics.wait(SLEEP_VIEW, 0, 0, ms);
      return;
    } catch (_) {
      // 环境不支持 Atomics.wait 时退回短忙等
    }
  }
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait fallback
  }
}

function worksDailyFile(group, platform) {
  return path.join(accountDir(group, platform), "works-daily.json");
}

function toNullProtoDict(obj) {
  const dict = Object.create(null);
  for (const key of Object.keys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc) dict[key] = desc.value;
  }
  return dict;
}

/**
 * 读取作品日快照。
 * 仅 ENOENT 返回空无原型字典；EIO / JSON 损坏 / 根结构非对象一律抛错，避免误把异常当空库覆写历史。
 */
function readWorksDaily(group, platform) {
  const file = worksDailyFile(group, platform);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return Object.create(null);
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const err = new Error("works-daily.json 根结构必须为对象");
    err.code = "EINVALID_WORKS_DAILY";
    throw err;
  }
  return toNullProtoDict(parsed);
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

function renameWithRetrySync(src, dest) {
  for (let attempt = 0; attempt <= WORKS_DAILY_RENAME_MAX_RETRIES; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const retryable = err && (err.code === "EPERM" || err.code === "EBUSY");
      if (!retryable || attempt === WORKS_DAILY_RENAME_MAX_RETRIES) {
        throw err;
      }
      sleepSync(WORKS_DAILY_RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * 原子写入 works-daily.json：同目录唯一临时文件 → 写全 → fsync → renameSync 覆盖。
 * 任何步骤失败都删除临时文件并保留旧文件完整。
 */
function writeWorksDailyAtomic(file, daily) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const buf = Buffer.from(JSON.stringify(daily, null, 2), "utf8");
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
    fs.closeSync(fd);
    fd = null;
    renameWithRetrySync(tmpFile, file);
    tmpCreated = false;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
      fd = null;
    }
    if (tmpCreated) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
    throw err;
  }
}

function tryCreateLock(lockFile, token) {
  const fd = fs.openSync(lockFile, "wx");
  let closed = false;
  try {
    const payload = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      token,
    });
    writeAllSync(fd, Buffer.from(payload, "utf8"));
    fs.closeSync(fd);
    closed = true;
  } catch (err) {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    try {
      fs.unlinkSync(lockFile);
    } catch (_) {}
    throw err;
  }
}

function isLockStale(lockFile, nowMs, staleMs = WORKS_DAILY_LOCK_STALE_MS) {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch (_) {
    return false;
  }
  if (nowMs - stat.mtimeMs > staleMs) {
    return true;
  }
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    if (raw) {
      const info = JSON.parse(raw);
      const ts = info && (info.createdAt ?? info.time ?? info.timestamp);
      if (typeof ts === "number" && Number.isFinite(ts) && nowMs - ts > staleMs) {
        return true;
      }
    }
  } catch (_) {
    // 锁文件可能正在写入中或非 JSON，以 mtime 为准
  }
  return false;
}

function tryPreemptStaleLock(lockFile, token, staleMs) {
  const reapLock = `${lockFile}.reap`;
  let reapFd = null;
  try {
    reapFd = fs.openSync(reapLock, "wx");
    fs.closeSync(reapFd);
    reapFd = null;
  } catch (err) {
    if (reapFd !== null) {
      try {
        fs.closeSync(reapFd);
      } catch (_) {}
    }
    if (err && err.code === "EEXIST") {
      try {
        const st = fs.statSync(reapLock);
        if (Date.now() - st.mtimeMs > staleMs) {
          fs.unlinkSync(reapLock);
        }
      } catch (_) {}
      return false;
    }
    throw err;
  }

  try {
    if (!isLockStale(lockFile, Date.now(), staleMs)) {
      return false;
    }
    try {
      fs.unlinkSync(lockFile);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        throw err;
      }
    }
    try {
      tryCreateLock(lockFile, token);
      return true;
    } catch (err) {
      if (err && err.code === "EEXIST") {
        return false;
      }
      throw err;
    }
  } finally {
    try {
      fs.unlinkSync(reapLock);
    } catch (_) {}
  }
}

function acquireWorksDailyLock(lockFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? WORKS_DAILY_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? WORKS_DAILY_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? WORKS_DAILY_LOCK_RETRY_MS;
  const token = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      tryCreateLock(lockFile, token);
      return { lockFile, token, acquiredAt: Date.now(), staleMs };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
    }

    if (isLockStale(lockFile, Date.now(), staleMs)) {
      if (tryPreemptStaleLock(lockFile, token, staleMs)) {
        return { lockFile, token, acquiredAt: Date.now(), staleMs };
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const err = new Error(`获取 works-daily.json 锁超时 (${timeoutMs}ms): ${lockFile}`);
      err.code = "ELOCK_TIMEOUT";
      throw err;
    }
    sleepSync(Math.min(retryMs, remaining));
  }
}

function releaseWorksDailyLock(lock) {
  if (!lock) return;
  let shouldUnlink = false;
  try {
    const raw = fs.readFileSync(lock.lockFile, "utf8");
    const info = JSON.parse(raw);
    shouldUnlink = Boolean(info && info.token === lock.token);
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    // 自身持锁未超陈旧阈值时，遇临时读失败仍清理自建锁，避免残留死锁
    shouldUnlink = Date.now() - lock.acquiredAt < lock.staleMs;
  }
  if (!shouldUnlink) return;
  try {
    fs.unlinkSync(lock.lockFile);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 释放 works-daily.json 锁失败 (${lock.lockFile}):`,
        (err && err.message) || err
      );
    }
  }
}

function backupCorruptWorksDaily(file) {
  const backupFile = path.join(
    path.dirname(file),
    `works-daily.corrupt-${Date.now()}.json`
  );
  try {
    fs.copyFileSync(file, backupFile);
    console.warn(`[dataStats] 检测到损坏的 works-daily.json，已备份至 ${backupFile}`);
    return backupFile;
  } catch (err) {
    console.warn(
      `[dataStats] 备份损坏的 works-daily.json 失败 (${backupFile}):`,
      (err && err.message) || err
    );
    return null;
  }
}

function pickWorkDailyStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) {
    out[k] = normalizeMetric(w[k]);
  }
  return out;
}

/**
 * 写入作品当日累计快照（日期按 UTC+8；同日多次采集覆盖为最后一次）。
 * 跨进程持锁 → 锁内重读 → 合并 → 原子写；读/写/锁失败仅告警跳过，不得影响主流程（mergeWorks）。
 */
function recordWorksDaily(group, platform, works, now = Date.now()) {
  if (!works || !works.length) return;
  const validWorks = [];
  for (const w of works) {
    if (w && w.workId) validWorks.push(w);
  }
  if (!validWorks.length) return;

  const file = worksDailyFile(group, platform);
  const lockFile = `${file}.lock`;
  let lock = null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lock = acquireWorksDailyLock(lockFile);

    let daily;
    try {
      daily = readWorksDaily(group, platform);
    } catch (readErr) {
      if (readErr instanceof SyntaxError) {
        backupCorruptWorksDaily(file);
      }
      throw readErr;
    }

    const today = todayStr(now);
    for (const w of validWorks) {
      const id = String(w.workId);
      const existingDates = daily[id];
      if (
        !Object.prototype.hasOwnProperty.call(daily, id) ||
        !existingDates ||
        typeof existingDates !== "object" ||
        Array.isArray(existingDates)
      ) {
        daily[id] = {};
      }
      daily[id][today] = pickWorkDailyStats(w);
    }

    writeWorksDailyAtomic(file, daily);
  } catch (err) {
    console.warn(
      `[dataStats] 写入 works-daily.json 失败 (${group}/${platform}):`,
      (err && err.message) || err
    );
  } finally {
    releaseWorksDailyLock(lock);
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
  readAccount,
  readOverview,
  listAccounts,
  writeMeta,
  appendCollectLog,
  readCollectLogs,
  todayStr,
};
