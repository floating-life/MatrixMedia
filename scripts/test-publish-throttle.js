"use strict";

/**
 * S11 发布节流 / 平台错峰 / 默认 AI 创作声明 综合单测：
 * 1. 纯排期算法：间隔不足顺延（含 ≤1min 立即 vs >1min 定时边界、同平台多账号隔离、同账号顺序累积、失败/草稿不计数）
 * 2. 纯排期算法：跨允许时段顺延到次日 06:00（含 05:59:59 / 23:30:00 / 23:30:01 边界）
 * 3. 纯排期算法：同账号每日上限顺延到次日首个可用时刻（含连满两天顺延至第 3 天、0=不限）
 * 4. 纯排期算法：百家号相对首发延迟 +10h（含跨时段叠加与最小间隔取 max）
 * 5. 纯排期算法：显式 publishAt 过节流且只顺延不提前
 * 6. 纯排期算法与三端：noThrottle / --no-throttle / 总开关关闭绕过
 * 7. 主进程持久化设置与 IPC（读写、校验、重置、损坏回退、排期预览、定时创建去重）
 * 8. HTTP POST /publish & GET /creative-statements：多平台部分立即部分定时、与 S10 重复拦截叠加、默认声明套用与覆盖、不支持平台回退
 * 9. CLI publish：单文件节流自动转定时、--no-throttle 绕过、重复拦截先于排期、默认声明套用与覆盖
 * 10. 重启恢复：节流生成的定时任务落盘 pushData → 停调度器模拟退出 → 重新加载模块并启动调度器 → 定时任务仍在且重新挂上定时器
 * 11. GUI 模板编译与接线（PublishThrottleSettingsCard / LocalVideoPublish / videoManager / projectDetail）与文档校验
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const esbuild = require("esbuild");
const compiler = require("vue-template-compiler");

const root = path.resolve(__dirname, "..");

const {
  IMMEDIATE_THRESHOLD_MS,
  createDefaultPublishThrottleSettings,
  normalizePublishThrottleSettings,
  validatePublishThrottleSettings,
  formatUtc8DateTime,
  parseUtc8DateTimeMs,
  planPublishTimes,
} = require("../src/shared/publishThrottle.js");

const throttleService = require("../src/main/services/publishThrottle.js");

function t8(isoWithoutTz) {
  return Date.parse(`${isoWithoutTz}+08:00`);
}

function testCase1_IntervalPostponeAndBoundaries() {
  const now = t8("2026-11-21T10:00:00");
  const settings = createDefaultPublishThrottleSettings();

  // 默认配置校验：总开关开、抖音 6h、其余 4h、日上限 3、相对延迟 0、允许时段 06:00-23:30、默认声明 ai_generated
  assert.strictEqual(settings.enabled, true);
  assert.strictEqual(settings.platforms["抖音"].minIntervalHours, 6);
  assert.strictEqual(settings.platforms["快手"].minIntervalHours, 4);
  assert.strictEqual(settings.platforms["百家号"].minIntervalHours, 4);
  assert.strictEqual(settings.platforms["百家号"].delayFromFirstHours, 0);
  assert.strictEqual(settings.platforms["抖音"].dailyLimit, 3);
  assert.deepStrictEqual(settings.allowedWindow, { start: "06:00", end: "23:30" });
  assert.strictEqual(settings.defaultCreativeStatement, "ai_generated");

  const records = [
    // 抖音 A组 1 小时前刚成功发过（间隔 6h → 15:00）
    {
      id: "r1",
      pt: "抖音",
      phone: "A组",
      partition: "persist:A组抖音",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:00:00"),
    },
    // 快手 A组 失败记录与草稿记录不计入节流
    {
      id: "r2",
      pt: "快手",
      phone: "A组",
      partition: "persist:A组快手",
      publishStatus: "failed",
      lastPublishAt: t8("2026-11-21T09:50:00"),
    },
    {
      id: "r3",
      pt: "快手",
      phone: "A组",
      partition: "persist:A组快手",
      publishStatus: "draft",
      lastPublishAt: t8("2026-11-21T09:55:00"),
    },
    // 头条 A组 有进行中（publishing）记录（30 分钟前，间隔 4h → 13:30）
    {
      id: "r4",
      pt: "头条",
      phone: "A组",
      partition: "persist:A组头条",
      publishStatus: "publishing",
      lastPublishAt: t8("2026-11-21T09:30:00"),
    },
    // 视频号 A组 有待执行定时任务（12:00，间隔 4h → 16:00）
    {
      id: "r5",
      pt: "视频号",
      phone: "A组",
      partition: "persist:A组视频号",
      scheduledTask: true,
      publishStatus: "scheduled",
      scheduledPublishAt: t8("2026-11-21T12:00:00"),
    },
  ];

  // 1a. 同请求内：抖音 A组顺延至 15:00、抖音 B组互不影响立即发、快手 A组忽略失败/草稿立即发、头条 A组顺延至 13:30、视频号 A组顺延至 16:00
  const plan = planPublishTimes({
    targets: [
      { platform: "dy", phone: "A组" },
      { platform: "dy", phone: "B组" },
      { platform: "ks", phone: "A组" },
      { platform: "tt", phone: "A组" },
      { platform: "sph", phone: "A组" },
    ],
    now,
    records,
    settings,
  });

  assert.strictEqual(plan.items[0].immediate, false);
  assert.strictEqual(plan.items[0].scheduled, true);
  assert.strictEqual(plan.items[0].throttled, true);
  assert.strictEqual(plan.items[0].publishAt, "2026-11-21 15:00:00");
  assert.ok(plan.items[0].reason.includes("距上次抖音发布不足 6 小时"), plan.items[0].reason);

  // 同平台不同账号互不影响
  assert.strictEqual(plan.items[1].immediate, true);
  assert.strictEqual(plan.items[1].scheduled, false);
  assert.strictEqual(plan.items[1].publishAt, null);

  // 失败/草稿不计入节流
  assert.strictEqual(plan.items[2].immediate, true);
  assert.strictEqual(plan.items[2].scheduled, false);

  // 进行中记录计入节流
  assert.strictEqual(plan.items[3].scheduled, true);
  assert.strictEqual(plan.items[3].publishAt, "2026-11-21 13:30:00");

  // 待执行定时任务计入节流
  assert.strictEqual(plan.items[4].scheduled, true);
  assert.strictEqual(plan.items[4].publishAt, "2026-11-21 16:00:00");
  assert.ok(plan.items[4].reason.includes("待发任务不足 4 小时"), plan.items[4].reason);

  // 1b. 同账号多条请求按顺序累积（A组快手连发 3 条：10:00 立即 → 14:00 定时 → 18:00 定时）
  const seqPlan = planPublishTimes({
    targets: [
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
    ],
    now,
    records: [],
    settings,
  });
  assert.strictEqual(seqPlan.items[0].immediate, true);
  assert.strictEqual(seqPlan.items[1].publishAt, "2026-11-21 14:00:00");
  assert.strictEqual(seqPlan.items[2].publishAt, "2026-11-21 18:00:00");

  // 1c. ≤ 现在+1 分钟 边界：恰好差 60s → 立即发；差 61s → 建定时任务
  assert.strictEqual(IMMEDIATE_THRESHOLD_MS, 60000);
  const edgeRec60s = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: now - 6 * 3600000 + 60000, // last + 6h = now + 60s
    },
  ];
  const p60 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records: edgeRec60s,
    settings,
  });
  assert.strictEqual(p60.items[0].immediate, true, "计划时刻恰好等于 now+1 分钟应立即发");
  assert.strictEqual(p60.items[0].throttled, false);

  const edgeRec61s = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: now - 6 * 3600000 + 61000, // last + 6h = now + 61s
    },
  ];
  const p61 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records: edgeRec61s,
    settings,
  });
  assert.strictEqual(p61.items[0].scheduled, true, "计划时刻为 now+61 秒应建定时任务");
  assert.strictEqual(p61.items[0].publishAt, "2026-11-21 10:01:01");

  console.log("✓ 1. 间隔不足顺延、1 分钟边界、多账号隔离与同账号顺序累积验证通过");
}

function testCase2_AllowedWindowRollover() {
  const settings = createDefaultPublishThrottleSettings();

  // 2a. 23:30:00 恰好在允许时段末端点 → 立即发
  const at2330 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T23:30:00"),
    records: [],
    settings,
  });
  assert.strictEqual(at2330.items[0].immediate, true, "23:30:00 在 06:00–23:30 内应立即发");

  // 2b. 23:30:01 超出允许时段 → 顺延到次日 06:00:00
  const at233001 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T23:30:01"),
    records: [],
    settings,
  });
  assert.strictEqual(at233001.items[0].scheduled, true);
  assert.strictEqual(at233001.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(at233001.items[0].reason.includes("06:00–23:30"));

  // 2c. 05:58:00 凌晨未到 06:00 → 顺延到当日 06:00:00
  const at0558 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T05:58:00"),
    records: [],
    settings,
  });
  assert.strictEqual(at0558.items[0].scheduled, true);
  assert.strictEqual(at0558.items[0].publishAt, "2026-11-21 06:00:00");

  // 2d. 05:59:30 距 06:00 仅 30 秒（≤ 1 分钟阈值）→ 立即发
  const at055930 = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T05:59:30"),
    records: [],
    settings,
  });
  assert.strictEqual(at055930.items[0].immediate, true);

  // 2e. 间隔不足把时刻推到 23:31 之后（例如 18:30 发过抖音，6h 后 00:30 → 顺延至次日 06:00:00）
  const nightPush = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now: t8("2026-11-21T20:00:00"),
    records: [
      {
        pt: "抖音",
        phone: "A组",
        publishStatus: "success",
        lastPublishAt: t8("2026-11-21T18:30:00"),
      },
    ],
    settings,
  });
  assert.strictEqual(nightPush.items[0].scheduled, true);
  assert.strictEqual(nightPush.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(nightPush.items[0].reason.includes("不足 6 小时"));
  assert.ok(nightPush.items[0].reason.includes("允许发布时段"));

  console.log("✓ 2. 跨允许时段（06:00–23:30 UTC+8）与端点边界顺延至次日 06:00 验证通过");
}

function testCase3_DailyLimitRollover() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T19:00:00");

  // 3a. 快手当日已有 2 条（06:00, 10:00）< 上限 3，且距 10:00 超过 4h → 立即发
  const twoToday = [
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T06:00:00") },
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T10:00:00") },
  ];
  const p2 = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: twoToday,
    settings,
  });
  assert.strictEqual(p2.items[0].immediate, true);

  // 3b. 快手当日已有 3 条（06:00, 10:00, 14:00）= 上限 3，尽管距 14:00 已超 4h，仍顺延到次日 06:00:00
  const threeToday = [
    ...twoToday,
    { pt: "快手", phone: "A组", publishStatus: "success", lastPublishAt: t8("2026-11-21T14:00:00") },
  ];
  const p3 = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: threeToday,
    settings,
  });
  assert.strictEqual(p3.items[0].scheduled, true);
  assert.strictEqual(p3.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(p3.items[0].reason.includes("上限（3 条/天）"), p3.items[0].reason);

  // 3c. 同批请求第 4、5 条：次日 06:00、10:00、14:00 满 3 条后，第 4 条跨到第 3 天 06:00:00
  const pMultiDays = planPublishTimes({
    targets: [
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
      { platform: "ks", phone: "A组" },
    ],
    now,
    records: threeToday,
    settings,
  });
  assert.deepStrictEqual(
    pMultiDays.items.map((it) => it.publishAt),
    [
      "2026-11-22 06:00:00",
      "2026-11-22 10:00:00",
      "2026-11-22 14:00:00",
      "2026-11-23 06:00:00",
    ]
  );

  // 3d. dailyLimit = 0 表示不限制日上限
  const unlimitedSettings = normalizePublishThrottleSettings({
    ...settings,
    platforms: { ...settings.platforms, 快手: { minIntervalHours: 4, dailyLimit: 0, delayFromFirstHours: 0 } },
  });
  const pUnlimited = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    records: threeToday,
    settings: unlimitedSettings,
  });
  assert.strictEqual(pUnlimited.items[0].immediate, true);

  console.log("✓ 3. 每日上限边界、跨多日顺延与 0=不限 验证通过");
}

function testCase4_BjhDelayPlus10h() {
  const settings = normalizePublishThrottleSettings({
    platforms: {
      bjh: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 },
    },
  });

  // 4a. 10:00 发 → 百家号自动延迟 +10h 至 20:00:00，抖音立即发
  const pDay = planPublishTimes({
    targets: [
      { platform: "dy", phone: "A组" },
      { platform: "bjh", phone: "A组" },
    ],
    now: t8("2026-11-21T10:00:00"),
    records: [],
    settings,
  });
  assert.strictEqual(pDay.items[0].immediate, true);
  assert.strictEqual(pDay.items[1].scheduled, true);
  assert.strictEqual(pDay.items[1].publishAt, "2026-11-21 20:00:00");
  assert.ok(pDay.items[1].reason.includes("百家号相对首发延迟 10 小时"), pDay.items[1].reason);

  // 4b. 15:00 发 → +10h = 次日 01:00 → 超出 06:00–23:30 顺延至次日 06:00:00
  const pOvernight = planPublishTimes({
    targets: [{ platform: "bjh", phone: "A组" }],
    now: t8("2026-11-21T15:00:00"),
    records: [],
    settings,
  });
  assert.strictEqual(pOvernight.items[0].scheduled, true);
  assert.strictEqual(pOvernight.items[0].publishAt, "2026-11-22 06:00:00");
  assert.ok(pOvernight.items[0].reason.includes("延迟 10 小时"));
  assert.ok(pOvernight.items[0].reason.includes("允许发布时段"));

  // 4c. 已有待发任务在 18:00（minInterval 4h → 22:00）vs 请求 10:00 + 10h = 20:00 → max(20:00, 22:00) = 22:00
  const pMax = planPublishTimes({
    targets: [{ platform: "bjh", phone: "A组" }],
    now: t8("2026-11-21T10:00:00"),
    records: [
      {
        pt: "百家号",
        phone: "A组",
        scheduledTask: true,
        publishStatus: "scheduled",
        scheduledPublishAt: t8("2026-11-21T18:00:00"),
      },
    ],
    settings,
  });
  assert.strictEqual(pMax.items[0].publishAt, "2026-11-21 22:00:00");

  console.log("✓ 4. 百家号相对首发延迟 +10h（含跨时段与最小间隔取 max）验证通过");
}

function testCase5_ExplicitPublishAtOnlyPostpones() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T10:00:00");
  const records = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:00:00"), // +6h = 15:00
    },
  ];

  // 5a. 用户指定 12:00（< 15:00）→ 顺延至 15:00:00
  const pPostpone = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 12:00:00",
    records,
    settings,
  });
  assert.strictEqual(pPostpone.items[0].scheduled, true);
  assert.strictEqual(pPostpone.items[0].throttled, true);
  assert.strictEqual(pPostpone.items[0].publishAt, "2026-11-21 15:00:00");
  assert.ok(pPostpone.items[0].reason.includes("距上次抖音发布不足 6 小时"));

  // 5b. 用户指定 18:00（> 15:00 且在允许时段内）→ 保持 18:00:00，绝不提前
  const pKeep = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 18:00:00",
    records,
    settings,
  });
  assert.strictEqual(pKeep.items[0].scheduled, true);
  assert.strictEqual(pKeep.items[0].throttled, false);
  assert.strictEqual(pKeep.items[0].publishAt, "2026-11-21 18:00:00");
  assert.strictEqual(pKeep.items[0].reason, "");

  // 5c. 用户指定凌晨 02:00（在次日允许时段外）→ 顺延到 06:00:00
  const pNight = planPublishTimes({
    targets: [{ platform: "ks", phone: "A组" }],
    now,
    publishAt: "2026-11-22 02:00:00",
    records: [],
    settings,
  });
  assert.strictEqual(pNight.items[0].throttled, true);
  assert.strictEqual(pNight.items[0].publishAt, "2026-11-22 06:00:00");

  console.log("✓ 5. 显式 publishAt 过节流（只顺延不提前）验证通过");
}

function testCase6_NoThrottleBypass() {
  const settings = createDefaultPublishThrottleSettings();
  const now = t8("2026-11-21T10:00:00");
  const records = [
    {
      pt: "抖音",
      phone: "A组",
      publishStatus: "success",
      lastPublishAt: t8("2026-11-21T09:50:00"),
    },
  ];

  // 6a. 全局 noThrottle: true → 立即发
  const pBypass = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records,
    settings,
    noThrottle: true,
  });
  assert.strictEqual(pBypass.items[0].immediate, true);
  assert.strictEqual(pBypass.items[0].throttled, false);
  assert.strictEqual(pBypass.items[0].bypassed, true);

  // 6b. 显式 publishAt + noThrottle: true → 保持原定时间不顺延
  const pBypassAt = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    publishAt: "2026-11-21 11:00:00",
    records,
    settings,
    noThrottle: true,
  });
  assert.strictEqual(pBypassAt.items[0].scheduled, true);
  assert.strictEqual(pBypassAt.items[0].throttled, false);
  assert.strictEqual(pBypassAt.items[0].publishAt, "2026-11-21 11:00:00");

  // 6c. 总开关 enabled: false → 绕过节流
  const pDisabled = planPublishTimes({
    targets: [{ platform: "dy", phone: "A组" }],
    now,
    records,
    settings: { ...settings, enabled: false },
  });
  assert.strictEqual(pDisabled.items[0].immediate, true);
  assert.strictEqual(pDisabled.items[0].throttled, false);

  console.log("✓ 6. noThrottle / 总开关关闭 绕过节流验证通过");
}

async function testCase7_SettingsPersistenceAndIpc() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-settings-"));
  const filePath = path.join(tmpDir, "publish-throttle-settings.json");

  try {
    // 7a. 未写文件前读出默认值
    const initial = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(initial.enabled, true);
    assert.strictEqual(initial.defaultCreativeStatement, "ai_generated");
    assert.strictEqual(initial.platforms["抖音"].minIntervalHours, 6);

    // 7b. 校验非法配置被拒绝
    assert.strictEqual(
      validatePublishThrottleSettings({ allowedWindow: { start: "10:00", end: "10:00" } }).ok,
      false
    );
    assert.strictEqual(
      validatePublishThrottleSettings({ platforms: { 抖音: { dailyLimit: 1.5 } } }).ok,
      false
    );
    assert.strictEqual(
      throttleService.savePublishThrottleSettings(
        { allowedWindow: { start: "bad", end: "23:30" } },
        { filePath }
      ).ok,
      false
    );

    // 7c. 持久化写入并重新读回
    const saved = throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "07:00", end: "22:30" },
        defaultCreativeStatement: "none",
        platforms: {
          bjh: { minIntervalHours: 5, dailyLimit: 2, delayFromFirstHours: 10 },
        },
      },
      { filePath }
    );
    assert.strictEqual(saved.ok, true);
    const reloaded = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(reloaded.allowedWindow.start, "07:00");
    assert.strictEqual(reloaded.allowedWindow.end, "22:30");
    assert.strictEqual(reloaded.defaultCreativeStatement, "none");
    assert.strictEqual(reloaded.platforms["百家号"].delayFromFirstHours, 10);
    assert.strictEqual(reloaded.platforms["百家号"].dailyLimit, 2);
    assert.strictEqual(reloaded.platforms["抖音"].minIntervalHours, 6);

    // 7d. 损坏 JSON 文件回退默认值不崩
    fs.writeFileSync(filePath, "{broken-json", "utf8");
    const fallback = throttleService.readPublishThrottleSettings({ filePath });
    assert.strictEqual(fallback.defaultCreativeStatement, "ai_generated");
    assert.strictEqual(fallback.platforms["抖音"].minIntervalHours, 6);

    // 7e. IPC 注册与调用（get / save / reset / plan）
    const handlers = new Map();
    const fakeIpcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
    };
    throttleService.registerPublishThrottleIpc(fakeIpcMain, {
      filePath,
      changeData: () => ({
        success: true,
        data: {
          "2026-11-21": [
            {
              id: "hist-1",
              pt: "抖音",
              phone: "A组",
              partition: "persist:A组抖音",
              publishStatus: "success",
              lastPublishAt: t8("2026-11-21T09:00:00"),
            },
          ],
        },
      }),
    });

    const saveRes = await handlers.get("publish-throttle:save-settings")(null, {
      enabled: true,
      allowedWindow: { start: "06:00", end: "23:30" },
      defaultCreativeStatement: "ai_generated",
      platforms: { 百家号: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 } },
    });
    assert.strictEqual(saveRes.ok, true);

    const planRes = await handlers.get("publish-throttle:plan")(null, {
      now: t8("2026-11-21T10:00:00"),
      targets: [
        { platform: "dy", phone: "A组" },
        { platform: "bjh", phone: "A组" },
        { platform: "ks", phone: "A组" },
      ],
    });
    assert.strictEqual(planRes.ok, true);
    assert.strictEqual(planRes.items[0].publishAt, "2026-11-21 15:00:00");
    assert.strictEqual(planRes.items[1].publishAt, "2026-11-21 20:00:00");
    assert.strictEqual(planRes.items[2].immediate, true);

    const resetRes = await handlers.get("publish-throttle:reset-settings")(null);
    assert.strictEqual(resetRes.ok, true);
    assert.strictEqual(resetRes.settings.platforms["百家号"].delayFromFirstHours, 0);

    console.log("✓ 7. 主进程持久化设置读写/校验/损坏回退与 IPC 验证通过");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase8_HttpMultiPlatformAndDedupeAndDefaultStatement() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-http-"));
  const videoFile = path.join(tmpDir, "demo.mp4");
  fs.writeFileSync(videoFile, "fake-video");

  const routesBundle = path.join(tmpDir, "routes.cjs");
  const guardStub = path.join(tmpDir, "guardStub.js");
  const pupStub = path.join(tmpDir, "pupStub.js");
  const alertStub = path.join(tmpDir, "alertStub.js");

  global.__MM_S11_PUP_CALLS__ = [];
  fs.writeFileSync(guardStub, `module.exports = { isTrustedLocalRequest: () => true };`);
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(taskPayload, transport, done) {
       global.__MM_S11_PUP_CALLS__.push(taskPayload);
       setImmediate(() => {
         transport.reply("puppeteerFile-done", {
           taskId: taskPayload.taskId,
           status: true,
           message: "上传成功",
         });
         if (done) done();
       });
     }`
  );
  fs.writeFileSync(alertStub, `module.exports = { handleAccountCollectOutcome: () => ({ ok: true }) };`);

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/server/routes/index.js")],
    outfile: routesBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "express"],
    plugins: [
      {
        name: "s11-http-stubs",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/requestGuard$/ }, () => ({ path: guardStub }));
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
          build.onResolve({ filter: /collectAlert\.js$/ }, () => ({ path: alertStub }));
        },
      },
    ],
  });

  const expressMod = require("express");
  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "express") return expressMod;
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDir, getVersion: () => "0.15.0-test" },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const { changeData } = require(utilsPath);
    const router = require(routesBundle);
    const postPublish = router.stack.find(
      (l) => l.route && l.route.path === "/publish" && l.route.methods.post
    ).route.stack[0].handle;
    const getCsSpec = router.stack.find(
      (l) => l.route && l.route.path === "/creative-statements" && l.route.methods.get
    ).route.stack[0].handle;

    const invokePost = async (body) => {
      let statusCode = 200;
      let payload = null;
      await postPublish(
        { method: "POST", body, headers: { origin: "http://localhost:30088" } },
        {
          status(c) {
            statusCode = c;
            return this;
          },
          json(p) {
            payload = p;
            return this;
          },
        }
      );
      return { statusCode, payload };
    };

    const invokeGetCs = async () => {
      let payload = null;
      await getCsSpec(
        { method: "GET", headers: { origin: "http://localhost:30088" } },
        {
          status() {
            return this;
          },
          json(p) {
            payload = p;
            return this;
          },
        }
      );
      return payload;
    };

    // 8a. 写入持久化设置：百家号 +10h，默认声明 ai_generated；且设置全天允许窗口（避开 VPS UTC+8 凌晨时间不确定性）
    const settingsPath = path.join(tmpDir, "publish-throttle-settings.json");
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "ai_generated",
        platforms: {
          抖音: { minIntervalHours: 6, dailyLimit: 3, delayFromFirstHours: 0 },
          快手: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 0 },
          百家号: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 10 },
          头条: { minIntervalHours: 4, dailyLimit: 3, delayFromFirstHours: 0 },
        },
      },
      { filePath: settingsPath }
    );

    // GET /creative-statements 返回持久化默认声明 ai_generated
    const csSpec1 = await invokeGetCs();
    assert.strictEqual(csSpec1.default, "ai_generated");

    // 预置历史：
    // - 抖音 A组 1 小时前发过「重复作品」（触发 S10 重复拦截，不得进入节流排期）
    // - 头条 A组 1 小时前发过「旧头条作品」（不同标题 → 通过 S10，但触发 S11 间隔不足 4h 顺延为定时）
    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "old-dy",
        selectedFile: "old-dy.mp4",
        bt: "重复作品",
        title: "重复作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "头条",
        phone: "A组",
        partition: "persist:A组头条",
        textType: "local",
        textOtherName: "old-tt",
        selectedFile: "old-tt.mp4",
        bt: "旧头条作品",
        title: "旧头条作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });

    // 8b. 多平台请求：dy（重复拦截）+ ks（立即）+ tt（间隔不足 4h 定时）+ bjh（+10h 定时）+ fqsp（立即，不支持声明回退 none）
    // 请求不传 creativeStatement → 自动套用 ai_generated（fqsp 回退 none）
    const multiRes = await invokePost({
      phone: "A组",
      file: videoFile,
      title: "重复作品",
      platforms: ["dy", "ks", "tt", "bjh", "fqsp"],
    });
    assert.strictEqual(multiRes.statusCode, 200);
    assert.strictEqual(multiRes.payload.status, "partial_duplicate");
    assert.strictEqual(multiRes.payload.results.length, 5);

    const [rDy, rKs, rTt, rBjh, rFq] = multiRes.payload.results;
    // dy 被 S10 拦截，绝不建定时任务
    assert.strictEqual(rDy.platform, "抖音");
    assert.strictEqual(rDy.status, "duplicate");
    assert.strictEqual(rDy.exitCode, 6);
    assert.strictEqual(rDy.creativeStatement, "ai_generated");

    // ks 立即提交
    assert.strictEqual(rKs.platform, "快手");
    assert.strictEqual(rKs.status, "submitted");
    assert.strictEqual(rKs.scheduled, false);
    assert.strictEqual(rKs.creativeStatement, "ai_generated");

    // tt 因距上次头条发布不足 4 小时自动定时
    assert.strictEqual(rTt.platform, "头条");
    assert.strictEqual(rTt.status, "scheduled");
    assert.strictEqual(rTt.scheduled, true);
    assert.strictEqual(rTt.throttled, true);
    assert.ok(rTt.publishAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rTt.publishAt));
    assert.ok(rTt.throttleReason.includes("距上次头条发布不足 4 小时"), rTt.throttleReason);
    assert.strictEqual(rTt.creativeStatement, "ai_generated");

    // bjh 因 +10h 自动定时
    assert.strictEqual(rBjh.platform, "百家号");
    assert.strictEqual(rBjh.status, "scheduled");
    assert.strictEqual(rBjh.scheduled, true);
    assert.strictEqual(rBjh.throttled, true);
    assert.ok(rBjh.throttleReason.includes("百家号相对首发延迟 10 小时"), rBjh.throttleReason);
    assert.strictEqual(rBjh.creativeStatement, "ai_generated");

    // fqsp 立即提交，且不支持创作声明回退 none
    assert.strictEqual(rFq.platform, "番茄视频");
    assert.strictEqual(rFq.status, "submitted");
    assert.strictEqual(rFq.creativeStatement, "none");

    // 核实 pushData 里只写入了 tt 和 bjh 两条 scheduled 记录，dy 未进入排期
    const allRecs = require("../src/shared/publishDedupe.js").readPushDataRecords(changeData);
    const schedPts = allRecs.filter((r) => r.scheduledTask === true).map((r) => r.pt).sort();
    assert.deepStrictEqual(schedPts, ["头条", "百家号"]);

    // 8c. HTTP noThrottle: true 绕过节流 + 显式 creativeStatement: "none" 覆盖默认声明
    const prevPupCount = global.__MM_S11_PUP_CALLS__.length;
    const bypassRes = await invokePost({
      platform: "dy",
      phone: "A组",
      file: videoFile,
      title: "绕过节流新作品",
      noThrottle: true,
      creativeStatement: "none",
    });
    assert.strictEqual(bypassRes.statusCode, 200);
    assert.strictEqual(bypassRes.payload.success, true);
    assert.strictEqual(bypassRes.payload.scheduled, undefined);
    assert.strictEqual(bypassRes.payload.creativeStatement, "none");
    assert.strictEqual(global.__MM_S11_PUP_CALLS__.length, prevPupCount + 1);
    assert.strictEqual(
      global.__MM_S11_PUP_CALLS__[global.__MM_S11_PUP_CALLS__.length - 1].data.creativeStatement,
      "none"
    );

    // 8d. 更改持久化默认声明为 fiction，HTTP 不传 creativeStatement 时自动套用 fiction，且 creativeStatements 单平台覆盖优先
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "fiction",
      },
      { filePath: settingsPath }
    );
    const csSpec2 = await invokeGetCs();
    assert.strictEqual(csSpec2.default, "fiction");

    const overrideRes = await invokePost({
      phone: "B组",
      file: videoFile,
      title: "声明覆盖测试",
      noThrottle: true,
      creativeStatements: { ks: "none" },
      platforms: ["dy", "ks"],
    });
    assert.strictEqual(overrideRes.payload.results[0].creativeStatement, "fiction");
    assert.strictEqual(overrideRes.payload.results[1].creativeStatement, "none");

    // 给 setImmediate 异步回调留一点时间收尾，避免临时目录提前删除
    await new Promise((r) => setTimeout(r, 50));

    console.log("✓ 8. HTTP 多平台部分立即部分定时、S10+S11 叠加、noThrottle 与默认声明套用/覆盖验证通过");
  } finally {
    delete global.__MM_S11_PUP_CALLS__;
    Module._load = origLoad;
    delete require.cache[routesBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase9_CliThrottleAndDefaultStatement() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-cli-"));
  const videoFile = path.join(tmpDir, "cli-demo.mp4");
  fs.writeFileSync(videoFile, "fake-video");

  const cliBundle = path.join(tmpDir, "cli.cjs");
  const pupStub = path.join(tmpDir, "pupStub.js");
  global.__MM_S11_CLI_PUP__ = [];
  fs.writeFileSync(
    pupStub,
    `export function registerPublishDedupeBypass() {}
     export function runPuppeteerTask(taskPayload, transport, done) {
       global.__MM_S11_CLI_PUP__.push(taskPayload);
       setImmediate(() => {
         transport.reply("puppeteerFile-done", {
           taskId: taskPayload.taskId,
           status: true,
           message: "CLI上传成功",
         });
         if (done) done();
       });
     }`
  );

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/cli/index.js")],
    outfile: cliBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: [
      "electron",
      "puppeteer-core",
      "puppeteer-extra",
      "puppeteer-extra-plugin-stealth",
      "puppeteer-in-electron",
      "xlsx",
    ],
    plugins: [
      {
        name: "s11-cli-stubs",
        setup(build) {
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
        },
      },
    ],
  });

  const xlsxMod = require("xlsx");
  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "xlsx") return xlsxMod;
    if (request === "electron") {
      return {
        app: {
          getPath: () => tmpDir,
          getVersion: () => "0.15.0-test",
          on: () => {},
          once: () => {},
          commandLine: { getSwitchValue: () => "" },
        },
        ipcMain: { on: () => {}, handle: () => {} },
        BrowserWindow: function () {},
        dialog: {},
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  try {
    const { changeData } = require(utilsPath);
    const cliMod = require(cliBundle);

    const settingsPath = path.join(tmpDir, "publish-throttle-settings.json");
    throttleService.savePublishThrottleSettings(
      {
        enabled: true,
        allowedWindow: { start: "00:00", end: "23:59" },
        defaultCreativeStatement: "ai_generated",
      },
      { filePath: settingsPath }
    );

    const now = Date.now();
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    changeData({
      fileName: "pushData",
      type: "add",
      item: {
        pt: "抖音",
        phone: "A组",
        partition: "persist:A组抖音",
        textType: "local",
        textOtherName: "prev",
        selectedFile: "prev.mp4",
        bt: "历史已发作品",
        title: "历史已发作品",
        publishStatus: "success",
        publishSuccessCount: 1,
        lastPublishAt: now - 3600 * 1000,
        date: todayKey,
      },
    });

    const runCli = async (args) => {
      const out = [];
      const err = [];
      const origLog = console.log;
      const origErr = console.error;
      console.log = (...a) => out.push(a.join(" "));
      console.error = (...a) => err.push(a.join(" "));
      try {
        const code = await cliMod.runCliMain(["node", ".", "cli", ...args]);
        return { code, out, err };
      } finally {
        console.log = origLog;
        console.error = origErr;
      }
    };

    // 9a. 重复标题先被 S10 拦截（退出码 6），不进排期
    const dupRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "历史已发作品",
    ]);
    assert.strictEqual(dupRun.code, 6);
    const dupJson = JSON.parse(dupRun.out[dupRun.out.length - 1]);
    assert.strictEqual(dupJson.status, "duplicate");
    assert.strictEqual(dupJson.creativeStatement, "ai_generated");

    // 9b. 新标题因距上次抖音发布不足 6 小时自动转定时，status: "scheduled"，带 publishAt/reason/creativeStatement
    const schedRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "新节流测试视频",
    ]);
    assert.strictEqual(schedRun.code, 0, `CLI 节流转定时应退出 0，err=${schedRun.err.join(" ")}`);
    const schedJson = JSON.parse(schedRun.out[schedRun.out.length - 1]);
    assert.strictEqual(schedJson.status, "scheduled");
    assert.strictEqual(schedJson.scheduled, true);
    assert.strictEqual(schedJson.throttled, true);
    assert.ok(schedJson.publishAt && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(schedJson.publishAt));
    assert.ok(schedJson.throttleReason.includes("距上次抖音发布不足 6 小时"), schedJson.throttleReason);
    assert.strictEqual(schedJson.creativeStatement, "ai_generated");
    assert.strictEqual(global.__MM_S11_CLI_PUP__.length, 0, "节流转定时不得立即触发上传");

    // 9c. --no-throttle + --cs none → 绕过节流立即发，且声明覆盖为 none
    const bypassRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "紧急直发视频",
      "--no-throttle", "--cs", "none",
    ]);
    assert.strictEqual(bypassRun.code, 0);
    const bypassJson = JSON.parse(bypassRun.out[bypassRun.out.length - 1]);
    assert.strictEqual(bypassJson.status, true);
    assert.strictEqual(bypassJson.creativeStatement, "none");
    assert.strictEqual(global.__MM_S11_CLI_PUP__.length, 1);
    assert.strictEqual(global.__MM_S11_CLI_PUP__[0].data.creativeStatement, "none");

    // 9d. 显式 --publish-at 也会过节流且只顺延不提前（抖音 1h 前发过，--publish-at 设 5 分钟后 → 顺延到至少 5h 后）
    const soonMs = Date.now() + 5 * 60 * 1000;
    const formatLocal = (ms) => {
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const explicitRun = await runCli([
      "publish", "-p", "dy", "--phone", "A组", "-f", videoFile, "-t", "显式定时顺延视频",
      "--publish-at", formatLocal(soonMs),
    ]);
    assert.strictEqual(explicitRun.code, 0, `CLI 显式定时顺延应退出 0，err=${explicitRun.err.join(" ")}`);
    const explicitJson = JSON.parse(explicitRun.out[explicitRun.out.length - 1]);
    assert.strictEqual(explicitJson.status, "scheduled");
    assert.strictEqual(explicitJson.throttled, true);
    assert.ok(parseUtc8DateTimeMs(explicitJson.publishAt) > soonMs + 4 * 3600 * 1000, "显式 --publish-at 应被节流顺延");

    // 9e. --help 文档包含 --no-throttle
    assert.ok(cliMod.publishHelpText().includes("--no-throttle"));

    console.log("✓ 9. CLI 节流转定时、--no-throttle 绕过、S10 优先拦截与默认声明套用/覆盖验证通过");
  } finally {
    delete global.__MM_S11_CLI_PUP__;
    Module._load = origLoad;
    delete require.cache[cliBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase10_RestartPersistenceOfScheduledTasks() {
  // 真实写盘到 pushData/<date>.json → 停止调度器 + 卸载模块模拟应用重启 → 重新加载并启动调度器 → 定时任务仍在且定时器重新挂起
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-restart-"));
  const schedBundle = path.join(tmpDir, "scheduledPublish.cjs");
  const pupStub = path.join(tmpDir, "pupStub.js");
  fs.writeFileSync(pupStub, `export function runPuppeteerTask() {}`);

  await esbuild.build({
    entryPoints: [path.join(root, "src/main/services/scheduledPublish.js")],
    outfile: schedBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    plugins: [
      {
        name: "s11-restart-stub",
        setup(build) {
          build.onResolve({ filter: /puppeteerFile(\.js)?$/ }, () => ({ path: pupStub }));
        },
      },
    ],
  });

  const origLoad = Module._load;
  const utilsPath = path.resolve(root, "src/main/server/utils.js");
  delete require.cache[utilsPath];

  Module._load = function (request, parent, isMain) {
    if (request === "electron") {
      return {
        app: { getPath: () => tmpDir, getVersion: () => "0.15.0-test" },
        ipcMain: { on: () => {}, handle: () => {} },
      };
    }
    if (request === "puppeteer-extra") {
      return { addExtra: () => ({ use: () => {}, connect: () => {} }) };
    }
    if (request === "puppeteer-extra-plugin-stealth") {
      return () => ({});
    }
    if (request.startsWith("puppeteer")) {
      return { use: () => {}, connect: () => {} };
    }
    return origLoad.apply(this, arguments);
  };

  let schedMod1 = null;
  let schedMod2 = null;
  try {
    const { changeData } = require(utilsPath);
    schedMod1 = require(schedBundle);

    const now = Date.now();
    const plannedAtMs = now + 6 * 3600 * 1000;
    const plannedAtText = formatUtc8DateTime(plannedAtMs);
    const todayKey = new Date(now + 8 * 3600000).toISOString().slice(0, 10);

    // 模拟节流创建一条定时任务并落盘
    const record = schedMod1.createScheduledRecord(
      {
        bookName: "重启恢复测试",
        textOtherName: "restart-clip",
        textType: "local",
        pt: "抖音",
        selectedFile: "restart-clip.mp4",
        bt: "重启恢复测试",
        title: "重启恢复测试",
        creativeStatement: "ai_generated",
        filePath: "/tmp/restart-clip.mp4",
        phone: "A组",
        partition: "persist:A组抖音",
        date: todayKey,
      },
      plannedAtText,
      now,
      {
        scheduledPublishAtMs: plannedAtMs,
        throttleReason: "距上次抖音发布不足 6 小时",
      }
    );

    const addRes = changeData({ fileName: "pushData", type: "add", item: record });
    assert.strictEqual(addRes.success, true);

    schedMod1.startScheduledPublishScheduler();
    assert.strictEqual(schedMod1.getScheduledTimersSnapshot().length, 1, "首次启动应挂起 1 个定时器");

    // 模拟应用关闭退出：停调度器并清掉模块缓存
    schedMod1.stopScheduledPublishScheduler();
    assert.strictEqual(schedMod1.getScheduledTimersSnapshot().length, 0);
    delete require.cache[schedBundle];

    // 模拟应用重启：全新加载 scheduledPublish 模块并调用 startScheduledPublishScheduler()
    schedMod2 = require(schedBundle);
    const loadedRecords = schedMod2.listScheduledRecords();
    assert.strictEqual(loadedRecords.length, 1, "重启后应从磁盘读回 1 条待执行定时任务");
    assert.strictEqual(loadedRecords[0].scheduledPublishAt, plannedAtMs);
    assert.strictEqual(loadedRecords[0].scheduledPublishAtText, plannedAtText);
    assert.strictEqual(loadedRecords[0].throttleReason, "距上次抖音发布不足 6 小时");
    assert.strictEqual(loadedRecords[0].creativeStatement, "ai_generated");
    assert.ok(loadedRecords[0].lastPublishMessage.includes("距上次抖音发布不足 6 小时"));

    schedMod2.startScheduledPublishScheduler();
    assert.strictEqual(
      schedMod2.getScheduledTimersSnapshot().length,
      1,
      "重启后调度器应自动为磁盘任务重新挂起定时器"
    );

    console.log("✓ 10. 重启后定时任务落盘恢复与调度器重新挂起定时器验证通过");
  } finally {
    if (schedMod1) schedMod1.stopScheduledPublishScheduler();
    if (schedMod2) schedMod2.stopScheduledPublishScheduler();
    Module._load = origLoad;
    delete require.cache[schedBundle];
    delete require.cache[utilsPath];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function testCase11_GuiTemplatesAndDocsCheck() {
  const vueFiles = [
    "src/renderer/components/PublishThrottleSettingsCard.vue",
    "src/renderer/components/LocalVideoPublish.vue",
    "src/renderer/views/videoManager/index.vue",
    "src/renderer/views/projectDetail/index.vue",
  ];
  for (const rel of vueFiles) {
    const src = fs.readFileSync(path.join(root, rel), "utf8");
    const sfc = compiler.parseComponent(src);
    assert.ok(sfc.template && sfc.template.content, `${rel} 应含 <template>`);
    const compiled = compiler.compile(sfc.template.content);
    assert.strictEqual(
      compiled.errors.length,
      0,
      `${rel} 模板编译报错: ${compiled.errors.join("; ")}`
    );
  }

  const localPubSrc = fs.readFileSync(
    path.join(root, "src/renderer/components/LocalVideoPublish.vue"),
    "utf8"
  );
  assert.ok(localPubSrc.includes("publish-throttle:plan"), "LocalVideoPublish 应调用 publish-throttle:plan");
  assert.ok(localPubSrc.includes("publish-throttle:get-settings"), "LocalVideoPublish 应读取默认创作声明设置");
  assert.ok(localPubSrc.includes("发布排期预览"), "LocalVideoPublish 应含排期预览弹窗");
  assert.ok(localPubSrc.includes("改为不节流"), "LocalVideoPublish 排期预览应支持改为不节流");
  assert.ok(localPubSrc.includes("DEFAULT_PUBLISH_CREATIVE_STATEMENT"), "LocalVideoPublish 应使用默认创作声明常量");

  // 真跑 LocalVideoPublish.vue 方法：验证默认声明初始选中 ai_generated、不支持平台回退 none，以及排期预览表确认/不节流分支
  const vm = require("vm");
  const tmpGuiDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-s11-gui-"));
  const csBundle = path.join(tmpGuiDir, "cs.cjs");
  try {
    esbuild.buildSync({
      entryPoints: [path.join(root, "src/shared/creativeStatement.js")],
      outfile: csBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
    });
    const csMod = require(csBundle);
    const script = localPubSrc
      .match(/<script>([\s\S]*?)<\/script>/)[1]
      .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "")
      .replace("export default", "globalThis.component =");
    const importedNames = [
      ...localPubSrc.matchAll(/^import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];/gm),
    ].flatMap((m) =>
      m[1]
        .replace(/[{}]/g, "")
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/).pop())
        .filter(Boolean)
    );
    const stubs = Object.fromEntries(importedNames.map((n) => [n, () => {}]));
    const ipcCalls = [];
    const ctx = vm.createContext({
      ...stubs,
      ...csMod,
      ipcRenderer: {
        invoke: async (ch, arg) => {
          ipcCalls.push({ ch, arg });
          if (ch === "publish-throttle:get-settings") {
            return { ok: true, settings: { defaultCreativeStatement: "ai_generated" } };
          }
          if (ch === "publish-throttle:plan") {
            return {
              ok: true,
              enabled: true,
              items: [
                {
                  platform: "抖音",
                  phone: "A组",
                  immediate: false,
                  scheduled: true,
                  throttled: true,
                  plannedAtMs: t8("2026-11-21T16:00:00"),
                  publishAt: "2026-11-21 16:00:00",
                  reason: "距上次抖音发布不足 6 小时",
                },
                {
                  platform: "快手",
                  phone: "A组",
                  immediate: true,
                  scheduled: false,
                  throttled: false,
                  plannedAtMs: t8("2026-11-21T10:00:00"),
                  publishAt: null,
                  reason: "",
                },
              ],
            };
          }
          return { ok: true };
        },
      },
    });
    vm.runInContext(script, ctx);
    const state = {
      ...ctx.component.data(),
      $set: (o, k, v) => {
        o[k] = v;
      },
      getAllPlatformLeafNodes: () => [
        { id: "n-dy", pt: "抖音" },
        { id: "n-fq", pt: "番茄视频" },
      ],
    };
    for (const [k, fn] of Object.entries(ctx.component.methods)) {
      state[k] = fn.bind(state);
    }
    await state.loadPublishThrottleDefaults();
    state.resetPlatformStatementState();
    assert.strictEqual(state.batchCreativeStatement, "ai_generated", "GUI 批量声明应初始选中 ai_generated");
    state.initPlatformStatementsForLeaves([
      { id: "n-dy", pt: "抖音" },
      { id: "n-fq", pt: "番茄视频" },
    ]);
    assert.strictEqual(state.getPlatformStatement("n-dy", "抖音"), "ai_generated");
    assert.strictEqual(state.getPlatformStatement("n-fq", "番茄视频"), "none", "不支持创作声明的平台应回退 none");

    // 排期预览表：先打开弹窗检查预览行，再点确认按排期发布
    const entries = [
      { key: "k0", pt: "抖音", phone: "A组", partition: "persist:A组抖音", title: "测试视频", isDraft: false },
      { key: "k1", pt: "快手", phone: "A组", partition: "persist:A组快手", title: "测试视频", isDraft: false },
    ];
    const pConfirm = state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(state.throttlePreviewVisible, true, "点发布前应弹出排期预览表");
    assert.strictEqual(state.throttlePreviewRows.length, 2);
    assert.strictEqual(state.throttlePreviewRows[0].plannedTimeText, "2026-11-21 16:00:00");
    assert.ok(state.throttlePreviewRows[0].reasonText.includes("不足 6 小时"));
    assert.strictEqual(state.throttlePreviewRows[1].plannedTimeText, "立即发布");
    state.resolveThrottlePreview("confirm");
    const confirmRes = await pConfirm;
    assert.strictEqual(confirmRes.proceed, true);
    assert.strictEqual(confirmRes.noThrottle, false);
    assert.strictEqual(confirmRes.itemsByKey.get("k0").publishAt, "2026-11-21 16:00:00");

    // 点「改为不节流」
    const pNoThrottle = state.confirmThrottlePublishPlan(entries, {});
    await new Promise((r) => setImmediate(r));
    state.resolveThrottlePreview("no_throttle");
    const noThrottleRes = await pNoThrottle;
    assert.strictEqual(noThrottleRes.proceed, true);
    assert.strictEqual(noThrottleRes.noThrottle, true);
  } finally {
    delete require.cache[csBundle];
    fs.rmSync(tmpGuiDir, { recursive: true, force: true });
  }

  const vmSrc = fs.readFileSync(
    path.join(root, "src/renderer/views/videoManager/index.vue"),
    "utf8"
  );
  assert.ok(vmSrc.includes("发布节流设置"), "视频管理页应有发布节流设置入口");

  const pdSrc = fs.readFileSync(
    path.join(root, "src/renderer/views/projectDetail/index.vue"),
    "utf8"
  );
  assert.ok(pdSrc.includes("PublishThrottleSettingsCard"), "项目详情页应接入发布节流设置卡片");

  const httpDoc = fs.readFileSync(path.join(root, "docs/http-api.md"), "utf8");
  const cliDoc = fs.readFileSync(path.join(root, "docs/cli.md"), "utf8");
  const planDoc = fs.readFileSync(path.join(root, "docs/fork/plan.md"), "utf8");
  assert.ok(httpDoc.includes("noThrottle") && httpDoc.includes("ai_generated") && httpDoc.includes("throttleReason"));
  assert.ok(cliDoc.includes("--no-throttle") && cliDoc.includes("ai_generated") && cliDoc.includes("scheduled"));
  assert.ok(planDoc.includes("## S11：发布节流 / 平台错峰 / 默认 AI 创作声明"));

  console.log("✓ 11. GUI 4 个 Vue 组件模板编译、默认声明/预览表真跑与文档校验通过");
}

async function main() {
  testCase1_IntervalPostponeAndBoundaries();
  testCase2_AllowedWindowRollover();
  testCase3_DailyLimitRollover();
  testCase4_BjhDelayPlus10h();
  testCase5_ExplicitPublishAtOnlyPostpones();
  testCase6_NoThrottleBypass();
  await testCase7_SettingsPersistenceAndIpc();
  await testCase8_HttpMultiPlatformAndDedupeAndDefaultStatement();
  await testCase9_CliThrottleAndDefaultStatement();
  await testCase10_RestartPersistenceOfScheduledTasks();
  await testCase11_GuiTemplatesAndDocsCheck();
  console.log("\ntest-publish-throttle: 全部断言通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
