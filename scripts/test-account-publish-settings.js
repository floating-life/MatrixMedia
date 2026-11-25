"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
});

const assert = require("assert");
const {
  isDefaultPublishToDraftEnabled,
  normalizeAccountPublishSettings,
  resolveEffectivePublishMode,
  resolveEffectiveAccountPublishExtras,
  updateAccountTreePublishSettings,
} = require("../src/shared/accountPublishSettings");

assert.deepStrictEqual(normalizeAccountPublishSettings({}), {
  defaultPublishToDraft: false,
  useRealBrowser: false,
});
assert.deepStrictEqual(
  normalizeAccountPublishSettings({
    defaultPublishToDraft: true,
    useRealBrowser: true,
    aiChapters: false,
    originalStatement: false,
  }),
  {
    defaultPublishToDraft: true,
    useRealBrowser: true,
    aiChapters: false,
    originalStatement: false,
  }
);

assert.strictEqual(isDefaultPublishToDraftEnabled({}), false);
assert.strictEqual(
  isDefaultPublishToDraftEnabled({ defaultPublishToDraft: true }),
  true
);

assert.deepStrictEqual(resolveEffectivePublishMode(false, {}), {
  publishMode: "publish",
  publishToDraft: false,
});
assert.deepStrictEqual(
  resolveEffectivePublishMode(false, { defaultPublishToDraft: true }),
  {
    publishMode: "draft",
    publishToDraft: true,
  }
);
assert.deepStrictEqual(resolveEffectivePublishMode(true, {}), {
  publishMode: "draft",
  publishToDraft: true,
});

// AI 章节与原创声明优先级及平台过滤
const xhsExtrasDefault = resolveEffectiveAccountPublishExtras("小红书", {});
assert.strictEqual(xhsExtrasDefault.aiChapters, true);
assert.strictEqual(xhsExtrasDefault.originalStatement, true);

const sphAccountOff = resolveEffectiveAccountPublishExtras("视频号", {
  account: { originalStatement: false },
  globalSettings: { defaultOriginalStatement: true },
});
assert.strictEqual(sphAccountOff.aiChapters, undefined);
assert.strictEqual(sphAccountOff.originalStatement, false);

const dyExplicitOff = resolveEffectiveAccountPublishExtras("抖音", {
  explicitAiChapters: false,
  account: { aiChapters: true },
  globalSettings: { defaultAiChapters: true },
});
assert.strictEqual(dyExplicitOff.aiChapters, false);
assert.strictEqual(dyExplicitOff.originalStatement, undefined);

const accountTree = {
  13800138000: {
    children: [
      {
        meta: {
          pt: "小红书",
          phone: "13800138000",
          defaultPublishToDraft: false,
        },
      },
      {
        meta: {
          pt: "抖音",
          phone: "13800138000",
          defaultPublishToDraft: false,
        },
      },
    ],
  },
};
const nextTree = updateAccountTreePublishSettings(accountTree, {
  phone: "13800138000-备注",
  pt: "小红书",
  defaultPublishToDraft: true,
  aiChapters: false,
  originalStatement: false,
});
assert.strictEqual(
  nextTree["13800138000"].children[0].meta.defaultPublishToDraft,
  true
);
assert.strictEqual(nextTree["13800138000"].children[0].meta.aiChapters, false);
assert.strictEqual(
  nextTree["13800138000"].children[0].meta.originalStatement,
  false
);
assert.strictEqual(
  nextTree["13800138000"].children[1].meta.defaultPublishToDraft,
  false
);
assert.strictEqual(
  accountTree["13800138000"].children[0].meta.defaultPublishToDraft,
  false
);

// 非支持平台（抖音不支持 originalStatement）不写入无效字段
const dyTree = updateAccountTreePublishSettings(accountTree, {
  phone: "13800138000",
  pt: "抖音",
  defaultPublishToDraft: false,
  aiChapters: false,
  originalStatement: false,
});
assert.strictEqual(dyTree["13800138000"].children[1].meta.aiChapters, false);
assert.strictEqual(
  dyTree["13800138000"].children[1].meta.originalStatement,
  undefined
);

console.log("test-account-publish-settings passed");
