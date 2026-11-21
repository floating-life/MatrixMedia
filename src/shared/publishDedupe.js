"use strict";

/**
 * 同平台重复发布拦截（7 天窗口）公共判定模块。
 *
 * 判定条件：
 * 1. 同平台（别名归一到 canonical 中文名）
 * 2. 同账号（partition 归一匹配，缺省按 accountKey / phone "-" 前缀匹配）
 * 3. 清洗归一后的标题完全相同（复用 textSanitize.sanitizeTitle + 多空白合并 + 小写）
 * 4. 7 天内已有成功/进行中记录（success / publishing / drafting / draft / draft_saved / scheduled；
 *    failed / skipped / login_required / abnormal / expired / cancelled / duplicate 不拦截）
 */

const { sanitizeTitle } = require("./textSanitize");

const DUPLICATE_WINDOW_DAYS = 7;
const DUPLICATE_WINDOW_MS = DUPLICATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DUPLICATE_EXIT_CODE = 6;
const UTC8_MS = 8 * 3600 * 1000;

const BLOCKING_PUBLISH_STATUSES = new Set([
  "success",
  "publishing",
  "drafting",
  "draft",
  "draft_saved",
  "scheduled",
]);

const NON_BLOCKING_PUBLISH_STATUSES = new Set([
  "failed",
  "skipped",
  "login_required",
  "abnormal",
  "expired",
  "cancelled",
  "canceled",
  "duplicate",
]);

const PLATFORM_ALIAS_MAP = {
  dy: "抖音",
  douyin: "抖音",
  抖音: "抖音",
  sph: "视频号",
  视频号: "视频号",
  blbl: "哔哩哔哩",
  bilibili: "哔哩哔哩",
  哔哩哔哩: "哔哩哔哩",
  bjh: "百家号",
  百家号: "百家号",
  tt: "头条",
  toutiao: "头条",
  头条: "头条",
  ks: "快手",
  kuaishou: "快手",
  快手: "快手",
  xhs: "小红书",
  xiaohongshu: "小红书",
  小红书: "小红书",
  fqsp: "番茄视频",
  fanqie: "番茄视频",
  fq: "番茄视频",
  番茄视频: "番茄视频",
  juejin: "掘金",
  jj: "掘金",
  掘金: "掘金",
};

function resolveCanonicalPlatform(raw) {
  const s = String(raw || "")
    .replace(/状态$/, "")
    .trim();
  if (!s) return "";
  return PLATFORM_ALIAS_MAP[s] || PLATFORM_ALIAS_MAP[s.toLowerCase()] || s;
}

/** 与 src/shared/accountPartition.js canonicalAccountPartition 同口径 */
function canonicalizePartition(partition, pt) {
  const raw = String(partition || "").trim();
  if (!raw) return "";
  const suffix = resolveCanonicalPlatform(pt);
  let head = raw;
  if (suffix && raw.endsWith(suffix)) {
    head = raw.slice(0, raw.length - suffix.length);
  }
  let account = head.split("-")[0];
  if (!account.startsWith("persist:")) {
    account = "persist:" + account.replace(/^persist:?/, "");
  }
  return account + suffix;
}

function deriveCanonicalPartition(item, canonicalPt) {
  if (!item || typeof item !== "object") return "";
  if (item.partition) {
    return canonicalizePartition(item.partition, canonicalPt);
  }
  const key = String(item.accountKey || "").trim();
  if (key && canonicalPt) {
    return `persist:${key}${canonicalPt}`;
  }
  const phone = String(item.phone || "").trim();
  if (phone && canonicalPt) {
    return `persist:${phone.split("-")[0]}${canonicalPt}`;
  }
  return "";
}

function normalizeTitleForDedupe(raw) {
  const cleaned = sanitizeTitle(raw);
  if (!cleaned) return "";
  return cleaned.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractCandidateTitle(item) {
  if (!item || typeof item !== "object") return "";
  const data = item.data && typeof item.data === "object" ? item.data : {};
  const candidates = [
    item.title,
    data.title,
    item.bt1,
    data.bt1,
    item.bt,
    item.bookName,
  ];
  for (const c of candidates) {
    const cleaned = sanitizeTitle(c);
    if (cleaned) return cleaned;
  }
  return "";
}

function parseRecordTimeMs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (raw instanceof Date) {
    const ms = raw.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      // 仅有日期时按 UTC+8 当天 12:00 估算，确保 7 天窗口稳定
      const ms = Date.parse(`${s}T12:00:00+08:00`);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
      const iso = s.replace(" ", "T");
      const withSec = iso.length === 16 ? `${iso}:00` : iso;
      const ms = Date.parse(`${withSec}+08:00`);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

function extractRecordPublishTimeMs(record) {
  if (!record || typeof record !== "object") return null;
  const fromLast = parseRecordTimeMs(record.lastPublishAt);
  if (fromLast !== null) return fromLast;
  const fromCreate = parseRecordTimeMs(record.createTime);
  if (fromCreate !== null) return fromCreate;
  const fromDate = parseRecordTimeMs(record.date);
  if (fromDate !== null) return fromDate;
  if (String(record.publishStatus || "").trim().toLowerCase() === "scheduled") {
    return parseRecordTimeMs(record.scheduledPublishAt);
  }
  return null;
}

function formatUtc8DateTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + UTC8_MS).toISOString().slice(0, 19).replace("T", " ");
}

function isBlockingPublishRecord(record) {
  if (!record || typeof record !== "object") return false;
  const rawStatus = String(record.publishStatus || "").trim().toLowerCase();
  if (rawStatus) {
    if (BLOCKING_PUBLISH_STATUSES.has(rawStatus)) return true;
    if (NON_BLOCKING_PUBLISH_STATUSES.has(rawStatus)) return false;
    return false;
  }
  // 兼容旧数据（无 publishStatus 字段）
  return Number(record.publishSuccessCount) > 0 || Boolean(record.videoLink);
}

function isSameAccount(record, candidate, canonicalPt) {
  const recPart = deriveCanonicalPartition(record, canonicalPt);
  const candPart = deriveCanonicalPartition(candidate, canonicalPt);
  if (recPart && candPart) {
    return recPart === candPart;
  }
  const recKey = String(record.accountKey || "").trim();
  const candKey = String(candidate.accountKey || "").trim();
  if (recKey && candKey) {
    return recKey === candKey;
  }
  const recPhone = String(record.phone || "").split("-")[0].trim();
  const candPhone = String(candidate.phone || "").split("-")[0].trim();
  if (recPhone && candPhone) {
    return recPhone === candPhone;
  }
  return false;
}

function formatAccountLabel(candidate, record) {
  const phone = String(
    (candidate && candidate.phone) || (record && record.phone) || ""
  ).trim();
  if (phone) return phone;
  const part = String(
    (candidate && candidate.partition) || (record && record.partition) || ""
  )
    .replace(/^persist:/, "")
    .trim();
  return part || "当前账号";
}

function statusDisplayName(status) {
  const s = String(status || "").trim().toLowerCase();
  if (s === "publishing") return "发布中";
  if (s === "drafting") return "保存草稿中";
  if (s === "draft" || s === "draft_saved") return "已存草稿";
  if (s === "scheduled") return "定时待发";
  return "发布成功";
}

/**
 * 兼容 pushData 返回的两种结构，统一平铺为发布记录数组：
 * 1) 真实 changeData({ fileName: "pushData", type: "get" }) 返回的按日期分组对象 { "YYYY-MM-DD": [...] }
 * 2) 完整响应体 { success: true, data: ... } 或平铺数组 [...]
 *
 * @param {unknown} raw
 * @returns {Array<object>}
 */
function flattenPushDataRecords(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((item) => item && typeof item === "object");
  }
  if (typeof raw !== "object") return [];
  if (
    Object.prototype.hasOwnProperty.call(raw, "success") &&
    Object.prototype.hasOwnProperty.call(raw, "data")
  ) {
    if (raw.success === false) return [];
    return flattenPushDataRecords(raw.data);
  }
  const rows = [];
  for (const dateKey of Object.keys(raw)) {
    const list = raw[dateKey];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it || typeof it !== "object") continue;
      rows.push(it.date ? it : { ...it, date: dateKey });
    }
  }
  return rows;
}

/**
 * GUI / CLI / HTTP / puppeteerFile 查重共用的 pushData 读取函数。
 * 统一通过 changeData({ fileName: "pushData", type: "get" }) 读取并兼容按日期分组对象与数组。
 *
 * @param {Function} changeDataFn
 * @param {object} [options]
 * @returns {Array<object>}
 */
function readPushDataRecords(changeDataFn, options = {}) {
  if (typeof changeDataFn !== "function") return [];
  try {
    const pageSize =
      typeof options.pageSize === "number" && options.pageSize > 0
        ? options.pageSize
        : 10000;
    const res = changeDataFn({
      fileName: "pushData",
      type: "get",
      item: { page: 1, pageSize },
    });
    if (!res || res.success === false) return [];
    return flattenPushDataRecords(res.data);
  } catch (_) {
    return [];
  }
}

/**
 * 在 pushData 发布记录中查找同平台 + 同账号 + 清洗归一后标题相同、且 7 天内有成功/进行中记录的最近一条。
 *
 * 定时待发（scheduled）记录的先后规则（S11-fix #5）：
 * - 待发记录只拦截「计划时刻更早或相同」（recPlannedMs <= refMs）的同标题请求；
 * - 执行时查重（isExecutionCheck: true）排除计划时刻晚于本任务的待发记录（recPlannedMs > taskTimeMs）；
 * - allowDuplicate 只影响带它的那条任务，不放行其它未带 allowDuplicate 的任务。
 *
 * @param {Array<object>|Record<string, Array<object>>} records pushData 记录数组或按日期分组对象
 * @param {object} candidate { pt|platform, phone?, partition?, accountKey?, title?, bt1?, bookName?, data?, scheduledPublishAt?, publishAt? }
 * @param {object} [options] { now?: number, windowMs?: number, excludeRecordId?: string|number, candidateScheduledAt?: number|null, isExecutionCheck?: boolean }
 * @returns {object|null}
 */
function findRecentDuplicatePublish(records, candidate, options = {}) {
  const list = Array.isArray(records) ? records : flattenPushDataRecords(records);
  if (list.length === 0 || !candidate) return null;
  const now =
    typeof options.now === "number" && Number.isFinite(options.now)
      ? options.now
      : Date.now();
  const windowMs =
    typeof options.windowMs === "number" && Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : DUPLICATE_WINDOW_MS;
  const excludeRecordId =
    options.excludeRecordId != null ? String(options.excludeRecordId) : "";
  const isExecutionCheck = options.isExecutionCheck === true;
  const candidateScheduledAt = (() => {
    const fromOpt = parseRecordTimeMs(options.candidateScheduledAt);
    if (fromOpt !== null) return fromOpt;
    const fromCandSched = parseRecordTimeMs(candidate.scheduledPublishAt);
    if (fromCandSched !== null) return fromCandSched;
    const fromCandPublishAt = parseRecordTimeMs(candidate.publishAt);
    if (fromCandPublishAt !== null) return fromCandPublishAt;
    return null;
  })();

  const candPlatform = resolveCanonicalPlatform(
    candidate.pt || candidate.platform
  );
  if (!candPlatform) return null;

  const cleanedTitle = extractCandidateTitle(candidate);
  const normTitle = normalizeTitleForDedupe(cleanedTitle);
  if (!normTitle) return null;

  const candType = String(candidate.textType || "").trim().toLowerCase();

  let bestRecord = null;
  let bestTimeMs = -1;

  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    if (!rec || typeof rec !== "object") continue;
    let rec2 = rec;
    if (excludeRecordId && rec.id != null && String(rec.id) === excludeRecordId) {
      // 本次登记的记录本身不算重复；但若它是复用的旧记录且之前成功过，按上次成功时间参与查重
      const prior = Number(rec.priorSuccessAt);
      if (!(prior > 0)) continue;
      rec2 = { ...rec, publishStatus: "success", lastPublishAt: prior };
    }
    if (!isBlockingPublishRecord(rec2)) continue;

    // 区分文章与视频记录
    const recType = String(rec.textType || "").trim().toLowerCase();
    if (
      (candType === "article" && recType && recType !== "article") ||
      (recType === "article" && candType && candType !== "article")
    ) {
      continue;
    }

    const recPlatform = resolveCanonicalPlatform(rec.pt || rec.platform);
    if (recPlatform !== candPlatform) continue;
    if (!isSameAccount(rec, candidate, candPlatform)) continue;

    const recTitle = normalizeTitleForDedupe(extractCandidateTitle(rec));
    if (!recTitle || recTitle !== normTitle) continue;

    const recStatus = String(rec2.publishStatus || "").trim().toLowerCase();
    const recTimeMs = extractRecordPublishTimeMs(rec2);
    if (recTimeMs === null) continue;

    if (recStatus === "scheduled") {
      const recPlannedMs =
        parseRecordTimeMs(rec2.scheduledPublishAt) ||
        parseRecordTimeMs(rec2.scheduledPublishAtText) ||
        recTimeMs;
      if (isExecutionCheck) {
        // 执行时查重：排除计划时刻晚于本任务的待发记录（后排任务不得拦掉先排任务）
        const taskRefMs = candidateScheduledAt !== null ? candidateScheduledAt : now;
        if (recPlannedMs > taskRefMs) continue;
      } else if (candidateScheduledAt !== null) {
        // 提交时带计划时刻：待发记录只拦截计划时刻更早或相同的同标题请求
        if (recPlannedMs > candidateScheduledAt) continue;
      }
    }

    const ageMs = now - recTimeMs;
    // 允许定时待发记录（创建在 7 天内或定时时间在未来），普通记录须在 7 天窗口内
    const inWindow =
      recStatus === "scheduled"
        ? ageMs <= windowMs
        : ageMs >= -5 * 60 * 1000 && ageMs <= windowMs;
    if (!inWindow) continue;

    if (recTimeMs > bestTimeMs) {
      bestTimeMs = recTimeMs;
      bestRecord = rec2;
    }
  }

  if (!bestRecord) return null;

  const lastPublishAtText = formatUtc8DateTime(bestTimeMs);
  const lastStatus = String(bestRecord.publishStatus || "success").trim().toLowerCase();
  const accountLabel = formatAccountLabel(candidate, bestRecord);
  const candPartition = deriveCanonicalPartition(candidate, candPlatform);

  return {
    duplicate: true,
    status: "duplicate",
    exitCode: DUPLICATE_EXIT_CODE,
    platform: candPlatform,
    phone: String(candidate.phone || bestRecord.phone || "").trim(),
    partition: candPartition,
    title: cleanedTitle,
    lastPublishAt: bestTimeMs,
    lastPublishAtText,
    lastPublishStatus: lastStatus,
    matchedRecordId: bestRecord.id != null ? bestRecord.id : null,
    message: `${candPlatform}（${accountLabel}）近 ${DUPLICATE_WINDOW_DAYS} 天内已有相同标题「${cleanedTitle}」的${statusDisplayName(
      lastStatus
    )}记录（上次发布时间：${lastPublishAtText}），已拦截重复发布`,
  };
}

/**
 * 批量检查多个目标平台，返回命中重复的列表。
 * @param {Array<object>} records
 * @param {Array<object>} targets
 * @param {object} [options]
 * @returns {Array<{index: number, target: object, hit: object}>}
 */
function findDuplicatePublishesForTargets(records, targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return [];
  const list = Array.isArray(records) ? records : flattenPushDataRecords(records);
  if (list.length === 0) return [];
  const hits = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t || t.allowDuplicate === true) continue;
    const hit = findRecentDuplicatePublish(list, t, options);
    if (hit) {
      hits.push({ index: i, target: t, hit });
    }
  }
  return hits;
}

module.exports = {
  DUPLICATE_WINDOW_DAYS,
  DUPLICATE_WINDOW_MS,
  DUPLICATE_EXIT_CODE,
  BLOCKING_PUBLISH_STATUSES,
  NON_BLOCKING_PUBLISH_STATUSES,
  resolveCanonicalPlatform,
  canonicalizePartition,
  deriveCanonicalPartition,
  normalizeTitleForDedupe,
  extractCandidateTitle,
  extractRecordPublishTimeMs,
  formatUtc8DateTime,
  isBlockingPublishRecord,
  flattenPushDataRecords,
  readPushDataRecords,
  findRecentDuplicatePublish,
  findDuplicatePublishesForTargets,
};
