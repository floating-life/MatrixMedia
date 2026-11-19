/**
 * 每日定时自动采集调度器单元测试（不依赖 Electron 运行环境）：
 * 1. 纯函数 shouldRun：未到点、到点、当天已跑、跨天再跑、错过补跑、启动 2 分钟内、关闭、坏设置、边界时间
 * 2. 配置读写（normalizeSettings / loadSettings / saveSettings / updateSettings）：坏 JSON / 非法字段 / 异常兜底
 * 3. 完整调度流程：先置 lastRunDate 防轰炸、成功/部分失败/取消/异常通知、无账号记为已跑、并发防重入、改设置即时生效、不可写存储兜底、启停生命周期
 * 4. 「已有采集任务进行中」还原 lastRunDate 与当日 6 次重试上限（首次 + 6 次重试 = 7 次）及跨天清零
 * 5. 主进程 stats:collect 可选 trigger 字段（"auto" / "manual" / 缺省向后兼容 / 非法忽略 / 互斥）与默认 IPC 透传
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
  shouldRun,
  isBusyError,
  buildNotifyPayload,
  loadSettings,
  saveSettings,
  updateSettings,
  createStatsScheduler,
} = schedulerMod;

function localTime(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  return new Date(y, m - 1, d, hh, mm, ss, ms);
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

async function main() {
  /* ---------- 1. shouldRun 纯函数 ---------- */
  {
    const startedAt = localTime(2026, 11, 19, 8, 0, 0).getTime();

    // 未到点不跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 9, 59, 59),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt,
      }),
      false,
      "未到设定时间（09:59:59 < 10:00）不应运行"
    );

    // 到点跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt,
      }),
      true,
      "刚好到点（10:00:00）应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 30),
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt,
      }),
      true,
      "到点后同分钟内应运行"
    );

    // 当天已跑不跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
        startedAt,
      }),
      false,
      "当天已跑过不应重复运行"
    );

    // 跨天：未到点不跑，到点再跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 9, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
        startedAt,
      }),
      false,
      "跨天后未到点不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 10, 0, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-19" },
        startedAt,
      }),
      true,
      "跨天到点应再次运行"
    );

    // 错过补跑（笔记本 10:00 关机/睡眠，15:30 唤醒/开机满 2 分钟后补跑）
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 15, 30, 0),
        settings: { enabled: true, time: "10:00", lastRunDate: "2026-11-18" },
        startedAt,
      }),
      true,
      "错过设定时间且当天未跑时应补跑"
    );

    // 启动 2 分钟内不跑
    const lateStart = localTime(2026, 11, 19, 15, 0, 0).getTime();
    assert.strictEqual(
      shouldRun({
        now: lateStart,
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: lateStart,
      }),
      false,
      "启动瞬间（0ms）不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: lateStart + 60 * 1000,
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: lateStart,
      }),
      false,
      "启动 1 分钟不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: lateStart + STARTUP_DELAY_MS - 1,
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: lateStart,
      }),
      false,
      "启动 119.999 秒不应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: lateStart + STARTUP_DELAY_MS,
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: lateStart,
      }),
      true,
      "启动刚好满 2 分钟且已过设定时间应运行"
    );
    assert.strictEqual(
      shouldRun({
        now: lateStart - 1000,
        settings: { enabled: true, time: "10:00", lastRunDate: "" },
        startedAt: lateStart,
      }),
      false,
      "系统时钟回拨到 startedAt 之前不应运行"
    );

    // 关闭不跑
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 12, 0, 0),
        settings: { enabled: false, time: "10:00", lastRunDate: "" },
        startedAt,
      }),
      false,
      "enabled=false 时不应运行"
    );

    // 坏设置直接传入 shouldRun 时回落默认（enabled: true, time: "10:00", lastRunDate: ""）
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 9, 59, 0),
        settings: null,
        startedAt,
      }),
      false,
      "settings=null 回落默认 10:00，09:59 不跑"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 10, 0, 0),
        settings: { enabled: "nope", time: "99:99", lastRunDate: "invalid" },
        startedAt,
      }),
      true,
      "坏字段回落默认后 10:00 应跑"
    );

    // 边界时间 00:00 与 23:30
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 20, 0, 0, 0),
        settings: { enabled: true, time: "00:00", lastRunDate: "2026-11-19" },
        startedAt,
      }),
      true,
      "00:00 设定在零点应触发"
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 23, 29, 59),
        settings: { enabled: true, time: "23:30", lastRunDate: "" },
        startedAt,
      }),
      false
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 23, 30, 0),
        settings: { enabled: true, time: "23:30", lastRunDate: "" },
        startedAt,
      }),
      true
    );

    // 非法时间戳
    assert.strictEqual(
      shouldRun({ now: NaN, settings: DEFAULT_SETTINGS, startedAt }),
      false
    );
    assert.strictEqual(
      shouldRun({
        now: localTime(2026, 11, 19, 12, 0, 0),
        settings: DEFAULT_SETTINGS,
        startedAt: NaN,
      }),
      false
    );
    console.log("✓ shouldRun 纯函数判定（未到点/到点/已跑/跨天/补跑/2分钟延迟/关闭/坏设置/边界）");
  }

  /* ---------- 2. 坏设置回落默认 & 存储读写容错 ---------- */
  {
    assert.deepStrictEqual(normalizeSettings(null), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings([]), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings("bad"), DEFAULT_SETTINGS);
    assert.deepStrictEqual(normalizeSettings(123), DEFAULT_SETTINGS);

    // 单字段非法各自回落，合法字段保留
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: false,
        time: "25:00",
        lastRunDate: "2026-11-18",
      }),
      { enabled: false, time: "10:00", lastRunDate: "2026-11-18" },
      "非法 time 应回落 10:00，同时保留合法 enabled 与 lastRunDate"
    );
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: "false",
        time: "10:60",
        lastRunDate: "2026-02-30",
      }),
      { enabled: true, time: "10:00", lastRunDate: "" },
      "字符串布尔、60 分、不存在日历日期 02-30 均应回落默认"
    );
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: 0,
        time: "9:00",
        lastRunDate: "2026-13-01",
      }),
      { enabled: true, time: "10:00", lastRunDate: "" }
    );
    assert.deepStrictEqual(
      normalizeSettings({
        enabled: true,
        time: "08:30",
        lastRunDate: "2024-02-29",
      }),
      { enabled: true, time: "08:30", lastRunDate: "2024-02-29" },
      "闰年 2024-02-29 合法应保留"
    );

    // 损坏 JSON / 非对象 JSON
    for (const badRaw of ["", "{broken", "null", "[]", "123", '"hello"', "true"]) {
      const storage = createMemoryStorage({ [STORAGE_KEY]: badRaw });
      assert.deepStrictEqual(
        loadSettings(storage),
        DEFAULT_SETTINGS,
        `损坏存储值 ${badRaw} 应回落默认`
      );
    }

    // storage 抛异常不崩溃
    const throwingStorage = {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    assert.deepStrictEqual(loadSettings(throwingStorage), DEFAULT_SETTINGS);
    assert.deepStrictEqual(
      saveSettings({ enabled: false, time: "11:30", lastRunDate: "2026-11-19" }, throwingStorage),
      { enabled: false, time: "11:30", lastRunDate: "2026-11-19" }
    );

    // updateSettings 保留未传字段并忽略 undefined
    const storage = createMemoryStorage();
    saveSettings({ enabled: true, time: "10:00", lastRunDate: "2026-11-18" }, storage);
    const updated = updateSettings({ time: "14:30", lastRunDate: undefined }, storage);
    assert.deepStrictEqual(updated, {
      enabled: true,
      time: "14:30",
      lastRunDate: "2026-11-18",
    });
    assert.deepStrictEqual(loadSettings(storage), updated);
    console.log("✓ 配置归一化与 localStorage 读写容错（坏数据回落默认 / 异常不崩 / 局部更新）");
  }

  /* ---------- 3. 调度器全流程：启动延迟、先写日期、单次运行、跨天再跑、通知 ---------- */
  {
    let currentTime = localTime(2026, 11, 19, 9, 59, 0).getTime();
    const storage = createMemoryStorage();
    const calls = [];
    const notifications = [];
    let intervalId = 0;
    let clearedIds = [];
    let observedLastRunDuringCollect = null;

    const accounts = [
      { group: "G1", platform: "抖音", partition: "persist:G1-抖音" },
      { group: "G1", platform: "快手", partition: "persist:G1-快手" },
    ];

    const scheduler = createStatsScheduler({
      storage,
      now: () => currentTime,
      getAccounts: () => accounts,
      collect: async (accs) => {
        observedLastRunDuringCollect = loadSettings(storage).lastRunDate;
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

    // 未 start 前 tick 不跑
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "stopped" });

    scheduler.start();
    assert.strictEqual(intervalId, 1);

    // 10:00:00：虽然到了 10:00，但距离 09:59:00 启动仅 1 分钟，启动 2 分钟内不跑
    currentTime = localTime(2026, 11, 19, 10, 0, 0).getTime();
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(calls.length, 0);

    // 10:01:00：距离 09:59:00 满 2 分钟且已到 10:00 → 跑一次
    currentTime = localTime(2026, 11, 19, 10, 1, 0).getTime();
    const r1 = await scheduler.tick();
    assert.strictEqual(r1.ran, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      observedLastRunDuringCollect,
      "2026-11-19",
      "必须先将 lastRunDate 置为 today 再调用 collect"
    );
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-19");
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].type, "warning");
    assert.ok(
      notifications[0].message.includes("成功 1 / 失败 1"),
      "通知文案应包含成功/失败计数"
    );

    // 同天 10:02:00 再 tick 不跑
    currentTime = localTime(2026, 11, 19, 10, 2, 0).getTime();
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(calls.length, 1);

    // 跨天 11-20 09:59:00 未到点不跑
    currentTime = localTime(2026, 11, 20, 9, 59, 0).getTime();
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(calls.length, 1);

    // 跨天 11-20 10:00:00 到点再跑
    currentTime = localTime(2026, 11, 20, 10, 0, 0).getTime();
    const r2 = await scheduler.tick();
    assert.strictEqual(r2.ran, true);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-20");

    scheduler.stop();
    assert.deepStrictEqual(clearedIds, [1]);
    assert.deepStrictEqual(await scheduler.tick(), { ran: false, reason: "stopped" });
    console.log("✓ 调度器主流程（2分钟延迟/先置日期/单次运行/跨天再跑/$notify/stop清理）");
  }

  /* ---------- 4. 失败/异常不还原 lastRunDate & 无账号直接记为已跑 ---------- */
  {
    // 4a. collect 抛异常：不还原 lastRunDate，防止每分钟轰炸平台
    let currentTime = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const storage = createMemoryStorage();
    let collectCount = 0;
    const notifications = [];
    const sErr = createStatsScheduler({
      storage,
      now: () => currentTime,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      collect: async () => {
        collectCount++;
        throw new Error("网络断开");
      },
      notify: (p) => notifications.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sErr.start();
    currentTime += STARTUP_DELAY_MS;
    const resErr = await sErr.tick();
    assert.strictEqual(resErr.ran, true);
    assert.strictEqual(collectCount, 1);
    assert.strictEqual(loadSettings(storage).lastRunDate, "2026-11-19");
    assert.strictEqual(notifications.length, 1);
    assert.ok(notifications[0].message.includes("网络断开"));
    // 下一分钟不再重试
    currentTime += 60 * 1000;
    await sErr.tick();
    assert.strictEqual(collectCount, 1, "非进行中失败后同天不得重试轰炸");
    sErr.stop();

    // 4b. 无账号直接记为已跑，不调 collect、不弹窗
    let emptyTime = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const emptyStorage = createMemoryStorage();
    let emptyCollectCalled = 0;
    const emptyNotifies = [];
    const sEmpty = createStatsScheduler({
      storage: emptyStorage,
      now: () => emptyTime,
      getAccounts: () => [],
      collect: async () => {
        emptyCollectCalled++;
        return { results: [] };
      },
      notify: (p) => emptyNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sEmpty.start();
    emptyTime += STARTUP_DELAY_MS;
    const rEmpty = await sEmpty.tick();
    assert.deepStrictEqual(rEmpty, { ran: true, skippedEmpty: true });
    assert.strictEqual(emptyCollectCalled, 0, "无账号不得调用 collect");
    assert.strictEqual(emptyNotifies.length, 0, "无账号不得弹通知");
    assert.strictEqual(loadSettings(emptyStorage).lastRunDate, "2026-11-19");
    // 同天后续 tick 不再跑
    emptyTime += 60 * 1000;
    assert.deepStrictEqual(await sEmpty.tick(), { ran: false, reason: "not-due" });
    sEmpty.stop();
    console.log("✓ 失败不重炸平台 & 无账号直接记为已跑");
  }

  /* ---------- 5. 「已有采集任务进行中」还原与 6 次上限 + 跨天清零 + 中途成功 ---------- */
  {
    // 5a. 持续「已有采集任务进行中」：首次 + 最多 6 次重试 = 共 7 次，之后当日停止，且保留原 lastRunDate
    let currentTime = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const storage = createMemoryStorage();
    saveSettings({ enabled: true, time: "10:00", lastRunDate: "2026-11-18" }, storage);

    let busyCalls = 0;
    const busyNotifies = [];
    const sBusy = createStatsScheduler({
      storage,
      now: () => currentTime,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      collect: async () => {
        busyCalls++;
        // 调用期间已提前写入当天，返回进行中后再还原
        assert.strictEqual(
          loadSettings(storage).lastRunDate,
          formatLocalDate(currentTime)
        );
        // 模拟调用期间用户修改了设定时间，还原时不得覆盖用户的修改
        if (busyCalls === 2) {
          updateSettings({ time: "09:30" }, storage);
        }
        return { results: [], error: BUSY_ERROR_TEXT };
      },
      notify: (p) => busyNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });

    sBusy.start();
    currentTime += STARTUP_DELAY_MS;

    // 连续 10 个周期 tick：前 7 次触发（1 首次 + 6 重试），第 8/9/10 次跳过
    for (let i = 1; i <= 10; i++) {
      const out = await sBusy.tick();
      if (i <= MAX_BUSY_RETRIES + 1) {
        assert.strictEqual(out.busy, true, `第 ${i} 次应命中进行中`);
        assert.strictEqual(out.retryCount, i);
        assert.strictEqual(
          out.exhausted,
          i > MAX_BUSY_RETRIES,
          `仅第 ${MAX_BUSY_RETRIES + 1} 次应标记 exhausted`
        );
        assert.strictEqual(
          loadSettings(storage).lastRunDate,
          "2026-11-18",
          `第 ${i} 次进行中后 lastRunDate 应还原为 2026-11-18`
        );
      } else {
        assert.deepStrictEqual(
          out,
          { ran: false, reason: "not-due" },
          `超过 ${MAX_BUSY_RETRIES} 次重试上限后第 ${i} 次不应再触发`
        );
      }
      currentTime += 60 * 1000;
    }

    assert.strictEqual(
      busyCalls,
      MAX_BUSY_RETRIES + 1,
      "应为首次触发 + 最多 6 次重试共 7 次调用"
    );
    assert.strictEqual(busyNotifies.length, 0, "进行中重试期间不应弹通知");
    assert.strictEqual(
      loadSettings(storage).time,
      "09:30",
      "还原 lastRunDate 不得覆盖期间修改的 time"
    );
    assert.strictEqual(
      loadSettings(storage).lastRunDate,
      "2026-11-18",
      "达到上限后不伪造今日已跑"
    );

    // 跨天到 11-20 09:30：重试计数自动清零，可重新触发
    currentTime = localTime(2026, 11, 20, 9, 30, 0).getTime();
    const nextDayOut = await sBusy.tick();
    assert.strictEqual(nextDayOut.busy, true);
    assert.strictEqual(nextDayOut.retryCount, 1, "跨天后进行中重试计数应清零");
    assert.strictEqual(busyCalls, MAX_BUSY_RETRIES + 2);
    sBusy.stop();

    // 5b. 重试中途恢复成功（前 2 次进行中，第 3 次成功）
    let tMid = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const midStorage = createMemoryStorage();
    let midCalls = 0;
    const midNotifies = [];
    const sMid = createStatsScheduler({
      storage: midStorage,
      now: () => tMid,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      collect: async () => {
        midCalls++;
        if (midCalls <= 2) {
          return { results: [], error: "已有采集任务进行中" };
        }
        return {
          cancelled: false,
          results: [{ group: "G1", platform: "抖音", success: true, workCount: 5 }],
        };
      },
      notify: (p) => midNotifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sMid.start();
    tMid += STARTUP_DELAY_MS;

    assert.strictEqual((await sMid.tick()).busy, true);
    assert.strictEqual(loadSettings(midStorage).lastRunDate, "", "首次从未跑过时应还原为空串");
    tMid += 60 * 1000;
    assert.strictEqual((await sMid.tick()).busy, true);
    assert.strictEqual(loadSettings(midStorage).lastRunDate, "");
    tMid += 60 * 1000;
    const okOut = await sMid.tick();
    assert.strictEqual(okOut.ran, true);
    assert.strictEqual(loadSettings(midStorage).lastRunDate, "2026-11-19");
    assert.strictEqual(midNotifies.length, 1);
    assert.strictEqual(midNotifies[0].type, "success");
    assert.strictEqual(midNotifies[0].message, "成功 1 / 失败 0");
    // 当天后续不再触发
    tMid += 60 * 1000;
    assert.deepStrictEqual(await sMid.tick(), { ran: false, reason: "not-due" });
    assert.strictEqual(midCalls, 3);
    sMid.stop();
    console.log("✓ 「已有采集任务进行中」还原 lastRunDate、6 次重试上限、跨天清零与中途恢复成功");
  }

  /* ---------- 6. 并发防重入、改设置即时生效、不可写存储兜底、stop 后不弹通知 ---------- */
  {
    // 6a. 并发防重入 + stop 后结束不弹通知
    let t = localTime(2026, 11, 19, 23, 59, 0).getTime();
    const storage = createMemoryStorage();
    saveSettings({ enabled: true, time: "00:00", lastRunDate: "2026-11-18" }, storage);
    const pending = createDeferred();
    let calls = 0;
    const notifies = [];
    const s = createStatsScheduler({
      storage,
      now: () => t,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      collect: () => {
        calls++;
        return pending.promise;
      },
      notify: (p) => notifies.push(p),
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    s.start();
    t = localTime(2026, 11, 20, 0, 1, 0).getTime();
    const firstRun = s.tick();
    // 进行中即使跨天再次 tick 也不得重入
    t = localTime(2026, 11, 21, 0, 1, 0).getTime();
    assert.deepStrictEqual(await s.tick(), { ran: false, reason: "in-flight" });
    assert.strictEqual(calls, 1);
    // stop 后再 resolve 不弹通知
    s.stop();
    pending.resolve({
      cancelled: false,
      results: [{ group: "G1", platform: "抖音", success: true }],
    });
    await firstRun;
    assert.strictEqual(notifies.length, 0, "stop() 后完成的采集不应再弹通知");

    // 6b. 改设置即时生效（关闭 → 开启；推迟/提前时间）
    let tLive = localTime(2026, 11, 19, 10, 0, 0).getTime();
    const liveStorage = createMemoryStorage();
    saveSettings({ enabled: false, time: "18:00", lastRunDate: "" }, liveStorage);
    let liveCalls = 0;
    const sLive = createStatsScheduler({
      storage: liveStorage,
      now: () => tLive,
      getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
      collect: async () => {
        liveCalls++;
        return { cancelled: false, results: [{ success: true }] };
      },
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
    });
    sLive.start();
    tLive = localTime(2026, 11, 19, 11, 0, 0).getTime();
    assert.deepStrictEqual(await sLive.tick(), { ran: false, reason: "not-due" });
    // 开启但时间仍是 18:00 → 11:00 仍不跑
    updateSettings({ enabled: true }, liveStorage);
    assert.deepStrictEqual(await sLive.tick(), { ran: false, reason: "not-due" });
    // 改时间为 10:30 → 立刻在下个 tick 生效运行
    updateSettings({ time: "10:30" }, liveStorage);
    assert.strictEqual((await sLive.tick()).ran, true);
    assert.strictEqual(liveCalls, 1);
    sLive.stop();

    // 6c. 不可写 storage（setItem 抛错，即使已有昨日 lastRunDate）内存兜底不轰炸
    for (const staleRaw of [
      null,
      JSON.stringify({ enabled: true, time: "10:00", lastRunDate: "2026-11-18" }),
    ]) {
      let tRo = localTime(2026, 11, 19, 10, 0, 0).getTime();
      const roStorage = {
        getItem: () => staleRaw,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      };
      let roCalls = 0;
      const sRo = createStatsScheduler({
        storage: roStorage,
        now: () => tRo,
        getAccounts: () => [{ group: "G1", platform: "抖音", partition: "p1" }],
        collect: async () => {
          roCalls++;
          return { cancelled: false, results: [{ success: true }] };
        },
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });
      sRo.start();
      tRo += STARTUP_DELAY_MS;
      assert.strictEqual((await sRo.tick()).ran, true);
      tRo += 60 * 1000;
      assert.deepStrictEqual(await sRo.tick(), { ran: false, reason: "not-due" });
      assert.strictEqual(
        roCalls,
        1,
        "localStorage 不可写时内存兜底应防止同天重复采集"
      );
      // 跨天仍可正常触发一次
      tRo = localTime(2026, 11, 20, 10, 0, 0).getTime();
      assert.strictEqual((await sRo.tick()).ran, true);
      assert.strictEqual(roCalls, 2);
      sRo.stop();
    }

    // 6d. buildNotifyPayload 与 isBusyError
    assert.strictEqual(isBusyError({ error: "已有采集任务进行中" }), true);
    assert.strictEqual(isBusyError({ error: "没有可采集的账号" }), false);
    assert.strictEqual(isBusyError(null), false);
    assert.strictEqual(
      buildNotifyPayload({ cancelled: true, results: [{ success: true }] }).type,
      "info"
    );
    assert.strictEqual(
      buildNotifyPayload({ results: [], error: "服务异常" }).title,
      "每日自动采集失败"
    );
    console.log("✓ 并发防重入、改设置即时生效、只读 storage 兜底、stop 后静默");
  }

  /* ---------- 7. 主进程 stats:collect 可选 trigger 字段 + 默认 IPC 透传 ---------- */
  {
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
    const appendedLogs = [];
    const invokeCalls = [];
    let activeCollectGate = null;

    require.cache[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: {
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
        collectAccount: async () => {
          if (activeCollectGate) await activeCollectGate.promise;
          return { overview: { plays: 1 }, fansHistory: [], works: [{ workId: "w1" }] };
        },
      },
    };
    require.cache[storeId] = {
      id: storeId,
      filename: storeId,
      loaded: true,
      exports: {
        mergeDaily: () => {},
        mergeWorks: () => {},
        writeMeta: () => {},
        readAccount: () => ({}),
        readOverview: () => ({}),
        readCollectLogs: () => appendedLogs,
        appendCollectLog: (entry) => appendedLogs.push(entry),
      },
    };
    delete require.cache[indexId];
    delete require.cache[statsApiId];

    try {
      const { registerDataStatsIpc } = require(indexId);
      registerDataStatsIpc();
      const collectHandler = ipcHandlers.get("stats:collect");
      assert.strictEqual(typeof collectHandler, "function");

      const sampleAccounts = [
        { group: "G1", platform: "抖音", partition: "persist:G1-抖音" },
      ];
      const fakeEvent = { sender: { send: () => {} } };

      // 7a. trigger: "auto" 原样写入 log
      const resAuto = await collectHandler(fakeEvent, {
        accounts: sampleAccounts,
        trigger: "auto",
      });
      assert.strictEqual(resAuto.results.length, 1);
      assert.strictEqual(appendedLogs[appendedLogs.length - 1].trigger, "auto");

      // 7b. trigger: "manual" 原样写入 log
      await collectHandler(fakeEvent, {
        accounts: sampleAccounts,
        trigger: "manual",
      });
      assert.strictEqual(appendedLogs[appendedLogs.length - 1].trigger, "manual");

      // 7c. 缺省不传 trigger（向后兼容，不写多余字段）
      await collectHandler(fakeEvent, { accounts: sampleAccounts });
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
          appendedLogs[appendedLogs.length - 1],
          "trigger"
        ),
        false,
        "未传 trigger 时不应写入 trigger 字段"
      );

      // 7d. 非法 trigger 忽略
      await collectHandler(fakeEvent, {
        accounts: sampleAccounts,
        trigger: "invalid-trigger",
      });
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(
          appendedLogs[appendedLogs.length - 1],
          "trigger"
        ),
        false,
        "非法 trigger 值应忽略"
      );

      // 7e. 并发互斥语义保持不变
      activeCollectGate = createDeferred();
      const inFlight = collectHandler(fakeEvent, {
        accounts: sampleAccounts,
        trigger: "manual",
      });
      const busyRes = await collectHandler(fakeEvent, {
        accounts: sampleAccounts,
        trigger: "auto",
      });
      assert.deepStrictEqual(busyRes, {
        results: [],
        error: "已有采集任务进行中",
      });
      activeCollectGate.resolve();
      activeCollectGate = null;
      await inFlight;

      // 7f. 默认 scheduler 通过 ipcRenderer.invoke("stats:collect", { accounts, trigger: "auto" }) 打通主进程
      let tIpc = localTime(2026, 11, 19, 10, 0, 0).getTime();
      const ipcStorage = createMemoryStorage();
      const sIpc = createStatsScheduler({
        storage: ipcStorage,
        now: () => tIpc,
        getAccounts: () => sampleAccounts,
        setIntervalFn: () => 1,
        clearIntervalFn: () => {},
      });
      sIpc.start();
      tIpc += STARTUP_DELAY_MS;
      const ipcRun = await sIpc.tick();
      assert.strictEqual(ipcRun.ran, true);
      assert.strictEqual(invokeCalls.length, 1);
      assert.strictEqual(invokeCalls[0].channel, "stats:collect");
      assert.strictEqual(invokeCalls[0].payload.trigger, "auto");
      assert.strictEqual(appendedLogs[appendedLogs.length - 1].trigger, "auto");
      sIpc.stop();

      console.log("✓ 主进程 stats:collect 可选 trigger 字段与默认 IPC 透传正确");
    } finally {
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
    }
  }

  console.log("\n全部通过：每日定时自动采集调度器与 trigger 兼容");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
