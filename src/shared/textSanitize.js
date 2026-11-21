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
 * 标签类字段清洗（tags / bq）：支持字符串或字符串数组。
 * @param {unknown} raw
 * @returns {string|string[]}
 */
function sanitizeTags(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => sanitizeTitle(item)).filter(Boolean);
  }
  return sanitizeTitle(raw);
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
 * GUI（dialog:openBatchXlsx）与 CLI（parseXlsxRows）共用的批量 Excel 行归一化函数。
 * 保证两条 Excel 导入链路对 title / description / shortTitle / tags 的清洗结果完全一致。
 *
 * @param {Array<Record<string, unknown>>} rows xlsx.utils.sheet_to_json 产出的原始行
 * @returns {Array<{fileName: string, title: string, description: string, shortTitle: string, tags: string, coverPath: string, creativeStatement: string}>}
 */
function normalizeBatchXlsxRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => {
      const map = {};
      if (row && typeof row === "object") {
        Object.keys(row).forEach((k) => {
          const key = cleanExcelMetaCell(k).toLowerCase();
          map[key] = row[k];
        });
      }
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
        coverPath: cleanExcelMetaCell(
          map["封面"] != null
            ? map["封面"]
            : map["cover"] != null
            ? map["cover"]
            : map["coverpath"] || ""
        ),
        creativeStatement: cleanExcelMetaCell(
          map["创作声明"] != null
            ? map["创作声明"]
            : map["creativestatement"] != null
            ? map["creativestatement"]
            : map["cs"] || ""
        ),
      };
    })
    .filter((r) => r.fileName);
}

const TITLE_BODY_KEYS = ["title", "bt1", "shortTitle", "short_title", "bt2"];
const DESC_BODY_KEYS = ["description", "desc", "bdText"];
const TAG_BODY_KEYS = ["tags", "bq"];

/**
 * 清洗单条 HTTP /publish 请求体（或 platforms[] 子对象）的文案字段。
 * 返回浅拷贝，不修改入参原对象。
 * @param {Record<string, any>} raw
 * @returns {Record<string, any>}
 */
function sanitizePublishPayloadObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const out = { ...raw };
  for (const k of TITLE_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeTitle(out[k]);
    }
  }
  for (const k of DESC_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeDescription(out[k]);
    }
  }
  for (const k of TAG_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, k) && out[k] != null) {
      out[k] = sanitizeTags(out[k]);
    }
  }
  if (Array.isArray(out.platforms)) {
    out.platforms = out.platforms.map((item) =>
      item && typeof item === "object" && !Array.isArray(item)
        ? sanitizePublishPayloadObject(item)
        : item
    );
  }
  return out;
}

const CLI_TITLE_FLAGS = new Set(["-t", "--title", "--short-title", "--bt2"]);
const CLI_DESC_FLAGS = new Set(["--description", "--desc"]);
const CLI_TAG_FLAGS = new Set(["--tags", "--bq"]);

/**
 * 清洗 CLI publish 参数数组中的标题/短标题/简介/标签值（支持 `--flag val` 与 `--flag=val`），
 * 确保在 parsePublishArgs 校验短标题长度/字符之前已完成 `_x000d_` 与 `\r` 清洗。
 * @param {string[]} argv
 * @returns {string[]}
 */
function sanitizePublishCliArgs(argv) {
  if (!Array.isArray(argv)) return [];
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
    if (CLI_TAG_FLAGS.has(arg) && i + 1 < argv.length) {
      out.push(arg, sanitizeTags(argv[i + 1]));
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

module.exports = {
  stripExcelEscapesAndCR,
  sanitizeTitle,
  sanitizeDescription,
  sanitizeTags,
  cleanExcelMetaCell,
  normalizeBatchXlsxRows,
  sanitizePublishPayloadObject,
  sanitizePublishCliArgs,
};
