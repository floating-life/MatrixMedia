/**
 * 每日定时自动采集调度器与主进程权威认领单元测试（不依赖 Electron 运行环境）：
 * 1. 纯函数 shouldRun：未到点/到点/快速跳过/跨天/补跑/关闭/坏设置/边界时间，且已移除依赖 Date 的启动闸门
 * 2. 配置归一化与保存失败反馈（saveSettings/updateSettings 返回 { ok, settings, error }，失败不广播供 UI 回滚）
 * 3. 单调时钟启动延迟（performance.now）：系统时间大幅回拨不卡死、前拨不提前跑
 * 4. isMainWindowLocation 主窗口判定（主页面放行，登录窗/加载窗/子窗口/外部页拦截）
 * 5. buildCollectAccounts 区分解析失败（null）与空列表（[]），调度器遇 null 不认领、空数组仍走 auto-claim
 * 6. 调度器全流程：通知（含 skipped）、异常不释放认领、认领 busy 与采集 busy（触发 auto-release）重试上限、并发防重入、改设置即时生效
 * 7. 主进程权威认领 + store.js 真实落盘 + match-works 互斥 + auto 跳过今日已成功账号：
 *    - stats:auto-claim 忽略渲染层传值（UTC+8）、同日二次认领拒绝、双窗口并发仅跑一次、只读 localStorage + 重挂载不重跑
 *    - collecting 中（stats:collect / stats:match-works）认领返回 busy 且不写入
 *    - stats:auto-release 释放后可再认领
 *    - 系统校时回拨到已跑日期拒绝
 *    - auto-run.json 只保留最近 14 个日期（含回拨新日期不自逐）
 *    - 原子写失败（ENOSPC）返回 store-failed、旧文件完整、无 .tmp 残留、不触发采集
 *    - stats:match-works 与 stats:collect 双向互斥 & finally 复位
 *    - stats:collect(trigger:"auto") 跳过今日（UTC+8）lastError 为空的账号（skipped:true，不打开窗口），manual 不跳过
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
  MAX_BUSY_RETRIES,
  BUSY_ERROR_TEXT,
  formatLocalDate,
  normalizeSettings,
  isMainWindowLocation,
  shouldRun,
  isBusyError,
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
    dump() {
      return Object.fromEntries(map.entries());
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

/** 构造内存态假主进程认领器（供渲染层纯调度单测使用） */
function createFakeClaimer(getNow) {
  const runs = new Set();
  return {
    runs,
    autoClaim: async () => {
      const date = formatLocalDate(getNow());
      if (runs.has(date)) return { ok: false, reason: "already-ran" };
      runs.add(date);
      return { ok: true, date };
    },
    autoRelease: async (date) => {
      const existed = runs.delete(date);
      return { ok: true, released: existed };
    },
  };
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

async function main() {
  /* ---------- 1. shouldRun 纯函数（不含依赖 Date 的启动闸门） ---------- */
  {
    // 未到点不跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 9, 59, 59),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
      }),
      false,
      "未到设定时间（09:59:59 < 10:00）不应运行"
    );

    // 到点跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
      }),
      true,
      "刚好到点（10:00:00）应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 30),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
      }),
      true,
      "到点后同分钟内应运行"
    );

    // 当天已跑快速跳过
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
      }),
      false,
      "当天已跑过应快速跳过"
    );

    // 跨天：未到点不跑，到点再跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 9, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
      }),
      false,
      "跨天后未到点不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 10, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
      }),
      true,
      "跨天到点应再次运行"
    );

    // 错过补跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 15, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-18" },
      }),
      true,
      "错过设定时间且当天未跑时应补跑"
    );

    // shouldRun 已删除依赖 Date 的启动闸门：即使调用方传未来 startedAt 也不会阻塞
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 15, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: localTime(2026, 11, 25, 15, 0, 0).getTime(),
      }),
      true,
      "shouldRun 不应再含依赖 Date 的启动闸门"
    );

    // 关闭不跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 12, 0, 0),
        settings: { enabled: false, time: "10:00", lastRunDate: "" },
      }),
      false,
      "enabled=false 时不应运行"
    );

    // 坏设置回落默认
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 9, 59, 0),
        settings: null,
      }),
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
        settings: { enabled: true, time: "00:00", lastRunDate: "2026-11-19" },
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

    // 非法时间戳
    assert.strictEqual(shouldRun({ now: NaN, settings: DEFAULT_SETTINGS }), false);
    console.log("✓ shouldRun 纯函数判定（无 Date 启动闸门 / 未到点 / 到点 / 跨天 / 补跑 / 关闭 / 坏设置）");
  }

  /* ---------- 2. 配置归一化、读写容错与保存失败反馈 ---------- */
  {
    assert.deepStrictEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings([]), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings("bad"), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings(123), DEFAULT_SETTINGS);

    assert.deepStrictEqual(
      normalizeSettings({
        enabled: false,
        time: "25:00",
        lastRunDate: "2026-11-18",
      }),
      { enabled: false, time: "10:00", lastRunDate: "2026-11-18" }
    );
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: "false",
        time: "10:60",
        lastRunDate: "2026-02-30",
      }),
      { enabled: true, time: "10:00", lastRunDate: "" }
    );
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: true,
        time: "08:30",
        lastRunDate: "2024-02-29",
      }),
      { enabled: true, time: "08:30", lastRunDate: "2024-02-29" }
    );

    for (const badRaw of ["", "{broken", "null", "[]", "123", '"hello"', "true"]) {
      const storage = createMemoryStorage({ [STORAGE_KEY]: badRaw });
      assert.deepStrictEqual(loadSettings(storage), DEFAULT_SETTINGS);
    }

    // 写入失败：返回 { ok: false, settings: 旧有效配置, error }，不广播
    const origGlobalLS = global.localStorage;
    const broadcasted = [];
    const unsub = subscribeSettings((s) => broadcasted.push(s));
    try {
      const storedRaw = JSON.stringify({
        enabled: true,
        time: "10:00",
        lastRunDate: "2026-11-18",
      });
      const failingStorage = {
        getItem: () => storedRaw,
        setItem() {
          throw new Error("QuotaExceededError");
        },
      };
      global.localStorage = failingStorage;

      const saveFail = saveSettings({ enabled: false, time: "11:30" });
      assert.strictEqual(saveFail.ok, false, "setItem 抛错必须返回 ok:false");
      assert.ok(saveFail.error.includes("QuotaExceededError"));
      assert.deepStrictEqual(
        saveFail.settings,
        { enabled: true, time: "10:00", lastRunDate: "2026-11-18" },
        "保存失败应返回当前实际生效的旧配置供开关 UI 回滚"
      );
      assert.strictEqual(broadcasted.length, 0, "保存失败不得广播假状态");

      const updateFail = updateSettings({ enabled: false });
      assert.strictEqual(updateFail.ok, false);
      assert.strictEqual(updateFail.settings.enabled, true);
      assert.strictEqual(broadcasted.length, 0);

      // 无 storage 时同样返回 ok:false
      const noStorageRes = saveSettings({ enabled: false }, null);
      assert.strictEqual(noStorageRes.ok, false);
      assert.deepStrictEqual(noStorageRes.settings, DEFAULT_SETTINGS);
    } finally {
      unsub();
      if (origGlobalLS === undefined) delete global.localStorage;
      else global.localStorage = origGlobalLS;
    }

    // 正常写入与局部更新
    const storage = createMemoryStorage();
    const saved = saveSettings(
      { enabled: true, time: "10:00", lastRunDate: "2026-11-18" },
      storage
    );
    assert.strictEqual(saved.ok, true);
    const updated = updateSettings({ time: "14:30", lastRunDate: undefined }, storage);
    assert.strictEqual(updated.ok, true);
    assert.deepStrictEqual(updated.settings, {
      enabled: true,
      time: "14:30",
      lastRunDate: "2026-11-18",
    });
    assert.deepStrictEqual(loadSettings(storage), updated.settings);
    console.log("✓ 配置归一化、读写容错与保存失败回滚结果正确");
  }

  /* ---------- 3. 单调时钟启动延迟（不受系统时间回拨/前拨影响） ---------- */
  {
    // 启动时系统时钟错误超前 6 天（2026-11-25 10:00），随后校时回拨到 2026-11-19 10:05
    let wallNow = localTime(2026, 11, 25, 10, 0, 0).getTime();
    let monoNow = 1000;
    const storage = createMemoryStorage();
    const claimer = createFakeClaimer(() => wallNow);
    let collectCalls = 0;

    const sMono = createStatsScheduler({
      storage,
      now: () => wallNow,
      monotonicNow: () => monoNow,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      autoClaim: claimer.autoClaim,
      autoRelease: claimer.autoRelease,
      collect: async () => {
        collectCalls++;
        return { cancelled: false, results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });

    sMono.start();

    // 即使挂钟往前跳 10 分钟，单调时钟只过了 60s（< 120s），仍必须等待
    wallNow = localTime(2026, 11, 25, 10, 10, 0).getTime();
    monoNow += 60 * 1000;
    assert.deepStrictEqual(await sMono.tick(), { ran: false, reason: "startup-delay" });
    assert.strictEqual(collectCalls, 0);

    // 挂钟大幅回拨 6 天到 2026-11-19 10:05，但单调时钟已满 2 分钟 → 立刻放行
    wallNow = localTime(2026, 11, 19, 10, 5, 0).getTime();
    monoNow += 60 * 1000;
    const out = await sMono.tick();
    assert.strictEqual(out.ran, true, "系统校时回拨后单调时钟满 2 分钟应正常触发");
    assert.strictEqual(collectCalls, 1);
    sMono.stop();
    console.log("✓ 单调时钟启动延迟（挂钟前拨不提前、挂钟回拨 6 天不卡死）");
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
      assert.strictEqual(
        isMainWindowLocation(loc),
        true,
        `主窗口 URL 应放行: ${JSON.stringify(loc)}`
      );
    }

    const nonMainCases = [
      null,
      { protocol: "file:", hostname: "", pathname: "/app/static/loader.html", hash: "" },
      { protocol: "http:", hostname: "localhost", pathname: "/static/loader.html", hash: "" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/login" },
      { protocol: "http:", hostname: "localhost", pathname: "/", hash: "#/print" },
      { protocol: "file:", hostname: "", pathname: "/app/index.html", hash: "#/child" },
      { protocol: "https:", hostname: "creator.douyin.com", pathname: "/creator-micro/home", hash: "" },
      { protocol: "about:", hostname: "", pathname: "blank", hash: "" },
    ];
    for (const loc of nonMainCases) {
      assert.strictEqual(
        isMainWindowLocation(loc),
        false,
        `非主窗口 URL 应拒绝: ${JSON.stringify(loc)}`
      );
    }
    console.log("✓ isMainWindowLocation 主窗口与登录/子窗口区分正确");
  }

  /* ---------- 5. 调度器主流程、失败不释放、busy 重试与 autoRelease ---------- */
  {
    // 5a. 主流程：延迟 → 认领 → 采集 → 通知 → 同天不再跑 → 跨天再跑 → stop 清理
    let currentTime = localTime(2026, 11, 19, 9, 59, 0).getTime();
    let mono = 0;
    const storage = createMemoryStorage();
    const claimer = createFakeClaimer(() => currentTime);
    const calls = [];
    const notifications = [];
    let intervalId = 0;
    const clearedIds = [];
    let claimedBeforeCollect = false;

    const accounts = [
      { group: "G1", platform: "抖音", partition: "persist:G1-抖音" },
      { group: "G1", platform: "快手", partition: "persist:G1-快手" },
    ];

    const scheduler = createStatsScheduler({
      storage,
      now: () => currentTime,
      monotonicNow: () => mono,
      getAccounts: () => accounts,
      autoClaim: claimer.autoClaim,
      autoRelease: claimer.autoRelease,
      collect: async (accs) => {
        claimedBeforeCollect = claimer.runs.has("2026-11-19");
        calls.push({ at: formatLocalDate(currentTime), count: accs.length });
        return {
          cancelled: false,
          results: [
            { group: "G1", platform: "抖音", success: true, workCount: 10 },
            { group: "G1", platform: "快手", success: false, error: "未登录" },
          ],
        };
      },
      notify: (payload) => notifications.push(payload),
      setIntervalFn: () => ++intervalId,
      clearIntervalFn: (id) => clearedIds.push(id),
    });

    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "stopped" });
    scheduler.start();
    assert.strictEqual(intervalId, 1);

    currentTime = localTime(2026, 11, 19, 10, 0, 0).getTime();
    mono += 60 * 1000;
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "startup-delay" });

    currentTime = localTime(2026, 11, 19, 10, 1, 0).getTime();
    mono += 60 * 1000;
    const r1 = await scheduler.tick();
    assert.strictEqual(r1.ran, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(claimedBeforeCollect, true, "采集前必须已完成主进程认领");
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-19");
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].type, "warning");
    assert.ok(notifications[0].message.includes("成功 1 / 失败 1"));

    // 同天再 tick 不跑
    currentTime = localTime(2026, 11, 19, 10, 2, 0).getTime();
    mono += 60 * 1000;
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "not-due" });

    // 跨天未到点不跑，到点再跑
    currentTime = localTime(2026, 11, 20, 9, 59, 0).getTime();
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "not-due" });
    currentTime = localTime(2026, 11, 20, 10, 0, 0).getTime();
    const r2 = await scheduler.tick();
    assert.strictEqual(r2.ran, true);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-20");

    scheduler.stop();
    assert.deepStrictEqual(clearedIds, [1]);
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "stopped" });

    // 5b. collect 抛异常：不释放认领，不重炸平台
    let tErr = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const errClaimer = createFakeClaimer(() => tErr);
    let errCollectCount = 0;
    let errReleaseCount = 0;
    const errNotifies = [];
    const sErr = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => tErr,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => accounts,
      autoClaim: errClaimer.autoClaim,
      autoRelease: async (d) => {
        errReleaseCount++;
        return errClaimer.autoRelease(d);
      },
      collect: async () => {
        errCollectCount++;
        throw new Error("网络断开");
      },
      notify: (p) => errNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sErr.start();
    const outErr = await sErr.tick();
    assert.strictEqual(outErr.ran, true);
    assert.strictEqual(errCollectCount, 1);
    assert.strictEqual(errReleaseCount, 0, "采集抛异常不得释放当日认领");
    assert.strictEqual(errNotifies.length, 1);
    assert.ok(errNotifies[0].message.includes("网络断开"));
    tErr += 60 * 1000;
    await sErr.tick();
    assert.strictEqual(errCollectCount, 1);
    sErr.stop();

    // 5c. 认领后 collect 返回 busy → 调用 autoRelease，最多重试 6 次（共 7 次），跨天清零
    let tBusy = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const busyStorage = createMemoryStorage();
    saveSettings({ enabled: true, time: "10:00", lastRunDate: "2026-11-18" }, busyStorage);
    const busyClaimer = createFakeClaimer(() => tBusy);
    let busyCollectCalls = 0;
    let busyReleaseCalls = 0;
    const busyNotifies = [];
    const sBusy = createStatsScheduler({
      storage: busyStorage,
      now: () => tBusy,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => accounts,
      autoClaim: busyClaimer.autoClaim,
      autoRelease: async (date) => {
        busyReleaseCalls++;
        return busyClaimer.autoRelease(date);
      },
      collect: async () => {
        busyCollectCalls++;
        if (busyCollectCalls === 2) {
          updateSettings({ time: "09:30" }, busyStorage);
        }
        return { results: [], error: BUSY_ERROR_TEXT };
      },
      notify: (p) => busyNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sBusy.start();

    for (let i = 1; i <= 10; i++) {
      const out = await sBusy.tick();
      if (i <= MAX_BUSY_RETRIES + 1) {
        assert.strictEqual(out.busy, true);
        assert.strictEqual(out.retryCount, i);
        assert.strictEqual(out.exhausted, i > MAX_BUSY_RETRIES);
        assert.strictEqual(busyClaimer.runs.has("2026-11-19"), false, "每次 busy 后必须释放认领");
        assert.strictEqual(loadSettings(busyStorage).lastRunDate, "2026-11-18");
      } else {
        assert.deepStrictEqual(out, { ran: false, reason: "not-due" });
      }
      tBusy += 60 * 1000;
    }
    assert.strictEqual(busyCollectCalls, MAX_BUSY_RETRIES + 1);
    assert.strictEqual(busyReleaseCalls, MAX_BUSY_RETRIES + 1);
    assert.strictEqual(busyNotifies.length, 0);
    assert.strictEqual(loadSettings(busyStorage).time, "09:30");

    // 跨天重试计数清零
    tBusy = localTime(2026, 11, 20, 9, 30, 0).getTime();
    const nextDayBusy = await sBusy.tick();
    assert.strictEqual(nextDayBusy.busy, true);
    assert.strictEqual(nextDayBusy.retryCount, 1);
    sBusy.stop();

    // 5d. autoClaim 直接返回 busy → 不调 autoRelease、不调 collect，中途恢复后成功
    let tClaimBusy = localTime(2026, 11, 19, 10, 0, 0).getTime();
    let claimAttempts = 0;
    let releaseOnClaimBusy = 0;
    let collectAfterBusy = 0;
    const sClaimBusy = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => tClaimBusy,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => accounts,
      autoClaim: async () => {
        claimAttempts++;
        if (claimAttempts <= 2) return { ok: false, reason: "busy" };
        return { ok: true, date: "2026-11-19" };
      },
      autoRelease: async () => {
        releaseOnClaimBusy++;
        return { ok: true, released: true };
      },
      collect: async () => {
        collectAfterBusy++;
        return { cancelled: false, results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sClaimBusy.start();
    assert.strictEqual((await sClaimBusy.tick()).busy, true);
    tClaimBusy += 60 * 1000;
    assert.strictEqual((await sClaimBusy.tick()).busy, true);
    assert.strictEqual(releaseOnClaimBusy, 0, "autoClaim 返回 busy 时从未认领，不得调 autoRelease");
    assert.strictEqual(collectAfterBusy, 0);
    tClaimBusy += 60 * 1000;
    assert.strictEqual((await sClaimBusy.tick()).ran, true);
    assert.strictEqual(collectAfterBusy, 1);
    sClaimBusy.stop();

    // 5e. 并发防重入 + stop 后静默 + 改设置即时生效 + buildNotifyPayload(含 skipped)
    let tConc = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const pending = createDeferred();
    let concCalls = 0;
    const concNotifies = [];
    const sConc = createStatsScheduler({
      storage: createMemoryStorage(),
      now: () => tConc,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => accounts,
      autoClaim: async () => ({ ok: true, date: "2026-11-19" }),
      collect: () => {
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
    pending.resolve({ cancelled: false, results: [{ success: true }] });
    await p1;
    assert.strictEqual(concNotifies.length, 0);

    // 改设置即时生效
    let tLive = localTime(2026, 11, 19, 11, 0, 0).getTime();
    const liveStorage = createMemoryStorage();
    saveSettings({ enabled: false, time: "18:00", lastRunDate: "" }, liveStorage);
    let liveCalls = 0;
    const sLive = createStatsScheduler({
      storage: liveStorage,
      now: () => tLive,
      monotonicNow: () => STARTUP_DELAY_MS,
      startupDelayMs: 0,
      getAccounts: () => accounts,
      autoClaim: async () => ({ ok: true, date: "2026-11-19" }),
      collect: async () => {
        liveCalls++;
        return { cancelled: false, results: [{ success: true }] };
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

    // buildNotifyPayload（含 skipped 账号）与 isBusyError
    assert.strictEqual(isBusyError({ error: "已有采集任务进行中" }), true);
    assert.strictEqual(isBusyError({ error: "没有可采集的账号" }), false);
    assert.strictEqual(isBusyError(null), false);
    const skipOnlyNotify = buildNotifyPayload({
      cancelled: false,
      results: [{ group: "G1", platform: "抖音", success: true, skipped: true }],
    });
    assert.strictEqual(skipOnlyNotify.type, "info");
    assert.ok(skipOnlyNotify.message.includes("跳过 1"));
    const mixNotify = buildNotifyPayload({
      cancelled: false,
      results: [
        { group: "G1", platform: "抖音", success: true, skipped: true },
        { group: "G1", platform: "快手", success: true },
      ],
    });
    assert.strictEqual(mixNotify.type, "success");
    assert.ok(mixNotify.message.includes("成功 1 / 跳过 1 / 失败 0"));
    assert.strictEqual(
      buildNotifyPayload({ cancelled: true, results: [{ success: true }] }).type,
      "info"
    );
    assert.strictEqual(
      buildNotifyPayload({ results: [], error: "服务异常" }).title,
      "每日自动采集失败"
    );
    console.log("✓ 调度器主流程、异常不释放、busy 重试上限、防重入与 skipped 通知正确");
  }

  /* ---------- 6. 主进程权威认领 + store 真实落盘 + match-works 互斥 + auto 跳过今日已成功 + accountTree 损坏 ---------- */
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
    const invokeCalls = [];
    const collectedBatches = [];
    let collectorImpl = async ({ partition, platform }) => ({
      overview: { plays: 10 },
      fansHistory: [],
      works: [{ workId: `${partition}-w1`, title: `标题-${platform}`, url: "https://example.com/1" }],
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
            invokeCalls.push({ channel, payload });
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

      const claimHandler = ipcHandlers.get("stats:auto-claim");
      const releaseHandler = ipcHandlers.get("stats:auto-release");
      const collectHandler = ipcHandlers.get("stats:collect");
      const matchHandler = ipcHandlers.get("stats:match-works");
      assert.strictEqual(typeof claimHandler, "function");
      assert.strictEqual(typeof releaseHandler, "function");
      assert.strictEqual(typeof collectHandler, "function");
      assert.strictEqual(typeof matchHandler, "function");

      const fakeEvent = { sender: { send: () => {} } };
      const autoRunFile = path.join(tmpRoot, "data-stats", "auto-run.json");

      /* ---- 6a. buildCollectAccounts 解析失败返回 null vs 空数组 [] + 调度器遇损坏不认领 ---- */
      {
        const lsMap = new Map();
        global.localStorage = {
          getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
          setItem: (k, v) => lsMap.set(k, String(v)),
          removeItem: (k) => lsMap.delete(k),
        };

        // 未初始化 / 空对象 → []
        assert.deepStrictEqual(buildCollectAccounts(), []);
        lsMap.set("accountTree", "{}");
        assert.deepStrictEqual(buildCollectAccounts(), []);

        // 损坏 JSON / 非对象 JSON → null
        for (const bad of ["{broken", "null", "[]", "123", '"oops"']) {
          lsMap.set("accountTree", bad);
          assert.strictEqual(
            buildCollectAccounts(),
            null,
            `损坏 accountTree(${bad}) 应返回 null`
          );
        }

        // localStorage.getItem 抛错 → null
        global.localStorage = {
          getItem() {
            throw new Error("SecurityError");
          },
          setItem() {},
        };
        assert.strictEqual(buildCollectAccounts(), null);

        // 调度器遇到损坏 accountTree：不调用 auto-claim、不写入 auto-run.json、继续轮询；修复后正常认领
        global.localStorage = {
          getItem: (k) => (lsMap.has(k) ? lsMap.get(k) : null),
          setItem: (k, v) => lsMap.set(k, String(v)),
          removeItem: (k) => lsMap.delete(k),
        };
        lsMap.set("accountTree", "{broken");

        let mockNow = cnTime(2026, 11, 19, 10, 0, 0);
        await withMockDateNow(
          () => mockNow,
          async () => {
            const sched = createStatsScheduler({
              storage: createMemoryStorage(),
              now: () => localTime(2026, 11, 19, 10, 0, 0).getTime(),
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              setIntervalFn: () => 1,
              clearIntervalFn: () => {},
            });
            sched.start();
            const brokenOut = await sched.tick();
            assert.deepStrictEqual(brokenOut, {
              ran: false,
              reason: "accounts-unavailable",
            });
            assert.strictEqual(
              fs.existsSync(autoRunFile),
              false,
              "accountTree 损坏时绝不得向主进程认领"
            );

            // 修复为空账号树 {} → 确认为空数组，此时走 auto-claim 记录当天已跑，但不调 collect
            lsMap.set("accountTree", "{}");
            const beforeCollectLen = collectedBatches.length;
            const emptyOut = await sched.tick();
            assert.strictEqual(emptyOut.ran, true);
            assert.strictEqual(emptyOut.skippedEmpty, true);
            assert.strictEqual(emptyOut.date, "2026-11-19");
            assert.strictEqual(collectedBatches.length, beforeCollectLen);
            assert.deepStrictEqual(
              JSON.parse(fs.readFileSync(autoRunFile, "utf8")).runs,
              ["2026-11-19"],
              "确认空账号时仍须调用 auto-claim 落盘记录当日已跑"
            );
            sched.stop();
          }
        );

        // 释放 2026-11-19 以便后续用例从干净状态开始
        const relClean = await releaseHandler(fakeEvent, { date: "2026-11-19" });
        assert.deepStrictEqual(relClean, { ok: true, released: true });
        console.log("✓ buildCollectAccounts 区分 null/[]，损坏不认领，空数组走 auto-claim");
      }

      /* ---- 6b. 主进程每日认领：忽略渲染层传值、同日二次拒绝、release 后可再认领、回拨拒绝、14 天上限 ---- */
      {
        let mockNow = cnTime(2026, 11, 19, 10, 0, 0);
        await withMockDateNow(
          () => mockNow,
          async () => {
            // 传入伪造日期 2020-01-01，主进程必须忽略并用 store.todayStr()（2026-11-19）
            const c1 = await claimHandler(fakeEvent, { date: "2020-01-01" });
            assert.deepStrictEqual(c1, { ok: true, date: "2026-11-19" });
            assert.deepStrictEqual(store.readAutoRuns(), ["2026-11-19"]);

            // 同日二次认领拒绝
            const c2 = await claimHandler(fakeEvent, { date: "2026-11-19" });
            assert.deepStrictEqual(c2, { ok: false, reason: "already-ran" });

            // 非法日期 release 返回 invalid-date；未存在日期返回 released:false
            assert.deepStrictEqual(await releaseHandler(fakeEvent, { date: "bad" }), {
              ok: false,
              reason: "invalid-date",
            });
            assert.deepStrictEqual(
              await releaseHandler(fakeEvent, { date: "2026-11-18" }),
              { ok: true, released: false }
            );

            // release 后可再认领
            assert.deepStrictEqual(
              await releaseHandler(fakeEvent, { date: "2026-11-19" }),
              { ok: true, released: true }
            );
            assert.deepStrictEqual(store.readAutoRuns(), []);
            const c3 = await claimHandler(fakeEvent, {});
            assert.deepStrictEqual(c3, { ok: true, date: "2026-11-19" });

            // 次日（2026-11-20）认领成功
            mockNow = cnTime(2026, 11, 20, 10, 0, 0);
            assert.deepStrictEqual(await claimHandler(fakeEvent, {}), {
              ok: true,
              date: "2026-11-20",
            });

            // 系统校时回拨到已跑过的 2026-11-19 → 拒绝（already-ran）
            mockNow = cnTime(2026, 11, 19, 15, 0, 0);
            assert.deepStrictEqual(await claimHandler(fakeEvent, {}), {
              ok: false,
              reason: "already-ran",
            });

            // 连续认领 16 天 → auto-run.json 只保留最近 14 个日期
            for (let day = 1; day <= 16; day++) {
              mockNow = cnTime(2026, 12, day, 10, 0, 0);
              const res = await claimHandler(fakeEvent, {});
              assert.strictEqual(res.ok, true, `12-${day} 应认领成功`);
            }
            const runsAfter16 = store.readAutoRuns();
            assert.strictEqual(runsAfter16.length, 14, "runs 必须只保留 14 个日期");
            assert.strictEqual(runsAfter16[0], "2026-12-03");
            assert.strictEqual(runsAfter16[13], "2026-12-16");

            // 回拨到未跑过的早先日期（2026-11-10）：认领后必须留存在 runs 末尾，二次认领被拒（防死循环）
            mockNow = cnTime(2026, 11, 10, 10, 0, 0);
            assert.deepStrictEqual(await claimHandler(fakeEvent, {}), {
              ok: true,
              date: "2026-11-10",
            });
            assert.strictEqual(store.readAutoRuns().length, 14);
            assert.strictEqual(store.readAutoRuns().includes("2026-11-10"), true);
            assert.deepStrictEqual(await claimHandler(fakeEvent, {}), {
              ok: false,
              reason: "already-ran",
            });
          }
        );
        console.log("✓ 主进程 auto-claim/auto-release（UTC+8/二次拒绝/释放重领/回拨拒绝/14天上限）");
      }

      /* ---- 6c. 双窗口并发 + localStorage 只读/重挂载 → 仅跑一次；原子写失败不采集 ---- */
      {
        const testDay = cnTime(2026, 11, 25, 10, 0, 0);
        const sampleAcc = [
          { group: "MultiG", platform: "抖音", partition: "persist:MultiG-抖音" },
        ];
        await withMockDateNow(
          () => testDay,
          async () => {
            const startLen = collectedBatches.length;
            // 模拟两个窗口各自独立的空 localStorage 同时 tick
            const winA = createStatsScheduler({
              storage: createMemoryStorage(),
              now: () => localTime(2026, 11, 25, 10, 0, 0).getTime(),
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              getAccounts: () => sampleAcc,
              setIntervalFn: () => 1,
              clearIntervalFn: () => {},
            });
            const winB = createStatsScheduler({
              storage: createMemoryStorage(),
              now: () => localTime(2026, 11, 25, 10, 0, 0).getTime(),
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              getAccounts: () => sampleAcc,
              setIntervalFn: () => 2,
              clearIntervalFn: () => {},
            });
            winA.start();
            winB.start();
            const [resA, resB] = await Promise.all([winA.tick(), winB.tick()]);
            const ranCount = [resA, resB].filter((r) => r.ran).length;
            assert.strictEqual(ranCount, 1, "双窗口同时触发时仅允许一个窗口执行采集");
            assert.strictEqual(
              [resA, resB].some((r) => r.reason === "already-ran"),
              true,
              "第二个窗口应收到 already-ran，绝不覆盖或释放第一个窗口的认领"
            );
            assert.strictEqual(
              collectedBatches.length - startLen,
              1,
              "真实采集函数只能被调用一次"
            );
            winA.stop();
            winB.stop();

            // localStorage 只读且重新创建调度器（模拟重挂载），主进程 auto-run.json 仍挡住二次采集
            const roStorage = {
              getItem: () => null,
              setItem: () => {
                throw new Error("QuotaExceededError");
              },
            };
            const remounted = createStatsScheduler({
              storage: roStorage,
              now: () => localTime(2026, 11, 25, 10, 5, 0).getTime(),
              monotonicNow: () => STARTUP_DELAY_MS,
              startupDelayMs: 0,
              getAccounts: () => sampleAcc,
              setIntervalFn: () => 3,
              clearIntervalFn: () => {},
            });
            remounted.start();
            assert.deepStrictEqual(await remounted.tick(), {
              ran: false,
              reason: "already-ran",
            });
            assert.strictEqual(collectedBatches.length - startLen, 1);
            remounted.stop();
          }
        );

        // 原子写失败（ENOSPC）→ store-failed、旧文件完整、无 .tmp 残留、调度器不采集
        const failDay = cnTime(2026, 11, 26, 10, 0, 0);
        const beforeBytes = fs.readFileSync(autoRunFile, "utf8");
        const beforeCollectCount = collectedBatches.length;
        const origWriteSync = fs.writeSync;
        const origWarn = console.warn;
        console.warn = () => {};
        fs.writeSync = function patchedWriteSync() {
          const err = new Error("ENOSPC: no space left on device");
          err.code = "ENOSPC";
          throw err;
        };
        try {
          await withMockDateNow(
            () => failDay,
            async () => {
              const sFail = createStatsScheduler({
                storage: createMemoryStorage(),
                now: () => localTime(2026, 11, 26, 10, 0, 0).getTime(),
                monotonicNow: () => STARTUP_DELAY_MS,
                startupDelayMs: 0,
                getAccounts: () => sampleAcc,
                setIntervalFn: () => 1,
                clearIntervalFn: () => {},
              });
              sFail.start();
              const out = await sFail.tick();
              assert.deepStrictEqual(out, { ran: false, reason: "store-failed" });
              assert.strictEqual(
                collectedBatches.length,
                beforeCollectCount,
                "auto-run.json 写失败时绝不得发起采集"
              );
              sFail.stop();
            }
          );
        } finally {
          fs.writeSync = origWriteSync;
          console.warn = origWarn;
        }
        assert.strictEqual(
          fs.readFileSync(autoRunFile, "utf8"),
          beforeBytes,
          "写失败后旧 auto-run.json 必须字节完整"
        );
        const leftovers = fs
          .readdirSync(path.join(tmpRoot, "data-stats"))
          .filter((f) => f.endsWith(".tmp"));
        assert.deepStrictEqual(leftovers, [], "原子写失败后不得遗留 .tmp 临时文件");
        console.log("✓ 双窗口并发仅跑一次、只读存储重挂载防重、ENOSPC 写失败不采集且旧文件完整");
      }

      /* ---- 6d. stats:collect 与 stats:match-works 双向互斥 & collecting 中 auto-claim 返回 busy 不写入 ---- */
      {
        const mutexDay = cnTime(2026, 11, 27, 10, 0, 0);
        const gate1 = createDeferred();
        const origImpl = collectorImpl;
        collectorImpl = async (params) => {
          await gate1.promise;
          return origImpl(params);
        };

        await withMockDateNow(
          () => mutexDay,
          async () => {
            // 1) stats:collect 运行中 → stats:match-works 返回 busy:true；stats:auto-claim 返回 busy 且不写入
            const inFlightCollect = collectHandler(fakeEvent, {
              accounts: [{ group: "MutexG", platform: "抖音", partition: "persist:MutexG-抖音" }],
              trigger: "manual",
            });
            const matchWhileCollecting = await matchHandler(fakeEvent, {
              tasks: [
                {
                  key: "0",
                  group: "MutexG",
                  platform: "抖音",
                  partition: "persist:MutexG-抖音",
                  title: "标题-抖音",
                },
              ],
            });
            assert.deepStrictEqual(matchWhileCollecting, {
              matches: {},
              errors: [{ error: "已有采集任务进行中" }],
              busy: true,
            });

            const claimWhileCollecting = await claimHandler(fakeEvent, {});
            assert.deepStrictEqual(claimWhileCollecting, { ok: false, reason: "busy" });
            assert.strictEqual(
              store.readAutoRuns().includes("2026-11-27"),
              false,
              "collecting 期间 auto-claim 返回 busy 不得写入 auto-run.json"
            );

            gate1.resolve();
            await inFlightCollect;

            // 2) stats:match-works 运行中 → stats:collect 返回忙；stats:auto-claim 返回 busy 且不写入；二次 match-works 返回 busy:true
            const gate2 = createDeferred();
            collectorImpl = async (params) => {
              await gate2.promise;
              return origImpl(params);
            };
            const inFlightMatch = matchHandler(fakeEvent, {
              tasks: [
                {
                  key: "0",
                  group: "MutexG",
                  platform: "快手",
                  partition: "persist:MutexG-快手",
                  title: "标题-快手",
                },
              ],
            });
            const collectWhileMatch = await collectHandler(fakeEvent, {
              accounts: [{ group: "MutexG", platform: "快手", partition: "persist:MutexG-快手" }],
              trigger: "auto",
            });
            assert.deepStrictEqual(collectWhileMatch, {
              results: [],
              error: "已有采集任务进行中",
            });
            const match2WhileMatch = await matchHandler(fakeEvent, { tasks: [] });
            assert.deepStrictEqual(match2WhileMatch, {
              matches: {},
              errors: [{ error: "已有采集任务进行中" }],
              busy: true,
            });
            const claimWhileMatch = await claimHandler(fakeEvent, {});
            assert.deepStrictEqual(claimWhileMatch, { ok: false, reason: "busy" });
            assert.strictEqual(store.readAutoRuns().includes("2026-11-27"), false);

            gate2.resolve();
            const matchDone = await inFlightMatch;
            assert.strictEqual(matchDone.matches["0"].found, true);

            // 3) match-works 完成后 collecting 已复位，后续 auto-claim 可正常成功
            collectorImpl = origImpl;
            assert.deepStrictEqual(await claimHandler(fakeEvent, {}), {
              ok: true,
              date: "2026-11-27",
            });

            // 4) match-works 内部抛错时 finally 同样复位 collecting
            collectorImpl = async () => {
              throw new Error("页面超时");
            };
            const matchErr = await matchHandler(fakeEvent, {
              tasks: [
                {
                  key: "0",
                  group: "MutexG",
                  platform: "B站",
                  partition: "persist:MutexG-B站",
                  title: "x",
                },
              ],
            });
            assert.strictEqual(matchErr.errors.length, 1);
            collectorImpl = origImpl;
            const afterErrCollect = await collectHandler(fakeEvent, {
              accounts: [{ group: "MutexG", platform: "B站", partition: "persist:MutexG-B站" }],
              trigger: "manual",
            });
            assert.strictEqual(afterErrCollect.results.length, 1);
            assert.strictEqual(afterErrCollect.results[0].success, true);
          }
        );
        console.log("✓ stats:match-works 与 stats:collect 双向互斥、busy 不写 auto-run、finally 正确复位");
      }

      /* ---- 6e. trigger==="auto" 跳过今日（UTC+8）已成功采集的账号 + trigger 日志向后兼容 ---- */
      {
        const skipDay = cnTime(2026, 11, 28, 10, 0, 0);
        const yesterday = cnTime(2026, 11, 27, 23, 0, 0);

        // 预设 4 个账号的 meta：
        // A: 今日成功（lastError:""）→ auto 跳过
        // B: 今日失败（lastError:"未登录"）→ auto 不跳过
        // C: 昨日成功（lastError:""）→ auto 不跳过
        // D: 从未采集 → auto 不跳过
        store.writeMeta("SkipG", "抖音", {
          lastCollectAt: cnTime(2026, 11, 28, 9, 30, 0),
          lastError: "",
          workCount: 12,
        });
        store.writeMeta("SkipG", "快手", {
          lastCollectAt: cnTime(2026, 11, 28, 9, 31, 0),
          lastError: "未登录",
          workCount: 0,
        });
        store.writeMeta("SkipG", "视频号", {
          lastCollectAt: yesterday,
          lastError: "",
          workCount: 8,
        });

        const fourAccounts = [
          { group: "SkipG", platform: "抖音", partition: "persist:SkipG-抖音" },
          { group: "SkipG", platform: "快手", partition: "persist:SkipG-快手" },
          { group: "SkipG", platform: "视频号", partition: "persist:SkipG-视频号" },
          { group: "SkipG", platform: "B站", partition: "persist:SkipG-B站" },
        ];

        await withMockDateNow(
          () => skipDay,
          async () => {
            const progressEvents = [];
            const progressEvent = {
              sender: { send: (_ch, payload) => progressEvents.push(payload) },
            };
            const beforeLen = collectedBatches.length;

            // 先用 2000ms 延迟控制：临时替换 setTimeout 以免单测等待 4 秒
            const origSetTimeout = global.setTimeout;
            global.setTimeout = (fn) => {
              fn();
              return 0;
            };
            let resAuto;
            let resManual;
            let resDefault;
            let resInvalid;
            try {
              resAuto = await collectHandler(progressEvent, {
                accounts: fourAccounts,
                trigger: "auto",
              });
              const calledPlatforms = collectedBatches
                .slice(beforeLen)
                .map((x) => x.platform);
              assert.deepStrictEqual(
                calledPlatforms,
                ["快手", "视频号", "B站"],
                "auto 触发应跳过今日已成功的抖音，仅采集快手/视频号/B站"
              );
              assert.strictEqual(resAuto.results.length, 4);
              assert.strictEqual(resAuto.results[0].platform, "抖音");
              assert.strictEqual(resAuto.results[0].skipped, true);
              assert.strictEqual(resAuto.results[0].success, true);
              assert.strictEqual(resAuto.results[0].workCount, 12);
              assert.strictEqual(resAuto.results[1].skipped, undefined);
              assert.strictEqual(resAuto.results[1].success, true);
              assert.ok(
                progressEvents.some(
                  (e) => e.platform === "抖音" && e.status === "skipped"
                ),
                "跳过账号应推送 skipped 进度而非 failed"
              );

              // 日志应记录 trigger: "auto"
              assert.strictEqual(store.readCollectLogs()[0].trigger, "auto");

              // 手动触发（trigger:"manual"）：今日已成功的账号照常采集，不跳过
              const beforeManualLen = collectedBatches.length;
              resManual = await collectHandler(fakeEvent, {
                accounts: [fourAccounts[0]],
                trigger: "manual",
              });
              assert.strictEqual(collectedBatches.length - beforeManualLen, 1);
              assert.strictEqual(resManual.results[0].skipped, undefined);
              assert.strictEqual(store.readCollectLogs()[0].trigger, "manual");

              // 缺省不传 trigger：不跳过、向后兼容不写 trigger 字段
              resDefault = await collectHandler(fakeEvent, {
                accounts: [fourAccounts[0]],
              });
              assert.strictEqual(resDefault.results[0].skipped, undefined);
              assert.strictEqual(
                Object.prototype.hasOwnProperty.call(
                  store.readCollectLogs()[0],
                  "trigger"
                ),
                false
              );

              // 非法 trigger 忽略
              resInvalid = await collectHandler(fakeEvent, {
                accounts: [fourAccounts[0]],
                trigger: "invalid-trigger",
              });
              assert.strictEqual(resInvalid.results[0].skipped, undefined);
              assert.strictEqual(
                Object.prototype.hasOwnProperty.call(
                  store.readCollectLogs()[0],
                  "trigger"
                ),
                false
              );
            } finally {
              global.setTimeout = origSetTimeout;
            }
          }
        );

        // 端到端场景：「手动同步全部」进行中时自动到点遇 busy，手动完成后下周期自动重试跳过已成功账号
        const e2eDay = cnTime(2026, 11, 29, 10, 0, 0);
        const e2eAccounts = [
          { group: "E2E", platform: "抖音", partition: "persist:E2E-抖音" },
          { group: "E2E", platform: "快手", partition: "persist:E2E-快手" },
        ];
        const manualGate = createDeferred();
        const origImpl2 = collectorImpl;
        let manualBlocking = true;
        collectorImpl = async (params) => {
          if (manualBlocking) await manualGate.promise;
          return origImpl2(params);
        };
        const origSetTimeout = global.setTimeout;
        global.setTimeout = (fn) => {
          fn();
          return 0;
        };
        try {
          await withMockDateNow(
            () => e2eDay,
            async () => {
              const sE2E = createStatsScheduler({
                storage: createMemoryStorage(),
                now: () => localTime(2026, 11, 29, 10, 0, 0).getTime(),
                monotonicNow: () => STARTUP_DELAY_MS,
                startupDelayMs: 0,
                getAccounts: () => e2eAccounts,
                setIntervalFn: () => 1,
                clearIntervalFn: () => {},
              });
              sE2E.start();

              // 手动同步全部正在进行
              const manualPromise = collectHandler(fakeEvent, {
                accounts: e2eAccounts,
                trigger: "manual",
              });

              // 到点自动触发：遇 busy，不写入 auto-run.json
              const autoTick1 = await sE2E.tick();
              assert.strictEqual(autoTick1.busy, true);
              assert.strictEqual(store.readAutoRuns().includes("2026-11-29"), false);

              // 手动同步完成
              manualBlocking = false;
              manualGate.resolve();
              await manualPromise;

              // 下周期自动重试：认领 2026-11-29，但两个账号今日都已成功采集 → 全部跳过，0 次打开采集窗口！
              const beforeRetryCollects = collectedBatches.length;
              const autoTick2 = await sE2E.tick();
              assert.strictEqual(autoTick2.ran, true);
              assert.strictEqual(
                collectedBatches.length,
                beforeRetryCollects,
                "手动同步全部完成后，自动重试不得再打开窗口重采已成功账号"
              );
              assert.strictEqual(
                autoTick2.result.results.every((r) => r.skipped === true),
                true
              );
              assert.strictEqual(store.readAutoRuns().includes("2026-11-29"), true);
              sE2E.stop();
            }
          );
        } finally {
          global.setTimeout = origSetTimeout;
          collectorImpl = origImpl2;
        }
        console.log("✓ trigger==='auto' 跳过今日已成功账号、manual 不跳过、手动后自动重试不重采");
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

  console.log("\n全部通过：每日定时自动采集调度器、主进程权威认领与互斥跳重");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
