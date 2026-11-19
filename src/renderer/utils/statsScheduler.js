/**
 * 每日定时自动采集调度器（渲染层）：
 * - 设置保存在 localStorage "statsAutoCollect"：{ enabled, time, lastRunDate }
 *   其中 lastRunDate 仅作界面展示与快速跳过，「每天只跑一次」的权威判定在主进程
 *   stats:auto-claim（<userData>/data-stats/auto-run.json，UTC+8）
 * - 每 60s 用 setInterval 轮询一次（避免长 setTimeout 在系统睡眠/唤醒后漂移）
 * - 启动后前 2 分钟用单调时钟（performance.now）拦截，不受系统校时/回拨影响
 * - 本地时间 >= time 且未快速跳过时，先读取账号树（解析失败返回 null → 不认领继续轮询；
 *   确认为空数组 [] → 仍向主进程认领记录当天已跑）
 * - 主进程 stats:auto-claim 成功后发起 stats:collect(trigger:"auto")；
 *   若认领返回 busy，或认领后采集 IPC 返回 busy（此时调 stats:auto-release 释放本次认领），
 *   则下周期重试，当天最多重试 6 次（计数存内存）
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
const MAIN_ROUTE_PREFIXES = [
  "/data-stats",
  "/video-manager",
  "/project-detail",
  "/accountManager",
];

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
 * 判断当前渲染器的 location 是否为主窗口页面（排除登录窗、加载窗及 open-win 子窗口）。
 */
export function isMainWindowLocation(
  loc = typeof window !== "undefined" ? window.location : null
) {
  if (!loc || typeof loc !== "object") return false;
  const protocol = String(loc.protocol || "");
  const hostname = String(loc.hostname || "");
  const pathname = String(loc.pathname || "");
  const hash = String(loc.hash || "");

  if (protocol === "file:") {
    if (!/(?:^|\/)index\.html$/i.test(pathname)) return false;
  } else if (protocol === "http:" || protocol === "https:") {
    if (
      hostname !== "localhost" &&
      hostname !== "127.0.0.1" &&
      hostname !== "[::1]"
    ) {
      return false;
    }
    if (pathname !== "/" && !/\/index\.html$/i.test(pathname)) return false;
  } else {
    return false;
  }

  const rawHash = hash.replace(/^#/, "").split("?")[0];
  if (!rawHash || rawHash === "/") return true;
  return MAIN_ROUTE_PREFIXES.some(
    (prefix) => rawHash === prefix || rawHash.startsWith(`${prefix}/`)
  );
}

/**
 * 纯函数：判断当前时刻是否应触发每日自动采集。
 * 注意：不含依赖 Date 的启动延迟闸门（启动延迟由调度器用单调时钟独立判定）；
 * settings.lastRunDate 仅作快速跳过与展示，权威判定在主进程 stats:auto-claim。
 * @param {object} params
 * @param {Date|number} params.now 当前时刻
 * @param {object} [params.settings] 采集设置（自动归一化，坏数据回落默认）
 * @param {{ date: string, count: number }|null} [params.busyState] 当日「进行中」重试状态
 * @param {number} [params.maxBusyRetries=6] 当日最多重试次数（首次尝试 + 最多 6 次重试）
 */
export function shouldRun({
  now,
  settings,
  busyState = null,
  maxBusyRetries = MAX_BUSY_RETRIES,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  if (!Number.isFinite(nowMs)) return false;

  const cfg = normalizeSettings(settings);
  if (!cfg.enabled) return false;

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
  const skippedCount = results.filter((item) => item && item.skipped).length;
  const successCount = results.filter(
    (item) => item && item.success && !item.skipped
  ).length;
  const failCount = results.filter(
    (item) => !item || (!item.success && !item.skipped)
  ).length;
  const countText =
    skippedCount > 0
      ? `成功 ${successCount} / 跳过 ${skippedCount} / 失败 ${failCount}`
      : `成功 ${successCount} / 失败 ${failCount}`;

  if (res && res.cancelled) {
    return {
      title: "每日自动采集已取消",
      message: `${countText}，详情请查看「拉取记录」`,
      type: "info",
      duration: 6000,
    };
  }
  if (failCount > 0) {
    return {
      title: "每日自动采集完成",
      message: `${countText}，详情请查看「拉取记录」`,
      type: "warning",
      duration: 6000,
    };
  }
  return {
    title: "每日自动采集完成",
    message: countText,
    type: successCount > 0 ? "success" : "info",
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

function defaultMonotonicNow() {
  if (
    typeof performance !== "undefined" &&
    performance &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
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

/**
 * 保存配置到 localStorage。
 * 返回 { ok: true, settings } 或 { ok: false, settings: 当前有效配置, error }，
 * 写入失败时不触发设置变更广播，由调用方提示错误并回滚 UI。
 */
export function saveSettings(settings, storage = getDefaultStorage()) {
  const normalized = normalizeSettings(settings);
  if (!storage || typeof storage.setItem !== "function") {
    return {
      ok: false,
      settings: loadSettings(storage),
      error: "本地存储不可用",
    };
  }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch (err) {
    return {
      ok: false,
      settings: loadSettings(storage),
      error: (err && err.message) || "保存失败",
    };
  }
  if (storage === getDefaultStorage()) {
    emitSettingsChange(normalized);
  }
  return { ok: true, settings: normalized };
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

function defaultAutoClaim() {
  const { ipcRenderer } = require("electron");
  if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
    return ipcRenderer.invoke("stats:auto-claim");
  }
  return Promise.resolve({ ok: false, reason: "ipc-unavailable" });
}

function defaultAutoRelease(date) {
  const { ipcRenderer } = require("electron");
  if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
    return ipcRenderer.invoke("stats:auto-release", { date });
  }
  return Promise.resolve({ ok: false, reason: "ipc-unavailable" });
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
    autoClaim = defaultAutoClaim,
    autoRelease = defaultAutoRelease,
    collect = defaultCollect,
    notify = () => {},
    now = () => Date.now(),
    monotonicNow = defaultMonotonicNow,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = CHECK_INTERVAL_MS,
    startupDelayMs = STARTUP_DELAY_MS,
    maxBusyRetries = MAX_BUSY_RETRIES,
    onRunComplete,
    emitGlobalRunComplete = false,
  } = options;

  let timer = null;
  let startedAtMono = null;
  let running = false;
  let stopped = true;
  let busyState = { date: "", count: 0 };

  function recordBusy(today) {
    const nextCount = busyState.date === today ? busyState.count + 1 : 1;
    busyState = { date: today, count: nextCount };
    return {
      ran: false,
      busy: true,
      retryCount: nextCount,
      exhausted: nextCount > maxBusyRetries,
    };
  }

  async function tick() {
    if (stopped || running) {
      return { ran: false, reason: stopped ? "stopped" : "in-flight" };
    }

    // 启动延迟改用单调时钟（performance.now），不受系统校时/回拨影响
    const delay =
      Number.isFinite(startupDelayMs) && startupDelayMs >= 0
        ? startupDelayMs
        : STARTUP_DELAY_MS;
    const elapsedMono =
      startedAtMono === null ? -1 : monotonicNow() - startedAtMono;
    if (!Number.isFinite(elapsedMono) || elapsedMono < delay) {
      return { ran: false, reason: "startup-delay" };
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
    if (
      !shouldRun({
        now: currentNow,
        settings,
        busyState,
        maxBusyRetries,
      })
    ) {
      return { ran: false, reason: "not-due" };
    }

    running = true;

    try {
      // 账号树解析失败返回 null → 不认领，继续轮询；
      // 确认为空数组 [] 才视为「无账号」，并走主进程 auto-claim 记录当天已跑
      let accounts = null;
      try {
        const list = getAccounts();
        accounts = Array.isArray(list) ? list : null;
      } catch (_) {
        accounts = null;
      }
      if (accounts === null) {
        return { ran: false, reason: "accounts-unavailable" };
      }

      // 主进程权威认领今日自动采集配额（UTC+8，单线程防多窗口与回拨重跑）
      let claimRes;
      try {
        claimRes = await autoClaim();
      } catch (err) {
        return {
          ran: false,
          reason: "claim-failed",
          error: (err && err.message) || String(err),
        };
      }

      if (!claimRes || !claimRes.ok) {
        const reason = (claimRes && claimRes.reason) || "claim-failed";
        if (reason === "already-ran") {
          busyState = { date: "", count: 0 };
          // localStorage.lastRunDate 仅作展示与快速跳过，避免覆盖更新的日期
          if (!settings.lastRunDate || settings.lastRunDate < today) {
            updateSettings({ lastRunDate: today }, storage);
          }
          return { ran: false, reason: "already-ran" };
        }
        if (reason === "busy") {
          return recordBusy(today);
        }
        // store-failed 等：不采集，避免无持久化保障时重复轰炸平台
        return { ran: false, reason };
      }

      const claimedDate = isValidDateStr(claimRes.date)
        ? claimRes.date
        : today;

      // 确认为空数组：主进程已通过 auto-claim 记录当天已跑，不调 collect、不弹窗
      if (!accounts.length) {
        updateSettings({ lastRunDate: claimedDate }, storage);
        busyState = { date: "", count: 0 };
        return { ran: true, skippedEmpty: true, date: claimedDate };
      }

      let res;
      try {
        res = await collect(accounts);
      } catch (err) {
        const message = (err && err.message) || String(err) || "采集异常";
        updateSettings({ lastRunDate: claimedDate }, storage);
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
        return { ran: true, error: message, date: claimedDate };
      }

      if (isBusyError(res)) {
        // 仅本次认领后采集 IPC 返回 busy 时，同步释放本次认领日期
        try {
          await autoRelease(claimedDate);
        } catch (_) {
          /* 释放失败不阻塞状态复位 */
        }
        return recordBusy(today);
      }

      updateSettings({ lastRunDate: claimedDate }, storage);
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
      return { ran: true, result: res, date: claimedDate };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer !== null) return;
    stopped = false;
    startedAtMono = monotonicNow();
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
      startedAtMono,
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
  isMainWindowLocation,
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
