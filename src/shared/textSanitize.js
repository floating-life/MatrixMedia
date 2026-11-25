"use strict";

/**
 * 发布标题 / 文案 / Excel 导入统一清洗工具。
 *
 * 解决 Excel 单元格读出的字面量 `_x000d_`（大小写不敏感，可能连续多个）与 `\r` 残留：
 * - 所有文本字段：删除 `_x000d_`，将 `\r\n` 和 `\r` 统一转为 `\n`
 * - 标题类字段（title / shortTitle / bt1）：把换行折成空格并 trim
 * - 简介类字段（description / bdText）：保留 `\n` 并 trim
 * - 标签类字段（tags / bq）：删除 `_x000d_`、折换行并 trim
 *
 * GUI 批量导入、CLI publish / xlsx、HTTP /publish 共用本模块，保证三条链路结果一致。
 */

const EXCEL_CR_ESCAPE_RE = /_x000d_/gi;
const ZERO_WIDTH_RE = /[\uFEFF\u200B\u200C\u200D]/g;
const NBSP_RE = /\u00A0/g;
// 标签分隔：字符串里出现逗号/中文逗号/顿号/换行/`#` 任一「强分隔符」时只按强分隔符拆
// （保留含空格标签如 "Final Cut Pro,剪辑"）；没有强分隔符时按空格拆（"游戏 解说 开黑" → 3 个，与 CLI 帮助一致）。
// 数组元素各自视为整体，不按空格拆。
const TAG_SPLIT_RE = /[\n,，、;；|]+/;

function isShipinhaoPlatform(raw) {
  const s = String(raw || "").trim().toLowerCase();
  return s === "sph" || s === "视频号";
}

/**
 * 基础清洗：删除 Excel 回车转义 `_x000d_`（大小写不敏感、可连续），并将 `\r\n` / `\r` 统一为 `\n`。
 * @param {unknown} raw
 * @returns {string}
 */
function stripExcelEscapesAndCR(raw) {
  if (raw == null) return "";
  return String(raw)
    .replace(EXCEL_CR_ESCAPE_RE, "")
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n");
}

/**
 * 标题类字段清洗（title / shortTitle / bt1）：
 * 删除 `_x000d_`，`\r\n`/`\r` → `\n`，再将换行与制表符折成单个空格并 trim。
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeTitle(raw) {
  if (raw == null) return "";
  return stripExcelEscapesAndCR(raw)
    .replace(ZERO_WIDTH_RE, "")
    .replace(NBSP_RE, " ")
    .replace(/[ \t]*\n+[ \t]*/g, " ")
    .replace(/\t+/g, " ")
    .trim();
}

/**
 * 简介/正文类字段清洗（description / bdText）：
 * 删除 `_x000d_`，`\r\n`/`\r` → `\n`，保留 `\n` 并 trim。
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeDescription(raw) {
  if (raw == null) return "";
  return stripExcelEscapesAndCR(raw)
    .replace(ZERO_WIDTH_RE, "")
    .replace(NBSP_RE, " ")
    .trim();
}

/**
 * 标签统一清洗与拆分（GUI 单发/批量、CLI publish/xlsx、HTTP /publish、videoMetadata、平台上传共用）：
 * - 支持字符串或字符串数组
 * - 删除 `_x000d_`、`\r`、零宽字符、NBSP
 * - 只按逗号/中文逗号/顿号/换行与 `#` 边界拆分，不按空格拆（含空格的标签如 "Final Cut Pro" 保持完整）
 * - 去除前导 `#`，过滤空项并保序去重
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitAndSanitizeTags(raw) {
  const rawItems = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out = [];
  const seen = new Set();
  for (const entry of rawItems) {
    if (entry == null) continue;
    const cleaned = stripExcelEscapesAndCR(entry)
      .replace(ZERO_WIDTH_RE, "")
      .replace(NBSP_RE, " ")
      .replace(/\t+/g, " ");
    // 与上游语义一致：字符串里空格、逗号、顿号、分号、竖线、换行都是分隔符；数组元素各自保持完整
    const parts = Array.isArray(raw) ? cleaned.split(TAG_SPLIT_RE) : cleaned.split(/[\s,，、;；|]+/);
    for (const part of parts) {
      if (!part) continue;
      const hashParts = part.split(/(?=#)/);
      for (const hp of hashParts) {
        const tag = hp.replace(/^#+/, "").replace(/ {2,}/g, " ").trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
      }
    }
  }
  return out;
}

/**
 * 话题类平台（抖音/快手/视频号/小红书等 `#话题` 形式）的标签：话题里不能有空格，
 * 在通用拆分基础上再按空格拆开（"减脂,健身 教程" → 减脂/健身/教程）。B 站等普通标签平台不用。
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitHashtagTags(raw) {
  const out = [];
  const seen = new Set();
  for (const t of splitAndSanitizeTags(raw)) {
    for (const part of String(t).split(/\s+/)) {
      if (!part || seen.has(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  return out;
}

/**
 * 标签类字段清洗（tags / bq）：支持字符串或字符串数组，统一走 splitAndSanitizeTags。
 * 字符串形态以 `,` 拼回，保持无损可逆（含空格标签如 "Final Cut Pro" 再次拆分仍完整）。
 * @param {unknown} raw
 * @returns {string|string[]}
 */
function sanitizeTags(raw) {
  const list = splitAndSanitizeTags(raw);
  if (Array.isArray(raw)) {
    return list;
  }
  return list.join(",");
}

/**
 * Excel 非文案类单元格（表头、文件名、封面路径、创作声明）清洗：
 * 去除 BOM / 零宽 / NBSP / `_x000d_` / 换行 / 制表符并 trim。
 * @param {unknown} raw
 * @returns {string}
 */
function cleanExcelMetaCell(raw) {
  if (raw == null) return "";
  return stripExcelEscapesAndCR(raw)
    .replace(ZERO_WIDTH_RE, "")
    .replace(NBSP_RE, "")
    .replace(/[\n\t]/g, "")
    .trim();
}

/**
 * Excel 分平台标题/简介表头别名映射（与 src/shared/platformRules.js 对齐，
 * 本模块保持纯 CommonJS 以便 Node 单测直接 require）。
 */
const XLSX_PLATFORM_HEADER_ALIASES = {
  抖音: "抖音",
  dy: "抖音",
  douyin: "抖音",
  视频号: "视频号",
  微信视频号: "视频号",
  sph: "视频号",
  shipinhao: "视频号",
  wxvideo: "视频号",
  channels: "视频号",
  快手: "快手",
  ks: "快手",
  kuaishou: "快手",
  百家号: "百家号",
  百度百家号: "百家号",
  bjh: "百家号",
  baijiahao: "百家号",
  头条: "头条",
  今日头条: "头条",
  头条号: "头条",
  tt: "头条",
  toutiao: "头条",
  小红书: "小红书",
  xhs: "小红书",
  xiaohongshu: "小红书",
  red: "小红书",
  哔哩哔哩: "哔哩哔哩",
  b站: "哔哩哔哩",
  bilibili: "哔哩哔哩",
  blbl: "哔哩哔哩",
  bili: "哔哩哔哩",
  番茄视频: "番茄视频",
  番茄: "番茄视频",
  fqsp: "番茄视频",
  fanqie: "番茄视频",
  fq: "番茄视频",
};

/**
 * 解析批量 xlsx 的分平台表头：
 * 如「抖音标题」「百家号标题」「快手简介」「B站标题」「今日头条标题」「dy_title」「ks简介」。
 * 明确排除「视频号短标题」「短标题」「标题」「简介」等既有列。
 * @param {string} cleanedLowerKey cleanExcelMetaCell(k).toLowerCase()
 * @returns {{ platform: string, field: "title"|"description", exactCanonical: boolean } | null}
 */
function parsePlatformOverrideHeader(cleanedLowerKey) {
  if (!cleanedLowerKey) return null;
  if (
    cleanedLowerKey === "标题" ||
    cleanedLowerKey === "title" ||
    cleanedLowerKey === "简介" ||
    cleanedLowerKey === "description" ||
    cleanedLowerKey === "desc" ||
    cleanedLowerKey === "视频号短标题" ||
    cleanedLowerKey === "短标题" ||
    cleanedLowerKey === "shorttitle" ||
    cleanedLowerKey.endsWith("短标题")
  ) {
    return null;
  }
  const m = cleanedLowerKey.match(
    /^(.+?)[-_\s]*(标题|简介|title|description|desc)$/
  );
  if (!m) return null;
  const prefix = m[1].replace(/[-_\s]+$/g, "").trim();
  const suffix = m[2];
  if (!prefix) return null;
  const canonical = XLSX_PLATFORM_HEADER_ALIASES[prefix];
  if (!canonical) return null;
  const field =
    suffix === "标题" || suffix === "title" ? "title" : "description";
  return {
    platform: canonical,
    field,
    exactCanonical: prefix === canonical.toLowerCase(),
  };
}

/**
 * 解析批量 xlsx 布尔可选列（「AI章节」「原创声明」等）：
 * - 空单元格返回 null（未显式指定，交由调用方回退发布设置默认值）
 * - 支持 是/否、开启/关闭、开/关、true/false、yes/no、1/0
 * - 无法识别的非空值返回 null（不崩溃，回退默认值）
 * @param {unknown} raw
 * @returns {boolean | null}
 */
function parseExcelOptionalBoolean(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") {
    if (raw === 1) return true;
    if (raw === 0) return false;
    return null;
  }
  const cleaned = cleanExcelMetaCell(raw);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (
    cleaned === "是" ||
    cleaned === "开" ||
    cleaned === "开启" ||
    cleaned === "启用" ||
    cleaned === "打开" ||
    cleaned === "勾选" ||
    cleaned === "声明" ||
    lower === "true" ||
    lower === "yes" ||
    lower === "y" ||
    lower === "on" ||
    lower === "1"
  ) {
    return true;
  }
  if (
    cleaned === "否" ||
    cleaned === "关" ||
    cleaned === "关闭" ||
    cleaned === "禁用" ||
    cleaned === "不勾选" ||
    cleaned === "不声明" ||
    cleaned === "不开启" ||
    cleaned === "无" ||
    lower === "false" ||
    lower === "no" ||
    lower === "n" ||
    lower === "off" ||
    lower === "0"
  ) {
    return false;
  }
  return null;
}

/**
 * GUI（dialog:openBatchXlsx）与 CLI（parseXlsxRows）共用的批量 Excel 行归一化函数。
 * 保证两条 Excel 导入链路对 title / description / shortTitle / tags / coverPathH /
 * 分平台覆盖（titleByPlatform / descByPlatform）/ aiChapters / originalStatement 的清洗结果完全一致。
 *
 * @param {Array<Record<string, unknown>>} rows xlsx.utils.sheet_to_json 产出的原始行
 * @returns {Array<{fileName: string, title: string, description: string, shortTitle: string, tags: string, coverPath: string, coverPathH: string, creativeStatement: string, collection: string, aiChapters: boolean|null, originalStatement: boolean|null, titleByPlatform: Record<string, string>, descByPlatform: Record<string, string>}>}
 */
function normalizeBatchXlsxRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const map = {};
      const titleCanonical = {};
      const titleAlias = {};
      const descCanonical = {};
      const descAlias = {};
      if (row && typeof row === "object") {
        Object.keys(row).forEach((k) => {
          const key = cleanExcelMetaCell(k).toLowerCase();
          map[key] = row[k];
          const parsedHeader = parsePlatformOverrideHeader(key);
          if (parsedHeader) {
            if (parsedHeader.field === "title") {
              const val = sanitizeTitle(row[k]);
              if (val) {
                if (parsedHeader.exactCanonical) {
                  titleCanonical[parsedHeader.platform] = val;
                } else if (!titleAlias[parsedHeader.platform]) {
                  titleAlias[parsedHeader.platform] = val;
                }
              }
            } else {
              const val = sanitizeDescription(row[k]);
              if (val) {
                if (parsedHeader.exactCanonical) {
                  descCanonical[parsedHeader.platform] = val;
                } else if (!descAlias[parsedHeader.platform]) {
                  descAlias[parsedHeader.platform] = val;
                }
              }
            }
          }
        });
      }
      const coverPathRaw =
        map["封面"] != null && String(map["封面"]).trim() !== ""
          ? map["封面"]
          : map["竖版封面"] != null && String(map["竖版封面"]).trim() !== ""
          ? map["竖版封面"]
          : map["竖封面"] != null && String(map["竖封面"]).trim() !== ""
          ? map["竖封面"]
          : map["竖版封面(3:4)"] != null && String(map["竖版封面(3:4)"]).trim() !== ""
          ? map["竖版封面(3:4)"]
          : map["竖版封面（3:4）"] != null && String(map["竖版封面（3:4）"]).trim() !== ""
          ? map["竖版封面（3:4）"]
          : map["cover"] != null
          ? map["cover"]
          : map["coverpath"] || "";
      const coverPathHRaw =
        map["横版封面"] != null && String(map["横版封面"]).trim() !== ""
          ? map["横版封面"]
          : map["横版封面(4:3)"] != null && String(map["横版封面(4:3)"]).trim() !== ""
          ? map["横版封面(4:3)"]
          : map["横版封面（4:3）"] != null && String(map["横版封面（4:3）"]).trim() !== ""
          ? map["横版封面（4:3）"]
          : map["横封面"] != null && String(map["横封面"]).trim() !== ""
          ? map["横封面"]
          : map["4:3封面"] != null && String(map["4:3封面"]).trim() !== ""
          ? map["4:3封面"]
          : map["coverpathh"] != null && String(map["coverpathh"]).trim() !== ""
          ? map["coverpathh"]
          : map["coverh"] != null && String(map["coverh"]).trim() !== ""
          ? map["coverh"]
          : map["cover_h"] != null && String(map["cover_h"]).trim() !== ""
          ? map["cover_h"]
          : map["cover-h"] || "";
      const pickFirstCell = (keys) => {
        for (let i = 0; i < keys.length; i++) {
          const val = map[keys[i]];
          if (val !== undefined && val !== null && String(val).trim() !== "") {
            return val;
          }
        }
        return null;
      };
      const aiChaptersRaw = pickFirstCell([
        "ai章节",
        "ai自动章节",
        "自动章节",
        "智能章节",
        "aichapters",
        "ai_chapters",
        "ai-chapters",
      ]);
      const originalStatementRaw = pickFirstCell([
        "原创声明",
        "声明原创",
        "原创",
        "originalstatement",
        "original_statement",
        "original-statement",
        "original",
      ]);
      return {
        fileName: cleanExcelMetaCell(
          map["文件名"] != null
            ? map["文件名"]
            : map["filename"] != null
            ? map["filename"]
            : map["file"] || ""
        ),
        title: sanitizeTitle(
          map["标题"] != null ? map["标题"] : map["title"] || ""
        ),
        description: sanitizeDescription(
          map["简介"] != null
            ? map["简介"]
            : map["description"] != null
            ? map["description"]
            : ""
        ),
        shortTitle: sanitizeTitle(
          map["视频号短标题"] != null
            ? map["视频号短标题"]
            : map["shorttitle"] != null
            ? map["shorttitle"]
            : ""
        ),
        tags: sanitizeTags(
          map["标签"] != null ? map["标签"] : map["tags"] || ""
        ),
        coverPath: cleanExcelMetaCell(coverPathRaw),
        coverPathH: cleanExcelMetaCell(coverPathHRaw),
        creativeStatement: cleanExcelMetaCell(
          map["创作声明"] != null
            ? map["创作声明"]
            : map["creativestatement"] != null
            ? map["creativestatement"]
            : map["cs"] || ""
        ),
        collection: sanitizeTitle(
          map["合集"] != null
            ? map["合集"]
            : map["合集名称"] != null
            ? map["合集名称"]
            : map["collection"] != null
            ? map["collection"]
            : ""
        ),
        aiChapters: parseExcelOptionalBoolean(aiChaptersRaw),
        originalStatement: parseExcelOptionalBoolean(originalStatementRaw),
        titleByPlatform: { ...titleAlias, ...titleCanonical },
        descByPlatform: { ...descAlias, ...descCanonical },
      };
    })
    .filter((r) => r.fileName);
}

const TITLE_BODY_KEYS = ["title", "bt1", "shortTitle", "short_title"];
const DESC_BODY_KEYS = ["description", "desc", "bdText"];
const TAG_BODY_KEYS = ["tags", "bq"];

function sanitizeCollectionMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return rawMap;
  const next = { ...rawMap };
  for (const k of Object.keys(next)) {
    if (typeof next[k] === "string") {
      next[k] = sanitizeTitle(next[k]);
    }
  }
  return next;
}

function sanitizePlatformOptionsCollections(rawPlatformOptions) {
  if (
    !rawPlatformOptions ||
    typeof rawPlatformOptions !== "object" ||
    Array.isArray(rawPlatformOptions)
  ) {
    return rawPlatformOptions;
  }
  const next = { ...rawPlatformOptions };
  for (const ptKey of Object.keys(next)) {
    const entry = next[ptKey];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      if (
        Object.prototype.hasOwnProperty.call(entry, "collection") &&
        typeof entry.collection === "string"
      ) {
        next[ptKey] = {
          ...entry,
          collection: sanitizeTitle(entry.collection),
        };
      }
    }
  }
  return next;
}

function sanitizePlatformTextMapValues(rawMap, sanitizer) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) return rawMap;
  const next = { ...rawMap };
  for (const k of Object.keys(next)) {
    if (typeof next[k] === "string") {
      next[k] = sanitizer(next[k]);
    }
  }
  return next;
}

/**
 * 清洗单条 HTTP /publish 请求体（或 platforms[] 子对象）的文案字段。
 * 返回浅拷贝，不修改入参原对象。
 * 注意：旧字段 bt2 在视频号作为短标题（折换行），在其他平台作为简介（保留换行）；
 * 多平台共享顶层的 bt2 先保留换行，交由 parsePublishArgs 按各目标平台语义最终归一化。
 * @param {Record<string, any>} raw
 * @param {string} [parentPlatform]
 * @returns {Record<string, any>}
 */
function sanitizePublishPayloadObject(raw, parentPlatform = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...raw };
  for (const k of TITLE_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeTitle(out[k]);
    }
  }
  for (const k of ["titleByPlatform", "title-by-platform"]) {
    if (
      Object.prototype.hasOwnProperty.call(out, k) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = sanitizePlatformTextMapValues(out[k], sanitizeTitle);
    }
  }
  for (const k of ["descByPlatform", "desc-by-platform", "descriptionByPlatform"]) {
    if (
      Object.prototype.hasOwnProperty.call(out, k) &&
      out[k] &&
      typeof out[k] === "object" &&
      !Array.isArray(out[k])
    ) {
      out[k] = sanitizePlatformTextMapValues(out[k], sanitizeDescription);
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(out, "collection") &&
    typeof out.collection === "string"
  ) {
    out.collection = sanitizeTitle(out.collection);
  }
  if (
    Object.prototype.hasOwnProperty.call(out, "collections") &&
    out.collections &&
    typeof out.collections === "object"
  ) {
    out.collections = sanitizeCollectionMap(out.collections);
  }
  if (
    Object.prototype.hasOwnProperty.call(out, "platformOptions") &&
    out.platformOptions &&
    typeof out.platformOptions === "object"
  ) {
    out.platformOptions = sanitizePlatformOptionsCollections(out.platformOptions);
  }
  for (const k of DESC_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeDescription(out[k]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(out, "bt2") && out.bt2 != null) {
    const ownPlatform =
      out.platform != null
        ? out.platform
        : out.p != null
        ? out.p
        : out.pt != null
        ? out.pt
        : parentPlatform;
    const isSphOnly =
      !Array.isArray(out.platforms) && isShipinhaoPlatform(ownPlatform);
    out.bt2 = isSphOnly ? sanitizeTitle(out.bt2) : sanitizeDescription(out.bt2);
  }
  for (const k of TAG_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeTags(out[k]);
    }
  }
  if (Array.isArray(out.platforms)) {
    out.platforms = out.platforms.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? sanitizePublishPayloadObject(item, "")
        : item
    );
  }
  return out;
}

const CLI_TITLE_FLAGS = new Set(["-t", "--title", "--short-title", "--collection"]);
const CLI_DESC_FLAGS = new Set(["--description", "--desc"]);
const CLI_TAG_FLAGS = new Set(["--tags", "--bq"]);
const CLI_VALUE_FLAGS = new Set([
  "-p",
  "--platform",
  "-f",
  "--file",
  "--phone",
  "--partition",
  "-t",
  "--title",
  "--description",
  "--desc",
  "--short-title",
  "--name",
  "--book-name",
  "--bt2",
  "--tags",
  "--bq",
  "--publish-at",
  "--dir",
  "--config",
  "--xlsx",
  "--cover",
  "--cover-h",
  "--coverH",
  "--cover-path-h",
  "--title-by-platform",
  "--titleByPlatform",
  "--desc-by-platform",
  "--descByPlatform",
  "--creative-statement",
  "--cs",
  "--collection",
  "--sph-link-type",
  "--sph-link-value",
  "--sph-product-id",
  "--sph-drama-id",
  "--sph-series-id",
  "--address",
]);

function detectCliPublishPlatform(argv) {
  let platform = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const flag = arg.slice(0, eqIdx);
      if (flag === "-p" || flag === "--platform") {
        platform = arg.slice(eqIdx + 1);
      }
      continue;
    }
    if ((arg === "-p" || arg === "--platform") && i + 1 < argv.length) {
      platform = String(argv[++i]);
      continue;
    }
    if (CLI_VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
      i += 1;
    }
  }
  return platform;
}

/**
 * 清洗 CLI publish 参数数组中的标题/短标题/简介/标签值（支持 `--flag val` 与 `--flag=val`），
 * 确保在 parsePublishArgs 校验短标题长度/字符之前已完成 `_x000d_` 与 `\r` 清洗。
 * 严格按参数位置解析，不吞其他选项的值；`--bt2` 仅在视频号折行，其他平台保留换行。
 * @param {string[]} argv
 * @returns {string[]}
 */
function sanitizePublishCliArgs(argv) {
  if (!Array.isArray(argv)) return [];
  const targetIsSph = isShipinhaoPlatform(detectCliPublishPlatform(argv));
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    const eqIdx = arg.indexOf("=");
    if (eqIdx > 0) {
      const flag = arg.slice(0, eqIdx);
      const val = arg.slice(eqIdx + 1);
      if (CLI_TITLE_FLAGS.has(flag)) {
        out.push(`${flag}=${sanitizeTitle(val)}`);
        continue;
      }
      if (CLI_DESC_FLAGS.has(flag)) {
        out.push(`${flag}=${sanitizeDescription(val)}`);
        continue;
      }
      if (flag === "--bt2") {
        out.push(`${flag}=${targetIsSph ? sanitizeTitle(val) : sanitizeDescription(val)}`);
        continue;
      }
      if (CLI_TAG_FLAGS.has(flag)) {
        out.push(`${flag}=${sanitizeTags(val)}`);
        continue;
      }
    }
    if (CLI_TITLE_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, sanitizeTitle(argv[i + 1]));
      i += 1;
      continue;
    }
    if (CLI_DESC_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, sanitizeDescription(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg === "--bt2" && i + 1 < argv.length) {
      out.push(arg, targetIsSph ? sanitizeTitle(argv[i + 1]) : sanitizeDescription(argv[i + 1]));
      i += 1;
      continue;
    }
    if (CLI_TAG_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, sanitizeTags(argv[i + 1]));
      i += 1;
      continue;
    }
    if (CLI_VALUE_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, String(argv[i + 1]));
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

module.exports = {
  splitHashtagTags,
  stripExcelEscapesAndCR,
  sanitizeTitle,
  sanitizeDescription,
  splitAndSanitizeTags,
  sanitizeTags,
  cleanExcelMetaCell,
  normalizeBatchXlsxRows,
  sanitizePublishPayloadObject,
  sanitizePublishCliArgs,
};
