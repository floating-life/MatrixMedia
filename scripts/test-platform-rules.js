"use strict";

/**
 * 卡 S17 单测：发布前按平台规则处理文案与封面
 *
 * 覆盖：
 * 1. 集中的平台规则表 src/shared/platformRules.js（8 平台字段、别名映射、双比例封面判定）
 * 2. 标题截断：标点截断（含全集合标点 & 去尾标点 & 边界标点）、无标点/截后少于一半硬截、不加省略号、emoji/Array.from 安全、覆盖值超长同样截断
 * 3. 简介截断 & 标签保留：内联 #xxx 与追加 tags 优先保留、仅截正文、单标签超限减少标签、快手 tagMax=4 保序取前 4 且其他非 4 上限平台保留 5+、快手合并 500 字上限（含标题已在简介前缀）、小红书 20 字标题与正文/话题拆分、B 站独立标签箱、幂等性、日志与调整明细
 * 4. 分平台覆盖优先级（分平台覆盖 > 通用标题/简介）：CLI（--title-by-platform / --desc-by-platform / --cover-h）、HTTP 单/多平台（target.titleByPlatform > target.title > body.titleByPlatform > body.title）、缺字段回归原行为
 * 5. xlsx 新列解析与别名（<平台中文名>标题 / <平台中文名>简介 / 别名 B站/今日头条/微信视频号/dy / 横版封面 / 视频号短标题不误判为视频号标题 / 缺列回归）
 * 6. GUI LocalVideoPublish.vue：模板编译、分平台标题覆盖、横版封面、发布前非阻断预检提示「将截断」、payload 透传与空字段不污染 publishOptions
 * 7. 抖音 / 视频号横封面上传器（fake DOM）：集中选择器导出、成功校验（slot img.src 变化 + 弹窗关闭）、失败抛错并打诊断日志/截图（弹窗未关 / src 未变 / 槽位缺失）
 * 8. publishVideo.js & MCP publish.ts：触发截断/裁标签时回执与记录写入 ruleAdjustments，未触发时保持干净原回执；MCP schema 与 CLI 参数转发
 */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { build, buildSync } = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "test/.cache/platform-rules");
fs.mkdirSync(outDir, { recursive: true });

function bundle(relPath, outName, external = ["electron"]) {
  const outfile = path.join(outDir, outName);
  buildSync({
    entryPoints: [path.join(root, relPath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external,
  });
  delete require.cache[outfile];
  return require(outfile);
}

const platformRules = bundle("src/shared/platformRules.js", "platformRules.cjs");
const videoMetadata = bundle("src/shared/videoMetadata.js", "videoMetadata.cjs");
const parsePublish = bundle("src/main/cli/parsePublishArgs.js", "parsePublishArgs.cjs");
const dyMod = bundle("src/main/services/upLoad/dy.js", "dy.cjs");
const sphMod = bundle("src/main/services/upLoad/sph.js", "sph.cjs");
const textSanitize = require(path.join(root, "src/shared/textSanitize.js"));

/* ------------------------------------------------------------------ *
 * 1. 规则表与别名映射
 * ------------------------------------------------------------------ */
function testRuleTable() {
  const {
    PLATFORM_RULES,
    resolvePlatformRuleKey,
    getPlatformRule,
    platformSupportsDualCover,
  } = platformRules;

  const expectedPlatforms = [
    "抖音",
    "视频号",
    "快手",
    "百家号",
    "头条",
    "小红书",
    "哔哩哔哩",
    "番茄视频",
  ];
  for (const pt of expectedPlatforms) {
    const r = PLATFORM_RULES[pt];
    assert.ok(r, `缺少平台规则: ${pt}`);
    assert.ok("titleMax" in r);
    assert.ok("descMax" in r);
    assert.ok("tagMax" in r);
    assert.ok(Array.isArray(r.coverRatios));
  }

  assert.strictEqual(PLATFORM_RULES["抖音"].titleMax, 30);
  assert.strictEqual(PLATFORM_RULES["百家号"].titleMax, null);
  assert.strictEqual(PLATFORM_RULES["百家号"].descMax, 50);
  assert.strictEqual(PLATFORM_RULES["百家号"].hasSeparateTitle, false);
  assert.strictEqual(PLATFORM_RULES["百家号"].combinesTitleIntoDescription, true);
  assert.strictEqual(PLATFORM_RULES["百家号"].tagsInDescriptionBudget, true);
  assert.strictEqual(PLATFORM_RULES["小红书"].titleMax, 20);
  assert.strictEqual(PLATFORM_RULES["头条"].titleMax, 30);
  assert.strictEqual(PLATFORM_RULES["快手"].tagMax, 4);
  assert.strictEqual(PLATFORM_RULES["抖音"].tagMax, 4);

  assert.deepStrictEqual(PLATFORM_RULES["抖音"].coverRatios, ["3:4", "4:3"]);
  assert.deepStrictEqual(PLATFORM_RULES["视频号"].coverRatios, ["3:4", "4:3"]);
  assert.deepStrictEqual(PLATFORM_RULES["快手"].coverRatios, ["3:4"]);

  assert.strictEqual(platformSupportsDualCover("抖音"), true);
  assert.strictEqual(platformSupportsDualCover("dy"), true);
  assert.strictEqual(platformSupportsDualCover("视频号"), true);
  assert.strictEqual(platformSupportsDualCover("sph"), true);
  assert.strictEqual(platformSupportsDualCover("快手"), false);
  assert.strictEqual(platformSupportsDualCover("百家号"), false);

  // 常见别名解析
  assert.strictEqual(resolvePlatformRuleKey("dy"), "抖音");
  assert.strictEqual(resolvePlatformRuleKey("douyin"), "抖音");
  assert.strictEqual(resolvePlatformRuleKey("微信视频号"), "视频号");
  assert.strictEqual(resolvePlatformRuleKey("B站"), "哔哩哔哩");
  assert.strictEqual(resolvePlatformRuleKey("b站"), "哔哩哔哩");
  assert.strictEqual(resolvePlatformRuleKey("今日头条"), "头条");
  assert.strictEqual(resolvePlatformRuleKey("百度百家号"), "百家号");
  assert.strictEqual(resolvePlatformRuleKey("red"), "小红书");
  assert.strictEqual(resolvePlatformRuleKey("番茄"), "番茄视频");
  assert.strictEqual(getPlatformRule("unknown-pt"), null);

  console.log("✓ 1. 集中的平台规则表与别名映射通过");
}

/* ------------------------------------------------------------------ *
 * 2. 截断纯函数：标点、去尾标点、半长硬截、无省略号、emoji 安全
 * ------------------------------------------------------------------ */
function testTruncationRules() {
  const { truncateTextByPunctuation, countChars } = platformRules;

  // 未超限原样返回
  const exact = truncateTextByPunctuation("一二三四五六七八九十", 10);
  assert.strictEqual(exact.truncated, false);
  assert.strictEqual(exact.text, "一二三四五六七八九十");

  // 标点处截断，去掉尾部标点，不加省略号
  const byComma = truncateTextByPunctuation(
    "今天去公园散步，顺便拍了一段超美的晚霞，回来剪辑分享给大家看看",
    20
  );
  assert.strictEqual(byComma.truncated, true);
  assert.strictEqual(byComma.mode, "punctuation");
  assert.strictEqual(byComma.text, "今天去公园散步，顺便拍了一段超美的晚霞");
  assert.strictEqual(countChars(byComma.text), 19);
  assert.ok(!byComma.text.endsWith("，"));
  assert.ok(!byComma.text.includes("…") && !byComma.text.includes("..."));

  // 各类标点覆盖：！ ？ 、 ； ： , . ! ? ; : 空格 ｜ | —
  for (const sep of ["，", "。", "！", "？", "、", "；", "：", ",", ".", "!", "?", ";", ":", " ", "｜", "|", "—"]) {
    const src = `前半段核心内容说明测试一下${sep}后面多出来的部分需要被裁掉`;
    const r = truncateTextByPunctuation(src, 20);
    assert.strictEqual(r.truncated, true, `sep=${sep}`);
    assert.strictEqual(r.mode, "punctuation", `sep=${sep} 应命中标点截断`);
    assert.strictEqual(r.text, "前半段核心内容说明测试一下", `sep=${sep}`);
  }

  // 上限后紧邻标点（chars[limit] 是标点）
  const nextIsPunct = truncateTextByPunctuation(
    "零一二三四五六七八九十甲乙丙丁戊己庚辛壬，后面还有内容",
    20
  );
  assert.strictEqual(nextIsPunct.truncated, true);
  assert.strictEqual(nextIsPunct.mode, "punctuation");
  assert.strictEqual(nextIsPunct.text, "零一二三四五六七八九十甲乙丙丁戊己庚辛壬");

  // 标点位置太靠前（截后少于上限一半 < 10）→ 改为硬截到 20 字
  const tooShortPunct = truncateTextByPunctuation(
    "短句，后面连续二十五个汉字没有任何标点符号所以不能只留两个字",
    20
  );
  assert.strictEqual(tooShortPunct.truncated, true);
  assert.strictEqual(tooShortPunct.mode, "hard");
  assert.strictEqual(countChars(tooShortPunct.text), 20);
  assert.strictEqual(tooShortPunct.text, "短句，后面连续二十五个汉字没有任何标点符");
  assert.ok(!tooShortPunct.text.includes("…"));

  // 完全没有标点 → 硬截到上限
  const noPunct = truncateTextByPunctuation("测".repeat(35), 30);
  assert.strictEqual(noPunct.truncated, true);
  assert.strictEqual(noPunct.mode, "hard");
  assert.strictEqual(countChars(noPunct.text), 30);

  // emoji（UTF-16 代理对）按 Array.from 计 1，硬截不破坏代理对
  const emojiTitle = "🔥".repeat(25); // UTF-16 length=50, Array.from length=25
  assert.strictEqual(countChars(emojiTitle), 25);
  const emojiCut = truncateTextByPunctuation(emojiTitle, 20);
  assert.strictEqual(emojiCut.truncated, true);
  assert.strictEqual(countChars(emojiCut.text), 20);
  assert.strictEqual(emojiCut.text, "🔥".repeat(20));
  // 验证无孤立半个代理对
  assert.ok(!/[\uD800-\uDFFF]/.test(emojiCut.text.replace(/🔥/g, "")));

  console.log("✓ 2. 截断纯函数（标点/硬截/去尾标点/无省略号/emoji）通过");
}

/* ------------------------------------------------------------------ *
 * 3. 平台规则应用：覆盖值超长、快手裁标签、简介保标签、幂等性、回执日志
 * ------------------------------------------------------------------ */
function testApplyPlatformRulesFull() {
  const { applyPlatformPublishRules, countChars } = platformRules;

  // 3a-1. 覆盖标题优先于通用标题，且覆盖值本身超长（标点前 ≥ 一半 → 按标点截）
  const xhsPunct = applyPlatformPublishRules("小红书", {
    title: "通用短标题",
    titleByPlatform: {
      xhs: "小红书专属深度解读攻略，超过二十个字也要按标点截断",
    },
  });
  assert.strictEqual(xhsPunct.adjusted, true);
  assert.strictEqual(xhsPunct.title, "小红书专属深度解读攻略");
  assert.strictEqual(countChars(xhsPunct.title), 11);
  assert.strictEqual(xhsPunct.adjustments[0].platform, "小红书");
  assert.strictEqual(xhsPunct.adjustments[0].field, "title");
  assert.strictEqual(xhsPunct.adjustments[0].originalLength, 25);
  assert.strictEqual(xhsPunct.adjustments[0].finalLength, 11);
  assert.ok(xhsPunct.adjustments[0].message.includes("25→11"));

  // 3a-2. 覆盖值超长且标点前 < 一半 → 硬截到 20
  const xhsHard = applyPlatformPublishRules("小红书", {
    title: "通用短标题",
    titleByPlatform: {
      小红书: "小红书标题，后面连续二十五个汉字没有任何标点符号所以硬截",
    },
  });
  assert.strictEqual(xhsHard.adjusted, true);
  assert.strictEqual(countChars(xhsHard.title), 20);

  // 3a-3. 百家号新版 50 字作品描述（无独立 titleMax）：标题超 50 只截标题，标点截断/硬截
  const bjhPunct = applyPlatformPublishRules("百家号", {
    title: "通用短标题",
    description: "通用简介正文",
    titleByPlatform: {
      bjh: "百家号专属深度解读攻略第一段超过三十个字用来测试标点截断，超过五十个字也要按标点截断不保留后面多出来的字",
    },
  });
  assert.strictEqual(bjhPunct.adjusted, true);
  assert.strictEqual(bjhPunct.combinedDescription, "百家号专属深度解读攻略第一段超过三十个字用来测试标点截断");
  assert.strictEqual(countChars(bjhPunct.combinedDescription), 28);
  assert.ok(!bjhPunct.combinedDescription.includes("通用简介正文"));
  assert.strictEqual(bjhPunct.adjustments[0].platform, "百家号");
  assert.strictEqual(bjhPunct.adjustments[0].field, "description");

  const bjhHard = applyPlatformPublishRules("百家号", {
    title: "通用短标题",
    titleByPlatform: {
      百家号:
        "百家号标题，后面连续五十五个汉字没有任何标点符号所以必须硬截到五十个字以内测试看看有没有超出限制呢绝对超过五十个字",
    },
  });
  assert.strictEqual(bjhHard.adjusted, true);
  assert.strictEqual(countChars(bjhHard.combinedDescription), 50);

  // 3b. 抖音标题 ≤30、小红书标题 ≤20
  const dyLong = applyPlatformPublishRules("抖音", {
    title: "这是一段用来测试抖音三十字标题上限的超长示例文案，后面多余的部分会被截断掉",
  });
  assert.strictEqual(dyLong.adjusted, true);
  assert.strictEqual(
    dyLong.title,
    "这是一段用来测试抖音三十字标题上限的超长示例文案"
  );
  assert.ok(countChars(dyLong.title) <= 30);

  const xhsLong = applyPlatformPublishRules("小红书", {
    title: "小红书图文视频实操合集，一文讲透选题与剪辑技巧",
    description: "正文内容",
    tags: ["话题一", "话题二", "话题三", "话题四", "话题五"],
  });
  assert.strictEqual(xhsLong.title, "小红书图文视频实操合集");
  assert.ok(countChars(xhsLong.title) <= 20);
  // 小红书 tagMax=null，5 个标签全部保留（不受快手 4 标签限制影响）
  assert.deepStrictEqual(xhsLong.tags, [
    "话题一",
    "话题二",
    "话题三",
    "话题四",
    "话题五",
  ]);

  // 3c. 快手标签超 4 个只取前 4 个（按填写顺序），视频号 / B 站 / 小红书不受快手 4 个限制
  const ksTags = applyPlatformPublishRules("快手", {
    title: "快手测试",
    description: "简单简介",
    tags: ["第一", "第二", "第三", "第四", "第五", "第六"],
  });
  assert.strictEqual(ksTags.adjusted, true);
  assert.deepStrictEqual(ksTags.tags, ["第一", "第二", "第三", "第四"]);
  const tagAdj = ksTags.adjustments.find((a) => a.field === "tags");
  assert.ok(tagAdj);
  assert.strictEqual(tagAdj.originalLength, 6);
  assert.strictEqual(tagAdj.finalLength, 4);
  assert.deepStrictEqual(tagAdj.droppedTags, ["第五", "第六"]);
  assert.ok(ksTags.combinedDescription.includes("#第一 #第二 #第三 #第四"));
  assert.ok(!ksTags.combinedDescription.includes("#第五"));

  // 快手内联 #话题 + 独立 tags 合计超 4 个：按出现顺序保留前 4 个
  const ksInlineTags = applyPlatformPublishRules("快手", {
    title: "标题",
    description: "正文 #内联一 #内联二",
    tags: ["独立三", "独立四", "独立五"],
  });
  assert.deepStrictEqual(ksInlineTags.tags, ["内联一", "内联二", "独立三", "独立四"]);
  assert.ok(!ksInlineTags.combinedDescription.includes("#独立五"));

  // 视频号 / 哔哩哔哩 5 个标签均不受快手 4 标签规则影响
  const sphTags = applyPlatformPublishRules("视频号", {
    title: "视频号测试",
    description: "简介",
    tags: ["一", "二", "三", "四", "五", "六"],
  });
  assert.strictEqual(sphTags.adjusted, false);
  assert.strictEqual(sphTags.tags.length, 6);

  const blblTags = applyPlatformPublishRules("哔哩哔哩", {
    title: "B站测试",
    description: "简介",
    tags: ["一", "二", "三", "四", "五", "六"],
  });
  assert.strictEqual(blblTags.adjusted, false);
  assert.strictEqual(blblTags.tags.length, 6);

  // 3d. 简介超限时：话题标签（内联 #xxx + 追加 tags）优先保留，只截正文
  const longBody = `${"这是一段非常长的测试正文内容，".repeat(80)}结尾段落`;
  const sphLongDesc = applyPlatformPublishRules("视频号", {
    title: "视频号长简介测试",
    description: `${longBody} #内联必留`,
    tags: ["追加一", "追加二"],
  });
  assert.strictEqual(sphLongDesc.adjusted, true);
  assert.ok(
    countChars(sphLongDesc.combinedDescription) <= 1000,
    `视频号简介超限: ${countChars(sphLongDesc.combinedDescription)}`
  );
  assert.ok(sphLongDesc.combinedDescription.includes("#内联必留"));
  assert.ok(sphLongDesc.combinedDescription.includes("#追加一"));
  assert.ok(sphLongDesc.combinedDescription.includes("#追加二"));
  assert.ok(sphLongDesc.adjustments.some((a) => a.field === "description"));

  // 3e. 单标签本身或标签总长超出 descMax 时，按上限减少标签
  const hugeTags = [
    "甲".repeat(200),
    "乙".repeat(200),
    "丙".repeat(200),
  ];
  const ksHugeTags = applyPlatformPublishRules("快手", {
    title: "标题",
    description: "正文",
    tags: hugeTags,
  });
  assert.strictEqual(ksHugeTags.adjusted, true);
  assert.ok(
    countChars(ksHugeTags.ksFillText) <= 500,
    `快手填充总长应 <= 500，实际 ${countChars(ksHugeTags.ksFillText)}`
  );
  assert.strictEqual(ksHugeTags.tags.length, 2, "超过 500 字的第 3 个超长标签应被裁剪");
  assert.ok(ksHugeTags.adjustments.some((a) => a.field === "tags"));

  // 3f. 快手合并上限（含标题已在简介开头前缀的场景）：绝不超过 500 字
  const ksPrefixTitle = "快手前缀标题".repeat(70); // 420 chars
  const ksPrefixDesc = `${ksPrefixTitle}，后面补充一大段描述超过五百字`.repeat(2);
  const ksPrefixRes = applyPlatformPublishRules("快手", {
    title: ksPrefixTitle,
    description: ksPrefixDesc,
    tags: ["标签一", "标签二"],
  });
  assert.ok(
    countChars(ksPrefixRes.ksFillText) <= 500,
    `快手前缀场景总长超 500: ${countChars(ksPrefixRes.ksFillText)}`
  );
  assert.ok(ksPrefixRes.ksFillText.includes("#标签一 #标签二"));

  // 3g. 幂等性：对处理后结果再跑一次不二次截断、不产新调整
  const dySecond = applyPlatformPublishRules("抖音", {
    title: dyLong.title,
    description: sphLongDesc.bodyDescription,
    tags: sphLongDesc.tags.slice(0, 3),
  });
  assert.strictEqual(dySecond.adjusted, false);
  assert.strictEqual(dySecond.adjustments.length, 0);

  // 3h. buildPlatformVideoText / buildPlatformVideoTextDetailed 集成（与 videoMetadata.js 联动）
  const builtKs = videoMetadata.buildPlatformVideoTextDetailed("快手", {
    title: "快手测试",
    description: "内容简介",
    tags: ["a", "b", "c", "d", "e"],
  });
  assert.deepStrictEqual(builtKs.tags, ["a", "b", "c", "d"]);
  assert.strictEqual(builtKs.adjusted, true);
  assert.ok(builtKs.ksFillText.includes("#a #b #c #d"));
  assert.deepStrictEqual(
    videoMetadata.buildPlatformVideoText("快手", {
      title: "快手测试",
      description: "内容简介",
      tags: ["a", "b", "c", "d", "e"],
    }),
    {
      title: "快手测试",
      description: "内容简介 #a #b #c #d",
      shortTitle: "",
    }
  );

  // 3i. 日志输出验证（options.log = true）
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    applyPlatformPublishRules(
      "抖音",
      { title: "超过三十字的测试标题测试标题测试标题测试标题测试标题测试标题测试" },
      { log: true }
    );
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warns.some((w) => w.includes("[platform-rules]") && w.includes("[抖音]")),
    "开启 log 时应打印截断告警日志"
  );

  console.log("✓ 3. 平台规则应用（覆盖超长/快手裁标签/保标签/幂等/日志）通过");
}

/* ------------------------------------------------------------------ *
 * 3.5 S17 返修第 1 轮：话题识别、不丢正文、全平台幂等、B 站保话题与 Grok 三组实测用例
 * ------------------------------------------------------------------ */
function testS17ReworkCases() {
  const {
    PLATFORM_RULES,
    applyPlatformPublishRules,
    createAppliedRuleSnapshot,
    extractInlineHashtags,
    countChars,
  } = platformRules;

  // A. extractInlineHashtags 话题识别：任意位置 #、中英文标点截断、连写、胶囊、空话题
  assert.deepStrictEqual(extractInlineHashtags("正文。#减脂"), {
    body: "正文。",
    inlineTags: ["减脂"],
  });
  assert.deepStrictEqual(extractInlineHashtags("正文#话题"), {
    body: "正文",
    inlineTags: ["话题"],
  });
  assert.deepStrictEqual(extractInlineHashtags("#减脂#健身#干货"), {
    body: "",
    inlineTags: ["减脂", "健身", "干货"],
  });
  assert.deepStrictEqual(extractInlineHashtags("前面内容。#减脂#健身#干货"), {
    body: "前面内容。",
    inlineTags: ["减脂", "健身", "干货"],
  });
  assert.deepStrictEqual(
    extractInlineHashtags("探店记录 #美食，环境很好，推荐尝试"),
    {
      body: "探店记录，环境很好，推荐尝试",
      inlineTags: ["美食"],
    }
  );
  assert.deepStrictEqual(
    extractInlineHashtags("#减脂，今天分享在家深蹲"),
    {
      body: "今天分享在家深蹲",
      inlineTags: ["减脂"],
    }
  );
  // 中英文标点终止：，。！？、；：,.!?;:「」“”（）()【】[]
  assert.deepStrictEqual(
    extractInlineHashtags(
      "「#美食」“#探店”（#干货）(#vlog)【#精选】[#daily]#a，#b。#c！#d？#e、#f；#g：#h,#i.#j!#k?#l;#m:"
    ).inlineTags,
    [
      "美食",
      "探店",
      "干货",
      "vlog",
      "精选",
      "daily",
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
      "g",
      "h",
      "i",
      "j",
      "k",
      "l",
      "m",
    ]
  );
  // 平台话题胶囊写法 `#话题[话题]#` 兼容
  assert.deepStrictEqual(
    extractInlineHashtags("看这里 #美食[话题]##探店[话题]# 很好吃"),
    {
      body: "看这里 很好吃",
      inlineTags: ["美食", "探店"],
    }
  );
  assert.deepStrictEqual(
    extractInlineHashtags("#减脂[话题]#，今天分享深蹲"),
    {
      body: "今天分享深蹲",
      inlineTags: ["减脂"],
    }
  );
  // 空话题（单独 # / 紧跟标点 / 连续 # / 键帽 emoji）不算话题
  for (const emptyHashCase of [
    "#",
    "##",
    "单独的 # 符号",
    "价格#，优惠#。",
    "结尾#",
    "#[话题]#",
    "#️⃣ 排名第一",
  ]) {
    const ext = extractInlineHashtags(emptyHashCase);
    assert.deepStrictEqual(
      ext.inlineTags,
      [],
      `空话题不应被识别: ${emptyHashCase}`
    );
    assert.strictEqual(ext.body, emptyHashCase);
  }
  // 防止残留孤立 # 与后文粘连生成新话题
  const coalesced = extractInlineHashtags("前面##美食[话题]#后面");
  assert.deepStrictEqual(coalesced.inlineTags, ["美食"]);
  assert.deepStrictEqual(extractInlineHashtags(coalesced.body).inlineTags, []);

  // B. Grok 实测用例 1：704 字、以 `#减脂，` 开头且中间无空格的简介 + 话题「健身」，快手标题「在家减脂」
  {
    const baseSentence = "今天分享在家就能做的无器械深蹲训练动作要领与呼吸节奏";
    const body700 = Array.from(baseSentence.repeat(30)).slice(0, 700).join("");
    const desc704 = `#减脂，${body700}`;
    assert.strictEqual(countChars(desc704), 704);
    const r1 = applyPlatformPublishRules("快手", {
      title: "在家减脂",
      description: desc704,
      tags: ["健身"],
    });
    assert.strictEqual(r1.adjusted, true);
    assert.strictEqual(r1.title, "在家减脂");
    assert.ok(
      countChars(r1.ksFillText) <= 500,
      `快手超 500: ${countChars(r1.ksFillText)}`
    );
    assert.ok(r1.ksFillText.startsWith("在家减脂\n"));
    assert.ok(r1.bodyDescription.includes("深蹲"), "正文深蹲内容不能丢");
    // 500 - title(4) - \n(1) - space(1) - `#减脂 #健身`(7) = 487 字最大可用正文
    assert.strictEqual(
      countChars(r1.bodyDescription),
      487,
      `正文应保留到上限允许的最大长度 487，实际 ${countChars(r1.bodyDescription)}`
    );
    assert.deepStrictEqual(r1.tags, ["减脂", "健身"]);
    assert.ok(r1.ksFillText.includes("#减脂 #健身"));
    // 幂等验证
    const r2 = applyPlatformPublishRules("快手", r1);
    assert.strictEqual(r2.adjusted, false);
    assert.strictEqual(r2.ksFillText, r1.ksFillText);
    assert.strictEqual(r2.bodyDescription, r1.bodyDescription);
    assert.deepStrictEqual(r2.tags, r1.tags);
  }

  // C. Grok 实测用例 2：「探店记录 #美食，环境很好，推荐尝试」+ 话题「探店」跑两遍（含 GUI/CLI normalize + 上传器二次调用）
  {
    const srcDesc = "探店记录 #美食，环境很好，推荐尝试";
    for (const pt of ["抖音", "快手", "视频号", "小红书"]) {
      const r1 = applyPlatformPublishRules(pt, {
        title: "探店标题",
        description: srcDesc,
        tags: ["探店"],
      });
      assert.strictEqual(r1.adjusted, false, `${pt} 未超限不应触发调整`);
      assert.ok(r1.combinedDescription.includes("#美食"));
      assert.ok(r1.combinedDescription.includes("#探店"), `${pt} 第一遍必须保留「探店」`);
      assert.ok(!r1.combinedDescription.includes("#环境很好"));
      assert.ok(!r1.combinedDescription.includes("#推荐尝试"));

      // 模拟 GUI/CLI：normalizeVideoMetadata → 上传器 buildPlatformVideoTextDetailed（无快照 + 有快照两条路都验）
      const norm = videoMetadata.normalizeVideoMetadata(
        {
          title: r1.title,
          description: r1.bodyDescription,
          shortTitle: r1.shortTitle,
          tags: r1.tags,
        },
        pt
      );
      const secondNoSnap = videoMetadata.buildPlatformVideoTextDetailed(pt, {
        title: norm.title,
        description: norm.description,
        shortTitle: norm.shortTitle,
        tags: norm.tags,
        ...norm.legacy,
      });
      assert.strictEqual(secondNoSnap.adjusted, false);
      assert.strictEqual(
        secondNoSnap.description,
        r1.combinedDescription,
        `${pt} 无快照二次调用必须完全不变`
      );
      assert.strictEqual(secondNoSnap.ksFillText, r1.ksFillText);
      assert.deepStrictEqual(secondNoSnap.tags, r1.tags);
      assert.ok(secondNoSnap.description.includes("#探店"), `${pt} 第二遍绝不能挤掉「探店」`);
      assert.ok(!secondNoSnap.description.includes("#环境很好"));
      assert.ok(!secondNoSnap.description.includes("#推荐尝试"));

      const secondWithSnap = videoMetadata.buildPlatformVideoTextDetailed(pt, {
        title: norm.title,
        description: norm.description,
        shortTitle: norm.shortTitle,
        tags: norm.tags,
        ...norm.legacy,
        platformRulesApplied: createAppliedRuleSnapshot(r1),
      });
      assert.strictEqual(secondWithSnap.adjusted, false);
      assert.strictEqual(secondWithSnap.description, r1.combinedDescription);
      assert.strictEqual(secondWithSnap.ksFillText, r1.ksFillText);
      assert.deepStrictEqual(secondWithSnap.tags, r1.tags);
    }

    // P2 专项：视频号「探店记录 #美食，环境很好，推荐尝试」+ 4 个话题跑两遍不得追加拆出的逗号伪话题
    const sphFour1 = applyPlatformPublishRules("视频号", {
      title: "探店",
      description: srcDesc,
      tags: ["探店", "周末", "打卡", "日常"],
    });
    const sphFourNorm = videoMetadata.normalizeVideoMetadata(
      {
        title: sphFour1.title,
        description: sphFour1.bodyDescription,
        shortTitle: sphFour1.shortTitle,
        tags: sphFour1.tags,
      },
      "视频号"
    );
    const sphFour2 = videoMetadata.buildPlatformVideoTextDetailed("视频号", {
      ...sphFourNorm,
      ...sphFourNorm.legacy,
    });
    assert.strictEqual(sphFour2.description, sphFour1.combinedDescription);
    assert.strictEqual(
      sphFour2.description,
      "探店记录 #美食，环境很好，推荐尝试 #探店 #周末 #打卡 #日常"
    );
    assert.ok(!sphFour2.description.includes("#环境很好"));
    assert.ok(!sphFour2.description.includes("#推荐尝试"));
  }

  // D. Grok 实测用例 3（含 P3 B 站）：句号后直接写 `#减脂#健身#干货` + 独立话题「日常」超限截断
  {
    const makeEndedWithTags = (targetTotalLen) => {
      const suffix = "。#减脂#健身#干货";
      const need = targetTotalLen - countChars(suffix);
      const unit = "这是一段干货满满的居家训练记录，动作标准很关键。";
      let body = "";
      while (countChars(body) < need) body += unit;
      return Array.from(body).slice(0, need).join("") + suffix;
    };

    const cases = [
      { pt: "快手", totalLen: 580, maxLen: 500, checkField: "ksFillText" },
      { pt: "抖音", totalLen: 1150, maxLen: 1000, checkField: "combinedDescription" },
      { pt: "视频号", totalLen: 1150, maxLen: 1000, checkField: "combinedDescription" },
      { pt: "小红书", totalLen: 1150, maxLen: 1000, checkField: "combinedDescription" },
      { pt: "哔哩哔哩", totalLen: 2290, maxLen: 2000, checkField: "combinedDescription" },
    ];
    for (const c of cases) {
      const desc = makeEndedWithTags(c.totalLen);
      assert.strictEqual(countChars(desc), c.totalLen);
      const r1 = applyPlatformPublishRules(c.pt, {
        title: "居家训练",
        description: desc,
        tags: ["日常"],
      });
      assert.strictEqual(r1.adjusted, true, `${c.pt} 应触发截断`);
      const outText = r1[c.checkField];
      assert.ok(
        countChars(outText) <= c.maxLen,
        `${c.pt} 截断后超出上限 ${c.maxLen}: ${countChars(outText)}`
      );
      assert.ok(r1.bodyDescription.length > 0, `${c.pt} 正文不得为空`);
      assert.ok(outText.includes("#减脂"), `${c.pt} 应保留 #减脂`);
      assert.ok(outText.includes("#健身"), `${c.pt} 应保留 #健身`);
      assert.ok(outText.includes("#干货"), `${c.pt} 应保留 #干货`);
      if (c.pt === "哔哩哔哩") {
        // B 站独立标签栏保留「日常」，简介保留内联 #减脂 #健身 #干货
        assert.deepStrictEqual(r1.tags, ["日常"]);
        assert.ok(r1.description.includes("#减脂 #健身 #干货"));
        assert.ok(countChars(r1.description) <= 2000);
      } else {
        assert.ok(outText.includes("#日常"), `${c.pt} 应保留独立话题 #日常`);
        assert.deepStrictEqual(r1.tags, ["减脂", "健身", "干货", "日常"]);
      }
      // 二次调用完全不变
      const r2 = applyPlatformPublishRules(c.pt, r1);
      assert.strictEqual(r2.adjusted, false, `${c.pt} 二次调用不应再调整`);
      assert.strictEqual(r2[c.checkField], outText);
      assert.deepStrictEqual(r2.tags, r1.tags);
    }
  }

  // E. 不丢正文专项：单话题过长丢弃该话题不吞正文；快手超长标题也不得把正文清空只剩标题
  {
    const longBodyNoPunct = "深蹲训练".repeat(150); // 600 chars
    // E1. 单个超长话题（500 字）+ 正常短话题「健身」→ 丢超长话题，保留「健身」与最大长度正文
    const ksOversized = applyPlatformPublishRules("快手", {
      title: "在家减脂",
      description: longBodyNoPunct,
      tags: ["超".repeat(500), "健身"],
    });
    assert.strictEqual(ksOversized.adjusted, true);
    assert.deepStrictEqual(ksOversized.tags, ["健身"]);
    assert.strictEqual(countChars(ksOversized.bodyDescription), 491); // 500 - 4 - 1 - 1 - 3
    assert.strictEqual(countChars(ksOversized.ksFillText), 500);
    assert.ok(ksOversized.ksFillText.includes("深蹲训练"));

    // E2. 单话题接近上限（499 字）+ 10 字短正文 → 丢超长话题，10 字正文完整保留
    const ksNearLimitTag = applyPlatformPublishRules("快手", {
      title: "减脂",
      description: "十个字的正文绝不能丢",
      tags: ["甲".repeat(499)],
    });
    assert.strictEqual(ksNearLimitTag.bodyDescription, "十个字的正文绝不能丢");
    assert.deepStrictEqual(ksNearLimitTag.tags, []);
    assert.ok(countChars(ksNearLimitTag.ksFillText) <= 500);

    // E3. 快手标题本身超 500 字 + 200 字正文 + 话题「健身」→ 不允许清空正文只剩标题
    const ksHugeTitle = applyPlatformPublishRules("快手", {
      title: "标".repeat(520),
      description: "正".repeat(200),
      tags: ["健身"],
    });
    assert.ok(countChars(ksHugeTitle.ksFillText) <= 500);
    assert.ok(ksHugeTitle.title.length > 0, "标题应保留");
    assert.ok(ksHugeTitle.bodyDescription.length >= 50, "正文绝不能被超长标题清空");
    assert.deepStrictEqual(ksHugeTitle.tags, ["健身"]);

    // E4. B 站简介内单个超长内联话题 + 短正文 → 丢超长内联话题，保留正文与独立标签栏
    const blblOversizedInline = applyPlatformPublishRules("哔哩哔哩", {
      title: "B站测试",
      description: `这是不能丢的正文 #${"长".repeat(2100)} #短话题`,
      tags: ["独立标签"],
    });
    assert.ok(countChars(blblOversizedInline.description) <= 2000);
    assert.ok(blblOversizedInline.description.includes("这是不能丢的正文"));
    assert.ok(blblOversizedInline.description.includes("#短话题"));
    assert.deepStrictEqual(blblOversizedInline.tags, ["独立标签"]);
  }

  // F. 严格幂等覆盖全部 8 个平台：apply(apply(x)) === apply(x)
  {
    const allPlatforms = Object.keys(PLATFORM_RULES);
    assert.strictEqual(allPlatforms.length, 8);

    const sampleInputs = [
      {
        name: "短文案+逗号紧邻内联话题+独立标签",
        input: {
          title: "短标题",
          description: "探店记录 #美食，环境很好，推荐尝试",
          shortTitle: "探店记录短标",
          tags: ["探店", "周末", "打卡", "日常", "美食"],
        },
      },
      {
        name: "连写话题+胶囊话题+独立标签超限",
        input: {
          title: "超长标题测试".repeat(20),
          description: `${"居家无器械深蹲教程，坚持每天打卡有效。".repeat(130)}#减脂#健身#干货 #胶囊[话题]#`,
          shortTitle: "居家深蹲教程",
          tags: ["日常", "运动", "健康", "打卡", "新手", "居家"],
        },
      },
      {
        name: "开头逗号内联话题+无空格长正文",
        input: {
          title: "在家减脂",
          description: `#减脂，${"无器械深蹲训练计划".repeat(260)}`,
          shortTitle: "在家减脂计划",
          tags: ["健身"],
        },
      },
      {
        name: "单个超长话题+短话题+正文",
        input: {
          title: "正常标题",
          description: "核心正文内容绝对不能被超长话题吞掉".repeat(30),
          tags: ["超".repeat(600), "短一", "短二"],
        },
      },
      {
        name: "超长标题+前缀重合+超长正文",
        input: {
          title: "前缀标题".repeat(120),
          description: `${"前缀标题".repeat(120)}，补充描述内容超过限制`.repeat(2),
          tags: ["甲".repeat(80), "乙".repeat(80)],
        },
      },
      {
        name: "纯话题无正文+空井号混合",
        input: {
          title: "纯话题",
          description: "# #减脂#健身",
          tags: ["干货", "日常", "多余"],
        },
      },
      {
        name: "分平台覆盖超长值",
        input: {
          title: "通用标题",
          description: "通用简介",
          titleByPlatform: {
            dy: "抖音覆盖超长标题".repeat(8),
            bjh: "百家号覆盖超长标题".repeat(8),
            xhs: "小红书覆盖超长标题".repeat(8),
            tt: "头条覆盖超长标题".repeat(8),
            blbl: "B站覆盖超长标题".repeat(20),
            ks: "快手覆盖标题".repeat(90),
          },
          descByPlatform: {
            dy: `${"抖音覆盖超长简介。".repeat(130)}#覆一#覆二`,
            bjh: "这场戏的看点是掌柜往豆腐缸里泼脏水，济公当众拆穿。街坊邻居全都围过来拍手叫好，黑心掌柜灰溜溜低头认错，再不敢作恶。",
            ks: `${"快手覆盖超长简介。".repeat(70)}#覆一#覆二`,
            sph: `${"视频号覆盖超长简介。".repeat(130)}#覆一#覆二`,
            xhs: `${"小红书覆盖超长简介。".repeat(130)}#覆一#覆二`,
            blbl: `${"B站覆盖超长简介。".repeat(240)}#覆一#覆二`,
          },
          tags: ["一", "二", "三", "四", "五"],
        },
      },
    ];

    for (const pt of allPlatforms) {
      for (const sample of sampleInputs) {
        const r1 = applyPlatformPublishRules(pt, sample.input);
        const r2 = applyPlatformPublishRules(pt, r1);
        const ctx = `[${pt}][${sample.name}]`;
        assert.strictEqual(r2.title, r1.title, `${ctx} title 不幂等`);
        assert.strictEqual(r2.description, r1.description, `${ctx} description 不幂等`);
        assert.strictEqual(r2.bodyDescription, r1.bodyDescription, `${ctx} bodyDescription 不幂等`);
        assert.strictEqual(
          r2.combinedDescription,
          r1.combinedDescription,
          `${ctx} combinedDescription 不幂等`
        );
        assert.strictEqual(r2.ksFillText, r1.ksFillText, `${ctx} ksFillText 不幂等`);
        assert.strictEqual(r2.shortTitle, r1.shortTitle, `${ctx} shortTitle 不幂等`);
        assert.deepStrictEqual(r2.tags, r1.tags, `${ctx} tags 不幂等`);
        assert.strictEqual(r2.tagsText, r1.tagsText, `${ctx} tagsText 不幂等`);
        assert.strictEqual(r2.adjusted, false, `${ctx} 第二遍不应再触发调整`);
        assert.strictEqual(r2.adjustments.length, 0, `${ctx} 第二遍 adjustments 应为空`);
        assert.strictEqual(r2.summary, "", `${ctx} 第二遍 summary 应为空`);

        // 同步验证 buildPlatformVideoTextDetailed 带快照与修改字段后的安全回退
        const snap = createAppliedRuleSnapshot(r1);
        const viaSnap = videoMetadata.buildPlatformVideoTextDetailed(pt, {
          title: r1.title,
          description: r1.bodyDescription,
          shortTitle: r1.shortTitle,
          tags: r1.tags,
          platformRulesApplied: snap,
        });
        assert.strictEqual(viaSnap.title, r1.title, `${ctx} snapshot title 不一致`);
        assert.strictEqual(viaSnap.description, r1.combinedDescription, `${ctx} snapshot description 不一致`);
        assert.strictEqual(viaSnap.ksFillText, r1.ksFillText, `${ctx} snapshot ksFillText 不一致`);
        assert.deepStrictEqual(viaSnap.tags, r1.tags, `${ctx} snapshot tags 不一致`);
        assert.strictEqual(viaSnap.adjusted, false);
      }
    }

    // 修改字段后快照自动失效并重新应用规则
    const baseR1 = applyPlatformPublishRules("百家号", { title: "短标题" });
    const mutated = videoMetadata.buildPlatformVideoTextDetailed("百家号", {
      title: "事后被改成了超过五十个字的百家号长作品描述首句需要重新按五十上限截断并且绝不能超过平台计数器上限限制绝对超长",
      platformRulesApplied: createAppliedRuleSnapshot(baseR1),
    });
    assert.strictEqual(mutated.adjusted, true);
    assert.ok(countChars(mutated.description) <= 50);
  }

  console.log("✓ 3.5 S17 返修用例（话题识别/不丢正文/全平台幂等/B站保话题/Grok三组用例）通过");
}

/* ------------------------------------------------------------------ *
 * 4. CLI & HTTP 参数解析、覆盖优先级与回归
 * ------------------------------------------------------------------ */
function testCliAndHttpArgs() {
  const base = ["-p", "dy", "--phone", "13800138000", "-f", "./v.mp4", "-t", "通用标题"];

  // 4a. 缺新字段回归原行为
  const plain = parsePublish.parsePublishArgs(base);
  assert.strictEqual(plain.ok, true);
  assert.strictEqual(plain.value.coverPathH, null);
  assert.deepStrictEqual(plain.value.titleByPlatform, {});
  assert.deepStrictEqual(plain.value.descByPlatform, {});
  assert.deepStrictEqual(plain.value.publishOptions, {});

  // 4b. CLI --cover-h / --title-by-platform / --desc-by-platform
  const withNew = parsePublish.parsePublishArgs(
    textSanitize.sanitizePublishCliArgs([
      ...base,
      "--cover-h",
      "/tmp/h.jpg",
      "--title-by-platform",
      '{"dy":"抖音标题","bjh":"百家号标题"}',
      "--desc-by-platform",
      '{"ks":"快手简介"}',
    ])
  );
  assert.strictEqual(withNew.ok, true, withNew.error);
  assert.strictEqual(withNew.value.coverPathH, "/tmp/h.jpg");
  assert.deepStrictEqual(withNew.value.titleByPlatform, {
    抖音: "抖音标题",
    百家号: "百家号标题",
  });
  assert.deepStrictEqual(withNew.value.descByPlatform, { 快手: "快手简介" });

  // 非法 JSON 报错
  const badJson = parsePublish.parsePublishArgs([
    ...base,
    "--title-by-platform",
    "not-json",
  ]);
  assert.strictEqual(badJson.ok, false);
  assert.ok(badJson.error.includes("合法的 JSON 对象"));

  // 数组报错（必须是对象）
  const arrJson = parsePublish.parsePublishArgs([
    ...base,
    "--desc-by-platform",
    '["a"]',
  ]);
  assert.strictEqual(arrJson.ok, false);

  // help 文案包含新参数
  const help = parsePublish.publishHelpText();
  assert.ok(help.includes("--cover-h"));
  assert.ok(help.includes("--title-by-platform"));
  assert.ok(help.includes("--desc-by-platform"));

  // 4c. HTTP 单平台 & 多平台优先级：
  //     target.titleByPlatform > target.title > body.titleByPlatform > body.title
  const httpMulti = parsePublish.parseMultiPublishRequest({
    file: "/tmp/v.mp4",
    phone: "13800138000",
    title: "全局通用标题",
    description: "全局通用简介",
    titleByPlatform: { dy: "全局抖音覆盖", bjh: "全局百家号覆盖", ks: "全局快手覆盖" },
    descByPlatform: { dy: "全局抖音简介", ks: "全局快手简介" },
    coverPathH: "/tmp/h-cover.jpg",
    platforms: [
      "dy", // 用 body.titleByPlatform.dy
      { platform: "bjh", title: "单平台直接标题" }, // target.title 必须高于 body.titleByPlatform.bjh
      {
        platform: "ks",
        title: "单平台直接标题",
        titleByPlatform: { ks: "单平台映射最高优" },
      }, // target.titleByPlatform.ks 最高
      "xhs", // 无覆盖，落回全局通用标题
    ],
  });
  assert.strictEqual(httpMulti.ok, true, httpMulti.error);
  const [rDy, rBjh, rKs, rXhs] = httpMulti.value;
  assert.strictEqual(rDy.coverPathH, "/tmp/h-cover.jpg");
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(rDy.platform, rDy).title,
    "全局抖音覆盖"
  );
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(rDy.platform, rDy).bodyDescription,
    "全局抖音简介"
  );
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(rBjh.platform, rBjh).title,
    "单平台直接标题",
    "platforms[].title 必须优先于顶层 titleByPlatform"
  );
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(rKs.platform, rKs).title,
    "单平台映射最高优"
  );
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(rXhs.platform, rXhs).title,
    "通用标题".length ? "全局通用标题" : ""
  );

  // HTTP 校验非法 titleByPlatform（非对象）
  const httpBadMap = parsePublish.parseMultiPublishRequest({
    platform: "dy",
    phone: "13800138000",
    file: "/tmp/v.mp4",
    title: "标题",
    titleByPlatform: "bad",
  });
  assert.strictEqual(httpBadMap.ok, false);

  // 4d. S17 返修第 4 轮（Grok P3）：多平台子目标未带 descByPlatform 时继承顶层 descByPlatform
  const httpInheritDescMap = parsePublish.parseMultiPublishRequest({
    file: "/tmp/v.mp4",
    phone: "13800138000",
    title: "济公断案",
    description: "顶层通用简介",
    descByPlatform: {
      bjh: "这场戏的看点是掌柜往豆腐缸里泼脏水，济公当众拆穿。",
      ks: "顶层快手专属简介",
    },
    tags: "民间故事",
    platforms: [
      { platform: "bjh", description: "子目标通用简介" }, // 未带 descByPlatform → 继承顶层 descByPlatform.bjh
      { platform: "dy", description: "子目标抖音直接简介" }, // 顶层无 dy 项 → 保留子目标 description
      {
        platform: "ks",
        description: "子目标快手通用简介",
        "desc-by-platform": { ks: "子目标快手映射覆盖" },
      }, // 子目标显式带映射 → 以子目标映射为准
    ],
  });
  assert.strictEqual(httpInheritDescMap.ok, true, httpInheritDescMap.error);
  const [inhBjh, inhDy, inhKs] = httpInheritDescMap.value;
  assert.strictEqual(
    inhBjh.descByPlatform["百家号"],
    "这场戏的看点是掌柜往豆腐缸里泼脏水，济公当众拆穿。",
    "多平台子目标未带 descByPlatform 时必须继承顶层 descByPlatform"
  );
  const inhBjhRuled = platformRules.applyPlatformPublishRules(inhBjh.platform, inhBjh);
  assert.strictEqual(
    inhBjhRuled.combinedDescription,
    "这场戏的看点是掌柜往豆腐缸里泼脏水，济公当众拆穿。 #民间故事"
  );
  assert.strictEqual(inhBjhRuled.title, "济公断案");
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(inhDy.platform, inhDy).bodyDescription,
    "子目标抖音直接简介"
  );
  assert.strictEqual(
    platformRules.applyPlatformPublishRules(inhKs.platform, inhKs).bodyDescription,
    "子目标快手映射覆盖"
  );

  console.log("✓ 4. CLI & HTTP 参数解析与覆盖优先级通过");
}

/* ------------------------------------------------------------------ *
 * 5. xlsx 新列解析与别名（含缺列回归 & 视频号短标题不误判）
 * ------------------------------------------------------------------ */
function testXlsxColumns() {
  const { normalizeBatchXlsxRows } = textSanitize;

  // 5a. 新列：各平台中文名标题/简介 + 别名 + 横版封面
  const rows = normalizeBatchXlsxRows([
    {
      文件名: "demo.mp4",
      标题: "通用标题",
      简介: "通用简介",
      标签: "标签1 标签2",
      视频号短标题: "六字以上短标题",
      封面: "v.jpg",
      横版封面: "h.jpg",
      抖音标题: "抖音专属标题",
      百家号标题: "百家号专属标题",
      快手简介: "快手专属简介",
      B站标题: "B站专属标题",
      今日头条标题: "头条专属标题",
      微信视频号简介: "视频号专属简介",
      xhs_title: "小红书英文别名标题",
    },
  ]);
  assert.strictEqual(rows.length, 1);
  const row = rows[0];
  assert.strictEqual(row.fileName, "demo.mp4");
  assert.strictEqual(row.title, "通用标题");
  assert.strictEqual(row.shortTitle, "六字以上短标题");
  assert.strictEqual(row.coverPath, "v.jpg");
  assert.strictEqual(row.coverPathH, "h.jpg");
  assert.strictEqual(row.titleByPlatform["抖音"], "抖音专属标题");
  assert.strictEqual(row.titleByPlatform["百家号"], "百家号专属标题");
  assert.strictEqual(row.titleByPlatform["哔哩哔哩"], "B站专属标题");
  assert.strictEqual(row.titleByPlatform["头条"], "头条专属标题");
  assert.strictEqual(row.titleByPlatform["小红书"], "小红书英文别名标题");
  // 视频号短标题绝不能被误解析为 视频号标题
  assert.strictEqual(row.titleByPlatform["视频号"], undefined);
  assert.strictEqual(row.descByPlatform["快手"], "快手专属简介");
  assert.strictEqual(row.descByPlatform["视频号"], "视频号专属简介");

  // 5b. 缺新列时回归原行为（返回空串 / 空对象，不影响老 xlsx）
  const legacyRows = normalizeBatchXlsxRows([
    {
      文件名: "old.mp4",
      标题: "老标题",
      简介: "老简介",
      标签: "t1",
      封面: "c.jpg",
    },
  ]);
  assert.strictEqual(legacyRows[0].coverPath, "c.jpg");
  assert.strictEqual(legacyRows[0].coverPathH, "");
  assert.deepStrictEqual(legacyRows[0].titleByPlatform, {});
  assert.deepStrictEqual(legacyRows[0].descByPlatform, {});

  console.log("✓ 5. xlsx 新列解析与别名（含缺列回归）通过");
}

/* ------------------------------------------------------------------ *
 * 6. GUI LocalVideoPublish.vue 编译、分平台覆盖、横封面、非阻断预检
 * ------------------------------------------------------------------ */
function testGuiLocalVideoPublish() {
  const lvpSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  const sfc = compiler.parseComponent(lvpSrc);
  assert.ok(sfc.template && sfc.template.content);
  const compiled = compiler.compile(sfc.template.content);
  assert.strictEqual(
    compiled.errors.length,
    0,
    `LocalVideoPublish.vue 模板编译报错: ${compiled.errors.join("; ")}`
  );

  const videoLink = bundle("src/shared/videoLink.js", "videoLink.cjs");
  const accountIdentity = bundle("src/shared/accountIdentity.js", "accountIdentity.cjs");

  const importedNames = [
    ...sfc.script.content.matchAll(
      /^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm
    ),
  ].flatMap((m) =>
    m[1]
      .replace(/[{}]/g, "")
      .split(",")
      .map((x) => x.trim().split(/\s+as\s+/).pop())
      .filter(Boolean)
  );
  const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
  const ctx = vm.createContext({
    ...stubs,
    ...videoLink,
    ...videoMetadata,
    ...platformRules,
    ...accountIdentity,
    ...textSanitize,
  });
  const script = sfc.script.content
    .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
    .replace("export default", "globalThis.component =");
  vm.runInContext(script, ctx);
  const comp = ctx.component;

  const state = {
    ...comp.data(),
    $set: (o, k, v) => {
      o[k] = v;
    },
    $delete: (o, k) => {
      delete o[k];
    },
    $message: { warning: () => {}, error: () => {}, info: () => {}, success: () => {} },
    $nextTick: () => {},
  };
  for (const [k, fn] of Object.entries(comp.methods)) {
    state[k] = fn.bind(state);
  }
  state.getPlatformStatement = () => "none";
  state.loadPublishThrottleDefaults = async () => "none";

  // 模板具备横版封面选择器与预检提示
  assert.ok(sfc.template.content.includes("横版封面(4:3)"));
  assert.ok(sfc.template.content.includes("将截断"));
  assert.ok(sfc.template.content.includes("分平台标题"));

  // 百家号提示文案反映新版无独立标题、作品描述首句共 ≤50 字
  const overrideList = comp.computed.platformTitleOverrideList.call(state);
  const bjhOverrideItem = overrideList.find((x) => x.pt === "百家号");
  assert.ok(bjhOverrideItem && bjhOverrideItem.hint.includes("50"));
  assert.ok(
    state.getPlatformTitleOverridePlaceholder("百家号").includes("50")
  );

  // 预检提示（非阻断）：标题 35 字 + 简介 20 字 + 5 个标签 → 抖音/百家号/小红书/快手均有预检项
  state.form.bt1 = "一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十多余字";
  state.form.description = "补充一段二十字以上的通用简介内容用来触发百家号预检";
  state.bqTags = ["甲", "乙", "丙", "丁", "戊"];
  const metaWarnings = comp.computed.metaRuleWarnings.call(state);
  assert.ok(metaWarnings.some((w) => w.platform === "抖音"));
  assert.ok(metaWarnings.some((w) => w.platform === "百家号"));
  assert.ok(metaWarnings.some((w) => w.platform === "快手"));

  // 为百家号设置较短覆盖标题（加上简介+标签总长 ≤50 字）后，百家号不再触发预检告警
  state.form.description = "简短补充";
  state.setPlatformTitleOverride("百家号", "百家号合规首句");
  const afterOverrideWarnings = comp.computed.metaRuleWarnings.call(state);
  assert.ok(!afterOverrideWarnings.some((w) => w.platform === "百家号"));

  // buildPlatformVideoPayload：百家号取覆盖标题作首句拼作品描述；抖音截断并携带 ruleAdjustments；空 coverPathH 不污染 publishOptions
  const baseVideo = state.buildVideoPayload();
  const bjhNode = { id: "n-bjh", pt: "百家号", phone: "13800138000", url: "https://bjh" };
  const dyNode = { id: "n-dy", pt: "抖音", phone: "13800138000", url: "https://dy" };
  const ksNode = { id: "n-ks", pt: "快手", phone: "13800138000", url: "https://ks" };

  const bjhPayload = state.buildPlatformVideoPayload(bjhNode, baseVideo);
  assert.strictEqual(bjhPayload.data.title, "百家号合规首句");
  assert.strictEqual(bjhPayload.data.description, "百家号合规首句，简短补充");
  assert.strictEqual(bjhPayload.data.ruleAdjustments, undefined);
  assert.strictEqual(bjhPayload.data.titleByPlatform, undefined);
  assert.ok(
    bjhPayload.data.platformRulesApplied &&
      bjhPayload.data.platformRulesApplied.platform === "百家号" &&
      bjhPayload.data.platformRulesApplied.combinedDescription ===
        "百家号合规首句，简短补充 #甲 #乙 #丙 #丁 #戊"
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(bjhPayload.publishOptions, "coverPathH"),
    false
  );

  const dyPayload = state.buildPlatformVideoPayload(dyNode, baseVideo);
  assert.ok(platformRules.countChars(dyPayload.data.title) <= 30);
  assert.ok(Array.isArray(dyPayload.data.ruleAdjustments));
  assert.ok(dyPayload.data.ruleAdjustments.some((a) => a.field === "title"));

  const ksPayload = state.buildPlatformVideoPayload(ksNode, baseVideo);
  assert.deepStrictEqual(ksPayload.data.tags, ["甲", "乙", "丙", "丁"]);
  assert.ok(ksPayload.data.ruleAdjustments.some((a) => a.field === "tags"));

  // 设了 coverPathH 时同步透传到 data 与 publishOptions
  state.form.coverPathH = "/tmp/my-h-cover.jpg";
  const dyWithH = state.buildPlatformVideoPayload(dyNode, state.buildVideoPayload());
  assert.strictEqual(dyWithH.data.coverPathH, "/tmp/my-h-cover.jpg");
  assert.strictEqual(dyWithH.publishOptions.coverPathH, "/tmp/my-h-cover.jpg");

  // S17 返修第 4 轮（Grok P3）：GUI openRepublish 恢复 descByPlatform（form & records 两种来源）
  const bjhDesc25 = "这场戏的看点是掌柜往豆腐缸里泼脏水，济公当众拆穿。";
  state.loadAccounts = () => {};
  state.openRepublish({
    filePath: "/tmp/济公J04-豆腐坊泼脏水-审看版-v1.mp4",
    form: {
      title: "济公J04-豆腐坊泼脏水-审看版-v1",
      bt1: "济公断案",
      description: "",
      tags: "民间故事",
      descByPlatform: { bjh: bjhDesc25 },
    },
    records: [],
    failedTargets: [],
  });
  assert.deepStrictEqual({ ...state.form.descByPlatform }, { 百家号: bjhDesc25 });
  const repubBaseFromForm = state.buildVideoPayload();
  assert.deepStrictEqual({ ...repubBaseFromForm.data.descByPlatform }, { 百家号: bjhDesc25 });
  const repubBjhPayload = state.buildPlatformVideoPayload(bjhNode, repubBaseFromForm);
  assert.strictEqual(repubBjhPayload.data.descOverrideApplied, true);
  assert.strictEqual(
    repubBjhPayload.data.platformRulesApplied.combinedDescription,
    `${bjhDesc25} #民间故事`
  );
  assert.strictEqual(repubBjhPayload.data.title, "济公断案");

  // 从历史 records 恢复 descByPlatform（无需 form 传映射）
  state.openRepublish({
    filePath: "/tmp/济公J04-豆腐坊泼脏水-审看版-v1.mp4",
    form: {
      title: "济公J04-豆腐坊泼脏水-审看版-v1",
      bt1: "济公断案",
      description: bjhDesc25,
      tags: "民间故事",
    },
    records: [
      {
        pt: "百家号",
        phone: "13800138000",
        descByPlatform: { 百家号: bjhDesc25 },
      },
    ],
    failedTargets: [],
  });
  assert.deepStrictEqual({ ...state.form.descByPlatform }, { 百家号: bjhDesc25 });

  console.log("✓ 6. GUI LocalVideoPublish.vue 模板编译、覆盖标题、横封面与预检提示通过");
}

/* ------------------------------------------------------------------ *
 * 7. 抖音 / 视频号横封面上传器（fake DOM：集中选择器 + 严格校验 + 诊断）
 * ------------------------------------------------------------------ */
class FakeEl {
  constructor(tag = "div", text = "", attrs = {}) {
    this.tagName = tag.toUpperCase();
    this._text = text;
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.disabled = false;
    this.rect = { left: 10, top: 10, width: 160, height: 120 };
    this.onClick = null;
    this.uploadedFiles = [];
    this.shadowRoot = null;
  }
  append(...kids) {
    for (const k of kids) {
      k.parentElement = this;
      this.children.push(k);
    }
    return this;
  }
  get className() {
    return String(this.attrs.class || "");
  }
  set className(v) {
    this.attrs.class = String(v || "");
  }
  get src() {
    return String(this.attrs.src || "");
  }
  set src(v) {
    this.attrs.src = String(v || "");
  }
  get accept() {
    return String(this.attrs.accept || "");
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  get innerText() {
    return this.textContent;
  }
  get outerHTML() {
    const attrStr = Object.entries(this.attrs)
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");
    return `<${this.tagName.toLowerCase()}${attrStr ? " " + attrStr : ""}>${this.textContent}</${this.tagName.toLowerCase()}>`;
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  getBoundingClientRect() {
    if (this.hidden) return { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
    return { x: this.rect.left, y: this.rect.top, ...this.rect };
  }
  scrollIntoView() {}
  closest(sel) {
    for (let n = this; n; n = n.parentElement) {
      if (n.matches && n.matches(sel)) return n;
    }
    return null;
  }
  matchesSingle(simple) {
    const s = simple.trim();
    if (!s || s === "*") return Boolean(s);
    let rest = s;
    const tagM = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagM) {
      if (this.tagName.toLowerCase() !== tagM[1].toLowerCase()) return false;
      rest = rest.slice(tagM[0].length);
    }
    for (const m of rest.matchAll(/\.([\w-]+)/g)) {
      const cls = String(this.attrs.class || "").split(/\s+/).filter(Boolean);
      if (!cls.includes(m[1])) return false;
    }
    rest = rest.replace(/\.[\w-]+/g, "");
    const attrRe = /\[([\w-]+)(?:([*^$]?)=["']?([^"'\]]*)["']?(?:\s+[iI])?)?\]/g;
    for (const m of rest.matchAll(attrRe)) {
      const rawVal = this.getAttribute(m[1]);
      const ci = /\s+[iI]\]$/.test(m[0]);
      const val = ci && rawVal != null ? String(rawVal).toLowerCase() : rawVal;
      const needle = ci && m[3] != null ? String(m[3]).toLowerCase() : m[3];
      if (m[2] === undefined && m[3] === undefined) {
        if (val === null) return false;
      } else if (m[2] === "") {
        if (val !== needle) return false;
      } else if (m[2] === "*") {
        if (!String(val || "").includes(needle)) return false;
      } else if (m[2] === "^") {
        if (!String(val || "").startsWith(needle)) return false;
      } else if (m[2] === "$") {
        if (!String(val || "").endsWith(needle)) return false;
      }
    }
    rest = rest.replace(attrRe, "");
    return rest.trim() === "";
  }
  matches(sel) {
    return String(sel || "")
      .split(",")
      .some((part) => {
        const tokens = part.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) return false;
        const check = (node, idx) => {
          if (!node || !node.matchesSingle(tokens[idx])) return false;
          if (idx === 0) return true;
          let p = node.parentElement;
          while (p) {
            if (check(p, idx - 1)) return true;
            p = p.parentElement;
          }
          return false;
        };
        return check(this, tokens.length - 1);
      });
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  click() {
    if (this.onClick) this.onClick();
  }
  async uploadFile(p) {
    this.uploadedFiles.push(p);
    if (this.onUpload) this.onUpload(p);
  }
  asElement() {
    return this;
  }
  async dispose() {}
}

function makeFakeCoverPage(doc) {
  const screenshots = [];
  return {
    screenshots,
    async evaluate(fn, ...args) {
      const prevDoc = global.document;
      const prevStyle = global.getComputedStyle;
      global.document = doc;
      global.getComputedStyle = (el) => ({
        display: el && el.hidden ? "none" : "block",
        visibility: "visible",
        opacity: "1",
      });
      try {
        return fn(...args);
      } finally {
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevStyle === undefined) delete global.getComputedStyle;
        else global.getComputedStyle = prevStyle;
      }
    },
    async evaluateHandle(fn, ...args) {
      return this.evaluate(fn, ...args);
    },
    async $(sel) {
      return doc.querySelector(sel);
    },
    async waitForSelector(sel) {
      const hit = doc.querySelector(sel);
      if (!hit || hit.hidden) throw new Error(`waitForSelector timeout: ${sel}`);
      return hit;
    },
    async waitForFunction(fn, _opts, ...args) {
      const ok = await this.evaluate(fn, ...args);
      if (!ok) throw new Error("waitForFunction timeout");
      return ok;
    },
    async waitForTimeout() {},
    async screenshot(opts) {
      screenshots.push(opts && opts.path);
    },
  };
}

async function testHorizontalCoverUploaders() {
  // 7a. 确认选择器集中导出
  assert.ok(dyMod.DY_HORIZONTAL_COVER_SELECTORS);
  assert.ok(Array.isArray(dyMod.DY_HORIZONTAL_COVER_SELECTORS.slotTextKeywords));
  assert.ok(Array.isArray(dyMod.DY_HORIZONTAL_COVER_SELECTORS.modalSelectors));
  assert.ok(sphMod.SPH_HORIZONTAL_COVER_SELECTORS);
  assert.ok(Array.isArray(sphMod.SPH_HORIZONTAL_COVER_SELECTORS.slotTextKeywords));
  assert.strictEqual(typeof sphMod.SPH_HORIZONTAL_COVER_SELECTORS.dialogSelector, "string");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-hcover-dom-"));
  const fakeImgFile = path.join(tmpDir, "h.jpg");
  fs.writeFileSync(fakeImgFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));

  try {
    // 7b. 抖音横封面上传成功（点击横封面槽位 → 打开弹窗 → 上传文件 → 点完成 → 弹窗关闭 + 槽位 img.src 变更）
    {
      const doc = new FakeEl("document");
      const body = new FakeEl("body");
      doc.body = body;
      doc.append(body);

      const slot = new FakeEl("div", "设置横封面 4:3", { class: "horizontal-cover-slot" });
      const slotImg = new FakeEl("img", "", { src: "https://old.example/frame.jpg" });
      slot.append(slotImg);
      body.append(slot);

      const modal = new FakeEl("div", "", { class: "semi-modal-wrap" });
      modal.hidden = true;
      const uploadTab = new FakeEl("div", "上传封面");
      const fileInput = new FakeEl("input", "", { type: "file", accept: "image/*" });
      const confirmBtn = new FakeEl("button", "完成", { class: "semi-button" });
      modal.append(uploadTab, fileInput, confirmBtn);
      body.append(modal);

      slot.onClick = () => {
        modal.hidden = false;
      };
      confirmBtn.onClick = () => {
        modal.hidden = true;
        slotImg.src = "https://cdn.example/new-h-cover.jpg";
      };

      const page = makeFakeCoverPage(doc);
      await dyMod.uploadDyHorizontalCover(page, fakeImgFile, {
        waitAfterUploadMs: 0,
        pollTimeoutMs: 20,
      });
      assert.strictEqual(fileInput.uploadedFiles[0], path.resolve(fakeImgFile));
      assert.strictEqual(slotImg.src, "https://cdn.example/new-h-cover.jpg");
    }

    // 7c. 抖音横封面上传失败（点击完成后槽位 img.src 未变化）→ 必须抛错并打诊断日志
    {
      const doc = new FakeEl("document");
      const body = new FakeEl("body");
      doc.body = body;
      doc.append(body);

      const slot = new FakeEl("div", "横封面 4:3", { class: "horizontal-cover-slot" });
      const slotImg = new FakeEl("img", "", { src: "https://old.example/same.jpg" });
      slot.append(slotImg);
      const modal = new FakeEl("div", "", { class: "semi-modal-wrap" });
      modal.hidden = true;
      const uploadTab = new FakeEl("div", "上传封面");
      const fileInput = new FakeEl("input", "", { type: "file", accept: "image/*" });
      const confirmBtn = new FakeEl("button", "完成");
      modal.append(uploadTab, fileInput, confirmBtn);
      body.append(slot, modal);
      slot.onClick = () => {
        modal.hidden = false;
      };
      confirmBtn.onClick = () => {
        modal.hidden = true;
        // 故意不改 slotImg.src
      };

      const page = makeFakeCoverPage(doc);
      const logs = [];
      const origWarn = console.warn;
      console.warn = (...a) => logs.push(a.join(" "));
      let caught = null;
      try {
        await dyMod.uploadDyHorizontalCover(page, fakeImgFile, {
          waitAfterUploadMs: 0,
          pollTimeoutMs: 20,
        });
      } catch (e) {
        caught = e;
      } finally {
        console.warn = origWarn;
      }
      assert.ok(caught, "抖音横封面 src 未变化必须抛错中止发布");
      assert.ok(caught.message.includes("已中止"), caught.message);
      assert.ok(logs.some((l) => l.includes("[dy][cover-h][diag]")));
    }

    // 7d. 视频号横封面上传成功（wujie-app.wujie_iframe.shadowRoot 内）
    {
      const doc = new FakeEl("document");
      const body = new FakeEl("body");
      doc.body = body;
      doc.append(body);

      const wujie = new FakeEl("wujie-app", "", { class: "wujie_iframe" });
      const shadow = new FakeEl("shadow-root");
      wujie.shadowRoot = shadow;
      body.append(wujie);

      const slot = new FakeEl("div", "横版封面 4:3", { class: "horizon-cover-wrap" });
      const slotImg = new FakeEl("img", "", { src: "https://sph.old/1.jpg" });
      slot.append(slotImg);
      shadow.append(slot);

      const dialog = new FakeEl("div", "编辑封面", { class: "weui-desktop-dialog" });
      dialog.hidden = true;
      const uploadTab = new FakeEl("span", "上传封面");
      const fileInput = new FakeEl("input", "", { type: "file", accept: "image/*" });
      const okBtn = new FakeEl("button", "确认");
      dialog.append(uploadTab, fileInput, okBtn);
      shadow.append(dialog);

      slot.onClick = () => {
        dialog.hidden = false;
      };
      okBtn.onClick = () => {
        dialog.hidden = true;
        slotImg.src = "https://sph.new/h-cover.jpg";
      };

      const page = makeFakeCoverPage(doc);
      await sphMod.uploadSphHorizontalCover(page, fakeImgFile, {
        waitAfterUploadMs: 0,
        pollTimeoutMs: 20,
      });
      assert.strictEqual(fileInput.uploadedFiles[0], path.resolve(fakeImgFile));
      assert.strictEqual(slotImg.src, "https://sph.new/h-cover.jpg");
    }

    // 7e. 视频号横封面槽位缺失 → 抛错并输出诊断日志
    {
      const doc = new FakeEl("document");
      const body = new FakeEl("body");
      doc.body = body;
      doc.append(body);
      const wujie = new FakeEl("wujie-app", "", { class: "wujie_iframe" });
      wujie.shadowRoot = new FakeEl("shadow-root");
      body.append(wujie);

      const page = makeFakeCoverPage(doc);
      const logs = [];
      const origWarn = console.warn;
      console.warn = (...a) => logs.push(a.join(" "));
      let caught = null;
      try {
        await sphMod.uploadSphHorizontalCover(page, fakeImgFile, {
          waitAfterUploadMs: 0,
          pollTimeoutMs: 20,
        });
      } catch (e) {
        caught = e;
      } finally {
        console.warn = origWarn;
      }
      assert.ok(caught, "视频号横封面槽位缺失必须抛错中止发布");
      assert.ok(caught.message.includes("已中止"), caught.message);
      assert.ok(logs.some((l) => l.includes("[sph][cover-h][diag]")));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("✓ 7. 抖音 & 视频号横封面上传器（集中选择器/严格校验/诊断）通过");
}

/* ------------------------------------------------------------------ *
 * 8. publishVideo.js & MCP publish.ts 集成回归验证
 * ------------------------------------------------------------------ */
async function testPublishVideoAndMcpIntegration() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s17-int-"));
  const videoFile = path.join(tmpDir, "demo.mp4");
  const coverHFile = path.join(tmpDir, "cover-h.jpg");
  fs.writeFileSync(videoFile, Buffer.from("fake-mp4"));
  fs.writeFileSync(coverHFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  const publishVideoOut = path.join(outDir, "publishVideo.cjs");
  await build({
    entryPoints: [path.join(root, "src/main/services/publishVideo.js")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: publishVideoOut,
    packages: "external",
    plugins: [
      {
        name: "stub-puppeteer-file",
        setup(buildApi) {
          buildApi.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({
            path: "mock-puppeteer-file",
            external: true,
          }));
        },
      },
    ],
  });

  let lastTaskPayload = null;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: {
          getPath: () => tmpDir,
        },
      };
    }
    if (request === "mock-puppeteer-file") {
      return {
        registerPublishDedupeBypass: () => {},
        runPuppeteerTask: (payload, transport) => {
          lastTaskPayload = payload;
          setImmediate(() => {
            transport.reply("puppeteerFile-done", {
              taskId: payload.taskId,
              status: true,
              message: "上传成功",
            });
          });
        },
      };
    }
    return origLoad.apply(this, arguments);
  };

  let publishVideoMod;
  try {
    delete require.cache[publishVideoOut];
    publishVideoMod = require(publishVideoOut);

    // 8a. 触发标题截断 + 快手标签裁剪 + coverPathH：回执带 ruleAdjustments
    const resKs = await publishVideoMod.runSingleFilePublish({
      platform: "快手",
      phone: "13800138000",
      partition: "persist:13800138000快手",
      file: videoFile,
      title: "快手通用标题",
      description: "快手通用简介",
      descByPlatform: { ks: "快手专属覆盖简介" },
      tags: ["一", "二", "三", "四", "五", "六"],
      coverPathH: coverHFile,
      noThrottle: true,
      allowDuplicate: true,
    });
    assert.strictEqual(resKs.status, "success");
    assert.strictEqual(resKs.exitCode, 0);
    assert.ok(Array.isArray(resKs.ruleAdjustments));
    assert.strictEqual(resKs.ruleAdjustments.length, 1);
    assert.strictEqual(resKs.ruleAdjustments[0].field, "tags");
    assert.ok(resKs.ruleAdjustmentsSummary.includes("6→4"));
    assert.ok(resKs.message.includes("规则调整"));
    assert.deepStrictEqual(lastTaskPayload.data.tags, ["一", "二", "三", "四"]);
    assert.strictEqual(lastTaskPayload.data.description, "快手专属覆盖简介");
    assert.strictEqual(lastTaskPayload.data.coverPathH, coverHFile);
    assert.ok(
      lastTaskPayload.data.platformRulesApplied &&
        lastTaskPayload.data.platformRulesApplied.platform === "快手"
    );

    // 8b. 缺字段且未超限 → 回归原行为（回执干净，无 ruleAdjustments，message === "上传成功"）
    const resPlain = await publishVideoMod.runSingleFilePublish({
      platform: "抖音",
      phone: "13800138000",
      partition: "persist:13800138000抖音",
      file: videoFile,
      title: "短标题",
      description: "短简介",
      tags: ["一", "二"],
      noThrottle: true,
      allowDuplicate: true,
    });
    assert.strictEqual(resPlain.status, "success");
    assert.strictEqual(resPlain.exitCode, 0);
    assert.strictEqual(resPlain.message, "上传成功");
    assert.strictEqual(resPlain.ruleAdjustments, undefined);
    assert.strictEqual(resPlain.ruleAdjustmentsSummary, undefined);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(lastTaskPayload.publishOptions || {}, "coverPathH"),
      false
    );
    // 8b-2. 百家号新版 50 字作品描述走 publishVideo.js 端到端透传 snapshot 与 ruleAdjustments
    const resBjh = await publishVideoMod.runSingleFilePublish({
      platform: "百家号",
      phone: "13800138000",
      partition: "persist:13800138000百家号",
      file: videoFile,
      title: "济公断豆腐坊泼脏水",
      description:
        "黑心掌柜半夜往豆腐缸里泼脏水，结果被济公一眼识破当众拆穿真相，街坊邻居全都拍手叫好，掌柜灰溜溜逃跑",
      tags: ["济公", "民间故事"],
      noThrottle: true,
      allowDuplicate: true,
    });
    assert.strictEqual(resBjh.status, "success");
    assert.strictEqual(resBjh.exitCode, 0);
    assert.ok(Array.isArray(resBjh.ruleAdjustments) && resBjh.ruleAdjustments.length > 0);
    assert.ok(
      lastTaskPayload.data.platformRulesApplied &&
        lastTaskPayload.data.platformRulesApplied.platform === "百家号" &&
        platformRules.countChars(
          lastTaskPayload.data.platformRulesApplied.combinedDescription
        ) <= 50
    );
    assert.ok(
      lastTaskPayload.data.platformRulesApplied.combinedDescription.startsWith(
        "济公断豆腐坊泼脏水"
      )
    );
  } finally {
    Module._load = origLoad;
  }

  // 8c. MCP publish.ts schema 与 CLI 参数转发
  const mcpPublishOut = path.join(outDir, "mcp-publish.cjs");
  buildSync({
    entryPoints: [path.join(root, "mcp/src/tools/publish.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: mcpPublishOut,
  });
  delete require.cache[mcpPublishOut];
  const { publishVideoTool, handlePublishVideo } = require(mcpPublishOut);
  const props = publishVideoTool.inputSchema.properties;
  assert.ok(props.coverPathH, "MCP publish_video 缺少 coverPathH");
  assert.ok(props.titleByPlatform, "MCP publish_video 缺少 titleByPlatform");
  assert.ok(props.descByPlatform, "MCP publish_video 缺少 descByPlatform");

  const argvFile = path.join(tmpDir, "mcp-argv.json");
  const fakeBin = path.join(tmpDir, "fake-mm.js");
  fs.writeFileSync(
    fakeBin,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({
  success: true,
  status: "success",
  exitCode: 0,
  message: "上传成功（规则调整：[抖音] 标题截断）",
  ruleAdjustments: [{ platform: "抖音", field: "title", originalLength: 35, finalLength: 28 }],
  ruleAdjustmentsSummary: "[抖音] 标题截断"
}));
process.exit(0);
`,
    { mode: 0o755 }
  );

  const origBin = process.env.MATRIXMEDIA_BIN;
  process.env.MATRIXMEDIA_BIN = fakeBin;
  try {
    const rawResp = await handlePublishVideo({
      platform: "dy",
      phone: "13800138000",
      file: videoFile,
      title: "通用标题",
      coverPathH: coverHFile,
      titleByPlatform: { dy: "抖音标题" },
      descByPlatform: { dy: "抖音简介" },
    });
    const resp = JSON.parse(rawResp);
    assert.strictEqual(resp.status, "success");
    assert.ok(Array.isArray(resp.ruleAdjustments));
    assert.strictEqual(resp.ruleAdjustmentsSummary, "[抖音] 标题截断");
    const forwardedArgv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
    assert.ok(forwardedArgv.includes("--cover-h"));
    assert.ok(forwardedArgv.includes(coverHFile));
    assert.ok(forwardedArgv.includes("--title-by-platform"));
    assert.ok(forwardedArgv.includes(JSON.stringify({ dy: "抖音标题" })));
    assert.ok(forwardedArgv.includes("--desc-by-platform"));
    assert.ok(forwardedArgv.includes(JSON.stringify({ dy: "抖音简介" })));
  } finally {
    if (origBin === undefined) delete process.env.MATRIXMEDIA_BIN;
    else process.env.MATRIXMEDIA_BIN = origBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("✓ 8. publishVideo.js & MCP publish.ts 集成回归通过");
}

(async () => {
  testRuleTable();
  testTruncationRules();
  testApplyPlatformRulesFull();
  testS17ReworkCases();
  testCliAndHttpArgs();
  testXlsxColumns();
  testGuiLocalVideoPublish();
  await testHorizontalCoverUploaders();
  await testPublishVideoAndMcpIntegration();
  console.log("\ntest-platform-rules: 全部断言通过");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
