/**
 * 跨平台作品关联（contentLink.js）、pushData 读取（pushRecords.js）与
 * buildWorkDailyRows 可选 link 参数单元测试（不依赖 Electron 运行环境）：
 *
 * 1. 纯函数模块独立加载（contentLink.js / statsTable.js 不依赖 electron / fs）
 * 2. normalizeTitle 与 normalizeUrl 边界用例
 * 3. buildContentIndex：同文件多平台归一（含大小写/扩展名/Win&POSIX路径）、无文件名按标题、
 *    图文记录排除、历史 phone 分组回退、重发合并去重
 * 4. linkWorks：链接优先于标题、标题带话题/全角/零宽差异匹配、全局唯一标题兜底（含歧义拦截与分组改名）、
 *    同标题两条视频不互占（按 publishTime 最接近 firstPublishDate 先到先得，且不跨平台抢占）
 * 5. buildContentSummaryRows：跨平台汇总行、未关联作品各自成行、null 合计语义（全 null 为 null，0+null 为 0）、
 *    截至 date 切片（默认最新）、多种 worksDaily 传参形态、特殊 workId 防原型污染
 * 6. buildWorkDailyRows：不传 link 保持原字段契约；传 link 增加 contentKey / matchedBy
 * 7. pushRecords.readPushRecords：注入目录读取、损坏/非数组/EISDIR 跳过+warn、不存在目录静默空数组、
 *    electron documents 路径回退与端到端串联
 *
 * 运行：yarn test:content-link
 */

"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// 先加载纯函数模块与 pushRecords（在 mock electron 之前），验证其不强依赖 electron
const {
  normalizeTitle,
  normalizeUrl,
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
    const result = fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
  }
}

/* ---------- 1. normalizeTitle & normalizeUrl ---------- */
{
  assert.strictEqual(normalizeTitle(null), "");
  assert.strictEqual(normalizeTitle(undefined), "");
  assert.strictEqual(normalizeTitle("   "), "");

  // 零宽字符、全角空格、连续空白、全角/中文标点归一
  assert.strictEqual(
    normalizeTitle("  \u200B今天\uFEFF学做　　红烧肉（超好吃）！\t\n "),
    "今天学做 红烧肉(超好吃)!"
  );
  assert.strictEqual(
    normalizeTitle("【干货】AI实战：效率提升，看这篇就够了。"),
    "[干货]AI实战:效率提升,看这篇就够了."
  );
  assert.strictEqual(
    normalizeTitle("《指南》“引文”——开箱…"),
    '<指南>"引文"--开箱...'
  );

  // 去除末尾话题标签（半角/全角 #、无空格紧贴、#tag#、小红书 [话题]#）
  assert.strictEqual(normalizeTitle("红烧肉教程 #美食 #家常菜"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("红烧肉教程#美食#家常菜"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("红烧肉教程 ＃美食 ＃家常菜"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("红烧肉教程 #美食# #家常菜#"), "红烧肉教程");
  assert.strictEqual(normalizeTitle("红烧肉教程 #美食[话题]# #家常菜[话题]#"), "红烧肉教程");
  assert.strictEqual(
    normalizeTitle("红烧肉教程！ #美食 #家常菜  "),
    normalizeTitle("红烧肉教程!")
  );

  // 保留非末尾标签与 C#
  assert.strictEqual(normalizeTitle("#开箱 新品评测 #数码"), "#开箱 新品评测");
  assert.strictEqual(normalizeTitle("零基础学 C# #编程"), "零基础学 C#");
  assert.strictEqual(normalizeTitle("零基础学 C#"), "零基础学 C#");
  assert.strictEqual(normalizeTitle("#纯标签1 #纯标签2"), "");

  // normalizeUrl：去 query、hash、尾斜杠；保留路径大小写（如 B站 BV 号）
  assert.strictEqual(
    normalizeUrl("https://www.douyin.com/video/7123456/?modeFrom=userPost#top"),
    "https://www.douyin.com/video/7123456"
  );
  assert.strictEqual(
    normalizeUrl("HTTPS://WWW.BILIBILI.COM/video/BV1Ab2Cd3Ef/?spm_id_from=333"),
    "https://www.bilibili.com/video/BV1Ab2Cd3Ef"
  );
  assert.strictEqual(
    normalizeUrl("https://www.toutiao.com/a712345///"),
    "https://www.toutiao.com/a712345"
  );
  assert.strictEqual(normalizeUrl("  "), "");
  assert.strictEqual(normalizeUrl(null), "");
  console.log("✓ normalizeTitle 与 normalizeUrl 边界用例正确");
}

/* ---------- 2. buildContentIndex：同文件多平台归一 / 无文件名按标题 / 图文排除 ---------- */
{
  const pushRecords = [
    // 同文件不同大小写/扩展名/路径分隔符 + 跨日期 + 历史 phone 分组与显式 group
    {
      pt: "快手",
      phone: "运营一组-快手备注",
      bt: "春季穿搭分享！ #穿搭",
      selectedFile: "D:\\Videos\\Look_01.MOV",
      videoLink: "",
      date: "2026-11-11",
      textType: "local",
    },
    {
      pt: "抖音",
      group: "运营一组",
      phone: "运营一组-主号",
      title: "春季穿搭分享！ #穿搭 #日常",
      selectedFile: "look_01.mp4",
      videoLink: "https://www.douyin.com/video/9001?from=share",
      date: "2026-11-10",
      textType: "local",
    },
    {
      pt: "哔哩哔哩",
      group: "品牌-A",
      phone: "品牌-A-B站",
      title: "春季穿搭完整版",
      selectedFile: "/home/user/videos/LOOK_01.mp4",
      videoLink: "https://www.bilibili.com/video/BV1Aa2Bb3Cc/",
      date: "2026-11-12",
      textType: "local",
    },
    // 同账号同内容重发后补齐 videoLink → 应合并为同一 target 而非重复占位
    {
      pt: "快手",
      group: "运营一组",
      title: "春季穿搭分享! #日常",
      selectedFile: "look_01.mp4",
      videoLink: "https://www.kuaishou.com/short-video/ks01",
      date: "2026-11-12",
      textType: "local",
    },
    // 空白 selectedFile + 远程 URL filePath（含 query 中的小数点）→ 仍能正确归一到 look_01
    {
      pt: "头条",
      group: "运营一组",
      title: "春季穿搭分享",
      selectedFile: "   ",
      filePath: "https://cdn.example.com/media/LOOK_01.mp4?v=1.2&token=abc",
      videoLink: "",
      date: "2026-11-12",
      textType: "local",
    },
    // 图文记录（即使同名文件）必须排除
    {
      pt: "百家号",
      group: "运营一组",
      title: "图文测试",
      selectedFile: "look_01.md",
      videoLink: "https://baijiahao.baidu.com/s?id=1",
      date: "2026-11-09",
      textType: "article",
    },
    {
      pt: "掘金",
      group: "运营一组",
      title: "纯文章记录",
      selectedFile: "article_only.md",
      videoLink: "https://juejin.cn/post/1",
      date: "2026-11-10",
      textType: "article",
    },
    // 无文件名：按 normalizeTitle 归为同一内容
    {
      pt: "抖音",
      group: "运营一组",
      title: "无文件名测试（全角）！ #热门",
      selectedFile: "",
      videoLink: "",
      date: "2026-11-13",
    },
    {
      pt: "小红书",
      phone: "运营一组-小红书",
      textOtherName: "无文件名测试(全角)!",
      videoLink: "",
      date: "2026-11-14",
    },
  ];

  const contents = buildContentIndex(pushRecords);
  assert.strictEqual(contents.length, 2, "图文记录应被排除，仅保留 2 条视频内容");

  const cFile = contents.find((c) => c.contentKey === "file:look_01");
  assert.ok(cFile, "同文件多平台应归一到 file:look_01");
  assert.strictEqual(cFile.firstPublishDate, "2026-11-10", "firstPublishDate 应取视频记录最早日期（不受图文 11-09 影响）");
  assert.strictEqual(cFile.displayTitle, "春季穿搭分享！ #穿搭 #日常", "displayTitle 应保留原始展示标题（不归一化）");
  assert.strictEqual(cFile.file, "look_01.mp4");
  assert.strictEqual(cFile.targets.length, 4, "重发补齐 videoLink 的快手记录应合并为同一 target，另含头条远程 URL 归一");

  const ksTarget = cFile.targets.find((t) => t.platform === "快手");
  assert.strictEqual(ksTarget.group, "运营一组", "缺 group 时应按 phone '-' 前缀提取分组");
  assert.strictEqual(ksTarget.videoLink, "https://www.kuaishou.com/short-video/ks01", "合并后应保留补齐的 videoLink");

  const biliTarget = cFile.targets.find((t) => t.platform === "哔哩哔哩");
  assert.strictEqual(biliTarget.group, "品牌-A", "显式 group 含 '-' 不应被截断");

  const cTitle = contents.find((c) => c.contentKey === "title:无文件名测试(全角)!");
  assert.ok(cTitle, "无文件名记录应按 normalizeTitle 归并");
  assert.strictEqual(cTitle.file, "");
  assert.strictEqual(cTitle.firstPublishDate, "2026-11-13");
  assert.strictEqual(cTitle.targets.length, 2);
  assert.deepStrictEqual(
    cTitle.targets.map((t) => t.platform).sort(),
    ["小红书", "抖音"]
  );
  console.log("✓ buildContentIndex：同文件多平台归一、无文件名按标题、图文排除、分组兼容与重发合并正确");
}

/* ---------- 3. linkWorks：链接优先于标题 + 话题/全角差异匹配 + 全局唯一兜底 ---------- */
{
  const contents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "相同标题",
      selectedFile: "video_a.mp4",
      videoLink: "https://www.douyin.com/video/111?from=web",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "相同标题",
      selectedFile: "video_b.mp4",
      videoLink: "https://www.douyin.com/video/222/",
      date: "2026-11-15",
    },
    {
      pt: "视频号",
      group: "G1",
      title: "美食教学（第一期）！ #美食 #家常菜",
      selectedFile: "video_a.mp4",
      videoLink: "",
      date: "2026-11-10",
    },
    // 单一 target 全局唯一标题（用于验证分组改名/跨账号 title-global 命中）
    {
      pt: "快手",
      group: "旧分组",
      title: "独家测评：新款耳机",
      selectedFile: "unique_review.mp4",
      videoLink: "",
      date: "2026-11-12",
    },
    // 多平台同内容、分组整体改名场景（两个 target 同属一个 contentKey，各平台唯一）
    {
      pt: "抖音",
      group: "老组",
      title: "改名后跨平台视频",
      selectedFile: "renamed_video.mp4",
      videoLink: "",
      date: "2026-11-12",
    },
    {
      pt: "快手",
      group: "老组",
      title: "改名后跨平台视频",
      selectedFile: "renamed_video.mp4",
      videoLink: "",
      date: "2026-11-12",
    },
    // 两个不同 content 共用同一标题 → title-global 必须判歧义不匹配
    {
      pt: "抖音",
      group: "G2",
      title: "歧义标题",
      selectedFile: "amb_1.mp4",
      videoLink: "",
      date: "2026-11-10",
    },
    {
      pt: "快手",
      group: "G2",
      title: "歧义标题",
      selectedFile: "amb_2.mp4",
      videoLink: "",
      date: "2026-11-11",
    },
  ]);

  const accounts = [
    {
      group: "G1",
      platform: "抖音",
      works: [
        // 标题完全被改，且 publishTime 更贴近 video_a，但链接指向 video_b → 必须走 link 命中 video_b
        {
          workId: "dy_link_override",
          title: "已修改的全新标题",
          url: "https://www.douyin.com/video/222?enter_from=manage",
          publishTime: Date.parse("2026-11-10T04:00:00Z"),
        },
        // 即使排在后面、标题是「相同标题」，仍通过链接命中 video_a；不会误占 video_b
        {
          workId: "dy_a",
          title: "相同标题",
          url: "https://www.douyin.com/video/111/",
          publishTime: Date.parse("2026-11-10T06:00:00Z"),
        },
      ],
    },
    {
      group: "G1",
      platform: "视频号",
      works: [
        // 标题全角/半角、零宽字符、末尾话题均与 pushData 不同 → 仍通过同 group+platform title 命中 video_a
        {
          workId: "sph_a",
          title: "美食\u200B教学(第一期)! #下饭菜",
          url: "",
          publishTime: Date.parse("2026-11-10T05:00:00Z"),
        },
      ],
    },
    {
      group: "新分组",
      platform: "快手",
      works: [
        {
          workId: "ks_global",
          title: "独家测评:新款耳机 #数码",
          url: "",
          publishTime: Date.parse("2026-11-12T04:00:00Z"),
        },
      ],
    },
    {
      group: "新组",
      platform: "抖音",
      works: [
        {
          workId: "dy_renamed",
          title: "改名后跨平台视频",
          url: "",
          publishTime: Date.parse("2026-11-12T04:00:00Z"),
        },
      ],
    },
    {
      group: "新组",
      platform: "快手",
      works: [
        {
          workId: "ks_renamed",
          title: "改名后跨平台视频",
          url: "",
          publishTime: Date.parse("2026-11-12T04:00:00Z"),
        },
      ],
    },
    {
      group: "G3",
      platform: "哔哩哔哩",
      works: [
        // 歧义标题跨两个 content → 不得匹配
        {
          workId: "bili_amb",
          title: "歧义标题",
          url: "",
          publishTime: Date.parse("2026-11-10T04:00:00Z"),
        },
      ],
    },
  ];

  const link = linkWorks({ contents, accounts });
  assert.ok(link instanceof Map, "linkWorks 应返回 Map");

  assert.deepStrictEqual(link.get(makeWorkKey("G1", "抖音", "dy_link_override")), {
    contentKey: "file:video_b",
    matchedBy: "link",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("G1", "抖音", "dy_a")), {
    contentKey: "file:video_a",
    matchedBy: "link",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("G1", "视频号", "sph_a")), {
    contentKey: "file:video_a",
    matchedBy: "title",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("新分组", "快手", "ks_global")), {
    contentKey: "file:unique_review",
    matchedBy: "title-global",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("新组", "抖音", "dy_renamed")), {
    contentKey: "file:renamed_video",
    matchedBy: "title-global",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("新组", "快手", "ks_renamed")), {
    contentKey: "file:renamed_video",
    matchedBy: "title-global",
  });
  assert.deepStrictEqual(link.get(makeWorkKey("G3", "哔哩哔哩", "bili_amb")), {
    contentKey: null,
    matchedBy: null,
  });

  // 额外验证：链接匹配跨作品仍优先于标题匹配（W_title 排前面且时间更近，但 W_link 凭链接抢回 target）
  const linkPriorityContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "同题测试",
      selectedFile: "p1.mp4",
      videoLink: "https://www.douyin.com/video/777",
      date: "2026-11-10",
    },
  ]);
  const linkPriorityRes = linkWorks({
    contents: linkPriorityContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          {
            workId: "w_by_title",
            title: "同题测试",
            url: "https://www.douyin.com/video/999",
            publishTime: Date.parse("2026-11-10T04:00:00Z"),
          },
          {
            workId: "w_by_link",
            title: "后来改了标题",
            url: "https://www.douyin.com/video/777?x=1",
            publishTime: Date.parse("2026-11-18T04:00:00Z"),
          },
        ],
      },
    ],
  });
  assert.deepStrictEqual(linkPriorityRes.get("G1|抖音|w_by_link"), {
    contentKey: "file:p1",
    matchedBy: "link",
  });
  assert.deepStrictEqual(linkPriorityRes.get("G1|抖音|w_by_title"), {
    contentKey: null,
    matchedBy: null,
  });
  console.log("✓ linkWorks：链接优先于标题、话题/全角差异匹配与全局唯一标题兜底正确");
}

/* ---------- 4. 同标题两条视频不互占（按 publishTime 最接近 firstPublishDate，且不跨平台抢占） ---------- */
{
  // 4a. 单 target，同账号 2 条同标题视频（较晚/较远那条故意排在前面，模拟 store.js 倒序列表）
  const singleTargetContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "日常Vlog",
      selectedFile: "vlog_1110.mp4",
      date: "2026-11-10",
    },
    // 同内容还发了快手，验证 抖音 的第二条同标题视频绝不会跨平台抢占快手 target
    {
      pt: "快手",
      group: "G1",
      title: "日常Vlog",
      selectedFile: "vlog_1110.mp4",
      date: "2026-11-10",
    },
  ]);

  const resSingle = linkWorks({
    contents: singleTargetContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          {
            workId: "vlog_far",
            title: "日常Vlog",
            publishTime: Date.parse("2026-11-20T04:00:00Z"),
          },
          {
            workId: "vlog_near",
            title: "日常Vlog",
            publishTime: Date.parse("2026-11-10T05:00:00Z"),
          },
        ],
      },
    ],
  });
  assert.deepStrictEqual(resSingle.get("G1|抖音|vlog_near"), {
    contentKey: "file:vlog_1110",
    matchedBy: "title",
  });
  assert.deepStrictEqual(resSingle.get("G1|抖音|vlog_far"), {
    contentKey: null,
    matchedBy: null,
  });

  // 4b. 两个不同文件（11-10 与 11-15）、完全同标题，同账号也有两条同标题作品 → 按时间就近一一配对，互不抢占
  const pairContents = buildContentIndex([
    {
      pt: "抖音",
      group: "G1",
      title: "每周复盘",
      selectedFile: "week1.mp4",
      date: "2026-11-10",
    },
    {
      pt: "抖音",
      group: "G1",
      title: "每周复盘",
      selectedFile: "week2.mp4",
      date: "2026-11-15",
    },
  ]);
  const resPair = linkWorks({
    contents: pairContents,
    accounts: [
      {
        group: "G1",
        platform: "抖音",
        works: [
          // 倒序传入
          {
            workId: "w_week2",
            title: "每周复盘 #复盘",
            publishTime: Date.parse("2026-11-15T06:00:00Z"),
          },
          {
            workId: "w_week1",
            title: "每周复盘",
            publishTime: Date.parse("2026-11-10T03:00:00Z"),
          },
        ],
      },
    ],
  });
  assert.deepStrictEqual(resPair.get("G1|抖音|w_week1"), {
    contentKey: "file:week1",
    matchedBy: "title",
  });
  assert.deepStrictEqual(resPair.get("G1|抖音|w_week2"), {
    contentKey: "file:week2",
    matchedBy: "title",
  });
  console.log("✓ 同标题两条视频不互占：按 publishTime 最接近 firstPublishDate 配对且不跨平台抢占");
}

/* ---------- 5. buildContentSummaryRows：汇总行、未关联成行、null 语义、截至 date ---------- */
{
  const contents = buildContentIndex([
    {
      pt: "抖音",
      group: "主号组",
      title: "AI神器测评！ #AI",
      selectedFile: "ai_tool.mp4",
      videoLink: "https://www.douyin.com/video/1001",
      date: "2026-11-10",
    },
    {
      pt: "哔哩哔哩",
      group: "主号组",
      title: "AI神器测评",
      selectedFile: "ai_tool.mp4",
      videoLink: "https://www.bilibili.com/video/BV1001",
      date: "2026-11-11",
    },
    {
      pt: "小红书",
      group: "副号组",
      title: "全空指标测试",
      selectedFile: "all_null.mp4",
      date: "2026-11-10",
    },
  ]);

  const accounts = [
    {
      group: "主号组",
      platform: "抖音",
      works: [
        {
          workId: "dy1",
          title: "AI神器测评! #效率",
          url: "https://www.douyin.com/video/1001?a=1",
          publishTime: Date.parse("2026-11-10T02:00:00Z"),
        },
        // 未关联作品
        {
          workId: "dy_unlinked",
          title: "随手拍日常",
          url: "https://www.douyin.com/video/9999",
          publishTime: Date.parse("2026-11-12T04:00:00Z"),
        },
      ],
    },
    {
      group: "主号组",
      platform: "哔哩哔哩",
      works: [
        {
          workId: "BV1001",
          title: "AI神器测评",
          url: "https://www.bilibili.com/video/BV1001/",
          publishTime: Date.parse("2026-11-11T04:00:00Z"),
        },
      ],
    },
    {
      group: "副号组",
      platform: "小红书",
      works: [
        {
          workId: "xhs_null",
          title: "全空指标测试",
          url: "https://www.xiaohongshu.com/explore/xhs_null",
          publishTime: Date.parse("2026-11-10T04:00:00Z"),
        },
      ],
    },
  ];

  const worksDaily = {
    "主号组|抖音": {
      dy1: {
        "2026-11-10": { play: 100, like: 0, comment: 2, share: null, favorite: null, fansDelta: -1 },
        "2026-11-12": { play: 300, like: 0, comment: 5, share: null, favorite: 10, fansDelta: 4 },
      },
      dy_unlinked: {
        "2026-11-12": { play: 88, like: 8, comment: 1, share: 0, favorite: null, fansDelta: null },
      },
    },
    "主号组|哔哩哔哩": {
      BV1001: {
        "2026-11-11": { play: 200, like: null, comment: 3, share: null, favorite: 5, fansDelta: null },
        "2026-11-12": { play: 500, like: null, comment: 7, share: null, favorite: null, fansDelta: null },
      },
    },
    "副号组|小红书": {
      xhs_null: {
        "2026-11-10": { play: null, like: null, comment: null, share: null, favorite: null, fansDelta: null },
      },
    },
  };

  const link = linkWorks({ contents, accounts });

  // 5a. 默认最新（不传 date）
  const latestRows = buildContentSummaryRows({ contents, accounts, link, worksDaily });
  assert.strictEqual(latestRows.length, 3, "应产出 2 条关联内容 + 1 条未关联作品");

  const aiRow = latestRows.find((r) => r.contentKey === "file:ai_tool");
  assert.ok(aiRow);
  assert.strictEqual(aiRow.title, "AI神器测评！ #AI");
  assert.strictEqual(aiRow.file, "ai_tool.mp4");
  assert.strictEqual(aiRow.firstPublishDate, "2026-11-10");
  assert.strictEqual(aiRow.platformCount, 2);
  assert.strictEqual(aiRow.totalPlay, 800, "300 + 500");
  assert.strictEqual(aiRow.totalLike, 0, "0 + null 应为 0 而非 null");
  assert.strictEqual(aiRow.totalComment, 12, "5 + 7");
  assert.strictEqual(aiRow.totalShare, null, "null + null 必须为 null");
  assert.strictEqual(aiRow.totalFavorite, 10, "10 + null = 10");
  assert.strictEqual(aiRow.totalFansDelta, 4, "4 + null = 4");
  assert.deepStrictEqual(Object.keys(aiRow.perPlatform).sort(), [
    "哔哩哔哩|主号组",
    "抖音|主号组",
  ]);
  assert.deepStrictEqual(aiRow.perPlatform["抖音|主号组"], {
    play: 300,
    like: 0,
    comment: 5,
    share: null,
    favorite: 10,
    fansDelta: 4,
    url: "https://www.douyin.com/video/1001?a=1",
  });
  assert.deepStrictEqual(aiRow.perPlatform["哔哩哔哩|主号组"], {
    play: 500,
    like: null,
    comment: 7,
    share: null,
    favorite: null,
    fansDelta: null,
    url: "https://www.bilibili.com/video/BV1001/",
  });

  // 全 null 指标行
  const nullRow = latestRows.find((r) => r.contentKey === "file:all_null");
  assert.ok(nullRow);
  assert.strictEqual(nullRow.platformCount, 1);
  assert.strictEqual(nullRow.totalPlay, null);
  assert.strictEqual(nullRow.totalLike, null);
  assert.strictEqual(nullRow.totalComment, null);
  assert.strictEqual(nullRow.totalShare, null);
  assert.strictEqual(nullRow.totalFavorite, null);
  assert.strictEqual(nullRow.totalFansDelta, null);

  // 未关联作品成行
  const unlinkedRow = latestRows.find((r) => r.contentKey === "unlinked:抖音:dy_unlinked");
  assert.ok(unlinkedRow, "未关联作品应独立成行且 contentKey 为 unlinked:<platform>:<workId>");
  assert.strictEqual(unlinkedRow.title, "随手拍日常");
  assert.strictEqual(unlinkedRow.file, "");
  assert.strictEqual(unlinkedRow.firstPublishDate, "2026-11-12");
  assert.strictEqual(unlinkedRow.platformCount, 1);
  assert.strictEqual(unlinkedRow.totalPlay, 88);
  assert.strictEqual(unlinkedRow.totalShare, 0);
  assert.strictEqual(unlinkedRow.totalFavorite, null);
  assert.deepStrictEqual(unlinkedRow.perPlatform["抖音|主号组"], {
    play: 88,
    like: 8,
    comment: 1,
    share: 0,
    favorite: null,
    fansDelta: null,
    url: "https://www.douyin.com/video/9999",
  });

  // 5b. 截至 date = "2026-11-11"：抖音取 11-10 快照，B站取 11-11 快照，dy_unlinked(11-12) 尚不存在
  const asOf11 = buildContentSummaryRows({
    contents,
    accounts,
    link,
    worksDaily,
    date: "2026-11-11",
  });
  assert.strictEqual(asOf11.length, 2, "截至 11-11 不应包含 11-12 才出现的 dy_unlinked");
  const ai11 = asOf11.find((r) => r.contentKey === "file:ai_tool");
  assert.strictEqual(ai11.platformCount, 2);
  assert.strictEqual(ai11.totalPlay, 300, "100(11-10) + 200(11-11)");
  assert.strictEqual(ai11.totalLike, 0);
  assert.strictEqual(ai11.totalComment, 5, "2 + 3");
  assert.strictEqual(ai11.totalFavorite, 5, "null + 5");
  assert.strictEqual(ai11.totalFansDelta, -1, "负 fansDelta 照实合计");

  // 5c. 截至 date = "2026-11-10"：仅抖音有快照，B站(11-11) 尚未出现
  const asOf10 = buildContentSummaryRows({
    contents,
    accounts,
    link,
    worksDaily,
    date: "2026-11-10",
  });
  const ai10 = asOf10.find((r) => r.contentKey === "file:ai_tool");
  assert.strictEqual(ai10.platformCount, 1);
  assert.strictEqual(ai10.totalPlay, 100);
  assert.deepStrictEqual(Object.keys(ai10.perPlatform), ["抖音|主号组"]);

  // 5d. Map 形态与嵌套对象形态 worksDaily，以及特殊 workId（__proto__ / constructor）
  const mapDaily = new Map([
    [
      "特殊组|抖音",
      Object.assign(Object.create(null), {
        ["__proto__"]: { "2026-11-10": { play: 42, like: 3, comment: null, share: null, favorite: null, fansDelta: null } },
        constructor: { "2026-11-10": { play: 10, like: 1, comment: 0, share: 0, favorite: 0, fansDelta: null } },
      }),
    ],
  ]);
  const specialRows = buildContentSummaryRows({
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
    worksDaily: mapDaily,
  });
  assert.strictEqual(specialRows.length, 2);
  assert.strictEqual(specialRows.find((r) => r.contentKey === "unlinked:抖音:__proto__").totalPlay, 42);
  assert.strictEqual(specialRows.find((r) => r.contentKey === "unlinked:抖音:constructor").totalPlay, 10);

  // 嵌套对象形态 worksDaily[group][platform]
  const nestedRows = buildContentSummaryRows({
    contents: [],
    accounts: [{ group: "G", platform: "快手", works: [{ workId: "k1", title: "嵌套测试" }] }],
    worksDaily: { G: { 快手: { k1: { "2026-11-10": { play: 77, like: 7 } } } } },
  });
  assert.strictEqual(nestedRows.length, 1);
  assert.strictEqual(nestedRows[0].totalPlay, 77);
  console.log("✓ buildContentSummaryRows：汇总行、未关联成行、null 语义、date 切片与特殊 workId 正确");
}

/* ---------- 6. buildWorkDailyRows：可选 link 参数 ---------- */
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

  // 不传 link：保持原行为（无 contentKey / matchedBy 字段）
  const plainRows = buildWorkDailyRows({ group: "G1", platform: "抖音", works, worksDaily });
  assert.strictEqual(plainRows.length, 3);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plainRows[0], "contentKey"), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plainRows[0], "matchedBy"), false);

  // 传 link Map：输出 contentKey / matchedBy
  const contents = buildContentIndex([
    { pt: "抖音", group: "G1", title: "联动视频", selectedFile: "v1.mp4", videoLink: "https://www.douyin.com/video/1", date: "2026-11-10" },
  ]);
  const link = linkWorks({ contents, accounts: [{ group: "G1", platform: "抖音", works }] });
  const linkedRows = buildWorkDailyRows({ group: "G1", platform: "抖音", works, worksDaily, link });

  const r1 = linkedRows.find((r) => r.workId === "W1");
  const r2 = linkedRows.find((r) => r.workId === "W2");
  const rDel = linkedRows.find((r) => r.workId === "W_DEL");
  assert.strictEqual(r1.contentKey, "file:v1");
  assert.strictEqual(r1.matchedBy, "link");
  assert.strictEqual(r2.contentKey, null);
  assert.strictEqual(r2.matchedBy, null);
  assert.strictEqual(rDel.contentKey, null);
  assert.strictEqual(rDel.matchedBy, null);

  // 普通对象形态 link 同样支持（且不误读原型属性）
  const objLinkedRows = buildWorkDailyRows({
    group: "G1",
    platform: "抖音",
    works,
    worksDaily,
    link: { "G1|抖音|W1": { contentKey: "file:v1", matchedBy: "title" } },
  });
  assert.strictEqual(objLinkedRows.find((r) => r.workId === "W1").contentKey, "file:v1");
  assert.strictEqual(objLinkedRows.find((r) => r.workId === "W1").matchedBy, "title");
  assert.strictEqual(objLinkedRows.find((r) => r.workId === "W2").contentKey, null);
  console.log("✓ buildWorkDailyRows：不传 link 保持原字段契约，传入 link 正确附加 contentKey / matchedBy");
}

/* ---------- 7. pushRecords.readPushRecords：注入目录 + 损坏跳过+warn + 端到端串联 ---------- */
{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mm-content-link-test-"));
  try {
    // 7a. 不存在的目录静默返回 []
    const { result: missingRes, warnings: missingWarns } = captureWarn(() =>
      readPushRecords({ dir: path.join(tmpRoot, "not-exists") })
    );
    assert.deepStrictEqual(missingRes, []);
    assert.deepStrictEqual(missingWarns, []);

    // 7b. 构造 pushData 目录：正常文件 + 损坏 JSON + 非数组 JSON + EISDIR + 非日期干扰文件
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
          videoLink: "https://www.douyin.com/video/555?from=app",
          textType: "local",
        },
        {
          pt: "百家号",
          group: "运营一组",
          title: "端到端图文",
          selectedFile: "e2e_demo.md",
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
          selectedFile: "C:\\Videos\\E2E_DEMO.MP4",
          videoLink: "",
          textType: "local",
        },
      ]),
      "utf8"
    );
    fs.writeFileSync(path.join(pushDir, "notes.txt"), "ignore", "utf8");
    fs.writeFileSync(path.join(pushDir, "2026-02-31.json"), "[]", "utf8");

    const { result: records, warnings } = captureWarn(() => readPushRecords({ dir: pushDir }));
    assert.strictEqual(records.length, 3, "应读出 2026-11-10 的 2 条 + 2026-11-14 的 1 条");
    assert.strictEqual(records[0].date, "2026-11-10");
    assert.strictEqual(records[2].date, "2026-11-14");
    assert.ok(warnings.some((w) => w.includes("2026-11-11.json")), "损坏 JSON 应 warn");
    assert.ok(warnings.some((w) => w.includes("2026-11-12.json")), "非数组结构应 warn");
    assert.ok(warnings.some((w) => w.includes("2026-11-13.json")), "读目录 EISDIR 应 warn");
    assert.strictEqual(
      warnings.some((w) => w.includes("notes.txt")),
      false,
      "非日期文件应静默忽略"
    );

    // 7c. from/to 过滤
    const filtered = readPushRecords({ dir: pushDir, from: "2026-11-14", to: "2026-11-14" });
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].pt, "快手");

    // 7d. 端到端串联：readPushRecords → buildContentIndex → linkWorks → buildContentSummaryRows + buildWorkDailyRows
    const contents = buildContentIndex(records);
    assert.strictEqual(contents.length, 1, "图文已排除，同文件双平台归一为 1 条内容");
    assert.strictEqual(contents[0].contentKey, "file:e2e_demo");

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
      "运营一组|抖音": { "555": { "2026-11-15": { play: 1000, like: 100, comment: 10, share: 5, favorite: 20, fansDelta: 3 } } },
      "运营一组|快手": { ks555: { "2026-11-15": { play: 600, like: 40, comment: 4, share: null, favorite: 8, fansDelta: null } } },
    };

    const e2eLink = linkWorks({ contents, accounts: e2eAccounts });
    assert.deepStrictEqual(e2eLink.get("运营一组|抖音|555"), { contentKey: "file:e2e_demo", matchedBy: "link" });
    assert.deepStrictEqual(e2eLink.get("运营一组|快手|ks555"), { contentKey: "file:e2e_demo", matchedBy: "title" });

    const summary = buildContentSummaryRows({ contents, accounts: e2eAccounts, link: e2eLink, worksDaily: e2eDaily });
    assert.strictEqual(summary.length, 1);
    assert.strictEqual(summary[0].platformCount, 2);
    assert.strictEqual(summary[0].totalPlay, 1600);
    assert.strictEqual(summary[0].totalShare, 5);
    assert.strictEqual(summary[0].totalFansDelta, 3);

    const dailyRows = buildWorkDailyRows({
      group: "运营一组",
      platform: "快手",
      works: e2eAccounts[1].works,
      worksDaily: e2eDaily["运营一组|快手"],
      link: e2eLink,
    });
    assert.strictEqual(dailyRows.length, 1);
    assert.strictEqual(dailyRows[0].contentKey, "file:e2e_demo");
    assert.strictEqual(dailyRows[0].matchedBy, "title");

    // 7e. 默认目录回退（mock electron.app.getPath("documents")）
    const fakeDocs = path.join(tmpRoot, "FakeDocs");
    const defaultPushDir = path.join(fakeDocs, "MatrixMedia", "data", "pushData");
    fs.mkdirSync(defaultPushDir, { recursive: true });
    fs.writeFileSync(
      path.join(defaultPushDir, "2026-11-15.json"),
      JSON.stringify([{ pt: "抖音", group: "G", title: "默认路径测试", selectedFile: "def.mp4" }]),
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
      assert.strictEqual(defRecords[0].selectedFile, "def.mp4");
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

console.log("\n全部通过：跨平台作品关联与内容级汇总行");
