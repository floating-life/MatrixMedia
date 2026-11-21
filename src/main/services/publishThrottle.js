"use strict";

/**
 * 发布节流 / 平台错峰 / 默认创作声明 主进程持久化、节流账本、串行锁与 IPC 服务。
 *
 * - 设置文件：<userData>/publish-throttle-settings.json（GUI / CLI / HTTP 共用）
 * - 节流账本：<userData>/publish-throttle-ledger.json（按「平台+规范化账号分区」记录每条
 *   已预留 / 已开始 / 已成功的正式发布时刻与记录 id；草稿不进账本；失败/取消/过期释放；
 *   账本为空时从历史 pushData 一次性导入初始历史）
 * - 主进程串行排期：planPublishTimes + 写账本预留放在同一把 async 锁里（HTTP / CLI / GUI IPC 共用）
 */

const fs = require("fs");
const path = require("path");
const sharedThrottle = require("../../shared/publishThrottle.js");
const {
  resolveCanonicalPlatform,
  deriveCanonicalPartition,
  readPushDataRecords,
} = require("../../shared/publishDedupe.js");

const SETTINGS_FILE_NAME = "publish-throttle-settings.json";
const LEDGER_FILE_NAME = "publish-throttle-ledger.json";
// 立即发布的预留在结果回写前一直有效（大文件下载/上传可能很久）；只为防进程崩溃永久占位设 3 小时兜底
const RESERVED_STALE_TTL_MS = 3 * 60 * 60 * 1000;
const LEDGER_LOCK_STALE_MS = 30 * 1000;
const LEDGER_LOCK_TIMEOUT_MS = 10 * 1000;
const LEDGER_LOCK_INITIAL_DELAY_MS = 15;
const LEDGER_LOCK_MAX_DELAY_MS = 100;
const DELETE_LEDGER_MAX_ATTEMPTS = 3;
const DISPATCH_SYNCED_RETENTION_MS = 7 * 24 * 3600 * 1000;

let tmpWriteSeq = 0;
let reservationSeq = 0;
let lockTokenSeq = 0;
let sharedSleepBuf = null;
const inProcessLockTails = new Map();

function getPublishThrottleLedgerLockPath(ledgerPathOrOptions = {}) {
  const ledgerPath =
    typeof ledgerPathOrOptions === "string" && ledgerPathOrOptions
      ? path.resolve(ledgerPathOrOptions)
      : getPublishThrottleLedgerPath(ledgerPathOrOptions);
  const dir = path.dirname(ledgerPath);
  const base = path.basename(ledgerPath);
  const stem = base.endsWith(".json") ? base.slice(0, -5) : base;
  return path.join(dir, `${stem}.lock`);
}

function createLockToken() {
  lockTokenSeq = (lockTokenSeq + 1) % 1000000;
  return `lk_${process.pid}_${Date.now()}_${lockTokenSeq}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function monotonicNowMs() {
  try {
    if (
      typeof process !== "undefined" &&
      process.hrtime &&
      typeof process.hrtime.bigint === "function"
    ) {
      return Number(process.hrtime.bigint() / 1000000n);
    }
  } catch (_) {}
  return null;
}

function sleepAsync(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}

function sleepSync(ms) {
  const delay = Math.max(1, Math.floor(Number(ms) || 1));
  try {
    if (
      typeof SharedArrayBuffer === "function" &&
      typeof Atomics === "object" &&
      typeof Atomics.wait === "function"
    ) {
      if (!sharedSleepBuf) {
        sharedSleepBuf = new Int32Array(new SharedArrayBuffer(4));
      }
      Atomics.wait(sharedSleepBuf, 0, 0, delay);
      return;
    }
  } catch (_) {}
  const monoStart = monotonicNowMs();
  if (monoStart !== null) {
    while (monotonicNowMs() - monoStart < delay) {
      /* fallback */
    }
  }
}

function tryAcquireFileLockOnce(lockPath, token) {
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return { acquired: false };
    }
    throw err;
  }
  try {
    const payload = Buffer.from(
      JSON.stringify({
        pid: process.pid,
        token,
        acquiredAt: Date.now(),
      }),
      "utf8"
    );
    fs.writeSync(fd, payload, 0, payload.length, 0);
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch (_) {}
    try {
      fs.unlinkSync(lockPath);
    } catch (_) {}
    throw err;
  }
  try {
    fs.closeSync(fd);
  } catch (_) {}
  return { acquired: true, token, lockPath };
}

function tryPreemptStaleLock(lockPath, staleMs, state) {
  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return true;
    return false;
  }
  const nowMs = Date.now();
  let isStale = false;
  let parsedInfo = null;
  if (raw && raw.trim()) {
    try {
      parsedInfo = JSON.parse(raw);
    } catch (_) {
      parsedInfo = null;
    }
  }
  if (
    parsedInfo &&
    typeof parsedInfo.acquiredAt === "number" &&
    Number.isFinite(parsedInfo.acquiredAt) &&
    parsedInfo.acquiredAt > 0
  ) {
    state.emptyReads = 0;
    isStale = nowMs - parsedInfo.acquiredAt > staleMs;
  } else {
    state.emptyReads = (state.emptyReads || 0) + 1;
    // 空锁文件可能是另一进程刚 openSync 尚未 writeSync，至少重试一次再按 mtime 判陈旧
    if ((raw && raw.trim()) || state.emptyReads >= 2) {
      try {
        const st = fs.statSync(lockPath);
        const mtime = Number(st && st.mtimeMs) || 0;
        if (mtime > 0 && nowMs - mtime > staleMs) {
          isStale = true;
        }
      } catch (err) {
        if (err && err.code === "ENOENT") return true;
      }
    }
  }
  if (!isStale) return false;

  lockTokenSeq = (lockTokenSeq + 1) % 1000000;
  // 只在锁内容仍是我们判定陈旧的那份时才删除；不用 rename（会把别的进程刚拿到的新锁挪走）。
  // 删除后由调用方用 openSync('wx') 独占创建，同时只有一个进程能成功。
  try {
    const cur = fs.readFileSync(lockPath, "utf8");
    if (cur !== raw) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    if (err && err.code === "ENOENT") return true;
  }
  return false;
}

function releaseFileLock(lockPath, token) {
  if (!lockPath) return;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const info = raw && raw.trim() ? JSON.parse(raw) : null;
    if (info && info.token && info.token !== token) {
      return;
    }
  } catch (err) {
    if (err && err.code === "ENOENT") return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (_) {}
}

async function acquireFileLockAsync(lockPath, options = {}) {
  const staleMs =
    typeof options.lockStaleMs === "number" &&
    Number.isFinite(options.lockStaleMs) &&
    options.lockStaleMs >= 0
      ? options.lockStaleMs
      : LEDGER_LOCK_STALE_MS;
  const timeoutMs =
    typeof options.lockTimeoutMs === "number" &&
    Number.isFinite(options.lockTimeoutMs) &&
    options.lockTimeoutMs >= 0
      ? options.lockTimeoutMs
      : LEDGER_LOCK_TIMEOUT_MS;
  const token = createLockToken();
  const monoStart = monotonicNowMs();
  let waitedMs = 0;
  let delayMs = LEDGER_LOCK_INITIAL_DELAY_MS;
  const staleState = { emptyReads: 0 };

  while (true) {
    const res = tryAcquireFileLockOnce(lockPath, token);
    if (res.acquired) return res;

    if (tryPreemptStaleLock(lockPath, staleMs, staleState)) {
      continue;
    }

    const monoElapsed =
      monoStart !== null ? Math.max(0, monotonicNowMs() - monoStart) : 0;
    const elapsed = Math.max(waitedMs, monoElapsed);
    if (elapsed >= timeoutMs) {
      const err = new Error(
        `获取节流账本文件锁超时（${Math.round(timeoutMs / 1000)} 秒）：${lockPath}`
      );
      err.code = "LEDGER_LOCK_TIMEOUT";
      throw err;
    }

    const remaining = timeoutMs - elapsed;
    const sleepFor = Math.max(1, Math.min(delayMs, remaining));
    await sleepAsync(sleepFor);
    waitedMs += sleepFor;
    delayMs = Math.min(
      LEDGER_LOCK_MAX_DELAY_MS,
      Math.max(delayMs + 5, Math.round(delayMs * 1.5))
    );
  }
}

function acquireFileLockSync(lockPath, options = {}) {
  const staleMs =
    typeof options.lockStaleMs === "number" &&
    Number.isFinite(options.lockStaleMs) &&
    options.lockStaleMs >= 0
      ? options.lockStaleMs
      : LEDGER_LOCK_STALE_MS;
  const timeoutMs =
    typeof options.lockTimeoutMs === "number" &&
    Number.isFinite(options.lockTimeoutMs) &&
    options.lockTimeoutMs >= 0
      ? options.lockTimeoutMs
      : LEDGER_LOCK_TIMEOUT_MS;
  const token = createLockToken();
  const monoStart = monotonicNowMs();
  let waitedMs = 0;
  let delayMs = LEDGER_LOCK_INITIAL_DELAY_MS;
  const staleState = { emptyReads: 0 };

  while (true) {
    const res = tryAcquireFileLockOnce(lockPath, token);
    if (res.acquired) return res;

    if (tryPreemptStaleLock(lockPath, staleMs, staleState)) {
      continue;
    }

    const monoElapsed =
      monoStart !== null ? Math.max(0, monotonicNowMs() - monoStart) : 0;
    const elapsed = Math.max(waitedMs, monoElapsed);
    if (elapsed >= timeoutMs) {
      const err = new Error(
        `获取节流账本文件锁超时（${Math.round(timeoutMs / 1000)} 秒）：${lockPath}`
      );
      err.code = "LEDGER_LOCK_TIMEOUT";
      throw err;
    }

    const remaining = timeoutMs - elapsed;
    const sleepFor = Math.max(1, Math.min(delayMs, remaining));
    sleepSync(sleepFor);
    waitedMs += sleepFor;
    delayMs = Math.min(
      LEDGER_LOCK_MAX_DELAY_MS,
      Math.max(delayMs + 5, Math.round(delayMs * 1.5))
    );
  }
}

/** 跨进程 + 同进程串行账本读写锁（同目录 .lock 独占创建，CLI / HTTP / GUI 共用） */
function withPublishThrottleLock(fn, options = {}) {
  const ledgerPath = getPublishThrottleLedgerPath(options);
  const lockPath = getPublishThrottleLedgerLockPath(ledgerPath);
  const prev = inProcessLockTails.get(ledgerPath) || Promise.resolve();
  const exec = async () => {
    const lock = await acquireFileLockAsync(lockPath, options);
    try {
      return await fn();
    } finally {
      releaseFileLock(lockPath, lock.token);
    }
  };
  const run = prev.then(exec, exec);
  const tail = run.then(
    () => {},
    () => {}
  );
  inProcessLockTails.set(ledgerPath, tail);
  tail.then(() => {
    if (inProcessLockTails.get(ledgerPath) === tail) {
      inProcessLockTails.delete(ledgerPath);
    }
  });
  return run;
}

/** 同步跨进程文件锁（供 changeData delete 同步账本使用） */
function withPublishThrottleLockSync(fn, options = {}) {
  const ledgerPath = getPublishThrottleLedgerPath(options);
  const lockPath = getPublishThrottleLedgerLockPath(ledgerPath);
  const lock = acquireFileLockSync(lockPath, options);
  try {
    return fn();
  } finally {
    releaseFileLock(lockPath, lock.token);
  }
}

function getPublishThrottleSettingsPath(options = {}) {
  if (options && options.filePath) {
    return path.resolve(options.filePath);
  }
  if (options && options.userDataDir) {
    return path.join(path.resolve(options.userDataDir), SETTINGS_FILE_NAME);
  }
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
    }
  } catch (_) {
    /* 非 Electron 环境回退 */
  }
  return path.resolve(__dirname, SETTINGS_FILE_NAME);
}

function getPublishThrottleLedgerPath(options = {}) {
  if (options && options.ledgerPath) {
    return path.resolve(options.ledgerPath);
  }
  if (options && options.userDataDir) {
    return path.join(path.resolve(options.userDataDir), LEDGER_FILE_NAME);
  }
  if (options && options.filePath) {
    return path.join(path.dirname(path.resolve(options.filePath)), LEDGER_FILE_NAME);
  }
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), LEDGER_FILE_NAME);
    }
  } catch (_) {
    /* 非 Electron 环境回退 */
  }
  return path.resolve(__dirname, LEDGER_FILE_NAME);
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  tmpWriteSeq = (tmpWriteSeq + 1) % 1000000;
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${tmpWriteSeq}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows 偶发目标被占用时退回覆盖写并清理临时文件
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
    }
  }
}

function createReservationId(nowMs = Date.now()) {
  reservationSeq = (reservationSeq + 1) % 1000000;
  return `tl_${nowMs}_${process.pid}_${reservationSeq}`;
}

function defaultChangeDataFn(options = {}) {
  if (options && typeof options.changeData === "function") {
    return options.changeData;
  }
  try {
    return require("../server/utils.js").changeData;
  } catch (_) {
    return null;
  }
}

function defaultFindExistingScheduledFn(options = {}) {
  if (options && typeof options.findExistingScheduled === "function") {
    return options.findExistingScheduled;
  }
  try {
    const mod = require("./scheduledDedupe.js");
    return mod.findExistingScheduled || (mod.default && mod.default.findExistingScheduled) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 读取主进程持久化的节流与默认声明设置（文件不存在或损坏时自动回退默认值）。
 */
function readPublishThrottleSettings(options = {}) {
  const filePath = getPublishThrottleSettingsPath(options);
  try {
    if (!fs.existsSync(filePath)) {
      return sharedThrottle.createDefaultPublishThrottleSettings();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sharedThrottle.normalizePublishThrottleSettings(raw);
  } catch (err) {
    console.warn(
      "[publishThrottle] 读取设置失败，回退默认值:",
      (err && err.message) || err
    );
    return sharedThrottle.createDefaultPublishThrottleSettings();
  }
}

/**
 * 校验并持久化节流与默认声明设置。
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
function savePublishThrottleSettings(nextSettings, options = {}) {
  const checked = sharedThrottle.validatePublishThrottleSettings(nextSettings);
  if (!checked.ok) {
    return { ok: false, error: checked.error };
  }
  const filePath = getPublishThrottleSettingsPath(options);
  const toSave = {
    ...checked.value,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(filePath, toSave);
  return { ok: true, settings: checked.value };
}

/**
 * 重置为默认设置并落盘。
 */
function resetPublishThrottleSettings(options = {}) {
  const defaults = sharedThrottle.createDefaultPublishThrottleSettings();
  return savePublishThrottleSettings(defaults, options);
}

/**
 * 读取当前持久化配置的默认创作声明（默认 ai_generated）。
 */
function getDefaultCreativeStatement(options = {}) {
  const settings = readPublishThrottleSettings(options);
  return settings.defaultCreativeStatement;
}

/* ---------------- 节流账本（<userData>/publish-throttle-ledger.json） ---------------- */

const ACTIVE_LEDGER_STATUSES = new Set([
  "reserved",
  "publishing",
  "scheduled",
  "success",
]);

function normalizeScheduledDispatchesMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(rawMap)) {
    if (!k || !v || typeof v !== "object") continue;
    out[String(k)] = { ...v };
  }
  return out;
}

function pruneScheduledDispatches(map, nowMs) {
  const out = {};
  if (!map || typeof map !== "object") return out;
  for (const [k, v] of Object.entries(map)) {
    if (!v || typeof v !== "object") continue;
    // 未补写回 pushData 的派发标记永不自动丢弃，确保刷新能补写而不重复上传
    if (v.historySynced !== true) {
      out[k] = v;
      continue;
    }
    const ts = Number(v.updatedAt || v.dispatchedAt) || 0;
    if (ts > 0 && nowMs - ts > DISPATCH_SYNCED_RETENTION_MS) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

function readPublishThrottleLedgerRaw(options = {}) {
  const ledgerPath = getPublishThrottleLedgerPath(options);
  if (!fs.existsSync(ledgerPath)) {
    return {
      exists: false,
      ledgerPath,
      ledger: {
        version: 1,
        importedPushData: false,
        updatedAt: 0,
        entries: [],
        scheduledDispatches: {},
      },
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const entries = Array.isArray(raw && raw.entries) ? raw.entries : [];
    const scheduledDispatches = normalizeScheduledDispatchesMap(
      raw && raw.scheduledDispatches
    );
    return {
      exists: true,
      ledgerPath,
      ledger: {
        version: 1,
        importedPushData: Boolean(raw && raw.importedPushData),
        updatedAt: Number(raw && raw.updatedAt) || 0,
        entries,
        scheduledDispatches,
      },
    };
  } catch (err) {
    // 读失败（EIO/半写入等）不能当空账本，否则会重复上传或连发：重试一次，仍失败则报错（排期与派发均中止）
    try {
      const raw2 = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      return {
        exists: true,
        ledgerPath,
        ledger: {
          version: 1,
          importedPushData: Boolean(raw2 && raw2.importedPushData),
          updatedAt: Number(raw2 && raw2.updatedAt) || 0,
          entries: Array.isArray(raw2 && raw2.entries) ? raw2.entries : [],
          scheduledDispatches: normalizeScheduledDispatchesMap(raw2 && raw2.scheduledDispatches),
        },
      };
    } catch (_) {}
    const e = new Error(`节流账本读取失败，已停止本次发布以防重复：${(err && err.message) || err}`);
    e.code = "LEDGER_READ_FAILED";
    throw e;
    // eslint-disable-next-line no-unreachable
    return {
      exists: false,
      ledgerPath,
      ledger: {
        version: 1,
        importedPushData: false,
        updatedAt: 0,
        entries: [],
        scheduledDispatches: {},
      },
    };
  }
}

function readPushDataRecordsSafe(changeDataFn) {
  if (typeof changeDataFn !== "function") {
    return { ok: false, records: [] };
  }
  try {
    const res = changeDataFn({
      fileName: "pushData",
      type: "get",
      item: { page: 1, pageSize: 10000 },
    });
    if (!res || res.success === false) {
      return { ok: false, records: [] };
    }
    const records = readPushDataRecords(() => res);
    return { ok: true, records };
  } catch (_) {
    return { ok: false, records: [] };
  }
}

function reconcileScheduledLedgerEntries(entries, pushDataRecords) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries: [], reconciled: false };
  }
  const byId = new Map();
  const byReservationId = new Map();
  const activeScheduledList = [];

  for (let i = 0; i < pushDataRecords.length; i++) {
    const rec = pushDataRecords[i];
    if (!rec || typeof rec !== "object") continue;
    if (rec.id != null && String(rec.id) !== "") {
      byId.set(String(rec.id), rec);
    }
    if (rec.throttleReservationId) {
      byReservationId.set(String(rec.throttleReservationId), rec);
    }
    const st = String(rec.publishStatus || "").trim().toLowerCase();
    if (
      rec.scheduledTask === true &&
      st === "scheduled" &&
      !sharedThrottle.isDraftPublishItem(rec)
    ) {
      activeScheduledList.push(rec);
    }
  }

  const isPendingFormalScheduled = (rec) => {
    if (!rec || typeof rec !== "object") return false;
    const st = String(rec.publishStatus || "").trim().toLowerCase();
    return (
      rec.scheduledTask === true &&
      st === "scheduled" &&
      !sharedThrottle.isDraftPublishItem(rec)
    );
  };

  let reconciled = false;
  const kept = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    const status = String(e.status || "").trim().toLowerCase();
    if (status !== "scheduled") {
      kept.push(e);
      continue;
    }

    let matchedRec = null;
    if (e.recordId != null && String(e.recordId) !== "") {
      matchedRec =
        byId.get(String(e.recordId)) ||
        (e.id ? byReservationId.get(String(e.id)) : null) ||
        null;
    } else {
      matchedRec = (e.id ? byReservationId.get(String(e.id)) : null) || null;
      if (!matchedRec) {
        matchedRec =
          activeScheduledList.find((rec) => {
            const recPt = resolveCanonicalPlatform(rec.pt || rec.platform);
            if (!recPt) return false;
            const recBucket = sharedThrottle.buildAccountBucketKey(rec, recPt);
            const recTs =
              Number(rec.scheduledPublishAt) ||
              sharedThrottle.parseUtc8DateTimeMs(rec.scheduledPublishAtText);
            return recBucket === e.bucketKey && recTs === e.ts;
          }) || null;
      }
    }

    if (isPendingFormalScheduled(matchedRec)) {
      if (
        (e.recordId == null || String(e.recordId) === "") &&
        matchedRec.id != null
      ) {
        e.recordId = String(matchedRec.id);
      }
      kept.push(e);
    } else {
      reconciled = true;
    }
  }
  return { entries: kept, reconciled };
}

function buildLegacyLedgerEntriesFromPushData(pushDataRecords, nowMs) {
  const out = [];
  if (!Array.isArray(pushDataRecords)) return out;
  for (let i = 0; i < pushDataRecords.length; i++) {
    const rec = pushDataRecords[i];
    if (!rec || typeof rec !== "object") continue;
    if (String(rec.textType || "").trim().toLowerCase() === "article") continue;
    if (sharedThrottle.isDraftPublishItem(rec)) continue;
    const recPt = resolveCanonicalPlatform(rec.pt || rec.platform);
    if (!recPt) continue;
    const ev = sharedThrottle.extractThrottleRecordEvent(rec, nowMs, {
      scheduledExpireGraceMs: sharedThrottle.SCHEDULED_EXPIRE_GRACE_MS,
    });
    if (!ev) continue;
    const rawStatus = String(rec.publishStatus || "").trim().toLowerCase();
    const status = ev.isScheduled
      ? "scheduled"
      : rawStatus === "publishing"
      ? "publishing"
      : "success";
    out.push({
      id: `legacy_${rec.id != null ? String(rec.id) : i}_${ev.ts}_${i}`,
      bucketKey: sharedThrottle.buildAccountBucketKey(rec, recPt),
      platform: recPt,
      partition: deriveCanonicalPartition(rec, recPt),
      phone: String(rec.phone || "").trim(),
      status,
      ts: ev.ts,
      isScheduled: ev.isScheduled,
      recordId: rec.id != null ? String(rec.id) : null,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
  }
  return out;
}

function pruneLedgerEntries(entries, nowMs) {
  if (!Array.isArray(entries)) return [];
  const kept = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e || typeof e !== "object") continue;
    const status = String(e.status || "").trim().toLowerCase();
    if (!ACTIVE_LEDGER_STATUSES.has(status)) continue;
    if (!e.bucketKey || typeof e.ts !== "number" || !Number.isFinite(e.ts) || e.ts <= 0) {
      continue;
    }
    if (status === "reserved") {
      const createdAt = Number(e.createdAt) || 0;
      if (createdAt > 0 && nowMs - createdAt > RESERVED_STALE_TTL_MS) {
        continue;
      }
    }
    if (
      status === "scheduled" &&
      e.ts < nowMs - sharedThrottle.SCHEDULED_EXPIRE_GRACE_MS
    ) {
      continue;
    }
    kept.push(e);
  }
  return kept;
}

/**
 * 读取当前有效账本：
 * - 若账本文件尚不存在（或为空且未导入过），从历史 pushData 一次性导入初始历史。
 * - 读取时与 pushData 对账：scheduled 类型的预留若对应任务已不存在或已非待发状态则视为失效并清理。
 */
function loadActiveLedger(options = {}, nowMs = Date.now(), pushDataRecordsOpt = null) {
  const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
  let didImport = false;
  let reconciled = false;
  let cachedPushRes = Array.isArray(pushDataRecordsOpt)
    ? { ok: true, records: pushDataRecordsOpt }
    : null;

  const ensurePushRecords = () => {
    if (!cachedPushRes) {
      cachedPushRes = readPushDataRecordsSafe(defaultChangeDataFn(options));
    }
    return cachedPushRes;
  };

  if (!exists || (!ledger.importedPushData && ledger.entries.length === 0)) {
    const pushRes = ensurePushRecords();
    ledger.entries = buildLegacyLedgerEntriesFromPushData(pushRes.records, nowMs);
    ledger.importedPushData = true;
    didImport = true;
  }

  ledger.entries = pruneLedgerEntries(ledger.entries, nowMs);
  ledger.scheduledDispatches = pruneScheduledDispatches(
    ledger.scheduledDispatches,
    nowMs
  );

  // 对账：scheduled 类型预留必须对应 pushData 中仍处于待发状态的任务，否则视为失效并清理
  const hasScheduledEntries = ledger.entries.some(
    (e) => e && String(e.status || "").trim().toLowerCase() === "scheduled"
  );
  if (hasScheduledEntries && options.skipPushDataReconcile !== true) {
    let pushRes = ensurePushRecords();
    // 历史读到 0 条却有待发预留：可能是偶发读取失败（读失败也返回空），重读一次确认后再对账
    if (pushRes.ok && pushRes.records.length === 0 && !Array.isArray(pushDataRecordsOpt)) {
      const again = readPushDataRecordsSafe(defaultChangeDataFn(options));
      if (again.ok && again.records.length > 0) {
        pushRes = again;
        cachedPushRes = again;
      }
    }
    if (pushRes.ok) {
      const checked = reconcileScheduledLedgerEntries(
        ledger.entries,
        pushRes.records
      );
      ledger.entries = checked.entries;
      reconciled = checked.reconciled;
    }
  }

  return { exists, ledgerPath, ledger, didImport, reconciled };
}

function readPublishThrottleLedger(options = {}, nowMs = Date.now()) {
  try {
    return loadActiveLedger(options, nowMs).ledger;
  } catch (err) {
    console.warn("[publishThrottle] 读取账本失败（仅展示用，返回空）:", (err && err.message) || err);
    return { version: 1, importedPushData: true, updatedAt: 0, entries: [], scheduledDispatches: {} };
  }
}

function derivePhoneFallback(target, canonicalPt) {
  if (target && target.phone) return String(target.phone).trim();
  if (!target || !target.partition) return "";
  const stripped = String(target.partition).replace(/^persist:/, "");
  const idx = canonicalPt ? stripped.indexOf(canonicalPt) : -1;
  return idx > 0 ? stripped.slice(0, idx) : stripped;
}

/**
 * 主进程串行排期 + 写账本预留统一入口（HTTP / CLI / GUI IPC 共用同一把 async 锁）。
 *
 * @param {object} params
 *   - targets: Array<{ platform|pt, phone?, accountKey?, partition?, publishAt?, publishAtMs?, noThrottle?, isDraft?, draft?, publishToDraft?, publishMode?, filePath?, textType?, creativeStatement? }>
 *   - now?: number
 *   - publishAt?: string|null
 *   - publishAtMs?: number|null
 *   - noThrottle?: boolean
 *   - dryRun?: boolean（true=仅预览不落账本）
 *   - previewItems?: Array<object>（GUI 确认时传入预览项；若与重算结果不同，返回 changed:true 交 GUI 重确认）
 *   - allowPartialError?: boolean（多平台部分溢出时仅失败溢出项，其余照常预留）
 *   - maxLookaheadDays?: number
 * @param {object} [options]
 */
async function planAndReservePublishTimes(params = {}, options = {}) {
  try {
    return await withPublishThrottleLock(async () => {
      const actualNowMs =
        typeof params.now === "number" && Number.isFinite(params.now)
          ? params.now
          : Date.now();
      const settings = readPublishThrottleSettings(options);
      const dryRun = params.dryRun === true;
      const globalNoThrottle = Boolean(params.noThrottle);
      const allowPartialError = params.allowPartialError === true;
      const rawTargets = Array.isArray(params.targets) ? params.targets : [];

      // 1. 统一按 UTC+8 以实际当前时刻 actualNowMs 校验全局与目标级显式 publishAt（过期/非法直接拒绝，GUI/HTTP/CLI 一致）
      let globalExplicitMs = null;
      if (
        params.publishAtMs != null &&
        params.publishAtMs !== "" &&
        Number.isFinite(Number(params.publishAtMs))
      ) {
        const ms = Number(params.publishAtMs);
        if (ms <= actualNowMs) {
          return {
            ok: false,
            code: "EXPIRED_PUBLISH_AT",
            error: "定时发布时间必须是未来时间",
            message: "定时发布时间必须是未来时间",
          };
        }
        globalExplicitMs = ms;
      } else if (
        params.publishAt != null &&
        String(params.publishAt).trim() !== ""
      ) {
        const parsedAt = sharedThrottle.parsePublishAtUtc8(
          params.publishAt,
          actualNowMs
        );
        if (!parsedAt.ok) {
          return {
            ok: false,
            code: parsedAt.code || "INVALID_PUBLISH_AT",
            error: parsedAt.error,
            message: parsedAt.error,
          };
        }
        globalExplicitMs = parsedAt.value;
      }

      const validPreparedTargets = [];
      const validPreparedIndices = [];
      const preErrorsByIndex = new Map();
      let needPushDataForReuse = false;

      for (let i = 0; i < rawTargets.length; i++) {
        const t = rawTargets[i] || {};
        const canonicalPt = resolveCanonicalPlatform(t.platform || t.pt);
        const isDraft = sharedThrottle.isDraftPublishItem(t);
        let targetExplicitMs = globalExplicitMs;
        let targetError = null;

        if (
          t.publishAtMs != null &&
          t.publishAtMs !== "" &&
          Number.isFinite(Number(t.publishAtMs))
        ) {
          const ms = Number(t.publishAtMs);
          if (ms <= actualNowMs) {
            targetError = {
              code: "EXPIRED_PUBLISH_AT",
              error: "定时发布时间必须是未来时间",
            };
          } else {
            targetExplicitMs = ms;
          }
        } else if (t.publishAt != null && String(t.publishAt).trim() !== "") {
          const parsedAt = sharedThrottle.parsePublishAtUtc8(
            t.publishAt,
            actualNowMs
          );
          if (!parsedAt.ok) {
            targetError = {
              code: parsedAt.code || "INVALID_PUBLISH_AT",
              error: parsedAt.error,
            };
          } else {
            targetExplicitMs = parsedAt.value;
          }
        }

        if (targetError) {
          if (!allowPartialError) {
            return {
              ok: false,
              code: targetError.code,
              error: targetError.error,
              message: targetError.error,
            };
          }
          preErrorsByIndex.set(i, {
            index: i,
            ok: false,
            overflow: false,
            code: targetError.code,
            error: targetError.error,
            platform: canonicalPt || t.platform || t.pt,
            phone: String(t.phone || "").trim(),
            partition: t.partition || deriveCanonicalPartition(t, canonicalPt),
            accountKey: sharedThrottle.buildAccountBucketKey(t, canonicalPt),
            isDraft,
            reusedScheduled: false,
            immediate: false,
            scheduled: false,
            throttled: false,
            bypassed: false,
            requestedAtMs: actualNowMs,
            plannedAtMs: null,
            publishAt: null,
            reasons: [],
            reason: targetError.error,
            reservationId: null,
          });
          continue;
        }

        if (targetExplicitMs !== null && !isDraft && t.filePath) {
          needPushDataForReuse = true;
        }

        validPreparedTargets.push({
          ...t,
          platform: canonicalPt || t.platform || t.pt,
          publishAtMs: targetExplicitMs,
          publishAt:
            targetExplicitMs !== null
              ? sharedThrottle.formatUtc8DateTime(targetExplicitMs)
              : null,
          isDraft,
        });
        validPreparedIndices.push(i);
      }

      // 2. 加载 pushData（需要检查既有定时任务复用、账本首次导入或账本 scheduled 对账时读取）
      const changeDataFn = defaultChangeDataFn(options);
      const findExistingScheduledFn = defaultFindExistingScheduledFn(options);
      const rawLedgerState = readPublishThrottleLedgerRaw(options);
      const needPushDataForImport =
        !rawLedgerState.exists ||
        (!rawLedgerState.ledger.importedPushData &&
          rawLedgerState.ledger.entries.length === 0);
      const hasScheduledInRaw = rawLedgerState.ledger.entries.some(
        (e) => e && String(e.status || "").trim().toLowerCase() === "scheduled"
      );
      const pushDataSafe =
        needPushDataForReuse || needPushDataForImport || hasScheduledInRaw
          ? readPushDataRecordsSafe(changeDataFn)
          : { ok: false, records: [] };
      const pushDataRecords = pushDataSafe.ok ? pushDataSafe.records : null;

      // 2b. 改标题复用同文件同时刻的定时任务：排期前命中既有待发任务则直接复用，不再节流顺延（#1）
      if (
        needPushDataForReuse &&
        typeof findExistingScheduledFn === "function" &&
        Array.isArray(pushDataRecords) &&
        pushDataRecords.length > 0
      ) {
        for (let i = 0; i < validPreparedTargets.length; i++) {
          const t = validPreparedTargets[i];
          if (t.isDraft || t.publishAtMs === null || !t.filePath) continue;
          const canonicalPt = resolveCanonicalPlatform(t.platform || t.pt);
          const resolvedPartition =
            t.partition || deriveCanonicalPartition(t, canonicalPt);
          const phone = derivePhoneFallback(t, canonicalPt);
          const existing = findExistingScheduledFn(pushDataRecords, {
            pt: canonicalPt,
            partition: resolvedPartition,
            phone,
            filePath: t.filePath,
            textType: t.textType || "local",
            scheduledPublishAt: t.publishAtMs,
          });
          if (existing) {
            t.reusedScheduled = true;
            t.existingRecordId = existing.id != null ? existing.id : null;
            t._existingRecord = existing;
          }
        }
      }

      // 3. 排期只读账本（首次空账本一次性导入历史 pushData，读取时与 pushData 对账清理失效 scheduled 占位）
      const { exists: ledgerExists, ledgerPath, ledger, reconciled } =
        loadActiveLedger(options, actualNowMs, pushDataRecords);

      // GUI 确认重算时，若携带了距今 ≤ 10 分钟的预览基准时刻 previewBaseMs，则以其作为排期「请求时刻」
      const rawPreviewBase =
        typeof params.previewBaseMs === "number" &&
        Number.isFinite(params.previewBaseMs) &&
        params.previewBaseMs > 0
          ? params.previewBaseMs
          : null;
      const acceptedPreviewBaseMs =
        !dryRun &&
        !globalNoThrottle &&
        rawPreviewBase !== null &&
        rawPreviewBase <= actualNowMs &&
        actualNowMs - rawPreviewBase <= sharedThrottle.PREVIEW_BASE_MAX_AGE_MS
          ? rawPreviewBase
          : null;

      const computeMergedPlan = (planNowMs) => {
        const subPlan = sharedThrottle.planPublishTimes({
          targets: validPreparedTargets,
          now: planNowMs,
          records: ledger.entries,
          settings,
          noThrottle: globalNoThrottle,
          maxLookaheadDays: params.maxLookaheadDays,
          scheduledExpireGraceMs: sharedThrottle.SCHEDULED_EXPIRE_GRACE_MS,
        });
        if (preErrorsByIndex.size === 0) {
          return subPlan;
        }
        const mergedItems = new Array(rawTargets.length);
        for (const [idx, errItem] of preErrorsByIndex.entries()) {
          mergedItems[idx] = errItem;
        }
        for (let k = 0; k < validPreparedIndices.length; k++) {
          const origIdx = validPreparedIndices[k];
          mergedItems[origIdx] = {
            ...subPlan.items[k],
            index: origIdx,
          };
        }
        const firstErr = mergedItems.find((it) => it && it.ok === false);
        return {
          ...subPlan,
          ok: !firstErr,
          error: firstErr ? firstErr.error : "",
          hasError: Boolean(firstErr),
          items: mergedItems,
          hasThrottled: mergedItems.some((it) => it && it.throttled),
          hasScheduled: mergedItems.some((it) => it && it.scheduled),
        };
      };

      let planNowMs =
        acceptedPreviewBaseMs !== null ? acceptedPreviewBaseMs : actualNowMs;
      let plan = computeMergedPlan(planNowMs);

      // 若基于 previewBaseMs 算出的定时计划时间相对实际当前时刻已过期，则回退实际当前时刻重算
      if (
        acceptedPreviewBaseMs !== null &&
        plan.items.some(
          (it) =>
            it &&
            it.ok === true &&
            it.scheduled &&
            typeof it.plannedAtMs === "number" &&
            it.plannedAtMs <= actualNowMs
        )
      ) {
        planNowMs = actualNowMs;
        plan = computeMergedPlan(planNowMs);
      }

      // 4. 搜索超限（「排期已满」）处理（#13）
      if (!plan.ok && !allowPartialError) {
        if (reconciled && ledgerExists) {
          try {
            ledger.updatedAt = actualNowMs;
            writeJsonAtomic(ledgerPath, ledger);
          } catch (_) {}
        }
        return {
          ...plan,
          ok: false,
          code: "SCHEDULE_FULL",
          error: plan.error,
          message: plan.error,
          previewBaseMs: plan.nowMs,
        };
      }

      // 5. GUI 确认时与预览对比：仅当计划时刻差异 > 60 秒或节流原因/状态变化时要求重新确认
      if (
        !dryRun &&
        !globalNoThrottle &&
        Array.isArray(params.previewItems) &&
        sharedThrottle.comparePlanForGuiDrift(params.previewItems, plan.items)
      ) {
        const refreshedPlan =
          planNowMs !== actualNowMs ? computeMergedPlan(actualNowMs) : plan;
        return {
          ...refreshedPlan,
          ok: true,
          changed: true,
          reservationIds: [],
          previewBaseMs: refreshedPlan.nowMs,
          message: "期间有新的发布任务，排期已更新，请重新确认最新排期",
        };
      }

      if (dryRun) {
        if (reconciled && ledgerExists) {
          try {
            ledger.updatedAt = actualNowMs;
            writeJsonAtomic(ledgerPath, ledger);
          } catch (_) {}
        }
        return {
          ...plan,
          ok: allowPartialError ? true : plan.ok,
          planOk: plan.ok,
          partialError: !plan.ok,
          changed: false,
          reservationIds: [],
          previewBaseMs: plan.nowMs,
        };
      }

      // 6. 写账本预留（仅正式发布且非复用且有效的条目进账本；草稿与失败项绝不进账本）
      const reservationIds = [];
      for (let i = 0; i < plan.items.length; i++) {
        const item = plan.items[i];
        if (!item || item.ok !== true || item.isDraft || item.reusedScheduled) {
          if (item) item.reservationId = null;
          continue;
        }
        const resId = createReservationId(actualNowMs);
        item.reservationId = resId;
        reservationIds.push(resId);
        ledger.entries.push({
          id: resId,
          bucketKey: item.accountKey,
          platform: item.platform,
          partition: item.partition,
          phone: item.phone,
          status: "reserved",
          ts: Math.max(actualNowMs, item.plannedAtMs),
          isScheduled: Boolean(item.scheduled),
          recordId: null,
          createdAt: actualNowMs,
          updatedAt: actualNowMs,
        });
      }

      if (reservationIds.length > 0 || (reconciled && ledgerExists)) {
        ledger.importedPushData = true;
        ledger.updatedAt = actualNowMs;
        try {
          writeJsonAtomic(ledgerPath, ledger);
        } catch (err) {
          if (reservationIds.length > 0) {
            const msg = `写入节流账本失败: ${(err && err.message) || err}`;
            return {
              ok: false,
              code: "LEDGER_WRITE_FAILED",
              error: msg,
              message: msg,
            };
          }
        }
      }

      // 注意：...plan 放在前面，防止 allowPartialError 部分失败时 plan.ok=false 覆盖服务层 ok:true
      return {
        ...plan,
        ok: true,
        planOk: plan.ok,
        partialError: !plan.ok,
        changed: false,
        reservationIds,
        previewBaseMs: plan.nowMs,
      };
    }, options);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: msg,
      message: msg,
    };
  }
}

/**
 * 确认/更新已预留的账本条目状态（publishing / scheduled / success）并绑定 recordId。
 * 严格按 reservationId 精准操作，不波及同 recordId 的其他预留。
 */
async function confirmThrottleReservation(reservationId, patch = {}, options = {}) {
  if (!reservationId) return { ok: true };
  try {
    return await withPublishThrottleLock(async () => {
      const nowMs = Date.now();
      const { ledgerPath, ledger } = loadActiveLedger(options, nowMs);
      const resIdStr = String(reservationId);
      const entry = ledger.entries.find((e) => e && String(e.id) === resIdStr);
      const st = patch.status ? String(patch.status).trim().toLowerCase() : "";

      if (!entry) {
        // 正式发布已确认成功时，若预留条目意外缺失且调用方带了账号信息，按该 reservationId 补记防止漏算
        if (
          (st === "success" || st === "published") &&
          !sharedThrottle.isDraftPublishItem(patch) &&
          (patch.platform || patch.pt)
        ) {
          const canonicalPt = resolveCanonicalPlatform(patch.platform || patch.pt);
          if (canonicalPt) {
            ledger.entries.push({
              id: resIdStr,
              bucketKey: sharedThrottle.buildAccountBucketKey(patch, canonicalPt),
              platform: canonicalPt,
              partition: deriveCanonicalPartition(patch, canonicalPt),
              phone: String(patch.phone || "").trim(),
              status: "success",
              ts:
                typeof patch.ts === "number" && Number.isFinite(patch.ts) && patch.ts > 0
                  ? patch.ts
                  : nowMs,
              isScheduled: false,
              recordId:
                patch.recordId != null && patch.recordId !== ""
                  ? String(patch.recordId)
                  : null,
              createdAt: nowMs,
              updatedAt: nowMs,
            });
            ledger.importedPushData = true;
            ledger.updatedAt = nowMs;
            try {
              writeJsonAtomic(ledgerPath, ledger);
              return { ok: true };
            } catch (err) {
              return {
                ok: false,
                error: `写入节流账本失败: ${(err && err.message) || err}`,
              };
            }
          }
        }
        return { ok: true };
      }

      if (st) {
        if (!ACTIVE_LEDGER_STATUSES.has(st)) {
          // 转为失败/草稿/取消/过期等非计数状态时仅释放当前 reservationId
          ledger.entries = ledger.entries.filter(
            (e) => e && String(e.id) !== resIdStr
          );
        } else {
          entry.status = st;
          if (
            typeof patch.ts === "number" &&
            Number.isFinite(patch.ts) &&
            patch.ts > 0
          ) {
            entry.ts = patch.ts;
          }
          if (typeof patch.isScheduled === "boolean") {
            entry.isScheduled = patch.isScheduled;
          }
          if (patch.recordId != null && patch.recordId !== "") {
            entry.recordId = String(patch.recordId);
          }
          entry.updatedAt = nowMs;
        }
      } else {
        if (
          typeof patch.ts === "number" &&
          Number.isFinite(patch.ts) &&
          patch.ts > 0
        ) {
          entry.ts = patch.ts;
        }
        if (typeof patch.isScheduled === "boolean") {
          entry.isScheduled = patch.isScheduled;
        }
        if (patch.recordId != null && patch.recordId !== "") {
          entry.recordId = String(patch.recordId);
        }
        entry.updatedAt = nowMs;
      }

      ledger.importedPushData = true;
      ledger.updatedAt = nowMs;
      try {
        writeJsonAtomic(ledgerPath, ledger);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `写入节流账本失败: ${(err && err.message) || err}`,
        };
      }
    }, options);
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

/**
 * 直接向账本追加一条正式发布记录（用于绕过 commit-plan 直接调 create-scheduled IPC 等场景）。
 */
async function recordThrottleEntryDirect(entryInput, options = {}) {
  try {
    return await withPublishThrottleLock(async () => {
      if (!entryInput || sharedThrottle.isDraftPublishItem(entryInput)) {
        return { ok: true, id: null };
      }
      const nowMs = Date.now();
      const canonicalPt = resolveCanonicalPlatform(
        entryInput.platform || entryInput.pt
      );
      if (!canonicalPt) return { ok: true, id: null };
      const ts =
        typeof entryInput.ts === "number" && Number.isFinite(entryInput.ts)
          ? entryInput.ts
          : nowMs;
      const { ledgerPath, ledger } = loadActiveLedger(options, nowMs);
      const id = createReservationId(nowMs);
      ledger.entries.push({
        id,
        bucketKey: sharedThrottle.buildAccountBucketKey(entryInput, canonicalPt),
        platform: canonicalPt,
        partition: deriveCanonicalPartition(entryInput, canonicalPt),
        phone: String(entryInput.phone || "").trim(),
        status:
          entryInput.status ||
          (entryInput.isScheduled ? "scheduled" : "publishing"),
        ts,
        isScheduled: Boolean(entryInput.isScheduled),
        recordId:
          entryInput.recordId != null ? String(entryInput.recordId) : null,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
      ledger.importedPushData = true;
      ledger.updatedAt = nowMs;
      try {
        writeJsonAtomic(ledgerPath, ledger);
        return { ok: true, id };
      } catch (err) {
        return {
          ok: false,
          error: `写入节流账本失败: ${(err && err.message) || err}`,
        };
      }
    }, options);
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

/**
 * 释放一条或多条账本预留（严格按 reservationId 释放，不影响其他并发预留）。
 */
async function releaseThrottleReservation(reservationIdOrList, options = {}) {
  const ids = Array.isArray(reservationIdOrList)
    ? reservationIdOrList.filter(Boolean).map(String)
    : reservationIdOrList
    ? [String(reservationIdOrList)]
    : [];
  if (ids.length === 0) return { ok: true, removed: 0 };

  try {
    return await withPublishThrottleLock(async () => {
      const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
      if (!exists) return { ok: true, removed: 0 };
      const idSet = new Set(ids);
      const before = ledger.entries.length;
      ledger.entries = ledger.entries.filter(
        (e) => !e || !idSet.has(String(e.id))
      );
      const removed = before - ledger.entries.length;
      if (removed > 0) {
        ledger.updatedAt = Date.now();
        try {
          writeJsonAtomic(ledgerPath, ledger);
        } catch (err) {
          return {
            ok: false,
            removed: 0,
            error: `释放节流账本预留失败: ${(err && err.message) || err}`,
          };
        }
      }
      return { ok: true, removed };
    }, options);
  } catch (err) {
    return {
      ok: false,
      removed: 0,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

/**
 * 按 pushData 记录 id 释放或更新账本条目（仅用于定时任务或显式历史清理；
 * 若 extra.reservationId 存在则严格按 reservationId 操作；若 extra.onlyScheduled 为 true 则仅处理 scheduled 条目）。
 */
async function settleThrottleByRecordId(
  recordId,
  nextStatus,
  extra = {},
  options = {}
) {
  if (extra && extra.reservationId) {
    const st = String(nextStatus || "").trim().toLowerCase();
    const isDraft =
      extra.publishToDraft === true ||
      String(extra.publishMode || "").trim().toLowerCase() === "draft";
    if (
      st === "delete" ||
      isDraft ||
      sharedThrottle.NON_COUNTING_PUBLISH_STATUSES.has(st)
    ) {
      return releaseThrottleReservation(extra.reservationId, options);
    }
    if (st === "success" || st === "published") {
      return confirmThrottleReservation(
        extra.reservationId,
        {
          status: "success",
          isScheduled: false,
          recordId,
          ts: extra.ts,
          platform: extra.platform || extra.pt,
          phone: extra.phone,
          partition: extra.partition,
        },
        options
      );
    }
    if (st === "publishing") {
      return confirmThrottleReservation(
        extra.reservationId,
        { status: "publishing", isScheduled: false, recordId },
        options
      );
    }
    return { ok: true, changed: false };
  }

  if (recordId == null || recordId === "") return { ok: true, changed: false };

  try {
    return await withPublishThrottleLock(async () => {
      const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
      if (!exists) return { ok: true, changed: false };

      const recIdStr = String(recordId);
      const st = String(nextStatus || "").trim().toLowerCase();
      const onlyScheduled = Boolean(extra && extra.onlyScheduled);
      const isDraft =
        extra.publishToDraft === true ||
        String(extra.publishMode || "").trim().toLowerCase() === "draft";
      const nowMs = Date.now();
      let changed = false;

      if (
        st === "delete" ||
        isDraft ||
        sharedThrottle.NON_COUNTING_PUBLISH_STATUSES.has(st)
      ) {
        const nextEntries = [];
        for (let i = 0; i < ledger.entries.length; i++) {
          const e = ledger.entries[i];
          const statusMatch = onlyScheduled
            ? e && e.status === "scheduled"
            : e && e.status !== "success";
          if (
            e &&
            e.recordId != null &&
            String(e.recordId) === recIdStr &&
            statusMatch
          ) {
            changed = true;
            continue;
          }
          nextEntries.push(e);
        }
        ledger.entries = nextEntries;
      } else if (st === "success" || st === "published") {
        for (let i = ledger.entries.length - 1; i >= 0; i--) {
          const e = ledger.entries[i];
          const statusMatch = onlyScheduled
            ? e && e.status === "scheduled"
            : e && e.status !== "success";
          if (
            e &&
            e.recordId != null &&
            String(e.recordId) === recIdStr &&
            statusMatch
          ) {
            e.status = "success";
            e.isScheduled = false;
            if (
              typeof extra.ts === "number" &&
              Number.isFinite(extra.ts) &&
              extra.ts > 0
            ) {
              e.ts = extra.ts;
            }
            e.updatedAt = nowMs;
            changed = true;
            break;
          }
        }
      } else if (st === "publishing") {
        for (let i = ledger.entries.length - 1; i >= 0; i--) {
          const e = ledger.entries[i];
          const statusMatch = onlyScheduled
            ? e && e.status === "scheduled"
            : e && (e.status === "reserved" || e.status === "scheduled");
          if (
            e &&
            e.recordId != null &&
            String(e.recordId) === recIdStr &&
            statusMatch
          ) {
            e.status = "publishing";
            e.isScheduled = false;
            e.updatedAt = nowMs;
            changed = true;
            break;
          }
        }
      }

      if (changed) {
        ledger.updatedAt = nowMs;
        try {
          writeJsonAtomic(ledgerPath, ledger);
        } catch (err) {
          return {
            ok: false,
            changed: false,
            error: `同步节流账本失败: ${(err && err.message) || err}`,
          };
        }
      }
      return { ok: true, changed };
    }, options);
  } catch (err) {
    return {
      ok: false,
      changed: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

function releaseThrottleByRecordId(recordId, options = {}) {
  return settleThrottleByRecordId(recordId, "cancelled", {}, options);
}

/* ---------------- 定时任务防重复派发持久化标记 ---------------- */

function getScheduledTaskDispatchStateSync(recordId, options = {}) {
  if (recordId == null || recordId === "") return { dispatched: false };
  const recIdStr = String(recordId);
  const { exists, ledger } = readPublishThrottleLedgerRaw(options);
  if (!exists) return { dispatched: false };

  const rec =
    ledger.scheduledDispatches && ledger.scheduledDispatches[recIdStr];
  if (rec && typeof rec === "object") {
    return {
      dispatched: true,
      recordId: recIdStr,
      status: String(rec.status || "publishing").trim().toLowerCase(),
      historySynced: rec.historySynced === true,
      resultPatch: rec.resultPatch || null,
      dispatchedAt: Number(rec.dispatchedAt) || 0,
      updatedAt: Number(rec.updatedAt) || 0,
      isDraft: Boolean(rec.isDraft),
      reservationId: rec.reservationId || null,
    };
  }

  // 兜底检查账本 entries：若对应任务 id 已进入 publishing 或 success，同样不得再次上传
  for (let i = ledger.entries.length - 1; i >= 0; i--) {
    const e = ledger.entries[i];
    if (!e || e.recordId == null || String(e.recordId) !== recIdStr) continue;
    const st = String(e.status || "").trim().toLowerCase();
    if (st === "publishing" || st === "success") {
      return {
        dispatched: true,
        recordId: recIdStr,
        status: st,
        historySynced: false,
        resultPatch: null,
        dispatchedAt: Number(e.createdAt) || 0,
        updatedAt: Number(e.updatedAt || e.ts) || 0,
        isDraft: false,
        reservationId: e.id || null,
      };
    }
  }
  return { dispatched: false };
}

/**
 * 定时任务派发前原子检查并持久化「已派发」标记到账本（按任务 id）。
 * 若账本中已存在该任务 id 的开始/成功记录，返回 alreadyDispatched: true，调用方不得再次上传。
 */
async function markScheduledTaskDispatched(record, nowMs = Date.now(), options = {}) {
  if (!record || record.id == null || record.id === "") {
    return { ok: false, error: "缺少定时任务 id" };
  }
  const recIdStr = String(record.id);
  const resId = record.throttleReservationId
    ? String(record.throttleReservationId)
    : null;
  const isDraft = sharedThrottle.isDraftPublishItem(record);

  try {
    return await withPublishThrottleLock(async () => {
      const { ledgerPath, ledger } = loadActiveLedger(options, nowMs);
      const existingDispatch =
        ledger.scheduledDispatches && ledger.scheduledDispatches[recIdStr];
      if (existingDispatch && typeof existingDispatch === "object") {
        return {
          ok: true,
          alreadyDispatched: true,
          state: {
            dispatched: true,
            recordId: recIdStr,
            status: String(existingDispatch.status || "publishing")
              .trim()
              .toLowerCase(),
            historySynced: existingDispatch.historySynced === true,
            resultPatch: existingDispatch.resultPatch || null,
            dispatchedAt: Number(existingDispatch.dispatchedAt) || 0,
            updatedAt: Number(existingDispatch.updatedAt) || 0,
            isDraft: Boolean(existingDispatch.isDraft),
            reservationId: existingDispatch.reservationId || resId,
          },
        };
      }

      for (let i = ledger.entries.length - 1; i >= 0; i--) {
        const e = ledger.entries[i];
        if (!e || e.recordId == null || String(e.recordId) !== recIdStr) continue;
        const st = String(e.status || "").trim().toLowerCase();
        if (st === "publishing" || st === "success") {
          return {
            ok: true,
            alreadyDispatched: true,
            state: {
              dispatched: true,
              recordId: recIdStr,
              status: st,
              historySynced: false,
              resultPatch: null,
              dispatchedAt: Number(e.createdAt) || 0,
              updatedAt: Number(e.updatedAt || e.ts) || 0,
              isDraft: false,
              reservationId: e.id || resId,
            },
          };
        }
      }

      if (!ledger.scheduledDispatches || typeof ledger.scheduledDispatches !== "object") {
        ledger.scheduledDispatches = {};
      }
      ledger.scheduledDispatches[recIdStr] = {
        recordId: recIdStr,
        date: record.date || "",
        reservationId: resId,
        isDraft,
        status: "publishing",
        dispatchedAt: nowMs,
        updatedAt: nowMs,
        historySynced: false,
        resultPatch: null,
      };

      // 正式视频任务的账本条目由 scheduled 转为 publishing
      if (!isDraft) {
        let matchedEntry = null;
        if (resId) {
          matchedEntry =
            ledger.entries.find((e) => e && String(e.id) === resId) || null;
        }
        if (!matchedEntry) {
          matchedEntry =
            ledger.entries.find(
              (e) =>
                e &&
                e.recordId != null &&
                String(e.recordId) === recIdStr &&
                e.status === "scheduled"
            ) || null;
        }
        if (matchedEntry) {
          matchedEntry.status = "publishing";
          matchedEntry.isScheduled = false;
          matchedEntry.recordId = recIdStr;
          matchedEntry.updatedAt = nowMs;
        }
      }

      ledger.importedPushData = true;
      ledger.updatedAt = nowMs;
      try {
        writeJsonAtomic(ledgerPath, ledger);
        return { ok: true, alreadyDispatched: false };
      } catch (err) {
        return {
          ok: false,
          error: `持久化定时任务派发标记失败: ${(err && err.message) || err}`,
        };
      }
    }, options);
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

/**
 * 定时任务终结时原子更新账本预留状态与派发结果（含历史补写所需 resultPatch 与 historySynced 标志）。
 */
async function recordScheduledTaskOutcome(
  record,
  status,
  extra = {},
  options = {}
) {
  if (!record || record.id == null || record.id === "") return { ok: true };
  const recIdStr = String(record.id);
  const resId = record.throttleReservationId
    ? String(record.throttleReservationId)
    : null;
  const st = String(status || "").trim().toLowerCase();
  const isDraft =
    extra.publishToDraft === true ||
    String(extra.publishMode || "").trim().toLowerCase() === "draft" ||
    sharedThrottle.isDraftPublishItem(record);
  const isFormalSuccess =
    (st === "success" || st === "published") && !isDraft;
  const nowMs =
    typeof extra.ts === "number" && Number.isFinite(extra.ts) && extra.ts > 0
      ? extra.ts
      : Date.now();

  try {
    return await withPublishThrottleLock(async () => {
      const { ledgerPath, ledger } = loadActiveLedger(options, nowMs);
      if (!ledger.scheduledDispatches || typeof ledger.scheduledDispatches !== "object") {
        ledger.scheduledDispatches = {};
      }
      const prev = ledger.scheduledDispatches[recIdStr] || {};
      ledger.scheduledDispatches[recIdStr] = {
        ...prev,
        recordId: recIdStr,
        date: record.date || prev.date || "",
        reservationId: resId || prev.reservationId || null,
        isDraft,
        status: st || prev.status || "failed",
        dispatchedAt: prev.dispatchedAt || nowMs,
        updatedAt: nowMs,
        historySynced: extra.historySynced === true,
        resultPatch:
          extra.resultPatch && typeof extra.resultPatch === "object"
            ? { ...extra.resultPatch }
            : prev.resultPatch || null,
      };

      if (isFormalSuccess) {
        let entry = resId
          ? ledger.entries.find((e) => e && String(e.id) === resId)
          : null;
        if (!entry) {
          entry = ledger.entries.find(
            (e) =>
              e &&
              e.recordId != null &&
              String(e.recordId) === recIdStr &&
              e.status !== "success"
          );
        }
        if (!entry && !resId) {
          entry = ledger.entries.find(
            (e) =>
              e &&
              e.recordId != null &&
              String(e.recordId) === recIdStr &&
              e.status === "success"
          );
        }
        if (entry) {
          entry.status = "success";
          entry.isScheduled = false;
          entry.ts = nowMs;
          entry.recordId = recIdStr;
          entry.updatedAt = nowMs;
        } else {
          const canonicalPt = resolveCanonicalPlatform(
            record.pt || record.platform
          );
          if (canonicalPt) {
            ledger.entries.push({
              id: resId || createReservationId(nowMs),
              bucketKey: sharedThrottle.buildAccountBucketKey(record, canonicalPt),
              platform: canonicalPt,
              partition: deriveCanonicalPartition(record, canonicalPt),
              phone: String(record.phone || "").trim(),
              status: "success",
              ts: nowMs,
              isScheduled: false,
              recordId: recIdStr,
              createdAt: nowMs,
              updatedAt: nowMs,
            });
          }
        }
      } else if (resId) {
        ledger.entries = ledger.entries.filter(
          (e) => !e || String(e.id) !== resId
        );
      } else {
        ledger.entries = ledger.entries.filter(
          (e) =>
            !e ||
            e.recordId == null ||
            String(e.recordId) !== recIdStr ||
            e.status === "success"
        );
      }

      ledger.importedPushData = true;
      ledger.updatedAt = nowMs;
      try {
        writeJsonAtomic(ledgerPath, ledger);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `写入节流账本失败: ${(err && err.message) || err}`,
        };
      }
    }, options);
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

async function markScheduledTaskHistorySynced(recordId, options = {}) {
  if (recordId == null || recordId === "") return { ok: true };
  const recIdStr = String(recordId);
  try {
    return await withPublishThrottleLock(async () => {
      const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
      if (!exists) return { ok: true };
      const rec =
        ledger.scheduledDispatches && ledger.scheduledDispatches[recIdStr];
      if (!rec) return { ok: true };
      if (rec.historySynced === true) return { ok: true };
      rec.historySynced = true;
      rec.updatedAt = Date.now();
      ledger.updatedAt = Date.now();
      try {
        writeJsonAtomic(ledgerPath, ledger);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: `写入节流账本失败: ${(err && err.message) || err}`,
        };
      }
    }, options);
  } catch (err) {
    return {
      ok: false,
      code: (err && err.code) || "LEDGER_LOCK_FAILED",
      error: (err && err.message) || String(err),
    };
  }
}

/**
 * 供 server/utils.js 在 pushData update/delete 时同步账本：
 * - delete：同步加跨进程文件锁清理，写盘失败自动重试（最多 3 次），仍失败返回告警对象绝不静默
 * - update：仅同步显式携带 reservationId 或定时任务自身状态变更，绝不按共享 recordId 误删并发任务的预留
 */
function syncLedgerOnPushDataMutation(mutation = {}, options = {}) {
  if (!mutation || mutation.id == null || mutation.id === "") {
    return { ok: true, changed: false };
  }
  const ledgerPath = getPublishThrottleLedgerPath(options);
  if (!fs.existsSync(ledgerPath)) {
    return { ok: true, changed: false };
  }

  if (mutation.type === "delete") {
    const recIdStr = String(mutation.id);
    const resId = mutation.reservationId ? String(mutation.reservationId) : "";
    const maxAttempts =
      typeof options.maxAttempts === "number" &&
      Number.isFinite(options.maxAttempts) &&
      options.maxAttempts >= 1
        ? Math.floor(options.maxAttempts)
        : DELETE_LEDGER_MAX_ATTEMPTS;
    let lastErr = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      try {
        const changed = withPublishThrottleLockSync(() => {
          const { exists, ledger } = readPublishThrottleLedgerRaw(options);
          if (!exists) return false;
          let dirty = false;
          const nextEntries = [];
          for (let i = 0; i < ledger.entries.length; i++) {
            const e = ledger.entries[i];
            if (!e) continue;
            const matchByResId = resId && String(e.id) === resId;
            const matchByRecId =
              e.recordId != null && String(e.recordId) === recIdStr;
            const isRemovable =
              (matchByResId && e.status !== "success") ||
              (matchByRecId &&
                (e.status === "scheduled" ||
                  (mutation.scheduledTask === true && e.status !== "success") ||
                  (!resId && e.status !== "success")));
            if (isRemovable) {
              dirty = true;
              continue;
            }
            nextEntries.push(e);
          }
          if (
            ledger.scheduledDispatches &&
            Object.prototype.hasOwnProperty.call(
              ledger.scheduledDispatches,
              recIdStr
            )
          ) {
            delete ledger.scheduledDispatches[recIdStr];
            dirty = true;
          }
          if (dirty) {
            ledger.entries = nextEntries;
            ledger.updatedAt = Date.now();
            writeJsonAtomic(ledgerPath, ledger);
          }
          return dirty;
        }, options);
        return { ok: true, changed, attempts, retried: attempts > 1 };
      } catch (err) {
        lastErr = err;
        if (err && err.code === "LEDGER_LOCK_TIMEOUT") {
          break;
        }
        if (attempt < maxAttempts) {
          sleepSync(20 * attempt);
        }
      }
    }

    const errMsg =
      (lastErr && lastErr.message) || String(lastErr || "未知错误");
    const warning = `删除任务成功，但节流账本同步失败（已重试 ${attempts} 次）：${errMsg}；后续读取账本时将自动与历史对账清理`;
    console.warn("[publishThrottle]", warning);
    return {
      ok: false,
      changed: false,
      attempts,
      error: errMsg,
      warning,
    };
  }

  if (mutation.type === "update" && mutation.publishStatus) {
    const resId = mutation.reservationId ? String(mutation.reservationId) : "";
    if (resId) {
      settleThrottleByRecordId(
        mutation.id,
        mutation.publishStatus,
        {
          reservationId: resId,
          publishMode: mutation.publishMode,
          publishToDraft: mutation.publishToDraft,
          ts:
            typeof mutation.lastPublishAt === "number"
              ? mutation.lastPublishAt
              : undefined,
        },
        options
      ).catch(() => {});
      return { ok: true };
    }
    if (mutation.scheduledTask === true) {
      settleThrottleByRecordId(
        mutation.id,
        mutation.publishStatus,
        {
          onlyScheduled: true,
          publishMode: mutation.publishMode,
          publishToDraft: mutation.publishToDraft,
          ts:
            typeof mutation.lastPublishAt === "number"
              ? mutation.lastPublishAt
              : undefined,
        },
        options
      ).catch(() => {});
    }
  }
  return { ok: true };
}

/**
 * 注册发布节流设置、排期预览、串行预留与定时创建相关 IPC（供 GUI 调用）。
 */
function registerPublishThrottleIpc(ipcMain, deps = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") return;

  const getChangeData = () => defaultChangeDataFn(deps);

  ipcMain.handle("publish-throttle:get-settings", async () => {
    try {
      const settings = readPublishThrottleSettings(deps);
      return { ok: true, settings };
    } catch (e) {
      return {
        ok: false,
        message: (e && e.message) || String(e),
        settings: sharedThrottle.createDefaultPublishThrottleSettings(),
      };
    }
  });

  ipcMain.handle("publish-throttle:save-settings", async (_event, payload) => {
    try {
      const res = savePublishThrottleSettings(payload, deps);
      if (!res.ok) {
        return { ok: false, message: res.error };
      }
      return { ok: true, settings: res.settings };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle("publish-throttle:reset-settings", async () => {
    try {
      const res = resetPublishThrottleSettings(deps);
      if (!res.ok) {
        return { ok: false, message: res.error };
      }
      return { ok: true, settings: res.settings };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  // 只读排期预览（读账本、校验显式 publishAt 与 60 天搜索上限，不写入预留）
  ipcMain.handle("publish-throttle:plan", async (_event, payload = {}) => {
    try {
      const res = await planAndReservePublishTimes(
        {
          targets: Array.isArray(payload.targets) ? payload.targets : [],
          now:
            typeof payload.now === "number" && Number.isFinite(payload.now)
              ? payload.now
              : Date.now(),
          publishAt: payload.publishAt || null,
          publishAtMs:
            typeof payload.publishAtMs === "number" &&
            Number.isFinite(payload.publishAtMs)
              ? payload.publishAtMs
              : null,
          noThrottle: Boolean(payload.noThrottle),
          dryRun: true,
        },
        deps
      );
      return res;
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  // GUI 确认提交：主进程加锁重算，与预览一致才立刻写账本预留；发生偏移返回 changed:true 让 GUI 再确认
  ipcMain.handle("publish-throttle:commit-plan", async (_event, payload = {}) => {
    try {
      const res = await planAndReservePublishTimes(
        {
          targets: Array.isArray(payload.targets) ? payload.targets : [],
          now:
            typeof payload.now === "number" && Number.isFinite(payload.now)
              ? payload.now
              : Date.now(),
          previewBaseMs:
            typeof payload.previewBaseMs === "number" &&
            Number.isFinite(payload.previewBaseMs)
              ? payload.previewBaseMs
              : null,
          publishAt: payload.publishAt || null,
          publishAtMs:
            typeof payload.publishAtMs === "number" &&
            Number.isFinite(payload.publishAtMs)
              ? payload.publishAtMs
              : null,
          noThrottle: Boolean(payload.noThrottle),
          previewItems: Array.isArray(payload.previewItems)
            ? payload.previewItems
            : null,
          dryRun: false,
        },
        deps
      );
      return res;
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  // GUI 立即任务写盘失败或中止时释放预留
  ipcMain.handle(
    "publish-throttle:release-reservation",
    async (_event, payload = {}) => {
      try {
        const ids =
          payload && Array.isArray(payload.reservationIds)
            ? payload.reservationIds
            : payload && payload.reservationId
            ? [payload.reservationId]
            : [];
        return await releaseThrottleReservation(ids, deps);
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }
  );

  // GUI 立即任务写盘成功后把 recordId 绑定到预留条目并置为 publishing
  ipcMain.handle(
    "publish-throttle:confirm-reservation",
    async (_event, payload = {}) => {
      try {
        if (!payload || !payload.reservationId) return { ok: true };
        return await confirmThrottleReservation(
          payload.reservationId,
          {
            status: payload.status || "publishing",
            recordId: payload.recordId,
            ts: payload.ts,
            isScheduled: payload.isScheduled,
          },
          deps
        );
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }
  );

  ipcMain.handle(
    "publish-throttle:create-scheduled",
    async (_event, payload = {}) => {
      const reservationId =
        (payload && payload.reservationId) ||
        (payload && payload.item && payload.item.throttleReservationId) ||
        null;
      try {
        const changeDataFn = getChangeData();
        const createScheduledRecordFn = deps.createScheduledRecord;
        const notifyScheduledChangedFn = deps.notifyScheduledPublishChanged;
        const findExistingScheduledFn = defaultFindExistingScheduledFn(deps);
        if (typeof createScheduledRecordFn !== "function") {
          if (reservationId) await releaseThrottleReservation(reservationId, deps);
          return { ok: false, message: "定时发布服务未就绪" };
        }

        const rawItem =
          payload && payload.item && typeof payload.item === "object"
            ? payload.item
            : payload;
        const item = { ...(rawItem || {}) };
        if (reservationId) {
          item.throttleReservationId = reservationId;
        }
        const publishAtText =
          (payload && payload.publishAtText) ||
          (item && item.scheduledPublishAtText) ||
          "";
        const publishAtMs =
          payload && Number.isFinite(payload.scheduledPublishAtMs)
            ? payload.scheduledPublishAtMs
            : item && Number.isFinite(item.scheduledPublishAt)
            ? item.scheduledPublishAt
            : null;
        const nowMs = Date.now();
        const scheduledRecord = createScheduledRecordFn(
          item,
          publishAtMs ? { value: publishAtMs, text: publishAtText } : publishAtText,
          nowMs
        );
        if (typeof findExistingScheduledFn === "function") {
          const existing = findExistingScheduledFn(
            readPushDataRecords(changeDataFn),
            scheduledRecord
          );
          if (existing) {
            if (reservationId) {
              await releaseThrottleReservation(reservationId, deps);
            }
            const conflictInfo =
              sharedThrottle.checkExistingScheduledCreativeConflict(
                existing,
                scheduledRecord.creativeStatement
              );
            const existingPublishAt =
              existing.scheduledPublishAtText ||
              sharedThrottle.formatUtc8DateTime(existing.scheduledPublishAt) ||
              scheduledRecord.scheduledPublishAtText;
            if (conflictInfo.conflict) {
              return {
                ok: false,
                status: "needs_attention",
                needsAttention: true,
                duplicate: true,
                id: existing.id || null,
                publishAt: existingPublishAt,
                creativeStatement: conflictInfo.actualCreativeStatement,
                requestedCreativeStatement:
                  conflictInfo.requestedCreativeStatement,
                message: conflictInfo.message,
              };
            }
            return {
              ok: true,
              duplicate: true,
              id: existing.id || null,
              publishAt: existingPublishAt,
              creativeStatement: conflictInfo.actualCreativeStatement,
              message: conflictInfo.message,
            };
          }
        }
        const addRes = changeDataFn({
          fileName: "pushData",
          type: "add",
          item: scheduledRecord,
        });
        if (!addRes || addRes.success !== true) {
          if (reservationId) {
            await releaseThrottleReservation(reservationId, deps);
          }
          return {
            ok: false,
            message:
              (addRes && addRes.message) || "写入定时发布记录失败",
          };
        }
        let recordId = null;
        if (Array.isArray(addRes.data)) {
          const found = [...addRes.data]
            .reverse()
            .find(
              (it) =>
                it.scheduledTask === true &&
                it.scheduledPublishAt === scheduledRecord.scheduledPublishAt &&
                it.textOtherName === scheduledRecord.textOtherName &&
                it.pt === scheduledRecord.pt &&
                it.selectedFile === scheduledRecord.selectedFile &&
                it.textType === scheduledRecord.textType
            );
          if (found) recordId = found.id;
        }

        // 绑定或补记正式发布的账本条目（草稿不进账本）；账本写盘失败则回滚 pushData
        if (!sharedThrottle.isDraftPublishItem(scheduledRecord)) {
          const ledgerRes = reservationId
            ? await confirmThrottleReservation(
                reservationId,
                {
                  status: "scheduled",
                  ts: scheduledRecord.scheduledPublishAt,
                  isScheduled: true,
                  recordId,
                },
                deps
              )
            : await recordThrottleEntryDirect(
                {
                  pt: scheduledRecord.pt,
                  phone: scheduledRecord.phone,
                  partition: scheduledRecord.partition,
                  status: "scheduled",
                  ts: scheduledRecord.scheduledPublishAt,
                  isScheduled: true,
                  recordId,
                },
                deps
              );
          if (!ledgerRes || ledgerRes.ok !== true) {
            if (recordId != null && scheduledRecord.date) {
              try {
                changeDataFn({
                  fileName: "pushData",
                  type: "delete",
                  item: { id: recordId, date: scheduledRecord.date },
                });
              } catch (_) {}
            }
            return {
              ok: false,
              message: (ledgerRes && ledgerRes.error) || "写入节流账本失败",
            };
          }
        }

        if (typeof notifyScheduledChangedFn === "function") {
          notifyScheduledChangedFn();
        }
        return {
          ok: true,
          duplicate: false,
          id: recordId,
          publishAt: scheduledRecord.scheduledPublishAtText,
          creativeStatement: scheduledRecord.creativeStatement || "none",
        };
      } catch (e) {
        if (reservationId) {
          try {
            await releaseThrottleReservation(reservationId, deps);
          } catch (_) {}
        }
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }
  );
}

module.exports = {
  ...sharedThrottle,
  SETTINGS_FILE_NAME,
  LEDGER_FILE_NAME,
  RESERVED_STALE_TTL_MS,
  LEDGER_LOCK_STALE_MS,
  LEDGER_LOCK_TIMEOUT_MS,
  withPublishThrottleLock,
  withPublishThrottleLockSync,
  getPublishThrottleSettingsPath,
  getPublishThrottleLedgerPath,
  getPublishThrottleLedgerLockPath,
  readPublishThrottleSettings,
  savePublishThrottleSettings,
  resetPublishThrottleSettings,
  getDefaultCreativeStatement,
  readPublishThrottleLedger,
  planAndReservePublishTimes,
  confirmThrottleReservation,
  recordThrottleEntryDirect,
  releaseThrottleReservation,
  settleThrottleByRecordId,
  releaseThrottleByRecordId,
  getScheduledTaskDispatchStateSync,
  markScheduledTaskDispatched,
  recordScheduledTaskOutcome,
  markScheduledTaskHistorySynced,
  syncLedgerOnPushDataMutation,
  registerPublishThrottleIpc,
};
