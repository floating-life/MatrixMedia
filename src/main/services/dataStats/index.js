"use strict";

/**
 * 数据统计 IPC 入口。
 *
 * - stats:collect              采集一组账号（串行队列，账号间间隔防风控），进度经 stats:progress 推送
 * - stats:auto-run             定时自动采集单一操作（支持 daily 按日 / interval 按槽；检查 auto-run.json → 互斥 → 采集 → 落盘）
 * - stats:get-data             读取单账号本地数据（daily + works + meta）
 * - stats:get-overview         全账号按日聚合（所有账号总览页）
 * - stats:get-content-summary  跨平台作品汇总（作品汇总 tab）
 * - stats:get-content-trend    单条内容各平台播放走势（作品汇总 tab 趋势弹窗-按天）
 * - stats:get-content-intraday 单条内容各平台分时段播放走势（作品汇总 tab 趋势弹窗-按时段）
 * - stats:get-analysis         规则数据分析（数据分析 tab，与 Excel「分析」sheet 共用计算函数）
 * - stats:save-chart-image     保存单张图表 PNG 图片（含 dataUrl 与大小校验、保存对话框）
 * - stats:save-chart-images-batch 批量导出全部图表 PNG 到选定目录（一次目录选择对话框）
 * - stats:get-link-overrides   读取作品关联手工矫正配置
 * - stats:set-link-override    设置单条作品手工关联（assign / detach）
 * - stats:merge-works          合并多条未关联作品为同一 manual 内容
 * - stats:clear-link-override  清除单条作品手工矫正，恢复自动匹配
 * - stats:apply-link-overrides 批量原子应用多条手工矫正操作（assign / detach / clear / merge），一次写盘
 * - stats:delete-contents      批量隐藏/删除内容行（写入 deletedContents，不物理删快照）
 * - stats:restore-contents     批量恢复已隐藏/删除的内容行（从 deletedContents 移除）
 * - stats:export-xlsx          导出统计 Excel 工作簿（含本地页面校验与保存对话框）
 * - stats:match-works          发布状态匹配（与采集共享 collecting 互斥锁）
 *
 * 采集全程使用平台页面上下文 fetch（复用分组 partition 登录态），不做任何签名构造。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const electron = require("electron");
const { ipcMain } = electron;
const { collectAccount } = require("./collector");
const store = require("./store");
const { handleAccountCollectOutcome } = require("./collectAlert");
const {
  normalizeStatusTitle,
  buildTitleIndex,
  isValidAutoContentKey,
  isValidManualContentKey,
  isUnstableRecordKey,
  isValidDeletableContentKey,
  isValidWorkIdentityKey,
  isContentRowDeleted,
} = require("./contentLink");
const {
  validateExportDateRange,
  assertExportRangeNotAllFuture,
  buildDefaultExportFileName,
  resolveLinkValidationContext,
  resolveDeleteContentSnapshots,
  buildContentSummaryData,
  buildContentTrendData,
  buildContentIntradayData,
  buildStatsAnalysisData,
  buildStatsWorkbookData,
  writeStatsXlsx,
} = require("./statsExport");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LINK_OVERRIDES_READ_ERROR_MESSAGE =
  store.LINK_OVERRIDES_READ_ERROR_MESSAGE || "读取手工矫正配置失败，请稍后重试";

function isLinkOverridesReadErr(err) {
  if (typeof store.isLinkOverridesReadError === "function" && store.isLinkOverridesReadError(err)) {
    return true;
  }
  return Boolean(err && typeof err === "object" && err.isLinkOverridesReadError === true);
}

const VALID_TRIGGERS = new Set(["auto", "manual"]);
const VALID_INTERVAL_HOURS = new Set([1, 2, 3, 4, 6]);
const RATE_LIMIT_GRACE_MINUTES = 10;
const SLOT_STR_RE = /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
const TIME_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_HHMM_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHART_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CHART_IMAGE_B64_CHARS = Math.ceil(MAX_CHART_IMAGE_BYTES / 3) * 4;
const MAX_BATCH_CHART_IMAGES = 30;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let collecting = false;
let cancelled = false;
let collectedToday = { date: "", partitions: new Set() };
// 每个分区最近一次成功采集时间戳（手动与自动共用，用于同槽 [槽开始, 下一槽开始) 跳重）
const lastCollectedAtByPartition = new Map();
const MAX_COLLECTED_PARTITIONS = 1024;
// 本进程内全局与各分区最近一次自动采集时间戳（用于防高频硬下限）
let lastGlobalAutoRunAt = 0;
const lastAutoRunAtByPartition = new Map();
// 本进程内已因高频跳过且不再重复触发的槽
const skippedAutoSlots = new Set();
// 最近一次在 stats:auto-run 中观察到的 interval 调度参数（用于兜底检测未走 save-auto-settings 的参数变化）
let lastSeenAutoRunSchedule = null;
let lastRetentionDays = store.DEFAULT_INTRADAY_RETENTION_DAYS || 60;
// auto-run.json 读写失败时的兜底：本进程内已自动跑过的日期/时段槽（防止持久化失败导致每分钟重采）
const autoRanInMemory = new Set();
// link-overrides.json 串行写入队列：保证并发 set/merge/clear 顺序执行不丢写
let overrideWriteChain = Promise.resolve();

function enqueueOverrideWrite(fn) {
  const run = () => Promise.resolve().then(fn);
  const next = overrideWriteChain.then(run, run);
  overrideWriteChain = next.catch(() => {});
  return next;
}

function toPlainOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc && desc.value && typeof desc.value === "object") {
      Object.defineProperty(out, key, {
        value: { ...desc.value },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

function toPlainBoolMap(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc && desc.value === true) {
      Object.defineProperty(out, key, {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

function cloneNoProtoMap(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc && desc.value && typeof desc.value === "object" && !Array.isArray(desc.value)) {
      out[key] = { ...desc.value };
    }
  }
  return out;
}

function cloneNoProtoBoolMap(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    if (desc && desc.value === true) {
      out[key] = true;
    }
  }
  return out;
}

function normalizeDeletedContentEntryForIpc(val) {
  if (
    !val ||
    typeof val !== "object" ||
    Array.isArray(val) ||
    typeof val.deletedAt !== "number" ||
    !Number.isFinite(val.deletedAt) ||
    val.deletedAt < 0
  ) {
    return null;
  }
  const entry = { deletedAt: val.deletedAt };
  if (Object.prototype.hasOwnProperty.call(val, "title") && typeof val.title === "string") {
    const trimmed = val.title.trim();
    if (trimmed) entry.title = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(val, "pwKeys") && Array.isArray(val.pwKeys)) {
    const seen = new Set();
    const pwKeys = [];
    for (const k of val.pwKeys) {
      if (!isValidWorkIdentityKey(k) || seen.has(k)) continue;
      seen.add(k);
      pwKeys.push(k);
    }
    pwKeys.sort();
    entry.pwKeys = pwKeys;
  }
  return entry;
}

function toPlainDeletedContents(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!isValidDeletableContentKey(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    const normalized = normalizeDeletedContentEntryForIpc(desc ? desc.value : null);
    if (normalized) {
      Object.defineProperty(out, key, {
        value: normalized,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return out;
}

function cloneNoProtoDeletedContents(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (!isValidDeletableContentKey(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(raw, key);
    const normalized = normalizeDeletedContentEntryForIpc(desc ? desc.value : null);
    if (normalized) {
      out[key] = normalized;
    }
  }
  return out;
}

function normalizeContentKeysArg(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("参数无效");
  }
  let rawList = null;
  if (Array.isArray(args.contentKeys)) {
    rawList = args.contentKeys;
  } else if (typeof args.contentKey === "string") {
    rawList = [args.contentKey];
  } else {
    throw new Error("contentKeys 必须为非空数组");
  }
  if (!rawList.length) {
    throw new Error("contentKeys 不能为空");
  }
  const uniqueKeys = [];
  const seen = new Set();
  for (let i = 0; i < rawList.length; i++) {
    const raw = rawList[i];
    if (typeof raw !== "string") {
      throw new Error(`第 ${i + 1} 条 contentKey 无效`);
    }
    const ck = raw.trim();
    if (!isValidDeletableContentKey(ck)) {
      throw new Error(`第 ${i + 1} 条 contentKey 无效`);
    }
    if (seen.has(ck)) continue;
    seen.add(ck);
    uniqueKeys.push(ck);
  }
  if (!uniqueKeys.length) {
    throw new Error("contentKeys 不能为空");
  }
  return uniqueKeys;
}

function normalizeOverrideOps(rawOps) {
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new Error("ops 必须为非空数组");
  }
  const normalized = [];
  for (let i = 0; i < rawOps.length; i++) {
    const op = rawOps[i];
    if (!op || typeof op !== "object" || Array.isArray(op)) {
      throw new Error(`第 ${i + 1} 条操作参数无效`);
    }
    const kind =
      typeof op.action === "string"
        ? op.action.trim()
        : typeof op.type === "string"
        ? op.type.trim()
        : "";
    if (kind === "assign") {
      const workKey = typeof op.workKey === "string" ? op.workKey : "";
      const contentKey = typeof op.contentKey === "string" ? op.contentKey.trim() : "";
      if (!workKey) throw new Error("workKey 不能为空");
      if (!contentKey || contentKey.startsWith("unlinked:")) {
        throw new Error("assign 操作需提供有效的 contentKey");
      }
      normalized.push({ action: "assign", workKey, contentKey });
    } else if (kind === "detach") {
      const workKey = typeof op.workKey === "string" ? op.workKey : "";
      if (!workKey) throw new Error("workKey 不能为空");
      normalized.push({ action: "detach", workKey });
    } else if (kind === "clear") {
      const workKey = typeof op.workKey === "string" ? op.workKey : "";
      if (!workKey) throw new Error("workKey 不能为空");
      normalized.push({ action: "clear", workKey });
    } else if (kind === "merge") {
      if (!Array.isArray(op.workKeys)) {
        throw new Error("workKeys 必须为数组");
      }
      const uniqueKeys = [];
      const seen = new Set();
      for (const k of op.workKeys) {
        if (typeof k !== "string" || !k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        uniqueKeys.push(k);
      }
      if (uniqueKeys.length < 2) {
        throw new Error("至少需要选择 2 条作品才能合并");
      }
      const title = typeof op.title === "string" ? op.title.trim() : "";
      normalized.push({ action: "merge", workKeys: uniqueKeys, title });
    } else {
      throw new Error("不支持的手工矫正操作类型（仅支持 assign/detach/clear/merge）");
    }
  }
  return normalized;
}

function pickMergedWorksTitle(pwKeys, workInfoByPwKey, explicitTitle) {
  if (explicitTitle) return explicitTitle;
  const list = pwKeys
    .map((pwKey) => workInfoByPwKey.get(pwKey))
    .filter(Boolean)
    .sort((a, b) => {
      const aHas = a.pubMs !== null;
      const bHas = b.pubMs !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && a.pubMs !== b.pubMs) return a.pubMs - b.pubMs;
      return a.pwKey < b.pwKey ? -1 : a.pwKey > b.pwKey ? 1 : 0;
    });
  const chosen = list.find((o) => o.fromWorksJson && o.rawTitle) || list[0];
  return (chosen && chosen.title) || "(无标题)";
}

/**
 * 将请求中的 workKey（规范作品身份 `platform|workId`，或兼容观测键 `group|platform|workId`）
 * 归一解析为作品身份 `platform|workId`。
 */
function resolveOpWorkIdentity(
  rawKey,
  ctx,
  workingOverrides,
  allowMissing = false,
  workingExcludedAuto = null
) {
  if (typeof rawKey !== "string" || !rawKey) return null;
  if (ctx.workInfoByPwKey.has(rawKey)) return rawKey;
  if (ctx.pwKeyByObsWorkKey.has(rawKey)) return ctx.pwKeyByObsWorkKey.get(rawKey);
  if (allowMissing) {
    if (isValidWorkIdentityKey(rawKey)) return rawKey;
    const firstPipe = rawKey.indexOf("|");
    if (firstPipe > 0) {
      const candidate = rawKey.slice(firstPipe + 1);
      if (
        isValidWorkIdentityKey(candidate) &&
        (Object.prototype.hasOwnProperty.call(workingOverrides, candidate) ||
          (workingExcludedAuto &&
            Object.prototype.hasOwnProperty.call(workingExcludedAuto, candidate)))
      ) {
        return candidate;
      }
    }
  }
  return null;
}

function applyOverrideOpsSync(rawOps, exportDeps) {
  const ops = normalizeOverrideOps(rawOps);
  const current = store.readLinkOverrides({ strict: true });
  const workingDoc = {
    version: current.version,
    updatedAt: current.updatedAt,
    contents: cloneNoProtoMap(current.contents),
    excludedAuto: cloneNoProtoBoolMap(current.excludedAuto),
    deletedContents: cloneNoProtoDeletedContents(current.deletedContents),
    overrides: cloneNoProtoMap(current.overrides),
  };

  // 复用汇总的截至日读取路径（传 exportDeps 而非 { store }，走 store.readWorksDailyLatestAsOf 不加载全量历史）
  const ctx = resolveLinkValidationContext({ linkOverrides: current }, exportDeps);
  const now = Date.now();
  const createdContentKeys = [];
  const resolvedWorkKeys = [];
  const expectedFinalByPwKey = new Map();

  let state = null;
  let stateDirty = true;
  const ensureState = () => {
    if (!state || stateDirty) {
      state = ctx.evaluate(workingDoc);
      stateDirty = false;
    }
    return state;
  };

  // 按顺序在内存状态上逐条应用并校验（后一条基于前一条应用后的状态）
  for (const op of ops) {
    if (op.action === "detach") {
      const pwKey = resolveOpWorkIdentity(op.workKey, ctx, workingDoc.overrides, false);
      if (!pwKey) {
        throw new Error(`作品不存在或未纳入当前统计范围：${op.workKey}`);
      }
      workingDoc.excludedAuto[pwKey] = true;
      workingDoc.overrides[pwKey] = { action: "detach" };
      stateDirty = true;
      expectedFinalByPwKey.set(pwKey, { action: "detach" });
      resolvedWorkKeys.push(pwKey);
    } else if (op.action === "clear") {
      const pwKey = resolveOpWorkIdentity(
        op.workKey,
        ctx,
        workingDoc.overrides,
        true,
        workingDoc.excludedAuto
      );
      if (!pwKey) {
        throw new Error(`无效的作品标识：${op.workKey}`);
      }
      delete workingDoc.overrides[pwKey];
      delete workingDoc.excludedAuto[pwKey];
      stateDirty = true;
      expectedFinalByPwKey.set(pwKey, { action: "clear" });
      resolvedWorkKeys.push(pwKey);
    } else if (op.action === "assign") {
      const pwKey = resolveOpWorkIdentity(op.workKey, ctx, workingDoc.overrides, false);
      if (!pwKey) {
        throw new Error(`作品不存在或未纳入当前统计范围：${op.workKey}`);
      }
      const ck = op.contentKey;
      if (isUnstableRecordKey(ck) || ctx.unstableRecordKeys.has(ck)) {
        throw new Error("该记录缺少稳定标识，不能作为手工合并目标");
      }
      if (isValidAutoContentKey(ck)) {
        if (!workingDoc.contents[ck]) {
          const curState = ensureState();
          const cluster = curState.autoClusters.get(ck);
          if (!cluster) {
            throw new Error(`目标自动聚类内容不存在或已失效：${ck}`);
          }
          workingDoc.contents[ck] = {
            title: cluster.title || "(无标题)",
            createdAt: now,
          };
        }
      } else if (isValidManualContentKey(ck)) {
        if (!workingDoc.contents[ck]) {
          throw new Error(`目标手工合并内容不存在：${ck}`);
        }
      } else if (!ctx.eligibleAssignableKeys.has(ck)) {
        throw new Error(`目标内容不存在或不可用：${ck}`);
      }
      // 保留既有 excludedAuto 状态：已拆出作品再手工 assign 仍在 ③④ 中排除，不得打散其他作品自动结果
      workingDoc.overrides[pwKey] = { action: "assign", contentKey: ck };
      stateDirty = true;
      expectedFinalByPwKey.set(pwKey, { action: "assign", contentKey: ck });
      resolvedWorkKeys.push(pwKey);
    } else if (op.action === "merge") {
      const curState = ensureState();
      const uniquePwKeys = [];
      const seenPw = new Set();
      for (const wk of op.workKeys) {
        const pwKey = resolveOpWorkIdentity(wk, ctx, workingDoc.overrides, false);
        if (!pwKey) {
          throw new Error(`待合并作品不存在或未纳入当前统计范围：${wk}`);
        }
        if (seenPw.has(pwKey)) continue;
        seenPw.add(pwKey);
        uniquePwKeys.push(pwKey);
      }
      if (uniquePwKeys.length < 2) {
        throw new Error("至少需要选择 2 条不同作品才能合并");
      }
      for (const pwKey of uniquePwKeys) {
        const cur = curState.byWorkIdentity.get(pwKey);
        if (cur && cur.contentKey != null) {
          throw new Error(`待合并作品已关联其他内容，请刷新后重试：${pwKey}`);
        }
      }
      const contentKey = `manual:${crypto.randomBytes(8).toString("hex")}`;
      const title = pickMergedWorksTitle(uniquePwKeys, ctx.workInfoByPwKey, op.title);
      workingDoc.contents[contentKey] = { title, createdAt: now };
      for (const pwKey of uniquePwKeys) {
        // 保留既有 excludedAuto 状态（如已被拆出的作品参与手工合并时，继续排除于 ③④ 之外）
        workingDoc.overrides[pwKey] = { action: "assign", contentKey };
        expectedFinalByPwKey.set(pwKey, { action: "assign", contentKey });
      }
      stateDirty = true;
      createdContentKeys.push({ contentKey, workKeys: uniquePwKeys, title });
      resolvedWorkKeys.push(...uniquePwKeys);
    }
  }

  // 写盘前按全量分组重新计算并校验最终归属与请求一致，不一致则不写盘并返回错误
  const finalState = ensureState();
  for (const [pwKey, expected] of expectedFinalByPwKey.entries()) {
    const finalEntry = finalState.byWorkIdentity.get(pwKey) || null;
    if (expected.action === "assign") {
      if (
        !finalEntry ||
        finalEntry.contentKey !== expected.contentKey ||
        finalEntry.matchedBy !== "manual"
      ) {
        throw new Error(`操作后作品最终归属与请求不一致：${pwKey}`);
      }
    } else if (expected.action === "detach") {
      if (
        !finalEntry ||
        finalEntry.contentKey !== null ||
        finalEntry.matchedBy !== "manual-detach" ||
        workingDoc.excludedAuto[pwKey] !== true
      ) {
        throw new Error(`拆出后作品最终归属与请求不一致：${pwKey}`);
      }
    } else if (expected.action === "clear") {
      if (
        Object.prototype.hasOwnProperty.call(workingDoc.overrides, pwKey) ||
        Object.prototype.hasOwnProperty.call(workingDoc.excludedAuto, pwKey)
      ) {
        throw new Error(`恢复自动后作品仍残留手动覆盖：${pwKey}`);
      }
      if (
        ctx.workInfoByPwKey.has(pwKey) &&
        finalEntry &&
        (finalEntry.matchedBy === "manual" || finalEntry.matchedBy === "manual-detach")
      ) {
        throw new Error(`恢复自动后作品仍残留手动覆盖：${pwKey}`);
      }
    }
  }

  const doc = store.writeLinkOverrides(
    {
      overrides: workingDoc.overrides,
      contents: workingDoc.contents,
      excludedAuto: workingDoc.excludedAuto,
      deletedContents: workingDoc.deletedContents,
    },
    now
  );
  return {
    doc,
    applied: ops.length,
    createdContentKeys,
    resolvedWorkKeys,
  };
}

function getTodayStr(now = Date.now()) {
  if (typeof store.todayStr === "function") {
    return store.todayStr(now);
  }
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function normalizePartition(partition) {
  return typeof partition === "string" ? partition.trim() : "";
}

function syncCollectedToday(date) {
  if (collectedToday.date !== date) {
    collectedToday = { date, partitions: new Set() };
  }
}

function parseSlotStartMs(slot) {
  if (typeof slot !== "string") return null;
  const m = SLOT_STR_RE.exec(slot.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const utcMs = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d
  ) {
    return null;
  }
  return utcMs - 8 * 3600e3;
}

function setBoundedMap(map, key, val, maxSize) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > maxSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) map.delete(oldestKey);
  }
}

function markPartitionCollected(partition, collectedAtMs = Date.now(), isAuto = false) {
  const key = normalizePartition(partition);
  if (!key) return;
  const ts =
    typeof collectedAtMs === "number" && Number.isFinite(collectedAtMs) && collectedAtMs > 0
      ? collectedAtMs
      : Date.now();
  syncCollectedToday(getTodayStr(ts));
  collectedToday.partitions.add(key);
  setBoundedMap(lastCollectedAtByPartition, key, ts, MAX_COLLECTED_PARTITIONS);
  if (isAuto) {
    setBoundedMap(lastAutoRunAtByPartition, key, ts, MAX_COLLECTED_PARTITIONS);
  }
}

function hasPartitionCollected(partition, date = getTodayStr()) {
  const key = normalizePartition(partition);
  if (!key) return false;
  syncCollectedToday(date);
  return collectedToday.partitions.has(key);
}

/**
 * 判断该分区最近一次成功采集时间（手动与自动共用）是否落在当前槽 [slotStartMs, slotEndMs) 内。
 */
function hasPartitionCollectedInSlot(partition, slotStartMs, slotEndMs) {
  const key = normalizePartition(partition);
  if (!key || !Number.isFinite(slotStartMs)) return false;
  const lastAt = lastCollectedAtByPartition.get(key);
  if (typeof lastAt !== "number" || !Number.isFinite(lastAt)) return false;
  if (lastAt < slotStartMs) return false;
  if (Number.isFinite(slotEndMs) && lastAt >= slotEndMs) return false;
  return true;
}

function hasPartitionAutoRanRecently(partition, nowMs, minIntervalMs, persistedMap) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) return false;
  const key = normalizePartition(partition);
  if (!key) return false;
  let lastAutoAt = 0;
  const memTs = lastAutoRunAtByPartition.get(key);
  if (typeof memTs === "number" && Number.isFinite(memTs) && memTs > 0 && memTs <= nowMs) {
    lastAutoAt = Math.max(lastAutoAt, memTs);
  }
  if (persistedMap && typeof persistedMap === "object") {
    const desc = Object.getOwnPropertyDescriptor(persistedMap, key);
    const diskTs = desc ? desc.value : null;
    if (typeof diskTs === "number" && Number.isFinite(diskTs) && diskTs > 0 && diskTs <= nowMs) {
      lastAutoAt = Math.max(lastAutoAt, diskTs);
    }
  }
  return lastAutoAt > 0 && nowMs - lastAutoAt < minIntervalMs;
}

function normalizeRetentionDaysArg(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 3650) return n;
  return null;
}

function normalizeIntervalHoursArg(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && VALID_INTERVAL_HOURS.has(n)) return n;
  return null;
}

function resolveEffectiveRetentionDays() {
  const persisted =
    typeof store.readAutoSettings === "function"
      ? store.readAutoSettings()
      : { retentionDays: store.DEFAULT_INTRADAY_RETENTION_DAYS || 60 };
  const persistedDays =
    normalizeRetentionDaysArg(persisted && persisted.retentionDays) ||
    store.DEFAULT_INTRADAY_RETENTION_DAYS ||
    60;
  lastRetentionDays = persistedDays;
  return persistedDays;
}

function resolveEffectiveIntervalHours(args, autoSettings, slotStartMs, rawSlotEndMs) {
  const argHours = normalizeIntervalHoursArg(args && args.intervalHours);
  if (argHours !== null) return argHours;
  if (autoSettings && autoSettings.mode === "interval") {
    const cfgHours = normalizeIntervalHoursArg(autoSettings.intervalHours);
    if (cfgHours !== null) return cfgHours;
  }
  const slotEndMs =
    rawSlotEndMs !== undefined && rawSlotEndMs !== null ? Number(rawSlotEndMs) : NaN;
  if (Number.isFinite(slotStartMs) && Number.isFinite(slotEndMs) && slotEndMs > slotStartMs) {
    const diffHours = (slotEndMs - slotStartMs) / 3600000;
    if (Number.isInteger(diffHours) && VALID_INTERVAL_HOURS.has(diffHours)) {
      return diffHours;
    }
  }
  return (
    normalizeIntervalHoursArg(autoSettings && autoSettings.intervalHours) || 2
  );
}

function resolveEffectiveSlotEndMs(args, slotStartMs, intervalHours) {
  const rawEnd =
    args && args.slotEndMs !== undefined && args.slotEndMs !== null
      ? Number(args.slotEndMs)
      : NaN;
  if (Number.isFinite(rawEnd) && rawEnd > slotStartMs) {
    return rawEnd;
  }
  return slotStartMs + intervalHours * 3600000;
}

async function collectAccounts(accounts, sender, options = {}) {
  const results = [];
  const total = accounts.length;
  const startedAt = Date.now();
  const isAutoTrigger = Boolean(options && options.trigger === "auto");
  const skipCollectedToday = Boolean(options && options.skipCollectedToday);
  const slot =
    options && typeof options.slot === "string" ? options.slot.trim() : "";
  const slotStartMs =
    options && Number.isFinite(options.slotStartMs)
      ? options.slotStartMs
      : slot
      ? parseSlotStartMs(slot)
      : null;
  const slotEndMs =
    options && Number.isFinite(options.slotEndMs) ? options.slotEndMs : null;
  const skipCollectedSlot = Boolean(
    options && options.skipCollectedSlot && slot && Number.isFinite(slotStartMs)
  );
  const minAutoIntervalMs =
    isAutoTrigger && options && Number.isFinite(options.minAutoIntervalMs)
      ? options.minAutoIntervalMs
      : 0;
  const persistedPartitionAutoRunAt =
    options && options.persistedPartitionAutoRunAt
      ? options.persistedPartitionAutoRunAt
      : null;
  const onAutoCollectInitiated =
    isAutoTrigger && options && typeof options.onAutoCollectInitiated === "function"
      ? options.onAutoCollectInitiated
      : null;
  const collectedAutoPartitions = Object.create(null);
  const attemptedAutoPartitions = Object.create(null);
  // 一轮采集内同一个「平台 + 账号」的告警状态只计一次，防止重复累加或互清
  const roundAlertCounted = new Set();
  let firstAutoAttemptAt = 0;
  let hasCollectedAny = false;

  for (let i = 0; i < total; i++) {
    if (cancelled) break;
    const acc = accounts[i];
    if (!acc || typeof acc !== "object") continue;

    const progress = (status, extra = {}) => {
      try {
        if (sender && typeof sender.send === "function") {
          sender.send("stats:progress", {
            index: i,
            total,
            group: acc.group,
            platform: acc.platform,
            status,
            ...extra,
          });
        }
      } catch (_) {
        /* 窗口可能已关闭 */
      }
    };

    const nowCheck = Date.now();
    const skippedBySlot = skipCollectedSlot
      ? hasPartitionCollectedInSlot(acc.partition, slotStartMs, slotEndMs)
      : skipCollectedToday
      ? hasPartitionCollected(acc.partition)
      : false;
    const skippedByRateLimit =
      !skippedBySlot &&
      isAutoTrigger &&
      minAutoIntervalMs > 0 &&
      hasPartitionAutoRanRecently(
        acc.partition,
        nowCheck,
        minAutoIntervalMs,
        persistedPartitionAutoRunAt
      );
    if (skippedBySlot || skippedByRateLimit) {
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        skipped: true,
        ...(skippedByRateLimit ? { skipReason: "rate-limited" } : {}),
      });
      progress("skipped");
      continue;
    }

    if (hasCollectedAny) {
      await sleep(2000); // 账号间间隔
      if (cancelled) break;
    }
    hasCollectedAny = true;

    const attemptNow = Date.now();
    if (isAutoTrigger) {
      if (!firstAutoAttemptAt) firstAutoAttemptAt = attemptNow;
      const normPart = normalizePartition(acc.partition);
      if (normPart) {
        attemptedAutoPartitions[normPart] = attemptNow;
        setBoundedMap(lastAutoRunAtByPartition, normPart, attemptNow, MAX_COLLECTED_PARTITIONS);
      }
      if (onAutoCollectInitiated) {
        onAutoCollectInitiated(attemptNow, normPart);
      }
    }

    progress("running");
    const alertMeta = {
      accountKey: acc.accountKey,
      partition: acc.partition,
      phone: acc.phone,
      accountName: acc.accountName,
      // 同组同平台账号数：升级前旧数据只按分组记了作品数，组内仅 1 个账号时可安全沿用
      groupPlatformAccountCount: accounts.filter(
        (a) => a && a.group === acc.group && a.platform === acc.platform
      ).length,
    };
    const alertKey =
      typeof store.collectAlertKey === "function"
        ? store.collectAlertKey(acc.group, acc.platform, alertMeta)
        : `${String(acc.platform || "")}|${String(acc.accountKey || acc.partition || acc.group || "")}`;
    const prevWorkCount =
      typeof store.getPreviousWorkCount === "function"
        ? store.getPreviousWorkCount(acc.group, acc.platform, alertMeta)
        : 0;
    try {
      const data = await collectAccount({
        partition: acc.partition,
        platform: acc.platform,
      });
      // 以采集返回时刻的 UTC+8 日期为整次写入的唯一日期，daily/works-daily/intraday 统一按 collectNow 归档
      const collectNow = Date.now();
      let outcome;
      if (!roundAlertCounted.has(alertKey)) {
        roundAlertCounted.add(alertKey);
        outcome = handleAccountCollectOutcome({
          group: acc.group,
          platform: acc.platform,
          ...alertMeta,
          success: true,
          works: data.works,
          prevWorkCount,
          now: collectNow,
        });
      } else {
        const workLen = Array.isArray(data.works) ? data.works.length : 0;
        const zeroWorksAnomaly = prevWorkCount > 0 && workLen === 0;
        const curState =
          typeof store.getAccountCollectFailureState === "function"
            ? store.getAccountCollectFailureState(acc.group, acc.platform, alertMeta)
            : null;
        outcome = zeroWorksAnomaly
          ? {
              ok: false,
              zeroWorksAnomaly: true,
              reason: `上次作品数 ${prevWorkCount}，本次采集为 0（疑似接口异常或登录态异常）`,
              alert: curState,
              notified: false,
            }
          : {
              ok: true,
              zeroWorksAnomaly: false,
              reason: "",
              alert: null,
              notified: false,
            };
      }
      if (!outcome.ok && outcome.zeroWorksAnomaly) {
        try {
          store.writeMeta(acc.group, acc.platform, {
            lastCollectAt: collectNow,
            lastError: outcome.reason,
          });
        } catch (metaErr) {
          console.warn(
            "[dataStats] 写入空作品异常 meta 失败:",
            (metaErr && metaErr.message) || metaErr
          );
        }
        results.push({
          group: acc.group,
          platform: acc.platform,
          ...(acc.accountKey ? { accountKey: acc.accountKey } : {}),
          ...(acc.partition ? { partition: acc.partition } : {}),
          success: false,
          workCount: 0,
          error: outcome.reason,
          zeroWorksAnomaly: true,
          alert: outcome.alert,
        });
        progress("failed", { error: outcome.reason });
        continue;
      }
      store.mergeDaily(
        acc.group,
        acc.platform,
        data.overview,
        data.fansHistory,
        collectNow,
        { works: data.works }
      );
      store.mergeWorks(acc.group, acc.platform, data.works, collectNow, {
        slot: slot || undefined,
      });
      store.writeMeta(
        acc.group,
        acc.platform,
        {
          lastCollectAt: collectNow,
          lastError: "",
          workCount: data.works.length,
        },
        alertMeta
      );
      markPartitionCollected(acc.partition, collectNow, isAutoTrigger);
      if (isAutoTrigger) {
        const normPart = normalizePartition(acc.partition);
        if (normPart) {
          collectedAutoPartitions[normPart] = collectNow;
          attemptedAutoPartitions[normPart] = collectNow;
          if (onAutoCollectInitiated) {
            onAutoCollectInitiated(collectNow, normPart, true);
          }
        }
      }
      results.push({
        group: acc.group,
        platform: acc.platform,
        ...(acc.accountKey ? { accountKey: acc.accountKey } : {}),
        ...(acc.partition ? { partition: acc.partition } : {}),
        success: true,
        workCount: data.works.length,
        collectedAt: collectNow,
      });
      progress("success");
    } catch (err) {
      const message = (err && err.message) || String(err);
      const failNow = Date.now();
      let alertState = null;
      try {
        if (!roundAlertCounted.has(alertKey)) {
          roundAlertCounted.add(alertKey);
          const outcome = handleAccountCollectOutcome({
            group: acc.group,
            platform: acc.platform,
            ...alertMeta,
            success: false,
            error: message,
            errorObj: err,
            prevWorkCount,
            now: failNow,
          });
          alertState = outcome.alert;
        } else if (typeof store.getAccountCollectFailureState === "function") {
          alertState = store.getAccountCollectFailureState(acc.group, acc.platform, alertMeta);
        }
      } catch (alertErr) {
        console.warn(
          "[dataStats] 记录采集失败告警异常:",
          (alertErr && alertErr.message) || alertErr
        );
      }
      try {
        store.writeMeta(acc.group, acc.platform, {
          lastCollectAt: failNow,
          lastError: message,
        });
      } catch (metaErr) {
        console.warn(
          "[dataStats] 写入失败 meta 异常:",
          (metaErr && metaErr.message) || metaErr
        );
      }
      results.push({
        group: acc.group,
        platform: acc.platform,
        ...(acc.accountKey ? { accountKey: acc.accountKey } : {}),
        ...(acc.partition ? { partition: acc.partition } : {}),
        success: false,
        error: message,
        ...(alertState ? { alert: alertState } : {}),
      });
      progress("failed", { error: message });
    }
  }
  // 任务日志落盘（拉取记录弹窗用）
  const logEntry = {
    startedAt,
    finishedAt: Date.now(),
    cancelled,
    results,
  };
  if (options && VALID_TRIGGERS.has(options.trigger)) {
    logEntry.trigger = options.trigger;
  }
  if (slot) {
    logEntry.slot = slot;
  }
  try {
    store.appendCollectLog(logEntry);
  } catch (err) {
    console.warn(
      "[dataStats] 写入采集日志失败:",
      (err && err.message) || err
    );
  }
  return {
    results,
    cancelled,
    collectedAutoPartitions,
    attemptedAutoPartitions,
    firstAutoAttemptAt,
  };
}

function isLocalFrameEvent(event) {
  try {
    const frame = new URL(
      String((event && event.senderFrame && event.senderFrame.url) || "")
    );
    return (
      (frame.protocol === "file:" && !frame.hostname) ||
      (["http:", "https:"].includes(frame.protocol) &&
        ["localhost", "127.0.0.1"].includes(frame.hostname))
    );
  } catch (_) {
    return false;
  }
}

function decodePngDataUrl(rawDataUrl) {
  if (typeof rawDataUrl !== "string" || !rawDataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error("仅支持 image/png base64 图片数据");
  }
  const rawBody = rawDataUrl.slice(PNG_DATA_URL_PREFIX.length);
  if (!rawBody) {
    throw new Error("图片数据为空");
  }
  // 解码前做字符串长度上限拦截，防止超大负载占用内存
  if (rawBody.length > MAX_CHART_IMAGE_B64_CHARS + 1024 * 64) {
    throw new Error("图片大小超过 10MB 限制");
  }
  const cleaned = rawBody.replace(/[\r\n]/g, "");
  if (!cleaned || cleaned.length % 4 !== 0 || !BASE64_BODY_RE.test(cleaned)) {
    throw new Error("PNG base64 编码格式无效");
  }
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const decodedBytes = (cleaned.length / 4) * 3 - padding;
  if (decodedBytes <= 0) {
    throw new Error("图片数据为空");
  }
  if (decodedBytes > MAX_CHART_IMAGE_BYTES) {
    throw new Error("图片大小超过 10MB 限制");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length > MAX_CHART_IMAGE_BYTES) {
    throw new Error("图片大小超过 10MB 限制");
  }
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw new Error("图片内容不是有效的 PNG 文件");
  }
  return buf;
}

function sanitizeChartFileName(rawName, fallback = "图表") {
  const base = typeof rawName === "string" ? rawName.replace(/\.png$/i, "") : "";
  const cleaned = base
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/-+/g, "-")
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .slice(0, 80);
  if (!cleaned || cleaned === "." || cleaned === "..") {
    return fallback;
  }
  return cleaned;
}

function buildChartImageFileName(rawName, dateStr) {
  const safe = sanitizeChartFileName(rawName, "图表");
  const hasDate = /\d{4}-\d{2}-\d{2}/.test(safe);
  const stem = hasDate || !dateStr ? safe : `${safe}-${dateStr}`;
  return `${stem}.png`;
}

function formatUtc8Hms(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + 8 * 3600e3).toISOString().slice(11, 19).replace(/:/g, "");
}

function formatChartBatchPeriodLabel(rawPeriod) {
  if (typeof rawPeriod === "number" && Number.isInteger(rawPeriod) && rawPeriod > 0) {
    return `近${rawPeriod}天`;
  }
  if (typeof rawPeriod === "string") {
    const trimmed = rawPeriod.trim();
    if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
      return `近${Number(trimmed)}天`;
    }
    const safe = sanitizeChartFileName(trimmed, "");
    if (safe) return safe;
  }
  return "全部";
}

function createUniqueBatchExportDir(parentDir, baseDirName) {
  fs.mkdirSync(parentDir, { recursive: true });
  const safeBase = sanitizeChartFileName(baseDirName, "MatrixMedia-图表");
  for (let seq = 1; seq <= 999; seq++) {
    const dirName = seq === 1 ? safeBase : `${safeBase}-${seq}`;
    const candidate = path.resolve(parentDir, dirName);
    if (path.dirname(candidate) !== parentDir) {
      throw new Error(`非法导出目录名：${dirName}`);
    }
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new Error("无法创建独立的图表导出子目录");
}

function registerDataStatsIpc(options = {}) {
  const exportMaxRows =
    options && options.exportMaxRows !== undefined ? options.exportMaxRows : undefined;
  const exportDeps =
    options && options.exportDeps && typeof options.exportDeps === "object"
      ? options.exportDeps
      : undefined;

  // 主进程启动时预读持久化的保留期与自动采集设置（未设置回退 60）
  try {
    if (typeof store.readAutoSettings === "function") {
      const loaded = store.readAutoSettings();
      const loadedRetention = normalizeRetentionDaysArg(loaded && loaded.retentionDays);
      lastRetentionDays =
        loadedRetention || store.DEFAULT_INTRADAY_RETENTION_DAYS || 60;
    }
  } catch (_) {}

  ipcMain.handle("stats:get-auto-settings", async (event) => {
    if (event && event.senderFrame && !isLocalFrameEvent(event)) {
      return { ok: false, error: "不允许外部页面读取自动采集设置" };
    }
    try {
      const settings =
        typeof store.readAutoSettings === "function"
          ? store.readAutoSettings()
          : { retentionDays: lastRetentionDays };
      return { ok: true, settings };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "读取自动采集设置失败",
      };
    }
  });

  ipcMain.handle("stats:save-auto-settings", async (event, args) => {
    if (event && event.senderFrame && !isLocalFrameEvent(event)) {
      return { ok: false, error: "不允许外部页面修改自动采集设置" };
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, error: "设置参数无效" };
    }
    try {
      const prev =
        typeof store.readAutoSettings === "function"
          ? store.readAutoSettings()
          : null;
      const saved =
        typeof store.writeAutoSettings === "function"
          ? store.writeAutoSettings(args, Date.now(), {
              initOnly: Boolean(args.initOnly),
            })
          : { retentionDays: normalizeRetentionDaysArg(args.retentionDays) || lastRetentionDays };
      const savedRetention = normalizeRetentionDaysArg(saved && saved.retentionDays);
      if (savedRetention !== null) {
        lastRetentionDays = savedRetention;
      }
      if (
        prev &&
        saved &&
        saved.scheduleUpdatedAt !== prev.scheduleUpdatedAt
      ) {
        skippedAutoSlots.clear();
        lastSeenAutoRunSchedule =
          saved.mode === "interval"
            ? `${saved.startTime}|${saved.endTime}|${saved.intervalHours}`
            : null;
      }
      return { ok: true, settings: saved };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "保存自动采集设置失败",
      };
    }
  });

  ipcMain.handle("stats:collect", async (event, args) => {
    if (collecting) {
      return { results: [], error: "已有采集任务进行中" };
    }
    const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
    if (!accounts.length) return { results: [], error: "没有可采集的账号" };
    const trigger =
      args && VALID_TRIGGERS.has(args.trigger) ? args.trigger : undefined;
    collecting = true;
    cancelled = false;
    try {
      const out = await collectAccounts(accounts, event && event.sender, {
        trigger,
      });
      return { results: out.results, cancelled: out.cancelled };
    } finally {
      collecting = false;
    }
  });

  /**
   * 定时自动采集单一操作（认领与采集合并）：
   * - interval 模式（传入 args.slot = "YYYY-MM-DD HH:mm"）：
   *   按槽去重与落盘 auto-run.json，支持 slotEndMs 过槽放弃、设置变更生效边界、
   *   主进程防高频硬下限（< intervalHours*60-10 分钟跳过本槽）、以及同槽 [槽开始, 下一槽开始) 分区跳重；
   *   槽认领与限流时间分开记录：只有实际发起了至少一个分区的自动采集才更新上次自动采集时间，全跳过只记槽认领
   * - daily 模式（未传 slot，兼容旧调用）：
   *   today = store.todayStr()（UTC+8，由主进程计算），行为与历史完全一致
   * - 均遵守：auto-run.json 已含目标 → already-ran；collecting 中 → busy（不写入）；
   *   开跑前原子追加目标到 runs（写失败返回 store-failed、不采集），结束后复位 collecting
   */
  ipcMain.handle("stats:auto-run", async (event, args) => {
    const hasSlotArg =
      args &&
      Object.prototype.hasOwnProperty.call(args, "slot") &&
      args.slot !== undefined &&
      args.slot !== null &&
      args.slot !== "";

    if (hasSlotArg) {
      const slot = typeof args.slot === "string" ? args.slot.trim() : "";
      const slotStartMs = parseSlotStartMs(slot);
      const validSlot =
        slotStartMs !== null &&
        (typeof store.isValidAutoRunSlot === "function"
          ? store.isValidAutoRunSlot(slot)
          : SLOT_STR_RE.test(slot));
      if (!validSlot) {
        return { status: "invalid-slot", error: "非法时段槽" };
      }
      const slotDate = slot.slice(0, 10);
      const now = Date.now();

      let autoSettings =
        typeof store.readAutoSettings === "function"
          ? store.readAutoSettings()
          : { intervalHours: 2, scheduleUpdatedAt: 0 };

      // 兜底检测：若调用方携带新调度参数且未先调 stats:save-auto-settings，主进程同步生效边界
      const reqStart =
        typeof args.startTime === "string" && TIME_HHMM_RE.test(args.startTime.trim())
          ? args.startTime.trim()
          : "";
      const reqEnd =
        typeof args.endTime === "string" && END_TIME_HHMM_RE.test(args.endTime.trim())
          ? args.endTime.trim()
          : "";
      const reqInterval = normalizeIntervalHoursArg(args.intervalHours);
      if (reqStart && reqEnd && reqInterval !== null) {
        const reqSig = `${reqStart}|${reqEnd}|${reqInterval}`;
        const hasDiskSettings =
          typeof store.autoSettingsFile === "function" &&
          fs.existsSync(store.autoSettingsFile());
        const prevSig =
          lastSeenAutoRunSchedule ||
          (hasDiskSettings && autoSettings.mode === "interval"
            ? `${autoSettings.startTime}|${autoSettings.endTime}|${autoSettings.intervalHours}`
            : null);
        if (prevSig && prevSig !== reqSig && typeof store.writeAutoSettings === "function") {
          try {
            autoSettings = store.writeAutoSettings(
              {
                mode: "interval",
                enabled: true,
                startTime: reqStart,
                endTime: reqEnd,
                intervalHours: reqInterval,
              },
              now
            );
            skippedAutoSlots.clear();
          } catch (_) {}
        }
        lastSeenAutoRunSchedule = reqSig;
      }

      if (autoRanInMemory.has(slot)) {
        return { status: "already-ran", date: slotDate, slot };
      }
      let autoRunState;
      try {
        autoRunState =
          typeof store.readAutoRunState === "function"
            ? store.readAutoRunState()
            : { runs: store.readAutoRuns(), lastAutoRunAt: 0, partitionAutoRunAt: {} };
      } catch (err) {
        console.warn("[dataStats] 读取 auto-run.json 失败:", (err && err.message) || err);
        return { status: "busy" };
      }
      const runs = autoRunState.runs || [];
      if (runs.includes(slot)) {
        autoRanInMemory.add(slot);
        return { status: "already-ran", date: slotDate, slot };
      }
      if (
        args.slotEndMs !== undefined &&
        args.slotEndMs !== null &&
        Number.isFinite(Number(args.slotEndMs)) &&
        now >= Number(args.slotEndMs)
      ) {
        return { status: "expired", date: slotDate, slot };
      }

      // 生效边界：设置变更后不补跑槽开始时刻早于设置变更时刻的更早槽
      if (
        autoSettings &&
        typeof autoSettings.scheduleUpdatedAt === "number" &&
        autoSettings.scheduleUpdatedAt > 0 &&
        slotStartMs < autoSettings.scheduleUpdatedAt
      ) {
        return {
          status: "skipped",
          reason: "before-settings-change",
          date: slotDate,
          slot,
        };
      }

      // 主进程防高频硬下限：距上次自动采集 < intervalHours*60 - 10 分钟 → 跳过本槽
      const intervalHours = resolveEffectiveIntervalHours(
        args,
        autoSettings,
        slotStartMs,
        args.slotEndMs
      );
      const effectiveSlotEndMs = resolveEffectiveSlotEndMs(
        args,
        slotStartMs,
        intervalHours
      );
      const minAutoIntervalMs =
        Math.max(0, intervalHours * 60 - RATE_LIMIT_GRACE_MINUTES) * 60000;
      if (skippedAutoSlots.has(slot)) {
        return {
          status: "skipped",
          reason: "rate-limited",
          date: slotDate,
          slot,
        };
      }
      let prevGlobalAutoAt = 0;
      if (lastGlobalAutoRunAt > 0 && lastGlobalAutoRunAt <= now) {
        prevGlobalAutoAt = Math.max(prevGlobalAutoAt, lastGlobalAutoRunAt);
      }
      if (autoRunState.lastAutoRunAt > 0 && autoRunState.lastAutoRunAt <= now) {
        prevGlobalAutoAt = Math.max(prevGlobalAutoAt, autoRunState.lastAutoRunAt);
      }
      if (prevGlobalAutoAt > 0 && now - prevGlobalAutoAt < minAutoIntervalMs) {
        skippedAutoSlots.add(slot);
        return {
          status: "skipped",
          reason: "rate-limited",
          date: slotDate,
          slot,
          retryAfterMs: minAutoIntervalMs - (now - prevGlobalAutoAt),
        };
      }

      if (collecting) {
        return { status: "busy" };
      }
      const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
      if (!accounts.length) {
        return { status: "empty", date: slotDate, slot, results: [] };
      }
      // 仅记录槽认领；不在此处更新限流时间（只有实际发起至少一个分区的自动采集才更新）
      try {
        store.appendAutoRun(slot);
      } catch (err) {
        console.warn(
          "[dataStats] 写入 auto-run.json 失败，本轮不自动采集:",
          (err && err.message) || err
        );
        return { status: "store-failed" };
      }
      autoRanInMemory.add(slot);
      collecting = true;
      cancelled = false;
      let initiatedAutoAt = 0;
      const initiatedAutoPartitions = Object.create(null);
      try {
        const out = await collectAccounts(accounts, event && event.sender, {
          trigger: "auto",
          skipCollectedSlot: true,
          slot,
          slotStartMs,
          slotEndMs: effectiveSlotEndMs,
          minAutoIntervalMs,
          persistedPartitionAutoRunAt: autoRunState.partitionAutoRunAt,
          onAutoCollectInitiated: (ts, normPart, isSuccessUpdate) => {
            const isFirst = !isSuccessUpdate && !initiatedAutoAt;
            if (isFirst) {
              initiatedAutoAt = ts;
              lastGlobalAutoRunAt = ts;
            }
            if (normPart) {
              initiatedAutoPartitions[normPart] = ts;
            }
            // 每个分区真正发起采集请求前立即落盘限流时间：采集中途退出/重启也不会绕过限流下限
            if (!isSuccessUpdate && typeof store.updateAutoRunTimestamps === "function") {
              try {
                store.updateAutoRunTimestamps({
                  lastAutoRunAt: isFirst ? ts : undefined,
                  partitionAutoRunAt: normPart ? { [normPart]: ts } : undefined,
                });
              } catch (tsErr) {
                console.warn(
                  "[dataStats] 预写 auto-run.json 限流时间戳失败:",
                  (tsErr && tsErr.message) || tsErr
                );
              }
            }
          },
        });
        return {
          status: "done",
          date: slotDate,
          slot,
          results: out.results,
          cancelled: Boolean(out.cancelled),
        };
      } finally {
        if (
          initiatedAutoAt > 0 &&
          typeof store.updateAutoRunTimestamps === "function"
        ) {
          try {
            store.updateAutoRunTimestamps({
              lastAutoRunAt: initiatedAutoAt,
              partitionAutoRunAt: initiatedAutoPartitions,
            });
          } catch (tsErr) {
            console.warn(
              "[dataStats] 更新 auto-run.json 限流时间戳失败:",
              (tsErr && tsErr.message) || tsErr
            );
          }
        }
        collecting = false;
      }
    }

    const today = getTodayStr();
    if (autoRanInMemory.has(today)) {
      return { status: "already-ran", date: today };
    }
    let runs = [];
    try {
      runs = store.readAutoRuns();
    } catch (err) {
      // 读失败不冒险开跑：当作忙，下一轮再试
      console.warn("[dataStats] 读取 auto-run.json 失败:", (err && err.message) || err);
      return { status: "busy" };
    }
    if (runs.includes(today)) {
      autoRanInMemory.add(today);
      return { status: "already-ran", date: today };
    }
    if (collecting) {
      return { status: "busy" };
    }
    const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
    if (!accounts.length) {
      return { status: "empty", date: today, results: [] };
    }
    // 开跑前先落盘「今天已自动跑」：中途退出/重启不会同日重采；落盘失败则不采集（下一轮再试）
    try {
      store.appendAutoRun(today);
    } catch (err) {
      console.warn("[dataStats] 写入 auto-run.json 失败，本轮不自动采集:", (err && err.message) || err);
      return { status: "store-failed" };
    }
    autoRanInMemory.add(today);
    collecting = true;
    cancelled = false;
    try {
      const out = await collectAccounts(accounts, event && event.sender, {
        trigger: "auto",
        skipCollectedToday: true,
      });
      return {
        status: "done",
        date: today,
        results: out.results,
        cancelled: Boolean(out.cancelled),
      };
    } finally {
      collecting = false;
    }
  });

  ipcMain.handle("stats:cancel", async () => {
    cancelled = true;
    return { ok: true };
  });

  ipcMain.handle("stats:get-data", async (_event, args) => {
    const { group, platform } = args || {};
    return store.readAccount(group, platform);
  });

  ipcMain.handle("stats:get-overview", async () => {
    return store.readOverview();
  });

  ipcMain.handle("stats:get-logs", async () => {
    return store.readCollectLogs();
  });

  ipcMain.handle("stats:get-content-summary", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { rows: [], deletedRows: [], date: "", error: "不允许外部页面读取作品汇总" };
      }
      if (args != null && (typeof args !== "object" || Array.isArray(args))) {
        return { rows: [], deletedRows: [], date: "", error: "查询参数无效" };
      }
      await overrideWriteChain;
      const date = args && args.date !== undefined ? args.date : undefined;
      return buildContentSummaryData({ date }, exportDeps);
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      return {
        rows: [],
        deletedRows: [],
        date: "",
        error: isOvReadErr
          ? LINK_OVERRIDES_READ_ERROR_MESSAGE
          : (err && err.message) || "读取作品汇总失败",
        ...(isOvReadErr
          ? { errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
      };
    }
  });

  ipcMain.handle("stats:get-content-trend", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面读取作品趋势" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "查询参数无效" };
      }
      const contentKey = typeof args.contentKey === "string" ? args.contentKey.trim() : "";
      if (!contentKey) {
        return { ok: false, error: "contentKey 不能为空" };
      }
      await overrideWriteChain;
      const data = buildContentTrendData(
        {
          contentKey,
          from: args.from !== undefined ? args.from : undefined,
          to: args.to !== undefined ? args.to : undefined,
          groups: args.groups,
        },
        exportDeps
      );
      return { ok: true, ...data };
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      return {
        ok: false,
        error: isOvReadErr
          ? LINK_OVERRIDES_READ_ERROR_MESSAGE
          : (err && err.message) || "读取作品趋势失败",
        ...(isOvReadErr
          ? { errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
      };
    }
  });

  ipcMain.handle("stats:get-content-intraday", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面读取作品分时段趋势" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "查询参数无效" };
      }
      const contentKey = typeof args.contentKey === "string" ? args.contentKey.trim() : "";
      if (!contentKey) {
        return { ok: false, error: "contentKey 不能为空" };
      }
      await overrideWriteChain;
      const data = buildContentIntradayData(
        {
          contentKey,
          days: args.days !== undefined ? args.days : undefined,
          to: args.to !== undefined ? args.to : undefined,
          groups: args.groups,
        },
        exportDeps
      );
      return { ok: true, ...data };
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      return {
        ok: false,
        error: isOvReadErr
          ? LINK_OVERRIDES_READ_ERROR_MESSAGE
          : (err && err.message) || "读取作品分时段趋势失败",
        ...(isOvReadErr
          ? { errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
      };
    }
  });

  ipcMain.handle("stats:get-analysis", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面读取数据分析" };
      }
      if (args != null && (typeof args !== "object" || Array.isArray(args))) {
        return { ok: false, error: "查询参数无效" };
      }
      await overrideWriteChain;
      const payload = args || {};
      const period = payload.period !== undefined ? payload.period : 30;
      const to = payload.to !== undefined ? payload.to : undefined;
      const data = buildStatsAnalysisData({ period, to }, exportDeps);
      return { ok: true, ...data };
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      return {
        ok: false,
        error: isOvReadErr
          ? LINK_OVERRIDES_READ_ERROR_MESSAGE
          : (err && err.message) || "读取数据分析失败",
        ...(isOvReadErr
          ? { errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
      };
    }
  });

  ipcMain.handle("stats:save-chart-image", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        const msg = "不允许外部页面保存图表图片";
        return { ok: false, error: msg, message: msg };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        const msg = "保存图表参数无效";
        return { ok: false, error: msg, message: msg };
      }
      const buf = decodePngDataUrl(args.dataUrl);
      const exportNow =
        exportDeps && exportDeps.now !== undefined ? exportDeps.now : Date.now();
      const dateStr =
        typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim())
          ? args.date.trim()
          : getTodayStr(exportNow);
      const defaultName = buildChartImageFileName(args.name, dateStr);

      const { BrowserWindow, dialog, app } = electron;
      const win =
        BrowserWindow && typeof BrowserWindow.fromWebContents === "function"
          ? BrowserWindow.fromWebContents(event && event.sender)
          : null;
      if (!win) {
        const msg = "窗口已关闭";
        return { ok: false, error: msg, message: msg };
      }

      const result = await dialog.showSaveDialog(win, {
        title: "保存图表图片",
        defaultPath: path.join(app.getPath("documents"), defaultName),
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }

      fs.mkdirSync(path.dirname(result.filePath), { recursive: true });
      fs.writeFileSync(result.filePath, buf);
      return {
        ok: true,
        filePath: result.filePath,
        size: buf.length,
      };
    } catch (err) {
      const msg = (err && err.message) || "保存图表图片失败";
      return { ok: false, error: msg, message: msg };
    }
  });

  ipcMain.handle("stats:save-chart-images-batch", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        const msg = "不允许外部页面批量导出图表图片";
        return { ok: false, error: msg, message: msg };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        const msg = "批量导出参数无效";
        return { ok: false, error: msg, message: msg };
      }
      if (!Array.isArray(args.items) || args.items.length === 0) {
        const msg = "没有可导出的图表图片";
        return { ok: false, error: msg, message: msg };
      }
      if (args.items.length > MAX_BATCH_CHART_IMAGES) {
        const msg = `单次最多导出 ${MAX_BATCH_CHART_IMAGES} 张图表`;
        return { ok: false, error: msg, message: msg };
      }
      const exportNow =
        exportDeps && exportDeps.now !== undefined ? exportDeps.now : Date.now();
      const dateStr =
        typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim())
          ? args.date.trim()
          : getTodayStr(exportNow);

      const prepared = [];
      const usedNames = new Set();
      for (let i = 0; i < args.items.length; i++) {
        const item = args.items[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`第 ${i + 1} 张图表参数无效`);
        }
        const buf = decodePngDataUrl(item.dataUrl);
        let fileName = buildChartImageFileName(item.name || `图表-${i + 1}`, dateStr);
        if (usedNames.has(fileName.toLowerCase())) {
          const stem = fileName.slice(0, -4);
          let seq = 2;
          while (usedNames.has(`${stem}-${seq}.png`.toLowerCase())) {
            seq += 1;
          }
          fileName = `${stem}-${seq}.png`;
        }
        usedNames.add(fileName.toLowerCase());
        prepared.push({ fileName, buf });
      }

      const { BrowserWindow, dialog, app } = electron;
      const win =
        BrowserWindow && typeof BrowserWindow.fromWebContents === "function"
          ? BrowserWindow.fromWebContents(event && event.sender)
          : null;
      if (!win) {
        const msg = "窗口已关闭";
        return { ok: false, error: msg, message: msg };
      }

      const result = await dialog.showOpenDialog(win, {
        title: "选择图表导出文件夹",
        defaultPath: app.getPath("documents"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { ok: false, canceled: true };
      }

      const parentDir = path.resolve(result.filePaths[0]);
      const periodLabel = formatChartBatchPeriodLabel(args.period);
      const hms = formatUtc8Hms(exportNow);
      const subDirName = `MatrixMedia-图表-${periodLabel}-${dateStr}-${hms}`;
      const targetDir = createUniqueBatchExportDir(parentDir, subDirName);
      const files = [];
      for (const item of prepared) {
        const targetPath = path.resolve(targetDir, item.fileName);
        if (path.dirname(targetPath) !== targetDir) {
          throw new Error(`非法文件名：${item.fileName}`);
        }
        fs.writeFileSync(targetPath, item.buf);
        files.push(targetPath);
      }
      return {
        ok: true,
        dir: targetDir,
        parentDir,
        files,
        count: files.length,
      };
    } catch (err) {
      const msg = (err && err.message) || "批量导出图表失败";
      return { ok: false, error: msg, message: msg };
    }
  });

  ipcMain.handle("stats:get-link-overrides", async (event) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return {
          ok: false,
          error: "不允许外部页面读取手动关联配置",
          contents: {},
          excludedAuto: {},
          deletedContents: {},
          overrides: {},
        };
      }
      await overrideWriteChain;
      const doc = store.readLinkOverrides({ strict: true });
      return {
        ok: true,
        version: doc.version,
        updatedAt: doc.updatedAt,
        contents: toPlainOverrides(doc.contents),
        excludedAuto: toPlainBoolMap(doc.excludedAuto),
        deletedContents: toPlainDeletedContents(doc.deletedContents),
        overrides: toPlainOverrides(doc.overrides),
      };
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      return {
        ok: false,
        error: isOvReadErr
          ? LINK_OVERRIDES_READ_ERROR_MESSAGE
          : (err && err.message) || "读取手动关联配置失败",
        ...(isOvReadErr
          ? { errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
        contents: {},
        excludedAuto: {},
        deletedContents: {},
        overrides: {},
      };
    }
  });

  ipcMain.handle("stats:set-link-override", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面修改手动关联配置" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "参数无效" };
      }
      const workKey = typeof args.workKey === "string" ? args.workKey : "";
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const contentKey = typeof args.contentKey === "string" ? args.contentKey.trim() : "";
      if (!workKey) {
        return { ok: false, error: "workKey 不能为空" };
      }
      if (action !== "assign" && action !== "detach") {
        return { ok: false, error: "action 必须为 assign 或 detach" };
      }
      if (action === "assign" && (!contentKey || contentKey.startsWith("unlinked:"))) {
        return { ok: false, error: "assign 操作需提供有效的 contentKey" };
      }
      const entry = action === "assign" ? { action: "assign", contentKey } : { action: "detach" };
      const res = await enqueueOverrideWrite(() =>
        applyOverrideOpsSync([{ workKey, ...entry }], exportDeps)
      );
      return {
        ok: true,
        workKey: res.resolvedWorkKeys[0] || workKey,
        override: entry,
        updatedAt: res.doc.updatedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "保存手动关联失败",
      };
    }
  });

  ipcMain.handle("stats:merge-works", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面合并作品" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "参数无效" };
      }
      if (!Array.isArray(args.workKeys)) {
        return { ok: false, error: "workKeys 必须为数组" };
      }
      const uniqueKeys = [];
      const seen = new Set();
      for (const k of args.workKeys) {
        if (typeof k !== "string" || !k) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        uniqueKeys.push(k);
      }
      if (uniqueKeys.length < 2) {
        return { ok: false, error: "至少需要选择 2 条作品才能合并" };
      }
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const res = await enqueueOverrideWrite(() =>
        applyOverrideOpsSync([{ action: "merge", workKeys: uniqueKeys, title }], exportDeps)
      );
      const created = res.createdContentKeys[0];
      return {
        ok: true,
        contentKey: created.contentKey,
        workKeys: created.workKeys,
        updatedAt: res.doc.updatedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "合并作品失败",
      };
    }
  });

  ipcMain.handle("stats:clear-link-override", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面清除手动关联配置" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "参数无效" };
      }
      const workKey = typeof args.workKey === "string" ? args.workKey : "";
      if (!workKey) {
        return { ok: false, error: "workKey 不能为空" };
      }
      const res = await enqueueOverrideWrite(() =>
        applyOverrideOpsSync([{ action: "clear", workKey }], exportDeps)
      );
      return {
        ok: true,
        workKey: res.resolvedWorkKeys[0] || workKey,
        updatedAt: res.doc.updatedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "恢复自动关联失败",
      };
    }
  });

  ipcMain.handle("stats:apply-link-overrides", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面修改手动关联配置" };
      }
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return { ok: false, error: "参数无效" };
      }
      if (!Array.isArray(args.ops) || args.ops.length === 0) {
        return { ok: false, error: "ops 必须为非空数组" };
      }
      const res = await enqueueOverrideWrite(() =>
        applyOverrideOpsSync(args.ops, exportDeps)
      );
      const out = {
        ok: true,
        applied: res.applied,
        updatedAt: res.doc.updatedAt,
        createdContentKeys: res.createdContentKeys,
      };
      if (res.createdContentKeys.length === 1) {
        out.contentKey = res.createdContentKeys[0].contentKey;
      }
      return out;
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "批量保存手动关联失败",
      };
    }
  });

  ipcMain.handle("stats:delete-contents", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面删除内容行" };
      }
      const uniqueKeys = normalizeContentKeysArg(args);
      const rawMode =
        args && Object.prototype.hasOwnProperty.call(args, "mode") ? args.mode : undefined;
      let isEmptyOnly = false;
      if (rawMode !== undefined && rawMode !== null && rawMode !== "") {
        if (typeof rawMode !== "string") {
          return { ok: false, error: "mode 参数无效" };
        }
        const trimmedMode = rawMode.trim();
        if (trimmedMode === "empty-only") {
          isEmptyOnly = true;
        } else if (trimmedMode !== "normal") {
          return { ok: false, error: "mode 参数无效" };
        }
      }
      const res = await enqueueOverrideWrite(() => {
        const current = store.readLinkOverrides({ strict: true });
        const deletedContents = cloneNoProtoDeletedContents(current.deletedContents);
        const { visibleRowByKey, snapshotByKey } = resolveDeleteContentSnapshots(
          uniqueKeys,
          current,
          exportDeps
        );
        const now = Date.now();
        let added = 0;
        const deletedKeys = [];
        const skippedKeys = [];
        for (const ck of uniqueKeys) {
          const visibleRow = visibleRowByKey.get(ck) || null;
          const snap = snapshotByKey.get(ck) || null;
          const existing = Object.prototype.hasOwnProperty.call(deletedContents, ck)
            ? deletedContents[ck]
            : null;
          if (isEmptyOnly) {
            if (visibleRow === null && existing) {
              continue;
            }
            const isStillEmptyRow =
              visibleRow !== null &&
              Number(visibleRow.platformCount) === 0 &&
              (!snap || !Array.isArray(snap.pwKeys) || snap.pwKeys.length === 0);
            if (!isStillEmptyRow) {
              skippedKeys.push(ck);
              continue;
            }
          }
          const shouldWrite =
            !existing ||
            (visibleRow !== null &&
              !isContentRowDeleted(ck, visibleRow.title, new Map([[ck, existing]])));
          if (shouldWrite) {
            const entry = { deletedAt: now };
            if (snap && snap.title) entry.title = snap.title;
            if (snap && Array.isArray(snap.pwKeys)) entry.pwKeys = [...snap.pwKeys];
            deletedContents[ck] = entry;
            added++;
            deletedKeys.push(ck);
          } else if (!isEmptyOnly) {
            deletedKeys.push(ck);
          }
        }
        if (isEmptyOnly && added === 0) {
          return {
            doc: current,
            added: 0,
            deletedKeys,
            skippedKeys,
            skipped: skippedKeys.length,
          };
        }
        const doc = store.writeLinkOverrides(
          {
            overrides: current.overrides,
            contents: current.contents,
            excludedAuto: current.excludedAuto,
            deletedContents,
          },
          now
        );
        return {
          doc,
          added,
          deletedKeys,
          skippedKeys,
          skipped: skippedKeys.length,
        };
      });
      return {
        ok: true,
        ...(isEmptyOnly ? { mode: "empty-only" } : {}),
        deletedKeys: res.deletedKeys,
        skipped: res.skipped,
        skippedKeys: res.skippedKeys,
        added: res.added,
        totalDeleted: Object.keys(res.doc.deletedContents).length,
        updatedAt: res.doc.updatedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "删除内容失败",
      };
    }
  });

  ipcMain.handle("stats:restore-contents", async (event, args) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, error: "不允许外部页面恢复内容行" };
      }
      const uniqueKeys = normalizeContentKeysArg(args);
      const res = await enqueueOverrideWrite(() => {
        const current = store.readLinkOverrides({ strict: true });
        const deletedContents = cloneNoProtoDeletedContents(current.deletedContents);
        const now = Date.now();
        let restored = 0;
        for (const ck of uniqueKeys) {
          if (Object.prototype.hasOwnProperty.call(deletedContents, ck)) {
            delete deletedContents[ck];
            restored++;
          }
        }
        const doc = store.writeLinkOverrides(
          {
            overrides: current.overrides,
            contents: current.contents,
            excludedAuto: current.excludedAuto,
            deletedContents,
          },
          now
        );
        return {
          doc,
          restored,
        };
      });
      return {
        ok: true,
        restoredKeys: uniqueKeys,
        restored: res.restored,
        totalDeleted: Object.keys(res.doc.deletedContents).length,
        updatedAt: res.doc.updatedAt,
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "恢复内容失败",
      };
    }
  });

  ipcMain.handle("stats:export-xlsx", async (event, args = {}) => {
    try {
      if (!isLocalFrameEvent(event)) {
        return { ok: false, message: "不允许外部页面导出数据" };
      }
      if (args != null && (typeof args !== "object" || Array.isArray(args))) {
        return { ok: false, message: "导出参数无效" };
      }
      const payload = args || {};
      // 纯参数校验（不读任何数据）：日期非法、from > to 或所选日期都在未来时直接拒绝，不弹保存框
      const { from: validFrom, to: validTo } = validateExportDateRange(
        payload.from,
        payload.to
      );
      const exportNow =
        exportDeps && exportDeps.now !== undefined ? exportDeps.now : Date.now();
      const { from: effectiveFrom, to: effectiveTo } = assertExportRangeNotAllFuture(
        validFrom,
        validTo,
        exportNow
      );

      const { BrowserWindow, dialog, app } = electron;
      const win =
        BrowserWindow && typeof BrowserWindow.fromWebContents === "function"
          ? BrowserWindow.fromWebContents(event && event.sender)
          : null;
      if (!win) return { ok: false, message: "窗口已关闭" };

      // 先弹保存对话框，用户取消则不读任何数据
      const defaultName = buildDefaultExportFileName(effectiveFrom, effectiveTo);
      const result = await dialog.showSaveDialog(win, {
        title: "导出作品数据 Excel",
        defaultPath: path.join(app.getPath("documents"), defaultName),
        filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }

      const buildOpts = {
        from: validFrom || undefined,
        to: validTo || undefined,
        groups: payload.groups,
      };
      if (exportMaxRows !== undefined) buildOpts.maxRows = exportMaxRows;

      await overrideWriteChain;
      const data = buildStatsWorkbookData(buildOpts, exportDeps);
      // 原样使用对话框返回路径（不做 trim）
      writeStatsXlsx(
        data,
        result.filePath,
        exportMaxRows !== undefined ? { maxRows: exportMaxRows } : undefined
      );
      return {
        ok: true,
        filePath: result.filePath,
        from: data.from,
        to: data.to,
        counts: data.counts,
      };
    } catch (err) {
      const isOvReadErr = isLinkOverridesReadErr(err);
      const msg = isOvReadErr
        ? LINK_OVERRIDES_READ_ERROR_MESSAGE
        : (err && err.message) || "导出失败";
      return {
        ok: false,
        message: msg,
        ...(isOvReadErr
          ? { error: msg, errorCode: "LINK_OVERRIDES_READ_ERROR", detail: (err && err.message) || "" }
          : {}),
      };
    }
  });

  /**
   * 发布状态匹配（视频管理「获取状态」）：
   * 输入若干条发布记录，按「分组 × 平台」聚合后各跑一次采集，
   * 在作品列表里按标题匹配——命中即说明发布成功，返回作品链接。
   * 与 stats:collect / stats:auto-run 共享 collecting 互斥锁，避免并发打开同分区采集窗口。
   *
   * @param {Array<{key, group, platform, partition, title}>} args.tasks
   * @returns {{ matches: Record<string, {found: boolean, url?: string, workId?: string}>, errors: Array, busy?: boolean }}
   */
  ipcMain.handle("stats:match-works", async (_event, args) => {
    if (collecting) {
      return {
        matches: {},
        errors: [{ error: "已有采集任务进行中" }],
        busy: true,
      };
    }
    const tasks = Array.isArray(args && args.tasks) ? args.tasks : [];
    const matches = {};
    const errors = [];
    // 按规范化 partition 聚合，每分区只采集一次（顺带写入本地快照，数据页同步受益）
    const groupsMap = new Map();
    for (const t of tasks) {
      if (!t || !t.platform || !t.key) continue;
      const gk = normalizePartition(t.partition);
      if (!gk) continue;
      if (!groupsMap.has(gk)) {
        groupsMap.set(gk, {
          partition: gk,
          platform: t.platform,
          group: t.group || "",
          tasks: [],
        });
      }
      groupsMap.get(gk).tasks.push(t);
    }

    collecting = true;
    try {
      const entries = [...groupsMap.values()];
      for (let i = 0; i < entries.length; i++) {
        const { partition, platform, group, tasks: groupTasks } = entries[i];
        const matchAlertMeta = { partition };
        const prevWorkCount =
          typeof store.getPreviousWorkCount === "function"
            ? store.getPreviousWorkCount(group, platform, matchAlertMeta)
            : 0;
        try {
          const data = await collectAccount({ partition, platform });
          // 以采集返回时刻的 UTC+8 日期为整次写入的唯一日期，daily/works-daily/intraday 统一按 collectNow 归档
          const collectNow = Date.now();
          const outcome = handleAccountCollectOutcome({
            group,
            platform,
            partition,
            success: true,
            works: data.works,
            prevWorkCount,
            now: collectNow,
          });
          if (!outcome.ok && outcome.zeroWorksAnomaly) {
            try {
              store.writeMeta(group, platform, {
                lastCollectAt: collectNow,
                lastError: outcome.reason,
              });
            } catch (_) {}
            errors.push({ group, platform, error: outcome.reason });
            for (const t of groupTasks) {
              matches[t.key] = { found: false, error: outcome.reason };
            }
            if (i < entries.length - 1) await sleep(2000);
            continue;
          }
          store.mergeDaily(
            group,
            platform,
            data.overview,
            data.fansHistory,
            collectNow,
            { works: data.works }
          );
          store.mergeWorks(group, platform, data.works, collectNow);
          store.writeMeta(
            group,
            platform,
            {
              lastCollectAt: collectNow,
              lastError: "",
              workCount: data.works.length,
            },
            matchAlertMeta
          );
          markPartitionCollected(partition, collectNow, false);
          const byTitle = buildTitleIndex(data.works, normalizeStatusTitle);
          for (const t of groupTasks) {
            const key = normalizeStatusTitle(t.title);
            const entry = key ? byTitle.get(key) : null;
            if (entry && entry.ambiguous) {
              matches[t.key] = { found: false, ambiguous: true };
            } else if (entry && entry.work) {
              matches[t.key] = {
                found: true,
                url: entry.work.url || "",
                workId: entry.work.workId,
              };
            } else {
              matches[t.key] = { found: false };
            }
          }
        } catch (err) {
          const message = (err && err.message) || String(err);
          try {
            handleAccountCollectOutcome({
              group,
              platform,
              partition,
              success: false,
              error: message,
              errorObj: err,
              prevWorkCount,
              now: Date.now(),
            });
          } catch (_) {}
          errors.push({ group, platform, error: message });
          for (const t of groupTasks) {
            matches[t.key] = { found: false, error: message };
          }
        }
        if (i < entries.length - 1) await sleep(2000); // 平台间间隔
      }
      return { matches, errors };
    } finally {
      collecting = false;
    }
  });
}

module.exports = { registerDataStatsIpc };
