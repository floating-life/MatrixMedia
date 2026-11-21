"use strict";
/**
 * S11 收尾（GPT Pro 第三轮 S11-review3b.out，Claude 修）：宁可少发，不重复发、不连发。
 * 1 立即发布预留在长时间下载/上传期间不过期（TTL 3 小时兜底）
 * 2 账本读失败不当空账本：派发标记与排期都失败关闭；仅展示接口容错
 * 3 陈旧锁抢占不用 rename，不会挪走别的进程刚拿到的新锁
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const svc = require("../src/main/services/publishThrottle.js");

(async () => {
  // 1
  assert.ok(svc.RESERVED_STALE_TTL_MS >= 3 * 60 * 60 * 1000, "预留兜底 TTL 至少 3 小时");
  console.log("✓ 1 预留 TTL");

  // 2 账本损坏
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11f-"));
  const ledgerPath = svc.getPublishThrottleLedgerPath({ userDataDir: dir });
  fs.writeFileSync(ledgerPath, "{ broken", "utf8");
  const opts = { userDataDir: dir, skipPushDataReconcile: true };
  const mark = await svc.markScheduledTaskDispatched({ id: "t1", pt: "抖音", phone: "A" }, Date.now(), opts);
  assert.strictEqual(mark.ok, false, "账本读失败时派发标记必须失败（中止上传）");
  const plan = await svc.planAndReservePublishTimes(
    { items: [{ key: "a", platform: "抖音", phone: "A", title: "x" }], now: Date.now() },
    opts
  );
  assert.strictEqual(plan.ok, false, "账本读失败时排期必须失败");
  assert.strictEqual(plan.code, "LEDGER_READ_FAILED", `排期失败原因应为账本读取失败，实际 ${plan.code}`);
  const shown = svc.readPublishThrottleLedger(opts);
  assert.ok(shown && Array.isArray(shown.entries), "展示接口容错返回空");
  console.log("✓ 2 账本读失败失败关闭");

  // 3 陈旧锁：判定陈旧后若锁已被别人换成新锁，不得删除
  const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11f-lock-"));
  const lockFile = svc.getPublishThrottleLedgerLockPath({ userDataDir: lockDir });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, token: "dead", acquiredAt: Date.now() - 60000 }), "utf8");
  // 正常抢占陈旧锁
  let ran = false;
  await svc.withPublishThrottleLock(() => { ran = true; }, { userDataDir: lockDir });
  assert.ok(ran);
  // 源码层面确认不再使用 rename 抢占
  const src = fs.readFileSync(path.join(__dirname, "../src/main/services/publishThrottle.js"), "utf8");
  const takeover = src.slice(src.indexOf("只在锁内容仍是我们判定陈旧的那份时才删除"), src.indexOf("function releaseFileLock"));
  assert.ok(takeover.length > 0 && !/renameSync\(lockPath/.test(takeover), "陈旧锁抢占不得 rename lockPath");
  console.log("✓ 3 陈旧锁抢占");
  console.log("test-s11-final: 全部通过");
})().catch((e) => { console.error(e); process.exit(1); });
