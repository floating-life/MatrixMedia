/**
 * 每日定时自动采集调度器（渲染层）：
 * - 设置保存在 localStorage "statsAutoCollect"：{ enabled, time, lastRunDate }
 *   其中 lastRunDate 仅作界面展示，不参与跳过判定；「每天只跑一次」的权威判定在主进程 stats:auto-run
 * - 启动后用单调时钟（performance.now）延迟 2 分钟，之后每 60s 轮询一次
 * - enabled 且本地时间 >= time 且内存标记 doneLocalDate !== 本地日期时，组装账号并调用 stats:auto-run：
 *   - "done" / "already-ran" → doneLocalDate = 本地日期，更新显示用 lastRunDate；done 时 $notify
 *   - "busy" 或 IPC 异常 → 不设标记，下一分钟继续重试
 */

export const STORAGE_KEY = "statsAutoCollect";
export const CHECK_INTERVAL_MS = 60 * 1000;
export const STARTUP_DELAY_MS = 2 * 60 * 1000;

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
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function isValidDateStr(date) {
  if (typeof date !== "string") return false;
  const match = DATE_RE.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
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

/** 判断当前渲染器的 location 是否为主窗口页面（排除登录窗、加载窗及子窗口） */
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
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return false;
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

/** 纯函数：基于本地时间与内存 doneLocalDate 判断本轮是否应向主进程发起自动采集 */
export function shouldRun({ now, settings, doneLocalDate = "" } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(dt.getTime())) return false;
  const cfg = normalizeSettings(settings);
  if (!cfg.enabled) return false;
  const localDate = formatLocalDate(dt);
  if (!localDate || doneLocalDate === localDate) return false;
  const targetMinutes = parseTimeToMinutes(cfg.time);
  if (targetMinutes === null) return false;
  return dt.getHours() * 60 + dt.getMinutes() >= targetMinutes;
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
  return typeof performance !== "undefined" &&
    performance &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function emitListeners(set, arg) {
  for (const fn of [...set]) {
    try {
      fn(arg);
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
    return raw ? normalizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 保存配置到 localStorage。
 * 返回 { ok: true, settings } 或 { ok: false, settings: 当前有效配置, error }。
 */
export function saveSettings(settings, storage = getDefaultStorage()) {
  const normalized = normalizeSettings(settings);
  if (!storage || typeof storage.setItem !== "function") {
    return { ok: false, settings: loadSettings(storage), error: "本地存储不可用" };
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
    emitListeners(settingsListeners, { ...normalized });
  }
  return { ok: true, settings: normalized };
}

export function updateSettings(patch, storage = getDefaultStorage()) {
  const merged = { ...loadSettings(storage) };
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const key of ["enabled", "time", "lastRunDate"]) {
      if (patch[key] !== undefined) merged[key] = patch[key];
    }
  }
  return saveSettings(merged, storage);
}

function defaultGetAccounts() {
  const { buildCollectAccounts } = require("./statsApi");
  return buildCollectAccounts();
}

function defaultAutoRun(accounts) {
  const { ipcRenderer } = require("electron");
  if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
    return ipcRenderer.invoke("stats:auto-run", { accounts });
  }
  return Promise.reject(new Error("ipcRenderer 不可用"));
}

/** 创建可测试、可依赖注入的每日自动采集调度器实例 */
export function createStatsScheduler(options = {}) {
  const {
    storage,
    getAccounts = defaultGetAccounts,
    autoRun = defaultAutoRun,
    notify = () => {},
    now = () => Date.now(),
    monotonicNow = defaultMonotonicNow,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    checkIntervalMs = CHECK_INTERVAL_MS,
    startupDelayMs = STARTUP_DELAY_MS,
    onRunComplete,
    emitGlobalRunComplete = false,
  } = options;

  let timer = null;
  let startedAtMono = null;
  let running = false;
  let stopped = true;
  let doneLocalDate = "";

  async function tick() {
    if (stopped || running) {
      return { ran: false, reason: stopped ? "stopped" : "in-flight" };
    }

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
    const localDate = formatLocalDate(currentNow);
    if (!localDate) {
      return { ran: false, reason: "invalid-date" };
    }

    const settings = loadSettings(storage);
    if (!shouldRun({ now: currentNow, settings, doneLocalDate })) {
      return { ran: false, reason: "not-due" };
    }

    running = true;
    try {
      let accounts = null;
      try {
        const list = getAccounts();
        accounts = Array.isArray(list) && list.length > 0 ? list : null;
      } catch (_) {
        accounts = null;
      }
      if (!accounts) {
        return { ran: false, reason: "no-accounts" };
      }

      let res;
      try {
        res = await autoRun(accounts);
      } catch (err) {
        return {
          ran: false,
          reason: "ipc-error",
          error: (err && err.message) || String(err),
        };
      }

      if (!res || typeof res !== "object") {
        return { ran: false, reason: "invalid-response" };
      }
      if (res.status === "busy") {
        return { ran: false, reason: "busy" };
      }
      if (res.status !== "done" && res.status !== "already-ran") {
        return { ran: false, reason: res.status || "unknown" };
      }

      doneLocalDate = localDate;
      const displayDate = isValidDateStr(res.date) ? res.date : "";
      if (displayDate && loadSettings(storage).lastRunDate !== displayDate) {
        updateSettings({ lastRunDate: displayDate }, storage);
      }

      if (res.status === "already-ran") {
        return { ran: false, reason: "already-ran", date: displayDate };
      }

      if (!stopped) {
        if (typeof notify === "function") {
          try {
            notify(buildNotifyPayload(res));
          } catch (_) {}
        }
        if (typeof onRunComplete === "function") {
          try {
            onRunComplete(res);
          } catch (_) {}
        }
        if (emitGlobalRunComplete) {
          emitListeners(runCompleteListeners, res);
        }
      }
      return { ran: true, result: res, date: displayDate };
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
    return { running, stopped, startedAtMono, doneLocalDate };
  }

  return { start, stop, tick, getState };
}

let defaultScheduler = null;

export function start(options = {}) {
  if (defaultScheduler) defaultScheduler.stop();
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
  formatLocalDate,
  normalizeSettings,
  isMainWindowLocation,
  shouldRun,
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
