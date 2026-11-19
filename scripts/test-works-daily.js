/**
 * 作品日快照存储（store.js）与长表行构建（statsTable.js）单元测试（不依赖 Electron 运行环境）：
 * 1. statsTable.js 纯函数模块独立加载（不依赖 electron / fs）
 * 2. store.mergeWorks → works-daily.json：同日覆盖、UTC+8 切日、跨日累计、null 指标、缺席作品不伪造
 * 3. store.mergeWorks：works-daily.json 写失败时仅 console.warn，不影响 works.json 与返回值
 * 4. buildWorkDailyRows：字段完整、首条 null、连续 gapDays=0、断档 gapDays、跨闰年
 * 5. buildWorkDailyRows：null 指标单双侧与 0 值增量、负增量照实输出
 * 6. buildWorkDailyRows：from/to 含端点过滤，且 from 之前记录仍参与增量与 gapDays 计算
 * 7. buildWorkDailyRows：已删除/未匹配作品、排序（date 升序 + 同日 publishTime 降序）
 * 8. 端到端串联（store.mergeWorks → readWorksDaily → buildWorkDailyRows）与脏输入防护
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
} = require("../src/main/services/dataStats/statsTable.js");

// mock electron.app（store.js 只用到 userData 路径）
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-works-daily-test-"));
require.cache[require.resolve("electron")] = {
  id: "electron",
  filename: "electron",
  loaded: true,
  exports: { app: { getPath: () => tmpRoot } },
};

const store = require("../src/main/services/dataStats/store.js");

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

try {
  /* ---------- 1. store: 同日覆盖 + UTC+8 切日 + 跨日累计 + null 指标 ---------- */
  {
    const group = "测试组A";
    const platform = "抖音";

    assert.deepStrictEqual(
      store.readWorksDaily(group, platform),
      {},
      "无文件时 readWorksDaily 应返回空对象"
    );

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

    // 验证物理文件路径符合约定
    const diskPath = path.join(tmpRoot, "data-stats", group, platform, "works-daily.json");
    assert.ok(fs.existsSync(diskPath), "works-daily.json 应落在 userData/data-stats/<分组>/<平台>/");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(diskPath, "utf8")), daily);
    console.log("✓ store.mergeWorks：同日覆盖 + UTC+8 切日 + 跨日累计 + null 指标正确");
  }

  /* ---------- 2. store: works-daily.json 写失败不得影响 mergeWorks ---------- */
  {
    const group = "写失败组";
    const platform = "快手";
    const accDir = path.join(tmpRoot, "data-stats", group, platform);
    fs.mkdirSync(accDir, { recursive: true });
    // 在 works-daily.json 位置放置一个同名目录，确保 fs.writeFileSync 必定抛 EISDIR（跨平台/含 root 生效）
    fs.mkdirSync(path.join(accDir, "works-daily.json"));

    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    let res;
    try {
      res = store.mergeWorks(
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
      );
    } finally {
      console.warn = origWarn;
    }

    assert.strictEqual(res.works.length, 1, "写日快照失败不得影响 mergeWorks 返回值");
    assert.strictEqual(res.works[0].workId, "KS1");
    assert.strictEqual(res.works[0].play, 300);
    assert.strictEqual(
      store.readWorks(group, platform).works[0].play,
      300,
      "works.json 应正常落盘"
    );
    assert.ok(
      warnings.some((m) => m.includes("works-daily.json")),
      "写入失败应通过 console.warn 输出警告"
    );

    // 补充 mock fs.writeFileSync 抛 EACCES 场景
    const origWriteFileSync = fs.writeFileSync;
    const warnings2 = [];
    console.warn = (...args) => warnings2.push(args.join(" "));
    fs.writeFileSync = function patchedWrite(file, ...rest) {
      if (String(file).endsWith("works-daily.json")) {
        const err = new Error("EACCES: permission denied");
        err.code = "EACCES";
        throw err;
      }
      return origWriteFileSync.call(fs, file, ...rest);
    };
    let res2;
    try {
      res2 = store.mergeWorks(
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
      );
    } finally {
      fs.writeFileSync = origWriteFileSync;
      console.warn = origWarn;
    }
    assert.strictEqual(res2.works[0].workId, "BV1");
    assert.strictEqual(store.readWorks("写失败组2", "哔哩哔哩").works[0].play, 99);
    assert.ok(warnings2.some((m) => m.includes("EACCES")));
    console.log("✓ store.mergeWorks：works-daily 写失败只 warn，不影响 works.json 与结果");
  }

  /* ---------- 3. statsTable: 基本增量、连续 gapDays=0、断档 gapDays、null 指标、负增量 ---------- */
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

  /* ---------- 4. statsTable: from / to 过滤（含端点），且保留 from 之前用于算增量 ---------- */
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

    // from=11-05, to=11-05（单日含端点）：增量应相对 11-02 计算，gapDays 应为 2
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

    // 仅 from=11-02：含端点 11-02..11-06，其中 11-02 相对 11-01 算增量
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

    // 仅 to=11-02：含端点 11-01..11-02
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

    // from > to 返回空
    assert.deepStrictEqual(
      buildWorkDailyRows({ group: "G", platform: "抖音", works, worksDaily, from: "2026-11-06", to: "2026-11-05" }),
      []
    );
    console.log("✓ buildWorkDailyRows：from / to 过滤（含端点）与跨界增量计算正确");
  }

  /* ---------- 5. statsTable: 已删除作品 + 排序（date 升序、同日 publishTime 降序） ---------- */
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

    // 11-11：NEW (11-10) → OLD (10-01) → DELETED_1 / NOPT (publishTime=""，按 workId 升序 DELETED_1 < NOPT)
    const day1 = rows.filter((r) => r.date === "2026-11-11");
    assert.deepStrictEqual(
      day1.map((r) => r.workId),
      ["NEW", "OLD", "DELETED_1", "NOPT"],
      "同日必须按 publishTime 降序排列，无发布时间置后"
    );

    // 11-12：NEW → OLD → DELETED_1
    const day2 = rows.filter((r) => r.date === "2026-11-12");
    assert.deepStrictEqual(day2.map((r) => r.workId), ["NEW", "OLD", "DELETED_1"]);

    // 全局日期升序
    assert.deepStrictEqual(
      rows.map((r) => r.date),
      ["2026-11-11", "2026-11-11", "2026-11-11", "2026-11-11", "2026-11-12", "2026-11-12", "2026-11-12"]
    );

    // 已删除作品字段检查
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

    // publishTime=0 规范为 ""
    const noptRow = day1.find((r) => r.workId === "NOPT");
    assert.strictEqual(noptRow.publishTime, "");
    console.log("✓ buildWorkDailyRows：已删除作品兜底标题 + date 升序 / publishTime 降序正确");
  }

  /* ---------- 6. 端到端串联（store → statsTable）与脏输入防护 ---------- */
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

    // 脏输入与空输入不抛错
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
