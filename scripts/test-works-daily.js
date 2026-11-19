/**
 * 作品日快照存储（store.js）与长表行构建（statsTable.js）单元测试（不依赖 Electron 运行环境）：
 * 1. statsTable.js 纯函数模块独立加载（不依赖 electron / fs）
 * 2. store.mergeWorks → works-daily.json：同日覆盖、UTC+8 切日、跨日累计、null 指标、缺席作品不伪造
 * 3. store.mergeWorks：works-daily.json 写失败（EISDIR / EACCES）仅 warn，不影响 works.json 与返回值
 * 4. 读失败不清空历史：① JSON 损坏（保留原文件 + 生成 corrupt 备份）+ 根结构非对象；② 读 EIO（保留完整历史）
 * 5. 原子写与容错：③ 写入中途 ENOSPC（writeSync 半写 / fsyncSync）保留旧文件并清临时文件；rename EPERM/EBUSY 重试
 * 6. 跨进程锁：④ 双进程交错写入（锁内重读合并，多日数据都在）+ 锁超时告警跳过；⑤ 陈旧锁（>30s）被抢占
 * 7. ⑥ 指标校验统一（normalizeMetric）：畸形指标归 null 且不产生假增量，真实 0 照常保留
 * 8. ⑦ 特殊 workId（"__proto__" / "constructor" / "hasOwnProperty" / "toString"）无原型字典往返不丢
 * 9. buildWorkDailyRows：增量、断档 gapDays、from/to 过滤、已删除作品、排序、端到端串联与脏输入防护
 *
 * 运行：yarn test:works-daily
 */

"use strict";

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 先加载 statsTable.js（在 mock electron 之前），验证其不依赖 electron / fs
const {
  buildWorkDailyRows,
  DELETED_WORK_TITLE,
  normalizeMetric,
} = require("../src/main/services/dataStats/statsTable.js");

// mock electron.app（store.js 只用到 userData 路径）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-works-daily-test-"));
require.cache[require.resolve("electron")] = {
  id: "electron",
  filename: "electron",
  loaded: true,
  exports: { app: { getPath: () => tmpRoot } },
};

const storePath = path.resolve(__dirname, "../src/main/services/dataStats/store.js");
const store = require(storePath);

const EXPECTED_ROW_KEYS = [
  "date",
  "group",
  "platform",
  "workId",
  "title",
  "url",
  "publishTime",
  "play",
  "like",
  "comment",
  "share",
  "favorite",
  "fansDelta",
  "playDelta",
  "likeDelta",
  "commentDelta",
  "shareDelta",
  "favoriteDelta",
  "fansDeltaDelta",
  "gapDays",
];

const SLEEP_VIEW = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  if (ms > 0) Atomics.wait(SLEEP_VIEW, 0, 0, ms);
}

function accPath(group, platform, ...rest) {
  return path.join(tmpRoot, "data-stats", group, platform, ...rest);
}

function captureWarn(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
  }
}

function listLeftoverTempOrLock(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".tmp") || f.endsWith(".lock") || f.endsWith(".reap"));
}

try {
  /* ---------- 1. store: 同日覆盖 + UTC+8 切日 + 跨日累计 + null 指标 ---------- */
  {
    const group = "测试组A";
    const platform = "抖音";

    const empty = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(empty), null, "无文件时应返回无原型空字典");
    assert.deepStrictEqual(Object.keys(empty), [], "无文件时 readWorksDaily 应无键");

    // 2026-11-10 上午 09:00（UTC+8）首次采集
    const tDay1Morning = Date.parse("2026-11-10T01:00:00Z");
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "W1",
          title: "视频一",
          url: "https://example.com/w1",
          publishTime: Date.parse("2026-11-09T10:00:00Z"),
          play: 100,
          like: 10,
          comment: 2,
          share: 1,
          favorite: 5,
          fansDelta: 3,
        },
        {
          workId: "W2",
          title: "视频二",
          url: "https://example.com/w2",
          publishTime: Date.parse("2026-11-10T00:00:00Z"),
          play: 50,
          like: 0,
          comment: 0,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      tDay1Morning
    );

    // 2026-11-10 晚上 22:00（UTC+8，同一天）二次采集：覆盖为最后一次
    const tDay1Evening = Date.parse("2026-11-10T14:00:00Z");
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "W1",
          title: "视频一",
          url: "https://example.com/w1",
          publishTime: Date.parse("2026-11-09T10:00:00Z"),
          play: 180,
          like: 15,
          comment: 4,
          share: 2,
          favorite: 8,
          fansDelta: 6,
        },
        {
          workId: "W2",
          title: "视频二",
          url: "https://example.com/w2",
          publishTime: Date.parse("2026-11-10T00:00:00Z"),
          play: 70,
          like: 1,
          comment: 0,
          share: null,
          favorite: null,
          fansDelta: null,
        },
      ],
      tDay1Evening
    );

    let daily = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(daily), null, "读回 JSON 后应为无原型字典");
    assert.deepStrictEqual(Object.keys(daily.W1), ["2026-11-10"], "同日多次采集只保留一条日期键");
    assert.deepStrictEqual(daily.W1["2026-11-10"], {
      play: 180,
      like: 15,
      comment: 4,
      share: 2,
      favorite: 8,
      fansDelta: 6,
    });
    assert.deepStrictEqual(daily.W2["2026-11-10"], {
      play: 70,
      like: 1,
      comment: 0,
      share: null,
      favorite: null,
      fansDelta: null,
    });

    // UTC 2026-11-10T16:30:00Z = UTC+8 2026-11-11 00:30 → 应记为 2026-11-11
    // 此次采集不包含 W2（模拟已删或未返回），不应伪造 W2 的 11-11 快照
    const tDay2Utc8 = Date.parse("2026-11-10T16:30:00Z");
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "W1",
          title: "视频一",
          url: "https://example.com/w1",
          publishTime: Date.parse("2026-11-09T10:00:00Z"),
          play: 260,
          like: 20,
          comment: 5,
          share: 3,
          favorite: 10,
          fansDelta: 7,
        },
      ],
      tDay2Utc8
    );

    daily = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(daily.W1).sort(), ["2026-11-10", "2026-11-11"]);
    assert.strictEqual(daily.W1["2026-11-10"].play, 180, "历史日期快照不得被覆盖");
    assert.strictEqual(daily.W1["2026-11-11"].play, 260, "UTC+8 切日后记为次日快照");
    assert.deepStrictEqual(
      Object.keys(daily.W2),
      ["2026-11-10"],
      "当日未采集到的作品不应伪造当日快照"
    );

    // 验证物理文件路径与无残留锁/临时文件
    const diskPath = accPath(group, platform, "works-daily.json");
    assert.ok(fs.existsSync(diskPath), "works-daily.json 应落在 userData/data-stats/<分组>/<平台>/");
    assert.deepStrictEqual(
      Object.assign(Object.create(null), JSON.parse(fs.readFileSync(diskPath, "utf8"))),
      daily
    );
    assert.deepStrictEqual(listLeftoverTempOrLock(accPath(group, platform)), []);
    console.log("✓ store.mergeWorks：同日覆盖 + UTC+8 切日 + 跨日累计 + null 指标正确");
  }

  /* ---------- 2. store: works-daily.json 写失败（EISDIR / EACCES）不得影响 mergeWorks ---------- */
  {
    const group = "写失败组";
    const platform = "快手";
    const dir = accPath(group, platform);
    fs.mkdirSync(dir, { recursive: true });
    // 在 works-daily.json 位置放置一个同名目录，确保读/写必然抛 EISDIR
    fs.mkdirSync(path.join(dir, "works-daily.json"));

    const { result: res, warnings } = captureWarn(() =>
      store.mergeWorks(
        group,
        platform,
        [
          {
            workId: "KS1",
            title: "快手测试",
            url: "https://kuaishou.com/ks1",
            publishTime: Date.parse("2026-11-10T08:00:00Z"),
            play: 300,
            like: 20,
            comment: 3,
            share: null,
            favorite: null,
            fansDelta: null,
          },
        ],
        Date.parse("2026-11-11T04:00:00Z")
      )
    );

    assert.strictEqual(res.works.length, 1, "写日快照失败不得影响 mergeWorks 返回值");
    assert.strictEqual(res.works[0].workId, "KS1");
    assert.strictEqual(res.works[0].play, 300);
    assert.strictEqual(store.readWorks(group, platform).works[0].play, 300, "works.json 应正常落盘");
    assert.ok(warnings.some((m) => m.includes("works-daily.json")), "失败应通过 console.warn 告警");
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), [], "失败后不应残留锁或临时文件");

    // mock 原子写打开临时文件抛 EACCES
    const origOpenSync = fs.openSync;
    fs.openSync = function patchedOpen(file, ...rest) {
      if (String(file).includes("works-daily.json") && String(file).endsWith(".tmp")) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return origOpenSync.call(fs, file, ...rest);
    };
    let out2;
    try {
      out2 = captureWarn(() =>
        store.mergeWorks(
          "写失败组2",
          "哔哩哔哩",
          [
            {
              workId: "BV1",
              title: "B站测试",
              publishTime: Date.parse("2026-11-11T02:00:00Z"),
              play: 99,
              like: 5,
              comment: 1,
              share: 0,
              favorite: 2,
              fansDelta: null,
            },
          ],
          Date.parse("2026-11-11T05:00:00Z")
        )
      );
    } finally {
      fs.openSync = origOpenSync;
    }
    assert.strictEqual(out2.result.works[0].workId, "BV1");
    assert.strictEqual(store.readWorks("写失败组2", "哔哩哔哩").works[0].play, 99);
    assert.ok(out2.warnings.some((m) => m.includes("EACCES")));
    assert.deepStrictEqual(listLeftoverTempOrLock(accPath("写失败组2", "哔哩哔哩")), []);
    console.log("✓ store.mergeWorks：works-daily 写失败只 warn，不影响 works.json 与结果");
  }

  /* ---------- 3. ① 既有历史 JSON 损坏 & 根结构非对象：不清空历史 + 生成 corrupt 备份 ---------- */
  {
    const group = "损坏恢复组";
    const platform = "抖音";
    const dir = accPath(group, platform);
    const file = path.join(dir, "works-daily.json");

    // 先写入正常历史，再制造 JSON 损坏（截断残留）
    store.mergeWorks(
      group,
      platform,
      [{ workId: "H1", title: "历史视频", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100 }],
      Date.parse("2026-11-08T04:00:00Z")
    );
    const corruptRaw = '{"H1":{"2026-11-08":{"play":100,"like":5';
    fs.writeFileSync(file, corruptRaw, "utf8");

    // readWorksDaily 必须直接抛 SyntaxError，不能静默返回空
    assert.throws(() => store.readWorksDaily(group, platform), SyntaxError);

    // mergeWorks 触发 recordWorksDaily：告警、不覆盖原文件、复制出 corrupt 备份、mergeWorks 仍成功
    const { result, warnings } = captureWarn(() =>
      store.mergeWorks(
        group,
        platform,
        [{ workId: "H1", title: "历史视频", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 220 }],
        Date.parse("2026-11-10T04:00:00Z")
      )
    );
    assert.strictEqual(result.works[0].play, 220, "mergeWorks 本身仍应成功");
    assert.strictEqual(store.readWorks(group, platform).works[0].play, 220);
    assert.strictEqual(fs.readFileSync(file, "utf8"), corruptRaw, "原 works-daily.json 字节不得被覆盖");
    assert.ok(warnings.some((m) => m.includes("works-daily.json")), "损坏时应输出告警");

    const backups = fs
      .readdirSync(dir)
      .filter((name) => /^works-daily\.corrupt-\d+\.json$/.test(name));
    assert.strictEqual(backups.length, 1, "JSON 损坏应生成一份 works-daily.corrupt-<时间戳>.json 备份");
    assert.strictEqual(
      fs.readFileSync(path.join(dir, backups[0]), "utf8"),
      corruptRaw,
      "corrupt 备份内容应与原损坏文件一致"
    );
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);

    // 根结构非对象（数组 / null / 原始类型）同样抛错且不覆盖原文件
    const groupBadRoot = "非对象根组";
    const dirBadRoot = accPath(groupBadRoot, platform);
    const fileBadRoot = path.join(dirBadRoot, "works-daily.json");
    fs.mkdirSync(dirBadRoot, { recursive: true });
    for (const badPayload of ["[]", "null", "123", '"hello"']) {
      fs.writeFileSync(fileBadRoot, badPayload, "utf8");
      assert.throws(
        () => store.readWorksDaily(groupBadRoot, platform),
        (err) => err && err.code === "EINVALID_WORKS_DAILY",
        `根结构 ${badPayload} 应抛 EINVALID_WORKS_DAILY`
      );
      const outBad = captureWarn(() =>
        store.mergeWorks(
          groupBadRoot,
          platform,
          [{ workId: "R1", title: "根测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 50 }],
          Date.parse("2026-11-10T04:00:00Z")
        )
      );
      assert.strictEqual(outBad.result.works[0].play, 50);
      assert.strictEqual(fs.readFileSync(fileBadRoot, "utf8"), badPayload, "非对象根原文件应保持不变");
      assert.ok(outBad.warnings.some((m) => m.includes("works-daily.json")));
    }
    assert.deepStrictEqual(listLeftoverTempOrLock(dirBadRoot), []);
    console.log("✓ ① JSON 损坏与非对象根：readWorksDaily 抛错、保留原文件、生成 corrupt 备份、mergeWorks 成功");
  }

  /* ---------- 4. ② 带既有历史时读 EIO（mock fs）：历史文件内容不变、无 corrupt 备份、mergeWorks 成功 ---------- */
  {
    const group = "读EIO组";
    const platform = "视频号";
    const dir = accPath(group, platform);
    const file = path.join(dir, "works-daily.json");

    store.mergeWorks(
      group,
      platform,
      [{ workId: "E1", title: "重要历史", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 500, like: 50 }],
      Date.parse("2026-11-08T04:00:00Z")
    );
    store.mergeWorks(
      group,
      platform,
      [{ workId: "E1", title: "重要历史", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 650, like: 62 }],
      Date.parse("2026-11-09T04:00:00Z")
    );
    const beforeBytes = fs.readFileSync(file, "utf8");

    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = function patchedRead(target, ...rest) {
      if (String(target) === file) {
        const err = new Error("EIO: i/o error, read");
        err.code = "EIO";
        throw err;
      }
      return origReadFileSync.call(fs, target, ...rest);
    };

    let outEio;
    try {
      assert.throws(
        () => store.readWorksDaily(group, platform),
        (err) => err && err.code === "EIO",
        "readWorksDaily 遇 EIO 应抛错"
      );
      outEio = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "E1", title: "重要历史", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 800, like: 75 }],
          Date.parse("2026-11-10T04:00:00Z")
        )
      );
    } finally {
      fs.readFileSync = origReadFileSync;
    }

    assert.strictEqual(outEio.result.works[0].play, 800, "读 EIO 不得影响 mergeWorks 返回值");
    assert.strictEqual(store.readWorks(group, platform).works[0].play, 800, "works.json 应正常更新");
    assert.ok(outEio.warnings.some((m) => m.includes("EIO")), "应记录 EIO 告警");
    assert.strictEqual(fs.readFileSync(file, "utf8"), beforeBytes, "读 EIO 后原历史文件字节必须完全不变");
    assert.strictEqual(
      fs.readdirSync(dir).filter((f) => f.includes(".corrupt-")).length,
      0,
      "读 EIO 不应生成 corrupt 备份"
    );
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);

    // EIO 恢复后可读出完整历史
    const recovered = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(recovered.E1).sort(), ["2026-11-08", "2026-11-09"]);
    assert.strictEqual(recovered.E1["2026-11-08"].play, 500);
    assert.strictEqual(recovered.E1["2026-11-09"].play, 650);
    console.log("✓ ② 带既有历史读 EIO：历史文件完整保留、无 corrupt 备份、mergeWorks 成功");
  }

  /* ---------- 5. ③ 写入中途 ENOSPC（writeSync 半写 / fsyncSync）+ renameSync 重试 ---------- */
  {
    const group = "原子写组";
    const platform = "抖音";
    const dir = accPath(group, platform);
    const file = path.join(dir, "works-daily.json");

    store.mergeWorks(
      group,
      platform,
      [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1000, like: 80 }],
      Date.parse("2026-11-08T04:00:00Z")
    );
    store.mergeWorks(
      group,
      platform,
      [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1200, like: 95 }],
      Date.parse("2026-11-09T04:00:00Z")
    );
    const intactBytes = fs.readFileSync(file, "utf8");

    // 5a. writeSync 半写（先写 16 字节再抛 ENOSPC）→ 旧文件完整可解析、临时文件已清理
    const origOpenSync = fs.openSync;
    const origWriteSync = fs.writeSync;
    const tmpFds = new Set();
    let partialDone = false;
    fs.openSync = function patchedOpen(target, ...rest) {
      const fd = origOpenSync.call(fs, target, ...rest);
      if (String(target).includes("works-daily.json") && String(target).endsWith(".tmp")) {
        tmpFds.add(fd);
      }
      return fd;
    };
    fs.writeSync = function patchedWrite(fd, buf, offset, length, position) {
      if (tmpFds.has(fd)) {
        if (!partialDone) {
          partialDone = true;
          const chunk = Math.min(16, length);
          return origWriteSync.call(fs, fd, buf, offset, chunk, position);
        }
        const err = new Error("ENOSPC: no space left on device, write");
        err.code = "ENOSPC";
        throw err;
      }
      return origWriteSync.call(fs, fd, buf, offset, length, position);
    };

    let outHalfWrite;
    try {
      outHalfWrite = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1500, like: 120 }],
          Date.parse("2026-11-10T04:00:00Z")
        )
      );
    } finally {
      fs.openSync = origOpenSync;
      fs.writeSync = origWriteSync;
    }

    assert.strictEqual(partialDone, true, "确认已命中半写路径");
    assert.strictEqual(outHalfWrite.result.works[0].play, 1500, "writeSync ENOSPC 不得影响 mergeWorks");
    assert.ok(outHalfWrite.warnings.some((m) => m.includes("ENOSPC")));
    assert.strictEqual(fs.readFileSync(file, "utf8"), intactBytes, "半写 ENOSPC 后旧文件必须字节完整不变");
    assert.deepStrictEqual(Object.keys(store.readWorksDaily(group, platform).A1).sort(), [
      "2026-11-08",
      "2026-11-09",
    ]);
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), [], "半写失败后临时文件与锁均应清理");

    // 5b. fsyncSync 抛 ENOSPC → 旧文件完整可解析、临时文件已清理
    const origFsyncSync = fs.fsyncSync;
    fs.fsyncSync = function patchedFsync() {
      const err = new Error("ENOSPC: no space left on device, fsync");
      err.code = "ENOSPC";
      throw err;
    };
    let outFsync;
    try {
      outFsync = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1600, like: 130 }],
          Date.parse("2026-11-10T05:00:00Z")
        )
      );
    } finally {
      fs.fsyncSync = origFsyncSync;
    }
    assert.strictEqual(outFsync.result.works[0].play, 1600);
    assert.ok(outFsync.warnings.some((m) => m.includes("ENOSPC")));
    assert.strictEqual(fs.readFileSync(file, "utf8"), intactBytes, "fsync ENOSPC 后旧文件必须完整可解析");
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);

    // 5c. renameSync 遇 EPERM/EBUSY 重试：前 2 次失败第 3 次成功
    const origRenameSync = fs.renameSync;
    let renameAttempts = 0;
    fs.renameSync = function patchedRename(src, dest) {
      if (String(dest) === file) {
        renameAttempts++;
        if (renameAttempts === 1) {
          const err = new Error("EPERM: operation not permitted");
          err.code = "EPERM";
          throw err;
        }
        if (renameAttempts === 2) {
          const err = new Error("EBUSY: resource busy or locked");
          err.code = "EBUSY";
          throw err;
        }
      }
      return origRenameSync.call(fs, src, dest);
    };
    try {
      store.mergeWorks(
        group,
        platform,
        [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1700, like: 140 }],
        Date.parse("2026-11-10T06:00:00Z")
      );
    } finally {
      fs.renameSync = origRenameSync;
    }
    assert.strictEqual(renameAttempts, 3, "EPERM/EBUSY 后应自动重试并成功");
    const afterRetry = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(afterRetry.A1).sort(), [
      "2026-11-08",
      "2026-11-09",
      "2026-11-10",
    ]);
    assert.strictEqual(afterRetry.A1["2026-11-10"].play, 1700);
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);

    // 5d. renameSync 连续 4 次 EBUSY（耗尽 3 次重试）→ 保留上一完整版本、清理临时文件
    const beforeExhaustBytes = fs.readFileSync(file, "utf8");
    let exhaustAttempts = 0;
    fs.renameSync = function patchedRenameFail(src, dest) {
      if (String(dest) === file) {
        exhaustAttempts++;
        const err = new Error("EBUSY: still locked");
        err.code = "EBUSY";
        throw err;
      }
      return origRenameSync.call(fs, src, dest);
    };
    let outExhaust;
    try {
      outExhaust = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1900, like: 150 }],
          Date.parse("2026-11-11T04:00:00Z")
        )
      );
    } finally {
      fs.renameSync = origRenameSync;
    }
    assert.strictEqual(exhaustAttempts, 4, "应为首次尝试 + 3 次重试共 4 次");
    assert.strictEqual(outExhaust.result.works[0].play, 1900);
    assert.ok(outExhaust.warnings.some((m) => m.includes("EBUSY")));
    assert.strictEqual(fs.readFileSync(file, "utf8"), beforeExhaustBytes, "耗尽重试后旧文件应完好保留");
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);
    console.log("✓ ③ 原子写：writeSync 半写/fsync ENOSPC 保留完整旧文件 + rename EPERM/EBUSY 重试正确");
  }

  /* ---------- 6. ④ 两个写入者交错（跨进程持锁等待、锁内重读合并）+ 锁超时告警跳过 ---------- */
  {
    const group = "并发交错组";
    const platform = "抖音";
    const dir = accPath(group, platform);
    const flagFile = path.join(tmpRoot, "child-in-lock.flag");
    const doneFile = path.join(tmpRoot, "child-done.json");
    const childLogFile = path.join(tmpRoot, "child-interleave.log");

    // 预置 Day 0 历史
    store.mergeWorks(
      group,
      platform,
      [{ workId: "W1", title: "作品一", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 50, like: 5 }],
      Date.parse("2026-11-09T04:00:00Z")
    );

    const childScript = `
      "use strict";
      const fs = require("fs");
      const tmpRoot = process.env.TEST_TMP_ROOT;
      const flagFile = process.env.TEST_FLAG_FILE;
      const doneFile = process.env.TEST_DONE_FILE;
      const storePath = process.env.TEST_STORE_PATH;
      const group = process.env.TEST_GROUP;
      const platform = process.env.TEST_PLATFORM;
      const day1Ms = Number(process.env.TEST_DAY1_MS);
      require.cache[require.resolve("electron")] = {
        id: "electron",
        filename: "electron",
        loaded: true,
        exports: { app: { getPath: () => tmpRoot } },
      };
      const sleepArr = new Int32Array(new SharedArrayBuffer(4));
      const origRead = fs.readFileSync;
      let held = false;
      fs.readFileSync = function (target, ...rest) {
        const res = origRead.call(fs, target, ...rest);
        if (!held && String(target).endsWith("works-daily.json")) {
          held = true;
          fs.writeFileSync(flagFile, String(process.pid), "utf8");
          Atomics.wait(sleepArr, 0, 0, 350);
        }
        return res;
      };
      try {
        const s = require(storePath);
        s.mergeWorks(
          group,
          platform,
          [
            { workId: "W1", title: "作品一", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100, like: 10, comment: 2, share: 1, favorite: 3, fansDelta: 1 },
            { workId: "W2", title: "作品二", publishTime: Date.parse("2026-11-02T00:00:00Z"), play: 30, like: 3, comment: 0, share: 0, favorite: 1, fansDelta: null },
          ],
          day1Ms
        );
        fs.writeFileSync(doneFile, JSON.stringify({ ok: true }), "utf8");
      } catch (err) {
        fs.writeFileSync(doneFile, JSON.stringify({ ok: false, error: (err && err.stack) || String(err) }), "utf8");
        process.exitCode = 1;
      }
    `;

    const logFd = fs.openSync(childLogFile, "w");
    const child = spawn(process.execPath, ["-e", childScript], {
      env: {
        ...process.env,
        TEST_TMP_ROOT: tmpRoot,
        TEST_FLAG_FILE: flagFile,
        TEST_DONE_FILE: doneFile,
        TEST_STORE_PATH: storePath,
        TEST_GROUP: group,
        TEST_PLATFORM: platform,
        TEST_DAY1_MS: String(Date.parse("2026-11-10T04:00:00Z")),
      },
      stdio: ["ignore", logFd, logFd],
    });
    fs.closeSync(logFd);

    try {
      // 等待子进程拿到 works-daily.json.lock 并停在读后写前
      const waitFlagDeadline = Date.now() + 5000;
      while (!fs.existsSync(flagFile) && Date.now() < waitFlagDeadline) {
        sleepSync(10);
      }
      assert.ok(fs.existsSync(flagFile), "子进程应在超时前拿到锁并写入标记");

      // 在子进程持锁期间发起第二个写入者（Day 2）
      const tStart = Date.now();
      store.mergeWorks(
        group,
        platform,
        [
          { workId: "W1", title: "作品一", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 200, like: 22, comment: 4, share: 2, favorite: 6, fansDelta: 3 },
          { workId: "W3", title: "作品三", publishTime: Date.parse("2026-11-03T00:00:00Z"), play: 80, like: 8, comment: 1, share: 0, favorite: 2, fansDelta: null },
        ],
        Date.parse("2026-11-11T04:00:00Z")
      );
      const elapsed = Date.now() - tStart;

      // 等待子进程结束写出结果
      const waitDoneDeadline = Date.now() + 5000;
      while (!fs.existsSync(doneFile) && Date.now() < waitDoneDeadline) {
        sleepSync(10);
      }
      assert.ok(fs.existsSync(doneFile), "子进程应正常完成");
      const childRes = JSON.parse(fs.readFileSync(doneFile, "utf8"));
      assert.strictEqual(childRes.ok, true, `子进程写入失败: ${childRes.error || ""}`);
      assert.ok(elapsed >= 150, `第二个写入者应等待锁释放（实际耗时 ${elapsed}ms）`);

      // 验证三日数据与两进程各自作品全部保留
      const merged = store.readWorksDaily(group, platform);
      assert.deepStrictEqual(Object.keys(merged.W1).sort(), [
        "2026-11-09",
        "2026-11-10",
        "2026-11-11",
      ]);
      assert.strictEqual(merged.W1["2026-11-09"].play, 50, "Day 0 历史应保留");
      assert.strictEqual(merged.W1["2026-11-10"].play, 100, "第一个写入者的 Day 1 不得被覆盖");
      assert.strictEqual(merged.W1["2026-11-11"].play, 200, "第二个写入者的 Day 2 应成功合并");
      assert.strictEqual(merged.W2["2026-11-10"].play, 30, "第一个写入者独有作品应保留");
      assert.strictEqual(merged.W3["2026-11-11"].play, 80, "第二个写入者独有作品应合并");
      assert.deepStrictEqual(listLeftoverTempOrLock(dir), [], "完成后不应残留锁或临时文件");
    } finally {
      try {
        child.kill();
      } catch (_) {}
    }

    // 6b. 新鲜锁持续占用（超过 5s）→ 告警跳过、不破坏原历史、不误删他人锁、mergeWorks 成功
    const lockGroup = "锁超时组";
    const lockDir = accPath(lockGroup, platform);
    const lockFile = path.join(lockDir, "works-daily.json.lock");
    store.mergeWorks(
      lockGroup,
      platform,
      [{ workId: "L1", title: "锁超时测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100 }],
      Date.parse("2026-11-10T04:00:00Z")
    );
    const foreignLockPayload = JSON.stringify({
      pid: 999999,
      createdAt: Date.now(),
      token: "foreign-active-lock",
    });
    fs.writeFileSync(lockFile, foreignLockPayload, "utf8");

    const tLockStart = Date.now();
    const outTimeout = captureWarn(() =>
      store.mergeWorks(
        lockGroup,
        platform,
        [{ workId: "L1", title: "锁超时测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 300 }],
        Date.parse("2026-11-11T04:00:00Z")
      )
    );
    const lockElapsed = Date.now() - tLockStart;

    assert.ok(
      lockElapsed >= 4500 && lockElapsed <= 7000,
      `等待超时应贴近 5s（实际 ${lockElapsed}ms）`
    );
    assert.strictEqual(outTimeout.result.works[0].play, 300, "拿不到锁不得影响 mergeWorks");
    assert.strictEqual(store.readWorks(lockGroup, platform).works[0].play, 300);
    assert.ok(outTimeout.warnings.some((m) => m.includes("锁超时")), "超时应输出告警");
    assert.deepStrictEqual(
      Object.keys(store.readWorksDaily(lockGroup, platform).L1),
      ["2026-11-10"],
      "拿不到锁应跳过写入并保留既有历史"
    );
    assert.strictEqual(
      fs.readFileSync(lockFile, "utf8"),
      foreignLockPayload,
      "超时退出不得误删其他进程的新鲜锁"
    );
    fs.unlinkSync(lockFile);
    console.log("✓ ④ 跨进程锁：双进程交错重读合并无丢数 + 锁超时告警跳过正确");
  }

  /* ---------- 7. ⑤ 陈旧锁（>30s）被抢占 ---------- */
  {
    const group = "陈旧锁组";
    const platform = "快手";
    const dir = accPath(group, platform);
    const lockFile = path.join(dir, "works-daily.json.lock");

    // 预置 Day 1
    store.mergeWorks(
      group,
      platform,
      [{ workId: "S1", title: "陈旧锁测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100 }],
      Date.parse("2026-11-10T04:00:00Z")
    );

    // 7a. mtime 超过 30s 且内容为空（模拟进程建锁后立刻崩溃）
    fs.writeFileSync(lockFile, "", "utf8");
    const staleDate = new Date(Date.now() - 45000);
    fs.utimesSync(lockFile, staleDate, staleDate);

    const t1 = Date.now();
    store.mergeWorks(
      group,
      platform,
      [{ workId: "S1", title: "陈旧锁测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 180 }],
      Date.parse("2026-11-11T04:00:00Z")
    );
    const elapsed1 = Date.now() - t1;
    assert.ok(elapsed1 < 2000, `陈旧锁应立刻被抢占，而非等 5s（实际 ${elapsed1}ms）`);

    let daily = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(daily.S1).sort(), ["2026-11-10", "2026-11-11"]);
    assert.strictEqual(daily.S1["2026-11-10"].play, 100);
    assert.strictEqual(daily.S1["2026-11-11"].play, 180);
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), [], "抢占并写完后锁与 .reap 均应清理");

    // 7b. JSON payload 中 createdAt 超过 30s 的陈旧锁
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 777777, createdAt: Date.now() - 35000, token: "dead-worker" }),
      "utf8"
    );
    const t2 = Date.now();
    store.mergeWorks(
      group,
      platform,
      [{ workId: "S1", title: "陈旧锁测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 260 }],
      Date.parse("2026-11-12T04:00:00Z")
    );
    const elapsed2 = Date.now() - t2;
    assert.ok(elapsed2 < 2000, `createdAt 超 30s 的陈旧锁也应立刻被抢占（实际 ${elapsed2}ms）`);
    daily = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(daily.S1).sort(), [
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    assert.strictEqual(daily.S1["2026-11-12"].play, 260);
    assert.deepStrictEqual(listLeftoverTempOrLock(dir), []);
    console.log("✓ ⑤ 陈旧锁（>30s）：mtime 过期与 createdAt 过期均正确抢占并清理");
  }

  /* ---------- 8. ⑥ 畸形指标校验统一（normalizeMetric）→ null 且不产生假增量 ---------- */
  {
    // normalizeMetric 合法值
    assert.strictEqual(normalizeMetric(0), 0);
    assert.ok(Object.is(normalizeMetric(-0), 0), "-0 应规范为 +0");
    assert.strictEqual(normalizeMetric(42), 42);
    assert.strictEqual(normalizeMetric(-5), -5);
    assert.strictEqual(normalizeMetric(3.14), 3.14);
    assert.strictEqual(normalizeMetric("0"), 0);
    assert.ok(Object.is(normalizeMetric("-0"), 0));
    assert.strictEqual(normalizeMetric(" 123 "), 123);
    assert.strictEqual(normalizeMetric("\t-7.5\n"), -7.5);
    assert.strictEqual(normalizeMetric("+8"), 8);
    assert.strictEqual(normalizeMetric(".5"), 0.5);

    // normalizeMetric 畸形/非法值 → 全部 null
    const invalidInputs = [
      "",
      "   ",
      "\t\n",
      [],
      [0],
      [1],
      {},
      { valueOf: () => 10 },
      true,
      false,
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      "0x10",
      "0b101",
      "0o77",
      "1e5",
      "12px",
      "1,000",
      "Infinity",
      "NaN",
      ".",
      "-",
      "+",
      "5.",
      new Date(),
      Symbol("metric"),
      new Number(5), // eslint-disable-line no-new-wrappers
    ];
    for (const bad of invalidInputs) {
      assert.strictEqual(
        normalizeMetric(bad),
        null,
        `畸形值 ${String(bad)} (${typeof bad}) 必须归为 null`
      );
    }

    // store 写入链路：畸形指标必须落盘为 null，合法数字字符串转为数值
    const group = "畸形指标组";
    const platform = "抖音";
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "M1",
          title: "指标测试",
          publishTime: Date.parse("2026-11-01T00:00:00Z"),
          play: 100,
          like: " 20 ",
          comment: 5,
          share: 0,
          favorite: "0",
          fansDelta: "-2",
        },
      ],
      Date.parse("2026-11-10T04:00:00Z")
    );
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "M1",
          title: "指标测试",
          publishTime: Date.parse("2026-11-01T00:00:00Z"),
          play: "   ",
          like: [],
          comment: {},
          share: true,
          favorite: false,
          fansDelta: NaN,
        },
      ],
      Date.parse("2026-11-11T04:00:00Z")
    );
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "M1",
          title: "指标测试",
          publishTime: Date.parse("2026-11-01T00:00:00Z"),
          play: 120,
          like: [1],
          comment: "0x10",
          share: "",
          favorite: 0,
          fansDelta: 1,
        },
      ],
      Date.parse("2026-11-12T04:00:00Z")
    );

    const daily = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(daily.M1["2026-11-10"], {
      play: 100,
      like: 20,
      comment: 5,
      share: 0,
      favorite: 0,
      fansDelta: -2,
    });
    assert.deepStrictEqual(daily.M1["2026-11-11"], {
      play: null,
      like: null,
      comment: null,
      share: null,
      favorite: null,
      fansDelta: null,
    });
    assert.deepStrictEqual(daily.M1["2026-11-12"], {
      play: 120,
      like: null,
      comment: null,
      share: null,
      favorite: 0,
      fansDelta: 1,
    });

    // statsTable 读表链路：即使外部文件直接含有畸形值（[]、"   "、{}、true），也不得转 0 产生 -100/+120 假增量
    const rows = buildWorkDailyRows({
      group,
      platform,
      works: [{ workId: "M1", title: "指标测试", publishTime: Date.parse("2026-11-01T00:00:00Z") }],
      worksDaily: {
        M1: {
          "2026-11-10": { play: 100, like: 50, comment: 10, share: 10, favorite: 10, fansDelta: 5 },
          "2026-11-11": { play: "   ", like: [], comment: {}, share: true, favorite: "0x10", fansDelta: "" },
          "2026-11-12": { play: 120, like: 0, comment: "15", share: false, favorite: 0, fansDelta: " 8 " },
        },
      },
    });
    assert.strictEqual(rows.length, 3);
    // 第 2 日全部畸形 → 全部 null，不出现 play=0 / playDelta=-100
    assert.strictEqual(rows[1].play, null);
    assert.strictEqual(rows[1].playDelta, null);
    assert.strictEqual(rows[1].like, null);
    assert.strictEqual(rows[1].likeDelta, null);
    assert.strictEqual(rows[1].comment, null);
    assert.strictEqual(rows[1].commentDelta, null);
    assert.strictEqual(rows[1].share, null);
    assert.strictEqual(rows[1].shareDelta, null);
    assert.strictEqual(rows[1].favorite, null);
    assert.strictEqual(rows[1].favoriteDelta, null);
    assert.strictEqual(rows[1].fansDelta, null);
    assert.strictEqual(rows[1].fansDeltaDelta, null);
    // 第 3 日前一日为 null → 增量仍为 null，不出现假增量 +120；真实 0 保留为 0
    assert.strictEqual(rows[2].play, 120);
    assert.strictEqual(rows[2].playDelta, null);
    assert.strictEqual(rows[2].like, 0);
    assert.strictEqual(rows[2].likeDelta, null);
    assert.strictEqual(rows[2].comment, 15);
    assert.strictEqual(rows[2].commentDelta, null);
    assert.strictEqual(rows[2].share, null);
    assert.strictEqual(rows[2].fansDelta, 8);
    assert.strictEqual(rows[2].fansDeltaDelta, null);
    console.log("✓ ⑥ 畸形指标校验统一：store 与 statsTable 均归 null，不产生假零与假增量");
  }

  /* ---------- 9. ⑦ 特殊 workId 往返（"__proto__" / "constructor" / "hasOwnProperty" / "toString"） ---------- */
  {
    const group = "特殊ID组";
    const platform = "小红书";
    const specialIds = ["__proto__", "constructor", "hasOwnProperty", "toString"];

    const empty = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(empty), null);

    // Day 1 写入
    store.mergeWorks(
      group,
      platform,
      specialIds.map((id, idx) => ({
        workId: id,
        title: `特殊作品-${id}`,
        url: `https://example.com/${encodeURIComponent(id)}`,
        publishTime: Date.parse("2026-11-01T00:00:00Z") + idx * 1000,
        play: 100 + idx * 10,
        like: 10 + idx,
        comment: 1,
        share: 0,
        favorite: 2,
        fansDelta: null,
      })),
      Date.parse("2026-11-10T04:00:00Z")
    );

    // Day 2 更新（验证读回 JSON 转为无原型对象后再合并不会丢失 Day 1 或 __proto__）
    store.mergeWorks(
      group,
      platform,
      specialIds.map((id, idx) => ({
        workId: id,
        title: `特殊作品-${id}`,
        url: `https://example.com/${encodeURIComponent(id)}`,
        publishTime: Date.parse("2026-11-01T00:00:00Z") + idx * 1000,
        play: 150 + idx * 20,
        like: 15 + idx,
        comment: 3,
        share: 1,
        favorite: 4,
        fansDelta: null,
      })),
      Date.parse("2026-11-11T04:00:00Z")
    );

    const daily = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(daily), null, "读回字典原型必须为 null");
    for (let idx = 0; idx < specialIds.length; idx++) {
      const id = specialIds[idx];
      assert.ok(
        Object.prototype.hasOwnProperty.call(daily, id),
        `特殊 workId "${id}" 必须作为自身属性保留`
      );
      assert.strictEqual(daily[id]["2026-11-10"].play, 100 + idx * 10);
      assert.strictEqual(daily[id]["2026-11-11"].play, 150 + idx * 20);
    }

    // 传入 buildWorkDailyRows 往返验证
    const rows = buildWorkDailyRows({
      group,
      platform,
      works: store.readWorks(group, platform).works,
      worksDaily: daily,
    });
    assert.strictEqual(rows.length, specialIds.length * 2);
    for (let idx = 0; idx < specialIds.length; idx++) {
      const id = specialIds[idx];
      const day2Row = rows.find((r) => r.workId === id && r.date === "2026-11-11");
      assert.ok(day2Row, `buildWorkDailyRows 应输出 "${id}" 的行`);
      assert.strictEqual(day2Row.title, `特殊作品-${id}`);
      assert.strictEqual(day2Row.playDelta, 50 + idx * 10);
      assert.strictEqual(day2Row.gapDays, 0);
    }
    console.log('✓ ⑦ 特殊 workId（"__proto__" / "constructor" 等）无原型字典往返完整');
  }

  /* ---------- 10. statsTable: 基本增量、连续 gapDays=0、断档 gapDays、null 指标、负增量 ---------- */
  {
    const ptW1 = Date.parse("2026-11-01T08:00:00Z");
    const works = [
      {
        workId: "W1",
        title: "作品一",
        url: "https://example.com/1",
        publishTime: ptW1,
      },
    ];
    // 故意打乱日期键顺序，验证函数内部按日期升序计算
    const worksDaily = {
      W1: {
        "2026-11-05": { play: 240, like: 18, comment: 2, share: 5, favorite: 9, fansDelta: 3 },
        "2026-11-01": { play: 100, like: 10, comment: 5, share: null, favorite: 0, fansDelta: 2 },
        "2026-11-02": { play: 150, like: 10, comment: 4, share: 3, favorite: 0, fansDelta: 5 },
        "2026-11-09": { play: 240, like: 25, comment: 2, share: null, favorite: 12, fansDelta: 1 },
      },
    };

    const rows = buildWorkDailyRows({
      group: "运营一组",
      platform: "视频号",
      works,
      worksDaily,
    });

    assert.strictEqual(rows.length, 4);
    assert.deepStrictEqual(
      rows.map((r) => r.date),
      ["2026-11-01", "2026-11-02", "2026-11-05", "2026-11-09"]
    );
    assert.deepStrictEqual(Object.keys(rows[0]), EXPECTED_ROW_KEYS, "行字段名与契约一致");

    // 第 1 条：首条记录，所有增量与 gapDays 均为 null
    assert.strictEqual(rows[0].group, "运营一组");
    assert.strictEqual(rows[0].platform, "视频号");
    assert.strictEqual(rows[0].workId, "W1");
    assert.strictEqual(rows[0].title, "作品一");
    assert.strictEqual(rows[0].url, "https://example.com/1");
    assert.strictEqual(rows[0].publishTime, new Date(ptW1).toISOString());
    assert.strictEqual(rows[0].play, 100);
    assert.strictEqual(rows[0].share, null);
    assert.strictEqual(rows[0].favorite, 0);
    assert.strictEqual(rows[0].playDelta, null);
    assert.strictEqual(rows[0].likeDelta, null);
    assert.strictEqual(rows[0].commentDelta, null);
    assert.strictEqual(rows[0].shareDelta, null);
    assert.strictEqual(rows[0].favoriteDelta, null);
    assert.strictEqual(rows[0].fansDeltaDelta, null);
    assert.strictEqual(rows[0].gapDays, null);

    // 第 2 条（连续次日 11-02）：gapDays=0；负增量 commentDelta=-1；前一日 null → shareDelta=null；0→0 → favoriteDelta=0
    assert.strictEqual(rows[1].gapDays, 0, "连续日 gapDays 应为 0");
    assert.strictEqual(rows[1].playDelta, 50);
    assert.strictEqual(rows[1].likeDelta, 0);
    assert.strictEqual(rows[1].commentDelta, -1, "负增量应照实输出（删评）");
    assert.strictEqual(rows[1].shareDelta, null, "上一条为 null 时增量应为 null");
    assert.strictEqual(rows[1].favoriteDelta, 0, "0 → 0 增量应为 0 而非 null");
    assert.strictEqual(rows[1].fansDeltaDelta, 3);

    // 第 3 条（11-02 → 11-05，中间缺 11-03、11-04 共 2 天）：gapDays=2；comment 4→2 负增量 -2；fansDelta 5→3 负增量 -2
    assert.strictEqual(rows[2].gapDays, 2, "11-02 到 11-05 断档 2 天");
    assert.strictEqual(rows[2].playDelta, 90);
    assert.strictEqual(rows[2].likeDelta, 8);
    assert.strictEqual(rows[2].commentDelta, -2);
    assert.strictEqual(rows[2].shareDelta, 2);
    assert.strictEqual(rows[2].favoriteDelta, 9);
    assert.strictEqual(rows[2].fansDeltaDelta, -2, "fansDeltaDelta 负增量照实输出");

    // 第 4 条（11-05 → 11-09，缺 3 天）：gapDays=3；当日 share 为 null → shareDelta=null；fansDelta 3→1 → -2
    assert.strictEqual(rows[3].gapDays, 3);
    assert.strictEqual(rows[3].playDelta, 0);
    assert.strictEqual(rows[3].likeDelta, 7);
    assert.strictEqual(rows[3].share, null);
    assert.strictEqual(rows[3].shareDelta, null, "当日为 null 时增量应为 null");
    assert.strictEqual(rows[3].fansDeltaDelta, -2);

    // 跨闰年与平年 2 月底 gapDays 检查
    const leapRows = buildWorkDailyRows({
      group: "g",
      platform: "抖音",
      works: [],
      worksDaily: {
        L1: {
          "2024-02-28": { play: 10, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
          "2024-03-01": { play: 20, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
        },
        N1: {
          "2025-02-28": { play: 10, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
          "2025-03-01": { play: 20, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: 0 },
        },
      },
    });
    assert.strictEqual(
      leapRows.find((r) => r.workId === "L1" && r.date === "2024-03-01").gapDays,
      1,
      "闰年跳过 02-29 应为 gapDays=1"
    );
    assert.strictEqual(
      leapRows.find((r) => r.workId === "N1" && r.date === "2025-03-01").gapDays,
      0,
      "平年 02-28 → 03-01 连续应为 gapDays=0"
    );
    console.log("✓ buildWorkDailyRows：字段、增量、null 指标、负增量、断档 gapDays 正确");
  }

  /* ---------- 11. statsTable: from / to 过滤（含端点），且保留 from 之前用于算增量 ---------- */
  {
    const works = [{ workId: "W1", title: "测试", url: "", publishTime: Date.parse("2026-11-01T00:00:00Z") }];
    const worksDaily = {
      W1: {
        "2026-11-01": { play: 100, like: 10, comment: 1, share: 0, favorite: 2, fansDelta: 1 },
        "2026-11-02": { play: 130, like: 15, comment: 2, share: 1, favorite: 3, fansDelta: 2 },
        "2026-11-05": { play: 200, like: 25, comment: 1, share: 1, favorite: 5, fansDelta: 4 },
        "2026-11-06": { play: 220, like: 26, comment: 1, share: 2, favorite: 5, fansDelta: 4 },
      },
    };

    const singleDay = buildWorkDailyRows({
      group: "G",
      platform: "抖音",
      works,
      worksDaily,
      from: "2026-11-05",
      to: "2026-11-05",
    });
    assert.strictEqual(singleDay.length, 1);
    assert.strictEqual(singleDay[0].date, "2026-11-05");
    assert.strictEqual(singleDay[0].playDelta, 70, "from 过滤后仍需用 11-02 计算增量");
    assert.strictEqual(singleDay[0].likeDelta, 10);
    assert.strictEqual(singleDay[0].commentDelta, -1);
    assert.strictEqual(singleDay[0].gapDays, 2, "from 过滤后仍需用 11-02 计算 gapDays");

    const fromOnly = buildWorkDailyRows({
      group: "G",
      platform: "抖音",
      works,
      worksDaily,
      from: "2026-11-02",
    });
    assert.deepStrictEqual(
      fromOnly.map((r) => r.date),
      ["2026-11-02", "2026-11-05", "2026-11-06"]
    );
    assert.strictEqual(fromOnly[0].playDelta, 30);
    assert.strictEqual(fromOnly[0].gapDays, 0);

    const toOnly = buildWorkDailyRows({
      group: "G",
      platform: "抖音",
      works,
      worksDaily,
      to: "2026-11-02",
    });
    assert.deepStrictEqual(
      toOnly.map((r) => r.date),
      ["2026-11-01", "2026-11-02"]
    );
    assert.strictEqual(toOnly[0].playDelta, null);
    assert.strictEqual(toOnly[1].playDelta, 30);

    assert.deepStrictEqual(
      buildWorkDailyRows({ group: "G", platform: "抖音", works, worksDaily, from: "2026-11-06", to: "2026-11-05" }),
      []
    );
    console.log("✓ buildWorkDailyRows：from / to 过滤（含端点）与跨界增量计算正确");
  }

  /* ---------- 12. statsTable: 已删除作品 + 排序（date 升序、同日 publishTime 降序） ---------- */
  {
    const works = [
      { workId: "OLD", title: "早期视频", url: "https://ex/old", publishTime: Date.parse("2026-10-01T00:00:00Z") },
      { workId: "NEW", title: "最新视频", url: "https://ex/new", publishTime: Date.parse("2026-11-10T12:00:00Z") },
      { workId: "NOPT", title: "无发布时间", url: "https://ex/nopt", publishTime: 0 },
    ];
    const worksDaily = {
      OLD: {
        "2026-11-11": { play: 100, like: 1, comment: 0, share: 0, favorite: 0, fansDelta: null },
        "2026-11-12": { play: 120, like: 2, comment: 0, share: 0, favorite: 0, fansDelta: null },
      },
      NEW: {
        "2026-11-11": { play: 50, like: 5, comment: 1, share: 1, favorite: 2, fansDelta: null },
        "2026-11-12": { play: 90, like: 9, comment: 2, share: 2, favorite: 3, fansDelta: null },
      },
      NOPT: {
        "2026-11-11": { play: 10, like: 0, comment: 0, share: 0, favorite: 0, fansDelta: null },
      },
      DELETED_1: {
        "2026-11-11": { play: 80, like: 4, comment: 1, share: null, favorite: null, fansDelta: null },
        "2026-11-12": { play: 75, like: 4, comment: 0, share: null, favorite: null, fansDelta: null },
      },
    };

    const rows = buildWorkDailyRows({
      group: "G",
      platform: "头条",
      works,
      worksDaily,
    });

    const day1 = rows.filter((r) => r.date === "2026-11-11");
    assert.deepStrictEqual(
      day1.map((r) => r.workId),
      ["NEW", "OLD", "DELETED_1", "NOPT"],
      "同日必须按 publishTime 降序排列，无发布时间置后"
    );

    const day2 = rows.filter((r) => r.date === "2026-11-12");
    assert.deepStrictEqual(day2.map((r) => r.workId), ["NEW", "OLD", "DELETED_1"]);

    assert.deepStrictEqual(
      rows.map((r) => r.date),
      ["2026-11-11", "2026-11-11", "2026-11-11", "2026-11-11", "2026-11-12", "2026-11-12", "2026-11-12"]
    );

    const delRow1 = day1.find((r) => r.workId === "DELETED_1");
    const delRow2 = day2.find((r) => r.workId === "DELETED_1");
    assert.strictEqual(delRow1.title, "(已删除或未匹配)");
    assert.strictEqual(delRow1.title, DELETED_WORK_TITLE);
    assert.strictEqual(delRow1.url, "");
    assert.strictEqual(delRow1.publishTime, "");
    assert.strictEqual(delRow1.play, 80);
    assert.strictEqual(delRow2.playDelta, -5, "已删除作品同样正常算增量");
    assert.strictEqual(delRow2.commentDelta, -1);
    assert.strictEqual(delRow2.gapDays, 0);

    const noptRow = day1.find((r) => r.workId === "NOPT");
    assert.strictEqual(noptRow.publishTime, "");
    console.log("✓ buildWorkDailyRows：已删除作品兜底标题 + date 升序 / publishTime 降序正确");
  }

  /* ---------- 13. 端到端串联（store → statsTable）与脏输入防护 ---------- */
  {
    const g = "联调组";
    const p = "小红书";
    store.mergeWorks(
      g,
      p,
      [
        {
          workId: "X1",
          title: "笔记A",
          url: "https://xhs/x1",
          publishTime: Date.parse("2026-11-14T06:00:00Z"),
          play: 200,
          like: 20,
          comment: 5,
          share: 2,
          favorite: 10,
          fansDelta: null,
        },
      ],
      Date.parse("2026-11-15T04:00:00Z")
    );
    store.mergeWorks(
      g,
      p,
      [
        {
          workId: "X1",
          title: "笔记A",
          url: "https://xhs/x1",
          publishTime: Date.parse("2026-11-14T06:00:00Z"),
          play: 350,
          like: 32,
          comment: 7,
          share: 4,
          favorite: 18,
          fansDelta: null,
        },
      ],
      Date.parse("2026-11-17T04:00:00Z")
    );

    const rows = buildWorkDailyRows({
      group: g,
      platform: p,
      works: store.readWorks(g, p).works,
      worksDaily: store.readWorksDaily(g, p),
    });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].date, "2026-11-15");
    assert.strictEqual(rows[0].playDelta, null);
    assert.strictEqual(rows[1].date, "2026-11-17");
    assert.strictEqual(rows[1].playDelta, 150);
    assert.strictEqual(rows[1].fansDelta, null);
    assert.strictEqual(rows[1].fansDeltaDelta, null);
    assert.strictEqual(rows[1].gapDays, 1);

    assert.deepStrictEqual(buildWorkDailyRows(), []);
    assert.deepStrictEqual(buildWorkDailyRows({ worksDaily: null }), []);
    assert.deepStrictEqual(buildWorkDailyRows({ worksDaily: [] }), []);
    assert.deepStrictEqual(
      buildWorkDailyRows({
        worksDaily: {
          BAD: {
            "not-a-date": { play: 1 },
            "2026-02-31": { play: 2 },
            "2026-11-01": null,
          },
        },
      }),
      []
    );
    console.log("✓ 端到端串联与脏输入防护正确");
  }

  console.log("\n全部通过：works-daily 存储与 statsTable 长表构建");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
