"use strict";

import {
  resolveEffectivePublishMode,
  resolveEffectiveAccountPublishExtras,
  isDefaultPublishToDraftEnabled,
} from "../../shared/accountPublishSettings.js";
import { findAccountRecordFlexible } from "./accountLookup.js";

/**
 * 从账号数据源查匹配 phone/partition + pt 的账号记录（新分组模型兼容版）。
 * 匹配优先级见 accountLookup：partition 精确 > phone 全字 > phone "-" 前缀。
 * @param {{ phone?: string, pt?: string, partition?: string }} query
 * @returns {{ defaultPublishToDraft: boolean, aiChapters?: boolean, originalStatement?: boolean } | null}
 */
export function findAccountPublishSettings({ phone, pt, partition } = {}) {
  const targetPt = String(pt || "");
  if (!targetPt) return null;
  if (!String(phone || "").trim() && !String(partition || "").trim()) {
    return null;
  }

  try {
    const row = findAccountRecordFlexible({ phone, pt: targetPt, partition });
    if (row) {
      return {
        defaultPublishToDraft: isDefaultPublishToDraftEnabled(row),
        ...(typeof row.aiChapters === "boolean"
          ? { aiChapters: row.aiChapters }
          : {}),
        ...(typeof row.originalStatement === "boolean"
          ? { originalStatement: row.originalStatement }
          : {}),
      };
    }
  } catch (e) {
    console.warn(
      "[accountPublishSettingsResolver] 查询账号发布设置失败:",
      e && e.message
    );
  }
  return null;
}

/**
 * 结合「请求显式 draft」+「账号 defaultPublishToDraft」算出最终发布模式
 * @param {{ phone?: string, pt?: string, partition?: string, requestDraftMode?: boolean }} query
 * @returns {{ publishMode: "publish"|"draft", publishToDraft: boolean }}
 */
export function resolveAccountPublishMode({
  phone,
  pt,
  partition,
  requestDraftMode = false,
} = {}) {
  const settings =
    findAccountPublishSettings({ phone, pt, partition }) || {};
  return resolveEffectivePublishMode(requestDraftMode, settings);
}

/**
 * 结合「单次显式值」+「账号级发布设置」+「全局发布设置」算出最终生效的 aiChapters / originalStatement。
 * 不支持的平台对应字段返回 undefined。
 */
export function resolveAccountPublishExtras({
  phone,
  pt,
  partition,
  requestAiChapters,
  requestOriginalStatement,
  globalSettings = {},
} = {}) {
  const accountSettings =
    findAccountPublishSettings({ phone, pt, partition }) || {};
  return resolveEffectiveAccountPublishExtras(pt, {
    explicitAiChapters: requestAiChapters,
    explicitOriginalStatement: requestOriginalStatement,
    account: accountSettings,
    globalSettings,
  });
}
