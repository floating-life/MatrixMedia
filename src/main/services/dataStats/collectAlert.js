"use strict";

/**
 * 采集失败告警统一处理模块（自动采集 / 手动采集 / HTTP /stats/sync / CLI stats-sync 共用）。
 *
 * 规则：
 * - 平台账号采集报错（登录失效、接口报错）或「上次作品数 > 0 且本次 = 0」计为一次失败；
 * - 连续失败状态持久化到 <userData>/data-stats/collect-alerts.json；
 * - 连续失败达到 2 次时标为 alerted 并弹一次 Electron 系统通知（同一账号恢复成功前不再重复弹）；
 * - 任意一次有效采集成功即清除该账号的失败与告警状态。
 */

const store = require("./store");

function showCollectAlertNotification(alertState, notifyFn) {
  const title = alertState.isLoginError
    ? `数据采集告警：${alertState.platform}需重新登录`
    : `数据采集失败告警：${alertState.platform}`;
  const body = `${alertState.group}·${alertState.platform} 已连续失败 ${alertState.consecutiveFailures} 次：${alertState.reason}`;

  if (typeof notifyFn === "function") {
    notifyFn({ title, body, alert: alertState });
    return true;
  }

  try {
    const electron = require("electron");
    const NotificationCtor = electron && electron.Notification;
    if (typeof NotificationCtor !== "function") return false;
    if (
      typeof NotificationCtor.isSupported === "function" &&
      !NotificationCtor.isSupported()
    ) {
      return false;
    }
    const n = new NotificationCtor({ title, body });
    if (typeof n.show === "function") {
      n.show();
    }
    return true;
  } catch (err) {
    console.warn(
      "[dataStats] 弹出采集失败系统通知异常:",
      (err && err.message) || err
    );
    return false;
  }
}

/**
 * 评估一次采集结果并更新持久化告警状态。
 *
 * @param {object} params
 * @param {string} params.group
 * @param {string} params.platform
 * @param {boolean} params.success            采集调用是否成功返回
 * @param {Array<object>} [params.works]      成功返回的作品列表
 * @param {string} [params.error]             失败原因
 * @param {number} [params.prevWorkCount]     采集前该账号历史作品数（不传则自动读取）
 * @param {number} [params.now]               时间戳（ms）
 * @param {Function} [params.notifyFn]        测试注入通知回调
 * @returns {{ ok: boolean, zeroWorksAnomaly: boolean, reason: string, alert: object|null, notified: boolean }}
 */
function handleAccountCollectOutcome({
  group,
  platform,
  success,
  works,
  error,
  prevWorkCount,
  now = Date.now(),
  notifyFn,
}) {
  const priorCount =
    typeof prevWorkCount === "number" && Number.isFinite(prevWorkCount)
      ? prevWorkCount
      : typeof store.getPreviousWorkCount === "function"
      ? store.getPreviousWorkCount(group, platform)
      : 0;

  const workLen = Array.isArray(works) ? works.length : 0;
  let effectiveFailed = !success;
  let zeroWorksAnomaly = false;
  let reason = effectiveFailed ? String(error || "采集失败").trim() || "采集失败" : "";

  if (!effectiveFailed && priorCount > 0 && workLen === 0) {
    effectiveFailed = true;
    zeroWorksAnomaly = true;
    reason = `上次作品数 ${priorCount}，本次采集为 0（疑似登录失效或接口异常）`;
  }

  if (effectiveFailed) {
    if (typeof store.recordCollectFailure !== "function") {
      return {
        ok: false,
        zeroWorksAnomaly,
        reason,
        alert: null,
        notified: false,
      };
    }
    const res = store.recordCollectFailure(group, platform, reason, now);
    let notified = false;
    if (res.shouldNotify) {
      showCollectAlertNotification(res.state, notifyFn);
      if (typeof store.markCollectAlertNotified === "function") {
        store.markCollectAlertNotified(group, platform, now);
      }
      res.state.notified = true;
      res.state.notifiedAt = now;
      notified = true;
    }
    return {
      ok: false,
      zeroWorksAnomaly,
      reason,
      alert: res.state,
      notified,
    };
  }

  if (typeof store.clearCollectFailure === "function") {
    store.clearCollectFailure(group, platform, now);
  }
  return {
    ok: true,
    zeroWorksAnomaly: false,
    reason: "",
    alert: null,
    notified: false,
  };
}

module.exports = {
  handleAccountCollectOutcome,
  showCollectAlertNotification,
};
