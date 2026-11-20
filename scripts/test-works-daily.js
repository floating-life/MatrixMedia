/**
 * 作品日快照存储（store.js，按天分文件无锁）与长表行构建（statsTable.js）单元测试（不依赖 Electron 运行环境）：
 * 1. statsTable.js 纯函数模块独立加载（不依赖 electron / fs）
 * 2. 同日两次采集合并（第二次缺某作品时保留第一次该作品的值）+ UTC+8 切日 + null 指标
 * 3. 跨日各自成文件、历史文件内容在后续采集中字节不变、缺席作品不伪造
 * 4. 某天文件损坏 / 读失败 / 文件名与内容 date 不一致 → warn 并跳过，其余天正常读出
 * 5. 当天文件损坏 → warn 且本次采集覆盖为有效文件（不做备份、历史文件不变）
 * 6. 写失败 / 写入中途 ENOSPC（writeSync 半写 / fsyncSync）→ 旧当天文件完整、mergeWorks 成功、清临时文件
 * 7. renameSync 遇 EPERM / EBUSY 重试（3 次×50ms）与重试耗尽容错
 * 8. 旧单文件 works-daily.json 兼容读取（目录文件优先、不删除、不迁移写入、旧文件损坏跳过）
 * 9. 畸形指标校验统一（normalizeMetric）：畸形指标归 null 且不产生假增量，真实 0 照常保留
 * 10. 特殊 workId（"__proto__" / "constructor" / "hasOwnProperty" / "toString"）无原型字典往返不丢
 * 11. buildWorkDailyRows：增量、断档 gapDays、from/to 过滤、已删除作品、排序、端到端串联与脏输入防护
 *
 * 运行：yarn test:works-daily
 */

"use strict";

const assert = require("assert");
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

function accPath(group, platform, ...rest) {
  return path.join(tmpRoot, "data-stats", group, platform, ...rest);
}

function dailyDir(group, platform, ...rest) {
  return accPath(group, platform, "works-daily", ...rest);
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

function listLeftoverArtifacts(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".tmp") ||
        f.endsWith(".lock") ||
        f.endsWith(".reap") ||
        f.includes(".corrupt-")
    );
}

try {
  /* ---------- 1. 同日两次采集合并（第二次缺某作品保留第一次值）+ UTC+8 切日 + 跨日历史字节不变 ---------- */
  {
    const group = "测试组A";
    const platform = "抖音";

    const { result: empty, warnings: emptyWarns } = captureWarn(() =>
      store.readWorksDaily(group, platform)
    );
    assert.strictEqual(Object.getPrototypeOf(empty), null, "无目录时应返回无原型空字典");
    assert.deepStrictEqual(Object.keys(empty), [], "无目录时 readWorksDaily 应无键");
    assert.deepStrictEqual(emptyWarns, [], "目录不存在时不应输出告警");

    // 2026-11-10 上午 09:00（UTC+8）首次采集：W1 + W2
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

    // 2026-11-10 晚上 22:00（UTC+8，同一天）二次采集：W1 更新 + W3 新增，故意缺少 W2
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
          workId: "W3",
          title: "视频三",
          url: "https://example.com/w3",
          publishTime: Date.parse("2026-11-10T12:00:00Z"),
          play: 20,
          like: 2,
          comment: 1,
          share: 0,
          favorite: 1,
          fansDelta: null,
        },
      ],
      tDay1Evening
    );

    const day1File = dailyDir(group, platform, "2026-11-10.json");
    assert.ok(fs.existsSync(day1File), "当天快照应落在 works-daily/2026-11-10.json");
    assert.strictEqual(
      fs.existsSync(accPath(group, platform, "works-daily.json")),
      false,
      "新结构不应生成单文件 works-daily.json"
    );

    const day1Raw = fs.readFileSync(day1File, "utf8");
    const day1Doc = JSON.parse(day1Raw);
    assert.strictEqual(day1Doc.date, "2026-11-10");
    assert.strictEqual(day1Doc.updatedAt, tDay1Evening);
    assert.deepStrictEqual(Object.keys(day1Doc.works).sort(), ["W1", "W2", "W3"]);
    assert.strictEqual(day1Doc.works.W1.play, 180, "同日二次采集应覆盖 W1");
    assert.strictEqual(day1Doc.works.W2.play, 50, "同日二次采集缺 W2 时应保留第一次 W2 的值");
    assert.strictEqual(day1Doc.works.W2.share, null);
    assert.strictEqual(day1Doc.works.W3.play, 20, "同日新增作品 W3 应并入当天文件");

    let daily = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(daily), null, "readWorksDaily 返回值必须无原型");
    assert.deepStrictEqual(daily.W1["2026-11-10"], {
      play: 180,
      like: 15,
      comment: 4,
      share: 2,
      favorite: 8,
      fansDelta: 6,
    });
    assert.deepStrictEqual(daily.W2["2026-11-10"], {
      play: 50,
      like: 0,
      comment: 0,
      share: null,
      favorite: null,
      fansDelta: null,
    });
    assert.deepStrictEqual(daily.W3["2026-11-10"], {
      play: 20,
      like: 2,
      comment: 1,
      share: 0,
      favorite: 1,
      fansDelta: null,
    });

    // UTC 2026-11-10T16:30:00Z = UTC+8 2026-11-11 00:30 → 跨日写入 2026-11-11.json
    // 此次采集仅含 W1（不含 W2/W3），不应伪造 W2/W3 的 11-11 快照，也不得修改 2026-11-10.json
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

    const day2File = dailyDir(group, platform, "2026-11-11.json");
    assert.ok(fs.existsSync(day2File), "跨日应独立生成 2026-11-11.json");
    assert.strictEqual(
      fs.readFileSync(day1File, "utf8"),
      day1Raw,
      "跨日后续采集中历史文件 2026-11-10.json 字节必须完全不变"
    );
    const day2Raw = fs.readFileSync(day2File, "utf8");
    const day2Doc = JSON.parse(day2Raw);
    assert.strictEqual(day2Doc.date, "2026-11-11");
    assert.strictEqual(day2Doc.updatedAt, tDay2Utc8);
    assert.deepStrictEqual(Object.keys(day2Doc.works), ["W1"], "当日未采集到的作品不应伪造");

    // 第三天采集：验证前两天文件字节全部不变
    store.mergeWorks(
      group,
      platform,
      [{ workId: "W1", title: "视频一", publishTime: Date.parse("2026-11-09T10:00:00Z"), play: 310 }],
      Date.parse("2026-11-12T02:00:00Z")
    );
    assert.strictEqual(fs.readFileSync(day1File, "utf8"), day1Raw, "第 3 日采集后第 1 日文件字节不变");
    assert.strictEqual(fs.readFileSync(day2File, "utf8"), day2Raw, "第 3 日采集后第 2 日文件字节不变");
    assert.deepStrictEqual(
      fs.readdirSync(dailyDir(group, platform)).sort(),
      ["2026-11-10.json", "2026-11-11.json", "2026-11-12.json"]
    );

    daily = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(daily.W1).sort(), ["2026-11-10", "2026-11-11", "2026-11-12"]);
    assert.strictEqual(daily.W1["2026-11-10"].play, 180);
    assert.strictEqual(daily.W1["2026-11-11"].play, 260);
    assert.strictEqual(daily.W1["2026-11-12"].play, 310);
    assert.deepStrictEqual(Object.keys(daily.W2), ["2026-11-10"]);
    assert.deepStrictEqual(Object.keys(daily.W3), ["2026-11-10"]);
    assert.deepStrictEqual(listLeftoverArtifacts(dailyDir(group, platform)), []);
    assert.deepStrictEqual(listLeftoverArtifacts(accPath(group, platform)), []);
    console.log("✓ 同日合并保留缺席作品 + UTC+8 切日 + 跨日独立文件与历史字节不变");
  }

  /* ---------- 2. 某天文件损坏 / 读失败 / 文件名与内容 date 不一致 → 其余天正常读出 ---------- */
  {
    const group = "单日损坏组";
    const platform = "视频号";
    const dir = dailyDir(group, platform);
    fs.mkdirSync(dir, { recursive: true });

    // 正常日：11-08
    fs.writeFileSync(
      path.join(dir, "2026-11-08.json"),
      JSON.stringify({ date: "2026-11-08", updatedAt: 1000, works: { H1: { play: 100, like: 10 } } }),
      "utf8"
    );
    // 损坏 JSON：11-09
    fs.writeFileSync(path.join(dir, "2026-11-09.json"), '{"date":"2026-11-09","works":{"H1":', "utf8");
    // 无效结构（works 非对象）：11-10
    fs.writeFileSync(
      path.join(dir, "2026-11-10.json"),
      JSON.stringify({ date: "2026-11-10", updatedAt: 2000, works: [] }),
      "utf8"
    );
    // 文件名日期与内容 date 不一致：11-11 文件内写了 2026-01-01，应以文件名 2026-11-11 为准
    fs.writeFileSync(
      path.join(dir, "2026-11-11.json"),
      JSON.stringify({ date: "2026-01-01", updatedAt: 3000, works: { H1: { play: 220, like: 22 } } }),
      "utf8"
    );
    // 读失败（同名目录触发 EISDIR）：11-12
    fs.mkdirSync(path.join(dir, "2026-11-12.json"));
    // 干扰文件（不符合 YYYY-MM-DD.json）：静默忽略
    fs.writeFileSync(path.join(dir, ".2026-11-08.json.123.tmp"), "{incomplete", "utf8");
    fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me", "utf8");

    const { result: daily, warnings } = captureWarn(() => store.readWorksDaily(group, platform));
    assert.strictEqual(Object.getPrototypeOf(daily), null);
    assert.deepStrictEqual(
      Object.keys(daily.H1).sort(),
      ["2026-11-08", "2026-11-11"],
      "损坏/无效/读失败日期应跳过，其余天正常读出且以文件名日期为准"
    );
    assert.strictEqual(daily.H1["2026-11-08"].play, 100);
    assert.strictEqual(daily.H1["2026-11-08"].like, 10);
    assert.strictEqual(daily.H1["2026-11-11"].play, 220);
    assert.strictEqual(daily.H1["2026-01-01"], undefined, "不得使用内容中不一致的 date");
    assert.ok(warnings.some((m) => m.includes("2026-11-09.json")), "损坏 JSON 应 warn");
    assert.ok(warnings.some((m) => m.includes("2026-11-10.json")), "结构无效应 warn");
    assert.ok(warnings.some((m) => m.includes("2026-11-12.json")), "读失败应 warn");
    assert.strictEqual(
      warnings.some((m) => m.includes("notes.txt") || m.includes(".tmp")),
      false,
      "非 YYYY-MM-DD.json 文件应静默忽略"
    );

    // 进一步测试 mock EIO 读单日文件：同样 warn 并跳过，不影响其余天
    const origReadFileSync = fs.readFileSync;
    const eioTarget = path.join(dir, "2026-11-08.json");
    fs.readFileSync = function patchedRead(target, ...rest) {
      if (String(target) === eioTarget) {
        const err = new Error("EIO: i/o error, read");
        err.code = "EIO";
        throw err;
      }
      return origReadFileSync.call(fs, target, ...rest);
    };
    let outEio;
    try {
      outEio = captureWarn(() => store.readWorksDaily(group, platform));
    } finally {
      fs.readFileSync = origReadFileSync;
    }
    assert.deepStrictEqual(Object.keys(outEio.result.H1), ["2026-11-11"]);
    assert.ok(outEio.warnings.some((m) => m.includes("2026-11-08.json") && m.includes("EIO")));
    console.log("✓ 某天文件损坏/读失败/date 不一致：warn 并跳过异常天，其余天以文件名日期正常读出");
  }

  /* ---------- 3. 当天文件损坏 → 本次采集 warn 并覆盖为有效文件（不做备份、历史不变） ---------- */
  {
    const group = "当天损坏覆盖组";
    const platform = "抖音";
    const dir = dailyDir(group, platform);

    // 先写入前一天正常历史
    store.mergeWorks(
      group,
      platform,
      [{ workId: "C1", title: "历史视频", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100 }],
      Date.parse("2026-11-09T04:00:00Z")
    );
    const prevFile = path.join(dir, "2026-11-09.json");
    const prevBytes = fs.readFileSync(prevFile, "utf8");

    // 3a. 当天文件 JSON 损坏
    const todayFile = path.join(dir, "2026-11-10.json");
    fs.writeFileSync(todayFile, '{"date":"2026-11-10","works":{"C1":{"play":150', "utf8");

    const tToday = Date.parse("2026-11-10T04:00:00Z");
    const { result, warnings } = captureWarn(() =>
      store.mergeWorks(
        group,
        platform,
        [{ workId: "C1", title: "历史视频", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 220, like: 18 }],
        tToday
      )
    );

    assert.strictEqual(result.works[0].play, 220);
    assert.ok(warnings.some((m) => m.includes("2026-11-10.json")), "当天文件损坏应输出 warn");
    const repaired = JSON.parse(fs.readFileSync(todayFile, "utf8"));
    assert.strictEqual(repaired.date, "2026-11-10");
    assert.strictEqual(repaired.updatedAt, tToday);
    assert.strictEqual(repaired.works.C1.play, 220, "当天损坏文件应被本次采集覆盖为有效文件");
    assert.strictEqual(repaired.works.C1.like, 18);
    assert.strictEqual(fs.readFileSync(prevFile, "utf8"), prevBytes, "前一天历史文件字节不得变化");
    assert.deepStrictEqual(listLeftoverArtifacts(dir), [], "不得生成 corrupt 备份或残留临时文件");
    assert.deepStrictEqual(listLeftoverArtifacts(accPath(group, platform)), []);

    // 3b. 当天文件根结构非对象 / works 非对象 → 同样 warn 并覆盖为有效文件
    for (const badPayload of ["[]", "null", '{"date":"2026-11-10","works":null}']) {
      fs.writeFileSync(todayFile, badPayload, "utf8");
      const outBad = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "C1", title: "历史视频", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 260 }],
          tToday + 1000
        )
      );
      assert.ok(outBad.warnings.some((m) => m.includes("2026-11-10.json")));
      const doc = JSON.parse(fs.readFileSync(todayFile, "utf8"));
      assert.strictEqual(doc.works.C1.play, 260);
    }

    const { result: afterDaily, warnings: readWarns } = captureWarn(() =>
      store.readWorksDaily(group, platform)
    );
    assert.deepStrictEqual(readWarns, [], "覆盖修复后读取不应再有告警");
    assert.deepStrictEqual(Object.keys(afterDaily.C1).sort(), ["2026-11-09", "2026-11-10"]);
    assert.strictEqual(afterDaily.C1["2026-11-09"].play, 100);
    assert.strictEqual(afterDaily.C1["2026-11-10"].play, 260);
    console.log("✓ 当天文件损坏：warn 且本次采集覆盖为有效文件，不做备份，历史文件完整");
  }

  /* ---------- 4. 写失败 / 写入中途 ENOSPC（writeSync 半写 / fsyncSync）→ 旧当天文件完整、mergeWorks 成功 ---------- */
  {
    const group = "原子写组";
    const platform = "快手";
    const dir = dailyDir(group, platform);
    const tDay1 = Date.parse("2026-11-09T04:00:00Z");
    const tDay2 = Date.parse("2026-11-10T04:00:00Z");

    store.mergeWorks(
      group,
      platform,
      [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1000, like: 80 }],
      tDay1
    );
    store.mergeWorks(
      group,
      platform,
      [{ workId: "A1", title: "原子写测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 1200, like: 95 }],
      tDay2
    );

    const day1File = path.join(dir, "2026-11-09.json");
    const day2File = path.join(dir, "2026-11-10.json");
    const intactDay1Bytes = fs.readFileSync(day1File, "utf8");
    const intactDay2Bytes = fs.readFileSync(day2File, "utf8");

    // 4a. writeSync 半写（先写 16 字节再抛 ENOSPC）→ 旧当天文件完整可解析、临时文件已清理、mergeWorks 成功
    const origOpenSync = fs.openSync;
    const origWriteSync = fs.writeSync;
    const tmpFds = new Set();
    let partialDone = false;
    fs.openSync = function patchedOpen(target, ...rest) {
      const fd = origOpenSync.call(fs, target, ...rest);
      if (String(target).includes("2026-11-10.json") && String(target).endsWith(".tmp")) {
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
          tDay2 + 3600e3
        )
      );
    } finally {
      fs.openSync = origOpenSync;
      fs.writeSync = origWriteSync;
    }

    assert.strictEqual(partialDone, true, "确认已命中半写路径");
    assert.strictEqual(outHalfWrite.result.works[0].play, 1500, "writeSync ENOSPC 不得影响 mergeWorks");
    assert.strictEqual(store.readWorks(group, platform).works[0].play, 1500, "works.json 应正常更新");
    assert.ok(outHalfWrite.warnings.some((m) => m.includes("ENOSPC")));
    assert.strictEqual(fs.readFileSync(day2File, "utf8"), intactDay2Bytes, "半写 ENOSPC 后旧当天文件必须字节完整");
    assert.strictEqual(fs.readFileSync(day1File, "utf8"), intactDay1Bytes, "历史文件不受影响");
    assert.strictEqual(store.readWorksDaily(group, platform).A1["2026-11-10"].play, 1200);
    assert.deepStrictEqual(listLeftoverArtifacts(dir), [], "半写失败后临时文件应被清理");

    // 4b. fsyncSync 抛 ENOSPC → 旧当天文件完整可解析、临时文件已清理、mergeWorks 成功
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
          tDay2 + 7200e3
        )
      );
    } finally {
      fs.fsyncSync = origFsyncSync;
    }
    assert.strictEqual(outFsync.result.works[0].play, 1600);
    assert.ok(outFsync.warnings.some((m) => m.includes("ENOSPC")));
    assert.strictEqual(fs.readFileSync(day2File, "utf8"), intactDay2Bytes, "fsync ENOSPC 后旧当天文件必须字节完整");
    assert.deepStrictEqual(listLeftoverArtifacts(dir), []);

    // 4c. 目录位置被文件占据（ENOTDIR / EEXIST）& openSync EACCES → 仅 warn，不影响 mergeWorks
    const badGroup = "写失败组";
    const badAccDir = accPath(badGroup, "哔哩哔哩");
    fs.mkdirSync(badAccDir, { recursive: true });
    fs.writeFileSync(path.join(badAccDir, "works-daily"), "occupy-as-file", "utf8");
    const outBlocked = captureWarn(() =>
      store.mergeWorks(
        badGroup,
        "哔哩哔哩",
        [{ workId: "BV1", title: "B站测试", publishTime: Date.parse("2026-11-10T02:00:00Z"), play: 99 }],
        tDay2
      )
    );
    assert.strictEqual(outBlocked.result.works[0].play, 99);
    assert.strictEqual(store.readWorks(badGroup, "哔哩哔哩").works[0].play, 99);
    assert.ok(outBlocked.warnings.some((m) => m.includes("works-daily")));

    fs.openSync = function patchedOpenAcc(target, ...rest) {
      if (String(target).endsWith(".tmp")) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return origOpenSync.call(fs, target, ...rest);
    };
    let outAcc;
    try {
      outAcc = captureWarn(() =>
        store.mergeWorks(
          "写失败组2",
          "哔哩哔哩",
          [{ workId: "BV2", title: "权限测试", publishTime: Date.parse("2026-11-10T02:00:00Z"), play: 88 }],
          tDay2
        )
      );
    } finally {
      fs.openSync = origOpenSync;
    }
    assert.strictEqual(outAcc.result.works[0].play, 88);
    assert.ok(outAcc.warnings.some((m) => m.includes("EACCES")));
    assert.deepStrictEqual(listLeftoverArtifacts(dailyDir("写失败组2", "哔哩哔哩")), []);
    console.log("✓ 写入中途 ENOSPC/fsync 失败与路径/权限异常：旧当天文件完整、mergeWorks 成功、临时文件已清理");
  }

  /* ---------- 5. renameSync 遇 EPERM / EBUSY 重试（3 次×50ms）与耗尽容错 ---------- */
  {
    const group = "重命名重试组";
    const platform = "抖音";
    const dir = dailyDir(group, platform);
    const tDay = Date.parse("2026-11-10T04:00:00Z");
    const targetFile = path.join(dir, "2026-11-10.json");

    store.mergeWorks(
      group,
      platform,
      [{ workId: "R1", title: "重试测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 100 }],
      tDay
    );

    // 5a. 前 2 次分别抛 EPERM、EBUSY，第 3 次成功
    const origRenameSync = fs.renameSync;
    let renameAttempts = 0;
    fs.renameSync = function patchedRename(src, dest) {
      if (String(dest) === targetFile) {
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
    let outRetryOk;
    try {
      outRetryOk = captureWarn(() =>
        store.mergeWorks(
          group,
          platform,
          [{ workId: "R1", title: "重试测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 170 }],
          tDay + 1000
        )
      );
    } finally {
      fs.renameSync = origRenameSync;
    }
    assert.strictEqual(renameAttempts, 3, "EPERM/EBUSY 后应自动重试并成功");
    assert.deepStrictEqual(outRetryOk.warnings, []);
    assert.strictEqual(store.readWorksDaily(group, platform).R1["2026-11-10"].play, 170);
    assert.deepStrictEqual(listLeftoverArtifacts(dir), []);

    // 5b. 连续 EPERM 耗尽 3 次重试（共 4 次调用）→ 保留旧文件、清临时文件、warn、mergeWorks 成功
    const beforeExhaustBytes = fs.readFileSync(targetFile, "utf8");
    let exhaustAttempts = 0;
    fs.renameSync = function patchedRenameFail(src, dest) {
      if (String(dest) === targetFile) {
        exhaustAttempts++;
        const err = new Error("EPERM: still locked");
        err.code = "EPERM";
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
          [{ workId: "R1", title: "重试测试", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 250 }],
          tDay + 2000
        )
      );
    } finally {
      fs.renameSync = origRenameSync;
    }
    assert.strictEqual(exhaustAttempts, 4, "应为首次尝试 + 3 次重试共 4 次");
    assert.strictEqual(outExhaust.result.works[0].play, 250);
    assert.ok(outExhaust.warnings.some((m) => m.includes("EPERM")));
    assert.strictEqual(fs.readFileSync(targetFile, "utf8"), beforeExhaustBytes, "重试耗尽后旧文件应字节完好");
    assert.deepStrictEqual(listLeftoverArtifacts(dir), []);
    console.log("✓ renameSync EPERM/EBUSY 重试（3 次×50ms）与耗尽容错正确");
  }

  /* ---------- 6. 旧单文件 works-daily.json 兼容读取（目录文件优先、不删除、不迁移写入） ---------- */
  {
    const group = "旧单文件兼容组";
    const platform = "头条";
    const accDir = accPath(group, platform);
    const legacyFile = path.join(accDir, "works-daily.json");
    const dir = dailyDir(group, platform);
    fs.mkdirSync(accDir, { recursive: true });

    const legacyPayload = JSON.stringify(
      {
        W1: {
          "2026-11-08": { play: 100, like: 10, comment: 1, share: 0, favorite: 2, fansDelta: 1 },
          "2026-11-09": { play: 150, like: 15, comment: 2, share: 1, favorite: 3, fansDelta: 2 },
        },
        W2: {
          "2026-11-09": { play: 40, like: 4, comment: 0, share: null, favorite: 1, fansDelta: null },
        },
        W_OLD: {
          "2026-11-08": { play: 20, like: " 3 ", comment: "   ", share: [], favorite: 0, fansDelta: null },
        },
        ["__proto__"]: {
          "2026-11-08": { play: 77, like: 7, comment: 0, share: 0, favorite: 0, fansDelta: null },
        },
      },
      null,
      2
    );
    fs.writeFileSync(legacyFile, legacyPayload, "utf8");

    // 6a. 仅存在旧单文件、无 works-daily/ 目录时正常读出，且不创建目录、不改旧文件
    const { result: legacyOnly, warnings: wLegacyOnly } = captureWarn(() =>
      store.readWorksDaily(group, platform)
    );
    assert.deepStrictEqual(wLegacyOnly, []);
    assert.strictEqual(Object.getPrototypeOf(legacyOnly), null);
    assert.strictEqual(legacyOnly.W1["2026-11-08"].play, 100);
    assert.strictEqual(legacyOnly.W1["2026-11-09"].play, 150);
    assert.strictEqual(legacyOnly.W2["2026-11-09"].play, 40);
    assert.strictEqual(legacyOnly.W_OLD["2026-11-08"].like, 3);
    assert.strictEqual(legacyOnly.W_OLD["2026-11-08"].comment, null);
    assert.strictEqual(legacyOnly.W_OLD["2026-11-08"].share, null);
    assert.strictEqual(legacyOnly["__proto__"]["2026-11-08"].play, 77);
    assert.strictEqual(fs.existsSync(dir), false, "仅读取时不得迁移创建 works-daily/ 目录");
    assert.strictEqual(fs.readFileSync(legacyFile, "utf8"), legacyPayload, "旧单文件不得被改动");

    // 6b. 目录文件同时存在：同日期同作品以目录文件优先，其余由旧单文件补充
    store.mergeWorks(
      group,
      platform,
      [{ workId: "W1", title: "作品一", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 165, like: 16 }],
      Date.parse("2026-11-09T04:00:00Z")
    );
    store.mergeWorks(
      group,
      platform,
      [{ workId: "W1", title: "作品一", publishTime: Date.parse("2026-11-01T00:00:00Z"), play: 220, like: 22 }],
      Date.parse("2026-11-10T04:00:00Z")
    );

    const merged = store.readWorksDaily(group, platform);
    assert.deepStrictEqual(Object.keys(merged.W1).sort(), ["2026-11-08", "2026-11-09", "2026-11-10"]);
    assert.strictEqual(merged.W1["2026-11-08"].play, 100, "旧单文件独有日期应补充合并");
    assert.strictEqual(merged.W1["2026-11-09"].play, 165, "冲突日期应以目录文件优先");
    assert.strictEqual(merged.W1["2026-11-10"].play, 220, "目录新日期应正常读出");
    assert.strictEqual(merged.W2["2026-11-09"].play, 40, "旧单文件独有作品应补充合并");
    assert.strictEqual(merged.W_OLD["2026-11-08"].play, 20);
    assert.strictEqual(merged["__proto__"]["2026-11-08"].play, 77);

    // 验证不删除、不迁移写入旧单文件
    assert.strictEqual(fs.existsSync(legacyFile), true, "不得删除旧 works-daily.json");
    assert.strictEqual(fs.readFileSync(legacyFile, "utf8"), legacyPayload, "不得修改旧 works-daily.json");
    assert.deepStrictEqual(
      fs.readdirSync(dir).sort(),
      ["2026-11-09.json", "2026-11-10.json"],
      "不得把旧单文件里的 2026-11-08 迁移写入目录"
    );

    // 6c. 旧单文件损坏时 warn 并跳过，不影响目录文件读取
    fs.writeFileSync(legacyFile, "{corrupt-legacy", "utf8");
    const { result: afterCorruptLegacy, warnings: wCorruptLegacy } = captureWarn(() =>
      store.readWorksDaily(group, platform)
    );
    assert.ok(wCorruptLegacy.some((m) => m.includes("works-daily.json")));
    assert.deepStrictEqual(Object.keys(afterCorruptLegacy.W1).sort(), ["2026-11-09", "2026-11-10"]);
    assert.strictEqual(afterCorruptLegacy.W1["2026-11-09"].play, 165);
    assert.strictEqual(afterCorruptLegacy.W1["2026-11-10"].play, 220);
    console.log("✓ 旧单文件 works-daily.json 兼容读取：目录优先、补充合并、不删不迁移、损坏跳过");
  }

  /* ---------- 7. 畸形指标校验统一（normalizeMetric）→ null 且不产生假增量 ---------- */
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
    console.log("✓ 畸形指标校验统一：store 与 statsTable 均归 null，不产生假零与假增量");
  }

  /* ---------- 8. 特殊 workId 往返（"__proto__" / "constructor" / "hasOwnProperty" / "toString"） ---------- */
  {
    const group = "特殊ID组";
    const platform = "小红书";
    const specialIds = ["__proto__", "constructor", "hasOwnProperty", "toString"];

    const empty = store.readWorksDaily(group, platform);
    assert.strictEqual(Object.getPrototypeOf(empty), null);

    // Day 1 首次写入
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

    // Day 1 同日二次采集仅更新 "constructor"（验证读回当天文件再合并不会丢失 "__proto__" 等其余特殊 ID）
    store.mergeWorks(
      group,
      platform,
      [
        {
          workId: "constructor",
          title: "特殊作品-constructor",
          url: "https://example.com/constructor",
          publishTime: Date.parse("2026-11-01T00:00:00Z") + 1000,
          play: 110,
          like: 11,
          comment: 1,
          share: 0,
          favorite: 2,
          fansDelta: null,
        },
      ],
      Date.parse("2026-11-10T08:00:00Z")
    );

    // Day 2 更新（验证跨日写入与读回不会丢失 Day 1 或 __proto__）
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
    console.log('✓ 特殊 workId（"__proto__" / "constructor" 等）无原型字典往返完整');
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


  /* ---------- 跨零点：以 collectNow 的 UTC+8 日期为唯一日期，零点前采集、零点后写入 → 写入前一天文件且三类文件一致 ---------- */
  {
    const G = "跨零点组", P = "抖音";
    const before = Date.parse("2026-11-10T15:59:59.900Z"); // UTC+8 2026-11-10 23:59:59.900
    const afterMidnight = Date.parse("2026-11-10T16:00:00.100Z"); // UTC+8 2026-11-11 00:00:00.100
    store.mergeDaily(G, P, { plays: 170 }, [], before - 60000);
    store.mergeWorks(G, P, [{ workId: "A", title: "a", publishTime: 1, play: 170 }], before - 60000);

    const dayFile = path.join(tmpRoot, "data-stats", G, P, "works-daily", "2026-11-10.json");
    const nextDayFile = path.join(tmpRoot, "data-stats", G, P, "works-daily", "2026-11-11.json");
    const intradayFile = path.join(tmpRoot, "data-stats", G, P, "works-intraday", "2026-11-10.json");
    const nextIntradayFile = path.join(tmpRoot, "data-stats", G, P, "works-intraday", "2026-11-11.json");

    const realNow = Date.now;
    const realFsync = fs.fsyncSync;
    let clock = before;
    let rolled = false;
    try {
      Date.now = () => clock;
      // daily.json 落盘 fsync 期间时钟跨过零点到次日 00:00:00.100
      fs.fsyncSync = (fd) => {
        realFsync(fd);
        if (!rolled) {
          rolled = true;
          clock = afterMidnight;
        }
      };
      store.mergeDaily(G, P, { plays: 250 }, [], before);
      store.mergeWorks(
        G,
        P,
        [
          { workId: "A", title: "a", publishTime: 1, play: 250 },
          { workId: "B", title: "b", publishTime: 2, play: 2 },
        ],
        before
      );
    } finally {
      Date.now = realNow;
      fs.fsyncSync = realFsync;
    }

    assert.strictEqual(rolled, true, "确认写入过程中已跨过零点");
    // 1) daily.json 归档在前一天 2026-11-10，不生成 2026-11-11
    const accDaily = store.readDaily(G, P);
    assert.strictEqual(accDaily["2026-11-10"].plays, 250, "daily.json 应按 collectNow 写入 2026-11-10");
    assert.strictEqual(accDaily["2026-11-11"], undefined, "不得因写入跨零点拆写到 2026-11-11");
    // 2) works-daily 归档在前一天 2026-11-10.json，不生成 2026-11-11.json
    const worksDaily = store.readWorksDaily(G, P);
    assert.strictEqual(worksDaily.A["2026-11-10"].play, 250, "works-daily 应与 daily 一致写入 250");
    assert.strictEqual(worksDaily.B["2026-11-10"].play, 2);
    assert.strictEqual(fs.existsSync(nextDayFile), false, "不得生成次日 works-daily/2026-11-11.json");
    // 3) works-intraday 归档在前一天 2026-11-10.json 的 23:00 槽，不生成 2026-11-11.json
    assert.strictEqual(fs.existsSync(intradayFile), true);
    assert.strictEqual(fs.existsSync(nextIntradayFile), false, "不得生成次日 works-intraday/2026-11-11.json");
    const intraday = store.readWorksIntraday(G, P);
    assert.strictEqual(intraday.A[intraday.A.length - 1].date, "2026-11-10");
    assert.strictEqual(intraday.A[intraday.A.length - 1].slot, "23:00");
    assert.strictEqual(intraday.A[intraday.A.length - 1].play, 250);
    assert.strictEqual(intraday.A[intraday.A.length - 1].collectedAt, before);
    // 4) 无临时文件残留
    assert.strictEqual(fs.readdirSync(path.dirname(dayFile)).filter((f) => f.endsWith(".tmp")).length, 0);
    assert.strictEqual(fs.readdirSync(path.dirname(intradayFile)).filter((f) => f.endsWith(".tmp")).length, 0);
    console.log("✓ 跨零点（零点前采集、零点后写入）：以 collectNow 的 UTC+8 日期写入前一天，daily/works-daily/works-intraday 三类文件一致");
  }

  /* ---------- 评审场景（S9-r3 #2）：2026-11-20 22:01 采到 170，23:59:59.900 采到 250 且 daily.json 替换时跨到 11-21 00:00:00.100 ---------- */
  {
    const G = "跨零点评审组", P = "抖音";
    const t2201 = Date.parse("2026-11-20T22:01:00+08:00");
    const tBeforeMid = Date.parse("2026-11-20T23:59:59.900+08:00");
    const tAfterMid = Date.parse("2026-11-21T00:00:00.100+08:00");

    store.mergeDaily(G, P, { plays: 170 }, [], t2201);
    store.mergeWorks(G, P, [{ workId: "W1", title: "短片", publishTime: Date.parse("2026-11-20T08:00:00+08:00"), play: 170 }], t2201);

    const realNow = Date.now;
    const realRename = fs.renameSync;
    let clock = tBeforeMid;
    let rolledOnDaily = false;
    try {
      Date.now = () => clock;
      fs.renameSync = (src, dest) => {
        const out = realRename(src, dest);
        if (!rolledOnDaily && typeof dest === "string" && path.basename(dest) === "daily.json") {
          rolledOnDaily = true;
          clock = tAfterMid;
        }
        return out;
      };
      store.mergeDaily(G, P, { plays: 250 }, [], tBeforeMid);
      store.mergeWorks(G, P, [{ workId: "W1", title: "短片", publishTime: Date.parse("2026-11-20T08:00:00+08:00"), play: 250 }], tBeforeMid);
    } finally {
      Date.now = realNow;
      fs.renameSync = realRename;
    }

    assert.strictEqual(rolledOnDaily, true);
    assert.strictEqual(store.readDaily(G, P)["2026-11-20"].plays, 250);
    assert.strictEqual(store.readDaily(G, P)["2026-11-21"], undefined);
    assert.strictEqual(store.readWorks(G, P).works[0].play, 250);
    assert.strictEqual(store.readWorksDaily(G, P).W1["2026-11-20"].play, 250);
    assert.strictEqual(store.readWorksDaily(G, P).W1["2026-11-21"], undefined);
    assert.deepStrictEqual(
      store.readWorksIntraday(G, P).W1.map((x) => [x.date, x.slot, x.play]),
      [
        ["2026-11-20", "22:00", 170],
        ["2026-11-20", "23:00", 250],
      ]
    );
    console.log("✓ [S9-r3 #2] 评审跨零点场景：daily.json 替换跨零点后不留半次写入，三类文件一致落盘 2026-11-20 (250)");
  }

  console.log("\n全部通过：works-daily 存储与 statsTable 长表构建");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
