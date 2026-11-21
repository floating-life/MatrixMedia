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
const RESERVED_STALE_TTL_MS = 5 * 60 * 1000;

let tmpWriteSeq = 0;
let reservationSeq = 0;
let throttleLockTail = Promise.resolve();

/** 主进程全局串行排期/账本读写锁（FIFO） */
function withPublishThrottleLock(fn) {
  const run = throttleLockTail.then(
    () => fn(),
    () => fn()
  );
  throttleLockTail = run.then(
    () => {},
    () => {}
  );
  return run;
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
      },
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const entries = Array.isArray(raw && raw.entries) ? raw.entries : [];
    return {
      exists: true,
      ledgerPath,
      ledger: {
        version: 1,
        importedPushData: Boolean(raw && raw.importedPushData),
        updatedAt: Number(raw && raw.updatedAt) || 0,
        entries,
      },
    };
  } catch (err) {
    console.warn(
      "[publishThrottle] 读取节流账本失败，视为空账本:",
      (err && err.message) || err
    );
    return {
      exists: false,
      ledgerPath,
      ledger: {
        version: 1,
        importedPushData: false,
        updatedAt: 0,
        entries: [],
      },
    };
  }
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
 */
function loadActiveLedger(options = {}, nowMs = Date.now(), pushDataRecordsOpt = null) {
  const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
  let didImport = false;
  if (!exists || (!ledger.importedPushData && ledger.entries.length === 0)) {
    const pushRecords = Array.isArray(pushDataRecordsOpt)
      ? pushDataRecordsOpt
      : readPushDataRecords(defaultChangeDataFn(options));
    ledger.entries = buildLegacyLedgerEntriesFromPushData(pushRecords, nowMs);
    ledger.importedPushData = true;
    didImport = true;
  }
  ledger.entries = pruneLedgerEntries(ledger.entries, nowMs);
  return { exists, ledgerPath, ledger, didImport };
}

function readPublishThrottleLedger(options = {}, nowMs = Date.now()) {
  return loadActiveLedger(options, nowMs).ledger;
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
function planAndReservePublishTimes(params = {}, options = {}) {
  return withPublishThrottleLock(async () => {
    const nowMs =
      typeof params.now === "number" && Number.isFinite(params.now)
        ? params.now
        : Date.now();
    const settings = readPublishThrottleSettings(options);
    const dryRun = params.dryRun === true;
    const globalNoThrottle = Boolean(params.noThrottle);
    const rawTargets = Array.isArray(params.targets) ? params.targets : [];

    // 1. 统一按 UTC+8 校验全局与目标级显式 publishAt（过期/非法直接拒绝，GUI/HTTP/CLI 一致）
    let globalExplicitMs = null;
    if (
      params.publishAtMs != null &&
      params.publishAtMs !== "" &&
      Number.isFinite(Number(params.publishAtMs))
    ) {
      const ms = Number(params.publishAtMs);
      if (ms <= nowMs) {
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
      const parsedAt = sharedThrottle.parsePublishAtUtc8(params.publishAt, nowMs);
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

    const preparedTargets = [];
    let needPushDataForReuse = false;

    for (let i = 0; i < rawTargets.length; i++) {
      const t = rawTargets[i] || {};
      const canonicalPt = resolveCanonicalPlatform(t.platform || t.pt);
      const isDraft = sharedThrottle.isDraftPublishItem(t);
      let targetExplicitMs = globalExplicitMs;

      if (
        t.publishAtMs != null &&
        t.publishAtMs !== "" &&
        Number.isFinite(Number(t.publishAtMs))
      ) {
        const ms = Number(t.publishAtMs);
        if (ms <= nowMs) {
          return {
            ok: false,
            code: "EXPIRED_PUBLISH_AT",
            error: "定时发布时间必须是未来时间",
            message: "定时发布时间必须是未来时间",
          };
        }
        targetExplicitMs = ms;
      } else if (t.publishAt != null && String(t.publishAt).trim() !== "") {
        const parsedAt = sharedThrottle.parsePublishAtUtc8(t.publishAt, nowMs);
        if (!parsedAt.ok) {
          return {
            ok: false,
            code: parsedAt.code || "INVALID_PUBLISH_AT",
            error: parsedAt.error,
            message: parsedAt.error,
          };
        }
        targetExplicitMs = parsedAt.value;
      }

      if (targetExplicitMs !== null && !isDraft && t.filePath) {
        needPushDataForReuse = true;
      }

      preparedTargets.push({
        ...t,
        platform: canonicalPt || t.platform || t.pt,
        publishAtMs: targetExplicitMs,
        publishAt:
          targetExplicitMs !== null
            ? sharedThrottle.formatUtc8DateTime(targetExplicitMs)
            : null,
        isDraft,
      });
    }

    // 2. 加载 pushData（仅当需要检查既有定时任务复用或账本首次导入时读取）
    const changeDataFn = defaultChangeDataFn(options);
    const findExistingScheduledFn = defaultFindExistingScheduledFn(options);
    const rawLedgerState = readPublishThrottleLedgerRaw(options);
    const needPushDataForImport =
      !rawLedgerState.exists ||
      (!rawLedgerState.ledger.importedPushData &&
        rawLedgerState.ledger.entries.length === 0);
    const pushDataRecords =
      needPushDataForReuse || needPushDataForImport
        ? readPushDataRecords(changeDataFn)
        : null;

    // 2b. 改标题复用同文件同时刻的定时任务：排期前命中既有待发任务则直接复用，不再节流顺延（#1）
    if (
      needPushDataForReuse &&
      typeof findExistingScheduledFn === "function" &&
      Array.isArray(pushDataRecords) &&
      pushDataRecords.length > 0
    ) {
      for (let i = 0; i < preparedTargets.length; i++) {
        const t = preparedTargets[i];
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

    // 3. 排期只读账本（首次空账本一次性导入历史 pushData）
    const { ledgerPath, ledger } = loadActiveLedger(
      options,
      nowMs,
      pushDataRecords
    );

    const plan = sharedThrottle.planPublishTimes({
      targets: preparedTargets,
      now: nowMs,
      records: ledger.entries,
      settings,
      noThrottle: globalNoThrottle,
      maxLookaheadDays: params.maxLookaheadDays,
      scheduledExpireGraceMs: sharedThrottle.SCHEDULED_EXPIRE_GRACE_MS,
    });

    // 4. 搜索超限（「排期已满」）处理（#13）
    if (!plan.ok && !params.allowPartialError) {
      return {
        ok: false,
        code: "SCHEDULE_FULL",
        error: plan.error,
        message: plan.error,
        ...plan,
      };
    }

    // 5. GUI 确认时与预览对比：发生偏移则把新计划返回 GUI 重新确认，不得拿旧预览提交（#6）
    if (
      !dryRun &&
      !globalNoThrottle &&
      Array.isArray(params.previewItems) &&
      sharedThrottle.comparePlanForGuiDrift(params.previewItems, plan.items)
    ) {
      return {
        ok: true,
        changed: true,
        reservationIds: [],
        message: "期间有新的发布任务，排期已更新，请重新确认最新排期",
        ...plan,
      };
    }

    if (dryRun) {
      return {
        ok: plan.ok,
        changed: false,
        reservationIds: [],
        ...plan,
      };
    }

    // 6. 写账本预留（仅正式发布且非复用的条目进账本；草稿绝不进账本）
    const reservationIds = [];
    for (let i = 0; i < plan.items.length; i++) {
      const item = plan.items[i];
      if (!item || item.ok !== true || item.isDraft || item.reusedScheduled) {
        if (item) item.reservationId = null;
        continue;
      }
      const resId = createReservationId(nowMs);
      item.reservationId = resId;
      reservationIds.push(resId);
      ledger.entries.push({
        id: resId,
        bucketKey: item.accountKey,
        platform: item.platform,
        partition: item.partition,
        phone: item.phone,
        status: "reserved",
        ts: Math.max(nowMs, item.plannedAtMs),
        isScheduled: Boolean(item.scheduled),
        recordId: null,
        createdAt: nowMs,
        updatedAt: nowMs,
      });
    }

    if (reservationIds.length > 0) {
      ledger.importedPushData = true;
      ledger.updatedAt = nowMs;
      try {
        writeJsonAtomic(ledgerPath, ledger);
      } catch (err) {
        const msg = `写入节流账本失败: ${(err && err.message) || err}`;
        return {
          ok: false,
          code: "LEDGER_WRITE_FAILED",
          error: msg,
          message: msg,
        };
      }
    }

    return {
      ok: true,
      changed: false,
      reservationIds,
      ...plan,
    };
  });
}

/**
 * 确认/更新已预留的账本条目状态（publishing / scheduled / success）并绑定 recordId。
 */
function confirmThrottleReservation(reservationId, patch = {}, options = {}) {
  return withPublishThrottleLock(async () => {
    if (!reservationId) return { ok: true };
    const nowMs = Date.now();
    const { ledgerPath, ledger } = loadActiveLedger(options, nowMs);
    const entry = ledger.entries.find((e) => e && e.id === reservationId);
    if (!entry) return { ok: true };

    if (patch.status) {
      const st = String(patch.status).trim().toLowerCase();
      if (!ACTIVE_LEDGER_STATUSES.has(st)) {
        // 转为失败/草稿/取消/过期等非计数状态时直接释放
        ledger.entries = ledger.entries.filter((e) => e && e.id !== reservationId);
      } else {
        entry.status = st;
        if (typeof patch.ts === "number" && Number.isFinite(patch.ts) && patch.ts > 0) {
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
      if (typeof patch.ts === "number" && Number.isFinite(patch.ts) && patch.ts > 0) {
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
  });
}

/**
 * 直接向账本追加一条正式发布记录（用于绕过 commit-plan 直接调 create-scheduled IPC 等场景）。
 */
function recordThrottleEntryDirect(entryInput, options = {}) {
  return withPublishThrottleLock(async () => {
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
      status: entryInput.status || (entryInput.isScheduled ? "scheduled" : "publishing"),
      ts,
      isScheduled: Boolean(entryInput.isScheduled),
      recordId: entryInput.recordId != null ? String(entryInput.recordId) : null,
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
  });
}

/**
 * 释放一条或多条账本预留（失败 / 取消 / 过期 / 转草稿 / 写盘回滚时调用）。
 */
function releaseThrottleReservation(reservationIdOrList, options = {}) {
  return withPublishThrottleLock(async () => {
    const ids = Array.isArray(reservationIdOrList)
      ? reservationIdOrList.filter(Boolean).map(String)
      : reservationIdOrList
      ? [String(reservationIdOrList)]
      : [];
    if (ids.length === 0) return { ok: true, removed: 0 };

    const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
    if (!exists) return { ok: true, removed: 0 };
    const idSet = new Set(ids);
    const before = ledger.entries.length;
    ledger.entries = ledger.entries.filter((e) => !e || !idSet.has(String(e.id)));
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
  });
}

/**
 * 按 pushData 记录 id 释放或更新尚未终结（reserved / publishing / scheduled）的账本条目。
 * 注意：绝不触碰历史上已 success 的旧条目，避免同文件复用 recordId 时误删历史次数（#7）。
 */
function settleThrottleByRecordId(recordId, nextStatus, extra = {}, options = {}) {
  return withPublishThrottleLock(async () => {
    if (recordId == null || recordId === "") return { ok: true, changed: false };
    const { exists, ledgerPath, ledger } = readPublishThrottleLedgerRaw(options);
    if (!exists) return { ok: true, changed: false };

    const recIdStr = String(recordId);
    const st = String(nextStatus || "").trim().toLowerCase();
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
        if (
          e &&
          e.recordId != null &&
          String(e.recordId) === recIdStr &&
          e.status !== "success"
        ) {
          changed = true;
          continue;
        }
        nextEntries.push(e);
      }
      ledger.entries = nextEntries;
    } else if (st === "success" || st === "published") {
      // 只更新最近一条未终结的活跃条目
      for (let i = ledger.entries.length - 1; i >= 0; i--) {
        const e = ledger.entries[i];
        if (
          e &&
          e.recordId != null &&
          String(e.recordId) === recIdStr &&
          e.status !== "success"
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
        if (
          e &&
          e.recordId != null &&
          String(e.recordId) === recIdStr &&
          (e.status === "reserved" || e.status === "scheduled")
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
  });
}

function releaseThrottleByRecordId(recordId, options = {}) {
  return settleThrottleByRecordId(recordId, "cancelled", {}, options);
}

/**
 * 供 server/utils.js 在 pushData update/delete 时惰性同步账本：
 * 仅在账本文件已存在时排队更新，不在无账本的测试/场景里额外建文件。
 */
function syncLedgerOnPushDataMutation(mutation = {}, options = {}) {
  try {
    if (!mutation || mutation.id == null || mutation.id === "") return;
    const ledgerPath = getPublishThrottleLedgerPath(options);
    if (!fs.existsSync(ledgerPath)) return;
    if (mutation.type === "delete") {
      settleThrottleByRecordId(mutation.id, "delete", {}, options).catch(() => {});
      return;
    }
    if (mutation.type === "update" && mutation.publishStatus) {
      settleThrottleByRecordId(
        mutation.id,
        mutation.publishStatus,
        {
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
  } catch (_) {
    /* ignore */
  }
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
  withPublishThrottleLock,
  getPublishThrottleSettingsPath,
  getPublishThrottleLedgerPath,
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
  syncLedgerOnPushDataMutation,
  registerPublishThrottleIpc,
};
