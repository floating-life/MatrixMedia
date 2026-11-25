"use strict";

/**
 * S17 返修第 2 轮单测：百家号新版只有「作品描述」（上限 50 字）
 *
 * 覆盖：
 * 1. 作品描述组装（platformRules + videoMetadata）：
 *    - 规则表 descMax=50 / titleMax=null / hasSeparateTitle=false
 *    - 覆盖优先（descByPlatform.bjh 优先且不拼标题；titleByPlatform.bjh 作为描述首句）
 *    - 标题完整保留 + 50 字标点截断（含标题以标点结尾不被裁、标题自身超 50 只截标题）
 *    - 话题在 50 字内放得下才保留、放不下丢话题（按 S17 修正后的内联话题识别）
 *    - emoji 按 Array.from 计数与安全截断（不拆碎 UTF-16 代理对）
 *    - 全场景严格幂等 + publishVideo / platformRulesApplied 快照端到端一致
 * 2. 完全相等校验（bjhDescOk / normBjhDesc）：
 *    - 完全一致 / 零宽字符 / 多空白归一通过
 *    - 文件名残留、纯文件名、重复叠加、前缀包含、多余后缀、空串一律判失败
 * 3. 可靠清空写入 + 气泡关闭 + 终检 + 诊断日志 + 确定性失败不可重试（noRetry=true）：
 *    - 智能文案蓝色气泡自动点 × 关闭，无气泡时静默跳过
 *    - DOM Range selectNodeContents + execCommand('delete'/'insertText') 清空预填文件名并写入
 *    - delete 失效时：仅焦点在编辑器内才补发 Ctrl/Cmd+A + Backspace；焦点在外绝不误发
 *    - ensureBjhDescription 终检：异步回填文件名后清空覆盖，绝不在旧文本前叠加
 *    - 确定性失败：3 次校验仍不等即中止（不点发布），抛出 noRetry+bjhDeterministic，
 *      完整 handler 通过 replyPublishFailure 上报 { status:false, noRetry:true }，外层不触发 5 次重试；
 *      点击发布后出现失败提示仍保持 bjhClickDispatched → noRetry:true。
 */

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { buildSync } = require("esbuild");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "test/.cache/bjh-desc");
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
const bjhMod = bundle("src/main/services/upLoad/bjh.js", "bjh.cjs");

const {
  PLATFORM_RULES,
  applyPlatformPublishRules,
  createAppliedRuleSnapshot,
  countChars,
} = platformRules;

/* ------------------------------------------------------------------ *
 * 1. 作品描述组装：覆盖优先、标题完整、50 截断、话题放不下丢话题、emoji 计数、幂等
 * ------------------------------------------------------------------ */
function testBjhDescriptionAssembly() {
  // 1a. 规则表
  const bjhRule = PLATFORM_RULES["百家号"];
  assert.strictEqual(bjhRule.titleMax, null);
  assert.strictEqual(bjhRule.descMax, 50);
  assert.strictEqual(bjhRule.tagMax, null);
  assert.strictEqual(bjhRule.hasSeparateTitle, false);
  assert.strictEqual(bjhRule.usesCombinedDescription, true);
  assert.strictEqual(bjhRule.combinesTitleIntoDescription, true);
  assert.strictEqual(bjhRule.tagsInDescriptionBudget, true);

  // 1b. 覆盖优先：「百家号简介」覆盖直接生效，不拼通用标题或「百家号标题」覆盖
  {
    const r = applyPlatformPublishRules("百家号", {
      title: "通用标题不该出现",
      titleByPlatform: { bjh: "百家号标题也不该拼进去" },
      description: "通用简介不该出现",
      descByPlatform: { bjh: "百家号专属作品描述，全程高能反转" },
      tags: ["济公"],
    });
    assert.strictEqual(r.adjusted, false);
    assert.strictEqual(r.combinedDescription, "百家号专属作品描述，全程高能反转 #济公");
    assert.ok(!r.combinedDescription.includes("通用标题"));
    assert.ok(!r.combinedDescription.includes("百家号标题"));
    // 幂等
    const r2 = applyPlatformPublishRules("百家号", r);
    assert.strictEqual(r2.adjusted, false);
    assert.strictEqual(r2.combinedDescription, r.combinedDescription);
    assert.deepStrictEqual(r2.tags, r.tags);

    // 覆盖简介本身接近 50 字 + 放不下的通用标签 → 覆盖简介完整保留，丢标签
    const ov46 = "这是一段刚好四十六个字的百家号专属简介覆盖内容用来测试覆盖优先并且不会被通用标签挤掉或截断";
    assert.strictEqual(countChars(ov46), 45);
    const rKeepOv = applyPlatformPublishRules("百家号", {
      title: "通用标题",
      descByPlatform: { 百家号: ov46 },
      tags: ["民间故事"],
    });
    assert.strictEqual(rKeepOv.adjusted, true);
    assert.strictEqual(rKeepOv.combinedDescription, ov46);
    assert.deepStrictEqual(rKeepOv.tags, []);
    assert.ok(rKeepOv.adjustments.some((a) => a.field === "tags"));

    // 覆盖简介本身超 50 字 → 按标点截断 ≤ 50
    const ovLong =
      "这是超过五十个字的百家号专属作品描述第一句写得很长很长很长很长，后面多余的这一段内容超过五十上限会被截掉";
    assert.ok(countChars(ovLong) > 50);
    const rOvLong = applyPlatformPublishRules("百家号", {
      title: "通用标题",
      descByPlatform: { bjh: ovLong },
    });
    assert.strictEqual(rOvLong.adjusted, true);
    assert.strictEqual(
      rOvLong.combinedDescription,
      "这是超过五十个字的百家号专属作品描述第一句写得很长很长很长很长"
    );
    assert.ok(countChars(rOvLong.combinedDescription) <= 50);
    const rOvLong2 = applyPlatformPublishRules("百家号", rOvLong);
    assert.strictEqual(rOvLong2.adjusted, false);
    assert.strictEqual(rOvLong2.combinedDescription, rOvLong.combinedDescription);
  }

  // 1c. 未填「百家号简介」覆盖：百家号标题（覆盖或通用）+ 「，」 + 通用简介正文
  {
    const r = applyPlatformPublishRules("百家号", {
      title: "通用标题",
      titleByPlatform: { bjh: "济公断豆腐坊泼脏水" },
      description: "黑心掌柜往豆腐缸泼脏水，济公当众拆穿",
      tags: ["济公", "民间故事"],
    });
    assert.strictEqual(r.adjusted, false);
    assert.strictEqual(
      r.combinedDescription,
      "济公断豆腐坊泼脏水，黑心掌柜往豆腐缸泼脏水，济公当众拆穿 #济公 #民间故事"
    );
    assert.ok(countChars(r.combinedDescription) <= 50);

    // 标题末尾已有标点（！）不重复加「，」
    const rPunctEnd = applyPlatformPublishRules("百家号", {
      title: "济公当众拆穿黑心掌柜！",
      description: "街坊邻居拍手叫好",
    });
    assert.strictEqual(rPunctEnd.combinedDescription, "济公当众拆穿黑心掌柜！街坊邻居拍手叫好");
    assert.ok(!rPunctEnd.combinedDescription.includes("！，"));
  }

  // 1d. 标题必须完整保留 + 50 字标点截断
  {
    const title = "济公断豆腐坊泼脏水";
    const longDesc =
      "黑心掌柜半夜往豆腐缸里泼脏水，结果被济公一眼识破当众拆穿真相，后面还有一大段很长很长的话超出五十限制";
    const r = applyPlatformPublishRules("百家号", {
      title,
      description: longDesc,
      tags: ["济公", "民间故事"],
    });
    assert.strictEqual(r.adjusted, true);
    assert.ok(r.combinedDescription.startsWith(title), "标题必须完整保留在开头");
    assert.ok(
      countChars(r.combinedDescription) <= 50,
      `总长应 <= 50，实际 ${countChars(r.combinedDescription)}`
    );
    // 截断后正文落在标点处（40 字），剩余 9 字空间可放下 #济公(3) + #民间故事(5) = 9 字；
    // 若标题+正文占 42 字，剩余 7 字只能放下 #济公(3)，放不下 #民间故事(5)
    assert.strictEqual(
      r.bodyDescription,
      "济公断豆腐坊泼脏水，黑心掌柜半夜往豆腐缸里泼脏水，结果被济公一眼识破当众拆穿真相"
    );

    const rDropSecondTag = applyPlatformPublishRules("百家号", {
      title: "济公断豆腐坊泼脏水",
      description:
        "黑心掌柜半夜偷偷往豆腐缸里泼脏水，结果被济公一眼识破当众拆穿真相，后面还有一大段很长的话超五十上限",
      tags: ["济公", "民间故事"],
    });
    assert.strictEqual(rDropSecondTag.adjusted, true);
    assert.ok(rDropSecondTag.combinedDescription.startsWith("济公断豆腐坊泼脏水"));
    assert.ok(countChars(rDropSecondTag.combinedDescription) <= 50);
    assert.deepStrictEqual(rDropSecondTag.tags, ["济公"]);
    assert.ok(rDropSecondTag.combinedDescription.endsWith(" #济公"));
    assert.ok(!rDropSecondTag.combinedDescription.includes("#民间故事"));

    // 标题 32 字且以「！」结尾 + 无标点正文超 50 → 绝不能裁掉标题末尾的「！」
    const longTitleBang = "这是一段三十二个字的完整标题并且以感叹号结尾必须一字不差保留！";
    assert.strictEqual(countChars(longTitleBang), 31);
    const rKeepBang = applyPlatformPublishRules("百家号", {
      title: longTitleBang,
      description: "后面是没有标点符号的三十个字正文内容测试不会误裁标题末尾的感叹号",
    });
    assert.strictEqual(rKeepBang.adjusted, true);
    assert.ok(
      rKeepBang.combinedDescription.startsWith(longTitleBang),
      `标题(含末尾！)必须完整保留，实际: ${rKeepBang.combinedDescription}`
    );
    assert.ok(countChars(rKeepBang.combinedDescription) <= 50);

    // 标题 46 字 + 短正文 → 完整保留 46 字标题，舍弃放不下的正文
    const title46 = "甲".repeat(46);
    const r46 = applyPlatformPublishRules("百家号", {
      title: title46,
      description: "补充正文超五十字",
    });
    assert.strictEqual(r46.adjusted, true);
    assert.strictEqual(r46.combinedDescription, title46);
  }

  // 1e. 标题自身超 50 → 只截标题（不拼通用简介正文，不加省略号）
  {
    const titleOver50Punct =
      "济公在豆腐坊当众拆穿黑心掌柜往豆腐缸泼脏水的全过程，街坊邻居拍手叫好，后面这段超过五十字应该被标点截断";
    const r1 = applyPlatformPublishRules("百家号", {
      title: titleOver50Punct,
      description: "这段通用简介绝不应该拼进去",
      tags: ["济公", "放不下的超长话题标签名称测试超过剩余预算"],
    });
    assert.strictEqual(r1.adjusted, true);
    assert.strictEqual(
      r1.bodyDescription,
      "济公在豆腐坊当众拆穿黑心掌柜往豆腐缸泼脏水的全过程，街坊邻居拍手叫好"
    );
    assert.ok(!r1.combinedDescription.includes("这段通用简介"));
    assert.ok(!r1.combinedDescription.includes("…"));
    assert.ok(r1.combinedDescription.includes("#济公"));
    assert.ok(!r1.combinedDescription.includes("放不下的超长话题"));
    assert.ok(countChars(r1.combinedDescription) <= 50);

    // 无标点超 50 标题 → 硬截到 50，剩余 0，话题全丢
    const titleOver50Hard = "测".repeat(60);
    const r2 = applyPlatformPublishRules("百家号", {
      title: titleOver50Hard,
      description: "通用简介",
      tags: ["济公"],
    });
    assert.strictEqual(r2.combinedDescription, "测".repeat(50));
    assert.deepStrictEqual(r2.tags, []);
  }

  // 1f. 话题识别（按 S17 修正后的规则）& 放不下丢话题
  {
    // 逗号紧邻内联话题 + 连写话题 + 外部话题：
    // 1) naturalBody(49字) 已放下内联 #济公#民间故事，剩余 0 字 → 保留内联话题，丢外部 #历史 与超长话题
    const rInlineFit = applyPlatformPublishRules("百家号", {
      title: "济公探案",
      description: "黑心掌柜半夜偷偷往豆腐缸里泼脏水，结果当众被拆穿真相，百姓全都拍手叫好。#济公#民间故事",
      tags: ["历史", "超长放不下的话题标签"],
    });
    assert.strictEqual(rInlineFit.adjusted, true);
    assert.strictEqual(countChars(rInlineFit.combinedDescription), 49);
    assert.ok(rInlineFit.combinedDescription.includes("#济公#民间故事"));
    assert.ok(!rInlineFit.combinedDescription.includes("#历史"));
    assert.deepStrictEqual(rInlineFit.tags, ["济公", "民间故事"]);

    // 2) naturalBody(52字) 超 50 → 按 S17 拆出连写话题，正文(41字)保留，剩 8 字放下 #济公(3)+#历史(3)=7，丢 #民间传说故事(7) 与超长话题
    const rInlineDrop = applyPlatformPublishRules("百家号", {
      title: "济公探案",
      description: "黑心掌柜半夜偷偷往豆腐缸里泼脏水，结果当众被拆穿真相，百姓全都拍手叫好。#济公#民间传说故事",
      tags: ["历史", "超长放不下的话题标签"],
    });
    assert.strictEqual(rInlineDrop.adjusted, true);
    assert.ok(countChars(rInlineDrop.combinedDescription) <= 50);
    assert.ok(rInlineDrop.combinedDescription.includes("济公探案"));
    assert.ok(rInlineDrop.combinedDescription.includes("黑心掌柜半夜偷偷往豆腐缸里泼脏水"));
    assert.ok(rInlineDrop.combinedDescription.includes("#济公"));
    assert.ok(rInlineDrop.combinedDescription.includes("#历史"));
    assert.ok(!rInlineDrop.combinedDescription.includes("#民间传说故事"));
    assert.ok(!rInlineDrop.combinedDescription.includes("#超长放不下的话题标签"));

    // 开头逗号内联话题（#减脂，正文）超 50 字时：按 S17 识别出 #减脂，绝不把逗号后正文当话题，且正文保留
    const rStartTag = applyPlatformPublishRules("百家号", {
      title: "在家减脂",
      description:
        "#减脂，每天十分钟无器械深蹲训练计划，动作简单易学新手友好，坚持打卡有惊喜还有更多训练技巧分享给大家",
      tags: ["健身"],
    });
    assert.strictEqual(rStartTag.adjusted, true);
    assert.ok(countChars(rStartTag.combinedDescription) <= 50);
    assert.ok(rStartTag.bodyDescription.startsWith("在家减脂，每天十分钟"));
    assert.ok(!rStartTag.combinedDescription.includes("#每天十分钟"));
    assert.ok(rStartTag.combinedDescription.includes("#减脂"));
    // 幂等验证
    const rStartTag2 = applyPlatformPublishRules("百家号", rStartTag);
    assert.strictEqual(rStartTag2.adjusted, false);
    assert.strictEqual(rStartTag2.combinedDescription, rStartTag.combinedDescription);
  }

  // 1g. Emoji 计数（Array.from）：UTF-16 代理对计 1，不拆碎代理对
  {
    // 20 个 emoji 标题（UTF-16 长度 40，Array.from 长度 20 < 25）+ 35 个无标点 emoji 正文 → 硬截到 50 码点，不拆碎代理对，放不下话题
    const emojiTitle20 = "🔥".repeat(20);
    const emojiBody35 = "🎉".repeat(35);
    const rEmojiHard = applyPlatformPublishRules("百家号", {
      title: emojiTitle20,
      description: emojiBody35,
      tags: ["热"],
    });
    assert.strictEqual(rEmojiHard.adjusted, true);
    assert.strictEqual(countChars(rEmojiHard.combinedDescription), 50);
    assert.strictEqual(
      rEmojiHard.combinedDescription,
      `${emojiTitle20}，${"🎉".repeat(29)}`
    );
    assert.deepStrictEqual(rEmojiHard.tags, []);
    assert.ok(
      !/[\uD800-\uDFFF]/.test(
        rEmojiHard.combinedDescription.replace(/🔥|🎉/g, "")
      ),
      "截断后不能出现孤立 UTF-16 代理对"
    );

    // 25 个 emoji 标题（25 >= 50/2）+ 无标点长正文 → 标点截断在「，」保留完整 25 emoji 标题，剩余空间放下 #热
    const emojiTitle25 = "🔥".repeat(25); // UTF-16 length=50, countChars=25
    const rEmojiPunct = applyPlatformPublishRules("百家号", {
      title: emojiTitle25,
      description: "🎉".repeat(30),
      tags: ["热"],
    });
    assert.strictEqual(rEmojiPunct.adjusted, true);
    assert.strictEqual(rEmojiPunct.combinedDescription, `${emojiTitle25} #热`);
    assert.strictEqual(countChars(rEmojiPunct.combinedDescription), 28);
    assert.deepStrictEqual(rEmojiPunct.tags, ["热"]);

    const emojiOver50 = "🚀".repeat(55);
    const rEmojiOver = applyPlatformPublishRules("百家号", {
      title: emojiOver50,
    });
    assert.strictEqual(countChars(rEmojiOver.combinedDescription), 50);
    assert.strictEqual(rEmojiOver.combinedDescription, "🚀".repeat(50));
  }

  // 1h. videoMetadata + platformRulesApplied 快照端到端一致
  {
    const r1 = applyPlatformPublishRules("百家号", {
      title: "济公断豆腐坊泼脏水",
      description: "黑心掌柜往豆腐缸泼脏水，济公当众拆穿",
      tags: ["济公", "民间故事"],
    });
    const viaSnap = videoMetadata.buildPlatformVideoTextDetailed("百家号", {
      title: r1.title,
      description: r1.bodyDescription,
      tags: r1.tags,
      platformRulesApplied: createAppliedRuleSnapshot(r1),
    });
    assert.strictEqual(viaSnap.description, r1.combinedDescription);
    assert.strictEqual(viaSnap.ksFillText, r1.combinedDescription);
    assert.strictEqual(viaSnap.adjusted, false);

    // 无快照二次调用（模拟定时发布回放）结果完全相同
    const noSnap = videoMetadata.buildPlatformVideoTextDetailed("百家号", {
      title: r1.title,
      description: r1.bodyDescription,
      tags: r1.tags,
    });
    assert.strictEqual(noSnap.description, r1.combinedDescription);
    assert.strictEqual(noSnap.adjusted, false);
  }

  console.log("✓ 1. 百家号 50 字作品描述组装（覆盖/标题完整/截断/丢话题/emoji/幂等）通过");
}

/* ------------------------------------------------------------------ *
 * 2. 完全相等校验（bjhDescOk / normBjhDesc）
 * ------------------------------------------------------------------ */
function testBjhExactEquality() {
  const { bjhDescOk, normBjhDesc } = bjhMod;
  const want = "济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公";

  // 完全一致 & 空白/零宽归一一致
  assert.strictEqual(bjhDescOk(want, want), true);
  assert.strictEqual(
    bjhDescOk("  济公断豆腐坊泼脏水，黑心掌柜当众被拆穿\u200B\u00A0 #济公  ", want),
    true
  );
  assert.strictEqual(normBjhDesc("a\u200B\uFEFF  b\nc"), "a b c");

  // 文件名残留 → 必须判失败
  assert.strictEqual(
    bjhDescOk(
      "济公断豆腐坊泼脏水济公J04-豆腐坊泼脏水-审看版-v1",
      "济公断豆腐坊泼脏水"
    ),
    false,
    "标题+文件名残留必须判失败"
  );
  assert.strictEqual(
    bjhDescOk("济公J04-豆腐坊泼脏水-审看版-v1", "济公断豆腐坊泼脏水"),
    false,
    "纯文件名未清空必须判失败"
  );

  // 重复叠加（真机 2026-11-25 故障现象）→ 必须判失败
  assert.strictEqual(
    bjhDescOk(
      "济公断豆腐坊泼脏水济公断豆腐坊泼脏水济公断豆腐坊泼脏水",
      "济公断豆腐坊泼脏水"
    ),
    false,
    "重复叠加必须判失败"
  );
  assert.strictEqual(
    bjhDescOk(
      "济公断豆腐坊泼脏水济公断豆腐坊泼脏水济公J04-豆腐坊泼脏水-审看版-v1",
      "济公断豆腐坊泼脏水"
    ),
    false,
    "重复叠加+文件名必须判失败"
  );

  // 旧逻辑「前缀/包含」放行情况 → 现在必须判失败
  assert.strictEqual(
    bjhDescOk("济公断豆腐坊泼脏水", want),
    false,
    "仅匹配前缀（缺后半段）必须判失败"
  );
  assert.strictEqual(
    bjhDescOk(`${want} 多余字符`, want),
    false,
    "多出尾随字符必须判失败"
  );
  assert.strictEqual(bjhDescOk("", want), false, "空串必须判失败");

  console.log("✓ 2. 百家号作品描述严格相等校验（文件名残留/重复叠加/前缀包含均判失败）通过");
}

/* ------------------------------------------------------------------ *
 * 3. Fake DOM：气泡关闭、可靠清空写入、终检重填、诊断日志、确定性失败不可重试
 * ------------------------------------------------------------------ */
function createFakeBjhEnv({
  initialText = "济公J04-豆腐坊泼脏水-审看版-v1",
  hasBubble = true,
  hasEditor = true,
  execDeleteMode = "clear", // "clear" | "noop"
  execInsertMode = "replaceSelection", // "replaceSelection" | "prependStubborn" | "noop"
  keyboardClearMode = "clear", // "clear" | "noop"
  keyboardTypeMode = "append", // "append" | "noop"
  allowFocus = true,
  rewriteAfterFirstFill = "",
  afterClickToast = null, // { type: "close-circle" | "check-circle", text: "..." }
} = {}) {
  const editor = {
    tagName: "DIV",
    className: "FeEditorApp-abc123-contentEditable",
    _text: initialText,
    _selectedAll: false,
    parentElement: null,
    get textContent() {
      return this._text;
    },
    set textContent(v) {
      this._text = String(v == null ? "" : v);
    },
    get innerText() {
      return this._text;
    },
    getAttribute(k) {
      if (k === "contenteditable") return "true";
      if (k === "class") return this.className;
      return null;
    },
    scrollIntoView() {},
    focus() {
      if (allowFocus) doc.activeElement = this;
    },
    contains(n) {
      return n === this;
    },
    getBoundingClientRect() {
      return { left: 100, top: 100, width: 500, height: 120 };
    },
  };

  const counterNode = {
    tagName: "SPAN",
    get textContent() {
      return `${Array.from(editor._text).length}/50`;
    },
  };

  const editorWrap = {
    tagName: "DIV",
    parentElement: null,
    get textContent() {
      return `${editor.textContent} ${counterNode.textContent}`;
    },
    querySelectorAll(sel) {
      if (sel.includes("span")) return [counterNode];
      return [];
    },
  };
  editor.parentElement = editorWrap;

  let bubbleVisible = hasBubble;
  let bubbleCloseClicks = 0;
  const bubbleCloseBtn = {
    tagName: "SPAN",
    textContent: "×",
    isConnected: true,
    getAttribute(k) {
      if (k === "aria-label") return "close";
      return null;
    },
    getBoundingClientRect() {
      return bubbleVisible
        ? { left: 400, top: 120, width: 16, height: 16 }
        : { left: 0, top: 0, width: 0, height: 0 };
    },
    click() {
      bubbleCloseClicks += 1;
      bubbleVisible = false;
    },
  };
  const bubbleEl = {
    tagName: "DIV",
    textContent: "新增智能文案，上传视频，AI为您生成优质文案，快来试试吧！ ×",
    isConnected: true,
    parentElement: null,
    getBoundingClientRect() {
      return bubbleVisible
        ? { left: 120, top: 110, width: 320, height: 40 }
        : { left: 0, top: 0, width: 0, height: 0 };
    },
    querySelectorAll(sel) {
      if (!bubbleVisible) return [];
      if (sel.includes("aria-label=\"close\"") || sel.includes("span")) {
        return [bubbleCloseBtn];
      }
      return [];
    },
  };

  const publishBtn = {
    tagName: "BUTTON",
    textContent: "发布",
    disabled: false,
    className: "cheetah-btn-primary cheetah-btn-solid",
    getAttribute(k) {
      if (k === "data-testid") return "publish-btn";
      return null;
    },
    hasAttribute() {
      return false;
    },
    getBoundingClientRect() {
      return { left: 700, top: 600, width: 88, height: 36 };
    },
  };

  let clickedOnce = false;
  const toastEl = {
    get innerText() {
      return afterClickToast ? afterClickToast.text : "";
    },
    get textContent() {
      return this.innerText;
    },
    querySelector(sel) {
      if (!afterClickToast) return null;
      if (sel.includes('role="img"')) {
        return {
          getAttribute: (k) => (k === "aria-label" ? afterClickToast.type : null),
        };
      }
      return null;
    },
  };

  let currentRange = null;
  const selection = {
    ranges: [],
    removeAllRanges() {
      this.ranges = [];
      editor._selectedAll = false;
    },
    addRange(r) {
      this.ranges = [r];
      if (r && r._node === editor) {
        editor._selectedAll = true;
      }
    },
  };

  const execCommands = [];
  const doc = {
    activeElement: null,
    body: { textContent: "", innerText: "" },
    createRange() {
      currentRange = {
        _node: null,
        selectNodeContents(node) {
          this._node = node;
        },
      };
      return currentRange;
    },
    execCommand(cmd, _ui, val) {
      execCommands.push({ cmd, val, selectedAll: editor._selectedAll });
      if (cmd === "delete") {
        if (execDeleteMode === "clear" && editor._selectedAll) {
          editor._text = "";
          editor._selectedAll = false;
          return true;
        }
        return false;
      }
      if (cmd === "insertText") {
        if (execInsertMode === "replaceSelection") {
          if (editor._selectedAll) {
            editor._text = String(val || "");
            editor._selectedAll = false;
          } else {
            editor._text = String(val || "") + editor._text;
          }
          return true;
        }
        if (execInsertMode === "prependStubborn") {
          // 模拟老事故：清空无效，新内容被插到旧内容前面
          editor._text = String(val || "") + editor._text;
          return true;
        }
        return false;
      }
      return false;
    },
    querySelector(sel) {
      if (sel.includes("contentEditable") || sel.includes("FeEditorApp")) {
        return hasEditor ? editor : null;
      }
      if (sel === 'button[data-testid="publish-btn"]') return publishBtn;
      if (sel === "#new-operator-content .op-list-right") {
        return {
          querySelector: (s) => (s.includes("publish-btn") ? publishBtn : null),
          querySelectorAll: (s) => (s === "button" ? [publishBtn] : []),
        };
      }
      if (sel === ".cheetah-message.cheetah-message-top") {
        return clickedOnce && afterClickToast ? toastEl : null;
      }
      if (sel === "#cover-tabs-container") {
        return { querySelector: () => null };
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel.includes("popover") || sel.includes("tooltip")) {
        return bubbleVisible ? [bubbleEl] : [];
      }
      if (sel === '[contenteditable="true"]') return hasEditor ? [editor] : [];
      if (sel === "button") return [publishBtn];
      return [];
    },
  };

  const fakeWin = {
    getSelection: () => selection,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };

  const keyEvents = [];
  let modHeld = false;
  let allSelectedByKey = false;
  let mouseClicks = 0;
  let uploadCalls = 0;
  let fillCount = 0;

  const page = {
    url: () => "https://baijiahao.baidu.com/builder/rc/edit?type=videoV2",
    async evaluate(fn, ...args) {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStyle = global.getComputedStyle;
      global.document = doc;
      global.window = fakeWin;
      global.getComputedStyle = fakeWin.getComputedStyle;
      try {
        if (typeof fn === "string") {
          // eslint-disable-next-line no-eval
          return eval(fn);
        }
        return fn(...args);
      } finally {
        if (prevDoc === undefined) delete global.document;
        else global.document = prevDoc;
        if (prevWin === undefined) delete global.window;
        else global.window = prevWin;
        if (prevStyle === undefined) delete global.getComputedStyle;
        else global.getComputedStyle = prevStyle;
      }
    },
    async waitForTimeout() {},
    async waitForSelector(sel, opts = {}) {
      if (sel.includes('input[type="file"]')) return {};
      if (sel.includes("请选择创作声明")) throw new Error("skip statement in unit test");
      if (sel.includes("contentEditable") || sel.includes("FeEditorApp")) {
        if (!hasEditor) throw new Error("no editor");
        return editor;
      }
      if (sel === ".cheetah-message.cheetah-message-top") {
        if (opts.hidden) return null;
        if (opts.visible) {
          if (clickedOnce && afterClickToast) return toastEl;
          throw new Error("no toast");
        }
      }
      return {};
    },
    async $$(sel) {
      if (sel.includes('input[type="file"]')) {
        return [
          {
            uploadFile: async () => {
              uploadCalls += 1;
            },
          },
        ];
      }
      return [];
    },
    async $(sel) {
      if (sel === ".op-list.op-list-wrap-videoV2") {
        // 模拟上传解析完成后页面把文件名回填进作品描述（检验终检重写能力）
        if (rewriteAfterFirstFill && fillCount === 0) {
          fillCount += 1;
          editor._text = rewriteAfterFirstFill;
        }
        return {
          boundingBox: async () => ({ x: 100, y: 500, width: 800, height: 60 }),
        };
      }
      if (sel.includes("contentEditable") || sel.includes("FeEditorApp")) {
        return hasEditor ? editor : null;
      }
      return null;
    },
    keyboard: {
      async down(k) {
        keyEvents.push(`down:${k}`);
        if (k === "Control" || k === "Meta") modHeld = true;
      },
      async up(k) {
        keyEvents.push(`up:${k}`);
        if (k === "Control" || k === "Meta") modHeld = false;
      },
      async press(k) {
        keyEvents.push(`press:${k}`);
        if (k === "KeyA" && modHeld && doc.activeElement === editor) {
          allSelectedByKey = true;
        }
        if (k === "Backspace" && allSelectedByKey && keyboardClearMode === "clear") {
          editor._text = "";
          allSelectedByKey = false;
        }
      },
      async type(txt) {
        keyEvents.push(`type:${txt}`);
        if (keyboardTypeMode === "append") {
          editor._text += txt;
        }
      },
    },
    mouse: {
      async click() {
        mouseClicks += 1;
        clickedOnce = true;
      },
    },
  };

  return {
    page,
    editor,
    doc,
    execCommands,
    keyEvents,
    get bubbleCloseClicks() {
      return bubbleCloseClicks;
    },
    get bubbleVisible() {
      return bubbleVisible;
    },
    get mouseClicks() {
      return mouseClicks;
    },
    get uploadCalls() {
      return uploadCalls;
    },
  };
}

async function testBjhDomClearWriteAndNoRetry() {
  const {
    dismissBjhSmartCopyBubble,
    fillBjhDescription,
    ensureBjhDescription,
    isBjhNoRetryError,
  } = bjhMod;
  const bjhHandler = bjhMod.default;

  // 3a. 正常清空预填文件名 + 关闭蓝色智能文案气泡 + 诊断日志打印前后 textContent 与计数器
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: true,
    });
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const res = await fillBjhDescription(
        env.page,
        "济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公"
      );
      assert.strictEqual(res.ok, true);
      assert.strictEqual(
        res.text,
        "济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公"
      );
      assert.strictEqual(env.bubbleCloseClicks, 1, "应先点 × 关闭智能文案气泡");
      assert.strictEqual(env.bubbleVisible, false);
      assert.strictEqual(
        env.editor.textContent,
        "济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公"
      );
      assert.ok(
        env.execCommands.some((c) => c.cmd === "delete" && c.selectedAll),
        "应使用 Range selectNodeContents 后 execCommand('delete')"
      );
      assert.ok(
        env.execCommands.some((c) => c.cmd === "insertText"),
        "应使用 execCommand('insertText') 覆盖写入"
      );
      assert.ok(
        logs.some((l) => l.includes("写入前") && l.includes("济公J04-豆腐坊泼脏水-审看版-v1") && l.includes("19/50")),
        "应输出写入前 textContent 与计数器诊断日志"
      );
      assert.ok(
        logs.some((l) => l.includes("写入后") && l.includes("济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公") && l.includes("23/50")),
        "应输出写入后 textContent 与计数器诊断日志"
      );
    } finally {
      console.log = origLog;
    }

    // 无气泡时调用 dismissBjhSmartCopyBubble 应跳过不报错
    const skipRes = await dismissBjhSmartCopyBubble(env.page);
    assert.strictEqual(skipRes.found, false);
    assert.strictEqual(skipRes.closed, false);
  }

  // 3b. delete 失效时，仅当焦点确认在编辑器内才补发 Ctrl/Cmd+A + Backspace，随后成功写入
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: false,
      execDeleteMode: "noop",
      execInsertMode: "noop",
      keyboardClearMode: "clear",
      keyboardTypeMode: "append",
      allowFocus: true,
    });
    const res = await fillBjhDescription(env.page, "济公断豆腐坊泼脏水");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(env.editor.textContent, "济公断豆腐坊泼脏水");
    assert.ok(env.keyEvents.includes("press:KeyA"), "焦点在编辑器内时应补发全选");
    assert.ok(env.keyEvents.includes("press:Backspace"), "焦点在编辑器内时应补发 Backspace");
  }

  // 3c. delete 失效且焦点不在编辑器内 → 绝不盲发 Ctrl/Cmd+A，也不允许 keyboard.type 叠加到旧文本上
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: false,
      execDeleteMode: "noop",
      execInsertMode: "noop",
      allowFocus: false,
    });
    let caught = null;
    try {
      await fillBjhDescription(env.page, "济公断豆腐坊泼脏水", { maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "写入失败必须抛错中止");
    assert.strictEqual(isBjhNoRetryError(caught), true, "应标记为不可重试的确定性失败");
    assert.strictEqual(caught.noRetry, true);
    assert.strictEqual(caught.bjhDeterministic, true);
    assert.ok(!env.keyEvents.includes("press:KeyA"), "焦点不在编辑器内时绝不能发 Ctrl/Cmd+A");
    assert.ok(!env.keyEvents.some((k) => k.startsWith("type:")), "编辑器非空时绝不能 keyboard.type 追加");
  }

  // 3d. 顽固叠加（模拟真机 2026-11-25 标题×3+文件名故障）→ 最多 3 次后抛确定性失败（noRetry=true）
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: false,
      execDeleteMode: "noop",
      execInsertMode: "prependStubborn",
      keyboardClearMode: "noop",
      allowFocus: true,
    });
    let caught = null;
    try {
      await fillBjhDescription(env.page, "济公断豆腐坊泼脏水", { maxAttempts: 3 });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "重复叠加+文件名残留必须判失败并中止");
    assert.strictEqual(caught.noRetry, true);
    assert.strictEqual(caught.bjhDeterministic, true);
    assert.strictEqual(
      env.execCommands.filter((c) => c.cmd === "insertText").length,
      3,
      "最多尝试清空重写 3 次"
    );
    assert.ok(caught.message.includes("确定性失败"), caught.message);
  }

  // 3e. ensureBjhDescription 终检：页面异步回填文件名后走清空重写，绝不追加叠加
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: false,
    });
    const res = await ensureBjhDescription(env.page, "济公断豆腐坊泼脏水，百姓拍手叫好");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(env.editor.textContent, "济公断豆腐坊泼脏水，百姓拍手叫好");
    assert.ok(!env.editor.textContent.includes("审看版"));
  }

  // 3f. 完整 bjh handler：描述写入/校验确定性失败 → 不点发布，replyPublishFailure 携带 noRetry:true，外层不再 5 次重试
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: true,
      execDeleteMode: "noop",
      execInsertMode: "prependStubborn",
      keyboardClearMode: "noop",
      allowFocus: true,
    });
    const replies = [];
    const fakeTransport = {
      reply(channel, payload) {
        replies.push({ channel, payload });
        // 模拟 puppeteerFile.js createAttemptTransport：status:false 抛带 _mmUploadFailurePayload 的异常
        if (channel === "puppeteerFile-done" && payload && payload.status === false) {
          const e = new Error(payload.message || "平台上传失败");
          e._mmUploadFailurePayload = payload;
          throw e;
        }
      },
    };

    let outerErr = null;
    try {
      await bjhHandler(
        env.page,
        {
          pt: "百家号",
          filePath: "/tmp/济公J04-豆腐坊泼脏水-审看版-v1.mp4",
          data: {
            title: "济公断豆腐坊泼脏水",
            description: "黑心掌柜往豆腐缸泼脏水，济公当众拆穿",
            tags: ["济公"],
          },
        },
        null,
        fakeTransport
      );
    } catch (e) {
      outerErr = e;
    }

    assert.strictEqual(env.mouseClicks, 0, "描述校验失败必须中止，绝不能点发布");
    assert.ok(outerErr && outerErr._mmUploadFailurePayload, "应通过 replyPublishFailure 上报给外层");
    const failurePayload = outerErr._mmUploadFailurePayload;
    assert.strictEqual(failurePayload.status, false);
    assert.strictEqual(
      failurePayload.noRetry,
      true,
      "描述写入/校验失败必须标记 noRetry:true，阻止外层 5 次重复上传"
    );
    assert.strictEqual(env.uploadCalls, 1, "只执行 1 次上传，不重复上传");
    assert.ok(replies.some((r) => r.channel === "puppeteerFile-done" && r.payload.noRetry === true));
  }

  // 3g. 完整 bjh handler：点击发布前页面异步把文件名写回 → 终检清空覆盖后成功点发布；
  //     若点击发布后页面弹 close-circle 失败提示 → bjhClickDispatched 仍保持 noRetry:true
  {
    const env = createFakeBjhEnv({
      initialText: "济公J04-豆腐坊泼脏水-审看版-v1",
      hasBubble: true,
      rewriteAfterFirstFill: "济公J04-豆腐坊泼脏水-审看版-v1",
      afterClickToast: { type: "close-circle", text: "系统繁忙请稍后" },
    });
    let outerErr = null;
    try {
      await bjhHandler(
        env.page,
        {
          pt: "百家号",
          filePath: "/tmp/济公J04-豆腐坊泼脏水-审看版-v1.mp4",
          data: {
            title: "济公断豆腐坊泼脏水",
            description: "黑心掌柜当众被拆穿",
            tags: ["济公"],
          },
        },
        null,
        {
          reply(channel, payload) {
            if (channel === "puppeteerFile-done" && payload && payload.status === false) {
              const e = new Error(payload.message || "失败");
              e._mmUploadFailurePayload = payload;
              throw e;
            }
          },
        }
      );
    } catch (e) {
      outerErr = e;
    }
    assert.strictEqual(
      env.editor.textContent,
      "济公断豆腐坊泼脏水，黑心掌柜当众被拆穿 #济公",
      "终检应彻底覆盖异步回填的文件名"
    );
    assert.strictEqual(env.mouseClicks, 1, "终检通过后仅点击发布一次");
    assert.ok(outerErr && outerErr._mmUploadFailurePayload);
    assert.strictEqual(
      outerErr._mmUploadFailurePayload.noRetry,
      true,
      "派发过发布点击后的任何失败仍必须带 noRetry:true"
    );
  }

  console.log("✓ 3. 百家号气泡关闭、DOM Range 清空写入、终检、诊断日志与确定性失败 noRetry 通过");
}

(async () => {
  testBjhDescriptionAssembly();
  testBjhExactEquality();
  await testBjhDomClearWriteAndNoRetry();
  console.log("\ntest-bjh-description: 全部断言通过");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
