"use strict";

/**
 * 发布节流 / 平台错峰 / 默认创作声明 主进程持久化与 IPC 服务。
 *
 * 配置文件保存在 <userData>/publish-throttle-settings.json，GUI / CLI / HTTP 共用。
 * 纯排期算法 planPublishTimes 与设置规范化复用自 src/shared/publishThrottle.js，并在此原样重导出。
 */

const fs = require("fs");
const path = require("path");
const sharedThrottle = require("../../shared/publishThrottle.js");
const { readPushDataRecords } = require("../../shared/publishDedupe.js");

const SETTINGS_FILE_NAME = "publish-throttle-settings.json";

function getPublishThrottleSettingsPath(options = {}) {
  if (options && options.filePath) {
    return path.resolve(options.filePath);
  }
  if (options && options.userDataDir) {
    return path.join(path.resolve(options.userDataDir), SETTINGS_FILE_NAME);
  }
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
    }
  } catch (_) {
    /* 非 Electron 环境回退 */
  }
  return path.resolve(__dirname, SETTINGS_FILE_NAME);
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Windows 偶发目标被占用时退回覆盖写并清理临时文件
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {}
    }
  }
}

/**
 * 读取主进程持久化的节流与默认声明设置（文件不存在或损坏时自动回退默认值）。
 */
function readPublishThrottleSettings(options = {}) {
  const filePath = getPublishThrottleSettingsPath(options);
  try {
    if (!fs.existsSync(filePath)) {
      return sharedThrottle.createDefaultPublishThrottleSettings();
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return sharedThrottle.normalizePublishThrottleSettings(raw);
  } catch (err) {
    console.warn(
      "[publishThrottle] 读取设置失败，回退默认值:",
      (err && err.message) || err
    );
    return sharedThrottle.createDefaultPublishThrottleSettings();
  }
}

/**
 * 校验并持久化节流与默认声明设置。
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
function savePublishThrottleSettings(nextSettings, options = {}) {
  const checked = sharedThrottle.validatePublishThrottleSettings(nextSettings);
  if (!checked.ok) {
    return { ok: false, error: checked.error };
  }
  const filePath = getPublishThrottleSettingsPath(options);
  const toSave = {
    ...checked.value,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(filePath, toSave);
  return { ok: true, settings: checked.value };
}

/**
 * 重置为默认设置并落盘。
 */
function resetPublishThrottleSettings(options = {}) {
  const defaults = sharedThrottle.createDefaultPublishThrottleSettings();
  return savePublishThrottleSettings(defaults, options);
}

/**
 * 读取当前持久化配置的默认创作声明（默认 ai_generated）。
 */
function getDefaultCreativeStatement(options = {}) {
  const settings = readPublishThrottleSettings(options);
  return settings.defaultCreativeStatement;
}

/**
 * 注册发布节流设置与排期预览相关 IPC（供 GUI 调用）。
 */
function registerPublishThrottleIpc(ipcMain, deps = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") return;

  const getChangeData = () => {
    if (typeof deps.changeData === "function") return deps.changeData;
    return require("../server/utils.js").changeData;
  };

  ipcMain.handle("publish-throttle:get-settings", async () => {
    try {
      const settings = readPublishThrottleSettings(deps);
      return { ok: true, settings };
    } catch (e) {
      return {
        ok: false,
        message: (e && e.message) || String(e),
        settings: sharedThrottle.createDefaultPublishThrottleSettings(),
      };
    }
  });

  ipcMain.handle("publish-throttle:save-settings", async (_event, payload) => {
    try {
      const res = savePublishThrottleSettings(payload, deps);
      if (!res.ok) {
        return { ok: false, message: res.error };
      }
      return { ok: true, settings: res.settings };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle("publish-throttle:reset-settings", async () => {
    try {
      const res = resetPublishThrottleSettings(deps);
      if (!res.ok) {
        return { ok: false, message: res.error };
      }
      return { ok: true, settings: res.settings };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle("publish-throttle:plan", async (_event, payload = {}) => {
    try {
      const settings = readPublishThrottleSettings(deps);
      const records = readPushDataRecords(getChangeData());
      const plan = sharedThrottle.planPublishTimes({
        targets: Array.isArray(payload.targets) ? payload.targets : [],
        now:
          typeof payload.now === "number" && Number.isFinite(payload.now)
            ? payload.now
            : Date.now(),
        publishAt: payload.publishAt || null,
        publishAtMs:
          typeof payload.publishAtMs === "number" &&
          Number.isFinite(payload.publishAtMs)
            ? payload.publishAtMs
            : null,
        records,
        settings,
        noThrottle: Boolean(payload.noThrottle),
      });
      return { ok: true, ...plan };
    } catch (e) {
      return { ok: false, message: (e && e.message) || String(e) };
    }
  });

  ipcMain.handle(
    "publish-throttle:create-scheduled",
    async (_event, payload = {}) => {
      try {
        const changeDataFn = getChangeData();
        const createScheduledRecordFn = deps.createScheduledRecord;
        const notifyScheduledChangedFn = deps.notifyScheduledPublishChanged;
        const findExistingScheduledFn = deps.findExistingScheduled;
        if (typeof createScheduledRecordFn !== "function") {
          return { ok: false, message: "定时发布服务未就绪" };
        }

        const item =
          payload && payload.item && typeof payload.item === "object"
            ? payload.item
            : payload;
        const publishAtText =
          (payload && payload.publishAtText) ||
          (item && item.scheduledPublishAtText) ||
          "";
        const publishAtMs =
          payload && Number.isFinite(payload.scheduledPublishAtMs)
            ? payload.scheduledPublishAtMs
            : item && Number.isFinite(item.scheduledPublishAt)
            ? item.scheduledPublishAt
            : null;
        const nowMs = Date.now();
        const scheduledRecord = createScheduledRecordFn(
          item,
          publishAtMs ? { value: publishAtMs, text: publishAtText } : publishAtText,
          nowMs
        );
        if (typeof findExistingScheduledFn === "function") {
          const existing = findExistingScheduledFn(
            readPushDataRecords(changeDataFn),
            scheduledRecord
          );
          if (existing) {
            return {
              ok: true,
              duplicate: true,
              id: existing.id || null,
              publishAt: scheduledRecord.scheduledPublishAtText,
            };
          }
        }
        const addRes = changeDataFn({
          fileName: "pushData",
          type: "add",
          item: scheduledRecord,
        });
        let recordId = null;
        if (addRes && addRes.success && Array.isArray(addRes.data)) {
          const found = [...addRes.data]
            .reverse()
            .find(
              (it) =>
                it.scheduledTask === true &&
                it.scheduledPublishAt === scheduledRecord.scheduledPublishAt &&
                it.textOtherName === scheduledRecord.textOtherName &&
                it.pt === scheduledRecord.pt &&
                it.selectedFile === scheduledRecord.selectedFile &&
                it.textType === scheduledRecord.textType
            );
          if (found) recordId = found.id;
        }
        if (typeof notifyScheduledChangedFn === "function") {
          notifyScheduledChangedFn();
        }
        return {
          ok: true,
          duplicate: false,
          id: recordId,
          publishAt: scheduledRecord.scheduledPublishAtText,
        };
      } catch (e) {
        return { ok: false, message: (e && e.message) || String(e) };
      }
    }
  );
}

module.exports = {
  ...sharedThrottle,
  SETTINGS_FILE_NAME,
  getPublishThrottleSettingsPath,
  readPublishThrottleSettings,
  savePublishThrottleSettings,
  resetPublishThrottleSettings,
  getDefaultCreativeStatement,
  registerPublishThrottleIpc,
};
