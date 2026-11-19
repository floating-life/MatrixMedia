"use strict";

/**
 * 跨平台作品关联与内容级汇总行构建（纯函数模块，不依赖 electron / fs）。
 *
 * 原则：误关联比漏关联更糟；证据不足一律留空（未关联作品单独成行）。
 *
 * 已知限制：同一分组同一平台挂多个账号时，统计存储（userData/data-stats/<分组>/<平台>/）
 * 本身按「分组/平台」合并（上游结构），跨平台关联也只能到这一粒度。
 */

const { WORK_STAT_KEYS, normalizeMetric } = require("./statsTable");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const FULLWIDTH_ASCII_RE = /[\uFF01-\uFF5E]/g;
const TRACKING_PARAM_RE =
  /^(?:utm_|share_|spm(?:$|_)|from$|modefrom$|vd_source$|fbclid$|gclid$|xsec_token$|xsec_source$)/i;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const UTC8_MS = 8 * 3600e3;

const CJK_PUNCT_MAP = {
  "。": ".", "、": ",", "“": '"', "”": '"', "‘": "'", "’": "'",
  "【": "[", "】": "]", "「": "[", "」": "]", "『": "[", "』": "]", "〔": "[", "〕": "]",
  "《": "<", "》": ">", "〈": "<", "〉": ">", "｟": "(", "｠": ")",
  "—": "-", "–": "-", "―": "-", "…": "...", "〜": "~", "·": ".", "・": ".", "｡": ".", "､": ",",
};
const CJK_PUNCT_RE = new RegExp(
  `[${Object.keys(CJK_PUNCT_MAP).map((c) => c.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("")}]`,
  "g"
);

const STAT_TO_TOTAL_KEY = {
  play: "totalPlay", like: "totalLike", comment: "totalComment",
  share: "totalShare", favorite: "totalFavorite", fansDelta: "totalFansDelta",
};

// 对齐 src/main/config/ptConfig.js（index / listIndex / upload），管理页兜底链接不参与直链匹配
const MANAGEMENT_URL_KEYS = new Set([
  "creator.douyin.com/creator-micro/home", "creator.douyin.com/creator-micro/content/manage", "creator.douyin.com/creator-micro/content/post/video",
  "channels.weixin.qq.com/platform", "channels.weixin.qq.com/platform/post/list", "channels.weixin.qq.com/platform/post/create",
  "member.bilibili.com/platform/home", "member.bilibili.com/platform/upload-manager/article", "member.bilibili.com/platform/upload/video/frame",
  "baijiahao.baidu.com/builder/rc/home", "baijiahao.baidu.com/builder/rc/content", "baijiahao.baidu.com/builder/rc/edit",
  "mp.toutiao.com/profile_v4/index", "mp.toutiao.com/profile_v4/manage/content/all", "mp.toutiao.com/profile_v4/xigua/upload-video",
  "cp.kuaishou.com/profile", "cp.kuaishou.com/article/manage/video", "cp.kuaishou.com/article/publish/video",
  "creator.xiaohongshu.com/new/home", "creator.xiaohongshu.com/new/note-manager", "creator.xiaohongshu.com/publish/publish",
  "juejin.cn/login", "juejin.cn/creator/content/article/essays", "juejin.cn/editor/drafts/new",
  "pugc.yueduwuxian.com/fqvideo/login", "pugc.yueduwuxian.com/fqvideo/home/video-list", "pugc.yueduwuxian.com/fqvideo/home/publish-video",
]);

const hasOwn = (obj, k) => Boolean(obj && Object.prototype.hasOwnProperty.call(obj, k));
const isPlainObject = (v) => Boolean(v && typeof v === "object" && !Array.isArray(v));
const pushToMap = (map, k, v) => {
  const arr = map.get(k);
  if (arr) arr.push(v);
  else map.set(k, [v]);
};

function isValidDateStr(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR && d.toISOString().slice(0, 10) === s;
}

/** 校验时间戳为合法 Date 且年份（含 UTC+8 偏移）在 2000–2100 内，否则返回 null，不抛错 */
function parseValidTimestampMs(raw) {
  if (raw == null || raw === "") return null;
  let ms = NaN;
  if (typeof raw === "number") ms = raw;
  else if (raw instanceof Date) ms = raw.getTime();
  else if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  const shifted = new Date(t + UTC8_MS);
  if (!Number.isFinite(shifted.getTime())) return null;
  const y = d.getUTCFullYear();
  const sy = shifted.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR && sy >= MIN_YEAR && sy <= MAX_YEAR ? t : null;
}

function toUtc8DateStr(raw) {
  const ms = parseValidTimestampMs(raw);
  return ms === null ? "" : new Date(ms + UTC8_MS).toISOString().slice(0, 10);
}

/** 标题归一化（仅用于匹配）：去零宽字符、全角/中文标点归一、空白归一、去末尾话题标签 */
function normalizeTitle(s) {
  if (s == null) return "";
  let out = String(s)
    .replace(ZERO_WIDTH_RE, "")
    .replace(FULLWIDTH_ASCII_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(CJK_PUNCT_RE, (ch) => CJK_PUNCT_MAP[ch] || ch)
    .replace(/\s+/g, " ")
    .trim();
  while (out) {
    const next = out.replace(/\s*#[^\s#]+#?$/, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function parseHttpUrl(raw) {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** URL 归一化：保留 path 与非追踪 query，去除 fragment、尾斜杠与常见追踪参数 */
function normalizeUrl(raw) {
  if (raw == null) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const parsed = parseHttpUrl(trimmed);
  if (parsed) {
    const pathname = parsed.pathname.replace(/\/+$/, "");
    const kept = [...parsed.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort((a, b) =>
        a[0] !== b[0] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0
      );
    const qs = kept.length ? `?${new URLSearchParams(kept).toString()}` : "";
    return `${parsed.origin}${pathname}${qs}`;
  }
  const noHash = trimmed.split("#")[0];
  const qIdx = noHash.indexOf("?");
  return qIdx === -1
    ? noHash.replace(/\/+$/, "")
    : `${noHash.slice(0, qIdx).replace(/\/+$/, "")}${noHash.slice(qIdx)}`;
}

function isManagementUrl(raw) {
  const parsed = parseHttpUrl(raw);
  return Boolean(
    parsed && MANAGEMENT_URL_KEYS.has(`${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`)
  );
}

function normalizeDirectUrl(raw) {
  return parseHttpUrl(raw) && !isManagementUrl(raw) ? normalizeUrl(raw) : "";
}

/** 规范化完整本地路径（Win 盘符 / UNC / POSIX 绝对路径），非完整路径返回 "" */
function normalizeFullPath(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim().replace(/\\/g, "/");
  if (!s) return "";
  const isUnc = s.startsWith("//");
  s = isUnc ? `//${s.slice(2).replace(/\/+/g, "/")}` : s.replace(/\/+/g, "/");
  if (s.endsWith("/")) return "";
  if (/^[a-zA-Z]:\/.+/.test(s) || (!isUnc && /^\/.+/.test(s)) || (isUnc && /^\/\/[^/]+\/[^/]+\/.+/.test(s))) {
    return s;
  }
  return "";
}

function makeWorkKey(group, platform, workId) {
  return `${group == null ? "" : String(group)}|${platform == null ? "" : String(platform)}|${workId == null ? "" : String(workId)}`;
}

function extractRecordDate(rec, status) {
  if (rec.scheduledTask === true && status === "success") {
    const doneDate = toUtc8DateStr(rec.lastPublishAt);
    if (doneDate) return doneDate;
  }
  if (typeof rec.date === "string") {
    const s = rec.date.trim();
    if (isValidDateStr(s)) return s;
  }
  return toUtc8DateStr(rec.lastPublishAt) || toUtc8DateStr(rec.createTime);
}

function collectMatchTitles(values) {
  const out = [];
  for (const item of values) {
    const norm = normalizeTitle(item);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * 构建内容索引：
 * - 排除图文与未确认发布记录（仅保留 publishStatus === "success" 或有效非管理页直链）
 * - 仅按完整路径归桶（小写、/ 分隔）；无完整路径各自独立为 `record:<日期>:<id或序号>`
 * - 每条平台记录独立成 target，不再按文件+平台折叠
 */
function buildContentIndex(pushRecords) {
  if (!Array.isArray(pushRecords)) return [];
  const buckets = new Map();

  for (let idx = 0; idx < pushRecords.length; idx++) {
    const rec = pushRecords[idx];
    if (!isPlainObject(rec)) continue;
    if (String(rec.textType || "").trim().toLowerCase() === "article") continue;

    const status = String(rec.publishStatus || "").trim().toLowerCase();
    const rawVideoLink = String(rec.videoLink || "").trim();
    const validLink = normalizeDirectUrl(rawVideoLink);
    if (status !== "success" && !validLink) continue;

    const platform = String(rec.pt || "").trim();
    const group = String(rec.group || "").trim() || String(rec.phone || "").split("-")[0].trim();
    const recordDate = extractRecordDate(rec, status);
    // 真实 pushData 完整路径在 filePath（LocalVideoPublish.vue:2095），兼容完整路径写入 selectedFile
    const fullPath = normalizeFullPath(rec.filePath) || normalizeFullPath(rec.selectedFile);
    const title = [rec.title, rec.bt, rec.textOtherName, rec.bookName]
      .map((v) => (v == null ? "" : String(v).trim()))
      .find(Boolean) || "";
    const matchRaw = platform === "视频号"
      ? [rec.title, rec.bt, rec.textOtherName, rec.shortTitle, rec.bt2Filled]
      : [rec.title, rec.bt, rec.textOtherName];

    let contentKey;
    if (fullPath) {
      contentKey = `file:${fullPath.toLowerCase()}`;
    } else {
      const idPart = rec.id != null && String(rec.id).trim() ? String(rec.id).trim() : String(idx);
      const baseKey = `record:${recordDate || "unknown"}:${idPart}`;
      contentKey = buckets.has(baseKey) ? `${baseKey}:${idx}` : baseKey;
    }

    let bucket = buckets.get(contentKey);
    if (!bucket) {
      bucket = {
        contentKey,
        displayTitle: "",
        displayTitleDate: "",
        file: fullPath || String(rec.selectedFile || "").trim(),
        fileDate: recordDate,
        firstPublishDate: "",
        targets: [],
      };
      buckets.set(contentKey, bucket);
    }

    if (fullPath && recordDate && (!bucket.fileDate || recordDate < bucket.fileDate)) {
      bucket.file = fullPath;
      bucket.fileDate = recordDate;
    }
    if (recordDate && (!bucket.firstPublishDate || recordDate < bucket.firstPublishDate)) {
      bucket.firstPublishDate = recordDate;
    }
    if (title && (!bucket.displayTitle || (recordDate && (!bucket.displayTitleDate || recordDate < bucket.displayTitleDate)))) {
      bucket.displayTitle = title;
      bucket.displayTitleDate = recordDate;
    }

    bucket.targets.push({
      contentKey,
      group,
      platform,
      recordDate,
      status,
      videoLink: validLink ? rawVideoLink : "",
      matchTitles: collectMatchTitles(matchRaw),
    });
  }

  return [...buckets.values()]
    .map((b) => ({
      contentKey: b.contentKey,
      displayTitle: b.displayTitle || (b.file ? b.file.split("/").pop() : "") || "(无标题)",
      file: b.file,
      firstPublishDate: b.firstPublishDate,
      targets: b.targets,
    }))
    .sort((a, b) => {
      if (a.firstPublishDate !== b.firstPublishDate) {
        if (!a.firstPublishDate) return 1;
        if (!b.firstPublishDate) return -1;
        return a.firstPublishDate < b.firstPublishDate ? -1 : 1;
      }
      return a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0;
    });
}

/**
 * 在同 group + platform 内关联作品与 target，返回 Map<`group|platform|workId`, { contentKey, matchedBy }>。
 * ① 有效直链 1:1 唯一匹配（多对一/一对多全部留空且禁止标题兜底）；
 * ② 标题命中且同 group+platform 内唯一 work、唯一未被①占用的 target，且 target 无冲突直链。
 */
function linkWorks({ contents, accounts } = {}) {
  const result = new Map();
  if (!Array.isArray(accounts)) return result;

  const targetsByGp = new Map();
  let targetSeq = 0;
  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c) || !c.contentKey) continue;
    const contentKey = String(c.contentKey);
    for (const t of Array.isArray(c.targets) ? c.targets : []) {
      if (!isPlainObject(t)) continue;
      const gpKey = `${t.group == null ? "" : String(t.group).trim()}|${t.platform == null ? "" : String(t.platform).trim()}`;
      pushToMap(targetsByGp, gpKey, {
        idx: targetSeq++,
        contentKey,
        normUrl: normalizeDirectUrl(t.videoLink),
        matchTitles: collectMatchTitles(Array.isArray(t.matchTitles) ? t.matchTitles : [t.title]),
      });
    }
  }

  const worksByGp = new Map();
  let workSeq = 0;
  for (const acc of accounts) {
    if (!isPlainObject(acc)) continue;
    const rawGroup = acc.group == null ? "" : String(acc.group);
    const rawPlatform = acc.platform == null ? "" : String(acc.platform);
    const gpKey = `${rawGroup.trim()}|${rawPlatform.trim()}`;
    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const workKey = makeWorkKey(rawGroup, rawPlatform, String(w.workId));
      if (result.has(workKey)) continue;
      result.set(workKey, { contentKey: null, matchedBy: null });
      pushToMap(worksByGp, gpKey, {
        idx: workSeq++,
        workKey,
        normTitle: normalizeTitle(w.title),
        normUrl: normalizeDirectUrl(w.url),
      });
    }
  }

  for (const [gpKey, gpWorks] of worksByGp.entries()) {
    const gpTargets = targetsByGp.get(gpKey);
    if (!gpTargets || !gpTargets.length) continue;

    const matchedWorks = new Set();
    const occupiedTargets = new Set();
    const blockedWorks = new Set();
    const blockedTargets = new Set();

    // ① 有效直链严格 1:1 匹配
    const targetsByUrl = new Map();
    const worksByUrl = new Map();
    for (const t of gpTargets) if (t.normUrl) pushToMap(targetsByUrl, t.normUrl, t);
    for (const w of gpWorks) if (w.normUrl) pushToMap(worksByUrl, w.normUrl, w);

    for (const [url, urlWorks] of worksByUrl.entries()) {
      const urlTargets = targetsByUrl.get(url);
      if (!urlTargets) continue;
      if (urlWorks.length === 1 && urlTargets.length === 1) {
        matchedWorks.add(urlWorks[0].idx);
        occupiedTargets.add(urlTargets[0].idx);
        result.set(urlWorks[0].workKey, { contentKey: urlTargets[0].contentKey, matchedBy: "link" });
      } else {
        for (const w of urlWorks) blockedWorks.add(w.idx);
        for (const t of urlTargets) blockedTargets.add(t.idx);
      }
    }

    // ② 同 group+platform 唯一标题匹配
    const worksByTitle = new Map();
    const freeTargetsByTitle = new Map();
    for (const w of gpWorks) if (w.normTitle) pushToMap(worksByTitle, w.normTitle, w);
    for (const t of gpTargets) {
      if (occupiedTargets.has(t.idx)) continue;
      for (const mt of t.matchTitles) pushToMap(freeTargetsByTitle, mt, t);
    }

    const candidatesByTarget = new Map();
    for (const w of gpWorks) {
      if (matchedWorks.has(w.idx) || blockedWorks.has(w.idx) || !w.normTitle) continue;
      if (worksByTitle.get(w.normTitle).length !== 1) continue;
      const titleTargets = freeTargetsByTitle.get(w.normTitle);
      if (!titleTargets || titleTargets.length !== 1) continue;
      const t = titleTargets[0];
      if (blockedTargets.has(t.idx) || (t.normUrl && t.normUrl !== w.normUrl)) continue;
      pushToMap(candidatesByTarget, t.idx, { work: w, target: t });
    }

    for (const pairs of candidatesByTarget.values()) {
      if (pairs.length === 1) {
        result.set(pairs[0].work.workKey, { contentKey: pairs[0].target.contentKey, matchedBy: "title" });
      }
    }
  }

  return result;
}

function mergeMetricValue(prev, next) {
  if (prev == null) return next == null ? null : next;
  if (next == null) return prev;
  const total = prev + next;
  return total === 0 ? 0 : total;
}

/** 仅从 worksDaily 中取 ≤ cutoffDate 的最近有效快照，不回退 works.json */
function resolveWorkMetricsAsOf(workId, accWorksDaily, cutoffDate) {
  if (!isPlainObject(accWorksDaily) || !hasOwn(accWorksDaily, workId)) return null;
  const dateMap = accWorksDaily[workId];
  if (!isPlainObject(dateMap)) return null;

  let bestDate = "";
  let bestSnap = null;
  for (const [d, snap] of Object.entries(dateMap)) {
    if (!isPlainObject(snap) || !isValidDateStr(d)) continue;
    if (cutoffDate && d > cutoffDate) continue;
    if (!bestDate || d > bestDate) {
      bestDate = d;
      bestSnap = snap;
    }
  }
  if (!bestSnap) return null;

  const metrics = {};
  for (const k of WORK_STAT_KEYS) {
    metrics[k] = hasOwn(bestSnap, k) ? normalizeMetric(bestSnap[k]) : null;
  }
  return metrics;
}

function addWorkToBucket(bucket, platform, group, workId, rawUrl, metrics) {
  const workUrl = rawUrl ? String(rawUrl).trim() : "";
  const pgKey = `${platform}|${group}`;
  if (platform) bucket.platforms.add(platform);

  if (!hasOwn(bucket.perPlatform, pgKey)) {
    bucket.perPlatform[pgKey] = {
      ...metrics,
      urls: workUrl ? [workUrl] : [],
      workIds: [workId],
    };
  } else {
    const cell = bucket.perPlatform[pgKey];
    for (const k of WORK_STAT_KEYS) cell[k] = mergeMetricValue(cell[k], metrics[k]);
    if (workUrl && !cell.urls.includes(workUrl)) cell.urls.push(workUrl);
    cell.workIds.push(workId);
  }
}

/**
 * 构建跨平台内容级汇总行（截至 date，默认最新快照日）。
 * - link：Map<`group|platform|workId`, { contentKey, matchedBy }>（可省）
 * - worksDaily：`{ "group|platform": readWorksDaily(group, platform) }`
 */
function buildContentSummaryRows({ contents, accounts, link, worksDaily, date } = {}) {
  const cutoffDate = typeof date === "string" && date.trim() ? date.trim() : "";
  if (cutoffDate && !isValidDateStr(cutoffDate)) return [];

  const accountList = Array.isArray(accounts) ? accounts : [];
  const resolvedLink = link instanceof Map ? link : linkWorks({ contents, accounts: accountList });
  const dailyByGp = isPlainObject(worksDaily) ? worksDaily : null;

  const contentByKey = new Map();
  const buckets = new Map();
  const makeBucket = (contentKey, title, file, recordFirstDate, minWorkPublishMs, isUnlinked) => ({
    contentKey,
    title: title || "(无标题)",
    file: file || "",
    recordFirstDate: recordFirstDate || "",
    minWorkPublishMs,
    isUnlinked,
    platforms: new Set(),
    perPlatform: {},
  });

  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c) || !c.contentKey) continue;
    const contentKey = String(c.contentKey);
    const rawDate = typeof c.firstPublishDate === "string" ? c.firstPublishDate.trim() : "";
    const recordDate = isValidDateStr(rawDate) ? rawDate : "";
    contentByKey.set(contentKey, { c, recordDate });
    if (cutoffDate && recordDate && recordDate > cutoffDate) continue;
    const bucketId = `linked:${contentKey}`;
    if (!buckets.has(bucketId)) {
      buckets.set(bucketId, makeBucket(contentKey, c.displayTitle, c.file, recordDate, null, false));
    }
  }

  const seenWorkKeys = new Set();
  for (const acc of accountList) {
    if (!isPlainObject(acc)) continue;
    const group = acc.group == null ? "" : String(acc.group);
    const platform = acc.platform == null ? "" : String(acc.platform);
    const gpKey = `${group}|${platform}`;
    const accWorksDaily = dailyByGp && hasOwn(dailyByGp, gpKey) ? dailyByGp[gpKey] : null;

    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w) || w.workId == null || w.workId === "") continue;
      const workId = String(w.workId);
      const workKey = makeWorkKey(group, platform, workId);
      if (seenWorkKeys.has(workKey)) continue;
      seenWorkKeys.add(workKey);

      const linkEntry = resolvedLink.get(workKey);
      const linkedKey = linkEntry && linkEntry.contentKey ? String(linkEntry.contentKey) : null;
      const pubMs = parseValidTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
      const metrics = resolveWorkMetricsAsOf(workId, accWorksDaily, cutoffDate);

      if (linkedKey) {
        const bucketId = `linked:${linkedKey}`;
        let bucket = buckets.get(bucketId);
        if (!bucket) {
          if (!metrics) continue;
          const meta = contentByKey.get(linkedKey);
          bucket = meta
            ? makeBucket(linkedKey, meta.c.displayTitle, meta.c.file, meta.recordDate, null, false)
            : makeBucket(linkedKey, w.title ? String(w.title) : "", "", "", null, false);
          buckets.set(bucketId, bucket);
        }
        if (pubMs !== null && (!cutoffDate || pubDate <= cutoffDate)) {
          if (bucket.minWorkPublishMs === null || pubMs < bucket.minWorkPublishMs) {
            bucket.minWorkPublishMs = pubMs;
          }
        }
        if (metrics) addWorkToBucket(bucket, platform, group, workId, w.url, metrics);
      } else if (metrics) {
        const bucket = makeBucket(
          `unlinked:${platform}:${workId}`,
          w.title ? String(w.title) : "",
          "",
          "",
          pubMs,
          true
        );
        addWorkToBucket(bucket, platform, group, workId, w.url, metrics);
        buckets.set(`unlinked:${group}|${platform}|${workId}`, bucket);
      }
    }
  }

  const rows = [];
  for (const b of buckets.values()) {
    const hasWorkPub = b.minWorkPublishMs !== null;
    const row = {
      contentKey: b.contentKey,
      title: b.title,
      file: b.file,
      firstPublishDate: hasWorkPub ? toUtc8DateStr(b.minWorkPublishMs) : b.recordFirstDate,
      firstPublishDateSource: hasWorkPub || b.isUnlinked ? "work" : "record",
      platformCount: b.platforms.size,
    };
    const cells = Object.values(b.perPlatform);
    for (const k of WORK_STAT_KEYS) {
      let total = null;
      for (const cell of cells) total = mergeMetricValue(total, cell[k]);
      row[STAT_TO_TOTAL_KEY[k]] = total;
    }
    row.perPlatform = b.perPlatform;
    rows.push(row);
  }

  return rows.sort((a, b) => {
    if (a.firstPublishDate !== b.firstPublishDate) {
      if (!a.firstPublishDate) return 1;
      if (!b.firstPublishDate) return -1;
      return a.firstPublishDate > b.firstPublishDate ? -1 : 1;
    }
    if (a.totalPlay !== b.totalPlay) {
      if (a.totalPlay === null) return 1;
      if (b.totalPlay === null) return -1;
      return b.totalPlay - a.totalPlay;
    }
    return a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0;
  });
}

module.exports = {
  normalizeTitle,
  normalizeUrl,
  isManagementUrl,
  makeWorkKey,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
};
