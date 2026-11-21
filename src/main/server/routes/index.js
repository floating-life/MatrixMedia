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
  planPublishTimes,
  parseLocalPublishAt,
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
      const candTitle = target.title || fileStemForDedupe(target.file);
      const targetAllowDup = Boolean(rootAllowDuplicate || target.allowDuplicate === true);
      if (targetAllowDup) {
        target.allowDuplicate = true;
        target.publishOptions = { ...(target.publishOptions || {}), allowDuplicate: true };
      }
      if (!targetAllowDup) {
        const hit = findRecentDuplicatePublish(records, {
          pt: target.platform,
          phone: target.phone,
          partition: resolvedPartition,
          title: candTitle,
        });
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

      // 显式 publishAt 先校验，再过节流排期（只顺延不提前，除非 noThrottle）
      let explicitPublishAtMs = null;
      if (target.publishAt) {
        const parsedAt = parseLocalPublishAt(target.publishAt, nowMs);
        if (!parsedAt.ok) {
          return res.status(400).json({
            success: false,
            status: "failed",
            message: parsedAt.error,
          });
        }
        explicitPublishAtMs = parsedAt.value;
      }

      const planItem = planPublishTimes({
        targets: [
          {
            platform: target.platform,
            phone: target.phone,
            partition: resolvedPartition,
            publishAt: target.publishAt || null,
            publishAtMs: explicitPublishAtMs,
            noThrottle: Boolean(target.noThrottle),
          },
        ],
        now: nowMs,
        records,
        settings: throttleSettings,
      }).items[0];

      if (planItem && planItem.scheduled) {
        target.publishAt = planItem.publishAt;
        target.scheduledPublishAtMs = planItem.plannedAtMs;
        target.throttled = planItem.throttled;
        target.throttleReason = planItem.reason;
      } else {
        target.publishAt = null;
        target.scheduledPublishAtMs = null;
        target.throttled = false;
        target.throttleReason = "";
        registerPublishDedupeBypass({
          pt: target.platform,
          phone: target.phone,
          partition: resolvedPartition,
          title: candTitle,
        });
      }
      result = await publishService.runSingleFilePublish(target);
      if (result && result.creativeStatement == null) {
        result.creativeStatement = target.creativeStatement || "none";
      }
    } else {
      // platforms 数组（1 个或多个平台）：先逐平台查重，仅拦截重复的那几个平台；
      // 未被拦截的平台再进入节流排期并执行
      const targets = parsed.value;
      const allowedTargets = [];
      const allowedMeta = [];
      const allowedIndices = [];
      const blockedByIndex = new Map();

      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const resolvedPartition = resolveTaskPartition({
          partition: t.partition,
          phone: t.phone,
          pt: t.platform,
        });
        const candTitle = t.title || fileStemForDedupe(t.file);
        const allowDup = Boolean(t.allowDuplicate);
        if (allowDup) {
          t.allowDuplicate = true;
          t.publishOptions = { ...(t.publishOptions || {}), allowDuplicate: true };
        }
        if (!allowDup) {
          const hit = findRecentDuplicatePublish(records, {
            pt: t.platform,
            phone: t.phone,
            partition: resolvedPartition,
            title: candTitle,
          });
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
        let explicitPublishAtMs = null;
        if (t.publishAt) {
          const parsedAt = parseLocalPublishAt(t.publishAt, nowMs);
          if (!parsedAt.ok) {
            return res.status(400).json({
              success: false,
              status: "failed",
              message: parsedAt.error,
            });
          }
          explicitPublishAtMs = parsedAt.value;
        }
        allowedTargets.push(t);
        allowedMeta.push({ resolvedPartition, candTitle, explicitPublishAtMs });
        allowedIndices.push(i);
      }

      if (allowedTargets.length === 0) {
        const blockedList = targets.map((_, idx) => blockedByIndex.get(idx)).filter(Boolean);
        result = {
          success: false,
          status: "duplicate",
          exitCode: DUPLICATE_EXIT_CODE,
          duplicate: true,
          total: blockedList.length,
          succeeded: 0,
          failed: blockedList.length,
          message: blockedList.map((r) => r.message).join("；"),
          results: blockedList,
        };
      } else {
        // 仅对未命中重复拦截的平台进行节流排期
        const plan = planPublishTimes({
          targets: allowedTargets.map((t, k) => ({
            platform: t.platform,
            phone: t.phone,
            partition: allowedMeta[k].resolvedPartition,
            publishAt: t.publishAt || null,
            publishAtMs: allowedMeta[k].explicitPublishAtMs,
            noThrottle: Boolean(t.noThrottle),
          })),
          now: nowMs,
          records,
          settings: throttleSettings,
        });

        for (let k = 0; k < allowedTargets.length; k++) {
          const t = allowedTargets[k];
          const meta = allowedMeta[k];
          const planItem = plan.items[k];
          if (planItem && planItem.scheduled) {
            t.publishAt = planItem.publishAt;
            t.scheduledPublishAtMs = planItem.plannedAtMs;
            t.throttled = planItem.throttled;
            t.throttleReason = planItem.reason;
          } else {
            t.publishAt = null;
            t.scheduledPublishAtMs = null;
            t.throttled = false;
            t.throttleReason = "";
            registerPublishDedupeBypass({
              pt: t.platform,
              phone: t.phone,
              partition: meta.resolvedPartition,
              title: meta.candTitle,
            });
          }
        }

        if (blockedByIndex.size === 0) {
          result = parsed.multi
            ? await publishService.runMultiPlatformPublish(allowedTargets)
            : await publishService.runSingleFilePublish(allowedTargets[0]);
          if (!parsed.multi && result && result.creativeStatement == null) {
            result.creativeStatement = allowedTargets[0].creativeStatement || "none";
          }
        } else {
          const runRes = await publishService.runMultiPlatformPublish(allowedTargets);
          const runResults = Array.isArray(runRes && runRes.results) ? runRes.results : [];
          const mergedResults = new Array(targets.length);
          for (const [idx, blocked] of blockedByIndex.entries()) {
            mergedResults[idx] = blocked;
          }
          for (let k = 0; k < allowedIndices.length; k++) {
            const rr = runResults[k];
            mergedResults[allowedIndices[k]] = rr
              ? {
                  ...rr,
                  creativeStatement:
                    rr.creativeStatement ||
                    allowedTargets[k].creativeStatement ||
                    "none",
                }
              : {
                  platform: allowedTargets[k].platform,
                  phone: allowedTargets[k].phone || "",
                  creativeStatement: allowedTargets[k].creativeStatement || "none",
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
          result = {
            ...(runRes || {}),
            success: failed === 0,
            status: succeeded > 0 ? "partial_duplicate" : "duplicate",
            exitCode: failed === 0 ? 0 : DUPLICATE_EXIT_CODE,
            total,
            succeeded,
            scheduledCount,
            failed,
            results: mergedResults,
            message: `共 ${total} 个平台：成功 ${succeeded} 个${
              scheduledCount > 0 ? `（含节流排期 ${scheduledCount} 个）` : ""
            }，拦截重复 ${blockedByIndex.size} 个${
              failed - blockedByIndex.size > 0
                ? `，失败 ${failed - blockedByIndex.size} 个`
                : ""
            }`,
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
