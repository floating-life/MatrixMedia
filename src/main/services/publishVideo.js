"use strict";

import fs from "fs";
import path from "path";
import {
  normalizeCreativeStatement,
  resolveCreativeStatementForPlatform,
} from "../../shared/creativeStatement.js";
import ptConfig from "../config/ptConfig";
import { runPuppeteerTask } from "./puppeteerFile";
import { changeData } from "../server/utils";
import {
  createScheduledRecord,
  notifyScheduledPublishChanged,
} from "./scheduledPublish";
import { findExistingScheduled } from "./scheduledDedupe.js";
import {
  getDefaultCreativeStatement,
  confirmThrottleReservation,
  recordThrottleEntryDirect,
  releaseThrottleReservation,
  checkExistingScheduledCreativeConflict,
  formatUtc8DateTime,
} from "./publishThrottle.js";
import { CLI_PUBLISH_TIMEOUT_MS } from "./upLoad/uploadTimeouts.js";
import {
  isRemotePublishFile,
  resolvePublishFile,
  guessFileNameFromUrl,
} from "./resolvePublishFile";
import { resolveAccountPublishMode } from "./accountPublishSettingsResolver.js";
import { resolveTaskPartition } from "./accountLookup.js";
import { resolvePublishCompletion } from "../../shared/publishResult.js";
import { normalizeVideoMetadata } from "../../shared/videoMetadata.js";
import {
  applyPlatformPublishRules,
  createAppliedRuleSnapshot,
  formatRuleAdjustmentsSummary,
  mergeRuleAdjustments,
} from "../../shared/platformRules.js";
import { resolveCollectionOption } from "../../shared/videoLink.js";
import {
  DY_SYNC_TOUTIAO_CONFLICT_MESSAGE,
  isDySyncToutiaoEnabled,
  checkDySyncToutiaoConflict,
} from "../cli/parsePublishArgs.js";

export {
  DY_SYNC_TOUTIAO_CONFLICT_MESSAGE,
  isDySyncToutiaoEnabled,
  checkDySyncToutiaoConflict,
};

/** 读取全部 pushData 记录（跨日期平铺），用于定时任务查重 */
function listPushDataRecords() {
  try {
    const res = changeData({
      fileName: "pushData",
      type: "get",
      item: { page: 1, pageSize: 10000 },
    });
    const data = (res && res.data) || {};
    const rows = [];
    Object.keys(data).forEach((date) => {
      (data[date] || []).forEach((it) => {
        if (it) rows.push({ ...it, date: it.date || date });
      });
    });
    return rows;
  } catch (e) {
    console.warn("读取 pushData 失败，跳过定时任务查重:", e && e.message);
    return [];
  }
}

function fileStemFromSource(source) {
  const raw = String(source || "").trim();
  const base = isRemotePublishFile(raw)
    ? guessFileNameFromUrl(raw)
    : path.basename(path.resolve(raw));
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function todayYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function derivePhoneForRecord(v) {
  if (v.phone) return String(v.phone);
  if (!v.partition) return "";
  const stripped = String(v.partition).replace(/^persist:/, "");
  const idx = stripped.indexOf(v.platform);
  return idx > 0 ? stripped.slice(0, idx) : stripped;
}

/**
 * 提前校验封面文件（在视频上传/下载之前拦截，避免大文件白传一次）：
 * 文件必须存在；视频号仅收 jpg/png（上传控件 accept 限制）。
 * @returns {{ ok: true, coverPath: string } | { ok: false, message: string }}
 */
function resolveCoverPath(v) {
  if (!v.cover) return { ok: true, coverPath: "" };
  const coverPath = path.resolve(v.cover);
  if (!fs.existsSync(coverPath) || !fs.statSync(coverPath).isFile()) {
    return { ok: false, message: `封面文件不存在: ${coverPath}` };
  }
  if (v.platform === "视频号" && !/\.(jpe?g|png)$/i.test(coverPath)) {
    return {
      ok: false,
      message: `视频号封面仅支持 jpg/png 格式: ${coverPath}`,
    };
  }
  return { ok: true, coverPath };
}

/**
 * 提前校验横版封面文件（4:3，抖音/视频号生效）：存在性 + 视频号 jpg/png 格式校验。
 */
function resolveCoverPathH(v) {
  const raw = v && (v.coverPathH || v.coverH);
  if (!raw) return { ok: true, coverPathH: "" };
  const coverPathH = path.resolve(raw);
  if (!fs.existsSync(coverPathH) || !fs.statSync(coverPathH).isFile()) {
    return { ok: false, message: `横版封面文件不存在: ${coverPathH}` };
  }
  if (v.platform === "视频号" && !/\.(jpe?g|png)$/i.test(coverPathH)) {
    return {
      ok: false,
      message: `视频号横版封面仅支持 jpg/png 格式: ${coverPathH}`,
    };
  }
  return { ok: true, coverPathH };
}

/**
 * 单文件发布（与 cli publish 单文件模式一致）
 * @param {object} v parsePublishArgs 解析后的参数
 * @param {{ sourceFile: string, resolvedFile: string } | null} fileContext 多平台复用已下载文件时传入
 * @returns {Promise<{ exitCode: number, status?: string, scheduled?: boolean, id?: string|null, publishAt?: string, message?: string }>}
 */
export async function runSingleFilePublish(
  v,
  fileContext = null,
  options = {}
) {
  const releaseOwnReservation = async () => {
    if (v && v.throttleReservationId) {
      const id = v.throttleReservationId;
      v.throttleReservationId = null;
      try {
        await releaseThrottleReservation(id);
      } catch (_) {}
    }
  };

  const dySyncConflict = checkDySyncToutiaoConflict([v]);
  if (dySyncConflict) {
    await releaseOwnReservation();
    return {
      exitCode: 2,
      status: "failed",
      message: dySyncConflict,
    };
  }

  const cfg = ptConfig[v.platform];
  if (!cfg) {
    await releaseOwnReservation();
    return {
      exitCode: 2,
      status: "failed",
      message: `内部错误: 未找到平台配置 ${v.platform}`,
    };
  }

  const sourceFile = String(v.file || "").trim();
  const stem = fileStemFromSource(sourceFile);
  const rawMetadata = normalizeVideoMetadata(v, v.platform);
  const ruled = applyPlatformPublishRules(
    v.platform,
    {
      title: rawMetadata.title,
      description: rawMetadata.description,
      shortTitle: rawMetadata.shortTitle,
      tags: rawMetadata.tags,
      titleByPlatform: v.titleByPlatform,
      descByPlatform: v.descByPlatform,
    },
    { log: true }
  );
  const metadata = {
    title: ruled.title,
    description: ruled.bodyDescription,
    shortTitle: ruled.shortTitle,
    tags: ruled.tags,
    legacy: {
      bt1: ruled.title,
      bt2: ruled.bodyDescription,
      bt2Filled: ruled.shortTitle,
      bdText: ruled.bodyDescription,
      bq: ruled.tagsText,
    },
  };
  const ruleAdjustments = ruled.adjustments || [];
  const ruleAdjustmentsSummary = ruled.summary || "";
  const platformRulesApplied = createAppliedRuleSnapshot(ruled);
  const bookName = (v.bookName && String(v.bookName).trim()) || stem;

  // 封面文件在组装参数时就校验（存在性 / 视频号 jpg|png），失败早于视频下载与上传
  const cover = resolveCoverPath(v);
  if (!cover.ok) {
    await releaseOwnReservation();
    return { exitCode: 2, status: "failed", message: cover.message };
  }
  const coverPath = cover.coverPath;
  const coverH = resolveCoverPathH(v);
  if (!coverH.ok) {
    await releaseOwnReservation();
    return { exitCode: 2, status: "failed", message: coverH.message };
  }
  const coverPathH = coverH.coverPathH;

  let cleanupDownload = null;
  let resolvedFile = sourceFile;
  const deferRemoteDownload =
    !fileContext && v.publishAt && isRemotePublishFile(sourceFile);

  if (fileContext) {
    resolvedFile = fileContext.resolvedFile;
  } else if (!deferRemoteDownload) {
    try {
      const resolved = await resolvePublishFile(sourceFile);
      resolvedFile = resolved.localPath;
      cleanupDownload = resolved.cleanup;
    } catch (e) {
      await releaseOwnReservation();
      return {
        exitCode: 1,
        status: "failed",
        message: `下载视频失败: ${e && e.message ? e.message : e}`,
      };
    }
  }

  try {
    return await runSingleFilePublishInner(
      v,
      cfg,
      {
        sourceFile,
        resolvedFile,
        stem,
        metadata,
        bookName,
        coverPath,
        coverPathH,
        ruleAdjustments,
        ruleAdjustmentsSummary,
        platformRulesApplied,
      },
      options
    );
  } finally {
    if (cleanupDownload) cleanupDownload();
  }
}

async function runSingleFilePublishInner(
  v,
  cfg,
  {
    sourceFile,
    resolvedFile,
    stem,
    metadata,
    bookName,
    coverPath = "",
    coverPathH = "",
    ruleAdjustments = [],
    ruleAdjustmentsSummary = "",
    platformRulesApplied = null,
  },
  options = {}
) {
  // 新分组模型：CLI/HTTP 传入的 partition 可能仍按历史「phone 前缀」规则拼出，
  // 这里按账号记录的 accountKey 重算标准 partition（未命中记录时原样保留）
  v.partition = resolveTaskPartition({
    partition: v.partition,
    phone: v.phone,
    pt: v.platform,
  });

  // 结合「请求显式 draft」与账号「默认发布到草稿」设置，算出最终发布模式
  const effectivePublishMode = resolveAccountPublishMode({
    phone: derivePhoneForRecord(v),
    pt: v.platform,
    partition: v.partition,
    requestDraftMode: Boolean(v.draft),
  });
  const isDraft = effectivePublishMode.publishToDraft === true;

  let activeReservationId = v.throttleReservationId || null;
  if (isDraft && activeReservationId) {
    // 草稿一律不进节流账本：防御性释放上游可能带入的预留
    try {
      await releaseThrottleReservation(activeReservationId);
    } catch (_) {}
    activeReservationId = null;
    v.throttleReservationId = null;
  }

  // 创作声明：显式传入优先，未传时套用发布设置里的默认声明（默认 ai_generated），
  // 平台不支持该声明时按现有规则自动回退为 none。
  const rawCreativeStatement =
    v.creativeStatement != null && String(v.creativeStatement).trim() !== ""
      ? v.creativeStatement
      : getDefaultCreativeStatement();
  const finalCreativeStatement = resolveCreativeStatementForPlatform(
    rawCreativeStatement,
    v.platform
  );
  const throttleReason = String(v.throttleReason || "").trim();
  const throttleReasons = Array.isArray(v.throttleReasons)
    ? v.throttleReasons
    : throttleReason
    ? [throttleReason]
    : [];
  const isThrottled = Boolean(v.throttled);

  const effectivePublishOptions =
    v.publishOptions && typeof v.publishOptions === "object"
      ? { ...v.publishOptions }
      : {};
  if (
    !Object.prototype.hasOwnProperty.call(
      effectivePublishOptions,
      "collection"
    ) &&
    v.collection != null &&
    String(v.collection).trim() !== ""
  ) {
    const resolvedCol = resolveCollectionOption(v.platform, {
      collection: v.collection,
    });
    if (resolvedCol.enabled) {
      effectivePublishOptions.collection = resolvedCol.name;
    }
  }
  if (v.platform === "抖音" && isDySyncToutiaoEnabled(v)) {
    effectivePublishOptions.dySyncToutiao = true;
  } else {
    delete effectivePublishOptions.dySyncToutiao;
  }
  if (coverPathH) {
    effectivePublishOptions.coverPathH = coverPathH;
  }

  const ruleAdjustmentsPatch =
    Array.isArray(ruleAdjustments) && ruleAdjustments.length > 0
      ? {
          ruleAdjustments,
          ruleAdjustmentsSummary:
            ruleAdjustmentsSummary ||
            formatRuleAdjustmentsSummary(ruleAdjustments),
        }
      : {};

  const taskPayload = {
    taskId: Date.now() + Math.random(),
    ...(activeReservationId ? { throttleReservationId: activeReservationId } : {}),
    bookName,
    textType: "local",
    data: {
      textOtherName: stem,
      title: metadata.title,
      description: metadata.description,
      shortTitle: metadata.shortTitle,
      tags: metadata.tags,
      ...metadata.legacy,
      creativeStatement: normalizeCreativeStatement(finalCreativeStatement),
      coverPath,
      coverPathH,
      noDownload: v.noDownload === true,
      ...(platformRulesApplied ? { platformRulesApplied } : {}),
      ...ruleAdjustmentsPatch,
    },
    ...ruleAdjustmentsPatch,
    url: cfg.upload,
    show: v.show,
    mmCliSuppressWindow: false,
    publishMode: effectivePublishMode.publishMode,
    publishToDraft: effectivePublishMode.publishToDraft,
    publishOptions: effectivePublishOptions,
    closeWindowAfterPublish: v.show ? v.closeWindowAfterPublish : true,
    useragent: cfg.useragent,
    partition: v.partition,
    phone: derivePhoneForRecord(v),
    filePath: resolvedFile,
    pt: v.platform,
    useRealBrowser: Boolean(v.useRealBrowser),
  };

  const taskId = taskPayload.taskId;
  const recordDate = todayYmd();
  const selectedFile = isRemotePublishFile(sourceFile)
    ? guessFileNameFromUrl(sourceFile)
    : path.basename(resolvedFile);
  const recordItem = {
    bookName,
    textOtherName: stem,
    textType: "local",
    pt: v.platform,
    selectedFile,
    bt: metadata.title,
    title: metadata.title,
    description: metadata.description,
    shortTitle: metadata.shortTitle,
    tags: metadata.tags,
    ...metadata.legacy,
    creativeStatement: normalizeCreativeStatement(finalCreativeStatement),
    ...(throttleReason ? { throttleReason } : {}),
    ...(activeReservationId ? { throttleReservationId: activeReservationId } : {}),
    coverPath,
    ...(coverPathH ? { coverPathH } : {}),
    ...ruleAdjustmentsPatch,
    noDownload: v.noDownload === true,
    filePath:
      v.publishAt && isRemotePublishFile(sourceFile)
        ? sourceFile
        : resolvedFile,
    remoteFileUrl: isRemotePublishFile(sourceFile) ? sourceFile : "",
    useragent: cfg.useragent,
    phone: derivePhoneForRecord(v),
    partition: v.partition,
    url: cfg.listIndex,
    uploadUrl: cfg.upload,
    date: recordDate,
    publishAttemptCount: 1,
    republishCount: 0,
    publishSuccessCount: 0,
    publishFailCount: 0,
    publishMode: effectivePublishMode.publishMode,
    publishToDraft: effectivePublishMode.publishToDraft,
    publishOptions: effectivePublishOptions,
    publishStatus: effectivePublishMode.publishToDraft
      ? "drafting"
      : "publishing",
    lastPublishMessage: effectivePublishMode.publishToDraft
      ? "等待保存草稿结果"
      : "等待发布结果",
    lastPublishAt: Date.now(),
  };

  if (v.publishAt) {
    let scheduledRecord;
    try {
      scheduledRecord = createScheduledRecord(
        recordItem,
        v.publishAt,
        Date.now(),
        {
          scheduledPublishAtMs: v.scheduledPublishAtMs,
          throttleReason,
          throttleReservationId: activeReservationId,
        }
      );
    } catch (e) {
      if (activeReservationId) {
        try {
          await releaseThrottleReservation(activeReservationId);
        } catch (_) {}
      }
      return {
        exitCode: 2,
        status: "failed",
        scheduled: false,
        creativeStatement: finalCreativeStatement,
        message: e && e.message ? e.message : String(e),
      };
    }
    try {
      // 查重：同一视频在同一时刻只允许一条待触发任务，
      // 否则重跑 --publish-at 会造出两条到期记录 → 触发时双发。
      const existing = findExistingScheduled(listPushDataRecords(), scheduledRecord);
      if (existing) {
        if (activeReservationId) {
          try {
            await releaseThrottleReservation(activeReservationId);
          } catch (_) {}
        }
        const requestedCollection =
          resolveCollectionOption(v.platform, effectivePublishOptions).name ||
          "";
        const requestedDySyncToutiao =
          effectivePublishOptions.dySyncToutiao === true;
        const conflictInfo = checkExistingScheduledCreativeConflict(
          existing,
          finalCreativeStatement,
          requestedCollection,
          requestedDySyncToutiao
        );
        const existingPublishAt =
          existing.scheduledPublishAtText ||
          formatUtc8DateTime(existing.scheduledPublishAt) ||
          scheduledRecord.scheduledPublishAtText;
        if (conflictInfo.conflict) {
          console.warn(
            `[publish] 定时任务已存在（id=${existing.id}）但参数冲突: creative(stored=${conflictInfo.actualCreativeStatement}, requested=${conflictInfo.requestedCreativeStatement}), collection(stored=${conflictInfo.actualCollection || "无"}, requested=${conflictInfo.requestedCollection || "无"}), dySyncToutiao(stored=${Boolean(conflictInfo.actualDySyncToutiao)}, requested=${Boolean(conflictInfo.requestedDySyncToutiao)})`
          );
          return {
            exitCode: 4,
            status: "needs_attention",
            needsAttention: true,
            scheduled: false,
            duplicate: true,
            id: existing.id || null,
            publishAt: existingPublishAt,
            plannedAtMs: existing.scheduledPublishAt,
            creativeStatement: conflictInfo.actualCreativeStatement,
            requestedCreativeStatement: conflictInfo.requestedCreativeStatement,
            collection: conflictInfo.actualCollection,
            requestedCollection: conflictInfo.requestedCollection,
            ...(conflictInfo.dySyncToutiaoConflict
              ? {
                  dySyncToutiao: conflictInfo.actualDySyncToutiao,
                  requestedDySyncToutiao: conflictInfo.requestedDySyncToutiao,
                }
              : {}),
            throttled: false,
            throttleReason: "",
            reason: "",
            reasons: [],
            message: conflictInfo.message,
          };
        }
        console.log(
          `[publish] 定时任务已存在（id=${existing.id}），跳过重复创建: ${existingPublishAt}`
        );
        return {
          exitCode: 0,
          status: "scheduled",
          scheduled: true,
          duplicate: true,
          id: existing.id || null,
          publishAt: existingPublishAt,
          plannedAtMs: existing.scheduledPublishAt,
          creativeStatement: conflictInfo.actualCreativeStatement,
          ...(conflictInfo.actualCollection
            ? { collection: conflictInfo.actualCollection }
            : {}),
          ...(conflictInfo.actualDySyncToutiao ? { dySyncToutiao: true } : {}),
          throttled: false,
          throttleReason: "",
          reason: "",
          reasons: [],
          message: conflictInfo.message,
        };
      }
      const addRes = changeData({
        fileName: "pushData",
        type: "add",
        item: scheduledRecord,
      });
      if (!addRes || addRes.success !== true) {
        if (activeReservationId) {
          try {
            await releaseThrottleReservation(activeReservationId);
          } catch (_) {}
        }
        return {
          exitCode: 1,
          status: "failed",
          scheduled: false,
          id: null,
          creativeStatement: finalCreativeStatement,
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

      if (!isDraft) {
        const ledgerRes = activeReservationId
          ? await confirmThrottleReservation(activeReservationId, {
              status: "scheduled",
              ts: scheduledRecord.scheduledPublishAt,
              isScheduled: true,
              recordId,
              platform: v.platform,
              phone: recordItem.phone,
              partition: v.partition,
            })
          : await recordThrottleEntryDirect({
              pt: v.platform,
              phone: recordItem.phone,
              partition: v.partition,
              status: "scheduled",
              ts: scheduledRecord.scheduledPublishAt,
              isScheduled: true,
              recordId,
            });
        if (!ledgerRes || ledgerRes.ok !== true) {
          if (recordId != null && scheduledRecord.date) {
            try {
              changeData({
                fileName: "pushData",
                type: "delete",
                item: { id: recordId, date: scheduledRecord.date },
              });
            } catch (_) {}
          }
          return {
            exitCode: 1,
            status: "failed",
            scheduled: false,
            id: null,
            creativeStatement: finalCreativeStatement,
            message: (ledgerRes && ledgerRes.error) || "写入节流账本失败",
          };
        }
        v.throttleReservationId = null;
      }

      notifyScheduledPublishChanged();
      const scheduledMessage =
        isThrottled && throttleReason
          ? `已按发布节流排期至 ${scheduledRecord.scheduledPublishAtText}（${throttleReason}）`
          : "定时发布任务已创建，已写入发布历史";
      return {
        exitCode: 0,
        status: "scheduled",
        scheduled: true,
        id: recordId,
        publishAt: scheduledRecord.scheduledPublishAtText,
        plannedAtMs: scheduledRecord.scheduledPublishAt,
        creativeStatement: finalCreativeStatement,
        ...ruleAdjustmentsPatch,
        throttled: isThrottled,
        throttleReason,
        reason: throttleReason,
        reasons: throttleReasons,
        message: scheduledMessage,
      };
    } catch (e) {
      if (activeReservationId) {
        try {
          await releaseThrottleReservation(activeReservationId);
        } catch (_) {}
      }
      return {
        exitCode: 1,
        status: "failed",
        scheduled: false,
        creativeStatement: finalCreativeStatement,
        message: `写入定时发布记录失败: ${e && e.message ? e.message : e}`,
      };
    }
  }

  let recordId = null;
  try {
    const addRes = changeData({
      fileName: "pushData",
      type: "add",
      item: recordItem,
    });
    if (!addRes || addRes.success !== true) {
      if (activeReservationId) {
        try {
          await releaseThrottleReservation(activeReservationId);
        } catch (_) {}
      }
      return {
        exitCode: 1,
        status: "failed",
        scheduled: false,
        id: null,
        creativeStatement: finalCreativeStatement,
        message: (addRes && addRes.message) || "写入发布历史记录失败",
      };
    }
    if (Array.isArray(addRes.data)) {
      const found = [...addRes.data]
        .reverse()
        .find(
          (it) =>
            it.textOtherName === recordItem.textOtherName &&
            it.pt === recordItem.pt &&
            it.selectedFile === recordItem.selectedFile &&
            it.textType === recordItem.textType &&
            String(it.partition || "") === String(recordItem.partition || "")
        );
      if (found) recordId = found.id;
    }
  } catch (e) {
    if (activeReservationId) {
      try {
        await releaseThrottleReservation(activeReservationId);
      } catch (_) {}
    }
    console.error("MatrixMedia: 写入 pushData 初始记录失败:", e && e.message);
    return {
      exitCode: 1,
      status: "failed",
      scheduled: false,
      id: null,
      creativeStatement: finalCreativeStatement,
      message: `写入发布历史记录失败: ${e && e.message ? e.message : e}`,
    };
  }
  if (recordId != null) {
    taskPayload.recordId = recordId;
  }

  if (!isDraft) {
    const ledgerRes = activeReservationId
      ? await confirmThrottleReservation(activeReservationId, {
          status: "publishing",
          ts: recordItem.lastPublishAt,
          isScheduled: false,
          recordId,
          platform: v.platform,
          phone: recordItem.phone,
          partition: v.partition,
        })
      : await recordThrottleEntryDirect({
          pt: v.platform,
          phone: recordItem.phone,
          partition: v.partition,
          status: "publishing",
          ts: recordItem.lastPublishAt,
          isScheduled: false,
          recordId,
        });
    if (!ledgerRes || ledgerRes.ok !== true) {
      return {
        exitCode: 1,
        status: "failed",
        scheduled: false,
        id: recordId,
        creativeStatement: finalCreativeStatement,
        message: (ledgerRes && ledgerRes.error) || "写入节流账本失败",
      };
    }
    if (!activeReservationId && ledgerRes.id) {
      activeReservationId = ledgerRes.id;
      taskPayload.throttleReservationId = activeReservationId;
    }
    // 预留已由本执行任务接管，清空入参引用避免外层异常误释放
    v.throttleReservationId = null;
  }

  let ledgerSettled = false;
  const settleImmediateLedger = (status, extra = {}) => {
    if (ledgerSettled || !activeReservationId) return Promise.resolve();
    ledgerSettled = true;
    const isFormalSuccess =
      status === "success" &&
      !isDraft &&
      extra.savedAsDraft !== true;
    if (isFormalSuccess) {
      return confirmThrottleReservation(activeReservationId, {
        status: "success",
        ts: Date.now(),
        isScheduled: false,
        recordId,
        platform: v.platform,
        phone: recordItem.phone,
        partition: v.partition,
      }).catch(() => {});
    }
    return releaseThrottleReservation(activeReservationId).catch(() => {});
  };

  const updateRecord = (status, message) => {
    if (!recordId) return;
    try {
      changeData({
        fileName: "pushData",
        type: "update",
        item: {
          id: recordId,
          date: recordDate,
          publishStatus: status,
          publishSuccessCount:
            status === "success" || status === "draft" ? 1 : 0,
          // login_required 也是「本次没发出去」，必须计失败次数：
          // 否则 history/GUI 的失败判定（failCount>0 且 successCount=0）认不出来，
          // 记录会永远停在「发布中」。
          publishFailCount:
            status === "failed" || status === "login_required" ? 1 : 0,
          publishAbnormalCount: status === "abnormal" ? 1 : 0,
          lastPublishMessage: message || "",
          lastPublishAt: Date.now(),
        },
      });
    } catch (e) {
      console.error("MatrixMedia: 更新 pushData 记录失败:", e && e.message);
    }
  };

  return await new Promise((resolve) => {
    const waitForResult = options.waitForResult !== false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof options.onDone === "function") {
        try {
          options.onDone(result);
        } catch (e) {
          console.error("MatrixMedia: 发布完成回调失败:", e && e.message);
        }
      }
      if (waitForResult) resolve(result);
    };

    const timer = setTimeout(() => {
      const min = Math.round(CLI_PUBLISH_TIMEOUT_MS / 60000);
      const message = `发布超时（${min} 分钟），请检查网络或登录态`;
      console.error(message);
      updateRecord("failed", message);
      settleImmediateLedger("failed").finally(() => {
        finish({ exitCode: 1, status: "failed", message, id: recordId });
      });
    }, CLI_PUBLISH_TIMEOUT_MS);

    const transport = {
      reply(channel, payload) {
        if (channel === "puppeteerFile-done") {
          if (payload && payload.taskId != null && payload.taskId !== taskId) {
            return;
          }
          if (payload && payload.skipped) {
            const message = payload.message || "用户关闭窗口，已跳过发布";
            updateRecord("skipped", message);
            settleImmediateLedger("skipped").finally(() => {
              finish({
                exitCode: 0,
                status: "skipped",
                message,
                id: recordId,
              });
            });
            return;
          }
          const completion = resolvePublishCompletion({
            ...(payload || {}),
            publishMode:
              (payload && payload.publishMode) ||
              effectivePublishMode.publishMode,
            publishToDraft:
              (payload && payload.publishToDraft === true) ||
              (payload && payload.publishMode === "draft") ||
              effectivePublishMode.publishToDraft,
          });
          const mergedAdj = mergeRuleAdjustments(
            ruleAdjustments,
            payload && payload.ruleAdjustments
          );
          const mergedSummary = formatRuleAdjustmentsSummary(mergedAdj);
          const finalMessage =
            mergedSummary && !String(completion.message || "").includes(mergedSummary)
              ? `${completion.message}（规则调整：${mergedSummary}）`
              : completion.message;
          updateRecord(completion.recordStatus, finalMessage);
          settleImmediateLedger(completion.recordStatus, {
            savedAsDraft: completion.savedAsDraft,
          }).finally(() => {
            finish({
              exitCode: completion.exitCode,
              status: completion.status,
              message: finalMessage,
              id: recordId,
              creativeStatement: finalCreativeStatement,
              ...(mergedAdj.length > 0
                ? {
                    ruleAdjustments: mergedAdj,
                    ruleAdjustmentsSummary: mergedSummary,
                  }
                : {}),
              publishMode: completion.savedAsDraft ? "draft" : "publish",
              outcome: payload && payload.outcome,
              needsAttention: completion.fallbackDraft,
              // 草稿保存结果校验字段（#42），供 CLI JSON 透传给 e2e/脚本消费；
              // undefined 时 JSON.stringify 自动省略，保持老版本输出兼容
              draftVerified: payload && payload.draftVerified,
              draftUrlUnchanged: payload && payload.draftUrlUnchanged,
            });
          });
        } else if (channel === "puppeteer-noLogin") {
          if (payload && payload.taskId != null && payload.taskId !== taskId) {
            return;
          }
          const message = (payload && payload.message) || "登录态异常或未登录";
          console.error("登录态异常或未登录:", JSON.stringify(payload));
          // 登录失效不是内容失败：单独状态 + 退出码 5，便于流水线提示"先补登录"
          updateRecord("login_required", message);
          settleImmediateLedger("login_required").finally(() => {
            finish({
              exitCode: 5,
              status: "login_required",
              message,
              id: recordId,
              creativeStatement: finalCreativeStatement,
              loginRequired: true,
            });
          });
        }
      },
    };

    runPuppeteerTask(taskPayload, transport, () => {});
    if (!waitForResult) {
      resolve({
        exitCode: 0,
        status: "submitted",
        message: ruleAdjustmentsSummary
          ? `已提交发布任务（规则调整：${ruleAdjustmentsSummary}）`
          : "已提交发布任务",
        id: recordId,
        creativeStatement: finalCreativeStatement,
        ...ruleAdjustmentsPatch,
      });
    }
  });
}

function sortPublishPlatforms(list) {
  return [...list].sort((a, b) => {
    const ptA = a.platform || (a.item && a.item.platform) || "";
    const ptB = b.platform || (b.item && b.item.platform) || "";
    if (ptA.includes("视频号")) return -1;
    if (ptB.includes("视频号")) return 1;
    return 0;
  });
}

/**
 * 多平台顺序发布；远程视频只下载一次，全部完成后清理临时文件；
 * 混合立即与待排平台时，立即平台下载失败只影响立即平台，待排平台照常创建定时任务（到点再下载）。
 * @param {object[]} parsedList
 */
export async function runMultiPlatformPublish(parsedList) {
  if (!Array.isArray(parsedList) || parsedList.length === 0) {
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      message: "平台列表为空",
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    };
  }

  const dySyncConflict = checkDySyncToutiaoConflict(parsedList);
  if (dySyncConflict) {
    for (const item of parsedList) {
      if (item && item.throttleReservationId) {
        const resId = item.throttleReservationId;
        item.throttleReservationId = null;
        try {
          await releaseThrottleReservation(resId);
        } catch (_) {}
      }
    }
    return {
      success: false,
      exitCode: 2,
      status: "failed",
      message: dySyncConflict,
      total: parsedList.length,
      succeeded: 0,
      failed: parsedList.length,
      results: parsedList.map((item) => ({
        platform: item && item.platform ? item.platform : "",
        phone: (item && item.phone) || "",
        creativeStatement: (item && item.creativeStatement) || "none",
        success: false,
        exitCode: 2,
        status: "failed",
        message: dySyncConflict,
        id: null,
        publishAt: null,
        plannedAtMs: null,
        scheduled: false,
        throttled: false,
        throttleReason: "",
        reason: "",
        reasons: [],
      })),
    };
  }

  if (parsedList.length === 1) {
    const result = await runSingleFilePublish(parsedList[0]);
    const finalCs =
      result.creativeStatement || parsedList[0].creativeStatement || "none";
    const throttleReason = result.throttleReason || result.reason || "";
    const throttleReasons = Array.isArray(result.reasons)
      ? result.reasons
      : throttleReason
      ? [throttleReason]
      : [];
    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      status: result.status || (result.exitCode === 0 ? "success" : "failed"),
      message: result.message || "",
      id: result.id ?? null,
      publishAt: result.publishAt ?? null,
      plannedAtMs: result.plannedAtMs ?? null,
      scheduled: result.scheduled === true,
      throttled: result.throttled === true,
      throttleReason,
      reason: throttleReason,
      reasons: throttleReasons,
      creativeStatement: finalCs,
      ...(Array.isArray(result.ruleAdjustments) && result.ruleAdjustments.length > 0
        ? {
            ruleAdjustments: result.ruleAdjustments,
            ruleAdjustmentsSummary: result.ruleAdjustmentsSummary || "",
          }
        : {}),
      ...(result.needsAttention ? { needsAttention: true } : {}),
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.requestedCreativeStatement !== undefined
        ? { requestedCreativeStatement: result.requestedCreativeStatement }
        : {}),
      ...(result.collection !== undefined
        ? { collection: result.collection }
        : {}),
      ...(result.requestedCollection !== undefined
        ? { requestedCollection: result.requestedCollection }
        : {}),
      ...(result.dySyncToutiao !== undefined
        ? { dySyncToutiao: result.dySyncToutiao }
        : {}),
      ...(result.requestedDySyncToutiao !== undefined
        ? { requestedDySyncToutiao: result.requestedDySyncToutiao }
        : {}),
      total: 1,
      succeeded: result.exitCode === 0 ? 1 : 0,
      failed: result.exitCode === 0 ? 0 : 1,
      results: [
        {
          platform: parsedList[0].platform,
          phone: parsedList[0].phone || "",
          creativeStatement: finalCs,
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          status: result.status,
          message: result.message || "",
          id: result.id ?? null,
          publishAt: result.publishAt ?? null,
          plannedAtMs: result.plannedAtMs ?? null,
          scheduled: result.scheduled === true,
          throttled: result.throttled === true,
          throttleReason,
          reason: throttleReason,
          reasons: throttleReasons,
          ...(Array.isArray(result.ruleAdjustments) &&
          result.ruleAdjustments.length > 0
            ? {
                ruleAdjustments: result.ruleAdjustments,
                ruleAdjustmentsSummary: result.ruleAdjustmentsSummary || "",
              }
            : {}),
          ...(result.needsAttention ? { needsAttention: true } : {}),
          ...(result.duplicate ? { duplicate: true } : {}),
          ...(result.requestedCreativeStatement !== undefined
            ? { requestedCreativeStatement: result.requestedCreativeStatement }
            : {}),
          ...(result.collection !== undefined
            ? { collection: result.collection }
            : {}),
          ...(result.requestedCollection !== undefined
            ? { requestedCollection: result.requestedCollection }
            : {}),
          ...(result.dySyncToutiao !== undefined
            ? { dySyncToutiao: result.dySyncToutiao }
            : {}),
          ...(result.requestedDySyncToutiao !== undefined
            ? { requestedDySyncToutiao: result.requestedDySyncToutiao }
            : {}),
        },
      ],
    };
  }

  const sourceFile = String(parsedList[0].file || "").trim();
  const isRemote = isRemotePublishFile(sourceFile);
  const immediateItems = parsedList.filter((item) => !item.publishAt);
  const needImmediateDownload = immediateItems.length > 0;

  let cleanupDownload = null;
  let fileContext = null;
  let downloadErrorMessage = "";

  if (needImmediateDownload) {
    try {
      const resolved = await resolvePublishFile(sourceFile);
      fileContext = {
        sourceFile,
        resolvedFile: resolved.localPath,
      };
      cleanupDownload = resolved.cleanup;
    } catch (e) {
      downloadErrorMessage = `下载视频失败: ${e && e.message ? e.message : e}`;
    }
  }

  const results = new Array(parsedList.length);
  let pendingCleanupCount = fileContext ? immediateItems.length : 0;
  let immediateHandled = 0;
  const releaseSharedDownload = () => {
    pendingCleanupCount -= 1;
    if (pendingCleanupCount <= 0 && cleanupDownload) {
      cleanupDownload();
      cleanupDownload = null;
    }
  };

  const indexed = parsedList.map((item, origIdx) => ({ item, origIdx }));
  try {
    for (const { item, origIdx } of sortPublishPlatforms(indexed)) {
      const isItemScheduled = Boolean(item.publishAt);
      if (!isItemScheduled && downloadErrorMessage) {
        // 立即平台下载失败：释放其账本预留并标失败，但不影响待排平台照常建定时任务（#9）
        if (item.throttleReservationId) {
          const resId = item.throttleReservationId;
          item.throttleReservationId = null;
          try {
            await releaseThrottleReservation(resId);
          } catch (_) {}
        }
        results[origIdx] = {
          platform: item.platform,
          phone: item.phone || "",
          creativeStatement: item.creativeStatement || "none",
          success: false,
          exitCode: 1,
          status: "failed",
          message: downloadErrorMessage,
          id: null,
          publishAt: null,
          plannedAtMs: null,
          scheduled: false,
          throttled: false,
          throttleReason: "",
          reason: "",
          reasons: [],
        };
        continue;
      }

      const itemUsesSharedDownload = !isItemScheduled && Boolean(fileContext);
      const itemFileContext =
        isItemScheduled && isRemote ? null : fileContext;
      const result = await runSingleFilePublish(item, itemFileContext, {
        waitForResult: false,
        onDone: itemUsesSharedDownload ? releaseSharedDownload : undefined,
      });
      if (itemUsesSharedDownload) {
        immediateHandled += 1;
        // 定时任务或提前失败不会触发异步 onDone 回调，立即释放共享下载计数避免临时文件泄漏
        if (result.scheduled || result.status !== "submitted") {
          releaseSharedDownload();
        }
      }
      const throttleReason = result.throttleReason || result.reason || "";
      const throttleReasons = Array.isArray(result.reasons)
        ? result.reasons
        : throttleReason
        ? [throttleReason]
        : [];
      results[origIdx] = {
        platform: item.platform,
        phone: item.phone || "",
        creativeStatement:
          result.creativeStatement || item.creativeStatement || "none",
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        status: result.status,
        message: result.message || "",
        id: result.id ?? null,
        publishAt: result.publishAt ?? null,
        plannedAtMs: result.plannedAtMs ?? null,
        scheduled: result.scheduled === true,
        throttled: result.throttled === true,
        throttleReason,
        reason: throttleReason,
        reasons: throttleReasons,
        ...(Array.isArray(result.ruleAdjustments) &&
        result.ruleAdjustments.length > 0
          ? {
              ruleAdjustments: result.ruleAdjustments,
              ruleAdjustmentsSummary: result.ruleAdjustmentsSummary || "",
            }
          : {}),
        ...(result.needsAttention ? { needsAttention: true } : {}),
        ...(result.duplicate ? { duplicate: true } : {}),
        ...(result.requestedCreativeStatement !== undefined
          ? { requestedCreativeStatement: result.requestedCreativeStatement }
          : {}),
        ...(result.collection !== undefined
          ? { collection: result.collection }
          : {}),
        ...(result.requestedCollection !== undefined
          ? { requestedCollection: result.requestedCollection }
          : {}),
        ...(result.dySyncToutiao !== undefined
          ? { dySyncToutiao: result.dySyncToutiao }
          : {}),
        ...(result.requestedDySyncToutiao !== undefined
          ? { requestedDySyncToutiao: result.requestedDySyncToutiao }
          : {}),
      };
      if (
        !result.scheduled &&
        result.status === "submitted" &&
        item.platform.includes("视频号")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }
  } finally {
    if (fileContext && immediateHandled < immediateItems.length) {
      pendingCleanupCount -= immediateItems.length - immediateHandled;
      if (pendingCleanupCount <= 0 && cleanupDownload) {
        cleanupDownload();
        cleanupDownload = null;
      }
    }
  }

  const compactResults = results.filter(Boolean);
  const scheduledCount = compactResults.filter((r) => r.scheduled).length;
  const submittedCount = compactResults.filter(
    (r) => !r.scheduled && r.success
  ).length;
  const failedCount = compactResults.filter((r) => !r.success).length;
  const allScheduledResult =
    scheduledCount === compactResults.length && failedCount === 0;
  const topStatus = allScheduledResult
    ? "scheduled"
    : failedCount === compactResults.length
    ? "failed"
    : scheduledCount > 0 && submittedCount === 0
    ? "partial_scheduled"
    : "submitted";
  let topMessage = `已提交 ${compactResults.length} 个平台发布`;
  if (allScheduledResult) {
    topMessage = `已创建 ${scheduledCount} 个平台定时发布任务`;
  } else if (failedCount === compactResults.length && downloadErrorMessage) {
    topMessage = downloadErrorMessage;
  } else if (scheduledCount > 0 && failedCount > 0) {
    topMessage =
      submittedCount > 0
        ? `已提交 ${submittedCount} 个平台立即发布，${scheduledCount} 个平台已排期定时发布，${failedCount} 个平台失败`
        : `已创建 ${scheduledCount} 个平台定时发布任务，${failedCount} 个平台失败`;
  } else if (scheduledCount > 0 && submittedCount > 0) {
    topMessage = `已提交 ${submittedCount} 个平台立即发布，${scheduledCount} 个平台已按节流排期定时发布`;
  }

  const succeededCount = scheduledCount + submittedCount;
  return {
    success: succeededCount > 0,
    exitCode: failedCount === 0 ? 0 : 1,
    status: topStatus,
    scheduled: allScheduledResult,
    scheduledCount,
    submittedCount,
    message: topMessage,
    total: compactResults.length,
    succeeded: succeededCount,
    failed: failedCount,
    results: compactResults,
  };
}
