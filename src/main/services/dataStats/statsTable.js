"use strict";

/**
 * 作品日快照长表行构建（纯函数模块，不依赖 electron / fs）。
 *
 * 将 works.json 的作品元信息与 works-daily.json 的按日累计快照展开为长表行，
 * 并计算相对「上一个有记录日期」的日增量与断档天数（gapDays）。
 */

const WORK_STAT_KEYS = ["play", "like", "comment", "share", "favorite", "fansDelta"];
const DELETED_WORK_TITLE = "(已删除或未匹配)";
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL_NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;

/** 解析 YYYY-MM-DD 为 UTC 零点毫秒时间戳，非法日期返回 null */
function parseDateDayMs(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) return null;
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== dateStr) return null;
  return ms;
}

/** 将 publishTime（毫秒时间戳 / ISO 字符串 / Date）规范化为 { ms, iso } */
function parsePublishTime(raw) {
  if (raw == null || raw === "") return { ms: 0, iso: "" };
  let ms = NaN;
  if (typeof raw === "number") {
    ms = raw;
  } else if (raw instanceof Date) {
    ms = raw.getTime();
  } else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return { ms: 0, iso: "" };
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms) || ms <= 0) return { ms: 0, iso: "" };
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t) || t <= 0) return { ms: 0, iso: "" };
  return { ms: t, iso: d.toISOString() };
}

/**
 * 统一指标校验：仅接受有限 number，或去空白后非空且为合法十进制数字的字符串；
 * 其余值（空白串、数组、对象、布尔、NaN、Infinity 等）一律归为 null。
 */
function normalizeMetric(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    return v === 0 ? 0 : v;
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed || !DECIMAL_NUM_RE.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return n === 0 ? 0 : n;
  }
  return null;
}

/**
 * 构建单个「分组 × 平台」的作品日快照长表行。
 *
 * @param {object} params
 * @param {string} [params.group]
 * @param {string} [params.platform]
 * @param {Array<object>} [params.works]       作品元信息数组（works.json 中的 works）
 * @param {object} [params.worksDaily]         作品日快照对象（works-daily.json）
 * @param {string} [params.from]               起始日期 YYYY-MM-DD（含），可省
 * @param {string} [params.to]                 截止日期 YYYY-MM-DD（含），可省
 * @param {Map} [params.link]                  可选，linkWorks 返回的 Map；传入时行增加 contentKey / matchedBy / matchScore
 * @returns {Array<object>}
 */
function buildWorkDailyRows({ group, platform, works, worksDaily, from, to, link } = {}) {
  if (!worksDaily || typeof worksDaily !== "object" || Array.isArray(worksDaily)) {
    return [];
  }

  const groupStr = group == null ? "" : String(group);
  const platformStr = platform == null ? "" : String(platform);
  const fromStr = typeof from === "string" && from.trim() ? from.trim() : "";
  const toStr = typeof to === "string" && to.trim() ? to.trim() : "";
  const hasLink = link instanceof Map;

  const workById = new Map();
  if (Array.isArray(works)) {
    for (const w of works) {
      if (w && w.workId != null && w.workId !== "") {
        workById.set(String(w.workId), w);
      }
    }
  }

  const entries = [];

  for (const [rawWorkId, dateMap] of Object.entries(worksDaily)) {
    if (!dateMap || typeof dateMap !== "object" || Array.isArray(dateMap)) continue;
    const workId = String(rawWorkId);
    const linkInfo = hasLink
      ? link.get(`${groupStr}|${platformStr}|${workId}`) ||
        link.get(`${platformStr}|${workId}`) ||
        null
      : null;
    const meta = workById.get(workId);
    const title = meta ? meta.title || "(无标题)" : DELETED_WORK_TITLE;
    const url = meta ? meta.url || "" : "";
    const { ms: publishTimeMs, iso: publishTime } = meta
      ? parsePublishTime(meta.publishTime)
      : { ms: 0, iso: "" };

    // 按日期升序整理该作品的全部有效日快照，确保增量与断档计算不受键序或过滤影响
    const points = [];
    for (const [date, snap] of Object.entries(dateMap)) {
      if (!snap || typeof snap !== "object" || Array.isArray(snap)) continue;
      const dayMs = parseDateDayMs(date);
      if (dayMs === null) continue;
      points.push({ date, dayMs, snap });
    }
    points.sort((a, b) => a.dayMs - b.dayMs);

    let prevPoint = null;
    let prevValues = null;

    for (const point of points) {
      const values = {};
      const deltas = {};
      for (const k of WORK_STAT_KEYS) {
        const rawVal = Object.prototype.hasOwnProperty.call(point.snap, k)
          ? point.snap[k]
          : null;
        const curr = normalizeMetric(rawVal);
        values[k] = curr;
        if (!prevValues || curr === null || prevValues[k] === null) {
          deltas[`${k}Delta`] = null;
        } else {
          deltas[`${k}Delta`] = curr - prevValues[k];
        }
      }

      const gapDays = prevPoint
        ? Math.round((point.dayMs - prevPoint.dayMs) / DAY_MS) - 1
        : null;

      prevPoint = point;
      prevValues = values;

      if (fromStr && point.date < fromStr) continue;
      if (toStr && point.date > toStr) continue;

      const row = {
        date: point.date,
        group: groupStr,
        platform: platformStr,
        workId,
        title,
        url,
        publishTime,
        play: values.play,
        like: values.like,
        comment: values.comment,
        share: values.share,
        favorite: values.favorite,
        fansDelta: values.fansDelta,
        playDelta: deltas.playDelta,
        likeDelta: deltas.likeDelta,
        commentDelta: deltas.commentDelta,
        shareDelta: deltas.shareDelta,
        favoriteDelta: deltas.favoriteDelta,
        fansDeltaDelta: deltas.fansDeltaDelta,
        gapDays,
      };
      if (hasLink) {
        row.contentKey =
          linkInfo && linkInfo.contentKey != null ? linkInfo.contentKey : null;
        row.matchedBy =
          linkInfo && linkInfo.matchedBy != null ? linkInfo.matchedBy : null;
        row.matchScore =
          linkInfo &&
          linkInfo.matchedBy === "fuzzy" &&
          typeof linkInfo.score === "number" &&
          Number.isFinite(linkInfo.score)
            ? linkInfo.score
            : null;
      }

      entries.push({
        publishTimeMs,
        row,
      });
    }
  }

  // 行按 date 升序、同日按 publishTime 降序（同时间戳按 workId 升序确保稳定）
  entries.sort((a, b) => {
    if (a.row.date !== b.row.date) {
      return a.row.date < b.row.date ? -1 : 1;
    }
    if (b.publishTimeMs !== a.publishTimeMs) {
      return b.publishTimeMs - a.publishTimeMs;
    }
    if (a.row.workId !== b.row.workId) {
      return a.row.workId < b.row.workId ? -1 : 1;
    }
    return 0;
  });

  return entries.map((e) => e.row);
}

const HOUR_MS = 3600000;
const UTC8_MS = 8 * HOUR_MS;
const SLOT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function slotToUtc8Ms(dateStr, slotStr) {
  const dayMs = parseDateDayMs(dateStr);
  if (dayMs === null) return null;
  const m = SLOT_TIME_RE.exec(typeof slotStr === "string" ? slotStr.trim() : "");
  if (!m) return null;
  return dayMs + (Number(m[1]) * 60 + Number(m[2])) * 60000 - UTC8_MS;
}

function compareIntradayPointTime(a, b) {
  const ta = a.sortTsMs;
  const tb = b.sortTsMs;
  if (ta !== null && tb !== null && ta !== tb) return ta - tb;
  if (ta !== null && tb === null) return -1;
  if (ta === null && tb !== null) return 1;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  return 0;
}

function round2(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return null;
  const rounded = Math.round((val + (val >= 0 ? Number.EPSILON : -Number.EPSILON)) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function normalizeCollectedAtMs(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) && t > 0 ? t : null;
  }
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

/**
 * 构建单个「分组 × 平台」的作品分时段长表行（纯函数，不依赖 electron / fs）。
 *
 * @param {object} params
 * @param {string} [params.group]
 * @param {string} [params.platform]
 * @param {Array<object>} [params.works]
 * @param {object} [params.worksIntraday]  readWorksIntraday 返回的 { workId: [{ date, slot, collectedAt, ...metrics }] }
 * @param {string} [params.from]           起始日期 YYYY-MM-DD（含），可省
 * @param {string} [params.to]             截止日期 YYYY-MM-DD（含），可省
 * @param {Map} [params.link]              可选，linkWorks 返回的 Map
 * @returns {Array<object>}
 */
function buildWorkIntradayRows({ group, platform, works, worksIntraday, from, to, link } = {}) {
  if (!worksIntraday || typeof worksIntraday !== "object" || Array.isArray(worksIntraday)) {
    return [];
  }
  const workIds = Object.keys(worksIntraday);
  if (!workIds.length) return [];

  const groupStr = group == null ? "" : String(group);
  const platformStr = platform == null ? "" : String(platform);
  const fromStr = typeof from === "string" && from.trim() ? from.trim() : "";
  const toStr = typeof to === "string" && to.trim() ? to.trim() : "";
  const hasLink = link instanceof Map;

  const workById = new Map();
  if (Array.isArray(works)) {
    for (const w of works) {
      if (w && w.workId != null && w.workId !== "") {
        workById.set(String(w.workId), w);
      }
    }
  }

  const entries = [];

  for (const rawWorkId of workIds) {
    const desc = Object.getOwnPropertyDescriptor(worksIntraday, rawWorkId);
    const rawList = desc ? desc.value : null;
    if (!Array.isArray(rawList) || !rawList.length) continue;

    const workId = String(rawWorkId);
    const linkInfo = hasLink
      ? link.get(`${groupStr}|${platformStr}|${workId}`) ||
        link.get(`${platformStr}|${workId}`) ||
        null
      : null;
    const meta = workById.get(workId);
    const title = meta ? meta.title || "(无标题)" : DELETED_WORK_TITLE;
    const { ms: publishTimeMs, iso: publishTime } = meta
      ? parsePublishTime(meta.publishTime)
      : { ms: 0, iso: "" };

    // 按 (date, slot) 去重保留较晚记录，再按实际 collectedAt 升序计算增量与距上次小时数
    const byDateSlot = new Map();
    for (const pt of rawList) {
      if (!pt || typeof pt !== "object" || Array.isArray(pt)) continue;
      const date = typeof pt.date === "string" ? pt.date.trim() : "";
      const slot = typeof pt.slot === "string" ? pt.slot.trim() : "";
      if (parseDateDayMs(date) === null || !SLOT_TIME_RE.test(slot)) continue;
      const collectedAt = normalizeCollectedAtMs(pt.collectedAt);
      const sortTsMs = collectedAt !== null ? collectedAt : slotToUtc8Ms(date, slot);
      const key = `${date} ${slot}`;
      const prev = byDateSlot.get(key);
      if (
        !prev ||
        (collectedAt !== null && (prev.collectedAt === null || collectedAt >= prev.collectedAt)) ||
        (collectedAt === null && prev.collectedAt === null)
      ) {
        byDateSlot.set(key, { date, slot, collectedAt, sortTsMs, snap: pt });
      }
    }
    if (!byDateSlot.size) continue;

    const deduped = [...byDateSlot.values()].sort(compareIntradayPointTime);

    let prevPoint = null;
    let prevValues = null;

    for (const point of deduped) {
      const values = {};
      for (const k of WORK_STAT_KEYS) {
        const rawVal = Object.prototype.hasOwnProperty.call(point.snap, k)
          ? point.snap[k]
          : null;
        values[k] = normalizeMetric(rawVal);
      }

      const playDelta =
        prevValues && values.play !== null && prevValues.play !== null
          ? values.play - prevValues.play
          : null;
      const likeDelta =
        prevValues && values.like !== null && prevValues.like !== null
          ? values.like - prevValues.like
          : null;
      const commentDelta =
        prevValues && values.comment !== null && prevValues.comment !== null
          ? values.comment - prevValues.comment
          : null;
      const hoursSincePrev =
        prevPoint &&
        prevPoint.collectedAt !== null &&
        point.collectedAt !== null &&
        point.collectedAt >= prevPoint.collectedAt
          ? round2((point.collectedAt - prevPoint.collectedAt) / HOUR_MS)
          : null;

      prevPoint = point;
      prevValues = values;

      if (fromStr && point.date < fromStr) continue;
      if (toStr && point.date > toStr) continue;

      const row = {
        date: point.date,
        slot: point.slot,
        collectedAt: point.collectedAt,
        group: groupStr,
        platform: platformStr,
        workId,
        title,
        publishTime,
        play: values.play,
        like: values.like,
        comment: values.comment,
        share: values.share,
        favorite: values.favorite,
        fansDelta: values.fansDelta,
        playDelta: playDelta === 0 ? 0 : playDelta,
        likeDelta: likeDelta === 0 ? 0 : likeDelta,
        commentDelta: commentDelta === 0 ? 0 : commentDelta,
        hoursSincePrev,
      };
      if (hasLink) {
        row.contentKey =
          linkInfo && linkInfo.contentKey != null ? linkInfo.contentKey : null;
        row.matchedBy =
          linkInfo && linkInfo.matchedBy != null ? linkInfo.matchedBy : null;
      }

      entries.push({ publishTimeMs, sortTsMs: point.sortTsMs, row });
    }
  }

  entries.sort((a, b) => {
    const ta = a.sortTsMs;
    const tb = b.sortTsMs;
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if (ta !== null && tb === null) return -1;
    if (ta === null && tb !== null) return 1;
    if (a.row.date !== b.row.date) return a.row.date < b.row.date ? -1 : 1;
    if (a.row.slot !== b.row.slot) return a.row.slot < b.row.slot ? -1 : 1;
    if (b.publishTimeMs !== a.publishTimeMs) return b.publishTimeMs - a.publishTimeMs;
    if (a.row.workId !== b.row.workId) return a.row.workId < b.row.workId ? -1 : 1;
    return 0;
  });

  return entries.map((e) => e.row);
}

module.exports = {
  WORK_STAT_KEYS,
  DELETED_WORK_TITLE,
  normalizeMetric,
  buildWorkDailyRows,
  buildWorkIntradayRows,
};
