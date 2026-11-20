/**
 * 数据统计渲染层 API：封装主进程采集/读取 IPC。
 */
import { ipcRenderer } from "electron";
import {
  buildAccountPartitionOf,
  recordAccountKeyOf,
} from "../../shared/accountIdentity.js";

/** 不参与统计的平台（无数据接口） */
const STATS_EXCLUDED = new Set(["番茄视频", "掘金"]);

/**
 * 从 localStorage 账号树组装可采集账号列表。
 * localStorage 缺失/解析失败/结构异常或最终无有效账号时均返回 null。
 * @param {(group: string, platform: string) => boolean} [filter] 可选过滤（如只采集某分组某平台）
 * @returns {Array<{ group: string, platform: string, partition: string, accountKey: string }> | null}
 */
export function buildCollectAccounts(filter) {
  let raw;
  try {
    raw = localStorage.getItem("accountTree");
  } catch (e) {
    return null;
  }
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  let tree;
  try {
    tree = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    return null;
  }
  const accounts = [];
  const seenPartitions = new Set();
  for (const [group, node] of Object.entries(tree)) {
    if (!node || typeof node !== "object" || !Array.isArray(node.children)) {
      continue;
    }
    for (const child of node.children) {
      if (!child || typeof child !== "object") continue;
      const pt = (child.meta && child.meta.pt) || child.path;
      if (!pt || STATS_EXCLUDED.has(pt)) continue;
      if (filter && !filter(group, pt)) continue;
      // partition 按账号记录的 accountKey 拼装（与登录窗口一致，
      // 老数据回退历史 phone "-" 前缀规则）；同一平台账号跨分组共享
      // 登录态，partition 去重后只采一次
      const meta = child.meta || {};
      const partition = buildAccountPartitionOf(meta, pt);
      if (seenPartitions.has(partition)) continue;
      seenPartitions.add(partition);
      accounts.push({
        group,
        platform: pt,
        partition,
        accountKey: recordAccountKeyOf(meta),
      });
    }
  }
  return accounts.length ? accounts : null;
}

function readStoredRetentionDays() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    const raw = localStorage.getItem("statsAutoCollect");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!Object.prototype.hasOwnProperty.call(parsed, "retentionDays")) return null;
    const n = typeof parsed.retentionDays === "number" ? parsed.retentionDays : Number(parsed.retentionDays);
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : null;
  } catch (_) {
    return null;
  }
}

export function collectAccounts(accounts, options = {}) {
  const payload = { accounts };
  if (options && typeof options === "object" && !Array.isArray(options)) {
    if (typeof options.trigger === "string" && options.trigger) {
      payload.trigger = options.trigger;
    }
    const reqRetention =
      typeof options.retentionDays === "number"
        ? options.retentionDays
        : Number(options.retentionDays);
    if (Number.isInteger(reqRetention) && reqRetention >= 1 && reqRetention <= 3650) {
      payload.retentionDays = reqRetention;
    }
  }
  if (payload.retentionDays === undefined) {
    const storedRetention = readStoredRetentionDays();
    if (storedRetention !== null) {
      payload.retentionDays = storedRetention;
    }
  }
  return ipcRenderer.invoke("stats:collect", payload);
}

export function saveAutoSettings(settings) {
  return ipcRenderer.invoke("stats:save-auto-settings", settings || {});
}

export function getAutoSettings() {
  return ipcRenderer.invoke("stats:get-auto-settings");
}

export function cancelCollect() {
  return ipcRenderer.invoke("stats:cancel");
}

export function getAccountStats(group, platform) {
  return ipcRenderer.invoke("stats:get-data", { group, platform });
}

export function getOverviewStats() {
  return ipcRenderer.invoke("stats:get-overview");
}

export function getCollectLogs() {
  return ipcRenderer.invoke("stats:get-logs");
}

/** 订阅采集进度；返回取消订阅函数 */
export function onStatsProgress(handler) {
  const listener = (_event, data) => handler(data);
  ipcRenderer.on("stats:progress", listener);
  return () => ipcRenderer.removeListener("stats:progress", listener);
}
