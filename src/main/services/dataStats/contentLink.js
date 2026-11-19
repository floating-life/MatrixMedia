"use strict";

/**
 * 跨平台作品关联与内容级汇总行构建（纯函数模块，不依赖 electron / fs）。
 *
 * 原则：误关联比漏关联更糟；证据不足一律留空（未关联作品单独成行）。
 *
 * 已知限制：同一分组同一平台挂多个账号时，统计存储（userData/data-stats/<分组>/<平台>/）
 * 本身按「分组/平台」合并（上游结构），跨平台关联也只能到这一粒度。
 */

const crypto = require("crypto");
const { WORK_STAT_KEYS, DELETED_WORK_TITLE, normalizeMetric } = require("./statsTable");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const ZERO_WIDTH_RE = /[\u200B-\u200F\u2060\uFEFF\u00AD]/g;
const FULLWIDTH_ASCII_RE = /[\uFF01-\uFF5E]/g;
const TRACKING_PARAM_RE =
  /^(?:utm_|share_|spm(?:$|_)|from$|modefrom$|vd_source$|fbclid$|gclid$|xsec_token$|xsec_source$)/i;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
const UTC8_MS = 8 * 3600e3;

// 模糊匹配阈值常量（模块导出便于后续调优）
const FUZZY_SIM_THRESHOLD = 0.6;
const FUZZY_MISSING_TIME_PENALTY = 0.1;
const FUZZY_MARGIN_MIN = 0.1;
const FUZZY_MAX_DAY_DIFF = 2; // 按 UTC+8 日历日相差 ≤2 天
const FUZZY_SUBSTRING_MIN_LEN = 6;
const FUZZY_SUBSTRING_SCORE = 0.95;
const FUZZY_MIN_CORE_LEN = 4;
const FUZZY_EPS = 1e-9;
const FUZZY_PLACEHOLDER_TITLES = Object.freeze([
  "(无标题)",
  "无标题",
  "暂无标题",
  "未命名",
  "默认标题",
  DELETED_WORK_TITLE,
  "untitled",
  "none",
  "null",
  "undefined",
  "n/a",
]);
const FUZZY_THRESHOLDS = Object.freeze({
  simThreshold: FUZZY_SIM_THRESHOLD,
  missingTimePenalty: FUZZY_MISSING_TIME_PENALTY,
  marginMin: FUZZY_MARGIN_MIN,
  maxDayDiff: FUZZY_MAX_DAY_DIFF,
  substringMinLen: FUZZY_SUBSTRING_MIN_LEN,
  substringScore: FUZZY_SUBSTRING_SCORE,
  minCoreLen: FUZZY_MIN_CORE_LEN,
});

const KEYCAP_EMOJI_RE = /[#*0-9]\uFE0F?\u20E3/g;
// 话题外词内 # 保护（如 C#、F#、J#、Q#，以及后接空白/标点/音调词的乐理音名 D#、G#、A# 等）；
// 扫描时按「完整 #…[话题]# → 通用 #…# 闭合边界 → 单 #… → 话题外词内 #」顺序处理：
// 1. #…[话题]# 内部允许词内 C#/F# 等，防止 #学C#入门[话题]# 被 C# 提前截断并吞掉后续集数
// 2. 通用 #…# 闭合边界优先于词内 #，防止 #C#第1集 的结束符被词内规则抢占
// 3. 话题外保护 C#/F# 等词内 #
const WORD_INTERNAL_HASH_STICKY_RE =
  /(?:([CcFfJjQq])#(?!\[话题\]#)|([A-Ga-g])#(?=$|[\s.,!?;:)\]}\-/]|大调|小调|和弦|调|音|major|minor|m(?![A-Za-z])))/y;
const HASH_PLACEHOLDER = "\u0000";
const XHS_TOPIC_BODY_SOURCE =
  "(?:[^\\s#]|(?<![A-Za-z0-9])(?:[CcFfJjQq]#|[A-Ga-g]#(?=[.,!?;:)\\]}\\-/]|\\[话题\\]#|大调|小调|和弦|调|音|major|minor|m(?![A-Za-z]))))+";
const XHS_TOPIC_TAIL_RE = new RegExp(
  `(?:^|\\s)#(?:(?:${XHS_TOPIC_BODY_SOURCE}|[^\\s#]+#[^\\s#]*)\\[话题\\]#|[^\\s#]+)$`
);
const XHS_TOPIC_STICKY_RE = new RegExp(`#${XHS_TOPIC_BODY_SOURCE}\\[话题\\]#`, "y");
// 兜底：若 #…[话题]# 内部仅含 1 个非词内 #（如 #2025#年度计划[话题]#），避免提前按 #2025# 闭合后残留孤立 [话题]# 吞掉后续集数；
// 仍不会跨过 #美食#中间正文#摄影[话题]#（含 2 个非词内 #）吞掉中间正文
const XHS_TOPIC_ONE_HASH_STICKY_RE = /#[^\s#]+#[^\s#]*\[话题\]#/y;
const WRAPPED_TOPIC_STICKY_RE = /#[^\s#]+#/y;
const SINGLE_TOPIC_STICKY_RE = /#[^\s#]+/y;
const ASCII_ALNUM_RE = /[A-Za-z0-9]/;
const EXT_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/gu;
const NON_LETTER_NUM_OR_PH_RE = /[^\p{L}\p{N}\u0000]/gu;
const UNSTABLE_RECORD_KEY_RE = /^record:(?:.*:)?pos:\d+$/;
const DAY_BUCKET_INDEX_THRESHOLD = 32;

const ZH_DIGIT_MAP = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const ROMAN_NUM_MAP = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};
// 记录 linkWorks 返回 Map 的输入身份指纹，供 buildContentSummaryRows 同数据集同 cutoff 零重算复用
const LINK_RESULT_META = new WeakMap();

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
/** 安全读取文本字段：仅接受 string 或有限 number，对象/数组/null 等视为空串，绝不调用 toString */
function toSafeString(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}
const toSafeTrimmed = (v) => toSafeString(v).trim();
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

/** 标题归一化（仅用于匹配）：去零宽字符、全角/中文标点归一、空白归一、去末尾独立话题标签 */
function normalizeTitle(s) {
  let out = toSafeString(s)
    .replace(ZERO_WIDTH_RE, "")
    .replace(FULLWIDTH_ASCII_RE, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(CJK_PUNCT_RE, (ch) => CJK_PUNCT_MAP[ch] || ch)
    .replace(/\s+/g, " ")
    .trim();
  while (out) {
    // 仅剥离尾部、且 # 前为字符串开头或空白的话题标签（保留 C#入门 等词内 #）；
    // 结尾 # 只在小红书 `#xx[话题]#` 格式下允许（含内部 C#/F#），避免把 `#2025#` 这类编号剥掉
    const next = out.replace(XHS_TOPIC_TAIL_RE, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

/** 「获取状态」用的精确标题键：仅去零宽字符与首尾空白（与原入口一致，不剥话题/标点） */
function normalizeStatusTitle(s) {
  return toSafeString(s).replace(ZERO_WIDTH_RE, "").trim();
}

/**
 * 单遍从左到右剥离话题并保护话题外词内 #：
 * - 遇到 # 时优先按完整闭合话题（#xx[话题]#、#xx#）边界剥离，确保 #C# 的结束符不被词内 C# 抢占；
 *   其次剥离单 #xx（遇到空白或下一个 # 截止，不吞后续正文）
 * - 仅对话题外、且前一个字符非 ASCII 字母数字的 C#/F#/J#/Q#/乐理音名 D# 等保护为占位符
 */
function stripTopicsAndProtectHash(s) {
  const normalized = normalizeTitle(s);
  if (!normalized) return "";
  const text = normalized.replace(/\u0000/g, "").replace(KEYCAP_EMOJI_RE, "");
  let out = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (ch === "#") {
      XHS_TOPIC_STICKY_RE.lastIndex = i;
      let m = XHS_TOPIC_STICKY_RE.exec(text);
      if (!m) {
        XHS_TOPIC_ONE_HASH_STICKY_RE.lastIndex = i;
        m = XHS_TOPIC_ONE_HASH_STICKY_RE.exec(text);
      }
      if (m) {
        out += " ";
        i += m[0].length;
        continue;
      }
      WRAPPED_TOPIC_STICKY_RE.lastIndex = i;
      m = WRAPPED_TOPIC_STICKY_RE.exec(text);
      if (m) {
        out += " ";
        i += m[0].length;
        continue;
      }
      SINGLE_TOPIC_STICKY_RE.lastIndex = i;
      m = SINGLE_TOPIC_STICKY_RE.exec(text);
      if (m) {
        out += " ";
        i += m[0].length;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (i + 1 < len && text[i + 1] === "#") {
      if (i === 0 || !ASCII_ALNUM_RE.test(text[i - 1])) {
        WORD_INTERNAL_HASH_STICKY_RE.lastIndex = i;
        const m = WORD_INTERNAL_HASH_STICKY_RE.exec(text);
        if (m) {
          out += `${m[1] || m[2]}${HASH_PLACEHOLDER}`;
          i += 2;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 模糊匹配用话题剥离（保留括号、标点与空白，供集数解析与核心标题提取共用）：
 * 1. 先按闭合话题边界（#xx[话题]#、#xx#）剥离，再剥单 #xx
 * 2. 对话题外文本保护并还原 C#/F# 等词内 #
 */
function stripTopicsForFuzzy(s) {
  const stripped = stripTopicsAndProtectHash(s);
  if (!stripped) return "";
  return stripped.replace(/\u0000/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * 提取模糊匹配核心标题：
 * normalizeTitle 后先按闭合话题边界剥离、再剥单 #xx，同时对话题外文本保留 C#/F# 等词内 #，
 * 再去 emoji、标点与空白，并转小写。
 */
function extractCoreTitle(s) {
  const stripped = stripTopicsAndProtectHash(s);
  if (!stripped) return "";
  return stripped
    .replace(EXT_PICTOGRAPHIC_RE, "")
    .replace(NON_LETTER_NUM_OR_PH_RE, "")
    .replace(/\u0000/g, "#")
    .toLowerCase();
}

const FUZZY_PLACEHOLDER_CORE_SET = new Set(
  FUZZY_PLACEHOLDER_TITLES.map((t) => extractCoreTitle(t)).filter(Boolean)
);

/** 判断标题是否属于占位/无效标题（空、纯符号、(无标题)、core 长度 < FUZZY_MIN_CORE_LEN 等） */
function isPlaceholderTitle(rawTitle) {
  const trimmed = toSafeTrimmed(rawTitle);
  if (!trimmed) return true;
  const core = extractCoreTitle(trimmed);
  if (!core) return true;
  if (FUZZY_PLACEHOLDER_CORE_SET.has(core)) return true;
  return Array.from(core).length < FUZZY_MIN_CORE_LEN;
}

function parseZhOrArabicInt(raw) {
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  const lower = raw.toLowerCase();
  if (hasOwn(ROMAN_NUM_MAP, lower)) return ROMAN_NUM_MAP[lower];
  let total = 0;
  let cur = 0;
  let hasValid = false;
  for (const ch of raw) {
    if (hasOwn(ZH_DIGIT_MAP, ch)) {
      cur = ZH_DIGIT_MAP[ch];
      hasValid = true;
    } else if (ch === "十") {
      total += (cur === 0 ? 1 : cur) * 10;
      cur = 0;
      hasValid = true;
    } else if (ch === "百") {
      total += (cur === 0 ? 1 : cur) * 100;
      cur = 0;
      hasValid = true;
    } else {
      return null;
    }
  }
  total += cur;
  return hasValid && total > 0 ? total : null;
}

const SEASON_ZH_RE = /第\s*(\d+|[一二两三四五六七八九十百零〇]+)\s*季/g;
const SEASON_EN_RE = /(?<![A-Za-z0-9])season\s*[.#:\-_]?\s*0*(\d{1,3})(?![A-Za-z0-9])/gi;
const SEASON_EP_SE_RE = /(?<![A-Za-z0-9])s0*(\d{1,2})\s*e0*(\d{1,3})(?![A-Za-z0-9])/gi;
const EP_ZH_RE = /第\s*(\d+|[一二两三四五六七八九十百零〇]+)\s*(?:集|期|话|课|部|讲|节|章|回|弹|篇|辑)/g;
const EP_EN_RE = /(?<![A-Za-z0-9])(?:ep(?:isode)?|part|pt|vol\.?|no\.?)\s*[.#:\-_]?\s*0*(\d{1,4})(?![A-Za-z0-9])/gi;
const EP_PART_ROMAN_RE = /(?<![A-Za-z0-9])part\s+(i|ii|iii|iv|v|vi|vii|viii|ix|x)(?![A-Za-z0-9])/gi;
const EP_P_RE = /(?<![A-Za-z0-9])p0*(\d{1,3})(?![A-Za-z0-9])/gi;
const EP_BRACKET_RE = /[(\[]\s*(\d{1,3}|[一二两三四五六七八九十]+)\s*[)\]]/g;
const SECTION_BRACKET_RE = /[(\[]\s*(上|中|下)\s*(?:集|篇|部|卷|期|半场|半部)?\s*[)\]]/g;
const SECTION_UNIT_RE = /(上|中|下)(?:集|篇|部|卷|半场|半部)/g;
const SECTION_TAIL_RE = /(?:[\s\-_|·:/])(上|中|下)(?=$|[\s\-_|·:/)])/g;

function collectSeriesSets(rawTitle, seasons, episodes, sections) {
  const clean = stripTopicsForFuzzy(rawTitle);
  if (!clean) return;
  let m;

  SEASON_ZH_RE.lastIndex = 0;
  while ((m = SEASON_ZH_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) seasons.add(n);
  }
  SEASON_EN_RE.lastIndex = 0;
  while ((m = SEASON_EN_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) seasons.add(n);
  }
  SEASON_EP_SE_RE.lastIndex = 0;
  while ((m = SEASON_EP_SE_RE.exec(clean)) !== null) {
    const s = parseZhOrArabicInt(m[1]);
    const e = parseZhOrArabicInt(m[2]);
    if (s !== null) seasons.add(s);
    if (e !== null) episodes.add(e);
  }
  EP_ZH_RE.lastIndex = 0;
  while ((m = EP_ZH_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) episodes.add(n);
  }
  EP_EN_RE.lastIndex = 0;
  while ((m = EP_EN_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) episodes.add(n);
  }
  EP_PART_ROMAN_RE.lastIndex = 0;
  while ((m = EP_PART_ROMAN_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) episodes.add(n);
  }
  EP_P_RE.lastIndex = 0;
  while ((m = EP_P_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null) episodes.add(n);
  }
  EP_BRACKET_RE.lastIndex = 0;
  while ((m = EP_BRACKET_RE.exec(clean)) !== null) {
    const n = parseZhOrArabicInt(m[1]);
    if (n !== null && n <= 999) episodes.add(n);
  }
  SECTION_BRACKET_RE.lastIndex = 0;
  while ((m = SECTION_BRACKET_RE.exec(clean)) !== null) {
    sections.add(m[1]);
  }
  SECTION_UNIT_RE.lastIndex = 0;
  while ((m = SECTION_UNIT_RE.exec(clean)) !== null) {
    sections.add(m[1]);
  }
  SECTION_TAIL_RE.lastIndex = 0;
  while ((m = SECTION_TAIL_RE.exec(clean)) !== null) {
    sections.add(m[1]);
  }
}

function formatSeriesSets(seasons, episodes, sections) {
  if (seasons.size === 0 && episodes.size === 0 && sections.size === 0) {
    return null;
  }
  const sortNums = (set) => [...set].sort((a, b) => a - b).join(",");
  const sectionOrder = { 上: 1, 中: 2, 下: 3 };
  const sectionKey = [...sections]
    .sort((a, b) => (sectionOrder[a] || 9) - (sectionOrder[b] || 9))
    .join(",");
  return {
    seasonKey: sortNums(seasons),
    episodeKey: sortNums(episodes),
    sectionKey,
  };
}

/**
 * 提取标题中的系列序号标记（季/集期话课部/EP/Part/(N)/上中下）。
 * 无法提取返回 null；否则返回规范化字符串签名 `{ seasonKey, episodeKey, sectionKey }`。
 */
function extractSeriesMarkers(rawTitle) {
  const seasons = new Set();
  const episodes = new Set();
  const sections = new Set();
  collectSeriesSets(rawTitle, seasons, episodes, sections);
  return formatSeriesSets(seasons, episodes, sections);
}

/**
 * 汇总多条标题别名（如主标题+短标题等）中全部明确系列序号标记，
 * 供目标侧与作品侧在打分前统一拒绝集数冲突（防止无集数短标题绕过主标题集数冲突检查）。
 */
function extractSeriesMarkersFromTitles(titles) {
  const seasons = new Set();
  const episodes = new Set();
  const sections = new Set();
  const list = Array.isArray(titles) ? titles : [titles];
  for (const t of list) {
    if (t == null || t === "") continue;
    collectSeriesSets(t, seasons, episodes, sections);
  }
  return formatSeriesSets(seasons, episodes, sections);
}

function hasConflictingSeries(sa, sb) {
  if (!sa || !sb) return false;
  if (sa.seasonKey && sb.seasonKey && sa.seasonKey !== sb.seasonKey) return true;
  if (sa.episodeKey && sb.episodeKey && sa.episodeKey !== sb.episodeKey) return true;
  if (sa.sectionKey && sb.sectionKey && sa.sectionKey !== sb.sectionKey) return true;
  return false;
}

const EMPTY_INT32 = new Int32Array(0);
const EMPTY_FLOAT64 = new Float64Array(0);

function prepareCore(rawTitle) {
  const core = extractCoreTitle(rawTitle);
  if (!core || FUZZY_PLACEHOLDER_CORE_SET.has(core)) {
    return {
      core: "",
      len: 0,
      eligible: false,
      series: null,
      bigrams: EMPTY_FLOAT64,
      uniqueBigrams: EMPTY_FLOAT64,
      uniqueCounts: EMPTY_INT32,
    };
  }
  const chars = Array.from(core);
  const len = chars.length;
  if (len < FUZZY_MIN_CORE_LEN) {
    return {
      core,
      len,
      eligible: false,
      series: null,
      bigrams: EMPTY_FLOAT64,
      uniqueBigrams: EMPTY_FLOAT64,
      uniqueCounts: EMPTY_INT32,
    };
  }
  const bgLen = len - 1;
  // cp1 * 0x110000 + cp2 最大约 1.24e12（41 bit），用 Float64Array 保留 53 bit 完整整数精度，避免 Int32 截断碰撞
  const bigrams = new Float64Array(bgLen);
  for (let i = 0; i < bgLen; i++) {
    bigrams[i] = chars[i].codePointAt(0) * 0x110000 + chars[i + 1].codePointAt(0);
  }
  bigrams.sort();

  let uniqueCount = 0;
  for (let i = 0; i < bgLen; i++) {
    if (i === 0 || bigrams[i] !== bigrams[i - 1]) uniqueCount++;
  }
  const uniqueBigrams = new Float64Array(uniqueCount);
  const uniqueCounts = new Int32Array(uniqueCount);
  let uIdx = -1;
  for (let i = 0; i < bgLen; i++) {
    if (i === 0 || bigrams[i] !== bigrams[i - 1]) {
      uIdx++;
      uniqueBigrams[uIdx] = bigrams[i];
      uniqueCounts[uIdx] = 1;
    } else {
      uniqueCounts[uIdx]++;
    }
  }
  return {
    core,
    len,
    eligible: true,
    series: extractSeriesMarkers(rawTitle),
    bigrams,
    uniqueBigrams,
    uniqueCounts,
  };
}

function countSortedOverlap(a, b) {
  let i = 0;
  let j = 0;
  let overlap = 0;
  const al = a.length;
  const bl = b.length;
  while (i < al && j < bl) {
    const va = a[i];
    const vb = b[j];
    if (va === vb) {
      overlap++;
      i++;
      j++;
    } else if (va < vb) {
      i++;
    } else {
      j++;
    }
  }
  return overlap;
}

function computeSimilarityFromOverlap(pa, pb, overlap) {
  if (overlap <= 0) return 0;
  if (hasConflictingSeries(pa.series, pb.series)) return 0;
  if (pa.len === pb.len && overlap === pa.bigrams.length && pa.core === pb.core) return 1;
  const shorter = pa.len <= pb.len ? pa : pb;
  const longer = pa.len <= pb.len ? pb : pa;
  // 若 shorter 是 longer 的子串，其全部二元组必然被 longer 覆盖（overlap === shorter.bigrams.length）
  if (
    shorter.len >= FUZZY_SUBSTRING_MIN_LEN &&
    overlap === shorter.bigrams.length &&
    longer.core.includes(shorter.core)
  ) {
    return FUZZY_SUBSTRING_SCORE;
  }
  return (2 * overlap) / (pa.bigrams.length + pb.bigrams.length);
}

function computePreparedSimilarity(pa, pb) {
  if (!pa || !pb || !pa.eligible || !pb.eligible) return 0;
  if (hasConflictingSeries(pa.series, pb.series)) return 0;
  if (pa.core === pb.core) return 1;
  const overlap = countSortedOverlap(pa.bigrams, pb.bigrams);
  return computeSimilarityFromOverlap(pa, pb, overlap);
}

/** 计算两个标题的模糊相似度 ∈ [0, 1]（占位/短标题及不同系列集数直接返回 0） */
function computeTitleSimilarity(titleA, titleB) {
  return computePreparedSimilarity(prepareCore(titleA), prepareCore(titleB));
}

function roundScore(sim) {
  return Math.round((sim + Number.EPSILON) * 100) / 100;
}

function dateStrToDayNum(dateStr) {
  if (!isValidDateStr(dateStr)) return null;
  return Math.floor(Date.parse(`${dateStr}T00:00:00Z`) / DAY_MS);
}

/** 模糊匹配时间窗判定：按 UTC+8 日历日相差 ≤ FUZZY_MAX_DAY_DIFF（2 天），缺时间门槛 +0.1 */
function checkFuzzyTimeWindow(dayA, dayB) {
  if (dayA !== null && dayB !== null) {
    if (Math.abs(dayA - dayB) > FUZZY_MAX_DAY_DIFF) {
      return { eligible: false, threshold: Infinity };
    }
    return { eligible: true, threshold: FUZZY_SIM_THRESHOLD };
  }
  return {
    eligible: true,
    threshold: FUZZY_SIM_THRESHOLD + FUZZY_MISSING_TIME_PENALTY,
  };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isValidManualContentKey(key) {
  return typeof key === "string" && key.startsWith("manual:") && key.length > "manual:".length;
}

function isValidAutoContentKey(key) {
  return typeof key === "string" && key.startsWith("auto:") && key.length > "auto:".length;
}

function isValidSyntheticContentKey(key) {
  return isValidManualContentKey(key) || isValidAutoContentKey(key);
}

function isUnstableRecordKey(key) {
  return typeof key === "string" && UNSTABLE_RECORD_KEY_RE.test(key);
}

/** 作品身份键：`platform|workId`（不含 group，同一账号挂多分组共享同一作品身份） */
function makeWorkIdentityKey(platform, workId) {
  return `${toSafeString(platform)}|${toSafeString(workId)}`;
}

/** 校验合法的作品身份键 `platform|workId`（恰含一个 `|` 且两端均非空） */
function isValidWorkIdentityKey(key) {
  if (typeof key !== "string" || !key) return false;
  const sep = key.indexOf("|");
  if (sep <= 0 || sep >= key.length - 1) return false;
  return key.indexOf("|", sep + 1) === -1;
}

/**
 * 基于簇内排序后的成员身份（platform|workId，不含 group）计算确定性 auto:<hash>。
 * 同一组作品在多个分组重复出现时生成同一键，避免跨组去重判冲突。
 */
function computeAutoClusterKey(sortedMemberKeys) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedMemberKeys))
    .digest("hex")
    .slice(0, 16);
  return `auto:${hash}`;
}

/**
 * 清洗手工矫正配置，兼容传入 `{ version, updatedAt, contents?, excludedAuto?, overrides }` 或直接传入 overrides 字典。
 * overrides 键为作品身份 `platform|workId`；
 * 返回 `{ overrides: Map<pwKey, entry>, contents: Map<contentKey, { title, createdAt }>, excludedAuto: Set<pwKey> }`。
 */
function normalizeOverridesDoc(raw) {
  const overrides = new Map();
  const contents = new Map();
  const excludedAuto = new Set();
  if (!isPlainObject(raw)) return { overrides, contents, excludedAuto };
  const isDoc =
    hasOwn(raw, "overrides") && isPlainObject(raw.overrides) && typeof raw.action !== "string";
  const source = isDoc ? raw.overrides : raw;
  for (const pwKey of Object.keys(source)) {
    if (!isValidWorkIdentityKey(pwKey)) continue;
    const desc = Object.getOwnPropertyDescriptor(source, pwKey);
    const entry = desc ? desc.value : null;
    if (!isPlainObject(entry)) continue;
    const action = typeof entry.action === "string" ? entry.action.trim() : "";
    if (action === "detach") {
      overrides.set(pwKey, { action: "detach" });
      excludedAuto.add(pwKey);
    } else if (action === "assign") {
      const contentKey = typeof entry.contentKey === "string" ? entry.contentKey.trim() : "";
      if (contentKey && !contentKey.startsWith("unlinked:")) {
        overrides.set(pwKey, { action: "assign", contentKey });
        if (entry.excludeAuto === true) {
          excludedAuto.add(pwKey);
        }
      }
    }
  }
  if (isDoc && hasOwn(raw, "excludedAuto") && isPlainObject(raw.excludedAuto)) {
    for (const pwKey of Object.keys(raw.excludedAuto)) {
      if (!isValidWorkIdentityKey(pwKey)) continue;
      const desc = Object.getOwnPropertyDescriptor(raw.excludedAuto, pwKey);
      if (desc && desc.value === true) {
        excludedAuto.add(pwKey);
      }
    }
  }
  if (isDoc && hasOwn(raw, "contents") && isPlainObject(raw.contents)) {
    for (const ck of Object.keys(raw.contents)) {
      if (!isValidSyntheticContentKey(ck)) continue;
      const desc = Object.getOwnPropertyDescriptor(raw.contents, ck);
      const meta = desc ? desc.value : null;
      if (!isPlainObject(meta)) continue;
      if (typeof meta.title !== "string") continue;
      if (typeof meta.createdAt !== "number" || !Number.isFinite(meta.createdAt)) continue;
      contents.set(ck, { title: meta.title, createdAt: meta.createdAt });
    }
  }
  return { overrides, contents, excludedAuto };
}

function buildPreparedCores(titles) {
  const list = [];
  const seen = new Set();
  for (const t of titles) {
    const p = prepareCore(t);
    if (!p.eligible) continue;
    const sig = p.series
      ? `${p.core}\0${p.series.seasonKey}|${p.series.episodeKey}|${p.series.sectionKey}`
      : p.core;
    if (seen.has(sig)) continue;
    seen.add(sig);
    list.push(p);
  }
  return list;
}

/**
 * 构建按 UTC+8 日历日（dayNum | null）分桶的候选索引：
 * - 小桶（alias 数 ≤ 32）直接扫描，避免建索引开销
 * - 大桶对高频 bigram（超过半数 alias 恰好出现 1 次）采用补集倒排，
 *   将密集共享前缀场景从 O(L·M) 降为 O(L + M)，且数学结果 100% 精确等价。
 * - 每条 item 携带汇总自全部标题别名的 `series`，在评分前先按整条 item 拒绝集数冲突。
 */
function buildDayBucketedIndex(items) {
  const grouped = new Map();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const cores = it.cores;
    if (!cores || cores.length === 0) continue;
    pushToMap(grouped, it.dayNum, { itemIdx: it.itemIdx, cores, series: it.series || null });
  }

  const bucketsByDay = new Map();
  for (const [dayNum, dayItems] of grouped.entries()) {
    const itemCount = dayItems.length;
    const itemIndices = new Int32Array(itemCount);
    const itemSeries = new Array(itemCount);
    const aliasCoreList = [];
    const aliasLocalTiList = [];

    for (let li = 0; li < itemCount; li++) {
      itemIndices[li] = dayItems[li].itemIdx;
      itemSeries[li] = dayItems[li].series;
      const cores = dayItems[li].cores;
      for (let ci = 0; ci < cores.length; ci++) {
        aliasCoreList.push(cores[ci]);
        aliasLocalTiList.push(li);
      }
    }

    const aliasCount = aliasCoreList.length;
    const aliasLocalTi = Int32Array.from(aliasLocalTiList);
    const aliasLen = new Int32Array(aliasCount);
    const aliasBigramLen = new Int32Array(aliasCount);
    for (let ai = 0; ai < aliasCount; ai++) {
      aliasLen[ai] = aliasCoreList[ai].len;
      aliasBigramLen[ai] = aliasCoreList[ai].bigrams.length;
    }

    let invIndex = null;
    if (aliasCount > DAY_BUCKET_INDEX_THRESHOLD) {
      const postings = new Map();
      for (let ai = 0; ai < aliasCount; ai++) {
        const p = aliasCoreList[ai];
        const ub = p.uniqueBigrams;
        const uc = p.uniqueCounts;
        for (let bi = 0; bi < ub.length; bi++) {
          const g = ub[bi];
          let arr = postings.get(g);
          if (!arr) {
            arr = [];
            postings.set(g, arr);
          }
          arr.push(ai, uc[bi]);
        }
      }

      invIndex = new Map();
      const halfAliases = aliasCount >>> 1;
      const presentMark = new Uint8Array(aliasCount);

      for (const [g, arr] of postings.entries()) {
        const df = arr.length >>> 1;
        let onesCount = 0;
        let allOne = true;
        for (let k = 1; k < arr.length; k += 2) {
          if (arr[k] === 1) onesCount++;
          else allOne = false;
        }
        if (onesCount > halfAliases) {
          // 高频补集编码：默认全部 alias 出现 1 次，仅记录缺席者与出现 >=2 次者
          presentMark.fill(0);
          const multiTmp = [];
          for (let k = 0; k < arr.length; k += 2) {
            const aIdx = arr[k];
            const cnt = arr[k + 1];
            presentMark[aIdx] = 1;
            if (cnt !== 1) multiTmp.push(aIdx, cnt);
          }
          const absentCount = aliasCount - df;
          const absent = new Int32Array(absentCount);
          if (absentCount > 0) {
            let w = 0;
            for (let ai = 0; ai < aliasCount; ai++) {
              if (presentMark[ai] === 0) absent[w++] = ai;
            }
          }
          invIndex.set(g, {
            complement: true,
            absent,
            multi: multiTmp.length > 0 ? Int32Array.from(multiTmp) : EMPTY_INT32,
          });
        } else if (allOne) {
          const ids = new Int32Array(df);
          for (let k = 0, w = 0; k < arr.length; k += 2) ids[w++] = arr[k];
          invIndex.set(g, { complement: false, allOne: true, ids });
        } else {
          invIndex.set(g, { complement: false, allOne: false, pairs: Int32Array.from(arr) });
        }
      }
    }

    bucketsByDay.set(dayNum, {
      dayNum,
      itemCount,
      itemIndices,
      itemSeries,
      aliasCount,
      aliasCores: aliasCoreList,
      aliasLocalTi,
      aliasLen,
      aliasBigramLen,
      invIndex,
      aliasOverlap: new Int32Array(aliasCount),
      aliasStamp: new Int32Array(aliasCount),
      touchedAliases: new Int32Array(aliasCount),
      itemMaxSim: new Float64Array(itemCount),
      itemStamp: new Int32Array(itemCount),
      touchedItems: new Int32Array(itemCount),
      stamp: 0,
    });
  }

  return bucketsByDay;
}

/** 在单个日桶内为 queryCore 评分并回调所有相似度 > 0 的 (itemIdx, sim)；评分前先按整条 item 别名集数拒绝冲突 */
function scoreDayBucket(bucket, queryCore, querySeries, onHit) {
  const { itemIndices, itemSeries, aliasCount, aliasCores, aliasLocalTi } = bucket;
  const effectiveQuerySeries = querySeries || queryCore.series;
  let stamp = ++bucket.stamp;
  if (stamp >= 0x7fffffff) {
    bucket.aliasStamp.fill(0);
    bucket.itemStamp.fill(0);
    bucket.stamp = 1;
    stamp = 1;
  }

  const itemMaxSim = bucket.itemMaxSim;
  const itemStamp = bucket.itemStamp;
  const touchedItems = bucket.touchedItems;
  let touchedItemCount = 0;

  if (!bucket.invIndex) {
    for (let ai = 0; ai < aliasCount; ai++) {
      const li = aliasLocalTi[ai];
      const targetSeries = itemSeries[li] || aliasCores[ai].series;
      if (effectiveQuerySeries && targetSeries && hasConflictingSeries(effectiveQuerySeries, targetSeries)) {
        continue;
      }
      const sim = computePreparedSimilarity(queryCore, aliasCores[ai]);
      if (sim <= 0) continue;
      if (itemStamp[li] !== stamp) {
        itemStamp[li] = stamp;
        itemMaxSim[li] = sim;
        touchedItems[touchedItemCount++] = li;
      } else if (sim > itemMaxSim[li]) {
        itemMaxSim[li] = sim;
      }
    }
    for (let k = 0; k < touchedItemCount; k++) {
      const li = touchedItems[k];
      onHit(itemIndices[li], itemMaxSim[li]);
    }
    return;
  }

  const invIndex = bucket.invIndex;
  const aliasOverlap = bucket.aliasOverlap;
  const aliasStamp = bucket.aliasStamp;
  const touchedAliases = bucket.touchedAliases;
  let touchedAliasCount = 0;
  let baseOverlap = 0;

  const qUb = queryCore.uniqueBigrams;
  const qUc = queryCore.uniqueCounts;
  for (let bi = 0; bi < qUb.length; bi++) {
    const entry = invIndex.get(qUb[bi]);
    if (!entry) continue;
    const ca = qUc[bi];
    if (entry.complement) {
      baseOverlap += 1;
      const absent = entry.absent;
      for (let k = 0; k < absent.length; k++) {
        const aIdx = absent[k];
        if (aliasStamp[aIdx] !== stamp) {
          aliasStamp[aIdx] = stamp;
          aliasOverlap[aIdx] = -1;
        } else {
          aliasOverlap[aIdx] -= 1;
        }
      }
      if (ca > 1 && entry.multi.length > 0) {
        const multi = entry.multi;
        for (let k = 0; k < multi.length; k += 2) {
          const aIdx = multi[k];
          const cb = multi[k + 1];
          const delta = (ca < cb ? ca : cb) - 1;
          if (delta === 0) continue;
          if (aliasStamp[aIdx] !== stamp) {
            aliasStamp[aIdx] = stamp;
            aliasOverlap[aIdx] = delta;
          } else {
            aliasOverlap[aIdx] += delta;
          }
        }
      }
    } else if (entry.allOne) {
      const ids = entry.ids;
      for (let k = 0; k < ids.length; k++) {
        const aIdx = ids[k];
        if (aliasStamp[aIdx] !== stamp) {
          aliasStamp[aIdx] = stamp;
          aliasOverlap[aIdx] = 1;
          if (baseOverlap === 0) touchedAliases[touchedAliasCount++] = aIdx;
        } else {
          aliasOverlap[aIdx] += 1;
        }
      }
    } else {
      const pairs = entry.pairs;
      for (let k = 0; k < pairs.length; k += 2) {
        const aIdx = pairs[k];
        const cb = pairs[k + 1];
        const inc = ca < cb ? ca : cb;
        if (aliasStamp[aIdx] !== stamp) {
          aliasStamp[aIdx] = stamp;
          aliasOverlap[aIdx] = inc;
          if (baseOverlap === 0) touchedAliases[touchedAliasCount++] = aIdx;
        } else {
          aliasOverlap[aIdx] += inc;
        }
      }
    }
  }

  const qLen = queryCore.len;
  const qBgLen = queryCore.bigrams.length;
  const qCore = queryCore.core;
  const qSeries = effectiveQuerySeries;
  const aliasLen = bucket.aliasLen;
  const aliasBigramLen = bucket.aliasBigramLen;

  if (baseOverlap > 0) {
    for (let ai = 0; ai < aliasCount; ai++) {
      const ov = baseOverlap + (aliasStamp[ai] === stamp ? aliasOverlap[ai] : 0);
      if (ov <= 0) continue;
      const li = aliasLocalTi[ai];
      const targetSeries = itemSeries[li] || aliasCores[ai].series;
      if (qSeries && targetSeries && hasConflictingSeries(qSeries, targetSeries)) continue;
      const ac = aliasCores[ai];

      const aLen = aliasLen[ai];
      const aBgLen = aliasBigramLen[ai];
      let sim;
      if (qLen === aLen && ov === qBgLen && qCore === ac.core) {
        sim = 1;
      } else {
        const minLen = qLen <= aLen ? qLen : aLen;
        const minBgLen = qBgLen <= aBgLen ? qBgLen : aBgLen;
        if (
          minLen >= FUZZY_SUBSTRING_MIN_LEN &&
          ov === minBgLen &&
          (qLen <= aLen ? ac.core.includes(qCore) : qCore.includes(ac.core))
        ) {
          sim = FUZZY_SUBSTRING_SCORE;
        } else {
          sim = (2 * ov) / (qBgLen + aBgLen);
        }
      }
      if (itemStamp[li] !== stamp) {
        itemStamp[li] = stamp;
        itemMaxSim[li] = sim;
        touchedItems[touchedItemCount++] = li;
      } else if (sim > itemMaxSim[li]) {
        itemMaxSim[li] = sim;
      }
    }
  } else {
    for (let k = 0; k < touchedAliasCount; k++) {
      const ai = touchedAliases[k];
      const ov = aliasOverlap[ai];
      if (ov <= 0) continue;
      const li = aliasLocalTi[ai];
      const targetSeries = itemSeries[li] || aliasCores[ai].series;
      if (qSeries && targetSeries && hasConflictingSeries(qSeries, targetSeries)) continue;
      const ac = aliasCores[ai];

      const aLen = aliasLen[ai];
      const aBgLen = aliasBigramLen[ai];
      let sim;
      if (qLen === aLen && ov === qBgLen && qCore === ac.core) {
        sim = 1;
      } else {
        const minLen = qLen <= aLen ? qLen : aLen;
        const minBgLen = qBgLen <= aBgLen ? qBgLen : aBgLen;
        if (
          minLen >= FUZZY_SUBSTRING_MIN_LEN &&
          ov === minBgLen &&
          (qLen <= aLen ? ac.core.includes(qCore) : qCore.includes(ac.core))
        ) {
          sim = FUZZY_SUBSTRING_SCORE;
        } else {
          sim = (2 * ov) / (qBgLen + aBgLen);
        }
      }
      if (itemStamp[li] !== stamp) {
        itemStamp[li] = stamp;
        itemMaxSim[li] = sim;
        touchedItems[touchedItemCount++] = li;
      } else if (sim > itemMaxSim[li]) {
        itemMaxSim[li] = sim;
      }
    }
  }

  for (let k = 0; k < touchedItemCount; k++) {
    const li = touchedItems[k];
    onHit(itemIndices[li], itemMaxSim[li]);
  }
}

/** 收集与 queryDay 满足 ±FUZZY_MAX_DAY_DIFF（含缺时间 null 桶）的全部候选日桶 */
function collectWindowBuckets(bucketsByDay, queryDay, outBuckets) {
  outBuckets.length = 0;
  if (queryDay === null) {
    for (const b of bucketsByDay.values()) outBuckets.push(b);
    return;
  }
  for (let d = queryDay - FUZZY_MAX_DAY_DIFF; d <= queryDay + FUZZY_MAX_DAY_DIFF; d++) {
    const b = bucketsByDay.get(d);
    if (b) outBuckets.push(b);
  }
  const nullBucket = bucketsByDay.get(null);
  if (nullBucket) outBuckets.push(nullBucket);
}

/**
 * ③ 同 group+platform 内对未关联作品与未占用 target 做模糊匹配。
 * 先按 UTC+8 日历日时间窗（±2 天 + 缺时间桶）分桶，再在桶内用高频补集倒排一次打分并按 (core, day) 缓存。
 */
function matchFuzzyGroupTargets(freeWorks, freeTargets, result, matchedWorks, occupiedTargets) {
  if (!freeWorks.length || !freeTargets.length) return;

  const targetItems = [];
  for (let ti = 0; ti < freeTargets.length; ti++) {
    const t = freeTargets[ti];
    if (t.preparedCores && t.preparedCores.length > 0) {
      targetItems.push({
        itemIdx: ti,
        dayNum: t.dayNum,
        cores: t.preparedCores,
        series: t.series || null,
      });
    }
  }
  if (!targetItems.length) return;

  const bucketsByDay = buildDayBucketedIndex(targetItems);
  const wCount = freeWorks.length;
  const tCount = freeTargets.length;

  const wBestSim = new Float64Array(wCount);
  const wSecondSim = new Float64Array(wCount);
  const wBestTarget = new Int32Array(wCount).fill(-1);
  const wBestThreshold = new Float64Array(wCount).fill(Infinity);

  const tBestSim = new Float64Array(tCount);
  const tSecondSim = new Float64Array(tCount);
  const tBestWork = new Int32Array(tCount).fill(-1);
  const tBestTied = new Uint8Array(tCount);

  // 仅对出现 ≥2 次的相同标题签名启用日桶打分缓存，唯一标题直接走零分配回调
  const coreSigCounts = new Map();
  const workCoreSigs = new Array(wCount);
  for (let wi = 0; wi < wCount; wi++) {
    const w = freeWorks[wi];
    const wp = w.preparedCore;
    if (!wp || !wp.eligible) continue;
    const ws = w.series || wp.series;
    const sig = ws
      ? `${wp.core}\0${ws.seasonKey}|${ws.episodeKey}|${ws.sectionKey}`
      : wp.core;
    workCoreSigs[wi] = sig;
    coreSigCounts.set(sig, (coreSigCounts.get(sig) || 0) + 1);
  }

  const bucketScoreCache = new Map();
  const windowBuckets = [];

  for (let wi = 0; wi < wCount; wi++) {
    const w = freeWorks[wi];
    const wp = w.preparedCore;
    if (!wp || !wp.eligible) continue;
    const ws = w.series || wp.series;

    collectWindowBuckets(bucketsByDay, w.dayNum, windowBuckets);
    if (!windowBuckets.length) continue;

    const coreSig = workCoreSigs[wi];
    const shouldCache = coreSigCounts.get(coreSig) > 1;

    let bestSim = 0;
    let secondSim = 0;
    let bestTi = -1;
    let bestThreshold = Infinity;

    for (let bi = 0; bi < windowBuckets.length; bi++) {
      const bucket = windowBuckets[bi];
      const threshold =
        w.dayNum !== null && bucket.dayNum !== null
          ? FUZZY_SIM_THRESHOLD
          : FUZZY_SIM_THRESHOLD + FUZZY_MISSING_TIME_PENALTY;

      const applyHit = (ti, sim) => {
        const t = freeTargets[ti];
        // 保留直链冲突排除：target 已有明确直链且与作品直链不同时禁止模糊关联
        if (t.normUrl && t.normUrl !== w.normUrl) return;

        if (sim > bestSim + FUZZY_EPS) {
          secondSim = bestSim;
          bestSim = sim;
          bestTi = ti;
          bestThreshold = threshold;
        } else if (Math.abs(sim - bestSim) <= FUZZY_EPS) {
          secondSim = sim;
        } else if (sim > secondSim) {
          secondSim = sim;
        }

        if (sim > tBestSim[ti] + FUZZY_EPS) {
          tSecondSim[ti] = tBestSim[ti];
          tBestSim[ti] = sim;
          tBestWork[ti] = wi;
          tBestTied[ti] = 0;
        } else if (Math.abs(sim - tBestSim[ti]) <= FUZZY_EPS) {
          tSecondSim[ti] = sim;
          tBestTied[ti] = 1;
        } else if (sim > tSecondSim[ti]) {
          tSecondSim[ti] = sim;
        }
      };

      if (!shouldCache) {
        scoreDayBucket(bucket, wp, ws, applyHit);
      } else {
        const cacheKey = `${bucket.dayNum === null ? "null" : bucket.dayNum}\0${coreSig}`;
        let cachedHits = bucketScoreCache.get(cacheKey);
        if (!cachedHits) {
          const hitIndices = [];
          const hitSims = [];
          scoreDayBucket(bucket, wp, ws, (ti, sim) => {
            hitIndices.push(ti);
            hitSims.push(sim);
            applyHit(ti, sim);
          });
          cachedHits = { hitIndices, hitSims };
          if (bucketScoreCache.size < 4096) {
            bucketScoreCache.set(cacheKey, cachedHits);
          }
        } else {
          const { hitIndices, hitSims } = cachedHits;
          for (let k = 0; k < hitIndices.length; k++) {
            applyHit(hitIndices[k], hitSims[k]);
          }
        }
      }
    }

    wBestSim[wi] = bestSim;
    wSecondSim[wi] = secondSim;
    wBestTarget[wi] = bestTi;
    wBestThreshold[wi] = bestThreshold;
  }

  for (let wi = 0; wi < wCount; wi++) {
    const ti = wBestTarget[wi];
    if (ti < 0) continue;
    const sim = wBestSim[wi];
    if (sim < wBestThreshold[wi] - FUZZY_EPS) continue;
    if (sim - wSecondSim[wi] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;
    // 互为最佳且 target 侧无并列最高分（防止同分时按输入顺序任选其一）
    if (tBestWork[ti] !== wi || tBestTied[ti]) continue;

    const w = freeWorks[wi];
    const t = freeTargets[ti];
    matchedWorks.add(w.idx);
    occupiedTargets.add(t.idx);
    result.set(w.workKey, {
      contentKey: t.contentKey,
      matchedBy: "fuzzy",
      score: roundScore(sim),
    });
  }
}

/**
 * ④ 无发布记录作品跨平台聚类（同 group，不同 platform）。
 * - 每对平台 (P1, P2) 按时间窗分桶做对称互为最佳 + 差值 ≥0.1 + 时间窗 ≤2 天（缺时间 +0.1）成边
 * - 按 (sim desc, minMemberKey asc, maxMemberKey asc) 全序做 Kruskal 合并：
 *   合簇前检查平台不冲突，且两簇所有跨簇成员对均满足时间窗与标题相似度 ≥ 阈值（禁止链式传递）
 * - 簇大小 ≥2 才成立，基于排序后的 `platform|workId`（不含 group）生成稳定 auto:<hash>
 */
function clusterUnlinkedAcrossPlatforms(unlinkedWorks, result) {
  const autoKeys = new Set();
  if (!unlinkedWorks.length) return autoKeys;

  const byGroup = new Map();
  for (const w of unlinkedWorks) {
    if (!w.preparedCore || !w.preparedCore.eligible) continue;
    pushToMap(byGroup, w.groupKey, w);
  }

  for (const groupWorks of byGroup.values()) {
    const byPlatform = new Map();
    for (const w of groupWorks) {
      pushToMap(byPlatform, w.platformKey, w);
    }
    const platforms = [...byPlatform.keys()].sort(compareText);
    if (platforms.length < 2) continue;

    // 统一按不含 group 的 memberKey（platform|workId）升序赋局部节点编号，保证跨组等价簇确定性一致
    const nodes = [...groupWorks].sort((a, b) => {
      const cm = compareText(a.memberKey, b.memberKey);
      return cm !== 0 ? cm : compareText(a.workKey, b.workKey);
    });
    const nodeIdxByWorkKey = new Map();
    for (let i = 0; i < nodes.length; i++) {
      nodeIdxByWorkKey.set(nodes[i].workKey, i);
    }

    const edges = [];
    for (let pi = 0; pi < platforms.length; pi++) {
      const listA = byPlatform.get(platforms[pi]);
      for (let pj = pi + 1; pj < platforms.length; pj++) {
        const listB = byPlatform.get(platforms[pj]);
        findCrossPlatformPairEdges(listA, listB, nodeIdxByWorkKey, edges);
      }
    }
    if (!edges.length) continue;

    edges.sort((a, b) => {
      if (Math.abs(a.sim - b.sim) > FUZZY_EPS) return b.sim - a.sim;
      const c1 = compareText(a.key1, b.key1);
      if (c1 !== 0) return c1;
      return compareText(a.key2, b.key2);
    });

    const n = nodes.length;
    const parent = new Int32Array(n);
    const clusterPlatforms = new Array(n);
    const clusterMembers = new Array(n);
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      clusterPlatforms[i] = new Set([nodes[i].platformKey]);
      clusterMembers[i] = [i];
    }
    const find = (x) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };

    // 缓存已确认边及合簇校验中计算过的成员对相似度
    const pairSimCache = new Map();
    const pairKey = (a, b) => (a < b ? a * n + b : b * n + a);
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      pairSimCache.set(pairKey(e.u, e.v), e.sim);
    }
    const getPairSim = (a, b) => {
      const pk = pairKey(a, b);
      let s = pairSimCache.get(pk);
      if (s === undefined) {
        const sa = nodes[a].series || nodes[a].preparedCore.series;
        const sb = nodes[b].series || nodes[b].preparedCore.series;
        s =
          sa && sb && hasConflictingSeries(sa, sb)
            ? 0
            : computePreparedSimilarity(nodes[a].preparedCore, nodes[b].preparedCore);
        pairSimCache.set(pk, s);
      }
      return s;
    };

    const acceptedEdges = [];
    for (let ei = 0; ei < edges.length; ei++) {
      const e = edges[ei];
      const ru = find(e.u);
      const rv = find(e.v);
      if (ru === rv) {
        acceptedEdges.push(e);
        continue;
      }
      const setU = clusterPlatforms[ru];
      const setV = clusterPlatforms[rv];
      let conflict = false;
      const smaller = setU.size <= setV.size ? setU : setV;
      const larger = setU.size <= setV.size ? setV : setU;
      for (const pt of smaller) {
        if (larger.has(pt)) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;

      // 全对相容检查：两簇所有跨簇成员对必须两两满足时间窗且标题相似度 ≥ 对应阈值（禁止链式传递）
      const membersU = clusterMembers[ru];
      const membersV = clusterMembers[rv];
      let compatible = true;
      for (let i = 0; i < membersU.length && compatible; i++) {
        const aIdx = membersU[i];
        const wa = nodes[aIdx];
        for (let j = 0; j < membersV.length; j++) {
          const bIdx = membersV[j];
          const wb = nodes[bIdx];
          const tw = checkFuzzyTimeWindow(wa.dayNum, wb.dayNum);
          if (!tw.eligible) {
            compatible = false;
            break;
          }
          const pairSim = getPairSim(aIdx, bIdx);
          if (pairSim < tw.threshold - FUZZY_EPS) {
            compatible = false;
            break;
          }
        }
      }
      if (!compatible) continue;

      // 按节点编号小的为根合并
      const root = ru < rv ? ru : rv;
      const child = ru < rv ? rv : ru;
      parent[child] = root;
      for (const pt of clusterPlatforms[child]) clusterPlatforms[root].add(pt);
      for (let k = 0; k < clusterMembers[child].length; k++) {
        clusterMembers[root].push(clusterMembers[child][k]);
      }
      clusterPlatforms[child] = null;
      clusterMembers[child] = null;
      acceptedEdges.push(e);
    }

    const clusters = new Map();
    for (let i = 0; i < n; i++) {
      pushToMap(clusters, find(i), i);
    }

    const bestIncidentSim = new Float64Array(n);
    for (let ei = 0; ei < acceptedEdges.length; ei++) {
      const e = acceptedEdges[ei];
      if (e.sim > bestIncidentSim[e.u]) bestIncidentSim[e.u] = e.sim;
      if (e.sim > bestIncidentSim[e.v]) bestIncidentSim[e.v] = e.sim;
    }

    for (const memberIndices of clusters.values()) {
      if (memberIndices.length < 2) continue;
      // 按不含 group 的 platform|workId 排序计算哈希，确保跨组等价成员簇键完全一致
      const sortedMemberKeys = memberIndices.map((idx) => nodes[idx].memberKey).sort(compareText);
      const contentKey = computeAutoClusterKey(sortedMemberKeys);
      autoKeys.add(contentKey);
      for (const idx of memberIndices) {
        const w = nodes[idx];
        result.set(w.workKey, {
          contentKey,
          matchedBy: "fuzzy",
          score: roundScore(bestIncidentSim[idx]),
        });
      }
    }
  }

  return autoKeys;
}

function findCrossPlatformPairEdges(listA, listB, nodeIdxByWorkKey, edgesOut) {
  if (!listA.length || !listB.length) return;

  const bItems = [];
  for (let bi = 0; bi < listB.length; bi++) {
    const p = listB[bi].preparedCore;
    if (p && p.eligible) {
      bItems.push({
        itemIdx: bi,
        dayNum: listB[bi].dayNum,
        cores: [p],
        series: listB[bi].series || p.series || null,
      });
    }
  }
  if (!bItems.length) return;

  const bucketsByDay = buildDayBucketedIndex(bItems);
  const aCount = listA.length;
  const bCount = listB.length;
  const aBestSim = new Float64Array(aCount);
  const aSecondSim = new Float64Array(aCount);
  const aBestB = new Int32Array(aCount).fill(-1);
  const aBestThreshold = new Float64Array(aCount).fill(Infinity);

  const bBestSim = new Float64Array(bCount);
  const bSecondSim = new Float64Array(bCount);
  const bBestA = new Int32Array(bCount).fill(-1);
  const bBestThreshold = new Float64Array(bCount).fill(Infinity);

  const coreSigCounts = new Map();
  const aCoreSigs = new Array(aCount);
  for (let ai = 0; ai < aCount; ai++) {
    const wa = listA[ai];
    const pa = wa.preparedCore;
    if (!pa || !pa.eligible) continue;
    const sa = wa.series || pa.series;
    const sig = sa
      ? `${pa.core}\0${sa.seasonKey}|${sa.episodeKey}|${sa.sectionKey}`
      : pa.core;
    aCoreSigs[ai] = sig;
    coreSigCounts.set(sig, (coreSigCounts.get(sig) || 0) + 1);
  }

  const bucketScoreCache = new Map();
  const windowBuckets = [];

  for (let ai = 0; ai < aCount; ai++) {
    const wa = listA[ai];
    const pa = wa.preparedCore;
    if (!pa || !pa.eligible) continue;
    const sa = wa.series || pa.series;

    collectWindowBuckets(bucketsByDay, wa.dayNum, windowBuckets);
    if (!windowBuckets.length) continue;

    const coreSig = aCoreSigs[ai];
    const shouldCache = coreSigCounts.get(coreSig) > 1;

    let bestSim = 0;
    let secondSim = 0;
    let bestBi = -1;
    let bestThreshold = Infinity;

    for (let bk = 0; bk < windowBuckets.length; bk++) {
      const bucket = windowBuckets[bk];
      const threshold =
        wa.dayNum !== null && bucket.dayNum !== null
          ? FUZZY_SIM_THRESHOLD
          : FUZZY_SIM_THRESHOLD + FUZZY_MISSING_TIME_PENALTY;

      const applyHit = (bi, sim) => {
        if (sim > bestSim + FUZZY_EPS) {
          secondSim = bestSim;
          bestSim = sim;
          bestBi = bi;
          bestThreshold = threshold;
        } else if (Math.abs(sim - bestSim) <= FUZZY_EPS) {
          secondSim = sim;
        } else if (sim > secondSim) {
          secondSim = sim;
        }

        if (sim > bBestSim[bi] + FUZZY_EPS) {
          bSecondSim[bi] = bBestSim[bi];
          bBestSim[bi] = sim;
          bBestA[bi] = ai;
          bBestThreshold[bi] = threshold;
        } else if (Math.abs(sim - bBestSim[bi]) <= FUZZY_EPS) {
          bSecondSim[bi] = sim;
        } else if (sim > bSecondSim[bi]) {
          bSecondSim[bi] = sim;
        }
      };

      if (!shouldCache) {
        scoreDayBucket(bucket, pa, sa, applyHit);
      } else {
        const cacheKey = `${bucket.dayNum === null ? "null" : bucket.dayNum}\0${coreSig}`;
        let cachedHits = bucketScoreCache.get(cacheKey);
        if (!cachedHits) {
          const hitIndices = [];
          const hitSims = [];
          scoreDayBucket(bucket, pa, sa, (bi, sim) => {
            hitIndices.push(bi);
            hitSims.push(sim);
            applyHit(bi, sim);
          });
          cachedHits = { hitIndices, hitSims };
          if (bucketScoreCache.size < 4096) {
            bucketScoreCache.set(cacheKey, cachedHits);
          }
        } else {
          const { hitIndices, hitSims } = cachedHits;
          for (let k = 0; k < hitIndices.length; k++) {
            applyHit(hitIndices[k], hitSims[k]);
          }
        }
      }
    }

    aBestSim[ai] = bestSim;
    aSecondSim[ai] = secondSim;
    aBestB[ai] = bestBi;
    aBestThreshold[ai] = bestThreshold;
  }

  for (let ai = 0; ai < aCount; ai++) {
    const bi = aBestB[ai];
    if (bi < 0) continue;
    if (bBestA[bi] !== ai) continue;
    const sim = aBestSim[ai];
    if (sim < aBestThreshold[ai] - FUZZY_EPS) continue;
    if (sim < bBestThreshold[bi] - FUZZY_EPS) continue;
    if (sim - aSecondSim[ai] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;
    if (bBestSim[bi] - bSecondSim[bi] < FUZZY_MARGIN_MIN - FUZZY_EPS) continue;

    const wa = listA[ai];
    const wb = listB[bi];
    const u = nodeIdxByWorkKey.get(wa.workKey);
    const v = nodeIdxByWorkKey.get(wb.workKey);
    const key1 = wa.memberKey < wb.memberKey ? wa.memberKey : wb.memberKey;
    const key2 = wa.memberKey < wb.memberKey ? wb.memberKey : wa.memberKey;
    edgesOut.push({ u, v, sim, key1, key2 });
  }
}

/**
 * 按归一标题构建作品索引（供「获取状态」等入口复用）：
 * - 同一归一标题仅对应 1 个作品 → `{ work, ambiguous: false }`
 * - 同一归一标题对应 ≥2 个作品 → `{ work: null, ambiguous: true }`
 * normalize 可替换：「获取状态」用 normalizeStatusTitle（仅去零宽与首尾空白，保持该入口原有精确匹配语义）
 */
function buildTitleIndex(works, normalize = normalizeTitle) {
  const byTitle = new Map();
  if (!Array.isArray(works)) return byTitle;
  for (const w of works) {
    if (!isPlainObject(w)) continue;
    const key = normalize(w.title);
    if (!key) continue;
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, { work: w, ambiguous: false });
    } else if (!prev.ambiguous) {
      const prevId = toSafeTrimmed(prev.work.workId);
      const currId = toSafeTrimmed(w.workId);
      const prevUrl = toSafeTrimmed(prev.work.url);
      const currUrl = toSafeTrimmed(w.url);
      if (prevId && currId && prevId === currId && prevUrl === currUrl) continue;
      byTitle.set(key, { work: null, ambiguous: true });
    }
  }
  return byTitle;
}

function parseHttpUrl(raw) {
  const trimmed = toSafeTrimmed(raw);
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
  const trimmed = toSafeTrimmed(raw);
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
  return `${toSafeString(group)}|${toSafeString(platform)}|${toSafeString(workId)}`;
}

function extractRecordDate(rec, status) {
  const baseDate = typeof rec.date === "string" && isValidDateStr(rec.date.trim())
    ? rec.date.trim()
    : "";
  // 发布成功（含定时任务、换文件重发）时以最后一次发布日期为准：晚于登记日才采用
  if (status === "success") {
    const doneDate = toUtc8DateStr(rec.lastPublishAt);
    if (doneDate && (!baseDate || doneDate > baseDate)) return doneDate;
  }
  return baseDate || toUtc8DateStr(rec.lastPublishAt) || toUtc8DateStr(rec.createTime);
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
 * - 排除图文记录
 * - publishStatus 存在且不是 success → 直接排除（即使有 videoLink）；
 *   仅 publishStatus 缺失的历史记录允许凭有效非管理页直链纳入；
 *   republishCount > 0 时其 videoLink 不作为直链证据（仅走唯一标题规则）
 * - 仅按完整路径归桶（小写、/ 分隔，`file:<完整路径>`，assignable=true）；
 *   无完整路径时仅允许用不可变记录 `id` 生成 `record:id:<id>`（不含发布日期，唯一 id 时 assignable=true）；
 *   缺少完整路径与唯一记录 id（或 id 碰撞）的记录退化为位置键 `record:pos:<idx>` / `record:id:<id>:pos:<idx>`
 *   （assignable=false，禁止手工 assign，防止删改记录导致手工关联漂移）
 * - 每条平台记录独立成 target，不再按文件+平台折叠
 */
function buildContentIndex(pushRecords) {
  if (!Array.isArray(pushRecords)) return [];
  const parsedRecords = [];
  const recordKeyCounts = new Map();

  for (let idx = 0; idx < pushRecords.length; idx++) {
    const rec = pushRecords[idx];
    if (!isPlainObject(rec)) continue;
    if (toSafeTrimmed(rec.textType).toLowerCase() === "article") continue;

    // 字段存在（含空串、数组等异常值）即只接受 success；仅字段缺失的历史记录可凭直链兜底
    const hasStatusField = Object.prototype.hasOwnProperty.call(rec, "publishStatus") &&
      rec.publishStatus !== undefined;
    const rawStatus = rec.publishStatus;
    const status = typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
    if (hasStatusField && status !== "success") continue;
    const rawVideoLink = toSafeTrimmed(rec.videoLink);
    const validLink = normalizeDirectUrl(rawVideoLink);
    const republishCount = normalizeMetric(rec.republishCount);
    const attemptCount = normalizeMetric(rec.publishAttemptCount);
    const isRepublished =
      (republishCount !== null && republishCount > 0) ||
      (republishCount === null && attemptCount !== null && attemptCount > 1);
    const directVideoLink = !isRepublished && validLink ? rawVideoLink : "";

    if (!hasStatusField && !directVideoLink) continue;

    const platform = toSafeTrimmed(rec.pt);
    const group = toSafeTrimmed(rec.group) || toSafeString(rec.phone).split("-")[0].trim();
    const recordDate = extractRecordDate(rec, status);
    // 真实 pushData 完整路径在 filePath（LocalVideoPublish.vue:2095），兼容完整路径写入 selectedFile
    const fullPath = normalizeFullPath(rec.filePath) || normalizeFullPath(rec.selectedFile);
    const title = [rec.title, rec.bt, rec.textOtherName, rec.bookName]
      .map(toSafeTrimmed)
      .find(Boolean) || "";
    const matchRaw = platform === "视频号"
      ? [rec.title, rec.bt, rec.textOtherName, rec.shortTitle, rec.bt2Filled]
      : [rec.title, rec.bt, rec.textOtherName];

    let stableCandidateKey = "";
    if (!fullPath) {
      const recId = toSafeTrimmed(rec.id);
      if (recId) {
        // 仅用不可变记录 id，不含发布日期，跨日重发不会换键
        stableCandidateKey = `record:id:${recId}`;
        recordKeyCounts.set(stableCandidateKey, (recordKeyCounts.get(stableCandidateKey) || 0) + 1);
      }
    }

    parsedRecords.push({
      idx,
      platform,
      group,
      recordDate,
      fullPath,
      selectedFile: toSafeTrimmed(rec.selectedFile),
      title,
      matchRaw,
      status,
      directVideoLink,
      stableCandidateKey,
    });
  }

  const buckets = new Map();
  for (let i = 0; i < parsedRecords.length; i++) {
    const item = parsedRecords[i];
    let contentKey;
    let assignable = true;
    if (item.fullPath) {
      contentKey = `file:${item.fullPath.toLowerCase()}`;
    } else if (
      item.stableCandidateKey &&
      recordKeyCounts.get(item.stableCandidateKey) === 1 &&
      !isUnstableRecordKey(item.stableCandidateKey)
    ) {
      contentKey = item.stableCandidateKey;
    } else {
      assignable = false;
      contentKey = item.stableCandidateKey
        ? `${item.stableCandidateKey}:pos:${item.idx}`
        : `record:pos:${item.idx}`;
    }

    let bucket = buckets.get(contentKey);
    if (!bucket) {
      bucket = {
        contentKey,
        assignable,
        displayTitle: "",
        displayTitleDate: "",
        file: item.fullPath || item.selectedFile,
        fileDate: item.recordDate,
        firstPublishDate: "",
        targets: [],
      };
      buckets.set(contentKey, bucket);
    }

    if (item.fullPath && item.recordDate && (!bucket.fileDate || item.recordDate < bucket.fileDate)) {
      bucket.file = item.fullPath;
      bucket.fileDate = item.recordDate;
    }
    if (item.recordDate && (!bucket.firstPublishDate || item.recordDate < bucket.firstPublishDate)) {
      bucket.firstPublishDate = item.recordDate;
    }
    if (
      item.title &&
      (!bucket.displayTitle || (item.recordDate && (!bucket.displayTitleDate || item.recordDate < bucket.displayTitleDate)))
    ) {
      bucket.displayTitle = item.title;
      bucket.displayTitleDate = item.recordDate;
    }

    bucket.targets.push({
      contentKey,
      group: item.group,
      platform: item.platform,
      recordDate: item.recordDate,
      status: item.status,
      videoLink: item.directVideoLink,
      matchTitles: collectMatchTitles(item.matchRaw),
    });
  }

  return [...buckets.values()]
    .map((b) => ({
      contentKey: b.contentKey,
      assignable: b.assignable,
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

function parseCutoffDate(date) {
  if (date === undefined || date === null) return { ok: true, cutoffDate: "" };
  if (typeof date !== "string") return { ok: false, cutoffDate: "" };
  const trimmed = date.trim();
  if (!trimmed) return { ok: true, cutoffDate: "" };
  return isValidDateStr(trimmed) ? { ok: true, cutoffDate: trimmed } : { ok: false, cutoffDate: "" };
}

const AUTO_MATCH_RANK = { link: 3, title: 2, fuzzy: 1 };

function pickStrongestAutoEntry(autoEntries) {
  let best = autoEntries[0].entry;
  let bestRank = AUTO_MATCH_RANK[best.matchedBy] || 0;
  let bestScore = typeof best.score === "number" && Number.isFinite(best.score) ? best.score : -1;
  for (let i = 1; i < autoEntries.length; i++) {
    const cur = autoEntries[i].entry;
    const rank = AUTO_MATCH_RANK[cur.matchedBy] || 0;
    const score = typeof cur.score === "number" && Number.isFinite(cur.score) ? cur.score : -1;
    if (rank > bestRank || (rank === bestRank && score > bestScore + FUZZY_EPS)) {
      best = cur;
      bestRank = rank;
      bestScore = score;
    }
  }
  return best;
}

function getLinkResultMeta(link) {
  return link instanceof Map ? LINK_RESULT_META.get(link) || null : null;
}

/**
 * 关联作品与内容，返回 Map<`group|platform|workId`, { contentKey, matchedBy, score? }>。
 * - 可选截止日 date：排除 recordDate > date 的 target 与有效 publishTime > date 的 work
 * - 可选 worksDaily：将截至 date 仅存在于 worksDaily 的作品也纳入作品身份归属（仅接受手工覆盖）
 * - 可选手工矫正 overrides：按作品身份 `platform|workId` 存储；只有 detach 在 ③④ 之前按作品身份排除；
 *   ①–④ 照常运行（含被 assign 的作品参与占位），随后在全量分组上按作品身份 `platform|workId` 做一次统一归属裁决
 *   （同一作品挂在多分组时共用同一最终归属，日明细、跨平台汇总、GUI 完全一致），最后套用 overrides
 *   （assign 指向不存在/不稳定 contentKey 或未写入 contents 表的 auto:/manual: 时忽略）。
 * - auto 簇成员资格在自动阶段 ④ 确定：某成员被 assign 走后，不得改变其他作品的自动归属，
 *   剩余成员无论 ≥2 还是仅剩 1 条均保留原 `auto:` 键与 `fuzzy` 标记（仅剩 1 条时在汇总中显示为单平台）。
 * ① 有效直链 1:1 唯一匹配（多对一/一对多全部留空且禁止标题兜底）；
 * ② 标题命中且同 group+platform 内唯一 work、唯一未被①占用的 target，且 target 无冲突直链；
 * ③ 模糊匹配（同 group+platform，先汇总目标与作品全部标题别名的明确集数并在评分前硬拒绝冲突，排除占位/短标题，
 *    标题 core 子串≥6=0.95 / Float64 无损二元组 Dice，仅取 target 自身 recordDate/lastPublishAt，
 *    时间窗按 UTC+8 日历日相差 ≤2 天、缺时间门槛 +0.1，sim≥0.6、最佳比次佳高≥0.1、互为最佳）；
 * ④ 无发布记录作品跨平台聚类（同 group 不同 platform，同规则互为最佳成边 + Kruskal 全对相容合并每平台最多 1 条，
 *    簇大小≥2，按不含 group 的 platform|workId 生成稳定 auto:<hash>）。
 */
function linkWorks({ contents, accounts, date, overrides, worksDaily } = {}) {
  const result = new Map();
  if (!Array.isArray(accounts)) return result;
  const { ok, cutoffDate } = parseCutoffDate(date);
  if (!ok) return result;

  const {
    overrides: overrideMap,
    contents: overrideContents,
    excludedAuto: excludedAutoSet,
  } = normalizeOverridesDoc(overrides);
  const dailyByGp = isPlainObject(worksDaily) ? worksDaily : null;
  const assignableContentKeys = new Set();
  const targetsByGp = new Map();
  let targetSeq = 0;

  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c)) continue;
    const contentKey = toSafeString(c.contentKey);
    if (!contentKey) continue;
    const rawContentDate = toSafeTrimmed(c.firstPublishDate);
    const contentDate = isValidDateStr(rawContentDate) ? rawContentDate : "";
    const rawTargets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    const hasTargets = rawTargets.length > 0;
    let eligibleTargetCount = 0;

    for (const t of rawTargets) {
      const rawTargetDate = toSafeTrimmed(t.recordDate);
      // target 自身日期仅取 recordDate 或 lastPublishAt，不借素材首发日 contentDate
      const ownTargetDate = isValidDateStr(rawTargetDate)
        ? rawTargetDate
        : toUtc8DateStr(t.lastPublishAt);
      const cutoffTargetDate = ownTargetDate || contentDate;
      if (cutoffDate && cutoffTargetDate && cutoffTargetDate > cutoffDate) continue;
      eligibleTargetCount++;
      const gpKey = `${toSafeTrimmed(t.group)}|${toSafeTrimmed(t.platform)}`;
      const rawTitles = Array.isArray(t.matchTitles)
        ? t.matchTitles
        : [t.title, t.shortTitle, ...(Array.isArray(t.altTitles) ? t.altTitles : [])].filter(
            (v) => v != null && v !== ""
          );
      const matchTitles = collectMatchTitles(rawTitles);
      pushToMap(targetsByGp, gpKey, {
        idx: targetSeq++,
        contentKey,
        normUrl: normalizeDirectUrl(t.videoLink),
        matchTitles,
        preparedCores: buildPreparedCores(rawTitles),
        // 目标全部标题别名（主标题+短标题等）汇总的集数标记：②唯一标题与③模糊阶段共用集数冲突拒绝
        series: extractSeriesMarkersFromTitles(rawTitles),
        // ③ 模糊匹配时间窗只看该 target 自身日期，缺则走缺时间门槛 +0.1
        dayNum: dateStrToDayNum(ownTargetDate),
      });
    }

    const contentEligible = hasTargets
      ? eligibleTargetCount > 0
      : !cutoffDate || !contentDate || contentDate <= cutoffDate;
    if (contentEligible && c.assignable !== false && !isUnstableRecordKey(contentKey)) {
      assignableContentKeys.add(contentKey);
    }
  }

  // 若指定了截止日，先跨全量分组收集有效 publishTime > cutoffDate 的作品身份，避免跨组泄漏未来作品
  const excludedFuturePwKeys = new Set();
  if (cutoffDate) {
    for (const acc of accounts) {
      if (!isPlainObject(acc)) continue;
      const rawPlatform = toSafeString(acc.platform);
      for (const w of Array.isArray(acc.works) ? acc.works : []) {
        if (!isPlainObject(w)) continue;
        const workId = toSafeString(w.workId);
        if (!workId) continue;
        const pubMs = parseValidTimestampMs(w.publishTime);
        const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
        if (pubDate && pubDate > cutoffDate) {
          excludedFuturePwKeys.add(makeWorkIdentityKey(rawPlatform, workId));
        }
      }
    }
  }

  const worksByGp = new Map();
  const obsByPw = new Map();
  const gpInfoByKey = new Map();
  let workSeq = 0;

  for (const acc of accounts) {
    if (!isPlainObject(acc)) continue;
    const rawGroup = toSafeString(acc.group);
    const rawPlatform = toSafeString(acc.platform);
    const groupKey = rawGroup.trim();
    const platformKey = rawPlatform.trim();
    const gpKey = `${groupKey}|${platformKey}`;
    const rawGpKey = `${rawGroup}|${rawPlatform}`;
    if (!gpInfoByKey.has(rawGpKey)) gpInfoByKey.set(rawGpKey, { group: rawGroup, platform: rawPlatform });
    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w)) continue;
      const workId = toSafeString(w.workId);
      if (!workId) continue;
      const workKey = makeWorkKey(rawGroup, rawPlatform, workId);
      if (result.has(workKey)) continue;
      result.set(workKey, { contentKey: null, matchedBy: null });
      const pwKey = makeWorkIdentityKey(rawPlatform, workId);
      const pubMs = parseValidTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
      if (cutoffDate && ((pubDate && pubDate > cutoffDate) || excludedFuturePwKeys.has(pwKey))) {
        excludedFuturePwKeys.add(pwKey);
        continue;
      }

      const normTitle = normalizeTitle(w.title);
      const rawTitle = w.title;
      const preparedCore = prepareCore(rawTitle);
      const rawAltTitles = Array.isArray(w.altTitles) ? w.altTitles : [];
      const rawMatchTitles = Array.isArray(w.matchTitles) ? w.matchTitles : [];
      const hasExtraWorkTitles =
        rawAltTitles.length > 0 ||
        rawMatchTitles.length > 0 ||
        (w.shortTitle != null && w.shortTitle !== "");
      const workSeries = hasExtraWorkTitles
        ? extractSeriesMarkersFromTitles([
            rawTitle,
            ...rawAltTitles,
            ...rawMatchTitles,
            w.shortTitle,
          ])
        : preparedCore.series || extractSeriesMarkers(rawTitle);

      pushToMap(obsByPw, pwKey, {
        workKey,
        pwKey,
        group: rawGroup,
        platform: rawPlatform,
        workId,
        title: toSafeString(rawTitle),
        pubMs,
        fromWorksJson: true,
      });

      pushToMap(worksByGp, gpKey, {
        idx: workSeq++,
        workKey,
        pwKey,
        memberKey: `${platformKey}|${workId}`,
        groupKey,
        platformKey,
        normTitle,
        preparedCore,
        series: workSeries,
        normUrl: normalizeDirectUrl(w.url),
        dayNum: dateStrToDayNum(pubDate),
      });
    }
  }

  // 只存在于 works-daily（works.json 已删除/缺失）的作品也纳入 obsByPw，接受跨组统一归属与手工覆盖
  if (dailyByGp) {
    for (const [rawGpKey, accWorksDaily] of Object.entries(dailyByGp)) {
      if (!isPlainObject(accWorksDaily)) continue;
      let gpInfo = gpInfoByKey.get(rawGpKey);
      if (!gpInfo) {
        const sep = rawGpKey.lastIndexOf("|");
        if (sep === -1) continue;
        gpInfo = { group: rawGpKey.slice(0, sep), platform: rawGpKey.slice(sep + 1) };
      }
      const { group, platform } = gpInfo;
      for (const workId of Object.keys(accWorksDaily)) {
        if (!workId) continue;
        const workKey = makeWorkKey(group, platform, workId);
        if (result.has(workKey)) continue;
        const pwKey = makeWorkIdentityKey(platform, workId);
        if (excludedFuturePwKeys.has(pwKey)) continue;
        const snap = resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate);
        if (!snap) continue;
        result.set(workKey, { contentKey: null, matchedBy: null });
        pushToMap(obsByPw, pwKey, {
          workKey,
          pwKey,
          group,
          platform,
          workId,
          title: DELETED_WORK_TITLE,
          pubMs: null,
          fromWorksJson: false,
        });
      }
    }
  }

  const rawAutoResult = new Map();
  const unlinkedForCluster = [];

  for (const [gpKey, gpWorks] of worksByGp.entries()) {
    const gpTargets = targetsByGp.get(gpKey);
    const matchedWorks = new Set();
    const occupiedTargets = new Set();
    const blockedWorks = new Set();
    const blockedTargets = new Set();

    if (gpTargets && gpTargets.length) {
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
          rawAutoResult.set(urlWorks[0].workKey, { contentKey: urlTargets[0].contentKey, matchedBy: "link" });
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
        if (
          blockedTargets.has(t.idx) ||
          (t.normUrl && t.normUrl !== w.normUrl) ||
          hasConflictingSeries(w.series, t.series)
        ) {
          continue;
        }
        pushToMap(candidatesByTarget, t.idx, { work: w, target: t });
      }

      for (const pairs of candidatesByTarget.values()) {
        if (pairs.length === 1) {
          matchedWorks.add(pairs[0].work.idx);
          occupiedTargets.add(pairs[0].target.idx);
          rawAutoResult.set(pairs[0].work.workKey, { contentKey: pairs[0].target.contentKey, matchedBy: "title" });
        }
      }

      // ③ 作品↔发布记录 target 模糊匹配（只排除已匹配/已阻断/按作品身份排除自动；仅 assign 且未排除的作品照常参与占位）
      const freeWorks = [];
      for (const w of gpWorks) {
        if (
          matchedWorks.has(w.idx) ||
          blockedWorks.has(w.idx) ||
          excludedAutoSet.has(w.pwKey)
        ) {
          continue;
        }
        freeWorks.push(w);
      }
      const freeTargets = [];
      for (const t of gpTargets) {
        if (occupiedTargets.has(t.idx) || blockedTargets.has(t.idx)) continue;
        freeTargets.push(t);
      }

      matchFuzzyGroupTargets(freeWorks, freeTargets, rawAutoResult, matchedWorks, occupiedTargets);
    }

    for (const w of gpWorks) {
      if (matchedWorks.has(w.idx) || excludedAutoSet.has(w.pwKey)) {
        continue;
      }
      unlinkedForCluster.push(w);
    }
  }

  // ④ 无发布记录作品跨平台聚类（同 group，不同 platform；簇成员资格在此阶段确定）
  clusterUnlinkedAcrossPlatforms(unlinkedForCluster, rawAutoResult);

  // ⑤ 在全量分组上按作品身份 platform|workId 做一次统一归属裁决，再套用按作品身份存储的手工覆盖。
  //    注意：不清理因其他成员被 assign 走而仅剩 1 条的 auto:* 簇（assign 不得改变其他作品的自动归属）。
  const isValidAssignTarget = (contentKey) => {
    if (isValidSyntheticContentKey(contentKey)) {
      // auto:/manual: 合成内容必须在持久化 contents 表中存在才生效
      return overrideContents.has(contentKey);
    }
    return assignableContentKeys.has(contentKey);
  };

  const byWorkIdentity = new Map();
  const syntheticObsByKey = new Map();

  for (const [pwKey, obsList] of obsByPw.entries()) {
    if (excludedFuturePwKeys.has(pwKey)) continue;
    obsList.sort((a, b) => compareText(a.group, b.group));

    const autoEntries = [];
    for (const obs of obsList) {
      const entry = rawAutoResult.get(obs.workKey);
      if (entry && entry.contentKey) {
        autoEntries.push({ obs, entry });
      }
    }

    let resolved;
    if (autoEntries.length > 0 && new Set(autoEntries.map((x) => x.entry.contentKey)).size === 1) {
      const best = pickStrongestAutoEntry(autoEntries);
      resolved =
        best.matchedBy === "fuzzy" && typeof best.score === "number" && Number.isFinite(best.score)
          ? { contentKey: best.contentKey, matchedBy: "fuzzy", score: best.score }
          : { contentKey: best.contentKey, matchedBy: best.matchedBy };
    } else {
      resolved = { contentKey: null, matchedBy: null };
    }

    const ov = overrideMap.get(pwKey);
    if (ov) {
      if (ov.action === "detach") {
        resolved = { contentKey: null, matchedBy: "manual-detach" };
      } else if (ov.action === "assign") {
        if (isValidAssignTarget(ov.contentKey)) {
          resolved = { contentKey: ov.contentKey, matchedBy: "manual" };
        } else if (excludedAutoSet.has(pwKey)) {
          resolved = { contentKey: null, matchedBy: "manual-detach" };
        }
      }
    }

    byWorkIdentity.set(pwKey, resolved);
    for (const obs of obsList) {
      result.set(obs.workKey, { ...resolved });
      if (resolved.contentKey && isValidSyntheticContentKey(resolved.contentKey)) {
        pushToMap(syntheticObsByKey, resolved.contentKey, obs);
      }
    }
  }

  // 全量分组视角下的合成内容标题（供分组裁剪导出与校验上下文复用）
  const syntheticTitlesByKey = new Map();
  for (const [ck, list] of syntheticObsByKey.entries()) {
    const persisted = overrideContents.get(ck);
    if (persisted && persisted.title) {
      syntheticTitlesByKey.set(ck, persisted.title);
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const aHas = a.pubMs !== null;
      const bHas = b.pubMs !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && a.pubMs !== b.pubMs) return a.pubMs - b.pubMs;
      const cp = compareText(a.pwKey, b.pwKey);
      return cp !== 0 ? cp : compareText(a.workKey, b.workKey);
    });
    const chosen = sorted.find((o) => o.fromWorksJson && o.title) || sorted[0];
    syntheticTitlesByKey.set(ck, (chosen && chosen.title) || "(无标题)");
  }

  LINK_RESULT_META.set(result, {
    contents,
    accounts,
    worksDaily: dailyByGp,
    cutoffDate,
    overrides,
    byWorkIdentity,
    rawAutoByWorkKey: rawAutoResult,
    syntheticTitlesByKey,
    excludedFuturePwKeys,
  });
  return result;
}

function mergeMetricValue(prev, next) {
  if (prev == null) return next == null ? null : next;
  if (next == null) return prev;
  const total = prev + next;
  return total === 0 ? 0 : total;
}

/** 仅从 worksDaily 中取 ≤ cutoffDate 的最近有效快照，返回 { date, metrics }，不回退 works.json */
function resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate) {
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
  return { date: bestDate, metrics };
}

function addWorkToBucket(bucket, workItem, metrics) {
  const { platform, group, workId, url } = workItem;
  const workUrl = toSafeTrimmed(url);
  const pgKey = `${platform}|${group}`;
  if (platform) bucket.platforms.add(platform);
  bucket.workItems.push(workItem);

  if (!hasOwn(bucket.perPlatform, pgKey)) {
    bucket.perPlatform[pgKey] = {
      ...metrics,
      urls: workUrl ? [workUrl] : [],
      workIds: [workId],
      works: [workItem],
    };
  } else {
    const cell = bucket.perPlatform[pgKey];
    for (const k of WORK_STAT_KEYS) cell[k] = mergeMetricValue(cell[k], metrics[k]);
    if (workUrl && !cell.urls.includes(workUrl)) cell.urls.push(workUrl);
    cell.workIds.push(workId);
    cell.works.push(workItem);
  }
}

function summarizeBucketMatch(bucket) {
  if (bucket.isUnlinked) {
    const isManualDetach = bucket.workItems.some((w) => w.matchedBy === "manual-detach");
    return {
      matchMethod: null,
      matchScore: null,
      hasFuzzy: false,
      hasManual: false,
      isManualDetach,
    };
  }
  let hasManual = false;
  let hasFuzzy = false;
  let hasTitle = false;
  let hasLink = false;
  let minFuzzyScore = null;

  for (const w of bucket.workItems) {
    if (w.matchedBy === "manual") hasManual = true;
    else if (w.matchedBy === "fuzzy") {
      hasFuzzy = true;
      if (typeof w.score === "number" && Number.isFinite(w.score)) {
        if (minFuzzyScore === null || w.score < minFuzzyScore) {
          minFuzzyScore = w.score;
        }
      }
    } else if (w.matchedBy === "title") hasTitle = true;
    else if (w.matchedBy === "link") hasLink = true;
  }

  let matchMethod = null;
  if (hasManual) matchMethod = "manual";
  else if (hasFuzzy) matchMethod = "fuzzy";
  else if (hasTitle) matchMethod = "title";
  else if (hasLink) matchMethod = "link";

  return {
    matchMethod,
    matchScore: minFuzzyScore,
    hasFuzzy,
    hasManual,
    isManualDetach: false,
  };
}

function pickLatestSnapshot(obsList) {
  let best = null;
  for (const o of obsList) {
    if (!o.snap) continue;
    if (!best || o.snap.date > best.date) best = o.snap;
  }
  return best;
}

function pickMinValidPubMs(obsList) {
  let minMs = null;
  for (const o of obsList) {
    if (o.pubMs !== null && (minMs === null || o.pubMs < minMs)) minMs = o.pubMs;
  }
  return minMs;
}

/**
 * 构建跨平台内容级汇总行（截至 date，默认最新快照日）。
 * - link：仅当由 linkWorks 针对同一全量数据集与 cutoffDate 产出时复用，否则按截止日重算
 * - overrides：可选手工矫正配置（按作品身份 `platform|workId`，与 linkWorks 口径一致）
 * - groups：可选导出分组裁剪（Set 或数组）；归属已在全量分组上按作品身份裁决，此处仅按 groups 裁剪输出观测
 * - worksDaily：`{ "group|platform": readWorksDaily(group, platform) }`
 * - 按 `platform|workId` 跨组去重：只取一份 ≤date 的最近快照，归组列沿用按分组名排序的首个匹配分组
 * - worksDaily 中出现但 works.json 缺失的作品 ID 纳入手工覆盖范围，未关联时保留为未关联行（title "(已删除或未匹配)"）
 */
function buildContentSummaryRows({ contents, accounts, link, worksDaily, date, overrides, groups } = {}) {
  const { ok, cutoffDate } = parseCutoffDate(date);
  if (!ok) return [];

  const accountList = Array.isArray(accounts) ? accounts : [];
  const dailyByGp = isPlainObject(worksDaily) ? worksDaily : null;
  const {
    overrides: overrideMap,
    contents: overrideContents,
    excludedAuto: excludedAutoSet,
  } = normalizeOverridesDoc(overrides);
  const groupSet =
    groups instanceof Set
      ? groups.size > 0
        ? groups
        : null
      : Array.isArray(groups) && groups.length > 0
      ? new Set(groups.map((g) => String(g)))
      : null;

  const cachedMeta = link instanceof Map ? LINK_RESULT_META.get(link) : null;
  const canReuseLink = Boolean(
    cachedMeta &&
      cachedMeta.contents === contents &&
      cachedMeta.accounts === accountList &&
      cachedMeta.worksDaily === dailyByGp &&
      cachedMeta.cutoffDate === cutoffDate &&
      cachedMeta.overrides === overrides
  );
  const resolvedLink = canReuseLink
    ? link
    : linkWorks({
        contents,
        accounts: accountList,
        worksDaily: dailyByGp,
        date: cutoffDate,
        overrides,
      });
  const linkMeta = LINK_RESULT_META.get(resolvedLink) || null;
  const byWorkIdentity = linkMeta && linkMeta.byWorkIdentity ? linkMeta.byWorkIdentity : null;
  const rawAutoByWorkKey = linkMeta && linkMeta.rawAutoByWorkKey ? linkMeta.rawAutoByWorkKey : null;
  const metaSyntheticTitles =
    linkMeta && linkMeta.syntheticTitlesByKey ? linkMeta.syntheticTitlesByKey : null;

  const contentByKey = new Map();
  const buckets = new Map();
  const makeBucket = (
    contentKey,
    title,
    file,
    recordFirstDate,
    minWorkPublishMs,
    isUnlinked,
    canAssignTarget = true
  ) => ({
    contentKey,
    title: title || "(无标题)",
    file: file || "",
    recordFirstDate: recordFirstDate || "",
    minWorkPublishMs,
    isUnlinked,
    canAssignTarget: Boolean(!isUnlinked && canAssignTarget && !isUnstableRecordKey(contentKey)),
    platforms: new Set(),
    perPlatform: {},
    workItems: [],
  });

  for (const c of Array.isArray(contents) ? contents : []) {
    if (!isPlainObject(c)) continue;
    const contentKey = toSafeString(c.contentKey);
    if (!contentKey) continue;
    const rawDate = toSafeTrimmed(c.firstPublishDate);
    const contentDate = isValidDateStr(rawDate) ? rawDate : "";

    const rawTargets = Array.isArray(c.targets) ? c.targets.filter(isPlainObject) : [];
    const hasTargets = rawTargets.length > 0;
    const eligibleTargetsByGp = new Map();
    let eligibleCount = 0;
    let minEligibleTargetDate = "";

    for (const t of rawTargets) {
      const rawTDate = toSafeTrimmed(t.recordDate);
      const tDate = isValidDateStr(rawTDate)
        ? rawTDate
        : toUtc8DateStr(t.lastPublishAt) || contentDate;
      if (cutoffDate && tDate && tDate > cutoffDate) continue;
      eligibleCount++;
      if (tDate && (!minEligibleTargetDate || tDate < minEligibleTargetDate)) {
        minEligibleTargetDate = tDate;
      }
      const gpKey = `${toSafeTrimmed(t.group)}|${toSafeTrimmed(t.platform)}`;
      pushToMap(eligibleTargetsByGp, gpKey, {
        normUrl: normalizeDirectUrl(t.videoLink),
        matchTitles: collectMatchTitles(Array.isArray(t.matchTitles) ? t.matchTitles : [t.title]),
      });
    }

    const eligible = hasTargets
      ? eligibleCount > 0
      : !cutoffDate || !contentDate || contentDate <= cutoffDate;
    const effectiveRecordDate = hasTargets
      ? minEligibleTargetDate || (!cutoffDate || !contentDate || contentDate <= cutoffDate ? contentDate : "")
      : contentDate;
    const canAssignTarget = c.assignable !== false && !isUnstableRecordKey(contentKey);

    contentByKey.set(contentKey, {
      c,
      recordDate: effectiveRecordDate,
      hasTargets,
      eligible,
      canAssignTarget,
      eligibleTargetsByGp,
    });

    if (!eligible) continue;
    const bucketId = `linked:${contentKey}`;
    if (!buckets.has(bucketId)) {
      buckets.set(
        bucketId,
        makeBucket(
          contentKey,
          toSafeString(c.displayTitle),
          toSafeString(c.file),
          effectiveRecordDate,
          null,
          false,
          canAssignTarget
        )
      );
    }
  }

  // 1. 收集 accounts[*].works 中的作品观测（排除有效 publishTime > cutoffDate 的作品，按 groupSet 裁剪输出）
  const seenGpWorkKeys = new Set();
  const gpInfoByKey = new Map();
  const excludedFuturePwKeys = new Set(
    linkMeta && linkMeta.excludedFuturePwKeys ? linkMeta.excludedFuturePwKeys : []
  );
  const obsByPw = new Map();
  const syntheticObsByContentKey = new Map();

  for (const acc of accountList) {
    if (!isPlainObject(acc)) continue;
    const group = toSafeString(acc.group);
    const platform = toSafeString(acc.platform);
    const gpKey = `${group}|${platform}`;
    if (!gpInfoByKey.has(gpKey)) gpInfoByKey.set(gpKey, { group, platform });
    const inGroupScope = !groupSet || groupSet.has(group);
    const accWorksDaily = inGroupScope && dailyByGp && hasOwn(dailyByGp, gpKey) ? dailyByGp[gpKey] : null;

    for (const w of Array.isArray(acc.works) ? acc.works : []) {
      if (!isPlainObject(w)) continue;
      const workId = toSafeString(w.workId);
      if (!workId) continue;
      const workKey = makeWorkKey(group, platform, workId);
      if (seenGpWorkKeys.has(workKey)) continue;
      seenGpWorkKeys.add(workKey);

      const pwKey = makeWorkIdentityKey(platform, workId);
      const pubMs = parseValidTimestampMs(w.publishTime);
      const pubDate = pubMs !== null ? toUtc8DateStr(pubMs) : "";
      if (cutoffDate && pubDate && pubDate > cutoffDate) {
        excludedFuturePwKeys.add(pwKey);
        continue;
      }
      if (!inGroupScope || excludedFuturePwKeys.has(pwKey)) continue;

      const linkEntry = (byWorkIdentity && byWorkIdentity.get(pwKey)) || resolvedLink.get(workKey);
      const linkedKey = linkEntry ? toSafeString(linkEntry.contentKey) || null : null;
      const matchedBy = linkEntry ? linkEntry.matchedBy || null : null;
      const score =
        linkEntry && matchedBy === "fuzzy" && typeof linkEntry.score === "number" && Number.isFinite(linkEntry.score)
          ? linkEntry.score
          : null;

      const snap = resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate);
      const obs = {
        workKey,
        pwKey,
        group,
        platform,
        workId,
        title: toSafeString(w.title),
        url: toSafeTrimmed(w.url),
        pubMs,
        pubDate,
        linkedKey,
        matchedBy,
        score,
        snap,
        fromWorksJson: true,
      };
      pushToMap(obsByPw, pwKey, obs);
      if (linkedKey && !contentByKey.has(linkedKey)) {
        pushToMap(syntheticObsByContentKey, linkedKey, obs);
      }
    }
  }

  // 2. 遍历 worksDaily 中出现但 works.json 缺失的作品 ID，纳入手工覆盖范围
  if (dailyByGp) {
    for (const [gpKey, accWorksDaily] of Object.entries(dailyByGp)) {
      if (!isPlainObject(accWorksDaily)) continue;
      let gpInfo = gpInfoByKey.get(gpKey);
      if (!gpInfo) {
        const sep = gpKey.lastIndexOf("|");
        if (sep === -1) continue;
        gpInfo = { group: gpKey.slice(0, sep), platform: gpKey.slice(sep + 1) };
      }
      const { group, platform } = gpInfo;
      if (groupSet && !groupSet.has(group)) continue;
      for (const workId of Object.keys(accWorksDaily)) {
        if (!workId) continue;
        const workKey = makeWorkKey(group, platform, workId);
        if (seenGpWorkKeys.has(workKey)) continue;
        seenGpWorkKeys.add(workKey);

        const pwKey = makeWorkIdentityKey(platform, workId);
        if (excludedFuturePwKeys.has(pwKey)) continue;
        const snap = resolveWorkSnapshotAsOf(workId, accWorksDaily, cutoffDate);
        if (!snap) continue;
        const linkEntry = (byWorkIdentity && byWorkIdentity.get(pwKey)) || resolvedLink.get(workKey);
        const linkedKey = linkEntry ? toSafeString(linkEntry.contentKey) || null : null;
        const matchedBy = linkEntry ? linkEntry.matchedBy || null : null;
        const score =
          linkEntry && matchedBy === "fuzzy" && typeof linkEntry.score === "number" && Number.isFinite(linkEntry.score)
            ? linkEntry.score
            : null;

        const obs = {
          workKey,
          pwKey,
          group,
          platform,
          workId,
          title: DELETED_WORK_TITLE,
          url: "",
          pubMs: null,
          pubDate: "",
          linkedKey,
          matchedBy,
          score,
          snap,
          fromWorksJson: false,
        };
        pushToMap(obsByPw, pwKey, obs);
        if (linkedKey && !contentByKey.has(linkedKey)) {
          pushToMap(syntheticObsByContentKey, linkedKey, obs);
        }
      }
    }
  }

  // 为 auto:* / manual:* 合成桶确定性地选取标题：优先持久化 contents 表标题，其次全量簇内最早发布作品标题
  const syntheticTitleByKey = new Map();
  for (const [ck, list] of syntheticObsByContentKey.entries()) {
    const persisted = overrideContents.get(ck);
    if (persisted && persisted.title) {
      syntheticTitleByKey.set(ck, persisted.title);
      continue;
    }
    if (metaSyntheticTitles && metaSyntheticTitles.has(ck)) {
      syntheticTitleByKey.set(ck, metaSyntheticTitles.get(ck));
      continue;
    }
    const sorted = [...list].sort((a, b) => {
      const aHas = a.pubMs !== null;
      const bHas = b.pubMs !== null;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (aHas && a.pubMs !== b.pubMs) return a.pubMs - b.pubMs;
      return compareText(a.pwKey, b.pwKey);
    });
    const chosen = sorted.find((o) => o.fromWorksJson && o.title) || sorted[0];
    syntheticTitleByKey.set(ck, (chosen && chosen.title) || "(无标题)");
  }

  // 3. 按作品身份 platform|workId 跨组去重（归属已由 linkWorks 在全量分组上按作品身份统一裁决）
  for (const [pwKey, obsList] of obsByPw.entries()) {
    if (excludedFuturePwKeys.has(pwKey)) continue;
    obsList.sort((a, b) => compareText(a.group, b.group));

    const { platform, workId } = obsList[0];
    const resolvedLinkedKey = obsList[0].linkedKey;
    const resolvedMatchedBy = obsList[0].matchedBy;
    const resolvedScore = obsList[0].score;
    const hasOverride = overrideMap.has(pwKey) || excludedAutoSet.has(pwKey);
    const bestSnap = pickLatestSnapshot(obsList);

    if (resolvedLinkedKey != null) {
      // 既有归组列：若存在自动匹配到同一 contentKey 的观测则取按分组名排序的首组，否则取全观测首组
      const sameRawAutoObs = rawAutoByWorkKey
        ? obsList.filter((o) => {
            const raw = rawAutoByWorkKey.get(o.workKey);
            return raw && raw.contentKey === resolvedLinkedKey;
          })
        : [];
      const primaryGroup = (sameRawAutoObs[0] || obsList[0]).group;
      const preferredObs = sameRawAutoObs.length > 0 ? sameRawAutoObs : obsList;
      const bestTitle =
        (preferredObs.find((o) => o.fromWorksJson && o.title) ||
          obsList.find((o) => o.fromWorksJson && o.title) ||
          obsList[0]).title || "(无标题)";
      const bestUrl =
        (preferredObs.find((o) => o.url) || obsList.find((o) => o.url) || {}).url || "";
      const bestPubMs = pickMinValidPubMs(preferredObs) ?? pickMinValidPubMs(obsList);

      const bucketId = `linked:${resolvedLinkedKey}`;
      let bucket = buckets.get(bucketId);
      if (!bucket) {
        if (!bestSnap) continue;
        const meta = contentByKey.get(resolvedLinkedKey);
        const persisted = overrideContents.get(resolvedLinkedKey);
        const fallbackTitle =
          (persisted && persisted.title) ||
          syntheticTitleByKey.get(resolvedLinkedKey) ||
          (preferredObs.find((o) => o.fromWorksJson && o.title) || {}).title ||
          (obsList[0] && obsList[0].title) ||
          "";
        bucket = meta
          ? makeBucket(
              resolvedLinkedKey,
              toSafeString(meta.c.displayTitle),
              toSafeString(meta.c.file),
              meta.recordDate,
              null,
              false,
              meta.canAssignTarget
            )
          : makeBucket(resolvedLinkedKey, fallbackTitle, "", "", null, false, true);
        buckets.set(bucketId, bucket);
      }

      if (bestPubMs !== null) {
        if (bucket.minWorkPublishMs === null || bestPubMs < bucket.minWorkPublishMs) {
          bucket.minWorkPublishMs = bestPubMs;
        }
      }
      if (bestSnap) {
        addWorkToBucket(
          bucket,
          {
            workKey: pwKey,
            workId,
            group: primaryGroup,
            platform,
            title: bestTitle,
            url: bestUrl,
            publishDate: bestPubMs !== null ? toUtc8DateStr(bestPubMs) : "",
            matchedBy: resolvedMatchedBy,
            score: resolvedScore,
            hasOverride,
            ...bestSnap.metrics,
          },
          bestSnap.metrics
        );
      }
    } else if (bestSnap) {
      // 未关联作品归组列始终取按分组名排序的首组（与改前一致）
      const primaryGroup = obsList[0].group;
      const metaObs = obsList.find((o) => o.fromWorksJson);
      const bestTitle = metaObs
        ? (obsList.find((o) => o.fromWorksJson && o.title) || metaObs).title
        : DELETED_WORK_TITLE;
      const bestUrl = (obsList.find((o) => o.url) || {}).url || "";
      const bestPubMs = pickMinValidPubMs(obsList);

      const bucket = makeBucket(
        `unlinked:${platform}:${workId}`,
        bestTitle,
        "",
        "",
        bestPubMs,
        true,
        false
      );
      addWorkToBucket(
        bucket,
        {
          workKey: pwKey,
          workId,
          group: primaryGroup,
          platform,
          title: bestTitle || "(无标题)",
          url: bestUrl,
          publishDate: bestPubMs !== null ? toUtc8DateStr(bestPubMs) : "",
          matchedBy: resolvedMatchedBy === "manual-detach" ? "manual-detach" : null,
          score: null,
          hasOverride,
          ...bestSnap.metrics,
        },
        bestSnap.metrics
      );
      buckets.set(`unlinked:${pwKey}`, bucket);
    }
  }

  const rows = [];
  for (const b of buckets.values()) {
    // 保证每个平台单元格内 works / workIds 顺序确定（按 workId 升序）
    for (const cell of Object.values(b.perPlatform)) {
      if (Array.isArray(cell.works) && cell.works.length > 1) {
        cell.works.sort((a, bItem) => compareText(a.workId, bItem.workId));
        cell.workIds = cell.works.map((w) => w.workId);
      }
    }
    const hasWorkPub = b.minWorkPublishMs !== null;
    const matchInfo = summarizeBucketMatch(b);
    const row = {
      contentKey: b.contentKey,
      title: b.title,
      file: b.file,
      firstPublishDate: hasWorkPub ? toUtc8DateStr(b.minWorkPublishMs) : b.recordFirstDate,
      firstPublishDateSource: hasWorkPub || b.isUnlinked ? "work" : "record",
      platformCount: b.platforms.size,
      isUnlinked: b.isUnlinked,
      canAssignTarget: b.canAssignTarget,
      matchMethod: matchInfo.matchMethod,
      matchScore: matchInfo.matchScore,
      hasFuzzy: matchInfo.hasFuzzy,
      hasManual: matchInfo.hasManual,
      isManualDetach: matchInfo.isManualDetach,
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
    return compareText(a.contentKey, b.contentKey);
  });
}

module.exports = {
  FUZZY_SIM_THRESHOLD,
  FUZZY_MISSING_TIME_PENALTY,
  FUZZY_MARGIN_MIN,
  FUZZY_MAX_DAY_DIFF,
  FUZZY_SUBSTRING_MIN_LEN,
  FUZZY_SUBSTRING_SCORE,
  FUZZY_MIN_CORE_LEN,
  FUZZY_PLACEHOLDER_TITLES,
  FUZZY_THRESHOLDS,
  normalizeTitle,
  stripTopicsForFuzzy,
  extractCoreTitle,
  isPlaceholderTitle,
  extractSeriesMarkers,
  extractSeriesMarkersFromTitles,
  hasConflictingSeries,
  isValidAutoContentKey,
  isValidManualContentKey,
  isValidSyntheticContentKey,
  isUnstableRecordKey,
  isValidWorkIdentityKey,
  computeTitleSimilarity,
  buildTitleIndex,
  normalizeStatusTitle,
  normalizeUrl,
  isManagementUrl,
  makeWorkKey,
  makeWorkIdentityKey,
  getLinkResultMeta,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
};
