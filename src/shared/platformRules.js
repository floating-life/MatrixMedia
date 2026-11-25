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
    titleMax: 20, // 已确认（百家号视频标题上限 20 字；若英文/数字按 0.5 计则本值更保守，待真机核对）
    descMax: null, // 当前 bjh.js 不填写简介（待真机核对新版是否有简介栏及上限）
    tagMax: null, // 当前 bjh.js 不填写标签（待真机核对）
    coverRatios: Object.freeze([]),
    usesCombinedDescription: false,
    hasSeparateTitle: true,
    tagsInDescriptionBudget: false,
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
 * 从简介正文中拆出内联 #话题（如「正文内容 #话题1 #话题2」）。
 * 仅识别位于开头或空白后的 #xxx（避免误拆 URL 里的锚点 https://a.com#top）。
 *
 * @param {string} description
 * @returns {{ body: string, inlineTags: string[] }}
 */
export function extractInlineHashtags(description) {
  const src = String(description == null ? "" : description);
  if (!src || !src.includes("#")) {
    return { body: src, inlineTags: [] };
  }
  const inlineTags = [];
  const seen = new Set();
  const body = src
    .replace(/(^|[\s])((?:#[^\s#]+)+)/g, (match, lead, cluster) => {
      const parts = String(cluster || "")
        .split("#")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!parts.length) return match;
      for (const tagBody of parts) {
        if (!seen.has(tagBody)) {
          seen.add(tagBody);
          inlineTags.push(tagBody);
        }
      }
      return lead === "\n" ? "\n" : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { body, inlineTags };
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

  if (rule.tagsInDescriptionBudget) {
    // 抖音 / 视频号 / 快手 / 小红书：#话题 与正文共享简介/描述上限
    // 检查简介内嵌 #话题（如用户在正文里手写了 #xxx）
    const extracted = extractInlineHashtags(description);
    const hasInlineTags = extracted.inlineTags.length > 0;

    // 合并所有待保留的标签（去重保序）：先内联 #xxx 再独立 tags
    const allTagNames = [];
    const seenTag = new Set();
    for (const t of [...extracted.inlineTags, ...keptTags]) {
      if (!t || seenTag.has(t)) continue;
      seenTag.add(t);
      allTagNames.push(t);
    }

    const totalOriginalTagCount = allTagNames.length;
    let workingTags = allTagNames.slice();
    let droppedByLimit = [];

    // 3a. 先按 tagMax 裁个数（快手 4 / 抖音 4）
    if (rule.tagMax != null && workingTags.length > rule.tagMax) {
      droppedByLimit = workingTags.slice(rule.tagMax);
      workingTags = workingTags.slice(0, rule.tagMax);
    }

    // 决定正文基文本：若内联话题被 tagMax 裁过，或整体将超过 descMax，
    // 则把内联话题统一抽离到尾部标签区一起保序保留；否则原样保留内联位置！
    const formatTagsStr = (list) => list.map((t) => `#${t}`).join(" ");
    const tagSep = canonical === "小红书" ? "\n" : " ";

    const calcNaturalCombined = () => {
      if (hasInlineTags && droppedByLimit.length === 0) {
        // 仅追加不在内联里的独立标签
        const inlineSet = new Set(extracted.inlineTags);
        const extraTags = workingTags.filter((t) => !inlineSet.has(t));
        const extraStr = formatTagsStr(extraTags);
        return [description, extraStr].filter(Boolean).join(" ");
      }
      const tagsStr = formatTagsStr(workingTags);
      return [extracted.body, tagsStr].filter(Boolean).join(" ");
    };

    const ksTitleAlreadyInDesc =
      rule.combinesTitleIntoDescription &&
      title &&
      description &&
      collapseText(description).startsWith(collapseText(title));

    const calcKsPrefixLen = (t) => {
      if (!rule.combinesTitleIntoDescription || !t || ksTitleAlreadyInDesc) {
        return 0;
      }
      return countChars(t);
    };

    const naturalCombined = calcNaturalCombined();
    const naturalTotalLen = (() => {
      if (canonical === "小红书") {
        const bodyLen = countChars(
          hasInlineTags && droppedByLimit.length === 0 ? description : extracted.body
        );
        const tagsPart =
          hasInlineTags && droppedByLimit.length === 0
            ? formatTagsStr(
                workingTags.filter((t) => !new Set(extracted.inlineTags).has(t))
              )
            : formatTagsStr(workingTags);
        const tagsLen = countChars(tagsPart);
        return bodyLen + (bodyLen > 0 && tagsLen > 0 ? 1 : 0) + tagsLen;
      }
      if (rule.combinesTitleIntoDescription && title && !ksTitleAlreadyInDesc) {
        const combLen = countChars(naturalCombined);
        return countChars(title) + (combLen > 0 ? 1 : 0) + combLen;
      }
      return countChars(naturalCombined);
    })();

    const exceedsDescMax = rule.descMax != null && naturalTotalLen > rule.descMax;

    if (!exceedsDescMax && droppedByLimit.length === 0) {
      // 未超字数且未超标签数：保持原文与标签位置完全不动
      if (canonical === "小红书") {
        const inlineSet = new Set(extracted.inlineTags);
        bodyDescription = description;
        keptTags = workingTags.filter((t) => !inlineSet.has(t));
        combinedDescription = [description, formatTagsStr(keptTags)]
          .filter(Boolean)
          .join(" ");
      } else {
        bodyDescription = description;
        keptTags = workingTags;
        combinedDescription = naturalCombined;
      }
    } else {
      // 需要裁标签或截正文：所有话题标签（内联 + 追加）集中优先保留在尾部，只截正文
      const descLimit = rule.descMax;
      const bodySource = extracted.body;
      let droppedByLength = [];

      // 若标签串自身就超出 descMax，按尾部减少标签直到 <= descMax
      if (descLimit != null) {
        while (
          workingTags.length > 0 &&
          countChars(formatTagsStr(workingTags)) > descLimit
        ) {
          droppedByLength.unshift(workingTags.pop());
        }
      }

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
        // 为标签预留长度（若有正文且有标签，留 1 个分隔符）
        const totalAvailForText =
          finalTagsLen > 0 ? Math.max(0, descLimit - finalTagsLen - 1) : descLimit;

        if (rule.combinesTitleIntoDescription && title && !ksTitleAlreadyInDesc) {
          // 快手把 title + "\n" + body + " " + tags 合并进同一编辑器
          const origCombinedBody = [title, bodySource].filter(Boolean).join("\n");
          const origTitleLen = countChars(title);
          if (origTitleLen > totalAvailForText) {
            const titleTrunc = truncateTextByPunctuation(title, totalAvailForText);
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
            if (bodySource) {
              adjustments.push(
                makeAdjustment({
                  platform: canonical,
                  field: "description",
                  action: "truncate",
                  limit: descLimit,
                  originalLength: countChars(origCombinedBody),
                  finalLength: countChars(title),
                  originalPreview: previewText(bodySource, 18),
                  finalPreview: "",
                })
              );
            }
            bodyDescription = "";
          } else {
            const bodyBudget = Math.max(
              0,
              totalAvailForText - origTitleLen - (bodySource ? 1 : 0)
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
          // 抖音 / 视频号 / 小红书 / 快手(无独立标题前缀)
          const bodyRes = truncateTextByPunctuation(bodySource, totalAvailForText);
          if (bodyRes.truncated) {
            const sepLen = bodySource && finalTagsLen > 0 ? countChars(tagSep) : 0;
            const newSepLen = bodyRes.text && finalTagsLen > 0 ? countChars(tagSep) : 0;
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
      if (ksTitleAlreadyInDesc) ksFillText = d;
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
