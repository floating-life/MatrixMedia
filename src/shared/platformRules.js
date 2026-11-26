"use strict";

import {
  PLATFORM_ALIASES,
  resolvePublishPlatform,
} from "./publishPlatforms.js";
import {
  sanitizeTitle,
  sanitizeDescription,
  splitAndSanitizeTags,
  splitHashtagTags,
} from "./textSanitize.js";

/**
 * 集中的平台发布规则表（单一真源）。
 *
 * 字数计量口径说明：
 * - 本模块统一使用 `Array.from(str).length` 计字（一个汉字、英文字母、数字、常见 emoji 均计 1，
 *   且截断不拆分 UTF-16 代理对）。
 * - 平台页面计数器口径可能存在差异，以下保守上限已留安全余量：
 *   - 抖音 / 头条 / 百家号 / 小红书：部分页面对英文/数字按 0.5 计，或对部分组合 emoji 按 UTF-16 码元计 2；
 *     按 Array.from 计 1 对中英混排属保守值，不会超出按 0.5 计的上限；含极多复杂 emoji 时请以真机核对为准。
 *   - 抖音 / 快手 / 视频号：#话题 转为话题胶囊后，平台计数器对胶囊字数的计法可能含或不含 `#` 与尾随空格；
 *     本模块按完整 `#标签` + 分隔空格计入 `descMax`，属保守安全口径。
 *
 * 每平台字段：{ titleMax, descMax, tagMax, coverRatios }
 * - titleMax: 标题字数上限（null 表示该平台当前无独立标题输入栏）
 * - descMax: 简介/正文总字数上限（含拼接进去的 #话题；null 表示该平台当前不填简介）
 * - tagMax: 话题/标签个数上限（null 表示不按个数硬裁，仅受 descMax 约束）
 * - coverRatios: 自定义封面支持的比例列表（"3:4" 竖封面、"4:3" 横封面）
 */
export const PLATFORM_RULES = Object.freeze({
  抖音: Object.freeze({
    code: "dy",
    titleMax: 30, // 已确认（抖音作品标题上限 30 字；计数器口径差异：部分组合 emoji 可能计 2，待真机核对）
    descMax: 1000, // 保守值（抖音作品简介含 #话题；待真机核对）
    tagMax: 4, // 代码实测已确认（见 videoMetadata.js：第 5 个起弹「最多添加4个话题」阻断发布；若新版放宽可顺带真机核对）
    coverRatios: Object.freeze(["3:4", "4:3"]),
    usesCombinedDescription: true,
    hasSeparateTitle: true,
    tagsInDescriptionBudget: true,
  }),
  视频号: Object.freeze({
    code: "sph",
    titleMax: null, // 视频号发布页无独立长标题输入栏（短标题 6~16 字单独字段 shortTitle 校验；待真机核对）
    shortTitleMin: 6,
    shortTitleMax: 16,
    descMax: 1000, // 保守值（视频号视频描述含 #话题，常识上限 1000 字；待真机核对）
    tagMax: null, // 不按固定个数硬裁，受 descMax 约束（待真机核对）
    coverRatios: Object.freeze(["3:4", "4:3"]),
    usesCombinedDescription: true,
    hasSeparateTitle: false,
    tagsInDescriptionBudget: true,
  }),
  快手: Object.freeze({
    code: "ks",
    titleMax: null, // 快手无独立标题框，标题与简介、#话题合并写入描述编辑器，受 descMax 统一约束
    descMax: 500, // 保守值（快手作品描述含标题与 #话题，常识上限 500 字；待真机核对）
    tagMax: 4, // 已确认（用户决策 + 代码实测：超过 4 个弹「最多只能添加4个话题」阻断发布，只取前 4 个）
    coverRatios: Object.freeze(["3:4"]),
    usesCombinedDescription: true,
    hasSeparateTitle: false,
    combinesTitleIntoDescription: true,
    tagsInDescriptionBudget: true,
  }),
  百家号: Object.freeze({
    code: "bjh",
    titleMax: null, // 真机 2026-11-25 确认：百家号新版视频页无独立标题框，只有 50 字「作品描述」；「百家号标题」覆盖列作为作品描述第一句
    descMax: 50, // 真机 2026-11-25 确认：作品描述计数器上限 50 字（含拼接进去的标题与 #话题）
    tagMax: null, // 不按固定个数硬裁，受 50 字 descMax 约束（放不下则丢话题）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: true,
    hasSeparateTitle: false,
    combinesTitleIntoDescription: true,
    tagsInDescriptionBudget: true,
  }),
  头条: Object.freeze({
    code: "tt",
    titleMax: 30, // 代码 tt.js:691 placeholder「请输入 0～30 个字符」（计数器全半角口径待真机核对）
    descMax: null, // 当前 tt.js 不填写简介（待真机核对）
    tagMax: null, // 当前 tt.js 不填写标签（待真机核对）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: false,
    hasSeparateTitle: true,
    tagsInDescriptionBudget: false,
  }),
  小红书: Object.freeze({
    code: "xhs",
    titleMax: 20, // 已确认（原 xhs.js 硬截 20 字并入；计数器全半角/emoji 口径待真机核对）
    descMax: 1000, // 保守值（小红书正文含话题上限 1000 字；待真机核对）
    tagMax: null, // 不按固定个数硬裁，受 descMax 约束（待真机核对）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: true,
    hasSeparateTitle: true,
    separateTagInput: true, // 正文与话题分步输入，但共享正文框 1000 字上限
    tagsInDescriptionBudget: true,
  }),
  哔哩哔哩: Object.freeze({
    code: "blbl",
    titleMax: 80, // 保守值（B 站稿件标题常识上限 80 字；待真机核对）
    descMax: 2000, // 保守值（B 站简介常识上限 2000 字，与 GUI textarea maxlength 一致；待真机核对）
    tagMax: 10, // 保守值（B 站独立标签栏常识上限 10 个；待真机核对）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: false,
    hasSeparateTitle: true,
    separateTagInput: true,
    tagsInDescriptionBudget: false, // B 站标签为独立输入框，不占简介字数
  }),
  番茄视频: Object.freeze({
    code: "fqsp",
    titleMax: null, // 当前 fqsp.js 不填写元数据（待真机核对）
    descMax: null, // 当前 fqsp.js 不填写元数据（待真机核对）
    tagMax: null, // 当前 fqsp.js 不填写元数据（待真机核对）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: false,
    hasSeparateTitle: false,
    tagsInDescriptionBudget: false,
  }),
});

/** 扩展平台别名映射（供分平台覆盖入参、xlsx 表头、规则查询共用） */
export const PLATFORM_RULE_ALIASES = Object.freeze({
  ...PLATFORM_ALIASES,
  微信视频号: "视频号",
  shipinhao: "视频号",
  wxvideo: "视频号",
  channels: "视频号",
  b站: "哔哩哔哩",
  B站: "哔哩哔哩",
  bili: "哔哩哔哩",
  baijiahao: "百家号",
  百度百家号: "百家号",
  今日头条: "头条",
  头条号: "头条",
  red: "小红书",
  番茄: "番茄视频",
});

/**
 * 截断标点集合：，。！？、；：,.!?;: 空格 ｜|—（并兼容简介中的换行符 \n）
 */
export const TRUNCATE_PUNCTUATION_CHARS = "，。！？、；：,.!?;: ｜|—";
const TRUNCATE_PUNCTUATION_SET = new Set(
  Array.from(TRUNCATE_PUNCTUATION_CHARS + "\n\t")
);

export function isTruncatePunctuation(ch) {
  return TRUNCATE_PUNCTUATION_SET.has(ch);
}

/** 按 Array.from 计字数（汉字、ASCII、常见 emoji 均计 1） */
export function countChars(text) {
  return Array.from(String(text == null ? "" : text)).length;
}

/** 按码点安全取前 n 字预览（避免切碎 emoji 代理对） */
export function previewText(text, maxChars = 16) {
  const chars = Array.from(String(text == null ? "" : text));
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, maxChars).join("")}…`;
}

/** 将平台代码、中文名或常见别名解析为 canonical 平台中文名；未命中返回空串 */
export function resolvePlatformRuleKey(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (PLATFORM_RULES[trimmed]) return trimmed;
  const lower = trimmed.toLowerCase();
  const mapped =
    PLATFORM_RULE_ALIASES[trimmed] ||
    PLATFORM_RULE_ALIASES[lower] ||
    resolvePublishPlatform(trimmed);
  return PLATFORM_RULES[mapped] ? mapped : "";
}

/** 获取指定平台的规则对象；未知平台返回 null */
export function getPlatformRule(platform) {
  const key = resolvePlatformRuleKey(platform);
  return key ? PLATFORM_RULES[key] : null;
}

/** 平台是否支持双比例封面（竖 3:4 + 横 4:3） */
export function platformSupportsDualCover(platform) {
  const rule = getPlatformRule(platform);
  if (!rule || !Array.isArray(rule.coverRatios)) return false;
  return rule.coverRatios.includes("3:4") && rule.coverRatios.includes("4:3");
}

/**
 * 去掉尾部连续标点/空白（按 TRUNCATE_PUNCTUATION_SET）。
 * @param {string[]} chars
 * @returns {string[]}
 */
function trimTrailingPunctuationChars(chars) {
  let end = chars.length;
  while (end > 0 && isTruncatePunctuation(chars[end - 1])) {
    end -= 1;
  }
  return chars.slice(0, end);
}

/**
 * 按平台规则截断文本（不加省略号）：
 * - 在上限内优先于最后一个标点（，。！？、；：,.!?;: 空格 ｜|—）处截断，
 *   标点后无内容则去掉尾部标点；
 * - 若上限边界紧邻的下一个字符就是标点，则当前前 maxLen 字已落在完整句界，去掉尾部标点即可；
 * - 找不到标点，或按标点截后长度少于上限一半（< maxLen / 2），则硬截至 maxLen 字。
 * - 不加省略号。
 *
 * @param {string} text
 * @param {number|null|undefined} maxLen
 * @returns {{ text: string, truncated: boolean, mode: "none"|"punctuation"|"hard"|"empty", originalLength: number, finalLength: number }}
 */
export function truncateTextByPunctuation(text, maxLen) {
  const raw = String(text == null ? "" : text);
  const chars = Array.from(raw);
  const originalLength = chars.length;
  if (maxLen == null || !Number.isFinite(Number(maxLen))) {
    return {
      text: raw,
      truncated: false,
      mode: "none",
      originalLength,
      finalLength: originalLength,
    };
  }
  const limit = Math.max(0, Math.floor(Number(maxLen)));
  if (limit === 0) {
    return {
      text: "",
      truncated: originalLength > 0,
      mode: originalLength > 0 ? "empty" : "none",
      originalLength,
      finalLength: 0,
    };
  }
  if (originalLength <= limit) {
    return {
      text: raw,
      truncated: false,
      mode: "none",
      originalLength,
      finalLength: originalLength,
    };
  }

  const minPunctLen = limit / 2;
  const within = chars.slice(0, limit);

  // 恰好停在标点前（第 limit+1 个字符本身是标点）：直接视为标点句界截断
  if (isTruncatePunctuation(chars[limit])) {
    const trimmed = trimTrailingPunctuationChars(within);
    if (trimmed.length >= minPunctLen) {
      return {
        text: trimmed.join(""),
        truncated: true,
        mode: "punctuation",
        originalLength,
        finalLength: trimmed.length,
      };
    }
  }

  // 在上限内找最后一个标点
  let lastPunctIdx = -1;
  for (let i = within.length - 1; i >= 0; i--) {
    if (isTruncatePunctuation(within[i])) {
      lastPunctIdx = i;
      break;
    }
  }

  if (lastPunctIdx >= 0) {
    const candidate = trimTrailingPunctuationChars(within.slice(0, lastPunctIdx));
    if (candidate.length >= minPunctLen) {
      return {
        text: candidate.join(""),
        truncated: true,
        mode: "punctuation",
        originalLength,
        finalLength: candidate.length,
      };
    }
  }

  // 找不到标点或按标点截后少于上限一半 → 硬截，不加省略号
  return {
    text: within.join(""),
    truncated: true,
    mode: "hard",
    originalLength,
    finalLength: within.length,
  };
}

/**
 * 话题词终止字符集合：空白、下一个 `#`、中英文标点与常见分隔符。
 * 涵盖 ，。！？、；：,.!?;:「」『』“”‘’'"（）()【】[]{}〔〕《》〈〉〖〗｛｝…—–―｜|/\~～·•・@＠<>
 */
const HASHTAG_STOP_CLASS =
  "\\s#，。！？、；：,.!?;:「」『』“”‘’'\"（）()【】\\[\\]{}〔〕《》〈〉〖〗｛｝…—–―｜|/\\\\~～·•・@＠<>";
const INLINE_HASHTAG_RE = new RegExp(
  `#(?!\\uFE0F?\\u20E3)([^${HASHTAG_STOP_CLASS}]+)(?:\\[话题\\]#)?`,
  "g"
);
const HASHTAG_STOP_CHAR_RE = new RegExp(`[${HASHTAG_STOP_CLASS}]`);
const LEADING_ORPHAN_SEP_RE = /^[ \t]*[,，、；;：:。！？.!?]+[ \t]*/;
const TRAILING_SEP_CHAR_RE = /[,，、；;：:。！？.!?]$/;
const LEADING_JOIN_PUNCT_RE = /^[，。！？、；：,.!?;:）」』”’】\]）)》〉〕〗｝}]/;

function joinBodyChunks(left, right) {
  if (!right) return left;
  if (!left) return right;
  let l = left;
  let r = right;

  // 若移除话题前是孤立 `#`（如 `a##b[话题]#c`）且后文首字非终止符，插空格防止粘连成新话题
  if (l.endsWith("#") && !HASHTAG_STOP_CHAR_RE.test(r[0])) {
    return `${l} ${r}`;
  }
  // 移除话题后左侧尾随水平空格紧邻标点（如 `探店记录 #美食，环境很好` → `探店记录，环境很好`）
  if (/[ \t]+$/.test(l) && LEADING_JOIN_PUNCT_RE.test(r)) {
    l = l.replace(/[ \t]+$/, "");
  }
  // 左侧已以分隔标点收尾且右侧紧跟孤立逗号/顿号/分号（如 `今天练腿，#减脂，深蹲`）
  if (TRAILING_SEP_CHAR_RE.test(l) && /^[,，、；;]/.test(r)) {
    r = r.replace(/^[,，、；;]+/, "");
  }
  return `${l}${r}`;
}

/**
 * 从简介正文中拆出内联 #话题：
 * - `#` 出现在任意位置都视为话题起点（支持 `。#减脂`、`正文#话题`、`#减脂#健身#干货` 连写）；
 * - 话题词在遇到空白、下一个 `#` 或中英文标点时结束；
 * - 兼容平台话题胶囊式写法 `#话题[话题]#`；
 * - 空话题（单独 `#` 或 `#` 后紧跟空白/标点/`#`）不算话题。
 *
 * @param {string} description
 * @returns {{ body: string, inlineTags: string[] }}
 */
export function extractInlineHashtags(description) {
  const src = String(description == null ? "" : description);
  if (!src || !src.includes("#")) {
    return { body: src, inlineTags: [] };
  }

  const matches = [];
  INLINE_HASHTAG_RE.lastIndex = 0;
  let m;
  while ((m = INLINE_HASHTAG_RE.exec(src)) !== null) {
    const tagBody = String(m[1] || "").trim();
    if (!tagBody) continue;
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      tag: tagBody,
    });
  }

  if (matches.length === 0) {
    return { body: src, inlineTags: [] };
  }

  const inlineTags = [];
  const seen = new Set();
  for (const item of matches) {
    if (!seen.has(item.tag)) {
      seen.add(item.tag);
      inlineTags.push(item.tag);
    }
  }

  let out = "";
  let cursor = 0;
  let removedAtStart = false;

  for (const item of matches) {
    const leftChunk = src.slice(cursor, item.start);
    if (cursor === 0) {
      if (leftChunk.trim() === "") {
        removedAtStart = true;
      }
      out += leftChunk;
    } else {
      let piece = leftChunk;
      if (removedAtStart && out.trim() === "") {
        piece = piece.replace(LEADING_ORPHAN_SEP_RE, "");
      }
      out = joinBodyChunks(out, piece);
    }
    cursor = item.end;
  }

  let tail = src.slice(cursor);
  if (removedAtStart && out.trim() === "") {
    tail = tail.replace(LEADING_ORPHAN_SEP_RE, "");
  }
  out = joinBodyChunks(out, tail);

  const body = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { body, inlineTags };
}

/**
 * 正文最小保底字数：只要原文含正文，截断或话题保留绝不能把正文挤成空串。
 * - bodyLen === 0 → 0
 * - bodyLen > 0   → min(bodyLen, max(1, floor(descLimit * 0.1)))
 */
function calcMinBodyReserve(bodyLen, descLimit) {
  if (bodyLen <= 0 || descLimit == null || descLimit <= 0) return 0;
  return Math.min(bodyLen, Math.max(1, Math.floor(descLimit * 0.1)));
}

/**
 * 按顺序筛选话题标签：
 * - 单个或累计长度超出 maxTagsBudget（含 `#` 与分隔空格）的话题丢弃，不吞正文且不误伤其后的短话题；
 * - 超出 tagMax 个数上限的话题丢弃。
 */
function selectTagsWithinBudget(
  allTagNames,
  { tagMax = null, maxTagsBudget = null } = {}
) {
  const kept = [];
  const droppedByLength = [];
  const droppedByLimit = [];
  let usedLen = 0;

  for (const tag of allTagNames) {
    if (tagMax != null && kept.length >= tagMax) {
      droppedByLimit.push(tag);
      continue;
    }
    const tagLen = 1 + countChars(tag);
    const nextLen = kept.length === 0 ? tagLen : usedLen + 1 + tagLen;
    if (maxTagsBudget != null && nextLen > maxTagsBudget) {
      droppedByLength.push(tag);
      continue;
    }
    kept.push(tag);
    usedLen = nextLen;
  }

  return { kept, droppedByLength, droppedByLimit, usedLen };
}

/**
 * 生成已处理文案的快照标记，供上游（publishVideo / CLI / GUI）附到任务 payload 上，
 * 让上传器（buildPlatformVideoTextDetailed）识别已处理过的文本、避免重复解析与二次变更。
 *
 * @param {object|null|undefined} ruled applyPlatformPublishRules 返回值
 */
export function createAppliedRuleSnapshot(ruled) {
  if (!ruled || typeof ruled !== "object") return null;
  const bodyDesc =
    ruled.bodyDescription !== undefined
      ? String(ruled.bodyDescription)
      : String(ruled.description || "");
  const combinedDesc =
    ruled.combinedDescription !== undefined
      ? String(ruled.combinedDescription)
      : bodyDesc;
  const ksFill =
    ruled.ksFillText !== undefined ? String(ruled.ksFillText) : combinedDesc;
  return {
    platform: String(ruled.platform || ""),
    title: String(ruled.title || ""),
    description: bodyDesc,
    bodyDescription: bodyDesc,
    combinedDescription: combinedDesc,
    ksFillText: ksFill,
    shortTitle: String(ruled.shortTitle || ""),
    tags: Array.isArray(ruled.tags) ? ruled.tags.slice() : [],
    tagsText: String(ruled.tagsText || ""),
  };
}

/**
 * 归一化分平台文本映射（titleByPlatform / descByPlatform），
 * 支持平台短码（dy/bjh/ks/...）、canonical 中文名与常见别名（B站/今日头条/微信视频号等）。
 * 同平台既有 canonical 中文名又有别名时，canonical 中文名优先。
 *
 * @param {unknown} rawMap
 * @param {"title"|"description"} kind
 * @returns {Record<string, string>}
 */
export function normalizePlatformTextMap(rawMap, kind = "title") {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return {};
  }
  const clean = kind === "description" ? sanitizeDescription : sanitizeTitle;
  const canonicalOut = {};
  const aliasOut = {};
  for (const [rawKey, rawVal] of Object.entries(rawMap)) {
    if (rawVal == null) continue;
    const keyTrimmed = String(rawKey || "").trim();
    const canonical = resolvePlatformRuleKey(keyTrimmed);
    if (!canonical) continue;
    const cleaned = clean(rawVal);
    if (!cleaned) continue;
    if (keyTrimmed === canonical) {
      canonicalOut[canonical] = cleaned;
    } else if (!aliasOut[canonical]) {
      aliasOut[canonical] = cleaned;
    }
  }
  return { ...aliasOut, ...canonicalOut };
}

/**
 * 从分平台映射中按平台取覆盖文本（空串视为未覆盖）。
 *
 * @param {Record<string, unknown>|null|undefined} rawMap
 * @param {string} platform
 * @param {"title"|"description"} [kind]
 * @returns {string}
 */
export function resolvePlatformOverrideValue(rawMap, platform, kind = "title") {
  const canonical = resolvePlatformRuleKey(platform);
  if (!canonical) return "";
  const normalized = normalizePlatformTextMap(rawMap, kind);
  return normalized[canonical] || "";
}

function collapseText(t) {
  return String(t || "").replace(/\s+/g, "");
}

function dedupeTagList(lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** 百家号作品描述首句（标题）与正文拼接：标题末尾或正文开头已有标点时不重复加「，」 */
function joinBjhTitleAndBody(titleText, bodyText) {
  const t = String(titleText || "").trim();
  const b = String(bodyText || "").trim();
  if (!t) return b;
  if (!b) return t;
  if (collapseText(b).startsWith(collapseText(t))) return b;
  const sep =
    /[，。！？、；：,.!?;:]$/.test(t) || /^[，。！？、；：,.!?;:]/.test(b)
      ? ""
      : "，";
  return `${t}${sep}${b}`;
}

/** 百家号作品描述按上限截断，并保证 ≤ 上限的标题部分始终完整保留 */
function truncateBjhTextPreservingTitle(fullText, titleText, descLimit) {
  const origLen = countChars(fullText);
  if (descLimit == null || origLen <= descLimit) {
    return {
      text: fullText,
      truncated: false,
      originalLength: origLen,
      finalLength: origLen,
    };
  }
  const t = String(titleText || "");
  const tLen = countChars(t);
  if (!t || !fullText.startsWith(t)) {
    return truncateTextByPunctuation(fullText, descLimit);
  }
  if (tLen >= descLimit) {
    return {
      text: t,
      truncated: true,
      originalLength: origLen,
      finalLength: tLen,
    };
  }
  const res = truncateTextByPunctuation(fullText, descLimit);
  if (res.text.startsWith(t)) {
    return res;
  }
  // 标点截断落在了标题内部或裁掉了标题末尾标点 → 完整保留标题
  if (tLen >= descLimit / 2) {
    return {
      text: t,
      truncated: true,
      originalLength: origLen,
      finalLength: tLen,
    };
  }
  const hard = Array.from(fullText).slice(0, descLimit).join("");
  return {
    text: hard,
    truncated: true,
    originalLength: origLen,
    finalLength: countChars(hard),
  };
}

function makeAdjustment({
  platform,
  field,
  action,
  limit,
  originalLength,
  finalLength,
  originalPreview,
  finalPreview,
  droppedTags,
  reason,
}) {
  const fieldLabel =
    field === "title"
      ? "标题"
      : field === "description"
      ? "简介"
      : field === "tags"
      ? "话题/标签"
      : field;
  let message = "";
  if (field === "tags") {
    const droppedText =
      Array.isArray(droppedTags) && droppedTags.length
        ? `，已移除：${droppedTags.join(" ")}`
        : "";
    const reasonText = reason ? `（${reason}）` : `（上限 ${limit} 个）`;
    message = `[${platform}] ${fieldLabel}裁剪：${originalLength}→${finalLength} 个${reasonText}${droppedText}`;
  } else {
    message = `[${platform}] ${fieldLabel}截断：${originalLength}→${finalLength} 字（上限 ${limit}）「${originalPreview}」→「${finalPreview}」`;
  }
  return {
    platform,
    field,
    action,
    limit,
    originalLength,
    finalLength,
    ...(originalPreview !== undefined ? { originalPreview } : {}),
    ...(finalPreview !== undefined ? { finalPreview } : {}),
    ...(Array.isArray(droppedTags) && droppedTags.length ? { droppedTags } : {}),
    ...(reason ? { reason } : {}),
    message,
  };
}

/** 将调整项数组拼成一行可读摘要 */
export function formatRuleAdjustmentsSummary(adjustments) {
  if (!Array.isArray(adjustments) || adjustments.length === 0) return "";
  return adjustments.map((a) => a.message).filter(Boolean).join("；");
}

/**
 * 合并上游与当前步骤的调整记录（按 platform+field 去重，保留首次记录的原始长度）
 */
export function mergeRuleAdjustments(prevList, nextList) {
  const out = [];
  const seen = new Set();
  for (const list of [prevList, nextList]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const key = `${item.platform || ""}|${item.field || ""}|${item.originalLength}|${item.finalLength}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * 发布前按平台规则处理文案（分平台覆盖 → 标题截断 → 标签裁剪 → 简介截断保标签）。
 *
 * 纯函数（除 options.log === true 时输出 console.warn 外无副作用），幂等：
 * 对已处理结果再次调用不会二次截断。
 *
 * @param {string} platform 平台名或别名
 * @param {object} [input]
 * @param {string} [input.title]
 * @param {string} [input.description]
 * @param {string} [input.shortTitle]
 * @param {string|string[]} [input.tags]
 * @param {Record<string, string>} [input.titleByPlatform]
 * @param {Record<string, string>} [input.descByPlatform]
 * @param {{ log?: boolean }} [options]
 */
export function applyPlatformPublishRules(platform, input = {}, options = {}) {
  const canonical = resolvePlatformRuleKey(platform) || String(platform || "").trim();
  const rule = getPlatformRule(canonical);
  const logEnabled = Boolean(options && options.log);

  // 1. 分平台覆盖优先级：分平台覆盖 > 通用标题/简介
  const baseTitle = sanitizeTitle(input.title ?? input.bt1 ?? "");
  const overrideTitle = resolvePlatformOverrideValue(
    input.titleByPlatform,
    canonical,
    "title"
  );
  let title = overrideTitle || baseTitle;

  const baseDesc = sanitizeDescription(input.description ?? input.bdText ?? "");
  const overrideDesc = resolvePlatformOverrideValue(
    input.descByPlatform,
    canonical,
    "description"
  );
  const hasBjhDescOverride =
    canonical === "百家号" &&
    (Boolean(overrideDesc) ||
      Boolean(input && input.descOverrideApplied === true));
  const effectiveOverrideDesc =
    overrideDesc || (hasBjhDescOverride ? baseDesc : "");
  let description = overrideDesc || baseDesc;

  const shortTitle =
    canonical === "视频号"
      ? sanitizeTitle(input.shortTitle ?? input.bt2Filled ?? "")
      : "";

  const isHashtagPlatform = Boolean(rule && rule.usesCombinedDescription);
  const rawTagsInput = input.tags !== undefined ? input.tags : input.bq;
  const initialTags = isHashtagPlatform
    ? splitHashtagTags(rawTagsInput)
    : splitAndSanitizeTags(rawTagsInput);

  if (!rule) {
    const tagsText = initialTags.join(" ");
    return {
      platform: canonical,
      rule: null,
      title,
      description,
      bodyDescription: description,
      combinedDescription: description,
      ksFillText: description,
      shortTitle,
      tags: initialTags,
      tagsText,
      adjusted: false,
      adjustments: [],
      summary: "",
    };
  }

  const adjustments = [];
  const tagPrefix = canonical === "哔哩哔哩" ? "" : "#";

  // 2. 标题截断（存在 titleMax 时）
  if (rule.titleMax != null && title) {
    const titleRes = truncateTextByPunctuation(title, rule.titleMax);
    if (titleRes.truncated) {
      adjustments.push(
        makeAdjustment({
          platform: canonical,
          field: "title",
          action: "truncate",
          limit: rule.titleMax,
          originalLength: titleRes.originalLength,
          finalLength: titleRes.finalLength,
          originalPreview: previewText(title, 18),
          finalPreview: previewText(titleRes.text, 18),
        })
      );
      title = titleRes.text;
    }
  }

  // 3. 标签个数裁剪（tagMax）与简介字数截断（descMax）
  let keptTags = initialTags.slice();
  let bodyDescription = description;
  let combinedDescription = description;
  let ksFillText = description;

  if (canonical === "百家号") {
    // 百家号新版视频发布页无独立标题框，只有 50 字「作品描述」：
    // 1) 若填了「百家号简介」覆盖（descByPlatform）→ 直接用它（不拼标题）；
    // 2) 否则 = 百家号标题（覆盖或通用标题）+ 「，」+ 通用简介正文，整体按 50 字用标点截断规则截
    //    （标题必须完整保留；标题自身超 50 则只截标题）；
    // 3) 话题按 S17 规则识别，仅在 50 字内放得下时保留，放不下就丢话题。
    const descLimit = rule.descMax;
    const formatTagsStr = (list) => list.map((t) => `#${t}`).join(" ");

    if (hasBjhDescOverride) {
      const extracted = extractInlineHashtags(effectiveOverrideDesc);
      const inlineSet = new Set(extracted.inlineTags);
      const allTagNames = dedupeTagList([extracted.inlineTags, keptTags]);
      const extraTagsNatural = allTagNames.filter((t) => !inlineSet.has(t));
      const extraTagsNaturalStr = formatTagsStr(extraTagsNatural);
      const naturalCombined = [effectiveOverrideDesc, extraTagsNaturalStr]
        .filter(Boolean)
        .join(" ");

      if (descLimit == null || countChars(naturalCombined) <= descLimit) {
        bodyDescription = effectiveOverrideDesc;
        keptTags = allTagNames;
        combinedDescription = naturalCombined;
      } else if (countChars(effectiveOverrideDesc) <= descLimit) {
        // 覆盖简介本身 ≤ 50：完整保留覆盖简介，仅追加 50 字内放得下的外部话题
        const remaining = effectiveOverrideDesc
          ? Math.max(0, descLimit - countChars(effectiveOverrideDesc) - 1)
          : descLimit;
        const { kept: keptExtra, droppedByLength } = selectTagsWithinBudget(
          extraTagsNatural,
          { tagMax: rule.tagMax, maxTagsBudget: remaining }
        );
        bodyDescription = effectiveOverrideDesc;
        keptTags = dedupeTagList([extracted.inlineTags, keptExtra]);
        combinedDescription = [effectiveOverrideDesc, formatTagsStr(keptExtra)]
          .filter(Boolean)
          .join(" ");
        if (droppedByLength.length > 0) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "tags",
              action: "trim_tags",
              limit: descLimit,
              originalLength: allTagNames.length,
              finalLength: keptTags.length,
              droppedTags: droppedByLength,
              reason: `标签总长超出简介上限 ${descLimit} 字`,
            })
          );
        }
      } else {
        // 覆盖简介本身 > 50：剥离内联话题后按标点截断正文至 ≤ 50，剩余空间放得下的话题才保留
        const bodySource = extracted.body;
        const bodyRes = truncateTextByPunctuation(bodySource, descLimit);
        const remaining = bodyRes.text
          ? Math.max(0, descLimit - countChars(bodyRes.text) - 1)
          : descLimit;
        const { kept: workingTags, droppedByLength } = selectTagsWithinBudget(
          allTagNames,
          { tagMax: rule.tagMax, maxTagsBudget: remaining }
        );
        bodyDescription = bodyRes.text;
        keptTags = workingTags;
        combinedDescription = [bodyDescription, formatTagsStr(workingTags)]
          .filter(Boolean)
          .join(" ");
        if (droppedByLength.length > 0) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "tags",
              action: "trim_tags",
              limit: descLimit,
              originalLength: allTagNames.length,
              finalLength: keptTags.length,
              droppedTags: droppedByLength,
              reason: `标签总长超出简介上限 ${descLimit} 字`,
            })
          );
        }
        if (bodyRes.truncated) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "description",
              action: "truncate",
              limit: descLimit,
              originalLength: countChars(effectiveOverrideDesc),
              finalLength: countChars(combinedDescription),
              originalPreview: previewText(effectiveOverrideDesc, 18),
              finalPreview: previewText(combinedDescription, 18),
            })
          );
        }
      }
      // 发布记录/账本标题保持用户标题（分平台标题覆盖 > 通用标题 > 现有回退），
      // 作品描述只作为写入页面文本，绝不覆盖 title，确保各入口 7 天查重与账本一致
      ksFillText = combinedDescription;
    } else if (descLimit != null && title && countChars(title) > descLimit) {
      // 标题自身超 50：只截标题（不拼通用简介正文），剩余空间放得下的话题才保留
      const descExtracted = extractInlineHashtags(baseDesc);
      const origTitle = title;
      const origNatural = joinBjhTitleAndBody(origTitle, baseDesc);
      const titleRes = truncateTextByPunctuation(origTitle, descLimit);
      title = titleRes.text;

      const titleInlineTags = extractInlineHashtags(title).inlineTags;
      const titleInlineSet = new Set(titleInlineTags);
      const allTagNames = dedupeTagList([
        titleInlineTags,
        descExtracted.inlineTags,
        keptTags,
      ]);
      const extraCandidates = allTagNames.filter(
        (t) => !titleInlineSet.has(t)
      );
      const remaining = title
        ? Math.max(0, descLimit - countChars(title) - 1)
        : descLimit;
      const { kept: keptExtra, droppedByLength } = selectTagsWithinBudget(
        extraCandidates,
        { tagMax: rule.tagMax, maxTagsBudget: remaining }
      );
      bodyDescription = title;
      keptTags = dedupeTagList([titleInlineTags, keptExtra]);
      combinedDescription = [bodyDescription, formatTagsStr(keptExtra)]
        .filter(Boolean)
        .join(" ");
      ksFillText = combinedDescription;

      adjustments.push(
        makeAdjustment({
          platform: canonical,
          field: "description",
          action: "truncate",
          limit: descLimit,
          originalLength: countChars(origNatural),
          finalLength: countChars(combinedDescription),
          originalPreview: previewText(origNatural, 18),
          finalPreview: previewText(combinedDescription, 18),
        })
      );
      if (droppedByLength.length > 0) {
        adjustments.push(
          makeAdjustment({
            platform: canonical,
            field: "tags",
            action: "trim_tags",
            limit: descLimit,
            originalLength: allTagNames.length,
            finalLength: keptTags.length,
            droppedTags: droppedByLength,
            reason: `标签总长超出简介上限 ${descLimit} 字`,
          })
        );
      }
    } else {
      // 标题 ≤ 50（或无标题）：标题 + 「，」 + 通用简介正文，整体按 50 字截断且完整保留标题
      const naturalBody = joinBjhTitleAndBody(title, baseDesc);
      const naturalInlineTags = extractInlineHashtags(naturalBody).inlineTags;
      const naturalInlineSet = new Set(naturalInlineTags);
      const allTagNamesNatural = dedupeTagList([naturalInlineTags, keptTags]);
      const extraTagsNatural = allTagNamesNatural.filter(
        (t) => !naturalInlineSet.has(t)
      );
      const naturalCombined = [naturalBody, formatTagsStr(extraTagsNatural)]
        .filter(Boolean)
        .join(" ");

      if (descLimit == null || countChars(naturalCombined) <= descLimit) {
        bodyDescription = naturalBody;
        keptTags = allTagNamesNatural;
        combinedDescription = naturalCombined;
      } else if (countChars(naturalBody) <= descLimit) {
        // 组装文本本身 ≤ 50：保持正文与内联话题完整，仅追加 50 字内放得下的外部话题
        const remaining = naturalBody
          ? Math.max(0, descLimit - countChars(naturalBody) - 1)
          : descLimit;
        const { kept: keptExtra, droppedByLength } = selectTagsWithinBudget(
          extraTagsNatural,
          { tagMax: rule.tagMax, maxTagsBudget: remaining }
        );
        bodyDescription = naturalBody;
        keptTags = dedupeTagList([naturalInlineTags, keptExtra]);
        combinedDescription = [naturalBody, formatTagsStr(keptExtra)]
          .filter(Boolean)
          .join(" ");
        if (droppedByLength.length > 0) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "tags",
              action: "trim_tags",
              limit: descLimit,
              originalLength: allTagNamesNatural.length,
              finalLength: keptTags.length,
              droppedTags: droppedByLength,
              reason: `标签总长超出简介上限 ${descLimit} 字`,
            })
          );
        }
      } else {
        // 组装文本本身 > 50：只剥离简介部分的内联话题（不改动标题），按 50 字截断并完整保留标题，剩余空间放话题
        const titleInlineTags = extractInlineHashtags(title).inlineTags;
        const titleInlineSet = new Set(titleInlineTags);
        let descBodyClean = "";
        let descInlineTags = [];
        if (title && baseDesc && baseDesc.startsWith(title)) {
          const tailExt = extractInlineHashtags(baseDesc.slice(title.length));
          const cleanTail = tailExt.body.replace(
            /^[，。！？、；：,.!?;:\s]+$/,
            ""
          );
          descBodyClean = joinBjhTitleAndBody(title, cleanTail);
          descInlineTags = tailExt.inlineTags;
        } else {
          const descExt = extractInlineHashtags(baseDesc);
          descBodyClean = joinBjhTitleAndBody(title, descExt.body);
          descInlineTags = descExt.inlineTags;
        }
        const allTagNames = dedupeTagList([
          titleInlineTags,
          descInlineTags,
          keptTags,
        ]);
        const extraCandidates = allTagNames.filter(
          (t) => !titleInlineSet.has(t)
        );
        const truncRes = truncateBjhTextPreservingTitle(
          descBodyClean,
          title,
          descLimit
        );
        const bodyFinal = truncRes.text;
        const remaining = bodyFinal
          ? Math.max(0, descLimit - countChars(bodyFinal) - 1)
          : descLimit;
        const { kept: keptExtra, droppedByLength } = selectTagsWithinBudget(
          extraCandidates,
          { tagMax: rule.tagMax, maxTagsBudget: remaining }
        );
        bodyDescription = bodyFinal;
        keptTags = dedupeTagList([titleInlineTags, keptExtra]);
        combinedDescription = [bodyDescription, formatTagsStr(keptExtra)]
          .filter(Boolean)
          .join(" ");

        if (
          title &&
          bodyDescription &&
          !collapseText(bodyDescription).startsWith(collapseText(title))
        ) {
          title = sanitizeTitle(bodyDescription);
        }

        if (droppedByLength.length > 0) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "tags",
              action: "trim_tags",
              limit: descLimit,
              originalLength: allTagNames.length,
              finalLength: keptTags.length,
              droppedTags: droppedByLength,
              reason: `标签总长超出简介上限 ${descLimit} 字`,
            })
          );
        }
        if (truncRes.truncated) {
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "description",
              action: "truncate",
              limit: descLimit,
              originalLength: countChars(naturalBody),
              finalLength: countChars(combinedDescription),
              originalPreview: previewText(naturalBody, 18),
              finalPreview: previewText(combinedDescription, 18),
            })
          );
        }
      }
      ksFillText = combinedDescription;
    }
  } else if (rule.tagsInDescriptionBudget) {
    // 抖音 / 视频号 / 快手 / 小红书：#话题 与正文共享简介/描述上限
    // 检查简介内嵌 #话题（如用户在正文里手写了 #xxx）
    const extracted = extractInlineHashtags(description);
    const inlineSet = new Set(extracted.inlineTags);

    // 合并所有待保留的标签（去重保序）：先内联 #xxx 再独立 tags
    const allTagNames = [];
    const seenTag = new Set();
    for (const t of [...extracted.inlineTags, ...keptTags]) {
      if (!t || seenTag.has(t)) continue;
      seenTag.add(t);
      allTagNames.push(t);
    }

    const totalOriginalTagCount = allTagNames.length;
    const formatTagsStr = (list) => list.map((t) => `#${t}`).join(" ");
    const tagSep = canonical === "小红书" ? "\n" : " ";

    const ksTitleAlreadyInDesc =
      rule.combinesTitleIntoDescription &&
      Boolean(title) &&
      Boolean(description) &&
      collapseText(description).startsWith(collapseText(title));

    const extraTagsNatural = allTagNames.filter((t) => !inlineSet.has(t));
    const extraTagsNaturalStr = formatTagsStr(extraTagsNatural);
    const naturalCombined = [description, extraTagsNaturalStr]
      .filter(Boolean)
      .join(" ");

    const naturalTotalLen = (() => {
      if (canonical === "小红书") {
        const bodyLen = countChars(description);
        const tagsLen = countChars(extraTagsNaturalStr);
        return bodyLen + (bodyLen > 0 && tagsLen > 0 ? 1 : 0) + tagsLen;
      }
      if (rule.combinesTitleIntoDescription && title && !ksTitleAlreadyInDesc) {
        const combLen = countChars(naturalCombined);
        return countChars(title) + (combLen > 0 ? 1 : 0) + combLen;
      }
      return countChars(naturalCombined);
    })();

    const exceedsTagMax =
      rule.tagMax != null && allTagNames.length > rule.tagMax;
    const exceedsDescMax =
      rule.descMax != null && naturalTotalLen > rule.descMax;

    let ksTitleIncluded = ksTitleAlreadyInDesc;

    if (!exceedsDescMax && !exceedsTagMax) {
      // 未超字数且未超标签数：保持原文与内联话题位置完全不动
      if (canonical === "小红书") {
        bodyDescription = description;
        keptTags = extraTagsNatural;
        combinedDescription = naturalCombined;
      } else {
        bodyDescription = description;
        keptTags = allTagNames;
        combinedDescription = naturalCombined;
      }
    } else {
      // 需要裁标签或截正文：所有话题标签（内联 + 追加）集中优先保留在尾部，只截正文；
      // 且单个/累计话题过长时丢弃超长话题而不是吞掉正文，任何情况下有正文时绝不清空正文。
      const descLimit = rule.descMax;
      const bodySource = extracted.body;
      const bodyLen = countChars(bodySource);

      const ksTitleAlreadyInBody =
        rule.combinesTitleIntoDescription &&
        Boolean(title) &&
        Boolean(bodySource) &&
        collapseText(bodySource).startsWith(collapseText(title));
      ksTitleIncluded = ksTitleAlreadyInBody;

      const hasKsTitlePrefix =
        rule.combinesTitleIntoDescription &&
        Boolean(title) &&
        !ksTitleAlreadyInBody;

      const minBodyReserve = calcMinBodyReserve(bodyLen, descLimit);
      const titleReserve =
        descLimit != null && hasKsTitlePrefix
          ? Math.min(countChars(title), Math.floor(descLimit * 0.5)) + 1
          : 0;
      const maxTagsBudget =
        descLimit != null
          ? Math.max(
              0,
              descLimit - titleReserve - minBodyReserve - (bodyLen > 0 ? 1 : 0)
            )
          : null;

      const {
        kept: workingTags,
        droppedByLength,
        droppedByLimit,
      } = selectTagsWithinBudget(allTagNames, {
        tagMax: rule.tagMax,
        maxTagsBudget,
      });

      const allDropped = [...droppedByLength, ...droppedByLimit];
      if (allDropped.length > 0) {
        const reason =
          droppedByLength.length > 0 && droppedByLimit.length > 0
            ? `超出标签上限 ${rule.tagMax} 个且超出简介上限 ${descLimit} 字`
            : droppedByLength.length > 0
            ? `标签总长超出简介上限 ${descLimit} 字`
            : `上限 ${rule.tagMax} 个`;
        adjustments.push(
          makeAdjustment({
            platform: canonical,
            field: "tags",
            action: "trim_tags",
            limit: rule.tagMax != null ? rule.tagMax : descLimit,
            originalLength: totalOriginalTagCount,
            finalLength: workingTags.length,
            droppedTags: allDropped,
            reason,
          })
        );
      }

      const finalTagsStr = formatTagsStr(workingTags);
      const finalTagsLen = countChars(finalTagsStr);
      keptTags = workingTags;

      if (descLimit != null) {
        // 为标签预留长度（若有正文或有快手独立标题前缀，且有标签，留 1 个分隔符）
        const totalAvailForText =
          finalTagsLen > 0
            ? bodyLen > 0 || hasKsTitlePrefix
              ? Math.max(0, descLimit - finalTagsLen - 1)
              : 0
            : descLimit;

        if (hasKsTitlePrefix) {
          // 快手把 title + "\n" + body + " " + tags 合并进同一编辑器
          if (bodyLen === 0) {
            const origTitleLen = countChars(title);
            if (origTitleLen > totalAvailForText) {
              const titleTrunc = truncateTextByPunctuation(
                title,
                totalAvailForText
              );
              if (titleTrunc.truncated) {
                adjustments.push(
                  makeAdjustment({
                    platform: canonical,
                    field: "title",
                    action: "truncate",
                    limit: totalAvailForText,
                    originalLength: titleTrunc.originalLength,
                    finalLength: titleTrunc.finalLength,
                    originalPreview: previewText(title, 18),
                    finalPreview: previewText(titleTrunc.text, 18),
                  })
                );
                title = titleTrunc.text;
              }
            }
            bodyDescription = "";
          } else {
            // 有正文时为正文保留至少 minBodyReserve + 1(\n)，绝不因标题过长把正文清空只剩标题
            const maxTitleForKs = Math.max(
              0,
              totalAvailForText - minBodyReserve - 1
            );
            if (countChars(title) > maxTitleForKs) {
              const titleTrunc = truncateTextByPunctuation(
                title,
                maxTitleForKs
              );
              if (titleTrunc.truncated) {
                adjustments.push(
                  makeAdjustment({
                    platform: canonical,
                    field: "title",
                    action: "truncate",
                    limit: maxTitleForKs,
                    originalLength: titleTrunc.originalLength,
                    finalLength: titleTrunc.finalLength,
                    originalPreview: previewText(title, 18),
                    finalPreview: previewText(titleTrunc.text, 18),
                  })
                );
                title = titleTrunc.text;
              }
            }
            const curTitleLen = countChars(title);
            const bodyBudget = Math.max(
              0,
              totalAvailForText - curTitleLen - (curTitleLen > 0 ? 1 : 0)
            );
            const bodyRes = truncateTextByPunctuation(bodySource, bodyBudget);
            if (bodyRes.truncated) {
              adjustments.push(
                makeAdjustment({
                  platform: canonical,
                  field: "description",
                  action: "truncate",
                  limit: descLimit,
                  originalLength: countChars(
                    [title, bodySource, finalTagsStr].filter(Boolean).join(" ")
                  ),
                  finalLength: countChars(
                    [title, bodyRes.text, finalTagsStr].filter(Boolean).join(" ")
                  ),
                  originalPreview: previewText(bodySource, 18),
                  finalPreview: previewText(bodyRes.text, 18),
                })
              );
            }
            bodyDescription = bodyRes.text;
          }
        } else {
          // 抖音 / 视频号 / 小红书 / 快手(无独立标题前缀或标题已在正文开头)
          const bodyRes = truncateTextByPunctuation(
            bodySource,
            totalAvailForText
          );
          if (bodyRes.truncated) {
            const sepLen = bodySource && finalTagsLen > 0 ? countChars(tagSep) : 0;
            const newSepLen =
              bodyRes.text && finalTagsLen > 0 ? countChars(tagSep) : 0;
            adjustments.push(
              makeAdjustment({
                platform: canonical,
                field: "description",
                action: "truncate",
                limit: descLimit,
                originalLength: countChars(bodySource) + sepLen + finalTagsLen,
                finalLength: bodyRes.finalLength + newSepLen + finalTagsLen,
                originalPreview: previewText(bodySource, 18),
                finalPreview: previewText(bodyRes.text, 18),
              })
            );
          }
          bodyDescription = bodyRes.text;

          // 快手标题原在正文开头：若正文截得比标题更短，同步收窄标题，保持二次调用幂等
          if (
            ksTitleAlreadyInBody &&
            title &&
            bodyDescription &&
            !collapseText(bodyDescription).startsWith(collapseText(title))
          ) {
            title = bodyDescription;
          }
        }
      } else {
        bodyDescription = bodySource;
      }

      combinedDescription = [bodyDescription, finalTagsStr]
        .filter(Boolean)
        .join(" ");
    }

    // 计算快手最终写入编辑器的完整文本
    if (rule.combinesTitleIntoDescription) {
      const t = String(title || "").trim();
      const d = String(combinedDescription || "").trim();
      if (ksTitleIncluded) ksFillText = d;
      else if (!t) ksFillText = d;
      else if (!d) ksFillText = t;
      else if (collapseText(d).startsWith(collapseText(t))) ksFillText = d;
      else ksFillText = `${t}\n${d}`;
    } else {
      ksFillText = combinedDescription;
    }
  } else {
    // 非拼接标签平台（哔哩哔哩 / 百家号 / 头条 / 番茄视频）
    if (rule.descMax != null && description) {
      const origDescLen = countChars(description);
      if (origDescLen > rule.descMax) {
        const extracted = extractInlineHashtags(description);
        if (extracted.inlineTags.length > 0) {
          // 简介内含 #话题 时同样优先保留话题、仅截正文，单个话题过长则丢弃该话题不吞正文
          const bodySource = extracted.body;
          const bodyLen = countChars(bodySource);
          const minBodyReserve = calcMinBodyReserve(bodyLen, rule.descMax);
          const maxInlineTagsBudget = Math.max(
            0,
            rule.descMax - minBodyReserve - (bodyLen > 0 ? 1 : 0)
          );
          const { kept: keptInlineTags, droppedByLength: droppedInlineTags } =
            selectTagsWithinBudget(extracted.inlineTags, {
              tagMax: null,
              maxTagsBudget: maxInlineTagsBudget,
            });
          const inlineTagsStr = keptInlineTags.map((t) => `#${t}`).join(" ");
          const inlineTagsLen = countChars(inlineTagsStr);
          const bodyBudget =
            inlineTagsLen > 0
              ? bodyLen > 0
                ? Math.max(0, rule.descMax - inlineTagsLen - 1)
                : 0
              : rule.descMax;
          const bodyRes = truncateTextByPunctuation(bodySource, bodyBudget);
          const finalDesc = [bodyRes.text, inlineTagsStr]
            .filter(Boolean)
            .join(" ");

          if (droppedInlineTags.length > 0) {
            adjustments.push(
              makeAdjustment({
                platform: canonical,
                field: "tags",
                action: "trim_tags",
                limit: rule.descMax,
                originalLength: extracted.inlineTags.length,
                finalLength: keptInlineTags.length,
                droppedTags: droppedInlineTags,
                reason: `简介内联话题超出简介上限 ${rule.descMax} 字`,
              })
            );
          }
          adjustments.push(
            makeAdjustment({
              platform: canonical,
              field: "description",
              action: "truncate",
              limit: rule.descMax,
              originalLength: origDescLen,
              finalLength: countChars(finalDesc),
              originalPreview: previewText(description, 18),
              finalPreview: previewText(finalDesc, 18),
            })
          );
          bodyDescription = finalDesc;
          combinedDescription = finalDesc;
          ksFillText = finalDesc;
        } else {
          const descRes = truncateTextByPunctuation(description, rule.descMax);
          if (descRes.truncated) {
            adjustments.push(
              makeAdjustment({
                platform: canonical,
                field: "description",
                action: "truncate",
                limit: rule.descMax,
                originalLength: descRes.originalLength,
                finalLength: descRes.finalLength,
                originalPreview: previewText(description, 18),
                finalPreview: previewText(descRes.text, 18),
              })
            );
            bodyDescription = descRes.text;
            combinedDescription = descRes.text;
            ksFillText = descRes.text;
          }
        }
      }
    }
    if (rule.tagMax != null && keptTags.length > rule.tagMax) {
      const dropped = keptTags.slice(rule.tagMax);
      adjustments.push(
        makeAdjustment({
          platform: canonical,
          field: "tags",
          action: "trim_tags",
          limit: rule.tagMax,
          originalLength: keptTags.length,
          finalLength: rule.tagMax,
          droppedTags: dropped,
          reason: `上限 ${rule.tagMax} 个`,
        })
      );
      keptTags = keptTags.slice(0, rule.tagMax);
    }
  }

  const tagsText = keptTags.map((t) => `${tagPrefix}${t}`).join(" ");
  const summary = formatRuleAdjustmentsSummary(adjustments);

  if (logEnabled && adjustments.length > 0) {
    for (const adj of adjustments) {
      console.warn(`[platform-rules] ${adj.message}`);
    }
  }

  return {
    platform: canonical,
    rule,
    title,
    description: bodyDescription,
    bodyDescription,
    combinedDescription,
    ksFillText,
    shortTitle,
    tags: keptTags,
    tagsText,
    ...(hasBjhDescOverride ? { descOverrideApplied: true } : {}),
    adjusted: adjustments.length > 0,
    adjustments,
    summary,
  };
}

/**
 * GUI 发布前预检：计算指定平台列表将会发生的截断 / 裁标签提示（不阻断发布）。
 *
 * @param {string[]} platforms 平台列表（可含重复或别名）
 * @param {object} input { title, description, shortTitle, tags, titleByPlatform, descByPlatform }
 * @returns {Array<{ platform: string, adjustments: object[], summary: string }>}
 */
export function previewPlatformPublishAdjustments(platforms, input = {}) {
  const list = Array.isArray(platforms) ? platforms : [];
  const seen = new Set();
  const warnings = [];
  for (const rawPt of list) {
    const canonical = resolvePlatformRuleKey(rawPt);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    const res = applyPlatformPublishRules(canonical, input, { log: false });
    if (res.adjusted) {
      warnings.push({
        platform: canonical,
        adjustments: res.adjustments,
        summary: res.summary,
      });
    }
  }
  return warnings;
}
