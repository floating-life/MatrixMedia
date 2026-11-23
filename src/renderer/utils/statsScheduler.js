/**
 * 定时自动采集调度器（渲染层）：
 * - 支持两种模式：
 *   - daily：每日定点一次（沿用 S3 全部语义，兼容旧配置 { enabled, time, lastRunDate }）
 *   - interval：固定时段 [startTime, endTime] 内每 intervalHours（1/2/3/4/6）小时采集一个槽
 *     - endTime < startTime 视为跨零点，槽日期按槽开始时刻的 UTC+8 日历日
 *     - 到达某槽（当前时刻 >= 槽时刻 且 < 下一槽时刻）且该槽未跑过 → 调 stats:auto-run { accounts, slot: "YYYY-MM-DD HH:mm" }
 *     - 电脑休眠/关机漏掉或 busy 拖过下一槽时刻的旧槽直接放弃不补采
 * - 设置保存在 localStorage "statsAutoCollect"：
 *   { enabled, mode, startTime, endTime, intervalHours, time, retentionDays, lastRunDate, lastRunSlot }
 *   其中 lastRunDate / lastRunSlot 仅作界面展示，不参与跳过判定；权威防重裁决在主进程 stats:auto-run
 * - 启动后用单调时钟（performance.now）延迟 2 分钟，之后每 60s 轮询一次
 */

export const STORAGE_KEY = "statsAutoCollect";
export const CHECK_INTERVAL_MS = 60 * 1000;
export const STARTUP_DELAY_MS = 2 * 60 * 1000;
export const END_SLOT_GRACE_MS = 5 * 60 * 1000;
export const VALID_INTERVAL_HOURS = Object.freeze([1, 2, 3, 4, 6]);
export const DEFAULT_RETENTION_DAYS = 60;

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  mode: "daily",
  startTime: "08:00",
  endTime: "22:00",
  intervalHours: 2,
  time: "10:00",
  retentionDays: DEFAULT_RETENTION_DAYS,
  lastRunDate: "",
  lastRunSlot: "",
});

const UTC8_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const END_TIME_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLOT_RE = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
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

export function isValidEndTimeStr(time) {
  return typeof time === "string" && END_TIME_RE.test(time);
}

export function parseTimeToMinutes(time) {
  if (typeof time !== "string") return null;
  const match = TIME_RE.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function parseEndTimeToMinutes(time) {
  if (typeof time !== "string") return null;
  if (time === "24:00") return 1440;
  return parseTimeToMinutes(time);
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

export function isValidSlotStr(slot) {
  if (typeof slot !== "string") return false;
  const match = SLOT_RE.exec(slot);
  if (!match) return false;
  return isValidDateStr(match[1]);
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

/** UTC+8 日期格式化为 YYYY-MM-DD；非法时间返回空串 */
export function formatUtc8Date(now) {
  const dt = now instanceof Date ? now : new Date(now);
  const ms = dt.getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + UTC8_MS).toISOString().slice(0, 10);
}

/** 解析 UTC+8 日历日 YYYY-MM-DD 零点对应的真实 UTC 毫秒时间戳 */
function utc8DayStartMs(ymd) {
  if (!isValidDateStr(ymd)) return null;
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d) - UTC8_MS;
}

function shiftUtc8Date(ymd, deltaDays) {
  const start = utc8DayStartMs(ymd);
  if (start === null) return "";
  return formatUtc8Date(start + deltaDays * DAY_MS);
}

function normalizeIntervalHours(val) {
  const n = typeof val === "number" ? val : Number(val);
  if (Number.isInteger(n) && VALID_INTERVAL_HOURS.includes(n)) {
    return n;
  }
  return DEFAULT_SETTINGS.intervalHours;
}

function normalizeRetentionDays(val) {
  const n = typeof val === "number" ? val : Number(val);
  if (Number.isInteger(n) && n >= 1 && n <= 3650) {
    return n;
  }
  return DEFAULT_RETENTION_DAYS;
}

/**
 * 清洗配置对象，任何坏数据均回落到对应默认值。
 * 旧设置 { enabled, time } 不含 mode 字段时自动迁移为 mode="daily"（不擅自加大采集频率）。
 */
export function normalizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const mode = raw.mode === "interval" ? "interval" : "daily";
  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled,
    mode,
    startTime: isValidTimeStr(raw.startTime)
      ? raw.startTime
      : DEFAULT_SETTINGS.startTime,
    endTime: isValidEndTimeStr(raw.endTime) ? raw.endTime : DEFAULT_SETTINGS.endTime,
    intervalHours: normalizeIntervalHours(raw.intervalHours),
    time: isValidTimeStr(raw.time) ? raw.time : DEFAULT_SETTINGS.time,
    retentionDays: normalizeRetentionDays(raw.retentionDays),
    lastRunDate: isValidDateStr(raw.lastRunDate) ? raw.lastRunDate : "",
    lastRunSlot: isValidSlotStr(raw.lastRunSlot) ? raw.lastRunSlot : "",
  };
}

/**
 * 计算以指定 UTC+8 日历日 baseDate 为起点的固定时段内所有槽：
 * - 从 startTime 起每 intervalHours 小时一个槽，若 endTime 恰好落在槽上则包含 endTime
 * - endTime === "24:00"（1440 分钟）视为排他末端：不额外生成 24:00 / 次日 00:00 槽，末槽窗口截止到次日 00:00
 * - endTime < startTime 视为跨零点（延续到次日 endTime），每个槽的日期按槽开始时刻的 UTC+8 日历日
 * - 非末槽有效窗口为 [startMs, 下一槽开始)
 * - 末槽有效窗口截断到 endTime（[lastSlotStart, endTime)）；若 endTime (<24:00) 恰为槽时刻，该槽有效窗口为 [endTime, endTime + END_SLOT_GRACE_MS(5分钟))
 */
export function buildScheduleSlots(baseDate, settings) {
  const baseStartMs = utc8DayStartMs(baseDate);
  if (baseStartMs === null) return [];
  const cfg = normalizeSettings(settings);
  const startMin = parseTimeToMinutes(cfg.startTime);
  const endMin = parseEndTimeToMinutes(cfg.endTime);
  if (startMin === null || endMin === null) return [];

  const isExclusiveEnd = endMin === 1440;
  const stepMin = cfg.intervalHours * 60;
  const spanMin = endMin < startMin ? endMin + 1440 - startMin : endMin - startMin;
  const windowEndMs = baseStartMs + (startMin + spanMin) * 60000;
  const slots = [];

  for (
    let offsetMin = 0;
    isExclusiveEnd ? offsetMin < spanMin : offsetMin <= spanMin;
    offsetMin += stepMin
  ) {
    const startMs = baseStartMs + (startMin + offsetMin) * 60000;
    const isLastSlot = isExclusiveEnd
      ? offsetMin + stepMin >= spanMin
      : offsetMin + stepMin > spanMin;
    let endMs;
    if (!isLastSlot) {
      endMs = startMs + stepMin * 60000;
    } else if (!isExclusiveEnd && startMs === windowEndMs) {
      endMs = windowEndMs + END_SLOT_GRACE_MS;
    } else {
      endMs = windowEndMs;
    }
    const shifted = new Date(startMs + UTC8_MS);
    const date = shifted.toISOString().slice(0, 10);
    const time = shifted.toISOString().slice(11, 16);
    slots.push({
      slot: `${date} ${time}`,
      date,
      time,
      startMs,
      endMs,
    });
  }
  return slots;
}

/**
 * 纯函数：在 interval 模式下计算 now 时刻所属的当前活动槽（满足 startMs <= now < endMs）。
 * 若未启用、非 interval 模式或当前时刻不在任何槽窗口内，返回 null。
 */
export function getCurrentSlot(now, settings) {
  const dt = now instanceof Date ? now : new Date(now);
  const nowMs = dt.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const cfg = normalizeSettings(settings);
  if (!cfg.enabled || cfg.mode !== "interval") return null;

  const todayUtc8 = formatUtc8Date(nowMs);
  if (!todayUtc8) return null;
  const yesterdayUtc8 = shiftUtc8Date(todayUtc8, -1);

  for (const baseDate of [yesterdayUtc8, todayUtc8]) {
    if (!baseDate) continue;
    const slots = buildScheduleSlots(baseDate, cfg);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (nowMs >= s.startMs && nowMs < s.endMs) {
        return s;
      }
    }
  }
  return null;
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

/**
 * 纯函数：判断本轮是否应向主进程发起自动采集。
 * - daily 模式：基于本地时间与内存 doneLocalDate（与 S3 完全一致）
 * - interval 模式：基于 UTC+8 时段槽与内存 doneSlot
 */
export function shouldRun({ now, settings, doneLocalDate = "", doneSlot = "" } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(dt.getTime())) return false;
  const cfg = normalizeSettings(settings);
  if (!cfg.enabled) return false;

  if (cfg.mode === "interval") {
    const active = getCurrentSlot(dt, cfg);
    return Boolean(active && doneSlot !== active.slot);
  }

  const localDate = formatLocalDate(dt);
  if (!localDate || doneLocalDate === localDate) return false;
  const targetMinutes = parseTimeToMinutes(cfg.time);
  if (targetMinutes === null) return false;
  return dt.getHours() * 60 + dt.getMinutes() >= targetMinutes;
}

/** 组装完成后的 Element UI $notify 参数 */
export function buildNotifyPayload(res) {
  const slotSuffix =
    res && typeof res.slot === "string" && isValidSlotStr(res.slot)
      ? `（${res.slot.slice(11, 16)}）`
      : "";
  const prefix = slotSuffix ? "定时自动采集" : "每日自动采集";

  if (res && typeof res.error === "string" && res.error) {
    return {
      title: `${prefix}失败${slotSuffix}`,
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
      title: `${prefix}已取消${slotSuffix}`,
      message: `${countText}，详情请查看「拉取记录」`,
      type: "info",
      duration: 6000,
    };
  }
  if (failCount > 0) {
    return {
      title: `${prefix}完成${slotSuffix}`,
      message: `${countText}，详情请查看「拉取记录」`,
      type: "warning",
      duration: 6000,
    };
  }
  return {
    title: `${prefix}完成${slotSuffix}`,
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
 * 将自动采集与保留期设置异步同步到主进程持久化文件（纯 Node 无 Electron 环境安全跳过）。
 */
export function syncSettingsToMain(settings, options = {}) {
  try {
    const { ipcRenderer } = require("electron");
    if (!ipcRenderer || typeof ipcRenderer.invoke !== "function") {
      return Promise.resolve(null);
    }
    const normalized = normalizeSettings(settings);
    const payload = {
      enabled: normalized.enabled,
      mode: normalized.mode,
      startTime: normalized.startTime,
      endTime: normalized.endTime,
      intervalHours: normalized.intervalHours,
      time: normalized.time,
      retentionDays: normalized.retentionDays,
    };
    if (options && options.initOnly) {
      payload.initOnly = true;
    }
    return Promise.resolve(ipcRenderer.invoke("stats:save-auto-settings", payload)).catch(
      () => null
    );
  } catch (_) {
    return Promise.resolve(null);
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

const UPDATABLE_SETTINGS_KEYS = [
  "enabled",
  "mode",
  "startTime",
  "endTime",
  "intervalHours",
  "time",
  "retentionDays",
  "lastRunDate",
  "lastRunSlot",
];

export function updateSettings(patch, storage = getDefaultStorage()) {
  const merged = { ...loadSettings(storage) };
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    for (const key of UPDATABLE_SETTINGS_KEYS) {
      if (patch[key] !== undefined) merged[key] = patch[key];
    }
  }
  return saveSettings(merged, storage);
}

function defaultGetAccounts() {
  const { buildCollectAccounts } = require("./statsApi");
  return buildCollectAccounts();
}

function defaultAutoRun(accounts, meta) {
  const { ipcRenderer } = require("electron");
  if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
    const payload = { accounts };
    if (meta && typeof meta.slot === "string" && meta.slot) {
      payload.slot = meta.slot;
    }
    if (meta && Number.isFinite(meta.slotEndMs)) {
      payload.slotEndMs = meta.slotEndMs;
    }
    if (meta && Number.isInteger(meta.intervalHours) && meta.intervalHours > 0) {
      payload.intervalHours = meta.intervalHours;
    }
    if (meta && typeof meta.startTime === "string" && isValidTimeStr(meta.startTime)) {
      payload.startTime = meta.startTime;
    }
    if (meta && typeof meta.endTime === "string" && isValidEndTimeStr(meta.endTime)) {
      payload.endTime = meta.endTime;
    }
    return ipcRenderer.invoke("stats:auto-run", payload);
  }
  return Promise.reject(new Error("ipcRenderer 不可用"));
}

function buildIntervalScheduleSig(cfg) {
  return `${cfg.enabled ? 1 : 0}|${cfg.mode}|${cfg.startTime}|${cfg.endTime}|${cfg.intervalHours}`;
}

/** 创建可测试、可依赖注入的定时自动采集调度器实例 */
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
  let doneSlot = "";
  let lastScheduleSig = "";
  let lastScheduleEnabled = false;
  let scheduleChangedAtMs = 0;

  function syncObservedSettings(cfg, currentNowMs, isInitial = false) {
    const sig = buildIntervalScheduleSig(cfg);
    if (isInitial || !lastScheduleSig) {
      lastScheduleSig = sig;
      lastScheduleEnabled = Boolean(cfg.enabled);
      return;
    }
    if (sig !== lastScheduleSig) {
      const wasDisabled = !lastScheduleEnabled;
      const turnedOffOnly = !cfg.enabled;
      lastScheduleSig = sig;
      lastScheduleEnabled = Boolean(cfg.enabled);
      // 启用态切换或 interval 调度参数变更时记录变更时刻：不立即补跑已开始的更早槽
      if (!turnedOffOnly && (cfg.mode === "interval" || wasDisabled)) {
        const ts = currentNowMs instanceof Date ? currentNowMs.getTime() : Number(currentNowMs);
        if (Number.isFinite(ts)) {
          scheduleChangedAtMs = ts;
        }
        doneSlot = "";
      }
    }
  }

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
    syncObservedSettings(settings, currentNow, false);
    const isInterval = settings.mode === "interval";
    const activeSlot = isInterval ? getCurrentSlot(currentNow, settings) : null;

    if (
      isInterval &&
      activeSlot &&
      scheduleChangedAtMs > 0 &&
      activeSlot.startMs < scheduleChangedAtMs
    ) {
      return { ran: false, reason: "before-settings-change", slot: activeSlot.slot };
    }

    if (!shouldRun({ now: currentNow, settings, doneLocalDate, doneSlot })) {
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

      const runMeta = isInterval
        ? {
            mode: "interval",
            slot: activeSlot.slot,
            slotStartMs: activeSlot.startMs,
            slotEndMs: activeSlot.endMs,
            intervalHours: settings.intervalHours,
            startTime: settings.startTime,
            endTime: settings.endTime,
          }
        : {
            mode: "daily",
          };

      let res;
      try {
        res = await autoRun(accounts, runMeta);
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
      if (isInterval && (res.status === "skipped" || res.status === "rate-limited")) {
        doneSlot = activeSlot.slot;
        return {
          ran: false,
          reason: res.reason || res.status,
          slot: activeSlot.slot,
        };
      }
      if (res.status !== "done" && res.status !== "already-ran") {
        return { ran: false, reason: res.status || "unknown" };
      }

      if (isInterval) {
        doneSlot = activeSlot.slot;
        const displaySlot = isValidSlotStr(res.slot) ? res.slot : activeSlot.slot;
        const displayDate = isValidDateStr(res.date)
          ? res.date
          : displaySlot.slice(0, 10);
        const cur = loadSettings(storage);
        if (cur.lastRunDate !== displayDate || cur.lastRunSlot !== displaySlot) {
          updateSettings(
            { lastRunDate: displayDate, lastRunSlot: displaySlot },
            storage
          );
        }
        if (res.status === "already-ran") {
          return {
            ran: false,
            reason: "already-ran",
            date: displayDate,
            slot: displaySlot,
          };
        }
        if (!stopped) {
          if (typeof notify === "function") {
            try {
              notify(buildNotifyPayload({ ...res, slot: displaySlot }));
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
        return { ran: true, result: res, date: displayDate, slot: displaySlot };
      }

      doneLocalDate = localDate;
      const displayDate = isValidDateStr(res.date) ? res.date : "";
      const cur = loadSettings(storage);
      if (
        (displayDate && cur.lastRunDate !== displayDate) ||
        (displayDate && cur.lastRunSlot !== "")
      ) {
        updateSettings({ lastRunDate: displayDate, lastRunSlot: "" }, storage);
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
    syncObservedSettings(loadSettings(storage), now(), true);
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
    return { running, stopped, startedAtMono, doneLocalDate, doneSlot, scheduleChangedAtMs };
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
  END_SLOT_GRACE_MS,
  VALID_INTERVAL_HOURS,
  DEFAULT_RETENTION_DAYS,
  isValidTimeStr,
  isValidEndTimeStr,
  parseTimeToMinutes,
  parseEndTimeToMinutes,
  isValidDateStr,
  isValidSlotStr,
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
  syncSettingsToMain,
  subscribeSettings,
  subscribeRunComplete,
  createStatsScheduler,
  start,
  stop,
};
