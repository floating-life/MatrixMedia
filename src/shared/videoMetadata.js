import {
  sanitizeTitle,
  sanitizeDescription,
  splitAndSanitizeTags,
  splitHashtagTags,
} from "./textSanitize.js";
import {
  PLATFORM_RULES,
  applyPlatformPublishRules,
  formatRuleAdjustmentsSummary,
  getPlatformRule,
  mergeRuleAdjustments,
} from "./platformRules.js";

export { formatRuleAdjustmentsSummary, mergeRuleAdjustments };

function firstText(...values) {
  return values.map((value) => sanitizeTitle(value)).find(Boolean) || "";
}

function firstDescriptionText(...values) {
  return values.map((value) => sanitizeDescription(value)).find(Boolean) || "";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function semanticText(data, key, legacyKeys = [], { multiline = false } = {}) {
  const clean = multiline ? sanitizeDescription : sanitizeTitle;
  if (hasOwn(data, key)) return clean(data[key]);
  return (multiline ? firstDescriptionText : firstText)(
    ...legacyKeys.map((legacyKey) => data[legacyKey])
  );
}

export function normalizeVideoTags(value) {
  return splitAndSanitizeTags(value);
}

export function joinDescriptionAndTags(description, tags) {
  const tagsText = Array.isArray(tags)
    ? tags.map((t) => sanitizeTitle(t)).filter(Boolean).join(" ")
    : sanitizeTitle(tags);
  return [sanitizeDescription(description), tagsText]
    .filter(Boolean)
    .join(" ");
}

/**
 * 各平台话题/标签的硬上限（与 platformRules.js 同源）：超出时平台不是「权重降低」，而是直接拒绝本次提交。
 *
 * 快手：编辑器里每个 #话题 都是一个话题 chip，第 5 个会弹出「最多只能添加4个话题」，
 * 并且「发布」按钮的点击被这个校验吞掉——页面停在发布页、不改地址、不给成功提示，
 * 最终被 waitForPublishSignal 判成 signal=none 的「发布异常」。
 * 抖音：实测第 5 个起同样弹出「最多添加4个话题」阻断发布。
 */
export const PLATFORM_TAG_LIMITS = {
  快手: PLATFORM_RULES.快手.tagMax,
  抖音: PLATFORM_RULES.抖音.tagMax,
};

export function formatTagsForPlatform(platform, tags) {
  const prefix = platform === "哔哩哔哩" ? "" : "#";
  let normalized = prefix ? splitHashtagTags(tags) : normalizeVideoTags(tags);
  const rule = getPlatformRule(platform);
  const limit =
    (rule && rule.tagMax) || PLATFORM_TAG_LIMITS[platform] || 0;
  if (limit > 0 && normalized.length > limit) {
    const dropped = normalized.slice(limit);
    console.warn(
      `[text] ${platform} 话题上限 ${limit} 个（平台硬限制，超出会导致本次发布被拒绝），` +
        `已丢弃 ${dropped.length} 个：${dropped.join(" ")}`
    );
    normalized = normalized.slice(0, limit);
  }
  return normalized.map((tag) => `${prefix}${tag}`).join(" ");
}

export function buildPlatformVideoTextDetailed(platform, metadata = {}) {
  const applied = applyPlatformPublishRules(
    platform,
    {
      title: firstText(metadata.title, metadata.bt1),
      description: firstDescriptionText(metadata.description, metadata.bdText),
      shortTitle:
        platform === "视频号"
          ? firstText(metadata.shortTitle, metadata.bt2Filled)
          : "",
      tags: metadata.tags ?? metadata.bq,
      titleByPlatform: metadata.titleByPlatform,
      descByPlatform: metadata.descByPlatform,
    },
    { log: true }
  );

  return {
    title: applied.title,
    description: applied.combinedDescription,
    bodyDescription: applied.bodyDescription,
    ksFillText: applied.ksFillText,
    shortTitle: applied.shortTitle,
    tags: applied.tags,
    tagsText: applied.tagsText,
    adjusted: applied.adjusted,
    adjustments: applied.adjustments,
    summary: applied.summary,
  };
}

export function buildPlatformVideoText(platform, metadata = {}) {
  const detailed = buildPlatformVideoTextDetailed(platform, metadata);
  return {
    title: detailed.title,
    description: detailed.description,
    shortTitle: detailed.shortTitle,
  };
}

export function normalizeVideoMetadata(raw = {}, platform = "") {
  const data = raw.data || raw;
  const title = semanticText(data, "title", ["bt1"]);
  const description = semanticText(
    data,
    "description",
    ["bdText", ...(platform === "视频号" ? [] : ["bt2"])],
    { multiline: true }
  );
  const shortTitle = semanticText(data, "shortTitle", [
    "bt2Filled",
    ...(platform === "视频号" ? ["bt2"] : []),
  ]);
  const tags = normalizeVideoTags(data.tags ?? data.bq);

  return {
    title,
    description,
    shortTitle,
    tags,
    legacy: {
      bt1: title,
      bt2: description,
      bt2Filled: shortTitle,
      bdText: description,
      bq: tags.join(" "),
    },
  };
}

export function normalizeVideoRecordMetadata(record = {}) {
  const platform = record.pt || record.platform || "";
  const title = hasOwn(record, "title")
    ? sanitizeTitle(record.title)
    : firstText(record.bt, record.bt1);
  const data = { ...record, title };

  if (
    platform === "视频号" &&
    !hasOwn(record, "shortTitle") &&
    !hasOwn(record, "bt2Filled") &&
    firstText(record.bt2) === title
  ) {
    data.bt2 = "";
  }

  return normalizeVideoMetadata(data, platform);
}
