"use strict";

import {
  legacyPhoneGroup,
  recordAccountKeyOf,
} from "./accountIdentity.js";
import {
  platformSupportsAiChapters,
  platformSupportsOriginalStatement,
  resolvePublishExtrasForPlatform,
} from "./publishExtras.js";

export function normalizeAccountPublishSettings(settings = {}) {
  const out = {
    defaultPublishToDraft: Boolean(settings.defaultPublishToDraft),
    useRealBrowser: Boolean(settings.useRealBrowser),
  };
  if (typeof settings.aiChapters === "boolean") {
    out.aiChapters = settings.aiChapters;
  }
  if (typeof settings.originalStatement === "boolean") {
    out.originalStatement = settings.originalStatement;
  }
  return out;
}

export function isDefaultPublishToDraftEnabled(account = {}) {
  return Boolean(account.defaultPublishToDraft);
}

export function resolveEffectivePublishMode(requestDraftMode, account = {}) {
  // 使用真实浏览器时，仍然尊重用户主动选择的草稿模式和账号级别的默认草稿设置。
  // 真实浏览器同样支持点击"暂存离开"按钮进行草稿发布，不应静默覆盖用户意图。
  const publishToDraft =
    Boolean(requestDraftMode) || isDefaultPublishToDraftEnabled(account);
  return {
    publishMode: publishToDraft ? "draft" : "publish",
    publishToDraft,
  };
}

/**
 * 结合「单次显式值」+「账号发布设置」+「全局发布设置」算出平台生效的 AI 章节与原创声明开关。
 * 不支持的平台对应字段返回 undefined。
 */
export function resolveEffectiveAccountPublishExtras(
  pt,
  {
    explicitAiChapters,
    explicitOriginalStatement,
    account = {},
    globalSettings = {},
  } = {}
) {
  return resolvePublishExtrasForPlatform(pt, {
    explicitAiChapters,
    explicitOriginalStatement,
    accountSettings: account || {},
    globalSettings: globalSettings || {},
  });
}

export function updateAccountTreePublishSettings(accountTree = {}, patch = {}) {
  const targetPt = String(patch.pt || "");
  const nextTree = JSON.parse(JSON.stringify(accountTree || {}));
  if (!targetPt) return nextTree;

  // 匹配键：优先 accountKey（新分组模型，同一登录态只属一个平台账号），
  // patch 未携带 accountKey 时回退历史 phone "-" 前缀匹配
  const targetKey = patch.accountKey
    ? String(patch.accountKey)
    : legacyPhoneGroup(patch.phone);
  if (!targetKey) return nextTree;

  const supportsAi = platformSupportsAiChapters(targetPt);
  const supportsOriginal = platformSupportsOriginalStatement(targetPt);

  Object.keys(nextTree).forEach((phoneKey) => {
    const group = nextTree[phoneKey];
    const children = Array.isArray(group && group.children)
      ? group.children
      : [];
    children.forEach((child) => {
      // accountTree children 结构为 { meta: { phone, pt, ... }, ... }
      const meta = (child && child.meta) || child || {};
      const sameKey = recordAccountKeyOf(meta) === targetKey;
      const samePt = String(meta.pt || "") === targetPt;
      if (sameKey && samePt) {
        if (!child.meta) child.meta = {};
        child.meta.defaultPublishToDraft = Boolean(patch.defaultPublishToDraft);
        if (typeof patch.useRealBrowser === "boolean") {
          child.meta.useRealBrowser = patch.useRealBrowser;
        }
        if (supportsAi && typeof patch.aiChapters === "boolean") {
          child.meta.aiChapters = patch.aiChapters;
        }
        if (supportsOriginal && typeof patch.originalStatement === "boolean") {
          child.meta.originalStatement = patch.originalStatement;
        }
      }
    });
  });

  return nextTree;
}
