"use strict";

import {
  PLATFORM_ALIASES,
  VIDEO_PUBLISH_CANONICAL,
  resolvePublishPlatform,
  isVideoPublishPlatform,
} from "../../shared/publishPlatforms.js";
import {
  DEFAULT_PUBLISH_CREATIVE_STATEMENT,
  resolveCreativeStatementForPlatform,
  getCreativeStatementPlatformKey,
} from "../../shared/creativeStatement.js";
import {
  VIDEO_LINK_TYPES,
  buildVideoLinkOption,
  normalizeCollectionName,
  platformSupportsCollection,
  resolveCollectionOption,
} from "../../shared/videoLink.js";
import {
  sanitizeTitle,
  sanitizeDescription,
  splitAndSanitizeTags,
  splitHashtagTags,
} from "../../shared/textSanitize.js";

export { PLATFORM_ALIASES, VIDEO_PUBLISH_CANONICAL, resolvePublishPlatform };

/**
 * 解析 `cli publish` 后的 argv（不含子命令名 publish）
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function parsePublishArgs(subArgv) {
  const args = Array.isArray(subArgv) ? subArgv : [];
  if (args.includes("--help") || args.includes("-h")) {
    return { ok: true, value: { help: true } };
  }

  const out = {
    platform: null,
    file: null,
    phone: null,
    partition: null,
    title: null,
    description: "",
    shortTitle: "",
    bookName: null,
    bt2: null,
    bq: "",
    publishAt: null,
    show: false,
    closeWindowAfterPublish: true,
    dir: null,
    config: null,
    cover: null,
    creativeStatement: null,
    draft: false,
    allowDuplicate: false,
    noThrottle: false,
    noDownload: false,
    collection: "",
    sphLinkType: null,
    sphLinkValue: null,
    publishOptions: {},
  };

  const VALUE_FLAG_HINTS = {
    "--sph-product-id": "商品编号",
    "--sph-drama-id": "短剧名称",
    "--sph-series-id": "剧集名称",
    "--collection": "合集名称",
  };
  const consumeOptionValue = (flag, idx) => {
    const next = args[idx + 1];
    if (
      idx + 1 >= args.length ||
      next == null ||
      String(next).startsWith("--")
    ) {
      const hint = VALUE_FLAG_HINTS[flag] || "值";
      return {
        ok: false,
        error: `参数 ${flag} 缺少${hint}${
          next != null && String(next).startsWith("--")
            ? `（紧随其后的是选项 ${next}）`
            : ""
        }`,
      };
    }
    return { ok: true, value: next };
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--platform" || a === "-p") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.platform = v.value;
      i += 1;
    } else if (a === "--file" || a === "-f") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.file = v.value;
      i += 1;
    } else if (a === "--phone") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.phone = v.value;
      i += 1;
    } else if (a === "--partition") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.partition = v.value;
      i += 1;
    } else if (a === "--title" || a === "-t") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.title = v.value;
      i += 1;
    } else if (a === "--description" || a === "--desc") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.description = v.value || "";
      i += 1;
    } else if (a === "--short-title") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.shortTitle = v.value || "";
      i += 1;
    } else if (a === "--name" || a === "--book-name") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.bookName = v.value;
      i += 1;
    } else if (a === "--bt2") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.bt2 = v.value;
      i += 1;
    } else if (a === "--tags" || a === "--bq") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.bq = v.value || "";
      i += 1;
    } else if (a === "--publish-at") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.publishAt = v.value;
      i += 1;
    } else if (a === "--show") {
      out.show = true;
    } else if (a === "--no-close-window") {
      out.closeWindowAfterPublish = false;
    } else if (a === "--dir") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.dir = v.value;
      i += 1;
    } else if (a === "--config" || a === "--xlsx") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.config = v.value;
      i += 1;
    } else if (a === "--cover") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.cover = v.value;
      i += 1;
    } else if (a === "--creative-statement" || a === "--cs") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.creativeStatement = v.value;
      i += 1;
    } else if (a === "--collection") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.collection = v.value || "";
      i += 1;
    } else if (a.startsWith("--collection=")) {
      const eqVal = a.slice("--collection=".length);
      if (eqVal.startsWith("--")) {
        return {
          ok: false,
          error: `参数 --collection 值无效（${eqVal}）`,
        };
      }
      out.collection = eqVal;
    } else if (a === "--draft") {
      out.draft = true;
    } else if (a === "--allow-duplicate") {
      out.allowDuplicate = true;
    } else if (a === "--no-throttle") {
      out.noThrottle = true;
    } else if (a === "--no-download") {
      out.noDownload = true;
    } else if (a === "--sph-link-type") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.sphLinkType = v.value;
      i += 1;
    } else if (a === "--sph-link-value") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      out.sphLinkValue = v.value;
      i += 1;
    } else if (a === "--sph-product-id") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      // 商品上架快捷参数：等价于 --sph-link-type product --sph-link-value <id>
      out.sphLinkType = VIDEO_LINK_TYPES.PRODUCT;
      out.sphLinkValue = v.value;
      i += 1;
    } else if (a === "--sph-drama-id") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      // 小程序短剧快捷参数：等价于 --sph-link-type mini_drama --sph-link-value <短剧名称>
      out.sphLinkType = VIDEO_LINK_TYPES.MINI_DRAMA;
      out.sphLinkValue = v.value;
      i += 1;
    } else if (a === "--sph-series-id") {
      const v = consumeOptionValue(a, i);
      if (!v.ok) return v;
      // 视频号剧集快捷参数：等价于 --sph-link-type sph_series --sph-link-value <剧集名称>
      out.sphLinkType = VIDEO_LINK_TYPES.SPH_SERIES;
      out.sphLinkValue = v.value;
      i += 1;
    }
  }

  if (!out.platform) {
    return { ok: false, error: "缺少 --platform（或 -p），例如 dy / 抖音" };
  }
  const pt = resolvePublishPlatform(out.platform);
  if (!VIDEO_PUBLISH_CANONICAL.includes(pt)) {
    return { ok: false, error: `未知平台: ${out.platform}` };
  }
  out.platform = pt;
  if (out.title != null) out.title = sanitizeTitle(out.title);
  out.description = sanitizeDescription(out.description);
  out.shortTitle = sanitizeTitle(out.shortTitle);
  if (out.bt2 != null) {
    out.bt2 =
      out.platform === "视频号"
        ? sanitizeTitle(out.bt2)
        : sanitizeDescription(out.bt2);
    if (out.bt2) {
      if (out.platform === "视频号" && !out.shortTitle) out.shortTitle = out.bt2;
      if (out.platform !== "视频号" && !out.description)
        out.description = out.bt2;
    }
  }

  // 视频号链接是平台专属参数；误传给其他平台时直接忽略。
  if (out.platform === "视频号") {
    const hasType =
      out.sphLinkType != null && String(out.sphLinkType).trim() !== "";
    const hasValue =
      out.sphLinkValue != null && String(out.sphLinkValue).trim() !== "";
    // 只传商品编号时默认按商品上架处理。
    if (hasValue && !hasType) {
      out.sphLinkType = VIDEO_LINK_TYPES.PRODUCT;
    }
    const resolvedHasType =
      out.sphLinkType != null && String(out.sphLinkType).trim() !== "";
    if (resolvedHasType) {
      const typeAliases = {
        none: VIDEO_LINK_TYPES.NONE,
        无: VIDEO_LINK_TYPES.NONE,
        product: VIDEO_LINK_TYPES.PRODUCT,
        商品: VIDEO_LINK_TYPES.PRODUCT,
        mini_drama: VIDEO_LINK_TYPES.MINI_DRAMA,
        drama: VIDEO_LINK_TYPES.MINI_DRAMA,
        短剧: VIDEO_LINK_TYPES.MINI_DRAMA,
        小程序短剧: VIDEO_LINK_TYPES.MINI_DRAMA,
        微短剧: VIDEO_LINK_TYPES.MINI_DRAMA,
        sph_series: VIDEO_LINK_TYPES.SPH_SERIES,
        series: VIDEO_LINK_TYPES.SPH_SERIES,
        剧集: VIDEO_LINK_TYPES.SPH_SERIES,
        视频号剧集: VIDEO_LINK_TYPES.SPH_SERIES,
      };
      const linkType =
        typeAliases[String(out.sphLinkType).trim().toLowerCase()];
      if (!linkType) {
        return {
          ok: false,
          error:
            "--sph-link-type 当前仅支持 none、product、mini_drama 或 sph_series",
        };
      }
      if (linkType === VIDEO_LINK_TYPES.PRODUCT && !hasValue) {
        return {
          ok: false,
          error:
            "视频号商品上架必须提供 --sph-product-id 或 --sph-link-value <商品编号>",
        };
      }
      if (linkType === VIDEO_LINK_TYPES.MINI_DRAMA && !hasValue) {
        return {
          ok: false,
          error:
            "视频号短剧挂载必须提供 --sph-drama-id 或 --sph-link-value <短剧名称>",
        };
      }
      if (linkType === VIDEO_LINK_TYPES.SPH_SERIES && !hasValue) {
        return {
          ok: false,
          error:
            "视频号剧集挂载必须提供 --sph-series-id 或 --sph-link-value <剧集名称>",
        };
      }
      if (linkType === VIDEO_LINK_TYPES.NONE && hasValue) {
        return {
          ok: false,
          error: "--sph-link-type none 不应同时提供编号",
        };
      }
      const built = buildVideoLinkOption("视频号", linkType, out.sphLinkValue);
      if (!built.ok) return { ok: false, error: built.error };
      out.publishOptions = { link: built.value };
    }
  } else {
    out.sphLinkType = null;
    out.sphLinkValue = null;
  }

  if (!out.file && !out.dir) {
    return {
      ok: false,
      error:
        "缺少 --file（或 -f）视频文件路径，或 --dir + --config 批量目录模式",
    };
  }
  if (out.file && out.dir) {
    return { ok: false, error: "--file 和 --dir 不能同时使用" };
  }
  if (out.dir && !out.config) {
    return {
      ok: false,
      error: "--dir 批量模式必须同时提供 --config <xlsx路径>",
    };
  }

  if (!out.partition) {
    if (!out.phone) {
      return {
        ok: false,
        error:
          "缺少 --phone 或完整 --partition（与 GUI 一致，如 persist:13800138000抖音）",
      };
    }
    // 历史规则（phone "-" 前缀）先拼兜底 partition；发布执行层
    // （publishVideo）会按账号记录的 accountKey 重算标准 partition，
    // 传完整 --phone（如 "分组-账号名"）时也能命中新分组模型账号。
    const phoneSeg = String(out.phone).split("-")[0];
    out.partition = `persist:${phoneSeg}${out.platform}`;
  }

  if (!out.dir && (!out.title || !String(out.title).trim())) {
    return {
      ok: false,
      error:
        "缺少 --title（或 -t）视频标题（与 GUI「视频标题」一致，写入 data.bt1）",
    };
  }
  // in dir mode title comes from xlsx per row, no global --title needed

  if (out.show) {
    console.warn(
      "MatrixMedia: CLI publish 不显示浏览器窗口，已忽略 --show（--no-close-window 仅在与 GUI 显示窗口时有关，CLI 下无效）。"
    );
    out.show = false;
  }

  if (out.platform === "视频号") {
    out.shortTitle = String(out.shortTitle || "").trim();
    if (out.shortTitle) {
      if (/[，。、\/,;:!?'"()\[\]{}<>]/.test(out.shortTitle)) {
        return {
          ok: false,
          error: "视频号短标题不能包含特殊标点符号",
        };
      }
      const length = Array.from(out.shortTitle).length;
      if (length < 6 || length > 16) {
        return {
          ok: false,
          error: "视频号短标题去除首尾空格后长度需为 6～16 字",
        };
      }
    }
  }

  // 标签统一走共享 splitAndSanitizeTags（只按逗号/中文逗号/顿号/换行/# 分隔，保留含空格标签）
  if (out.bq) {
    const tags = splitAndSanitizeTags(out.bq);
    out.tags = tags;
    if (tags.length > 4) {
      console.warn(
        `MatrixMedia: --tags 共 ${tags.length} 个，建议最多 4 个话题；多余标签会降低每个话题的权重，生成层请按相关性裁到 4 个以内。`
      );
    }
    const hashtagPlatforms = new Set(["视频号", "抖音", "快手"]);
    if (hashtagPlatforms.has(out.platform)) {
      out.bq = splitHashtagTags(out.bq)
        .map((t) =>
          String(t).startsWith("#") ? String(t) : `#${String(t).trim()}`
        )
        .join(" ");
    } else {
      out.bq = tags.join(",");
    }
  }

  // allowDuplicate 放行透传进 publishOptions，确保经由 publishVideo.js 创建的定时任务记录也能持久保存
  if (out.allowDuplicate) {
    out.publishOptions = { ...(out.publishOptions || {}), allowDuplicate: true };
  }

  // 合集名称（仅抖音 / 快手 / 视频号生效；留空或非支持平台忽略，不污染 publishOptions）
  out.collection = normalizeCollectionName(out.collection);
  if (out.collection && platformSupportsCollection(out.platform)) {
    out.publishOptions = {
      ...(out.publishOptions || {}),
      collection: out.collection,
    };
  } else {
    out.collection = "";
  }

  return { ok: true, value: out };
}

function pickBodyValue(body, keys) {
  for (const key of keys) {
    const val = body[key];
    if (val != null && String(val).trim() !== "") {
      return String(val);
    }
  }
  return null;
}

function normalizeBodyTags(value) {
  return splitAndSanitizeTags(value).join(",");
}

/**
 * 将 HTTP JSON 请求体转为 cli publish 等价 argv
 * @param {object} body
 * @returns {string[]}
 */
export function publishBodyToArgv(body) {
  if (!body || typeof body !== "object") return [];
  const argv = [];
  const pushPair = (keys, flag) => {
    const val = pickBodyValue(body, keys);
    if (val != null) {
      argv.push(flag, val);
    }
  };

  pushPair(["platform", "p"], "-p");
  pushPair(["file", "f"], "-f");
  pushPair(["phone"], "--phone");
  pushPair(["partition"], "--partition");
  pushPair(["title", "t"], "-t");
  pushPair(["description", "desc"], "--description");
  pushPair(["shortTitle", "short-title"], "--short-title");
  pushPair(["bookName", "name", "book-name"], "--name");
  pushPair(["bt2"], "--bt2");
  const rawTags =
    body.tags != null &&
    (Array.isArray(body.tags)
      ? body.tags.length > 0
      : String(body.tags).trim() !== "")
      ? body.tags
      : body.bq != null &&
        (Array.isArray(body.bq)
          ? body.bq.length > 0
          : String(body.bq).trim() !== "")
      ? body.bq
      : null;
  if (rawTags != null) {
    const normalizedTags = normalizeBodyTags(rawTags);
    if (normalizedTags) argv.push("--tags", normalizedTags);
  }
  pushPair(["publishAt", "publish-at"], "--publish-at");
  pushPair(
    ["creativeStatement", "creative-statement", "cs"],
    "--creative-statement"
  );
  pushPair(["cover", "coverPath", "cover-path"], "--cover");
  if (typeof body.collection === "string" && body.collection.trim() !== "") {
    argv.push("--collection", body.collection);
  }
  const sphLink =
    (body.sphLink && typeof body.sphLink === "object" && body.sphLink) ||
    (body.platformOptions &&
      body.platformOptions.sph &&
      body.platformOptions.sph.link);
  const sphProductId = pickBodyValue(body, [
    "sphProductId",
    "sph-product-id",
    "productId",
  ]);
  const sphDramaId = pickBodyValue(body, [
    "sphDramaId",
    "sph-drama-id",
    "dramaId",
  ]);
  const sphSeriesId = pickBodyValue(body, [
    "sphSeriesId",
    "sph-series-id",
    "seriesId",
  ]);
  if (sphProductId != null && String(sphProductId).trim() !== "") {
    argv.push("--sph-product-id", String(sphProductId).trim());
  } else if (sphDramaId != null && String(sphDramaId).trim() !== "") {
    argv.push("--sph-drama-id", String(sphDramaId).trim());
  } else if (sphSeriesId != null && String(sphSeriesId).trim() !== "") {
    argv.push("--sph-series-id", String(sphSeriesId).trim());
  } else if (sphLink && typeof sphLink === "object") {
    if (sphLink.type != null && String(sphLink.type).trim() !== "") {
      argv.push("--sph-link-type", String(sphLink.type));
    }
    if (sphLink.value != null && String(sphLink.value).trim() !== "") {
      argv.push("--sph-link-value", String(sphLink.value));
    }
  }

  if (body.show === true) argv.push("--show");
  if (body.closeWindowAfterPublish === false) argv.push("--no-close-window");
  if (body.draft === true) argv.push("--draft");
  if (body.allowDuplicate === true || body["allow-duplicate"] === true)
    argv.push("--allow-duplicate");
  if (body.noThrottle === true || body["no-throttle"] === true)
    argv.push("--no-throttle");
  if (body.noDownload === true || body["no-download"] === true)
    argv.push("--no-download");

  return argv;
}

/**
 * 解析 HTTP / CLI 共用的发布参数
 * @param {object} body
 */
export function parsePublishRequest(body) {
  const err = validateHttpCollectionInput(body);
  if (err) return { ok: false, error: err };
  const parsed = parsePublishArgs(publishBodyToArgv(body));
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    value: applyHttpCollection(body, parsed.value, body),
  };
}

const SHARED_PUBLISH_BODY_KEYS = [
  "file",
  "f",
  "title",
  "t",
  "description",
  "desc",
  "shortTitle",
  "short-title",
  "phone",
  "partition",
  "bookName",
  "name",
  "book-name",
  "bt2",
  "tags",
  "bq",
  "publishAt",
  "publish-at",
  "creativeStatement",
  "creative-statement",
  "cs",
  "cover",
  "coverPath",
  "cover-path",
  "collection",
  "collections",
  "show",
  "closeWindowAfterPublish",
  "draft",
  "allowDuplicate",
  "allow-duplicate",
  "noThrottle",
  "no-throttle",
  "noDownload",
  "no-download",
  "platformOptions",
  "sphLink",
  "sphProductId",
  "sph-product-id",
  "productId",
  "sphDramaId",
  "sph-drama-id",
  "dramaId",
  "sphSeriesId",
  "sph-series-id",
  "seriesId",
];

function extractSharedPublishBody(body) {
  const shared = {};
  for (const key of SHARED_PUBLISH_BODY_KEYS) {
    if (body[key] != null && body[key] !== "") {
      shared[key] = body[key];
    }
  }
  return shared;
}

function mergePublishBody(shared, target) {
  const sharedPlatformOptions =
    shared.platformOptions && typeof shared.platformOptions === "object"
      ? shared.platformOptions
      : {};
  const targetPlatformOptions =
    target.platformOptions && typeof target.platformOptions === "object"
      ? target.platformOptions
      : {};
  const platformOptions = { ...sharedPlatformOptions };
  for (const [platformKey, options] of Object.entries(targetPlatformOptions)) {
    platformOptions[platformKey] = {
      ...(sharedPlatformOptions[platformKey] || {}),
      ...(options || {}),
    };
  }
  return {
    ...shared,
    ...target,
    ...(Object.keys(platformOptions).length > 0 ? { platformOptions } : {}),
  };
}

function normalizePublishTargets(body) {
  const raw = body.platforms;
  if (raw == null) return null;
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[,，|]/)
        .map((item) => item.trim())
        .filter(Boolean);
  if (list.length === 0) return null;

  return list
    .map((item) => {
      if (typeof item === "string") {
        return { platform: item };
      }
      if (item && typeof item === "object" && item.platform != null) {
        return { ...item };
      }
      return null;
    })
    .filter(Boolean);
}

function pickCreativeStatementFromMap(map, platformPt) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const keys = new Set([
    platformPt,
    getCreativeStatementPlatformKey(platformPt),
  ]);
  for (const [alias, canonical] of Object.entries(PLATFORM_ALIASES)) {
    if (canonical === platformPt) keys.add(alias);
  }
  for (const key of keys) {
    if (key && map[key] != null && String(map[key]).trim() !== "") {
      return map[key];
    }
  }
  return null;
}

function pickTargetCreativeStatement(target) {
  if (!target || typeof target !== "object") return null;
  return pickBodyValue(target, [
    "creativeStatement",
    "creative-statement",
    "cs",
  ]);
}

/**
 * HTTP 创作声明解析（对齐 LocalVideoPublish 批量设置 + 单账号覆盖 + 设置默认声明）
 * 优先级：target.creativeStatement > creativeStatements[平台] > body.creativeStatement > options.defaultCreativeStatement（默认 ai_generated）
 */
export function resolveHttpPublishCreativeStatement(
  body,
  platformPt,
  target,
  options = {}
) {
  let raw = pickTargetCreativeStatement(target);
  if (raw == null) {
    raw = pickCreativeStatementFromMap(body.creativeStatements, platformPt);
  }
  if (raw == null) {
    raw = pickBodyValue(body, [
      "creativeStatement",
      "creative-statement",
      "cs",
    ]);
  }
  if (raw == null) {
    raw =
      options && options.defaultCreativeStatement !== undefined
        ? options.defaultCreativeStatement
        : DEFAULT_PUBLISH_CREATIVE_STATEMENT;
  }
  return resolveCreativeStatementForPlatform(raw, platformPt);
}

function hasOwnKey(obj, key) {
  return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isValidCollectionValue(val) {
  if (val === undefined || val === null || typeof val === "string") return true;
  if (typeof val === "object" && !Array.isArray(val)) {
    const hasName = hasOwnKey(val, "name") && (val.name == null || typeof val.name === "string");
    const hasValue = hasOwnKey(val, "value") && (val.value == null || typeof val.value === "string");
    const hasEnabled = hasOwnKey(val, "enabled") && typeof val.enabled === "boolean";
    return hasName || hasValue || hasEnabled;
  }
  return false;
}

function validateHttpCollectionInput(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
  if (hasOwnKey(obj, "collection") && !isValidCollectionValue(obj.collection)) {
    return "collection 必须是合集名称字符串";
  }
  if (hasOwnKey(obj, "collections") && obj.collections != null) {
    if (typeof obj.collections !== "object" || Array.isArray(obj.collections)) {
      return "collections 必须是按平台映射的对象";
    }
    for (const [k, v] of Object.entries(obj.collections)) {
      if (!isValidCollectionValue(v)) {
        return `collections.${k} 必须是合集名称字符串`;
      }
    }
  }
  if (
    hasOwnKey(obj, "platformOptions") &&
    obj.platformOptions &&
    typeof obj.platformOptions === "object" &&
    !Array.isArray(obj.platformOptions)
  ) {
    for (const [ptKey, opts] of Object.entries(obj.platformOptions)) {
      if (
        opts &&
        typeof opts === "object" &&
        !Array.isArray(opts) &&
        hasOwnKey(opts, "collection") &&
        !isValidCollectionValue(opts.collection)
      ) {
        return `platformOptions.${ptKey}.collection 必须是合集名称字符串`;
      }
    }
  }
  return "";
}

/**
 * HTTP 合集解析（与 resolveCollectionOption 保持一致）：
 * 优先级：target.collection > target.platformOptions[平台].collection >
 *        body.platformOptions[平台].collection > body.collections[平台] > body.collection。
 * 显式传空串（如 collections: { ks: "" } 或 target: { platform: "ks", collection: "" }）可覆盖全局为不选合集。
 */
export function resolveHttpPublishCollection(body, platformPt, target) {
  if (!platformSupportsCollection(platformPt)) return "";
  const rootBody = body && typeof body === "object" ? body : {};
  const tgt = target && typeof target === "object" ? target : {};

  // 1. 多平台 target 子对象显式传了 collection（含显式空串 "" 取消全局合集）
  if (tgt !== rootBody && hasOwnKey(tgt, "collection") && tgt.collection !== undefined && tgt.collection !== null) {
    const resolved = resolveCollectionOption(platformPt, {
      collection: tgt.collection,
    });
    return resolved.enabled ? resolved.name : "";
  }
  // 2. target.platformOptions[平台].collection
  if (tgt !== rootBody && tgt.platformOptions && typeof tgt.platformOptions === "object") {
    const fromTargetPlatform = resolveCollectionOption(platformPt, {
      platformOptions: tgt.platformOptions,
    });
    const probeGlobal = resolveCollectionOption(platformPt, {
      collection: "__probe_fallback__",
      platformOptions: tgt.platformOptions,
    });
    if (probeGlobal.name !== "__probe_fallback__") {
      return fromTargetPlatform.enabled ? fromTargetPlatform.name : "";
    }
  }
  // 3-5. 复用 resolveCollectionOption(platformPt, { platformOptions, collections, collection })
  const resolved = resolveCollectionOption(platformPt, {
    platformOptions: rootBody.platformOptions,
    collections: rootBody.collections,
    collection: rootBody.collection,
  });
  return resolved.enabled ? resolved.name : "";
}

function applyHttpCollection(body, parsedValue, target = {}) {
  const collection = resolveHttpPublishCollection(
    body,
    parsedValue.platform,
    target
  );
  const nextPublishOptions = { ...(parsedValue.publishOptions || {}) };
  if (collection) {
    nextPublishOptions.collection = collection;
  } else {
    delete nextPublishOptions.collection;
  }
  return {
    ...parsedValue,
    collection,
    publishOptions: nextPublishOptions,
  };
}

function applyHttpCreativeStatements(
  body,
  parsedValue,
  target = {},
  options = {}
) {
  return applyHttpCollection(
    body,
    {
      ...parsedValue,
      creativeStatement: resolveHttpPublishCreativeStatement(
        body,
        parsedValue.platform,
        target,
        options
      ),
    },
    target
  );
}

/**
 * 解析 HTTP 发布请求；支持单平台 platform 或多平台 platforms
 * @param {object} body
 * @param {{ defaultCreativeStatement?: string }} [options]
 * @returns {{ ok: true, multi: boolean, value: object|object[] } | { ok: false, error: string }}
 */
export function parseMultiPublishRequest(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }

  const rootCollectionErr = validateHttpCollectionInput(body);
  if (rootCollectionErr) {
    return { ok: false, error: rootCollectionErr };
  }

  const targets = normalizePublishTargets(body);
  if (!targets || targets.length === 0) {
    const single = parsePublishRequest(body);
    if (!single.ok) return single;
    return {
      ok: true,
      multi: false,
      value: applyHttpCreativeStatements(body, single.value, body, options),
    };
  }

  if (body.platform != null && String(body.platform).trim() !== "") {
    return {
      ok: false,
      error: "请只使用 platform 或 platforms 其一，不要同时传",
    };
  }

  const shared = extractSharedPublishBody(body);
  const parsed = [];
  const skipped = [];

  for (let i = 0; i < targets.length; i++) {
    const targetCollectionErr = validateHttpCollectionInput(targets[i]);
    if (targetCollectionErr) {
      const label =
        targets[i].platform != null ? String(targets[i].platform) : `#${i + 1}`;
      return { ok: false, error: `平台 ${label}: ${targetCollectionErr}` };
    }
    const merged = mergePublishBody(shared, targets[i]);
    const item = parsePublishRequest(merged);
    if (!item.ok) {
      const label =
        targets[i].platform != null ? String(targets[i].platform) : `#${i + 1}`;
      // 对于未知平台，跳过并记录，不阻断其他平台的发布
      const rawPt =
        targets[i].platform != null ? String(targets[i].platform).trim() : "";
      const canonical = resolvePublishPlatform(rawPt);
      if (rawPt && !isVideoPublishPlatform(canonical)) {
        skipped.push({ platform: rawPt, reason: item.error });
        continue;
      }
      // 非「未知平台」的错误（如缺少 phone / title 等）仍然报错
      return { ok: false, error: `平台 ${label}: ${item.error}` };
    }
    if (item.value.dir) {
      return {
        ok: false,
        error: "HTTP API 暂不支持批量目录发布，请使用 cli publish --dir",
      };
    }
    parsed.push(
      applyHttpCreativeStatements(body, item.value, targets[i], options)
    );
  }

  if (parsed.length === 0) {
    const names = skipped.map((s) => s.platform).join(", ");
    return {
      ok: false,
      error: `所有平台均不支持: ${names}`,
    };
  }

  const publishAtSet = new Set(
    parsed.map((item) => String(item.publishAt || "").trim()).filter(Boolean)
  );
  if (publishAtSet.size > 1) {
    return {
      ok: false,
      error: "多平台定时发布时，各平台 publishAt 必须相同",
    };
  }

  const fileSet = new Set(parsed.map((item) => String(item.file || "").trim()));
  if (fileSet.size > 1) {
    return { ok: false, error: "多平台发布需使用相同 file" };
  }

  const result = { ok: true, multi: parsed.length > 1, value: parsed };
  if (skipped.length > 0) {
    result.skipped = skipped;
  }
  return result;
}

export function publishHelpText() {
  return `
用法: <应用> cli publish [选项]

字段与 GUI「本地视频发布」弹窗一致（见 LocalVideoPublish buildVideoPayload）：

选项:
  -p, --platform <id>   平台：dy|抖音、tt|头条、ks|快手、blbl|哔哩哔哩、bjh|百家号、sph|视频号、xhs|小红书、fqsp|番茄视频
  -f, --file <path>     本地视频文件路径，或 http(s) 远程视频 URL（远程会先下载到临时目录，发布结束后自动删除）
      --dir <path>          [batch] video directory path; must be paired with --config
      --config <path>       [batch] xlsx 声明文件（列：文件名/标题/简介/标签/视频号短标题/封面/创作声明/合集）
      --cs, --creative-statement <val>  creative statement value for single-file mode.
                            Valid values: none | ai_generated | fiction | marketing | personal_opinion | repost | self_made_no_repost
                            (self_made_no_repost is blbl-only). Default: configured setting (default ai_generated; unsupported platforms fall back to none).
      --cover <path>    自定义封面图片路径（抖音/快手/视频号生效；竖封面 3:4 比例最佳，
                            抖音横封面基于竖封面自动生成；视频号仅收 jpg/png）。
                            单文件模式传绝对路径；--dir 批量模式下全局覆盖 xlsx「封面」列，
                            未传时用 xlsx 每行的封面列（相对路径相对视频目录解析）
      --collection <name> 发布时选择的合集名称（抖音/快手/视频号生效，按去空白后完全匹配；留空不选，
                            其他平台忽略）。--dir 批量模式下每行优先用 xlsx「合集」列，留空时回退本参数；
                            找不到入口、找不到同名合集或回读不符时中止发布、截图留证且不重试
      --phone <id>      账号手机号（与 GUI 账号树一致，可与 partition 二选一）
      --partition <p>   完整 session partition，如 persist:13800138000抖音
  -t, --title <text>    视频标题（必填）→ data.title
      --description <text> 视频简介或正文 → data.description
      --short-title <text> 视频号短标题 → data.shortTitle，建议 6～16 字
      --name <n>        名称 / 任务记录名 → bookName；默认与视频文件名（无扩展名）一致
      --book-name <n>   同 --name
      --bt2 <text>      旧兼容字段：视频号作为短标题，其他平台作为简介
      --tags <text>     视频标签 → data.bq（同 --bq）。多个标签用【空格】分隔，例如 "减脂 健身 教程"。
                            【上限 4 个话题】：超过 4 个会触发 warn，agent 生成时请按相关性裁到 ≤ 4。
                            • 视频号/抖音/快手：整串拼进描述末尾；未写 # 的标签会自动补上（与 GUI 标签多选一致）。
                            • 哔哩哔哩/小红书：按空格切分为独立标签，前导 # 会被自动剥离，可省。
                            • 百家号/头条：当前代码不消费 bq，无需填。
      --publish-at <t>  一次性定时发布，格式 "YYYY-MM-DD HH:mm:ss"。创建后立即写入发布历史，
                            到点后由应用主进程调度执行；不支持每日/每周/每月循环。
      --show            （已忽略）CLI 不显示自动化窗口
      --no-close-window 发布后不自动关窗（仅 GUI 显示窗口时有效；CLI 始终后台运行）
      --draft           显式发布到草稿箱（小红书点「暂存离开」）。若账号在 GUI「媒体平台管理」
                            里开启了「默认发布到草稿」，即使不加该参数也会自动走草稿。
      --allow-duplicate 放行 7 天内同平台+同账号+同标题的重复发布拦截（默认拒绝并退出码 6）
      --no-throttle     绕过发布节流与错峰排期（不自动顺延为定时任务；即使传了 --publish-at 也不顺延）
      --no-download     快手专用：取消勾选「允许下载此作品」并校验终态（其它平台忽略；
                            取消未确认会中止发布，宁可不发不可漏禁下载红线）
      --sph-product-id <id>   视频号商品上架（快捷参数，等价于 product + 商品编号）
      --sph-drama-id <name>   视频号挂载小程序短剧。值为短剧「名称」而非编号（发布页按名称搜索），
                                如 --sph-drama-id 泳陷错恋；传数字编号会搜不到。
      --sph-series-id <name>  视频号挂载剧集（视频号原生剧集，区别于小程序短剧）。同样传「名称」而非编号。
      --sph-link-type <type>  视频号链接类型：none | product | mini_drama | sph_series（也接受 drama / 短剧 / series / 剧集）；传给其他平台时忽略
      --sph-link-value <v>    视频号链接值：商品编号，或短剧/剧集名称；只传该参数时默认按商品上架
  -h, --help            显示帮助

退出码 (单文件): 0 成功, 1 异常, 2 参数错误, 3 任务失败（上传未成功）, 4 已转存草稿需检查, 6 近7天重复发布拦截
退出码 (批量 --dir): 0 全部成功, 1 部分失败, 2 全部失败

示例:
  matrixmedia.exe cli publish -p dy --phone 13800138000 -f C:\\\\v.mp4 -t "我的视频标题" --tags "#减脂 #健身"
  electron . cli publish -p dy --phone 13800138000 -f ./a.mp4 --name "任务A" -t "标题" --tags "#标签1 #标签2"
  # 视频号用 --short-title，其他平台用 --description：
  matrixmedia cli publish -p sph --phone 13800138000 -f ./v.mp4 \\\\
    -t "新手第一天跑步就坚持 5 公里是什么体验" \\\\
    --description "第一次跑步的完整过程" \\\\
    --short-title "5公里新手挑战" \\\\
    --tags "跑步 新手 减脂" \\
    --sph-product-id 10000591263144 --draft
  # 视频号挂载小程序短剧（短剧名称取自视频号发布页「选择需要关联的短剧」列表，如 泳陷错恋；失败会自动转存草稿）：
  matrixmedia cli publish -p sph --phone 13800138000 -f ./v.mp4 \\\\
    -t "短剧第一集" --draft --sph-drama-id 泳陷错恋
  # 视频号挂载剧集（剧集名称取自发布页剧集列表；与小程序短剧互斥，一次只挂一种）：
  matrixmedia cli publish -p sph --phone 13800138000 -f ./v.mp4 \\\\
    -t "短剧第一集" --draft --sph-series-id 天作剧场
  # 哔哩哔哩独立标签控件，空格分隔、是否带 # 都可：
  matrixmedia cli publish -p blbl --phone 13800138000 -f ./v.mp4 -t "标题" --tags "游戏 解说 开黑"
  # 一次性定时发布：必须提供实际视频、标题、账号等完整发布参数
  matrixmedia cli publish -p dy --phone 13800138000 -f ./v.mp4 -t "标题" --publish-at "2026-05-05 20:30:00"
  # 指定合集发布（抖音/快手/视频号生效）：
  matrixmedia cli publish -p dy --phone 13800138000 -f ./v.mp4 -t "标题" --collection "民间故事"
  # batch publish with xlsx config:
  matrixmedia cli publish -p dy --phone 13800138000 --dir ./videos --config ./videos/batch.xlsx
`.trim();
}
