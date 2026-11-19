/**
 * 每日定时自动采集调度器与主进程 stats:auto-run 单元测试（不依赖 Electron 运行环境）：
 * 1. 纯函数 shouldRun：未到点/到点/doneLocalDate 抑制/跨天/补跑/关闭/坏设置/边界时间，且 lastRunDate 不参与跳过判定
 * 2. 配置归一化与保存失败反馈（saveSettings/updateSettings 返回 { ok, settings, error }，失败不广播供 UI 回滚）
 * 3. 单调时钟启动延迟（performance.now）：启动 2 分钟内不调用、挂钟前拨不提前、挂钟回拨 6 天不卡死
 * 4. isMainWindowLocation 主窗口判定（主页面放行，登录窗/加载窗/子窗口/外部页拦截）
 * 5. 调度器全流程：
 *    - done 后当天本地不再调用、弹一条 notify、跨天再跑、stop 静默
 *    - already-ran 后当天本地不再调用、更新 lastRunDate、不弹 notify
 *    - busy / IPC 异常后不设标记，下一分钟继续重试（无 6 次上限）
 *    - null 账号不调用 stats:auto-run
 *    - 并发防重入、改设置即时生效、buildNotifyPayload（含 skipped/cancelled/error）
 * 6. UTC 时区 23:30 设置连续两天都会调用（含单实例跨天与重启实例验证不混用本地与 UTC+8 日期）
 * 7. 主进程 stats:auto-run + store.js 真实落盘 + collectedToday 跳重 + 三方互斥：
 *    - 已删除 stats:auto-claim / stats:auto-release
 *    - buildCollectAccounts：无 accountTree / 损坏 JSON / 非对象根 / 空列表 → null；坏 children 节点跳过
 *    - 同日二次 auto-run 返回 already-ran 且不调用 collectAccount
 *    - collecting 中（stats:collect / stats:match-works / stats:auto-run）返回 busy 且不写 runs
 *    - 采集中途抛错（单账号抛错 & 意外异常逃逸）与取消后：runs 仍写入、collecting 复位
 *    - 原子写 auto-run.json 失败（ENOSPC）：只 warn、旧文件完整、无 .tmp 残留、collecting 复位
 *    - 系统校时回拨到已跑日期返回 already-ran；runs 最多保留 14 个日期
 *    - collectedToday（按 trim 后 partition）：match-works 或手动 collect 成功在 auto-run 跳过、
 *      同分组同平台另一 partition 不跳过、跨组同 partition 跳过、失败不记入、日期变化清空
 *    - 双窗口并发触发：仅跑一次、仅通知一次；只读 localStorage + 重挂载仍由主进程挡住
 *
 * 运行：yarn test:stats-scheduler
 */

"use strict";

require("@babel/register")({
  extensions: [".js"],
  ignore: [/node_modules/],
  presets: [
    ["@babel/preset-env", { targets: { node: "20" }, modules: "commonjs" }],
  ],
});

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 先不 mock electron 直接加载 statsScheduler，验证纯函数与注入式调度器不依赖 Electron / DOM
const schedulerMod = require("../src/renderer/utils/statsScheduler.js");
const {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  STARTUP_DELAY_MS,
  formatLocalDate,
  normalizeSettings,
  isMainWindowLocation,
  shouldRun,
  buildNotifyPayload,
  loadSettings,
  saveSettings,
  updateSettings,
  subscribeSettings,
  createStatsScheduler,
} = schedulerMod;

function localTime(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
}

/** 生成指定 UTC+8 时刻的毫秒时间戳 */
function cnTime(y, m, d, hh = 10, mm = 0, ss = 0) {
  return Date.UTC(y, m - 1, d, hh - 8, mm, ss);
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, val) {
      map.set(key, String(val));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function withMockDateNow(getNow, fn) {
  const origDateNow = Date.now;
  Date.now = () => getNow();
  const restore = () => {
    Date.now = origDateNow;
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

function withImmediateTimers(fn) {
  const origSetTimeout = global.setTimeout;
  global.setTimeout = (cb) => {
    cb();
    return 0;
  };
  const restore = () => {
    global.setTimeout = origSetTimeout;
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.finally(restore);
    }
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

async function main() {
  /* ---------- 1. shouldRun 纯函数 ---------- */
  {
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 9, 59, 59),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
      }),
      false,
      "未到设定时间不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
      }),
      true,
      "刚好到点应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 15, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-18" },
      }),
      true,
      "错过设定时间应补跑"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        doneLocalDate: "2026-11-19",
      }),
      false,
      "doneLocalDate 为当天本地日期时不再调用"
    );
    // lastRunDate 仅作显示，不参与跳过判定（避免 UTC 与 UTC+8 混用导致隔天漏跑）
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 23, 30, 0),
        settings: { enabled: true, time: "23:30", lastRunDate: "2026-11-20" },
        doneLocalDate: "2026-11-19",
      }),
      true,
      "settings.lastRunDate 不得阻断次日本地定时触发"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 9, 59, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
        doneLocalDate: "2026-11-19",
      }),
      false
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 12, 0, 0),
        settings: { enabled: false, time: "10:00", lastRunDate: "" },
      }),
      false
    );
    // 坏设置回落默认（10:00 / enabled:true）
    assert.strictEqual(
      shouldRun({ now: localTime(2026, 11, 19, 9, 59, 0), settings: null }),
      false
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 0),
        settings: { enabled: "nope", time: "99:99", lastRunDate: "invalid" },
      }),
      true
    );
    // 边界时间 00:00 与 23:30
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 0, 0, 0),
        settings: { enabled: true, time: "00:00", lastRunDate: "" },
        doneLocalDate: "2026-11-19",
      }),
      true
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 23, 29, 59),
        settings: { enabled: true, time: "23:30", lastRunDate: "" },
      }),
      false
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 23, 30, 0),
        settings: { enabled: true, time: "23:30", lastRunDate: "" },
      }),
      true
    );
    assert.strictEqual(shouldRun({ now: NaN, settings: DEFAULT_SETTINGS }), false);
    console.log("✓ shouldRun 纯函数判定（未到点 / 到点 / doneLocalDate / lastRunDate 不拦截 / 边界 / 坏设置）");
  }

  /* ---------- 2. 配置归一化、读写容错与保存失败反馈 ---------- */
  {
    for (const bad of [null, undefined, [], "bad", 123]) {
      assert.deepStrictEqual(normalizeSettings(bad), DEFAULT_SETTINGS);
    }
    assert.deepStrictEqual(
      normalizeSettings({ enabled: false, time: "25:00", lastRunDate: "2026-11-18" }),
      { enabled: false, time: "10:00", lastRunDate: "2026-11-18" }
    );
    assert.deepStrictEqual(
      normalizeSettings({ enabled: "false", time: "10:60", lastRunDate: "2026-02-30" }),
      { enabled: true, time: "10:00", lastRunDate: "" }
    );
    assert.deepStrictEqual(
      normalizeSettings({ enabled: true, time: "08:30", lastRunDate: "2024-02-29" }),
      { enabled: true, time: "08:30", lastRunDate: "2024-02-29" }
    );
    for (const badRaw of ["", "{broken", "null", "[]", "123", '"hello"', "true"]) {
      assert.deepStrictEqual(
        loadSettings(createMemoryStorage({ [STORAGE_KEY]: badRaw })),
        DEFAULT_SETTINGS
      );
    }

    const origGlobalLS = global.localStorage;
    const broadcasted = [];
    const unsub = subscribeSettings((s) => broadcasted.push(s));
    try {
      const storedRaw = JSON.stringify({
        enabled: true,
        time: "10:00",
        lastRunDate: "2026-11-18",
      });
      global.localStorage = {
        getItem: () => storedRaw,
        setItem() {
          throw new Error("QuotaExceededError");
        },
      };

      const saveFail = saveSettings({ enabled: false, time: "11:30" });
      assert.strictEqual(saveFail.ok, false);
      assert.ok(saveFail.error.includes("QuotaExceededError"));
      assert.deepStrictEqual(saveFail.settings, {
        enabled: true,
        time: "10:00",
        lastRunDate: "2026-11-18",
      });
      assert.strictEqual(broadcasted.length, 0);

      const updateFail = updateSettings({ enabled: false });
      assert.strictEqual(updateFail.ok, false);
      assert.strictEqual(updateFail.settings.enabled, true);
      assert.strictEqual(broadcasted.length, 0);

      const noStorageRes = saveSettings({ enabled: false }, null);
      assert.strictEqual(noStorageRes.ok, false);
      assert.deepStrictEqual(noStorageRes.settings, DEFAULT_SETTINGS);
    } finally {
      unsub();
      if (origGlobalLS === undefined) delete global.localStorage;
      else global.localStorage = origGlobalLS;
    }

    const storage = createMemoryStorage();
    assert.strictEqual(
      saveSettings({ enabled: true, time: "10:00", lastRunDate: "2026-11-18" }, storage).ok,
      true
    );
    const updated = updateSettings({ time: "14:30", lastRunDate: undefined }, storage);
    assert.strictEqual(updated.ok, true);
    assert.deepStrictEqual(updated.settings, {
      enabled: true,
      time: "14:30",
      lastRunDate: "2026-11-18",
    });
    console.log("✓ 配置归一化、读写容错与保存失败回滚正确");
  }

  /* ---------- 3. 单调时钟启动延迟（2 分钟内不调用，不受挂钟回拨/前拨影响） ---------- */
  {
    let wallNow = localTime(2026, 11, 25, 10, 0, 0).getTime();
    let monoNow = 1000;
    let calls = 0;

    const sMono = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => wallNow,
      monotonicNow: () => monoNow,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      autoRun: async () => {
        calls++;
        return { status: "done", date: "2026-11-19", results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });

    sMono.start();

    // 启动后 119 秒（即使挂钟跳快 10 分钟），仍不调用
    wallNow = localTime(2026, 11, 25, 10, 10, 0).getTime();
    monoNow += STARTUP_DELAY_MS - 1000;
    assert.deepStrictEqual(await sMono.tick(), { ran: false, reason: "startup-delay" });
    assert.strictEqual(calls, 0);

    // 挂钟大幅回拨 6 天到 2026-11-19 10:05，单调时钟满 2 分钟 → 立即放行
    wallNow = localTime(2026, 11, 19, 10, 5, 0).getTime();
    monoNow += 1000;
    const out = await sMono.tick();
    assert.strictEqual(out.ran, true);
    assert.strictEqual(calls, 1);
    sMono.stop();
    console.log("✓ 单调时钟 2 分钟启动延迟（启动 2 分钟内不调用、挂钟前拨/回拨不影响）");
  }

  /* ---------- 4. isMainWindowLocation 主窗口判定 ---------- */
  {
    const mainCases = [
      { protocol: "file:", hostname: "", pathname: "/C:/app/dist/index.html", hash: "" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/data-stats" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/data-stats/group/G1/%E6%8A%96%E9%9F%B3" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/video-manager" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/project-detail?tab=ai" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/accountManager/G1/dy" },
      { protocol: "http:", hostname: "localhost", pathname: "/", hash: "#/data-stats" },
      { protocol: "http:", hostname: "127.0.0.1", pathname: "/index.html", hash: "" },
    ];
    for (const loc of mainCases) {
      assert.strictEqual(isMainWindowLocation(loc), true);
    }

    const nonMainCases = [
      null,
      { protocol: "file:", hostname: "", pathname: "/app/static/loader.html", hash: "" },
      { protocol: "http:", hostname: "localhost", pathname: "/static/loader.html", hash: "" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/login" },
      { protocol: "http:", hostname: "localhost", pathname: "/", hash: "#/print" },
      { protocol: "https:", hostname: "creator.douyin.com", pathname: "/creator-micro/home", hash: "" },
      { protocol: "about:", hostname: "", pathname: "blank", hash: "" },
    ];
    for (const loc of nonMainCases) {
      assert.strictEqual(isMainWindowLocation(loc), false);
    }
    console.log("✓ isMainWindowLocation 主窗口与登录/子窗口区分正确");
  }

  /* ---------- 5. 调度器行为：done/already-ran/busy/IPC异常/null账号/防重入/改设置 ---------- */
  {
    const sampleAccounts = [
      { group: "G1", platform: "抖音", partition: "persist:G1-抖音" },
      { group: "G1", platform: "快手", partition: "persist:G1-快手" },
    ];

    // 5a. done 后当天本地不再调用、弹 notify、跨天再跑、stop 清理
    let tMain = localTime(2026, 11, 19, 9, 59, 0).getTime();
    let mono = 0;
    const storage = createMemoryStorage();
    const calls = [];
    const notifications = [];
    let intervalId = 0;
    const clearedIds = [];

    const sched = createStatsScheduler({
      storage,
      now: () => tMain,
      monotonicNow: () => mono,
      getAccounts: () => sampleAccounts,
      autoRun: async (accs) => {
        const d = formatLocalDate(tMain);
        calls.push({ date: d, count: accs.length });
        return {
          status: "done",
          date: d,
          cancelled: false,
          results: [
            { group: "G1", platform: "抖音", success: true, workCount: 10 },
            { group: "G1", platform: "快手", success: false, error: "未登录" },
          ],
        };
      },
      notify: (p) => notifications.push(p),
      setIntervalFn: () => ++intervalId,
      clearIntervalFn: (id) => clearedIds.push(id),
    });

    assert.deepStrictEqual(await sched.tick(), { ran: false, reason: "stopped" });
    sched.start();
    assert.strictEqual(intervalId, 1);

    tMain = localTime(2026, 11, 19, 10, 0, 0).getTime();
    mono += 60 * 1000;
    assert.deepStrictEqual(await sched.tick(), { ran: false, reason: "startup-delay" });

    tMain = localTime(2026, 11, 19, 10, 1, 0).getTime();
    mono += 60 * 1000;
    const r1 = await sched.tick();
    assert.strictEqual(r1.ran, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(sched.getState().doneLocalDate, "2026-11-19");
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-19");
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].type, "warning");
    assert.ok(notifications[0].message.includes("成功 1 / 失败 1"));

    // 当天本地再次 tick：不再调用 autoRun
    tMain = localTime(2026, 11, 19, 10, 2, 0).getTime();
    assert.deepStrictEqual(await sched.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(calls.length, 1);

    // 跨天未到点不跑，到点再跑
    tMain = localTime(2026, 11, 20, 9, 59, 0).getTime();
    assert.deepStrictEqual(await sched.tick(), { ran: false, reason: "not-due" });
    tMain = localTime(2026, 11, 20, 10, 0, 0).getTime();
    const r2 = await sched.tick();
    assert.strictEqual(r2.ran, true);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-20");

    sched.stop();
    assert.deepStrictEqual(clearedIds, [1]);
    assert.deepStrictEqual(await sched.tick(), { ran: false, reason: "stopped" });

    // 5b. busy 与 IPC 异常后不设标记，下一分钟无限重试（无 6 次上限），恢复后成功
    let tRetry = localTime(2026, 11, 19, 10, 0, 0).getTime();
    let attempt = 0;
    const retryNotifies = [];
    const retryStorage = createMemoryStorage();
    const sRetry = createStatsScheduler({
      storage: retryStorage,
      now: () => tRetry,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => sampleAccounts,
      autoRun: async () => {
        attempt++;
        if (attempt <= 7) return { status: "busy" }; // 超过旧 6 次上限仍继续重试
        if (attempt === 8) throw new Error("IPC 通道断开");
        return {
          status: "done",
          date: "2026-11-19",
          results: [{ group: "G1", platform: "抖音", success: true }],
        };
      },
      notify: (p) => retryNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sRetry.start();
    for (let i = 1; i <= 7; i++) {
      assert.deepStrictEqual(await sRetry.tick(), { ran: false, reason: "busy" });
      assert.strictEqual(sRetry.getState().doneLocalDate, "");
      assert.strictEqual(loadSettings(retryStorage).lastRunDate, "");
      tRetry += 60 * 1000;
    }
    const ipcErrOut = await sRetry.tick();
    assert.strictEqual(ipcErrOut.ran, false);
    assert.strictEqual(ipcErrOut.reason, "ipc-error");
    assert.strictEqual(sRetry.getState().doneLocalDate, "");
    assert.strictEqual(retryNotifies.length, 0);

    // 第 9 分钟恢复成功
    tRetry += 60 * 1000;
    const okOut = await sRetry.tick();
    assert.strictEqual(okOut.ran, true);
    assert.strictEqual(attempt, 9);
    assert.strictEqual(sRetry.getState().doneLocalDate, "2026-11-19");
    assert.strictEqual(loadSettings(retryStorage).lastRunDate, "2026-11-19");
    assert.strictEqual(retryNotifies.length, 1);

    // 成功后当天不再调
    tRetry += 60 * 1000;
    assert.deepStrictEqual(await sRetry.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(attempt, 9);
    sRetry.stop();

    // 5c. already-ran → 设 doneLocalDate & 更新 lastRunDate，不弹 notify，当天不再调
    let tAlready = localTime(2026, 11, 19, 10, 0, 0).getTime();
    let alreadyCalls = 0;
    const alreadyNotifies = [];
    const alreadyStorage = createMemoryStorage();
    const sAlready = createStatsScheduler({
      storage: alreadyStorage,
      now: () => tAlready,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => sampleAccounts,
      autoRun: async () => {
        alreadyCalls++;
        return { status: "already-ran", date: "2026-11-19" };
      },
      notify: (p) => alreadyNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sAlready.start();
    assert.deepStrictEqual(await sAlready.tick(), {
      ran: false,
      reason: "already-ran",
      date: "2026-11-19",
    });
    assert.strictEqual(alreadyCalls, 1);
    assert.strictEqual(alreadyNotifies.length, 0);
    assert.strictEqual(sAlready.getState().doneLocalDate, "2026-11-19");
    assert.strictEqual(loadSettings(alreadyStorage).lastRunDate, "2026-11-19");
    tAlready += 60 * 1000;
    assert.deepStrictEqual(await sAlready.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(alreadyCalls, 1);
    sAlready.stop();

    // 5d. getAccounts 返回 null 或空数组 → 本轮跳过，不调用 autoRun
    let nullCalls = 0;
    let mockAccs = null;
    const sNull = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => localTime(2026, 11, 19, 10, 0, 0).getTime(),
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => mockAccs,
      autoRun: async () => {
        nullCalls++;
        return { status: "done", date: "2026-11-19", results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sNull.start();
    assert.deepStrictEqual(await sNull.tick(), { ran: false, reason: "no-accounts" });
    mockAccs = [];
    assert.deepStrictEqual(await sNull.tick(), { ran: false, reason: "no-accounts" });
    assert.strictEqual(nullCalls, 0);
    assert.strictEqual(sNull.getState().doneLocalDate, "");
    // 有账号后下一轮正常触发
    mockAccs = sampleAccounts;
    assert.strictEqual((await sNull.tick()).ran, true);
    assert.strictEqual(nullCalls, 1);
    sNull.stop();

    // 5e. 并发防重入 + stop 后静默 + 改设置即时生效 + buildNotifyPayload
    const pending = createDeferred();
    let concCalls = 0;
    const concNotifies = [];
    const sConc = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => localTime(2026, 11, 19, 10, 0, 0).getTime(),
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => sampleAccounts,
      autoRun: () => {
        concCalls++;
        return pending.promise;
      },
      notify: (p) => concNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sConc.start();
    const p1 = sConc.tick();
    assert.deepStrictEqual(await sConc.tick(), { ran: false, reason: "in-flight" });
    assert.strictEqual(concCalls, 1);
    sConc.stop();
    pending.resolve({ status: "done", date: "2026-11-19", results: [{ success: true }] });
    await p1;
    assert.strictEqual(concNotifies.length, 0);

    const liveStorage = createMemoryStorage();
    saveSettings({ enabled: false, time: "18:00", lastRunDate: "" }, liveStorage);
    let liveCalls = 0;
    const sLive = createStatsScheduler({
      storage: liveStorage,
      now: () => localTime(2026, 11, 19, 11, 0, 0).getTime(),
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => sampleAccounts,
      autoRun: async () => {
        liveCalls++;
        return { status: "done", date: "2026-11-19", results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sLive.start();
    assert.deepStrictEqual(await sLive.tick(), { ran: false, reason: "not-due" });
    updateSettings({ enabled: true }, liveStorage);
    assert.deepStrictEqual(await sLive.tick(), { ran: false, reason: "not-due" });
    updateSettings({ time: "10:30" }, liveStorage);
    assert.strictEqual((await sLive.tick()).ran, true);
    assert.strictEqual(liveCalls, 1);
    sLive.stop();

    // buildNotifyPayload
    const skipOnly = buildNotifyPayload({
      cancelled: false,
      results: [{ group: "G1", platform: "抖音", success: true, skipped: true }],
    });
    assert.strictEqual(skipOnly.type, "info");
    assert.ok(skipOnly.message.includes("跳过 1"));
    const mixed = buildNotifyPayload({
      cancelled: false,
      results: [
        { group: "G1", platform: "抖音", success: true, skipped: true },
        { group: "G1", platform: "快手", success: true },
      ],
    });
    assert.strictEqual(mixed.type, "success");
    assert.ok(mixed.message.includes("成功 1 / 跳过 1 / 失败 0"));
    assert.strictEqual(
      buildNotifyPayload({ cancelled: true, results: [{ success: true }] }).type,
      "info"
    );
    assert.strictEqual(
      buildNotifyPayload({ results: [], error: "服务异常" }).title,
      "每日自动采集失败"
    );
    console.log("✓ 调度器行为（done/already-ran/busy 无限重试/IPC 异常/null 账号/防重入/通知）正确");
  }

  /* ---------- 6. 主进程 stats:auto-run + store.js 真实落盘 + collectedToday + 互斥 + UTC 23:30 ---------- */
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-stats-sched-"));
    const electronId = require.resolve("electron");
    const collectorId = path.resolve(
      __dirname,
      "../src/main/services/dataStats/collector.js"
    );
    const storeId = path.resolve(
      __dirname,
      "../src/main/services/dataStats/store.js"
    );
    const indexId = path.resolve(
      __dirname,
      "../src/main/services/dataStats/index.js"
    );
    const statsApiId = path.resolve(
      __dirname,
      "../src/renderer/utils/statsApi.js"
    );

    const origCache = {
      electron: require.cache[electronId],
      collector: require.cache[collectorId],
      store: require.cache[storeId],
      index: require.cache[indexId],
      statsApi: require.cache[statsApiId],
    };

    const ipcHandlers = new Map();
    const collectedBatches = [];
    let collectorImpl = async ({ partition, platform }) => ({
      overview: { plays: 10 },
      fansHistory: [],
      works: [
        {
          workId: `${partition}-w1`,
          title: `标题-${platform}`,
          url: "https://example.com/1",
        },
      ],
    });

    require.cache[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: {
        app: { getPath: () => tmpRoot },
        ipcMain: {
          handle: (channel, fn) => ipcHandlers.set(channel, fn),
        },
        ipcRenderer: {
          invoke: async (channel, payload) => {
            const handler = ipcHandlers.get(channel);
            if (!handler) throw new Error(`未注册 IPC: ${channel}`);
            return handler({ sender: { send: () => {} } }, payload);
          },
        },
      },
    };
    require.cache[collectorId] = {
      id: collectorId,
      filename: collectorId,
      loaded: true,
      exports: {
        collectAccount: async (params) => {
          collectedBatches.push(params);
          return collectorImpl(params);
        },
      },
    };
    delete require.cache[storeId];
    delete require.cache[indexId];
    delete require.cache[statsApiId];

    const origGlobalLS = global.localStorage;

    try {
      const store = require(storeId);
      const { registerDataStatsIpc } = require(indexId);
      const { buildCollectAccounts } = require(statsApiId);
      registerDataStatsIpc();

      // 已彻底移除 stats:auto-claim / stats:auto-release，新增 stats:auto-run
      assert.strictEqual(ipcHandlers.has("stats:auto-claim"), false);
      assert.strictEqual(ipcHandlers.has("stats:auto-release"), false);
      assert.strictEqual(typeof store.writeAutoRuns, "undefined");
      assert.strictEqual(typeof store.appendAutoRun, "function");

      const autoRunHandler = ipcHandlers.get("stats:auto-run");
      const collectHandler = ipcHandlers.get("stats:collect");
      const cancelHandler = ipcHandlers.get("stats:cancel");
      const matchHandler = ipcHandlers.get("stats:match-works");
      assert.strictEqual(typeof autoRunHandler, "function");
      assert.strictEqual(typeof collectHandler, "function");
      assert.strictEqual(typeof cancelHandler, "function");
      assert.strictEqual(typeof matchHandler, "function");

      const fakeEvent = { sender: { send: () => {} } };
      const autoRunFile = path.join(tmpRoot, "data-stats", "auto-run.json");

      /* ---- 6a. buildCollectAccounts：无数据/损坏/非对象/空列表 → null；坏 children 节点跳过 ---- */
      {
        const lsMap = new Map();
        global.localStorage = {
          getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
          setItem: (k, v) => lsMap.set(k, String(v)),
          removeItem: (k) => lsMap.delete(k),
        };

        // 无 accountTree / 空串 / 空对象 / 损坏 JSON / 非对象根 → null
        assert.strictEqual(buildCollectAccounts(), null);
        for (const bad of ["", "{}", "{broken", "null", "[]", "123", '"oops"']) {
          lsMap.set("accountTree", bad);
          assert.strictEqual(
            buildCollectAccounts(),
            null,
            `accountTree=${bad} 应返回 null`
          );
        }

        // 所有节点 children 非数组，或仅含不参与统计平台 → 最终为空 → null
        lsMap.set(
          "accountTree",
          JSON.stringify({
            badGroup: { children: "not-an-array" },
            nullGroup: null,
            excludedOnly: {
              children: [{ meta: { phone: "G1", pt: "番茄视频" } }],
            },
          })
        );
        assert.strictEqual(buildCollectAccounts(), null);

        // 混合坏节点与好节点 → 跳过坏节点，返回有效账号
        lsMap.set(
          "accountTree",
          JSON.stringify({
            badGroup: { children: { broken: true } },
            goodGroup: {
              children: [null, { meta: { phone: "Good", pt: "抖音" } }],
            },
          })
        );
        const built = buildCollectAccounts();
        assert.strictEqual(Array.isArray(built), true);
        assert.strictEqual(built.length, 1);
        assert.strictEqual(built[0].group, "goodGroup");
        assert.strictEqual(built[0].platform, "抖音");

        // localStorage.getItem 抛错 → null
        global.localStorage = {
          getItem() {
            throw new Error("SecurityError");
          },
          setItem() {},
        };
        assert.strictEqual(buildCollectAccounts(), null);

        // 调度器遇到缺失/空/损坏 accountTree：不触发 stats:auto-run、不写 auto-run.json
        global.localStorage = {
          getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
          setItem: (k, v) => lsMap.set(k, String(v)),
          removeItem: (k) => lsMap.delete(k),
        };
        lsMap.delete("accountTree");
        const sEmpty = createStatsScheduler({
          storage: createMemoryStorage(),
          now: () => localTime(2026, 11, 19, 10, 0, 0).getTime(),
          monotonicNow: () => STARTUP_DELAY_MS,
          startupDelayMs: 0,
          setIntervalFn: () => 1,
          clearIntervalFn: () => {},
        });
        sEmpty.start();
        assert.deepStrictEqual(await sEmpty.tick(), { ran: false, reason: "no-accounts" });
        lsMap.set("accountTree", "{}");
        assert.deepStrictEqual(await sEmpty.tick(), { ran: false, reason: "no-accounts" });
        lsMap.set("accountTree", "{broken");
        assert.deepStrictEqual(await sEmpty.tick(), { ran: false, reason: "no-accounts" });
        assert.strictEqual(fs.existsSync(autoRunFile), false);
        sEmpty.stop();
        console.log("✓ buildCollectAccounts 空/损坏/坏节点处理与调度器跳过正确");
      }

      /* ---- 6b. 同日二次 auto-run 返回 already-ran 且不调 collectAccount；回拨已跑日期 already-ran；14 天上限 ---- */
      {
        const acc = [{ group: "G1", platform: "抖音", partition: "persist:G1-抖音" }];
        let mockNow = cnTime(2026, 11, 19, 10, 0, 0);

        await withMockDateNow(
          () => mockNow,
          async () => {
            const before1 = collectedBatches.length;
            const r1 = await autoRunHandler(fakeEvent, { accounts: acc });
            assert.strictEqual(r1.status, "done");
            assert.strictEqual(r1.date, "2026-11-19");
            assert.strictEqual(r1.results.length, 1);
            assert.strictEqual(r1.results[0].success, true);
            assert.strictEqual(collectedBatches.length - before1, 1);
            assert.deepStrictEqual(store.readAutoRuns(), ["2026-11-19"]);
            assert.strictEqual(store.readCollectLogs()[0].trigger, "auto");

            // 同日二次 auto-run → already-ran 且不调用 collectAccount
            const before2 = collectedBatches.length;
            const r2 = await autoRunHandler(fakeEvent, { accounts: acc });
            assert.deepStrictEqual(r2, { status: "already-ran", date: "2026-11-19" });
            assert.strictEqual(collectedBatches.length, before2);

            // 次日 2026-11-20 正常执行
            mockNow = cnTime(2026, 11, 20, 10, 0, 0);
            const r3 = await autoRunHandler(fakeEvent, { accounts: acc });
            assert.strictEqual(r3.status, "done");
            assert.strictEqual(r3.date, "2026-11-20");
            assert.deepStrictEqual(store.readAutoRuns(), ["2026-11-19", "2026-11-20"]);

            // 系统校时回拨到已跑过的 2026-11-19 → already-ran 且不调 collectAccount
            const beforeRollback = collectedBatches.length;
            mockNow = cnTime(2026, 11, 19, 15, 0, 0);
            const rBack = await autoRunHandler(fakeEvent, { accounts: acc });
            assert.deepStrictEqual(rBack, { status: "already-ran", date: "2026-11-19" });
            assert.strictEqual(collectedBatches.length, beforeRollback);

            // 连续运行 16 天 → auto-run.json 只保留最近 14 个日期
            for (let day = 1; day <= 16; day++) {
              mockNow = cnTime(2026, 12, day, 10, 0, 0);
              const rDay = await autoRunHandler(fakeEvent, { accounts: acc });
              assert.strictEqual(rDay.status, "done");
            }
            const runs16 = store.readAutoRuns();
            assert.strictEqual(runs16.length, 14);
            assert.strictEqual(runs16[0], "2026-12-03");
            assert.strictEqual(runs16[13], "2026-12-16");

            // 回拨到未跑过的早先日期（2026-11-10）→ 跑一次后保留在末尾，二次 already-ran
            mockNow = cnTime(2026, 11, 10, 10, 0, 0);
            assert.strictEqual((await autoRunHandler(fakeEvent, { accounts: acc })).status, "done");
            assert.strictEqual(store.readAutoRuns().length, 14);
            assert.strictEqual(store.readAutoRuns().includes("2026-11-10"), true);
            assert.deepStrictEqual(await autoRunHandler(fakeEvent, { accounts: acc }), {
              status: "already-ran",
              date: "2026-11-10",
            });
          }
        );
        console.log("✓ stats:auto-run 同日二次 already-ran、回拨已跑日期 already-ran、14 天上限正确");
      }

      /* ---- 6c. 互斥：collecting 中 auto-run 返回 busy 且不写 runs；三方互斥与双窗口并发 ---- */
      {
        const acc = [{ group: "MutexG", platform: "抖音", partition: "persist:MutexG-抖音" }];
        const mutexDay = cnTime(2026, 11, 21, 10, 0, 0);
        const origImpl = collectorImpl;

        await withMockDateNow(
          () => mutexDay,
          async () => {
            // 1) stats:collect 运行中 → auto-run 返回 busy 且不写 runs；match-works 返回 busy:true
            const gate1 = createDeferred();
            collectorImpl = async (params) => {
              await gate1.promise;
              return origImpl(params);
            };
            const inFlightCollect = collectHandler(fakeEvent, {
              accounts: acc,
              trigger: "manual",
            });
            assert.deepStrictEqual(await autoRunHandler(fakeEvent, { accounts: acc }), {
              status: "busy",
            });
            assert.strictEqual(
              store.readAutoRuns().includes("2026-11-21"),
              false,
              "busy 绝不能写 runs"
            );
            const matchWhileCollect = await matchHandler(fakeEvent, {
              tasks: [{ key: "0", group: "MutexG", platform: "抖音", partition: "persist:MutexG-抖音", title: "x" }],
            });
            assert.strictEqual(matchWhileCollect.busy, true);
            gate1.resolve();
            await inFlightCollect;

            // 2) stats:match-works 运行中 → auto-run 返回 busy 且不写 runs；stats:collect 返回忙
            const gate2 = createDeferred();
            collectorImpl = async (params) => {
              await gate2.promise;
              return origImpl(params);
            };
            const inFlightMatch = matchHandler(fakeEvent, {
              tasks: [{ key: "0", group: "MutexG", platform: "快手", partition: "persist:MutexG-快手", title: "标题-快手" }],
            });
            assert.deepStrictEqual(await autoRunHandler(fakeEvent, { accounts: acc }), {
              status: "busy",
            });
            assert.strictEqual(store.readAutoRuns().includes("2026-11-21"), false);
            assert.strictEqual(
              (await collectHandler(fakeEvent, { accounts: acc })).error,
              "已有采集任务进行中"
            );
            gate2.resolve();
            assert.strictEqual((await inFlightMatch).matches["0"].found, true);

            // 3) 双窗口同时触发 auto-run：A 执行 done，B 收到 busy，下一分钟 B 收到 already-ran，仅采 1 次、通知 1 次
            const gate3 = createDeferred();
            const multiDay = cnTime(2026, 11, 22, 10, 0, 0);
            const multiAcc = [{ group: "MultiG", platform: "抖音", partition: "persist:MultiG-抖音" }];
            collectorImpl = async (params) => {
              await gate3.promise;
              return origImpl(params);
            };
            await withMockDateNow(
              () => multiDay,
              async () => {
                const startLen = collectedBatches.length;
                const notifiesA = [];
                const notifiesB = [];
                const winA = createStatsScheduler({
                  storage: createMemoryStorage(),
                  now: () => localTime(2026, 11, 22, 10, 0, 0).getTime(),
                  monotonicNow: () => STARTUP_DELAY_MS,
                  startupDelayMs: 0,
                  getAccounts: () => multiAcc,
                  notify: (p) => notifiesA.push(p),
                  setIntervalFn: () => 1,
                  clearIntervalFn: () => {},
                });
                const winB = createStatsScheduler({
                  storage: createMemoryStorage(),
                  now: () => localTime(2026, 11, 22, 10, 0, 0).getTime(),
                  monotonicNow: () => STARTUP_DELAY_MS,
                  startupDelayMs: 0,
                  getAccounts: () => multiAcc,
                  notify: (p) => notifiesB.push(p),
                  setIntervalFn: () => 2,
                  clearIntervalFn: () => {},
                });
                winA.start();
                winB.start();
                const pA = winA.tick();
                const resB1 = await winB.tick();
                assert.deepStrictEqual(resB1, { ran: false, reason: "busy" });
                assert.strictEqual(store.readAutoRuns().includes("2026-11-22"), false);

                gate3.resolve();
                const resA = await pA;
                assert.strictEqual(resA.ran, true);
                assert.strictEqual(collectedBatches.length - startLen, 1);
                assert.strictEqual(notifiesA.length, 1);
                assert.strictEqual(notifiesB.length, 0);

                // 下一分钟 B 重试：主进程返回 already-ran，不重采、不通知
                const resB2 = await winB.tick();
                assert.deepStrictEqual(resB2, {
                  ran: false,
                  reason: "already-ran",
                  date: "2026-11-22",
                });
                assert.strictEqual(collectedBatches.length - startLen, 1);
                assert.strictEqual(notifiesB.length, 0);
                winA.stop();
                winB.stop();

                // 只读 localStorage 重挂载调度器：主进程 auto-run.json 仍挡住
                const roSched = createStatsScheduler({
                  storage: {
                    getItem: () => null,
                    setItem() {
                      throw new Error("QuotaExceededError");
                    },
                  },
                  now: () => localTime(2026, 11, 22, 10, 5, 0).getTime(),
                  monotonicNow: () => STARTUP_DELAY_MS,
                  startupDelayMs: 0,
                  getAccounts: () => multiAcc,
                  setIntervalFn: () => 3,
                  clearIntervalFn: () => {},
                });
                roSched.start();
                assert.deepStrictEqual(await roSched.tick(), {
                  ran: false,
                  reason: "already-ran",
                  date: "2026-11-22",
                });
                assert.strictEqual(collectedBatches.length - startLen, 1);
                roSched.stop();
              }
            );
          }
        );
        collectorImpl = origImpl;
        console.log("✓ busy 不写 runs、三方互斥、双窗口并发仅跑一次、只读存储重挂载防重正确");
      }

      /* ---- 6d. 采集中途抛错 / 取消 / 写 auto-run.json 失败：runs 仍写入（或 warn）、collecting 复位 ---- */
      {
        const origImpl = collectorImpl;

        // 1) 单账号采集中途抛错（部分失败）→ runs 仍写入，collecting 复位
        await withImmediateTimers(() =>
          withMockDateNow(
            () => cnTime(2026, 11, 23, 10, 0, 0),
            async () => {
              collectorImpl = async ({ partition }) => {
                if (partition === "persist:ErrG-快手") {
                  throw new Error("页面崩溃");
                }
                return origImpl({ partition, platform: "抖音" });
              };
              const res = await autoRunHandler(fakeEvent, {
                accounts: [
                  { group: "ErrG", platform: "抖音", partition: "persist:ErrG-抖音" },
                  { group: "ErrG", platform: "快手", partition: "persist:ErrG-快手" },
                ],
              });
              assert.strictEqual(res.status, "done");
              assert.strictEqual(res.date, "2026-11-23");
              assert.strictEqual(res.results[0].success, true);
              assert.strictEqual(res.results[1].success, false);
              assert.ok(res.results[1].error.includes("页面崩溃"));
              assert.strictEqual(store.readAutoRuns().includes("2026-11-23"), true);

              // collecting 已复位：紧接着手动采集可正常运行
              collectorImpl = origImpl;
              const manualAfter = await collectHandler(fakeEvent, {
                accounts: [{ group: "ErrG", platform: "快手", partition: "persist:ErrG-快手" }],
                trigger: "manual",
              });
              assert.strictEqual(manualAfter.results[0].success, true);
            }
          )
        );

        // 2) 未捕获异常逃逸 collectAccounts（如坏对象 getter 抛错）→ finally 仍写 runs 并复位 collecting
        await withMockDateNow(
          () => cnTime(2026, 11, 24, 10, 0, 0),
          async () => {
            const poisonAcc = {
              get group() {
                throw new Error("意外异常");
              },
              platform: "抖音",
              partition: "persist:Poison-抖音",
            };
            let threw = false;
            const origWarn2 = console.warn;
            console.warn = () => {};
            try {
              await autoRunHandler(fakeEvent, { accounts: [poisonAcc] });
            } catch (err) {
              threw = true;
              assert.ok(err.message.includes("意外异常"));
            } finally {
              console.warn = origWarn2;
            }
            assert.strictEqual(threw, true);
            assert.strictEqual(
              store.readAutoRuns().includes("2026-11-24"),
              true,
              "异常逃逸后 finally 仍必须写入 runs"
            );
            // collecting 已复位
            const afterPoison = await collectHandler(fakeEvent, {
              accounts: [{ group: "OkG", platform: "抖音", partition: "persist:OkG-抖音" }],
              trigger: "manual",
            });
            assert.strictEqual(afterPoison.results[0].success, true);
          }
        );

        // 3) 采集中途取消（stats:cancel）→ runs 仍写入、collecting 复位、返回 cancelled:true
        await withMockDateNow(
          () => cnTime(2026, 11, 25, 10, 0, 0),
          async () => {
            const gateCancel = createDeferred();
            collectorImpl = async (params) => {
              await gateCancel.promise;
              return origImpl(params);
            };
            const cancelRun = autoRunHandler(fakeEvent, {
              accounts: [
                { group: "CanG", platform: "抖音", partition: "persist:CanG-抖音" },
                { group: "CanG", platform: "快手", partition: "persist:CanG-快手" },
              ],
            });
            await cancelHandler(fakeEvent);
            gateCancel.resolve();
            const cancelRes = await cancelRun;
            assert.strictEqual(cancelRes.status, "done");
            assert.strictEqual(cancelRes.date, "2026-11-25");
            assert.strictEqual(cancelRes.cancelled, true);
            assert.strictEqual(cancelRes.results.length, 1, "取消后应中断后续账号");
            assert.strictEqual(store.readAutoRuns().includes("2026-11-25"), true);

            // collecting 已复位
            collectorImpl = origImpl;
            const afterCancel = await collectHandler(fakeEvent, {
              accounts: [{ group: "CanG", platform: "快手", partition: "persist:CanG-快手" }],
              trigger: "manual",
            });
            assert.strictEqual(afterCancel.results[0].success, true);
          }
        );

        // 4) auto-run.json 原子写失败（ENOSPC）→ 只 warn、旧文件字节完整、无 .tmp 残留、collecting 复位、仍返回 done
        const beforeBytes = fs.readFileSync(autoRunFile, "utf8");
        const origWriteSync = fs.writeSync;
        const origWarn = console.warn;
        const warns = [];
        console.warn = (...args) => warns.push(args.join(" "));
        fs.writeSync = () => {
          const err = new Error("ENOSPC: no space left on device");
          err.code = "ENOSPC";
          throw err;
        };
        try {
          await withMockDateNow(
            () => cnTime(2026, 11, 26, 10, 0, 0),
            async () => {
              const res = await autoRunHandler(fakeEvent, {
                accounts: [{ group: "DiskG", platform: "抖音", partition: "persist:DiskG-抖音" }],
              });
              assert.strictEqual(res.status, "done");
              assert.strictEqual(res.date, "2026-11-26");
              assert.strictEqual(res.results[0].success, true);
            }
          );
        } finally {
          fs.writeSync = origWriteSync;
          console.warn = origWarn;
        }
        assert.ok(warns.some((w) => w.includes("auto-run.json")));
        assert.strictEqual(fs.readFileSync(autoRunFile, "utf8"), beforeBytes);
        assert.deepStrictEqual(
          fs.readdirSync(path.join(tmpRoot, "data-stats")).filter((f) => f.endsWith(".tmp")),
          []
        );
        // collecting 已复位
        const afterDiskErr = await collectHandler(fakeEvent, {
          accounts: [{ group: "DiskG", platform: "抖音", partition: "persist:DiskG-抖音" }],
          trigger: "manual",
        });
        assert.strictEqual(afterDiskErr.results[0].success, true);
        // 持久化失败后同日再次自动触发：内存兜底返回 already-ran，不得再采集（防每分钟重采）
        {
          const before = collectedBatches.length;
          await withMockDateNow(
            () => cnTime(2026, 11, 26, 10, 1, 0),
            async () => {
              const again = await autoRunHandler(fakeEvent, {
                accounts: [{ group: "DiskG2", platform: "抖音", partition: "persist:DiskG2-抖音" }],
              });
              assert.strictEqual(again.status, "already-ran");
            }
          );
          assert.strictEqual(collectedBatches.length, before, "写盘失败后同日不得再次自动采集");
        }

        collectorImpl = origImpl;
        console.log("✓ 采集中途抛错/异常逃逸/取消/写盘失败：runs 行为与 collecting 复位均正确");
      }

      /* ---- 6e. collectedToday 按规范化 partition（trim）跳过 + 同分组同平台另一 partition 不跳过 + 日期变化清空 ---- */
      {
        const origImpl = collectorImpl;
        const day1 = cnTime(2026, 11, 27, 10, 0, 0);
        const day2 = cnTime(2026, 11, 28, 10, 0, 0);

        await withImmediateTimers(async () => {
          // 即使磁盘 meta 存在「今日成功」，未进入内存 collectedToday 的 partition 不应被旧 meta 逻辑误跳过
          store.writeMeta("SameGroup", "抖音", {
            lastCollectAt: day1,
            lastError: "",
            workCount: 99,
          });

          await withMockDateNow(
            () => day1,
            async () => {
              // 1) 手动 collect 成功：SameGroup/抖音 的 acc1（带前后空格验证 trim）
              await collectHandler(fakeEvent, {
                accounts: [
                  { group: "SameGroup", platform: "抖音", partition: " persist:acc1-抖音 " },
                ],
                trigger: "manual",
              });

              // 2) match-works 成功：SameGroup/快手 的 acc1（带空格验证 trim）
              await matchHandler(fakeEvent, {
                tasks: [
                  {
                    key: "0",
                    group: "SameGroup",
                    platform: "快手",
                    partition: "  persist:acc1-快手  ",
                    title: "标题-快手",
                  },
                ],
              });

              // 3) 手动 collect 失败的 partition 不得被记为已采集
              collectorImpl = async () => {
                throw new Error("未登录");
              };
              const failedManual = await collectHandler(fakeEvent, {
                accounts: [
                  { group: "SameGroup", platform: "B站", partition: "persist:fail-B站" },
                ],
                trigger: "manual",
              });
              assert.strictEqual(failedManual.results[0].success, false);
              collectorImpl = origImpl;

              // 4) auto-run 校验：
              //    - persist:acc1-抖音（手动 collect 成功）→ 跳过
              //    - persist:acc2-抖音（同分组同平台不同 partition！）→ 不跳过！
              //    - persist:acc1-抖音 在另一分组 OtherGroup（同 partition）→ 跳过！
              //    - persist:acc1-快手（match-works 成功）→ 跳过
              //    - persist:fail-B站（手动失败）→ 不跳过！
              const beforeLen = collectedBatches.length;
              const progressEvents = [];
              const progressEv = {
                sender: { send: (_ch, p) => progressEvents.push(p) },
              };
              const resDay1 = await autoRunHandler(progressEv, {
                accounts: [
                  { group: "SameGroup", platform: "抖音", partition: "persist:acc1-抖音" },
                  { group: "SameGroup", platform: "抖音", partition: "persist:acc2-抖音" },
                  { group: "OtherGroup", platform: "抖音", partition: "persist:acc1-抖音" },
                  { group: "SameGroup", platform: "快手", partition: "persist:acc1-快手" },
                  { group: "SameGroup", platform: "B站", partition: "persist:fail-B站" },
                ],
              });
              assert.strictEqual(resDay1.status, "done");
              assert.strictEqual(resDay1.date, "2026-11-27");

              const actuallyCollected = collectedBatches
                .slice(beforeLen)
                .map((x) => x.partition);
              assert.deepStrictEqual(
                actuallyCollected,
                ["persist:acc2-抖音", "persist:fail-B站"],
                "仅应采集未成功过的 partition（同分组同平台另一 partition 绝不能被跳过）"
              );
              assert.strictEqual(resDay1.results[0].skipped, true);
              assert.strictEqual(resDay1.results[1].skipped, undefined);
              assert.strictEqual(resDay1.results[1].success, true);
              assert.strictEqual(resDay1.results[2].skipped, true);
              assert.strictEqual(resDay1.results[3].skipped, true);
              assert.strictEqual(resDay1.results[4].skipped, undefined);
              assert.strictEqual(resDay1.results[4].success, true);
              assert.strictEqual(
                progressEvents.filter((e) => e.status === "skipped").length,
                3
              );
            }
          );

          // 5) 日期变化到次日（2026-11-28）→ collectedToday 自动清空，先前跳过的 partition 次日照常采集
          await withMockDateNow(
            () => day2,
            async () => {
              const beforeDay2 = collectedBatches.length;
              const resDay2 = await autoRunHandler(fakeEvent, {
                accounts: [
                  { group: "SameGroup", platform: "抖音", partition: "persist:acc1-抖音" },
                  { group: "SameGroup", platform: "快手", partition: "persist:acc1-快手" },
                ],
              });
              assert.strictEqual(resDay2.status, "done");
              assert.strictEqual(resDay2.date, "2026-11-28");
              assert.deepStrictEqual(
                collectedBatches.slice(beforeDay2).map((x) => x.partition),
                ["persist:acc1-抖音", "persist:acc1-快手"],
                "跨天后 collectedToday 必须清空，两个账号都应重新采集"
              );
              assert.strictEqual(resDay2.results.every((r) => !r.skipped && r.success), true);
            }
          );
        });
        console.log("✓ collectedToday 按 trim 后 partition 跳过、同分组同平台另一 partition 不跳过、跨天清空正确");
      }

      /* ---- 6f. UTC 时区 23:30 设置连续两天都会调用（主进程 UTC+8 与渲染层本地日期解耦） ---- */
      {
        const origTZ = process.env.TZ;
        process.env.TZ = "UTC";
        try {
          const utcStorage = createMemoryStorage();
          saveSettings({ enabled: true, time: "23:30", lastRunDate: "" }, utcStorage);
          const utcAccs = [{ group: "UtcG", platform: "抖音", partition: "persist:UtcG-抖音" }];
          const notifies = [];
          let utcNow = Date.parse("2026-12-20T23:30:00Z"); // 本地 2026-12-20 23:30, UTC+8 2026-12-21 07:30

          await withMockDateNow(
            () => utcNow,
            async () => {
              const sUtc = createStatsScheduler({
                storage: utcStorage,
                now: () => utcNow,
                monotonicNow: () => STARTUP_DELAY_MS,
                startupDelayMs: 0,
                getAccounts: () => utcAccs,
                notify: (p) => notifies.push(p),
                setIntervalFn: () => 1,
                clearIntervalFn: () => {},
              });
              sUtc.start();

              const startCount = collectedBatches.length;
              // 第 1 天：UTC 2026-12-20 23:30 → 主进程记 UTC+8 2026-12-21，渲染层 doneLocalDate="2026-12-20"
              const d1 = await sUtc.tick();
              assert.strictEqual(d1.ran, true);
              assert.strictEqual(d1.date, "2026-12-21");
              assert.strictEqual(sUtc.getState().doneLocalDate, "2026-12-20");
              assert.strictEqual(loadSettings(utcStorage).lastRunDate, "2026-12-21");
              assert.strictEqual(collectedBatches.length - startCount, 1);

              // 同日 23:31 不再调用
              utcNow = Date.parse("2026-12-20T23:31:00Z");
              assert.deepStrictEqual(await sUtc.tick(), { ran: false, reason: "not-due" });

              // 第 2 天：UTC 2026-12-21 23:30（此时 localStorage.lastRunDate==="2026-12-21" 与本地日期相同，绝不能误拦截！）
              utcNow = Date.parse("2026-12-21T23:30:00Z"); // 本地 2026-12-21 23:30, UTC+8 2026-12-22 07:30
              const d2 = await sUtc.tick();
              assert.strictEqual(d2.ran, true, "UTC 时区 23:30 设置第 2 天必须正常调用");
              assert.strictEqual(d2.date, "2026-12-22");
              assert.strictEqual(sUtc.getState().doneLocalDate, "2026-12-21");
              assert.strictEqual(loadSettings(utcStorage).lastRunDate, "2026-12-22");
              assert.strictEqual(collectedBatches.length - startCount, 2);
              assert.strictEqual(notifies.length, 2);
              sUtc.stop();

              // 模拟第 3 天重启新调度器（带持久化 lastRunDate="2026-12-22"）同样正常触发
              utcNow = Date.parse("2026-12-22T23:30:00Z"); // 本地 2026-12-22 23:30, UTC+8 2026-12-23 07:30
              const sUtcRestart = createStatsScheduler({
                storage: utcStorage,
                now: () => utcNow,
                monotonicNow: () => STARTUP_DELAY_MS,
                startupDelayMs: 0,
                getAccounts: () => utcAccs,
                setIntervalFn: () => 2,
                clearIntervalFn: () => {},
              });
              sUtcRestart.start();
              const d3 = await sUtcRestart.tick();
              assert.strictEqual(d3.ran, true);
              assert.strictEqual(d3.date, "2026-12-23");
              assert.strictEqual(collectedBatches.length - startCount, 3);
              sUtcRestart.stop();
            }
          );
        } finally {
          if (origTZ === undefined) delete process.env.TZ;
          else process.env.TZ = origTZ;
        }
        console.log("✓ UTC 时区 23:30 设置连续多天（含重启）均正常调用，不混用本地与 UTC+8 日期");
      }
    } finally {
      if (origGlobalLS === undefined) delete global.localStorage;
      else global.localStorage = origGlobalLS;

      for (const [id, entry] of [
        [electronId, origCache.electron],
        [collectorId, origCache.collector],
        [storeId, origCache.store],
        [indexId, origCache.index],
        [statsApiId, origCache.statsApi],
      ]) {
        if (entry) require.cache[id] = entry;
        else delete require.cache[id];
      }
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  console.log("\n全部通过：每日定时自动采集调度器、主进程 stats:auto-run 与 partition 跳重");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
