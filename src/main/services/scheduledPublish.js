"use strict";

import fs from "fs";
import path from "path";
import { ipcMain } from "electron";
import ptConfig from "../config/ptConfig";
import { runPuppeteerTask } from "./puppeteerFile";
import { changeData } from "../server/utils";
import { normalizeCreativeStatement } from "../../shared/creativeStatement.js";
import { isRemotePublishFile, resolvePublishFile } from "./resolvePublishFile";
import { normalizeVideoRecordMetadata } from "../../shared/videoMetadata.js";
import { scheduledKey } from "./scheduledDedupe.js";
import { resolvePublishCompletion } from "../../shared/publishResult.js";
import {
  SCHEDULED_EXPIRE_GRACE_MS,
  formatUtc8DateTime,
  parsePublishAtUtc8,
} from "../../shared/publishThrottle.js";
import {
  confirmThrottleReservation,
  releaseThrottleReservation,
  settleThrottleByRecordId,
} from "./publishThrottle.js";

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const scheduledTimers = new Map();
const dispatchedKeys = new Set();
let schedulerStarted = false;
let schedulerStartedAt = null;
let refreshInterval = null;

export { SCHEDULED_EXPIRE_GRACE_MS };

function pad(n) {
  return String(n).padStart(2, "0");
}

function todayYmd(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parsePublishAt(value, nowMs = Date.now()) {
  return parsePublishAtUtc8(value, nowMs);
}

export function createScheduledRecord(
  recordItem,
  publishAtText,
  nowMs = Date.now(),
  options = {}
) {
  let parsed;
  if (
    publishAtText &&
    typeof publishAtText === "object" &&
    Number.isFinite(publishAtText.value)
  ) {
    if (publishAtText.value <= nowMs) {
      throw new Error("定时发布时间必须是未来时间");
    }
    const text = formatUtc8DateTime(publishAtText.value);
    parsed = { ok: true, value: publishAtText.value, text };
  } else if (
    options &&
    Number.isFinite(options.scheduledPublishAtMs) &&
    options.scheduledPublishAtMs > 0
  ) {
    if (options.scheduledPublishAtMs <= nowMs) {
      throw new Error("定时发布时间必须是未来时间");
    }
    const text = formatUtc8DateTime(options.scheduledPublishAtMs);
    parsed = { ok: true, value: options.scheduledPublishAtMs, text };
  } else {
    parsed = parsePublishAt(publishAtText, nowMs);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
  }
  const allowDuplicate =
    recordItem.allowDuplicate === true ||
    Boolean(recordItem.publishOptions && recordItem.publishOptions.allowDuplicate === true);
  const throttleReason = String(
    (options && options.throttleReason) || recordItem.throttleReason || ""
  ).trim();
  const throttleReservationId =
    (options && options.throttleReservationId) ||
    recordItem.throttleReservationId ||
    null;
  return {
    ...recordItem,
    ...(allowDuplicate ? { allowDuplicate: true } : {}),
    ...(throttleReason ? { throttleReason } : {}),
    ...(throttleReservationId ? { throttleReservationId } : {}),
    date: recordItem.date || todayYmd(nowMs),
    scheduledTask: true,
    scheduledPublishAt: parsed.value,
    scheduledPublishAtText: parsed.text,
    publishStatus: "scheduled",
    publishAttemptCount: Number(recordItem.publishAttemptCount) || 1,
    republishCount: Number(recordItem.republishCount) || 0,
    publishSuccessCount: Number(recordItem.publishSuccessCount) || 0,
    publishFailCount: Number(recordItem.publishFailCount) || 0,
    lastPublishMessage: throttleReason
      ? `等待定时发布（${throttleReason}）`
      : "等待定时发布",
    lastPublishAt: nowMs,
  };
}

export function isExpiredScheduledRecord(record, nowMs = Date.now()) {
  return (
    !!record &&
    record.scheduledTask === true &&
    record.publishStatus === "scheduled" &&
    Number(record.scheduledPublishAt) <= nowMs
  );
}

/**
 * 仅当定时任务已超过宽限期（默认 10 分钟）且应用在其计划时刻未运行时，才判定为 expired。
 * 应用持续运行期间刚到点的任务不得标 expired，一律进入执行队列（S11-fix #2）。
 */
function shouldExpireScheduledRecord(record, nowMs = Date.now()) {
  if (!isExpiredScheduledRecord(record, nowMs)) return false;
  const scheduledAt = Number(record.scheduledPublishAt);
  if (nowMs - scheduledAt <= SCHEDULED_EXPIRE_GRACE_MS) {
    return false;
  }
  if (
    schedulerStarted &&
    schedulerStartedAt !== null &&
    scheduledAt >= schedulerStartedAt
  ) {
    return false;
  }
  return true;
}

export function buildTaskPayloadFromRecord(record) {
  const cfg = ptConfig[record.pt] || {};
  const allowDuplicate =
    record.allowDuplicate === true ||
    Boolean(record.publishOptions && record.publishOptions.allowDuplicate === true);
  const recordIdPatch = record.id != null ? { recordId: record.id } : {};
  const allowDuplicatePatch = allowDuplicate ? { allowDuplicate: true } : {};
  const scheduledAtPatch =
    Number.isFinite(Number(record.scheduledPublishAt)) &&
    Number(record.scheduledPublishAt) > 0
      ? { scheduledPublishAt: Number(record.scheduledPublishAt) }
      : {};
  const reservationPatch = record.throttleReservationId
    ? { throttleReservationId: record.throttleReservationId }
    : {};
  if (record.textType === "article") {
    return {
      taskId: Date.now() + Math.random(),
      ...recordIdPatch,
      ...allowDuplicatePatch,
      ...scheduledAtPatch,
      bookName: record.bookName || record.textOtherName || "",
      textType: "article",
      data: {
        title: record.bt || record.textOtherName || "",
        content: record.content || "",
        articleFilePath: record.articleFilePath || record.filePath || "",
        coverPath: record.coverPath || "",
        category: record.category || "前端",
        tags: record.bq || record.tags || "前端 Electron",
        summary: record.summary || "",
      },
      textOtherName: record.textOtherName || record.bt || "",
      selectedFile:
        record.selectedFile ||
        path.basename(record.articleFilePath || record.filePath || ""),
      url: record.uploadUrl || cfg.upload || record.url,
      show: false,
      mmCliSuppressWindow: true,
      closeWindowAfterPublish: true,
      useragent: record.useragent || cfg.useragent,
      partition: record.partition,
      pt: record.pt,
      phone: record.phone,
      date: record.date,
      coverPath: record.coverPath || "",
    };
  }
  const metadata = normalizeVideoRecordMetadata(record);
  return {
    taskId: Date.now() + Math.random(),
    ...recordIdPatch,
    ...allowDuplicatePatch,
    ...scheduledAtPatch,
    ...reservationPatch,
    bookName: record.bookName || record.textOtherName || "",
    textType: record.textType || "local",
    data: {
      textOtherName: record.textOtherName || "",
      title: metadata.title,
      description: metadata.description,
      shortTitle: metadata.shortTitle,
      tags: metadata.tags,
      ...metadata.legacy,
      creativeStatement: normalizeCreativeStatement(record.creativeStatement),
      // 定时视频发布透传封面（dy/ks/sph 读 data.data.coverPath，
      // 缺失会静默跳过自定义封面；文章分支一直有传，视频分支上游漏了）
      coverPath: record.coverPath || "",
      // 快手禁下载红线参数：定时触发时从记录字段回传（GUI 勾选/CLI --no-download 落档）
      noDownload: record.noDownload === true,
    },
    textOtherName: record.textOtherName || "",
    selectedFile: record.selectedFile || path.basename(record.filePath || ""),
    url: record.uploadUrl || cfg.upload || record.url,
    show: false,
    mmCliSuppressWindow: false,
    publishMode: record.publishMode || "publish",
    publishToDraft:
      record.publishMode === "draft" || record.publishToDraft === true,
    publishOptions: record.publishOptions || {},
    closeWindowAfterPublish: true,
    useragent: record.useragent || cfg.useragent,
    partition: record.partition,
    filePath: record.filePath,
    pt: record.pt,
    phone: record.phone,
    date: record.date,
  };
}

function updateRecord(record, patch) {
  if (!record || !record.id || !record.date) return;
  changeData({
    fileName: "pushData",
    type: "update",
    item: {
      id: record.id,
      date: record.date,
      ...patch,
    },
  });
}

export function listScheduledRecords() {
  const result = changeData({
    fileName: "pushData",
    type: "get",
    item: {
      page: 1,
      pageSize: 10000,
    },
  });
  const data = (result && result.data) || {};
  const rows = [];
  Object.keys(data).forEach((date) => {
    (data[date] || []).forEach((item) => {
      if (
        item &&
        item.scheduledTask === true &&
        item.publishStatus === "scheduled"
      ) {
        rows.push({ ...item, date: item.date || date });
      }
    });
  });
  return rows;
}

function settleScheduledLedger(record, status, extra = {}) {
  try {
    const reservationId = record && record.throttleReservationId;
    const isFormalSuccess =
      status === "success" &&
      extra.publishToDraft !== true &&
      String(extra.publishMode || "").trim().toLowerCase() !== "draft";
    if (reservationId) {
      if (isFormalSuccess) {
        confirmThrottleReservation(reservationId, {
          status: "success",
          ts:
            typeof extra.ts === "number" && Number.isFinite(extra.ts)
              ? extra.ts
              : Date.now(),
          isScheduled: false,
          recordId: record && record.id,
        }).catch(() => {});
      } else {
        releaseThrottleReservation(reservationId).catch(() => {});
      }
      return;
    }
    if (record && record.id != null) {
      settleThrottleByRecordId(record.id, status, extra).catch(() => {});
    }
  } catch (_) {
    /* ignore */
  }
}

function finishScheduledRecord(record, payload) {
  const nowMs = Date.now();
  if (payload && payload.skipped) {
    updateRecord(record, {
      publishStatus: "skipped",
      publishSuccessCount: 0,
      publishFailCount: 0,
      lastPublishMessage:
        (payload && payload.message) || "用户关闭窗口，已跳过发布",
      lastPublishAt: nowMs,
    });
    settleScheduledLedger(record, "skipped", { ts: nowMs });
    return;
  }
  const mergedPayload = {
    ...(payload || {}),
    publishMode:
      (payload && payload.publishMode) || record.publishMode || "publish",
    publishToDraft:
      (payload && payload.publishToDraft === true) ||
      (payload && payload.publishMode === "draft") ||
      record.publishMode === "draft" ||
      record.publishToDraft === true,
  };
  const completion = resolvePublishCompletion(mergedPayload);
  // 失败/异常时主进程已在发布页截了图，落库后视频管理里可点开回看
  const failScreenshot =
    (payload && payload.failScreenshot) || record.failScreenshot;
  const isPositive =
    completion.recordStatus === "success" ||
    completion.recordStatus === "draft";
  const isFailure =
    completion.recordStatus === "failed" ||
    completion.recordStatus === "login_required";
  updateRecord(record, {
    publishMode: completion.savedAsDraft ? "draft" : record.publishMode || "publish",
    publishToDraft: completion.savedAsDraft,
    publishStatus: completion.recordStatus,
    publishSuccessCount: isPositive ? 1 : 0,
    publishFailCount: isFailure ? 1 : 0,
    publishAbnormalCount: completion.publishAbnormal ? 1 : 0,
    ...(isPositive ? {} : { failScreenshot }),
    lastPublishMessage: completion.message,
    lastPublishAt: nowMs,
  });
  settleScheduledLedger(record, completion.recordStatus, {
    publishMode: completion.savedAsDraft ? "draft" : "publish",
    publishToDraft: completion.savedAsDraft,
    ts: nowMs,
  });
}

function executeScheduledRecord(record, dispatchKey) {
  if (!record || !record.id) {
    if (dispatchKey) dispatchedKeys.delete(dispatchKey);
    return;
  }
  executeScheduledRecordAsync(record)
    .catch((e) => {
      console.error("[scheduledPublish] 执行定时发布失败:", e && e.message);
      const nowMs = Date.now();
      updateRecord(record, {
        publishStatus: "failed",
        publishFailCount: 1,
        lastPublishMessage: (e && e.message) || "定时发布执行失败",
        lastPublishAt: nowMs,
      });
      settleScheduledLedger(record, "failed", { ts: nowMs });
    })
    .finally(() => {
      if (dispatchKey) dispatchedKeys.delete(dispatchKey);
    });
}

async function executeScheduledRecordAsync(record) {
  if (!record || !record.id) return;

  let cleanupDownload = null;
  let publishFilePath = record.filePath;

  if (record.textType !== "article") {
    if (!publishFilePath) {
      const nowMs = Date.now();
      updateRecord(record, {
        publishStatus: "failed",
        publishFailCount: 1,
        lastPublishMessage: "本地视频文件不存在",
        lastPublishAt: nowMs,
      });
      settleScheduledLedger(record, "failed", { ts: nowMs });
      return;
    }

    if (isRemotePublishFile(publishFilePath)) {
      try {
        const resolved = await resolvePublishFile(publishFilePath);
        publishFilePath = resolved.localPath;
        cleanupDownload = resolved.cleanup;
      } catch (e) {
        const nowMs = Date.now();
        updateRecord(record, {
          publishStatus: "failed",
          publishFailCount: 1,
          lastPublishMessage: `下载视频失败: ${e && e.message ? e.message : e}`,
          lastPublishAt: nowMs,
        });
        settleScheduledLedger(record, "failed", { ts: nowMs });
        return;
      }
    } else if (!fs.existsSync(publishFilePath)) {
      const nowMs = Date.now();
      updateRecord(record, {
        publishStatus: "failed",
        publishFailCount: 1,
        lastPublishMessage: "本地视频文件不存在",
        lastPublishAt: nowMs,
      });
      settleScheduledLedger(record, "failed", { ts: nowMs });
      return;
    }
  }

  if (
    record.textType === "article" &&
    !String(record.content || "").trim() &&
    (!record.articleFilePath || !fs.existsSync(record.articleFilePath))
  ) {
    const nowMs = Date.now();
    updateRecord(record, {
      publishStatus: "failed",
      publishFailCount: 1,
      lastPublishMessage: "文章正文文件不存在",
      lastPublishAt: nowMs,
    });
    settleScheduledLedger(record, "failed", { ts: nowMs });
    return;
  }

  try {
    const taskPayload = buildTaskPayloadFromRecord({
      ...record,
      filePath: publishFilePath,
    });
    const taskId = taskPayload.taskId;
    const isDraftTask =
      record.publishMode === "draft" || record.publishToDraft === true;
    updateRecord(record, {
      publishStatus: isDraftTask ? "drafting" : "publishing",
      lastPublishMessage: isDraftTask
        ? "定时任务开始保存草稿"
        : "定时任务开始发布",
      lastPublishAt: Date.now(),
    });

    await new Promise((resolve) => {
      let publishSettled = false;
      const finish = () => {
        if (publishSettled) return;
        publishSettled = true;
        resolve();
      };
      const transport = {
        reply(channel, payload) {
          if (payload && payload.taskId != null && payload.taskId !== taskId)
            return;
          if (channel === "puppeteerFile-done") {
            finishScheduledRecord(record, payload);
            finish();
          } else if (channel === "puppeteer-noLogin") {
            // 登录失效单独标状态：任务本身没错，补扫码后可重新排期
            const nowMs = Date.now();
            updateRecord(record, {
              publishStatus: "login_required",
              publishFailCount: Number(record.publishFailCount || 0) + 1,
              lastPublishMessage:
                "登录态失效，需重新扫码登录后重排（本次未发布）",
              lastPublishAt: nowMs,
            });
            settleScheduledLedger(record, "login_required", { ts: nowMs });
            finish();
          }
        },
      };
      runPuppeteerTask(taskPayload, transport, () => {});
    });
  } finally {
    if (cleanupDownload) cleanupDownload();
  }
}

function dispatchScheduledRecord(record, key) {
  if (dispatchedKeys.has(key)) return;
  dispatchedKeys.add(key);
  executeScheduledRecord(record, key);
}

export function schedulePublishRecord(record, nowMs = Date.now()) {
  if (!record || !record.id || record.publishStatus !== "scheduled") return;
  const key = `${record.date || ""}:${record.id}`;
  if (dispatchedKeys.has(key)) return;

  const targetAt = Number(record.scheduledPublishAt);
  const existingEntry = scheduledTimers.get(key);

  if (targetAt <= nowMs) {
    if (shouldExpireScheduledRecord(record, nowMs)) {
      if (existingEntry) {
        clearTimeout(existingEntry.timer);
        scheduledTimers.delete(key);
      }
      updateRecord(record, {
        publishStatus: "expired",
        lastPublishMessage: "任务过期，未执行发布",
        lastPublishAt: nowMs,
      });
      settleScheduledLedger(record, "expired", { ts: nowMs });
      return;
    }
    // 已到点且在宽限期内或应用持续运行中：直接进入执行队列（避免刷新误取消或标 expired）
    if (existingEntry) {
      clearTimeout(existingEntry.timer);
      scheduledTimers.delete(key);
    }
    dispatchScheduledRecord(record, key);
    return;
  }

  // 尚未到点且已有同一时刻的有效计时器：保留原计时器不重复清掉重建
  if (existingEntry && existingEntry.scheduledPublishAt === targetAt) {
    return;
  }
  if (existingEntry) {
    clearTimeout(existingEntry.timer);
    scheduledTimers.delete(key);
  }
  const delay = Math.min(targetAt - nowMs, MAX_TIMER_DELAY_MS);
  const timer = setTimeout(() => {
    scheduledTimers.delete(key);
    if (Number(record.scheduledPublishAt) > Date.now()) {
      schedulePublishRecord(record);
      return;
    }
    dispatchScheduledRecord(record, key);
  }, delay);
  scheduledTimers.set(key, { timer, scheduledPublishAt: targetAt });
}

export function refreshScheduledPublishScheduler(nowMs = Date.now()) {
  // 同一轮触发里同一任务只处理一次：历史数据里可能存在同键重复记录
  // （isDuplicate 不覆盖 scheduledTask），这里做兜底防止双发。
  const activeRecords = listScheduledRecords();
  const activeKeySet = new Set(
    activeRecords
      .filter((r) => r && r.id)
      .map((r) => `${r.date || ""}:${r.id}`)
  );
  // 清理已被删除或取消的旧计时器，但绝不清掉仍在待发列表或已到点的计时器
  for (const [k, entry] of scheduledTimers.entries()) {
    if (!activeKeySet.has(k) && !dispatchedKeys.has(k)) {
      clearTimeout(entry.timer);
      scheduledTimers.delete(k);
    }
  }
  const inFlight = new Set();
  activeRecords.forEach((record) => {
    const key = scheduledKey(record);
    if (key && inFlight.has(key)) {
      console.warn(`[scheduled] 同键任务已在本轮处理，跳过重复记录: ${key}`);
      return;
    }
    if (key) inFlight.add(key);
    schedulePublishRecord(record, nowMs);
  });
}

export function notifyScheduledPublishChanged(nowMs = Date.now()) {
  if (!schedulerStarted) return;
  refreshScheduledPublishScheduler(nowMs);
}

export function getScheduledTimersSnapshot() {
  return Array.from(scheduledTimers.keys());
}

export function startScheduledPublishScheduler(nowMs = Date.now()) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerStartedAt = nowMs;
  refreshScheduledPublishScheduler(nowMs);
  refreshInterval = setInterval(() => {
    refreshScheduledPublishScheduler();
  }, REFRESH_INTERVAL_MS);
}

export function registerScheduledPublishIpc() {
  ipcMain.on("scheduledPublish:refresh", () => {
    refreshScheduledPublishScheduler();
  });
}

export function stopScheduledPublishScheduler() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  scheduledTimers.forEach((entry) => clearTimeout(entry.timer));
  scheduledTimers.clear();
  dispatchedKeys.clear();
  schedulerStarted = false;
  schedulerStartedAt = null;
}
