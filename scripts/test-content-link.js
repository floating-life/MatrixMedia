/**
 * 跨平台作品关联（contentLink.js）、pushData 读取（pushRecords.js）与
 * buildWorkDailyRows 可选 link 参数单元测试（不依赖 Electron 运行环境）：
 *
 * 1. normalizeTitle / normalizeUrl / isManagementUrl（含 query 保留、追踪参数剥离、管理页识别）
 * 2. buildContentIndex：仅完整路径归桶、同名不同目录不合并、无完整路径独立 record:*、
 *    不按 basename/标题归桶、同文件两次实发独立 target、仅已确认发布纳入、图文排除
 * 3. linkWorks：同 group+platform 内严格 1:1 直链与唯一标题匹配；反例不误关联：
 *    id=1/id=2 查询参数直链、1 直链多 target/多 work 全留空、同组同标题两条作品、
 *    target 直链与 work 直链冲突、定时/草稿/未发布记录不吸旧作品、取消全局标题兜底、
 *    视频号短标题（shortTitle / bt2Filled）匹配与管理页兜底链接排除
 * 4. buildContentSummaryRows：截止日仅读 worksDaily（不回退 works.json、不泄漏未来值）、
 *    无指标已确认内容保留行、perPlatform 多作品 urls/workIds 求和、platformCount 按平台名计、
 *    group|platform|workId 去重、firstPublishDate（UTC+8 最小值）与 firstPublishDateSource、
 *    publishTime 越界（1e20 / 8.64e15 / 1999 / 2101）不崩、合计 null 语义、特殊 workId 防原型污染
 * 5. buildWorkDailyRows：不传 link 保持原契约；传 Map 附加 contentKey / matchedBy；非 Map 忽略
 * 6. pushRecords.readPushRecords：目录注入、损坏/非数组/EISDIR 跳过+warn、from/to、默认目录回退与端到端串联
 *
 * 运行：node scripts/test-content-link.js
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 先加载纯函数模块与 pushRecords（在 mock electron 之前），验证不强依赖 electron
const {
  FUZZY_SIM_THRESHOLD,
  FUZZY_MISSING_TIME_PENALTY,
  FUZZY_MARGIN_MIN,
  FUZZY_MAX_DAY_DIFF,
  FUZZY_SUBSTRING_MIN_LEN,
  FUZZY_SUBSTRING_SCORE,
  FUZZY_THRESHOLDS,
  normalizeTitle,
  extractCoreTitle,
  computeTitleSimilarity,
  buildTitleIndex,
  normalizeUrl,
  isManagementUrl,
  makeWorkKey,
  buildContentIndex,
  linkWorks,
  buildContentSummaryRows,
} = require("../src/main/services/dataStats/contentLink.js");
const { buildWorkDailyRows } = require("../src/main/services/dataStats/statsTable.js");
const { readPushRecords, getPushDataDir } = require("../src/main/services/dataStats/pushRecords.js");

function captureWarn(fn) {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = origWarn;
  }
}

/* ---------- 1. normalizeTitle / normalizeUrl / isManagementUrl ---------- */
{
  assert.strictEqual(normalizeTitle(null), "");
  assert.strictEqual(normalizeTitle(undefined), "");
  assert.strictEqual(normalizeTitle("   "), "");
  assert.strictEqual(
    normalizeTitle("  \u200B今天\uFEFF学做　　红烧肉（超好吃）！\t\n "),
    "今天学做 红烧肉(超好吃)!"
  );
  assert.strictEqual(
    normalizeTitle("【干货】AI实战：效率提升，看这篇就够了。"),
    "[干货]AI实战:效率提升,看这篇就够了."
  );
  assert.strictEqual(normalizeTitle("红烧肉教程 #美食 #家常菜"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("红烧肉教程 #美食[话题]# #家常菜[话题]#"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("标题 #话题"), "标题");
  assert.strictEqual(normalizeTitle("零基础学 C# #编程"), "零基础学 C#");
  assert.strictEqual(normalizeTitle("C#入门"), "C#入门");
  assert.strictEqual(normalizeTitle("C#进阶"), "C#进阶");
  assert.strictEqual(normalizeTitle("C#入门 #编程"), "C#入门");
  assert.strictEqual(normalizeTitle("标题#紧贴非话题"), "标题#紧贴非话题");
  assert.strictEqual(normalizeTitle("#开箱 新品评测 #数码"), "#开箱 新品评测");
  assert.strictEqual(normalizeTitle("#纯标签1 #纯标签2"), "");
  // 坏对象 / 数组 / 布尔不崩且视为空串，number 可转串
  assert.strictEqual(normalizeTitle({ toString: null }), "");
  assert.strictEqual(normalizeTitle(["a", "b"]), "");
  assert.strictEqual(normalizeTitle(true), "");
  assert.strictEqual(normalizeTitle(2026), "2026");
  assert.strictEqual(normalizeUrl({ toString: null }), "");

  // normalizeUrl：保留 path 与标识作品的 query 参数，去除 fragment、尾斜杠与常见追踪参数
  assert.strictEqual(
    normalizeUrl("https://baijiahao.baidu.com/s?id=1&utm_source=app&spm=1.2&share_from=wx#top"),
    "https://baijiahao.baidu.com/s?id=1"
  );
  assert.strictEqual(
    normalizeUrl("https://baijiahao.baidu.com/s?id=2&utm_medium=feed"),
    "https://baijiahao.baidu.com/s?id=2"
  );
  assert.notStrictEqual(
    normalizeUrl("https://baijiahao.baidu.com/s?id=1"),
    normalizeUrl("https://baijiahao.baidu.com/s?id=2"),
    "不同 id 查询参数必须保持区分"
  );
  assert.strictEqual(
    normalizeUrl("https://www.bilibili.com/video/BV1Ab2Cd3Ef/?p=2&spm_id_from=333&vd_source=abc"),
    "https://www.bilibili.com/video/BV1Ab2Cd3Ef?p=2"
  );
  assert.strictEqual(
    normalizeUrl("https://www.douyin.com/video/7123456/?modeFrom=userPost#top"),
    "https://www.douyin.com/video/7123456"
  );
  assert.strictEqual(
    normalizeUrl("https://www.toutiao.com/a712345///"),
    "https://www.toutiao.com/a712345"
  );
  assert.strictEqual(normalizeUrl("  "), "");
  assert.strictEqual(normalizeUrl(null), "");

  // 管理页兜底链接识别
  assert.strictEqual(isManagementUrl("https://channels.weixin.qq.com/platform/post/list"), true);
  assert.strictEqual(isManagementUrl("https://channels.weixin.qq.com/platform/"), true);
  assert.strictEqual(
    isManagementUrl("https://baijiahao.baidu.com/builder/rc/content?currentPage=1&pageSize=10"),
    true
  );
  assert.strictEqual(isManagementUrl("https://creator.douyin.com/creator-micro/content/manage"), true);
  assert.strictEqual(isManagementUrl("https://www.douyin.com/video/7123456"), false);
  assert.strictEqual(isManagementUrl("https://baijiahao.baidu.com/s?id=1"), false);
  console.log("✓ normalizeTitle / normalizeUrl / isManagementUrl 正确");
}

/* ---------- 2. buildContentIndex：完整路径归桶、同名不同目录分离、独立 target、图文/未发布排除 ---------- */
{
  const records = [
    // 2a. 同文件跨平台（真实 pushData 形态：filePath 完整路径 + selectedFile basename；兼容 selectedFile 写完整路径）
    {
      pt: "快手",
      phone: "运营一组-快手",
      bt: "春季穿搭分享！ #穿搭",
      selectedFile: "look_01.mp4",
      filePath: "D:\\Videos\\Look_01.MP4",
      publishStatus: "success",
      videoLink: "",
      date: "2026-11-11",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "运营一组",
      phone: "运营一组-抖音",
      title: "最早记录原标题！ #穿搭 #日常",
      selectedFile: "  d:/videos/look_01.mp4  ",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/9001?from=share",
      date: "2026-11-10",
      textType: "local",
    },
    // 2b. 同名不同目录（评审反例 #1）：D:\美食\final.mp4 vs D:\旅行\final.mp4 绝不合并
    {
      pt: "抖音",
      group: "G1",
      title: "美食日记",
      selectedFile: "final.mp4",
      filePath: "D:\\美食\\final.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/101",
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "旅行日记",
      selectedFile: "final.mp4",
      filePath: "D:\\旅行\\final.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/102",
      date: "2026-11-10",
      textType: "local",
    },
    // 2c. 只有 basename（无完整路径）的两条同名记录 → 各自独立为 record:*，绝不按 basename 归桶
    {
      id: "rec-a",
      pt: "抖音",
      group: "G1",
      title: "同basename测试",
      selectedFile: "final.mp4",
      publishStatus: "success",
      date: "2026-11-12",
      textType: "local",
    },
    {
      id: "rec-b",
      pt: "快手",
      group: "G1",
      title: "同basename测试",
      selectedFile: "final.mp4",
      publishStatus: "success",
      date: "2026-11-12",
      textType: "local",
    },
    // 2d. 无文件名但同标题的两条记录 → 各自独立为 record:*，绝不按标题归桶
    {
      pt: "抖音",
      group: "G1",
      title: "无文件名相同标题",
      selectedFile: "",
      publishStatus: "success",
      date: "2026-11-13",
      textType: "local",
    },
    {
      pt: "小红书",
      group: "G1",
      title: "无文件名相同标题",
      selectedFile: "",
      publishStatus: "success",
      date: "2026-11-13",
      textType: "local",
    },
    // 2e. 图文记录（即便与视频同完整路径、状态 success、有直链）必须排除
    {
      pt: "百家号",
      group: "运营一组",
      title: "图文排除测试",
      selectedFile: "look_01.mp4",
      filePath: "D:\\Videos\\Look_01.MP4",
      publishStatus: "success",
      videoLink: "https://baijiahao.baidu.com/s?id=999",
      date: "2026-11-09",
      textType: "article",
    },
    // 2f. 未确认发布状态（scheduled / publishing / failed / draft / abnormal / publishing+管理页兜底链接）全部排除
    {
      pt: "抖音",
      group: "G1",
      title: "定时任务未发",
      filePath: "D:\\待发\\sched.mp4",
      publishStatus: "scheduled",
      scheduledTask: true,
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "发布中未确认",
      filePath: "D:\\待发\\pub.mp4",
      publishStatus: "publishing",
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "发布失败",
      filePath: "D:\\待发\\fail.mp4",
      publishStatus: "failed",
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "仅保存草稿",
      filePath: "D:\\待发\\draft.mp4",
      publishStatus: "draft",
      publishSuccessCount: 1,
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "视频号",
      group: "G1",
      title: "管理页链接不算已确认",
      filePath: "D:\\待发\\sph_mgmt.mp4",
      publishStatus: "publishing",
      videoLink: "https://channels.weixin.qq.com/platform/post/list",
      date: "2026-11-10",
      textType: "local",
    },
    // 2g. 历史记录缺 publishStatus 但有有效非管理页直链 → 视为已确认发布
    {
      id: "legacy-1",
      pt: "头条",
      group: "G1",
      title: "历史直链确认",
      filePath: "D:\\历史\\old.mp4",
      videoLink: "https://www.toutiao.com/a777888/",
      date: "2026-11-10",
      textType: "local",
    },
  ];

  const contents = buildContentIndex(records);
  assert.strictEqual(contents.length, 8, "应产出 8 个独立内容（look_01 + 美食 + 旅行 + 2×basename + 2×无文件 + 历史直链）");

  const look = contents.find((c) => c.contentKey === "file:d:/videos/look_01.mp4");
  assert.ok(look, "同完整路径跨平台应归入同一桶");
  assert.strictEqual(look.firstPublishDate, "2026-11-10", "图文 11-09 必须被排除，首发日为 11-10");
  assert.strictEqual(look.displayTitle, "最早记录原标题！ #穿搭 #日常", "displayTitle 必须用最早记录原标题");
  assert.strictEqual(look.targets.length, 2);
  assert.strictEqual(look.targets.find((t) => t.platform === "快手").group, "运营一组");

  // 同名不同目录各自独立成桶
  assert.ok(contents.find((c) => c.contentKey === "file:d:/美食/final.mp4"));
  assert.ok(contents.find((c) => c.contentKey === "file:d:/旅行/final.mp4"));

  // 无完整路径各自独立为 record:<日期>:<id或序号>
  assert.ok(contents.find((c) => c.contentKey === "record:2026-11-12:rec-a"));
  assert.ok(contents.find((c) => c.contentKey === "record:2026-11-12:rec-b"));
  const noFileContents = contents.filter((c) => c.contentKey.startsWith("record:2026-11-13:"));
  assert.strictEqual(noFileContents.length, 2, "无文件名同标题两条记录绝不按标题合并");

  // 历史有效直链确认纳入
  assert.ok(contents.find((c) => c.contentKey === "file:d:/历史/old.mp4"));

  // 确认未发布记录与图文全部排除
  assert.strictEqual(
    contents.some((c) => c.contentKey.includes("待发") || c.displayTitle === "图文排除测试"),
    false
  );
  console.log("✓ buildContentIndex：完整路径归桶、同名不同目录隔离、无完整路径不归桶、图文与未发布排除正确");
}

/* ---------- 3. 反例集：同名不同目录汇总不合并 + id=1/id=2 查询参数直链 + 1直链多target全留空 ---------- */
{
  // 3a. 评审反例 #1：D:\美食\final.mp4 (100 播放) 与 D:\旅行\final.mp4 (900 播放) 绝不汇成 1000
  const contents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "美食视频",
      selectedFile: "final.mp4",
      filePath: "D:\\美食\\final.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/100",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "旅行视频",
      selectedFile: "final.mp4",
      filePath: "D:\\旅行\\final.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/900",
      date: "2026-11-10",
    },
  ]);
  const accounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "100", title: "美食视频", url: "https://www.douyin.com/video/100", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "900", title: "旅行视频", url: "https://www.douyin.com/video/900", publishTime: Date.parse("2026-11-10T05:00:00Z") },
      ],
    },
  ];
  const worksDaily = {
    "G1|抖音": {
      100: { "2026-11-10": { play: 100, like: 10, comment: 1, share: 0, favorite: 2, fansDelta: 1 } },
      900: { "2026-11-10": { play: 900, like: 90, comment: 9, share: 5, favorite: 20, fansDelta: 8 } },
    },
  };
  const rows = buildContentSummaryRows({ contents, accounts, worksDaily });
  assert.strictEqual(rows.length, 2, "同名不同目录必须保持为 2 条独立内容行");
  assert.strictEqual(rows.find((r) => r.contentKey === "file:d:/美食/final.mp4").totalPlay, 100);
  assert.strictEqual(rows.find((r) => r.contentKey === "file:d:/旅行/final.mp4").totalPlay, 900);

  // 3b. 评审反例 #2：百家号 …/s?id=1 与 …/s?id=2 查询参数直链不混淆、不对调
  const bjhContents = buildContentIndex([
    {
      pt: "百家号",
      group: "G1",
      title: "相同标题",
      filePath: "D:\\a\\v1.mp4",
      publishStatus: "success",
      videoLink: "https://baijiahao.baidu.com/s?id=1&utm_source=app#hash",
      date: "2026-11-10",
    },
    {
      pt: "百家号",
      group: "G1",
      title: "相同标题",
      filePath: "D:\\b\\v2.mp4",
      publishStatus: "success",
      videoLink: "https://baijiahao.baidu.com/s?id=2&share_from=wx",
      date: "2026-11-10",
    },
  ]);
  const bjhLink = linkWorks({
    contents: bjhContents,
    accounts: [
      {
        group: "G1",
        platform: "百家号",
        works: [
          { workId: "b1", title: "相同标题", url: "https://baijiahao.baidu.com/s?id=1" },
          { workId: "b2", title: "相同标题", url: "https://baijiahao.baidu.com/s?id=2" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(bjhLink.get("G1|百家号|b1"), { contentKey: "file:d:/a/v1.mp4", matchedBy: "link" });
  assert.deepStrictEqual(bjhLink.get("G1|百家号|b2"), { contentKey: "file:d:/b/v2.mp4", matchedBy: "link" });

  // 3c. 一个直链对应多个 target（如获取状态误回写同链）或对应多个 work → 全部留空，且不得经标题绕过
  const dupTargetLinkContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "唯一标题甲",
      filePath: "D:\\a\\one.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/555",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "唯一标题乙",
      filePath: "D:\\b\\two.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/555",
      date: "2026-11-10",
    },
  ]);
  const dupTargetLink = linkWorks({
    contents: dupTargetLinkContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [{ workId: "555", title: "唯一标题甲", url: "https://www.douyin.com/video/555" }],
      },
    ],
  });
  assert.deepStrictEqual(
    dupTargetLink.get("G1|抖音|555"),
    { contentKey: null, matchedBy: null },
    "同一直链指向多个 target 时必须留空，不得降级靠标题关联"
  );

  const dupWorkLinkContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "单目标标题",
      filePath: "D:\\a\\single.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/666",
      date: "2026-11-10",
    },
  ]);
  const dupWorkLink = linkWorks({
    contents: dupWorkLinkContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "w666a", title: "单目标标题", url: "https://www.douyin.com/video/666" },
          { workId: "w666b", title: "另一标题", url: "https://www.douyin.com/video/666?from=share" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(dupWorkLink.get("G1|抖音|w666a"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(dupWorkLink.get("G1|抖音|w666b"), { contentKey: null, matchedBy: null });
  console.log("✓ 同名不同目录分离、id=1/id=2 查询参数直链、1 直链多目标/多作品全留空正确");
}

/* ---------- 4. 反例集：同组同标题两条作品、直链冲突、取消全局兜底、同文件两次实发 ---------- */
{
  // 4a. 评审反例 #4：同组同平台同标题两条作品（即使发布时间 09:00 / 12:00 区分）→ 不做时间猜测，全部留空
  const sameTitleContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "每日打卡 #日常",
      filePath: "D:\\a\\morning.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "每日打卡",
      filePath: "D:\\b\\noon.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  const sameTitleLink = linkWorks({
    contents: sameTitleContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "m1", title: "每日打卡", url: "https://www.douyin.com/video/1", publishTime: Date.parse("2026-11-10T01:00:00Z") },
          { workId: "m2", title: "每日打卡", url: "https://www.douyin.com/video/2", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        ],
      },
    ],
  });
  assert.deepStrictEqual(sameTitleLink.get("G1|抖音|m1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(sameTitleLink.get("G1|抖音|m2"), { contentKey: null, matchedBy: null });

  // 仅 1 条 target 但同组有 2 条同标题作品 → 同样全部留空
  const oneTargetTwoWorks = linkWorks({
    contents: buildContentIndex([
      { pt: "抖音", group: "G1", title: "双作品冲突", filePath: "D:\\a\\only1.mp4", publishStatus: "success", date: "2026-11-10" },
    ]),
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "tw1", title: "双作品冲突", url: "https://www.douyin.com/video/11" },
          { workId: "tw2", title: "双作品冲突 #热门", url: "https://www.douyin.com/video/12" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(oneTargetTwoWorks.get("G1|抖音|tw1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(oneTargetTwoWorks.get("G1|抖音|tw2"), { contentKey: null, matchedBy: null });

  // 4b. 评审反例 #4：target 已有有效直链 /201，同名作品直链 /202（或空）→ 不得靠标题关联
  const conflictLink = linkWorks({
    contents: buildContentIndex([
      {
        pt: "抖音",
        group: "G1",
        title: "直链冲突视频",
        filePath: "D:\\a\\c201.mp4",
        publishStatus: "success",
        videoLink: "https://www.douyin.com/video/201",
        date: "2026-11-10",
      },
      {
        pt: "快手",
        group: "G1",
        title: "直链与空链冲突",
        filePath: "D:\\a\\ks301.mp4",
        publishStatus: "success",
        videoLink: "https://www.kuaishou.com/short-video/301",
        date: "2026-11-10",
      },
    ]),
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [{ workId: "202", title: "直链冲突视频", url: "https://www.douyin.com/video/202" }],
      },
      {
        group: "G1",
        platform: "快手",
        works: [{ workId: "302", title: "直链与空链冲突", url: "" }],
      },
    ],
  });
  assert.deepStrictEqual(conflictLink.get("G1|抖音|202"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(conflictLink.get("G1|快手|302"), { contentKey: null, matchedBy: null });

  // 4c. 删除全局标题兜底：不同 group 或不同 platform 即便标题全局唯一也不得跨界关联
  const crossGpLink = linkWorks({
    contents: buildContentIndex([
      {
        pt: "快手",
        group: "旧分组",
        title: "全球唯一测试标题",
        filePath: "D:\\a\\uniq.mp4",
        publishStatus: "success",
        date: "2026-11-10",
      },
    ]),
    accounts: [
      { group: "新分组", platform: "快手", works: [{ workId: "k1", title: "全球唯一测试标题" }] },
      { group: "旧分组", platform: "抖音", works: [{ workId: "d1", title: "全球唯一测试标题" }] },
    ],
  });
  assert.deepStrictEqual(crossGpLink.get("新分组|快手|k1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(crossGpLink.get("旧分组|抖音|d1"), { contentKey: null, matchedBy: null });

  // 4d. 评审反例 #5：同文件两次实发各自成 target，直链均命中时单元格求和并列出全部 urls / workIds
  const twiceContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "同片重发",
      filePath: "D:\\clips\\repost.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/701",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "同片重发",
      filePath: "D:\\clips\\repost.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/702",
      date: "2026-11-12",
    },
  ]);
  assert.strictEqual(twiceContents.length, 1);
  assert.strictEqual(twiceContents[0].targets.length, 2, "同文件两次实发必须各自成独立 target，不折叠");

  const twiceAccounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "701", title: "同片重发", url: "https://www.douyin.com/video/701", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "702", title: "同片重发", url: "https://www.douyin.com/video/702", publishTime: Date.parse("2026-11-12T04:00:00Z") },
      ],
    },
  ];
  const twiceDaily = {
    "G1|抖音": {
      701: { "2026-11-12": { play: 300, like: 30, comment: null, share: 0, favorite: 5, fansDelta: 2 } },
      702: { "2026-11-12": { play: 500, like: 50, comment: null, share: null, favorite: 10, fansDelta: 3 } },
    },
  };
  const twiceLink = linkWorks({ contents: twiceContents, accounts: twiceAccounts });
  assert.deepStrictEqual(twiceLink.get("G1|抖音|701"), { contentKey: "file:d:/clips/repost.mp4", matchedBy: "link" });
  assert.deepStrictEqual(twiceLink.get("G1|抖音|702"), { contentKey: "file:d:/clips/repost.mp4", matchedBy: "link" });

  const twiceRows = buildContentSummaryRows({
    contents: twiceContents,
    accounts: twiceAccounts,
    link: twiceLink,
    worksDaily: twiceDaily,
  });
  assert.strictEqual(twiceRows.length, 1);
  assert.strictEqual(twiceRows[0].platformCount, 1, "同平台两次实发 platformCount 仍为 1");
  assert.strictEqual(twiceRows[0].totalPlay, 800);
  assert.strictEqual(twiceRows[0].totalComment, null, "全 null 合计为 null");
  assert.strictEqual(twiceRows[0].totalShare, 0, "0 + null 合计为 0");
  assert.deepStrictEqual(twiceRows[0].perPlatform["抖音|G1"].urls, [
    "https://www.douyin.com/video/701",
    "https://www.douyin.com/video/702",
  ]);
  assert.deepStrictEqual(twiceRows[0].perPlatform["抖音|G1"].workIds, ["701", "702"]);
  assert.strictEqual(twiceRows[0].firstPublishDate, "2026-11-10");
  assert.strictEqual(twiceRows[0].firstPublishDateSource, "work");
  console.log("✓ 同组同标题留空、直链冲突禁配、取消全局兜底与同文件两次实发独立 target/多作品汇总正确");
}

/* ---------- 5. 定时未发布不吸旧作品 + 已完成定时任务日期 + 视频号短标题匹配 ---------- */
{
  // 5a. 评审反例 #6：11-10 登记的定时任务未发布时，绝不能凭标题吸走 11-08 的旧作品
  const schedPendingContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "每周复盘",
      filePath: "D:\\sched\\ep2.mp4",
      scheduledTask: true,
      publishStatus: "scheduled",
      date: "2026-11-10",
    },
  ]);
  assert.strictEqual(schedPendingContents.length, 0, "scheduled 记录不得进入内容索引");
  const schedPendingLink = linkWorks({
    contents: schedPendingContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [{ workId: "old08", title: "每周复盘", url: "https://www.douyin.com/video/8", publishTime: Date.parse("2026-11-08T04:00:00Z") }],
      },
    ],
  });
  assert.deepStrictEqual(schedPendingLink.get("G1|抖音|old08"), { contentKey: null, matchedBy: null });

  // 已完成的定时任务（11-10 登记、11-20 实发）：未采集时首发日取 lastPublishAt(11-20) 且 source="record"；
  // 关联到作品后首发日取作品 publishTime 且 source="work"
  const schedDoneContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "定时发布完成",
      filePath: "D:\\sched\\done.mp4",
      scheduledTask: true,
      publishStatus: "success",
      date: "2026-11-10",
      lastPublishAt: Date.parse("2026-11-20T04:00:00Z"),
    },
  ]);
  assert.strictEqual(schedDoneContents[0].firstPublishDate, "2026-11-20");
  const uncollectedSchedRows = buildContentSummaryRows({ contents: schedDoneContents, accounts: [], worksDaily: {} });
  assert.strictEqual(uncollectedSchedRows.length, 1);
  assert.strictEqual(uncollectedSchedRows[0].firstPublishDate, "2026-11-20");
  assert.strictEqual(uncollectedSchedRows[0].firstPublishDateSource, "record");
  assert.strictEqual(uncollectedSchedRows[0].totalPlay, null);

  // 5b. 评审反例 #7：视频号短标题（shortTitle 与旧字段 bt2Filled）匹配 + 管理页兜底链接不阻断标题匹配
  const sphContents = buildContentIndex([
    {
      pt: "视频号",
      group: "主号组",
      title: "超长主标题：零基础三步学会红烧肉！ #美食 #家常菜",
      shortTitle: "三步学会红烧肉",
      filePath: "D:\\cook\\hongshaorou.mp4",
      publishStatus: "success",
      videoLink: "https://channels.weixin.qq.com/platform/post/list",
      date: "2026-11-10",
    },
    {
      pt: "视频号",
      group: "主号组",
      title: "历史视频长标题",
      bt2Filled: "历史短标题",
      filePath: "D:\\cook\\legacy.mp4",
      publishStatus: "success",
      date: "2026-11-11",
    },
  ]);
  assert.strictEqual(sphContents[0].targets[0].videoLink, "", "管理页兜底链接不得作为有效直链");
  assert.ok(sphContents[0].targets[0].matchTitles.includes("三步学会红烧肉"));
  assert.ok(sphContents[1].targets[0].matchTitles.includes("历史短标题"));

  const sphAccounts = [
    {
      group: "主号组",
      platform: "视频号",
      works: [
        { workId: "sph1", title: "三步学会红烧肉", url: "", publishTime: Date.parse("2026-11-10T17:00:00Z") }, // UTC+8 为 2026-11-11
        { workId: "sph2", title: "历史短标题", url: "", publishTime: Date.parse("2026-11-11T04:00:00Z") },
      ],
    },
  ];
  const sphLink = linkWorks({ contents: sphContents, accounts: sphAccounts });
  assert.deepStrictEqual(sphLink.get("主号组|视频号|sph1"), {
    contentKey: "file:d:/cook/hongshaorou.mp4",
    matchedBy: "title",
  });
  assert.deepStrictEqual(sphLink.get("主号组|视频号|sph2"), {
    contentKey: "file:d:/cook/legacy.mp4",
    matchedBy: "title",
  });

  const sphRows = buildContentSummaryRows({
    contents: sphContents,
    accounts: sphAccounts,
    link: sphLink,
    worksDaily: {
      "主号组|视频号": {
        sph1: { "2026-11-11": { play: 1200, like: 80, comment: 10, share: 5, favorite: 30, fansDelta: 4 } },
        sph2: { "2026-11-11": { play: 400, like: 20, comment: 2, share: 1, favorite: 5, fansDelta: 0 } },
      },
    },
  });
  const r1 = sphRows.find((r) => r.contentKey === "file:d:/cook/hongshaorou.mp4");
  assert.strictEqual(r1.title, "超长主标题：零基础三步学会红烧肉！ #美食 #家常菜", "展示标题保留原文");
  assert.strictEqual(r1.firstPublishDate, "2026-11-11", "UTC+8 跨日 publishTime 应归 2026-11-11");
  assert.strictEqual(r1.firstPublishDateSource, "work");
  assert.strictEqual(r1.totalPlay, 1200);
  assert.deepStrictEqual(r1.perPlatform["视频号|主号组"].urls, []);
  assert.deepStrictEqual(r1.perPlatform["视频号|主号组"].workIds, ["sph1"]);

  // 视频号两作品分别命中同一 target 的主标题与短标题 → 争抢同一 target，全部留空
  const aliasConflictLink = linkWorks({
    contents: buildContentIndex([
      {
        pt: "视频号",
        group: "G1",
        title: "主标题甲",
        shortTitle: "短标题乙",
        filePath: "D:\\cook\\conflict.mp4",
        publishStatus: "success",
        date: "2026-11-10",
      },
    ]),
    accounts: [
      {
        group: "G1",
        platform: "视频号",
        works: [
          { workId: "a1", title: "主标题甲", url: "" },
          { workId: "a2", title: "短标题乙", url: "" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(aliasConflictLink.get("G1|视频号|a1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(aliasConflictLink.get("G1|视频号|a2"), { contentKey: null, matchedBy: null });
  console.log("✓ 定时未发布不吸旧作品、已完成定时任务首发日与视频号短标题匹配正确");
}

/* ---------- 6. 截止日不泄漏未来值、无指标保留行、publishTime 1e20 不崩、null 语义、platformCount & 去重 ---------- */
{
  const contents = buildContentIndex([
    // 已确认发布、有 works.json 累计值 900，但无 11-11 及以前 worksDaily 快照
    {
      pt: "抖音",
      group: "主号组",
      title: "截止日测试",
      filePath: "D:\\stats\\cutoff.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/c1",
      date: "2026-11-10",
    },
    // 已确认发布但尚未采集到任何作品
    {
      pt: "快手",
      group: "主号组",
      title: "未采集内容",
      filePath: "D:\\stats\\no_metrics.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
    // 同平台跨两个分组（检验 platformCount 按不同平台名计）
    {
      pt: "抖音",
      group: "组A",
      title: "同平台双组",
      filePath: "D:\\stats\\multi_group.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/mg1",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "组B",
      title: "同平台双组",
      filePath: "D:\\stats\\multi_group.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/mg2",
      date: "2026-11-10",
    },
  ]);

  const accounts = [
    {
      group: "主号组",
      platform: "抖音",
      works: [
        // works.json 里有 play: 900，绝不能在缺日快照时泄漏！
        {
          workId: "c1",
          title: "截止日测试",
          url: "https://www.douyin.com/video/c1",
          publishTime: Date.parse("2026-11-10T04:00:00Z"),
          play: 900,
          like: 90,
        },
        // 越界时间戳 1e20 与其他非法时间绝不抛 RangeError
        {
          workId: "bad_ts_1",
          title: "越界时间作品1",
          url: "https://www.douyin.com/video/bad1",
          publishTime: 1e20,
        },
        {
          workId: "bad_ts_2",
          title: "越界时间作品2",
          url: "https://www.douyin.com/video/bad2",
          publishTime: 8.64e15,
        },
        {
          workId: "bad_ts_3",
          title: "1999年时间作品",
          url: "https://www.douyin.com/video/bad3",
          publishTime: Date.parse("1999-12-31T23:59:59Z"),
        },
        {
          workId: "bad_ts_4",
          title: "2101年时间作品",
          url: "https://www.douyin.com/video/bad4",
          publishTime: Date.parse("2101-01-01T00:00:00Z"),
        },
      ],
    },
    {
      group: "组A",
      platform: "抖音",
      works: [
        { workId: "mg1", title: "同平台双组", url: "https://www.douyin.com/video/mg1", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        // 同 group|platform|workId 重复出现 → 只计一次
        { workId: "mg1", title: "同平台双组", url: "https://www.douyin.com/video/mg1", publishTime: Date.parse("2026-11-10T04:00:00Z") },
      ],
    },
    {
      group: "组B",
      platform: "抖音",
      works: [
        { workId: "mg2", title: "同平台双组", url: "https://www.douyin.com/video/mg2", publishTime: Date.parse("2026-11-11T04:00:00Z") },
      ],
    },
  ];

  // 6a. 评审反例 #8：worksDaily 只有 2026-11-19 的 900，或完全没有该账号快照 → 截止 2026-11-11 绝不泄漏 900
  const worksDailyFuture = {
    "主号组|抖音": {
      c1: { "2026-11-19": { play: 900, like: 90, comment: 9, share: 3, favorite: 12, fansDelta: 5 } },
      bad_ts_1: { "2026-11-10": { play: 50, like: 0, comment: null, share: null, favorite: null, fansDelta: null } },
      bad_ts_2: { "2026-11-10": { play: 10, like: null, comment: null, share: null, favorite: null, fansDelta: null } },
      bad_ts_3: { "2026-11-10": { play: 20, like: null, comment: null, share: null, favorite: null, fansDelta: null } },
      bad_ts_4: { "2026-11-10": { play: 30, like: null, comment: null, share: null, favorite: null, fansDelta: null } },
    },
    "组A|抖音": {
      mg1: {
        "2026-11-10": { play: 100, like: 0, comment: null, share: 0, favorite: null, fansDelta: -2 },
        "2026-11-15": { play: 800, like: 80, comment: 8, share: 4, favorite: 10, fansDelta: 10 },
      },
    },
    "组B|抖音": {
      mg2: { "2026-11-11": { play: 250, like: null, comment: null, share: 0, favorite: null, fansDelta: 5 } },
    },
  };

  const asOf11 = buildContentSummaryRows({
    contents,
    accounts,
    worksDaily: worksDailyFuture,
    date: "2026-11-11",
  });

  // c1 不泄漏 11-19 的 900，但已确认发布的内容仍保留行且指标为 null
  const cutoffRow = asOf11.find((r) => r.contentKey === "file:d:/stats/cutoff.mp4");
  assert.ok(cutoffRow, "无截至 11-11 快照的已确认发布内容必须保留行");
  assert.strictEqual(cutoffRow.totalPlay, null, "不得泄漏 11-19 或 works.json 的 900 播放");
  assert.strictEqual(cutoffRow.totalLike, null);
  assert.strictEqual(cutoffRow.platformCount, 0);
  assert.deepStrictEqual(cutoffRow.perPlatform, {});
  assert.strictEqual(cutoffRow.firstPublishDate, "2026-11-10");
  assert.strictEqual(cutoffRow.firstPublishDateSource, "work");

  // 完全未采集的已确认发布内容保留行，指标全 null，firstPublishDateSource = "record"
  const noMetricRow = asOf11.find((r) => r.contentKey === "file:d:/stats/no_metrics.mp4");
  assert.ok(noMetricRow, "未采集的已确认发布内容必须保留行");
  assert.strictEqual(noMetricRow.totalPlay, null);
  assert.strictEqual(noMetricRow.totalLike, null);
  assert.strictEqual(noMetricRow.totalComment, null);
  assert.strictEqual(noMetricRow.totalShare, null);
  assert.strictEqual(noMetricRow.totalFavorite, null);
  assert.strictEqual(noMetricRow.totalFansDelta, null);
  assert.strictEqual(noMetricRow.platformCount, 0);
  assert.deepStrictEqual(noMetricRow.perPlatform, {});
  assert.strictEqual(noMetricRow.firstPublishDate, "2026-11-10");
  assert.strictEqual(noMetricRow.firstPublishDateSource, "record");

  // 即使省略 date 且 worksDaily 为空，也绝不回退 works.json 的 900
  const noDailyRows = buildContentSummaryRows({
    contents: [contents[0]],
    accounts: [accounts[0]],
    worksDaily: {},
  });
  assert.strictEqual(noDailyRows.length, 1);
  assert.strictEqual(noDailyRows[0].totalPlay, null, "date 省略且 worksDaily 缺失时也不得回退 works.json");

  // 同平台双组：platformCount 按不同平台名计为 1；重复 group|platform|workId 只计一次；null 语义正确
  const mgRow = asOf11.find((r) => r.contentKey === "file:d:/stats/multi_group.mp4");
  assert.ok(mgRow);
  assert.strictEqual(mgRow.platformCount, 1, "组A 与 组B 同属「抖音」，platformCount 必须为 1");
  assert.strictEqual(mgRow.totalPlay, 350, "mg1 重复出现只计一次：100 + 250 = 350");
  assert.strictEqual(mgRow.totalLike, 0, "0 + null 合计为 0");
  assert.strictEqual(mgRow.totalComment, null, "null + null 合计为 null");
  assert.strictEqual(mgRow.totalShare, 0, "0 + 0 合计为 0");
  assert.strictEqual(mgRow.totalFansDelta, 3, "-2 + 5 = 3");
  assert.strictEqual(mgRow.firstPublishDate, "2026-11-10", "取已关联作品 publishTime 最小值");
  assert.strictEqual(mgRow.firstPublishDateSource, "work");

  // 省略 date 时取 worksDaily 最新快照日（mg1 取 11-15 的 800 + mg2 的 250 = 1050；c1 取 11-19 的 900）
  const latestRows = buildContentSummaryRows({ contents, accounts, worksDaily: worksDailyFuture });
  assert.strictEqual(latestRows.find((r) => r.contentKey === "file:d:/stats/multi_group.mp4").totalPlay, 1050);
  assert.strictEqual(latestRows.find((r) => r.contentKey === "file:d:/stats/cutoff.mp4").totalPlay, 900);

  // 评审反例 #9：publishTime 1e20 / 8.64e15 / 1999 / 2101 不崩且视为无效（firstPublishDate 为 ""）
  for (const id of ["bad_ts_1", "bad_ts_2", "bad_ts_3", "bad_ts_4"]) {
    const r = asOf11.find((x) => x.contentKey === `unlinked:抖音:${id}`);
    assert.ok(r, `越界时间作品 ${id} 应正常出未关联行不崩溃`);
    assert.strictEqual(r.firstPublishDate, "", `越界时间 ${id} 应视为无效（空日期）`);
  }

  // 特殊 workId（__proto__ / constructor）防原型污染
  const protoDaily = {
    "特殊组|抖音": Object.assign(Object.create(null), {
      ["__proto__"]: { "2026-11-10": { play: 42, like: 3, comment: null, share: null, favorite: null, fansDelta: null } },
      constructor: { "2026-11-10": { play: 10, like: 1, comment: 0, share: 0, favorite: 0, fansDelta: null } },
    }),
  };
  const protoRows = buildContentSummaryRows({
    contents: [],
    accounts: [
      {
        group: "特殊组",
        platform: "抖音",
        works: [
          { workId: "__proto__", title: "原型作品", publishTime: Date.parse("2026-11-10T04:00:00Z") },
          { workId: "constructor", title: "构造作品", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        ],
      },
    ],
    worksDaily: protoDaily,
  });
  assert.strictEqual(protoRows.length, 2);
  assert.strictEqual(protoRows.find((r) => r.contentKey === "unlinked:抖音:__proto__").totalPlay, 42);
  assert.strictEqual(protoRows.find((r) => r.contentKey === "unlinked:抖音:constructor").totalPlay, 10);
  console.log("✓ 截止日不泄漏未来值、无指标保留行、publishTime 越界不崩、null 语义、platformCount 与原型防护正确");
}

/* ---------- 7. buildWorkDailyRows：可选 link 参数（仅 Map） ---------- */
{
  const works = [
    { workId: "W1", title: "联动视频", url: "https://www.douyin.com/video/1", publishTime: Date.parse("2026-11-10T04:00:00Z") },
    { workId: "W2", title: "未关联视频", url: "https://www.douyin.com/video/2", publishTime: Date.parse("2026-11-10T02:00:00Z") },
  ];
  const worksDaily = {
    W1: { "2026-11-10": { play: 100, like: 10, comment: 1, share: 0, favorite: 2, fansDelta: 1 } },
    W2: { "2026-11-10": { play: 50, like: 5, comment: 0, share: 0, favorite: 1, fansDelta: null } },
    W_DEL: { "2026-11-10": { play: 30, like: 1, comment: 0, share: 0, favorite: 0, fansDelta: null } },
  };

  // 不传 link：保持原契约（无 contentKey / matchedBy）
  const plainRows = buildWorkDailyRows({ group: "G1", platform: "抖音", works, worksDaily });
  assert.strictEqual(plainRows.length, 3);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plainRows[0], "contentKey"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plainRows[0], "matchedBy"), false);

  // 传 link Map：输出 contentKey / matchedBy
  const contents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "联动视频",
      filePath: "D:\\v\\v1.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/1",
      date: "2026-11-10",
    },
  ]);
  const link = linkWorks({ contents, accounts: [{ group: "G1", platform: "抖音", works }] });
  const linkedRows = buildWorkDailyRows({ group: "G1", platform: "抖音", works, worksDaily, link });
  assert.strictEqual(linkedRows.find((r) => r.workId === "W1").contentKey, "file:d:/v/v1.mp4");
  assert.strictEqual(linkedRows.find((r) => r.workId === "W1").matchedBy, "link");
  assert.strictEqual(linkedRows.find((r) => r.workId === "W2").contentKey, null);
  assert.strictEqual(linkedRows.find((r) => r.workId === "W2").matchedBy, null);
  assert.strictEqual(linkedRows.find((r) => r.workId === "W_DEL").contentKey, null);

  // 非 Map 的 link（瘦身：只支持 Map）不附加字段
  const nonMapRows = buildWorkDailyRows({
    group: "G1",
    platform: "抖音",
    works,
    worksDaily,
    link: { "G1|抖音|W1": { contentKey: "file:d:/v/v1.mp4", matchedBy: "title" } },
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(nonMapRows[0], "contentKey"), false);
  console.log("✓ buildWorkDailyRows：不传 link 保持原契约，传 Map 附加 contentKey / matchedBy 正确");
}

/* ---------- 8. pushRecords.readPushRecords：目录注入、损坏跳过+warn、默认目录回退与端到端串联 ---------- */
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-content-link-test-"));
  try {
    // 8a. 不存在目录静默空数组
    const { result: missingRes, warnings: missingWarns } = captureWarn(() =>
      readPushRecords({ dir: path.join(tmpRoot, "not-exists") })
    );
    assert.deepStrictEqual(missingRes, []);
    assert.deepStrictEqual(missingWarns, []);

    // 8b. 构造 pushData 目录：正常文件 + 损坏 JSON + 非数组 + EISDIR + 干扰文件
    const pushDir = path.join(tmpRoot, "pushData");
    fs.mkdirSync(pushDir, { recursive: true });
    fs.writeFileSync(
      path.join(pushDir, "2026-11-10.json"),
      JSON.stringify([
        {
          pt: "抖音",
          group: "运营一组",
          title: "端到端测试视频！ #测试",
          selectedFile: "e2e_demo.mp4",
          filePath: "C:\\Videos\\E2E_DEMO.MP4",
          publishStatus: "success",
          videoLink: "https://www.douyin.com/video/555?from=app",
          textType: "local",
        },
        {
          pt: "百家号",
          group: "运营一组",
          title: "端到端图文",
          selectedFile: "e2e_demo.md",
          filePath: "C:\\Videos\\E2E_DEMO.MP4",
          publishStatus: "success",
          textType: "article",
        },
      ]),
      "utf8"
    );
    fs.writeFileSync(path.join(pushDir, "2026-11-11.json"), "{broken json", "utf8");
    fs.writeFileSync(path.join(pushDir, "2026-11-12.json"), '{"not":"array"}', "utf8");
    fs.mkdirSync(path.join(pushDir, "2026-11-13.json"));
    fs.writeFileSync(
      path.join(pushDir, "2026-11-14.json"),
      JSON.stringify([
        {
          pt: "快手",
          phone: "运营一组-快手",
          bt: "端到端测试视频!",
          selectedFile: "e2e_demo.mp4",
          filePath: "c:/videos/e2e_demo.mp4",
          publishStatus: "success",
          videoLink: "",
          textType: "local",
        },
      ]),
      "utf8"
    );
    fs.writeFileSync(path.join(pushDir, "notes.txt"), "ignore", "utf8");
    fs.writeFileSync(path.join(pushDir, "2026-02-31.json"), "[]", "utf8");

    const { result: records, warnings } = captureWarn(() => readPushRecords({ dir: pushDir }));
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[0].date, "2026-11-10");
    assert.strictEqual(records[2].date, "2026-11-14");
    assert.ok(warnings.some((w) => w.includes("2026-11-11.json")));
    assert.ok(warnings.some((w) => w.includes("2026-11-12.json")));
    assert.ok(warnings.some((w) => w.includes("2026-11-13.json")));
    assert.strictEqual(warnings.some((w) => w.includes("notes.txt")), false);

    // 8c. from/to 过滤
    const filtered = readPushRecords({ dir: pushDir, from: "2026-11-14", to: "2026-11-14" });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].pt, "快手");

    // 8d. 端到端串联
    const contents = buildContentIndex(records);
    assert.strictEqual(contents.length, 1);
    assert.strictEqual(contents[0].contentKey, "file:c:/videos/e2e_demo.mp4");

    const e2eAccounts = [
      {
        group: "运营一组",
        platform: "抖音",
        works: [{ workId: "555", title: "改名后的抖音标题", url: "https://www.douyin.com/video/555/", publishTime: Date.parse("2026-11-10T04:00:00Z") }],
      },
      {
        group: "运营一组",
        platform: "快手",
        works: [{ workId: "ks555", title: "端到端测试视频！ #快手热点", url: "", publishTime: Date.parse("2026-11-14T04:00:00Z") }],
      },
    ];
    const e2eDaily = {
      "运营一组|抖音": { 555: { "2026-11-15": { play: 1000, like: 100, comment: 10, share: 5, favorite: 20, fansDelta: 3 } } },
      "运营一组|快手": { ks555: { "2026-11-15": { play: 600, like: 40, comment: 4, share: null, favorite: 8, fansDelta: null } } },
    };

    const e2eLink = linkWorks({ contents, accounts: e2eAccounts });
    assert.deepStrictEqual(e2eLink.get("运营一组|抖音|555"), { contentKey: "file:c:/videos/e2e_demo.mp4", matchedBy: "link" });
    assert.deepStrictEqual(e2eLink.get("运营一组|快手|ks555"), { contentKey: "file:c:/videos/e2e_demo.mp4", matchedBy: "title" });
    assert.strictEqual(makeWorkKey("运营一组", "快手", "ks555"), "运营一组|快手|ks555");

    const summary = buildContentSummaryRows({ contents, accounts: e2eAccounts, link: e2eLink, worksDaily: e2eDaily });
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].platformCount, 2);
    assert.strictEqual(summary[0].totalPlay, 1600);
    assert.strictEqual(summary[0].totalShare, 5);
    assert.strictEqual(summary[0].totalFansDelta, 3);
    assert.strictEqual(summary[0].firstPublishDate, "2026-11-10");
    assert.strictEqual(summary[0].firstPublishDateSource, "work");

    const dailyRows = buildWorkDailyRows({
      group: "运营一组",
      platform: "快手",
      works: e2eAccounts[1].works,
      worksDaily: e2eDaily["运营一组|快手"],
      link: e2eLink,
    });
    assert.strictEqual(dailyRows.length, 1);
    assert.strictEqual(dailyRows[0].contentKey, "file:c:/videos/e2e_demo.mp4");
    assert.strictEqual(dailyRows[0].matchedBy, "title");

    // 8e. 默认目录回退（mock electron.app.getPath("documents")）
    const fakeDocs = path.join(tmpRoot, "FakeDocs");
    const defaultPushDir = path.join(fakeDocs, "MatrixMedia", "data", "pushData");
    fs.mkdirSync(defaultPushDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultPushDir, "2026-11-15.json"),
      JSON.stringify([{ pt: "抖音", group: "G", title: "默认路径测试", selectedFile: "def.mp4", publishStatus: "success" }]),
      "utf8"
    );
    const electronId = require.resolve("electron");
    const prevCache = require.cache[electronId];
    require.cache[electronId] = {
      id: electronId,
      filename: electronId,
      loaded: true,
      exports: { app: { getPath: (name) => (name === "documents" ? fakeDocs : tmpRoot) } },
    };
    try {
      assert.strictEqual(getPushDataDir(), defaultPushDir);
      const defRecords = readPushRecords();
      assert.strictEqual(defRecords.length, 1);
      assert.strictEqual(defRecords[0].date, "2026-11-15");
    } finally {
      if (prevCache) require.cache[electronId] = prevCache;
      else delete require.cache[electronId];
    }

    console.log("✓ pushRecords.readPushRecords：目录注入、损坏跳过+warn、默认目录回退与端到端串联正确");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/* ---------- 9. 精修回归：状态+直链、重发去直链、C#词内#、截止日过滤与预计算 link、跨组去重、坏对象、缺 works.json ---------- */
{
  // 9a. 显式非 success 状态（即使带有效直链）一律排除；仅缺 publishStatus 的历史记录凭有效直链纳入
  const nonSuccessStatuses = [
    "scheduled", "publishing", "failed", "fail", "draft", "drafting",
    "abnormal", "skipped", "expired", "login_required",
  ];
  const statusRecords = nonSuccessStatuses.map((st, i) => ({
    pt: "抖音",
    group: "G1",
    title: `非成功_${st}`,
    filePath: `D:\\status\\${st}.mp4`,
    publishStatus: st,
    videoLink: `https://www.douyin.com/video/800${i}`,
    date: "2026-11-10",
  }));
  // 缺 publishStatus 但 republishCount > 0 → 其 videoLink 不作直链证据，不得纳入
  statusRecords.push({
    pt: "抖音",
    group: "G1",
    title: "无状态重发记录",
    filePath: "D:\\status\\legacy_repub.mp4",
    republishCount: 1,
    videoLink: "https://www.douyin.com/video/8888",
    date: "2026-11-10",
  });
  // 缺 publishStatus 且未重发 + 有效直链 → 历史记录纳入
  statusRecords.push({
    pt: "抖音",
    group: "G1",
    title: "无状态历史直链",
    filePath: "D:\\status\\legacy_ok.mp4",
    videoLink: "https://www.douyin.com/video/8999",
    date: "2026-11-10",
  });
  const statusContents = buildContentIndex(statusRecords);
  assert.strictEqual(statusContents.length, 1, "所有显式非 success（含 scheduled 带直链）与无状态重发记录必须排除");
  assert.strictEqual(statusContents[0].contentKey, "file:d:/status/legacy_ok.mp4");

  // 9b. 重发记录（republishCount > 0 且 publishStatus === "success"）：videoLink 不作直链证据，仅走唯一标题规则
  const repubContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "重发新标题",
      filePath: "D:\\repub\\new_video.mp4",
      publishStatus: "success",
      republishCount: 1,
      videoLink: "https://www.douyin.com/video/old1", // 重发残留旧链
      date: "2026-11-10",
    },
  ]);
  assert.strictEqual(repubContents.length, 1);
  assert.strictEqual(repubContents[0].targets[0].videoLink, "", "重发记录的 videoLink 必须清空，不作为直链证据");
  const repubLink = linkWorks({
    contents: repubContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "old1", title: "旧素材标题", url: "https://www.douyin.com/video/old1" },
          { workId: "new2", title: "重发新标题", url: "https://www.douyin.com/video/new2" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(repubLink.get("G1|抖音|old1"), { contentKey: null, matchedBy: null }, "重发残留旧链不得匹配旧作品");
  assert.deepStrictEqual(
    repubLink.get("G1|抖音|new2"),
    { contentKey: "file:d:/repub/new_video.mp4", matchedBy: "title" },
    "重发记录仅凭唯一标题匹配新作品"
  );
  // 重发记录若标题不唯一 → 全部留空
  const repubAmbiguousLink = linkWorks({
    contents: repubContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "old1", title: "重发新标题", url: "https://www.douyin.com/video/old1" },
          { workId: "new2", title: "重发新标题", url: "https://www.douyin.com/video/new2" },
        ],
      },
    ],
  });
  assert.deepStrictEqual(repubAmbiguousLink.get("G1|抖音|old1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(repubAmbiguousLink.get("G1|抖音|new2"), { contentKey: null, matchedBy: null });

  // 9c. C#入门 / C#进阶 词内 # 保留，绝不混淆关联
  const csharpContents = buildContentIndex([
    {
      pt: "抖音",
      group: "教程组",
      title: "C#进阶",
      filePath: "D:\\code\\part2.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  const csharpAccounts = [
    {
      group: "教程组",
      platform: "抖音",
      works: [
        { workId: "cs1", title: "C#入门", url: "https://www.douyin.com/video/cs1", publishTime: Date.parse("2026-11-10T01:00:00Z") },
      ],
    },
  ];
  const csharpLink = linkWorks({ contents: csharpContents, accounts: csharpAccounts });
  assert.deepStrictEqual(csharpLink.get("教程组|抖音|cs1"), { contentKey: null, matchedBy: null }, "C#入门 不得匹配 C#进阶");
  const csharpRows = buildContentSummaryRows({
    contents: csharpContents,
    accounts: csharpAccounts,
    worksDaily: { "教程组|抖音": { cs1: { "2026-11-10": { play: 100 } } } },
  });
  assert.strictEqual(csharpRows.length, 2);
  assert.strictEqual(csharpRows.find((r) => r.contentKey === "file:d:/code/part2.mp4").totalPlay, null);
  assert.strictEqual(csharpRows.find((r) => r.contentKey === "unlinked:抖音:cs1").totalPlay, 100);

  // 9d. 截止日：排除未来 target、未来 work，并对传入的预计算 link 作同样过滤
  const cutoffContents = buildContentIndex([
    // 11-20 才实发的定时任务，标题与 11-08 旧作品相同
    {
      pt: "抖音",
      group: "G1",
      title: "每周复盘",
      filePath: "D:\\sched\\future_ep.mp4",
      scheduledTask: true,
      publishStatus: "success",
      date: "2026-11-10",
      lastPublishAt: Date.parse("2026-11-20T04:00:00Z"),
    },
    // 多平台内容：快手 11-10 已发、抖音 11-20 才发（同标题撞 11-08 另一旧作品）
    {
      pt: "快手",
      group: "G1",
      title: "跨日多平台",
      filePath: "D:\\sched\\multi_day.mp4",
      publishStatus: "success",
      videoLink: "https://www.kuaishou.com/short-video/ks10",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "旧视频乙",
      filePath: "D:\\sched\\multi_day.mp4",
      publishStatus: "success",
      date: "2026-11-20",
    },
    // 11-10 已发目标（用于验证未来 publishTime 的 work 被排除）
    {
      pt: "小红书",
      group: "G1",
      title: "未来作品测试",
      filePath: "D:\\sched\\past_target.mp4",
      publishStatus: "success",
      videoLink: "https://www.xiaohongshu.com/explore/f99",
      date: "2026-11-10",
    },
  ]);
  const cutoffAccounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "old08", title: "每周复盘", url: "https://www.douyin.com/video/old08", publishTime: Date.parse("2026-11-08T04:00:00Z") },
        { workId: "old08b", title: "旧视频乙", url: "https://www.douyin.com/video/old08b", publishTime: Date.parse("2026-11-08T05:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "快手",
      works: [
        { workId: "ks10", title: "跨日多平台", url: "https://www.kuaishou.com/short-video/ks10", publishTime: Date.parse("2026-11-10T04:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "小红书",
      works: [
        { workId: "f99", title: "未来作品测试", url: "https://www.xiaohongshu.com/explore/f99", publishTime: Date.parse("2026-11-20T04:00:00Z") },
      ],
    },
  ];
  const cutoffDaily = {
    "G1|抖音": {
      old08: { "2026-11-10": { play: 100 } },
      old08b: { "2026-11-10": { play: 200 } },
    },
    "G1|快手": {
      ks10: { "2026-11-10": { play: 300 } },
    },
    "G1|小红书": {
      f99: { "2026-11-10": { play: 999 } },
    },
  };
  // 无截止日预计算 link 会把 old08 / old08b / f99 都关联上
  const precomputedFullLink = linkWorks({ contents: cutoffContents, accounts: cutoffAccounts });
  assert.strictEqual(precomputedFullLink.get("G1|抖音|old08").contentKey, "file:d:/sched/future_ep.mp4");
  assert.strictEqual(precomputedFullLink.get("G1|抖音|old08b").contentKey, "file:d:/sched/multi_day.mp4");
  assert.strictEqual(precomputedFullLink.get("G1|小红书|f99").contentKey, "file:d:/sched/past_target.mp4");

  // 带截止日 linkWorks：排除 11-20 的 target 与 11-20 的 work
  const linkAsOf11 = linkWorks({ contents: cutoffContents, accounts: cutoffAccounts, date: "2026-11-11" });
  assert.deepStrictEqual(linkAsOf11.get("G1|抖音|old08"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(linkAsOf11.get("G1|抖音|old08b"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(linkAsOf11.get("G1|小红书|f99"), { contentKey: null, matchedBy: null });
  assert.strictEqual(linkAsOf11.get("G1|快手|ks10").contentKey, "file:d:/sched/multi_day.mp4");

  // buildContentSummaryRows 无论是否传预计算 link，截至 11-11 行为必须一致
  for (const maybeLink of [undefined, precomputedFullLink]) {
    const rowsAsOf11 = buildContentSummaryRows({
      contents: cutoffContents,
      accounts: cutoffAccounts,
      link: maybeLink,
      worksDaily: cutoffDaily,
      date: "2026-11-11",
    });
    assert.strictEqual(
      rowsAsOf11.find((r) => r.contentKey === "file:d:/sched/future_ep.mp4"),
      undefined,
      "11-20 才发布的内容不得出现在 11-11 汇总中"
    );
    const old08Row = rowsAsOf11.find((r) => r.contentKey === "unlinked:抖音:old08");
    assert.ok(old08Row, "被排除未来关联的旧作品应作为未关联行保留");
    assert.strictEqual(old08Row.totalPlay, 100);

    const multiDayRow = rowsAsOf11.find((r) => r.contentKey === "file:d:/sched/multi_day.mp4");
    assert.ok(multiDayRow);
    assert.strictEqual(multiDayRow.totalPlay, 300, "11-20 抖音 target 的关联必须失效，只计 11-10 快手 300");
    assert.strictEqual(multiDayRow.platformCount, 1);
    const old08bRow = rowsAsOf11.find((r) => r.contentKey === "unlinked:抖音:old08b");
    assert.ok(old08bRow);
    assert.strictEqual(old08bRow.totalPlay, 200);

    const pastTargetRow = rowsAsOf11.find((r) => r.contentKey === "file:d:/sched/past_target.mp4");
    assert.ok(pastTargetRow);
    assert.strictEqual(pastTargetRow.totalPlay, null, "publishTime > date 的未来 work 必须排除，不得计入");
    assert.strictEqual(
      rowsAsOf11.find((r) => r.contentKey === "unlinked:小红书:f99"),
      undefined,
      "publishTime > date 的未来 work 不得生成未关联行"
    );
  }

  // 9e. 跨组同作品（platform|workId 相同）只计一次：取 ≤date 最近快照，归入按分组名排序首个分组
  const crossGroupContents = buildContentIndex([
    {
      pt: "抖音",
      group: "组B",
      title: "跨组共享作品",
      filePath: "D:\\shared\\clip.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/shared1",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "组A",
      title: "跨组共享作品",
      filePath: "D:\\shared\\clip.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/shared1",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "组B",
      title: "组B独有作品",
      filePath: "D:\\shared\\clip.mp4",
      publishStatus: "success",
      videoLink: "https://www.douyin.com/video/onlyB",
      date: "2026-11-10",
    },
  ]);
  // 故意把 组B 放在 组A 前面，验证仍按分组名排序归入 组A
  const crossGroupAccounts = [
    {
      group: "组B",
      platform: "抖音",
      works: [
        { workId: "shared1", title: "跨组共享作品", url: "https://www.douyin.com/video/shared1", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "onlyB", title: "组B独有作品", url: "https://www.douyin.com/video/onlyB", publishTime: Date.parse("2026-11-10T05:00:00Z") },
        { workId: "unlinkedDup", title: "跨组未关联", url: "https://www.douyin.com/video/udup", publishTime: Date.parse("2026-11-10T06:00:00Z") },
      ],
    },
    {
      group: "组A",
      platform: "抖音",
      works: [
        { workId: "shared1", title: "跨组共享作品", url: "https://www.douyin.com/video/shared1", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "unlinkedDup", title: "跨组未关联", url: "https://www.douyin.com/video/udup", publishTime: Date.parse("2026-11-10T06:00:00Z") },
      ],
    },
  ];
  const crossGroupDaily = {
    "组A|抖音": {
      shared1: { "2026-11-10": { play: 100 }, "2026-11-15": { play: 500 } },
      unlinkedDup: { "2026-11-10": { play: 60 } },
    },
    "组B|抖音": {
      shared1: { "2026-11-11": { play: 150 } },
      onlyB: { "2026-11-10": { play: 40 } },
      unlinkedDup: { "2026-11-10": { play: 60 } },
    },
  };
  const cgRows = buildContentSummaryRows({
    contents: crossGroupContents,
    accounts: crossGroupAccounts,
    worksDaily: crossGroupDaily,
    date: "2026-11-11",
  });
  const cgClip = cgRows.find((r) => r.contentKey === "file:d:/shared/clip.mp4");
  assert.ok(cgClip);
  assert.strictEqual(cgClip.platformCount, 1);
  assert.strictEqual(cgClip.totalPlay, 190, "shared1 取 ≤11-11 最近快照 150，加上 onlyB 40 = 190，不重复计数");
  assert.deepStrictEqual(cgClip.perPlatform["抖音|组A"].workIds, ["shared1"]);
  assert.strictEqual(cgClip.perPlatform["抖音|组A"].play, 150);
  assert.deepStrictEqual(cgClip.perPlatform["抖音|组B"].workIds, ["onlyB"], "组B 中不得重复计入 shared1");
  assert.strictEqual(cgClip.perPlatform["抖音|组B"].play, 40);

  // 未关联作品跨组重复时也只生成 1 行，归入 组A
  const udupRows = cgRows.filter((r) => r.contentKey === "unlinked:抖音:unlinkedDup");
  assert.strictEqual(udupRows.length, 1);
  assert.strictEqual(udupRows[0].totalPlay, 60);
  assert.deepStrictEqual(Object.keys(udupRows[0].perPlatform), ["抖音|组A"]);

  // 9f. 坏 title / 文本对象不崩（buildContentIndex / linkWorks / buildContentSummaryRows / readPushRecords）
  const badObj = { toString: null };
  const badContents = buildContentIndex([
    {
      id: badObj,
      pt: "抖音",
      group: badObj,
      phone: badObj,
      title: badObj,
      bt: ["bad"],
      textOtherName: null,
      bookName: true,
      selectedFile: badObj,
      filePath: "D:\\bad\\safe.mp4",
      videoLink: badObj,
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  assert.strictEqual(badContents.length, 1);
  assert.strictEqual(badContents[0].displayTitle, "safe.mp4");
  const badAccounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "bw1", title: badObj, url: badObj, publishTime: badObj },
        { workId: badObj, title: "无效ID" },
      ],
    },
  ];
  const badRows = buildContentSummaryRows({
    contents: badContents,
    accounts: badAccounts,
    worksDaily: { "G1|抖音": { bw1: { "2026-11-10": { play: 12 } } } },
  });
  assert.strictEqual(badRows.find((r) => r.contentKey === "unlinked:抖音:bw1").title, "(无标题)");

  // readPushRecords 读取含坏对象 JSON 文件不崩且文本字段置空
  const badTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-bad-text-test-"));
  try {
    fs.writeFileSync(
      path.join(badTmpDir, "2026-11-10.json"),
      JSON.stringify([
        {
          id: 1001,
          pt: "抖音",
          group: "G1",
          title: { toString: null },
          bt: ["arr"],
          textOtherName: null,
          videoLink: { toString: null },
          publishStatus: "success",
        },
      ]),
      "utf8"
    );
    const badDiskRecs = readPushRecords({ dir: badTmpDir });
    assert.strictEqual(badDiskRecs.length, 1);
    assert.strictEqual(badDiskRecs[0].id, "1001");
    assert.strictEqual(badDiskRecs[0].title, "");
    assert.strictEqual(badDiskRecs[0].bt, "");
    assert.strictEqual(badDiskRecs[0].textOtherName, "");
    assert.strictEqual(badDiskRecs[0].videoLink, "");
    assert.strictEqual(buildContentIndex(badDiskRecs).length, 1);
  } finally {
    fs.rmSync(badTmpDir, { recursive: true, force: true });
  }

  // 9g. works.json 缺失（或为空）时，worksDaily 中有快照的作品 ID 仍作为未关联行保留
  const missingMetaRows = buildContentSummaryRows({
    contents: [],
    accounts: [{ group: "G1", platform: "抖音", works: [] }],
    worksDaily: {
      "G1|抖音": {
        ghost1: { "2026-11-10": { play: 100, like: 5 } },
      },
      "孤儿组|快手": {
        ghost2: { "2026-11-10": { play: 77 } },
      },
    },
    date: "2026-11-10",
  });
  assert.strictEqual(missingMetaRows.length, 2);
  const g1 = missingMetaRows.find((r) => r.contentKey === "unlinked:抖音:ghost1");
  assert.ok(g1);
  assert.strictEqual(g1.title, "(已删除或未匹配)");
  assert.strictEqual(g1.totalPlay, 100);
  assert.strictEqual(g1.totalLike, 5);
  assert.strictEqual(g1.firstPublishDate, "");
  assert.strictEqual(g1.firstPublishDateSource, "work");
  assert.deepStrictEqual(g1.perPlatform["抖音|G1"].workIds, ["ghost1"]);

  const g2 = missingMetaRows.find((r) => r.contentKey === "unlinked:快手:ghost2");
  assert.ok(g2);
  assert.strictEqual(g2.title, "(已删除或未匹配)");
  assert.strictEqual(g2.totalPlay, 77);
  assert.deepStrictEqual(g2.perPlatform["快手|孤儿组"].workIds, ["ghost2"]);

  // 截止日早于快照日时不泄漏
  assert.strictEqual(
    buildContentSummaryRows({
      contents: [],
      accounts: [{ group: "G1", platform: "抖音", works: [] }],
      worksDaily: { "G1|抖音": { ghost1: { "2026-11-10": { play: 100 } } } },
      date: "2026-11-09",
    }).length,
    0
  );

  // 9h. buildTitleIndex 纯函数单测
  const titleIdx = buildTitleIndex([
    { workId: "u1", title: "唯一作品", url: "https://www.douyin.com/video/u1" },
    { workId: "d1", title: "同名作品", url: "https://www.douyin.com/video/d1" },
    { workId: "d2", title: "同名作品 #热门", url: "https://www.douyin.com/video/d2" },
    { workId: "c1", title: "C#入门", url: "https://www.douyin.com/video/c1" },
    { workId: "c2", title: "C#进阶", url: "https://www.douyin.com/video/c2" },
    { workId: "bad", title: { toString: null }, url: "" },
  ]);
  assert.strictEqual(titleIdx.get("唯一作品").ambiguous, false);
  assert.strictEqual(titleIdx.get("唯一作品").work.workId, "u1");
  assert.deepStrictEqual(titleIdx.get("同名作品"), { work: null, ambiguous: true });
  assert.strictEqual(titleIdx.get("C#入门").work.workId, "c1");
  assert.strictEqual(titleIdx.get("C#进阶").work.workId, "c2");
  console.log("✓ 精修回归：状态/重发/C#词内#/截止日预计算link/跨组去重/坏对象/缺失works.json/buildTitleIndex 正确");
}

/* ---------- 10. stats:match-works IPC：同名两作品返回 { found: false, ambiguous: true } ---------- */
async function testMatchWorksIpcAmbiguity() {
  const electronId = require.resolve("electron");
  const collectorId = require.resolve("../src/main/services/dataStats/collector.js");
  const storeId = require.resolve("../src/main/services/dataStats/store.js");
  const indexId = require.resolve("../src/main/services/dataStats/index.js");

  const prevCache = {
    electron: require.cache[electronId],
    collector: require.cache[collectorId],
    store: require.cache[storeId],
    index: require.cache[indexId],
  };
  const origSetTimeout = global.setTimeout;
  const handlers = new Map();

  require.cache[electronId] = {
    id: electronId,
    filename: electronId,
    loaded: true,
    exports: {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    },
  };
  require.cache[collectorId] = {
    id: collectorId,
    filename: collectorId,
    loaded: true,
    exports: {
      collectAccount: async () => ({
        overview: {},
        fansHistory: [],
        works: [
          { workId: "w_dup_1", title: "每日打卡", url: "https://www.douyin.com/video/dup1" },
          { workId: "w_dup_2", title: " 每日打卡\u200B", url: "https://www.douyin.com/video/dup2" },
          { workId: "w_uniq", title: "唯一教程", url: "https://www.douyin.com/video/uniq" },
          { workId: "w_cs1", title: "C#入门", url: "https://www.douyin.com/video/cs1" },
          { workId: "w_cs2", title: "C#进阶", url: "https://www.douyin.com/video/cs2" },
        ],
      }),
    },
  };
  require.cache[storeId] = {
    id: storeId,
    filename: storeId,
    loaded: true,
    exports: {
      mergeDaily: () => {},
      mergeWorks: () => {},
      writeMeta: () => {},
      readAccount: () => ({}),
      readOverview: () => ({}),
      readCollectLogs: () => [],
      appendCollectLog: () => {},
    },
  };
  delete require.cache[indexId];
  global.setTimeout = (fn) => {
    fn();
    return 0;
  };

  try {
    const { registerDataStatsIpc } = require("../src/main/services/dataStats/index.js");
    registerDataStatsIpc();
    const matchHandler = handlers.get("stats:match-works");
    assert.strictEqual(typeof matchHandler, "function");

    const res = await matchHandler(null, {
      tasks: [
        { key: "t_dup", group: "G1", platform: "抖音", partition: "persist:G1抖音", title: "每日打卡" },
        { key: "t_uniq", group: "G1", platform: "抖音", partition: "persist:G1抖音", title: "唯一教程" },
        { key: "t_cs", group: "G1", platform: "抖音", partition: "persist:G1抖音", title: "C#进阶" },
        { key: "t_miss", group: "G1", platform: "抖音", partition: "persist:G1抖音", title: "不存在的标题" },
      ],
    });
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(
      res.matches.t_dup,
      { found: false, ambiguous: true },
      "同名两作品时「获取状态」必须返回 { found: false, ambiguous: true }，不得写错链"
    );
    assert.deepStrictEqual(res.matches.t_uniq, {
      found: true,
      url: "https://www.douyin.com/video/uniq",
      workId: "w_uniq",
    });
    assert.deepStrictEqual(res.matches.t_cs, {
      found: true,
      url: "https://www.douyin.com/video/cs2",
      workId: "w_cs2",
    });
    assert.deepStrictEqual(res.matches.t_miss, { found: false });
    console.log("✓ stats:match-works IPC：同名两作品返回 ambiguous、唯一作品正常命中");
  } finally {
    global.setTimeout = origSetTimeout;
    for (const [key, id] of [
      ["electron", electronId],
      ["collector", collectorId],
      ["store", storeId],
      ["index", indexId],
    ]) {
      if (prevCache[key]) require.cache[id] = prevCache[key];
      else delete require.cache[id];
    }
  }
}


/* ---------- Claude 精修回归（S2 第 3 轮评审） ---------- */
{
  const CL = require("../src/main/services/dataStats/contentLink.js");
  // 尾部 # 仅限小红书 [话题] 格式
  assert.notStrictEqual(CL.normalizeTitle("版本更新 #2025#"), CL.normalizeTitle("版本更新 #2026#"));
  assert.strictEqual(CL.normalizeTitle("红烧肉 #美食[话题]#"), "红烧肉");
  // 「获取状态」精确键：不剥话题
  assert.notStrictEqual(CL.normalizeStatusTitle("每日打卡"), CL.normalizeStatusTitle("每日打卡 #日常"));
  // 状态字段存在但非 success（空串/数组清洗后为空串）→ 排除，即使有直链
  const base = { pt: "抖音", group: "G", title: "t", filePath: "D:/v/a.mp4", date: "2026-11-10",
    videoLink: "https://www.douyin.com/video/1" };
  assert.strictEqual(CL.buildContentIndex([{ ...base, publishStatus: "" }]).length, 0);
  assert.strictEqual(CL.buildContentIndex([{ ...base }]).length, 1, "缺状态字段的历史记录可凭直链纳入");
  // 成功重发：recordDate 取更晚的 lastPublishAt
  const idx = CL.buildContentIndex([{ ...base, publishStatus: "success", republishCount: 1,
    lastPublishAt: Date.parse("2026-11-20T04:00:00Z") }]);
  assert.strictEqual(idx[0].targets[0].recordDate, "2026-11-20");
  // 跨组冲突：同一作品在两组分别关联到不同内容 → 作未关联行，且只计一次
  const contents = CL.buildContentIndex([
    { pt: "抖音", group: "A", title: "甲", filePath: "D:/v/jia.mp4", date: "2026-11-01", publishStatus: "success" },
    { pt: "抖音", group: "B", title: "乙", filePath: "D:/v/yi.mp4", date: "2026-11-01", publishStatus: "success",
      videoLink: "https://www.douyin.com/video/77" },
  ]);
  const w = (title) => ({ workId: "77", title, url: "https://www.douyin.com/video/77", publishTime: Date.parse("2026-11-01T04:00:00Z") });
  const rows = CL.buildContentSummaryRows({
    contents,
    accounts: [{ group: "A", platform: "抖音", works: [w("甲")] }, { group: "B", platform: "抖音", works: [w("乙")] }],
    worksDaily: { "A|抖音": { "77": { "2026-11-02": { play: 150 } } }, "B|抖音": { "77": { "2026-11-02": { play: 150 } } } },
    date: "2026-11-02",
  });
  const withPlay = rows.filter((r) => r.totalPlay != null);
  assert.strictEqual(withPlay.length, 1, "同一作品只计一次");
  assert.ok(String(withPlay[0].contentKey).startsWith("unlinked:"), "证据冲突应作未关联行");
  console.log("✓ Claude 精修回归：尾部#、精确状态键、状态字段存在、重发日期、跨组冲突");
}

/* ---------- 11. S6 模糊匹配（③ 作品↔target + ④ 无发布记录跨平台聚类 + 确定性） ---------- */
{
  // 11a. 阈值常量导出与核心标题/相似度函数
  assert.strictEqual(FUZZY_SIM_THRESHOLD, 0.6);
  assert.strictEqual(FUZZY_MISSING_TIME_PENALTY, 0.1);
  assert.strictEqual(FUZZY_MARGIN_MIN, 0.1);
  assert.strictEqual(FUZZY_MAX_DAY_DIFF, 2);
  assert.strictEqual(FUZZY_SUBSTRING_MIN_LEN, 6);
  assert.strictEqual(FUZZY_SUBSTRING_SCORE, 0.95);
  assert.deepStrictEqual(FUZZY_THRESHOLDS, {
    simThreshold: 0.6,
    missingTimePenalty: 0.1,
    marginMin: 0.1,
    maxDayDiff: 2,
    substringMinLen: 6,
    substringScore: 0.95,
  });

  assert.strictEqual(
    extractCoreTitle("今天教大家做 #美食教程 红烧肉！🔥超下饭 #家常菜"),
    "今天教大家做红烧肉超下饭"
  );
  assert.strictEqual(
    extractCoreTitle("今天教大家做#美食[话题]#红烧肉（超下饭）1️⃣"),
    "今天教大家做红烧肉超下饭"
  );
  assert.strictEqual(
    computeTitleSimilarity("手把手教你做正宗红烧肉软烂入味超下饭", "手把手教你做正宗红烧肉"),
    0.95,
    "长度≥6的前缀/子串截断应得 0.95"
  );
  assert.strictEqual(
    computeTitleSimilarity("今天教大家做 #美食 红烧肉超下饭", "今天教大家做红烧肉超下饭"),
    1,
    "去掉中间话题后完全一致应得 1"
  );
  assert.ok(
    computeTitleSimilarity("红烧肉做法", "红烧肉做法超详细完整教程") < 0.95,
    "短于 6 字的子串不走 0.95 截断规则，走二元组 Dice"
  );

  // 11b. ③ 截断标题合并 + 话题插中间合并 + buildWorkDailyRows 透传 matchScore
  const fuzzyContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "手把手教你做正宗秘制红烧肉软烂入味超级下饭完整版",
      filePath: "D:\\cook\\hsr_long.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
    {
      pt: "快手",
      group: "G1",
      title: "零基础三步学会煎牛排外焦里嫩秘诀",
      filePath: "D:\\cook\\steak.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  const fuzzyAccounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        {
          workId: "trunc1",
          title: "手把手教你做正宗秘制红烧肉",
          url: "https://www.douyin.com/video/trunc1",
          publishTime: Date.parse("2026-11-11T04:00:00Z"), // 差 1 天 ≤ 2
        },
      ],
    },
    {
      group: "G1",
      platform: "快手",
      works: [
        {
          workId: "midtopic1",
          title: "零基础 #西餐教学 三步学会🔥煎牛排！#美食 外焦里嫩秘诀",
          url: "https://www.kuaishou.com/short-video/mid1",
          publishTime: Date.parse("2026-11-12T04:00:00Z"), // 差 2 天 ≤ 2
        },
      ],
    },
  ];
  const fuzzyLink = linkWorks({ contents: fuzzyContents, accounts: fuzzyAccounts });
  assert.deepStrictEqual(fuzzyLink.get("G1|抖音|trunc1"), {
    contentKey: "file:d:/cook/hsr_long.mp4",
    matchedBy: "fuzzy",
    score: 0.95,
  });
  assert.deepStrictEqual(fuzzyLink.get("G1|快手|midtopic1"), {
    contentKey: "file:d:/cook/steak.mp4",
    matchedBy: "fuzzy",
    score: 1,
  });

  const dailyWithScore = buildWorkDailyRows({
    group: "G1",
    platform: "抖音",
    works: fuzzyAccounts[0].works,
    worksDaily: { trunc1: { "2026-11-12": { play: 500, like: 30 } } },
    link: fuzzyLink,
  });
  assert.strictEqual(dailyWithScore[0].matchedBy, "fuzzy");
  assert.strictEqual(dailyWithScore[0].matchScore, 0.95);

  // 11c. 时间差 3 天不合 + 缺时间门槛 +0.1
  const timeContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "秋冬季节护肤保湿全攻略完整版教程",
      filePath: "D:\\beauty\\skincare.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
    {
      pt: "快手",
      group: "G1",
      title: "十个职场高效沟通的核心方法总结",
      filePath: "D:\\work\\comm.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  const timeDiff3Link = linkWorks({
    contents: timeContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          {
            workId: "late3",
            title: "秋冬季节护肤保湿全攻略",
            url: "",
            publishTime: Date.parse("2026-11-13T04:00:00Z"), // 差 3 天 > 2
          },
        ],
      },
    ],
  });
  assert.deepStrictEqual(
    timeDiff3Link.get("G1|抖音|late3"),
    { contentKey: null, matchedBy: null },
    "发布日期相差 3 天（>2 天）不得模糊合并"
  );

  // 缺时间门槛 +0.1：构造 Dice 约 0.64（≥0.6 但 <0.7），有时间时合并，缺时间时不合
  const simCheck = computeTitleSimilarity("人工智能大模型应用实践课程指南", "人工智能大模型应用实操方法汇总");
  assert.ok(simCheck >= 0.6 && simCheck < 0.7, `测试样例相似度应在 [0.6, 0.7) 内，实际=${simCheck}`);
  const missingTimeContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "人工智能大模型应用实践课程指南",
      filePath: "D:\\ai\\llm.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  const withTimeRes = linkWorks({
    contents: missingTimeContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          {
            workId: "has_t",
            title: "人工智能大模型应用实操方法汇总",
            publishTime: Date.parse("2026-11-10T04:00:00Z"),
          },
        ],
      },
    ],
  });
  assert.strictEqual(withTimeRes.get("G1|抖音|has_t").matchedBy, "fuzzy", "有时间且 sim>=0.6 应合并");

  const noTimeRes = linkWorks({
    contents: missingTimeContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          {
            workId: "no_t",
            title: "人工智能大模型应用实操方法汇总",
            // 缺 publishTime -> 门槛提升为 0.7
          },
        ],
      },
    ],
  });
  assert.deepStrictEqual(
    noTimeRes.get("G1|抖音|no_t"),
    { contentKey: null, matchedBy: null },
    "缺时间时 sim 门槛 +0.1（需 ≥0.7），0.6x 不得合并"
  );

  // 11d. 两个系列视频（「第1集」「第2集」）不互相误合（互为最佳 + 差值规则）
  const seriesContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "Python零基础入门第1集",
      filePath: "D:\\py\\ep1.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "Python零基础入门第2集",
      filePath: "D:\\py\\ep2.mp4",
      publishStatus: "success",
      date: "2026-11-10",
    },
  ]);
  // 场景1：第1集/第2集各自截断或增补 → 精确一一对应，互不交叉
  const seriesPairLink = linkWorks({
    contents: seriesContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "ep1_w", title: "Python零基础入门第1集完整精讲", publishTime: Date.parse("2026-11-10T04:00:00Z") },
          { workId: "ep2_w", title: "Python零基础入门第2集完整精讲", publishTime: Date.parse("2026-11-10T05:00:00Z") },
        ],
      },
    ],
  });
  assert.strictEqual(seriesPairLink.get("G1|抖音|ep1_w").contentKey, "file:d:/py/ep1.mp4");
  assert.strictEqual(seriesPairLink.get("G1|抖音|ep1_w").matchedBy, "fuzzy");
  assert.strictEqual(seriesPairLink.get("G1|抖音|ep2_w").contentKey, "file:d:/py/ep2.mp4");
  assert.strictEqual(seriesPairLink.get("G1|抖音|ep2_w").matchedBy, "fuzzy");

  // 场景2：已有第1集/第2集 target，来了第3集作品 → 与第1/2集同分（差值 0 < 0.1），绝不误合
  const seriesEp3Link = linkWorks({
    contents: seriesContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "ep3_w", title: "Python零基础入门第3集", publishTime: Date.parse("2026-11-10T06:00:00Z") },
        ],
      },
    ],
  });
  assert.deepStrictEqual(
    seriesEp3Link.get("G1|抖音|ep3_w"),
    { contentKey: null, matchedBy: null },
    "系列视频第3集对第1/2集同分（差值<0.1），不得误合"
  );

  // 场景3：只有第2集 target，但有第1集+第2集两条作品 → 仅第2集互为最佳匹配，第1集不误合进第2集
  const onlyEp2Link = linkWorks({
    contents: [seriesContents[1]],
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "ep1_only", title: "Python零基础入门第1集详讲", publishTime: Date.parse("2026-11-10T04:00:00Z") },
          { workId: "ep2_only", title: "Python零基础入门第2集详讲", publishTime: Date.parse("2026-11-10T05:00:00Z") },
        ],
      },
    ],
  });
  assert.deepStrictEqual(onlyEp2Link.get("G1|抖音|ep1_only"), { contentKey: null, matchedBy: null });
  assert.strictEqual(onlyEp2Link.get("G1|抖音|ep2_only").contentKey, "file:d:/py/ep2.mp4");

  // 11e. 次佳差 < 0.1 不合（非并列但分差 < 0.1）
  const candWorkTitle = "深度解析人工智能办公效率提升全套实战方法";
  const candT1 = "深度解析人工智能办公效率提升实战指南";
  const candT2 = "深度解析人工智能办公效率提升实用教程";
  const s1 = computeTitleSimilarity(candWorkTitle, candT1);
  const s2 = computeTitleSimilarity(candWorkTitle, candT2);
  assert.ok(
    s1 >= 0.6 && s2 >= 0.6 && s1 > s2 && s1 - s2 < 0.1,
    `构造次佳差 <0.1 失败: s1=${s1}, s2=${s2}`
  );
  const closeMarginLink = linkWorks({
    contents: buildContentIndex([
      { pt: "抖音", group: "G1", title: candT1, filePath: "D:\\m\\c1.mp4", publishStatus: "success", date: "2026-11-10" },
      { pt: "抖音", group: "G1", title: candT2, filePath: "D:\\m\\c2.mp4", publishStatus: "success", date: "2026-11-10" },
    ]),
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [{ workId: "close1", title: candWorkTitle, publishTime: Date.parse("2026-11-10T04:00:00Z") }],
      },
    ],
  });
  assert.deepStrictEqual(
    closeMarginLink.get("G1|抖音|close1"),
    { contentKey: null, matchedBy: null },
    "最佳与次佳分差 < 0.1 时不得合并"
  );

  // 11f. ④ 无发布记录跨平台聚类：auto:<hash> 稳定可重现、标题取最早发布、素材为空、3平台成簇
  const clusterAccounts = [
    {
      group: "运营组",
      platform: "快手",
      works: [
        {
          workId: "ks_c1",
          title: "秋季露营装备清单推荐 #户外露营 完整避坑",
          url: "https://www.kuaishou.com/short-video/c1",
          publishTime: Date.parse("2026-11-11T04:00:00Z"), // 晚于抖音
        },
      ],
    },
    {
      group: "运营组",
      platform: "抖音",
      works: [
        {
          workId: "dy_c1",
          title: "秋季露营装备清单推荐完整避坑指南（最早发布原标题）",
          url: "https://www.douyin.com/video/c1",
          publishTime: Date.parse("2026-11-10T02:00:00Z"), // 最早发布
        },
      ],
    },
    {
      group: "运营组",
      platform: "小红书",
      works: [
        {
          workId: "xhs_c1",
          title: "秋季露营装备清单推荐完整避坑🔥",
          url: "https://www.xiaohongshu.com/explore/c1",
          publishTime: Date.parse("2026-11-12T03:00:00Z"), // 距抖音 2 天 ≤ 2
        },
      ],
    },
  ];
  const clusterLink1 = linkWorks({ contents: [], accounts: clusterAccounts });
  const clusterLink2 = linkWorks({ contents: [], accounts: [...clusterAccounts].reverse() });
  const ckDy = clusterLink1.get("运营组|抖音|dy_c1");
  const ckKs = clusterLink1.get("运营组|快手|ks_c1");
  const ckXhs = clusterLink1.get("运营组|小红书|xhs_c1");
  assert.ok(ckDy && ckDy.contentKey && ckDy.contentKey.startsWith("auto:"), "无发布记录跨平台应生成 auto: key");
  assert.strictEqual(ckKs.contentKey, ckDy.contentKey);
  assert.strictEqual(ckXhs.contentKey, ckDy.contentKey);
  assert.strictEqual(ckDy.matchedBy, "fuzzy");
  assert.strictEqual(typeof ckDy.score, "number");
  assert.strictEqual(
    clusterLink2.get("运营组|抖音|dy_c1").contentKey,
    ckDy.contentKey,
    "auto: key 必须稳定可重现（不依赖输入顺序）"
  );

  const clusterSummary = buildContentSummaryRows({
    contents: [],
    accounts: clusterAccounts,
    worksDaily: {
      "运营组|抖音": { dy_c1: { "2026-11-12": { play: 1000, like: 50 } } },
      "运营组|快手": { ks_c1: { "2026-11-12": { play: 600, like: 20 } } },
      "运营组|小红书": { xhs_c1: { "2026-11-12": { play: 400, like: 30 } } },
    },
  });
  assert.strictEqual(clusterSummary.length, 1);
  assert.strictEqual(clusterSummary[0].contentKey, ckDy.contentKey);
  assert.strictEqual(clusterSummary[0].title, "秋季露营装备清单推荐完整避坑指南（最早发布原标题）");
  assert.strictEqual(clusterSummary[0].file, "");
  assert.strictEqual(clusterSummary[0].platformCount, 3);
  assert.strictEqual(clusterSummary[0].totalPlay, 2000);
  assert.strictEqual(clusterSummary[0].matchMethod, "fuzzy");
  assert.strictEqual(clusterSummary[0].hasFuzzy, true);

  // 11g. 同平台两条作品绝不进同一簇（含单平台两条 & 跨平台传递冲突守卫）
  const samePlatOnlyLink = linkWorks({
    contents: [],
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          { workId: "sp1", title: "居家健身十分钟燃脂操完整版", publishTime: Date.parse("2026-11-10T04:00:00Z") },
          { workId: "sp2", title: "居家健身十分钟燃脂操", publishTime: Date.parse("2026-11-10T05:00:00Z") },
        ],
      },
    ],
  });
  assert.deepStrictEqual(samePlatOnlyLink.get("G1|抖音|sp1"), { contentKey: null, matchedBy: null });
  assert.deepStrictEqual(samePlatOnlyLink.get("G1|抖音|sp2"), { contentKey: null, matchedBy: null });

  // 跨平台传递冲突：A1(抖) — B1(快) — C1(小) — A2(抖)，检查任何簇内同平台最多 1 条
  const transitiveAccounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "dy_a1", title: "甲乙丙丁戊己庚辛壬癸子丑", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "dy_a2", title: "寅卯辰巳午未申酉戌亥乾坤", publishTime: Date.parse("2026-11-10T04:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "快手",
      works: [
        { workId: "ks_b1", title: "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳", publishTime: Date.parse("2026-11-10T04:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "小红书",
      works: [
        { workId: "xhs_c1", title: "壬癸子丑寅卯辰巳午未申酉戌亥乾坤", publishTime: Date.parse("2026-11-10T04:00:00Z") },
      ],
    },
  ];
  const transLink = linkWorks({ contents: [], accounts: transitiveAccounts });
  const transByCk = new Map();
  for (const [wk, v] of transLink.entries()) {
    if (!v.contentKey) continue;
    const pt = wk.split("|")[1];
    const pts = transByCk.get(v.contentKey) || [];
    assert.strictEqual(pts.includes(pt), false, `同一簇 ${v.contentKey} 不得包含同平台 ${pt} 多条作品`);
    pts.push(pt);
    transByCk.set(v.contentKey, pts);
  }

  // 11h. 确定性测试：多轮打乱 contents / accounts / works 输入顺序，结果必须 100% 一致
  const detContentsBase = buildContentIndex([
    { pt: "抖音", group: "G1", title: "高效学习英语听力的五个核心技巧完整版", filePath: "D:\\det\\e1.mp4", publishStatus: "success", date: "2026-11-10" },
    { pt: "抖音", group: "G1", title: "零基础剪辑调色实战入门指南完整版", filePath: "D:\\det\\e2.mp4", publishStatus: "success", date: "2026-11-10" },
  ]);
  const detAccountsBase = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        { workId: "d1", title: "高效学习英语听力的五个核心技巧", publishTime: Date.parse("2026-11-10T04:00:00Z") },
        { workId: "d2", title: "零基础剪辑调色实战入门指南", publishTime: Date.parse("2026-11-10T05:00:00Z") },
        { workId: "d3", title: "家庭咖啡手冲水温粉水比实测分享", publishTime: Date.parse("2026-11-10T06:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "快手",
      works: [
        { workId: "k1", title: "家庭咖啡手冲 #咖啡 水温粉水比实测", publishTime: Date.parse("2026-11-11T04:00:00Z") },
        { workId: "k2", title: "无匹配快手独有视频", publishTime: Date.parse("2026-11-11T05:00:00Z") },
      ],
    },
    {
      group: "G1",
      platform: "小红书",
      works: [
        { workId: "x1", title: "家庭咖啡手冲水温粉水比实测分享！", publishTime: Date.parse("2026-11-11T08:00:00Z") },
      ],
    },
  ];
  const detDaily = {
    "G1|抖音": {
      d1: { "2026-11-12": { play: 100 } },
      d2: { "2026-11-12": { play: 200 } },
      d3: { "2026-11-12": { play: 300 } },
    },
    "G1|快手": {
      k1: { "2026-11-12": { play: 400 } },
      k2: { "2026-11-12": { play: 50 } },
    },
    "G1|小红书": {
      x1: { "2026-11-12": { play: 500 } },
    },
  };
  const baselineEntries = [...linkWorks({ contents: detContentsBase, accounts: detAccountsBase }).entries()].sort(
    (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  );
  const baselineSummary = buildContentSummaryRows({
    contents: detContentsBase,
    accounts: detAccountsBase,
    worksDaily: detDaily,
  });

  // 倒序 + 轮换打乱多次验证
  for (let round = 0; round < 5; round++) {
    const shuffledContents = [...detContentsBase].reverse();
    const shuffledAccounts = detAccountsBase
      .map((a, idx) => ({
        ...a,
        works: a.works.slice((idx + round) % a.works.length).concat(a.works.slice(0, (idx + round) % a.works.length)).reverse(),
      }))
      .slice(round % detAccountsBase.length)
      .concat(detAccountsBase.slice(0, round % detAccountsBase.length).map((a) => ({ ...a, works: [...a.works].reverse() })));
    const curEntries = [...linkWorks({ contents: shuffledContents, accounts: shuffledAccounts }).entries()].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    );
    const curSummary = buildContentSummaryRows({
      contents: shuffledContents,
      accounts: shuffledAccounts,
      worksDaily: detDaily,
    });
    assert.deepStrictEqual(curEntries, baselineEntries, `第 ${round + 1} 轮打乱顺序 linkWorks 必须确定一致`);
    assert.deepStrictEqual(curSummary, baselineSummary, `第 ${round + 1} 轮打乱顺序 buildContentSummaryRows 必须确定一致`);
  }

  console.log("✓ S6 模糊匹配：截断/中间话题/时间窗/缺时间门槛/系列第1-2集/次佳差/跨平台聚类/同平台隔离/确定性全通过");
}

testMatchWorksIpcAmbiguity()
  .then(() => {
    console.log("\n全部通过：跨平台作品关联与内容级汇总行");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
