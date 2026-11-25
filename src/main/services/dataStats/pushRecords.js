"use strict";

/**
 * 读取本地发布记录（<Documents>/MatrixMedia/data/pushData/YYYY-MM-DD.json）。
 *
 * 与 src/main/cli/runHistoryCli.js 保持同一目录与文件名约定；
 * 支持注入 dir 以便单测（注入 dir 时不加载 electron）。
 */

const fs = require("fs");
const path = require("path");

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const TEXT_FIELDS = [
  "id",
  "pt",
  "group",
  "phone",
  "partition",
  "accountKey",
  "textType",
  "publishStatus",
  "title",
  "bt",
  "textOtherName",
  "bookName",
  "shortTitle",
  "bt2Filled",
  "selectedFile",
  "filePath",
  "videoLink",
];

/** 文本字段类型校验：仅接受 string 或有限 number，对象/数组/null 等视为空串，绝不调用 toString */
function toSafeText(v) {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return "";
}

function isValidYmd(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return false;
  }
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === dateStr;
}

/** 获取默认 pushData 目录：<Documents>/MatrixMedia/data/pushData */
function getPushDataDir() {
  const { app } = require("electron");
  const documents = app.getPath("documents");
  return path.join(documents, "MatrixMedia", "data", "pushData");
}

/**
 * 读取 pushData 下全部 YYYY-MM-DD.json 记录并按日期升序平铺返回。
 *
 * - 目录不存在：返回 []
 * - 非 YYYY-MM-DD.json 文件：静默忽略
 * - 单文件读失败 / JSON 损坏 / 根结构非数组：console.warn 并跳过，继续读取其余文件
 *
 * @param {object|string} [options]  可传 `{ dir, from, to }` 或直接传目录路径字符串
 * @returns {Array<object>}
 */
function readPushRecords(options) {
  let dir = "";
  let fromStr = "";
  let toStr = "";

  if (typeof options === "string") {
    dir = options.trim();
  } else if (options && typeof options === "object") {
    if (typeof options.dir === "string" && options.dir.trim()) {
      dir = options.dir.trim();
    }
    if (typeof options.from === "string" && options.from.trim()) {
      fromStr = options.from.trim();
    }
    if (typeof options.to === "string" && options.to.trim()) {
      toStr = options.to.trim();
    }
  }

  if (!dir) {
    dir = getPushDataDir();
  }

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    console.warn(
      `[dataStats] 读取 pushData 目录失败 (${dir}):`,
      (err && err.message) || err
    );
    return [];
  }

  const dateFiles = [];
  for (const name of entries) {
    const match = DATE_FILE_RE.exec(name);
    if (!match) continue;
    const date = match[1];
    if (!isValidYmd(date)) continue;
    if (fromStr && date < fromStr) continue;
    if (toStr && date > toStr) continue;
    dateFiles.push({ name, date });
  }
  dateFiles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const records = [];
  for (const f of dateFiles) {
    const filePath = path.join(dir, f.name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.warn(
        `[dataStats] 读取 pushData 文件失败，已跳过 (${filePath}):`,
        (err && err.message) || err
      );
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(
        `[dataStats] pushData JSON 损坏，已跳过 (${filePath}):`,
        (err && err.message) || err
      );
      continue;
    }
    if (!Array.isArray(parsed)) {
      console.warn(
        `[dataStats] pushData 结构无效（非数组），已跳过 (${filePath})`
      );
      continue;
    }
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const sanitized = {
        ...item,
        date: f.date,
      };
      for (const field of TEXT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(item, field)) {
          sanitized[field] = toSafeText(item[field]);
        }
      }
      records.push(sanitized);
    }
  }

  return records;
}

module.exports = {
  getPushDataDir,
  readPushRecords,
};
