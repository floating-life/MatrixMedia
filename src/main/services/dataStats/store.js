"use strict";

/**
 * 数据统计本地存储（userData/data-stats/<分组>/<平台>/）：
 *   daily.json       每日总量快照 { "YYYY-MM-DD": { fans, plays, likes, comments, favorites, shares } }
 *   works.json       作品列表 + 发布增长封闭记录
 *   works-daily/     作品每日累计值快照目录（每日一文件 YYYY-MM-DD.json：{ date, updatedAt, works }）
 *   meta.json        { lastCollectAt, lastError, workCount }
 *
 * 日趋势口径：所有平台统一为「当日总量快照」；抖音/视频号额外回填粉丝历史（只补缺日期）。
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const METRIC_KEYS = ["fans", "plays", "likes", "comments", "favorites", "shares"];
const ACCOUNT_PLAYS_SHARP_DROP_RATIO = 0.5;
const COLLECT_ALERTS_VERSION = 1;
const COLLECT_ALERT_THRESHOLD = 2;

const JSON_PARSE_ERROR_RE =
  /SyntaxError|Unexpected token|Unexpected end of JSON|is not valid JSON|非JSON响应|响应格式异常/i;
const EXPLICIT_LOGIN_HTTP_RE =
  /\b(?:HTTP\s*(?:401|403)|status(?:Code)?\s*[:=]?\s*(?:401|403)|401\s*Unauthorized|403\s*Forbidden)\b/i;
const EXPLICIT_LOGIN_TEXT_RE =
  /未登录|登录态?已?失效|登录已?过期|需?重新登录|请先[^\n]*登录|跳[转至到]?登录页|重定向[^\n]*登录页|扫码登录|NOT_LOGGED_IN/i;
const EXPLICIT_PLATFORM_LOGIN_CODE_RE =
  /(?:(?:index\/stat|archives)\s*:\s*-101\b|\bcode\s*[:=]?\s*-101\b|(?:dashboard|work_list)\s*:\s*(?:8|10008)\b|\bstatus_code\s*[:=]?\s*(?:8|10008)\b|(?:fans_trend|post_list)\s*:\s*(?:300333|300334)\b|\berrCode\s*[:=]?\s*(?:300333|300334)\b|(?:personal_info|notes)\s*:\s*code\s*[:=]?\s*(?:-100|-101)\b|userInfo\s*:\s*(?:109|100001)\b|\berrno\s*[:=]?\s*(?:10001|10002|110003)\b)/i;

/**
 * 采集错误分类：
 * - 登录失效只认明确的登录信号（err.code === "NOT_LOGGED_IN"、HTTP 401/403、平台未登录码、跳登录页/明确未登录文案）
 * - JSON 解析错误、HTTP 5xx/非 2xx（除 401/403）、普通接口错误体均判为「接口错误」，绝不误报登录失效
 */
function classifyCollectError(reason, errObj = null) {
  const msg = typeof reason === "string" ? reason.trim() : "";
  if (errObj && errObj.code === "NOT_LOGGED_IN") {
    return { isLoginError: true, errorType: "login_expired", errorTypeLabel: "登录失效" };
  }
  if (errObj && (errObj.status === 401 || errObj.status === 403)) {
    return { isLoginError: true, errorType: "login_expired", errorTypeLabel: "登录失效" };
  }
  if (EXPLICIT_LOGIN_HTTP_RE.test(msg)) {
    return { isLoginError: true, errorType: "login_expired", errorTypeLabel: "登录失效" };
  }
  if (EXPLICIT_LOGIN_TEXT_RE.test(msg)) {
    return { isLoginError: true, errorType: "login_expired", errorTypeLabel: "登录失效" };
  }
  if (EXPLICIT_PLATFORM_LOGIN_CODE_RE.test(msg)) {
    return { isLoginError: true, errorType: "login_expired", errorTypeLabel: "登录失效" };
  }
  if (JSON_PARSE_ERROR_RE.test(msg)) {
    return { isLoginError: false, errorType: "api_error", errorTypeLabel: "接口错误" };
  }
  return { isLoginError: false, errorType: "api_error", errorTypeLabel: "接口错误" };
}

function baseDir() {
  return path.join(app.getPath("userData"), "data-stats");
}

function safeSeg(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g, "_");
}

function accountDir(group, platform) {
  return path.join(baseDir(), safeSeg(group), safeSeg(platform));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function todayStr(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

/* ---------------- daily ---------------- */

function readDaily(group, platform) {
  return readJson(path.join(accountDir(group, platform), "daily.json"), {});
}

function writeDaily(group, platform, daily) {
  const file = path.join(accountDir(group, platform), "daily.json");
  writeWorksDailyAtomic(file, daily);
}

function sumPositiveWorksPlay(works) {
  let sum = 0;
  let hasAny = false;
  for (const w of Array.isArray(works) ? works : []) {
    if (!w || typeof w !== "object") continue;
    const p = normalizeMetric(w.play);
    const lp = normalizeMetric(w.lastPositivePlay);
    const v = p !== null && p > 0 ? p : lp !== null && lp > 0 ? lp : null;
    if (v !== null) {
      sum += v;
      hasAny = true;
    }
  }
  return { sum, hasAny };
}

function computeEffectiveCurrWorksPlaySum(group, platform, prevWorks, incomingWorks) {
  const prevById = new Map();
  for (const pw of Array.isArray(prevWorks) ? prevWorks : []) {
    if (pw && pw.workId != null) prevById.set(String(pw.workId), pw);
  }
  let dailyHistoryByWork = null;
  let dailyHistoryLoaded = false;
  const ensureDailyHistory = () => {
    if (!dailyHistoryLoaded) {
      dailyHistoryLoaded = true;
      try {
        dailyHistoryByWork = readWorksDaily(group, platform);
      } catch (_) {
        dailyHistoryByWork = null;
      }
    }
    return dailyHistoryByWork;
  };
  let sum = 0;
  let hasAny = false;
  for (const w of Array.isArray(incomingWorks) ? incomingWorks : []) {
    if (!w || typeof w !== "object") continue;
    const wid = w.workId != null ? String(w.workId) : "";
    const existing = wid ? prevById.get(wid) : null;
    const incomingPlay = normalizeMetric(w.play);
    let histPosPlay = getWorkHistoricalPositivePlay(existing, null, wid);
    if (histPosPlay <= 0 && (incomingPlay === 0 || incomingPlay === null)) {
      histPosPlay = getWorkHistoricalPositivePlay(existing, ensureDailyHistory(), wid);
    }
    const isFalseZeroPlay = histPosPlay > 0 && (incomingPlay === 0 || incomingPlay === null);
    if (isFalseZeroPlay) {
      // 作品级被判定为假 0 / 缺失（将在 mergeWorks 中置空）时，不视为作品级真实下降，
      // 沿用其既有正播放参与对比，联动让账号级总播放也判定异常。
      const existingPos = existing ? normalizeMetric(existing.play) : null;
      const carry = existingPos !== null && existingPos > 0 ? existingPos : histPosPlay;
      sum += carry;
      hasAny = true;
    } else {
      const lp = normalizeMetric(w.lastPositivePlay);
      const v =
        incomingPlay !== null && incomingPlay > 0
          ? incomingPlay
          : lp !== null && lp > 0
          ? lp
          : incomingPlay === 0
          ? 0
          : null;
      if (v !== null) {
        sum += v;
        hasAny = true;
      }
    }
  }
  return { sum, hasAny };
}

function findPrevValidAccountPlays(daily, today) {
  if (!isPlainObject(daily)) return null;
  // 1) 同日多次采集优先与当日上一次有效正播放比较（避免同日骤降拿昨天做基准）
  const todayEntry = daily[today];
  if (isPlainObject(todayEntry)) {
    if (todayEntry.playsAnomaly !== true) {
      const todayPlays = normalizeMetric(todayEntry.plays);
      if (todayPlays !== null && todayPlays > 0) {
        return { date: today, value: todayPlays };
      }
    } else {
      const savedValid = normalizeMetric(todayEntry.lastValidPlays);
      if (savedValid !== null && savedValid > 0) {
        return { date: today, value: savedValid };
      }
      const detail = isPlainObject(todayEntry.playsAnomalyDetail)
        ? todayEntry.playsAnomalyDetail
        : null;
      const detailPrevVal = detail ? normalizeMetric(detail.prevValue) : null;
      if (detail && detail.prevDate === today && detailPrevVal !== null && detailPrevVal > 0) {
        return { date: today, value: detailPrevVal };
      }
    }
  }
  // 2) 当日尚无有效正播放时，回溯早于 today 的最近正常正值日
  const dates = Object.keys(daily)
    .filter((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    if (d >= today) continue;
    const entry = daily[d];
    if (!isPlainObject(entry) || entry.playsAnomaly === true) continue;
    const v = normalizeMetric(entry.plays);
    if (v !== null && v > 0) {
      return { date: d, value: v };
    }
  }
  return null;
}

/**
 * 合并一次采集到 daily：以 collectNow 的 UTC+8 日期写入当日总量快照；fansHistory 只回填缺失日期。
 * 防假 0 / 骤降覆写：若本次账号总播放相对上次有效正值骤降（归 0 或降幅 ≥50%）且作品级无对应下降，
 * 标记 playsAnomaly=true 且本次 plays 写 null，避免账号日增出现大负数。
 */
function mergeDaily(group, platform, overview, fansHistory, now = Date.now(), options = null) {
  const opts = isPlainObject(options) ? options : null;
  const daily = readDaily(group, platform);
  const today = todayStr(now);
  const snap = {};
  for (const k of METRIC_KEYS) {
    if (overview && Object.prototype.hasOwnProperty.call(overview, k) && overview[k] !== null && overview[k] !== undefined && overview[k] !== "") {
      const v = Number(overview[k]);
      if (Number.isFinite(v)) snap[k] = v;
    }
  }

  const mergedToday = { ...(isPlainObject(daily[today]) ? daily[today] : {}), ...snap };
  if (Object.prototype.hasOwnProperty.call(snap, "plays")) {
    const incomingPlays = normalizeMetric(snap.plays);
    const prev = findPrevValidAccountPlays(daily, today);
    if (prev && prev.value > 0 && incomingPlays !== null) {
      const drop = prev.value - incomingPlays;
      const dropRatio = drop / prev.value;
      const isSharpDrop =
        incomingPlays === 0 || (drop > 0 && dropRatio >= ACCOUNT_PLAYS_SHARP_DROP_RATIO);
      if (isSharpDrop) {
        let hasCorrespondingWorkDrop = false;
        if (opts && Array.isArray(opts.works)) {
          const prevWorks = readWorks(group, platform).works;
          const prevSumInfo = sumPositiveWorksPlay(prevWorks);
          const currSumInfo = computeEffectiveCurrWorksPlaySum(
            group,
            platform,
            prevWorks,
            opts.works
          );
          if (prevSumInfo.hasAny && prevSumInfo.sum > 0) {
            const worksDrop = prevSumInfo.sum - (currSumInfo.hasAny ? currSumInfo.sum : 0);
            const worksDropRatio = worksDrop / prevSumInfo.sum;
            if (
              worksDrop > 0 &&
              worksDrop >= drop * 0.5 &&
              worksDropRatio >= dropRatio * 0.5
            ) {
              hasCorrespondingWorkDrop = true;
            }
          }
        }
        if (!hasCorrespondingWorkDrop) {
          mergedToday.plays = null;
          mergedToday.playsAnomaly = true;
          if (prev.date === today) {
            mergedToday.lastValidPlays = prev.value;
          }
          mergedToday.playsAnomalyDetail = {
            prevDate: prev.date,
            prevValue: prev.value,
            rawValue: incomingPlays,
            reason: "账号总播放较上次骤降且作品级无对应下降",
          };
        } else {
          delete mergedToday.playsAnomaly;
          delete mergedToday.playsAnomalyDetail;
          delete mergedToday.lastValidPlays;
        }
      } else if (incomingPlays > 0) {
        delete mergedToday.playsAnomaly;
        delete mergedToday.playsAnomalyDetail;
        delete mergedToday.lastValidPlays;
      }
    } else if (incomingPlays !== null && incomingPlays > 0) {
      delete mergedToday.playsAnomaly;
      delete mergedToday.playsAnomalyDetail;
      delete mergedToday.lastValidPlays;
    }
  }

  const nextDaily = { ...daily, [today]: mergedToday };
  for (const point of fansHistory || []) {
    if (!point || !point.date) continue;
    if (!nextDaily[point.date]) nextDaily[point.date] = {};
    else nextDaily[point.date] = { ...nextDaily[point.date] };
    if (nextDaily[point.date].fans == null) {
      nextDaily[point.date].fans = Number(point.value) || 0;
    }
  }
  writeDaily(group, platform, nextDaily);
  return nextDaily;
}

/* ---------------- works（发布增长） ---------------- */

function normalizeAltTitles(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!item.trim() || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function readWorks(group, platform) {
  const data = readJson(path.join(accountDir(group, platform), "works.json"), {
    works: [],
  });
  const works = Array.isArray(data && data.works)
    ? data.works.map((w) =>
        isPlainObject(w) ? { ...w, altTitles: normalizeAltTitles(w.altTitles) } : w
      )
    : [];
  return { ...(isPlainObject(data) ? data : {}), works };
}

function writeWorks(group, platform, data) {
  writeJson(path.join(accountDir(group, platform), "works.json"), data);
}

function pickStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) out[k] = w[k] == null ? null : w[k];
  return out;
}

const NAIVE_PUBLISH_TIME_RE =
  /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/;
const TZ_SUFFIX_RE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/;

function parseValidPublishTime(raw) {
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
      const m = NAIVE_PUBLISH_TIME_RE.exec(s);
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
            ms = utcMs - 8 * 3600e3;
          }
        }
      } else {
        ms = Date.parse(s);
      }
    }
  }
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (!Number.isFinite(new Date(ms).getTime())) return null;
  return ms;
}

function maxPositiveMetric(...vals) {
  let max = 0;
  for (const raw of vals) {
    const v = normalizeMetric(raw);
    if (v !== null && v > max) max = v;
  }
  return max;
}

function getWorkHistoricalPositivePlay(existing, dailyHistoryByWork, workId) {
  let max = existing
    ? maxPositiveMetric(
        existing.play,
        existing.lastPositivePlay,
        existing.baselineStats && existing.baselineStats.play,
        existing.closedStats && existing.closedStats.play
      )
    : 0;
  if (max > 0) return max;
  if (dailyHistoryByWork && workId != null) {
    const wid = String(workId);
    const dateMap = dailyHistoryByWork[wid];
    if (isPlainObject(dateMap)) {
      for (const snap of Object.values(dateMap)) {
        if (isPlainObject(snap)) {
          max = maxPositiveMetric(max, snap.play);
        }
      }
    }
  }
  return max;
}

/**
 * 合并作品列表，实现「发布增长」口径：
 * - 新出现的作品：登记基线（首次见到时的值），并封闭「比它早且尚未封闭」的最近一条
 * - 已有作品：更新当前累计值；若重采得到有效 publishTime（>0 且可解析）同步更新
 * - 防假 0 覆写：若该作品历史已有 play>0，本次 play===0 或缺失，视为接口缺省，
 *   快照（works-daily / works-intraday）本次 play 写 null（其他字段正常写），
 *   works.json 保留原正 play 不被假 0 覆写
 * - 展示时优先用封闭值（closedStats），未封闭用当前值
 */
function mergeWorks(group, platform, newWorks, now = Date.now(), options = null) {
  const opts = isPlainObject(options) ? options : null;

  const data = readWorks(group, platform);
  const byId = new Map(data.works.map((w) => [w.workId, w]));
  // 首次全量导入时不做封闭：封闭语义是「两次采集之间出现了新发布」，
  // 首次导入没有历史基线，全部登记为未封闭
  const isFirstImport = data.works.length === 0;

  // 接口返回按发布时间倒序；先升序处理，便于「上一条」封闭逻辑
  const sorted = [...(newWorks || [])]
    .filter((w) => w && w.workId)
    .sort((a, b) => (parseValidPublishTime(a.publishTime) || 0) - (parseValidPublishTime(b.publishTime) || 0));

  // 仅当存在「本次 play 为 0/缺失且 works.json 未记录正 play」的作品时，懒加载 works-daily 历史兜底检查
  let dailyHistoryByWork = null;
  let dailyHistoryLoaded = false;
  const ensureDailyHistory = () => {
    if (!dailyHistoryLoaded) {
      dailyHistoryLoaded = true;
      try {
        dailyHistoryByWork = readWorksDaily(group, platform);
      } catch (_) {
        dailyHistoryByWork = null;
      }
    }
    return dailyHistoryByWork;
  };

  const snapshotWorks = [];

  for (const w of sorted) {
    const validPubTime = parseValidPublishTime(w.publishTime);
    const existing = byId.get(w.workId);
    const incomingPlay = normalizeMetric(w.play);
    let histPosPlay = getWorkHistoricalPositivePlay(existing, null, w.workId);
    if (histPosPlay <= 0 && (incomingPlay === 0 || incomingPlay === null)) {
      histPosPlay = getWorkHistoricalPositivePlay(existing, ensureDailyHistory(), w.workId);
    }
    const isFalseZeroPlay = histPosPlay > 0 && (incomingPlay === 0 || incomingPlay === null);
    const snapWork = isFalseZeroPlay ? { ...w, play: null } : w;
    snapshotWorks.push(snapWork);

    if (existing) {
      const nextStats = pickStats(w);
      if (isFalseZeroPlay) {
        const existingPosPlay = normalizeMetric(existing.play);
        nextStats.play =
          existingPosPlay !== null && existingPosPlay > 0 ? existingPosPlay : null;
      }
      Object.assign(existing, nextStats, { updatedAt: now });
      if (incomingPlay !== null && incomingPlay > 0) {
        existing.lastPositivePlay = maxPositiveMetric(existing.lastPositivePlay, incomingPlay);
      } else if (histPosPlay > 0) {
        existing.lastPositivePlay = histPosPlay;
      }
      if (w.title) existing.title = w.title;
      if (w.url) existing.url = w.url;
      if (validPubTime !== null) existing.publishTime = validPubTime;
      if (Array.isArray(w.altTitles)) {
        existing.altTitles = normalizeAltTitles(w.altTitles);
      } else if (!Array.isArray(existing.altTitles)) {
        existing.altTitles = [];
      }
      continue;
    }
    // 新作品：封闭比它早的最近一条未封闭作品（仅非首次导入时）
    const newPubTime = validPubTime !== null ? validPubTime : 0;
    if (!isFirstImport) {
      const earlier = data.works
        .filter((x) => !x.closedStats && (x.publishTime || 0) < newPubTime)
        .sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0))[0];
      if (earlier) {
        earlier.closedStats = pickStats(earlier);
        earlier.closedAt = now;
      }
    }
    const initStats = pickStats(snapWork);
    const row = {
      workId: w.workId,
      title: w.title || "(无标题)",
      altTitles: normalizeAltTitles(w.altTitles),
      url: w.url || "",
      publishTime: newPubTime,
      ...initStats,
      baselineStats: { ...initStats },
      closedStats: null,
      closedAt: null,
      firstSeenAt: now,
      updatedAt: now,
    };
    const posPlay = maxPositiveMetric(histPosPlay, incomingPlay);
    if (posPlay > 0) {
      row.lastPositivePlay = posPlay;
    }
    data.works.push(row);
    byId.set(row.workId, row);
  }

  // 展示按发布时间倒序
  data.works.sort((a, b) => (b.publishTime || 0) - (a.publishTime || 0));

  // 整次写入统一以 collectNow（now）的 UTC+8 日期归档，不因写入耗时跨零点而中途放弃
  writeWorks(group, platform, data);
  recordWorksDaily(group, platform, snapshotWorks, now);
  recordWorksIntraday(group, platform, snapshotWorks, {
    ...(opts || {}),
    now,
    _falseZeroChecked: true,
  });
  return data;
}

/* ---------------- works-daily（作品日快照，按天分文件） ---------------- */

const WORKS_DAILY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WORKS_DAILY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const WORKS_DAILY_RENAME_MAX_RETRIES = 3;
const WORKS_DAILY_RENAME_RETRY_DELAY_MS = 50;

const SLEEP_VIEW =
  typeof SharedArrayBuffer === "function"
    ? new Int32Array(new SharedArrayBuffer(4))
    : null;

function sleepMs(ms) {
  if (!SLEEP_VIEW || !ms || ms <= 0) return;
  try {
    Atomics.wait(SLEEP_VIEW, 0, 0, ms);
  } catch (_) {}
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function worksDailyDir(group, platform) {
  return path.join(accountDir(group, platform), "works-daily");
}

function legacyWorksDailyFile(group, platform) {
  return path.join(accountDir(group, platform), "works-daily.json");
}

function pickWorkDailyStats(w) {
  const out = {};
  for (const k of WORK_STAT_KEYS) {
    out[k] = normalizeMetric(w[k]);
  }
  return out;
}

function writeAllSync(fd, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      const err = new Error("短写入：未能写入字节");
      err.code = "EIO";
      throw err;
    }
    offset += written;
  }
}

function renameWithRetrySync(src, dest) {
  for (let attempt = 0; attempt <= WORKS_DAILY_RENAME_MAX_RETRIES; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err) {
      const retryable = err && (err.code === "EPERM" || err.code === "EBUSY");
      if (!retryable || attempt === WORKS_DAILY_RENAME_MAX_RETRIES) {
        throw err;
      }
      sleepMs(WORKS_DAILY_RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * 原子写入单日文件：同目录唯一临时文件 → writeSync 全量 → fsync → renameSync 覆盖。
 * 任何步骤失败都删除临时文件并保留旧文件完整。
 */
function writeWorksDailyAtomic(file, payload) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
  fs.mkdirSync(dir, { recursive: true });
  const rand = crypto.randomBytes(6).toString("hex");
  const tmpFile = path.join(dir, `.${base}.${process.pid}.${Date.now()}.${rand}.tmp`);
  let fd = null;
  let tmpCreated = false;
  try {
    fd = fs.openSync(tmpFile, "wx");
    tmpCreated = true;
    writeAllSync(fd, buf);
    fs.fsyncSync(fd);
    const closeFd = fd;
    fd = null;
    fs.closeSync(closeFd);
    renameWithRetrySync(tmpFile, file);
    tmpCreated = false;
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
    if (tmpCreated) {
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {}
    }
    throw err;
  }
}

/**
 * 解析单日快照文件，返回无原型 works 字典。
 * 不存在返回 null；JSON 损坏或结构无效告警并返回 null；读 I/O 错误上抛由调用方处理。
 */
function parseDayWorksFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] 作品日快照 JSON 损坏 (${file}):`, (err && err.message) || err);
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.works)) {
    console.warn(`[dataStats] 作品日快照结构无效 (${file})`);
    return null;
  }
  const works = Object.create(null);
  for (const workId of Object.keys(parsed.works)) {
    const desc = Object.getOwnPropertyDescriptor(parsed.works, workId);
    if (desc && isPlainObject(desc.value)) {
      works[workId] = pickWorkDailyStats(desc.value);
    }
  }
  return works;
}

/** 兼容读取旧版单文件 works-daily.json 作为补充来源（不删除、不迁移写入） */
function mergeLegacyWorksDaily(result, group, platform) {
  const file = legacyWorksDailyFile(group, platform);
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return;
    console.warn(`[dataStats] 读取旧 works-daily.json 失败 (${file}):`, (err && err.message) || err);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] 旧 works-daily.json JSON 损坏，已跳过 (${file}):`, (err && err.message) || err);
    return;
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[dataStats] 旧 works-daily.json 结构无效，已跳过 (${file})`);
    return;
  }
  for (const workId of Object.keys(parsed)) {
    const desc = Object.getOwnPropertyDescriptor(parsed, workId);
    const dateMap = desc ? desc.value : null;
    if (!isPlainObject(dateMap)) continue;
    for (const date of Object.keys(dateMap)) {
      if (!WORKS_DAILY_DATE_RE.test(date)) continue;
      const snapDesc = Object.getOwnPropertyDescriptor(dateMap, date);
      if (!snapDesc || !isPlainObject(snapDesc.value)) continue;
      if (!result[workId]) result[workId] = {};
      result[workId][date] = pickWorkDailyStats(snapDesc.value);
    }
  }
}

/**
 * 读取作品日快照，返回无原型字典 `{ workId: { "YYYY-MM-DD": stats } }`。
 * 遍历 works-daily/ 下 YYYY-MM-DD.json（以文件名日期为准），单文件损坏/读失败 warn 并跳过；
 * 若存在旧单文件 works-daily.json，作为补充来源合并（目录文件优先）。
 */
function readWorksDaily(group, platform) {
  const result = Object.create(null);
  mergeLegacyWorksDaily(result, group, platform);

  const dir = worksDailyDir(group, platform);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return result;
    console.warn(`[dataStats] 读取 works-daily 目录失败 (${dir}):`, (err && err.message) || err);
    return result;
  }

  entries.sort();
  for (const name of entries) {
    const match = WORKS_DAILY_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    const file = path.join(dir, name);
    let dayWorks;
    try {
      dayWorks = parseDayWorksFile(file);
    } catch (err) {
      console.warn(`[dataStats] 读取作品日快照失败，已跳过 (${file}):`, (err && err.message) || err);
      continue;
    }
    if (!dayWorks) continue;
    for (const workId of Object.keys(dayWorks)) {
      if (!result[workId]) result[workId] = {};
      result[workId][date] = dayWorks[workId];
    }
  }
  return result;
}

/**
 * 仅读取截至 cutoffDate 的每个作品最新一条快照（跳过 > cutoffDate 的日文件，内存保持 O(作品数)）。
 * 与 readWorksDaily 保持同一口径：目录文件优先于旧单文件 works-daily.json。
 * 返回 `{ worksDaily: { [workId]: { [bestDate]: stats } }, latestDate }`。
 */
function readWorksDailyLatestAsOf(group, platform, cutoffDate = "") {
  const dir = worksDailyDir(group, platform);
  const bestByWork = Object.create(null);
  let latestDate = "";

  let entries = null;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 读取 works-daily 目录失败 (${dir}):`,
        (err && err.message) || err
      );
    }
  }

  if (Array.isArray(entries) && entries.length > 0) {
    const dayFiles = [];
    for (const name of entries) {
      const m = WORKS_DAILY_FILE_RE.exec(name);
      if (!m) continue;
      const date = m[1];
      if (!isValidAutoRunDate(date)) continue;
      if (cutoffDate && date > cutoffDate) continue;
      dayFiles.push({ date, name });
    }
    // 倒序扫描：每个作品首次命中即为 <= cutoffDate 的最新快照
    dayFiles.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    for (const { date, name } of dayFiles) {
      const file = path.join(dir, name);
      let dayWorks;
      try {
        dayWorks = parseDayWorksFile(file);
      } catch (err) {
        console.warn(
          `[dataStats] 读取作品日快照失败，已跳过 (${file}):`,
          (err && err.message) || err
        );
        continue;
      }
      if (!dayWorks) continue;
      for (const workId of Object.keys(dayWorks)) {
        if (!bestByWork[workId]) {
          bestByWork[workId] = { date, snap: dayWorks[workId] };
          if (!latestDate || date > latestDate) latestDate = date;
        }
      }
    }
  }

  // 兼容旧单文件 works-daily.json（目录同日优先，仅更晚日期可补缺）
  const legacyFile = legacyWorksDailyFile(group, platform);
  let legacyRaw = null;
  try {
    legacyRaw = fs.readFileSync(legacyFile, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 读取旧 works-daily.json 失败 (${legacyFile}):`,
        (err && err.message) || err
      );
    }
  }
  if (legacyRaw !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(legacyRaw);
    } catch (err) {
      console.warn(
        `[dataStats] 旧 works-daily.json JSON 损坏，已跳过 (${legacyFile}):`,
        (err && err.message) || err
      );
    }
    if (isPlainObject(parsed)) {
      for (const workId of Object.keys(parsed)) {
        const desc = Object.getOwnPropertyDescriptor(parsed, workId);
        const dateMap = desc ? desc.value : null;
        if (!isPlainObject(dateMap)) continue;
        for (const d of Object.keys(dateMap)) {
          if (!isValidAutoRunDate(d)) continue;
          if (cutoffDate && d > cutoffDate) continue;
          const snapDesc = Object.getOwnPropertyDescriptor(dateMap, d);
          if (!snapDesc || !isPlainObject(snapDesc.value)) continue;
          const prev = bestByWork[workId];
          if (!prev || d > prev.date) {
            bestByWork[workId] = { date: d, snap: pickWorkDailyStats(snapDesc.value) };
            if (!latestDate || d > latestDate) latestDate = d;
          }
        }
      }
    }
  }

  const worksDaily = Object.create(null);
  for (const workId of Object.keys(bestByWork)) {
    const entry = bestByWork[workId];
    worksDaily[workId] = { [entry.date]: entry.snap };
  }
  return { worksDaily, latestDate };
}

/**
 * 写入作品当日累计快照（UTC+8，以 collectNow 的 UTC+8 日期为准，只读写该日 YYYY-MM-DD.json）。
 * 读当日文件（不存在/损坏视为空，损坏时 warn）→ 按 workId 合并 → 原子写；失败仅 warn，不影响 mergeWorks。
 */
function recordWorksDaily(group, platform, works, now = Date.now()) {
  if (!works || !works.length) return;
  const validWorks = [];
  for (const w of works) {
    if (w && w.workId) validWorks.push(w);
  }
  if (!validWorks.length) return;

  const today = todayStr(now);
  const file = path.join(worksDailyDir(group, platform), `${today}.json`);
  try {
    const dayWorks = parseDayWorksFile(file) || Object.create(null);
    for (const w of validWorks) {
      dayWorks[String(w.workId)] = pickWorkDailyStats(w);
    }
    writeWorksDailyAtomic(file, {
      date: today,
      updatedAt: now,
      works: dayWorks,
    });
  } catch (err) {
    console.warn(
      `[dataStats] 写入 works-daily/${today}.json 失败 (${group}/${platform}):`,
      (err && err.message) || err
    );
  }
}

/* ---------------- works-intraday（作品分时段快照，按天分文件） ---------------- */

const DEFAULT_INTRADAY_RETENTION_DAYS = 60;
const SLOT_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const AUTO_RUN_SLOT_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86400000;
// 记录每个 works-intraday 目录当天是否已完成过期清理：dir -> "YYYY-MM-DD|retentionDays"
const intradayCleanupDone = new Map();

function worksIntradayDir(group, platform) {
  return path.join(accountDir(group, platform), "works-intraday");
}

function dateStrToDayNum(ymd) {
  if (!isValidAutoRunDate(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** 将时间戳向下取整到 UTC+8 整点，返回 "YYYY-MM-DD HH:00" */
function formatManualSlotKey(now = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const safeMs = Number.isFinite(ms) ? ms : Date.now();
  const iso = new Date(safeMs + 8 * 3600e3).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00`;
}

function normalizeIntradayCollectedAt(raw) {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const s = raw.trim();
    const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

function normalizeRetentionDaysOption(raw) {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 3650) return n;
  return DEFAULT_INTRADAY_RETENTION_DAYS;
}

/**
 * 解析单日分时段快照文件，返回无原型 slots 字典 `{ "HH:mm": { collectedAt, works } }`。
 * 不存在返回 null；JSON 损坏或结构无效告警并返回 null；读 I/O 错误上抛由调用方处理。
 */
function parseIntradayDayFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] 作品分时段快照 JSON 损坏 (${file}):`, (err && err.message) || err);
    return null;
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.slots)) {
    console.warn(`[dataStats] 作品分时段快照结构无效 (${file})`);
    return null;
  }
  const slots = Object.create(null);
  for (const slotTime of Object.keys(parsed.slots)) {
    if (!SLOT_TIME_RE.test(slotTime)) continue;
    const slotDesc = Object.getOwnPropertyDescriptor(parsed.slots, slotTime);
    const slotObj = slotDesc ? slotDesc.value : null;
    if (!isPlainObject(slotObj) || !isPlainObject(slotObj.works)) continue;
    const works = Object.create(null);
    for (const workId of Object.keys(slotObj.works)) {
      const wDesc = Object.getOwnPropertyDescriptor(slotObj.works, workId);
      if (wDesc && isPlainObject(wDesc.value)) {
        works[workId] = pickWorkDailyStats(wDesc.value);
      }
    }
    slots[slotTime] = {
      collectedAt: normalizeIntradayCollectedAt(slotObj.collectedAt),
      works,
    };
  }
  return slots;
}

/**
 * 清理超过 retentionDays 的分时段快照文件：
 * 仅删除 works-intraday 目录下文件名严格符合 YYYY-MM-DD.json 且为普通文件、
 * 日期严格早于 (today - retentionDays) 的文件；未显式传入 retentionDays 时以主进程持久化设置为准，
 * 并在每个文件删除前再次校验日期严格早于 (今天 - 主进程 retentionDays)；不触碰目录内外任何其他文件。
 */
function cleanupWorksIntraday(
  group,
  platform,
  now = Date.now(),
  retentionDaysArg
) {
  const dir = worksIntradayDir(group, platform);
  const today = todayStr(now);
  const todayDayNum = dateStrToDayNum(today);
  if (todayDayNum === null) return [];
  const hasExplicit =
    retentionDaysArg !== undefined &&
    retentionDaysArg !== null &&
    retentionDaysArg !== "";
  const keepDays = hasExplicit
    ? normalizeRetentionDaysOption(retentionDaysArg)
    : readAutoSettings().retentionDays;
  const minKeepDayNum = todayDayNum - keepDays;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    console.warn(
      `[dataStats] 清理 works-intraday 读目录失败 (${dir}):`,
      (err && err.message) || err
    );
    return [];
  }

  const deleted = [];
  for (const name of entries) {
    const match = WORKS_DAILY_FILE_RE.exec(name);
    if (!match) continue;
    const fileDate = match[1];
    const fileDayNum = dateStrToDayNum(fileDate);
    if (fileDayNum === null || fileDayNum >= minKeepDayNum) continue;
    // 清理前再次校验：只删严格早于（今天 − 主进程 retentionDays）的文件
    const verifyKeepDays = hasExplicit ? keepDays : readAutoSettings().retentionDays;
    if (fileDayNum >= todayDayNum - verifyKeepDays) continue;
    const fullPath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(fullPath);
      if (!stat.isFile()) continue;
      fs.unlinkSync(fullPath);
      deleted.push(name);
    } catch (err) {
      console.warn(
        `[dataStats] 清理过期 works-intraday 文件失败 (${fullPath}):`,
        (err && err.message) || err
      );
    }
  }
  return deleted;
}

/**
 * 写入作品分时段快照（works-intraday/YYYY-MM-DD.json）：
 * - 自动采集：使用传入 slot ("YYYY-MM-DD HH:mm") 的日期与时段作为文件与槽键
 * - 手动采集（未传 slot）：按 collectNow（UTC+8）向下取整到整点 "HH:00"
 * - 同槽重复采集覆盖该槽；同日其他槽完整保留
 * - 整次写入统一以 collectNow 归档，不因写入耗时跨零点而放弃；每天首次写入成功后自动清理过期 intraday 文件
 */
function recordWorksIntraday(group, platform, works, optionsOrNow, extraOpts) {
  if (!works || !works.length) return;
  const validWorks = [];
  for (const w of works) {
    if (w && w.workId != null && w.workId !== "") validWorks.push(w);
  }
  if (!validWorks.length) return;

  let opts;
  if (isPlainObject(optionsOrNow)) {
    opts = optionsOrNow;
  } else {
    opts = {
      ...(isPlainObject(extraOpts) ? extraOpts : {}),
      now: optionsOrNow !== undefined ? optionsOrNow : Date.now(),
    };
  }
  const now =
    typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now();
  const hasExplicitRetention =
    opts.retentionDays !== undefined && opts.retentionDays !== null && opts.retentionDays !== "";

  let targetDate;
  let slotTime;
  const rawSlot = typeof opts.slot === "string" ? opts.slot.trim() : "";
  if (rawSlot && isValidAutoRunSlot(rawSlot)) {
    targetDate = rawSlot.slice(0, 10);
    slotTime = rawSlot.slice(11, 16);
  } else if (rawSlot && SLOT_TIME_RE.test(rawSlot)) {
    targetDate = todayStr(now);
    slotTime = rawSlot;
  } else {
    const manualSlot = formatManualSlotKey(now);
    targetDate = manualSlot.slice(0, 10);
    slotTime = manualSlot.slice(11, 16);
  }

  const startedDay = todayStr(now);
  const dir = worksIntradayDir(group, platform);
  const file = path.join(dir, `${targetDate}.json`);

  try {
    const existingSlots = parseIntradayDayFile(file) || Object.create(null);
    let knownWorksById = null;
    const ensureKnownWorks = () => {
      if (knownWorksById === null) {
        knownWorksById = new Map();
        try {
          const wd = readWorks(group, platform);
          for (const item of wd.works || []) {
            if (item && item.workId != null) knownWorksById.set(String(item.workId), item);
          }
        } catch (_) {}
      }
      return knownWorksById;
    };
    const hasEarlierPositiveInSlots = (wid) => {
      for (const sKey of Object.keys(existingSlots)) {
        if (sKey >= slotTime) continue;
        const se = existingSlots[sKey];
        const prevSnap = se && se.works && se.works[wid];
        if (prevSnap && normalizeMetric(prevSnap.play) > 0) return true;
      }
      return false;
    };
    const slotWorks = Object.create(null);
    for (const w of validWorks) {
      const wid = String(w.workId);
      const stats = pickWorkDailyStats(w);
      if (opts._falseZeroChecked !== true && (stats.play === 0 || stats.play === null)) {
        const known = ensureKnownWorks().get(wid);
        const histPos =
          getWorkHistoricalPositivePlay(known, null, wid) > 0 ||
          hasEarlierPositiveInSlots(wid);
        if (histPos) {
          stats.play = null;
        }
      }
      slotWorks[wid] = stats;
    }
    existingSlots[slotTime] = {
      collectedAt: now,
      works: slotWorks,
    };

    writeWorksDailyAtomic(file, {
      date: targetDate,
      slots: existingSlots,
    });

    const cleanupRetention = hasExplicitRetention
      ? normalizeRetentionDaysOption(opts.retentionDays)
      : readAutoSettings().retentionDays;
    const cleanupKey = `${startedDay}|${cleanupRetention}`;
    if (intradayCleanupDone.get(dir) !== cleanupKey) {
      intradayCleanupDone.set(dir, cleanupKey);
      cleanupWorksIntraday(
        group,
        platform,
        now,
        hasExplicitRetention ? cleanupRetention : undefined
      );
    }
  } catch (err) {
    console.warn(
      `[dataStats] 写入 works-intraday/${targetDate}.json 失败 (${group}/${platform}):`,
      (err && err.message) || err
    );
  }
}

function slotToUtc8Ms(dateStr, slotStr) {
  const dayNum = dateStrToDayNum(dateStr);
  if (dayNum === null) return null;
  const m = SLOT_TIME_RE.exec(typeof slotStr === "string" ? slotStr.trim() : "");
  if (!m) return null;
  return dayNum * DAY_MS + (Number(m[1]) * 60 + Number(m[2])) * 60000 - 8 * 3600e3;
}

/**
 * 读取作品分时段快照，返回无原型字典：
 * `{ workId: [{ date, slot, collectedAt, play, like, comment, share, favorite, fansDelta }] }`
 * 按实际 collectedAt 升序（缺省回退槽时刻，再按 date → slot）；支持 { from, to } 日期范围过滤；损坏/读失败文件 warn 并跳过。
 */
function readWorksIntraday(group, platform, range = {}) {
  const result = Object.create(null);
  const opts = isPlainObject(range) ? range : {};
  const fromStr =
    typeof opts.from === "string" && isValidAutoRunDate(opts.from.trim())
      ? opts.from.trim()
      : "";
  const toStr =
    typeof opts.to === "string" && isValidAutoRunDate(opts.to.trim())
      ? opts.to.trim()
      : "";
  if (fromStr && toStr && fromStr > toStr) return result;

  const dir = worksIntradayDir(group, platform);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return result;
    console.warn(
      `[dataStats] 读取 works-intraday 目录失败 (${dir}):`,
      (err && err.message) || err
    );
    return result;
  }

  entries.sort();
  for (const name of entries) {
    const match = WORKS_DAILY_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!isValidAutoRunDate(date)) continue;
    if (fromStr && date < fromStr) continue;
    if (toStr && date > toStr) continue;

    const file = path.join(dir, name);
    let slots;
    try {
      slots = parseIntradayDayFile(file);
    } catch (err) {
      console.warn(
        `[dataStats] 读取作品分时段快照失败，已跳过 (${file}):`,
        (err && err.message) || err
      );
      continue;
    }
    if (!slots) continue;

    const slotTimes = Object.keys(slots).sort();
    for (const slotTime of slotTimes) {
      const slotEntry = slots[slotTime];
      if (!slotEntry || !isPlainObject(slotEntry.works)) continue;
      const collectedAt = slotEntry.collectedAt;
      for (const workId of Object.keys(slotEntry.works)) {
        const stats = slotEntry.works[workId];
        if (!result[workId]) result[workId] = [];
        result[workId].push({
          date,
          slot: slotTime,
          collectedAt,
          ...stats,
        });
      }
    }
  }

  for (const workId of Object.keys(result)) {
    result[workId].sort((a, b) => {
      const ta =
        typeof a.collectedAt === "number" && Number.isFinite(a.collectedAt) && a.collectedAt > 0
          ? a.collectedAt
          : slotToUtc8Ms(a.date, a.slot);
      const tb =
        typeof b.collectedAt === "number" && Number.isFinite(b.collectedAt) && b.collectedAt > 0
          ? b.collectedAt
          : slotToUtc8Ms(b.date, b.slot);
      if (ta !== null && tb !== null && ta !== tb) return ta - tb;
      if (ta !== null && tb === null) return -1;
      if (ta === null && tb !== null) return 1;
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
      return 0;
    });
  }

  return result;
}

/**
 * 仅读取截至 cutoffDate 每个作品在 works-intraday 中最近一次 collectedAt（用于作品汇总「最近采集」列）。
 * 若指定 cutoffDate，同时校验 collectedAt 的 UTC+8 日期 <= cutoffDate。
 * 返回无原型字典 `{ [workId]: maxCollectedAtMs }`。
 */
function readWorksIntradayLatestCollectedAt(group, platform, cutoffDate = "") {
  const out = Object.create(null);
  const cutoff =
    typeof cutoffDate === "string" && isValidAutoRunDate(cutoffDate.trim())
      ? cutoffDate.trim()
      : "";
  const dir = worksIntradayDir(group, platform);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      console.warn(
        `[dataStats] 读取 works-intraday 目录失败 (${dir}):`,
        (err && err.message) || err
      );
    }
    return out;
  }

  const dayFiles = [];
  for (const name of entries) {
    const m = WORKS_DAILY_FILE_RE.exec(name);
    if (!m) continue;
    const date = m[1];
    if (!isValidAutoRunDate(date)) continue;
    if (cutoff && date > cutoff) continue;
    dayFiles.push({ date, name });
  }
  dayFiles.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  for (const { name } of dayFiles) {
    const file = path.join(dir, name);
    let slots;
    try {
      slots = parseIntradayDayFile(file);
    } catch (err) {
      console.warn(
        `[dataStats] 读取作品分时段快照失败，已跳过 (${file}):`,
        (err && err.message) || err
      );
      continue;
    }
    if (!slots) continue;
    for (const slotTime of Object.keys(slots)) {
      const slotEntry = slots[slotTime];
      if (!slotEntry || !isPlainObject(slotEntry.works)) continue;
      const ts = slotEntry.collectedAt;
      if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) continue;
      if (cutoff && todayStr(ts) > cutoff) continue;
      for (const workId of Object.keys(slotEntry.works)) {
        if (out[workId] === undefined || ts > out[workId]) {
          out[workId] = ts;
        }
      }
    }
  }
  return out;
}

/* ---------------- meta ---------------- */

function readMeta(group, platform) {
  return readJson(path.join(accountDir(group, platform), "meta.json"), {});
}

function writeMeta(group, platform, patch, accountMeta = null) {
  const file = path.join(accountDir(group, platform), "meta.json");
  const meta = readJson(file, {});
  const next = { ...meta, ...patch };
  if (typeof patch.workCount === "number" && Number.isFinite(patch.workCount) && patch.workCount >= 0) {
    if (patch.workCount > 0) {
      next.lastPositiveWorkCount = patch.workCount;
    }
    const accId = resolveCollectAlertAccountKey(group, platform, accountMeta);
    if (accId) {
      const byAcc = isPlainObject(meta.workCountsByAccount)
        ? { ...meta.workCountsByAccount }
        : {};
      const prevRec = isPlainObject(byAcc[accId]) ? byAcc[accId] : null;
      const prevPos =
        prevRec &&
        typeof prevRec.lastPositiveWorkCount === "number" &&
        Number.isFinite(prevRec.lastPositiveWorkCount) &&
        prevRec.lastPositiveWorkCount > 0
          ? prevRec.lastPositiveWorkCount
          : 0;
      byAcc[accId] = {
        workCount: patch.workCount,
        lastPositiveWorkCount: patch.workCount > 0 ? patch.workCount : prevPos,
        updatedAt:
          typeof patch.lastCollectAt === "number" && Number.isFinite(patch.lastCollectAt)
            ? patch.lastCollectAt
            : Date.now(),
      };
      next.workCountsByAccount = byAcc;
    }
  }
  writeJson(file, next);
}

function getPreviousWorkCount(group, platform, accountMeta = null) {
  const meta = readMeta(group, platform);
  const byAcc = isPlainObject(meta.workCountsByAccount) ? meta.workCountsByAccount : null;
  const accId = resolveCollectAlertAccountKey(group, platform, accountMeta);
  if (byAcc && accId && Object.prototype.hasOwnProperty.call(byAcc, accId)) {
    const rec = byAcc[accId];
    if (isPlainObject(rec)) {
      const pos =
        typeof rec.lastPositiveWorkCount === "number" && Number.isFinite(rec.lastPositiveWorkCount)
          ? rec.lastPositiveWorkCount
          : 0;
      const cur =
        typeof rec.workCount === "number" && Number.isFinite(rec.workCount) ? rec.workCount : 0;
      return Math.max(pos, cur);
    }
  }
  // 显式指定账号时只和同一账号自己的历史比较：已有其他账号记录或账号键与分组名不同时，绝不借用同组其他账号的作品数
  if (hasExplicitAccountMeta(accountMeta)) {
    const groupStr = String(group || "").trim();
    // 以分组名为键的条目是未带账号信息时写入的旧式记录，不算「按账号」历史
    const hasPerAccount = Boolean(byAcc) && Object.keys(byAcc).some((k) => k !== groupStr);
    // 升级迁移：尚无按账号记录、且组内该平台只有这一个账号时，旧的按分组作品数就是它自己的历史
    const soleLegacyAccount =
      !hasPerAccount && Number(accountMeta && accountMeta.groupPlatformAccountCount) === 1;
    if (!soleLegacyAccount && (hasPerAccount || accId !== groupStr)) {
      return 0;
    }
  }
  const works = readWorks(group, platform).works || [];
  const metaPos =
    typeof meta.lastPositiveWorkCount === "number" && Number.isFinite(meta.lastPositiveWorkCount)
      ? meta.lastPositiveWorkCount
      : 0;
  const metaCur =
    typeof meta.workCount === "number" && Number.isFinite(meta.workCount) ? meta.workCount : 0;
  return Math.max(metaPos, metaCur, works.length);
}

/* ---------------- 采集失败告警（持久化状态，按「平台 + 账号」独立键控） ---------------- */

function collectAlertsFile() {
  return path.join(baseDir(), "collect-alerts.json");
}

function extractAccountIdFromPartition(partition, platform) {
  let raw = typeof partition === "string" ? partition.trim() : "";
  if (!raw) return "";
  if (raw.startsWith("persist:")) raw = raw.slice("persist:".length);
  const pt = typeof platform === "string" ? platform.trim() : "";
  if (pt && raw.endsWith(pt) && raw.length > pt.length) {
    raw = raw.slice(0, raw.length - pt.length);
  }
  return raw.trim();
}

function hasExplicitAccountMeta(meta) {
  if (!isPlainObject(meta)) return false;
  return Boolean(
    (typeof meta.accountKey === "string" && meta.accountKey.trim()) ||
      (typeof meta.partition === "string" && meta.partition.trim()) ||
      (typeof meta.accountName === "string" && meta.accountName.trim()) ||
      (typeof meta.phone === "string" && meta.phone.trim())
  );
}

function resolveCollectAlertAccountKey(group, platform, meta = null) {
  const m = isPlainObject(meta) ? meta : null;
  if (m && typeof m.accountKey === "string" && m.accountKey.trim()) {
    return m.accountKey.trim();
  }
  if (m && typeof m.partition === "string" && m.partition.trim()) {
    const fromPart = extractAccountIdFromPartition(m.partition, platform);
    if (fromPart) return fromPart;
    return m.partition.trim();
  }
  if (m && typeof m.accountName === "string" && m.accountName.trim()) {
    return m.accountName.trim();
  }
  if (m && typeof m.phone === "string" && m.phone.trim()) {
    return m.phone.trim();
  }
  return String(group || "").trim();
}

function collectAlertKey(group, platform, meta = null) {
  const pt = String(platform || "").trim();
  const accId = resolveCollectAlertAccountKey(group, pt, meta);
  return `${pt}|${accId}`;
}

function formatCollectAlertAccountLabel(group, platform, accountKey, accountName) {
  const g = String(group || "").trim();
  const pt = String(platform || "").trim();
  const disp = String(accountName || accountKey || "").trim();
  if (disp && g && disp !== g) {
    return `${g}·${disp}·${pt}`;
  }
  return `${g || disp}·${pt}`;
}

function emptyCollectAlertsDoc() {
  return {
    version: COLLECT_ALERTS_VERSION,
    updatedAt: 0,
    accounts: Object.create(null),
  };
}

function isLegacyGroupAlertEntry(raw) {
  if (!isPlainObject(raw)) return false;
  if (raw.legacyGroupScoped === true) return true;
  return !hasExplicitAccountMeta(raw);
}

function sanitizeAccountKeyLocal(name) {
  return String(name || "")
    .replace(/[\s\-－—–]+/g, "")
    .trim();
}

function listGroupPlatformAccountsFromDisk(group, platform) {
  const g = String(group || "").trim();
  const pt = String(platform || "").trim();
  if (!g || !pt) return [];
  const candidateDirs = [];
  try {
    if (app && typeof app.getPath === "function") {
      const docs = app.getPath("documents");
      if (docs) candidateDirs.push(path.join(docs, "MatrixMedia", "data", "account"));
      const ud = app.getPath("userData");
      if (ud) candidateDirs.push(path.join(ud, "data", "account"));
    }
  } catch (_) {
    /* ignore */
  }
  const accountFolder = candidateDirs.find((dir) => {
    try {
      return (
        fs.existsSync(dir) &&
        fs.statSync(dir).isDirectory() &&
        fs.readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      );
    } catch (_) {
      return false;
    }
  });
  if (!accountFolder) return [];
  let files = [];
  try {
    files = fs
      .readdirSync(accountFolder)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
  } catch (_) {
    return [];
  }
  const seenPhonePt = new Map();
  for (const file of files) {
    const rows = readJson(path.join(accountFolder, file), []);
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isPlainObject(row) || !row.phone || !row.pt) continue;
      const k = `${row.phone}__${row.pt}`;
      const prev = seenPhonePt.get(k);
      if (!prev || (row.createTime || 0) > (prev.createTime || 0)) {
        seenPhonePt.set(k, row);
      }
    }
  }
  const byAccountKey = new Map();
  for (const row of seenPhonePt.values()) {
    if (String(row.pt || "").trim() !== pt) continue;
    const phoneStr = String(row.phone || "").trim();
    const phonePrefix = phoneStr.split("-")[0].trim();
    const rowGroup = String(row.group || "").trim() || phonePrefix;
    if (rowGroup !== g) continue;
    const accKey = sanitizeAccountKeyLocal(row.accountKey) || phonePrefix;
    if (!accKey || byAccountKey.has(accKey)) continue;
    const dashIdx = phoneStr.indexOf("-");
    const phoneSuffix = dashIdx > 0 ? phoneStr.slice(dashIdx + 1).trim() : "";
    const accName = String(row.accountName || "").trim() || phoneSuffix || rowGroup;
    byAccountKey.set(accKey, {
      accountKey: accKey,
      accountName: accName,
      partition: `persist:${accKey}${pt}`,
      phone: phoneStr,
    });
  }
  return [...byAccountKey.values()];
}

function normalizeCollectAlertEntry(raw, options = null) {
  if (!isPlainObject(raw)) return null;
  const opts = isPlainObject(options) ? options : null;
  const group = typeof raw.group === "string" ? raw.group.trim() : "";
  const platform = typeof raw.platform === "string" ? raw.platform.trim() : "";
  if (!platform) return null;
  const rawLegacy = isLegacyGroupAlertEntry(raw);
  let partition = typeof raw.partition === "string" ? raw.partition.trim() : "";
  let accountName = typeof raw.accountName === "string" ? raw.accountName.trim() : "";
  let accountKey = resolveCollectAlertAccountKey(group, platform, {
    accountKey: raw.accountKey,
    partition,
    accountName,
    phone: raw.phone,
  });
  let legacyGroupScoped = rawLegacy;
  let migratedFromLegacy = false;

  // 读入旧版按分组归键的告警条目时尝试迁移到账号键：
  // 组内单账号直接映射到该账号键；多账号（或无法唯一映射）保留 legacyGroupScoped 标记，由任一账号成功时清除
  if (rawLegacy && group && !(opts && opts.skipLegacyMigration)) {
    const resolver =
      opts && typeof opts.resolveGroupAccounts === "function"
        ? opts.resolveGroupAccounts
        : listGroupPlatformAccountsFromDisk;
    let groupAccounts = [];
    try {
      const list = resolver(group, platform);
      if (Array.isArray(list)) groupAccounts = list;
    } catch (_) {
      groupAccounts = [];
    }
    if (groupAccounts.length === 1 && groupAccounts[0]) {
      const target = groupAccounts[0];
      const resolvedKey = resolveCollectAlertAccountKey(group, platform, target);
      if (resolvedKey) {
        accountKey = resolvedKey;
        accountName =
          (typeof target.accountName === "string" && target.accountName.trim()) || resolvedKey;
        partition =
          (typeof target.partition === "string" && target.partition.trim()) ||
          `persist:${resolvedKey}${platform}`;
        legacyGroupScoped = false;
        migratedFromLegacy = true;
      }
    }
  }

  if (!group && !accountKey) return null;
  const consecutiveFailures =
    typeof raw.consecutiveFailures === "number" &&
    Number.isInteger(raw.consecutiveFailures) &&
    raw.consecutiveFailures > 0
      ? raw.consecutiveFailures
      : 1;
  const firstFailedAt =
    typeof raw.firstFailedAt === "number" && Number.isFinite(raw.firstFailedAt) && raw.firstFailedAt > 0
      ? raw.firstFailedAt
      : 0;
  const lastFailedAt =
    typeof raw.lastFailedAt === "number" && Number.isFinite(raw.lastFailedAt) && raw.lastFailedAt > 0
      ? raw.lastFailedAt
      : firstFailedAt;
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : "采集失败";
  const classified = classifyCollectError(reason);
  const isLoginError =
    typeof raw.isLoginError === "boolean" ? raw.isLoginError : classified.isLoginError;
  const errorType =
    typeof raw.errorType === "string" && raw.errorType.trim()
      ? raw.errorType.trim()
      : isLoginError
      ? "login_expired"
      : classified.errorType;
  const errorTypeLabel =
    typeof raw.errorTypeLabel === "string" && raw.errorTypeLabel.trim()
      ? raw.errorTypeLabel.trim()
      : errorType === "login_expired"
      ? "登录失效"
      : errorType === "zero_works"
      ? "空作品异常"
      : "接口错误";
  const alerted = consecutiveFailures >= COLLECT_ALERT_THRESHOLD;
  const notified = Boolean(raw.notified);
  const notifiedAt =
    typeof raw.notifiedAt === "number" && Number.isFinite(raw.notifiedAt) && raw.notifiedAt > 0
      ? raw.notifiedAt
      : null;
  const key = collectAlertKey(group, platform, { accountKey, partition, accountName });
  const entry = {
    key,
    group: group || accountKey,
    platform,
    accountKey,
    accountName: accountName || accountKey,
    partition,
    account: formatCollectAlertAccountLabel(group || accountKey, platform, accountKey, accountName),
    reason,
    errorType,
    errorTypeLabel,
    isLoginError,
    firstFailedAt,
    lastFailedAt,
    consecutiveFailures,
    alerted,
    notified,
    notifiedAt,
    ...(legacyGroupScoped ? { legacyGroupScoped: true } : {}),
  };
  if (migratedFromLegacy && opts && typeof opts.onMigrated === "function") {
    opts.onMigrated(entry);
  }
  return entry;
}

function mergeCollectAlertEntries(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  // 优先保留已按新账号键记录的条目，仅补充更早的首次失败时间/更高连败次数/已通知标记
  const preferIncoming =
    Boolean(existing.legacyGroupScoped) && !incoming.legacyGroupScoped
      ? true
      : !existing.legacyGroupScoped && Boolean(incoming.legacyGroupScoped)
      ? false
      : (incoming.lastFailedAt || 0) >= (existing.lastFailedAt || 0);
  const primary = preferIncoming ? incoming : existing;
  const secondary = preferIncoming ? existing : incoming;
  const consecutiveFailures = Math.max(
    primary.consecutiveFailures || 1,
    secondary.consecutiveFailures || 1
  );
  const firstFailedAt =
    primary.firstFailedAt > 0 && secondary.firstFailedAt > 0
      ? Math.min(primary.firstFailedAt, secondary.firstFailedAt)
      : primary.firstFailedAt || secondary.firstFailedAt || 0;
  const notified = Boolean(primary.notified || secondary.notified);
  const notifiedAt = primary.notifiedAt || secondary.notifiedAt || null;
  return {
    ...primary,
    firstFailedAt,
    consecutiveFailures,
    alerted: consecutiveFailures >= COLLECT_ALERT_THRESHOLD,
    notified,
    notifiedAt,
  };
}

function readCollectAlerts(options = null) {
  const file = collectAlertsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (!err || err.code === "ENOENT") return emptyCollectAlertsDoc();
    console.warn(`[dataStats] 读取 collect-alerts.json 失败 (${file}):`, (err && err.message) || err);
    return emptyCollectAlertsDoc();
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.accounts)) {
      return emptyCollectAlertsDoc();
    }
    const opts = isPlainObject(options) ? options : null;
    const accounts = Object.create(null);
    let migrated = false;
    for (const k of Object.keys(parsed.accounts)) {
      const desc = Object.getOwnPropertyDescriptor(parsed.accounts, k);
      const norm = normalizeCollectAlertEntry(desc ? desc.value : null, {
        resolveGroupAccounts: opts && opts.resolveGroupAccounts,
        onMigrated: () => {
          migrated = true;
        },
      });
      if (norm) {
        accounts[norm.key] = mergeCollectAlertEntries(accounts[norm.key], norm);
      }
    }
    const doc = {
      version: COLLECT_ALERTS_VERSION,
      updatedAt:
        typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
          ? parsed.updatedAt
          : 0,
      accounts,
    };
    if (migrated && !(opts && opts.noPersist)) {
      try {
        writeCollectAlerts(doc, doc.updatedAt || Date.now());
      } catch (_) {
        /* 只读环境下忽略写回失败，内存结果已完成迁移 */
      }
    }
    return doc;
  } catch (err) {
    console.warn(`[dataStats] collect-alerts.json JSON 损坏 (${file}):`, (err && err.message) || err);
    return emptyCollectAlertsDoc();
  }
}

function writeCollectAlerts(doc, now = Date.now()) {
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const plainAccounts = {};
  const src = doc && isPlainObject(doc.accounts) ? doc.accounts : {};
  for (const k of Object.keys(src)) {
    const norm = normalizeCollectAlertEntry(src[k], { skipLegacyMigration: true });
    if (norm) {
      plainAccounts[norm.key] = norm;
    }
  }
  const payload = {
    version: COLLECT_ALERTS_VERSION,
    updatedAt: ts,
    accounts: plainAccounts,
  };
  writeWorksDailyAtomic(collectAlertsFile(), payload);
  return payload;
}

function recordCollectFailure(group, platform, reason, now = Date.now(), meta = null) {
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const m = isPlainObject(meta) ? meta : null;
  const doc = readCollectAlerts();
  const key = collectAlertKey(group, platform, m);
  const prev = doc.accounts[key] || null;
  const cleanReason =
    typeof reason === "string" && reason.trim() ? reason.trim() : "采集失败";
  const classified = classifyCollectError(cleanReason, m ? m.errorObj : null);
  const isLoginError =
    m && typeof m.isLoginError === "boolean" ? m.isLoginError : classified.isLoginError;
  const errorType =
    m && typeof m.errorType === "string" && m.errorType.trim()
      ? m.errorType.trim()
      : isLoginError
      ? "login_expired"
      : classified.errorType;
  const errorTypeLabel =
    errorType === "login_expired"
      ? "登录失效"
      : errorType === "zero_works"
      ? "空作品异常"
      : "接口错误";
  const consecutiveFailures = prev ? prev.consecutiveFailures + 1 : 1;
  const accountKey = resolveCollectAlertAccountKey(group, platform, m);
  const partition =
    (m && typeof m.partition === "string" && m.partition.trim()) ||
    (prev && prev.partition) ||
    "";
  const accountName =
    (m && typeof m.accountName === "string" && m.accountName.trim()) ||
    (prev && prev.accountName) ||
    accountKey;
  const groupStr = String(group || "").trim() || accountKey;
  const platformStr = String(platform || "").trim();
  const state = {
    key,
    group: groupStr,
    platform: platformStr,
    accountKey,
    accountName,
    partition,
    account: formatCollectAlertAccountLabel(groupStr, platformStr, accountKey, accountName),
    reason: cleanReason,
    errorType,
    errorTypeLabel,
    isLoginError,
    firstFailedAt: prev && prev.firstFailedAt > 0 ? prev.firstFailedAt : ts,
    lastFailedAt: ts,
    consecutiveFailures,
    alerted: consecutiveFailures >= COLLECT_ALERT_THRESHOLD,
    notified: prev ? Boolean(prev.notified) : false,
    notifiedAt: prev ? prev.notifiedAt || null : null,
  };
  doc.accounts[key] = state;
  writeCollectAlerts(doc, ts);
  return {
    state,
    alerted: state.alerted,
    shouldNotify: state.alerted && !state.notified,
  };
}

function markCollectAlertNotified(group, platform, now = Date.now(), meta = null) {
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const doc = readCollectAlerts();
  const key = collectAlertKey(group, platform, meta);
  const entry = doc.accounts[key];
  if (!entry) return null;
  entry.notified = true;
  entry.notifiedAt = ts;
  writeCollectAlerts(doc, ts);
  return entry;
}

function clearCollectFailure(group, platform, now = Date.now(), meta = null) {
  const doc = readCollectAlerts();
  const key = collectAlertKey(group, platform, meta);
  const g = String(group || "").trim();
  const pt = String(platform || "").trim();
  let removed = false;
  if (doc.accounts[key]) {
    delete doc.accounts[key];
    removed = true;
  }
  // 旧版按分组归键且未唯一映射的告警条目（如多账号分组）：组内任一账号采集成功即清除
  for (const existingKey of Object.keys(doc.accounts)) {
    const entry = doc.accounts[existingKey];
    if (
      entry &&
      entry.legacyGroupScoped === true &&
      entry.group === g &&
      entry.platform === pt
    ) {
      delete doc.accounts[existingKey];
      removed = true;
    }
  }
  if (!removed) return false;
  writeCollectAlerts(doc, now);
  return true;
}

function sortCollectAlerts(list) {
  return list.sort((a, b) => {
    if (a.group !== b.group) return a.group < b.group ? -1 : 1;
    if (a.platform !== b.platform) return a.platform < b.platform ? -1 : 1;
    const ak = a.accountKey || "";
    const bk = b.accountKey || "";
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

function getAccountCollectFailureState(group, platform, meta = null) {
  const doc = readCollectAlerts();
  const key = collectAlertKey(group, platform, meta);
  if (doc.accounts[key]) return doc.accounts[key];
  if (hasExplicitAccountMeta(meta)) return null;
  const g = String(group || "").trim();
  const pt = String(platform || "").trim();
  const matched = Object.values(doc.accounts).filter(
    (entry) => entry && entry.group === g && entry.platform === pt
  );
  if (!matched.length) return null;
  matched.sort((a, b) => {
    if (Boolean(b.alerted) !== Boolean(a.alerted)) return b.alerted ? 1 : -1;
    return (b.lastFailedAt || 0) - (a.lastFailedAt || 0);
  });
  return matched[0];
}

function getAccountCollectAlert(group, platform, meta = null) {
  const state = getAccountCollectFailureState(group, platform, meta);
  return state && state.alerted ? state : null;
}

function getAccountCollectAlerts(group, platform) {
  const doc = readCollectAlerts();
  const g = String(group || "").trim();
  const pt = String(platform || "").trim();
  return sortCollectAlerts(
    Object.values(doc.accounts).filter(
      (entry) => entry && entry.alerted && entry.group === g && entry.platform === pt
    )
  );
}

function listActiveCollectAlerts() {
  const doc = readCollectAlerts();
  return sortCollectAlerts(
    Object.values(doc.accounts).filter((entry) => entry && entry.alerted)
  );
}

/* ---------------- 采集日志 ---------------- */

const MAX_COLLECT_LOGS = 100;

function collectLogFile() {
  return path.join(baseDir(), "collect-logs.json");
}

/** 追加一次采集任务记录（新记录在前，最多保留 100 次） */
function appendCollectLog(taskLog) {
  const logs = readJson(collectLogFile(), []);
  logs.unshift(taskLog);
  writeJson(collectLogFile(), logs.slice(0, MAX_COLLECT_LOGS));
}

function readCollectLogs() {
  return readJson(collectLogFile(), []);
}

/* ---------------- auto-run（每日/分时段自动采集运行记录） ---------------- */

const MAX_AUTO_RUN_DATES = 14;
const MAX_AUTO_RUN_PARTITIONS = 256;
const VALID_AUTO_INTERVAL_HOURS = new Set([1, 2, 3, 4, 6]);
const DEFAULT_AUTO_SETTINGS = Object.freeze({
  enabled: true,
  mode: "daily",
  startTime: "08:00",
  endTime: "22:00",
  intervalHours: 2,
  time: "10:00",
  retentionDays: DEFAULT_INTRADAY_RETENTION_DAYS,
  updatedAt: 0,
  scheduleUpdatedAt: 0,
});

function autoRunFile() {
  return path.join(baseDir(), "auto-run.json");
}

function autoSettingsFile() {
  return path.join(baseDir(), "auto-settings.json");
}

function normalizeAutoSettingsDoc(raw) {
  if (!isPlainObject(raw)) {
    return { ...DEFAULT_AUTO_SETTINGS };
  }
  const mode = raw.mode === "interval" ? "interval" : "daily";
  const ih = typeof raw.intervalHours === "number" ? raw.intervalHours : Number(raw.intervalHours);
  const intervalHours =
    Number.isInteger(ih) && VALID_AUTO_INTERVAL_HOURS.has(ih)
      ? ih
      : DEFAULT_AUTO_SETTINGS.intervalHours;
  const startTime =
    typeof raw.startTime === "string" && SLOT_TIME_RE.test(raw.startTime.trim())
      ? raw.startTime.trim()
      : DEFAULT_AUTO_SETTINGS.startTime;
  const endTime =
    typeof raw.endTime === "string" && END_TIME_RE.test(raw.endTime.trim())
      ? raw.endTime.trim()
      : DEFAULT_AUTO_SETTINGS.endTime;
  const time =
    typeof raw.time === "string" && SLOT_TIME_RE.test(raw.time.trim())
      ? raw.time.trim()
      : DEFAULT_AUTO_SETTINGS.time;
  const retentionDays = normalizeRetentionDaysOption(raw.retentionDays);
  const updatedAt =
    typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0
      ? raw.updatedAt
      : 0;
  const scheduleUpdatedAt =
    typeof raw.scheduleUpdatedAt === "number" &&
    Number.isFinite(raw.scheduleUpdatedAt) &&
    raw.scheduleUpdatedAt >= 0
      ? raw.scheduleUpdatedAt
      : 0;
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_AUTO_SETTINGS.enabled,
    mode,
    startTime,
    endTime,
    intervalHours,
    time,
    retentionDays,
    updatedAt,
    scheduleUpdatedAt,
  };
}

/**
 * 读取主进程持久化的自动采集与保留期设置（<userData>/data-stats/auto-settings.json）。
 * 不存在返回默认值（retentionDays=60）；损坏或结构无效告警并返回默认值。
 */
function readAutoSettings() {
  const file = autoSettingsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ...DEFAULT_AUTO_SETTINGS };
    console.warn(`[dataStats] 读取 auto-settings.json 失败 (${file}):`, (err && err.message) || err);
    return { ...DEFAULT_AUTO_SETTINGS };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] auto-settings.json JSON 损坏 (${file}):`, (err && err.message) || err);
    return { ...DEFAULT_AUTO_SETTINGS };
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[dataStats] auto-settings.json 结构无效 (${file})`);
    return { ...DEFAULT_AUTO_SETTINGS };
  }
  return normalizeAutoSettingsDoc(parsed);
}

/**
 * 原子持久化自动采集与保留期设置（<userData>/data-stats/auto-settings.json）。
 * 当调度参数（mode / startTime / endTime / intervalHours 或 enabled 由关到开）变化时，
 * 自动记录主进程权威生效边界 scheduleUpdatedAt = now。
 * 若 opts.initOnly=true 且文件已存在，直接返回现有持久化设置，不覆盖。
 */
function writeAutoSettings(patch, now = Date.now(), opts = null) {
  const file = autoSettingsFile();
  const initOnly = Boolean(isPlainObject(opts) && opts.initOnly);
  const exists = fs.existsSync(file);
  if (initOnly && exists) {
    return readAutoSettings();
  }
  const prev = exists ? readAutoSettings() : { ...DEFAULT_AUTO_SETTINGS };
  const mergedRaw = { ...prev };
  if (isPlainObject(patch)) {
    for (const k of [
      "enabled",
      "mode",
      "startTime",
      "endTime",
      "intervalHours",
      "time",
      "retentionDays",
    ]) {
      if (patch[k] !== undefined) mergedRaw[k] = patch[k];
    }
  }
  const next = normalizeAutoSettingsDoc(mergedRaw);
  const ts = typeof now === "number" && Number.isFinite(now) && now > 0 ? now : Date.now();
  const scheduleChanged =
    prev.mode !== next.mode ||
    prev.startTime !== next.startTime ||
    prev.endTime !== next.endTime ||
    prev.intervalHours !== next.intervalHours ||
    (!prev.enabled && next.enabled);

  if (initOnly) {
    next.scheduleUpdatedAt = 0;
  } else if (
    isPlainObject(patch) &&
    typeof patch.scheduleUpdatedAt === "number" &&
    Number.isFinite(patch.scheduleUpdatedAt) &&
    patch.scheduleUpdatedAt >= 0
  ) {
    next.scheduleUpdatedAt = patch.scheduleUpdatedAt;
  } else if (scheduleChanged) {
    next.scheduleUpdatedAt = ts;
  } else {
    next.scheduleUpdatedAt = prev.scheduleUpdatedAt;
  }
  next.updatedAt = ts;

  writeWorksDailyAtomic(file, next);
  return next;
}

function isValidAutoRunDate(str) {
  if (typeof str !== "string" || !WORKS_DAILY_DATE_RE.test(str)) return false;
  const [year, month, day] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function isValidAutoRunSlot(str) {
  if (typeof str !== "string") return false;
  const match = AUTO_RUN_SLOT_RE.exec(str);
  if (!match) return false;
  return isValidAutoRunDate(match[1]);
}

function isValidAutoRunEntry(str) {
  return isValidAutoRunDate(str) || isValidAutoRunSlot(str);
}

/**
 * 归一化 auto-run.json 记录：
 * - 兼容旧按日期记录 ("YYYY-MM-DD") 与新按槽记录 ("YYYY-MM-DD HH:mm")
 * - 去重保持追加顺序，按所属日期保留最近 MAX_AUTO_RUN_DATES（14）个不同日历日的全部记录
 */
function normalizeAutoRuns(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const deduped = [];
  for (const item of list) {
    if (!isValidAutoRunEntry(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    deduped.push(item);
  }
  // 从末尾向前收集最多 MAX_AUTO_RUN_DATES 个不同日历日（保留最新 14 天的全部槽与兼容日期记录）
  const keptDates = new Set();
  for (let i = deduped.length - 1; i >= 0; i--) {
    const d = deduped[i].slice(0, 10);
    if (!keptDates.has(d)) {
      if (keptDates.size >= MAX_AUTO_RUN_DATES) continue;
      keptDates.add(d);
    }
  }
  return deduped.filter((item) => keptDates.has(item.slice(0, 10)));
}

function normalizePartitionAutoRunAt(raw) {
  const entries = [];
  if (isPlainObject(raw)) {
    for (const key of Object.keys(raw)) {
      const k = typeof key === "string" ? key.trim() : "";
      if (!k) continue;
      const desc = Object.getOwnPropertyDescriptor(raw, key);
      const ts = desc ? desc.value : null;
      if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
        entries.push([k, ts]);
      }
    }
  }
  if (entries.length > MAX_AUTO_RUN_PARTITIONS) {
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = MAX_AUTO_RUN_PARTITIONS;
  }
  const out = Object.create(null);
  for (const [k, ts] of entries) {
    out[k] = ts;
  }
  return out;
}

/**
 * 读取 <userData>/data-stats/auto-run.json 完整状态（runs + lastAutoRunAt + partitionAutoRunAt）。
 * 兼容旧格式 { runs: [...] }；不存在返回空状态；损坏告警返回空状态；读 I/O 错误上抛。
 */
function readAutoRunState() {
  const file = autoRunFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { runs: [], lastAutoRunAt: 0, partitionAutoRunAt: Object.create(null) };
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[dataStats] auto-run.json JSON 损坏 (${file}):`, (err && err.message) || err);
    return { runs: [], lastAutoRunAt: 0, partitionAutoRunAt: Object.create(null) };
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.runs)) {
    console.warn(`[dataStats] auto-run.json 结构无效 (${file})`);
    return { runs: [], lastAutoRunAt: 0, partitionAutoRunAt: Object.create(null) };
  }
  const lastAutoRunAt =
    typeof parsed.lastAutoRunAt === "number" &&
    Number.isFinite(parsed.lastAutoRunAt) &&
    parsed.lastAutoRunAt > 0
      ? parsed.lastAutoRunAt
      : 0;
  return {
    runs: normalizeAutoRuns(parsed.runs),
    lastAutoRunAt,
    partitionAutoRunAt: normalizePartitionAutoRunAt(parsed.partitionAutoRunAt),
  };
}

/**
 * 读取 <userData>/data-stats/auto-run.json 中的已运行日期/时段槽列表。
 * 不存在返回 []；JSON 损坏或结构无效告警并返回 []；读 I/O 错误上抛由调用方处理。
 */
function readAutoRuns() {
  return readAutoRunState().runs;
}

function buildAutoRunPayload(runs, lastAutoRunAt, partitionAutoRunAt) {
  const payload = { runs };
  if (typeof lastAutoRunAt === "number" && Number.isFinite(lastAutoRunAt) && lastAutoRunAt > 0) {
    payload.lastAutoRunAt = lastAutoRunAt;
  }
  const partMap = normalizePartitionAutoRunAt(partitionAutoRunAt);
  if (Object.keys(partMap).length > 0) {
    payload.partitionAutoRunAt = partMap;
  }
  return payload;
}

/**
 * 追加运行日期 ("YYYY-MM-DD") 或时段槽 ("YYYY-MM-DD HH:mm") 到 auto-run.json
 * （复用原子写，仅保留最近 14 天的记录）。可选记录本次自动采集时间戳 meta.autoRunAt。
 * 写入失败直接抛错，保留旧文件完整。
 */
function appendAutoRun(entry, meta = null) {
  if (!isValidAutoRunEntry(entry)) {
    throw new Error(`非法自动采集记录: ${entry}`);
  }
  const state = readAutoRunState();
  const normalized = normalizeAutoRuns([...state.runs, entry]);
  let lastAutoRunAt = state.lastAutoRunAt;
  if (
    isPlainObject(meta) &&
    typeof meta.autoRunAt === "number" &&
    Number.isFinite(meta.autoRunAt) &&
    meta.autoRunAt > 0
  ) {
    lastAutoRunAt = meta.autoRunAt;
  }
  const partMap = state.partitionAutoRunAt;
  if (isPlainObject(meta) && isPlainObject(meta.partitionAutoRunAt)) {
    for (const k of Object.keys(meta.partitionAutoRunAt)) {
      const nk = typeof k === "string" ? k.trim() : "";
      const ts = meta.partitionAutoRunAt[k];
      if (nk && typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
        partMap[nk] = ts;
      }
    }
  }
  writeWorksDailyAtomic(autoRunFile(), buildAutoRunPayload(normalized, lastAutoRunAt, partMap));
  return normalized;
}

/**
 * 更新 auto-run.json 中的全局与分区最近自动采集时间戳（原子写）。
 */
function updateAutoRunTimestamps({ lastAutoRunAt, partitionAutoRunAt } = {}) {
  const state = readAutoRunState();
  const nextLast =
    typeof lastAutoRunAt === "number" && Number.isFinite(lastAutoRunAt) && lastAutoRunAt > 0
      ? Math.max(lastAutoRunAt, Number(state.lastAutoRunAt) || 0) // 只前进不后退：时钟回拨不覆盖较新限流记录
      : state.lastAutoRunAt;
  const partMap = state.partitionAutoRunAt;
  if (isPlainObject(partitionAutoRunAt)) {
    for (const k of Object.keys(partitionAutoRunAt)) {
      const nk = typeof k === "string" ? k.trim() : "";
      const ts = partitionAutoRunAt[k];
      if (nk && typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
        partMap[nk] = Math.max(ts, Number(partMap[nk]) || 0);
      }
    }
  }
  writeWorksDailyAtomic(autoRunFile(), buildAutoRunPayload(state.runs, nextLast, partMap));
  return {
    runs: state.runs,
    lastAutoRunAt: nextLast,
    partitionAutoRunAt: partMap,
  };
}

/* ---------------- link-overrides（跨平台关联手工矫正） ---------------- */

const LINK_OVERRIDES_VERSION = 1;
const FORBIDDEN_PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UNSTABLE_RECORD_KEY_RE = /^record:(?:.*:)?pos:\d+$/;

function isPosRecordKey(key) {
  return (
    typeof key === "string" &&
    (key.startsWith("record:pos:") || UNSTABLE_RECORD_KEY_RE.test(key))
  );
}

function linkOverridesFile() {
  return path.join(baseDir(), "link-overrides.json");
}

function emptyLinkOverrides() {
  return {
    version: LINK_OVERRIDES_VERSION,
    updatedAt: 0,
    contents: Object.create(null),
    excludedAuto: Object.create(null),
    deletedContents: Object.create(null),
    overrides: Object.create(null),
  };
}

function isSyntheticContentKey(key) {
  return (
    typeof key === "string" &&
    ((key.startsWith("auto:") && key.length > "auto:".length) ||
      (key.startsWith("manual:") && key.length > "manual:".length))
  );
}

/** 校验可删除/隐藏的内容键：非空、无首尾空白、禁止原型污染键名 */
function isValidDeletableContentKey(key) {
  if (typeof key !== "string") return false;
  const trimmed = key.trim();
  if (!trimmed || trimmed !== key) return false;
  return !FORBIDDEN_PROTO_KEYS.has(trimmed);
}

/** 校验作品身份键 `platform|workId`（恰含一个 `|` 且平台与作品 ID 均非空） */
function isValidWorkIdentityKey(key) {
  if (typeof key !== "string" || !key) return false;
  const sep = key.indexOf("|");
  if (sep <= 0 || sep >= key.length - 1) return false;
  return key.indexOf("|", sep + 1) === -1;
}

function normalizeLinkContentEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.title !== "string") return null;
  if (typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt)) return null;
  return {
    title: entry.title,
    createdAt: entry.createdAt,
  };
}

function normalizeLinkContentsMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const contentKey of Object.keys(rawMap)) {
    if (!isSyntheticContentKey(contentKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, contentKey);
    const normalized = normalizeLinkContentEntry(desc ? desc.value : null);
    if (normalized) {
      out[contentKey] = normalized;
    }
  }
  return out;
}

function normalizeExcludedAutoMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const pwKey of Object.keys(rawMap)) {
    if (!isValidWorkIdentityKey(pwKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, pwKey);
    if (desc && desc.value === true) {
      out[pwKey] = true;
    }
  }
  return out;
}

function normalizeDeletedContentEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (
    typeof entry.deletedAt !== "number" ||
    !Number.isFinite(entry.deletedAt) ||
    entry.deletedAt < 0
  ) {
    return null;
  }
  const out = { deletedAt: entry.deletedAt };
  if (Object.prototype.hasOwnProperty.call(entry, "title") && typeof entry.title === "string") {
    const trimmed = entry.title.trim();
    if (trimmed) out.title = trimmed;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "pwKeys") && Array.isArray(entry.pwKeys)) {
    const seen = new Set();
    const validPwKeys = [];
    for (const rawKey of entry.pwKeys) {
      if (!isValidWorkIdentityKey(rawKey)) continue;
      if (seen.has(rawKey)) continue;
      seen.add(rawKey);
      validPwKeys.push(rawKey);
    }
    validPwKeys.sort();
    out.pwKeys = validPwKeys;
  }
  return out;
}

function normalizeDeletedContentsMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const contentKey of Object.keys(rawMap)) {
    if (!isValidDeletableContentKey(contentKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, contentKey);
    const normalized = normalizeDeletedContentEntry(desc ? desc.value : null);
    if (normalized) {
      out[contentKey] = normalized;
    }
  }
  return out;
}

function normalizeLinkOverrideEntry(entry) {
  if (!isPlainObject(entry)) return null;
  if (typeof entry.action !== "string") return null;
  const action = entry.action;
  if (action === "detach") {
    return { action: "detach" };
  }
  if (action === "assign") {
    if (typeof entry.contentKey !== "string") return null;
    const contentKey = entry.contentKey.trim();
    if (!contentKey || contentKey.startsWith("unlinked:")) return null;
    return { action: "assign", contentKey };
  }
  return null;
}

function normalizeLinkOverridesMap(rawMap) {
  const out = Object.create(null);
  if (!isPlainObject(rawMap)) return out;
  for (const pwKey of Object.keys(rawMap)) {
    if (!isValidWorkIdentityKey(pwKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(rawMap, pwKey);
    const normalized = normalizeLinkOverrideEntry(desc ? desc.value : null);
    if (normalized) {
      out[pwKey] = normalized;
    }
  }
  return out;
}

function syncExcludedAutoFromOverrides(excludedAuto, overrides, rawOverrides) {
  for (const pwKey of Object.keys(overrides)) {
    if (overrides[pwKey].action === "detach") {
      excludedAuto[pwKey] = true;
    } else if (isPlainObject(rawOverrides)) {
      const desc = Object.getOwnPropertyDescriptor(rawOverrides, pwKey);
      if (desc && isPlainObject(desc.value) && desc.value.excludeAuto === true) {
        excludedAuto[pwKey] = true;
      }
    }
  }
  return excludedAuto;
}

const LINK_OVERRIDES_READ_ERROR_MESSAGE = "读取手工矫正配置失败，请稍后重试";
const LINK_OVERRIDES_READ_ERROR_CODES = new Set([
  "LINK_OVERRIDES_READ_ERROR",
  "LINK_OVERRIDES_PARSE_ERROR",
  "LINK_OVERRIDES_INVALID_SCHEMA",
]);

function makeLinkOverridesReadError(message, code, cause) {
  const err = new Error(message);
  if (code) err.code = code;
  if (cause) err.cause = cause;
  err.isLinkOverridesReadError = true;
  return err;
}

function isLinkOverridesReadError(err) {
  if (!err || typeof err !== "object") return false;
  if (err.isLinkOverridesReadError === true) return true;
  if (typeof err.code === "string" && LINK_OVERRIDES_READ_ERROR_CODES.has(err.code)) {
    return true;
  }
  return false;
}

function readLinkOverridesInternal(file) {
  try {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") {
        return { ok: true, missing: true, doc: emptyLinkOverrides() };
      }
      const reason = (err && err.message) || String(err);
      return {
        ok: false,
        warnMsg: `[dataStats] 读取 link-overrides.json 失败 (${file}): ${reason}`,
        error: makeLinkOverridesReadError(
          `读取 link-overrides.json 失败: ${reason}`,
          (err && err.code) || "LINK_OVERRIDES_READ_ERROR",
          err
        ),
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const reason = (err && err.message) || String(err);
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json JSON 损坏 (${file}): ${reason}`,
        error: makeLinkOverridesReadError(
          `link-overrides.json JSON 损坏: ${reason}`,
          "LINK_OVERRIDES_PARSE_ERROR",
          err
        ),
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json 结构无效 (${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json 结构无效",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    if (parsed.version !== LINK_OVERRIDES_VERSION) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json version 无效（需 === ${LINK_OVERRIDES_VERSION}）(${file})`,
        error: makeLinkOverridesReadError(
          `link-overrides.json version 无效（需 === ${LINK_OVERRIDES_VERSION}）`,
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isFinite(parsed.updatedAt)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json updatedAt 无效（需有限数字）(${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json updatedAt 无效（需有限数字）",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    if (!isPlainObject(parsed.overrides)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json overrides 结构无效 (${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json overrides 结构无效",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    const hasContents =
      Object.prototype.hasOwnProperty.call(parsed, "contents") && parsed.contents !== undefined;
    if (hasContents && !isPlainObject(parsed.contents)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json contents 结构无效 (${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json contents 结构无效",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    const hasExcludedAuto =
      Object.prototype.hasOwnProperty.call(parsed, "excludedAuto") &&
      parsed.excludedAuto !== undefined;
    if (hasExcludedAuto && !isPlainObject(parsed.excludedAuto)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json excludedAuto 结构无效 (${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json excludedAuto 结构无效",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    const hasDeletedContents =
      Object.prototype.hasOwnProperty.call(parsed, "deletedContents") &&
      parsed.deletedContents !== undefined;
    if (hasDeletedContents && !isPlainObject(parsed.deletedContents)) {
      return {
        ok: false,
        warnMsg: `[dataStats] link-overrides.json deletedContents 结构无效 (${file})`,
        error: makeLinkOverridesReadError(
          "link-overrides.json deletedContents 结构无效",
          "LINK_OVERRIDES_INVALID_SCHEMA"
        ),
      };
    }
    const overrides = normalizeLinkOverridesMap(parsed.overrides);
    const excludedAuto = syncExcludedAutoFromOverrides(
      hasExcludedAuto ? normalizeExcludedAutoMap(parsed.excludedAuto) : Object.create(null),
      overrides,
      parsed.overrides
    );
    const deletedContents = hasDeletedContents
      ? normalizeDeletedContentsMap(parsed.deletedContents)
      : Object.create(null);
    return {
      ok: true,
      missing: false,
      doc: {
        version: LINK_OVERRIDES_VERSION,
        updatedAt: parsed.updatedAt,
        contents: hasContents ? normalizeLinkContentsMap(parsed.contents) : Object.create(null),
        excludedAuto,
        deletedContents,
        overrides,
      },
    };
  } catch (err) {
    const reason = (err && err.message) || String(err);
    return {
      ok: false,
      warnMsg: `[dataStats] 解析 link-overrides.json 异常 (${file}): ${reason}`,
      error: makeLinkOverridesReadError(
        `解析 link-overrides.json 异常: ${reason}`,
        (err && err.code) || "LINK_OVERRIDES_READ_ERROR",
        err
      ),
    };
  }
}

/**
 * 读取 <userData>/data-stats/link-overrides.json。
 * - 文件不存在（ENOENT）一律视为空配置；
 * - 严格校验 version === 1、updatedAt 为有限数字、overrides/contents/excludedAuto/deletedContents 结构；
 * - strict/throwOnError 模式（供所有写路径及导出/汇总/分析/趋势读取路径使用）：区分 ENOENT 与读/解析失败，失败直接抛错，避免用空配置覆盖旧文件或漏出已删内容；
 * - 未传 strict 时仅保留给遗留直接调用方的非抛出 warn + 空配置回退。
 */
function readLinkOverrides(options = {}) {
  const strict = Boolean(options && (options.strict || options.throwOnError));
  const res = readLinkOverridesInternal(linkOverridesFile());
  if (res.ok) return res.doc;
  if (strict) throw res.error;
  console.warn(res.warnMsg);
  return emptyLinkOverrides();
}

function readLinkOverridesStrict() {
  return readLinkOverrides({ strict: true });
}

/** 原子写入 <userData>/data-stats/link-overrides.json（复用 tmp + fsync + rename） */
function writeLinkOverrides(docOrMap, now = Date.now()) {
  const isDoc =
    isPlainObject(docOrMap) &&
    (isPlainObject(docOrMap.overrides) ||
      isPlainObject(docOrMap.deletedContents) ||
      isPlainObject(docOrMap.contents) ||
      isPlainObject(docOrMap.excludedAuto));
  const rawMap = isDoc ? (isPlainObject(docOrMap.overrides) ? docOrMap.overrides : null) : docOrMap;
  const rawContents = isDoc && isPlainObject(docOrMap.contents) ? docOrMap.contents : null;
  const rawExcludedAuto =
    isDoc && isPlainObject(docOrMap.excludedAuto) ? docOrMap.excludedAuto : null;
  const rawDeletedContents =
    isDoc && isPlainObject(docOrMap.deletedContents) ? docOrMap.deletedContents : null;
  const overrides = normalizeLinkOverridesMap(rawMap);
  const contents = normalizeLinkContentsMap(rawContents);
  const excludedAuto = syncExcludedAutoFromOverrides(
    normalizeExcludedAutoMap(rawExcludedAuto),
    overrides,
    rawMap
  );
  const deletedContents = normalizeDeletedContentsMap(rawDeletedContents);
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const payload = {
    version: LINK_OVERRIDES_VERSION,
    updatedAt: ts,
    contents,
    excludedAuto,
    deletedContents,
    overrides,
  };
  writeWorksDailyAtomic(linkOverridesFile(), payload);
  return payload;
}

function setLinkOverride(workKey, entry, now = Date.now(), contentMeta) {
  if (!isValidWorkIdentityKey(workKey)) {
    throw new Error("workKey 必须为有效的作品身份 platform|workId");
  }
  const normalized = normalizeLinkOverrideEntry(entry);
  if (!normalized) {
    throw new Error("无效的手动关联操作（需为 assign+contentKey 或 detach）");
  }
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const current = readLinkOverridesStrict();
  if (normalized.action === "detach" || (entry && entry.excludeAuto === true)) {
    current.excludedAuto[workKey] = true;
  }
  current.overrides[workKey] = normalized;
  if (
    normalized.action === "assign" &&
    isSyntheticContentKey(normalized.contentKey) &&
    contentMeta &&
    !current.contents[normalized.contentKey]
  ) {
    const normMeta = normalizeLinkContentEntry({
      title: typeof contentMeta.title === "string" ? contentMeta.title : "",
      createdAt:
        typeof contentMeta.createdAt === "number" && Number.isFinite(contentMeta.createdAt)
          ? contentMeta.createdAt
          : ts,
    });
    if (normMeta) {
      current.contents[normalized.contentKey] = normMeta;
    }
  }
  return writeLinkOverrides(current, ts);
}

function clearLinkOverride(workKey, now = Date.now()) {
  if (!isValidWorkIdentityKey(workKey)) {
    throw new Error("workKey 必须为有效的作品身份 platform|workId");
  }
  const current = readLinkOverridesStrict();
  delete current.overrides[workKey];
  delete current.excludedAuto[workKey];
  return writeLinkOverrides(current, now);
}

function mergeWorksOverride(workKeys, now = Date.now(), title = "") {
  if (!Array.isArray(workKeys)) {
    throw new Error("workKeys 必须为数组");
  }
  const uniqueKeys = [];
  const seen = new Set();
  for (const k of workKeys) {
    if (!isValidWorkIdentityKey(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    uniqueKeys.push(k);
  }
  if (uniqueKeys.length < 2) {
    throw new Error("至少需要选择 2 条作品才能合并");
  }
  const ts = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
  const current = readLinkOverridesStrict();
  const contentKey = `manual:${crypto.randomBytes(8).toString("hex")}`;
  current.contents[contentKey] = {
    title: typeof title === "string" ? title : "",
    createdAt: ts,
  };
  for (const k of uniqueKeys) {
    current.overrides[k] = { action: "assign", contentKey };
  }
  const doc = writeLinkOverrides(current, ts);
  return { contentKey, workKeys: uniqueKeys, doc };
}

function deleteContentsOverride(contentKeys, now = Date.now()) {
  const list = Array.isArray(contentKeys) ? contentKeys : [contentKeys];
  const uniqueItems = [];
  const seen = new Set();
  for (const raw of list) {
    let ck = "";
    let title;
    let pwKeys;
    if (typeof raw === "string") {
      ck = raw.trim();
    } else if (isPlainObject(raw)) {
      ck = typeof raw.contentKey === "string" ? raw.contentKey.trim() : "";
      if (typeof raw.title === "string" && raw.title.trim()) {
        title = raw.title.trim();
      }
      if (Array.isArray(raw.pwKeys)) {
        pwKeys = raw.pwKeys;
      }
    }
    if (!isValidDeletableContentKey(ck)) {
      throw new Error("contentKey 无效");
    }
    if (seen.has(ck)) continue;
    seen.add(ck);
    uniqueItems.push({ ck, title, pwKeys });
  }
  if (!uniqueItems.length) {
    throw new Error("contentKeys 不能为空");
  }
  const ts = typeof now === "number" && Number.isFinite(now) && now >= 0 ? now : Date.now();
  const current = readLinkOverridesStrict();
  for (const item of uniqueItems) {
    const existing = Object.prototype.hasOwnProperty.call(current.deletedContents, item.ck)
      ? current.deletedContents[item.ck]
      : null;
    const isPosTitleShift =
      existing &&
      isPosRecordKey(item.ck) &&
      typeof item.title === "string" &&
      item.title &&
      existing.title !== item.title;
    if (!existing || isPosTitleShift) {
      const nextEntry = { deletedAt: ts };
      if (item.title) nextEntry.title = item.title;
      if (Array.isArray(item.pwKeys)) nextEntry.pwKeys = item.pwKeys;
      current.deletedContents[item.ck] = normalizeDeletedContentEntry(nextEntry);
    }
  }
  return writeLinkOverrides(current, ts);
}

function restoreContentsOverride(contentKeys, now = Date.now()) {
  const list = Array.isArray(contentKeys) ? contentKeys : [contentKeys];
  const uniqueKeys = [];
  const seen = new Set();
  for (const raw of list) {
    const ck = typeof raw === "string" ? raw.trim() : "";
    if (!isValidDeletableContentKey(ck)) {
      throw new Error("contentKey 无效");
    }
    if (seen.has(ck)) continue;
    seen.add(ck);
    uniqueKeys.push(ck);
  }
  if (!uniqueKeys.length) {
    throw new Error("contentKeys 不能为空");
  }
  const ts = typeof now === "number" && Number.isFinite(now) && now >= 0 ? now : Date.now();
  const current = readLinkOverridesStrict();
  for (const ck of uniqueKeys) {
    delete current.deletedContents[ck];
  }
  return writeLinkOverrides(current, ts);
}

/* ---------------- group-settings（分组统计起点日期） ---------------- */

const DEFAULT_GROUP_START_DATES = Object.freeze({
  人间善恶录: "2026-11-15",
  赛博老司机: "2026-11-24",
});
const GROUP_SETTINGS_MIN_YEAR = 1970;
const GROUP_SETTINGS_MAX_YEAR = 2100;

function groupSettingsFile() {
  return path.join(baseDir(), "group-settings.json");
}

function isValidGroupStartDate(str) {
  if (typeof str !== "string") return false;
  const trimmed = str.trim();
  if (!isValidAutoRunDate(trimmed)) return false;
  const y = Number(trimmed.slice(0, 4));
  return y >= GROUP_SETTINGS_MIN_YEAR && y <= GROUP_SETTINGS_MAX_YEAR;
}

/**
 * 清洗分组统计起点日期映射为无原型字典 `{ [group]: "YYYY-MM-DD" }`：
 * - 拒绝原型污染键名（__proto__ / constructor / prototype）
 * - 兼容直接值 "YYYY-MM-DD" 与对象值 { statsStartDate: "YYYY-MM-DD" }
 * - 坏数据（非法日期 / 非字符串 / 越界年份等）静默忽略（回落为未设置=不限制）
 */
function normalizeGroupSettings(raw) {
  const out = Object.create(null);
  if (!isPlainObject(raw)) return out;
  for (const rawKey of Object.keys(raw)) {
    if (typeof rawKey !== "string") continue;
    const group = rawKey.trim();
    if (!group || FORBIDDEN_PROTO_KEYS.has(group)) continue;
    const desc = Object.getOwnPropertyDescriptor(raw, rawKey);
    const val = desc ? desc.value : undefined;
    let dateStr = "";
    if (typeof val === "string") {
      dateStr = val.trim();
    } else if (isPlainObject(val) && typeof val.statsStartDate === "string") {
      dateStr = val.statsStartDate.trim();
    }
    if (dateStr && isValidGroupStartDate(dateStr)) {
      out[group] = dateStr;
    }
  }
  return out;
}

/**
 * 读取 <userData>/data-stats/group-settings.json，返回无原型字典 `{ [group]: "YYYY-MM-DD" }`。
 * - 文件不存在（ENOENT）返回空字典
 * - 非 strict 模式下 JSON 损坏 / 结构无效 / 读失败 warn 并回落为空字典（不限制）
 * - strict 模式下（供改名迁移使用）读失败或结构损坏直接抛错，防止误写盘
 */
function readGroupSettings(options = {}) {
  const strict = Boolean(options && (options.strict || options.throwOnError));
  const file = groupSettingsFile();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return Object.create(null);
    if (strict) throw err;
    console.warn(`[dataStats] 读取 group-settings.json 失败 (${file}):`, (err && err.message) || err);
    return Object.create(null);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    if (strict) {
      const e = new Error(`group-settings.json JSON 损坏: ${(err && err.message) || err}`);
      e.code = "GROUP_SETTINGS_PARSE_ERROR";
      e.cause = err;
      throw e;
    }
    console.warn(`[dataStats] group-settings.json JSON 损坏 (${file}):`, (err && err.message) || err);
    return Object.create(null);
  }
  if (!isPlainObject(parsed)) {
    if (strict) {
      const e = new Error("group-settings.json 结构无效（需为对象）");
      e.code = "GROUP_SETTINGS_INVALID_SCHEMA";
      throw e;
    }
    console.warn(`[dataStats] group-settings.json 结构无效 (${file})`);
    return Object.create(null);
  }
  return normalizeGroupSettings(parsed);
}

/** 原子持久化 group-settings.json（无原型清洗后落盘） */
function writeGroupSettings(rawMap) {
  const normalized = normalizeGroupSettings(rawMap);
  writeWorksDailyAtomic(groupSettingsFile(), normalized);
  return normalized;
}

/**
 * 设置或清空单个分组的统计起点日期（YYYY-MM-DD，UTC+8）。
 * dateStr 为空串 / null / undefined 时清空该分组限制。
 * 写入前严格读取现有 group-settings.json：仅 ENOENT 视为空配置，
 * 任何非 ENOENT 读失败（如 EBUSY/EPERM）或 JSON 损坏/结构异常直接拒绝写入并抛错，绝不以空配置覆盖。
 */
function setGroupStartDate(group, dateStr) {
  const g = typeof group === "string" ? group.trim() : "";
  if (!g || FORBIDDEN_PROTO_KEYS.has(g)) {
    throw new Error("分组名称无效");
  }
  const isClear = dateStr === undefined || dateStr === null || (typeof dateStr === "string" && !dateStr.trim());
  let validDate = "";
  if (!isClear) {
    if (typeof dateStr !== "string" || !isValidGroupStartDate(dateStr)) {
      throw new Error(`起点日期无效（需 YYYY-MM-DD）：${dateStr}`);
    }
    validDate = dateStr.trim();
  }
  const current = readGroupSettings({ strict: true });
  if (isClear) {
    delete current[g];
  } else {
    current[g] = validDate;
  }
  return writeGroupSettings(current);
}

/** 扫描本地账号记录（account/*.json）中的全部分组名，供首次启动默认配置迁移识别已有分组 */
function listExistingAccountGroupsFromDisk() {
  const groups = new Set();
  const candidateDirs = [];
  try {
    if (app && typeof app.getPath === "function") {
      const docs = app.getPath("documents");
      if (docs) candidateDirs.push(path.join(docs, "MatrixMedia", "data", "account"));
      const ud = app.getPath("userData");
      if (ud) candidateDirs.push(path.join(ud, "data", "account"));
    }
  } catch (_) {}
  for (const dir of candidateDirs) {
    let entries;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    } catch (_) {
      continue;
    }
    for (const file of entries) {
      const rows = readJson(path.join(dir, file), []);
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!isPlainObject(row)) continue;
        const g =
          (typeof row.group === "string" && row.group.trim()) ||
          (typeof row.phone === "string" ? row.phone.split("-")[0].trim() : "");
        if (g) groups.add(g);
      }
    }
  }
  return groups;
}

/**
 * 首次启动默认起点日期迁移：
 * 仅当 group-settings.json 不存在时检查是否存在目标分组（data-stats 子目录或账号记录），
 * 若命中则写入对应默认值（{ "人间善恶录": "2026-11-15", "赛博老司机": "2026-11-24" } 的存在子集）。
 * 已存在 group-settings.json（包括用户手动清空后的 `{}`）绝不覆盖。
 */
function migrateDefaultGroupSettings(options = {}) {
  const file = groupSettingsFile();
  try {
    fs.statSync(file);
    return { migrated: false, reason: "exists", settings: readGroupSettings() };
  } catch (statErr) {
    if (!statErr || statErr.code !== "ENOENT") {
      return { migrated: false, reason: "read-error", settings: Object.create(null) };
    }
  }
  const existingGroups = new Set();
  if (options && (Array.isArray(options.existingGroups) || options.existingGroups instanceof Set)) {
    for (const g of options.existingGroups) {
      if (typeof g === "string" && g.trim()) existingGroups.add(g.trim());
    }
  } else {
    const root = baseDir();
    try {
      if (fs.existsSync(root)) {
        for (const name of fs.readdirSync(root)) {
          const full = path.join(root, name);
          try {
            if (fs.statSync(full).isDirectory()) existingGroups.add(name);
          } catch (_) {}
        }
      }
    } catch (_) {}
    for (const g of listExistingAccountGroupsFromDisk()) {
      existingGroups.add(g);
    }
  }

  const initial = Object.create(null);
  for (const [groupName, defaultDate] of Object.entries(DEFAULT_GROUP_START_DATES)) {
    if (existingGroups.has(groupName) || existingGroups.has(safeSeg(groupName))) {
      initial[groupName] = defaultDate;
    }
  }
  if (Object.keys(initial).length === 0) {
    return { migrated: false, reason: "no-target-groups", settings: Object.create(null) };
  }
  const saved = writeGroupSettings(initial);
  return { migrated: true, reason: "migrated", settings: saved };
}

/**
 * 统计各分组中被 statsStartDate 排除的起点前作品条数（按 group 内去重 platform|workId 计数）。
 * 发布时间缺失的作品视为不排除。
 */
function countExcludedWorksBeforeStartDate(groupSettingsInput) {
  const settings = normalizeGroupSettings(
    groupSettingsInput !== undefined ? groupSettingsInput : readGroupSettings()
  );
  const excludedByGroup = {};
  let excludedTotal = 0;
  if (Object.keys(settings).length === 0) {
    return { excludedByGroup, excludedTotal };
  }
  const seenByGroup = new Map();
  for (const acc of listAccounts()) {
    const group = String(acc.group || "").trim();
    if (!group) continue;
    const startDate = settings[group];
    if (!startDate) continue;
    const works = readWorks(acc.group, acc.platform).works || [];
    let seen = seenByGroup.get(group);
    if (!seen) {
      seen = new Set();
      seenByGroup.set(group, seen);
    }
    for (const w of works) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const pubMs = parseValidPublishTime(w.publishTime);
      if (pubMs === null) continue;
      const pubDate = todayStr(pubMs);
      if (pubDate && pubDate < startDate) {
        seen.add(`${acc.platform}|${String(w.workId)}`);
      }
    }
  }
  for (const [group, set] of seenByGroup.entries()) {
    if (set.size > 0) {
      Object.defineProperty(excludedByGroup, group, {
        value: set.size,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      excludedTotal += set.size;
    }
  }
  return { excludedByGroup, excludedTotal };
}

/* ---------------- 读取与聚合 ---------------- */

/** 单账号完整数据（平台页用） */
function readAccount(group, platform) {
  const alerts = getAccountCollectAlerts(group, platform);
  return {
    group,
    platform,
    daily: readDaily(group, platform),
    works: readWorks(group, platform).works,
    meta: readJson(path.join(accountDir(group, platform), "meta.json"), {}),
    collectAlert: alerts[0] || getAccountCollectAlert(group, platform),
    collectAlerts: alerts,
  };
}

/** 列出已采集的账号 */
function listAccounts() {
  const out = [];
  const root = baseDir();
  if (!fs.existsSync(root)) return out;
  for (const group of fs.readdirSync(root)) {
    const gDir = path.join(root, group);
    if (!fs.statSync(gDir).isDirectory()) continue;
    for (const platform of fs.readdirSync(gDir)) {
      const pDir = path.join(gDir, platform);
      if (!fs.statSync(pDir).isDirectory()) continue;
      out.push({
        group,
        platform,
        meta: readJson(path.join(pDir, "meta.json"), {}),
      });
    }
  }
  return out;
}

/** 全账号按日聚合（所有账号总览页用）；accounts 附最新快照与采集失败告警 */
function readOverview() {
  const merged = {};
  const alertsDoc = readCollectAlerts();
  const accounts = listAccounts().map((acc) => {
    const daily = readDaily(acc.group, acc.platform);
    const dates = Object.keys(daily).sort();
    const latest = dates.length ? daily[dates[dates.length - 1]] : null;
    for (const [date, snap] of Object.entries(daily)) {
      if (!merged[date]) {
        merged[date] = { fans: 0, plays: 0, likes: 0, comments: 0, favorites: 0, shares: 0 };
      }
      for (const k of METRIC_KEYS) {
        if (k === "plays" && snap && snap.playsAnomaly === true) continue;
        const v = Number(snap && snap[k]);
        if (Number.isFinite(v)) merged[date][k] += v;
      }
    }
    const matchedAlerts = sortCollectAlerts(
      Object.values(alertsDoc.accounts).filter(
        (entry) =>
          entry && entry.alerted && entry.group === acc.group && entry.platform === acc.platform
      )
    );
    const collectAlert = matchedAlerts[0] || null;
    return { ...acc, latest, collectAlert, collectAlerts: matchedAlerts };
  });
  const collectAlerts = sortCollectAlerts(
    Object.values(alertsDoc.accounts).filter((entry) => entry && entry.alerted)
  );
  return { daily: merged, accounts, collectAlerts };
}

module.exports = {
  METRIC_KEYS,
  WORK_STAT_KEYS,
  ACCOUNT_PLAYS_SHARP_DROP_RATIO,
  COLLECT_ALERTS_VERSION,
  COLLECT_ALERT_THRESHOLD,
  DEFAULT_INTRADAY_RETENTION_DAYS,
  mergeDaily,
  mergeWorks,
  recordWorksIntraday,
  cleanupWorksIntraday,
  readDaily,
  readWorks,
  readWorksDaily,
  readWorksDailyLatestAsOf,
  worksDailyDir,
  worksIntradayDir,
  readWorksIntraday,
  readWorksIntradayLatestCollectedAt,
  formatManualSlotKey,
  readAccount,
  readOverview,
  listAccounts,
  readMeta,
  writeMeta,
  getPreviousWorkCount,
  collectAlertsFile,
  collectAlertKey,
  resolveCollectAlertAccountKey,
  classifyCollectError,
  readCollectAlerts,
  writeCollectAlerts,
  recordCollectFailure,
  markCollectAlertNotified,
  clearCollectFailure,
  getAccountCollectFailureState,
  getAccountCollectAlert,
  getAccountCollectAlerts,
  listActiveCollectAlerts,
  appendCollectLog,
  readCollectLogs,
  MAX_AUTO_RUN_DATES,
  DEFAULT_AUTO_SETTINGS,
  autoRunFile,
  autoSettingsFile,
  readAutoSettings,
  writeAutoSettings,
  isValidAutoRunDate,
  isValidAutoRunSlot,
  readAutoRunState,
  readAutoRuns,
  appendAutoRun,
  updateAutoRunTimestamps,
  LINK_OVERRIDES_VERSION,
  LINK_OVERRIDES_READ_ERROR_MESSAGE,
  isLinkOverridesReadError,
  isValidDeletableContentKey,
  normalizeDeletedContentsMap,
  readLinkOverrides,
  readLinkOverridesStrict,
  writeLinkOverrides,
  setLinkOverride,
  clearLinkOverride,
  mergeWorksOverride,
  deleteContentsOverride,
  restoreContentsOverride,
  DEFAULT_GROUP_START_DATES,
  baseDir,
  safeSeg,
  writeWorksDailyAtomic,
  listGroupPlatformAccountsFromDisk,
  listExistingAccountGroupsFromDisk,
  groupSettingsFile,
  isValidGroupStartDate,
  normalizeGroupSettings,
  readGroupSettings,
  writeGroupSettings,
  setGroupStartDate,
  migrateDefaultGroupSettings,
  countExcludedWorksBeforeStartDate,
  todayStr,
};
