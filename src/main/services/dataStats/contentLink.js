"use strict";

/**
 * 跨平台作品关联与内容级汇总行构建（纯函数模块，不依赖 electron / fs）。
 *
 * 将 pushData 多平台发布记录按视频文件（或归一化标题）归并为「内容」（contentKey），
 * 再按「作品链接 > 同账号标题 > 全局唯一标题」三级优先级关联采集到的平台作品，
 * 并基于 works-daily 产出跨平台汇总行。
 */

const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const FULLWIDTH_ASCII_RE = /[\uFF01-\uFF5E]/g;

const CJK_PUNCT_MAP = {
  "。": ".",
  "、": ",",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "【": "[",
  "】": "]",
  "「": "[",
  "」": "]",
  "『": "[",
  "』": "]",
  "〔": "[",
  "〕": "]",
  "《": "<",
  "》": ">",
  "〈": "<",
  "〉": ">",
  "—": "-",
  "–": "-",
  "―": "-",
  "…": "...",
  "〜": "~",
  "·": ".",
  "・": ".",
  "｡": ".",
  "､": ",",
  "｟": "(",
  "｠": ")",
};
const CJK_PUNCT_RE = new RegExp(
  `[${Object.keys(CJK_PUNCT_MAP)
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"))
    .join("")}]`,
  "g"
);

const STAT_TO_TOTAL_KEY = {
  play: "totalPlay",
  like: "totalLike",
  comment: "totalComment",
  share: "totalShare",
  favorite: "totalFavorite",
  fansDelta: "totalFansDelta",
};

function hasOwn(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isPlainObject(v) {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/** 解析 YYYY-MM-DD 为 UTC 零点毫秒时间戳，非法日期返回 null */
function parseDateDayMs(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) return null;
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== dateStr) return null;
  return ms;
}

/** 将 YYYY-MM-DD 转为该 UTC+8 日历日正午（12:00+08:00 = 04:00Z），用于距离比较 */
function parseDateMidUtc8Ms(dateStr) {
  const dayMs = parseDateDayMs(dateStr);
  return dayMs === null ? null : dayMs + 4 * 3600e3;
}

/** 将毫秒时间戳 / ISO 字符串 / Date 规范化为正毫秒时间戳，无效返回 null */
function parsePublishTimeMs(raw) {
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
  return ms;
}

/** 毫秒时间戳转 UTC+8 日期串 YYYY-MM-DD */
function toUtc8DateStr(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
}

/**
 * 标题归一化（仅用于匹配，不用于展示）：
 * 去零宽字符、全角/中文标点归一、连续空白归一与首尾去空、去除末尾话题标签（#xxx / #xxx#）。
 *
 * @param {string} s
 * @returns {string}
 */
function normalizeTitle(s) {
  if (s == null) return "";
  let out = String(s);
  // 1. 去零宽字符与 BOM
  out = out.replace(ZERO_WIDTH_RE, "");
  // 2. 全角 ASCII（含全角标点与全角 ＃）→ 半角
  out = out.replace(FULLWIDTH_ASCII_RE, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  // 3. 常见中文/全角标点 → 半角等价标点
  out = out.replace(CJK_PUNCT_RE, (ch) => CJK_PUNCT_MAP[ch] || ch);
  // 4. 连续空白（含 \u3000 全角空格、换行、制表）归一为单个半角空格并去首尾空白
  out = out.replace(/\s+/g, " ").trim();
  // 5. 逐个剥离末尾话题标签（#话题 / #话题# / #话题[话题]#），保留 "学习 C#" 等非标签写法
  while (out) {
    const next = out.replace(/\s*#[^\s#]+#?$/, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 作品链接归一化（仅用于匹配）：去 ?query、#hash 与末尾斜杠；http(s) 协议与主机名转小写，路径保留大小写。
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeUrl(raw) {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const pathname = parsed.pathname.replace(/\/+$/, "");
      return `${parsed.origin}${pathname}`;
    }
  } catch (_) {
    /* 非完整 URL 时走字符串回退 */
  }
  return trimmed.split(/[?#]/)[0].replace(/\/+$/, "");
}

/** 构造 linkWorks 的键：`group|platform|workId` */
function makeWorkKey(group, platform, workId) {
  const g = group == null ? "" : String(group);
  const p = platform == null ? "" : String(platform);
  const id = workId == null ? "" : String(workId);
  return `${g}|${p}|${id}`;
}

/** 同时兼容 Windows（\）、POSIX（/）与远程 URL，取文件 basename */
function extractFileBasename(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    s = s.split(/[?#]/)[0];
  }
  s = s.replace(/[\\/]+$/, "");
  if (!s) return "";
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1].trim();
}

/** 去最后一个扩展名（保留前导点如 .hidden） */
function stripExtension(basename) {
  if (!basename) return "";
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx <= 0) return basename;
  return basename.slice(0, dotIdx);
}

/**
 * 从 pushData 记录提取分组名：与 src/shared/accountIdentity.js 的 recordGroupOf 一致，
 * 优先 rec.group，缺失时回退 rec.phone 的 "-" 前缀。
 */
function extractRecordGroup(rec) {
  if (!isPlainObject(rec)) return "";
  const group = String(rec.group || "").trim();
  if (group) return group;
  return String(rec.phone || "").split("-")[0].trim();
}

/** 从 pushData 记录提取展示标题（title / bt / data.bt1 / textOtherName / bookName） */
function extractRecordTitle(rec) {
  if (!isPlainObject(rec)) return "";
  const data = isPlainObject(rec.data) ? rec.data : null;
  const candidates = [
    rec.title,
    rec.bt,
    data ? data.title : "",
    data ? data.bt1 : "",
    rec.textOtherName,
    rec.bookName,
  ];
  for (const c of candidates) {
    const s = c == null ? "" : String(c).trim();
    if (s) return s;
  }
  return "";
}

/** 从 pushData 记录提取 YYYY-MM-DD 日期 */
function extractRecordDate(rec) {
  if (!isPlainObject(rec)) return "";
  for (const field of [rec.date, rec.publishDate, rec.firstPublishDate]) {
    if (typeof field === "string") {
      const s = field.trim().slice(0, 10);
      if (parseDateDayMs(s) !== null) return s;
    }
  }
  const ts = parsePublishTimeMs(rec.lastPublishAt || rec.createTime);
  return ts !== null ? toUtc8DateStr(ts) : "";
}

/**
 * 将 pushData 各平台记录归并为内容索引。
 *
 * - 只看视频类记录（textType !== "article"）
 * - 按视频文件 basename（去扩展名、小写）分组；无文件名时退回 normalizeTitle(title)
 *
 * @param {Array<object>} pushRecords
 * @returns {Array<{
 *   contentKey: string,
 *   displayTitle: string,
 *   file: string,
 *   firstPublishDate: string,
 *   targets: Array<{ group: string, platform: string, title: string, videoLink: string }>
 * }>}
 */
function buildContentIndex(pushRecords) {
  if (!Array.isArray(pushRecords)) return [];

  const buckets = new Map();

  for (const rec of pushRecords) {
    if (!isPlainObject(rec)) continue;
    if (String(rec.textType || "").trim().toLowerCase() === "article") {
      continue;
    }

    const platform = String(rec.pt || rec.platform || "").trim();
    const group = extractRecordGroup(rec);
    const title = extractRecordTitle(rec);
    const normTitle = normalizeTitle(title);
    const fileBasename =
      extractFileBasename(rec.selectedFile) ||
      extractFileBasename(rec.filePath) ||
      extractFileBasename(rec.file);
    const fileStem = stripExtension(fileBasename);
    const fileStemLower = fileStem.toLowerCase();
    const videoLink = String(rec.videoLink || "").trim();
    const normLink = normalizeUrl(videoLink);
    const date = extractRecordDate(rec);

    let contentKey = "";
    if (fileStemLower) {
      contentKey = `file:${fileStemLower}`;
    } else if (normTitle) {
      contentKey = `title:${normTitle}`;
    } else {
      continue;
    }

    let bucket = buckets.get(contentKey);
    if (!bucket) {
      bucket = {
        contentKey,
        displayTitle: "",
        displayTitleDate: "",
        file: "",
        fileDate: "",
        fallbackTitle: fileStem || title,
        firstPublishDate: "",
        targets: [],
      };
      buckets.set(contentKey, bucket);
    }

    if (fileBasename) {
      if (
        !bucket.file ||
        (date && (!bucket.fileDate || date < bucket.fileDate))
      ) {
        bucket.file = fileBasename;
        bucket.fileDate = date;
      }
    }

    if (date && (!bucket.firstPublishDate || date < bucket.firstPublishDate)) {
      bucket.firstPublishDate = date;
    }

    if (title) {
      if (
        !bucket.displayTitle ||
        (date && (!bucket.displayTitleDate || date < bucket.displayTitleDate))
      ) {
        bucket.displayTitle = title;
        bucket.displayTitleDate = date;
      }
    }

    // 同一 content 下若重复登记同一 (group, platform)：
    // - 归一化 videoLink 相同（同一作品链接），或
    // - 归一化标题相同且链接不冲突（如重发/后补 videoLink），
    // 合并为同一 target，避免造出冗余占位。
    const existingTarget = bucket.targets.find((t) => {
      if (t.group !== group || t.platform !== platform) return false;
      if (t._normLink && normLink && t._normLink === normLink) return true;
      if (t._normTitle !== normTitle) return false;
      if (t._normLink && normLink && t._normLink !== normLink) return false;
      return true;
    });

    if (existingTarget) {
      if (!existingTarget.videoLink && videoLink) {
        existingTarget.videoLink = videoLink;
        existingTarget._normLink = normLink;
      }
      if (!existingTarget.title && title) {
        existingTarget.title = title;
      }
    } else {
      bucket.targets.push({
        group,
        platform,
        title,
        videoLink,
        _normTitle: normTitle,
        _normLink: normLink,
      });
    }
  }

  const contents = [];
  for (const b of buckets.values()) {
    contents.push({
      contentKey: b.contentKey,
      displayTitle: b.displayTitle || b.fallbackTitle || "(无标题)",
      file: b.file,
      firstPublishDate: b.firstPublishDate,
      targets: b.targets.map((t) => ({
        group: t.group,
        platform: t.platform,
        title: t.title,
        videoLink: t.videoLink,
      })),
    });
  }

  contents.sort((a, b) => {
    if (a.firstPublishDate !== b.firstPublishDate) {
      if (!a.firstPublishDate) return 1;
      if (!b.firstPublishDate) return -1;
      return a.firstPublishDate < b.firstPublishDate ? -1 : 1;
    }
    return a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0;
  });

  return contents;
}

/**
 * 将各账号采集到的作品关联到内容索引。
 *
 * 匹配优先级：
 *   1. work.url 与 target.videoLink 归一化后相等（matchedBy: "link"）
 *   2. 同 group + platform 的 target 中 normalizeTitle 相等（matchedBy: "title"）
 *   3. 跨所有 target normalizeTitle 相等且目标唯一（matchedBy: "title-global"）
 *   4. 否则 contentKey = null, matchedBy = null
 *
 * 同一 target 最多被一个 work 占用；竞争时按 |work.publishTime - content.firstPublishDate| 最小者先得。
 *
 * @param {object} params
 * @param {Array<object>} [params.contents]
 * @param {Array<{ group: string, platform: string, works: Array<object> }>} [params.accounts]
 * @returns {Map<string, { contentKey: string | null, matchedBy: "link" | "title" | "title-global" | null }>}
 */
function linkWorks({ contents, accounts } = {}) {
  const result = new Map();
  if (!Array.isArray(accounts)) return result;

  // 1. 展开所有 target 并建立检索索引
  const targets = [];
  const targetsByUrl = new Map();
  const targetsByGpTitle = new Map();
  const targetsByTitle = new Map();

  if (Array.isArray(contents)) {
    for (const content of contents) {
      if (!isPlainObject(content) || !content.contentKey) continue;
      const contentKey = String(content.contentKey);
      const firstPublishDate =
        typeof content.firstPublishDate === "string"
          ? content.firstPublishDate.trim()
          : "";
      const firstPublishMidMs = parseDateMidUtc8Ms(firstPublishDate);
      const rawTargets = Array.isArray(content.targets) ? content.targets : [];

      for (const t of rawTargets) {
        if (!isPlainObject(t)) continue;
        const group = t.group == null ? "" : String(t.group).trim();
        const platform = t.platform == null ? "" : String(t.platform).trim();
        const title = t.title == null ? "" : String(t.title);
        const normTitle = normalizeTitle(title);
        const normUrl = normalizeUrl(t.videoLink);

        const entry = {
          targetIdx: targets.length,
          contentKey,
          firstPublishDate,
          firstPublishMidMs,
          group,
          platform,
          title,
          normTitle,
          normUrl,
        };
        targets.push(entry);

        if (normUrl) {
          if (!targetsByUrl.has(normUrl)) targetsByUrl.set(normUrl, []);
          targetsByUrl.get(normUrl).push(entry);
        }
        if (normTitle) {
          const gpKey = `${group}|${platform}|${normTitle}`;
          if (!targetsByGpTitle.has(gpKey)) targetsByGpTitle.set(gpKey, []);
          targetsByGpTitle.get(gpKey).push(entry);

          if (!targetsByTitle.has(normTitle)) targetsByTitle.set(normTitle, []);
          targetsByTitle.get(normTitle).push(entry);
        }
      }
    }
  }

  // 2. 展开所有 work 并初始化结果 Map
  const works = [];
  for (const acc of accounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    const accWorks = Array.isArray(acc.works) ? acc.works : [];

    for (const w of accWorks) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const workId = String(w.workId);
      const workKey = makeWorkKey(group, platform, workId);
      if (result.has(workKey)) continue;

      result.set(workKey, { contentKey: null, matchedBy: null });
      works.push({
        workIdx: works.length,
        group,
        platform,
        workId,
        workKey,
        normTitle: normalizeTitle(w.title),
        normUrl: normalizeUrl(w.url),
        publishTimeMs: parsePublishTimeMs(w.publishTime),
      });
    }
  }

  const matchedWorks = new Set();
  const occupiedTargets = new Set();

  function distanceMs(work, target) {
    if (work.publishTimeMs !== null && target.firstPublishMidMs !== null) {
      return Math.abs(work.publishTimeMs - target.firstPublishMidMs);
    }
    return Infinity;
  }

  function applyPass(candidates, matchedBy) {
    if (!candidates.length) return;
    candidates.sort((a, b) => {
      if (a.preference !== b.preference) return a.preference - b.preference;
      if (a.distance !== b.distance) return a.distance - b.distance;
      if (a.work.workIdx !== b.work.workIdx) return a.work.workIdx - b.work.workIdx;
      return a.target.targetIdx - b.target.targetIdx;
    });
    for (const c of candidates) {
      if (matchedWorks.has(c.work.workIdx) || occupiedTargets.has(c.target.targetIdx)) {
        continue;
      }
      matchedWorks.add(c.work.workIdx);
      occupiedTargets.add(c.target.targetIdx);
      result.set(c.work.workKey, {
        contentKey: c.target.contentKey,
        matchedBy,
      });
    }
  }

  // Pass 1：链接匹配（① work.url === target.videoLink，去 query/尾斜杠）
  const pass1 = [];
  for (const w of works) {
    if (!w.normUrl) continue;
    const hits = targetsByUrl.get(w.normUrl);
    if (!hits || !hits.length) continue;
    for (const t of hits) {
      const sameGp = t.group === w.group && t.platform === w.platform;
      const samePlatform = t.platform === w.platform;
      pass1.push({
        work: w,
        target: t,
        preference: sameGp ? 0 : samePlatform ? 1 : 2,
        distance: distanceMs(w, t),
      });
    }
  }
  applyPass(pass1, "link");

  // Pass 2：同 group + platform 标题匹配（②）
  const pass2 = [];
  for (const w of works) {
    if (matchedWorks.has(w.workIdx) || !w.normTitle) continue;
    const gpKey = `${w.group}|${w.platform}|${w.normTitle}`;
    const hits = targetsByGpTitle.get(gpKey);
    if (!hits || !hits.length) continue;
    for (const t of hits) {
      if (occupiedTargets.has(t.targetIdx)) continue;
      pass2.push({
        work: w,
        target: t,
        preference: 0,
        distance: distanceMs(w, t),
      });
    }
  }
  applyPass(pass2, "title");

  // Pass 3：跨所有 target 标题相等且唯一（③）
  // 唯一性基于全量 targets 判定（避免已占用 target 掩盖多内容歧义）：
  // - 全部匹配 target 必须同属 1 个 contentKey；
  // - 若全量仅 1 个 target，直接作为候选；
  // - 若该 content 下有多个不同平台 target（如分组改名场景），仅当同平台 target 唯一时作为候选，
  //   杜绝同账号第二条同名视频跨平台抢占其他平台的 target。
  const pass3 = [];
  for (const w of works) {
    if (matchedWorks.has(w.workIdx) || !w.normTitle) continue;
    const allHits = targetsByTitle.get(w.normTitle);
    if (!allHits || !allHits.length) continue;

    const firstContentKey = allHits[0].contentKey;
    let singleContent = true;
    for (let i = 1; i < allHits.length; i++) {
      if (allHits[i].contentKey !== firstContentKey) {
        singleContent = false;
        break;
      }
    }
    if (!singleContent) continue;

    let candidateTarget = null;
    if (allHits.length === 1) {
      candidateTarget = allHits[0];
    } else {
      const samePlat = allHits.filter((t) => t.platform === w.platform);
      if (samePlat.length === 1) {
        candidateTarget = samePlat[0];
      }
    }

    if (candidateTarget && !occupiedTargets.has(candidateTarget.targetIdx)) {
      pass3.push({
        work: w,
        target: candidateTarget,
        preference: 0,
        distance: distanceMs(w, candidateTarget),
      });
    }
  }
  applyPass(pass3, "title-global");

  return result;
}

/** 按账号查找 worksDaily：支持 Map 或对象（"group|platform"、嵌套 [group][platform]、"platform|group" 或 account.worksDaily） */
function getAccountWorksDaily(worksDaily, group, platform, account) {
  const g = group == null ? "" : String(group);
  const p = platform == null ? "" : String(platform);
  const keyGP = `${g}|${p}`;
  const keyPG = `${p}|${g}`;

  if (worksDaily instanceof Map) {
    if (worksDaily.has(keyGP)) return worksDaily.get(keyGP);
    if (worksDaily.has(keyPG)) return worksDaily.get(keyPG);
  } else if (isPlainObject(worksDaily)) {
    if (hasOwn(worksDaily, keyGP)) return worksDaily[keyGP];
    if (hasOwn(worksDaily, g) && isPlainObject(worksDaily[g]) && hasOwn(worksDaily[g], p)) {
      return worksDaily[g][p];
    }
    if (hasOwn(worksDaily, keyPG)) return worksDaily[keyPG];
  }

  if (account && isPlainObject(account.worksDaily)) {
    return account.worksDaily;
  }
  return null;
}

/**
 * 读取某作品截至 cutoffDate（可省，默认最新）的累计指标。
 * 返回 `{ found, metrics }`；当指定 cutoffDate 且作品仅在更晚日期有快照时返回 `{ found: false }`。
 */
function resolveWorkMetricsAsOf(work, accWorksDaily, cutoffDate) {
  const workId = String(work.workId);
  const hasAccDaily = isPlainObject(accWorksDaily);
  const dateMap =
    hasAccDaily && hasOwn(accWorksDaily, workId) && isPlainObject(accWorksDaily[workId])
      ? accWorksDaily[workId]
      : null;

  if (dateMap) {
    let hasAnyValidDate = false;
    let bestDate = "";
    let bestSnap = null;
    for (const [d, snap] of Object.entries(dateMap)) {
      if (!isPlainObject(snap)) continue;
      if (parseDateDayMs(d) === null) continue;
      hasAnyValidDate = true;
      if (cutoffDate && d > cutoffDate) continue;
      if (!bestDate || d > bestDate) {
        bestDate = d;
        bestSnap = snap;
      }
    }
    if (bestSnap) {
      const metrics = {};
      for (const k of WORK_STAT_KEYS) {
        metrics[k] = hasOwn(bestSnap, k) ? normalizeMetric(bestSnap[k]) : null;
      }
      return { found: true, metrics };
    }
    if (hasAnyValidDate) {
      return { found: false, metrics: null };
    }
  }

  // 若传入了该账号的 worksDaily 且指定了截止日期，但该作品无任何日快照，避免泄漏未来累计值
  if (cutoffDate) {
    if (hasAccDaily) {
      return { found: false, metrics: null };
    }
    const pubMs = parsePublishTimeMs(work.publishTime);
    if (pubMs !== null && toUtc8DateStr(pubMs) > cutoffDate) {
      return { found: false, metrics: null };
    }
  }

  const metrics = {};
  for (const k of WORK_STAT_KEYS) {
    metrics[k] = hasOwn(work, k) ? normalizeMetric(work[k]) : null;
  }
  return { found: true, metrics };
}

function lookupLinkEntry(link, workKey) {
  if (link instanceof Map) return link.get(workKey) || null;
  if (isPlainObject(link) && hasOwn(link, workKey)) return link[workKey] || null;
  return null;
}

function sumNullable(values) {
  let hasNumber = false;
  let sum = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    hasNumber = true;
    sum += v;
  }
  if (!hasNumber) return null;
  return sum === 0 ? 0 : sum;
}

function mergeMetricValue(prev, next) {
  if (prev === null || prev === undefined) return next == null ? null : next;
  if (next === null || next === undefined) return prev;
  const total = prev + next;
  return total === 0 ? 0 : total;
}

/**
 * 构建跨平台内容级汇总行（截至 date，默认最新）。
 *
 * - 已关联到同一 contentKey 的多平台作品合并为一行，null 指标不计入合计（全 null 时合计为 null）
 * - 未关联作品各自成行，contentKey = "unlinked:<platform>:<workId>"，title = 作品标题
 * - perPlatform 键格式为 "<平台>|<分组>"
 *
 * @param {object} params
 * @param {Array<object>} [params.contents]
 * @param {Array<{ group: string, platform: string, works: Array<object> }>} [params.accounts]
 * @param {Map|object} [params.link]
 * @param {Map|object} [params.worksDaily]  按账号的 worksDaily（键 "group|platform" 或嵌套 [group][platform]）
 * @param {string} [params.date]            截止日期 YYYY-MM-DD（含），可省（默认最新）
 * @returns {Array<object>}
 */
function buildContentSummaryRows({ contents, accounts, link, worksDaily, date } = {}) {
  if (!Array.isArray(accounts)) return [];

  const cutoffDate = typeof date === "string" && date.trim() ? date.trim() : "";
  if (cutoffDate && parseDateDayMs(cutoffDate) === null) {
    return [];
  }

  const resolvedLink = link != null ? link : linkWorks({ contents, accounts });

  const contentByKey = new Map();
  if (Array.isArray(contents)) {
    for (const c of contents) {
      if (isPlainObject(c) && c.contentKey) {
        contentByKey.set(String(c.contentKey), c);
      }
    }
  }

  const buckets = new Map();
  const seenWorkKeys = new Set();

  for (const acc of accounts) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    const accWorks = Array.isArray(acc.works) ? acc.works : [];
    const accWorksDaily = getAccountWorksDaily(worksDaily, group, platform, acc);

    for (const w of accWorks) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const workId = String(w.workId);
      const workKey = makeWorkKey(group, platform, workId);
      if (seenWorkKeys.has(workKey)) continue;
      seenWorkKeys.add(workKey);

      const resolved = resolveWorkMetricsAsOf(w, accWorksDaily, cutoffDate);
      if (!resolved.found) continue;
      const metrics = resolved.metrics;

      const linkEntry = lookupLinkEntry(resolvedLink, workKey);
      const linkedContentKey =
        linkEntry && linkEntry.contentKey != null && String(linkEntry.contentKey)
          ? String(linkEntry.contentKey)
          : null;

      const workTitle = w.title ? String(w.title) : "(无标题)";
      const workUrl = w.url ? String(w.url) : "";
      const workPubDate = toUtc8DateStr(parsePublishTimeMs(w.publishTime));

      const rowContentKey = linkedContentKey || `unlinked:${platform}:${workId}`;
      const bucketId = linkedContentKey
        ? `linked:${linkedContentKey}`
        : `unlinked:${group}|${platform}|${workId}`;

      let bucket = buckets.get(bucketId);
      if (!bucket) {
        const meta = linkedContentKey ? contentByKey.get(linkedContentKey) : null;
        bucket = {
          contentKey: rowContentKey,
          title: meta ? meta.displayTitle || workTitle : workTitle,
          file: meta ? meta.file || "" : "",
          firstPublishDate: meta ? meta.firstPublishDate || workPubDate : workPubDate,
          perPlatform: {},
          metricLists: {
            play: [],
            like: [],
            comment: [],
            share: [],
            favorite: [],
            fansDelta: [],
          },
        };
        buckets.set(bucketId, bucket);
      } else if (!bucket.firstPublishDate && workPubDate) {
        bucket.firstPublishDate = workPubDate;
      }

      const pgKey = `${platform}|${group}`;
      if (!hasOwn(bucket.perPlatform, pgKey)) {
        bucket.perPlatform[pgKey] = {
          play: metrics.play,
          like: metrics.like,
          comment: metrics.comment,
          share: metrics.share,
          favorite: metrics.favorite,
          fansDelta: metrics.fansDelta,
          url: workUrl,
        };
      } else {
        const existing = bucket.perPlatform[pgKey];
        for (const k of WORK_STAT_KEYS) {
          existing[k] = mergeMetricValue(existing[k], metrics[k]);
        }
        if (!existing.url && workUrl) existing.url = workUrl;
      }

      for (const k of WORK_STAT_KEYS) {
        bucket.metricLists[k].push(metrics[k]);
      }
    }
  }

  const rows = [];
  for (const b of buckets.values()) {
    const row = {
      contentKey: b.contentKey,
      title: b.title,
      file: b.file,
      firstPublishDate: b.firstPublishDate,
      platformCount: Object.keys(b.perPlatform).length,
      totalPlay: null,
      totalLike: null,
      totalComment: null,
      totalShare: null,
      totalFavorite: null,
      totalFansDelta: null,
      perPlatform: b.perPlatform,
    };
    for (const k of WORK_STAT_KEYS) {
      row[STAT_TO_TOTAL_KEY[k]] = sumNullable(b.metricLists[k]);
    }
    rows.push(row);
  }

  // 按首次发布日期降序（无日期置后），同日按总播放降序（null 置后），再按 contentKey 升序
  rows.sort((a, b) => {
    if (a.firstPublishDate !== b.firstPublishDate) {
      if (!a.firstPublishDate) return 1;
      if (!b.firstPublishDate) return -1;
      return a.firstPublishDate > b.firstPublishDate ? -1 : 1;
    }
    const ap = a.totalPlay;
    const bp = b.totalPlay;
    if (ap !== bp) {
      if (ap === null) return 1;
      if (bp === null) return -1;
      return bp - ap;
    }
    return a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0;
  });

  return rows;
}

module.exports = {
  normalizeTitle,
  normalizeUrl,
  makeWorkKey,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
};
