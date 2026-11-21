"use strict";

/**
 * 作品与账号数据纯规则分析模块（不依赖 electron / fs，不调 AI）。
 *
 * 基于 S6 跨平台关联结果（自动 + overrides）与作品日明细 / 账号日快照，
 * 产出 7 节结构化分析供 GUI「数据分析」tab 与 Excel「分析」sheet 共用。
 */

const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const UTC8_MS = 8 * 3600e3;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLOT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NAIVE_DATETIME_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/;
const TZ_SUFFIX_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];
const PLATFORM_RANK_MAP = new Map(PLATFORM_ORDER.map((p, i) => [p, i]));

const METRIC_LABELS = Object.freeze({
  play: "播放",
  like: "点赞",
  comment: "评论",
  share: "分享",
  favorite: "收藏",
  fansDelta: "涨粉",
});

// 各平台作品级缺失的互动字段（与 adapters.js / 字段说明保持一致；加权互动率计算时缺失按 0 计）
const PLATFORM_MISSING_INTERACTION_FIELDS = Object.freeze({
  快手: Object.freeze(["分享", "收藏"]),
  头条: Object.freeze(["分享"]),
});

const ACCOUNT_PLAYS_SHARP_DROP_RATIO = 0.5;

// 分析阈值常量（导出便于单测与后续调优）
const DEFAULT_ANALYSIS_PERIOD = 30;
const MIN_PLATFORM_COMPARE_PLATFORMS = 2;
const LOW_SAMPLE_THRESHOLD = 3;
const PLATFORM_PLAY_CLOSE_DIFF_RATIO = 0.05;
const ENGAGEMENT_MIN_PLAY = 100;
const RANKING_LIMIT = 10;
const PLATFORM_SKEW_RATIO = 3;
const PLATFORM_SKEW_MIN_PLAY = 500;
const NEW_WORK_MILESTONES = Object.freeze([1, 3, 7]);
const NEW_WORKS_FIRST_24H_DAYS = 7;
const NEW_WORKS_FIRST_24H_HOURS = 24;
const LONG_TAIL_D7_D3_RATIO = 1.5;
const BURST_FLAT_D3_D1_RATIO = 1.3;
const BURST_FLAT_D7_D3_RATIO = 1.1;
const PUBLISH_TIME_MIN_SAMPLES = 3;
const RECOMMEND_BASELINE_DAYS = 7;
const RECOMMEND_SPIKE_MULTIPLIER = 5;
const RECOMMEND_SPIKE_MIN_PLAY_DELTA = 1000;
const MIN_ACCUMULATED_DAYS_NOTICE = 14;

const PUBLISH_TIME_SLOTS = Object.freeze([
  { key: "0-6", label: "0–6", startHour: 0, endHour: 6 },
  { key: "6-12", label: "6–12", startHour: 6, endHour: 12 },
  { key: "12-18", label: "12–18", startHour: 12, endHour: 18 },
  { key: "18-24", label: "18–24", startHour: 18, endHour: 24 },
]);

const WEEKDAY_LABELS = Object.freeze({
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
});

const LOW_HISTORY_NOTICE_TEXT =
  "数据积累少于 14 天，走势与发布时间结论仅供参考";

const ANALYSIS_THRESHOLDS = Object.freeze({
  defaultPeriod: DEFAULT_ANALYSIS_PERIOD,
  minPlatformComparePlatforms: MIN_PLATFORM_COMPARE_PLATFORMS,
  lowSampleThreshold: LOW_SAMPLE_THRESHOLD,
  platformPlayCloseDiffRatio: PLATFORM_PLAY_CLOSE_DIFF_RATIO,
  engagementMinPlay: ENGAGEMENT_MIN_PLAY,
  rankingLimit: RANKING_LIMIT,
  platformSkewRatio: PLATFORM_SKEW_RATIO,
  platformSkewMinPlay: PLATFORM_SKEW_MIN_PLAY,
  newWorkMilestones: NEW_WORK_MILESTONES,
  longTailD7D3Ratio: LONG_TAIL_D7_D3_RATIO,
  burstFlatD3D1Ratio: BURST_FLAT_D3_D1_RATIO,
  burstFlatD7D3Ratio: BURST_FLAT_D7_D3_RATIO,
  publishTimeMinSamples: PUBLISH_TIME_MIN_SAMPLES,
  recommendBaselineDays: RECOMMEND_BASELINE_DAYS,
  recommendSpikeMultiplier: RECOMMEND_SPIKE_MULTIPLIER,
  recommendSpikeMinPlayDelta: RECOMMEND_SPIKE_MIN_PLAY_DELTA,
  minAccumulatedDaysNotice: MIN_ACCUMULATED_DAYS_NOTICE,
});

// 日期解析 O(1) 缓存（典型分析仅 90–365 个不同日期，避免重复 Date.parse/toISOString）
const DATE_DAYNUM_CACHE = new Map();
const DAYNUM_DATE_CACHE = new Map();
const MAX_DATE_CACHE_SIZE = 8192;

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function fastNormalizeMetric(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v === 0 ? 0 : v;
  }
  if (v === null || v === undefined) return null;
  return normalizeMetric(v);
}

function compareText(a, b) {
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function comparePlatform(a, b) {
  const ia = PLATFORM_RANK_MAP.get(a);
  const ib = PLATFORM_RANK_MAP.get(b);
  if (ia !== undefined && ib !== undefined) return ia - ib;
  if (ia !== undefined) return -1;
  if (ib !== undefined) return 1;
  return compareText(a, b);
}

function dateStrToDayNum(ymd) {
  if (typeof ymd !== "string") return null;
  const cached = DATE_DAYNUM_CACHE.get(ymd);
  if (cached !== undefined) return cached;
  if (!DATE_RE.test(ymd)) return null;
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  const d = Number(ymd.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    if (DATE_DAYNUM_CACHE.size < MAX_DATE_CACHE_SIZE) DATE_DAYNUM_CACHE.set(ymd, null);
    return null;
  }
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  const valid =
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  const res = valid ? Math.floor(ms / DAY_MS) : null;
  if (DATE_DAYNUM_CACHE.size >= MAX_DATE_CACHE_SIZE) {
    DATE_DAYNUM_CACHE.clear();
  }
  DATE_DAYNUM_CACHE.set(ymd, res);
  if (res !== null && DAYNUM_DATE_CACHE.size < MAX_DATE_CACHE_SIZE) {
    DAYNUM_DATE_CACHE.set(res, ymd);
  }
  return res;
}

function dayNumToDateStr(dayNum) {
  const cached = DAYNUM_DATE_CACHE.get(dayNum);
  if (cached !== undefined) return cached;
  const s = new Date(dayNum * DAY_MS).toISOString().slice(0, 10);
  if (DAYNUM_DATE_CACHE.size >= MAX_DATE_CACHE_SIZE) {
    DAYNUM_DATE_CACHE.clear();
  }
  DAYNUM_DATE_CACHE.set(dayNum, s);
  if (DATE_DAYNUM_CACHE.size < MAX_DATE_CACHE_SIZE) {
    DATE_DAYNUM_CACHE.set(s, dayNum);
  }
  return s;
}

function isValidDateStr(s) {
  return dateStrToDayNum(s) !== null;
}

function shiftDateStr(ymd, deltaDays) {
  const dn = dateStrToDayNum(ymd);
  if (dn !== null) return dayNumToDateStr(dn + deltaDays);
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function formatUtc8Date(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return dayNumToDateStr(Math.floor((safeMs + UTC8_MS) / DAY_MS));
}

function parseTimestampMs(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") {
    ms = raw;
  } else if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      ms = Number(s);
    } else if (TZ_SUFFIX_RE.test(s)) {
      ms = Date.parse(s.replace(/\//g, "-").replace(" ", "T"));
    } else {
      const m = NAIVE_DATETIME_RE.exec(s);
      if (m) {
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const hh = m[4] ? Number(m[4]) : 0;
        const mm = m[5] ? Number(m[5]) : 0;
        const ss = m[6] ? Number(m[6]) : 0;
        const frac = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh <= 23 && mm <= 59 && ss <= 59) {
          const utcMs = Date.UTC(y, mo - 1, d, hh, mm, ss, frac);
          const check = new Date(utcMs);
          if (
            check.getUTCFullYear() === y &&
            check.getUTCMonth() === mo - 1 &&
            check.getUTCDate() === d
          ) {
            ms = utcMs - UTC8_MS;
          }
        }
      } else {
        ms = Date.parse(s);
      }
    }
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  // 1970-01-01 ~ 2100-12-31 UTC+8 边界快速校验（无需每次构造 Date）
  const shiftedMs = ms + UTC8_MS;
  if (shiftedMs < 0 || shiftedMs >= 4133980800000) return null;
  return ms;
}

function toUtc8DateStr(raw) {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (DATE_RE.test(trimmed) && dateStrToDayNum(trimmed) !== null) {
      return trimmed;
    }
  }
  const ms = parseTimestampMs(raw);
  return ms === null ? "" : dayNumToDateStr(Math.floor((ms + UTC8_MS) / DAY_MS));
}

function parsePgKey(pgKey) {
  const s = pgKey == null ? "" : String(pgKey);
  const sep = s.indexOf("|");
  if (sep === -1) return { platform: s, group: "" };
  return { platform: s.slice(0, sep), group: s.slice(sep + 1) };
}

function roundTo(val, digits) {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  const factor = Math.pow(10, digits);
  const rounded =
    Math.round((val + (val >= 0 ? Number.EPSILON : -Number.EPSILON)) * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

const round2 = (v) => roundTo(v, 2);
const round4 = (v) => roundTo(v, 4);

function normalizeZero(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v === 0 ? 0 : v;
}

function formatIntText(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "-";
  return Math.round(v).toLocaleString("zh-CN");
}

function formatPctFromRate(rate) {
  if (typeof rate !== "number" || !Number.isFinite(rate)) return "-";
  return `${round2(rate * 100)}%`;
}

function formatMomText(momPct) {
  if (typeof momPct !== "number" || !Number.isFinite(momPct)) return "无上期基数";
  const sign = momPct > 0 ? "+" : "";
  return `${sign}${momPct}%`;
}

function resolvePeriod(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_ANALYSIS_PERIOD;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 365) {
    throw new Error(`分析周期 period 需为 1–365 的正整数：${raw}`);
  }
  return raw;
}

/**
 * 解析截止日期，并以 UTC+8 今天为上限（未来日期夹到今天，避免提前填入未到期里程碑）。
 */
function resolveToDate(rawTo, dailyRows, accountRows, nowVal, intradayRows) {
  const todayUtc8 = formatUtc8Date(nowVal);
  if (rawTo !== undefined && rawTo !== null && rawTo !== "") {
    if (typeof rawTo !== "string" || !isValidDateStr(rawTo.trim())) {
      throw new Error(`截止日期 to 不是合法日期（需 YYYY-MM-DD）：${rawTo}`);
    }
    const trimmed = rawTo.trim();
    return trimmed > todayUtc8 ? todayUtc8 : trimmed;
  }
  let latestWorkDate = "";
  for (const r of Array.isArray(dailyRows) ? dailyRows : []) {
    if (!isPlainObject(r) || typeof r.date !== "string") continue;
    const d = r.date.trim();
    if (!isValidDateStr(d)) continue;
    if (!latestWorkDate || d > latestWorkDate) latestWorkDate = d;
  }
  if (latestWorkDate) {
    return latestWorkDate > todayUtc8 ? todayUtc8 : latestWorkDate;
  }
  let latestIntradayDate = "";
  for (const r of Array.isArray(intradayRows) ? intradayRows : []) {
    if (!isPlainObject(r) || typeof r.date !== "string") continue;
    const d = r.date.trim();
    if (!isValidDateStr(d)) continue;
    if (!latestIntradayDate || d > latestIntradayDate) latestIntradayDate = d;
  }
  if (latestIntradayDate) {
    return latestIntradayDate > todayUtc8 ? todayUtc8 : latestIntradayDate;
  }

  let latestAccDate = "";
  for (const r of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(r) || typeof r.date !== "string") continue;
    const d = r.date.trim();
    if (!isValidDateStr(d)) continue;
    if (!latestAccDate || d > latestAccDate) latestAccDate = d;
  }
  if (latestAccDate) {
    return latestAccDate > todayUtc8 ? todayUtc8 : latestAccDate;
  }

  return todayUtc8;
}

function buildSummaryWorkToContentMap(summaryRows) {
  const map = new Map();
  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!isPlainObject(row) || !row.contentKey || !isPlainObject(row.perPlatform)) continue;
    const ck = String(row.contentKey).trim();
    if (!ck) continue;
    for (const [pgKey, cell] of Object.entries(row.perPlatform)) {
      if (!isPlainObject(cell)) continue;
      const { platform } = parsePgKey(pgKey);
      if (!platform) continue;
      if (Array.isArray(cell.workIds)) {
        for (const wid of cell.workIds) {
          if (wid != null && wid !== "") {
            const pwKey = `${platform}|${String(wid).trim()}`;
            if (!map.has(pwKey)) map.set(pwKey, ck);
          }
        }
      }
      if (Array.isArray(cell.works)) {
        for (const w of cell.works) {
          if (isPlainObject(w) && w.workId != null && w.workId !== "") {
            const p =
              typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
            const pwKey = `${p}|${String(w.workId).trim()}`;
            if (!map.has(pwKey)) map.set(pwKey, ck);
          }
        }
      }
    }
  }
  return map;
}

/**
 * 预处理作品日明细（结构化列存 SoA + 先按作品分组后排序去重，兼顾大数据量性能）：
 * 1. 使用全部快照（含截止日之后的恢复快照）按 (platform|workId) 组织时间序列并跨组去重
 * 2. 在全历史序列上识别「疑似采集异常（某指标当日为 0 或缺失，前后有记录日均 >0）」
 * 3. 仅保留 <= cutoffTo 的有效点重算日增与最新有效累计值（cleanedLatest），避免未来快照泄漏，
 *    同时确保历史截止日也能剔除已由后续恢复快照确认的掉 0 异常
 */
function prepareWorkSeries(dailyRows, cutoffTo, summaryWorkToContent) {
  const cutoffDayNum = dateStrToDayNum(cutoffTo);
  const rawByWork = new Map();
  const hasSummaryMap = summaryWorkToContent instanceof Map && summaryWorkToContent.size > 0;

  for (let idx = 0, len = Array.isArray(dailyRows) ? dailyRows.length : 0; idx < len; idx++) {
    const raw = dailyRows[idx];
    if (!isPlainObject(raw)) continue;
    const rawDate = raw.date;
    if (typeof rawDate !== "string") continue;
    const date = rawDate.length === 10 && rawDate[4] === "-" ? rawDate : rawDate.trim();
    const dayNum =
      typeof raw.dayNum === "number" && Number.isInteger(raw.dayNum)
        ? raw.dayNum
        : dateStrToDayNum(date);
    if (dayNum === null) continue;

    const rawPlatform = raw.platform;
    const rawWorkId = raw.workId;
    if (rawPlatform == null || rawWorkId == null) continue;
    const platform =
      typeof rawPlatform === "string" ? rawPlatform.trim() : String(rawPlatform).trim();
    const workId = typeof rawWorkId === "string" ? rawWorkId.trim() : String(rawWorkId).trim();
    if (!platform || !workId) continue;

    const pwKey = `${platform}|${workId}`;
    let bucket = rawByWork.get(pwKey);
    if (!bucket) {
      bucket = {
        pwKey,
        platform,
        workId,
        points: [],
        strictlySorted: true,
        lastDayNum: -Infinity,
      };
      rawByWork.set(pwKey, bucket);
    }

    if (dayNum <= bucket.lastDayNum) {
      bucket.strictlySorted = false;
    }
    bucket.lastDayNum = dayNum;

    const group = raw.group == null ? "" : String(raw.group);
    const play = fastNormalizeMetric(raw.play);
    const like = fastNormalizeMetric(raw.like);
    const comment = fastNormalizeMetric(raw.comment);
    const share = fastNormalizeMetric(raw.share);
    const favorite = fastNormalizeMetric(raw.favorite);
    const fansDelta = fastNormalizeMetric(raw.fansDelta);

    const pubMs =
      typeof raw.publishTimeMs === "number" && Number.isFinite(raw.publishTimeMs)
        ? raw.publishTimeMs > 0
          ? raw.publishTimeMs
          : null
        : parseTimestampMs(raw.publishTime);
    const pubDate =
      typeof raw.publishDate === "string" && raw.publishDate.length === 10 && isValidDateStr(raw.publishDate)
        ? raw.publishDate
        : pubMs !== null
        ? dayNumToDateStr(Math.floor((pubMs + UTC8_MS) / DAY_MS))
        : toUtc8DateStr(raw.publishDate);

    const explicitCk =
      typeof raw.contentKey === "string" && raw.contentKey.trim() ? raw.contentKey.trim() : "";
    const fallbackCk = !explicitCk && hasSummaryMap ? summaryWorkToContent.get(pwKey) || "" : "";
    const rawContentKey = explicitCk || fallbackCk || null;
    const contentKey = rawContentKey || `unlinked:${platform}:${workId}`;

    bucket.points.push({
      date,
      dayNum,
      group,
      title: typeof raw.title === "string" && raw.title ? raw.title : "(无标题)",
      url: typeof raw.url === "string" ? raw.url : "",
      publishTimeMs: pubMs,
      publishDate: pubDate,
      contentKey,
      rawContentKey,
      play,
      like,
      comment,
      share,
      favorite,
      fansDelta,
    });
  }

  const seriesByWork = new Map();
  const allCollectionAnomalies = [];
  const snapshotDayNums = new Set();

  for (const [pwKey, bucket] of rawByWork.entries()) {
    let points = bucket.points;
    if (!bucket.strictlySorted && points.length > 1) {
      points.sort((a, b) => {
        if (a.dayNum !== b.dayNum) return a.dayNum - b.dayNum;
        return compareText(a.group, b.group);
      });
      // 按 dayNum 去重，同一天跨多分组保留按分组名排序第一组的一份观测
      let writeIdx = 1;
      for (let i = 1; i < points.length; i++) {
        if (points[i].dayNum !== points[writeIdx - 1].dayNum) {
          points[writeIdx++] = points[i];
        }
      }
      if (writeIdx < points.length) points.length = writeIdx;
    }

    const n = points.length;
    // 找出 <= cutoffTo 的点数量（points 已按 dayNum 严格递增）
    let cutoffLen = n;
    while (cutoffLen > 0 && points[cutoffLen - 1].dayNum > cutoffDayNum) {
      cutoffLen -= 1;
    }
    if (cutoffLen === 0) continue;

    // 在全部快照（含 cutoffTo 之后）上检测「掉 0 或缺失后回升」
    const excludedByMetric = {};
    let hadAnomaly = false;
    const prevPosArr = new Int32Array(n);

    for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
      const k = WORK_STAT_KEYS[ki];
      const exFlags = new Uint8Array(cutoffLen);
      excludedByMetric[k] = exFlags;

      let seenPos = -1;
      for (let i = 0; i < n; i++) {
        prevPosArr[i] = seenPos;
        const v = points[i][k];
        if (v !== null && v > 0) seenPos = i;
      }
      let nextPos = -1;
      for (let i = n - 1; i >= 0; i--) {
        const v = points[i][k];
        if (i < cutoffLen) {
          const prevPosIdx = prevPosArr[i];
          if ((v === 0 || v === null) && prevPosIdx !== -1 && nextPos !== -1) {
            exFlags[i] = 1;
            hadAnomaly = true;
            const pt = points[i];
            allCollectionAnomalies.push({
              date: pt.date,
              platform: bucket.platform,
              group: pt.group,
              workId: bucket.workId,
              pwKey,
              contentKey: pt.contentKey,
              title: pt.title,
              url: pt.url,
              metric: k,
              metricLabel: METRIC_LABELS[k] || k,
              value: v,
              prevDate: points[prevPosIdx].date,
              prevValue: points[prevPosIdx][k],
              nextDate: points[nextPos].date,
              nextValue: points[nextPos][k],
            });
          }
        }
        if (v !== null && v > 0) nextPos = i;
      }
    }

    // 仅基于 <= cutoffTo 的点构建清洗后列存序列，并重算日增与最新有效累计值
    const dates = new Array(cutoffLen);
    const dayNums = new Int32Array(cutoffLen);
    const groups = new Array(cutoffLen);
    const titles = new Array(cutoffLen);
    const urls = new Array(cutoffLen);
    const vals = {};
    const deltas = {};
    const cleanedLatest = {};
    const lastValidVal = {};
    const lastValidDay = {};
    for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
      const k = WORK_STAT_KEYS[ki];
      vals[k] = new Array(cutoffLen);
      deltas[k] = new Array(cutoffLen);
      cleanedLatest[k] = null;
      lastValidVal[k] = null;
      lastValidDay[k] = -1;
    }
    const playDaySpans = new Int32Array(cutoffLen);
    const playExcluded = excludedByMetric.play;

    let workTitle = "(无标题)";
    let workUrl = "";
    let workPubMs = null;
    let workPubDate = "";
    let workContentKey = points[cutoffLen - 1].contentKey;
    let workRawContentKey = points[cutoffLen - 1].rawContentKey;
    const workGroup = points[0].group;

    for (let i = 0; i < cutoffLen; i++) {
      const pt = points[i];
      dates[i] = pt.date;
      dayNums[i] = pt.dayNum;
      groups[i] = pt.group;
      titles[i] = pt.title;
      urls[i] = pt.url;
      snapshotDayNums.add(pt.dayNum);

      if (pt.title && pt.title !== "(无标题)") workTitle = pt.title;
      if (pt.url) workUrl = pt.url;
      if (pt.publishTimeMs !== null && (workPubMs === null || pt.publishTimeMs < workPubMs)) {
        workPubMs = pt.publishTimeMs;
      }
      if (pt.publishDate && (!workPubDate || pt.publishDate < workPubDate)) {
        workPubDate = pt.publishDate;
      }
      if (pt.rawContentKey) {
        workContentKey = pt.rawContentKey;
        workRawContentKey = pt.rawContentKey;
      }

      for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
        const k = WORK_STAT_KEYS[ki];
        if (excludedByMetric[k][i]) {
          vals[k][i] = null;
          deltas[k][i] = null;
          if (k === "play") playDaySpans[i] = 0;
          continue;
        }
        const curr = pt[k];
        vals[k][i] = curr;
        cleanedLatest[k] = curr;
        if (curr === null) {
          deltas[k][i] = null;
          if (k === "play") playDaySpans[i] = 0;
        } else if (lastValidVal[k] === null) {
          deltas[k][i] = null;
          if (k === "play") playDaySpans[i] = 0;
          lastValidVal[k] = curr;
          lastValidDay[k] = pt.dayNum;
        } else {
          const diff = curr - lastValidVal[k];
          deltas[k][i] = diff === 0 ? 0 : diff;
          if (k === "play") playDaySpans[i] = pt.dayNum - lastValidDay[k];
          lastValidVal[k] = curr;
          lastValidDay[k] = pt.dayNum;
        }
      }
    }

    if (workPubMs !== null) {
      const msDate = dayNumToDateStr(Math.floor((workPubMs + UTC8_MS) / DAY_MS));
      if (!workPubDate || msDate < workPubDate) {
        workPubDate = msDate;
      }
    }

    seriesByWork.set(pwKey, {
      pwKey,
      platform: bucket.platform,
      group: workGroup,
      workId: bucket.workId,
      contentKey: workContentKey,
      rawContentKey: workRawContentKey,
      title: workTitle,
      url: workUrl,
      publishTimeMs: workPubMs,
      publishDate: workPubDate,
      len: cutoffLen,
      dates,
      dayNums,
      groups,
      titles,
      urls,
      vals,
      deltas,
      playDaySpans,
      playExcluded,
      cleanedLatest,
      hadAnomaly,
    });
  }

  allCollectionAnomalies.sort((a, b) => {
    if (a.date !== b.date) return compareText(b.date, a.date);
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    const wc = compareText(a.workId, b.workId);
    if (wc !== 0) return wc;
    return WORK_STAT_KEYS.indexOf(a.metric) - WORK_STAT_KEYS.indexOf(b.metric);
  });

  return {
    seriesByWork,
    allCollectionAnomalies,
    snapshotDays: snapshotDayNums.size,
  };
}

/** 计算环比%（上期为 0 或无数据 → null，不输出 Infinity） */
function computeMomPct(current, previous) {
  if (
    typeof current !== "number" ||
    !Number.isFinite(current) ||
    typeof previous !== "number" ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }
  return round2(((current - previous) / Math.abs(previous)) * 100);
}

function addNullable(acc, val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return acc;
  const next = acc === null ? val : acc + val;
  return next === 0 ? 0 : next;
}

function buildWorkDailyPlaySumMap(seriesByWork) {
  const byPgDay = new Map();
  const byPlatformDay = new Map();
  for (const series of seriesByWork.values()) {
    const playVals = series.vals && series.vals.play;
    if (!playVals) continue;
    let lastPosPlay = null;
    for (let i = 0; i < series.len; i++) {
      const rawP = playVals[i];
      let effectiveP = null;
      if (rawP !== null && rawP > 0) {
        effectiveP = rawP;
        lastPosPlay = rawP;
      } else if (
        (rawP === null || rawP === 0) &&
        lastPosPlay !== null &&
        lastPosPlay > 0
      ) {
        // 作品级当日播放因假 0 / 采集异常被置空或回退为 0 时，沿用其上一次有效正播放，
        // 避免误判为「作品级同步下降」而放过账号总播放骤降异常。
        effectiveP = lastPosPlay;
      } else if (rawP === 0) {
        // 历史从未有正播放、持续为 0 的作品属于有效 0 观测，必须计入当日作品总和（使当日和为 0 而非缺失）
        effectiveP = 0;
      }
      if (effectiveP === null) continue;
      const dn = series.dayNums[i];
      const grp = series.groups[i] || series.group || "";
      const pgKey = `${series.platform}|${grp}\0${dn}`;
      byPgDay.set(pgKey, (byPgDay.get(pgKey) || 0) + effectiveP);
      const pKey = `${series.platform}\0${dn}`;
      byPlatformDay.set(pKey, (byPlatformDay.get(pKey) || 0) + effectiveP);
    }
  }
  return { byPgDay, byPlatformDay };
}

/**
 * 账号级总播放防假 0 / 骤降异常检测（复用 anomaly 机制）：
 * - 已由采集落盘标记 playsAnomaly=true 的记录，或相对上次有效正值骤降（归 0 或降幅 ≥50%）
 *   且作品级总播放无对应下降时，标为异常、不参与账号 playsDelta 计算并输出到 anomalies.collectionAnomalies。
 */
function prepareAccountSeries(accountRows, seriesByWork, cutoffTo) {
  const cutoffDayNum = dateStrToDayNum(cutoffTo);
  const byAccount = new Map();

  for (const ar of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(ar) || typeof ar.date !== "string") continue;
    const date = ar.date.trim();
    const dn = dateStrToDayNum(date);
    if (dn === null || dn > cutoffDayNum) continue;
    const platform = ar.platform == null ? "" : String(ar.platform).trim();
    if (!platform) continue;
    const group = ar.group == null ? "" : String(ar.group).trim();
    const key = `${platform}|${group}`;
    let bucket = byAccount.get(key);
    if (!bucket) {
      bucket = { platform, group, byDay: new Map() };
      byAccount.set(key, bucket);
    }
    const prevSameDay = bucket.byDay.get(dn);
    const entry = {
      date,
      dayNum: dn,
      platform,
      group,
      fans: fastNormalizeMetric(ar.fans),
      plays: fastNormalizeMetric(ar.plays),
      likes: fastNormalizeMetric(ar.likes),
      comments: fastNormalizeMetric(ar.comments),
      favorites: fastNormalizeMetric(ar.favorites),
      shares: fastNormalizeMetric(ar.shares),
      fansDelta: fastNormalizeMetric(ar.fansDelta),
      playsDelta: fastNormalizeMetric(ar.playsDelta),
      playsAnomaly: ar.playsAnomaly === true,
      playsAnomalyDetail: isPlainObject(ar.playsAnomalyDetail) ? ar.playsAnomalyDetail : null,
    };
    if (!prevSameDay) {
      bucket.byDay.set(dn, entry);
    } else {
      bucket.byDay.set(dn, {
        ...prevSameDay,
        fans:
          entry.fans !== null && (prevSameDay.fans === null || entry.fans > prevSameDay.fans)
            ? entry.fans
            : prevSameDay.fans,
        plays:
          entry.plays !== null && (prevSameDay.plays === null || entry.plays > prevSameDay.plays)
            ? entry.plays
            : prevSameDay.plays,
        playsAnomaly: prevSameDay.playsAnomaly || entry.playsAnomaly,
        playsAnomalyDetail: entry.playsAnomalyDetail || prevSameDay.playsAnomalyDetail,
      });
    }
  }

  const workPlayMaps = buildWorkDailyPlaySumMap(seriesByWork);
  const cleanedAccountRows = [];
  const accountPlaysAnomalies = [];

  for (const bucket of byAccount.values()) {
    const points = [...bucket.byDay.values()].sort((a, b) => a.dayNum - b.dayNum);
    let prevValidPlays = null;
    let prevValidDate = null;
    let prevValidDayNum = null;
    let prevValidFans = null;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      let isPlaysAnom = pt.playsAnomaly === true;
      let anomRawVal =
        pt.playsAnomalyDetail && pt.playsAnomalyDetail.rawValue !== undefined
          ? fastNormalizeMetric(pt.playsAnomalyDetail.rawValue)
          : pt.plays;
      let anomPrevDate =
        (pt.playsAnomalyDetail && pt.playsAnomalyDetail.prevDate) || prevValidDate;
      let anomPrevVal =
        pt.playsAnomalyDetail && pt.playsAnomalyDetail.prevValue !== undefined
          ? fastNormalizeMetric(pt.playsAnomalyDetail.prevValue)
          : prevValidPlays;
      let anomReason =
        (pt.playsAnomalyDetail && pt.playsAnomalyDetail.reason) ||
        "账号总播放较上次骤降且作品级无对应下降";

      if (!isPlaysAnom && prevValidPlays !== null && prevValidPlays > 0 && pt.plays !== null) {
        const drop = prevValidPlays - pt.plays;
        const dropRatio = drop / prevValidPlays;
        if (pt.plays === 0 || (drop > 0 && dropRatio >= ACCOUNT_PLAYS_SHARP_DROP_RATIO)) {
          const prevWorkSum =
            workPlayMaps.byPgDay.get(`${pt.platform}|${pt.group}\0${prevValidDayNum}`) ??
            workPlayMaps.byPlatformDay.get(`${pt.platform}\0${prevValidDayNum}`) ??
            null;
          const currWorkSum =
            workPlayMaps.byPgDay.get(`${pt.platform}|${pt.group}\0${pt.dayNum}`) ??
            workPlayMaps.byPlatformDay.get(`${pt.platform}\0${pt.dayNum}`) ??
            null;
          let hasCorrespondingWorkDrop = false;
          if (prevWorkSum !== null && prevWorkSum > 0 && currWorkSum !== null) {
            const worksDrop = prevWorkSum - currWorkSum;
            const worksDropRatio = worksDrop / prevWorkSum;
            if (
              worksDrop > 0 &&
              worksDrop >= drop * 0.5 &&
              worksDropRatio >= dropRatio * 0.5
            ) {
              hasCorrespondingWorkDrop = true;
            }
          }
          if (!hasCorrespondingWorkDrop) {
            isPlaysAnom = true;
            anomRawVal = pt.plays;
            anomPrevDate = prevValidDate;
            anomPrevVal = prevValidPlays;
          }
        }
      }

      let nextFansDelta = pt.fansDelta;
      if (pt.fans !== null && prevValidFans !== null) {
        nextFansDelta = normalizeZero(pt.fans - prevValidFans);
      }
      if (pt.fans !== null) prevValidFans = pt.fans;

      let cleanedPlays = pt.plays;
      let cleanedPlaysDelta = null;
      if (isPlaysAnom) {
        cleanedPlays = null;
        cleanedPlaysDelta = null;
        let nextDate = null;
        let nextValue = null;
        for (let j = i + 1; j < points.length; j++) {
          if (!points[j].playsAnomaly && points[j].plays !== null && points[j].plays > 0) {
            nextDate = points[j].date;
            nextValue = points[j].plays;
            break;
          }
        }
        accountPlaysAnomalies.push({
          scope: "account",
          date: pt.date,
          platform: pt.platform,
          group: pt.group,
          workId: "(账号总计)",
          pwKey: `account:${pt.platform}|${pt.group}`,
          contentKey: null,
          title: pt.group ? `${pt.platform}·${pt.group}（账号总播放）` : `${pt.platform}（账号总播放）`,
          url: "",
          metric: "plays",
          metricLabel: "账号总播放",
          value: anomRawVal,
          prevDate: anomPrevDate,
          prevValue: anomPrevVal,
          nextDate,
          nextValue,
          reason: anomReason,
        });
      } else if (pt.plays !== null) {
        if (prevValidPlays !== null) {
          cleanedPlaysDelta = normalizeZero(pt.plays - prevValidPlays);
        } else if (pt.playsDelta !== null) {
          cleanedPlaysDelta = pt.playsDelta;
        }
        prevValidPlays = pt.plays;
        prevValidDate = pt.date;
        prevValidDayNum = pt.dayNum;
      }

      const playsAnomalyDetail = isPlaysAnom
        ? {
            prevDate: anomPrevDate,
            prevValue: anomPrevVal,
            rawValue: anomRawVal,
            reason: anomReason,
          }
        : null;
      const playsAnomalyNote = isPlaysAnom
        ? `${anomReason}${
            anomPrevVal !== null && anomRawVal !== null
              ? `（${anomPrevDate ? `${anomPrevDate} ` : ""}${anomPrevVal}→${anomRawVal}，已排除播放日增）`
              : "（已排除播放日增）"
          }`
        : null;

      cleanedAccountRows.push({
        ...pt,
        plays: cleanedPlays,
        fansDelta: nextFansDelta,
        playsDelta: cleanedPlaysDelta,
        playsAnomaly: isPlaysAnom,
        playsAnomalyDetail,
        playsAnomalyNote,
      });
    }
  }

  accountPlaysAnomalies.sort((a, b) => {
    if (a.date !== b.date) return compareText(b.date, a.date);
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.group, b.group);
  });

  return { cleanedAccountRows, accountPlaysAnomalies };
}

/** 计算《账号日快照》各平台/账号在 [startDay, endDay] 区间内的首尾粉丝差合计 */
function computeAccountFansRangeDiff(accountRows, startDay, endDay) {
  const byAccount = new Map();
  for (const ar of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(ar)) continue;
    const dn =
      typeof ar.dayNum === "number" && Number.isInteger(ar.dayNum)
        ? ar.dayNum
        : typeof ar.date === "string"
        ? dateStrToDayNum(ar.date.trim())
        : null;
    if (dn === null || dn < startDay || dn > endDay) continue;
    const fans = fastNormalizeMetric(ar.fans);
    if (fans === null) continue;
    const platform = ar.platform == null ? "" : String(ar.platform).trim();
    if (!platform) continue;
    const group = ar.group == null ? "" : String(ar.group).trim();
    const key = `${platform}|${group}`;
    let rec = byAccount.get(key);
    if (!rec) {
      rec = {
        platform,
        group,
        firstDay: dn,
        firstFans: fans,
        lastDay: dn,
        lastFans: fans,
      };
      byAccount.set(key, rec);
    } else {
      if (dn < rec.firstDay || (dn === rec.firstDay && fans > rec.firstFans)) {
        rec.firstDay = dn;
        rec.firstFans = fans;
      }
      if (dn > rec.lastDay || (dn === rec.lastDay && fans > rec.lastFans)) {
        rec.lastDay = dn;
        rec.lastFans = fans;
      }
    }
  }

  let total = null;
  let accountCount = 0;
  const byPlatformMap = new Map();
  for (const rec of byAccount.values()) {
    if (rec.lastDay <= rec.firstDay) continue;
    const diff = normalizeZero(rec.lastFans - rec.firstFans);
    total = addNullable(total, diff);
    accountCount += 1;
    const prevPt = byPlatformMap.has(rec.platform) ? byPlatformMap.get(rec.platform) : null;
    byPlatformMap.set(rec.platform, addNullable(prevPt, diff));
  }
  const byPlatform = [...byPlatformMap.entries()]
    .sort((a, b) => comparePlatform(a[0], b[0]))
    .map(([platform, fansGrowth]) => ({ platform, fansGrowth }));

  return { total, accountCount, byPlatform };
}

/** 1. 总览：本周期 vs 上一周期的 6 项日增合计、环比%、实际覆盖天数、账号日快照涨粉主口径、各平台播放贡献占比与分日趋势 */
function buildOverviewSection(
  seriesByWork,
  accountRows,
  { currentStart, currentEnd, prevStart, prevEnd }
) {
  const curStartDay = dateStrToDayNum(currentStart);
  const curEndDay = dateStrToDayNum(currentEnd);
  const prevStartDay = dateStrToDayNum(prevStart);
  const prevEndDay = dateStrToDayNum(prevEnd);
  const periodDays = curEndDay - curStartDay + 1;
  const trendDates = new Array(periodDays);
  for (let d = 0; d < periodDays; d++) {
    trendDates[d] = dayNumToDateStr(curStartDay + d);
  }

  const curSums = {};
  const prevSums = {};
  for (const k of WORK_STAT_KEYS) {
    curSums[k] = null;
    prevSums[k] = null;
  }

  const byPlatform = new Map();
  const trendByPlatform = new Map();
  const coveredDayNums = new Set();

  for (const series of seriesByWork.values()) {
    const dayNums = series.dayNums;
    const len = series.len;
    const deltas = series.deltas;
    const vals = series.vals;
    let ptAgg = null;
    let ptTrend = null;

    for (let i = 0; i < len; i++) {
      const dn = dayNums[i];
      if (dn < prevStartDay) continue;
      if (dn > curEndDay) break;
      const inCur = dn >= curStartDay;
      const inPrev = !inCur && dn <= prevEndDay;
      if (!inCur && !inPrev) continue;

      if (inCur) {
        let hasValidWorkVal = false;
        for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
          if (vals[WORK_STAT_KEYS[ki]][i] !== null) {
            hasValidWorkVal = true;
            break;
          }
        }
        if (hasValidWorkVal) coveredDayNums.add(dn);

        if (!ptAgg) {
          ptAgg = byPlatform.get(series.platform);
          if (!ptAgg) {
            ptAgg = {
              platform: series.platform,
              play: null,
              like: null,
              comment: null,
              share: null,
              favorite: null,
              fansDelta: null,
            };
            byPlatform.set(series.platform, ptAgg);
          }
          ptTrend = trendByPlatform.get(series.platform);
          if (!ptTrend) {
            ptTrend = {
              platform: series.platform,
              play: new Array(periodDays).fill(null),
              like: new Array(periodDays).fill(null),
              comment: new Array(periodDays).fill(null),
              share: new Array(periodDays).fill(null),
              favorite: new Array(periodDays).fill(null),
              fansDelta: new Array(periodDays).fill(null),
            };
            trendByPlatform.set(series.platform, ptTrend);
          }
        }
        const dayIdx = dn - curStartDay;
        for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
          const k = WORK_STAT_KEYS[ki];
          const dv = deltas[k][i];
          if (dv !== null) {
            curSums[k] = curSums[k] === null ? dv : curSums[k] + dv;
            if (curSums[k] === 0) curSums[k] = 0;
            ptAgg[k] = ptAgg[k] === null ? dv : ptAgg[k] + dv;
            if (ptAgg[k] === 0) ptAgg[k] = 0;
            const prevDayVal = ptTrend[k][dayIdx];
            const nextDayVal = prevDayVal === null ? dv : prevDayVal + dv;
            ptTrend[k][dayIdx] = nextDayVal === 0 ? 0 : nextDayVal;
          }
        }
      } else {
        for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
          const k = WORK_STAT_KEYS[ki];
          const dv = deltas[k][i];
          if (dv !== null) {
            prevSums[k] = prevSums[k] === null ? dv : prevSums[k] + dv;
            if (prevSums[k] === 0) prevSums[k] = 0;
          }
        }
      }
    }
  }

  // 统计区间内作品日数据实际覆盖口径
  let coveredMinDay = Infinity;
  let coveredMaxDay = -Infinity;
  for (const dn of coveredDayNums) {
    if (dn < coveredMinDay) coveredMinDay = dn;
    if (dn > coveredMaxDay) coveredMaxDay = dn;
  }
  const coveredDays = coveredDayNums.size;
  const coveredFrom = coveredDays > 0 ? dayNumToDateStr(coveredMinDay) : null;
  const coveredTo = coveredDays > 0 ? dayNumToDateStr(coveredMaxDay) : null;
  const isPartial = coveredDays < periodDays;
  const rangeText =
    coveredDays > 0
      ? `统计区间 ${currentStart} ~ ${currentEnd}，其中作品日数据实际覆盖 ${coveredFrom} ~ ${coveredTo}（共 ${coveredDays} 天）`
      : `统计区间 ${currentStart} ~ ${currentEnd}，其中作品日数据实际覆盖暂无（共 0 天）`;
  const partialNotice = isPartial
    ? `实际覆盖 ${coveredDays} 天，少于统计区间 ${periodDays} 天，汇总与环比仅反映已采集天数。`
    : "";
  const coverage = {
    rangeFrom: currentStart,
    rangeTo: currentEnd,
    periodDays,
    coveredFrom,
    coveredTo,
    coveredDays,
    isPartial,
    rangeText,
    partialNotice,
  };

  const metrics = {};
  for (const k of WORK_STAT_KEYS) {
    metrics[k] = {
      key: k,
      label: METRIC_LABELS[k] || k,
      current: curSums[k],
      previous: prevSums[k],
      momPct: computeMomPct(curSums[k], prevSums[k]),
      source:
        k === "fansDelta"
          ? "单作品涨粉日增合计（辅助，仅含抖音/视频号等有单作品涨粉平台）"
          : "作品日明细日增合计",
    };
  }

  // 总览涨粉：优先用《账号日快照》各平台区间首尾粉丝差合计（覆盖快手等无单作品涨粉平台），单作品涨粉合计作为辅助行
  const curAccFansRange = computeAccountFansRangeDiff(accountRows, curStartDay, curEndDay);
  const prevAccFansRange = computeAccountFansRangeDiff(accountRows, prevStartDay, prevEndDay);
  const accountFansGrowth = {
    key: "accountFansGrowth",
    label: "涨粉（账号快照）",
    current: curAccFansRange.total,
    previous: prevAccFansRange.total,
    momPct: computeMomPct(curAccFansRange.total, prevAccFansRange.total),
    accountCount: curAccFansRange.accountCount,
    byPlatform: curAccFansRange.byPlatform,
    source: "账号日快照各平台区间首尾粉丝差合计（主口径，覆盖快手等全平台）",
    isPrimary: true,
  };
  const workFansGrowth = {
    key: "workFansDelta",
    label: "涨粉（单作品）",
    current: curSums.fansDelta,
    previous: prevSums.fansDelta,
    momPct: computeMomPct(curSums.fansDelta, prevSums.fansDelta),
    source: "单作品涨粉日增合计（辅助行，仅含抖音/视频号等有单作品涨粉字段的平台）",
    isAuxiliary: true,
  };
  const primaryFansGrowth =
    accountFansGrowth.current !== null ? accountFansGrowth : workFansGrowth;

  const metricRows = [
    metrics.play,
    metrics.like,
    metrics.comment,
    metrics.share,
    metrics.favorite,
    accountFansGrowth,
    workFansGrowth,
  ];

  // 各平台贡献占比（按本周期播放日增）
  const platformRows = [...byPlatform.values()];
  let totalPositivePlay = 0;
  let hasAnyPlatformPlay = false;
  for (const pr of platformRows) {
    if (typeof pr.play === "number" && Number.isFinite(pr.play)) {
      hasAnyPlatformPlay = true;
      if (pr.play > 0) totalPositivePlay += pr.play;
    }
  }

  const platformContribution = platformRows
    .map((pr) => {
      let sharePct = null;
      if (
        hasAnyPlatformPlay &&
        totalPositivePlay > 0 &&
        typeof pr.play === "number" &&
        Number.isFinite(pr.play)
      ) {
        sharePct = pr.play >= 0 ? round2((pr.play / totalPositivePlay) * 100) : 0;
      }
      return {
        platform: pr.platform,
        play: pr.play,
        sharePct,
        like: pr.like,
        comment: pr.comment,
        share: pr.share,
        favorite: pr.favorite,
        fansDelta: pr.fansDelta,
      };
    })
    .sort((a, b) => {
      const ap = a.play === null ? -Infinity : a.play;
      const bp = b.play === null ? -Infinity : b.play;
      if (bp !== ap) return bp - ap;
      return comparePlatform(a.platform, b.platform);
    });

  // 补充账号级日增（来自清洗后的 accountRows，已剔除 playsAnomaly）
  let accFansCur = null;
  let accFansPrev = null;
  let accPlaysCur = null;
  let accPlaysPrev = null;
  for (const ar of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(ar) || typeof ar.date !== "string") continue;
    const dn =
      typeof ar.dayNum === "number" && Number.isInteger(ar.dayNum)
        ? ar.dayNum
        : dateStrToDayNum(ar.date.trim());
    if (dn === null || dn > curEndDay) continue;
    const fd = fastNormalizeMetric(ar.fansDelta);
    const pd = ar.playsAnomaly ? null : fastNormalizeMetric(ar.playsDelta);
    if (dn >= curStartDay && dn <= curEndDay) {
      accFansCur = addNullable(accFansCur, fd);
      accPlaysCur = addNullable(accPlaysCur, pd);
    } else if (dn >= prevStartDay && dn <= prevEndDay) {
      accFansPrev = addNullable(accFansPrev, fd);
      accPlaysPrev = addNullable(accPlaysPrev, pd);
    }
  }

  const trendPlatforms = [...trendByPlatform.values()].sort((a, b) =>
    comparePlatform(a.platform, b.platform)
  );

  return {
    coverage,
    metrics,
    metricRows,
    accountFansGrowth,
    workFansGrowth,
    primaryFansGrowth,
    platformContribution,
    dailyTrend: {
      dates: trendDates,
      platforms: trendPlatforms,
    },
    accountSummary: {
      fansDelta: {
        current: accFansCur,
        previous: accFansPrev,
        momPct: computeMomPct(accFansCur, accFansPrev),
      },
      fansRangeDiff: {
        current: curAccFansRange.total,
        previous: prevAccFansRange.total,
        momPct: computeMomPct(curAccFansRange.total, prevAccFansRange.total),
      },
      playsDelta: {
        current: accPlaysCur,
        previous: accPlaysPrev,
        momPct: computeMomPct(accPlaysCur, accPlaysPrev),
      },
    },
  };
}

/**
 * 先按单作品判断是否 play > 0 再累计平台互动率分子/分母：
 * - 分母：该平台 play > 0 的全部作品播放（互动全缺按 0 计入分子，仍保留在分母）
 * - 零播放/空播放作品的互动绝不计入分子
 */
function accumulateWorkEngagement(agg, metrics) {
  if (!agg || !metrics) return;
  const play = hasOwn(metrics, "play") ? fastNormalizeMetric(metrics.play) : null;
  if (typeof play === "number" && Number.isFinite(play) && play > 0) {
    const like = hasOwn(metrics, "like") ? fastNormalizeMetric(metrics.like) : null;
    const comment = hasOwn(metrics, "comment") ? fastNormalizeMetric(metrics.comment) : null;
    const share = hasOwn(metrics, "share") ? fastNormalizeMetric(metrics.share) : null;
    const favorite = hasOwn(metrics, "favorite") ? fastNormalizeMetric(metrics.favorite) : null;
    agg.engPlaySum += play;
    agg.engInteraction4Sum += (like || 0) + (comment || 0) + (share || 0) + (favorite || 0);
    agg.engInteraction3Sum += (like || 0) + (comment || 0) + (share || 0);
    agg.engWorkCount += 1;
  }
}

function createEmptyPlatformAgg(platform) {
  return {
    platform,
    play: null,
    like: null,
    comment: null,
    share: null,
    favorite: null,
    fansDelta: null,
    engPlaySum: 0,
    engInteraction4Sum: 0,
    engInteraction3Sum: 0,
    engWorkCount: 0,
  };
}

function collectCellWorkPwKeys(platform, cell) {
  const pwKeys = [];
  const seen = new Set();
  if (Array.isArray(cell.workIds)) {
    for (const wid of cell.workIds) {
      if (wid != null && wid !== "") {
        const pwKey = `${platform}|${String(wid).trim()}`;
        if (!seen.has(pwKey)) {
          seen.add(pwKey);
          pwKeys.push(pwKey);
        }
      }
    }
  }
  if (Array.isArray(cell.works)) {
    for (const w of cell.works) {
      if (isPlainObject(w) && w.workId != null && w.workId !== "") {
        const p =
          typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
        const pwKey = `${p}|${String(w.workId).trim()}`;
        if (!seen.has(pwKey)) {
          seen.add(pwKey);
          pwKeys.push(pwKey);
        }
      }
    }
  }
  return pwKeys;
}

/**
 * 归一化内容级跨平台汇总行，提取每条内容的按平台汇总指标（同一平台多分组求和）。
 * 若 dailyRows 中存在采集掉 0 异常（含由截止日之后恢复快照确认的异常），
 * 使用剔除异常后的最新有效累计值（series.cleanedLatest）重算平台汇总与总计，
 * 确保第 2 节平台对比与第 3 节作品排行/偏科均不受掉 0 污染。
 */
function normalizeContentRows(summaryRows, cutoffTo, seriesByWork) {
  const hasSeries = seriesByWork instanceof Map && seriesByWork.size > 0;
  const hasSummaryRows = Array.isArray(summaryRows) && summaryRows.length > 0;

  // 若调用方仅传 dailyRows 未传 summaryRows，直接由清洗后作品序列合成内容级汇总行
  if (!hasSummaryRows) {
    if (!hasSeries) return [];
    const grouped = new Map();
    for (const series of seriesByWork.values()) {
      const ck = series.contentKey;
      let bucket = grouped.get(ck);
      if (!bucket) {
        bucket = {
          contentKey: ck,
          title: series.title || "(无标题)",
          isUnlinked: !series.rawContentKey && ck.startsWith("unlinked:"),
          firstPublishTimeMs: series.publishTimeMs,
          firstPublishDate: series.publishDate || "",
          byPlatform: new Map(),
        };
        grouped.set(ck, bucket);
      } else {
        if (
          series.publishTimeMs !== null &&
          (bucket.firstPublishTimeMs === null || series.publishTimeMs < bucket.firstPublishTimeMs)
        ) {
          bucket.firstPublishTimeMs = series.publishTimeMs;
          if (series.title && series.title !== "(无标题)") bucket.title = series.title;
        }
        if (
          series.publishDate &&
          (!bucket.firstPublishDate || series.publishDate < bucket.firstPublishDate)
        ) {
          bucket.firstPublishDate = series.publishDate;
        }
        if (bucket.title === "(无标题)" && series.title && series.title !== "(无标题)") {
          bucket.title = series.title;
        }
      }
      let agg = bucket.byPlatform.get(series.platform);
      if (!agg) {
        agg = createEmptyPlatformAgg(series.platform);
        bucket.byPlatform.set(series.platform, agg);
      }
      for (const k of WORK_STAT_KEYS) {
        agg[k] = addNullable(agg[k], series.cleanedLatest[k]);
      }
      accumulateWorkEngagement(agg, series.cleanedLatest);
    }

    const out = [];
    for (const b of grouped.values()) {
      if (b.firstPublishDate && b.firstPublishDate > cutoffTo) continue;
      const activePlatforms = [];
      let totalPlay = null;
      let totalLike = null;
      let totalComment = null;
      let totalShare = null;
      let totalFavorite = null;
      let totalFansDelta = null;
      for (const agg of b.byPlatform.values()) {
        if (WORK_STAT_KEYS.some((k) => agg[k] !== null)) {
          activePlatforms.push(agg);
          totalPlay = addNullable(totalPlay, agg.play);
          totalLike = addNullable(totalLike, agg.like);
          totalComment = addNullable(totalComment, agg.comment);
          totalShare = addNullable(totalShare, agg.share);
          totalFavorite = addNullable(totalFavorite, agg.favorite);
          totalFansDelta = addNullable(totalFansDelta, agg.fansDelta);
        }
      }
      activePlatforms.sort((a, bItem) => comparePlatform(a.platform, bItem.platform));
      out.push({
        contentKey: b.contentKey,
        title: b.title,
        file: "",
        firstPublishDate: b.firstPublishDate,
        firstPublishTimeMs: b.firstPublishTimeMs,
        isUnlinked: b.isUnlinked,
        platformCount: activePlatforms.length,
        platforms: activePlatforms,
        totalPlay,
        totalLike,
        totalComment,
        totalShare,
        totalFavorite,
        totalFansDelta,
      });
    }
    return out;
  }

  // 仅当存在异常作品时才可能需要按 (contentKey, platform) 兜底匹配无 workIds 的汇总行
  let anomalousByContentPlatform = null;
  if (hasSeries) {
    for (const s of seriesByWork.values()) {
      if (!s.hadAnomaly) continue;
      if (!anomalousByContentPlatform) anomalousByContentPlatform = new Map();
      const key = `${s.contentKey}\0${s.platform}`;
      let list = anomalousByContentPlatform.get(key);
      if (!list) {
        list = [];
        anomalousByContentPlatform.set(key, list);
      }
      list.push(s);
    }
  }

  const out = [];
  for (const row of summaryRows) {
    if (!isPlainObject(row) || !row.contentKey) continue;
    const ck = String(row.contentKey);

    // 解析已知最早发布时间（ms 与 date）
    let firstPublishTimeMs = parseTimestampMs(
      row.firstPublishTime !== undefined ? row.firstPublishTime : row.firstPublishTimeMs
    );
    let firstPublishDate =
      typeof row.firstPublishDate === "string" && isValidDateStr(row.firstPublishDate.trim())
        ? row.firstPublishDate.trim()
        : "";
    if (firstPublishTimeMs !== null) {
      const d = toUtc8DateStr(firstPublishTimeMs);
      if (d && (!firstPublishDate || d < firstPublishDate)) {
        firstPublishDate = d;
      }
    }

    const byPlatform = new Map();
    let recomputedAnyCell = false;

    if (isPlainObject(row.perPlatform)) {
      for (const [pgKey, cell] of Object.entries(row.perPlatform)) {
        if (!isPlainObject(cell)) continue;
        const { platform } = parsePgKey(pgKey);
        if (!platform) continue;

        // 顺带检查 perPlatform.works 中携带的发布时间
        if (Array.isArray(cell.works)) {
          for (const w of cell.works) {
            if (!isPlainObject(w)) continue;
            const wMs = parseTimestampMs(w.publishTime);
            if (wMs !== null && (firstPublishTimeMs === null || wMs < firstPublishTimeMs)) {
              const wd = toUtc8DateStr(wMs);
              if (!wd || wd <= cutoffTo) firstPublishTimeMs = wMs;
            }
            const wDate =
              typeof w.publishDate === "string" && isValidDateStr(w.publishDate.trim())
                ? w.publishDate.trim()
                : "";
            if (wDate && wDate <= cutoffTo && (!firstPublishDate || wDate < firstPublishDate)) {
              firstPublishDate = wDate;
            }
          }
        }

        let agg = byPlatform.get(platform);
        if (!agg) {
          agg = createEmptyPlatformAgg(platform);
          byPlatform.set(platform, agg);
        }

        const cellPwKeys = hasSeries ? collectCellWorkPwKeys(platform, cell) : [];
        let usedCleanedCell = false;
        let accumulatedWorkEng = false;
        if (cellPwKeys.length > 0) {
          let allFound = true;
          let anyAnom = false;
          for (let i = 0; i < cellPwKeys.length; i++) {
            const s = seriesByWork.get(cellPwKeys[i]);
            if (!s) {
              allFound = false;
              break;
            }
            if (s.hadAnomaly) anyAnom = true;
          }
          if (allFound) {
            for (let i = 0; i < cellPwKeys.length; i++) {
              accumulateWorkEngagement(agg, seriesByWork.get(cellPwKeys[i]).cleanedLatest);
            }
            accumulatedWorkEng = true;
          }
          if (allFound && anyAnom) {
            for (let i = 0; i < cellPwKeys.length; i++) {
              const cl = seriesByWork.get(cellPwKeys[i]).cleanedLatest;
              for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
                const k = WORK_STAT_KEYS[ki];
                agg[k] = addNullable(agg[k], cl[k]);
              }
            }
            usedCleanedCell = true;
            recomputedAnyCell = true;
          } else if (!allFound && Array.isArray(cell.works)) {
            let someAnom = false;
            for (const w of cell.works) {
              if (!isPlainObject(w) || w.workId == null) continue;
              const p =
                typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
              const s = seriesByWork.get(`${p}|${String(w.workId).trim()}`);
              if (s && s.hadAnomaly) {
                someAnom = true;
                break;
              }
            }
            if (someAnom) {
              for (const w of cell.works) {
                if (!isPlainObject(w)) continue;
                const p =
                  typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
                const s =
                  w.workId != null ? seriesByWork.get(`${p}|${String(w.workId).trim()}`) : null;
                const src = s ? s.cleanedLatest : w;
                for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
                  const k = WORK_STAT_KEYS[ki];
                  const v = hasOwn(src, k) ? fastNormalizeMetric(src[k]) : null;
                  agg[k] = addNullable(agg[k], v);
                }
                accumulateWorkEngagement(agg, src);
              }
              accumulatedWorkEng = true;
              usedCleanedCell = true;
              recomputedAnyCell = true;
            }
          }
        } else if (anomalousByContentPlatform) {
          const matchedAnom = anomalousByContentPlatform.get(`${ck}\0${platform}`);
          if (matchedAnom && matchedAnom.length > 0) {
            for (const s of matchedAnom) {
              for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
                const k = WORK_STAT_KEYS[ki];
                agg[k] = addNullable(agg[k], s.cleanedLatest[k]);
              }
              accumulateWorkEngagement(agg, s.cleanedLatest);
            }
            accumulatedWorkEng = true;
            usedCleanedCell = true;
            recomputedAnyCell = true;
          }
        }

        if (!usedCleanedCell) {
          for (let ki = 0; ki < WORK_STAT_KEYS.length; ki++) {
            const k = WORK_STAT_KEYS[ki];
            const v = hasOwn(cell, k) ? fastNormalizeMetric(cell[k]) : null;
            agg[k] = addNullable(agg[k], v);
          }
        }
        if (!accumulatedWorkEng) {
          const hasPerWorkMetrics =
            Array.isArray(cell.works) &&
            cell.works.length > 0 &&
            cell.works.some((w) => isPlainObject(w) && WORK_STAT_KEYS.some((k) => hasOwn(w, k)));
          if (hasPerWorkMetrics) {
            for (const w of cell.works) {
              if (!isPlainObject(w)) continue;
              const p =
                typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
              const s =
                hasSeries && w.workId != null
                  ? seriesByWork.get(`${p}|${String(w.workId).trim()}`)
                  : null;
              accumulateWorkEngagement(agg, s ? s.cleanedLatest : w);
            }
          } else {
            accumulateWorkEngagement(agg, cell);
          }
        }
      }
    }

    if (firstPublishTimeMs !== null) {
      const d = toUtc8DateStr(firstPublishTimeMs);
      if (d && (!firstPublishDate || d < firstPublishDate)) {
        firstPublishDate = d;
      }
    }
    if (firstPublishDate && firstPublishDate > cutoffTo) continue;

    // 仅保留至少有一项非空指标的平台
    const activePlatforms = [];
    for (const agg of byPlatform.values()) {
      const hasAny = WORK_STAT_KEYS.some((k) => agg[k] !== null);
      if (hasAny) activePlatforms.push(agg);
    }
    activePlatforms.sort((a, b) => comparePlatform(a.platform, b.platform));

    let totalPlay;
    let totalLike;
    let totalComment;
    let totalShare;
    let totalFavorite;
    let totalFansDelta;

    if (recomputedAnyCell) {
      totalPlay = null;
      totalLike = null;
      totalComment = null;
      totalShare = null;
      totalFavorite = null;
      totalFansDelta = null;
      for (const agg of activePlatforms) {
        totalPlay = addNullable(totalPlay, agg.play);
        totalLike = addNullable(totalLike, agg.like);
        totalComment = addNullable(totalComment, agg.comment);
        totalShare = addNullable(totalShare, agg.share);
        totalFavorite = addNullable(totalFavorite, agg.favorite);
        totalFansDelta = addNullable(totalFansDelta, agg.fansDelta);
      }
    } else {
      totalPlay = hasOwn(row, "totalPlay") ? fastNormalizeMetric(row.totalPlay) : null;
      totalLike = hasOwn(row, "totalLike") ? fastNormalizeMetric(row.totalLike) : null;
      totalComment = hasOwn(row, "totalComment") ? fastNormalizeMetric(row.totalComment) : null;
      totalShare = hasOwn(row, "totalShare") ? fastNormalizeMetric(row.totalShare) : null;
      totalFavorite = hasOwn(row, "totalFavorite") ? fastNormalizeMetric(row.totalFavorite) : null;
      totalFansDelta = hasOwn(row, "totalFansDelta")
        ? fastNormalizeMetric(row.totalFansDelta)
        : null;
    }

    out.push({
      contentKey: ck,
      title: typeof row.title === "string" && row.title ? row.title : "(无标题)",
      file: typeof row.file === "string" ? row.file : "",
      firstPublishDate,
      firstPublishTimeMs,
      isUnlinked: Boolean(row.isUnlinked || ck.startsWith("unlinked:")),
      platformCount: activePlatforms.length,
      platforms: activePlatforms,
      totalPlay,
      totalLike,
      totalComment,
      totalShare,
      totalFavorite,
      totalFansDelta,
    });
  }
  return out;
}

function computeItemEngagementRate(play, like, comment, share, favorite = null) {
  if (typeof play !== "number" || !Number.isFinite(play) || play <= 0) return null;
  const hasAnyInteraction =
    like !== null || comment !== null || share !== null || favorite !== null;
  if (!hasAnyInteraction) return null;
  const interactions = (like || 0) + (comment || 0) + (share || 0) + (favorite || 0);
  return interactions / play;
}

function computeItemEngagementRate3(play, like, comment, share) {
  if (typeof play !== "number" || !Number.isFinite(play) || play <= 0) return null;
  const hasAnyInteraction = like !== null || comment !== null || share !== null;
  if (!hasAnyInteraction) return null;
  const interactions = (like || 0) + (comment || 0) + (share || 0);
  return interactions / play;
}

/** 判断两个平台的均播是否接近（相对差值严格 <5% 视为并列） */
function isAvgPlayClose(a, b) {
  if (
    typeof a !== "number" ||
    !Number.isFinite(a) ||
    typeof b !== "number" ||
    !Number.isFinite(b)
  ) {
    return false;
  }
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi <= 0) return hi === lo;
  return hi - lo < hi * PLATFORM_PLAY_CLOSE_DIFF_RATIO;
}

/** 2. 平台对比：只取覆盖 ≥2 平台的内容；平台互动率改加权（含收藏四项 + 不含收藏三项对比） */
function buildPlatformComparisonSection(contentRows) {
  const multiPlatformContents = contentRows.filter(
    (c) => !c.isUnlinked && c.platformCount >= MIN_PLATFORM_COMPARE_PLATFORMS
  );

  const statsByPlatform = new Map();
  for (const c of multiPlatformContents) {
    for (const p of c.platforms) {
      let bucket = statsByPlatform.get(p.platform);
      if (!bucket) {
        bucket = {
          platform: p.platform,
          sampleCount: 0,
          playSum: 0,
          playCount: 0,
          engPlaySum: 0,
          engInteractionSum: 0,
          engRateCount: 0,
          eng3PlaySum: 0,
          eng3InteractionSum: 0,
          eng3RateCount: 0,
          fansSum: 0,
          fansCount: 0,
        };
        statsByPlatform.set(p.platform, bucket);
      }
      bucket.sampleCount += 1;
      if (p.play !== null) {
        bucket.playSum += p.play;
        bucket.playCount += 1;
      }
      // 平台级加权互动率：分母 = 该平台 play > 0 的全部作品播放（互动缺失按 0 计），
      // 先按作品判断 play > 0 再合并，零播放作品的互动不计入。
      if (typeof p.engPlaySum === "number" && Number.isFinite(p.engPlaySum) && p.engPlaySum > 0) {
        bucket.engPlaySum += p.engPlaySum;
        bucket.engInteractionSum += p.engInteraction4Sum || 0;
        bucket.engRateCount += p.engWorkCount || 1;
        bucket.eng3PlaySum += p.engPlaySum;
        bucket.eng3InteractionSum += p.engInteraction3Sum || 0;
        bucket.eng3RateCount += p.engWorkCount || 1;
      }
      if (p.fansDelta !== null) {
        bucket.fansSum += p.fansDelta;
        bucket.fansCount += 1;
      }
    }
  }

  const enrichedPlatforms = [...statsByPlatform.values()]
    .map((b) => {
      const rawAvgPlay = b.playCount > 0 ? b.playSum / b.playCount : null;
      const rawEngagementRate =
        b.engPlaySum > 0 ? b.engInteractionSum / b.engPlaySum : null;
      const rawEngagementRate3 =
        b.eng3PlaySum > 0 ? b.eng3InteractionSum / b.eng3PlaySum : null;
      const rawAvgFansDelta = b.fansCount > 0 ? b.fansSum / b.fansCount : null;
      const avgPlay = rawAvgPlay !== null ? round2(rawAvgPlay) : null;
      const engagementRate = rawEngagementRate !== null ? round4(rawEngagementRate) : null;
      const engagementRatePct =
        rawEngagementRate !== null ? round2(rawEngagementRate * 100) : null;
      const engagementRate3 = rawEngagementRate3 !== null ? round4(rawEngagementRate3) : null;
      const engagementRate3Pct =
        rawEngagementRate3 !== null ? round2(rawEngagementRate3 * 100) : null;
      const avgFansDelta = rawAvgFansDelta !== null ? round2(rawAvgFansDelta) : null;
      const lowSample = b.sampleCount < LOW_SAMPLE_THRESHOLD;
      const missingFields = PLATFORM_MISSING_INTERACTION_FIELDS[b.platform]
        ? [...PLATFORM_MISSING_INTERACTION_FIELDS[b.platform]]
        : [];
      const missingFieldsNote = missingFields.length
        ? `缺${missingFields.join("、")}（按0计）`
        : "";
      const note = [lowSample ? "样本少，仅供参考" : "", missingFieldsNote]
        .filter(Boolean)
        .join("；");
      return {
        platform: b.platform,
        sampleCount: b.sampleCount,
        avgPlay,
        engagementRate,
        engagementRatePct,
        engagementRate3,
        engagementRate3Pct,
        engagementSampleCount: b.engRateCount,
        engagement3SampleCount: b.eng3RateCount,
        avgFansDelta,
        lowSample,
        missingFields,
        missingFieldsNote,
        note,
        _rawAvgPlay: rawAvgPlay,
        _rawEngagementRate: rawEngagementRate,
        _rawAvgFansDelta: rawAvgFansDelta,
      };
    })
    .sort((a, b) => {
      const ap = a._rawAvgPlay === null ? -Infinity : a._rawAvgPlay;
      const bp = b._rawAvgPlay === null ? -Infinity : b._rawAvgPlay;
      if (bp !== ap) return bp - ap;
      return comparePlatform(a.platform, b.platform);
    });

  // 规则生成 1–3 句中文结论（按原始比率排序，均播相差 <5% 视为播放接近）
  const conclusions = [];
  if (multiPlatformContents.length === 0 || enrichedPlatforms.length < 2) {
    conclusions.push("暂无覆盖 2 个及以上平台的同款内容，无法进行跨平台对比。");
  } else {
    const withPlay = enrichedPlatforms.filter((p) => p._rawAvgPlay !== null);
    const withEng = [...enrichedPlatforms]
      .filter((p) => p._rawEngagementRate !== null)
      .sort((a, b) => {
        if (b._rawEngagementRate !== a._rawEngagementRate) {
          return b._rawEngagementRate - a._rawEngagementRate;
        }
        return comparePlatform(a.platform, b.platform);
      });
    const withFans = [...enrichedPlatforms]
      .filter((p) => p._rawAvgFansDelta !== null)
      .sort((a, b) => {
        if (b._rawAvgFansDelta !== a._rawAvgFansDelta) {
          return b._rawAvgFansDelta - a._rawAvgFansDelta;
        }
        return comparePlatform(a.platform, b.platform);
      });

    const topPlay = withPlay[0] || null;
    const lowestPlay = withPlay.length >= 2 ? withPlay[withPlay.length - 1] : null;
    const topEng = withEng[0] || null;
    const topFans = withFans[0] || null;
    let firstMentionsClose = false;

    // 句 1：播放与互动率对比（均播相差 <5% 视为并列，写「播放接近」）
    if (topPlay && topEng && topPlay.platform !== topEng.platform) {
      if (
        topEng._rawAvgPlay !== null &&
        isAvgPlayClose(topPlay._rawAvgPlay, topEng._rawAvgPlay)
      ) {
        firstMentionsClose = true;
        conclusions.push(
          `${topEng.platform}与${topPlay.platform}播放接近（均播 ${formatIntText(
            topEng.avgPlay
          )} vs ${formatIntText(topPlay.avgPlay)}），且${topEng.platform}互动率最高（${formatPctFromRate(
            topEng._rawEngagementRate
          )}）。`
        );
      } else if (topEng._rawAvgPlay !== null) {
        conclusions.push(
          `${topEng.platform}播放低于${topPlay.platform}（均播 ${formatIntText(
            topEng.avgPlay
          )} vs ${formatIntText(topPlay.avgPlay)}），但互动率最高（${formatPctFromRate(
            topEng._rawEngagementRate
          )}）。`
        );
      } else {
        conclusions.push(
          `${topPlay.platform}平均播放最高（${formatIntText(
            topPlay.avgPlay
          )}），${topEng.platform}互动率最高（${formatPctFromRate(
            topEng._rawEngagementRate
          )}）。`
        );
      }
    } else if (topPlay && topEng) {
      const tiedWithTopPlay = withPlay.filter((p) =>
        isAvgPlayClose(topPlay._rawAvgPlay, p._rawAvgPlay)
      );
      if (tiedWithTopPlay.length >= 2) {
        firstMentionsClose = true;
        const names = tiedWithTopPlay.map((p) => p.platform).join("与");
        const valsText = tiedWithTopPlay.map((p) => formatIntText(p.avgPlay)).join(" vs ");
        conclusions.push(
          `${names}播放接近（均播 ${valsText}），其中${topEng.platform}互动率最高（${formatPctFromRate(
            topEng._rawEngagementRate
          )}）。`
        );
      } else {
        conclusions.push(
          `${topPlay.platform}综合表现领先，平均播放（${formatIntText(
            topPlay.avgPlay
          )}）与互动率（${formatPctFromRate(topEng._rawEngagementRate)}）均居各平台首位。`
        );
      }
    } else if (topPlay) {
      const tiedWithTopPlay = withPlay.filter((p) =>
        isAvgPlayClose(topPlay._rawAvgPlay, p._rawAvgPlay)
      );
      if (tiedWithTopPlay.length >= 2) {
        firstMentionsClose = true;
        const names = tiedWithTopPlay.map((p) => p.platform).join("与");
        const valsText = tiedWithTopPlay.map((p) => formatIntText(p.avgPlay)).join(" vs ");
        conclusions.push(`${names}播放接近（均播 ${valsText}）。`);
      } else {
        conclusions.push(`${topPlay.platform}平均播放最高（${formatIntText(topPlay.avgPlay)}）。`);
      }
    } else if (topEng) {
      conclusions.push(
        `${topEng.platform}互动率最高（${formatPctFromRate(topEng._rawEngagementRate)}）。`
      );
    }

    // 句 2：涨粉或高低播差距
    if (topFans && topFans._rawAvgFansDelta > 0) {
      conclusions.push(
        `涨粉效率方面，${topFans.platform}表现最佳，单内容平均涨粉 ${round2(
          topFans._rawAvgFansDelta
        )}。`
      );
    } else if (
      topPlay &&
      lowestPlay &&
      topPlay.platform !== lowestPlay.platform &&
      lowestPlay._rawAvgPlay > 0
    ) {
      if (isAvgPlayClose(topPlay._rawAvgPlay, lowestPlay._rawAvgPlay)) {
        if (!firstMentionsClose) {
          conclusions.push(
            `各平台播放接近（均播 ${formatIntText(lowestPlay.avgPlay)} ~ ${formatIntText(
              topPlay.avgPlay
            )}，基于 ${multiPlatformContents.length} 条跨平台同款内容）。`
          );
        }
      } else {
        const ratio = round2(topPlay._rawAvgPlay / lowestPlay._rawAvgPlay);
        conclusions.push(
          `${topPlay.platform}平均播放约为${lowestPlay.platform}的 ${ratio} 倍（基于 ${multiPlatformContents.length} 条跨平台同款内容）。`
        );
      }
    }

    // 句 3：低样本提示
    const lowPlatforms = enrichedPlatforms.filter((p) => p.lowSample).map((p) => p.platform);
    if (lowPlatforms.length > 0 || multiPlatformContents.length < LOW_SAMPLE_THRESHOLD) {
      const scope =
        lowPlatforms.length === enrichedPlatforms.length ? "各平台" : lowPlatforms.join("、");
      conclusions.push(`${scope}跨平台对比样本不足 ${LOW_SAMPLE_THRESHOLD} 条，样本少，仅供参考。`);
    }
  }

  const platforms = enrichedPlatforms.map((p) => ({
    platform: p.platform,
    sampleCount: p.sampleCount,
    avgPlay: p.avgPlay,
    engagementRate: p.engagementRate,
    engagementRatePct: p.engagementRatePct,
    engagementRate3: p.engagementRate3,
    engagementRate3Pct: p.engagementRate3Pct,
    engagementSampleCount: p.engagementSampleCount,
    engagement3SampleCount: p.engagement3SampleCount,
    avgFansDelta: p.avgFansDelta,
    lowSample: p.lowSample,
    missingFields: p.missingFields,
    missingFieldsNote: p.missingFieldsNote,
    note: p.note,
  }));

  return {
    multiPlatformContentCount: multiPlatformContents.length,
    lowSample:
      multiPlatformContents.length < LOW_SAMPLE_THRESHOLD ||
      platforms.some((p) => p.lowSample),
    platforms,
    conclusions: conclusions.slice(0, 3),
  };
}

/** 3. 作品排行（总播放 / 互动率[总播放>=100，计入收藏] / 总涨粉 各 Top10 & Bottom10）+ 平台偏科 */
function buildRankingsSection(contentRows) {
  const enriched = contentRows.map((c) => {
    const rawEng = computeItemEngagementRate(
      c.totalPlay,
      c.totalLike,
      c.totalComment,
      c.totalShare,
      c.totalFavorite
    );
    const rawEng3 = computeItemEngagementRate3(
      c.totalPlay,
      c.totalLike,
      c.totalComment,
      c.totalShare
    );
    const engagementEligible =
      c.totalPlay !== null && c.totalPlay >= ENGAGEMENT_MIN_PLAY && rawEng !== null;
    return {
      contentKey: c.contentKey,
      title: c.title,
      firstPublishDate: c.firstPublishDate,
      platformCount: c.platformCount,
      isUnlinked: c.isUnlinked,
      totalPlay: c.totalPlay,
      totalLike: c.totalLike,
      totalComment: c.totalComment,
      totalShare: c.totalShare,
      totalFavorite: c.totalFavorite,
      totalFansDelta: c.totalFansDelta,
      rawEngagementRate: rawEng,
      rawEngagementRate3: rawEng3,
      engagementEligible,
      platforms: c.platforms,
    };
  });

  // 排序使用原始比率，输出时再做四舍五入；附按平台明细供 Top10 堆叠图使用
  const toRankItem = (item) => ({
    contentKey: item.contentKey,
    title: item.title,
    firstPublishDate: item.firstPublishDate,
    platformCount: item.platformCount,
    totalPlay: item.totalPlay,
    engagementRate: item.rawEngagementRate !== null ? round4(item.rawEngagementRate) : null,
    engagementRatePct:
      item.rawEngagementRate !== null ? round2(item.rawEngagementRate * 100) : null,
    engagementRate3: item.rawEngagementRate3 !== null ? round4(item.rawEngagementRate3) : null,
    engagementRate3Pct:
      item.rawEngagementRate3 !== null ? round2(item.rawEngagementRate3 * 100) : null,
    totalFansDelta: item.totalFansDelta,
    platforms: (Array.isArray(item.platforms) ? item.platforms : []).map((p) => {
      const pRate = computeItemEngagementRate(
        p.play,
        p.like,
        p.comment,
        p.share,
        p.favorite
      );
      const hasInt =
        p.like !== null || p.comment !== null || p.share !== null || p.favorite !== null;
      const interactions = hasInt
        ? (p.like || 0) + (p.comment || 0) + (p.share || 0) + (p.favorite || 0)
        : null;
      const rawEngagementContribPct =
        item.totalPlay !== null && item.totalPlay > 0 && interactions !== null
          ? normalizeZero((interactions / item.totalPlay) * 100)
          : null;
      const engagementContribPct =
        rawEngagementContribPct !== null ? round2(rawEngagementContribPct) : null;
      return {
        platform: p.platform,
        play: p.play,
        like: p.like,
        comment: p.comment,
        share: p.share,
        favorite: p.favorite,
        fansDelta: p.fansDelta,
        engagementRatePct: pRate !== null ? round2(pRate * 100) : null,
        engagementContribPct,
        rawEngagementContribPct,
      };
    }),
  });

  const playEligible = enriched.filter((x) => x.totalPlay !== null);
  const byPlayTop = [...playEligible]
    .sort((a, b) => {
      if (b.totalPlay !== a.totalPlay) return b.totalPlay - a.totalPlay;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);
  const byPlayBottom = [...playEligible]
    .sort((a, b) => {
      if (a.totalPlay !== b.totalPlay) return a.totalPlay - b.totalPlay;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);

  const engEligible = enriched.filter((x) => x.engagementEligible);
  const byEngTop = [...engEligible]
    .sort((a, b) => {
      if (b.rawEngagementRate !== a.rawEngagementRate) {
        return b.rawEngagementRate - a.rawEngagementRate;
      }
      if (b.totalPlay !== a.totalPlay) return b.totalPlay - a.totalPlay;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);
  const byEngBottom = [...engEligible]
    .sort((a, b) => {
      if (a.rawEngagementRate !== b.rawEngagementRate) {
        return a.rawEngagementRate - b.rawEngagementRate;
      }
      if (b.totalPlay !== a.totalPlay) return b.totalPlay - a.totalPlay;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);

  const fansEligible = enriched.filter((x) => x.totalFansDelta !== null);
  const byFansTop = [...fansEligible]
    .sort((a, b) => {
      if (b.totalFansDelta !== a.totalFansDelta) {
        return b.totalFansDelta - a.totalFansDelta;
      }
      const ap = a.totalPlay === null ? -Infinity : a.totalPlay;
      const bp = b.totalPlay === null ? -Infinity : b.totalPlay;
      if (bp !== ap) return bp - ap;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);
  const byFansBottom = [...fansEligible]
    .sort((a, b) => {
      if (a.totalFansDelta !== b.totalFansDelta) {
        return a.totalFansDelta - b.totalFansDelta;
      }
      const ap = a.totalPlay === null ? -Infinity : a.totalPlay;
      const bp = b.totalPlay === null ? -Infinity : b.totalPlay;
      if (bp !== ap) return bp - ap;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);

  // 平台偏科：同一内容某平台播放 >= 其它平台平均 * PLATFORM_SKEW_RATIO 且 >= PLATFORM_SKEW_MIN_PLAY
  const platformSkew = [];
  for (const c of contentRows) {
    const withPlay = c.platforms.filter((p) => p.play !== null && p.play >= 0);
    if (withPlay.length < 2) continue;
    const totalPlay = withPlay.reduce((sum, p) => sum + p.play, 0);
    const otherCount = withPlay.length - 1;
    for (const p of withPlay) {
      if (p.play < PLATFORM_SKEW_MIN_PLAY) continue;
      const otherSum = totalPlay - p.play;
      // 整数安全交叉乘法：避免 3 * (sum / count) 浮点误差
      if (p.play * otherCount >= otherSum * PLATFORM_SKEW_RATIO) {
        const otherAvg = otherSum / otherCount;
        platformSkew.push({
          contentKey: c.contentKey,
          title: c.title,
          firstPublishDate: c.firstPublishDate,
          platform: p.platform,
          platformPlay: p.play,
          otherAvgPlay: round2(otherAvg),
          ratio: otherAvg > 0 ? round2(p.play / otherAvg) : null,
          otherPlatforms: withPlay
            .filter((o) => o.platform !== p.platform)
            .map((o) => ({ platform: o.platform, play: o.play })),
        });
      }
    }
  }

  platformSkew.sort((a, b) => {
    const ar = a.ratio === null ? Infinity : a.ratio;
    const br = b.ratio === null ? Infinity : b.ratio;
    if (br !== ar) return br - ar;
    if (b.platformPlay !== a.platformPlay) return b.platformPlay - a.platformPlay;
    const kc = compareText(a.contentKey, b.contentKey);
    if (kc !== 0) return kc;
    return comparePlatform(a.platform, b.platform);
  });

  return {
    byPlay: { top: byPlayTop, bottom: byPlayBottom, eligibleCount: playEligible.length },
    byEngagement: {
      top: byEngTop,
      bottom: byEngBottom,
      eligibleCount: engEligible.length,
    },
    byFans: { top: byFansTop, bottom: byFansBottom, eligibleCount: fansEligible.length },
    platformSkew,
  };
}

/** 取某作品在 <= targetDayNum（且 >= minDayNum，可选）的最近一次非异常播放累计值 */
function resolveWorkPlayAsOfDay(series, targetDayNum, minDayNum) {
  const dayNums = series.dayNums;
  const playExcluded = series.playExcluded;
  const playVals = series.vals.play;
  const len = series.len;
  // 二分定位最后一个 <= targetDayNum 的下标
  let lo = 0;
  let hi = len - 1;
  let upper = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dayNums[mid] <= targetDayNum) {
      upper = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = upper; i >= 0; i--) {
    if (minDayNum !== null && dayNums[i] < minDayNum) break;
    if (playExcluded[i]) continue;
    const v = playVals[i];
    if (v !== null) return v;
  }
  return null;
}

/** 走势分类：长尾型 / 爆发后平稳 / 数据不足 / 其它 */
function classifyTrajectory(d1, d3, d7) {
  if (d3 !== null && d3 > 0 && d7 !== null) {
    // D7 / D3 >= 1.5（3/2，无浮点精度问题）
    if (d7 * 2 >= d3 * 3) {
      return "长尾型";
    }
  }
  if (d1 === null || d1 <= 0 || d3 === null || d3 <= 0 || d7 === null) {
    return "数据不足";
  }
  // D3 / D1 < 1.3 且 D7 / D3 < 1.1（整数安全交叉乘法）
  if (d3 * 10 < d1 * 13 && d7 * 10 < d3 * 11) {
    return "爆发后平稳";
  }
  return "其它";
}

/**
 * 第 4 节（新作品走势）与第 5 节（发布时间）共用的「按作品发布日期计算里程碑」索引。
 * 每条作品按自身发布日期计算 D1/D3/D7 与截至 to 的最新累计播放，再分别汇总到平台/内容/时段，
 * 保证两节口径完全一致。
 */
function buildWorkMilestoneIndex(seriesByWork, contentMetaByKey, cutoffTo) {
  const cutoffDayNum = dateStrToDayNum(cutoffTo);
  const byWork = new Map();
  const worksByContent = new Map();

  for (const series of seriesByWork.values()) {
    const ck = series.contentKey;
    const meta = contentMetaByKey.get(ck) || null;
    const wPubDate = series.publishDate || (meta && meta.firstPublishDate) || "";
    const wPubDayNum = wPubDate ? dateStrToDayNum(wPubDate) : null;

    const reached = { 1: false, 3: false, 7: false };
    const milestones = { 1: null, 3: null, 7: null };
    let latestPlay = null;
    let d7OrLatest = null;
    let usedFallback = false;

    if (wPubDayNum !== null && wPubDayNum <= cutoffDayNum) {
      for (const dayN of NEW_WORK_MILESTONES) {
        const targetDay = wPubDayNum + dayN;
        if (targetDay <= cutoffDayNum) {
          reached[dayN] = true;
          milestones[dayN] = resolveWorkPlayAsOfDay(series, targetDay, wPubDayNum);
        }
      }
      latestPlay = resolveWorkPlayAsOfDay(series, cutoffDayNum, wPubDayNum);
      if (reached[7]) {
        d7OrLatest = milestones[7];
      } else if (latestPlay !== null) {
        d7OrLatest = latestPlay;
        usedFallback = true;
      }
    }

    const entry = {
      series,
      contentKey: ck,
      platform: series.platform,
      publishDate: wPubDate,
      publishDayNum: wPubDayNum,
      reached,
      milestones,
      latestPlay,
      d7OrLatest,
      usedFallback,
      hasAllMilestones:
        milestones[1] !== null && milestones[3] !== null && milestones[7] !== null,
    };
    byWork.set(series.pwKey, entry);

    let arr = worksByContent.get(ck);
    if (!arr) {
      arr = [];
      worksByContent.set(ck, arr);
    }
    arr.push(entry);
  }

  return { byWork, worksByContent };
}

function minNonEmptyDate(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return a <= b ? a : b;
}

function computeMilestoneRatios(d1, d3, d7) {
  return {
    d3ToD1: d1 !== null && d1 > 0 && d3 !== null ? round2(d3 / d1) : null,
    d7ToD3: d3 !== null && d3 > 0 && d7 !== null ? round2(d7 / d3) : null,
  };
}

/** 4. 新作品走势（本周期发布内容，按作品发布日期计算 D1/D3/D7 再汇总到平台与内容；同行倍数按同行累计值计算，分类仅用三里程碑均有值的可比样本并标明分类依据） */
function buildNewWorksSection(contentMetaByKey, worksByContent, { currentStart, to }) {
  const allKeys = new Set([...contentMetaByKey.keys(), ...worksByContent.keys()]);
  const items = [];
  const categoryCounts = {
    长尾型: 0,
    爆发后平稳: 0,
    数据不足: 0,
    其它: 0,
  };

  for (const contentKey of allKeys) {
    const meta = contentMetaByKey.get(contentKey) || null;
    const workEntries = worksByContent.get(contentKey) || [];

    // 内容首发日取 S6 关联结果中最早已知发布日期（含无快照作品元数据、发布记录）与快照作品发布日期的最小值，补发不算新作品
    let minWorkPubDate = "";
    for (const we of workEntries) {
      if (we.publishDate) minWorkPubDate = minNonEmptyDate(minWorkPubDate, we.publishDate);
    }
    const contentPubDate = minNonEmptyDate(meta && meta.firstPublishDate, minWorkPubDate);
    if (!contentPubDate || contentPubDate < currentStart || contentPubDate > to) {
      continue;
    }

    // 过滤出发布日 <= to 的作品条目，按平台分组
    const eligibleEntries = workEntries.filter(
      (we) => !we.publishDate || we.publishDate <= to
    );
    const worksByPlatform = new Map();
    for (const we of eligibleEntries) {
      let arr = worksByPlatform.get(we.platform);
      if (!arr) {
        arr = [];
        worksByPlatform.set(we.platform, arr);
      }
      arr.push(we);
    }

    const platformRows = [];
    const platformComparable = new Map();
    const sortedPlatforms = [...worksByPlatform.keys()].sort(comparePlatform);

    for (const platform of sortedPlatforms) {
      const pEntries = worksByPlatform.get(platform);
      let pPubDate = "";
      for (const we of pEntries) {
        if (we.publishDate) pPubDate = minNonEmptyDate(pPubDate, we.publishDate);
      }
      if (!pPubDate) pPubDate = contentPubDate;

      // 平台级 D1/D3/D7：共用每条作品按自身发布日算出的里程碑再求和；仅当该平台所有作品均到达第 N 天时输出
      const milestoneVals = {};
      for (const dayN of NEW_WORK_MILESTONES) {
        const allReached = pEntries.every((we) => we.reached[dayN]);
        if (!allReached) {
          milestoneVals[dayN] = null;
          continue;
        }
        let sum = null;
        for (const we of pEntries) {
          sum = addNullable(sum, we.milestones[dayN]);
        }
        milestoneVals[dayN] = sum;
      }

      let latestPlay = null;
      for (const we of pEntries) {
        latestPlay = addNullable(latestPlay, we.latestPlay);
      }

      // 同行倍数严格按同一行显示的 D1/D3/D7 累计值计算
      const { d3ToD1, d7ToD3 } = computeMilestoneRatios(
        milestoneVals[1],
        milestoneVals[3],
        milestoneVals[7]
      );

      // 平台内可比作品（D1/D3/D7 三个里程碑均有值），仅用于走势分类与分类依据
      const compWorks = pEntries.filter((we) => we.hasAllMilestones);
      let category = "数据不足";
      let comparableD1Play = null;
      let comparableD3Play = null;
      let comparableD7Play = null;
      let comparableD3ToD1 = null;
      let comparableD7ToD3 = null;
      let classificationBasis = "";

      if (compWorks.length > 0) {
        let cD1 = 0;
        let cD3 = 0;
        let cD7 = 0;
        for (const we of compWorks) {
          cD1 += we.milestones[1];
          cD3 += we.milestones[3];
          cD7 += we.milestones[7];
        }
        comparableD1Play = cD1;
        comparableD3Play = cD3;
        comparableD7Play = cD7;
        comparableD3ToD1 = cD1 > 0 ? round2(cD3 / cD1) : null;
        comparableD7ToD3 = cD3 > 0 ? round2(cD7 / cD3) : null;
        category = classifyTrajectory(cD1, cD3, cD7);
        const basisLabel =
          compWorks.length === pEntries.length
            ? platform
            : `${platform}（${compWorks.length}/${pEntries.length}条）`;
        if (category !== "数据不足") {
          classificationBasis = basisLabel;
        }
        platformComparable.set(platform, {
          d1: cD1,
          d3: cD3,
          d7: cD7,
          basisLabel,
          comparableWorkCount: compWorks.length,
          totalWorkCount: pEntries.length,
        });
      }

      platformRows.push({
        platform,
        publishDate: pPubDate,
        d1Play: milestoneVals[1],
        d3Play: milestoneVals[3],
        d7Play: milestoneVals[7],
        latestPlay,
        d3ToD1,
        d7ToD3,
        category,
        comparableWorkCount: compWorks.length,
        totalWorkCount: pEntries.length,
        comparableD1Play,
        comparableD3Play,
        comparableD7Play,
        comparableD3ToD1,
        comparableD7ToD3,
        classificationBasis,
      });
    }

    // 内容级合计 D1/D3/D7：仅当所有作品均已到达第 N 天时汇总，未到期为空
    const totalMilestones = {};
    for (const dayN of NEW_WORK_MILESTONES) {
      if (eligibleEntries.length === 0) {
        totalMilestones[dayN] = null;
        continue;
      }
      const allReached = eligibleEntries.every((we) => we.reached[dayN]);
      if (!allReached) {
        totalMilestones[dayN] = null;
        continue;
      }
      let sum = null;
      for (const we of eligibleEntries) {
        sum = addNullable(sum, we.milestones[dayN]);
      }
      totalMilestones[dayN] = sum;
    }

    let totalLatestPlay = null;
    for (const pr of platformRows) {
      totalLatestPlay = addNullable(totalLatestPlay, pr.latestPlay);
    }

    // 内容行倍数严格按同一行显示的 D1/D3/D7 累计值计算
    const { d3ToD1, d7ToD3 } = computeMilestoneRatios(
      totalMilestones[1],
      totalMilestones[3],
      totalMilestones[7]
    );

    // 内容级走势分类：严格只用在 D1/D3/D7 三个里程碑都有值的同一组可比平台样本；不存在可比样本 → 「数据不足」
    const comparablePlatforms = platformRows.filter((pr) =>
      platformComparable.has(pr.platform)
    );

    let category = "数据不足";
    let comparableD1Play = null;
    let comparableD3Play = null;
    let comparableD7Play = null;
    let comparableD3ToD1 = null;
    let comparableD7ToD3 = null;
    let classificationBasis = "";
    const comparablePlatformNames = [];

    if (comparablePlatforms.length > 0) {
      let compD1 = 0;
      let compD3 = 0;
      let compD7 = 0;
      const basisLabels = [];
      for (const pr of comparablePlatforms) {
        const comp = platformComparable.get(pr.platform);
        compD1 += comp.d1;
        compD3 += comp.d3;
        compD7 += comp.d7;
        comparablePlatformNames.push(pr.platform);
        basisLabels.push(comp.basisLabel);
      }
      comparableD1Play = compD1;
      comparableD3Play = compD3;
      comparableD7Play = compD7;
      comparableD3ToD1 = compD1 > 0 ? round2(compD3 / compD1) : null;
      comparableD7ToD3 = compD3 > 0 ? round2(compD7 / compD3) : null;
      category = classifyTrajectory(compD1, compD3, compD7);
      if (category !== "数据不足") {
        classificationBasis = basisLabels.join("、");
      }
    }

    categoryCounts[category] += 1;

    const title =
      (meta && meta.title) ||
      (workEntries[0] && workEntries[0].series.title) ||
      "(无标题)";

    items.push({
      contentKey,
      title,
      publishDate: contentPubDate,
      platformCount: platformRows.length,
      d1Play: totalMilestones[1],
      d3Play: totalMilestones[3],
      d7Play: totalMilestones[7],
      latestPlay: totalLatestPlay,
      d3ToD1,
      d7ToD3,
      category,
      comparablePlatforms: category !== "数据不足" ? comparablePlatformNames : [],
      comparableD1Play,
      comparableD3Play,
      comparableD7Play,
      comparableD3ToD1,
      comparableD7ToD3,
      classificationBasis,
      platforms: platformRows,
    });
  }

  items.sort((a, b) => {
    if (a.publishDate !== b.publishDate) return compareText(b.publishDate, a.publishDate);
    const av = a.d7Play !== null ? a.d7Play : a.latestPlay !== null ? a.latestPlay : -Infinity;
    const bv = b.d7Play !== null ? b.d7Play : b.latestPlay !== null ? b.latestPlay : -Infinity;
    if (bv !== av) return bv - av;
    return compareText(a.contentKey, b.contentKey);
  });

  return {
    totalCount: items.length,
    categoryCounts,
    items,
  };
}

function resolveUtc8WeekdayAndSlot(pubMs) {
  const shifted = new Date(pubMs + UTC8_MS);
  const rawDay = shifted.getUTCDay(); // 0=周日, 1=周一 .. 6=周六
  const weekday = rawDay === 0 ? 7 : rawDay;
  const hour = shifted.getUTCHours();
  let slotObj = PUBLISH_TIME_SLOTS[0];
  for (const s of PUBLISH_TIME_SLOTS) {
    if (hour >= s.startHour && hour < s.endHour) {
      slotObj = s;
      break;
    }
  }
  return {
    weekday,
    weekdayLabel: WEEKDAY_LABELS[weekday],
    slot: slotObj.key,
    slotLabel: slotObj.label,
    hour,
  };
}

/**
 * 5. 发布时间：按内容最早已知发布时间（UTC+8 星期几 × 时段）分组，
 * 共用第 4 节按作品发布日期算出的 D7 里程碑（不足 7 天用最新累计并标注）再汇总到内容与时段。
 */
function buildPublishTimeSection(contentMetaByKey, worksByContent, cutoffTo) {
  const slotBuckets = new Map();

  for (const [contentKey, workEntries] of worksByContent.entries()) {
    const meta = contentMetaByKey.get(contentKey) || null;

    let earliestPubMs = meta && meta.firstPublishTimeMs !== null ? meta.firstPublishTimeMs : null;
    let earliestPubDate = (meta && meta.firstPublishDate) || "";

    for (const we of workEntries) {
      const s = we.series;
      if (s.publishTimeMs !== null && (earliestPubMs === null || s.publishTimeMs < earliestPubMs)) {
        earliestPubMs = s.publishTimeMs;
      }
      if (we.publishDate) {
        earliestPubDate = minNonEmptyDate(earliestPubDate, we.publishDate);
      }
    }

    if (earliestPubMs === null) continue;
    const msPubDate = toUtc8DateStr(earliestPubMs);
    earliestPubDate = minNonEmptyDate(earliestPubDate, msPubDate);
    if (!earliestPubDate || earliestPubDate > cutoffTo) continue;
    // 若已知更早首发日期但该日期仅有日期无时分秒，不得误归入后续补发时段
    if (msPubDate !== earliestPubDate) continue;

    let totalD7Play = null;
    let usedFallback = false;

    for (const we of workEntries) {
      if (!we.publishDate || we.publishDate > cutoffTo) continue;
      if (we.d7OrLatest !== null) {
        totalD7Play = addNullable(totalD7Play, we.d7OrLatest);
        if (we.usedFallback) usedFallback = true;
      }
    }

    if (totalD7Play === null) continue;

    const { weekday, weekdayLabel, slot, slotLabel } = resolveUtc8WeekdayAndSlot(earliestPubMs);
    const key = `${weekday}|${slot}`;
    let bucket = slotBuckets.get(key);
    if (!bucket) {
      bucket = {
        weekday,
        weekdayLabel,
        slot,
        slotLabel,
        playSum: 0,
        sampleCount: 0,
        fallbackCount: 0,
      };
      slotBuckets.set(key, bucket);
    }
    bucket.playSum += totalD7Play;
    bucket.sampleCount += 1;
    if (usedFallback) bucket.fallbackCount += 1;
  }

  const slotOrder = (slotKey) => {
    const idx = PUBLISH_TIME_SLOTS.findIndex((s) => s.key === slotKey);
    return idx === -1 ? 99 : idx;
  };

  const groups = [...slotBuckets.values()]
    .map((b) => {
      const avgD7Play = round2(b.playSum / b.sampleCount);
      const lowSample = b.sampleCount < PUBLISH_TIME_MIN_SAMPLES;
      const hasFallback = b.fallbackCount > 0;
      const notes = [];
      if (lowSample) notes.push("样本少");
      if (hasFallback) notes.push("含不足7天最新累计");
      return {
        weekday: b.weekday,
        weekdayLabel: b.weekdayLabel,
        slot: b.slot,
        slotLabel: b.slotLabel,
        sampleCount: b.sampleCount,
        avgD7Play,
        fallbackCount: b.fallbackCount,
        hasFallback,
        lowSample,
        note: notes.join("；"),
      };
    })
    .sort((a, b) => {
      if (b.avgD7Play !== a.avgD7Play) return b.avgD7Play - a.avgD7Play;
      if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      return slotOrder(a.slot) - slotOrder(b.slot);
    });

  // 优先选样本 >= 3 中平均 D7 播放最高的时段；若全部样本 < 3 则回退选最高组
  const sufficientGroups = groups.filter((g) => !g.lowSample);
  const bestSlot = sufficientGroups[0] || groups[0] || null;

  return {
    totalSamples: groups.reduce((s, g) => s + g.sampleCount, 0),
    groups,
    bestSlot,
  };
}

/**
 * 6. 异常提醒：
 * - 疑似采集异常（本周期内；基于全历史含截止日后恢复快照识别）
 * - 疑似上推荐：仅对单日实测日增（daySpan === 1，断档后首日不触发）判定，
 *   基线严格限定在前 7 个日历日窗口 [d - 7, d - 1]，跨断档增量按覆盖天数均摊。
 */
function buildAnomaliesSection(
  seriesByWork,
  allCollectionAnomalies,
  { currentStart, to },
  accountPlaysAnomalies = []
) {
  const workAnomalies = allCollectionAnomalies.filter(
    (a) => a.date >= currentStart && a.date <= to
  );
  const accAnomalies = (Array.isArray(accountPlaysAnomalies) ? accountPlaysAnomalies : []).filter(
    (a) => a.date >= currentStart && a.date <= to
  );
  const collectionAnomalies = [...workAnomalies, ...accAnomalies].sort((a, b) => {
    if (a.date !== b.date) return compareText(b.date, a.date);
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.workId || "", b.workId || "");
  });

  const curStartDay = dateStrToDayNum(currentStart);
  const toDay = dateStrToDayNum(to);
  const recommendSpikes = [];

  for (const series of seriesByWork.values()) {
    const len = series.len;
    const dayNums = series.dayNums;
    const dates = series.dates;
    const groups = series.groups;
    const titles = series.titles;
    const urls = series.urls;
    const playDeltas = series.deltas.play;
    const playSpans = series.playDaySpans;
    const playExcluded = series.playExcluded;

    for (let i = 0; i < len; i++) {
      const dn = dayNums[i];
      if (dn < curStartDay) continue;
      if (dn > toDay) break;
      if (playExcluded[i]) continue;

      const rawDelta = playDeltas[i];
      const span = playSpans[i];
      // 跨断档增量不当作单日实测增量（断档后首日不触发上推荐）
      if (rawDelta === null || span !== 1) continue;
      if (rawDelta < RECOMMEND_SPIKE_MIN_PLAY_DELTA) continue;

      // 严格限定前 7 个日历日窗口 [d - 7, d - 1]，跨断档区间按重叠天数均摊
      const minBaselineDay = dn - RECOMMEND_BASELINE_DAYS;
      const maxBaselineDay = dn - 1;
      let baseDeltaSum = 0;
      let baseCoveredDays = 0;

      for (let j = i - 1; j >= 0; j--) {
        const prevDay = dayNums[j];
        if (prevDay < minBaselineDay) break;
        if (prevDay > maxBaselineDay) continue;
        if (playExcluded[j]) continue;
        const prevDelta = playDeltas[j];
        const prevSpan = playSpans[j];
        if (prevDelta === null || prevSpan <= 0) continue;

        const intStart = prevDay - prevSpan + 1;
        const ovStart = intStart > minBaselineDay ? intStart : minBaselineDay;
        const ovEnd = prevDay < maxBaselineDay ? prevDay : maxBaselineDay;
        const overlapDays = ovEnd - ovStart + 1;
        if (overlapDays > 0) {
          baseDeltaSum += prevDelta * (overlapDays / prevSpan);
          baseCoveredDays += overlapDays;
        }
      }

      if (baseCoveredDays <= 0) continue;

      const baselineAvg = baseDeltaSum / baseCoveredDays;
      const effectiveBaseline = Math.max(0, baselineAvg);
      if (rawDelta >= effectiveBaseline * RECOMMEND_SPIKE_MULTIPLIER) {
        recommendSpikes.push({
          date: dates[i],
          platform: series.platform,
          group: groups[i],
          workId: series.workId,
          pwKey: series.pwKey,
          contentKey: series.contentKey,
          title: titles[i] || series.title,
          url: urls[i] || series.url,
          playDelta: rawDelta,
          daySpan: 1,
          dailyPlayDelta: round2(rawDelta),
          baselineAvg: round2(baselineAvg),
          baselineDays: baseCoveredDays,
          ratio: effectiveBaseline > 0 ? round2(rawDelta / effectiveBaseline) : null,
        });
      }
    }
  }

  recommendSpikes.sort((a, b) => {
    if (a.date !== b.date) return compareText(b.date, a.date);
    if (b.dailyPlayDelta !== a.dailyPlayDelta) return b.dailyPlayDelta - a.dailyPlayDelta;
    const pc = comparePlatform(a.platform, b.platform);
    if (pc !== 0) return pc;
    return compareText(a.workId, b.workId);
  });

  return {
    collectionAnomalies,
    accountAnomalies: accAnomalies,
    recommendSpikes,
    excludedPointCount: allCollectionAnomalies.length + (Array.isArray(accountPlaysAnomalies) ? accountPlaysAnomalies.length : 0),
    totalCount: collectionAnomalies.length + recommendSpikes.length,
  };
}

/** 账号粉丝趋势（来自账号日快照，覆盖本周期连续日期，按平台与分组确定性排序） */
function buildFansTrendSection(accountRows, { currentStart, currentEnd }) {
  const curStartDay = dateStrToDayNum(currentStart);
  const curEndDay = dateStrToDayNum(currentEnd);
  const periodDays = curEndDay - curStartDay + 1;
  const dates = new Array(periodDays);
  for (let d = 0; d < periodDays; d++) {
    dates[d] = dayNumToDateStr(curStartDay + d);
  }

  const byAccount = new Map();
  for (const ar of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(ar) || typeof ar.date !== "string") continue;
    const dn = dateStrToDayNum(ar.date.trim());
    if (dn === null || dn < curStartDay || dn > curEndDay) continue;
    const platform = ar.platform == null ? "" : String(ar.platform).trim();
    if (!platform) continue;
    const group = ar.group == null ? "" : String(ar.group).trim();
    const fans = fastNormalizeMetric(ar.fans);
    const fansDelta = fastNormalizeMetric(ar.fansDelta);
    if (fans === null && fansDelta === null) continue;

    const accountKey = `${platform}|${group}`;
    let bucket = byAccount.get(accountKey);
    if (!bucket) {
      bucket = {
        accountKey,
        platform,
        group,
        label: group ? `${platform}·${group}` : platform,
        fans: new Array(periodDays).fill(null),
        fansDelta: new Array(periodDays).fill(null),
      };
      byAccount.set(accountKey, bucket);
    }
    const dayIdx = dn - curStartDay;
    // 确定性合并（避免重复日期受输入顺序影响）
    if (fans !== null && (bucket.fans[dayIdx] === null || fans > bucket.fans[dayIdx])) {
      bucket.fans[dayIdx] = fans;
    }
    if (
      fansDelta !== null &&
      (bucket.fansDelta[dayIdx] === null || fansDelta > bucket.fansDelta[dayIdx])
    ) {
      bucket.fansDelta[dayIdx] = fansDelta;
    }
  }

  const accounts = [...byAccount.values()]
    .filter((b) => b.fans.some((v) => v !== null))
    .map((b) => {
      let latestFans = null;
      let periodDelta = null;
      for (let i = 0; i < periodDays; i++) {
        if (b.fans[i] !== null) latestFans = b.fans[i];
        periodDelta = addNullable(periodDelta, b.fansDelta[i]);
      }
      return {
        accountKey: b.accountKey,
        platform: b.platform,
        group: b.group,
        label: b.label,
        fans: b.fans,
        fansDelta: b.fansDelta,
        latestFans,
        periodDelta,
      };
    })
    .sort((a, b) => {
      const pc = comparePlatform(a.platform, b.platform);
      if (pc !== 0) return pc;
      return compareText(a.group, b.group);
    });

  return {
    dates,
    accounts,
  };
}

/** 7. 文字小结：从 1–6 节拼 5–8 行中文要点 + 数据积累不足 14 天提示 */
function buildSummarySection({
  period,
  currentStart,
  to,
  snapshotDays,
  overview,
  platformComparison,
  rankings,
  newWorks,
  publishTime,
  anomalies,
}) {
  const lines = [];

  // 1. 总量与环比（明确统计区间与作品日数据实际覆盖天数；涨粉优先取《账号日快照》首尾差合计）
  const m = overview.metrics;
  const cov = overview.coverage || {
    rangeText: `统计区间 ${currentStart} ~ ${to}`,
    isPartial: false,
    partialNotice: "",
  };
  const accFans = overview.accountFansGrowth || null;
  const workFans = overview.workFansGrowth || m.fansDelta || null;
  const hasAccFans = accFans && accFans.current !== null;
  const hasWorkFans = workFans && workFans.current !== null;
  const partialSuffix = cov.isPartial && cov.partialNotice ? `（${cov.partialNotice.replace(/。$/, "")}）` : "";

  if (
    m.play.current === null &&
    m.like.current === null &&
    m.comment.current === null &&
    !hasAccFans &&
    !hasWorkFans
  ) {
    lines.push(`总量与环比：${cov.rangeText}${partialSuffix}，暂无可计算的作品日增或账号涨粉数据。`);
  } else {
    const parts = [];
    if (m.play.current !== null) {
      parts.push(`新增播放 ${formatIntText(m.play.current)}（环比 ${formatMomText(m.play.momPct)}）`);
    }
    if (m.like.current !== null) {
      parts.push(`点赞 ${formatIntText(m.like.current)}（环比 ${formatMomText(m.like.momPct)}）`);
    }
    if (m.comment.current !== null) {
      parts.push(`评论 ${formatIntText(m.comment.current)}`);
    }
    if (hasAccFans) {
      const workFansNote = hasWorkFans
        ? `；单作品涨粉合计 ${formatIntText(workFans.current)}`
        : "";
      parts.push(
        `涨粉 ${formatIntText(accFans.current)}（账号日快照首尾差合计，环比 ${formatMomText(
          accFans.momPct
        )}${workFansNote}）`
      );
    } else if (hasWorkFans) {
      parts.push(
        `涨粉 ${formatIntText(workFans.current)}（单作品涨粉合计，环比 ${formatMomText(
          workFans.momPct
        )}）`
      );
    }
    lines.push(`总量与环比：${cov.rangeText}${partialSuffix}；${parts.join("、")}。`);
  }

  // 2. 表现最好的平台
  if (
    platformComparison.multiPlatformContentCount > 0 &&
    platformComparison.platforms.length >= 2 &&
    platformComparison.conclusions.length > 0
  ) {
    const topContrib = overview.platformContribution[0];
    const contribSuffix =
      topContrib && topContrib.sharePct !== null
        ? ` 本周期播放增量占比最高为${topContrib.platform}（${topContrib.sharePct}%）。`
        : "";
    lines.push(`平台表现：${platformComparison.conclusions[0]}${contribSuffix}`);
  } else if (
    overview.platformContribution.length > 0 &&
    overview.platformContribution[0].play !== null
  ) {
    const top = overview.platformContribution[0];
    const shareText = top.sharePct !== null ? `，占比 ${top.sharePct}%` : "";
    lines.push(
      `平台表现：${top.platform}本周期播放日增最高（+${formatIntText(top.play)}${shareText}）；跨平台同款内容不足，暂无对比结论。`
    );
  } else {
    lines.push("平台表现：暂无足够平台增量或跨平台同款数据。");
  }

  // 3. Top 作品
  const topPlay = rankings.byPlay.top[0] || null;
  const topEng = rankings.byEngagement.top[0] || null;
  if (topPlay) {
    const engSuffix = topEng
      ? `；互动率最高为「${topEng.title}」（${formatPctFromRate(topEng.engagementRate)}）`
      : "";
    lines.push(
      `Top 作品：总播放最高为「${topPlay.title}」（${formatIntText(topPlay.totalPlay)}）${engSuffix}。`
    );
  } else {
    lines.push("Top 作品：截至当前暂无有播放数据的作品。");
  }

  // 4. 新作品与长尾作品数
  const cc = newWorks.categoryCounts;
  lines.push(
    `新作品走势：本周期发布 ${newWorks.totalCount} 条内容，其中长尾型 ${cc.长尾型} 条、爆发后平稳 ${cc.爆发后平稳} 条、其它 ${cc.其它} 条、数据不足 ${cc.数据不足} 条。`
  );

  // 5. 推荐发布时段
  if (publishTime.bestSlot) {
    const bs = publishTime.bestSlot;
    const noteText = bs.note ? `，${bs.note}` : "";
    lines.push(
      `推荐发布时段：${bs.weekdayLabel} ${bs.slotLabel} 时段表现最佳，平均 D7 播放 ${formatIntText(
        bs.avgD7Play
      )}（样本 ${bs.sampleCount} 条${noteText}）。`
    );
  } else {
    lines.push("推荐发布时段：暂无带有效发布时间与 D7 快照的内容样本。");
  }

  // 6. 异常条数
  const colCnt = anomalies.collectionAnomalies.length;
  const recCnt = anomalies.recommendSpikes.length;
  if (colCnt > 0 || recCnt > 0) {
    lines.push(
      `异常提醒：本周期发现疑似采集异常 ${colCnt} 条（已在第 1–5 节剔除并重算日增）、疑似上推荐 ${recCnt} 条。`
    );
  } else {
    lines.push("异常提醒：本周期未发现疑似采集异常（0 条）或疑似上推荐波动（0 条）。");
  }

  // 7. 偏科补充（有偏科时加一行）
  if (rankings.platformSkew.length > 0) {
    const s0 = rankings.platformSkew[0];
    const ratioText = s0.ratio !== null ? `约 ${s0.ratio} 倍` : "远高于其它平台";
    lines.push(
      `平台偏科：共 ${rankings.platformSkew.length} 条内容单平台明显突出（如「${s0.title}」在${s0.platform}播放 ${formatIntText(
        s0.platformPlay
      )}，为其它平台均值的 ${ratioText}）。`
    );
  }

  // 8. 少于 14 天提示
  const lowHistoryNotice = snapshotDays < MIN_ACCUMULATED_DAYS_NOTICE;
  if (lowHistoryNotice) {
    lines.push(`${LOW_HISTORY_NOTICE_TEXT}（当前已积累 ${snapshotDays} 天作品快照）。`);
  }

  return {
    lines,
    text: lines.join("\n"),
    lowHistoryNotice,
    snapshotDays,
  };
}

/** 将 UTC+8 日期 + HH:mm 时段转换为时间戳（ms） */
function slotToUtc8Ms(dateStr, slotStr) {
  const dn = dateStrToDayNum(dateStr);
  if (dn === null) return null;
  const m = SLOT_TIME_RE.exec(typeof slotStr === "string" ? slotStr.trim() : "");
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return dn * DAY_MS + (hh * 60 + mm) * 60000 - UTC8_MS;
}

/**
 * 构建单个作品集合在参考发布时间 refPubMs 之后 [0, 24h] 内的累计播放曲线：
 * - x = 发布后小时数（保留两位小数）
 * - 在每个采集时点上，取集合内各作品最近一次 <= 该时点且 >= refPubMs 的累计播放求和
 */
function build24hCurve(workEntries, refPubMs) {
  if (!Array.isArray(workEntries) || !workEntries.length || refPubMs === null) return [];
  const maxTs = refPubMs + NEW_WORKS_FIRST_24H_HOURS * HOUR_MS;
  const timeTicksMap = new Map();
  const filteredLists = [];

  for (const we of workEntries) {
    const valid = [];
    for (const pt of we.points) {
      if (pt.tsMs < refPubMs || pt.tsMs > maxTs) continue;
      valid.push(pt);
      const tickKey = `${pt.date} ${pt.slot}|${pt.tsMs}`;
      if (!timeTicksMap.has(tickKey)) {
        timeTicksMap.set(tickKey, {
          date: pt.date,
          slot: pt.slot,
          collectedAt: pt.collectedAt,
          tsMs: pt.tsMs,
        });
      }
    }
    if (valid.length) filteredLists.push(valid);
  }
  if (!filteredLists.length || !timeTicksMap.size) return [];

  const ticks = [...timeTicksMap.values()].sort((a, b) => {
    if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
    if (a.date !== b.date) return compareText(a.date, b.date);
    return compareText(a.slot, b.slot);
  });

  const ptrs = new Int32Array(filteredLists.length);
  const curPlays = new Array(filteredLists.length).fill(null);
  const curve = [];

  for (let ti = 0; ti < ticks.length; ti++) {
    const tick = ticks[ti];
    for (let wi = 0; wi < filteredLists.length; wi++) {
      const list = filteredLists[wi];
      let p = ptrs[wi];
      while (p < list.length && list[p].tsMs <= tick.tsMs) {
        curPlays[wi] = list[p].play;
        p += 1;
      }
      ptrs[wi] = p;
    }

    let sumPlay = null;
    for (let wi = 0; wi < filteredLists.length; wi++) {
      if (curPlays[wi] !== null) {
        sumPlay = sumPlay === null ? curPlays[wi] : sumPlay + curPlays[wi];
      }
    }
    if (sumPlay === null) continue;
    const hours = round2((tick.tsMs - refPubMs) / HOUR_MS);
    if (hours === null || hours < 0 || hours > NEW_WORKS_FIRST_24H_HOURS) continue;

    const point = {
      hours,
      play: sumPlay === 0 ? 0 : sumPlay,
      date: tick.date,
      slot: tick.slot,
      collectedAt: tick.collectedAt,
    };
    const last = curve.length ? curve[curve.length - 1] : null;
    if (last && last.hours === point.hours) {
      curve[curve.length - 1] = point;
    } else {
      curve.push(point);
    }
  }

  return curve;
}

/**
 * 新作品前 24 小时起量走势：
 * - 范围：近 7 天内（[to - 6, to]）发布的内容（按内容最早已知首发日，补发不算新作品）
 * - 每个采集时点的累计播放（x = 发布后小时数，0..24h），提供内容总曲线与分平台曲线
 */
function buildNewWorksFirst24hSection(
  intradayRows,
  contentMetaByKey,
  seriesByWork,
  cutoffTo,
  summaryWorkToContent
) {
  const recent7Start = shiftDateStr(cutoffTo, -(NEW_WORKS_FIRST_24H_DAYS - 1));
  if (!Array.isArray(intradayRows) || intradayRows.length === 0) {
    return {
      totalCount: 0,
      windowDays: NEW_WORKS_FIRST_24H_DAYS,
      maxHours: NEW_WORKS_FIRST_24H_HOURS,
      from: recent7Start,
      to: cutoffTo,
      items: [],
    };
  }

  // 1. 按 (platform|workId, date, slot) 去重（多分组取分组名排序第一组），过滤掉 > cutoffTo 与空 play
  const dedupByWorkSlot = new Map();
  for (let i = 0; i < intradayRows.length; i++) {
    const r = intradayRows[i];
    if (!isPlainObject(r)) continue;
    const date = typeof r.date === "string" ? r.date.trim() : "";
    const slot = typeof r.slot === "string" ? r.slot.trim() : "";
    if (!isValidDateStr(date) || !SLOT_TIME_RE.test(slot)) continue;
    if (date > cutoffTo) continue;
    const platform = r.platform == null ? "" : String(r.platform).trim();
    const workId = r.workId == null ? "" : String(r.workId).trim();
    if (!platform || !workId) continue;
    const play = fastNormalizeMetric(r.play);
    if (play === null) continue;

    const group = r.group == null ? "" : String(r.group).trim();
    const collectedAt = parseTimestampMs(r.collectedAt);
    const collectedDate = collectedAt !== null ? formatUtc8Date(collectedAt) : "";
    if (collectedDate && collectedDate > cutoffTo) continue;
    const pwKey = `${platform}|${workId}`;
    const slotKey = `${pwKey}\0${date}\0${slot}`;
    const existing = dedupByWorkSlot.get(slotKey);
    if (!existing || compareText(group, existing.group) < 0) {
      const tsMs = collectedAt !== null ? collectedAt : slotToUtc8Ms(date, slot);
      if (tsMs === null) continue;
      dedupByWorkSlot.set(slotKey, {
        pwKey,
        platform,
        workId,
        group,
        date,
        slot,
        collectedAt,
        tsMs,
        play,
        title: typeof r.title === "string" ? r.title : "",
        contentKey: typeof r.contentKey === "string" && r.contentKey.trim() ? r.contentKey.trim() : "",
        publishTimeMs:
          typeof r.publishTimeMs === "number" && Number.isFinite(r.publishTimeMs) && r.publishTimeMs > 0
            ? r.publishTimeMs
            : parseTimestampMs(r.publishTime),
        publishDate:
          typeof r.publishDate === "string" && isValidDateStr(r.publishDate.trim())
            ? r.publishDate.trim()
            : "",
      });
    }
  }

  // 2. 归组到作品 -> 内容
  const byWork = new Map();
  for (const row of dedupByWorkSlot.values()) {
    let bucket = byWork.get(row.pwKey);
    if (!bucket) {
      const series = seriesByWork.get(row.pwKey) || null;
      const ck =
        (summaryWorkToContent && summaryWorkToContent.get(row.pwKey)) ||
        (series && series.contentKey) ||
        row.contentKey ||
        `unlinked:${row.platform}:${row.workId}`;
      const pubMs =
        row.publishTimeMs !== null
          ? row.publishTimeMs
          : series && series.publishTimeMs !== null
          ? series.publishTimeMs
          : null;
      const pubDate =
        row.publishDate ||
        (pubMs !== null ? formatUtc8Date(pubMs) : "") ||
        (series && series.publishDate) ||
        "";
      bucket = {
        pwKey: row.pwKey,
        contentKey: ck,
        platform: row.platform,
        workId: row.workId,
        title: row.title || (series && series.title) || "",
        pubMs,
        pubDate,
        points: [],
      };
      byWork.set(row.pwKey, bucket);
    } else {
      if (!bucket.title && row.title) bucket.title = row.title;
      if (row.publishTimeMs !== null && (bucket.pubMs === null || row.publishTimeMs < bucket.pubMs)) {
        bucket.pubMs = row.publishTimeMs;
        bucket.pubDate = row.publishDate || formatUtc8Date(row.publishTimeMs);
      }
    }
    bucket.points.push({
      date: row.date,
      slot: row.slot,
      collectedAt: row.collectedAt,
      tsMs: row.tsMs,
      play: row.play,
    });
  }

  // 收集 seriesByWork 中每个内容的已知最早作品发布日与精确发布时间戳
  // （确保仅有旧版日快照、未在 intraday 出现过的最早平台首发仍作为起点参与判定）
  const seriesMinPubDateByContent = new Map();
  const seriesMinPubMsByContent = new Map();
  for (const s of seriesByWork.values()) {
    if (s.publishDate) {
      const prevDate = seriesMinPubDateByContent.get(s.contentKey) || "";
      seriesMinPubDateByContent.set(s.contentKey, minNonEmptyDate(prevDate, s.publishDate));
    }
    if (s.publishTimeMs !== null && s.publishTimeMs > 0) {
      const prevMs = seriesMinPubMsByContent.get(s.contentKey);
      if (prevMs === undefined || s.publishTimeMs < prevMs) {
        seriesMinPubMsByContent.set(s.contentKey, s.publishTimeMs);
      }
    }
  }

  const worksByContent = new Map();
  for (const wb of byWork.values()) {
    wb.points.sort((a, b) => {
      if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
      if (a.date !== b.date) return compareText(a.date, b.date);
      return compareText(a.slot, b.slot);
    });
    let arr = worksByContent.get(wb.contentKey);
    if (!arr) {
      arr = [];
      worksByContent.set(wb.contentKey, arr);
    }
    arr.push(wb);
  }

  // 3. 逐内容构建前 24 小时起量曲线（起点与 S7 最早已知首发一致：归一化 firstPublishTimeMs）
  const items = [];
  for (const [contentKey, workEntries] of worksByContent.entries()) {
    const meta = contentMetaByKey.get(contentKey) || null;
    let earliestPubMs =
      meta && meta.firstPublishTimeMs !== null && meta.firstPublishTimeMs > 0
        ? meta.firstPublishTimeMs
        : null;
    let earliestPubDate = minNonEmptyDate(
      meta && meta.firstPublishDate,
      seriesMinPubDateByContent.get(contentKey) || ""
    );
    const seriesMinMs = seriesMinPubMsByContent.get(contentKey);
    if (
      seriesMinMs !== undefined &&
      seriesMinMs > 0 &&
      (earliestPubMs === null || seriesMinMs < earliestPubMs)
    ) {
      earliestPubMs = seriesMinMs;
    }
    for (const we of workEntries) {
      if (we.pubDate) earliestPubDate = minNonEmptyDate(earliestPubDate, we.pubDate);
      if (we.pubMs !== null && we.pubMs > 0 && (earliestPubMs === null || we.pubMs < earliestPubMs)) {
        earliestPubMs = we.pubMs;
      }
    }
    if (earliestPubMs === null) continue;
    const msPubDate = formatUtc8Date(earliestPubMs);
    const contentPubDate = minNonEmptyDate(earliestPubDate, msPubDate);
    if (!contentPubDate || contentPubDate < recent7Start || contentPubDate > cutoffTo) {
      continue;
    }
    // 若已知更早首发日期但该日期仅有日期无时分秒，不得误把后续补发时间当作首发起点
    if (msPubDate && contentPubDate < msPubDate) {
      continue;
    }
    const contentPubMs = earliestPubMs;

    const byPlatform = new Map();
    for (const we of workEntries) {
      let arr = byPlatform.get(we.platform);
      if (!arr) {
        arr = [];
        byPlatform.set(we.platform, arr);
      }
      arr.push(we);
    }

    const sortedPlatforms = [...byPlatform.keys()].sort(comparePlatform);
    const platformSeries = [];
    for (const platform of sortedPlatforms) {
      const pWorks = byPlatform.get(platform);
      const pCurve = build24hCurve(pWorks, contentPubMs);
      if (!pCurve.length) continue;
      platformSeries.push({
        platform,
        publishTimeMs: contentPubMs,
        latestPlay24h: pCurve[pCurve.length - 1].play,
        points: pCurve,
      });
    }

    const totalCurve = build24hCurve(workEntries, contentPubMs);
    if (!totalCurve.length) continue;

    let primaryPlatform = "";
    let maxPlatformPlay = -Infinity;
    for (const ps of platformSeries) {
      if (
        ps.latestPlay24h > maxPlatformPlay ||
        (ps.latestPlay24h === maxPlatformPlay &&
          (!primaryPlatform || comparePlatform(ps.platform, primaryPlatform) < 0))
      ) {
        maxPlatformPlay = ps.latestPlay24h;
        primaryPlatform = ps.platform;
      }
    }
    if (!primaryPlatform && sortedPlatforms.length) {
      primaryPlatform = sortedPlatforms[0];
    }

    const firstWorkTitle = workEntries.find((w) => w.title)?.title || "";
    items.push({
      contentKey,
      title: (meta && meta.title) || firstWorkTitle || "(无标题)",
      publishDate: contentPubDate,
      publishTimeMs: contentPubMs,
      primaryPlatform,
      platformCount: platformSeries.length,
      latestPlay24h: totalCurve[totalCurve.length - 1].play,
      points: totalCurve,
      platforms: platformSeries,
    });
  }

  items.sort((a, b) => {
    if (b.publishTimeMs !== a.publishTimeMs) return b.publishTimeMs - a.publishTimeMs;
    if (b.latestPlay24h !== a.latestPlay24h) return b.latestPlay24h - a.latestPlay24h;
    return compareText(a.contentKey, b.contentKey);
  });

  return {
    totalCount: items.length,
    windowDays: NEW_WORKS_FIRST_24H_DAYS,
    maxHours: NEW_WORKS_FIRST_24H_HOURS,
    from: recent7Start,
    to: cutoffTo,
    items,
  };
}

/**
 * 纯函数构建数据分析结果（7 节 + 新作品前 24 小时），供 GUI「数据分析」tab 与 Excel「分析」sheet 共用。
 *
 * @param {object} params
 * @param {Array<object>} [params.dailyRows]    作品日明细行（建议含全量快照以支持截止日后恢复异常识别、环比与7天基线）
 * @param {Array<object>} [params.summaryRows]  跨平台内容汇总行（截至 to，可携带 S6 最早已知 firstPublishTime）
 * @param {Array<object>} [params.accountRows]  账号日快照行（截至 to）
 * @param {Array<object>} [params.intradayRows] 作品分时段快照行（近 7 天，用于「新作品前 24 小时」起量曲线）
 * @param {string} [params.to]                  截止日期 YYYY-MM-DD（上限为 UTC+8 今天，未来日期自动夹到今天）
 * @param {number} [params.period=30]           分析周期天数（7 / 30 或导出区间天数）
 * @param {number|Date} [params.now]            注入当前时间（UTC+8 今天上限与兜底截止日，保证确定性）
 */
function buildStatsAnalysis({
  dailyRows = [],
  summaryRows = [],
  accountRows = [],
  intradayRows = [],
  to,
  period = DEFAULT_ANALYSIS_PERIOD,
  now = Date.now(),
} = {}) {
  const resolvedPeriod = resolvePeriod(period);
  const resolvedTo = resolveToDate(to, dailyRows, accountRows, now, intradayRows);
  const currentStart = shiftDateStr(resolvedTo, -(resolvedPeriod - 1));
  const prevEnd = shiftDateStr(currentStart, -1);
  const prevStart = shiftDateStr(currentStart, -resolvedPeriod);

  // 先用全量快照做去重、采集异常识别与截止日内清洗重算（第 1–5 节共用清洗后序列）
  const summaryWorkToContent = buildSummaryWorkToContentMap(summaryRows);
  const { seriesByWork, allCollectionAnomalies, snapshotDays } = prepareWorkSeries(
    dailyRows,
    resolvedTo,
    summaryWorkToContent
  );

  const contentRows = normalizeContentRows(summaryRows, resolvedTo, seriesByWork);
  const contentMetaByKey = new Map();
  for (const c of contentRows) {
    contentMetaByKey.set(c.contentKey, c);
  }

  const { cleanedAccountRows, accountPlaysAnomalies } = prepareAccountSeries(
    accountRows,
    seriesByWork,
    resolvedTo
  );

  const overview = buildOverviewSection(seriesByWork, cleanedAccountRows, {
    currentStart,
    currentEnd: resolvedTo,
    prevStart,
    prevEnd,
  });

  const platformComparison = buildPlatformComparisonSection(contentRows);
  const rankings = buildRankingsSection(contentRows);

  // 第 4、5 节共用按作品发布日期计算的里程碑结果
  const { worksByContent } = buildWorkMilestoneIndex(seriesByWork, contentMetaByKey, resolvedTo);
  const newWorks = buildNewWorksSection(contentMetaByKey, worksByContent, {
    currentStart,
    to: resolvedTo,
  });
  const newWorksFirst24h = buildNewWorksFirst24hSection(
    intradayRows,
    contentMetaByKey,
    seriesByWork,
    resolvedTo,
    summaryWorkToContent
  );
  const publishTime = buildPublishTimeSection(contentMetaByKey, worksByContent, resolvedTo);
  const anomalies = buildAnomaliesSection(
    seriesByWork,
    allCollectionAnomalies,
    {
      currentStart,
      to: resolvedTo,
    },
    accountPlaysAnomalies
  );
  const fansTrend = buildFansTrendSection(cleanedAccountRows, {
    currentStart,
    currentEnd: resolvedTo,
  });
  const summary = buildSummarySection({
    period: resolvedPeriod,
    currentStart,
    to: resolvedTo,
    snapshotDays,
    overview,
    platformComparison,
    rankings,
    newWorks,
    publishTime,
    anomalies,
  });

  const result = {
    to: resolvedTo,
    period: resolvedPeriod,
    currentRange: { from: currentStart, to: resolvedTo },
    previousRange: { from: prevStart, to: prevEnd },
    coverage: overview.coverage,
    snapshotDays,
    thresholds: ANALYSIS_THRESHOLDS,
    overview,
    platformComparison,
    rankings,
    newWorks,
    newWorksFirst24h,
    publishTime,
    fansTrend,
    anomalies,
    summary,
  };
  Object.defineProperty(result, "_cleanedAccountRows", {
    value: cleanedAccountRows,
    enumerable: false,
    configurable: true,
  });
  return result;
}

module.exports = {
  DEFAULT_ANALYSIS_PERIOD,
  MIN_PLATFORM_COMPARE_PLATFORMS,
  LOW_SAMPLE_THRESHOLD,
  PLATFORM_PLAY_CLOSE_DIFF_RATIO,
  ENGAGEMENT_MIN_PLAY,
  RANKING_LIMIT,
  PLATFORM_SKEW_RATIO,
  PLATFORM_SKEW_MIN_PLAY,
  NEW_WORK_MILESTONES,
  NEW_WORKS_FIRST_24H_DAYS,
  NEW_WORKS_FIRST_24H_HOURS,
  LONG_TAIL_D7_D3_RATIO,
  BURST_FLAT_D3_D1_RATIO,
  BURST_FLAT_D7_D3_RATIO,
  PUBLISH_TIME_MIN_SAMPLES,
  PUBLISH_TIME_SLOTS,
  RECOMMEND_BASELINE_DAYS,
  RECOMMEND_SPIKE_MULTIPLIER,
  RECOMMEND_SPIKE_MIN_PLAY_DELTA,
  MIN_ACCUMULATED_DAYS_NOTICE,
  LOW_HISTORY_NOTICE_TEXT,
  PLATFORM_MISSING_INTERACTION_FIELDS,
  ACCOUNT_PLAYS_SHARP_DROP_RATIO,
  ANALYSIS_THRESHOLDS,
  classifyTrajectory,
  buildStatsAnalysis,
};
