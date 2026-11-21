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

const UTC8_OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const IMMEDIATE_THRESHOLD_MS = 60 * 1000;
const MAX_PLAN_LOOKAHEAD_DAYS = 366;

const DEFAULT_CREATIVE_STATEMENT_VALUE = "ai_generated";

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
  ["营销推广", "marketing"],
  ["个人观点", "personal_opinion"],
  ["转载", "repost"],
  ["自行拍摄", "self_shot"],
  ["自制禁转载", "self_made_no_repost"],
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
    platforms: createDefaultPlatformRules(),
  };
}

const DEFAULT_THROTTLE_SETTINGS = createDefaultPublishThrottleSettings();

/** 计入节流间隔与日上限的发布状态（已成功 / 进行中 / 待执行定时任务） */
const COUNTING_PUBLISH_STATUSES = new Set([
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

function isCountingRecordForThrottle(record) {
  if (!record || typeof record !== "object") return false;
  const rawStatus = String(record.publishStatus || "").trim().toLowerCase();
  if (rawStatus) {
    if (COUNTING_PUBLISH_STATUSES.has(rawStatus)) return true;
    if (NON_COUNTING_PUBLISH_STATUSES.has(rawStatus)) return false;
    return false;
  }
  return Number(record.publishSuccessCount) > 0 || Boolean(record.videoLink);
}

function extractThrottleRecordEvent(record, nowMs) {
  if (!isCountingRecordForThrottle(record)) return null;
  const status = String(record.publishStatus || "").trim().toLowerCase();
  if (status === "scheduled" || (record.scheduledTask === true && !status)) {
    const ts =
      parseUtc8DateTimeMs(record.scheduledPublishAt) ||
      parseUtc8DateTimeMs(record.scheduledPublishAtText);
    if (ts === null) return null;
    // 已过期的待发任务不会执行，不计入排期占位
    if (ts < nowMs) return null;
    return { ts, isScheduled: true };
  }
  const ts =
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
} = {}) {
  const nowMs =
    typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const normSettings = normalizePublishThrottleSettings(settings);
  const startMin = parseTimeOfDayMinutes(normSettings.allowedWindow.start);
  const endMin = parseTimeOfDayMinutes(normSettings.allowedWindow.end);
  const windowLabel = `${normSettings.allowedWindow.start}–${normSettings.allowedWindow.end}`;

  const globalExplicitMs =
    typeof publishAtMs === "number" && Number.isFinite(publishAtMs)
      ? publishAtMs
      : parseUtc8DateTimeMs(publishAt);
  const globalExplicitText =
    typeof publishAt === "string" && publishAt.trim() ? publishAt.trim() : null;

  // 按 (平台, 账号) 分桶索引历史有效发布记录与待执行定时任务
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
    const ev = extractThrottleRecordEvent(rec, nowMs);
    if (!ev) continue;
    const key = buildAccountBucketKey(rec, recPt);
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
    const targetExplicitText =
      typeof t.publishAt === "string" && t.publishAt.trim()
        ? t.publishAt.trim()
        : targetExplicitMs === globalExplicitMs
        ? globalExplicitText
        : null;

    const bypass = Boolean(noThrottle || t.noThrottle || !normSettings.enabled);

    let list = buckets.get(bucketKey);
    if (!list) {
      list = [];
      buckets.set(bucketKey, list);
    }

    if (bypass) {
      const hasExplicit = targetExplicitMs !== null;
      const plannedAtMs = hasExplicit ? targetExplicitMs : nowMs;
      const scheduled = hasExplicit;
      const immediate = !scheduled;
      const finalPublishAt = scheduled
        ? targetExplicitText || formatUtc8DateTime(plannedAtMs)
        : null;

      list.push({ ts: Math.max(nowMs, plannedAtMs), isScheduled: scheduled });

      items.push({
        index,
        platform: canonicalPt,
        phone: String(t.phone || "").trim(),
        partition: resolvedPartition,
        accountKey: bucketKey,
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

    const hasExplicit = targetExplicitMs !== null;
    const baseRequestMs = hasExplicit ? Math.max(nowMs, targetExplicitMs) : nowMs;
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

    // 2. 同账号最小发布间隔（取所有有效历史记录与待执行定时任务中最新一条）
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

    // 3. 迭代检查允许发布时段（UTC+8）与每日上限（UTC+8 日历日），确保全部约束同时满足
    let addedWindowReason = false;
    let addedDailyLimitReason = false;
    for (let step = 0; step < MAX_PLAN_LOOKAHEAD_DAYS; step++) {
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

      if (!moved) break;
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

    const finalPublishAt = scheduled
      ? throttled
        ? formatUtc8DateTime(candidateMs)
        : targetExplicitText || formatUtc8DateTime(candidateMs)
      : null;

    // 写回桶内，供同请求后续同平台同账号任务按顺序累积
    list.push({ ts: Math.max(nowMs, finalPlannedAtMs), isScheduled: scheduled });

    const finalReasons = throttled ? reasons : [];
    items.push({
      index,
      platform: canonicalPt,
      phone: String(t.phone || "").trim(),
      partition: resolvedPartition,
      accountKey: bucketKey,
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

  return {
    enabled: normSettings.enabled,
    nowMs,
    settings: normSettings,
    items,
    hasThrottled: items.some((it) => it.throttled),
    hasScheduled: items.some((it) => it.scheduled),
  };
}

/**
 * 校验用户显式传入的 publishAt（与 scheduledPublish.parsePublishAt 同口径：
 * 格式 YYYY-MM-DD HH:mm:ss、合法日历日期且必须晚于 nowMs）。
 */
function parseLocalPublishAt(value, nowMs = Date.now()) {
  const text = String(value || "").trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) {
    return { ok: false, error: "定时发布时间格式应为 YYYY-MM-DD HH:mm:ss" };
  }
  const nums = m.slice(1).map((v) => Number(v));
  const [year, month, day, hour, minute, second] = nums;
  const dt = new Date(year, month - 1, day, hour, minute, second, 0);
  const valid =
    dt.getFullYear() === year &&
    dt.getMonth() === month - 1 &&
    dt.getDate() === day &&
    dt.getHours() === hour &&
    dt.getMinutes() === minute &&
    dt.getSeconds() === second;
  if (!valid) {
    return { ok: false, error: "定时发布时间不是有效日期" };
  }
  if (dt.getTime() <= nowMs) {
    return { ok: false, error: "定时发布时间必须是未来时间" };
  }
  return { ok: true, value: dt.getTime(), text };
}

module.exports = {
  UTC8_OFFSET_MS,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  IMMEDIATE_THRESHOLD_MS,
  DEFAULT_CREATIVE_STATEMENT_VALUE,
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
  parseLocalPublishAt,
  normalizeDefaultCreativeStatement,
  normalizePublishThrottleSettings,
  validatePublishThrottleSettings,
  getPlatformThrottleRule,
  isCountingRecordForThrottle,
  planPublishTimes,
};
