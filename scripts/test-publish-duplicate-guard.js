"use strict";

/**
 * S10 #6 同平台重复发布拦截单测（修前失败、修后通过）：
 * 1. 7 天内同平台 + 同账号 + 清洗归一后标题相同的成功/进行中记录触发拦截（exitCode 6, status duplicate, message 含上次时间）
 * 2. 超过 7 天 / 不同平台 / 不同账号 / failed/skipped/login_required 记录不拦截
 * 3. CLI 默认拒绝返回退出码 6，--allow-duplicate 放行
 * 4. HTTP POST /publish 单平台拦截与 allowDuplicate: true 放行；多平台仅拦截重复平台，其余平台照常执行
 * 5. puppeteerFile.js 发布入口查重兜底（状态巡检不拦、allowDuplicate 放行、重复拦截）
 * 6. GUI LocalVideoPublish.vue 模板编译与确认框接线校验
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const Module = require("module");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");

const {
  DUPLICATE_EXIT_CODE,
  DUPLICATE_WINDOW_MS,
  flattenPushDataRecords,
  readPushDataRecords,
  findRecentDuplicatePublish,
  findDuplicatePublishesForTargets,
} = require("../src/shared/publishDedupe.js");

function testPureDedupeRules() {
  const now = Date.parse("2026-11-20T15:00:00+08:00");
  const twoDaysAgo = now - 2 * 86400000;
  const eightDaysAgo = now - 8 * 86400000;

  const records = [
    {
      id: "rec-1",
      pt: "抖音",
      phone: "A组-主号",
      partition: "persist:A组抖音",
      title: "AI效率神器_x000d_\n实测分享",
      publishStatus: "success",
      lastPublishAt: twoDaysAgo,
    },
    {
      id: "rec-2",
      pt: "快手",
      phone: "A组-主号",
      partition: "persist:A组快手",
      title: "已失败的视频",
      publishStatus: "failed",
      lastPublishAt: twoDaysAgo,
    },
    {
      id: "rec-3",
      pt: "视频号",
      phone: "A组-主号",
      partition: "persist:A组视频号",
      title: "超过七天的视频",
      publishStatus: "success",
      lastPublishAt: eightDaysAgo,
    },
    {
      id: "rec-4",
      pt: "小红书",
      phone: "A组-主号",
      partition: "persist:A组小红书",
      title: "正在发布中视频",
      publishStatus: "publishing",
      lastPublishAt: now - 300000,
    },
  ];

  // 同平台 + 同账号 + 清洗后同标题（含 _x000d_/换行差异）→ 拦截
  const hit1 = findRecentDuplicatePublish(
    records,
    { pt: "dy", phone: "A组-备注2", title: "  ai效率神器   实测分享 " },
    { now }
  );
  assert.ok(hit1, "清洗归一后标题相同应触发拦截");
  assert.strictEqual(hit1.status, "duplicate");
  assert.strictEqual(hit1.exitCode, DUPLICATE_EXIT_CODE);
  assert.strictEqual(hit1.exitCode, 6);
  assert.ok(hit1.message.includes("2026-11-18 15:00:00"), `message 必须写明上次发布时间: ${hit1.message}`);

  // 进行中（publishing）同样拦截
  const hitPub = findRecentDuplicatePublish(
    records,
    { pt: "小红书", phone: "A组", title: "正在发布中视频" },
    { now }
  );
  assert.ok(hitPub && hitPub.exitCode === 6, "进行中记录应拦截");

  // 不同平台不拦截
  assert.strictEqual(
    findRecentDuplicatePublish(records, { pt: "快手", phone: "A组", title: "AI效率神器 实测分享" }, { now }),
    null
  );

  // 不同账号不拦截
  assert.strictEqual(
    findRecentDuplicatePublish(records, { pt: "抖音", phone: "B组", title: "AI效率神器 实测分享" }, { now }),
    null
  );

  // failed 记录不拦截
  assert.strictEqual(
    findRecentDuplicatePublish(records, { pt: "快手", phone: "A组", title: "已失败的视频" }, { now }),
    null
  );

  // 超过 7 天不拦截
  assert.strictEqual(
    findRecentDuplicatePublish(records, { pt: "视频号", phone: "A组", title: "超过七天的视频" }, { now }),
    null
  );

  // 恰好 7 天边界内拦截，7 天 + 1ms 不拦截
  const edgeRec = [
    { id: "e1", pt: "抖音", phone: "A组", title: "边界测试", publishStatus: "success", lastPublishAt: now - DUPLICATE_WINDOW_MS },
  ];
  assert.ok(findRecentDuplicatePublish(edgeRec, { pt: "抖音", phone: "A组", title: "边界测试" }, { now }));
  assert.strictEqual(
    findRecentDuplicatePublish(edgeRec, { pt: "抖音", phone: "A组", title: "边界测试" }, { now: now + 1 }),
    null
  );

  // 多目标批量检查只命中重复项
  const batchHits = findDuplicatePublishesForTargets(
    records,
    [
      { pt: "抖音", phone: "A组", title: "AI效率神器 实测分享" },
      { pt: "快手", phone: "A组", title: "AI效率神器 实测分享" },
    ],
    { now }
  );
  assert.strictEqual(batchHits.length, 1);
  assert.strictEqual(batchHits[0].index, 0);

  console.log("✓ 1. publishDedupe 7 天窗口、清洗归一标题、状态与账号隔离规则验证通过");
}

async function testHttpPublishRouteDedupe() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-http-dup-"));
  const videoFile = path.join(tmpDir, "clip.mp4");
  fs.writeFileSync(videoFile, "video-stub");

  const now = Date.now();
  const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  // 使用真实 server/utils.js changeData({ fileName: "pushData", type: "get" }) 返回的按日期分组对象结构
  const mockRecords = {
    [todayKey]: [
      {
        id: "http-rec-1",
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        title: "重发测试标题",
        publishStatus: "success",
        lastPublishAt: now - 3600000,
      },
      {
        id: "http-rec-2",
        pt: "抖音",
        phone: "B组",
        partition: "persist:B组抖音",
        title: "重发测试标题",
        publishStatus: "success",
        lastPublishAt: now - 1800000,
      },
      {
        id: "http-rec-3",
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        title: "样例_x000d_\r\n互动",
        publishStatus: "success",
        lastPublishAt: now - 3600000,
      },
    ],
  };

  // 使用 esbuild 打包 routes/index.js（把动态 import() 转为可注入 stub 的 require）
  const routesBundle = path.join(tmpDir, "routesIndex.cjs");
  const stubState = {
    singleCalls: [],
    multiCalls: [],
    bypassCalls: [],
  };
  global.__MM_S10_HTTP_STUB__ = { mockRecords, stubState };

  const utilsStub = path.join(tmpDir, "utilsStub.js");
  const guardStub = path.join(tmpDir, "guardStub.js");
  const publishStub = path.join(tmpDir, "publishStub.js");
  const lookupStub = path.join(tmpDir, "lookupStub.js");
  const pupStub = path.join(tmpDir, "pupStub.js");
  const alertStub = path.join(tmpDir, "alertStub.js");
  fs.writeFileSync(
    utilsStub,
    `module.exports = {
      changeData: ({ fileName, type }) => {
        if (fileName === "pushData" && type === "get") {
          return { success: true, data: global.__MM_S10_HTTP_STUB__.mockRecords };
        }
        return { success: true, data: [] };
      },
    };`
  );
  fs.writeFileSync(guardStub, `module.exports = { isTrustedLocalRequest: () => true };`);
  fs.writeFileSync(
    publishStub,
    `export async function runSingleFilePublish(v) {
      global.__MM_S10_HTTP_STUB__.stubState.singleCalls.push(v);
      return { success: true, exitCode: 0, status: "success", message: "ok" };
    }
    export async function runMultiPlatformPublish(list) {
      global.__MM_S10_HTTP_STUB__.stubState.multiCalls.push(list);
      return {
        success: true,
        exitCode: 0,
        status: "submitted",
        total: list.length,
        succeeded: list.length,
        failed: 0,
        results: list.map((t) => ({
          platform: t.platform,
          phone: t.phone,
          success: true,
          exitCode: 0,
          status: "submitted",
          message: "已提交发布任务",
        })),
      };
    }`
  );
  fs.writeFileSync(
    lookupStub,
    `export function resolveTaskPartition({ partition, phone, pt }) {
      return partition || ("persist:" + String(phone || "").split("-")[0] + pt);
    }`
  );
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass(t) {
      global.__MM_S10_HTTP_STUB__.stubState.bypassCalls.push(t);
    }`
  );
  fs.writeFileSync(
    alertStub,
    `module.exports = { handleAccountCollectOutcome: () => ({ ok: true }) };`
  );

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/server/routes/index.js")],
    outfile: routesBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "express"],
    plugins: [
      {
        name: "stub-http-route-deps",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/utils$/ }, () => ({ path: utilsStub }));
          build.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({ path: guardStub }));
          build.onResolve({ filter: /services\/publishVideo\.js$/ }, () => ({ path: publishStub }));
          build.onResolve({ filter: /services\/accountLookup\.js$/ }, () => ({ path: lookupStub }));
          build.onResolve({ filter: /services\/puppeteerFile\.js$/ }, () => ({ path: pupStub }));
          build.onResolve({ filter: /services\/dataStats\/collectAlert\.js$/ }, () => ({ path: alertStub }));
        },
      },
    ],
  });

  const expressMod = require("express");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "express") return expressMod;
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDir, getVersion: () => "0.14.9-test" },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const router = require(routesBundle);
    const publishLayer = router.stack.find(
      (l) => l.route && l.route.path === "/publish" && l.route.methods.post
    );
    assert.ok(publishLayer, "路由应注册 POST /publish");
    const handler = publishLayer.route.stack[0].handle;

    const invoke = async (body) => {
      let statusCode = 200;
      let payload = null;
      const req = { method: "POST", body, headers: { origin: "http://localhost:30088" } };
      const res = {
        status(c) {
          statusCode = c;
          return this;
        },
        json(obj) {
          payload = obj;
          return this;
        },
      };
      await handler(req, res);
      return { statusCode, payload };
    };

    // 2a. 单平台默认拦截（带 _x000d_ 标题也能归一命中！）
    const rSingleBlocked = await invoke({
      platform: "dy",
      phone: "A组",
      file: videoFile,
      title: "重发测试_x000d__X000D_标题",
    });
    assert.strictEqual(rSingleBlocked.statusCode, 200);
    assert.strictEqual(rSingleBlocked.payload.success, false);
    assert.strictEqual(rSingleBlocked.payload.status, "duplicate");
    assert.strictEqual(rSingleBlocked.payload.exitCode, 6);
    assert.ok(rSingleBlocked.payload.message.includes("上次发布时间"));
    assert.strictEqual(stubState.singleCalls.length, 0, "重复拦截时不得触发发布");

    // 2b. 单平台传 allowDuplicate: true 放行
    const rSingleAllow = await invoke({
      platform: "dy",
      phone: "A组",
      file: videoFile,
      title: "重发测试标题",
      allowDuplicate: true,
    });
    assert.strictEqual(rSingleAllow.payload.success, true);
    assert.strictEqual(stubState.singleCalls.length, 1, "allowDuplicate: true 必须放行");

    // 2c. 多平台请求：dy 重复被拦截，ks 照常提交
    const rMultiPartial = await invoke({
      phone: "A组",
      file: videoFile,
      title: "重发测试标题",
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(stubState.multiCalls.length, 1, "剩余未重复平台应照常提交");
    assert.strictEqual(stubState.multiCalls[0].length, 1);
    assert.strictEqual(stubState.multiCalls[0][0].platform, "快手");
    assert.strictEqual(rMultiPartial.payload.results.length, 2);
    assert.strictEqual(rMultiPartial.payload.results[0].platform, "抖音");
    assert.strictEqual(rMultiPartial.payload.results[0].status, "duplicate");
    assert.strictEqual(rMultiPartial.payload.results[0].exitCode, 6);
    assert.strictEqual(rMultiPartial.payload.results[1].platform, "快手");
    assert.strictEqual(rMultiPartial.payload.results[1].success, true);

    // 2d. 多平台同平台不同账号按账号隔离 allowDuplicate
    const rMultiSamePt = await invoke({
      file: videoFile,
      title: "重发测试标题",
      platforms: [
        { platform: "dy", phone: "A组", allowDuplicate: false },
        { platform: "dy", phone: "B组", allowDuplicate: true },
      ],
    });
    assert.strictEqual(stubState.multiCalls.length, 2);
    assert.strictEqual(stubState.multiCalls[1].length, 1);
    assert.strictEqual(stubState.multiCalls[1][0].phone, "B组");
    assert.strictEqual(rMultiSamePt.payload.results[0].status, "duplicate");
    assert.strictEqual(rMultiSamePt.payload.results[1].success, true);

    // 2e. 多平台全部重复 → 不调用 publishService，返回 duplicate + exitCode 6
    const rMultiAllBlocked = await invoke({
      phone: "A组",
      file: videoFile,
      title: "重发测试标题",
      platforms: [{ platform: "dy", phone: "A组" }],
    });
    assert.strictEqual(stubState.multiCalls.length, 2);
    assert.strictEqual(rMultiAllBlocked.payload.status, "duplicate");
    assert.strictEqual(rMultiAllBlocked.payload.exitCode, 6);

    // 2f. S10-fix #6a：按日期分组真实结构下，历史为 `样例_x000d_\r\n互动`，现提交 `样例 互动` 同时请求抖音和快手 -> 仅提交快手
    const rSampleMulti = await invoke({
      phone: "A组",
      file: videoFile,
      title: "样例 互动",
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(stubState.multiCalls.length, 3);
    assert.strictEqual(stubState.multiCalls[2].length, 1);
    assert.strictEqual(stubState.multiCalls[2][0].platform, "快手");
    assert.strictEqual(rSampleMulti.payload.results[0].status, "duplicate");
    assert.strictEqual(rSampleMulti.payload.results[0].exitCode, 6);
    assert.strictEqual(rSampleMulti.payload.results[1].platform, "快手");
    assert.strictEqual(rSampleMulti.payload.results[1].success, true);

    console.log("✓ 2. HTTP POST /publish 按日期分组真实记录单/多平台拦截与 allowDuplicate 放行验证通过");
  } finally {
    delete global.__MM_S10_HTTP_STUB__;
    Module._load = origLoad;
    delete require.cache[routesBundle];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCliAndPuppeteerEntryDedupe() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-cli-dup-"));
  const videoFile = path.join(tmpDir, "sample.mp4");
  fs.writeFileSync(videoFile, "stub");

  // 3. 验证 puppeteerFile.js 发布的入口查重函数
  const pupBundle = path.join(tmpDir, "puppeteerFile.cjs");
  esbuild.buildSync({
    entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    outfile: pupBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
  });

  const origLoad = Module._load;
  const now = Date.now();
  const mockRecords = [
    {
      id: "p-1",
      pt: "抖音",
      phone: "A组",
      partition: "persist:A组抖音",
      title: "入口查重标题",
      publishStatus: "success",
      lastPublishAt: now - 600000,
    },
  ];
  const xlsxMod = require("xlsx");
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: { on: () => {}, handle: () => {} },
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.14.9-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "xlsx") return xlsxMod;
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const pup = require(pupBundle);
    const hit = pup.checkPublishEntryDuplicate(
      { pt: "抖音", phone: "A组", partition: "persist:A组抖音", data: { title: "入口查重_x000d_标题" } },
      mockRecords,
      { now, skipBypass: true }
    );
    assert.ok(hit && hit.exitCode === 6, "puppeteerFile 发布入口应拦截重复发布");

    assert.strictEqual(
      pup.checkPublishEntryDuplicate(
        { pt: "抖音", phone: "A组", partition: "persist:A组抖音", allowDuplicate: true, data: { title: "入口查重标题" } },
        mockRecords,
        { now }
      ),
      null,
      "allowDuplicate: true 应放行"
    );

    assert.strictEqual(
      pup.checkPublishEntryDuplicate(
        { pt: "抖音状态", phone: "A组", partition: "persist:A组抖音", data: { title: "入口查重标题" } },
        mockRecords,
        { now }
      ),
      null,
      "登录态巡检任务不应被重复发布拦截"
    );

    // 登记一次性 bypass 后放行一次，第二次未登记再拦
    pup.registerPublishDedupeBypass({ pt: "抖音", phone: "A组", partition: "persist:A组抖音", title: "入口查重标题" });
    assert.strictEqual(
      pup.checkPublishEntryDuplicate(
        { pt: "抖音", phone: "A组", partition: "persist:A组抖音", data: { title: "入口查重标题" } },
        mockRecords,
        { now }
      ),
      null,
      "已登记 bypass 应放行一次"
    );
    assert.ok(
      pup.checkPublishEntryDuplicate(
        { pt: "抖音", phone: "A组", partition: "persist:A组抖音", data: { title: "入口查重标题" } },
        mockRecords,
        { now }
      ),
      "bypass 消费后再次提交应重新拦截"
    );

    console.log("✓ 3. puppeteerFile.js 发布入口查重与一次性 bypass 验证通过");
  } finally {
    Module._load = origLoad;
    delete require.cache[pupBundle];
  }

  // 4. 验证 CLI publish 退出码 6 与 --allow-duplicate（通过 stub 模块打包 cli/index.js 验证）
  const cliBundle = path.join(tmpDir, "cliEntry.cjs");
  const singlePublishStub = path.join(tmpDir, "publishVideoStub.js");
  const utilsStub = path.join(tmpDir, "utilsStub.js");
  fs.writeFileSync(
    singlePublishStub,
    `let calls = 0;
     export function getCalls() { return calls; }
     export async function runSingleFilePublish(v) {
       calls += 1;
       return { exitCode: 0, status: "success", publishMode: "publish", message: "ok" };
     }`
  );
  const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  fs.writeFileSync(
    utilsStub,
    `export function changeData({ fileName, type }) {
       if (fileName === "pushData" && type === "get") {
         return {
           success: true,
           data: {
             ${JSON.stringify(todayKey)}: [
               {
                 id: "cli-dup-1",
                 pt: "抖音",
                 phone: "A组",
                 partition: "persist:A组抖音",
                 title: "CLI重复标题",
                 publishStatus: "success",
                 lastPublishAt: ${now - 1800000}
               },
               {
                 id: "cli-dup-sample",
                 pt: "抖音",
                 phone: "A组",
                 partition: "persist:A组抖音",
                 title: "样例_x000d_\\r\\n互动",
                 publishStatus: "success",
                 lastPublishAt: ${now - 3600000}
               }
             ]
           }
         };
       }
       return { success: true, data: {} };
     }`
  );

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/cli/index.js")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
    plugins: [
      {
        name: "stub-cli-deps",
        setup(build) {
          build.onResolve({ filter: /services\/publishVideo$/ }, () => ({ path: singlePublishStub }));
          build.onResolve({ filter: /server\/utils$/ }, () => ({ path: utilsStub }));
        },
      },
    ],
  });

  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        ipcMain: { on: () => {}, handle: () => {} },
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.14.9-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "xlsx") return xlsxMod;
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const cliMod = require(cliBundle);
    const out = [];
    const err = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    try {
      const code1 = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "CLI重复_x000d_标题",
      ]);
      assert.strictEqual(code1, 6, `CLI 重复发布应返回退出码 6，实际=${code1}`);
      const json1 = JSON.parse(out[out.length - 1]);
      assert.strictEqual(json1.status, "duplicate");
      assert.strictEqual(json1.exitCode, 6);
      assert.ok(json1.message.includes("上次发布时间"), `CLI message 必须含上次时间: ${json1.message}`);

      // 4b. S10-fix #6a：按日期分组真实结构下，历史为 `样例_x000d_\r\n互动`，CLI 提交 `样例 互动` -> duplicate / 6
      const codeSample = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "样例 互动",
      ]);
      assert.strictEqual(codeSample, 6, `真实按日期分组结构下 CLI 应拦截并返回 6，实际=${codeSample}`);

      // 4c. S10-fix #6b：CLI 使用 `-t '--allow-duplicate'` 不得吞掉标题值
      const codeOptionLikeTitle = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "--allow-duplicate",
      ]);
      assert.strictEqual(
        codeOptionLikeTitle,
        0,
        `-t '--allow-duplicate' 应按字面标题发布返回 0（不得报缺少标题退 2），实际=${codeOptionLikeTitle}`
      );
      const parsedOptTitle = cliMod.parsePublishArgs([
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "--allow-duplicate",
      ]);
      assert.strictEqual(parsedOptTitle.ok, true);
      assert.strictEqual(parsedOptTitle.value.title, "--allow-duplicate");
      assert.strictEqual(
        parsedOptTitle.value.allowDuplicate,
        false,
        "作为 -t 值的 --allow-duplicate 不得开启 allowDuplicate 开关"
      );

      // 带 --allow-duplicate 放行
      const code2 = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "CLI重复标题",
        "--allow-duplicate",
      ]);
      assert.strictEqual(code2, 0, `--allow-duplicate 应放行并返回 0，实际=${code2}`);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    console.log("✓ 4. CLI publish 按日期分组查重、-t '--allow-duplicate' 字面标题与 --allow-duplicate 放行验证通过");
  } finally {
    Module._load = origLoad;
    delete require.cache[cliBundle];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function testGuiLocalVideoPublishCheck() {
  const vueSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  const sfc = compiler.parseComponent(vueSrc);
  assert.ok(sfc.template && sfc.template.content, "LocalVideoPublish.vue 应含 <template>");
  const compiled = compiler.compile(sfc.template.content);
  assert.strictEqual(
    compiled.errors.length,
    0,
    `LocalVideoPublish.vue 模板编译报错: ${compiled.errors.join("; ")}`
  );
  assert.ok(vueSrc.includes("publish:check-duplicate"), "GUI 发布应调用 publish:check-duplicate IPC");
  assert.ok(vueSrc.includes("仍然发布"), "GUI 重复发布确认框应包含「仍然发布」按钮");
  assert.ok(vueSrc.includes("上次发布时间"), "GUI 确认框应显示上次发布时间");

  const docsHttp = fs.readFileSync(path.join(root, "docs/http-api.md"), "utf8");
  const docsCli = fs.readFileSync(path.join(root, "docs/cli.md"), "utf8");
  assert.ok(docsHttp.includes("allowDuplicate") && docsHttp.includes("duplicate"));
  assert.ok(docsCli.includes("--allow-duplicate") && docsCli.includes("collectAlert"));

  console.log("✓ 5. GUI LocalVideoPublish.vue 确认框接线、模板编译与文档字段校验通过");
}

function testRealDiskPushDataAndGuiCheck() {
  // S10-fix #6a：使用真实 server/utils.js 落盘 YYYY-MM-DD.json + readPushDataRecords 验证 GUI / 共享读取函数
  const tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-real-pushdata-"));
  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDocs },
      };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    const { changeData } = require(utilsPath);
    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const addRes = changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        title: "样例_x000d_\r\n互动",
        publishStatus: "success",
        lastPublishAt: now - 3600000,
        date: todayKey,
      },
    });
    assert.strictEqual(addRes.success, true);

    // 确认真实 changeData({ type: "get" }) 返回的是按日期分组对象（非数组）
    const rawGet = changeData({ fileName: "pushData", type: "get", item: { page: 1, pageSize: 10000 } });
    assert.strictEqual(rawGet.success, true);
    assert.strictEqual(Array.isArray(rawGet.data), false, "真实 pushData get 应返回按日期分组的对象");
    assert.ok(Array.isArray(rawGet.data[todayKey]) && rawGet.data[todayKey].length === 1);

    // 共享 readPushDataRecords 正确平铺并命中 GUI 查重
    const records = readPushDataRecords(changeData);
    assert.strictEqual(records.length, 1);
    const guiHits = findDuplicatePublishesForTargets(
      records,
      [{ pt: "抖音", phone: "A组", partition: "persist:A组抖音", title: "样例 互动" }],
      { now }
    );
    assert.strictEqual(guiHits.length, 1, "真实按日期分组结构下 GUI 查重必须命中");
    assert.strictEqual(guiHits[0].hit.status, "duplicate");
    assert.strictEqual(guiHits[0].hit.exitCode, 6);
    assert.ok(guiHits[0].hit.message.includes("上次发布时间"));

    // 兼容数组结构
    assert.strictEqual(flattenPushDataRecords(records).length, 1);
    assert.strictEqual(flattenPushDataRecords(rawGet).length, 1);
    assert.strictEqual(flattenPushDataRecords(rawGet.data).length, 1);

    // 确认三条入口与 puppeteerFile 统一调用 readPushDataRecords
    for (const rel of [
      "src/main/services/ipcMain.js",
      "src/main/cli/index.js",
      "src/main/server/routes/index.js",
      "src/main/services/puppeteerFile.js",
    ]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      assert.ok(src.includes("readPushDataRecords"), `${rel} 应使用共享 readPushDataRecords`);
    }
    console.log("✓ 6. 真实按日期分组 pushData（含磁盘读写）与四处入口共用 readPushDataRecords 验证通过");
  } finally {
    Module._load = origLoad;
    delete require.cache[utilsPath];
    fs.rmSync(tmpDocs, { recursive: true, force: true });
  }
}

async function testMcpPublishVideoDuplicateHandling() {
  // S10-fix #6c：用 esbuild 直接编译 mcp/src/tools/publish.ts 与 mcp/src/jobs.ts，
  // 实测 publish_video schema、allowDuplicate 透传 --allow-duplicate，以及 exit 6 duplicate 回执原样返回
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-mcp-dup-"));
  const publishBundle = path.join(tmpDir, "mcpPublish.mjs");
  const jobsBundle = path.join(tmpDir, "mcpJobs.mjs");
  await esbuild.build({
    entryPoints: [path.join(root, "mcp/src/tools/publish.ts")],
    outfile: publishBundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await esbuild.build({
    entryPoints: [path.join(root, "mcp/src/jobs.ts")],
    outfile: jobsBundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });

  const { publishVideoTool, handlePublishVideo } = await import(pathToFileURL(publishBundle).href);
  const { startJob, waitForJob, describeJob } = await import(pathToFileURL(jobsBundle).href);

  const argsLogFile = path.join(tmpDir, "argv.json");
  const modeFile = path.join(tmpDir, "mode.txt");
  const fakeBin = path.join(tmpDir, "fake-matrixmedia");
  const dupReceipt = {
    status: "duplicate",
    exitCode: 6,
    duplicate: true,
    platform: "抖音",
    phone: "13800138000",
    title: "样例 互动",
    lastPublishAt: 1795190400000,
    lastPublishAtText: "2026-11-21 16:00:00",
    message: "抖音（13800138000）近 7 天内已有相同标题「样例 互动」的发布成功记录（上次发布时间：2026-11-21 16:00:00），已拦截重复发布",
  };
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argsLogFile)}, JSON.stringify(process.argv.slice(2)));
const mode = fs.readFileSync(${JSON.stringify(modeFile)}, "utf8").trim();
if (mode === "dup") {
  console.log(${JSON.stringify(JSON.stringify(dupReceipt))});
  console.error(${JSON.stringify(dupReceipt.message)});
  process.exit(6);
}
console.log(JSON.stringify({ resultStatus: "success", publishMode: "publish", message: "上传成功" }));
process.exit(0);
`,
    "utf8"
  );
  fs.chmodSync(fakeBin, 0o755);

  const prevBin = process.env.MATRIXMEDIA_BIN;
  process.env.MATRIXMEDIA_BIN = fakeBin;
  try {
    // 1. schema 包含 allowDuplicate
    assert.ok(
      publishVideoTool &&
        publishVideoTool.inputSchema &&
        publishVideoTool.inputSchema.properties &&
        publishVideoTool.inputSchema.properties.allowDuplicate &&
        publishVideoTool.inputSchema.properties.allowDuplicate.type === "boolean",
      "MCP publish_video schema 必须含 boolean 类型的 allowDuplicate"
    );

    // 2. CLI 返回 exit 6 duplicate 回执时，原样返回 duplicate 状态与上次发布时间，绝不报「未知错误 exit 6」
    fs.writeFileSync(modeFile, "dup");
    const dupArgs = {
      platform: "dy",
      phone: "13800138000",
      file: "/tmp/demo.mp4",
      title: "样例 互动",
    };
    const dupRaw = await handlePublishVideo(dupArgs);
    const dupBody = JSON.parse(dupRaw);
    assert.strictEqual(dupBody.status, "duplicate");
    assert.strictEqual(dupBody.exitCode, 6);
    assert.strictEqual(dupBody.duplicate, true);
    assert.strictEqual(dupBody.lastPublishAt, dupReceipt.lastPublishAt);
    assert.strictEqual(dupBody.lastPublishAtText, dupReceipt.lastPublishAtText);
    assert.ok(dupBody.message.includes("2026-11-21 16:00:00"));
    const argvNoFlag = JSON.parse(fs.readFileSync(argsLogFile, "utf8"));
    assert.strictEqual(argvNoFlag.includes("--allow-duplicate"), false);

    // 2b. 经 jobs.ts runAsJob 同款包装（describeJob），exit 6 回执仍保持 duplicate 与上次发布时间
    const { job } = startJob(
      "publish_video",
      "dup-check-job",
      { platform: "dy", phone: "13800138000", title: "样例 互动", file: "/tmp/demo.mp4" },
      () => handlePublishVideo(dupArgs)
    );
    await waitForJob(job, 5000);
    assert.strictEqual(job.status, "succeeded");
    const described = describeJob(job);
    assert.strictEqual(described.status, "duplicate");
    assert.strictEqual(described.exitCode, 6);
    assert.strictEqual(described.lastPublishAtText, dupReceipt.lastPublishAtText);

    // 3. 传 allowDuplicate: true 透传 --allow-duplicate 给 CLI
    fs.writeFileSync(modeFile, "ok");
    const allowRaw = await handlePublishVideo({
      ...dupArgs,
      allowDuplicate: true,
    });
    const allowBody = JSON.parse(allowRaw);
    assert.strictEqual(allowBody.status, "success");
    const argvWithFlag = JSON.parse(fs.readFileSync(argsLogFile, "utf8"));
    assert.strictEqual(
      argvWithFlag.includes("--allow-duplicate"),
      true,
      "MCP allowDuplicate: true 必须转发 --allow-duplicate"
    );

    console.log("✓ 7. MCP publish_video allowDuplicate 透传与 exit 6 duplicate 回执原样返回验证通过");
  } finally {
    if (prevBin === undefined) delete process.env.MATRIXMEDIA_BIN;
    else process.env.MATRIXMEDIA_BIN = prevBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testS10Fix2_1_ArticleFirstPublishExcludesOwnRecord() {
  // S10-fix2 #1：空发布历史执行 cli publish-article -p juejin --phone A组 -t 首篇文章 --content 正文内容
  // 发布入口查重必须按记录 id 排除本次自己刚写入的 publishing 记录，进入上传并退出 0（修前匹配自身记录退出 3、历史记 failed）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-fix2-article-"));
  const origLoad = Module._load;
  const cliBundle = path.join(tmpDir, "cliArticle.cjs");
  const pupBundle = path.join(tmpDir, "pupEntry.cjs");
  const realUtilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[realUtilsPath];

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    outfile: pupBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
  });

  // 用真实 server/utils.js + 真实 checkPublishEntryDuplicate（拦截 doUpload 的上传器执行以验证查重闸门）
  const pupRunnerStub = path.join(tmpDir, "pupRunnerStub.js");
  fs.writeFileSync(
    pupRunnerStub,
    `const pupReal = require(${JSON.stringify(pupBundle)});
     export const checkPublishEntryDuplicate = pupReal.checkPublishEntryDuplicate;
     export const registerPublishDedupeBypass = pupReal.registerPublishDedupeBypass;
     export function runPuppeteerTask(data, transport, onFinish) {
       const dup = pupReal.checkPublishEntryDuplicate(data);
       if (dup) {
         transport.reply("puppeteerFile-done", {
           ...data,
           status: false,
           duplicate: true,
           publishStatus: "duplicate",
           exitCode: 6,
           message: dup.message,
         });
         if (onFinish) onFinish();
         return;
       }
       transport.reply("puppeteerFile-done", {
         ...data,
         status: true,
         message: "掘金文章上传成功",
       });
       if (onFinish) onFinish();
     }`
  );

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/cli/index.js")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
    plugins: [
      {
        name: "wire-real-check-stub-upload",
        setup(build) {
          build.onResolve({ filter: /services\/puppeteerFile$/ }, () => ({
            path: pupRunnerStub,
          }));
        },
      },
    ],
  });

  const xlsxModArt = require("xlsx");
  Module._load = function (request, parent, isMain) {
    if (request === "xlsx") return xlsxModArt;
    if (request === "electron") {
      return {
        ipcMain: { on: () => {}, handle: () => {} },
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.14.9-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const cliMod = require(cliBundle);
    const { changeData } = require(realUtilsPath);
    const out = [];
    const err = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    let code;
    try {
      code = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish-article",
        "-p",
        "juejin",
        "--phone",
        "A组",
        "-t",
        "首篇文章",
        "--content",
        "正文内容",
      ]);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    assert.strictEqual(
      code,
      0,
      `S10-fix2 #1 空历史首发掘金文章应进入上传并退出 0，实际=${code}，err=${err.join(" | ")}`
    );
    const records = readPushDataRecords(changeData);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].pt, "掘金");
    assert.strictEqual(records[0].bt, "首篇文章");
    assert.strictEqual(
      records[0].publishStatus,
      "success",
      `S10-fix2 #1 历史记录状态应为 success，实际=${records[0].publishStatus}`
    );

    // 反向校验：若 pushData 中确实存在另一条（不同 id 的）7 天内同标题文章记录，仍应被查重拦截
    const pupMod = require(pupBundle);
    const dupHit = pupMod.checkPublishEntryDuplicate(
      {
        pt: "掘金",
        phone: "A组",
        partition: "persist:A组掘金",
        textType: "article",
        recordId: "new-article-id",
        data: { title: "首篇文章" },
      },
      records
    );
    assert.ok(dupHit && dupHit.status === "duplicate", "已有另一条不同 id 的 7 天内文章记录时仍应拦截");

    // LocalArticlePublish.vue 同样透传 recordId 且模板编译通过
    const articleVueSrc = fs.readFileSync(
      path.join(root, "src/renderer/components/LocalArticlePublish.vue"),
      "utf8"
    );
    const sfc = compiler.parseComponent(articleVueSrc);
    const compiled = compiler.compile(sfc.template.content);
    assert.strictEqual(compiled.errors.length, 0);
    assert.ok(articleVueSrc.includes("recordId: pendingRecordId"));

    console.log("✓ 8. S10-fix2 #1 掘金文章首发按 recordId 排除自身记录并正常上传退出 0 验证通过");
  } finally {
    Module._load = origLoad;
    delete require.cache[cliBundle];
    delete require.cache[pupBundle];
    delete require.cache[realUtilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testS10Fix2_2_ScheduledAllowDuplicatePersistedAcrossAllThreeChains() {
  // S10-fix2 #2：同账号 1 小时前发过同标题，排期到 5 分钟后。
  // CLI --allow-duplicate、HTTP allowDuplicate:true、GUI 点「仍然发布」三条链路均把 allowDuplicate:true 持久化到定时任务记录，
  // 到点执行时（临时内存票据早已过期/不存在）均通过入口查重进入上传，不变成 failed。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s10-fix2-sched-"));
  const origLoad = Module._load;
  const videoFile = path.join(tmpDir, "sched.mp4");
  fs.writeFileSync(videoFile, "video");
  const cliBundle = path.join(tmpDir, "cliSched.cjs");
  const schedBundle = path.join(tmpDir, "schedPub.cjs");
  const pupBundle = path.join(tmpDir, "pupSched.cjs");
  const realUtilsPath = path.resolve(root, "src/main/server/utils.js");
  const realRoutePath = path.resolve(root, "src/main/server/routes/index.js");
  delete require.cache[realUtilsPath];
  delete require.cache[realRoutePath];

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/services/puppeteerFile.js")],
    outfile: pupBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
  });
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/services/scheduledPublish.js")],
    outfile: schedBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
    ],
  });
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/cli/index.js")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
  });

  const routesBundle = path.join(tmpDir, "routesSched.cjs");
  const guardStub = path.join(tmpDir, "guardSchedStub.js");
  fs.writeFileSync(guardStub, `module.exports = { isTrustedLocalRequest: () => true };`);
  await esbuild.build({
    entryPoints: [path.join(root, "src/main/server/routes/index.js")],
    outfile: routesBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "express",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
    plugins: [
      {
        name: "stub-http-sched-guard",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({ path: guardStub }));
        },
      },
    ],
  });

  const expressMod = require("express");
  const xlsxMod2 = require("xlsx");
  Module._load = function (request, parent, isMain) {
    if (request === "express") return expressMod;
    if (request === "xlsx") return xlsxMod2;
    if (request === "electron") {
      return {
        ipcMain: { on: () => {}, handle: () => {} },
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.14.9-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  function formatLocalYmdHms(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  try {
    const { changeData } = require(realUtilsPath);
    const cliMod = require(cliBundle);
    const schedMod = require(schedBundle);
    const pupMod = require(pupBundle);
    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);

    // 预置同账号 1 小时前已成功发布的同标题记录
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "sched",
        selectedFile: "sched.mp4",
        bt: "定时重复标题",
        title: "定时重复标题",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });

    const fireAt1 = now + 5 * 60 * 1000;
    const fireAt2 = now + 6 * 60 * 1000;
    const fireAt3 = now + 7 * 60 * 1000;

    // 链路 1：CLI --allow-duplicate + --publish-at
    const cliLogs = [];
    const origLog = console.log;
    console.log = (...a) => cliLogs.push(a.join(" "));
    let cliCode;
    try {
      cliCode = await cliMod.runCliMain([
        "node",
        ".",
        "cli",
        "publish",
        "-p",
        "dy",
        "--phone",
        "A组",
        "-f",
        videoFile,
        "-t",
        "定时重复标题",
        "--publish-at",
        formatLocalYmdHms(fireAt1),
        "--allow-duplicate",
      ]);
    } finally {
      console.log = origLog;
    }
    assert.strictEqual(cliCode, 0, `CLI --allow-duplicate 定时排期应成功退出 0，实际=${cliCode}`);
    const cliOut = JSON.parse(cliLogs[cliLogs.length - 1]);
    assert.strictEqual(cliOut.scheduled, true);

    // 链路 2：HTTP POST /publish 传 allowDuplicate: true + publishAt（真实路由 + 真实 publishVideo + 真实 createScheduledRecord）
    const router = require(routesBundle);
    const publishLayer = router.stack.find((l) => l.route && l.route.path === "/publish");
    assert.ok(publishLayer && publishLayer.route.stack.length > 0);
    const httpHandler = publishLayer.route.stack[0].handle;
    const httpRes = await new Promise((resolve, reject) => {
      const req = {
        method: "POST",
        headers: { origin: "http://localhost:8080" },
        body: {
          platform: "dy",
          phone: "A组",
          file: videoFile,
          title: "定时重复标题",
          publishAt: formatLocalYmdHms(fireAt2),
          allowDuplicate: true,
        },
      };
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(payload) {
          resolve({ statusCode: this.statusCode, body: payload });
        },
      };
      Promise.resolve(httpHandler(req, res)).catch(reject);
    });
    assert.strictEqual(httpRes.statusCode, 200);
    assert.strictEqual(httpRes.body.success, true, `HTTP allowDuplicate 定时创建应成功: ${JSON.stringify(httpRes.body)}`);
    assert.strictEqual(httpRes.body.scheduled, true);

    // 链路 3：GUI 确认「仍然发布」后写入定时任务记录
    const vueSrc = fs.readFileSync(
      path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
      "utf8"
    );
    assert.ok(
      vueSrc.includes("dupDecision.allowDuplicate ? { allowDuplicate: true }") &&
        vueSrc.includes("dirDupDecision.allowDuplicate ? { allowDuplicate: true }"),
      "GUI 单视频与目录批量定时任务在用户点击「仍然发布」后必须持久化 allowDuplicate: true"
    );
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "sched",
        selectedFile: "sched.mp4",
        bt: "定时重复标题",
        title: "定时重复标题",
        filePath: videoFile,
        date: todayKey,
        scheduledTask: true,
        allowDuplicate: true,
        scheduledPublishAt: fireAt3,
        scheduledPublishAtText: formatLocalYmdHms(fireAt3),
        publishStatus: "scheduled",
        lastPublishMessage: "等待定时发布",
        lastPublishAt: now,
      },
    });

    // 验证落盘的三条定时任务记录均带有 allowDuplicate: true
    const allRecords = readPushDataRecords(changeData);
    const schedRecords = allRecords.filter((r) => r.scheduledTask === true);
    assert.strictEqual(schedRecords.length, 3, `应落盘 3 条定时记录，实际=${schedRecords.length}`);
    for (const rec of schedRecords) {
      assert.strictEqual(
        rec.allowDuplicate,
        true,
        `定时记录 id=${rec.id} 必须持久化 allowDuplicate: true`
      );
    }

    // 模拟 5 分钟后到点执行（且跳过任何内存票据 skipBypass: true）：三条均应通过入口查重
    for (const rec of schedRecords) {
      const payload = schedMod.buildTaskPayloadFromRecord(rec);
      assert.strictEqual(payload.allowDuplicate, true, "buildTaskPayloadFromRecord 必须读取 allowDuplicate: true");
      assert.strictEqual(payload.recordId, rec.id, "buildTaskPayloadFromRecord 必须带上 recordId");
      // 模拟 scheduledPublish 将自身状态改为 publishing 后调用入口查重
      const snapshotAtFire = allRecords.map((r) =>
        r.id === rec.id
          ? { ...r, publishStatus: "publishing", lastPublishMessage: "定时任务开始发布", lastPublishAt: fireAt1 }
          : r
      );
      const dupHit = pupMod.checkPublishEntryDuplicate(payload, snapshotAtFire, {
        now: fireAt1 + 20000,
        skipBypass: true,
      });
      assert.strictEqual(
        dupHit,
        null,
        `S10-fix2 #2 放行的定时任务 id=${rec.id} 到点执行不得被拦截，实际=${JSON.stringify(dupHit)}`
      );
    }

    // 反向校验：未放行（无 allowDuplicate）的定时任务排除自身 recordId，但若存在其它 7 天内记录仍被拦截
    const normalSchedRec = schedMod.createScheduledRecord(
      {
        id: "sched-no-bypass",
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "fresh",
        selectedFile: "fresh.mp4",
        bt: "全新定时标题",
        title: "全新定时标题",
        filePath: videoFile,
        date: todayKey,
      },
      formatLocalYmdHms(fireAt1),
      now
    );
    assert.strictEqual(normalSchedRec.allowDuplicate, undefined);
    const normalPayload = schedMod.buildTaskPayloadFromRecord(normalSchedRec);
    assert.strictEqual(normalPayload.recordId, "sched-no-bypass");
    const ownPublishingOnly = [
      { ...normalSchedRec, publishStatus: "publishing", lastPublishAt: fireAt1 },
    ];
    assert.strictEqual(
      pupMod.checkPublishEntryDuplicate(normalPayload, ownPublishingOnly, {
        now: fireAt1 + 20000,
        skipBypass: true,
      }),
      null,
      "未放行定时任务应按 recordId 排除自身 publishing 记录（即使超过 10 秒）"
    );

    console.log("✓ 9. S10-fix2 #2 CLI/HTTP/GUI 三条链路定时发布持久化 allowDuplicate 到点放行验证通过");
  } finally {
    Module._load = origLoad;
    delete require.cache[cliBundle];
    delete require.cache[schedBundle];
    delete require.cache[pupBundle];
    delete require.cache[routesBundle];
    delete require.cache[realUtilsPath];
    delete require.cache[realRoutePath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  testPureDedupeRules();
  await testHttpPublishRouteDedupe();
  await testCliAndPuppeteerEntryDedupe();
  testGuiLocalVideoPublishCheck();
  testRealDiskPushDataAndGuiCheck();
  await testMcpPublishVideoDuplicateHandling();
  await testS10Fix2_1_ArticleFirstPublishExcludesOwnRecord();
  await testS10Fix2_2_ScheduledAllowDuplicatePersistedAcrossAllThreeChains();
  console.log("\ntest-publish-duplicate-guard: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
