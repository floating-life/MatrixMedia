"use strict";

import { resolvePublishPlatform } from "./publishPlatforms.js";

/**
 * 发布扩展字段单一真源（零 Electron / fs 依赖，主进程 / 渲染进程 / CLI / HTTP / 单测共用）：
 * - aiChapters：AI 自动章节（布尔，默认 true；仅抖音 / 快手 / 小红书生效，其他平台忽略）
 * - originalStatement：原创声明（布尔，默认 true；仅小红书 / 视频号生效，其他平台忽略）
 *
 * 二者与 creativeStatement（创作声明 / AI 声明）完全独立存取与展示，互不覆盖。
 */

export const DEFAULT_AI_CHAPTERS = true;
export const DEFAULT_ORIGINAL_STATEMENT = true;

export const AI_CHAPTERS_PLATFORMS = Object.freeze(["抖音", "快手", "小红书"]);
export const ORIGINAL_STATEMENT_PLATFORMS = Object.freeze(["小红书", "视频号"]);

export const NO_ORIGINAL_QUALIFICATION_MESSAGE =
  "账号无原创资格，可在发布设置关闭原创声明";

export const AI_CHAPTERS_STATUS = Object.freeze({
  ENABLED: "enabled",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
  SKIPPED: "skipped",
});

export const ORIGINAL_STATEMENT_STATUS = Object.freeze({
  ENABLED: "enabled",
  FAILED: "failed",
  NO_QUALIFICATION: "no_qualification",
  SKIPPED: "skipped",
});

const AI_CHAPTERS_STATUS_LABELS = Object.freeze({
  [AI_CHAPTERS_STATUS.ENABLED]: "已开启",
  [AI_CHAPTERS_STATUS.UNSUPPORTED]: "不支持",
  [AI_CHAPTERS_STATUS.FAILED]: "失败",
});

const ORIGINAL_STATEMENT_STATUS_LABELS = Object.freeze({
  [ORIGINAL_STATEMENT_STATUS.ENABLED]: "已开启",
  [ORIGINAL_STATEMENT_STATUS.FAILED]: "失败",
  [ORIGINAL_STATEMENT_STATUS.NO_QUALIFICATION]: "无原创资格",
});

const EXTRA_PLATFORM_ALIASES = Object.freeze({
  抖音: "抖音",
  dy: "抖音",
  douyin: "抖音",
  快手: "快手",
  ks: "快手",
  kuaishou: "快手",
  小红书: "小红书",
  xhs: "小红书",
  xiaohongshu: "小红书",
  red: "小红书",
  视频号: "视频号",
  微信视频号: "视频号",
  sph: "视频号",
  shipinhao: "视频号",
  wxvideo: "视频号",
  channels: "视频号",
  哔哩哔哩: "哔哩哔哩",
  b站: "哔哩哔哩",
  blbl: "哔哩哔哩",
  bilibili: "哔哩哔哩",
  bili: "哔哩哔哩",
  百家号: "百家号",
  百度百家号: "百家号",
  bjh: "百家号",
  baijiahao: "百家号",
  头条: "头条",
  今日头条: "头条",
  头条号: "头条",
  tt: "头条",
  toutiao: "头条",
  番茄视频: "番茄视频",
  番茄: "番茄视频",
  fqsp: "番茄视频",
  fanqie: "番茄视频",
  fq: "番茄视频",
});

const AI_CHAPTERS_PLATFORM_SET = new Set(AI_CHAPTERS_PLATFORMS);
const ORIGINAL_STATEMENT_PLATFORM_SET = new Set(ORIGINAL_STATEMENT_PLATFORMS);

const TRUTHY_STRINGS = new Set([
  "1",
  "true",
  "yes",
  "y",
  "on",
  "是",
  "开",
  "开启",
  "启用",
  "打开",
  "勾选",
  "声明",
  "已开启",
]);

const FALSY_STRINGS = new Set([
  "0",
  "false",
  "no",
  "n",
  "off",
  "否",
  "关",
  "关闭",
  "禁用",
  "不勾选",
  "不声明",
  "不开启",
  "无",
  "未开启",
]);

/**
 * 归一化平台名到规范中文名（兼容 code、常见别名及含平台名的文案）。
 * @param {string} pt
 * @returns {string}
 */
export function resolvePublishExtrasPlatform(pt) {
  const raw = String(pt || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (EXTRA_PLATFORM_ALIASES[raw]) return EXTRA_PLATFORM_ALIASES[raw];
  if (EXTRA_PLATFORM_ALIASES[lower]) return EXTRA_PLATFORM_ALIASES[lower];
  const fromShared = resolvePublishPlatform(raw);
  if (fromShared && EXTRA_PLATFORM_ALIASES[fromShared]) {
    return EXTRA_PLATFORM_ALIASES[fromShared];
  }
  if (raw.includes("抖音")) return "抖音";
  if (raw.includes("快手")) return "快手";
  if (raw.includes("小红书")) return "小红书";
  if (raw.includes("视频号")) return "视频号";
  if (raw.includes("哔哩哔哩") || lower.includes("b站")) return "哔哩哔哩";
  if (raw.includes("百家号")) return "百家号";
  if (raw.includes("头条")) return "头条";
  if (raw.includes("番茄")) return "番茄视频";
  return fromShared || raw;
}

export function platformSupportsAiChapters(pt) {
  return AI_CHAPTERS_PLATFORM_SET.has(resolvePublishExtrasPlatform(pt));
}

export function platformSupportsOriginalStatement(pt) {
  return ORIGINAL_STATEMENT_PLATFORM_SET.has(resolvePublishExtrasPlatform(pt));
}

/**
 * 解析可选布尔输入（支持布尔、0/1、中英文「是/否/true/false/开启/关闭」）。
 * 空串 / null / undefined 视为「未显式指定」，交由下游回退发布设置默认值。
 *
 * @param {unknown} raw
 * @returns {{ specified: boolean, valid: boolean, value: boolean | null }}
 */
export function parsePublishExtraBoolean(raw) {
  if (raw === undefined || raw === null) {
    return { specified: false, valid: true, value: null };
  }
  if (typeof raw === "boolean") {
    return { specified: true, valid: true, value: raw };
  }
  if (typeof raw === "number") {
    if (raw === 1) return { specified: true, valid: true, value: true };
    if (raw === 0) return { specified: true, valid: true, value: false };
    return { specified: true, valid: false, value: null };
  }
  if (typeof raw === "string") {
    const cleaned = raw
      .replace(/[\uFEFF\u200B\u200C\u200D\u00A0]/g, "")
      .trim();
    if (!cleaned) {
      return { specified: false, valid: true, value: null };
    }
    const lower = cleaned.toLowerCase();
    if (TRUTHY_STRINGS.has(cleaned) || TRUTHY_STRINGS.has(lower)) {
      return { specified: true, valid: true, value: true };
    }
    if (FALSY_STRINGS.has(cleaned) || FALSY_STRINGS.has(lower)) {
      return { specified: true, valid: true, value: false };
    }
    return { specified: true, valid: false, value: null };
  }
  return { specified: true, valid: false, value: null };
}

/**
 * 仅在明确给出有效布尔值时返回 true/false，否则返回 null（未指定）。
 * @param {unknown} raw
 * @returns {boolean | null}
 */
export function parseOptionalBooleanFlag(raw) {
  const parsed = parsePublishExtraBoolean(raw);
  return parsed.specified && parsed.valid ? parsed.value : null;
}

/**
 * 按优先级解析单平台 aiChapters 与 originalStatement：
 * explicit（单条 / CLI / HTTP / xlsx / GUI） > accountSetting（账号发布设置） > globalDefault（全局发布设置） > 系统默认 true。
 * 不支持的平台对应字段返回 undefined（忽略该字段，不污染入参和记录）。
 *
 * @param {string} pt
 * @param {{
 *   explicitAiChapters?: unknown,
 *   explicitOriginalStatement?: unknown,
 *   accountSettings?: { aiChapters?: boolean, originalStatement?: boolean } | null,
 *   globalSettings?: { defaultAiChapters?: boolean, defaultOriginalStatement?: boolean } | null,
 * }} [options]
 * @returns {{
 *   platform: string,
 *   aiChaptersSupported: boolean,
 *   aiChapters: boolean | undefined,
 *   originalStatementSupported: boolean,
 *   originalStatement: boolean | undefined,
 * }}
 */
export function resolvePublishExtrasForPlatform(pt, options = {}) {
  const platform = resolvePublishExtrasPlatform(pt);
  const aiChaptersSupported = AI_CHAPTERS_PLATFORM_SET.has(platform);
  const originalStatementSupported =
    ORIGINAL_STATEMENT_PLATFORM_SET.has(platform);

  const accountSettings =
    options && options.accountSettings && typeof options.accountSettings === "object"
      ? options.accountSettings
      : {};
  const globalSettings =
    options && options.globalSettings && typeof options.globalSettings === "object"
      ? options.globalSettings
      : {};

  let aiChapters;
  if (aiChaptersSupported) {
    const exp = parseOptionalBooleanFlag(options.explicitAiChapters);
    const acc = parseOptionalBooleanFlag(accountSettings.aiChapters);
    const glob = parseOptionalBooleanFlag(
      globalSettings.defaultAiChapters !== undefined
        ? globalSettings.defaultAiChapters
        : globalSettings.aiChapters
    );
    aiChapters =
      exp !== null
        ? exp
        : acc !== null
        ? acc
        : glob !== null
        ? glob
        : DEFAULT_AI_CHAPTERS;
  }

  let originalStatement;
  if (originalStatementSupported) {
    const exp = parseOptionalBooleanFlag(options.explicitOriginalStatement);
    const acc = parseOptionalBooleanFlag(accountSettings.originalStatement);
    const glob = parseOptionalBooleanFlag(
      globalSettings.defaultOriginalStatement !== undefined
        ? globalSettings.defaultOriginalStatement
        : globalSettings.originalStatement
    );
    originalStatement =
      exp !== null
        ? exp
        : acc !== null
        ? acc
        : glob !== null
        ? glob
        : DEFAULT_ORIGINAL_STATEMENT;
  }

  return {
    platform,
    aiChaptersSupported,
    aiChapters,
    originalStatementSupported,
    originalStatement,
  };
}

/**
 * 从任务对象 / 历史记录提取显式指定的布尔值（不自动补默认值，避免污染未支持平台或旧单测 mock）。
 * 优先级：data[field] > publishOptions[field] > root[field]
 */
function readExplicitBooleanFromTask(task, field) {
  if (!task || typeof task !== "object") return undefined;
  if (task.data && typeof task.data === "object" && typeof task.data[field] === "boolean") {
    return task.data[field];
  }
  if (
    task.publishOptions &&
    typeof task.publishOptions === "object" &&
    typeof task.publishOptions[field] === "boolean"
  ) {
    return task.publishOptions[field];
  }
  if (typeof task[field] === "boolean") {
    return task[field];
  }
  return undefined;
}

export function readTaskAiChapters(task) {
  return readExplicitBooleanFromTask(task, "aiChapters");
}

export function readTaskOriginalStatement(task) {
  return readExplicitBooleanFromTask(task, "originalStatement");
}

/** 仅当显式开启（=== true）时返回 true；关闭（false）或未传入时返回 false（不触碰页面） */
export function isAiChaptersRequested(task) {
  return readTaskAiChapters(task) === true;
}

/** 仅当显式开启（=== true）时返回 true；关闭（false）或未传入时返回 false（不触碰页面） */
export function isOriginalStatementRequested(task) {
  // 2026-11-27 用户定：原创声明功能整体关闭（视频号无资格/弹窗阻断上传，改为手机端手动勾选）。
  // 仅测试或将来需要时以环境变量 MM_ENABLE_ORIGINAL_STATEMENT=1 重新打开。
  if (
    typeof process === "undefined" ||
    !process.env ||
    process.env.MM_ENABLE_ORIGINAL_STATEMENT !== "1"
  ) {
    return false;
  }
  return readTaskOriginalStatement(task) === true;
}

/**
 * 格式化 AI 章节回执片段：「章节：已开启」「章节：不支持」「章节：失败」。
 * 未执行（skipped / 空）返回空串。
 * @param {string} status
 * @returns {string}
 */
export function formatAiChaptersReceipt(status) {
  const key = String(status || "").trim();
  const label = AI_CHAPTERS_STATUS_LABELS[key];
  return label ? `章节：${label}` : "";
}

export function formatAiChaptersStatusLabel(status, fallbackEnabled) {
  const key = String(status || "").trim();
  if (AI_CHAPTERS_STATUS_LABELS[key]) return AI_CHAPTERS_STATUS_LABELS[key];
  if (fallbackEnabled === true) return "开";
  if (fallbackEnabled === false) return "关";
  return "";
}

export function formatOriginalStatementStatusLabel(status, fallbackEnabled) {
  const key = String(status || "").trim();
  if (ORIGINAL_STATEMENT_STATUS_LABELS[key]) {
    return ORIGINAL_STATEMENT_STATUS_LABELS[key];
  }
  if (fallbackEnabled === true) return "开";
  if (fallbackEnabled === false) return "关";
  return "";
}

/**
 * 将「章节：已开启/不支持/失败」等补充说明拼接进发布回执文案（幂等，不重复拼接）。
 * @param {string} baseMessage
 * @param {string} note
 * @returns {string}
 */
export function appendPublishReceiptNote(baseMessage, note) {
  const base = String(baseMessage || "").trim();
  const extra = String(note || "").trim();
  if (!extra) return base;
  if (!base) return extra;
  if (base.includes(extra)) return base;
  return `${base}（${extra}）`;
}

/**
 * 构造无原创资格失败错误（包含规定文案「账号无原创资格，可在发布设置关闭原创声明」）。
 * @param {string} platformLabel
 * @param {string} [detail]
 * @returns {Error}
 */
export function createNoOriginalQualificationError(platformLabel, detail = "") {
  const prefix = platformLabel ? `${platformLabel}原创声明失败：` : "";
  const suffix = detail ? `（${detail}）` : "";
  const err = new Error(
    `${prefix}${NO_ORIGINAL_QUALIFICATION_MESSAGE}${suffix}，已中止本条${
      platformLabel || ""
    }发布，未发布`
  );
  err.originalStatementError = true;
  err.noOriginalQualification = true;
  return err;
}

/**
 * 构造一般原创声明设置失败错误（中止发布，宁可不发）。
 * @param {string} platformLabel
 * @param {string} stage
 * @param {string} reason
 * @returns {Error}
 */
export function createOriginalStatementError(platformLabel, stage, reason) {
  const stagePart = stage ? `（${stage}）` : "";
  const err = new Error(
    `${platformLabel || ""}原创声明设置失败${stagePart}：${
      reason || "未知原因"
    }，已中止本条${platformLabel || ""}发布，未发布`
  );
  err.originalStatementError = true;
  return err;
}

/**
 * 为受支持平台构造需写入 data / publishOptions / record 的扩展字段补丁（未支持平台返回空对象）。
 * @param {string} pt
 * @param {{ aiChapters?: boolean, originalStatement?: boolean }} resolved
 * @returns {{ aiChapters?: boolean, originalStatement?: boolean }}
 */
export function buildPlatformExtrasPatch(pt, resolved = {}) {
  const patch = {};
  if (
    platformSupportsAiChapters(pt) &&
    typeof resolved.aiChapters === "boolean"
  ) {
    patch.aiChapters = resolved.aiChapters;
  }
  if (
    platformSupportsOriginalStatement(pt) &&
    typeof resolved.originalStatement === "boolean"
  ) {
    patch.originalStatement = resolved.originalStatement;
  }
  return patch;
}

/**
 * 构造发布历史中用于独立展示的标签清单（与创作声明分离、各自显示）。
 * @param {object} record
 * @returns {Array<{ key: string, label: string, value: string, tone: string }>}
 */
export function buildHistoryExtrasDisplay(record) {
  if (!record || typeof record !== "object") return [];
  const items = [];
  const pt = record.pt || record.platform || "";

  if (platformSupportsAiChapters(pt)) {
    const enabled = readTaskAiChapters(record);
    const status = String(record.aiChaptersStatus || "").trim();
    if (status || typeof enabled === "boolean") {
      const value = formatAiChaptersStatusLabel(status, enabled);
      if (value) {
        const tone =
          status === AI_CHAPTERS_STATUS.FAILED
            ? "warning"
            : status === AI_CHAPTERS_STATUS.UNSUPPORTED
            ? "info"
            : enabled === false
            ? "info"
            : "success";
        items.push({ key: "aiChapters", label: "AI章节", value, tone });
      }
    }
  }

  if (platformSupportsOriginalStatement(pt)) {
    const enabled = readTaskOriginalStatement(record);
    const status = String(record.originalStatementStatus || "").trim();
    if (status || typeof enabled === "boolean") {
      const value = formatOriginalStatementStatusLabel(status, enabled);
      if (value) {
        const tone =
          status === ORIGINAL_STATEMENT_STATUS.FAILED ||
          status === ORIGINAL_STATEMENT_STATUS.NO_QUALIFICATION
            ? "danger"
            : enabled === false
            ? "info"
            : "success";
        items.push({ key: "originalStatement", label: "原创声明", value, tone });
      }
    }
  }

  return items;
}
