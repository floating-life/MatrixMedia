"use strict";

/**
 * 数据统计 IPC 入口。
 *
 * - stats:collect       采集一组账号（串行队列，账号间间隔防风控），进度经 stats:progress 推送
 * - stats:get-data      读取单账号本地数据（daily + works + meta）
 * - stats:get-overview  全账号按日聚合（所有账号总览页）
 *
 * 采集全程使用平台页面上下文 fetch（复用分组 partition 登录态），不做任何签名构造。
 */

const { ipcMain } = require("electron");
const { collectAccount } = require("./collector");
const store = require("./store");
const { normalizeStatusTitle, buildTitleIndex } = require("./contentLink");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_TRIGGERS = new Set(["auto", "manual"]);
const AUTO_RUN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let collecting = false;
let cancelled = false;

/** 判断账号今日（UTC+8）是否已成功采集过（lastError 为空） */
function getTodaySucceededMeta(acc, today) {
  if (!acc || !today) return null;
  let data;
  try {
    data = store.readAccount(acc.group, acc.platform);
  } catch (_) {
    return null;
  }
  const meta = data && data.meta;
  if (!meta || typeof meta !== "object") return null;
  const lastCollectAt = Number(meta.lastCollectAt);
  if (!Number.isFinite(lastCollectAt) || lastCollectAt <= 0) return null;
  const lastError = meta.lastError;
  if (
    lastError !== undefined &&
    lastError !== null &&
    String(lastError).trim() !== ""
  ) {
    return null;
  }
  if (store.todayStr(lastCollectAt) !== today) return null;
  return meta;
}

async function collectAccounts(accounts, sender, options = {}) {
  const results = [];
  const total = accounts.length;
  const startedAt = Date.now();
  const isAuto = Boolean(options && options.trigger === "auto");
  const today = isAuto ? store.todayStr(startedAt) : "";
  let hasCollectedAny = false;

  for (let i = 0; i < total; i++) {
    if (cancelled) break;
    const acc = accounts[i];
    const progress = (status, extra = {}) => {
      try {
        sender.send("stats:progress", {
          index: i,
          total,
          group: acc.group,
          platform: acc.platform,
          status,
          ...extra,
        });
      } catch (_) {
        /* 窗口可能已关闭 */
      }
    };

    if (isAuto) {
      const succeededMeta = getTodaySucceededMeta(acc, today);
      if (succeededMeta) {
        const workCount = Number(succeededMeta.workCount);
        results.push({
          group: acc.group,
          platform: acc.platform,
          success: true,
          skipped: true,
          workCount: Number.isFinite(workCount) ? workCount : 0,
        });
        progress("skipped");
        continue;
      }
    }

    if (hasCollectedAny) {
      await sleep(2000); // 账号间间隔
      if (cancelled) break;
    }
    hasCollectedAny = true;

    progress("running");
    try {
      const data = await collectAccount({
        partition: acc.partition,
        platform: acc.platform,
      });
      store.mergeDaily(acc.group, acc.platform, data.overview, data.fansHistory);
      store.mergeWorks(acc.group, acc.platform, data.works);
      store.writeMeta(acc.group, acc.platform, {
        lastCollectAt: Date.now(),
        lastError: "",
        workCount: data.works.length,
      });
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        workCount: data.works.length,
      });
      progress("success");
    } catch (err) {
      const message = (err && err.message) || String(err);
      store.writeMeta(acc.group, acc.platform, {
        lastCollectAt: Date.now(),
        lastError: message,
      });
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: false,
        error: message,
      });
      progress("failed", { error: message });
    }
  }
  // 任务日志落盘（拉取记录弹窗用）
  const logEntry = {
    startedAt,
    finishedAt: Date.now(),
    cancelled,
    results,
  };
  if (options && VALID_TRIGGERS.has(options.trigger)) {
    logEntry.trigger = options.trigger;
  }
  store.appendCollectLog(logEntry);
  return { results, cancelled };
}

function registerDataStatsIpc() {
  ipcMain.handle("stats:collect", async (event, args) => {
    if (collecting) {
      return { results: [], error: "已有采集任务进行中" };
    }
    const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
    if (!accounts.length) return { results: [], error: "没有可采集的账号" };
    const trigger =
      args && VALID_TRIGGERS.has(args.trigger) ? args.trigger : undefined;
    collecting = true;
    cancelled = false;
    try {
      return await collectAccounts(accounts, event.sender, { trigger });
    } finally {
      collecting = false;
    }
  });

  ipcMain.handle("stats:cancel", async () => {
    cancelled = true;
    return { ok: true };
  });

  ipcMain.handle("stats:get-data", async (_event, args) => {
    const { group, platform } = args || {};
    return store.readAccount(group, platform);
  });

  ipcMain.handle("stats:get-overview", async () => {
    return store.readOverview();
  });

  ipcMain.handle("stats:get-logs", async () => {
    return store.readCollectLogs();
  });

  /**
   * 每日自动采集权威认领（主进程单线程同步读/判/写，防多窗口与时钟回拨重跑）：
   * - 日期统一由主进程用 store.todayStr()（UTC+8）计算，忽略渲染层传值
   * - 今日已在 auto-run.json 中 → { ok: false, reason: "already-ran" }
   * - 当前 collecting 中 → { ok: false, reason: "busy" }（不写入）
   * - 否则原子写入今日（保留最近 14 个日期）；读写失败 → { ok: false, reason: "store-failed" }
   */
  ipcMain.handle("stats:auto-claim", async () => {
    const date = store.todayStr();
    let runs;
    try {
      runs = store.readAutoRuns();
    } catch (err) {
      console.warn(
        "[dataStats] 读取 auto-run.json 失败:",
        (err && err.message) || err
      );
      return { ok: false, reason: "store-failed" };
    }
    if (runs.includes(date)) {
      return { ok: false, reason: "already-ran" };
    }
    if (collecting) {
      return { ok: false, reason: "busy" };
    }
    try {
      store.writeAutoRuns([...runs, date]);
    } catch (err) {
      console.warn(
        "[dataStats] 写入 auto-run.json 失败:",
        (err && err.message) || err
      );
      return { ok: false, reason: "store-failed" };
    }
    return { ok: true, date };
  });

  /**
   * 仅当本次认领后紧接着调用 stats:collect 返回 busy 时调用，同步移除该日期。
   */
  ipcMain.handle("stats:auto-release", async (_event, args) => {
    const date = args && typeof args.date === "string" ? args.date : "";
    if (!AUTO_RUN_DATE_RE.test(date)) {
      return { ok: false, reason: "invalid-date" };
    }
    let runs;
    try {
      runs = store.readAutoRuns();
    } catch (err) {
      console.warn(
        "[dataStats] 释放 auto-run 读取失败:",
        (err && err.message) || err
      );
      return { ok: false, reason: "store-failed" };
    }
    const next = runs.filter((d) => d !== date);
    if (next.length === runs.length) {
      return { ok: true, released: false };
    }
    try {
      store.writeAutoRuns(next);
    } catch (err) {
      console.warn(
        "[dataStats] 释放 auto-run 写入失败:",
        (err && err.message) || err
      );
      return { ok: false, reason: "store-failed" };
    }
    return { ok: true, released: true };
  });

  /**
   * 发布状态匹配（视频管理「获取状态」）：
   * 输入若干条发布记录，按「分组 × 平台」聚合后各跑一次采集，
   * 在作品列表里按标题匹配——命中即说明发布成功，返回作品链接。
   * 与 stats:collect 共享 collecting 互斥锁，避免并发打开同分区采集窗口。
   *
   * @param {Array<{key, group, platform, partition, title}>} args.tasks
   * @returns {{ matches: Record<string, {found: boolean, url?: string, workId?: string}>, errors: Array, busy?: boolean }}
   */
  ipcMain.handle("stats:match-works", async (_event, args) => {
    if (collecting) {
      return {
        matches: {},
        errors: [{ error: "已有采集任务进行中" }],
        busy: true,
      };
    }
    const tasks = Array.isArray(args && args.tasks) ? args.tasks : [];
    const matches = {};
    const errors = [];
    // 按平台聚合，每平台只采集一次（顺带写入本地快照，数据页同步受益）
    const groupsMap = new Map();
    for (const t of tasks) {
      if (!t || !t.partition || !t.platform || !t.key) continue;
      const gk = `${t.partition}`;
      if (!groupsMap.has(gk)) {
        groupsMap.set(gk, {
          partition: t.partition,
          platform: t.platform,
          group: t.group || "",
          tasks: [],
        });
      }
      groupsMap.get(gk).tasks.push(t);
    }

    collecting = true;
    try {
      const entries = [...groupsMap.values()];
      for (let i = 0; i < entries.length; i++) {
        const { partition, platform, group, tasks: groupTasks } = entries[i];
        try {
          const data = await collectAccount({ partition, platform });
          // 顺带落库（与「同步数据」同效果）
          store.mergeDaily(group, platform, data.overview, data.fansHistory);
          store.mergeWorks(group, platform, data.works);
          store.writeMeta(group, platform, {
            lastCollectAt: Date.now(),
            lastError: "",
            workCount: data.works.length,
          });
          const byTitle = buildTitleIndex(data.works, normalizeStatusTitle);
          for (const t of groupTasks) {
            const key = normalizeStatusTitle(t.title);
            const entry = key ? byTitle.get(key) : null;
            if (entry && entry.ambiguous) {
              matches[t.key] = { found: false, ambiguous: true };
            } else if (entry && entry.work) {
              matches[t.key] = {
                found: true,
                url: entry.work.url || "",
                workId: entry.work.workId,
              };
            } else {
              matches[t.key] = { found: false };
            }
          }
        } catch (err) {
          const message = (err && err.message) || String(err);
          errors.push({ group, platform, error: message });
          for (const t of groupTasks) {
            matches[t.key] = { found: false, error: message };
          }
        }
        if (i < entries.length - 1) await sleep(2000); // 平台间间隔
      }
      return { matches, errors };
    } finally {
      collecting = false;
    }
  });
}

module.exports = { registerDataStatsIpc };
