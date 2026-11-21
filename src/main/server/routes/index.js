var express = require("express");
var path = require("path");
const { changeData } = require("../utils");
const { isTrustedLocalRequest } = require("../requestGuard");
const { sanitizePublishPayloadObject } = require("../../../shared/textSanitize.js");
const {
  DUPLICATE_EXIT_CODE,
  findRecentDuplicatePublish,
  readPushDataRecords,
} = require("../../../shared/publishDedupe.js");
const { handleAccountCollectOutcome } = require("../../services/dataStats/collectAlert.js");
const {
  readPublishThrottleSettings,
  getDefaultCreativeStatement,
  planAndReservePublishTimes,
  releaseThrottleReservation,
  parsePublishAtUtc8,
} = require("../../services/publishThrottle.js");

var router = express.Router();

router.get("/", function (req, res) {
  res.send("<h1>MatrixMedia API</h1>");
});

router.get("/test", function (req, res) {
  res.json({
    success: true,
    message: "ok",
  });
});

router.get("/platforms", async function (req, res) {
  try {
    const { getVideoPublishPlatformList } = await import(
      "../../../shared/publishPlatforms.js"
    );
    const ptConfig = (await import("../../config/ptConfig.js")).default;
    res.json({
      success: true,
      platforms: getVideoPublishPlatformList(ptConfig),
    });
  } catch (error) {
    console.error("[HTTP /platforms]", error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : String(error),
    });
  }
});

router.get("/creative-statements", async function (req, res) {
  try {
    const { getCreativeStatementApiSpec } = await import(
      "../../../shared/creativeStatement.js"
    );
    const defaultStatement = getDefaultCreativeStatement();
    res.json({
      success: true,
      ...getCreativeStatementApiSpec(defaultStatement),
    });
  } catch (error) {
    console.error("[HTTP /creative-statements]", error);
    res.status(500).json({
      success: false,
      message: error && error.message ? error.message : String(error),
    });
  }
});

router.post("/changeData", function (req, res) {
  // 信任条件见 requestGuard：命中 Origin 白名单，或携带本次启动的
  // 随机令牌（打包后 file:// 页面不发送 Origin，必须靠令牌通过）。
  // 无 Origin 也无令牌的本地脚本 / 外部网站请求一律 403。
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  // 首个数据请求前确保账号记录已迁移到分组新模型（幂等，进程内只跑一次）
  import("../../services/accountMigration.js")
    .then((m) => m.ensureAccountRecordsMigrated())
    .catch(() => {})
    .then(() => {
      res.json(changeData({ ...req.body }));
    });
});

function fileStemForDedupe(rawFile) {
  const s = String(rawFile || "").trim();
  if (!s) return "";
  const clean = s.split("?")[0].split("#")[0];
  const base = path.basename(clean);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function normalizeFilePathForScheduledKey(rawFile) {
  const s = String(rawFile || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  return path.resolve(s);
}

function derivePhoneForHttpTarget(target, resolvedPartition) {
  if (target && target.phone) return String(target.phone);
  if (!resolvedPartition) return "";
  const stripped = String(resolvedPartition).replace(/^persist:/, "");
  const idx = target && target.platform ? stripped.indexOf(target.platform) : -1;
  return idx > 0 ? stripped.slice(0, idx) : stripped;
}

function readPushDataRecordsForHttp() {
  return readPushDataRecords(changeData);
}

router.post("/publish", async function (req, res) {
  // 守卫必须放在解析参数之前：本接口接受 http(s) 远程视频 URL
  // （resolvePublishFile 会先下载再发布到已登录账号），漏掉守卫时
  // 任意网页都能借用户的登录态发内容。
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const acquiredReservationIds = [];
  const ownedReservationTargets = [];
  try {
    const { parseMultiPublishRequest } = await import(
      "../../cli/parsePublishArgs.js"
    );
    const publishService = await import("../../services/publishVideo.js");
    const { resolveTaskPartition } = await import(
      "../../services/accountLookup.js"
    );
    const { registerPublishDedupeBypass } = await import(
      "../../services/puppeteerFile.js"
    );
    const { resolveAccountPublishMode } = await import(
      "../../services/accountPublishSettingsResolver.js"
    );

    const throttleSettings = readPublishThrottleSettings();
    const sanitizedBody = sanitizePublishPayloadObject(req.body || {});
    const parsed = parseMultiPublishRequest(sanitizedBody, {
      defaultCreativeStatement: throttleSettings.defaultCreativeStatement,
    });
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        status: "failed",
        message: parsed.error,
      });
    }

    const rootAllowDuplicate = Boolean(
      sanitizedBody && sanitizedBody.allowDuplicate === true
    );
    const records = readPushDataRecordsForHttp();
    const nowMs = Date.now();

    let result;
    if (!Array.isArray(parsed.value)) {
      const target = parsed.value;
      const resolvedPartition = resolveTaskPartition({
        partition: target.partition,
        phone: target.phone,
        pt: target.platform,
      });
      const targetPhone = derivePhoneForHttpTarget(target, resolvedPartition);
      const effectiveMode = resolveAccountPublishMode({
        phone: targetPhone,
        pt: target.platform,
        partition: resolvedPartition,
        requestDraftMode: Boolean(target.draft),
      });
      const isDraft = Boolean(effectiveMode.publishToDraft);
      const candTitle = target.title || fileStemForDedupe(target.file);
      const targetAllowDup = Boolean(rootAllowDuplicate || target.allowDuplicate === true);
      if (targetAllowDup) {
        target.allowDuplicate = true;
        target.publishOptions = { ...(target.publishOptions || {}), allowDuplicate: true };
      }

      // 显式 publishAt 先统一按 UTC+8 校验
      let explicitPublishAtMs = null;
      if (target.publishAt) {
        const parsedAt = parsePublishAtUtc8(target.publishAt, nowMs);
        if (!parsedAt.ok) {
          return res.status(400).json({
            success: false,
            status: "failed",
            message: parsedAt.error,
          });
        }
        explicitPublishAtMs = parsedAt.value;
        target.publishAt = parsedAt.text;
      }

      if (!targetAllowDup) {
        const hit = findRecentDuplicatePublish(
          records,
          {
            pt: target.platform,
            phone: targetPhone,
            partition: resolvedPartition,
            title: candTitle,
          },
          { now: nowMs, candidateScheduledAt: explicitPublishAtMs }
        );
        if (hit) {
          return res.status(200).json({
            success: false,
            status: "duplicate",
            exitCode: DUPLICATE_EXIT_CODE,
            duplicate: true,
            platform: hit.platform,
            phone: hit.phone,
            title: hit.title,
            creativeStatement: target.creativeStatement || "none",
            lastPublishAt: hit.lastPublishAt,
            lastPublishAtText: hit.lastPublishAtText,
            message: hit.message,
          });
        }
      }

      // 主进程串行加锁排期 + 立即写账本预留（草稿不进账本、既有同文件同时刻任务直接复用）
      const planRes = await planAndReservePublishTimes({
        targets: [
          {
            platform: target.platform,
            phone: targetPhone,
            partition: resolvedPartition,
            publishAt: target.publishAt || null,
            publishAtMs: explicitPublishAtMs,
            noThrottle: Boolean(target.noThrottle),
            isDraft,
            filePath: normalizeFilePathForScheduledKey(target.file),
            textType: "local",
          },
        ],
        now: nowMs,
      });

      if (!planRes.ok) {
        const isParamErr =
          planRes.code === "INVALID_PUBLISH_AT" ||
          planRes.code === "EXPIRED_PUBLISH_AT";
        const exitCode = isParamErr
          ? 2
          : planRes.code === "SCHEDULE_FULL"
          ? 3
          : 1;
        return res.status(isParamErr ? 400 : 200).json({
          success: false,
          status: "failed",
          exitCode,
          code: planRes.code,
          creativeStatement: target.creativeStatement || "none",
          message: planRes.message || planRes.error || "发布排期失败",
        });
      }

      const planItem = planRes.items[0];
      if (planItem && planItem.reservationId) {
        acquiredReservationIds.push(planItem.reservationId);
        target.throttleReservationId = planItem.reservationId;
        ownedReservationTargets.push(target);
      }

      if (planItem && planItem.scheduled) {
        target.publishAt = planItem.publishAt;
        target.scheduledPublishAtMs = planItem.plannedAtMs;
        target.throttled = planItem.throttled;
        target.throttleReason = planItem.reason;
        target.throttleReasons = planItem.reasons || [];
      } else {
        target.publishAt = null;
        target.scheduledPublishAtMs = null;
        target.throttled = false;
        target.throttleReason = "";
        target.throttleReasons = [];
        registerPublishDedupeBypass({
          pt: target.platform,
          phone: targetPhone,
          partition: resolvedPartition,
          title: candTitle,
        });
      }
      result = await publishService.runSingleFilePublish(target);
      acquiredReservationIds.length = 0;
      ownedReservationTargets.length = 0;
      if (result && result.creativeStatement == null) {
        result.creativeStatement = target.creativeStatement || "none";
      }
    } else {
      // platforms 数组（1 个或多个平台）：先逐平台校验 publishAt 与查重，仅拦截重复或参数无效的平台；
      // 其余有效平台照常进入主进程串行排期与账本预留，绝不在处理有效项前提前返回
      const targets = parsed.value;
      const allowedTargets = [];
      const allowedMeta = [];
      const allowedIndices = [];
      const blockedByIndex = new Map();
      const planFailedByIndex = new Map();

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const resolvedPartition = resolveTaskPartition({
          partition: t.partition,
          phone: t.phone,
          pt: t.platform,
        });
        const targetPhone = derivePhoneForHttpTarget(t, resolvedPartition);
        const effectiveMode = resolveAccountPublishMode({
          phone: targetPhone,
          pt: t.platform,
          partition: resolvedPartition,
          requestDraftMode: Boolean(t.draft),
        });
        const isDraft = Boolean(effectiveMode.publishToDraft);
        const candTitle = t.title || fileStemForDedupe(t.file);
        const allowDup = Boolean(t.allowDuplicate);
        if (allowDup) {
          t.allowDuplicate = true;
          t.publishOptions = { ...(t.publishOptions || {}), allowDuplicate: true };
        }
        let explicitPublishAtMs = null;
        if (t.publishAt) {
          const parsedAt = parsePublishAtUtc8(t.publishAt, nowMs);
          if (!parsedAt.ok) {
            if (!parsed.multi) {
              return res.status(400).json({
                success: false,
                status: "failed",
                exitCode: 2,
                code: parsedAt.code || "INVALID_PUBLISH_AT",
                message: parsedAt.error,
              });
            }
            planFailedByIndex.set(i, {
              platform: t.platform,
              phone: t.phone || "",
              creativeStatement: t.creativeStatement || "none",
              success: false,
              status: "failed",
              exitCode: 2,
              code: parsedAt.code || "INVALID_PUBLISH_AT",
              scheduled: false,
              message: parsedAt.error,
            });
            continue;
          }
          explicitPublishAtMs = parsedAt.value;
          t.publishAt = parsedAt.text;
        }
        if (!allowDup) {
          const hit = findRecentDuplicatePublish(
            records,
            {
              pt: t.platform,
              phone: targetPhone,
              partition: resolvedPartition,
              title: candTitle,
            },
            { now: nowMs, candidateScheduledAt: explicitPublishAtMs }
          );
          if (hit) {
            blockedByIndex.set(i, {
              platform: t.platform,
              phone: t.phone || "",
              creativeStatement: t.creativeStatement || "none",
              success: false,
              status: "duplicate",
              exitCode: DUPLICATE_EXIT_CODE,
              duplicate: true,
              title: hit.title,
              lastPublishAt: hit.lastPublishAt,
              lastPublishAtText: hit.lastPublishAtText,
              message: hit.message,
            });
            continue;
          }
        }
        allowedTargets.push(t);
        allowedMeta.push({
          resolvedPartition,
          targetPhone,
          isDraft,
          candTitle,
          explicitPublishAtMs,
        });
        allowedIndices.push(i);
      }

      if (allowedTargets.length === 0) {
        const mergedFailedList = targets
          .map((_, idx) => blockedByIndex.get(idx) || planFailedByIndex.get(idx))
          .filter(Boolean);
        const onlyDuplicates =
          blockedByIndex.size > 0 && planFailedByIndex.size === 0;
        const allParamErr =
          planFailedByIndex.size === mergedFailedList.length &&
          mergedFailedList.every((r) => r.exitCode === 2);
        if (allParamErr && !onlyDuplicates) {
          return res.status(400).json({
            success: false,
            status: "failed",
            exitCode: 2,
            total: mergedFailedList.length,
            succeeded: 0,
            failed: mergedFailedList.length,
            message: mergedFailedList.map((r) => r.message).join("；"),
            results: mergedFailedList,
          });
        }
        result = {
          success: false,
          status: onlyDuplicates ? "duplicate" : "failed",
          exitCode: onlyDuplicates ? DUPLICATE_EXIT_CODE : 3,
          ...(onlyDuplicates ? { duplicate: true } : {}),
          total: mergedFailedList.length,
          succeeded: 0,
          failed: mergedFailedList.length,
          message: mergedFailedList.map((r) => r.message).join("；"),
          results: mergedFailedList,
        };
      } else {
        // 仅对未命中重复拦截与参数校验的平台进行主进程串行节流排期与账本预留
        const planRes = await planAndReservePublishTimes({
          targets: allowedTargets.map((t, k) => ({
            platform: t.platform,
            phone: allowedMeta[k].targetPhone,
            partition: allowedMeta[k].resolvedPartition,
            publishAt: t.publishAt || null,
            publishAtMs: allowedMeta[k].explicitPublishAtMs,
            noThrottle: Boolean(t.noThrottle),
            isDraft: allowedMeta[k].isDraft,
            filePath: normalizeFilePathForScheduledKey(t.file),
            textType: "local",
          })),
          now: nowMs,
          allowPartialError: true,
        });

        if (!planRes.ok) {
          if (
            Array.isArray(planRes.reservationIds) &&
            planRes.reservationIds.length > 0
          ) {
            try {
              await releaseThrottleReservation(planRes.reservationIds);
            } catch (_) {}
          }
          const isParamErr =
            planRes.code === "INVALID_PUBLISH_AT" ||
            planRes.code === "EXPIRED_PUBLISH_AT";
          return res.status(isParamErr ? 400 : 200).json({
            success: false,
            status: "failed",
            exitCode: isParamErr ? 2 : 1,
            code: planRes.code,
            total: targets.length,
            succeeded: 0,
            failed: targets.length,
            message: planRes.message || planRes.error || "发布排期失败",
            results: [],
          });
        }

        const execTargets = [];
        const execIndices = [];
        const failedReservationIds = [];
        for (let k = 0; k < allowedTargets.length; k++) {
          const t = allowedTargets[k];
          const meta = allowedMeta[k];
          const planItem = planRes.items && planRes.items[k];
          if (!planItem || planItem.ok === false) {
            if (planItem && planItem.reservationId) {
              failedReservationIds.push(planItem.reservationId);
            }
            const itemExitCode =
              planItem &&
              (planItem.code === "INVALID_PUBLISH_AT" ||
                planItem.code === "EXPIRED_PUBLISH_AT")
                ? 2
                : 3;
            planFailedByIndex.set(allowedIndices[k], {
              platform: t.platform,
              phone: t.phone || "",
              creativeStatement: t.creativeStatement || "none",
              success: false,
              status: "failed",
              exitCode: itemExitCode,
              code:
                (planItem && planItem.code) ||
                (planItem && planItem.overflow ? "SCHEDULE_FULL" : "PLAN_FAILED"),
              scheduled: false,
              message: (planItem && planItem.error) || "排期已满",
            });
            continue;
          }
          if (planItem.reservationId) {
            acquiredReservationIds.push(planItem.reservationId);
            t.throttleReservationId = planItem.reservationId;
            ownedReservationTargets.push(t);
          }
          if (planItem.scheduled) {
            t.publishAt = planItem.publishAt;
            t.scheduledPublishAtMs = planItem.plannedAtMs;
            t.throttled = planItem.throttled;
            t.throttleReason = planItem.reason;
            t.throttleReasons = planItem.reasons || [];
          } else {
            t.publishAt = null;
            t.scheduledPublishAtMs = null;
            t.throttled = false;
            t.throttleReason = "";
            t.throttleReasons = [];
            registerPublishDedupeBypass({
              pt: t.platform,
              phone: meta.targetPhone,
              partition: meta.resolvedPartition,
              title: meta.candTitle,
            });
          }
          execTargets.push(t);
          execIndices.push(allowedIndices[k]);
        }

        if (failedReservationIds.length > 0) {
          try {
            await releaseThrottleReservation(failedReservationIds);
          } catch (_) {}
        }

        if (
          blockedByIndex.size === 0 &&
          planFailedByIndex.size === 0
        ) {
          result = parsed.multi
            ? await publishService.runMultiPlatformPublish(execTargets)
            : await publishService.runSingleFilePublish(execTargets[0]);
          acquiredReservationIds.length = 0;
          ownedReservationTargets.length = 0;
          if (!parsed.multi && result && result.creativeStatement == null) {
            result.creativeStatement = execTargets[0].creativeStatement || "none";
          }
        } else {
          const runRes =
            execTargets.length > 0
              ? await publishService.runMultiPlatformPublish(execTargets)
              : { results: [] };
          acquiredReservationIds.length = 0;
          ownedReservationTargets.length = 0;
          const runResults = Array.isArray(runRes && runRes.results) ? runRes.results : [];
          const mergedResults = new Array(targets.length);
          for (const [idx, blocked] of blockedByIndex.entries()) {
            mergedResults[idx] = blocked;
          }
          for (const [idx, failedItem] of planFailedByIndex.entries()) {
            mergedResults[idx] = failedItem;
          }
          for (let k = 0; k < execIndices.length; k++) {
            const rr = runResults[k];
            mergedResults[execIndices[k]] = rr
              ? {
                  ...rr,
                  creativeStatement:
                    rr.creativeStatement ||
                    execTargets[k].creativeStatement ||
                    "none",
                }
              : {
                  platform: execTargets[k].platform,
                  phone: execTargets[k].phone || "",
                  creativeStatement: execTargets[k].creativeStatement || "none",
                  success: false,
                  status: "failed",
                  exitCode: 1,
                  message: "发布未返回结果",
                };
          }
          const total = mergedResults.length;
          const succeeded = mergedResults.filter(
            (r) => r && (r.success === true || r.exitCode === 0)
          ).length;
          const scheduledCount = mergedResults.filter(
            (r) => r && r.scheduled === true
          ).length;
          const failed = total - succeeded;
          const hasDup = blockedByIndex.size > 0;
          result = {
            ...(runRes || {}),
            // 多平台部分失败时，整体 success 表示至少提交了一个有效平台
            success: succeeded > 0,
            scheduled: scheduledCount === total && failed === 0,
            status: hasDup
              ? succeeded > 0
                ? "partial_duplicate"
                : "duplicate"
              : failed === total
              ? "failed"
              : "partial_failed",
            exitCode:
              failed === 0
                ? 0
                : hasDup && failed === blockedByIndex.size
                ? DUPLICATE_EXIT_CODE
                : planFailedByIndex.size === failed
                ? 3
                : 1,
            total,
            succeeded,
            scheduledCount,
            failed,
            results: mergedResults,
            message: hasDup
              ? `共 ${total} 个平台：成功 ${succeeded} 个${
                  scheduledCount > 0 ? `（含节流排期 ${scheduledCount} 个）` : ""
                }，拦截重复 ${blockedByIndex.size} 个${
                  failed - blockedByIndex.size > 0
                    ? `，失败 ${failed - blockedByIndex.size} 个`
                    : ""
                }`
              : mergedResults
                  .filter((r) => r && !r.success && r.message)
                  .map((r) => r.message)
                  .join("；") || `共 ${total} 个平台：成功 ${succeeded} 个，失败 ${failed} 个`,
          };
        }
      }
    }

    const success = result.success === true || result.exitCode === 0;
    const httpStatus =
      result.exitCode === 2 && !parsed.multi ? 400 : success ? 200 : 200;

    const response = { ...result };
    response.success = success;
    if (parsed.skipped && parsed.skipped.length > 0) {
      response.skipped = parsed.skipped;
    }

    return res.status(httpStatus).json(response);
  } catch (error) {
    const unconsumedIds = ownedReservationTargets.length > 0
      ? ownedReservationTargets
          .map((t) => t && t.throttleReservationId)
          .filter(Boolean)
      : acquiredReservationIds;
    if (unconsumedIds.length > 0) {
      try {
        await releaseThrottleReservation(unconsumedIds);
      } catch (_) {}
    }
    console.error("[HTTP /publish]", error);
    return res.status(500).json({
      success: false,
      status: "failed",
      message: error && error.message ? error.message : String(error),
    });
  }
});

/* ---------------- 数据统计（采集层） ---------------- */

const { PLATFORM_ALIASES } = require("../../../shared/publishPlatforms.js");

const STATS_PLATFORMS = new Set([
  "抖音",
  "视频号",
  "哔哩哔哩",
  "百家号",
  "头条",
  "快手",
  "小红书",
]);

function resolveStatsParams(req) {
  const src = req.method === "GET" ? req.query : req.body || {};
  const phone = String(src.phone || "").trim();
  const rawPt = String(src.pt || src.platform || "").trim();
  // 支持短码（dy/sph/blbl/bjh/tt/ks/xhs）与中文名
  const pt = PLATFORM_ALIASES[rawPt] || PLATFORM_ALIASES[rawPt.toLowerCase()] || rawPt;
  return { phone, pt, title: src.title ? String(src.title) : "" };
}

/** GET /stats?phone=<分组>&pt=<平台> —— 读本地快照中的账号粉丝数据 */
router.get("/stats", function (req, res) {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const { phone, pt } = resolveStatsParams(req);
  if (!phone || !STATS_PLATFORMS.has(pt)) {
    return res.status(400).json({
      success: false,
      message: `参数错误：需要 phone 与 pt（${[...STATS_PLATFORMS].join("/")}）`,
    });
  }
  try {
    const store = require("../../services/dataStats/store.js");
    const acc = store.readAccount(phone, pt);
    const dates = Object.keys(acc.daily || {}).sort();
    const latestDate = dates.length ? dates[dates.length - 1] : null;
    res.json({
      success: Boolean(latestDate),
      group: phone,
      platform: pt,
      latestDate,
      latest: latestDate ? acc.daily[latestDate] : null,
      lastCollectAt: acc.meta.lastCollectAt || null,
      workCount: (acc.works || []).length,
      collectAlert: acc.collectAlert || null,
      hasCollectAlert: Boolean(acc.collectAlert && acc.collectAlert.alerted),
      ...(latestDate ? {} : { hint: "本地暂无数据，请先调用 POST /stats/sync 采集" }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: String(error && error.message || error) });
  }
});

/** POST /stats/sync { phone, pt } —— 主动采集该账号最新数据并写库 */
router.post("/stats/sync", async function (req, res) {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const { phone, pt } = resolveStatsParams(req);
  if (!phone || !STATS_PLATFORMS.has(pt)) {
    return res.status(400).json({
      success: false,
      message: `参数错误：需要 phone 与 pt（${[...STATS_PLATFORMS].join("/")}）`,
    });
  }
  const startedAt = Date.now();
  const store = require("../../services/dataStats/store.js");
  let syncPartition = "";
  let prevWorkCount = 0;
  try {
    const { collectAccount } = require("../../services/dataStats/collector.js");
    // 与登录窗口同一套 partition 规则：优先按账号记录的 accountKey（新分组模型），
    // 未命中记录时回退历史「phone "-" 前缀」规则，否则带 "-" 的账号读不到登录态
    const { resolveTaskPartition } = await import(
      "../../services/accountLookup.js"
    );
    syncPartition = resolveTaskPartition({ phone, pt });
    const alertMeta = { partition: syncPartition, phone };
    prevWorkCount =
      typeof store.getPreviousWorkCount === "function"
        ? store.getPreviousWorkCount(phone, pt, alertMeta)
        : 0;
    const data = await collectAccount({
      partition: syncPartition,
      platform: pt,
    });
    const collectNow = Date.now();
    const outcome = handleAccountCollectOutcome({
      group: phone,
      platform: pt,
      ...alertMeta,
      success: true,
      works: data.works,
      prevWorkCount,
      now: collectNow,
    });
    if (!outcome.ok && outcome.zeroWorksAnomaly) {
      store.writeMeta(phone, pt, {
        lastCollectAt: collectNow,
        lastError: outcome.reason,
      });
      store.appendCollectLog({
        startedAt,
        finishedAt: collectNow,
        cancelled: false,
        results: [{ group: phone, platform: pt, success: false, error: outcome.reason }],
      });
      return res.status(200).json({
        success: false,
        group: phone,
        platform: pt,
        error: outcome.reason,
        zeroWorksAnomaly: true,
        collectAlert: store.getAccountCollectAlert(phone, pt, alertMeta),
      });
    }
    store.mergeDaily(phone, pt, data.overview, data.fansHistory, collectNow, {
      works: data.works,
    });
    store.mergeWorks(phone, pt, data.works, collectNow);
    store.writeMeta(
      phone,
      pt,
      {
        lastCollectAt: collectNow,
        lastError: "",
        workCount: data.works.length,
      },
      alertMeta
    );
    store.appendCollectLog({
      startedAt,
      finishedAt: Date.now(),
      cancelled: false,
      results: [
        { group: phone, platform: pt, success: true, workCount: data.works.length },
      ],
    });
    res.json({
      success: true,
      group: phone,
      platform: pt,
      overview: data.overview,
      workCount: data.works.length,
      fansHistoryPoints: data.fansHistory.length,
      collectAlert: null,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    let collectAlert = null;
    try {
      const failNow = Date.now();
      const alertMeta = { partition: syncPartition, phone };
      handleAccountCollectOutcome({
        group: phone,
        platform: pt,
        ...alertMeta,
        success: false,
        error: message,
        errorObj: error,
        prevWorkCount,
        now: failNow,
      });
      collectAlert = store.getAccountCollectAlert(phone, pt, alertMeta);
      store.writeMeta(phone, pt, { lastCollectAt: failNow, lastError: message });
      store.appendCollectLog({
        startedAt,
        finishedAt: Date.now(),
        cancelled: false,
        results: [{ group: phone, platform: pt, success: false, error: message }],
      });
    } catch (_) { /* ignore */ }
    res.status(200).json({
      success: false,
      group: phone,
      platform: pt,
      error: message,
      collectAlert,
    });
  }
});

/** GET /stats/work?phone=<分组>&pt=<平台>&title=<标题> —— 按标题查视频发布数据 */
router.get("/stats/work", function (req, res) {
  if (!isTrustedLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }
  const { phone, pt, title } = resolveStatsParams(req);
  if (!phone || !STATS_PLATFORMS.has(pt) || !title) {
    return res.status(400).json({
      success: false,
      message: "参数错误：需要 phone、pt 与 title",
    });
  }
  try {
    const store = require("../../services/dataStats/store.js");
    const { works } = store.readAccount(phone, pt);
    const norm = (s) => String(s || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
    const hit = (works || []).find((w) => norm(w.title) === norm(title));
    if (!hit) {
      return res.json({
        success: false,
        message: `未找到该标题的视频（本库共 ${(works || []).length} 条，可先 sync 更新后重试）`,
      });
    }
    res.json({
      success: true,
      group: phone,
      platform: pt,
      work: {
        workId: hit.workId,
        title: hit.title,
        url: hit.url || "",
        publishTime: hit.publishTime || 0,
        play: hit.play,
        like: hit.like,
        comment: hit.comment,
        share: hit.share,
        favorite: hit.favorite,
        fansDelta: hit.fansDelta,
        closedStats: hit.closedStats || null,
        updatedAt: hit.updatedAt || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: String(error && error.message || error) });
  }
});

module.exports = router;
