"use strict";

/**
 * 合集公共纯逻辑与平台提交按钮选择器常量（单一来源）。
 *
 * 1. normalizeCollectionName / collapseCollectionText 供 collection.js 页面匹配与回读、
 *    以及 publishThrottle.js 排期复用冲突比较共同使用，保证「民 间故事」与「民间故事」语义一致；
 * 2. 平台提交/存草稿按钮选择器常量供 dy.js / sph.js 与 collection.js safeClick 共同复用，
 *    避免复制粘贴导致选择器漂移。
 */

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

/** 去所有空白字符，用于页面合集名精确匹配、回读校验与排期复用冲突比较（单一来源） */
export function collapseCollectionText(value) {
  return normalizeCollectionName(value).replace(/\s+/g, "");
}

/**
 * 去掉合集选项 / 回读文本尾部的作品计数后缀（如「共21个作品」「21个作品」「/ 共10个作品」「（共21个作品）」）。
 * 仅用于页面候选项匹配、候选列表展示与回读归一化，不得截断正常合集名（如「民间故事续集」「民间故事2」）。
 */
export const COLLECTION_COUNT_SUFFIX_RE =
  /(?:\s*[/·•|｜]\s*|\s+[-—]\s+|\s*)(?:[\(（]\s*(?:共\s*)?\d+\s*(?:个|条|篇|部)?\s*(?:作品|视频)\s*[\)）]|(?:共\s*)?\d+\s*(?:个|条|篇|部)?\s*(?:作品|视频))$/;

export function stripCollectionCountSuffix(value) {
  const cleaned = normalizeCollectionName(value);
  if (!cleaned) return "";
  return cleaned.replace(COLLECTION_COUNT_SUFFIX_RE, "").trim();
}

/** 禁止被当作目标合集选中的「不选/清空」选项文案（精确匹配，去空白后比较） */
export const NON_COLLECTION_OPTION_TEXTS = Object.freeze(["不选择合集"]);

export function isNonCollectionOptionText(value) {
  const raw = collapseCollectionText(value);
  if (!raw) return false;
  const stripped = collapseCollectionText(stripCollectionCountSuffix(value));
  for (let i = 0; i < NON_COLLECTION_OPTION_TEXTS.length; i++) {
    const item = NON_COLLECTION_OPTION_TEXTS[i];
    if (raw === item || (stripped && stripped === item)) {
      return true;
    }
  }
  return false;
}

/** 各平台提交 / 存草稿按钮选择器常量（与 dy.js / ks.js / sph.js 保持单一真源） */
export const DY_PUBLISH_BUTTON_SELECTOR = "#popover-tip-container";
export const DY_DRAFT_BUTTON_SELECTOR = "#popover-tip-container+button";
export const KS_SUBMIT_BAR_SELECTOR = "#setting-tours + div";
export const SPH_DRAFT_BUTTON_SELECTOR = ".form-btns>div:first-child button";
export const SPH_PUBLISH_BUTTON_SELECTOR = ".form-btns>div:last-child button";

export const PLATFORM_SUBMIT_SELECTORS = Object.freeze({
  dy: Object.freeze([DY_PUBLISH_BUTTON_SELECTOR, DY_DRAFT_BUTTON_SELECTOR]),
  ks: Object.freeze([
    KS_SUBMIT_BAR_SELECTOR,
    `${KS_SUBMIT_BAR_SELECTOR} button`,
    `${KS_SUBMIT_BAR_SELECTOR} > div`,
    `${KS_SUBMIT_BAR_SELECTOR} [role='button']`,
  ]),
  sph: Object.freeze([SPH_DRAFT_BUTTON_SELECTOR, SPH_PUBLISH_BUTTON_SELECTOR]),
});

export const ALL_PLATFORM_SUBMIT_SELECTORS = Object.freeze([
  ...PLATFORM_SUBMIT_SELECTORS.dy,
  ...PLATFORM_SUBMIT_SELECTORS.ks,
  ...PLATFORM_SUBMIT_SELECTORS.sph,
]);
