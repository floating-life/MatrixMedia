"use strict";

import fs from "fs";
import path from "path";
import { app } from "electron";
import { changeData } from "../server/utils.js";
import { normalizeAccountRecordFields } from "../../shared/accountIdentity.js";

/**
 * 账号记录「分组新模型」一次性迁移。
 *
 * 给存量账号记录补齐 group / accountName / accountKey 三个新字段：
 *   group       = phone "-" 前缀
 *   accountName = phone "-" 后缀（无后缀 = 分组名）
 *   accountKey  = phone "-" 前缀（保证存量登录态 partition 逐字节不变）
 *
 * 顺带把数据统计目录里按历史「phone 全值」建的分组目录改名为「分组名」，
 * 保持统计历史连续（如 "主号组-皇汉科技AI" → "主号组"）。
 *
 * 每进程只执行一次（幂等：字段已存在时不改写）。在主进程启动、CLI 入口、
 * 内置服务 changeData 入口三处调用，覆盖 GUI / CLI / HTTP 三条链路。
 */

let migrated = false;

/** safeSeg 与 dataStats/store.js 保持一致 */
function safeSeg(name) {
  return String(name || "未命名").replace(/[\\/:*?"<>|]/g, "_");
}

/**
 * 数据统计目录按分组名归并（仅迁移历史「phone 全值」目录）：
 * - 当前任何账号记录已使用的 group（含带连字符的新分组名，如「赛博老司机-科普」）一律不动；
 * - 仅当目录名不是当前任何账号记录的 group，且与账号记录的历史 phone 全值格式
 *   （`<group>-<suffix>`，其中 `row.group === prefix` 且 suffix 非空）匹配时，
 *   且目标目录不存在时才归并改名；失败静默（不影响账号迁移主流程）。
 */
function migrateStatsGroupDirs(currentGroupSegs, historicalPhoneDirMap) {
  try {
    if (!app || typeof app.getPath !== "function") return 0;
    if (!(historicalPhoneDirMap instanceof Map) || historicalPhoneDirMap.size === 0) {
      return 0;
    }
    const baseDir = path.join(app.getPath("userData"), "data-stats");
    if (!fs.existsSync(baseDir)) return 0;
    const activeGroups = currentGroupSegs instanceof Set ? currentGroupSegs : new Set();
    let renamed = 0;
    for (const name of fs.readdirSync(baseDir)) {
      if (!name.includes("-")) continue;
      // 当前存在的分组名（含连字符）一律不动
      if (activeGroups.has(name)) continue;
      const targetSeg = historicalPhoneDirMap.get(name);
      if (!targetSeg || targetSeg === name) continue;
      const from = path.join(baseDir, name);
      const to = path.join(baseDir, targetSeg);
      if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue;
      fs.renameSync(from, to);
      renamed += 1;
    }
    if (renamed > 0) {
      console.log(`[account-migration] 数据统计目录已按分组名归并 ${renamed} 个`);
    }
    return renamed;
  } catch (e) {
    console.warn("[account-migration] 数据统计目录归并失败（不影响使用）:", e && e.message);
    return 0;
  }
}

const DEFAULT_GROUP_START_DATES = Object.freeze({
  人间善恶录: "2026-11-15",
  赛博老司机: "2026-11-24",
});

/**
 * 首次启动默认分组起点日期迁移（若 group-settings.json 不存在且对应分组存在，则写入默认值）。
 * 失败静默，不阻断启动；读状态非 ENOENT 时绝不覆盖已有文件。
 */
function migrateDefaultGroupStartDates(accountGroups) {
  try {
    if (!app || typeof app.getPath !== "function") return false;
    const baseDir = path.join(app.getPath("userData"), "data-stats");
    const file = path.join(baseDir, "group-settings.json");
    try {
      fs.statSync(file);
      return false;
    } catch (statErr) {
      if (!statErr || statErr.code !== "ENOENT") return false;
    }
    const existing = new Set(accountGroups || []);
    if (fs.existsSync(baseDir)) {
      for (const name of fs.readdirSync(baseDir)) {
        try {
          if (fs.statSync(path.join(baseDir, name)).isDirectory()) {
            existing.add(name);
          }
        } catch (_) {}
      }
    }
    const initial = Object.create(null);
    for (const [g, d] of Object.entries(DEFAULT_GROUP_START_DATES)) {
      if (existing.has(g) || existing.has(safeSeg(g))) {
        initial[g] = d;
      }
    }
    if (Object.keys(initial).length === 0) return false;
    fs.mkdirSync(baseDir, { recursive: true });
    const tmp = path.join(baseDir, `.group-settings.json.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(initial, null, 2), "utf8");
    fs.renameSync(tmp, file);
    console.log(
      `[account-migration] 已初始化默认分组统计起点日期: ${Object.keys(initial).join("、")}`
    );
    return true;
  } catch (e) {
    console.warn(
      "[account-migration] 初始化默认分组统计起点日期失败（不影响使用）:",
      e && e.message
    );
    return false;
  }
}

/**
 * @returns {{ changed: number, skipped: boolean }}
 */
export function ensureAccountRecordsMigrated() {
  if (migrated) return { changed: 0, skipped: true };
  migrated = true;
  let changed = 0;
  const accountGroups = new Set();
  const currentGroupSegs = new Set();
  const historicalPhoneDirMap = new Map();
  let accountsLoaded = false;
  try {
    const result = changeData({
      fileName: "account",
      type: "get",
      item: { page: 1, pageSize: 9999 },
    });
    if (!result || result.success !== false) {
      accountsLoaded = true;
    }
    const data = (result && result.data) || {};
    for (const dateKey of Object.keys(data)) {
      const rows = data[dateKey] || [];
      for (const row of rows) {
        const changedRow = normalizeAccountRecordFields(row);
        const rowGroup =
          row && typeof row.group === "string" ? row.group.trim() : "";
        if (rowGroup) {
          accountGroups.add(rowGroup);
          currentGroupSegs.add(rowGroup);
          currentGroupSegs.add(safeSeg(rowGroup));
        }
        // 识别符合历史「phone 全值」格式（<group>-<suffix> 且 row.group === prefix）的统计目录映射
        if (row && typeof row.phone === "string" && rowGroup) {
          const rawPhone = row.phone.trim();
          const dashIdx = rawPhone.indexOf("-");
          if (dashIdx > 0) {
            const prefix = rawPhone.slice(0, dashIdx).trim();
            const suffix = rawPhone.slice(dashIdx + 1).trim();
            if (prefix && suffix && rowGroup === prefix) {
              const fromSeg = safeSeg(rawPhone);
              const toSeg = safeSeg(prefix);
              if (fromSeg && toSeg && fromSeg !== toSeg) {
                historicalPhoneDirMap.set(fromSeg, toSeg);
              }
            }
          }
        }
        if (!changedRow) continue;
        const res = changeData({
          fileName: "account",
          type: "update",
          item: {
            id: row.id,
            date: row.date || dateKey,
            group: row.group,
            accountName: row.accountName,
            accountKey: row.accountKey,
          },
        });
        if (res && res.success !== false) changed += 1;
      }
    }
    if (changed > 0) {
      console.log(`[account-migration] 已为 ${changed} 条账号记录补齐分组新字段`);
    }
  } catch (e) {
    // 迁移失败不阻断启动：所有读取路径对缺新字段的记录都有 phone 前缀回退
    console.warn(
      "[account-migration] 账号记录迁移失败（按历史规则回退运行）:",
      e && e.message
    );
  }
  if (accountsLoaded) {
    migrateStatsGroupDirs(currentGroupSegs, historicalPhoneDirMap);
  }
  migrateDefaultGroupStartDates(accountGroups);
  return { changed, skipped: false };
}
