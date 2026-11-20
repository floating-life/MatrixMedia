/**
 * 作品分时段快照（works-intraday）与跨平台分时段趋势单元测试（不依赖真实 Electron 环境）：
 * 1. 同槽覆盖与同日多槽保留
 * 2. 手动采集按 UTC+8 向下取整为 "HH:00"
 * 3. 原子写失败（writeSync ENOSPC / fsyncSync EIO / renameSync EPERM）：旧文件 byte-for-byte 完整、无 .tmp 残留、不阻断 mergeWorks
 * 4. 跨零点写入放弃：不改写昨日文件、无 .tmp 残留
 * 5. 保留期清理：每天首次写入触发、只删 works-intraday 下超过 retentionDays 的合法 YYYY-MM-DD.json 普通文件
 *    （不删边界日、非日期文件、子目录、works-daily 文件；同日再次写入不重复清理）
 * 6. readWorksIntraday 升序排序、from/to 过滤、特殊 workId（__proto__/constructor）安全与损坏/不可读文件 warn 跳过
 * 7. buildContentIntradayData & stats:get-content-intraday 与作品汇总关联（link / fuzzy / manual override / detach / merge / 跨组去重）一致，
 *    以及汇总行 lastCollectedAt 汇总逻辑
 *
 * 运行：yarn test:works-intraday
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function cnTime(y, m, d, hh = 10, mm = 0, ss = 0) {
  return Date.UTC(y, m - 1, d, hh - 8, mm, ss);
}

function captureWarns(fn) {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(" "));
  try {
    const out = fn();
    if (out && typeof out.then === "function") {
      return out.then(
        (res) => {
          console.warn = origWarn;
          return { res, warns };
        },
        (err) => {
          console.warn = origWarn;
          throw err;
        }
      );
    }
    console.warn = origWarn;
    return { res: out, warns };
  } catch (err) {
    console.warn = origWarn;
    throw err;
  }
}

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-works-intraday-test-"));
  const userDataDir = path.join(tmpRoot, "userData");
  const docsDir = path.join(tmpRoot, "Documents");
  const pushDataDir = path.join(docsDir, "MatrixMedia", "data", "pushData");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(pushDataDir, { recursive: true });

  const ipcHandlers = new Map();
  const electronId = require.resolve("electron");
  const origElectronCache = require.cache[electronId];
  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      app: {
        getPath: (name) => (name === "documents" ? docsDir : userDataDir),
        getVersion: () => "0.14.9-intraday-test",
      },
      ipcMain: {
        handle: (ch, fn) => ipcHandlers.set(ch, fn),
      },
      BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async () => ({ canceled: true }),
      },
    },
  };

  const storeId = require.resolve("../src/main/services/dataStats/store.js");
  const exportId = require.resolve("../src/main/services/dataStats/statsExport.js");
  const indexId = require.resolve("../src/main/services/dataStats/index.js");
  const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
  const origCollectorCache = require.cache[collectorId];

  require.cache[collectorId] = {
    id: collectorId,
    filename: collectorId,
    loaded: true,
    exports: {
      collectAccount: async () => ({ overview: {}, works: [], fansHistory: {} }),
    },
  };

  delete require.cache[storeId];
  delete require.cache[exportId];
  delete require.cache[indexId];

  const store = require("../src/main/services/dataStats/store.js");
  const statsExport = require("../src/main/services/dataStats/statsExport.js");
  const { registerDataStatsIpc } = require("../src/main/services/dataStats/index.js");
  const { buildWorkIntradayRows } = require("../src/main/services/dataStats/statsTable.js");

  try {
    /* ---------- 1. 同槽覆盖 + 同日多槽保留 + 自动槽键 ---------- */
    {
      const t08 = cnTime(2026, 11, 20, 8, 2, 10);
      const t08b = cnTime(2026, 11, 20, 8, 15, 0);
      const t10 = cnTime(2026, 11, 20, 10, 1, 5);

      store.mergeWorks(
        "测试组",
        "抖音",
        [
          { workId: "w1", title: "测试视频1", play: 100, like: 10, comment: 2, share: 1, favorite: 3, fansDelta: 1 },
          { workId: "w2", title: "测试视频2", play: 50, like: 5, comment: 0, share: null, favorite: null, fansDelta: 0 },
        ],
        t08,
        { slot: "2026-11-20 08:00" }
      );

      // 同槽重复采集覆盖（08:00 覆盖为最新值）
      store.mergeWorks(
        "测试组",
        "抖音",
        [
          { workId: "w1", title: "测试视频1", play: 120, like: 12, comment: 3, share: 1, favorite: 4, fansDelta: 2 },
        ],
        t08b,
        { slot: "2026-11-20 08:00" }
      );

      // 下一槽 10:00 写入，08:00 保持完整
      store.mergeWorks(
        "测试组",
        "抖音",
        [
          { workId: "w1", title: "测试视频1", play: 260, like: 25, comment: 6, share: 3, favorite: 9, fansDelta: 5 },
          { workId: "w2", title: "测试视频2", play: 90, like: 8, comment: 1, share: null, favorite: null, fansDelta: 0 },
        ],
        t10,
        { slot: "2026-11-20 10:00" }
      );

      const dayFile = path.join(
        store.worksIntradayDir("测试组", "抖音"),
        "2026-11-20.json"
      );
      assert.strictEqual(fs.existsSync(dayFile), true, "应生成 works-intraday/2026-11-20.json");
      const rawDoc = JSON.parse(fs.readFileSync(dayFile, "utf8"));
      assert.strictEqual(rawDoc.date, "2026-11-20");
      assert.deepStrictEqual(Object.keys(rawDoc.slots).sort(), ["08:00", "10:00"]);
      assert.strictEqual(rawDoc.slots["08:00"].collectedAt, t08b, "同槽覆盖应更新 collectedAt");
      assert.strictEqual(rawDoc.slots["08:00"].works.w1.play, 120, "同槽覆盖应替换该槽作品数据");
      assert.strictEqual(rawDoc.slots["08:00"].works.w2, undefined, "同槽覆盖应整体替换该槽 works 快照");
      assert.strictEqual(rawDoc.slots["10:00"].collectedAt, t10);
      assert.strictEqual(rawDoc.slots["10:00"].works.w1.play, 260);
      assert.strictEqual(rawDoc.slots["10:00"].works.w2.play, 90);

      // works-daily 当天语义仍不变（保留当天最新值）
      const daily = store.readWorksDaily("测试组", "抖音");
      assert.strictEqual(daily.w1["2026-11-20"].play, 260);
      assert.strictEqual(daily.w2["2026-11-20"].play, 90);
      console.log("✓ 1. 同槽覆盖、同日多槽保留与 works-daily 共存正确");
    }

    /* ---------- 2. 手动采集按 UTC+8 向下取整为 "HH:00" ---------- */
    {
      // UTC 2026-11-19 16:47:59 = UTC+8 2026-11-20 00:47:59 → "2026-11-20 00:00"
      const tMidnightCn = Date.UTC(2026, 10, 19, 16, 47, 59);
      assert.strictEqual(store.formatManualSlotKey(tMidnightCn), "2026-11-20 00:00");

      // UTC+8 2026-11-20 14:59:59 → "2026-11-20 14:00"
      const tAfternoon = cnTime(2026, 11, 20, 14, 59, 59);
      assert.strictEqual(store.formatManualSlotKey(tAfternoon), "2026-11-20 14:00");

      // 不传 slot 走手动采集逻辑
      store.mergeWorks(
        "手动组",
        "快手",
        [{ workId: "ks1", title: "手动测试", play: 300, like: 20, comment: 4 }],
        tMidnightCn
      );
      store.mergeWorks(
        "手动组",
        "快手",
        [{ workId: "ks1", title: "手动测试", play: 450, like: 35, comment: 7 }],
        tAfternoon
      );
      // 同一小时内再次手动采集（14:12 -> 14:00）覆盖 14:00 槽
      const tAfternoon2 = cnTime(2026, 11, 20, 14, 12, 0);
      store.mergeWorks(
        "手动组",
        "快手",
        [{ workId: "ks1", title: "手动测试", play: 460, like: 36, comment: 8 }],
        tAfternoon2
      );

      const read = store.readWorksIntraday("手动组", "快手");
      assert.strictEqual(read.ks1.length, 2);
      assert.deepStrictEqual(
        read.ks1.map((x) => `${x.date} ${x.slot}`),
        ["2026-11-20 00:00", "2026-11-20 14:00"]
      );
      assert.strictEqual(read.ks1[1].play, 460);
      assert.strictEqual(read.ks1[1].collectedAt, tAfternoon2);
      console.log("✓ 2. 手动采集按 UTC+8 向下取整为 HH:00 且同小时覆盖正确");
    }

    /* ---------- 3. 原子写失败（writeSync / fsyncSync / renameSync）：旧文件完整、无 .tmp 残留 ---------- */
    {
      const g = "原子组";
      const p = "抖音";
      const t1 = cnTime(2026, 11, 20, 8, 0, 0);
      const t2 = cnTime(2026, 11, 20, 10, 0, 0);
      store.mergeWorks(g, p, [{ workId: "a1", title: "原子作品", play: 100 }], t1, {
        slot: "2026-11-20 08:00",
      });
      const dir = store.worksIntradayDir(g, p);
      const dayFile = path.join(dir, "2026-11-20.json");
      const beforeBytes = fs.readFileSync(dayFile);

      const isIntradayPath = (pStr) =>
        typeof pStr === "string" && pStr.includes(`${path.sep}works-intraday${path.sep}`);

      // 3a. writeSync ENOSPC（仅拦截 works-intraday 目录的 .tmp）
      {
        const origOpenSync = fs.openSync;
        const origWriteSync = fs.writeSync;
        const intradayFds = new Set();
        fs.openSync = function (filePath, ...rest) {
          const fd = origOpenSync.call(this, filePath, ...rest);
          if (isIntradayPath(filePath)) {
            intradayFds.add(fd);
          }
          return fd;
        };
        fs.writeSync = function (fd, ...rest) {
          if (intradayFds.has(fd)) {
            const e = new Error("ENOSPC: no space left on device");
            e.code = "ENOSPC";
            throw e;
          }
          return origWriteSync.call(this, fd, ...rest);
        };
        try {
          const { warns } = captureWarns(() => {
            store.mergeWorks(g, p, [{ workId: "a1", title: "原子作品", play: 200 }], t2, {
              slot: "2026-11-20 10:00",
            });
          });
          assert.ok(warns.some((w) => w.includes("works-intraday") && w.includes("ENOSPC")));
        } finally {
          fs.openSync = origOpenSync;
          fs.writeSync = origWriteSync;
        }
        assert.strictEqual(Buffer.compare(fs.readFileSync(dayFile), beforeBytes), 0, "writeSync 失败旧文件须逐字节完整");
        assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".tmp")), false, "不得残留 .tmp 文件");
        // mergeWorks 整体不抛错，works-daily 仍正常更新到 200
        assert.strictEqual(store.readWorksDaily(g, p).a1["2026-11-20"].play, 200);
      }

      // 3b. fsyncSync EIO
      {
        const origOpenSync = fs.openSync;
        const origFsyncSync = fs.fsyncSync;
        const intradayFds = new Set();
        fs.openSync = function (filePath, ...rest) {
          const fd = origOpenSync.call(this, filePath, ...rest);
          if (isIntradayPath(filePath)) {
            intradayFds.add(fd);
          }
          return fd;
        };
        fs.fsyncSync = function (fd) {
          if (intradayFds.has(fd)) {
            const e = new Error("EIO: fsync failed");
            e.code = "EIO";
            throw e;
          }
          return origFsyncSync.call(this, fd);
        };
        try {
          const { warns } = captureWarns(() => {
            store.recordWorksIntraday(g, p, [{ workId: "a1", play: 250 }], {
              now: t2,
              slot: "2026-11-20 10:00",
            });
          });
          assert.ok(warns.some((w) => w.includes("EIO")));
        } finally {
          fs.openSync = origOpenSync;
          fs.fsyncSync = origFsyncSync;
        }
        assert.strictEqual(Buffer.compare(fs.readFileSync(dayFile), beforeBytes), 0, "fsyncSync 失败旧文件须完整");
        assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".tmp")), false);
      }

      // 3c. renameSync EPERM
      {
        const origRenameSync = fs.renameSync;
        fs.renameSync = function (src, dst) {
          if (isIntradayPath(dst)) {
            const e = new Error("EPERM: operation not permitted");
            e.code = "EPERM";
            throw e;
          }
          return origRenameSync.call(this, src, dst);
        };
        try {
          const { warns } = captureWarns(() => {
            store.recordWorksIntraday(g, p, [{ workId: "a1", play: 280 }], {
              now: t2,
              slot: "2026-11-20 10:00",
            });
          });
          assert.ok(warns.some((w) => w.includes("EPERM")));
        } finally {
          fs.renameSync = origRenameSync;
        }
        assert.strictEqual(Buffer.compare(fs.readFileSync(dayFile), beforeBytes), 0, "renameSync 失败旧文件须完整");
        assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".tmp")), false);
      }
      console.log("✓ 3. 原子写失败（writeSync/fsyncSync/renameSync）：旧文件完整、无 .tmp 残留、不阻断 mergeWorks");
    }

    /* ---------- 4. 跨零点写入：以 collectNow 的 UTC+8 日期为唯一日期，不中途放弃 ---------- */
    {
      const g = "跨零点组";
      const p = "视频号";
      const beforeMid = cnTime(2026, 11, 20, 23, 59, 58);
      store.recordWorksIntraday(g, p, [{ workId: "m1", play: 100 }], {
        now: cnTime(2026, 11, 20, 22, 0, 0),
        slot: "2026-11-20 22:00",
      });
      const dir = store.worksIntradayDir(g, p);
      const dayFile = path.join(dir, "2026-11-20.json");
      const nextDayFile = path.join(dir, "2026-11-21.json");

      // 模拟写入过程中时钟跨过 2026-11-21 00:00:00 (UTC+8)：仍按 collectNow (2026-11-20) 完整写入前一天文件
      const origDateNow = Date.now;
      let calls = 0;
      Date.now = () => {
        calls += 1;
        return calls <= 1 ? beforeMid : cnTime(2026, 11, 21, 0, 0, 3);
      };
      try {
        const { warns } = captureWarns(() => {
          store.recordWorksIntraday(g, p, [{ workId: "m1", play: 250 }], {
            now: beforeMid,
            slot: "2026-11-20 23:00",
          });
        });
        assert.deepStrictEqual(warns, [], "零点前采集、零点后写入不再中断告警");
      } finally {
        Date.now = origDateNow;
      }
      const doc = JSON.parse(fs.readFileSync(dayFile, "utf8"));
      assert.strictEqual(doc.slots["22:00"].works.m1.play, 100);
      assert.strictEqual(doc.slots["23:00"].works.m1.play, 250);
      assert.strictEqual(doc.slots["23:00"].collectedAt, beforeMid);
      assert.strictEqual(fs.existsSync(nextDayFile), false, "不得拆写到次日文件");
      assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".tmp")), false, "不得残留 .tmp");
      console.log("✓ 4. 跨零点写入：以 collectNow 归档 2026-11-20 且无 .tmp 残留");
    }

    /* ---------- 5. 保留期清理：每天首次写入触发、只删 works-intraday 目标文件 ---------- */
    {
      const g = "清理组";
      const p = "抖音";
      const dir = store.worksIntradayDir(g, p);
      const dailyDir = store.worksDailyDir(g, p);
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(dailyDir, { recursive: true });

      const today = "2026-11-20";
      const tToday = cnTime(2026, 11, 20, 10, 0, 0);
      // retentionDays = 3 → 保留 2026-11-17..2026-11-20，删除 <= 2026-11-16
      const dummyPayload = JSON.stringify({
        date: "2026-11-15",
        slots: { "10:00": { collectedAt: cnTime(2026, 11, 15, 10, 0), works: { w1: { play: 1 } } } },
      });
      fs.writeFileSync(path.join(dir, "2026-11-15.json"), dummyPayload); // 过期 → 删
      fs.writeFileSync(path.join(dir, "2026-11-16.json"), dummyPayload); // 过期 (today - 4) → 删
      fs.writeFileSync(path.join(dir, "2026-11-17.json"), dummyPayload); // 边界 (today - 3) → 保留
      fs.writeFileSync(path.join(dir, "2026-11-19.json"), dummyPayload); // 近期 → 保留
      // 非目标文件/目录均不得删除
      fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");
      fs.writeFileSync(path.join(dir, "backup-2026-01-01.json"), "{}");
      fs.writeFileSync(path.join(dir, "2026-02-30.json"), "{}"); // 非法日历日不删
      fs.mkdirSync(path.join(dir, "2020-01-01.json"), { recursive: true }); // 同名子目录不删
      // works-daily 里的旧文件绝不受影响
      fs.writeFileSync(path.join(dailyDir, "2025-01-01.json"), JSON.stringify({ date: "2025-01-01", works: {} }));

      // 首次写入 2026-11-20 触发清理
      store.recordWorksIntraday(g, p, [{ workId: "w1", play: 500 }], {
        now: tToday,
        slot: `${today} 10:00`,
        retentionDays: 3,
      });

      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-15.json")), false, "过期文件应被清理");
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-16.json")), false, "超保留期 1 天应被清理");
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-17.json")), true, "恰好等于 retentionDays 的边界文件应保留");
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-19.json")), true);
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-20.json")), true);
      assert.strictEqual(fs.existsSync(path.join(dir, "notes.txt")), true, "非 YYYY-MM-DD.json 不得删除");
      assert.strictEqual(fs.existsSync(path.join(dir, "backup-2026-01-01.json")), true, "非 YYYY-MM-DD.json 不得删除");
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-02-30.json")), true, "非法日期名不得删除");
      assert.strictEqual(fs.statSync(path.join(dir, "2020-01-01.json")).isDirectory(), true, "子目录不得删除");
      assert.strictEqual(fs.existsSync(path.join(dailyDir, "2025-01-01.json")), true, "works-daily 旧文件不得删除");

      // 同日第二次写入不重复清理（手动再放回一个过期文件，验证当天仅首次写入触发清理）
      fs.writeFileSync(path.join(dir, "2026-11-10.json"), dummyPayload);
      store.recordWorksIntraday(g, p, [{ workId: "w1", play: 520 }], {
        now: cnTime(2026, 11, 20, 12, 0, 0),
        slot: `${today} 12:00`,
        retentionDays: 3,
      });
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-10.json")), true, "同日二次写入不重复扫盘清理");

      // 次日首次写入再次触发清理
      store.recordWorksIntraday(g, p, [{ workId: "w1", play: 600 }], {
        now: cnTime(2026, 11, 21, 8, 0, 0),
        slot: "2026-11-21 08:00",
        retentionDays: 3,
      });
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-10.json")), false, "次日首次写入应触发新一轮清理");
      assert.strictEqual(fs.existsSync(path.join(dir, "2026-11-17.json")), false, "次日后 11-17 也过期应被清理");
      console.log("✓ 5. 保留期清理：每天首次写入触发，仅删 works-intraday 超期 YYYY-MM-DD.json 普通文件");
    }

    /* ---------- 6. readWorksIntraday 排序、区间过滤、特殊 workId 与损坏文件 warn 跳过 ---------- */
    {
      const g = "读取组";
      const p = "小红书";
      const dir = store.worksIntradayDir(g, p);
      fs.mkdirSync(dir, { recursive: true });

      // 写入乱序槽键的文件（18:00 在 08:00 之前）+ 特殊 workId（__proto__, constructor）
      fs.writeFileSync(
        path.join(dir, "2026-11-18.json"),
        JSON.stringify({
          date: "2026-11-18",
          slots: {
            "18:00": {
              collectedAt: cnTime(2026, 11, 18, 18, 5),
              works: {
                wA: { play: 200, like: 20, comment: 4, share: 1, favorite: 2, fansDelta: null },
                ["__proto__"]: { play: 10, like: 1, comment: 0, share: 0, favorite: 0, fansDelta: null },
                constructor: { play: 20, like: 2, comment: 0, share: 0, favorite: 0, fansDelta: null },
              },
            },
            "08:00": {
              collectedAt: cnTime(2026, 11, 18, 8, 1),
              works: {
                wA: { play: 100, like: 10, comment: 1, share: 0, favorite: 1, fansDelta: null },
              },
            },
          },
        })
      );
      // 损坏 JSON 文件 + 结构无效文件 + 目录伪装文件
      fs.writeFileSync(path.join(dir, "2026-11-19.json"), "{broken json!!!");
      fs.writeFileSync(path.join(dir, "2026-11-17.json"), JSON.stringify({ date: "2026-11-17", slots: "bad" }));
      fs.mkdirSync(path.join(dir, "2026-11-16.json"), { recursive: true });
      // 正常 11-20 文件
      fs.writeFileSync(
        path.join(dir, "2026-11-20.json"),
        JSON.stringify({
          date: "2026-11-20",
          slots: {
            "10:00": {
              collectedAt: cnTime(2026, 11, 20, 10, 0),
              works: {
                wA: { play: 350, like: 35, comment: 7, share: 2, favorite: 5, fansDelta: null },
              },
            },
          },
        })
      );

      const { res: allData, warns } = captureWarns(() => store.readWorksIntraday(g, p));
      assert.strictEqual(Object.getPrototypeOf(allData), null, "返回值必须为无原型对象");
      assert.strictEqual(({}).polluted, undefined, "不得污染 Object.prototype");
      assert.ok(warns.length >= 3, `损坏/无效/目录文件应均触发 warn，实际 ${warns.length}`);
      assert.deepStrictEqual(
        allData.wA.map((x) => `${x.date} ${x.slot}:${x.play}`),
        ["2026-11-18 08:00:100", "2026-11-18 18:00:200", "2026-11-20 10:00:350"],
        "必须按 date -> slot 升序排列"
      );
      assert.strictEqual(Object.getOwnPropertyDescriptor(allData, "__proto__").value[0].play, 10);
      assert.strictEqual(allData.constructor[0].play, 20);

      // { from, to } 过滤
      const { res: ranged } = captureWarns(() =>
        store.readWorksIntraday(g, p, { from: "2026-11-19", to: "2026-11-20" })
      );
      assert.deepStrictEqual(
        ranged.wA.map((x) => `${x.date} ${x.slot}`),
        ["2026-11-20 10:00"]
      );
      // from > to 返回空对象
      assert.deepStrictEqual(
        Object.keys(store.readWorksIntraday(g, p, { from: "2026-11-21", to: "2026-11-20" })),
        []
      );

      // buildWorkIntradayRows 跨边界增量与距上次小时数验证
      const intradayRows = buildWorkIntradayRows({
        group: g,
        platform: p,
        works: [{ workId: "wA", title: "排序作品", publishTime: cnTime(2026, 11, 18, 7, 0) }],
        worksIntraday: allData,
        from: "2026-11-20",
        to: "2026-11-20",
      });
      assert.strictEqual(intradayRows.length, 1);
      assert.strictEqual(intradayRows[0].playDelta, 150, "应跨 from 边界减 2026-11-18 18:00 的 200");
      assert.strictEqual(intradayRows[0].likeDelta, 15);
      assert.strictEqual(intradayRows[0].commentDelta, 3);
      assert.strictEqual(intradayRows[0].hoursSincePrev, 39.92, "11-18 18:05 到 11-20 10:00 为 39.92 小时");
      console.log("✓ 6. readWorksIntraday 升序/过滤/无原型安全/损坏 warn 跳过与 buildWorkIntradayRows 正确");
    }

    /* ---------- 7. buildContentIntradayData & stats:get-content-intraday 与汇总关联一致 + lastCollectedAt ---------- */
    {
      // 准备 2 分组（G1, G2）× 2 平台（抖音, 快手）：
      // - 关联内容 file:/v/demo.mp4：直链匹配 DY1 + 手工 assign 把 KS_M 归入该内容
      // - 跨组同作品：G2/抖音 也包含 DY1（应去重取排序第一组 G1）
      // - 手工拆出：KS_DETACH 从 file:/v/demo.mp4 拆出为独立未关联作品
      const pubMs = cnTime(2026, 11, 18, 9, 0, 0);
      const t18_10 = cnTime(2026, 11, 18, 10, 0, 0);
      const t19_10 = cnTime(2026, 11, 19, 10, 0, 0);
      const t19_12 = cnTime(2026, 11, 19, 12, 0, 0);
      const t20_08 = cnTime(2026, 11, 20, 8, 5, 0);
      const t20_10 = cnTime(2026, 11, 20, 10, 10, 0);

      // 写 pushData 记录
      fs.writeFileSync(
        path.join(pushDataDir, "2026-11-18.json"),
        JSON.stringify([
          {
            id: "rec-demo-1",
            filePath: "/v/demo.mp4",
            title: "示例跨平台视频",
            pt: "抖音",
            group: "G1",
            videoLink: "https://www.douyin.com/video/dy1",
            publishStatus: "success",
            lastPublishAt: pubMs,
          },
          {
            id: "rec-demo-2",
            filePath: "/v/demo.mp4",
            title: "示例跨平台视频",
            pt: "快手",
            group: "G1",
            videoLink: "https://www.kuaishou.com/short-video/ks_detach",
            publishStatus: "success",
            lastPublishAt: pubMs,
          },
        ])
      );

      // 写 G1/抖音（DY1）
      store.mergeWorks(
        "G1",
        "抖音",
        [{ workId: "DY1", title: "示例跨平台视频", url: "https://www.douyin.com/video/dy1", publishTime: pubMs, play: 100, like: 10, comment: 1 }],
        t18_10,
        { slot: "2026-11-18 10:00" }
      );
      store.mergeWorks(
        "G1",
        "抖音",
        [{ workId: "DY1", title: "示例跨平台视频", url: "https://www.douyin.com/video/dy1", publishTime: pubMs, play: 220, like: 22, comment: 3 }],
        t19_10,
        { slot: "2026-11-19 10:00" }
      );
      store.mergeWorks(
        "G1",
        "抖音",
        [{ workId: "DY1", title: "示例跨平台视频", url: "https://www.douyin.com/video/dy1", publishTime: pubMs, play: 400, like: 40, comment: 5 }],
        t20_08,
        { slot: "2026-11-20 08:00" }
      );
      store.mergeWorks(
        "G1",
        "抖音",
        [{ workId: "DY1", title: "示例跨平台视频", url: "https://www.douyin.com/video/dy1", publishTime: pubMs, play: 520, like: 52, comment: 6 }],
        t20_10,
        { slot: "2026-11-20 10:00" }
      );

      // 写 G2/抖音（同作品 DY1 重复挂组，值故意不同用于验证跨组去重取 G1）
      store.mergeWorks(
        "G2",
        "抖音",
        [{ workId: "DY1", title: "示例跨平台视频", url: "https://www.douyin.com/video/dy1", publishTime: pubMs, play: 9999, like: 99, comment: 9 }],
        t20_10,
        { slot: "2026-11-20 10:00" }
      );

      // 写 G1/快手（KS_M 手工合并进来，KS_DETACH 拆出）
      store.mergeWorks(
        "G1",
        "快手",
        [
          { workId: "KS_M", title: "改名快手视频", url: "https://www.kuaishou.com/short-video/ksm", publishTime: pubMs, play: 80, like: 8, comment: 1 },
          { workId: "KS_DETACH", title: "示例跨平台视频", url: "https://www.kuaishou.com/short-video/ks_detach", publishTime: pubMs, play: 30, like: 3, comment: 0 },
        ],
        t19_12,
        { slot: "2026-11-19 12:00" }
      );
      store.mergeWorks(
        "G1",
        "快手",
        [
          { workId: "KS_M", title: "改名快手视频", url: "https://www.kuaishou.com/short-video/ksm", publishTime: pubMs, play: 180, like: 18, comment: 2 },
          { workId: "KS_DETACH", title: "示例跨平台视频", url: "https://www.kuaishou.com/short-video/ks_detach", publishTime: pubMs, play: 50, like: 5, comment: 0 },
        ],
        t20_10,
        { slot: "2026-11-20 10:00" }
      );

      // 写 link-overrides：KS_M assign 到 file:/v/demo.mp4；KS_DETACH detach
      store.writeLinkOverrides({
        contents: {},
        excludedAuto: { "快手|KS_DETACH": true },
        overrides: {
          "快手|KS_M": { action: "assign", contentKey: "file:/v/demo.mp4" },
          "快手|KS_DETACH": { action: "detach" },
        },
      });

      // 校验 buildContentSummaryData 的 lastCollectedAt 与关联结果
      const summary = statsExport.buildContentSummaryData({ pushDataDir });
      const demoRow = summary.rows.find((r) => r.contentKey === "file:/v/demo.mp4");
      assert.ok(demoRow, "应存在汇总行 file:/v/demo.mp4");
      assert.strictEqual(demoRow.platformCount, 2, "手工 assign 后应覆盖抖音+快手 2 个平台");
      assert.strictEqual(demoRow.lastCollectedAt, t20_10, "汇总行最近采集应取各平台作品最大 collectedAt");
      const detachRow = summary.rows.find((r) => r.contentKey === "unlinked:快手:KS_DETACH");
      assert.ok(detachRow, "被拆出作品应独立成行");
      assert.strictEqual(detachRow.lastCollectedAt, t20_10);

      // 校验 buildContentIntradayData 默认 3 天（2026-11-18..2026-11-20）
      const intra3 = statsExport.buildContentIntradayData({
        contentKey: "file:/v/demo.mp4",
        pushDataDir,
      });
      assert.strictEqual(intra3.found, true);
      assert.strictEqual(intra3.days, 3);
      assert.strictEqual(intra3.from, "2026-11-18");
      assert.strictEqual(intra3.to, "2026-11-20");
      assert.deepStrictEqual(intra3.timePoints, [
        "2026-11-18 10:00",
        "2026-11-19 10:00",
        "2026-11-19 12:00",
        "2026-11-20 08:00",
        "2026-11-20 10:00",
      ]);
      const dySeries = intra3.platforms.find((x) => x.platform === "抖音");
      const ksSeries = intra3.platforms.find((x) => x.platform === "快手");
      assert.ok(dySeries && ksSeries, "应包含抖音与手工合并的快手（不含拆出的 KS_DETACH）");
      // 跨组去重取 G1：2026-11-20 10:00 抖音播放为 520 而非 G2 的 9999
      assert.deepStrictEqual(dySeries.play, [100, 220, null, 400, 520]);
      assert.deepStrictEqual(dySeries.playDelta, [null, 120, null, 180, 120]);
      // 快手仅含 KS_M（不含拆出的 KS_DETACH）
      assert.deepStrictEqual(ksSeries.play, [null, null, 80, null, 180]);
      assert.deepStrictEqual(ksSeries.playDelta, [null, null, null, null, 100]);
      assert.deepStrictEqual(intra3.totalPlayDelta, [null, 120, null, 180, 220]);

      // days = 1（仅 2026-11-20），首点 08:00 仍应跨边界算增量（400 - 220 = 180）
      const intra1 = statsExport.buildContentIntradayData({
        contentKey: "file:/v/demo.mp4",
        days: 1,
        pushDataDir,
      });
      assert.strictEqual(intra1.from, "2026-11-20");
      assert.strictEqual(intra1.to, "2026-11-20");
      assert.deepStrictEqual(intra1.timePoints, ["2026-11-20 08:00", "2026-11-20 10:00"]);
      assert.deepStrictEqual(intra1.platforms.find((x) => x.platform === "抖音").playDelta, [180, 120]);
      assert.deepStrictEqual(intra1.totalPlayDelta, [180, 220]);

      // 拆出作品单独查分时段走势
      const detachIntra = statsExport.buildContentIntradayData({
        contentKey: "unlinked:快手:KS_DETACH",
        days: 7,
        pushDataDir,
      });
      assert.strictEqual(detachIntra.found, true);
      assert.deepStrictEqual(detachIntra.timePoints, ["2026-11-19 12:00", "2026-11-20 10:00"]);
      assert.deepStrictEqual(detachIntra.platforms[0].play, [30, 50]);
      assert.deepStrictEqual(detachIntra.platforms[0].playDelta, [null, 20]);

      // IPC stats:get-content-intraday 本地页面校验与参数校验
      registerDataStatsIpc();
      const intradayHandler = ipcHandlers.get("stats:get-content-intraday");
      assert.strictEqual(typeof intradayHandler, "function", "应注册 stats:get-content-intraday IPC");

      const remoteEv = { senderFrame: { url: "https://evil.example.com" } };
      const localEv = { senderFrame: { url: "file:///app/index.html" } };
      const blockedRes = await intradayHandler(remoteEv, { contentKey: "file:/v/demo.mp4" });
      assert.strictEqual(blockedRes.ok, false);

      const emptyKeyRes = await intradayHandler(localEv, { contentKey: "   " });
      assert.strictEqual(emptyKeyRes.ok, false);

      const badDaysRes = await intradayHandler(localEv, { contentKey: "file:/v/demo.mp4", days: 0 });
      assert.strictEqual(badDaysRes.ok, false);

      const okRes = await intradayHandler(localEv, { contentKey: "file:/v/demo.mp4", days: 3 });
      assert.strictEqual(okRes.ok, true);
      assert.strictEqual(okRes.found, true);
      assert.deepStrictEqual(okRes.timePoints, intra3.timePoints);
      assert.deepStrictEqual(okRes.totalPlayDelta, intra3.totalPlayDelta);
      console.log("✓ 7. buildContentIntradayData、stats:get-content-intraday 与汇总关联及 lastCollectedAt 一致");
    }

    /* ---------- 8. S9-fix #4/#5/#6/#7 专项回归（使用评审时刻与数字，修前失败、修后通过） ---------- */
    {
      // testS9Fix4_PersistedRetentionDaysAcrossRestartAndAllEntries
      // 评审 #4：已保存 retentionDays=90 并关闭自动采集，重启后首次手动同步不得按 60 天删除 70 天前分时快照
      {
        const fix4Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix4-"));
        const origGetPath = require.cache[electronId].exports.app.getPath;
        const origHandle = require.cache[electronId].exports.ipcMain.handle;
        const origCollector = require.cache[collectorId].exports.collectAccount;
        const origDateNow = Date.now;
        const fix4Handlers = new Map();
        const tToday = cnTime(2026, 11, 20, 11, 0, 0);
        try {
          require.cache[electronId].exports.app.getPath = (name) =>
            name === "documents" ? docsDir : fix4Root;
          require.cache[electronId].exports.ipcMain.handle = (ch, fn) => fix4Handlers.set(ch, fn);
          require.cache[collectorId].exports.collectAccount = async () => ({
            overview: { plays: 100 },
            fansHistory: [],
            works: [{ workId: "R4_W1", title: "保留期测试", play: 100 }],
          });
          Date.now = () => tToday;

          delete require.cache[storeId];
          delete require.cache[indexId];
          const store4a = require(storeId);
          require(indexId).registerDataStatsIpc();

          // 预置 70 天前（2026-09-11）和 95 天前（2026-08-17）分时快照
          const dir4 = store4a.worksIntradayDir("保留组", "抖音");
          fs.mkdirSync(dir4, { recursive: true });
          const oldSnap = (d) =>
            JSON.stringify({
              date: d,
              slots: { "10:00": { collectedAt: cnTime(2026, 9, 1, 10, 0), works: { R4_W1: { play: 10 } } } },
            });
          fs.writeFileSync(path.join(dir4, "2026-09-11.json"), oldSnap("2026-09-11")); // 70 天前
          fs.writeFileSync(path.join(dir4, "2026-08-17.json"), oldSnap("2026-08-17")); // 95 天前

          // 保存 retentionDays=90 并关闭自动采集（验证落盘在与 auto-run.json 同目录）
          const saveRes = await fix4Handlers.get("stats:save-auto-settings")(
            { senderFrame: { url: "file:///app/index.html" } },
            { enabled: false, mode: "daily", retentionDays: 90 }
          );
          assert.strictEqual(saveRes.ok, true);
          assert.strictEqual(saveRes.settings.retentionDays, 90);
          assert.strictEqual(
            path.dirname(store4a.autoSettingsFile()),
            path.dirname(store4a.autoRunFile()),
            "retentionDays 设置文件须与 auto-run.json 同目录"
          );
          assert.strictEqual(fs.existsSync(store4a.autoSettingsFile()), true);

          // 模拟进程重启：清 require.cache 并重新注册 IPC，直接手动同步（即使调用方误传 retentionDays=60 也不得覆盖主进程 90）
          fix4Handlers.clear();
          delete require.cache[storeId];
          delete require.cache[indexId];
          const store4b = require(storeId);
          require(indexId).registerDataStatsIpc();

          // 额外放入边界文件 2026-08-22.json（恰 90 天前 → 保留）与 2026-08-21.json（91 天前 → 删）
          fs.writeFileSync(path.join(dir4, "2026-08-22.json"), oldSnap("2026-08-22"));
          fs.writeFileSync(path.join(dir4, "2026-08-21.json"), oldSnap("2026-08-21"));

          // 一次性迁移 initOnly:true 在主进程已有设置时不得覆盖 90
          const initRes = await fix4Handlers.get("stats:save-auto-settings")(
            { senderFrame: { url: "file:///app/index.html" } },
            { enabled: false, mode: "daily", retentionDays: 60, initOnly: true }
          );
          assert.strictEqual(initRes.ok, true);
          assert.strictEqual(initRes.settings.retentionDays, 90, "主进程已有保留期时 initOnly 迁移不得覆盖");

          // 即使采集 IPC 携带 retentionDays=60，主进程也必须忽略并以自身持久化 90 为准
          const colRes = await fix4Handlers.get("stats:collect")(
            { sender: { send: () => {} } },
            {
              accounts: [{ group: "保留组", platform: "抖音", partition: "persist:r4-dy" }],
              trigger: "manual",
              retentionDays: 60,
            }
          );
          assert.strictEqual(colRes.results[0].success, true);
          assert.strictEqual(store4b.readAutoSettings().retentionDays, 90, "采集 IPC 不得覆盖主进程 retentionDays");
          assert.strictEqual(
            fs.existsSync(path.join(dir4, "2026-09-11.json")),
            true,
            "重启后手动同步必须沿用主进程 retentionDays=90，不得删除 70 天前快照"
          );
          assert.strictEqual(
            fs.existsSync(path.join(dir4, "2026-08-22.json")),
            true,
            "恰等于 90 天的边界文件必须保留"
          );
          assert.strictEqual(
            fs.existsSync(path.join(dir4, "2026-08-21.json")),
            false,
            "早于 今天-90天 的 91 天前快照应被清理"
          );
          assert.strictEqual(
            fs.existsSync(path.join(dir4, "2026-08-17.json")),
            false,
            "超过 90 天的 95 天前快照应被清理"
          );

          // stats:auto-run 携带 retentionDays=30 同样不得覆盖主进程 90
          await fix4Handlers.get("stats:auto-run")(
            { sender: { send: () => {} } },
            {
              accounts: [{ group: "保留组", platform: "抖音", partition: "persist:r4-auto" }],
              slot: "2026-11-20 10:00",
              slotEndMs: cnTime(2026, 11, 20, 12, 0, 0),
              retentionDays: 30,
            }
          );
          assert.strictEqual(store4b.readAutoSettings().retentionDays, 90, "stats:auto-run 不得覆盖主进程 retentionDays");
          assert.strictEqual(fs.existsSync(path.join(dir4, "2026-09-11.json")), true);

          // stats:match-works 入口同样共用主进程 retentionDays=90，且忽略调用方传入的 30
          const dir4b = store4a.worksIntradayDir("匹配保留组", "快手");
          fs.mkdirSync(dir4b, { recursive: true });
          fs.writeFileSync(path.join(dir4b, "2026-09-11.json"), oldSnap("2026-09-11")); // 70 天前
          fs.writeFileSync(path.join(dir4b, "2026-08-17.json"), oldSnap("2026-08-17")); // 95 天前
          await fix4Handlers.get("stats:match-works")(
            {},
            {
              retentionDays: 30,
              tasks: [
                { key: "k1", group: "匹配保留组", platform: "快手", partition: "persist:r4-ks", title: "保留期测试" },
              ],
            }
          );
          assert.strictEqual(store4b.readAutoSettings().retentionDays, 90);
          assert.strictEqual(fs.existsSync(path.join(dir4b, "2026-09-11.json")), true, "match-works 须共用主进程 retentionDays=90");
          assert.strictEqual(fs.existsSync(path.join(dir4b, "2026-08-17.json")), false);

          // 只有设置保存 IPC（非 initOnly）才能修改主进程 retentionDays
          const explicitSave = await fix4Handlers.get("stats:save-auto-settings")(
            { senderFrame: { url: "file:///app/index.html" } },
            { retentionDays: 120 }
          );
          assert.strictEqual(explicitSave.ok, true);
          assert.strictEqual(explicitSave.settings.retentionDays, 120);
          assert.strictEqual(store4b.readAutoSettings().retentionDays, 120);

          // 未设置过的新 userData 目录：initOnly:true 可一次性迁移渲染层缓存，后续再次 initOnly 不覆盖；无迁移时默认 60 天
          const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix4-def-"));
          try {
            require.cache[electronId].exports.app.getPath = (name) =>
              name === "documents" ? docsDir : defaultRoot;
            fix4Handlers.clear();
            delete require.cache[storeId];
            delete require.cache[indexId];
            const storeDef = require(storeId);
            require(indexId).registerDataStatsIpc();
            const dirDef = storeDef.worksIntradayDir("默认组", "抖音");
            fs.mkdirSync(dirDef, { recursive: true });
            fs.writeFileSync(path.join(dirDef, "2026-09-16.json"), oldSnap("2026-09-16")); // 65 天前 → 删
            fs.writeFileSync(path.join(dirDef, "2026-09-26.json"), oldSnap("2026-09-26")); // 55 天前 → 留
            await fix4Handlers.get("stats:collect")(
              { sender: { send: () => {} } },
              { accounts: [{ group: "默认组", platform: "抖音", partition: "persist:def-dy" }], trigger: "manual" }
            );
            assert.strictEqual(fs.existsSync(path.join(dirDef, "2026-09-16.json")), false, "未设置 retentionDays 默认 60 天，65 天前应清理");
            assert.strictEqual(fs.existsSync(path.join(dirDef, "2026-09-26.json")), true, "55 天前应保留");

            // 尚无 auto-settings.json 时 initOnly:true 一次性迁移为 90，二次 initOnly:true(60) 不覆盖
            assert.strictEqual(fs.existsSync(storeDef.autoSettingsFile()), false);
            const firstMig = await fix4Handlers.get("stats:save-auto-settings")(
              { senderFrame: { url: "file:///app/index.html" } },
              { enabled: false, mode: "daily", retentionDays: 90, initOnly: true }
            );
            assert.strictEqual(firstMig.settings.retentionDays, 90);
            const secondMig = await fix4Handlers.get("stats:save-auto-settings")(
              { senderFrame: { url: "file:///app/index.html" } },
              { enabled: false, mode: "daily", retentionDays: 60, initOnly: true }
            );
            assert.strictEqual(secondMig.settings.retentionDays, 90);
            assert.strictEqual(storeDef.readAutoSettings().retentionDays, 90);
          } finally {
            fs.rmSync(defaultRoot, { recursive: true, force: true });
          }
        } finally {
          Date.now = origDateNow;
          require.cache[electronId].exports.app.getPath = origGetPath;
          require.cache[electronId].exports.ipcMain.handle = origHandle;
          require.cache[collectorId].exports.collectAccount = origCollector;
          delete require.cache[storeId];
          delete require.cache[indexId];
          fs.rmSync(fix4Root, { recursive: true, force: true });
        }
        console.log("✓ [S9-r3 #1] testS9R3_1_MainProcessAuthoritativeRetentionDays 通过");
      }

      // testS9R3_2_MidnightWriteUsesCollectNowDateConsistently
      // 评审2 #2：22:01 采到 170，23:59:59.900 采到 250，daily.json 替换完成时跨到 00:00:00.100；
      // 整次写入统一以 collectNow 的 UTC+8 日期 2026-11-20 归档，daily/works/works-daily/works-intraday 全部一致为 250，不留半次写入
      {
        const fix5Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9r3-2-"));
        const origGetPath = require.cache[electronId].exports.app.getPath;
        const origHandle = require.cache[electronId].exports.ipcMain.handle;
        const origCollector = require.cache[collectorId].exports.collectAccount;
        const origDateNow = Date.now;
        const origRename = fs.renameSync;
        const fix5Handlers = new Map();
        let mockPlay = 170;
        try {
          require.cache[electronId].exports.app.getPath = (name) =>
            name === "documents" ? docsDir : fix5Root;
          require.cache[electronId].exports.ipcMain.handle = (ch, fn) => fix5Handlers.set(ch, fn);
          require.cache[collectorId].exports.collectAccount = async () => ({
            overview: { plays: mockPlay, fans: 10 },
            fansHistory: [],
            works: [{ workId: "W1", title: "短片", publishTime: cnTime(2026, 11, 20, 8, 0, 0), play: mockPlay }],
          });
          delete require.cache[storeId];
          delete require.cache[indexId];
          const store5 = require(storeId);
          require(indexId).registerDataStatsIpc();

          const g = "示例";
          const p = "抖音";
          const acc = { group: g, platform: p, partition: "persist:demo抖音" };
          const day = "2026-11-20";
          const midnight = cnTime(2026, 11, 21, 0, 0, 0);

          // 1) 22:01 手动采集 170
          let mockNow = cnTime(2026, 11, 20, 22, 1, 0);
          Date.now = () => mockNow;
          mockPlay = 170;
          const rInit = await fix5Handlers.get("stats:collect")(
            { sender: { send: () => {} } },
            { accounts: [acc], trigger: "manual" }
          );
          assert.strictEqual(rInit.results[0].success, true);

          // 2) 23:59:59.900 采到 250，daily.json 替换完成瞬间时钟跨到 2026-11-21 00:00:00.100
          mockNow = midnight - 100;
          mockPlay = 250;
          let rolled = false;
          fs.renameSync = (src, dest) => {
            const out = origRename(src, dest);
            if (!rolled && typeof dest === "string" && path.basename(dest) === "daily.json") {
              rolled = true;
              mockNow = midnight + 100;
            }
            return out;
          };

          const rMid = await fix5Handlers.get("stats:collect")(
            { sender: { send: () => {} } },
            { accounts: [acc], trigger: "manual" }
          );
          fs.renameSync = origRename;

          assert.strictEqual(rolled, true, "确认 daily.json 替换时跨过零点");
          assert.strictEqual(rMid.results[0].success, true, "零点前采到的数据应完整写入并成功返回");
          assert.strictEqual(Boolean(rMid.results[0].dayRolled), false, "不再中途 abort 置 dayRolled");
          assert.strictEqual(store5.readDaily(g, p)[day].plays, 250, "账号日快照为 250");
          assert.strictEqual(store5.readDaily(g, p)["2026-11-21"], undefined, "不得拆写到次日 daily");
          assert.strictEqual(store5.readWorks(g, p).works[0].play, 250, "works.json 为 250");
          assert.strictEqual(store5.readWorksDaily(g, p).W1[day].play, 250, "works-daily 必须同步为 250（非半次写入 170）");
          assert.strictEqual(store5.readWorksDaily(g, p).W1["2026-11-21"], undefined, "不得拆写到次日 works-daily");
          assert.deepStrictEqual(
            store5.readWorksIntraday(g, p).W1.map((x) => [x.date, x.slot, x.play]),
            [
              ["2026-11-20", "22:00", 170],
              ["2026-11-20", "23:00", 250],
            ],
            "works-intraday 必须完整写入 2026-11-20 的 23:00 槽 (250)"
          );
          assert.strictEqual(
            fs.existsSync(path.join(store5.worksIntradayDir(g, p), "2026-11-21.json")),
            false,
            "不得生成次日 works-intraday 文件"
          );

          // 3) stats:match-works 写入跨零点同样三类文件一致归档到 collectNow 所属日期
          const gMatch = "匹配跨零点组";
          mockNow = midnight - 100;
          mockPlay = 320;
          let rolledMatch = false;
          fs.renameSync = (src, dest) => {
            const out = origRename(src, dest);
            if (!rolledMatch && typeof dest === "string" && path.basename(dest) === "daily.json") {
              rolledMatch = true;
              mockNow = midnight + 100;
            }
            return out;
          };
          const matchOut = await fix5Handlers.get("stats:match-works")(
            {},
            { tasks: [{ key: "m1", group: gMatch, platform: p, partition: "persist:m-mid", title: "短片" }] }
          );
          fs.renameSync = origRename;
          assert.strictEqual(rolledMatch, true);
          assert.strictEqual(matchOut.matches.m1.found, true);
          assert.strictEqual(store5.readDaily(gMatch, p)[day].plays, 320);
          assert.strictEqual(store5.readWorksDaily(gMatch, p).W1[day].play, 320);
          assert.strictEqual(store5.readWorksIntraday(gMatch, p).W1[0].date, day);
          assert.strictEqual(store5.readWorksIntraday(gMatch, p).W1[0].play, 320);
        } finally {
          fs.renameSync = origRename;
          Date.now = origDateNow;
          require.cache[electronId].exports.app.getPath = origGetPath;
          require.cache[electronId].exports.ipcMain.handle = origHandle;
          require.cache[collectorId].exports.collectAccount = origCollector;
          delete require.cache[storeId];
          delete require.cache[indexId];
          fs.rmSync(fix5Root, { recursive: true, force: true });
        }
        console.log("✓ [S9-r3 #2] testS9R3_2_MidnightWriteUsesCollectNowDateConsistently 通过");
      }

      // testS9Fix6_IntradayTrendAndRowsSortByActualCollectedAt
      // 评审 #6：10:30 自动槽在 10:31 采到 100 播放，10:40 手动采到 150（归入 10:00）；按实际 collectedAt 排序 → 增量 +50、距上次 0.15h
      {
        const fix6Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix6-"));
        const origGetPath = require.cache[electronId].exports.app.getPath;
        try {
          require.cache[electronId].exports.app.getPath = (name) =>
            name === "documents" ? docsDir : fix6Root;
          delete require.cache[storeId];
          delete require.cache[exportId];
          const store6 = require(storeId);
          const export6 = require(exportId);

          const pub = cnTime(2026, 11, 20, 8, 0, 0);
          const t1031 = cnTime(2026, 11, 20, 10, 31, 0);
          const t1040 = cnTime(2026, 11, 20, 10, 40, 0);
          // 10:30 自动槽 @ 10:31 采到 100
          store6.mergeWorks(
            "排序组",
            "抖音",
            [{ workId: "W6", title: "短片", publishTime: pub, play: 100, like: 10, comment: 2 }],
            t1031,
            { slot: "2026-11-20 10:30" }
          );
          // 10:40 手动采集（无 slot → 归入 10:00）采到 150
          store6.mergeWorks(
            "排序组",
            "抖音",
            [{ workId: "W6", title: "短片", publishTime: pub, play: 150, like: 15, comment: 3 }],
            t1040
          );

          const read6 = store6.readWorksIntraday("排序组", "抖音");
          assert.deepStrictEqual(
            read6.W6.map((x) => `${x.slot}@${x.play}`),
            ["10:30@100", "10:00@150"],
            "readWorksIntraday 须按实际 collectedAt 升序"
          );

          const rows6 = buildWorkIntradayRows({
            group: "排序组",
            platform: "抖音",
            works: [{ workId: "W6", title: "短片", publishTime: pub }],
            worksIntraday: read6,
          });
          assert.strictEqual(rows6.length, 2);
          assert.strictEqual(rows6[0].slot, "10:30");
          assert.strictEqual(rows6[0].play, 100);
          assert.strictEqual(rows6[0].playDelta, null);
          assert.strictEqual(rows6[0].hoursSincePrev, null);
          assert.strictEqual(rows6[1].slot, "10:00");
          assert.strictEqual(rows6[1].play, 150);
          assert.strictEqual(rows6[1].playDelta, 50, "10:40 手动采集相对 10:31 应为 +50 而非 -50");
          assert.strictEqual(rows6[1].likeDelta, 5);
          assert.strictEqual(rows6[1].commentDelta, 1);
          assert.strictEqual(rows6[1].hoursSincePrev, 0.15, "9 分钟 = 0.15 小时");

          const trend6 = export6.buildContentIntradayData({
            contentKey: "unlinked:抖音:W6",
            pushDataDir,
          });
          assert.strictEqual(trend6.found, true);
          assert.deepStrictEqual(trend6.timePoints, ["2026-11-20 10:30", "2026-11-20 10:00"]);
          assert.deepStrictEqual(trend6.collectedAts, [t1031, t1040]);
          assert.deepStrictEqual(trend6.platforms[0].play, [100, 150]);
          assert.deepStrictEqual(trend6.platforms[0].playDelta, [null, 50]);
          assert.deepStrictEqual(trend6.totalPlayDelta, [null, 50]);
        } finally {
          require.cache[electronId].exports.app.getPath = origGetPath;
          delete require.cache[storeId];
          delete require.cache[exportId];
          fs.rmSync(fix6Root, { recursive: true, force: true });
        }
        console.log("✓ [S9-fix #6] testS9Fix6_IntradayTrendAndRowsSortByActualCollectedAt 通过");
      }

      // testS9R3_4_CrossPlatformIntradayUsesOwnCollectedAtAndDelta
      // 评审2 #4：抖音 10:31→100 (10:30 槽) 与 10:40→150 (10:00 槽)，同时快手 10:29→100 (10:00 槽) 与 10:31:02→150 (10:30 槽)；
      // 两平台曲线必须按各自实际 collectedAt 递增、各自增量 [+50] 落在第二点，不再因共享槽轴把快手倒序画成 150→100
      {
        const r3_4Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9r3-4-"));
        const r3_4Push = path.join(r3_4Root, "pushData");
        fs.mkdirSync(r3_4Push, { recursive: true });
        const origGetPath = require.cache[electronId].exports.app.getPath;
        try {
          require.cache[electronId].exports.app.getPath = (name) =>
            name === "documents" ? docsDir : r3_4Root;
          delete require.cache[storeId];
          delete require.cache[exportId];
          const store4 = require(storeId);
          const export4 = require(exportId);

          const day = "2026-11-20";
          const pub = cnTime(2026, 11, 20, 8, 0, 0);
          const t1029 = cnTime(2026, 11, 20, 10, 29, 0);
          const t1031 = cnTime(2026, 11, 20, 10, 31, 0);
          const t103102 = cnTime(2026, 11, 20, 10, 31, 2);
          const t1040 = cnTime(2026, 11, 20, 10, 40, 0);
          const dyUrl = "https://www.douyin.com/video/123456";
          const ksUrl = "https://www.kuaishou.com/short-video/ks1";

          fs.writeFileSync(
            path.join(r3_4Push, `${day}.json`),
            JSON.stringify([
              { id: "123456", filePath: "/v/sample.mp4", title: "样片", pt: "抖音", group: "示例", videoLink: dyUrl, publishStatus: "success", lastPublishAt: pub },
              { id: "ks1", filePath: "/v/sample.mp4", title: "样片", pt: "快手", group: "示例", videoLink: ksUrl, publishStatus: "success", lastPublishAt: pub },
            ])
          );

          store4.mergeWorks("示例", "快手", [{ workId: "ks1", title: "样片", publishTime: pub, play: 100, url: ksUrl }], t1029);
          store4.mergeWorks("示例", "抖音", [{ workId: "123456", title: "样片", publishTime: pub, play: 100, url: dyUrl }], t1031, { slot: `${day} 10:30` });
          store4.mergeWorks("示例", "快手", [{ workId: "ks1", title: "样片", publishTime: pub, play: 150, url: ksUrl }], t103102, { slot: `${day} 10:30` });
          store4.mergeWorks("示例", "抖音", [{ workId: "123456", title: "样片", publishTime: pub, play: 150, url: dyUrl }], t1040);

          const trend = export4.buildContentIntradayData({
            contentKey: "file:/v/sample.mp4",
            days: 1,
            pushDataDir: r3_4Push,
          });
          assert.strictEqual(trend.found, true);
          assert.deepStrictEqual(trend.collectedAts, [t1029, t1031, t103102, t1040], "全局时间戳必须严格按实际 collectedAt 升序");

          const dy = trend.platforms.find((x) => x.platform === "抖音");
          const ks = trend.platforms.find((x) => x.platform === "快手");
          assert.ok(dy && ks);

          // 抖音自身时间线：10:31 (100, delta null, 槽 10:30) → 10:40 (150, delta +50, 槽 10:00)
          assert.deepStrictEqual(
            dy.points.map((x) => [x.collectedAt, x.slot, x.play, x.playDelta]),
            [
              [t1031, "10:30", 100, null],
              [t1040, "10:00", 150, 50],
            ]
          );
          // 快手自身时间线：10:29 (100, delta null, 槽 10:00) → 10:31:02 (150, delta +50, 槽 10:30)
          assert.deepStrictEqual(
            ks.points.map((x) => [x.collectedAt, x.slot, x.play, x.playDelta]),
            [
              [t1029, "10:00", 100, null],
              [t103102, "10:30", 150, 50],
            ],
            "快手曲线必须保持 100→150 增长且 +50 落在第二点，绝不得倒序为 150→100"
          );
          assert.deepStrictEqual(ks.play, [100, null, 150, null]);
          assert.deepStrictEqual(ks.playDelta, [null, null, 50, null]);
          assert.deepStrictEqual(dy.play, [null, 100, null, 150]);
          assert.deepStrictEqual(dy.playDelta, [null, null, null, 50]);
          assert.deepStrictEqual(trend.totalPlayDelta, [null, null, 50, 50]);
        } finally {
          require.cache[electronId].exports.app.getPath = origGetPath;
          delete require.cache[storeId];
          delete require.cache[exportId];
          fs.rmSync(r3_4Root, { recursive: true, force: true });
        }
        console.log("✓ [S9-r3 #4] testS9R3_4_CrossPlatformIntradayUsesOwnCollectedAtAndDelta 通过");
      }

      // testS9Fix7_First24hNormalizedFirstPublishTimeAndCutoffByCollectedAt
      // 评审 #7：抖音 11-19 08:00 首发（仅旧日快照），快手次日 10:00 补发，12:00 采集（距首发 28h > 24h 不画）；
      // 跨零点 23:00 槽于 11-21 00:05 采集，分析截止日 11-20 不得纳入该点
      {
        const fix7Root = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s9fix7-"));
        const fix7Push = path.join(fix7Root, "pushData");
        fs.mkdirSync(fix7Push, { recursive: true });
        const origGetPath = require.cache[electronId].exports.app.getPath;
        try {
          require.cache[electronId].exports.app.getPath = (name) =>
            name === "documents" ? docsDir : fix7Root;
          delete require.cache[storeId];
          delete require.cache[exportId];
          const store7 = require(storeId);
          const export7 = require(exportId);

          const firstPub = cnTime(2026, 11, 19, 8, 0, 0);
          const secondPub = cnTime(2026, 11, 20, 10, 0, 0);
          const collectNoon = cnTime(2026, 11, 20, 12, 0, 0);
          const firstUrl = "https://www.douyin.com/video/fix7dy1";
          const secondUrl = "https://www.kuaishou.com/short-video/fix7ks1";

          fs.writeFileSync(
            path.join(fix7Push, "2026-11-19.json"),
            JSON.stringify([
              {
                id: "fix7-first",
                filePath: "/v/fix7-sample.mp4",
                title: "样片",
                pt: "抖音",
                group: "示例",
                videoLink: firstUrl,
                publishStatus: "success",
                lastPublishAt: firstPub,
              },
            ])
          );
          fs.writeFileSync(
            path.join(fix7Push, "2026-11-20.json"),
            JSON.stringify([
              {
                id: "fix7-repost",
                filePath: "/v/fix7-sample.mp4",
                title: "样片",
                pt: "快手",
                group: "示例",
                videoLink: secondUrl,
                publishStatus: "success",
                lastPublishAt: secondPub,
              },
            ])
          );

          // 抖音仅有旧版 works-daily + works.json，无 intraday
          const dyDailyDir = store7.worksDailyDir("示例", "抖音");
          fs.mkdirSync(dyDailyDir, { recursive: true });
          fs.writeFileSync(
            path.join(dyDailyDir, "2026-11-19.json"),
            JSON.stringify({
              date: "2026-11-19",
              updatedAt: cnTime(2026, 11, 19, 10, 0, 0),
              works: { dy1: { play: 100 } },
            })
          );
          fs.writeFileSync(
            path.join(path.dirname(dyDailyDir), "works.json"),
            JSON.stringify({
              works: [{ workId: "dy1", title: "样片", url: firstUrl, publishTime: firstPub, play: 100 }],
            })
          );

          // 快手 11-20 10:00 补发，12:00 采集（距内容首发 11-19 08:00 已 28h）
          store7.mergeWorks(
            "示例",
            "快手",
            [{ workId: "ks1", title: "样片", url: secondUrl, publishTime: secondPub, play: 250 }],
            collectNoon
          );

          const analysisRepub = export7.buildStatsAnalysisData({
            pushDataDir: fix7Push,
            now: collectNoon,
          });
          assert.strictEqual(
            analysisRepub.newWorksFirst24h.items.find((r) => r.contentKey === "file:/v/fix7-sample.mp4"),
            undefined,
            "实际距最早首发已 28 小时 > 24 小时，不得以补发时间作为起点画出 2h 点"
          );

          // 跨零点截止日校验：作品 11-20 22:00 发布，11-21 00:05 采集归入 11-20 23:00 槽
          const nightPub = cnTime(2026, 11, 20, 22, 0, 0);
          const t2310 = cnTime(2026, 11, 20, 23, 10, 0);
          const t0005 = cnTime(2026, 11, 21, 0, 5, 0);
          store7.mergeWorks(
            "示例",
            "抖音",
            [{ workId: "night1", title: "跨夜作品", publishTime: nightPub, play: 120 }],
            t2310,
            { slot: "2026-11-20 22:00" }
          );
          store7.mergeWorks(
            "示例",
            "抖音",
            [{ workId: "night1", title: "跨夜作品", publishTime: nightPub, play: 350 }],
            t0005,
            { slot: "2026-11-20 23:00" }
          );

          // 截止日选 2026-11-20：只含 23:10 点，不得纳入 11-21 00:05 采集点
          const analysisTo20 = export7.buildStatsAnalysisData({
            pushDataDir: fix7Push,
            to: "2026-11-20",
            now: cnTime(2026, 11, 21, 10, 0, 0),
          });
          const nightItem20 = analysisTo20.newWorksFirst24h.items.find(
            (r) => r.contentKey === "unlinked:抖音:night1"
          );
          assert.ok(nightItem20, "11-20 23:10 采集点应在截止日 11-20 内");
          assert.strictEqual(nightItem20.points.length, 1, "11-21 00:05 采集点不得出现在截止日 11-20 的前 24h 曲线中");
          assert.strictEqual(nightItem20.points[0].play, 120);

          // 截止日选 2026-11-21：两个点均包含
          const analysisTo21 = export7.buildStatsAnalysisData({
            pushDataDir: fix7Push,
            to: "2026-11-21",
            now: cnTime(2026, 11, 21, 10, 0, 0),
          });
          const nightItem21 = analysisTo21.newWorksFirst24h.items.find(
            (r) => r.contentKey === "unlinked:抖音:night1"
          );
          assert.ok(nightItem21);
          assert.deepStrictEqual(
            nightItem21.points.map((x) => x.play),
            [120, 350]
          );
        } finally {
          require.cache[electronId].exports.app.getPath = origGetPath;
          delete require.cache[storeId];
          delete require.cache[exportId];
          fs.rmSync(fix7Root, { recursive: true, force: true });
        }
        console.log("✓ [S9-fix #7] testS9Fix7_First24hNormalizedFirstPublishTimeAndCutoffByCollectedAt 通过");
      }
    }
  } finally {
    if (origElectronCache) require.cache[electronId] = origElectronCache;
    else delete require.cache[electronId];
    if (origCollectorCache) require.cache[collectorId] = origCollectorCache;
    else delete require.cache[collectorId];
    delete require.cache[storeId];
    delete require.cache[exportId];
    delete require.cache[indexId];
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log("\ntest-works-intraday: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
