"use strict";
/**
 * S10 收尾三处（GPT Pro 第三轮评审 S10-review3.out）：
 * 1 复用旧记录重新登记时，之前成功过的同一内容仍按 7 天查重拦截
 * 2 升级迁移：组内该平台只有一个账号时沿用旧的按分组作品数（告警不漏报）
 * 3 标签：与上游一致，字符串按空格/逗号等拆分，数组元素保持完整
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const t = require("../src/shared/textSanitize.js");
const dedupe = require("../src/shared/publishDedupe.js");

// 3 标签（与上游语义一致：字符串里空格也是分隔符；数组元素保持完整）
assert.deepStrictEqual(t.splitAndSanitizeTags("游戏 解说 开黑"), ["游戏", "解说", "开黑"]);
assert.deepStrictEqual(t.splitAndSanitizeTags("减脂,健身 教程"), ["减脂", "健身", "教程"]);
assert.deepStrictEqual(t.splitAndSanitizeTags("美食_x000d_\r\n旅行"), ["美食", "旅行"]);
assert.deepStrictEqual(t.splitAndSanitizeTags(["Final Cut Pro", "剪辑"]), ["Final Cut Pro", "剪辑"]);
assert.deepStrictEqual(t.splitHashtagTags("#旅行, 日常 旅行"), ["旅行", "日常"]);
console.log("✓ 3 标签拆分");

// 1 复用记录的上次成功时间
const now = Date.now();
const base = { id: "r1", pt: "掘金", phone: "A组", title: "首篇文章", textType: "article" };
const reused = { ...base, publishStatus: "publishing", lastPublishAt: now, priorSuccessAt: now - 3600e3 };
const cand = { pt: "掘金", phone: "A组", title: "首篇文章", textType: "article" };
assert.ok(dedupe.findRecentDuplicatePublish([reused], cand, { now, excludeRecordId: "r1" }), "复用且曾成功应拦截");
const fresh = { ...base, publishStatus: "publishing", lastPublishAt: now };
assert.strictEqual(dedupe.findRecentDuplicatePublish([fresh], cand, { now, excludeRecordId: "r1" }), null, "首发自身记录不应拦截");
const old = { ...reused, priorSuccessAt: now - 8 * 86400e3 };
assert.strictEqual(dedupe.findRecentDuplicatePublish([old], cand, { now, excludeRecordId: "r1" }), null, "7 天外不拦");
console.log("✓ 1 复用记录查重");

// 1b utils 复用登记写入 priorSuccessAt
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10f-"));
  const orig = Module._load;
  Module._load = function (req) {
    if (req === "electron") return { app: { getPath: () => tmp, getVersion: () => "t" } };
    return orig.apply(this, arguments);
  };
  try {
    const utils = require("../src/main/server/utils.js");
    const date = new Date().toISOString().slice(0, 10);
    const item = { id: "a1", date, pt: "掘金", phone: "A组", title: "首篇文章", textType: "article", bt1: "首篇文章" };
    utils.changeData({ fileName: "pushData", type: "add", item: { ...item } });
    const recs1 = dedupe.flattenPushDataRecords(utils.changeData({ fileName: "pushData", type: "get", item: { page: 1, pageSize: 100 } }).data);
    const r = recs1[0];
    utils.changeData({ fileName: "pushData", type: "update", item: { ...r, publishStatus: "success", lastPublishAt: now - 60e3 } });
    utils.changeData({ fileName: "pushData", type: "add", item: { ...item, id: "a2" } });
    const recs = dedupe.flattenPushDataRecords(utils.changeData({ fileName: "pushData", type: "get", item: { page: 1, pageSize: 100 } }).data);
    assert.strictEqual(recs.length, 1, "复用同一条记录");
    assert.ok(Number(recs[0].priorSuccessAt) > 0, "保留上次成功时间");
    assert.ok(dedupe.findRecentDuplicatePublish(recs, cand, { now, excludeRecordId: recs[0].id }), "第二次应被拦截");
  } finally {
    Module._load = orig;
  }
  console.log("✓ 1b 重新登记保留上次成功时间");
}

// 2 升级迁移作品数
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10f2-"));
  const orig = Module._load;
  Module._load = function (req) {
    if (req === "electron") return { app: { getPath: () => tmp, getVersion: () => "t" } };
    return orig.apply(this, arguments);
  };
  try {
    const sp = path.resolve(__dirname, "../src/main/services/dataStats/store.js");
    delete require.cache[sp];
    const store = require(sp);
    store.writeMeta("旧分组", "抖音", { lastCollectAt: now, lastError: "", workCount: 1 });
    const metaSole = { accountKey: "账号甲", groupPlatformAccountCount: 1 };
    assert.strictEqual(store.getPreviousWorkCount("旧分组", "抖音", metaSole), 1, "单账号沿用旧计数");
    const metaMulti = { accountKey: "账号乙", groupPlatformAccountCount: 2 };
    assert.strictEqual(store.getPreviousWorkCount("旧分组", "抖音", metaMulti), 0, "多账号不借用");
  } finally {
    Module._load = orig;
  }
  console.log("✓ 2 升级迁移作品数");
}
console.log("test-s10-final: 全部通过");
