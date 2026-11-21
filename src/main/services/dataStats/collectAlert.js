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
  const label = alertState.account || `${alertState.group}·${alertState.platform}`;
  const body = `${label} 已连续失败 ${alertState.consecutiveFailures} 次：${alertState.reason}`;

  if (typeof notifyFn === "function") {
    try {
      const ret = notifyFn({ title, body, alert: alertState });
      return ret !== false;
    } catch (err) {
      console.warn(
        "[dataStats] 弹出采集失败系统通知异常:",
        (err && err.message) || err
      );
      return false;
    }
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
    if (typeof n.show !== "function") return false;
    n.show();
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
 * 评估一次采集结果并更新持久化告警状态（按「平台 + 账号」独立计数）。
 *
 * @param {object} params
 * @param {string} params.group
 * @param {string} params.platform
 * @param {string} [params.accountKey]
 * @param {string} [params.partition]
 * @param {string} [params.phone]
 * @param {string} [params.accountName]
 * @param {boolean} params.success            采集调用是否成功返回
 * @param {Array<object>} [params.works]      成功返回的作品列表
 * @param {string} [params.error]             失败原因
 * @param {Error} [params.errorObj]           原始错误对象（用于识别 NOT_LOGGED_IN / 401 / 403）
 * @param {boolean} [params.isLoginError]     显式覆写是否登录失效
 * @param {string} [params.errorType]         显式覆写错误类型
 * @param {number} [params.prevWorkCount]     采集前该账号历史作品数（不传则自动读取）
 * @param {number} [params.now]               时间戳（ms）
 * @param {Function} [params.notifyFn]        测试注入通知回调
 * @returns {{ ok: boolean, zeroWorksAnomaly: boolean, reason: string, alert: object|null, notified: boolean }}
 */
function handleAccountCollectOutcome({
  group,
  platform,
  accountKey,
  partition,
  phone,
  accountName,
  success,
  works,
  error,
  errorObj,
  isLoginError,
  errorType,
  prevWorkCount,
  now = Date.now(),
  notifyFn,
}) {
  const alertMeta = {
    accountKey,
    partition,
    phone,
    accountName,
    errorObj,
    isLoginError,
    errorType,
  };
  const priorCount =
    typeof prevWorkCount === "number" && Number.isFinite(prevWorkCount)
      ? prevWorkCount
      : typeof store.getPreviousWorkCount === "function"
      ? store.getPreviousWorkCount(group, platform, alertMeta)
      : 0;

  const workLen = Array.isArray(works) ? works.length : 0;
  let effectiveFailed = !success;
  let zeroWorksAnomaly = false;
  let reason = effectiveFailed ? String(error || "采集失败").trim() || "采集失败" : "";

  if (!effectiveFailed && priorCount > 0 && workLen === 0) {
    effectiveFailed = true;
    zeroWorksAnomaly = true;
    reason = `上次作品数 ${priorCount}，本次采集为 0（疑似接口异常或登录态异常）`;
    if (alertMeta.isLoginError === undefined) alertMeta.isLoginError = false;
    if (!alertMeta.errorType) alertMeta.errorType = "zero_works";
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
    const res = store.recordCollectFailure(group, platform, reason, now, alertMeta);
    let notified = false;
    if (res.shouldNotify) {
      const sent = showCollectAlertNotification(res.state, notifyFn);
      if (sent) {
        if (typeof store.markCollectAlertNotified === "function") {
          store.markCollectAlertNotified(group, platform, now, alertMeta);
        }
        res.state.notified = true;
        res.state.notifiedAt = now;
        notified = true;
      }
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
    store.clearCollectFailure(group, platform, now, alertMeta);
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
