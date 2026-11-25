"use strict";

/**
 * 发布节流 / 平台错峰 / 默认创作声明 纯逻辑模块（零 Electron / fs 依赖，主进程 / 渲染进程 / 单测共用）。
 *
 * 时间口径：
 * - 允许发布时段（默认 06:00–23:30）与当日上限（默认 3 条/天）均按 UTC+8（东八区）计算，
 *   不受运行主机系统时区影响。
 * - 输出的 plannedAtMs 为精确 epoch 毫秒，publishAt 为 UTC+8 的 "YYYY-MM-DD HH:mm:ss"。
 */

const {
  resolveCanonicalPlatform,
  deriveCanonicalPartition,
  flattenPushDataRecords,
} = require("./publishDedupe.js");
const {
  normalizeCollectionName,
  collapseCollectionText,
} = require("./collectionShared.js");

const UTC8_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const IMMEDIATE_THRESHOLD_MS = 60 * 1000;
const MAX_PLAN_LOOKAHEAD_DAYS = 60;
const SCHEDULED_EXPIRE_GRACE_MS = 10 * 60 * 1000;
const PREVIEW_BASE_MAX_AGE_MS = 10 * 60 * 1000;
const GUI_DRIFT_TIME_TOLERANCE_MS = 60 * 1000;

const DEFAULT_CREATIVE_STATEMENT_VALUE = "ai_generated";
const DEFAULT_AI_CHAPTERS = true;
const DEFAULT_ORIGINAL_STATEMENT = true;

const VALID_CREATIVE_STATEMENT_VALUES = new Set([
  "none",
  "ai_generated",
  "fiction",
  "marketing",
  "personal_opinion",
  "repost",
  "self_shot",
  "self_made_no_repost",
]);

const CREATIVE_STATEMENT_LABEL_MAP = new Map([
  ["无标注", "none"],
  ["无需标注", "none"],
  ["无需声明", "none"],
  ["内容无需标注", "none"],
  ["无需添加自主声明", "none"],
  ["ai生成", "ai_generated"],
  ["AI生成", "ai_generated"],
  ["含AI生成内容", "ai_generated"],
  ["内容由AI生成", "ai_generated"],
  ["内容为AI生成", "ai_generated"],
  ["笔记含AI合成内容", "ai_generated"],
  ["虚构演绎", "fiction"],
  ["含虚构演绎内容", "fiction"],
  ["虚构演绎，仅供娱乐", "fiction"],
  ["演绎情节，仅供娱乐", "fiction"],
  ["虚构演绎，故事经历", "fiction"],
  ["内容为虚构剧情，仅供娱乐", "fiction"],
  ["营销推广", "marketing"],
  ["内容含营销信息", "marketing"],
  ["内容含营销推广信息", "marketing"],
  ["内容包含营销广告", "marketing"],
  ["个人观点", "personal_opinion"],
  ["个人观点，仅供参考", "personal_opinion"],
  ["内容为个人观点或见解", "personal_opinion"],
  ["转载", "repost"],
  ["内容为转载", "repost"],
  ["内容为转载信息", "repost"],
  ["取自站外", "repost"],
  ["素材来源于网络", "repost"],
  ["自行拍摄", "self_shot"],
  ["内容为自行拍摄", "self_shot"],
  ["自制禁转载", "self_made_no_repost"],
  ["内容为自制：未经作者允许，禁止转载", "self_made_no_repost"],
]);

/** 全部支持节流配置的视频平台（canonical 中文名） */
const THROTTLE_PLATFORMS = [
  "抖音",
  "视频号",
  "哔哩哔哩",
  "百家号",
  "头条",
  "快手",
  "小红书",
  "番茄视频",
];

const DEFAULT_ALLOWED_WINDOW = Object.freeze({
  start: "06:00",
  end: "23:30",
});

function createDefaultPlatformRules() {
  const map = {};
  for (const pt of THROTTLE_PLATFORMS) {
    map[pt] = {
      minIntervalHours: pt === "抖音" ? 6 : 4,
      dailyLimit: 3,
      delayFromFirstHours: 0,
    };
  }
  return map;
}

function createDefaultPublishThrottleSettings() {
  return {
    version: 1,
    enabled: true,
    allowedWindow: {
      start: DEFAULT_ALLOWED_WINDOW.start,
      end: DEFAULT_ALLOWED_WINDOW.end,
    },
    defaultCreativeStatement: DEFAULT_CREATIVE_STATEMENT_VALUE,
    defaultAiChapters: DEFAULT_AI_CHAPTERS,
    defaultOriginalStatement: DEFAULT_ORIGINAL_STATEMENT,
    platforms: createDefaultPlatformRules(),
  };
}

const DEFAULT_THROTTLE_SETTINGS = createDefaultPublishThrottleSettings();

/** 计入节流间隔与日上限的发布状态（已预留 / 已成功 / 进行中 / 待执行定时任务） */
const COUNTING_PUBLISH_STATUSES = new Set([
  "reserved",
  "success",
  "published",
  "publishing",
  "scheduled",
]);

/** 不计入节流的历史状态（失败 / 跳过 / 登录失效 / 过期 / 取消 / 重复拦截 / 纯草稿） */
const NON_COUNTING_PUBLISH_STATUSES = new Set([
  "failed",
  "fail",
  "skipped",
  "login_required",
  "abnormal",
  "expired",
  "cancelled",
  "canceled",
  "duplicate",
  "draft",
  "drafting",
  "draft_saved",
]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * 解析 "HH:mm" 为当日分钟数（0..1440，支持 "24:00"）。
 * 无效返回 null。
 */
function parseTimeOfDayMinutes(raw) {
  const text = String(raw || "").trim();
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h === 24 && min === 0) return 24 * 60;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function formatMinutesToHHmm(totalMinutes) {
  if (totalMinutes === 24 * 60) return "24:00";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

/** 格式化 epoch 毫秒为 UTC+8 "YYYY-MM-DD HH:mm:ss" */
function formatUtc8DateTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Date(ms + UTC8_OFFSET_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/** 取 epoch 毫秒对应的 UTC+8 日历日 "YYYY-MM-DD" */
function formatUtc8Ymd(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Date(ms + UTC8_OFFSET_MS).toISOString().slice(0, 10);
}

/** 取 epoch 毫秒所在 UTC+8 当日 00:00:00.000 对应的 epoch 毫秒 */
function utc8DayStartMs(ms) {
  const shifted = ms + UTC8_OFFSET_MS;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStartShifted - UTC8_OFFSET_MS;
}

/** 取 epoch 毫秒在 UTC+8 当日内经过的毫秒数 [0, DAY_MS) */
function utc8TimeOfDayMs(ms) {
  const shifted = ms + UTC8_OFFSET_MS;
  return ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
}

/**
 * 解析时间入参为 epoch 毫秒：
 * - finite number: 原样返回
 * - Date: getTime()
 * - 带显式时区的 ISO 字符串: Date.parse()
 * - 无时区的 "YYYY-MM-DD HH:mm:ss" / "YYYY-MM-DD HH:mm": 按 UTC+8 解析
 * - 纯日期 "YYYY-MM-DD": 按 UTC+8 当日 12:00:00 解析
 */
function parseUtc8DateTimeMs(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    const bareMatch = s.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
    );
    if (bareMatch) {
      const year = Number(bareMatch[1]);
      const month = Number(bareMatch[2]);
      const day = Number(bareMatch[3]);
      const hour = Number(bareMatch[4]);
      const minute = Number(bareMatch[5]);
      const second = bareMatch[6] != null ? Number(bareMatch[6]) : 0;
      const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
      const check = new Date(utcMs);
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
      ) {
        return null;
      }
      return utcMs - UTC8_OFFSET_MS;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const ms = Date.parse(`${s}T12:00:00+08:00`);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    const ms = Date.parse(s);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  return null;
}

function normalizeDefaultCreativeStatement(raw, fallback = DEFAULT_CREATIVE_STATEMENT_VALUE) {
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim();
  if (!s) return fallback;
  if (VALID_CREATIVE_STATEMENT_VALUES.has(s)) return s;
  if (CREATIVE_STATEMENT_LABEL_MAP.has(s)) return CREATIVE_STATEMENT_LABEL_MAP.get(s);
  const lower = s.toLowerCase();
  if (VALID_CREATIVE_STATEMENT_VALUES.has(lower)) return lower;
  if (CREATIVE_STATEMENT_LABEL_MAP.has(lower)) return CREATIVE_STATEMENT_LABEL_MAP.get(lower);
  return fallback;
}

function normalizeNumber(raw, fallback, { min = 0, max = 168, integer = false } = {}) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.min(max, Math.max(min, n));
  return integer ? Math.floor(clamped) : Math.round(clamped * 100) / 100;
}

function defaultRuleForPlatform(canonicalPt) {
  return {
    minIntervalHours: canonicalPt === "抖音" ? 6 : 4,
    dailyLimit: 3,
    delayFromFirstHours: 0,
  };
}

/**
 * 归一化节流与默认声明设置（兼容缺省字段、短码平台 key 如 dy/bjh、旧结构）。
 */
function normalizePublishThrottleSettings(raw) {
  const defaults = createDefaultPublishThrottleSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaults;
  }

  const enabled =
    typeof raw.enabled === "boolean" ? raw.enabled : defaults.enabled;

  const rawWin =
    raw.allowedWindow && typeof raw.allowedWindow === "object"
      ? raw.allowedWindow
      : {};
  const startMin = parseTimeOfDayMinutes(
    rawWin.start !== undefined ? rawWin.start : raw.allowedStart
  );
  const endMin = parseTimeOfDayMinutes(
    rawWin.end !== undefined ? rawWin.end : raw.allowedEnd
  );
  let allowedWindow;
  if (startMin !== null && endMin !== null && startMin !== endMin) {
    allowedWindow = {
      start: formatMinutesToHHmm(startMin),
      end: formatMinutesToHHmm(endMin),
    };
  } else {
    allowedWindow = { ...defaults.allowedWindow };
  }

  const defaultCreativeStatement = normalizeDefaultCreativeStatement(
    raw.defaultCreativeStatement,
    defaults.defaultCreativeStatement
  );
  const defaultAiChapters =
    typeof raw.defaultAiChapters === "boolean"
      ? raw.defaultAiChapters
      : defaults.defaultAiChapters;
  const defaultOriginalStatement =
    typeof raw.defaultOriginalStatement === "boolean"
      ? raw.defaultOriginalStatement
      : defaults.defaultOriginalStatement;

  const platforms = createDefaultPlatformRules();
  const rawPlatforms =
    raw.platforms && typeof raw.platforms === "object" && !Array.isArray(raw.platforms)
      ? raw.platforms
      : {};

  for (const [key, val] of Object.entries(rawPlatforms)) {
    if (!val || typeof val !== "object") continue;
    const canonical = resolveCanonicalPlatform(key);
    if (!canonical) continue;
    const base = platforms[canonical] || defaultRuleForPlatform(canonical);
    platforms[canonical] = {
      minIntervalHours: normalizeNumber(
        val.minIntervalHours,
        base.minIntervalHours,
        { min: 0, max: 168, integer: false }
      ),
      dailyLimit: normalizeNumber(val.dailyLimit, base.dailyLimit, {
        min: 0,
        max: 100,
        integer: true,
      }),
      delayFromFirstHours: normalizeNumber(
        val.delayFromFirstHours,
        base.delayFromFirstHours,
        { min: 0, max: 168, integer: false }
      ),
    };
  }

  return {
    version: 1,
    enabled,
    allowedWindow,
    defaultCreativeStatement,
    defaultAiChapters,
    defaultOriginalStatement,
    platforms,
  };
}

/**
 * 校验用户提交的设置对象（用于 GUI 保存前提示明确错误）。
 */
function validatePublishThrottleSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "设置格式无效" };
  }
  const rawWin =
    raw.allowedWindow && typeof raw.allowedWindow === "object"
      ? raw.allowedWindow
      : {};
  const startRaw = rawWin.start !== undefined ? rawWin.start : raw.allowedStart;
  const endRaw = rawWin.end !== undefined ? rawWin.end : raw.allowedEnd;
  if (startRaw !== undefined || endRaw !== undefined) {
    const s = parseTimeOfDayMinutes(startRaw);
    const e = parseTimeOfDayMinutes(endRaw);
    if (s === null || e === null) {
      return { ok: false, error: "允许发布时段格式应为 HH:mm（如 06:00 和 23:30）" };
    }
    if (s === e) {
      return { ok: false, error: "允许发布时段的开始时间与结束时间不能相同" };
    }
  }
  if (raw.defaultCreativeStatement !== undefined) {
    const s = String(raw.defaultCreativeStatement || "").trim();
    if (
      s &&
      !VALID_CREATIVE_STATEMENT_VALUES.has(s) &&
      !CREATIVE_STATEMENT_LABEL_MAP.has(s)
    ) {
      return { ok: false, error: `不支持的默认创作声明：${s}` };
    }
  }
  if (
    raw.defaultAiChapters !== undefined &&
    typeof raw.defaultAiChapters !== "boolean"
  ) {
    return { ok: false, error: "默认 AI 自动章节开关必须为布尔值" };
  }
  if (
    raw.defaultOriginalStatement !== undefined &&
    typeof raw.defaultOriginalStatement !== "boolean"
  ) {
    return { ok: false, error: "默认原创声明开关必须为布尔值" };
  }
  if (raw.platforms && typeof raw.platforms === "object") {
    for (const [k, v] of Object.entries(raw.platforms)) {
      if (!v || typeof v !== "object") continue;
      if (v.minIntervalHours !== undefined) {
        const n = Number(v.minIntervalHours);
        if (!Number.isFinite(n) || n < 0 || n > 168) {
          return { ok: false, error: `${k} 的最小间隔小时数须在 0～168 之间` };
        }
      }
      if (v.dailyLimit !== undefined) {
        const n = Number(v.dailyLimit);
        if (!Number.isFinite(n) || n < 0 || n > 100 || !Number.isInteger(n)) {
          return { ok: false, error: `${k} 的每日上限须为 0～100 的整数（0 表示不限制）` };
        }
      }
      if (v.delayFromFirstHours !== undefined) {
        const n = Number(v.delayFromFirstHours);
        if (!Number.isFinite(n) || n < 0 || n > 168) {
          return { ok: false, error: `${k} 的相对首发延迟小时数须在 0～168 之间` };
        }
      }
    }
  }
  return { ok: true, value: normalizePublishThrottleSettings(raw) };
}

function getPlatformThrottleRule(settings, platform) {
  const norm = normalizePublishThrottleSettings(settings);
  const canonical = resolveCanonicalPlatform(platform);
  if (canonical && norm.platforms[canonical]) {
    return { ...norm.platforms[canonical] };
  }
  return defaultRuleForPlatform(canonical);
}

function isDraftPublishItem(record) {
  if (!record || typeof record !== "object") return false;
  if (record.isDraft === true || record.draft === true || record.publishToDraft === true) {
    return true;
  }
  const mode = String(record.publishMode || "").trim().toLowerCase();
  return mode === "draft";
}

function isCountingRecordForThrottle(record) {
  if (!record || typeof record !== "object") return false;
  // 草稿（含定时草稿、账号默认草稿）一律不计入节流与日上限
  if (isDraftPublishItem(record)) return false;
  const rawStatus = String(record.publishStatus || record.status || "")
    .trim()
    .toLowerCase();
  if (rawStatus) {
    if (COUNTING_PUBLISH_STATUSES.has(rawStatus)) return true;
    if (NON_COUNTING_PUBLISH_STATUSES.has(rawStatus)) return false;
    return false;
  }
  return Number(record.publishSuccessCount) > 0 || Boolean(record.videoLink);
}

function extractThrottleRecordEvent(record, nowMs, options = {}) {
  if (!isCountingRecordForThrottle(record)) return null;
  const status = String(record.publishStatus || record.status || "")
    .trim()
    .toLowerCase();
  const graceMs =
    typeof options.scheduledExpireGraceMs === "number" &&
    Number.isFinite(options.scheduledExpireGraceMs) &&
    options.scheduledExpireGraceMs >= 0
      ? options.scheduledExpireGraceMs
      : 0;
  const isSched =
    record.isScheduled === true ||
    status === "scheduled" ||
    (record.scheduledTask === true && !status);
  if (isSched) {
    const ts =
      (typeof record.ts === "number" && Number.isFinite(record.ts) && record.ts > 0
        ? record.ts
        : null) ||
      parseUtc8DateTimeMs(record.scheduledPublishAt) ||
      parseUtc8DateTimeMs(record.scheduledPublishAtText);
    if (ts === null) return null;
    // 已过期的待发任务不会执行，不计入排期占位
    if (ts < nowMs - graceMs) return null;
    return { ts, isScheduled: true };
  }
  const ts =
    (typeof record.ts === "number" && Number.isFinite(record.ts) && record.ts > 0
      ? record.ts
      : null) ||
    parseUtc8DateTimeMs(record.lastPublishAt) ||
    parseUtc8DateTimeMs(record.createTime) ||
    parseUtc8DateTimeMs(record.date);
  if (ts === null) return null;
  return { ts, isScheduled: false };
}

function buildAccountBucketKey(item, canonicalPt) {
  const part = deriveCanonicalPartition(item, canonicalPt);
  if (part) return `${canonicalPt}|${part}`;
  const key = String((item && item.accountKey) || "").trim();
  if (key) return `${canonicalPt}|key:${key}`;
  const phone = String((item && item.phone) || "").split("-")[0].trim();
  if (phone) return `${canonicalPt}|phone:${phone}`;
  return `${canonicalPt}|__default__`;
}

function formatHoursLabel(hours) {
  return Number.isInteger(hours) ? String(hours) : String(hours);
}

/**
 * 将 candidateMs 对齐到 UTC+8 允许发布时段 [startMin, endMin] 内。
 * - 若已在时段内，原样返回 { ms, shifted: false }
 * - 若落在时段外，顺延至下一个允许时段的开始时刻 { ms, shifted: true }
 */
function alignToAllowedWindow(candidateMs, startMin, endMin) {
  const startMs = startMin * MINUTE_MS;
  const endMs = endMin * MINUTE_MS;
  const todMs = utc8TimeOfDayMs(candidateMs);
  const dayStart = utc8DayStartMs(candidateMs);

  if (startMs < endMs) {
    // 常规日间窗口，例如 06:00–23:30（含起止端点）
    if (todMs >= startMs && todMs <= endMs) {
      return { ms: candidateMs, shifted: false };
    }
    if (todMs < startMs) {
      return { ms: dayStart + startMs, shifted: true };
    }
    return { ms: dayStart + DAY_MS + startMs, shifted: true };
  }

  // 跨零点窗口，例如 22:00–02:00
  if (todMs >= startMs || todMs <= endMs) {
    return { ms: candidateMs, shifted: false };
  }
  return { ms: dayStart + startMs, shifted: true };
}

/**
 * 计算日上限满时顺延到的「次日首个可用时刻」。
 */
function nextDayFirstAvailableMs(candidateMs, startMin, endMin) {
  const nextDayStart = utc8DayStartMs(candidateMs) + DAY_MS;
  if (startMin < endMin) {
    return nextDayStart + startMin * MINUTE_MS;
  }
  // 跨零点窗口（如 22:00–02:00）次日 00:00 就在允许时段内
  return nextDayStart;
}

/**
 * 纯函数：为本次请求的目标平台/账号列表计算发布计划时刻。
 *
 * 规则：
 * 1. 对每个目标：
 *    baseMs = explicitPublishAtMs != null ? max(nowMs, explicitPublishAtMs) : nowMs
 *    - 平台相对首发延迟：candidate = baseMs + delayFromFirstHours
 *    - 同平台同账号最小间隔：candidate = max(candidate, latestEventMs + minIntervalHours)
 *    - 允许发布时段（UTC+8）：落在时段外则顺延到下个时段开始
 *    - 同平台同账号每日上限（UTC+8 日历日）：已满则顺延到次日首个可用时刻（并再次确保满足时段与上限）
 * 2. 显式 publishAt 同样过节流，且只顺延不提前（plannedAtMs >= explicitPublishAtMs）。
 * 3. noThrottle 为 true 或 settings.enabled 为 false 时绕过节流。
 * 4. 未显式指定 publishAt 且 plannedAtMs <= nowMs + 1 分钟 → immediate: true（立即发）；
 *    否则 scheduled: true（自动建定时任务）。
 * 5. 同一请求内同平台多账号互不影响；同账号多条请求按顺序累积。
 *
 * @param {object} params
 * @returns {{ enabled: boolean, nowMs: number, settings: object, items: Array<object>, hasThrottled: boolean, hasScheduled: boolean }}
 */
function planPublishTimes({
  targets = [],
  now = Date.now(),
  publishAt = null,
  publishAtMs = null,
  records = [],
  settings = null,
  noThrottle = false,
  immediateThresholdMs = IMMEDIATE_THRESHOLD_MS,
  maxLookaheadDays = MAX_PLAN_LOOKAHEAD_DAYS,
  scheduledExpireGraceMs = 0,
} = {}) {
  const nowMs =
    typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const normSettings = normalizePublishThrottleSettings(settings);
  const startMin = parseTimeOfDayMinutes(normSettings.allowedWindow.start);
  const endMin = parseTimeOfDayMinutes(normSettings.allowedWindow.end);
  const windowLabel = `${normSettings.allowedWindow.start}–${normSettings.allowedWindow.end}`;
  const lookaheadDays =
    typeof maxLookaheadDays === "number" &&
    Number.isFinite(maxLookaheadDays) &&
    maxLookaheadDays >= 1
      ? Math.floor(maxLookaheadDays)
      : MAX_PLAN_LOOKAHEAD_DAYS;

  const globalExplicitMs =
    typeof publishAtMs === "number" && Number.isFinite(publishAtMs)
      ? publishAtMs
      : parseUtc8DateTimeMs(publishAt);

  // 按 (平台, 账号) 分桶索引历史有效发布记录 / 账本记录与待执行定时任务
  const flatRecords = Array.isArray(records)
    ? records
    : flattenPushDataRecords(records);
  const buckets = new Map(); // bucketKey -> Array<{ ts: number, isScheduled: boolean }>

  for (let i = 0; i < flatRecords.length; i++) {
    const rec = flatRecords[i];
    if (!rec || typeof rec !== "object") continue;
    // 文章记录不参与视频节流
    if (String(rec.textType || "").trim().toLowerCase() === "article") continue;
    const recPt = resolveCanonicalPlatform(rec.pt || rec.platform);
    if (!recPt) continue;
    const ev = extractThrottleRecordEvent(rec, nowMs, {
      scheduledExpireGraceMs,
    });
    if (!ev) continue;
    const key =
      typeof rec.bucketKey === "string" && rec.bucketKey.trim()
        ? rec.bucketKey.trim()
        : buildAccountBucketKey(rec, recPt);
    let list = buckets.get(key);
    if (!list) {
      list = [];
      buckets.set(key, list);
    }
    list.push(ev);
  }

  const targetList = Array.isArray(targets) ? targets : [];
  const items = [];

  for (let index = 0; index < targetList.length; index++) {
    const t = targetList[index] || {};
    const canonicalPt = resolveCanonicalPlatform(t.platform || t.pt);
    const resolvedPartition = deriveCanonicalPartition(t, canonicalPt);
    const bucketKey = buildAccountBucketKey(t, canonicalPt);
    const rule = getPlatformThrottleRule(normSettings, canonicalPt);

    const targetExplicitMs =
      typeof t.publishAtMs === "number" && Number.isFinite(t.publishAtMs)
        ? t.publishAtMs
        : t.publishAt != null && String(t.publishAt).trim() !== ""
        ? parseUtc8DateTimeMs(t.publishAt)
        : globalExplicitMs;

    const hasExplicit = targetExplicitMs !== null;

    // 0. 草稿（CLI --draft、HTTP draft、账号默认草稿、定时草稿）一律不节流、不进账本、不计入日上限
    if (isDraftPublishItem(t)) {
      const plannedAtMs = hasExplicit ? targetExplicitMs : nowMs;
      const scheduled = hasExplicit;
      const immediate = !scheduled;
      const finalPublishAt = scheduled ? formatUtc8DateTime(plannedAtMs) : null;
      items.push({
        index,
        ok: true,
        overflow: false,
        error: "",
        platform: canonicalPt,
        phone: String(t.phone || "").trim(),
        partition: resolvedPartition,
        accountKey: bucketKey,
        isDraft: true,
        reusedScheduled: false,
        immediate,
        scheduled,
        throttled: false,
        bypassed: true,
        requestedAtMs: hasExplicit ? targetExplicitMs : nowMs,
        plannedAtMs,
        publishAt: finalPublishAt,
        reasons: [],
        reason: "",
        rule,
      });
      continue;
    }

    // 1. 复用既有同文件同时刻定时任务：按原基线规则复用，不再节流顺延，也不重复占位
    if (t.reusedScheduled === true && hasExplicit) {
      const finalPublishAt = formatUtc8DateTime(targetExplicitMs);
      items.push({
        index,
        ok: true,
        overflow: false,
        error: "",
        platform: canonicalPt,
        phone: String(t.phone || "").trim(),
        partition: resolvedPartition,
        accountKey: bucketKey,
        isDraft: false,
        reusedScheduled: true,
        existingRecordId: t.existingRecordId || null,
        immediate: false,
        scheduled: true,
        throttled: false,
        bypassed: false,
        requestedAtMs: targetExplicitMs,
        plannedAtMs: targetExplicitMs,
        publishAt: finalPublishAt,
        reasons: [],
        reason: "",
        rule,
      });
      continue;
    }

    const bypass = Boolean(noThrottle || t.noThrottle || !normSettings.enabled);

    let list = buckets.get(bucketKey);
    if (!list) {
      list = [];
      buckets.set(bucketKey, list);
    }

    if (bypass) {
      const plannedAtMs = hasExplicit ? targetExplicitMs : nowMs;
      const scheduled = hasExplicit;
      const immediate = !scheduled;
      const finalPublishAt = scheduled ? formatUtc8DateTime(plannedAtMs) : null;

      list.push({ ts: Math.max(nowMs, plannedAtMs), isScheduled: scheduled });

      items.push({
        index,
        ok: true,
        overflow: false,
        error: "",
        platform: canonicalPt,
        phone: String(t.phone || "").trim(),
        partition: resolvedPartition,
        accountKey: bucketKey,
        isDraft: false,
        reusedScheduled: false,
        immediate,
        scheduled,
        throttled: false,
        bypassed: Boolean(noThrottle || t.noThrottle),
        requestedAtMs: hasExplicit ? targetExplicitMs : nowMs,
        plannedAtMs,
        publishAt: finalPublishAt,
        reasons: [],
        reason: "",
        rule,
      });
      continue;
    }

    const baseRequestMs = hasExplicit ? Math.max(nowMs, targetExplicitMs) : nowMs;
    const horizonDayStartMs =
      utc8DayStartMs(baseRequestMs) + lookaheadDays * DAY_MS;
    let candidateMs = baseRequestMs;
    const reasons = [];

    // 1. 平台相对首发延迟（如百家号 +10h）
    const delayMs = Math.round(rule.delayFromFirstHours * HOUR_MS);
    if (delayMs > 0) {
      candidateMs = baseRequestMs + delayMs;
      reasons.push(
        `${canonicalPt}相对首发延迟 ${formatHoursLabel(rule.delayFromFirstHours)} 小时`
      );
    }

    // 2. 同账号最小发布间隔（取所有有效账本记录与待执行定时任务中最新一条）
    const minIntervalMs = Math.round(rule.minIntervalHours * HOUR_MS);
    if (minIntervalMs > 0 && list.length > 0) {
      let latestEv = list[0];
      for (let j = 1; j < list.length; j++) {
        if (list[j].ts > latestEv.ts) {
          latestEv = list[j];
        }
      }
      const earliestAfterInterval = latestEv.ts + minIntervalMs;
      if (earliestAfterInterval > candidateMs) {
        candidateMs = earliestAfterInterval;
        reasons.push(
          latestEv.isScheduled
            ? `距${canonicalPt}待发任务不足 ${formatHoursLabel(rule.minIntervalHours)} 小时`
            : `距上次${canonicalPt}发布不足 ${formatHoursLabel(rule.minIntervalHours)} 小时`
        );
      }
    }

    // 3. 迭代检查允许发布时段（UTC+8）与每日上限（UTC+8 日历日），超过搜索上限返回「排期已满」而非突破上限
    let addedWindowReason = false;
    let addedDailyLimitReason = false;
    let foundSlot = false;
    let overflow = false;
    const maxSteps = Math.max(10, (lookaheadDays + 2) * 3);

    for (let step = 0; step < maxSteps; step++) {
      if (utc8DayStartMs(candidateMs) > horizonDayStartMs) {
        overflow = true;
        break;
      }
      let moved = false;

      if (startMin !== null && endMin !== null && startMin !== endMin) {
        const aligned = alignToAllowedWindow(candidateMs, startMin, endMin);
        if (aligned.shifted && aligned.ms > candidateMs) {
          candidateMs = aligned.ms;
          moved = true;
          if (!addedWindowReason) {
            addedWindowReason = true;
            reasons.push(
              `超出允许发布时段（${windowLabel}），顺延至时段开始`
            );
          }
        }
      }

      if (utc8DayStartMs(candidateMs) > horizonDayStartMs) {
        overflow = true;
        break;
      }

      if (rule.dailyLimit > 0) {
        const dayKey = formatUtc8Ymd(candidateMs);
        let dayCount = 0;
        for (let j = 0; j < list.length; j++) {
          if (formatUtc8Ymd(list[j].ts) === dayKey) {
            dayCount += 1;
          }
        }
        if (dayCount >= rule.dailyLimit) {
          const nextMs = nextDayFirstAvailableMs(candidateMs, startMin, endMin);
          if (nextMs > candidateMs) {
            candidateMs = nextMs;
          } else {
            candidateMs = utc8DayStartMs(candidateMs) + DAY_MS;
          }
          moved = true;
          if (!addedDailyLimitReason) {
            addedDailyLimitReason = true;
            reasons.push(
              `当日${canonicalPt}发布已达上限（${rule.dailyLimit} 条/天），顺延至次日`
            );
          }
        }
      }

      if (utc8DayStartMs(candidateMs) > horizonDayStartMs) {
        overflow = true;
        break;
      }

      if (!moved) {
        foundSlot = true;
        break;
      }
    }

    if (!foundSlot || overflow) {
      const errorMsg = `${canonicalPt}排期已满（未来 ${lookaheadDays} 天内无可用发布时段，请调整节流设置或改用不节流模式）`;
      items.push({
        index,
        ok: false,
        overflow: true,
        error: errorMsg,
        platform: canonicalPt,
        phone: String(t.phone || "").trim(),
        partition: resolvedPartition,
        accountKey: bucketKey,
        isDraft: false,
        reusedScheduled: false,
        immediate: false,
        scheduled: false,
        throttled: false,
        bypassed: false,
        requestedAtMs: hasExplicit ? targetExplicitMs : nowMs,
        plannedAtMs: null,
        publishAt: null,
        reasons,
        reason: errorMsg,
        rule,
      });
      continue;
    }

    // 只顺延不提前
    if (hasExplicit && candidateMs < targetExplicitMs) {
      candidateMs = targetExplicitMs;
    }

    const scheduled = hasExplicit
      ? true
      : candidateMs > nowMs + immediateThresholdMs;
    const immediate = !scheduled;
    const throttled = scheduled && candidateMs > baseRequestMs;
    const finalPlannedAtMs = immediate ? nowMs : candidateMs;
    // 回执 publishAt 与解析统一按 UTC+8 格式化，与主机系统时区无关
    const finalPublishAt = scheduled ? formatUtc8DateTime(candidateMs) : null;

    // 写回桶内，供同请求后续同平台同账号任务按顺序累积
    list.push({ ts: Math.max(nowMs, finalPlannedAtMs), isScheduled: scheduled });

    const finalReasons = throttled ? reasons : [];
    items.push({
      index,
      ok: true,
      overflow: false,
      error: "",
      platform: canonicalPt,
      phone: String(t.phone || "").trim(),
      partition: resolvedPartition,
      accountKey: bucketKey,
      isDraft: false,
      reusedScheduled: false,
      immediate,
      scheduled,
      throttled,
      bypassed: false,
      requestedAtMs: hasExplicit ? targetExplicitMs : nowMs,
      plannedAtMs: finalPlannedAtMs,
      publishAt: finalPublishAt,
      reasons: finalReasons,
      reason: finalReasons.join("；"),
      rule,
    });
  }

  const firstErrorItem = items.find((it) => it && it.ok === false);
  return {
    ok: !firstErrorItem,
    error: firstErrorItem ? firstErrorItem.error : "",
    hasError: Boolean(firstErrorItem),
    enabled: normSettings.enabled,
    nowMs,
    settings: normSettings,
    items,
    hasThrottled: items.some((it) => it.throttled),
    hasScheduled: items.some((it) => it.scheduled),
  };
}

/**
 * 校验并按 UTC+8 解析用户显式传入的 publishAt（与回执 formatUtc8DateTime 同口径，不受主机系统时区影响）：
 * 格式 YYYY-MM-DD HH:mm:ss、合法日历日期且必须晚于 nowMs。
 */
function parsePublishAtUtc8(value, nowMs = Date.now()) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    return {
      ok: false,
      code: "INVALID_PUBLISH_AT",
      error: "定时发布时间格式应为 YYYY-MM-DD HH:mm:ss",
    };
  }
  const nums = m.slice(1).map((v) => Number(v));
  const [year, month, day, hour, minute, second] = nums;
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const check = new Date(utcMs);
  const valid =
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second;
  if (!valid) {
    return {
      ok: false,
      code: "INVALID_PUBLISH_AT",
      error: "定时发布时间不是有效日期",
    };
  }
  const ms = utcMs - UTC8_OFFSET_MS;
  if (ms <= nowMs) {
    return {
      ok: false,
      code: "EXPIRED_PUBLISH_AT",
      error: "定时发布时间必须是未来时间",
    };
  }
  return { ok: true, value: ms, text: formatUtc8DateTime(ms) };
}

/** 兼容旧导出名，内部统一按 UTC+8 解析 */
function parseLocalPublishAt(value, nowMs = Date.now()) {
  return parsePublishAtUtc8(value, nowMs);
}

const COLLECTION_PLATFORM_KEYS = {
  抖音: ["抖音", "dy", "douyin"],
  快手: ["快手", "ks", "kuaishou"],
  视频号: ["视频号", "sph"],
};

function resolveCollectionPlatformForThrottle(platform) {
  const canonical = resolveCanonicalPlatform(platform);
  return canonical && COLLECTION_PLATFORM_KEYS[canonical] ? canonical : "";
}

function normalizeScheduledCollectionName(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.enabled === false) return "";
    const inner =
      value.name != null ? value.name : value.value != null ? value.value : "";
    return normalizeScheduledCollectionName(inner);
  }
  return normalizeCollectionName(value);
}

function pickCollectionMapEntry(map, canonicalPt) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { found: false, value: undefined };
  }
  const keys = COLLECTION_PLATFORM_KEYS[canonicalPt] || [];
  const lowerSet = new Set(keys.map((k) => k.toLowerCase()));
  for (let i = 0; i < keys.length; i++) {
    if (
      Object.prototype.hasOwnProperty.call(map, keys[i]) &&
      map[keys[i]] !== undefined &&
      map[keys[i]] !== null
    ) {
      return { found: true, value: map[keys[i]] };
    }
  }
  for (const mk of Object.keys(map)) {
    if (
      lowerSet.has(mk.toLowerCase()) &&
      map[mk] !== undefined &&
      map[mk] !== null
    ) {
      return { found: true, value: map[mk] };
    }
  }
  return { found: false, value: undefined };
}

/** 提取定时任务记录或请求配置在对应平台上实际生效的合集名（不支持平台返回空串） */
function extractScheduledCollectionForPlatform(recordOrValue, platformHint) {
  const pt = resolveCollectionPlatformForThrottle(
    platformHint ||
      (recordOrValue &&
        typeof recordOrValue === "object" &&
        (recordOrValue.pt || recordOrValue.platform))
  );
  if (!pt) return "";
  if (recordOrValue == null) return "";
  if (typeof recordOrValue === "string") {
    return normalizeScheduledCollectionName(recordOrValue);
  }
  if (typeof recordOrValue !== "object") return "";
  if (
    (Object.prototype.hasOwnProperty.call(recordOrValue, "enabled") ||
      Object.prototype.hasOwnProperty.call(recordOrValue, "name") ||
      Object.prototype.hasOwnProperty.call(recordOrValue, "value")) &&
    !Object.prototype.hasOwnProperty.call(recordOrValue, "publishOptions") &&
    !Object.prototype.hasOwnProperty.call(recordOrValue, "collection")
  ) {
    return normalizeScheduledCollectionName(recordOrValue);
  }
  const opts =
    recordOrValue.publishOptions &&
    typeof recordOrValue.publishOptions === "object"
      ? recordOrValue.publishOptions
      : recordOrValue;
  if (opts.platformOptions && typeof opts.platformOptions === "object") {
    const pHit = pickCollectionMapEntry(opts.platformOptions, pt);
    if (
      pHit.found &&
      pHit.value &&
      typeof pHit.value === "object" &&
      Object.prototype.hasOwnProperty.call(pHit.value, "collection") &&
      pHit.value.collection !== undefined &&
      pHit.value.collection !== null
    ) {
      return normalizeScheduledCollectionName(pHit.value.collection);
    }
  }
  if (opts.collections && typeof opts.collections === "object") {
    const mHit = pickCollectionMapEntry(opts.collections, pt);
    if (mHit.found) {
      return normalizeScheduledCollectionName(mHit.value);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(opts, "collection") &&
    opts.collection !== undefined &&
    opts.collection !== null
  ) {
    return normalizeScheduledCollectionName(opts.collection);
  }
  if (
    recordOrValue !== opts &&
    Object.prototype.hasOwnProperty.call(recordOrValue, "collection") &&
    recordOrValue.collection !== undefined &&
    recordOrValue.collection !== null
  ) {
    return normalizeScheduledCollectionName(recordOrValue.collection);
  }
  return "";
}

/**
 * 校验复用既有定时任务时的参数冲突（创作声明 + 合集）：
 * - 回执必须反映既有任务的实际声明与合集（与上传参数一致）
 * - 若请求声明或合集与既有任务不同，标记 conflict: true，交由调用方返回 needs_attention 不静默复用原任务
 */
function checkExistingScheduledCreativeConflict(
  existing,
  requestedCreativeStatement,
  requestedCollection = undefined
) {
  const actualCreativeStatement = normalizeDefaultCreativeStatement(
    existing && existing.creativeStatement,
    "none"
  );
  const requestedNorm = normalizeDefaultCreativeStatement(
    requestedCreativeStatement,
    "none"
  );
  const platformHint =
    (existing && (existing.pt || existing.platform)) ||
    (requestedCollection &&
      typeof requestedCollection === "object" &&
      (requestedCollection.pt || requestedCollection.platform)) ||
    "";
  const actualCollection = extractScheduledCollectionForPlatform(
    existing,
    platformHint
  );
  const compareCollection = requestedCollection !== undefined;
  const requestedCollectionNorm = compareCollection
    ? extractScheduledCollectionForPlatform(requestedCollection, platformHint)
    : actualCollection;

  const creativeConflict = actualCreativeStatement !== requestedNorm;
  // 合集冲突比较与页面匹配使用同一个归一函数 collapseCollectionText（单一来源），
  // 确保「民 间故事」与「民间故事」视为相同。
  const collectionConflict =
    compareCollection &&
    collapseCollectionText(actualCollection) !==
      collapseCollectionText(requestedCollectionNorm);
  const conflict = creativeConflict || collectionConflict;

  const existingId = (existing && existing.id) || "";
  let message = "同一视频在该时间点的定时任务已存在，未重复创建";
  if (creativeConflict && collectionConflict) {
    message = `同一视频在该时间点的定时任务已存在（id=${existingId}），但既有任务创作声明为「${actualCreativeStatement}」、合集为「${
      actualCollection || "无"
    }」，与本次请求创作声明「${requestedNorm}」、合集「${
      requestedCollectionNorm || "无"
    }」不一致，未覆盖原任务，请核对后处理`;
  } else if (creativeConflict) {
    message = `同一视频在该时间点的定时任务已存在（id=${existingId}），但既有任务创作声明为「${actualCreativeStatement}」，与本次请求声明「${requestedNorm}」不一致，未覆盖原任务，请核对后处理`;
  } else if (collectionConflict) {
    message = `同一视频在该时间点的定时任务已存在（id=${existingId}），但既有任务合集为「${
      actualCollection || "无"
    }」，与本次请求合集「${
      requestedCollectionNorm || "无"
    }」不一致，未覆盖原任务，请核对后处理`;
  }

  return {
    conflict,
    creativeConflict,
    collectionConflict,
    actualCreativeStatement,
    requestedCreativeStatement: requestedNorm,
    actualCollection,
    requestedCollection: requestedCollectionNorm,
    message,
  };
}

function normalizeDriftReasons(item) {
  if (!item || typeof item !== "object") return "";
  if (Array.isArray(item.reasons) && item.reasons.length > 0) {
    return item.reasons
      .map((r) => String(r || "").trim())
      .filter(Boolean)
      .join("；");
  }
  return String(item.reason || "").trim();
}

/**
 * 比较 GUI 预览排期与主进程加锁重算后的排期是否发生实质偏移：
 * - 草稿态 / 定时态 / 溢出错误态变化 → 要求重新确认
 * - 节流原因变化（当预览项携带 reason/reasons 时）→ 要求重新确认
 * - 计划时刻差异 > 60 秒（GUI_DRIFT_TIME_TOLERANCE_MS）→ 要求重新确认
 */
function comparePlanForGuiDrift(previewItems, freshItems) {
  if (!Array.isArray(previewItems) || !Array.isArray(freshItems)) return false;
  if (previewItems.length !== freshItems.length) return true;
  for (let i = 0; i < freshItems.length; i++) {
    const prev = previewItems[i] || {};
    const fresh = freshItems[i] || {};
    if (Boolean(prev.isDraft) !== Boolean(fresh.isDraft)) return true;
    if (fresh.isDraft) continue;
    if (Boolean(prev.ok !== false) !== Boolean(fresh.ok !== false)) return true;
    if (Boolean(prev.scheduled) !== Boolean(fresh.scheduled)) return true;
    const prevHasReasonField =
      Object.prototype.hasOwnProperty.call(prev, "reason") ||
      Object.prototype.hasOwnProperty.call(prev, "reasons");
    if (prevHasReasonField) {
      if (normalizeDriftReasons(prev) !== normalizeDriftReasons(fresh)) {
        return true;
      }
    }
    if (Boolean(fresh.scheduled)) {
      const prevMs =
        typeof prev.plannedAtMs === "number" && Number.isFinite(prev.plannedAtMs)
          ? prev.plannedAtMs
          : parseUtc8DateTimeMs(prev.publishAt);
      const freshMs =
        typeof fresh.plannedAtMs === "number" && Number.isFinite(fresh.plannedAtMs)
          ? fresh.plannedAtMs
          : parseUtc8DateTimeMs(fresh.publishAt);
      if (prevMs === null || freshMs === null) {
        if (String(prev.publishAt || "") !== String(fresh.publishAt || "")) {
          return true;
        }
      } else if (Math.abs(freshMs - prevMs) > GUI_DRIFT_TIME_TOLERANCE_MS) {
        return true;
      }
    }
  }
  return false;
}

module.exports = {
  UTC8_OFFSET_MS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  IMMEDIATE_THRESHOLD_MS,
  MAX_PLAN_LOOKAHEAD_DAYS,
  SCHEDULED_EXPIRE_GRACE_MS,
  PREVIEW_BASE_MAX_AGE_MS,
  GUI_DRIFT_TIME_TOLERANCE_MS,
  DEFAULT_CREATIVE_STATEMENT_VALUE,
  DEFAULT_AI_CHAPTERS,
  DEFAULT_ORIGINAL_STATEMENT,
  THROTTLE_PLATFORMS,
  DEFAULT_ALLOWED_WINDOW,
  DEFAULT_THROTTLE_SETTINGS,
  COUNTING_PUBLISH_STATUSES,
  NON_COUNTING_PUBLISH_STATUSES,
  createDefaultPlatformRules,
  createDefaultPublishThrottleSettings,
  parseTimeOfDayMinutes,
  formatMinutesToHHmm,
  formatUtc8DateTime,
  formatUtc8Ymd,
  utc8DayStartMs,
  utc8TimeOfDayMs,
  parseUtc8DateTimeMs,
  parsePublishAtUtc8,
  parseLocalPublishAt,
  normalizeDefaultCreativeStatement,
  normalizePublishThrottleSettings,
  validatePublishThrottleSettings,
  getPlatformThrottleRule,
  isDraftPublishItem,
  isCountingRecordForThrottle,
  extractThrottleRecordEvent,
  buildAccountBucketKey,
  planPublishTimes,
  extractScheduledCollectionForPlatform,
  checkExistingScheduledCreativeConflict,
  comparePlanForGuiDrift,
};
