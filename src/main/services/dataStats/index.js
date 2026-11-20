"use strict";

/**
 * 数据统计 IPC 入口。
 *
 * - stats:collect              采集一组账号（串行队列，账号间间隔防风控），进度经 stats:progress 推送
 * - stats:auto-run             每日定时自动采集单一操作（检查 auto-run.json → 互斥 → 采集 → 落盘日期）
 * - stats:get-data             读取单账号本地数据（daily + works + meta）
 * - stats:get-overview         全账号按日聚合（所有账号总览页）
 * - stats:get-content-summary  跨平台作品汇总（作品汇总 tab）
 * - stats:get-content-trend    单条内容各平台播放走势（作品汇总 tab 趋势弹窗）
 * - stats:get-analysis         规则数据分析（数据分析 tab，与 Excel「分析」sheet 共用计算函数）
 * - stats:save-chart-image     保存单张图表 PNG 图片（含 dataUrl 与大小校验、保存对话框）
 * - stats:save-chart-images-batch 批量导出全部图表 PNG 到选定目录（一次目录选择对话框）
 * - stats:get-link-overrides   读取作品关联手工矫正配置
 * - stats:set-link-override    设置单条作品手工关联（assign / detach）
 * - stats:merge-works          合并多条未关联作品为同一 manual 内容
 * - stats:clear-link-override  清除单条作品手工矫正，恢复自动匹配
 * - stats:apply-link-overrides 批量原子应用多条手工矫正操作（assign / detach / clear / merge），一次写盘
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
const {
  normalizeStatusTitle,
  buildTitleIndex,
  isValidAutoContentKey,
  isValidManualContentKey,
  isUnstableRecordKey,
  isValidWorkIdentityKey,
} = require("./contentLink");
const {
  validateExportDateRange,
  assertExportRangeNotAllFuture,
  buildDefaultExportFileName,
  resolveLinkValidationContext,
  buildContentSummaryData,
  buildContentTrendData,
  buildStatsAnalysisData,
  buildStatsWorkbookData,
  writeStatsXlsx,
} = require("./statsExport");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_TRIGGERS = new Set(["auto", "manual"]);
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHART_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CHART_IMAGE_B64_CHARS = Math.ceil(MAX_CHART_IMAGE_BYTES / 3) * 4;
const MAX_BATCH_CHART_IMAGES = 30;
const BASE64_BODY_RE = /^[A-Za-z0-9+/]+={0,2}$/;

let collecting = false;
let cancelled = false;
let collectedToday = { date: "", partitions: new Set() };
// auto-run.json 读写失败时的兜底：本进程内已自动跑过的日期（防止持久化失败导致每分钟重采）
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
  const current = store.readLinkOverrides();
  const workingDoc = {
    version: current.version,
    updatedAt: current.updatedAt,
    contents: cloneNoProtoMap(current.contents),
    excludedAuto: cloneNoProtoBoolMap(current.excludedAuto),
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

function markPartitionCollected(partition, date = getTodayStr()) {
  const key = normalizePartition(partition);
  if (!key) return;
  syncCollectedToday(date);
  collectedToday.partitions.add(key);
}

function hasPartitionCollected(partition, date = getTodayStr()) {
  const key = normalizePartition(partition);
  if (!key) return false;
  syncCollectedToday(date);
  return collectedToday.partitions.has(key);
}

async function collectAccounts(accounts, sender, options = {}) {
  const results = [];
  const total = accounts.length;
  const startedAt = Date.now();
  const skipCollected = Boolean(options && options.skipCollectedToday);
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

    if (skipCollected && hasPartitionCollected(acc.partition)) {
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        skipped: true,
      });
      progress("skipped");
      continue;
    }

    if (hasCollectedAny) {
      await sleep(2000); // 账号间间隔
      if (cancelled) break;
    }
    hasCollectedAny = true;

    progress("running");
    try {
      const data = await collectAccount({
        partition: acc.partition,
        platform: acc.platform,
      });
      store.mergeDaily(acc.group, acc.platform, data.overview, data.fansHistory);
      store.mergeWorks(acc.group, acc.platform, data.works);
      store.writeMeta(acc.group, acc.platform, {
        lastCollectAt: Date.now(),
        lastError: "",
        workCount: data.works.length,
      });
      markPartitionCollected(acc.partition);
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        workCount: data.works.length,
      });
      progress("success");
    } catch (err) {
      const message = (err && err.message) || String(err);
      try {
        store.writeMeta(acc.group, acc.platform, {
          lastCollectAt: Date.now(),
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
        success: false,
        error: message,
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
  try {
    store.appendCollectLog(logEntry);
  } catch (err) {
    console.warn(
      "[dataStats] 写入采集日志失败:",
      (err && err.message) || err
    );
  }
  return { results, cancelled };
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

function registerDataStatsIpc(options = {}) {
  const exportMaxRows =
    options && options.exportMaxRows !== undefined ? options.exportMaxRows : undefined;
  const exportDeps =
    options && options.exportDeps && typeof options.exportDeps === "object"
      ? options.exportDeps
      : undefined;
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
      return await collectAccounts(accounts, event && event.sender, { trigger });
    } finally {
      collecting = false;
    }
  });

  /**
   * 每日自动采集单一操作（认领与采集合并）：
   * - today = store.todayStr()（UTC+8，由主进程计算）
   * - auto-run.json 已含 today → 立即返回 { status: "already-ran", date: today }
   * - collecting 中 → 返回 { status: "busy" }，不写入任何内容
   * - 否则同步置位 collecting=true，执行采集（复用 collectAccounts，trigger:"auto"），
   *   开跑前原子追加 today 到 runs（写失败返回 store-failed、不采集），结束后复位 collecting
   */
  ipcMain.handle("stats:auto-run", async (event, args) => {
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
        return { rows: [], date: "", error: "不允许外部页面读取作品汇总" };
      }
      if (args != null && (typeof args !== "object" || Array.isArray(args))) {
        return { rows: [], date: "", error: "查询参数无效" };
      }
      await overrideWriteChain;
      const date = args && args.date !== undefined ? args.date : undefined;
      return buildContentSummaryData({ date }, exportDeps);
    } catch (err) {
      return {
        rows: [],
        date: "",
        error: (err && err.message) || "读取作品汇总失败",
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
      return {
        ok: false,
        error: (err && err.message) || "读取作品趋势失败",
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
      return {
        ok: false,
        error: (err && err.message) || "读取数据分析失败",
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

      const targetDir = path.resolve(result.filePaths[0]);
      fs.mkdirSync(targetDir, { recursive: true });
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
          overrides: {},
        };
      }
      await overrideWriteChain;
      const doc = store.readLinkOverrides();
      return {
        ok: true,
        version: doc.version,
        updatedAt: doc.updatedAt,
        contents: toPlainOverrides(doc.contents),
        excludedAuto: toPlainBoolMap(doc.excludedAuto),
        overrides: toPlainOverrides(doc.overrides),
      };
    } catch (err) {
      return {
        ok: false,
        error: (err && err.message) || "读取手动关联配置失败",
        contents: {},
        excludedAuto: {},
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
      return { ok: false, message: (err && err.message) || "导出失败" };
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
        try {
          const data = await collectAccount({ partition, platform });
          // 顺带落库（与「同步数据」同效果）
          store.mergeDaily(group, platform, data.overview, data.fansHistory);
          store.mergeWorks(group, platform, data.works);
          store.writeMeta(group, platform, {
            lastCollectAt: Date.now(),
            lastError: "",
            workCount: data.works.length,
          });
          markPartitionCollected(partition);
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
