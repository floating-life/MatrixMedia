"use strict";

/**
 * 分组改名时的统计目录迁移与合并模块（不强依赖 electron，支持直接传入 baseDir 单测）。
 *
 * 将 data-stats/<旧分组>/<平台> 合并进 data-stats/<新分组>/<平台>，同时更新 group-settings.json 的键名，
 * 并将旧目录移入与 data-stats 同级的 data-stats-merged-old/ 备份（绝不物理删除）。
 *
 * 严格两阶段执行：
 * 1. 阶段一（只读校验与内存合并）：完整读取并解析所有旧/新目录文件与 group-settings.json；
 *    任何读 I/O 错误、JSON 损坏或结构异常立即报错中止，绝不写入任何文件。
 * 2. 阶段二（原子写盘与备份移走）：所有合并结果原子写盘后，将旧分组目录移入 data-stats-merged-old/。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const FORBIDDEN_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 50;

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

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function safeOwnGet(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc ? desc.value : undefined;
}

function safeSeg(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g, "_");
}

function isValidYmd(str) {
  if (typeof str !== "string" || !DATE_STR_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  if (y < 1970 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

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

function maxPositiveMetric(...vals) {
  let max = 0;
  for (const raw of vals) {
    const v = normalizeMetric(raw);
    if (v !== null && v > max) max = v;
  }
  return max;
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
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const retryable = err && (err.code === "EPERM" || err.code === "EBUSY");
      if (!retryable || attempt === RENAME_MAX_RETRIES) {
        throw err;
      }
      sleepMs(RENAME_RETRY_DELAY_MS);
    }
  }
}

function writeBufferAtomic(file, buf) {
  const dir = path.dirname(file);
  const base = path.basename(file);
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
    renameWithRetrySync(tmpFile, file);
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

function writeJsonAtomic(file, payload) {
  const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  writeBufferAtomic(file, buf);
}

function readJsonStrict(file, validator, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { exists: false, data: null };
    }
    const wrapped = new Error(`读取 ${label} 失败 (${file}): ${(err && err.message) || err}`);
    wrapped.code = (err && err.code) || "STATS_MIGRATION_READ_ERROR";
    wrapped.cause = err;
    throw wrapped;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`${label} JSON 损坏 (${file}): ${(err && err.message) || err}`);
    wrapped.code = "STATS_MIGRATION_PARSE_ERROR";
    wrapped.cause = err;
    throw wrapped;
  }
  if (typeof validator === "function" && !validator(parsed)) {
    const wrapped = new Error(`${label} 结构无效 (${file})`);
    wrapped.code = "STATS_MIGRATION_INVALID_SCHEMA";
    throw wrapped;
  }
  return { exists: true, data: parsed };
}

function readDirEntriesStrict(dir, label) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    const wrapped = new Error(`读取 ${label} 目录失败 (${dir}): ${(err && err.message) || err}`);
    wrapped.code = (err && err.code) || "STATS_MIGRATION_READ_ERROR";
    wrapped.cause = err;
    throw wrapped;
  }
}

function cloneWork(w) {
  if (!isPlainObject(w)) return w;
  const copy = { ...w };
  if (isPlainObject(w.baselineStats)) copy.baselineStats = { ...w.baselineStats };
  if (isPlainObject(w.closedStats)) copy.closedStats = { ...w.closedStats };
  copy.altTitles = normalizeAltTitles(w.altTitles);
  return copy;
}

/**
 * 合并 works.json：
 * - 以旧为底保留 baselineStats / firstSeenAt / closed*
 * - 新记录更新当前指标 / 标题 / 链接 / publishTime / updatedAt
 * - lastPositivePlay 取大
 * - altTitles 取并集
 * - 仅新有的作品加入
 */
function mergeWorksJsonDocs(oldDoc, newDoc) {
  const oldWorks = Array.isArray(oldDoc && oldDoc.works) ? oldDoc.works : [];
  const newWorks = Array.isArray(newDoc && newDoc.works) ? newDoc.works : [];
  const byId = new Map();

  for (const ow of oldWorks) {
    if (!isPlainObject(ow) || ow.workId == null || ow.workId === "") continue;
    const wid = String(ow.workId);
    byId.set(wid, cloneWork(ow));
  }

  for (const nw of newWorks) {
    if (!isPlainObject(nw) || nw.workId == null || nw.workId === "") continue;
    const wid = String(nw.workId);
    const ow = byId.get(wid);
    if (!ow) {
      byId.set(wid, cloneWork(nw));
      continue;
    }

    const merged = cloneWork(ow);

    // 保留旧记录的 baselineStats / firstSeenAt / closed*（仅旧缺时才回退取新）
    if (merged.baselineStats == null && isPlainObject(nw.baselineStats)) {
      merged.baselineStats = { ...nw.baselineStats };
    }
    const oldFirst =
      typeof merged.firstSeenAt === "number" && Number.isFinite(merged.firstSeenAt) && merged.firstSeenAt > 0
        ? merged.firstSeenAt
        : null;
    const newFirst =
      typeof nw.firstSeenAt === "number" && Number.isFinite(nw.firstSeenAt) && nw.firstSeenAt > 0
        ? nw.firstSeenAt
        : null;
    if (oldFirst !== null) {
      merged.firstSeenAt = oldFirst;
    } else if (newFirst !== null) {
      merged.firstSeenAt = newFirst;
    }
    for (const k of Object.keys(nw)) {
      if (!k.startsWith("closed")) continue;
      if (merged[k] == null && nw[k] != null) {
        merged[k] = isPlainObject(nw[k]) ? { ...nw[k] } : nw[k];
      }
    }

    // 新记录更新当前指标
    for (const k of WORK_STAT_KEYS) {
      if (hasOwn(nw, k) && nw[k] !== undefined && nw[k] !== null) {
        merged[k] = nw[k];
      } else if (!hasOwn(merged, k) && hasOwn(nw, k)) {
        merged[k] = nw[k];
      }
    }

    // 标题 / 链接 / publishTime / updatedAt
    if (typeof nw.title === "string" && nw.title.trim()) {
      if (nw.title !== "(无标题)" || !merged.title) {
        merged.title = nw.title;
      }
    }
    if (typeof nw.url === "string" && nw.url.trim()) {
      merged.url = nw.url;
    }
    if (typeof nw.publishTime === "number" && Number.isFinite(nw.publishTime) && nw.publishTime > 0) {
      merged.publishTime = nw.publishTime;
    }
    const oldUpd = typeof ow.updatedAt === "number" && Number.isFinite(ow.updatedAt) ? ow.updatedAt : 0;
    const newUpd = typeof nw.updatedAt === "number" && Number.isFinite(nw.updatedAt) ? nw.updatedAt : 0;
    if (newUpd > 0 || oldUpd > 0) {
      merged.updatedAt = Math.max(oldUpd, newUpd);
    }

    // lastPositivePlay 取大
    const maxPos = maxPositiveMetric(ow.lastPositivePlay, nw.lastPositivePlay, ow.play, nw.play);
    if (maxPos > 0) {
      merged.lastPositivePlay = maxPos;
    }

    // altTitles 并集
    merged.altTitles = normalizeAltTitles([
      ...(Array.isArray(ow.altTitles) ? ow.altTitles : []),
      ...(Array.isArray(nw.altTitles) ? nw.altTitles : []),
    ]);

    byId.set(wid, merged);
  }

  const mergedWorks = [...byId.values()].sort((a, b) => {
    const pb = typeof b.publishTime === "number" && Number.isFinite(b.publishTime) ? b.publishTime : 0;
    const pa = typeof a.publishTime === "number" && Number.isFinite(a.publishTime) ? a.publishTime : 0;
    if (pb !== pa) return pb - pa;
    const wa = String(a.workId || "");
    const wb = String(b.workId || "");
    return wa < wb ? -1 : wa > wb ? 1 : 0;
  });

  const baseTop = {};
  if (isPlainObject(oldDoc)) Object.assign(baseTop, oldDoc);
  if (isPlainObject(newDoc)) Object.assign(baseTop, newDoc);
  baseTop.works = mergedWorks;
  return baseTop;
}

/**
 * 合并 works-daily/<date>.json：按作品合并，冲突取 updatedAt 较新者。
 */
function mergeWorksDailyDocs(oldDoc, newDoc, date) {
  if (!oldDoc) return newDoc;
  if (!newDoc) return oldDoc;
  const oldUpd =
    typeof oldDoc.updatedAt === "number" && Number.isFinite(oldDoc.updatedAt) ? oldDoc.updatedAt : 0;
  const newUpd =
    typeof newDoc.updatedAt === "number" && Number.isFinite(newDoc.updatedAt) ? newDoc.updatedAt : 0;
  const first = newUpd >= oldUpd ? oldDoc.works : newDoc.works;
  const second = newUpd >= oldUpd ? newDoc.works : oldDoc.works;

  const works = Object.create(null);
  for (const src of [first, second]) {
    if (!isPlainObject(src)) continue;
    for (const workId of Object.keys(src)) {
      const val = safeOwnGet(src, workId);
      if (isPlainObject(val)) {
        works[workId] = { ...val };
      }
    }
  }
  return {
    date: date || newDoc.date || oldDoc.date,
    updatedAt: Math.max(oldUpd, newUpd),
    works,
  };
}

/**
 * 合并 works-intraday/<date>.json：按时段并集合并，同槽冲突取 collectedAt 较新者。
 */
function mergeWorksIntradayDocs(oldDoc, newDoc, date) {
  if (!oldDoc) return newDoc;
  if (!newDoc) return oldDoc;
  const oldSlots = isPlainObject(oldDoc.slots) ? oldDoc.slots : {};
  const newSlots = isPlainObject(newDoc.slots) ? newDoc.slots : {};
  const allSlotKeys = [...new Set([...Object.keys(oldSlots), ...Object.keys(newSlots)])].sort();
  const slots = Object.create(null);

  for (const slotTime of allSlotKeys) {
    if (!SLOT_TIME_RE.test(slotTime)) continue;
    const os = hasOwn(oldSlots, slotTime) ? safeOwnGet(oldSlots, slotTime) : null;
    const ns = hasOwn(newSlots, slotTime) ? safeOwnGet(newSlots, slotTime) : null;
    const validOs = isPlainObject(os) && isPlainObject(os.works) ? os : null;
    const validNs = isPlainObject(ns) && isPlainObject(ns.works) ? ns : null;
    if (!validOs && !validNs) continue;
    if (!validOs) {
      const w = Object.create(null);
      for (const wid of Object.keys(validNs.works)) {
        const val = safeOwnGet(validNs.works, wid);
        if (isPlainObject(val)) w[wid] = { ...val };
      }
      slots[slotTime] = { collectedAt: validNs.collectedAt ?? null, works: w };
      continue;
    }
    if (!validNs) {
      const w = Object.create(null);
      for (const wid of Object.keys(validOs.works)) {
        const val = safeOwnGet(validOs.works, wid);
        if (isPlainObject(val)) w[wid] = { ...val };
      }
      slots[slotTime] = { collectedAt: validOs.collectedAt ?? null, works: w };
      continue;
    }

    const oldTs =
      typeof validOs.collectedAt === "number" && Number.isFinite(validOs.collectedAt)
        ? validOs.collectedAt
        : 0;
    const newTs =
      typeof validNs.collectedAt === "number" && Number.isFinite(validNs.collectedAt)
        ? validNs.collectedAt
        : 0;
    const winner = newTs >= oldTs ? validNs : validOs;
    const loser = newTs >= oldTs ? validOs : validNs;
    const w = Object.create(null);
    for (const src of [loser.works, winner.works]) {
      for (const wid of Object.keys(src)) {
        const val = safeOwnGet(src, wid);
        if (isPlainObject(val)) w[wid] = { ...val };
      }
    }
    slots[slotTime] = {
      collectedAt: winner.collectedAt ?? loser.collectedAt ?? null,
      works: w,
    };
  }

  return {
    date: date || newDoc.date || oldDoc.date,
    slots,
  };
}

/**
 * 合并 daily.json：按日期并集，冲突取新。
 */
function mergeDailyDocs(oldDaily, newDaily) {
  const o = isPlainObject(oldDaily) ? oldDaily : {};
  const n = isPlainObject(newDaily) ? newDaily : {};
  const dates = [...new Set([...Object.keys(o), ...Object.keys(n)])].sort();
  const merged = Object.create(null);
  for (const d of dates) {
    if (FORBIDDEN_PROTO_KEYS.has(d)) continue;
    const newVal = hasOwn(n, d) ? safeOwnGet(n, d) : undefined;
    const oldVal = hasOwn(o, d) ? safeOwnGet(o, d) : undefined;
    if (isPlainObject(newVal)) {
      merged[d] = { ...newVal };
    } else if (isPlainObject(oldVal)) {
      merged[d] = { ...oldVal };
    }
  }
  return merged;
}

/**
 * 合并 meta.json：取新（按 lastCollectAt 比较；仅单边存在时取该边）。
 * 若两边均有 workCountsByAccount，合并保留各历史账号条目（冲突取 updatedAt 较新者），
 * 避免合桶后丢失历史换号记录。
 */
function mergeMetaDocs(oldMeta, newMeta) {
  const hasOld = isPlainObject(oldMeta) && Object.keys(oldMeta).length > 0;
  const hasNew = isPlainObject(newMeta) && Object.keys(newMeta).length > 0;
  if (!hasOld && !hasNew) return {};
  if (!hasOld) return { ...newMeta };
  if (!hasNew) return { ...oldMeta };
  const oldTs =
    typeof oldMeta.lastCollectAt === "number" && Number.isFinite(oldMeta.lastCollectAt)
      ? oldMeta.lastCollectAt
      : 0;
  const newTs =
    typeof newMeta.lastCollectAt === "number" && Number.isFinite(newMeta.lastCollectAt)
      ? newMeta.lastCollectAt
      : 0;
  const merged = newTs >= oldTs ? { ...newMeta } : { ...oldMeta };
  const oldByAcc = isPlainObject(oldMeta.workCountsByAccount) ? oldMeta.workCountsByAccount : null;
  const newByAcc = isPlainObject(newMeta.workCountsByAccount) ? newMeta.workCountsByAccount : null;
  if (oldByAcc || newByAcc) {
    const combined = {};
    for (const src of [oldByAcc, newByAcc]) {
      if (!src) continue;
      for (const accId of Object.keys(src)) {
        if (FORBIDDEN_PROTO_KEYS.has(accId)) continue;
        const val = safeOwnGet(src, accId);
        if (!isPlainObject(val)) continue;
        const prev = Object.prototype.hasOwnProperty.call(combined, accId) ? combined[accId] : null;
        if (!prev) {
          combined[accId] = { ...val };
        } else {
          const prevUpd =
            typeof prev.updatedAt === "number" && Number.isFinite(prev.updatedAt)
              ? prev.updatedAt
              : 0;
          const nextUpd =
            typeof val.updatedAt === "number" && Number.isFinite(val.updatedAt) ? val.updatedAt : 0;
          combined[accId] = nextUpd >= prevUpd ? { ...val } : prev;
        }
      }
    }
    if (Object.keys(combined).length > 0) {
      merged.workCountsByAccount = combined;
    }
  }
  return merged;
}

function mergeLegacyWorksDailyDocs(oldLegacy, newLegacy) {
  const merged = Object.create(null);
  for (const src of [oldLegacy, newLegacy]) {
    if (!isPlainObject(src)) continue;
    for (const workId of Object.keys(src)) {
      const dateMap = safeOwnGet(src, workId);
      if (!isPlainObject(dateMap)) continue;
      if (!merged[workId]) merged[workId] = Object.create(null);
      for (const d of Object.keys(dateMap)) {
        if (!DATE_STR_RE.test(d)) continue;
        const snap = safeOwnGet(dateMap, d);
        if (isPlainObject(snap)) merged[workId][d] = { ...snap };
      }
    }
  }
  return merged;
}

function formatUtc8BackupSlug(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + 8 * 3600e3)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, "")
    .replace("T", "-");
}

function resolveBackupDir(baseDirPath, oldSafeName, now = Date.now()) {
  const resolvedBase = path.resolve(baseDirPath);
  const backupRoot = path.join(path.dirname(resolvedBase), "data-stats-merged-old");
  const slug = formatUtc8BackupSlug(now);
  const stem = `${oldSafeName}-${slug}`;
  for (let seq = 1; seq <= 999; seq++) {
    const name = seq === 1 ? stem : `${stem}-${seq}`;
    const candidate = path.join(backupRoot, name);
    if (!fs.existsSync(candidate)) {
      return { backupRoot, backupDir: candidate };
    }
  }
  return {
    backupRoot,
    backupDir: path.join(backupRoot, `${stem}-${crypto.randomBytes(4).toString("hex")}`),
  };
}

function moveDirToBackup(srcDir, backupRoot, backupDir) {
  fs.mkdirSync(backupRoot, { recursive: true });
  try {
    renameWithRetrySync(srcDir, backupDir);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      fs.cpSync(srcDir, backupDir, { recursive: true });
      fs.rmSync(srcDir, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * 分组改名迁移主入口。
 *
 * @param {object} params
 * @param {string} params.baseDir   data-stats 根目录
 * @param {string} params.oldGroup  旧分组名
 * @param {string} params.newGroup  新分组名
 * @param {number} [params.now]     时间戳（用于备份目录命名）
 */
function renameStatsGroup({ baseDir, oldGroup, newGroup, now = Date.now() } = {}) {
  const oldName = typeof oldGroup === "string" ? oldGroup.trim() : "";
  const newName = typeof newGroup === "string" ? newGroup.trim() : "";
  if (!oldName || !newName) {
    throw new Error("旧分组名与新分组名不能为空");
  }
  if (
    oldName === "." ||
    oldName === ".." ||
    newName === "." ||
    newName === ".." ||
    FORBIDDEN_PROTO_KEYS.has(oldName) ||
    FORBIDDEN_PROTO_KEYS.has(newName)
  ) {
    throw new Error("分组名包含非法名称");
  }
  if (oldName === newName) {
    throw new Error("新分组名不能与旧分组名相同");
  }
  if (typeof baseDir !== "string" || !baseDir.trim()) {
    throw new Error("baseDir 不能为空");
  }

  const resolvedBase = path.resolve(baseDir);
  const oldSafe = safeSeg(oldName);
  const newSafe = safeSeg(newName);
  if (oldSafe === newSafe) {
    throw new Error("新旧分组对应的目录名冲突，无法迁移");
  }
  const oldGroupDir = path.resolve(resolvedBase, oldSafe);
  const newGroupDir = path.resolve(resolvedBase, newSafe);
  if (path.dirname(oldGroupDir) !== resolvedBase || path.dirname(newGroupDir) !== resolvedBase) {
    throw new Error("非法的分组目录路径");
  }

  /* ---------- 阶段一：严格只读加载与内存合并（失败直接抛错，不写盘） ---------- */

  const plannedWrites = [];
  const mergedPlatforms = [];

  // 1. 严格读取 group-settings.json（若存在）
  const groupSettingsPath = path.join(resolvedBase, "group-settings.json");
  const gsRead = readJsonStrict(groupSettingsPath, isPlainObject, "group-settings.json");
  let groupSettingsRenamed = false;
  if (gsRead.exists) {
    const rawGs = gsRead.data;
    const nextGs = Object.create(null);
    let oldVal = null;
    for (const k of Object.keys(rawGs)) {
      const trimmedKey = typeof k === "string" ? k.trim() : "";
      if (!trimmedKey || FORBIDDEN_PROTO_KEYS.has(trimmedKey)) continue;
      const val = safeOwnGet(rawGs, k);
      let dateStr = "";
      if (typeof val === "string") dateStr = val.trim();
      else if (isPlainObject(val) && typeof val.statsStartDate === "string") {
        dateStr = val.statsStartDate.trim();
      }
      if (!isValidYmd(dateStr)) continue;
      if (trimmedKey === oldName || trimmedKey === oldSafe) {
        oldVal = dateStr;
        groupSettingsRenamed = true;
      } else {
        nextGs[trimmedKey] = dateStr;
      }
    }
    if (groupSettingsRenamed && oldVal) {
      if (!hasOwn(nextGs, newName)) {
        nextGs[newName] = oldVal;
      }
      plannedWrites.push({ file: groupSettingsPath, payload: nextGs });
    }
  }

  // 2. 检查旧分组目录并完整读取所有平台文件
  let hasOldGroupDir = false;
  try {
    const st = fs.statSync(oldGroupDir);
    if (!st.isDirectory()) {
      throw new Error(`旧分组统计路径不是目录：${oldGroupDir}`);
    }
    hasOldGroupDir = true;
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }

  if (hasOldGroupDir) {
    const oldEntries = readDirEntriesStrict(oldGroupDir, `旧分组(${oldName})`);
    const platformDirs = oldEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const pt of platformDirs) {
      const oldPtDir = path.join(oldGroupDir, pt);
      const newPtDir = path.join(newGroupDir, pt);

      // 2a. works.json
      const oldWorksRes = readJsonStrict(
        path.join(oldPtDir, "works.json"),
        (d) => isPlainObject(d) && Array.isArray(d.works),
        `${oldName}/${pt}/works.json`
      );
      const newWorksRes = readJsonStrict(
        path.join(newPtDir, "works.json"),
        (d) => isPlainObject(d) && Array.isArray(d.works),
        `${newName}/${pt}/works.json`
      );
      if (oldWorksRes.exists || newWorksRes.exists) {
        const mergedWorks = mergeWorksJsonDocs(oldWorksRes.data, newWorksRes.data);
        plannedWrites.push({
          file: path.join(newPtDir, "works.json"),
          payload: mergedWorks,
        });
      }

      // 2b. daily.json
      const oldDailyRes = readJsonStrict(
        path.join(oldPtDir, "daily.json"),
        isPlainObject,
        `${oldName}/${pt}/daily.json`
      );
      const newDailyRes = readJsonStrict(
        path.join(newPtDir, "daily.json"),
        isPlainObject,
        `${newName}/${pt}/daily.json`
      );
      if (oldDailyRes.exists || newDailyRes.exists) {
        const mergedDaily = mergeDailyDocs(oldDailyRes.data, newDailyRes.data);
        plannedWrites.push({
          file: path.join(newPtDir, "daily.json"),
          payload: mergedDaily,
        });
      }

      // 2c. meta.json
      const oldMetaRes = readJsonStrict(
        path.join(oldPtDir, "meta.json"),
        isPlainObject,
        `${oldName}/${pt}/meta.json`
      );
      const newMetaRes = readJsonStrict(
        path.join(newPtDir, "meta.json"),
        isPlainObject,
        `${newName}/${pt}/meta.json`
      );
      if (oldMetaRes.exists || newMetaRes.exists) {
        const mergedMeta = mergeMetaDocs(oldMetaRes.data, newMetaRes.data);
        plannedWrites.push({
          file: path.join(newPtDir, "meta.json"),
          payload: mergedMeta,
        });
      }

      // 2d. legacy works-daily.json（如存在一并合并）
      const oldLegacyRes = readJsonStrict(
        path.join(oldPtDir, "works-daily.json"),
        isPlainObject,
        `${oldName}/${pt}/works-daily.json`
      );
      const newLegacyRes = readJsonStrict(
        path.join(newPtDir, "works-daily.json"),
        isPlainObject,
        `${newName}/${pt}/works-daily.json`
      );
      if (oldLegacyRes.exists || newLegacyRes.exists) {
        plannedWrites.push({
          file: path.join(newPtDir, "works-daily.json"),
          payload: mergeLegacyWorksDailyDocs(oldLegacyRes.data, newLegacyRes.data),
        });
      }

      // 2e. works-daily/<date>.json
      const oldWdDir = path.join(oldPtDir, "works-daily");
      const newWdDir = path.join(newPtDir, "works-daily");
      const oldWdEntries = readDirEntriesStrict(oldWdDir, `${oldName}/${pt}/works-daily`);
      const newWdEntries = readDirEntriesStrict(newWdDir, `${newName}/${pt}/works-daily`);
      const wdDates = new Set();
      for (const e of [...oldWdEntries, ...newWdEntries]) {
        const m = DATE_FILE_RE.exec(e.name);
        if (m && isValidYmd(m[1])) wdDates.add(m[1]);
      }
      for (const date of [...wdDates].sort()) {
        const fileName = `${date}.json`;
        const oldDayRes = readJsonStrict(
          path.join(oldWdDir, fileName),
          (d) => isPlainObject(d) && isPlainObject(d.works),
          `${oldName}/${pt}/works-daily/${fileName}`
        );
        const newDayRes = readJsonStrict(
          path.join(newWdDir, fileName),
          (d) => isPlainObject(d) && isPlainObject(d.works),
          `${newName}/${pt}/works-daily/${fileName}`
        );
        if (oldDayRes.exists || newDayRes.exists) {
          plannedWrites.push({
            file: path.join(newWdDir, fileName),
            payload: mergeWorksDailyDocs(oldDayRes.data, newDayRes.data, date),
          });
        }
      }

      // 2f. works-intraday/<date>.json
      const oldWiDir = path.join(oldPtDir, "works-intraday");
      const newWiDir = path.join(newPtDir, "works-intraday");
      const oldWiEntries = readDirEntriesStrict(oldWiDir, `${oldName}/${pt}/works-intraday`);
      const newWiEntries = readDirEntriesStrict(newWiDir, `${newName}/${pt}/works-intraday`);
      const wiDates = new Set();
      for (const e of [...oldWiEntries, ...newWiEntries]) {
        const m = DATE_FILE_RE.exec(e.name);
        if (m && isValidYmd(m[1])) wiDates.add(m[1]);
      }
      for (const date of [...wiDates].sort()) {
        const fileName = `${date}.json`;
        const oldDayRes = readJsonStrict(
          path.join(oldWiDir, fileName),
          (d) => isPlainObject(d) && isPlainObject(d.slots),
          `${oldName}/${pt}/works-intraday/${fileName}`
        );
        const newDayRes = readJsonStrict(
          path.join(newWiDir, fileName),
          (d) => isPlainObject(d) && isPlainObject(d.slots),
          `${newName}/${pt}/works-intraday/${fileName}`
        );
        if (oldDayRes.exists || newDayRes.exists) {
          plannedWrites.push({
            file: path.join(newWiDir, fileName),
            payload: mergeWorksIntradayDocs(oldDayRes.data, newDayRes.data, date),
          });
        }
      }

      mergedPlatforms.push(pt);
    }
  }

  // 3. 记录写前快照（用于账号更新失败时精确回滚，绝不删除迁移前已有的其他文件）
  let hadNewGroupDir = false;
  try {
    const st = fs.statSync(newGroupDir);
    if (!st.isDirectory()) {
      throw new Error(`新分组统计路径不是目录：${newGroupDir}`);
    }
    hadNewGroupDir = true;
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }

  const previousFiles = [];
  const createdDirsSet = new Set();
  for (const item of plannedWrites) {
    let existed = false;
    let raw = null;
    try {
      raw = fs.readFileSync(item.file);
      existed = true;
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        const wrapped = new Error(
          `读取迁移前备份快照失败 (${item.file}): ${(err && err.message) || err}`
        );
        wrapped.code = (err && err.code) || "STATS_MIGRATION_READ_ERROR";
        wrapped.cause = err;
        throw wrapped;
      }
    }
    previousFiles.push({ file: item.file, existed, raw });

    // 收集将在 newGroupDir 下新建的目录，回滚时仅删除本次新建且为空的目录
    let dirCursor = path.dirname(item.file);
    while (
      dirCursor === newGroupDir ||
      dirCursor.startsWith(`${newGroupDir}${path.sep}`)
    ) {
      if (!fs.existsSync(dirCursor)) {
        createdDirsSet.add(dirCursor);
      }
      if (dirCursor === newGroupDir) break;
      const parent = path.dirname(dirCursor);
      if (parent === dirCursor) break;
      dirCursor = parent;
    }
  }

  /* ---------- 阶段二：全部校验通过后才原子写盘并备份旧目录 ---------- */

  for (const item of plannedWrites) {
    writeJsonAtomic(item.file, item.payload);
  }

  let backupDir = "";
  if (hasOldGroupDir) {
    const resolvedBackup = resolveBackupDir(resolvedBase, oldSafe, now);
    moveDirToBackup(oldGroupDir, resolvedBackup.backupRoot, resolvedBackup.backupDir);
    backupDir = resolvedBackup.backupDir;
  }

  const rollbackPlan = {
    baseDir: resolvedBase,
    oldGroup: oldName,
    newGroup: newName,
    oldGroupDir,
    newGroupDir,
    backupDir,
    moved: hasOldGroupDir,
    hadNewGroupDir,
    hasChanges: hasOldGroupDir || previousFiles.length > 0,
    previousFiles,
    createdDirs: [...createdDirsSet].sort((a, b) => b.length - a.length),
  };

  const result = {
    ok: true,
    oldGroup: oldName,
    newGroup: newName,
    mergedPlatforms,
    backupDir,
    groupSettingsRenamed,
    moved: hasOldGroupDir,
  };
  Object.defineProperty(result, "_rollbackPlan", {
    value: rollbackPlan,
    enumerable: false,
    configurable: true,
  });
  return result;
}

/**
 * 回滚一次刚刚完成的分组统计目录迁移（供 Sidebar 账号更新失败时调用）：
 * 1. 若旧目录已移入备份，将其移回原位（若原位已被其他目录占用则拒绝覆盖并报错）；
 * 2. 将所有被本次迁移写入的文件恢复到写前原始字节（新建文件则删除）；
 * 3. 清理本次迁移在 newGroupDir 下新建且已为空的目录（绝不删除任何非空目录）。
 */
function rollbackRenameStatsGroup(rollbackPlan) {
  if (!isPlainObject(rollbackPlan)) {
    throw new Error("无效的迁移回滚上下文");
  }
  if (!rollbackPlan.hasChanges) {
    return {
      ok: true,
      rolledBack: false,
      oldGroup: rollbackPlan.oldGroup || "",
      newGroup: rollbackPlan.newGroup || "",
    };
  }

  const {
    oldGroupDir,
    newGroupDir,
    backupDir,
    moved,
    hadNewGroupDir,
    previousFiles = [],
    createdDirs = [],
  } = rollbackPlan;

  // 1. 先恢复旧分组目录（确保原始数据先安全归位，再清理新目录中的本次写入）
  if (moved && backupDir) {
    if (fs.existsSync(oldGroupDir)) {
      throw new Error(`无法回滚：旧分组目录已存在 (${oldGroupDir})`);
    }
    if (!fs.existsSync(backupDir)) {
      throw new Error(`无法回滚：未找到旧分组备份目录 (${backupDir})`);
    }
    moveDirToBackup(backupDir, path.dirname(oldGroupDir), oldGroupDir);
  }

  // 2. 恢复写前文件快照（原有文件按原始字节写回，新建文件删除）
  for (const entry of previousFiles) {
    if (!entry || typeof entry.file !== "string") continue;
    if (entry.existed) {
      writeBufferAtomic(entry.file, entry.raw);
    } else {
      try {
        fs.unlinkSync(entry.file);
      } catch (err) {
        if (!err || err.code !== "ENOENT") throw err;
      }
    }
  }

  // 3. 清理本次新建的空目录（最深路径优先；仅删空目录，绝不误删他处写入的文件）
  const sortedDirs = [...createdDirs].sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    if (dir === newGroupDir && hadNewGroupDir) continue;
    if (dir !== newGroupDir && !dir.startsWith(`${newGroupDir}${path.sep}`)) continue;
    try {
      fs.rmdirSync(dir);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTEMPTY" || err.code === "EEXIST")) {
        continue;
      }
      throw err;
    }
  }

  return {
    ok: true,
    rolledBack: true,
    oldGroup: rollbackPlan.oldGroup || "",
    newGroup: rollbackPlan.newGroup || "",
  };
}

module.exports = {
  renameStatsGroup,
  rollbackRenameStatsGroup,
  mergeWorksJsonDocs,
  mergeWorksDailyDocs,
  mergeWorksIntradayDocs,
  mergeDailyDocs,
  mergeMetaDocs,
  resolveBackupDir,
};
