"use strict";

import { validateDouyinProductUrl } from "./productLinkInput.js";

export const VIDEO_LINK_TYPES = {
  NONE: "none",
  OFFICIAL_ARTICLE: "official_article",
  RED_PACKET_COVER: "red_packet_cover",
  PRODUCT: "product",
  MINI_GAME: "mini_game",
  MINI_DRAMA: "mini_drama",
  SPH_SERIES: "sph_series",
};

/**
 * 平台链接能力表。
 * platformAvailable 表示平台页面存在该能力；automationSupported 表示已提供自动化实现。
 * 抖音 / 快手商品流程仍需有权限的账号实机验收；无法唯一确认挂载时停止发布。
 * 会员专区不进入工具能力表；小游戏仍仅预留结构，未验证前不向用户开放。
 * 小程序短剧 / 视频号剧集已按同款流程实现（见 main/services/upLoad/sphDrama.js 与 sphSeries.js），
 * 但平台 DOM 存在版本差异，失败时会由 sphLink 兜底转存草稿并返回 needs_attention，不会误报成功。
 */
const VIDEO_LINK_CAPABILITIES = {
  抖音: {
    platformKey: "dy", maxItems: 1,
    types: [
      { type: VIDEO_LINK_TYPES.NONE, label: "无", inputKind: "none", placeholder: "", maxLength: 0, platformAvailable: true, automationSupported: true, selectionMode: "none" },
      { type: VIDEO_LINK_TYPES.PRODUCT, label: "商品", inputKind: "url", placeholder: "粘贴完整商品链接", maxLength: 2048, platformAvailable: true, automationSupported: true, selectionMode: "product_url", requiresShortTitle: true },
    ],
  },
  快手: {
    platformKey: "ks", maxItems: 1,
    types: [
      { type: VIDEO_LINK_TYPES.NONE, label: "无", inputKind: "none", placeholder: "", maxLength: 0, platformAvailable: true, automationSupported: true, selectionMode: "none" },
      { type: VIDEO_LINK_TYPES.PRODUCT, label: "商品", inputKind: "product_name", placeholder: "填写已在货架中的商品完整名称", maxLength: 200, platformAvailable: true, automationSupported: true, selectionMode: "exact_product_name" },
    ],
  },
  视频号: {
    platformKey: "sph",
    maxItems: 1,
    types: [
      {
        type: VIDEO_LINK_TYPES.NONE,
        label: "无",
        inputKind: "none",
        placeholder: "",
        maxLength: 0,
        platformAvailable: true,
        automationSupported: true,
        selectionMode: "none",
      },
      {
        type: VIDEO_LINK_TYPES.PRODUCT,
        label: "商品",
        inputKind: "entity_id",
        placeholder: "输入视频号商品 ID",
        maxLength: 32,
        platformAvailable: true,
        automationSupported: true,
        selectionMode: "product_id",
      },
      {
        type: VIDEO_LINK_TYPES.OFFICIAL_ARTICLE,
        label: "公众号文章",
        inputKind: "url",
        placeholder: "粘贴公众号文章链接",
        maxLength: 2048,
        platformAvailable: true,
        automationSupported: false,
      },
      {
        type: VIDEO_LINK_TYPES.RED_PACKET_COVER,
        label: "红包封面",
        inputKind: "url",
        placeholder: "粘贴红包封面链接",
        maxLength: 2048,
        platformAvailable: true,
        automationSupported: false,
      },
      {
        type: VIDEO_LINK_TYPES.MINI_GAME,
        label: "小游戏",
        inputKind: "entity_id",
        placeholder: "输入小游戏编号",
        maxLength: 64,
        platformAvailable: true,
        automationSupported: false,
      },
      {
        type: VIDEO_LINK_TYPES.MINI_DRAMA,
        label: "小程序短剧",
        inputKind: "entity_id",
        placeholder: "输入短剧名称，如 泳陷错恋",
        maxLength: 64,
        platformAvailable: true,
        automationSupported: true,
        selectionMode: "drama_id",
      },
      {
        type: VIDEO_LINK_TYPES.SPH_SERIES,
        label: "视频号剧集",
        inputKind: "entity_id",
        placeholder: "输入剧集名称",
        maxLength: 64,
        platformAvailable: true,
        automationSupported: true,
        selectionMode: "series_id",
      },
    ],
  },
};

export function getVideoLinkCapability(platform) {
  const name = String(platform || "");
  const key = Object.keys(VIDEO_LINK_CAPABILITIES).find((fragment) =>
    name.includes(fragment)
  );
  return key ? VIDEO_LINK_CAPABILITIES[key] : null;
}

export function getVideoLinkTypeCapability(platform, type) {
  const capability = getVideoLinkCapability(platform);
  if (!capability) return null;
  return (
    capability.types.find((item) => item.type === String(type || "")) || null
  );
}

/** GUI 可展示的平台链接类型（含尚未开放自动化的占位项）。 */
export function getDisplayableVideoLinkTypes(platform) {
  const capability = getVideoLinkCapability(platform);
  if (!capability) return [];
  return capability.types.filter((item) => item.platformAvailable);
}

/** 已支持自动化的链接类型。 */
export function getSupportedVideoLinkTypes(platform) {
  return getDisplayableVideoLinkTypes(platform).filter(
    (item) => item.automationSupported
  );
}

export function platformSupportsVideoLink(platform) {
  return getDisplayableVideoLinkTypes(platform).some(
    (item) => item.type !== VIDEO_LINK_TYPES.NONE
  );
}

export function normalizeVideoLinkValue(value) {
  return String(value == null ? "" : value).trim();
}

export function validateVideoLinkValue(platform, type, value, details = {}) {
  const normalized = normalizeVideoLinkValue(value);
  const resolvedType = String(type || VIDEO_LINK_TYPES.NONE);
  const typeCapability = getVideoLinkTypeCapability(platform, resolvedType);
  if (resolvedType === VIDEO_LINK_TYPES.NONE) return { ok: true, value: "" };
  if (!typeCapability) {
    return { ok: false, value: normalized, error: "当前链接类型尚未开放" };
  }
  if (!typeCapability.automationSupported) {
    return { ok: false, value: normalized, error: "当前链接类型尚未开放" };
  }
  if (resolvedType === VIDEO_LINK_TYPES.PRODUCT && typeCapability.selectionMode === "product_url") {
    const url = validateDouyinProductUrl(value);
    if (!url.ok) return url;
    const shortTitle = typeof details.shortTitle === "string" ? details.shortTitle.trim() : "";
    if (!shortTitle || [...shortTitle].length > 10 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(details.shortTitle)) {
      return { ok: false, value: normalized, error: "商品短标题必填，最多 10 个字符，不能包含控制字符" };
    }
    return url;
  }
  if (resolvedType === VIDEO_LINK_TYPES.PRODUCT && typeCapability.selectionMode === "exact_product_name") {
    if (typeof value !== "string" || !normalized || [...normalized].length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
      return { ok: false, value: normalized, error: "请填写货架商品的完整名称（最多 200 个字符，不能包含控制字符）" };
    }
    return { ok: true, value: normalized };
  }
  if (!normalized) {
    const emptyMessage =
      resolvedType === VIDEO_LINK_TYPES.PRODUCT
        ? "请选择或填写商品编号"
        : resolvedType === VIDEO_LINK_TYPES.MINI_DRAMA
        ? "请填写短剧名称"
        : resolvedType === VIDEO_LINK_TYPES.SPH_SERIES
        ? "请填写剧集名称"
        : "请填写链接内容";
    return { ok: false, value: "", error: emptyMessage };
  }
  if (resolvedType === VIDEO_LINK_TYPES.PRODUCT && !/^\d+$/.test(normalized)) {
    return { ok: false, value: normalized, error: "商品编码只能包含数字" };
  }
  const isEntityIdType =
    resolvedType === VIDEO_LINK_TYPES.MINI_DRAMA ||
    resolvedType === VIDEO_LINK_TYPES.SPH_SERIES;
  if (isEntityIdType) {
    const entityHint =
      resolvedType === VIDEO_LINK_TYPES.MINI_DRAMA ? "短剧" : "剧集";
    // 名称按「包含匹配」搜索，允许空格（如「My Boss 是首富」）；
    // 仅拦截会破坏输入/日志的换行与制表符。
    if (/[\r\n\t]/.test(normalized)) {
      return {
        ok: false,
        value: normalized,
        error: `${entityHint}名称不能包含换行或制表符`,
      };
    }
    if (normalized.length > 64) {
      return {
        ok: false,
        value: normalized,
        error: `${entityHint}名称最长 64 个字符`,
      };
    }
  }
  return { ok: true, value: normalized };
}

export function buildVideoLinkOption(platform, type, value, details = {}) {
  const supportedTypes = getSupportedVideoLinkTypes(platform);
  const resolvedType = String(type || (supportedTypes[0] || {}).type || "");
  const typeCapability = getVideoLinkTypeCapability(platform, resolvedType);
  const checked = validateVideoLinkValue(platform, resolvedType, value, details);
  if (!checked.ok) return checked;
  const enabled = Boolean(
    resolvedType !== VIDEO_LINK_TYPES.NONE &&
      checked.value &&
      typeCapability &&
      typeCapability.automationSupported
  );
  return {
    ok: true,
    value: {
      enabled,
      type: resolvedType,
      inputKind: (typeCapability && typeCapability.inputKind) || "text",
      value: enabled ? checked.value : "",
      selectionMode:
        (typeCapability && typeCapability.selectionMode) || "direct_input",
      ...(enabled && typeCapability.requiresShortTitle ? { shortTitle: details.shortTitle.trim() } : {}),
      failurePolicy: ["dy", "ks"].includes((getVideoLinkCapability(platform) || {}).platformKey) ? "stop" : "save_draft",
    },
  };
}

/** 读取通用链接结构；未配置时使用“无”。 */
export function resolveVideoLinkOption(platform, publishOptions = {}) {
  const options = publishOptions || {};
  const link = options.link;
  if (link && typeof link === "object") {
    const resolvedType = String(link.type || VIDEO_LINK_TYPES.NONE);
    const typeCapability = getVideoLinkTypeCapability(platform, resolvedType);
    const platformKey = (getVideoLinkCapability(platform) || {}).platformKey;
    const commerceProduct = resolvedType === VIDEO_LINK_TYPES.PRODUCT && ["dy", "ks"].includes(platformKey);
    return {
      enabled: resolvedType !== VIDEO_LINK_TYPES.NONE && link.enabled === true,
      type: resolvedType,
      inputKind:
        link.inputKind ||
        (typeCapability && typeCapability.inputKind) ||
        "text",
      // 新商品输入保留原值交给平台模块校验，不能 trim 掉控制字符或把数值强转商品名。
      value: commerceProduct ? link.value : normalizeVideoLinkValue(link.value),
      ...(typeCapability && typeCapability.requiresShortTitle ? { shortTitle: link.shortTitle } : {}),
      selectionMode:
        link.selectionMode ||
        (typeCapability && typeCapability.selectionMode) ||
        "direct_input",
      failurePolicy: ["dy", "ks"].includes((getVideoLinkCapability(platform) || {}).platformKey) ? "stop" : (link.failurePolicy || "save_draft"),
    };
  }
  return buildVideoLinkOption(platform, VIDEO_LINK_TYPES.NONE, "").value;
}

/** 支持发布时选择合集的平台表（抖音 / 快手 / 视频号） */
export const COLLECTION_SUPPORTED_PLATFORMS = {
  抖音: { platformKey: "dy", aliases: ["dy", "douyin", "抖音"] },
  快手: { platformKey: "ks", aliases: ["ks", "kuaishou", "快手"] },
  视频号: { platformKey: "sph", aliases: ["sph", "视频号"] },
};

function hasOwnCollectionProp(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

export function getCollectionCanonicalPlatform(platform) {
  const raw = String(platform || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const keys = Object.keys(COLLECTION_SUPPORTED_PLATFORMS);
  for (let i = 0; i < keys.length; i++) {
    const canonical = keys[i];
    const entry = COLLECTION_SUPPORTED_PLATFORMS[canonical];
    if (
      raw.includes(canonical) ||
      entry.aliases.some((alias) => alias.toLowerCase() === lower)
    ) {
      return canonical;
    }
  }
  return "";
}

export function getCollectionPlatformKey(platform) {
  const canonical = getCollectionCanonicalPlatform(platform);
  return canonical ? COLLECTION_SUPPORTED_PLATFORMS[canonical].platformKey : "";
}

export function platformSupportsCollection(platform) {
  return Boolean(getCollectionCanonicalPlatform(platform));
}

/**
 * 清洗合集名称：去掉 Excel `_x000d_` 转义、零宽字符、NBSP，将换行/制表符折成空格并 trim。
 * 留空返回 ""（表示不选合集）。
 */
export function normalizeCollectionName(value) {
  if (value == null) return "";
  return String(value)
    .replace(/_x000d_/gi, "")
    .replace(/[\uFEFF\u200B\u200C\u200D]/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 去所有空白字符，用于与页面合集名做完全匹配比对 */
export function collapseCollectionText(value) {
  return normalizeCollectionName(value).replace(/\s+/g, "");
}

function getCollectionLookupKeys(platform) {
  const canonical = getCollectionCanonicalPlatform(platform);
  if (!canonical) return [];
  const entry = COLLECTION_SUPPORTED_PLATFORMS[canonical];
  return [canonical, entry.platformKey, ...entry.aliases];
}

function pickCollectionEntryFromMap(map, platform) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { found: false, value: undefined };
  }
  const lookupKeys = getCollectionLookupKeys(platform);
  const keySet = new Set(lookupKeys.map((k) => k.toLowerCase()));
  // 优先精确 key 顺序命中，再大小写不敏感匹配
  for (let i = 0; i < lookupKeys.length; i++) {
    const k = lookupKeys[i];
    if (hasOwnCollectionProp(map, k) && map[k] !== undefined && map[k] !== null) {
      return { found: true, value: map[k] };
    }
  }
  const mapKeys = Object.keys(map);
  for (let i = 0; i < mapKeys.length; i++) {
    const mk = mapKeys[i];
    if (keySet.has(mk.toLowerCase()) && map[mk] !== undefined && map[mk] !== null) {
      return { found: true, value: map[mk] };
    }
  }
  return { found: false, value: undefined };
}

function pickCollectionFromPlatformOptions(platformOptions, platform) {
  const hit = pickCollectionEntryFromMap(platformOptions, platform);
  if (!hit.found || !hit.value || typeof hit.value !== "object") {
    return { found: false, value: undefined };
  }
  if (
    hasOwnCollectionProp(hit.value, "collection") &&
    hit.value.collection !== undefined &&
    hit.value.collection !== null
  ) {
    return { found: true, value: hit.value.collection };
  }
  return { found: false, value: undefined };
}

function toResolvedCollection(raw, platformKey) {
  if (raw && typeof raw === "object") {
    if (raw.enabled === false) {
      return {
        enabled: false,
        name: "",
        platformKey,
        supported: true,
        failurePolicy: "stop",
      };
    }
    const name = normalizeCollectionName(
      raw.name != null ? raw.name : raw.value != null ? raw.value : ""
    );
    return {
      enabled: Boolean(name),
      name,
      platformKey,
      supported: true,
      failurePolicy: "stop",
    };
  }
  const name = normalizeCollectionName(raw);
  return {
    enabled: Boolean(name),
    name,
    platformKey,
    supported: true,
    failurePolicy: "stop",
  };
}

export function buildCollectionOption(platform, name) {
  const platformKey = getCollectionPlatformKey(platform);
  if (!platformKey) {
    return {
      ok: true,
      value: {
        enabled: false,
        name: "",
        platformKey: "",
        supported: false,
        failurePolicy: "stop",
      },
    };
  }
  return {
    ok: true,
    value: toResolvedCollection(name, platformKey),
  };
}

/**
 * 解析当前平台最终生效的合集配置（仿 resolveVideoLinkOption）。
 * 覆盖优先级：publishOptions.platformOptions[平台].collection > publishOptions.collections[平台] > publishOptions.collection（全局）。
 * 显式按平台覆盖为空串或 { enabled: false } 时关闭该平台合集，不再回退全局。
 * 非支持平台（仅支持抖音/快手/视频号）始终返回 enabled: false。
 */
export function resolveCollectionOption(platform, publishOptions = {}) {
  const platformKey = getCollectionPlatformKey(platform);
  if (!platformKey) {
    return {
      enabled: false,
      name: "",
      platformKey: "",
      supported: false,
      failurePolicy: "stop",
    };
  }
  const options =
    publishOptions && typeof publishOptions === "object" ? publishOptions : {};

  const fromPlatformOpts = pickCollectionFromPlatformOptions(
    options.platformOptions,
    platform
  );
  if (fromPlatformOpts.found) {
    return toResolvedCollection(fromPlatformOpts.value, platformKey);
  }

  const fromMap = pickCollectionEntryFromMap(options.collections, platform);
  if (fromMap.found) {
    return toResolvedCollection(fromMap.value, platformKey);
  }

  if (
    hasOwnCollectionProp(options, "collection") &&
    options.collection !== undefined &&
    options.collection !== null
  ) {
    return toResolvedCollection(options.collection, platformKey);
  }

  return {
    enabled: false,
    name: "",
    platformKey,
    supported: true,
    failurePolicy: "stop",
  };
}
