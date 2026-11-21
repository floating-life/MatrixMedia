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
  getScheduledTaskDispatchStateSync,
  markScheduledTaskDispatched,
  recordScheduledTaskOutcome,
  markScheduledTaskHistorySynced,
} from "./publishThrottle.js";

const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 60 * 1000;
const scheduledTimers = new Map();
const dispatchedKeys = new Set();
const inFlightKeys = new Set();
const pendingHistoryPatches = new Map();
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
  if (!record || !record.id || !record.date) {
    return { ok: false, res: null };
  }
  const res = changeData({
    fileName: "pushData",
    type: "update",
    item: {
      id: record.id,
      date: record.date,
      ...patch,
    },
  });
  return { ok: Boolean(res && res.success === true), res };
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

function buildBackfillPatchFromLedgerState(record, state, nowMs = Date.now()) {
  if (state && state.resultPatch && typeof state.resultPatch === "object") {
    return { ...state.resultPatch };
  }
  const st = String((state && state.status) || "publishing")
    .trim()
    .toLowerCase();
  const ts =
    (state && (state.updatedAt || state.dispatchedAt)) || nowMs;
  const isDraft =
    Boolean(state && state.isDraft) ||
    record.publishMode === "draft" ||
    record.publishToDraft === true;
  if (st === "success" || st === "published") {
    return {
      publishMode: "publish",
      publishToDraft: false,
      publishStatus: "success",
      publishSuccessCount: 1,
      publishFailCount: 0,
      publishAbnormalCount: 0,
      lastPublishMessage: "已发布（从节流账本补写历史状态）",
      lastPublishAt: ts,
    };
  }
  if (st === "draft" || st === "draft_saved") {
    return {
      publishMode: "draft",
      publishToDraft: true,
      publishStatus: "draft",
      publishSuccessCount: 1,
      publishFailCount: 0,
      publishAbnormalCount: 0,
      lastPublishMessage: "已保存草稿（从节流账本补写历史状态）",
      lastPublishAt: ts,
    };
  }
  if (st === "skipped") {
    return {
      publishStatus: "skipped",
      publishSuccessCount: 0,
      publishFailCount: 0,
      lastPublishMessage: "用户关闭窗口，已跳过发布（从节流账本补写状态）",
      lastPublishAt: ts,
    };
  }
  if (st === "login_required") {
    return {
      publishStatus: "login_required",
      publishFailCount: Number(record.publishFailCount || 0) + 1,
      lastPublishMessage: "登录态失效，需重新扫码登录后重排（从节流账本补写状态）",
      lastPublishAt: ts,
    };
  }
  if (st === "expired") {
    return {
      publishStatus: "expired",
      lastPublishMessage: "任务过期，未执行发布",
      lastPublishAt: ts,
    };
  }
  if (st === "failed" || st === "fail" || st === "abnormal") {
    return {
      publishStatus: st === "abnormal" ? "abnormal" : "failed",
      publishFailCount: st === "abnormal" ? 0 : 1,
      publishAbnormalCount: st === "abnormal" ? 1 : 0,
      lastPublishMessage: "定时发布执行失败（从节流账本补写状态）",
      lastPublishAt: ts,
    };
  }
  return {
    publishStatus: isDraft ? "drafting" : "publishing",
    lastPublishMessage: isDraft
      ? "定时任务已派发保存草稿（从节流账本补写状态）"
      : "定时任务已派发（从节流账本补写状态）",
    lastPublishAt: ts,
  };
}

function tryBackfillScheduledHistory(record, key, state, nowMs = Date.now()) {
  const patch = buildBackfillPatchFromLedgerState(record, state, nowMs);
  const written = updateRecord(record, patch);
  if (written.ok) {
    if (key) {
      dispatchedKeys.delete(key);
      pendingHistoryPatches.delete(key);
    }
    if (record && record.id != null) {
      markScheduledTaskHistorySynced(record.id).catch(() => {});
    }
    return true;
  }
  if (key) {
    dispatchedKeys.add(key);
    pendingHistoryPatches.set(key, patch);
  }
  return false;
}

async function settleScheduledLedger(record, status, extra = {}) {
  try {
    await recordScheduledTaskOutcome(record, status, extra);
  } catch (_) {
    /* ignore */
  }
}

async function finishScheduledRecord(record, payload, dispatchKey) {
  const nowMs = Date.now();
  if (payload && payload.skipped) {
    const patch = {
      publishStatus: "skipped",
      publishSuccessCount: 0,
      publishFailCount: 0,
      lastPublishMessage:
        (payload && payload.message) || "用户关闭窗口，已跳过发布",
      lastPublishAt: nowMs,
    };
    const writeRes = updateRecord(record, patch);
    if (!writeRes.ok && dispatchKey) {
      pendingHistoryPatches.set(dispatchKey, patch);
    }
    await settleScheduledLedger(record, "skipped", {
      ts: nowMs,
      resultPatch: patch,
      historySynced: writeRes.ok,
    });
    return writeRes.ok;
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
  const patch = {
    publishMode: completion.savedAsDraft ? "draft" : record.publishMode || "publish",
    publishToDraft: completion.savedAsDraft,
    publishStatus: completion.recordStatus,
    publishSuccessCount: isPositive ? 1 : 0,
    publishFailCount: isFailure ? 1 : 0,
    publishAbnormalCount: completion.publishAbnormal ? 1 : 0,
    ...(isPositive ? {} : { failScreenshot }),
    lastPublishMessage: completion.message,
    lastPublishAt: nowMs,
  };
  const writeRes = updateRecord(record, patch);
  if (!writeRes.ok && dispatchKey) {
    pendingHistoryPatches.set(dispatchKey, patch);
  }
  await settleScheduledLedger(record, completion.recordStatus, {
    publishMode: completion.savedAsDraft ? "draft" : "publish",
    publishToDraft: completion.savedAsDraft,
    ts: nowMs,
    resultPatch: patch,
    historySynced: writeRes.ok,
  });
  return writeRes.ok;
}

function executeScheduledRecord(record, dispatchKey) {
  if (!record || !record.id) {
    if (dispatchKey) {
      inFlightKeys.delete(dispatchKey);
      dispatchedKeys.delete(dispatchKey);
    }
    return;
  }
  let historyWritten = false;
  executeScheduledRecordAsync(record, dispatchKey)
    .then((outcome) => {
      historyWritten = Boolean(outcome && outcome.historyWritten === true);
    })
    .catch(async (e) => {
      console.error("[scheduledPublish] 执行定时发布失败:", e && e.message);
      const nowMs = Date.now();
      const patch = {
        publishStatus: "failed",
        publishFailCount: 1,
        lastPublishMessage: (e && e.message) || "定时发布执行失败",
        lastPublishAt: nowMs,
      };
      const writeRes = updateRecord(record, patch);
      historyWritten = writeRes.ok;
      if (!writeRes.ok && dispatchKey) {
        pendingHistoryPatches.set(dispatchKey, patch);
      }
      await settleScheduledLedger(record, "failed", {
        ts: nowMs,
        resultPatch: patch,
        historySynced: writeRes.ok,
      });
    })
    .finally(() => {
      if (dispatchKey) {
        inFlightKeys.delete(dispatchKey);
        // 写历史失败时绝不清除派发标记，防止下次刷新再次上传同一任务
        if (historyWritten) {
          dispatchedKeys.delete(dispatchKey);
          pendingHistoryPatches.delete(dispatchKey);
        }
      }
    });
}

async function executeScheduledRecordAsync(record, dispatchKey) {
  if (!record || !record.id) return { historyWritten: true };

  // 计时器到点时任务可能已被删除/改期：上传前重读历史确认它仍是待发（读不到就本轮不发，下轮刷新再判）
  const stillPending = listScheduledRecords().some(
    (r) => r && String(r.id) === String(record.id)
  );
  if (!stillPending) {
    console.warn("[scheduledPublish] 任务已删除、已改状态或历史暂不可读，跳过本次派发:", record.id);
    return { historyWritten: true, abortedBeforeUpload: true };
  }

  // 派发前先把「已派发」标记持久化到账本（按任务 id）；若账本已显示已开始/已成功则不再上传，只补写历史
  const markRes = await markScheduledTaskDispatched(record, Date.now());
  if (!markRes || markRes.ok !== true) {
    console.error(
      "[scheduledPublish] 持久化定时任务派发标记失败，中止本次派发以防重复上传:",
      markRes && markRes.error
    );
    return { historyWritten: true, abortedBeforeUpload: true };
  }
  if (markRes.alreadyDispatched) {
    const synced = tryBackfillScheduledHistory(
      record,
      dispatchKey,
      markRes.state,
      Date.now()
    );
    return { historyWritten: synced };
  }

  let cleanupDownload = null;
  let publishFilePath = record.filePath;

  const failBeforeUpload = async (message) => {
    const nowMs = Date.now();
    const patch = {
      publishStatus: "failed",
      publishFailCount: 1,
      lastPublishMessage: message,
      lastPublishAt: nowMs,
    };
    const writeRes = updateRecord(record, patch);
    if (!writeRes.ok && dispatchKey) {
      pendingHistoryPatches.set(dispatchKey, patch);
    }
    await settleScheduledLedger(record, "failed", {
      ts: nowMs,
      resultPatch: patch,
      historySynced: writeRes.ok,
    });
    return { historyWritten: writeRes.ok };
  };

  if (record.textType !== "article") {
    if (!publishFilePath) {
      return await failBeforeUpload("本地视频文件不存在");
    }

    if (isRemotePublishFile(publishFilePath)) {
      try {
        const resolved = await resolvePublishFile(publishFilePath);
        publishFilePath = resolved.localPath;
        cleanupDownload = resolved.cleanup;
      } catch (e) {
        return await failBeforeUpload(
          `下载视频失败: ${e && e.message ? e.message : e}`
        );
      }
    } else if (!fs.existsSync(publishFilePath)) {
      return await failBeforeUpload("本地视频文件不存在");
    }
  }

  if (
    record.textType === "article" &&
    !String(record.content || "").trim() &&
    (!record.articleFilePath || !fs.existsSync(record.articleFilePath))
  ) {
    return await failBeforeUpload("文章正文文件不存在");
  }

  try {
    const taskPayload = buildTaskPayloadFromRecord({
      ...record,
      filePath: publishFilePath,
    });
    const taskId = taskPayload.taskId;
    const isDraftTask =
      record.publishMode === "draft" || record.publishToDraft === true;
    const startPatch = {
      publishStatus: isDraftTask ? "drafting" : "publishing",
      lastPublishMessage: isDraftTask
        ? "定时任务开始保存草稿"
        : "定时任务开始发布",
      lastPublishAt: Date.now(),
    };
    const startWrite = updateRecord(record, startPatch);
    if (!startWrite.ok && dispatchKey) {
      pendingHistoryPatches.set(dispatchKey, startPatch);
    }

    const finalHistoryWritten = await new Promise((resolve) => {
      let publishSettled = false;
      const finish = (written) => {
        if (publishSettled) return;
        publishSettled = true;
        resolve(Boolean(written));
      };
      const transport = {
        reply(channel, payload) {
          if (payload && payload.taskId != null && payload.taskId !== taskId)
            return;
          if (channel === "puppeteerFile-done") {
            finishScheduledRecord(record, payload, dispatchKey)
              .then((written) => finish(written))
              .catch(() => finish(false));
          } else if (channel === "puppeteer-noLogin") {
            // 登录失效单独标状态：任务本身没错，补扫码后可重新排期
            const nowMs = Date.now();
            const patch = {
              publishStatus: "login_required",
              publishFailCount: Number(record.publishFailCount || 0) + 1,
              lastPublishMessage:
                "登录态失效，需重新扫码登录后重排（本次未发布）",
              lastPublishAt: nowMs,
            };
            const writeRes = updateRecord(record, patch);
            if (!writeRes.ok && dispatchKey) {
              pendingHistoryPatches.set(dispatchKey, patch);
            }
            settleScheduledLedger(record, "login_required", {
              ts: nowMs,
              resultPatch: patch,
              historySynced: writeRes.ok,
            })
              .then(() => finish(writeRes.ok))
              .catch(() => finish(writeRes.ok));
          }
        },
      };
      runPuppeteerTask(taskPayload, transport, () => {});
    });
    return { historyWritten: finalHistoryWritten };
  } finally {
    if (cleanupDownload) cleanupDownload();
  }
}

function dispatchScheduledRecord(record, key) {
  if (dispatchedKeys.has(key) || inFlightKeys.has(key)) return;
  dispatchedKeys.add(key);
  inFlightKeys.add(key);
  executeScheduledRecord(record, key);
}

export function schedulePublishRecord(record, nowMs = Date.now()) {
  if (!record || !record.id || record.publishStatus !== "scheduled") return;
  const key = `${record.date || ""}:${record.id}`;
  if (inFlightKeys.has(key)) return;

  const existingEntry = scheduledTimers.get(key);

  // 刷新时检查账本（及内存未写盘补丁）：若该任务 id 已开始/已成功，绝不再上传，只补写历史状态
  const ledgerDispatchState = getScheduledTaskDispatchStateSync(record.id);
  const pendingMemPatch = pendingHistoryPatches.get(key) || null;
  if (
    ledgerDispatchState.dispatched ||
    pendingMemPatch ||
    dispatchedKeys.has(key)
  ) {
    if (existingEntry) {
      clearTimeout(existingEntry.timer);
      scheduledTimers.delete(key);
    }
    const state = ledgerDispatchState.dispatched
      ? {
          ...ledgerDispatchState,
          resultPatch: ledgerDispatchState.resultPatch || pendingMemPatch,
        }
      : {
          status: "publishing",
          resultPatch: pendingMemPatch,
          updatedAt: nowMs,
        };
    tryBackfillScheduledHistory(record, key, state, nowMs);
    return;
  }

  const targetAt = Number(record.scheduledPublishAt);

  if (targetAt <= nowMs) {
    if (shouldExpireScheduledRecord(record, nowMs)) {
      if (existingEntry) {
        clearTimeout(existingEntry.timer);
        scheduledTimers.delete(key);
      }
      const expirePatch = {
        publishStatus: "expired",
        lastPublishMessage: "任务过期，未执行发布",
        lastPublishAt: nowMs,
      };
      const writeRes = updateRecord(record, expirePatch);
      if (!writeRes.ok) {
        dispatchedKeys.add(key);
        pendingHistoryPatches.set(key, expirePatch);
      }
      settleScheduledLedger(record, "expired", {
        ts: nowMs,
        resultPatch: expirePatch,
        historySynced: writeRes.ok,
      }).catch(() => {});
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

/**
 * 启动时处理上次运行中断、停在「发布中」的定时任务：
 * - 账本显示已成功/已存草稿 → 补写历史为对应结果；
 * - 否则（下载/上传中途退出）→ 标为失败并提示手动重发，绝不自动重传（宁可少发不重复发）。
 */
function recoverInterruptedScheduledTasks(nowMs = Date.now()) {
  const result = changeData({ fileName: "pushData", type: "get", item: { page: 1, pageSize: 10000 } });
  const data = (result && result.data) || {};
  Object.keys(data).forEach((date) => {
    (data[date] || []).forEach((item) => {
      if (!item || item.scheduledTask !== true || item.publishStatus !== "publishing") return;
      const record = { ...item, date: item.date || date };
      let state = null;
      try {
        state = getScheduledTaskDispatchStateSync(record.id);
      } catch (_) {
        return; // 账本读不了就先不动，下次启动再处理
      }
      const st = state && state.status;
      if (st === "success" || st === "draft") {
        updateRecord(record, {
          ...(state.resultPatch || {}),
          publishStatus: st,
          lastPublishMessage: st === "draft" ? "已存草稿（启动时补写）" : "发布成功（启动时补写）",
        });
        return;
      }
      updateRecord(record, {
        publishStatus: "failed",
        lastPublishMessage: "上次运行中断，任务未完成；为防重复发布未自动重试，请确认平台上是否已发出后手动重发",
        lastPublishAt: nowMs,
      });
    });
  });
}

export function startScheduledPublishScheduler(nowMs = Date.now()) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  schedulerStartedAt = nowMs;
  try {
    recoverInterruptedScheduledTasks(nowMs);
  } catch (err) {
    console.warn("[scheduledPublish] 恢复中断任务失败:", (err && err.message) || err);
  }
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
  inFlightKeys.clear();
  pendingHistoryPatches.clear();
  schedulerStarted = false;
  schedulerStartedAt = null;
}
