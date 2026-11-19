/**
 * 每日定时自动采集调度器（渲染层）：
 * - 设置保存在 localStorage "statsAutoCollect"：{ enabled, time, lastRunDate }
 * - 每 60s 用 setInterval 轮询一次（避免长 setTimeout 在系统睡眠/唤醒后漂移）
 * - 启动后前 2 分钟不触发（给用户先手动操作和登录窗口初始化留出时间）
 * - 本地日期 today !== lastRunDate 且当前时间 >= time 时触发（含关机/睡眠错过补跑）
 * - 先置 lastRunDate = today 再发起采集，防止失败后每分钟重试轰炸平台；
 *   仅当主进程返回「已有采集任务进行中」时还原 lastRunDate 下周期重试，当天最多重试 6 次（计数存内存）
 */

export const STORAGE_KEY = "statsAutoCollect";
export const CHECK_INTERVAL_MS = 60 * 1000;
export const STARTUP_DELAY_MS = 2 * 60 * 1000;
export const MAX_BUSY_RETRIES = 6;
export const BUSY_ERROR_TEXT = "已有采集任务进行中";

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  time: "10:00",
  lastRunDate: "",
});

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const settingsListeners = new Set();
const runCompleteListeners = new Set();

export function isValidTimeStr(time) {
  return typeof time === "string" && TIME_RE.test(time);
}

export function parseTimeToMinutes(time) {
  if (typeof time !== "string") return null;
  const match = TIME_RE.exec(time);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isValidDateStr(date) {
  if (typeof date !== "string") return false;
  const match = DATE_RE.exec(date);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(year, month - 1, day);
  return (
    dt.getFullYear() === year &&
    dt.getMonth() === month - 1 &&
    dt.getDate() === day
  );
}

/** 本地日期格式化为 YYYY-MM-DD；非法时间返回空串 */
export function formatLocalDate(now) {
  const dt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(dt.getTime())) return "";
  const year = dt.getFullYear();
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 清洗配置对象，任何坏数据均回落到对应默认值 */
export function normalizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    time: isValidTimeStr(raw.time) ? raw.time : DEFAULT_SETTINGS.time,
    lastRunDate: isValidDateStr(raw.lastRunDate) ? raw.lastRunDate : "",
  };
}

export function isBusyError(res) {
  return Boolean(
    res && typeof res.error === "string" && res.error.includes(BUSY_ERROR_TEXT)
  );
}

/**
 * 纯函数：判断当前时刻是否应触发每日自动采集。
 * @param {object} params
 * @param {Date|number} params.now 当前时刻
 * @param {object} [params.settings] 采集设置（自动归一化，坏数据回落默认）
 * @param {Date|number} [params.startedAt] 调度器启动时刻（未满 startupDelayMs 不跑）
 * @param {number} [params.startupDelayMs=120000] 启动延迟毫秒数
 * @param {{ date: string, count: number }|null} [params.busyState] 当日「进行中」重试状态
 * @param {number} [params.maxBusyRetries=6] 当日最多重试次数（首次尝试 + 最多 6 次重试）
 */
export function shouldRun({
  now,
  settings,
  startedAt,
  startupDelayMs = STARTUP_DELAY_MS,
  busyState = null,
  maxBusyRetries = MAX_BUSY_RETRIES,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return false;

  const cfg = normalizeSettings(settings);
  if (!cfg.enabled) return false;

  if (startedAt !== undefined && startedAt !== null) {
    const startMs =
      startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
    if (!Number.isFinite(startMs)) return false;
    const delay =
      Number.isFinite(startupDelayMs) && startupDelayMs >= 0
        ? startupDelayMs
        : STARTUP_DELAY_MS;
    if (nowMs - startMs < delay) return false;
  }

  const today = formatLocalDate(nowDate);
  if (!today || cfg.lastRunDate === today) return false;

  // busyState.count 记录当天遇到「已有采集任务进行中」的次数：
  // 首次触发(count=0) + 最多 maxBusyRetries(6) 次重试(count=1..6) = 最多 7 次调用；
  // count > maxBusyRetries 时当日停止重试。
  if (
    busyState &&
    busyState.date === today &&
    Number(busyState.count) > maxBusyRetries
  ) {
    return false;
  }

  const targetMinutes = parseTimeToMinutes(cfg.time);
  if (targetMinutes === null) return false;
  const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
  return nowMinutes >= targetMinutes;
}

/** 组装完成后的 Element UI $notify 参数 */
export function buildNotifyPayload(res) {
  if (res && typeof res.error === "string" && res.error) {
    return {
      title: "每日自动采集失败",
      message: res.error,
      type: "warning",
      duration: 6000,
    };
  }
  const results = Array.isArray(res && res.results) ? res.results : [];
  const successCount = results.filter((item) => item && item.success).length;
  const failCount = results.length - successCount;

  if (res && res.cancelled) {
    return {
      title: "每日自动采集已取消",
      message: `成功 ${successCount} / 失败 ${failCount}，详情请查看「拉取记录」`,
      type: "info",
      duration: 6000,
    };
  }
  if (failCount > 0) {
    return {
      title: "每日自动采集完成",
      message: `成功 ${successCount} / 失败 ${failCount}，详情请查看「拉取记录」`,
      type: "warning",
      duration: 6000,
    };
  }
  return {
    title: "每日自动采集完成",
    message: `成功 ${successCount} / 失败 0`,
    type: results.length > 0 ? "success" : "info",
    duration: 6000,
  };
}

function getDefaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch (_) {
    return null;
  }
}

function emitSettingsChange(settings) {
  for (const listener of [...settingsListeners]) {
    try {
      listener({ ...settings });
    } catch (_) {
      /* 单个监听异常不影响其他监听 */
    }
  }
}

function emitRunComplete(result) {
  for (const listener of [...runCompleteListeners]) {
    try {
      listener(result);
    } catch (_) {
      /* 单个监听异常不影响其他监听 */
    }
  }
}

export function subscribeSettings(listener) {
  if (typeof listener !== "function") return () => {};
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

export function subscribeRunComplete(listener) {
  if (typeof listener !== "function") return () => {};
  runCompleteListeners.add(listener);
  return () => runCompleteListeners.delete(listener);
}

export function loadSettings(storage = getDefaultStorage()) {
  if (!storage || typeof storage.getItem !== "function") {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings, storage = getDefaultStorage()) {
  const normalized = normalizeSettings(settings);
  if (storage && typeof storage.setItem === "function") {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (_) {
      /* 忽略 localStorage 不可写 / 配额满异常 */
    }
  }
  if (storage === getDefaultStorage()) {
    emitSettingsChange(normalized);
  }
  return normalized;
}

export function updateSettings(patch, storage = getDefaultStorage()) {
  const current = loadSettings(storage);
  const merged = { ...current };
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const key of ["enabled", "time", "lastRunDate"]) {
      if (patch[key] !== undefined) {
        merged[key] = patch[key];
      }
    }
  }
  return saveSettings(merged, storage);
}

function defaultGetAccounts() {
  const { buildCollectAccounts } = require("./statsApi");
  return buildCollectAccounts();
}

function defaultCollect(accounts) {
  const { ipcRenderer } = require("electron");
  if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
    return ipcRenderer.invoke("stats:collect", { accounts, trigger: "auto" });
  }
  const { collectAccounts } = require("./statsApi");
  return collectAccounts(accounts);
}

/** 创建可测试、可依赖注入的每日自动采集调度器实例 */
export function createStatsScheduler(options = {}) {
  const {
    storage,
    getAccounts = defaultGetAccounts,
    collect = defaultCollect,
    notify = () => {},
    now = () => Date.now(),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = CHECK_INTERVAL_MS,
    startupDelayMs = STARTUP_DELAY_MS,
    maxBusyRetries = MAX_BUSY_RETRIES,
    onRunComplete,
    emitGlobalRunComplete = false,
  } = options;

  let timer = null;
  let startedAt = null;
  let running = false;
  let stopped = true;
  let busyState = { date: "", count: 0 };
  // localStorage 不可写时的内存兜底日期，避免每分钟重复触发采集
  let fallbackRunDate = "";

  async function tick() {
    if (stopped || running) {
      return { ran: false, reason: stopped ? "stopped" : "in-flight" };
    }

    const currentNow = now();
    const today = formatLocalDate(currentNow);
    if (!today) {
      return { ran: false, reason: "invalid-date" };
    }

    if (busyState.date && busyState.date !== today) {
      busyState = { date: "", count: 0 };
    }

    const settings = loadSettings(storage);
    const effectiveSettings =
      fallbackRunDate === today && settings.lastRunDate !== today
        ? { ...settings, lastRunDate: today }
        : settings;

    if (
      !shouldRun({
        now: currentNow,
        settings: effectiveSettings,
        startedAt,
        startupDelayMs,
        busyState,
        maxBusyRetries,
      })
    ) {
      return { ran: false, reason: "not-due" };
    }

    const prevLastRunDate = settings.lastRunDate;
    const prevFallbackRunDate = fallbackRunDate;
    running = true;

    try {
      // 先置 lastRunDate = today，防止失败后每分钟重试轰炸平台
      updateSettings({ lastRunDate: today }, storage);
      if (loadSettings(storage).lastRunDate !== today) {
        fallbackRunDate = today;
      }

      let accounts = [];
      try {
        const list = getAccounts();
        accounts = Array.isArray(list) ? list : [];
      } catch (_) {
        accounts = [];
      }

      // 无账号则直接记为已跑，不调用 IPC、不弹窗
      if (!accounts.length) {
        busyState = { date: "", count: 0 };
        return { ran: true, skippedEmpty: true };
      }

      let res;
      try {
        res = await collect(accounts);
      } catch (err) {
        const message = (err && err.message) || String(err) || "采集异常";
        if (!stopped && typeof notify === "function") {
          try {
            notify({
              title: "每日自动采集失败",
              message,
              type: "warning",
              duration: 6000,
            });
          } catch (_) {
            /* 忽略通知异常 */
          }
        }
        if (!stopped) {
          if (typeof onRunComplete === "function") {
            try {
              onRunComplete({ results: [], error: message });
            } catch (_) {}
          }
          if (emitGlobalRunComplete) {
            emitRunComplete({ results: [], error: message });
          }
        }
        return { ran: true, error: message };
      }

      if (isBusyError(res)) {
        const nextCount = busyState.date === today ? busyState.count + 1 : 1;
        busyState = { date: today, count: nextCount };
        fallbackRunDate = prevFallbackRunDate;
        const latest = loadSettings(storage);
        if (latest.lastRunDate === today) {
          updateSettings({ lastRunDate: prevLastRunDate }, storage);
        }
        return {
          ran: false,
          busy: true,
          retryCount: nextCount,
          exhausted: nextCount > maxBusyRetries,
        };
      }

      busyState = { date: "", count: 0 };

      const payload = buildNotifyPayload(res);
      if (payload && !stopped && typeof notify === "function") {
        try {
          notify(payload);
        } catch (_) {
          /* 忽略通知异常 */
        }
      }
      if (!stopped) {
        if (typeof onRunComplete === "function") {
          try {
            onRunComplete(res);
          } catch (_) {}
        }
        if (emitGlobalRunComplete) {
          emitRunComplete(res);
        }
      }
      return { ran: true, result: res };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer !== null) return;
    stopped = false;
    startedAt = now();
    timer = setIntervalFn(() => {
      tick();
    }, checkIntervalMs);
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  function getState() {
    return {
      running,
      stopped,
      startedAt,
      busyState: { ...busyState },
    };
  }

  return { start, stop, tick, getState };
}

let defaultScheduler = null;

export function start(options = {}) {
  if (defaultScheduler) {
    defaultScheduler.stop();
  }
  defaultScheduler = createStatsScheduler({
    ...options,
    emitGlobalRunComplete: true,
  });
  defaultScheduler.start();
  return defaultScheduler;
}

export function stop() {
  if (defaultScheduler) {
    defaultScheduler.stop();
    defaultScheduler = null;
  }
}

export const startStatsScheduler = start;
export const stopStatsScheduler = stop;

export default {
  STORAGE_KEY,
  DEFAULT_SETTINGS,
  CHECK_INTERVAL_MS,
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
  subscribeSettings,
  subscribeRunComplete,
  createStatsScheduler,
  start,
  stop,
};
