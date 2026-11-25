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
  assert.strictEqual(PLATFORM_RULES["百家号"].titleMax, 20);
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
  const bjhPunct = applyPlatformPublishRules("百家号", {
    title: "通用短标题",
    titleByPlatform: {
      bjh: "百家号专属深度解读攻略，超过二十个字也要按标点截断",
    },
  });
  assert.strictEqual(bjhPunct.adjusted, true);
  assert.strictEqual(bjhPunct.title, "百家号专属深度解读攻略");
  assert.strictEqual(countChars(bjhPunct.title), 11);
  assert.strictEqual(bjhPunct.adjustments[0].platform, "百家号");
  assert.strictEqual(bjhPunct.adjustments[0].field, "title");
  assert.strictEqual(bjhPunct.adjustments[0].originalLength, 25);
  assert.strictEqual(bjhPunct.adjustments[0].finalLength, 11);
  assert.ok(bjhPunct.adjustments[0].message.includes("25→11"));

  // 3a-2. 覆盖值超长且标点前 < 一半 → 硬截到 20
  const bjhHard = applyPlatformPublishRules("百家号", {
    title: "通用短标题",
    titleByPlatform: {
      百家号: "百家号标题，后面连续二十五个汉字没有任何标点符号所以硬截",
    },
  });
  assert.strictEqual(bjhHard.adjusted, true);
  assert.strictEqual(countChars(bjhHard.title), 20);

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

  // 预检提示（非阻断）：标题 35 字 + 5 个标签 → 抖音/百家号/小红书/快手均有预检项
  state.form.bt1 = "一二三四五六七八九十，一二三四五六七八九十，一二三四五六七八九十多余字";
  state.bqTags = ["甲", "乙", "丙", "丁", "戊"];
  const metaWarnings = comp.computed.metaRuleWarnings.call(state);
  assert.ok(metaWarnings.some((w) => w.platform === "抖音"));
  assert.ok(metaWarnings.some((w) => w.platform === "百家号"));
  assert.ok(metaWarnings.some((w) => w.platform === "快手"));

  // 为百家号设置合规覆盖标题（≤20 字）后，百家号不再触发预检告警
  state.setPlatformTitleOverride("百家号", "百家号合规短标题");
  const afterOverrideWarnings = comp.computed.metaRuleWarnings.call(state);
  assert.ok(!afterOverrideWarnings.some((w) => w.platform === "百家号"));

  // buildPlatformVideoPayload：百家号取覆盖标题；抖音截断并携带 ruleAdjustments；空 coverPathH 不污染 publishOptions
  const baseVideo = state.buildVideoPayload();
  const bjhNode = { id: "n-bjh", pt: "百家号", phone: "13800138000", url: "https://bjh" };
  const dyNode = { id: "n-dy", pt: "抖音", phone: "13800138000", url: "https://dy" };
  const ksNode = { id: "n-ks", pt: "快手", phone: "13800138000", url: "https://ks" };

  const bjhPayload = state.buildPlatformVideoPayload(bjhNode, baseVideo);
  assert.strictEqual(bjhPayload.data.title, "百家号合规短标题");
  assert.strictEqual(bjhPayload.data.ruleAdjustments, undefined);
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
