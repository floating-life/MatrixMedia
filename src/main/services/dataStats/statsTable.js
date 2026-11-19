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
 * @returns {Array<object>}
 */
function buildWorkDailyRows({ group, platform, works, worksDaily, from, to } = {}) {
  if (!worksDaily || typeof worksDaily !== "object" || Array.isArray(worksDaily)) {
    return [];
  }

  const groupStr = group == null ? "" : String(group);
  const platformStr = platform == null ? "" : String(platform);
  const fromStr = typeof from === "string" && from.trim() ? from.trim() : "";
  const toStr = typeof to === "string" && to.trim() ? to.trim() : "";

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

      entries.push({
        publishTimeMs,
        row: {
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
        },
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

module.exports = {
  WORK_STAT_KEYS,
  DELETED_WORK_TITLE,
  normalizeMetric,
  buildWorkDailyRows,
};
