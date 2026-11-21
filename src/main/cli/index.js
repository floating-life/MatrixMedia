"use strict";

import path from "path";
import fs from "fs";
import xlsx from "xlsx";
import { normalizeCreativeStatement } from "../../shared/creativeStatement.js";
import { getCliSubArgv, isCliMode } from "./detectArgv";
import { parsePublishArgs, publishHelpText } from "./parsePublishArgs";
import {
  parsePublishArticleArgs,
  publishArticleHelpText,
} from "./parsePublishArticleArgs";
import { parseLoginArgs, loginHelpText } from "./parseLoginArgs";
import { parseAccountsArgs, accountsHelpText } from "./parseAccountsArgs";
import { parseHistoryArgs, historyHelpText } from "./parseHistoryArgs";
import { parseStatsArgs, statsHelpText } from "./parseStatsArgs";
import {
  parseCommentsArgs,
  commentsHelpText,
} from "./parseCommentsArgs";
import { runAccountsCli } from "./runAccountsCli";
import { runHistoryCli } from "./runHistoryCli";
import { runStatsCli } from "./runStatsCli";
import { runCommentsCli } from "./runCommentsCli";
import ptConfig from "../config/ptConfig";
import {
  runPuppeteerTask,
  registerPublishDedupeBypass,
} from "../services/puppeteerFile";
import { runDouyinCliLogin } from "../services/cliLogin/douyinCliLogin";
import { runSphCliLogin } from "../services/cliLogin/sphCliLogin";
import { runSphChromeLogin } from "../services/cliLogin/sphChromeLogin";
import { runSingleFilePublish } from "../services/publishVideo";
import { changeData } from "../server/utils";
import { createScheduledRecord } from "../services/scheduledPublish";
import { CLI_PUBLISH_TIMEOUT_MS } from "../services/upLoad/uploadTimeouts.js";
import { resolveAccountPublishMode } from "../services/accountPublishSettingsResolver.js";
import { resolveTaskPartition } from "../services/accountLookup.js";
import { ensureAccountRecordsMigrated } from "../services/accountMigration.js";
import { normalizeVideoMetadata } from "../../shared/videoMetadata.js";
import {
  normalizeBatchXlsxRows,
  sanitizePublishCliArgs,
  sanitizeTitle,
  splitAndSanitizeTags,
} from "../../shared/textSanitize.js";
import {
  DUPLICATE_EXIT_CODE,
  findRecentDuplicatePublish,
  readPushDataRecords,
} from "../../shared/publishDedupe.js";
import dataStatsStore from "../services/dataStats/store.js";
import { collectAccount as collectStatsAccount } from "../services/dataStats/collector.js";
import { handleAccountCollectOutcome } from "../services/dataStats/collectAlert.js";

export {
  isCliMode,
  getCliSubArgv,
  parsePublishArgs,
  publishHelpText,
  parsePublishArticleArgs,
  publishArticleHelpText,
  parseLoginArgs,
  loginHelpText,
  parseAccountsArgs,
  accountsHelpText,
  parseHistoryArgs,
  historyHelpText,
  parseXlsxRows,
  runStatsGetWithAlerts,
  runStatsSyncWithAlerts,
};

function fileStem(filePath) {
  const base = path.basename(filePath || "");
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(0, i) : base;
}

function articleFileName(filePath) {
  return filePath ? path.basename(filePath) : "";
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
 * Parse xlsx rows for batch publish. Shares normalizeBatchXlsxRows with ipcMain.js dialog:openBatchXlsx.
 * Returns video metadata rows filtered to rows with non-empty fileName.
 */
function parseXlsxRows(xlsxPath) {
  const workbook = xlsx.readFile(xlsxPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });
  return normalizeBatchXlsxRows(rows);
}

function readPushDataRecordsForCli() {
  return readPushDataRecords(changeData);
}

function formatAlertUtc8Time(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * `cli stats` 输出增强：在原字段基础上附带 collectAlert / hasCollectAlert，便于远程脚本监控采集失败告警。
 */
async function runStatsGetWithAlerts(opts, deps = {}) {
  const storeApi = deps.store || dataStatsStore;
  const outLog = deps.log || console.log;
  const acc = storeApi.readAccount(opts.phone, opts.platform);
  const dates = Object.keys(acc.daily || {}).sort();
  const latestDate = dates.length ? dates[dates.length - 1] : null;
  const latest = latestDate ? acc.daily[latestDate] : null;
  const collectAlert = acc.collectAlert || null;
  const hasCollectAlert = Boolean(collectAlert && collectAlert.alerted);
  const payload = {
    success: Boolean(latestDate),
    action: "get",
    group: opts.phone,
    platform: opts.platform,
    latestDate,
    latest,
    lastCollectAt: (acc.meta && acc.meta.lastCollectAt) || null,
    workCount: (acc.works || []).length,
    collectAlert,
    hasCollectAlert,
    ...(latestDate ? {} : { hint: "本地暂无数据，请先运行 cli stats-sync 采集" }),
  };

  if (opts.json) {
    outLog(JSON.stringify(payload, null, 2));
  } else {
    if (!latestDate) {
      outLog(`${opts.phone} · ${opts.platform}: 本地暂无数据，请先运行 cli stats-sync 采集`);
    } else {
      const n = (v) => (v == null ? "-" : Number(v).toLocaleString("zh-CN"));
      outLog(`${opts.phone} · ${opts.platform}（最新快照 ${latestDate}）`);
      outLog(
        `  粉丝 ${n(latest.fans)} | 播放 ${n(latest.plays)} | 点赞 ${n(latest.likes)} | 评论 ${n(
          latest.comments
        )} | 收藏 ${n(latest.favorites)} | 作品 ${payload.workCount} 条`
      );
    }
    if (hasCollectAlert) {
      const label = collectAlert.isLoginError ? "采集失败/需重新登录" : "采集失败";
      outLog(
        `  告警: ${label}（连续 ${collectAlert.consecutiveFailures} 次，首次失败 ${formatAlertUtc8Time(
          collectAlert.firstFailedAt
        )}）— ${collectAlert.reason}`
      );
    }
  }
  return latestDate ? 0 : 3;
}

/**
 * `cli stats-sync` 接入采集失败告警持久化与账号总播放防假 0 保护。
 */
async function runStatsSyncWithAlerts(opts, deps = {}) {
  const storeApi = deps.store || dataStatsStore;
  const collectorFn = deps.collectAccount || collectStatsAccount;
  const resolvePartFn = deps.resolveTaskPartition || resolveTaskPartition;
  const outcomeFn = deps.handleAccountCollectOutcome || handleAccountCollectOutcome;
  const outLog = deps.log || console.log;
  const errLog = deps.error || console.error;

  const startedAt = Date.now();
  const resolvedPartition = resolvePartFn({ phone: opts.phone, pt: opts.platform });
  const alertMeta = { partition: resolvedPartition, phone: opts.phone };
  const prevWorkCount =
    typeof storeApi.getPreviousWorkCount === "function"
      ? storeApi.getPreviousWorkCount(opts.phone, opts.platform, alertMeta)
      : 0;
  try {
    const data = await collectorFn({
      partition: resolvedPartition,
      platform: opts.platform,
    });
    const collectNow = Date.now();
    const outcome = outcomeFn({
      group: opts.phone,
      platform: opts.platform,
      ...alertMeta,
      success: true,
      works: data.works,
      prevWorkCount,
      now: collectNow,
    });
    if (!outcome.ok && outcome.zeroWorksAnomaly) {
      storeApi.writeMeta(opts.phone, opts.platform, {
        lastCollectAt: collectNow,
        lastError: outcome.reason,
      });
      storeApi.appendCollectLog({
        startedAt,
        finishedAt: collectNow,
        cancelled: false,
        results: [
          { group: opts.phone, platform: opts.platform, success: false, error: outcome.reason },
        ],
      });
      const collectAlert =
        typeof storeApi.getAccountCollectAlert === "function"
          ? storeApi.getAccountCollectAlert(opts.phone, opts.platform, alertMeta)
          : null;
      const failPayload = {
        success: false,
        action: "sync",
        group: opts.phone,
        platform: opts.platform,
        error: outcome.reason,
        zeroWorksAnomaly: true,
        collectAlert,
        hasCollectAlert: Boolean(collectAlert && collectAlert.alerted),
      };
      if (opts.json) {
        outLog(JSON.stringify(failPayload, null, 2));
      } else {
        errLog(`✗ 采集异常 ${opts.phone} · ${opts.platform}: ${outcome.reason}`);
      }
      return 3;
    }
    storeApi.mergeDaily(opts.phone, opts.platform, data.overview, data.fansHistory, collectNow, {
      works: data.works,
    });
    storeApi.mergeWorks(opts.phone, opts.platform, data.works, collectNow);
    storeApi.writeMeta(
      opts.phone,
      opts.platform,
      {
        lastCollectAt: collectNow,
        lastError: "",
        workCount: data.works.length,
      },
      alertMeta
    );
    storeApi.appendCollectLog({
      startedAt,
      finishedAt: Date.now(),
      cancelled: false,
      results: [
        {
          group: opts.phone,
          platform: opts.platform,
          success: true,
          workCount: data.works.length,
        },
      ],
    });
    const payload = {
      success: true,
      action: "sync",
      group: opts.phone,
      platform: opts.platform,
      overview: data.overview,
      workCount: data.works.length,
      fansHistoryPoints: (data.fansHistory || []).length,
      collectAlert: null,
      hasCollectAlert: false,
    };
    if (opts.json) {
      outLog(JSON.stringify(payload, null, 2));
    } else {
      outLog(
        `✓ 已采集 ${opts.phone} · ${opts.platform}：粉丝 ${data.overview.fans ?? "-"}，作品 ${
          data.works.length
        } 条`
      );
    }
    return 0;
  } catch (err) {
    const message = (err && err.message) || String(err);
    const failNow = Date.now();
    let collectAlert = null;
    try {
      outcomeFn({
        group: opts.phone,
        platform: opts.platform,
        ...alertMeta,
        success: false,
        error: message,
        errorObj: err,
        prevWorkCount,
        now: failNow,
      });
      if (typeof storeApi.getAccountCollectAlert === "function") {
        collectAlert = storeApi.getAccountCollectAlert(opts.phone, opts.platform, alertMeta);
      }
      storeApi.writeMeta(opts.phone, opts.platform, {
        lastCollectAt: failNow,
        lastError: message,
      });
      storeApi.appendCollectLog({
        startedAt,
        finishedAt: Date.now(),
        cancelled: false,
        results: [{ group: opts.phone, platform: opts.platform, success: false, error: message }],
      });
    } catch (_) {}
    if (opts.json) {
      outLog(
        JSON.stringify(
          {
            success: false,
            action: "sync",
            group: opts.phone,
            platform: opts.platform,
            error: message,
            collectAlert,
            hasCollectAlert: Boolean(collectAlert && collectAlert.alerted),
          },
          null,
          2
        )
      );
    } else {
      errLog(`✗ 采集失败 ${opts.phone} · ${opts.platform}: ${message}`);
    }
    return 3;
  }
}

/**
 * Case-insensitive filename resolver: try exact match, then stem-only match.
 * Returns absolute resolved path or null if not found.
 */
function resolveFileInDir(dirPath, fileName) {
  const norm = (s) =>
    String(s || "")
      .replace(/[﻿​‌‍ ]/g, "")
      .replace(/[\n\t]/g, "")
      .trim()
      .toLowerCase();
  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return null;
  }
  const indexByName = new Map();
  const indexByStem = new Map();
  entries.forEach((entry) => {
    indexByName.set(norm(entry), entry);
    const stem = entry.replace(/\.[^/.]+$/, "");
    if (!indexByStem.has(norm(stem))) indexByStem.set(norm(stem), entry);
  });
  const normName = norm(fileName);
  if (indexByName.has(normName))
    return path.join(dirPath, indexByName.get(normName));
  if (indexByStem.has(normName))
    return path.join(dirPath, indexByStem.get(normName));
  const stem = norm(String(fileName).replace(/\.[^/.]+$/, ""));
  if (indexByStem.has(stem)) return path.join(dirPath, indexByStem.get(stem));
  return null;
}

function deriveArticlePhoneForRecord(v) {
  if (v.phone) return String(v.phone).trim();
  if (!v.partition) return "";
  const stripped = String(v.partition).replace(/^persist:/, "");
  const idx = stripped.indexOf(v.platform);
  return idx > 0 ? stripped.slice(0, idx).trim() : stripped.trim();
}

function articleRecordValue(value) {
  return String(value || "");
}

function articleTagsValue(item) {
  return articleRecordValue(item.bq || item.tags);
}

function isSameArticleRecord(record, target) {
  return (
    record.textOtherName === target.textOtherName &&
    record.pt === target.pt &&
    record.textType === target.textType &&
    articleRecordValue(record.partition) ===
      articleRecordValue(target.partition) &&
    articleRecordValue(record.articleFilePath) ===
      articleRecordValue(target.articleFilePath) &&
    articleRecordValue(record.content) === articleRecordValue(target.content) &&
    articleRecordValue(record.coverPath) ===
      articleRecordValue(target.coverPath) &&
    articleRecordValue(record.category) ===
      articleRecordValue(target.category) &&
    articleTagsValue(record) === articleTagsValue(target) &&
    articleRecordValue(record.summary) === articleRecordValue(target.summary)
  );
}

/**
 * Batch directory publish handler.
 * @param {object} v - parsed publish args (must have .dir, .config, .platform, .partition, .phone)
 * @param {object} cfg - platform config from ptConfig
 * @returns {Promise<number>} exit code: 0=all success, 1=partial failure, 2=all failed
 */
async function runBatchDirPublish(v, cfg) {
  const resolvedDir = path.resolve(v.dir);
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    console.error("目录不存在或不是有效目录: " + resolvedDir);
    return 2;
  }
  const resolvedXlsx = path.resolve(v.config);
  if (!fs.existsSync(resolvedXlsx)) {
    console.error("xlsx 文件不存在: " + resolvedXlsx);
    return 2;
  }

  let rows;
  try {
    rows = parseXlsxRows(resolvedXlsx);
  } catch (e) {
    console.error(
      "解析 xlsx 失败: " + (e && e.message ? e.message : String(e))
    );
    return 2;
  }
  if (rows.length === 0) {
    console.error("xlsx 中没有有效行（文件名列全部为空）");
    return 2;
  }

  const recordDate = todayYmd();
  const results = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const resolvedFile = resolveFileInDir(resolvedDir, row.fileName);

    if (!resolvedFile) {
      const r = {
        index: i + 1,
        total: rows.length,
        fileName: row.fileName,
        title: row.title,
        platform: v.platform,
        phone: v.phone || "",
        status: "skipped",
        message: "文件不存在: " + row.fileName,
      };
      results.push(r);
      console.log(JSON.stringify({ progress: true, ...r }));
      continue;
    }

    const stem = fileStem(resolvedFile);
    const bt1 = row.title && row.title.trim() ? row.title.trim() : stem;
    const bookName = stem;

    // 封面：显式 --cover 全局覆盖 xlsx 封面列；行内相对路径相对视频目录解析。
    // 校验失败按「文件不存在」同一策略跳过该行，不中断整批。
    const rawCover = String(v.cover || row.coverPath || "").trim();
    let coverPath = "";
    if (rawCover) {
      const absCover = path.isAbsolute(rawCover)
        ? rawCover
        : path.join(resolvedDir, rawCover);
      const coverOk =
        fs.existsSync(absCover) && fs.statSync(absCover).isFile();
      const extOk =
        v.platform !== "视频号" || /\.(jpe?g|png)$/i.test(absCover);
      if (!coverOk) {
        const r = {
          index: i + 1,
          total: rows.length,
          fileName: row.fileName,
          title: row.title,
          platform: v.platform,
          phone: v.phone || "",
          status: "skipped",
          message: "封面文件不存在: " + absCover,
        };
        results.push(r);
        console.log(JSON.stringify({ progress: true, ...r }));
        continue;
      }
      if (!extOk) {
        const r = {
          index: i + 1,
          total: rows.length,
          fileName: row.fileName,
          title: row.title,
          platform: v.platform,
          phone: v.phone || "",
          status: "skipped",
          message: "视频号封面仅支持 jpg/png 格式: " + absCover,
        };
        results.push(r);
        console.log(JSON.stringify({ progress: true, ...r }));
        continue;
      }
      coverPath = absCover;
    }

    // 标签统一走共享 splitAndSanitizeTags（与 GUI / HTTP 保持完全一致）
    const tagList = splitAndSanitizeTags(row.tags);
    let bq = "";
    if (tagList.length) {
      const hashtagPlatforms = new Set(["视频号", "抖音", "快手"]);
      if (hashtagPlatforms.has(v.platform)) {
        bq = tagList.map((t) => (t.startsWith("#") ? t : "#" + t)).join(" ");
      } else {
        bq = tagList.join(",");
      }
    }

    const cs = normalizeCreativeStatement(row.creativeStatement || "");
    const metadata = normalizeVideoMetadata(
      {
        title: bt1,
        description: row.description,
        shortTitle: row.shortTitle,
        tags: tagList,
      },
      v.platform
    );

    // 批量目录发布同样尊重账号「默认发布到草稿」设置 + 显式 --draft
    // partition 先按账号记录的 accountKey 规整（新分组模型，见 accountLookup）
    v.partition = resolveTaskPartition({
      partition: v.partition,
      phone: v.phone,
      pt: v.platform,
    });
    if (!v.allowDuplicate) {
      const dup = findRecentDuplicatePublish(readPushDataRecordsForCli(), {
        pt: v.platform,
        phone: derivePhoneForRecord(v),
        partition: v.partition,
        title: metadata.title,
      });
      if (dup) {
        const r = {
          index: i + 1,
          total: rows.length,
          fileName: row.fileName,
          title: metadata.title,
          platform: v.platform,
          phone: v.phone || "",
          status: "duplicate",
          exitCode: DUPLICATE_EXIT_CODE,
          duplicate: true,
          lastPublishAt: dup.lastPublishAt,
          lastPublishAtText: dup.lastPublishAtText,
          message: dup.message,
        };
        results.push(r);
        console.log(JSON.stringify({ progress: true, ...r }));
        continue;
      }
    }
    const effectivePublishMode = resolveAccountPublishMode({
      phone: derivePhoneForRecord(v),
      pt: v.platform,
      partition: v.partition,
      requestDraftMode: Boolean(v.draft),
    });

    const taskId = Date.now() + Math.random();
    const taskPayload = {
      taskId,
      allowDuplicate: true,
      bookName,
      textType: "local",
      data: {
        textOtherName: stem,
        title: metadata.title,
        description: metadata.description,
        shortTitle: metadata.shortTitle,
        tags: metadata.tags,
        ...metadata.legacy,
        creativeStatement: cs,
        coverPath,
      },
      url: cfg.upload,
      show: false,
      mmCliSuppressWindow: false,
      publishMode: effectivePublishMode.publishMode,
      publishToDraft: effectivePublishMode.publishToDraft,
      publishOptions: v.publishOptions || {},
      closeWindowAfterPublish: true,
      useragent: cfg.useragent,
      partition: v.partition,
      phone: derivePhoneForRecord(v),
      filePath: resolvedFile,
      pt: v.platform,
    };

    const selectedFile = path.basename(resolvedFile);
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
      coverPath,
      filePath: resolvedFile,
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
      publishOptions: v.publishOptions || {},
      publishStatus: effectivePublishMode.publishToDraft
        ? "drafting"
        : "publishing",
      lastPublishMessage: effectivePublishMode.publishToDraft
        ? "等待保存草稿结果"
        : "等待发布结果",
      lastPublishAt: Date.now(),
    };

    let recordId = null;
    try {
      const addRes = changeData({
        fileName: "pushData",
        type: "add",
        item: recordItem,
      });
      if (addRes && addRes.success && Array.isArray(addRes.data)) {
        const found = [...addRes.data]
          .reverse()
          .find(
            (it) =>
              it.textOtherName === recordItem.textOtherName &&
              it.pt === recordItem.pt &&
              it.selectedFile === recordItem.selectedFile &&
              it.textType === recordItem.textType
          );
        if (found) recordId = found.id;
      }
    } catch (e) {
      console.error(
        "MatrixMedia: 写入 pushData 初始记录失败 [" + row.fileName + "]:",
        e && e.message
      );
    }
    if (recordId != null) {
      taskPayload.recordId = recordId;
    }

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
            publishSuccessCount: status === "success" ? 1 : 0,
            publishFailCount: status === "failed" ? 1 : 0,
            publishAbnormalCount: status === "abnormal" ? 1 : 0,
            lastPublishMessage: message || "",
            lastPublishAt: Date.now(),
          },
        });
      } catch (e) {
        console.error(
          "MatrixMedia: 更新 pushData 记录失败 [" + row.fileName + "]:",
          e && e.message
        );
      }
    };

    console.log(
      JSON.stringify({
        progress: true,
        index: i + 1,
        total: rows.length,
        fileName: row.fileName,
        title: bt1,
        platform: v.platform,
        phone: v.phone || "",
        status: "publishing",
      })
    );

    const taskResult = await new Promise((resolve) => {
      let settled = false;
      const finish = (ok, message) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, message });
      };

      const timer = setTimeout(() => {
        const min = Math.round(CLI_PUBLISH_TIMEOUT_MS / 60000);
        const msg = "CLI publish 超时（" + min + " 分钟）";
        console.error("[" + row.fileName + "] " + msg);
        updateRecord("failed", msg);
        finish(false, msg);
      }, CLI_PUBLISH_TIMEOUT_MS);

      const transport = {
        reply(channel, payload) {
          if (channel === "puppeteerFile-done") {
            if (payload && payload.taskId != null && payload.taskId !== taskId)
              return;
            if (payload && payload.skipped) {
              const msg = payload.message || "用户关闭窗口，已跳过发布";
              updateRecord("skipped", msg);
              finish(true, msg);
              return;
            }
            const ok = payload && payload.status === true;
            const abnormal = ok && payload.publishAbnormal === true;
            const msg =
              (payload && payload.message) || (ok ? "上传成功" : "上传失败");
            updateRecord(
              abnormal ? "abnormal" : ok ? "success" : "failed",
              msg
            );
            finish(ok && !abnormal, msg);
          } else if (channel === "puppeteer-noLogin") {
            if (payload && payload.taskId != null && payload.taskId !== taskId)
              return;
            const msg = "登录态异常或未登录";
            console.error(
              "[" + row.fileName + "] " + msg + ":",
              JSON.stringify(payload)
            );
            updateRecord("failed", msg);
            finish(false, msg);
          }
        },
      };

      runPuppeteerTask(taskPayload, transport, () => {});
    });

    const r = {
      index: i + 1,
      total: rows.length,
      fileName: row.fileName,
      title: bt1,
      platform: v.platform,
      phone: v.phone || "",
      status: taskResult.ok ? "success" : "failed",
      message: taskResult.message,
    };
    results.push(r);
    console.log(JSON.stringify({ progress: true, done: true, ...r }));
  }

  // Summary
  const succeeded = results.filter((r) => r.status === "success").length;
  const duplicateCount = results.filter((r) => r.status === "duplicate").length;
  const failed = results.filter(
    (r) => r.status === "failed" || r.status === "skipped" || r.status === "duplicate"
  ).length;
  console.log(
    JSON.stringify({
      summary: true,
      total: rows.length,
      succeeded,
      failed,
      duplicate: duplicateCount,
      message:
        "成功 " +
        succeeded +
        " / 失败 " +
        failed +
        (duplicateCount > 0 ? "（含重复拦截 " + duplicateCount + "）" : ""),
      results,
    })
  );

  if (failed === 0) return 0;
  if (succeeded === 0 && duplicateCount === results.length && duplicateCount > 0) {
    return DUPLICATE_EXIT_CODE;
  }
  if (succeeded === 0) return 2;
  return 1;
}

/**
 * @returns {Promise<number>} 进程退出码
 */
export async function runCliMain(argv = process.argv) {
  const sub = getCliSubArgv(argv);
  // CLI 链路同样先做账号记录「分组新模型」一次性迁移（幂等），诊断日志路由到 stderr 不污染 stdout
  {
    const origLog = console.log;
    console.log = (...args) => console.error(...args);
    try {
      ensureAccountRecordsMigrated();
    } finally {
      console.log = origLog;
    }
  }
  if (!sub || sub.length === 0) {
    console.error(
      "用法: <应用> cli <publish|publish-article|login|accounts|history|stats|stats-sync|stats-work|stats-export|comments|comments-reply|comments-probe> ..."
    );
    console.error("  cli publish --help");
    console.error("  cli publish-article --help");
    console.error("  cli login --help");
    console.error("  cli accounts --help");
    console.error("  cli history --help");
    console.error("  cli stats --help");
    return 2;
  }

  const cmd = sub[0];
  if (cmd === "login") {
    const parsed = parseLoginArgs(sub.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(loginHelpText());
      return 0;
    }
    const v = parsed.value;
    // CLI 登录同样按账号记录的 accountKey 规整 partition（新分组模型兼容：
    // 老数据 accountKey = phone 前缀，行为不变；新数据 accountKey = 账号名）
    v.partition = resolveTaskPartition({
      partition: v.partition,
      phone: v.phone,
      pt: v.platform,
    });
    try {
      const loginOpts = {
        partition: v.partition,
        show: v.show,
        terminalQr: v.terminalQr,
        timeoutMs: v.timeoutSec * 1000,
        saveQrPngPath: v.saveQrPng || null,
        puppeteerHeadless: v.puppeteerHeadless,
        phone: v.phone || null,
        force: v.force || false,
      };
      if (v.platform === "视频号") {
        if (v.browser === "chrome") {
          const result = await runSphChromeLogin({ partition: v.partition, phone: v.phone, timeoutMs: v.timeoutSec * 1000 });
          console.log(result.message);
          return result.exitCode;
        }
        return await runSphCliLogin(loginOpts);
      }
      return await runDouyinCliLogin(loginOpts);
    } catch (e) {
      console.error(e);
      return 1;
    }
  }

  if (cmd === "publish") {
    const sanitizedArgs = sanitizePublishCliArgs(sub.slice(1));
    const parsed = parsePublishArgs(sanitizedArgs);
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(publishHelpText());
      return 0;
    }

    const v = parsed.value;
    const allowDuplicate = Boolean(v.allowDuplicate);
    const cfg = ptConfig[v.platform];
    if (!cfg) {
      console.error("内部错误: 未找到平台配置", v.platform);
      return 2;
    }

    // Batch directory publish mode
    if (v.dir) {
      return await runBatchDirPublish(v, cfg);
    }

    const resolvedPartition = resolveTaskPartition({
      partition: v.partition,
      phone: v.phone,
      pt: v.platform,
    });
    const candTitle = sanitizeTitle(v.title) || fileStem(v.file);
    if (!allowDuplicate) {
      const hit = findRecentDuplicatePublish(readPushDataRecordsForCli(), {
        pt: v.platform,
        phone: v.phone || derivePhoneForRecord({ ...v, partition: resolvedPartition }),
        partition: resolvedPartition,
        title: candTitle,
      });
      if (hit) {
        console.log(
          JSON.stringify({
            status: "duplicate",
            exitCode: DUPLICATE_EXIT_CODE,
            duplicate: true,
            platform: hit.platform,
            phone: hit.phone,
            title: hit.title,
            lastPublishAt: hit.lastPublishAt,
            lastPublishAtText: hit.lastPublishAtText,
            message: hit.message,
          })
        );
        console.error(hit.message);
        return DUPLICATE_EXIT_CODE;
      }
    }
    if (allowDuplicate) {
      v.allowDuplicate = true;
      v.publishOptions = { ...(v.publishOptions || {}), allowDuplicate: true };
    }
    // 仅即时发布使用短期票据防止 publishVideo 自撞；定时发布依赖持久化的 allowDuplicate/recordId
    if (!v.publishAt) {
      registerPublishDedupeBypass({
        pt: v.platform,
        phone: v.phone || derivePhoneForRecord({ ...v, partition: resolvedPartition }),
        partition: resolvedPartition,
        title: candTitle,
      });
    }

    const result = await runSingleFilePublish(v);
    if (result.scheduled) {
      console.log(
        JSON.stringify({
          status: true,
          scheduled: true,
          id: result.id,
          publishAt: result.publishAt,
          message: result.message,
        })
      );
    } else if (result.exitCode === 0) {
      console.log(
        JSON.stringify({
          channel: "puppeteerFile-done",
          status: true,
          resultStatus: result.status,
          publishMode: result.publishMode,
          // 草稿模式的保存结果校验字段（#42），老版本 App 无这两个字段
          ...(result.draftVerified !== undefined
            ? { draftVerified: result.draftVerified }
            : {}),
          ...(result.draftUrlUnchanged !== undefined
            ? { draftUrlUnchanged: result.draftUrlUnchanged }
            : {}),
          message: result.message,
        })
      );
    } else if (result.exitCode === 4) {
      console.log(
        JSON.stringify({
          channel: "puppeteerFile-done",
          status: false,
          resultStatus: result.status,
          publishMode: result.publishMode,
          outcome: result.outcome,
          needsAttention: true,
          // 草稿未确认场景透传诊断字段，便于 e2e/脚本消费（#42）
          ...(result.draftUrlUnchanged !== undefined
            ? { draftUrlUnchanged: result.draftUrlUnchanged }
            : {}),
          message: result.message,
        })
      );
    } else if (result.exitCode === 5) {
      // 登录态失效：单独的退出码，直接给出重登指令（不要落进通用 else 只剩一句文案）
      console.error(result.message || "登录态已失效，需要重新登录后再试");
      const aliasMap = {
        抖音: "dy",
        快手: "ks",
        视频号: "sph",
        哔哩哔哩: "blbl",
        百家号: "bjh",
        小红书: "xhs",
      };
      const alias = aliasMap[v.platform] || "<平台>";
      console.error(
        `提示: 先执行 cli login -p ${alias} --phone ${v.phone || "<手机号>"} 在本机完成扫码，再重跑本次发布。`
      );
    } else if (result.exitCode === 3) {
      console.error(result.message || "登录态异常或未登录");
      if (v.platform === "抖音") {
        console.error(
          "提示: 可先执行 cli login -p dy --phone <手机号> 在本机完成扫码登录。"
        );
      }
    } else if (result.message) {
      console.error(result.message);
    }
    return result.exitCode;
  }

  if (cmd === "publish-article") {
    const parsed = parsePublishArticleArgs(sub.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(publishArticleHelpText());
      return 0;
    }

    const v = parsed.value;
    const cfg = ptConfig[v.platform];
    if (!cfg) {
      console.error("内部错误: 未找到平台配置", v.platform);
      return 2;
    }

    const resolvedArticleFile = v.file ? path.resolve(v.file) : "";
    const resolvedCover = v.cover ? path.resolve(v.cover) : "";
    // partition 按账号记录的 accountKey 规整（新分组模型，见 accountLookup）
    v.partition = resolveTaskPartition({
      partition: v.partition,
      phone: v.phone,
      pt: v.platform,
    });
    const title = String(v.title).trim();
    const category = String(v.category || "前端").trim() || "前端";
    const tags = String(v.tags || "前端 Electron").trim() || "前端 Electron";
    const summary = String(v.summary || "");
    const content = String(v.content || "");
    const selectedFile = articleFileName(resolvedArticleFile);
    const phone = deriveArticlePhoneForRecord(v);

    const taskPayload = {
      taskId: Date.now() + Math.random(),
      bookName: title,
      textType: "article",
      data: {
        title,
        content,
        articleFilePath: resolvedArticleFile,
        coverPath: resolvedCover,
        category,
        tags,
        summary,
      },
      textOtherName: title,
      selectedFile,
      url: cfg.upload,
      show: v.show,
      mmCliSuppressWindow: true,
      closeWindowAfterPublish: true,
      useragent: cfg.useragent,
      partition: v.partition,
      pt: v.platform,
      phone,
      coverPath: resolvedCover,
    };

    const taskId = taskPayload.taskId;
    const recordDate = todayYmd();
    const recordItem = {
      bookName: title,
      textOtherName: title,
      textType: "article",
      pt: v.platform,
      selectedFile,
      bt: title,
      bq: tags,
      articleFilePath: resolvedArticleFile,
      coverPath: resolvedCover,
      category,
      summary,
      content,
      useragent: cfg.useragent,
      phone,
      partition: v.partition,
      url: cfg.listIndex,
      uploadUrl: cfg.upload,
      date: recordDate,
      publishAttemptCount: 1,
      republishCount: 0,
      publishSuccessCount: 0,
      publishFailCount: 0,
      publishStatus: "publishing",
      lastPublishMessage: "等待发布结果",
      lastPublishAt: Date.now(),
    };

    if (v.publishAt) {
      let scheduledRecord;
      try {
        scheduledRecord = createScheduledRecord(recordItem, v.publishAt);
      } catch (e) {
        console.error(e && e.message ? e.message : e);
        return 2;
      }
      try {
        const addRes = changeData({
          fileName: "pushData",
          type: "add",
          item: scheduledRecord,
        });
        let recordId = null;
        if (addRes && addRes.success && Array.isArray(addRes.data)) {
          const found = [...addRes.data]
            .reverse()
            .find(
              (it) =>
                it.scheduledTask === true &&
                it.scheduledPublishAt === scheduledRecord.scheduledPublishAt &&
                isSameArticleRecord(it, scheduledRecord)
            );
          if (found) recordId = found.id;
        }
        console.log(
          JSON.stringify({
            status: true,
            scheduled: true,
            id: recordId,
            publishAt: scheduledRecord.scheduledPublishAtText,
            message: "定时文章发布任务已创建，已写入发布历史",
          })
        );
        return 0;
      } catch (e) {
        console.error("MatrixMedia: 写入定时文章发布记录失败:", e && e.message);
        return 1;
      }
    }

    let recordId = null;
    try {
      const addRes = changeData({
        fileName: "pushData",
        type: "add",
        item: recordItem,
      });
      if (addRes && addRes.success && Array.isArray(addRes.data)) {
        const found = [...addRes.data]
          .reverse()
          .find((it) => isSameArticleRecord(it, recordItem));
        if (found) recordId = found.id;
      }
    } catch (e) {
      console.error(
        "MatrixMedia: 写入文章 pushData 初始记录失败:",
        e && e.message
      );
    }
    if (recordId != null) {
      taskPayload.recordId = recordId;
    }

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
            publishSuccessCount: status === "success" ? 1 : 0,
            publishFailCount: status === "failed" ? 1 : 0,
            publishAbnormalCount: status === "abnormal" ? 1 : 0,
            lastPublishMessage: message || "",
            lastPublishAt: Date.now(),
          },
        });
      } catch (e) {
        console.error(
          "MatrixMedia: 更新文章 pushData 记录失败:",
          e && e.message
        );
      }
    };

    return await new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code);
      };

      const timer = setTimeout(() => {
        const min = Math.round(CLI_PUBLISH_TIMEOUT_MS / 60000);
        console.error(
          `CLI publish-article 超时（${min} 分钟），请检查网络或登录态`
        );
        updateRecord("failed", `CLI publish-article 超时 ${min} 分钟`);
        finish(1);
      }, CLI_PUBLISH_TIMEOUT_MS);

      const transport = {
        reply(channel, payload) {
          if (channel === "puppeteerFile-done") {
            if (
              payload &&
              payload.taskId != null &&
              payload.taskId !== taskId
            ) {
              return;
            }
            if (payload && payload.skipped) {
              console.log(
                JSON.stringify({
                  channel,
                  skipped: true,
                  message: payload.message,
                })
              );
              updateRecord(
                "skipped",
                payload.message || "用户关闭窗口，已跳过发布"
              );
              finish(0);
              return;
            }
            const ok = payload && payload.status === true;
            console.log(
              JSON.stringify({
                channel,
                status: ok,
                message: payload && payload.message,
              })
            );
            updateRecord(
              ok ? "success" : "failed",
              (payload && payload.message) ||
                (ok ? "文章发布成功" : "文章发布失败")
            );
            finish(ok ? 0 : 3);
          } else if (channel === "puppeteer-noLogin") {
            if (
              payload &&
              payload.taskId != null &&
              payload.taskId !== taskId
            ) {
              return;
            }
            console.error("登录态异常或未登录:", JSON.stringify(payload));
            updateRecord("failed", "登录态异常或未登录");
            finish(3);
          } else {
            console.log(channel, payload);
          }
        },
      };

      runPuppeteerTask(taskPayload, transport, () => {});
    });
  }

  if (cmd === "accounts") {
    const parsed = parseAccountsArgs(sub.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(accountsHelpText());
      return 0;
    }
    try {
      return await runAccountsCli(parsed.value);
    } catch (e) {
      console.error(e);
      return 1;
    }
  }

  if (cmd === "history") {
    const parsed = parseHistoryArgs(sub.slice(1));
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(historyHelpText());
      return 0;
    }
    try {
      return runHistoryCli(parsed.value);
    } catch (e) {
      console.error(e);
      return 1;
    }
  }

  // 数据统计：stats 读本地快照 / stats-sync 主动采集 / stats-work 查单视频 / stats-export 导出 Excel
  const STATS_CMDS = {
    stats: "get",
    "stats-sync": "sync",
    "stats-work": "work",
    "stats-export": "export",
  };
  if (Object.prototype.hasOwnProperty.call(STATS_CMDS, cmd)) {
    const parsed = parseStatsArgs(sub.slice(1), STATS_CMDS[cmd]);
    if (!parsed.ok) {
      if (cmd === "stats-export") {
        console.log(JSON.stringify({ success: false, error: parsed.error }, null, 2));
      }
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(statsHelpText(cmd));
      return 0;
    }
    try {
      if (cmd === "stats" && typeof runStatsGetWithAlerts === "function") {
        return await runStatsGetWithAlerts(parsed.value);
      }
      if (cmd === "stats-sync" && typeof runStatsSyncWithAlerts === "function") {
        return await runStatsSyncWithAlerts(parsed.value);
      }
      return await runStatsCli(parsed.value);
    } catch (e) {
      if (cmd === "stats-export") {
        console.log(
          JSON.stringify(
            { success: false, error: (e && e.message) || String(e) },
            null,
            2
          )
        );
      }
      console.error(e);
      return 1;
    }
  }

  // 评论互动：comments 拉评论列表 / comments-reply 回复（默认 dry-run）/ comments-probe 端点探针
  const COMMENTS_CMDS = {
    comments: "list",
    "comments-reply": "reply",
    "comments-probe": "probe",
  };
  if (Object.prototype.hasOwnProperty.call(COMMENTS_CMDS, cmd)) {
    const parsed = parseCommentsArgs(sub.slice(1), COMMENTS_CMDS[cmd]);
    if (!parsed.ok) {
      console.error(parsed.error);
      return 2;
    }
    if (parsed.value.help) {
      console.log(commentsHelpText(cmd));
      return 0;
    }
    try {
      return await runCommentsCli(parsed.value);
    } catch (e) {
      console.error(e);
      return 1;
    }
  }

  if (cmd === "--help" || cmd === "-h") {
    console.log(
      "可用子命令: publish | publish-article | login | accounts | history | stats | stats-sync | stats-work | stats-export | comments | comments-reply | comments-probe"
    );
    console.log("各自 --help 查看详细参数。");
    return 0;
  }

  console.error("未知子命令:", cmd);
  console.error(
    "支持: publish | publish-article | login | accounts | history | stats | stats-sync | stats-work | stats-export | comments | comments-reply | comments-probe"
  );
  return 2;
}
