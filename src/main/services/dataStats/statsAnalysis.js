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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const PLATFORM_ORDER = [
  "抖音",
  "视频号",
  "快手",
  "哔哩哔哩",
  "小红书",
  "百家号",
  "头条",
];

const METRIC_LABELS = Object.freeze({
  play: "播放",
  like: "点赞",
  comment: "评论",
  share: "分享",
  favorite: "收藏",
  fansDelta: "涨粉",
});

// 分析阈值常量（导出便于单测与后续调优）
const DEFAULT_ANALYSIS_PERIOD = 30;
const MIN_PLATFORM_COMPARE_PLATFORMS = 2;
const LOW_SAMPLE_THRESHOLD = 3;
const ENGAGEMENT_MIN_PLAY = 100;
const RANKING_LIMIT = 10;
const PLATFORM_SKEW_RATIO = 3;
const PLATFORM_SKEW_MIN_PLAY = 500;
const NEW_WORK_MILESTONES = Object.freeze([1, 3, 7]);
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

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function compareText(a, b) {
  const sa = a == null ? "" : String(a);
  const sb = b == null ? "" : String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function comparePlatform(a, b) {
  const ia = PLATFORM_ORDER.indexOf(a);
  const ib = PLATFORM_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return compareText(a, b);
}

function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s;
}

function dateStrToDayNum(ymd) {
  if (!isValidDateStr(ymd)) return null;
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / DAY_MS);
}

function shiftDateStr(ymd, deltaDays) {
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return new Date(ms + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

function formatUtc8Date(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(safeMs + UTC8_MS).toISOString().slice(0, 10);
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
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const shifted = new Date(ms + UTC8_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const y = shifted.getUTCFullYear();
  if (y < 1970 || y > 2100) return null;
  return ms;
}

function toUtc8DateStr(raw) {
  if (typeof raw === "string" && isValidDateStr(raw.trim())) {
    return raw.trim();
  }
  const ms = parseTimestampMs(raw);
  return ms === null ? "" : new Date(ms + UTC8_MS).toISOString().slice(0, 10);
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
  const rounded = Math.round((val + (val >= 0 ? Number.EPSILON : -Number.EPSILON)) * factor) / factor;
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

function resolveToDate(rawTo, dailyRows, accountRows, nowVal) {
  if (rawTo !== undefined && rawTo !== null && rawTo !== "") {
    if (typeof rawTo !== "string" || !isValidDateStr(rawTo.trim())) {
      throw new Error(`截止日期 to 不是合法日期（需 YYYY-MM-DD）：${rawTo}`);
    }
    return rawTo.trim();
  }
  let latestWorkDate = "";
  for (const r of Array.isArray(dailyRows) ? dailyRows : []) {
    if (!isPlainObject(r) || typeof r.date !== "string") continue;
    const d = r.date.trim();
    if (!isValidDateStr(d)) continue;
    if (!latestWorkDate || d > latestWorkDate) latestWorkDate = d;
  }
  if (latestWorkDate) return latestWorkDate;

  let latestAccDate = "";
  for (const r of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(r) || typeof r.date !== "string") continue;
    const d = r.date.trim();
    if (!isValidDateStr(d)) continue;
    if (!latestAccDate || d > latestAccDate) latestAccDate = d;
  }
  if (latestAccDate) return latestAccDate;

  return formatUtc8Date(nowVal);
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
            const p = typeof w.platform === "string" && w.platform.trim() ? w.platform.trim() : platform;
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
 * 预处理作品日明细：
 * 1. 截断到 date <= to
 * 2. 按 (date, platform, workId) 跨组去重（同一作品跨多分组只保留按分组名排序第一组的一份观测）
 * 3. 按作品 (platform|workId) 整理升序时间序列
 * 4. 识别所有「疑似采集异常（某指标当日为 0 或缺失，前后有记录日均 >0）」并在时间序列中剔除
 * 5. 基于剔除异常后的有效序列重新计算各项指标日增
 */
function prepareWorkSeries(dailyRows, cutoffTo, summaryWorkToContent) {
  const dedupByDayWork = new Map();
  const snapshotDates = new Set();

  for (const raw of Array.isArray(dailyRows) ? dailyRows : []) {
    if (!isPlainObject(raw)) continue;
    const date = typeof raw.date === "string" ? raw.date.trim() : "";
    if (!isValidDateStr(date) || date > cutoffTo) continue;
    const platform = raw.platform == null ? "" : String(raw.platform).trim();
    const workId = raw.workId == null ? "" : String(raw.workId).trim();
    if (!platform || !workId) continue;

    snapshotDates.add(date);

    const group = raw.group == null ? "" : String(raw.group);
    const dedupKey = `${date}\0${platform}\0${workId}`;
    const existing = dedupByDayWork.get(dedupKey);
    if (!existing || compareText(group, existing.group) < 0) {
      const metrics = {};
      for (const k of WORK_STAT_KEYS) {
        metrics[k] = hasOwn(raw, k) ? normalizeMetric(raw[k]) : null;
      }
      const pubMs = parseTimestampMs(raw.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : toUtc8DateStr(raw.publishDate);
      const pwKey = `${platform}|${workId}`;
      const explicitCk =
        typeof raw.contentKey === "string" && raw.contentKey.trim()
          ? raw.contentKey.trim()
          : "";
      const fallbackCk =
        !explicitCk && summaryWorkToContent instanceof Map
          ? summaryWorkToContent.get(pwKey) || ""
          : "";
      const contentKey = explicitCk || fallbackCk || `unlinked:${platform}:${workId}`;

      dedupByDayWork.set(dedupKey, {
        date,
        dayNum: dateStrToDayNum(date),
        group,
        platform,
        workId,
        pwKey,
        title: typeof raw.title === "string" && raw.title ? raw.title : "(无标题)",
        url: typeof raw.url === "string" ? raw.url : "",
        publishTimeMs: pubMs,
        publishDate: pubDate,
        contentKey,
        rawContentKey: explicitCk || fallbackCk || null,
        metrics,
      });
    }
  }

  const byWork = new Map();
  for (const obs of dedupByDayWork.values()) {
    let list = byWork.get(obs.pwKey);
    if (!list) {
      list = [];
      byWork.set(obs.pwKey, list);
    }
    list.push(obs);
  }

  const seriesByWork = new Map();
  const allCollectionAnomalies = [];

  for (const [pwKey, points] of byWork.entries()) {
    points.sort((a, b) => a.dayNum - b.dayNum);
    const n = points.length;

    // 针对每个指标分别检测「掉 0 或缺失后回升」
    const excludedByMetric = {};
    for (const k of WORK_STAT_KEYS) {
      excludedByMetric[k] = new Uint8Array(n);
      const firstPosIdx = [];
      let seenPos = -1;
      for (let i = 0; i < n; i++) {
        firstPosIdx[i] = seenPos;
        const v = points[i].metrics[k];
        if (v !== null && v > 0) seenPos = i;
      }
      let nextPos = -1;
      for (let i = n - 1; i >= 0; i--) {
        const v = points[i].metrics[k];
        const prevPosIdx = firstPosIdx[i];
        if ((v === 0 || v === null) && prevPosIdx !== -1 && nextPos !== -1) {
          excludedByMetric[k][i] = 1;
          allCollectionAnomalies.push({
            date: points[i].date,
            platform: points[i].platform,
            group: points[i].group,
            workId: points[i].workId,
            pwKey,
            contentKey: points[i].contentKey,
            title: points[i].title,
            url: points[i].url,
            metric: k,
            metricLabel: METRIC_LABELS[k] || k,
            value: v,
            prevDate: points[prevPosIdx].date,
            prevValue: points[prevPosIdx].metrics[k],
            nextDate: points[nextPos].date,
            nextValue: points[nextPos].metrics[k],
          });
        }
        if (v !== null && v > 0) nextPos = i;
      }
    }

    // 基于剔除异常点后的有效序列重算各指标日增与有效值
    const cleanPoints = [];
    const lastValid = {};
    for (const k of WORK_STAT_KEYS) lastValid[k] = null;

    let workTitle = "(无标题)";
    let workUrl = "";
    let workPubMs = null;
    let workPubDate = "";
    let workContentKey = points[n - 1].contentKey;
    let workPlatform = points[0].platform;
    let workId = points[0].workId;
    let workGroup = points[0].group;

    for (let i = 0; i < n; i++) {
      const pt = points[i];
      if (pt.title && pt.title !== "(无标题)") workTitle = pt.title;
      if (pt.url) workUrl = pt.url;
      if (pt.publishTimeMs !== null && (workPubMs === null || pt.publishTimeMs < workPubMs)) {
        workPubMs = pt.publishTimeMs;
      }
      if (pt.publishDate && (!workPubDate || pt.publishDate < workPubDate)) {
        workPubDate = pt.publishDate;
      }
      if (pt.rawContentKey) workContentKey = pt.rawContentKey;

      const values = {};
      const deltas = {};
      const daySpans = {};
      const excluded = {};

      for (const k of WORK_STAT_KEYS) {
        if (excludedByMetric[k][i]) {
          excluded[k] = true;
          values[k] = null;
          deltas[k] = null;
          daySpans[k] = null;
          continue;
        }
        excluded[k] = false;
        const curr = pt.metrics[k];
        values[k] = curr;
        if (curr === null) {
          deltas[k] = null;
          daySpans[k] = null;
        } else if (lastValid[k] === null) {
          deltas[k] = null;
          daySpans[k] = null;
          lastValid[k] = { value: curr, dayNum: pt.dayNum, date: pt.date };
        } else {
          deltas[k] = normalizeZero(curr - lastValid[k].value);
          daySpans[k] = pt.dayNum - lastValid[k].dayNum;
          lastValid[k] = { value: curr, dayNum: pt.dayNum, date: pt.date };
        }
      }

      cleanPoints.push({
        date: pt.date,
        dayNum: pt.dayNum,
        platform: pt.platform,
        group: pt.group,
        workId: pt.workId,
        pwKey,
        contentKey: pt.contentKey,
        title: pt.title,
        url: pt.url,
        values,
        deltas,
        daySpans,
        excluded,
      });
    }

    if (workPubMs !== null) {
      workPubDate = toUtc8DateStr(workPubMs);
    }

    seriesByWork.set(pwKey, {
      pwKey,
      platform: workPlatform,
      group: workGroup,
      workId,
      contentKey: workContentKey,
      title: workTitle,
      url: workUrl,
      publishTimeMs: workPubMs,
      publishDate: workPubDate,
      points: cleanPoints,
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
    snapshotDays: snapshotDates.size,
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

/** 1. 总览：本周期 vs 上一周期的 6 项日增合计、环比%、各平台播放贡献占比 */
function buildOverviewSection(
  seriesByWork,
  accountRows,
  { currentStart, currentEnd, prevStart, prevEnd }
) {
  const curSums = {};
  const prevSums = {};
  for (const k of WORK_STAT_KEYS) {
    curSums[k] = null;
    prevSums[k] = null;
  }

  const byPlatform = new Map();

  for (const series of seriesByWork.values()) {
    for (const pt of series.points) {
      const inCur = pt.date >= currentStart && pt.date <= currentEnd;
      const inPrev = !inCur && pt.date >= prevStart && pt.date <= prevEnd;
      if (!inCur && !inPrev) continue;

      if (inCur) {
        let ptAgg = byPlatform.get(pt.platform);
        if (!ptAgg) {
          ptAgg = { platform: pt.platform };
          for (const k of WORK_STAT_KEYS) ptAgg[k] = null;
          byPlatform.set(pt.platform, ptAgg);
        }
        for (const k of WORK_STAT_KEYS) {
          curSums[k] = addNullable(curSums[k], pt.deltas[k]);
          ptAgg[k] = addNullable(ptAgg[k], pt.deltas[k]);
        }
      } else {
        for (const k of WORK_STAT_KEYS) {
          prevSums[k] = addNullable(prevSums[k], pt.deltas[k]);
        }
      }
    }
  }

  const metrics = {};
  for (const k of WORK_STAT_KEYS) {
    metrics[k] = {
      key: k,
      label: METRIC_LABELS[k] || k,
      current: curSums[k],
      previous: prevSums[k],
      momPct: computeMomPct(curSums[k], prevSums[k]),
    };
  }

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

  // 补充账号级日增（来自 accountRows，可选展示）
  let accFansCur = null;
  let accFansPrev = null;
  let accPlaysCur = null;
  let accPlaysPrev = null;
  for (const ar of Array.isArray(accountRows) ? accountRows : []) {
    if (!isPlainObject(ar) || typeof ar.date !== "string") continue;
    const d = ar.date.trim();
    if (!isValidDateStr(d) || d > currentEnd) continue;
    const fd = normalizeMetric(ar.fansDelta);
    const pd = normalizeMetric(ar.playsDelta);
    if (d >= currentStart && d <= currentEnd) {
      accFansCur = addNullable(accFansCur, fd);
      accPlaysCur = addNullable(accPlaysCur, pd);
    } else if (d >= prevStart && d <= prevEnd) {
      accFansPrev = addNullable(accFansPrev, fd);
      accPlaysPrev = addNullable(accPlaysPrev, pd);
    }
  }

  return {
    metrics,
    platformContribution,
    accountSummary: {
      fansDelta: {
        current: accFansCur,
        previous: accFansPrev,
        momPct: computeMomPct(accFansCur, accFansPrev),
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
 * 归一化内容级跨平台汇总行，提取每条内容的按平台汇总指标（同一平台多分组求和）。
 */
function normalizeContentRows(summaryRows, cutoffTo) {
  const out = [];
  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!isPlainObject(row) || !row.contentKey) continue;
    const firstPublishDate =
      typeof row.firstPublishDate === "string" && isValidDateStr(row.firstPublishDate.trim())
        ? row.firstPublishDate.trim()
        : "";
    if (firstPublishDate && firstPublishDate > cutoffTo) continue;

    const byPlatform = new Map();
    if (isPlainObject(row.perPlatform)) {
      for (const [pgKey, cell] of Object.entries(row.perPlatform)) {
        if (!isPlainObject(cell)) continue;
        const { platform } = parsePgKey(pgKey);
        if (!platform) continue;
        let agg = byPlatform.get(platform);
        if (!agg) {
          agg = {
            platform,
            play: null,
            like: null,
            comment: null,
            share: null,
            favorite: null,
            fansDelta: null,
          };
          byPlatform.set(platform, agg);
        }
        for (const k of WORK_STAT_KEYS) {
          const v = hasOwn(cell, k) ? normalizeMetric(cell[k]) : null;
          agg[k] = addNullable(agg[k], v);
        }
      }
    }

    // 仅保留至少有一项非空指标的平台
    const activePlatforms = [];
    for (const agg of byPlatform.values()) {
      const hasAny = WORK_STAT_KEYS.some((k) => agg[k] !== null);
      if (hasAny) activePlatforms.push(agg);
    }
    activePlatforms.sort((a, b) => comparePlatform(a.platform, b.platform));

    const totalPlay = hasOwn(row, "totalPlay") ? normalizeMetric(row.totalPlay) : null;
    const totalLike = hasOwn(row, "totalLike") ? normalizeMetric(row.totalLike) : null;
    const totalComment = hasOwn(row, "totalComment") ? normalizeMetric(row.totalComment) : null;
    const totalShare = hasOwn(row, "totalShare") ? normalizeMetric(row.totalShare) : null;
    const totalFavorite = hasOwn(row, "totalFavorite") ? normalizeMetric(row.totalFavorite) : null;
    const totalFansDelta = hasOwn(row, "totalFansDelta")
      ? normalizeMetric(row.totalFansDelta)
      : null;

    out.push({
      contentKey: String(row.contentKey),
      title: typeof row.title === "string" && row.title ? row.title : "(无标题)",
      file: typeof row.file === "string" ? row.file : "",
      firstPublishDate,
      isUnlinked: Boolean(
        row.isUnlinked || String(row.contentKey).startsWith("unlinked:")
      ),
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

function computeItemEngagementRate(play, like, comment, share) {
  if (typeof play !== "number" || !Number.isFinite(play) || play <= 0) return null;
  const hasAnyInteraction = like !== null || comment !== null || share !== null;
  if (!hasAnyInteraction) return null;
  const interactions = (like || 0) + (comment || 0) + (share || 0);
  return interactions / play;
}

/** 2. 平台对比：只取覆盖 ≥2 平台的内容 */
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
          engRateSum: 0,
          engRateCount: 0,
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
      const rate = computeItemEngagementRate(p.play, p.like, p.comment, p.share);
      if (rate !== null) {
        bucket.engRateSum += rate;
        bucket.engRateCount += 1;
      }
      if (p.fansDelta !== null) {
        bucket.fansSum += p.fansDelta;
        bucket.fansCount += 1;
      }
    }
  }

  const platforms = [...statsByPlatform.values()]
    .map((b) => {
      const avgPlay = b.playCount > 0 ? round2(b.playSum / b.playCount) : null;
      const engagementRate =
        b.engRateCount > 0 ? round4(b.engRateSum / b.engRateCount) : null;
      const engagementRatePct =
        engagementRate !== null ? round2(engagementRate * 100) : null;
      const avgFansDelta = b.fansCount > 0 ? round2(b.fansSum / b.fansCount) : null;
      const lowSample = b.sampleCount < LOW_SAMPLE_THRESHOLD;
      return {
        platform: b.platform,
        sampleCount: b.sampleCount,
        avgPlay,
        engagementRate,
        engagementRatePct,
        engagementSampleCount: b.engRateCount,
        avgFansDelta,
        lowSample,
        note: lowSample ? "样本少，仅供参考" : "",
      };
    })
    .sort((a, b) => {
      const ap = a.avgPlay === null ? -Infinity : a.avgPlay;
      const bp = b.avgPlay === null ? -Infinity : b.avgPlay;
      if (bp !== ap) return bp - ap;
      return comparePlatform(a.platform, b.platform);
    });

  // 规则生成 1–3 句中文结论
  const conclusions = [];
  if (multiPlatformContents.length === 0 || platforms.length < 2) {
    conclusions.push("暂无覆盖 2 个及以上平台的同款内容，无法进行跨平台对比。");
  } else {
    const withPlay = platforms.filter((p) => p.avgPlay !== null);
    const withEng = [...platforms]
      .filter((p) => p.engagementRate !== null)
      .sort((a, b) => {
        if (b.engagementRate !== a.engagementRate) {
          return b.engagementRate - a.engagementRate;
        }
        return comparePlatform(a.platform, b.platform);
      });
    const withFans = [...platforms]
      .filter((p) => p.avgFansDelta !== null)
      .sort((a, b) => {
        if (b.avgFansDelta !== a.avgFansDelta) return b.avgFansDelta - a.avgFansDelta;
        return comparePlatform(a.platform, b.platform);
      });

    const topPlay = withPlay[0] || null;
    const lowestPlay = withPlay.length >= 2 ? withPlay[withPlay.length - 1] : null;
    const topEng = withEng[0] || null;
    const topFans = withFans[0] || null;

    // 句 1：播放与互动率对比
    if (topPlay && topEng && topPlay.platform !== topEng.platform) {
      conclusions.push(
        `${topEng.platform}播放低于${topPlay.platform}（均播 ${formatIntText(
          topEng.avgPlay
        )} vs ${formatIntText(topPlay.avgPlay)}），但互动率最高（${formatPctFromRate(
          topEng.engagementRate
        )}）。`
      );
    } else if (topPlay && topEng) {
      conclusions.push(
        `${topPlay.platform}综合表现领先，平均播放（${formatIntText(
          topPlay.avgPlay
        )}）与互动率（${formatPctFromRate(topEng.engagementRate)}）均居各平台首位。`
      );
    } else if (topPlay) {
      conclusions.push(
        `${topPlay.platform}平均播放最高（${formatIntText(topPlay.avgPlay)}）。`
      );
    } else if (topEng) {
      conclusions.push(
        `${topEng.platform}互动率最高（${formatPctFromRate(topEng.engagementRate)}）。`
      );
    }

    // 句 2：涨粉或高低播差距
    if (topFans && topFans.avgFansDelta > 0) {
      conclusions.push(
        `涨粉效率方面，${topFans.platform}表现最佳，单内容平均涨粉 ${round2(
          topFans.avgFansDelta
        )}。`
      );
    } else if (
      topPlay &&
      lowestPlay &&
      topPlay.platform !== lowestPlay.platform &&
      lowestPlay.avgPlay > 0
    ) {
      const ratio = round2(topPlay.avgPlay / lowestPlay.avgPlay);
      conclusions.push(
        `${topPlay.platform}平均播放约为${lowestPlay.platform}的 ${ratio} 倍（基于 ${multiPlatformContents.length} 条跨平台同款内容）。`
      );
    }

    // 句 3：低样本提示
    const lowPlatforms = platforms.filter((p) => p.lowSample).map((p) => p.platform);
    if (lowPlatforms.length > 0 || multiPlatformContents.length < LOW_SAMPLE_THRESHOLD) {
      const scope =
        lowPlatforms.length === platforms.length
          ? "各平台"
          : lowPlatforms.join("、");
      conclusions.push(`${scope}跨平台对比样本不足 ${LOW_SAMPLE_THRESHOLD} 条，样本少，仅供参考。`);
    }
  }

  return {
    multiPlatformContentCount: multiPlatformContents.length,
    lowSample:
      multiPlatformContents.length < LOW_SAMPLE_THRESHOLD ||
      platforms.some((p) => p.lowSample),
    platforms,
    conclusions: conclusions.slice(0, 3),
  };
}

/** 3. 作品排行（总播放 / 互动率[总播放>=100] / 总涨粉 各 Top10 & Bottom10）+ 平台偏科 */
function buildRankingsSection(contentRows) {
  const enriched = contentRows.map((c) => {
    const rawEng = computeItemEngagementRate(
      c.totalPlay,
      c.totalLike,
      c.totalComment,
      c.totalShare
    );
    const engagementEligible =
      c.totalPlay !== null && c.totalPlay >= ENGAGEMENT_MIN_PLAY && rawEng !== null;
    const engagementRate = rawEng !== null ? round4(rawEng) : null;
    const engagementRatePct =
      engagementRate !== null ? round2(engagementRate * 100) : null;
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
      engagementRate,
      engagementRatePct,
      engagementEligible,
    };
  });

  const toRankItem = (item) => ({
    contentKey: item.contentKey,
    title: item.title,
    firstPublishDate: item.firstPublishDate,
    platformCount: item.platformCount,
    totalPlay: item.totalPlay,
    engagementRate: item.engagementRate,
    engagementRatePct: item.engagementRatePct,
    totalFansDelta: item.totalFansDelta,
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
      if (b.engagementRate !== a.engagementRate) {
        return b.engagementRate - a.engagementRate;
      }
      if (b.totalPlay !== a.totalPlay) return b.totalPlay - a.totalPlay;
      return compareText(a.contentKey, b.contentKey);
    })
    .slice(0, RANKING_LIMIT)
    .map(toRankItem);
  const byEngBottom = [...engEligible]
    .sort((a, b) => {
      if (a.engagementRate !== b.engagementRate) {
        return a.engagementRate - b.engagementRate;
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

/** 取某作品在 <= targetDate（且 >= minDate，可选）的最近一次非异常播放累计值 */
function resolveWorkPlayAsOf(series, targetDate, minDate) {
  let best = null;
  for (const pt of series.points) {
    if (pt.date > targetDate) break;
    if (minDate && pt.date < minDate) continue;
    if (pt.excluded.play) continue;
    if (pt.values.play !== null) {
      best = pt.values.play;
    }
  }
  return best;
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

/** 4. 新作品走势（本周期发布内容，按 UTC+8 日历日计算发布后 D1/D3/D7 累计播放并分类） */
function buildNewWorksSection(seriesByWork, contentRows, { currentStart, to }) {
  const contentMetaByKey = new Map();
  for (const c of contentRows) {
    contentMetaByKey.set(c.contentKey, c);
  }

  // 按 contentKey 归组作品时间序列
  const worksByContent = new Map();
  for (const series of seriesByWork.values()) {
    const ck = series.contentKey;
    let arr = worksByContent.get(ck);
    if (!arr) {
      arr = [];
      worksByContent.set(ck, arr);
    }
    arr.push(series);
  }

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
    const workList = worksByContent.get(contentKey) || [];

    // 确定内容首发日期（优先取作品最早有效发布日，否则取汇总行 firstPublishDate）
    let minWorkPubDate = "";
    for (const w of workList) {
      if (w.publishDate && (!minWorkPubDate || w.publishDate < minWorkPubDate)) {
        minWorkPubDate = w.publishDate;
      }
    }
    const contentPubDate = minWorkPubDate || (meta && meta.firstPublishDate) || "";
    if (!contentPubDate || contentPubDate < currentStart || contentPubDate > to) {
      continue;
    }

    // 按平台分组该内容下的作品
    const worksByPlatform = new Map();
    for (const w of workList) {
      let arr = worksByPlatform.get(w.platform);
      if (!arr) {
        arr = [];
        worksByPlatform.set(w.platform, arr);
      }
      arr.push(w);
    }

    const platformRows = [];
    const sortedPlatforms = [...worksByPlatform.keys()].sort(comparePlatform);
    for (const platform of sortedPlatforms) {
      const pWorks = worksByPlatform.get(platform);
      let pPubDate = "";
      for (const w of pWorks) {
        if (w.publishDate && (!pPubDate || w.publishDate < pPubDate)) {
          pPubDate = w.publishDate;
        }
      }
      if (!pPubDate) pPubDate = contentPubDate;

      const milestoneVals = {};
      for (const dayN of NEW_WORK_MILESTONES) {
        const targetDate = shiftDateStr(pPubDate, dayN);
        if (targetDate > to) {
          milestoneVals[dayN] = null;
          continue;
        }
        let sum = null;
        for (const w of pWorks) {
          const wPub = w.publishDate || pPubDate;
          const v = resolveWorkPlayAsOf(w, targetDate, wPub);
          sum = addNullable(sum, v);
        }
        milestoneVals[dayN] = sum;
      }

      let latestPlay = null;
      for (const w of pWorks) {
        const wPub = w.publishDate || pPubDate;
        latestPlay = addNullable(latestPlay, resolveWorkPlayAsOf(w, to, wPub));
      }

      const d1Play = milestoneVals[1];
      const d3Play = milestoneVals[3];
      const d7Play = milestoneVals[7];
      const d3ToD1 =
        d1Play !== null && d1Play > 0 && d3Play !== null ? round2(d3Play / d1Play) : null;
      const d7ToD3 =
        d3Play !== null && d3Play > 0 && d7Play !== null ? round2(d7Play / d3Play) : null;
      const category = classifyTrajectory(d1Play, d3Play, d7Play);

      platformRows.push({
        platform,
        publishDate: pPubDate,
        d1Play,
        d3Play,
        d7Play,
        latestPlay,
        d3ToD1,
        d7ToD3,
        category,
      });
    }

    // 内容级合计 D1/D3/D7（基于各平台：仅当该内容所有平台均已到达第 N 天时才汇总，未到期为空）
    const totalMilestones = {};
    for (const dayN of NEW_WORK_MILESTONES) {
      if (platformRows.length === 0) {
        totalMilestones[dayN] = null;
        continue;
      }
      const allReached = platformRows.every(
        (pr) => shiftDateStr(pr.publishDate, dayN) <= to
      );
      if (!allReached) {
        totalMilestones[dayN] = null;
        continue;
      }
      let sum = null;
      const key = `d${dayN}Play`;
      for (const pr of platformRows) {
        sum = addNullable(sum, pr[key]);
      }
      totalMilestones[dayN] = sum;
    }

    let totalLatestPlay = null;
    for (const pr of platformRows) {
      totalLatestPlay = addNullable(totalLatestPlay, pr.latestPlay);
    }

    const d1Play = totalMilestones[1];
    const d3Play = totalMilestones[3];
    const d7Play = totalMilestones[7];
    const d3ToD1 =
      d1Play !== null && d1Play > 0 && d3Play !== null ? round2(d3Play / d1Play) : null;
    const d7ToD3 =
      d3Play !== null && d3Play > 0 && d7Play !== null ? round2(d7Play / d3Play) : null;
    const category = classifyTrajectory(d1Play, d3Play, d7Play);
    categoryCounts[category] += 1;

    const title =
      (meta && meta.title) ||
      (workList[0] && workList[0].title) ||
      "(无标题)";

    items.push({
      contentKey,
      title,
      publishDate: contentPubDate,
      platformCount: platformRows.length,
      d1Play,
      d3Play,
      d7Play,
      latestPlay: totalLatestPlay,
      d3ToD1,
      d7ToD3,
      category,
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

/** 5. 发布时间：按发布的 UTC+8 星期几 × 时段分组，算平均 D7 播放（不足 7 天用最新累计并标注） */
function buildPublishTimeSection(seriesByWork, cutoffTo) {
  const worksByContent = new Map();
  for (const series of seriesByWork.values()) {
    const ck = series.contentKey;
    let arr = worksByContent.get(ck);
    if (!arr) {
      arr = [];
      worksByContent.set(ck, arr);
    }
    arr.push(series);
  }

  const slotBuckets = new Map();

  for (const workList of worksByContent.values()) {
    let minPubMs = null;
    for (const w of workList) {
      if (w.publishTimeMs !== null && (minPubMs === null || w.publishTimeMs < minPubMs)) {
        minPubMs = w.publishTimeMs;
      }
    }
    if (minPubMs === null) continue;
    const contentPubDate = toUtc8DateStr(minPubMs);
    if (!contentPubDate || contentPubDate > cutoffTo) continue;

    let totalD7Play = null;
    let usedFallback = false;

    for (const w of workList) {
      const wPubDate = w.publishDate || contentPubDate;
      if (wPubDate > cutoffTo) continue;
      const d7Date = shiftDateStr(wPubDate, 7);
      if (d7Date <= cutoffTo) {
        const v = resolveWorkPlayAsOf(w, d7Date, wPubDate);
        totalD7Play = addNullable(totalD7Play, v);
      } else {
        const v = resolveWorkPlayAsOf(w, cutoffTo, wPubDate);
        if (v !== null) {
          totalD7Play = addNullable(totalD7Play, v);
          usedFallback = true;
        }
      }
    }

    if (totalD7Play === null) continue;

    const { weekday, weekdayLabel, slot, slotLabel } = resolveUtc8WeekdayAndSlot(minPubMs);
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

/** 6. 异常提醒：疑似采集异常（本周期内）+ 疑似上推荐（单日播放日增 >= 前7天日均*5 且 >= 1000） */
function buildAnomaliesSection(seriesByWork, allCollectionAnomalies, { currentStart, to }) {
  const collectionAnomalies = allCollectionAnomalies.filter(
    (a) => a.date >= currentStart && a.date <= to
  );

  const recommendSpikes = [];

  for (const series of seriesByWork.values()) {
    const pts = series.points;
    for (let i = 0; i < pts.length; i++) {
      const pt = pts[i];
      if (pt.date < currentStart || pt.date > to) continue;
      if (pt.excluded.play) continue;
      const rawDelta = pt.deltas.play;
      const span = pt.daySpans.play;
      if (rawDelta === null || span === null || span <= 0) continue;

      const dailyPlayDelta = span === 1 ? rawDelta : rawDelta / span;
      if (dailyPlayDelta < RECOMMEND_SPIKE_MIN_PLAY_DELTA) continue;

      // 计算前 7 天 [d - 7, d - 1] 的有效日均播放日增
      const minBaselineDay = pt.dayNum - RECOMMEND_BASELINE_DAYS;
      const maxBaselineDay = pt.dayNum - 1;
      let baseDeltaSum = 0;
      let baseDaySpanSum = 0;
      let basePointCount = 0;

      for (let j = i - 1; j >= 0; j--) {
        const prev = pts[j];
        if (prev.dayNum < minBaselineDay) break;
        if (prev.dayNum > maxBaselineDay) continue;
        if (prev.excluded.play) continue;
        if (prev.deltas.play === null || prev.daySpans.play === null || prev.daySpans.play <= 0) {
          continue;
        }
        baseDeltaSum += prev.deltas.play;
        baseDaySpanSum += prev.daySpans.play;
        basePointCount += 1;
      }

      if (basePointCount === 0 || baseDaySpanSum <= 0) continue;

      const baselineAvg = baseDeltaSum / baseDaySpanSum;
      const effectiveBaseline = Math.max(0, baselineAvg);
      if (dailyPlayDelta >= effectiveBaseline * RECOMMEND_SPIKE_MULTIPLIER) {
        recommendSpikes.push({
          date: pt.date,
          platform: pt.platform,
          group: pt.group,
          workId: pt.workId,
          pwKey: pt.pwKey,
          contentKey: pt.contentKey,
          title: pt.title || series.title,
          url: pt.url || series.url,
          playDelta: rawDelta,
          daySpan: span,
          dailyPlayDelta: round2(dailyPlayDelta),
          baselineAvg: round2(baselineAvg),
          baselineDays: baseDaySpanSum,
          ratio: effectiveBaseline > 0 ? round2(dailyPlayDelta / effectiveBaseline) : null,
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
    recommendSpikes,
    excludedPointCount: allCollectionAnomalies.length,
    totalCount: collectionAnomalies.length + recommendSpikes.length,
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

  // 1. 总量与环比
  const m = overview.metrics;
  if (
    m.play.current === null &&
    m.like.current === null &&
    m.comment.current === null &&
    m.fansDelta.current === null
  ) {
    lines.push(`总量与环比：近${period}天（${currentStart} ~ ${to}）暂无可计算的作品日增数据。`);
  } else {
    const parts = [
      `新增播放 ${formatIntText(m.play.current)}（环比 ${formatMomText(m.play.momPct)}）`,
      `点赞 ${formatIntText(m.like.current)}（环比 ${formatMomText(m.like.momPct)}）`,
      `评论 ${formatIntText(m.comment.current)}`,
    ];
    if (m.fansDelta.current !== null) {
      parts.push(`涨粉 ${formatIntText(m.fansDelta.current)}（环比 ${formatMomText(m.fansDelta.momPct)}）`);
    }
    lines.push(`总量与环比：近${period}天（${currentStart} ~ ${to}）${parts.join("、")}。`);
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
  } else if (overview.platformContribution.length > 0 && overview.platformContribution[0].play !== null) {
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

/**
 * 纯函数构建数据分析结果（7 节），供 GUI「数据分析」tab 与 Excel「分析」sheet 共用。
 *
 * @param {object} params
 * @param {Array<object>} [params.dailyRows]    作品日明细行（建议含截止日之前足够历史以支持环比与7天基线）
 * @param {Array<object>} [params.summaryRows]  跨平台内容汇总行（截至 to）
 * @param {Array<object>} [params.accountRows]  账号日快照行（截至 to）
 * @param {string} [params.to]                  截止日期 YYYY-MM-DD（默认最新作品快照日，回退账号快照日/当天）
 * @param {number} [params.period=30]           分析周期天数（7 / 30 或导出区间天数）
 * @param {number|Date} [params.now]            注入当前时间（无数据时兜底计算截止日，保证确定性）
 */
function buildStatsAnalysis({
  dailyRows = [],
  summaryRows = [],
  accountRows = [],
  to,
  period = DEFAULT_ANALYSIS_PERIOD,
  now = Date.now(),
} = {}) {
  const resolvedPeriod = resolvePeriod(period);
  const resolvedTo = resolveToDate(to, dailyRows, accountRows, now);
  const currentStart = shiftDateStr(resolvedTo, -(resolvedPeriod - 1));
  const prevEnd = shiftDateStr(currentStart, -1);
  const prevStart = shiftDateStr(currentStart, -resolvedPeriod);

  // 先做去重、采集异常识别与异常剔除后日增重算（确保第 1–5 节均基于清洗后序列）
  const summaryWorkToContent = buildSummaryWorkToContentMap(summaryRows);
  const { seriesByWork, allCollectionAnomalies, snapshotDays } = prepareWorkSeries(
    dailyRows,
    resolvedTo,
    summaryWorkToContent
  );

  const contentRows = normalizeContentRows(summaryRows, resolvedTo);

  const overview = buildOverviewSection(seriesByWork, accountRows, {
    currentStart,
    currentEnd: resolvedTo,
    prevStart,
    prevEnd,
  });

  const platformComparison = buildPlatformComparisonSection(contentRows);
  const rankings = buildRankingsSection(contentRows);
  const newWorks = buildNewWorksSection(seriesByWork, contentRows, {
    currentStart,
    to: resolvedTo,
  });
  const publishTime = buildPublishTimeSection(seriesByWork, resolvedTo);
  const anomalies = buildAnomaliesSection(seriesByWork, allCollectionAnomalies, {
    currentStart,
    to: resolvedTo,
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

  return {
    to: resolvedTo,
    period: resolvedPeriod,
    currentRange: { from: currentStart, to: resolvedTo },
    previousRange: { from: prevStart, to: prevEnd },
    snapshotDays,
    thresholds: ANALYSIS_THRESHOLDS,
    overview,
    platformComparison,
    rankings,
    newWorks,
    publishTime,
    anomalies,
    summary,
  };
}

module.exports = {
  DEFAULT_ANALYSIS_PERIOD,
  MIN_PLATFORM_COMPARE_PLATFORMS,
  LOW_SAMPLE_THRESHOLD,
  ENGAGEMENT_MIN_PLAY,
  RANKING_LIMIT,
  PLATFORM_SKEW_RATIO,
  PLATFORM_SKEW_MIN_PLAY,
  NEW_WORK_MILESTONES,
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
  ANALYSIS_THRESHOLDS,
  classifyTrajectory,
  buildStatsAnalysis,
};
