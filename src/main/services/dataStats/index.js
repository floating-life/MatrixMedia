"use strict";

/**
 * 数据统计 IPC 入口。
 *
 * - stats:collect       采集一组账号（串行队列，账号间间隔防风控），进度经 stats:progress 推送
 * - stats:auto-run      每日定时自动采集单一操作（检查 auto-run.json → 互斥 → 采集 → 落盘日期）
 * - stats:get-data      读取单账号本地数据（daily + works + meta）
 * - stats:get-overview  全账号按日聚合（所有账号总览页）
 * - stats:match-works   发布状态匹配（与采集共享 collecting 互斥锁）
 *
 * 采集全程使用平台页面上下文 fetch（复用分组 partition 登录态），不做任何签名构造。
 */

const { ipcMain } = require("electron");
const { collectAccount } = require("./collector");
const store = require("./store");
const { normalizeStatusTitle, buildTitleIndex } = require("./contentLink");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VALID_TRIGGERS = new Set(["auto", "manual"]);

let collecting = false;
let cancelled = false;
let collectedToday = { date: "", partitions: new Set() };
// auto-run.json 读写失败时的兜底：本进程内已自动跑过的日期（防止持久化失败导致每分钟重采）
const autoRanInMemory = new Set();

function getTodayStr(now = Date.now()) {
  if (typeof store.todayStr === "function") {
    return store.todayStr(now);
  }
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}

function normalizePartition(partition) {
  return typeof partition === "string" ? partition.trim() : "";
}

function syncCollectedToday(date) {
  if (collectedToday.date !== date) {
    collectedToday = { date, partitions: new Set() };
  }
}

function markPartitionCollected(partition, date = getTodayStr()) {
  const key = normalizePartition(partition);
  if (!key) return;
  syncCollectedToday(date);
  collectedToday.partitions.add(key);
}

function hasPartitionCollected(partition, date = getTodayStr()) {
  const key = normalizePartition(partition);
  if (!key) return false;
  syncCollectedToday(date);
  return collectedToday.partitions.has(key);
}

async function collectAccounts(accounts, sender, options = {}) {
  const results = [];
  const total = accounts.length;
  const startedAt = Date.now();
  const skipCollected = Boolean(options && options.skipCollectedToday);
  let hasCollectedAny = false;

  for (let i = 0; i < total; i++) {
    if (cancelled) break;
    const acc = accounts[i];
    if (!acc || typeof acc !== "object") continue;

    const progress = (status, extra = {}) => {
      try {
        if (sender && typeof sender.send === "function") {
          sender.send("stats:progress", {
            index: i,
            total,
            group: acc.group,
            platform: acc.platform,
            status,
            ...extra,
          });
        }
      } catch (_) {
        /* 窗口可能已关闭 */
      }
    };

    if (skipCollected && hasPartitionCollected(acc.partition)) {
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        skipped: true,
      });
      progress("skipped");
      continue;
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
      markPartitionCollected(acc.partition);
      results.push({
        group: acc.group,
        platform: acc.platform,
        success: true,
        workCount: data.works.length,
      });
      progress("success");
    } catch (err) {
      const message = (err && err.message) || String(err);
      try {
        store.writeMeta(acc.group, acc.platform, {
          lastCollectAt: Date.now(),
          lastError: message,
        });
      } catch (metaErr) {
        console.warn(
          "[dataStats] 写入失败 meta 异常:",
          (metaErr && metaErr.message) || metaErr
        );
      }
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
  try {
    store.appendCollectLog(logEntry);
  } catch (err) {
    console.warn(
      "[dataStats] 写入采集日志失败:",
      (err && err.message) || err
    );
  }
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
      return await collectAccounts(accounts, event && event.sender, { trigger });
    } finally {
      collecting = false;
    }
  });

  /**
   * 每日自动采集单一操作（认领与采集合并）：
   * - today = store.todayStr()（UTC+8，由主进程计算）
   * - auto-run.json 已含 today → 立即返回 { status: "already-ran", date: today }
   * - collecting 中 → 返回 { status: "busy" }，不写入任何内容
   * - 否则同步置位 collecting=true，执行采集（复用 collectAccounts，trigger:"auto"），
   *   结束（无论成功/部分失败/取消/异常）后原子追加 today 到 runs（写失败仅 warn）并复位 collecting
   */
  ipcMain.handle("stats:auto-run", async (event, args) => {
    const today = getTodayStr();
    if (autoRanInMemory.has(today)) {
      return { status: "already-ran", date: today };
    }
    let runs = [];
    try {
      runs = store.readAutoRuns();
    } catch (err) {
      // 读失败不冒险开跑：当作忙，下一轮再试
      console.warn("[dataStats] 读取 auto-run.json 失败:", (err && err.message) || err);
      return { status: "busy" };
    }
    if (runs.includes(today)) {
      autoRanInMemory.add(today);
      return { status: "already-ran", date: today };
    }
    if (collecting) {
      return { status: "busy" };
    }
    const accounts = Array.isArray(args && args.accounts) ? args.accounts : [];
    if (!accounts.length) {
      return { status: "empty", date: today, results: [] };
    }
    collecting = true;
    cancelled = false;
    try {
      const out = await collectAccounts(accounts, event && event.sender, {
        trigger: "auto",
        skipCollectedToday: true,
      });
      return {
        status: "done",
        date: today,
        results: out.results,
        cancelled: Boolean(out.cancelled),
      };
    } finally {
      autoRanInMemory.add(today);
      try {
        store.appendAutoRun(today);
      } catch (err) {
        console.warn(
          "[dataStats] 写入 auto-run.json 失败:",
          (err && err.message) || err
        );
      }
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
   * 发布状态匹配（视频管理「获取状态」）：
   * 输入若干条发布记录，按「分组 × 平台」聚合后各跑一次采集，
   * 在作品列表里按标题匹配——命中即说明发布成功，返回作品链接。
   * 与 stats:collect / stats:auto-run 共享 collecting 互斥锁，避免并发打开同分区采集窗口。
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
    // 按规范化 partition 聚合，每分区只采集一次（顺带写入本地快照，数据页同步受益）
    const groupsMap = new Map();
    for (const t of tasks) {
      if (!t || !t.platform || !t.key) continue;
      const gk = normalizePartition(t.partition);
      if (!gk) continue;
      if (!groupsMap.has(gk)) {
        groupsMap.set(gk, {
          partition: gk,
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
          markPartitionCollected(partition);
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
