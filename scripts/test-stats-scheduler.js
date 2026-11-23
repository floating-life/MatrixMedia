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
  END_SLOT_GRACE_MS,
  VALID_INTERVAL_HOURS,
  DEFAULT_RETENTION_DAYS,
  formatLocalDate,
  formatUtc8Date,
  normalizeSettings,
  buildScheduleSlots,
  getCurrentSlot,
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
      { ...DEFAULT_SETTINGS, enabled: false, time: "10:00", lastRunDate: "2026-11-18" }
    );
    assert.deepStrictEqual(
      normalizeSettings({ enabled: "false", time: "10:60", lastRunDate: "2026-02-30" }),
      { ...DEFAULT_SETTINGS, enabled: true, time: "10:00", lastRunDate: "" }
    );
    assert.deepStrictEqual(
      normalizeSettings({ enabled: true, time: "08:30", lastRunDate: "2024-02-29" }),
      { ...DEFAULT_SETTINGS, enabled: true, time: "08:30", lastRunDate: "2024-02-29" }
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
        ...DEFAULT_SETTINGS,
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
      ...DEFAULT_SETTINGS,
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
                // 日期在开跑前已落盘：A 采集期间 B 直接得到 already-ran
                assert.deepStrictEqual(resB1, { ran: false, reason: "already-ran", date: "2026-11-22" });
                assert.strictEqual(store.readAutoRuns().includes("2026-11-22"), true);

                gate3.resolve();
                const resA = await pA;
                assert.strictEqual(resA.ran, true);
                assert.strictEqual(collectedBatches.length - startLen, 1);
                assert.strictEqual(notifiesA.length, 1);
                assert.strictEqual(notifiesB.length, 0);

                // 下一分钟 B：本地已标记当天完成，不再调用主进程
                const resB2 = await winB.tick();
                assert.deepStrictEqual(resB2, { ran: false, reason: "not-due" });
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
              const beforeBatches = collectedBatches.length;
              const res = await autoRunHandler(fakeEvent, {
                accounts: [{ group: "DiskG", platform: "抖音", partition: "persist:DiskG-抖音" }],
              });
              // 开跑前落盘失败 → 不采集
              assert.strictEqual(res.status, "store-failed");
              assert.strictEqual(collectedBatches.length, beforeBatches, "落盘失败不得采集");
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
        // 磁盘恢复后下一轮：正常落盘并采集一次；同日再触发 already-ran，不重采
        {
          const before = collectedBatches.length;
          await withMockDateNow(
            () => cnTime(2026, 11, 26, 10, 1, 0),
            async () => {
              const ok = await autoRunHandler(fakeEvent, {
                accounts: [{ group: "DiskG2", platform: "抖音", partition: "persist:DiskG2-抖音" }],
              });
              assert.strictEqual(ok.status, "done");
              const again = await autoRunHandler(fakeEvent, {
                accounts: [{ group: "DiskG3", platform: "抖音", partition: "persist:DiskG3-抖音" }],
              });
              assert.strictEqual(again.status, "already-ran");
            }
          );
          assert.strictEqual(collectedBatches.length, before + 1, "同日只自动采集一次");
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

      /* ---- 7. S9 分时段自动采集：槽计算、旧设置迁移、跳槽不补采、按槽 auto-run.json 与分区跳重 ---- */
      {
        // 7a. 旧设置迁移为 mode=daily，不擅自提高采集频率
        assert.deepStrictEqual(VALID_INTERVAL_HOURS, [1, 2, 3, 4, 6]);
        assert.strictEqual(DEFAULT_RETENTION_DAYS, 60);
        const migrated = normalizeSettings({ enabled: true, time: "09:30" });
        assert.strictEqual(migrated.mode, "daily", "旧设置 {enabled, time} 应自动迁移为 mode=daily");
        assert.strictEqual(migrated.time, "09:30");
        assert.strictEqual(migrated.startTime, "08:00");
        assert.strictEqual(migrated.endTime, "22:00");
        assert.strictEqual(migrated.intervalHours, 2);
        assert.strictEqual(migrated.retentionDays, 60);
        // 非法 intervalHours / mode / retentionDays 回落默认
        const badInterval = normalizeSettings({
          enabled: true,
          mode: "interval",
          startTime: "08:00",
          endTime: "22:00",
          intervalHours: 5,
          retentionDays: -1,
        });
        assert.strictEqual(badInterval.mode, "interval");
        assert.strictEqual(badInterval.intervalHours, 2);
        assert.strictEqual(badInterval.retentionDays, 60);

        // 7b. 槽计算（默认 08:00-22:00 每 2 小时，endTime 落在槽上）
        const slots2h = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "08:00",
          endTime: "22:00",
          intervalHours: 2,
        });
        assert.deepStrictEqual(
          slots2h.map((s) => s.slot),
          [
            "2026-11-20 08:00",
            "2026-11-20 10:00",
            "2026-11-20 12:00",
            "2026-11-20 14:00",
            "2026-11-20 16:00",
            "2026-11-20 18:00",
            "2026-11-20 20:00",
            "2026-11-20 22:00",
          ],
          "endTime 落在槽上应包含 22:00"
        );

        // endTime 不落在槽上（08:00-21:00 每 2 小时 → 最后一个槽为 20:00）
        const slotsOff = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "08:00",
          endTime: "21:00",
          intervalHours: 2,
        });
        assert.deepStrictEqual(
          slotsOff.map((s) => s.slot),
          [
            "2026-11-20 08:00",
            "2026-11-20 10:00",
            "2026-11-20 12:00",
            "2026-11-20 14:00",
            "2026-11-20 16:00",
            "2026-11-20 18:00",
            "2026-11-20 20:00",
          ],
          "endTime 不落在槽上时最后一个槽应为 20:00"
        );

        // 间隔 1 / 3 / 6 小时
        const slots1h = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "09:00",
          endTime: "12:00",
          intervalHours: 1,
        });
        assert.deepStrictEqual(
          slots1h.map((s) => s.slot),
          ["2026-11-20 09:00", "2026-11-20 10:00", "2026-11-20 11:00", "2026-11-20 12:00"]
        );
        const slots3h = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "08:00",
          endTime: "20:00",
          intervalHours: 3,
        });
        assert.deepStrictEqual(
          slots3h.map((s) => s.slot),
          ["2026-11-20 08:00", "2026-11-20 11:00", "2026-11-20 14:00", "2026-11-20 17:00", "2026-11-20 20:00"]
        );
        const slots6h = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "06:00",
          endTime: "23:00",
          intervalHours: 6,
        });
        assert.deepStrictEqual(
          slots6h.map((s) => s.slot),
          ["2026-11-20 06:00", "2026-11-20 12:00", "2026-11-20 18:00"]
        );

        // 跨零点（endTime < startTime：22:00-04:00 每 2 小时，槽日期按槽开始时刻 UTC+8 日历日）
        const slotsCross = buildScheduleSlots("2026-11-20", {
          mode: "interval",
          startTime: "22:00",
          endTime: "04:00",
          intervalHours: 2,
        });
        assert.deepStrictEqual(
          slotsCross.map((s) => s.slot),
          ["2026-11-20 22:00", "2026-11-21 00:00", "2026-11-21 02:00", "2026-11-21 04:00"]
        );
        // 跨零点实时槽匹配：UTC+8 2026-11-21 01:30 应命中 "2026-11-21 00:00"
        const crossCfg = {
          enabled: true,
          mode: "interval",
          startTime: "22:00",
          endTime: "04:00",
          intervalHours: 2,
        };
        const activeCross = getCurrentSlot(cnTime(2026, 11, 21, 1, 30, 0), crossCfg);
        assert.ok(activeCross && activeCross.slot === "2026-11-21 00:00");
        assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 6, 0, 0), crossCfg), null, "超出最后一个槽窗口应返回 null");
        assert.strictEqual(formatUtc8Date(cnTime(2026, 11, 21, 0, 1, 0)), "2026-11-21");

        // 7c. 渲染层调度：同槽只跑一次 + busy 过槽放弃 + 休眠跳槽不补采
        {
          const ivStorage = createMemoryStorage();
          saveSettings(
            {
              enabled: true,
              mode: "interval",
              startTime: "08:00",
              endTime: "22:00",
              intervalHours: 2,
            },
            ivStorage
          );
          let curNow = cnTime(2026, 11, 20, 7, 59, 0);
          let nextStatus = "done";
          const seenCalls = [];
          const ivNotifies = [];
          const sIv = createStatsScheduler({
            storage: ivStorage,
            now: () => curNow,
            monotonicNow: () => STARTUP_DELAY_MS,
            startupDelayMs: 0,
            getAccounts: () => [{ group: "IvG", platform: "抖音", partition: "persist:IvG-抖音" }],
            autoRun: async (_accs, meta) => {
              seenCalls.push(meta && meta.slot);
              if (nextStatus === "busy") return { status: "busy" };
              return { status: "done", date: meta.slot.slice(0, 10), slot: meta.slot, results: [{ success: true }] };
            },
            notify: (p) => ivNotifies.push(p),
            setIntervalFn: () => 1,
            clearIntervalFn: () => {},
          });
          sIv.start();

          // 07:59 未到 08:00 槽
          assert.deepStrictEqual(await sIv.tick(), { ran: false, reason: "not-due" });

          // 08:05 命中 08:00 槽并执行一次
          curNow = cnTime(2026, 11, 20, 8, 5, 0);
          const r08 = await sIv.tick();
          assert.strictEqual(r08.ran, true);
          assert.strictEqual(r08.slot, "2026-11-20 08:00");
          assert.strictEqual(loadSettings(ivStorage).lastRunSlot, "2026-11-20 08:00");
          assert.ok(ivNotifies[0].title.includes("08:00"));

          // 同槽 09:59 不再重跑
          curNow = cnTime(2026, 11, 20, 9, 59, 0);
          assert.deepStrictEqual(await sIv.tick(), { ran: false, reason: "not-due" });

          // 10:05 遇到 busy，11:50 再试仍 busy，12:01 已过下一槽 → 直接跑 12:00 放弃 10:00（绝不补采）
          nextStatus = "busy";
          curNow = cnTime(2026, 11, 20, 10, 5, 0);
          assert.strictEqual((await sIv.tick()).reason, "busy");
          curNow = cnTime(2026, 11, 20, 11, 50, 0);
          assert.strictEqual((await sIv.tick()).reason, "busy");
          nextStatus = "done";
          curNow = cnTime(2026, 11, 20, 12, 1, 0);
          const r12 = await sIv.tick();
          assert.strictEqual(r12.ran, true);
          assert.strictEqual(r12.slot, "2026-11-20 12:00");

          // 休眠跳过 14:00 / 16:00，唤醒在 18:10 → 只跑 18:00，不补采 14:00/16:00
          curNow = cnTime(2026, 11, 20, 18, 10, 0);
          const r18 = await sIv.tick();
          assert.strictEqual(r18.ran, true);
          assert.strictEqual(r18.slot, "2026-11-20 18:00");

          assert.deepStrictEqual(seenCalls, [
            "2026-11-20 08:00",
            "2026-11-20 10:00",
            "2026-11-20 10:00",
            "2026-11-20 12:00",
            "2026-11-20 18:00",
          ]);
          sIv.stop();
        }

        // 7d. 主进程按槽 auto-run.json（兼容旧按日期记录、14 天保留、expired 拒绝）与按槽分区跳重
        {
          // 预置旧按日期记录 + 多天槽记录验证兼容与 14 天保留
          const autoFile = store.autoRunFile();
          const legacyPlusSlots = ["2026-12-01"];
          for (let d = 2; d <= 16; d++) {
            const ds = `2026-12-${String(d).padStart(2, "0")}`;
            legacyPlusSlots.push(`${ds} 08:00`, `${ds} 10:00`);
          }
          fs.writeFileSync(autoFile, JSON.stringify({ runs: legacyPlusSlots }));
          const normalizedRuns = store.readAutoRuns();
          const keptDaySet = new Set(normalizedRuns.map((x) => x.slice(0, 10)));
          assert.strictEqual(keptDaySet.size, 14, "按槽 auto-run.json 应按日历日保留最近 14 天");
          assert.strictEqual(keptDaySet.has("2026-12-01"), false, "超 14 天的旧日期记录应被淘汰");
          assert.strictEqual(keptDaySet.has("2026-12-03"), true);
          assert.strictEqual(keptDaySet.has("2026-12-16"), true);

          // 旧记录与新槽同文件共存
          fs.writeFileSync(autoFile, JSON.stringify({ runs: ["2026-12-28", "2026-12-29 08:00"] }));
          const mergedRuns = store.appendAutoRun("2026-12-29 10:00");
          assert.deepStrictEqual(mergedRuns, ["2026-12-28", "2026-12-29 08:00", "2026-12-29 10:00"]);

          // 主进程非法槽 & 过期槽拦截（不落盘不采集）
          const badSlotRes = await autoRunHandler(fakeEvent, {
            slot: "not-a-slot",
            accounts: [{ group: "SlotG", platform: "抖音", partition: "persist:slot-a" }],
          });
          assert.strictEqual(badSlotRes.status, "invalid-slot");

          await withMockDateNow(
            () => cnTime(2026, 12, 30, 12, 0, 5),
            async () => {
              const expRes = await autoRunHandler(fakeEvent, {
                slot: "2026-12-30 10:00",
                slotEndMs: cnTime(2026, 12, 30, 12, 0, 0),
                accounts: [{ group: "SlotG", platform: "抖音", partition: "persist:slot-a" }],
              });
              assert.strictEqual(expRes.status, "expired", "已过下一槽时刻必须放弃");
              assert.strictEqual(
                store.readAutoRuns().includes("2026-12-30 10:00"),
                false,
                "过期槽不得写入 auto-run.json"
              );
            }
          );

          // 按槽分区跳重：10:15 手动采集 persist:slot-p1（取整到 10:00）→ 10:00 自动槽跳过 p1、采集 p2；12:00 下一槽 p1 不再跳过
          await withImmediateTimers(async () => {
            await withMockDateNow(
              () => cnTime(2026, 12, 30, 10, 15, 0),
              async () => {
                await collectHandler(fakeEvent, {
                  accounts: [{ group: "SlotG", platform: "抖音", partition: "persist:slot-p1" }],
                  trigger: "manual",
                });

                const before10 = collectedBatches.length;
                const res10 = await autoRunHandler(fakeEvent, {
                  slot: "2026-12-30 10:00",
                  slotEndMs: cnTime(2026, 12, 30, 12, 0, 0),
                  accounts: [
                    { group: "SlotG", platform: "抖音", partition: "persist:slot-p1" },
                    { group: "SlotG", platform: "快手", partition: "persist:slot-p2" },
                  ],
                });
                assert.strictEqual(res10.status, "done");
                assert.strictEqual(res10.slot, "2026-12-30 10:00");
                assert.strictEqual(res10.results[0].skipped, true, "同槽手动采集过的分区应跳过");
                assert.strictEqual(res10.results[1].skipped, undefined);
                assert.deepStrictEqual(
                  collectedBatches.slice(before10).map((x) => x.partition),
                  ["persist:slot-p2"]
                );

                // 同槽再次触发 → already-ran
                const dup10 = await autoRunHandler(fakeEvent, {
                  slot: "2026-12-30 10:00",
                  slotEndMs: cnTime(2026, 12, 30, 12, 0, 0),
                  accounts: [{ group: "SlotG", platform: "抖音", partition: "persist:slot-p1" }],
                });
                assert.strictEqual(dup10.status, "already-ran");
              }
            );

            await withMockDateNow(
              () => cnTime(2026, 12, 30, 12, 6, 0),
              async () => {
                const before12 = collectedBatches.length;
                const res12 = await autoRunHandler(fakeEvent, {
                  slot: "2026-12-30 12:00",
                  slotEndMs: cnTime(2026, 12, 30, 14, 0, 0),
                  accounts: [
                    { group: "SlotG", platform: "抖音", partition: "persist:slot-p1" },
                    { group: "SlotG", platform: "快手", partition: "persist:slot-p2" },
                  ],
                });
                assert.strictEqual(res12.status, "done");
                assert.strictEqual(res12.slot, "2026-12-30 12:00");
                assert.deepStrictEqual(
                  collectedBatches.slice(before12).map((x) => x.partition),
                  ["persist:slot-p1", "persist:slot-p2"],
                  "进入下一槽 12:00 且满足防高频硬下限后，10:00 槽采过的分区应重新采集"
                );
              }
            );
          });
        }
        console.log("✓ S9 分时段自动采集（槽计算/跨零点/旧设置迁移/跳槽不补采/按槽 auto-run.json/按槽跳重）通过");
      }

      /* ---- 8. S9-fix #1/#2/#3 专项回归（使用评审时刻与数字，修前失败、修后通过） ---- */
      {
        const saveAutoSettingsHandler = ipcHandlers.get("stats:save-auto-settings");
        const getAutoSettingsHandler = ipcHandlers.get("stats:get-auto-settings");
        assert.strictEqual(typeof saveAutoSettingsHandler, "function", "应注册 stats:save-auto-settings IPC");
        assert.strictEqual(typeof getAutoSettingsHandler, "function", "应注册 stats:get-auto-settings IPC");

        // testS9Fix3_LastSlotCappedAtEndTimeAndGraceWindow
        // 评审 #3：08:00-21:00 每 2 小时，21:30 恢复运行时不得启动 20:00 槽；endTime 恰落槽上留 5 分钟轮询窗口；跨零点同理
        {
          assert.strictEqual(END_SLOT_GRACE_MS, 5 * 60 * 1000);
          const cfg21 = {
            enabled: true,
            mode: "interval",
            startTime: "08:00",
            endTime: "21:00",
            intervalHours: 2,
          };
          const slots21 = buildScheduleSlots("2026-11-20", cfg21);
          const last21 = slots21[slots21.length - 1];
          assert.strictEqual(last21.slot, "2026-11-20 20:00");
          assert.strictEqual(last21.startMs, cnTime(2026, 11, 20, 20, 0, 0));
          assert.strictEqual(last21.endMs, cnTime(2026, 11, 20, 21, 0, 0), "末槽有效期必须截断到 endTime 21:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 20, 59, 0), cfg21).slot, "2026-11-20 20:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 21, 0, 0), cfg21), null, "到达 21:00 末槽应截止");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 21, 30, 0), cfg21), null, "21:30 恢复运行不得启动 20:00 槽");

          // 调度器 21:30 恢复运行也不得调用 autoRun
          let callsAt2130 = 0;
          const s21Storage = createMemoryStorage();
          saveSettings(cfg21, s21Storage);
          const s21 = createStatsScheduler({
            storage: s21Storage,
            now: () => cnTime(2026, 11, 20, 21, 30, 0),
            monotonicNow: () => STARTUP_DELAY_MS,
            startupDelayMs: 0,
            getAccounts: () => [{ group: "CapG", platform: "抖音", partition: "persist:cap-dy" }],
            autoRun: async () => {
              callsAt2130++;
              return { status: "done", date: "2026-11-20", slot: "2026-11-20 20:00", results: [] };
            },
            setIntervalFn: () => 1,
            clearIntervalFn: () => {},
          });
          s21.start();
          assert.deepStrictEqual(await s21.tick(), { ran: false, reason: "not-due" });
          assert.strictEqual(callsAt2130, 0);
          s21.stop();

          // endTime 恰为槽时刻（08:00-22:00 每 2 小时）：末槽 22:00 有效期 [22:00, 22:05)
          const cfg22 = {
            enabled: true,
            mode: "interval",
            startTime: "08:00",
            endTime: "22:00",
            intervalHours: 2,
          };
          const slots22 = buildScheduleSlots("2026-11-20", cfg22);
          const last22 = slots22[slots22.length - 1];
          assert.strictEqual(last22.slot, "2026-11-20 22:00");
          assert.strictEqual(last22.endMs, cnTime(2026, 11, 20, 22, 5, 0), "endTime 恰落槽上应给 5 分钟轮询窗口");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 22, 0, 0), cfg22).slot, "2026-11-20 22:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 22, 4, 59), cfg22).slot, "2026-11-20 22:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 22, 5, 0), cfg22), null);

          // 跨零点不落槽上（22:00-03:00 每 2 小时）：末槽次日 02:00 截断到 03:00
          const cfgCrossOff = {
            enabled: true,
            mode: "interval",
            startTime: "22:00",
            endTime: "03:00",
            intervalHours: 2,
          };
          const slotsCrossOff = buildScheduleSlots("2026-11-20", cfgCrossOff);
          const lastCrossOff = slotsCrossOff[slotsCrossOff.length - 1];
          assert.strictEqual(lastCrossOff.slot, "2026-11-21 02:00");
          assert.strictEqual(lastCrossOff.endMs, cnTime(2026, 11, 21, 3, 0, 0));
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 2, 59, 0), cfgCrossOff).slot, "2026-11-21 02:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 3, 0, 0), cfgCrossOff), null);
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 3, 30, 0), cfgCrossOff), null);

          // 跨零点恰落槽上（22:00-04:00 每 2 小时）：末槽次日 04:00 有效期 [04:00, 04:05)
          const cfgCrossOn = {
            enabled: true,
            mode: "interval",
            startTime: "22:00",
            endTime: "04:00",
            intervalHours: 2,
          };
          const slotsCrossOn = buildScheduleSlots("2026-11-20", cfgCrossOn);
          const lastCrossOn = slotsCrossOn[slotsCrossOn.length - 1];
          assert.strictEqual(lastCrossOn.slot, "2026-11-21 04:00");
          assert.strictEqual(lastCrossOn.endMs, cnTime(2026, 11, 21, 4, 5, 0));
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 4, 4, 0), cfgCrossOn).slot, "2026-11-21 04:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 4, 5, 0), cfgCrossOn), null);
          console.log("✓ [S9-fix #3] testS9Fix3_LastSlotCappedAtEndTimeAndGraceWindow 通过");
        }

        // testS9Fix1_ManualCollectInSameSlotSkippedByAutoRun
        // 评审 #1：默认每 2 小时（08:00-22:00），11:15 手动同步成功，11:16 首轮自动轮询触发 10:00 槽不得重采同一账号
        {
          // 用新子目录与干净 index.js 实例隔离状态
          const fix1Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix1-"));
          const origGetPath = require.cache[electronId].exports.app.getPath;
          require.cache[electronId].exports.app.getPath = () => fix1Root;
          delete require.cache[storeId];
          delete require.cache[indexId];
          const localHandlers = new Map();
          const origHandle = require.cache[electronId].exports.ipcMain.handle;
          require.cache[electronId].exports.ipcMain.handle = (ch, fn) => localHandlers.set(ch, fn);
          try {
            require(indexId).registerDataStatsIpc();
            const cHandler = localHandlers.get("stats:collect");
            const aHandler = localHandlers.get("stats:auto-run");
            const acc1 = { group: "Fix1G", platform: "抖音", partition: "persist:fix1-dy" };
            const acc2 = { group: "Fix1G", platform: "快手", partition: "persist:fix1-ks" };
            let mockNow = cnTime(2026, 11, 20, 11, 15, 0);
            const fix1Storage = createMemoryStorage();
            saveSettings(
              { enabled: true, mode: "interval", startTime: "08:00", endTime: "22:00", intervalHours: 2 },
              fix1Storage
            );
            const fix1Sched = createStatsScheduler({
              storage: fix1Storage,
              now: () => mockNow,
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              getAccounts: () => [acc1, acc2],
              autoRun: (accounts, meta) => aHandler(fakeEvent, { accounts, ...meta }),
              setIntervalFn: () => 1,
              clearIntervalFn: () => {},
            });
            fix1Sched.start();

            await withImmediateTimers(async () => {
              await withMockDateNow(() => mockNow, async () => {
                // 11:15 手动同步 acc1，记录 collectedAt
                const manRes = await cHandler(fakeEvent, { accounts: [acc1], trigger: "manual" });
                assert.strictEqual(manRes.results[0].success, true);
                assert.strictEqual(manRes.results[0].collectedAt, cnTime(2026, 11, 20, 11, 15, 0));

                // 11:16 首轮自动轮询命中 10:00 槽 [10:00, 12:00)：acc1 必须跳过，仅采 acc2
                mockNow = cnTime(2026, 11, 20, 11, 16, 0);
                const beforeAuto = collectedBatches.length;
                const tickRes = await fix1Sched.tick();
                assert.strictEqual(tickRes.ran, true);
                assert.strictEqual(tickRes.slot, "2026-11-20 10:00");
                assert.strictEqual(tickRes.result.results[0].skipped, true, "11:15 手动采集落在 10:00 槽 [10:00,12:00) 内，11:16 自动槽必须跳过");
                assert.strictEqual(tickRes.result.results[1].skipped, undefined);
                assert.deepStrictEqual(
                  collectedBatches.slice(beforeAuto).map((x) => x.partition),
                  ["persist:fix1-ks"]
                );

                // 进入 14:00 槽（满足防高频下限）→ acc1 不再跳过
                mockNow = cnTime(2026, 11, 20, 14, 1, 0);
                const before14 = collectedBatches.length;
                const tick14 = await fix1Sched.tick();
                assert.strictEqual(tick14.ran, true);
                assert.strictEqual(tick14.slot, "2026-11-20 14:00");
                assert.deepStrictEqual(
                  collectedBatches.slice(before14).map((x) => x.partition),
                  ["persist:fix1-dy", "persist:fix1-ks"]
                );
              });
            });
            fix1Sched.stop();
          } finally {
            require.cache[electronId].exports.app.getPath = origGetPath;
            require.cache[electronId].exports.ipcMain.handle = origHandle;
            fs.rmSync(fix1Root, { recursive: true, force: true });
          }
          console.log("✓ [S9-fix #1] testS9Fix1_ManualCollectInSameSlotSkippedByAutoRun 通过");
        }

        // testS9Fix2_RateLimitFloorAndSettingsChangeEffectiveBoundary
        // 评审 #2：10:01 跑完 10:00 槽，10:02 改 startTime 08:00->08:30，10:02 不补跑 08:30 槽；
        // 且距上次自动采集 < intervalHours*60-10 分钟（2h -> 110 分钟）硬下限跳过本槽，满 110 分钟后新槽正常跑
        {
          const fix2Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix2-"));
          const origGetPath = require.cache[electronId].exports.app.getPath;
          const origHandle = require.cache[electronId].exports.ipcMain.handle;
          require.cache[electronId].exports.app.getPath = () => fix2Root;
          delete require.cache[storeId];
          delete require.cache[indexId];
          const localHandlers = new Map();
          require.cache[electronId].exports.ipcMain.handle = (ch, fn) => localHandlers.set(ch, fn);
          try {
            require(indexId).registerDataStatsIpc();
            const aHandler = localHandlers.get("stats:auto-run");
            const saveSettingsHandler = localHandlers.get("stats:save-auto-settings");
            const acc = { group: "Fix2G", platform: "抖音", partition: "persist:fix2-dy" };
            let mockNow = cnTime(2026, 11, 20, 10, 1, 0);

            const fix2Storage = createMemoryStorage();
            saveSettings(
              { enabled: true, mode: "interval", startTime: "08:00", endTime: "22:00", intervalHours: 2 },
              fix2Storage
            );
            const fix2Sched = createStatsScheduler({
              storage: fix2Storage,
              now: () => mockNow,
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              getAccounts: () => [acc],
              // 模拟评审脚本只传 { accounts, slot, slotEndMs, retentionDays }，也验证主进程独立防高频
              autoRun: (accounts, { slot, slotEndMs, retentionDays }) =>
                aHandler(fakeEvent, { accounts, slot, slotEndMs, retentionDays }),
              setIntervalFn: () => 1,
              clearIntervalFn: () => {},
            });
            fix2Sched.start();

            await withImmediateTimers(async () => {
              await withMockDateNow(() => mockNow, async () => {
                // 1) 10:01 跑完 10:00 槽
                const before10 = collectedBatches.length;
                const r10 = await fix2Sched.tick();
                assert.strictEqual(r10.ran, true);
                assert.strictEqual(r10.slot, "2026-11-20 10:00");
                assert.strictEqual(collectedBatches.length, before10 + 1);

                // 2) 10:02 修改开始时间 08:00 -> 08:30（并同步主进程设置）
                mockNow = cnTime(2026, 11, 20, 10, 2, 0);
                updateSettings({ startTime: "08:30" }, fix2Storage);
                await saveSettingsHandler(fakeEvent, {
                  enabled: true,
                  mode: "interval",
                  startTime: "08:30",
                  endTime: "22:00",
                  intervalHours: 2,
                });

                // 调度器在 10:02 轮询不得补跑已开始的 08:30 槽
                const rChange = await fix2Sched.tick();
                assert.strictEqual(rChange.ran, false);
                assert.strictEqual(rChange.reason, "before-settings-change");
                assert.strictEqual(collectedBatches.length, before10 + 1);

                // 即使绕过调度器直接调主进程 stats:auto-run 跑 08:30 槽，主进程必须拒绝（生效边界）
                const directEarly = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 08:30",
                  slotEndMs: cnTime(2026, 11, 20, 10, 30, 0),
                });
                assert.strictEqual(directEarly.status, "skipped");
                assert.strictEqual(directEarly.reason, "before-settings-change");
                assert.strictEqual(collectedBatches.length, before10 + 1);

                // 3) 10:31 进入新槽 10:30（槽开始 10:30 >= 变更时刻 10:02），但距 10:01 仅 30 分钟 < 110 分钟硬下限 → 主进程跳过本槽
                mockNow = cnTime(2026, 11, 20, 10, 31, 0);
                const r1030 = await fix2Sched.tick();
                assert.strictEqual(r1030.ran, false);
                assert.strictEqual(r1030.reason, "rate-limited");
                assert.strictEqual(collectedBatches.length, before10 + 1);

                // 11:50（距 10:01 仅 109 分钟 < 110 分钟）即便换未跑过的新槽 11:30 仍被硬下限挡住
                mockNow = cnTime(2026, 11, 20, 11, 50, 0);
                const r109m = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 11:30",
                  slotEndMs: cnTime(2026, 11, 20, 13, 30, 0),
                });
                assert.strictEqual(r109m.status, "skipped");
                assert.strictEqual(r109m.reason, "rate-limited");
                assert.strictEqual(collectedBatches.length, before10 + 1);

                // 4) 12:30 槽（距 10:01 已 149 分钟 >= 110 分钟）→ 正常采集
                mockNow = cnTime(2026, 11, 20, 12, 30, 0);
                const r1230 = await fix2Sched.tick();
                assert.strictEqual(r1230.ran, true);
                assert.strictEqual(r1230.slot, "2026-11-20 12:30");
                assert.strictEqual(collectedBatches.length, before10 + 2);

                // 5) 1 小时间隔硬下限 = 50 分钟：13:19（49 分钟）跳过，13:30 槽在 13:30（60 分钟 >= 50 分钟）放行
                mockNow = cnTime(2026, 11, 20, 12, 35, 0);
                await saveSettingsHandler(fakeEvent, {
                  enabled: true,
                  mode: "interval",
                  startTime: "08:30",
                  endTime: "22:30",
                  intervalHours: 1,
                });
                mockNow = cnTime(2026, 11, 20, 13, 19, 0);
                const r49m = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 13:00",
                  slotEndMs: cnTime(2026, 11, 20, 14, 0, 0),
                  intervalHours: 1,
                });
                assert.strictEqual(r49m.status, "skipped");
                assert.strictEqual(r49m.reason, "rate-limited");

                mockNow = cnTime(2026, 11, 20, 13, 30, 0);
                const r60m = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 13:30",
                  slotEndMs: cnTime(2026, 11, 20, 14, 30, 0),
                  intervalHours: 1,
                });
                assert.strictEqual(r60m.status, "done");
              });
            });
            fix2Sched.stop();
          } finally {
            require.cache[electronId].exports.app.getPath = origGetPath;
            require.cache[electronId].exports.ipcMain.handle = origHandle;
            fs.rmSync(fix2Root, { recursive: true, force: true });
          }
          console.log("✓ [S9-fix #2] testS9Fix2_RateLimitFloorAndSettingsChangeEffectiveBoundary 通过");
        }

        // testS9R3_3_SlotClaimSeparatedFromAutoRunRateLimitTimestamp
        // 评审2 #3：单账号 11:15 手动同步，11:16 自动轮询 10:00 槽跳过该账号（只记槽认领、不更新上次自动采集时间），
        // 12:00 槽必须正常采集，12:01 再次轮询返回 already-ran
        {
          const r3Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9r3-3-"));
          const origGetPath = require.cache[electronId].exports.app.getPath;
          const origHandle = require.cache[electronId].exports.ipcMain.handle;
          const localHandlers = new Map();
          require.cache[electronId].exports.app.getPath = () => r3Root;
          require.cache[electronId].exports.ipcMain.handle = (ch, fn) => localHandlers.set(ch, fn);
          delete require.cache[storeId];
          delete require.cache[indexId];
          try {
            const storeR3 = require(storeId);
            require(indexId).registerDataStatsIpc();
            const cHandler = localHandlers.get("stats:collect");
            const aHandler = localHandlers.get("stats:auto-run");
            const acc = { group: "示例", platform: "抖音", partition: "persist:demo抖音" };
            let mockNow = cnTime(2026, 11, 20, 11, 15, 0);

            await withImmediateTimers(async () => {
              await withMockDateNow(() => mockNow, async () => {
                const startBatches = collectedBatches.length;

                // 1) 11:15 手动同步成功
                const manRes = await cHandler(fakeEvent, { accounts: [acc], trigger: "manual" });
                assert.strictEqual(manRes.results[0].success, true);
                assert.strictEqual(collectedBatches.length, startBatches + 1);

                // 2) 11:16 自动轮询 10:00 槽 [10:00, 12:00)：该账号被跳过，只记槽认领，不写 lastAutoRunAt
                mockNow = cnTime(2026, 11, 20, 11, 16, 0);
                const sameRes = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 10:00",
                  slotEndMs: cnTime(2026, 11, 20, 12, 0, 0),
                  intervalHours: 2,
                  startTime: "08:00",
                  endTime: "22:00",
                });
                assert.strictEqual(sameRes.status, "done");
                assert.strictEqual(sameRes.results[0].skipped, true, "11:16 必须跳过 11:15 手动同步过的账号");
                assert.strictEqual(collectedBatches.length, startBatches + 1, "11:16 不得发起实际采集");
                const ledger11 = JSON.parse(fs.readFileSync(storeR3.autoRunFile(), "utf8"));
                assert.deepStrictEqual(ledger11.runs, ["2026-11-20 10:00"], "应记录 10:00 槽认领");
                assert.strictEqual(
                  ledger11.lastAutoRunAt,
                  undefined,
                  "全部分区跳过时不得写入上次自动采集时间 lastAutoRunAt"
                );

                // 3) 12:00 槽 [12:00, 14:00)：必须正常采集，不得被 11:16 的全跳过误限流
                mockNow = cnTime(2026, 11, 20, 12, 0, 0);
                const noonRes = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 12:00",
                  slotEndMs: cnTime(2026, 11, 20, 14, 0, 0),
                  intervalHours: 2,
                  startTime: "08:00",
                  endTime: "22:00",
                });
                assert.strictEqual(noonRes.status, "done", "12:00 槽必须正常采集而非 rate-limited");
                assert.strictEqual(noonRes.results[0].skipped, undefined);
                assert.strictEqual(noonRes.results[0].success, true);
                assert.strictEqual(collectedBatches.length, startBatches + 2, "12:00 槽必须发起真实采集");
                const ledger12 = JSON.parse(fs.readFileSync(storeR3.autoRunFile(), "utf8"));
                assert.strictEqual(
                  ledger12.lastAutoRunAt,
                  cnTime(2026, 11, 20, 12, 0, 0),
                  "实际发起自动采集后应更新 lastAutoRunAt"
                );

                // 4) 12:01 再次轮询 12:00 槽 → already-ran，不重采
                mockNow = cnTime(2026, 11, 20, 12, 1, 0);
                const retryRes = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 12:00",
                  slotEndMs: cnTime(2026, 11, 20, 14, 0, 0),
                  intervalHours: 2,
                  startTime: "08:00",
                  endTime: "22:00",
                });
                assert.strictEqual(retryRes.status, "already-ran");
                assert.strictEqual(collectedBatches.length, startBatches + 2);

                // 5) 已有 12:00 限流时间后，13:55 手动同步 + 13:56 全跳过 14:00 前某槽不会把 12:00 改写成 13:56；
                //    而 12:30 距 12:00 仅 30 分钟 < 110 分钟仍被限流
                mockNow = cnTime(2026, 11, 20, 12, 30, 0);
                const rlRes = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 12:30",
                  slotEndMs: cnTime(2026, 11, 20, 14, 30, 0),
                  intervalHours: 2,
                });
                assert.strictEqual(rlRes.status, "skipped");
                assert.strictEqual(rlRes.reason, "rate-limited");

                // 6) 若某槽确实发起了自动采集但采集失败，仍应更新限流时间防止紧接着高频重采
                const origImplR3 = collectorImpl;
                mockNow = cnTime(2026, 11, 20, 14, 0, 0);
                collectorImpl = async () => {
                  throw new Error("模拟平台超时");
                };
                try {
                  const failAuto = await aHandler(fakeEvent, {
                    accounts: [acc],
                    slot: "2026-11-20 14:00",
                    slotEndMs: cnTime(2026, 11, 20, 16, 0, 0),
                    intervalHours: 2,
                  });
                  assert.strictEqual(failAuto.status, "done");
                  assert.strictEqual(failAuto.results[0].success, false);
                } finally {
                  collectorImpl = origImplR3;
                }
                const ledger14 = JSON.parse(fs.readFileSync(storeR3.autoRunFile(), "utf8"));
                assert.strictEqual(ledger14.lastAutoRunAt, cnTime(2026, 11, 20, 14, 0, 0));
                mockNow = cnTime(2026, 11, 20, 14, 30, 0);
                const afterFailRl = await aHandler(fakeEvent, {
                  accounts: [acc],
                  slot: "2026-11-20 14:30",
                  slotEndMs: cnTime(2026, 11, 20, 16, 30, 0),
                  intervalHours: 2,
                });
                assert.strictEqual(afterFailRl.status, "skipped");
                assert.strictEqual(afterFailRl.reason, "rate-limited");

                // 7) S9-r4：采集请求发出时限流时间必须已落盘（模拟采集中途退出：请求进行中读盘即可看到）
                const origImplR4 = collectorImpl;
                mockNow = cnTime(2026, 11, 20, 16, 0, 0);
                let seenDuringCollect = null;
                collectorImpl = async (...a) => {
                  seenDuringCollect = JSON.parse(fs.readFileSync(storeR3.autoRunFile(), "utf8"));
                  return origImplR4(...a);
                };
                try {
                  const r16 = await aHandler(fakeEvent, {
                    accounts: [acc],
                    slot: "2026-11-20 16:00",
                    slotEndMs: cnTime(2026, 11, 20, 18, 0, 0),
                    intervalHours: 2,
                  });
                  assert.strictEqual(r16.status, "done");
                } finally {
                  collectorImpl = origImplR4;
                }
                assert.ok(seenDuringCollect, "采集器应被调用");
                assert.strictEqual(
                  seenDuringCollect.lastAutoRunAt,
                  cnTime(2026, 11, 20, 16, 0, 0),
                  "采集进行中 auto-run.json 必须已含本次 lastAutoRunAt（中途退出重启不绕过限流）"
                );
                assert.strictEqual(
                  seenDuringCollect.partitionAutoRunAt && seenDuringCollect.partitionAutoRunAt["persist:demo抖音"],
                  cnTime(2026, 11, 20, 16, 0, 0)
                );

                // 8) 时钟回拨：较早时间不得覆盖较新限流记录
                storeR3.updateAutoRunTimestamps({
                  lastAutoRunAt: cnTime(2026, 11, 20, 13, 55, 0),
                  partitionAutoRunAt: { "persist:demo抖音": cnTime(2026, 11, 20, 13, 55, 0) },
                });
                const ledgerRb = JSON.parse(fs.readFileSync(storeR3.autoRunFile(), "utf8"));
                assert.strictEqual(ledgerRb.lastAutoRunAt, cnTime(2026, 11, 20, 16, 0, 0), "时钟回拨不得回退全局限流时间");
                assert.strictEqual(ledgerRb.partitionAutoRunAt["persist:demo抖音"], cnTime(2026, 11, 20, 16, 0, 0), "时钟回拨不得回退分区限流时间");
              });
            });
          } finally {
            require.cache[electronId].exports.app.getPath = origGetPath;
            require.cache[electronId].exports.ipcMain.handle = origHandle;
            fs.rmSync(r3Root, { recursive: true, force: true });
          }
          console.log("✓ [S9-r3 #3] testS9R3_3_SlotClaimSeparatedFromAutoRunRateLimitTimestamp 通过");
        }

        // testS9R3_1_StatsApiAndSchedulerNeverSendOrOverrideRetentionDays
        // 评审2 #1：主进程已保存 retentionDays=90 并关闭自动采集，渲染层仍缓存 60 天；
        // 重启后手动同步不得携带或覆盖 retentionDays，不得误删 70 天前（2026-09-11.json）快照
        {
          const fix4ApiRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9r3-1-api-"));
          const origGetPath = require.cache[electronId].exports.app.getPath;
          const origHandle = require.cache[electronId].exports.ipcMain.handle;
          const origInvoke = require.cache[electronId].exports.ipcRenderer.invoke;
          const origLS = global.localStorage;
          const apiHandlers = new Map();
          const sentPayloads = [];
          try {
            require.cache[electronId].exports.app.getPath = () => fix4ApiRoot;
            require.cache[electronId].exports.ipcMain.handle = (ch, fn) => apiHandlers.set(ch, fn);
            require.cache[electronId].exports.ipcRenderer.invoke = async (ch, payload) => {
              sentPayloads.push({ ch, payload });
              const fn = apiHandlers.get(ch);
              return fn
                ? fn({ sender: { send: () => {} }, senderFrame: { url: "file:///app/index.html" } }, payload)
                : null;
            };
            const startMainApi = () => {
              apiHandlers.clear();
              delete require.cache[storeId];
              delete require.cache[indexId];
              const s = require(storeId);
              require(indexId).registerDataStatsIpc();
              return s;
            };
            delete require.cache[statsApiId];
            let storeApi = startMainApi();
            const statsApiMod = require(statsApiId);
            const acc = { group: "示例", platform: "抖音", partition: "persist:demo抖音" };
            const oldDay = "2026-09-11";
            const tToday = cnTime(2026, 11, 20, 9, 0, 0);

            await withMockDateNow(() => tToday, async () => {
              // 1) 写入 70 天前历史快照（2026-09-11.json）
              storeApi.recordWorksIntraday(acc.group, acc.platform, [{ workId: "W1", play: 20 }], {
                now: cnTime(2026, 9, 11, 10, 0, 0),
                retentionDays: 90,
              });
              const retentionFile = path.join(
                storeApi.worksIntradayDir(acc.group, acc.platform),
                `${oldDay}.json`
              );
              assert.strictEqual(fs.existsSync(retentionFile), true);

              // 2) 主进程保存 retentionDays=90 并关闭自动采集
              const saved = await apiHandlers.get("stats:save-auto-settings")(
                { senderFrame: { url: "file:///app/index.html" } },
                { enabled: false, mode: "daily", retentionDays: 90 }
              );
              assert.strictEqual(saved.ok, true);
              assert.strictEqual(saved.settings.retentionDays, 90);

              // 3) 模拟重启，渲染层 localStorage 仍残留旧缓存 retentionDays=60
              storeApi = startMainApi();
              const lsApi = createMemoryStorage({
                [STORAGE_KEY]: JSON.stringify({ enabled: false, mode: "daily", retentionDays: 60 }),
              });
              global.localStorage = lsApi;

              // 启动一次性迁移 initOnly:true 不得用缓存 60 覆盖主进程 90
              await schedulerMod.syncSettingsToMain(loadSettings(lsApi), { initOnly: true });
              assert.strictEqual(storeApi.readAutoSettings().retentionDays, 90);

              // 渲染层更新本地展示字段（saveSettings/updateSettings）不得覆盖主进程 90
              updateSettings({ lastRunDate: "2026-11-20" }, lsApi);
              assert.strictEqual(storeApi.readAutoSettings().retentionDays, 90);

              // 4) 重启后通过 statsApi.collectAccounts 手动同步：不携带 retentionDays、不覆盖主进程 90、不误删 2026-09-11.json
              sentPayloads.length = 0;
              await statsApiMod.collectAccounts([acc]);
              const lastCollect = sentPayloads.find((x) => x.ch === "stats:collect");
              assert.ok(lastCollect, "应调用 stats:collect");
              assert.strictEqual(lastCollect.payload.retentionDays, undefined, "stats:collect 不得携带 retentionDays");
              assert.strictEqual(storeApi.readAutoSettings().retentionDays, 90, "主进程 retentionDays 须保持 90");
              assert.strictEqual(fs.existsSync(retentionFile), true, "70 天前快照 2026-09-11.json 不得被误删");

              // 5) 调度器 defaultAutoRun 也不携带 retentionDays
              saveSettings({ enabled: true, mode: "interval", startTime: "08:00", endTime: "22:00", intervalHours: 2, retentionDays: 60 }, lsApi);
              sentPayloads.length = 0;
              const sNoRet = createStatsScheduler({
                storage: lsApi,
                now: () => cnTime(2026, 11, 20, 10, 5, 0),
                monotonicNow: () => STARTUP_DELAY_MS,
                startupDelayMs: 0,
                getAccounts: () => [acc],
                setIntervalFn: () => 1,
                clearIntervalFn: () => {},
              });
              sNoRet.start();
              await sNoRet.tick();
              sNoRet.stop();
              const autoSent = sentPayloads.find((x) => x.ch === "stats:auto-run");
              assert.ok(autoSent, "调度器应调用 stats:auto-run");
              assert.strictEqual(autoSent.payload.retentionDays, undefined, "stats:auto-run 不得携带 retentionDays");
              assert.strictEqual(storeApi.readAutoSettings().retentionDays, 90);
              assert.strictEqual(fs.existsSync(retentionFile), true);
            });
          } finally {
            if (origLS === undefined) delete global.localStorage;
            else global.localStorage = origLS;
            require.cache[electronId].exports.app.getPath = origGetPath;
            require.cache[electronId].exports.ipcMain.handle = origHandle;
            require.cache[electronId].exports.ipcRenderer.invoke = origInvoke;
            fs.rmSync(fix4ApiRoot, { recursive: true, force: true });
          }
          console.log("✓ [S9-r3 #1] testS9R3_1_StatsApiAndSchedulerNeverSendOrOverrideRetentionDays 通过");
        }

        // S13: 分时段循环支持全天 00:00–24:00（排他末端，不额外生成 24:00 槽；仅结束时间接受 24:00；旧配置不变）
        {
          // 1) 时间校验函数：仅 endTime 接受 24:00（=1440 分钟）
          assert.strictEqual(schedulerMod.isValidEndTimeStr("24:00"), true);
          assert.strictEqual(schedulerMod.isValidEndTimeStr("23:59"), true);
          assert.strictEqual(schedulerMod.isValidEndTimeStr("24:01"), false);
          assert.strictEqual(schedulerMod.isValidEndTimeStr("24:30"), false);
          assert.strictEqual(schedulerMod.isValidTimeStr("24:00"), false, "每日定时与开始时间不得接受 24:00");
          assert.strictEqual(schedulerMod.parseEndTimeToMinutes("24:00"), 1440);
          assert.strictEqual(schedulerMod.parseTimeToMinutes("24:00"), null);

          // 2) normalizeSettings：保留 endTime="24:00"，拒绝 startTime/time="24:00" 与 endTime="24:30"
          const normFullDay = normalizeSettings({
            enabled: true,
            mode: "interval",
            startTime: "00:00",
            endTime: "24:00",
            intervalHours: 2,
          });
          assert.strictEqual(normFullDay.startTime, "00:00");
          assert.strictEqual(normFullDay.endTime, "24:00");

          const normBadStart = normalizeSettings({
            enabled: true,
            mode: "interval",
            startTime: "24:00",
            endTime: "24:00",
            time: "24:00",
          });
          assert.strictEqual(normBadStart.startTime, DEFAULT_SETTINGS.startTime);
          assert.strictEqual(normBadStart.time, DEFAULT_SETTINGS.time);
          assert.strictEqual(normBadStart.endTime, "24:00");

          const normBadEnd = normalizeSettings({
            enabled: true,
            mode: "interval",
            startTime: "00:00",
            endTime: "24:30",
          });
          assert.strictEqual(normBadEnd.endTime, DEFAULT_SETTINGS.endTime);

          // 3) 00:00–24:00 每 2 小时 → 12 个槽 00:00..22:00，无 24:00/次日00:00 槽
          const slots00_24_2h = buildScheduleSlots("2026-11-20", normFullDay);
          assert.strictEqual(slots00_24_2h.length, 12, "00:00–24:00 每 2 小时应为 12 个槽");
          assert.deepStrictEqual(
            slots00_24_2h.map((s) => s.slot),
            [
              "2026-11-20 00:00",
              "2026-11-20 02:00",
              "2026-11-20 04:00",
              "2026-11-20 06:00",
              "2026-11-20 08:00",
              "2026-11-20 10:00",
              "2026-11-20 12:00",
              "2026-11-20 14:00",
              "2026-11-20 16:00",
              "2026-11-20 18:00",
              "2026-11-20 20:00",
              "2026-11-20 22:00",
            ]
          );
          assert.strictEqual(
            slots00_24_2h[11].endMs,
            cnTime(2026, 11, 21, 0, 0, 0),
            "22:00 末槽应截止到次日 00:00:00（不顺延 5 分钟避免与次日 00:00 冲突）"
          );
          // 跨天无缝衔接
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 23, 59, 59), normFullDay).slot, "2026-11-20 22:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 0, 0, 0), normFullDay).slot, "2026-11-21 00:00");

          // 4) 08:00–24:00 每 2 小时 → 8 个槽 08:00..22:00；次日 00:00 归 null
          const cfg08_24 = { enabled: true, mode: "interval", startTime: "08:00", endTime: "24:00", intervalHours: 2 };
          const slots08_24 = buildScheduleSlots("2026-11-20", cfg08_24);
          assert.strictEqual(slots08_24.length, 8, "08:00–24:00 每 2 小时应为 8 个槽");
          assert.deepStrictEqual(
            slots08_24.map((s) => s.time),
            ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00", "20:00", "22:00"]
          );
          assert.strictEqual(slots08_24[7].endMs, cnTime(2026, 11, 21, 0, 0, 0));
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 20, 23, 59, 0), cfg08_24).slot, "2026-11-20 22:00");
          assert.strictEqual(getCurrentSlot(cnTime(2026, 11, 21, 0, 0, 0), cfg08_24), null);

          // 5) 非整除起点（09:00–24:00/2h=8 槽，23:30–24:00/2h=1 槽）及其他步长（1/3/4/6h）
          const slots09_24 = buildScheduleSlots("2026-11-20", {
            enabled: true,
            mode: "interval",
            startTime: "09:00",
            endTime: "24:00",
            intervalHours: 2,
          });
          assert.deepStrictEqual(
            slots09_24.map((s) => s.time),
            ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00", "23:00"]
          );
          assert.strictEqual(slots09_24[7].endMs, cnTime(2026, 11, 21, 0, 0, 0));
          const slots2330_24 = buildScheduleSlots("2026-11-20", {
            enabled: true,
            mode: "interval",
            startTime: "23:30",
            endTime: "24:00",
            intervalHours: 2,
          });
          assert.deepStrictEqual(slots2330_24.map((s) => s.slot), ["2026-11-20 23:30"]);
          assert.strictEqual(slots2330_24[0].endMs, cnTime(2026, 11, 21, 0, 0, 0));
          assert.strictEqual(buildScheduleSlots("2026-11-20", { ...normFullDay, intervalHours: 1 }).length, 24);
          assert.strictEqual(buildScheduleSlots("2026-11-20", { ...normFullDay, intervalHours: 3 }).length, 8);
          assert.strictEqual(buildScheduleSlots("2026-11-20", { ...normFullDay, intervalHours: 4 }).length, 6);
          assert.strictEqual(buildScheduleSlots("2026-11-20", { ...normFullDay, intervalHours: 6 }).length, 4);

          // 6) 旧配置（开始=结束、endTime 落槽、跨零点）完全不变
          const slotsSame = buildScheduleSlots("2026-11-20", {
            enabled: true,
            mode: "interval",
            startTime: "08:00",
            endTime: "08:00",
            intervalHours: 2,
          });
          assert.strictEqual(slotsSame.length, 1);
          assert.strictEqual(slotsSame[0].slot, "2026-11-20 08:00");
          assert.strictEqual(slotsSame[0].endMs, cnTime(2026, 11, 20, 8, 5, 0));

          const slotsOld22 = buildScheduleSlots("2026-11-20", {
            enabled: true,
            mode: "interval",
            startTime: "08:00",
            endTime: "22:00",
            intervalHours: 2,
          });
          assert.strictEqual(slotsOld22.length, 8);
          assert.strictEqual(slotsOld22[7].slot, "2026-11-20 22:00");
          assert.strictEqual(slotsOld22[7].endMs, cnTime(2026, 11, 20, 22, 5, 0));

          // 7) 主进程 store.writeAutoSettings / stats:save-auto-settings / stats:auto-run 均接受 endTime="24:00"
          const s13Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s13-24h-"));
          const origGetPath = require.cache[electronId].exports.app.getPath;
          const origHandle = require.cache[electronId].exports.ipcMain.handle;
          const origInvoke = require.cache[electronId].exports.ipcRenderer.invoke;
          const localHandlers = new Map();
          const sentS13Payloads = [];
          try {
            require.cache[electronId].exports.app.getPath = () => s13Root;
            require.cache[electronId].exports.ipcMain.handle = (ch, fn) => localHandlers.set(ch, fn);
            require.cache[electronId].exports.ipcRenderer.invoke = async (ch, payload) => {
              sentS13Payloads.push({ ch, payload });
              const fn = localHandlers.get(ch);
              return fn
                ? fn({ sender: { send: () => {} }, senderFrame: { url: "file:///app/index.html" } }, payload)
                : null;
            };
            delete require.cache[storeId];
            delete require.cache[indexId];
            const storeS13 = require(storeId);
            require(indexId).registerDataStatsIpc();

            const saveRes = await withMockDateNow(
              () => cnTime(2026, 11, 20, 8, 0, 0),
              () =>
                localHandlers.get("stats:save-auto-settings")(
                  { senderFrame: { url: "file:///app/index.html" } },
                  { enabled: true, mode: "interval", startTime: "00:00", endTime: "24:00", intervalHours: 2 }
                )
            );
            assert.strictEqual(saveRes.ok, true);
            assert.strictEqual(saveRes.settings.endTime, "24:00");
            assert.strictEqual(storeS13.readAutoSettings().endTime, "24:00");

            // startTime / time 传 24:00 仍被拒绝回落默认
            const badMain = storeS13.writeAutoSettings(
              {
                mode: "interval",
                startTime: "24:00",
                endTime: "24:00",
                time: "24:00",
              },
              cnTime(2026, 11, 20, 8, 1, 0)
            );
            assert.strictEqual(badMain.startTime, "08:00");
            assert.strictEqual(badMain.time, "10:00");
            assert.strictEqual(badMain.endTime, "24:00");

            // 调度器 defaultAutoRun 携带 endTime="24:00" 且主进程 stats:auto-run 正常接纳并同步配置
            // 先把主进程设置切回 00:00-24:00（生效边界 08:02 早于 22:00 槽），验证 22:00 槽正常执行
            storeS13.writeAutoSettings(
              { enabled: true, mode: "interval", startTime: "00:00", endTime: "24:00", intervalHours: 2 },
              cnTime(2026, 11, 20, 8, 2, 0)
            );
            const s13Storage = createMemoryStorage();
            saveSettings(
              { enabled: true, mode: "interval", startTime: "00:00", endTime: "24:00", intervalHours: 2 },
              s13Storage
            );
            const acc24 = { group: "G24", platform: "抖音", partition: "persist:g24-dy" };
            await withImmediateTimers(async () => {
              await withMockDateNow(
                () => cnTime(2026, 11, 20, 22, 10, 0),
                async () => {
                  const s24 = createStatsScheduler({
                    storage: s13Storage,
                    now: () => cnTime(2026, 11, 20, 22, 10, 0),
                    monotonicNow: () => STARTUP_DELAY_MS,
                    startupDelayMs: 0,
                    getAccounts: () => [acc24],
                    setIntervalFn: () => 1,
                    clearIntervalFn: () => {},
                  });
                  s24.start();
                  const tickRes = await s24.tick();
                  s24.stop();
                  assert.strictEqual(tickRes.ran, true);
                  assert.strictEqual(tickRes.slot, "2026-11-20 22:00");
                  const autoCall = sentS13Payloads.find((x) => x.ch === "stats:auto-run");
                  assert.ok(autoCall && autoCall.payload.endTime === "24:00", "defaultAutoRun 必须携带 endTime='24:00'");
                  assert.strictEqual(storeS13.readAutoSettings().startTime, "00:00");
                  assert.strictEqual(storeS13.readAutoSettings().endTime, "24:00");
                }
              );
            });
          } finally {
            require.cache[electronId].exports.app.getPath = origGetPath;
            require.cache[electronId].exports.ipcMain.handle = origHandle;
            require.cache[electronId].exports.ipcRenderer.invoke = origInvoke;
            fs.rmSync(s13Root, { recursive: true, force: true });
          }
          console.log("✓ [S13] 全天 00:00–24:00 槽生成、排他末端、旧配置兼容与主进程持久化/IPC 全通过");
        }
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
